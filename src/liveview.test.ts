import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	clampFraction,
	encodeCommand,
	EventParser,
	FrameParser,
	loginBlockedByRun,
	remedyFor,
	toEngineMouse,
	toEngineScroll,
} from "./liveview.js";
import { acquire, type Lease } from "./runner/lease.js";

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
