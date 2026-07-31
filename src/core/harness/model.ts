import Anthropic from "@anthropic-ai/sdk";
import type { AppMapEdge, AppMapNode } from "../../types.js";
import { AZURE_ENDPOINT_ENV, AZURE_KEY_ENV, type ModelClient, responsesClient } from "./responses.js";

/**
 * The default is Claude Fable 5 on Anthropic's own API (set by David, 2026-07-31): the
 * benchmark's Claude arm runs direct, with no router in the path. The OpenAI arm reaches
 * `openai/gpt-5.6-sol` through OpenRouter's Anthropic-format `/api/v1/messages` endpoint —
 * verified to carry tool use, streaming, base64 screenshots and `thinking` blocks unchanged,
 * so the SDK and both loops need no restructuring. `sol` rather than `sol-pro`: same weights
 * and price, but pro's `reasoning.mode=pro` buys longer thinking per turn, and these loops are
 * long and sequential — a 96-action pass pays that cost 96 times.
 *
 * **The MODEL ID picks the transport, not which key happens to be set.** Key presence was the
 * old rule and it silently broke the two-provider split the moment both keys existed on one
 * host: OpenRouter won unconditionally, so a `claude-*` run went through the router anyway —
 * measurable only as a surprising `provider_name` in an error, and invisible when nothing
 * failed. A bare `claude-*` id (or an explicit `anthropic:` prefix) is Anthropic-direct;
 * anything else — including a deliberate `anthropic/claude-*`, which is OpenRouter's OWN
 * spelling for a Claude model — goes to OpenRouter. The slash is the tell: OpenRouter ids are
 * `vendor/model`, Anthropic's own are not.
 *
 * One measured consequence of the router path: OpenRouter returns a null
 * `cache_creation_input_tokens` for OpenAI models, so the `cache_control` blocks the
 * explore/agent prompts carry are accepted and then ignored. Nothing breaks; the per-chapter
 * system prompt is simply billed in full each time.
 */
export type Transport = "anthropic" | "openrouter" | "azure-responses";

export function makeClient(): { client: ModelClient; model: string; transport: Transport } {
	const requested = process.env.AGENT_MODEL?.trim();
	const anthropicKey = process.env.ANTHROPIC_API_KEY;
	const openrouter = process.env.OPENROUTER_API_KEY;
	const azureEndpoint = process.env[AZURE_ENDPOINT_ENV]?.trim();
	const azureKey = process.env[AZURE_KEY_ENV];
	// Default: Fable 5 direct when an Anthropic key exists, else whatever OpenRouter can
	// reach. :nitro is OpenRouter's throughput-first routing (fastest provider hosting the
	// model, premium pricing) — a model-id suffix, not a different model. Composes with
	// providerRouting(): nitro sets the sort, the ignore list still excludes watched failures.
	const model = requested || (anthropicKey ? "claude-fable-5" : "openai/gpt-5.6-sol:nitro");

	// `azure/<deployment>` is the third transport: OpenAI's Responses API, translated at the
	// boundary (src/core/harness/responses.ts) so no call site knows the difference. The
	// deployment name — not a catalog model id — is what follows the prefix, because that is
	// what Azure routes on.
	if (wantsAzureResponses(model)) {
		const deployment = model.slice("azure/".length);
		if (!azureEndpoint || !azureKey)
			throw new Error(`${model} needs ${AZURE_ENDPOINT_ENV} and ${AZURE_KEY_ENV} (the full endpoint URL including api-version).`);

		return { model: deployment, transport: "azure-responses", client: responsesClient({ endpoint: azureEndpoint, apiKey: azureKey }) };
	}

	const direct = wantsAnthropicDirect(model);
	if (direct && !anthropicKey)
		throw new Error(`${model} needs ANTHROPIC_API_KEY (a bare claude-* id runs direct). Set it, or ask for OpenRouter's "anthropic/${model}".`);
	if (!direct && !openrouter) throw new Error(`${model} is an OpenRouter id and needs OPENROUTER_API_KEY.`);

	return {
		model: direct ? model.replace(/^anthropic:/, "") : model,
		transport: direct ? "anthropic" : "openrouter",
		client: direct
			? new Anthropic({ apiKey: anthropicKey })
			: new Anthropic({ baseURL: "https://openrouter.ai/api", authToken: openrouter }),
	};
}

/** `azure/<deployment>` routes to the Responses transport. */
export function wantsAzureResponses(model: string): boolean {
	return model.trim().startsWith("azure/");
}

/**
 * Does this model id mean "Anthropic's own API"? Bare `claude-*` ids and an explicit
 * `anthropic:` prefix do; `vendor/model` ids are OpenRouter's namespace, `anthropic/claude-*`
 * included — that spelling is how an operator deliberately routes Claude through the router.
 */
export function wantsAnthropicDirect(model: string): boolean {
	const id = model.trim();

	return id.startsWith("anthropic:") || (!id.includes("/") && /^claude-/i.test(id));
}

/**
 * Reasoning-effort tuning, spread into every model request the way providerRouting() is.
 *
 * Highest by default (set by David, 2026-07-31): per Jasper, inter-action latency is a
 * non-issue — Yarn's pipeline eats the thinking gaps — so effort costs throughput and tokens,
 * not demo quality, and reliability is the prototype's whole frontier. Speed comes from
 * :nitro routing (see makeClient), not from thinking less.
 *
 * `output_config.effort` is the Anthropic-format field; OpenRouter maps it onto the routed
 * model's native reasoning knob (verified against GET /models: gpt-5.6-sol lists
 * supported_efforts [max, xhigh, high, medium, low, none]). AGENT_EFFORT overrides per run —
 * any of those levels, or `off` to omit the field entirely and take the model's default.
 */
export function outputEffort(): Record<string, unknown> {
	const effort = process.env.AGENT_EFFORT ?? "max";

	return effort === "off" ? {} : { output_config: { effort } };
}

/**
 * The upstream provider OpenRouter blamed for a failed request, if it named one.
 *
 * OpenRouter is a router: one model id fans out to several hosts, and a request that fails
 * because ONE of them is broken carries that host's name in `error.metadata.provider_name`.
 * Reading it is what makes the retry different from the attempt that just failed — see
 * providerRouting below.
 *
 * Both shapes are handled because both were observed from the same incident: the SDK attaches
 * the parsed body as `.error` on an APIError, but a failure that arrives wrapped (or from
 * `.stream()`) only has the JSON inside the message string.
 */
export function failedProvider(err: unknown): string | undefined {
	const body = (err as { error?: { error?: { metadata?: { provider_name?: unknown } } } })?.error;
	const named = body?.error?.metadata?.provider_name;
	if (typeof named === "string" && named.trim()) return named.trim();

	const m = /"provider_name"\s*:\s*"([^"]+)"/.exec(`${(err as Error)?.message ?? ""}`);

	return m?.[1]?.trim() || undefined;
}

/**
 * Tell OpenRouter to route around providers this run has already watched fail.
 *
 * The bug this closes: a run died with five consecutive 404 DeploymentNotFound while the same
 * key on the same host got a 200 for the same model seconds later. OpenRouter was routing some
 * requests to a broken Azure-backed provider, and the retry loop — which backed off correctly —
 * re-asked the identical route each time, so one bad provider consumed the whole allowance.
 * Backoff cannot help when the fault is not load.
 *
 * Empty when nothing has failed, so the normal request is byte-for-byte what it was and
 * OpenRouter's own ranking is untouched. Non-OpenRouter clients ignore the field.
 */
export function providerRouting(ignore: Iterable<string>): Record<string, unknown> {
	const list = [...new Set(ignore)];

	return list.length ? { provider: { ignore: list } } : {};
}

/**
 * Is this error worth trying again, or is retrying it just a slower failure?
 *
 * Transient here means the request never got a verdict: the connection dropped, the body
 * stalled, the server was busy. A 400 or an auth failure will fail identically forever and
 * must surface immediately.
 *
 * Matching on message text as well as status because a mid-stream failure arrives wrapped —
 * the observed one was `AnthropicError: terminated` with a `BodyTimeoutError` cause and no
 * status at all, since the headers had already come back 200.
 *
 * A provider-attributed error is transient WHATEVER its status. That is not a general claim
 * about 404s — it is specific to a router: the code came from one upstream host, the next
 * attempt can be sent somewhere else (providerRouting makes sure it is), and "this provider
 * has no such deployment" says nothing about the others.
 */
export function isTransientApiError(err: unknown): boolean {
	if (failedProvider(err)) return true;

	const status = (err as { status?: number })?.status;
	if (typeof status === "number") return status === 408 || status === 429 || status >= 500;
	const text = `${(err as Error)?.message ?? ""} ${String((err as { cause?: unknown })?.cause ?? "")}`.toLowerCase();

	return /terminated|timeout|econnreset|econnrefused|enotfound|socket hang up|network|overloaded|fetch failed/.test(text);
}

/**
 * Retry a model call through transient network failures.
 *
 * Added after a 12-hour unattended pass died two minutes in on a single `BodyTimeoutError`
 * mid-stream, having recorded nothing and so leaving nothing to salvage. The SDK's own retries
 * do not cover a stream that fails after headers, which is exactly the failure long
 * generations are most exposed to.
 *
 * Delays are a parameter rather than a constant so tests do not have to sleep through them.
 */
export async function retryTransient<T>(
	run: () => Promise<T>,
	opts: { delaysMs?: number[]; onRetry?: (attempt: number, err: unknown) => void } = {},
): Promise<T> {
	const delays = opts.delaysMs ?? [2000, 8000, 20000];
	for (let attempt = 0; ; attempt++) {
		try {
			return await run();
		} catch (err) {
			if (attempt >= delays.length || !isTransientApiError(err)) throw err;
			opts.onRetry?.(attempt + 1, err);
			await new Promise((r) => setTimeout(r, delays[attempt]));
		}
	}
}

/**
 * Recover graph entries the model serialised into a STRING argument instead of the structured
 * `nodes`/`edges` arrays.
 *
 * Observed live on 2026-07-30: a `record` call arrives with its finding text ending in a
 * literal `<parameter name="nodes">[{"id":"editor/captions-toolbar",...}]` — tool-call markup
 * emitted as prose. The payload is well-formed JSON, so the knowledge is intact; only its
 * envelope is wrong, and without this it lands in the appmap as narrative rather than as
 * queryable nodes. 15 of 28 findings in that run leaked this way, carrying 73 entries.
 *
 * That matters beyond tidiness: `findScopeAmbiguities()` reads nodes, so a scope pair recorded
 * only as prose produces no warning for the task agent — the exact failure the graph exists to
 * prevent.
 *
 * Deliberately permissive about the closing tag (a truncated generation often has none) and
 * silent on unparseable blocks: this is salvage, and a half-written array should cost its own
 * entries, not the whole finding. Returns the cleaned text so the leaked markup does not also
 * end up quoted in the prose map.
 */
export function recoverLeakedGraph(text: string): {
	cleaned: string;
	nodes: AppMapNode[];
	edges: AppMapEdge[];
} {
	const nodes: AppMapNode[] = [];
	const edges: AppMapEdge[] = [];
	let cleaned = text;
	const pattern = /<parameter\s+name="(nodes|edges)">\s*(\[[\s\S]*?\])\s*(?:<\/parameter>|$)/g;
	for (const match of text.matchAll(pattern)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(match[2]);
		} catch {
			continue; // Truncated mid-array; the rest of the finding is still worth keeping.
		}
		if (!Array.isArray(parsed)) continue;
		if (match[1] === "nodes") nodes.push(...(parsed as AppMapNode[]));
		else edges.push(...(parsed as AppMapEdge[]));
		cleaned = cleaned.replace(match[0], "");
	}

	return { cleaned: cleaned.trimEnd(), nodes, edges };
}
