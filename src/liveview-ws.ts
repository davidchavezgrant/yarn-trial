// liveview-ws — a minimal RFC 6455 WebSocket codec, just enough for the login viewer.
//
// WHY HAND-ROLLED AND NOT `ws`. This repo has exactly two runtime dependencies (the Anthropic
// SDK and the cua driver) and a stated preference against pulling frameworks in for small
// problems. The viewer needs one server-to-client message type (binary JPEG frames) and one
// client-to-server type (small JSON input events) — a fraction of what `ws` implements. The
// parts that are genuinely fiddly (the accept-key hash, unmasking client frames, the 2/8-byte
// length forms) are pure functions and are unit-tested in liveview-ws.test.ts, which is the
// whole reason they are split out here rather than inlined into the server's socket handlers.
//
// SCOPE, stated so nobody mistakes this for a general WebSocket library: no permessage-deflate,
// no continuation frames (our messages fit one frame), no client role. Server-side only.

import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The `Sec-WebSocket-Accept` value for a given client key (RFC 6455 §4.2.2). */
export function acceptKey(clientKey: string): string {
	return createHash("sha1").update(clientKey + GUID).digest("base64");
}

/** The full HTTP/1.1 upgrade response for a validated handshake. */
export function handshakeResponse(clientKey: string): string {
	return [
		"HTTP/1.1 101 Switching Protocols",
		"Upgrade: websocket",
		"Connection: Upgrade",
		`Sec-WebSocket-Accept: ${acceptKey(clientKey)}`,
		"\r\n",
	].join("\r\n");
}

export type Opcode = "text" | "binary" | "close" | "ping" | "pong" | "cont";

const OPCODES: Record<number, Opcode> = { 0x0: "cont", 0x1: "text", 0x2: "binary", 0x8: "close", 0x9: "ping", 0xa: "pong" };

/**
 * Encode a server->client frame. Server frames are never masked (RFC 6455 §5.1). Handles the
 * three length forms: <126 inline, <=65535 as 16-bit, else 64-bit.
 */
export function encodeFrame(payload: Buffer, opcode: Opcode = "binary"): Buffer {
	const op = opcode === "text" ? 0x1 : opcode === "close" ? 0x8 : opcode === "ping" ? 0x9 : opcode === "pong" ? 0xa : 0x2;
	const fin = 0x80;
	const len = payload.length;
	let header: Buffer;
	if (len < 126) {
		header = Buffer.from([fin | op, len]);
	} else if (len <= 0xffff) {
		header = Buffer.alloc(4);
		header[0] = fin | op;
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = fin | op;
		header[1] = 127;
		// High 32 bits are ~always zero for our frames; write the low 32 to be safe.
		header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
		header.writeUInt32BE(len >>> 0, 6);
	}

	return Buffer.concat([header, payload]);
}

export interface DecodedFrame {
	opcode: Opcode;
	payload: Buffer;
}

/**
 * Incremental decoder for client->server frames. Client frames are ALWAYS masked; we unmask.
 * Returns complete frames and retains the partial tail, like FrameParser. Control frames
 * (close/ping) are surfaced so the server can respond.
 */
export class WsDecoder {
	private buf: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): DecodedFrame[] {
		this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
		const out: DecodedFrame[] = [];

		for (;;) {
			if (this.buf.length < 2) break;
			const b0 = this.buf[0];
			const b1 = this.buf[1];
			const opcode = OPCODES[b0 & 0x0f] ?? "binary";
			const masked = (b1 & 0x80) !== 0;
			let len = b1 & 0x7f;
			let offset = 2;
			if (len === 126) {
				if (this.buf.length < offset + 2) break;
				len = this.buf.readUInt16BE(offset);
				offset += 2;
			} else if (len === 127) {
				if (this.buf.length < offset + 8) break;
				// Low 32 bits are enough for anything the viewer sends.
				len = this.buf.readUInt32BE(offset + 4);
				offset += 8;
			}
			const maskLen = masked ? 4 : 0;
			if (this.buf.length < offset + maskLen + len) break;

			let payload: Buffer;
			if (masked) {
				const mask = this.buf.subarray(offset, offset + 4);
				const start = offset + 4;
				payload = Buffer.alloc(len);
				for (let i = 0; i < len; i++) payload[i] = this.buf[start + i] ^ mask[i & 3];
			} else {
				payload = this.buf.subarray(offset, offset + len);
			}
			out.push({ opcode, payload });
			this.buf = this.buf.subarray(offset + maskLen + len);
		}

		return out;
	}
}
