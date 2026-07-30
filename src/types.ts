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
	nodes: AppMapNode[];
	edges: AppMapEdge[];
}
