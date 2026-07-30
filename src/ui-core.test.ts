import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { listRecordedRuns, pruneUiState, readUiState, writeUiState } from "./ui-core.js";

/**
 * State is keyed off process.cwd(), so each test runs in its own temp dir rather than
 * writing out/ui-state.json into the checkout.
 */
function inTempCwd(fn: () => void): void {
	const prev = process.cwd();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-state-"));
	try {
		process.chdir(dir);
		fn();
	} finally {
		process.chdir(prev);
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("readUiState__ReturnsEmpty__When__NoStateFileExists", () => {
	inTempCwd(() => {
		assert.deepEqual(readUiState(), { byApp: {} });
	});
});

test("writeUiState__RoundTrips__When__StateHasPerAppTaskAndLog", () => {
	inTempCwd(() => {
		const state = {
			lastApp: "Yarn",
			byApp: {
				Yarn: { task: "show me how to change the cursor type", log: ["[1] click", "✓ verified"] },
				"Notion Calendar": { task: "change my timezone to Paris", log: [] },
			},
		};
		writeUiState(state);
		assert.deepEqual(readUiState(), state);
	});
});

test("readUiState__ReturnsEmpty__When__StateFileIsCorrupt", () => {
	inTempCwd(() => {
		fs.mkdirSync("out", { recursive: true });
		fs.writeFileSync("out/ui-state.json", "{not json");
		assert.deepEqual(readUiState(), { byApp: {} });
	});
});

test("pruneUiState__CapsScrollback__When__LogExceedsTheLimit", () => {
	// The cap keeps the newest lines: a terminal restored to its first 400 lines would
	// show the run's preamble and hide how it ended.
	const log = Array.from({ length: 700 }, (_, i) => `line ${i}`);
	const pruned = pruneUiState({ byApp: { Yarn: { task: "", log } } });
	assert.equal(pruned.byApp.Yarn.log.length, 400);
	assert.equal(pruned.byApp.Yarn.log[0], "line 300");
	assert.equal(pruned.byApp.Yarn.log.at(-1), "line 699");
});

test("pruneUiState__DropsEntry__When__AppHasNeitherTaskNorLog", () => {
	// Selecting an app creates an entry; without this, browsing the list would accumulate
	// one empty record per app ever clicked.
	const pruned = pruneUiState({ byApp: { Empty: { task: "", log: [] }, Kept: { task: "x", log: [] } } });
	assert.deepEqual(Object.keys(pruned.byApp), ["Kept"]);
});

test("pruneUiState__Coerces__When__FieldsAreWrongType", () => {
	// The file is hand-editable, and a malformed one must degrade rather than break the shell.
	const pruned = pruneUiState({ lastApp: 42, byApp: { Yarn: { task: null, log: ["ok", 7, null] } } });
	assert.equal(pruned.lastApp, undefined);
	assert.deepEqual(pruned.byApp.Yarn, { task: "", log: ["ok"] });
});

/** Writes the pair of artifacts a recorded run leaves behind: a log and an mp4 on disk. */
function fakeRun(id: string, log: Record<string, unknown>, withVideo = true): void {
	fs.mkdirSync("out/runs", { recursive: true });
	const video = `out/recording/${id}/window.mp4`;
	if (withVideo) {
		fs.mkdirSync(path.dirname(video), { recursive: true });
		fs.writeFileSync(video, "");
	}
	fs.writeFileSync(`out/runs/${id}.json`, JSON.stringify({ ...(withVideo ? { video } : {}), ...log }));
}

test("listRecordedRuns__ListsTheRun__When__RunFailedButRecordedAVideo", () => {
	// The bug this pins: the two exits in agent.ts wrote the log independently and the
	// step-limit path omitted `video` — the one field this filter keys on. Runs that ran
	// out of steps vanished from the gallery even with a finished mp4 beside them.
	inTempCwd(() => {
		fakeRun("2026-07-30T01-00-53-notion-calendar", {
			app: "Notion Calendar", task: "change my timezone", success: false,
			summary: "step limit reached", steps: [{ timestamp: "t0" }, { timestamp: "t1" }],
		});
		const runs = listRecordedRuns();
		assert.equal(runs.length, 1);
		assert.equal(runs[0].success, false);
		assert.equal(runs[0].actions, 2);
	});
});

test("listRecordedRuns__SkipsTheRun__When__LogDeclaresNoVideo", () => {
	// The filter itself stays strict: a run with no recording is not a gallery entry.
	inTempCwd(() => {
		fakeRun("2026-07-30T02-00-00-yarn", { app: "Yarn", success: true, steps: [] }, false);
		assert.deepEqual(listRecordedRuns(), []);
	});
});

test("listRecordedRuns__SkipsTheRun__When__DeclaredVideoIsGone", () => {
	// Logs outlive out/recording/, which gets cleaned. A dead <video> src is worse than
	// an absent card, so existence on disk is checked rather than trusted.
	inTempCwd(() => {
		fakeRun("2026-07-30T03-00-00-yarn", { app: "Yarn", success: true, steps: [] });
		fs.rmSync("out/recording/2026-07-30T03-00-00-yarn/window.mp4");
		assert.deepEqual(listRecordedRuns(), []);
	});
});
