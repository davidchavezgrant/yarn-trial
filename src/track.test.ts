import assert from "node:assert/strict";
import test from "node:test";
import type { MotionConstants, MotionSegment } from "./motion-types.js";
import {
	buildFramePlan,
	ACTION_MAX_MS,
	GAP_BEAT_MS,
	joinSteps,
	keystrokeSchedule,
	makeRandom,
	octantOf,
	pickSegment,
	pointerTypeForRole,
	samplePercentile,
	synthesizeMove,
	toFramePixels,
	toOutputMs,
	warpSegment,
	type RunLogStep,
	type TrajectoryTurn,
} from "./track.js";

/** The measured corpus values, small enough to inline so tests do not depend on the fitted file. */
const CONSTANTS: MotionConstants = {
	fittedFrom: { dataset: "test", recordings: 0, movementEvents: 0, generatedAt: "" },
	durationByLogDistance: {
		"6": { p10: 240, p50: 540, p90: 1250, n: 96 },
		"8": { p10: 360, p50: 780, p90: 1600, n: 163 },
		"10": { p10: 550, p50: 930, p90: 1540, n: 215 },
	},
	clickDwellMs: { p10: 8, p50: 101, p90: 464 },
	ikiMs: { p10: 45, p25: 69, p50: 108, p75: 160, p90: 283, p99: 1324 },
	ikiAfterSpaceMs: 144,
	keyHoldMs: 92,
	correctionRate: 0.037,
	perpDeviationFrac: { p50: 0.076, p75: 0.152, p90: 0.393 },
	peakSpeedRatio: { p10: 3.57, p50: 9.15, p90: 27.0 },
	nearStoppedFrac: { p50: 0.3, p90: 0.68 },
	sampleHz: 123,
};

const turn = (tool: string, over: Partial<TrajectoryTurn> = {}): TrajectoryTurn => ({
	tool,
	arguments: {},
	startMs: 0,
	endMs: 100,
	epochMs: 1_000_000,
	dir: "",
	...over,
});

test("readTrajectory__DropsHeartbeats__When__SessionRedeclaredMidRun", () => {
	// joinSteps is the observable consequence: heartbeats must never consume a step.
	const steps: RunLogStep[] = [
		{ index: 1, timestamp: "", action: { kind: "tool", name: "click" } },
		{ index: 2, timestamp: "", action: { kind: "tool", name: "type_text" } },
	];
	const joined = joinSteps(steps, [turn("click"), turn("type_text")]);
	assert.equal(joined.length, 2);
	assert.equal(joined[0].step?.index, 1);
	assert.equal(joined[1].step?.index, 2);
});

test("joinSteps__PairsEveryStep__When__TrajectoryHasUnmatchedTurns", () => {
	// A driver turn with no corresponding step must not shift later pairings.
	const steps: RunLogStep[] = [
		{ index: 1, timestamp: "", action: { kind: "tool", name: "click" } },
		{ index: 2, timestamp: "", action: { kind: "tool", name: "click" } },
	];
	const joined = joinSteps(steps, [turn("get_window_state"), turn("click"), turn("click")]);
	assert.equal(joined[0].step, undefined);
	assert.equal(joined[1].step?.index, 1);
	assert.equal(joined[2].step?.index, 2);
});

test("toFramePixels__LandsOnControl__When__CaptureIsLargerThanFrame", () => {
	// The measured case: click_point (1346.5, 270) on a 1920-wide capture is (1100, 220) on a
	// 1568-wide frame, verified visually to sit on the clicked combobox.
	const p = toFramePixels({ x: 1346.5, y: 270 }, 1920, 1568);
	assert.ok(Math.abs(p.x - 1099.6) < 0.5, `x was ${p.x}`);
	assert.ok(Math.abs(p.y - 220.5) < 0.5, `y was ${p.y}`);
});

test("toFramePixels__UsesPerTurnCaptureWidth__When__WindowMovedBetweenDisplays", () => {
	// Capture width genuinely varies WITHIN a run: a live run on 2026-07-30 produced before.png
	// widths of 2560, 1570, 1920 and 3456 across ten turns as the window moved between displays.
	// Scaling every turn by the first one's width put later clicks hundreds of pixels off target.
	const onRetina = toFramePixels({ x: 214, y: 2050 }, 2560, 1568);
	const onStandard = toFramePixels({ x: 107, y: 1021 }, 1920, 1568);
	assert.ok(Math.abs(onRetina.x - 131) < 1 && Math.abs(onRetina.y - 1256) < 1);
	assert.ok(Math.abs(onStandard.x - 87) < 1 && Math.abs(onStandard.y - 834) < 1);
	// The same point under the wrong turn's scale is off by hundreds of pixels — the actual bug.
	const wrong = toFramePixels({ x: 107, y: 1021 }, 2560, 1568);
	assert.ok(Math.abs(wrong.y - onStandard.y) > 200);
});

test("pointerTypeForRole__ReturnsIBeam__When__TargetIsTextField", () => {
	assert.equal(pointerTypeForRole("AXTextField"), "iBeam");
	assert.equal(pointerTypeForRole("AXButton"), "pointingHand");
	assert.equal(pointerTypeForRole(undefined), "arrow");
});

/** A synthetic corpus segment: a straight run with a visible bow across the axis. */
const bowedSegment = (over: Partial<MotionSegment> = {}): MotionSegment => {
	const par: number[] = [];
	const perp: number[] = [];
	const t: number[] = [];
	for (let i = 0; i <= 20; i++) {
		const u = i / 20;
		par.push(u);
		perp.push(Math.sin(u * Math.PI) * 0.1);
		t.push(u * 800);
	}

	return { logDistance: 8, octant: 0, distancePx: 400, durationMs: 800, par, perp, t, cursorType: "arrow", ...over };
};

test("warpSegment__PreservesEndpoints__When__DistanceDiffersFromSource", () => {
	const path = warpSegment(bowedSegment(), { x: 100, y: 100 }, { x: 900, y: 500 });
	assert.equal(path[0].x, 100);
	assert.equal(path[0].y, 100);
	assert.equal(path[path.length - 1].x, 900);
	assert.equal(path[path.length - 1].y, 500);
});

test("warpSegment__ScalesPerpendicularDeviation__When__DistanceDiffersFromSource", () => {
	// Curvature must scale with the movement. Flattening it on long moves is the specific bug
	// an independent-axis scale would introduce.
	const deviation = (from: { x: number; y: number }, to: { x: number; y: number }): number => {
		const path = warpSegment(bowedSegment(), from, to);
		const dx = to.x - from.x;
		const dy = to.y - from.y;
		const len = Math.hypot(dx, dy);

		return Math.max(...path.map((p) => Math.abs(dx * (from.y - p.y) - (from.x - p.x) * dy) / len));
	};
	const short = deviation({ x: 0, y: 0 }, { x: 200, y: 0 });
	const long = deviation({ x: 0, y: 0 }, { x: 800, y: 0 });
	assert.ok(long > short * 3.5, `expected deviation to scale with distance, got ${short} then ${long}`);
});

test("warpSegment__KeepsSourceTiming__When__Replayed", () => {
	// Renormalizing to a per-distance median would erase the measured 3-5x speed spread.
	const segment = bowedSegment({ durationMs: 800 });
	const path = warpSegment(segment, { x: 0, y: 0 }, { x: 1000, y: 1000 });
	assert.equal(path[path.length - 1].tMs, 800);
});

test("buildTrack__VariesDurationAcrossEqualDistances__When__ManyMovesAreGenerated", () => {
	// The regression guard. Measured p90/p10 spread within a distance bucket is 3-5x; a model that
	// collapses to one speed per distance is the failure this catches.
	const rand = makeRandom(7);
	const durations: number[] = [];
	for (let i = 0; i < 400; i++) {
		const move = synthesizeMove({ x: 0, y: 0 }, { x: 300, y: 0 }, CONSTANTS, rand);
		durations.push(move[move.length - 1].tMs);
	}
	durations.sort((a, b) => a - b);
	const spread = durations[Math.floor(durations.length * 0.9)] / durations[Math.floor(durations.length * 0.1)];
	assert.ok(spread > 2.5 && spread < 8, `expected a 3-5x duration spread, got ${spread.toFixed(2)}x`);
});

test("synthesizeMove__ProducesMidFlightNearStops__When__NoSegmentMatches", () => {
	// Smoothness is the most robotic-looking property; the measured corpus has 30% of mid-flight
	// samples below 5% of mean speed.
	const move = synthesizeMove({ x: 0, y: 0 }, { x: 900, y: 200 }, CONSTANTS, makeRandom(3));
	const speeds: number[] = [];
	for (let i = 1; i < move.length; i++) {
		const dt = move[i].tMs - move[i - 1].tMs;
		if (dt > 0) speeds.push(Math.hypot(move[i].x - move[i - 1].x, move[i].y - move[i - 1].y) / dt);
	}
	const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
	assert.ok(Math.max(...speeds) / mean > 2, "expected a peaky speed profile, not a constant glide");
	assert.ok(speeds.some((s) => s < mean * 0.25), "expected the pointer to visibly slow mid-flight");
});

test("synthesizeMove__DecomposesIntoSeveralSubmovements__When__NoSegmentMatches", () => {
	// BeCAPTCHA-Mouse (arXiv:2005.00890) trains a bot detector whose most informative single
	// feature is the number of lognormal strokes a trajectory decomposes into: a human reach is
	// one ballistic launch plus a tail of corrections, and a smooth synthetic curve is one or two.
	// Measured against our own corpus, real segments give a median of 7 velocity peaks and the
	// pre-lognormal version of this function gave 2. Counting peaks approximates the decomposition.
	const rand = makeRandom(23);
	const counts: number[] = [];
	for (let i = 0; i < 60; i++) {
		const move = synthesizeMove({ x: 0, y: 0 }, { x: 400 + rand() * 600, y: 200 }, CONSTANTS, rand);
		const speeds: number[] = [];
		for (let k = 1; k < move.length; k++) {
			const dt = move[k].tMs - move[k - 1].tMs;
			if (dt > 0) speeds.push(Math.hypot(move[k].x - move[k - 1].x, move[k].y - move[k - 1].y) / dt);
		}
		const floor = Math.max(...speeds) * 0.1;
		let peaks = 0;
		for (let k = 1; k < speeds.length - 1; k++)
			if (speeds[k] > floor && speeds[k] >= speeds[k - 1] && speeds[k] > speeds[k + 1]) peaks++;
		counts.push(peaks);
	}
	counts.sort((a, b) => a - b);
	const median = counts[Math.floor(counts.length / 2)];
	assert.ok(median >= 4, `expected several submovements per reach, got a median of ${median}`);
});

test("synthesizeMove__EmitsWholePixelPositions__When__Generated", () => {
	// A real pointer is quantized to the pixel grid; the corpus is mostly 0px and 1px steps between
	// adjacent samples. Sub-pixel positions make the speed profile implausibly smooth.
	const move = synthesizeMove({ x: 0, y: 0 }, { x: 640, y: 360 }, CONSTANTS, makeRandom(31));
	assert.ok(move.every((p) => Number.isInteger(p.x) && Number.isInteger(p.y)));
});

test("synthesizeMove__CurvesOffTheStraightLine__When__Generated", () => {
	const from = { x: 0, y: 0 };
	const to = { x: 800, y: 0 };
	const move = synthesizeMove(from, to, CONSTANTS, makeRandom(11));
	assert.ok(Math.max(...move.map((p) => Math.abs(p.y))) > 8, "expected perpendicular deviation");
});

test("pickSegment__RelaxesDirectionBeforeDistance__When__NoExactOctantMatch", () => {
	const library = [bowedSegment({ octant: 3 })];
	const picked = pickSegment(library, 400, 0, makeRandom(1));
	assert.equal(picked?.octant, 3);
	assert.equal(pickSegment([], 400, 0, makeRandom(1)), undefined);
});

test("keystrokeSchedule__MatchesFittedIKI__When__TextContainsSpaces", () => {
	const keys = keystrokeSchedule("hello world how are you", CONSTANTS, makeRandom(5));
	const chars = keys.filter((k) => k.keyType === "character" || k.keyType === "space");
	assert.ok(chars.length >= 23, "every character should produce a keystroke");
	assert.ok(keys.some((k) => k.keyType === "space"), "spaces are their own key type");
	const gaps: number[] = [];
	for (let i = 1; i < keys.length; i++) gaps.push(keys[i].tMs - keys[i - 1].tMs);
	const median = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
	assert.ok(median > 40 && median < 400, `median inter-key gap ${median}ms outside the measured range`);
	assert.ok(keys.every((k) => k.holdMs === CONSTANTS.keyHoldMs));
});

test("keystrokeSchedule__IsMonotonic__When__CorrectionsAreInserted", () => {
	const keys = keystrokeSchedule("the quick brown fox jumps over the lazy dog", CONSTANTS, makeRandom(9));
	for (let i = 1; i < keys.length; i++)
		assert.ok(keys[i].tMs >= keys[i - 1].tMs, "keystroke times must never go backwards");
});

test("buildFramePlan__PreservesActionAdjacentDuration__When__ThinkingGapsCompressed", () => {
	// Frames one second apart; the action sits at the third. Its interval keeps real duration
	// while the surrounding thinking gaps collapse to the beat.
	const base = 1_000_000;
	const frameTimes = [base, base + 1000, base + 2000, base + 3000, base + 4000];
	const plan = buildFramePlan(frameTimes, [{ startEpochMs: base + 2000, endEpochMs: base + 2100 }]);
	const action = plan.find((p) => p.action);
	assert.ok(action, "the action frame should be marked");
	assert.equal(action.endMs - action.startMs, 1000);
	const gap = plan.find((p) => !p.action);
	assert.ok(gap, "a thinking gap should remain");
	assert.equal(gap.endMs - gap.startMs, GAP_BEAT_MS);
});

test("buildFramePlan__MarksFrameSpanningTheAction__When__CaptureLoopPausedToAct", () => {
	// The capture loop stops polling while the driver acts, so the action lands INSIDE a long gap
	// between two frames rather than near either one. Testing only each frame's start instant
	// marked every action as a thinking gap and compressed away the moments worth watching.
	const base = 1_000_000;
	const frameTimes = [base, base + 800, base + 5200, base + 6000];
	const plan = buildFramePlan(frameTimes, [{ startEpochMs: base + 2900, endEpochMs: base + 4800 }]);
	assert.equal(plan[1].action, true, "the frame whose interval spans the action must be marked");
	assert.equal(plan[0].action, false);
});

test("buildFramePlan__CapsActionSpan__When__PrecedingThinkWasLong", () => {
	// An action frame also covers the think that preceded it. Uncapped, "keep real timing around
	// actions" would preserve a 30s deliberation and the retimed cut would barely be shorter.
	const base = 1_000_000;
	const frameTimes = [base, base + 30_000, base + 30_800];
	const plan = buildFramePlan(frameTimes, [{ startEpochMs: base + 29_000, endEpochMs: base + 29_500 }]);
	assert.equal(plan[0].action, true);
	assert.equal(plan[0].endMs - plan[0].startMs, ACTION_MAX_MS);
});

test("buildFramePlan__ReturnsEmpty__When__NoFramesCaptured", () => {
	assert.deepEqual(buildFramePlan([], []), []);
});

test("toOutputMs__MapsIntoCompressedTimeline__When__GapPrecedesAction", () => {
	const base = 1_000_000;
	// Two pure thinking frames, then one spanning the action. The first two collapse to the beat,
	// so the action lands early in the output timeline instead of ten seconds in.
	const frameTimes = [base, base + 4000, base + 8000, base + 12_000];
	const plan = buildFramePlan(frameTimes, [{ startEpochMs: base + 9000, endEpochMs: base + 9500 }]);
	assert.ok(
		toOutputMs(plan, frameTimes, base + 9000) <= GAP_BEAT_MS * 2 + ACTION_MAX_MS,
		"the action should land within the compressed lead-in plus its own capped span",
	);
	assert.equal(toOutputMs(plan, frameTimes, base - 5000), 0);
});

test("samplePercentile__InterpolatesBetweenQuantiles__When__GivenUniformInput", () => {
	const q = { p10: 100, p50: 200, p90: 400 };
	assert.equal(samplePercentile(q, 0), 100);
	assert.equal(samplePercentile(q, 0.5), 200);
	assert.equal(samplePercentile(q, 1), 400);
	assert.ok(samplePercentile(q, 0.7) > 200 && samplePercentile(q, 0.7) < 400);
});

test("makeRandom__ProducesIdenticalSequence__When__SeededTheSame", () => {
	// Renders must be reproducible, so nothing in this pass may reach for Math.random.
	const a = makeRandom(42);
	const b = makeRandom(42);
	for (let i = 0; i < 20; i++) assert.equal(a(), b());
});

test("octantOf__PartitionsTheCircle__When__GivenAxisDirections", () => {
	assert.equal(octantOf(1, 0), 0);
	assert.equal(octantOf(0, 1), 2);
	assert.equal(octantOf(-1, 0), 4);
	assert.equal(octantOf(0, -1), 6);
});
