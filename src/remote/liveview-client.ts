// A Node-side WebSocket CLIENT for the liveview server, presented as an EngineHandle.
//
// The dash's fleet-peek wall drives most targets over CDP directly (liveview-cdp.ts, no runner).
// But an ax-arm run opens no debug port ever, and a hardened Electron target strips it — those
// runs are invisible to CDP. The ONLY way to see them is to capture pixels on the Mac, where the
// runner holds the Screen Recording grant, and relay them. This module is the relay's client
// half: it dials a runner-spawned liveview server (native/liveview SCK capture, view-only) over
// an ssh tunnel and re-exposes its JPEG frames + JSON events through the SAME EngineHandle shape
// connectCdpEngine returns, so the peek session attaches it with no special-casing downstream.
//
// WHY A HAND-ROLLED CODEC and not liveview-ws.ts's: that pair is the SERVER'S half. Its decoder
// REQUIRES masked frames (RFC 6455 §5.1 — clients mask, and it enforces it) and REFUSES the
// 64-bit length; its encoder produces UNMASKED frames. A client is the mirror image: it must
// SEND masked frames (or the server's decoder fails the connection) and RECEIVE unmasked ones,
// and the server's JPEG frames routinely exceed 64KB (the 127/8-byte length path). So the client
// needs its own tiny frame codec — masking on send, unmasked-and-large on receive.
//
// VIEW-ONLY: `send` is a deliberate no-op. The peek never drives input; a relay that could would
// be an input channel onto a live benchmark run. The only client→server frames this ever writes
// are a pong (if the server pings) and a close on teardown.
//
// Durable exit: like native/liveview.swift, this is trial tooling. If Yarn ships its own capture
// pipeline, the whole liveview stack — this included — is deleted.

import { createHash, randomBytes } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import type { EngineEvent, EngineHandle } from "./liveview.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const ACCEPT = (key: string): string => createHash("sha1").update(key + GUID).digest("base64");

const OPCODES: Record<number, "text" | "binary" | "close" | "ping" | "pong" | "cont"> = {
	0x0: "cont", 0x1: "text", 0x2: "binary", 0x8: "close", 0x9: "ping", 0xa: "pong",
};

/** Ceiling on a partial frame held mid-decode — a JPEG is large but bounded; past this is a
 *  broken/hostile server, and growing without limit would hand it our memory. */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

/** One masked client frame (RFC 6455 §5.1). Only ever a small control payload here. */
function maskedFrame(payload: Buffer, op: number): Buffer {
	const len = payload.length;
	const mask = randomBytes(4);
	let header: Buffer;
	if (len < 126) {
		header = Buffer.from([0x80 | op, 0x80 | len]);
	} else if (len <= 0xffff) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | op;
		header[1] = 0x80 | 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | op;
		header[1] = 0x80 | 127;
		header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
		header.writeUInt32BE(len >>> 0, 6);
	}
	const body = Buffer.alloc(len);
	for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];

	return Buffer.concat([header, mask, body]);
}

/**
 * Incremental decoder for SERVER→client frames: unmasked, and large (JPEG frames use the 64-bit
 * length path). Fragmentation is not negotiated by the server, so a continuation/FIN=0 is a
 * protocol break. Tolerates a mask bit if a server ever sets one, but the liveview server never
 * does.
 */
class ClientDecoder {
	private buf: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): Array<{ opcode: string; payload: Buffer }> {
		this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
		if (this.buf.length > MAX_BUFFERED_BYTES) throw new Error(`liveview client buffer exceeded ${MAX_BUFFERED_BYTES} bytes`);
		const out: Array<{ opcode: string; payload: Buffer }> = [];
		for (;;) {
			if (this.buf.length < 2) break;
			const b0 = this.buf[0];
			const b1 = this.buf[1];
			const opcode = OPCODES[b0 & 0x0f] ?? "binary";
			if ((b0 & 0x80) === 0 || opcode === "cont") throw new Error("fragmented frame (FIN=0/continuation) not supported");
			const masked = (b1 & 0x80) !== 0;
			let len = b1 & 0x7f;
			let offset = 2;
			if (len === 126) {
				if (this.buf.length < offset + 2) break;
				len = this.buf.readUInt16BE(offset);
				offset += 2;
			} else if (len === 127) {
				if (this.buf.length < offset + 8) break;
				// High 32 bits are always zero for frames this side ever sees (< 4GB).
				len = this.buf.readUInt32BE(offset + 4);
				offset += 8;
			}
			const maskLen = masked ? 4 : 0;
			if (this.buf.length < offset + maskLen + len) break;
			let payload = this.buf.subarray(offset + maskLen, offset + maskLen + len);
			if (masked) {
				const mask = this.buf.subarray(offset, offset + 4);
				const un = Buffer.alloc(len);
				for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i & 3];
				payload = un;
			}
			out.push({ opcode, payload });
			this.buf = this.buf.subarray(offset + maskLen + len);
		}

		return out;
	}
}

export interface LiveviewClientOptions {
	/** Handshake + first-byte budget. The runner spawned the server and the dash already waited
	 *  for its port to answer HTTP, so this only covers the upgrade round trip. */
	connectTimeoutMs?: number;
}

/**
 * Dial a liveview server at `wsUrl` (ws://127.0.0.1:<local-tunnel-port>/?t=<token>) and resolve
 * an EngineHandle once the WebSocket upgrade completes. The handle emits the server's JPEG frames
 * (onFrame) and JSON events (onEvent), and fires onExit exactly once when the socket ends for any
 * reason. Rejects if the upgrade does not complete within the budget or the server refuses the
 * token (403 — no 101).
 */
export function connectLiveviewClient(wsUrl: string, opts: LiveviewClientOptions = {}): Promise<EngineHandle> {
	const url = new URL(wsUrl);
	const port = Number(url.port) || 80;
	const path = `${url.pathname}${url.search}`;
	const key = randomBytes(16).toString("base64");
	const timeoutMs = opts.connectTimeoutMs ?? 8000;

	return new Promise<EngineHandle>((resolve, reject) => {
		const socket: Socket = netConnect({ host: url.hostname || "127.0.0.1", port });
		const decoder = new ClientDecoder();
		let upgraded = false;
		let headerBuf: Buffer = Buffer.alloc(0);
		let settled = false;

		// Callbacks may be registered a microtask AFTER connect resolves, and a frame can arrive
		// in the same chunk as the handshake — so buffer until they are set, then flush.
		let onFrameCb: ((jpeg: Buffer) => void) | undefined;
		let onEventCb: ((ev: EngineEvent) => void) | undefined;
		const exitCbs: Array<() => void> = [];
		const pendingFrames: Buffer[] = [];
		const pendingEvents: EngineEvent[] = [];
		let exited = false;

		const to = setTimeout(() => {
			if (!upgraded && !settled) {
				settled = true;
				socket.destroy();
				reject(new Error(`liveview client: no WebSocket upgrade within ${timeoutMs}ms`));
			}
		}, timeoutMs);
		to.unref?.();

		const fireExit = (): void => {
			if (exited) return;
			exited = true;
			clearTimeout(to);
			// A clean FIN BEFORE the upgrade (the server hit its lifetime, or the tunnel dropped, in
			// the gap between the caller's readiness probe and the 101) emits 'end'/'close' with no
			// 'error' — so without this, the connect promise never settles and the caller's await
			// hangs forever, wedging its sckInFlight guard. Reject so the caller's catch runs.
			if (!settled) {
				settled = true;
				reject(new Error("liveview client: socket closed before the WebSocket upgrade"));

				return;
			}
			for (const cb of exitCbs) {
				try {
					cb();
				} catch {}
			}
		};

		const emitFrame = (jpeg: Buffer): void => {
			if (onFrameCb) onFrameCb(jpeg);
			else pendingFrames.push(jpeg);
		};
		const emitEvent = (ev: EngineEvent): void => {
			if (onEventCb) onEventCb(ev);
			else pendingEvents.push(ev);
		};

		const consume = (chunk: Buffer): void => {
			let frames: Array<{ opcode: string; payload: Buffer }>;
			try {
				frames = decoder.push(chunk);
			} catch {
				socket.destroy();

				return;
			}
			for (const f of frames) {
				if (f.opcode === "binary") emitFrame(f.payload);
				else if (f.opcode === "text") {
					try {
						emitEvent(JSON.parse(f.payload.toString("utf8")) as EngineEvent);
					} catch {}
				} else if (f.opcode === "ping") {
					try {
						socket.write(maskedFrame(f.payload, 0xa)); // pong
					} catch {}
				} else if (f.opcode === "close") {
					socket.end();
				}
			}
		};

		socket.on("connect", () => {
			socket.write(
				`GET ${path} HTTP/1.1\r\n` +
					`Host: ${url.hostname || "127.0.0.1"}:${port}\r\n` +
					"Upgrade: websocket\r\n" +
					"Connection: Upgrade\r\n" +
					`Sec-WebSocket-Key: ${key}\r\n` +
					"Sec-WebSocket-Version: 13\r\n\r\n",
			);
		});

		socket.on("data", (chunk: Buffer) => {
			if (upgraded) {
				consume(chunk);

				return;
			}
			headerBuf = headerBuf.length ? Buffer.concat([headerBuf, chunk]) : chunk;
			const sep = headerBuf.indexOf("\r\n\r\n");
			if (sep === -1) {
				if (headerBuf.length > 16 * 1024 && !settled) {
					settled = true;
					clearTimeout(to);
					socket.destroy();
					reject(new Error("liveview client: handshake response too large"));
				}

				return;
			}
			const head = headerBuf.subarray(0, sep).toString("utf8");
			const rest = headerBuf.subarray(sep + 4);
			const ok = /^HTTP\/1\.1 101/i.test(head) && new RegExp(`sec-websocket-accept:\\s*${ACCEPT(key).replace(/[+/]/g, "\\$&")}`, "i").test(head);
			if (!ok) {
				settled = true;
				clearTimeout(to);
				socket.destroy();
				reject(new Error(`liveview client: server refused the upgrade (${head.split("\r\n")[0] || "no status line"})`));

				return;
			}
			upgraded = true;
			settled = true;
			clearTimeout(to);
			const handle: EngineHandle = {
				send() {
					// View-only: the peek never injects input into a live run.
				},
				onFrame(cb) {
					onFrameCb = cb;
					for (const f of pendingFrames.splice(0)) cb(f);
				},
				onEvent(cb) {
					onEventCb = cb;
					for (const ev of pendingEvents.splice(0)) cb(ev);
				},
				onExit(cb) {
					if (exited) cb();
					else exitCbs.push(cb);
				},
				close() {
					try {
						socket.write(maskedFrame(Buffer.alloc(0), 0x8)); // close
					} catch {}
					socket.end();
					setTimeout(() => socket.destroy(), 1000).unref?.();
				},
			};
			resolve(handle);
			if (rest.length) consume(rest);
		});

		socket.on("error", (err) => {
			if (!settled) {
				settled = true;
				clearTimeout(to);
				reject(err);

				return;
			}
			fireExit();
		});
		socket.on("close", () => fireExit());
		socket.on("end", () => fireExit());
	});
}
