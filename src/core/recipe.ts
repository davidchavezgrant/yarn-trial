import fs from "node:fs";
import type { ObservationBundle } from "./harness.js";
import type { Expectation, StepRecord } from "../types.js";

/**
 * Recipe compilation: a successful run's thinking, frozen into a replayable sequence.
 *
 * The production cost story (Jasper, 2026-07-28; FOR_AMAN §9): grounding-time and first-run
 * thinking are paid once, and every run after that replays the recorded actions with
 * deterministic verification — the model is invoked only when the app has drifted from what
 * the recipe remembers. A replayed run costs zero model calls on the happy path.
 *
 * What a recipe step stores, and why:
 *
 * - The ACTION with its volatile handles STRIPPED. `element_index` is a walk order that
 *   renumbers on every observation, and a CDP `ref` is re-issued per snapshot — both are
 *   meaningless minutes after they were recorded, and replaying one addresses whatever
 *   control happens to occupy that slot today. This is the same fact that forced the
 *   journal to match controls by (name, surface) and the frontier to key by role|label|
 *   surface. Coordinates, text, keys and directions are kept: they are the action's
 *   payload, not its addressing.
 * - A TARGET DESCRIPTOR (role + name + surface), read from the step record's own
 *   targetName/targetRole. Replay re-resolves it against a FRESH observation, exactly the
 *   way the forward loop resolves a model-proposed name. A step that addressed no element
 *   (a keystroke, a coordinate drag on a canvas) has no descriptor and replays as-is.
 * - The recorded EXPECTATION, verbatim. It already passed `verify()` once, including the
 *   discrimination check, so it is known to be checkable and known to discriminate on the
 *   surface it was written for. Replay runs the same `verify()` with the same authority —
 *   the recipe carries the checks, so a replay is gated per step exactly like a live run,
 *   not trusted like a macro.
 *
 * What a recipe deliberately does NOT store: observations, screenshots, model reasoning.
 * A recipe is a claim about the APP ("these controls, on these surfaces, respond to these
 * actions with these effects"), not a recording of one afternoon's pixels. Everything
 * environmental is re-derived at replay time.
 *
 * Provenance: a recipe is stamped with the run it was compiled from and that run's
 * grounding tier. It is machine output — the same rule as stamped appmaps applies
 * (CLAUDE.md "Measurement rule"): never hand-edit one. A hand-authored sequence belongs in
 * docs/recipes/<app>.md prose, which is a different, separately-declared tier.
 */

/**
 * Actions that never address an element and replay without resolution. press_key is NOT
 * here: recorded with a target it re-arms with the resolved handle, which directs the key
 * at that field rather than at whatever has focus — the no-op-click-then-stray-keystroke
 * failure documented in LIMITATIONS §4.
 */
const NO_TARGET_ACTIONS = new Set(["wait", "navigate", "drag"]);

/**
 * Volatile per-observation handles, stripped at compile time. `pid`/`window_id` are the AX
 * path's session plumbing (re-derived by findWindow at replay); `element_index`/`ref` are
 * walk orders. Everything else an action carries is payload.
 */
const VOLATILE_ARGS = new Set(["pid", "window_id", "element_index", "ref"]);

export interface RecipeTarget {
	/** AX role or CDP role, as the recording observed it ("AXButton", "searchbox"). */
	role?: string;
	/** The control's name as the model saw it — the stable half of its identity. */
	name: string;
	/** Nearest named ancestor, disambiguating same-named controls on different panels. */
	surface?: string;
}

export interface RecipeStep {
	/** Tool name ("click", "type_text", …) plus non-volatile args, ready for re-targeting. */
	action: { name: string; args: Record<string, unknown> };
	/** Re-resolved against a fresh observation at replay. Absent = replay action as-is. */
	target?: RecipeTarget;
	/** The recorded check, verbatim — already proven checkable and discriminating once. */
	expectation: Expectation;
}

export interface Recipe {
	version: 1;
	task: string;
	app: string;
	slug: string;
	backend: string;
	/** Run stamp this was compiled from, so a recipe is auditable back to its evidence. */
	compiledFrom: string;
	compiledAt: string;
	/** The grounding tier of the source run — a recipe from a hinted run says so forever. */
	grounding?: unknown;
	hintedPrompt?: boolean;
	steps: RecipeStep[];
	/** The run's final goal check, replayed as the recipe's own success gate. */
	finalEvidence?: Expectation;
}

export class RecipeCompileError extends Error {}

/**
 * Compile a finished run log into a recipe.
 *
 * Refuses runs that cannot honestly seed one: a failed run's steps are not a route to the
 * goal, and an unverified step proves nothing about what its action did — replaying it
 * would assert an effect nobody ever observed. Steps that verified by pixels alone are
 * refused for the same reason: a pixel delta says SOMETHING changed, and a recipe's whole
 * value is knowing WHAT to check. (Runs with such steps can still ground a fresh live run;
 * they just cannot be frozen.)
 */
export function compileRecipe(runLog: Record<string, any>, stamp: string): Recipe {
	if (!runLog.success) throw new RecipeCompileError("run did not succeed — a recipe compiled from it would replay a failure");
	if (!Array.isArray(runLog.steps) || runLog.steps.length === 0)
		throw new RecipeCompileError("run has no steps");

	const steps: RecipeStep[] = [];
	for (const s of runLog.steps as StepRecord[]) {
		const name = actionName(s.action);
		// A wait is thinking-time, not a state transition: the recipe's per-step settle covers
		// pacing, and freezing one run's five-minute embedded-agent wait into every replay
		// would charge every future run for one afternoon's slow render.
		if (name === "wait") continue;
		if (!s.verified)
			throw new RecipeCompileError(
				`step ${s.index} (${name}) was not verified — a recipe cannot assert an effect nobody observed`,
			);
		if (s.verificationChannel === "pixel")
			throw new RecipeCompileError(
				`step ${s.index} (${name}) verified by pixels only — there is no text check to replay`,
			);

		steps.push({
			action: { name, args: stripVolatile(argsOf(s.action)) },
			// Absent fields stay absent (never `undefined`): a recipe round-trips through
			// JSON, which drops undefined and would make the parsed copy differ from the
			// compiled one.
			...(s.targetName
				? {
						target: {
							name: s.targetName,
							...(s.targetRole !== undefined ? { role: s.targetRole } : {}),
							...(surfaceOf(s) !== undefined ? { surface: surfaceOf(s) } : {}),
						},
					}
				: {}),
			expectation: s.expectation,
		});
	}
	if (steps.length === 0) throw new RecipeCompileError("run contains no replayable steps (all waits)");

	return {
		version: 1,
		task: runLog.task,
		app: runLog.app,
		slug: slugOf(runLog, stamp),
		backend: runLog.backend ?? "ax",
		compiledFrom: stamp,
		compiledAt: new Date().toISOString(),
		...(runLog.grounding !== undefined ? { grounding: runLog.grounding } : {}),
		...(runLog.hintedPrompt ? { hintedPrompt: true } : {}),
		steps,
		...(runLog.finalCheck?.evidence ? { finalEvidence: runLog.finalCheck.evidence } : {}),
	};
}

/**
 * Resolve a recipe target against a fresh observation.
 *
 * The identity question the whole design rests on: same (name, surface, role-if-recorded),
 * matched exactly the way the journal matches controls across observations. Surface and
 * role narrow progressively rather than gate absolutely — an app that renamed a panel
 * between recording and replay still resolves by unique name, but two same-named controls
 * (the dual-scope trap) resolve only if the recorded surface separates them. Ambiguity is
 * an error, never a guess: clicking "the other Save Changes" is precisely the wrong-scope
 * bug the scope machinery exists to prevent, and a recipe that guesses re-introduces it
 * with no model in the loop to notice.
 */
export function resolveTarget(
	target: RecipeTarget,
	obs: ObservationBundle,
): { handle: number | string } | { error: string } {
	let candidates = obs.interactive.filter((e) => e.name === target.name);
	if (candidates.length > 1 && target.surface !== undefined)
		candidates = narrow(candidates, (e) => e.surface === target.surface);
	if (candidates.length > 1 && target.role !== undefined)
		candidates = narrow(candidates, (e) => e.role === target.role);

	if (candidates.length === 1) return { handle: candidates[0].handle };
	if (candidates.length === 0)
		return { error: `no control named ${JSON.stringify(target.name)} in the current observation` };

	return {
		error:
			`${candidates.length} controls named ${JSON.stringify(target.name)}` +
			`${target.surface ? ` on surface ${JSON.stringify(target.surface)}` : ""} — cannot replay an ambiguous target`,
	};
}

/** Filter, but only when the predicate keeps at least one candidate — never narrow to zero. */
function narrow<T>(list: T[], keep: (t: T) => boolean): T[] {
	const kept = list.filter(keep);

	return kept.length > 0 ? kept : list;
}

/**
 * Re-arm a compiled action with a freshly-resolved handle, in each backend's dialect.
 * The AX path's toActionRequest re-adds pid/window_id; the CDP path's act() takes ref
 * directly. Handle-less actions pass through unchanged.
 */
export function armAction(
	step: RecipeStep,
	handle: number | string | undefined,
	backend: string,
): Record<string, unknown> {
	const a: Record<string, unknown> = { name: step.action.name, ...step.action.args };
	if (handle !== undefined) {
		if (backend === "cdp") a.ref = handle;
		else a.element_index = handle;
	}

	return a;
}

/** Does this step need a resolved element, or does it replay as recorded? */
export function needsTarget(step: RecipeStep): boolean {
	if (!step.target) return false;
	if (NO_TARGET_ACTIONS.has(step.action.name)) return false;
	// A coordinate action recorded x/y as payload — the canvas case, where there was never
	// an element to resolve. Its target field is provenance, not addressing.
	if (step.action.args.x !== undefined || step.action.args.from_x !== undefined) return false;

	return true;
}

function actionName(action: any): string {
	return action?.kind === "tool" ? action.name : (action?.kind ?? "unknown");
}

function argsOf(action: any): Record<string, unknown> {
	return action?.kind === "tool" ? (action.args ?? {}) : { ...action, kind: undefined };
}

function stripVolatile(args: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(args)) if (!VOLATILE_ARGS.has(k) && v !== undefined) out[k] = v;

	return out;
}

function surfaceOf(s: StepRecord): string | undefined {
	// Typed, not cast. The `as any` this replaces is the whole reason the field went unwritten
	// for months: the read compiled fine against a StepRecord that had no such property, so
	// nothing flagged that step.ts never set it. Every recipe compiled in that window has
	// targets with name+role only, which resolve ambiguously on any app with two same-named
	// controls — the failure is safe (an error, never a wrong click) and therefore silent.
	// Absent still means "resolve by name and role alone", which is what old recipes carry.
	return s.targetSurface;
}

/** Exported for procedure.ts: both artifacts key on (app, task) and must derive the app half identically. */
export function slugOf(runLog: Record<string, any>, stamp: string): string {
	// The stamp always ends "-<slug>"; the run log's app name round-trips through appSlug
	// identically, but the stamp is what the artifacts are already keyed by.
	const m = stamp.match(/^(?:.*T[\d-]+Z?(?:-\d+)?)-(.+)$/);

	return m?.[1] ?? String(runLog.app ?? "unknown").toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
}

/**
 * The task half of an artifact's identity, hashed short so filenames stay readable.
 *
 * Exported because procedures key on (app, task) too, and the two artifacts derived from one run
 * must agree on which task it was — a procedure findable by a run doing a DIFFERENT task on the
 * same app is the failure mode this identity exists to prevent.
 */
export function taskHash(task: string): string {
	let h = 0;
	for (const c of task) h = (h * 31 + c.charCodeAt(0)) | 0;

	return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * One recipe per (app, task, BACKEND).
 *
 * The backend was missing and it silently destroyed an arm. A recipe is a frozen sequence of
 * `(name, surface, role)` resolutions, and ax and cdp name the same controls differently — so
 * the two are not interchangeable artifacts that happen to share a task, they are different
 * recordings. Keyed on (app, task) alone, phase 3's two compile arms wrote the same path and
 * the cdp compile (9 steps) overwrote the ax one (11 steps). `p3-replay-ax` then deferred
 * forever: its gate wanted an ax recipe and the only file on disk was cdp's.
 *
 * `procedureFileFor` already keys on backend for exactly this reason. Recipes were the tier
 * that missed it.
 *
 * Backend is optional so a caller that genuinely does not know one (a bare path lookup for an
 * old file) still resolves the legacy name rather than throwing.
 */
export function recipeFileFor(dir: string, slug: string, task: string, backend?: string): string {
	return `${dir}/${slug}.${taskHash(task)}${backend ? `.${backend}` : ""}.recipe.json`;
}

export function readRecipe(path: string): Recipe {
	const r = JSON.parse(fs.readFileSync(path, "utf8"));
	if (r.version !== 1) throw new RecipeCompileError(`unsupported recipe version ${r.version}`);

	return r as Recipe;
}
