import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appmapsDir, dataRoot, outDir } from "./paths.js";
import { listApps, listRecordedRuns, pruneUiState, readUiState, RunController, writeUiState } from "./ui-core.js";

/**
 * Each test gets its own data root rather than writing out/ui-state.json into the checkout.
 *
 * This redirects the root by env var instead of chdir'ing, because paths.ts deliberately
 * stopped deriving roots from cwd — a LaunchAgent and a packaged .app both start at `/`, so
 * cwd was never a trustworthy input. The env var is the same override the plist uses, which
 * makes this test exercise the production mechanism rather than a test-only one.
 */
function inTempRoot(fn: () => void): void {
	const prev = process.env.YARN_RUNNER_DATA;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-state-"));
	try {
		process.env.YARN_RUNNER_DATA = dir;
		fn();
	} finally {
		if (prev === undefined) delete process.env.YARN_RUNNER_DATA;
		else process.env.YARN_RUNNER_DATA = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("readUiState__ReturnsEmpty__When__NoStateFileExists", () => {
	inTempRoot(() => {
		assert.deepEqual(readUiState(), { byApp: {} });
	});
});

test("writeUiState__RoundTrips__When__StateHasPerAppTaskAndLog", () => {
	inTempRoot(() => {
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
	inTempRoot(() => {
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

/**
 * Writes the pair of artifacts a recorded run leaves behind: a log and an mp4 on disk.
 *
 * Absolute, via outDir(), so the fixture lands in the same redirected root the code under
 * test reads. These paths used to be relative and therefore cwd-dependent, which silently
 * wrote fixtures into the real checkout the moment the root stopped being cwd — and the two
 * assert-empty tests below went on passing, because reading the wrong directory also
 * returns nothing. The `video` field stays root-relative because that is what a real run
 * log stores.
 */
function fakeRun(id: string, log: Record<string, unknown>, withVideo = true): void {
	fs.mkdirSync(`${outDir()}/runs`, { recursive: true });
	const video = `out/recording/${id}/window.mp4`;
	if (withVideo) {
		fs.mkdirSync(path.dirname(`${dataRoot()}/${video}`), { recursive: true });
		fs.writeFileSync(`${dataRoot()}/${video}`, "");
	}
	fs.writeFileSync(`${outDir()}/runs/${id}.json`, JSON.stringify({ ...(withVideo ? { video } : {}), ...log }));
}

test("listRecordedRuns__ListsTheRun__When__RunFailedButRecordedAVideo", () => {
	// The bug this pins: the two exits in agent.ts wrote the log independently and the
	// step-limit path omitted `video` — the one field this filter keys on. Runs that ran
	// out of steps vanished from the gallery even with a finished mp4 beside them.
	inTempRoot(() => {
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
	inTempRoot(() => {
		fakeRun("2026-07-30T02-00-00-yarn", { app: "Yarn", success: true, steps: [] }, false);
		assert.deepEqual(listRecordedRuns(), []);
	});
});

test("listRecordedRuns__SkipsTheRun__When__DeclaredVideoIsGone", () => {
	// Logs outlive out/recording/, which gets cleaned. A dead <video> src is worse than
	// an absent card, so existence on disk is checked rather than trusted.
	inTempRoot(() => {
		fakeRun("2026-07-30T03-00-00-yarn", { app: "Yarn", success: true, steps: [] });
		fs.rmSync(`${dataRoot()}/out/recording/2026-07-30T03-00-00-yarn/window.mp4`);
		assert.deepEqual(listRecordedRuns(), []);
	});
});

/**
 * A run is never actually spawned here: RunController.start/explore build argv and hand it to
 * spawn(), so a fake spawn captures the argv without a child process — and without a driver
 * session, which is the thing that must never start twice (LIMITATIONS §6).
 */
function captureArgs(fn: (c: RunController) => string | undefined): { args: string[]; error?: string } {
	const controller = new RunController();
	let args: string[] = [];
	(controller as unknown as { spawn(a: string[]): undefined }).spawn = (a: string[]) => {
		args = a;

		return undefined;
	};
	const error = fn(controller);

	return { args, ...(error ? { error } : {}) };
}

const HANDLERS = { onLine() {}, onDone() {} };

test("start__BuildsTheLegacyArgv__When__TargetIsAnApp", () => {
	// Pins the no-web-target path byte for byte. runner.test.ts asserts args.slice(-2) is
	// [task, app], so an unconditional --url would break a pure app run.
	const { args } = captureArgs((c) =>
		c.start({ app: "Yarn", task: "show me how to change the cursor type", record: false, noVision: false }, HANDLERS),
	);
	assert.deepEqual(args, ["tsx", "src/agent.ts", "show me how to change the cursor type", "Yarn"]);
});

test("start__AppendsTheUrlFlag__When__TargetIsWeb", () => {
	const { args } = captureArgs((c) =>
		c.start({ app: "www.notion.so", task: "change my timezone to Paris", record: true, noVision: false, url: "https://www.notion.so" }, HANDLERS),
	);
	assert.equal(args[args.indexOf("--url") + 1], "https://www.notion.so/");
	assert.ok(args.includes("--record"));
});

test("start__RefusesWithoutSpawning__When__UrlIsNotNavigable", () => {
	// A bad URL must fail as a returned error string the shell renders, not a thrown exception
	// that takes the Electron main process down with it.
	const { args, error } = captureArgs((c) =>
		c.start({ app: "x", task: "do a thing", record: false, noVision: false, url: "file:///etc/passwd" }, HANDLERS),
	);
	assert.match(error ?? "", /http/);
	assert.deepEqual(args, []);
});

test("explore__BuildsTheLegacyArgv__When__TargetIsAnApp", () => {
	const { args } = captureArgs((c) => c.explore("Yarn", HANDLERS));
	assert.deepEqual(args, ["tsx", "src/explore.ts", "Yarn"]);
});

test("explore__GroundsTheSite__When__UrlGiven", () => {
	const { args } = captureArgs((c) => c.explore("", HANDLERS, "https://www.notion.so"));
	assert.equal(args[2], "www.notion.so");
	assert.equal(args[args.indexOf("--url") + 1], "https://www.notion.so/");
});

test("listApps__SurfacesTheSite__When__AWebAppmapExists", () => {
	inTempRoot(() => {
		fs.mkdirSync(appmapsDir(), { recursive: true });
		fs.writeFileSync(`${appmapsDir()}/web-www.notion.so.md`, "<!-- provenance: explore -->");
		const hit = listApps().find((a) => a.name === "www.notion.so");
		assert.ok(hit, "the grounded site is not in the picker");
		assert.equal(hit.kind, "web");
		assert.equal(hit.grounded, true);
		// There is no "is this site open" probe, and inventing one would be a lie in a badge.
		assert.equal(hit.running, false);
		assert.equal(hit.url, "https://www.notion.so");
	});
});

test("listApps__ListsNoWebTargets__When__OnlyAppAppmapsExist", () => {
	inTempRoot(() => {
		fs.mkdirSync(appmapsDir(), { recursive: true });
		fs.writeFileSync(`${appmapsDir()}/yarn.md`, "<!-- provenance: explore -->");
		assert.equal(listApps().some((a) => a.kind === "web"), false);
	});
});
