import assert from "node:assert/strict";
import { test } from "node:test";
import { buildState, type FleetView } from "../src/bench/dash.js";
import type { Manifest, ManifestEntry } from "../src/bench/manifest.js";

/**
 * The dashboard's state assembly, pure by construction: manifest + fleet snapshot in,
 * wire JSON out. The live-status mapping is the part worth testing — it is the one place
 * the dashboard makes its own call (running/queued/awaiting-collect) instead of relaying
 * numbers the report's rollup() already computed and bench.test.ts already covers.
 */

const entry = (over: Partial<ManifestEntry>): ManifestEntry => ({
	armId: "p2-ax-grounded",
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
	const e = armView(s, "p2-ax-grounded")?.passes[0]?.entries[0];
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
	const e = armView(s, "p2-ax-grounded")?.passes[0]?.entries[0];
	assert.equal(e?.status, "queued");
	assert.equal(e?.queuePosition, 2);
});

test("BuildState__MarksAwaitingCollect__When__HostAnsweredWithoutTheJob", () => {
	const s = buildState(manifest(entry({})), fleet([{ name: "mac1", reachable: true, state: "idle" }]), [], true);
	assert.equal(armView(s, "p2-ax-grounded")?.passes[0]?.entries[0]?.status, "awaiting-collect");
});

test("BuildState__KeepsManifestState__When__HostIsUnreachable", () => {
	// An unreachable host proves nothing about the job, so the last-known state stands.
	const s = buildState(manifest(entry({})), fleet([{ name: "mac1", reachable: false, state: "unknown", reason: "down" }]), [], true);
	assert.equal(armView(s, "p2-ax-grounded")?.passes[0]?.entries[0]?.status, "running");
});

test("BuildState__RollsUpSuccessAndCost__When__EntriesAreCollected", () => {
	const s = buildState(
		manifest(
			entry({
				jobId: "job-ok",
				state: "done",
				collected: true,
				metrics: { success: true, steps: 5, elapsedSec: 205, model: "claude-opus-5", inputTokens: 1_000_000, outputTokens: 100_000, endedAt: "2026-07-31T20:10:00.000Z" },
			}),
			entry({ jobId: "job-bad", state: "failed", collected: true, metrics: { success: false, failureKind: "unready" } }),
		),
		fleet([]),
		[],
		true,
	);
	const p = armView(s, "p2-ax-grounded")?.passes[0];
	assert.equal(p?.collected, 2);
	assert.equal(p?.successes, 1);
	// The chip's "ran for" readout: the run log's own clock reaches the wire on collected entries.
	assert.equal(p?.entries.find((e) => e.jobId === "job-ok")?.elapsedSec, 205);
	// claude-opus-5: $5/M input + $25/M output → 1M in + 0.1M out = $7.50
	assert.ok(Math.abs((p?.usd ?? 0) - 7.5) < 1e-9);
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
				armId: "p1-explore-ax",
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
	const p = armView(s, "p1-explore-ax")?.passes[0];
	assert.equal(p?.explore?.controlsActuated, 47);
	assert.equal(p?.explore?.controlsSeen, 396);
	assert.equal(p?.explore?.scopeAmbiguities, 10);
});

test("BuildState__OmitsArmPasses__When__NothingSubmitted", () => {
	// Every MATRIX arm rides the wire so the page can show the whole plan, but an arm with
	// no submissions carries no pass — the page reads passes.length as "not started".
	const s = buildState(manifest(), fleet([]), [], false);
	assert.ok(s.arms.length > 20);
	assert.ok(s.arms.every((a) => a.passes.length === 0));
	assert.equal(s.progress.submitted, 0);
});
