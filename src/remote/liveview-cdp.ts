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
//
// FOLLOWING THE FLOW. A sign-in that opens a new page — an in-app OAuth popup (new target,
// same endpoint) or the external-browser handoff (macOS `open` → the persistent-profile
// Chrome on a DIFFERENT endpoint) — must not leave the viewer staring at the original page.
// Where the Swift engine follows the flow through screen space (frontmost window), this one
// follows it through target space: every BrowserContext is watched for new pages, the newest
// page wins the stream, and a closing page pops back to the most recent still-open one
// (FollowStack below — the deep-link return to the app page IS that pop, no special casing).
// The browser endpoint is opt-in and attached lazily: a caller that wants the hop NAMES the
// endpoint (or sets LIVEVIEW_BROWSER_CDP_URL), and Chrome may not exist until the handoff
// launches it, so a silent endpoint is re-probed on an interval, never an error. No endpoint
// named at all means the engine never hops — browserCdpEndpoint has the why.
// onExit fires when the PRIMARY leg dies — at connect (endpoint unreachable, no drivable
// page, first screencast refused) or any time after; the browser leg dying just pops the
// follow stack.

import { type Browser, type CDPSession, chromium, type Page } from "playwright-core";
import { envNum } from "../env.js";
import { homeLabels } from "../core/harness/appmap.js";
import { clampFraction, type EngineCommand, type EngineEvent, type EngineHandle } from "./liveview.js";

/** The slice of Page.screencastFrame metadata input mapping needs: the viewport, CSS px. */
export interface FrameMeta {
	deviceWidth: number;
	deviceHeight: number;
}

export interface CdpEngineOptions {
	/** Debug endpoint, e.g. http://127.0.0.1:9222. Falls back to CDP_URL, then CDP_PORT. */
	endpoint?: string;
	/**
	 * The OPTIONAL second endpoint: the external browser an OAuth handoff lands in. Falls
	 * back to LIVEVIEW_BROWSER_CDP_URL; absent BOTH, the engine never hops — the hop is
	 * opt-in by presence, there is no default (browserCdpEndpoint has the why). A named but
	 * silent endpoint is still not an error — it is probed lazily and the session simply
	 * never hops until it answers.
	 */
	browserEndpoint?: string;
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

/**
 * Where the OPTIONAL browser endpoint is: explicit argument, then LIVEVIEW_BROWSER_CDP_URL,
 * then NOWHERE — undefined, and the engine never hops. There used to be a loopback default
 * here (127.0.0.1:9777, the cdp backend's web-Chrome port), removed deliberately: a default
 * that means "the machine I happen to run on" is only correct for exactly one caller class —
 * the sign-in CLI, which runs ON the Mac whose flagged Chrome that is (runner-spawned there,
 * or run by hand at the machine). For any other caller — the dash's fleet peek runs on the
 * OPERATOR'S laptop — the same fallback aims the lazy re-probe at the operator's own local
 * Chrome and silently streams THEIR browser into the panel the moment it answers. The one
 * caller the loopback is right for now says so explicitly (localBrowserCdpEndpoint).
 */
export function browserCdpEndpoint(endpoint?: string): string | undefined {
	return endpoint?.trim() || process.env.LIVEVIEW_BROWSER_CDP_URL?.trim() || undefined;
}

/**
 * The browser endpoint for the caller class that legitimately means ITS OWN loopback: the
 * sign-in CLI, which runs on the Mac where the OAuth handoff's Chrome lives. Exactly the env
 * semantics the removed in-engine default had (LIVEVIEW_BROWSER_CDP_URL wins; CDP_PORT beats
 * 9777 when set, blank reads as unset via envNum), kept in THIS module so the derivation and
 * the runner's CDP_BROWSER_PORT (runner/serve.ts) keep agreeing on where the browser leg
 * lives without anything being configured.
 */
export function localBrowserCdpEndpoint(): string {
	return process.env.LIVEVIEW_BROWSER_CDP_URL?.trim() || `http://127.0.0.1:${envNum("CDP_PORT", 9777)}`;
}

/** Do two strings name the same debug endpoint? Origin equality when they parse (a trailing
 *  slash is not a second endpoint), literal equality otherwise. Same-endpoint sessions
 *  attach once — two connections to one Chrome would follow every page twice. */
export function sameEndpoint(a: string, b: string): boolean {
	try {
		return new URL(a).origin === new URL(b).origin;
	} catch {
		return a.trim() === b.trim();
	}
}

/** Which endpoint a followed page came from. Identical while streaming; they part ways at
 *  death — the primary dying ends the session, the browser leg dying merely drops its pages. */
export type FollowOrigin = "primary" | "browser";

/**
 * The follow policy, pure: NEWEST PAGE WINS, POP ON CLOSE. A sign-in flow is a stack of
 * detours — app page → OAuth popup → maybe a consent page — and the human is always working
 * the most recently opened one; when it closes, the flow has returned to wherever it came
 * from, so the deep-link return to the app page IS the pop, no special casing. Kept free of
 * playwright so the policy is unit-testable with plain values (tests/liveview-cdp.test.ts).
 *
 * De-duped by page identity: re-pushing a followed page moves it to the top WITHOUT
 * duplicating (its close must pop exactly once), and dropping an unknown page is a no-op —
 * close events arrive for pages the engine chose never to follow.
 */
export class FollowStack<T> {
	private entries: { page: T; origin: FollowOrigin }[] = [];

	/** The page the engine should be streaming right now; undefined when none remains. */
	get active(): { page: T; origin: FollowOrigin } | undefined {
		return this.entries.at(-1);
	}

	get size(): number {
		return this.entries.length;
	}

	/**
	 * `idle` marks a page nothing is happening on — Chrome's New Tab, about:blank. It goes in
	 * BELOW everything live rather than on top, because newest-wins otherwise hands the stream
	 * to whatever the browser happened to have open. Measured on mac3, 2026-07-31: adopting
	 * pre-existing pages (the fix for the interstitial being unreachable) meant the lazily
	 * attached OAuth Chrome contributed its New Tab, which arrived after Yarn's login page and
	 * won — the operator opened the viewer onto an empty tab while the sign-in sat behind it.
	 * Ranked, not filtered: an idle page is still reachable with cmd+], because a flow can
	 * legitimately land on about:blank mid-redirect.
	 */
	push(page: T, origin: FollowOrigin, idle = false): void {
		this.entries = this.entries.filter((e) => e.page !== page);
		if (idle) this.entries.unshift({ page, origin });
		else this.entries.push({ page, origin });
	}

	/** A page closed: the active one pops back to the most recent still-open page, a
	 *  non-active one leaves silently. */
	dropClosed(page: T): void {
		this.entries = this.entries.filter((e) => e.page !== page);
	}

	/** An endpoint died: every page it contributed goes at once — their individual close
	 *  events never crossed the dead connection. */
	dropOrigin(origin: FollowOrigin): void {
		this.entries = this.entries.filter((e) => e.origin !== origin);
	}

	/**
	 * Make the OLDEST entry active — the operator's manual override for a newest-wins pick
	 * that landed on the wrong page (mac3, 2026-07-31: a blocking enterprise interstitial hid
	 * behind the redirect page that opened after it). Repeated calls walk every page and
	 * return to where they started, so a human can always reach any of them by pressing again.
	 * Rotation, not a swap: a swap on three or more pages can never reach the middle.
	 */
	cycle(): void {
		const first = this.entries.shift();
		if (first) this.entries.push(first);
	}
}

/**
 * A page with nothing on it: the browser's landing surfaces, not the flow. Deliberately a tiny
 * list of exact matches — `chrome://` in general must NOT be here, because the pages that
 * matter most (the managed-profile interstitial, permission prompts) live there too.
 */
export function isIdlePage(url: string): boolean {
	const u = url.trim();

	return u === "" || u === "about:blank" || u === "chrome://newtab/" || u === "chrome://new-tab-page/" || u === "edge://newtab/";
}

/**
 * How a page on the BROWSER leg enters the follow stack: whose tab is this — the flow's, or
 * the operator's?
 *
 * Reported 2026-07-31: with a leftover Wikipedia tab in the flagged Chrome (bench-run
 * residue), the sign-in viewer opened onto Wikipedia and never switched to the Google page.
 * Two policy errors with one root — ranking was decided from the URL alone, sampled once:
 *
 *  - A PRE-EXISTING tab is the operator's, however live its URL looks. It parks: reachable
 *    with cmd+] (the mac3 interstitial lesson — unselectable equals nonexistent), but never
 *    the stream's owner, and it never promotes itself — an old tab navigating is ambient
 *    (auto-refresh, a redirect it was parked on), not the flow.
 *  - A NEW tab is the flow's next leg, but Chrome creates it as about:blank and navigates it
 *    a beat later — so its follow-time URL says "idle" exactly when it matters most. It parks
 *    AND arms a one-shot promotion: the moment its main frame lands somewhere real, it takes
 *    the stream. A new tab that already carries a real URL just goes live.
 *
 * Browser origin only. Primary pages keep their own promotion channel (`cameHome` on every
 * main-frame navigation), which is why web-target flows never showed this bug.
 */
export function browserPageDisposition(preExisting: boolean, url: string): { rank: "live" | "parked"; promoteOnNavigate: boolean } {
	if (preExisting) return { rank: "parked", promoteOnNavigate: false };

	return isIdlePage(url) ? { rank: "parked", promoteOnNavigate: true } : { rank: "live", promoteOnNavigate: false };
}

/** How long the endpoint gets to answer /json/version. The target is already running (the
 *  runner foregrounds it before the viewer link goes out), so this is a liveness check, not
 *  a launch wait. */
const PROBE_ATTEMPTS = 3;
const PROBE_DELAY_MS = 300;
const CONNECT_TIMEOUT_MS = 5_000;
/** Cadence for re-probing a silent browser endpoint — Chrome may not exist until the OAuth
 *  handoff launches it, so silence is re-checked on this interval, never reported. */
const REPROBE_MS = 2_000;
/**
 * What the viewer's title bar shows for a page. A titleless page falls back to its URL, and an
 * OAuth URL is ~1500 characters of query string — seen live on mac3, 2026-07-31, where
 * Google's consent URL wrapped over six lines and shoved the whole canvas down the page.
 * A URL fallback is still worth having (it names where you are when a page has no title), so
 * it is shortened to origin + path rather than dropped, and anything still long is cut.
 */
export function titleFor(raw: string, max = 80): string {
	let s = raw.trim();
	if (/^https?:\/\//.test(s)) {
		try {
			const u = new URL(s);
			s = u.host + (u.pathname === "/" ? "" : u.pathname);
		} catch {}
	}

	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** How often to ask the app's own page whether the sign-in has landed. Cheap (one innerText
 *  read), and a second of lag on a flow that took minutes is not worth polling harder for. */
const HOME_POLL_MS = envNum("LIVEVIEW_HOME_POLL_MS", 1_000);

/** page.title() evaluates in the page; a hung renderer must not stall a hop announcement. */
const TITLE_TIMEOUT_MS = 1_500;

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
 * Decides when the home watch may announce "signed in": on a TRANSITION, never a level.
 *
 * The level check ("is a home label on screen right now?") closed every sign-in session on the
 * fleet, 2026-07-31. Two ways it fired without a sign-in, both seen live:
 *
 *  - **The cached flash.** The runner's `signin` verb restores the operator's parked profile
 *    and launches the app, which boots into a cached render of the signed-in Library before
 *    its dead token redirects it to /login. "Library" was on screen at the first poll, the
 *    session died ~3.5s in, and the operator never got to click anything.
 *  - **The provider's pages ARE the primary page.** Yarn's "Continue with Google" navigates
 *    the app's own window to accounts.google.com, so the primary-only guard never kept the
 *    watch off OAuth pages; a label collision there was one Google product name away.
 *
 * So: a hit only counts on the app's OWN origin (anchored to where the session started), and
 * only after at least one poll where it did NOT count — the label coming BACK is what a
 * completed sign-in looks like, because /login, the OAuth detour, or the flash expiring all
 * register as absence first. A session anchored somewhere unparseable (about:blank, an app
 * still booting) never fires and keeps the pre-auto-close behaviour: the 20-minute clock and
 * the operator closing the tab, which is an idle session, not a broken one.
 *
 * Two ways to fire, and "returned" is the point (set by David 2026-07-31: close "basically
 * as soon as the user submits their credential"):
 *
 *  - **"returned"** — the primary page comes back from a FOREIGN origin to the app's, on a
 *    path it did not start on. A provider only redirects back once the credential is
 *    accepted, so this lands seconds before the home label renders — no label needed. The
 *    path check is the failure guard: a bounced or abandoned OAuth returns to the SAME path
 *    the session started on (/login → provider → /login), which is not a submit.
 *  - **"label"** — the absence→presence transition on the home label, for flows that never
 *    leave the app origin (in-app credentials) and as the fallback when a return lands on
 *    the start path anyway.
 *
 * The runner's `ready` probe stays the real verdict either way — this only decides when the
 * operator stops having to watch.
 *
 * Known residual: an app that RELAUNCHES mid-session replays its cached flash after absence
 * has been recorded, and that would fire. The runner launches the app before the viewer link
 * goes out, so a mid-session relaunch is operator-driven and rare; accepted.
 */
export function homeTransitionGate(sessionStartUrl: string | undefined): (pageUrl: string, hit: string | undefined) => "label" | "returned" | undefined {
	const startPath = pathnameOf(sessionStartUrl);
	let sawAbsent = false;
	let sawForeign = false;

	return (pageUrl, hit) => {
		const onApp = sessionStartUrl !== undefined && sameOrigin(pageUrl, sessionStartUrl);
		if (!onApp) {
			sawForeign = true;
			sawAbsent = true;

			return undefined;
		}
		if (sawForeign && pathnameOf(pageUrl) !== startPath) return "returned";
		if (hit === undefined) {
			sawAbsent = true;

			return undefined;
		}

		return sawAbsent ? "label" : undefined;
	};
}

function pathnameOf(url: string | undefined): string | undefined {
	if (url === undefined) return undefined;
	try {
		return new URL(url).pathname;
	} catch {
		return undefined;
	}
}

/**
 * Connect to a Chromium debug endpoint and return an EngineHandle streaming the chosen page.
 *
 * Nothing here throws to the caller. A connect-time failure — endpoint silent, no drivable
 * page, first screencast refused — resolves to a DEAD handle: send/close are no-ops, the
 * typed error event reaches the first onEvent listener (so the viewer shows a remedy instead
 * of the server crashing), AND onExit fires. That last part is the liveness contract: a
 * handle that is born dead must give callers the same signal as an endpoint dying
 * mid-session, or every caller reimplements death-sniffing off the first buffered error
 * event (the dash did exactly that before this contract existed). Events are buffered until
 * the onEvent listener registers, and onExit registered after the death invokes its callback
 * immediately (the `exited` flag, in base below) — so no wiring order can lose either
 * signal. This deliberately DIVERGES from spawnEngine's spawn-failed posture (error event,
 * no exit): there the bridge must stay up to display the remedy, and it still does here —
 * both callers send the error to their viewer before their exit handler tears down.
 *
 * close() disconnects WITHOUT closing the browser (browser.close() on a connectOverCDP
 * connection only detaches — same posture as CdpBackend.close()): the signed-in session the
 * whole feature exists to create must survive the viewer tab closing.
 */
export async function connectCdpEngine(opts: CdpEngineOptions = {}): Promise<EngineHandle> {
	const endpoint = cdpEndpoint(opts.endpoint);
	const browserEndpoint = browserCdpEndpoint(opts.browserEndpoint);

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
	// A connect-time death: send/close are no-ops, but the handle SAYS it is dead — the typed
	// error event (already emitted by the caller) stands for the remedy, and fireExit gives
	// every onExit listener, however late it registers, the same signal as any other death.
	const dead = (): EngineHandle => {
		fireExit();

		return { ...base, send() {}, close() {} };
	};

	let browser: Browser;
	try {
		if (!(await endpointAnswers(endpoint))) throw new Error(`nothing answered at ${endpoint}/json/version`);
		browser = await chromium.connectOverCDP(endpoint, { timeout: CONNECT_TIMEOUT_MS });
	} catch (e) {
		emit({ ev: "error", kind: "cdp-unreachable", detail: `${(e as Error).message}` });

		return dead();
	}

	// Pick the page like the agent backend does: devtools and extension targets are never the
	// app; an origin match wins when the caller declared a URL, otherwise the first real page.
	const pages = browser.contexts().flatMap((c) => c.pages());
	const usable = pages.filter((p) => !/^(devtools|chrome-extension):/.test(p.url()));
	const first = (opts.url ? usable.find((p) => sameOrigin(p.url(), opts.url!)) : undefined) ?? usable[0];
	if (!first) {
		emit({
			ev: "error",
			kind: "no-page",
			detail: `${endpoint} exposes ${pages.length} target(s), none a drivable page${opts.url ? ` on ${opts.url}` : ""}`,
		});
		await browser.close().catch(() => {});

		return dead();
	}

	const appName = opts.app?.trim();
	const hostOf = (u: string): string => {
		try {
			return new URL(u).host;
		} catch {
			return u;
		}
	};

	const stack = new FollowStack<Page>();
	/** What is streaming right now — undefined mid-hop, and after the stack empties. */
	let streamed: { page: Page; session: CDPSession } | undefined;
	let meta: FrameMeta | undefined;
	let held = 0;
	let closed = false;
	let secondary: Browser | undefined;
	let reprobe: NodeJS.Timeout | undefined;
	/** Hops are serialized: two quick page events interleaving their session teardown/setup is
	 *  the one race this design has, and a queue removes it wholesale. Every step converges the
	 *  stream onto the stack's CURRENT active, so a hop that is stale by its turn is a no-op. */
	let hopQueue: Promise<void> = Promise.resolve();

	// The geometry fields are zeros on purpose: the viewer reads only app/title/settling from
	// window events (frame arrival is what reveals the canvas), and this engine has no window
	// geometry to report. Best-effort with a short timeout — page.title() evaluates in the
	// page, and a busy renderer must not stall the announcement the title bar is waiting on.
	const announce = (page: Page, origin: FollowOrigin) => {
		void (async () => {
			const raw =
				(await Promise.race([
					page.title().catch(() => ""),
					new Promise<string>((r) => setTimeout(r, TITLE_TIMEOUT_MS, "")),
				])) || page.url();
			// A browser-origin page can only exist once the browser leg attached, which requires
			// a named endpoint — the ?? arm satisfies the type, not a reachable case.
			const app = appName || hostOf(origin === "primary" ? endpoint : browserEndpoint ?? endpoint);
			emit({ ev: "window", id: 0, title: titleFor(raw), app, x: 0, y: 0, w: 0, h: 0, scale: 1 });
		})();
	};

	/** Converge the screencast + input routing onto the stack's active page. */
	const sync = () => {
		hopQueue = hopQueue
			.then(async () => {
				const want = closed ? undefined : stack.active;
				if (want?.page === streamed?.page) return;
				if (streamed) {
					const old = streamed.session;
					streamed = undefined;
					// Best-effort: the old session may already be dead (its page just closed).
					old.send("Page.stopScreencast").catch(() => {});
					void old.detach().catch(() => {});
				}
				// Stale metadata from the old page must never map a click onto the new one:
				// mapping is unavailable until the new page's first frame arrives — input is
				// dropped meanwhile, the same contract as the pre-first-frame window at connect.
				// Held buttons die with the page they were pressed on.
				meta = undefined;
				held = 0;
				if (!want) {
					// The stack emptied with the primary endpoint still up. NOT a death, so unlike
					// the connect-time dead() paths exit does NOT fire: the error stands, and a
					// page opening later revives the stream — only primary-endpoint death (or a
					// first hop that never streamed) ends the session.
					if (!closed) emit({ ev: "error", kind: "stream-stopped", detail: "every followed page closed" });

					return;
				}
				try {
					const s = await want.page.context().newCDPSession(want.page);
					s.on("Page.screencastFrame", (p) => {
						// Ack unconditionally — an unacked frame stops the stream cold — but
						// forward only while this session is the streamed one: a frame in flight
						// across a hop must not repaint the old page or poison the new mapping.
						s.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
						if (streamed?.session !== s) return;
						meta = p.metadata;
						const jpeg = Buffer.from(p.data, "base64");
						for (const cb of frameCbs) cb(jpeg);
					});
					// Re-announced on every top-frame navigation so the title bar tracks an OAuth
					// flow's redirects.
					s.on("Page.frameNavigated", ({ frame }) => {
						if (!frame.parentId && streamed?.session === s) announce(want.page, want.origin);
					});
					streamed = { page: want.page, session: s };
					await s.send("Page.enable");
					await s.send("Page.startScreencast", {
						format: "jpeg",
						quality: cdpQuality(opts.quality),
						...(opts.maxWidth ? { maxWidth: opts.maxWidth } : {}),
					});
				} catch (e) {
					if (streamed) {
						void streamed.session.detach().catch(() => {});
						streamed = undefined;
					}
					if (!closed) emit({ ev: "error", kind: "capture-failed", detail: (e as Error).message });

					return;
				}
				announce(want.page, want.origin);
			})
			.catch(() => {}); // a failed hop must not wedge the queue — the next sync converges
	};

	/**
	 * The PRIMARY app navigated, so the flow has come home.
	 *
	 * A browser leg that handed off does not close and does not go blank — Google's
	 * `accounts.youtube.com/accounts/SetSID` sits there as a live https page forever. Newest-wins
	 * keeps streaming it while the app it just authenticated renders the signed-in view behind,
	 * which on mac3 (2026-07-31) was reported as "stuck white screen after successful signin":
	 * the sign-in HAD worked, the viewer was simply pointed at the wrong page.
	 *
	 * A navigation on the primary target is the strongest available signal that the detour is
	 * over — the app only re-navigates when the deep link lands. So promote the app and demote
	 * the browser pages that led here. Not closing them: the flow can bounce back to the
	 * browser, and cmd+] still reaches them.
	 */
	const cameHome = (page: Page) => {
		if (closed || stack.active?.page === page) return;
		stack.push(page, "primary");
		sync();
	};

	/**
	 * One-shot: the first main-frame navigation that lands somewhere real takes the page live.
	 * The handoff's tab is born about:blank and becomes the auth page a beat later — a rank
	 * decided at follow time says "parked" exactly when it matters most (browserPageDisposition
	 * has the full account of the leftover-Wikipedia-tab report this closes).
	 */
	const armPromotion = (page: Page) => {
		const promote = () => {
			if (closed || isIdlePage(page.url())) return;
			page.off("framenavigated", promote);
			stack.push(page, "browser");
			sync();
		};
		page.on("framenavigated", promote);
	};

	/** Put a page under follow: wire its close to the pop, push it (newest wins), converge. */
	const followed = new WeakSet<Page>();
	const follow = (page: Page, origin: FollowOrigin, preExisting = false) => {
		if (closed || followed.has(page)) return;
		if (/^(devtools|chrome-extension):/.test(page.url())) return;
		followed.add(page);
		page.on("close", () => {
			stack.dropClosed(page);
			sync();
		});
		// The deep-link return: only the primary target's own navigation counts, and only after
		// the stream has already wandered off to a browser leg. A browser page navigating is
		// just the OAuth chain doing its several redirects.
		if (origin === "primary") {
			page.on("framenavigated", (f) => { if (f === page.mainFrame()) cameHome(page); });
			stack.push(page, origin, isIdlePage(page.url()));
		} else {
			const d = browserPageDisposition(preExisting, page.url());
			if (d.promoteOnNavigate) armPromotion(page);
			stack.push(page, origin, d.rank === "parked");
		}
		sync();
	};

	/**
	 * Follow every page a browser opens from here on, AND every page it already has.
	 *
	 * The adoption half was learned the hard way on mac3, 2026-07-31: a managed-Workspace
	 * sign-in opened `chrome://managed-user-profile-notice`, which BLOCKS the OAuth chain, and
	 * the engine never offered it — page events only fire for pages created after the listener
	 * attaches, so anything already open was invisible and unreachable. A page the operator
	 * cannot select is the same as a page that is not there. Adopting existing pages costs
	 * nothing (the stack dedupes, `followed` guards) and is the difference between a stuck
	 * sign-in and a steerable one.
	 */
	const watch = (b: Browser, origin: FollowOrigin) => {
		for (const c of b.contexts()) {
			c.on("page", (p) => follow(p, origin));
			// Adopted as PRE-EXISTING: on the browser leg that parks them (an operator's old
			// tabs are reachable with cmd+], never the stream's owner); primary pages ignore
			// the flag — an app window that exists is exactly the thing to stream.
			for (const p of c.pages()) follow(p, origin, true);
		}
	};

	watch(browser, "primary");
	follow(first, "primary");
	// The first hop decides connect success exactly as the single-page engine did: a refused
	// screencast on the chosen page is a dead engine with a typed remedy already emitted, not
	// a live one showing nothing.
	await hopQueue;
	if (!streamed) {
		await browser.close().catch(() => {});

		return dead();
	}

	browser.on("disconnected", fireExit);

	// The optional browser leg. Attached lazily and silently: no error events for an absent
	// secondary — it is optional by design, and Chrome may not exist until the handoff
	// launches it. Same-URL endpoints attach once; the primary watcher already covers them.
	const attachSecondary = async (launchedMidFlow: boolean): Promise<void> => {
		if (browserEndpoint === undefined) return; // hopping was never opted into
		let b: Browser;
		try {
			b = await chromium.connectOverCDP(browserEndpoint, { timeout: CONNECT_TIMEOUT_MS });
		} catch {
			return; // answered the probe but refused the connect — the re-probe loop retries
		}
		if (closed) {
			await b.close().catch(() => {});

			return;
		}
		secondary = b;
		b.on("disconnected", () => {
			// The browser leg dying pops its pages (their close events never crossed the dead
			// connection) — it does NOT end the session, and Chrome may come back for a later
			// handoff, so the probe resumes.
			if (secondary === b) secondary = undefined;
			stack.dropOrigin("browser");
			sync();
			armReprobe();
		});
		watch(b, "browser");
		// A Chrome that was silent at session start was launched mid-flow — by the handoff's
		// `open`, carrying its page BEFORE this attach could see a `page` event. That page IS
		// the flow's next leg: watch() above adopted it PARKED like any pre-existing page
		// (right for an operator's old tabs, wrong for this one — the Chrome exists BECAUSE
		// of the handoff), so take the newest live, or arm the same one-shot promotion a
		// born-blank new tab gets. A Chrome that answered at start holds the operator's old
		// tabs; those stay parked — reachable with cmd+], never streamed unbidden.
		if (launchedMidFlow) {
			const cand = b.contexts().flatMap((c) => c.pages()).filter((p) => !/^(devtools|chrome-extension):/.test(p.url()));
			const newest = cand.at(-1);
			if (newest && !isIdlePage(newest.url())) {
				stack.push(newest, "browser");
				sync();
			} else if (newest) armPromotion(newest);
		}
	};

	const armReprobe = () => {
		if (closed || reprobe) return;
		reprobe = setTimeout(() => {
			reprobe = undefined;
			void probeSecondary(true);
		}, REPROBE_MS);
		reprobe.unref();
	};
	const probeSecondary = async (launchedMidFlow: boolean): Promise<void> => {
		if (closed || secondary || browserEndpoint === undefined) return;
		if (await endpointAnswers(browserEndpoint)) await attachSecondary(launchedMidFlow);
		if (!closed && !secondary) armReprobe();
	};
	// No browser endpoint at all (no argument, no env) means the caller never opted into the
	// hop, so the probe loop never starts: the engine must not lazily discover a Chrome the
	// caller never named — on an operator's laptop, "the local 9777" is THEIR browser.
	if (browserEndpoint !== undefined && !sameEndpoint(endpoint, browserEndpoint)) void probeSecondary(false);

	/**
	 * Watch the PRIMARY page for the app's signed-in home screen and announce it.
	 *
	 * Set by David 2026-07-31: once authentication is programmatically confirmed, the operator
	 * has no reason to keep watching a remote copy of their app — end the session there rather
	 * than run the 20-minute clock down. It also retires the bug class that produced the
	 * "stuck white screen": there is no after-the-flow page to choose if there is no after.
	 *
	 * The labels come from the appmap (the same ones `homeVisible` greps an ObservationBundle
	 * for) and are matched against the page's own visible text — no driver, no observation, and
	 * cheap enough to poll. An app with no appmap yields no labels, and then this never fires:
	 * the session keeps its old behaviour rather than guessing that some page means "done".
	 *
	 * A hit alone is not the announcement — `homeTransitionGate` requires the label to have been
	 * ABSENT first and the page to be on the app's own origin, because a level check fired on
	 * the cached-Library flash at app launch and closed every sign-in session on the fleet
	 * (2026-07-31; the gate's own comment has the full account).
	 *
	 * Emitted ONCE, as an event. Whether it ends the session is the server's call, not the
	 * engine's — the engine reports what it sees.
	 */
	const armHomeWatch = () => {
		const labels = appName ? homeLabels(appName) : [];
		if (!labels.length) return undefined;
		const gate = homeTransitionGate(first.url());
		let fired = false;

		return setInterval(() => {
			if (closed || fired) return;
			const active = stack.active;
			// Primary only: a detour streaming a browser leg is by definition not home. The
			// origin anchor inside the gate covers the case this guard cannot — OAuth pages
			// loading in the primary window itself.
			if (!active || active.origin !== "primary") return;
			const url = active.page.url();
			void active.page
				.evaluate((want: string[]) => {
					const text = document.body?.innerText ?? "";

					return want.find((w) => text.includes(w));
				}, labels)
				.then((hit) => {
					if (fired || closed) return;
					const why = gate(url, hit ?? undefined);
					if (!why) return;
					fired = true;
					emit({
						ev: "home",
						detail: why === "returned"
							? `${appName} came back from the sign-in detour — closing; the readiness check confirms in the background`
							: `"${hit}" is back on screen — ${appName} is signed in`,
					});
				})
				.catch(() => {}); // a navigating page throws; the next tick asks again
		}, HOME_POLL_MS);
	};
	const homeWatch = armHomeWatch();

	const close = () => {
		if (closed) return;
		closed = true;
		if (reprobe) clearTimeout(reprobe);
		if (homeWatch) clearInterval(homeWatch);
		void (async () => {
			// Let an in-flight hop land before tearing down what it installed.
			await hopQueue.catch(() => {});
			const s = streamed?.session;
			streamed = undefined;
			if (s) {
				await s.send("Page.stopScreencast").catch(() => {});
				await s.detach().catch(() => {});
			}
			await browser.close().catch(() => {}); // disconnect only; the browser survives
			if (secondary) await secondary.close().catch(() => {});
		})();
	};

	return {
		...base,
		send(cmd) {
			if (closed) return;
			// Commands route to the ACTIVE session only; mid-hop (undefined) they are dropped,
			// like input before the first frame.
			const s = streamed?.session;
			switch (cmd.cmd) {
				case "quit":
					close();

					return;
				case "follow":
					// Cycle to the next followed page. Newest-wins is a heuristic and mac3
					// (2026-07-31) showed it losing: a blocking enterprise interstitial was
					// superseded by the redirect page that arrived after it, leaving the
					// operator watching a blank `Redirecting` while the thing needing a click
					// sat behind it. An automatic policy will always have such a case, so the
					// human gets a manual override rather than a cleverer heuristic.
					stack.cycle();
					sync();

					return;
				case "pin":
					// A viewer-side window id means nothing here: the CDP engine's units are
					// pages, and the viewer never learns their ids. `follow` is the verb.
					return;
				case "mouse": {
					if (!s || !meta) return; // no frame from the current page yet: nowhere to aim
					const t = mouseEventParams(cmd, meta, held);
					held = t.held;
					for (const ev of t.events) void s.send("Input.dispatchMouseEvent", ev).catch(() => {});

					return;
				}
				case "scroll":
					if (!s || !meta) return;
					void s.send("Input.dispatchMouseEvent", wheelParams(cmd, meta)).catch(() => {});

					return;
				case "key": {
					if (!s) return;
					const ev = keyEventParams(cmd.down, cmd.code, cmd.flags);
					if (ev) void s.send("Input.dispatchKeyEvent", ev).catch(() => {});

					return;
				}
				case "text":
					// Paste-like insertion, no key events — exactly right for sign-in fields, and
					// the same path the viewer's own paste handler already takes on the SCK engine.
					if (!s) return;
					void s.send("Input.insertText", { text: cmd.s }).catch(() => {});

					return;
			}
		},
		close,
	};
}
