import { createHash } from "node:crypto";
import fs from "node:fs";
import { checkHome, findScopeAmbiguities, gatedSection, recoverLeakedGraph } from "../harness.js";
import type { AppMap } from "../../types.js";
import { DESCENT_ON } from "./config.js";
import { type FinishInput, merge, type Pass, type StopReason } from "./state.js";

/**
 * Machine-readable stamp distinguishing autonomous exploration output from
 * hand-curated notes. loadGrounding() in agent.ts treats unstamped appmaps as
 * "curated" and the run log records the difference — hand edits to a stamped
 * file MUST remove the stamp (or move the file to docs/recipes/).
 */
export const provenanceHeader = (p: {
	app: string;
	actions: number;
	elapsed: string;
	findings: number;
	backend: string;
	findCalls: number;
	vision: boolean;
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
}): string =>
	`<!-- provenance: explore | app: ${p.app} | date: ${new Date().toISOString().slice(0, 10)} | backend: ${p.backend}${p.vision ? "" : " | vision: off"} | actions: ${p.actions} | elapsed: ${p.elapsed} | findings: ${p.findings} | finds: ${p.findCalls}` +
	` | controls: ${p.actuated} actuated / ${p.dismissed} dismissed / ${p.seen} seen | surfaces: ${p.surfaces} | chapters: ${p.chapters} | stopped: ${p.stopped}` +
	` | descent: ${DESCENT_ON ? "on" : "off"} | gated: ${p.gatedRead ?? 0} read / ${p.gatedRefused ?? 0} refused` +
	`${p.guidance ? " | operator-guidance: yes" : ""}${p.salvaged ? " | salvaged: session died before finish" : ""} -->\n` +
	"<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->\n" +
	"<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->\n\n";

export const hm = (ms: number): string => {
	const m = Math.max(0, Math.round(ms / 60000));

	return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};

export const coverageNow = (p: Pass, stopped: string) => ({
	seen: p.ledger.seen.size,
	actuated: [...p.ledger.actuated].filter((k) => p.ledger.seen.has(k)).length,
	dismissed: p.ledger.dismissed.size,
	surfaces: new Set([...p.ledger.seen.values()].map((e) => e.surface)).size,
	chapters: p.chapters,
	stopped,
	dismissals: [...new Set(p.ledger.dismissed.values())],
	gatedRead: p.gated.filter((g) => g.tierReached === 1).length,
	gatedRefused: p.gated.filter((g) => g.tierReached === 0).length,
});

export const checkpoint = (p: Pass): void => {
	fs.writeFileSync(
		p.checkpointPath,
		JSON.stringify(
			{
				// Shaped as a valid AppMap so a killed run's checkpoint can be promoted to
				// docs/appmaps/<slug>.json as-is, without hand-adding fields.
				app: p.app,
				capturedAt: new Date().toISOString(),
				provenance: "explore",
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
			guidance: p.guidance,
			salvaged,
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
	const modelFinished = stopped === "frontier-empty" || stopped === "frontier-conceded";
	const demoted = salvaged || (!modelFinished && p.graphNodes.size * 2 < committedNodes);
	const prosePath = demoted ? p.salvageProsePath : p.outPath;
	const jsonPath = demoted ? p.salvageGraphPath : p.graphPath;
	fs.writeFileSync(prosePath, prose);
	console.log(`\n=== exploration ${salvaged ? "SALVAGED" : "finished"} after ${p.actions} actions, ${elapsed}, ${p.findings.length} findings ===`);
	console.log(`stopped: ${stopped} | controls: ${cov.actuated} actuated / ${cov.dismissed} dismissed / ${cov.seen} seen across ${cov.surfaces} surfaces | chapters: ${p.chapters}`);
	if (p.refusals > 0) console.log(`safety guard refused ${p.refusals} action(s) on destructive-looking labels`);
	console.log(`grounding notes: ${prosePath}`);

	const graph: AppMap = {
		app: p.app,
		capturedAt: new Date().toISOString(),
		provenance: "explore",
		proseSha256: createHash("sha256").update(prose).digest("hex").slice(0, 12),
		elapsed,
		coverage: cov,
		...(home ? { home } : {}),
		nodes: [...p.graphNodes.values()],
		edges: [...p.graphEdges.values()],
		...(p.gated.length ? { gated: p.gated } : {}),
	};
	fs.writeFileSync(jsonPath, JSON.stringify(graph, null, 2));
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
};
