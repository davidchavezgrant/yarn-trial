import { pathToFileURL } from "node:url";
import { auditTaskPrompt } from "../core/harness.js";
import { appSlug, liveDir, outDir, relToData } from "../paths.js";
import { AUTO_HOST, type DispatchOptions, dispatchNotes, type DispatchResult } from "../remote/control/dispatch.js";
import { CHALLENGER_N, challengerNeedsExplore, planChallenger } from "./challenger.js";
import { collect } from "./collect.js";
import { manifestCost } from "./cost.js";
import { fetchTrueCost, reconcile } from "./truecost.js";
import { BENCH_APP, BENCH_PRIMARY_MODEL, MATRIX, PHASES, armById, discoveryArmsFor, flagsLine, isPhase, perceptionLine, armModel, phaseArms, phaseRunCount, procedureArms, stageCompiles, stageNeedsMaps, stageOf, type Arm, type Phase } from "./matrix.js";
import {
	entriesForArm,
	type Manifest,
	type ManifestEntry,
	readManifest,
	recordSubmissions,
	submittedCount,
	utcDate,
	writeManifest,
} from "./manifest.js";

/**
 * Phase dispatch, behind the human gate.
 *
 * HARD CONSTRAINT (David): no benchmark run ever fires without an explicit go. `runPhase`
 * without `go: true` prints what WOULD run and returns exit 2 — the same shape either way,
 * so the preview IS the plan that executes. With `--go` it submits every arm×n of the phase
 * through the fleet queue and EXITS; the fleet drains, and `bench collect` gathers later.
 * Nothing here follows a log or waits on a run.
 *
 * Submissions are interleaved across arms (sample 0 of every arm, then sample 1, …) rather
 * than one arm's n back-to-back: `host: auto`'s idle walk then spreads concurrent arms over
 * different Macs, and order-independent cells (grounded vs ungrounded) don't serialize on
 * one machine while two sit idle.
 *
 * Top-up semantics: an arm with entries already in today's manifest only submits the
 * difference up to its n. Re-running a phase after a partial submit (or for phase 3/4's
 * second wave, where replays need a compiled recipe) is therefore safe and cheap.
 */

/**
 * The wire contract MERGED, and this type went with it.
 *
 * It used to be `Omit<DispatchOptions, "kind"> &` eleven redeclared fields, because
 * `DispatchOptions` did not yet carry `backend`/`noAx`/`axdomOff`/`noGrounding`/`useRecipe`/
 * `recipe`/`noRescue`/`url`/`appmapVariant`/`model` and `JobKind` had no `"replay"`. All of
 * them landed (dispatch.ts declares each, jobs.ts's union includes replay), so the local copy
 * was duplication and the `as DispatchOptions` at the call site had stopped bridging a gap and
 * started suppressing real type errors — a cast that outlives its reason is worse than the
 * gap it covered, because it silently accepts whatever the two sides drift into.
 */
export type DispatchFn = (opts: DispatchOptions) => Promise<DispatchResult>;
export type CompileFn = (stamp: string) => { path: string };

export interface PhaseOptions {
	go?: boolean;
	force?: boolean;
	/** Which model this pass runs (`--model <id>`). Crosses the wire as AGENT_MODEL; scopes
	 *  every manifest count so two self-grounded passes coexist in one manifest. Absent =
	 *  the child's default model, recorded as such. */
	model?: string;
	date?: string;
	outRoot?: string;
	/** Injected by tests. Production lazily loads the real dispatch/compile. */
	dispatchFn?: DispatchFn;
	/**
	 * Pin every run in this phase to one Mac instead of letting `auto` choose.
	 *
	 * Exists because the alternative was bypassing bench entirely, and dispatching directly
	 * skips BOTH things bench does around a submit: writing the manifest entry (so collect can
	 * find the run) and syncing the fleet (so the run uses current code). Both were lost that
	 * way on 2026-08-01 — one vision retry became invisible to collect, and another ran the
	 * pre-sweep explore loop because the fix never reached the Macs.
	 *
	 * The real need is mundane: one Mac is sick and `auto` keeps picking it.
	 */
	host?: string;
	compileFn?: CompileFn;
	/** Where promoted procedures live (phase-6 gate). Injected by tests; defaults to paths'. */
	proceduresDir?: string;
	log?: (line: string) => void;
}

/** One planned submission: the arm, which sample it is, and the options that will cross. */
export interface PlannedRun {
	arm: Arm;
	sample: number;
}

/** Exit codes: the preview exit is distinct so scripts can tell "refused" from "not confirmed". */
export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_NEEDS_GO = 2;

/** Phase-1 arms whose collected maps gate phase 2 — the Yarn explores, not the web check. */
// Per-app since 2026-08-03 — see discoveryArmsFor. Kept as a named local for the gate below.
const phase1GateArms = (phase: Phase): Arm[] => discoveryArmsFor(phase);

/**
 * Interleaved submission order, minus samples the manifest already holds. Compile arms are
 * excluded — they never dispatch; `runCompiles` handles them locally.
 */
export function plannedRuns(phase: Phase, manifest: Manifest, model?: string): PlannedRun[] {
	const arms = phaseArms(phase).filter((a) => a.kind !== "compile");
	const remaining = arms.map((arm) => ({ arm, have: submittedCount(manifest, arm.id, armModel(arm, model)) }));
	const out: PlannedRun[] = [];
	const maxN = Math.max(0, ...arms.map((a) => a.n));
	for (let sample = 0; sample < maxN; sample++)
		for (const { arm, have } of remaining) if (sample >= have && sample < arm.n) out.push({ arm, sample });

	return out;
}

/** The DispatchOptions a planned run crosses with. Task text goes over VERBATIM (property 1). */
export function dispatchOptionsFor(arm: Arm, recipe?: string, model?: string): DispatchOptions {
	const d = arm.dispatch;

	return {
		host: AUTO_HOST,
		// Arm pin beats the pass default: a Claude cell must stay Claude when the pass is Sol.
		...(d.model ?? model ? { model: d.model ?? model } : {}),
		app: arm.app,
		kind: arm.kind === "compile" ? "task" : arm.kind,
		queue: true,
		...(arm.task !== undefined ? { task: arm.task } : {}),
		...(d.backend ? { backend: d.backend } : {}),
		...(d.noVision ? { noVision: true } : {}),
		...(d.noAx ? { noAx: true } : {}),
		...(d.axdomOff ? { axdomOff: true } : {}),
		...(d.noGrounding ? { noGrounding: true } : {}),
		...(d.useRecipe ? { useRecipe: true } : {}),
		...(d.useProcedures ? { useProcedures: true } : {}),
		...(d.procedureLineage ? { procedureLineage: d.procedureLineage } : {}),
		// `record` is the DELIVERABLE flag: without it phase 5 is not "unfilmed", it is a
		// bit-identical re-run of its phase-2 sibling under a different arm id — 16 runs of
		// plausible, wrong-labelled data producing no footage. `filmed()` derives those arms by
		// adding only `record: true` and `n: 1`, so dropping it erases the entire difference.
		...(d.record ? { record: true } : {}),
		...(d.steps !== undefined ? { steps: d.steps } : {}),
		...(d.noRescue ? { noRescue: true } : {}),
		...(d.url ? { url: d.url } : {}),
		...(recipe ? { recipe } : {}),
		// The one env arm has a first-class wire field now: the runner validates the variant
		// and sets APPMAP_VARIANT on the child. Anything else in arm.env has no wire lane and
		// would silently not reach the run — refuse loudly at plan time, not here.
		// Forward whatever the arm declared. Restricting this to "vision" meant
		// APPMAP_VARIANT=novision never crossed the wire: ax-grounded-no-vision and
		// cdp-grounded-no-vision silently read the WITH-screenshots maps, the two
		// element-only grounding passes had no consumer at all, and `bench plan` printed
		// "crosses the wire as appmapVariant" — a claim that was false.
		...(arm.env?.APPMAP_VARIANT ? { appmapVariant: arm.env.APPMAP_VARIANT as "vision" | "novision" } : {}),
	};
}

/**
 * The goal-only gate, re-checked here even though every task string lives in matrix.ts:
 * auditTaskPrompt is the ONE authoritative rule (CLAUDE.md, "Measurement rule"), and the
 * orchestrator must be unable to construct a hinted dispatch no matter what the matrix
 * says. A hinted arm refuses the whole phase — there is no --force past this one.
 */
export function auditPhase(phase: Phase): string[] {
	const problems: string[] = [];
	for (const arm of phaseArms(phase)) {
		if (arm.kind !== "task" || !arm.task) continue;
		const audit = auditTaskPrompt(arm.task);
		if (audit.hinted) problems.push(`${arm.id}: ${audit.reasons.join("; ")}`);
	}

	return problems;
}

/**
 * A clean compile source: collected, successful, machine-checked. First match wins.
 * `tried` excludes stamps a previous compile already refused — the manifest keys on
 * (armId, jobId), so re-recording the same pair would be dropped, and re-compiling the
 * same log would refuse identically anyway.
 */
export function findCompileSource(manifest: Manifest, sourceArmId: string, tried: Set<string> = new Set(), model?: string): ManifestEntry | undefined {
	return entriesForArm(manifest, sourceArmId, model).find(
		(e) => !tried.has(e.jobId) && e.collected && e.metrics?.success === true && e.metrics?.finalCheckVerified !== false,
	);
}

/**
 * Phase 3/4 compiles, run LOCALLY: a compile is a pure file transform on a pulled run log
 * (recipe-cli's compileFromStamp keeps every refusal gate). A refusal is recorded in the
 * manifest as a failed-but-collected entry — "what the gate refuses" is a phase-3 datum,
 * not an orchestrator error.
 */
async function runCompiles(phase: Phase, manifest: Manifest, opts: Required<Pick<PhaseOptions, "log">> & PhaseOptions): Promise<Manifest> {
	const compileFn = opts.compileFn ?? (await defaultCompile());
	let m = manifest;
	for (const arm of phaseArms(phase).filter((a) => a.kind === "compile")) {
		// A recipe on file is the done condition — a recorded REFUSAL does not retire the arm,
		// so a later collect that lands a cleaner source run gets the compile retried.
		if (entriesForArm(m, arm.id, opts.model).some((e) => e.recipe)) {
			opts.log(`${arm.id}: already compiled — skipping`);
			continue;
		}
		const tried = new Set(entriesForArm(m, arm.id, opts.model).map((e) => e.jobId));
		const source = findCompileSource(m, arm.sourceArm ?? "", tried, opts.model);
		if (!source) {
			opts.log(`${arm.id}: no clean collected run in ${arm.sourceArm} yet — run \`./run bench collect\` after those land, then re-run this phase`);
			continue;
		}

		const entry: ManifestEntry = {
			armId: arm.id,
			jobId: source.jobId,
			host: "local",
			submittedAt: new Date().toISOString(),
			state: "done",
			collected: true,
			...(opts.model ? { model: opts.model } : {}),
		};
		try {
			const { path } = compileFn(source.jobId);
			m = recordSubmissions(m, [{ ...entry, recipe: relToData(path) }]);
			opts.log(`${arm.id}: compiled ${source.jobId} -> ${relToData(path)}`);
		} catch (e) {
			m = recordSubmissions(m, [{ ...entry, state: "failed", note: `compile refused: ${(e as Error).message}` }]);
			opts.log(`${arm.id}: compile refused — ${(e as Error).message}`);
		}
		writeManifest(m, liveDir(opts.outRoot ?? outDir()));
	}

	return m;
}

/** The recipe a replay arm replays: its compile arm's manifest entry, when the compile succeeded. */
const recipeFor = (manifest: Manifest, arm: Arm, model?: string): string | undefined =>
	entriesForArm(manifest, arm.sourceArm ?? "", model).find((e) => e.recipe && e.state === "done")?.recipe;

/**
 * Dispatch the challenger slice. Deliberately NOT a phase: its arms are resolved from
 * collected data rather than declared, and its n differs, so folding it into runPhase would
 * mean two sets of rules inside one function.
 *
 * The explore, when needed, goes out FIRST and alone — its map is an input to the task arms,
 * and dispatching them together would race a grounded run against a map that does not exist
 * yet, which degrades silently to provenance "none" instead of failing.
 */
export async function runChallenger(
	plan: NonNullable<ReturnType<typeof planChallenger>>,
	explore: Arm | undefined,
	model: string,
	opts: { log?: (s: string) => void; outRoot?: string; date?: string; dispatchFn?: DispatchFn } = {},
): Promise<number> {
	const log = opts.log ?? console.log;
	const outRoot = opts.outRoot ?? outDir();
	const date = opts.date ?? utcDate();
	const dispatchFn = opts.dispatchFn ?? (await defaultDispatch());
	const liveRoot = liveDir(outRoot);
	let manifest = readManifest(date, liveRoot);

	const exploreDone = explore ? entriesForArm(manifest, explore.id, model).some((e) => e.collected) : true;
	const wave: Array<{ arm: Arm; sample: number }> = [];
	if (explore && !exploreDone) wave.push({ arm: explore, sample: 0 });
	else
		for (const arm of plan.arms)
			for (let i = entriesForArm(manifest, arm.id, model).length; i < CHALLENGER_N; i++) wave.push({ arm, sample: i });

	if (!wave.length) {
		log("challenger slice already fully submitted for this model — nothing to do.");

		return EXIT_OK;
	}
	if (explore && !exploreDone) log(`explore first: the task arms need ${model}'s OWN map. Re-run this command after \`bench collect\`.`);

	let submitted = 0;
	for (const w of wave) {
		const result = await dispatchFn({ ...dispatchOptionsFor(w.arm, undefined, model) });
		if (!result.ok) {
			log(`✗ ${w.arm.id} [${w.sample + 1}]: ${result.error}`);
			continue;
		}
		submitted++;
		manifest = recordSubmissions(manifest, [
			{
				armId: w.arm.id,
				jobId: result.jobId,
				host: result.host.name,
				submittedAt: new Date().toISOString(),
				state: result.queued ? "queued" : "running",
				collected: false,
				model,
				...(w.arm.env ? { env: w.arm.env } : {}),
			},
		]);
		writeManifest(manifest, liveRoot);
		log(`✓ ${w.arm.id} [${w.sample + 1}/${explore && !exploreDone ? 1 : CHALLENGER_N}] -> ${result.jobId} on ${result.host.name}${result.queued ? " (queued)" : ""}`);
	}
	log(`\nsubmitted ${submitted}. Then: ./run bench collect && ./run bench judge --cross`);

	return submitted ? EXIT_OK : EXIT_REFUSED;
}

/**
 * Push this checkout to the Macs before dispatching. The fleet runs a RSYNCED COPY, so a fix
 * committed locally does not reach it — and a benchmark run on stale code produces data that
 * looks fine and means nothing.
 *
 * This is not hypothetical: on 2026-07-31 a Responses-API pairing fix was committed and phase
 * 1 fired immediately, so all four explores ran the pre-fix code and died on the same 400 the
 * commit had just fixed. Syncing here makes that structurally impossible rather than merely
 * detectable — provision is idempotent and takes seconds, which is cheaper than one wasted
 * explore, let alone a wasted phase.
 *
 * Skipped when a dispatch fake is injected (tests never touch the fleet) and non-fatal on
 * failure: a Mac that cannot be reached will refuse its dispatch a moment later with a
 * clearer message than a provisioning stack trace.
 */
/**
 * Warn when a runner is older than the runner-side code just shipped to it.
 *
 * syncOnly ships source without restarting the runner, which is correct — restarting orphans
 * whatever is in flight. The cost is that a fix in serve.ts or jobs.ts sits on disk
 * unexecuted: children are spawned fresh and pick up child-side changes immediately, but the
 * runner itself keeps running the modules it loaded at boot.
 *
 * That difference is invisible and expensive. On 2026-07-31 a fix making the explore argv
 * carry --no-ax was synced twice; both times the vision arm ran without it and reported
 * success, because the fix lived in serve.ts. Two wasted passes and an arm that measured the
 * wrong thing while looking healthy.
 *
 * A warning rather than a refusal: the operator may be mid-phase and unwilling to bounce a
 * busy Mac, and only they know whether the pending change matters to the arms about to run.
 */
async function warnStaleRunners(log: (s: string) => void): Promise<void> {
	try {
		const [{ fleetStatus }, fs, path] = [await import("../remote/control/fleet.js"), await import("node:fs"), await import("node:path")];
		// Newest mtime across the files whose changes only a restart can apply.
		const runnerSide = ["src/remote/runner/serve.ts", "src/remote/runner/jobs.ts"]
			.map((f) => {
				try {
					return fs.statSync(path.join(process.cwd(), f)).mtimeMs;
				} catch {
					return 0;
				}
			})
			.reduce((a, b) => Math.max(a, b), 0);
		if (!runnerSide) return;

		for (const row of await fleetStatus()) {
			const started = row.startedAt ? Date.parse(row.startedAt) : NaN;
			if (!Number.isFinite(started) || started >= runnerSide) continue;
			log(`⚠ ${row.name}'s runner started before the runner-side code it now has on disk — serve.ts/jobs.ts changes are NOT live there.`);
			log(`  Restart when that Mac is idle: ./run provision --restart --all   (a busy runner is skipped rather than orphaned)`);
		}
	} catch {
		// Advisory only; never block a dispatch on the warning machinery.
	}
}

async function syncFleet(opts: PhaseOptions, log: (s: string) => void): Promise<void> {
	if (opts.dispatchFn) return;
	try {
		const { provisionFleet } = await import("../remote/control/provision.js");
		const { loadHosts } = await import("../remote/control/hosts.js");
		// syncOnly: a FULL provision reinstalls the LaunchAgent, which boots the runner out and
		// orphans whatever it was running. Dispatching one arm must never kill another's work.
		const rows = await provisionFleet(loadHosts(), { syncOnly: true });
		// Code and maps travel by DIFFERENT mechanisms, deliberately. The rsync above excludes
		// docs/appmaps because it would overwrite blindly; syncAppmaps compares each side's
		// stamp and moves a map only when it is genuinely newer. Phase 2's grounded arms depend
		// on the phase-1 map having reached the Mac they land on, and this is what puts it
		// there. Never fatal — a Mac that is asleep costs a note, not a refused dispatch.
		const { syncAppmaps } = await import("../remote/control/appmaps.js");
		const maps = await syncAppmaps();
		// `adopted` is the direction that matters here: a map this laptop replaced with a newer
		// one FROM the fleet is a phase-1 result arriving, and it is worth naming rather than
		// counting — that is the artifact phase 2 will ground on.
		await warnStaleRunners(log);
		if (maps.transfers.length) log(`appmaps converged: ${maps.transfers.length} transfer(s)${maps.adopted.length ? `; adopted from fleet: ${maps.adopted.join(", ")}` : ""}`);
		const bad = rows.filter((r) => !r.ok);
		log(`fleet code synced (no runner restart): ${rows.length - bad.length}/${rows.length} host(s)${bad.length ? ` — ${bad.map((r) => r.host).join(", ")} FAILED` : ""}`);
	} catch (e) {
		log(`fleet sync skipped: ${(e as Error).message}`);
	}
}

export async function runPhase(phase: Phase, opts: PhaseOptions = {}): Promise<number> {
	const log = opts.log ?? console.log;
	/**
	 * DECLARED HERE, not at the CLI boundary — every caller of runPhase gets it, including the
	 * programmatic ones. Defaulting in the argv parser left the real API still inferring, which
	 * is the hole this closes.
	 *
	 * Without it a dispatch carries no model and the child falls through to makeClient's key
	 * precedence on whichever Mac dequeued it. See BENCH_PRIMARY_MODEL: on 2026-08-01 the fleet
	 * ran Sol from its own AGENT_MODEL while the laptop's default was claude-fable-5, and the
	 * dashboard showed the laptop's answer for the whole pass.
	 */
	opts = { ...opts, model: opts.model ?? BENCH_PRIMARY_MODEL };
	const outRoot = opts.outRoot ?? outDir();
	const date = opts.date ?? utcDate();
	const liveRoot = liveDir(outRoot);
	let manifest = readManifest(date, liveRoot);

	const hinted = auditPhase(phase);
	if (hinted.length) {
		log(`REFUSED: hinted task prompt(s) in the matrix — fix matrix.ts, the task text is the measurement:`);
		for (const p of hinted) log(`  ${p}`);

		return EXIT_REFUSED;
	}

	// The gate refuses DISPATCH, not the preview: without --go nothing can fire anyway, and
	// the preview is how an operator finds out what phase 2 needs before phase 1 has run.
	const missingMaps =
		stageNeedsMaps(phase) && !opts.force
			? phase1GateArms(phase).filter((a) => !entriesForArm(manifest, a.id, opts.model).some((e) => e.collected))
			: [];
	if (missingMaps.length && opts.go) {
		log(`REFUSED: phase ${phase}'s grounded arms need phase-1 maps${opts.model ? ` from THIS model's pass (${opts.model} grounds itself)` : ""}, and today's manifest has no collected explore for: ${missingMaps.map((a) => a.id).join(", ")}`);
		log(`Run \`./run bench phase 1${opts.model ? ` --model ${opts.model}` : ""} --go\`, wait, \`./run bench collect\` — or \`--force\` to use maps from an earlier pass.`);

		return EXIT_REFUSED;
	}

	/**
	 * Phase 6 needs a PROMOTED procedure per arm, which no phase produces — harvesting and
	 * promoting are deliberate operator steps (see harvest.ts for why). Without this gate a
	 * missing procedure only warns on the child's console and the run proceeds as an ordinary
	 * appmap-grounded one: six runs of data labelled "procedure" that measured the appmap tier.
	 * groundingChecked catches it, but only at collect, after the runs are paid for.
	 *
	 * PER ARM since 2026-08-01: an arm without its procedure is SKIPPED loudly, the rest
	 * dispatch. All-or-nothing meant the arm most likely to be unharvestable (the ungrounded
	 * lineage — a judged-PASS ungrounded run is rare by design) held the runnable arms hostage.
	 * Only when EVERY arm is missing does the phase refuse outright, as before.
	 */
	let missingProcedures = new Set<string>();
	if (procedureArms(phase).length > 0 && !opts.force) {
		const { proceduresDir } = await import("../paths.js");
		const { procedureFileFor } = await import("../core/procedure.js");
		const fs6 = await import("node:fs");
		const dir = opts.proceduresDir ?? proceduresDir();
		const wanted = (a: (typeof MATRIX)[number]): string =>
			procedureFileFor(dir, appSlug(a.app), a.task ?? "", a.dispatch.backend, a.dispatch.procedureLineage ?? "grounded");
		const missing = procedureArms(phase).filter((a) => !fs6.existsSync(wanted(a)));
		/**
		 * Refuse outright only when skipping the blocked arms would leave NOTHING to dispatch.
		 *
		 * The old rule — every procedure arm missing → refuse the phase — was written when a
		 * phase WAS the procedure tier and the two statements meant the same thing. After the
		 * stage reorganisation they do not: Generalization holds one procedure arm among
		 * twenty-two, so a single unharvested procedure would have refused the whole stage and
		 * taken sixty runs of task-and-model work down with it. Skip-loudly is already the
		 * per-arm behaviour; this just stops the all-missing shortcut from over-reaching.
		 */
		const dispatchable = phaseArms(phase).filter((a) => a.kind !== "compile");
		if (missing.length && missing.length === dispatchable.length && opts.go) {
			log(`REFUSED: every dispatchable arm in this stage grounds on a promoted procedure, and none exists.`);
			log(`Workflow: runs land → \`./run bench judge\` → \`./run bench harvest\` → \`./run procedures promote <stamp>\`, then re-run.`);
			log(`Expected at: ${missing.map((a) => relToData(wanted(a))).join(", ")}`);

			return EXIT_REFUSED;
		}
		if (missing.length) {
			missingProcedures = new Set(missing.map((a) => a.id));
			for (const a of missing) log(`– ${a.id}: no promoted procedure at ${relToData(wanted(a))} — SKIPPED (harvest + promote a source run, then re-run phase 6)`);
		}
	}

	// Compiles are local and cheap, but they are still phase work — gated like everything else.
	if (opts.go && stageCompiles(phase)) manifest = await runCompiles(phase, manifest, { ...opts, log });

	const planned = plannedRuns(phase, manifest, opts.model).filter((p) => !missingProcedures.has(p.arm.id));
	// Resolve replay recipes AFTER compiles so a single --go does compile-then-replay when
	// the sources are already collected; a missing recipe defers the replay to a later re-run.
	const ready = planned.filter((p) => p.arm.kind !== "replay" || recipeFor(manifest, p.arm, opts.model) !== undefined);
	const deferred = planned.filter((p) => !ready.includes(p));

	if (!opts.go) {
		log(`phase ${phase}${opts.model ? ` [model ${opts.model}]` : ""}: ${planned.length} run(s) would be submitted (${phaseRunCount(phase)} total in phase, minus already-submitted this pass):`);
		for (const p of planned) {
			const arm = p.arm;
			log(`  ${arm.id} [${p.sample + 1}/${arm.n}] ${arm.kind} "${arm.app}"${arm.task ? ` — ${JSON.stringify(arm.task)}` : ""} | ${flagsLine(arm)}`);
			if (arm.env) log(`    env: ${Object.entries(arm.env).map(([k, v]) => `${k}=${v}`).join(" ")} (crosses the wire as appmapVariant)`);
			if (arm.prereq) log(`    PREREQ: ${arm.prereq}`);
		}
		for (const arm of phaseArms(phase).filter((a) => a.kind === "compile"))
			if (submittedCount(manifest, arm.id, armModel(arm, opts.model)) < arm.n) log(`  ${arm.id} [local] compile from ${arm.sourceArm}`);
		if (missingMaps.length) log(`NOTE: --go would currently refuse — no collected phase-1 explore for: ${missingMaps.map((a) => a.id).join(", ")}`);
		log(`Nothing was dispatched. Re-run with --go to submit.`);

		return EXIT_NEEDS_GO;
	}

	const dispatchFn = opts.dispatchFn ?? (await defaultDispatch());
	await syncFleet(opts, log);
	let submitted = 0;
	let refused = 0;
	for (const p of ready) {
		const recipe = p.arm.kind === "replay" ? recipeFor(manifest, p.arm, opts.model) : undefined;
		const result = await dispatchFn({ ...dispatchOptionsFor(p.arm, recipe, opts.model), ...(opts.host ? { host: opts.host } : {}) });
		if (!result.ok) {
			refused++;
			log(`✗ ${p.arm.id} [${p.sample + 1}/${p.arm.n}]: ${result.error}`);
			continue;
		}

		submitted++;
		manifest = recordSubmissions(manifest, [
			{
				armId: p.arm.id,
				jobId: result.jobId,
				host: result.host.name,
				submittedAt: new Date().toISOString(),
				state: result.queued ? "queued" : "running",
				collected: false,
				// The ARM's model, not the pass's — armModel() is the same resolution dispatch
				// used, and the entry has to agree with it. Recording the pass model on a pinned
				// arm made the manifest say Sol for a run dispatched as Claude, and then
				// submittedCount looked for Claude entries, found none, and re-dispatched the
				// whole arm every pass: three arms sat at n=6 with the wrong model on all six.
				...(armModel(p.arm, opts.model) ? { model: armModel(p.arm, opts.model) } : {}),
				...(p.arm.env ? { env: p.arm.env } : {}),
				...(recipe ? { recipe } : {}),
			},
		]);
		// After every accept, not at the end: a dead laptop mid-phase must not orphan the
		// stamps of runs the fleet is already draining.
		writeManifest(manifest, liveRoot);
		log(`✓ ${p.arm.id} [${p.sample + 1}/${p.arm.n}] -> ${result.jobId} on ${result.host.name}${result.queued ? ` (queued #${result.position ?? "?"})` : ""}`);
		for (const note of dispatchNotes(result)) log(`    ${note}`);
		log(`    follow: ./run dispatch ${result.host.name} follow ${result.jobId}`);
	}

	for (const p of deferred) log(`… ${p.arm.id}: waiting on ${p.arm.sourceArm} — collect its source runs, then re-run \`bench phase ${phase} --go\``);
	log(`phase ${phase}: ${submitted} submitted, ${refused} refused, ${deferred.length} deferred. The fleet drains the queue; \`./run bench collect\` gathers results.`);

	return refused ? EXIT_REFUSED : EXIT_OK;
}

/** `bench plan` — the whole resolved matrix, no side effects. */
export function printPlan(log: (line: string) => void = console.log): void {
	const total = MATRIX.reduce((sum, a) => sum + a.n, 0);
	log(`benchmark matrix — ${MATRIX.length} arms, ${total} runs (dom cut; Notion cut entirely; procedures added 2026-08-01 — reasons in matrix.ts)`);
	for (const phase of PHASES) {
		const st = stageOf(phase);
		const note = [st?.inCorePass ? "" : "optional", st?.before?.length ? `needs ${st.before.join(" → ")} first` : "", st?.note]
			.filter(Boolean)
			.join("; ");
		log(`\nstage ${phase} ${st?.title ?? ""} — ${phaseRunCount(phase)} runs${note ? ` (${note})` : ""}`);
		for (const arm of phaseArms(phase)) {
			log(`  ${arm.id}  n=${arm.n}  ${arm.kind}  "${arm.app}"  ${flagsLine(arm)}`);
			// Only where it is not the default: printing "elements + screenshots" on every one
			// of 41 arms would bury the four where perception is the whole point of the arm.
			if (arm.dispatch.noAx || arm.dispatch.noVision) log(`      ${perceptionLine(arm)} — --backend names the ACTUATOR, not a perception channel`);
			if (arm.task) log(`      task: ${JSON.stringify(arm.task)}`);
			if (arm.sourceArm) log(`      source: ${arm.sourceArm}`);
			if (arm.env) log(`      env: ${Object.entries(arm.env).map(([k, v]) => `${k}=${v}`).join(" ")} (crosses the wire as appmapVariant)`);
			if (arm.prereq) log(`      PREREQ: ${arm.prereq}`);
			if (arm.informs) log(`      informs: ${arm.informs}`);
		}
	}
	log(`\nNo runs fire without \`./run bench phase <n> --go\` (David's gate).`);
}

async function defaultDispatch(): Promise<DispatchFn> {
	const { dispatch } = await import("../remote/control/dispatch.js");

	// Returned directly: DispatchFn IS dispatch's signature now, so there is nothing to adapt.
	return dispatch;
}

async function defaultCompile(): Promise<CompileFn> {
	// Lazy: recipe-cli drags the driver + SDK at import time, which `bench plan` and every
	// test must not pay for.
	const { compileFromStamp } = await import("../core/recipe-cli.js");

	return (stamp) => ({ path: compileFromStamp(stamp).path });
}

/**
 * `--date YYYY-MM-DD` — which manifest a command works against.
 *
 * Manifests are keyed by UTC date, and a matrix phase runs for hours. Phase 2 is 40 runs and
 * will cross midnight, at which point a fresh manifest reads every collected arm as
 * unsubmitted: the phase-1 gate refuses (it reads TODAY's), and re-running the phase silently
 * re-dispatches work already done. That happened on the 07-31→08-01 rollover with phase 1 —
 * three finished explores were re-dispatched and had to be stopped by hand within seconds.
 *
 * Pinning the date keeps one pass in one manifest across the boundary.
 */
export function dateArg(argv: string[]): string | undefined {
	const i = argv.indexOf("--date");
	if (i < 0) return undefined;
	const v = argv[i + 1];

	return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}

/**
 * The signature of a pass interrupted by the UTC rollover: today's manifest is empty while
 * yesterday's holds work. Returns yesterday's date + entry count when that is the case.
 * The autopilot REFUSES on this (an unattended pass must not silently fork); the interactive
 * `bench phase` merely warns, because an operator may genuinely mean to start a new pass.
 */
export function interruptedPass(date: string, outRoot: string): { date: string; entries: number } | undefined {
	try {
		if (readManifest(date, liveDir(outRoot)).entries.length) return undefined;
		const prev = new Date(`${date}T00:00:00Z`);
		prev.setUTCDate(prev.getUTCDate() - 1);
		const yday = prev.toISOString().slice(0, 10);
		const entries = readManifest(yday, liveDir(outRoot)).entries.length;

		return entries ? { date: yday, entries } : undefined;
	} catch {
		return undefined;
	}
}

function warnRollover(date: string, outRoot: string, log: (s: string) => void): void {
	const prior = interruptedPass(date, outRoot);
	if (!prior) return;
	log(`NOTE: today's manifest (${date}) is empty, but ${prior.date} holds ${prior.entries} entr(ies) — the UTC date rolled over.`);
	log(`      A phase re-run now re-dispatches arms already collected yesterday. Continue that pass with: --date ${prior.date}`);
}

const USAGE = `usage: ./run bench plan
       ./run bench phase <1|2|3|4|5|6> [--model <id>] [--date YYYY-MM-DD] [--host <mac>] [--go] [--force]
       ./run bench collect [--date YYYY-MM-DD]
       ./run bench judge [--cross] [--date YYYY-MM-DD]
       ./run bench harvest [--date YYYY-MM-DD]
       ./run bench watch <phase> [--then <phase>] [--interval <sec>] [--date YYYY-MM-DD]
       ./run bench autopilot [--phases 1,2,3,6] [--model <id>] [--date YYYY-MM-DD] [--host <mac>]
                             [--interval <sec>] [--max-usd <n>] [--max-waves <n>] [--max-retries <n>] [--go]
       ./run bench truecost [--since <RFC3339>] [--bucket 1m|1h|1d]
       ./run bench challenger --model <id> [--primary <id>] [--go]

plan     print the resolved matrix — every arm, flags, n, phase. No side effects.
phase    dispatch that phase's runs to the fleet queue. WITHOUT --go: preview and exit 2.
         --model runs the pass under that model (AGENT_MODEL on every child; e.g.
         claude-fable-5 or azure/gpt-5.6-sol). Each model is a SEPARATE
         self-grounded pass: its own explores, its own maps, its own sample counts —
         run the whole matrix under one model, then again under the other. Sequencing
         matters: docs/appmaps/ holds one live map per app, so a pass's phase 2 must
         run before the next pass's phase 1 overwrites it (collect archives each pass's
         maps under out/bench/<date>/appmaps/<model>/).
         --date pins the manifest a pass writes to. Manifests are keyed by UTC date and a
         phase runs for hours, so a long pass crosses midnight and a fresh manifest then
         reads every collected arm as unsubmitted — the gate refuses and a re-run
         re-dispatches finished work. Pin it for anything that will not finish inside the day.
         --host pins every run to one Mac instead of auto. Use it when a Mac is sick and
         auto keeps choosing it — dispatching around bench instead loses the manifest entry
         AND the pre-dispatch code sync, which has cost two runs already.
         --force skips the "phase-1 maps collected this pass" gate (phases 2 and 5).
         Phase 5 is the FILMED pass and must run last: --record injects demo conduct,
         swaps in an act tool without set_value, and changes actuation, so a filmed run
         has a different action space than the run that measured it. It exists to catch a
         REORDER — demo mode bans the keyboard paths ungrounded agents tend to find, so it
         may cost them more than the grounded arms. n=1 per config: direction, not
         significance. Cursor compositing is still manual afterwards:
         \`npm run humanize -- <stamp>\` per filmed run.
collect  pull artifacts for every uncollected manifest entry, compute metrics, rewrite
         the report skeleton. Idempotent; run it as often as you like while the queue drains.
         A terminal FAILURE's run directory is evicted from out/bench/live once its metrics
         are banked (same guarded backup-then-delete as \`runs drop\`; the manifest row and
         the out/bench/archive backup both stay).
truecost reconciles the report's ESTIMATE against Anthropic's own accounting: token counts
         from /v1/organizations/usage_report/messages (minute granularity, grouped by API key
         and model) priced at published rates, plus the daily /cost_report total. Needs an
         ADMIN credential in ANTHROPIC_ADMIN_KEY — not the run-time API key — and is skipped
         without one. Definitive per-run DOLLARS do not exist: cost is daily and
         workspace-level. Per-run TOKENS do, if each Mac has its own API key (the per-Mac
         lease means one run at a time, so a (key, minute) belongs to exactly one run).
challenger
         the head-to-head. OpenAI is the default and runs the full matrix; this dispatches
         the CHALLENGER against only what that pass found to win — the winning arm plus a
         DIVERGENCE arm (the hardest config measured), because testing a challenger solely at
         its opponent's optimum bakes in that optimum. n=6 per arm, concentrated rather than
         spread. Needs phase 2 collected for the primary; refuses otherwise rather than
         guessing a winner. Grounded arms get the challenger's OWN explore first — each model
         grounds itself. Compare the result on STEPS and ACTIONS, never tokens: Claude 4.7+
         tokenises ~30% higher for identical text.
judge    grades collected runs with the offline adversarial judge. --cross adds a SECOND
         grader (CROSS_JUDGE_MODEL, default claude-fable-5) writing .judge.cross.json beside
         the first — use it on the head-to-head, where the pinned judge shares lineage with
         the primary contestant. Agreement makes a verdict solid; disagreement is the finding.
         Base judge is pinned to
         azure/gpt-5.6-sol; JUDGE_MODEL overrides); idempotent — skips runs already
         judged. Run after runs land, before reading the report's Judge section.
watch    waits for a phase to finish, collecting as it goes (which is also what pulls
         artifacts home and fans the appmaps out to the fleet). Prints only on change.
         --then <phase> dispatches the next phase ONCE when this one completes — opt-in,
         and it never chains further, because phase 2 wants a human to read the phase-1
         maps first. Holds no leash: a dying watcher never touches a run.
autopilot
         the whole pass, hands off: for each phase — dispatch, watch, collect, re-dispatch
         what technical failures freed — and judge → harvest → promote automatically before
         phase 6. Encodes the known gotchas: date pinned at launch (UTC rollover), judge-key
         liveness checked BEFORE anything dispatches, per-arm technical-failure retry budget
         (--max-retries, default 2), optional hard spend ceiling (--max-usd), second waves
         for phase-3/4 compiles+replays (--max-waves, default 4). Stops the line on the first
         NEW sign-in refusal (exit 3 — 29% of archived runs; prints the signin command) and
         on a newly POISONED host; aborts a watch after 90 min of flat progress (wedged run)
         instead of holding the phase for hours; refuses to adopt an archive manifest as a
         wiped live pass. Default phases 1,2,3,6 —
         4 (optional) and 5 (filmed; changes the action space) are opt-in via --phases.
         Without --go: prints the plan and current progress, dispatches nothing. Your --go
         here is David's explicit-go gate, given once for the printed span. Holds no leash:
         Ctrl-C never touches a run, and re-running resumes from the manifest.
harvest  turns judged-PASS phase-2 runs into procedures — prose describing the route that
         worked, for a later agent to ground on. Refuses any run the judge did not pass, so
         run \`bench judge\` first. Writes into each run's own folder; promoting one into
         docs/procedures/ (\`./run procedures promote <stamp>\`) is a SEPARATE, deliberate step,
         because that is what makes it an input to phase 6.`;

async function main(argv: string[]): Promise<number> {
	const cmd = argv[0];
	if (cmd === "plan") {
		printPlan();

		return EXIT_OK;
	}
	if (cmd === "phase") {
		const phase = Number(argv[1]);
		if (!isPhase(phase)) {
			console.error(USAGE);

			return EXIT_REFUSED;
		}
		const mi = argv.indexOf("--model");
		const model = mi >= 0 ? argv[mi + 1] : undefined;
		if (mi >= 0 && (!model || model.startsWith("--"))) {
			console.error("--model needs a model id, e.g. --model claude-fable-5");

			return EXIT_REFUSED;
		}

		const hi = argv.indexOf("--host");
		const pinnedHost = hi >= 0 && argv[hi + 1] && !argv[hi + 1].startsWith("--") ? argv[hi + 1] : undefined;
		const pinned = dateArg(argv);
		if (!pinned) warnRollover(utcDate(), outDir(), console.log);

		return runPhase(phase as Phase, { go: argv.includes("--go"), force: argv.includes("--force"), ...(model ? { model } : {}), ...(pinned ? { date: pinned } : {}), ...(pinnedHost ? { host: pinnedHost } : {}) });
	}
	if (cmd === "challenger") {
		const mi = argv.indexOf("--model");
		const model = mi >= 0 ? argv[mi + 1] : undefined;
		if (!model || model.startsWith("--")) {
			console.error("challenger needs --model <id> (the challenger, e.g. claude-fable-5)");

			return EXIT_REFUSED;
		}
		const pi = argv.indexOf("--primary");
		const primary = pi >= 0 && argv[pi + 1] && !argv[pi + 1].startsWith("--") ? argv[pi + 1] : "azure/gpt-5.6-sol";
		const manifest = readManifest(dateArg(argv) ?? utcDate());
		const plan = planChallenger(manifest, primary);
		if (!plan) {
			console.error(`REFUSED: no collected phase-2 runs for the primary model (${primary}), so there is no winner to challenge.`);
			console.error("Run the primary pass first: ./run bench phase 2 --go, wait, ./run bench collect.");

			return EXIT_REFUSED;
		}
		for (const n of plan.notes) console.log(n);
		const explore = challengerNeedsExplore(plan);
		if (explore) console.log(`self-grounding first: ${explore.id} (the challenger cannot inherit the primary's appmap)`);
		if (!argv.includes("--go")) {
			console.log(`\npreview only — ${plan.arms.length} arms x n=${CHALLENGER_N}${explore ? " + 1 explore" : ""}. Add --go to dispatch.`);

			return EXIT_NEEDS_GO;
		}

		return runChallenger(plan, explore, model, { log: console.log });
	}
	if (cmd === "truecost") {
		const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
		if (!adminKey) {
			console.error("truecost needs ANTHROPIC_ADMIN_KEY (an Admin API credential, not the run-time key).");
			console.error("Without it there is no way to read Anthropic's accounting — the report's estimate stands alone.");

			return EXIT_REFUSED;
		}
		const si = argv.indexOf("--since");
		// Default to the start of today UTC: the manifest is dated per day, so that is the
		// window the current pass lives in.
		const startingAt = si >= 0 && argv[si + 1] ? String(argv[si + 1]) : `${utcDate()}T00:00:00Z`;
		const bi = argv.indexOf("--bucket");
		const bucketWidth = (bi >= 0 ? argv[bi + 1] : "1h") as "1m" | "1h" | "1d";
		const m = readManifest(dateArg(argv) ?? utcDate());
		const estimated = manifestCost(m.entries);
		const truth = await fetchTrueCost({ startingAt, adminKey, bucketWidth });
		for (const line of reconcile(estimated.usd, truth)) console.log(line);

		return EXIT_OK;
	}
	if (cmd === "collect") {
		// The same pin as phase: collecting today's manifest for a pass pinned to yesterday
		// would report every run as missing and pull nothing.
		const cDate = dateArg(argv);
		const outcome = await collect(cDate ? { date: cDate } : {});
		console.log(`collected ${outcome.collected.length}, pending ${outcome.pending.length}${outcome.reportPath ? `; report: ${outcome.reportPath}` : ""}`);

		return EXIT_OK;
	}
	if (cmd === "judge") {
		const cross = argv.includes("--cross");
		const { judgeBench } = await import("./judge.js");
		const jDate = dateArg(argv);
		const outcome = await judgeBench({ cross, ...(jDate ? { date: jDate } : {}) });
		console.log(`judged ${outcome.judged.length}, skipped ${outcome.skipped.length}, failed ${outcome.failed.length}`);
		for (const f of outcome.failed) console.log(`  ✗ ${f.jobId}: ${f.error}`);

		// Advisory step: per-entry failures are reported above, not fatal — a re-run judges
		// only what failed or landed since.
		return EXIT_OK;
	}
	if (cmd === "watch") {
		const phase = Number(argv[1]);
		const ti = argv.indexOf("--then");
		const then = ti >= 0 ? Number(argv[ti + 1]) : undefined;
		const ii = argv.indexOf("--interval");
		const valid = (p: number) => isPhase(p);
		if (!valid(phase) || (then !== undefined && !valid(then))) {
			console.error(USAGE);

			return EXIT_REFUSED;
		}
		const { watchPhase } = await import("./watch.js");
		const wDate = dateArg(argv);
		await watchPhase({
			phase: phase as Phase,
			...(then !== undefined ? { then: then as Phase } : {}),
			...(ii >= 0 ? { intervalSec: Number(argv[ii + 1]) } : {}),
			...(wDate ? { date: wDate } : {}),
		});

		return EXIT_OK;
	}
	if (cmd === "autopilot") {
		const num = (flag: string): number | undefined => {
			const i = argv.indexOf(flag);
			const v = i >= 0 ? Number(argv[i + 1]) : Number.NaN;

			return Number.isFinite(v) ? v : undefined;
		};
		const pi = argv.indexOf("--phases");
		let phases: Phase[] | undefined;
		if (pi >= 0) {
			const nums = (argv[pi + 1] ?? "").split(",").map((s) => Number(s.trim()));
			if (!nums.length || nums.some((n) => !isPhase(n))) {
				console.error("--phases wants a comma list from 1-6, e.g. --phases 1,2,3,6");

				return EXIT_REFUSED;
			}
			phases = nums as Phase[];
		}
		const mi = argv.indexOf("--model");
		const model = mi >= 0 && argv[mi + 1] && !argv[mi + 1].startsWith("--") ? argv[mi + 1] : undefined;
		const hi = argv.indexOf("--host");
		const pinnedHost = hi >= 0 && argv[hi + 1] && !argv[hi + 1].startsWith("--") ? argv[hi + 1] : undefined;
		const aDate = dateArg(argv);
		const interval = num("--interval");
		const maxUsd = num("--max-usd");
		const maxWaves = num("--max-waves");
		const maxRetries = num("--max-retries");
		const { autopilot } = await import("./autopilot.js");

		return autopilot({
			go: argv.includes("--go"),
			...(phases ? { phases } : {}),
			...(model ? { model } : {}),
			...(aDate ? { date: aDate } : {}),
			...(pinnedHost ? { host: pinnedHost } : {}),
			...(interval !== undefined ? { intervalSec: interval } : {}),
			...(maxUsd !== undefined ? { maxUsd } : {}),
			...(maxWaves !== undefined ? { maxWaves } : {}),
			...(maxRetries !== undefined ? { maxTechnicalFailures: maxRetries } : {}),
		});
	}
	if (cmd === "harvest") {
		const { harvestBench } = await import("./harvest.js");
		const hDate = dateArg(argv);
		const outcome = await harvestBench({ ...(hDate ? { date: hDate } : {}) });
		console.log(
			`harvested ${outcome.harvested.length}, skipped ${outcome.skipped.length}, refused ${outcome.refused.length}, failed ${outcome.failed.length}`,
		);
		// Refusals print as findings, not errors: "which runs were not good enough to teach
		// from" is the phase-6 datum most likely to be interesting.
		for (const r of outcome.refused) console.log(`  – ${r.jobId}: ${r.reason}`);
		for (const f of outcome.failed) console.log(`  ✗ ${f.jobId}: ${f.error}`);

		return EXIT_OK;
	}
	console.error(USAGE);

	return EXIT_REFUSED;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err) => {
			console.error(`bench failed: ${(err as Error).message}`);
			process.exit(1);
		},
	);
