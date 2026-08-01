import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { Driver } from "./driver.js";
import { envNum } from "../env.js";
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
import { compileRecipe, readRecipe, type Recipe, RecipeCompileError, recipeFileFor } from "./recipe.js";
import { modelRescue, replayRecipe } from "./replay.js";
import { runTeardown } from "./teardown.js";
import { LIVE_DIR, RUN_FILES, archiveRun, recipesDir, relToData, runDir, runFile, runPath } from "../paths.js";
import { parseTarget } from "./target.js";
import { coldStart } from "./coldstart.js";
import { type DriverSync, finishRecording, newRecording, startRecording } from "./agent/recording.js";

/**
 * Recipe compilation and replay, as a CLI.
 *
 *   npm run recipe -- compile <stamp>            run log -> docs/recipes/<slug>.<hash>.recipe.json
 *   npm run recipe -- replay <file|stamp> [--url <https://…>] [--no-rescue] [--no-cleanup]
 *
 * compile: freezes a SUCCESSFUL run's verified steps into a replayable sequence. It refuses
 * failed runs, unverified steps, and pixel-only steps — see compileRecipe for why each
 * refusal is what makes a recipe worth having.
 *
 * replay: runs the sequence with NO model calls on the happy path. Each step re-resolves
 * its control by (name, surface, role) against a fresh observation and is gated by the
 * recorded expectation through the same `verify()` a live run uses. A broken step gets one
 * bounded model rescue (RECIPE_RESCUE_STEPS, default 3) unless --no-rescue; without rescue
 * a drifted app fails the replay, which is the honest unattended default.
 *
 * Replays journal their mutations and run the standard teardown afterwards (CLEANUP env
 * applies; --no-cleanup skips), so a replayed demo puts the app back like any other run.
 *
 * Compiled recipes live beside the curated prose in docs/recipes/ but are machine output
 * with a provenance stamp — the appmap rule applies: never hand-edit one; re-record it.
 */

function usage(): never {
	console.error("usage:");
	console.error("  npm run recipe -- compile <stamp>");
	console.error("  npm run recipe -- replay <file|stamp> [--url <https://…>] [--record] [--no-rescue] [--no-cleanup]");
	process.exit(1);
}

export function compileFromStamp(stamp: string): { recipe: Recipe; path: string } {
	const logPath = runFile(stamp, RUN_FILES.log);
	if (!fs.existsSync(logPath)) throw new RecipeCompileError(`no run log at ${logPath}`);
	const recipe = compileRecipe(JSON.parse(fs.readFileSync(logPath, "utf8")), stamp);
	if (recipe.hintedPrompt)
		// Compiling a hinted run would launder the hint: the recipe replays clean while its
		// route was dictated. The stamp records it; the refusal keeps the tier honest.
		throw new RecipeCompileError("run was --hinted — its route was dictated, not discovered; re-run goal-only and compile that");
	const path = recipeFileFor(recipesDir(), recipe.slug, recipe.task);
	fs.mkdirSync(recipesDir(), { recursive: true });
	// A copy inside the SOURCE run's folder: compiling is something that run produced, and the
	// folder is the source of truth for what a run produced. docs/recipes stays the place a
	// recipe is found by name.
	try {
		fs.mkdirSync(runDir(stamp), { recursive: true });
		fs.writeFileSync(runPath(stamp, RUN_FILES.recipe), JSON.stringify(recipe, null, "\t"));
		// And re-link the backup. This write lands LONG after the source run terminated and took
		// its backup, so without this the recipe exists in live and not in archive — and the whole
		// point of the archive is that dropping the live copy loses nothing. Any post-terminal
		// writer has this obligation; archiveRun only links what the archive is missing.
		archiveRun(stamp);
	} catch {
		// The source run may predate the consolidated layout; the canonical write above stands.
	}
	fs.writeFileSync(path, `${JSON.stringify(recipe, null, "\t")}\n`);

	return { recipe, path };
}

/** replay <arg> accepts a recipe file path or a run stamp (resolved to its compiled file). */
function recipeFor(arg: string): Recipe {
	if (fs.existsSync(arg)) return readRecipe(arg);
	const logPath = runFile(arg, RUN_FILES.log);
	if (fs.existsSync(logPath)) {
		const runLog = JSON.parse(fs.readFileSync(logPath, "utf8"));
		const path = recipeFileFor(recipesDir(), compileRecipe(runLog, arg).slug, runLog.task);
		if (fs.existsSync(path)) return readRecipe(path);
		throw new RecipeCompileError(`no compiled recipe for ${arg} — run: npm run recipe -- compile ${arg}`);
	}
	throw new RecipeCompileError(`${arg} is neither a recipe file nor a run stamp`);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const verb = argv[0];
	if (verb === "compile") {
		const stamp = argv[1];
		if (!stamp) usage();
		const { recipe, path } = compileFromStamp(stamp);
		console.log(`compiled ${recipe.steps.length} step(s) from ${stamp}`);
		console.log(`  task:    ${recipe.task}`);
		console.log(`  backend: ${recipe.backend}${recipe.finalEvidence ? "" : "  (no final goal check in source run — replay will gate on steps alone)"}`);
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
	const recipe = recipeFor(argv[1]);

	// A cdp recipe against a website needs the URL back — the run log's `app` is only the
	// host, and guessing a scheme would navigate the replay somewhere the recording never
	// was. Same operator-input rule as cleanup's --url, for the same reason.
	const wantCdp = recipe.backend === "cdp" || !!url;
	if (recipe.backend === "cdp" && !url && recipe.app.includes("."))
		throw new RecipeCompileError(`this recipe was recorded on a web target — pass --url https://${recipe.app}`);
	const target = url ? parseTarget(["--url", url], recipe.app).target : parseTarget([], recipe.app).target;
	// runKey, not mintRunKey: a dispatched replay is handed RUN_STAMP by the runner, and the
	// job id must be the key the run log and journal land under — the same contract task and
	// explore runs already honour (see src/core/harness/run.ts).
	const stamp = runKey("replay-", recipe.slug);
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

	console.log(`=== replay: ${recipe.task} (${recipe.app}, ${recipe.steps.length} steps, from ${recipe.compiledFrom}) ===`);
	runEvent(stamp, "start", { mode: "replay", task: recipe.task, app: recipe.app, backend: wantCdp ? "cdp" : "ax", recipeSteps: recipe.steps.length });
	// wantCdp is the replay's actual delivery, whatever the recipe says: a cdp replay keeps
	// its hands off the operator's input, so it shows no banner (backendSeizesInput).
	const overlay = startOverlay("drive", `Agent replaying on ${recipe.app} — do not touch`, wantCdp ? "cdp" : "ax");
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
	const graph = loadAppMapGraph(recipe.slug);
	let exitCode = 1;

	try {
		// BEFORE acquisition, or the window handle below is stale the moment the app dies. A
		// recipe records a route from a freshly launched app, so replaying into whatever the last
		// run left behind measures that drift rather than the recipe.
		await coldStart(target, recipe.app);
		let win = cdp ? undefined : await findWindow(driver!, recipe.app);
		if (!cdp) {
			await driver!.act({ kind: "tool", name: "launch_app", args: { name: recipe.app } });
			await new Promise((r) => setTimeout(r, 1500));
			win = await ensureObservable(driver!, win!, recipe.app);
		}
		await overlay.countdown();
		overlay.setDriving(true);
		// After acquisition and BEFORE the home reset, matching a live run: the video opens on
		// the app being put into a known state rather than on whatever the last job left.
		if (record) await startRecording({ cdp, driver, win, app: recipe.app, overlay, recordingDir, framesDir, rec, sync });

		// Same normalisation as a live run: a recipe records a route FROM HOME, so replaying
		// from wherever the last run ended measures the app's drift, not the recipe's.
		if (cdp) console.log(`home reset: ${await cdp.goHome()}`);
		else {
			const reset = await resetToHome(driver!, win!, recipe.app, graph);
			console.log(`home reset: ${reset.result} — ${reset.detail}`);
		}
		if (interrupted()) return;

		const doObserve = (name: string) => (cdp ? cdp.observe(name) : observe(driver!, win!, name));
		const result = await replayRecipe(recipe, {
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
				`${result.steps.filter((s) => s.outcome !== "failed").length}/${recipe.steps.length} steps` +
				`${rescued ? ` (${rescued} rescued)` : ""}, ${result.modelCalls} model call(s)`,
		);
		runEvent(stamp, "verdict", {
			success: result.ok,
			summary: `${result.steps.filter((s) => s.outcome !== "failed").length}/${recipe.steps.length} steps${rescued ? `, ${rescued} rescued` : ""}, ${result.modelCalls} model call(s)`,
		});

		// The replay writes a run log of the same shape as a live run — one writer, in this
		// function, fields derived in one place (the a86cafc lesson).
		fs.mkdirSync(runDir(stamp), { recursive: true });
		// And the recipe it replayed, so the folder answers "what was this replay meant to do"
		// without resolving a docs/recipes filename that a later recompile changes (the name
		// carries a content hash).
		fs.writeFileSync(runPath(stamp, RUN_FILES.recipe), JSON.stringify(recipe, null, "\t"));
		fs.writeFileSync(
			runPath(stamp, RUN_FILES.log),
			`${JSON.stringify(
				{
					task: recipe.task,
					app: recipe.app,
					backend: cdp ? "cdp" : "ax",
					replayOf: recipe.compiledFrom,
					recipeSteps: recipe.steps.length,
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
					app: recipe.app,
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
		console.error(err instanceof RecipeCompileError ? err.message : err);
		process.exit(1);
	});
