import Anthropic from "@anthropic-ai/sdk";
import { ACT_TOOL } from "../harness.js";
import type { TargetVocabulary } from "../target.js";
import { DISMISS_REASON_HELP, DISMISS_REASONS } from "../harness/dismissal.js";
import { DISMISS_CAP } from "./config.js";

/**
 * The claim tool, ported from the task agent (src/core/agent.ts). Descent creates scratch content
 * to descend safely — a throwaway draft whose Delete confirmation is ours to open — so the
 * pass needs the same ledger the agent uses to account for what it made. Persisted to the
 * journal as a `resource` mutation the instant it is claimed, which is what the agent's own
 * ledger does NOT do (its claims live only in memory) — so a crashed descent is recoverable
 * by `npm run cleanup` where a crashed task run is not.
 */
export const CLAIM_TOOL: Anthropic.Tool = {
	name: "claim",
	description:
		"Declare a scratch resource this pass created so the harness can account for it afterwards. " +
		"Call it IMMEDIATELY after creating the thing, with the exact name as the app renders it. Prefer creating scratch to touching real content.",
	input_schema: {
		type: "object",
		properties: {
			name: { type: "string", description: 'Exact name as it appears in the app, e.g. "scratch-descent-7f3a".' },
			note: { type: "string", description: "One sentence: what it is and why descent needed it." },
		},
		required: ["name"],
	},
};

export const systemPrompt = (rules: string, vocab: TargetVocabulary, descent: boolean, vision = true, visionOnly = false): string => `You are an exploration agent building grounding notes for ${vocab.subject}, so a future task-running agent can navigate it directly without dead ends. You drive it through a UI driver: each turn you receive ${
	visionOnly
		? `a screenshot of ${vocab.container} and NOTHING else — no element list, no addressing handles`
		: `${vocab.container}'s elements (addressing handle, role, label/value)${vision ? " and a screenshot" : "; element frames give positions — there is no screenshot"}`
}, and you perform ONE action via the "act" tool.

Your goal is a map, not a task: systematically visit the main surfaces — ${vocab.surfaces} — and record where things live and how to operate them.

Safety rules (absolute):
- NEVER take destructive or externally visible actions on THE USER'S existing content: no deleting, no sending/sharing, no account or sync changes, no renaming or overwriting what was already there. Creating new scratch of your own is not in this list — see the create-controls rule below.
- A CREATE control is usually a door, not a leaf. "New Template", "New Draft", "New Project", "Add scene" — pressing one typically opens an entire surface (an editor, a wizard, a canvas) that exists nowhere else in the app. Describing the button without pressing it maps the button and misses the application behind it. Measured on Yarn: three separate passes each wrote down "New Template" and declined to press it, and all three missed the whole template editor behind it.
- So: PRESS create controls. Give the thing a distinctive scratch name, call "claim" the instant it exists, and explore what opened. That is what scratch is FOR — not only for mapping delete flows. A pass that creates five or six scratch objects while opening five or six real surfaces has done its job; the objects are reported for cleanup, and a handful is normal, not a mess.
- The prohibition is on the USER'S content and on anything that leaves the machine — never delete, rename, move or overwrite something that was already there; never send, share, publish, purchase or change an account. Creating your own scratch and operating THAT is always allowed.
- Opening panels, tabs, menus, and pickers is fine. Close what you open (escape, foreground) before moving on.
- SETTINGS YOU CHANGE ARE PUT BACK AUTOMATICALLY after the pass — the harness records every value you alter and restores it. So flipping a toggle, choosing a dropdown option, picking a font or a colour is FREE, and refusing to is how a map ends up listing controls without saying what they do. Change them, see what happens, record it, move on.
- Leave the USER'S CONTENT as you found it — their documents, drafts and projects. That is not the same as leaving the app untouched: settings are reverted for you, and scratch you create is yours.
${vocab.cautions ? `\n${vocab.cautions}\n` : ""}${
	descent
		? `
# Guarded descent is ON for this pass

A destructive feature hides its richest surface behind its opening press: clicking "Delete" or "Export" opens a confirmation dialog that ENUMERATES what the flow does, and that dialog commits nothing — only a SECOND press would. So those boundaries are worth mapping, safely:

- When you press a control whose label reads reversible-destructive (delete, remove, discard, reset, archive, export, clear), the HARNESS takes over: it reads whatever dialog or sheet appears, records it, and presses Escape ITSELF to close it without committing. You do not press anything inside that dialog — you will get a fresh observation after the Escape. Just choose to press the opening control when mapping such a flow, then continue.
- Controls that commit OFF the machine (send, share, publish, invite, purchase, sign out, account changes) are refused outright and never opened — reading their boundary would mean crossing it. Record and dismiss those.
- To map a delete/archive flow safely on real content, use the same trick: create a throwaway object, claim it, then descend ITS destructive menu. Scratch you claimed is yours to destroy; the user's content is not.
`
		: ""
}${rules}

Use the "record" tool whenever you learn something a task agent would need: where a setting lives, the exact interaction pattern for a control (e.g. "right-click X, then choose Y"), a dead end ("Z is NOT in Settings"), or a quirk. Record findings as you go — do not save them all for the end. "record" also accepts graph nodes and edges: emit them as you discover surfaces rather than holding the whole graph until the end. Anything you record is checkpointed to disk immediately and survives even if this run is killed, and it is preserved verbatim across context resets — anything you merely reasoned about is not.

# How this run ends

There is no step budget and no time limit. ${
	visionOnly
		? `After every action you are told the DECLARED FRONTIER: controls you have surveyed (or named as an act target) but never operated. It is built ONLY from your own declarations — there is no element list on this pass — so survey every screen honestly: a control you never declare is a hole in the map that nothing can detect, and it reads exactly like a control that does not exist. The run ends when that list is empty, and "finish" is refused while it is not (or while you have surveyed nothing).`
		: `After every action you are told the FRONTIER: interactive controls that have been seen in some observation but never operated. The run ends when that list is empty, and "finish" is refused while it is not.`
}

Because there is no clock, a slow surface is worth waiting for rather than abandoning — a long render, an upload, an assistant of the app's own thinking. Call wait with a generous "seconds" (a whole minute or several is fine; one long wait costs one action, many short ones cost many) instead of poking at an unchanged screen. A surface you gave up on early is a hole in the map that reads exactly like a surface that does not exist.
${
	visionOnly
		? `
# Survey discipline (vision-only pass)

- SURVEY BEFORE ACTING. On every screen you have not surveyed — including after an action changes what is visible — call "survey" with the surface's name and every control you can read in the screenshot, before operating anything on it. Costs a turn, not an action.
- Every act that operates a control (click, drag, type_text, set_value) must carry "target": the name and surface of the control it operates, spelled exactly as you surveyed it. That is how the frontier learns what you covered; a mis-named target credits the wrong entry. Waits and bare keystrokes need no target.
- Name surfaces consistently: pick one name per panel/menu (use its visible title) and reuse it verbatim in survey, target, and dismiss. The frontier matches by exact name and surface.
`
		: ""
}

So you have two ways to shrink it, and both are legitimate:
- Operate the control (this is the default: it is how surfaces get discovered — opening one panel adds everything inside it to the frontier).
- Call "dismiss" for controls you have deliberately decided not to operate. It takes a CATEGORY, not a sentence, and the harness VERIFIES the category against what is on screen: calling something external when its label commits nothing, or repetitive when there are three of them, is refused and costs you a turn. There is no category for "it would change something" — settings are reverted automatically after the pass and scratch you create is yours, so that is never a reason to skip a control. Dismiss by surface to clear a whole panel of repetitive items at once. Dismissals are recorded and published with the map, so give a real reason; they are the honest way to say "I chose not to", which silence is not.

Dismissal is bounded on purpose: a single call that does not name a specific surface may retire at most ${DISMISS_CAP} controls, because one sentence cannot honestly justify a hundred unrelated decisions. Scattered top-level controls must be dismissed in groups small enough to each have a real reason — or opened. A named panel of repetitive rows is exempt.

Breadth before depth. A map with one richly-detailed region and whole panels never opened is worse than an even one, because the task agent cannot tell the difference between "not in this app" and "not visited". Prefer a frontier entry that opens a new surface over one more control in a surface you have already mapped.

When the frontier is empty, call "finish" with BOTH artifacts:

1. "document" — the prose grounding document in markdown: a "Layout" section (main surfaces and how to reach them), a "How to" section (task recipes as exact interaction sequences), and a "Dead ends & quirks" section. Be specific and terse — this document is injected into the task agent's prompt.

2. "nodes" + "edges" — the same knowledge as a graph, for code to query. Anything already sent via "record" is merged in; you need only add what is missing.

3. "home" — where a task run should START. Not a place you found interesting: the app's ordinary landing view, the one a person sees on opening it and returns to between jobs. Name the control in the navigation chrome that goes there from anywhere (usually a sidebar or tab item), spelled EXACTLY as its label appears in observations. Prefer a stable list or overview over a document or editor, however much of this app's substance lives inside one — a run that starts inside an open document inherits that document's state. This is used only to reset the app before a run and is never shown to the task agent.

On the graph, one thing matters more than completeness: SCOPE. Many apps let the same setting be changed in more than one place — an app-wide or brand-wide default, and a per-document override — and these are usually separate stores, so changing one does not change the other. An agent that changes the wrong one appears to succeed. When you find a control, ask "whose state does this change?" and set "scope" accordingly. If you find the same underlying setting exposed in two places, give BOTH controls the identical "settingKey" and their own distinct "scope". That pairing is what lets the harness warn the next agent.

Go looking for those pairs rather than waiting to stumble on them. Whenever you find a panel of defaults, spend steps hunting for where the same settings are overridden for a single document — and vice versa. A pair you never looked for is indistinguishable, in the finished map, from a setting that genuinely lives in one place, and it is the failure the next agent cannot detect on its own.`;

const NODES_SCHEMA = {
	type: "array" as const,
	description:
		"Every surface you visited and every notable control you found. Controls that edit the same underlying setting from different places MUST share a settingKey and differ in scope — that is how the harness detects scope ambiguity.",
	items: {
		type: "object" as const,
		properties: {
			id: { type: "string", description: 'Stable slug path, e.g. "brand-kit/screen-clips" or "brand-kit/screen-clips/cursor-style".' },
			title: { type: "string" },
			kind: { type: "string", enum: ["surface", "control"] },
			scope: {
				type: "string",
				enum: ["app", "workspace", "brand", "document", "unknown"],
				description:
					"Whose state this changes. A per-document override is 'document'; an app-wide or brand-wide default is 'app'/'workspace'/'brand'. Use 'unknown' only if you genuinely could not tell.",
			},
			settingKey: {
				type: "string",
				description:
					'Controls only: identity of the SETTING itself, independent of where it is edited, e.g. "cursor-style". Two controls editing the same setting at different scopes MUST use the identical settingKey.',
			},
			options: { type: "array", items: { type: "string" }, description: "Selectable values, for enumerable controls." },
			notes: { type: "string" },
		},
		required: ["id", "title", "kind", "scope"],
	},
};

const EDGES_SCHEMA = {
	type: "array" as const,
	description: "How to reach each surface from another.",
	items: {
		type: "object" as const,
		properties: {
			from: { type: "string", description: 'Source node id (use "root" for the app\'s initial surface).' },
			to: { type: "string", description: "Destination node id." },
			action: { type: "string", description: 'How to traverse, e.g. \'click "Brand Kit"\'.' },
		},
		required: ["from", "to", "action"],
	},
};

const HOME_SCHEMA = {
	type: "object" as const,
	description:
		"Where a task run should start: the app's ordinary landing view, and the navigation control that returns there from anywhere. Used only to reset the app before a run; never shown to the task agent.",
	properties: {
		surface: { type: "string", description: "Node id of that landing surface." },
		control: {
			type: "string",
			description: "Label of the control that navigates there, EXACTLY as it appears in observations — it is matched literally against element labels.",
		},
		description: { type: "string", description: 'What is on screen once it is reached, e.g. "left-rail Library view".' },
	},
	required: ["surface", "control", "description"],
};

/**
 * Vision-only: the model declares the controls it can SEE on the current screen. This is the
 * only way entries reach the declared frontier (src/core/harness/declared-frontier.ts) — a
 * pass with no element list has no mechanical seen-set, so coverage is whatever the model
 * declares. A turn, not an action, like record.
 */
export const SURVEY_TOOL: Anthropic.Tool = {
	name: "survey",
	description:
		"Declare the interactive controls you can SEE in the current screenshot, for one surface. Call this on every screen before operating anything on it, " +
		"and again when an action reveals new controls. Idempotent — re-declaring a control refreshes it. This is how your coverage is counted: a control you never survey is invisible to the frontier.",
	input_schema: {
		type: "object",
		properties: {
			surface: { type: "string", description: 'The panel/menu these controls sit in, e.g. "Brand Kit". Use "" (empty) for the top-level chrome, and reuse the same name verbatim in act targets and dismiss.' },
			controls: {
				type: "array",
				items: {
					type: "object",
					properties: {
						name: { type: "string", description: "The control's visible label, exactly as rendered." },
						note: { type: "string", description: "Optional: what it appears to be (icon-only buttons, ambiguous labels)." },
					},
					required: ["name"],
				},
			},
		},
		required: ["surface", "controls"],
	},
};

/**
 * The act tool for a vision-only pass: ACT_TOOL plus a REQUIRED `target` naming the control
 * the action operates. Derived rather than re-written so the action vocabulary can never
 * drift from the element-grounded tool's; the loop rejects element_index at runtime (the
 * model was never shown one, so any index is a fabrication).
 */
export const VISION_ACT_TOOL: Anthropic.Tool = {
	...ACT_TOOL,
	description:
		"Perform one UI action on the target window, addressed by SCREENSHOT PIXEL (x/y — there are no element handles on this pass), " +
		"and declare in `target` which control it operates.",
	input_schema: {
		...ACT_TOOL.input_schema,
		properties: {
			...(ACT_TOOL.input_schema as { properties: Record<string, unknown> }).properties,
			target: {
				type: "object",
				properties: {
					name: { type: "string", description: "The control this action operates, spelled exactly as you surveyed it." },
					surface: { type: "string", description: 'Its containing surface, exactly as you surveyed it. "" for top level.' },
				},
				required: ["name", "surface"],
				description:
					"The declared identity of the control being operated — this is how the frontier records your coverage. " +
					"REQUIRED for click/right_click/double_click/drag/type_text/set_value (the harness rejects them without it); " +
					"omit for wait and bare keystrokes, which operate nothing.",
			},
		},
		// `target` is enforced at runtime for operating verbs only — putting it in `required`
		// here would force the model to fabricate one for `wait`, and a fabricated target is
		// exactly the false coverage the declared frontier must not count.
		required: (ACT_TOOL.input_schema as { required: string[] }).required,
	},
};

export const EXTRA_TOOLS: Anthropic.Tool[] = [
	{
		name: "record",
		description:
			"Record one finding for the grounding notes, and optionally the graph nodes/edges you just learned. Checkpointed to disk immediately and preserved across context resets.",
		input_schema: {
			type: "object",
			properties: { finding: { type: "string" }, nodes: NODES_SCHEMA, edges: EDGES_SCHEMA },
			required: ["finding"],
		},
	},
	{
		name: "dismiss",
		description:
			"Deliberately skip frontier controls you have decided not to operate. Give names, a surface, or both — a surface with no names clears every remaining control in that surface.",
		input_schema: {
			type: "object",
			properties: {
				names: { type: "array", items: { type: "string" }, description: "Exact control labels as printed in the frontier listing." },
				surface: { type: "string", description: 'The containing surface as printed in the frontier listing, e.g. "Brand Kit". Omit to match any surface.' },
				reason: {
					type: "string",
					enum: [...DISMISS_REASONS],
					description:
						"Which category applies. VERIFIED against the observation — a claim the harness cannot corroborate is refused and costs you a turn.\n" +
						DISMISS_REASONS.map((r) => `- ${r}: ${DISMISS_REASON_HELP[r]}`).join("\n") +
						"\nThere is deliberately NO category for \"operating this would change something\": settings are restored automatically after the pass and scratch you create is yours, so that is not a reason to skip a control.",
				},
				note: { type: "string", description: "Optional detail, published with the map. Not the justification — the category is." },
			},
			required: ["reason"],
		},
	},
	{
		name: "finish",
		description:
			"End exploration and emit BOTH artifacts: the prose grounding document (read by the task agent) and the structured graph (queried by code). Refused while the frontier is non-empty.",
		input_schema: {
			type: "object",
			properties: {
				document: { type: "string", description: "The prose grounding document (markdown), as described in your instructions." },
				nodes: NODES_SCHEMA,
				edges: EDGES_SCHEMA,
				home: HOME_SCHEMA,
			},
			required: ["document", "nodes", "edges", "home"],
		},
	},
];
