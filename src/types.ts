export interface Observation {
	text: string;
	screenshotPath?: string;
	structured?: unknown;
	degraded: boolean;
}

export type ActionRequest =
	| { kind: "click"; x: number; y: number; button?: "left" | "right" | "middle"; count?: number }
	| { kind: "type"; text: string }
	| { kind: "key"; key: string }
	| { kind: "hotkey"; keys: string[] }
	| { kind: "scroll"; x: number; y: number; direction: "up" | "down" | "left" | "right"; amount?: number }
	| { kind: "tool"; name: string; args: Record<string, unknown> };

export interface Expectation {
	description: string;
	textIncludes?: string[];
	textExcludes?: string[];
}

export interface StepRecord {
	index: number;
	timestamp: string;
	action: ActionRequest;
	expectation: Expectation;
	verified: boolean;
	/**
	 * Which evidence proved it, weakest last. "text" is a substring that appeared or
	 * disappeared in the AX tree. "geometry" is a named element's frame moving by about the
	 * distance a drag asked for — structural, but it locates the re-layout rather than the
	 * dragged thing. "pixel" is only that the screen changed where the drag was aimed.
	 * Undefined when the step did not verify. Kept per step so a run's totals can be split by
	 * channel — a weak step must never be counted as a strong one.
	 */
	verificationChannel?: "text" | "geometry" | "pixel";
	verificationNote: string;
	screenshotFile?: string;
	/**
	 * Fraction of pixels (0..1) that changed vs the previous observation. Advisory: rendered
	 * content is absent from the AX text channel verify() greps, so this is the only signal
	 * that a canvas/preview did or did not repaint. Undefined when the diff could not run.
	 */
	pixelDelta?: number;
	modelReasoning?: string;
	/**
	 * AX role of the control this action operated, resolved against the PRE-action observation.
	 * Absent when the action addressed no element (a keystroke, or a coordinate that hit no box).
	 *
	 * Exists for the cursor pass: a recording has no cursor in it, so the pointer is drawn in
	 * post, and the role is what decides whether it should be an I-beam, a hand, or an arrow.
	 */
	targetRole?: string;
	/** That control's bounds in SCREENSHOT PIXELS, the same space coordinate actions consume. */
	targetRect?: { x: number; y: number; w: number; h: number };
	/** That control's name as the model saw it, so channel attribution can be read per step. */
	targetName?: string;
	/**
	 * Which channel NAMED the control this step operated: an AX label, the DOM descriptor
	 * (axdom sidecar — the control is anonymous in bare AX), or neither ("none": addressed by
	 * handle or coordinate with no name at all). Absent when no element was resolved. This is
	 * the per-step answer to "which perception channel did the work", counted by code rather
	 * than inferred from run-level flags.
	 */
	targetNamedBy?: "ax" | "dom" | "none";
}

/**
 * Structured companion to the prose appmap. Exploration emits BOTH: `docs/appmaps/<app>.md`
 * (injected into the prompt, which the model reads well) and `<app>.json` (this shape, which
 * code can query, diff, and validate). The prose stays the prompt input; the graph exists for
 * the things prose cannot do.
 *
 * The motivating case is real: on "change the cursor style to Pointer-first", the ungrounded
 * agent changed a per-draft override while the grounded one changed the brand-wide default,
 * and both passed verification because the evidence check only proves *a* control reads the
 * value, not that it is the *intended* one. Prose cannot express "this control exists at two
 * scopes"; `scope` + `settingKey` can, and `findScopeAmbiguities()` finds them mechanically.
 */
export type SurfaceScope = "app" | "workspace" | "brand" | "document" | "unknown";

export interface AppMapNode {
	/** Stable slug, e.g. "brand-kit/screen-clips". */
	id: string;
	title: string;
	kind: "surface" | "control";
	/** Whose state this changes. The lever against wrong-scope success. */
	scope: SurfaceScope;
	/**
	 * Present on controls only: identity of the SETTING, independent of where it is edited.
	 * Two nodes sharing a settingKey but differing in scope are a scope ambiguity.
	 */
	settingKey?: string;
	/** Observed values for enumerable controls (combobox/segmented). */
	options?: string[];
	notes?: string;
}

export interface AppMapEdge {
	from: string;
	to: string;
	/** How to get there, e.g. 'click "Brand Kit"'. Prose is fine; this is not replayed yet. */
	action: string;
}

export interface ScopeAmbiguity {
	settingKey: string;
	/** Node ids that edit the same setting at different scopes. */
	nodes: Array<{ id: string; scope: SurfaceScope }>;
}

/**
 * What the exploration pass actually touched, counted by code rather than reported by the
 * model. Its predecessor was a sentence in the prose map saying coverage was good.
 *
 * `actuated / seen` is a LOWER BOUND ON BREADTH, not a percentage of the app. Three reasons
 * it is not a coverage figure: a control can only be seen once some surface exposing it has
 * been opened, so the denominator itself grows with exploration and closed panels contribute
 * nothing; operating a control is not the same as understanding it; and controls that share
 * a role, label and surface collapse into one entry.
 */
export interface AppMapCoverage {
	/** Distinct interactive controls observed across the pass. */
	seen: number;
	/** ...that the pass operated at least once. */
	actuated: number;
	/** ...that it deliberately declined to operate. */
	dismissed: number;
	/** Distinct containing surfaces those controls were found in. */
	surfaces: number;
	/** Context resets. See the chapter logic in src/explore.ts. */
	chapters: number;
	/** frontier-empty | action-ceiling | frontier-conceded | error */
	stopped: string;
	/** Deduped reasons given for dismissals — why the skipped controls were skipped. */
	dismissals?: string[];
	/** Gated controls whose boundary surface was read under descent (see AppMap.gated). */
	gatedRead?: number;
	/** Gated controls refused outright — externality, or descent off. */
	gatedRefused?: number;
}

/**
 * What was seen at the point a guarded descent stopped.
 *
 * The map used to record only that a destructive-labelled control EXISTS ("Export: refused,
 * unmapped"), which is indistinguishable from "not in this app". A boundary record is the
 * difference between a hole and a boundary: it says what the flow offers and why the pass
 * went no further, so a task agent given a delete/export task has grounding instead of a
 * dead end, and the safety line is auditable the way `dismissals` already is.
 */
export interface GatedBoundary {
	/** Node id of the gated control, matching `nodes` when the pass recorded one. */
	id: string;
	settingKey?: string;
	/**
	 * How far the pass went. 0 = refused at the label (externality, or descent off);
	 * 1 = the opening press ran, the boundary surface was read, and Escape restored.
	 * Higher tiers (reversible mutation, scratch-and-commit) are not implemented yet;
	 * the field is numeric so maps stay readable when they are.
	 */
	tierReached: 0 | 1;
	/** What the boundary surface said: danger copy, option labels, external host. */
	boundary: string;
	/** Why the pass stopped there, e.g. "externality:oauth-window" or "descent:read-and-escape". */
	stoppedBecause: string;
	/** Whether the descent operated on content the pass created (claimed scratch). */
	scratchUsed: boolean;
}

/**
 * Where a run should start, declared by the exploration pass.
 *
 * This is a TEST FIXTURE, not grounding: it is read by the harness to put the app in a known
 * state before a run, the way a test resets a database, and it is never shown to the task
 * agent. Keeping it out of the prompt is what lets a grounded and an ungrounded run start from
 * the same place and stay comparable.
 *
 * It has to be declared rather than derived. Every structural signal in the graph picks the
 * wrong node: on Yarn the correct home ("Library") is the SMALLEST labelled subtree at 9 nodes,
 * because exploration spends its time in configuration surfaces, while subtree size picks the
 * editor at 77 — a document, and the most stateful place a run could possibly begin.
 */
export interface AppMapHome {
	/** Node id of the surface a run should start on. */
	surface: string;
	/** Label of the control that navigates there, matched against observed element labels. */
	control: string;
	/** What should be on screen once it is reached, for the run log. */
	description: string;
	/**
	 * Where this declaration came from. "explore" is a live pass that operated the app;
	 * "backfill" (src/home.ts) derived it from the graph a pass already wrote, which is checked
	 * against the same evidence but cannot notice that the map itself is wrong. Absent on the
	 * first maps to carry a home at all; read it as "explore".
	 */
	source?: "explore" | "backfill";
}

export interface AppMap {
	app: string;
	capturedAt: string;
	/** "explore" only — same provenance rule as the prose map. */
	provenance: "explore";
	/** sha256 prefix of the prose map written in the same pass, pairing the two artifacts. */
	proseSha256?: string;
	/** Wall-clock the pass took, e.g. "1h07m". The grounding budget is per-app, so the cost
	 *  of producing this map has to travel with it rather than living only in a console log. */
	elapsed?: string;
	coverage?: AppMapCoverage;
	/** Absent on maps written before exploration recorded one; the harness degrades. */
	home?: AppMapHome;
	nodes: AppMapNode[];
	edges: AppMapEdge[];
	/** Boundary reads from guarded descent. Absent on maps from passes without EXPLORE_DESCENT. */
	gated?: GatedBoundary[];
}
