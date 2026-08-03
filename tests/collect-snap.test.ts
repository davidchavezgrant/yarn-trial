import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRunMetrics } from "../src/bench/collect.js";

/**
 * The pixel-snap aggregates in `parseRunMetrics` — the eight snap arms' whole question, and the
 * one part of the run log where ABSENT and 0 are different claims.
 *
 * These live in their own file rather than in bench.test.ts because the arithmetic is the point:
 * the denominator counts candidate steps only, `snapDeclaredMismatches` counts APPLIED mismatches
 * only, and every field disappears on an arm that never named a pixel. Each of those is a distinct
 * way for a reader to be misled by a number that looks fine.
 */

/** A minimal task run log — only the fields parseRunMetrics reads, plus the steps under test. */
const snapLog = (steps: Array<Record<string, unknown>>): Record<string, any> => ({
	task: "show me how to change the cursor type",
	app: "Yarn",
	backend: "cdp",
	vision: true,
	ax: false,
	success: false,
	steps,
});

/**
 * A candidate step as step.ts writes one: name/role/distance/inside always together, plus
 * `snapMatchesDeclared` when the model declared a target and `snapApplied` when the rewrite fired.
 */
const snapStep = (index: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
	index,
	snapName: "Cursor Style",
	snapRole: "button",
	snapDistancePx: 12,
	snapInside: false,
	snapMatchesDeclared: true,
	...over,
});

test("parseRunMetrics__CountsOnlyCandidateSteps__When__SomeStepsCarryNoSnapData", () => {
	// Two candidates among four steps: an element-addressed step and a step from before the
	// diagnostic existed both carry nothing, and neither may enter the denominator.
	const m = parseRunMetrics(
		snapLog([
			snapStep(1, { snapDistancePx: 10 }),
			{ index: 2, observationNodes: 180 },
			snapStep(3, { snapDistancePx: 40 }),
			{ index: 4 },
		]),
	);
	assert.equal(m.steps, 4);
	assert.equal(m.snapCandidateSteps, 2);
	// The mean's denominator is the candidate count, not the step count — 25, never 12.5.
	assert.equal(m.snapMeanDistancePx, 25);
});

test("parseRunMetrics__CountsOnlyAppliedMismatches__When__AnUnappliedStepAlsoMismatches", () => {
	const m = parseRunMetrics(
		snapLog([
			// Applied and matching: the refinement a snap arm is supposed to be made of.
			snapStep(1, { snapApplied: true, snapMatchesDeclared: true }),
			// Applied and NOT matching: the confound — retargeted to a control never asked for.
			snapStep(2, { snapApplied: true, snapMatchesDeclared: false }),
			// Mismatched but never applied (SNAP_PX off, or out of tolerance). The action went to
			// the raw pixel, so nothing was retargeted and this must NOT be counted.
			snapStep(3, { snapMatchesDeclared: false }),
		]),
	);
	assert.equal(m.snapCandidateSteps, 3);
	assert.equal(m.snapAppliedSteps, 2);
	assert.equal(m.snapDeclaredMismatches, 1);
});

test("parseRunMetrics__CountsInsideSteps__When__PointsLandedInsideAControl", () => {
	const m = parseRunMetrics(
		snapLog([
			snapStep(1, { snapDistancePx: 0, snapInside: true }),
			snapStep(2, { snapDistancePx: 0, snapInside: true }),
			snapStep(3, { snapDistancePx: 30, snapInside: false }),
		]),
	);
	assert.equal(m.snapInsideSteps, 2);
	assert.equal(m.snapMeanDistancePx, 10);
});

test("parseRunMetrics__ReportsZeroApplied__When__TheDiagnosticRanWithoutTheRewrite", () => {
	// A non-snap vision-only arm: SNAP_PX unset, so step.ts records candidates and never rewrites.
	// The fields must be PRESENT with zero applied — that is what makes snap vs no-snap a
	// comparison between two measured populations instead of one against a blank.
	const m = parseRunMetrics(snapLog([snapStep(1, { snapDistancePx: 44 }), snapStep(2, { snapDistancePx: 46 })]));
	assert.equal(m.snapCandidateSteps, 2);
	assert.equal(m.snapAppliedSteps, 0);
	assert.equal(m.snapDeclaredMismatches, 0);
	assert.equal(m.snapMeanDistancePx, 45);
});

test("parseRunMetrics__OmitsEverySnapField__When__NoStepCarriedSnapData", () => {
	// An element-addressed arm names no pixels, so it has no denominator. Absent, not 0: a 0 here
	// would claim the points never landed near a control rather than that there were no points.
	const m = parseRunMetrics(snapLog([{ index: 1, observationNodes: 221 }, { index: 2 }]));
	for (const field of ["snapCandidateSteps", "snapAppliedSteps", "snapDeclaredMismatches", "snapMeanDistancePx", "snapInsideSteps"]) {
		assert.ok(!(field in m), `${field} must be absent, not present — got ${JSON.stringify((m as Record<string, unknown>)[field])}`);
	}
});

test("parseRunMetrics__OmitsMeanDistanceRatherThanNaN__When__NoStepHadACandidate", () => {
	// The zero-candidate mean is the arithmetic trap: sum 0 over count 0 is NaN, and NaN survives
	// JSON.stringify as `null`, which every downstream reader would take for a real measurement.
	const m = parseRunMetrics(snapLog([]));
	assert.equal(m.snapMeanDistancePx, undefined);
	assert.ok(!Number.isNaN(m.snapMeanDistancePx as unknown as number));
	assert.equal(JSON.parse(JSON.stringify(m)).snapMeanDistancePx, undefined);
});
