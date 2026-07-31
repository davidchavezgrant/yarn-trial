import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appmapsDir, dataRoot, outDir } from "../src/paths.js";
import { HumanizeController, listApps, listRecordedRuns, parseByteRange, pruneUiState, readUiState, resolveVideo, RunController, stampTime, streamPump, writeUiState } from "../src/ui/ui-core.js";

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

test("listRecordedRuns__SurfacesTheHumanizedRender__When__ItExistsBesideTheCapture", () => {
	// The humanize pass writes humanized.mp4 next to window.mp4; the gallery keys its default
	// playback and its Render button off this field, so presence-on-disk must become presence
	// in the entry on the very next scan.
	inTempRoot(() => {
		fakeRun("2026-07-30T04-00-00-yarn", { app: "Yarn", success: true, steps: [] });
		fs.writeFileSync(`${dataRoot()}/out/recording/2026-07-30T04-00-00-yarn/humanized.mp4`, "");
		const runs = listRecordedRuns();
		assert.equal(runs.length, 1);
		assert.equal(runs[0].humanized, "out/recording/2026-07-30T04-00-00-yarn/humanized.mp4");
	});
});

test("listRecordedRuns__OmitsHumanized__When__NoRenderHasBeenMade", () => {
	// Absence is load-bearing: it is what makes the card offer "Render human cursor".
	inTempRoot(() => {
		fakeRun("2026-07-30T05-00-00-yarn", { app: "Yarn", success: true, steps: [] });
		assert.equal(listRecordedRuns()[0].humanized, undefined);
	});
});

test("stampTime__RecoversTheUtcInstant__When__TheStampHasSecondsPrecision", () => {
	// The old stamp shape, minted before the millisecond bump. The trailing Z is the point:
	// the stamp came from toISOString(), and reading it as local time would shift every
	// gallery label by the timezone offset.
	assert.equal(stampTime("2026-07-30T17-31-22-yarn"), "2026-07-30T17:31:22Z");
});

test("stampTime__KeepsTheMillis__When__TheStampCarriesThem", () => {
	assert.equal(stampTime("2026-07-30T23-19-59-123-notion-calendar"), "2026-07-30T23:19:59.123Z");
});

test("stampTime__ReturnsUndefined__When__TheIdCarriesNoTimestamp", () => {
	assert.equal(stampTime("not-a-stamp"), undefined);
	assert.equal(stampTime(""), undefined);
});

test("listRecordedRuns__FallsBackToTheStamp__When__TheLogHasNoStepTimestamp", () => {
	// A run that crashed before writing step 0 still has WHEN it happened encoded in its own
	// id, so the card's time label must not depend on the run having gotten anywhere.
	inTempRoot(() => {
		fakeRun("2026-07-30T17-31-22-yarn", { app: "Yarn", success: false, steps: [] });
		assert.equal(listRecordedRuns()[0].startedAt, "2026-07-30T17:31:22Z");
	});
});

test("listRecordedRuns__PrefersTheStepTimestamp__When__TheLogHasOne", () => {
	// The step timestamp is the authoritative instant; the stamp is only its stand-in.
	inTempRoot(() => {
		fakeRun("2026-07-30T17-31-22-yarn", { app: "Yarn", success: true, steps: [{ timestamp: "2026-07-30T17:31:25.000Z" }] });
		assert.equal(listRecordedRuns()[0].startedAt, "2026-07-30T17:31:25.000Z");
	});
});

test("resolveVideo__ServesTheHumanizedRender__When__AskedForIt", () => {
	// Pins the assumption the gallery leans on: the protocol path needed NO change for
	// humanized.mp4 because resolveVideo accepts any mp4 under out/recording.
	inTempRoot(() => {
		const rel = "out/recording/2026-07-30T06-00-00-yarn/humanized.mp4";
		fs.mkdirSync(path.dirname(`${dataRoot()}/${rel}`), { recursive: true });
		fs.writeFileSync(`${dataRoot()}/${rel}`, "");
		assert.equal(resolveVideo(rel), `${dataRoot()}/${rel}`);
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
	assert.deepEqual(args, ["tsx", "src/core/agent.ts", "show me how to change the cursor type", "Yarn"]);
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
	assert.deepEqual(args, ["tsx", "src/core/explore.ts", "Yarn"]);
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

test("listApps__CarriesTheCaptureStamp__When__TheWebGraphIsStamped", () => {
	// The stamp is the pass's own capturedAt, read out of the graph — never file mtime,
	// which git restamps on every checkout.
	inTempRoot(() => {
		fs.mkdirSync(appmapsDir(), { recursive: true });
		fs.writeFileSync(`${appmapsDir()}/web-www.notion.so.md`, "<!-- provenance: explore -->");
		fs.writeFileSync(`${appmapsDir()}/web-www.notion.so.json`, JSON.stringify({ capturedAt: "2026-07-27T10:00:00.000Z" }));
		const hit = listApps().find((a) => a.name === "www.notion.so");
		assert.ok(hit, "the grounded site is not in the picker");
		assert.equal(hit.groundedAt, "2026-07-27T10:00:00.000Z");
	});
});

test("listApps__LeavesGroundedAtUnset__When__TheMapIsProseOnly", () => {
	// Prose-only maps predate the stamp; inventing an age for them would be worse than none.
	inTempRoot(() => {
		fs.mkdirSync(appmapsDir(), { recursive: true });
		fs.writeFileSync(`${appmapsDir()}/web-www.notion.so.md`, "<!-- provenance: explore -->");
		const hit = listApps().find((a) => a.name === "www.notion.so");
		assert.ok(hit);
		assert.equal(hit.groundedAt, undefined);
	});
});

test("listApps__StampsTheInstalledApp__When__ItsGraphCarriesCapturedAt", () => {
	// The app path is exercised with a fixture bundle under $HOME/Applications — one of the
	// directories listApps really scans — so nothing here depends on what this Mac has
	// installed.
	inTempRoot(() => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
		const prevHome = process.env.HOME;
		try {
			fs.mkdirSync(path.join(home, "Applications", "Stamp Fixture.app"), { recursive: true });
			process.env.HOME = home;
			fs.mkdirSync(appmapsDir(), { recursive: true });
			fs.writeFileSync(`${appmapsDir()}/stamp-fixture.md`, "<!-- provenance: explore -->");
			fs.writeFileSync(`${appmapsDir()}/stamp-fixture.json`, JSON.stringify({ capturedAt: "2026-07-27T10:00:00.000Z" }));
			const hit = listApps().find((a) => a.name === "Stamp Fixture");
			assert.ok(hit, "the fixture app under $HOME/Applications is not listed");
			assert.equal(hit.grounded, true);
			assert.equal(hit.groundedAt, "2026-07-27T10:00:00.000Z");
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
			fs.rmSync(home, { recursive: true, force: true });
		}
	});
});

test("streamPump__ReassemblesTheLine__When__AChunkBoundaryFallsMidLine", () => {
	// The exact defect the log pane showed: a chunk ending inside a step line emitted
	// "[12] click" and " \"Save\" ✓ verified" as two rows, neither matching the step pattern.
	const got: string[] = [];
	const pump = streamPump((l) => got.push(l));
	const text = Buffer.from('[12] click "Save" ✓ verified\n[13] type "Paris" ✓ verified\n');
	pump.push(text.subarray(0, 10));
	pump.push(text.subarray(10));
	pump.end();
	assert.deepEqual(got, ['[12] click "Save" ✓ verified', '[13] type "Paris" ✓ verified']);
});

test("streamPump__KeepsTheGlyphIntact__When__AChunkBoundaryFallsInsideIt", () => {
	// ✓ is three bytes; Buffer.toString() on a cut mid-glyph produced replacement characters
	// and turned "✓ verified" into "�� verified" — which reads as a failed run.
	const got: string[] = [];
	const pump = streamPump((l) => got.push(l));
	const text = Buffer.from('[12] click "Save" ✓ verified\n');
	// Byte 19 is inside the ✓ (bytes 18-20).
	pump.push(text.subarray(0, 19));
	pump.push(text.subarray(19));
	pump.end();
	assert.deepEqual(got, ['[12] click "Save" ✓ verified']);
});

test("streamPump__EmitsTheFinalLine__When__TheStreamEndsWithoutANewline", () => {
	// A process's last words — usually the reason it stopped — rarely end in a newline.
	const got: string[] = [];
	const pump = streamPump((l) => got.push(l));
	pump.push(Buffer.from("exit reason: session lease lost"));
	pump.end();
	assert.deepEqual(got, ["exit reason: session lease lost"]);
});

test("parseByteRange__ServesThePart__When__BothEndsAreNamed", () => {
	assert.deepEqual(parseByteRange("bytes=10-19", 100), { kind: "part", start: 10, end: 19 });
	// An end past the file clamps rather than 416s — RFC 9110 says so, and Chromium asks.
	assert.deepEqual(parseByteRange("bytes=90-500", 100), { kind: "part", start: 90, end: 99 });
});

test("parseByteRange__ServesTheTail__When__OnlyAStartIsNamed", () => {
	// The form Chromium's media stack actually sends when scrubbing.
	assert.deepEqual(parseByteRange("bytes=40-", 100), { kind: "part", start: 40, end: 99 });
});

test("parseByteRange__ServesTheLastNBytes__When__TheRangeIsASuffix", () => {
	// bytes=-500 names the LAST 500 bytes. The old parse treated it as 0-500 and served the
	// head of the file labelled as its tail.
	assert.deepEqual(parseByteRange("bytes=-30", 100), { kind: "part", start: 70, end: 99 });
	// A suffix longer than the file is the whole file, not an error (RFC 9110 §14.1.2).
	assert.deepEqual(parseByteRange("bytes=-500", 100), { kind: "part", start: 0, end: 99 });
});

test("parseByteRange__AnswersWhole__When__ThereIsNoRangeToHonour", () => {
	assert.deepEqual(parseByteRange(null, 100), { kind: "whole" });
	assert.deepEqual(parseByteRange("bytes=-", 100), { kind: "whole" });
	assert.deepEqual(parseByteRange("lines=1-2", 100), { kind: "whole" });
});

test("parseByteRange__Refuses__When__TheRangeStartsPastTheFile", () => {
	assert.deepEqual(parseByteRange("bytes=100-", 100), { kind: "unsatisfiable" });
	assert.deepEqual(parseByteRange("bytes=50-10", 100), { kind: "unsatisfiable" });
});

/**
 * A render is never actually spawned here: launch() is patched out the way RunController.spawn
 * is, and the test emits the child's bytes and exit by hand — no tsx, no ffmpeg, no minutes of
 * real compositing inside a unit test.
 */
interface FakeChild {
	child: ChildProcess;
	out(text: string): void;
	err(text: string): void;
	close(code: number | null): void;
	error(message: string): void;
}

function fakeChild(): FakeChild {
	const child = new EventEmitter();
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	Object.assign(child, { stdout, stderr });

	return {
		child: child as unknown as ChildProcess,
		out: (t) => stdout.emit("data", Buffer.from(t)),
		err: (t) => stderr.emit("data", Buffer.from(t)),
		close: (code) => child.emit("close", code),
		error: (message) => child.emit("error", new Error(message)),
	};
}

/** A controller whose launch() hands out the given fakes in order. */
function rig(children: FakeChild[]): HumanizeController {
	const controller = new HumanizeController();
	let i = 0;
	(controller as unknown as { launch(stamp: string): ChildProcess }).launch = () => children[i++].child;

	return controller;
}

test("start__RefusesTheSecond__When__TheSameStampIsAlreadyRendering", () => {
	// Two renders of one stamp race on the same motion-track.json and humanized.mp4.
	const c = rig([fakeChild()]);
	assert.equal(c.start("2026-07-30T01-00-00-yarn"), undefined);
	assert.match(c.start("2026-07-30T01-00-00-yarn") ?? "", /already rendering/);
});

test("start__RefusesTheThird__When__TwoRendersAreInFlight", () => {
	// Different stamps are allowed concurrently — up to the cap, which is about CPU fan-out,
	// not correctness.
	const c = rig([fakeChild(), fakeChild()]);
	assert.equal(c.start("stamp-one"), undefined);
	assert.equal(c.start("stamp-two"), undefined);
	assert.match(c.start("stamp-three") ?? "", /2 renders already in flight/);
});

test("start__AllowsTheStampAgain__When__ThePreviousRenderSettled", () => {
	// failed must be retryable, and a settled render must release its slot under the cap.
	const a = fakeChild();
	const b = fakeChild();
	const c = rig([a, b]);
	assert.equal(c.start("stamp-one"), undefined);
	a.err("no recording at out/recording/stamp-one\n");
	a.close(1);
	assert.equal(c.status()["stamp-one"].state, "failed");
	assert.equal(c.start("stamp-one"), undefined);
	assert.deepEqual(c.status()["stamp-one"], { state: "rendering" });
});

test("start__CapturesTheLastErrorLine__When__TheChildExitsNonzero", () => {
	// The card's failed state shows ONE line, and it must be the diagnosis humanize.ts printed
	// to stderr right before exit(1) — not the stdout progress that preceded it. The stderr
	// line carries no trailing newline on purpose: a process's last words rarely do, so this
	// also pins the flush-before-report ordering.
	const a = fakeChild();
	const c = rig([a]);
	c.start("stamp-one");
	a.out("motion track: out/recording/stamp-one/motion-track.json (400 cursor samples)\n");
	a.err("render failed: no frames to render at out/recording/stamp-one/frames");
	a.close(1);
	assert.deepEqual(c.status()["stamp-one"], { state: "failed", error: "render failed: no frames to render at out/recording/stamp-one/frames" });
});

test("start__FallsBackToStdout__When__AFailingChildWroteNoStderr", () => {
	const a = fakeChild();
	const c = rig([a]);
	c.start("stamp-one");
	a.out("could not measure changed regions: python3 missing\n");
	a.close(1);
	assert.deepEqual(c.status()["stamp-one"], { state: "failed", error: "could not measure changed regions: python3 missing" });
});

test("start__MarksDone__When__TheChildExitsZero", () => {
	const a = fakeChild();
	const c = rig([a]);
	c.start("stamp-one");
	a.out("humanized video: out/recording/stamp-one/humanized.mp4 (900 frames)\n");
	a.close(0);
	assert.deepEqual(c.status()["stamp-one"], { state: "done" });
});

test("start__ReportsFailure__When__TheChildCannotSpawn", () => {
	// npx missing from a packaged app's PATH emits 'error' and then 'close' — the second event
	// must not overwrite the failure, and nothing here may throw across IPC.
	const a = fakeChild();
	const c = rig([a]);
	assert.equal(c.start("stamp-one"), undefined);
	a.error("spawn npx ENOENT");
	a.close(null);
	assert.deepEqual(c.status()["stamp-one"], { state: "failed", error: "could not start the render: spawn npx ENOENT" });
});

test("start__RefusesTheStamp__When__ItIsNotStampShaped", () => {
	// The stamp arrives from the renderer and rides into argv: path separators and flag-shaped
	// strings are refused before a child exists to be confused by them.
	const c = rig([]);
	for (const bad of ["", "  ", "../etc", "a/b", "--no-video"]) assert.match(c.start(bad) ?? "", /not a run stamp/);
	assert.deepEqual(c.status(), {});
});
