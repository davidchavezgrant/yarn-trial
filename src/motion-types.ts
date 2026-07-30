/**
 * Shared types for the cursor humanization pass.
 *
 * A run's recording contains no cursor: AX/CGEvent actuation never moves the physical pointer
 * (trajectory/cursor.jsonl proves it — 1.2% of samples show any delta, and those are teleports).
 * So the cursor is drawn in post, from a track built out of what the run already recorded.
 *
 * The MotionTrack below is the CLIENT-FACING CONTRACT. Yarn reimposes a synthetic cursor in their
 * own pipeline; this is the handoff format. It is deliberately self-describing — coordinate space
 * and timebase are stated in the file, never left to the reader to infer — because the single
 * biggest failure mode is a consumer assuming track time aligns with the original recording's
 * clock when the track has been retimed.
 */

/** Cursor vocabulary, taken from the dataset's own `cursorType` values rather than invented. */
export type CursorType =
	| "arrow"
	| "pointingHand"
	| "iBeam"
	| "closedHand"
	| "openHand"
	| "resizeLeftRight"
	| "operationNotAllowed";

/** One cursor position sample in the output timeline. */
export interface CursorSample {
	/** Milliseconds in the OUTPUT timeline (see TrackTimeline.timebase). */
	tMs: number;
	/** Window-local pixels, matching TrackSpace.width/height. */
	x: number;
	y: number;
	type: CursorType;
}

export type TrackEvent =
	| { tMs: number; kind: "mousedown" | "mouseup"; button: "primary" | "secondary"; x: number; y: number; sourceTMs?: number; stepIndex?: number }
	/** One synthesized keystroke. `char` is absent for non-character keys (delete, return, ...). */
	| { tMs: number; kind: "key"; keyType: string; char?: string; holdMs: number; sourceTMs?: number; stepIndex?: number }
	/**
	 * A text mutation the agent performed atomically (set_value). Declared, never animated:
	 * faking a typing animation over an atomic write invents evidence, which cuts against this
	 * repo's whole verification posture.
	 */
	| { tMs: number; kind: "textReveal"; reveal: "typed" | "atomic"; text: string; sourceTMs?: number; stepIndex?: number };

/**
 * Coordinate space of every x/y in the track.
 *
 * Measured 2026-07-30: trajectory/turn-*&#47;before.png is the WINDOW at higher resolution, not a
 * display capture — aspect ratio matches the polled frames within 0.06% across all 14 recordings
 * on disk, and downscaling before.png to frame size differences to meanAbsDiff 0.000-0.002 on
 * non-Retina runs. So driver click_point values are window-local and convert with a single ratio:
 * `framePx = click_point * (frameWidth / captureWidth)`. Verified visually: click_point
 * (1346.5, 270) * (1568/1920) = (1100, 220) lands exactly on the clicked combobox.
 */
export interface TrackSpace {
	coords: "window-local-pixels";
	/** Output frame size — the space every x/y in this track lives in. */
	width: number;
	height: number;
	/** The higher-resolution capture those coordinates were converted FROM. */
	sourceCapture: { width: number; height: number; scale: number };
}

export interface TrackTimeline {
	/**
	 * "output" means tMs is the RENDERED timeline, which is retimed and does NOT align with the
	 * original recording. Every event also carries sourceTMs (ms from driver session start) for
	 * anyone needing to get back to the real clock.
	 */
	timebase: "output";
	fps: number;
	durationMs: number;
	retimed: boolean;
}

/** Which source frame is held over which span of the output timeline. */
export interface FramePlanEntry {
	/**
	 * Index into the USABLE frame list, after malformed frames are dropped.
	 *
	 * `frameFile` is the authoritative reference — a bare index only agrees with the renderer if it
	 * filters the directory identically, and it did not: the renderer re-listed every png while the
	 * plan was built from the filtered set, so each entry pointed at the wrong frame.
	 */
	frameIndex: number;
	/** Filename within frames/, e.g. "f-00042.png". */
	frameFile?: string;
	/** Output-timeline span this frame is displayed for. */
	startMs: number;
	endMs: number;
	/** True when this span covers an action; false for a compressed thinking gap. */
	action: boolean;
}

/**
 * A control the cursor is resting on, and the span it should look hovered for.
 *
 * The recording almost never contains a real hover: the agent actuates through the accessibility
 * API, which does not move the physical pointer, so the app receives no mouseover and paints no
 * highlight. Measured on one run, the real pointer was inside the app window in 12 of 164 frames.
 * Left alone, the rendered cursor sits on a control that never lights up, which reads as the
 * cursor not really being there.
 *
 * Bounds come from the step's own `targetRect`, so this highlights the control the agent actually
 * addressed rather than guessing from the cursor position.
 */
export interface HoverSpan {
	startMs: number;
	endMs: number;
	/** Control bounds in the same window-local pixels as everything else in the track. */
	x: number;
	y: number;
	w: number;
	h: number;
	stepIndex?: number;
}

export interface MotionTrack {
	schema: "yarn-motion-track/v1";
	run: { stamp: string; app: string; task: string; runLog: string };
	space: TrackSpace;
	timeline: TrackTimeline;
	cursor: CursorSample[];
	events: TrackEvent[];
	framePlan: FramePlanEntry[];
	/** Where a hover highlight should be painted, because the app did not paint one itself. */
	hovers: HoverSpan[];
	/** The fitted constants used to build this track, embedded verbatim for provenance. */
	constants: MotionConstants;
}

/**
 * Constants fitted from data/cursor-keyboard-dataset-2026-07-30 (113 recordings, 4.6 hours,
 * 365k events, 8 creators). Regenerated by scripts/fit-motion.py; committed as
 * data/motion-constants.json so the render path never needs the 82MB corpus.
 */
export interface MotionConstants {
	fittedFrom: { dataset: string; recordings: number; movementEvents: number; generatedAt: string };
	/** Empirical move-duration distribution, keyed by floor(log2(distancePx)). */
	durationByLogDistance: Record<string, { p10: number; p50: number; p90: number; n: number }>;
	/** Click press-to-release, milliseconds. */
	clickDwellMs: { p10: number; p50: number; p90: number };
	/** Inter-key interval, milliseconds. */
	ikiMs: { p10: number; p25: number; p50: number; p75: number; p90: number; p99: number };
	/** Median IKI following a space, which runs slower than mid-word. */
	ikiAfterSpaceMs: number;
	keyHoldMs: number;
	/** Fraction of keypresses that are corrections (delete). */
	correctionRate: number;
	/** Max perpendicular deviation from the straight line, as a fraction of movement distance. */
	perpDeviationFrac: { p50: number; p75: number; p90: number };
	/** Peak instantaneous speed over mean speed within one movement. */
	peakSpeedRatio: { p10: number; p50: number; p90: number };
	/** Fraction of mid-flight samples below 5% of mean speed. */
	nearStoppedFrac: { p50: number; p90: number };
	/** Source sampling rate of the corpus. */
	sampleHz: number;
}

/**
 * One real human approach movement, normalized so it can be replayed onto a different pair of
 * endpoints. Stored in data/motion-segments.json.
 *
 * `par`/`perp`/`t` are parallel arrays. `par` is distance along the start->end axis as a fraction
 * of total distance; `perp` is deviation across that axis, same unit. `t` is milliseconds from
 * movement start, KEPT AS RECORDED — renormalizing duration to a per-distance median would erase
 * the 3-5x cross-movement speed variance that makes replay worth doing.
 */
export interface MotionSegment {
	/** floor(log2(distancePx)) of the source movement. */
	logDistance: number;
	/** Direction octant 0-7 of the source movement, so replay picks a plausible curve shape. */
	octant: number;
	/** Source movement distance in pixels, for reference/debugging. */
	distancePx: number;
	durationMs: number;
	par: number[];
	perp: number[];
	t: number[];
	/** Press-to-release of the click that terminated this movement, when present. */
	dwellMs?: number;
	cursorType: CursorType;
}

export interface MotionSegmentLibrary {
	fittedFrom: { dataset: string; generatedAt: string };
	segments: MotionSegment[];
}
