import assert from "node:assert/strict";
import { test } from "node:test";
import { liveDir } from "../src/paths.js";
import { type Manifest, readManifest, recordSubmissions, writeManifest } from "../src/bench/manifest.js";
import { BENCH_PRIMARY_MODEL } from "../src/bench/matrix.js";
import { rebalanceStranded } from "../src/bench/rebalance.js";
import { withTempAsync } from "./fixtures.js";

const DATE = "2026-07-31";

/** A minimal accepted dispatch — only the fields rebalance reads are meaningful. */
const accepted = (jobId: string): any => ({ ok: true, jobId, host: { name: "mac2" }, queued: false, kind: "task", app: "Yarn", artifacts: [], attempts: [] });
const ARM = "cdp-grounded";

/** mac1 busy with one queued job, mac2 idle — the shape `stranded()` exists for. */
const rows = (): any[] => [
	{ name: "mac1", reachable: true, state: "busy", jobId: "running-1", queue: [{ jobId: "queued-1", queuedAt: "2026-07-31T10:00:00.000Z", kind: "task" }] },
	{ name: "mac2", reachable: true, state: "idle", queue: [] },
];

const seed = (dir: string): Manifest => {
	const m = recordSubmissions(readManifest(DATE, liveDir(dir)), [
		{ armId: ARM, jobId: "queued-1", host: "mac1", submittedAt: "2026-07-31T10:00:00.000Z", state: "queued", model: BENCH_PRIMARY_MODEL, collected: false },
	]);
	writeManifest(m, liveDir(dir));

	return m;
};

test("rebalanceStranded__ReplacesTheEntryRatherThanStoppingAndAdding__When__AJobMoves", async () => {
	await withTempAsync("reb-", async (dir) => {
		seed(dir);
		const stopped: string[] = [];
		const moves = await rebalanceStranded({
			rows: rows(),
			date: DATE,
			root: liveDir(dir),
			stopFn: async (_h, j) => void stopped.push(j),
			dispatchFn: async () => accepted("moved-1"),
		});
		assert.deepEqual(stopped, ["queued-1"], "the queued job is cancelled before it is re-sent");
		assert.equal(moves.length, 1);

		// THE POINT. A stop-and-resubmit would leave two rows for one sample, and `stopped` is
		// deliberately not a technical failure — so the dead row would still count and the arm
		// would finish one short. A move is the same sample on a different Mac.
		const after = readManifest(DATE, liveDir(dir));
		const forArm = after.entries.filter((e) => e.armId === ARM);
		assert.equal(forArm.length, 1, "one sample, one row — never a stopped row plus a live one");
		assert.equal(forArm[0].jobId, "moved-1");
		assert.equal(forArm[0].host, "mac2");
	});
});

test("rebalanceStranded__DropsTheRowAndOwesTheSample__When__TheIdleHostRefuses", async () => {
	await withTempAsync("reb-", async (dir) => {
		seed(dir);
		const lines: string[] = [];
		const moves = await rebalanceStranded({
			rows: rows(),
			date: DATE,
			root: liveDir(dir),
			stopFn: async () => {},
			dispatchFn: async () => ({ ok: false as const, error: "unreachable", attempts: [] }),
			log: (s) => lines.push(s),
		});
		assert.deepEqual(moves, []);
		// Cancelled on mac1 and refused by mac2: the row must go, or a job that no longer exists
		// anywhere keeps counting as a submitted sample and the arm never tops up.
		assert.equal(readManifest(DATE, liveDir(dir)).entries.filter((e) => e.armId === ARM).length, 0);
		assert.ok(lines.some((l) => l.includes("owed")), "the loss is reported, not swallowed");
	});
});

test("rebalanceStranded__LeavesAdHocRunsAlone__When__NoManifestRowExists", async () => {
	await withTempAsync("reb-", async (dir) => {
		// A run dispatched by hand is real work on a real Mac; nothing here can rebuild a spec
		// the manifest never held, so it stays where it is rather than being cancelled.
		writeManifest(readManifest(DATE, liveDir(dir)), liveDir(dir));
		const stopped: string[] = [];
		const moves = await rebalanceStranded({
			rows: rows(),
			date: DATE,
			root: liveDir(dir),
			stopFn: async (_h, j) => void stopped.push(j),
			dispatchFn: async () => accepted("x"),
		});
		assert.deepEqual(moves, []);
		assert.deepEqual(stopped, [], "an ad-hoc run is never cancelled");
	});
});

test("rebalanceStranded__DoesNothing__When__NoHostIsIdle", async () => {
	await withTempAsync("reb-", async (dir) => {
		seed(dir);
		const moves = await rebalanceStranded({
			rows: [{ name: "mac1", reachable: true, state: "busy", queue: [{ jobId: "queued-1", queuedAt: "2026-07-31T10:00:00.000Z" }] } as any],
			date: DATE,
			root: liveDir(dir),
			stopFn: async () => assert.fail("nothing to move"),
			dispatchFn: async () => assert.fail("nothing to move"),
		});
		assert.deepEqual(moves, []);
	});
});
