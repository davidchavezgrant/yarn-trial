import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { Driver } from "./driver.js";
import { envNum, refuseRetiredEnv } from "../env.js";
import {
	appSlug,
	ensureObservable,
	findWindow,
	loadAppMapGraph,
	makeClient,
	observe,
	onInterrupt,
	OUT,
	resetToHome,
	runEvent,
	runKey,
	teeConsole,
} from "./harness.js";
import { readJournal } from "./journal.js";
import { startOverlay } from "./overlay.js";
import { compileProcedure, readProcedure, type Procedure, ProcedureCompileError, procedureFileFor } from "./procedure.js";
import { modelRescue, replayProcedure } from "./replay.js";
import { runTeardown } from "./teardown.js";
import { LIVE_DIR, RUN_FILES, archiveRun, proceduresDir, relToData, runDir, runFile, runPath } from "../paths.js";
import { electronTarget, parseTarget } from "./target.js";
import { coldStart } from "./coldstart.js";
import { type DriverSync, finishRecording, newRecording, startRecording } from "./agent/recording.js";

/**
 * Procedure compilation and replay, as a CLI.
 *
 *   npm run procedure -- compile <stamp>            run log -> docs/procedures/<slug>.<hash>.procedure.json
 *   npm run procedure -- replay <file|stamp> [--url <https://…>] [--no-rescue] [--no-cleanup]
 *
 * compile: freezes a SUCCESSFUL run's verified steps into a replayable sequence. It refuses
 * failed runs, unverified steps, and pixel-only steps — see compileProcedure for why each
 * refusal is what makes a procedure worth having.
 *
 * replay: runs the sequence with NO model calls on the happy path. Each step re-resolves
 * its control by (name, surface, role) against a fresh observation and is gated by the
 * recorded expectation through the same `verify()` a live run uses. A broken step gets one
 * bounded model rescue (PROCEDURE_RESCUE_STEPS, default 3) unless --no-rescue; without rescue
 * a drifted app fails the replay, which is the honest unattended default.
 *
 * Replays journal their mutations and run the standard teardown afterwards (CLEANUP env
 * applies; --no-cleanup skips), so a replayed demo puts the app back like any other run.
 *
 * Compiled procedures have docs/procedures/ to themselves — machine output with a provenance
 * stamp, so the appmap rule applies: never hand-edit one; re-record it. The prose tiers are
 * elsewhere by design (docs/curated/ by hand, docs/recipes/ harvested).
 */

/**
 * How long to let a freshly relaunched app paint before the first step resolves a control.
 * Mirrors explore/loop.ts and the task agent's home probe — 8 x 2s covers a cold Electron
 * relaunch while a genuinely blank target still fails fast instead of burning a fleet slot.
 */
const FIRST_OBSERVATION_TRIES = Number(process.env.REPLAY_FIRST_OBS_TRIES ?? 8);
const FIRST_OBSERVATION_WAIT_MS = Number(process.env.REPLAY_FIRST_OBS_WAIT_MS ?? 2000);

function usage(): never {
	console.error("usage:");
	console.error("  npm run procedure -- compile <stamp>");
	console.error("  npm run procedure -- replay <file|stamp> [--url <https://…>] [--record] [--no-rescue] [--no-cleanup]");
	process.exit(1);
}

export function compileFromStamp(stamp: string): { procedure: Procedure; path: string } {
	const logPath = runFile(stamp, RUN_FILES.log);
	if (!fs.existsSync(logPath)) throw new ProcedureCompileError(`no run log at ${logPath}`);
	const procedure = compileProcedure(JSON.parse(fs.readFileSync(logPath, "utf8")), stamp);
	if (procedure.hintedPrompt)
		// Compiling a hinted run would launder the hint: the procedure replays clean while its
		// route was dictated. The stamp records it; the refusal keeps the tier honest.
		throw new ProcedureCompileError("run was --hinted — its route was dictated, not discovered; re-run goal-only and compile that");
	const path = procedureFileFor(proceduresDir(), procedure.slug, procedure.task, procedure.backend);
	fs.mkdirSync(proceduresDir(), { recursive: true });
	// A copy inside the SOURCE run's folder: compiling is something that run produced, and the
	// folder is the source of truth for what a run produced. docs/procedures stays the place a
	// procedure is found by name.
	try {
		fs.mkdirSync(runDir(stamp), { recursive: true });
		fs.writeFileSync(runPath(stamp, RUN_FILES.procedure), JSON.stringify(procedure, null, "\t"));
		// And re-link the backup. This write lands LONG after the source run terminated and took
		// its backup, so without this the procedure exists in live and not in archive — and the whole
		// point of the archive is that dropping the live copy loses nothing. Any post-terminal
		// writer has this obligation; archiveRun only links what the archive is missing.
		archiveRun(stamp);
	} catch {
		// The source run may predate the consolidated layout; the canonical write above stands.
	}
	fs.writeFileSync(path, `${JSON.stringify(procedure, null, "\t")}\n`);

	return { procedure, path };
}

/** replay <arg> accepts a procedure file path or a run stamp (resolved to its compiled file). */
function procedureFor(arg: string): Procedure {
	if (fs.existsSync(arg)) return readProcedure(arg);
	const logPath = runFile(arg, RUN_FILES.log);
	if (fs.existsSync(logPath)) {
		const runLog = JSON.parse(fs.readFileSync(logPath, "utf8"));
		const slug = compileProcedure(runLog, arg).slug;
		// Backend-keyed first, legacy name second: procedures compiled before the backend joined the
		// key are still on disk and still replayable.
		for (const p of [procedureFileFor(proceduresDir(), slug, runLog.task, runLog.backend), procedureFileFor(proceduresDir(), slug, runLog.task)])
			if (fs.existsSync(p)) return readProcedure(p);
		throw new ProcedureCompileError(`no compiled procedure for ${arg} — run: npm run procedure -- compile ${arg}`);
	}
	throw new ProcedureCompileError(`${arg} is neither a procedure file nor a run stamp`);
}

async function main(): Promise<void> {
	/**
	 * FIRST, before argv is even read.
	 *
	 * The guard's own comment in src/env.ts says it is "called wherever a tier is chosen", and that
	 * description was the bug: it had exactly one caller, `loadGrounding` (src/core/agent/grounding.ts:28),
	 * which a replay never reaches — a replay executes frozen steps with no model in the loop and so
	 * chooses no grounding tier at all. But three of the retired names are REPLAY-side knobs
	 * (RECIPE_RESCUE, RECIPE_RESCUE_STEPS, RECIPE_SETTLE_MS), and the only command an operator would
	 * ever set them for is this one. So on the single code path where those names get typed, the guard
	 * could not fire, and setting one did what an unset variable does: replay took the 900ms default
	 * and rescue stayed on, quietly, which is the exact silent no-op the guard exists to prevent.
	 *
	 * "Where a tier is chosen" is therefore the wrong rule. The rule is WHERE A RETIRED NAME COULD BE
	 * SET — every operator-facing entry point owns the guard for the names its command reads, and an
	 * entry point cannot delegate that to a function it does not call.
	 *
	 * Ahead of the verb parse rather than inside the replay branch: `compile` is typed by the same
	 * operator out of the same shell, and a stale name in that environment is just as wrong there.
	 */
	refuseRetiredEnv();
	const argv = process.argv.slice(2);
	const verb = argv[0];
	if (verb === "compile") {
		const stamp = argv[1];
		if (!stamp) usage();
		const { procedure, path } = compileFromStamp(stamp);
		console.log(`compiled ${procedure.steps.length} step(s) from ${stamp}`);
		console.log(`  task:    ${procedure.task}`);
		console.log(`  backend: ${procedure.backend}${procedure.finalEvidence ? "" : "  (no final goal check in source run — replay will gate on steps alone)"}`);
		console.log(`  wrote:   ${path}`);

		return;
	}
	if (verb !== "replay" || !argv[1]) usage();

	const urlIdx = argv.indexOf("--url");
	const url = urlIdx >= 0 ? argv[urlIdx + 1] : undefined;
	const noRescue = argv.includes("--no-rescue");
	const noCleanup = argv.includes("--no-cleanup");
	/**
	 * A replay is the best filming candidate in the matrix: zero model calls on the happy path
	 * means no thinking gaps to hide in post. It could not be filmed at all before — this CLI
	 * had no --record and the runner's replay argv never passed one — so the two filmed-replay
	 * arms were declared and impossible.
	 */
	const record = argv.includes("--record");
	const procedure = procedureFor(argv[1]);

	// A cdp procedure against a website needs the URL back — the run log's `app` is only the
	// host, and guessing a scheme would navigate the replay somewhere the recording never
	// was. Same operator-input rule as cleanup's --url, for the same reason.
	const wantCdp = procedure.backend === "cdp" || !!url;
	if (procedure.backend === "cdp" && !url && procedure.app.includes("."))
		throw new ProcedureCompileError(`this procedure was recorded on a web target — pass --url https://${procedure.app}`);
	let target = url ? parseTarget(["--url", url], procedure.app).target : parseTarget([], procedure.app).target;
	// An app target driven over CDP must be marked cdpAttach, exactly as agent/cli.ts:73 and
	// explore/cli.ts:63 do it — that flag is what lets acquisition (re)launch the app with
	// --remote-debugging-port. Replay was the one entry point that never got it, and it went
	// unnoticed because replay had only ever been run by hand against an already-flagged app.
	// The first fleet dispatch of it failed 6 for 6 across two Macs: nothing was listening on
	// :9222, nothing was allowed to relaunch Yarn, and the runs died before writing a log —
	// which collect reasonably but wrongly read as two poisoned hosts.
	if (wantCdp && target.kind === "app") target = electronTarget(procedure.app);
	// runKey, not mintRunKey: a dispatched replay is handed RUN_STAMP by the runner, and the
	// job id must be the key the run log and journal land under — the same contract task and
	// explore runs already honour (see src/core/harness/run.ts).
	const stamp = runKey("replay-", procedure.slug);
	// A replay is a run: its console output lands in the run folder like any other artifact.
	// The tee stands down under the runner, which already redirects stdio into this file.
	teeConsole(stamp);
	const journalPath = runPath(stamp, RUN_FILES.journal);
	const recordingDir = runPath(stamp, RUN_FILES.recording);
	const framesDir = `${recordingDir}/frames`;
	const videoPath = `${recordingDir}/window.mp4`;
	const rec = newRecording();
	// The frame poller and the replay's own acts share the driver, so they share a mutex — the
	// same contract a live run's step loop honours.
	const sync: DriverSync = { busy: false, lastActionAt: 0 };

	console.log(`=== replay: ${procedure.task} (${procedure.app}, ${procedure.steps.length} steps, from ${procedure.compiledFrom}) ===`);
	runEvent(stamp, "start", { mode: "replay", task: procedure.task, app: procedure.app, backend: wantCdp ? "cdp" : "ax", procedureSteps: procedure.steps.length });
	// wantCdp is the replay's actual delivery, whatever the procedure says: a cdp replay keeps
	// its hands off the operator's input, so it shows no banner (backendSeizesInput).
	const overlay = startOverlay("drive", `Agent replaying on ${procedure.app} — do not touch`, wantCdp ? "cdp" : "ax");
	/**
	 * BEFORE EITHER BACKEND ACQUIRES. A procedure records a route through a freshly launched app,
	 * so replaying into whatever the last run left behind measures that drift rather than the
	 * procedure.
	 *
	 * It used to sit inside the try below, ahead of the AX `findWindow` — which reads as "before
	 * acquisition" only on the AX path. On CDP, acquisition is the line under this one, so the
	 * quit landed AFTER attach and killed the page the replay had just connected to: "the page
	 * this run was driving closed and no successor window appeared — saw: (no pages)", on every
	 * fleet replay. Locally it never showed, because the app was already running and flagged, so
	 * the relaunch that follows a quit happened to restore a usable endpoint before observe.
	 */
	await coldStart(target, procedure.app);
	// Lazy, matching the rest of core/: no static value-imports of backends/.
	const cdp = wantCdp ? await (await import("../backends/cdp.js")).CdpBackend.acquire(target) : undefined;
	const driver = cdp ? undefined : await Driver.start("replay");
	const interrupted = onInterrupt(async () => {
		await driver?.close();
		await cdp?.close();
	});
	// The client is created lazily-but-upfront: rescue and teardown share it. --no-rescue
	// with CLEANUP=off never calls the model at all, and makeClient itself is offline.
	const { client, model } = makeClient();
	const graph = loadAppMapGraph(procedure.slug);
	let exitCode = 1;

	try {
		// The cold start ran before acquisition (see above), so this handle is of the app the
		// quit-and-relaunch produced.
		let win = cdp ? undefined : await findWindow(driver!, procedure.app);
		if (!cdp) {
			await driver!.act({ kind: "tool", name: "launch_app", args: { name: procedure.app } });
			await new Promise((r) => setTimeout(r, 1500));
			win = await ensureObservable(driver!, win!, procedure.app);
		}
		await overlay.countdown();
		overlay.setDriving(true);
		// After acquisition and BEFORE the home reset, matching a live run: the video opens on
		// the app being put into a known state rather than on whatever the last job left.
		if (record) await startRecording({ cdp, driver, win, app: procedure.app, overlay, recordingDir, framesDir, rec, sync });

		// Same normalisation as a live run: a procedure records a route FROM HOME, so replaying
		// from wherever the last run ended measures the app's drift, not the procedure's.
		if (cdp) console.log(`home reset: ${await cdp.goHome()}`);
		else {
			const reset = await resetToHome(driver!, win!, procedure.app, graph);
			console.log(`home reset: ${reset.result} — ${reset.detail}`);
		}
		if (interrupted()) return;

		const doObserve = (name: string) => (cdp ? cdp.observe(name) : observe(driver!, win!, name));
		/**
		 * Let the relaunched app paint before step 1 resolves anything.
		 *
		 * The cold start quits the app; on CDP, acquisition returns as soon as the DEBUG PORT
		 * answers, which Electron's main process opens well before the renderer has content. So
		 * quit → relaunch → attach → resolve raced the first paint, and every no-rescue replay
		 * died on `[1/9] click "New Draft" — no control named "New Draft"` with zero model calls.
		 * The rescued arm gave it away: ONE rescue was enough and one run then completed, which
		 * cannot happen if the control is truly absent.
		 *
		 * Explore hit the identical race after its own cold start and solved it this way
		 * (FIRST_OBSERVATION_TRIES in explore/loop.ts); the task agent's home probe is the same
		 * shape. Sample, stop on content, give up after a bounded wait and let step 1 report the
		 * honest failure.
		 */
		for (let attempt = 0; attempt < FIRST_OBSERVATION_TRIES; attempt++) {
			const first = await doObserve(`${LIVE_DIR}/${stamp}/${RUN_FILES.steps}/replay-step-0`);
			if (first.appContent > 0) break;
			if (attempt === 0) console.log(`first observation is empty — waiting for ${procedure.app} to paint`);
			await new Promise((r) => setTimeout(r, FIRST_OBSERVATION_WAIT_MS));
		}
		const result = await replayProcedure(procedure, {
			driver,
			cdp,
			win,
			observe: doObserve,
			...(noRescue ? {} : { client, model, rescue: modelRescue }),
			graph,
			journalPath,
			// The engine has no stamp — this is where its structured events gain one.
			event: (kind, detail) => runEvent(stamp, kind, detail),
		});

		const rescued = result.steps.filter((s) => s.outcome === "rescued").length;
		console.log(
			`replay ${result.ok ? "SUCCEEDED" : "FAILED"}: ` +
				`${result.steps.filter((s) => s.outcome !== "failed").length}/${procedure.steps.length} steps` +
				`${rescued ? ` (${rescued} rescued)` : ""}, ${result.modelCalls} model call(s)`,
		);
		runEvent(stamp, "verdict", {
			success: result.ok,
			summary: `${result.steps.filter((s) => s.outcome !== "failed").length}/${procedure.steps.length} steps${rescued ? `, ${rescued} rescued` : ""}, ${result.modelCalls} model call(s)`,
		});

		// The replay writes a run log of the same shape as a live run — one writer, in this
		// function, fields derived in one place (the a86cafc lesson).
		fs.mkdirSync(runDir(stamp), { recursive: true });
		// And the procedure it replayed, so the folder answers "what was this replay meant to do"
		// without resolving a docs/procedures filename that a later recompile changes (the name
		// carries a content hash).
		fs.writeFileSync(runPath(stamp, RUN_FILES.procedure), JSON.stringify(procedure, null, "\t"));
		fs.writeFileSync(
			runPath(stamp, RUN_FILES.log),
			`${JSON.stringify(
				{
					task: procedure.task,
					app: procedure.app,
					backend: cdp ? "cdp" : "ax",
					replayOf: procedure.compiledFrom,
					procedureSteps: procedure.steps.length,
					modelCalls: result.modelCalls,
					success: result.ok,
					...(result.finalCheck ? { finalCheck: result.finalCheck } : {}),
					steps: result.records,
					...(record ? { video: relToData(videoPath) } : {}),
				},
				null,
				"\t",
			)}\n`,
		);

		const cleanupMode = process.env.CLEANUP ?? "advisory";
		if (!noCleanup && cleanupMode !== "off" && !interrupted()) {
			const journal = readJournal(journalPath);
			if (journal.length) {
				const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, modelCalls: 0 };
				const report = await runTeardown({
					stepsDir: `${LIVE_DIR}/${stamp}/${RUN_FILES.steps}`,
					driver,
					cdp,
					client,
					model,
					app: procedure.app,
					journal,
					claimed: [],
					graph,
					steps: [],
					budget: envNum("CLEANUP_STEPS", 10),
					mode: cleanupMode,
					vision: false,
					usage,
				});
				runEvent(stamp, "cleanup", { restored: report.restored ?? 0, failed: report.failed ?? 0 });
			}
		}

		exitCode = result.ok ? 0 : 1;
	} catch (err) {
		// Name the cause in the event log before rethrowing to main's catch — a replay that
		// died mid-acquire otherwise leaves an event log that just stops after "start".
		runEvent(stamp, "fatal", { error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
		throw err;
	} finally {
		overlay.setDriving(false);
		await driver?.close();
		await cdp?.close();
		overlay.stop();
		// Same contract as a live run: the run directory gets a hard-linked backup at the end,
		// and a backup that fails does not turn a finished replay into a crashed one.
		try {
			archiveRun(stamp);
		} catch (err) {
			console.log(`backup: could not copy ${stamp} to out/bench/archive — ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main().catch((err) => {
		console.error(err instanceof ProcedureCompileError ? err.message : err);
		process.exit(1);
	});
