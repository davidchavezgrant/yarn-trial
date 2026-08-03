import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { aggregateRunEvents, appendNarrativeEvent, basicAuthGate, buildDetail, buildState, type DashEvent, defaultDashDate, exploreSeries, type FleetView, freezeStates, fromStore, groundingArmId, legacyNarrativeLogPath, loadEnvFallback, localRunProgress, matchPath, narrativeLogPath, type NarrativeEvent, narratorPrompt, notedRunKeys, parseDashArgs, parseEnvLine, parseLogFrames, parseRunEvents, rankExplore, readPersistedNarrative, runEventLine, type RunProgress, storeEvents, utf8Tail, watchStoreChain } from "../src/bench/dash.js";
import { exportSnapshot } from "../src/bench/snapshot.js";
// The submodule, not the core/harness.ts barrel: the barrel loads the Anthropic SDK and the
// cua driver, which a unit test of a 30-line appender has no business paying for.
import { runEvent, usageEvent } from "../src/core/harness/run-events.js";
import { estimateCost } from "../src/bench/cost.js";
import type { Manifest, ManifestEntry } from "../src/bench/manifest.js";
import { MATRIX, armAppmapSlug, armById } from "../src/bench/matrix.js";

/**
 * The dashboard's state assembly, pure by construction: manifest + fleet snapshot in,
 * wire JSON out. The live-status mapping is the part worth testing — it is the one place
 * the dashboard makes its own call (running/queued/awaiting-collect) instead of relaying
 * numbers the report's rollup() already computed and bench.test.ts already covers.
 */

const entry = (over: Partial<ManifestEntry>): ManifestEntry => ({
	armId: "ax-grounded",
	jobId: "job-1",
	host: "mac1",
	submittedAt: "2026-07-31T20:00:00.000Z",
	state: "running",
	collected: false,
	...over,
});

const manifest = (...entries: ManifestEntry[]): Manifest => ({ date: "2026-07-31", createdAt: "2026-07-31T19:00:00.000Z", entries });

const fleet = (rows: FleetView["rows"]): FleetView => ({ rows, polledAt: "2026-07-31T20:05:00.000Z" });

const armView = (state: ReturnType<typeof buildState>, id: string) => state.arms.find((a) => a.id === id);

test("BuildState__MarksEntryRunning__When__FleetRowHoldsItsJob", () => {
	const s = buildState(
		manifest(entry({})),
		fleet([{ name: "mac1", reachable: true, state: "busy", jobId: "job-1", elapsedSec: 42, stalled: true }]),
		[],
		true,
	);
	const e = armView(s, "ax-grounded")?.passes[0]?.entries[0];
	assert.equal(e?.status, "running");
	assert.equal(e?.elapsedSec, 42);
	assert.equal(e?.stalled, true);
	assert.equal(s.progress.running, 1);
});

test("BuildState__MarksEntryQueued__When__JobWaitsInHostQueue", () => {
	const s = buildState(
		manifest(entry({ jobId: "job-2", state: "queued" })),
		fleet([{ name: "mac1", reachable: true, state: "busy", jobId: "job-1", queue: [{ jobId: "other" }, { jobId: "job-2" }] }]),
		[],
		true,
	);
	const e = armView(s, "ax-grounded")?.passes[0]?.entries[0];
	assert.equal(e?.status, "queued");
	assert.equal(e?.queuePosition, 2);
});

test("BuildState__MarksAwaitingCollect__When__HostAnsweredWithoutTheJob", () => {
	const s = buildState(manifest(entry({})), fleet([{ name: "mac1", reachable: true, state: "idle" }]), [], true);
	assert.equal(armView(s, "ax-grounded")?.passes[0]?.entries[0]?.status, "awaiting-collect");
});

test("BuildState__MarksEntryFailed__When__HostRegistryReportsTheJobDied", () => {
	// The window this exists for: the run died on the Mac, no collect pass has happened, and
	// the host answered without the job. Before the registry feed, that rendered as the same
	// amber "awaiting-collect" as a healthy finish. `orphaned` maps to "crashed" — collect's
	// own failureKind vocabulary — and `stopped` passes through.
	const s = buildState(
		manifest(entry({}), entry({ jobId: "job-2" }), entry({ jobId: "job-3" })),
		fleet([
			{
				name: "mac1",
				reachable: true,
				state: "idle",
				recent: [
					{ jobId: "job-1", state: "failed", exitCode: 1, endedAt: "2026-07-31T20:04:00.000Z" },
					{ jobId: "job-2", state: "orphaned", exitCode: null },
					{ jobId: "job-3", state: "stopped", exitCode: null },
				],
			},
		]),
		[],
		true,
	);
	const entries = armView(s, "ax-grounded")?.passes[0]?.entries ?? [];
	assert.equal(entries.find((e) => e.jobId === "job-1")?.status, "failed");
	assert.equal(entries.find((e) => e.jobId === "job-2")?.status, "crashed");
	assert.equal(entries.find((e) => e.jobId === "job-3")?.status, "stopped");
});

test("BuildState__KeepsAwaitingCollect__When__HostRegistryReportsTheJobDone", () => {
	// A `done` record finished fine and genuinely is just waiting for a collect pass — the
	// amber chip is the truth, not a failure hiding behind it.
	const s = buildState(
		manifest(entry({})),
		fleet([{ name: "mac1", reachable: true, state: "idle", recent: [{ jobId: "job-1", state: "done", exitCode: 0, endedAt: "2026-07-31T20:04:00.000Z" }] }]),
		[],
		true,
	);
	assert.equal(armView(s, "ax-grounded")?.passes[0]?.entries[0]?.status, "awaiting-collect");
});

test("BuildState__KeepsManifestState__When__FleetSnapshotPredatesTheSubmit", () => {
	// A job submitted AFTER the last fleet poll is absent from that snapshot because the
	// snapshot is older than the job, not because the job ended. The manifest reaches the page
	// in ~300ms (fs-watch) while the fleet is polled every FLEET_POLL_SEC, so every fresh
	// submit used to spend that gap as amber "awaiting-collect" before flipping to Queued.
	// Absence is only evidence of termination when the poll postdates the submit.
	const s = buildState(
		manifest(entry({ state: "queued", submittedAt: "2026-07-31T20:06:00.000Z" })),
		fleet([{ name: "mac1", reachable: true, state: "idle" }]),
		[],
		true,
	);
	assert.equal(armView(s, "ax-grounded")?.passes[0]?.entries[0]?.status, "queued");
});

test("BuildState__KeepsManifestState__When__FleetWasNeverPolled", () => {
	// No polledAt = no snapshot age at all — same conclusion, conservatively: the snapshot
	// cannot testify about the job, so the manifest's state stands.
	const s = buildState(
		manifest(entry({ state: "queued" })),
		{ rows: [{ name: "mac1", reachable: true, state: "idle" }] },
		[],
		true,
	);
	assert.equal(armView(s, "ax-grounded")?.passes[0]?.entries[0]?.status, "queued");
});

test("BuildState__KeepsManifestState__When__HostIsUnreachable", () => {
	// An unreachable host proves nothing about the job, so the last-known state stands.
	const s = buildState(manifest(entry({})), fleet([{ name: "mac1", reachable: false, state: "unknown", reason: "down" }]), [], true);
	assert.equal(armView(s, "ax-grounded")?.passes[0]?.entries[0]?.status, "running");
});

test("BuildState__RollsUpSuccessAndCost__When__EntriesAreCollected", () => {
	const s = buildState(
		manifest(
			entry({
				jobId: "job-ok",
				state: "done",
				collected: true,
				metrics: { success: true, steps: 5, elapsedSec: 205, model: "claude-opus-5", inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 310_000, cacheCreationTokens: 88_000, endedAt: "2026-07-31T20:10:00.000Z" },
			}),
			entry({ jobId: "job-bad", state: "failed", collected: true, metrics: { success: false, failureKind: "unready" } }),
		),
		fleet([]),
		[],
		true,
	);
	const p = armView(s, "ax-grounded")?.passes[0];
	assert.equal(p?.collected, 2);
	assert.equal(p?.successes, 1);
	// The chip's "ran for" readout: the run log's own clock reaches the wire on collected entries.
	const ok = p?.entries.find((e) => e.jobId === "job-ok");
	assert.equal(ok?.elapsedSec, 205);
	// Per-run economics ride the wire so the chip/tooltip can show them (display-only — see EntryView caveat).
	assert.equal(ok?.inputTokens, 1_000_000);
	assert.equal(ok?.outputTokens, 100_000);
	assert.equal(ok?.cacheReadTokens, 310_000);
	assert.equal(ok?.cacheCreationTokens, 88_000);
	// claude-opus-5: $5/M in + $25/M out + $0.50/M cache-read + $6.25/M cache-write
	// → 1M in + 0.1M out + 0.31M read + 0.088M write = $8.205
	assert.ok(Math.abs((p?.usd ?? 0) - 8.205) < 1e-9);
	assert.equal(p?.failureBreakdown, "unready 1");
	assert.equal(s.progress.collected, 2);
	assert.equal(s.progress.successes, 1);
	assert.equal(s.cost.passes[0]?.pass, "(default)");
});

test("BuildState__AccumulatesCostSeries__When__RunsEndInOrder", () => {
	const s = buildState(
		manifest(
			entry({ jobId: "late", state: "done", collected: true, metrics: { success: true, model: "claude-opus-5", outputTokens: 200_000, endedAt: "2026-07-31T21:00:00.000Z" } }),
			entry({ jobId: "early", state: "done", collected: true, metrics: { success: true, model: "claude-opus-5", outputTokens: 100_000, endedAt: "2026-07-31T20:00:00.000Z" } }),
		),
		fleet([]),
		[],
		true,
	);
	assert.deepEqual(s.costSeries.map((p) => p.jobId), ["early", "late"]);
	assert.ok(s.costSeries[1]!.cumulativeUsd > s.costSeries[0]!.cumulativeUsd);
	assert.ok(Math.abs(s.costSeries[1]!.cumulativeUsd - 7.5) < 1e-9);
});

test("BuildState__PricesTokensAtDefaultRates__When__RunRecordedNoModel", () => {
	// Explore stamps record tokens but no model id — these used to count "unpriced" and the
	// hero read "$0.00 +N?". With a default model known they price at its published card,
	// counted separately as ASSUMED so the total never pretends the card was recorded.
	const s = buildState(
		manifest(entry({ jobId: "job-noid", state: "done", collected: true, metrics: { success: true, outputTokens: 100_000, endedAt: "2026-07-31T20:10:00.000Z" } })),
		fleet([]),
		[],
		true,
		"claude-opus-5",
	);
	// claude-opus-5 output $25/M → 0.1M out = $2.50.
	assert.ok(Math.abs(s.cost.totalUsd - 2.5) < 1e-9);
	assert.equal(s.cost.assumedRuns, 1);
	assert.equal(s.cost.unpriced, 0);
	assert.equal(s.cost.passes[0]?.assumed, 1);
	assert.equal(s.cost.passes[0]?.priced, 1);
	// The arm's pass rollup and the spend-so-far line must agree with the hero over the same run.
	const p = armView(s, "ax-grounded")?.passes[0];
	assert.ok(Math.abs((p?.usd ?? 0) - 2.5) < 1e-9);
	assert.equal(p?.unpriced, 0);
	assert.equal(p?.assumed, 1);
	assert.deepEqual(s.costSeries.map((x) => x.jobId), ["job-noid"]);
});

test("BuildState__LeavesRunUnpriced__When__ModelIsUnknownAndNoDefaultExists", () => {
	// An unknown model id must NOT price against a near-miss card, and with no default model
	// there is nothing honest to assume — the run stays visibly unpriced.
	const s = buildState(
		manifest(entry({ jobId: "job-azure", state: "done", collected: true, metrics: { success: true, model: "azure-mystery", outputTokens: 100_000 } })),
		fleet([]),
		[],
		true,
	);
	assert.equal(s.cost.totalUsd, 0);
	assert.equal(s.cost.unpriced, 1);
	assert.equal(s.cost.assumedRuns, 0);
	assert.equal(s.costSeries.length, 0);
	assert.equal(armView(s, "ax-grounded")?.passes[0]?.unpriced, 1);
});

test("BuildState__ExcludesTokenlessEntriesFromPricing__When__EntriesRecordNoTokens", () => {
	// Compiles (no metrics at all) and failed runs whose metrics carry no token fields cost
	// nothing and prove nothing — they must not surface as unpriced "+N?" on the hero.
	// "Unpriced" stays reserved for runs that DID spend tokens nobody could price.
	const s = buildState(
		manifest(
			entry({ armId: "compile-ax", jobId: "compile-refused", host: "local", state: "failed", collected: true, note: "compile refused: hinted run" }),
			entry({ jobId: "job-ok", state: "done", collected: true, metrics: { success: true, model: "claude-opus-5", outputTokens: 100_000, endedAt: "2026-07-31T20:10:00.000Z" } }),
			entry({ jobId: "job-bad", state: "failed", collected: true, metrics: { success: false, failureKind: "unready" } }),
		),
		fleet([]),
		[],
		true,
	);
	// claude-opus-5 output $25/M → 0.1M out = $2.50; the other two entries contribute nothing.
	assert.ok(Math.abs(s.cost.totalUsd - 2.5) < 1e-9);
	assert.equal(s.cost.unpriced, 0);
	assert.equal(s.cost.assumedRuns, 0);
	assert.equal(s.cost.passes[0]?.priced, 1);
	assert.equal(s.cost.passes[0]?.unpriced, 0);
	assert.equal(s.costSeries.length, 1);
	// Per-arm rollups agree: the tokenless failure sits in the same pass as the priced run.
	assert.equal(armView(s, "ax-grounded")?.passes[0]?.unpriced, 0);
	assert.equal(armView(s, "compile-ax")?.passes[0]?.unpriced, 0);
});

test("BuildState__MarksCompileRefused__When__CollectedEntryFailedWithoutMetrics", () => {
	// A refused compile is recorded collected with state "failed" and NO metrics (orchestrate's
	// runCompiles) — before this, the wire derived "collected" and the board rendered a
	// refusal as Collected. Metrics absent → the manifest's own state decides.
	const s = buildState(
		manifest(
			entry({ armId: "compile-ax", jobId: "compile-refused", host: "local", state: "failed", collected: true, note: "compile refused: hinted run" }),
			entry({ armId: "compile-cdp", jobId: "compile-ok", host: "local", state: "done", collected: true }),
		),
		fleet([]),
		[],
		true,
	);
	assert.equal(armView(s, "compile-ax")?.passes[0]?.entries[0]?.status, "refused");
	// A succeeded compile still reads "collected" — there is no run log to grade it further.
	assert.equal(armView(s, "compile-cdp")?.passes[0]?.entries[0]?.status, "collected");
});

test("BuildState__MarksEntryCrashed__When__CollectedFailureCarriesOnlyTechnical", () => {
	// The live case (explore-2026-08-01T08-01-31-073-yarn): a failed explore pass HAS metrics
	// (whatever the stamp parse salvaged) but no success/failureKind — collect computes neither
	// for explores. Its failure lives in `technical` + state "failed", which entryView used to
	// ignore once metrics existed: the board painted the failure as a gray Collected chip the
	// moment it was collected, and no client color map could ever redden a "collected" status.
	const s = buildState(
		manifest(entry({
			armId: "explore-ax",
			jobId: "explore-dead",
			state: "failed",
			collected: true,
			technical: { kind: "crashed", detail: "explore produced no published map — nothing for a later phase to ground on" },
			metrics: { exploreActions: 4 },
		})),
		fleet([]),
		[],
		true,
	);
	assert.equal(armView(s, "explore-ax")?.passes[0]?.entries[0]?.status, "crashed");
});

test("BuildState__MarksEntryFailed__When__CollectedEntryFailedWithMetricsButNoVerdict", () => {
	// An explore that died AFTER publishing its map: state "failed", no technical ruling, and
	// metrics carrying only the stamp. The manifest's own state is still a failure signal —
	// metrics existing must not silence it.
	const s = buildState(
		manifest(entry({ armId: "explore-ax", jobId: "explore-late-death", state: "failed", collected: true, metrics: { graphNodes: 150 } })),
		fleet([]),
		[],
		true,
	);
	assert.equal(armView(s, "explore-ax")?.passes[0]?.entries[0]?.status, "failed");
});

test("BuildState__MarksGroundingMismatch__When__SuccessTrueRunGotTheWrongGrounding", () => {
	// grounding-mismatch is the one failureKind that can sit on a success-true run (the number
	// is real but mislabelled; collect evicts the row as a non-sample). failureKind must
	// outrank the run's own success verdict or the board shows green Succeeded on a row the
	// arm's averages refuse to count.
	const s = buildState(
		manifest(entry({ jobId: "job-mislabelled", state: "done", collected: true, metrics: { success: true, failureKind: "grounding-mismatch" } })),
		fleet([]),
		[],
		true,
	);
	assert.equal(armView(s, "ax-grounded")?.passes[0]?.entries[0]?.status, "grounding-mismatch");
});

test("BuildState__ReportsDisagreement__When__SelfReportContradictsJudge", () => {
	const s = buildState(
		manifest(entry({ jobId: "job-lie", state: "done", collected: true, metrics: { success: true, judgeTrajectory: "FAIL", judgeScope: "document" } })),
		fleet([]),
		[],
		true,
	);
	assert.equal(s.judge.judged, 1);
	assert.equal(s.judge.trajectory.fail, 1);
	assert.deepEqual(s.judge.disagreements.map((d) => d.jobId), ["job-lie"]);
});

test("BuildState__CarriesExploreStamp__When__ArmIsExplore", () => {
	const s = buildState(
		manifest(
			entry({
				armId: "explore-ax",
				jobId: "explore-1",
				state: "done",
				collected: true,
				metrics: { controlsActuated: 47, controlsDismissed: 350, controlsSeen: 396, surfaces: 34, graphNodes: 150, scopeAmbiguities: 10 },
			}),
		),
		fleet([]),
		[],
		true,
	);
	const p = armView(s, "explore-ax")?.passes[0];
	assert.equal(p?.explore?.controlsActuated, 47);
	assert.equal(p?.explore?.controlsSeen, 396);
	assert.equal(p?.explore?.scopeAmbiguities, 10);
});

// Three explore passes for one arm, the middle one a degenerate husk (the 8-node map class
// the multi-pass matrix exists to catch): medians must ignore it where a mean would not.
const explorePasses = () =>
	manifest(
		entry({
			armId: "explore-ax",
			jobId: "explore-a",
			state: "done",
			collected: true,
			metrics: { exploreActions: 96, exploreElapsed: "40m12s", controlsSeen: 396, controlsActuated: 47, controlsDismissed: 350, surfaces: 34, graphNodes: 150, graphEdges: 60, scopeAmbiguities: 10 },
		}),
		entry({
			armId: "explore-ax",
			jobId: "explore-husk",
			state: "done",
			collected: true,
			metrics: { exploreActions: 5, exploreElapsed: "3m01s", controlsSeen: 12, controlsActuated: 3, controlsDismissed: 2, surfaces: 3, graphNodes: 8, graphEdges: 2, scopeAmbiguities: 0 },
		}),
		entry({
			armId: "explore-ax",
			jobId: "explore-c",
			state: "done",
			collected: true,
			metrics: { exploreActions: 90, exploreElapsed: "38m40s", controlsSeen: 380, controlsActuated: 41, controlsDismissed: 300, surfaces: 30, graphNodes: 142, graphEdges: 55, scopeAmbiguities: 8 },
		}),
	);

test("BuildState__MediansExploreAggregates__When__ADegeneratePassLands", () => {
	const s = buildState(explorePasses(), fleet([]), [], true);
	const ex = armView(s, "explore-ax")?.passes[0]?.explore;
	// Median of {96,5,90} = 90 — the husk cannot drag the arm's numbers the way a mean would.
	assert.equal(ex?.actions, 90);
	assert.equal(ex?.controlsSeen, 380);
	assert.equal(ex?.controlsActuated, 41);
	assert.equal(ex?.controlsDismissed, 300);
	assert.equal(ex?.surfaces, 30);
	assert.equal(ex?.graphNodes, 142);
	assert.equal(ex?.graphEdges, 55);
	assert.equal(ex?.scopeAmbiguities, 8);
	// elapsed is a display string, not a number — the first collected pass's stamp rides verbatim.
	assert.equal(ex?.elapsed, "40m12s");
});

test("BuildState__CarriesPerEntryExploreStamp__When__PassesDiffer", () => {
	const s = buildState(explorePasses(), fleet([]), [], true);
	const entries = armView(s, "explore-ax")?.passes[0]?.entries;
	const a = entries?.find((e) => e.jobId === "explore-a");
	const husk = entries?.find((e) => e.jobId === "explore-husk");
	// Each entry keeps ITS pass's own numbers — the dropdown shows these, the row the medians.
	assert.equal(a?.exploreStamp?.actions, 96);
	assert.equal(a?.exploreStamp?.graphNodes, 150);
	assert.equal(husk?.exploreStamp?.graphNodes, 8);
	assert.equal(husk?.exploreStamp?.controlsSeen, 12);
});

test("BuildState__OmitsExploreStamp__When__EntryIsATaskRun", () => {
	const s = buildState(
		manifest(entry({ jobId: "job-task", state: "done", collected: true, metrics: { success: true, steps: 5 } })),
		fleet([]),
		[],
		true,
	);
	assert.equal(armView(s, "ax-grounded")?.passes[0]?.entries[0]?.exploreStamp, undefined);
});

test("RankExplore__OrdersByNodesThenTiebreaks__When__PassesCompete", () => {
	const ranks = rankExplore([
		{ graphNodes: 150, surfaces: 20, controlsActuated: 47 },
		{ graphNodes: 8, surfaces: 3, controlsActuated: 5 },
		{ graphNodes: 150, surfaces: 34, controlsActuated: 41 }, // node tie → surfaces break it
		{ surfaces: 99, controlsActuated: 99 }, // no graphNodes — sorts below any recorded map
	]);
	assert.deepEqual(ranks, [2, 3, 1, 4]);
});

test("BuildState__RanksExplorePassesPerTarget__When__MultipleArmsCollected", () => {
	const s = buildState(
		manifest(
			entry({ armId: "explore-ax", jobId: "e-ax", state: "done", collected: true, metrics: { graphNodes: 150, surfaces: 30, controlsActuated: 40 } }),
			entry({ armId: "explore-cdp", jobId: "e-cdp", state: "done", collected: true, metrics: { graphNodes: 90, surfaces: 28, controlsActuated: 44 } }),
			entry({ jobId: "job-task", state: "done", collected: true, metrics: { success: true, steps: 5 } }),
		),
		fleet([]),
		[],
		true,
	);
	assert.deepEqual(armView(s, "explore-ax")?.passes[0]?.exploreRank, { rank: 1, of: 2 });
	assert.deepEqual(armView(s, "explore-cdp")?.passes[0]?.exploreRank, { rank: 2, of: 2 });
	// Task arms never rank.
	assert.equal(armView(s, "ax-grounded")?.passes[0]?.exploreRank, undefined);
});

test("BuildState__ExposesLineageAndTargetKey__When__ArmsRideTheWire", () => {
	// The board nests task/replay arms under the explore pass that grounded them, and the
	// scope picker keys off targetKey — both must ride the wire for every arm.
	const s = buildState(manifest(), fleet([]), [], false);
	const byId = (id: string) => s.arms.find((a) => a.id === id);
	assert.equal(byId("ax-grounded")?.groundedBy, "explore-ax");
	assert.equal(byId("cdp-grounded")?.groundedBy, "explore-cdp");
	// Curated (USE_RECIPE) arms are grounded — they nest too.
	// The curated tier moved to cdp on 2026-08-01 — it measures ONBOARDING COST, which should be
	// read on the shipping actuator, and it has no ax twin so it was never a comparison.
	assert.equal(byId("curated")?.groundedBy, "explore-cdp");
	// Replays consume the same lineage as the run they were compiled from.
	assert.equal(byId("replay-cdp")?.groundedBy, "explore-cdp");
	// Ungrounded arms and explore/compile arms carry no lineage.
	assert.equal(byId("ax-ungrounded")?.groundedBy, undefined);
	assert.equal(byId("explore-ax")?.groundedBy, undefined);
	assert.equal(byId("compile-ax")?.groundedBy, undefined);
	assert.ok(s.arms.every((a) => typeof a.targetKey === "string" && a.targetKey.length > 0));
	assert.equal(byId("ax-grounded")?.targetKey, "Yarn");
});

// The Sees check columns: perception as per-channel booleans, derived from the arm's
// dispatch flags (never parsed from the perception string). The four dispatch shapes below
// cover every branch: cdp (DOM only), plain ax (AX + DOM attrs), noAx (Vision only),
// axdomOff + noVision (bare AX tree).
test("BuildState__SeesAxDomVision__When__AxArmRunsFullPerception", () => {
	const s = buildState(manifest(), fleet([]), [], false);
	assert.deepEqual(armView(s, "ax-grounded")?.sees, { ax: true, dom: true, vision: true });
});

test("BuildState__SeesDomWithoutAx__When__ArmRunsTheCdpBackend", () => {
	const s = buildState(manifest(), fleet([]), [], false);
	assert.deepEqual(armView(s, "cdp-grounded")?.sees, { ax: false, dom: true, vision: true });
});

test("BuildState__SeesOnlyVision__When__ArmDeclaresNoAx", () => {
	const s = buildState(manifest(), fleet([]), [], false);
	assert.deepEqual(armView(s, "explore-vision")?.sees, { ax: false, dom: false, vision: true });
});

test("BuildState__SeesBareAx__When__ArmRunsAxdomOffWithoutVision", () => {
	const s = buildState(manifest(), fleet([]), [], false);
	assert.deepEqual(armView(s, "min-context-grounded")?.sees, { ax: true, dom: false, vision: false });
});

test("BuildState__OmitsArmPasses__When__NothingSubmitted", () => {
	// Every MATRIX arm rides the wire so the page can show the whole plan, but an arm with
	// no submissions carries no pass — the page reads passes.length as "not started".
	const s = buildState(manifest(), fleet([]), [], false);
	assert.ok(s.arms.length > 20);
	assert.ok(s.arms.every((a) => a.passes.length === 0));
	assert.equal(s.progress.submitted, 0);
});

// --- run detail: the appmap walk ---

const GRAPH = {
	nodes: [
		{ id: "brand-kit", title: "Brand Kit", kind: "surface", scope: "brand" },
		{ id: "brand-kit/screen-clips", title: "Screen Clips", kind: "surface", scope: "brand" },
		{ id: "brand-kit/screen-clips/cursor-style", title: "Cursor Style", kind: "control", scope: "brand", settingKey: "cursor-style" },
		{ id: "draft/design", title: "Design", kind: "surface", scope: "document" },
		{ id: "draft/design/cursor-style", title: "Cursor Style", kind: "control", scope: "document", settingKey: "cursor-style" },
	],
	edges: [
		{ from: "root", to: "brand-kit", action: 'click "Brand Kit" in the far-left sidebar' },
		{ from: "brand-kit", to: "brand-kit/screen-clips", action: 'click "Screen Clips" in the tab list' },
	],
};

const rawStep = (index: number, targetName: string | undefined, over: Record<string, unknown> = {}) => ({
	index,
	action: { kind: "tool", name: "click", args: {} },
	verified: true,
	...(targetName ? { targetName } : {}),
	...over,
});

test("MatchPath__MarksSurfaceTransitions__When__EdgeQuotedNamesMatchTargets", () => {
	const steps = matchPath(GRAPH, [rawStep(0, "Brand Kit"), rawStep(1, "Screen Clips")]);
	assert.equal(steps[0]?.edgeTo, "brand-kit");
	assert.equal(steps[1]?.edgeTo, "brand-kit/screen-clips");
	assert.equal(steps[1]?.surface, "brand-kit/screen-clips");
});

test("MatchPath__PrefersControlUnderCurrentSurface__When__TitlesCollide", () => {
	// Two "Cursor Style" controls exist (brand vs document scope) — after walking to
	// Screen Clips, the click must anchor to THAT surface's control, not the draft's.
	const steps = matchPath(GRAPH, [rawStep(0, "Brand Kit"), rawStep(1, "Screen Clips"), rawStep(2, "Cursor Style")]);
	assert.equal(steps[2]?.nodeId, "brand-kit/screen-clips/cursor-style");
});

test("MatchPath__LeavesStepUnanchored__When__NothingMatches", () => {
	const steps = matchPath(GRAPH, [rawStep(0, "Mystery Button"), rawStep(1, undefined, { action: { kind: "key", key: "escape" } })]);
	assert.equal(steps[0]?.nodeId, undefined);
	assert.equal(steps[0]?.edgeTo, undefined);
	assert.equal(steps[1]?.label, "key escape");
});

test("GroundingArmId__PicksTheMapTheArmConsumed__When__TaskArm", () => {
	assert.equal(groundingArmId(armById("cdp-grounded")!), "explore-cdp");
	assert.equal(groundingArmId(armById("ax-grounded")!), "explore-ax");
	assert.equal(groundingArmId(armById("vision-only-grounded-visionmap")!), "explore-vision");
});

test("BuildDetail__WalksRunThroughLiveMap__When__NoArchiveExists", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-detail-"));
	try {
		fs.mkdirSync(path.join(dir, "docs", "appmaps"), { recursive: true });
		fs.mkdirSync(path.join(dir, "out", "runs"), { recursive: true });
		fs.writeFileSync(path.join(dir, "docs", "appmaps", "yarn.json"), JSON.stringify(GRAPH));
		fs.writeFileSync(
			path.join(dir, "out", "runs", "job-d.json"),
			JSON.stringify({ task: "show me how to change the cursor type", steps: [rawStep(0, "Brand Kit"), rawStep(1, "Screen Clips"), rawStep(2, "Cursor Style")] }),
		);
		const m = manifest(entry({ jobId: "job-d", state: "done", collected: true }));
		const d = buildDetail("job-d", m, { dataDir: dir, benchRoot: path.join(dir, "bench") });
		assert.equal(d.graphSource, "docs/appmaps/yarn.json (live)");
		assert.equal(d.steps.length, 3);
		assert.equal(d.steps[2]?.nodeId, "brand-kit/screen-clips/cursor-style");
		// The run log's task rides the detail — the page's prompt fallback for replay rows.
		assert.equal(d.task, "show me how to change the cursor type");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * The Take column's data. These drive `outDir()` through YARN_RUNNER_DATA rather than a
 * dataDir argument, because that is the only lever entryView has — buildState takes no root,
 * and the alternative (planting a file under the real out/bench/live) would write into the
 * operator's own store from a unit test.
 */
const withDataRoot = (body: (dir: string) => void): void => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-take-"));
	const saved = process.env.YARN_RUNNER_DATA;
	try {
		process.env.YARN_RUNNER_DATA = dir;
		body(dir);
	} finally {
		if (saved === undefined) delete process.env.YARN_RUNNER_DATA;
		else process.env.YARN_RUNNER_DATA = saved;
		fs.rmSync(dir, { recursive: true, force: true });
	}
};

const plantRecording = (dir: string, jobId: string, file: string): void => {
	const rec = path.join(dir, "out", "bench", "live", jobId, "recording");
	fs.mkdirSync(rec, { recursive: true });
	fs.writeFileSync(path.join(rec, file), "BYTES");
};

test("BuildState__MarksTheEntry__When__ItsCursorRenderIsOnThisMachine", () => {
	withDataRoot((dir) => {
		// Only the render planted: the flag must not depend on metrics, a graph or a run log — a
		// filmed run whose other artifacts never landed still has a take worth watching.
		plantRecording(dir, "job-1", "humanized.mp4");
		const s = buildState(manifest(entry({})), fleet([{ name: "mac1", reachable: true, state: "idle" }]), [], true);
		assert.equal(armView(s, "ax-grounded")?.passes[0]?.entries[0]?.video, true);
	});
});

test("BuildState__OmitsTheEntrysTake__When__OnlyTheRawCaptureIsPresent", () => {
	withDataRoot((dir) => {
		// The cursorless capture is not the artifact: offering it as "the take" would play a
		// recording of a UI operating itself with no pointer, which reads as a broken video.
		plantRecording(dir, "job-1", "window.mp4");
		const s = buildState(manifest(entry({})), fleet([{ name: "mac1", reachable: true, state: "idle" }]), [], true);
		assert.equal(armView(s, "ax-grounded")?.passes[0]?.entries[0]?.video, undefined);
	});
});

test("BuildState__MarksAnUncollectedEntry__When__ItsRenderLandedBeforeCollect", () => {
	withDataRoot((dir) => {
		// The uncollected branch matters on its own: a hand-pulled or ad-hoc run has its render
		// before any collect banks its numbers, and the column exists to reach footage.
		plantRecording(dir, "job-1", "humanized.mp4");
		const s = buildState(manifest(entry({ collected: false, state: "running" })), fleet([{ name: "mac1", reachable: true, state: "busy", jobId: "job-1" }]), [], true);
		const e = armView(s, "ax-grounded")?.passes[0]?.entries[0];
		assert.equal(e?.collected, false);
		assert.equal(e?.video, true);
	});
});

test("BuildDetail__AggregatesHeatAcrossCollectedRuns__When__RunsShareTheGraph", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-heat-"));
	try {
		fs.mkdirSync(path.join(dir, "docs", "appmaps"), { recursive: true });
		fs.mkdirSync(path.join(dir, "out", "runs"), { recursive: true });
		fs.writeFileSync(path.join(dir, "docs", "appmaps", "yarn.json"), JSON.stringify(GRAPH));
		const walk = { steps: [rawStep(0, "Brand Kit"), rawStep(1, "Screen Clips"), rawStep(2, "Cursor Style")] };
		fs.writeFileSync(path.join(dir, "out", "runs", "job-h1.json"), JSON.stringify(walk));
		fs.writeFileSync(path.join(dir, "out", "runs", "job-h2.json"), JSON.stringify(walk));
		const m = manifest(
			entry({ jobId: "job-h1", state: "done", collected: true }),
			entry({ jobId: "job-h2", state: "done", collected: true }),
		);
		const d = buildDetail("job-h1", m, { dataDir: dir, benchRoot: path.join(dir, "bench") });
		// Both runs walked root→brand-kit→screen-clips and hit the brand cursor control.
		assert.equal(d.heat?.runs, 2);
		assert.equal(d.heat?.surfaces["brand-kit"], 2);
		assert.equal(d.heat?.surfaces["brand-kit/screen-clips"], 2);
		assert.equal(d.heat?.controls["brand-kit/screen-clips/cursor-style"], 2);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("BuildDetail__QualifiesBareGatedIds__When__AppmapRecordsThemUnpathed", () => {
	// The appmap writer records gated ids bare ("cursor-style"); graph node ids are
	// path-qualified. The shape step must resolve them or gated rings never render.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-gated-"));
	try {
		fs.mkdirSync(path.join(dir, "docs", "appmaps"), { recursive: true });
		fs.mkdirSync(path.join(dir, "out", "runs"), { recursive: true });
		fs.writeFileSync(path.join(dir, "docs", "appmaps", "yarn.json"), JSON.stringify({ ...GRAPH, gated: [{ id: "cursor-style" }, { id: "brand-kit" }] }));
		fs.writeFileSync(path.join(dir, "out", "runs", "job-g.json"), JSON.stringify({ steps: [] }));
		const m = manifest(entry({ jobId: "job-g", state: "done", collected: true }));
		const d = buildDetail("job-g", m, { dataDir: dir, benchRoot: path.join(dir, "bench") });
		// Suffix matches resolve to BOTH same-named controls; an exact match passes through.
		assert.deepEqual(
			(d.graph?.gated ?? []).sort(),
			["brand-kit", "brand-kit/screen-clips/cursor-style", "draft/design/cursor-style"],
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/*
 * /api/logs frame parsing. The runner's `logs` reply is NDJSON — zero or more chunk frames
 * then one terminal frame — and ssh.ts's lastFrame() keeps only the LAST parseable object,
 * which here would silently drop every chunk. parseLogFrames is the pure fold the endpoint
 * forwards.
 */

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

test("ParseLogFrames__AccumulatesChunksAndTerminalState__When__StreamHasChunksAndDone", () => {
	const stdout = [
		JSON.stringify({ ok: true, jobId: "j", chunk: b64("hello "), nextOffset: 6 }),
		JSON.stringify({ ok: true, jobId: "j", chunk: b64("world"), nextOffset: 11 }),
		JSON.stringify({ ok: true, jobId: "j", done: true, nextOffset: 11, state: "running", exitCode: null }),
	].join("\n");
	const f = parseLogFrames(stdout);
	assert.equal(Buffer.from(f.chunkB64, "base64").toString("utf8"), "hello world");
	assert.equal(f.nextOffset, 11);
	assert.equal(f.state, "running");
	assert.equal(f.exitCode, null);
	assert.equal(f.error, undefined);
});

test("ParseLogFrames__ReturnsEmptyChunk__When__StreamIsDoneOnly", () => {
	const f = parseLogFrames(`${JSON.stringify({ ok: true, jobId: "j", done: true, nextOffset: 42, state: "done", exitCode: 0 })}\n`);
	assert.equal(f.chunkB64, "");
	assert.equal(f.nextOffset, 42);
	assert.equal(f.state, "done");
	assert.equal(f.exitCode, 0);
});

test("ParseLogFrames__ReportsError__When__RunnerRefused", () => {
	const f = parseLogFrames(JSON.stringify({ ok: false, error: "no jobs on this host" }));
	assert.equal(f.error, "no jobs on this host");
	assert.equal(f.chunkB64, "");
	assert.equal(f.state, "unknown");
});

test("ParseLogFrames__IgnoresGarbageLines__When__BannersAndPartialJsonInterleave", () => {
	const stdout = [
		"Warning: Permanently added 'mac2' (ED25519) to the list of known hosts.",
		"{not json at all",
		JSON.stringify({ ok: true, jobId: "j", chunk: b64("data"), nextOffset: 4 }),
		"",
		JSON.stringify({ ok: true, jobId: "j", done: true, nextOffset: 4, state: "failed", exitCode: 1 }),
	].join("\n");
	const f = parseLogFrames(stdout);
	assert.equal(Buffer.from(f.chunkB64, "base64").toString("utf8"), "data");
	assert.equal(f.state, "failed");
	assert.equal(f.exitCode, 1);
});

test("ParseLogFrames__ReassemblesBytes__When__ChunkBoundarySplitsAUtf8Character", () => {
	// Base64 strings must never be joined as text (padding lands mid-stream) — the parser
	// concatenates BUFFERS, so a two-byte character split across chunks survives intact.
	const e = Buffer.from("é", "utf8");
	const stdout = [
		JSON.stringify({ ok: true, chunk: e.subarray(0, 1).toString("base64"), nextOffset: 1 }),
		JSON.stringify({ ok: true, chunk: e.subarray(1).toString("base64"), nextOffset: 2 }),
		JSON.stringify({ ok: true, done: true, nextOffset: 2, state: "running", exitCode: null }),
	].join("\n");
	assert.equal(Buffer.from(parseLogFrames(stdout).chunkB64, "base64").toString("utf8"), "é");
});

/*
 * The offset-0 64KB tail is a byte-arithmetic slice, and a byte offset can land mid-UTF-8
 * sequence — the pane would open on a replacement char. utf8Tail advances the start past
 * continuation bytes to the next character boundary.
 */

test("Utf8Tail__ReturnsWholeBuffer__When__ItFitsTheBudget", () => {
	const buf = Buffer.from("short log", "utf8");
	assert.equal(utf8Tail(buf, 64), buf);
	// Exactly at the budget is still whole — only a longer buffer slices.
	assert.equal(utf8Tail(buf, buf.length), buf);
});

test("Utf8Tail__AdvancesToCharacterBoundary__When__SliceStartsMidUtf8", () => {
	// "a😀b" = 61 f0 9f 98 80 62. A 3-byte tail starts on the emoji's second continuation
	// byte; the slice must skip forward to 'b' rather than open on a replacement char.
	const buf = Buffer.from("a😀b", "utf8");
	assert.equal(utf8Tail(buf, 3).toString("utf8"), "b");
	// A 5-byte tail starts on the emoji's LEAD byte (a boundary) — nothing is skipped.
	assert.equal(utf8Tail(buf, 5).toString("utf8"), "😀b");
	// Two-byte class too: "aaé" = 61 61 c3 a9; a 1-byte tail lands on é's continuation byte.
	assert.equal(utf8Tail(Buffer.from("aaé", "utf8"), 1).toString("utf8"), "");
	assert.equal(utf8Tail(Buffer.from("aaé", "utf8"), 2).toString("utf8"), "é");
});

test("Utf8Tail__StopsAfterThreeSteps__When__BytesAreNotUtf8", () => {
	// Valid UTF-8 never carries more than 3 continuation bytes in a row — a longer run is
	// not UTF-8, and the advance must stay bounded rather than scan (or empty) the tail.
	const buf = Buffer.alloc(8, 0x80);
	assert.equal(utf8Tail(buf, 6).length, 3); // start 2, advanced exactly 3 to 5 — never further
});

/*
 * The env fallback exists because watchdogs launch the dash as bare `tsx watch`, skipping
 * ./run's sourcing. The parser is pure and tested directly; loadEnvFallback's file walk
 * touches the real filesystem, so only its keyed no-op guard is tested here.
 */

test("ParseEnvLine__ReturnsPair__When__LineIsPlainAssignment", () => {
	assert.deepEqual(parseEnvLine("OPENROUTER_API_KEY=sk-or-abc123"), ["OPENROUTER_API_KEY", "sk-or-abc123"]);
});

test("ParseEnvLine__ReturnsPair__When__LineUsesExportPrefix", () => {
	assert.deepEqual(parseEnvLine("export ANTHROPIC_API_KEY=sk-ant-xyz"), ["ANTHROPIC_API_KEY", "sk-ant-xyz"]);
});

test("ParseEnvLine__StripsOneQuoteLayer__When__ValueIsQuoted", () => {
	assert.deepEqual(parseEnvLine('KEY="quoted value"'), ["KEY", "quoted value"]);
	assert.deepEqual(parseEnvLine("KEY='single'"), ["KEY", "single"]);
	// Only MATCHING pairs strip, and only one layer.
	assert.deepEqual(parseEnvLine("KEY=\"mismatched'"), ["KEY", "\"mismatched'"]);
	assert.deepEqual(parseEnvLine("KEY=\"'nested'\""), ["KEY", "'nested'"]);
});

test("ParseEnvLine__ReturnsUndefined__When__LineIsBlankOrComment", () => {
	assert.equal(parseEnvLine(""), undefined);
	assert.equal(parseEnvLine("   "), undefined);
	assert.equal(parseEnvLine("# a comment"), undefined);
	assert.equal(parseEnvLine("#KEY=value"), undefined);
	assert.equal(parseEnvLine("not an assignment"), undefined);
});

test("LoadEnvFallback__DoesNothing__When__EnvironmentAlreadyHoldsAKey", () => {
	// A keyed environment must never be overridden — presence of any model key short-circuits
	// before any file is read, so this is safe against the real repo's .env.
	const saved = process.env.OPENROUTER_API_KEY;
	process.env.OPENROUTER_API_KEY = "sk-or-test";
	try {
		assert.equal(loadEnvFallback(), undefined);
	} finally {
		if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = saved;
	}
});

/*
 * The store adapter. The runner saves all live data under out/bench/live (canonical, read-only to
 * the dash) with out/bench/archive as a hard-linked backup; the store's pre-bench homes (out/live,
 * out/archive) still hold what landed there the night before the final location was decided; and
 * anything older sits at its legacy path (out/bench, out/jobs, out/runs). Every dash read resolves
 * out/bench/live → out/bench/archive → out/live → out/archive → legacy, so these pin the
 * precedence with real directories the way the buildDetail fixtures do.
 */

// A pass is addressed by DATE; the store roots supply everything above it.
const REL = ["2026-08-01", "manifest.json"];

const plant = (root: string, parts: string[], body = "{}"): void => {
	fs.mkdirSync(path.join(root, ...parts.slice(0, -1)), { recursive: true });
	fs.writeFileSync(path.join(root, ...parts), body);
};

test("FromStore__PrefersLive__When__LiveAndLegacyBothExist", () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "dash-store-"));
	try {
		plant(out, ["bench", "live", ...REL]);
		plant(out, ["bench", ...REL]);
		assert.equal(fromStore(REL, out), path.join(out, "bench", "live", ...REL));
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
});

test("FromStore__FallsBackToArchiveThenLegacy__When__LiveIsAbsent", () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "dash-store-"));
	try {
		plant(out, ["bench", "archive", ...REL]);
		plant(out, ["bench", ...REL]);
		assert.equal(fromStore(REL, out), path.join(out, "bench", "archive", ...REL));
		fs.rmSync(path.join(out, "bench", "archive"), { recursive: true });
		assert.equal(fromStore(REL, out), path.join(out, "bench", ...REL));
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
});

test("FromStore__WalksTheFullPrecedenceChain__When__EveryLocationHoldsTheDate", () => {
	// Built bottom-up: each planting must steal resolution from everything below it, which pins
	// the entire order out/bench/live → out/bench/archive → out/live → out/archive → out/bench →
	// out in one pass.
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "dash-store-"));
	try {
		plant(out, REL);
		assert.equal(fromStore(REL, out), path.join(out, ...REL));
		plant(out, ["bench", ...REL]);
		assert.equal(fromStore(REL, out), path.join(out, "bench", ...REL));
		plant(out, ["archive", ...REL]);
		assert.equal(fromStore(REL, out), path.join(out, "archive", ...REL));
		plant(out, ["live", ...REL]);
		assert.equal(fromStore(REL, out), path.join(out, "live", ...REL));
		plant(out, ["bench", "archive", ...REL]);
		assert.equal(fromStore(REL, out), path.join(out, "bench", "archive", ...REL));
		plant(out, ["bench", "live", ...REL]);
		assert.equal(fromStore(REL, out), path.join(out, "bench", "live", ...REL));
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
});

test("NarrativeLogPath__AppendsUnderTheBenchStore__When__ReadsStillCoverThePreBenchFile", () => {
	// Appends moved with the store; the pre-bench file stays readable because events already
	// landed there the night the store lived at out/live.
	assert.equal(narrativeLogPath("/x/out"), path.join("/x/out", "bench", "live", "narrative.jsonl"));
	assert.equal(legacyNarrativeLogPath("/x/out"), path.join("/x/out", "live", "narrative.jsonl"));
});

test("NotedRunKeys__RecoversMintedSet__When__PassLogHoldsRunEvents", () => {
	// The narrator's re-mint guard recovers from the pass-level log's runKey fields at startup
	// — never from memory. Pre-per-run events (no runKey) and torn lines seed nothing.
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "dash-narr-"));
	try {
		plant(out, ["bench", "live", "narrative.jsonl"], [
			JSON.stringify({ t: "2026-08-01T00:00:00.000Z", date: "2026-08-01", collected: 3, model: "m", text: "old pass-level note" }),
			JSON.stringify({ t: "2026-08-01T01:00:00.000Z", runKey: "job-a", armId: "ax-grounded", collectedAtMint: 4, model: "m", text: "note a" }),
			'{"torn',
			JSON.stringify({ t: "2026-08-01T02:00:00.000Z", runKey: "job-b", armId: "ax-grounded", collectedAtMint: 5, model: "m", text: "note b" }),
			"",
		].join("\n"));
		const noted = notedRunKeys(out);
		assert.deepEqual([...noted].sort(), ["job-a", "job-b"]);
		assert.equal(noted.has("job-c"), false);
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
});

test("AppendNarrativeEvent__RoundTripsThroughBothLogs__When__NoteIsMinted", () => {
	// The SAME event lands in the run dir AND the pass-level log; the pass-level shape gains
	// runKey/armId/collectedAtMint but keeps t/model/text, so readPersistedNarrative serves it
	// (with the trigger fields) and notedRunKeys recovers the guard from the same bytes.
	// The run dir exists first, as it does for any collected run — the note follows the run to
	// its CURRENT home (live here; the archive case is the next test).
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "dash-narr-"));
	try {
		fs.mkdirSync(path.join(out, "bench", "live", "job-rt"), { recursive: true });
		const ev: NarrativeEvent = { t: "2026-08-01T03:00:00.000Z", runKey: "job-rt", armId: "ax-grounded", collectedAtMint: 7, model: "test-model", text: "the note" };
		appendNarrativeEvent(ev, out);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "bench", "live", "job-rt", "narrative.jsonl"), "utf8").trim()), ev);
		const n = readPersistedNarrative("2026-08-01", out);
		assert.equal(n?.updatedAt, ev.t);
		assert.equal(n?.text, "the note");
		assert.equal(n?.model, "test-model");
		assert.equal(n?.runKey, "job-rt");
		assert.equal(n?.collected, 7);
		assert.equal(notedRunKeys(out).has("job-rt"), true);
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
});

test("AppendNarrativeEvent__WritesIntoTheArchiveCopy__When__TheFailedRunWasEvicted", () => {
	// Collect evicts a failure from live before the narrator's tick sees the collection, so the
	// per-run note must land in the run's archive copy — a live-only write would recreate a stub
	// dir for every failed run and strand the note outside its backup.
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "dash-narr-"));
	try {
		fs.mkdirSync(path.join(out, "bench", "archive", "job-ev"), { recursive: true });
		const ev: NarrativeEvent = { t: "2026-08-01T04:00:00.000Z", runKey: "job-ev", armId: "ax-grounded", collectedAtMint: 8, model: "test-model", text: "failed and evicted" };
		appendNarrativeEvent(ev, out);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "bench", "archive", "job-ev", "narrative.jsonl"), "utf8").trim()), ev);
		assert.equal(fs.existsSync(path.join(out, "bench", "live", "job-ev")), false, "the eviction must not be undone by a note");
		assert.equal(notedRunKeys(out).has("job-ev"), true);
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
});

test("ReadPersistedNarrative__ToleratesPreRunEvents__When__LogPredatesPerRunNotes", () => {
	// Old pass-level events ({t, date, collected, model, text}) keep reading back — the parser
	// requires only t/text/model; the trigger fields are simply absent.
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "dash-narr-"));
	try {
		plant(out, ["bench", "live", "narrative.jsonl"],
			`${JSON.stringify({ t: "2026-08-01T00:00:00.000Z", date: "2026-08-01", collected: 3, model: "m", text: "old note" })}\n`);
		const n = readPersistedNarrative("2026-08-01", out);
		assert.equal(n?.text, "old note");
		assert.equal(n?.model, "m");
		assert.equal(n?.runKey, undefined);
		assert.equal(n?.collected, 3);
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
});

test("NarratorPrompt__FramesTheTriggeringRun__When__RunContextIsGiven", () => {
	// Per-run mints keep the persona and the terse rules, add the completed run's framing and
	// its own EntryView numbers ahead of the full-state digest.
	const p = narratorPrompt({ progress: { collected: 9 } }, undefined, { runKey: "job-x", armId: "cdp-grounded", stats: { steps: 9, usd: 0.12 } });
	assert.ok(p.includes("A run just completed: job-x (arm cdp-grounded)"));
	assert.ok(p.includes("write the note for THIS run"));
	assert.ok(p.includes('"steps": 9'));
	assert.ok(p.includes("Write 2–3 sentences"));
	// No run context — the framing stays out entirely (the pre-per-run prompt, unchanged).
	assert.ok(!narratorPrompt({ progress: {} }).includes("A run just completed"));
});

test("FromStore__NamesTheLegacyPath__When__ArtifactExistsNowhere", () => {
	// The last candidate comes back so error messages and the manifest watcher name where
	// the data is expected to appear — same contract as paths.ts's runFile.
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "dash-store-"));
	try {
		assert.equal(fromStore(REL, out), path.join(out, ...REL));
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
});

test("DefaultDashDate__FindsTheDrainUnderLive__When__LegacyTreeHoldsAnOlderDay", () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "dash-store-"));
	try {
		const full = JSON.stringify({ date: "x", createdAt: "x", entries: [{ jobId: "j" }] });
		plant(out, ["bench", "2026-07-31", "manifest.json"], full);
		plant(out, ["bench", "live", "2026-08-01", "manifest.json"], full);
		// An empty next-day husk (any post-midnight collect mints one) must not outrank either.
		plant(out, ["bench", "2026-08-02", "manifest.json"], JSON.stringify({ date: "x", createdAt: "x", entries: [] }));
		assert.equal(defaultDashDate(out), "2026-08-01");
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
});

test("BuildDetail__ReadsRunLog__When__RunLandedInTheLiveStore", () => {
	// The consolidated layout: one directory per run, out/bench/live/<job>/run.json — no legacy
	// out/runs fallback involved. The walk must come out identical to the legacy fixture's.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-detail-live-"));
	try {
		fs.mkdirSync(path.join(dir, "docs", "appmaps"), { recursive: true });
		fs.writeFileSync(path.join(dir, "docs", "appmaps", "yarn.json"), JSON.stringify(GRAPH));
		fs.mkdirSync(path.join(dir, "out", "bench", "live", "job-l"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "out", "bench", "live", "job-l", "run.json"),
			JSON.stringify({ task: "show me how to change the cursor type", steps: [rawStep(0, "Brand Kit"), rawStep(1, "Screen Clips"), rawStep(2, "Cursor Style")] }),
		);
		const m = manifest(entry({ jobId: "job-l", state: "done", collected: true }));
		const d = buildDetail("job-l", m, { dataDir: dir, benchRoot: path.join(dir, "bench") });
		assert.equal(d.steps.length, 3);
		assert.equal(d.steps[2]?.nodeId, "brand-kit/screen-clips/cursor-style");
		assert.equal(d.task, "show me how to change the cursor type");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("BuildDetail__PrefersTheRunDirsOwnAppmap__When__TheRunFolderHoldsOne", () => {
	// New explore passes file appmap.json beside their run log; that copy outranks the arm-keyed
	// bench archive and docs/appmaps because it is the record of what THIS run produced. Old maps
	// stay where they are (David, 2026-08-01) — the later candidates keep serving them.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-detail-own-"));
	try {
		fs.mkdirSync(path.join(dir, "docs", "appmaps"), { recursive: true });
		fs.writeFileSync(path.join(dir, "docs", "appmaps", "yarn.json"), JSON.stringify(GRAPH));
		fs.mkdirSync(path.join(dir, "out", "bench", "live", "job-o"), { recursive: true });
		fs.writeFileSync(path.join(dir, "out", "bench", "live", "job-o", "appmap.json"), JSON.stringify(GRAPH));
		fs.writeFileSync(
			path.join(dir, "out", "bench", "live", "job-o", "run.json"),
			JSON.stringify({ steps: [rawStep(0, "Brand Kit")] }),
		);
		const m = manifest(entry({ jobId: "job-o", state: "done", collected: true }));
		const d = buildDetail("job-o", m, { dataDir: dir, benchRoot: path.join(dir, "bench") });
		assert.equal(d.graphSource, "job-o/appmap.json (run dir)");
		assert.equal(d.steps[0]?.edgeTo, "brand-kit");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("BuildDetail__ServesCheckpointGraph__When__ExploreStillRunning", () => {
	// A running pass has no appmap.json yet, but checkpoint.json (rewritten on every record,
	// shaped as a valid AppMap) IS its map-so-far — served through the same renderer, marked
	// graphLive so the page tags it LIVE and expires its detail cache.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-detail-ckpt-"));
	try {
		fs.mkdirSync(path.join(dir, "out", "bench", "live", "job-ck"), { recursive: true });
		fs.writeFileSync(path.join(dir, "out", "bench", "live", "job-ck", "checkpoint.json"), JSON.stringify({ app: "Yarn", ...GRAPH }));
		const m = manifest(entry({ jobId: "job-ck", armId: "explore-ax", state: "running", collected: false }));
		const d = buildDetail("job-ck", m, { dataDir: dir, benchRoot: path.join(dir, "bench") });
		assert.equal(d.graphLive, true);
		assert.ok(d.graphSource?.includes("checkpoint"), `source names the checkpoint: ${d.graphSource}`);
		assert.equal(d.graph?.nodes.length, GRAPH.nodes.length);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("BuildDetail__PrefersFinalAppmap__When__RunDirHoldsCheckpointToo", () => {
	// The finished artifact outranks the checkpoint even while uncollected (the awaiting-
	// collect window): appmap.json is the pass's real output, the checkpoint its draft.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-detail-ckpt2-"));
	try {
		const run = path.join(dir, "out", "bench", "live", "job-ck2");
		fs.mkdirSync(run, { recursive: true });
		fs.writeFileSync(path.join(run, "appmap.json"), JSON.stringify(GRAPH));
		fs.writeFileSync(path.join(run, "checkpoint.json"), JSON.stringify({ ...GRAPH, nodes: GRAPH.nodes.slice(0, 1) }));
		const m = manifest(entry({ jobId: "job-ck2", armId: "explore-ax", state: "running", collected: false }));
		const d = buildDetail("job-ck2", m, { dataDir: dir, benchRoot: path.join(dir, "bench") });
		assert.equal(d.graphLive, undefined);
		assert.equal(d.graphSource, "job-ck2/appmap.json (run dir)");
		assert.equal(d.graph?.nodes.length, GRAPH.nodes.length);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("BuildDetail__PrefersRemoteCheckpoint__When__HandlerFetchedOne", () => {
	// A fleet run's local checkpoint is at best a stale mid-run pull snapshot; the copy the
	// handler just ssh-fetched off the busy Mac is the run speaking now, so it wins.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-detail-ckpt3-"));
	try {
		const run = path.join(dir, "out", "bench", "live", "job-ck3");
		fs.mkdirSync(run, { recursive: true });
		fs.writeFileSync(path.join(run, "checkpoint.json"), JSON.stringify({ ...GRAPH, nodes: GRAPH.nodes.slice(0, 1) }));
		const m = manifest(entry({ jobId: "job-ck3", armId: "explore-ax", state: "running", collected: false }));
		const d = buildDetail("job-ck3", m, { dataDir: dir, benchRoot: path.join(dir, "bench"), remoteCheckpoint: { app: "Yarn", ...GRAPH } });
		assert.equal(d.graphLive, true);
		assert.equal(d.graph?.nodes.length, GRAPH.nodes.length, "the remote copy's nodes, not the stale local one's");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("BuildDetail__IgnoresCheckpoint__When__EntryCollected", () => {
	// checkpoint.json persists after a pass finishes; once collect has banked the run, the
	// draft must never shadow the arm-keyed tiers (archive/docs) that hold real artifacts.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-detail-ckpt4-"));
	try {
		fs.mkdirSync(path.join(dir, "out", "bench", "live", "job-ck4"), { recursive: true });
		fs.writeFileSync(path.join(dir, "out", "bench", "live", "job-ck4", "checkpoint.json"), JSON.stringify(GRAPH));
		const m = manifest(entry({ jobId: "job-ck4", armId: "explore-ax", state: "done", collected: true }));
		const d = buildDetail("job-ck4", m, { dataDir: dir, benchRoot: path.join(dir, "bench") });
		assert.equal(d.graphLive, undefined);
		assert.ok(!d.graphSource?.includes("checkpoint"), `checkpoint must not serve a collected run: ${d.graphSource}`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("BuildDetail__CarriesTheRunsNarratorNote__When__RunDirHoldsNarrativeLog", () => {
	// The dropdown renders the run's own note beneath the prompt; the detail carries the run
	// dir's narrative.jsonl NEWEST event (several never happen in normal minting, but a rescue
	// re-mint must win). A run without one simply omits the field.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-detail-note-"));
	try {
		fs.mkdirSync(path.join(dir, "out", "bench", "live", "job-n"), { recursive: true });
		fs.writeFileSync(path.join(dir, "out", "bench", "live", "job-n", "run.json"), JSON.stringify({ task: "t", steps: [] }));
		fs.writeFileSync(path.join(dir, "out", "bench", "live", "job-n", "narrative.jsonl"), [
			JSON.stringify({ t: "2026-08-01T01:00:00.000Z", runKey: "job-n", armId: "ax-grounded", collectedAtMint: 1, model: "m1", text: "first" }),
			JSON.stringify({ t: "2026-08-01T02:00:00.000Z", runKey: "job-n", armId: "ax-grounded", collectedAtMint: 2, model: "m2", text: "latest note" }),
			"",
		].join("\n"));
		const m = manifest(entry({ jobId: "job-n", state: "done", collected: true }));
		const d = buildDetail("job-n", m, { dataDir: dir, benchRoot: path.join(dir, "bench") });
		assert.deepEqual(d.narratorNote, { t: "2026-08-01T02:00:00.000Z", text: "latest note", model: "m2" });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("ParseDashArgs__DefaultsToPureReader__When__NoCollectFlagGiven", () => {
	// READ-ONLY posture: out/bench/live is the runner's store; collecting is opt-in. --date keeps
	// the parse off the real repo's bench tree.
	assert.equal(parseDashArgs(["--date", "2026-08-01"]).autoCollect, false);
	assert.equal(parseDashArgs(["--date", "2026-08-01", "--collect"]).autoCollect, true);
	// The old opt-out stays accepted as a harmless no-op — it already means "pure reader".
	assert.equal(parseDashArgs(["--date", "2026-08-01", "--no-collect"]).autoCollect, false);
});

test("groundingArmId__AttributesTheMapTheArmActuallyReads__When__VariantsCombine", () => {
	// The bug this replaced tested APPMAP_VARIANT before axdomOff and short-circuited, so
	// min-context-grounded — which reads yarn.ax.noaxdom.novision — was attributed to
	// explore-no-vision, which writes yarn.ax.novision. Runs counted against a graph they
	// never read is precisely what the traversal-heat aggregation must not do.
	const min = armById("min-context-grounded")!;
	const attributed = groundingArmId(min);
	assert.equal(armAppmapSlug(armById(attributed)!), armAppmapSlug(min), `attributed to ${attributed}, whose map is a different file`);

	// Every task/replay arm that grounds at all must resolve to a REAL phase-1 arm — the old
	// version still named explore-web-cdp, deleted from the matrix.
	for (const arm of MATRIX) {
		if (arm.kind === "explore" || arm.kind === "compile") continue;
		if (arm.dispatch.noGrounding || arm.dispatch.useRecipe || arm.dispatch.useProcedures) continue;
		const id = groundingArmId(arm);
		assert.ok(armById(id), `${arm.id} attributed to "${id}", which is not an arm`);
		assert.equal(armAppmapSlug(armById(id)!), armAppmapSlug(arm), `${arm.id} attributed to ${id}, a different map`);
	}
});

/*
 * The run-folder event log: runEvent (writer, src/core/harness/run-events.ts) and
 * storeEvents (reader, the dash's Events feed). The writer is best-effort by contract — a
 * failed append must never affect the run — and the reader must survive everything a live
 * store throws at it: missing files, torn tail lines, a ring racing the run logs.
 */

test("RunEvent__AppendsShapedLine__When__RunDirDoesNotExistYet", () => {
	const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "run-events-"));
	const saved = process.env.YARN_RUNNER_DATA;
	process.env.YARN_RUNNER_DATA = dataRoot;
	try {
		// No mkdir first — the appender owns creating the run dir it writes into.
		runEvent("2026-08-01T00-00-00-000-test", "start", { task: "t", app: "Yarn", backend: "cdp" });
		runEvent("2026-08-01T00-00-00-000-test", "step", { step: 1, verified: true });
		const file = path.join(dataRoot, "out", "bench", "live", "2026-08-01T00-00-00-000-test", "events.jsonl");
		const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
		assert.equal(lines.length, 2);
		const first = JSON.parse(lines[0]!);
		assert.equal(first.kind, "start");
		assert.deepEqual(first.detail, { task: "t", app: "Yarn", backend: "cdp" });
		// t is a real ISO timestamp, not a placeholder.
		assert.ok(!Number.isNaN(Date.parse(first.t)));
		assert.deepEqual(JSON.parse(lines[1]!).detail, { step: 1, verified: true });
	} finally {
		if (saved === undefined) delete process.env.YARN_RUNNER_DATA;
		else process.env.YARN_RUNNER_DATA = saved;
		fs.rmSync(dataRoot, { recursive: true, force: true });
	}
});

test("RunEvent__SwallowsFailure__When__DataRootIsUnwritable", () => {
	// Point the data root UNDER a plain file so the mkdir inside the appender fails with
	// ENOTDIR — the contract is one console warning at most and never a throw.
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "run-events-bad-"));
	const blocker = path.join(tmp, "a-file");
	fs.writeFileSync(blocker, "not a directory");
	const saved = process.env.YARN_RUNNER_DATA;
	process.env.YARN_RUNNER_DATA = blocker;
	try {
		assert.doesNotThrow(() => runEvent("2026-08-01T00-00-00-000-test", "start", {}));
		assert.doesNotThrow(() => runEvent("2026-08-01T00-00-00-000-test", "verdict", { success: false }));
	} finally {
		if (saved === undefined) delete process.env.YARN_RUNNER_DATA;
		else process.env.YARN_RUNNER_DATA = saved;
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("UsageEvent__AppendsCumulativeTotals__When__Called", () => {
	const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "usage-events-"));
	const saved = process.env.YARN_RUNNER_DATA;
	process.env.YARN_RUNNER_DATA = dataRoot;
	try {
		// Two calls with GROWING totals — the contract is cumulative, so the consumer takes
		// the last line it sees and never sums the stream.
		usageEvent("2026-08-01T00-00-00-000-test", "openai/gpt-5.6-sol", {
			modelCalls: 1, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 90,
		});
		usageEvent("2026-08-01T00-00-00-000-test", "openai/gpt-5.6-sol", {
			modelCalls: 2, inputTokens: 250, outputTokens: 55, cacheReadTokens: 80, cacheCreationTokens: 130,
		});
		const file = path.join(dataRoot, "out", "bench", "live", "2026-08-01T00-00-00-000-test", "events.jsonl");
		const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
		assert.equal(lines.length, 2);
		assert.ok(lines.every((l) => l.kind === "usage"));
		// The detail shape is a frozen contract with the dashboard's cost math — exact field
		// names (TokenCounts plus model/modelCalls), nothing extra, nothing renamed.
		assert.deepEqual(lines[0].detail, {
			model: "openai/gpt-5.6-sol", modelCalls: 1, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 90,
		});
		assert.deepEqual(lines[1].detail, {
			model: "openai/gpt-5.6-sol", modelCalls: 2, inputTokens: 250, outputTokens: 55, cacheReadTokens: 80, cacheCreationTokens: 130,
		});
	} finally {
		if (saved === undefined) delete process.env.YARN_RUNNER_DATA;
		else process.env.YARN_RUNNER_DATA = saved;
		fs.rmSync(dataRoot, { recursive: true, force: true });
	}
});

test("RunEventLine__RendersKindAndPairs__When__DetailVaries", () => {
	assert.equal(runEventLine("start", { task: "change tz", step: 3, ok: true }), "start task=change tz step=3 ok=true");
	// Empty or absent detail renders as the bare kind — no trailing space, no "{}" noise.
	assert.equal(runEventLine("finish", {}), "finish");
	assert.equal(runEventLine("finish", undefined), "finish");
	// Bounded: one huge detail must not flood the feed card.
	assert.ok(runEventLine("step", { note: "x".repeat(500) }).length <= 240);
});

test("StoreEvents__MergesTagsAndSorts__When__RunLogsAndRingCoexist", () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "dash-events-"));
	try {
		plant(out, ["bench", "live", "2026-08-01T10-00-00-000-yarn", "events.jsonl"], [
			JSON.stringify({ t: "2026-08-01T10:00:01.000Z", kind: "start", detail: { task: "t", app: "Yarn" } }),
			JSON.stringify({ t: "2026-08-01T10:00:05.000Z", kind: "verdict", detail: { success: true } }),
			"",
		].join("\n"));
		const ring: DashEvent[] = [{ t: "2026-08-01T10:00:03.000Z", line: "collect: 1 run(s) landed" }];
		const merged = storeEvents(ring, 200, out);
		// Chronological on the wire (the page reverses for display), run and dash interleaved by t.
		assert.deepEqual(merged.map((e) => e.line), ["start task=t app=Yarn", "collect: 1 run(s) landed", "verdict success=true"]);
		assert.deepEqual(merged.map((e) => e.source), ["run", "dash", "run"]);
		assert.equal(merged[0]?.runKey, "2026-08-01T10-00-00-000-yarn");
		// Dash lines never gain a runKey; the ring passed in is not mutated.
		assert.equal(merged[1]?.runKey, undefined);
		assert.equal(ring[0]?.source, undefined);
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
});

test("StoreEvents__SkipsTornLines__When__WriterRacesTheRead", () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "dash-events-torn-"));
	try {
		plant(out, ["bench", "live", "run-a", "events.jsonl"], [
			JSON.stringify({ t: "2026-08-01T10:00:01.000Z", kind: "start", detail: {} }),
			'{"t":"2026-08-01T10:00:02.000Z","kind":"ste', // torn mid-append
			"not json at all",
			JSON.stringify({ t: "2026-08-01T10:00:03.000Z", kind: "verdict", detail: { success: false } }),
		].join("\n"));
		const merged = storeEvents([], 200, out);
		assert.deepEqual(merged.map((e) => e.line), ["start", "verdict success=false"]);
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
});

test("StoreEvents__KeepsTheNewest__When__FeedOverflowsTheLimit", () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "dash-events-cap-"));
	try {
		const line = (sec: number, kind: string) => JSON.stringify({ t: `2026-08-01T10:00:0${sec}.000Z`, kind, detail: {} });
		plant(out, ["bench", "live", "run-a", "events.jsonl"], `${[line(1, "a1"), line(3, "a3"), line(5, "a5")].join("\n")}\n`);
		plant(out, ["bench", "live", "run-b", "events.jsonl"], `${[line(2, "b2"), line(6, "b6")].join("\n")}\n`);
		const ring: DashEvent[] = [{ t: "2026-08-01T10:00:04.000Z", line: "d4" }];
		// Six events, limit 4: the two OLDEST fall off, and what remains stays chronological.
		const merged = storeEvents(ring, 4, out);
		assert.deepEqual(merged.map((e) => e.line), ["a3", "d4", "a5", "b6"]);
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
});

test("StoreEvents__ServesRingAlone__When__NoLiveStoreExists", () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "dash-events-none-"));
	try {
		const merged = storeEvents([{ t: "2026-08-01T10:00:00.000Z", line: "only dash" }], 200, out);
		assert.deepEqual(merged.map((e) => e.line), ["only dash"]);
		assert.equal(merged[0]?.source, "dash");
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
});

/*
 * The manifest watcher chain, against a REAL tmp tree. fs.watch on macOS (FSEvents) needs
 * settle time and delivers with latency, so every event assertion polls a callback counter
 * (bounded ~3s) instead of sleeping fixed amounts. The wipe step's FIRE comes from the
 * surviving ancestor — `out` sees its direct child `bench` vanish; the dead descendants'
 * cleanup is asserted as re-arm BOOKKEEPING (watching() contents) rather than event
 * delivery, because macOS emits nothing on the deleted dirs' own watchers.
 */

test("WatchStoreChain__FiresOnChange__When__StoreWipedAndRecreated", async () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "dash-watch-"));
	let fired = 0;
	// The same thunk main() passes: re-resolve the manifest dir through the store adapter,
	// so a wiped store re-chains to the last-candidate path and a recreated one back to live.
	const w = watchStoreChain(() => path.dirname(fromStore(REL, out)), out, () => { fired++; });
	const settle = () => new Promise((r) => setTimeout(r, 200));
	const firedPast = async (mark: number): Promise<boolean> => {
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && fired <= mark) await new Promise((r) => setTimeout(r, 25));

		return fired > mark;
	};
	try {
		// Arm against the full tree: every dir from out down to the date dir gets a watcher.
		plant(out, ["bench", "live", ...REL]);
		w.rearm();
		assert.deepEqual(
			w.watching().sort(),
			[out, path.join(out, "bench"), path.join(out, "bench", "live"), path.join(out, "bench", "live", "2026-08-01")].sort(),
		);

		// A manifest rewrite fires the date-dir watcher — the realtime edit path.
		await settle();
		let mark = fired;
		fs.writeFileSync(path.join(out, "bench", "live", ...REL), '{"touched":1}');
		assert.ok(await firedPast(mark), "manifest write did not fire the chain");

		// Wipe the store. The date dir's own watcher hears nothing — the fire must come from
		// `out`, whose direct child vanished.
		mark = fired;
		fs.rmSync(path.join(out, "bench"), { recursive: true, force: true });
		assert.ok(await firedPast(mark), "store wipe did not fire from the surviving ancestor");
		// The event's own re-arm drops the dead watchers; only the survivor remains.
		await settle();
		assert.deepEqual(w.watching(), [out]);

		// Recreate and rearm (the poll-tick stand-in): the chain re-resolves to the full
		// ancestry, and a manifest write reaches the callback again.
		plant(out, ["bench", "live", ...REL]);
		w.rearm();
		assert.equal(w.watching().length, 4);
		await settle();
		mark = fired;
		fs.writeFileSync(path.join(out, "bench", "live", ...REL), '{"touched":2}');
		assert.ok(await firedPast(mark), "post-recreation write did not fire");
	} finally {
		w.close();
		fs.rmSync(out, { recursive: true, force: true });
	}
});

test("ParseDashArgs__RecordsWhetherTheDateWasNamed__When__FlagIsAbsent", () => {
	// A resolved date and a chosen one are different things, and conflating them is why a
	// long-lived dash can never move: on 2026-08-01 four instances booted while 2026-07-31 was
	// the newest non-empty manifest and watched it all night while the pass ran under 08-01.
	// Any benchmark crossing UTC midnight reproduces it.
	assert.equal(parseDashArgs(["--date", "2026-07-31"]).dateExplicit, true, "a named date is pinned forever");
	assert.equal(parseDashArgs([]).dateExplicit, false, "a resolved date follows the newest pass");
	assert.equal(parseDashArgs(["--date", "2026-07-31"]).date, "2026-07-31");
});

/*
 * Results-so-far (RunProgress): counters folded off a run's own event log, the only numbers
 * that exist while collect has nothing. The contract under test is provisionality — attached
 * to uncollected entries only, absent the moment metrics land — and convergence: the step
 * counters must agree with what parseRunMetrics will read once the run log exists.
 */

test("AggregateRunEvents__CountsStepsAndVerified__When__StepEventsPresent", () => {
	const p = aggregateRunEvents(parseRunEvents([
		JSON.stringify({ t: "2026-08-01T10:00:01.000Z", kind: "start", detail: { task: "t", app: "Yarn" } }),
		JSON.stringify({ t: "2026-08-01T10:00:02.000Z", kind: "step", detail: { step: 1, action: "click", target: "Settings", verified: true, channel: "text" } }),
		JSON.stringify({ t: "2026-08-01T10:00:03.000Z", kind: "step", detail: { step: 2, action: "type_text", verified: false } }),
		JSON.stringify({ t: "2026-08-01T10:00:04.000Z", kind: "step", detail: { step: 3, action: "click", target: "Save", verified: true } }),
	].join("\n")));
	assert.equal(p?.steps, 3);
	assert.equal(p?.verified, 2);
	// The newest step, human-shaped — the chip tooltip's "what is it doing right now".
	assert.equal(p?.lastStep, 'click "Save" ✓');
	// The reading's age is the newest event's own stamp, never a fabricated now.
	assert.equal(p?.updatedAt, "2026-08-01T10:00:04.000Z");
});

test("AggregateRunEvents__CapturesVerdictAndCleanup__When__RunEnded", () => {
	const p = aggregateRunEvents(parseRunEvents([
		JSON.stringify({ t: "2026-08-01T10:00:01.000Z", kind: "step", detail: { step: 1, action: "click", verified: true } }),
		JSON.stringify({ t: "2026-08-01T10:00:05.000Z", kind: "cleanup", detail: { restored: 2, failed: 1 } }),
		JSON.stringify({ t: "2026-08-01T10:00:06.000Z", kind: "verdict", detail: { success: true, summary: "changed the cursor style" } }),
	].join("\n")));
	assert.deepEqual(p?.verdict, { success: true, summary: "changed the cursor style" });
	assert.equal(p?.cleanup, "2 restored, 1 failed");
	// A fatal error is its own field, not a verdict — the run may still salvage (explore).
	const f = aggregateRunEvents(parseRunEvents(JSON.stringify({ t: "2026-08-01T10:00:07.000Z", kind: "fatal", detail: { error: "driver died" } })));
	assert.equal(f?.fatal, "driver died");
	assert.equal(f?.verdict, undefined);
});

test("AggregateRunEvents__TracksExploreHeartbeat__When__ProgressAndFinishPresent", () => {
	// Explore emits COARSE heartbeats (every 10th action) rather than per-step events, so the
	// counters come from the LATEST heartbeat/chapter/finish — not from counting lines.
	const p = aggregateRunEvents(parseRunEvents([
		JSON.stringify({ t: "2026-08-01T10:00:01.000Z", kind: "progress", detail: { actions: 10, frontier: 40, seen: 55, elapsed: "4m" } }),
		JSON.stringify({ t: "2026-08-01T10:05:00.000Z", kind: "chapter", detail: { chapter: 2, findings: 12, nodes: 34 } }),
		JSON.stringify({ t: "2026-08-01T10:10:00.000Z", kind: "progress", detail: { actions: 20, frontier: 31, seen: 78, elapsed: "9m" } }),
	].join("\n")));
	assert.equal(p?.actions, 20);
	assert.equal(p?.frontier, 31);
	assert.equal(p?.seen, 78);
	assert.equal(p?.nodes, 34);
	assert.equal(p?.steps, undefined, "an explore pass has heartbeats, not task steps");
	const done = aggregateRunEvents(parseRunEvents(JSON.stringify({ t: "2026-08-01T10:40:00.000Z", kind: "finish", detail: { stopped: "frontier-empty", actions: 47, findings: 30, nodes: 150 } })));
	assert.equal(done?.finished, "frontier-empty");
	assert.equal(done?.actions, 47);
	assert.equal(done?.nodes, 150);
});

test("AggregateRunEvents__CarriesActuatedAndDismissed__When__HeartbeatIsEnriched", () => {
	// The 2026-08-01 heartbeat enrichment: actuated/dismissed ride the progress event (and
	// every finish event) so the board can tell a pass that OPERATED its frontier from one
	// that dismissed it en masse — `frontier` alone cannot.
	const p = aggregateRunEvents(parseRunEvents([
		JSON.stringify({ t: "2026-08-01T10:00:01.000Z", kind: "progress", detail: { actions: 10, frontier: 40, seen: 55, actuated: 8, dismissed: 7, nodes: 12 } }),
		JSON.stringify({ t: "2026-08-01T10:30:00.000Z", kind: "finish", detail: { stopped: "frontier-empty", actions: 47, frontier: 0, seen: 96, actuated: 51, dismissed: 45, nodes: 150 } }),
	].join("\n")));
	assert.equal(p?.actuated, 51);
	assert.equal(p?.dismissed, 45);
	assert.equal(p?.frontier, 0);
	assert.equal(p?.nodes, 150);
});

/*
 * The discovery series (exploreSeries): a run's events folded into the convergence chart's
 * data. Sparse by contract — a field is present only when its event carried it, so
 * pre-enrichment logs still fold into a drawable series.
 */

test("ExploreSeries__FoldsEventsIntoTimeSeries__When__LogIsPreEnrichment", () => {
	// The old event shape: progress = actions/frontier/seen only, nodes only on chapter
	// marks, finish without counters. Every 2026-08-01 pass on disk looks like this.
	const s = exploreSeries(parseRunEvents([
		JSON.stringify({ t: "2026-08-01T10:00:00.000Z", kind: "start", detail: { mode: "explore", app: "Yarn" } }),
		JSON.stringify({ t: "2026-08-01T10:02:00.000Z", kind: "progress", detail: { actions: 10, frontier: 99, seen: 170, elapsed: "2m" } }),
		JSON.stringify({ t: "2026-08-01T10:02:30.000Z", kind: "chapter", detail: { chapter: 2, findings: 4, nodes: 7 } }),
		JSON.stringify({ t: "2026-08-01T10:04:00.000Z", kind: "progress", detail: { actions: 20, frontier: 122, seen: 212, elapsed: "4m" } }),
		JSON.stringify({ t: "2026-08-01T10:05:00.000Z", kind: "finish", detail: { stopped: "frontier-empty", actions: 25, nodes: 30 } }),
	].join("\n")));
	// start is the time origin, not a point — the series holds the four plottable events.
	assert.equal(s.length, 4);
	assert.deepEqual(s.map((p) => p.t), [120_000, 150_000, 240_000, 300_000]);
	assert.equal(s[0]?.frontier, 99);
	assert.equal(s[0]?.actuated, undefined, "pre-enrichment heartbeats carry no actuated");
	assert.equal(s[1]?.kind, "chapter");
	assert.equal(s[1]?.nodes, 7);
	assert.equal(s[1]?.chapter, 2);
	assert.equal(s[3]?.kind, "finish");
	assert.equal(s[3]?.stopped, "frontier-empty");
	assert.equal(s[3]?.actions, 25);
});

test("ExploreSeries__CarriesDiscoveryCounters__When__HeartbeatIsEnriched", () => {
	const s = exploreSeries(parseRunEvents([
		JSON.stringify({ t: "2026-08-01T10:00:00.000Z", kind: "start", detail: {} }),
		JSON.stringify({ t: "2026-08-01T10:02:00.000Z", kind: "progress", detail: { actions: 10, frontier: 40, seen: 55, actuated: 8, dismissed: 7, nodes: 12, tokensIn: 210_000, tokensOut: 9_000, tokensCacheRead: 40_000, tokensCacheCreation: 5_000 } }),
		// A malformed field loses itself, never the point (same posture as aggregateRunEvents).
		JSON.stringify({ t: "2026-08-01T10:04:00.000Z", kind: "progress", detail: { actions: "twenty", frontier: 31 } }),
	].join("\n")));
	assert.equal(s.length, 2);
	assert.equal(s[0]?.actuated, 8);
	assert.equal(s[0]?.dismissed, 7);
	assert.equal(s[0]?.nodes, 12);
	assert.equal(s[0]?.tokensIn, 210_000);
	assert.equal(s[0]?.tokensCacheCreation, 5_000);
	assert.equal(s[1]?.actions, undefined);
	assert.equal(s[1]?.frontier, 31);
});

test("ExploreSeries__ReturnsEmpty__When__EventsAreTaskShaped", () => {
	// A task run's events are steps/verdict — nothing here plots on a discovery chart.
	const s = exploreSeries(parseRunEvents([
		JSON.stringify({ t: "2026-08-01T10:00:01.000Z", kind: "step", detail: { step: 1, action: "click", verified: true } }),
		JSON.stringify({ t: "2026-08-01T10:00:06.000Z", kind: "verdict", detail: { success: true } }),
	].join("\n")));
	assert.deepEqual(s, []);
	assert.deepEqual(exploreSeries([]), []);
});

test("ExploreSeries__CapturesTheFatalEndpoint__When__PassDied", () => {
	const s = exploreSeries(parseRunEvents([
		JSON.stringify({ t: "2026-08-01T10:00:00.000Z", kind: "progress", detail: { actions: 10, frontier: 99 } }),
		JSON.stringify({ t: "2026-08-01T10:03:00.000Z", kind: "fatal", detail: { error: "target not observable\nsecond line of prose", actions: 139 } }),
	].join("\n")));
	assert.equal(s[1]?.kind, "fatal");
	assert.equal(s[1]?.fatal, "target not observable", "the marker label wants the first line only");
	assert.equal(s[1]?.actions, 139);
});

test("BuildDetail__CarriesTheDiscoverySeries__When__ArmIsExplore", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-detail-series-"));
	try {
		plant(dir, ["out", "bench", "live", "job-x", "events.jsonl"], [
			JSON.stringify({ t: "2026-08-01T10:00:00.000Z", kind: "start", detail: { mode: "explore", app: "Yarn" } }),
			JSON.stringify({ t: "2026-08-01T10:02:00.000Z", kind: "progress", detail: { actions: 10, frontier: 99, seen: 170 } }),
			JSON.stringify({ t: "2026-08-01T10:05:00.000Z", kind: "finish", detail: { stopped: "frontier-empty", actions: 25, nodes: 30 } }),
		].join("\n") + "\n");
		const m = manifest(entry({ jobId: "job-x", armId: "explore-ax", state: "done", collected: true }));
		const d = buildDetail("job-x", m, { dataDir: dir, benchRoot: path.join(dir, "bench") });
		assert.equal(d.series?.length, 2);
		assert.equal(d.series?.[1]?.stopped, "frontier-empty");
		// A task arm never carries one, even with an events file in its run dir.
		plant(dir, ["out", "bench", "live", "job-y", "events.jsonl"], JSON.stringify({ t: "2026-08-01T10:00:00.000Z", kind: "progress", detail: { actions: 10 } }) + "\n");
		const mt = manifest(entry({ jobId: "job-y", state: "done", collected: true }));
		assert.equal(buildDetail("job-y", mt, { dataDir: dir, benchRoot: path.join(dir, "bench") }).series, undefined);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("LocalRunProgress__ReadsTheWholeFile__When__RunDirIsInLive", () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "dash-progress-"));
	try {
		// More step events than storeEvents' display tail holds — the counters must not
		// saturate at a tail cap, which is why this reads the whole file.
		const lines = Array.from({ length: 60 }, (_, i) =>
			JSON.stringify({ t: `2026-08-01T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`, kind: "step", detail: { step: i + 1, action: "click", verified: i % 2 === 0 } }));
		plant(out, ["bench", "live", "run-long", "events.jsonl"], `${lines.join("\n")}\n`);
		const p = localRunProgress("run-long", out);
		assert.equal(p?.steps, 60);
		assert.equal(p?.verified, 30);
		// No events file at all is the common case (runs predating the log) — undefined, not a throw.
		assert.equal(localRunProgress("no-such-run", out), undefined);
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
});

test("BuildState__AttachesLiveProgress__When__EntryUncollected", () => {
	const live = new Map<string, RunProgress>([["job-1", { updatedAt: "2026-08-01T10:00:04.000Z", steps: 3, verified: 2 }]]);
	const s = buildState(
		manifest(entry({})),
		fleet([{ name: "mac1", reachable: true, state: "busy", jobId: "job-1", elapsedSec: 42 }]),
		[],
		true,
		undefined,
		live,
	);
	const e = armView(s, "ax-grounded")?.passes[0]?.entries[0];
	assert.equal(e?.live?.steps, 3);
	assert.equal(e?.live?.verified, 2);
});

test("BuildState__OmitsLiveProgress__When__EntryCollected", () => {
	// Once collect banks the run, its real metrics are the only numbers on the row — carrying
	// the provisional counters past that point would put two answers to "how many steps" on
	// one entry, and the rollups' independence from `live` is what keeps the dashboard unable
	// to disagree with the report.
	const live = new Map<string, RunProgress>([["job-1", { updatedAt: "2026-08-01T10:00:04.000Z", steps: 3, verified: 2 }]]);
	const s = buildState(
		manifest(entry({ state: "done", collected: true, metrics: { success: true, steps: 5, verifiedSteps: 5 } })),
		fleet([]),
		[],
		true,
		undefined,
		live,
	);
	const e = armView(s, "ax-grounded")?.passes[0]?.entries[0];
	assert.equal(e?.live, undefined);
	assert.equal(e?.steps, 5, "the collected number stands alone");
});

test("AggregateRunEvents__KeepsLatestUsageTotals__When__MultipleUsageEvents", () => {
	// Usage events carry CUMULATIVE totals (one per model call) — the newest one IS the run's
	// usage so far, so the later event's numbers and model win outright.
	const p = aggregateRunEvents(parseRunEvents([
		JSON.stringify({ t: "2026-08-01T10:00:01.000Z", kind: "usage", detail: { model: "claude-opus-5", modelCalls: 1, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheCreationTokens: 10 } }),
		JSON.stringify({ t: "2026-08-01T10:00:05.000Z", kind: "usage", detail: { model: "gpt-5.6-sol", modelCalls: 3, inputTokens: 4200, outputTokens: 900, cacheReadTokens: 300, cacheCreationTokens: 40 } }),
	].join("\n")));
	assert.equal(p?.modelCalls, 3);
	assert.equal(p?.inputTokens, 4200);
	assert.equal(p?.outputTokens, 900);
	assert.equal(p?.cacheReadTokens, 300);
	assert.equal(p?.cacheCreationTokens, 40);
	assert.equal(p?.model, "gpt-5.6-sol");
	// usd is the VIEW layer's field (entryView prices it) — the aggregator never fills it.
	assert.equal(p?.usd, undefined);
});

test("AggregateRunEvents__IgnoresUsageFields__When__DetailMalformed", () => {
	// Per-field defensive checks: a stringly-typed or missing field loses ITSELF — no NaN, no
	// partial garbage — and never takes the good fields or the run's other counters with it.
	const p = aggregateRunEvents(parseRunEvents([
		JSON.stringify({ t: "2026-08-01T10:00:01.000Z", kind: "step", detail: { step: 1, action: "click", verified: true } }),
		JSON.stringify({ t: "2026-08-01T10:00:02.000Z", kind: "usage", detail: { model: "", modelCalls: "3", inputTokens: "lots", outputTokens: 900 } }),
	].join("\n")));
	assert.equal(p?.outputTokens, 900, "the one well-typed field still lands");
	assert.equal(p?.inputTokens, undefined);
	assert.equal(p?.modelCalls, undefined);
	assert.equal(p?.cacheReadTokens, undefined);
	assert.equal(p?.model, undefined, "an empty model string is no model");
	assert.equal(p?.steps, 1, "a malformed usage detail never loses the run");
});

test("BuildState__PricesLiveUsage__When__EntryUncollected", () => {
	// Live cost is priced server-side with the SAME math as collected rows: estimateCost at
	// the run-recorded model. claude-opus-5 (RATES: in $5, out $25, cache-read $0.5, cache-write
	// $6.25 per MTok) → 0.5 + 0.5 + 0.5 + 0.25 = $1.75.
	const tokens = { inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 1_000_000, cacheCreationTokens: 40_000 };
	const live = new Map<string, RunProgress>([
		["job-1", { updatedAt: "2026-08-01T10:00:04.000Z", steps: 3, verified: 2, modelCalls: 3, model: "claude-opus-5", ...tokens }],
	]);
	const s = buildState(
		manifest(entry({})),
		fleet([{ name: "mac1", reachable: true, state: "busy", jobId: "job-1", elapsedSec: 42 }]),
		[],
		true,
		undefined,
		live,
	);
	const pass = armView(s, "ax-grounded")?.passes[0];
	const e = pass?.entries[0];
	assert.equal(e?.live?.usd, estimateCost(tokens, "claude-opus-5"));
	assert.equal(e?.live?.usd, 1.75);
	assert.equal(e?.live?.outputTokens, 20_000);
	// The invariant the RunProgress header states: live values never feed the cost totals —
	// the pass's usd sums COLLECTED entries only, and nothing here is collected.
	assert.equal(pass?.usd, 0);

	// A collected entry gets no live field at all, priced or not (existing invariant).
	const s2 = buildState(
		manifest(entry({ state: "done", collected: true, metrics: { success: true, steps: 5, verifiedSteps: 5 } })),
		fleet([]),
		[],
		true,
		undefined,
		live,
	);
	assert.equal(armView(s2, "ax-grounded")?.passes[0]?.entries[0]?.live, undefined);
});

test("StoreEvents__OmitsUsageLines__When__TailingRunEvents", () => {
	// Usage is a counter channel, not narrative: aggregation consumes every usage event, but
	// the display feed skips them — one line per model call would crowd the 50-line tail.
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "dash-usage-feed-"));
	try {
		plant(out, ["bench", "live", "run-usage", "events.jsonl"], [
			JSON.stringify({ t: "2026-08-01T10:00:01.000Z", kind: "step", detail: { step: 1, action: "click", verified: true } }),
			JSON.stringify({ t: "2026-08-01T10:00:02.000Z", kind: "usage", detail: { model: "claude-opus-5", modelCalls: 1, inputTokens: 1000, outputTokens: 200 } }),
		].join("\n") + "\n");
		const merged = storeEvents([], 200, out);
		assert.ok(merged.some((e) => e.line.startsWith("step ")), "the step line reaches the feed");
		assert.ok(!merged.some((e) => e.line.startsWith("usage")), "usage lines stay out of the feed");
		// The counters still consume what the feed skips.
		assert.equal(localRunProgress("run-usage", out)?.outputTokens, 200);
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
});

test("StoreEvents__MergesRemoteTails__When__ExtraEventsPassed", () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "dash-events-extra-"));
	try {
		plant(out, ["bench", "live", "run-local", "events.jsonl"], `${JSON.stringify({ t: "2026-08-01T10:00:01.000Z", kind: "start", detail: {} })}\n`);
		// A remote tail line (startDash's ssh fetch) — same shape the local scan produces.
		const extra: DashEvent[] = [{ t: "2026-08-01T10:00:02.000Z", line: "step step=1 action=click verified=true", runKey: "run-remote", source: "run" }];
		const merged = storeEvents([], 200, out, extra);
		assert.deepEqual(merged.map((e) => e.runKey), ["run-local", "run-remote"]);
		assert.equal(merged[1]?.source, "run");
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
});

/*
 * ---- share mode: the posture a HOSTED dash runs in -----------------------------------------
 *
 * Three separable pieces, tested separately because they fail separately: the credential
 * check, the retirement of states a snapshot can no longer resolve, and the flag/env parsing
 * that turns the posture on. The ssh-branch disarming is NOT unit-tested here — it is the
 * absence of an `inventory`, which startDash owns and dash.test.ts has no server for.
 */

test("BasicAuthGate__ReturnsUndefined__When__SpecIsUnset", () => {
	// Undefined means WIDE OPEN, which is the correct default for a laptop-bound dash — and the
	// reason startDash refuses to pair it with --share.
	assert.equal(basicAuthGate(undefined), undefined);
	assert.equal(basicAuthGate(""), undefined);
});

test("BasicAuthGate__AcceptsCredential__When__HeaderMatchesTheSpec", () => {
	const gate = basicAuthGate("yarn:trial2026");
	assert.ok(gate);
	const header = `Basic ${Buffer.from("yarn:trial2026", "utf8").toString("base64")}`;
	assert.equal(gate(header), true);
	// Scheme match is case-insensitive per RFC 7617; the credential itself is not.
	assert.equal(gate(header.replace("Basic", "basic")), true);
});

test("BasicAuthGate__Rejects__When__CredentialOrHeaderIsWrong", () => {
	const gate = basicAuthGate("yarn:trial2026");
	assert.ok(gate);
	assert.equal(gate(`Basic ${Buffer.from("yarn:wrong", "utf8").toString("base64")}`), false);
	// A shorter/longer credential must return false, not throw — timingSafeEqual raises on a
	// length mismatch, so the gate has to check lengths before comparing.
	assert.equal(gate(`Basic ${Buffer.from("y", "utf8").toString("base64")}`), false);
	assert.equal(gate(undefined), false);
	assert.equal(gate("Bearer abc"), false);
	assert.equal(gate("Basic !!!not-base64!!!"), false);
});

test("FreezeStates__RetiresRunningAndQueued__When__EntryIsUncollected", () => {
	const frozen = freezeStates(manifest(
		entry({ jobId: "a", state: "running", collected: false }),
		entry({ jobId: "b", state: "queued", collected: false }),
	));
	// The names are outside collect's failure vocabulary on purpose: nobody diagnosed these.
	assert.deepEqual(frozen.entries.map((e) => e.state), ["abandoned", "never-ran"]);
});

test("FreezeStates__LeavesEntryAlone__When__ItIsCollectedOrAlreadyTerminal", () => {
	const frozen = freezeStates(manifest(
		// A collected entry's status comes from its metrics, never from state — so state must not
		// be rewritten under it, or a run that finished would read as abandoned.
		entry({ jobId: "a", state: "running", collected: true }),
		entry({ jobId: "b", state: "done", collected: true }),
		entry({ jobId: "c", state: "failed", collected: false }),
	));
	assert.deepEqual(frozen.entries.map((e) => e.state), ["running", "done", "failed"]);
});

test("FreezeStates__MovesNoNumber__When__ManifestIsFrozen", () => {
	// The load-bearing property: rollup() reads `collected` and `metrics` only, so retiring a
	// state cannot move a figure the report and the dashboard have to agree on.
	const m = manifest(
		entry({ jobId: "a", state: "running", collected: false }),
		entry({ jobId: "b", state: "done", collected: true, metrics: { success: true, steps: 4, outputTokens: 100 } }),
	);
	const before = buildState(m, fleet([]), [], false);
	const after = buildState(freezeStates(m), fleet([]), [], false);
	assert.deepEqual(after.progress.collected, before.progress.collected);
	assert.deepEqual(after.progress.successes, before.progress.successes);
	assert.equal(after.cost.totalUsd, before.cost.totalUsd);
});

test("ParseDashArgs__PrefersPortOverDashPort__When__BothEnvVarsAreSet", () => {
	const saved = { PORT: process.env.PORT, DASH_PORT: process.env.DASH_PORT };
	try {
		// A PaaS assigns PORT and expects the process to take it; DASH_PORT is the operator's
		// own preference and must not win on a host that already chose.
		process.env.PORT = "10000";
		process.env.DASH_PORT = "4642";
		assert.equal(parseDashArgs([]).port, 10000);
		// An explicit flag still outranks both.
		assert.equal(parseDashArgs(["--port", "5000"]).port, 5000);
	} finally {
		if (saved.PORT === undefined) delete process.env.PORT; else process.env.PORT = saved.PORT;
		if (saved.DASH_PORT === undefined) delete process.env.DASH_PORT; else process.env.DASH_PORT = saved.DASH_PORT;
	}
});

test("ParseDashArgs__SetsShare__When__FlagOrEnvAsksForIt", () => {
	const saved = process.env.DASH_SHARE;
	try {
		delete process.env.DASH_SHARE;
		assert.equal(parseDashArgs([]).share, undefined);
		assert.equal(parseDashArgs(["--share"]).share, true);
		process.env.DASH_SHARE = "1";
		assert.equal(parseDashArgs([]).share, true);
		// Only "1" arms it — a stray DASH_SHARE=false must not read as truthy.
		process.env.DASH_SHARE = "false";
		assert.equal(parseDashArgs([]).share, undefined);
	} finally {
		if (saved === undefined) delete process.env.DASH_SHARE; else process.env.DASH_SHARE = saved;
	}
});

/* ---- the snapshot exporter ----------------------------------------------------------------- */

test("ExportSnapshot__CopiesMetricsAndDropsEvidence__When__RunHasStepsAndRecording", () => {
	const src = fs.mkdtempSync(path.join(os.tmpdir(), "snap-src-"));
	const dest = fs.mkdtempSync(path.join(os.tmpdir(), "snap-dest-"));
	try {
		const m = manifest(entry({ jobId: "run-1", state: "done", collected: true, metrics: { success: true, steps: 3 } }));
		plant(src, ["out", "bench", "live", "2026-07-31", "manifest.json"], JSON.stringify(m));
		plant(src, ["out", "bench", "live", "2026-07-31", "appmaps", "default", "p2-ax-grounded", "run-1", "appmap.md"], "# map");
		plant(src, ["out", "bench", "live", "run-1", "run.json"], JSON.stringify({ success: true }));
		plant(src, ["out", "bench", "live", "run-1", "events.jsonl"], `${JSON.stringify({ t: "2026-07-31T20:00:00.000Z", kind: "start", detail: {} })}\n`);
		plant(src, ["out", "bench", "live", "run-1", "log.txt"], "console output");
		// The bulk the exporter exists to leave behind.
		plant(src, ["out", "bench", "live", "run-1", "steps", "001.png"], "PNGDATA");
		plant(src, ["out", "bench", "live", "run-1", "recording", "take.mp4"], "MP4DATA");
		plant(src, ["out", "bench", "live", "narrative.jsonl"], `${JSON.stringify({ t: "2026-07-31T20:00:00.000Z", text: "a note" })}\n`);

		const r = exportSnapshot({ date: "2026-07-31", srcRoot: path.join(src, "out"), dest });

		assert.equal(r.entries, 1);
		assert.equal(r.runsCopied, 1);
		assert.equal(r.runsMissing, 0);
		const live = path.join(dest, "out", "bench", "live");
		// Metrics travel...
		assert.ok(fs.existsSync(path.join(live, "2026-07-31", "manifest.json")));
		assert.ok(fs.existsSync(path.join(live, "2026-07-31", "appmaps", "default", "p2-ax-grounded", "run-1", "appmap.md")));
		assert.ok(fs.existsSync(path.join(live, "run-1", "run.json")));
		assert.ok(fs.existsSync(path.join(live, "run-1", "events.jsonl")));
		assert.ok(fs.existsSync(path.join(live, "run-1", "log.txt")));
		assert.ok(fs.existsSync(path.join(live, "narrative.jsonl")));
		// ...evidence does not.
		assert.equal(fs.existsSync(path.join(live, "run-1", "steps")), false);
		assert.equal(fs.existsSync(path.join(live, "run-1", "recording")), false);
	} finally {
		fs.rmSync(src, { recursive: true, force: true });
		fs.rmSync(dest, { recursive: true, force: true });
	}
});

test("ExportSnapshot__CarriesTheCursorRender__When__TheRunWasFilmed", () => {
	const src = fs.mkdtempSync(path.join(os.tmpdir(), "snap-src-"));
	const dest = fs.mkdtempSync(path.join(os.tmpdir(), "snap-dest-"));
	try {
		const m = manifest(entry({ jobId: "run-f", state: "done", collected: true }));
		plant(src, ["out", "bench", "live", "2026-07-31", "manifest.json"], JSON.stringify(m));
		plant(src, ["out", "bench", "live", "run-f", "run.json"], JSON.stringify({ success: true }));
		// A filmed run's recording directory, whole: the render, the raw capture it was drawn
		// over, and the frames it was drawn FROM. Exactly one of the three is meant to travel.
		plant(src, ["out", "bench", "live", "run-f", "recording", "humanized.mp4"], "RENDER");
		plant(src, ["out", "bench", "live", "run-f", "recording", "window.mp4"], "RAWCAPTURE");
		plant(src, ["out", "bench", "live", "run-f", "recording", "frames", "0001.png"], "PNGDATA");
		plant(src, ["out", "bench", "live", "run-f", "recording", "trajectory", "clicks.json"], "[]");

		const r = exportSnapshot({ date: "2026-07-31", srcRoot: path.join(src, "out"), dest });

		assert.equal(r.videosCopied, 1);
		const rec = path.join(dest, "out", "bench", "live", "run-f", "recording");
		assert.equal(fs.readFileSync(path.join(rec, "humanized.mp4"), "utf8"), "RENDER");
		// The raw capture is the same take with no cursor in it, and the frames are the render's
		// input — shipping either would multiply the bytes to show nothing new.
		assert.equal(fs.existsSync(path.join(rec, "window.mp4")), false);
		assert.equal(fs.existsSync(path.join(rec, "frames")), false);
		assert.equal(fs.existsSync(path.join(rec, "trajectory")), false);
	} finally {
		fs.rmSync(src, { recursive: true, force: true });
		fs.rmSync(dest, { recursive: true, force: true });
	}
});

test("ExportSnapshot__CountsNoVideos__When__NoRunWasFilmed", () => {
	const src = fs.mkdtempSync(path.join(os.tmpdir(), "snap-src-"));
	const dest = fs.mkdtempSync(path.join(os.tmpdir(), "snap-dest-"));
	try {
		const m = manifest(entry({ jobId: "run-u", state: "done", collected: true }));
		plant(src, ["out", "bench", "live", "2026-07-31", "manifest.json"], JSON.stringify(m));
		plant(src, ["out", "bench", "live", "run-u", "run.json"], JSON.stringify({ success: true }));
		// An unfilmed run whose recording dir holds only a raw capture must not leave an EMPTY
		// recording/ behind in the snapshot — the dash reads existence, so a hollow directory
		// would be a lie in the shape of a truth.
		plant(src, ["out", "bench", "live", "run-u", "recording", "window.mp4"], "RAWCAPTURE");

		const r = exportSnapshot({ date: "2026-07-31", srcRoot: path.join(src, "out"), dest });

		assert.equal(r.videosCopied, 0);
		assert.equal(fs.existsSync(path.join(dest, "out", "bench", "live", "run-u", "recording")), false);
	} finally {
		fs.rmSync(src, { recursive: true, force: true });
		fs.rmSync(dest, { recursive: true, force: true });
	}
});

test("ExportSnapshot__CountsEntryAsMissing__When__ItsRunDirectoryWasNeverWritten", () => {
	const src = fs.mkdtempSync(path.join(os.tmpdir(), "snap-src-"));
	const dest = fs.mkdtempSync(path.join(os.tmpdir(), "snap-dest-"));
	try {
		// A queued entry that never ran, and a failed one collect evicted — both legitimate.
		const m = manifest(entry({ jobId: "gone", state: "queued", collected: false }));
		plant(src, ["out", "bench", "live", "2026-07-31", "manifest.json"], JSON.stringify(m));

		const r = exportSnapshot({ date: "2026-07-31", srcRoot: path.join(src, "out"), dest });

		assert.equal(r.runsMissing, 1);
		assert.equal(r.runsCopied, 0);
		// The manifest still travels: the entry renders from metrics (or their absence) alone.
		assert.ok(fs.existsSync(path.join(dest, "out", "bench", "live", "2026-07-31", "manifest.json")));
	} finally {
		fs.rmSync(src, { recursive: true, force: true });
		fs.rmSync(dest, { recursive: true, force: true });
	}
});

test("ExportSnapshot__Throws__When__TheDatesManifestIsEmpty", () => {
	const src = fs.mkdtempSync(path.join(os.tmpdir(), "snap-src-"));
	const dest = fs.mkdtempSync(path.join(os.tmpdir(), "snap-dest-"));
	try {
		plant(src, ["out", "bench", "live", "2026-07-31", "manifest.json"], JSON.stringify({ date: "2026-07-31", createdAt: "", entries: [] }));
		// Publishing an empty board is a mistake worth hearing about, not a 0-byte snapshot.
		assert.throws(() => exportSnapshot({ date: "2026-07-31", srcRoot: path.join(src, "out"), dest }), /nothing to snapshot/);
	} finally {
		fs.rmSync(src, { recursive: true, force: true });
		fs.rmSync(dest, { recursive: true, force: true });
	}
});
