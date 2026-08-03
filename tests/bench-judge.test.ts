import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseJudgeMetrics } from "../src/bench/collect.js";
import { BENCH_JUDGE_MODEL, judgeBench } from "../src/bench/judge.js";
import { type ManifestEntry, type RunMetrics, writeManifest } from "../src/bench/manifest.js";
import { armById } from "../src/bench/matrix.js";
import { judgeDisagreements, writeReport } from "../src/bench/report.js";
import { withTemp, withTempAsync } from "./fixtures.js";
import { liveDir, RUN_FILES, runDir } from "../src/paths.js";

/**
 * The bench judge, offline by construction — same rule as bench.test.ts: the judge model
 * call is an injected fake, every manifest and artifact lands in a temp dir. Nothing here
 * may call OpenRouter; a stray real judge spends money and returns nondeterminism.
 *
 * Layout mirrors the collect tests: one temp dir per test, `outRoot = <dir>/out` (manifest at
 * <outRoot>/live/bench/<date>/manifest.json since the 2026-08-01 consolidation), `dataDir =
 * <dir>` (run log and judge artifact together in <dataDir>/out/bench/live/<jobId>/).
 *
 * The fixtures use the CURRENT layout deliberately. The pre-consolidation one still resolves
 * through runFile's fallback and is covered in runs.test.ts; leaving these on the old paths
 * would have meant nothing exercised judgeBench against what production actually writes.
 */

const DATE = "2026-07-31";

// Real arm ids off the matrix — one per kind the judge cares about.
const TASK_ARM = "ax-grounded";
const REPLAY_ARM = "replay-ax";
const EXPLORE_ARM = "explore-ax";

test("armById__ResolvesFixtureArms__When__JudgeTestsRun", () => {
	// Guard against matrix drift making every test below vacuous: the fixture ids must stay
	// real and keep their kinds.
	assert.equal(armById(TASK_ARM)?.kind, "task");
	assert.equal(armById(REPLAY_ARM)?.kind, "replay");
	assert.equal(armById(EXPLORE_ARM)?.kind, "explore");
});

test("BENCH_JUDGE_MODEL__PinsTheJudgeModel__When__Exported", () => {
	// Frozen by the contract: the judge is a fixed model, not whatever AGENT_MODEL says.
	// `azure/` since 2026-07-31 — same model, but the OpenRouter key it used to ride was
	// found dead in a pre-flight check, and the id decides the transport (makeClient).
	assert.equal(BENCH_JUDGE_MODEL, "azure/gpt-5.6-sol");
});

// --- fixtures ---

const entry = (armId: string, jobId: string, over: Partial<ManifestEntry> = {}): ManifestEntry => ({
	armId,
	jobId,
	host: "mac1",
	submittedAt: "2026-07-31T10:00:00.000Z",
	state: "done",
	collected: false,
	...over,
});

function seedManifest(outRoot: string, entries: ManifestEntry[]): void {
	writeManifest({ date: DATE, createdAt: "2026-07-31T09:00:00.000Z", entries }, liveDir(outRoot));
}

function runsDir(dataDir: string, jobId: string): string {
	const dir = runDir(jobId, path.join(dataDir, "out"));
	fs.mkdirSync(dir, { recursive: true });

	return dir;
}

function writeRunLog(dataDir: string, jobId: string): void {
	fs.writeFileSync(path.join(runsDir(dataDir, jobId), RUN_FILES.log), JSON.stringify({ task: "t", app: "Yarn", success: true }));
}

function writeJudgeArtifact(dataDir: string, jobId: string, report: Record<string, unknown> = { trajectory: "PASS" }): void {
	fs.writeFileSync(path.join(runsDir(dataDir, jobId), RUN_FILES.judge), JSON.stringify(report));
}

/** An injected judge that records its calls and throws for the stamps it is told to. */
function fakeJudge(failOn: Set<string> = new Set()): { calls: string[]; fn: (stamp: string) => Promise<unknown> } {
	const calls: string[] = [];

	return {
		calls,
		fn: async (stamp: string) => {
			calls.push(stamp);
			if (failOn.has(stamp)) throw new Error(`judge exploded on ${stamp}`);

			return { trajectory: "PASS" };
		},
	};
}

// --- judgeBench: eligibility + idempotency ---

test("judgeBench__CallsJudge__When__TerminalTaskEntryUnjudged", async () => {
	await withTempAsync("bench-judge-", async (dir) => {
		const outRoot = path.join(dir, "out");
		seedManifest(outRoot, [entry(TASK_ARM, "job-1")]);
		writeRunLog(dir, "job-1");

		const judge = fakeJudge();
		const outcome = await judgeBench({ date: DATE, outRoot, dataDir: dir, log: () => {}, judge: judge.fn });
		assert.deepEqual(outcome.judged, ["job-1"]);
		assert.deepEqual(outcome.skipped, []);
		assert.deepEqual(outcome.failed, []);
		assert.deepEqual(judge.calls, ["job-1"]);
	});
});

test("judgeBench__Skips__When__JudgeArtifactExists", async () => {
	await withTempAsync("bench-judge-", async (dir) => {
		const outRoot = path.join(dir, "out");
		seedManifest(outRoot, [entry(TASK_ARM, "job-1")]);
		writeRunLog(dir, "job-1");
		writeJudgeArtifact(dir, "job-1");

		const judge = fakeJudge();
		const outcome = await judgeBench({ date: DATE, outRoot, dataDir: dir, log: () => {}, judge: judge.fn });
		// Idempotent: an already-judged run is reported as skipped and never re-spends a call.
		assert.deepEqual(outcome.skipped, ["job-1"]);
		assert.deepEqual(outcome.judged, []);
		assert.deepEqual(outcome.failed, []);
		assert.deepEqual(judge.calls, []);
	});
});

test("judgeBench__Ignores__When__ArmIsExplore", async () => {
	await withTempAsync("bench-judge-", async (dir) => {
		const outRoot = path.join(dir, "out");
		seedManifest(outRoot, [entry(EXPLORE_ARM, "explore-1")]);
		writeRunLog(dir, "explore-1");

		const judge = fakeJudge();
		const outcome = await judgeBench({ date: DATE, outRoot, dataDir: dir, log: () => {}, judge: judge.fn });
		// Ineligible entries appear in NO outcome list — an explore pass has no trajectory to judge.
		assert.deepEqual(outcome.judged, []);
		assert.deepEqual(outcome.skipped, []);
		assert.deepEqual(outcome.failed, []);
		assert.deepEqual(judge.calls, []);
	});
});

test("judgeBench__Ignores__When__StateNotTerminal", async () => {
	await withTempAsync("bench-judge-", async (dir) => {
		const outRoot = path.join(dir, "out");
		seedManifest(outRoot, [entry(TASK_ARM, "job-1", { state: "running" })]);
		writeRunLog(dir, "job-1");

		const judge = fakeJudge();
		const outcome = await judgeBench({ date: DATE, outRoot, dataDir: dir, log: () => {}, judge: judge.fn });
		assert.deepEqual(outcome.judged, []);
		assert.deepEqual(outcome.skipped, []);
		assert.deepEqual(outcome.failed, []);
		assert.deepEqual(judge.calls, []);
	});
});

test("judgeBench__Ignores__When__RunLogMissing", async () => {
	await withTempAsync("bench-judge-", async (dir) => {
		const outRoot = path.join(dir, "out");
		seedManifest(outRoot, [entry(TASK_ARM, "job-1")]);
		// Terminal, but out/runs/job-1.json was never pulled — nothing for a judge to read.

		const judge = fakeJudge();
		const outcome = await judgeBench({ date: DATE, outRoot, dataDir: dir, log: () => {}, judge: judge.fn });
		assert.deepEqual(outcome.judged, []);
		assert.deepEqual(outcome.skipped, []);
		assert.deepEqual(outcome.failed, []);
		assert.deepEqual(judge.calls, []);
	});
});

test("judgeBench__RecordsFailureAndContinues__When__JudgeThrows", async () => {
	await withTempAsync("bench-judge-", async (dir) => {
		const outRoot = path.join(dir, "out");
		// Two eligible unjudged entries; the replay arm doubles as the "replay is eligible"
		// check and "failed" as the non-done terminal-state check.
		seedManifest(outRoot, [entry(TASK_ARM, "job-1"), entry(REPLAY_ARM, "job-2", { state: "failed" })]);
		writeRunLog(dir, "job-1");
		writeRunLog(dir, "job-2");

		const judge = fakeJudge(new Set(["job-1"]));
		const outcome = await judgeBench({ date: DATE, outRoot, dataDir: dir, log: () => {}, judge: judge.fn });
		// The first entry's rejection is recorded, not thrown — the loop reaches job-2.
		assert.equal(outcome.failed.length, 1);
		assert.equal(outcome.failed[0].jobId, "job-1");
		assert.match(outcome.failed[0].error, /exploded/);
		assert.deepEqual(outcome.judged, ["job-2"]);
		assert.deepEqual(outcome.skipped, []);
		assert.deepEqual(judge.calls, ["job-1", "job-2"]);
	});
});

// --- collect: judge artifact → metrics ---

test("parseJudgeMetrics__MapsAllFields__When__ArtifactComplete", () => {
	const m = parseJudgeMetrics({
		trajectory: "PASS",
		visual: "FAIL",
		scope: "brand",
		model: "openai/gpt-5.6-sol",
		framesUsed: 3,
	});
	assert.deepEqual(m, {
		judgeTrajectory: "PASS",
		judgeVisual: "FAIL",
		judgeScope: "brand",
		judgeModel: "openai/gpt-5.6-sol",
		judgeFrames: 3,
	});
});

test("parseJudgeMetrics__OmitsFields__When__ArtifactSparse", () => {
	const m = parseJudgeMetrics({ trajectory: "UNPROVEN" });
	assert.equal(m.judgeTrajectory, "UNPROVEN");
	// Absent input fields stay absent — no undefined-valued keys to trip JSON round-trips
	// or Object.keys-based reporting.
	for (const key of ["judgeVisual", "judgeScope", "judgeModel", "judgeFrames"]) {
		assert.ok(!Object.hasOwn(m, key), `${key} must not be an own property`);
	}
});

// --- report: self-verdict vs judge-verdict ---

const judged = (jobId: string, metrics: RunMetrics | undefined): ManifestEntry => entry(TASK_ARM, jobId, { collected: true, metrics });

test("judgeDisagreements__ReturnsEntry__When__SelfSuccessButJudgeFail", () => {
	const e = judged("job-1", { success: true, judgeTrajectory: "FAIL" });
	assert.deepEqual(judgeDisagreements([e]), [e]);
});

test("judgeDisagreements__ReturnsEntry__When__SelfFailButJudgePass", () => {
	const e = judged("job-1", { success: false, judgeTrajectory: "PASS" });
	assert.deepEqual(judgeDisagreements([e]), [e]);
});

test("judgeDisagreements__ReturnsEmpty__When__JudgeUnproven", () => {
	// UNPROVEN never disagrees, in either direction; missing judge fields or missing metrics
	// never disagree; agreement is not disagreement.
	const entries: ManifestEntry[] = [
		judged("job-1", { success: true, judgeTrajectory: "UNPROVEN" }),
		judged("job-2", { success: false, judgeTrajectory: "UNPROVEN" }),
		judged("job-3", { success: true }),
		judged("job-4", undefined),
		judged("job-5", { success: true, judgeTrajectory: "PASS" }),
		judged("job-6", { success: false, judgeTrajectory: "FAIL" }),
	];
	assert.deepEqual(judgeDisagreements(entries), []);
});

test("writeReport__EmitsJudgeSection__When__ManifestHasEntries", () => {
	withTemp("bench-judge-", (dir) => {
		const m = {
			date: DATE,
			createdAt: "2026-07-31T09:00:00.000Z",
			entries: [
				judged("job-1", { success: true, judgeTrajectory: "FAIL", judgeVisual: "FAIL", judgeScope: "brand" }),
				entry(TASK_ARM, "job-2", { collected: true, metrics: { success: true } }),
			],
		};
		const file = writeReport(m, { dir });
		const md = fs.readFileSync(file, "utf8");
		assert.ok(md.includes("## Judge"), "report must carry the judge section");
	});
});
