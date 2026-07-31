import { pathToFileURL } from "node:url";
import { auditTaskPrompt } from "../core/harness.js";
import { outDir, relToData } from "../paths.js";
import { AUTO_HOST, type DispatchOptions, dispatchNotes, type DispatchResult } from "../remote/control/dispatch.js";
import { CHALLENGER_N, challengerNeedsExplore, planChallenger } from "./challenger.js";
import { collect } from "./collect.js";
import { rollupCost } from "./cost.js";
import { fetchTrueCost, reconcile } from "./truecost.js";
import {
	type Arm,
	armById,
	BENCH_APP,
	flagsLine,
	MATRIX,
	type Phase,
	phaseArms,
	phaseRunCount,
} from "./matrix.js";
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
	compileFn?: CompileFn;
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
const phase1GateArms = (): Arm[] => phaseArms(1).filter((a) => a.app === BENCH_APP);

/**
 * Interleaved submission order, minus samples the manifest already holds. Compile arms are
 * excluded — they never dispatch; `runCompiles` handles them locally.
 */
export function plannedRuns(phase: Phase, manifest: Manifest, model?: string): PlannedRun[] {
	const arms = phaseArms(phase).filter((a) => a.kind !== "compile");
	const remaining = arms.map((arm) => ({ arm, have: submittedCount(manifest, arm.id, model) }));
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
		...(model ? { model } : {}),
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
		...(d.noRescue ? { noRescue: true } : {}),
		...(d.url ? { url: d.url } : {}),
		...(recipe ? { recipe } : {}),
		// The one env arm has a first-class wire field now: the runner validates the variant
		// and sets APPMAP_VARIANT on the child. Anything else in arm.env has no wire lane and
		// would silently not reach the run — refuse loudly at plan time, not here.
		...(arm.env?.APPMAP_VARIANT === "vision" ? { appmapVariant: "vision" as const } : {}),
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
		writeManifest(m, opts.outRoot ?? outDir());
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
	let manifest = readManifest(date, outRoot);

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
		writeManifest(manifest, outRoot);
		log(`✓ ${w.arm.id} [${w.sample + 1}/${explore && !exploreDone ? 1 : CHALLENGER_N}] -> ${result.jobId} on ${result.host.name}${result.queued ? " (queued)" : ""}`);
	}
	log(`\nsubmitted ${submitted}. Then: ./run bench collect && ./run bench judge --cross`);

	return submitted ? EXIT_OK : EXIT_REFUSED;
}

export async function runPhase(phase: Phase, opts: PhaseOptions = {}): Promise<number> {
	const log = opts.log ?? console.log;
	const outRoot = opts.outRoot ?? outDir();
	const date = opts.date ?? utcDate();
	let manifest = readManifest(date, outRoot);

	const hinted = auditPhase(phase);
	if (hinted.length) {
		log(`REFUSED: hinted task prompt(s) in the matrix — fix matrix.ts, the task text is the measurement:`);
		for (const p of hinted) log(`  ${p}`);

		return EXIT_REFUSED;
	}

	// The gate refuses DISPATCH, not the preview: without --go nothing can fire anyway, and
	// the preview is how an operator finds out what phase 2 needs before phase 1 has run.
	const missingMaps =
		(phase === 2 || phase === 5) && !opts.force
			? phase1GateArms().filter((a) => !entriesForArm(manifest, a.id, opts.model).some((e) => e.collected))
			: [];
	if (missingMaps.length && opts.go) {
		log(`REFUSED: phase ${phase}'s grounded arms need phase-1 maps${opts.model ? ` from THIS model's pass (${opts.model} grounds itself)` : ""}, and today's manifest has no collected explore for: ${missingMaps.map((a) => a.id).join(", ")}`);
		log(`Run \`./run bench phase 1${opts.model ? ` --model ${opts.model}` : ""} --go\`, wait, \`./run bench collect\` — or \`--force\` to use maps from an earlier pass.`);

		return EXIT_REFUSED;
	}

	// Compiles are local and cheap, but they are still phase work — gated like everything else.
	if (opts.go && (phase === 3 || phase === 4)) manifest = await runCompiles(phase, manifest, { ...opts, log });

	const planned = plannedRuns(phase, manifest, opts.model);
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
			if (submittedCount(manifest, arm.id, opts.model) < arm.n) log(`  ${arm.id} [local] compile from ${arm.sourceArm}`);
		if (missingMaps.length) log(`NOTE: --go would currently refuse — no collected phase-1 explore for: ${missingMaps.map((a) => a.id).join(", ")}`);
		log(`Nothing was dispatched. Re-run with --go to submit.`);

		return EXIT_NEEDS_GO;
	}

	const dispatchFn = opts.dispatchFn ?? (await defaultDispatch());
	let submitted = 0;
	let refused = 0;
	for (const p of ready) {
		const recipe = p.arm.kind === "replay" ? recipeFor(manifest, p.arm, opts.model) : undefined;
		const result = await dispatchFn(dispatchOptionsFor(p.arm, recipe, opts.model));
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
				...(opts.model ? { model: opts.model } : {}),
				...(p.arm.env ? { env: p.arm.env } : {}),
				...(recipe ? { recipe } : {}),
			},
		]);
		// After every accept, not at the end: a dead laptop mid-phase must not orphan the
		// stamps of runs the fleet is already draining.
		writeManifest(manifest, outRoot);
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
	log(`benchmark matrix — ${MATRIX.length} arms, ${total} runs (dom cut; Notion Calendar slice cut, vision-only tier completed 2026-07-31 — reasons in matrix.ts)`);
	for (const phase of [1, 2, 3, 4, 5] as Phase[]) {
		const note = phase === 4 ? " (optional)" : phase === 5 ? " (filmed takes — run last; --record changes the action space)" : "";
		log(`\nphase ${phase} — ${phaseRunCount(phase)} runs${note}`);
		for (const arm of phaseArms(phase)) {
			log(`  ${arm.id}  n=${arm.n}  ${arm.kind}  "${arm.app}"  ${flagsLine(arm)}`);
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

const USAGE = `usage: ./run bench plan
       ./run bench phase <1|2|3|4|5> [--model <id>] [--go] [--force]
       ./run bench collect
       ./run bench judge [--cross]
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
         judged. Run after runs land, before reading the report's Judge section.`;

async function main(argv: string[]): Promise<number> {
	const cmd = argv[0];
	if (cmd === "plan") {
		printPlan();

		return EXIT_OK;
	}
	if (cmd === "phase") {
		const phase = Number(argv[1]);
		if (![1, 2, 3, 4, 5].includes(phase)) {
			console.error(USAGE);

			return EXIT_REFUSED;
		}
		const mi = argv.indexOf("--model");
		const model = mi >= 0 ? argv[mi + 1] : undefined;
		if (mi >= 0 && (!model || model.startsWith("--"))) {
			console.error("--model needs a model id, e.g. --model claude-fable-5");

			return EXIT_REFUSED;
		}

		return runPhase(phase as Phase, { go: argv.includes("--go"), force: argv.includes("--force"), ...(model ? { model } : {}) });
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
		const manifest = readManifest(utcDate(), outDir());
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
		const m = readManifest(utcDate(), outDir());
		const estimated = rollupCost(
			m.entries
				.filter((e) => e.collected)
				.map((e) => ({
					inputTokens: e.metrics?.inputTokens,
					outputTokens: e.metrics?.outputTokens,
					cacheReadTokens: e.metrics?.cacheReadTokens,
					cacheCreationTokens: e.metrics?.cacheCreationTokens,
					...(e.metrics?.model ? { model: e.metrics.model } : e.model ? { model: e.model } : {}),
				})),
		);
		const truth = await fetchTrueCost({ startingAt, adminKey, bucketWidth });
		for (const line of reconcile(estimated.usd, truth)) console.log(line);

		return EXIT_OK;
	}
	if (cmd === "collect") {
		const outcome = await collect();
		console.log(`collected ${outcome.collected.length}, pending ${outcome.pending.length}${outcome.reportPath ? `; report: ${outcome.reportPath}` : ""}`);

		return EXIT_OK;
	}
	if (cmd === "judge") {
		const cross = argv.includes("--cross");
		const { judgeBench } = await import("./judge.js");
		const outcome = await judgeBench({ cross });
		console.log(`judged ${outcome.judged.length}, skipped ${outcome.skipped.length}, failed ${outcome.failed.length}`);
		for (const f of outcome.failed) console.log(`  ✗ ${f.jobId}: ${f.error}`);

		// Advisory step: per-entry failures are reported above, not fatal — a re-run judges
		// only what failed or landed since.
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
