import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "../paths.js";
import { type Arm, flagsLine, MATRIX, phaseArms } from "./matrix.js";
import type { Manifest, ManifestEntry, RunMetrics } from "./manifest.js";

/**
 * The report skeleton: tables per axis over whatever the manifest holds so far, a timing
 * section, the raw stamp list per arm, and an empty "For Aman" section for the human-written
 * conclusions. Regenerable by construction — collect rewrites it as runs land, so nothing
 * hand-written may live in the generated region. The For Aman TODOs are the one deliberate
 * exception: they are re-emitted empty every time, and the human conclusions belong in the
 * final edit AFTER the last collect, not interleaved with reruns.
 */

export const reportFileName = (date: string): string => `${date}-backend-grounding-recipe-benchmarks.md`;

const pct = (num: number, den: number): string => (den === 0 ? "—" : `${num}/${den}`);

const fmt = (v: number | string | boolean | undefined): string =>
	v === undefined ? "—" : typeof v === "number" && !Number.isInteger(v) ? v.toFixed(1) : String(v);

interface ArmRollup {
	arm: Arm;
	entries: ManifestEntry[];
	collected: ManifestEntry[];
	successes: number;
	meanSteps?: number;
	meanElapsedSec?: number;
	meanModelCalls?: number;
	meanOutputTokens?: number;
	rejections: number;
	documentScopeMutations: number;
	runsWithMutations: number;
	/** The attention pair, averaged across the arm's runs. */
	meanObsNodes?: number;
	meanShownLines?: number;
	/** Runs that did NOT start from the declared home state (homeReset none/failed/skipped). */
	unnormalisedRuns: number;
}

const mean = (xs: number[]): number | undefined => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);

const nums = (entries: ManifestEntry[], pick: (m: RunMetrics) => number | undefined): number[] =>
	entries.map((e) => (e.metrics ? pick(e.metrics) : undefined)).filter((n): n is number => typeof n === "number");

function rollup(arm: Arm, entries: ManifestEntry[]): ArmRollup {
	const collected = entries.filter((e) => e.collected);
	const withScopes = collected.filter((e) => (e.metrics?.mutationScopes?.length ?? 0) > 0);

	return {
		arm,
		entries,
		collected,
		successes: collected.filter((e) => e.metrics?.success === true).length,
		meanSteps: mean(nums(collected, (m) => m.steps)),
		meanElapsedSec: mean(nums(collected, (m) => m.elapsedSec ?? m.runSec)),
		meanModelCalls: mean(nums(collected, (m) => m.modelCalls)),
		meanOutputTokens: mean(nums(collected, (m) => m.outputTokens)),
		rejections: nums(collected, (m) => m.expectationRejections).reduce((a, b) => a + b, 0),
		// Raw count of document-scope mutations across the arm. The canonical cursor task
		// implies the brand default, so on THAT task these are the wrong-scope signal — but
		// the judgment line belongs to the For Aman section, not to this counter.
		documentScopeMutations: collected.flatMap((e) => e.metrics?.mutationScopes ?? []).filter((s) => s === "document").length,
		runsWithMutations: withScopes.length,
		meanObsNodes: mean(nums(collected, (m) => m.meanObservationNodes)),
		meanShownLines: mean(nums(collected, (m) => m.meanListShownToModel)),
		// A run that inherited the previous run's navigation is not comparable raw; the count
		// flags the arm rather than hiding the caveat in per-run fields nobody reads.
		unnormalisedRuns: collected.filter((e) => e.metrics?.homeReset && e.metrics.homeReset !== "reset").length,
	};
}

const taskTableHeader = "| arm | flags | done | success | steps x̄ | s x̄ | calls x̄ | out-tok x̄ | rejections | doc-scope muts | obs-nodes x̄ | shown x̄ | unnormalised |";
const taskTableRule = "|---|---|---|---|---|---|---|---|---|---|---|---|---|";

const taskRow = (r: ArmRollup): string =>
	`| ${r.arm.id} | ${flagsLine(r.arm)} | ${r.collected.length}/${r.arm.n} | ${pct(r.successes, r.collected.length)} | ${fmt(r.meanSteps)} | ${fmt(r.meanElapsedSec)} | ${fmt(r.meanModelCalls)} | ${fmt(r.meanOutputTokens)} | ${r.rejections} | ${r.documentScopeMutations} | ${fmt(r.meanObsNodes)} | ${fmt(r.meanShownLines)} | ${r.unnormalisedRuns ? `⚠ ${r.unnormalisedRuns}` : "0"} |`;

function taskTable(arms: Arm[], m: Manifest): string[] {
	const rows = arms.map((a) => taskRow(rollup(a, m.entries.filter((e) => e.armId === a.id))));

	return [taskTableHeader, taskTableRule, ...rows];
}

function exploreTable(arms: Arm[], m: Manifest): string[] {
	const header = "| arm | flags | actions | elapsed | actuated/dismissed/seen | surfaces | nodes | edges | ambiguities |";
	const rows = arms.map((a) => {
		const e = m.entries.filter((x) => x.armId === a.id).find((x) => x.collected);
		const mm = e?.metrics ?? {};
		const controls = mm.controlsSeen !== undefined ? `${fmt(mm.controlsActuated)}/${fmt(mm.controlsDismissed)}/${fmt(mm.controlsSeen)}` : "—";

		return `| ${a.id} | ${flagsLine(a)} | ${fmt(mm.exploreActions)} | ${fmt(mm.exploreElapsed)} | ${controls} | ${fmt(mm.surfaces)} | ${fmt(mm.graphNodes)} | ${fmt(mm.graphEdges)} | ${fmt(mm.scopeAmbiguities)} |`;
	});

	return [header, "|---|---|---|---|---|---|---|---|---|", ...rows];
}

function replayTable(arms: Arm[], m: Manifest): string[] {
	const header = "| arm | flags | done | success | recipe steps | rescued x̄ | calls x̄ | s x̄ |";
	const rows = arms.map((a) => {
		const r = rollup(a, m.entries.filter((e) => e.armId === a.id));

		return `| ${a.id} | ${flagsLine(a)} | ${r.collected.length}/${a.n} | ${pct(r.successes, r.collected.length)} | ${fmt(mean(nums(r.collected, (mm) => mm.recipeSteps)))} | ${fmt(mean(nums(r.collected, (mm) => mm.rescuedSteps)))} | ${fmt(r.meanModelCalls)} | ${fmt(r.meanElapsedSec)} |`;
	});

	return [header, "|---|---|---|---|---|---|---|---|", ...rows];
}

function timingSection(m: Manifest): string[] {
	const lines = ["| arm | job | host | queue wait s | run s |", "|---|---|---|---|---|"];
	for (const e of m.entries) {
		if (!e.collected || !e.metrics) continue;
		lines.push(`| ${e.armId} | ${e.jobId} | ${e.host} | ${fmt(e.metrics.queueWaitSec)} | ${fmt(e.metrics.runSec ?? e.metrics.elapsedSec)} |`);
	}

	return lines.length > 2 ? lines : ["_No collected runs yet._"];
}

function stampList(m: Manifest): string[] {
	const byArm = new Map<string, ManifestEntry[]>();
	for (const e of m.entries) byArm.set(e.armId, [...(byArm.get(e.armId) ?? []), e]);
	const lines: string[] = [];
	for (const arm of MATRIX) {
		const entries = byArm.get(arm.id);
		if (!entries) continue;
		lines.push(`- **${arm.id}**: ${entries.map((e) => `\`${e.jobId}\` (${e.host}${e.collected ? "" : ", uncollected"})`).join(", ")}`);
	}

	return lines.length ? lines : ["_Nothing submitted yet._"];
}

const isTask = (a: Arm): boolean => a.kind === "task";

export function renderReport(m: Manifest): string {
	const p2 = phaseArms(2);
	const core = p2.filter((a) => isTask(a) && /^p2-(ax|cdp)-(un)?grounded$/.test(a.id));
	const slices = p2.filter((a) => isTask(a) && !core.includes(a) && !a.id.startsWith("p2-nc-"));
	const nc = p2.filter((a) => a.id.startsWith("p2-nc-"));
	const p3Replays = phaseArms(3).filter((a) => a.kind === "replay");
	const p4 = phaseArms(4);

	const submitted = m.entries.length;
	const collected = m.entries.filter((e) => e.collected).length;

	return [
		`# Backend × grounding × recipe benchmarks — ${m.date}`,
		"",
		`> Generated by \`./run bench collect\` — hand-edits outside the "For Aman" section are overwritten on the next collect.`,
		`> Plan: docs/plans/2026-07-31-benchmark-matrix.md (as amended: dom cut, Notion Calendar slice added).`,
		`> Progress: ${collected}/${submitted} submitted runs collected.`,
		"",
		"## Phase 1 — node discovery per backend",
		"",
		...exploreTable(phaseArms(1), m),
		"",
		"## Phase 2 — backend × grounding (core)",
		"",
		...taskTable(core, m),
		"",
		"## Phase 2 — permutation slices",
		"",
		...taskTable(slices, m),
		"",
		"## Phase 2 — generalization (Notion Calendar)",
		"",
		...taskTable(nc, m),
		"",
		"## Phase 3 — recipes",
		"",
		...replayTable(p3Replays, m),
		"",
		"Compiles: " +
			(phaseArms(3)
				.filter((a) => a.kind === "compile")
				.map((a) => {
					const e = m.entries.find((x) => x.armId === a.id);

					return `${a.id}: ${e ? (e.recipe ?? e.jobId) : "not run"}`;
				})
				.join("; ") || "none"),
		"",
		"## Phase 4 — second-task spot check (optional)",
		"",
		...taskTable(p4.filter(isTask), m),
		"",
		...replayTable(p4.filter((a) => a.kind === "replay"), m),
		"",
		"## Timing (queue wait vs run, from job records)",
		"",
		...timingSection(m),
		"",
		"## Raw stamps per arm",
		"",
		...stampList(m),
		"",
		"## For Aman",
		"",
		"<!-- Human-written conclusions. Everything above regenerates; this section is re-emitted",
		"     as TODOs until the final edit, made after the last collect. -->",
		"",
		"- TODO: which backend to build on (phase 1 discovery + phase 2 outcomes).",
		"- TODO: leaner vs blinder — cdp's smaller per-screen observation (obs-nodes/shown columns) is a token win ONLY if phase 1 shows it DISCOVERED comparable functionality (controls actuated/seen + graph nodes vs ax). If cdp's frontier is materially smaller, the lean snapshot missed real controls.",
		"- TODO: what grounding buys — actions, tokens, wrong-scope rate (doc-scope mutation counts above are raw; the cursor task implies the brand default).",
		"- TODO: is the axdom sidecar worth shipping.",
		"- TODO: what vision costs/buys per backend; the vision-only deploy story.",
		"- TODO: whether replay is fleet-ready (rescue rate, no-rescue happy path).",
		"- TODO: does any of this generalize (Notion Calendar slice, phase 4).",
		"",
	].join("\n");
}

export interface ReportOptions {
	/** Defaults to docs/research under the data root. Tests point it at a temp dir. */
	dir?: string;
}

export function writeReport(m: Manifest, opts: ReportOptions = {}): string {
	const dir = opts.dir ?? path.join(dataRoot(), "docs", "research");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, reportFileName(m.date));
	fs.writeFileSync(file, renderReport(m));

	return file;
}
