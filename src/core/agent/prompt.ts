import Anthropic from "@anthropic-ai/sdk";
import type { TargetVocabulary } from "../target.js";

export const systemPrompt = (rules: string, vision: boolean, vocab: TargetVocabulary, ax = true): string => `You are a UI automation agent driving ${vocab.subject} through a UI driver. Each turn you receive an observation: ${ax ? `${vocab.container}'s interactive elements (addressing handle, role, label/value)${vision ? " and a screenshot" : "; element frames give positions — there is no screenshot"}` : `${vocab.container}'s window title and a screenshot — there is NO element list`}. You perform ONE action per turn by calling the "act" tool, then the harness executes it, waits, re-observes, and reports back.
${vocab.cautions ? `\n${vocab.cautions}\n` : ""}
${rules}
- Set a concrete, checkable expectation for every action: textIncludes and/or textExcludes, literal substrings checked against the window title plus all element labels and values in the NEXT observation. This is MANDATORY — an act call carrying only a prose description is rejected and NOT executed, costing you a turn. Supply it even when you are certain the action will work.
- Expectations must DISCRIMINATE: at least one substring that appears (or disappears) BECAUSE of the action. A check that was already true before the action is rejected as evidence — in particular, text you typed earlier does not verify a later action.
- If verification fails, do not repeat the same action blindly — re-read the observation, diagnose, and recover.
- There is no time limit, so when the app is working on something slow — a long render, an upload, an assistant of its own thinking — do not treat the unchanged screen as failure and do not poke at it. Call wait with a generous "seconds" (a whole minute or several is fine; one long wait costs one step, many short ones cost many) and set the expectation to the finished state you are waiting for.

DEMONSTRATE BY DOING. Your runs are recorded as product demos, so the video must show the outcome, not a tour of where the buttons are. Phrasings like "show me how to X", "walk me through X", "demo X" are requests to PERFORM X, end to end, leaving the app in the changed state. Navigating to a control, opening a dropdown, and describing the remaining steps in your summary is a FAILED run, however accurate the description.

- If the task names no specific value ("change the cursor type" — to what?), CHOOSE a sensible one — any value different from the current one — and commit it. An unspecified value is not a reason to stop short; it is yours to pick. Say which you chose in your summary.
- Commit the change: if there is a Save / Done / Apply control, click it, and confirm the change survived (the unsaved-changes affordance disappears, or the control still reads the new value on re-observation).
- Your "done" evidence must prove the NEW state, so pair textIncludes on the new value with textExcludes on the old one wherever the change replaces a value.

WORK IN SCRATCH, NOT IN THE USER'S CONTENT. When a task needs something to operate on — a document, a project, a draft — CREATE A NEW ONE with a distinctive name rather than opening something that is already there, and call "claim" the moment it exists. The workspace you are driving may be a real person's, and a demo that edits their actual work is a failure even when the task succeeds.

Settings you change are put back after the run, so change them freely. Things you CREATE are not removed automatically — they are only reported — so creating a scratch document is safe and preferable, but creating five of them leaves five behind.

The one exception is irreversible or externally-visible actions — deleting, publishing, exporting, sending, sharing, purchasing, account changes. For those, and ONLY those, go as far as the final confirmation step WITHOUT confirming, then call done with success: true, evidence showing you reached that point, and a summary saying plainly that you stopped before the irreversible step.

Call "done" when the task is complete (success: true) — you MUST attach evidence: substring checks proving the GOAL state, which the harness verifies against a fresh final observation before accepting. Call done with success: false when you are stuck after genuine recovery attempts. Always call exactly one tool per turn.`;

export const DONE_TOOL: Anthropic.Tool = {
	name: "done",
	description:
		"End the run: the task is complete and verified, or unrecoverable. A success claim is only accepted if your evidence checks pass against a FRESH final observation taken by the harness.",
	input_schema: {
		type: "object",
		properties: {
			success: { type: "boolean" },
			summary: { type: "string", description: "What was done and how the final state verifies it (or why it failed)." },
			evidence: {
				type: "object",
				description:
					"REQUIRED when success is true. Substring checks proving the GOAL state (not merely the last action) — run against a fresh observation. " +
					"When the goal REPLACES one state with another, presence of the new value is NOT sufficient: apps routinely show the new value ALONGSIDE the old " +
					"one (a preview, a secondary column, an unsaved draft), so a presence-only check passes while nothing actually changed. Pair textIncludes on the " +
					"new value with textExcludes on the old one. E.g. changing the timezone from EDT to Paris: textIncludes ['GMT+2'] AND textExcludes ['EDT'].",
				properties: {
					description: { type: "string" },
					textIncludes: { type: "array", items: { type: "string" } },
					textExcludes: { type: "array", items: { type: "string" } },
				},
				required: ["description"],
			},
		},
		required: ["success", "summary"],
	},
};

/**
 * The agent's declaration that it brought something into existence.
 *
 * This is the sandbox half of cleanup, and it exists because restoring a value and disposing
 * of a thing are not the same operation: a setting has a previous value to write back, while
 * a draft the run created has no "before" at all — the only way to leave the workspace as it
 * was found is to remove it. A claimed name is the whole of teardown's authority to do that:
 * disposal is matched against this ledger by code, so an unclaimed document cannot be deleted
 * however convinced the model is that it is scratch.
 */
export const CLAIM_TOOL: Anthropic.Tool = {
	name: "claim",
	description:
		"Declare a resource this run created (or is about to modify) so the harness can account for it afterwards. " +
		"Call it IMMEDIATELY after creating the thing, with the exact name as the app renders it.",
	input_schema: {
		type: "object",
		properties: {
			kind: {
				type: "string",
				enum: ["created", "will-modify"],
				description:
					'"created" is a thing that did not exist before this run. ' +
					'"will-modify" is pre-existing content you are about to change, recorded so the change can be reported.',
			},
			name: { type: "string", description: 'Exact name as it appears in the app, e.g. "scratch-demo-7f3a".' },
			note: { type: "string", description: "One sentence: what it is and why the task needed it." },
		},
		required: ["kind", "name"],
	},
};
