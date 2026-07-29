import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import { Driver } from "./driver.js";
import { OUT, type ObservationBundle, type WindowRef } from "./harness.js";
import type { ActionRequest } from "./types.js";

const DOM_ACTIONS = ["click", "right_click", "double_click", "hover", "type_text", "press_key", "scroll", "wait"] as const;

interface SemanticRef {
	ref: string;
	role: string;
	name: string | null;
	value: string | null;
	actions: string[];
	visibility: string;
	frame: string;
}

/**
 * DOM backend: observes and acts on an Electron/browser target over CDP via the
 * driver's browser_* tools, instead of the AX tree. Requires the target to expose
 * a DevTools endpoint (Electron: relaunch with --remote-debugging-port=<port>).
 * press_key stays on the AX path — OS-level keys (escape, cmd-shortcuts) have no
 * CDP equivalent that reaches the app's native layer.
 */
export class DomBackend {
	private constructor(
		private driver: Driver,
		private win: WindowRef,
		private targetId: string,
		private tabId: string,
	) {}

	static async bind(driver: Driver, win: WindowRef): Promise<DomBackend> {
		const r = await driver.act({
			kind: "tool",
			name: "get_browser_state",
			args: { pid: win.pid, window_id: win.windowId },
		});
		const bs = JSON.parse(r.structuredJson ?? "{}");
		const tab = bs.tabs?.[0];
		if (!bs.target_id || !tab)
			throw new Error(`CDP bind failed for pid=${win.pid}: ${r.text.slice(0, 200)}`);

		console.log(`DOM backend bound: ${bs.target_id} (${bs.binding_quality}) tab "${tab.title}"`);

		return new DomBackend(driver, win, bs.target_id, tab.tab_id);
	}

	private get target(): Record<string, unknown> {
		return { target_id: this.targetId, tab_id: this.tabId };
	}

	async observe(shotName: string): Promise<ObservationBundle> {
		const snap = await this.driver.act({
			kind: "tool",
			name: "get_browser_state",
			args: { ...this.target, snapshot_format: "semantic_v2" },
		});
		const sj = JSON.parse(snap.structuredJson ?? "{}");
		const actionRefs: SemanticRef[] = sj.refs ?? [];
		const contentRefs: SemanticRef[] = sj.content_refs ?? [];

		const lines: string[] = [];
		const haystackParts: string[] = [];
		for (const r of actionRefs) {
			if (r.name) haystackParts.push(r.name);
			if (r.value) haystackParts.push(r.value);
			const val = r.value && r.value !== r.name ? ` value="${r.value.slice(0, 80)}"` : "";
			const vis = r.visibility !== "in_viewport" ? ` ${r.visibility}` : "";
			lines.push(`[${r.ref}] ${r.role} "${(r.name ?? "").slice(0, 80)}"${val} (${r.actions.join(",")})${vis}`);
		}
		const texts = new Set<string>();
		for (const r of contentRefs) {
			if (!r.name || texts.has(r.name)) continue;
			texts.add(r.name);
			haystackParts.push(r.name);
		}

		const title = sj.page?.title ?? "";
		const truncated = sj.snapshot?.complete === false ? "\n(snapshot truncated — some elements omitted)" : "";
		const elementsText =
			`Interactive refs:\n${lines.join("\n")}\n\nVisible text: ${[...texts].slice(0, 120).map((t) => JSON.stringify(t.slice(0, 60))).join(", ")}${truncated}`;

		const shotPath = `${OUT}/${shotName}.png`;
		await this.driver.act({
			kind: "tool",
			name: "get_window_state",
			args: { pid: this.win.pid, window_id: this.win.windowId, screenshot_out_file: shotPath },
		});

		return {
			elementsText,
			haystack: `${title}\n${haystackParts.join("\n")}`.toLowerCase(),
			screenshotB64: fs.readFileSync(shotPath).toString("base64"),
			title,
			appContent: actionRefs.length,
		};
	}

	/**
	 * Same contract as harness.toActionRequest: null for wait, throws for
	 * unsupported actions (caller reports back to the model, run continues).
	 */
	toRequest(a: any): ActionRequest | null {
		switch (a.name) {
			case "wait":
				return null;
			case "click":
				return { kind: "tool", name: "browser_click", args: { ...this.target, ref: a.ref } };
			case "right_click":
			case "double_click":
			case "hover":
				return { kind: "tool", name: "browser_pointer", args: { ...this.target, action: a.name, ref: a.ref } };
			case "type_text":
				return { kind: "tool", name: "browser_type", args: { ...this.target, ref: a.ref, text: a.text, ...(a.mode ? { mode: a.mode } : {}) } };
			case "scroll":
				return {
					kind: "tool",
					name: "browser_pointer",
					args: {
						...this.target,
						action: "scroll",
						...(a.ref ? { ref: a.ref } : {}),
						delta_x: a.direction === "left" ? -(a.amount ?? 3) * 120 : a.direction === "right" ? (a.amount ?? 3) * 120 : 0,
						delta_y: a.direction === "up" ? -(a.amount ?? 3) * 120 : a.direction === "down" ? (a.amount ?? 3) * 120 : 0,
					},
				};
			case "press_key":
				return {
					kind: "tool",
					name: "press_key",
					args: {
						pid: this.win.pid,
						window_id: this.win.windowId,
						key: a.key,
						...(a.modifiers ? { modifiers: a.modifiers } : {}),
						...(a.delivery_mode ? { delivery_mode: a.delivery_mode } : {}),
					},
				};
			default:
				throw new Error(`unsupported action "${a.name}" — DOM backend supports: ${DOM_ACTIONS.join(", ")}`);
		}
	}
}

export const DOM_RULES = `Rules learned from this driver's DOM/CDP path (follow them):
- Address elements by ref (like "p3:7") from the CURRENT observation only — refs are invalidated by newer snapshots.
- Each ref lists its capabilities: only "click" refs take click; "pointer" refs take right_click/double_click/hover/scroll; "type" refs (textboxes) take type_text directly — type_text focuses the field itself, no click needed first.
- type_text INSERTS at the cursor. To replace existing text: type_text once to focus, then press_key cmd+a, press_key delete, then type_text the new value.
- press_key goes through the OS, not CDP: escape to close overlays and menu shortcuts (cmd+,) need delivery_mode "foreground". Everything else runs fully backgrounded — the app never needs focus.
- The visible-text list is your verification surface; element names come from the accessibility name, so unnamed containers appear as "".`;

export const DOM_ACT_TOOL: Anthropic.Tool = {
	name: "act",
	description: "Perform one UI action on the target page and state the expected observable effect.",
	input_schema: {
		type: "object",
		properties: {
			reasoning: { type: "string", description: "One sentence: why this action now." },
			action: {
				type: "object",
				properties: {
					name: { type: "string", enum: [...DOM_ACTIONS] },
					ref: { type: "string", description: "Target ref from the current observation (click/right_click/double_click/hover/type_text, optional for scroll)." },
					text: { type: "string", description: "For type_text." },
					key: { type: "string", description: "For press_key: return, tab, escape, up, down, a-z, 0-9, etc." },
					modifiers: { type: "array", items: { type: "string" }, description: "For press_key: cmd, shift, option, ctrl." },
					delivery_mode: { type: "string", enum: ["background", "foreground"], description: "For press_key." },
					direction: { type: "string", enum: ["up", "down", "left", "right"], description: "For scroll." },
					amount: { type: "integer", description: "For scroll: wheel notches." },
				},
				required: ["name"],
			},
			expectation: {
				type: "object",
				properties: {
					description: { type: "string" },
					textIncludes: { type: "array", items: { type: "string" }, description: "REQUIRED unless textExcludes is given. Substrings that should appear in the next observation." },
					textExcludes: { type: "array", items: { type: "string" }, description: "Substrings that should NOT appear in the next observation. Satisfies the checkable-expectation requirement on its own." },
				},
				required: ["description"],
				description: "You MUST supply textIncludes and/or textExcludes. An act call with only a prose description is REJECTED WITHOUT BEING EXECUTED.",
			},
		},
		required: ["action", "expectation"],
	},
};
