import Anthropic from "@anthropic-ai/sdk";
import type { ActionRequest } from "../../types.js";
import type { WindowRef } from "./observation.js";

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
 * The vision-only measurement arm's replacement for DRIVER_RULES. Exists because most of
 * DRIVER_RULES teaches element_index discipline, and an agent with no element list needs the
 * opposite: everything is a painted target. Expectations still work unchanged — verification
 * reads the harness's own observation, which keeps its element text regardless of what the
 * model was shown — and that is what makes this arm comparable to the others at all.
 */
export const VISION_ONLY_RULES = `Rules for this driver (follow them):
- You see the screenshot ONLY. There is no element list and no element_index — never pass one. Address every click/drag by screenshot pixel: x/y on click, from_x/from_y/to_x/to_y on drag.
- Screenshot pixels are exactly what the driver consumes — the pixel you read IS the pixel it acts on.
- Aim at the CENTER of the thing you mean. Small targets punish edge guesses.
- Text fields are often pre-filled: click the field to focus it, then press cmd+a, then type. Never type without focusing first.
- Menu-bar keyboard shortcuts (like cmd+,) need delivery_mode "foreground". Escape to close overlays also usually needs "foreground".
- A silent no-op click means your next keystrokes hit global shortcuts and can open random overlays. If the screenshot shows an unexpected overlay, close it (escape, foreground) before continuing.
- Your expectations are still checked against the app's rendered text (the harness reads it even though you cannot), so write textIncludes/textExcludes with the literal strings you can READ IN THE SCREENSHOT.
- Dragging a thing puts it under wherever you released. A reverse drag is NOT an undo.`;
