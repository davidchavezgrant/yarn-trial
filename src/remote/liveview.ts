// liveview — window-scoped remote login, in TypeScript.
//
// This is the deliberately-testable half of the feature. `native/liveview` (Swift) does the
// two things Node cannot — single-window ScreenCaptureKit capture and CGEvent injection — and
// this module owns everything that is pure logic and therefore worth unit-testing on its own:
//
//   - the wire protocol to the engine (JSON commands out, framed frames + JSON events in),
//   - viewport-fraction input translation (the viewer speaks 0..1 of the window; the engine
//     wants the same, so the contract is that NOTHING here needs to know pixels — proven by
//     `toEngineMouse`/`toEngineScroll` below being pure and total),
//   - the framed-frame parser that splits `"F" <uint32 BE len> <jpeg>` out of a byte stream.
//
// The streaming server and the browser viewer live in liveview-server.ts; they are I/O and are
// smoke-tested against a real Mac, not unit-tested. Keeping the parsing/translation here means
// the part most likely to have an off-by-one (the frame framing) is covered by `npm test`.
//
// WHY FRACTIONS AND NOT PIXELS. The tracked window moves and resizes (the OAuth handoff swaps
// to a differently-sized browser window mid-session), and the viewer is scaled to whatever the
// teammate's browser tab happens to be. If either side spoke pixels, every window switch and
// every tab resize would need a renegotiation. Instead the viewer reports where a click landed
// as a fraction of the rendered image, the engine maps that same fraction onto the CURRENT
// window bounds it already knows, and neither side ever learns the other's pixel dimensions.
// The one rule this imposes — clamp to [0,1] so a drag that leaves the image cannot inject a
// click onto the desktop behind the window — is enforced by the ENGINE in globalPoint, the one
// point every input path funnels through. The pure helpers below clamp too so a viewer can be
// written (and unit-tested) against them, but nothing forces a caller through them, so they are
// a convenience, not the authority.

import { spawn, type ChildProcess } from "node:child_process";
import { nativeDir } from "../paths.js";
import { describeHolder, inspect } from "./runner/lease.js";

/** A geometry/status event the engine emits on stdout. */
export interface WindowEvent {
	ev: "window";
	id: number;
	title: string;
	app: string;
	x: number;
	y: number;
	w: number;
	h: number;
	scale: number;
	/** The followed window belongs to some OTHER app than the sign-in target (the browser leg). */
	foreign?: boolean;
	/** Active page-content crop, as fractions of the window. Present only in constrained mode. */
	crop?: { x: number; y: number; w: number; h: number };
	/**
	 * Frames are being WITHHELD while this foreign window resolves its crop. The viewer shows a
	 * settling state rather than a dead canvas; see the engine's `framesAllowed()` for why an
	 * uncropped browser must never be shown even briefly.
	 */
	settling?: boolean;
}

/**
 * The target app reached its signed-in home screen — the sign-in is DONE.
 *
 * Set by David 2026-07-31, after a run where the sign-in had succeeded and the viewer sat on a
 * spent OAuth redirect page: once we can confirm authentication programmatically, nobody needs
 * to keep watching a remote copy of their app. The session should end at that moment rather
 * than burn its 20-minute clock, which also retires a whole bug class — "which page does the
 * viewer show after the flow finishes" stops being a question when there is no after.
 */
export interface HomeEvent {
	ev: "home";
	/** What was seen, for the viewer's farewell line ("home control 'Library' is on screen"). */
	detail: string;
}

/** The engine pressed the external-protocol confirmation ("Open Yarn.app") itself. */
export interface AutoEvent {
	ev: "auto";
	pressed: string;
}

/**
 * Emitted once at startup: whether the engine holds the Accessibility grant. False means the
 * foreign-browser crop and the "Open <App>" auto-press cannot work — the stream itself still
 * can, so this is a diagnostic, not an error.
 */
export interface AxEvent {
	ev: "ax";
	trusted: boolean;
}

/** Foreign-window scan diagnostic, emitted when the scan's findings change shape. */
export interface ScanEvent {
	ev: "scan";
	/**
	 * Which rect the crop came from, tightest first: the login card's own container (`ink`), the
	 * whole page (`webarea`), the window minus the browser's furniture (`chrome` — the floor
	 * adopted when no page geometry resolved before the settle deadline), or `none`, which means
	 * frames are being WITHHELD rather than shown wide.
	 */
	source: "ink" | "webarea" | "chrome" | "none";
	leaves: number;
	/** "WxH" or "nil". */
	web: string;
	ink: string;
	/** The chrome-less floor, whether or not it was the one used. "WxH" or "nil". */
	chrome?: string;
}

/** A Cmd-shortcut was dropped by the constrained-browser key guard. */
export interface BlockedEvent {
	ev: "blocked";
	what: "key";
	code: number;
}

export interface ErrorEvent {
	ev: "error";
	/** Typed so the caller can map to an operator remedy without parsing prose. */
	kind: "no-screen-recording" | "no-window" | "capture-failed" | "stream-stopped" | "spawn-failed" | string;
	detail: string;
}

export type EngineEvent = WindowEvent | AutoEvent | AxEvent | ScanEvent | BlockedEvent | ErrorEvent | HomeEvent;

/** A command the viewer/server sends to the engine. `x`/`y` are 0..1 fractions of the window. */
export type EngineCommand =
	| { cmd: "follow" }
	| { cmd: "pin"; window: number }
	| { cmd: "mouse"; type: "move" | "down" | "up" | "click"; x: number; y: number; button: "left" | "right" }
	| { cmd: "scroll"; x: number; y: number; dy: number; dx: number }
	| { cmd: "key"; down: boolean; code: number; flags: number }
	| { cmd: "text"; s: string }
	| { cmd: "quit" };

/** Clamp a fraction to the window, so input that leaves the rendered image cannot reach the desktop. */
export function clampFraction(f: number): number {
	if (Number.isNaN(f)) return 0;
	if (f < 0) return 0;
	if (f > 1) return 1;

	return f;
}

/**
 * Translate a viewer pointer event (a click at pixel px,py inside a rendered image of size
 * rw×rh) into an engine mouse command in window fractions. Total: any input, including a click
 * outside the image or a zero-size image, yields a valid clamped command rather than throwing —
 * a login viewer must never crash the stream on a stray event.
 */
export function toEngineMouse(
	type: "move" | "down" | "up" | "click",
	px: number,
	py: number,
	renderedW: number,
	renderedH: number,
	button: "left" | "right" = "left",
): Extract<EngineCommand, { cmd: "mouse" }> {
	const x = renderedW > 0 ? clampFraction(px / renderedW) : 0;
	const y = renderedH > 0 ? clampFraction(py / renderedH) : 0;

	return { cmd: "mouse", type, x, y, button };
}

export function toEngineScroll(
	px: number,
	py: number,
	renderedW: number,
	renderedH: number,
	dy: number,
	dx: number,
): Extract<EngineCommand, { cmd: "scroll" }> {
	const x = renderedW > 0 ? clampFraction(px / renderedW) : 0;
	const y = renderedH > 0 ? clampFraction(py / renderedH) : 0;

	return { cmd: "scroll", x, y, dy: Math.trunc(dy), dx: Math.trunc(dx) };
}

/**
 * Incremental parser for the engine's frame fd: a stream of `"F" <uint32 BE length> <jpeg>`.
 *
 * Written as a class holding a buffer because frames arrive split across `data` chunks at
 * arbitrary byte boundaries — the single most likely place for a corruption bug — and a stateful
 * parser with a test that feeds it one byte at a time is how that bug gets caught before a Mac
 * is involved. `push` returns every COMPLETE frame now available and retains the partial tail.
 */
export class FrameParser {
	private buf: Buffer = Buffer.alloc(0);
	private static readonly MARKER = 0x46; // 'F'
	private static readonly HEADER = 5; // marker + uint32
	// Resync can lock onto a 0x46 inside jpeg data, whose next four bytes then read as a length
	// up to ~4GiB — and the parser would buffer forever waiting for a frame that never completes.
	// Real frames are window-sized jpegs, well under this; anything bigger IS a desync.
	private static readonly MAX_FRAME = 32 * 1024 * 1024;

	push(chunk: Buffer): Buffer[] {
		this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
		const out: Buffer[] = [];

		for (;;) {
			if (this.buf.length < FrameParser.HEADER) break;
			if (this.buf[0] !== FrameParser.MARKER) {
				// Resync: drop bytes until the next marker rather than throwing, so one bad byte
				// costs at most one frame instead of the whole session.
				const next = this.buf.indexOf(FrameParser.MARKER, 1);
				if (next === -1) {
					this.buf = Buffer.alloc(0);
					break;
				}
				this.buf = this.buf.subarray(next);
				continue;
			}
			const len = this.buf.readUInt32BE(1);
			if (len > FrameParser.MAX_FRAME) {
				// False marker: treat as desync and resume scanning one byte later.
				this.buf = this.buf.subarray(1);
				continue;
			}
			if (this.buf.length < FrameParser.HEADER + len) break;
			out.push(this.buf.subarray(FrameParser.HEADER, FrameParser.HEADER + len));
			this.buf = this.buf.subarray(FrameParser.HEADER + len);
		}

		return out;
	}
}

/**
 * Line parser for the engine's JSON event stdout. Returns parsed events; silently drops a line
 * that is not valid JSON (the engine only ever writes JSON, but a corrupt half-line during
 * teardown should not throw).
 */
export class EventParser {
	private buf = "";

	push(chunk: string): EngineEvent[] {
		this.buf += chunk;
		const out: EngineEvent[] = [];
		let nl: number;
		while ((nl = this.buf.indexOf("\n")) !== -1) {
			const line = this.buf.slice(0, nl).trim();
			this.buf = this.buf.slice(nl + 1);
			if (!line) continue;
			try {
				const obj = JSON.parse(line);
				if (obj && typeof obj.ev === "string") out.push(obj as EngineEvent);
			} catch {
				// Not an event line — ignore.
			}
		}

		return out;
	}
}

/** Map a typed engine error to the operator remedy, matching the tone of signin.ts. */
export function remedyFor(err: ErrorEvent): string {
	switch (err.kind) {
		case "no-screen-recording":
			return "grant Screen Recording to the runner (the Electron process) in System Settings ▸ Privacy & Security ▸ Screen Recording, then retry";
		case "no-window":
			return "no capturable window is frontmost on that Mac — open the app first";
		case "capture-failed":
		case "stream-stopped":
			return `the capture stream stopped (${err.detail}) — retry, and check the app is still open`;
		case "spawn-failed":
			return `the engine binary would not start (${err.detail}) — it is gitignored, so run npm run build:native on that Mac`;
		case "cdp-unreachable":
			return `no Chromium debug endpoint answered (${err.detail}) — launch the target with --remote-debugging-port first, point LIVEVIEW_CDP_URL at a live endpoint, or force --sck for window capture instead`;
		case "no-page":
			return `the debug endpoint answered but exposed no drivable page (${err.detail}) — open the target page or window first, then retry`;
		default:
			return err.detail;
	}
}

/** Serialize a command to the newline-delimited form the engine reads on stdin. */
export function encodeCommand(cmd: EngineCommand): string {
	return `${JSON.stringify(cmd)}\n`;
}

/**
 * Refuse to start a login stream while a demo run holds the machine — the two must never capture
 * at once.
 *
 * A demo recording and a login live-view are two capture sessions on one Mac. If a login stream
 * comes up mid-run, the recorder's window snapshots and the login stream fight for the same
 * window, and worse, a human's password entry could land in frames of the demo take. The demo
 * run holds the runner lease for exactly its duration, so the lease is the authority on "is a run
 * in flight" — the same signal `serve.ts` consults. We CHECK it, we do not TAKE it: a login is
 * not a run, and taking the lease would wrongly mark the Mac busy to the fleet (this mirrors the
 * runner's own `signin` verb, which checks the lease without acquiring it).
 *
 * Returns a refusal string naming who holds the machine, or null when the coast is clear. Pure
 * apart from reading the lease file, so it is unit-testable by pointing `runnerDir` at a fixture.
 */
export function loginBlockedByRun(runnerDir?: string): string | null {
	const holder = inspect(runnerDir).holder;
	if (!holder) return null;

	return `a run is in flight (${describeHolder(holder)}) — a login stream would capture over the recording. Wait for it to finish, then retry.`;
}

/**
 * A live handle to a capture engine. Thin: frames out as JPEG buffers, typed events out,
 * viewer commands in. The server (liveview-server.ts) wires this to a WebSocket. Two
 * implementations exist: spawnEngine below (the native SCK/CGEvent child process) and
 * connectCdpEngine in liveview-cdp.ts (Page.startScreencast over an existing debug port).
 *
 * `onExit` is the transport-neutral "the engine died" signal — the server used to watch
 * `child.on("exit")` directly, which only a child-process engine can offer. `child` stays,
 * optional, for the callers that really do mean the process (the e2e harness, tests); no
 * server logic may depend on it.
 *
 * fd layout of the spawned engine matches the Swift side: stdin = commands, stdout = JSON
 * events, fd 3 = binary frames.
 */
export interface EngineHandle {
	send(cmd: EngineCommand): void;
	onFrame(cb: (jpeg: Buffer) => void): void;
	onEvent(cb: (ev: EngineEvent) => void): void;
	onExit(cb: () => void): void;
	close(): void;
	readonly child?: ChildProcess;
}

export interface EngineOptions {
	fps?: number;
	quality?: number;
	maxWidth?: number;
	bin?: string;
	/**
	 * The sign-in target's name. Naming it is what arms the engine's constrained-browser mode
	 * (crop to the page content, Cmd-key guard, hands-free "Open <App>" press) whenever the
	 * followed window belongs to any OTHER app. Absent, the engine streams windows whole.
	 */
	app?: string;
}

/** The argv for the engine binary — split out so the flag wiring is testable without a spawn. */
export function engineArgs(opts: EngineOptions): string[] {
	const args: string[] = [];
	if (opts.fps) args.push("--fps", String(opts.fps));
	if (opts.quality) args.push("--quality", String(opts.quality));
	if (opts.maxWidth) args.push("--max-width", String(opts.maxWidth));
	if (opts.app?.trim()) args.push("--app", opts.app.trim());

	return args;
}

/** The spawned engine always has a child process, and its callers (the e2e harness, the
 *  degrade tests) reach for it — so the return type says so rather than making every one
 *  of them re-prove the optional. */
export function spawnEngine(opts: EngineOptions = {}): EngineHandle & { readonly child: ChildProcess } {
	const bin = opts.bin ?? `${nativeDir()}/liveview`;
	const args = engineArgs(opts);

	// stdio: [stdin pipe, stdout pipe, stderr inherit, fd3 pipe for frames].
	const child = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit", "pipe"] });
	const frames = new FrameParser();
	const events = new EventParser();
	const frameCbs: ((j: Buffer) => void)[] = [];
	const eventCbs: ((e: EngineEvent) => void)[] = [];
	const exitCbs: (() => void)[] = [];

	// The engine dies for mundane reasons: the binary is gitignored, so a fresh checkout spawns
	// ENOENT, and a crashed engine breaks the stdin pipe, whose EPIPE arrives as an ASYNC 'error'
	// event on the stream — not a sync throw any try/catch here could see. None of that may take
	// down the detached server. Same degrade-gracefully contract as axdom's collect(): surface a
	// typed event the caller can remedy, swallow the pipe error, and go inert.
	let dead = false;
	const gone = () => dead || child.exitCode !== null;
	child.on("error", (err: NodeJS.ErrnoException) => {
		dead = true;
		const detail = `${err.code ?? err.message} (${bin})`;
		for (const cb of eventCbs) cb({ ev: "error", kind: "spawn-failed", detail });
	});
	// onExit fires on 'exit' ONLY, not on spawn 'error': ENOENT emits 'error' with no 'exit',
	// and that gap is load-bearing — the server's bridge staying up is what lets the viewer
	// display the spawn-failed remedy instead of an immediate "disconnected".
	child.on("exit", () => {
		dead = true;
		for (const cb of exitCbs) cb();
	});
	child.stdin?.on("error", () => {});

	const frameFd = child.stdio[3] as NodeJS.ReadableStream | null;
	frameFd?.on("data", (c: Buffer) => {
		for (const f of frames.push(c)) for (const cb of frameCbs) cb(f);
	});
	child.stdout?.on("data", (c: Buffer) => {
		for (const e of events.push(c.toString("utf8"))) for (const cb of eventCbs) cb(e);
	});

	return {
		child,
		send(cmd) {
			if (gone()) return;
			child.stdin?.write(encodeCommand(cmd));
		},
		onFrame(cb) {
			frameCbs.push(cb);
		},
		onEvent(cb) {
			eventCbs.push(cb);
		},
		onExit(cb) {
			exitCbs.push(cb);
		},
		close() {
			if (gone()) return;
			child.stdin?.write(encodeCommand({ cmd: "quit" }));
			child.kill("SIGTERM");
		},
	};
}
