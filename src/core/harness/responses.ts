import type Anthropic from "@anthropic-ai/sdk";

/**
 * The OpenAI **Responses API** as a drop-in for the Anthropic Messages client.
 *
 * Why an adapter and not a second loop: every model call in this repo is written against the
 * Messages shape — content blocks, `tool_use`/`tool_result` pairs, base64 image blocks,
 * `stop_reason`, `usage` — and there are ten call sites across the agent, explore, judge,
 * teardown, replay and probe paths. Rewriting them per provider would be ten chances to
 * introduce a difference that reads as a MODEL difference in the benchmark, which is the one
 * error class the whole measurement cannot tolerate. So the wire format is translated at the
 * boundary instead, and `makeClient()` hands back something structurally identical to the SDK
 * client: `messages.create(params)` and `messages.stream(params).finalMessage()`, both
 * resolving to an `Anthropic.Message`. Nothing upstream knows which provider answered.
 *
 * Responses is the better-shaped API and the direction the product wants (David, 2026-07-31):
 * `input` items are a flat, addressable list rather than nested content arrays, tool calls are
 * first-class items with their own ids, and reasoning is a declared field rather than an
 * interleaved block. The mapping below is therefore written to be readable in the Responses
 * direction — a future loop written natively against it should be able to delete this file
 * rather than invert it.
 *
 * Deliberately NOT translated:
 * - `cache_control` — Responses has no per-block cache directive. Dropped, not faked. (The
 *   same blocks are already inert on OpenRouter's OpenAI models, which return a null
 *   `cache_creation_input_tokens`, so no arm loses a behaviour it previously had.)
 * - `provider` (OpenRouter's routing ignore-list) — meaningless against a single deployment.
 * - `thinking` blocks are read but never sent back: Responses reasoning items are opaque
 *   (`reasoning` with a summary), and inventing Anthropic-shaped thinking to echo would be
 *   fabricating model output.
 */

/**
 * Azure's Responses endpoint. Either spelling works, because both are in circulation and an
 * operator pasting one from the portal should not have to know which we expect:
 *
 *   base    https://<res>.openai.azure.com/openai/v1        (the v1 surface — preferred)
 *   full    https://<res>.openai.azure.com/openai/responses?api-version=2025-04-01-preview
 *
 * `responsesUrl` normalises: a URL that already names `/responses` is used verbatim, anything
 * else gets `/responses` appended. Both were verified live against the same deployment, with
 * the key accepted as either `api-key` or a Bearer token; we send `api-key`, Azure's own.
 */
export const AZURE_ENDPOINT_ENV = "AZURE_OPENAI_ENDPOINT";
export const AZURE_KEY_ENV = "AZURE_OPENAI_API_KEY";

export function responsesUrl(endpoint: string): string {
	const url = endpoint.trim().replace(/\/+$/, "");

	return /\/responses(\?|$)/.test(url) ? url : `${url}/responses`;
}

/**
 * How long one call may take. Generous because the explore loop asks for up to 32k output
 * tokens at max reasoning effort, and this transport is non-streaming (see `stream` below):
 * the whole generation arrives in one response, so the ceiling has to cover the whole thing
 * rather than an inter-token gap.
 */
const CALL_TIMEOUT_MS = 15 * 60_000;

/** The params our call sites pass. A subset of Anthropic's, since that is all they use. */
export interface MessagesParams {
	model: string;
	max_tokens: number;
	system?: string;
	tools?: Anthropic.Tool[];
	messages: Anthropic.MessageParam[];
	tool_choice?: { type: string; name?: string };
	/** Anthropic-format effort knob (`output_config.effort`), mapped to `reasoning.effort`. */
	output_config?: { effort?: string };
	/** Accepted and dropped — see the header. Declared so callers need no provider branch. */
	cache_control?: unknown;
	provider?: unknown;
}

/**
 * The structural contract every call site depends on. The Anthropic SDK client satisfies it
 * already; `responsesClient` below is the second implementation.
 */
export interface ModelClient {
	messages: {
		// Params typed loosely on purpose: this interface has to be satisfied BY the Anthropic
		// SDK client (whose `create` is overloaded across streaming/non-streaming variants)
		// without anyone writing an adapter for the common path. `MessagesParams` above is the
		// honest description of what our call sites actually send.
		create(params: MessagesParams | any, options?: any): Promise<Anthropic.Message>;
		stream(params: MessagesParams | any, options?: any): { finalMessage(): Promise<Anthropic.Message> };
	};
}

/** One item in a Responses `input` array. Loose by design: the API accepts several shapes. */
type ResponsesItem = Record<string, unknown>;

/**
 * Anthropic tool declarations → Responses function tools.
 *
 * `input_schema` becomes `parameters` verbatim: both are plain JSON Schema, and rewriting one
 * into the other is exactly the kind of silent divergence this file exists to avoid. `strict`
 * is left OFF because our schemas use unions and optional properties that strict mode refuses,
 * and a refused schema fails the whole call rather than one field.
 */
export function toResponsesTools(tools: Anthropic.Tool[] | undefined): ResponsesItem[] | undefined {
	if (!tools?.length) return undefined;

	return tools.map((t) => ({
		type: "function",
		name: t.name,
		...(t.description ? { description: t.description } : {}),
		parameters: t.input_schema,
		strict: false,
	}));
}

/** Anthropic tool_choice → Responses tool_choice. `{type:"tool",name}` pins one function. */
export function toResponsesToolChoice(choice: MessagesParams["tool_choice"]): unknown {
	if (!choice) return undefined;
	if (choice.type === "tool" && choice.name) return { type: "function", name: choice.name };
	if (choice.type === "any") return "required";
	if (choice.type === "none") return "none";

	return "auto";
}

/**
 * Anthropic messages → a flat Responses `input` list.
 *
 * The flattening is the substance of the mapping. Anthropic nests everything inside a message's
 * `content` array; Responses wants sibling items, and tool traffic in particular stops being
 * nested: a `tool_use` block becomes its own `function_call` item and the matching
 * `tool_result` becomes a `function_call_output` item keyed by the SAME id. Preserving that id
 * is what keeps a multi-turn tool conversation coherent — a regenerated id would orphan every
 * result, and the model would see a call it never made answered by a result for nothing.
 *
 * Image blocks carry base64 through as a data URL, which is what `input_image` takes. Only
 * base64 sources appear in this repo (screenshots straight off the driver), so a URL source
 * would be a new case rather than a missing one — it throws instead of silently dropping the
 * only perception the model has.
 */
export function toResponsesInput(messages: Anthropic.MessageParam[]): ResponsesItem[] {
	const out: ResponsesItem[] = [];

	for (const m of messages) {
		if (typeof m.content === "string") {
			out.push({ role: m.role, content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }] });
			continue;
		}

		// Content parts split by destination: text/image stay inside one role item, while tool
		// calls and results become siblings. Buffered so a message mixing them keeps its order.
		let parts: ResponsesItem[] = [];
		const flush = (): void => {
			if (!parts.length) return;
			out.push({ role: m.role, content: parts });
			parts = [];
		};

		for (const block of m.content) {
			switch (block.type) {
				case "text":
					parts.push({ type: m.role === "assistant" ? "output_text" : "input_text", text: block.text });
					break;
				case "image": {
					const src = block.source as { type?: string; media_type?: string; data?: string; url?: string };
					if (src?.type !== "base64" || !src.data)
						throw new Error(`Responses transport received an unsupported image source (${src?.type ?? "none"}) — only base64 screenshots are produced here`);
					parts.push({ type: "input_image", image_url: `data:${src.media_type ?? "image/png"};base64,${src.data}` });
					break;
				}
				case "tool_use":
					flush();
					out.push({
						type: "function_call",
						call_id: block.id,
						name: block.name,
						// Responses takes arguments as a JSON STRING, where Anthropic takes an object.
						arguments: JSON.stringify(block.input ?? {}),
					});
					break;
				case "tool_result": {
					flush();
					const c = (block as Anthropic.ToolResultBlockParam).content;
					out.push({
						type: "function_call_output",
						call_id: (block as Anthropic.ToolResultBlockParam).tool_use_id,
						output: toolResultText(c),
					});
					// An image inside a tool_result — every observation in this repo — has nowhere to
					// go in `function_call_output`, whose output is text. It follows as a separate
					// user item so the model still SEES it; dropping it would blind the run while
					// every other channel looked healthy.
					for (const part of Array.isArray(c) ? c : []) {
						if (part.type !== "image") continue;
						const src = part.source as { type?: string; media_type?: string; data?: string };
						if (src?.type !== "base64" || !src.data) continue;
						out.push({ role: "user", content: [{ type: "input_image", image_url: `data:${src.media_type ?? "image/png"};base64,${src.data}` }] });
					}
					break;
				}
				default:
					// thinking / redacted_thinking / anything newer: not sent back. See the header.
					break;
			}
		}
		flush();
	}

	return pairToolCalls(out);
}

/**
 * Every `function_call` must be answered. The Responses API rejects a transcript containing a
 * call with no matching `function_call_output` — 400 "No tool output found for function call
 * <id>" — and it kills the run, not the turn.
 *
 * This is reachable from ordinary model behaviour, not from a bug in the translation above.
 * Every loop in this repo takes ONE tool call per turn (`content.find(...)` in agent/run.ts,
 * explore/loop.ts, replay.ts, teardown.ts, home.ts) and replies with exactly one tool_result.
 * When the model emits several tool_use blocks in a single turn — which it does; a Wikipedia
 * explore emitted a press_key plus three dismisses on 2026-07-31 — the extras are executed by
 * nobody and answered by nobody. Anthropic accepted that transcript. Responses does not.
 *
 * Answering here rather than in five loops: the fix belongs at the boundary that has the
 * constraint, it cannot be forgotten by the next loop written, and it does not change the
 * deliberate one-action-per-turn semantics.
 *
 * The synthesized output tells the truth — the call was NOT executed — rather than fabricating
 * a result. A fabricated success would teach the model its extra calls worked, which is how
 * you get an agent that fires three actions a turn and believes all three landed.
 */
function pairToolCalls(items: ResponsesItem[]): ResponsesItem[] {
	const answered = new Set<string>();
	for (const it of items) if (it.type === "function_call_output" && typeof it.call_id === "string") answered.add(it.call_id);

	const out: ResponsesItem[] = [];
	for (const it of items) {
		out.push(it);
		if (it.type !== "function_call" || typeof it.call_id !== "string" || answered.has(it.call_id)) continue;
		answered.add(it.call_id);
		out.push({
			type: "function_call_output",
			call_id: it.call_id,
			output: "not executed: this harness performs ONE tool call per turn, and another call in the same turn was taken instead. Emit a single call per turn.",
		});
	}

	return out;
}

/** A tool_result's text, joined. Non-text parts are named so an empty result is never silent. */
function toolResultText(content: Anthropic.ToolResultBlockParam["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts = content.filter((p): p is Anthropic.TextBlockParam => p.type === "text").map((p) => p.text);
	const images = content.filter((p) => p.type === "image").length;

	return [...texts, ...(images ? [`[${images} image(s) follow as a separate message]`] : [])].join("\n");
}

/** The full Responses request body for one Messages-shaped call. */
export function toResponsesBody(params: MessagesParams): Record<string, unknown> {
	const effort = params.output_config?.effort;

	return {
		model: params.model,
		...(params.system ? { instructions: params.system } : {}),
		input: toResponsesInput(params.messages),
		...(toResponsesTools(params.tools) ? { tools: toResponsesTools(params.tools) } : {}),
		...(params.tool_choice ? { tool_choice: toResponsesToolChoice(params.tool_choice) } : {}),
		max_output_tokens: params.max_tokens,
		// `none` is Anthropic's "omit the field" sentinel (outputEffort), not a level Responses
		// knows — and `max` is Anthropic vocabulary that Responses spells `high`, its ceiling.
		...(effort && effort !== "none" ? { reasoning: { effort: effort === "max" || effort === "xhigh" ? "high" : effort } } : {}),
	};
}

/**
 * A Responses response → an `Anthropic.Message`.
 *
 * `stop_reason` is derived rather than read: Responses reports lifecycle (`completed`,
 * `incomplete`) where Anthropic reports intent, and our loops branch on intent — `tool_use`
 * drives the whole act/verify cycle, and `refusal` is the one value both agent and explore
 * check explicitly. A truncated generation must read as `max_tokens`, because that is the
 * failure the step-limit logic is written against.
 */
export function fromResponsesBody(body: Record<string, any>): Anthropic.Message {
	const content: Anthropic.ContentBlock[] = [];
	let refused = false;

	for (const item of (body.output ?? []) as Record<string, any>[]) {
		if (item.type === "function_call") {
			let input: unknown = {};
			try {
				input = item.arguments ? JSON.parse(item.arguments) : {};
			} catch {
				// Malformed arguments reach the caller as an EMPTY tool input, which the loops
				// already handle (the act gate rejects an action with no object and reports it
				// back to the model). Throwing here would turn a recoverable turn into a dead run.
				input = {};
			}
			content.push({ type: "tool_use", id: String(item.call_id ?? item.id ?? ""), name: String(item.name ?? ""), input } as Anthropic.ToolUseBlock);
			continue;
		}
		for (const part of (item.content ?? []) as Record<string, any>[]) {
			if (part.type === "refusal") {
				refused = true;
				if (part.refusal) content.push({ type: "text", text: String(part.refusal), citations: [] } as Anthropic.TextBlock);
				continue;
			}
			if (typeof part.text === "string") content.push({ type: "text", text: part.text, citations: [] } as Anthropic.TextBlock);
		}
	}

	const hasTool = content.some((b) => b.type === "tool_use");
	const stop: Anthropic.Message["stop_reason"] = refused
		? "refusal"
		: body.status === "incomplete" || body.incomplete_details
			? "max_tokens"
			: hasTool
				? "tool_use"
				: "end_turn";

	const u = body.usage ?? {};

	return {
		id: String(body.id ?? ""),
		type: "message",
		role: "assistant",
		model: String(body.model ?? ""),
		content,
		stop_reason: stop,
		stop_sequence: null,
		usage: {
			/**
			 * Normalised to ANTHROPIC semantics, which is the whole job of this boundary: our
			 * `input_tokens` means UNCACHED input, and cache reads are counted separately.
			 *
			 * Responses reports `input_tokens` as the TOTAL, with `cached_tokens` a SUBSET of
			 * it. Passing that through unchanged makes the two fields overlap, and every
			 * consumer that treats them as disjoint is then wrong in the same direction —
			 * cost double-bills the cached portion (at $5/MTok AND $0.50/MTok for the same
			 * tokens), and any Anthropic-vs-Azure token comparison is skewed by the whole
			 * cached volume, which on a real run was 44k of 78k.
			 *
			 * Clamped at zero: a provider that ever reported more cached than total would
			 * otherwise produce a negative token count that silently reduces a cost total.
			 */
			input_tokens: Math.max(0, Number(u.input_tokens ?? 0) - Number(u.input_tokens_details?.cached_tokens ?? 0)),
			output_tokens: Number(u.output_tokens ?? 0),
			cache_read_input_tokens: Number(u.input_tokens_details?.cached_tokens ?? 0),
			// Responses has no cache-CREATION charge: caching is automatic and a hit is simply
			// billed cheaper, so there is no write event to report. null, not 0 — the
			// distinction is "this provider has no such concept" rather than "none happened".
			cache_creation_input_tokens: null,
			server_tool_use: null,
			service_tier: null,
		},
	} as Anthropic.Message;
}

/**
 * An error shaped like the SDK's, so `isTransientApiError` classifies a Responses failure by
 * the same rules — a 429 or a 5xx has to stay retryable across both transports or the retry
 * budget silently differs by provider.
 */
class ResponsesError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly error?: unknown,
	) {
		super(message);
		this.name = "ResponsesError";
	}
}

export interface ResponsesClientOptions {
	/** Base URL (`…/openai/v1`) or a full `…/responses?api-version=…` — see responsesUrl. */
	endpoint: string;
	apiKey: string;
	/** Injected in tests; production uses global fetch. */
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

/**
 * The adapter client. Non-streaming on purpose: the only reason the Anthropic path streams is
 * that its SDK refuses a non-streaming request whose `max_tokens` could exceed a ten-minute
 * generation, and both call sites throw the stream away immediately (`.finalMessage()`). One
 * POST with a matching ceiling is the same thing with fewer moving parts, so `stream()` here
 * returns an object whose `finalMessage()` is that POST.
 */
export function responsesClient(opts: ResponsesClientOptions): ModelClient {
	const doFetch = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? CALL_TIMEOUT_MS;
	const url = responsesUrl(opts.endpoint);

	const call = async (params: MessagesParams): Promise<Anthropic.Message> => {
		const res = await doFetch(url, {
			method: "POST",
			headers: { "api-key": opts.apiKey, "content-type": "application/json" },
			body: JSON.stringify(toResponsesBody(params)),
			signal: AbortSignal.timeout(timeoutMs),
		});

		const text = await res.text();
		let body: Record<string, any>;
		try {
			body = text ? JSON.parse(text) : {};
		} catch {
			// A provider overload can answer with an empty or HTML body; the agent loop already
			// treats a parse failure from inside the call as the same transient event as a 5xx.
			throw new ResponsesError(`Responses API returned unparseable body (${res.status})`, res.status);
		}
		if (!res.ok || body.error)
			throw new ResponsesError(
				`Responses API ${res.status}: ${body.error?.code ?? ""} ${body.error?.message ?? text.slice(0, 200)}`.trim(),
				res.status,
				body,
			);

		return fromResponsesBody(body);
	};

	return {
		messages: {
			create: call,
			stream: (params) => ({ finalMessage: () => call(params) }),
		},
	};
}
