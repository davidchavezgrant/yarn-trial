/**
 * The head-to-head slice. OpenAI is the default and runs the full matrix; Claude is the
 * challenger, tested against what that pass found to win.
 *
 * The tests that matter here are about the SELECTION, not the dispatch: picking the wrong
 * two arms spends the entire challenger budget answering the wrong question, and unlike a
 * crash it leaves data that looks fine.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CHALLENGER_N, challengerNeedsExplore, planChallenger, scoreArms } from "../src/bench/challenger.js";
import type { Manifest, ManifestEntry, RunMetrics } from "../src/bench/manifest.js";

const PRIMARY = "azure/gpt-5.6-sol";

const entry = (armId: string, jobId: string, metrics: RunMetrics, model = PRIMARY): ManifestEntry => ({
	armId,
	jobId,
	host: "mac1",
	submittedAt: "2026-07-31T00:00:00Z",
	state: "done",
	collected: true,
	model,
	metrics,
});

const manifest = (entries: ManifestEntry[]): Manifest => ({ date: "2026-07-31", createdAt: "2026-07-31T00:00:00Z", entries });

/** Three arms of clearly different quality, so ranking is unambiguous. */
const SPREAD = manifest([
	entry("ax-grounded", "a1", { success: true, steps: 5 }),
	entry("ax-grounded", "a2", { success: true, steps: 5 }),
	entry("ax-ungrounded", "b1", { success: true, steps: 12 }),
	entry("ax-ungrounded", "b2", { success: false, steps: 15 }),
	entry("vision-only-ungrounded", "c1", { success: false, steps: 15 }),
	entry("vision-only-ungrounded", "c2", { success: false, steps: 15 }),
]);

test("scoreArms__ScoresOnlyTheGivenModelsRuns__When__TwoPassesShareAManifest", () => {
	const m = manifest([...SPREAD.entries, entry("ax-grounded", "x1", { success: false, steps: 30 }, "claude-fable-5")]);
	const grounded = scoreArms(m, PRIMARY).find((s) => s.armId === "ax-grounded");
	// The challenger's own run must not drag down the primary's score — that would let the
	// challenger influence the choice of the arm it is about to be measured on.
	assert.equal(grounded?.runs, 2);
	assert.equal(grounded?.successRate, 1);
});

test("planChallenger__PicksTheWinnerAndTheHardestArm__When__PhaseTwoIsCollected", () => {
	const plan = planChallenger(SPREAD, PRIMARY);
	assert.ok(plan);
	assert.equal(plan.winner.armId, "ax-grounded");
	// The divergence arm is where the primary struggled most — the place a different model is
	// most likely to behave differently, and the reason the slice is not just the winner.
	assert.equal(plan.divergence.armId, "vision-only-ungrounded");
	assert.equal(plan.arms.length, 2);
});

test("planChallenger__BreaksSuccessTiesByFewerSteps__When__TwoArmsBothAlwaysSucceed", () => {
	const m = manifest([
		entry("ax-grounded", "a1", { success: true, steps: 9 }),
		entry("cdp-grounded", "b1", { success: true, steps: 4 }),
		entry("ax-ungrounded", "c1", { success: false, steps: 15 }),
	]);
	const plan = planChallenger(m, PRIMARY);
	// Both succeed; the cheaper one wins. Success rate alone would have made this a coin flip.
	assert.equal(plan?.winner.armId, "cdp-grounded");
});

test("planChallenger__StillSpansTwoArms__When__EveryArmScoresIdentically", () => {
	const m = manifest([
		entry("ax-grounded", "a1", { success: true, steps: 5 }),
		entry("cdp-grounded", "b1", { success: true, steps: 5 }),
	]);
	const plan = planChallenger(m, PRIMARY);
	assert.ok(plan);
	// Best and worst coincide when everything ties; the slice must not spend both budgets on
	// one arm and call it a two-arm comparison.
	assert.notEqual(plan.winner.armId, plan.divergence.armId);
});

test("planChallenger__ReturnsUndefined__When__ThePrimaryHasNotRun", () => {
	// Guessing a winner from no data would aim the whole challenger budget arbitrarily.
	assert.equal(planChallenger(manifest([]), PRIMARY), undefined);
	assert.equal(planChallenger(SPREAD, "some-other-model"), undefined);
});

test("planChallenger__WarnsAgainstComparingTokens__When__ItReportsItsPlan", () => {
	// Claude 4.7+ tokenises ~30% higher for identical text, so a cross-model token delta
	// measures tokenisers as much as efficiency. The caveat ships with the plan rather than
	// living in someone's memory.
	assert.match(planChallenger(SPREAD, PRIMARY)?.notes.join("\n") ?? "", /STEPS and ACTIONS, never tokens/);
	assert.match(planChallenger(SPREAD, PRIMARY)?.notes.join("\n") ?? "", new RegExp(`n=${CHALLENGER_N}`));
});

test("challengerNeedsExplore__RequiresTheChallengersOwnMap__When__AnArmIsGrounded", () => {
	const plan = planChallenger(SPREAD, PRIMARY);
	assert.ok(plan);
	// ax-grounded consumes a map, and each model grounds itself — the challenger cannot
	// inherit the primary's appmap.
	assert.equal(challengerNeedsExplore(plan)?.id, "explore-ax");
});

test("challengerNeedsExplore__SkipsTheExplore__When__NeitherArmConsumesAMap", () => {
	const m = manifest([
		entry("ax-ungrounded", "a1", { success: true, steps: 8 }),
		entry("vision-only-ungrounded", "b1", { success: false, steps: 15 }),
	]);
	const plan = planChallenger(m, PRIMARY);
	assert.ok(plan);
	// Paying for an explore whose map nothing reads is pure waste — explores are the most
	// expensive runs in the matrix.
	assert.equal(challengerNeedsExplore(plan), undefined);
});

test("challengerNeedsExplore__PicksTheVisionPass__When__TheGroundedArmIsVisionOnly", () => {
	const m = manifest([
		entry("vision-only-grounded-visionmap", "a1", { success: true, steps: 6 }),
		entry("ax-ungrounded", "b1", { success: false, steps: 15 }),
	]);
	const plan = planChallenger(m, PRIMARY);
	assert.ok(plan);
	// A vision-only arm reads the `.vision` map, a different artifact from the ax pass's —
	// grounding it with the wrong explore would silently measure the wrong tier.
	assert.equal(challengerNeedsExplore(plan)?.id, "explore-vision");
});
