import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pruneUiState, readUiState, writeUiState } from "./ui-core.js";

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
