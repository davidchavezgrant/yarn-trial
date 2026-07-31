import assert from "node:assert/strict";
import test from "node:test";
import type { MotionConstants, MotionSegment } from "../src/cursor/motion-types.js";
import {
	buildFramePlan,
	buildTrack,
	correctToChange,
	CLICK_LEAD_MS,
	ACTION_MAX_MS,
	GAP_BEAT_MS,
	joinSteps,
	keystrokeSchedule,
	makeRandom,
	octantOf,
	pickSegment,
	pointerTypeForRole,
	samplePercentile,
	springSmooth,
	synthesizeMove,
	toFramePixels,
	toOutputMs,
	warpSegment,
	type RunLogStep,
	type TrajectoryTurn,
} from "../src/cursor/track.js";

/**
 * Corpus values, inlined so tests do not depend on the fitted file.
 *
 * These are the SMOOTHED (rendered) figures — what a viewer sees after Yarn's editor springs the
 * raw input. The raw numbers are very different (peak/mean 10.4 rather than 2.5, 30% of samples
 * near-stopped rather than none) and fitting against them was a real bug, so do not restore them.
 */
const CONSTANTS: MotionConstants = {
	fittedFrom: { dataset: "test", recordings: 0, movementEvents: 0, generatedAt: "" },
	durationByLogDistance: {
		"6": { p10: 258, p50: 466, p90: 950, n: 158 },
		"8": { p10: 300, p50: 566, p90: 1116, n: 321 },
		"10": { p10: 383, p50: 700, p90: 1300, n: 449 },
	},
	clickDwellMs: { p10: 16.2, p50: 110.5, p90: 590.1 },
	ikiMs: { p10: 45, p25: 69, p50: 108, p75: 160, p90: 283, p99: 1322 },
	ikiAfterSpaceMs: 144,
	keyHoldMs: 92,
	correctionRate: 0.037,
	perpDeviationFrac: { p50: 0.0583, p75: 0.144, p90: 0.4045 },
	peakSpeedRatio: { p10: 1.65, p50: 2.45, p90: 3.96 },
	nearStoppedFrac: { p50: 0.0, p90: 0.117 },
	sampleHz: 60,
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

test("joinSteps__CollapsesChunkTurns__When__StepTypedLive", () => {
	// One demo type step actuates as a focus click plus one driver type_text call PER CHUNK, so
	// the trajectory holds several turns for a single run-log step. The chunks must collapse
	// into the step's entry, the focus click must not steal a later click step, and the step
	// after the typing must keep its own pairing.
	const steps: RunLogStep[] = [
		{
			index: 1,
			timestamp: "",
			action: { kind: "tool", name: "type_text", args: { text: "hello world" } },
			typedLive: true,
			typedChunks: [
				{ text: "hello ", epochStartMs: 1_000_100, epochEndMs: 1_000_500 },
				{ text: "world", epochStartMs: 1_000_600, epochEndMs: 1_001_000 },
			],
		},
		{ index: 2, timestamp: "", action: { kind: "tool", name: "click" } },
	];
	const turns = [
		turn("click", { epochMs: 1_000_050 }),
		turn("type_text", { arguments: { text: "hello " }, startMs: 100, endMs: 500, epochMs: 1_000_500 }),
		turn("type_text", { arguments: { text: "world" }, startMs: 600, endMs: 1000, epochMs: 1_001_000 }),
		turn("click", { epochMs: 1_002_000 }),
	];
	const joined = joinSteps(steps, turns);
	assert.equal(joined.length, 3, "the trailing chunk collapses into the step's entry");
	assert.equal(joined[0].step, undefined, "the focus click is the typed step's own actuation, not a later step's");
	assert.equal(joined[1].step?.index, 1);
	assert.equal(joined[1].chunkTurns?.length, 1);
	assert.equal(joined[1].chunkTurns?.[0].epochMs, 1_001_000);
	assert.equal(joined[2].step?.index, 2, "the step after the typing keeps its own turn");
	// A chunk run cut short — a strict prefix of the step's text — still collapses.
	const partial = joinSteps(steps.slice(0, 1), [
		turn("type_text", { arguments: { text: "hello " }, epochMs: 1_000_500 }),
		turn("type_text", { arguments: { text: "wor" }, epochMs: 1_001_000 }),
	]);
	assert.equal(partial.length, 1);
	assert.equal(partial[0].chunkTurns?.length, 1);
});

test("joinSteps__KeepsTurnsSeparate__When__StepsNotTypedLive", () => {
	// Legacy runs are one turn per step; two adjacent atomic type_text steps must not merge.
	const steps: RunLogStep[] = [
		{ index: 1, timestamp: "", action: { kind: "tool", name: "type_text", args: { text: "one" } } },
		{ index: 2, timestamp: "", action: { kind: "tool", name: "type_text", args: { text: "two" } } },
	];
	const joined = joinSteps(steps, [
		turn("type_text", { arguments: { text: "one" } }),
		turn("type_text", { arguments: { text: "two" } }),
	]);
	assert.equal(joined.length, 2);
	assert.equal(joined[0].step?.index, 1);
	assert.equal(joined[0].chunkTurns, undefined);
	assert.equal(joined[1].step?.index, 2);
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

test("synthesizeMove__MovesContinuously__When__NoSegmentMatches", () => {
	// The raw corpus has 30% of mid-flight samples nearly stopped, but the rendered corpus has
	// essentially none — the spring carries the pointer through the hand's hesitations. A reach
	// that stalls mid-flight in the OUTPUT is now the bug, the inverse of what this once asserted.
	const move = synthesizeMove({ x: 0, y: 0 }, { x: 900, y: 200 }, CONSTANTS, makeRandom(3));
	const speeds: number[] = [];
	for (let i = 1; i < move.length; i++) {
		const dt = move[i].tMs - move[i - 1].tMs;
		if (dt > 0) speeds.push(Math.hypot(move[i].x - move[i - 1].x, move[i].y - move[i - 1].y) / dt);
	}
	const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
	const stalled = speeds.filter((s) => s < mean * 0.05).length / speeds.length;
	assert.ok(stalled < 0.1, `rendered motion barely stalls; ${(stalled * 100).toFixed(0)}% of samples did`);
	assert.ok(Math.max(...speeds) / mean > 1.5, "expected acceleration and deceleration, not a constant glide");
});

test("synthesizeMove__MatchesRenderedSpeedProfile__When__NoSegmentMatches", () => {
	// Fitted against the SMOOTHED corpus, which is the motion a viewer sees. Yarn's editor
	// decimates raw input and springs toward it, which absorbs most of the hand's structure:
	// submovement peaks fall from a median of 7 raw to 2 rendered, and peak/mean speed from 10.4
	// to 2.5. Synthesis feeds lognormal strokes IN and runs the same spring, so what comes out
	// should look rendered, not raw — this catches a regression back to the raw-fitted profile.
	const rand = makeRandom(23);
	const peaks: number[] = [];
	const ratios: number[] = [];
	for (let i = 0; i < 60; i++) {
		const move = synthesizeMove({ x: 0, y: 0 }, { x: 400 + rand() * 600, y: 200 }, CONSTANTS, rand);
		const speeds: number[] = [];
		for (let k = 1; k < move.length; k++) {
			const dt = move[k].tMs - move[k - 1].tMs;
			if (dt > 0) speeds.push(Math.hypot(move[k].x - move[k - 1].x, move[k].y - move[k - 1].y) / dt);
		}
		const max = Math.max(...speeds);
		const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
		let n = 0;
		for (let k = 1; k < speeds.length - 1; k++)
			if (speeds[k] > max * 0.1 && speeds[k] >= speeds[k - 1] && speeds[k] > speeds[k + 1]) n++;
		peaks.push(n);
		ratios.push(max / mean);
	}
	const median = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
	assert.ok(median(peaks) <= 4, `rendered motion has ~2 submovement peaks, got ${median(peaks)}`);
	assert.ok(median(ratios) < 4, `rendered peak/mean is ~2.5, got ${median(ratios).toFixed(2)}`);
});

test("springSmooth__RemovesJitter__When__InputReversesEveryStep", () => {
	// The spring is the whole difference between input-shaped and rendered motion. Direction
	// reversals are the honest measure of the jitter it removes: a speed-ratio comparison is not,
	// because the output is resampled to 60fps and no longer cancels adjacent opposing steps.
	const spiky: Array<{ tMs: number; x: number; y: number }> = [];
	for (let i = 0; i <= 60; i++) spiky.push({ tMs: i * 8, x: i % 2 === 0 ? i * 10 : i * 10 + 40, y: 0 });
	const reversals = (pts: typeof spiky): number => {
		let n = 0;
		for (let i = 2; i < pts.length; i++)
			if ((pts[i - 1].x - pts[i - 2].x) * (pts[i].x - pts[i - 1].x) < 0) n++;

		return n;
	};
	assert.ok(reversals(spiky) > 50, "fixture should be jittery");
	assert.equal(reversals(springSmooth(spiky, 60)), 0);
});

test("springSmooth__EndsExactlyOnTarget__When__SpringStillLagging", () => {
	// The spring lags by design, so without the settle the click would land short of the control.
	const path = [
		{ tMs: 0, x: 0, y: 0 },
		{ tMs: 200, x: 300, y: 120 },
		{ tMs: 400, x: 640, y: 360 },
	];
	const out = springSmooth(path, 60);
	assert.equal(out[out.length - 1].x, 640);
	assert.equal(out[out.length - 1].y, 360);
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

test("keystrokeSchedule__IsMonotonic__When__Synthesizing", () => {
	const keys = keystrokeSchedule("the quick brown fox jumps over the lazy dog", CONSTANTS, makeRandom(9));
	for (let i = 1; i < keys.length; i++)
		assert.ok(keys[i].tMs >= keys[i - 1].tMs, "keystroke times must never go backwards");
});

test("keystrokeSchedule__EmitsOnlyTextChars__When__Synthesizing", () => {
	// The correction branch typed a QWERTY neighbour and deleted it — a fabricated typo in the
	// record of what happened, rendered over frames that never showed one. Even with the fitted
	// correction rate forced to certainty, only the text's own characters may come out.
	const text = "the quick brown fox";
	const keys = keystrokeSchedule(text, { ...CONSTANTS, correctionRate: 1 }, makeRandom(9));
	assert.equal(keys.length, [...text].length, "exactly one keystroke per character");
	assert.ok(keys.every((k) => k.keyType !== "delete"), "no fabricated backspace");
	const typed = keys.map((k) => (k.keyType === "space" ? " " : k.char)).join("");
	assert.equal(typed, text);
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

/** A minimal two-click run: enough to observe where the pointer waits between actions. */
const twoClickTrack = (): ReturnType<typeof buildTrack> => {
	const base = 1_000_000;
	const mk = (epochMs: number, x: number, y: number): TrajectoryTurn => ({
		tool: "click",
		arguments: {},
		clickPoint: { x, y },
		startMs: 0,
		endMs: 200,
		epochMs,
		dir: "",
		captureWidth: 1568,
	});

	return buildTrack({
		stamp: "t",
		app: "Yarn",
		task: "t",
		runLog: "",
		steps: [
			{ index: 1, timestamp: "", action: { kind: "tool", name: "click" }, targetRole: "AXButton", targetRect: { x: 90, y: 780, w: 150, h: 30 } },
			{ index: 2, timestamp: "", action: { kind: "tool", name: "click" }, targetRole: "AXButton", targetRect: { x: 1050, y: 60, w: 120, h: 30 } },
		],
		// Ten seconds of model thinking between the two clicks.
		turns: [mk(base + 2000, 100, 800), mk(base + 12_000, 1100, 70)],
		frameTimes: [base, base + 2000, base + 12_000, base + 13_000],
		frameSize: { width: 1568, height: 882 },
		captureSize: { width: 1568, height: 882 },
		constants: CONSTANTS,
		library: { fittedFrom: { dataset: "t", generatedAt: "" }, segments: [] },
	});
};

test("buildTrack__WaitsAtTheNextTarget__When__ModelThinksBetweenActions", () => {
	// The pointer used to sit on the control it had just clicked for the whole thinking gap. At 23s
	// of a real run the app had navigated to Workflows while the cursor still hovered "Brand Kit"
	// in the sidebar. The idle belongs at the DESTINATION — "about to click this", not "stuck on
	// that" — so the longest hold must be at the second target, not the first.
	const track = twoClickTrack();
	const clicks = track.events.filter((e) => e.kind === "mousedown");
	assert.equal(clicks.length, 2);
	let longest = { hold: 0, x: 0 };
	for (let i = 1; i < track.cursor.length; i++) {
		const hold = track.cursor[i].tMs - track.cursor[i - 1].tMs;
		if (hold > longest.hold) longest = { hold, x: track.cursor[i - 1].x };
	}
	const second = clicks[1] as { x: number };
	assert.ok(longest.hold > 1000, "a long think should still produce a long hold somewhere");
	assert.ok(
		Math.abs(longest.x - second.x) < 50,
		`the longest wait should be at the NEXT target (x=${second.x}), not at x=${longest.x}`,
	);
});

test("buildTrack__EmitsHoverSpans__When__StepsCarryTargetRects", () => {
	// The app paints no hover of its own: AX actuation leaves the physical pointer elsewhere, so no
	// mouseover fires — measured at 12 of 164 frames on a real run. Without a synthesized highlight
	// the cursor rests on a control that never lights up.
	const track = twoClickTrack();
	assert.equal(track.hovers.length, 2);
	for (const h of track.hovers) {
		assert.ok(h.endMs > h.startMs, "a hover span must have duration");
		assert.ok(h.w > 0 && h.h > 0);
	}
	// Each span ends at its own click, so the highlight is up while the pointer waits.
	const clicks = track.events.filter((e) => e.kind === "mousedown");
	assert.ok(track.hovers[0].endMs <= clicks[1].tMs);
});

test("buildTrack__SkipsActions__When__TheyPrecedeTheFirstUsableFrame", () => {
	// toOutputMs pins anything earlier than the first frame to 0, so actions from before the
	// window settled all stacked at 0ms on the opening frame — two clicks at once, against a
	// screen showing neither, which reads as the UI changing before the pointer gets there.
	const base = 1_000_000;
	const mk = (epochMs: number, x: number): TrajectoryTurn => ({
		tool: "click",
		arguments: {},
		clickPoint: { x, y: 400 },
		startMs: 0,
		endMs: 200,
		epochMs,
		dir: "",
		captureWidth: 1568,
	});
	const track = buildTrack({
		stamp: "t",
		app: "Yarn",
		task: "t",
		runLog: "",
		steps: [],
		// The first two happen before any frame was captured; only the third has footage.
		turns: [mk(base - 18_000, 100), mk(base - 2000, 300), mk(base + 4000, 900)],
		// Frames every second, so the third action has one at or before its dispatch to anchor to.
		frameTimes: [base, base + 1000, base + 2000, base + 3000, base + 4000, base + 6000],
		frameSize: { width: 1568, height: 882 },
		captureSize: { width: 1568, height: 882 },
		constants: CONSTANTS,
		library: { fittedFrom: { dataset: "t", generatedAt: "" }, segments: [] },
	});
	const clicks = track.events.filter((e) => e.kind === "mousedown");
	assert.equal(clicks.length, 1, "only the action with footage should be rendered");
	assert.ok(clicks[0].tMs > 0, "and it must not be pinned to the timeline start");
});

test("buildTrack__LeavesTheClickAtTheCorrectedPoint__When__TargetRectIsStale", () => {
	// The two-Save-Changes case: click_point AND targetRect agree with each other and are both
	// ~40px off the visible button, so correctToChange moves the point onto the changed pixels.
	// jitterWithin clamps INTO its rect — jittering against the stale rect would drag the
	// corrected point straight back onto the stale geometry. No agreement means no jitter and
	// no hover rect; the corrected point is the best evidence there is about the landing.
	const base = 1_000_000;
	const staleRect = { x: 1214, y: 12, w: 190, h: 30 };
	const track = buildTrack({
		stamp: "t",
		app: "Yarn",
		task: "t",
		runLog: "",
		steps: [
			{ index: 1, timestamp: "", action: { kind: "tool", name: "click" }, targetRole: "AXButton", targetRect: staleRect },
		],
		turns: [{
			tool: "click",
			arguments: {},
			clickPoint: { x: 1279, y: 27 },
			startMs: 0,
			endMs: 200,
			epochMs: base + 2000,
			dir: "",
			captureWidth: 1568,
			// The pixels that actually changed sit ~50px below both the click point and the rect.
			changeBox: { x: 1214, y: 63, w: 190, h: 30 },
		}],
		frameTimes: [base, base + 2000, base + 3000],
		frameSize: { width: 1568, height: 882 },
		captureSize: { width: 1568, height: 882 },
		constants: CONSTANTS,
		library: { fittedFrom: { dataset: "t", generatedAt: "" }, segments: [] },
	});
	const clicks = track.events.filter((e) => e.kind === "mousedown") as Array<{ tMs: number; x: number; y: number }>;
	assert.equal(clicks.length, 1);
	// The click sits on the changeBox centre, where the control visibly is.
	assert.ok(Math.abs(clicks[0].x - 1309) < 0.5 && Math.abs(clicks[0].y - 78) < 0.5, `landed at ${clicks[0].x},${clicks[0].y}`);
	// The last cursor sample at the click must be there too, and OFF the stale rect.
	const atClick = track.cursor.filter((s) => s.tMs <= clicks[0].tMs).at(-1);
	assert.ok(atClick, "the pointer should arrive before the click");
	const inStale =
		atClick.x >= staleRect.x
		&& atClick.x <= staleRect.x + staleRect.w
		&& atClick.y >= staleRect.y
		&& atClick.y <= staleRect.y + staleRect.h;
	assert.ok(!inStale, `the corrected point must survive, was clamped to ${atClick.x},${atClick.y}`);
	// A rect that disagrees with the landing is no hover target either.
	assert.equal(track.hovers.length, 0);
});

test("buildTrack__KeepsCursorMonotonicAroundActions__When__TheGapIsShorterThanTheMove", () => {
	// Two clicks a long reach apart (~1490px, sampled duration at least 383ms) with only ~300ms
	// of output timeline between them — a long think compressed to a beat. The move has to be
	// time-compressed into that gap: floored at zero instead of the previous action, its samples
	// sorted in BEFORE the first click, so the rendered pointer advanced, snapped back to the
	// old control for a sample, and re-arrived.
	const base = 1_000_000;
	const mk = (epochMs: number, x: number, y: number): TrajectoryTurn => ({
		tool: "click",
		arguments: {},
		clickPoint: { x, y },
		startMs: 0,
		endMs: 200,
		epochMs,
		dir: "",
		captureWidth: 1568,
	});
	const track = buildTrack({
		stamp: "t",
		app: "Yarn",
		task: "t",
		runLog: "",
		steps: [
			{ index: 1, timestamp: "", action: { kind: "tool", name: "click" }, targetRole: "AXButton", targetRect: { x: 40, y: 780, w: 150, h: 30 } },
			{ index: 2, timestamp: "", action: { kind: "tool", name: "click" }, targetRole: "AXButton", targetRect: { x: 1340, y: 85, w: 120, h: 30 } },
		],
		turns: [mk(base + 300, 100, 800), mk(base + 600, 1400, 100)],
		frameTimes: [base, base + 300, base + 600, base + 900],
		frameSize: { width: 1568, height: 882 },
		captureSize: { width: 1568, height: 882 },
		constants: CONSTANTS,
		library: { fittedFrom: { dataset: "t", generatedAt: "" }, segments: [] },
		seed: 41,
	});
	const clicks = track.events.filter((e) => e.kind === "mousedown") as Array<{ tMs: number; x: number; y: number }>;
	assert.equal(clicks.length, 2);
	for (let i = 1; i < track.cursor.length; i++)
		assert.ok(track.cursor[i].tMs >= track.cursor[i - 1].tMs, "cursor times must never go backwards");
	// A sample sits exactly at each click, on the click point — the move ended before dispatch.
	for (const c of clicks) {
		const at = track.cursor.find((s) => s.tMs === c.tMs && Math.hypot(s.x - c.x, s.y - c.y) < 0.01);
		assert.ok(at, `a cursor sample must sit on the click at t=${c.tMs}`);
	}
	// The second move departs FROM the first target, no earlier than the first action: the first
	// sample after the first click is still at that click, not mid-flight toward the second.
	const afterFirst = track.cursor.find((s) => s.tMs > clicks[0].tMs);
	assert.ok(afterFirst, "the second move should produce samples");
	assert.ok(
		Math.hypot(afterFirst.x - clicks[0].x, afterFirst.y - clicks[0].y) < 50,
		`pointer left the first target early: at ${afterFirst.x},${afterFirst.y} by t=${afterFirst.tMs}`,
	);
	// And nothing after the second click is still in flight toward it.
	for (const s of track.cursor.filter((s) => s.tMs >= clicks[1].tMs))
		assert.ok(Math.hypot(s.x - clicks[1].x, s.y - clicks[1].y) < 0.01, "no sample after the click may still be approaching");
});

test("toOutputMs__MapsByFrameIndex__When__PlanSkipsLeadingFrames", () => {
	// buildFramePlan's keepFrom drops leading frames, after which plan[i].frameIndex > i.
	// Positional indexing read frameTimes[0] for plan[0], so every instant was tested against
	// the wrong frame's real interval and fell through to the timeline's end.
	const base = 1_000_000;
	const frameTimes = [base, base + 1000, base + 2000, base + 3000];
	const plan = buildFramePlan(frameTimes, [], undefined, base + 2000);
	assert.equal(plan[0].frameIndex, 2, "the first two frames should be skipped");
	// Halfway through the third frame's real interval maps halfway through its output span.
	const out = toOutputMs(plan, frameTimes, base + 2500);
	assert.ok(out >= plan[0].startMs && out <= plan[0].endMs, `mapped to ${out}, outside the frame's span`);
	assert.equal(out, plan[0].startMs + (plan[0].endMs - plan[0].startMs) / 2);
});

test("correctToChange__MovesOntoTheControl__When__AxGeometryIsStale", () => {
	// One run's tree carried TWO "Save Changes" buttons; the agent pressed the offscreen one, so
	// click_point AND targetRect both landed 41px above the visible button — wrong together, which
	// no consistency check between them can catch. The before/after diff is independent of both.
	const fixed = correctToChange({ x: 1279, y: 27 }, { x: 1214, y: 63, w: 190, h: 30 }, { width: 1920, height: 1080 });
	assert.ok(Math.abs(fixed.x - 1309) < 2 && Math.abs(fixed.y - 78) < 2, `got ${fixed.x},${fixed.y}`);
});

test("correctToChange__LeavesThePoint__When__ChangeIsAWholeNavigation", () => {
	// A navigation repaints most of the window, so its centroid says nothing about the pointer.
	const p = { x: 100, y: 800 };
	assert.deepEqual(correctToChange(p, { x: 0, y: 0, w: 1900, h: 1000 }, { width: 1920, height: 1080 }), p);
});

test("correctToChange__LeavesThePoint__When__ChangeIsFarAway", () => {
	// A click that opens a panel elsewhere must not drag the cursor across the screen to it.
	const p = { x: 100, y: 800 };
	assert.deepEqual(correctToChange(p, { x: 1500, y: 60, w: 80, h: 24 }, { width: 1920, height: 1080 }), p);
});

test("correctToChange__LeavesThePoint__When__ClickIsAlreadyInside", () => {
	const p = { x: 1250, y: 75 };
	assert.deepEqual(correctToChange(p, { x: 1214, y: 63, w: 190, h: 30 }, { width: 1920, height: 1080 }), p);
});

test("buildFramePlan__NamesEveryFrame__When__FileListIsGiven", () => {
	// The renderer resolves by filename. Resolving by index required it to filter the frames
	// directory exactly as the track builder did — it did not, so after malformed frames were
	// dropped every plan entry pointed at the wrong capture.
	const base = 1_000_000;
	const plan = buildFramePlan([base, base + 1000, base + 2000], [], ["f-00025.png", "f-00026.png", "f-00027.png"]);
	assert.deepEqual(plan.map((p) => p.frameFile), ["f-00025.png", "f-00026.png", "f-00027.png"]);
	// Indices stay relative to the FILTERED list, so they must not be read as directory positions.
	assert.deepEqual(plan.map((p) => p.frameIndex), [0, 1, 2]);
});

test("buildTrack__OmitsHoverSpan__When__StepHasNoTargetRect", () => {
	// Inferring a box from the cursor position would highlight whatever the pointer overlaps,
	// including nothing at all.
	const base = 1_000_000;
	const track = buildTrack({
		stamp: "t",
		app: "Yarn",
		task: "t",
		runLog: "",
		steps: [{ index: 1, timestamp: "", action: { kind: "tool", name: "click" } }],
		turns: [{ tool: "click", arguments: {}, clickPoint: { x: 100, y: 800 }, startMs: 0, endMs: 200, epochMs: base + 2000, dir: "", captureWidth: 1568 }],
		frameTimes: [base, base + 2000, base + 3000],
		frameSize: { width: 1568, height: 882 },
		captureSize: { width: 1568, height: 882 },
		constants: CONSTANTS,
		library: { fittedFrom: { dataset: "t", generatedAt: "" }, segments: [] },
	});
	assert.equal(track.hovers.length, 0);
});

test("buildTrack__SkipsKeystrokeSynthesis__When__StepTypedLive", () => {
	// The frames of a live-typed step genuinely show the text appearing, so a synthesized
	// keystream would double-report it. The reveal carries the RECORDED chunk timing instead.
	const base = 1_000_000;
	const track = buildTrack({
		stamp: "t",
		app: "Yarn",
		task: "t",
		runLog: "",
		steps: [
			{
				index: 1,
				timestamp: "",
				action: { kind: "tool", name: "type_text", args: { text: "hello world" } },
				typedLive: true,
				typedChunks: [
					{ text: "hello ", epochStartMs: base + 2000, epochEndMs: base + 2600 },
					{ text: "world", epochStartMs: base + 2900, epochEndMs: base + 3400 },
				],
			},
		],
		turns: [
			turn("type_text", { arguments: { text: "hello " }, startMs: 100, endMs: 700, epochMs: base + 2600 }),
			turn("type_text", { arguments: { text: "world" }, startMs: 900, endMs: 1400, epochMs: base + 3400 }),
		],
		frameTimes: [base, base + 1000, base + 2000, base + 3000, base + 4000],
		frameSize: { width: 1568, height: 882 },
		captureSize: { width: 1568, height: 882 },
		constants: CONSTANTS,
		library: { fittedFrom: { dataset: "t", generatedAt: "" }, segments: [] },
	});
	assert.equal(track.events.filter((e) => e.kind === "key").length, 0, "no synthesized keystrokes over real typing");
	const reveals = track.events.filter((e) => e.kind === "textReveal") as Array<{
		tMs: number;
		endTMs?: number;
		reveal: string;
		text: string;
	}>;
	assert.equal(reveals.length, 2, "one reveal per recorded chunk");
	for (const r of reveals) {
		assert.equal(r.reveal, "live");
		assert.ok(r.endTMs !== undefined && r.endTMs >= r.tMs, "a live reveal spans its recorded chunk");
	}
	assert.deepEqual(reveals.map((r) => r.text), ["hello ", "world"]);
});

test("buildTrack__SpansTurnTiming__When__TypedLiveWithoutChunkRecord", () => {
	// Defensive: a typedLive step whose log carries no chunk timings still reveals with REAL
	// timing — the turn's own dispatch-to-completion window — never a synthesized schedule.
	const base = 1_000_000;
	const track = buildTrack({
		stamp: "t",
		app: "Yarn",
		task: "t",
		runLog: "",
		steps: [{ index: 1, timestamp: "", action: { kind: "tool", name: "type_text", args: { text: "hello" } }, typedLive: true }],
		turns: [turn("type_text", { arguments: { text: "hello" }, startMs: 100, endMs: 700, epochMs: base + 2600 })],
		frameTimes: [base, base + 1000, base + 2000, base + 3000],
		frameSize: { width: 1568, height: 882 },
		captureSize: { width: 1568, height: 882 },
		constants: CONSTANTS,
		library: { fittedFrom: { dataset: "t", generatedAt: "" }, segments: [] },
	});
	assert.equal(track.events.filter((e) => e.kind === "key").length, 0);
	const reveals = track.events.filter((e) => e.kind === "textReveal") as Array<{
		tMs: number;
		endTMs?: number;
		reveal: string;
		text: string;
	}>;
	assert.equal(reveals.length, 1);
	assert.equal(reveals[0].reveal, "live");
	assert.equal(reveals[0].text, "hello");
	assert.ok(reveals[0].endTMs !== undefined && reveals[0].endTMs > reveals[0].tMs);
});

test("buildTrack__SynthesizesKeystream__When__RunLogPredatesLiveTyping", () => {
	// An old-shape run log — no typedLive, no typedChunks — must keep producing the legacy
	// track: an atomic type_text gets a corpus-synthesized schedule and a "typed" reveal, with
	// exactly the text's own characters and nothing invented.
	const base = 1_000_000;
	const track = buildTrack({
		stamp: "t",
		app: "Yarn",
		task: "t",
		runLog: "",
		steps: [{ index: 1, timestamp: "", action: { kind: "tool", name: "type_text", args: { text: "hi there" } } }],
		turns: [turn("type_text", { arguments: { text: "hi there" }, startMs: 100, endMs: 400, epochMs: base + 2000 })],
		frameTimes: [base, base + 1000, base + 2000, base + 3000],
		frameSize: { width: 1568, height: 882 },
		captureSize: { width: 1568, height: 882 },
		constants: CONSTANTS,
		library: { fittedFrom: { dataset: "t", generatedAt: "" }, segments: [] },
	});
	const keys = track.events.filter((e) => e.kind === "key") as Array<{ keyType: string; char?: string }>;
	assert.equal(keys.length, "hi there".length, "one synthesized keystroke per character, none invented");
	assert.equal(keys.map((k) => (k.keyType === "space" ? " " : k.char)).join(""), "hi there");
	const reveals = track.events.filter((e) => e.kind === "textReveal") as Array<{ reveal: string; endTMs?: number }>;
	assert.equal(reveals.length, 1);
	assert.equal(reveals[0].reveal, "typed");
	assert.equal(reveals[0].endTMs, undefined);
});

test("toOutputMs__PlacesClickAgainstTheCut__When__AnchoredToEnd", () => {
	// The frame holding a click is the last capture of the PRE-click screen; the response is the
	// next one. Placing the click proportionally within a long frame left seconds of pre-click
	// state playing after the button went down — measured at 2.1s, which read as the state change
	// lagging the click. Anchored, it sits CLICK_LEAD_MS before the cut.
	const base = 1_000_000;
	const frameTimes = [base, base + 5000, base + 6000];
	const plan = buildFramePlan(frameTimes, [{ startEpochMs: base + 500, endEpochMs: base + 700 }]);
	const span = plan[0];
	const proportional = toOutputMs(plan, frameTimes, base + 500);
	const anchored = toOutputMs(plan, frameTimes, base + 500, true);
	assert.ok(anchored > proportional, "anchoring should move the click later within its frame");
	assert.equal(anchored, span.endMs - CLICK_LEAD_MS);
});

test("toOutputMs__StaysInsideTheFrame__When__SpanIsShorterThanTheLead", () => {
	// A frame briefer than the lead must not push the click before its own start.
	const base = 1_000_000;
	const frameTimes = [base, base + 60, base + 120];
	const plan = buildFramePlan(frameTimes, []);
	const anchored = toOutputMs(plan, frameTimes, base + 10, true);
	assert.ok(anchored >= plan[0].startMs && anchored <= plan[0].endMs);
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

test("buildTrack__ComposesChordLabel__When__PressKeyHasModifiers", () => {
	// The keycap chip renders this label verbatim; a bare "a" for what was really
	// cmd+a would depict a stray keystroke.
	const base = 1_000_000;
	const track = buildTrack({
		stamp: "t",
		app: "Yarn",
		task: "t",
		runLog: "",
		steps: [{ index: 1, timestamp: "", action: { kind: "tool", name: "press_key" } }],
		turns: [
			{
				tool: "press_key",
				arguments: { key: "a", modifiers: ["cmd"] },
				startMs: 0,
				endMs: 150,
				epochMs: base + 2000,
				dir: "",
				captureWidth: 1568,
			},
		],
		frameTimes: [base, base + 2000, base + 3000],
		frameSize: { width: 1568, height: 882 },
		captureSize: { width: 1568, height: 882 },
		constants: CONSTANTS,
		library: { fittedFrom: { dataset: "t", generatedAt: "" }, segments: [] },
	});
	const key = track.events.find((e) => e.kind === "key");
	assert.ok(key, "press_key emitted no key event");
	assert.equal((key as { keyType?: string }).keyType, "cmd+a");
});
