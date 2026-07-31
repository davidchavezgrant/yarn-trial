// liveview-server — serve the window-scoped login viewer and bridge it to the native engine.
//
// This is the I/O half: an HTTP server that hands out a single-page viewer, upgrades it to a
// WebSocket, spawns `native/liveview`, pipes JPEG frames down to the browser and input events
// back up to the engine. It has no pure logic worth unit-testing on its own — the fiddly parts
// (frame framing, WS masking, coordinate translation) all live in liveview.ts / liveview-ws.ts
// and are tested there. This file is smoke-tested against a real Mac.
//
// SECURITY POSTURE, and its limits, stated plainly (matching team.ts's candor):
//
//   - The link carries a single-use-ish random token in the path. Without it the server serves
//     nothing and refuses the upgrade. This stops a curious process on the same host from
//     opening the viewer, not a determined attacker on the wire.
//   - It binds to 127.0.0.1 by default. On the fleet the teammate reaches it by SSH
//     port-forward (`ssh -L`), so the stream never crosses the network unencrypted — the SSH
//     tunnel is the transport security, exactly as the runner's UDS leans on SSH for auth.
//     Binding to 0.0.0.0 is possible for a quick LAN demo and is gated behind an explicit flag,
//     because a raw ws:// login stream on the LAN is a credential-adjacent leak.
//   - The engine injects real input as the console user. Anyone who holds the token can drive
//     that Mac. The token is the whole access control; treat the URL like a password.
//
// WHY WE DO NOT PERSIST OR INSPECT THE STREAM. The frames carry a human typing a password. This
// server MUST NOT write them to disk or log them. It forwards bytes and forgets them. The demo
// recording is a SEPARATE capture that starts AFTER login (see the design doc) — this stream is
// transient and exists only for the seconds a human is signing in.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { type EngineEvent, remedyFor, spawnEngine } from "./liveview.js";
import { encodeFrame, handshakeResponse, WsDecoder } from "./liveview-ws.js";
import { viewerHtml } from "./liveview-viewer.js";

export interface ServerOptions {
	host?: string; // default 127.0.0.1
	port?: number; // default 0 (ephemeral)
	fps?: number;
	quality?: number;
	maxWidth?: number;
	/** Override the engine binary (tests). */
	bin?: string;
	/** Bind beyond loopback. Off by default; a raw login stream on the LAN is a leak. */
	lan?: boolean;
}

export interface RunningServer {
	url: string;
	token: string;
	port: number;
	close(): Promise<void>;
	server: Server;
}

/**
 * Start the viewer server. Resolves once it is listening, with the URL to hand to the teammate
 * (or to `ssh -L` against). One engine is spawned per WebSocket connection and killed when it
 * closes, so a dropped tab tears down the capture on the Mac rather than leaking a process.
 */
export function startLiveViewServer(opts: ServerOptions = {}): Promise<RunningServer> {
	const token = randomBytes(18).toString("base64url");
	const host = opts.lan ? "0.0.0.0" : (opts.host ?? "127.0.0.1");

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		// The viewer page itself is gated by the token in the query string.
		if (url.pathname === "/" && url.searchParams.get("t") === token) {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			res.end(viewerHtml(token));

			return;
		}
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("not found");
	});

	server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		const key = req.headers["sec-websocket-key"];
		if (url.searchParams.get("t") !== token || typeof key !== "string") {
			socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
			socket.destroy();

			return;
		}
		socket.write(handshakeResponse(key));
		bridge(socket, opts);
	});

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(opts.port ?? 0, host, () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			const shown = opts.lan ? hostAddress() : "127.0.0.1";
			resolve({
				url: `http://${shown}:${port}/?t=${token}`,
				token,
				port,
				server,
				close: () =>
					new Promise((r) => {
						server.close(() => r());
					}),
			});
		});
	});
}

/** Wire one WebSocket to one engine instance. */
function bridge(socket: Duplex, opts: ServerOptions): void {
	const engine = spawnEngine({ fps: opts.fps, quality: opts.quality, maxWidth: opts.maxWidth, bin: opts.bin });
	const decoder = new WsDecoder();
	let open = true;

	const send = (payload: Buffer, kind: "binary" | "text") => {
		if (!open) return;
		try {
			socket.write(encodeFrame(payload, kind));
		} catch {
			teardown();
		}
	};

	engine.onFrame((jpeg) => send(jpeg, "binary"));
	engine.onEvent((ev: EngineEvent) => {
		// Events go to the viewer as JSON text so it can show status / remedy an error.
		const withRemedy = ev.ev === "error" ? { ...ev, remedy: remedyFor(ev) } : ev;
		send(Buffer.from(JSON.stringify(withRemedy)), "text");
	});

	socket.on("data", (chunk: Buffer) => {
		for (const frame of decoder.push(chunk)) {
			if (frame.opcode === "close") {
				teardown();

				return;
			}
			if (frame.opcode === "text") {
				try {
					engine.send(JSON.parse(frame.payload.toString("utf8")));
				} catch {
					// Malformed input event — ignore, never crash the stream.
				}
			}
		}
	});

	const teardown = () => {
		if (!open) return;
		open = false;
		engine.close();
		try {
			socket.end();
		} catch {
			// already closed
		}
	};

	socket.on("close", teardown);
	socket.on("error", teardown);
	engine.child.on("exit", teardown);
}

/** First non-loopback IPv4, for the LAN-demo URL. Best-effort. */
function hostAddress(): string {
	// Deliberately tiny: import lazily to keep the pure path clean.
	const os = require("node:os") as typeof import("node:os");
	for (const ifaces of Object.values(os.networkInterfaces())) {
		for (const i of ifaces ?? []) {
			if (i.family === "IPv4" && !i.internal) return i.address;
		}
	}

	return "127.0.0.1";
}
