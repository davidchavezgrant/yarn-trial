import type { GatedBoundary } from "../../types.js";
import type { InteractiveElement, ObservationBundle } from "./observation.js";

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
 *
 * "Destructive" is two different questions fused into one word, and they have opposite
 * answers once a descent capability exists — so the verb set is split into two gates and
 * `destructiveTarget()` remains their union:
 *
 * - EXTERNALITY: the action commits something OFF the machine (send, publish, purchase,
 *   account change). Genuinely one-way; refused always, descent or not.
 * - REVERSIBLE: the action mutates local state that can in principle be put back (delete on
 *   scratch, reset, archive) or merely opens a local flow (export's panel). Refused by
 *   default, but eligible for guarded descent — see explore's EXPLORE_DESCENT.
 *
 * A verb belongs to exactly one gate; tests pin both the partition and the union.
 */
const EXTERNALITY_LABEL =
	/\b(publish|send|share|invite|buy|purchase|subscribe|unsubscribe|sign ?out|log ?out|revoke|deactivate)\b/i;
const REVERSIBLE_LABEL =
	/\b(delete|remove|discard|erase|trash|clear|export|download|reset|restore|merge|archive)\b/i;

/**
 * The same gates, retuned for the open web, where the verb set above is wrong in both
 * directions.
 *
 * Too narrow: a website's destructive act is usually a bare commit verb — Confirm, Submit,
 * Post, Reply, Accept, Place order — none of which appear above, and every one of which is
 * irreversible and externally visible in exactly the way the carve-out exists to prevent.
 * All of them are externality: a commit verb on the web ships state to a server.
 *
 * Too broad: `download` is on every documentation page on the internet, and blocking it would
 * refuse a large fraction of ordinary navigation. It (and `export`) is dropped here — a
 * download is a local side effect, not an externally visible one.
 */
const EXTERNALITY_LABEL_WEB =
	/\b(publish|send|share|invite|buy|purchase|subscribe|unsubscribe|sign ?out|log ?out|revoke|deactivate|confirm|submit|post|reply|accept|decline|place order|checkout|check out|pay|book|sign ?up|register|apply|transfer|withdraw)\b/i;
const REVERSIBLE_LABEL_WEB = /\b(delete|remove|discard|erase|trash|clear|reset|restore|merge|archive)\b/i;
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
	return externalityTarget(action, obs, web) ?? reversibleTarget(action, obs, web);
}

/**
 * Chords that make the target APP GO AWAY, named individually.
 *
 * The label guards above deliberately refuse to judge keystrokes, on the correct reasoning
 * that guessing at key combinations would block the pass from typing. This is not a guess.
 * These three chords have one meaning each on macOS and no legitimate use in a UI-automation
 * run: the agent never needs to quit, hide, or minimise the thing it is driving.
 *
 * Learned the expensive way on 2026-07-31: an explore pass 162 actions deep into Yarn pressed
 * cmd+Q. The label guard saw a keystroke with no control attached and passed it; the driver
 * then reported the target "running but not observable" and blamed an inactive macOS Space,
 * so the diagnostic sent the operator hunting for a window that no longer existed. The pass's
 * map was demoted to salvage and 162 actions of work went unfinished.
 *
 * cmd+W is NOT here: closing a tab or a dialog is ordinary navigation, and on a browser
 * target it is something a pass may legitimately need.
 */
const SESSION_ENDING_CHORDS: Array<{ key: string; meaning: string }> = [
	{ key: "q", meaning: "quits the application" },
	{ key: "h", meaning: "hides the application" },
	{ key: "m", meaning: "minimises the window" },
];

export function sessionEndingChord(action: any): string | undefined {
	if (String(action?.name) !== "press_key") return undefined;
	const mods = (Array.isArray(action?.modifiers) ? action.modifiers : []).map((m: unknown) => String(m).toLowerCase());
	if (!mods.some((m: string) => m === "cmd" || m === "command" || m === "meta")) return undefined;
	const key = String(action?.key ?? "").toLowerCase();
	const hit = SESSION_ENDING_CHORDS.find((c) => c.key === key);

	return hit ? `cmd+${hit.key} ${hit.meaning}` : undefined;
}

/**
 * The control this action would PRESS, or undefined when the action presses nothing.
 *
 * Only *pressing* things is guarded. A keystroke can be destructive too, but nothing
 * here can tell which one is, and guessing at key combinations would block the pass
 * from typing at all. The one exception is web: Enter is a submit, so an Enter aimed at a
 * NAMED control is treated as pressing that control. Enter with no target still passes —
 * see the hole documented above.
 */
function pressedTarget(action: any, obs: ObservationBundle, web: boolean): InteractiveElement | undefined {
	const target = actionTarget(action, obs);
	const pressing = ["click", "double_click", "right_click"];
	const isPress =
		pressing.includes(String(action?.name)) ||
		(web && String(action?.name) === "press_key" && /^(return|enter)$/i.test(String(action?.key ?? "")) && target !== undefined);

	return isPress ? target : undefined;
}

/**
 * Would this action commit something OFF the machine — send, publish, purchase, account
 * change? The hard gate: refused always, in code, descent or not. One-way is one-way.
 */
export function externalityTarget(action: any, obs: ObservationBundle, web = false): string | undefined {
	const target = pressedTarget(action, obs, web);
	if (!target) return undefined;
	const pattern = web ? EXTERNALITY_LABEL_WEB : EXTERNALITY_LABEL;

	return pattern.test(target.name) ? target.name : undefined;
}

/**
 * Would this action mutate LOCAL state that can in principle be put back — or open a local
 * flow behind a destructive-looking label? The soft gate: refused by default, but eligible
 * for guarded descent (open, read the boundary, Escape) when the caller opts in.
 */
export function reversibleTarget(action: any, obs: ObservationBundle, web = false): string | undefined {
	const target = pressedTarget(action, obs, web);
	if (!target) return undefined;
	const pattern = web ? REVERSIBLE_LABEL_WEB : REVERSIBLE_LABEL;

	return pattern.test(target.name) ? target.name : undefined;
}

/**
 * Node id for a gated boundary. Prefers a surface/label slug so it reads like the graph's own
 * ids; falls back to the raw label when the control resolved to nothing. Not required to match
 * a node in `nodes` — a gated control the pass never recorded as a node is exactly the hole the
 * boundary record exists to fill.
 */
export function gatedId(node: { surface: string; name: string } | undefined, label: string): string {
	const slugify = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
	const name = slugify(node?.name || label);
	const surface = node?.surface ? slugify(node.surface) : "";

	return surface ? `${surface}/${name}` : name;
}

/**
 * The prose "Gated flows" section, appended to the grounding document the task agent reads.
 *
 * This is the whole point of descent reaching the prose rather than only the graph: a task
 * agent given "show me how to export" now sees what the export dialog offers and where the
 * pass stopped, instead of a dead end. Only Tier-1 reads are worth prose — a Tier-0 refusal
 * says nothing a task agent can use. Empty string when there is nothing to say, so a
 * non-descent pass's document is byte-identical to before.
 */
export function gatedSection(gated: GatedBoundary[]): string {
	const read = gated.filter((g) => g.tierReached === 1);
	if (!read.length) return "";
	const lines = read.map((g) => `- **${g.id}** — ${g.boundary} _(stopped: ${g.stoppedBecause})_`);

	return (
		"\n\n## Gated flows (read at the boundary, not committed)\n\n" +
		"Destructive-labelled controls whose confirmation surface was opened and read under guarded descent, then Escaped without committing. " +
		"Use these to perform a delete/export/archive task up to — but not through — its point of no return.\n\n" +
		lines.join("\n") +
		"\n"
	);
}
