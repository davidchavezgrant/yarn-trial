import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readTrajectory } from "../src/cursor/track.js";
import { TrajectoryWriter } from "../src/core/trajectory.js";

/**
 * The contract under test is the ROUND TRIP: whatever TrajectoryWriter emits must come back
 * through readTrajectory() — the same reader that consumes the driver's recordings — with
 * the fields the motion pass depends on intact. Field-by-field assertions against the JSON
 * would pass while the reader rejected the file; this cannot.
 */

const tmpRecording = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "trajectory-test-"));

test("TrajectoryWriter__RoundTripsThroughReadTrajectory__When__TurnsAreRecorded", () => {
	const dir = tmpRecording();
	const w = new TrajectoryWriter(path.join(dir, "trajectory"));
	const t0 = Date.now();
	w.record({
		tool: "click",
		args: { ref: "e53" },
		clickPoint: { x: 640.5, y: 210 },
		startedAtMs: t0,
		endedAtMs: t0 + 250,
		resultSummary: "click on [e53]",
	});
	w.record({ tool: "press_key", args: { key: "escape" }, startedAtMs: t0 + 5000, endedAtMs: t0 + 5040 });

	const turns = readTrajectory(dir);
	assert.equal(turns.length, 2);
	assert.equal(turns[0].tool, "click");
	assert.deepEqual(turns[0].clickPoint, { x: 640.5, y: 210 });
	assert.equal(turns[0].endMs - turns[0].startMs, 250);
	// readTrajectory derives the dispatch instant as epochMs - (endMs - startMs); it must
	// come back as the wall-clock moment record() was told the action started.
	assert.equal(turns[0].epochMs - (turns[0].endMs - turns[0].startMs), t0);
	assert.equal(turns[1].tool, "press_key");
	assert.equal(turns[1].clickPoint, undefined);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("TrajectoryWriter__CopiesBeforeAndAfterFrames__When__SourceFilesExist", () => {
	const dir = tmpRecording();
	const shot = path.join(dir, "shot.png");
	fs.writeFileSync(shot, "not-a-real-png");
	const w = new TrajectoryWriter(path.join(dir, "trajectory"));
	w.record({ tool: "click", args: {}, startedAtMs: 1, endedAtMs: 2, beforePng: shot, afterPng: path.join(dir, "missing.png") });

	const turnDir = path.join(dir, "trajectory", "turn-00001");
	assert.ok(fs.existsSync(path.join(turnDir, "before.png")));
	// A missing source degrades silently — same posture as a missed observation frame.
	assert.ok(!fs.existsSync(path.join(turnDir, "after.png")));
	fs.rmSync(dir, { recursive: true, force: true });
});

test("TrajectoryWriter__NumbersTurnsSequentially__When__ReadBackInSortedOrder", () => {
	const dir = tmpRecording();
	const w = new TrajectoryWriter(path.join(dir, "trajectory"));
	for (let i = 0; i < 11; i++) w.record({ tool: `tool-${i}`, args: {}, startedAtMs: i, endedAtMs: i + 1 });
	const turns = readTrajectory(dir);
	assert.deepEqual(turns.map((t) => t.tool), Array.from({ length: 11 }, (_, i) => `tool-${i}`));
	fs.rmSync(dir, { recursive: true, force: true });
});
