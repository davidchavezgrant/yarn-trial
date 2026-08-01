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
import { readJob as readLocalJob, readLog } from "../remote/runner/jobs.js";
import { ARCHIVE_DIR, LIVE_DIR, OLD_ARCHIVE_DIR, OLD_LIVE_DIR, RUN_FILES, appSlug, dataRoot, outDir, resolveRunDir, runFile } from "../paths.js";
import { appmapSlug } from "../core/target.js";
import { archiveDirFor } from "./collect.js";
import { estimateCost } from "./cost.js";
import { BENCH_PRIMARY_MODEL, MATRIX, armAppmapSlug, armById, armTitle, flagsLine, perceptionLine, phaseArms, type Arm, type Phase } from "./matrix.js";
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
 *  - the manifest (fs-watched once its directory exists — an external `bench collect`
 *    shows up instantly),
 *  - the fleet (the same `fleetStatus()` ssh fan-out the fleet panel uses, polled),
 *  - `collect()`, OPT-IN via `--collect`. The default posture is a PURE READER (David,
 *    2026-08-01): the runner owns ./out/bench/live — the canonical store, with
 *    ./out/bench/archive as its hard-linked backup — and the dash writes nothing except the
 *    narrator's note (see narrate()). When armed, collect is idempotent and its writes are
 *    atomic BY DESIGN (collect.ts) — a manual collect racing this loop converges on the same
 *    bytes. `--no-collect`, the old opt-out, is still accepted as a harmless no-op.
 *
 * Every dash read of generated data resolves out/bench/live → out/bench/archive → the store's
 * pre-bench homes (out/live, out/archive) → the legacy location (fromStore below; paths.ts's
 * runFile is the same rule specialised to per-run artifacts), so the dash follows the data
 * wherever the writer currently puts it.
 *
 * Everything derived (rollups, cost, judge tallies) reuses the report's own exported math —
 * the dashboard must never disagree with the report over the same manifest.
 */

export interface DashEvent {
	t: string;
	line: string;
	/** The run whose events.jsonl this line was tailed from. Absent on dash-operational lines. */
	runKey?: string;
	/** Where the line came from: "run" = a run folder's event log, "dash" = this process's own ring. */
	source?: "run" | "dash";
}

export interface FleetView {
	rows: FleetRow[];
	/**
	 * When the poll that produced `rows` BEGAN — the snapshot's honest age, not when it landed.
	 * liveFor treats a job's absence from the snapshot as termination only when this postdates
	 * the job's submit; a failed re-poll keeps the old rows AND the old stamp, so staleness
	 * stays visible to that comparison.
	 */
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
	 * answered WITHOUT the job on a poll taken after the submit — unless the host's job
	 * registry says it DIED, in which case failed/crashed/stopped surface pre-collect; the
	 * manifest's own state otherwise (host unreachable, or the snapshot predates the submit).
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
	/** When the run actually began, off the run log's jobTiming — the board's Started column. */
	startedAt?: string;
	endedAt?: string;
	note?: string;
	/**
	 * Explore runs: THIS pass's own stamp numbers. The row aggregates medians across the
	 * arm's passes (multi-pass matrix), so the dropdown needs the per-pass figures here.
	 */
	exploreStamp?: {
		actions?: number;
		controlsSeen?: number;
		controlsActuated?: number;
		controlsDismissed?: number;
		surfaces?: number;
		graphNodes?: number;
		scopeAmbiguities?: number;
	};
}

export interface PassView {
	model: string;
	/** Distinct model ids the collected runs actually recorded — divergence from `model` is a finding. */
	ranModels?: string[];
	submitted: number;
	collected: number;
	successes: number;
	usd: number;
	/**
	 * Runs that actually priced (a card existed, directly or via the default-model fallback).
	 * On the wire so the page's filtered recompute counts what the server counts — tokenless
	 * entries (compiles, refusals) are neither priced nor unpriced, which `collected −
	 * unpriced` cannot express. Optional only for wire-compat with a server that predates it.
	 */
	priced?: number;
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
	/**
	 * Explore arms: stamp + graph numbers as MEDIANS across the arm's collected passes (the
	 * multi-pass matrix runs n>1 explores per arm; see exploreMedians for why not means).
	 * `elapsed` is the first collected pass's display string, not an aggregate.
	 */
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
	/**
	 * Comprehensiveness rank among the SAME target's collected explore passes (1 = biggest
	 * distilled map; rankExplore's ordering). `of` = passes ranked; the page draws no dot at
	 * of 1. Computed server-side so the wire, the page and the tests share one ordering.
	 */
	exploreRank?: { rank: number; of: number };
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
	/** The narrator's newest per-run note (see narrate()). Model-written; verify before quoting. */
	narrative?: Narrative;
	events: DashEvent[];
}

const mean = (xs: number[]): number | undefined => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);

/** Middle value (even n: mean of the two middles) — resists a degenerate outlier where a mean cannot. */
const median = (xs: number[]): number | undefined => {
	if (!xs.length) return undefined;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);

	return s.length % 2 ? s[mid] : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

function liveFor(e: ManifestEntry, fleet: FleetView): Pick<EntryView, "status" | "elapsedSec" | "queuePosition" | "stalled"> {
	const host = fleet.rows.find((r) => r.name === e.host);
	if (host?.jobId === e.jobId)
		return { status: "running", ...(host.elapsedSec !== undefined ? { elapsedSec: host.elapsedSec } : {}), ...(host.stalled ? { stalled: true } : {}) };
	const pos = host?.queue?.findIndex((q) => q.jobId === e.jobId) ?? -1;
	if (pos >= 0) return { status: "queued", queuePosition: pos + 1 };
	// The host answered and doesn't hold the job: it terminated. The host's job registry may
	// still say HOW — a failure must render loudly NOW, not hide behind the same amber
	// "awaiting-collect" as a healthy finish until a collect pass. `orphaned` maps to
	// "crashed", collect's own vocabulary (RunMetrics.failureKind: terminal with no run log,
	// an orphan, or a kill signal); a `done` record genuinely is just waiting for collection.
	if (host?.reachable && host.state !== "unknown") {
		const rec = host.recent?.find((r) => r.jobId === e.jobId);
		if (rec?.state === "failed" || rec?.state === "stopped") return { status: rec.state };
		if (rec?.state === "orphaned") return { status: "crashed" };
		// Absence from the snapshot is evidence of termination ONLY when the snapshot postdates
		// the submit. The manifest reaches the page in ~300ms (fs-watch) while the fleet is
		// polled every FLEET_POLL_SEC, so a fresh submit spends the gap absent from a snapshot
		// that merely predates it — and used to render as amber "awaiting-collect" until the
		// next poll. The registry reads above stay unguarded: they are positive sightings, and
		// a snapshot older than the job cannot contain it. NaN comparisons land on the manifest
		// side, which is the conservative direction — a snapshot of unknown age proves nothing.
		if (!(Date.parse(fleet.polledAt ?? "") >= Date.parse(e.submittedAt))) return { status: e.state };

		return { status: "awaiting-collect" };
	}
	// An unreachable host proves nothing, so the manifest's last-known state stands.

	return { status: e.state };
}

function entryView(e: ManifestEntry, fleet: FleetView): EntryView {
	const m = e.metrics;
	if (e.collected) {
		const cost = m ? estimateCost(m, m.model ?? e.model) : undefined;
		// Field presence is the signal: only explore stamps record these, so task runs never
		// grow a stamp and the page can key "explore run" off exploreStamp existing.
		const stamp = {
			...(m?.exploreActions !== undefined ? { actions: m.exploreActions } : {}),
			...(m?.controlsSeen !== undefined ? { controlsSeen: m.controlsSeen } : {}),
			...(m?.controlsActuated !== undefined ? { controlsActuated: m.controlsActuated } : {}),
			...(m?.controlsDismissed !== undefined ? { controlsDismissed: m.controlsDismissed } : {}),
			...(m?.surfaces !== undefined ? { surfaces: m.surfaces } : {}),
			...(m?.graphNodes !== undefined ? { graphNodes: m.graphNodes } : {}),
			...(m?.scopeAmbiguities !== undefined ? { scopeAmbiguities: m.scopeAmbiguities } : {}),
		};

		return {
			jobId: e.jobId,
			host: e.host,
			submittedAt: e.submittedAt,
			collected: true,
			// With metrics, the run log speaks — failureKind FIRST: grounding-mismatch is the one
			// kind that can sit on a success-true run (the number is real but mislabelled, and
			// collect evicts the row as a non-sample), so the run's own verdict must not paint it
			// green. Explore failures carry NO success/failureKind at all (collect computes
			// neither for explores) — their failure lives in `technical` and the manifest state,
			// which used to be ignored the moment metrics existed: a failed pass rendered as gray
			// Collected after collection. `technical` maps to "crashed", collect's own vocabulary
			// for died-not-measured. WITHOUT metrics (compiles — pure local file transforms), the
			// manifest's own state is the only signal: a REFUSED compile renders Refused.
			status: m
				? (m.failureKind
					?? (m.success === true ? "succeeded"
						: m.success === false ? "failed"
						: e.technical ? "crashed"
						: e.state === "failed" ? "failed"
						: "collected"))
				: (e.state === "failed" ? "refused" : "collected"),
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
			...(m?.startedAt ? { startedAt: m.startedAt } : {}),
			...(m?.endedAt ? { endedAt: m.endedAt } : {}),
			...(e.note ? { note: e.note } : {}),
			...(Object.keys(stamp).length ? { exploreStamp: stamp } : {}),
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
 * than pretend the card was known.
 *
 * Entries with NO token fields at all (compiles, refusals) are excluded from pricing
 * ENTIRELY — `tokenless: true`, never "unpriced": they cost nothing and prove nothing, and
 * counting them as unpriced added phantom "+N?" to the hero for runs that never touched a
 * model. "Unpriced" is reserved for runs that DID spend tokens we could not price.
 */
export function priceWithFallback(e: ManifestEntry, defaultModel?: string): { usd?: number; assumed: boolean; tokenless?: boolean } {
	const m = e.metrics;
	if (!m || (m.inputTokens === undefined && m.outputTokens === undefined && m.cacheReadTokens === undefined && m.cacheCreationTokens === undefined))
		return { assumed: false, tokenless: true };
	const direct = estimateCost(m, m.model ?? e.model);
	if (direct !== undefined) return { usd: direct, assumed: false };
	const assumed = estimateCost(m, e.model ?? defaultModel);

	return assumed !== undefined ? { usd: assumed, assumed: true } : { assumed: false };
}

/**
 * Explore aggregates are MEDIANS across the arm's collected passes: the multi-pass matrix
 * runs n>1 explores per arm, and a mean lets one degenerate pass (an 8-node husk map has
 * happened) drag every column toward it — the median ignores it. Task columns stay MEANS
 * via the report's shared rollup(): parity with the report outranks symmetry here.
 * `elapsed` keeps the first collected pass's stamp verbatim — it is a display string.
 */
function exploreMedians(ms: Array<NonNullable<ManifestEntry["metrics"]>>): NonNullable<PassView["explore"]> {
	const med = (pick: (m: NonNullable<ManifestEntry["metrics"]>) => number | undefined): number | undefined =>
		median(ms.map(pick).filter((n): n is number => n !== undefined));
	const elapsed = ms.find((m) => m.exploreElapsed)?.exploreElapsed;
	const out = {
		actions: med((m) => m.exploreActions),
		controlsActuated: med((m) => m.controlsActuated),
		controlsDismissed: med((m) => m.controlsDismissed),
		controlsSeen: med((m) => m.controlsSeen),
		surfaces: med((m) => m.surfaces),
		graphNodes: med((m) => m.graphNodes),
		graphEdges: med((m) => m.graphEdges),
		scopeAmbiguities: med((m) => m.scopeAmbiguities),
	};

	return {
		...(out.actions !== undefined ? { actions: out.actions } : {}),
		...(elapsed ? { elapsed } : {}),
		...(out.controlsActuated !== undefined ? { controlsActuated: out.controlsActuated } : {}),
		...(out.controlsDismissed !== undefined ? { controlsDismissed: out.controlsDismissed } : {}),
		...(out.controlsSeen !== undefined ? { controlsSeen: out.controlsSeen } : {}),
		...(out.surfaces !== undefined ? { surfaces: out.surfaces } : {}),
		...(out.graphNodes !== undefined ? { graphNodes: out.graphNodes } : {}),
		...(out.graphEdges !== undefined ? { graphEdges: out.graphEdges } : {}),
		...(out.scopeAmbiguities !== undefined ? { scopeAmbiguities: out.scopeAmbiguities } : {}),
	};
}

/**
 * Rank explore passes by distilled-map comprehensiveness: median graphNodes first,
 * tiebreaks surfaces then controlsActuated. `controlsSeen` is deliberately NOT a key — it
 * inflates on repetitive content (one sweep counted 262 seen for 25 actuated). Returns
 * 1-based ranks aligned with input order (1 = most comprehensive); a missing metric sorts
 * below any recorded value.
 */
export function rankExplore(passes: Array<{ graphNodes?: number; surfaces?: number; controlsActuated?: number }>): number[] {
	const v = (n: number | undefined): number => n ?? -1;
	const order = passes
		.map((_, i) => i)
		.sort((a, b) =>
			v(passes[b]!.graphNodes) - v(passes[a]!.graphNodes)
			|| v(passes[b]!.surfaces) - v(passes[a]!.surfaces)
			|| v(passes[b]!.controlsActuated) - v(passes[a]!.controlsActuated));
	const ranks = new Array<number>(passes.length);
	order.forEach((idx, pos) => {
		ranks[idx] = pos + 1;
	});

	return ranks;
}

function passView(arm: Arm, model: string | undefined, entries: ManifestEntry[], fleet: FleetView, defaultModel?: string): PassView {
	const r = rollup(arm, entries);
	const collectedMetrics = r.collected.map((e) => e.metrics).filter((m): m is NonNullable<ManifestEntry["metrics"]> => m !== undefined);

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
		// Tokenless entries (compiles) are neither priced nor unpriced — see priceWithFallback.
		// `priced` rides the wire so the page's target-filtered recompute counts exactly what
		// the server counts (collected − unpriced overcounts by every tokenless compile).
		priced: priced.filter((p) => p.usd !== undefined).length,
		unpriced: priced.filter((p) => p.usd === undefined && !p.tokenless).length,
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
		...(arm.kind === "explore" && collectedMetrics.length ? { explore: exploreMedians(collectedMetrics) } : {}),
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
	/** The run whose landing triggered this note. Absent on events minted before per-run notes. */
	runKey?: string;
	/** How many runs were collected when the note was minted — what "the field to date" meant. */
	collected?: number;
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
 * STORE ADAPTER — every dash read of generated data that is not a per-run artifact routes
 * through here. (Per-run artifacts — run logs, journals, console logs — go through paths.ts's
 * runFile, which applies the identical rule with the pre-consolidation filename mapping.)
 *
 * The runner saves all live data under ./out/bench/live — the dash's canonical READ-ONLY
 * store — with ./out/bench/archive as a hard-linked backup. The next two candidates are the
 * store's pre-bench homes (./out/live, ./out/archive — data landed there the night before the
 * final location was decided), then the legacy out/bench/<date> manifests, then the out root
 * itself. The live-first order is what lets the dash follow the data the day the writer moves
 * it, and what keeps `--date` working against old backups meanwhile.
 *
 * Returns the LAST candidate when the artifact exists nowhere, so error messages and the
 * watcher name where the data is expected to appear rather than where it last wasn't.
 */
export function storeRoot(relParts: string[], outRoot = outDir()): string {
	// The manifest family is keyed by DATE, so `relParts` starts with one and the roots supply
	// everything above it. `out/bench` is the legacy location AND the parent of the two current
	// ones — order matters, not containment: live and archive are tried first, so a date present
	// in both resolves to live.
	const roots = [
		path.join(outRoot, LIVE_DIR),
		path.join(outRoot, ARCHIVE_DIR),
		path.join(outRoot, OLD_LIVE_DIR),
		path.join(outRoot, OLD_ARCHIVE_DIR),
		path.join(outRoot, "bench"),
		outRoot,
	];

	return roots.find((r) => fs.existsSync(path.join(r, ...relParts))) ?? (roots[roots.length - 1] as string);
}

export function fromStore(relParts: string[], outRoot = outDir()): string {
	return path.join(storeRoot(relParts, outRoot), ...relParts);
}

/**
 * The day's manifest from wherever the store holds it. readManifest builds
 * `<root>/<date>/manifest.json`, so it is handed the out-root variant (out/bench/live,
 * out/bench/archive, or plain out) under which that file currently exists.
 */
const readStoredManifest = (date: string): Manifest => readManifest(date, storeRoot([date, "manifest.json"]));

/**
 * The manifest watcher — a self-healing CHAIN of non-recursive fs.watches over the path
 * ancestry from `outRoot` down to the manifest's directory (out → out/bench → out/bench/live
 * → out/bench/live/<date>), all funneling into one `onChange`.
 *
 * Why directories at all: the manifest is replaced atomically (temp + rename), and a rename
 * never fires a change event on the watched file itself — the deepest watcher is the
 * manifest-edit realtime path.
 *
 * Why a chain: wiping the store (`rm -rf out/bench/live` or higher) fires NOTHING on the
 * date-dir watcher — macOS FSEvents is silent when a watched dir's ancestor tree goes — and
 * before this, a wipe reached the browser only on the next 20s poll tick. A non-recursive
 * watcher on an ancestor DOES see its direct child appear or vanish, so whichever ancestor
 * survives the wipe reports it in ~real time. Volume stays low for the same reason: ancestors
 * see direct-child entry churn (run-dir creation), never writes inside run dirs.
 *
 * Why self-healing: the predecessor latched a `watchingManifest` boolean true on first arm
 * and never reset it — no error handler, no existence re-check — so it could watch a ghost
 * forever (and on Linux, where inotify emits 'error' when the watched dir is deleted, an
 * unhandled FSWatcher 'error' crashes the process outright). Here every fired event re-arms
 * the whole chain (a fired ancestor usually means descendants just appeared or vanished),
 * a watcher 'error' closes and drops just that path, and rearm() re-resolves the manifest
 * dir per call — the store root can move under the dash (live → archive fallback), so the
 * chain is never cached.
 *
 * READ-ONLY POSTURE: rearm() only ever OBSERVES — never mkdirs. Creating store directories
 * is the writer's job; until a dir exists its watcher stays unarmed and the caller's
 * poll-cadence rearm keeps probing, so an unwatched gap degrades to poll latency, never to
 * missing data.
 */
export function watchStoreChain(manifestDir: () => string, outRoot: string, onChange: () => void): { rearm: () => void; close: () => void; watching: () => string[] } {
	const watchers = new Map<string, fs.FSWatcher>();

	const chain = (): string[] => {
		const root = path.resolve(outRoot);
		const dirs: string[] = [];
		let dir = path.resolve(manifestDir());
		for (;;) {
			dirs.push(dir);
			if (dir === root) break;
			const parent = path.dirname(dir);
			if (parent === dir) break; // hit the fs root without meeting outRoot — a dir outside the tree still terminates

			dir = parent;
		}

		return dirs;
	};

	const drop = (p: string): void => {
		const w = watchers.get(p);
		if (!w) return;
		watchers.delete(p);
		try {
			w.close();
		} catch {}
	};

	const rearm = (): void => {
		const want = new Set(chain());
		// Drop first — a dir that vanished or fell out of the re-resolved chain gets a fresh
		// watch on recreation. FSEvents happens to survive same-path recreation and inotify
		// does not; relying on either behavior is how the latch bug lasted.
		for (const p of [...watchers.keys()]) if (!want.has(p) || !fs.existsSync(p)) drop(p);
		for (const p of want) {
			if (watchers.has(p) || !fs.existsSync(p)) continue;
			try {
				const w = fs.watch(p, () => {
					// A fired ancestor often means descendants just appeared or vanished —
					// re-arm the gaps before notifying, so the NEXT event comes from the
					// deepest surviving dir instead of waiting on the poll tick.
					rearm();
					onChange();
				});
				w.on("error", () => drop(p));
				watchers.set(p, w);
			} catch {
				// Vanished between the existsSync probe and the watch — the next rearm re-probes.
			}
		}
	};

	rearm();

	return {
		rearm,
		close: (): void => {
			for (const p of [...watchers.keys()]) drop(p);
		},
		watching: (): string[] => [...watchers.keys()],
	};
}

/*
 * Run-folder event logs → the Events card.
 *
 * Every run appends structured lifecycle events to its own <runDir>/events.jsonl (runEvent,
 * src/core/harness/run-events.ts). The dash's own ring only ever held dash-operational lines
 * (collect, narrator, fleet-poll failures), so the feed said nothing about what the RUNS were
 * doing. storeEvents merges the two: tail the newest run dirs' logs, tag each side with its
 * source, and serve one chronological feed. Read-only, like every other dash read of the store.
 */

/** Newest-mtime run dirs scanned per collection — a full drain holds hundreds; the feed needs the live tail. */
const EVENT_SCAN_DIRS = 20;
/** Lines tailed per events.jsonl — an 8-action run writes ~12; explores heartbeat every 10 actions. */
const EVENT_TAIL_LINES = 50;
/**
 * Parsed tails keyed by file path, valid while (mtime, size) hold still. storeEvents runs on
 * every push, so without this each SSE frame re-reads and re-parses up to 20 files that
 * almost never changed. Cleared wholesale when it grows past its bound — eviction bookkeeping
 * is not worth it for a cache this cheap to rebuild.
 */
const eventTailCache = new Map<string, { mtimeMs: number; size: number; events: DashEvent[] }>();

/** One event rendered as a feed line: the kind plus `k=v` pairs, bounded so one huge detail cannot flood the card. */
export function runEventLine(kind: string, detail: unknown): string {
	if (!detail || typeof detail !== "object" || !Object.keys(detail).length) return kind;
	const parts = Object.entries(detail as Record<string, unknown>).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
	const line = `${kind} ${parts.join(" ")}`;

	return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}

/**
 * The merged Events feed: run-folder event logs + the dash's in-memory operational ring.
 *
 * Scans the live store's run dirs newest-mtime first (capped — see EVENT_SCAN_DIRS), tails
 * each events.jsonl, tags those lines source:"run" with their runKey, tags the ring's lines
 * source:"dash", and returns the newest `limit` in CHRONOLOGICAL order — the wire has always
 * been oldest-first (the page reverses for display), and keeping that contract is what lets
 * the page's renderer tolerate both shapes. Torn tail lines (a writer append racing this
 * read) are skipped, same as every jsonl reader here.
 */
export function storeEvents(dashRing: DashEvent[], limit = 200, outRoot = outDir()): DashEvent[] {
	const fromRuns: DashEvent[] = [];
	try {
		const liveRoot = path.join(outRoot, LIVE_DIR);
		const dirs = fs.readdirSync(liveRoot, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => {
				try {
					return { name: d.name, mtimeMs: fs.statSync(path.join(liveRoot, d.name)).mtimeMs };
				} catch {
					return undefined; // raced a delete — skip the dir, keep the scan
				}
			})
			.filter((x): x is { name: string; mtimeMs: number } => x !== undefined)
			.sort((a, b) => b.mtimeMs - a.mtimeMs)
			.slice(0, EVENT_SCAN_DIRS);
		if (eventTailCache.size > 10 * EVENT_SCAN_DIRS) eventTailCache.clear();
		for (const d of dirs) {
			const file = path.join(liveRoot, d.name, RUN_FILES.events);
			let st: fs.Stats;
			try {
				st = fs.statSync(file);
			} catch {
				continue; // most runs predate the event log — no file is the common case
			}
			const cached = eventTailCache.get(file);
			if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
				fromRuns.push(...cached.events);
				continue;
			}
			const parsed: DashEvent[] = [];
			try {
				for (const line of fs.readFileSync(file, "utf8").split("\n").slice(-(EVENT_TAIL_LINES + 1))) {
					if (!line.trim()) continue;
					try {
						const ev = JSON.parse(line);
						if (typeof ev?.t !== "string" || typeof ev?.kind !== "string") continue;
						parsed.push({ t: ev.t, line: runEventLine(ev.kind, ev.detail), runKey: d.name, source: "run" });
					} catch {
						// torn or foreign line — not an event
					}
				}
			} catch {
				continue;
			}
			eventTailCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, events: parsed });
			fromRuns.push(...parsed);
		}
	} catch {
		// No live store yet — the dash ring alone is the feed.
	}

	return [...fromRuns, ...dashRing.map((e) => ({ ...e, source: e.source ?? ("dash" as const) }))]
		.sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0))
		.slice(0, limit)
		.reverse();
}

/** The narrator's event-log filename — the pass-level file beside the manifests AND one per run dir. */
const NARRATIVE_FILE = "narrative.jsonl";

/** Where the narrator's pass-level event log APPENDS: inside the store, by David's explicit exception. */
export const narrativeLogPath = (outRoot?: string): string => path.join(outRoot ?? outDir(), LIVE_DIR, NARRATIVE_FILE);

/** The event log's pre-bench home (out/live/narrative.jsonl) — read-only; appends go above. */
export const legacyNarrativeLogPath = (outRoot?: string): string => path.join(outRoot ?? outDir(), OLD_LIVE_DIR, NARRATIVE_FILE);

/**
 * One narrator note. Notes are PER RUN (David, 2026-08-01): each is minted when its run's
 * collection is detected, reading the ENTIRE state of the live store at that moment — so
 * every note is a point-in-time reflection of the runs finished by then. The same event
 * rides both logs (appendNarrativeEvent); the pass-level shape keeps t/model/text so
 * readPersistedNarrative keeps serving pre-per-run events unchanged.
 */
export interface NarrativeEvent {
	t: string;
	runKey: string;
	armId: string;
	/** Collected-run count at mint time. */
	collectedAtMint: number;
	model: string;
	text: string;
}

/**
 * Append one note to BOTH homes: the run's own folder (out/bench/live/<runKey>/narrative.jsonl
 * — the note is per run, and the run dir is that run's record) and the pass-level log (the
 * findings card's "newest" feed and the re-mint guard's recovery source). Both writes ride
 * David's sanctioned-write exception (2026-08-01): the dash is otherwise a pure reader, but
 * the narrator appends INTO the store — one JSON event per line, append-only, never
 * rewritten, so a reader racing an append at worst sees one torn tail line, which every
 * reader here skips. The mkdirs are defensive: the run dir already exists for any collected
 * run, and the store dir exists once the runner has written anything.
 *
 * resolveRunDir, not runPath: the note is minted AFTER collection, and collect evicts a failed
 * run's directory from live the moment its metrics are banked — a live-only write here would
 * recreate a stub dir for every failed run and strand the note outside its backup. Resolving
 * lands the note in the run's current home: live for successes, the archive copy for evictees.
 */
export function appendNarrativeEvent(ev: NarrativeEvent, outRoot?: string): void {
	const line = `${JSON.stringify(ev)}\n`;
	const runLog = path.join(resolveRunDir(ev.runKey, outRoot ?? outDir()), NARRATIVE_FILE);
	fs.mkdirSync(path.dirname(runLog), { recursive: true });
	fs.appendFileSync(runLog, line);
	const passLog = narrativeLogPath(outRoot);
	fs.mkdirSync(path.dirname(passLog), { recursive: true });
	fs.appendFileSync(passLog, line);
}

/**
 * The runKeys the pass-level log already holds notes for — the narrator's re-mint guard,
 * recovered from DISK at startup (never from memory: a restarted dash must not re-bill the
 * model for runs a previous process already noted). Pre-per-run events carry no runKey and
 * seed nothing, so the first tick after this feature lands backfills a note per collected run.
 */
export function notedRunKeys(outRoot?: string): Set<string> {
	const noted = new Set<string>();
	try {
		for (const line of fs.readFileSync(narrativeLogPath(outRoot), "utf8").split("\n")) {
			try {
				const ev = JSON.parse(line);
				if (typeof ev?.runKey === "string") noted.add(ev.runKey);
			} catch {
				// torn or foreign line — not an event
			}
		}
	} catch {
		// no log yet — nothing noted
	}

	return noted;
}

/** The newest parseable event in one log file — a torn final line (reader racing the append) falls back. */
function lastNarrativeEvent(file: string): Record<string, any> | undefined {
	try {
		const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const ev = JSON.parse(lines[i] as string);
				if (ev?.text && ev?.t) return ev;
			} catch {
				// torn or foreign line — keep walking back
			}
		}
	} catch {
		// this event log does not exist
	}

	return undefined;
}

/**
 * The newest note the narrator has persisted, if any. The live copy used to be in-memory
 * only, so a restarted dash served nothing while every note it had ever minted sat on disk
 * beside the manifest — and a restart into a keyless environment could never re-mint.
 * Canonical event log first, then the pre-bench file (events landed there the night the
 * store lived at out/live), then the legacy narrative.md whose headings narrate() once
 * machine-wrote (`## <ISO> — N collected (<model>)` — parsing the last back is exact).
 */
export function readPersistedNarrative(date: string, outRoot?: string): Narrative | undefined {
	for (const logFile of [narrativeLogPath(outRoot), legacyNarrativeLogPath(outRoot)]) {
		const ev = lastNarrativeEvent(logFile);
		if (!ev) continue;
		// Per-run events add runKey/armId/collectedAtMint; pre-per-run events had date/collected.
		// Both read back through the same t/model/text core the parser has always required.
		const collected = ev.collectedAtMint ?? ev.collected;

		return {
			updatedAt: String(ev.t),
			text: String(ev.text),
			model: String(ev.model ?? "?"),
			...(typeof ev.runKey === "string" ? { runKey: ev.runKey } : {}),
			...(typeof collected === "number" ? { collected } : {}),
		};
	}
	let raw: string;
	try {
		raw = fs.readFileSync(fromStore([date, "narrative.md"], outRoot), "utf8");
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

export function narratorPrompt(
	digest: Record<string, unknown>,
	previous?: string,
	/** Per-run framing: the run whose collection triggered this note, plus its own EntryView numbers. */
	run?: { runKey: string; armId: string; stats?: unknown },
): string {
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
		...(run
			? [
					"",
					`A run just completed: ${run.runKey} (arm ${run.armId}). Given the COMPLETE state below —`,
					"every run finished so far — write the note for THIS run: what it contributes, confirms,",
					"or changes versus its arm and the field to date. ≤5 sentences, numbers-first, plain prose.",
					...(run.stats !== undefined ? ["", "The completed run's own numbers:", JSON.stringify(run.stats, null, 1)] : []),
				]
			: []),
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
	"grounded task": "Explored Task",
	"ungrounded task": "Unexplored Task",
	"human-notes task": "Curated-Recipe Task",
	"vision-map grounded task": "Vision-Map Explored Task",
	"recipe compile": "Recipe Compile",
	"recipe replay": "Recipe Replay",
	"recipe replay (no rescue)": "Recipe Replay (No Rescue)",
};

/**
 * Explore variants name their perception CONDITION ("Element-Only Explore") — a bare
 * "Explore" was redundant with the Task cell, which already reads "Explore" on these rows
 * (David, 2026-08-01). Never the backend: Acts carries that, and folding actuation into
 * the label is how "vision-only explore (AX)" got misread as vision + AX on 2026-07-31.
 * Derived from the dispatch object, same rule as armTitle — new cells name themselves.
 */
function exploreTitle(arm: Arm): string {
	const d = arm.dispatch;
	const base = d.noAx ? "Vision-Only Explore"
		: d.axdomOff && d.noVision ? "Bare-Tree Explore"
		: d.axdomOff ? "No-Sidecar Explore"
		: d.noVision ? "Element-Only Explore"
		: "Baseline Explore";

	return base + (d.url ? " (Web)" : "");
}

function displayTitle(arm: Arm): string {
	if (arm.kind === "explore") return (arm.dispatch.record ? "Filmed " : "") + exploreTitle(arm);
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

	// Rank each target's collected explore passes by map comprehensiveness (rankExplore).
	// Per targetKey, never globally: comparing a web map's node count against the Yarn app's
	// says nothing. The page only colors dots from these ranks.
	const rankGroups = new Map<string, PassView[]>();
	for (const a of arms) {
		if (a.kind !== "explore") continue;
		for (const p of a.passes) if (p.explore) rankGroups.set(a.targetKey, [...(rankGroups.get(a.targetKey) ?? []), p]);
	}
	for (const group of rankGroups.values()) {
		const ranks = rankExplore(group.map((p) => p.explore ?? {}));
		group.forEach((p, i) => {
			p.exploreRank = { rank: ranks[i] as number, of: group.length };
		});
	}

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
			// Same exclusion as passView: a tokenless compile must not surface as "+N?".
			unpriced: priced.filter((p) => p.usd === undefined && !p.tokenless).length,
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
		// -200, matching storeEvents' cap: the caller hands in the ALREADY-merged feed (run
		// events + dash ring), and halving it here would silently drop the older run lines.
		events: events.slice(-200),
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
	/** Where the graph came from — the run dir's own copy, archived arm map, live docs/appmaps, or nothing. */
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
	/**
	 * The narrator's note for THIS run (the run dir's narrative.jsonl, newest event) — the
	 * dropdown renders it beneath the prompt. Named apart from `note`, which is the detail's
	 * own diagnostics string. Model-written; verify before quoting.
	 */
	narratorNote?: { t: string; text: string; model: string };
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
		const runLog = readJsonFile(runFile(e.jobId, RUN_FILES.log, path.join(dataDir, "out")));
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
 * vision-only pass, APPMAP_VARIANT=novision the element-only pass, otherwise the arm's
 * own backend's map.
 */
export function groundingArmId(arm: Arm): string {
	// ONE derivation, not a parallel decision tree. The hand-written version tested
	// APPMAP_VARIANT before axdomOff and short-circuited, so p2-min-context-grounded — which
	// reads yarn.ax.noaxdom.novision — was attributed to p1-explore-no-vision, which writes
	// yarn.ax.novision. The run itself was fine; the dash counted its path against a graph it
	// never read, which is exactly what the traversal-heat comment forbids. It also still named
	// p1-explore-web-cdp, an arm deleted from the matrix.
	//
	// armAppmapSlug already answers "which map file does this arm touch" for BOTH kinds: for an
	// explore arm the one it writes, for a task arm the one it reads. Matching on it cannot
	// disagree with what the run actually loaded.
	const want = armAppmapSlug(arm);

	return phaseArms(1).find((e) => armAppmapSlug(e) === want)?.id ?? "";
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

/**
 * A run's appmap graph: the run directory's OWN copy first, then the bench-archived per-arm
 * copy, then the live docs/appmaps map. Existing maps STAY where they are (David, 2026-08-01)
 * — the run-dir copy applies to new runs whose explore pass filed `appmap.json` beside its
 * run log; everything older is served from its current home by the later candidates.
 */
function resolveGraph(
	entry: ManifestEntry,
	exploreArmId: string,
	app: string,
	benchRoot: string,
	dataDir: string,
): { graph?: DashDetail["graph"]; source?: string } {
	// The run's own copy — explore passes save RUN_FILES.appmapGraph inside their run dir, and
	// runFile walks out/bench/live → out/bench/archive → the pre-bench out/live and out/archive
	// homes. Task runs carry no appmap of their own and fall through to the arm-keyed copies.
	const own = readJsonFile(runFile(entry.jobId, RUN_FILES.appmapGraph, path.join(dataDir, "out")));
	if (own?.nodes) return { graph: shapeGraph(own), source: `${entry.jobId}/${RUN_FILES.appmapGraph} (run dir)` };
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
	// Store-resolved (out/bench/live → out/bench/archive → pre-bench out/live and out/archive
	// → legacy out/bench), off dataDir so tests stay hermetic — this is where archiveDirFor
	// finds the pass-archived appmap graphs.
	const benchRoot = opts.benchRoot ?? fromStore([manifest.date], path.join(dataDir, "out"));
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
		const runLog = readJsonFile(runFile(jobId, RUN_FILES.log, path.join(dataDir, "out")));
		const rawSteps: Array<Record<string, any>> = Array.isArray(runLog?.steps) ? runLog.steps : [];
		if (!runLog) notes.push("run log not on this machine yet — collect pulls it when the run lands");
		if (typeof runLog?.task === "string") task = runLog.task;
		steps = graph ? matchPath(graph, rawSteps) : rawSteps.map((s) => ({ ...stepLabel(s.action ?? {}, s), index: s.index, verified: s.verified === true }));
	}

	const mutatedKeys = [
		...new Set(
			readJournal(runFile(jobId, RUN_FILES.journal, path.join(dataDir, "out")))
				.filter((m) => m.kind === "setting")
				.map((m) => (m as Record<string, any>).settingKey)
				.filter((k): k is string => typeof k === "string"),
		),
	];

	// The run's own narrator note — runFile so archived/legacy homes keep serving old notes.
	const noteEv = lastNarrativeEvent(runFile(jobId, NARRATIVE_FILE, path.join(dataDir, "out")));

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
		...(noteEv ? { narratorNote: { t: String(noteEv.t), text: String(noteEv.text), model: String(noteEv.model ?? "?") } } : {}),
	};
}

/** ---- server ---------------------------------------------------------------------------- */

const FLEET_POLL_SEC = Number(process.env.DASH_FLEET_SEC ?? 20);
const COLLECT_SEC = Number(process.env.DASH_COLLECT_SEC ?? 60);
/**
 * SSE keepalive cadence — a REAL {"ev":"hb"} data frame, not a comment. The old ": ping"
 * comment kept proxies from idling the socket but never fires onmessage, so the page could
 * not tell quiet-healthy from silently dead and its #conn dot lied green over a wedged link.
 * 15s means the page's 45s staleness watchdog trips only after ~3 missed beats — and the
 * beat is independent of the fleet poll, so a hung ssh fan-out never reads as a dead server.
 */
const SSE_HEARTBEAT_MS = 15_000;

/** /api/logs job ids become path segments locally and a spec field remotely — same shape jobs.ts pins. */
// At least one non-dot character: "." and ".." pass the alphabet but are path tricks, not ids.
const LOG_JOB_RE = /^(?!\.+$)[A-Za-z0-9._-]+$/;
/** A first read (offset 0) of a huge log forwards only this much tail — the pane wants recent lines, not 10MB. */
const LOG_TAIL_BYTES = 64 * 1024;

/**
 * The offset-0 tail slice, started on a UTF-8 character boundary. A byte-arithmetic slice
 * can open mid-sequence — on a continuation byte (0b10xxxxxx) — and the pane's streaming
 * TextDecoder would render a replacement char as the log's first visible character. Advance
 * the start past continuation bytes to the next boundary; at most 3 steps, because a valid
 * UTF-8 sequence carries at most 3 continuation bytes — a longer run means the data is not
 * UTF-8, and slicing anywhere in it is equally honest. Skipping forward never corrupts
 * offsets: nextOffset is the file's true offset, independent of how much tail we forward.
 */
export function utf8Tail(buf: Buffer, maxBytes: number): Buffer {
	if (buf.length <= maxBytes) return buf;
	let start = buf.length - maxBytes;
	for (let i = 0; i < 3 && start < buf.length && ((buf[start] as number) & 0xc0) === 0x80; i++) start++;

	return buf.subarray(start);
}

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
	/** Set when --date was passed: pin to it. Absent/false means follow the newest pass. */
	dateExplicit?: boolean;
}

/**
 * The date to watch when none was asked for: the LATEST manifest that exists, else today.
 * A benchmark drains across the UTC midnight rollover, and a dash restarted at 00:10 that
 * silently pointed at a fresh empty manifest — while three Macs kept draining yesterday's —
 * is exactly what happened the first night this ran.
 */
export function defaultDashDate(root?: string): string {
	const outRoot = root ?? outDir();
	// Date-dir discovery sweeps every store location (out/bench/live, out/bench/archive, the
	// pre-bench out/live and out/archive homes, and the legacy out/bench); each candidate date
	// is then judged on the SAME manifest the dash would actually read — fromStore's live-first
	// resolution — so discovery and the later reads can never disagree about which copy counts.
	// The date regex is what keeps the sweep of the legacy root from picking up its own
	// `live`/`archive` children as passes.
	const dates = new Set<string>();
	for (const r of [path.join(outRoot, LIVE_DIR), path.join(outRoot, ARCHIVE_DIR), path.join(outRoot, OLD_LIVE_DIR), path.join(outRoot, OLD_ARCHIVE_DIR), path.join(outRoot, "bench")]) {
		try {
			for (const d of fs.readdirSync(r)) if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.add(d);
		} catch {
			// This store location does not exist yet — fine.
		}
	}
	// Non-empty manifests only: the rollover itself can mint an empty next-day manifest
	// (any collect run after midnight does), and that husk must not outrank the drain.
	const drained = [...dates]
		.filter((d) => {
			try {
				return (JSON.parse(fs.readFileSync(fromStore([d, "manifest.json"], outRoot), "utf8")).entries?.length ?? 0) > 0;
			} catch {
				return false;
			}
		})
		.sort();

	return drained.length ? (drained[drained.length - 1] as string) : utcDate();
}

/** CLI flags shared by the web entry (main below) and the Electron shell (electron/dash.ts). */
export function parseDashArgs(args: string[]): DashOptions {
	const flag = (name: string): string | undefined => {
		const i = args.indexOf(name);

		return i >= 0 ? args[i + 1] : undefined;
	};

	const explicit = flag("--date");

	return {
		port: Number(flag("--port") ?? process.env.DASH_PORT ?? 4642),
		date: explicit ?? defaultDashDate(),
		/**
		 * Whether the operator NAMED a date. Without this the resolved date is indistinguishable
		 * from a chosen one, so a long-lived dash can never safely move: it resolves once at
		 * startup and watches that day forever. On 2026-08-01 four dash processes booted while
		 * the newest non-empty manifest was 2026-07-31 and spent the night on it while the pass
		 * ran under 2026-08-01 — a benchmark that crosses UTC midnight hits this every time.
		 *
		 * An explicit --date is honoured forever; a resolved one is re-resolved as passes land.
		 */
		dateExplicit: explicit !== undefined,
		// READ-ONLY by default (David, 2026-08-01): out/bench/live is the runner's store and the
		// dash is a reader over it — `--collect` arms the collect loop explicitly. The old
		// opt-out `--no-collect` is deliberately still accepted (as a no-op): launchers and
		// muscle memory that pass it must keep meaning what they always meant, a pure reader.
		autoCollect: args.includes("--collect"),
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
	const { port, autoCollect } = opts;
	// Mutable: a dash that did not have its date named follows the newest drained pass, so a
	// benchmark starting after the one it booted on does not leave it watching yesterday.
	let date = opts.date;

	let manifest = readStoredManifest(date);
	let fleet: FleetView = { rows: [] };
	const events: DashEvent[] = [];
	const addEventLater: string[] = [];
	const clients = new Set<http.ServerResponse>();

	/**
	 * What an UNCOLLECTED run will have used — the pass's declared model, not this machine's.
	 *
	 * This used to resolve makeClient() locally, which reads whichever API keys the OPERATOR'S
	 * machine happens to carry. On 2026-08-01 that displayed `claude-fable-5` for a whole
	 * phase-1 pass — the laptop had an Anthropic key and no Azure one — while every Mac was
	 * correctly running azure/gpt-5.6-sol from its own AGENT_MODEL. The runs were right and the
	 * dashboard was wrong, which is the worse way round: it is the thing a human reads.
	 *
	 * The pass declares its model now (BENCH_PRIMARY_MODEL, stamped onto every dispatch), so the
	 * hint comes from the same place the runs do. A collected run's own log still wins in the UI
	 * — that is the only true answer — and this is only what to show before one exists.
	 */
	let defaultModel: string | undefined = BENCH_PRIMARY_MODEL;
	try {
		const local = (await import("../core/harness/model.js")).makeClient().model;
		// Say so when they disagree rather than silently preferring either: a mismatch means
		// anything run LOCALLY (the offline judge, a hand-started run) is on a different model
		// from the fleet, which is worth knowing before comparing their numbers.
		if (local !== defaultModel) addEventLater.push(`note: this machine's default model is ${local}, the pass runs ${defaultModel}`);
	} catch {
		// No usable key here — the pass's declared model stands on its own.
	}

	for (const line of addEventLater) events.push({ t: new Date().toISOString(), line });

	const addEvent = (line: string): void => {
		events.push({ t: new Date().toISOString(), line });
		if (events.length > 200) events.shift();
	};

	// Seeded from disk so a restart does not lose the newest note: narrate() persists every
	// mint to the event logs, and the re-mint guard below recovers from the same file — a
	// restarted keyed process picks up where the last one stopped instead of re-minting.
	// Seed the persisted note ONLY when this pass actually has collected data. The read
	// chain deliberately walks historical homes, so an empty fresh store would otherwise
	// resurrect a previous pass's conclusions into a board showing zero collected runs —
	// exactly what happened the night of the store move. Mid-drain restarts still seed.
	let narrative: Narrative | undefined = manifest.entries.some((e) => e.collected) ? readPersistedNarrative(date) : undefined;

	// The ONE state builder for anything a client can receive. `narrative` used to be attached
	// only inside push(), so GET /api/state and the initial /events frame omitted it — a page
	// that connected after the note was minted showed nothing until an unrelated push came by.
	// The Events feed is the run folders' event logs merged with the dash's own ring —
	// recomputed per push (mtime-cached tails, see storeEvents), so run events reach the page
	// on the same cadence as everything else without any new watcher.
	const currentState = (): DashState => {
		const state = buildState(manifest, fleet, storeEvents(events), autoCollect, defaultModel);
		if (narrative) state.narrative = narrative;

		return state;
	};

	const push = (): void => {
		const data = `data: ${JSON.stringify(currentState())}\n\n`;
		for (const res of clients) {
			// One torn-down socket must not abort the fan-out for every other viewer (a throw
			// here used to escape pollFleet's tail as an unhandled rejection). The connection's
			// close handler deletes from `clients`; a res that throws before that handler ran
			// is already dead — drop it now rather than retry it every frame.
			try {
				res.write(data);
			} catch {
				clients.delete(res);
			}
		}
	};

	// The narrator, PER RUN (David, 2026-08-01): every newly collected run gets its own note,
	// and each note is written READING the entire current state of the live store — a
	// point-in-time reflection of the runs finished by then. A commentator, not an authority —
	// notes render with a "verify before quoting" sub. The already-noted set recovers from the
	// pass-level log's runKey fields (never from memory), so a restart never re-mints; the
	// writes themselves ride David's sanctioned-write exception (see appendNarrativeEvent).
	// DASH_NARRATE=0 disables; a keyless environment logs one feed line and skips.
	const notedRuns = notedRunKeys();
	let narrating = false;
	let keylessLogged = false;
	const narrate = async (): Promise<void> => {
		if (process.env.DASH_NARRATE === "0" || narrating) return;
		const collected = manifest.entries.filter((e) => e.collected);
		const newly = collected.filter((e) => !notedRuns.has(e.jobId));
		if (!newly.length) return;
		narrating = true;
		try {
			let mc: { client: any; model: string } | undefined;
			try {
				mc = (await import("../core/harness/model.js")).makeClient();
			} catch {
				// One line, once — a keyless dash must not restate this every tick.
				if (!keylessLogged) addEvent(`narrator: no model key — skipping ${newly.length} run note(s)`);
				keylessLogged = true;

				return;
			}
			// ONE state snapshot for the whole batch: a batch collect lands several runs at
			// once, and every note in it must reflect the same post-collect world.
			const state = buildState(manifest, fleet, [], autoCollect, defaultModel);
			const digest = narratorDigest(state);
			const entryByJob = new Map(state.arms.flatMap((a) => a.passes.flatMap((p) => p.entries)).map((e) => [e.jobId, e]));
			// Sequential on purpose — one model call at a time, never a parallel spam of the
			// provider; and one run's failed note must not block the rest (its runKey stays
			// un-noted, so the next tick retries it alone).
			for (const e of newly) {
				try {
					const res = await mc.client.messages.create({
						model: mc.model,
						// 4000, not a text-sized budget: reasoning models spend max_tokens on thinking
						// BEFORE the visible text, and 400 was exhausted mid-reason — every tick failed
						// with no text at all. The prompt caps the visible output (~5 sentences), so
						// this ceiling does not bound the note's length.
						max_tokens: 4000,
						messages: [{
							role: "user",
							content: narratorPrompt(digest, undefined, { runKey: e.jobId, armId: e.armId, stats: entryByJob.get(e.jobId) }),
						}],
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
					const ev: NarrativeEvent = {
						t: new Date().toISOString(),
						runKey: e.jobId,
						armId: e.armId,
						collectedAtMint: collected.length,
						model: mc.model,
						text,
					};
					appendNarrativeEvent(ev);
					notedRuns.add(e.jobId);
					// The findings card shows the newest pass-log event; several mints in one
					// tick leave the LAST one appended showing — fine, they share one state.
					narrative = { updatedAt: ev.t, text, model: mc.model, runKey: e.jobId, collected: collected.length };
					addEvent(`narrator: note minted for ${e.jobId} (${collected.length} collected)`);
					push();
				} catch (err) {
					addEvent(`narrator failed for ${e.jobId}: ${(err as Error).message}`);
				}
			}
		} finally {
			narrating = false;
		}
	};

	// A note minted before a wipe must not outlive the store it described — currentState()
	// grafts `narrative` onto every frame, so a stale note survived even browser refreshes.
	// Conservative on purpose: an empty manifest ALONE clears nothing (a fresh empty next-day
	// manifest coexists with yesterday's real narrative log); only manifest and log gone
	// together means the store the note narrated is gone.
	const clearStaleNarrative = (): void => {
		if (narrative && !manifest.entries.length && !fs.existsSync(narrativeLogPath())) narrative = undefined;
	};

	// The manifest watcher chain (watchStoreChain above — the WHY lives on it): directories
	// because the manifest is replaced atomically (temp + rename) and a rename never fires on
	// the watched file itself; a chain up to outDir() because a store wipe is silent on the
	// date-dir watcher and must report from whichever ancestor survives; self-healing because
	// the old single watcher latched a boolean on first arm and a wipe left it watching a
	// ghost until restart. Debounced because one collect pass rewrites the manifest once per
	// entry. rearm() never mkdirs (READ-ONLY posture); pollFleet re-arms on its cadence and
	// re-reads the manifest every tick anyway, so an unwatched gap degrades to poll latency.
	let watchTimer: NodeJS.Timeout | undefined;
	const storeWatch = watchStoreChain(
		// The LIVE ancestry, deterministically — NOT fromStore's resolution. fromStore falls
		// back by existence, so on an empty store it resolves to the legacy plain-out layout
		// and the chain would watch a phantom ancestry while writers recreate out/bench/live
		// (measured: a recreated store rode the 20s poll because out/bench was unwatched).
		// Watch where data APPEARS — live is the writers' canonical target; archive and the
		// legacy roots are read-side fallbacks, and reads still resolve via fromStore.
		() => path.join(outDir(), LIVE_DIR, date),
		outDir(),
		() => {
			clearTimeout(watchTimer);
			watchTimer = setTimeout(() => {
				manifest = readStoredManifest(date);
				clearStaleNarrative();
				push();
			}, 300);
		},
	);

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
			// A run IS a directory under out/bench/live now, so "what is this laptop doing" reads the
			// directory names directly instead of stripping suffixes off whichever file happened
			// to be touched most recently.
			const liveDir = path.join(dataRoot(), "out", LIVE_DIR);
			const now = Date.now();
			const fresh = fs.readdirSync(liveDir, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => ({ f: d.name, st: fs.statSync(path.join(liveDir, d.name)) }))
				.filter((e) => now - e.st.mtimeMs < 15 * 60 * 1000)
				.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)[0];
			if (fresh) {
				jobId = fresh.f;
				// Stems read `[explore-]<stamp>-<app-slug>` — the slug is the best-effort app.
				app = /^(?:explore-)?\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-(.+)$/.exec(jobId)?.[1];
				// birthtime is 0 on filesystems that do not track it — fall back to mtime.
				elapsedSec = Math.max(0, Math.round((now - (fresh.st.birthtimeMs || fresh.st.mtimeMs)) / 1000));
			}
		} catch {
			// No artifacts yet (or out/bench/live missing) — the row still reports a busy laptop.
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
		// Stamped BEFORE the ssh fan-out: liveFor compares this against submittedAt to decide
		// whether a job's absence from the snapshot means anything, and the snapshot's contents
		// are no fresher than the moment the poll began. Stamping at completion would claim the
		// round trip's worth of freshness the data does not have.
		const polledAt = new Date().toISOString();
		try {
			const rows = await fleetStatus();
			const local = await localRunRow();
			fleet = { rows: local ? [local, ...rows] : rows, polledAt };
		} catch (e) {
			fleet = { ...fleet, error: (e as Error).message };
			addEvent(`fleet poll failed: ${(e as Error).message}`);
		} finally {
			polling = false;
		}
		// This tail sat OUTSIDE the try above, so a throw from state-building or a client
		// write escaped the interval callback as an unhandled rejection — while the SSE
		// heartbeat kept flowing, which is what made the wedge invisible from the browser.
		// Failures land in the events ring instead.
		try {
			storeWatch.rearm(); // the cheap existence probe that replaces the startup mkdir
			/**
			 * Follow the newest pass, unless the operator named a date.
			 *
			 * The date used to be resolved once in parseDashArgs and closed over forever, so a
			 * dash outlived the pass it booted on: four instances started while 2026-07-31 was
			 * the newest non-empty manifest and stayed there while the live pass ran under
			 * 2026-08-01. Any benchmark crossing UTC midnight reproduces it.
			 *
			 * Only ever moves to a date that HAS a non-empty manifest — defaultDashDate's own
			 * rule — so an empty next-day husk minted by a post-midnight collect cannot pull the
			 * view off a pass that is still draining.
			 */
			if (!opts.dateExplicit) {
				const newest = defaultDashDate();
				if (newest !== date) {
					addEvent(`following the newer pass: ${date} -> ${newest}`);
					date = newest;
				}
			}
			manifest = readStoredManifest(date);
			clearStaleNarrative();
			push();
		} catch (e) {
			addEvent(`dash refresh failed: ${(e as Error).message}`);
		}
	};

	// Collect loop — the "results come in" mechanism, OPT-IN via --collect. In the default
	// reader posture the loop is not constructed at all: collect() writes manifests, and the
	// dash's only permitted write is the narrator's note. When armed it is idempotent by
	// design (collect.ts), so racing a manual `bench collect` converges. Skipped while
	// nothing is uncollected.
	let collecting = false;
	const runCollect = !autoCollect
		? undefined
		: async (): Promise<void> => {
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
				manifest = readStoredManifest(date);
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
	 * ONLY on 30s zero-viewer idle or process exit.
	 *
	 * View-only is structural: the viewer's messages are never forwarded to the engine, so a
	 * stray click cannot corrupt a live benchmark run. One session PER HOST, hosts concurrent —
	 * the always-on preview wall. Sessions are fully independent (own tunnels, engine, sockets,
	 * timers, ensure chain); a same-host ensure joins the live session, and nothing preempts
	 * across hosts — the old cross-host 4409 "superseded" close is gone. Each tunnel binds an
	 * EPHEMERAL local port, so concurrent sessions — and anything on the laptop: a stale
	 * ControlMaster forward, a local debug-flagged Chrome, another dash — can never collide.
	 *
	 * Event-feed discipline: attach, first stream, and teardown log once per host session;
	 * re-probes, re-attaches and tunnel churn stay off the feed (viewers still see them as
	 * status frames) — three always-on streams would otherwise drown the collect log.
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
	// peek-prep budget: ensureBrowserEndpoint may quit a flagless Chrome and wait out its
	// relaunch poll (LAUNCH_TIMEOUT_MS = 20s in electron-attach), so the fleet's 4s default
	// would kill every repair mid-flight and report nothing.
	const PEEK_PREP_TIMEOUT_MS = 30_000;

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
		/** First successful attach already hit the event feed — later re-attaches stay quiet. */
		streamLogged: boolean;
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
		/**
		 * How teardown closed this session — recorded BEFORE its sockets die, so an upgrade
		 * that resolved ensurePeek in the same window can replay the same code to its late
		 * socket. This is what lets the race check tell an idle teardown (1001, retryable —
		 * the armed client re-ensures while the host stays busy) from a genuine same-host
		 * supersede (4409, fatal).
		 */
		closedWith?: { code: number; reason: string };
	}
	// One live session per host, all hosts concurrently — the preview wall's server half.
	// "Is p still current?" is always `peeks.get(p.host) === p`, never identity against a slot.
	const peeks = new Map<string, Peek>();
	// Serializes ensurePeek PER HOST — without it two racing upgrades for the same host
	// interleave one session's teardown with another's construction (the strand/demolish
	// races). Per host, not global: three hosts' ensures are independent and must not queue
	// behind each other. Bounded by the pinned inventory, so entries are never evicted.
	const ensureChains = new Map<string, Promise<unknown>>();

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

	const teardownPeek = (host: string, code = 1001, reason = "view closed"): void => {
		const p = peeks.get(host);
		if (!p) return;
		peeks.delete(host);
		p.closing = true; // BEFORE killing tunnels, so their exit handlers don't respawn
		p.closedWith = { code, reason }; // BEFORE sockets die — the upgrade race check reads it
		clearTimeout(p.idleTimer);
		clearTimeout(p.reprobeTimer);
		clearTimeout(p.heartbeatTimer);
		for (const t of p.respawnTimers) clearTimeout(t);
		p.engine?.close();
		p.engine = undefined;
		// These are real non-mux clients (tunnelArgv orders its own mux-off options first),
		// so SIGTERM actually closes the forwards.
		for (const t of p.tunnels) t?.kill("SIGTERM");
		for (const s of p.sockets) closeSocket(s, code, reason);
		addEvent(`view: closed (${p.host}) — ${reason}`);
	};

	/** Process exit path: every live session's tunnels/engines/sockets go down together. */
	const teardownAllPeeks = (code: number, reason: string): void => {
		for (const host of [...peeks.keys()]) teardownPeek(host, code, reason);
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
		// tunnelArgv emits its own anti-mux options ahead of the base block — no overrides needed here.
		const child = spawn("ssh", tunnelArgv(p.hostCfg, remote, local), { stdio: "ignore" });
		p.tunnels[slot] = child;
		// ONE downed-tunnel path for both signals: 'exit' (the tunnel died) and 'error' (spawn
		// itself failed — ENOENT et al. never fires 'exit', and an unlistened ChildProcess
		// 'error' is an uncaught exception that takes the whole dash down). Some failure modes
		// fire both for one child, so the guard makes the respawn single-shot.
		let handled = false;
		const down = (what: string): void => {
			if (handled) return;
			handled = true;
			if (p.closing || peeks.get(p.host) !== p) return; // teardown killed it — expected
			// Viewers learn via the status frame; the event feed does NOT — tunnel churn across
			// three always-on sessions would drown it (attach/first-stream/teardown only).
			p.lastStatus = castJson(p, { ev: "error", kind: "tunnel-died", message: `ssh tunnel for :${remote} on ${p.host} ${what} — respawning` });
			const n = Math.min(p.respawnCounts[slot], TUNNEL_RESPAWN_MS.length - 1);
			p.respawnCounts[slot]++;
			p.respawnTimers[slot] = setTimeout(() => {
				void (async () => {
					if (p.closing || peeks.get(p.host) !== p) return;
					// FRESH ephemeral port — never rebind the old one (TOCTOU: anything may
					// have grabbed it between the tunnel dying and this respawn firing).
					p.locals[slot] = { remote, local: await freeLocalPort() };
					if (p.closing || peeks.get(p.host) !== p) return;
					spawnTunnel(p, slot, tunnelArgv);
				})();
			}, TUNNEL_RESPAWN_MS[n]);
		};
		child.once("exit", () => down("dropped"));
		child.once("error", (err) => down(`failed to spawn (${String((err as NodeJS.ErrnoException).code ?? err).slice(0, 40)})`));
	};
	// A dead endpoint tunnel also kills the CDP websocket riding it, so the engine fires
	// onExit → the waiting/reprobe loop picks up the respawned tunnel's new local port
	// automatically. No extra wiring needed; the composition is the design.

	const probeOnce = async (p: Peek): Promise<{ endpoint: string; browserEndpoint: string; slot: number } | undefined> => {
		// Probe slot 0 (app :9222) first; the first answering local port is primary. WHICH slot
		// answered travels with the result — primary semantics depend on it (tryConnect).
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
				return { endpoint: `http://127.0.0.1:${p.locals[slot].local}`, browserEndpoint: `http://127.0.0.1:${other}`, slot };
			}
		}

		return undefined;
	};

	const tryConnect = async (p: Peek, eps: { endpoint: string; browserEndpoint: string; slot: number }): Promise<boolean> => {
		const { connectCdpEngine } = await import("../remote/liveview-cdp.js");
		// idleNeverStreams: the wall is VIEW-ONLY, so a parked New Tab becoming the last page
		// standing (profile swap bounces the app between jobs) must show a spinner, not stream
		// Chrome's Google-lookalike New Tab as if the run had wandered off (2026-08-01).
		// preExistingParked when the WEB leg (slot 1) answered first: its pre-existing pages are
		// residue from earlier runs — mac3's leftover Notion tab streamed into the wall as if it
		// were the run (2026-08-01). The app leg (slot 0) keeps full-live semantics: an Electron
		// window that exists is exactly the thing to stream.
		const engine = await connectCdpEngine({
			endpoint: eps.endpoint,
			browserEndpoint: eps.browserEndpoint,
			quality: 80,
			maxWidth: 1600,
			app: p.host,
			idleNeverStreams: true,
			preExistingParked: eps.slot === 1,
		});
		if (peeks.get(p.host) !== p || p.closing) {
			engine.close();

			return false;
		}
		p.gotFrame = false;
		p.engine = engine;
		engine.onFrame((jpeg) => {
			if (peeks.get(p.host) !== p || p.engine !== engine) return;
			if (!p.gotFrame) {
				// The FIRST frame is what flips the panel to "streaming" — never the attach. An
				// alive engine can be deliberately showing nothing (gate-refused residue), and a
				// "streaming" status without frames leaves viewers a spinner labeled as a stream.
				p.gotFrame = true;
				setStatus(p, "streaming", `streaming ${p.host}`);
				// First stream only: an always-armed session re-attaches every time a run's
				// Chrome comes and goes, and per-re-attach lines would flood the feed.
				if (!p.streamLogged) {
					p.streamLogged = true;
					addEvent(`view: streaming ${p.host} via ${eps.endpoint} (+${eps.browserEndpoint})`);
				}
			}
			cast(p, jpeg, "binary");
		});
		engine.onEvent((ev: any) => {
			if (peeks.get(p.host) !== p || p.engine !== engine) return;
			if (ev?.ev === "window") p.lastWindow = castJson(p, ev);
			else castJson(p, ev);
			// Inert-handle detection: connect-time deaths resolve to an engine whose exit NEVER
			// fires; the only signal is this first buffered error event. Treat it as a failed
			// attach. idle-parked is deliberately NOT here — a gate-refused connect returns a
			// LIVE engine now, and its refusal event is a waiting state, not a death.
			if (ev?.ev === "error" && !p.gotFrame && (ev.kind === "cdp-unreachable" || ev.kind === "no-page" || ev.kind === "capture-failed")) {
				engine.close();
				if (p.engine === engine) p.engine = undefined;
				enterWaiting(p, `attach failed (${ev.kind}) — waiting for a debuggable target on ${p.host}`);
			}
		});
		engine.onExit(() => {
			if (peeks.get(p.host) !== p || p.engine !== engine) return; // stale corpse callback — ignore
			p.engine = undefined;
			p.lastStatus = castJson(p, { ev: "error", kind: "stream-ended", message: "target closed — waiting for it to come back" });
			enterWaiting(p, `waiting for a debuggable target on ${p.host}`);
		});
		// Registration may have killed the engine SYNCHRONOUSLY (a connect-time death drains its
		// buffered error into the onEvent branch above, and onExit fires immediately off the
		// exited flag) — then enterWaiting already owns this session and stamping a status here
		// would overwrite it. Only a still-alive engine gets the honest attach status; the flip
		// to "streaming" belongs to the first frame alone.
		if (peeks.get(p.host) === p && p.engine === engine) {
			setStatus(p, "waiting", `attached to ${p.host} — waiting for content`);
		}
		// True in BOTH cases — alive (the engine's own page watchers + secondary re-probe drive
		// recovery: while p.engine is set, reprobeTick early-returns) and dead-at-registration
		// (enterWaiting armed the dash's own re-probe). Either way responsibility is handed off,
		// and the caller's attach loop must not keep double-driving alongside it.

		return true;
	};

	const enterWaiting = (p: Peek, message: string): void => {
		if (peeks.get(p.host) !== p || p.closing) return;
		setStatus(p, "waiting", message);
		clearTimeout(p.reprobeTimer);
		p.reprobeTimer = setTimeout(() => {
			void reprobeTick(p);
		}, WAIT_REPROBE_MS);
	};

	const reprobeTick = async (p: Peek): Promise<void> => {
		try {
			if (peeks.get(p.host) !== p || p.closing || p.engine) return;
			const eps = await probeOnce(p);
			if (peeks.get(p.host) !== p || p.closing) return;
			if (eps && (await tryConnect(p, eps))) return;
			if (peeks.get(p.host) !== p || p.closing || p.engine) return;
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
			while (peeks.get(p.host) === p && !p.closing && Date.now() < deadline) {
				const eps = await probeOnce(p);
				if (peeks.get(p.host) !== p || p.closing) return;
				if (eps && (await tryConnect(p, eps))) return;
				if (peeks.get(p.host) !== p || p.closing || p.engine) return;
				await sleep(PROBE_STEP_MS);
			}
			if (peeks.get(p.host) !== p || p.closing || p.engine) return;
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

	// `fatal` classifies the failure for the close code: true = the INPUT is bad (unknown
	// host, bad params — retrying the same request cannot help; 4400), false = a transient
	// setup failure (hosts-file read hiccup, import/spawn race; 1011, the client's armed
	// backoff keeps trying while the host is busy).
	type EnsureResult = { ok: true; session: Peek } | { ok: false; error: string; fatal: boolean };
	const ensurePeek = (hostName: string): Promise<EnsureResult> => {
		const chain = ensureChains.get(hostName) ?? Promise.resolve();
		const r = chain.then(() => doEnsurePeek(hostName), () => doEnsurePeek(hostName));
		ensureChains.set(hostName, r.catch(() => {}));

		return r;
	};

	const doEnsurePeek = async (hostName: string): Promise<EnsureResult> => {
		// FAST PATH: same host joins the live session regardless of engine liveness or state —
		// the attach loop owns recovery for the session's entire life, and a joining socket
		// learns the current state from the late-joiner replay. Other hosts' sessions are
		// invisible here: sessions coexist per host, nothing preempts.
		const existing = peeks.get(hostName);
		if (existing) return { ok: true, session: existing };
		const [{ loadHosts }, { tunnelArgv }] = await Promise.all([import("../remote/control/hosts.js"), import("../remote/control/ssh.js")]);
		const host = loadHosts().hosts.find((h) => h.name === hostName);
		if (!host) return { ok: false, error: `unknown host ${JSON.stringify(hostName)}`, fatal: true };

		// Each remote debug port tunnels to a FRESH ephemeral local port. The old fixed
		// 9222/9777 local bindings needed a squatter-refusal check and a wait-for-release loop
		// after teardown (our own dying ssh held the port); both are obsolete with ephemeral
		// ports and were deleted — nothing else can be listening on a port the OS just minted,
		// which is also what lets three hosts' tunnel pairs coexist on one laptop.
		const locals: Array<{ remote: number; local: number }> = [];
		for (const remote of PEEK_PORTS) locals.push({ remote, local: await freeLocalPort() });

		const p: Peek = { host: hostName, hostCfg: host, locals, tunnels: [], respawnCounts: [0, 0], respawnTimers: [], gotFrame: false, streamLogged: false, state: "probing", sockets: new Set(), closing: false };
		peeks.set(hostName, p);
		addEvent(`view: attach ${hostName}`);
		// No await from here to attachLoop: the caller's socket must attach before any engine
		// event can fire (the buffered-inert-error-to-zero-sockets bug, fixed structurally —
		// attach is fully asynchronous and this function never probes or connects).
		spawnTunnel(p, 0, tunnelArgv);
		spawnTunnel(p, 1, tunnelArgv);
		p.heartbeatTimer = setInterval(() => castJson(p, { ev: "ping" }), HEARTBEAT_MS);
		setStatus(p, "probing", `connecting — opening ssh tunnels to ${hostName}…`);
		void attachLoop(p); // detached — the upgrade handler must NOT wait for attach
		// Detached repair of the browser leg: a peek is runner-less by design, so it inherits
		// whatever endpoint state the last run or liveview left on the Mac. The one state the
		// re-probe loop can never wait out is a flagless Chrome — no later flagged launch can
		// open the port (the singleton swallows the argv and exits), so an idle host's peek
		// stays "waiting" until a human intervenes (mac1, 2026-08-01: flagless for days). The
		// runner's peek-prep verb prunes and relaunches it flagged when the host is idle, and
		// touches nothing when a job holds the lease — the run owns the endpoints then. Once
		// per session, not per re-probe: the 3s reprobe attaches as soon as the port appears.
		// Failure is the status quo the session already handles (keep waiting), so it logs at
		// most one feed line; an un-provisioned runnerctl rejects the verb on stderr with
		// nothing on stdout, which reads as "no frame" and stays quiet by construction.
		void (async () => {
			try {
				const { runSsh, runnerArgv, lastFrame } = await import("../remote/control/ssh.js");
				const frame = lastFrame((await runSsh(host, runnerArgv("peek-prep"), { timeoutMs: PEEK_PREP_TIMEOUT_MS })).stdout);
				if (peeks.get(hostName) !== p || p.closing) return;
				if (frame?.relaunched) addEvent(`view: ${hostName}'s Chrome was running without the debug flag — relaunched flagged`);
				else if (frame?.ok === false) addEvent(`view: endpoint prep on ${hostName} refused — ${String(frame.error).slice(0, 120)}`);
			} catch {
				// ssh itself failed; the fleet poll already reports unreachable hosts.
			}
		})();

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
	 * Local first: a pulled/collected run's log already sits on disk — out/bench/live/<job>/log.txt
	 * canonically, out/bench/archive, the pre-bench out/live and out/archive homes, or the
	 * legacy out/jobs tree for older runs (runFile resolves) —
	 * and needs no ssh (job.json beside it answers what meta=1 would have asked the
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
			// utf8Tail, not a bare subarray: the arithmetic start can land mid-character.
			const tail = (buf: Buffer): Buffer => (offset === 0 ? utf8Tail(buf, LOG_TAIL_BYTES) : buf);

			// The local fast path answers BEFORE host validation: it shells nothing, and the
			// synthetic "local" fleet row (plus pulled runs queried with a stale host) would
			// otherwise 400 on inventory lookup while the log sits right here on disk.
			//
			// runFile resolves the console log live → archive → legacy out/jobs/<id>/log.txt
			// (runs pulled before the 2026-08-01 consolidation must stay readable), and all
			// three locations share the `<root>/<id>/log.txt` shape — so the resolved file's
			// grandparent IS the root the jobs.ts readers need, and job.json sits beside the
			// log in every layout.
			const localLog = runFile(job, RUN_FILES.console);
			if (fs.existsSync(localLog)) {
				const localRoot = path.dirname(path.dirname(localLog));
				const local = readLog(job, offset, localRoot);
				const rec = readLocalJob(job, localRoot);

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

			// Remote path only from here — NOW the host must be in the pinned inventory
			// (this is the branch that shells ssh).
			const { loadHosts } = await import("../remote/control/hosts.js");
			const host = loadHosts().hosts.find((h) => h.name === hostName);
			if (!host) return json(400, { error: `unknown host ${JSON.stringify(hostName)}` });

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
		// the dash: the contract is handshake-then-attach-or-reject, always. Thrown errors are
		// TRANSIENT by classification — a one-off fs/spawn hiccup must not close 4400 and
		// disarm the client for the rest of the run; only doEnsurePeek's own verdict on the
		// input (unknown host) is fatal.
		const r = await ensurePeek(url.searchParams.get("host") ?? "").catch((err): EnsureResult => ({ ok: false, error: `view setup failed — ${String(err).slice(0, 200)}`, fatal: false }));
		if (!r.ok) {
			say({ ev: "error", message: r.error });
			// 4400 strictly for bad input; 1011 (retryable) for transient setup failures.
			closeSocket(socket, r.fatal ? 4400 : 1011, r.error);

			return;
		}
		// NEVER re-resolve the host's session here: ensurePeek returned THIS socket's session.
		// If a teardown raced the await (idle reaper, process exit), this socket belongs to a
		// corpse and must not attach to whatever replaces it. Close with the SAME code the
		// teardown used on its live sockets — an idle/exit teardown is 1001-class (retryable;
		// the armed client backs off and re-ensures while the host is still busy). 4409 is
		// reserved STRICTLY for a genuine same-host supersede: a session replaced without a
		// recorded teardown, which no current call site produces — the fallback keeps the
		// reservation honest if one ever does.
		const session = r.session;
		if (peeks.get(session.host) !== session) {
			const { code, reason } = session.closedWith ?? { code: 4409, reason: "superseded by a newer view" };
			say({ ev: "error", ...(code === 4409 ? { kind: "superseded" } : { kind: "session-closed" }), message: reason });
			closeSocket(socket, code, reason);

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
			// tunnels — an idle capture stream against a colo Mac serves nobody. Per host: the
			// wall's other streams keep running.
			if (session.sockets.size === 0 && peeks.get(session.host) === session)
				session.idleTimer = setTimeout(() => {
					if (peeks.get(session.host) === session && session.sockets.size === 0) teardownPeek(session.host, 1001, "view idle — no viewers");
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

	// Orphaned ssh tunnels outlive a dead parent silently — kill them with the process, for
	// EVERY host session at once. The signal handlers matter: "exit" does NOT fire on an
	// unhandled SIGTERM/SIGINT, which is exactly how a dash restart (kill + relaunch) leaks
	// its tunnels as stray processes holding live forwards to colo Macs nobody is watching.
	// The 1001 close frame is what lets the client render "server restarting — reconnecting…"
	// and auto-retry instead of dead-ending on a bare 1006.
	process.on("exit", () => teardownAllPeeks(1001, "dash exiting"));
	for (const sig of ["SIGINT", "SIGTERM"] as const)
		process.on(sig, () => {
			teardownAllPeeks(1001, "dash restarting — reconnect shortly");
			process.exit(0);
		});

	// A data-frame heartbeat, doing double duty: proxy keepalive AND client liveness signal.
	// The page drops {"ev":"hb"} before state handling — see SSE_HEARTBEAT_MS for why this
	// stopped being a ": ping" comment.
	setInterval(() => {
		const beat = `data: {"ev":"hb","t":"${new Date().toISOString()}"}\n\n`;
		for (const res of clients) res.write(beat);
	}, SSE_HEARTBEAT_MS);
	setInterval(pollFleet, FLEET_POLL_SEC * 1000);
	void pollFleet();
	if (runCollect) {
		setInterval(runCollect, COLLECT_SEC * 1000);
		void runCollect();
	}
	// Piggybacks the collect cadence: a tick only calls the model when a run collected that
	// has no note yet, so a quiet hour costs nothing.
	setInterval(() => void narrate(), COLLECT_SEC * 1000);
	void narrate();

	return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	startDash(parseDashArgs(process.argv.slice(2))).catch((err) => {
		console.error(`dash failed: ${err}`);
		process.exit(1);
	});
