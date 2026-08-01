import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildDetail, buildState, defaultDashDate, type FleetView, fromStore, groundingArmId, loadEnvFallback, matchPath, parseDashArgs, parseEnvLine, parseLogFrames, rankExplore } from "../src/bench/dash.js";
import type { Manifest, ManifestEntry } from "../src/bench/manifest.js";
import { armById } from "../src/bench/matrix.js";

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
				metrics: { success: true, steps: 5, elapsedSec: 205, model: "claude-opus-5", inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 310_000, cacheCreationTokens: 88_000, endedAt: "2026-07-31T20:10:00.000Z" },
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
	const p = armView(s, "p2-ax-grounded")?.passes[0];
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
	assert.equal(armView(s, "p2-ax-grounded")?.passes[0]?.unpriced, 1);
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

// Three explore passes for one arm, the middle one a degenerate husk (the 8-node map class
// the multi-pass matrix exists to catch): medians must ignore it where a mean would not.
const explorePasses = () =>
	manifest(
		entry({
			armId: "p1-explore-ax",
			jobId: "explore-a",
			state: "done",
			collected: true,
			metrics: { exploreActions: 96, exploreElapsed: "40m12s", controlsSeen: 396, controlsActuated: 47, controlsDismissed: 350, surfaces: 34, graphNodes: 150, graphEdges: 60, scopeAmbiguities: 10 },
		}),
		entry({
			armId: "p1-explore-ax",
			jobId: "explore-husk",
			state: "done",
			collected: true,
			metrics: { exploreActions: 5, exploreElapsed: "3m01s", controlsSeen: 12, controlsActuated: 3, controlsDismissed: 2, surfaces: 3, graphNodes: 8, graphEdges: 2, scopeAmbiguities: 0 },
		}),
		entry({
			armId: "p1-explore-ax",
			jobId: "explore-c",
			state: "done",
			collected: true,
			metrics: { exploreActions: 90, exploreElapsed: "38m40s", controlsSeen: 380, controlsActuated: 41, controlsDismissed: 300, surfaces: 30, graphNodes: 142, graphEdges: 55, scopeAmbiguities: 8 },
		}),
	);

test("BuildState__MediansExploreAggregates__When__ADegeneratePassLands", () => {
	const s = buildState(explorePasses(), fleet([]), [], true);
	const ex = armView(s, "p1-explore-ax")?.passes[0]?.explore;
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
	const entries = armView(s, "p1-explore-ax")?.passes[0]?.entries;
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
	assert.equal(armView(s, "p2-ax-grounded")?.passes[0]?.entries[0]?.exploreStamp, undefined);
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
			entry({ armId: "p1-explore-ax", jobId: "e-ax", state: "done", collected: true, metrics: { graphNodes: 150, surfaces: 30, controlsActuated: 40 } }),
			entry({ armId: "p1-explore-cdp", jobId: "e-cdp", state: "done", collected: true, metrics: { graphNodes: 90, surfaces: 28, controlsActuated: 44 } }),
			entry({ jobId: "job-task", state: "done", collected: true, metrics: { success: true, steps: 5 } }),
		),
		fleet([]),
		[],
		true,
	);
	assert.deepEqual(armView(s, "p1-explore-ax")?.passes[0]?.exploreRank, { rank: 1, of: 2 });
	assert.deepEqual(armView(s, "p1-explore-cdp")?.passes[0]?.exploreRank, { rank: 2, of: 2 });
	// Task arms never rank.
	assert.equal(armView(s, "p2-ax-grounded")?.passes[0]?.exploreRank, undefined);
});

test("BuildState__ExposesLineageAndTargetKey__When__ArmsRideTheWire", () => {
	// The board nests task/replay arms under the explore pass that grounded them, and the
	// scope picker keys off targetKey — both must ride the wire for every arm.
	const s = buildState(manifest(), fleet([]), [], false);
	const byId = (id: string) => s.arms.find((a) => a.id === id);
	assert.equal(byId("p2-ax-grounded")?.groundedBy, "p1-explore-ax");
	assert.equal(byId("p2-cdp-grounded")?.groundedBy, "p1-explore-cdp");
	// Curated (USE_RECIPE) arms are grounded — they nest too.
	assert.equal(byId("p2-ax-curated")?.groundedBy, "p1-explore-ax");
	// Replays consume the same lineage as the run they were compiled from.
	assert.equal(byId("p3-replay-cdp")?.groundedBy, "p1-explore-cdp");
	// Ungrounded arms and explore/compile arms carry no lineage.
	assert.equal(byId("p2-ax-ungrounded")?.groundedBy, undefined);
	assert.equal(byId("p1-explore-ax")?.groundedBy, undefined);
	assert.equal(byId("p3-compile-ax")?.groundedBy, undefined);
	assert.ok(s.arms.every((a) => typeof a.targetKey === "string" && a.targetKey.length > 0));
	assert.equal(byId("p2-ax-grounded")?.targetKey, "Yarn");
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
	assert.equal(groundingArmId(armById("p2-cdp-grounded")!), "p1-explore-cdp");
	assert.equal(groundingArmId(armById("p2-ax-grounded")!), "p1-explore-ax");
	assert.equal(groundingArmId(armById("p2-vision-only-grounded-visionmap")!), "p1-explore-vision");
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
 * The store adapter. The runner saves all live data under out/live (canonical, read-only to
 * the dash) with out/archive as a hard-linked backup; anything older sits at its legacy path
 * (out/bench, out/jobs, out/runs). Every dash read resolves live → archive → legacy, so
 * these pin the precedence with real directories the way the buildDetail fixtures do.
 */

const REL = ["bench", "2026-08-01", "manifest.json"];

const plant = (root: string, parts: string[], body = "{}"): void => {
	fs.mkdirSync(path.join(root, ...parts.slice(0, -1)), { recursive: true });
	fs.writeFileSync(path.join(root, ...parts), body);
};

test("FromStore__PrefersLive__When__LiveAndLegacyBothExist", () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "dash-store-"));
	try {
		plant(out, ["live", ...REL]);
		plant(out, REL);
		assert.equal(fromStore(REL, out), path.join(out, "live", ...REL));
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
});

test("FromStore__FallsBackToArchiveThenLegacy__When__LiveIsAbsent", () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "dash-store-"));
	try {
		plant(out, ["archive", ...REL]);
		plant(out, REL);
		assert.equal(fromStore(REL, out), path.join(out, "archive", ...REL));
		fs.rmSync(path.join(out, "archive"), { recursive: true });
		assert.equal(fromStore(REL, out), path.join(out, ...REL));
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
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
		plant(out, ["live", "bench", "2026-08-01", "manifest.json"], full);
		// An empty next-day husk (any post-midnight collect mints one) must not outrank either.
		plant(out, ["bench", "2026-08-02", "manifest.json"], JSON.stringify({ date: "x", createdAt: "x", entries: [] }));
		assert.equal(defaultDashDate(out), "2026-08-01");
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
});

test("BuildDetail__ReadsRunLog__When__RunLandedInTheLiveStore", () => {
	// The consolidated layout: one directory per run, out/live/<job>/run.json — no legacy
	// out/runs fallback involved. The walk must come out identical to the legacy fixture's.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-detail-live-"));
	try {
		fs.mkdirSync(path.join(dir, "docs", "appmaps"), { recursive: true });
		fs.writeFileSync(path.join(dir, "docs", "appmaps", "yarn.json"), JSON.stringify(GRAPH));
		fs.mkdirSync(path.join(dir, "out", "live", "job-l"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "out", "live", "job-l", "run.json"),
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

test("ParseDashArgs__DefaultsToPureReader__When__NoCollectFlagGiven", () => {
	// READ-ONLY posture: out/live is the runner's store; collecting is opt-in. --date keeps
	// the parse off the real repo's bench tree.
	assert.equal(parseDashArgs(["--date", "2026-08-01"]).autoCollect, false);
	assert.equal(parseDashArgs(["--date", "2026-08-01", "--collect"]).autoCollect, true);
	// The old opt-out stays accepted as a harmless no-op — it already means "pure reader".
	assert.equal(parseDashArgs(["--date", "2026-08-01", "--no-collect"]).autoCollect, false);
});
