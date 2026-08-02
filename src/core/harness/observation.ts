import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { quitApp } from "../appctl.js";
import * as axdom from "../axdom.js";
import { Driver } from "../driver.js";
import { OUT } from "./run.js";

export interface WindowRef {
	pid: number;
	windowId: number;
	/**
	 * The window rect as list_windows reported it. Recorded so a post-pass can reconcile driver
	 * coordinates with the captured frames without re-deriving the display scale — and, on a
	 * natively-fullscreen app, this is the ONLY geometry available, since System Events reports
	 * zero windows for one and stageWindowForRecording has nothing to measure.
	 */
	bounds?: { x?: number; y?: number; width?: number; height?: number };
}

/** AX roles a pass can actuate. The frontier ledger counts these and nothing else. */
export const INTERACTIVE_ROLES = ["AXButton", "AXTextField", "AXPopUpButton", "AXMenuItem", "AXCheckBox", "AXRadioButton", "AXComboBox", "AXLink"];

/**
 * One actuatable control, extracted from an observation so callers can track which controls
 * they have operated versus merely looked at (see the frontier ledger in src/core/explore.ts).
 *
 * This is the same data already rendered into `elementsText` for the model; pulling it out
 * as structure is what lets code, rather than the model's self-report, say what was covered.
 */
export interface InteractiveElement {
	/** Addressing handle from THIS observation only — element_index (AX) or ref (DOM). */
	handle: number | string;
	role: string;
	/** Label, or the DOM descriptor when the control is anonymous. "" when it has neither. */
	name: string;
	/**
	 * Which channel supplied `name`: the AX label, or the DOM descriptor standing in for an
	 * anonymous control ("none" when both are empty). Carried so a step record can say which
	 * perception channel did the naming — the raw material for channel-contribution stats.
	 * Optional because the DOM/CDP backends build their own elements and have no AX label to
	 * distinguish from; absent means the question does not apply on that backend.
	 */
	namedBy?: "ax" | "dom" | "none";
	/** Nearest named ancestor: which panel or menu this sits in. "" at top level. */
	surface: string;
	/**
	 * The control's current value — what a combobox reads, what a text field holds. ""
	 * only when it has none. A value that merely duplicates `name` is suppressed in the
	 * RENDERED line, never here: the mutation journal restores from this field, and a text
	 * field whose content equals its label recorded as "" would make teardown "restore" it
	 * by clearing a field that had text.
	 *
	 * Rendered into `elementsText` for the model long before it was carried here. Pulling it
	 * into the struct is what lets code diff two observations and say which control CHANGED,
	 * rather than only which one was clicked — the raw material for the mutation journal in
	 * src/core/journal.ts, and the difference between restoring a setting and guessing at it.
	 */
	value: string;
	/**
	 * Bounds in SCREENSHOT PIXELS — the space coordinate actions consume, NOT the logical
	 * points AX reports and `frames` below carries. Converted here, once, so a click point
	 * can be tested against a control's box without every caller re-deriving the display
	 * scale. All zero when the scale could not be derived (no AXWindow element),
	 * which makes containment tests MISS rather than match wrongly.
	 */
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface ObservationBundle {
	elementsText: string;
	haystack: string;
	screenshotB64: string;
	title: string;
	/**
	 * The page URL, on a web target. Absent for a Mac app, which has no such thing.
	 *
	 * Worth carrying separately from the haystack it also feeds: it is the one piece of state a
	 * website exposes that a native app does not, and it makes a run log say WHERE each step
	 * happened rather than only what was on screen.
	 */
	url?: string;
	/** Every actuatable control in this observation. See InteractiveElement. */
	interactive: InteractiveElement[];
	/** Count of non-menu-bar AX elements. 0 means the app is not addressable right now. */
	appContent: number;
	/** Frames for which the axdom sidecar supplied DOM id/class/tooltip. 0 = no enrichment. */
	domEnriched: number;
	/** Set when enrichment could not run (sidecar unbuilt, disabled, native app). */
	domUnavailable?: string;
	/**
	 * The inputs the AX→screenshot transform was derived from, for diagnosing a mis-aimed click.
	 * Absent on cdp, which needs no transform: `scale:"css"` makes screenshot pixels and the
	 * coordinates act consumes the same space by construction.
	 */
	geometryBasis?: {
		window?: { x: number; y: number; w: number; h: number };
		shotW: number;
		shotH: number;
		scale: number;
		heightGapPoints?: number;
		structuredKeys: string[];
	};
	/**
	 * Every named element's position, keyed by name. The geometry channel's raw material:
	 * comparing two observations' maps says which elements moved and by how far.
	 *
	 * Deliberately keyed by NAME rather than element_index, which is a walk order that
	 * renumbers whenever the tree changes shape — the one thing guaranteed to happen when
	 * the app redraws. Frames are in logical points, a different space from the screenshot
	 * pixels a drag consumes, so a delta here is never fed back into an action.
	 */
	frames: Map<string, { x: number; y: number }>;
}

/** One row of `list_windows` output, the fields pickWindow consults. Verified live 2026-07-31. */
export interface WindowCandidate {
	app_name: string;
	pid: number;
	window_id: number;
	title: string;
	is_on_screen: boolean;
	z_index: number;
	bounds: { x: number; y: number; width: number; height: number };
}

/**
 * Which of the app's windows should a run be reading RIGHT NOW?
 *
 * The old selection sorted on (has-title, then area) — and on a multi-document app that is
 * a coin flip: in run 2026-07-31T10-29-05-036 the stale document and the actual front
 * window were both titled at identical 603x505 bounds, the tie broke arbitrarily, and the
 * run read the wrong window for 11 straight steps (0/11 verified, pixels 0.0%).
 *
 * The keys that DO distinguish them, probe-verified against TextEdit with 22 windows open:
 * - `is_on_screen` was true only for the actually-composited front window. It leads the
 *   sort but is deliberately NOT a filter — a backgrounded-but-composited window can
 *   report false, and filtering would then find nothing where a preference still picks
 *   the best available.
 * - `z_index` is the window server's front order (front window 361, the stale one 344,
 *   the junk placeholders lower still). Highest wins.
 * - titled-over-untitled and area survive from the old sort as the remaining tiebreakers;
 *   the >50k-pixel area guard still drops tooltips, panels and TextEdit's 30px offscreen
 *   placeholder rows before any key is consulted.
 *
 * `pid`, when given, pins the follow to the process we launched — two instances of an app
 * share an app_name, and a follow that drifted across processes would be worse than the
 * stale-window bug it replaces.
 */
export function pickWindow(windows: WindowCandidate[], app: string, pid?: number): WindowCandidate | undefined {
	const area = (w: WindowCandidate) => (w.bounds?.width ?? 0) * (w.bounds?.height ?? 0);

	return windows
		.filter((w) => w.app_name === app && (pid === undefined || w.pid === pid) && area(w) > 50_000)
		.sort(
			(a, b) =>
				(b.is_on_screen ? 1 : 0) - (a.is_on_screen ? 1 : 0)
				|| (b.z_index ?? 0) - (a.z_index ?? 0)
				|| (b.title ? 1 : 0) - (a.title ? 1 : 0)
				|| area(b) - area(a),
		)[0];
}

export async function findWindow(driver: Driver, app: string): Promise<WindowRef> {
	const windows = await driver.act({ kind: "tool", name: "list_windows", args: {} });
	const parsed = JSON.parse(windows.structuredJson ?? "{}");
	// No pid: first acquisition has no process to pin to yet — the pick names it.
	const win = pickWindow(parsed.windows ?? [], app);
	if (!win) throw new Error(`no window found for app "${app}"`);

	return { pid: win.pid, windowId: win.window_id, bounds: win.bounds };
}

/**
 * An app that is running, answers every driver call, and shows nothing but its menu bar.
 *
 * Two different causes produce the identical symptom, and the message has to name the right
 * one or it sends the operator somewhere useless:
 *
 * 1. THE SCREEN IS LOCKED. The login window owns the display, so app windows are not
 *    composited and AX exposes only the menu bar. Measured on mac2 and mac3, 2026-07-30:
 *    1974 elements, every one of them `AXMenu*`, `screencapture` refusing with "could not
 *    create image from display", and `CGSSessionScreenIsLocked` true on exactly the two
 *    hosts that failed. This is the common case on a colo Mac nobody sits at.
 * 2. The window is on an inactive Space (another app is fullscreen). Chromium suspends the
 *    app and produces the same empty tree. See LIMITATIONS.md §1.
 *
 * Only (1) is cheaply detectable, so it is checked and the rest is left as the fallback
 * rather than asserted. Until 2026-07-30 this class named (2) unconditionally, which is how
 * two locked Macs were read as a Spaces problem and answered with a relaunch that could not
 * possibly have helped — nothing relaunches its way out of a lock screen.
 */
export class TargetNotObservableError extends Error {
	constructor(app: string, detail: string, locked = false) {
		super(
			locked
				? `"${app}" is running but not observable (${detail}) because THE SCREEN IS LOCKED.\n` +
						`A locked Mac composites no app windows, so the accessibility tree contains the\n` +
						`menu bar and nothing else. No amount of foregrounding or relaunching changes this.\n` +
						`Unlock it — screen-share in (./run signin <host>) and log in once — then re-run.\n` +
						`To stop it recurring on a machine that exists to be driven, turn off the screen\n` +
						`lock and display sleep on that host.`
				: `"${app}" is running but not observable (${detail}), and neither foregrounding nor\n` +
						`relaunching it helped. The screen is unlocked, so the likely causes are:\n` +
						`  · the run itself closed, hid or minimised the app — check the last action in the\n` +
						`    log before this error (an explore pass pressed cmd+Q on 2026-07-31 and this\n` +
						`    message blamed Spaces, sending the operator after a window that no longer\n` +
						`    existed). sessionEndingChord() in harness/gates.ts now refuses those chords,\n` +
						`    so a run on current code should not reach this by its own hand.\n` +
						`  · an inactive macOS Space it keeps restoring itself onto — another app is\n` +
						`    fullscreen, or the window belongs to a different desktop. Bring the app onto\n` +
						`    the active Space (click it in the Dock or ⌘-Tab to it), then re-run.`,
		);
		this.name = "TargetNotObservableError";
	}
}

export const isAppContent = (e: any) => !String(e.role ?? "").startsWith("AXMenu");

/**
 * Whether the login window currently owns the display.
 *
 * `ioreg` rather than a Quartz call because this has to work from whatever context the runner
 * is in, including one that cannot link CoreGraphics. The key is absent — not false — on an
 * unlocked machine, so absence is the unlocked answer.
 *
 * Answers false on any failure. This only ever refines an error message; a diagnostic that
 * could itself fail a run would be worse than the wrong message.
 */
export function screenIsLocked(): boolean {
	try {
		const out = execFileSync("ioreg", ["-n", "Root", "-d1", "-a"], { encoding: "utf8", timeout: 5000 });
		const at = out.indexOf("CGSSessionScreenIsLocked");

		return at >= 0 && out.slice(at, at + 120).includes("<true/>");
	} catch {
		return false;
	}
}

export async function assertObservable(driver: Driver, win: WindowRef, app: string): Promise<void> {
	const state = await driver.act({
		kind: "tool",
		name: "get_window_state",
		args: { pid: win.pid, window_id: win.windowId },
	});
	const elements: any[] = JSON.parse(state.structuredJson ?? "{}").elements ?? [];
	const content = elements.filter(isAppContent).length;
	if (content === 0)
		throw new TargetNotObservableError(app, `${elements.length} AX elements, none of them app content`, screenIsLocked());
}

/**
 * Best-effort foregrounding. Every nudge is independently optional: `bring_to_front` is the
 * driver's own, `activate` re-raises an app whose windows are all hidden, and the unminimize
 * pass covers a window the AX tree reports but Chromium has stopped rendering.
 *
 * None of these can move a window between Spaces — macOS refuses background-initiated Space
 * switches, and all three return success while changing nothing (LIMITATIONS §1). They are
 * here for the cases that DO recover: no open window, hidden app, minimized window.
 */
async function foregroundApp(driver: Driver, app: string, pid: number): Promise<void> {
	try {
		await driver.act({ kind: "tool", name: "bring_to_front", args: { pid } });
	} catch {}
	// `launch_app` on a running app is `open -a`: it opens a window when the app has none,
	// which is one of the states that reads as "running but not observable".
	try {
		await driver.act({ kind: "tool", name: "launch_app", args: { name: app } });
	} catch {}
	try {
		execFileSync(
			"osascript",
			[
				"-e",
				`tell application "${app.replace(/"/g, '\\"')}" to activate`,
				"-e",
				`tell application "System Events" to tell process "${app.replace(/"/g, '\\"')}" to set value of attribute "AXMinimized" of every window to false`,
			],
			{ encoding: "utf8", timeout: 5000, stdio: "ignore" },
		);
	} catch {
		// Missing Automation permission, or an app that refuses the AXMinimized write.
	}
	// Chromium rebuilds the AX tree lazily once the window is rendering again.
	await new Promise((r) => setTimeout(r, 2000));
}

/**
 * Quit the app and start it again, then wait for a window.
 *
 * This is the escalation that actually reaches the off-Space case. `foregroundApp` cannot:
 * macOS refuses background-initiated Space switches, so every nudge in it returns success while
 * the window stays on the desktop it is on. But a process that has EXITED has no window to
 * leave anywhere, and the one it opens on next launch opens on the ACTIVE Space. Quitting is
 * therefore not a bigger hammer for the same nail — it is the only move that changes the thing
 * that is wrong.
 *
 * The cost is the app's unsaved state, which is why it is second and not first. In this repo
 * that cost is close to zero: a run is supposed to start from a general state anyway, and the
 * alternative on offer is a refused run.
 *
 * An app that restores its windows onto the Space they were on will defeat even this. That is
 * the case `TargetNotObservableError` is left for.
 */
async function relaunchApp(driver: Driver, app: string): Promise<void> {
	await quitApp(app).catch(() => {});
	try {
		await driver.act({ kind: "tool", name: "launch_app", args: { name: app } });
	} catch {
		// LaunchServices may still consider the app to be terminating. `open -a` again below.
	}
	try {
		execFileSync("open", ["-a", app], { timeout: 10_000, stdio: "ignore" });
	} catch {}
	// A cold Electron launch is slow, and a window that exists but has not painted yet still
	// reports zero app content — which is the very symptom being recovered from.
	await new Promise((r) => setTimeout(r, 6000));
}

/**
 * Observability with two recovery attempts, cheapest first: foreground the app, and failing
 * that quit and relaunch it. Returns the window to use — possibly a NEW one, because an app
 * that was restarted, or that was running with no open windows, gets a fresh window id and the
 * one probed a moment earlier then belongs to nothing.
 */
export async function ensureObservable(driver: Driver, win: WindowRef, app: string): Promise<WindowRef> {
	try {
		await assertObservable(driver, win, app);

		return win;
	} catch (err) {
		if (!(err instanceof TargetNotObservableError)) throw err;
		// Neither recovery below can survive a lock screen — a locked Mac composites no app
		// windows at all — and both are slow: the relaunch alone costs a quit, a cold Electron
		// start and a 6s settle, then fails anyway. Worse, it would discard the app's state to
		// buy nothing. Report the real reason immediately.
		if (screenIsLocked()) throw err;
	}

	console.log(`"${app}" is not observable — foregrounding it and retrying`);
	await foregroundApp(driver, app, win.pid);
	const settled = await recheck(driver, app, win);
	if (settled) return settled;

	console.log(`"${app}" is still not observable — relaunching it so its window opens on the active Space`);
	await relaunchApp(driver, app);
	// findWindow throws if the app came back with no window at all; assertObservable throws the
	// TargetNotObservableError whose message tells the operator what is left to do by hand.
	const fresh = await findWindow(driver, app);
	await assertObservable(driver, fresh, app);
	announceMove(fresh, win);

	return fresh;
}

/** Re-probe after a recovery nudge. Answers the usable window, or nothing if it did not take. */
async function recheck(driver: Driver, app: string, before: WindowRef): Promise<WindowRef | undefined> {
	try {
		const fresh = await findWindow(driver, app);
		await assertObservable(driver, fresh, app);
		announceMove(fresh, before);

		return fresh;
	} catch {
		// Anything other than "still not observable" — the app having no window at all, say — is
		// also worth escalating to a relaunch, so nothing is rethrown here.
		return undefined;
	}
}

function announceMove(fresh: WindowRef, before: WindowRef): void {
	if (fresh.windowId !== before.windowId || fresh.pid !== before.pid)
		console.log(`recovered on a different window: pid=${fresh.pid} window=${fresh.windowId}`);
}

/**
 * `webAreaOnly` restricts the FRONTIER to page content on a web target. Defaulted off so every
 * existing call site — and the whole Mac-app path — is unchanged.
 *
 * Deliberately narrow: it filters `interactive`, not `elementsText`. The model still SEES the
 * omnibox and the tab strip in its element list, because hiding them would make the browser
 * look broken when a page fails to load; it simply cannot spend frontier or dismiss budget on
 * them.
 */
export async function observe(
	driver: Driver,
	win: WindowRef,
	shotName: string,
	opts: { webAreaOnly?: boolean } = {},
): Promise<ObservationBundle> {
	const shotPath = `${OUT}/${shotName}.png`;
	// Delete any same-named frame FIRST. Agent step shots are now namespaced per run
	// (`runs/<stamp>-steps/agent-step-3`), but probe names (`home-probe`) still are not, so
	// a PNG from an earlier run can sit at this exact path. The existsSync guard
	// below exists precisely for the case the driver reports success but writes nothing — and
	// against a stale file it passes, feeding a previous run's frame to the screenshot channel,
	// pixelDelta and visualJudge. Removing it means existsSync tests only what THIS call wrote.
	try {
		fs.rmSync(shotPath, { force: true });
	} catch {}
	const state = await driver.act({
		kind: "tool",
		name: "get_window_state",
		args: { pid: win.pid, window_id: win.windowId, screenshot_out_file: shotPath },
	});
	const structured = JSON.parse(state.structuredJson ?? "{}");
	const elements: any[] = structured.elements ?? [];

	// Recover what the driver's role/label/value projection drops (see src/core/axdom.ts):
	// DOM id/class, tooltip, placeholder. Best-effort — degrades to the bare AX view.
	const dom = axdom.collect(win.pid);

	// The driver reports parent_index but we render a flat list, so "the Save button in
	// the Cursor section" is unrecoverable. Name each element's nearest *named* ancestor
	// so containment survives flattening without printing an indented tree.
	const byIndex = new Map<number, any>(elements.map((e) => [e.element_index, e]));
	const ancestorOf = (e: any): string => {
		let cur = e, hops = 0;
		while (cur?.parent_index !== undefined && hops++ < 12) {
			cur = byIndex.get(cur.parent_index);
			const name = (cur?.label ?? "").toString().replace(/\s+/g, " ");
			if (name && cur.role !== "AXWindow" && cur.role !== "AXWebArea") return name.slice(0, 40);
		}

		return "";
	};

	/**
	 * Is this element part of the PAGE, rather than the browser around it?
	 *
	 * Only consulted for web targets, and only to decide what enters the frontier. On the
	 * DOM/CDP backend the question never arises — `get_browser_state` snapshots the page — but
	 * the AX fallback sees the whole Chrome window, so the tab strip, omnibox, bookmarks bar,
	 * extension icons and Chrome's entire menu bar all arrive as perfectly good AXButtons. Left
	 * in, they dominate the frontier: the pass spends its actions and its dismiss budget on
	 * browser furniture instead of the app it was pointed at.
	 *
	 * The hop bound is `elements.length`, NOT the 12 that `ancestorOf` uses. That difference is
	 * load-bearing: 12 is fine for "which panel is this in", a question whose answer is nearby,
	 * but real page controls nest tens of levels below their AXWebArea, so borrowing the same
	 * bound here would quietly discard genuine page content — the failure would look like an
	 * app with almost no controls.
	 */
	const inWebArea = (e: any): boolean => {
		let cur = e, hops = 0;
		while (cur && hops++ < elements.length) {
			if (cur.role === "AXWebArea") return true;
			if (cur.parent_index === undefined) return false;
			cur = byIndex.get(cur.parent_index);
		}

		return false;
	};

	// Chromium labels every undescribed image with this; it names no control and is pure
	// tokens. Dropping it also lets the DOM class become the element's only name, which is
	// the useful one (`.icon--name--chevronDown`).
	const CHROMIUM_IMAGE_PLACEHOLDER = "To get missing image descriptions";

	/**
	 * Screenshot pixels and AX frames are different spaces — DRIVER_RULES says so, loudly,
	 * because feeding one to the other is a silent mis-click. The window element carries the
	 * window rect in points and the driver reports the screenshot's size in pixels, so a
	 * single ratio converts between them (measured: a 1920x1080 window shot at 1568x882).
	 *
	 * Origin matters as much as scale: AX frames are screen-global, so a window on a display
	 * left of the primary has negative x. Without the window's own origin every box would
	 * land off-image.
	 */
	const winEl = elements.find((e) => e.role === "AXWindow" && (e.frame?.w ?? 0) > 0);
	const shotW = Number(structured.screenshot_width ?? 0);
	const scale = winEl && shotW ? shotW / winEl.frame.w : 0;
	/**
	 * The inputs this transform is derived FROM, kept so the next mis-click is diagnosable
	 * instead of re-litigated.
	 *
	 * Yarn's Library page reports a rect ~43 frame px above the control it names — the same
	 * offset in a run from 2026-07-31 and again in three runs on 2026-08-02, so it is
	 * systematic, not a layout race. x is off by ~7 while y is off by ~43, and a bad SCALE
	 * would skew both in proportion; a y-only shift means the ORIGIN is wrong — the screenshot's
	 * true top edge and `winEl.frame.y` are not the same line.
	 *
	 * That is testable from the numbers below and cannot be tested from the run logs we have,
	 * because none of them recorded these. Whether the driver even reports the screenshot's
	 * HEIGHT decides the fix: if it does, `shotH / scale` vs `winEl.frame.h` measures the
	 * vertical discrepancy directly and the correction needs no constant.
	 */
	const shotH = Number(structured.screenshot_height ?? 0);
	const geometryBasis = {
		window: winEl?.frame ? { x: winEl.frame.x, y: winEl.frame.y, w: winEl.frame.w, h: winEl.frame.h } : undefined,
		shotW,
		shotH,
		scale,
		// Nonzero means the screenshot covers a taller area than the AX window frame claims —
		// on macOS the extra is at the top, which is exactly the sign and shape of this bug.
		heightGapPoints: shotH && scale ? Number((shotH / scale - (winEl?.frame?.h ?? 0)).toFixed(2)) : undefined,
		// Every key the driver actually returned, so the next reader does not have to guess
		// which fields exist. Cheap: a dozen short strings, once per observation.
		structuredKeys: Object.keys(structured ?? {}).sort(),
	};
	const toPixels = (f: any): { x: number; y: number; w: number; h: number } =>
		scale && f
			? {
					x: Math.round((f.x - winEl.frame.x) * scale),
					y: Math.round((f.y - winEl.frame.y) * scale),
					w: Math.round(f.w * scale),
					h: Math.round(f.h * scale),
				}
			: { x: 0, y: 0, w: 0, h: 0 };

	const lines: string[] = [];
	const haystackParts: string[] = [];
	const interactive: InteractiveElement[] = [];
	const frames = new Map<string, { x: number; y: number }>();
	for (const e of elements) {
		let label = (e.label ?? "").toString().replace(/\s+/g, " ");
		if (label.startsWith(CHROMIUM_IMAGE_PLACEHOLDER)) label = "";
		const value = (e.value ?? "").toString().replace(/\s+/g, " ");
		if (label) haystackParts.push(label);
		if (value) haystackParts.push(value);
		const descriptor = axdom.lookup(dom, e.frame);
		const interesting = label || value || descriptor || INTERACTIVE_ROLES.includes(e.role);
		if (!interesting) continue;
		const f = e.frame ? ` @(${e.frame.x},${e.frame.y} ${e.frame.w}x${e.frame.h})` : "";
		const val = value && value !== label ? ` value="${value.slice(0, 80)}"` : "";
		// Whatever descriptor is RENDERED must be greppable: the model quotes evidence from
		// what it was shown, and a descriptor beside a labelled control used to reach
		// elementsText while staying out of the haystack — verification then failed on text
		// the model was literally given.
		if (descriptor) haystackParts.push(descriptor);
		const dsc = descriptor ? ` ${descriptor}` : "";
		// An icon inside a button repeats the button's name; the containment only informs
		// when it names a DIFFERENT surface than the element's own label. Compare on the
		// truncated forms actually rendered, or near-duplicates slip through.
		// Record position under whatever names this element. A name colliding across
		// siblings (several "Delete" buttons) makes the entry ambiguous, so drop both
		// rather than pick one — the channel needs identity it can trust.
		const key = label || descriptor;
		if (key && e.frame) {
			if (frames.has(key)) frames.set(key, { x: NaN, y: NaN });
			else frames.set(key, { x: e.frame.x, y: e.frame.y });
		}
		const parent = ancestorOf(e);
		// A disabled control cannot be actuated, so listing it in the frontier would leave an
		// entry nothing can ever clear. It re-enters the moment the app enables it.
		if (INTERACTIVE_ROLES.includes(e.role) && e.enabled !== false && (!opts.webAreaOnly || inWebArea(e)))
			interactive.push({
				handle: e.element_index,
				role: e.role,
				name: key ?? "",
				namedBy: label ? "ax" : descriptor ? "dom" : "none",
				surface: parent,
				value,
				...toPixels(e.frame),
			});
		const inWhat = parent && !label.slice(0, 40).startsWith(parent) ? ` in="${parent}"` : "";
		lines.push(`[${e.element_index}] ${e.role} "${label.slice(0, 80)}"${val}${dsc}${inWhat}${f}${e.selected ? " SELECTED" : ""}${e.enabled === false ? " DISABLED" : ""}`);
	}

	const title = structured.window?.title ?? "";

	// The driver reports success but writes no file when the window isn't composited.
	if (!fs.existsSync(shotPath))
		throw new TargetNotObservableError(title || "target", "the driver could not capture the window");

	return {
		elementsText: lines.join("\n"),
		haystack: `${title}\n${haystackParts.join("\n")}`.toLowerCase(),
		screenshotB64: fs.readFileSync(shotPath).toString("base64"),
		title,
		interactive,
		appContent: elements.filter(isAppContent).length,
		domEnriched: dom.byFrame.size,
		domUnavailable: dom.unavailable,
		frames,
		geometryBasis,
	};
}

export function observationBlocks(obs: ObservationBundle, vision = true, ax = true): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
	// `ax: false` is the vision-only measurement arm: the MODEL loses the element list, while
	// the harness keeps the full bundle — verify(), the mutation journal and teardown all still
	// read it. The isolation is of what the model perceives, not of what the run can prove.
	const text: Anthropic.TextBlockParam = {
		type: "text",
		text: ax ? `Window title: "${obs.title}"\nElements:\n${obs.elementsText}` : `Window title: "${obs.title}"`,
	};
	// An empty frame degrades the observation rather than ending the run on backends where
	// the snapshot channel is primary (cdp). Sending it anyway would
	// put an empty base64 image block on the wire and the API would reject the whole request —
	// turning a cosmetic gap into exactly the run-ending failure the degradation avoided.
	if (!vision || !obs.screenshotB64) return [text];

	return [text, { type: "image", source: { type: "base64", media_type: "image/png", data: obs.screenshotB64 } }];
}

/**
 * Fill the window to the display it is ALREADY on, for recording.
 *
 * The previous staging set an absolute position of {0, 38} — the MAIN display's top-left
 * in global coordinates — so it dragged the window off whatever monitor it was on, and,
 * because macOS demotes a fullscreen window the moment its position is set, it also
 * kicked the app out of fullscreen. Both were visible in a recorded run.
 *
 * Now: find the screen containing the window's centre and size the window to that
 * screen's visibleFrame (already excludes menu bar and Dock). Native fullscreen is left
 * untouched — it is already the frame we want, and demoting it is the bug above.
 *
 * NOTE on 1x displays: the old code justified relocation with "the driver composites
 * window snapshots incorrectly on 1x displays". Measured 2026-07-29 against Yarn
 * fullscreen on a 1920x1080 1x panel, the capture came back clean (1568x882, no bands,
 * no offset), so that claim does not hold generally and does not justify moving a user's
 * window between monitors. We warn instead; assembleVideo's size-majority and
 * black-band gates already drop malformed frames if it does happen.
 */
export interface StageResult {
	staged: boolean;
	detail: string;
	/**
	 * Where the window was put, and at what backing scale.
	 *
	 * Absent on the fullscreen path: System Events reports no windows for a natively-fullscreen
	 * app, which is how that state is detected, so there is nothing to measure. WindowRef.bounds
	 * is the geometry source there.
	 */
	geometry?: { x: number; y: number; w: number; h: number; scale: number };
}

export function stageWindowForRecording(app: string): StageResult {
	const script = `
ObjC.import("AppKit");
const app = "${app.replace(/"/g, '\\"')}";
const se = Application("System Events");
const procs = se.processes.whose({name: app});
if (procs.length === 0) throw new Error("process not found");
const proc = procs[0];

// A natively-fullscreen window is reported by System Events as NO windows at all
// (windows.length === 0, and windows[0] throws "Invalid index"), so the absence of
// windows is itself the fullscreen signal — check it before touching windows[0].
if (proc.windows.length === 0) JSON.stringify({action: "left-fullscreen", reason: "no windows listed (native fullscreen)"});
else {
const win = proc.windows[0];

// A fullscreen window already fills its display; touching position would demote it.
let fullscreen = false;
try { fullscreen = win.attributes["AXFullScreen"].value(); } catch (e) {}
if (fullscreen) JSON.stringify({action: "left-fullscreen", reason: "AXFullScreen attribute"});
else {
  const p = win.position(), s = win.size();
  const cx = p[0] + s[0] / 2, cy = p[1] + s[1] / 2;
  const screens = $.NSScreen.screens;

  // AppKit y-axis is bottom-up with origin on the main screen; AX is top-down. Convert
  // via the main screen's height so "which screen holds this window" is computed in one
  // coordinate space.
  const mainH = screens.objectAtIndex(0).frame.size.height;
  let best = null, bestScale = 2;
  for (let i = 0; i < screens.count; i++) {
    const sc = screens.objectAtIndex(i), f = sc.frame, v = sc.visibleFrame;
    const axTop = mainH - (f.origin.y + f.size.height);
    if (cx >= f.origin.x && cx < f.origin.x + f.size.width && cy >= axTop && cy < axTop + f.size.height) {
      best = {x: v.origin.x, y: mainH - (v.origin.y + v.size.height), w: v.size.width, h: v.size.height};
      bestScale = sc.backingScaleFactor;
    }
  }
  if (!best) {
    const v = screens.objectAtIndex(0).visibleFrame;
    best = {x: v.origin.x, y: mainH - (v.origin.y + v.size.height), w: v.size.width, h: v.size.height};
    bestScale = screens.objectAtIndex(0).backingScaleFactor;
  }

  win.position = [best.x, best.y];
  win.size = [best.w, best.h];
  JSON.stringify({action: "filled", scale: bestScale, frame: best});
}
}
`;
	try {
		// The script drives System Events AX calls, which block indefinitely against a
		// beachballing app (the hang class the src/core/axdom.ts rationale documents). Without a
		// deadline the run hangs before its first action with nothing on the console; with
		// one, the catch below degrades to staged:false and the run proceeds unstaged.
		const out = execFileSync("osascript", ["-l", "JavaScript", "-e", script], { encoding: "utf8", timeout: 10_000 }).trim();
		const r = JSON.parse(out);
		if (r.action === "left-fullscreen")
			return { staged: true, detail: `window is native-fullscreen — left as is (${r.reason})` };

		const lowDpi = r.scale < 2 ? " (1x display — check frames if the video looks off)" : "";

		return {
			staged: true,
			detail: `filled its current display @ ${r.frame.w}x${r.frame.h}${lowDpi}`,
			geometry: { x: r.frame.x, y: r.frame.y, w: r.frame.w, h: r.frame.h, scale: r.scale },
		};
	} catch (err: any) {
		// osascript writes the useful diagnostic to stderr; err.message is just the echoed
		// command, which reported "Command failed: osascript -l JavaScript -e" and hid the
		// actual cause ("Invalid index" from windows[0] on a fullscreen app).
		const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
		const detail = stderr || (err instanceof Error ? err.message.split("\n")[0] : String(err));

		return { staged: false, detail: detail.split("\n")[0].slice(0, 200) };
	}
}
