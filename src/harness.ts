import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { quitApp } from "./appctl.js";
import * as axdom from "./axdom.js";
import { Driver } from "./driver.js";
import { appmapsDir, appSlug, outDir } from "./paths.js";
import type { ActionRequest, AppMap, AppMapEdge, AppMapHome, AppMapNode, Expectation, ScopeAmbiguity, StepRecord, SurfaceScope } from "./types.js";

/**
 * Snapshot at load, unlike the accessors in paths.ts: this is a CLI process whose data root
 * is fixed before it starts (by `run`, or by the LaunchAgent plist), and dozens of call
 * sites interpolate it as a plain string.
 */
export const OUT = outDir();

/**
 * What agent.ts exits with when the app is not at its declared home state.
 *
 * A CROSS-MACHINE contract, like the codes in runner/ctl.ts: the agent exits with it on a colo
 * Mac and the client on the laptop reads the number to decide whether to offer a sign-in. Two
 * independent copies of the literal is a protocol that drifts the first time one of them moves,
 * so there is one and both ends import it.
 */
export const UNREADY_EXIT = 3;

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
 * they have operated versus merely looked at (see the frontier ledger in src/explore.ts).
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
	/** Nearest named ancestor: which panel or menu this sits in. "" at top level. */
	surface: string;
	/**
	 * The control's current value — what a combobox reads, what a text field holds. "" when
	 * it has none, or when it duplicates `name` (a button labelled by its own value).
	 *
	 * Rendered into `elementsText` for the model long before it was carried here. Pulling it
	 * into the struct is what lets code diff two observations and say which control CHANGED,
	 * rather than only which one was clicked — the raw material for the mutation journal in
	 * src/journal.ts, and the difference between restoring a setting and guessing at it.
	 */
	value: string;
	/**
	 * Bounds in SCREENSHOT PIXELS — the space coordinate actions consume, NOT the logical
	 * points AX reports and `frames` below carries. Converted here, once, so a click point
	 * can be tested against a control's box without every caller re-deriving the display
	 * scale. All zero when the scale could not be derived (no AXWindow element, DOM backend),
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

// Re-exported, not defined here: the runner needs it and must not import this module, which
// loads the Anthropic SDK and the driver. Every existing call site keeps working.
export { appSlug };

/**
 * The key every artifact of one run shares: `out/runs/<key>.json`, `out/recording/<key>/`,
 * and — when the run was dispatched rather than started by hand — `out/jobs/<key>/`.
 *
 * `RUN_STAMP` exists so a dispatcher can decide the key BEFORE the child exists. Without it
 * the runner would have to guess which log a spawned process went on to write, and guessing
 * by "newest file in out/runs" is wrong the moment two runs land in the same second or a
 * previous run failed before writing anything. The child still owns the format; the caller
 * only pre-commits to a value.
 */
export function runKey(prefix: string, app: string): string {
	const override = process.env.RUN_STAMP?.trim();
	if (override) return override;

	return mintRunKey(prefix, app);
}

/**
 * The same key, minted rather than inherited. Separate from `runKey` because the runner is a
 * long-lived process that mints an id per job and then hands it to the child as `RUN_STAMP`:
 * if it ever read that variable out of its own environment — a launchd plist, a shell that
 * exported it once — every job it started would share one id, one job directory and one log.
 */
export function mintRunKey(prefix: string, app: string): string {
	return `${prefix}${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${appSlug(app)}`;
}

/**
 * Make SIGINT and SIGTERM a clean stop instead of an instant kill, and report whether one
 * has arrived.
 *
 * Node's default action for both is to terminate the process on the spot, so every `finally`
 * in the script is skipped: the driver session stays open until its own 300-second lifetime
 * expires, and the run writes no log at all. That is not hypothetical — `runnerctl stop`
 * signals the whole process group, so under the default a stopped run would be both invisible
 * to the gallery and a hazard to whichever job started next on that Mac.
 *
 * The handler only sets a flag. The caller reads it between actions and leaves through its
 * ordinary cleanup path, which is what keeps the run log. `graceMs` covers the case the flag
 * cannot: a signal landing in the middle of a model call, where nothing will read it for
 * several seconds. At that deadline the session is closed directly and the process exits —
 * the value sits below the runner's own SIGINT→SIGKILL interval so that this, and not
 * SIGKILL, is what ends the run.
 */
export function onInterrupt(closeDriver: () => Promise<void>, graceMs = 8000): () => boolean {
	let interrupted = false;

	for (const sig of ["SIGINT", "SIGTERM"] as const) {
		process.on(sig, () => {
			// A second signal is an operator saying the first one did not work. Honour it.
			if (interrupted) process.exit(130);
			interrupted = true;
			console.log(`\n=== ${sig} received — finishing the current action and stopping ===`);
			setTimeout(() => {
				console.log("=== cleanup did not finish in time; closing the driver session ===");
				closeDriver().finally(() => process.exit(130));
			}, graceMs).unref();
		});
	}

	return () => interrupted;
}

/**
 * The OpenRouter default is an OpenAI model, reached through OpenRouter's Anthropic-format
 * `/api/v1/messages` endpoint — verified to carry tool use, streaming, base64 screenshots and
 * `thinking` blocks unchanged, so the SDK and both loops need no restructuring. `sol` rather
 * than `sol-pro`: same weights and price, but pro's `reasoning.mode=pro` buys longer thinking
 * per turn, and these loops are long and sequential — a 96-action pass pays that cost 96
 * times. `AGENT_MODEL` overrides, including to `openai/gpt-5.6-sol-pro` or any `anthropic/*` id.
 *
 * One measured consequence: OpenRouter returns a null `cache_creation_input_tokens` for OpenAI
 * models, so the `cache_control` blocks the explore/agent prompts carry are accepted and then
 * ignored. Nothing breaks; the per-chapter system prompt is simply billed in full each time.
 */
export function makeClient(): { client: Anthropic; model: string } {
	const openrouter = process.env.OPENROUTER_API_KEY;
	const model = process.env.AGENT_MODEL ?? (openrouter ? "openai/gpt-5.6-sol" : "claude-opus-5");
	const client = openrouter
		? new Anthropic({ baseURL: "https://openrouter.ai/api", authToken: openrouter })
		: new Anthropic();

	return { client, model };
}

export async function findWindow(driver: Driver, app: string): Promise<WindowRef> {
	const windows = await driver.act({ kind: "tool", name: "list_windows", args: {} });
	const parsed = JSON.parse(windows.structuredJson ?? "{}");
	const area = (w: any) => (w.bounds?.width ?? 0) * (w.bounds?.height ?? 0);
	const win = (parsed.windows ?? [])
		.filter((w: any) => w.app_name === app && area(w) > 50_000) // skip tooltips/panels
		.sort((a: any, b: any) => (b.title ? 1 : 0) - (a.title ? 1 : 0) || area(b) - area(a))[0];
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
						`relaunching it helped. The screen is unlocked, so most likely it is on an inactive\n` +
						`macOS Space that it keeps restoring itself onto — another app is fullscreen, or the\n` +
						`window belongs to a different desktop. Bring the app onto the active Space (click it\n` +
						`in the Dock or ⌘-Tab to it), then re-run.`,
		);
		this.name = "TargetNotObservableError";
	}
}

const isAppContent = (e: any) => !String(e.role ?? "").startsWith("AXMenu");

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
	const state = await driver.act({
		kind: "tool",
		name: "get_window_state",
		args: { pid: win.pid, window_id: win.windowId, screenshot_out_file: shotPath },
	});
	const structured = JSON.parse(state.structuredJson ?? "{}");
	const elements: any[] = structured.elements ?? [];

	// Recover what the driver's role/label/value projection drops (see src/axdom.ts):
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
		// The DOM descriptor is the only naming an unlabeled control has, so it goes in
		// the haystack too — verification can then check for it like any other evidence.
		if (descriptor && !label) haystackParts.push(descriptor);
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
			interactive.push({ handle: e.element_index, role: e.role, name: key ?? "", surface: parent, value: val ? value : "", ...toPixels(e.frame) });
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
	};
}

/**
 * Did any named element move by roughly the distance a drag asked for?
 *
 * The third verification channel, and on a canvas the only one that is both structural and
 * quantitative. It exists because a drag on painted content is not necessarily invisible to
 * the accessibility tree: the dragged thing has no element, but content around it does, and
 * when the app re-lays-out that content its elements MOVE. Observed on one timeline — a
 * button's frame went -617 -> -540 on a drag, and back to -617 on undo.
 *
 * Stronger than the pixel channel, which only reports that some region changed colour: this
 * names WHICH element moved and by HOW FAR, and demands the distance match what was asked
 * for. Weaker than text, which says what a thing IS rather than where it sits.
 *
 * Nothing here is app-specific — it compares two observations' geometry and knows nothing
 * about what the elements are. The delta is a RATIO test rather than an equality one because
 * the two spaces differ (frames are logical points, drags are screenshot pixels) and the
 * scale factor is a display property; requiring only that the movement be proportional and
 * in the right direction avoids baking a display's scale into the harness.
 */
export function framesShifted(
	before: Map<string, { x: number; y: number }>,
	after: Map<string, { x: number; y: number }>,
	dragDx: number,
	dragDy: number,
): { shifted: boolean; movers: Array<{ name: string; dx: number; dy: number }> } {
	// Below this a drag is not asking for meaningful movement, and every ratio blows up.
	if (Math.abs(dragDx) < 8 && Math.abs(dragDy) < 8) return { shifted: false, movers: [] };

	const movers: Array<{ name: string; dx: number; dy: number }> = [];
	for (const [name, a] of before) {
		const b = after.get(name);
		// NaN marks a name that collided across siblings, so identity is not established.
		if (!b || Number.isNaN(a.x) || Number.isNaN(b.x)) continue;
		const dx = b.x - a.x, dy = b.y - a.y;
		if (dx === 0 && dy === 0) continue;
		// Proportional to the request, in the same direction, within a wide band: a real
		// re-layout moves content by the drag delta scaled to logical points, while an
		// unrelated repaint or a scroll moves things by an unrelated amount.
		const wanted = Math.hypot(dragDx, dragDy), got = Math.hypot(dx, dy);
		const sameDirection = dragDx * dx + dragDy * dy > 0;
		const ratio = got / wanted;
		if (sameDirection && ratio > 0.5 && ratio < 1.6) movers.push({ name, dx, dy });
	}

	return { shifted: movers.length > 0, movers };
}

/**
 * The frontier ledger: which controls a pass has SEEN versus which it has OPERATED.
 *
 * Coverage used to be the model's own answer to "did you cover the app?", reached from
 * inside a transcript that by construction contains only the surfaces it visited. This is
 * the mechanical replacement — every observation already lists the app's interactive
 * elements, so the difference between the two sets is computable and needs no self-report.
 *
 * Frontier = seen − actuated − dismissed. It is a moving target rather than a fixed
 * denominator: a closed popover contributes zero elements, so opening one surface can add
 * twenty entries. That is the point. The pass ends when nothing is left, not when a step
 * budget runs out.
 *
 * Nothing here knows anything about any particular app.
 */
export interface FrontierLedger {
	seen: Map<string, InteractiveElement>;
	actuated: Set<string>;
	/** key -> the reason given for skipping it. */
	dismissed: Map<string, string>;
}

export const newFrontier = (): FrontierLedger => ({ seen: new Map(), actuated: new Set(), dismissed: new Map() });

/**
 * Identity of a control across observations. Deliberately NOT the addressing handle, which
 * is a walk order that renumbers on every redraw. Controls sharing a role, label and
 * containing surface collapse into one entry — an under-count of distinct controls, taken
 * on purpose so the frontier converges instead of regrowing whenever the tree reshuffles.
 */
export const frontierKey = (e: { role: string; name: string; surface: string }): string => `${e.role}|${e.name}|${e.surface}`;

export function frontierIngest(ledger: FrontierLedger, obs: ObservationBundle): void {
	// Overwrite rather than skip: geometry and handle must track the LATEST observation,
	// since that is the one any credit will be resolved against.
	for (const e of obs.interactive) ledger.seen.set(frontierKey(e), e);
}

/**
 * Mark whatever an action operated as actuated, resolved against the observation the model
 * was looking at when it chose the action. Returns the keys credited.
 */
export function frontierCredit(ledger: FrontierLedger, action: any, before: ObservationBundle): string[] {
	const hits = new Set<string>();
	const handle = action?.element_index ?? action?.ref;
	if (handle !== undefined && handle !== null)
		for (const e of before.interactive) if (e.handle === handle) hits.add(frontierKey(e));

	// Coordinate actions name no element, so credit whatever box the point lands in — needed
	// because some controls only respond to pixel clicks, and painted surfaces have no
	// element at all. Smallest containing box only: boxes nest, and crediting every
	// container under the point would let one click drain a panel's worth of entries it
	// never touched.
	for (const [x, y] of [
		[action?.x, action?.y],
		[action?.from_x, action?.from_y],
	]) {
		if (typeof x !== "number" || typeof y !== "number") continue;
		let best: InteractiveElement | undefined;
		for (const e of before.interactive) {
			if (e.w <= 0 || e.h <= 0) continue; // no geometry -> never matches, never wrongly credits
			if (x < e.x || x >= e.x + e.w || y < e.y || y >= e.y + e.h) continue;
			if (!best || e.w * e.h < best.w * best.h) best = e;
		}
		if (best) hits.add(frontierKey(best));
	}
	for (const k of hits) ledger.actuated.add(k);

	return [...hits];
}

export function frontierRemaining(ledger: FrontierLedger): InteractiveElement[] {
	return [...ledger.seen]
		.filter(([k]) => !ledger.actuated.has(k) && !ledger.dismissed.has(k))
		.map(([, e]) => e)
		.sort((a, b) => a.surface.localeCompare(b.surface) || a.name.localeCompare(b.name));
}

/**
 * Deliberately skip frontier entries, by name and/or by whole surface.
 *
 * Without this the frontier can never empty and every run burns its full wall-clock cap:
 * most unactuated controls are content, not navigation — transcript chunks, list rows, the
 * eight hundredth item in a library. The escape has to exist, but it is recorded and
 * reported rather than silent, so "we skipped 240 controls, here is why" survives into the
 * artifact instead of looking like coverage.
 */
/**
 * Round-trip the summary's name for the unnamed surface.
 *
 * Top-level controls have `surface: ""`, which the listing has to render as something
 * printable — and the model then quotes that placeholder straight back. Observed: four
 * consecutive dismiss calls for "<top level>", "top level" and the HTML-escaped
 * "&lt;top level&gt;", each matching nothing and each costing a turn, while the frontier
 * sat unchanged. Whatever the listing prints must resolve back to the empty surface.
 */
const normSurface = (s: string): string =>
	s
		.trim()
		.toLowerCase()
		// Every spelling of a bracket that can reach here, not just the two that were observed.
		// The listing prints `<top level>`; whatever escapes it on the way through the model's
		// context decides the form it comes back in, and named entities are only the first one
		// we happened to see. Decimal (`&#60;`), hex (`&#x3c;`) and the doubly-escaped
		// `&amp;lt;` an escaper applied twice produces are the same string to a reader and were
		// four different non-matches to this function.
		.replace(/&(?:amp;)*(?:lt|gt|#0*6[02]|#x0*3[ce]);|[<>]/g, "")
		// After the brackets go, not before: `< top level >` leaves inner padding that would
		// otherwise stop the placeholder below from anchoring.
		.trim()
		.replace(/^(top[- ]?level|none|root|unnamed)$/, "");

/**
 * What a dismiss WOULD clear, without clearing it. Separate from frontierDismiss so the
 * caller can size a sweep before committing to it: one call that retires a hundred
 * heterogeneous controls under a single sentence is how a pass reaches "frontier-empty"
 * without having looked at much, and the count is the only signal available beforehand.
 */
export function frontierMatches(
	ledger: FrontierLedger,
	opts: { names?: string[]; surface?: string },
): InteractiveElement[] {
	if (!opts.names?.length && opts.surface === undefined) throw new Error("dismiss needs names, a surface, or both");
	const norm = (s: string) => s.trim().toLowerCase();
	const wanted = opts.names?.map(norm);

	return frontierRemaining(ledger).filter(
		(e) =>
			(opts.surface === undefined || normSurface(e.surface) === normSurface(opts.surface)) &&
			(!wanted || wanted.includes(norm(e.name))),
	);
}

/**
 * True when a surface name does not identify a real panel — the top-level scatter, where a
 * bulk dismissal is a sweep across unrelated controls rather than "this list is repetitive".
 */
export const isVagueSurface = (surface?: string): boolean => surface === undefined || normSurface(surface) === "";

/**
 * Roles that can name a surface in a semantic snapshot: ARIA landmarks and the containers a
 * page actually organises itself with.
 *
 * `main`, `document` and the web area are deliberately ABSENT, and that omission is the whole
 * point. If `main` counted, `isVagueSurface("main")` would be false, so a single dismiss
 * naming it would retire the entire page in one call — bypassing EXPLORE_DISMISS_CAP by a
 * different route, which is precisely the sweep the cap was added to stop.
 */
const LANDMARK_ROLES = new Set([
	"navigation",
	"banner",
	"complementary",
	"contentinfo",
	"form",
	"search",
	"region",
	"dialog",
	"alertdialog",
	"menu",
	"menubar",
	"toolbar",
	"tablist",
	"listbox",
	"grid",
	"table",
	"article",
	"group",
]);

/** `"x,y,w,h"` in whatever punctuation the driver used, or undefined if it is unreadable. */
function parseFrame(frame: string | undefined): { x: number; y: number; w: number; h: number } | undefined {
	const n = String(frame ?? "").match(/-?\d+(?:\.\d+)?/g);
	if (!n || n.length < 4) return undefined;
	const [x, y, w, h] = n.slice(0, 4).map(Number);

	return w > 0 && h > 0 ? { x, y, w, h } : undefined;
}

/**
 * Name the surface each semantic ref sits in, so the DOM backend's frontier can be grouped and
 * dismissed by panel the way the AX one is.
 *
 * Why this is needed at all: `DomBackend.observe` reports every ref with `surface: ""`, which
 * has two costs. `frontierKey` collapses distinct controls that share a role and a name, and —
 * worse — `isVagueSurface` is then ALWAYS true, so the un-named-surface dismiss cap of 20
 * binds on every bulk dismissal. A web page has far more controls than an Electron sidebar, so
 * a pass would crawl, retiring twenty at a time with a fresh justification for each batch.
 *
 * Semantic refs carry no parent pointer, so containment is geometric: the smallest landmark
 * whose box encloses the control wins. Computed for the whole observation at once rather than
 * per control, because the naive form is O(n²) on a page with hundreds of refs.
 *
 * Degrades to `""` — today's behaviour — for anything it cannot place. The `frame` string's
 * exact format is typed only as `string` in dom.ts and is unverified against a live driver, so
 * a wrong guess here makes the feature inert rather than wrong.
 */
export function refSurfaces(
	refs: Array<{ ref: string; role: string; name?: string | null; frame?: string }>,
): Map<string, string> {
	const landmarks = refs
		.filter((r) => LANDMARK_ROLES.has(r.role?.toLowerCase?.() ?? ""))
		.map((r) => ({ ref: r.ref, name: (r.name ?? "").trim() || r.role, box: parseFrame(r.frame) }))
		.filter((l): l is { ref: string; name: string; box: { x: number; y: number; w: number; h: number } } => !!l.box)
		.sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h);

	const out = new Map<string, string>();
	for (const r of refs) {
		const box = parseFrame(r.frame);
		if (!box) continue;
		const cx = box.x + box.w / 2;
		const cy = box.y + box.h / 2;
		// Smallest-first, so the first enclosing landmark is the innermost one.
		// Compared by REF, not by box identity: parseFrame returns a fresh object per call, so
		// an object comparison never matches and a landmark would become its own surface.
		const hit = landmarks.find(
			(l) => l.ref !== r.ref && cx >= l.box.x && cx < l.box.x + l.box.w && cy >= l.box.y && cy < l.box.y + l.box.h,
		);
		if (hit) out.set(r.ref, hit.name.slice(0, 40));
	}

	return out;
}


export function frontierDismiss(
	ledger: FrontierLedger,
	opts: { names?: string[]; surface?: string; reason: string },
): InteractiveElement[] {
	const gone = frontierMatches(ledger, opts);
	for (const e of gone) ledger.dismissed.set(frontierKey(e), opts.reason);

	return gone;
}

/** The frontier as the model sees it: grouped by surface, capped, unnamed entries counted. */
export function frontierSummary(ledger: FrontierLedger, maxSurfaces = 12, maxPerSurface = 14): string {
	const rest = frontierRemaining(ledger);
	if (rest.length === 0) return "The frontier is empty: every interactive control seen so far has been operated or dismissed.";

	const bySurface = new Map<string, InteractiveElement[]>();
	for (const e of rest) bySurface.set(e.surface, [...(bySurface.get(e.surface) ?? []), e]);
	// Biggest groups first: they are where the unexplored bulk is.
	const groups = [...bySurface].sort((a, b) => b[1].length - a[1].length);
	const lines = groups.slice(0, maxSurfaces).map(([surface, items]) => {
		const named = items.filter((e) => e.name);
		const anon = items.length - named.length;
		const shown = named.slice(0, maxPerSurface).map((e) => `"${e.name}"`).join(", ");
		const more = named.length > maxPerSurface ? `, +${named.length - maxPerSurface} more` : "";
		const unnamed = anon ? `${named.length ? "; " : ""}${anon} unnamed (dismiss by surface, or click them to find out)` : "";

		return `  in ${surface ? `"${surface}"` : "<top level>"} (${items.length}): ${shown}${more}${unnamed}`;
	});
	const hidden = groups.length > maxSurfaces ? `\n  ...and ${groups.length - maxSurfaces} more surface(s).` : "";

	return `${rest.length} control(s) seen but never operated, across ${groups.length} surface(s):\n${lines.join("\n")}${hidden}`;
}

/**
 * Fold a batch of nodes/edges into the accumulating graph, last write winning.
 *
 * Overwrite rather than merge-fields because a later sighting is a better one: the pass
 * records a surface when it first sees the link to it, then again with real detail once
 * inside. Nodes key on `id` and edges on the whole triple, so re-recording is idempotent
 * and the model can re-emit freely rather than having to remember what it already sent.
 * Returns how many entries were written, for the tool_result.
 */
export function mergeGraph(
	nodes: Map<string, AppMapNode>,
	edges: Map<string, AppMapEdge>,
	g: { nodes?: AppMapNode[]; edges?: AppMapEdge[] },
): number {
	let n = 0;
	for (const node of g.nodes ?? []) if (node?.id) (nodes.set(node.id, node), n++);
	for (const e of g.edges ?? []) if (e?.from && e?.to) (edges.set(`${e.from}|${e.to}|${e.action}`, e), n++);

	return n;
}

/**
 * The upstream provider OpenRouter blamed for a failed request, if it named one.
 *
 * OpenRouter is a router: one model id fans out to several hosts, and a request that fails
 * because ONE of them is broken carries that host's name in `error.metadata.provider_name`.
 * Reading it is what makes the retry different from the attempt that just failed — see
 * providerRouting below.
 *
 * Both shapes are handled because both were observed from the same incident: the SDK attaches
 * the parsed body as `.error` on an APIError, but a failure that arrives wrapped (or from
 * `.stream()`) only has the JSON inside the message string.
 */
export function failedProvider(err: unknown): string | undefined {
	const body = (err as { error?: { error?: { metadata?: { provider_name?: unknown } } } })?.error;
	const named = body?.error?.metadata?.provider_name;
	if (typeof named === "string" && named.trim()) return named.trim();

	const m = /"provider_name"\s*:\s*"([^"]+)"/.exec(`${(err as Error)?.message ?? ""}`);

	return m?.[1]?.trim() || undefined;
}

/**
 * Tell OpenRouter to route around providers this run has already watched fail.
 *
 * The bug this closes: a run died with five consecutive 404 DeploymentNotFound while the same
 * key on the same host got a 200 for the same model seconds later. OpenRouter was routing some
 * requests to a broken Azure-backed provider, and the retry loop — which backed off correctly —
 * re-asked the identical route each time, so one bad provider consumed the whole allowance.
 * Backoff cannot help when the fault is not load.
 *
 * Empty when nothing has failed, so the normal request is byte-for-byte what it was and
 * OpenRouter's own ranking is untouched. Non-OpenRouter clients ignore the field.
 */
export function providerRouting(ignore: Iterable<string>): Record<string, unknown> {
	const list = [...new Set(ignore)];

	return list.length ? { provider: { ignore: list } } : {};
}

/**
 * Is this error worth trying again, or is retrying it just a slower failure?
 *
 * Transient here means the request never got a verdict: the connection dropped, the body
 * stalled, the server was busy. A 400 or an auth failure will fail identically forever and
 * must surface immediately.
 *
 * Matching on message text as well as status because a mid-stream failure arrives wrapped —
 * the observed one was `AnthropicError: terminated` with a `BodyTimeoutError` cause and no
 * status at all, since the headers had already come back 200.
 *
 * A provider-attributed error is transient WHATEVER its status. That is not a general claim
 * about 404s — it is specific to a router: the code came from one upstream host, the next
 * attempt can be sent somewhere else (providerRouting makes sure it is), and "this provider
 * has no such deployment" says nothing about the others.
 */
export function isTransientApiError(err: unknown): boolean {
	if (failedProvider(err)) return true;

	const status = (err as { status?: number })?.status;
	if (typeof status === "number") return status === 408 || status === 429 || status >= 500;
	const text = `${(err as Error)?.message ?? ""} ${String((err as { cause?: unknown })?.cause ?? "")}`.toLowerCase();

	return /terminated|timeout|econnreset|econnrefused|enotfound|socket hang up|network|overloaded|fetch failed/.test(text);
}

/**
 * Retry a model call through transient network failures.
 *
 * Added after a 12-hour unattended pass died two minutes in on a single `BodyTimeoutError`
 * mid-stream, having recorded nothing and so leaving nothing to salvage. The SDK's own retries
 * do not cover a stream that fails after headers, which is exactly the failure long
 * generations are most exposed to.
 *
 * Delays are a parameter rather than a constant so tests do not have to sleep through them.
 */
export async function retryTransient<T>(
	run: () => Promise<T>,
	opts: { delaysMs?: number[]; onRetry?: (attempt: number, err: unknown) => void } = {},
): Promise<T> {
	const delays = opts.delaysMs ?? [2000, 8000, 20000];
	for (let attempt = 0; ; attempt++) {
		try {
			return await run();
		} catch (err) {
			if (attempt >= delays.length || !isTransientApiError(err)) throw err;
			opts.onRetry?.(attempt + 1, err);
			await new Promise((r) => setTimeout(r, delays[attempt]));
		}
	}
}

/**
 * Recover graph entries the model serialised into a STRING argument instead of the structured
 * `nodes`/`edges` arrays.
 *
 * Observed live on 2026-07-30: a `record` call arrives with its finding text ending in a
 * literal `<parameter name="nodes">[{"id":"editor/captions-toolbar",...}]` — tool-call markup
 * emitted as prose. The payload is well-formed JSON, so the knowledge is intact; only its
 * envelope is wrong, and without this it lands in the appmap as narrative rather than as
 * queryable nodes. 15 of 28 findings in that run leaked this way, carrying 73 entries.
 *
 * That matters beyond tidiness: `findScopeAmbiguities()` reads nodes, so a scope pair recorded
 * only as prose produces no warning for the task agent — the exact failure the graph exists to
 * prevent.
 *
 * Deliberately permissive about the closing tag (a truncated generation often has none) and
 * silent on unparseable blocks: this is salvage, and a half-written array should cost its own
 * entries, not the whole finding. Returns the cleaned text so the leaked markup does not also
 * end up quoted in the prose map.
 */
export function recoverLeakedGraph(text: string): {
	cleaned: string;
	nodes: AppMapNode[];
	edges: AppMapEdge[];
} {
	const nodes: AppMapNode[] = [];
	const edges: AppMapEdge[] = [];
	let cleaned = text;
	const pattern = /<parameter\s+name="(nodes|edges)">\s*(\[[\s\S]*?\])\s*(?:<\/parameter>|$)/g;
	for (const match of text.matchAll(pattern)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(match[2]);
		} catch {
			continue; // Truncated mid-array; the rest of the finding is still worth keeping.
		}
		if (!Array.isArray(parsed)) continue;
		if (match[1] === "nodes") nodes.push(...(parsed as AppMapNode[]));
		else edges.push(...(parsed as AppMapEdge[]));
		cleaned = cleaned.replace(match[0], "");
	}

	return { cleaned: cleaned.trimEnd(), nodes, edges };
}

/**
 * Would this action operate a control whose label reads destructive?
 *
 * An exploration pass can now run unattended for hours against a real workspace, and the
 * only thing standing between it and a deleted document was a paragraph in a system prompt.
 * This is the mechanical backstop: a label check over a fixed verb set, blind to which app
 * it is running against. Returns the offending label, or undefined.
 *
 * It over-refuses by design — "Reset zoom" is harmless and gets blocked. A refusal costs one
 * turn and is handed back as a tool result, so the pass reads it and moves on; the reverse
 * mistake is not recoverable.
 */
const DESTRUCTIVE_LABEL =
	/\b(delete|remove|discard|erase|trash|publish|export|download|send|share|invite|buy|purchase|subscribe|unsubscribe|sign out|log out|revoke|deactivate|reset|restore|merge|archive)\b/i;

/**
 * The same guard, retuned for the open web, where the verb set above is wrong in both
 * directions.
 *
 * Too narrow: a website's destructive act is usually a bare commit verb — Confirm, Submit,
 * Post, Reply, Accept, Place order — none of which appear above, and every one of which is
 * irreversible and externally visible in exactly the way the carve-out exists to prevent.
 *
 * Too broad: `download` is on every documentation page on the internet, and blocking it would
 * refuse a large fraction of ordinary navigation. It is dropped here — a download is a local
 * side effect, not an externally visible one.
 */
const DESTRUCTIVE_LABEL_WEB =
	/\b(delete|remove|discard|erase|trash|publish|send|share|invite|buy|purchase|subscribe|unsubscribe|sign out|log out|revoke|deactivate|reset|restore|merge|archive|confirm|submit|post|reply|accept|decline|place order|checkout|check out|pay|book|sign up|register|apply|transfer|withdraw)\b/i;
/**
 * Which control an action operates, resolved against the observation the model was looking at.
 *
 * Two addressing modes because the model has two: a handle names its element directly, and a
 * coordinate action is matched to the SMALLEST box containing the point — boxes nest, so a click
 * inside a button is also inside its panel, and the panel is never the thing being pressed.
 *
 * MUST be called with the PRE-action observation. Element handles are only meaningful in the
 * snapshot that produced them (DRIVER_RULES says so), and the agent reassigns its observation to
 * the post-action one before recording the step, so resolving late silently names a different
 * control.
 *
 * Shared by the destructive-label guard and the mutation journal, which ask different questions
 * of the same answer. Two copies would be two chances to disagree about what the agent just
 * touched.
 */
export function actionTarget(action: any, obs: ObservationBundle): InteractiveElement | undefined {
	const handle = action?.element_index ?? action?.ref;
	if (handle !== undefined && handle !== null) return obs.interactive.find((e) => e.handle === handle);
	if (typeof action?.x !== "number" || typeof action?.y !== "number") return undefined;

	let target: InteractiveElement | undefined;
	for (const e of obs.interactive) {
		if (e.w <= 0 || e.h <= 0) continue;
		if (action.x < e.x || action.x >= e.x + e.w || action.y < e.y || action.y >= e.y + e.h) continue;
		if (!target || e.w * e.h < target.w * target.h) target = e;
	}

	return target;
}

/**
 * `web` swaps in the verb set above. The caller knows the target kind; this function stays
 * blind to which app it is guarding, as it always has.
 *
 * KNOWN HOLE, stated rather than papered over: only *pressing* is guarded, and on the web the
 * destructive action is frequently **Enter in a form** — no control is named, so there is
 * nothing for a label check to read. The partial guard below catches Enter aimed at a named
 * control; Enter with no target, or in a text field that happens to be inside a form, still
 * submits. Closing that needs form membership, which the AX tree does not report.
 */
export function destructiveTarget(action: any, obs: ObservationBundle, web = false): string | undefined {
	const target = actionTarget(action, obs);
	// Only *pressing* things is guarded. A keystroke can be destructive too, but nothing
	// here can tell which one is, and guessing at key combinations would block the pass
	// from typing at all. The one exception is web: Enter is a submit, so an Enter aimed at a
	// NAMED control is treated as pressing that control. Enter with no target still passes —
	// see the hole documented above.
	const pressing = ["click", "double_click", "right_click"];
	const isPress =
		pressing.includes(String(action?.name)) ||
		(web && String(action?.name) === "press_key" && /^(return|enter)$/i.test(String(action?.key ?? "")) && target !== undefined);
	if (!target || !isPress) return undefined;
	const pattern = web ? DESTRUCTIVE_LABEL_WEB : DESTRUCTIVE_LABEL;

	return pattern.test(target.name) ? target.name : undefined;
}

export function observationBlocks(obs: ObservationBundle, vision = true): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
	const text: Anthropic.TextBlockParam = { type: "text", text: `Window title: "${obs.title}"\nElements:\n${obs.elementsText}` };
	// An empty frame is possible on the DOM path, where a missing screenshot degrades the
	// observation rather than ending the run (see DomBackend.observe). Sending it anyway would
	// put an empty base64 image block on the wire and the API would reject the whole request —
	// turning a cosmetic gap into exactly the run-ending failure the degradation avoided.
	if (!vision || !obs.screenshotB64) return [text];

	return [text, { type: "image", source: { type: "base64", media_type: "image/png", data: obs.screenshotB64 } }];
}

/**
 * The surface exploration started from: the one surface no edge leads to.
 *
 * Derived structurally rather than by looking for an id called "root", because that id is a
 * convention of one exploration pass and not part of the schema. Undefined unless exactly one
 * surface qualifies — zero means every surface is reachable (a cycle) and more than one means
 * the graph is disconnected; in both cases there is no single landing state to speak of, and
 * guessing between candidates is worse than admitting it.
 */
export function rootSurface(graph: AppMap): AppMapNode | undefined {
	const targets = new Set(graph.edges.map((e) => e.to));
	const roots = graph.nodes.filter((n) => n.kind === "surface" && !targets.has(n.id));

	return roots.length === 1 ? roots[0] : undefined;
}

/**
 * Labels of the controls that sit on the root surface, taken from the edges leaving it.
 *
 * Edge actions are prose ('click "Brand Kit" in bottom-left rail') and the quoted span is the
 * label the walk actually observed, so it is the one string in the graph that can be matched
 * against a live observation. Used only to answer "does this app look like itself right now" —
 * never to decide where to click.
 */
export function rootControlLabels(graph: AppMap): string[] {
	const root = rootSurface(graph);
	if (!root) return [];

	const labels = graph.edges.filter((e) => e.from === root.id).flatMap((e) => quotedLabels(e.action));

	return [...new Set(labels)];
}

/** The labels an edge action quotes — the only strings in the graph a live observation can match. */
function quotedLabels(action: string): string[] {
	return [...action.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((l) => l.trim());
}

/**
 * Accept a declared home only if the pass can show its own evidence for it.
 *
 * The surface must be a node the walk recorded, and the control label must appear in some edge
 * action — that is where the walk quotes labels it actually operated. Both are weak checks and
 * that is deliberate: they catch a fabricated or misremembered label at the end of a 40-minute,
 * context-reset transcript, which is the realistic failure, without pretending to validate
 * against a live app that is no longer running by the time this is called.
 *
 * Worth being strict about because this one field is written once and then silently governs the
 * start state of every future run: a label the pass never saw becomes a permanent, invisible
 * "failed" reset. Dropping it costs only the normalisation and keeps the readiness check.
 */
export function checkHome(
	home: AppMapHome | undefined,
	nodes: AppMapNode[],
	edges: AppMapEdge[],
): { home?: AppMapHome; problem?: string } {
	if (!home) return {};
	if (!home.surface?.trim() || !home.control?.trim()) return { problem: "surface and control are both required" };
	if (!nodes.some((n) => n.id === home.surface)) return { problem: `surface "${home.surface}" is not a node in the graph` };

	const quoted = new Set(edges.flatMap((e) => quotedLabels(e.action)));
	if (!quoted.has(home.control))
		return { problem: `control "${home.control}" appears in no edge action, so the pass never recorded operating it` };

	return { home };
}

export type HomeResetResult = "reset" | "already-home" | "none" | "failed" | "root-visible";

/**
 * Put the app in a known state before a run, and refuse to proceed if it is not in one.
 *
 * A run that begins wherever the last run happened to stop is not a measurement — it inherits
 * that run's navigation for free. (Measured: the Yarn cursor task took 3 actions starting on
 * the settings page it ends on, vs 4 from the app's home view; the difference is entirely the
 * navigation step the warm start skipped.)
 *
 * The home state is DECLARED IN THE APPMAP, not in this file. It used to be a table here
 * keyed by app slug, which was app-specific data in general-purpose code and, worse, meant the
 * unusable-app refusal in agent.ts only fired for the two apps that happened to be listed —
 * every newly onboarded app got "none" and was driven straight into its login wall.
 *
 * So there are two tiers, and the weaker one is the one that generalises:
 *
 *  - A declared home is clicked, which both normalises the start state and proves the app is
 *    usable.
 *  - With no declared home we can still ask whether ANY control from the app's landing surface
 *    is on screen. That does not normalise anything, so it is reported as `root-visible` and
 *    not as a reset — but it is a real answer to "is this app at a sign-in wall", and it works
 *    for any app with a map.
 *
 * Nothing here knows what a login looks like; that would be app-specific. It knows only
 * whether the app's own recorded landing state can be seen.
 */
/**
 * A short census of the named controls actually visible, for a diagnostic that would otherwise
 * only say what is missing.
 *
 * Deliberately app-agnostic: it reports labels, it does not try to classify them. Nothing here
 * knows what a login screen looks like — a reader does, from the labels.
 */
function onScreenSummary(obs: ObservationBundle): string {
	if (!obs.appContent) return " — and the app has NO content elements at all";

	// Menu-bar items last, not excluded: every Mac app carries the same ~70 of them ("About
	// This Mac", "System Settings…"), so unfiltered they crowd out the handful of labels that
	// identify the screen — on the first real use they pushed "Sign in with SSO" to fourth
	// place and filled the rest of the line. They still belong in the tail, because an app
	// whose ONLY named controls are menu items is itself the diagnosis.
	const named = obs.interactive.filter((e) => e.name.trim());
	const names = [
		...new Set([...named.filter(isAppContent), ...named.filter((e) => !isAppContent(e))].map((e) => e.name.trim())),
	];
	if (!names.length) return ` — ${obs.appContent} content elements, none of them a named control`;

	const shown = names.slice(0, 12);

	return ` — on screen instead: ${shown.map((n) => `"${n}"`).join(", ")}${names.length > shown.length ? `, +${names.length - shown.length} more` : ""}`;
}

/**
 * Which labels prove this app's landing surface is on screen — or why none can be named.
 *
 * Shared by the reset and the read-only probe below, because "is the app at home" has to mean
 * the same thing in both. They answer for different callers (one normalises a run's start
 * state, one waits for a human to finish signing in) and a second, drifting copy of the rule
 * would let a sign-in be declared complete against a screen the next run then refuses.
 */
function homeTargets(app: string, graph: AppMap | undefined): { home?: AppMap["home"]; wanted: string[]; problem?: string } {
	if (!graph) return { wanted: [], problem: `no appmap for "${app}" — run: npm run explore -- "${app}"` };

	// Any of the fallback labels will do; a declared home wants its own.
	const home = graph.home;
	const wanted = home ? [home.control] : rootControlLabels(graph);
	if (!wanted.length) return { wanted, problem: `appmap for "${app}" declares no home and has no identifiable landing surface` };

	return { home, wanted };
}

/** The first observation line naming any of `wanted`. */
function findHomeLine(text: string, wanted: string[]): string | undefined {
	return text.split("\n").find((l) => wanted.some((label) => l.includes(`"${label}"`)));
}

/**
 * Is the app sitting at its declared home right now? Observes and answers — nothing else.
 *
 * The read-only counterpart to `resetToHome`, and the difference is the point. It exists to be
 * called repeatedly while a HUMAN is using the app (signing it in over screen sharing), where
 * the reset's two side effects are both destructive: the escape would dismiss the dialog they
 * are filling in, and the click would navigate away from it. So there is no escape and no
 * click here, and a run of these leaves the app exactly as it found it.
 *
 * Nothing here knows what a sign-in looks like. It knows whether the app's own recorded landing
 * state can be seen, which is as app-agnostic as the reset it shares its rules with.
 */
export async function probeHome(
	driver: Driver,
	win: WindowRef,
	app: string,
	graph: AppMap | undefined = loadAppMapGraph(appSlug(app)),
): Promise<{ ready: boolean; detail: string }> {
	const target = homeTargets(app, graph);
	if (target.problem) return { ready: false, detail: target.problem };

	const obs = await observe(driver, win, "home-probe");
	if (findHomeLine(obs.elementsText, target.wanted))
		return {
			ready: true,
			detail: target.home ? `home control "${target.home.control}" is on screen` : `the landing surface of "${app}" is on screen`,
		};

	return { ready: false, detail: `${target.wanted.map((l) => `"${l}"`).join(", ")} not on screen${onScreenSummary(obs)}` };
}

export async function resetToHome(
	driver: Driver,
	win: WindowRef,
	app: string,
	graph: AppMap | undefined = loadAppMapGraph(appSlug(app)),
): Promise<{ result: HomeResetResult; detail: string }> {
	// Loaded here rather than passed down from agent.ts on purpose: there, the graph is gated
	// on grounding being enabled, and a reset that only happens in the grounded arm would make
	// every A/B comparison measure the reset instead of the grounding.
	const target = homeTargets(app, graph);
	if (target.problem) return { result: "none", detail: target.problem };

	const home = target.home;
	const wanted = target.wanted;
	const findLine = (text: string): string | undefined => findHomeLine(text, wanted);

	// An overlay left open by the previous run hides the sidebar: Yarn's dropdowns overlay
	// the page and sidebar elements vanish from the AX tree entirely, so the home control
	// is simply not there. That surfaced as homeReset "failed" and a run that silently
	// started wherever the last one stopped — the exact non-comparability the reset exists
	// to prevent. Escape first, then retry once.
	let obs = await observe(driver, win, "home-reset-probe");
	let line = findLine(obs.elementsText);
	let dismissed = false;
	if (!line) {
		await driver.act({
			kind: "tool",
			name: "press_key",
			args: { pid: win.pid, window_id: win.windowId, key: "escape", delivery_mode: "foreground" },
		});
		await new Promise((r) => setTimeout(r, 900));
		obs = await observe(driver, win, "home-reset-probe");
		line = findLine(obs.elementsText);
		dismissed = true;
	}
	if (!line)
		return {
			result: "failed",
			detail:
				(home
					? `home control "${home.control}" not present, even after escape`
					: `nothing from the landing surface of "${app}" is on screen, even after escape (looked for ${wanted.map((l) => `"${l}"`).join(", ")})`) +
				// What IS on screen, because the absence alone is unactionable. A sign-in wall, a
				// leftover modal and a different view all produce the identical "not present", and
				// the operator's next move differs for each. Measured on mac1, 2026-07-30: the run
				// refused with only the missing name and nothing in the log said whether the app
				// wanted a password or had a dialog open.
				onScreenSummary(obs),
		};

	// Without a declared home there is nowhere specific to click: the labels above prove the
	// app is usable, which is the safety half, but normalising the start state needs to know
	// WHICH surface is home and that is exactly what the map is missing.
	if (!home)
		return {
			result: "root-visible",
			detail: `landing surface of "${app}" is on screen, but the appmap declares no home — start state is not normalised; re-run: npm run explore -- "${app}"`,
		};

	const index = Number(line.match(/^\[(\d+)\]/)?.[1]);
	if (!Number.isFinite(index)) return { result: "failed", detail: `could not parse index from: ${line}` };

	await driver.act({
		kind: "tool",
		name: "click",
		args: { pid: win.pid, window_id: win.windowId, element_index: index, delivery_mode: "foreground" },
	});
	await new Promise((r) => setTimeout(r, 1200));

	return {
		result: "reset",
		detail: `${dismissed ? "escaped a leftover overlay, then " : ""}clicked "${home.control}" → ${home.description}`,
	};
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
		const out = execFileSync("osascript", ["-l", "JavaScript", "-e", script], { encoding: "utf8" }).trim();
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

/**
 * Controls that edit the SAME setting from different scopes — the failure this graph exists
 * to surface. Measured on Yarn: "Cursor Style" is editable brand-wide (Brand Kit ▸ Screen
 * Clips) and per-draft (Project actions ▸ Screen Clip Settings), they are independent stores,
 * and all four ungrounded runs silently changed the per-draft one while passing verification.
 */
export function findScopeAmbiguities(map: AppMap): ScopeAmbiguity[] {
	const byKey = new Map<string, Array<{ id: string; scope: SurfaceScope }>>();
	for (const n of map.nodes) {
		if (!n.settingKey) continue;
		const list = byKey.get(n.settingKey) ?? [];
		list.push({ id: n.id, scope: n.scope });
		byKey.set(n.settingKey, list);
	}

	const out: ScopeAmbiguity[] = [];
	for (const [settingKey, nodes] of byKey) {
		if (new Set(nodes.map((n) => n.scope)).size > 1) out.push({ settingKey, nodes });
	}

	return out.sort((a, b) => a.settingKey.localeCompare(b.settingKey));
}

/**
 * Prompt text warning the agent about ambiguous settings, appended to the prose map. Prose
 * alone did not prevent the wrong-scope changes; naming each collision explicitly, with the
 * scope of every candidate, gives the model something it cannot skim past.
 */
/**
 * The click-path to a node, as recorded by exploration. Edges are keyed by node id, and a
 * control's route is the path to its parent surface — you navigate to the panel, not to the
 * combobox inside it.
 *
 * Lifted out of `scopeWarnings`, where it was a closure, because teardown needs the same walk
 * to tell a restore where its control lives (`restoreRoute` in src/journal.ts).
 */
export function routeTo(map: AppMap, nodeId: string): string {
	const surface = map.nodes.find((n) => n.id === nodeId)?.kind === "control"
		? nodeId.split("/").slice(0, -1).join("/")
		: nodeId;
	const hops: string[] = [];
	let cursor = surface;
	// Walk parents until root; bounded by node count so a cyclic graph cannot hang us.
	for (let i = 0; i <= map.nodes.length; i++) {
		const edge = map.edges.find((e) => e.to === cursor);
		if (!edge) break;
		hops.unshift(edge.action);
		if (edge.from === "root") break;
		cursor = edge.from;
	}

	return hops.length ? hops.join(" → ") : "(route not recorded)";
}

export function scopeWarnings(map: AppMap): string {
	const ambiguities = findScopeAmbiguities(map);
	if (ambiguities.length === 0) return "";


	// Group by the SURFACES involved, not per setting. Yarn has 15 settings split across the
	// same brand-vs-document pair of panels; listing each separately made the warning 10.8k
	// chars — nearly twice the appmap it is supposed to annotate — by repeating one pair of
	// routes fifteen times. One entry per surface pair, with the settings it covers.
	const groups = new Map<string, { nodes: Array<{ id: string; scope: SurfaceScope }>; settings: string[] }>();
	for (const a of ambiguities) {
		const surfaceOf = (id: string) =>
			map.nodes.find((n) => n.id === id)?.kind === "control" ? id.split("/").slice(0, -1).join("/") : id;
		const pair = a.nodes
			.map((n) => `${n.scope}:${surfaceOf(n.id)}`)
			.sort()
			.join(" | ");
		const g = groups.get(pair) ?? {
			nodes: a.nodes.map((n) => ({ id: surfaceOf(n.id), scope: n.scope })),
			settings: [],
		};
		g.settings.push(a.settingKey);
		groups.set(pair, g);
	}

	const lines = [...groups.values()].map((g) => {
		const options = g.nodes
			.map((n) => `    · ${n.scope} scope — ${n.id}\n      route: ${routeTo(map, n.id)}`)
			.join("\n");

		return (
			`- These settings exist at ${g.nodes.length} scopes — SEPARATE stores, changing one does NOT change the other:\n` +
			`  ${g.settings.join(", ")}\n${options}`
		);
	});

	return (
		`\n\n# Settings that exist at more than one scope (from the structured appmap)\n` +
		`${lines.join("\n")}\n\n` +
		"Both routes are given because either can be correct — it depends on what the task is for. " +
		"Read the task and decide: a request about defaults, brand settings, or 'how it should always " +
		"look' points at the broad scope; a request about this document/project/recording points at the " +
		"override. If the task is genuinely ambiguous, pick the one you can best justify and SAY WHICH " +
		"YOU CHOSE AND WHY in your summary — an unstated choice is the actual failure, because a reader " +
		"cannot tell a deliberate decision from an accident. When it is cheap and non-destructive to do " +
		"so, you may set both and say so."
	);
}

/**
 * Takes the artifact SLUG, not an app name: a web target's slug is derived from its origin
 * rather than by folding whitespace, so `appSlug` is no longer the right thing to apply here
 * and applying it twice would mangle one. Callers own the slug (see `targetSlug`).
 */
export function loadAppMapGraph(slug: string): AppMap | undefined {
	const path = `${appmapsDir()}/${slug}.json`;
	if (!fs.existsSync(path)) return undefined;

	try {
		return JSON.parse(fs.readFileSync(path, "utf8")) as AppMap;
	} catch (err) {
		console.log(`WARNING: could not parse ${path}: ${err instanceof Error ? err.message : String(err)}`);

		return undefined;
	}
}

/**
 * Fraction of pixels that differ between two screenshots, 0..1, or undefined if the
 * comparison could not be made (missing file, size mismatch, no python/PIL).
 *
 * Why this exists: verify() greps AX labels and values, and rendered content is not in
 * that channel — measured on Yarn, the Library shows ~12 video thumbnails while the AX
 * tree reports one 20x20 image among 377 elements. So "the preview never re-rendered" is
 * invisible to text verification. This is the cheap, deterministic half of the fix: no
 * model call, just "did the pixels move".
 *
 * Deliberately a signal, not a gate — it is recorded per step and never fails a run on its
 * own. Legitimate actions can change nothing visible (a wait, an off-screen scroll), and
 * animation/carets can change pixels when nothing meaningful happened, so a threshold here
 * would produce confident wrong verdicts in both directions.
 */
export function pixelDelta(beforePath: string, afterPath: string): number | undefined {
	if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) return undefined;

	const script = `
import sys
from PIL import Image, ImageChops
a = Image.open(sys.argv[1]).convert("RGB")
b = Image.open(sys.argv[2]).convert("RGB")
if a.size != b.size:
    print("SIZE_MISMATCH"); sys.exit(0)
# Downscale before diffing: 8x fewer pixels, and it suppresses single-pixel AA noise
# that would otherwise register as change on a static screen.
w, h = max(1, a.width // 8), max(1, a.height // 8)
a = a.resize((w, h)); b = b.resize((w, h))
diff = ImageChops.difference(a, b).convert("L")
changed = sum(1 for p in diff.getdata() if p > 12)
print(changed / float(w * h))
`;
	try {
		const out = execFileSync("python3", ["-c", script, beforePath, afterPath], { encoding: "utf8" }).trim();
		if (out === "SIZE_MISMATCH") return undefined;
		const v = Number(out);

		return Number.isFinite(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Did a drag move something from where it was pressed to where it was released?
 *
 * The only evidence available on a painted target: it has no label to grep, so text
 * verification has nothing to work with. The test is deliberately about GEOMETRY, not
 * appearance — crop the neighbourhood of each endpoint and compare it against itself
 * before and after. A thing that moved vacates its origin and arrives at its destination,
 * whatever colour or shape it is. Nothing here knows what is being dragged.
 *
 * Both ends must change. One end alone is the common false positive: a canvas that draws an
 * indicator wherever you press lights up the origin on every drag, including one that
 * grabbed nothing.
 *
 * What it cannot do, and no amount of tuning will fix: say the thing landed in the RIGHT
 * place. That is why the channel is named in the result and why done(success) refuses it.
 */
export function dragMoved(
	beforePath: string,
	afterPath: string,
	from: { x: number; y: number },
	to: { x: number; y: number },
	radius = 14,
): { moved: boolean; origin?: number; dest?: number } {
	if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) return { moved: false };

	const script = `
import sys
from PIL import Image, ImageChops
a = Image.open(sys.argv[1]).convert("RGB")
b = Image.open(sys.argv[2]).convert("RGB")
if a.size != b.size:
    print("SIZE_MISMATCH"); sys.exit(0)
r = int(sys.argv[6])
def frac(cx, cy):
    box = (max(0, cx - r), max(0, cy - r), min(a.width, cx + r), min(a.height, cy + r))
    if box[2] <= box[0] or box[3] <= box[1]: return 0.0
    d = ImageChops.difference(a.crop(box), b.crop(box)).convert("L").getdata()
    return sum(1 for p in d if p > 12) / float(len(d))
print(frac(int(sys.argv[3]), int(sys.argv[4])), frac(int(sys.argv[5]), int(sys.argv[4] if len(sys.argv) < 8 else sys.argv[7])))
`;
	try {
		const out = execFileSync(
			"python3",
			["-c", script, beforePath, afterPath, String(from.x), String(from.y), String(to.x), String(radius), String(to.y)],
			{ encoding: "utf8" },
		).trim();
		if (out === "SIZE_MISMATCH") return { moved: false };
		const [origin, dest] = out.split(/\s+/).map(Number);
		if (!Number.isFinite(origin) || !Number.isFinite(dest)) return { moved: false };
		// A tenth of a small crop is well clear of antialiasing while far below what an
		// arriving object produces (measured: 0.04-0.12 for a real move, 0 for inert canvas).
		const MIN = 0.02;

		return { moved: origin > MIN && dest > MIN, origin, dest };
	} catch {
		return { moved: false };
	}
}

export interface VisualVerdict {
	verdict: "PASS" | "FAIL" | "UNPROVEN";
	scope: string;
	why: string;
}

/**
 * Independent visual check of the FINAL state, used only at the done boundary.
 *
 * This is a SEPARATE model call from the acting agent, deliberately: this whole harness's
 * verification layer was rebuilt because a model was grading its own work, and a judge that
 * shares the actor's context inherits its rationalisations. The judge sees the goal and one
 * screenshot — not the action history, not the actor's summary.
 *
 * It exists because substring evidence proves *a* control reads the target value, never that
 * it is the *intended* control. Measured on the two real scope screenshots (both showing
 * Cursor Style = Pointer-first, one brand-wide and one per-draft): the judge passed the brand
 * frame and failed the per-draft one, citing the missing Brand Kit surface — the exact
 * failure that shipped four times under text-only checking.
 *
 * Advisory by default: its verdict is recorded and printed, and only blocks a success claim
 * under VISUAL_JUDGE=block. A confident wrong FAIL would stall a correct run, and a confident
 * wrong PASS is precisely the failure we are trying to remove, so it adds a gate rather than
 * replacing the deterministic text check.
 */
export async function visualJudge(
	client: Anthropic,
	model: string,
	goal: string,
	screenshotB64: string,
	claim?: string,
): Promise<VisualVerdict | undefined> {
	try {
		const r = await client.messages.create({
			model,
			// 700 was not enough: the model spends output tokens on reasoning before it writes
			// the verdict, and on a busy frame with a long claim it hit the cap having emitted
			// a thinking block and no text at all — stop_reason "max_tokens", zero text blocks.
			// The judge then looked "unavailable" on exactly the runs hardest to judge, which
			// is the worst possible direction for the bias to run.
			max_tokens: 2000,
			system:
				"You are an independent verifier for a UI automation run. You did NOT perform the actions and " +
				"have no stake in them succeeding; your job is to be hard to fool. You are given a goal and a " +
				"screenshot of the FINAL state. Decide whether the screenshot proves the goal was achieved.\n\n" +
				"Be strict about WHICH control shows the value. Many apps expose the same setting at more than " +
				"one scope (an app/brand-wide default vs a per-document override). A screenshot showing the " +
				"right value in the WRONG scope does NOT prove the goal.\n\n" +
				"Use UNPROVEN when the frame simply does not show the relevant surface — that is different from " +
				"FAIL, which means the frame shows the goal was NOT achieved.\n\n" +
				"Judge the AGENT'S CLAIM, not merely the task wording. A task may be vaguely phrased " +
				"(\"show me how to change X\"), but the agent states what it actually did; your job is to " +
				"decide whether the frame supports THAT. In particular, if the agent claims it changed a " +
				"global/brand-wide default, a frame showing only a per-document override panel is a FAIL — " +
				"do not accept \"the control is visible here\" as proof that the claimed change was made.\n\n" +
				"Reply exactly:\nVERDICT: PASS | FAIL | UNPROVEN\nSCOPE: which surface/scope the value is shown at\nWHY: one or two sentences",
			messages: [
				{
					role: "user",
					content: [
						{
						type: "text",
						text: `Task given to the agent: ${goal}` + (claim ? `\n\nWhat the agent claims it did: ${claim}` : "") + "\n\nFinal-state screenshot follows.",
					},
						{ type: "image", source: { type: "base64", media_type: "image/png", data: screenshotB64 } },
					],
				},
			],
		});
		const text = r.content
			.filter((b): b is Anthropic.TextBlock => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		const verdict = /VERDICT:\s*(PASS|FAIL|UNPROVEN)/i.exec(text)?.[1]?.toUpperCase();
		// Say so. A judge that returns nothing used to do it silently, which made a missing
		// gate indistinguishable from a passing one in both the console and the run log —
		// and it went missing on a canvas run, where it is the only check on whether the
		// thing that moved was the thing we meant to move.
		if (!verdict) {
			const why = r.stop_reason === "max_tokens" ? "ran out of output tokens before writing one" : text.slice(0, 200).replace(/\s+/g, " ");
			console.log(`visual judge returned no parseable verdict: ${why}`);

			return undefined;
		}

		return {
			verdict: verdict as VisualVerdict["verdict"],
			scope: /SCOPE:\s*(.+)/i.exec(text)?.[1]?.trim() ?? "",
			why: /WHY:\s*([\s\S]+)/i.exec(text)?.[1]?.trim().slice(0, 400) ?? "",
		};
	} catch (err) {
		// Never fail a run because the judge was unreachable; it is an added gate.
		console.log(`visual judge unavailable: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);

		return undefined;
	}
}

/**
 * Which evidence proved a step, and therefore how much the step is worth.
 *
 * - "text" — a substring appeared or disappeared in the AX tree. Discriminating and
 *   deterministic: it says WHAT changed.
 * - "geometry" — a NAMED element's frame moved by about the distance the drag asked for.
 *   Structural and quantitative: it says which element moved and how far, so it survives
 *   the objection that something merely repainted. Available whenever painted content sits
 *   near addressable content, which on a document surface is usual.
 * - "pixel" — the screen changed where the action was aimed, and did not change where it
 *   was not. The last resort, for painted regions with no neighbouring elements at all:
 *   it says SOMETHING moved, never that it moved somewhere correct.
 *
 * They are kept apart everywhere — in the result, in the step log, in the run summary —
 * because the whole risk with a canvas task is quoting the weak number as if it were the
 * strong one.
 */
export type VerifyChannel = "text" | "geometry" | "pixel";

export interface VerifyResult {
	verified: boolean;
	note: string;
	channel?: VerifyChannel;
}

/**
 * Check an expectation against the post-action observation text.
 *
 * Two ways to fail beyond a plain substring miss, both discovered by auditing real run
 * logs (2026-07-29):
 * - An expectation with no textIncludes/textExcludes used to pass vacuously — 2–6 steps
 *   per historical run were "verified" by an unfalsifiable prose description.
 * - A substring already on screen BEFORE the action passes the presence check while
 *   proving nothing about the action (e.g. text the agent itself typed two steps ago).
 *   When `prevHaystack` is supplied, at least one check must discriminate: an include
 *   absent before, or an exclude present before. Final-state checks (done) pass no
 *   prevHaystack — there the claim is about state, not change.
 */
export function verify(expectation: Expectation, haystack: string, prevHaystack?: string): VerifyResult {
	const includes = expectation.textIncludes ?? [];
	const excludes = expectation.textExcludes ?? [];
	if (includes.length === 0 && excludes.length === 0)
		return { verified: false, note: "no checkable expectation (textIncludes/textExcludes)" };

	const missing = includes.filter((t) => !haystack.includes(t.toLowerCase()));
	const present = excludes.filter((t) => haystack.includes(t.toLowerCase()));
	if (missing.length || present.length) {
		const parts: string[] = [];
		if (missing.length) parts.push(`expected but not found: ${missing.join(", ")}`);
		if (present.length) parts.push(`expected absent but found: ${present.join(", ")}`);

		return { verified: false, note: parts.join("; ") };
	}

	if (prevHaystack !== undefined) {
		const discriminating =
			includes.some((t) => !prevHaystack.includes(t.toLowerCase())) ||
			excludes.some((t) => prevHaystack.includes(t.toLowerCase()));
		if (!discriminating)
			return {
				verified: false,
				note:
					"expectation met, but every check was ALREADY satisfied before the action — no evidence " +
					"the action changed anything; expect substrings that appear or disappear as a RESULT of it",
			};
	}

	return { verified: true, note: "expectation met", channel: "text" };
}

/**
 * Task prompts must state the GOAL only. Method knowledge — which control to click, what
 * key to press, which driver call to use — belongs in the appmap (a declared, measurable
 * input), never in the task text, where it silently inflates results and makes a run look
 * autonomous when it was dictated. See docs/research/2026-07-29-prompt-hygiene.md.
 *
 * Detection is deliberately narrow and high-precision: driver/AX vocabulary, and
 * interaction-mechanic verbs (click/press/keystroke), which describe HOW to act rather
 * than WHAT to achieve. Outcome verbs ("create a draft", "set the voice", "open the
 * Script tab") are legitimate task specification and do not trip it.
 */
const DRIVER_VOCAB = /\b(set_value|type_text|press_key|right_click|double_click|element_index|delivery_mode|AXPress|AX[A-Z]\w+)\b/g;
const MECHANIC_VERBS = /\b(click|clicks|clicking|clicked|right[- ]click\w*|double[- ]click\w*|press|presses|pressing|keystroke\w*|select all|scroll\w*|hover\w*|drag\w*|cmd\+|ctrl\+|option\+|shift\+|⌘)/gi;
/**
 * Screen coordinates, which arrived as a hint vector the moment painted targets became
 * actionable. A coordinate is the purest possible method hint: deriving it from the pixels
 * is the entire task on a canvas, so handing it over skips the only hard part. One is enough
 * to fail the prompt — unlike mechanic verbs, there is no innocent reading of "x=940".
 *
 * Both spellings the hint actually takes: an axis assignment, and a pair introduced by a
 * preposition. The pair requires that preposition so a bare "1080, 720" — a resolution, a
 * legitimate goal — does not trip it.
 */
const COORD_HINT = /\b[xy]\s*[=:]\s*-?\d+|\b(?:at|to|from)\s+\(?\s*\d{2,4}\s*,\s*\d{2,4}\s*\)?/gi;

export interface PromptAudit {
	hinted: boolean;
	reasons: string[];
}

export function auditTaskPrompt(task: string): PromptAudit {
	const reasons: string[] = [];
	const vocab = [...new Set(task.match(DRIVER_VOCAB) ?? [])];
	const mechanics = [...new Set((task.match(MECHANIC_VERBS) ?? []).map((m) => m.toLowerCase()))];
	if (vocab.length > 0) reasons.push(`names driver/AX internals: ${vocab.join(", ")}`);
	if (mechanics.length >= 2) reasons.push(`describes interaction mechanics, not just the goal: ${mechanics.join(", ")}`);
	const coords = [...new Set(task.match(COORD_HINT) ?? [])];
	if (coords.length > 0) reasons.push(`gives screen coordinates, which the agent must derive itself: ${coords.join(", ")}`);

	return { hinted: reasons.length > 0, reasons };
}

export const SUPPORTED_ACTIONS = [
	"click",
	"right_click",
	"double_click",
	"type_text",
	"press_key",
	"set_value",
	"scroll",
	"drag",
	"wait",
] as const;

/**
 * Longest a single `wait` may sleep. Not a budget — `wait` can be called again — but a bound
 * on one mistake: `seconds: 100000` from a model that meant 100 would otherwise hang a run
 * for a day with nothing on the console to explain it.
 */
export const MAX_WAIT_MS = 600_000;

/**
 * How long to let the app settle after an action. Everything takes the caller's short
 * default; `wait` takes the seconds it asked for, clamped.
 *
 * This exists because `wait` used to be indistinguishable from any other action: it issues no
 * driver call, so the whole action WAS the settle delay, and the longest pause the agent could
 * express was ~900ms. That is fine for a menu opening and useless for the growing class of
 * target that embeds an agent of its own and takes minutes to answer — reaching five minutes
 * meant ~330 turns, each a full model round-trip, against a 15-step budget. Waiting is now
 * one step.
 */
export function settleMsFor(action: unknown, defaultMs: number): number {
	const a = action as { name?: string; seconds?: unknown } | null | undefined;
	if (a?.name !== "wait") return defaultMs;
	const seconds = Number(a.seconds);
	// Absent, unparseable, or non-positive: an ordinary short wait, which is what `wait`
	// meant before it took an argument. Never shorter than the default settle.
	if (!Number.isFinite(seconds) || seconds <= 0) return defaultMs;

	return Math.min(Math.max(seconds * 1000, defaultMs), MAX_WAIT_MS);
}

export class UnsupportedActionError extends Error {
	constructor(name: string) {
		super(`unsupported action "${name}" — supported actions are: ${SUPPORTED_ACTIONS.join(", ")}`);
		this.name = "UnsupportedActionError";
	}
}

/**
 * Translate a model-proposed action into a driver call. Returns null for actions that
 * need no driver call (`wait` — the caller's settle delay is the action). Throws
 * UnsupportedActionError for anything unrecognized; callers must report that back to
 * the model as a failed step rather than aborting the run.
 */
export function toActionRequest(a: any, win: WindowRef): ActionRequest | null {
	const base = { pid: win.pid, window_id: win.windowId };
	switch (a.name) {
		case "wait":
			return null;
		case "click":
		case "right_click":
		case "double_click":
			// x/y instead of element_index for painted targets. A canvas draws its contents
			// rather than building them from controls, so there is frequently no element to
			// address — measured on one timeline: nothing but the window and the web area
			// covers a draggable handle.
			return a.element_index === undefined && a.x !== undefined
				? { kind: "tool", name: a.name, args: { ...base, x: a.x, y: a.y, delivery_mode: "foreground" } }
				: { kind: "tool", name: a.name, args: { ...base, element_index: a.element_index } };
		case "type_text":
			// element_index directs the write to a specific field — without it the driver
			// types at whatever has focus, and a preceding no-op click means keystrokes
			// land on the window and trigger the app's global shortcuts.
			return {
				kind: "tool",
				name: "type_text",
				args: {
					...base,
					text: a.text,
					...(a.element_index !== undefined ? { element_index: a.element_index } : {}),
					...(a.delivery_mode ? { delivery_mode: a.delivery_mode } : {}),
				},
			};
		case "press_key":
			return {
				kind: "tool",
				name: "press_key",
				args: {
					...base,
					key: a.key,
					...(a.modifiers ? { modifiers: a.modifiers } : {}),
					...(a.element_index !== undefined ? { element_index: a.element_index } : {}),
					...(a.delivery_mode ? { delivery_mode: a.delivery_mode } : {}),
				},
			};
		case "set_value":
			// The driver's parameter is `value`, not `text`.
			return { kind: "tool", name: "set_value", args: { ...base, element_index: a.element_index, value: a.text } };
		case "scroll":
			return {
				kind: "tool",
				name: "scroll",
				args: { ...base, direction: a.direction, ...(a.amount ? { amount: a.amount } : {}), ...(a.element_index !== undefined ? { element_index: a.element_index } : {}) },
			};
		case "drag":
			/**
			 * Press-drag-release between two points, for targets that are painted rather than
			 * built. Coordinates are window-local screenshot pixels — the same space as the
			 * observation's PNG, so a pixel read off the image needs no conversion (AX frames
			 * do; they are logical points).
			 *
			 * delivery_mode is pinned, not offered: the driver states background drag is
			 * unavailable on macOS. Duration and step count are slow on purpose — a drag the
			 * app can follow, and one that reads as human in a recording.
			 */
			return {
				kind: "tool",
				name: "drag",
				args: {
					...base,
					from_x: a.from_x,
					from_y: a.from_y,
					to_x: a.to_x,
					to_y: a.to_y,
					duration_ms: 600,
					steps: 40,
					delivery_mode: "foreground",
				},
			};
		default:
			throw new UnsupportedActionError(a.name);
	}
}

export const ACT_TOOL: Anthropic.Tool = {
	name: "act",
	description: "Perform one UI action on the target window and state the expected observable effect.",
	input_schema: {
		type: "object",
		properties: {
			reasoning: { type: "string", description: "One sentence: why this action now." },
			action: {
				type: "object",
				properties: {
					name: { type: "string", enum: [...SUPPORTED_ACTIONS] },
					element_index: { type: "integer", description: "Target element from the current observation. Required for click/right_click/double_click/set_value. STRONGLY recommended for type_text (directs the text into that field instead of relying on focus) and available for press_key." },
					x: { type: "integer", description: "For click/right_click/double_click on a PAINTED target with no element_index: horizontal pixel in the screenshot. Only use when no element covers the thing you mean." },
					y: { type: "integer", description: "Vertical pixel in the screenshot. Pairs with x." },
					from_x: { type: "integer", description: "For drag: where to press, in screenshot pixels." },
					from_y: { type: "integer", description: "For drag: where to press, in screenshot pixels." },
					to_x: { type: "integer", description: "For drag: where to release, in screenshot pixels." },
					to_y: { type: "integer", description: "For drag: where to release, in screenshot pixels." },
					text: { type: "string", description: "For type_text/set_value (the text/value to write)." },
					key: { type: "string", description: "For press_key: return, tab, escape, up, down, a-z, 0-9, etc." },
					modifiers: { type: "array", items: { type: "string" }, description: "For press_key: cmd, shift, option, ctrl." },
					delivery_mode: { type: "string", enum: ["background", "foreground"] },
					direction: { type: "string", enum: ["up", "down", "left", "right"], description: "For scroll." },
					amount: { type: "integer", description: "For scroll: wheel notches." },
					seconds: { type: "integer", description: `For wait: how long to wait before re-observing, up to ${MAX_WAIT_MS / 1000}. One wait of 120 costs a single step; 120 waits of 1 cost 120. Use it whenever the app is working on something slow.` },
				},
				required: ["name"],
			},
			expectation: {
				type: "object",
				properties: {
					description: { type: "string" },
					textIncludes: { type: "array", items: { type: "string" }, description: "REQUIRED unless textExcludes is given. Substrings that should appear in the next observation (window title, element labels, or values). Prose here is useless — use literal strings the app will render." },
					textExcludes: { type: "array", items: { type: "string" }, description: "Substrings that should NOT appear in the next observation. Satisfies the checkable-expectation requirement on its own." },
				},
				required: ["description"],
				description: "You MUST supply textIncludes and/or textExcludes. An act call with only a prose description is REJECTED WITHOUT BEING EXECUTED, because the harness cannot verify it.",
			},
		},
		required: ["action", "expectation"],
	},
};

export const DRIVER_RULES = `Rules learned from this driver (follow them):
- Address elements by element_index from the CURRENT observation only — indices change every snapshot.
- Elements in web content often warn "does not advertise AXPress" — the click usually still works. Trust the next observation, not the warning.
- If an element only advertises AXShowMenu (e.g. labels that open context menus), use right_click.
- Text fields are often pre-filled: click the field to focus it, then press cmd+a, then type. Never type without focusing first.
- Menu-bar keyboard shortcuts (like cmd+,) need delivery_mode "foreground". Escape to close overlays also usually needs "foreground".
- A silent no-op click means your next keystrokes hit global shortcuts and can open random overlays. If the observation shows an unexpected overlay, close it (escape, foreground) before continuing.

Painted targets (canvases, timelines, image regions):
- Some things are DRAWN, not built from controls, so no element_index exists for them. Look for them in the screenshot. Only then, address them by pixel: x/y on click, from_x/from_y/to_x/to_y on drag.
- Screenshot pixels are exactly what the driver consumes — the pixel you read IS the pixel it acts on. Do NOT convert. (The "frame" values printed beside elements are a DIFFERENT space — logical points — so never feed a frame coordinate to a coordinate action.)
- Prefer element_index whenever an element covers what you mean. Coordinates cannot be verified by the harness the way labels can, so they are the fallback, not the default.
- Dragging a thing puts it under wherever you released. If a pointer indicator follows your press, it now sits on top of the thing you just dropped, so pressing there again grabs the indicator instead — a reverse drag is NOT an undo.
- A canvas usually reacts to ANY press (scrubbing, selecting, deselecting). Text appearing after you act on a canvas may just be that reaction, not proof you hit the target.`;

/**
 * Verified-step tallies for a run log, split by evidence channel and never summed into one
 * number: a pixel step proves something moved where the action was aimed, a text step proves
 * WHAT changed. Reporting "8/8 verified" over a run carried by pixels would overstate it by
 * exactly the distinction the verification layers exist to keep.
 *
 * Shared so that every exit path — done() and the step limit alike — reports the same shape.
 */
export function verificationTallies(steps: StepRecord[]): {
	verifiedSteps: number;
	unverifiedSteps: number;
	verifiedByChannel: { text: number; geometry: number; pixel: number };
} {
	const unverified = steps.filter((s) => !s.verified).length;

	return {
		verifiedSteps: steps.length - unverified,
		unverifiedSteps: unverified,
		verifiedByChannel: {
			text: steps.filter((s) => s.verificationChannel === "text").length,
			geometry: steps.filter((s) => s.verificationChannel === "geometry").length,
			pixel: steps.filter((s) => s.verificationChannel === "pixel").length,
		},
	};
}

/** Below this fraction of pixels changed, a frame is treated as not having repainted. */
export const REPAINT_EPSILON = 0.001;

/**
 * How many trailing steps produced no evidence of a live app: nothing verified, nothing
 * repainted. `unpainted` because it counts the absence of a repaint, not a failure.
 *
 * A suspended Chromium window (off the active Space, or minimized) keeps answering AX
 * calls with its last tree, so nothing else in the loop notices it went dark: the agent
 * acts, verify() greps a stale-but-valid haystack, and the recorder saves the same frame
 * a few hundred times. Two Notion Calendar runs burned ~5 minutes each that way and
 * assembled a 247-identical-frame mp4.
 *
 * The pixel channel had already seen it — every step read 0.0% — but nothing consumed it.
 * A verified step proves the app is alive and clears the streak, and an unknown delta
 * (vision off, no prior frame) is not evidence either way, so it clears the streak too.
 *
 * Reporting only: the caller prints it and keeps going. It aborted runs for a day and had
 * to stop, because an app with an embedded agent produces the same signature while waiting
 * out a multi-minute think — see FROZEN_STEPS in agent.ts.
 */
export function unpaintedStreak(steps: StepRecord[]): number {
	let n = 0;
	for (let i = steps.length - 1; i >= 0; i--) {
		const s = steps[i];
		if (s.verified || s.pixelDelta === undefined || s.pixelDelta >= REPAINT_EPSILON) break;
		n++;
	}

	return n;
}
