import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
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
			`"${app}" is running but not observable (${detail}).\n` +
				`Most likely it is on an inactive macOS Space — another app is fullscreen, or the\n` +
				`window is on a different desktop. Programmatic activation cannot fix this; bring the\n` +
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

export async function observe(driver: Driver, win: WindowRef, shotName: string): Promise<ObservationBundle> {
	const shotPath = `${OUT}/${shotName}.png`;
	const state = await driver.act({
		kind: "tool",
		name: "get_window_state",
		args: { pid: win.pid, window_id: win.windowId, screenshot_out_file: shotPath },
	});
	const structured = JSON.parse(state.structuredJson ?? "{}");
	const elements: any[] = structured.elements ?? [];

	const lines: string[] = [];
	const haystackParts: string[] = [];
	for (const e of elements) {
		const label = (e.label ?? "").toString().replace(/\s+/g, " ");
		const value = (e.value ?? "").toString().replace(/\s+/g, " ");
		if (label) haystackParts.push(label);
		if (value) haystackParts.push(value);
		const interesting =
			label || value ||
			["AXButton", "AXTextField", "AXPopUpButton", "AXMenuItem", "AXCheckBox", "AXRadioButton", "AXComboBox", "AXLink"].includes(e.role);
		if (!interesting) continue;
		const f = e.frame ? ` @(${e.frame.x},${e.frame.y} ${e.frame.w}x${e.frame.h})` : "";
		const val = value && value !== label ? ` value="${value.slice(0, 80)}"` : "";
		lines.push(`[${e.element_index}] ${e.role} "${label.slice(0, 80)}"${val}${f}${e.selected ? " SELECTED" : ""}${e.enabled === false ? " DISABLED" : ""}`);
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
	};
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
const win = procs[0].windows[0];

// A fullscreen window already fills its display; touching position would demote it.
let fullscreen = false;
try { fullscreen = win.attributes["AXFullScreen"].value(); } catch (e) {}
if (fullscreen) JSON.stringify({action: "left-fullscreen"});
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
`;
	try {
		const out = execFileSync("osascript", ["-l", "JavaScript", "-e", script], { encoding: "utf8" }).trim();
		const r = JSON.parse(out);
		if (r.action === "left-fullscreen")
			return { staged: true, detail: "window is native-fullscreen — left as is" };

		const lowDpi = r.scale < 2 ? " (1x display — check frames if the video looks off)" : "";

		return { staged: true, detail: `filled its current display @ ${r.frame.w}x${r.frame.h}${lowDpi}` };
	} catch (err) {
		return { staged: false, detail: err instanceof Error ? err.message.split("\n")[0] : String(err) };
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

	const lines = ambiguities.map((a) => {
		const where = a.nodes.map((n) => `${n.id} (${n.scope} scope)`).join(" vs ");

		return `- "${a.settingKey}" can be changed in more than one place: ${where}. These are SEPARATE stores — changing one does not change the other. If the task does not say which scope it means, prefer the broadest (app/workspace/brand) default rather than a single document's override, and say in your summary which scope you changed.`;
	});

	return `\n\n# Ambiguous settings in this app (from the structured appmap — read carefully)\n${lines.join("\n")}`;
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

export interface VerifyResult {
	verified: boolean;
	note: string;
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

	return { verified: true, note: "expectation met" };
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
			return { kind: "tool", name: a.name, args: { ...base, element_index: a.element_index } };
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
- A silent no-op click means your next keystrokes hit global shortcuts and can open random overlays. If the observation shows an unexpected overlay, close it (escape, foreground) before continuing.`;
