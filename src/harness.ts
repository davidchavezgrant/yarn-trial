import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as axdom from "./axdom.js";
import { Driver } from "./driver.js";
import type { ActionRequest, AppMap, Expectation, ScopeAmbiguity, SurfaceScope } from "./types.js";

export const OUT = `${process.cwd()}/out`;

export interface WindowRef {
	pid: number;
	windowId: number;
}

export interface ObservationBundle {
	elementsText: string;
	haystack: string;
	screenshotB64: string;
	title: string;
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

export function appSlug(app: string): string {
	return app.toLowerCase().replace(/\s+/g, "-");
}

export function makeClient(): { client: Anthropic; model: string } {
	const openrouter = process.env.OPENROUTER_API_KEY;
	const model = process.env.AGENT_MODEL ?? (openrouter ? "anthropic/claude-opus-5" : "claude-opus-5");
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

	return { pid: win.pid, windowId: win.window_id };
}

/**
 * A window on an inactive macOS Space (e.g. because another app is fullscreen) still
 * appears in the window list and every driver call still succeeds — but Chromium has
 * suspended the app: no app-content AX elements, no screenshot. The failure looks
 * like a healthy app, so detect it explicitly instead of letting the caller flail
 * against a menu-bar-only tree. See LIMITATIONS.md §1.
 */
export class TargetNotObservableError extends Error {
	constructor(app: string, detail: string) {
		super(
			`"${app}" is running but not observable (${detail}), and foregrounding it did not help.\n` +
				`Most likely it is on an inactive macOS Space — another app is fullscreen, or the\n` +
				`window is on a different desktop. Programmatic activation cannot fix that; bring the\n` +
				`app onto the active Space (click it in the Dock or ⌘-Tab to it), then re-run.`,
		);
		this.name = "TargetNotObservableError";
	}
}

const isAppContent = (e: any) => !String(e.role ?? "").startsWith("AXMenu");

export async function assertObservable(driver: Driver, win: WindowRef, app: string): Promise<void> {
	const state = await driver.act({
		kind: "tool",
		name: "get_window_state",
		args: { pid: win.pid, window_id: win.windowId },
	});
	const elements: any[] = JSON.parse(state.structuredJson ?? "{}").elements ?? [];
	const content = elements.filter(isAppContent).length;
	if (content === 0)
		throw new TargetNotObservableError(app, `${elements.length} AX elements, none of them app content`);
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
 * Observability with one recovery attempt: an unobservable target is foregrounded and
 * re-probed before the run is abandoned. Returns the window to use — possibly a NEW one,
 * because an app that was running with no open windows gets a fresh window id from the
 * relaunch, and the id probed a moment earlier then belongs to nothing.
 */
export async function ensureObservable(driver: Driver, win: WindowRef, app: string): Promise<WindowRef> {
	try {
		await assertObservable(driver, win, app);

		return win;
	} catch (err) {
		if (!(err instanceof TargetNotObservableError)) throw err;
	}

	console.log(`"${app}" is not observable — foregrounding it and retrying`);
	await foregroundApp(driver, app, win.pid);
	const fresh = await findWindow(driver, app);
	// Throws TargetNotObservableError again if foregrounding did not help — which is the
	// off-Space case, and its message says so.
	await assertObservable(driver, fresh, app);
	if (fresh.windowId !== win.windowId || fresh.pid !== win.pid)
		console.log(`recovered on a different window: pid=${fresh.pid} window=${fresh.windowId}`);

	return fresh;
}

export async function observe(driver: Driver, win: WindowRef, shotName: string): Promise<ObservationBundle> {
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

	// Chromium labels every undescribed image with this; it names no control and is pure
	// tokens. Dropping it also lets the DOM class become the element's only name, which is
	// the useful one (`.icon--name--chevronDown`).
	const CHROMIUM_IMAGE_PLACEHOLDER = "To get missing image descriptions";

	const lines: string[] = [];
	const haystackParts: string[] = [];
	const frames = new Map<string, { x: number; y: number }>();
	for (const e of elements) {
		let label = (e.label ?? "").toString().replace(/\s+/g, " ");
		if (label.startsWith(CHROMIUM_IMAGE_PLACEHOLDER)) label = "";
		const value = (e.value ?? "").toString().replace(/\s+/g, " ");
		if (label) haystackParts.push(label);
		if (value) haystackParts.push(value);
		const descriptor = axdom.lookup(dom, e.frame);
		const interesting =
			label || value || descriptor ||
			["AXButton", "AXTextField", "AXPopUpButton", "AXMenuItem", "AXCheckBox", "AXRadioButton", "AXComboBox", "AXLink"].includes(e.role);
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

export function observationBlocks(obs: ObservationBundle, vision = true): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
	const text: Anthropic.TextBlockParam = { type: "text", text: `Window title: "${obs.title}"\nElements:\n${obs.elementsText}` };
	if (!vision) return [text];

	return [text, { type: "image", source: { type: "base64", media_type: "image/png", data: obs.screenshotB64 } }];
}

/**
 * Per-app "home" state: where a run must start so results are comparable.
 *
 * A run that begins wherever the last run happened to stop is not a measurement — it
 * inherits that run's navigation for free. (Measured: the Yarn cursor task took 3 actions
 * starting on the settings page it ends on, vs 4 from the app's home view — the difference
 * is entirely the navigation step the warm start skipped.)
 *
 * `label` is matched against element labels in the observation; the first match is clicked
 * with foreground delivery. Apps absent from this map get no reset, and the run log records
 * `homeReset: "none"` so the omission is visible rather than silent.
 */
const APP_HOME: Record<string, { label: string; description: string }> = {
	yarn: { label: "Library", description: "left-rail Library view" },
	"notion-calendar": { label: "Today", description: "current week, no modal open" },
};

export type HomeResetResult = "reset" | "already-home" | "none" | "failed";

export async function resetToHome(
	driver: Driver,
	win: WindowRef,
	app: string,
): Promise<{ result: HomeResetResult; detail: string }> {
	const home = APP_HOME[appSlug(app)];
	if (!home) return { result: "none", detail: `no home state declared for "${app}"` };

	// An overlay left open by the previous run hides the sidebar: Yarn's dropdowns overlay
	// the page and sidebar elements vanish from the AX tree entirely, so the home control
	// is simply not there. That surfaced as homeReset "failed" and a run that silently
	// started wherever the last one stopped — the exact non-comparability the reset exists
	// to prevent. Escape first, then retry once.
	let obs = await observe(driver, win, "home-reset-probe");
	let line = obs.elementsText.split("\n").find((l) => l.includes(`"${home.label}"`));
	let dismissed = false;
	if (!line) {
		await driver.act({
			kind: "tool",
			name: "press_key",
			args: { pid: win.pid, window_id: win.windowId, key: "escape", delivery_mode: "foreground" },
		});
		await new Promise((r) => setTimeout(r, 900));
		obs = await observe(driver, win, "home-reset-probe");
		line = obs.elementsText.split("\n").find((l) => l.includes(`"${home.label}"`));
		dismissed = true;
	}
	if (!line)
		return { result: "failed", detail: `home control "${home.label}" not present, even after escape` };

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
		detail: `${dismissed ? "escaped a leftover overlay, then " : ""}clicked "${home.label}" → ${home.description}`,
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

		return { staged: true, detail: `filled its current display @ ${r.frame.w}x${r.frame.h}${lowDpi}` };
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
export function scopeWarnings(map: AppMap): string {
	const ambiguities = findScopeAmbiguities(map);
	if (ambiguities.length === 0) return "";

	// Route to each option, so "both paths" is actionable rather than a label. Edges are
	// keyed by node id; a control's route is the path to its parent surface.
	const routeTo = (nodeId: string): string => {
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
	};

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
			.map((n) => `    · ${n.scope} scope — ${n.id}\n      route: ${routeTo(n.id)}`)
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

export function loadAppMapGraph(app: string): AppMap | undefined {
	const path = `${process.cwd()}/docs/appmaps/${appSlug(app)}.json`;
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
