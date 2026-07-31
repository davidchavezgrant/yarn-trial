import type { ModelClient } from "../harness.js";
import Anthropic from "@anthropic-ai/sdk";
import { outputEffort, providerRouting, retryTransient } from "../harness.js";
import { writeArtifacts } from "./artifacts.js";
import { type FinishInput, noteProvider, type Pass, type StopReason } from "./state.js";

/**
 * The one model call this pass makes, shared by the loop and requestFinish: retryTransient
 * around a streamed request carrying the pass's system prompt (plus operator guidance), tools,
 * transcript, and the provider-routing ignore list. `extra` is the single key that differs by
 * call site — cache_control on the loop call, tool_choice on the pinned finish call.
 */
export const streamCall = (p: Pass, client: ModelClient, model: string, extra: Record<string, unknown>): Promise<Anthropic.Message> =>
	retryTransient(
		() =>
			client.messages
				.stream({
					model,
					max_tokens: 32000,
					system: p.guidance ? `${p.basePrompt}\n\n# Operator guidance for this run\n${p.guidance}` : p.basePrompt,
					tools: p.tools,
					...extra,
					messages: p.messages,
					...outputEffort(),
					...providerRouting(p.badProviders),
				})
				.finalMessage(),
		{ onRetry: (n, e) => noteProvider(p, n, e) },
	);

/**
 * Ask for the map when the loop ends for a reason other than the model choosing to
 * finish (action ceiling, dead session). One model call, tool_choice pinned,
 * no driver needed — everything required is already in the transcript and the graph.
 */
export const requestFinish = async (p: Pass, client: ModelClient, model: string, why: string, stopped: StopReason, salvaged: boolean): Promise<void> => {
	p.messages.push({ role: "user", content: why });
	// Streamed, like the loop call: the SDK refuses a non-streaming request whose
	// max_tokens could exceed a 10-minute generation, and the finish payload is the
	// largest thing this program asks for.
	const rescue = await streamCall(p, client, model, { tool_choice: { type: "tool", name: "finish" } });
	const out = rescue.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
	if (!out) throw new Error("model did not emit finish");
	writeArtifacts(p, out.input as FinishInput, stopped, salvaged);
};
