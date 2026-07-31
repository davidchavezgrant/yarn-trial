// liveview-cdp — the CDP screencast engine: remote sign-in for Chromium targets.
//
// The second implementation of EngineHandle (decision record:
// docs/research/2026-07-31-liveview-transport-alternatives.md). Where native/liveview.swift
// captures a WINDOW with ScreenCaptureKit and injects input with CGEvent, this connects to a
// target already reachable over --remote-debugging-port, streams Page.startScreencast frames,
// and injects input through CDP's Input domain. What that buys, and why it is worth a second
// engine:
//
//   - Page-scoped by construction. A page stream has no outside-the-page to leak, so the SCK
//     engine's foreign-window crop / settling / frame-withholding machinery has nothing to do
//     here — none of it exists in this file, deliberately.
//   - Input never touches the machine. No CGEvent means the real cursor does not move, the
//     window can be occluded or on another Space, and nothing a human does locally collides
//     with the injection.
//
// What it deliberately does NOT do:
//
//   - Native chrome. Passkey/Touch ID sheets, TCC prompts, the external-protocol "Open
//     Yarn.app" dialog, and hardened Electron apps that strip the debug flag are invisible to
//     CDP — the SCK engine stays the default and the fallback for exactly those.
//   - An fps knob. Screencast is frame-driven: Chromium emits a frame when the compositor
//     commits one, so a static login form costs near-zero bandwidth (the decision record calls
//     that exactly right for sign-in) and there is no time-based rate to set. `fps` is
//     accepted and ignored rather than faked with everyNthFrame, which subsamples commits and
//     cannot raise a rate either.
//   - Sharing CdpBackend's connection. A sign-in session and an agent run never share a
//     lifecycle, so this makes its own lightweight connection and mirrors the backend's small
//     helpers (endpoint liveness poll, origin match) locally instead of refactoring them out.
//
// The input contract mirrors the Swift engine's globalPoint: commands arrive as fractions of
// the rendered frame, are clamped to [0,1] (a drag that leaves the image must not land
// somewhere else in the page), and map against the LATEST frame's metadata —
// deviceWidth/deviceHeight are the viewport in CSS pixels, which is exactly the coordinate
// space Input.dispatchMouseEvent speaks. Both sides describe the SAME rendered frame, so a
// maxWidth-downscaled JPEG changes nothing: fraction × viewport is correct at any scale.
// Input arriving before the first frame is dropped — there is no metadata to map it against,
// and no frame means the viewer has nothing to aim at yet.

import { type Browser, type CDPSession, chromium } from "playwright-core";
import { envNum } from "../env.js";
import { clampFraction, type EngineCommand, type EngineEvent, type EngineHandle } from "./liveview.js";

/** The slice of Page.screencastFrame metadata input mapping needs: the viewport, CSS px. */
export interface FrameMeta {
	deviceWidth: number;
	deviceHeight: number;
}

export interface CdpEngineOptions {
	/** Debug endpoint, e.g. http://127.0.0.1:9222. Falls back to CDP_URL, then CDP_PORT. */
	endpoint?: string;
	/** Prefer the page whose origin matches this URL; absent, the first real page wins. */
	url?: string;
	/** Display name for the viewer's title bar. */
	app?: string;
	/** JPEG quality — SCK-style 0..1 or CDP-style 0..100, see cdpQuality. */
	quality?: number;
	maxWidth?: number;
	/** Accepted for EngineOptions parity, ignored — screencast has no time-based rate. */
	fps?: number;
}

/** Map a viewer fraction onto the current viewport. Clamped first — the authority clamp,
 *  same contract as the Swift engine's globalPoint. */
export function fractionToCss(fx: number, fy: number, meta: FrameMeta): { x: number; y: number } {
	return { x: clampFraction(fx) * meta.deviceWidth, y: clampFraction(fy) * meta.deviceHeight };
}

/**
 * One ServerOptions.quality feeds both engines, and they disagree on units: the Swift engine
 * takes 0..1 (its default is 0.78), CDP takes 0..100. A fraction is scaled up, a percent is
 * clamped — 1.0 reads as the fraction (full quality), matching what it means to the SCK
 * engine, since a caller asking for literal "1%" JPEG is not a real case.
 */
export function cdpQuality(q?: number): number {
	if (q === undefined || !Number.isFinite(q) || q <= 0) return 80;
	const pct = q <= 1 ? Math.round(q * 100) : Math.round(q);

	return Math.max(1, Math.min(100, pct));
}

/** CGEventFlags bitmask (what the viewer sends) → CDP modifiers (Alt=1, Ctrl=2, Meta=4, Shift=8). */
export function cdpModifiers(cgFlags: number): number {
	let m = 0;
	if (cgFlags & 0x80000) m |= 1; // option
	if (cgFlags & 0x40000) m |= 2; // control
	if (cgFlags & 0x100000) m |= 4; // command
	if (cgFlags & 0x20000) m |= 8; // shift

	return m;
}

/**
 * The macOS virtual keycodes the viewer's NAMED table sends, mapped to the DOM identity CDP
 * wants. Exactly the viewer's nine — anything else returns undefined and is dropped, because
 * the viewer routes every printable through the `text` path and never sends other codes.
 * `text` is what makes a keyDown produce a character (Chromium synthesizes the char event
 * from it); only Enter and Space produce one.
 */
const CG_TO_DOM: Record<number, { key: string; code: string; windowsVirtualKeyCode: number; text?: string }> = {
	36: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
	48: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
	51: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
	53: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
	49: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
	123: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
	124: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
	125: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
	126: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
};

export interface CdpKeyParams {
	type: "keyDown" | "rawKeyDown" | "keyUp";
	modifiers: number;
	key: string;
	code: string;
	windowsVirtualKeyCode: number;
	text?: string;
	unmodifiedText?: string;
}

/**
 * A viewer key command → Input.dispatchKeyEvent params, or undefined for a code outside the
 * viewer's table. keyDown-with-text vs rawKeyDown follows Chromium's own rule (and
 * playwright's keyboard): a key produces its character only when no non-shift modifier is
 * held — cmd+Enter must not also type a newline.
 */
export function keyEventParams(down: boolean, cgCode: number, cgFlags: number): CdpKeyParams | undefined {
	const k = CG_TO_DOM[cgCode];
	if (!k) return undefined;
	const modifiers = cdpModifiers(cgFlags);
	const identity = { key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode };
	if (!down) return { type: "keyUp", modifiers, ...identity };
	const text = (modifiers & ~8) === 0 ? k.text : undefined;

	return text
		? { type: "keyDown", modifiers, ...identity, text, unmodifiedText: text }
		: { type: "rawKeyDown", modifiers, ...identity };
}

export interface CdpMouseParams {
	type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
	x: number;
	y: number;
	modifiers: number;
	button?: "none" | "left" | "right";
	buttons?: number;
	clickCount?: number;
	deltaX?: number;
	deltaY?: number;
}

/**
 * A viewer scroll → Input.dispatchMouseEvent mouseWheel. The viewer NEGATES the DOM wheel
 * deltas into CGEvent convention (positive scrolls up); CDP speaks the browser-native sign
 * (positive deltaY scrolls down — the convention the agent backend's page.mouse.wheel rides),
 * so both axes are negated back.
 */
export function wheelParams(cmd: Extract<EngineCommand, { cmd: "scroll" }>, meta: FrameMeta): CdpMouseParams {
	const { x, y } = fractionToCss(cmd.x, cmd.y, meta);

	return { type: "mouseWheel", x, y, modifiers: 0, deltaX: -cmd.dx, deltaY: -cmd.dy };
}

/** CDP `buttons` bit per button (Left=1, Right=2 — the DOM MouseEvent.buttons values). */
const BUTTON_BIT: Record<"left" | "right", number> = { left: 1, right: 2 };

/**
 * A viewer mouse command → the Input.dispatchMouseEvent calls it implies, plus the updated
 * held-buttons mask. The mask is the caller's to thread through: `buttons` must reflect what
 * is held ACROSS commands (a drag is move events with buttons≠0), and per DOM convention the
 * released button is already absent from mouseReleased's mask. clickCount stays 1 — the
 * viewer sends raw down/up pairs and never synthesizes double-clicks, and a sign-in form
 * does not need them.
 */
export function mouseEventParams(
	cmd: Extract<EngineCommand, { cmd: "mouse" }>,
	meta: FrameMeta,
	held: number,
): { events: CdpMouseParams[]; held: number } {
	const { x, y } = fractionToCss(cmd.x, cmd.y, meta);
	const bit = BUTTON_BIT[cmd.button];
	const press = (buttons: number): CdpMouseParams =>
		({ type: "mousePressed", x, y, modifiers: 0, button: cmd.button, buttons, clickCount: 1 });
	const release = (buttons: number): CdpMouseParams =>
		({ type: "mouseReleased", x, y, modifiers: 0, button: cmd.button, buttons, clickCount: 1 });

	switch (cmd.type) {
		case "move":
			return {
				events: [{
					type: "mouseMoved",
					x,
					y,
					modifiers: 0,
					button: held & 1 ? "left" : held & 2 ? "right" : "none",
					buttons: held,
				}],
				held,
			};
		case "down":
			return { events: [press(held | bit)], held: held | bit };
		case "up":
			return { events: [release(held & ~bit)], held: held & ~bit };
		case "click":
			// The viewer never sends this (it speaks down/up pairs); accepted anyway, as one
			// full press-release cycle, so a hand-rolled client cannot wedge the mask.
			return { events: [press(held | bit), release(held)], held };
	}
}

/**
 * Where the debug endpoint is when nobody named one: explicit argument, then CDP_URL, then
 * the CDP_PORT loopback default. Exported because the CLI's auto-transport probe must aim
 * at exactly the endpoint connectOverCDP would use — two derivations of "the default
 * endpoint" is how a probe passes against one port and the connect dies against another.
 */
export function cdpEndpoint(endpoint?: string): string {
	return endpoint?.trim() || process.env.CDP_URL || `http://127.0.0.1:${envNum("CDP_PORT", 9222)}`;
}

/** How long the endpoint gets to answer /json/version. The target is already running (the
 *  runner foregrounds it before the viewer link goes out), so this is a liveness check, not
 *  a launch wait. */
const PROBE_ATTEMPTS = 3;
const PROBE_DELAY_MS = 300;
const CONNECT_TIMEOUT_MS = 5_000;

/** Exported for the CLI's auto-transport selection: answers → screencast, silent → SCK. */
export async function endpointAnswers(url: string): Promise<boolean> {
	for (let i = 0; i < PROBE_ATTEMPTS; i++) {
		try {
			const r = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1_500) });
			if (r.ok) return true;
		} catch {}
		await new Promise((r) => setTimeout(r, PROBE_DELAY_MS));
	}

	return false;
}

/** Exact-origin equality, unparseable never matches — same posture as the agent backend's
 *  originMatches (mirrored, not imported: remote/ stays independent of backends/). */
function sameOrigin(pageUrl: string, targetUrl: string): boolean {
	try {
		return new URL(pageUrl).origin === new URL(targetUrl).origin;
	} catch {
		return false;
	}
}

/**
 * Connect to a Chromium debug endpoint and return an EngineHandle streaming the chosen page.
 *
 * Death handling mirrors spawnEngine's: nothing here throws to the caller. A failure —
 * endpoint silent, no drivable page, screencast refused — resolves to an INERT handle whose
 * send/close are no-ops and whose typed error event reaches the first onEvent listener, so
 * the viewer shows a remedy instead of the server crashing. Events are buffered until that
 * listener registers: the server wires callbacks after this resolves, and both the
 * dead-handle error and the connect-time window event would otherwise fall into the gap.
 *
 * close() disconnects WITHOUT closing the browser (browser.close() on a connectOverCDP
 * connection only detaches — same posture as CdpBackend.close()): the signed-in session the
 * whole feature exists to create must survive the viewer tab closing.
 */
export async function connectCdpEngine(opts: CdpEngineOptions = {}): Promise<EngineHandle> {
	const endpoint = cdpEndpoint(opts.endpoint);

	const frameCbs: ((j: Buffer) => void)[] = [];
	const eventCbs: ((e: EngineEvent) => void)[] = [];
	const exitCbs: (() => void)[] = [];
	const pending: EngineEvent[] = [];
	let exited = false;
	const emit = (ev: EngineEvent) => {
		if (eventCbs.length === 0) {
			pending.push(ev);

			return;
		}
		for (const cb of eventCbs) cb(ev);
	};
	const fireExit = () => {
		if (exited) return;
		exited = true;
		for (const cb of exitCbs) cb();
	};
	const base: Pick<EngineHandle, "onFrame" | "onEvent" | "onExit"> = {
		onFrame(cb) {
			frameCbs.push(cb);
		},
		onEvent(cb) {
			eventCbs.push(cb);
			while (pending.length) cb(pending.shift()!);
		},
		onExit(cb) {
			if (exited) {
				cb();

				return;
			}
			exitCbs.push(cb);
		},
	};
	// Inert like a spawn-failed SCK engine: the error event stands, exit never fires, so the
	// bridge stays up long enough for the viewer to display the remedy.
	const inert = (): EngineHandle => ({ ...base, send() {}, close() {} });

	let browser: Browser;
	try {
		if (!(await endpointAnswers(endpoint))) throw new Error(`nothing answered at ${endpoint}/json/version`);
		browser = await chromium.connectOverCDP(endpoint, { timeout: CONNECT_TIMEOUT_MS });
	} catch (e) {
		emit({ ev: "error", kind: "cdp-unreachable", detail: `${(e as Error).message}` });

		return inert();
	}

	// Pick the page like the agent backend does: devtools and extension targets are never the
	// app; an origin match wins when the caller declared a URL, otherwise the first real page.
	const pages = browser.contexts().flatMap((c) => c.pages());
	const usable = pages.filter((p) => !/^(devtools|chrome-extension):/.test(p.url()));
	const page = (opts.url ? usable.find((p) => sameOrigin(p.url(), opts.url!)) : undefined) ?? usable[0];
	if (!page) {
		emit({
			ev: "error",
			kind: "no-page",
			detail: `${endpoint} exposes ${pages.length} target(s), none a drivable page${opts.url ? ` on ${opts.url}` : ""}`,
		});
		await browser.close().catch(() => {});

		return inert();
	}

	let session: CDPSession;
	try {
		session = await page.context().newCDPSession(page);
		await session.send("Page.enable");
		await session.send("Page.startScreencast", {
			format: "jpeg",
			quality: cdpQuality(opts.quality),
			...(opts.maxWidth ? { maxWidth: opts.maxWidth } : {}),
		});
	} catch (e) {
		emit({ ev: "error", kind: "capture-failed", detail: (e as Error).message });
		await browser.close().catch(() => {});

		return inert();
	}

	const app = opts.app?.trim() || "Chrome";
	let meta: FrameMeta | undefined;
	let held = 0;
	let closed = false;

	session.on("Page.screencastFrame", (p) => {
		meta = p.metadata;
		// Ack unconditionally, listener or not — an unacked frame stops the stream cold, and a
		// stalled stream is indistinguishable from a dead one from the viewer's side.
		session.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
		const jpeg = Buffer.from(p.data, "base64");
		for (const cb of frameCbs) cb(jpeg);
	});

	// The geometry fields are zeros on purpose: the viewer reads only app/title/settling from
	// window events (frame arrival is what reveals the canvas), and this engine has no window
	// geometry to report. Re-announced on every top-frame navigation so the title bar tracks
	// an OAuth flow's redirects.
	const announce = async () => {
		const title = (await page.title().catch(() => "")) || page.url();
		emit({ ev: "window", id: 0, title, app, x: 0, y: 0, w: 0, h: 0, scale: 1 });
	};
	session.on("Page.frameNavigated", ({ frame }) => {
		if (!frame.parentId) void announce();
	});
	await announce();

	browser.on("disconnected", fireExit);
	page.on("close", () => {
		emit({ ev: "error", kind: "stream-stopped", detail: "the streamed page closed" });
		fireExit();
	});

	const close = () => {
		if (closed) return;
		closed = true;
		void (async () => {
			await session.send("Page.stopScreencast").catch(() => {});
			await session.detach().catch(() => {});
			await browser.close().catch(() => {}); // disconnect only; the browser survives
		})();
	};

	return {
		...base,
		send(cmd) {
			if (closed) return;
			switch (cmd.cmd) {
				case "quit":
					close();

					return;
				case "follow":
				case "pin":
					// Page-scoped by construction — there is nothing to follow or pin.
					return;
				case "mouse": {
					if (!meta) return; // no frame yet: nothing rendered, nowhere to aim
					const t = mouseEventParams(cmd, meta, held);
					held = t.held;
					for (const ev of t.events) void session.send("Input.dispatchMouseEvent", ev).catch(() => {});

					return;
				}
				case "scroll":
					if (!meta) return;
					void session.send("Input.dispatchMouseEvent", wheelParams(cmd, meta)).catch(() => {});

					return;
				case "key": {
					const ev = keyEventParams(cmd.down, cmd.code, cmd.flags);
					if (ev) void session.send("Input.dispatchKeyEvent", ev).catch(() => {});

					return;
				}
				case "text":
					// Paste-like insertion, no key events — exactly right for sign-in fields, and
					// the same path the viewer's own paste handler already takes on the SCK engine.
					void session.send("Input.insertText", { text: cmd.s }).catch(() => {});

					return;
			}
		},
		close,
	};
}
