/**
 * The benchmark matrix as data — docs/plans/2026-07-31-benchmark-matrix.md, as amended by
 * David the same day (relayed via the coordinator):
 *
 *   - the dom backend is DELETED (dominated by cdp) — every dom arm is gone, and the
 *     backend union is "ax" | "cdp";
 *   - a generalization slice on Notion Calendar joins phase 2 (ungrounded vs grounded ×
 *     ax vs cdp, n=2) — a Yarn-only matrix measures reliability but not generalization;
 *   - phase 1 gains one web-explore-on-cdp verification run: the dom web-explore path is
 *     being removed on the assumption cdp covers it, and this run checks that assumption.
 *
 * Every cell is an Arm here; nothing in this module dispatches, reads, or writes anything.
 * Code that wants to know what the benchmark IS reads this; code that wants to RUN it goes
 * through orchestrate.ts, where the human gate (--go) lives.
 *
 * COUNT NOTE: the plan doc's phase-2 header said "36 runs" / "Permutation slices (18)", but
 * its own table enumerated seven slices at n=3 (21). After the dom cut and the Notion
 * Calendar slice, phase 2 is 41 runs (12 core + 21 slices + 8 generalization); the ~11 runs
 * freed by cutting dom roughly fund the Notion Calendar slice. The enumerated arms are the
 * spec; header arithmetic is derived from them (`phaseRunCount`), never quoted.
 *
 * Task strings are GOAL-ONLY, always — auditTaskPrompt is the gate and orchestrate.ts
 * re-checks every task arm before dispatch. Method knowledge lives in the declared inputs
 * (backend, appmap tier, recipe), never in the task text.
 */

export type BenchBackend = "ax" | "cdp";
export type ArmKind = "task" | "explore" | "replay" | "compile";
export type Phase = 1 | 2 | 3 | 4;

/**
 * The dispatch knobs an arm turns, in `DispatchOptions`' exact spellings.
 *
 * Every one of them now EXISTS on that type — `backend`, `noAx`, `axdomOff`, `noGrounding`,
 * `useRecipe`, `recipe`, `noRescue`, `url`, `appmapVariant` — and `JobKind` carries "replay".
 * This used to describe a contract being built concurrently, with orchestrate.ts casting at
 * the dispatch() call site until it merged; it merged, the cast is gone, and the compiler now
 * checks that an arm can only name a knob the wire actually has.
 */
export interface ArmDispatch {
	backend?: BenchBackend;
	noVision?: boolean;
	noAx?: boolean;
	axdomOff?: boolean;
	noGrounding?: boolean;
	useRecipe?: boolean;
	noRescue?: boolean;
	/** Web target for an explore arm (`explore --url … --backend cdp`). Contract-assumed. */
	url?: string;
}

export interface Arm {
	/** Stable slug, e.g. "p2-ax-grounded". Manifest entries key on it. */
	id: string;
	phase: Phase;
	kind: ArmKind;
	app: string;
	/** Runs of this cell. Explore passes and compiles are n=1 by construction. */
	n: number;
	/** Task arms only. Goal-only, enforced by orchestrate + tests. */
	task?: string;
	dispatch: ArmDispatch;
	/**
	 * Pre-run environment the arm needs on the runner (e.g. APPMAP_VARIANT=vision for the
	 * vision-only grounded consumption arms). Passed through dispatch when the merged wire
	 * supports it; recorded in the manifest and printed by `bench plan` either way, so the
	 * integrating human can resolve it if the option is not there yet.
	 */
	env?: Record<string, string>;
	/**
	 * compile arms: the task arm whose clean successful run is the compile source.
	 * replay arms: the compile arm whose recipe they replay.
	 */
	sourceArm?: string;
	/** The decision this cell informs, from the plan doc. Printed by `bench plan`. */
	informs?: string;
	/** Unverified fleet-side requirement (install/sign-in). Printed loudly by `bench plan`. */
	prereq?: string;
}

export const BENCH_APP = "Yarn";

/** Canonical small task (set by David, 2026-07-29). Goal only — no control names, no verbs. */
export const CANONICAL_TASK = "show me how to change the cursor type";

/**
 * The generalization slice's app + task. The phrasing is the one the clean 2026-07-29
 * evening re-measure used on this app (out/runs/*notion-calendar.json), kept identical so
 * the new numbers are comparable with the old ones. Goal-only: names the outcome, not the
 * gutter label, the menu item, or any interaction verb.
 */
// Kept though currently unreferenced: the Notion Calendar slice above was dropped for a
// MISSING APP, not a bad idea, and restoring it should not mean re-deriving the task string.
export const NC_APP = "Notion Calendar";
export const NC_TASK = "Change my calendar's time zone to Paris";

/**
 * Phase 1's web-explore verification target. Wikipedia is the repo's prior cdp web target
 * (docs/recipes/www.wikipedia.org.*.recipe.json) — low-risk, public, no sign-in.
 */
export const WEB_EXPLORE_URL = "https://www.wikipedia.org";

/**
 * Phase 4's second task. The plan doc calls it "the Auto Time sync example" but records no
 * task string anywhere in the repo — this is a goal-only stand-in against a real control
 * (Settings → Preferences → "Auto-Add Screen Zooms", app scope, per the stamped Yarn map).
 * TODO(David): confirm or replace before dispatching phase 4. Phase 4 is optional and
 * gated behind an explicit `bench phase 4 --go`, so the placeholder cannot fire on its own.
 */
export const PHASE4_TASK = "show me how to turn on auto-add screen zooms";

export const BACKENDS: readonly BenchBackend[] = ["ax", "cdp"];

const task = (id: string, dispatch: ArmDispatch, informs: string, over: Partial<Arm> = {}): Arm => ({
	id,
	phase: 2,
	kind: "task",
	app: BENCH_APP,
	task: CANONICAL_TASK,
	n: 3,
	dispatch,
	informs,
	...over,
});

/**
 * Phase 1 — node discovery per backend (grounded arms use their own backend's map), plus
 * the one web-explore run that verifies cdp covers the web path dom used to own.
 */
const PHASE1: Arm[] = [
	...BACKENDS.map((backend): Arm => ({
		id: `p1-explore-${backend}`,
		phase: 1,
		kind: "explore",
		app: BENCH_APP,
		n: 1,
		dispatch: { backend },
		informs: "controls seen/actuated/dismissed, obs latency, pass duration, map size, scope ambiguities",
	})),
	{
		id: "p1-explore-web-cdp",
		phase: 1,
		kind: "explore",
		app: WEB_EXPLORE_URL,
		n: 1,
		dispatch: { backend: "cdp", url: WEB_EXPLORE_URL },
		informs: "dom's web-explore path is being deleted on the assumption cdp covers it — this run checks that",
	},
];

/** Phase 2 core — backend × grounding, n=3 per cell. */
const PHASE2_CORE: Arm[] = BACKENDS.flatMap((backend) => [
	task(`p2-${backend}-ungrounded`, { backend, noGrounding: true }, "ad-hoc discovery floor on this backend"),
	task(`p2-${backend}-grounded`, { backend }, "what a grounding pass buys on this backend"),
]);

/** Phase 2 permutation slices — each maps to a fork in the implementation Aman inherits. */
const PHASE2_SLICES: Arm[] = [
	task("p2-ax-grounded-axdom-off", { backend: "ax", axdomOff: true }, "is the Swift sidecar worth shipping (outcomes, not naming counts)"),
	task("p2-ax-grounded-no-vision", { backend: "ax", noVision: true }, "what the screenshot channel buys on ax"),
	task("p2-cdp-grounded-no-vision", { backend: "cdp", noVision: true }, "same on cdp — DOM snapshot is text-rich; fleet-scale cost"),
	task("p2-ax-curated", { backend: "ax", useRecipe: true }, "explore pass vs 10 minutes of human notes"),
	// Vision-only is ax-backend-only by construction: cdp observations ARE ref lists.
	task("p2-vision-only-ungrounded", { backend: "ax", noAx: true, noGrounding: true }, "the floor: screenshots alone, cold"),
	/**
	 * ~~p2-vision-only-grounded~~ — CUT 2026-07-31, and the reason is worth keeping: as
	 * specified it would have produced a WRONG answer rather than no answer.
	 *
	 * It set APPMAP_VARIANT=vision, which resolves to docs/appmaps/<slug>.vision.md — the
	 * output of a vision-only explore pass, which is deliberately not built yet. A missing map
	 * does not fail: loadGrounding returns `provenance: "none"` (agent/grounding.ts), which is
	 * byte-identical to NO_GROUNDING=1. So the arm would have run the SAME conditions as
	 * p2-vision-only-ungrounded while being labelled the grounded one, and the report would
	 * have concluded "prose grounding does not help a vision-only agent" from an experiment
	 * that never ran.
	 *
	 * It cannot borrow the ordinary appmap instead: that map was written by a pass that could
	 * read the AX tree, so it names controls a screenshots-only agent could never have
	 * discovered — the same contamination class as a hinted prompt.
	 *
	 * The QUESTION survives without it: p2-vision-only-curated puts human-written prose in
	 * front of the same blind agent. What is lost is only whether MACHINE-generated prose does
	 * the same, which is exactly the deferred vision-explore pipeline. Restore this arm when
	 * that pipeline lands and a stamped <slug>.vision.md exists.
	 */
	task("p2-vision-only-curated", { backend: "ax", noAx: true, useRecipe: true }, "same against the human-written tier"),
];

/**
 * ~~Phase 2 generalization slice (Notion Calendar)~~ — DROPPED 2026-07-31 (David's call).
 *
 * The arms carried a PREREQ marked UNVERIFIED; verifying it settled the matter — Notion
 * Calendar is installed on NONE of the three colo Macs (checked over ssh, all three). Every
 * run would have refused at the readiness gate for exit 3, costing 16 runs across both model
 * passes and teaching nothing. Reinstate by installing and signing the app in on the fleet
 * first, then restoring these arms from git history — the generalization question is still
 * worth asking, it just needs the app present to ask it.
 */

/**
 * Phase 3 — recipes. Compiles are LOCAL (a pure file transform on a pulled run log through
 * recipe-cli's compileFromStamp, which keeps its refusal gates); replays dispatch to the
 * fleet. The compile source — one clean grounded run per backend — is resolved at phase
 * time from the collected manifest, never named here.
 */
const PHASE3: Arm[] = [
	...BACKENDS.map((backend): Arm => ({
		id: `p3-compile-${backend}`,
		phase: 3,
		kind: "compile",
		app: BENCH_APP,
		n: 1,
		dispatch: { backend },
		sourceArm: `p2-${backend}-grounded`,
		informs: "compile success; what the gate refuses",
	})),
	...BACKENDS.map((backend): Arm => ({
		id: `p3-replay-${backend}`,
		phase: 3,
		kind: "replay",
		app: BENCH_APP,
		n: 3,
		dispatch: { backend },
		sourceArm: `p3-compile-${backend}`,
		informs: "steps re-resolved vs rescued, model calls (target 0), wall-clock + tokens vs live grounded",
	})),
	{
		id: "p3-replay-ax-norescue",
		phase: 3,
		kind: "replay",
		app: BENCH_APP,
		n: 3,
		dispatch: { backend: "ax", noRescue: true },
		sourceArm: "p3-compile-ax",
		informs: "unattended-fleet posture: does the happy path hold with ZERO model calls",
	},
];

/**
 * Phase 4 (optional) — second-task spot check, ax only. n=2 per cell keeps the phase inside
 * the plan's ~5–8 run budget (n=3 would be 9). The replay arm needs a recipe compiled from a
 * clean phase-4 grounded run, so it is dispatched in a second wave: run `bench collect`
 * after the grounded runs land, then `bench phase 4 --go` again — already-submitted samples
 * are skipped, the compile runs, and the replays go out.
 */
const PHASE4: Arm[] = [
	task("p4-ungrounded", { backend: "ax", noGrounding: true }, "is everything above cursor-task-specific", { phase: 4, task: PHASE4_TASK, n: 2 }),
	task("p4-grounded", { backend: "ax" }, "is everything above cursor-task-specific", { phase: 4, task: PHASE4_TASK, n: 2 }),
	{
		id: "p4-compile",
		phase: 4,
		kind: "compile",
		app: BENCH_APP,
		n: 1,
		dispatch: { backend: "ax" },
		sourceArm: "p4-grounded",
		informs: "does compile generalize past the canonical task",
	},
	{
		id: "p4-replay",
		phase: 4,
		kind: "replay",
		app: BENCH_APP,
		n: 2,
		dispatch: { backend: "ax" },
		sourceArm: "p4-compile",
		informs: "does replay generalize past the canonical task",
	},
];

export const MATRIX: readonly Arm[] = [...PHASE1, ...PHASE2_CORE, ...PHASE2_SLICES, ...PHASE3, ...PHASE4];

export const phaseArms = (phase: Phase): Arm[] => MATRIX.filter((a) => a.phase === phase);

export const armById = (id: string): Arm | undefined => MATRIX.find((a) => a.id === id);

/** Total runs a phase performs, local compiles included — the per-phase figures `bench plan` prints. */
export const phaseRunCount = (phase: Phase): number => phaseArms(phase).reduce((sum, a) => sum + a.n, 0);

/**
 * The human-readable spelling of an arm's knobs, in the vocabulary the plan doc and the CLI
 * use (`--backend ax`, `NO_GROUNDING=1`, …) rather than the wire field names. For `bench
 * plan` output and dispatch confirmation lines.
 */
export function flagsLine(arm: Arm): string {
	const d = arm.dispatch;
	const parts: string[] = [];
	if (d.backend) parts.push(`--backend ${d.backend}`);
	if (d.url) parts.push(`--url ${d.url}`);
	if (d.noVision) parts.push("--no-vision");
	if (d.noAx) parts.push("--no-ax");
	if (d.axdomOff) parts.push("AXDOM=0");
	if (d.noGrounding) parts.push("NO_GROUNDING=1");
	if (d.useRecipe) parts.push("USE_RECIPE=1");
	if (d.noRescue) parts.push("--no-rescue");
	for (const [k, v] of Object.entries(arm.env ?? {})) parts.push(`${k}=${v}`);

	return parts.join(" ") || "(defaults)";
}
