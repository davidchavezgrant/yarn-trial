import Anthropic from "@anthropic-ai/sdk";
import type { AppMapEdge, AppMapNode } from "../../types.js";

/**
 * The OpenRouter default is an OpenAI model, reached through OpenRouter's Anthropic-format
 * `/api/v1/messages` endpoint — verified to carry tool use, streaming, base64 screenshots and
 * `thinking` blocks unchanged, so the SDK and both loops need no restructuring. `sol` rather
 * than `sol-pro`: same weights and price, but pro's `reasoning.mode=pro` buys longer thinking
 * per turn, and these loops are long and sequential — a 96-action pass pays that cost 96
 * times. `AGENT_MODEL` overrides, including to `openai/gpt-5.6-sol-pro` or any `anthropic/*` id.
 *
 * One measured consequence: OpenRouter returns a null `cache_creation_input_tokens` for OpenAI
 * models, so the `cache_control` blocks the explore/agent prompts carry are accepted and then
 * ignored. Nothing breaks; the per-chapter system prompt is simply billed in full each time.
 */
export function makeClient(): { client: Anthropic; model: string } {
	const openrouter = process.env.OPENROUTER_API_KEY;
	const model = process.env.AGENT_MODEL ?? (openrouter ? "openai/gpt-5.6-sol" : "claude-opus-5");
	const client = openrouter
		? new Anthropic({ baseURL: "https://openrouter.ai/api", authToken: openrouter })
		: new Anthropic();

	return { client, model };
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
