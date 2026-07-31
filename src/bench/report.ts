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
	/** `unready 2, crashed 1` — why the arm's failures failed. Empty string when none did. */
	failureBreakdown: string;
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
		failureBreakdown: (() => {
			const kinds = new Map<string, number>();
			for (const e of collected) {
				const k = e.metrics?.failureKind;
				if (k) kinds.set(k, (kinds.get(k) ?? 0) + 1);
			}

			return [...kinds].map(([k, n]) => `${k} ${n}`).join(", ");
		})(),
	};
}

const taskTableHeader = "| arm | model | flags | done | success | failures | steps x̄ | s x̄ | calls x̄ | out-tok x̄ | rejections | doc-scope muts | obs-nodes x̄ | shown x̄ | unnormalised |";
const taskTableRule = "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";

const taskRow = (r: ArmRollup, model: string): string =>
	`| ${r.arm.id} | ${model} | ${flagsLine(r.arm)} | ${r.collected.length}/${r.arm.n} | ${pct(r.successes, r.collected.length)} | ${r.failureBreakdown || "—"} | ${fmt(r.meanSteps)} | ${fmt(r.meanElapsedSec)} | ${fmt(r.meanModelCalls)} | ${fmt(r.meanOutputTokens)} | ${r.rejections} | ${r.documentScopeMutations} | ${fmt(r.meanObsNodes)} | ${fmt(r.meanShownLines)} | ${r.unnormalisedRuns ? `⚠ ${r.unnormalisedRuns}` : "0"} |`;

/** The model passes present for an arm, in first-seen order; [undefined] when none ran yet. */
const modelPasses = (m: Manifest, armId: string): Array<string | undefined> => {
	const seen: Array<string | undefined> = [];
	for (const e of m.entries) if (e.armId === armId && !seen.includes(e.model)) seen.push(e.model);

	return seen.length ? seen : [undefined];
};

const passLabel = (model: string | undefined): string => model ?? "(default)";

function taskTable(arms: Arm[], m: Manifest): string[] {
	// One row per (arm, model pass): the two passes are separate self-grounded pipelines,
	// and averaging across them would blend exactly the comparison the dimension exists for.
	const rows = arms.flatMap((a) =>
		modelPasses(m, a.id).map((model) =>
			taskRow(rollup(a, m.entries.filter((e) => e.armId === a.id && e.model === model)), passLabel(model)),
		),
	);

	return [taskTableHeader, taskTableRule, ...rows];
}

function exploreTable(arms: Arm[], m: Manifest): string[] {
	const header = "| arm | model | flags | actions | elapsed | actuated/dismissed/seen | surfaces | nodes | edges | ambiguities |";
	const rows = arms.flatMap((a) =>
		modelPasses(m, a.id).map((model) => {
			const e = m.entries.filter((x) => x.armId === a.id && x.model === model).find((x) => x.collected);
			const mm = e?.metrics ?? {};
			const controls = mm.controlsSeen !== undefined ? `${fmt(mm.controlsActuated)}/${fmt(mm.controlsDismissed)}/${fmt(mm.controlsSeen)}` : "—";

			return `| ${a.id} | ${passLabel(model)} | ${flagsLine(a)} | ${fmt(mm.exploreActions)} | ${fmt(mm.exploreElapsed)} | ${controls} | ${fmt(mm.surfaces)} | ${fmt(mm.graphNodes)} | ${fmt(mm.graphEdges)} | ${fmt(mm.scopeAmbiguities)} |`;
		}),
	);

	return [header, "|---|---|---|---|---|---|---|---|---|---|", ...rows];
}

function replayTable(arms: Arm[], m: Manifest): string[] {
	const header = "| arm | model | flags | done | success | recipe steps | rescued x̄ | calls x̄ | s x̄ |";
	const rows = arms.flatMap((a) =>
		modelPasses(m, a.id).map((model) => {
			const r = rollup(a, m.entries.filter((e) => e.armId === a.id && e.model === model));

			return `| ${a.id} | ${passLabel(model)} | ${flagsLine(a)} | ${r.collected.length}/${a.n} | ${pct(r.successes, r.collected.length)} | ${fmt(mean(nums(r.collected, (mm) => mm.recipeSteps)))} | ${fmt(mean(nums(r.collected, (mm) => mm.rescuedSteps)))} | ${fmt(r.meanModelCalls)} | ${fmt(r.meanElapsedSec)} |`;
		}),
	);

	return [header, "|---|---|---|---|---|---|---|---|---|", ...rows];
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
		lines.push(`- **${arm.id}**: ${entries.map((e) => `\`${e.jobId}\` (${e.host}${e.model ? `, ${e.model}` : ""}${e.collected ? "" : ", uncollected"})`).join(", ")}`);
	}

	return lines.length ? lines : ["_Nothing submitted yet._"];
}

const isTask = (a: Arm): boolean => a.kind === "task";

/**
 * Runs where the self-grade and the judge contradict each other — the finding this whole
 * feature exists for. `success` is the run grading itself; the judge is a separate model
 * refuting it against the scope rubric. Only a hard verdict disagrees: UNPROVEN is the
 * judge declining to rule, and "the judge couldn't tell" is not evidence against either side.
 */
export function judgeDisagreements(entries: ManifestEntry[]): ManifestEntry[] {
	return entries.filter((e) => {
		const m = e.metrics;
		if (!m) return false;

		return (m.success === true && m.judgeTrajectory === "FAIL") || (m.success === false && m.judgeTrajectory === "PASS");
	});
}

/** P/F/U tallies over one verdict field, rendered as `2/0/1`. */
const verdictCounts = (entries: ManifestEntry[], pick: (m: RunMetrics) => string | undefined): string => {
	const count = (v: string): number => entries.filter((e) => e.metrics && pick(e.metrics) === v).length;

	return `${count("PASS")}/${count("FAIL")}/${count("UNPROVEN")}`;
};

function judgeSection(m: Manifest): string[] {
	const judged = m.entries.filter((e) => e.metrics?.judgeTrajectory !== undefined);
	// An ABSENT section reads as "nothing to disagree with", which is exactly the lie the
	// judge exists to kill — so the section always renders, and an unjudged manifest says so.
	if (judged.length === 0) return ["_No run has judge metrics yet — run \`./run bench judge\` after runs land, then re-collect._"];

	const lines = [
		"| arm | model | judged | trajectory P/F/U | visual P/F/U |",
		"|---|---|---|---|---|",
	];
	const arms = MATRIX.filter((a) => judged.some((e) => e.armId === a.id));
	for (const arm of arms)
		for (const model of modelPasses(m, arm.id)) {
			const entries = judged.filter((e) => e.armId === arm.id && e.model === model);
			if (!entries.length) continue;
			lines.push(
				`| ${arm.id} | ${passLabel(model)} | ${entries.length} | ${verdictCounts(entries, (mm) => mm.judgeTrajectory)} | ${verdictCounts(entries, (mm) => mm.judgeVisual)} |`,
			);
		}

	lines.push("", "### Disagreements", "");
	const disagreements = judgeDisagreements(m.entries);
	if (!disagreements.length) lines.push("_None — every judged run's verdict matches its self-report._");
	else
		for (const e of disagreements)
			lines.push(
				`- **${e.armId}** \`${e.jobId}\`: self-reported success=${e.metrics?.success}, judge trajectory=${e.metrics?.judgeTrajectory}, scope: ${e.metrics?.judgeScope || "—"}`,
			);

	return lines;
}

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
		`> Plan: docs/plans/2026-07-31-benchmark-matrix.md (as amended: dom cut; Notion Calendar slice and vision-only-grounded cut 2026-07-31).`,
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
		"## Judge",
		"",
		...judgeSection(m),
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
		"- TODO: which MODEL pipeline to ship — self-grounded end to end (its own explores, its own maps, its own task runs). Note: each model ran at its own max effort; that asymmetry is the deployment-honest comparison. If the winner's edge needs factoring (explored better vs executed better), one cross-cell (loser's tasks on winner's maps, n=3) resolves it.",
		"- TODO: which backend to build on (phase 1 discovery + phase 2 outcomes).",
		"- TODO: leaner vs blinder — cdp's smaller per-screen observation (obs-nodes/shown columns) is a token win ONLY if phase 1 shows it DISCOVERED comparable functionality (controls actuated/seen + graph nodes vs ax). If cdp's frontier is materially smaller, the lean snapshot missed real controls.",
		"- TODO: what grounding buys — actions, tokens, wrong-scope rate (doc-scope mutation counts above are raw; the cursor task implies the brand default).",
		"- TODO: is the axdom sidecar worth shipping.",
		"- TODO: what vision costs/buys per backend; the vision-only deploy story.",
		"- TODO: whether replay is fleet-ready (rescue rate, no-rescue happy path).",
		"- TODO: does any of this generalize — phase 4 only. The Notion Calendar slice was cut (app absent from the fleet), so nothing here speaks to a SECOND APP, only a second task.",
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
