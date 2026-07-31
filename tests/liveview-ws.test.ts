import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptKey, encodeFrame, handshakeResponse, WS_MAX_BUFFERED_BYTES, WsDecoder } from "../src/fleet/liveview-ws.js";

// ---- acceptKey: the RFC 6455 handshake hash (canonical vector from §1.3) -----------------

test("acceptKey__ReturnsSpecVector__When__GivenSpecKey", () => {
	// RFC 6455 §1.3 worked example.
	assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("handshakeResponse__Includes101AndAcceptHeader__When__GivenKey", () => {
	const res = handshakeResponse("dGhlIHNhbXBsZSBub25jZQ==");
	assert.match(res, /101 Switching Protocols/);
	assert.match(res, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
});

// ---- encodeFrame: the three length forms ------------------------------------------------

test("encodeFrame__UsesInlineLength__When__PayloadUnder126", () => {
	const f = encodeFrame(Buffer.from("hi"), "binary");
	assert.equal(f[0], 0x82); // FIN + binary
	assert.equal(f[1], 2);
	assert.equal(f.subarray(2).toString(), "hi");
});

test("encodeFrame__Uses16BitLength__When__PayloadBetween126And65535", () => {
	const payload = Buffer.alloc(200, 7);
	const f = encodeFrame(payload);
	assert.equal(f[1], 126);
	assert.equal(f.readUInt16BE(2), 200);
	assert.equal(f.length, 4 + 200);
});

test("encodeFrame__Uses64BitLength__When__PayloadOver65535", () => {
	const payload = Buffer.alloc(70000, 1);
	const f = encodeFrame(payload);
	assert.equal(f[1], 127);
	assert.equal(f.readUInt32BE(6), 70000);
	assert.equal(f.length, 10 + 70000);
});

test("encodeFrame__SetsTextOpcode__When__TextRequested", () => {
	const f = encodeFrame(Buffer.from("x"), "text");
	assert.equal(f[0], 0x81); // FIN + text
});

// ---- WsDecoder: unmasking client frames -------------------------------------------------

/** Build a masked client frame the way a browser would. */
function maskedClientFrame(payload: Buffer, opcode = 0x1): Buffer {
	const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
	const masked = Buffer.alloc(payload.length);
	for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
	const header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);

	return Buffer.concat([header, mask, masked]);
}

test("WsDecoder__UnmasksPayload__When__GivenMaskedTextFrame", () => {
	const d = new WsDecoder();
	const frames = d.push(maskedClientFrame(Buffer.from('{"cmd":"follow"}')));
	assert.equal(frames.length, 1);
	assert.equal(frames[0].opcode, "text");
	assert.equal(frames[0].payload.toString(), '{"cmd":"follow"}');
});

test("WsDecoder__Reassembles__When__FrameSplitAcrossChunks", () => {
	const d = new WsDecoder();
	const wire = maskedClientFrame(Buffer.from("hello"));
	assert.equal(d.push(wire.subarray(0, 4)).length, 0);
	const frames = d.push(wire.subarray(4));
	assert.equal(frames.length, 1);
	assert.equal(frames[0].payload.toString(), "hello");
});

test("WsDecoder__SurfacesCloseOpcode__When__ClientSendsClose", () => {
	const d = new WsDecoder();
	const frames = d.push(maskedClientFrame(Buffer.alloc(0), 0x8));
	assert.equal(frames.length, 1);
	assert.equal(frames[0].opcode, "close");
});

test("WsDecoder__ReturnsBoth__When__TwoFramesConcatenated", () => {
	const d = new WsDecoder();
	const wire = Buffer.concat([maskedClientFrame(Buffer.from("a")), maskedClientFrame(Buffer.from("bb"))]);
	const frames = d.push(wire);
	assert.equal(frames.length, 2);
	assert.equal(frames[0].payload.toString(), "a");
	assert.equal(frames[1].payload.toString(), "bb");
});

// ---- Protocol violations fail the connection (throw) rather than mis-parse ---------------
// Silently swallowing a fragment or desyncing on a length form loses operator input mid-sign-in;
// the bridge treats a throw as "fail the WebSocket connection" per RFC 6455 §7.1.7.

test("WsDecoder__Throws__When__FrameNotFinal", () => {
	// FIN=0: first fragment of a fragmented message. We never negotiate fragmentation.
	const d = new WsDecoder();
	const wire = maskedClientFrame(Buffer.from("part"));
	wire[0] &= 0x7f; // clear FIN
	assert.throws(() => d.push(wire), /fragmented/);
});

test("WsDecoder__Throws__When__ContinuationOpcode", () => {
	const d = new WsDecoder();
	assert.throws(() => d.push(maskedClientFrame(Buffer.from("tail"), 0x0)), /fragmented/);
});

test("WsDecoder__Throws__When__ClientFrameUnmasked", () => {
	// RFC 6455 §5.1: client frames MUST be masked; the server MUST fail the connection otherwise.
	const d = new WsDecoder();
	const payload = Buffer.from("{}");
	const wire = Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
	assert.throws(() => d.push(wire), /unmasked/);
});

test("WsDecoder__Throws__When__64BitLengthClaimed", () => {
	// len==127 never comes from the viewer; keeping only the low 32 bits would desync the stream.
	const d = new WsDecoder();
	const header = Buffer.from([0x81, 0x80 | 127, 0, 0, 0, 1, 0, 0, 0, 0]);
	assert.throws(() => d.push(header), /64-bit/);
});

test("WsDecoder__Throws__When__BufferedBytesExceedCap", () => {
	// Nothing the viewer sends approaches the cap; unbounded buffering hands a hostile peer the
	// server's memory.
	const d = new WsDecoder();
	assert.throws(() => d.push(Buffer.alloc(WS_MAX_BUFFERED_BYTES + 1)), /buffer exceeded/);
});
