import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import { Driver } from "./driver.js";
import type { ActionRequest } from "./types.js";

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

	return {
		elementsText: lines.join("\n"),
		haystack: `${title}\n${haystackParts.join("\n")}`.toLowerCase(),
		screenshotB64: fs.readFileSync(shotPath).toString("base64"),
		title,
	};
}

export function observationBlocks(obs: ObservationBundle): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
	return [
		{ type: "text", text: `Window title: "${obs.title}"\nElements:\n${obs.elementsText}` },
		{ type: "image", source: { type: "base64", media_type: "image/png", data: obs.screenshotB64 } },
	];
}

export function toActionRequest(a: any, win: WindowRef): ActionRequest {
	const base = { pid: win.pid, window_id: win.windowId };
	switch (a.name) {
		case "click":
		case "right_click":
		case "double_click":
			return { kind: "tool", name: a.name, args: { ...base, element_index: a.element_index } };
		case "type_text":
			return { kind: "tool", name: "type_text", args: { ...base, text: a.text, ...(a.delivery_mode ? { delivery_mode: a.delivery_mode } : {}) } };
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
			return { kind: "tool", name: "set_value", args: { ...base, element_index: a.element_index, text: a.text } };
		case "scroll":
			return {
				kind: "tool",
				name: "scroll",
				args: { ...base, direction: a.direction, ...(a.amount ? { amount: a.amount } : {}), ...(a.element_index !== undefined ? { element_index: a.element_index } : {}) },
			};
		default:
			throw new Error(`unknown action ${a.name}`);
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
					name: {
						type: "string",
						enum: ["click", "right_click", "double_click", "type_text", "press_key", "set_value", "scroll"],
					},
					element_index: { type: "integer", description: "Target element from the current observation (click/right_click/double_click/set_value, optional focus target for press_key)." },
					text: { type: "string", description: "For type_text/set_value." },
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
					textIncludes: { type: "array", items: { type: "string" }, description: "Substrings that should appear in the next observation." },
					textExcludes: { type: "array", items: { type: "string" }, description: "Substrings that should NOT appear in the next observation." },
				},
				required: ["description"],
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
