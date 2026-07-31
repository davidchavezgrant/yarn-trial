import type { ModelClient } from "../harness.js";
import Anthropic from "@anthropic-ai/sdk";
import { checkableCount, verificationTallies, verify, visualJudge } from "../harness.js";
import type { ObservationBundle, PromptAudit, VisualVerdict } from "../harness.js";
import type { Overlay } from "../overlay.js";
import type { Expectation, StepRecord } from "../../types.js";
import type { DriverSync } from "./recording.js";

export interface DoneContext {
	toolUse: Anthropic.ToolUseBlock;
	messages: Anthropic.MessageParam[];
	records: StepRecord[];
	sync: DriverSync;
	overlay: Overlay;
	doObserve: (name: string) => Promise<ObservationBundle>;
	client: ModelClient;
	model: string;
	judgeMode: string;
	task: string;
	usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; modelCalls: number };
	startedAt: number;
	groundingMeta: Record<string, unknown>;
	vision: boolean;
	noAx: boolean;
	audit: PromptAudit;
	homeReset: string;
	expectationRejections: number;
}

/**
 * Grade a `done` call. Returns the run's outcome when the call is accepted (the caller ends
 * the run with it), or undefined when it was rejected — every rejection path has already
 * pushed its feedback onto `messages`, so the caller just continues the loop.
 */
export async function gradeDone(ctx: DoneContext): Promise<Record<string, unknown> | undefined> {
	const {
		toolUse,
		messages,
		records,
		sync,
		overlay,
		doObserve,
		client,
		model,
		judgeMode,
		task,
		usage,
		startedAt,
		groundingMeta,
		vision,
		noAx,
		audit,
		homeReset,
		expectationRejections,
	} = ctx;
	const input = toolUse.input as { success: boolean; summary: string; evidence?: Expectation };

	// success is a claim; the harness demands machine-checkable evidence and
	// grades it against a FRESH observation (state can have shifted since the
	// last step — e.g. a toast expired or a save silently failed).
	let finalCheck: { verified: boolean; note: string; evidence?: Expectation } | undefined;
	let visual: VisualVerdict | undefined;
	if (input.success) {
		const checkable = checkableCount(input.evidence);
		if (!checkable) {
			console.log("    -> done(success) rejected: no checkable evidence");
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolUse.id,
						is_error: true,
						content:
							"DONE NOT ACCEPTED — success requires evidence.textIncludes and/or evidence.textExcludes: " +
							"substrings proving the GOAL state, verified against a fresh observation. " +
							"Re-issue done with checkable evidence, or done(success: false) if you cannot prove the goal.",
					},
				],
			});
			return undefined;
		}

		while (sync.busy) await new Promise((r) => setTimeout(r, 50));
		sync.busy = true;
		overlay.setDriving(true);
		let finalShot = "";
		try {
			const finalObs = await doObserve("agent-final");
			finalShot = finalObs.screenshotB64;
			finalCheck = { ...verify(input.evidence!, finalObs.haystack), evidence: input.evidence };
		} finally {
			sync.busy = false;
			overlay.setDriving(false);
		}

		// Independent visual check of the goal state — a SEPARATE model call that
		// sees only the task and the final frame, never the action history or the
		// actor's summary. Substring evidence proves *a* control reads the target
		// value; it cannot prove that control is the intended one. Advisory unless
		// VISUAL_JUDGE=block, because a confident wrong verdict either stalls a good
		// run or waves through a bad one.
		if (judgeMode !== "off" && finalShot) {
			visual = await visualJudge(client, model, task, finalShot, input.summary);
			if (visual) {
				usage.modelCalls++;
				console.log(`    visual judge: ${visual.verdict} — ${visual.why}`);
				if (visual.scope) console.log(`      scope seen: ${visual.scope}`);
			} else {
				console.log("    visual judge: NO VERDICT — this run has no independent visual check.");
			}
		} else if (judgeMode !== "off") {
			console.log("    visual judge: skipped — no final screenshot was captured.");
		}

		if (judgeMode === "block" && visual?.verdict === "FAIL") {
			console.log("    -> done(success) BLOCKED by the visual judge");
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolUse.id,
						is_error: true,
						content:
							`DONE NOT ACCEPTED — an independent visual check of the final screen says the goal was NOT achieved: ${visual.why}\n` +
							`Surface it saw: ${visual.scope}\n` +
							"Your text evidence passed, so a control does read the expected value — but possibly the wrong one " +
							"(e.g. a per-document override rather than the global default). Diagnose and continue, or call done(success: false).",
					},
				],
			});
			return undefined;
		}

		// The judge being unavailable must not read as the judge approving: block
		// mode exists to require the independent check, and a transient judge
		// failure (or a missed final frame) would otherwise degrade it to "off" at
		// exactly the moment it was opted into. The claim stays unproven until a
		// verdict lands or the model downgrades it.
		if (judgeMode === "block" && !visual) {
			console.log("    -> done(success) NOT ACCEPTED: VISUAL_JUDGE=block and no verdict was returned");
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolUse.id,
						is_error: true,
						content:
							"DONE NOT ACCEPTED — this run requires an independent visual verdict (VISUAL_JUDGE=block) and the judge " +
							"was unavailable, so your success claim is unproven. Re-issue done to retry the check, or call done(success: false).",
					},
				],
			});
			return undefined;
		}

		if (!finalCheck.verified) {
			console.log(`    -> done(success) REFUTED by final observation: ${finalCheck.note}`);
			// A run carried by pixel evidence lands here by construction: the final
			// check greps text, and a painted target has none. Say so, because
			// otherwise the model reads "evidence failed" as a miss and retries the
			// drag forever. There IS no text to find, and that is the honest answer.
			const pixelOnly = records.some((r) => r.verificationChannel === "pixel" || r.verificationChannel === "geometry") && !records.some((r) => r.verificationChannel === "text");
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolUse.id,
						is_error: true,
						content:
							`DONE NOT ACCEPTED — your evidence failed against a fresh observation: ${finalCheck.note}\n` +
							(pixelOnly
								? "Every step in this run was verified by pixels alone, so the app exposes no text for this target and " +
									"no substring can prove the goal. Do not keep retrying. If you believe the manipulation succeeded, call " +
									"done(success: false) and say in your summary what you did and that it is unverifiable through this channel."
								: "The goal state is not proven. Diagnose and continue, or call done(success: false)."),
					},
				],
			});
			return undefined;
		}
	}

	const { unverifiedSteps: unverified, verifiedByChannel } = verificationTallies(records);
	const { text: textSteps, geometry: geometrySteps, pixel: pixelSteps } = verifiedByChannel;
	const verdict = !input.success
		? "failure"
		: unverified === 0
			? "success (goal check passed, all steps verified)"
			: `success (goal check passed; ${unverified}/${records.length} steps unverified)`;
	console.log(`\n=== DONE (${verdict}) after ${records.length} actions ===`);
	console.log(input.summary);
	const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
	console.log(`stats: ${records.length} actions, ${elapsedSec}s, ${usage.modelCalls} model calls, ${usage.outputTokens} output tokens, grounding=${groundingMeta.provenance}, vision=${vision}, ax=${!noAx}, hintedPrompt=${audit.hinted}, homeReset=${homeReset}`);
	console.log(`verification: ${records.length - unverified}/${records.length} steps verified (${textSteps} by text, ${geometrySteps} by geometry, ${pixelSteps} by pixels only)${expectationRejections ? `, ${expectationRejections} call(s) rejected for missing checks` : ""}${finalCheck ? `; final goal check: ${finalCheck.verified ? "PASSED" : "failed"} (${finalCheck.evidence?.textIncludes?.join(", ") ?? ""})` : ""}`);
	if (visual && visual.verdict !== "PASS")
		console.log(`NOTE: visual judge returned ${visual.verdict} — text evidence passed, but the final frame did not independently confirm the goal.`);
	if (audit.hinted) console.log("NOTE: prompt contained method hints — NOT a clean autonomy result.");

	return { success: input.success, finalCheck, visualCheck: visual, summary: input.summary };
}
