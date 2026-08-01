import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { test } from "node:test";
import { connectLiveviewClient } from "../src/remote/liveview-client.js";
import { acceptKey, encodeFrame, WsDecoder } from "../src/remote/liveview-ws.js";

// The client is the MIRROR of liveview-ws.ts's server codec: it must RECEIVE unmasked frames
// (encodeFrame produces them) including the 64-bit length path (JPEGs > 64KB), and SEND masked
// ones (the server's WsDecoder enforces masking and would fail an unmasked client frame). These
// round-trip tests pair the real server-side codec against the client so the exact bug surface —
// masking direction and large-frame length — is exercised, not just asserted in the abstract.

/**
 * A throwaway WS server: real handshake (acceptKey), sends caller-supplied frames with the real
 * encodeFrame, and decodes what the client sends with the real server-side WsDecoder (which
 * THROWS on an unmasked client frame). Resolves the client's decoded frames back to the test.
 */
function fakeServer(onUpgrade: (socket: Socket, sendFrame: (f: Buffer) => void) => void): Promise<{ port: number; close: () => void; server: Server }> {
	return new Promise((resolve) => {
		const server = createServer((socket) => {
			let handshaken = false;
			let buf = Buffer.alloc(0);
			socket.on("data", (chunk: Buffer) => {
				if (!handshaken) {
					buf = Buffer.concat([buf, chunk]);
					const sep = buf.indexOf("\r\n\r\n");
					if (sep === -1) return;
					const head = buf.subarray(0, sep).toString("utf8");
					const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? "";
					socket.write(
						`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
					);
					handshaken = true;
					onUpgrade(socket, (f) => socket.write(f));
				}
			});
		});
		server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as { port: number }).port, close: () => server.close(), server }));
	});
}

test("connectLiveviewClient__DecodesBinaryAndTextFrames__When__ServerStreams", async () => {
	const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
	const srv = await fakeServer((_socket, send) => {
		send(encodeFrame(jpeg, "binary"));
		send(encodeFrame(Buffer.from(JSON.stringify({ ev: "window", app: "Yarn", title: "Editor" })), "text"));
	});
	try {
		const engine = await connectLiveviewClient(`ws://127.0.0.1:${srv.port}/?t=tok`);
		const frames: Buffer[] = [];
		const events: any[] = [];
		engine.onFrame((f) => frames.push(f));
		engine.onEvent((e) => events.push(e));
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(frames.length, 1);
		assert.deepEqual([...frames[0]], [...jpeg], "the JPEG bytes must survive the round trip");
		assert.equal(events.length, 1);
		assert.deepEqual(events[0], { ev: "window", app: "Yarn", title: "Editor" });
		engine.close();
	} finally {
		srv.close();
	}
});

test("connectLiveviewClient__DecodesLargeFrames__When__PayloadExceeds64KB", async () => {
	// A screencast JPEG routinely exceeds 0xffff bytes, so encodeFrame uses the 64-bit length
	// path — which the SERVER's WsDecoder refuses (clients never send big frames) but the client
	// MUST accept. This is the exact asymmetry the hand-rolled client codec exists for.
	const big = Buffer.alloc(200_000);
	for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
	const srv = await fakeServer((_socket, send) => send(encodeFrame(big, "binary")));
	try {
		const engine = await connectLiveviewClient(`ws://127.0.0.1:${srv.port}/?t=tok`);
		const got = await new Promise<Buffer>((resolve) => engine.onFrame(resolve));
		assert.equal(got.length, big.length);
		assert.ok(got.equals(big), "a >64KB frame must decode byte-for-byte");
		engine.close();
	} finally {
		srv.close();
	}
});

test("connectLiveviewClient__SendsMaskedFrames__When__ItWritesToTheServer", async () => {
	// The server's WsDecoder THROWS on an unmasked client frame (RFC 6455 §5.1). If the client's
	// close frame is unmasked, this decode rejects — so a clean decode proves the client masks.
	let decoded: { opcode: string; payload: Buffer } | undefined;
	let threw = false;
	const srv = await fakeServer((socket) => {
		const dec = new WsDecoder();
		socket.on("data", (chunk: Buffer) => {
			try {
				for (const f of dec.push(chunk)) decoded = f;
			} catch {
				threw = true;
			}
		});
	});
	try {
		const engine = await connectLiveviewClient(`ws://127.0.0.1:${srv.port}/?t=tok`);
		engine.close(); // writes a masked close frame
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(threw, false, "the server must not see an unmasked client frame");
		assert.equal(decoded?.opcode, "close", "the client's masked close frame decodes cleanly server-side");
	} finally {
		srv.close();
	}
});

test("connectLiveviewClient__FiresOnExit__When__TheSocketCloses", async () => {
	const srv = await fakeServer((socket) => setTimeout(() => socket.destroy(), 20));
	try {
		const engine = await connectLiveviewClient(`ws://127.0.0.1:${srv.port}/?t=tok`);
		await new Promise<void>((resolve) => engine.onExit(resolve));
		// A late onExit registration fires immediately (the exited flag) — no hang.
		await new Promise<void>((resolve) => engine.onExit(resolve));
	} finally {
		srv.close();
	}
});

test("connectLiveviewClient__Rejects__When__TheSocketClosesBeforeTheUpgrade", async () => {
	// A clean FIN before the 101 (the runner's liveview server hit its lifetime, or the tunnel
	// dropped, between the caller's readiness probe and the handshake) emits 'end'/'close' with
	// NO 'error'. Without settling on that, the connect promise hangs forever and the caller's
	// sckInFlight guard wedges — so this must reject, not hang.
	const server = createServer((socket) => {
		// Accept the TCP connection, read the client's GET, then close without writing the 101.
		socket.on("data", () => socket.end());
	});
	const port: number = await new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)));
	try {
		await assert.rejects(
			connectLiveviewClient(`ws://127.0.0.1:${port}/?t=tok`, { connectTimeoutMs: 5000 }),
			/closed before the WebSocket upgrade/,
		);
	} finally {
		server.close();
	}
});

test("connectLiveviewClient__Rejects__When__ServerRefusesTheUpgrade", async () => {
	// A 403 (bad token) has no 101 status line — the client must reject, not hang or half-open.
	const server = createServer((socket) => {
		socket.on("data", () => {
			socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
			socket.end();
		});
	});
	const port: number = await new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)));
	try {
		await assert.rejects(connectLiveviewClient(`ws://127.0.0.1:${port}/?t=bad`, { connectTimeoutMs: 2000 }), /refused the upgrade/);
	} finally {
		server.close();
	}
});
