import Anthropic from "@anthropic-ai/sdk";
import type { TargetVocabulary } from "../target.js";
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

export const systemPrompt = (rules: string, vocab: TargetVocabulary, descent: boolean, vision = true): string => `You are an exploration agent building grounding notes for ${vocab.subject}, so a future task-running agent can navigate it directly without dead ends. You drive it through a UI driver: each turn you receive ${vocab.container}'s elements (addressing handle, role, label/value)${vision ? " and a screenshot" : "; element frames give positions — there is no screenshot"}, and you perform ONE action via the "act" tool.

Your goal is a map, not a task: systematically visit the main surfaces — ${vocab.surfaces} — and record where things live and how to operate them.

Safety rules (absolute):
- NEVER take destructive or externally visible actions: no deleting, no sending/sharing, no account or sync changes, no creating events/documents you can't discard, no toggling settings you don't revert.
- Opening panels, tabs, menus, and pickers is fine. Close what you open (escape, foreground) before moving on.
- Leave it in the state you found it.
${vocab.cautions ? `\n${vocab.cautions}\n` : ""}${
	descent
		? `
# Guarded descent is ON for this pass

A destructive feature hides its richest surface behind its opening press: clicking "Delete" or "Export" opens a confirmation dialog that ENUMERATES what the flow does, and that dialog commits nothing — only a SECOND press would. So those boundaries are worth mapping, safely:

- When you press a control whose label reads reversible-destructive (delete, remove, discard, reset, archive, export, clear), the HARNESS takes over: it reads whatever dialog or sheet appears, records it, and presses Escape ITSELF to close it without committing. You do not press anything inside that dialog — you will get a fresh observation after the Escape. Just choose to press the opening control when mapping such a flow, then continue.
- Controls that commit OFF the machine (send, share, publish, invite, purchase, sign out, account changes) are refused outright and never opened — reading their boundary would mean crossing it. Record and dismiss those.
- To map a delete/archive flow safely on real content, first CREATE a throwaway object (a scratch draft/project with a distinctive name) and call "claim" the instant it exists, then descend ITS destructive menu. Scratch you claimed is yours to open; the user's content is not.
- Settings you toggle while mapping are put back automatically after the pass, so a reversible toggle is fine to flip. Things you CREATE are reported, not deleted — one scratch object is fine, five is a mess left behind.
`
		: ""
}${rules}

Use the "record" tool whenever you learn something a task agent would need: where a setting lives, the exact interaction pattern for a control (e.g. "right-click X, then choose Y"), a dead end ("Z is NOT in Settings"), or a quirk. Record findings as you go — do not save them all for the end. "record" also accepts graph nodes and edges: emit them as you discover surfaces rather than holding the whole graph until the end. Anything you record is checkpointed to disk immediately and survives even if this run is killed, and it is preserved verbatim across context resets — anything you merely reasoned about is not.

# How this run ends

There is no step budget and no time limit. After every action you are told the FRONTIER: interactive controls that have been seen in some observation but never operated. The run ends when that list is empty, and "finish" is refused while it is not.

Because there is no clock, a slow surface is worth waiting for rather than abandoning — a long render, an upload, an assistant of the app's own thinking. Call wait with a generous "seconds" (a whole minute or several is fine; one long wait costs one action, many short ones cost many) instead of poking at an unchanged screen. A surface you gave up on early is a hole in the map that reads exactly like a surface that does not exist.

So you have two ways to shrink it, and both are legitimate:
- Operate the control (this is the default: it is how surfaces get discovered — opening one panel adds everything inside it to the frontier).
- Call "dismiss" for controls you have deliberately decided not to operate — content rather than navigation (list rows, transcript chunks, individual documents), destructive things, or anything that would leave the app changed. Dismiss by surface to clear a whole panel of repetitive items at once. Dismissals are recorded and published with the map, so give a real reason; they are the honest way to say "I chose not to", which silence is not.

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
				reason: { type: "string", description: "Why these are not worth operating. Published with the map." },
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
