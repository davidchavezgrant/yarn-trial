import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkHome, findScopeAmbiguities, gatedSection, recoverLeakedGraph } from "../harness.js";
import type { AppMap } from "../../types.js";
import { DESCENT_ON } from "./config.js";
import { type FinishInput, merge, type Pass, type StopReason } from "./state.js";
import { archiveRun } from "../../paths.js";

/**
 * Machine-readable stamp distinguishing autonomous exploration output from
 * hand-curated notes. loadGrounding() in agent.ts treats unstamped appmaps as
 * "curated" and the run log records the difference — hand edits to a stamped
 * file MUST remove the stamp (or move the file to docs/curated/).
 *
 * docs/curated/, not docs/procedures/: after the tier rename a PROCEDURE is compiled
 * machine output (docs/procedures/<slug>.procedure.json, a frozen click sequence), so it is
 * the one destination hand-written prose can never have. The three tiers, since the nouns
 * are re-reversible: recipe = harvested PROSE (docs/recipes/*.recipe.md), procedure =
 * compiled JSON, curated = hand-written prose (docs/curated/<app>.md).
 */
export const provenanceHeader = (p: {
	app: string;
	actions: number;
	elapsed: string;
	findings: number;
	backend: string;
	findCalls: number;
	vision: boolean;
	visionOnly?: boolean;
	guidance?: string;
	salvaged?: boolean;
	stopped: string;
	seen: number;
	actuated: number;
	dismissed: number;
	surfaces: number;
	chapters: number;
	gatedRead?: number;
	gatedRefused?: number;
	blackouts?: number;
	relaunches?: number;
	usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; modelCalls: number };
}): string =>
	`<!-- provenance: ${p.visionOnly ? "explore-vision" : "explore"} | app: ${p.app} | date: ${new Date().toISOString().slice(0, 10)} | backend: ${p.backend}${p.vision ? "" : " | vision: off"} | actions: ${p.actions} | elapsed: ${p.elapsed}` +
	(p.usage
		? ` | calls: ${p.usage.modelCalls} | tokens-in: ${p.usage.inputTokens} | tokens-out: ${p.usage.outputTokens} | cache-read: ${p.usage.cacheReadTokens} | cache-write: ${p.usage.cacheCreationTokens}`
		: "") +
	` | findings: ${p.findings} | finds: ${p.findCalls}` +
	` | controls${p.visionOnly ? " (DECLARED)" : ""}: ${p.actuated} actuated / ${p.dismissed} dismissed / ${p.seen} seen | surfaces: ${p.surfaces} | chapters: ${p.chapters} | stopped: ${p.stopped}` +
	` | descent: ${DESCENT_ON && !p.visionOnly ? "on" : "off"} | gated: ${p.gatedRead ?? 0} read / ${p.gatedRefused ?? 0} refused` +
	// Only when nonzero: on the overwhelming majority of passes these are 0/0 and two dead
	// fields in every header is how a stamp becomes unreadable. Present means it happened.
	(p.blackouts ? ` | blackouts: ${p.blackouts} | relaunches: ${p.relaunches ?? 0}` : "") +
	`${p.guidance ? " | operator-guidance: yes" : ""}${p.salvaged ? " | salvaged: session died before finish" : ""} -->\n` +
	(p.visionOnly
		? // The declared frontier's known weakness, stated where the numbers are: the model
			// itself is the only witness to what it saw, so these tallies cannot bound coverage.
			"<!-- controls tallies are DECLARED — self-reported by the model from screenshots, not measured against an element list. A control the pass never declared is invisible to these numbers. -->\n"
		: "<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->\n") +
	// "curated RECIPE", not "curated procedure": a procedure is compiled JSON
	// (docs/procedures/*.procedure.json) and cannot be hand-authored at all, so naming it here told
	// an editor the one thing their edit could not have produced. Hand-written prose is a recipe,
	// and a hand-authored one belongs to the curated tier — which is why the destination below is
	// docs/curated/ and not docs/recipes/, whose filenames are hash-keyed machine output.
	"<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/curated/<app>.md instead. -->\n\n";

export const hm = (ms: number): string => {
	const m = Math.max(0, Math.round(ms / 60000));

	return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};

export const coverageNow = (p: Pass, stopped: string) => {
	// A vision-only pass counts the DECLARED ledger: the mechanical one is deliberately left
	// empty there (see the loop), and reporting zeros for a pass that surveyed forty controls
	// would misfile self-reported coverage as no coverage. Both ledgers share the shape this
	// needs — seen entries carrying a surface, an operated/actuated set, a dismissal map.
	const seen: Map<string, { surface: string }> = p.visionOnly ? p.declared.seen : p.ledger.seen;
	const operated = p.visionOnly ? p.declared.operated : p.ledger.actuated;
	const dismissed = p.visionOnly ? p.declared.dismissed : p.ledger.dismissed;

	return {
		seen: seen.size,
		actuated: [...operated].filter((k) => seen.has(k)).length,
		dismissed: dismissed.size,
		surfaces: new Set([...seen.values()].map((e) => e.surface)).size,
		chapters: p.chapters,
		stopped,
		dismissals: [...new Set(dismissed.values())],
		gatedRead: p.gated.filter((g) => g.tierReached === 1).length,
		gatedRefused: p.gated.filter((g) => g.tierReached === 0).length,
	};
};

export const checkpoint = (p: Pass): void => {
	fs.writeFileSync(
		p.checkpointPath,
		JSON.stringify(
			{
				// Shaped as a valid AppMap so a killed run's checkpoint can be promoted to
				// docs/appmaps/<slug>.json as-is, without hand-adding fields.
				app: p.app,
				capturedAt: new Date().toISOString(),
				provenance: p.visionOnly ? "explore-vision" : "explore",
				actions: p.actions,
				elapsed: hm(Date.now() - p.startedAt),
				coverage: coverageNow(p, "in-progress"),
				findings: p.findings,
				nodes: [...p.graphNodes.values()],
				edges: [...p.graphEdges.values()],
			},
			null,
			2,
		),
	);
};

export const writeArtifacts = (p: Pass, out: FinishInput, stopped: StopReason, salvaged = false): void => {
	merge(p, out);
	// The finish payload is the largest single generation of the run, so it is the most
	// likely place for nodes/edges to be serialised into the prose instead of alongside it.
	// Recovering here also strips the markup from the document that goes into the prompt.
	const recovered = recoverLeakedGraph(out.document);
	merge(p, recovered);
	const cov = coverageNow(p, stopped);
	// Checked, not trusted: this one field is written once and then silently governs the
	// start state of every future run, so a label the pass never actually saw would be a
	// permanent, invisible "failed" reset. Dropping it costs the normalisation and keeps
	// the readiness check, which is the safe way round.
	const { home, problem } = checkHome(out.home, [...p.graphNodes.values()], [...p.graphEdges.values()]);
	if (problem) console.log(`WARNING: discarding declared home — ${problem}`);
	const elapsed = hm(Date.now() - p.startedAt);
	const prose =
		provenanceHeader({
			app: p.app,
			actions: p.actions,
			elapsed,
			findings: p.findings.length,
			backend: p.backendKind,
			findCalls: p.findCalls,
			vision: p.vision,
			visionOnly: p.visionOnly,
			guidance: p.guidance,
			salvaged,
			usage: p.usage,
			blackouts: p.blackouts,
			relaunches: p.relaunches,
			...cov,
		}) +
		recovered.cleaned +
		gatedSection(p.gated);
	/**
	 * Destination decision. A salvaged pass must never replace docs/appmaps/: the map it
	 * asks for carries a FRESH capturedAt, and beats() in remote/appmaps.ts compares stamps,
	 * so a two-finding map overwriting a committed 150-node one would then fan out to every
	 * Mac — the exact loss the checkpoint comment above promises to prevent. Only the model
	 * choosing to finish (frontier-empty or frontier-conceded) has actually swept the
	 * frontier; any other ending that also produced under half the committed node count is
	 * demoted to the salvage files alongside it, promoted by hand.
	 */
	let committedNodes = 0;
	try {
		committedNodes = ((JSON.parse(fs.readFileSync(p.graphPath, "utf8")) as AppMap).nodes ?? []).length;
	} catch {} // no committed map, or an unparseable one — nothing to protect
	/**
	 * `frontier-conceded` is a model finish but NOT a publishable one, and the distinction is the
	 * whole reason the concede exit is safe to offer.
	 *
	 * Conceding sets the same "the model called finish" flag as sweeping the frontier, so a pass
	 * that gave up at action 60 with a third of the app mapped would have published over a
	 * complete 131-action map, counted as a delivered sample, and become what phase 2 grounds on.
	 * Offering a graceful exit would then have quietly improved the numbers — the exact skew the
	 * exit is supposed to avoid. What conceding buys is a clean stop reason and the findings
	 * write-up instead of a stack trace; it does not buy publication.
	 */
	const modelFinished = stopped === "frontier-empty";
	/**
	 * A pass that was CUT SHORT publishes only if it beats half the committed map.
	 *
	 * With no committed map the comparison used to be `size * 2 < 0` — always false — so a
	 * cut-short pass published unconditionally. Least protective exactly where there is no
	 * baseline to fall back on, which is every arm's state after a wipe: a run that died at
	 * action 12 with two nodes would have become the app's grounding, and phase 2 would have
	 * reported `provenance: explore` over it.
	 *
	 * No baseline now means DEMOTE. The map still lands in the run folder and can be promoted by
	 * hand; what it cannot do is silently become the thing later phases ground on.
	 *
	 * Deliberately not a quality score. Absolute size breaks on small apps, and a coverage ratio
	 * is worse than useless here — it counts dismissals, so the pre-fix passes that skipped 1933
	 * of 1985 controls would score 0.97 while the best pass of the night scores 0.06. The honest
	 * signal is structural: did the pass end on its own terms, or was it cut off?
	 */
	const beatsBaseline = committedNodes > 0 && p.graphNodes.size * 2 >= committedNodes;
	// Conceded is demoted UNCONDITIONALLY, not merely subject to the cut-short rule above. That
	// rule can pass a big partial map when a baseline exists, and "big enough to beat half the
	// old map" is not the question here — a pass that surrendered because the app went dark has
	// a hole in it exactly where the app stopped answering, which is precisely the region the
	// next run needs mapped.
	const demoted = salvaged || stopped === "frontier-conceded" || (!modelFinished && !beatsBaseline);
	// The run's own copy is written ALWAYS, and first: whatever this pass produced belongs with
	// the pass, at a path nothing later can overwrite. Publishing to docs/appmaps is the separate,
	// conditional step below — that path is keyed by app, so the next pass on the same variant
	// replaces it, and before this every successful pass's map existed in exactly one overwritable
	// place.
	// The write site owns the directory. newPass deliberately does not create it — constructing a
	// Pass is a description, not a run — so anything that writes into the run folder has to be
	// able to stand alone, including the salvage path reached from a catch.
	fs.mkdirSync(path.dirname(p.appmapProsePath), { recursive: true });
	fs.writeFileSync(p.appmapProsePath, prose);
	if (!demoted) fs.writeFileSync(p.outPath, prose);
	// What to TELL the operator: the published path when it was published, the run's copy when
	// the pass was held back.
	const prosePath = demoted ? p.appmapProsePath : p.outPath;
	const jsonPath = demoted ? p.appmapGraphPath : p.graphPath;
	console.log(`\n=== exploration ${salvaged ? "SALVAGED" : "finished"} after ${p.actions} actions, ${elapsed}, ${p.findings.length} findings ===`);
	console.log(`stopped: ${stopped} | controls${p.visionOnly ? " (declared)" : ""}: ${cov.actuated} actuated / ${cov.dismissed} dismissed / ${cov.seen} seen across ${cov.surfaces} surfaces | chapters: ${p.chapters}`);
	if (p.refusals > 0) console.log(`safety guard refused ${p.refusals} action(s) on destructive-looking labels`);
	console.log(`grounding notes: ${prosePath}`);

	const graph: AppMap = {
		app: p.app,
		capturedAt: new Date().toISOString(),
		provenance: p.visionOnly ? "explore-vision" : "explore",
		proseSha256: createHash("sha256").update(prose).digest("hex").slice(0, 12),
		elapsed,
		coverage: cov,
		...(home ? { home } : {}),
		nodes: [...p.graphNodes.values()],
		edges: [...p.graphEdges.values()],
		...(p.gated.length ? { gated: p.gated } : {}),
	};
	const graphJson = JSON.stringify(graph, null, 2);
	fs.writeFileSync(p.appmapGraphPath, graphJson);
	if (!demoted) fs.writeFileSync(p.graphPath, graphJson);
	if (p.gated.length) console.log(`gated boundaries: ${cov.gatedRead} read / ${cov.gatedRefused} refused`);
	const ambiguities = findScopeAmbiguities(graph);
	console.log(`structured graph: ${jsonPath} (${graph.nodes.length} nodes, ${graph.edges.length} edges)`);
	if (demoted) {
		console.log(`kept OUT of docs/appmaps/ (${salvaged ? "pass did not finish on its own" : `${p.graphNodes.size} nodes vs ${committedNodes} committed`}); promote by hand if it is the better map:`);
		console.log(`  cp ${prosePath} ${p.outPath}`);
		console.log(`  cp ${jsonPath} ${p.graphPath}`);
	}
	if (ambiguities.length > 0) {
		console.log(`scope ambiguities found (${ambiguities.length}) — the task agent will be warned about these:`);
		for (const a of ambiguities)
			console.log(`  · ${a.settingKey}: ${a.nodes.map((n) => `${n.id} [${n.scope}]`).join(" vs ")}`);
	}
	// A 40-minute grounding pass is the most expensive artifact this system produces and the
	// least reproducible. Back its directory up here, at the one point that runs on every
	// finish — including the salvage path, where the map was too small to commit and the
	// checkpoint is the only surviving record of the work.
	try {
		archiveRun(p.stamp);
	} catch (err) {
		console.log(`backup: could not copy ${p.stamp} to out/bench/archive — ${err instanceof Error ? err.message : String(err)}`);
	}
};
