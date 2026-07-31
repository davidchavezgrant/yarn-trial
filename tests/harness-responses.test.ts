import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import {
	fromResponsesBody,
	responsesUrl,
	responsesClient,
	toResponsesBody,
	toResponsesInput,
	toResponsesToolChoice,
	toResponsesTools,
} from "../src/core/harness/responses.js";

/**
 * The wire translation, both directions.
 *
 * These matter more than most tests in the repo: a mapping bug does not crash, it degrades —
 * an image that never arrives, a tool result attached to the wrong call — and the symptom is a
 * run that performs worse. In a benchmark comparing MODELS across transports, that reads as a
 * model difference and quietly corrupts the conclusion. So every field our loops depend on is
 * pinned in both directions.
 */

const img = (data = "AAAA"): Anthropic.ImageBlockParam => ({
	type: "image",
	source: { type: "base64", media_type: "image/png", data },
});

test("toResponsesTools__CarriesTheSchemaVerbatim__When__ToolsAreDeclared", () => {
	const tools: Anthropic.Tool[] = [
		{ name: "act", description: "Do one thing", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
	];
	const mapped = toResponsesTools(tools) as Record<string, any>[];
	assert.equal(mapped[0].type, "function");
	assert.equal(mapped[0].name, "act");
	// Verbatim, not rewritten: both sides are plain JSON Schema, and re-deriving one from the
	// other is exactly the silent divergence this mapping exists to avoid.
	assert.deepEqual(mapped[0].parameters, tools[0].input_schema);
	assert.equal(mapped[0].strict, false);
	assert.equal(toResponsesTools(undefined), undefined);
	assert.equal(toResponsesTools([]), undefined);
});

test("toResponsesToolChoice__PinsOneFunction__When__AnthropicPinsATool", () => {
	assert.deepEqual(toResponsesToolChoice({ type: "tool", name: "finish" }), { type: "function", name: "finish" });
	assert.equal(toResponsesToolChoice({ type: "any" }), "required");
	assert.equal(toResponsesToolChoice({ type: "auto" }), "auto");
	assert.equal(toResponsesToolChoice(undefined), undefined);
});

test("toResponsesInput__KeepsTheCallId__When__ToolUseAndResultPair", () => {
	// The load-bearing property of the whole mapping: a regenerated id would orphan every
	// result, leaving the model looking at an answer to a call it never made.
	const input = toResponsesInput([
		{ role: "assistant", content: [{ type: "tool_use", id: "toolu_42", name: "act", input: { name: "click" } }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_42", content: [{ type: "text", text: "clicked" }] }] },
	]) as Record<string, any>[];

	assert.equal(input[0].type, "function_call");
	assert.equal(input[0].call_id, "toolu_42");
	assert.equal(input[0].name, "act");
	// Arguments cross as a JSON STRING where Anthropic passes an object.
	assert.equal(input[0].arguments, JSON.stringify({ name: "click" }));
	assert.equal(input[1].type, "function_call_output");
	assert.equal(input[1].call_id, "toolu_42");
	assert.equal(input[1].output, "clicked");
});

test("toResponsesInput__KeepsTheScreenshot__When__ItRidesInsideAToolResult", () => {
	// Every observation in this repo is a tool_result carrying text AND an image, but
	// function_call_output's output is text-only — so the image has to follow as its own item
	// or the run goes blind while every other channel still looks healthy.
	const input = toResponsesInput([
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "Driver result: ok" }, img("PNGDATA")] }] },
	]) as Record<string, any>[];

	assert.equal(input[0].type, "function_call_output");
	assert.match(String(input[0].output), /Driver result: ok/);
	// The text says an image follows, so a reader of the transcript alone is not misled.
	assert.match(String(input[0].output), /1 image\(s\) follow/);
	assert.equal(input[1].role, "user");
	assert.equal((input[1].content as any[])[0].type, "input_image");
	assert.equal((input[1].content as any[])[0].image_url, "data:image/png;base64,PNGDATA");
});

test("toResponsesInput__MapsTextAndImage__When__AUserTurnCarriesBoth", () => {
	const input = toResponsesInput([{ role: "user", content: [{ type: "text", text: "look" }, img("Q")] }]) as Record<string, any>[];
	assert.equal(input.length, 1, "text and image stay in ONE role item");
	const parts = input[0].content as any[];
	assert.deepEqual(parts.map((p) => p.type), ["input_text", "input_image"]);
});

test("toResponsesInput__UsesOutputText__When__TheTurnIsAssistant", () => {
	// Responses distinguishes input_text from output_text by author; sending an assistant turn
	// as input_text is rejected.
	const input = toResponsesInput([{ role: "assistant", content: [{ type: "text", text: "done" }] }]) as Record<string, any>[];
	assert.equal((input[0].content as any[])[0].type, "output_text");
	const str = toResponsesInput([{ role: "user", content: "hi" }]) as Record<string, any>[];
	assert.equal((str[0].content as any[])[0].type, "input_text");
});

test("toResponsesInput__Throws__When__AnImageIsNotBase64", () => {
	// A URL source would be a NEW case rather than a missing one; failing loudly beats
	// silently dropping the only perception the model has.
	assert.throws(
		() => toResponsesInput([{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } } as any] }]),
		/unsupported image source/,
	);
});

test("toResponsesInput__DropsThinking__When__ATranscriptCarriesIt", () => {
	// Reasoning items are opaque on Responses; echoing invented Anthropic-shaped thinking back
	// would be fabricating model output.
	const input = toResponsesInput([
		{ role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "sig" } as any, { type: "text", text: "ok" }] },
	]) as Record<string, any>[];
	assert.equal(input.length, 1);
	assert.deepEqual((input[0].content as any[]).map((p) => p.type), ["output_text"]);
});

test("toResponsesBody__MapsEveryFieldOurCallSitesSend__When__BuildingARequest", () => {
	const body = toResponsesBody({
		model: "gpt-5.6-sol",
		max_tokens: 16000,
		system: "you are the agent",
		tools: [{ name: "act", input_schema: { type: "object" } }],
		tool_choice: { type: "tool", name: "act" },
		messages: [{ role: "user", content: "go" }],
		output_config: { effort: "max" },
		// Accepted and dropped — Responses has no per-block cache directive and no router.
		cache_control: { type: "ephemeral" },
		provider: { ignore: ["Azure"] },
	});

	assert.equal(body.model, "gpt-5.6-sol");
	assert.equal(body.instructions, "you are the agent");
	assert.equal(body.max_output_tokens, 16000);
	assert.deepEqual(body.tool_choice, { type: "function", name: "act" });
	// `max` is Anthropic vocabulary; Responses' ceiling is `high`.
	assert.deepEqual(body.reasoning, { effort: "high" });
	assert.equal("cache_control" in body, false);
	assert.equal("provider" in body, false);
});

test("toResponsesBody__OmitsReasoning__When__EffortIsOff", () => {
	// outputEffort() returns {} for `off`, so the field is simply absent; `none` is its
	// sentinel and must not reach the wire as a level.
	assert.equal("reasoning" in toResponsesBody({ model: "m", max_tokens: 1, messages: [] }), false);
	assert.equal("reasoning" in toResponsesBody({ model: "m", max_tokens: 1, messages: [], output_config: { effort: "none" } }), false);
	assert.deepEqual(toResponsesBody({ model: "m", max_tokens: 1, messages: [], output_config: { effort: "low" } }).reasoning, { effort: "low" });
});

test("fromResponsesBody__ProducesAToolUseBlock__When__TheModelCallsAFunction", () => {
	const msg = fromResponsesBody({
		id: "resp_1",
		model: "gpt-5.6-sol",
		status: "completed",
		output: [{ type: "function_call", call_id: "call_9", name: "act", arguments: '{"name":"click","target":"Save"}' }],
		usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } },
	});

	assert.equal(msg.content.length, 1);
	const tool = msg.content[0] as Anthropic.ToolUseBlock;
	assert.equal(tool.type, "tool_use");
	assert.equal(tool.id, "call_9");
	assert.equal(tool.name, "act");
	// Parsed back into an object, because that is what every act handler reads.
	assert.deepEqual(tool.input, { name: "click", target: "Save" });
	// stop_reason is DERIVED: the loops branch on intent, and tool_use drives the act cycle.
	assert.equal(msg.stop_reason, "tool_use");
	// input_tokens is normalised to ANTHROPIC semantics — UNCACHED input, cache reads counted
	// separately — so 100 total with 40 cached becomes 60. Responses reports the total with
	// cached as a subset; passing that through made the two fields OVERLAP, which double-bills
	// every cached token when costing (at both the full and the cached rate) and inflates
	// Azure's apparent input volume against Anthropic's in any cross-model comparison.
	assert.equal(msg.usage.input_tokens, 60);
	assert.equal(msg.usage.output_tokens, 20);
	// The field name is Anthropic's, because that is what the run log and bench collector read.
	assert.equal(msg.usage.cache_read_input_tokens, 40);
	// Not 0: Responses has no cache-creation charge at all, and null says "no such concept"
	// where 0 would say "none happened this call".
	assert.equal(msg.usage.cache_creation_input_tokens, null);
});

test("fromResponsesBody__SurvivesMalformedArguments__When__TheModelEmitsBadJson", () => {
	// An empty input reaches the act gate, which rejects it and reports back to the model —
	// a recoverable turn. Throwing here would kill the run instead.
	const msg = fromResponsesBody({ output: [{ type: "function_call", call_id: "c", name: "act", arguments: "{not json" }] });
	assert.deepEqual((msg.content[0] as Anthropic.ToolUseBlock).input, {});
});

test("fromResponsesBody__DerivesStopReason__When__TheLifecycleDiffers", () => {
	// Text only.
	assert.equal(fromResponsesBody({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] }).stop_reason, "end_turn");
	// Truncated: the step-limit logic is written against max_tokens.
	assert.equal(fromResponsesBody({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }).stop_reason, "max_tokens");
	// Refusal is the one value BOTH the agent and explore loops check explicitly.
	const refused = fromResponsesBody({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "I cannot" }] }] });
	assert.equal(refused.stop_reason, "refusal");
	assert.match((refused.content[0] as Anthropic.TextBlock).text, /I cannot/);
});

test("fromResponsesBody__ReadsText__When__TheModelAnswersInProse", () => {
	const msg = fromResponsesBody({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] });
	assert.equal((msg.content[0] as Anthropic.TextBlock).text, "ok");
	assert.equal(msg.role, "assistant");
	assert.equal(msg.type, "message");
});

test("responsesClient__PostsAndAdapts__When__TheCallSucceeds", async () => {
	let seen: { url: string; init: any } | undefined;
	const client = responsesClient({
		endpoint: "https://x.openai.azure.com/openai/responses?api-version=2025-04-01-preview",
		apiKey: "az-key",
		fetchImpl: (async (url: any, init: any) => {
			seen = { url: String(url), init };

			return new Response(
				JSON.stringify({ id: "r1", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 1, output_tokens: 2 } }),
				{ status: 200 },
			);
		}) as unknown as typeof fetch,
	});

	const msg = await client.messages.create({ model: "gpt-5.6-sol", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
	assert.equal((msg.content[0] as Anthropic.TextBlock).text, "ok");
	// The key travels as a header, never in the URL or a body field.
	assert.equal(seen?.init.headers["api-key"], "az-key");
	assert.match(seen?.url ?? "", /api-version=2025-04-01-preview/);

	// stream() is the same POST: both call sites throw the stream away immediately, and the
	// only reason the Anthropic path streams is an SDK guard this transport does not have.
	const streamed = await client.messages.stream({ model: "gpt-5.6-sol", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }).finalMessage();
	assert.equal((streamed.content[0] as Anthropic.TextBlock).text, "ok");
});

test("responsesClient__ThrowsWithTheStatus__When__TheApiRefuses", async () => {
	// The status has to survive: isTransientApiError classifies retryability by it, and a
	// transport whose errors lose it would silently retry differently from the Anthropic path.
	const client = responsesClient({
		endpoint: "https://x/openai/responses",
		apiKey: "k",
		fetchImpl: (async () => new Response(JSON.stringify({ error: { code: "429", message: "slow down" } }), { status: 429 })) as unknown as typeof fetch,
	});

	await assert.rejects(
		client.messages.create({ model: "m", max_tokens: 1, messages: [] }),
		(e: any) => e.status === 429 && /slow down/.test(e.message),
	);
});

test("responsesUrl__AcceptsBothSpellings__When__AnOperatorPastesEither", () => {
	// The v1 surface is a BASE url; the older one already names the path and carries its
	// api-version query. Both are in circulation, so neither is made the operator's problem.
	assert.equal(responsesUrl("https://x.openai.azure.com/openai/v1"), "https://x.openai.azure.com/openai/v1/responses");
	assert.equal(responsesUrl("https://x.openai.azure.com/openai/v1/"), "https://x.openai.azure.com/openai/v1/responses");
	const full = "https://x.openai.azure.com/openai/responses?api-version=2025-04-01-preview";
	assert.equal(responsesUrl(full), full);
	assert.equal(responsesUrl("https://x.openai.azure.com/openai/v1/responses"), "https://x.openai.azure.com/openai/v1/responses");
});

test("toResponsesInput__AnswersEveryToolCall__When__OneTurnEmitsSeveral", () => {
	// Reproduces the failure that killed the 2026-07-31 Wikipedia explore at action 7:
	// "Responses API 400: No tool output found for function call <id>". Every loop in this
	// repo takes ONE tool call per turn and replies with one tool_result, so a turn where the
	// model emitted press_key plus three dismisses left three calls unanswered. Anthropic
	// accepted that transcript; Responses rejects it and the whole run dies.
	const input = toResponsesInput([
		{
			role: "assistant",
			content: [
				{ type: "tool_use", id: "call_a", name: "act", input: { name: "press_key" } },
				{ type: "tool_use", id: "call_b", name: "dismiss", input: { names: ["x"] } },
				{ type: "tool_use", id: "call_c", name: "dismiss", input: { names: ["y"] } },
			],
		},
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: "ok" }] },
	]);

	const calls = input.filter((i: any) => i.type === "function_call").map((i: any) => i.call_id);
	const outputs = input.filter((i: any) => i.type === "function_call_output").map((i: any) => i.call_id);
	assert.deepEqual(calls, ["call_a", "call_b", "call_c"]);
	// Every call answered — that is the API's hard requirement.
	for (const id of calls) assert.ok(outputs.includes(id), `${id} unanswered`);
	// The real result is preserved, not overwritten by the synthesized one.
	const real = input.find((i: any) => i.type === "function_call_output" && i.call_id === "call_a") as any;
	assert.equal(real.output, "ok");
	// And the synthesized answers tell the truth: not executed. Fabricating success would
	// teach the model that firing three actions a turn works.
	const synth = input.find((i: any) => i.type === "function_call_output" && i.call_id === "call_b") as any;
	assert.match(synth.output, /not executed/);
});

test("toResponsesInput__PlacesTheAnswerAfterItsCall__When__Synthesizing", () => {
	const input = toResponsesInput([{ role: "assistant", content: [{ type: "tool_use", id: "call_z", name: "act", input: {} }] }]);
	// Order matters to the API: an output must follow the call it answers.
	assert.equal((input[0] as any).type, "function_call");
	assert.equal((input[1] as any).type, "function_call_output");
	assert.equal((input[1] as any).call_id, "call_z");
});
