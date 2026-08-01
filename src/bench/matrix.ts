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
import { appmapSlug } from "../core/target.js";

export type Phase = 1 | 2 | 3 | 4 | 5;

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
	/**
	 * Film this take. Phase 5 only — a measurement arm must never set it, because recording
	 * changes the agent's action space (demo prompt, demo act tool with no `set_value`,
	 * hover-dwell-click actuation) and would make the arm measure demo mode instead of the
	 * config. A test enforces the split.
	 */
	record?: boolean;
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
	/**
	 * An explore arm whose map no task arm reads, on purpose. Phase 1 measures GROUNDING —
	 * map size, surfaces, cost — which is an output in itself; requiring every map to feed a
	 * task arm conflates that with phase 2's question. Reading a map nothing writes is a
	 * correctness bug; writing one nothing reads is a cost decision, and this flag is where
	 * that decision is recorded.
	 */
	comparisonOnly?: boolean;
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
/**
 * The canonical web target (set by David 2026-07-31). Wikipedia was here first, as a thin
 * regression check that `cdp` still covered web exploration after `dom` was deleted — a
 * portal with a search box and some links, which proved almost nothing about whether any of
 * this transfers to a real application.
 *
 * Notion is the generalization test the matrix lost when the Notion Calendar slice was cut
 * for the app not being installed on the fleet. A web target needs no install — only a
 * signed-in browser profile, which every Mac now has.
 *
 * NOTE .com, not .so: David corrected this, and the profile signed in on each Mac is the
 * one for this host.
 */
export const WEB_EXPLORE_URL = "https://app.notion.com";

/**
 * Goal-only, and deliberately multi-step: a new document, a table view inside it, and five
 * columns filled. It names OUTCOMES — no menu, no slash-command, no keystroke — so it passes
 * auditTaskPrompt (verified: `hinted: false`).
 *
 * "Create a NEW document" is also the sandbox rule doing real work here. This runs against a
 * live personal workspace, and an agent that edited existing pages instead of making its own
 * would be a failure even on a run that passed every check.
 */
export const WEB_TASK = "Create a new document with a table view and populate its first five columns";

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
		/**
		 * TWO passes, not one. Every phase-1 number was a point estimate with no error bar,
		 * and we know the spread can be brutal: the vision arm gave 8 surfaces on one run and
		 * 3 on the next under identical code. Without a repeat, "cdp found 63 surfaces and ax
		 * found 31" cannot be told apart from two draws of a wide distribution — and that
		 * comparison is the headline of the whole discovery question.
		 *
		 * Free in wall-clock: four arms across three Macs is already two waves, and six is
		 * still two. It costs tokens, not time.
		 *
		 * Only these two repeat. They are the ones every other comparison is measured
		 * against; the single-channel arms are read relative to them.
		 */
		n: 2,
		dispatch: { backend },
		informs: "controls seen/actuated/dismissed, obs latency, pass duration, map size, scope ambiguities",
	})),
	/**
	 * ~~p1-explore-web-cdp (Notion)~~ — DROPPED 2026-08-01 (David's call, on time).
	 *
	 * The prompt and frontier fixes require re-running every grounding pass, and this was the
	 * longest run in the matrix by a wide margin: 1h14m and $24.45 against ~30m and ~$14 for a
	 * Yarn pass. On the critical path that is the whole re-run again.
	 *
	 * Its DATA IS KEPT rather than discarded — docs/appmaps/web-app.notion.com.cdp.* and the
	 * archived stamp — because it already answered the question nothing else can: what it
	 * costs to map an unfamiliar large app cold. Yarn cannot answer that; the pipeline has
	 * been tuned against it for days. Report it as a one-off spot check, never in the same
	 * table as the Yarn arms — the two differ in app, scale and maturity at once, so any delta
	 * between them is uninterpretable (David's point, and he was right).
	 *
	 * Restoring it means restoring the phase-2 web arms with it, or the explore grounds nothing.
	 */

	/**
	 * The element-only GROUNDING pass — the mirror of the vision-only one below.
	 *
	 * Added 2026-08-01 (David spotted the asymmetry): phase 2 tests dropping screenshots during
	 * a TASK, but nothing tested dropping them during GROUNDING, while the opposite channel got
	 * both. The 2x2 was half empty.
	 *
	 * It is a cost question above all. The Notion pass spent 2.5M input and 17.8M cache-read
	 * tokens, and screenshots are the bulk of that — so if an element-only pass produces a
	 * comparable map, onboarding a new app gets materially cheaper, which is exactly the
	 * per-app budget Jasper described. Read `nodes` and `surfaces` against p1-explore-ax,
	 * which differs from this arm in nothing but the screenshot channel.
	 */
	{
		id: "p1-explore-no-vision",
		phase: 1,
		kind: "explore",
		app: BENCH_APP,
		n: 1,
		dispatch: { backend: "ax", noVision: true },
		informs: "can grounding be done from the element tree alone — map size and cost vs the same pass with screenshots",
	},
	/**
	 * The three remaining cells of the perception grid, added 2026-08-01 (David: "so we're
	 * comprehensive"). The element channel has four states — AX+DOM attrs, AX alone, DOM via
	 * cdp, none — crossed with screenshots on/off. Seven are viable (no elements AND no
	 * screenshots is refused); four already existed.
	 *
	 * The axdom pair is the valuable half. AXDOM=0 removes the Swift sidecar that joins DOM
	 * attributes onto AX elements, which on Yarn named 955 of 1044 otherwise-anonymous nodes.
	 * A map IS names, so a pass without it should produce a measurably worse one — and that
	 * is the only test of whether the sidecar earns its keep AT GROUNDING TIME. The existing
	 * p2-ax-grounded-axdom-off arm tests it at RUN time, against a map that had it.
	 *
	 * Adding one costs the same as adding three: six runs is two waves across three Macs and
	 * nine is three, so the marginal cost of the last two is tokens, not time.
	 */
	{
		id: "p1-explore-ax-noaxdom",
		phase: 1,
		kind: "explore",
		app: BENCH_APP,
		n: 1,
		dispatch: { backend: "ax", axdomOff: true },
		informs: "does the axdom sidecar earn its keep at GROUNDING time — map size and named-control count vs p1-explore-ax",
	},
	{
		id: "p1-explore-ax-noaxdom-no-vision",
		phase: 1,
		kind: "explore",
		app: BENCH_APP,
		n: 1,
		dispatch: { backend: "ax", axdomOff: true, noVision: true },
		/**
		 * COMPARISON-ONLY: no task arm reads this map, deliberately. It completes the
		 * perception grid so the other three ax cells can be read against a floor, and a
		 * grounding pass is a measurement in its own right — map size, surfaces reached and
		 * cost are the phase-1 outputs. Adding a task consumer would mean three more phase-2
		 * runs to answer a question the grid already answers.
		 */
		comparisonOnly: true,
		informs: "the bare AX tree alone: the floor of the element channel, with neither DOM attrs nor screenshots",
	},
	{
		id: "p1-explore-cdp-no-vision",
		phase: 1,
		kind: "explore",
		app: BENCH_APP,
		n: 1,
		dispatch: { backend: "cdp", noVision: true },
		informs: "what screenshots buy on the SHIPPING backend — the ax answer may not transfer",
	},
	/**
	 * The vision-only GROUNDING pass — discovery from screenshots alone, no element list.
	 *
	 * This is the arm the matrix was missing: it had three vision-only TASK arms and no
	 * vision-only grounding, so "can this agent work on an app whose AX tree is useless"
	 * was only ever half-asked. A run-time-only answer is not the deployment question,
	 * because onboarding a new app starts with discovery.
	 *
	 * It writes its own `.vision.*` pair (explore/state.ts) rather than over the
	 * element-grounded map, precisely so phase 2 can compare the two tiers — and the stamp
	 * records provenance `explore-vision` with control tallies marked DECLARED, since a
	 * screenshots-only pass self-reports coverage through the `survey` tool instead of
	 * measuring it against an element list. Read those numbers as claims, not counts.
	 */
	{
		id: "p1-explore-vision",
		phase: 1,
		kind: "explore",
		app: BENCH_APP,
		n: 1,
		dispatch: { backend: "ax", noAx: true },
		informs: "can grounding itself be done from screenshots — declared coverage, pass duration, map size vs the ax pass",
	},
];

/** Phase 2 core — backend × grounding, n=3 per cell. */
const PHASE2_CORE: Arm[] = BACKENDS.flatMap((backend) => [
	task(`p2-${backend}-ungrounded`, { backend, noGrounding: true }, "ad-hoc discovery floor on this backend"),
	task(`p2-${backend}-grounded`, { backend }, "what a grounding pass buys on this backend"),
]);

/** Phase 2 permutation slices — each maps to a fork in the implementation Aman inherits. */
const PHASE2_SLICES: Arm[] = [
	// Grounds on the map a sidecar-less pass wrote, so the arm measures the sidecar's absence
	// END TO END rather than only at run time. Without this it read yarn.ax — a map the
	// sidecar helped build — and could only ever have shown half the effect.
	task("p2-ax-grounded-axdom-off", { backend: "ax", axdomOff: true }, "is the Swift sidecar worth shipping, end to end (grounding AND run)"),
	// Grounds on the map an element-only pass wrote, so the map's vocabulary matches what this
	// run can perceive — the same reason the vision arm reads the vision map. Also the only
	// thing that consumes p1-explore-no-vision's output; without it that pass writes an
	// artifact nobody reads.
	task("p2-ax-grounded-no-vision", { backend: "ax", noVision: true }, "what the screenshot channel buys on ax", { env: { APPMAP_VARIANT: "novision" } }),
	task("p2-cdp-grounded-no-vision", { backend: "cdp", noVision: true }, "same on cdp — DOM snapshot is text-rich; fleet-scale cost", { env: { APPMAP_VARIANT: "novision" } }),
	task("p2-ax-curated", { backend: "ax", useRecipe: true }, "explore pass vs 10 minutes of human notes"),
	// Vision-only is ax-backend-only by construction: cdp observations ARE ref lists.
	task("p2-vision-only-ungrounded", { backend: "ax", noAx: true, noGrounding: true }, "the floor: screenshots alone, cold"),
	/**
	 * Vision-only run against the ORDINARY stamped appmap — the one an ax explore pass wrote.
	 * No new infrastructure: docs/appmaps/<slug>.md already exists.
	 *
	 * This replaced an earlier arm that asked for APPMAP_VARIANT=vision, i.e. the output of a
	 * vision-only explore pass, which is deliberately not built yet. That arm was a trap: a
	 * missing map does not fail — loadGrounding returns `provenance: "none"` — so it would
	 * have run the SAME conditions as the ungrounded arm under a grounded label, and the
	 * report would have concluded prose grounding does not help a blind agent from a treatment
	 * that was never applied.
	 *
	 * What this arm DOES prove: whether machine-generated prose lifts a screenshots-only
	 * agent. That is a shipping configuration — ground once where AX works, then run
	 * vision-only (no sidecar, no AX flakiness at fleet scale). A lift here means the AX path
	 * can be dropped at RUN time and kept at GROUNDING time.
	 *
	 * What it does NOT prove, and must not be read as: the AX-hostile-app story. The map was
	 * written by a pass with strictly more perception than the run, so an app whose AX is
	 * useless at BOTH stages is still unmeasured — that needs the vision-only explore pass.
	 * The id says `axmap` so a reader of the report cannot miss which it is.
	 */
	task("p2-vision-only-grounded-axmap", { backend: "ax", noAx: true }, "does explore-written prose lift a vision-only agent (map from an ax pass — see the note)"),
	/**
	 * The AX-hostile-app story, measured properly: grounding AND actuation both from
	 * screenshots only. Consumes the `.vision` map that p1-explore-vision writes, so it is
	 * gated on phase 1 having run — with no map, loadGrounding degrades to provenance "none"
	 * and this silently becomes a duplicate of the ungrounded arm. `bench collect` records
	 * provenance per run, so check it reads `explore-vision` before believing this row.
	 *
	 * Paired with -axmap above, the two separate a question that was previously conflated:
	 * -axmap asks whether the AX path can be dropped at RUN time (ground once where AX works),
	 * this asks whether it can be dropped ENTIRELY.
	 */
	task(
		"p2-vision-only-grounded-visionmap",
		{ backend: "ax", noAx: true },
		"grounding and actuation both vision-only — the app-with-no-usable-AX deploy story",
		{ env: { APPMAP_VARIANT: "vision" } },
	),
	task("p2-vision-only-curated", { backend: "ax", noAx: true, useRecipe: true }, "same against the human-written tier"),
];

/**
 * Phase 2 generalization slice — Notion on the web, cdp only (a browser page IS the DOM;
 * there is no second backend to compare here).
 *
 * This is the question the matrix lost when the Notion Calendar arms were cut for the app
 * being absent from the fleet: does ANY of the Yarn result transfer to a different, larger
 * application? Same two tiers as the core arms so the comparison is like-for-like —
 * ungrounded floor against the explore-grounded pass — at n=2, which is a spot check, not a
 * measurement.
 *
 * Two things to know before running it. The task MUTATES a live personal workspace: every run
 * creates a document, so a full slice leaves up to four behind, reported via `claim` and
 * never auto-deleted (deletion has no second chance). And Notion is far bigger than Yarn, so
 * the phase-1 pass over it has no precedent for duration or cost — the 40min/96-action Yarn
 * figure is not a prediction, and EXPLORE_MAX_ACTIONS is the cap if one is wanted.
 */
// ~~PHASE2_WEB~~ — dropped with the web explore above. Two arms, n=2 each, that grounded on
// the Notion map; without the explore they have nothing to ground on, and with it they were
// the second-longest runs in the matrix. Restore both together or neither.

/**
 * ~~Phase 2 generalization slice (Notion Calendar, the native app)~~ — DROPPED 2026-07-31.
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

/**
 * Phase 5 — filmed takes. Every measured configuration, once, with `--record`.
 *
 * This is FOOTAGE, and it is also the matrix's own validity check. `--record` is not a
 * passive camera: it injects DEMO CONDUCT into the system prompt ("prefer clicking visible
 * controls over keyboard shortcuts"), swaps in a demo act tool without `set_value`, and
 * changes actuation mechanics (hover→dwell→click, per-keystroke typing). A filmed run
 * therefore has a different action space than the run that measured it.
 *
 * That is exactly why filming EVERY config matters rather than only the winner. Demo mode
 * forbids the keyboard paths an ungrounded agent is most likely to have discovered, so it may
 * penalise the ungrounded and vision-only arms harder than the grounded ones. If the
 * reliability ranking REORDERS under film, then phases 1–4 measured a ranking in a mode the
 * product does not ship — and nothing else in the matrix can see that.
 *
 * Read these as a flag to investigate, never as a conclusion: n=1 per config buys direction,
 * not significance. A reorder says "re-measure this arm filmed at n=3", not "the ranking is
 * wrong".
 *
 * Derived from the phase-2 arms rather than re-declared, so a config cannot be measured and
 * filmed under different flags. Two things it inherits for free: teardown runs AFTER the
 * recording is assembled, so the video ends on the changed state while the app is still put
 * back; and filmed runs write per-run step frames, so `bench judge` can return real VISUAL
 * verdicts on them instead of frames-stale.
 *
 * Explores are deliberately NOT filmed — a 40-minute video of the agent operating every
 * control it can find is not a demo, and nothing downstream consumes it.
 *
 * Remaining manual step: the composited cursor. `npm run humanize -- <stamp>` per filmed run,
 * after `bench collect` pulls it. It reads the run's own trajectory (click points, target
 * rects, real typing timings), so it needs no extra capture — but it is not wired into
 * `bench` yet, and the gallery is where the renders surface.
 */
const filmed = (arm: Arm): Arm => ({
	...arm,
	id: `p5-${arm.id.replace(/^p[0-9]-/, "")}-filmed`,
	phase: 5,
	n: 1,
	dispatch: { ...arm.dispatch, record: true },
	informs: `filmed take — does this config survive demo conduct (mouse-first, no set_value)? ${arm.informs ?? ""}`.trim(),
});

const PHASE5: Arm[] = [
	...PHASE2_CORE.map(filmed),
	...PHASE2_SLICES.map(filmed),
	// Replays are the best filming candidates in the whole matrix: zero model calls on the
	// happy path means no thinking gaps to speed up in post. Source the recipes phase 3
	// already compiled rather than compiling again.
	...BACKENDS.map((backend): Arm => ({
		id: `p5-replay-${backend}-filmed`,
		phase: 5,
		kind: "replay",
		app: BENCH_APP,
		n: 1,
		dispatch: { backend, record: true },
		sourceArm: `p3-compile-${backend}`,
		informs: "filmed take of a deterministic replay — the cleanest possible demo footage, no model latency to hide",
	})),
];

export const MATRIX: readonly Arm[] = [...PHASE1, ...PHASE2_CORE, ...PHASE2_SLICES, ...PHASE3, ...PHASE4, ...PHASE5];

export const phaseArms = (phase: Phase): Arm[] => MATRIX.filter((a) => a.phase === phase);

export const armById = (id: string): Arm | undefined => MATRIX.find((a) => a.id === id);

/** Total runs a phase performs, local compiles included — the per-phase figures `bench plan` prints. */
export const phaseRunCount = (phase: Phase): number => phaseArms(phase).reduce((sum, a) => sum + a.n, 0);

/**
 * The human-readable spelling of an arm's knobs, in the vocabulary the plan doc and the CLI
 * use (`--backend ax`, `NO_GROUNDING=1`, …) rather than the wire field names. For `bench
 * plan` output and dispatch confirmation lines.
 */
/**
 * The appmap slug an arm reads and writes. ONE derivation for the whole bench.
 *
 * Three things vary independently — target, backend, perception tier — and any two arms
 * sharing a filename means the later pass silently overwrites the earlier. That happened
 * twice on 2026-08-01: first every Yarn explore wrote yarn.json (ax 156 nodes, cdp 196,
 * no-vision 180, last writer won), then the first fix added the backend but not the tier so
 * p1-explore-ax and p1-explore-no-vision still collided.
 */
export const armAppmapSlug = (arm: Arm): string =>
	appmapSlug(arm.app, {
		visionOnly: Boolean(arm.dispatch.noAx),
		noVision: Boolean(arm.dispatch.noVision),
		axdomOff: Boolean(arm.dispatch.axdomOff),
		...(arm.dispatch.backend ? { backend: arm.dispatch.backend } : {}),
	});

/**
 * What the model can SEE, in words — because the flags do not say it.
 *
 * `--backend ax --no-ax` reads as a contradiction and is not one: the two flags name
 * different axes. `--backend` is ACTUATION (how a click is delivered — the cua driver or
 * CDP), `--no-ax`/`--no-vision` are PERCEPTION (which channels reach the model). David read
 * the vision arm as "vision + AX" on 2026-07-31, the opposite of what it measures, because
 * the plan printed only the flags.
 *
 * Names the element channel PER BACKEND, because they are not the same thing: on ax it is
 * the accessibility tree plus the DOM attributes the axdom sidecar joins on (AXDOM=0 removes
 * the second half); on cdp the DOM IS the element channel and there is no AX at all.
 */
export function perceptionLine(arm: Arm): string {
	const { noAx, noVision, axdomOff, backend } = arm.dispatch;
	// Refused by the explore CLI (a window title and nothing else), but rendered honestly if a
	// future arm ever declares it — a label that quietly cannot happen teaches nothing.
	if (noAx && noVision) return "nothing";
	if (noAx) return "screenshots only";
	const els = backend === "cdp" ? "DOM" : axdomOff ? "AX tree (no DOM attrs)" : "AX tree + DOM attrs";

	return noVision ? els : `${els} + screenshots`;
}

/**
 * A plain-English name for an arm — the KIND and the grounding tier, nothing else.
 *
 * Deliberately short and deliberately silent about perception, because every surface that
 * shows this also shows perceptionLine in its own column; saying "screenshots only" twice in
 * one row is noise. Together they read: "Grounded task | screenshots only".
 *
 * Derived from the dispatch object, never from the rendered flags string. The dash used to
 * do `flags.includes("USE_RECIPE")`, which is a parse of a display artifact — it breaks the
 * moment flagsLine changes its wording, and silently, since a missed match just falls
 * through to "grounded task".
 */
export function armTitle(arm: Arm): string {
	const filmed = arm.dispatch.record ? "filmed " : "";
	if (arm.kind === "explore") return `${filmed}grounding pass${arm.dispatch.url ? " (web)" : ""}`;
	if (arm.kind === "compile") return "recipe compile";
	if (arm.kind === "replay") return `${filmed}recipe replay${arm.dispatch.noRescue ? " (no rescue)" : ""}`;

	const tier = arm.dispatch.noGrounding
		? "ungrounded"
		: arm.dispatch.useRecipe
			? "human-notes"
			: arm.env?.APPMAP_VARIANT === "vision"
				? "vision-map grounded"
				: "grounded";

	return `${filmed}${tier} task`;
}

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
