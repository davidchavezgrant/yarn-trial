import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import { failedProvider, mergeGraph, newDeclaredLedger, newFrontier, OUT, runKey } from "../harness.js";
import { appmapsDir } from "../../paths.js";
import { appmapSlug, type Target, targetSlug } from "../target.js";
import type { AppMap, AppMapEdge, AppMapHome, AppMapNode, GatedBoundary } from "../../types.js";

/** The payload of the "finish" tool — the pass's entire output, prose plus graph. */
export type FinishInput = { document: string; nodes?: AppMapNode[]; edges?: AppMapEdge[]; home?: AppMapHome };
export type GraphInput = { nodes?: AppMapNode[]; edges?: AppMapEdge[] };
export type StopReason = "frontier-empty" | "action-ceiling" | "frontier-conceded" | "interrupted" | "error";

export const newPass = (target: Target, app: string, backendKind: string, vision: boolean, guidance: string | undefined, visionOnly = false) => {
	const findings: string[] = [];
	// Per BACKEND and per perception tier, never one shared slot: a vision-only pass must not
	// overwrite the element-grounded map (the benchmark compares the tiers), and an ax map must
	// not overwrite a cdp one (the two name the same surfaces differently, so a run grounded on
	// the wrong vocabulary fails to resolve controls for reasons that look like backend
	// weakness). appmapSlug owns the naming so writers and readers cannot drift.
	const slug = appmapSlug(targetSlug(target), { visionOnly, noVision: !vision, backend: backendKind });
	const outPath = `${appmapsDir()}/${slug}.md`;
	const graphPath = `${appmapsDir()}/${slug}.json`;
	fs.mkdirSync(appmapsDir(), { recursive: true });
	fs.mkdirSync(`${OUT}/runs`, { recursive: true });

	// Declared out here, not in the try, because the salvage path in the catch needs them:
	// the transcript IS the pass's memory, and a throw must not put it out of reach.
	const messages: Anthropic.MessageParam[] = [];
	const startedAt = Date.now();
	// Upstream providers this pass has watched fail. Fed back to OpenRouter as an ignore list so
	// a retry is routed elsewhere; a plain backoff re-asks the same broken host. An exploration
	// pass is 40 minutes of actions, so losing it to one bad route is the expensive case.
	const badProviders = new Set<string>();
	const ledger = newFrontier();
	// The vision-only pass's coverage ledger, built from the model's own survey/target
	// declarations rather than observations. Present on every pass (cheap, empty when unused)
	// so the loop can be typed against one Pass shape.
	const declared = newDeclaredLedger();

	/**
	 * The graph, accumulated as the pass goes rather than assembled at the end.
	 *
	 * Everything learned used to live only in the transcript until "finish", which made a
	 * truncated pass a weak map and a crashed pass nothing at all. Accumulating here is what
	 * makes the two things below safe: resetting the context (the model need not remember
	 * chapter 1 at hour 11) and being killed (the checkpoint on disk is already current).
	 */
	const graphNodes = new Map<string, AppMapNode>();
	const graphEdges = new Map<string, AppMapEdge>();

	// `gated` accumulates boundary reads the same way `findings` accumulates prose; the journal
	// path and claim ledger are set below, once `stamp` exists.
	const gated: GatedBoundary[] = [];

	/**
	 * Crash insurance. Deliberately NOT written to docs/appmaps/: a pass that dies at action
	 * 3 would otherwise overwrite a good 45-node map with two nodes, which is worse than the
	 * loss it is meant to prevent. Promote a checkpoint by hand if a run is killed.
	 */
	const stamp = runKey("explore-", app);
	const checkpointPath = `${OUT}/runs/${stamp}.checkpoint.json`;
	// Where a pass that must not replace the committed map writes instead — the checkpoint's
	// naming family, promoted by hand. See the demotion decision in writeArtifacts.
	const salvageProsePath = `${OUT}/runs/${stamp}.salvage.md`;
	const salvageGraphPath = `${OUT}/runs/${stamp}.salvage.json`;
	// Descent's mutation journal, shared with the task agent's format so `npm run cleanup` can
	// replay a crashed descent; `claimed` mirrors the agent's ledger.
	const journalPath = `${OUT}/runs/${stamp}.journal.jsonl`;
	const claimed: Array<{ kind: string; name: string; note?: string; step: number }> = [];

	return {
		target,
		app,
		backendKind,
		vision,
		visionOnly,
		guidance,
		findings,
		outPath,
		graphPath,
		messages,
		tools: [] as Anthropic.Tool[],
		basePrompt: "",
		actions: 0,
		findCalls: 0,
		// An explore pass had no token accounting whatsoever, which made the matrix's most
		// expensive runs the only ones that could not be costed — estimates for them spanned
		// 6x. Tallied in streamCall (the pass's single model call site) and emitted into the
		// appmap stamp, which is the artifact bench already collects for explore arms.
		usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, modelCalls: 0 },
		chapters: 1,
		refusals: 0,
		startedAt,
		badProviders,
		ledger,
		declared,
		graphNodes,
		graphEdges,
		gated,
		stamp,
		checkpointPath,
		salvageProsePath,
		salvageGraphPath,
		journalPath,
		claimed,
	};
};

export type Pass = ReturnType<typeof newPass>;

export const noteProvider = (p: Pass, attempt: number, e: unknown): void => {
	const provider = failedProvider(e);
	if (provider && !p.badProviders.has(provider)) {
		p.badProviders.add(provider);
		console.log(`  routing around provider "${provider}" for the rest of this pass`);
	}
	console.log(`  retry ${attempt} after transient API error: ${(e as Error).message}`);
};

export const merge = (p: Pass, g: GraphInput): number => mergeGraph(p.graphNodes, p.graphEdges, g);

// The graph-so-far, shaped for detectMutation's settingKey/scope lookup. Rebuilt per call
// because both maps grow as the pass records — cheap next to a model call.
export const accumulatedGraph = (p: Pass): AppMap => ({
	app: p.app,
	capturedAt: "",
	provenance: "explore",
	nodes: [...p.graphNodes.values()],
	edges: [...p.graphEdges.values()],
});
