import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJournal } from "../core/journal.js";
import type { FleetRow } from "../remote/control/fleet.js";
import type { EngineHandle } from "../remote/liveview.js";
import { logPath as jobLogPath, readJob as readLocalJob, readLog } from "../remote/runner/jobs.js";
import { appSlug, dataRoot } from "../paths.js";
import { appmapSlug } from "../core/target.js";
import { archiveDirFor } from "./collect.js";
import { estimateCost } from "./cost.js";
import { type Arm, armAppmapSlug, armById, armTitle, flagsLine, MATRIX, perceptionLine, type Phase } from "./matrix.js";
import { benchDir, type Manifest, type ManifestEntry, readManifest, utcDate } from "./manifest.js";
import { judgeDisagreements, modelPasses, passLabel, rollup } from "./report.js";

/**
 * `./run dash` — a live web dashboard over the benchmark matrix.
 *
 * The report (docs/research/…-benchmarks.md) is the durable artifact; this is the glanceable
 * one: which Mac is doing what right now, how far the matrix has drained, and the arm
 * comparisons charted as they land. It exists because the orchestrator submits and EXITS —
 * the fleet drains for hours with nothing watching, and `bench collect` is a manual step.
 *
 * Three inputs, three cadences:
 *  - the manifest (fs-watched — an external `bench collect` shows up instantly),
 *  - the fleet (the same `fleetStatus()` ssh fan-out the fleet panel uses, polled),
 *  - `collect()` itself, run on a loop so results land without a human typing collect.
 *    Collect is idempotent and its writes are atomic BY DESIGN (see collect.ts) — a manual
 *    collect racing this loop converges on the same bytes. `--no-collect` makes the
 *    dashboard a pure reader.
 *
 * Everything derived (rollups, cost, judge tallies) reuses the report's own exported math —
 * the dashboard must never disagree with the report over the same manifest.
 */

export interface DashEvent {
	t: string;
	line: string;
}

export interface FleetView {
	rows: FleetRow[];
	polledAt?: string;
	error?: string;
}

/** One manifest entry, enriched with what the fleet says is happening to it RIGHT NOW. */
export interface EntryView {
	jobId: string;
	host: string;
	/** When the manifest accepted the submission — the timeline fallback for jobs not yet started. */
	submittedAt: string;
	collected: boolean;
	/**
	 * running/queued come from the live fleet (authoritative while the poll is fresh);
	 * succeeded/failed kinds from collected metrics; "awaiting-collect" when the job's host
	 * answered and no longer holds it; the manifest's stale state string otherwise.
	 */
	status: string;
	/** Seconds the run has been going (running) or took per its own log (collected). */
	elapsedSec?: number;
	queuePosition?: number;
	stalled?: boolean;
	success?: boolean;
	failureKind?: string;
	steps?: number;
	verifiedSteps?: number;
	modelCalls?: number;
	/**
	 * Raw token classes for the per-run economics readout. Provider caveat (cost.ts header):
	 * Anthropic's inputTokens EXCLUDES cache reads while Azure's INCLUDES them, so these are
	 * per-run display numbers only — never sum or compare them across providers. outputTokens
	 * stays the headline number (the report's own convention).
	 */
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	usd?: number;
	docScopeMutations?: number;
	judgeTrajectory?: string;
	judgeVisual?: string;
	queueWaitSec?: number;
	runSec?: number;
	endedAt?: string;
	note?: string;
}

export interface PassView {
	model: string;
	/** Distinct model ids the collected runs actually recorded — divergence from `model` is a finding. */
	ranModels?: string[];
	submitted: number;
	collected: number;
	successes: number;
	usd: number;
	unpriced: number;
	/** Of the priced runs, how many were priced by ASSUMING the pass's default-model rates. */
	assumed: number;
	meanSteps?: number;
	meanElapsedSec?: number;
	meanModelCalls?: number;
	meanOutputTokens?: number;
	meanObsNodes?: number;
	meanShownLines?: number;
	rejections: number;
	documentScopeMutations: number;
	failureBreakdown: string;
	/** Explore arms: the stamp + graph numbers, off the one collected entry. */
	explore?: {
		actions?: number;
		elapsed?: string;
		controlsActuated?: number;
		controlsDismissed?: number;
		controlsSeen?: number;
		surfaces?: number;
		graphNodes?: number;
		graphEdges?: number;
		scopeAmbiguities?: number;
	};
	/** Replay arms. */
	replay?: { meanRecipeSteps?: number; meanRescuedSteps?: number };
	entries: EntryView[];
}

export interface ArmView {
	id: string;
	/**
	 * Plain English, derived — "Explored Task" rather than `p2-ax-grounded`. The ids say
	 * nothing about DOM attrs or vision, and `p2-vision-only-grounded-visionmap` is
	 * unreadable at a glance. armTitle's wording mapped through the dash's Explore-family
	 * copy (displayTitle below) — labels only, ids and flags keep the wire words.
	 */
	title: string;
	phase: Phase;
	kind: string;
	n: number;
	flags: string;
	app: string;
	/**
	 * The two axes an arm's cryptic name used to fold together ("vision-only explore (AX)"
	 * = sees pixels only, acts via AX). Same semantics as matrix.ts's perceptionLine, with
	 * the element channel named per backend (AX tree vs DOM).
	 */
	perception: string;
	actuation: string;
	/** Task arms: the goal-only prompt the run was given. */
	task?: string;
	/** Web arms: the URL the run pointed at (off the dispatch flags). */
	url?: string;
	/**
	 * The phase-1 explore arm whose map this task/replay arm consumed (groundingArmId — the
	 * same resolution orchestrate applies), so the board can nest arms under their lineage.
	 * Absent on ungrounded (NO_GROUNDING) arms and on explore/compile arms. Curated
	 * (USE_RECIPE) arms are still grounded — they carry it and nest.
	 */
	groundedBy?: string;
	/** What the arm points at — the dispatch URL for web arms, else the app. The picker's key. */
	targetKey: string;
	informs?: string;
	passes: PassView[];
}

export interface DashState {
	date: string;
	generatedAt: string;
	autoCollect: boolean;
	/**
	 * What "(default)" resolves to in THIS environment (makeClient's key precedence) — a
	 * hint for uncollected passes. The fleet Macs resolve their own env, so collected runs'
	 * ranModels is the truth and always wins in the UI.
	 */
	defaultModel?: string;
	progress: { planned: number; submitted: number; collected: number; running: number; queued: number; successes: number };
	fleet: FleetView;
	arms: ArmView[];
	cost: {
		totalUsd: number;
		unpriced: number;
		/** Runs priced by falling back to default-model rates (tokens recorded, no model id). */
		assumedRuns: number;
		passes: Array<{ pass: string; usd: number; priced: number; unpriced: number; assumed: number }>;
	};
	/** Cumulative dollars in collection-time order — the "what has this cost so far" line. */
	costSeries: Array<{ t: string; jobId: string; cumulativeUsd: number }>;
	judge: {
		judged: number;
		trajectory: { pass: number; fail: number; unproven: number };
		visual: { pass: number; fail: number; unproven: number };
		disagreements: Array<{ armId: string; jobId: string; success?: boolean; judgeTrajectory?: string; judgeScope?: string }>;
	};
	/** The narrator's latest plain-English read of the data. Model-written; verify before quoting. */
	narrative?: { updatedAt: string; text: string; model: string };
	events: DashEvent[];
}

const mean = (xs: number[]): number | undefined => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);

function liveFor(e: ManifestEntry, fleet: FleetView): Pick<EntryView, "status" | "elapsedSec" | "queuePosition" | "stalled"> {
	const host = fleet.rows.find((r) => r.name === e.host);
	if (host?.jobId === e.jobId)
		return { status: "running", ...(host.elapsedSec !== undefined ? { elapsedSec: host.elapsedSec } : {}), ...(host.stalled ? { stalled: true } : {}) };
	const pos = host?.queue?.findIndex((q) => q.jobId === e.jobId) ?? -1;
	if (pos >= 0) return { status: "queued", queuePosition: pos + 1 };
	// The host answered and doesn't hold the job: it finished and is waiting for a collect
	// pass. An unreachable host proves nothing, so the manifest's last-known state stands.
	if (host?.reachable && host.state !== "unknown") return { status: "awaiting-collect" };

	return { status: e.state };
}

function entryView(e: ManifestEntry, fleet: FleetView): EntryView {
	const m = e.metrics;
	if (e.collected) {
		const cost = m ? estimateCost(m, m.model ?? e.model) : undefined;

		return {
			jobId: e.jobId,
			host: e.host,
			submittedAt: e.submittedAt,
			collected: true,
			status: m?.success === true ? "succeeded" : (m?.failureKind ?? (m?.success === false ? "failed" : "collected")),
			...(m?.success !== undefined ? { success: m.success } : {}),
			...(m?.failureKind ? { failureKind: m.failureKind } : {}),
			...(m?.steps !== undefined ? { steps: m.steps } : {}),
			...(m?.elapsedSec !== undefined ? { elapsedSec: m.elapsedSec } : {}),
			...(m?.verifiedSteps !== undefined ? { verifiedSteps: m.verifiedSteps } : {}),
			...(m?.modelCalls !== undefined ? { modelCalls: m.modelCalls } : {}),
			...(m?.inputTokens !== undefined ? { inputTokens: m.inputTokens } : {}),
			...(m?.outputTokens !== undefined ? { outputTokens: m.outputTokens } : {}),
			...(m?.cacheReadTokens !== undefined ? { cacheReadTokens: m.cacheReadTokens } : {}),
			...(m?.cacheCreationTokens !== undefined ? { cacheCreationTokens: m.cacheCreationTokens } : {}),
			...(cost !== undefined ? { usd: cost } : {}),
			...(m?.mutationScopes ? { docScopeMutations: m.mutationScopes.filter((s) => s === "document").length } : {}),
			...(m?.judgeTrajectory ? { judgeTrajectory: m.judgeTrajectory } : {}),
			...(m?.judgeVisual ? { judgeVisual: m.judgeVisual } : {}),
			...(m?.queueWaitSec !== undefined ? { queueWaitSec: m.queueWaitSec } : {}),
			...(m?.runSec !== undefined ? { runSec: m.runSec } : {}),
			...(m?.endedAt ? { endedAt: m.endedAt } : {}),
			...(e.note ? { note: e.note } : {}),
		};
	}

	return { jobId: e.jobId, host: e.host, submittedAt: e.submittedAt, collected: false, ...liveFor(e, fleet) };
}

/**
 * Price one collected entry the way the report does (the run log's model first, the
 * manifest's dispatch model second), then RETRY at `entry.model ?? defaultModel` rates when
 * the run recorded tokens but no rate card matched. Explore stamps record tokens with no
 * model id, so before this every explore pass read as "unpriced" and the hero showed
 * "$0.00 +5?" — noise, per David; price them at the published default rates instead.
 * `assumed: true` marks the retry so totals can say "priced at default-model rates" rather
 * than pretend the card was known. A tokenless artifact never retries: it would "price" to
 * $0.00 and pad the assumed count without informing anyone.
 */
export function priceWithFallback(e: ManifestEntry, defaultModel?: string): { usd?: number; assumed: boolean } {
	const m = e.metrics;
	if (!m) return { assumed: false };
	const direct = estimateCost(m, m.model ?? e.model);
	if (direct !== undefined) return { usd: direct, assumed: false };
	if (m.inputTokens === undefined && m.outputTokens === undefined && m.cacheReadTokens === undefined && m.cacheCreationTokens === undefined)
		return { assumed: false };
	const assumed = estimateCost(m, e.model ?? defaultModel);

	return assumed !== undefined ? { usd: assumed, assumed: true } : { assumed: false };
}

function passView(arm: Arm, model: string | undefined, entries: ManifestEntry[], fleet: FleetView, defaultModel?: string): PassView {
	const r = rollup(arm, entries);
	const first = r.collected[0]?.metrics;

	const ranModels = [...new Set(r.collected.map((e) => e.metrics?.model).filter((m): m is string => typeof m === "string"))];

	// Post-adjust the report's cost rollup rather than editing report.ts: rollup() prices
	// per-entry metrics.model only, so it cannot see the manifest's dispatch model or the
	// default-model fallback. Recomputed here with the same estimateCost, superset semantics.
	const priced = r.collected.map((e) => priceWithFallback(e, defaultModel));

	return {
		model: passLabel(model),
		...(ranModels.length ? { ranModels } : {}),
		submitted: entries.length,
		collected: r.collected.length,
		successes: r.successes,
		usd: priced.reduce((s, p) => s + (p.usd ?? 0), 0),
		unpriced: priced.filter((p) => p.usd === undefined).length,
		assumed: priced.filter((p) => p.assumed).length,
		...(r.meanSteps !== undefined ? { meanSteps: r.meanSteps } : {}),
		...(r.meanElapsedSec !== undefined ? { meanElapsedSec: r.meanElapsedSec } : {}),
		...(r.meanModelCalls !== undefined ? { meanModelCalls: r.meanModelCalls } : {}),
		...(r.meanOutputTokens !== undefined ? { meanOutputTokens: r.meanOutputTokens } : {}),
		...(r.meanObsNodes !== undefined ? { meanObsNodes: r.meanObsNodes } : {}),
		...(r.meanShownLines !== undefined ? { meanShownLines: r.meanShownLines } : {}),
		rejections: r.rejections,
		documentScopeMutations: r.documentScopeMutations,
		failureBreakdown: r.failureBreakdown,
		...(arm.kind === "explore" && first
			? {
					explore: {
						...(first.exploreActions !== undefined ? { actions: first.exploreActions } : {}),
						...(first.exploreElapsed ? { elapsed: first.exploreElapsed } : {}),
						...(first.controlsActuated !== undefined ? { controlsActuated: first.controlsActuated } : {}),
						...(first.controlsDismissed !== undefined ? { controlsDismissed: first.controlsDismissed } : {}),
						...(first.controlsSeen !== undefined ? { controlsSeen: first.controlsSeen } : {}),
						...(first.surfaces !== undefined ? { surfaces: first.surfaces } : {}),
						...(first.graphNodes !== undefined ? { graphNodes: first.graphNodes } : {}),
						...(first.graphEdges !== undefined ? { graphEdges: first.graphEdges } : {}),
						...(first.scopeAmbiguities !== undefined ? { scopeAmbiguities: first.scopeAmbiguities } : {}),
					},
				}
			: {}),
		...(arm.kind === "replay"
			? {
					replay: {
						...(mean(r.collected.map((e) => e.metrics?.recipeSteps).filter((n): n is number => n !== undefined)) !== undefined
							? { meanRecipeSteps: mean(r.collected.map((e) => e.metrics?.recipeSteps).filter((n): n is number => n !== undefined)) }
							: {}),
						...(mean(r.collected.map((e) => e.metrics?.rescuedSteps).filter((n): n is number => n !== undefined)) !== undefined
							? { meanRescuedSteps: mean(r.collected.map((e) => e.metrics?.rescuedSteps).filter((n): n is number => n !== undefined)) }
							: {}),
					},
				}
			: {}),
		entries: entries.map((e) => entryView(e, fleet)),
	};
}

export interface Narrative {
	updatedAt: string;
	text: string;
	model: string;
}

/**
 * The digest the narrator model reads: the same per-arm rollups the report tabulates,
 * minus per-run noise. Small on purpose — the narrator runs on every landing batch.
 */
export function narratorDigest(state: DashState): Record<string, unknown> {
	return {
		progress: state.progress,
		estCostUsd: state.cost.totalUsd,
		judge: state.judge,
		arms: state.arms
			.filter((a) => a.passes.length)
			.map((a) => ({
				id: a.id,
				kind: a.kind,
				phase: a.phase,
				flags: a.flags,
				...(a.task ? { task: a.task } : {}),
				...(a.informs ? { informs: a.informs } : {}),
				passes: a.passes.map(({ entries, ...p }) => ({ ...p, statuses: entries.map((e) => e.status) })),
			})),
	};
}

/**
 * The newest note narrate() has persisted to narrative.md, if any. The live copy used to be
 * in-memory only, so a restarted dash served nothing while every note it had ever minted sat
 * on disk beside the manifest — and a restart into a keyless environment could never re-mint.
 * Headings are machine-written by narrate() (`## <ISO> — N collected (<model>)`), so parsing
 * the last one back is exact, not heuristic.
 */
function readPersistedNarrative(date: string): Narrative | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(benchDir(date), "narrative.md"), "utf8");
	} catch {
		return undefined; // No file — nothing narrated for this date yet.
	}
	const heads = [...raw.matchAll(/^## (\S+) — \d+ collected \(([^)\n]+)\)$/gm)];
	const last = heads.at(-1);
	if (!last) return undefined;
	const text = raw.slice((last.index ?? 0) + last[0].length).trim();
	if (!text) return undefined;

	return { updatedAt: last[1], text, model: last[2] };
}

export function narratorPrompt(digest: Record<string, unknown>, previous?: string): string {
	return [
		"You are the running commentator on a live benchmark matrix for a self-driving UI agent",
		"(backends: ax = macOS accessibility, cdp = Chrome DevTools Protocol; grounded = the agent",
		"gets an app map from a prior explore pass; explore passes measure discovery). The data",
		"below is per-arm rollups collected so far. Sample sizes are small — say so where it matters.",
		"",
		"Questions the matrix exists to answer (from the plan): which backend to build on;",
		"what grounding buys (actions, tokens, wrong-scope mutations); whether cdp's leaner",
		"observations are denser or blinder (compare explore discovery: controls seen/actuated,",
		"surfaces, graph nodes, scope ambiguities); what vision costs/buys; whether recipe replay",
		"is fleet-ready; judge disagreements with self-reports.",
		"",
		"Write AT MOST 5 sentences, 100 words total. Every sentence is one finding carried by its",
		"numbers (ratios beat raw counts). Newest or most decision-relevant first. No preamble, no",
		"inventory of what hasn't run, no hedging boilerplate — at most one short sample-size",
		"caveat, and only where it changes the conclusion. Never speculate past the data. Plain",
		"prose, no headers, no lists, no markdown.",
		...(previous ? ["", "Your previous note (already seen — write only what CHANGED or sharpened):", previous] : []),
		"",
		"Data:",
		JSON.stringify(digest, null, 1),
	].join("\n");
}

/**
 * armTitle speaks the report's vocabulary (grounded/grounding); the dash renders the
 * Explore family per David (2026-07-31) — copy only, applied at the view boundary. Arm ids,
 * flags (NO_GROUNDING), and every data-field comparison keep the wire words; bench.test.ts
 * pins armTitle's own output, which is why the rename lives here and not in matrix.ts.
 */
const ARM_TITLE_COPY: Record<string, string> = {
	"grounding pass": "Explore",
	"grounding pass (web)": "Web Explore",
	"grounded task": "Explored Task",
	"ungrounded task": "Unexplored Task",
	"human-notes task": "Curated-Recipe Task",
	"vision-map grounded task": "Vision-Map Explored Task",
	"recipe compile": "Recipe Compile",
	"recipe replay": "Recipe Replay",
	"recipe replay (no rescue)": "Recipe Replay (No Rescue)",
};

function displayTitle(arm: Arm): string {
	const t = armTitle(arm);
	const filmed = t.startsWith("filmed ");
	const base = filmed ? t.slice("filmed ".length) : t;

	return (filmed ? "Filmed " : "") + (ARM_TITLE_COPY[base] ?? base);
}

export function buildState(manifest: Manifest, fleet: FleetView, events: DashEvent[], autoCollect: boolean, defaultModel?: string): DashState {
	const arms: ArmView[] = MATRIX.map((arm) => ({
		id: arm.id,
		title: displayTitle(arm),
		phase: arm.phase,
		kind: arm.kind,
		n: arm.n,
		flags: flagsLine(arm),
		app: arm.app,
		// "vision", not perceptionLine's "screenshots" — the user-facing word (David,
		// 2026-07-31); the report keeps matrix.ts's own wording.
		perception: perceptionLine(arm).replace(/screenshots/g, "vision"),
		actuation: (arm.dispatch.backend ?? "ax").toUpperCase(),
		...(arm.task ? { task: arm.task } : {}),
		...(arm.dispatch.url ? { url: arm.dispatch.url } : {}),
		// Lineage off the dispatch object, never the rendered flags string (same rule as
		// armTitle): a task/replay arm without noGrounding consumed SOME explore map.
		...((arm.kind === "task" || arm.kind === "replay") && !arm.dispatch.noGrounding
			? { groundedBy: groundingArmId(arm) }
			: {}),
		targetKey: arm.dispatch.url ?? arm.app,
		...(arm.informs ? { informs: arm.informs } : {}),
		passes: modelPasses(manifest, arm.id)
			.map((model) => passView(arm, model, manifest.entries.filter((e) => e.armId === arm.id && e.model === model), fleet, defaultModel))
			.filter((p) => p.submitted > 0),
	}));

	const allEntries = arms.flatMap((a) => a.passes.flatMap((p) => p.entries));
	const collectedEntries = manifest.entries.filter((e) => e.collected);

	// Per model pass, same grouping as the report's cost section: only dollars are summed.
	// priceWithFallback, not bare rollupCost: runs with tokens but no model id (explore
	// stamps) price at default-model rates and are COUNTED as assumed, not unpriced.
	const byPass = new Map<string, ManifestEntry[]>();
	for (const e of collectedEntries) byPass.set(passLabel(e.model), [...(byPass.get(passLabel(e.model)) ?? []), e]);
	const passes = [...byPass].map(([pass, entries]) => {
		const priced = entries.map((e) => priceWithFallback(e, defaultModel));

		return {
			pass,
			usd: priced.reduce((s, p) => s + (p.usd ?? 0), 0),
			priced: priced.filter((p) => p.usd !== undefined).length,
			unpriced: priced.filter((p) => p.usd === undefined).length,
			assumed: priced.filter((p) => p.assumed).length,
		};
	});

	// Cumulative cost in the order runs ENDED (submit time as the fallback for artifacts
	// without job timing) — the line an operator reads as "spend so far". Same fallback
	// pricing as the totals, or the line and the hero would disagree over the same runs.
	let cumulative = 0;
	const costSeries = collectedEntries
		.map((e) => ({ e, t: e.metrics?.endedAt ?? e.metrics?.startedAt ?? e.submittedAt, cost: priceWithFallback(e, defaultModel).usd }))
		.filter((x) => x.cost !== undefined)
		.sort((a, b) => a.t.localeCompare(b.t))
		.map((x) => ({ t: x.t, jobId: x.e.jobId, cumulativeUsd: (cumulative += x.cost as number) }));

	const judged = collectedEntries.filter((e) => e.metrics?.judgeTrajectory !== undefined);
	const tally = (pick: (e: ManifestEntry) => string | undefined) => ({
		pass: judged.filter((e) => pick(e) === "PASS").length,
		fail: judged.filter((e) => pick(e) === "FAIL").length,
		unproven: judged.filter((e) => pick(e) === "UNPROVEN").length,
	});

	return {
		date: manifest.date,
		generatedAt: new Date().toISOString(),
		autoCollect,
		...(defaultModel ? { defaultModel } : {}),
		progress: {
			planned: MATRIX.reduce((sum, a) => sum + a.n, 0),
			submitted: manifest.entries.length,
			collected: collectedEntries.length,
			running: allEntries.filter((e) => e.status === "running").length,
			queued: allEntries.filter((e) => e.status === "queued").length,
			successes: collectedEntries.filter((e) => e.metrics?.success === true).length,
		},
		fleet,
		arms,
		cost: {
			totalUsd: passes.reduce((s, p) => s + p.usd, 0),
			unpriced: passes.reduce((s, p) => s + p.unpriced, 0),
			assumedRuns: passes.reduce((s, p) => s + p.assumed, 0),
			passes,
		},
		costSeries,
		judge: {
			judged: judged.length,
			trajectory: tally((e) => e.metrics?.judgeTrajectory),
			visual: tally((e) => e.metrics?.judgeVisual),
			disagreements: judgeDisagreements(manifest.entries).map((e) => ({
				armId: e.armId,
				jobId: e.jobId,
				...(e.metrics?.success !== undefined ? { success: e.metrics.success } : {}),
				...(e.metrics?.judgeTrajectory ? { judgeTrajectory: e.metrics.judgeTrajectory } : {}),
				...(e.metrics?.judgeScope ? { judgeScope: e.metrics.judgeScope } : {}),
			})),
		},
		events: events.slice(-100),
	};
}

/** ---- run detail: the appmap graph + the path a run took through it ---------------------- */

export interface DetailStep {
	index: number;
	/** What the step did, human-readable: the element it acted on, or the keys/text it sent. */
	label: string;
	kind: string;
	verified: boolean;
	channel?: string;
	reasoning?: string;
	/** Where the run believed it was after this step (graph surface id). */
	surface?: string;
	/** Matched graph node (control) this step acted on. */
	nodeId?: string;
	/** Matched navigation edge (surface transition) this step performed. */
	edgeTo?: string;
}

export interface DashDetail {
	jobId: string;
	armId: string;
	/** The run log's own task string — the page's prompt fallback for arms carrying none (replays). */
	task?: string;
	graph?: { nodes: any[]; edges: any[]; home?: string; gated?: string[] };
	/** Where the graph came from — archived arm map, live docs/appmaps, or nothing. */
	graphSource?: string;
	steps: DetailStep[];
	/** settingKeys the run's journal recorded as actually mutated. */
	mutatedKeys: string[];
	/**
	 * Traversal counts over THIS graph aggregated across every collected task/replay run
	 * that consumed it (same grounding arm + model pass) — the tree view's heat. Keyed by
	 * node id, so it is per-graph by construction: ax and cdp maps name nodes differently.
	 */
	heat?: { surfaces: Record<string, number>; controls: Record<string, number>; runs: number };
	note?: string;
}

function heatFor(
	graph: NonNullable<DashDetail["graph"]>,
	exploreArmId: string,
	model: string | undefined,
	manifest: Manifest,
	dataDir: string,
): DashDetail["heat"] {
	const out = { surfaces: {} as Record<string, number>, controls: {} as Record<string, number>, runs: 0 };
	for (const e of manifest.entries) {
		if (!e.collected || e.model !== model) continue;
		const a = armById(e.armId);
		if (!a || a.kind === "explore" || a.kind === "compile" || groundingArmId(a) !== exploreArmId) continue;
		const runLog = readJsonFile(path.join(dataDir, "out", "runs", `${e.jobId}.json`));
		const rawSteps = Array.isArray(runLog?.steps) ? runLog.steps : [];
		if (!rawSteps.length) continue;
		out.runs++;
		for (const st of matchPath(graph, rawSteps)) {
			if (st.edgeTo) out.surfaces[st.edgeTo] = (out.surfaces[st.edgeTo] ?? 0) + 1;
			if (st.nodeId) out.controls[st.nodeId] = (out.controls[st.nodeId] ?? 0) + 1;
		}
	}

	return out;
}

/**
 * Which phase-1 explore produced the map a task arm ran against. Mirrors how orchestrate
 * grounds the arms: web arms read the web explore, APPMAP_VARIANT=vision reads the
 * vision-only pass, otherwise the arm's own backend's map.
 */
export function groundingArmId(arm: Arm): string {
	if (arm.dispatch.url || arm.id.startsWith("p2-web")) return "p1-explore-web-cdp";
	if (arm.env?.APPMAP_VARIANT === "vision") return "p1-explore-vision";
	if (arm.dispatch.backend === "cdp") return "p1-explore-cdp";

	return "p1-explore-ax";
}

const stepLabel = (a: Record<string, any>, s: Record<string, any>): { label: string; kind: string } => {
	if (s.targetName) return { label: String(s.targetName), kind: a.kind === "tool" ? String(a.name ?? "act") : String(a.kind) };
	if (a.kind === "type") return { label: `type "${a.text}"`, kind: "type" };
	if (a.kind === "key") return { label: `key ${a.key}`, kind: "key" };
	if (a.kind === "hotkey") return { label: `keys ${(a.keys ?? []).join("+")}`, kind: "hotkey" };
	if (a.kind === "scroll") return { label: `scroll ${a.direction}`, kind: "scroll" };
	if (a.kind === "tool") return { label: String(a.name ?? "tool"), kind: "tool" };

	return { label: a.kind ?? "action", kind: String(a.kind ?? "action") };
};

/**
 * Walk a run's steps through the appmap graph. Matching is by the names the run RESOLVED
 * (StepRecord.targetName — what was actually clicked), against edge actions' quoted names
 * (`click "Brand Kit" …` → the root→brand-kit transition) and control titles, preferring
 * matches under the surface the walk currently stands on. Heuristic by construction — an
 * unmatched step stays in the list unanchored rather than being guessed onto the map.
 */
export function matchPath(graph: { nodes: any[]; edges: any[] }, rawSteps: Array<Record<string, any>>): DetailStep[] {
	const norm = (s: string): string => s.trim().toLowerCase();
	const controls = graph.nodes.filter((n) => n.kind === "control");
	let surface = "root";

	return rawSteps.map((s) => {
		const { label, kind } = stepLabel(s.action ?? {}, s);
		const out: DetailStep = {
			index: s.index,
			label,
			kind,
			verified: s.verified === true,
			...(s.verificationChannel ? { channel: String(s.verificationChannel) } : {}),
			...(s.modelReasoning ? { reasoning: String(s.modelReasoning) } : {}),
		};
		const name = s.targetName ? norm(String(s.targetName)) : undefined;
		if (name) {
			// Surface transition first: an edge whose quoted name is what was clicked.
			const edges = graph.edges.filter((e) => {
				const quoted = String(e.action ?? "").match(/"([^"]+)"/)?.[1];

				return quoted !== undefined && norm(quoted) === name;
			});
			const edge = edges.find((e) => e.from === surface) ?? edges[0];
			if (edge) {
				surface = String(edge.to);
				out.edgeTo = surface;
			} else {
				const hits = controls.filter((n) => norm(String(n.title ?? "")) === name);
				const hit = hits.find((n) => String(n.id).startsWith(`${surface}/`)) ?? hits[0];
				if (hit) out.nodeId = String(hit.id);
			}
		}
		out.surface = surface;

		return out;
	});
}

const readJsonFile = (file: string): Record<string, any> | undefined => {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};

/** The archived graph for an explore arm's pass, else the live docs/appmaps copy. */
function resolveGraph(
	entry: ManifestEntry,
	exploreArmId: string,
	app: string,
	benchRoot: string,
	dataDir: string,
): { graph?: DashDetail["graph"]; source?: string } {
	const archive = archiveDirFor(benchRoot, { ...entry, armId: exploreArmId });
	try {
		const file = fs.readdirSync(archive).find((f) => f.endsWith(".json"));
		if (file) {
			const g = readJsonFile(path.join(archive, file));
			if (g?.nodes) return { graph: shapeGraph(g), source: `${exploreArmId} pass (archived)` };
		}
	} catch {
		// No archive for that arm yet — fall through to the live map.
	}
	// appmapSlug, not appSlug: a web arm's `app` is a URL, and appSlug turns
	// https://app.notion.com into `https-app.notion.com` while the pass wrote
	// `web-app.notion.com`. The dash then reported no map for a 471-node map that existed.
	// Same backend-aware naming the pass writes with; the plain slug remains as the fallback
	// inside the live lookup below for curated and pre-split maps.
	// Backend-specific first, plain second — the same order and reasons as loadGrounding and
	// loadAppMapGraph: a map is not backend-portable (ax and cdp name the same surface
	// `editor` and `draft-editor`), while curated and pre-split maps live under the plain slug.
	const arm = MATRIX.find((a) => a.id === exploreArmId);
	for (const slug of [...(arm ? [armAppmapSlug(arm)] : []), appmapSlug(app)]) {
		const live = readJsonFile(path.join(dataDir, "docs", "appmaps", `${slug}.json`));
		if (live?.nodes) return { graph: shapeGraph(live), source: `docs/appmaps/${slug}.json (live)` };
	}

	return {};
}

/** The graph fields the page renders — including gated node ids, the per-node "refused" signal. */
function shapeGraph(g: Record<string, any>): NonNullable<DashDetail["graph"]> {
	// The appmap writer records gated ids BARE ("publish") while graph node ids are
	// path-qualified ("draft-editor/publish"), so a raw pass-through never matched a node
	// and gated rings were invisible on every map. Resolve each bare id to the node(s)
	// whose id equals it or ends with "/<bare>" — the bare id lost its surface, so when
	// several same-named controls exist, marking all of them gated is the honest reading.
	const nodeIds: string[] = Array.isArray(g.nodes) ? g.nodes.map((n: any) => String(n?.id)) : [];
	const gated = [
		...new Set(
			(Array.isArray(g.gated) ? g.gated.map((x: any) => String(x?.id)).filter(Boolean) : []).flatMap((bare: string) =>
				nodeIds.some((id) => id === bare) ? [bare] : nodeIds.filter((id) => id.endsWith(`/${bare}`)),
			),
		),
	];

	return {
		nodes: g.nodes,
		edges: g.edges ?? [],
		...(g.home ? { home: String(g.home) } : {}),
		...(gated.length ? { gated } : {}),
	};
}

/** Everything the board's dropdown needs for one run: the map, the walk, the mutations. */
export function buildDetail(jobId: string, manifest: Manifest, opts: { dataDir?: string; benchRoot?: string } = {}): DashDetail {
	const dataDir = opts.dataDir ?? dataRoot();
	const benchRoot = opts.benchRoot ?? benchDir(manifest.date);
	const entry = manifest.entries.find((e) => e.jobId === jobId);
	if (!entry) return { jobId, armId: "?", steps: [], mutatedKeys: [], note: "no manifest entry for this job" };
	const arm = armById(entry.armId);
	if (!arm) return { jobId, armId: entry.armId, steps: [], mutatedKeys: [], note: "unknown arm" };

	const exploreArmId = arm.kind === "explore" ? arm.id : groundingArmId(arm);
	const { graph, source } = resolveGraph(entry, exploreArmId, arm.app, benchRoot, dataDir);

	const notes: string[] = [];
	if (!graph) notes.push("no appmap graph found for this arm yet");
	if (arm.kind === "explore") notes.push("Explore pass — the map IS the output; there is no task path");
	if (flagsLine(arm).includes("NO_GROUNDING")) notes.push("unexplored run — the agent never saw this map; the walk is reconstructed for comparison");

	let steps: DetailStep[] = [];
	let task: string | undefined;
	if (arm.kind !== "explore") {
		const runLog = readJsonFile(path.join(dataDir, "out", "runs", `${jobId}.json`));
		const rawSteps: Array<Record<string, any>> = Array.isArray(runLog?.steps) ? runLog.steps : [];
		if (!runLog) notes.push("run log not on this machine yet — collect pulls it when the run lands");
		if (typeof runLog?.task === "string") task = runLog.task;
		steps = graph ? matchPath(graph, rawSteps) : rawSteps.map((s) => ({ ...stepLabel(s.action ?? {}, s), index: s.index, verified: s.verified === true }));
	}

	const mutatedKeys = [
		...new Set(
			readJournal(path.join(dataDir, "out", "runs", `${jobId}.journal.jsonl`))
				.filter((m) => m.kind === "setting")
				.map((m) => (m as Record<string, any>).settingKey)
				.filter((k): k is string => typeof k === "string"),
		),
	];

	return {
		jobId,
		armId: entry.armId,
		...(task ? { task } : {}),
		...(graph ? { graph } : {}),
		...(source ? { graphSource: source } : {}),
		steps,
		mutatedKeys,
		...(graph ? { heat: heatFor(graph, exploreArmId, entry.model, manifest, dataDir) } : {}),
		...(notes.length ? { note: notes.join("; ") } : {}),
	};
}

/** ---- server ---------------------------------------------------------------------------- */

const FLEET_POLL_SEC = Number(process.env.DASH_FLEET_SEC ?? 20);
const COLLECT_SEC = Number(process.env.DASH_COLLECT_SEC ?? 60);

/** /api/logs job ids become path segments locally and a spec field remotely — same shape jobs.ts pins. */
const LOG_JOB_RE = /^[A-Za-z0-9._-]+$/;
/** A first read (offset 0) of a huge log forwards only this much tail — the pane wants recent lines, not 10MB. */
const LOG_TAIL_BYTES = 64 * 1024;

/** Everything one single-shot `runnerctl logs` reply folds down to for the /api/logs response. */
export interface LogFrames {
	/** All chunk payloads, decoded and re-joined as ONE base64 string (see the buffer note below). */
	chunkB64: string;
	nextOffset: number;
	/** The terminal frame's job state; "unknown" when no terminal frame arrived (truncated stream). */
	state: string;
	exitCode: number | null;
	/** A `{ok:false}` frame's message — the runner refusing, not ssh failing. */
	error?: string;
}

/**
 * Parse EVERY stdout NDJSON line of a `runnerctl logs` reply. ssh.ts's lastFrame() is wrong
 * here by design — it keeps only the final parseable object, which for this stream is the
 * terminal `{done:true}` frame, silently dropping every chunk frame before it.
 *
 * Chunks accumulate as BUFFERS and re-encode once: two base64 payloads joined as text are
 * not valid base64 (padding lands mid-stream), and decoding per-chunk to a string would
 * corrupt a multi-byte character straddling a chunk boundary — the same reason the runner
 * framed them as base64 in the first place.
 */
export function parseLogFrames(stdout: string): LogFrames {
	const chunks: Buffer[] = [];
	let nextOffset = 0;
	let state = "unknown";
	let exitCode: number | null = null;
	let error: string | undefined;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let frame: Record<string, any>;
		try {
			frame = JSON.parse(trimmed);
		} catch {
			continue; // ssh banners and truncated interleavings are expected, never fatal
		}
		if (frame.ok === false) {
			if (typeof frame.error === "string") error = frame.error;
			continue;
		}
		if (typeof frame.chunk === "string") chunks.push(Buffer.from(frame.chunk, "base64"));
		if (typeof frame.nextOffset === "number") nextOffset = frame.nextOffset;
		if (frame.done === true) {
			if (typeof frame.state === "string") state = frame.state;
			exitCode = typeof frame.exitCode === "number" ? frame.exitCode : null;
		}
	}

	return { chunkB64: Buffer.concat(chunks).toString("base64"), nextOffset, state, exitCode, ...(error ? { error } : {}) };
}

export interface DashOptions {
	port: number;
	date: string;
	autoCollect: boolean;
}

/**
 * The date to watch when none was asked for: the LATEST manifest that exists, else today.
 * A benchmark drains across the UTC midnight rollover, and a dash restarted at 00:10 that
 * silently pointed at a fresh empty manifest — while three Macs kept draining yesterday's —
 * is exactly what happened the first night this ran.
 */
export function defaultDashDate(root?: string): string {
	try {
		const base = path.dirname(benchDir(utcDate(), root));
		// Non-empty manifests only: the rollover itself can mint an empty next-day manifest
		// (any collect run after midnight does), and that husk must not outrank the drain.
		const dates = fs
			.readdirSync(base)
			.filter((d) => {
				if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
				try {
					return (JSON.parse(fs.readFileSync(path.join(base, d, "manifest.json"), "utf8")).entries?.length ?? 0) > 0;
				} catch {
					return false;
				}
			})
			.sort();
		if (dates.length) return dates[dates.length - 1] as string;
	} catch {
		// No bench dir yet — today is as good as anything.
	}

	return utcDate();
}

/** CLI flags shared by the web entry (main below) and the Electron shell (electron/dash.ts). */
export function parseDashArgs(args: string[]): DashOptions {
	const flag = (name: string): string | undefined => {
		const i = args.indexOf(name);

		return i >= 0 ? args[i + 1] : undefined;
	};

	return {
		port: Number(flag("--port") ?? process.env.DASH_PORT ?? 4642),
		date: flag("--date") ?? defaultDashDate(),
		autoCollect: !args.includes("--no-collect"),
	};
}

/**
 * The page ships beside this module in the source tree, but tsc does not copy .html into
 * dist-electron — so the compiled module walks back to the repo's src copy. Resolved once
 * at startup so a missing page fails loudly at launch, not on first request.
 */
function resolveHtml(): string {
	const candidates = [new URL("./dash.html", import.meta.url), new URL("../../../src/bench/dash.html", import.meta.url)];
	for (const url of candidates) {
		const p = fileURLToPath(url);
		if (fs.existsSync(p)) return p;
	}

	throw new Error(`dash.html not found near ${import.meta.url}`);
}

/**
 * Parse one .env line into [name, value]. Blanks, comments, and anything that is not a
 * `KEY=VALUE` / `export KEY=VALUE` assignment come back undefined. One layer of matching
 * single or double quotes is stripped from the value, mirroring what `source` would do.
 */
export function parseEnvLine(line: string): [string, string] | undefined {
	const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
	if (!m) return undefined;
	let v = m[2]!.trim();
	if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))))
		v = v.slice(1, -1);

	return [m[1]!, v];
}

/**
 * Seed process.env from the same files ./run sources, in the same order. WHY: launchers that
 * bypass ./run (watchdogs, bare `tsx watch src/bench/dash.ts`) produced keyless dashes twice
 * tonight (2026-07-31) — the narrator failed every tick with an OpenRouter-needs-a-key error
 * and defaultModel resolved wrong. This makes any launch path equivalent to ./run's sourcing.
 *
 * A keyed environment is never overridden: if any model key is already present the loader
 * does nothing at all, and even when a file is read, only names absent from process.env are
 * set. First existing file wins — same `break` as the run script's loop. Returns the file
 * that seeded the env, for the startup log line (names only — never values).
 */
export function loadEnvFallback(): string | undefined {
	if ("OPENROUTER_API_KEY" in process.env || "ANTHROPIC_API_KEY" in process.env
		|| Object.keys(process.env).some((k) => k.startsWith("AZURE"))) return undefined;
	// Repo root from the module location, not cwd — a watchdog can launch from anywhere.
	// Two candidates because the compiled copy sits deeper than src/ (resolveHtml's trick);
	// package.json is the marker that says "this level is actually the repo".
	let root: string | undefined;
	for (const rel of ["../..", "../../.."]) {
		const p = fileURLToPath(new URL(rel, import.meta.url));
		if (fs.existsSync(path.join(p, "package.json"))) { root = p; break; }
	}
	if (!root) return undefined;
	const runnerDir = process.env.YARN_RUNNER_DIR ?? path.join(os.homedir(), ".yarn-runner");
	for (const file of [path.join(root, ".env"), path.join(root, "..", "yarn", ".env"), path.join(runnerDir, "env")]) {
		if (!fs.existsSync(file)) continue;
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			const kv = parseEnvLine(line);
			if (kv && !(kv[0] in process.env)) process.env[kv[0]] = kv[1];
		}
		console.log(`dash: env seeded from ${file} (launcher bypassed ./run)`);

		return file;
	}

	return undefined;
}

export async function startDash(opts: DashOptions): Promise<http.Server> {
	// Before ANYTHING that calls makeClient — the defaultModel resolution just below and
	// every narrate tick read the key env vars this seeds.
	loadEnvFallback();
	const { port, date, autoCollect } = opts;

	let manifest = readManifest(date);
	let fleet: FleetView = { rows: [] };
	const events: DashEvent[] = [];
	const clients = new Set<http.ServerResponse>();

	// What "(default)" would run HERE — the same key precedence makeClient applies. A hint
	// for uncollected passes only; keyless environments just leave it blank.
	let defaultModel: string | undefined;
	try {
		defaultModel = (await import("../core/harness/model.js")).makeClient().model;
	} catch {
		// No usable key on this machine — collected runs will supply the truth.
	}

	const addEvent = (line: string): void => {
		events.push({ t: new Date().toISOString(), line });
		if (events.length > 200) events.shift();
	};

	// Seeded from disk so a restart does not lose the note: narrate() persists every mint to
	// narrative.md, and narratedCount still starts at -1, so a keyed process replaces this
	// with a fresh note on its first tick — the seed only covers the window (or the keyless
	// environment) where it cannot.
	let narrative: Narrative | undefined = readPersistedNarrative(date);

	// The ONE state builder for anything a client can receive. `narrative` used to be attached
	// only inside push(), so GET /api/state and the initial /events frame omitted it — a page
	// that connected after the note was minted showed nothing until an unrelated push came by.
	const currentState = (): DashState => {
		const state = buildState(manifest, fleet, events, autoCollect, defaultModel);
		if (narrative) state.narrative = narrative;

		return state;
	};

	const push = (): void => {
		const data = `data: ${JSON.stringify(currentState())}\n\n`;
		for (const res of clients) res.write(data);
	};

	// The narrator: when a landing batch changes what is known, ask the default model for a
	// plain-English read of the rollups. A commentator, not an authority — its note renders
	// with a "verify before quoting" sub and appends to narrative.md beside the manifest.
	// DASH_NARRATE=0 disables; a keyless environment just logs and moves on.
	let narratedCount = -1;
	let narrating = false;
	const narrate = async (): Promise<void> => {
		if (process.env.DASH_NARRATE === "0" || narrating) return;
		const collectedCount = manifest.entries.filter((e) => e.collected).length;
		if (collectedCount === 0 || collectedCount === narratedCount) return;
		narrating = true;
		try {
			const { makeClient } = await import("../core/harness/model.js");
			const { client, model } = makeClient();
			const digest = narratorDigest(buildState(manifest, fleet, [], autoCollect, defaultModel));
			const res = await client.messages.create({
				model,
				// 4000, not a text-sized budget: reasoning models spend max_tokens on thinking
				// BEFORE the visible text, and 400 was exhausted mid-reason — every tick failed
				// with no text at all. The prompt caps the visible output (~5 sentences), so
				// this ceiling does not bound the note's length.
				max_tokens: 4000,
				messages: [{ role: "user", content: narratorPrompt(digest, narrative?.text) }],
			});
			const text = (res.content ?? [])
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text)
				.join("\n")
				.trim();
			if (!text) {
				// Name WHY there was no text — "no text" alone hid a max_tokens exhaustion for a day.
				const stop = (res as any).stop_reason ?? (res as any).finish_reason ?? "unknown";
				const blocks = (res.content ?? []).map((b: any) => b?.type ?? "?").join(", ") || "none";
				throw new Error(`model returned no text (stop: ${stop}; blocks: ${blocks})`);
			}
			narratedCount = collectedCount;
			narrative = { updatedAt: new Date().toISOString(), text, model };
			fs.appendFileSync(
				path.join(benchDir(date), "narrative.md"),
				`\n## ${narrative.updatedAt} — ${collectedCount} collected (${model})\n\n${text}\n`,
			);
			addEvent(`narrator: note updated (${collectedCount} collected)`);
			push();
		} catch (e) {
			addEvent(`narrator failed: ${(e as Error).message}`);
		} finally {
			narrating = false;
		}
	};

	// The manifest is replaced atomically (temp + rename), so watch the DIRECTORY — a rename
	// never fires a change event on the watched file itself. Debounced because one collect
	// pass rewrites the manifest once per entry.
	fs.mkdirSync(benchDir(date), { recursive: true });
	let watchTimer: NodeJS.Timeout | undefined;
	fs.watch(benchDir(date), () => {
		clearTimeout(watchTimer);
		watchTimer = setTimeout(() => {
			manifest = readManifest(date);
			push();
		}, 300);
	});

	// Fleet poll — lazy import so `buildState` stays importable without the ssh machinery.
	const { fleetStatus } = await import("../remote/control/fleet.js");

	/**
	 * The laptop itself runs agent/explore/replay jobs that `fleetStatus()` cannot see — it
	 * only polls the colo Macs — so an in-flight local run appears nowhere on the board.
	 * Detect one with the same pgrep the run script's in-flight guard uses and surface it as
	 * a synthetic "local" row. Identity is best-effort from the freshest run artifact; an
	 * idle laptop is not a fleet member, so no run means no row at all.
	 */
	const localRunRow = async (): Promise<FleetRow | undefined> => {
		// pgrep exits 1 on no match — that is the quiet "nothing running" path, not an error.
		const inFlight = await new Promise<boolean>((resolve) =>
			execFile("pgrep", ["-f", "tsx src/core/(agent|explore|recipe-cli)\\.ts"], (err) => resolve(!err)));
		if (!inFlight) return undefined;

		let jobId: string | undefined;
		let app: string | undefined;
		let elapsedSec: number | undefined;
		try {
			const runsDir = path.join(dataRoot(), "out", "runs");
			const now = Date.now();
			const fresh = fs.readdirSync(runsDir)
				.filter((f) => f.endsWith(".json") && !f.endsWith(".judge.json"))
				.map((f) => ({ f, st: fs.statSync(path.join(runsDir, f)) }))
				.filter((e) => e.st.isFile() && now - e.st.mtimeMs < 15 * 60 * 1000)
				.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)[0];
			if (fresh) {
				jobId = fresh.f.replace(/(?:\.checkpoint)?\.json$/, "");
				// Stems read `[explore-]<stamp>-<app-slug>` — the slug is the best-effort app.
				app = /^(?:explore-)?\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-(.+)$/.exec(jobId)?.[1];
				// birthtime is 0 on filesystems that do not track it — fall back to mtime.
				elapsedSec = Math.max(0, Math.round((now - (fresh.st.birthtimeMs || fresh.st.mtimeMs)) / 1000));
			}
		} catch {
			// No artifacts yet (or out/runs missing) — the row still reports a busy laptop.
		}

		return {
			name: "local",
			reachable: true,
			state: "busy",
			...(app ? { app } : {}),
			...(jobId ? { jobId } : {}),
			...(elapsedSec !== undefined ? { elapsedSec } : {}),
		};
	};

	let polling = false;
	const pollFleet = async (): Promise<void> => {
		if (polling) return;
		polling = true;
		try {
			const rows = await fleetStatus();
			const local = await localRunRow();
			fleet = { rows: local ? [local, ...rows] : rows, polledAt: new Date().toISOString() };
		} catch (e) {
			fleet = { ...fleet, error: (e as Error).message };
			addEvent(`fleet poll failed: ${(e as Error).message}`);
		} finally {
			polling = false;
		}
		manifest = readManifest(date);
		push();
	};

	// Collect loop — the "results come in" mechanism. Idempotent by design (collect.ts), so
	// racing a manual `bench collect` converges. Skipped while nothing is uncollected.
	let collecting = false;
	const runCollect = async (): Promise<void> => {
		if (collecting || !manifest.entries.some((e) => !e.collected && e.host !== "local")) return;
		collecting = true;
		try {
			const { collect } = await import("./collect.js");
			const outcome = await collect({ date, log: (line) => addEvent(`collect: ${line}`) });
			if (outcome.collected.length) addEvent(`collect: ${outcome.collected.length} run(s) landed`);
		} catch (e) {
			addEvent(`collect failed: ${(e as Error).message}`);
		} finally {
			collecting = false;
		}
		manifest = readManifest(date);
		push();
	};

	/**
	 * Fleet peek: a view-only live stream of a colo Mac's Chromium target, embedded in its
	 * host card. CDP-transport ONLY, on purpose: the debug port needs no TCC and no runner
	 * involvement — the dash tunnels to it (tunnelArgv, the repo's one ssh builder) and hosts
	 * the screencast engine itself, so nothing ships to the fleet mid-drain.
	 *
	 * A missing endpoint is never a socket-terminating error: the session lifecycle is
	 * probing → streaming ⇄ waiting. An ax-arm run on an unflagged app has no endpoint — the
	 * session says so and keeps re-probing until a debuggable target appears. Teardown happens
	 * ONLY on host switch (4409), 30s zero-viewer idle, or process exit.
	 *
	 * View-only is structural: the viewer's messages are never forwarded to the engine, so a
	 * stray click cannot corrupt a live benchmark run. One peek at a time — a second host's
	 * peek preempts the first (last request wins, the fleet's own idiom). Each tunnel binds an
	 * EPHEMERAL local port, so nothing on the laptop — a stale ControlMaster forward, a local
	 * debug-flagged Chrome, another dash — can ever collide with it.
	 */
	// Loaded ONCE — every cast, close frame, handshake, and decoder reuses the same codec.
	const wslib = await import("../remote/liveview-ws.js");
	const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

	const PEEK_PORTS = [9222, 9777]; // app target · web-Chrome, matching the cdp backend's defaults
	const MAX_QUEUED_PEEK_BYTES = 1.5 * 1024 * 1024;
	const PROBE_STEP_MS = 400; // initial-attach probe spacing
	const PROBE_BUDGET_MS = 8000; // initial-attach budget (covers ~478ms tunnel bind + churn)
	const WAIT_REPROBE_MS = 3000; // re-probe cadence in "waiting" state
	const HEARTBEAT_MS = 5000; // {ev:"ping"} cadence to viewers — the client's staleness watchdog feeds on it
	const IDLE_TEARDOWN_MS = 30_000; // last-viewer linger, long enough for a reload to rejoin the live session
	const TUNNEL_RESPAWN_MS = [1000, 2000, 5000]; // backoff for dead tunnel children (cap at last)
	// ssh.ts's tunnelArgv appends its anti-mux options AFTER sshBaseArgv's ControlMaster=auto block,
	// and OpenSSH is FIRST-value-wins — so those overrides are dead letters and peek tunnels join the
	// fleet-poll's mux master (no keepalives, kill() doesn't cancel forwards). ssh.ts is shared/read-only;
	// prepending here wins under first-value-wins.
	const TUNNEL_OVERRIDES = ["-o", "ControlPath=none", "-o", "ControlMaster=no", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ExitOnForwardFailure=yes"];

	type PeekState = "probing" | "waiting" | "streaming";
	interface Peek {
		host: string;
		/** The loadHosts() entry — tunnel respawn rebuilds argv from it. */
		hostCfg: any;
		locals: Array<{ remote: number; local: number }>;
		/** Slot-indexed, parallel to locals. */
		tunnels: Array<ChildProcess | undefined>;
		/** Per-slot, reset on a successful probe through that slot. */
		respawnCounts: number[];
		respawnTimers: Array<NodeJS.Timeout | undefined>;
		engine?: EngineHandle;
		/** Set on the first frame from the CURRENT engine attach — flips waiting→streaming once. */
		gotFrame: boolean;
		state: PeekState;
		sockets: Set<Duplex>;
		idleTimer?: NodeJS.Timeout;
		reprobeTimer?: NodeJS.Timeout;
		heartbeatTimer?: NodeJS.Timeout;
		/** Last status/error JSON frame, replayed to late joiners so they render state instantly. */
		lastStatus?: Buffer;
		/** Last {ev:"window"} frame, replayed to late joiners. */
		lastWindow?: Buffer;
		/** Set by teardown so child-exit handlers no-op instead of respawning. */
		closing: boolean;
	}
	let peek: Peek | undefined;
	// Serializes ensurePeek — without it two racing upgrades interleave the old session's
	// teardown with the new one's construction (the strand/demolish races).
	let ensureChain: Promise<unknown> = Promise.resolve();

	const cast = (p: Peek, payload: Buffer, kind: "binary" | "text"): void => {
		for (const s of p.sockets) {
			// Backpressure: skip FRAMES for a slow viewer rather than buffering unboundedly;
			// text (status/errors) is small enough to always send.
			if (kind === "binary" && (s as any).writableLength > MAX_QUEUED_PEEK_BYTES) continue;
			try {
				s.write(wslib.encodeFrame(payload, kind));
			} catch {
				s.destroy();
			}
		}
	};
	const castJson = (p: Peek, obj: unknown): Buffer => {
		const b = Buffer.from(JSON.stringify(obj));
		cast(p, b, "text");

		return b;
	};
	const setStatus = (p: Peek, state: PeekState, message: string): void => {
		p.state = state;
		p.lastStatus = castJson(p, { ev: "status", state, message });
	};
	// A REAL close frame (code uint16 BE + reason ≤120 bytes) so the client can classify
	// retryable vs fatal — a bare destroy reads as 1006 and gets retried even when it
	// should be abandoned.
	const closeSocket = (s: Duplex, code: number, reason: string): void => {
		try {
			const rb = Buffer.from(reason, "utf8").subarray(0, 120);
			const payload = Buffer.alloc(2 + rb.length);
			payload.writeUInt16BE(code, 0);
			rb.copy(payload, 2);
			s.write(wslib.encodeFrame(payload, "close"));
		} catch {}
		s.end();
		setTimeout(() => s.destroy(), 1000).unref?.();
	};

	const teardownPeek = (code = 1001, reason = "peek closed"): void => {
		if (!peek) return;
		const p = peek;
		peek = undefined;
		p.closing = true; // BEFORE killing tunnels, so their exit handlers don't respawn
		clearTimeout(p.idleTimer);
		clearTimeout(p.reprobeTimer);
		clearTimeout(p.heartbeatTimer);
		for (const t of p.respawnTimers) clearTimeout(t);
		p.engine?.close();
		p.engine = undefined;
		// With TUNNEL_OVERRIDES prepended these are real non-mux clients, so SIGTERM actually
		// closes the forwards (a mux client's kill() leaves the master's forward standing).
		for (const t of p.tunnels) t?.kill("SIGTERM");
		for (const s of p.sockets) closeSocket(s, code, reason);
		addEvent(`peek: closed (${p.host}) — ${reason}`);
	};

	const endpointUp = async (port: number): Promise<boolean> => {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });

			return res.ok;
		} catch {
			return false;
		}
	};

	/** An ephemeral local port, picked by letting the OS bind 0 and reading back what it chose. */
	const freeLocalPort = async (): Promise<number> => {
		const { createServer } = await import("node:net");

		return new Promise((resolve, reject) => {
			const srv = createServer();
			srv.once("error", reject);
			srv.listen(0, "127.0.0.1", () => {
				const chosen = (srv.address() as { port: number }).port;
				srv.close(() => resolve(chosen));
			});
		});
	};

	type TunnelArgvFn = (host: any, remotePort: number, localPort: number) => string[];
	const spawnTunnel = (p: Peek, slot: number, tunnelArgv: TunnelArgvFn): void => {
		const { remote, local } = p.locals[slot];
		const child = spawn("ssh", [...TUNNEL_OVERRIDES, ...tunnelArgv(p.hostCfg, remote, local)], { stdio: "ignore" });
		p.tunnels[slot] = child;
		child.once("exit", (codeOrNull) => {
			if (p.closing || peek !== p) return; // teardown killed it — expected
			addEvent(`peek: tunnel :${remote} on ${p.host} exited (${codeOrNull ?? "signal"})`);
			p.lastStatus = castJson(p, { ev: "error", kind: "tunnel-died", message: `ssh tunnel for :${remote} on ${p.host} dropped — respawning` });
			const n = Math.min(p.respawnCounts[slot], TUNNEL_RESPAWN_MS.length - 1);
			p.respawnCounts[slot]++;
			p.respawnTimers[slot] = setTimeout(() => {
				void (async () => {
					if (p.closing || peek !== p) return;
					// FRESH ephemeral port — never rebind the old one (TOCTOU: anything may
					// have grabbed it between the tunnel dying and this respawn firing).
					p.locals[slot] = { remote, local: await freeLocalPort() };
					if (p.closing || peek !== p) return;
					spawnTunnel(p, slot, tunnelArgv);
				})();
			}, TUNNEL_RESPAWN_MS[n]);
		});
	};
	// A dead endpoint tunnel also kills the CDP websocket riding it, so the engine fires
	// onExit → the waiting/reprobe loop picks up the respawned tunnel's new local port
	// automatically. No extra wiring needed; the composition is the design.

	const probeOnce = async (p: Peek): Promise<{ endpoint: string; browserEndpoint: string } | undefined> => {
		// Probe slot 0 (app :9222) first; the first answering local port is primary.
		for (const slot of [0, 1]) {
			const { local } = p.locals[slot];
			if (await endpointUp(local)) {
				p.respawnCounts[slot] = 0;
				const other = p.locals[slot === 0 ? 1 : 0].local;
				// ALWAYS pass the other tunnel's local port as browserEndpoint even if it never
				// answered: the engine's own lazy re-probe (its documented design) picks it up when
				// it appears, and never passing it would make the engine default to the LAPTOP'S
				// OWN 127.0.0.1:9777 — which can silently stream the operator's local Chrome into
				// the panel.
				return { endpoint: `http://127.0.0.1:${p.locals[slot].local}`, browserEndpoint: `http://127.0.0.1:${other}` };
			}
		}

		return undefined;
	};

	const tryConnect = async (p: Peek, eps: { endpoint: string; browserEndpoint: string }): Promise<boolean> => {
		const { connectCdpEngine } = await import("../remote/liveview-cdp.js");
		const engine = await connectCdpEngine({ endpoint: eps.endpoint, browserEndpoint: eps.browserEndpoint, quality: 80, maxWidth: 1600, app: p.host });
		if (peek !== p || p.closing) {
			engine.close();

			return false;
		}
		p.gotFrame = false;
		p.engine = engine;
		engine.onFrame((jpeg) => {
			if (peek !== p || p.engine !== engine) return;
			if (!p.gotFrame) {
				p.gotFrame = true;
				setStatus(p, "streaming", `streaming ${p.host}`);
			}
			cast(p, jpeg, "binary");
		});
		engine.onEvent((ev: any) => {
			if (peek !== p || p.engine !== engine) return;
			if (ev?.ev === "window") p.lastWindow = castJson(p, ev);
			else castJson(p, ev);
			// Inert-handle detection: connect-time deaths resolve to an engine whose exit NEVER
			// fires; the only signal is this first buffered error event. Treat it as a failed attach.
			if (ev?.ev === "error" && !p.gotFrame && (ev.kind === "cdp-unreachable" || ev.kind === "no-page" || ev.kind === "capture-failed")) {
				engine.close();
				if (p.engine === engine) p.engine = undefined;
				enterWaiting(p, `attach failed (${ev.kind}) — waiting for a debuggable target on ${p.host}`);
			}
		});
		engine.onExit(() => {
			if (peek !== p || p.engine !== engine) return; // stale corpse callback — ignore
			p.engine = undefined;
			p.lastStatus = castJson(p, { ev: "error", kind: "stream-ended", message: "target closed — waiting for it to come back" });
			enterWaiting(p, `waiting for a debuggable target on ${p.host}`);
		});
		setStatus(p, "streaming", `streaming ${p.host}`);
		addEvent(`peek: streaming ${p.host} via ${eps.endpoint} (+${eps.browserEndpoint})`);

		return true;
	};

	const enterWaiting = (p: Peek, message: string): void => {
		if (peek !== p || p.closing) return;
		setStatus(p, "waiting", message);
		clearTimeout(p.reprobeTimer);
		p.reprobeTimer = setTimeout(() => {
			void reprobeTick(p);
		}, WAIT_REPROBE_MS);
	};

	const reprobeTick = async (p: Peek): Promise<void> => {
		try {
			if (peek !== p || p.closing || p.engine) return;
			const eps = await probeOnce(p);
			if (peek !== p || p.closing) return;
			if (eps && (await tryConnect(p, eps))) return;
			if (peek !== p || p.closing || p.engine) return;
			p.reprobeTimer = setTimeout(() => {
				void reprobeTick(p);
			}, WAIT_REPROBE_MS);
		} catch (err) {
			enterWaiting(p, `attach error — retrying (${String(err).slice(0, 120)})`);
		}
	};

	const attachLoop = async (p: Peek): Promise<void> => {
		try {
			// Initial attach: a REAL time budget. A fresh non-mux ssh tunnel binds its -L listener
			// only after connect+auth (~0.5s measured); refused probes return in ~2ms, so without
			// the sleep the whole budget burns in ~30ms.
			const deadline = Date.now() + PROBE_BUDGET_MS;
			while (peek === p && !p.closing && Date.now() < deadline) {
				const eps = await probeOnce(p);
				if (peek !== p || p.closing) return;
				if (eps && (await tryConnect(p, eps))) return;
				if (peek !== p || p.closing || p.engine) return;
				await sleep(PROBE_STEP_MS);
			}
			if (peek !== p || p.closing || p.engine) return;
			// Budget exhausted: do NOT tear down. Keep tunnels up, arm the re-probe, and attach
			// when a target appears. The fleet snapshot can be a poll interval (~20s) stale, so
			// the busy/idle diagnosis is best-effort, not ground truth.
			const row = fleet.rows.find((r) => r.name === p.host);
			const msg = row?.state === "busy"
				? `no CDP endpoint on ${p.host} yet — the current run may be an ax-arm (no debug port); will attach when one appears`
				: row?.state === "idle"
					? `${p.host} is idle — will attach when a debuggable target appears (next cdp-arm run, or a web run's Chrome)`
					: `no CDP endpoint on ${p.host} and its runner state is unknown — will keep trying (check ./run hosts)`;
			enterWaiting(p, msg);
		} catch (err) {
			enterWaiting(p, `attach error — retrying (${String(err).slice(0, 120)})`);
		}
	};

	type EnsureResult = { ok: true; session: Peek } | { ok: false; error: string };
	const ensurePeek = (hostName: string): Promise<EnsureResult> => {
		const r = ensureChain.then(() => doEnsurePeek(hostName), () => doEnsurePeek(hostName));
		ensureChain = r.catch(() => {});

		return r;
	};

	const doEnsurePeek = async (hostName: string): Promise<EnsureResult> => {
		// FAST PATH: same host joins the live session regardless of engine liveness or state —
		// the attach loop owns recovery for the session's entire life, and a joining socket
		// learns the current state from the late-joiner replay.
		if (peek && peek.host === hostName) return { ok: true, session: peek };
		if (peek) {
			castJson(peek, { ev: "error", kind: "superseded", message: `preempted by a peek of ${hostName}` });
			teardownPeek(4409, `preempted by a peek of ${hostName}`);
		}
		const [{ loadHosts }, { tunnelArgv }] = await Promise.all([import("../remote/control/hosts.js"), import("../remote/control/ssh.js")]);
		const host = loadHosts().hosts.find((h) => h.name === hostName);
		if (!host) return { ok: false, error: `unknown host ${JSON.stringify(hostName)}` };

		// Each remote debug port tunnels to a FRESH ephemeral local port. The old fixed
		// 9222/9777 local bindings needed a squatter-refusal check and a wait-for-release loop
		// after teardown (our own dying ssh held the port); both are obsolete with ephemeral
		// ports and were deleted — nothing else can be listening on a port the OS just minted.
		const locals: Array<{ remote: number; local: number }> = [];
		for (const remote of PEEK_PORTS) locals.push({ remote, local: await freeLocalPort() });

		const p: Peek = { host: hostName, hostCfg: host, locals, tunnels: [], respawnCounts: [0, 0], respawnTimers: [], gotFrame: false, state: "probing", sockets: new Set(), closing: false };
		peek = p;
		// No await from here to attachLoop: the caller's socket must attach before any engine
		// event can fire (the buffered-inert-error-to-zero-sockets bug, fixed structurally —
		// attach is fully asynchronous and this function never probes or connects).
		spawnTunnel(p, 0, tunnelArgv);
		spawnTunnel(p, 1, tunnelArgv);
		p.heartbeatTimer = setInterval(() => castJson(p, { ev: "ping" }), HEARTBEAT_MS);
		setStatus(p, "probing", `connecting — opening ssh tunnels to ${hostName}…`);
		void attachLoop(p); // detached — the upgrade handler must NOT wait for attach

		return { ok: true, session: p };
	};

	const htmlPath = resolveHtml();

	// Hot reload for the page itself: editors save via rename, which kills a file-watch, so
	// watch the DIRECTORY and filter to the html basename (same reason as the manifest watcher
	// above). Not push() — the page reloads itself and refetches everything, so full state is
	// redundant here; a bare reload frame is all it needs. Debounced: one save fires several
	// events. try/catch because hot reload is a dev nicety — an unwatchable dir must not kill
	// the server.
	try {
		const htmlBase = path.basename(htmlPath);
		let htmlTimer: NodeJS.Timeout | undefined;
		fs.watch(path.dirname(htmlPath), (_ev, filename) => {
			if (filename && filename !== htmlBase) return;
			clearTimeout(htmlTimer);
			htmlTimer = setTimeout(() => {
				for (const res of clients) res.write(`data: {"reload":true}\n\n`);
			}, 200);
		});
	} catch {
		// Degrade silently — the dashboard still serves; edits just need a manual refresh.
	}

	/**
	 * GET /api/logs?job=<id>&host=<name>&offset=<n>[&meta=1] — the run-log pane's feed.
	 *
	 * Local first: a pulled/collected run's log already sits at <dataRoot>/out/jobs/<job>/
	 * log.txt and needs no ssh (job.json beside it answers what meta=1 would have asked the
	 * runner for). Otherwise ONE single-shot `runnerctl logs` — no follow key, the client's
	 * 2.5s poll IS the follow — parsed by parseLogFrames because lastFrame() would keep only
	 * the terminal frame and drop every chunk.
	 *
	 * The payload stays base64 END-TO-END: offsets are byte offsets, a poll boundary can
	 * split a UTF-8 character, and only the client's one streaming TextDecoder per pane may
	 * reassemble it. On the first read (offset 0) only the last ~64KB is forwarded, with the
	 * TRUE nextOffset — never seek-from-end remotely, because readLog resets fromByte>size
	 * to 0 by design (rotation guard), so a guessed size-minus-64K offset can replay the
	 * whole file.
	 */
	const logsInflight = new Set<string>();
	const serveLogs = async (res: http.ServerResponse, params: URLSearchParams): Promise<void> => {
		const json = (status: number, body: Record<string, unknown>): void => {
			if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		const job = params.get("job") ?? "";
		const hostName = params.get("host") ?? "";
		const offset = Math.max(0, Math.floor(Number(params.get("offset")) || 0));
		// STRICT validation before anything else: this endpoint shells ssh and the dash can sit
		// behind an ngrok tunnel, so both identifiers are checked against fixed shapes — the
		// job against the registry's own id alphabet, the host against the pinned inventory.
		if (!LOG_JOB_RE.test(job)) return json(400, { error: `bad job id ${JSON.stringify(job)}` });
		// Same idiom as the polling/collecting flags, per (host, job): a slow ssh must not
		// stack a second ssh behind it because the page's poll cadence outpaced it.
		const guard = `${hostName}:${job}`;
		if (logsInflight.has(guard)) return json(429, { error: "a read for this job is already in flight" });
		logsInflight.add(guard);
		try {
			const { loadHosts } = await import("../remote/control/hosts.js");
			const host = loadHosts().hosts.find((h) => h.name === hostName);
			if (!host) return json(400, { error: `unknown host ${JSON.stringify(hostName)}` });
			const tail = (buf: Buffer): Buffer => (offset === 0 && buf.length > LOG_TAIL_BYTES ? buf.subarray(buf.length - LOG_TAIL_BYTES) : buf);

			if (fs.existsSync(jobLogPath(job))) {
				// Local fast path — plain fs, covers pulled/collected runs and a runner on this
				// machine. readLog's default root is the same <dataRoot>/out/jobs tree.
				const local = readLog(job, offset);
				const rec = readLocalJob(job);

				return json(200, {
					jobId: job,
					host: hostName,
					chunkB64: tail(local.bytes).toString("base64"),
					nextOffset: local.nextOffset,
					live: rec?.state === "running" || rec?.state === "queued",
					state: rec?.state ?? "unknown",
					exitCode: rec?.exitCode ?? null,
					...(params.get("meta") === "1" && rec ? { task: rec.task, app: rec.app, kind: rec.kind } : {}),
				});
			}

			const { runSsh, runnerArgv, lastFrame, firstLine } = await import("../remote/control/ssh.js");
			const r = await runSsh(host, runnerArgv("logs", { jobId: job, fromByte: offset }), { timeoutMs: 10_000 });
			const frames = parseLogFrames(r.stdout);
			if (frames.error) return json(502, { error: frames.error });
			if (r.code !== 0 && !r.stdout.trim()) return json(502, { error: firstLine(r.stderr) || `ssh exited ${r.code}` });

			let meta: { task?: string; app?: string; kind?: string } = {};
			if (params.get("meta") === "1") {
				const rec = lastFrame((await runSsh(host, runnerArgv("job", { jobId: job }), { timeoutMs: 10_000 })).stdout)?.job;
				if (rec) meta = { task: rec.task, app: rec.app, kind: rec.kind };
			}

			return json(200, {
				jobId: job,
				host: hostName,
				chunkB64: tail(Buffer.from(frames.chunkB64, "base64")).toString("base64"),
				nextOffset: frames.nextOffset,
				live: frames.state === "running" || frames.state === "queued",
				state: frames.state,
				exitCode: frames.exitCode,
				...meta,
			});
		} catch (e) {
			json(500, { error: (e as Error).message });
		} finally {
			logsInflight.delete(guard);
		}
	};

	const server = http.createServer((req, res) => {
		const url = req.url ?? "/";
		if (url === "/" || url === "/index.html") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(fs.readFileSync(htmlPath));
		} else if (url === "/api/state") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(currentState(), null, "\t"));
		} else if (url.startsWith("/api/detail")) {
			const job = new URL(url, "http://localhost").searchParams.get("job") ?? "";
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(buildDetail(job, manifest)));
		} else if (url.startsWith("/api/logs")) {
			// Async by necessity (ssh); serveLogs answers every path itself, including throws.
			void serveLogs(res, new URL(url, "http://localhost").searchParams);
		} else if (url === "/events") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			res.write(`data: ${JSON.stringify(currentState())}\n\n`);
			clients.add(res);
			req.on("close", () => clients.delete(res));
		} else {
			res.writeHead(404);
			res.end("not found");
		}
	});

	// The peek stream rides a WebSocket on the same port. View-only: inbound text frames are
	// deliberately dropped on the floor (only ping/close are honored), so no viewer — local,
	// LAN, or tunneled through ngrok — can inject input into a machine mid-benchmark.
	server.on("upgrade", async (req, socket: Duplex) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const key = req.headers["sec-websocket-key"];
		if (url.pathname !== "/peek" || typeof key !== "string") {
			socket.destroy();

			return;
		}
		socket.write(wslib.handshakeResponse(key));
		const say = (obj: unknown) => {
			try {
				socket.write(wslib.encodeFrame(Buffer.from(JSON.stringify(obj)), "text"));
			} catch {
				socket.destroy();
			}
		};
		// Resolves fast — no probe inside. A thrown setup error (unreadable hosts file, import
		// failure) must become a close-frame rejection, not an unhandled rejection that kills
		// the dash: the contract is handshake-then-attach-or-reject, always.
		const r = await ensurePeek(url.searchParams.get("host") ?? "").catch((err): EnsureResult => ({ ok: false, error: `peek setup failed — ${String(err).slice(0, 200)}` }));
		if (!r.ok) {
			say({ ev: "error", message: r.error });
			closeSocket(socket, 4400, r.error);

			return;
		}
		// NEVER re-read the global `peek` here: ensurePeek returned THIS socket's session. If a
		// newer peek preempted it during the await, this socket belongs to the loser and must
		// not attach to the winner.
		const session = r.session;
		if (peek !== session) {
			say({ ev: "error", kind: "superseded", message: "superseded by a newer peek" });
			closeSocket(socket, 4409, "superseded by a newer peek");

			return;
		}
		clearTimeout(session.idleTimer);
		session.sockets.add(socket);
		// Late-joiner replay: the most recent status/error frame, then the most recent window
		// frame — a reconnecting client renders correct state before the next live frame.
		if (session.lastStatus) {
			try {
				socket.write(wslib.encodeFrame(session.lastStatus, "text"));
			} catch {
				socket.destroy();
			}
		}
		if (session.lastWindow) {
			try {
				socket.write(wslib.encodeFrame(session.lastWindow, "text"));
			} catch {
				socket.destroy();
			}
		}
		const decoder = new wslib.WsDecoder();
		socket.on("data", (chunk: Buffer) => {
			try {
				for (const frame of decoder.push(chunk)) {
					if (frame.opcode === "close") socket.end();
					else if (frame.opcode === "ping") socket.write(wslib.encodeFrame(frame.payload, "pong"));
					// text frames: dropped — the peek is view-only by construction.
				}
			} catch {
				socket.destroy();
			}
		});
		const gone = () => {
			session.sockets.delete(socket);
			// Last viewer gone: linger briefly (a reload, a tab hop), then drop the engine and
			// tunnels — an idle capture stream against a colo Mac serves nobody.
			if (session.sockets.size === 0 && peek === session)
				session.idleTimer = setTimeout(() => {
					if (peek === session && session.sockets.size === 0) teardownPeek(1001, "peek idle — no viewers");
				}, IDLE_TEARDOWN_MS);
		};
		socket.on("close", gone);
		socket.on("error", gone);
	});

	// Listen errors (EADDRINUSE above all) must reject rather than crash the process later:
	// the Electron shell catches "port taken" and attaches its window to the dash already
	// serving there instead of dying.
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, () => {
			server.removeListener("error", reject);
			console.log(`bench dash: http://localhost:${port}  (date ${date}, fleet poll ${FLEET_POLL_SEC}s, ${autoCollect ? `auto-collect ${COLLECT_SEC}s` : "collect OFF — pure reader"})`);
			resolve();
		});
	});

	// Orphaned ssh tunnels outlive a dead parent silently — kill them with the process. The
	// signal handlers matter: "exit" does NOT fire on an unhandled SIGTERM/SIGINT, which is
	// exactly how a dash restart (kill + relaunch) leaks its tunnels as stray processes
	// holding live forwards to a colo Mac nobody is watching. The 1001 close frame is what
	// lets the client render "server restarting — reconnecting…" and auto-retry instead of
	// dead-ending on a bare 1006.
	process.on("exit", () => teardownPeek(1001, "dash exiting"));
	for (const sig of ["SIGINT", "SIGTERM"] as const)
		process.on(sig, () => {
			teardownPeek(1001, "dash restarting — reconnect shortly");
			process.exit(0);
		});

	setInterval(() => {
		for (const res of clients) res.write(": ping\n\n");
	}, 25_000);
	setInterval(pollFleet, FLEET_POLL_SEC * 1000);
	void pollFleet();
	if (autoCollect) {
		setInterval(runCollect, COLLECT_SEC * 1000);
		void runCollect();
	}
	// Piggybacks the collect cadence: a tick only calls the model when the collected count
	// moved, so a quiet hour costs nothing.
	setInterval(() => void narrate(), COLLECT_SEC * 1000);
	void narrate();

	return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	startDash(parseDashArgs(process.argv.slice(2))).catch((err) => {
		console.error(`dash failed: ${err}`);
		process.exit(1);
	});
