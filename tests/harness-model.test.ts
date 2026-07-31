import assert from "node:assert/strict";
import { test } from "node:test";
import { failedProvider, isTransientApiError, makeClient, mergeGraph, outputEffort, providerRouting, recoverLeakedGraph, retryTransient, wantsAnthropicDirect } from "../src/core/harness.js";
import type { AppMapEdge, AppMapNode } from "../src/types.js";

// --- transient-error retry. A 12h unattended pass died two minutes in on one mid-stream
// BodyTimeoutError, with nothing recorded and so nothing to salvage.

test("isTransientApiError__ReturnsTrue__When__StreamTerminatedMidBody", () => {
	// The observed shape: no status (headers were already 200), the real cause nested.
	const err = Object.assign(new Error("terminated"), { cause: new Error("BodyTimeoutError") });
	assert.equal(isTransientApiError(err), true);
});

test("isTransientApiError__ReturnsTrue__When__ServerIsOverloadedOrRateLimited", () => {
	for (const status of [429, 500, 503])
		assert.equal(isTransientApiError(Object.assign(new Error("nope"), { status })), true, String(status));
});

test("isTransientApiError__ReturnsFalse__When__RequestIsMalformed", () => {
	// A 400 fails identically forever; retrying it only makes the failure slower.
	assert.equal(isTransientApiError(Object.assign(new Error("bad request"), { status: 400 })), false);
	assert.equal(isTransientApiError(Object.assign(new Error("unauthorized"), { status: 401 })), false);
});

// --- routing around a broken upstream. OpenRouter fans one model id out to several hosts, so a
// failure can belong to the route rather than to the request. Five consecutive 404
// DeploymentNotFound burned a run while the same key got 200s seconds later.

test("failedProvider__NamesTheUpstream__When__TheRouterAttributesTheError", () => {
	const err = { error: { error: { metadata: { provider_name: "Azure" } } } };
	assert.equal(failedProvider(err), "Azure");
});

test("failedProvider__NamesTheUpstream__When__ItOnlySurvivesInTheMessage", () => {
	// The SDK stringifies the body into the message for some error classes; that is the only
	// copy left by the time it reaches the catch.
	const err = new Error(`404 {"error":{"metadata":{"provider_name":"Google Vertex"}}}`);
	assert.equal(failedProvider(err), "Google Vertex");
});

test("failedProvider__ReturnsUndefined__When__NothingIsAttributed", () => {
	assert.equal(failedProvider(new Error("terminated")), undefined);
	assert.equal(failedProvider(undefined), undefined);
	assert.equal(failedProvider({ error: { error: { metadata: { provider_name: "  " } } } }), undefined);
});

test("isTransientApiError__ReturnsTrue__When__AProviderIsNamed", () => {
	// Not a general claim about 404s — a 404 from OUR request stays fatal. It is specific to a
	// router: if the upstream named itself, a different upstream may well answer.
	const err = Object.assign(new Error("no deployment"), { status: 404, error: { error: { metadata: { provider_name: "Azure" } } } });
	assert.equal(isTransientApiError(err), true);
	assert.equal(isTransientApiError(Object.assign(new Error("no such model"), { status: 404 })), false);
});

test("providerRouting__SendsNothing__When__NoProviderHasFailed", () => {
	// An empty ignore list must not appear in the body at all: it would pin routing decisions
	// for every healthy run, which is the overwhelming majority of them.
	assert.deepEqual(providerRouting([]), {});
});

test("providerRouting__ListsEachProviderOnce__When__OneFailedRepeatedly", () => {
	assert.deepEqual(providerRouting(["Azure", "Azure", "Fireworks"]), { provider: { ignore: ["Azure", "Fireworks"] } });
});

test("retryTransient__ReturnsResult__When__SecondAttemptSucceeds", async () => {
	let calls = 0;
	const result = await retryTransient(
		async () => {
			if (++calls === 1) throw new Error("terminated");

			return "mapped";
		},
		{ delaysMs: [0, 0] },
	);
	assert.equal(result, "mapped");
	assert.equal(calls, 2);
});

test("retryTransient__Rethrows__When__ErrorIsNotTransient", async () => {
	let calls = 0;
	await assert.rejects(
		retryTransient(
			async () => {
				calls++;
				throw Object.assign(new Error("bad request"), { status: 400 });
			},
			{ delaysMs: [0, 0] },
		),
		/bad request/,
	);
	assert.equal(calls, 1);
});

test("retryTransient__Rethrows__When__EveryAttemptIsExhausted", async () => {
	let calls = 0;
	await assert.rejects(
		retryTransient(
			async () => {
				calls++;
				throw new Error("terminated");
			},
			{ delaysMs: [0, 0] },
		),
		/terminated/,
	);
	assert.equal(calls, 3); // initial attempt plus one per delay
});

// --- leaked graph recovery. Observed live: the model writes its nodes/edges into the finding
// STRING as literal tool-call markup instead of the structured argument, so the graph stalls
// while the prose keeps growing. The payload is intact; only the envelope is wrong.

test("recoverLeakedGraph__ExtractsNodes__When__ModelWroteThemIntoTheFindingText", () => {
	const finding =
		'EDITOR captions: clicking the captions icon swaps the topbar.\n<parameter name="nodes">' +
		'[{"id":"editor/captions-toolbar","title":"Caption styling toolbar","kind":"surface","scope":"document"}]</parameter>';
	const out = recoverLeakedGraph(finding);
	assert.equal(out.nodes.length, 1);
	assert.equal(out.nodes[0].id, "editor/captions-toolbar");
	assert.doesNotMatch(out.cleaned, /<parameter/);
	assert.match(out.cleaned, /clicking the captions icon/);
});

test("recoverLeakedGraph__ExtractsBoth__When__NodesAndEdgesBothLeaked", () => {
	const out = recoverLeakedGraph(
		'Found it.\n<parameter name="nodes">[{"id":"a","title":"A","kind":"surface","scope":"app"}]</parameter>' +
			'<parameter name="edges">[{"from":"root","to":"a","action":"click \\"A\\""}]</parameter>',
	);
	assert.equal(out.nodes.length, 1);
	assert.equal(out.edges.length, 1);
	assert.equal(out.cleaned, "Found it.");
});

test("recoverLeakedGraph__ExtractsPayload__When__ClosingTagIsMissing", () => {
	// A generation cut off at max_tokens has the array but not the closing tag.
	const out = recoverLeakedGraph(
		'Notes here.\n<parameter name="nodes">[{"id":"a","title":"A","kind":"surface","scope":"app"}]',
	);
	assert.equal(out.nodes.length, 1);
});

test("recoverLeakedGraph__KeepsFinding__When__LeakedJsonIsTruncatedMidArray", () => {
	// Salvage must cost only the unparseable block, never the prose around it.
	const out = recoverLeakedGraph('Real knowledge worth keeping.\n<parameter name="nodes">[{"id":"a","tit');
	assert.equal(out.nodes.length, 0);
	assert.match(out.cleaned, /Real knowledge worth keeping/);
});

test("recoverLeakedGraph__ReturnsTextUnchanged__When__NothingLeaked", () => {
	const out = recoverLeakedGraph("An ordinary finding with no markup in it.");
	assert.equal(out.cleaned, "An ordinary finding with no markup in it.");
	assert.equal(out.nodes.length + out.edges.length, 0);
});

test("recoverLeakedGraph__FeedsMergeGraph__When__PayloadIsRecovered", () => {
	// The recovered entries must be the same shape mergeGraph already accepts.
	const nodes = new Map<string, AppMapNode>();
	const edges = new Map<string, AppMapEdge>();
	const out = recoverLeakedGraph(
		'x\n<parameter name="nodes">[{"id":"settings/theme","title":"Theme","kind":"control","scope":"app","settingKey":"theme"}]</parameter>',
	);
	assert.equal(mergeGraph(nodes, edges, out), 1);
	assert.equal(nodes.get("settings/theme")?.settingKey, "theme");
});

// --- reasoning effort. Highest by default (set by David, 2026-07-31): latency between actions
// is a non-issue for the deliverable, so effort buys reliability; speed comes from :nitro.

test("outputEffort__RequestsMax__When__NothingOverrides", () => {
	delete process.env.AGENT_EFFORT;
	assert.deepEqual(outputEffort(), { output_config: { effort: "max" } });
});

test("outputEffort__PassesTheLevelThrough__When__AGENT_EFFORTIsSet", () => {
	process.env.AGENT_EFFORT = "low";
	try {
		assert.deepEqual(outputEffort(), { output_config: { effort: "low" } });
	} finally {
		delete process.env.AGENT_EFFORT;
	}
});

test("outputEffort__SendsNothing__When__EffortIsOff", () => {
	// `off` must omit the field entirely — an explicit null is not "the model's default"
	// on every provider, and the spread at the call sites relies on {} adding no key.
	process.env.AGENT_EFFORT = "off";
	try {
		assert.deepEqual(outputEffort(), {});
	} finally {
		delete process.env.AGENT_EFFORT;
	}
});

// --- transport routing. Key presence used to pick the client, which silently sent Claude
// runs through OpenRouter the moment both keys existed on one host — the two-provider
// benchmark split (Claude direct, OpenAI routed) cannot survive that rule.

test("wantsAnthropicDirect__ReadsTheIdNamespace__When__AskedWhichTransport", () => {
	// Bare claude-* ids are Anthropic's own spelling.
	assert.equal(wantsAnthropicDirect("claude-fable-5"), true);
	assert.equal(wantsAnthropicDirect("claude-opus-5"), true);
	assert.equal(wantsAnthropicDirect("anthropic:claude-fable-5"), true);
	// vendor/model is OpenRouter's namespace — INCLUDING its spelling for Claude, which is how
	// an operator deliberately routes Claude through the router.
	assert.equal(wantsAnthropicDirect("anthropic/claude-fable-5"), false);
	assert.equal(wantsAnthropicDirect("openai/gpt-5.6-sol:nitro"), false);
});

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
	const prev: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(env)) {
		prev[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		return fn();
	} finally {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

test("makeClient__GoesDirect__When__TheModelIsABareClaudeId", () => {
	// Both keys present — the state a provisioned fleet Mac is in. The ID decides, so the
	// Claude arm does NOT get routed through OpenRouter just because its key is there.
	const { model, transport } = withEnv(
		{ AGENT_MODEL: "claude-fable-5", ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: "sk-or-test" },
		() => makeClient(),
	);
	assert.equal(model, "claude-fable-5");
	assert.equal(transport, "anthropic");
});

test("makeClient__RoutesThroughOpenRouter__When__TheIdIsNamespaced", () => {
	const { model, transport } = withEnv(
		{ AGENT_MODEL: "openai/gpt-5.6-sol:nitro", ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: "sk-or-test" },
		() => makeClient(),
	);
	assert.equal(model, "openai/gpt-5.6-sol:nitro");
	assert.equal(transport, "openrouter");
});

test("makeClient__UsesTheResponsesTransport__When__TheIdIsAzurePrefixed", () => {
	// The deployment name — not a catalog id — is what reaches the wire, because that is what
	// Azure routes on. The `azure/` prefix is consumed by the transport choice.
	const { model, transport } = withEnv(
		{
			AGENT_MODEL: "azure/gpt-5.6-sol",
			AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com/openai/responses?api-version=2025-04-01-preview",
			AZURE_OPENAI_API_KEY: "az-test",
		},
		() => makeClient(),
	);
	assert.equal(model, "gpt-5.6-sol");
	assert.equal(transport, "azure-responses");
});

test("makeClient__DefaultsToFableDirect__When__AnAnthropicKeyExists", () => {
	const { model, transport } = withEnv({ AGENT_MODEL: undefined, ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: "sk-or-test" }, () => makeClient());
	assert.equal(model, "claude-fable-5");
	assert.equal(transport, "anthropic");
});

test("makeClient__Refuses__When__TheAskedModelHasNoKeyForItsTransport", () => {
	// Naming the missing key beats a 401 from a provider the operator did not think they were
	// using — the failure that the key-presence rule produced silently.
	assert.throws(
		() => withEnv({ AGENT_MODEL: "claude-fable-5", ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: "sk-or-test" }, () => makeClient()),
		/needs ANTHROPIC_API_KEY/,
	);
	assert.throws(
		() => withEnv({ AGENT_MODEL: "openai/gpt-5.6-sol", ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: undefined }, () => makeClient()),
		/needs OPENROUTER_API_KEY/,
	);
	// Azure names BOTH of its variables, since a half-configured endpoint is the likely mistake.
	assert.throws(
		() => withEnv({ AGENT_MODEL: "azure/gpt-5.6-sol", AZURE_OPENAI_ENDPOINT: undefined, AZURE_OPENAI_API_KEY: "az" }, () => makeClient()),
		/needs AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY/,
	);
});
