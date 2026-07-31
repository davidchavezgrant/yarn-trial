/**
 * Ground truth for what the matrix actually cost, from Anthropic's own accounting rather
 * than from tokens the run counted for itself.
 *
 * Why bother when cost.ts already estimates: a run log records what the SDK handed back, and
 * a run that crashed, was killed by the stall watchdog, or died mid-stream may have been
 * billed for work its log never saw. The estimate also cannot see retries that burned a
 * completion before failing. This reconciles both against the invoice side.
 *
 * The two endpoints have deliberately different shapes, and the difference decides what is
 * answerable (both checked against the API reference 2026-07-31):
 *
 *   /v1/organizations/cost_report          buckets: 1d ONLY   group_by: description, workspace_id
 *   /v1/organizations/usage_report/messages buckets: 1m/1h/1d  group_by: api_key_id, model, +6
 *
 * So definitive DOLLARS are daily and workspace-level at best — there is no per-run cost
 * figure to be had, and anyone who claims one is estimating. Definitive TOKENS, though, come
 * at MINUTE granularity grouped by API key, and that is enough: applying published rates to
 * Anthropic's own token counts is as close to per-run truth as the API allows, and the daily
 * cost_report total is the check that the rate card is right.
 *
 * Per-run attribution works because of a property of the fleet rather than of the API: the
 * per-Mac lease permits exactly ONE run per Mac at a time. Give each Mac its own API key and
 * every (api_key_id, minute) belongs to exactly one run. Share a key across Macs and the
 * minute buckets blend concurrent runs — the reconciliation then only holds fleet-wide, which
 * is why `perHost` reports what it could and could not attribute rather than pretending.
 *
 * Auth is an ADMIN credential (`Authorization: Bearer …`), not the run-time API key —
 * ANTHROPIC_ADMIN_KEY here. Without it this command is skipped, never guessed at.
 */
import { estimateCost, type Rates, ratesFor, usd } from "./cost.js";

const USAGE_URL = "https://api.anthropic.com/v1/organizations/usage_report/messages";
const COST_URL = "https://api.anthropic.com/v1/organizations/cost_report";

/** One (bucket, group) row, flattened out of the report's nesting. */
export interface UsageRow {
	startingAt: string;
	endingAt: string;
	apiKeyId?: string;
	model?: string;
	uncachedInputTokens: number;
	cacheReadInputTokens: number;
	/** 5-minute and 1-hour writes kept APART: they bill at 1.25x and 2x, not the same rate. */
	cacheWrite5mTokens: number;
	cacheWrite1hTokens: number;
	outputTokens: number;
}

/**
 * Flatten the report's `data[].results[]` nesting. Unknown/absent numeric fields become 0 —
 * a group that reported no cache writes genuinely wrote none, unlike a missing rate card.
 */
export function parseUsageReport(body: Record<string, any>): UsageRow[] {
	const out: UsageRow[] = [];
	for (const bucket of Array.isArray(body?.data) ? body.data : []) {
		for (const r of Array.isArray(bucket?.results) ? bucket.results : []) {
			out.push({
				startingAt: String(bucket.starting_at ?? ""),
				endingAt: String(bucket.ending_at ?? ""),
				...(r.api_key_id ? { apiKeyId: String(r.api_key_id) } : {}),
				...(r.model ? { model: String(r.model) } : {}),
				uncachedInputTokens: Number(r.uncached_input_tokens ?? 0),
				cacheReadInputTokens: Number(r.cache_read_input_tokens ?? 0),
				cacheWrite5mTokens: Number(r.cache_creation?.ephemeral_5m_input_tokens ?? 0),
				cacheWrite1hTokens: Number(r.cache_creation?.ephemeral_1h_input_tokens ?? 0),
				outputTokens: Number(r.output_tokens ?? 0),
			});
		}
	}

	return out;
}

/**
 * Price a usage row against published rates, charging 1h cache writes at 2x base input
 * rather than at the 5m rate. cost.ts's single `cacheWrite` field cannot express that, which
 * is exactly why this function exists instead of reusing estimateCost for these rows.
 */
export function priceUsageRow(row: UsageRow): number | undefined {
	const r: Rates | undefined = ratesFor(row.model);
	if (!r) return undefined;
	const per = (n: number, rate: number): number => (n * rate) / 1_000_000;

	return (
		per(row.uncachedInputTokens, r.input) +
		per(row.cacheReadInputTokens, r.cacheRead) +
		per(row.cacheWrite5mTokens, r.cacheWrite) +
		per(row.cacheWrite1hTokens, r.input * 2) +
		per(row.outputTokens, r.output)
	);
}

/** Dollars from the cost report, whose `amount` is a decimal string in CENTS. */
export function parseCostReport(body: Record<string, any>): number {
	let cents = 0;
	for (const bucket of Array.isArray(body?.data) ? body.data : []) {
		for (const r of Array.isArray(bucket?.results) ? bucket.results : []) {
			const n = Number(r?.amount);
			if (Number.isFinite(n)) cents += n;
		}
	}

	return cents / 100;
}

export interface Fetcher {
	(url: string, init: { headers: Record<string, string> }): Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
}

const get = async (fetcher: Fetcher, url: string, params: Record<string, string | string[]>, key: string): Promise<any> => {
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) for (const one of Array.isArray(v) ? v : [v]) q.append(k, one);
	const res = await fetcher(`${url}?${q}`, {
		headers: { "anthropic-version": "2023-06-01", Authorization: `Bearer ${key}` },
	});
	if (!res.ok) throw new Error(`${url} returned ${res.status}`);

	return res.json();
};

export interface TrueCost {
	/** Priced from Anthropic's own token counts at published rates. */
	usdFromUsage: number;
	/** Billed dollars from the cost report — the invoice side. Undefined if not fetched. */
	usdFromCostReport?: number;
	rows: UsageRow[];
	/** Rows whose model has no rate card; their tokens are real but unpriceable here. */
	unpricedRows: number;
}

/**
 * Pull both reports for a window. `startingAt`/`endingAt` are RFC 3339; the API snaps them
 * to bucket boundaries in UTC.
 *
 * Minute buckets cap at 1440 (24h) per the API's own limit, so a matrix spanning more than a
 * day must be fetched a day at a time — this does NOT paginate for you, and a truncated
 * window silently returning fewer buckets would understate the total. Callers get the raw
 * rows back so they can check coverage themselves.
 */
export async function fetchTrueCost(
	opts: { startingAt: string; endingAt?: string; adminKey: string; bucketWidth?: "1m" | "1h" | "1d"; fetcher?: Fetcher; includeCostReport?: boolean },
): Promise<TrueCost> {
	const fetcher = opts.fetcher ?? ((url, init) => fetch(url, init) as any);
	const usageBody = await get(
		fetcher,
		USAGE_URL,
		{
			starting_at: opts.startingAt,
			...(opts.endingAt ? { ending_at: opts.endingAt } : {}),
			bucket_width: opts.bucketWidth ?? "1h",
			"group_by[]": ["api_key_id", "model"],
			limit: "168",
		},
		opts.adminKey,
	);
	const rows = parseUsageReport(usageBody);
	let usdFromUsage = 0;
	let unpricedRows = 0;
	for (const row of rows) {
		const p = priceUsageRow(row);
		if (p === undefined) {
			unpricedRows++;
			continue;
		}
		usdFromUsage += p;
	}

	let usdFromCostReport: number | undefined;
	if (opts.includeCostReport !== false) {
		// Daily only, and the bucket covers the WHOLE day — including anything else the org
		// ran. It validates the rate card; it does not isolate the matrix unless the matrix
		// had the day (or a workspace) to itself.
		const costBody = await get(fetcher, COST_URL, { starting_at: opts.startingAt, ...(opts.endingAt ? { ending_at: opts.endingAt } : {}), bucket_width: "1d" }, opts.adminKey);
		usdFromCostReport = parseCostReport(costBody);
	}

	return { usdFromUsage, rows, unpricedRows, ...(usdFromCostReport !== undefined ? { usdFromCostReport } : {}) };
}

/** Human-readable reconciliation: our estimate against Anthropic's numbers. */
export function reconcile(estimated: number, truth: TrueCost): string[] {
	const lines = [
		`estimated from run logs : ${usd(estimated)}`,
		`priced from usage report: ${usd(truth.usdFromUsage)}  (${truth.rows.length} rows${truth.unpricedRows ? `, ${truth.unpricedRows} unpriceable` : ""})`,
	];
	if (truth.usdFromCostReport !== undefined) lines.push(`billed per cost report  : ${usd(truth.usdFromCostReport)}  (whole-org, whole-day — see header)`);
	if (truth.usdFromUsage > 0) {
		const drift = ((estimated - truth.usdFromUsage) / truth.usdFromUsage) * 100;
		// Drift is the interesting number, not the totals: a large negative gap means runs
		// were billed for work their logs never recorded (crashes, killed streams, retries),
		// which is a correctness signal about the harness, not just an accounting note.
		lines.push(`drift                   : ${drift >= 0 ? "+" : ""}${drift.toFixed(1)}% (log estimate vs Anthropic's tokens)`);
	}

	return lines;
}

export { estimateCost };
