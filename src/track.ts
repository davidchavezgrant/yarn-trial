/**
 * Build a humanized cursor motion track from a finished run.
 *
 * A recording contains no cursor. AX and foreground-CGEvent actuation never move the physical
 * pointer — trajectory/cursor.jsonl proves it, with 1.2% of samples showing any delta at all and
 * those being instant teleports of up to 1350px. So the cursor is drawn in post, and the raw
 * material is what the run already wrote down: where each action landed and when.
 *
 * WHY REPLAY REAL MOVEMENT INSTEAD OF SYNTHESIZING IT. Measured over 913 approach movements in
 * data/cursor-keyboard-dataset-2026-07-30, human pointer motion is wrong in three independent ways
 * from the obvious model (symmetric minimum-jerk along a straight line):
 *
 *   - It is ASYMMETRIC. Median cumulative distance is 51% at t=0.2 and 90% at t=0.5 — a ballistic
 *     launch followed by a long settle, not a smooth arc.
 *   - It is not SMOOTH. Peak instantaneous speed is a median 9.15x the mean, and 30% of mid-flight
 *     samples sit below 5% of mean speed. There is hesitation and micro-correction in the middle
 *     of a single movement.
 *   - It is not STRAIGHT. Max perpendicular deviation is a median 7.6% of the movement distance.
 *
 * And duration barely follows from distance: within one distance bucket, p90/p10 spreads 3-5x, so
 * Fitts's law fits at R^2=0.09. Reproducing all of that convincingly is a lot of tuning; replaying
 * a real segment gets it for free. Synthesis remains as the fallback for geometry the corpus does
 * not cover, and it has to reproduce all three properties explicitly — see synthesizeMove().
 */

import fs from "node:fs";
import path from "node:path";
import type {
	CursorSample,
	CursorType,
	FramePlanEntry,
	HoverSpan,
	MotionConstants,
	MotionSegment,
	MotionSegmentLibrary,
	MotionTrack,
	TrackEvent,
} from "./motion-types.js";

/** Output frame rate. Human motion needs far more than the ~0.9fps the capture loop achieves. */
export const FPS = 60;

/**
 * A thinking gap collapses to this. Most of a run's wall clock is the model deciding what to do,
 * during which the screen is frozen; Yarn's own pipeline speeds these up too, but the artifact has
 * to stand on its own.
 *
 * Long enough to read. Once identical gap frames are collapsed, a run reduces to about a dozen
 * distinct screens, and at a shorter beat they went past faster than a viewer could follow — the
 * compression stopped being invisible and became the thing you noticed.
 */
export const GAP_BEAT_MS = 900;

/** Kept at real duration around each action, so the app's own response reads at true speed. */
export const PRE_ACTION_MS = 300;
export const POST_ACTION_MS = 500;

/**
 * How long after an action its consequences are still considered part of it.
 *
 * Longer than POST_ACTION_MS, which governs playback speed: this governs which captures survive at
 * all, and an app can take a second or two to finish a navigation.
 */
export const THINK_SETTLE_MS = 2500;

/**
 * Ceiling on an action frame's screen time.
 *
 * The capture loop pauses while the driver acts, so the frame covering an action also covers the
 * model's think leading up to it — often ten seconds or more. Without a cap, "preserve real timing
 * around actions" silently preserves the thinking too, and the retimed cut is barely shorter than
 * the raw one.
 */
export const ACTION_MAX_MS = 2500;

/**
 * Shortest movement that replays a corpus segment.
 *
 * scripts/fit-motion.py keeps only movements of 50px or more, so the library has nothing to say
 * about a nudge between adjacent controls; below this, synthesis handles it.
 */
export const MIN_REPLAY_PX = 60;

/**
 * Reject a corpus segment that wanders further off-axis than this multiple of its own distance.
 *
 * 149 of 1895 fitted segments exceed it, up to 13x — they are real, but they are the user drifting
 * across the screen and happening to click, not reaching for a target. Replayed onto a deliberate
 * agent action they read as the pointer getting lost.
 */
export const MAX_REPLAY_PERP = 0.6;

/** How far outside its own rect a click may fall before the rect is treated as stale. */
export const HOVER_SLOP_PX = 12;

/**
 * Correct a click point against the pixels that actually changed.
 *
 * AX geometry is not always current. One run's tree carried TWO "Save Changes" buttons and the
 * agent pressed the offscreen one, so the driver's click_point AND the recorded rect both landed
 * 41px above the visible button — agreeing with each other and wrong together, which no
 * consistency check between them can catch. The before/after diff is independent of both.
 *
 * Deliberately conservative: it only moves the point when the change is small enough to be one
 * control, and only far enough to reach it. A navigation repaints most of the window and is left
 * alone, because the changed region then says nothing about where the pointer was.
 */
export function correctToChange(
	point: { x: number; y: number },
	change: { x: number; y: number; w: number; h: number } | undefined,
	frame: { width: number; height: number },
): { x: number; y: number } {
	if (!change || change.w <= 0 || change.h <= 0) return point;
	const area = (change.w * change.h) / (frame.width * frame.height);
	if (area > MAX_CORRECTION_AREA) return point;
	const inside =
		point.x >= change.x && point.x <= change.x + change.w && point.y >= change.y && point.y <= change.y + change.h;
	if (inside) return point;
	const cx = change.x + change.w / 2;
	const cy = change.y + change.h / 2;
	if (Math.hypot(cx - point.x, cy - point.y) > MAX_CORRECTION_PX) return point;

	return { x: cx, y: cy };
}

/** A changed region larger than this fraction of the frame is a navigation, not one control. */
export const MAX_CORRECTION_AREA = 0.02;

/** Never move a click point further than this; beyond it the pairing is a guess. */
export const MAX_CORRECTION_PX = 120;

/** A driver turn, as recorded in trajectory/turn-NNNNN/action.json. */
export interface TrajectoryTurn {
	tool: string;
	arguments: Record<string, unknown>;
	clickPoint?: { x: number; y: number };
	/** Milliseconds from driver session start to dispatch, and to completion. */
	startMs: number;
	endMs: number;
	/** Unix epoch milliseconds. The file stores this as a seconds STRING, not ISO. */
	epochMs: number;
	dir: string;
	/**
	 * Width of THIS turn's before.png, the space its click_point lives in.
	 *
	 * Per-turn because it genuinely varies within one run: a window moved between displays mid-run
	 * produced captures of 2560, 1570, 1920 and 3456 px wide across ten turns. Taking the first
	 * turn's width as the run's scale put later clicks hundreds of pixels off target.
	 */
	captureWidth?: number;
	/** The driver warned this element does not advertise AXPress; the click may have no-opped. */
	warned?: boolean;
	/** Region that changed between before.png and after.png, in this turn's capture pixels. */
	changeBox?: { x: number; y: number; w: number; h: number };
}

/** The subset of a run log this pass reads. */
export interface RunLogStep {
	index: number;
	timestamp: string;
	action: { kind: string; name?: string; args?: Record<string, unknown> };
	targetRole?: string;
	targetRect?: { x: number; y: number; w: number; h: number };
	/** Fraction of pixels that changed after this action. 0 means the screen did not react. */
	pixelDelta?: number;
	/** Did the step's own expectation hold? False plus a driver warning means a no-op. */
	verified?: boolean;
}

export interface JoinedAction {
	step?: RunLogStep;
	turn: TrajectoryTurn;
}

/**
 * Read every turn in a recording's trajectory, in order.
 *
 * `start_session` turns are dropped: src/driver.ts re-declares the session every 90s to outrun the
 * driver's 300s absolute lifetime, so those heartbeats are interleaved with real actions and would
 * otherwise offset the join against the run log by a growing amount on any long run.
 */
/** Width from a PNG's IHDR header, avoiding an image-decoding dependency for four bytes. */
function pngWidth(file: string): number | undefined {
	if (!fs.existsSync(file)) return undefined;
	const buf = Buffer.alloc(4);
	const fd = fs.openSync(file, "r");
	fs.readSync(fd, buf, 0, 4, 16);
	fs.closeSync(fd);

	return buf.readUInt32BE(0) || undefined;
}

export function readTrajectory(recordingDir: string): TrajectoryTurn[] {
	const trajectoryDir = path.join(recordingDir, "trajectory");
	if (!fs.existsSync(trajectoryDir)) return [];
	const turns: TrajectoryTurn[] = [];
	for (const name of fs.readdirSync(trajectoryDir).sort()) {
		if (!name.startsWith("turn-")) continue;
		const dir = path.join(trajectoryDir, name);
		const file = path.join(dir, "action.json");
		if (!fs.existsSync(file)) continue;
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		if (raw.tool === "start_session") continue;
		turns.push({
			tool: raw.tool,
			arguments: raw.arguments ?? {},
			clickPoint: raw.click_point ? { x: raw.click_point.x, y: raw.click_point.y } : undefined,
			startMs: raw.t_start_ms_from_session_start ?? 0,
			endMs: raw.t_ms_from_session_start ?? 0,
			// Seconds as a string — NOT the ISO-8601 the run log's own `timestamp` field uses.
			epochMs: Math.round(Number(raw.timestamp) * 1000),
			dir,
			captureWidth: pngWidth(path.join(dir, "before.png")),
			// The driver warns when an element does not advertise AXPress. Usually the click works
			// anyway, but when it does not the frames show nothing happening — and animating a
			// deliberate reach into a control that never responded is the most misleading thing
			// this pass can do. Paired with a zero pixel delta below, it is a confirmed no-op.
			warned: /does not advertise/i.test(String(raw.result_summary ?? "")),
		});
	}

	return turns;
}

/**
 * Pair run-log steps with driver turns.
 *
 * Both are ordered records of the same actions, but neither is a subset of the other: the run log
 * omits turns the driver recorded outside a step (the initial observation's window query), and a
 * step whose driver call failed produces no turn. So this walks both in order and matches on tool
 * name, rather than zipping by position — a single unmatched entry would otherwise shift every
 * later pairing and silently attach each action's motion to the wrong target.
 */
export function joinSteps(steps: RunLogStep[], turns: TrajectoryTurn[]): JoinedAction[] {
	const joined: JoinedAction[] = [];
	let si = 0;
	for (const turn of turns) {
		let match: RunLogStep | undefined;
		for (let probe = si; probe < steps.length; probe++) {
			const name = steps[probe].action.name ?? steps[probe].action.kind;
			if (name !== turn.tool) continue;
			/**
			 * Tool name alone is not enough to pair on. Almost every action in a run is a click, so
			 * a turn the run log never recorded — a retried click, an action that failed before the
			 * step was written — silently consumed the NEXT step, shifting every later pairing by
			 * one. Observed on a real run: a no-op press on an unlabelled image took the following
			 * step's target, so its rect and role described a control it never touched.
			 *
			 * The element index is the same value on both sides and is exact, so it disambiguates
			 * where the name cannot. Falling back to the name keeps coordinate-addressed actions
			 * and older logs working.
			 */
			const stepEl = steps[probe].action.args?.element_index;
			const turnEl = turn.arguments.element_index;
			if (stepEl !== undefined && turnEl !== undefined && stepEl !== turnEl) continue;
			match = steps[probe];
			si = probe + 1;
			break;
		}
		joined.push({ step: match, turn });
	}

	return joined;
}

/**
 * Convert a driver click point into output-frame pixels.
 *
 * Measured 2026-07-30: trajectory before.png is the WINDOW at higher resolution, not a display
 * capture. Its aspect ratio matches the polled frames within 0.06% on all 14 recordings on disk,
 * and downscaling it to frame size differences to meanAbsDiff 0.000-0.002 on non-Retina runs. So
 * one ratio converts, with no origin to subtract. Verified visually: (1346.5, 270) on a 1920-wide
 * capture maps to (1100, 220) on a 1568-wide frame, landing exactly on the clicked combobox.
 */
export function toFramePixels(
	point: { x: number; y: number },
	captureWidth: number,
	frameWidth: number,
): { x: number; y: number } {
	const scale = captureWidth > 0 ? frameWidth / captureWidth : 1;

	return { x: point.x * scale, y: point.y * scale };
}

/** Where an action puts the pointer, in capture-space pixels. Undefined for keyboard-only actions. */
export function actionPoint(turn: TrajectoryTurn): { x: number; y: number } | undefined {
	if (turn.clickPoint) return turn.clickPoint;
	// Drags carry their geometry in arguments rather than click_point; the pointer ends at the
	// release point.
	const a = turn.arguments;
	if (typeof a.to_x === "number" && typeof a.to_y === "number") return { x: a.to_x, y: a.to_y };

	return undefined;
}

/** Pointer type for a target, using the dataset's own cursorType vocabulary. */
export function pointerTypeForRole(role: string | undefined): CursorType {
	if (role === "AXTextField") return "iBeam";
	if (role === "AXButton" || role === "AXLink" || role === "AXPopUpButton" || role === "AXMenuItem") return "pointingHand";
	if (role === "AXCheckBox" || role === "AXRadioButton" || role === "AXComboBox") return "pointingHand";

	return "arrow";
}

/** Deterministic PRNG. Runs must re-render identically, so Math.random is not an option. */
export function makeRandom(seed: number): () => number {
	let s = seed >>> 0 || 1;

	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;

		return s / 0x100000000;
	};
}

/** Sample from a p10/p50/p90 summary by piecewise-linear interpolation of the quantiles. */
export function samplePercentile(q: { p10: number; p50: number; p90: number }, r: number): number {
	if (r <= 0.1) return q.p10;
	if (r >= 0.9) return q.p90;
	if (r < 0.5) return q.p10 + ((r - 0.1) / 0.4) * (q.p50 - q.p10);

	return q.p50 + ((r - 0.5) / 0.4) * (q.p90 - q.p50);
}

const TAU = Math.PI * 2;

/** Direction octant 0-7, matching the bucketing scripts/fit-motion.py uses. */
export function octantOf(dx: number, dy: number): number {
	const angle = (Math.atan2(dy, dx) + TAU) % TAU;

	return Math.floor((angle / TAU) * 8) % 8;
}

/**
 * Pick a corpus segment for a movement, preferring the same distance scale and direction.
 *
 * Direction is relaxed before distance: a curve's shape is dominated by how far the hand travelled,
 * and an octant mismatch is corrected by the rotation in warpSegment() anyway.
 */
export function pickSegment(
	library: MotionSegment[],
	distancePx: number,
	octant: number,
	rand: () => number,
): MotionSegment | undefined {
	// The corpus was filtered to movements of at least 50px, so nothing in it describes a short
	// nudge between adjacent controls. Replaying a long reach's shape across 20px scales its
	// wander up to many times the distance — measured at 150% on a real run, a visible loop where
	// the pointer should barely twitch. Below the corpus floor, synthesis is the honest answer.
	if (library.length === 0 || distancePx < MIN_REPLAY_PX) return undefined;
	const logDistance = Math.floor(Math.log2(Math.max(distancePx, 1)));
	const usable = library.filter((s) => maxPerp(s) <= MAX_REPLAY_PERP);
	const tiers = [
		usable.filter((s) => s.logDistance === logDistance && s.octant === octant),
		usable.filter((s) => s.logDistance === logDistance),
		usable.filter((s) => Math.abs(s.logDistance - logDistance) <= 1),
	];
	for (const tier of tiers) if (tier.length > 0) return tier[Math.floor(rand() * tier.length)];

	return undefined;
}

/**
 * Yarn's editor cursor pipeline, replicated.
 *
 * `getSmoothedCursorData.js` keeps every third raw sample and drives a position spring toward each
 * survivor at mass 1 / stiffness 170 / damping 26 — critically damped, zeta ~= 1.0. These are the
 * default brand values and are configurable per brand
 * (`orgBrand.screenVideoStyle.cursorSmoothingConfig`), so a customer with different values gets
 * different rendered motion from identical input.
 */
export const SPRING = { mass: 1, stiffness: 170, damping: 26 };
export const DECIMATION = 3;

/** Frames over which the lagging spring is eased onto the exact click point. */
const SETTLE_FRAMES = 6;

/**
 * How soon after finishing an action the pointer starts moving to the next target.
 *
 * The pointer should not sit on a control it has already clicked while the app navigates away
 * from it. Long enough to read as a deliberate pause, short enough that the idle time lands at
 * the destination instead.
 */
export const DEPART_AFTER_MS = 250;

/** Ceiling on how long the pointer waits at its destination before clicking. */
export const MAX_LINGER_MS = 900;

/** Below this a frame counts as motionless, for trimming the spring's spin-up. Pixels. */
const STILL_PX = 0.5;

/**
 * Run a path through the editor's decimate-then-spring pipeline, resampled to `fps`.
 *
 * This is what turns input-shaped motion into what a viewer sees. Integrated with a fixed
 * sub-step rather than one step per output frame, because a 60fps step at stiffness 170 is close
 * enough to the stability limit that the result visibly depends on frame rate.
 */
export function springSmooth(
	path: Array<{ tMs: number; x: number; y: number }>,
	fps: number,
): Array<{ tMs: number; x: number; y: number }> {
	if (path.length < 2) return path;
	const targets = path.filter((_, i) => i % DECIMATION === 0 || i === path.length - 1);
	const durationMs = path[path.length - 1].tMs;
	const stepMs = 1;
	const out: Array<{ tMs: number; x: number; y: number }> = [];
	let x = targets[0].x;
	let y = targets[0].y;
	let vx = 0;
	let vy = 0;
	let next = 0;
	const frameMs = 1000 / fps;
	for (let t = 0; t <= durationMs; t += stepMs) {
		while (next + 1 < targets.length && targets[next + 1].tMs <= t) next++;
		const tx = targets[next].x;
		const ty = targets[next].y;
		const dt = stepMs / 1000;
		const ax = (SPRING.stiffness * (tx - x) - SPRING.damping * vx) / SPRING.mass;
		const ay = (SPRING.stiffness * (ty - y) - SPRING.damping * vy) / SPRING.mass;
		vx += ax * dt;
		vy += ay * dt;
		x += vx * dt;
		y += vy * dt;
		if (out.length === 0 || t - out[out.length - 1].tMs >= frameMs) out.push({ tMs: t, x, y });
	}
	// Drop the spin-up. The spring starts at rest and takes a few frames to reach the first
	// target, which shows up as a handful of near-motionless frames at the head of every reach —
	// 18% of samples against 0% in the corpus, because a real segment is cut from a pointer
	// already in motion, not launched from a standstill.
	while (out.length > 2 && Math.hypot(out[1].x - out[0].x, out[1].y - out[0].y) < STILL_PX) out.shift();
	const t0 = out.length > 0 ? out[0].tMs : 0;
	for (const s of out) s.tMs -= t0;
	// The spring lags its target by design, so it is still short of the goal when the input path
	// ends. The click must land on the control, so the tail is eased onto it across the last few
	// frames. Snapping the final sample instead leaves a one-frame jump that reads as a speed
	// spike — it put peak/mean at 3.4 against the corpus's 2.5.
	const end = path[path.length - 1];
	const tail = Math.min(SETTLE_FRAMES, out.length);
	for (let i = 0; i < tail; i++) {
		const s = out[out.length - tail + i];
		const w = (i + 1) / tail;
		s.x += (end.x - s.x) * w;
		s.y += (end.y - s.y) * w;
	}
	if (out.length > 0) {
		out[out.length - 1].x = end.x;
		out[out.length - 1].y = end.y;
	}

	return out;
}

/**
 * Scatter the landing point inside the control instead of hitting its exact centre.
 *
 * Every click resolving to a mathematical centre is the single most machine-like thing left in the
 * output — real clicks are distributed across a target, biased slightly toward the middle but
 * rarely on it. The offset is drawn from a triangular distribution (the average of two uniforms),
 * so most landings sit near the centre and the occasional one is near an edge.
 *
 * Bounded well inside the rect: this must never move a click off the control it is meant to hit,
 * and a click point the driver placed off-centre for its own reasons is only nudged, not recentred.
 */
export function jitterWithin(
	point: { x: number; y: number },
	rect: { x: number; y: number; w: number; h: number } | undefined,
	rand: () => number,
): { x: number; y: number } {
	if (!rect || rect.w <= 0 || rect.h <= 0) return point;
	const spread = (extent: number): number => {
		const room = Math.max(0, extent / 2 - CLICK_EDGE_MARGIN_PX);

		return (rand() + rand() - 1) * Math.min(room, extent * CLICK_JITTER_FRAC);
	};
	const x = point.x + spread(rect.w);
	const y = point.y + spread(rect.h);

	return {
		x: Math.min(Math.max(x, rect.x + CLICK_EDGE_MARGIN_PX), rect.x + rect.w - CLICK_EDGE_MARGIN_PX),
		y: Math.min(Math.max(y, rect.y + CLICK_EDGE_MARGIN_PX), rect.y + rect.h - CLICK_EDGE_MARGIN_PX),
	};
}

/** Landing scatter, as a fraction of the control's size. */
export const CLICK_JITTER_FRAC = 0.28;

/** Never land closer than this to a control's edge. */
export const CLICK_EDGE_MARGIN_PX = 3;

/**
 * When a movement first crosses into a rect, in ms from the movement's own start.
 *
 * Falls back to the movement's end if it never enters — the caller has already checked that the
 * click point agrees with the rect, so that means the approach came in from an odd angle rather
 * than that the rect is wrong.
 */
export function enterTime(
	move: Array<{ tMs: number; x: number; y: number }>,
	rect: { x: number; y: number; w: number; h: number },
): number {
	for (const p of move)
		if (p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h) return p.tMs;

	return move.length > 0 ? move[move.length - 1].tMs : 0;
}

/** Largest excursion off the straight line, as a fraction of the movement's distance. */
function maxPerp(segment: MotionSegment): number {
	let m = 0;
	for (const v of segment.perp) m = Math.max(m, Math.abs(v));

	return m;
}

/**
 * Replay a corpus segment between two points.
 *
 * A similarity transform — rotate to the new direction, scale uniformly, translate — so the
 * perpendicular deviation scales WITH the movement instead of being flattened. Scaling the two
 * axes independently would straighten long movements and exaggerate short ones.
 *
 * The segment's own timing is kept. Renormalizing duration to a per-distance median is the
 * tempting simplification and it is exactly wrong: the 3-5x spread of durations across movements
 * of equal length is a measured property of human motion, and averaging it away makes every
 * approach in the video move at the same speed.
 */
export function warpSegment(
	segment: MotionSegment,
	from: { x: number; y: number },
	to: { x: number; y: number },
): Array<{ tMs: number; x: number; y: number }> {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const distance = Math.hypot(dx, dy);
	const ux = distance > 0 ? dx / distance : 1;
	const uy = distance > 0 ? dy / distance : 0;
	const out: Array<{ tMs: number; x: number; y: number }> = [];
	for (let i = 0; i < segment.par.length; i++) {
		const along = segment.par[i] * distance;
		const across = segment.perp[i] * distance;
		out.push({
			tMs: segment.t[i],
			x: from.x + ux * along - uy * across,
			y: from.y + uy * along + ux * across,
		});
	}
	// The corpus segment ends where its own click landed; ours must end exactly on target.
	if (out.length > 0) {
		out[out.length - 1].x = to.x;
		out[out.length - 1].y = to.y;
	}

	return out;
}

/**
 * One lognormal stroke's speed contribution at time t.
 *
 * From the Sigma-Lognormal model of the kinematic theory of rapid human movements, as used by
 * Acien et al., "BeCAPTCHA-Mouse: Synthetic Mouse Trajectories and Improved Bot Detection"
 * (arXiv:2005.00890). The motor cortex issues discrete impulses whose speed contributions are
 * lognormal in time; a reach is their sum.
 *
 *   |v_i(t)| = D_i / (sqrt(2pi) * sigma_i * (t - t0_i)) * exp(-(ln(t - t0_i) - mu_i)^2 / (2 sigma_i^2))
 *
 * D is the distance the stroke contributes, t0 its onset, mu the log-temporal delay, sigma the
 * neuromotor impulse response time.
 */
function lognormalStroke(t: number, d: number, t0: number, mu: number, sigma: number): number {
	const dt = t - t0;
	if (dt <= 0) return 0;
	const z = (Math.log(dt) - mu) / sigma;

	return (d / (Math.sqrt(2 * Math.PI) * sigma * dt)) * Math.exp(-0.5 * z * z);
}

/**
 * Generate a movement when the corpus has no comparable segment.
 *
 * Built as a sum of lognormal strokes, then run through the same spring the editor applies.
 *
 * The stroke sum comes from BeCAPTCHA-Mouse (arXiv:2005.00890), whose bot detector's most
 * informative feature is N, the number of lognormal components a trajectory decomposes into: a
 * human reach is one ballistic stroke plus a tail of corrections, not a single eased curve. That
 * structure is what a human hand produces — so it is what belongs on the INPUT side.
 *
 * But the input is not what anyone sees. Yarn's editor decimates to every third sample and drives
 * a critically-damped spring toward the rest, which absorbs most of that structure: measured
 * across the same gestures, submovement peaks fall from a median of 7 raw to 2 rendered, and
 * peak speed from 10.4x the mean to 2.5x. So the strokes go in, the spring takes them out, and
 * what survives is what the viewer gets — matching the smoothed corpus this is fitted against.
 */
export function synthesizeMove(
	from: { x: number; y: number },
	to: { x: number; y: number },
	constants: MotionConstants,
	rand: () => number,
): Array<{ tMs: number; x: number; y: number }> {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const distance = Math.hypot(dx, dy);
	if (distance < 1) return [{ tMs: 0, x: to.x, y: to.y }];
	const logDistance = String(Math.floor(Math.log2(Math.max(distance, 1))));
	const bucket = constants.durationByLogDistance[logDistance];
	const durationMs = bucket
		? samplePercentile(bucket, rand())
		: samplePercentile({ p10: 330, p50: 790, p90: 1760 }, rand());
	const ux = dx / distance;
	const uy = dy / distance;

	// One dominant stroke carrying most of the distance, then corrective strokes that land later
	// and contribute progressively less — the agonist/antagonist activation followed by fine
	// correction the paper describes.
	const strokeCount = 4 + Math.floor(rand() * 4);
	const strokes: Array<{ d: number; t0: number; mu: number; sigma: number }> = [];
	let weight = 1;
	let weightTotal = 0;
	for (let i = 0; i < strokeCount; i++) {
		const share = weight * (0.7 + rand() * 0.6);
		strokes.push({
			d: share,
			// Corrections must land clearly AFTER the launch, not under it. Onsets bunched near the
			// start sum into a single smooth bump, which is the shape this whole function exists to
			// avoid — the strokes have to stay separable in the speed profile to read as distinct
			// submovements.
			t0: i === 0 ? 0 : durationMs * (0.18 + 0.62 * ((i - 0.5) / strokeCount) + rand() * 0.08),
			// Each stroke peaks soon after its own onset; the launch is the long one.
			mu: Math.log(durationMs * (i === 0 ? 0.2 + rand() * 0.12 : 0.03 + rand() * 0.04)),
			// Tight sigma keeps a stroke's energy in its own window instead of smearing across
			// its neighbours.
			sigma: i === 0 ? 0.28 + rand() * 0.12 : 0.14 + rand() * 0.12,
		});
		weightTotal += share;
		weight *= 0.45;
	}
	for (const s of strokes) s.d /= weightTotal;

	const steps = Math.max(8, Math.round((durationMs / 1000) * constants.sampleHz));
	// Integrate the speed profile into cumulative distance, then normalize so the movement covers
	// exactly the distance asked for and lands exactly on target.
	const cumulative: number[] = [0];
	for (let i = 1; i <= steps; i++) {
		const t = (i / steps) * durationMs;
		let speed = 0;
		for (const s of strokes) speed += lognormalStroke(t, s.d, s.t0, s.mu, s.sigma);
		cumulative.push(cumulative[i - 1] + speed);
	}
	const total = cumulative[steps] || 1;

	// Deviation peaks mid-flight and returns to zero at both ends; sign is arbitrary per movement.
	const peak = samplePercentile(
		{ p10: constants.perpDeviationFrac.p50 * 0.5, p50: constants.perpDeviationFrac.p50, p90: constants.perpDeviationFrac.p90 },
		rand(),
	) * distance * (rand() < 0.5 ? -1 : 1);

	const out: Array<{ tMs: number; x: number; y: number }> = [];
	for (let i = 0; i <= steps; i++) {
		const progress = Math.min(1, cumulative[i] / total);
		const along = progress * distance;
		const across = Math.sin(progress * Math.PI) * peak;
		out.push({
			tMs: (i / steps) * durationMs,
			// Whole pixels on the INPUT side: a physical pointer is quantized to the grid, and the
			// corpus of raw events is full of 0px and 1px steps. The spring below turns that back
			// into continuous motion, which is what the rendered corpus actually contains.
			x: Math.round(from.x + ux * along - uy * across),
			y: Math.round(from.y + uy * along + ux * across),
		});
	}
	out[out.length - 1].x = to.x;
	out[out.length - 1].y = to.y;

	return springSmooth(out, constants.sampleHz);
}

/**
 * Per-character keystroke schedule for a typed string.
 *
 * The agent types atomically (one type_text call carrying the whole string), so nothing about
 * per-key timing survives from the run and all of it is synthesized here from the corpus: a
 * lognormal-ish draw around the measured inter-key interval, slower after a space, with occasional
 * corrections that type a wrong character and delete it.
 */
export function keystrokeSchedule(
	text: string,
	constants: MotionConstants,
	rand: () => number,
): Array<{ tMs: number; keyType: string; char?: string; holdMs: number }> {
	const out: Array<{ tMs: number; keyType: string; char?: string; holdMs: number }> = [];
	const iki = constants.ikiMs;
	let t = 0;
	let previous = "";
	for (const ch of text) {
		const r = rand();
		let gap: number;
		if (r < 0.1) gap = iki.p10;
		else if (r < 0.25) gap = iki.p10 + ((r - 0.1) / 0.15) * (iki.p25 - iki.p10);
		else if (r < 0.5) gap = iki.p25 + ((r - 0.25) / 0.25) * (iki.p50 - iki.p25);
		else if (r < 0.75) gap = iki.p50 + ((r - 0.5) / 0.25) * (iki.p75 - iki.p50);
		else if (r < 0.9) gap = iki.p75 + ((r - 0.75) / 0.15) * (iki.p90 - iki.p75);
		else gap = iki.p90 + ((r - 0.9) / 0.1) * (iki.p99 - iki.p90);
		if (previous === " ") gap *= constants.ikiAfterSpaceMs / iki.p50;
		t += gap;
		// A correction types a neighbouring character, pauses, deletes it, and retypes.
		if (rand() < constants.correctionRate && ch !== " ") {
			out.push({ tMs: t, keyType: "character", char: wrongKeyFor(ch), holdMs: constants.keyHoldMs });
			t += iki.p50 + iki.p75;
			out.push({ tMs: t, keyType: "delete", holdMs: constants.keyHoldMs });
			t += iki.p50;
		}
		out.push({
			tMs: t,
			keyType: ch === " " ? "space" : ch === "\n" ? "return" : "character",
			char: ch === "\n" ? undefined : ch,
			holdMs: constants.keyHoldMs,
		});
		previous = ch;
	}

	return out;
}

/** A plausible mistyped character: the physical neighbour on a QWERTY board. */
function wrongKeyFor(ch: string): string {
	const rows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
	const lower = ch.toLowerCase();
	for (const row of rows) {
		const i = row.indexOf(lower);
		if (i < 0) continue;
		const neighbour = row[i + 1] ?? row[i - 1] ?? lower;

		return ch === lower ? neighbour : neighbour.toUpperCase();
	}

	return ch;
}

/**
 * Map the recording's captured frames onto the output timeline.
 *
 * Two kinds of interval. Around an action the real duration is kept, so the app's own response
 * plays at true speed and a viewer can see cause and effect. Everything else is the model
 * thinking against a frozen screen, and collapses to one short beat regardless of whether it took
 * four seconds or forty.
 */
export function buildFramePlan(
	frameTimes: number[],
	actionWindows: Array<{ startEpochMs: number; endEpochMs: number }>,
	frameFiles?: string[],
	keepFrom?: number,
): FramePlanEntry[] {
	if (frameTimes.length === 0) return [];
	/**
	 * A frame's whole INTERVAL is tested for overlap, not just its start instant. The capture loop
	 * pauses while the driver is busy (src/agent.ts skips polling when driverBusy), so an action
	 * lands inside a multi-second gap between two frames rather than near either one — testing the
	 * start instant alone marks every action frame as a thinking gap and compresses away exactly
	 * the moments worth watching.
	 */
	const overlapsAction = (start: number, end: number): boolean =>
		actionWindows.some((w) => start <= w.endEpochMs + POST_ACTION_MS && end >= w.startEpochMs - PRE_ACTION_MS);
	const plan: FramePlanEntry[] = [];
	let outMs = 0;
	for (let i = 0; i < frameTimes.length; i++) {
		// Frames from before the take, alongside the actions that produced them.
		if (keepFrom !== undefined && frameTimes[i] < keepFrom) continue;
		const realMs = i + 1 < frameTimes.length ? frameTimes[i + 1] - frameTimes[i] : GAP_BEAT_MS;
		const action = overlapsAction(frameTimes[i], frameTimes[i] + realMs);
		const shown = action
			? Math.min(Math.max(realMs, 1000 / FPS), ACTION_MAX_MS)
			: Math.min(realMs, GAP_BEAT_MS);
		plan.push({ frameIndex: i, ...(frameFiles?.[i] ? { frameFile: frameFiles[i] } : {}), startMs: outMs, endMs: outMs + shown, action });
		outMs += shown;
	}

	return plan;
}

/** Map an epoch instant onto the output timeline built by buildFramePlan. */
export function toOutputMs(plan: FramePlanEntry[], frameTimes: number[], epochMs: number): number {
	if (plan.length === 0) return 0;
	for (let i = 0; i < plan.length; i++) {
		const start = frameTimes[i];
		const end = i + 1 < frameTimes.length ? frameTimes[i + 1] : start + GAP_BEAT_MS;
		if (epochMs < start) return plan[i].startMs;
		if (epochMs <= end) {
			const frac = end > start ? (epochMs - start) / (end - start) : 0;

			return plan[i].startMs + frac * (plan[i].endMs - plan[i].startMs);
		}
	}

	return plan[plan.length - 1].endMs;
}

export interface BuildTrackInput {
	stamp: string;
	app: string;
	task: string;
	runLog: string;
	steps: RunLogStep[];
	turns: TrajectoryTurn[];
	frameTimes: number[];
	/** Epoch ms when recording actually began, so pre-take setup turns can be excluded. */
	recordedFromMs?: number;
	/** Content signature per frame, index-aligned with frameTimes. Identical consecutive frames in
	 *  a thinking gap are collapsed to one. */
	frameHashes?: string[];
	/** Usable frame filenames, index-aligned with frameTimes. Carried into the plan so the
	 *  renderer resolves frames by name instead of re-deriving an index from the directory. */
	frameFiles?: string[];
	frameSize: { width: number; height: number };
	captureSize: { width: number; height: number };
	constants: MotionConstants;
	library: MotionSegmentLibrary;
	seed?: number;
}

/**
 * Assemble the full track: where the cursor is at every output instant, and what it does there.
 *
 * The cursor is placed by working backwards from each action. An action's click point is where the
 * pointer must BE at that action's dispatch time, so the movement toward it is laid down ending at
 * that instant — which is why the pointer arrives and clicks rather than clicking and then
 * arriving.
 */
export function buildTrack(input: BuildTrackInput): MotionTrack {
	const rand = makeRandom(input.seed ?? 0x5eed);
	const allJoined = joinSteps(input.steps, input.turns);

	/**
	 * Decide which actions the take contains BEFORE building the timeline, because dropping an
	 * action means dropping its footage too.
	 *
	 * Skipping only the cursor animation left the frames in place, and those frames are the
	 * action's consequences: a no-op press on an unlabelled image sat in the middle of an in-flight
	 * navigation, so the video flickered between Library and Brand Kit for five seconds with no
	 * pointer doing anything, and the next click appeared to open a page the cursor had not
	 * touched. The frames have to go with the action that produced them.
	 */
	const firstFrameMs = input.frameTimes[0] ?? 0;
	/**
	 * Nothing before the take begins. start_recording backfills turns from earlier in the driver
	 * session, so the home reset's own clicks — navigating out of wherever the LAST run finished —
	 * arrive as the first turns. `recordedFromMs` is stamped by the agent when recording actually
	 * starts; without it the first usable frame is the best available proxy.
	 */
	const startMs = Math.max(firstFrameMs, input.recordedFromMs ?? 0);
	const dropped: Array<{ from: number; to: number }> = [];
	const joined = allJoined.filter(({ step, turn }, i) => {
		// A click the driver warned about that also failed verification is a no-op: the agent
		// pressed something that does not advertise AXPress and the expected result never appeared.
		const noop = turn.warned && step?.verified === false;
		// An action that DISPATCHED before the first frame has no footage of itself, only of its
		// aftermath. Rendering it puts a click at the timeline's very start, against a screen that
		// already shows the result — the pointer appears to click after the fact.
		const noFootage = turn.epochMs - (turn.endMs - turn.startMs) < startMs;
		if (turn.epochMs >= startMs && !noop && !noFootage) return true;
		/**
		 * Its footage runs from dispatch until its consequences have settled — NOT until the next
		 * action dispatches.
		 *
		 * Extending to the next dispatch swallows the whole thinking gap that follows, and that gap
		 * holds the frames showing the state the NEXT action starts from. A dropped pre-recording
		 * reset did exactly that: its window ran 14s to the first real click, taking twelve frames
		 * with it, so the click had no frame at or before it and clamped to the timeline start.
		 */
		const dispatch = turn.epochMs - (turn.endMs - turn.startMs);
		dropped.push({ from: dispatch, to: turn.epochMs + THINK_SETTLE_MS });

		return false;
	});

	const keep = (t: number): boolean => t >= startMs && !dropped.some((d) => t >= d.from && t < d.to);
	/**
	 * Hold one frame through each think instead of playing every capture in it.
	 *
	 * Between actions the app is not idle: it finishes navigations, settles animations, and
	 * sometimes repaints an earlier screen for a beat. The capture loop samples all of it, and
	 * played back at one beat per frame the result is a flicker with no pointer doing anything —
	 * measured on one run, the view alternated between Library and Brand Kit three times in a row,
	 * six seconds after the last click and seven before the next.
	 *
	 * The LAST frame of each gap is the one to keep: it is what the screen had actually settled to
	 * when the next action began. Frames inside an action window are all kept, because that is
	 * where cause and effect have to stay visible.
	 */
	const inAction = (t: number): boolean =>
		joined.some(({ turn }) => {
			const dispatch = turn.epochMs - (turn.endMs - turn.startMs);

			return t >= dispatch - PRE_ACTION_MS && t <= turn.epochMs + THINK_SETTLE_MS;
		});
	const keptTimes: number[] = [];
	const keptFiles: string[] = [];
	for (let i = 0; i < input.frameTimes.length; i++) {
		const t = input.frameTimes[i];
		if (!keep(t)) continue;
		/**
		 * Inside a gap, keep only frames that differ from the one before.
		 *
		 * The capture loop samples on a clock, so most gap frames are byte-identical repeats of a
		 * static screen and cost a beat each for nothing. Dropping every gap frame instead was too
		 * blunt — it removed the app's own response, which arrives seconds after the action while
		 * the model is already thinking, and left a cut that jumped between end states.
		 *
		 * Requires a content signature from the caller; without one, all frames are kept.
		 */
		/**
		 * Always keep the first frame, and any frame an action's dispatch falls after.
		 *
		 * toOutputMs maps an instant onto the plan by finding the frame it lands in, so a dispatch
		 * with no kept frame at or before it clamps to zero — putting the click at the very start
		 * of the video against a screen showing its own aftermath. The frames a dispatch needs are
		 * often the very duplicates this dedup removes, so they have to be exempted explicitly.
		 */
		const nextKept = input.frameTimes.slice(i + 1).find((n) => keep(n));
		const anchorsAction = joined.some(({ turn }) => {
			const dispatch = turn.epochMs - (turn.endMs - turn.startMs);

			// The next KEPT frame, not the next captured one: frames removed above are not in the
			// plan, so a dispatch landing between this frame and a dropped one still needs this
			// frame as its anchor.
			return dispatch >= t && (nextKept === undefined || dispatch < nextKept);
		});
		if (!inAction(t) && !anchorsAction && input.frameHashes && keptTimes.length > 0) {
			const prevIdx = input.frameTimes.indexOf(keptTimes[keptTimes.length - 1]);
			if (prevIdx >= 0 && input.frameHashes[prevIdx] === input.frameHashes[i]) continue;
		}
		keptTimes.push(t);
		if (input.frameFiles?.[i]) keptFiles.push(input.frameFiles[i]);
	}

	const plan = buildFramePlan(
		keptTimes,
		joined.map(({ turn }) => ({
			startEpochMs: turn.epochMs - (turn.endMs - turn.startMs),
			endEpochMs: turn.epochMs,
		})),
		keptFiles.length === keptTimes.length ? keptFiles : undefined,
	);
	// Per-turn capture width, falling back to the run's nominal one. A window that moves between
	// displays mid-run changes the size of the capture its click points are expressed in, so a
	// single run-wide scale silently misplaces every click after the move.
	const toFrame = (p: { x: number; y: number }, captureWidth?: number): { x: number; y: number } =>
		toFramePixels(p, captureWidth ?? input.captureSize.width, input.frameSize.width);

	const cursor: CursorSample[] = [];
	const events: TrackEvent[] = [];
	const hovers: HoverSpan[] = [];
	// Start off-target so the first action is a real approach rather than a jump cut.
	let at = { x: input.frameSize.width * 0.5, y: input.frameSize.height * 0.75 };
	let type: CursorType = "arrow";
	/** End of the previous action, so the pointer can leave it rather than linger. */
	let lastActionMs = 0;
	cursor.push({ tMs: 0, x: at.x, y: at.y, type });

	for (const { step, turn } of joined) {
		const dispatchMs = toOutputMs(plan, keptTimes, turn.epochMs - (turn.endMs - turn.startMs));
		const completeMs = toOutputMs(plan, keptTimes, turn.epochMs);
		const raw = actionPoint(turn);
		// Corrected against the pixels before scaling: the change box is in the same capture space
		// the driver reported the click point in.
		const fixed = raw
			? correctToChange(raw, turn.changeBox, {
					width: turn.captureWidth ?? input.captureSize.width,
					height: Math.round(((turn.captureWidth ?? input.captureSize.width) * input.frameSize.height) / input.frameSize.width),
				})
			: undefined;
		const target = fixed ? jitterWithin(toFrame(fixed, turn.captureWidth), step?.targetRect, rand) : undefined;

		if (target) {
			const distance = Math.hypot(target.x - at.x, target.y - at.y);
			const segment = pickSegment(input.library.segments, distance, octantOf(target.x - at.x, target.y - at.y), rand);
			const move = segment
				? warpSegment(segment, at, target)
				: synthesizeMove(at, target, input.constants, rand);
			const duration = move.length > 0 ? move[move.length - 1].tMs : 0;
			/**
			 * Leave the last control SOON after clicking it, then wait at the next one — rather
			 * than lingering on the old target until it is time to move.
			 *
			 * Anchoring the movement's end to the click meant the pointer sat on the previous
			 * control for the whole model-thinking gap, which reads as broken in two ways: at 23s
			 * of one run the app had navigated to Workflows while the cursor still hovered "Brand
			 * Kit" in the sidebar, and any hover highlight the app HAD painted has long since been
			 * repainted away under a cursor that is still sitting there.
			 *
			 * A person moves when they have decided, then pauses before committing. Departing
			 * shortly after the previous click puts the idle time at the destination, where a
			 * viewer reads it as "about to click this" instead of "stuck on that".
			 */
			const earliest = lastActionMs + DEPART_AFTER_MS;
			// Depart as soon as allowed, and only start later if the move would otherwise overshoot
			// the click. Clamping toward the click instead leaves the whole gap on the OLD control.
			const latest = dispatchMs - duration;
			const moveStart = Math.max(0, Math.min(earliest, Math.max(latest, 0)));
			const nextType = pointerTypeForRole(step?.targetRole);
			for (const m of move) cursor.push({ tMs: moveStart + m.tMs, x: m.x, y: m.y, type });
			type = nextType;
			at = target;
			cursor.push({ tMs: dispatchMs, x: at.x, y: at.y, type });
			/**
			 * Light the control up while the pointer waits on it.
			 *
			 * The app itself almost never does: AX actuation leaves the physical pointer wherever
			 * it was, so no mouseover fires and no highlight is painted — on one run the real
			 * pointer was inside the window for 12 of 164 frames. A cursor resting on a control
			 * that stays inert reads as not really being there.
			 *
			 * Only when the step recorded the control's own rect. Inferring a box from the cursor
			 * position would put a highlight on whatever the pointer happens to overlap, including
			 * nothing at all.
			 */
			/**
			 * Only when the rect actually contains the point the driver clicked.
			 *
			 * AX geometry can be stale or ambiguous: one run's tree carried TWO "Save Changes"
			 * buttons and the agent pressed the offscreen one, so both click_point and targetRect
			 * pointed 41px above the visible button — the highlight landed on blank space beside
			 * the real control. Requiring the rect to agree with the click point catches that
			 * disagreement, and dropping the highlight is better than confidently drawing it in
			 * the wrong place.
			 */
			const rect = step?.targetRect;
			const agrees =
				rect &&
				rect.w > 0 &&
				rect.h > 0 &&
				at.x >= rect.x - HOVER_SLOP_PX &&
				at.x <= rect.x + rect.w + HOVER_SLOP_PX &&
				at.y >= rect.y - HOVER_SLOP_PX &&
				at.y <= rect.y + rect.h + HOVER_SLOP_PX;
			// From the moment the pointer ENTERS the control, not when it finishes settling. A real
			// hover fires on the crossing, and the last stretch of a reach is the slow part —
			// waiting for the movement to end left the highlight visibly late.
			const hoverFrom = moveStart + enterTime(move, rect ?? { x: 0, y: 0, w: 0, h: 0 });
			// The click can precede the pointer's arrival when an action's footage was trimmed, and
			// a span that ends before it starts renders as a permanent highlight.
			if (rect && agrees && completeMs > hoverFrom)
				hovers.push({
					startMs: hoverFrom,
					endMs: completeMs,
					...rect,
					stepIndex: step.index,
				});
		}
		lastActionMs = Math.max(lastActionMs, completeMs);

		if (turn.tool === "click" || turn.tool === "right_click") {
			const dwell = samplePercentile(input.constants.clickDwellMs, rand());
			const button = turn.tool === "right_click" ? "secondary" : "primary";
			events.push({ tMs: dispatchMs, kind: "mousedown", button, x: at.x, y: at.y, sourceTMs: turn.startMs, stepIndex: step?.index });
			events.push({ tMs: dispatchMs + dwell, kind: "mouseup", button, x: at.x, y: at.y, sourceTMs: turn.endMs, stepIndex: step?.index });
		}

		if (turn.tool === "type_text") {
			const text = String(turn.arguments.text ?? "");
			// The reveal spans the action's real duration; the schedule is synthesized because the
			// agent types atomically and no per-key timing was ever recorded.
			for (const k of keystrokeSchedule(text, input.constants, rand))
				events.push({ tMs: dispatchMs + k.tMs, kind: "key", keyType: k.keyType, char: k.char, holdMs: k.holdMs, stepIndex: step?.index });
			events.push({ tMs: dispatchMs, kind: "textReveal", reveal: "typed", text, sourceTMs: turn.startMs, stepIndex: step?.index });
		}

		if (turn.tool === "set_value") {
			// Declared, never animated. The agent wrote this value in one shot; drawing a typing
			// animation over it would depict something that did not happen.
			events.push({
				tMs: completeMs,
				kind: "textReveal",
				reveal: "atomic",
				text: String(turn.arguments.value ?? ""),
				sourceTMs: turn.startMs,
				stepIndex: step?.index,
			});
		}

		if (turn.tool === "press_key") {
			events.push({
				tMs: dispatchMs,
				kind: "key",
				keyType: String(turn.arguments.key ?? "key"),
				holdMs: input.constants.keyHoldMs,
				sourceTMs: turn.startMs,
				stepIndex: step?.index,
			});
		}
	}

	cursor.sort((a, b) => a.tMs - b.tMs);
	events.sort((a, b) => a.tMs - b.tMs);
	const durationMs = plan.length > 0 ? plan[plan.length - 1].endMs : 0;

	return {
		schema: "yarn-motion-track/v1",
		run: { stamp: input.stamp, app: input.app, task: input.task, runLog: input.runLog },
		space: {
			coords: "window-local-pixels",
			width: input.frameSize.width,
			height: input.frameSize.height,
			sourceCapture: {
				width: input.captureSize.width,
				height: input.captureSize.height,
				scale: input.frameSize.width / input.captureSize.width,
			},
		},
		timeline: { timebase: "output", fps: FPS, durationMs, retimed: true },
		cursor,
		events,
		framePlan: plan,
		hovers,
		constants: input.constants,
	};
}
