import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	engineArgs,
	clampFraction,
	encodeCommand,
	type EngineEvent,
	type ErrorEvent,
	EventParser,
	FrameParser,
	loginBlockedByRun,
	remedyFor,
	spawnEngine,
	toEngineMouse,
	toEngineScroll,
} from "../src/remote/liveview.js";
import { acquire, type Lease } from "../src/remote/runner/lease.js";

// ---- clampFraction ----------------------------------------------------------------------

test("clampFraction__ReturnsInput__When__WithinUnitRange", () => {
	assert.equal(clampFraction(0), 0);
	assert.equal(clampFraction(0.5), 0.5);
	assert.equal(clampFraction(1), 1);
});

test("clampFraction__Clamps__When__OutsideUnitRange", () => {
	assert.equal(clampFraction(-0.3), 0);
	assert.equal(clampFraction(1.7), 1);
});

test("clampFraction__ReturnsZero__When__NaN", () => {
	assert.equal(clampFraction(Number.NaN), 0);
});

// ---- toEngineMouse: viewport-fraction translation ---------------------------------------

test("toEngineMouse__MapsCentreToHalf__When__ClickIsMidImage", () => {
	const cmd = toEngineMouse("click", 640, 360, 1280, 720);
	assert.equal(cmd.cmd, "mouse");
	assert.equal(cmd.x, 0.5);
	assert.equal(cmd.y, 0.5);
	assert.equal(cmd.button, "left");
});

test("toEngineMouse__Clamps__When__ClickLeavesImage", () => {
	// A drag that leaves the rendered image must NOT inject onto the desktop behind the window.
	const cmd = toEngineMouse("move", 2000, -50, 1280, 720);
	assert.equal(cmd.x, 1);
	assert.equal(cmd.y, 0);
});

test("toEngineMouse__ReturnsZero__When__ImageHasZeroSize", () => {
	// Total: a stray event before the first frame (no dimensions yet) must not divide by zero.
	const cmd = toEngineMouse("click", 100, 100, 0, 0);
	assert.equal(cmd.x, 0);
	assert.equal(cmd.y, 0);
});

test("toEngineMouse__CarriesButton__When__RightClick", () => {
	const cmd = toEngineMouse("down", 0, 0, 100, 100, "right");
	assert.equal(cmd.button, "right");
});

// ---- toEngineScroll ---------------------------------------------------------------------

test("toEngineScroll__TruncatesDelta__When__DeltaIsFractional", () => {
	const cmd = toEngineScroll(50, 50, 100, 100, 3.9, -2.1);
	assert.equal(cmd.dy, 3);
	assert.equal(cmd.dx, -2);
});

// ---- FrameParser: the off-by-one-prone byte framing -------------------------------------

function frameBytes(payload: Buffer): Buffer {
	const header = Buffer.alloc(5);
	header[0] = 0x46; // 'F'
	header.writeUInt32BE(payload.length, 1);

	return Buffer.concat([header, payload]);
}

test("FrameParser__ReturnsOneFrame__When__GivenExactlyOne", () => {
	const p = new FrameParser();
	const payload = Buffer.from("jpegdata");
	const frames = p.push(frameBytes(payload));
	assert.equal(frames.length, 1);
	assert.deepEqual(frames[0], payload);
});

test("FrameParser__ReturnsBothFrames__When__TwoConcatenated", () => {
	const p = new FrameParser();
	const a = Buffer.from("first");
	const b = Buffer.from("secondframe");
	const frames = p.push(Buffer.concat([frameBytes(a), frameBytes(b)]));
	assert.equal(frames.length, 2);
	assert.deepEqual(frames[0], a);
	assert.deepEqual(frames[1], b);
});

test("FrameParser__Reassembles__When__FedOneByteAtATime", () => {
	// The real failure mode: a frame split across many `data` chunks at arbitrary boundaries.
	const p = new FrameParser();
	const payload = Buffer.from("a moderately sized jpeg payload xyz");
	const wire = frameBytes(payload);
	const got: Buffer[] = [];
	for (const byte of wire) got.push(...p.push(Buffer.from([byte])));
	assert.equal(got.length, 1);
	assert.deepEqual(got[0], payload);
});

test("FrameParser__RetainsPartialTail__When__SecondFrameIncomplete", () => {
	const p = new FrameParser();
	const a = Buffer.from("complete");
	const b = Buffer.from("incomplete-tail");
	const wire = Buffer.concat([frameBytes(a), frameBytes(b)]);
	// Feed everything but the last 3 bytes of b.
	const first = p.push(wire.subarray(0, wire.length - 3));
	assert.equal(first.length, 1);
	assert.deepEqual(first[0], a);
	// Now the tail completes frame b.
	const second = p.push(wire.subarray(wire.length - 3));
	assert.equal(second.length, 1);
	assert.deepEqual(second[0], b);
});

test("FrameParser__Resyncs__When__StreamHasLeadingGarbage", () => {
	const p = new FrameParser();
	const payload = Buffer.from("real");
	const wire = Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), frameBytes(payload)]);
	const frames = p.push(wire);
	assert.equal(frames.length, 1);
	assert.deepEqual(frames[0], payload);
});

test("FrameParser__EmitsZeroLengthFrame__When__LengthIsZero", () => {
	// A degenerate zero-length frame must not wedge the parser.
	const p = new FrameParser();
	const frames = p.push(frameBytes(Buffer.alloc(0)));
	assert.equal(frames.length, 1);
	assert.equal(frames[0].length, 0);
});

test("FrameParser__Resyncs__When__LengthFieldIsImplausiblyLarge", () => {
	// Resync can lock onto a 0x46 INSIDE jpeg data; the four bytes after it then read as a
	// length up to ~4GiB and the parser would buffer forever waiting for a frame that never
	// completes. An implausible length is itself a desync, not a frame to wait for.
	const p = new FrameParser();
	const bogus = Buffer.from([0x46, 0xff, 0xff, 0xff, 0xff]); // claims a ~4GiB frame
	const payload = Buffer.from("real");
	const frames = p.push(Buffer.concat([bogus, frameBytes(payload)]));
	assert.equal(frames.length, 1);
	assert.deepEqual(frames[0], payload);
});

// ---- EventParser ------------------------------------------------------------------------

test("EventParser__ParsesWindowEvent__When__GivenOneLine", () => {
	const p = new EventParser();
	const evs = p.push('{"ev":"window","id":31000,"title":"App","app":"App","x":0,"y":0,"w":800,"h":600,"scale":2}\n');
	assert.equal(evs.length, 1);
	assert.equal(evs[0].ev, "window");
});

test("EventParser__Reassembles__When__LineSplitAcrossChunks", () => {
	const p = new EventParser();
	assert.equal(p.push('{"ev":"error","kind":"no-scr').length, 0);
	const evs = p.push('een-recording","detail":"denied"}\n');
	assert.equal(evs.length, 1);
	assert.equal(evs[0].ev, "error");
});

test("EventParser__DropsGarbage__When__LineIsNotJson", () => {
	const p = new EventParser();
	const evs = p.push("not json at all\n");
	assert.equal(evs.length, 0);
});

test("EventParser__ParsesTwo__When__TwoLinesInOneChunk", () => {
	const p = new EventParser();
	const evs = p.push('{"ev":"window","id":1,"title":"","app":"","x":0,"y":0,"w":1,"h":1,"scale":1}\n{"ev":"error","kind":"no-window","detail":""}\n');
	assert.equal(evs.length, 2);
});

// ---- remedyFor: typed error -> operator instruction -------------------------------------

test("remedyFor__NamesScreenRecordingGrant__When__NoScreenRecording", () => {
	const msg = remedyFor({ ev: "error", kind: "no-screen-recording", detail: "denied" });
	assert.match(msg, /Screen Recording/);
});

test("remedyFor__NamesBuildStep__When__SpawnFailed", () => {
	const msg = remedyFor({ ev: "error", kind: "spawn-failed", detail: "ENOENT (/x/native/liveview)" });
	assert.match(msg, /build:native/);
});

test("remedyFor__FallsBackToDetail__When__KindUnknown", () => {
	const msg = remedyFor({ ev: "error", kind: "weird", detail: "something specific" });
	assert.equal(msg, "something specific");
});

// ---- encodeCommand ----------------------------------------------------------------------

test("encodeCommand__AppendsNewline__When__GivenCommand", () => {
	const line = encodeCommand({ cmd: "follow" });
	assert.equal(line, '{"cmd":"follow"}\n');
});

test("encodeCommand__RoundTrips__When__MouseCommand", () => {
	const line = encodeCommand({ cmd: "mouse", type: "click", x: 0.5, y: 0.25, button: "left" });
	const parsed = JSON.parse(line);
	assert.equal(parsed.cmd, "mouse");
	assert.equal(parsed.x, 0.5);
});

// ---- spawnEngine: engine death must degrade the handle, never crash the server -----------

test("spawnEngine__SurfacesTypedError__When__BinaryIsMissing", async () => {
	// The binary is gitignored, so a fresh checkout has no engine. That must arrive as the same
	// typed error event the engine itself emits — not an uncaught ENOENT that kills the detached
	// server before the operator sees a remedy.
	const handle = spawnEngine({ bin: "/nonexistent/liveview-engine" });
	const ev = await new Promise<EngineEvent>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("no engine event within 2s")), 2000);
		handle.onEvent((e) => {
			clearTimeout(t);
			resolve(e);
		});
	});
	assert.equal(ev.ev, "error");
	const err = ev as ErrorEvent;
	assert.equal(err.kind, "spawn-failed");
	assert.match(err.detail, /ENOENT/);
	// The handle is now inert: neither call may throw or schedule an async pipe error.
	handle.send({ cmd: "follow" });
	handle.close();
});

test("spawnEngine__SendAndCloseAreNoOps__When__EngineHasExited", async () => {
	// Any short-lived executable stands in for a dying engine. Pipe failures arrive as 'error'
	// EVENTS on stdin, not sync throws — emitting one is the deterministic stand-in for the
	// EPIPE a broken pipe raises on its own schedule, and it throws right here unless
	// spawnEngine registered a handler. Then the NORMAL teardown path (send quit, kill) runs
	// against the dead child, which must be a no-op rather than a fresh write to a dead pipe.
	const handle = spawnEngine({ bin: "/usr/bin/true" });
	await new Promise<void>((resolve) => handle.child.once("exit", () => resolve()));
	handle.child.stdin?.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
	handle.send({ cmd: "follow" });
	handle.close();
});

// ---- loginBlockedByRun: a login stream must never capture over a demo recording ----------

function withRunnerDir(fn: (dir: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yr-lv-"));
	try {
		fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function lease(over: Partial<Lease> = {}): Lease {
	return {
		jobId: "2026-07-30T12-00-00-yarn",
		operator: "dave",
		kind: "task",
		app: "Yarn",
		startedAt: new Date().toISOString(),
		pid: process.pid,
		...over,
	};
}

test("loginBlockedByRun__ReturnsNull__When__NoRunInFlight", () => {
	withRunnerDir((dir) => {
		assert.equal(loginBlockedByRun(dir), null);
	});
});

test("loginBlockedByRun__Refuses__When__ALiveRunHoldsTheLease", () => {
	withRunnerDir((dir) => {
		// A live run: the lease pid is this process, which is alive, so inspect() reports a holder.
		assert.equal(acquire(lease({ operator: "sam", kind: "explore", app: "Notion Calendar" }), dir).ok, true);
		const msg = loginBlockedByRun(dir);
		assert.ok(msg, "expected a refusal string");
		assert.match(msg!, /run is in flight/);
		// The refusal must name who holds the machine, or it is unactionable.
		assert.match(msg!, /sam/);
		assert.match(msg!, /Notion Calendar/);
	});
});

test("loginBlockedByRun__ReturnsNull__When__LeaseHolderIsDead", () => {
	withRunnerDir((dir) => {
		// A dead holder is not an in-flight run — inspect() treats it as stale, not a holder, so a
		// login must be allowed rather than blocked forever by a crashed run's leftover lease.
		const DEAD_PID = 4_194_303;
		acquire(lease({ pid: DEAD_PID }), dir);
		assert.equal(loginBlockedByRun(dir), null);
	});
});

test("engineArgs__NamesTheTarget__When__AppIsSet", () => {
	// --app is what arms the engine's constrained-browser mode; an unset or blank app must
	// leave the argv exactly as before, so plain window streaming stays byte-identical.
	assert.deepEqual(engineArgs({ app: "  Yarn  " }), ["--app", "Yarn"]);
	assert.deepEqual(engineArgs({ app: "   " }), []);
	assert.deepEqual(engineArgs({}), []);
	assert.deepEqual(engineArgs({ fps: 10, app: "Yarn" }), ["--fps", "10", "--app", "Yarn"]);
});

test("EventParser__CarriesTheConstrainedFields__When__TheEngineEmitsThem", () => {
	const parser = new EventParser();
	const events = parser.push(
		'{"ev":"window","id":9,"title":"Sign in","app":"Google Chrome","x":0,"y":0,"w":800,"h":600,"scale":2,"foreign":true,"crop":{"x":0.02,"y":0.11,"w":0.96,"h":0.87}}\n' +
		'{"ev":"auto","pressed":"Open Yarn.app"}\n' +
		'{"ev":"blocked","what":"key","code":37}\n',
	);

	assert.equal(events.length, 3);
	const win = events[0];
	assert.equal(win.ev === "window" && win.foreign, true);
	assert.equal(win.ev === "window" && win.crop?.h, 0.87);
	assert.equal(events[1].ev === "auto" && events[1].pressed, "Open Yarn.app");
	assert.equal(events[2].ev === "blocked" && events[2].code, 37);
});

test("EventParser__CarriesTheDiagnosticEvents__When__TheEngineEmitsThem", () => {
	// `ax` (once at startup) and `scan` (per shape change) are how a no-crop session is
	// diagnosed from a transcript — the 2026-07-31 crop bug was undebuggable without them.
	const parser = new EventParser();
	const events = parser.push(
		'{"ev":"ax","trusted":false}\n' +
		'{"ev":"scan","source":"none","leaves":0,"web":"nil","ink":"nil"}\n' +
		'{"ev":"scan","source":"ink","leaves":19,"web":"1200x953","ink":"800x351"}\n',
	);

	assert.equal(events.length, 3);
	assert.equal(events[0].ev === "ax" && events[0].trusted, false);
	assert.equal(events[1].ev === "scan" && events[1].source, "none");
	assert.equal(events[2].ev === "scan" && events[2].ink, "800x351");
});

test("EventParser__CarriesTheChromeFloor__When__NoPageGeometryResolved", () => {
	// The rule this encodes: fail to chrome-less, never to chrome. `source:"none"` means frames
	// are WITHHELD; `source:"chrome"` means the settle deadline passed and the crop fell back to
	// the window minus its toolbar — measured 2026-07-31 as an 86pt inset that is present whether
	// or not the page's AX tree ever woke. Releasing the whole browser instead is what put a tab
	// strip, an OAuth URL and an account chooser into a stream someone else was watching.
	const parser = new EventParser();
	const events = parser.push(
		'{"ev":"scan","source":"none","leaves":0,"web":"nil","ink":"nil","chrome":"1200x954"}\n' +
		'{"ev":"scan","source":"chrome","leaves":0,"web":"nil","ink":"nil","chrome":"1200x954"}\n',
	);

	assert.equal(events.length, 2);
	// Withheld first — the floor is measured but not yet adopted, so a slow page still gets its
	// full grace period to produce a proper card crop.
	assert.equal(events[0].ev === "scan" && events[0].source, "none");
	assert.equal(events[0].ev === "scan" && events[0].chrome, "1200x954");
	assert.equal(events[1].ev === "scan" && events[1].source, "chrome");
});

test("EventParser__CarriesSettling__When__TheEngineWithholdsFrames", () => {
	// `settling` is how the viewer tells "frames withheld until the crop lands" apart from a
	// dead stream. Withholding exists because an uncropped foreign window shows the URL bar and,
	// as observed 2026-07-31, a saved-password dropdown listing real addresses.
	const parser = new EventParser();
	const events = parser.push(
		'{"ev":"window","id":1,"title":"Sign in","app":"Google Chrome","x":0,"y":0,"w":1200,"h":1040,"scale":2,"foreign":true,"settling":true}\n' +
		'{"ev":"window","id":1,"title":"","app":"Google Chrome","x":0,"y":0,"w":1200,"h":1040,"scale":2,"foreign":true,"settling":false,"crop":{"x":0.15,"y":0.31,"w":0.7,"h":0.38}}\n',
	);

	assert.equal(events.length, 2);
	assert.equal(events[0].ev === "window" && events[0].settling, true);
	assert.equal(events[1].ev === "window" && events[1].settling, false);
	assert.equal(events[1].ev === "window" && !!events[1].crop, true);
});

test("engineArgs__LeavesFrameRateToTheEngine__When__UnsetByTheCaller", () => {
	// The runner passes fps by env (LIVEVIEW_FPS), not argv, so an unset caller must not pin a
	// rate here — that is what kept the fleet at the old 15fps default with no way to change it.
	assert.deepEqual(engineArgs({ app: "Yarn" }), ["--app", "Yarn"]);
	assert.deepEqual(engineArgs({ fps: 30, app: "Yarn" }), ["--fps", "30", "--app", "Yarn"]);
});
