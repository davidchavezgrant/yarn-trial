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

export type Phase = 1 | 2 | 3 | 4 | 5 | 6 | 7;

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
	/** `USE_PROCEDURES=1`: ground on a procedure harvested from a judged-PASS run of THIS task. */
	useProcedures?: boolean;
	/** Which procedure lineage to load: one distilled from a grounded run, or from an ungrounded one. */
	procedureLineage?: "grounded" | "ungrounded";
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
	/**
	 * Step budget for this arm, when the default 15 is the wrong size for its TASK.
	 *
	 * The settings tasks finish in 5-13 steps, so 15 was never questioned. The creation task
	 * cannot: the only known-successful run of that flow took 19, and every creation arm in the
	 * first pass stopped at exactly 15 with `gave-up`. They were measuring the ceiling, not the
	 * agent — a budget starvation dressed up as a capability result.
	 */
	steps?: number;
	/**
	 * Pin THIS arm to a model, overriding the pass-level one.
	 *
	 * Model was a pass-level choice only, so the whole 115-run matrix ran on one model and the
	 * "some runs with Claude" half of the plan had nowhere to live: dispatching a second model
	 * meant re-running an entire 45-run phase. An arm-level pin lets a handful of Claude cells
	 * sit beside their Sol twins in the same pass, which is also the only way the report's
	 * per-model rows become a comparison rather than two separate tables.
	 */
	model?: string;
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
	/**
	 * WHY this arm actuates over `ax` when the default is `cdp`.
	 *
	 * Required on every ax arm, and enforced by a test. CDP is the production actuator — it
	 * backgrounds, it never steals the operator's pointer, and it has none of cua's liabilities
	 * (no 300s session lifetime, no shared daemon, no consent gate). AX is the FALLBACK: the
	 * actuator of last resort when there is no reachable DOM.
	 *
	 * The matrix drifted to 73% ax (77 runs against 28) purely because `task()` callers kept
	 * writing `backend: "ax"` out of habit, and nothing asked them why. A default is not a
	 * decision; this field is what turns each ax arm back into one.
	 */
	axRationale?: string;
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
 * NOTION IS GONE (David, 2026-08-01) — not deferred, killed as an approach.
 *
 * Three things used to live here and all are removed: `NC_APP`/`NC_TASK` (the Notion Calendar
 * generalization slice, cut when the app turned out to be installed on none of the three Macs),
 * and `WEB_EXPLORE_URL`/`WEB_TASK` (app.notion.com as the canonical web target, cut the same
 * day — the grounding pass was the longest in the matrix at 1h14m and the prompt and frontier
 * fixes forced a re-run of every pass).
 *
 * Recorded rather than silently deleted because "add a second app" is a reasonable idea someone
 * will have again, and the reason it did not happen here is logistical, not conceptual: nothing
 * in the matrix measures cross-APP transfer, only cross-task (phase 4). Their data is kept —
 * docs/appmaps/web-app.notion.com.*, notion-calendar.* and docs/recipes/notion-calendar.md are
 * the only record of what those passes produced.
 */


/**
 * Phase 4's second task (chosen by David, 2026-08-01): motion blur.
 *
 * The point of a second task is to ask whether phase 2's findings are cursor-task-specific, and
 * the previous stand-in ("auto-add screen zooms") could only answer half of it. That control is
 * SINGLE-SCOPE — it appears in no committed map's ambiguity list — so it could generalise the
 * actions/tokens half and none of the correctness half, which is the half CLAUDE.md calls the
 * more important result.
 *
 * `motion-blur` is dual-scope in all three committed maps (brand-wide default vs per-document
 * override), so the wrong-scope failure class is reachable on it, and phase 4 can generalise
 * both halves. `shadow-blur` and `entrance-exit-animation` were the other qualifying options.
 *
 * Goal-only, per the measurement rule: it names the outcome, never the route.
 */
export const PHASE4_TASK = "show me how to change the motion blur";
/**
 * Yarn's ACTUAL product flow — write a script, get scenes, pick a voice — as opposed to the two
 * settings toggles the rest of the matrix runs on.
 *
 * Every finding through phase 6 is scoped to flipping a dropdown. That is a fair test of
 * navigation and verification and a poor proxy for what Yarn sells, which is making a video.
 * Phrased GOAL-ONLY: the one previous run of this flow dictated its route ("then open the
 * Script tab…") and passed the hint gate, which is the hole NAV_HINT/SEQUENCE_HINT now close.
 */
export const CREATION_TASK =
	"Make a two-scene video script for a coffee ordering app called Brew, narrated by Cassidy. Do not publish, export, or share it.";
/**
 * The comparison model. Every one of the first 115 runs was Sol; nothing tested a second.
 *
 * A BARE id on purpose — makeClient routes `claude-*` direct to the Anthropic API, while
 * `anthropic/claude-*` is OpenRouter's namespace for the same weights. The runners hold both
 * keys, and direct removes a routing hop and an availability question from a comparison whose
 * whole job is to isolate one variable.
 */
export const BENCH_ALT_MODEL = "claude-fable-5";

export const BACKENDS: readonly BenchBackend[] = ["ax", "cdp"];

/**
 * The model the primary pass runs on — DECLARED, never inferred from ambient keys.
 *
 * `makeClient` resolves `(default)` from whichever API keys a machine happens to have, which
 * means two machines answer "what model is this benchmark on" differently. On 2026-08-01 that
 * produced a real scare: the fleet Macs carry AGENT_MODEL=azure/gpt-5.6-sol and were running
 * Sol correctly, while the operator's laptop — Anthropic key, no Azure key — resolved the
 * default to claude-fable-5 and the dashboard displayed THAT for every uncollected run. The
 * pass looked like it was running on the challenger.
 *
 * For a benchmark whose headline comparison is Claude against OpenAI, the model is the variable.
 * `runPhase` now stamps every dispatch with this id unless --model overrides, so a run's model
 * is a property of the pass rather than of the host that picked up the job. David set OpenAI as
 * the primary and Claude as the challenger (2026-07-31); `bench challenger` is the arm that
 * varies it deliberately.
 */
export const BENCH_PRIMARY_MODEL = "azure/gpt-5.6-sol";

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
	/**
	 * Vision-only EXPLORATION on cdp — the pass that writes `yarn.cdp.vision`.
	 *
	 * Needed structurally (the cdp vision-only grounded arm has to read a map some pass wrote)
	 * and worth running on its own: vision-only was phase 1's weakest explorer at 9-21 surfaces
	 * against 27-50 for the element arms, and it addresses by screenshot pixel on the backend
	 * where those pixels do not match the frame the harness reports. Whether a vision-only pass
	 * is genuinely poor at discovery, or was simply unable to open what it clicked, is
	 * unanswered — and this is the arm that answers it.
	 */
	{
		id: "p1-explore-vision-cdp",
		phase: 1,
		kind: "explore",
		app: BENCH_APP,
		/**
		 * TWO passes. It is a reference arm now — three task arms ground on its map — and
		 * vision-only discovery is the widest-spread measurement in the matrix: the ax vision
		 * pass gave 9 surfaces on one attempt and 21 on the next under identical code. Reading a
		 * single draw of that as "vision-only discovers little" is what the repeats exist to
		 * stop, and here a bad draw would also mis-grade every arm downstream of it.
		 */
		n: 2,
		dispatch: { backend: "cdp", noAx: true },
		informs: "does vision-only discovery improve when its clicks land — surfaces/nodes against p1-explore-vision on ax",
	},
	{
		id: "p1-explore-no-vision",
		phase: 1,
		kind: "explore",
		app: BENCH_APP,
		n: 1,
		dispatch: { backend: "ax", noVision: true },
		informs: "can grounding be done from the element tree alone — map size and cost vs the same pass with Vision",
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
		// Consumed by p2-min-context-grounded since 2026-08-01 — it was comparison-only until
		// David pointed out that the least-context condition is exactly the one worth running
		// a task in: it measures how much the agent can work out on the fly.
		informs: "the bare AX alone: the floor of the element channel, with neither DOM attrs nor Vision",
	},
	{
		id: "p1-explore-cdp-no-vision",
		phase: 1,
		kind: "explore",
		app: BENCH_APP,
		n: 1,
		dispatch: { backend: "cdp", noVision: true },
		informs: "what Vision buys on the SHIPPING backend — the ax answer may not transfer",
	},
	/**
	 * The vision-only GROUNDING pass — discovery from screenshots alone, no element list.
	 *
	 * This is the arm the matrix was missing: it had three vision-only TASK arms and no
	 * vision-only grounding, so "can this agent work on an app whose AX is useless"
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
		axRationale: "Vision-only is ax-only by construction — a cdp observation IS a ref list, so 'Vision only' cannot be expressed on that backend",
		informs: "can grounding itself be done from Vision — declared coverage, pass duration, map size vs the ax pass",
	},
];

/** Phase 2 core — backend × grounding, n=3 per cell. */
const PHASE2_CORE: Arm[] = BACKENDS.flatMap((backend) => [
	task(`p2-${backend}-ungrounded`, { backend, noGrounding: true }, "ad-hoc discovery floor on this backend"),
	task(`p2-${backend}-grounded`, { backend }, "what a grounding pass buys on this backend"),
]);

/** Phase 2 permutation slices — each maps to a fork in the implementation Aman inherits. */
const PHASE2_SLICES: Arm[] = [
	/**
	 * THE NATIVE-EQUIVALENT TIER (reframed 2026-08-01, David).
	 *
	 * These arms were declared to answer a build/don't-build question about a Swift binary —
	 * "is the sidecar worth shipping" — and they do. But the same runs answer something Yarn
	 * needs far more, and it was nowhere in the report: **can this drive an app with no DOM at
	 * all?**
	 *
	 * AXDOM=0 IS that condition, and holding the app constant is what makes it a measurement
	 * rather than an anecdote. axdom's whole trick is reading `AXDOMIdentifier` and
	 * `AXDOMClassList` — attributes that exist only because the target is Chromium. Switch it
	 * off and what remains is AX with no DOM behind it, actuated through the
	 * accessibility API: exactly the surface a native AppKit or SwiftUI app presents. The
	 * grounding matches, too — `p1-explore-ax-noaxdom` writes the map these read, so the
	 * limitation applies END TO END rather than only at run time.
	 *
	 * IT IS AN OPTIMISTIC BOUND, and the report must say so. Chromium derives its AX content FROM
	 * the DOM, so even sidecar-less that content is unusually complete; a hand-rolled AppKit app's AX is
	 * typically sparser and less consistently labelled. Measured on Yarn, axdom named 955/1044
	 * anonymous nodes and 37 of 64 anonymous INTERACTIVE controls — turning it off returns those
	 * 64 to anonymous, which is native-like, but everything Chromium already labelled stays
	 * labelled.
	 *
	 * And it simulates PERCEPTION only, not lifecycle. The one real native failure we have
	 * measured — Hex Fiend, 0/15 verified on 2026-07-30 — was an activation-policy problem: the
	 * app never became key/main, so every menu item stayed disabled. AXDOM=0 does not reproduce
	 * that. The fix lives in `AxBackend.acquire` and is still unvalidated against a real native
	 * app (docs/research/2026-07-30-native-mac-apps-investigation.md).
	 */
	task(
		"p2-ax-grounded-axdom-off",
		{ backend: "ax", axdomOff: true },
		"NATIVE-EQUIVALENT, grounded: AX with no DOM behind it, mapped and run under the same limit. Also answers whether the Swift sidecar earns its keep end to end.",
	),
	/**
	 * The cell the native tier was missing: cold AND native-equivalent, screenshots available.
	 * Its counterpart `p2-ax-ungrounded` has the sidecar, and `p2-min-context-ungrounded` also
	 * drops vision — so without this there was no way to say "no DOM, no map, but it can see",
	 * which is the honest starting position for an app nobody has onboarded yet.
	 */
	task(
		"p2-ax-noaxdom-ungrounded",
		{ backend: "ax", axdomOff: true, noGrounding: true },
		"NATIVE-EQUIVALENT, cold: no DOM attributes, no map, Vision on — the un-onboarded native app",
	),
	// Grounds on the map an element-only pass wrote, so the map's vocabulary matches what this
	// run can perceive — the same reason the vision arm reads the vision map. Also the only
	// thing that consumes p1-explore-no-vision's output; without it that pass writes an
	// artifact nobody reads.
	task("p2-ax-grounded-no-vision", { backend: "ax", noVision: true }, "what the Vision channel buys on ax", { env: { APPMAP_VARIANT: "novision" } }),
	task("p2-cdp-grounded-no-vision", { backend: "cdp", noVision: true }, "same on cdp — DOM snapshot is text-rich; fleet-scale cost", { env: { APPMAP_VARIANT: "novision" } }),
	/**
	 * MINIMUM CONTEXT, both tiers (David, 2026-08-01). Bare AX: no DOM attributes from
	 * the sidecar, no screenshots. It is the most impoverished condition an agent can be asked
	 * to work in and still be addressing real controls.
	 *
	 * Two reasons this pair earns six runs. It is the only test of how well the agent figures
	 * things out ON THE FLY when almost nothing is handed to it — the deployment case where
	 * the sidecar is unavailable and screenshots are too expensive at fleet scale. And the
	 * grounded half is the only consumer of p1-explore-ax-noaxdom-no-vision's map, which was
	 * otherwise a 30-minute pass written for a comparison alone.
	 *
	 * The ungrounded half is the floor of the entire matrix: least perception AND no map. Every
	 * other arm should beat it, and an arm that does not is telling you its condition adds
	 * nothing.
	 */
	task("p2-min-context-grounded", { backend: "ax", axdomOff: true, noVision: true }, "NATIVE-EQUIVALENT, harshest grounded: bare AX, no Vision, mapped under the same limit", {
		env: { APPMAP_VARIANT: "novision" },
	}),
	task("p2-min-context-ungrounded", { backend: "ax", axdomOff: true, noVision: true, noGrounding: true }, "NATIVE-EQUIVALENT floor: bare AX, no Vision, no map — can it work it out on the fly"),
		task(
		"p2-curated",
		{ backend: "cdp", useRecipe: true },
		// TASK-CONTAMINATED, and the numbers must be reported as such. docs/recipes/yarn.md names
		// the canonical task's control, its surface, its exact options AND the brand-vs-document
		// split — so this arm receives the route and the wrong-scope defence. Its own header also
		// says it was "assembled from an exploration pass on 2026-07-29", so it is not 10 minutes
		// of human notes either. auditTaskPrompt gates the TASK string; nothing gates grounding text.
		"explore pass vs a curated tier that CONTAINS THIS TASK'S ANSWER — an upper bound on grounding, not a human-notes comparison",
	),
	// Vision-only is ax-backend-only by construction: cdp observations ARE ref lists.
	task("p2-vision-only-ungrounded", { backend: "ax", noAx: true, noGrounding: true }, "the floor: Vision alone, cold", { axRationale: "Vision-only is ax-only by construction — a cdp observation IS a ref list, so 'Vision only' cannot be expressed on that backend" }),
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
	task("p2-vision-only-grounded-axmap", { backend: "ax", noAx: true }, "does explore-written prose lift a Vision-only agent (map from an element-perceiving pass)", { axRationale: "Vision-only is ax-only by construction — a cdp observation IS a ref list, so 'Vision only' cannot be expressed on that backend" }),
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
		"grounding and actuation both Vision-only — the app-with-no-usable-AX deploy story",
		{ env: { APPMAP_VARIANT: "vision" }, axRationale: "Vision-only is ax-only by construction — a cdp observation IS a ref list, so 'Vision only' cannot be expressed on that backend" },
	),
	task("p2-vision-only-curated", { backend: "ax", noAx: true, useRecipe: true }, "same against the human-written tier", { axRationale: "Vision-only is ax-only by construction — a cdp observation IS a ref list, so 'Vision only' cannot be expressed on that backend" }),
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
		id: "p3-replay-norescue",
		phase: 3,
		kind: "replay",
		app: BENCH_APP,
		n: 3,
		// cdp, not ax: this measures the UNATTENDED FLEET POSTURE, which is a question about
		// how the shipping configuration behaves with no operator, not about the fallback.
		dispatch: { backend: "cdp", noRescue: true },
		sourceArm: "p3-compile-cdp",
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
	task("p4-ungrounded", { backend: "cdp", noGrounding: true }, "is everything above cursor-task-specific", { phase: 4, task: PHASE4_TASK, n: 2 }),
	task("p4-grounded", { backend: "cdp" }, "is everything above cursor-task-specific", { phase: 4, task: PHASE4_TASK, n: 2 }),
	{
		id: "p4-compile",
		phase: 4,
		kind: "compile",
		app: BENCH_APP,
		n: 1,
		// Follows p4-grounded: a recipe compiled from a cdp run resolves cdp's control names.
		dispatch: { backend: "cdp" },
		sourceArm: "p4-grounded",
		informs: "does compile generalize past the canonical task",
	},
	{
		id: "p4-replay",
		phase: 4,
		kind: "replay",
		app: BENCH_APP,
		n: 2,
		dispatch: { backend: "cdp" },
		sourceArm: "p4-compile",
		informs: "does replay generalize past the canonical task",
	},
];

/**
 * Phase 6 — procedures: can an agent's own written-up success replace the exploration pass?
 *
 * The question Yarn actually has to answer to ship this. Jasper's budget is ~24h to onboard a
 * new app, and the current answer to "how" is a 40-minute frontier sweep producing a topological
 * map. A procedure is the other possibility: run the task once however you can, have the agent
 * write down the route that worked, and ground every later run on that. If it holds, onboarding
 * cost collapses from a sweep to a handful of successful runs.
 *
 * PREREQUISITE, and it is not optional: procedures are harvested from judged-PASS phase-2 runs
 * by `./run bench harvest`, which needs `bench judge` to have run first. There is no arm here
 * that produces them — harvesting is an operator step, deliberately, because promoting a
 * procedure makes it an INPUT to future runs and that should never happen as a side effect of
 * dispatching a phase.
 *
 * The comparison is three-way against arms that already exist at n=3 on the same task and
 * backend: p2-<backend>-ungrounded (nothing), p2-<backend>-grounded (the appmap), and these
 * (a previous run's write-up). USE_PROCEDURES REPLACES the appmap rather than adding to it —
 * stacking them would measure neither.
 */
const PHASE6: Arm[] = [
	/**
	 * The honest replacement claim (added by David, 2026-08-01). Its procedure is harvested from
	 * an UNGROUNDED run — an agent that worked the app out from nothing, succeeded, was judged
	 * correct, and wrote down what worked. Every later run reads that instead of a map.
	 *
	 * This is the only arm in the matrix that can speak to "does the 40-minute exploration pass
	 * need to exist", because it is the only procedure that does not presuppose one. If it holds,
	 * per-app onboarding collapses from a sweep to a handful of successful runs, which is the
	 * question Yarn's ~24h budget actually turns on.
	 *
	 * It may not be runnable: the wrong-scope class makes a judged-PASS ungrounded run rare, and
	 * `harvestRefusal` will decline every one that failed. That refusal IS a finding — "an agent
	 * with no map could not produce trustworthy knowledge" answers the question too — and the
	 * phase-6 gate refuses dispatch rather than silently running it as an appmap arm.
	 */
	...BACKENDS.map((backend): Arm => ({
		id: `p6-${backend}-procedure-from-ungrounded`,
		phase: 6,
		kind: "task",
		app: BENCH_APP,
		task: CANONICAL_TASK,
		n: 3,
		dispatch: { backend, useProcedures: true, procedureLineage: "ungrounded" as const },
		sourceArm: `p2-${backend}-ungrounded`,
		informs:
			"THE replacement question: can a write-up by an agent that had no map stand in for the exploration pass? " +
			"vs p2-<backend>-ungrounded (what its author knew) and p2-<backend>-grounded (the sweep it would replace).",
	})),
	...BACKENDS.map((backend): Arm => ({
	id: `p6-${backend}-procedure`,
	phase: 6,
	kind: "task",
	app: BENCH_APP,
	task: CANONICAL_TASK,
	n: 3,
	dispatch: { backend, useProcedures: true },
	sourceArm: `p2-${backend}-grounded`,
	informs:
		"does a frozen, judge-passed route beat live appmap grounding ON THE TASK IT WAS HARVESTED FROM? " +
		"NOT a replacement claim — its procedure presupposes the sweep; the -from-ungrounded arm above is that claim. " +
		"NOT a transfer claim: a procedure is per-task where a map is per-app, and no arm tests it on a second task.",
	})),
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
 * FILM EVERY TASK AND REPLAY ARM (David, 2026-08-01). The deliverable is not one good video —
 * it is a CORPUS showing how each lever moves outcomes and approaches, so a config that is
 * measured but never seen is a gap. Resource cost is explicitly not a constraint here.
 *
 * Explores remain unfilmed, and that is not a resource decision. `--record` swaps in demo rules
 * and a demo act tool with no `set_value`, which CHANGES WHAT THE PASS DOES — a filmed explore
 * would produce a different map from the one every downstream arm is grounded on, corrupting the
 * input rather than documenting it. Nothing downstream consumes explore footage either.
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

/**
 * Every arm that PERFORMS something, filmed. Derived from the arms themselves rather than
 * re-declared, so a config can never be measured and filmed under different flags — and so a
 * new arm anywhere upstream is filmed automatically instead of being remembered.
 *
 * Compiles are excluded because they are a local file transform with nothing to see; explores
 * for the reason above.
 */
/**
 * Phase 7 — the two axes the first 115 runs never varied: the TASK and the MODEL.
 *
 * Creation arms run the product flow on cdp, the actuator that works. Claude arms mirror three
 * phase-2/6 cells exactly, changing only the model, so the comparison is a difference of one
 * variable rather than two tables side by side.
 */
/**
 * The creation task on EVERY phase-2 config, derived from that grid rather than hand-listed.
 *
 * It began as three cdp cells, which quietly narrowed the question: the settings tasks showed
 * that grounding's value is backend-dependent (ax ungrounded 1/3 against every cdp arm at 3/3)
 * and that only human prose picks brand scope. None of that can be checked on the product flow
 * from a cdp-only slice.
 *
 * Derived so a config added to phase 2 gets a creation twin automatically — the same rule
 * FILMABLE follows, and for the same reason: the alternative is remembering.
 *
 * Expect these to strain verification rather than navigation. The one prior run of this flow
 * had 11 of 19 steps unverified, because typing a script into a rich editor produces little
 * checkable text. Whether the harness can grade creative work AT ALL is the second finding
 * here, and arguably the more useful one.
 */
const creationArms = (): Arm[] =>
	[...PHASE2_CORE, ...PHASE2_SLICES]
		.filter((a) => a.kind === "task")
		.map((a) => ({
			...a,
			id: a.id.replace(/^p2-/, "p7-create-"),
			phase: 7 as Phase,
			task: CREATION_TASK,
			// 30, against a known-good 19. The settings tasks run 5-13 and never strained the
			// default; writing a two-scene script and setting a voice is a longer flow, and a
			// budget that cuts it off measures the budget.
			dispatch: { ...a.dispatch, steps: 30 },
		}));

const PHASE7: Arm[] = [
	...creationArms(),
	// Same three cells as Sol ran, one variable changed. Canonical task on purpose: it is the
	// only task with 45 runs of Sol baseline behind it.
	task("p7-vision-only-cdp-curated", { backend: "cdp", noAx: true, useRecipe: true }, "vision-only against the human-written tier — completes the grid ax already has", { phase: 7 }),
	/**
	 * An ELEMENT-perceiving agent reading a map written from PIXELS.
	 *
	 * Unmeasured on either backend, and it is the question that decides whether a vision-only
	 * exploration pass is worth its 30-40 minutes at all. Every existing consumer of a
	 * vision-written map is itself vision-only, so a poor result there is ambiguous: bad map, or
	 * a reader that cannot act on a good one? Handing the same map to a reader with full
	 * perception separates them.
	 *
	 * It also matters practically. If a pixel-written map grounds a normal agent about as well
	 * as an element-written one, then onboarding an app whose AX tree is useless costs a vision
	 * pass and nothing else — which is the native-app generalisation story, priced.
	 */
	task("p7-cdp-grounded-visionmap", { backend: "cdp" }, "is a map written from pixels any good to an agent that can see elements", {
		phase: 7,
		env: { APPMAP_VARIANT: "vision" },
	}),
	task("p7-claude-cdp-ungrounded", { backend: "cdp", noGrounding: true, model: BENCH_ALT_MODEL }, "is the ungrounded floor a model property or a general one", { phase: 7 }),
	task("p7-claude-cdp-grounded", { backend: "cdp", model: BENCH_ALT_MODEL }, "does grounding lift Claude the way it lifts Sol", { phase: 7 }),
	/**
	 * Vision-only, re-run on the actuator that can aim.
	 *
	 * Every vision-only arm in phase 2 went 0/3, and I reported that as a perception result —
	 * "vision alone cannot find the controls". The failure classification says otherwise: 87 of
	 * their unverified steps are `target-never-appeared`, the signature of a click that did not
	 * land, and vision-only addresses by screenshot pixel on a backend where the AX frame and
	 * the screen disagree by ~40px. Its clicks were missing, not its eyes.
	 *
	 * On cdp the class is structurally absent (`scale:"css"` ties screenshot pixels to the
	 * coordinates act consumes), so these arms measure what the condition was always for. If
	 * they still fail, THAT is the perception result — and it will be the first honest one.
	 */
	task("p7-vision-only-cdp-ungrounded", { backend: "cdp", noAx: true, noGrounding: true }, "vision-only floor on an actuator that can aim", { phase: 7 }),
	task("p7-vision-only-cdp-grounded", { backend: "cdp", noAx: true }, "does a map lift vision-only once its clicks land (map from an element-perceiving pass)", { phase: 7 }),
	/**
	 * Vision-only at BOTH stages on cdp — the ax pair's `-visionmap` arm, on an actuator whose
	 * screenshot pixels and click coordinates are the same space. This is the honest version of
	 * the app-with-no-usable-AX deploy story: the ax pair could only ever answer it through a
	 * click path that misses by ~40px on this app.
	 */
	task("p7-vision-only-cdp-visionmap", { backend: "cdp", noAx: true }, "grounding AND actuation vision-only, on the backend that can aim", {
		phase: 7,
		env: { APPMAP_VARIANT: "vision" },
	}),
	task("p7-claude-cdp-procedure-from-ungrounded", { backend: "cdp", useProcedures: true, procedureLineage: "ungrounded", model: BENCH_ALT_MODEL }, "does the replacement result survive a model change — the finding most worth a second model", { phase: 7 }),
];

// Phase 7 joins the derivation rather than being remembered — that is the whole point of the
// rule. It also means the CREATION flow gets filmed, which is the footage closest to what Yarn
// actually sells; every take before it was of a dropdown being changed.
const FILMABLE: Arm[] = [...PHASE2_CORE, ...PHASE2_SLICES, ...PHASE3, ...PHASE4, ...PHASE6, ...PHASE7].filter((a) => a.kind === "task" || a.kind === "replay");

const PHASE5: Arm[] = FILMABLE.map(filmed);


export const MATRIX: readonly Arm[] = [...PHASE1, ...PHASE2_CORE, ...PHASE2_SLICES, ...PHASE3, ...PHASE4, ...PHASE5, ...PHASE6, ...PHASE7];

export const phaseArms = (phase: Phase): Arm[] => MATRIX.filter((a) => a.phase === phase);

/**
 * The model an arm will ACTUALLY run on: its own pin, else the pass default. Sample counting
 * has to agree with dispatch about this or a pinned arm never retires — its entries land under
 * the pinned model while submittedCount looks for the pass model, finds none, and re-dispatches
 * forever.
 */
export const armModel = (arm: Arm, passModel?: string): string | undefined => arm.dispatch.model ?? passModel;

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
 * the AX elements plus the DOM attributes the axdom sidecar joins on (AXDOM=0 removes
 * the second half); on cdp the DOM IS the element channel and there is no AX at all.
 */
export function perceptionLine(arm: Arm): string {
	const { noAx, noVision, axdomOff, backend } = arm.dispatch;
	// Refused by the explore CLI (a window title and nothing else), but rendered honestly if a
	// future arm ever declares it — a label that quietly cannot happen teaches nothing.
	if (noAx && noVision) return "nothing";
	if (noAx) return "Vision only";
	const els = backend === "cdp" ? "DOM" : axdomOff ? "AX (no DOM attrs)" : "AX + DOM attrs";

	return noVision ? els : `${els} + Vision`;
}

/**
 * A plain-English name for an arm — the KIND and the grounding tier, nothing else.
 *
 * Deliberately short and deliberately silent about perception, because every surface that
 * shows this also shows perceptionLine in its own column; saying "Vision only" twice in
 * one row is noise. Together they read: "Grounded task | Vision only".
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
	if (d.useProcedures) parts.push("USE_PROCEDURES=1");
	if (d.procedureLineage === "ungrounded") parts.push("PROCEDURE_LINEAGE=ungrounded");
	if (d.noRescue) parts.push("--no-rescue");
	for (const [k, v] of Object.entries(arm.env ?? {})) parts.push(`${k}=${v}`);

	return parts.join(" ") || "(defaults)";
}
