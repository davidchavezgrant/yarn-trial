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

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import { type EngineEvent, type EngineHandle, remedyFor, spawnEngine } from "./liveview.js";
import { type DecodedFrame, encodeFrame, handshakeResponse, type Opcode, WsDecoder } from "./liveview-ws.js";
import { viewerHtml } from "./liveview-viewer.js";

export interface ServerOptions {
	host?: string; // default 127.0.0.1
	port?: number; // default 0 (ephemeral)
	fps?: number;
	quality?: number;
	maxWidth?: number;
	/** Override the engine binary (tests). */
	bin?: string;
	/** Sign-in target app — arms the engine's constrained-browser mode. See EngineOptions.app. */
	app?: string;
	/** Bind beyond loopback. Off by default; a raw login stream on the LAN is a leak. */
	lan?: boolean;
	/**
	 * Use this exact token instead of minting one. The runner supplies it so it can hand the
	 * teammate a complete URL without a second round trip to read it back off the child's stdout.
	 */
	token?: string;
	/**
	 * Absolute ceiling on the server's lifetime, ms. The runner spawns this DETACHED, so nothing
	 * else will reap it — a sign-in that is walked away from must not leave a capture-capable
	 * server (and an injectable window) listening indefinitely. 0 disables (local dev, Ctrl-C).
	 */
	maxLifetimeMs?: number;
	/**
	 * After the viewer disconnects, exit if no new viewer connects within this window, ms. A closed
	 * tab is the normal "I'm done" signal; lingering would hold the port and a live engine. 0
	 * disables. Ignored until the first connection, so the operator has time to open the link.
	 */
	idleAfterCloseMs?: number;
	/** Called just before the server self-terminates (maxLifetime or idle). Injected for tests. */
	onExpire?: (reason: "max-lifetime" | "idle") => void;
	/**
	 * Engine factory — how a viewer connection gets its capture engine. Defaults to spawning
	 * the native SCK engine; the CLI passes connectCdpEngine for Chromium targets
	 * (LIVEVIEW_TRANSPORT=cdp). One engine per connection either way, torn down with it.
	 */
	engine?: () => EngineHandle | Promise<EngineHandle>;
}

export interface RunningServer {
	url: string;
	token: string;
	port: number;
	close(): Promise<void>;
	server: Server;
}

/**
 * The self-termination clock for a detached server, factored out as a pure state machine so its
 * decisions are unit-testable without sockets or timers. It answers one question — "should the
 * server exit now, and why" — from three facts: whether a viewer has ever connected, how many
 * are connected now, and how long since each relevant moment.
 *
 * Two independent deadlines, because they guard different failures:
 *  - max-lifetime: a hard ceiling from START, so a server nobody ever opens (or a wedged one)
 *    cannot listen forever with a capture-capable engine behind it.
 *  - idle-after-close: once a viewer has connected and then left, a closed tab is the operator
 *    saying "done"; linger briefly in case they reopen, then exit. Deliberately NOT armed before
 *    the first connection — the operator needs time to click the link.
 */
export interface LifecycleState {
	startedAtMs: number;
	everConnected: boolean;
	/**
	 * Live viewer count, not a boolean: connections overlap (a browser reconnecting through a
	 * tunnel blip, a second tab), and a stale socket's close must not mark the server idle while
	 * another viewer is mid-sign-in.
	 */
	openConnections: number;
	lastCloseMs?: number;
}

export function connectionOpened(s: LifecycleState): void {
	s.everConnected = true;
	s.openConnections += 1;
}

/** Only the LAST close makes the server idle-eligible; earlier closes leave a live viewer. */
export function connectionClosed(s: LifecycleState, nowMs: number): void {
	s.openConnections = Math.max(0, s.openConnections - 1);
	if (s.openConnections === 0) s.lastCloseMs = nowMs;
}

export function lifecycleVerdict(
	s: LifecycleState,
	nowMs: number,
	opts: { maxLifetimeMs?: number; idleAfterCloseMs?: number },
): "run" | "max-lifetime" | "idle" {
	if (opts.maxLifetimeMs && opts.maxLifetimeMs > 0 && nowMs - s.startedAtMs >= opts.maxLifetimeMs) return "max-lifetime";
	// Idle only applies once a viewer has connected AND none is connected now AND we know when the last left.
	if (opts.idleAfterCloseMs && opts.idleAfterCloseMs > 0 && s.everConnected && s.openConnections === 0 && s.lastCloseMs !== undefined)
		if (nowMs - s.lastCloseMs >= opts.idleAfterCloseMs) return "idle";

	return "run";
}

/**
 * Start the viewer server. Resolves once it is listening, with the URL to hand to the teammate
 * (or to `ssh -L` against). One engine is spawned per WebSocket connection and killed when it
 * closes, so a dropped tab tears down the capture on the Mac rather than leaking a process.
 */
export function startLiveViewServer(opts: ServerOptions = {}): Promise<RunningServer> {
	// A caller-supplied token (the runner) must pass the shape check or fail LOUDLY: silently
	// minting a replacement would leave the caller holding a URL that 403s while a
	// capture-capable server runs out its full lifetime under a token nobody knows.
	if (opts.token !== undefined && !/^[A-Za-z0-9_-]{16,}$/.test(opts.token))
		throw new Error("invalid supplied token: need >=16 chars of [A-Za-z0-9_-]");
	const token = opts.token ?? randomBytes(18).toString("base64url");
	const host = opts.lan ? "0.0.0.0" : (opts.host ?? "127.0.0.1");

	// Constant-time comparison; hashing both sides first equalizes lengths, which
	// timingSafeEqual requires.
	const tokenDigest = createHash("sha256").update(token).digest();
	const tokenOk = (supplied: string | null): boolean =>
		supplied !== null && timingSafeEqual(createHash("sha256").update(supplied).digest(), tokenDigest);

	// Parse the request target against a FIXED base: only the path and query matter here, and the
	// Host header is client-controlled — a malformed one (`Host: a b^c`) would make `new URL`
	// throw pre-auth, letting any local process crash the detached server mid-login and race a
	// look-alike onto the freed port.
	const parseTarget = (raw: string | undefined): URL | undefined => {
		try {
			return new URL(raw ?? "/", "http://127.0.0.1");
		} catch {
			return undefined;
		}
	};

	const server = createServer((req, res) => {
		const url = parseTarget(req.url);
		if (!url) {
			res.writeHead(400, { "content-type": "text/plain" });
			res.end("bad request");

			return;
		}
		// The viewer page itself is gated by the token in the query string.
		if (url.pathname === "/" && tokenOk(url.searchParams.get("t"))) {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			res.end(viewerHtml(token));

			return;
		}
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("not found");
	});

	// Self-termination clock (see lifecycleVerdict). Tracks connection state and, on a 1s tick,
	// exits the process when a deadline passes. Only armed if a deadline was actually set, so local
	// `./run liveview` (Ctrl-C to stop) is unaffected.
	const life: LifecycleState = { startedAtMs: Date.now(), everConnected: false, openConnections: 0 };
	// Upgraded sockets, so close() can destroy them: server.close() only refuses NEW connections,
	// and its callback never fires while a live viewer's socket is open.
	const liveSockets = new Set<Duplex>();
	let lifeTimer: NodeJS.Timeout | undefined;
	const armLifecycle = () => {
		if (!opts.maxLifetimeMs && !opts.idleAfterCloseMs) return;
		lifeTimer = setInterval(() => {
			const verdict = lifecycleVerdict(life, Date.now(), opts);
			if (verdict === "run") return;
			clearInterval(lifeTimer);
			if (opts.onExpire) opts.onExpire(verdict);
			else {
				server.close();
				process.exit(0);
			}
		}, 1000);
		lifeTimer.unref();
	};

	server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
		const url = parseTarget(req.url);
		const key = req.headers["sec-websocket-key"];
		if (!url || !tokenOk(url.searchParams.get("t")) || typeof key !== "string") {
			socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
			socket.destroy();

			return;
		}
		socket.write(handshakeResponse(key));
		connectionOpened(life);
		liveSockets.add(socket);
		socket.once("close", () => {
			liveSockets.delete(socket);
			connectionClosed(life, Date.now());
		});
		void bridge(socket, opts);
	});

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(opts.port ?? 0, host, () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			const shown = opts.lan ? hostAddress() : "127.0.0.1";
			armLifecycle();
			resolve({
				url: `http://${shown}:${port}/?t=${token}`,
				token,
				port,
				server,
				close: () =>
					new Promise((r) => {
						if (lifeTimer) clearInterval(lifeTimer);
						for (const s of liveSockets) s.destroy();
						server.close(() => r());
					}),
			});
		});
	});
}

/**
 * When the viewer's socket has this many bytes queued, outbound JPEG frames are DROPPED. The live
 * view only ever needs the newest frame, and ~15fps of JPEGs into a stalled ssh tunnel (TCP alive,
 * reader wedged) would otherwise grow the write queue by hundreds of MB over a 20-minute lifetime.
 */
const MAX_QUEUED_SEND_BYTES = 1.5 * 1024 * 1024;

/**
 * How long the viewer keeps streaming after the app reports itself signed in. Long enough for
 * the teammate to SEE that it worked — a stream that vanishes the instant they finish reads as
 * a crash, and they will ask whether the sign-in took. Short enough that a signed-in account is
 * not left on an injectable channel while nobody is watching.
 */
const HOME_LINGER_MS = 2_500;

/**
 * Wire one WebSocket to one engine instance. Async because the CDP engine connects before it
 * can stream; bytes the viewer sends meanwhile sit in the socket's readable buffer until the
 * 'data' listener attaches below, so nothing is lost to the await.
 */
async function bridge(socket: Duplex, opts: ServerOptions): Promise<void> {
	let engine: EngineHandle;
	try {
		engine = await (opts.engine
			? opts.engine()
			: spawnEngine({ fps: opts.fps, quality: opts.quality, maxWidth: opts.maxWidth, bin: opts.bin, app: opts.app }));
	} catch (e) {
		// Neither built-in factory throws (both degrade to a typed error event), but a factory
		// that does must not become an unhandled rejection that kills the detached server.
		console.error(`engine failed to start: ${(e as Error).message}`);
		socket.destroy();

		return;
	}
	if (socket.destroyed) {
		// The viewer left while the engine was connecting.
		engine.close();

		return;
	}
	const decoder = new WsDecoder();
	let open = true;

	const send = (payload: Buffer, kind: Opcode) => {
		if (!open) return;
		// Frames are disposable — drop them under backpressure. Small text/control messages are
		// not, and always go through.
		if (kind === "binary" && socket.writableLength > MAX_QUEUED_SEND_BYTES) return;
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

		// The sign-in landed: say so, then stop. Set by David 2026-07-31 — with authentication
		// confirmed programmatically there is nothing left for a human to watch, and every extra
		// second is a live capture-and-inject channel onto someone's signed-in account. The
		// viewer gets the event first (the send above) and a moment to paint its farewell before
		// the socket goes; teardown is idempotent, so a viewer that closes first is not a race.
		if (ev.ev === "home") setTimeout(teardown, HOME_LINGER_MS);
	});

	socket.on("data", (chunk: Buffer) => {
		let frames: DecodedFrame[];
		try {
			frames = decoder.push(chunk);
		} catch {
			// Protocol violation (fragmented/unmasked/oversized frame): fail the connection per
			// RFC 6455 rather than silently mis-parse operator input.
			teardown();

			return;
		}
		for (const frame of frames) {
			if (frame.opcode === "close") {
				teardown();

				return;
			}
			if (frame.opcode === "ping") {
				// RFC 6455 §5.5.3: a pong echoes the ping's payload.
				send(frame.payload, "pong");
				continue;
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
			// Complete the close handshake — a bare FIN reads as abnormal closure (1006) in the browser.
			socket.write(encodeFrame(Buffer.alloc(0), "close"));
			socket.end();
		} catch {
			// already closed
		}
	};

	socket.on("close", teardown);
	socket.on("error", teardown);
	engine.onExit(teardown);
}

/** First non-loopback IPv4, for the LAN-demo URL. Best-effort. */
function hostAddress(): string {
	for (const ifaces of Object.values(networkInterfaces())) {
		for (const i of ifaces ?? []) {
			if (i.family === "IPv4" && !i.internal) return i.address;
		}
	}

	return "127.0.0.1";
}
