import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import { failedProvider, mergeGraph, newDeclaredLedger, newFrontier, OUT, runKey } from "../harness.js";
import { LIVE_DIR, RUN_FILES, appmapsDir, runDir, runPath } from "../../paths.js";
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
	const slug = appmapSlug(targetSlug(target), { visionOnly, noVision: !vision, axdomOff: process.env.AXDOM === "0", backend: backendKind });
	const outPath = `${appmapsDir()}/${slug}.md`;
	const graphPath = `${appmapsDir()}/${slug}.json`;
	fs.mkdirSync(appmapsDir(), { recursive: true });
	
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
	const checkpointPath = runPath(stamp, RUN_FILES.checkpoint);
	// Where a pass that must not replace the committed map writes instead — the checkpoint's
	// naming family, promoted by hand. See the demotion decision in writeArtifacts.
	// The run's own copy of its map — always written, whether or not it also gets published to
	// docs/appmaps. Formerly named salvage.md/.json and written only when the pass was demoted,
	// which meant a SUCCESSFUL pass left no per-run record at all: its map existed once, at a
	// path keyed by app, waiting to be overwritten by the next pass on that variant.
	// OUT-relative, because observation.ts joins it onto OUT — the same shape run.ts uses. Every
	// pass wrote to a shared out/explore-step-N.png before this, so a second grounding pass
	// silently overwrote the first one's frames and no pass could be reviewed after the next ran.
	const stepsDir = `${LIVE_DIR}/${stamp}/${RUN_FILES.steps}`;
	const appmapProsePath = runPath(stamp, RUN_FILES.appmap);
	const appmapGraphPath = runPath(stamp, RUN_FILES.appmapGraph);
	// Descent's mutation journal, shared with the task agent's format so `npm run cleanup` can
	// replay a crashed descent; `claimed` mirrors the agent's ledger.
	const journalPath = runPath(stamp, RUN_FILES.journal);
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
		/**
		 * Blackouts: times the app stopped exposing ANY addressable element for the full blind
		 * budget. Relaunches: times the harness restarted the app to get out of one.
		 *
		 * Recorded because the retry policy was laundering a real result. Yarn's record control
		 * opens a native helper and the AX tree goes dark permanently — twice on 2026-08-01, same
		 * three actions both times. A blacked-out pass was thrown out and re-run until it happened
		 * to avoid that control, so the published numbers described "ax given it dodged the trap"
		 * and the trap itself appeared nowhere. These two counters are what make a recovered pass
		 * distinguishable from one that never needed recovering.
		 */
		blackouts: 0,
		relaunches: 0,
		startedAt,
		badProviders,
		ledger,
		declared,
		graphNodes,
		graphEdges,
		gated,
		stamp,
		checkpointPath,
		stepsDir,
		appmapProsePath,
		appmapGraphPath,
		journalPath,
		claimed,
	};
};

export type Pass = ReturnType<typeof newPass>;

/** What the loop should do about an observation that exposed nothing. */
export type BlindAction = "advise" | "relaunch" | "concede-turn" | "fatal";

/**
 * The blackout ladder, as a pure decision — extracted because this is precisely where the first
 * version was wrong and nothing could catch it.
 *
 * That version pushed a "call finish NOW" message and threw on the same tick, so the model got
 * two turns to attempt recovery and none to concede: the exit the text named was unreachable.
 * The bug was invisible in review (the message and the throw read fine individually) and
 * invisible in the logs (the message goes into the transcript, which is never printed). Two
 * passes died against it. It lives here, away from the loop's driver/client scaffolding, so the
 * ordering is asserted rather than eyeballed.
 *
 * Rungs, cheapest instrument first: the model's own moves, then the harness's restart (the one
 * instrument the model does not have), then one clear turn to finish, then fatal.
 */
export const blindAction = (streak: number, relaunches: number, budget: number, canRecover: boolean): BlindAction => {
	if (streak < 3) return "advise";
	if (canRecover && relaunches < budget) return "relaunch";
	// Exactly one turn between "we are out of options" and killing the pass. `>= 4` rather than
	// `=== 4` so a caller that somehow skips a count still terminates.
	return streak >= 4 ? "fatal" : "concede-turn";
};

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
