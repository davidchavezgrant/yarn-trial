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
 * (backend, appmap tier, procedure), never in the task text.
 */

export type BenchBackend = "ax" | "cdp";
export type ArmKind = "task" | "explore" | "replay" | "compile";
import { appmapSlug } from "../core/target.js";

/**
 * Stages, not phases (2026-08-03). Eight phases collapse to five ordered stages plus one that
 * sits off the ladder.
 *
 * The old numbering accreted because a bare integer was carrying three jobs at once —
 * dependency order, the axis a phase varied, and what KIND of thing it was — so every new
 * question took the next free number and the orchestrator learned about it through hand-edited
 * checks: five copies of `[1..8]` and seven behaviours keyed on specific values. Phase 8 was
 * claimed by two sessions inside one hour because the next number was the only slot on offer.
 *
 * `9` is deliberately non-adjacent. Diagnostics is not the sixth step; it measures the
 * INSTRUMENT rather than the agent, needs nothing, and blocks nothing.
 */
export type Phase = 1 | 2 | 3 | 4 | 5 | 9;

export type StageKind = "artifact" | "measurement" | "deliverable" | "diagnostic";

export interface StageDef {
	n: Phase;
	id: string;
	title: string;
	kind: StageKind;
	/** Topological order. Replaces autopilot's "ascending, except 5 (filmed) always runs last". */
	needs: Phase[];
	/** Workflow steps inserted before this stage. Replaces "judge→harvest→promote before phase 6". */
	before?: Array<"judge" | "harvest" | "promote">;
	/** In the default hands-off pass. Replaces `DEFAULT_PHASES = [1, 2, 3, 6]`. */
	inCorePass?: boolean;
	note?: string;
}

/**
 * The one source of truth for what stages exist and how they order. Adding a stage is adding an
 * object here; nothing in orchestrate.ts or autopilot.ts changes.
 *
 * What lives HERE is genuinely stage-level: order, kind, the prep a stage needs, whether the
 * core pass includes it. What does NOT live here is anything the stage's ARMS determine —
 * compiles, map-gating, recipe-gating are derived below. Declaring those was the same
 * mistake in miniature as keying on a phase number: an attribute attached to the wrong noun
 * goes stale the moment an arm moves, and the audit caught exactly that.
 */
export const STAGES: readonly StageDef[] = [
	{
		n: 1, id: "discovery", title: "Discovery", kind: "artifact", needs: [], inCorePass: true,
		note: "what a pass can find, per perception condition, per app — produces every grounding artifact downstream reads",
	},
	{
		n: 2, id: "configuration", title: "Configuration", kind: "measurement", needs: [1], inCorePass: true,
		note: "which backend / perception / grounding tier wins, holding task and model fixed",
	},
	{
		n: 3, id: "reuse", title: "Reuse", kind: "measurement", needs: [2], before: ["judge", "harvest", "promote"], inCorePass: true,
		note: "does a frozen artifact beat live grounding — compiled procedures and harvested recipes, together so the report can finally compare them",
	},
	{
		n: 4, id: "generalization", title: "Generalization", kind: "measurement", needs: [2, 3],
		note: "does stage 2 hold off this task, this model, this app",
	},
	{
		n: 5, id: "deliverables", title: "Deliverables", kind: "deliverable", needs: [2, 4],
		note: "footage of the configs that won; --record changes the action space, so these were never comparable to stage 2",
	},
	{
		n: 9, id: "diagnostics", title: "Diagnostics", kind: "diagnostic", needs: [],
		note: "is the instrument sound — measures the harness, not the agent; runs whenever the fleet is free",
	},
] as const;

export const PHASES: Phase[] = STAGES.map((s) => s.n);

export const stageOf = (phase: Phase): StageDef | undefined => STAGES.find((s) => s.n === phase);

export const isPhase = (n: number): n is Phase => PHASES.includes(n as Phase);

/**
 * Stages in execution order: topological over `needs`, ties broken by number.
 *
 * This is what replaces "ascending, except 5 always runs last". Deliverables runs last because
 * it DECLARES `needs: [2, 4]`, not because a sort function remembers a special case.
 */
export function orderStages(phases: Phase[]): Phase[] {
	const want = [...new Set(phases)].filter(isPhase);
	const out: Phase[] = [];
	const rest = new Set(want);
	while (rest.size) {
		// Ready = every dependency either satisfied or not requested in this run at all.
		// Ties break by number, EXCEPT that an off-ladder stage yields to the measurement work.
		// Diagnostics needs nothing, so a naive numeric tie-break scheduled it second — ahead of
		// Configuration — and put four harness runs in front of the pass the operator asked for.
		// It blocks nothing, so it should also wait for nothing.
		const rank = (p: Phase): number => (stageOf(p)?.kind === "diagnostic" ? 1 : 0);
		const ready = [...rest]
			.filter((p) => (stageOf(p)?.needs ?? []).every((d) => !rest.has(d)))
			.sort((a, b) => rank(a) - rank(b) || a - b);
		if (!ready.length) {
			// Cycle: emit the remainder in numeric order rather than hanging. The test below
			// makes this unreachable; the fallback exists so a bad edit degrades loudly-but-safely.
			out.push(...[...rest].sort((a, b) => a - b));
			break;
		}
		// ONE per round, not the whole ready set: Diagnostics needs nothing, so it is ready in
		// round one and a batch emit put it second — four harness runs ahead of Configuration.
		// Re-ranking each round lets the measurement chain unblock itself first.
		out.push(ready[0]);
		rest.delete(ready[0]);
	}

	return out;
}

/**
 * The dispatch knobs an arm turns, in `DispatchOptions`' exact spellings.
 *
 * Every knob declared here exists on that type — `backend`, `noVision`, `noAx`, `axdomOff`,
 * `noGrounding`, `useCurated`, `useRecipes`, `recipeLineage`, `noRescue`, `record`, `url`,
 * `snapPx`, `steps`, `stallSteps`, `model` — and `JobKind` carries "replay". This used to
 * describe a contract being built concurrently, with orchestrate.ts casting at the dispatch()
 * call site until it merged; it merged, the cast is gone, and the compiler now checks that an
 * arm can only name a knob the wire actually has.
 *
 * TWO knobs the wire has that an ARM does not, and the asymmetry is deliberate: `procedure` (the
 * compiled file a replay consumes) is threaded per dispatch by `dispatchOptionsFor(arm, procedure,
 * model)` because it is resolved at submit time from the source arm's compile, not declared; and
 * the appmap variant travels in `Arm.env` as `APPMAP_VARIANT` rather than as a dispatch field,
 * because the runner must set it as pre-run ENV for the child to read. An earlier version of this
 * comment listed both as ArmDispatch fields. They never were.
 */
export interface ArmDispatch {
	backend?: BenchBackend;
	noVision?: boolean;
	noAx?: boolean;
	axdomOff?: boolean;
	noGrounding?: boolean;
	useCurated?: boolean;
	/** `USE_RECIPES=1`: ground on a recipe harvested from a judged-PASS run of THIS task. */
	useRecipes?: boolean;
	/** Which recipe lineage to load: one distilled from a grounded run, or from an ungrounded one. */
	recipeLineage?: "grounded" | "ungrounded";
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
	 * SNAP_PX for this arm: treat a coordinate action as a hypothesis and act on the interactive
	 * control within this many pixels of it, if any. 0/absent leaves the raw coordinate alone.
	 */
	snapPx?: number;
	/**
	 * Step budget for this arm. ALMOST ALWAYS WRONG TO SET — see below.
	 *
	 * The default is no longer a budget at all: `AGENT_STEPS` is a runaway backstop of 100, and the
	 * condition that actually ends a working run is the stall detector (`stallSteps`). A run must
	 * never fail because it ran out of steps, which makes an arm-level ceiling a way to reintroduce
	 * exactly the bug the backstop was raised to kill.
	 *
	 * This codebase has now made that mistake three times, each one layer further out, and the
	 * history is the reason this comment is long. First the default was 15: the settings tasks
	 * finish in 5-13 so nobody questioned it, then every creation arm stopped at exactly 15 with
	 * `gave-up` against a known-good route of 19 — a ceiling reported as a capability result.
	 * Second, the creation arms were pinned to 30, and three of them hit 30 with verified steps
	 * inside their last eight; that pin is now deleted (see creationArms). Third, the Notion arms
	 * were pinned to 30 and 60 while the default was already 100, and the comment justifying the 60
	 * admitted it had "no known-good run at all" to measure against — a guess acting as a verdict.
	 * Those are deleted too.
	 *
	 * A test asserts no arm pins a budget below the backstop. If you are reaching for this field,
	 * you almost certainly want `stallSteps` instead: widen how long a run may go unverified, not
	 * how many steps it is allowed to take.
	 */
	steps?: number;
	/**
	 * How many consecutive steps this arm may verify NOTHING before the harness ends the run.
	 *
	 * `AGENT_STALL_STEPS`, default 8. This is the real stopping condition, so it is the number an
	 * arm should tune when its TASK legitimately produces long unverifiable stretches — the stall
	 * counter resets only on a verified step, and a task that navigates for ten steps without
	 * putting checkable text on screen is indistinguishable, to the detector, from a dead window.
	 *
	 * Raising it is not free: it is the only thing standing between a genuinely stuck run and the
	 * 100-step backstop, so every step of extra window is a step of a stuck run nobody stops.
	 * Prefer it over `steps` anyway — a stall window that is too small ends working runs, where a
	 * budget that is too small ends them AND reports the ending as the agent's verdict.
	 */
	stallSteps?: number;
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
	/**
	 * Stable slug naming the CELL, e.g. "ax-grounded" — not the stage it sits in. Manifest
	 * entries key on it, so an id that encoded its position (the old `p2-`, `p7-` prefixes)
	 * meant re-homing an arm silently orphaned its history. Re-homing is now free.
	 */
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
	 * replay arms: the compile arm whose procedure they replay.
	 */
	sourceArm?: string;
	/**
	 * WHY this arm actuates over `ax` when the default is `cdp`.
	 *
	 * Every ax arm must be JUSTIFIED, and a test enforces that — but not necessarily in writing
	 * here. The test accepts three justifications: this field, or a cdp twin of the same shape
	 * (the pair IS the comparison, so the reason is structural), or `axdomOff` (an arm about the
	 * DOM-attribute sidecar can only exist on ax). 39 of the 58 ax arms carry no `axRationale` and
	 * the suite is green, which is correct — an earlier version of this comment claimed the field
	 * was required on every ax arm, and that was never what the test checked.
	 *
	 * CDP is the production actuator — it backgrounds, it never steals the operator's pointer, and
	 * it has none of cua's liabilities (no 300s session lifetime, no shared daemon, no consent
	 * gate). AX is the FALLBACK: the actuator of last resort when there is no reachable DOM.
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
 * NOTION CALENDAR is gone; NOTION WEB came back (David, 2026-08-01, reversed 2026-08-03).
 *
 * Two different cuts happened on 2026-08-01 and only one of them stuck. `NC_APP`/`NC_TASK` — the
 * Notion Calendar generalization slice — is gone for good: the app is installed on none of the
 * three colo Macs, so those arms were guaranteed refusals. That half is still true.
 *
 * The other half was reversed. app.notion.com went the same day for logistical reasons (the
 * grounding pass was the longest in the matrix at 1h14m and the frontier fixes forced a re-run of
 * everything), and it is back as the benchmark's SECOND APP because the reason it went was cost,
 * never design — see SECOND_APP_URL below. The matrix now measures cross-APP transfer, not only
 * cross-task: stage 4 varies task, model AND app.
 *
 * What cannot be mirrored, and it is half the matrix: every `ax` arm and every `axdom` arm. A web
 * target on the ax backend is a hard refusal in three places (`agent/run.ts`, `explore.ts`,
 * `backends/ax.ts`), and the axdom sidecar reads a native window's pid, which a CDP page has no
 * equivalent of. So Notion mirrors the ELEVEN cdp cells and nothing else; the ax/cdp comparison,
 * the native-equivalent tier and the min-context floor are Yarn-only by construction. Notion still
 * out-runs Yarn's cdp-only half, because it crosses two tasks where the config sweep crosses one.
 *
 * docs/appmaps/notion-calendar.* and docs/curated/notion-calendar.md stay on disk as the only
 * record of the Calendar passes, and no arm reads them.
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
 * Every finding through stage 3 is scoped to flipping a dropdown. That is a fair test of
 * navigation and verification and a poor proxy for what Yarn sells, which is making a video.
 * Phrased GOAL-ONLY: the one previous run of this flow dictated its route ("then open the
 * Script tab…") and passed the hint gate, which is the hole NAV_HINT/SEQUENCE_HINT now close.
 */
export const CREATION_TASK =
	"Make a two-scene video script for a coffee ordering app called Brew, narrated by Cassidy. Do not publish, export, or share it.";

/**
 * The second APP — the axis 207 runs never varied, and the one the brief actually promises:
 * "This should theoretically work on arbitrary apps, although we'd budget some setup time."
 *
 * Every finding so far is indistinguishable from a fact about Yarn's DOM. Notion web is the
 * brief's own example, needs no install (the cdp backend drives its own persistent Chrome), and
 * already has a stamped explore map from 2026-07-31.
 *
 * The FULL URL, not a host: `appmapSlug` recognises a target by being a URL and slugs it to
 * `web-app.notion.com`, which is what the committed map is called. A bare host would slug to
 * `app.notion.com` and silently miss it — the arm would load nothing and run ungrounded under a
 * grounded label, which is this repo's most-repeated failure and the one `groundingChecked`
 * caught six times in the last pass.
 */
export const SECOND_APP_URL = "https://app.notion.com";

/**
 * TWO tasks, spanning difficulty on purpose (David, 2026-08-03).
 *
 * A settings toggle was the obvious choice and would have been the wrong one: Yarn's settings
 * task finished this pass at ceiling in eleven of twelve arms, so a third one buys nothing. The
 * pass's most useful finding was that grounding's value tracks the TASK — cdp needs none on a
 * dropdown (3/3 either way) and 0/3 without it on the product flow. A simple and a complex task
 * on a second app tests whether that PATTERN transfers, which is a sharper question than whether
 * one more toggle works.
 *
 * Both are goal-only: they name an outcome and never a route. Both mutate, which is safe here —
 * the workspace is a throwaway account — but see the reset note on the arms below, because
 * teardown restores what the mutation journal recorded and page creation is not that.
 *
 * NOT known to be dual-scope, either of them. `findScopeAmbiguities()` over the committed Notion
 * map returns 11 collisions and most are false positives — generic verbs (sort, filter, group)
 * the explore model gave one `settingKey` across unrelated database surfaces. The real
 * account-vs-workspace splits are missing from it, so the detector has both error kinds here.
 * Consequence, to be stated wherever these arms are reported: the actions/tokens half of the
 * comparison stands, the wrong-scope half does not until someone hand-validates a pair. That
 * degradation is itself a finding — the scope mechanism is grounding's strongest measured win on
 * Yarn and it does not survive contact with a database-shaped app.
 */
export const SECOND_APP_SIMPLE_TASK = "Create a table with five rows and populate every row.";

/**
 * The complex half: multi-surface, deeply nested, and still checkable at the end.
 *
 * Chosen against the Notion map's own shape — its dismissal log is dominated by view-settings,
 * filter, sort, group and property panels, which is where the app's real depth lives and where
 * nothing in this matrix has ever driven an agent. It needs a schema change, five records with
 * varied values, a second view, a grouping and a filter: six distinct surfaces against the
 * simple task's one, and no single control completes it.
 *
 * Deliberately free of externality verbs — nothing here shares, publishes, invites or deletes.
 */
export const SECOND_APP_COMPLEX_TASK =
	"Make a task database with a status property, add five tasks across different statuses, then give it a board view grouped by status that shows only the unfinished ones.";
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

/**
 * THE SAMPLING POLICY — one number per family, applied without exception (David, 2026-08-03,
 * prepping a clean run: "let's make the N numbers consistent across runs and explore phases").
 *
 * It used to be per-arm, and the drift was not random: the arms that got repeats were the ones
 * someone was actively arguing about. That produced a hole worth remembering. The comment
 * justifying explore repeats cited the vision pass's spread — 9 surfaces on one attempt, 21 on
 * the next under identical code — while `explore-vision`, the arm that spread belongs to, ran at
 * n=1. The stated rule was that reference arms repeat and single-channel arms are "read relative
 * to them", but a variant read against a reference still has no error bar of its own: comparing a
 * distribution to a single draw tells you the reference is trustworthy, not what the variant does.
 *
 * Two numbers, because the two families fail differently:
 *
 *  - MEASUREMENT runs report a SUCCESS RATE, and per-run success is binary. At n=1 an arm can only
 *    say 0% or 100%, so one flake flips the verdict; n=2 gives 0/50/100, which still cannot
 *    separate "usually works" from "works half the time". Three is the first count that resolves
 *    a single flake as 67% instead of a reversal.
 *  - EXPLORE passes report CONTINUOUS quantities (surfaces, nodes, controls actuated), where two
 *    draws already bound a spread. Two is enough, and explores cost 20-50x a task run.
 *
 * Deliberate exceptions, each because the arm is not sampling a distribution at all:
 *  - `filmed` arms take ONE take per variant (TAKE_RUNS). A take is a deliverable, not a
 *    measurement, and `--record` changes the action space, so a second one buys footage of the
 *    same config and ~200 MB of frames.
 *  - compiles run ONCE (COMPILE_RUNS). A compile is a deterministic local file transform; running
 *    it twice produces the same bytes.
 *  - the diagnostics pair keeps its own count (DIAGNOSTIC_SAMPLES) — see DIAGNOSTICS.
 */
export const TASK_SAMPLES = 3;
export const EXPLORE_SAMPLES = 2;
export const TAKE_RUNS = 1;
export const COMPILE_RUNS = 1;
/**
 * The diagnostics pair, kept at 2 rather than raised to TASK_SAMPLES — the one count that is NOT
 * about resolving a rate. It hunts an intermittent fault (an intermittent fault seen once is a
 * rumour), and its artifact is `geometryBasis` and the step rects, not whether the task passed.
 * Both halves share it so the filmed/unfilmed comparison stays like-for-like; raising one alone
 * would be the bug the pair exists to catch.
 */
export const DIAGNOSTIC_SAMPLES = 2;

const task = (id: string, dispatch: ArmDispatch, informs: string, over: Partial<Arm> = {}): Arm => ({
	id,
	phase: 2,
	kind: "task",
	app: BENCH_APP,
	task: CANONICAL_TASK,
	n: TASK_SAMPLES,
	dispatch,
	informs,
	...over,
});

/**
 * Phase 1 — node discovery per backend (grounded arms use their own backend's map), plus
 * the one web-explore run that verifies cdp covers the web path dom used to own.
 */
const DISCOVERY: Arm[] = [
	...BACKENDS.map((backend): Arm => ({
		id: `explore-${backend}`,
		phase: 1,
		kind: "explore",
		app: BENCH_APP,
		/**
		 * EXPLORE_SAMPLES, like every other explore arm now. The original reason still holds —
		 * a phase-1 number is a point estimate with no error bar, and the spread can be brutal:
		 * the vision arm gave 8 surfaces on one run and 3 on the next under identical code, so
		 * "cdp found 63 surfaces and ax found 31" could not be told from two draws of one
		 * distribution.
		 *
		 * What changed is the SCOPE. This used to read "only these two repeat; the
		 * single-channel arms are read relative to them" — and that does not survive contact
		 * with the arithmetic. A variant compared against a repeated reference still has no
		 * spread of its own, and the arm the evidence above is ABOUT ran at n=1. See the
		 * sampling policy.
		 */
		n: EXPLORE_SAMPLES,
		dispatch: { backend },
		informs: "controls seen/actuated/dismissed, obs latency, pass duration, map size, scope ambiguities",
	})),
	/**
	 * ~~explore-web-cdp (Notion)~~ — DROPPED 2026-08-01 (David's call, on time).
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
	 * per-app budget Jasper described. Read `nodes` and `surfaces` against explore-ax,
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
		id: "explore-vision-cdp",
		phase: 1,
		kind: "explore",
		app: BENCH_APP,
		/**
		 * Vision-only discovery is the WIDEST-SPREAD measurement in the matrix — the ax vision
		 * pass gave 9 surfaces on one attempt and 21 on the next under identical code — and this
		 * arm is a reference for three task arms that ground on its map, so a bad draw would
		 * mis-grade everything downstream of it. It was already repeated for that reason; the
		 * policy now extends the same treatment to `explore-vision`, which is the arm those
		 * 9-vs-21 numbers actually came from and which ran at n=1 until 2026-08-03.
		 */
		n: EXPLORE_SAMPLES,
		dispatch: { backend: "cdp", noAx: true },
		informs: "does vision-only discovery improve when its clicks land — surfaces/nodes against explore-vision on ax",
	},
	{
		id: "explore-no-vision",
		phase: 1,
		kind: "explore",
		app: BENCH_APP,
		n: EXPLORE_SAMPLES,
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
	 * ax-grounded-axdom-off arm tests it at RUN time, against a map that had it.
	 *
	 * Adding one costs the same as adding three: six runs is two waves across three Macs and
	 * nine is three, so the marginal cost of the last two is tokens, not time.
	 */
	{
		id: "explore-ax-noaxdom",
		phase: 1,
		kind: "explore",
		app: BENCH_APP,
		n: EXPLORE_SAMPLES,
		dispatch: { backend: "ax", axdomOff: true },
		informs: "does the axdom sidecar earn its keep at GROUNDING time — map size and named-control count vs explore-ax",
	},
	{
		id: "explore-ax-noaxdom-no-vision",
		phase: 1,
		kind: "explore",
		app: BENCH_APP,
		n: EXPLORE_SAMPLES,
		dispatch: { backend: "ax", axdomOff: true, noVision: true },
		// Consumed by min-context-grounded since 2026-08-01 — it was comparison-only until
		// David pointed out that the least-context condition is exactly the one worth running
		// a task in: it measures how much the agent can work out on the fly.
		informs: "the bare AX alone: the floor of the element channel, with neither DOM attrs nor Vision",
	},
	{
		id: "explore-cdp-no-vision",
		phase: 1,
		kind: "explore",
		app: BENCH_APP,
		n: EXPLORE_SAMPLES,
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
		id: "explore-vision",
		phase: 1,
		kind: "explore",
		app: BENCH_APP,
		n: EXPLORE_SAMPLES,
		dispatch: { backend: "ax", noAx: true },
		axRationale: "Vision-only is ax-only by construction — a cdp observation IS a ref list, so 'Vision only' cannot be expressed on that backend",
		informs: "can grounding itself be done from Vision — declared coverage, pass duration, map size vs the ax pass",
	},
];

/** Phase 2 core — backend × grounding, n=3 per cell. */
const CONFIG_CORE: Arm[] = BACKENDS.flatMap((backend) => [
	task(`${backend}-ungrounded`, { backend, noGrounding: true }, "ad-hoc discovery floor on this backend"),
	task(`${backend}-grounded`, { backend }, "what a grounding pass buys on this backend"),
]);

/**
 * The cdp half of the perception grid, declared here rather than where it happened to be typed.
 *
 * These five cells lived in phase 7 until the stage reorganisation (2026-08-03) — not because
 * they asked a phase-7 question (they hold the task and the model fixed and vary only what the
 * agent perceives and what it grounds on, which IS this stage's definition) but because that was
 * the next number free on the day they were written. `vision-only-cdp-curated` says so in its own
 * `informs`: "completes the grid ax already has".
 *
 * Declared as their own const, and spread into CONFIG_SLICES below, so the ARRAY grouping and the
 * STAGE agree. While they sat in the phase-7 array carrying `phase: 2`, every derivation that
 * read the arrays disagreed with every gate that read the stage.
 */
const CONFIG_CDP_PERCEPTION: Arm[] = [
	// Same three cells as Sol ran, one variable changed. Canonical task on purpose: it is the
	// only task with 45 runs of Sol baseline behind it.
	task("vision-only-cdp-curated", { backend: "cdp", noAx: true, useCurated: true }, "vision-only against the human-written tier — completes the grid ax already has", { phase: 2 }),
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
	task("cdp-grounded-visionmap", { backend: "cdp" }, "is a map written from pixels any good to an agent that can see elements", {
		phase: 2,
		env: { APPMAP_VARIANT: "vision" },
	}),
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
	task("vision-only-cdp-ungrounded", { backend: "cdp", noAx: true, noGrounding: true }, "vision-only floor on an actuator that can aim", { phase: 2 }),
	task("vision-only-cdp-grounded", { backend: "cdp", noAx: true }, "does a map lift vision-only once its clicks land (map from an element-perceiving pass)", { phase: 2 }),
	/**
	 * The SNAP arms: vision-only reasoning, element-precise actuation.
	 *
	 * Vision-only misses its target 75% of the time against 11% for element addressing, on a
	 * backend whose coordinate space is provably exact — so the model localises poorly from
	 * pixels, and the harness is not at fault. The redaction pipeline in ../yarn solved the same
	 * class by treating the vision model's box as a HYPOTHESIS and refining it
	 * (`detect -> track -> snap·prune·size -> render`, then a few pixels of padding because
	 * over-covering is free). UI driving had no refinement stage at all: the model's pixel went
	 * straight to a click, where a 40px error is not "slightly worse" but a no-op on a different
	 * control, and the error compounds because every later step reasons about a state that never
	 * happened.
	 *
	 * These add the middle. The model still sees ONLY pixels and still names its own target; the
	 * harness rewrites the coordinate to the control it landed on, within a tolerance. Two
	 * tolerances because the right radius is unknown and cheap to measure: 24px is about a small
	 * control's half-height, 48px is forgiving enough to cross a label into its widget.
	 *
	 * NOT a solution for an app with no element channel — snapping to elements presupposes
	 * elements, and vision-only exists to ask what happens without them. The genuine analogue
	 * there snaps to IMAGE structure and is a much larger build. This is the tractable half, and
	 * the half that matches a target with a DOM.
	 */
	task("vision-only-cdp-snap24", { backend: "cdp", noAx: true, snapPx: 24 }, "does refining the pixel to the nearest control rescue vision-only", { phase: 2 }),
	task("vision-only-cdp-snap48", { backend: "cdp", noAx: true, snapPx: 48 }, "same, at a tolerance that can cross a label into its widget", { phase: 2 }),
	/**
	 * Vision-only at BOTH stages on cdp — the ax pair's `-visionmap` arm, on an actuator whose
	 * screenshot pixels and click coordinates are the same space. This is the honest version of
	 * the app-with-no-usable-AX deploy story: the ax pair could only ever answer it through a
	 * click path that misses by ~40px on this app.
	 */
	task("vision-only-cdp-visionmap", { backend: "cdp", noAx: true }, "grounding AND actuation vision-only, on the backend that can aim", {
		phase: 2,
		env: { APPMAP_VARIANT: "vision" },
	}),
];

/** Phase 2 permutation slices — each maps to a fork in the implementation Aman inherits. */
const CONFIG_SLICES: Arm[] = [
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
	 * grounding matches, too — `explore-ax-noaxdom` writes the map these read, so the
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
		"ax-grounded-axdom-off",
		{ backend: "ax", axdomOff: true },
		"NATIVE-EQUIVALENT, grounded: AX with no DOM behind it, mapped and run under the same limit. Also answers whether the Swift sidecar earns its keep end to end.",
	),
	/**
	 * The cell the native tier was missing: cold AND native-equivalent, screenshots available.
	 * Its counterpart `ax-ungrounded` has the sidecar, and `min-context-ungrounded` also
	 * drops vision — so without this there was no way to say "no DOM, no map, but it can see",
	 * which is the honest starting position for an app nobody has onboarded yet.
	 */
	task(
		"ax-noaxdom-ungrounded",
		{ backend: "ax", axdomOff: true, noGrounding: true },
		"NATIVE-EQUIVALENT, cold: no DOM attributes, no map, Vision on — the un-onboarded native app",
	),
	// Grounds on the map an element-only pass wrote, so the map's vocabulary matches what this
	// run can perceive — the same reason the vision arm reads the vision map. Also the only
	// thing that consumes explore-no-vision's output; without it that pass writes an
	// artifact nobody reads.
	task("ax-grounded-no-vision", { backend: "ax", noVision: true }, "what the Vision channel buys on ax", { env: { APPMAP_VARIANT: "novision" } }),
	task("cdp-grounded-no-vision", { backend: "cdp", noVision: true }, "same on cdp — DOM snapshot is text-rich; fleet-scale cost", { env: { APPMAP_VARIANT: "novision" } }),
	/**
	 * MINIMUM CONTEXT, both tiers (David, 2026-08-01). Bare AX: no DOM attributes from
	 * the sidecar, no screenshots. It is the most impoverished condition an agent can be asked
	 * to work in and still be addressing real controls.
	 *
	 * Two reasons this pair earns six runs. It is the only test of how well the agent figures
	 * things out ON THE FLY when almost nothing is handed to it — the deployment case where
	 * the sidecar is unavailable and screenshots are too expensive at fleet scale. And the
	 * grounded half is the only consumer of explore-ax-noaxdom-no-vision's map, which was
	 * otherwise a 30-minute pass written for a comparison alone.
	 *
	 * The ungrounded half is the floor of the entire matrix: least perception AND no map. Every
	 * other arm should beat it, and an arm that does not is telling you its condition adds
	 * nothing.
	 */
	task("min-context-grounded", { backend: "ax", axdomOff: true, noVision: true }, "NATIVE-EQUIVALENT, harshest grounded: bare AX, no Vision, mapped under the same limit", {
		env: { APPMAP_VARIANT: "novision" },
	}),
	task("min-context-ungrounded", { backend: "ax", axdomOff: true, noVision: true, noGrounding: true }, "NATIVE-EQUIVALENT floor: bare AX, no Vision, no map — can it work it out on the fly"),
		task(
		"curated",
		{ backend: "cdp", useCurated: true },
		// TASK-CONTAMINATED, and the numbers must be reported as such. docs/curated/yarn.md names
		// the canonical task's control, its surface, its exact options AND the brand-vs-document
		// split — so this arm receives the route and the wrong-scope defence. Its own header also
		// says it was "assembled from an exploration pass on 2026-07-29", so it is not 10 minutes
		// of human notes either. auditTaskPrompt gates the TASK string; nothing gates grounding text.
		"explore pass vs a curated tier that CONTAINS THIS TASK'S ANSWER — an upper bound on grounding, not a human-notes comparison",
	),
	// Vision-only is ax-backend-only by construction: cdp observations ARE ref lists.
	task("vision-only-ungrounded", { backend: "ax", noAx: true, noGrounding: true }, "the floor: Vision alone, cold", { axRationale: "Vision-only is ax-only by construction — a cdp observation IS a ref list, so 'Vision only' cannot be expressed on that backend" }),
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
	task("vision-only-grounded-axmap", { backend: "ax", noAx: true }, "does explore-written prose lift a Vision-only agent (map from an element-perceiving pass)", { axRationale: "Vision-only is ax-only by construction — a cdp observation IS a ref list, so 'Vision only' cannot be expressed on that backend" }),
	/**
	 * The AX-hostile-app story, measured properly: grounding AND actuation both from
	 * screenshots only. Consumes the `.vision` map that explore-vision writes, so it is
	 * gated on phase 1 having run — with no map, loadGrounding degrades to provenance "none"
	 * and this silently becomes a duplicate of the ungrounded arm. `bench collect` records
	 * provenance per run, so check it reads `explore-vision` before believing this row.
	 *
	 * Paired with -axmap above, the two separate a question that was previously conflated:
	 * -axmap asks whether the AX path can be dropped at RUN time (ground once where AX works),
	 * this asks whether it can be dropped ENTIRELY.
	 */
	task(
		"vision-only-grounded-visionmap",
		{ backend: "ax", noAx: true },
		"grounding and actuation both Vision-only — the app-with-no-usable-AX deploy story",
		{ env: { APPMAP_VARIANT: "vision" }, axRationale: "Vision-only is ax-only by construction — a cdp observation IS a ref list, so 'Vision only' cannot be expressed on that backend" },
	),
	task("vision-only-curated", { backend: "ax", noAx: true, useCurated: true }, "same against the human-written tier", { axRationale: "Vision-only is ax-only by construction — a cdp observation IS a ref list, so 'Vision only' cannot be expressed on that backend" }),
	...CONFIG_CDP_PERCEPTION,
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
 * Phase 3 — procedures. Compiles are LOCAL (a pure file transform on a pulled run log through
 * procedure-cli's compileFromStamp, which keeps its refusal gates); replays dispatch to the
 * fleet. The compile source — one clean grounded run per backend — is resolved at phase
 * time from the collected manifest, never named here.
 */
const REUSE_PROCEDURES: Arm[] = [
	...BACKENDS.map((backend): Arm => ({
		id: `compile-${backend}`,
		phase: 3,
		kind: "compile",
		app: BENCH_APP,
		n: COMPILE_RUNS,
		dispatch: { backend },
		sourceArm: `${backend}-grounded`,
		informs: "compile success; what the gate refuses",
	})),
	...BACKENDS.map((backend): Arm => ({
		id: `replay-${backend}`,
		phase: 3,
		kind: "replay",
		app: BENCH_APP,
		n: TASK_SAMPLES,
		dispatch: { backend },
		sourceArm: `compile-${backend}`,
		informs: "steps re-resolved vs rescued, model calls (target 0), wall-clock + tokens vs live grounded",
	})),
	{
		id: "replay-norescue",
		phase: 3,
		kind: "replay",
		app: BENCH_APP,
		n: TASK_SAMPLES,
		// cdp, not ax: this measures the UNATTENDED FLEET POSTURE, which is a question about
		// how the shipping configuration behaves with no operator, not about the fallback.
		dispatch: { backend: "cdp", noRescue: true },
		sourceArm: "compile-cdp",
		informs: "unattended-fleet posture: does the happy path hold with ZERO model calls",
	},
];

/**
 * Phase 4 (optional) — second-task spot check, ax only. The cells used to run n=2 to keep the
 * phase inside the plan's ~5–8 run budget; they now take TASK_SAMPLES like every other measured
 * cell (David, 2026-08-03). Three runs is the cost of the phase reporting a rate at all: at n=2 a
 * cell can only say 0/50/100%, which is the resolution problem the task default exists to avoid,
 * and the phase is worth 3 runs or it is not worth running. The replay arm needs a procedure compiled from a
 * clean phase-4 grounded run, so it is dispatched in a second wave: run `bench collect`
 * after the grounded runs land, then `bench phase 4 --go` again — already-submitted samples
 * are skipped, the compile runs, and the replays go out.
 */
const GEN_SECOND_TASK: Arm[] = [
	task("blur-ungrounded", { backend: "cdp", noGrounding: true }, "is everything above cursor-task-specific", { phase: 4, task: PHASE4_TASK }),
	task("blur-grounded", { backend: "cdp" }, "is everything above cursor-task-specific", { phase: 4, task: PHASE4_TASK }),
	{
		id: "blur-compile",
		phase: 4,
		kind: "compile",
		app: BENCH_APP,
		n: COMPILE_RUNS,
		// Follows blur-grounded: a procedure compiled from a cdp run resolves cdp's control names.
		dispatch: { backend: "cdp" },
		sourceArm: "blur-grounded",
		informs: "does compile generalize past the canonical task",
	},
	{
		id: "blur-replay",
		phase: 4,
		kind: "replay",
		app: BENCH_APP,
		n: TASK_SAMPLES,
		dispatch: { backend: "cdp" },
		sourceArm: "blur-compile",
		informs: "does replay generalize past the canonical task",
	},
];

/**
 * Stage 3 (reuse), the recipe half — can an agent's own written-up success replace the exploration pass?
 *
 * The question Yarn actually has to answer to ship this. Jasper's budget is ~24h to onboard a
 * new app, and the current answer to "how" is a 40-minute frontier sweep producing a topological
 * map. A recipe is the other possibility: run the task once however you can, have the agent
 * write down the route that worked, and ground every later run on that. If it holds, onboarding
 * cost collapses from a sweep to a handful of successful runs.
 *
 * PREREQUISITE, and it is not optional: recipes are harvested from judged-PASS phase-2 runs
 * by `./run bench harvest`, which needs `bench judge` to have run first. There is no arm here
 * that produces them — harvesting is an operator step, deliberately, because promoting a
 * recipe makes it an INPUT to future runs and that should never happen as a side effect of
 * dispatching a phase.
 *
 * The comparison is three-way against arms that already exist at n=3 on the same task and
 * backend: <backend>-ungrounded (nothing), <backend>-grounded (the appmap), and these
 * (a previous run's write-up). USE_RECIPES REPLACES the appmap rather than adding to it —
 * stacking them would measure neither.
 */
const REUSE_RECIPES: Arm[] = [
	/**
	 * The honest replacement claim (added by David, 2026-08-01). Its recipe is harvested from
	 * an UNGROUNDED run — an agent that worked the app out from nothing, succeeded, was judged
	 * correct, and wrote down what worked. Every later run reads that instead of a map.
	 *
	 * This is the only arm in the matrix that can speak to "does the 40-minute exploration pass
	 * need to exist", because it is the only recipe that does not presuppose one. If it holds,
	 * per-app onboarding collapses from a sweep to a handful of successful runs, which is the
	 * question Yarn's ~24h budget actually turns on.
	 *
	 * It may not be runnable: the wrong-scope class makes a judged-PASS ungrounded run rare, and
	 * `harvestRefusal` will decline every one that failed. That refusal IS a finding — "an agent
	 * with no map could not produce trustworthy knowledge" answers the question too — and the
	 * recipe gate refuses dispatch rather than silently running it as an appmap arm.
	 */
	...BACKENDS.map((backend): Arm => ({
		id: `${backend}-recipe-from-ungrounded`,
		phase: 3,
		kind: "task",
		app: BENCH_APP,
		task: CANONICAL_TASK,
		n: TASK_SAMPLES,
		dispatch: { backend, useRecipes: true, recipeLineage: "ungrounded" as const },
		sourceArm: `${backend}-ungrounded`,
		informs:
			"THE replacement question: can a write-up by an agent that had no map stand in for the exploration pass? " +
			"vs <backend>-ungrounded (what its author knew) and <backend>-grounded (the sweep it would replace).",
	})),
	...BACKENDS.map((backend): Arm => ({
	id: `${backend}-recipe`,
	phase: 3,
	kind: "task",
	app: BENCH_APP,
	task: CANONICAL_TASK,
	n: TASK_SAMPLES,
	dispatch: { backend, useRecipes: true },
	sourceArm: `${backend}-grounded`,
	informs:
		"does a frozen, judge-passed route beat live appmap grounding ON THE TASK IT WAS HARVESTED FROM? " +
		"NOT a replacement claim — its recipe presupposes the sweep; the -from-ungrounded arm above is that claim. " +
		"NOT a transfer claim: a recipe is per-task where a map is per-app, and no arm tests it on a second task.",
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
 * The composited cursor is no longer a manual step: `bench collect` renders it on pull
 * (collect.ts's humanizePulled — `HUMANIZE=0` opts out), reading the run's own trajectory
 * (click points, target rects, real typing timings) so it needs no extra capture. Two surfaces
 * show the result: the Electron gallery, and the benchmark board's ▶ per filmed run — which
 * also means it is the one artifact a hosted snapshot carries (bench/snapshot.ts).
 */
const filmed = (arm: Arm): Arm => ({
	...arm,
	id: `${arm.id}-filmed`,
	phase: 5,
	n: TAKE_RUNS,
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
 * Stage 4 — the axes the first 115 runs never varied: the TASK, the MODEL, and now the APP.
 *
 * Creation arms run the product flow on cdp, the actuator that works. Claude arms mirror three
 * stage-2/3 cells exactly, changing only the model, so the comparison is a difference of one
 * variable rather than two tables side by side. The second-app arms below do the same for the app.
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
/**
 * Stage-2 cells that do NOT get a creation twin, named rather than left to fall out of where a
 * declaration happened to sit.
 *
 * Moving the cdp perception cells into Configuration would silently have widened the task axis
 * from 15 twins to 20 — fifteen runs nobody asked for, arriving as a side effect of a tidy-up.
 * The exclusion is a judgement and belongs in the open: vision-only already reaches the creation
 * task through its four ax cells, so the cdp repeats would buy a fourth sample of a condition
 * already represented, on the most expensive task in the matrix.
 *
 * Delete an entry here to widen the axis deliberately. A test asserts every id still resolves,
 * so a cell renamed out from under this list fails the build instead of quietly rejoining.
 */
export const CREATION_EXCLUDED: readonly string[] = [
	"vision-only-cdp-ungrounded",
	"vision-only-cdp-grounded",
	"vision-only-cdp-visionmap",
	"vision-only-cdp-curated",
	"cdp-grounded-visionmap",
];

const creationArms = (): Arm[] =>
	[...CONFIG_CORE, ...CONFIG_SLICES]
		.filter((a) => a.kind === "task" && !CREATION_EXCLUDED.includes(a.id))
		.map((a) => ({
			...a,
			id: `create-${a.id}`,
			phase: 4 as Phase,
			task: CREATION_TASK,
			// NO arm-level budget. 30 was the right fix against a default of 15 and became the
			// wrong one the moment the default turned into a runaway backstop of 100 with a
			// stall detector as the real stopping condition: it reintroduced a ceiling acting as
			// a verdict, one layer down. Three runs hit 30 with verified steps inside their last
			// eight — still working, cut off anyway. They inherit the backstop and stop when they
			// stall, which is the whole point of having a stall detector.
			dispatch: { ...a.dispatch },
		}));

const GEN_TASK_AND_MODEL: Arm[] = [
	...creationArms(),
	task("claude-cdp-ungrounded", { backend: "cdp", noGrounding: true, model: BENCH_ALT_MODEL }, "is the ungrounded floor a model property or a general one", { phase: 4 }),
	task("claude-cdp-grounded", { backend: "cdp", model: BENCH_ALT_MODEL }, "does grounding lift Claude the way it lifts Sol", { phase: 4 }),
	task("claude-cdp-recipe-from-ungrounded", { backend: "cdp", useRecipes: true, recipeLineage: "ungrounded", model: BENCH_ALT_MODEL }, "does the replacement result survive a model change — the finding most worth a second model", { phase: 4 }),
];

// Stage 4 joins the derivation rather than being remembered — that is the whole point of the
// rule. It also means the CREATION flow gets filmed, which is the footage closest to what Yarn
// actually sells; every take before it was of a dropdown being changed.
/**
 * Stage 9 — HARNESS diagnostics. These arms measure the rig, not the agent.
 *
 * They exist because the two runs that finally explained the "~43px Library-page AX offset"
 * were dispatched by hand and left no trace in the matrix: a plain ax run and a filmed one,
 * compared on the geometryBasis their run logs now carry. That comparison is what showed the
 * transform was sound (window 1570x970, shot 1568x969, heightGap 0.24pt) and that the error
 * was a snapshot taken mid-reflow after `--record` stages the window — not a coordinate bug at
 * all, which is what everyone had assumed for three days.
 *
 * A diagnosis worth three days should not depend on someone remembering to type the command.
 * Read the PAIR, never either alone: the filmed arm is the one that stages the window, so a
 * discrepancy that appears only there is staging, and one in both is the transform.
 *
 * Their task outcome is close to irrelevant — the artifact is geometryBasis and the step rects.
 * DIAGNOSTIC_SAMPLES (2), not TASK_SAMPLES: the offset is intermittent and an intermittent fault
 * seen once is a rumour, but nothing here is resolving a success rate — the artifact is
 * geometryBasis and the step rects, and the task outcome is close to irrelevant.
 */
const DIAGNOSTICS: Arm[] = [
	task("geometry-ax", { backend: "ax" }, "is the AX→screenshot transform sound when nothing stages the window", {
		phase: 9,
		n: DIAGNOSTIC_SAMPLES,
		axRationale: "the transform under test IS the ax path's; cdp needs none (scale:\"css\" ties screenshot pixels to the coordinates act consumes)",
	}),
	task("geometry-ax-filmed", { backend: "ax", record: true }, "does staging the window perturb the geometry the harness reads", {
		phase: 9,
		n: DIAGNOSTIC_SAMPLES,
		axRationale: "same transform, with the window resize --record performs — the difference between the two arms IS the measurement",
	}),
];

/**
 * Everything declared directly, before the two derived stages. Deliverables is derived FROM it,
 * so it cannot appear here.
 */
/**
 * Discovery for the second app. Two passes, both cdp — `run.ts` REFUSES a web target on the ax
 * backend ("web targets run on the cdp backend"), so the backend axis simply does not exist
 * here. That is the price of choosing the brief's app over an installed one, and it is why these
 * arms cannot re-test "is grounding backend-dependent".
 *
 * The no-vision pass exists because `notion-cdp-grounded-no-vision` consumes an
 * APPMAP_VARIANT=novision map. Grounding an arm on a map its own treatment did not produce is
 * LIMITATIONS §23 with the sign flipped.
 *
 * A stamped map from 2026-07-31 already exists (471 nodes, 119 surfaces, frontier-empty, 1h14m).
 * It predates the prompt and frontier fixes that forced a re-run of every Yarn pass, so these
 * arms re-run it rather than grounding on code no other arm executed. Skip them with `--force`
 * and reuse the old map if the 1h14m is not affordable — but label the rows if you do.
 */
/**
 * Carried by EVERY Notion arm, not just the explores.
 *
 * It used to sit on the two explore arms only, which was a reading of `prereq` as "what this pass
 * needs to produce its artifact" rather than "what this run needs to start". Every Notion task,
 * replay and filmed take depends on the same session, and a fleet Mac without it does not fail
 * loudly — it lands on a login wall and the run reads as an agent that could not do the task.
 * Measured 2026-08-03: mac1 had no app.notion.com session while mac2 and mac3 did, so an unlucky
 * schedule and a broken agent look identical.
 *
 * Kept to one line because `bench plan` prints it per arm, and 75 of the 77 Notion arms carry it —
 * the two compiles do not, because a compile is a local file transform that never opens a browser.
 */
const NOTION_PREREQ = "Notion signed in to the RUNNER's Chrome profile, not the operator's Mac (`./run browser-login`)";

const DISCOVERY_SECOND_APP: Arm[] = [
	{
		id: "explore-notion-cdp",
		phase: 1,
		kind: "explore",
		app: SECOND_APP_URL,
		n: EXPLORE_SAMPLES,
		dispatch: { backend: "cdp", url: SECOND_APP_URL },
		prereq: NOTION_PREREQ,
		informs: "does the discovery story hold on an app 3x Yarn's size that nobody tuned the harness against",
	},
	{
		id: "explore-notion-cdp-no-vision",
		phase: 1,
		kind: "explore",
		app: SECOND_APP_URL,
		n: EXPLORE_SAMPLES,
		dispatch: { backend: "cdp", noVision: true, url: SECOND_APP_URL },
		prereq: NOTION_PREREQ,
		informs: "the novision map the no-vision arm reads; also a second sample of what dropping screenshots costs during GROUNDING",
	},
	/**
	 * The vision-only grounding pass, added 2026-08-03 when the second app went to a full cdp
	 * mirror. It is a PREREQUISITE, not an extra: five of the eleven mirrored cells resolve to
	 * `web-app.notion.com.cdp.vision` — the two `-visionmap` cells, `vision-only-cdp-grounded`, and
	 * both snap cells — and grounding an arm on a map no arm writes is how a run ends up
	 * ungrounded under a grounded label. That is this repo's most-repeated failure and the one
	 * `groundingChecked` caught six times in the last pass.
	 *
	 * An earlier note here argued the opposite — that the two vision-only Notion cells were "cut on
	 * the evidence" because all four vision-only cdp cells on Yarn came back 0/3 and the vision-map
	 * win happened on ax, which is impossible on web. That reasoning was about whether the cells
	 * would SUCCEED. It is the wrong test for whether they should exist: a floor that reproduces on
	 * a second app is a result, and snap (the whole point of which is to ask whether refining the
	 * pixel rescues that floor) had no second-app measurement at all. The pass costs ~1h15m.
	 */
	{
		id: "explore-notion-cdp-vision",
		phase: 1,
		kind: "explore",
		app: SECOND_APP_URL,
		n: EXPLORE_SAMPLES,
		dispatch: { backend: "cdp", noAx: true, url: SECOND_APP_URL },
		prereq: NOTION_PREREQ,
		informs: "writes the .vision map the five pixel-reading Notion cells consume; also whether a vision-only sweep degrades worse on an app 3x Yarn's size",
	},
];

/**
 * The second APP crossed with a simple and a complex task — the FULL cdp mirror (David, 2026-08-03).
 *
 * DERIVED, not named. `SECOND_APP_CELLS` is every stage-2 cdp task cell, computed from the grid
 * rather than hand-listed, so a config added to stage 2 gets its Notion twin automatically. That is
 * the same rule `creationArms` and `FILMABLE` follow, and for the same reason: the alternative is
 * remembering. It resolves to eleven cells today.
 *
 * WHY ELEVEN AND NOT TWENTY-TWO. The other eleven stage-2 cells are `ax`, and a web target on the
 * ax backend is not a worse measurement — it is a hard refusal in `agent/run.ts`, `explore.ts` and
 * `backends/ax.ts`. The axdom cells go with them (the sidecar reads a native window's pid). So the
 * ax/cdp comparison, the native-equivalent tier and the min-context floor are Yarn-only by
 * construction, and no arrangement of Notion arms can reach Yarn's 231 runs. Crossing two tasks
 * puts Notion at 152 against Yarn's 116 cdp runs, which is the honest form of parity: every
 * dimension that CAN exist on a web target does, and Notion runs more of them than Yarn because
 * Yarn's config sweep crosses one task where this crosses two.
 *
 * The previous version ran THREE cells and argued the vision-only ones should stay cut because all
 * four vision-only cdp cells on Yarn came back 0/3. See the note on `explore-notion-cdp-vision` for
 * why that was the wrong test — briefly: a floor that reproduces on a second app is a result, and
 * snap exists precisely to ask whether refining the pixel lifts it.
 *
 * NO STEP BUDGET. The 30 and 60 that used to be pinned here are deleted. They sat below a default
 * backstop of 100, which made them the third instance of a ceiling acting as a verdict in this
 * file's history, and the comment justifying the 60 admitted it had no known-good run to measure
 * against. See `ArmDispatch.steps`. The complex arms carry a widened `stallSteps` instead, which is
 * the knob that matches the actual risk.
 *
 * TWO PREREQUISITES beyond the sign-in, both of which will silently degrade a run to the appmap
 * tier if missing rather than failing loudly:
 *  - `docs/curated/web-app.notion.com.md` — the two `curated` cells read it. A missing curated file
 *    warns and falls back, and `groundingChecked` only catches it at collect, after the runs are
 *    paid for.
 *  - `web-app.notion.com.cdp.vision.{md,json}` — written by `explore-notion-cdp-vision`, read by
 *    the two `-visionmap` cells, `vision-only-cdp-grounded`, and both snap cells.
 *
 * RESET NOTE: both tasks create workspace content, and teardown only restores what the mutation
 * journal recorded — page and database creation is not that. Seed the workspace to a known state
 * and clear it between passes, or run n+1 and read the first sample as contaminated.
 */
const SECOND_APP_CELLS: readonly string[] = [...CONFIG_CORE, ...CONFIG_SLICES]
	.filter((a) => a.kind === "task" && a.dispatch.backend === "cdp")
	.map((a) => a.id);

/**
 * The complex task's stall window, widened from the default 8.
 *
 * Not a guess dressed as a number, but not a measurement either — it is a bound read off the
 * nearest evidence. Yarn's creation task carried 8-14 CONSECUTIVE unverified steps in a run that
 * nonetheless succeeded, so 8 demonstrably ends work that would have finished on a flow whose
 * progress the text channel cannot see. The complex Notion task is strictly longer than that
 * (a schema change, five records, a second view, a grouping, a filter — six surfaces) and has no
 * known-good run at all, so it gets double the default rather than a number pretending to precision.
 *
 * This is the deliberate trade for deleting the step pin: a stall window too small ends working
 * runs, where a budget too small ends them AND reports the ending as the agent's verdict. If these
 * arms come back `stalled` with verified steps inside their last sixteen, raise it again — that
 * signature means the detector fired on a working run, exactly as 30 and 60 did before it.
 */
const SECOND_APP_COMPLEX_STALL = 16;

const secondAppArms = (): Arm[] =>
	[...CONFIG_CORE, ...CONFIG_SLICES]
		.filter((a) => SECOND_APP_CELLS.includes(a.id))
		.flatMap((a) => [
			{
				...a,
				id: `notion-${a.id}`,
				phase: 4 as Phase,
				app: SECOND_APP_URL,
				task: SECOND_APP_SIMPLE_TASK,
				dispatch: { ...a.dispatch, url: SECOND_APP_URL },
				prereq: NOTION_PREREQ,
				informs: `does ${a.id}'s result transfer to a second app on a SIMPLE task`,
			},
			{
				...a,
				id: `notion-complex-${a.id}`,
				phase: 4 as Phase,
				app: SECOND_APP_URL,
				task: SECOND_APP_COMPLEX_TASK,
				dispatch: { ...a.dispatch, url: SECOND_APP_URL, stallSteps: SECOND_APP_COMPLEX_STALL },
				prereq: NOTION_PREREQ,
				informs: `does ${a.id}'s result transfer to a second app on a COMPLEX task — and does Yarn's task-dependence reproduce`,
			},
		]);

/**
 * Reuse on the second app: compile, replay, and both recipe lineages, per task.
 *
 * Mirrors REUSE_PROCEDURES and REUSE_RECIPES on the one backend a web target has. It sits in
 * stage 4 rather than stage 3 for the same reason `blur-compile`/`blur-replay` do — stage 3 is the
 * canonical task's reuse slice, and a second subject's reuse arms belong with the generalization
 * question they answer. The precedent is exact, so this needs no new gate.
 *
 * Procedures are already PROVEN on web: `docs/procedures/www.wikipedia.org.bdf46c21.procedure.json`
 * is a committed web procedure and `procedure-cli.ts` replays one through `--url`. Recipes work too
 * but relied on a slug that diverged for web targets — the promote path and the bench gate slugged
 * `https-app.notion.com` while the run itself read `web-app.notion.com`, so every one of these arms
 * would have found no recipe and silently run as an appmap arm. That is fixed at the three write
 * sites; these arms are the first consumers that would have been bitten by it.
 *
 * Each recipe arm needs its OWN promoted harvest: `recipeFileFor` keys on the task hash, and the
 * two Notion tasks hash differently, so a recipe harvested from the simple task cannot ground the
 * complex one. The gate skips an arm with no promoted recipe loudly, which is the intended
 * behaviour rather than a gap — the absence is itself a finding.
 */
const secondAppReuseArms = (): Arm[] =>
	[
		{ suffix: "", task: SECOND_APP_SIMPLE_TASK, stall: undefined as number | undefined },
		{ suffix: "complex-", task: SECOND_APP_COMPLEX_TASK, stall: SECOND_APP_COMPLEX_STALL },
	].flatMap(({ suffix, task: armTask, stall }): Arm[] => {
		const id = (rest: string): string => `notion-${suffix}${rest}`;
		const web = { backend: "cdp" as const, url: SECOND_APP_URL, ...(stall !== undefined ? { stallSteps: stall } : {}) };

		return [
			{
				id: id("compile-cdp"),
				phase: 4,
				kind: "compile",
				app: SECOND_APP_URL,
				n: COMPILE_RUNS,
				dispatch: { ...web },
				sourceArm: id("cdp-grounded"),
				informs: "does compile survive a second app — and what the gate refuses on a database-shaped one",
			},
			{
				id: id("replay-cdp"),
				phase: 4,
				kind: "replay",
				app: SECOND_APP_URL,
				n: TASK_SAMPLES,
				dispatch: { ...web },
				sourceArm: id("compile-cdp"),
				prereq: NOTION_PREREQ,
				informs: "steps re-resolved vs rescued on a second app; model calls (target 0) and wall-clock vs live grounding",
			},
			{
				id: id("replay-norescue"),
				phase: 4,
				kind: "replay",
				app: SECOND_APP_URL,
				n: TASK_SAMPLES,
				dispatch: { ...web, noRescue: true },
				sourceArm: id("compile-cdp"),
				prereq: NOTION_PREREQ,
				informs: "unattended-fleet posture on a second app: does the happy path hold with ZERO model calls",
			},
			{
				id: id("cdp-recipe"),
				phase: 4,
				kind: "task",
				app: SECOND_APP_URL,
				task: armTask,
				n: TASK_SAMPLES,
				dispatch: { ...web, useRecipes: true },
				sourceArm: id("cdp-grounded"),
				prereq: NOTION_PREREQ,
				informs: "does a frozen judge-passed route beat live appmap grounding on a second app, ON THE TASK IT WAS HARVESTED FROM",
			},
			{
				id: id("cdp-recipe-from-ungrounded"),
				phase: 4,
				kind: "task",
				app: SECOND_APP_URL,
				task: armTask,
				n: TASK_SAMPLES,
				dispatch: { ...web, useRecipes: true, recipeLineage: "ungrounded" },
				sourceArm: id("cdp-ungrounded"),
				prereq: NOTION_PREREQ,
				informs: "THE replacement question on a second app: can a write-up by an agent that had no map stand in for the 1h15m sweep",
			},
		];
	});

/**
 * The model axis on the second app — three cells per task, mirroring GEN_TASK_AND_MODEL exactly.
 *
 * The Yarn model comparison varies one variable against its Sol twin. Doing the same here is what
 * turns "Claude is better/worse at this" into a claim about the AGENT rather than about Yarn's DOM,
 * which is the whole reason a second app was wired. The recipe cell is included because the
 * replacement result is the finding most worth a second model AND a second app — it is the one that
 * decides whether onboarding is a sweep or a handful of runs.
 *
 * The recipe file is keyed by (slug, backend, task hash, lineage) and NOT by model, so these arms
 * read the same promoted recipe their Sol twins do. That is the point: the input is held fixed and
 * only the reader changes.
 */
const secondAppModelArms = (): Arm[] =>
	[
		{ suffix: "", task: SECOND_APP_SIMPLE_TASK, stall: undefined as number | undefined },
		{ suffix: "complex-", task: SECOND_APP_COMPLEX_TASK, stall: SECOND_APP_COMPLEX_STALL },
	].flatMap(({ suffix, task: armTask, stall }): Arm[] => {
		const web = { backend: "cdp" as const, url: SECOND_APP_URL, model: BENCH_ALT_MODEL, ...(stall !== undefined ? { stallSteps: stall } : {}) };
		const cell = (rest: string, dispatch: ArmDispatch, informs: string, sourceArm: string): Arm => ({
			id: `claude-notion-${suffix}${rest}`,
			phase: 4,
			kind: "task",
			app: SECOND_APP_URL,
			task: armTask,
			n: TASK_SAMPLES,
			dispatch,
			sourceArm,
			prereq: NOTION_PREREQ,
			informs,
		});

		return [
			cell("cdp-ungrounded", { ...web, noGrounding: true }, "is the ungrounded floor a model property, a Yarn property, or a general one — the three-way this arm alone can separate", `notion-${suffix}cdp-ungrounded`),
			cell("cdp-grounded", { ...web }, "does grounding lift Claude the way it lifts Sol, off Yarn", `notion-${suffix}cdp-grounded`),
			cell("cdp-recipe-from-ungrounded", { ...web, useRecipes: true, recipeLineage: "ungrounded" }, "does the replacement result survive BOTH a model change and an app change", `notion-${suffix}cdp-ungrounded`),
		];
	});

const GEN_SECOND_APP: Arm[] = [...secondAppArms(), ...secondAppReuseArms(), ...secondAppModelArms()];

const DECLARED: Arm[] = [...DISCOVERY, ...DISCOVERY_SECOND_APP, ...CONFIG_CORE, ...CONFIG_SLICES, ...REUSE_PROCEDURES, ...REUSE_RECIPES, ...GEN_SECOND_TASK, ...GEN_TASK_AND_MODEL, ...GEN_SECOND_APP, ...DIAGNOSTICS];

/**
 * Filmed twins come from MEASUREMENT stages only, read off `StageDef.kind`.
 *
 * This used to be a hand-listed set of phase arrays, and Diagnostics had to be left out of it by
 * name — one of two exceptions that stage needed, because it films as its own measurement and
 * filming it again would compare a run against itself. Keying on kind makes that a consequence
 * rather than a special case, and a future non-measurement stage is excluded before anyone
 * remembers to exclude it.
 */
const FILMABLE: Arm[] = DECLARED.filter(
	// EVERY app, as of 2026-08-03. This used to be `a.app === BENCH_APP`, on the reasoning that the
	// deliverable is footage of the PRODUCT and nobody would cut a reel from the agent driving
	// someone else's web app. That is still true about the DELIVERABLE and was the wrong rule
	// anyway, because stage 5 is not only a deliverable — it is the matrix's validity check on its
	// own ranking. `--record` changes the action space (demo conduct, a demo act tool with no
	// `set_value`, hover-dwell-click), so if the reliability ranking REORDERS under film then the
	// measurement stages ranked configs in a mode the product does not ship. Asking that question of
	// Yarn only answered it for Yarn: a reorder that appears on one app and not the other is the
	// more interesting result, and it was unmeasurable while this clause stood.
	//
	// Cost is 36 further n=1 takes. Read the Notion takes as the validity check, not as reel
	// material — nothing downstream cuts from them.
	(a) => stageOf(a.phase)?.kind === "measurement" && (a.kind === "task" || a.kind === "replay"),
);

const DELIVERABLES: Arm[] = FILMABLE.map(filmed);


export const MATRIX: readonly Arm[] = [...DECLARED, ...DELIVERABLES];

export const phaseArms = (phase: Phase): Arm[] => MATRIX.filter((a) => a.phase === phase);

/**
 * Arms that ground on a promoted recipe — the set the recipe gate, the harvest source list
 * and the autopilot's "ran without" report all mean when they say it.
 *
 * They used to say `phaseArms(6)`, which was true only while recipes lived alone in a phase.
 * Reuse now holds procedures and recipes together, so the number stopped meaning the thing; the
 * dispatch flag always did.
 */
/**
 * The three gates, derived from the ARMS a stage holds rather than declared on the stage.
 *
 * Declaring them was the same mistake as `phaseArms(6)` in a smaller key: a stage does not
 * "have a recipe gate", it CONTAINS arms that ground on a recipe. The audit found the
 * difference — six of ten recipe arms sat in stages with no `recipeGate: true`, so a
 * claude cell and five filmed twins could dispatch with nothing promoted and bank runs labelled
 * "recipe" that measured the appmap tier. That is the exact failure the gate's own comment
 * warns about, and it survived because the flag was attached to the wrong noun.
 */
export const stageCompiles = (phase: Phase): boolean => phaseArms(phase).some((a) => a.kind === "compile");

/** Arms that load grounding prose, so the stage cannot dispatch before Discovery is collected. */
const readsAMap = (a: Arm): boolean => a.kind === "task" && !a.dispatch.noGrounding && !a.dispatch.useCurated && !a.dispatch.useRecipes;

/**
 * Diagnostics is exempt BY KIND, not by number: it measures the AX→screenshot transform, and
 * whether a map happened to load says nothing about that. Every other stage holding a
 * map-reading arm is gated — including Generalization, whose ten grounded creation arms the
 * old `phase === 2 || phase === 5` check missed entirely.
 */
export const stageNeedsMaps = (phase: Phase): boolean => stageOf(phase)?.kind !== "diagnostic" && phaseArms(phase).some(readsAMap);

/**
 * The Discovery arms a stage's grounded arms actually depend on — PER APP.
 *
 * The gate used to be `phaseArms(1).filter(a => a.app === BENCH_APP)`, which was correct while
 * everything was Yarn and wrong the moment it was not: Generalization's Notion arms would have
 * been held up by Yarn explores they never read, and — far worse — would have dispatched with
 * their OWN app's map missing, since nothing checked for it. That is the same shape as the six
 * grounding-mismatch runs the last pass paid for and only detected at collect.
 */
export const discoveryArmsFor = (phase: Phase): Arm[] => {
	const apps = new Set(phaseArms(phase).filter(readsAMap).map((a) => a.app));

	return phaseArms(1).filter((a) => apps.has(a.app));
};

export const recipeArms = (phase?: Phase): Arm[] =>
	MATRIX.filter((a) => a.dispatch.useRecipes && (phase === undefined || a.phase === phase));

/**
 * The model an arm will ACTUALLY run on: its own pin, else the pass default. Sample counting
 * has to agree with dispatch about this or a pinned arm never retires — its entries land under
 * the pinned model while submittedCount looks for the pass model, finds none, and re-dispatches
 * forever.
 */
export const armModel = (arm: Arm, passModel?: string): string | undefined => arm.dispatch.model ?? passModel;

/**
 * An arm by id, resolving the PRE-STAGES spelling as well.
 *
 * Ids lost their phase prefix in the stages collapse (109bf7a, "Ids name the cell, not the
 * stage") — `p2-ax-grounded` became `ax-grounded`. Every manifest written before that carries the
 * old form, so a legacy entry handed to this function used to answer `undefined`: collect's
 * grounding check and film gating, and the dash's detail pane, all silently treated those runs as
 * "unknown arm" rather than as runs.
 *
 * NECESSARY BUT NOT SUFFICIENT, and worth stating so nobody reads more into it. Rendering a pass
 * needs entries MATCHED to arms, and that happens in ~9 places that compare `e.armId === a.id`
 * directly (report.ts, dash.ts's buildState, autopilot.ts) — none of them route through here. A
 * pre-stages manifest therefore still renders as an empty board: measured 2026-08-03, the
 * 2026-08-01 pass showed 0 arms and 0 of 198 entries under current code. Restoring that needs the
 * armId canonicalised at the manifest-read boundary, which is a data migration and a separate
 * decision.
 *
 * The fallback is one rule, applied only after an exact miss, and it reads legacy while nothing
 * writes it — the same posture paths.ts takes toward the store's pre-`bench/` homes: reads walk
 * the old locations, writes only ever use the current one. A future rename that is not "drop the
 * phase prefix" will need its own line here, and will be just as visible when it does.
 */
/**
 * Arms renamed by more than the phase prefix, old id → new. Consulted before the prefix strip.
 *
 * Every entry here was verified against the RUNS' OWN LOGS, not inferred from the names: each of
 * these jobs recorded `task: "show me how to change the motion blur"`, identical to the current
 * `blur-*` arms' task, and the grounded/ungrounded split survives in the id. That is what makes
 * this a mapping rather than a guess.
 *
 * The `*-procedure*` block is the second half, and it was left blank here with a note asking for
 * "someone who knows the mapping" — this is that mapping, and the caution it replaces was aimed at
 * a spelling that never existed. The words swapped on 2026-08-03: a PROCEDURE is now the frozen
 * click sequence and a RECIPE is the prose, which is the reverse of what they meant when this pass
 * ran. So the prose arms were spelled `*-procedure*` THEN and are spelled `*-recipe*` NOW, and
 * there was never a `p6-ax-recipe` in any manifest — `out/bench-backup/2026-08-03-filmed-ax-before-fixes`
 * is an untouched pre-swap copy and holds `p5-ax-procedure-filmed`, never the recipe spelling.
 * They are the same ten arms under two names, not two kinds of artifact: the tier flag on every
 * one of these rows is the prose tier, and the pre-swap machine-steps arms were called
 * `compile-*`/`replay-*` — no id on either side of the swap is ambiguous between them.
 *
 * Anything renamed beyond a prefix belongs in this table, and is NOT to be guessed at: naming the
 * wrong arm would attribute runs to a config that did not produce them, the exact class of error
 * `groundingChecked` exists to catch. Every entry above cites the evidence that fixed it.
 */
export const RENAMED_ARMS: ReadonlyMap<string, string> = new Map([
	["p4-ungrounded", "blur-ungrounded"],
	["p4-grounded", "blur-grounded"],
	["p4-compile", "blur-compile"],
	["p5-ungrounded-filmed", "blur-ungrounded-filmed"],
	["p5-grounded-filmed", "blur-grounded-filmed"],
	// The prose tier, pre-swap spelling -> post-swap spelling.
	["p6-ax-procedure", "ax-recipe"],
	["p6-cdp-procedure", "cdp-recipe"],
	["p6-ax-procedure-from-ungrounded", "ax-recipe-from-ungrounded"],
	["p6-cdp-procedure-from-ungrounded", "cdp-recipe-from-ungrounded"],
	["p7-claude-cdp-procedure-from-ungrounded", "claude-cdp-recipe-from-ungrounded"],
	["p5-ax-procedure-filmed", "ax-recipe-filmed"],
	["p5-cdp-procedure-filmed", "cdp-recipe-filmed"],
	["p5-ax-procedure-from-ungrounded-filmed", "ax-recipe-from-ungrounded-filmed"],
	["p5-cdp-procedure-from-ungrounded-filmed", "cdp-recipe-from-ungrounded-filmed"],
	["p5-claude-cdp-procedure-from-ungrounded-filmed", "claude-cdp-recipe-from-ungrounded-filmed"],
]);

export const armById = (id: string): Arm | undefined => {
	const exact = MATRIX.find((a) => a.id === id);
	if (exact) return exact;
	const renamed = RENAMED_ARMS.get(id);
	if (renamed) return MATRIX.find((a) => a.id === renamed);

	return /^p[0-9]+-/.test(id) ? MATRIX.find((a) => a.id === id.replace(/^p[0-9]+-/, "")) : undefined;
};

/**
 * The CURRENT spelling of an arm id, for manifests written before the stages collapse.
 *
 * `readManifest` puts every entry through this, which is what makes one boundary enough: the ~9
 * sites that compare `e.armId === a.id` (report.ts, dash.ts's buildState, autopilot.ts) then see
 * current ids without any of them knowing a rename happened. Resolving it at each call site
 * instead would be nine chances to forget, and the failure mode is silent — an entry whose arm
 * does not resolve is not flagged, it is simply absent from the board.
 *
 * UNRECOGNISED IDS PASS THROUGH UNCHANGED, deliberately — and stay countable, see
 * DashState.unmatchedEntries. The 15 semantically-renamed arms of the 2026-08-01 pass
 * (`p4-grounded`, `p6-ax-procedure`, …) are now in RENAMED_ARMS, each verified against a run's own
 * log or against an untouched pre-swap manifest rather than inferred from its name. Anything still
 * unrecognised is genuinely unknown, and guessing at it would attribute runs to a config that did
 * not produce them — the failure this repo has been burned by before, a run reporting grounding
 * its row did not have.
 */
export const canonicalArmId = (id: string): string => armById(id)?.id ?? id;

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
 * explore-ax and explore-no-vision still collided.
 *
 * WHICH TIER A CONSUMER READS IS `APPMAP_VARIANT`, NOT ITS OWN PERCEPTION (fixed 2026-08-03).
 * This derived the tier from `dispatch.noAx`, which is the arm's own perception — but at run time
 * `harness/appmap.ts` picks the tier from the env variant ALONE, and its comment says so
 * deliberately ("not auto-derived from the run's own perception"). The two disagreed for five arms,
 * and the disagreement was not cosmetic: `vision-only-grounded-axmap` and `-visionmap` exist
 * precisely to be told apart, and both collapsed to one slug, so the dash attributed runs to a
 * graph they never read. `cdp-grounded-visionmap` was inverted the other way. Reading the variant
 * here makes this function agree with the code that actually opens the file.
 *
 * An explore arm has no variant to read — it WRITES the tier its own perception produces — so the
 * `noAx` fallback is still correct for `kind: "explore"` and only for it.
 */
export const armAppmapSlug = (arm: Arm): string =>
	appmapSlug(arm.app, {
		visionOnly: arm.kind === "explore" ? Boolean(arm.dispatch.noAx) : arm.env?.APPMAP_VARIANT === "vision",
		noVision: arm.kind === "explore" ? Boolean(arm.dispatch.noVision) : arm.env?.APPMAP_VARIANT === "novision",
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
 * do `flags.includes("USE_CURATED")`, which is a parse of a display artifact — it breaks the
 * moment flagsLine changes its wording, and silently, since a missed match just falls
 * through to "grounded task".
 */
export function armTitle(arm: Arm): string {
	const filmed = arm.dispatch.record ? "filmed " : "";
	if (arm.kind === "explore") return `${filmed}grounding pass${arm.dispatch.url ? " (web)" : ""}`;
	if (arm.kind === "compile") return "procedure compile";
	if (arm.kind === "replay") return `${filmed}procedure replay${arm.dispatch.noRescue ? " (no rescue)" : ""}`;

	// The recipe branch is checked BEFORE the appmap variant because USE_RECIPES replaces the map
	// rather than adding to it — an arm reading a recipe is not a vision-map arm that also has prose.
	// Without this branch all fourteen recipe arms rendered as a plain "grounded task", which is the
	// fall-through this function's header warns about: indistinguishable from the appmap arms they
	// exist to be compared against. The lineage is in the label because the two lineages are
	// different experiments — one presupposes the sweep, the other is the claim that replaces it.
	const tier = arm.dispatch.noGrounding
		? "ungrounded"
		: arm.dispatch.useCurated
			? "human-notes"
			: arm.dispatch.useRecipes
				? arm.dispatch.recipeLineage === "ungrounded"
					? "recipe (from ungrounded)"
					: "recipe"
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
	if (d.useCurated) parts.push("USE_CURATED=1");
	if (d.useRecipes) parts.push("USE_RECIPES=1");
	if (d.recipeLineage === "ungrounded") parts.push("RECIPE_LINEAGE=ungrounded");
	if (d.noRescue) parts.push("--no-rescue");
	for (const [k, v] of Object.entries(arm.env ?? {})) parts.push(`${k}=${v}`);

	return parts.join(" ") || "(defaults)";
}
