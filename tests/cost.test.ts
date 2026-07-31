/**
 * Cost estimation and the reconciliation against Anthropic's own accounting.
 *
 * The rates themselves are a published-price snapshot and cannot be unit-tested against
 * truth — what CAN be tested is that the arithmetic charges each token category at its own
 * rate, that an unknown model refuses to be priced rather than silently costing zero, and
 * that 1-hour cache writes are not billed at the 5-minute rate. Those are the three ways a
 * cost report goes quietly wrong.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { estimateCost, normaliseModel, rollupCost, usd } from "../src/bench/cost.js";
import { type Fetcher, fetchTrueCost, parseCostReport, parseUsageReport, priceUsageRow, reconcile } from "../src/bench/truecost.js";

test("estimateCost__ChargesEachCategoryAtItsOwnRate__When__ModelIsKnown", () => {
	// Fable 5: $10 in / $50 out / $1 cache read / $12.50 cache write, per MTok.
	const c = estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 }, "claude-fable-5");
	assert.equal(c, 10 + 50 + 1 + 12.5);
});

test("estimateCost__ReturnsUndefined__When__ModelHasNoRateCard", () => {
	assert.equal(estimateCost({ inputTokens: 1_000_000 }, "some-unlisted-model"), undefined);
	assert.equal(estimateCost({ inputTokens: 1_000_000 }, undefined), undefined);
});

test("estimateCost__ChargesNothingForCacheWrites__When__ModelIsOnTheResponsesAPI", () => {
	// OpenAI caching is automatic: a hit is billed cheaper and there is no creation event.
	// A non-zero cacheWrite here would invent a charge the provider does not levy.
	assert.equal(estimateCost({ cacheCreationTokens: 10_000_000 }, "gpt-5.6-sol"), 0);
	// $5 in / $30 out / $0.50 cached — OpenAI standard list, standing in for Azure's
	// subscription rates, so the primary pass reads as an upper bound.
	assert.equal(estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 }, "azure/gpt-5.6-sol"), 5 + 30 + 0.5);
});

test("estimateCost__DoesNotDoubleBillCachedTokens__When__PricingAResponsesRun", () => {
	// Responses reports input_tokens as the TOTAL with cached a subset; responses.ts
	// normalises it to Anthropic semantics (uncached only). This asserts the CONSEQUENCE:
	// a 78k-input/44k-cached run must cost the uncached remainder at full rate, not 78k.
	const normalised = estimateCost({ inputTokens: 78_678 - 44_544, cacheReadTokens: 44_544 }, "gpt-5.6-sol");
	const doubleBilled = estimateCost({ inputTokens: 78_678, cacheReadTokens: 44_544 }, "gpt-5.6-sol");
	assert.ok(normalised !== undefined && doubleBilled !== undefined);
	assert.ok(normalised < doubleBilled);
	assert.equal(Math.round(normalised * 10000) / 10000, Math.round(((78_678 - 44_544) * 5 + 44_544 * 0.5) / 1_000_000 * 10000) / 10000);
});

test("estimateCost__CountsCacheWritesAsTheDominantCost__When__ARunIsLongLived", () => {
	// The point of instrumenting cache writes: they outweigh reads by 12.5x per token, so a
	// run whose prefix is rewritten on TTL expiry costs far more than its read volume implies.
	const readHeavy = estimateCost({ cacheReadTokens: 1_000_000 }, "claude-fable-5");
	const writeHeavy = estimateCost({ cacheCreationTokens: 1_000_000 }, "claude-fable-5");
	assert.ok(writeHeavy !== undefined && readHeavy !== undefined);
	assert.equal(writeHeavy / readHeavy, 12.5);
});

test("normaliseModel__StripsRoutingDecoration__When__IdCarriesVendorOrSuffix", () => {
	for (const id of ["claude-fable-5", "anthropic/claude-fable-5", "anthropic:claude-fable-5", "claude-fable-5:nitro"]) {
		assert.equal(normaliseModel(id), "claude-fable-5", id);
		assert.ok(estimateCost({ outputTokens: 1_000_000 }, id) === 50, id);
	}
});

test("rollupCost__KeepsUnpricedRunsVisible__When__AModelHasNoRateCard", () => {
	// Both listed models now price, so the unpriced path is exercised with a model that is
	// genuinely absent — the case that matters is a run vanishing from a total that then
	// reads as complete, not which specific vendor happens to be missing today.
	const r = rollupCost([
		{ outputTokens: 1_000_000, model: "claude-fable-5" },
		{ outputTokens: 1_000_000, model: "gpt-5.6-sol" },
		{ outputTokens: 1_000_000, model: "some-unlisted-model" },
	]);
	assert.equal(r.usd, 50 + 30);
	assert.equal(r.priced, 2);
	assert.equal(r.unpriced, 1);
	assert.deepEqual(r.unpricedModels, ["some-unlisted-model"]);
});

test("usd__KeepsSubCentPrecision__When__AnArmIsCheap", () => {
	assert.equal(usd(4.126), "$4.13");
	// Arm-level costs can sit under a cent; rounding them to $0.00 hides real spend.
	assert.equal(usd(0.0042), "$0.0042");
});

const USAGE_BODY = {
	data: [
		{
			starting_at: "2026-07-31T10:00:00Z",
			ending_at: "2026-07-31T11:00:00Z",
			results: [
				{
					api_key_id: "apikey_mac1",
					model: "claude-fable-5",
					uncached_input_tokens: 1_000_000,
					cache_read_input_tokens: 1_000_000,
					cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
					output_tokens: 1_000_000,
				},
			],
		},
	],
};

test("parseUsageReport__FlattensBucketsAndSplitsCacheTTLs__When__GroupedByKeyAndModel", () => {
	const rows = parseUsageReport(USAGE_BODY);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].apiKeyId, "apikey_mac1");
	// The two TTLs must stay apart — they bill at 1.25x and 2x base input.
	assert.equal(rows[0].cacheWrite5mTokens, 1_000_000);
	assert.equal(rows[0].cacheWrite1hTokens, 1_000_000);
});

test("priceUsageRow__BillsOneHourWritesAtDoubleInput__When__BothTTLsArePresent", () => {
	const [row] = parseUsageReport(USAGE_BODY);
	// 10 (uncached) + 1 (read) + 12.50 (5m write) + 20 (1h write = 2x input) + 50 (output).
	assert.equal(priceUsageRow(row), 10 + 1 + 12.5 + 20 + 50);
	// A 1h write charged at the 5m rate would understate by $7.50 per MTok — the specific
	// error this function exists to avoid, since cost.ts holds only one cacheWrite rate.
	assert.notEqual(priceUsageRow(row), 10 + 1 + 12.5 + 12.5 + 50);
});

test("parseCostReport__ConvertsCentsToDollars__When__AmountsAreDecimalStrings", () => {
	// The API documents `amount` as lowest currency units: "123.45" is $1.2345.
	assert.equal(parseCostReport({ data: [{ results: [{ amount: "123.45" }, { amount: "76.55" }] }] }), 2);
});

test("parseUsageReport__ReturnsEmpty__When__BodyIsMalformed", () => {
	for (const body of [{}, { data: null }, { data: [{}] }, { data: [{ results: "nope" }] }]) assert.deepEqual(parseUsageReport(body as any), []);
});

test("fetchTrueCost__RequestsMinuteBucketsGroupedByKey__When__AskedForPerRunTruth", async () => {
	const seen: string[] = [];
	const fetcher: Fetcher = async (url) => {
		seen.push(url);

		return { ok: true, status: 200, json: async () => (url.includes("usage_report") ? USAGE_BODY : { data: [{ results: [{ amount: "9350" }] }] }) };
	};
	const truth = await fetchTrueCost({ startingAt: "2026-07-31T00:00:00Z", adminKey: "sk-ant-admin-x", bucketWidth: "1m", fetcher });

	assert.equal(truth.usdFromUsage, 93.5);
	assert.equal(truth.usdFromCostReport, 93.5);
	const usage = seen.find((u) => u.includes("usage_report")) ?? "";
	assert.match(usage, /bucket_width=1m/);
	// Per-run attribution depends on grouping by API key — the fleet's one-run-per-Mac lease
	// is what makes a (key, minute) unambiguous, and without this group_by it is lost.
	assert.match(usage, /group_by%5B%5D=api_key_id/);
	assert.match(usage, /group_by%5B%5D=model/);
	// The cost report has no minute buckets to ask for; requesting one would 400.
	assert.match(seen.find((u) => u.includes("cost_report")) ?? "", /bucket_width=1d/);
});

test("fetchTrueCost__Throws__When__TheAdminCredentialIsRejected", async () => {
	const fetcher: Fetcher = async () => ({ ok: false, status: 401, json: async () => ({}) });
	await assert.rejects(() => fetchTrueCost({ startingAt: "2026-07-31T00:00:00Z", adminKey: "bad", fetcher }), /401/);
});

test("reconcile__ReportsDriftAgainstAnthropicsTokens__When__TheLogEstimateDisagrees", () => {
	const lines = reconcile(80, { usdFromUsage: 100, rows: [], unpricedRows: 0 }).join("\n");
	// Negative drift is the signal worth surfacing: the org was billed for work the run logs
	// never recorded — crashed runs, killed streams, retries that burned a completion.
	assert.match(lines, /drift\s+: -20\.0%/);
});
