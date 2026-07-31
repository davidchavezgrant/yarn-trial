/**
 * What a run cost, in dollars, from the tokens it recorded.
 *
 * This exists because "how much will the matrix cost" could previously only be bracketed,
 * and the bracket spanned 6x. Two things caused that and both are now closed upstream:
 * cache WRITES were never recorded (they bill at 1.25x input against reads' 0.1x, so they
 * dominate), and explore passes recorded no tokens at all — making the matrix's most
 * expensive runs the only uncostable ones.
 *
 * Rates are per MILLION tokens and are a published-price snapshot, not a billing feed. Three
 * consequences worth stating plainly, because a number in a report reads as authoritative:
 *
 *  - Estimates only. Nothing here reconciles against an invoice. Discounts, batch pricing,
 *    minimum billing increments, and provider-side promotions are all invisible to it.
 *  - Azure/OpenAI deployments bill through Microsoft at rates tied to the subscription, so
 *    UNKNOWN_RATE is the honest answer for them rather than a guess. A run whose model has
 *    no rate contributes no cost and IS COUNTED SEPARATELY, so a total can never quietly
 *    omit half the matrix and still look complete.
 *  - Anthropic and Azure count input differently: Anthropic's `input_tokens` excludes cache
 *    reads, Azure's includes them. The per-token fields are stored as each provider reported
 *    them, so summing them across providers is meaningless — which is why costing happens
 *    per run, against that run's own rate card, and only the DOLLARS are added up.
 */

/** Dollars per million tokens. */
export interface Rates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * Published prices as of 2026-07-31. Keyed by the model id the RUN LOG recorded (makeClient
 * writes what actually ran), not by what dispatch asked for.
 *
 * Cache multipliers, verified against the published pricing page 2026-07-31: reads 0.1x
 * input, 5-minute writes 1.25x, ONE-HOUR writes 2x. `cacheWrite` below is the 5m rate,
 * which is what the loops actually use — if any loop ever sets a 1h TTL, that needs a
 * separate rate, not a fudged multiplier (for Fable 5 it is $20/MTok, not $12.50).
 *
 * Two things deliberately NOT modelled, both checked rather than assumed:
 *  - Long context has NO premium. Claude 4.6 and later bill the full 1M window at standard
 *    rates, so a 900k-token request costs the same per token as a 9k one. An earlier draft
 *    of this file was about to add a 200k+ tier; it would have been wrong.
 *  - `inference_geo: "us"` carries a 1.1x multiplier on every category. The loops do not set
 *    the parameter, so global (standard) applies. If that changes, every rate here scales.
 */
export const RATES: Record<string, Rates> = {
	"claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	"claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	// Sonnet 5 introductory pricing runs through 2026-08-31; standard ($3/$15) resumes
	// 2026-09-01. Whoever is here after that date: bump this row.
	"claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	"claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/** Tokens a run reported. Every field optional — an old artifact simply costs nothing. */
export interface TokenCounts {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
}

/**
 * Strip routing decoration so `anthropic/claude-fable-5`, `claude-fable-5:nitro` and
 * `anthropic:claude-fable-5` all price as the same model. Deliberately does NOT invent a
 * match for unknown ids — a near-miss priced against the wrong row is worse than no price.
 */
export const normaliseModel = (model: string): string =>
	model
		.trim()
		.replace(/^[a-z]+[:/]/i, "")
		.replace(/:[a-z]+$/i, "");

/**
 * Rates supplied at runtime for a model this file has no card for — Azure/OpenAI, whose
 * price is tied to the subscription rather than published.
 *
 *   MODEL_RATES="gpt-5.6-sol:in=1.25,out=10,cacheRead=0.125,cacheWrite=1.25"
 *
 * Semicolon-separate several. This exists so a pass that ran unpriced can be costed LATER by
 * setting the variable and re-running `bench collect` — the tokens are already in the
 * manifest, so nothing needs re-running. Unparseable entries are ignored rather than
 * throwing: a typo in an env var must not take down a report that is otherwise correct.
 */
export function envRates(raw = process.env.MODEL_RATES): Record<string, Rates> {
	const out: Record<string, Rates> = {};
	for (const chunk of (raw ?? "").split(";")) {
		const [id, spec] = chunk.split(":");
		if (!id?.trim() || !spec) continue;
		const f: Record<string, number> = {};
		for (const kv of spec.split(",")) {
			const [k, v] = kv.split("=");
			const n = Number(v);
			if (k?.trim() && Number.isFinite(n)) f[k.trim()] = n;
		}
		// Input and output are mandatory; cache rates fall back to the standard multipliers
		// (0.1x read, 1.25x 5-minute write) rather than to zero, which would understate.
		if (f.in === undefined || f.out === undefined) continue;
		out[normaliseModel(id)] = { input: f.in, output: f.out, cacheRead: f.cacheRead ?? f.in * 0.1, cacheWrite: f.cacheWrite ?? f.in * 1.25 };
	}

	return out;
}

export const ratesFor = (model: string | undefined): Rates | undefined => {
	if (!model) return undefined;
	const id = normaliseModel(model);

	return envRates()[id] ?? RATES[id];
};

/**
 * Dollars for one run, or undefined when the model has no rate card. Undefined is a real
 * answer here — see the Azure note in the header — and callers must surface it rather than
 * coerce it to zero.
 */
export function estimateCost(tokens: TokenCounts, model: string | undefined): number | undefined {
	const r = ratesFor(model);
	if (!r) return undefined;

	const m = (n: number | undefined, rate: number): number => ((n ?? 0) * rate) / 1_000_000;

	return m(tokens.inputTokens, r.input) + m(tokens.outputTokens, r.output) + m(tokens.cacheReadTokens, r.cacheRead) + m(tokens.cacheCreationTokens, r.cacheWrite);
}

export interface CostRollup {
	/** Dollars across runs that could be priced. */
	usd: number;
	/** How many runs contributed. */
	priced: number;
	/** Runs whose model has no rate card — the reason a total may understate. */
	unpriced: number;
	/** Distinct unpriced model ids, so the report can name what is missing. */
	unpricedModels: string[];
}

/** Sum per-run dollars, keeping the unpriced remainder visible instead of silently dropping it. */
export function rollupCost(runs: Array<TokenCounts & { model?: string }>): CostRollup {
	const unpricedModels = new Set<string>();
	let usd = 0;
	let priced = 0;
	let unpriced = 0;
	for (const run of runs) {
		const c = estimateCost(run, run.model);
		if (c === undefined) {
			unpriced++;
			unpricedModels.add(run.model ? normaliseModel(run.model) : "unknown");
			continue;
		}
		usd += c;
		priced++;
	}

	return { usd, priced, unpriced, unpricedModels: [...unpricedModels].sort() };
}

/** `$1.23`, or `$0.0412` under a cent — arm-level costs are small and rounding hides them. */
export const usd = (n: number): string => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
