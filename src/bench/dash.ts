import { type ChildProcess, execFile, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJournal } from "../core/journal.js";
import { type FleetRow, neverRan } from "../remote/control/fleet.js";
import type { HostEntry, Inventory } from "../remote/control/hosts.js";
import type { EngineHandle } from "../remote/liveview.js";
import { readJob as readLocalJob, readLog } from "../remote/runner/jobs.js";
import { ARCHIVE_DIR, CURSOR_RENDER, LIVE_DIR, OLD_ARCHIVE_DIR, OLD_LIVE_DIR, RUN_FILES, appSlug, dataRoot, outDir, resolveRunDir, runFile } from "../paths.js";
// Byte arithmetic only, from a module that imports nothing — see its header for why it is not
// reached through src/ui/ui-core.ts, which owns the other half of this idiom.
import { parseByteRange } from "../byterange.js";
import { appmapSlug, type Target, targetVocabulary, webTarget } from "../core/target.js";
// Narrow modules, per the harness barrel's own header rule — never the barrel from here.
import { DESCENT_ON } from "../core/explore/config.js";
import { systemPrompt } from "../core/explore/prompt.js";
import { DRIVER_RULES, VISION_ONLY_RULES } from "../core/harness/actions.js";
import { estimateCost } from "./cost.js";
import { BENCH_PRIMARY_MODEL, MATRIX, armAppmapSlug, armById, armTitle, flagsLine, perceptionLine, phaseArms, type Arm, type Phase } from "./matrix.js";
import { archiveDirFor, benchDir, type Manifest, type ManifestEntry, readManifest, utcDate } from "./manifest.js";
// Deliberate call-time cycle: graphs.ts imports this module's exported functions (buildDetail,
// exploreSeries) — safe because both sides only call across the boundary at request time.
import { serveGraphs } from "./graphs.js";
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
	/**
	 * This run's cursor render is on this machine — the board's Take column draws a ▶ when it is.
	 *
	 * On the ENTRY rather than only on the detail (where `DashDetail.video` also carries it),
	 * because the Take column is first-level: it renders for every row on the first paint, and a
	 * column that had to fetch one detail per row to decide whether to draw its own button would
	 * either flash in late or fire ~200 requests to answer a yes/no the state frame can carry in
	 * a byte. The detail keeps its copy for the dropdown's own use.
	 */
	video?: boolean;
	/** Seconds the run has been going (running) or took per its own log (collected). */
	elapsedSec?: number;
	/**
	 * Seconds a NEVER-RAN job spent waiting in a queue before being cancelled. Deliberately
	 * not `elapsedSec`: rollups, cost and every chart key on that field as time spent working,
	 * and inheriting queue time there is exactly the bug this pair exists to end.
	 */
	queuedSec?: number;
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
	 * Results-so-far off the run's OWN event log — the realtime channel for an entry collect
	 * has not banked yet (local file, or ssh-tailed from its fleet host). Provisional by
	 * contract: attached to UNCOLLECTED entries only, gone the moment metrics exist, and
	 * never read by rollups/cost — the page must render it visibly as live, not as a result.
	 */
	live?: RunProgress;
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
	/**
	 * The FILMED runs of this exact config, grafted onto its row for display (David,
	 * 2026-08-03). A filmed take belongs with the config it films — hunting for a
	 * `p5-…-filmed` twin to watch a run you are already looking at is the wrong shape.
	 *
	 * DISPLAY ONLY, and deliberately NOT merged into `entries`. A filmed run is a different
	 * run: `--record` swaps in demo rules and a demo act tool with no `set_value`, so folding
	 * it into this pass's samples would move meanSteps, successes and cost — the board would
	 * then disagree with the report over the same manifest, which is the one thing it may
	 * never do. Everything aggregated reads `entries`; only the row rendering reads this.
	 *
	 * Carries the filmed ARM's id and sample count, not just its runs, so the board can apply the
	 * same retry-pairing rule to these lines as to any others — a technical failure replaced by a
	 * re-dispatch drops its chip, and that rule reads the arm's `n` to know which entries are
	 * replacements. No filmed run in the 2026-08-01 pass is such a replacement, so it changes
	 * nothing today; it is here because the alternative is a rule that holds everywhere on the
	 * board except one kind of line, which is the sort of exception nobody remembers.
	 *
	 * The armId also names the provenance: these lines belong to a different arm than the row
	 * they render in, and a reader clicking one deserves to be told which.
	 */
	filmed?: { armId: string; n: number; entries: EntryView[] };
	/**
	 * Set on a FILMED arm's own pass once its runs were grafted into their config's row: the
	 * board skips this pass rather than drawing a second row for the same footage.
	 *
	 * A flag rather than dropping the pass from the wire, because the page's own aggregates
	 * (hero tiles, cost, the target-filtered recompute) walk every arm's `entries` — removing
	 * the pass would quietly subtract 48 real runs from the published totals. It stays counted
	 * and stops being drawn.
	 */
	graftedInto?: string;
	/** Distinct model ids the collected runs actually recorded — divergence from `model` is a finding. */
	ranModels?: string[];
	submitted: number;
	collected: number;
	successes: number;
	/**
	 * ArmRollup.harnessEnded / ArmRollup.verdictRuns, carried verbatim from the report's own
	 * rollup — the honest success denominator and the count carved out of it.
	 *
	 * On the wire because the board renders a success rate over the SAME manifest the report
	 * tabulates, and the two surfaces may never disagree about it. `successes` keeps the old
	 * meaning (report.ts deliberately did not redefine it, precisely because this file copies
	 * it); every rate on the page divides it by `verdictRuns` instead of `collected`.
	 *
	 * A run the harness ended — the AGENT_STALL_STEPS stall streak, or the AGENT_STEPS runaway
	 * backstop (src/core/agent/run.ts's stopping contract) — is not evidence about the agent, so
	 * it belongs in neither half of a rate. Folded in, one truncated run in a 3-run arm was a
	 * plain zero: a 33-point swing indistinguishable from an agent that could not do the task.
	 * It still counts everywhere else on the board (done, Finished, the failure breakdown, the
	 * outcomes chart's own segment) — the carve-out is only in the rate.
	 */
	harnessEnded: number;
	verdictRuns: number;
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
	replay?: { meanProcedureSteps?: number; meanRescuedSteps?: number };
	entries: EntryView[];
}

export interface ArmView {
	id: string;
	/**
	 * Plain English, derived — "Explored Task" rather than `ax-grounded`. The ids say
	 * nothing about DOM attrs or vision, and `vision-only-grounded-visionmap` is
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
	 * the element channel named per backend (AX vs DOM).
	 */
	perception: string;
	/**
	 * `perception` split into per-channel booleans so the board can render check cells
	 * (AX / DOM / Vision) instead of a constructed phrase. ax = AX elements reach the model;
	 * dom = DOM elements (cdp backend) or the axdom sidecar's DOM attrs (ax backend, off
	 * under AXDOM=0); vision = screenshots (off under --no-vision). Derived from the same
	 * dispatch flags perceptionLine reads — never parsed from the `perception` string.
	 */
	sees: { ax: boolean; dom: boolean; vision: boolean };
	actuation: string;
	/** Task arms: the goal-only prompt the run was given. */
	task?: string;
	/** Web arms: the URL the run pointed at (off the dispatch flags). */
	url?: string;
	/**
	 * Explore arms: the system prompt the pass runs under — reconstructed from the dispatch
	 * flags (explorePrompt below), because no run artifact records it. Absent until the
	 * lazily-loaded CDP_RULES lands (cdp arms, a push or two after start).
	 */
	prompt?: string;
	/**
	 * The phase-1 explore arm whose map this task/replay arm consumed (groundingArmId — the
	 * same resolution orchestrate applies), so the board can nest arms under their lineage.
	 * Absent on ungrounded (NO_GROUNDING) arms and on explore/compile arms. Curated
	 * (USE_CURATED) arms are still grounded — they carry it and nest.
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
	/**
	 * Manifest entries whose armId matches no arm in MATRIX, even after canonicalArmId.
	 *
	 * On the wire because the board CANNOT show them: rows are built from MATRIX, so an entry with
	 * no arm is not degraded, it is absent — and absent is indistinguishable from "never submitted"
	 * on a page that only draws what it can resolve. That is how the stages rename turned the whole
	 * 2026-08-01 pass into an empty board with nothing on screen saying so. A count is the smallest
	 * thing that makes the gap legible; the page prints it in the metaline.
	 *
	 * Absent when zero, so a healthy pass carries no field and the page renders no warning.
	 */
	unmatchedEntries?: number;
	/**
	 * `harnessEnded`/`verdictRuns` are the pass-wide twins of PassView's (see there for why the
	 * rate excludes them): `collected` keeps counting every banked run, and only the rate the
	 * hero tile quotes uses `verdictRuns` as its denominator.
	 */
	progress: { planned: number; submitted: number; collected: number; running: number; queued: number; successes: number; harnessEnded: number; verdictRuns: number };
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
	/**
	 * This board is a FROZEN SNAPSHOT, not a live drain (DashOptions.share). Set so the page can
	 * say so where it otherwise says "live" — the connection badge reports SSE health, and on a
	 * published link a healthy socket must not be mistaken for moving numbers.
	 */
	share?: boolean;
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

export function liveFor(e: ManifestEntry, fleet: FleetView): Pick<EntryView, "status" | "elapsedSec" | "queuedSec" | "queuePosition" | "stalled"> {
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
		/**
		 * A job cancelled while QUEUED never ran, and must not be graded as though it had.
		 *
		 * It gets its own status ahead of every other reading, including `done`: the registry
		 * marks a cancelled-from-the-queue job `stopped`, but one cancelled the moment its
		 * predecessor finished can land as `done` with no work behind it — so five queued
		 * Notion grounding passes cancelled together on 2026-08-03 rendered as four "Crashed
		 * after 1h55m" and one "Finished after 1h55m", the last being a completed grounding
		 * pass on the board that had never started a process.
		 *
		 * `elapsedSec` is deliberately NOT set here. Everything downstream reads it as time
		 * spent working, and this job's only elapsed time is time spent waiting.
		 */
		if (rec && neverRan(rec)) {
			// The wait, reported AS a wait. Named `queuedSec` rather than `elapsedSec` so no
			// existing reader can mistake it for work: rollups, cost and the charts all key on
			// elapsedSec, and this number must never enter any of them.
			const waited = rec.endedAt && rec.queuedAt ? Math.max(0, Math.round((Date.parse(rec.endedAt) - Date.parse(rec.queuedAt)) / 1000)) : undefined;

			return { status: "never-ran", ...(Number.isFinite(waited) ? { queuedSec: waited } : {}) };
		}
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

/**
 * Does this run have a cursor render this dash can serve? One question, one answer, asked by
 * BOTH the board's Take column (through entryView) and the dropdown (through buildDetail), so
 * the column can never offer a ▶ that /api/video would 404 — it is the same resolution the
 * route itself performs.
 *
 * Called per entry per state push, which is a few hundred stats on a local filesystem and
 * nothing next to the run-log reads the same push already does. It stays a live check rather
 * than a cached one because a render APPEARS mid-pass: collect composites on pull, so a row
 * gains its ▶ on the next push and a memo would hold "no" for the rest of the session.
 */
function hasTake(jobId: string, dataDir?: string): boolean {
	return fs.existsSync(path.join(runFile(jobId, RUN_FILES.recording, dataDir ? path.join(dataDir, "out") : undefined), CURSOR_RENDER));
}

function entryView(e: ManifestEntry, fleet: FleetView, live?: Map<string, RunProgress>, defaultModel?: string): EntryView {
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
			...(hasTake(e.jobId) ? { video: true } : {}),
		};
	}

	// Only the uncollected branch carries `live` — a collected entry's real metrics render
	// above, and keeping both would put two answers to "how many steps" on one row.
	let progress = live?.get(e.jobId);
	// Live cost, priced HERE with the same math as collected rows (estimateCost) and the same
	// fallback ladder as priceWithFallback: the run-recorded model first, then a retry at the
	// dispatch/default model when that recorded id has no rate card. Attached as a COPY — the
	// underlying progress objects are cached (progressCache / remoteRuns) and must not grow a
	// price stamped with one entry's model fallbacks. Invariant (RunProgress header): this usd
	// is provisional display only — it never feeds rollup()/cost totals/hero tiles.
	if (progress && (progress.inputTokens !== undefined || progress.outputTokens !== undefined || progress.cacheReadTokens !== undefined || progress.cacheCreationTokens !== undefined)) {
		const usd = estimateCost(progress, progress.model ?? e.model) ?? estimateCost(progress, e.model ?? defaultModel);
		if (usd !== undefined) progress = { ...progress, usd };
	}

	// The take rides the uncollected branch too: a run pulled by hand, or an ad-hoc local run,
	// has its render on disk before any collect pass banks its metrics — and the whole point of
	// the column is to reach the footage, which does not wait on the numbers.
	return { jobId: e.jobId, host: e.host, submittedAt: e.submittedAt, collected: false, ...liveFor(e, fleet), ...(progress ? { live: progress } : {}), ...(hasTake(e.jobId) ? { video: true } : {}) };
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

function passView(arm: Arm, model: string | undefined, entries: ManifestEntry[], fleet: FleetView, defaultModel?: string, live?: Map<string, RunProgress>): PassView {
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
		// Straight off the rollup, never recomputed here: the report and the board must divide
		// the same numerator by the same denominator, and a second implementation of "which
		// failureKinds are the harness's, not the agent's" is how they drift apart.
		harnessEnded: r.harnessEnded,
		verdictRuns: r.verdictRuns,
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
						...(mean(r.collected.map((e) => e.metrics?.procedureSteps).filter((n): n is number => n !== undefined)) !== undefined
							? { meanProcedureSteps: mean(r.collected.map((e) => e.metrics?.procedureSteps).filter((n): n is number => n !== undefined)) }
							: {}),
						...(mean(r.collected.map((e) => e.metrics?.rescuedSteps).filter((n): n is number => n !== undefined)) !== undefined
							? { meanRescuedSteps: mean(r.collected.map((e) => e.metrics?.rescuedSteps).filter((n): n is number => n !== undefined)) }
							: {}),
					},
				}
			: {}),
		entries: entries.map((e) => entryView(e, fleet, live, defaultModel)),
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
 * Retire the manifest's non-terminal states for a SNAPSHOT (share mode only).
 *
 * A live dash resolves "running" against the fleet: liveFor asks the hosts, and an absent job
 * on a fresh-enough poll means it finished. A snapshot has no fleet to ask, so liveFor falls
 * through to the manifest's last-known state — and the 2026-08-01 pass froze with 3 entries
 * mid-run and 33 still queued. Published unchanged, that dash claims three runs are executing
 * right now, forever. The runs are not in an unknown state; they are in a KNOWN one, which is
 * that the pass ended without them, and the display should say so.
 *
 * Uncollected entries only, and `state` only — every number the page and the report share
 * comes from `collected` + `metrics` (rollup reads nothing else), so this can rename a status
 * without moving a single figure. The two names are deliberately outside collect's failure
 * vocabulary: these are not failures anyone diagnosed, and the page renders an unmapped
 * status as a hollow dot, which is the honest shape for "no verdict was ever reached".
 */
export function freezeStates(m: Manifest): Manifest {
	const FROZEN: Record<string, string> = { running: "abandoned", queued: "never-ran" };

	return {
		...m,
		entries: m.entries.map((e) => (!e.collected && FROZEN[e.state] ? { ...e, state: FROZEN[e.state] as string } : e)),
	};
}

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
 * Run keys with an event log this machine can reach, newest first, capped at EVENT_SCAN_DIRS.
 *
 * Live AND the archive, deduped by key, because collect EVICTS a failed run's directory out of
 * live the moment its metrics are banked (collect.ts's evictFailedRun) — and a live-only scan
 * therefore lost exactly the runs whose event trail is most worth reading. For a `stalled` run
 * the heartbeat trail through the dead steps is the primary evidence for WHY nothing verified:
 * whether the app went dark, or the text channel simply could not see legitimate progress. That
 * evidence used to disappear from the Events pane the instant the numbers landed.
 *
 * Live wins on a key present in both: the archive copy is a hard link to the same inode
 * (paths.ts's archiveRun), so it is the same bytes either way, and resolving through the live→
 * archive ladder every other reader uses keeps one answer to "where is this run".
 *
 * Only keys the live scan did NOT already produce are stat'd in the archive, so a long-lived
 * archive (hundreds of dirs, all of them also in live) costs one readdir rather than a second
 * full stat sweep per push.
 */
function eventLogKeys(outRoot: string): string[] {
	const seen = new Map<string, number>();
	for (const root of [path.join(outRoot, LIVE_DIR), path.join(outRoot, ARCHIVE_DIR)]) {
		let names: fs.Dirent[];
		try {
			names = fs.readdirSync(root, { withFileTypes: true });
		} catch {
			continue; // no live store yet, or no backups taken — the other root still counts
		}
		for (const d of names) {
			if (!d.isDirectory() || seen.has(d.name)) continue;
			try {
				seen.set(d.name, fs.statSync(path.join(root, d.name)).mtimeMs);
			} catch {
				// raced a delete (or an eviction) — skip the dir, keep the scan
			}
		}
	}

	return [...seen].sort((a, b) => b[1] - a[1]).slice(0, EVENT_SCAN_DIRS).map(([name]) => name);
}

/**
 * The merged Events feed: run-folder event logs + the dash's in-memory operational ring.
 *
 * Scans the newest run dirs first (capped — see EVENT_SCAN_DIRS and eventLogKeys), tails
 * each events.jsonl, tags those lines source:"run" with their runKey, tags the ring's lines
 * source:"dash", and returns the newest `limit` in CHRONOLOGICAL order — the wire has always
 * been oldest-first (the page reverses for display), and keeping that contract is what lets
 * the page's renderer tolerate both shapes. Torn tail lines (a writer append racing this
 * read) are skipped, same as every jsonl reader here.
 */
export function storeEvents(dashRing: DashEvent[], limit = 200, outRoot = outDir(), extra: DashEvent[] = []): DashEvent[] {
	const fromRuns: DashEvent[] = [];
	try {
		const keys = eventLogKeys(outRoot);
		if (eventTailCache.size > 10 * EVENT_SCAN_DIRS) eventTailCache.clear();
		for (const key of keys) {
			// runFile, not a live path: the same live→archive→pre-`bench/` ladder every other
			// per-run read uses, so an evicted run's log is found where it now lives. The cache
			// keys on the resolved path, so a run moving homes re-reads rather than serving the
			// tail from its old one.
			const file = runFile(key, RUN_FILES.events, outRoot);
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
			let parsed: DashEvent[];
			try {
				// Usage events are a counter channel, not narrative — one per model call would
				// crowd the display tail with counter noise. They render in the metric columns
				// (RunProgress folds them); only the FEED skips them.
				parsed = parseRunEvents(fs.readFileSync(file, "utf8").split("\n").slice(-(EVENT_TAIL_LINES + 1)).join("\n"))
					.filter((ev) => ev.kind !== "usage")
					.map((ev) => ({ t: ev.t, line: runEventLine(ev.kind, ev.detail), runKey: key, source: "run" as const }));
			} catch {
				continue;
			}
			eventTailCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, events: parsed });
			fromRuns.push(...parsed);
		}
	} catch {
		// No store at all yet — the dash ring alone is the feed.
	}

	// `extra` is the remote tails (startDash's ssh fetch of running fleet jobs' event logs) —
	// lines the local scan above cannot see because the files are still on the colo Mac.
	// The fetch loop drops a job's tail the moment its events exist locally (pull landed),
	// so a line never arrives from both sides of this merge.
	return [...fromRuns, ...extra, ...dashRing.map((e) => ({ ...e, source: e.source ?? ("dash" as const) }))]
		.sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0))
		.slice(0, limit)
		.reverse();
}

/* ---- results-so-far: a run's own event log, aggregated while collect has nothing ---------- */

/** One line of a run's events.jsonl, parsed but not yet interpreted. */
export interface RawRunEvent {
	t: string;
	kind: string;
	detail: Record<string, unknown>;
}

/** Parse events.jsonl text. Torn tail lines (a writer append racing the read) are skipped, same as every jsonl reader here. */
export function parseRunEvents(text: string): RawRunEvent[] {
	const out: RawRunEvent[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const ev = JSON.parse(line);
			if (typeof ev?.t !== "string" || typeof ev?.kind !== "string") continue;
			out.push({ t: ev.t, kind: ev.kind, detail: ev.detail && typeof ev.detail === "object" ? ev.detail : {} });
		} catch {
			// torn or foreign line — not an event
		}
	}

	return out;
}

/**
 * Results about a run BEFORE collect has anything to read: the run log is written once, at
 * the end (`writeRunLog`), but the event log is appended the instant each step lands — so
 * counters folded off it are the only numbers that exist while the run executes. Everything
 * here is PROVISIONAL BY CONTRACT: it renders only on uncollected entries, it vanishes the
 * moment collect banks the real metrics, and it is never fed into rollups or cost — those
 * read collected metrics only, which is what keeps the dashboard unable to disagree with
 * the report. The step event is emitted from the same StepRecord the run log gets
 * (agent/run.ts: "the event cannot disagree with the run log"), so these counters converge
 * exactly to parseRunMetrics's numbers when the run terminates.
 */
export interface RunProgress {
	/** Newest event's own timestamp — the reading's honest age. */
	updatedAt: string;
	/** Task/replay: step events seen so far, and how many of them verified. */
	steps?: number;
	verified?: number;
	/** The newest step, human-shaped: `click "Save" ✓` — the "what is it doing right now" line. */
	lastStep?: string;
	/** Explore heartbeats (every 10th action) + chapter marks — coarse by design (run-events.ts). */
	actions?: number;
	frontier?: number;
	seen?: number;
	/** Operated / deliberately-skipped controls — absent on logs from before the heartbeat carried them (2026-08-01). */
	actuated?: number;
	dismissed?: number;
	nodes?: number;
	/** Distinct surfaces seen, and scope ambiguities off the graph so far — the heartbeat carries
	 *  them since 2026-08-02, so an older log simply has neither and the cell degrades to "–". */
	surfaces?: number;
	scopeAmbiguities?: number;
	/** The finish event's stop reason (frontier-empty, action-ceiling, interrupted…). */
	finished?: string;
	/** The run's OWN final claim (verdict event) — self-reported, pre-collect, pre-judge. */
	verdict?: { success: boolean; summary?: string };
	fatal?: string;
	/** Teardown outcome as one line: "3 restored" / "1 failed" / the error. */
	cleanup?: string;
	/**
	 * Token usage off the newest "usage" event — the harness emits one per model call carrying
	 * CUMULATIVE totals, so last-one-wins IS the run's usage so far. Field names match
	 * EntryView's collected fields (and cost.ts's TokenCounts) so the page treats live and
	 * collected symmetrically. `usd` is filled by the VIEW layer (entryView, with the same
	 * estimateCost + model fallbacks as collected rows), never by this aggregator — pricing
	 * needs the manifest's dispatch/default model, which an event log does not carry.
	 */
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	modelCalls?: number;
	/** The resolved model id the usage event named — pricing's first candidate. */
	model?: string;
	usd?: number;
}

/** Fold a run's events into results-so-far. Field checks are defensive per event, not per file: one malformed detail loses itself, never the run. */
export function aggregateRunEvents(raw: RawRunEvent[]): RunProgress | undefined {
	const last = raw[raw.length - 1];
	if (!last) return undefined;
	const p: RunProgress = { updatedAt: last.t };
	let steps = 0;
	let verified = 0;
	for (const ev of raw) {
		const d = ev.detail;
		switch (ev.kind) {
			case "step": {
				steps += 1;
				if (d.verified === true) verified += 1;
				p.lastStep = `${String(d.action ?? "?")}${typeof d.target === "string" ? ` "${d.target}"` : ""} ${d.verified === true ? "✓" : "✗"}`;
				break;
			}

			case "progress": {
				if (typeof d.actions === "number") p.actions = d.actions;
				if (typeof d.frontier === "number") p.frontier = d.frontier;
				if (typeof d.seen === "number") p.seen = d.seen;
				if (typeof d.actuated === "number") p.actuated = d.actuated;
				if (typeof d.dismissed === "number") p.dismissed = d.dismissed;
				if (typeof d.nodes === "number") p.nodes = d.nodes;
				if (typeof d.surfaces === "number") p.surfaces = d.surfaces;
				if (typeof d.scopeAmbiguities === "number") p.scopeAmbiguities = d.scopeAmbiguities;
				break;
			}

			case "chapter": {
				if (typeof d.nodes === "number") p.nodes = d.nodes;
				break;
			}

			case "finish": {
				if (typeof d.stopped === "string") p.finished = d.stopped;
				if (typeof d.actions === "number") p.actions = d.actions;
				if (typeof d.nodes === "number") p.nodes = d.nodes;
				if (typeof d.frontier === "number") p.frontier = d.frontier;
				if (typeof d.seen === "number") p.seen = d.seen;
				if (typeof d.actuated === "number") p.actuated = d.actuated;
				if (typeof d.dismissed === "number") p.dismissed = d.dismissed;
				if (typeof d.surfaces === "number") p.surfaces = d.surfaces;
				if (typeof d.scopeAmbiguities === "number") p.scopeAmbiguities = d.scopeAmbiguities;
				break;
			}

			case "verdict": {
				if (typeof d.success === "boolean")
					p.verdict = { success: d.success, ...(typeof d.summary === "string" && d.summary ? { summary: d.summary } : {}) };
				break;
			}

			case "fatal": {
				if (typeof d.error === "string") p.fatal = d.error;
				break;
			}

			case "usage": {
				// Cumulative totals by contract — the newest event IS the run's usage so far, so
				// later events simply overwrite earlier ones, field by field, defensively.
				if (typeof d.inputTokens === "number") p.inputTokens = d.inputTokens;
				if (typeof d.outputTokens === "number") p.outputTokens = d.outputTokens;
				if (typeof d.cacheReadTokens === "number") p.cacheReadTokens = d.cacheReadTokens;
				if (typeof d.cacheCreationTokens === "number") p.cacheCreationTokens = d.cacheCreationTokens;
				if (typeof d.modelCalls === "number") p.modelCalls = d.modelCalls;
				if (typeof d.model === "string" && d.model) p.model = d.model;
				break;
			}

			case "cleanup": {
				p.cleanup = typeof d.error === "string"
					? `teardown error: ${d.error}`
					: `${Number(d.restored ?? 0)} restored${Number(d.failed ?? 0) ? `, ${Number(d.failed)} failed` : ""}`;
				break;
			}
		}
	}
	if (steps) {
		p.steps = steps;
		p.verified = verified;
	}

	return p;
}

/** Aggregates keyed by file path, valid while (mtime, size) hold still — same idiom as eventTailCache. */
const progressCache = new Map<string, { mtimeMs: number; size: number; progress?: RunProgress }>();

/**
 * Results-so-far for a run whose events.jsonl is on THIS machine (local runs, and remote
 * runs once pulled). The WHOLE file, unlike storeEvents' display tail: counters must not
 * saturate at a tail cap — a 96-action explore writes more heartbeats than 50 lines hold.
 *
 * Resolved through runFile's live→archive ladder rather than read out of live directly. The
 * old live-only rule reasoned that "a run old enough to need the archive fallback has real
 * metrics to read instead" — true of the metric tiles, and wrong about the runs whose artifacts
 * leave live while the manifest still calls them uncollected: `runs drop`/`runs purge` move a
 * live directory to the archive on an operator's word alone, with no regard for whether a
 * collect pass has banked it. Those runs' counters simply went blank, and for a run the harness
 * ended on a stall streak the heartbeat trail through the dead steps is the evidence that says
 * whether the app went dark or the text channel could not see real progress.
 *
 * Still not read for COLLECTED entries — liveProgress skips those, and EntryView.live remains
 * uncollected-only so no row ever carries two answers to "how many steps".
 */
export function localRunProgress(runKey: string, outRoot = outDir()): RunProgress | undefined {
	const file = runFile(runKey, RUN_FILES.events, outRoot);
	let st: fs.Stats;
	try {
		st = fs.statSync(file);
	} catch {
		return undefined;
	}
	const hit = progressCache.get(file);
	if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.progress;
	let progress: RunProgress | undefined;
	try {
		progress = aggregateRunEvents(parseRunEvents(fs.readFileSync(file, "utf8")));
	} catch {
		return undefined;
	}
	if (progressCache.size > 500) progressCache.clear();
	progressCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, progress });

	return progress;
}

/* ---- discovery series: the shape of an explore pass over time ---------------------------- */

/**
 * One point of an explore pass's discovery series — a progress heartbeat, chapter mark, or
 * the finish/fatal endpoint, positioned on a wall-clock axis. SPARSE BY CONTRACT: a field is
 * present only when its event carried it, so logs from before the heartbeat was enriched
 * (2026-08-01: actuated/dismissed/nodes/tokens joined actions/frontier/seen) still fold into
 * a drawable series — the chart renders whichever metrics exist and skips the rest.
 */
export interface ExplorePoint {
	/** ms since the run's first event — the chart's wall-clock x-axis. */
	t: number;
	kind: "progress" | "chapter" | "finish" | "fatal";
	actions?: number;
	frontier?: number;
	seen?: number;
	actuated?: number;
	dismissed?: number;
	nodes?: number;
	/** Chapter ordinal — chapter marks render as context-reset ticks, not data points. */
	chapter?: number;
	tokensIn?: number;
	tokensOut?: number;
	tokensCacheRead?: number;
	tokensCacheCreation?: number;
	/** The finish event's stop reason / the fatal error's first line — the endpoint's label. */
	stopped?: string;
	fatal?: string;
}

const SERIES_NUMERIC_FIELDS = [
	"actions",
	"frontier",
	"seen",
	"actuated",
	"dismissed",
	"nodes",
	"chapter",
	"tokensIn",
	"tokensOut",
	"tokensCacheRead",
	"tokensCacheCreation",
] as const;

/**
 * Fold a run's events into its discovery series — the convergence chart's data. Same
 * defensive posture as aggregateRunEvents (a malformed detail loses its own fields, never
 * the series), and the same source of truth: this is a VIEW over events.jsonl, so it can
 * be drawn for any run whose event log survives, archived and evicted runs included.
 * Returns [] for logs with no plottable events — task runs fold to nothing here.
 */
export function exploreSeries(raw: RawRunEvent[]): ExplorePoint[] {
	const base = raw.length ? Date.parse(raw[0].t) : NaN;
	if (!Number.isFinite(base)) return [];
	const out: ExplorePoint[] = [];
	for (const ev of raw) {
		if (ev.kind !== "progress" && ev.kind !== "chapter" && ev.kind !== "finish" && ev.kind !== "fatal") continue;
		const t = Date.parse(ev.t) - base;
		if (!Number.isFinite(t)) continue;
		const point: ExplorePoint = { t, kind: ev.kind };
		for (const k of SERIES_NUMERIC_FIELDS) {
			const v = ev.detail[k];
			if (typeof v === "number" && Number.isFinite(v)) point[k] = v;
		}
		if (ev.kind === "finish" && typeof ev.detail.stopped === "string") point.stopped = ev.detail.stopped;
		if (ev.kind === "fatal" && typeof ev.detail.error === "string") point.fatal = ev.detail.error.split("\n")[0];
		out.push(point);
	}

	return out;
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
		"surfaces, graph nodes, scope ambiguities); what vision costs/buys; whether procedure replay",
		"is fleet-ready; judge disagreements with self-reports.",
		"",
		// The digest carries `collected`, `successes`, `harnessEnded` and `verdictRuns`, and a note
		// that divided by `collected` would contradict the board and the report over the same runs
		// — the narrative is one of the surfaces that quotes this rate out loud.
		"Success rates are successes over verdictRuns — collected runs MINUS harnessEnded, the runs",
		"the HARNESS ended (a stall streak, or the 100-step runaway backstop, neither of which is the",
		"agent's verdict). Never quote a rate over `collected`: a run that was cut off was never",
		"graded, and counting it as a miss reads as an agent that could not do the task.",
		"",
		"Write 2–3 sentences, Strunk & White style: plain, active, omit needless words. Every",
		"sentence is one finding carried by its numbers (ratios beat raw counts). Newest or most",
		"decision-relevant first. No preamble, no inventory of what hasn't run, no hedging",
		"boilerplate — a sample-size caveat only where it changes the conclusion. Never speculate",
		"past the data. Plain prose, no headers, no lists, no markdown.",
		...(previous ? ["", "Your previous note (already seen — write only what CHANGED or sharpened):", previous] : []),
		...(run
			? [
					"",
					`A run just completed: ${run.runKey} (arm ${run.armId}). Given the COMPLETE state below —`,
					"every run finished so far — write the note for THIS run: what it contributes, confirms,",
					"or changes versus its arm and the field to date. 2–3 sentences, numbers-first, plain prose.",
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
	"human-notes task": "Curated-Procedure Task",
	"vision-map grounded task": "Vision-Map Explored Task",
	"procedure compile": "Procedure Compile",
	"procedure replay": "Procedure Replay",
	"procedure replay (no rescue)": "Procedure Replay (No Rescue)",
};

/**
 * Explore variants name their perception CONDITION alone — the word "Explore" is dropped
 * entirely (David, 2026-08-01): the Task cell already reads "Explore" on these rows, so
 * repeating it in the Variant cell said everything twice. Never the backend as actuation:
 * Acts carries that, and folding actuation into the label is how "vision-only explore (AX)"
 * got misread as vision + AX on 2026-07-31. Names are CHANNEL-TRUTHFUL (renamed
 * 2026-08-01): each says which of the three channels (AX / DOM / Vision — armSees' axes)
 * the model is missing, or the single one it is left with. "Baseline" is all three, so it
 * is ax-only — a cdp arm never has the AX tree, and letting its full-perception label read
 * "Baseline" too hid that; it is "No AX". Likewise "DOM Only" (was "CDP Only") names the
 * channel, not the backend, and "No DOM" (was "No Sidecar") names what the sidecar's
 * absence costs, not the mechanism.
 * Derived from the dispatch object, same rule as armTitle — new cells name themselves.
 */
function exploreTitle(arm: Arm): string {
	const d = arm.dispatch;
	const base = d.noAx ? "Vision Only"
		: d.axdomOff && d.noVision ? "AX Only"
		: d.axdomOff ? "No DOM"
		: d.noVision ? (d.backend === "cdp" ? "DOM Only" : "No Vision")
		: (d.backend === "cdp" ? "No AX" : "Baseline");

	return base + (d.url ? " (Web)" : "");
}

function displayTitle(arm: Arm): string {
	if (arm.kind === "explore") return (arm.dispatch.record ? "Filmed " : "") + exploreTitle(arm);
	const t = armTitle(arm);
	const filmed = t.startsWith("filmed ");
	const base = filmed ? t.slice("filmed ".length) : t;

	return (filmed ? "Filmed " : "") + (ARM_TITLE_COPY[base] ?? base);
}

/**
 * perceptionLine's semantics as per-channel booleans (matrix.ts owns the sentence; this owns
 * the axes): --no-ax removes BOTH element channels; on cdp the DOM IS the element channel and
 * there is no AX; on ax the tree carries DOM attrs unless the axdom sidecar is off (AXDOM=0);
 * Vision is on unless --no-vision. Off the dispatch flags, never the rendered string.
 */
const armSees = (arm: Arm): ArmView["sees"] => ({
	ax: !arm.dispatch.noAx && arm.dispatch.backend !== "cdp",
	dom: !arm.dispatch.noAx && (arm.dispatch.backend === "cdp" || !arm.dispatch.axdomOff),
	vision: !arm.dispatch.noVision,
});

// CDP_RULES lives in src/backends/cdp.ts, whose static imports pull playwright-core — the one
// genuinely heavy module dash's graph does not already carry. Loaded lazily ONCE on first use
// and cached (same seam as core's backend selection branches); until it lands, cdp explore
// arms omit their prompt for a push or two rather than blocking the sync buildState. A failed
// load stays unloaded — prompts for those arms just never appear.
let cdpRules: string | undefined;
let cdpRulesRequested = false;
const requestCdpRules = (): void => {
	if (cdpRulesRequested) return;
	cdpRulesRequested = true;
	void import("../backends/cdp.js").then((m) => {
		cdpRules = m.CDP_RULES;
	}, () => {});
};

/**
 * The system prompt an explore arm runs under, mirroring explore.ts's selection branch
 * exactly (rules by backend/noAx, target vocabulary, vision, descent). A RECONSTRUCTION,
 * not a record: no artifact persists the explore prompt (checkpoint() writes only
 * coverage/nodes/edges), and the runner Mac's own env decides the real run's descent —
 * nothing in bench/remote sets EXPLORE_DESCENT, so DESCENT_ON here reproduces the fleet
 * default (off).
 */
function explorePrompt(arm: Arm): string | undefined {
	try {
		const d = arm.dispatch;
		const target: Target = d.url ? webTarget(d.url) : { kind: "app", name: arm.app };
		const vocab = targetVocabulary(target);
		const vision = !d.noVision;
		const descent = DESCENT_ON && !d.noAx;
		if (d.backend === "cdp") {
			requestCdpRules();

			return cdpRules === undefined ? undefined : systemPrompt(cdpRules, vocab, descent, vision);
		}

		return d.noAx ? systemPrompt(VISION_ONLY_RULES, vocab, descent, vision, true) : systemPrompt(DRIVER_RULES, vocab, descent, vision);
	} catch {
		// A malformed dispatch URL must degrade to a missing prompt, never kill the push.
		return undefined;
	}
}

/**
 * Which config each filmed arm films — `p5-ax-grounded-filmed` → `p2-ax-grounded`.
 *
 * Derived from MATRIX by stripping the phase prefix off both sides, because that is exactly how
 * `filmed()` mints the id (`p5-${arm.id.replace(/^p[0-9]-/, "")}-filmed`) and it also catches the
 * arms declared filmed by hand rather than derived — `p8-geometry-ax-filmed` keeps its own phase
 * prefix, so any rule anchored on "p5-" would miss it. Verified against the 109-arm matrix on
 * 2026-08-03: all 49 filmed arms resolve, and NO two plain arms strip to the same base, so the
 * mapping is one-to-one rather than merely plausible.
 *
 * Built once at module load: MATRIX is static, and rebuilding this per state push would be work
 * on the hot path for an answer that cannot change.
 */
const FILMED_TO_CONFIG: ReadonlyMap<string, string> = (() => {
	const stripPhase = (id: string): string => id.replace(/^p[0-9]+-/, "");
	const configByBase = new Map(MATRIX.filter((a) => !a.id.endsWith("-filmed")).map((a) => [stripPhase(a.id), a.id]));
	const out = new Map<string, string>();
	for (const a of MATRIX) {
		if (!a.id.endsWith("-filmed")) continue;
		const config = configByBase.get(stripPhase(a.id).replace(/-filmed$/, ""));
		if (config) out.set(a.id, config);
	}

	return out;
})();

/**
 * Move each filmed pass's runs onto the row of the config they film.
 *
 * The fallback is the point: a filmed pass whose config has no pass at the same model has no row
 * to move to, so it KEEPS ITS OWN — `graftedInto` stays unset and the board draws it as before.
 * One entry in the 2026-08-01 pass is exactly this case
 * (`p5-vision-only-grounded-visionmap-filmed` at sol, whose config never ran at that model), and
 * a graft that silently dropped it would be a run vanishing off the board — the worst outcome
 * available here, and invisible precisely because nothing would look wrong.
 */
function graftFilmedRuns(arms: ArmView[]): void {
	const byId = new Map(arms.map((a) => [a.id, a]));
	for (const [filmedId, configId] of FILMED_TO_CONFIG) {
		const filmed = byId.get(filmedId);
		const config = byId.get(configId);
		if (!filmed || !config) continue;
		for (const fp of filmed.passes) {
			// Matched on the DISPLAY label both sides already carry (passLabel), so the graft
			// lands on the pass a reader would call "that model" rather than on a raw id.
			const home = config.passes.find((p) => p.model === fp.model);
			if (!home) continue;
			home.filmed = { armId: filmedId, n: filmed.n, entries: [...(home.filmed?.entries ?? []), ...fp.entries] };
			fp.graftedInto = configId;
		}
	}
}

/**
 * The two failureKinds where the HARNESS ended the run rather than the agent reaching a verdict
 * (src/core/agent/run.ts's stopping contract; classified by collect.ts's failureKind).
 *
 * A copy of report.ts's private HARNESS_ENDED, and deliberately the ONLY copy on this side: every
 * per-arm number comes off `rollup()` itself, so this predicate is used once — for the pass-wide
 * `progress` tally, which counts manifest entries that may have no arm to roll up. Anything else
 * on this board that needs the distinction must read `harnessEnded`/`verdictRuns` off the rollup
 * rather than re-testing failureKind strings here.
 */
const HARNESS_ENDED = new Set(["step-ceiling", "stalled"]);

export function buildState(manifest: Manifest, fleet: FleetView, events: DashEvent[], autoCollect: boolean, defaultModel?: string, live?: Map<string, RunProgress>): DashState {
	const arms: ArmView[] = MATRIX.map((arm) => ({
		id: arm.id,
		title: displayTitle(arm),
		phase: arm.phase,
		kind: arm.kind,
		n: arm.n,
		flags: flagsLine(arm),
		app: arm.app,
		// perceptionLine speaks the user-facing modality words directly ("AX", "DOM",
		// "Vision") since the 2026-08-01 terminology pass — no display-side rewrite.
		perception: perceptionLine(arm),
		sees: armSees(arm),
		actuation: (arm.dispatch.backend ?? "ax").toUpperCase(),
		...(arm.task ? { task: arm.task } : {}),
		...(arm.dispatch.url ? { url: arm.dispatch.url } : {}),
		// JSON.stringify drops the undefined (cdp arms before CDP_RULES lands), so the wire
		// never carries an empty prompt field.
		...(arm.kind === "explore" ? { prompt: explorePrompt(arm) } : {}),
		// Lineage off the dispatch object, never the rendered flags string (same rule as
		// armTitle): a task/replay arm without noGrounding consumed SOME explore map.
		...((arm.kind === "task" || arm.kind === "replay") && !arm.dispatch.noGrounding
			? { groundedBy: groundingArmId(arm) }
			: {}),
		targetKey: arm.dispatch.url ?? arm.app,
		...(arm.informs ? { informs: arm.informs } : {}),
		passes: modelPasses(manifest, arm.id)
			.map((model) => passView(arm, model, manifest.entries.filter((e) => e.armId === arm.id && e.model === model), fleet, defaultModel, live))
			.filter((p) => p.submitted > 0),
	}));

	graftFilmedRuns(arms);

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

	// Counted against MATRIX directly, not against the rows: a row that was never built cannot
	// report its own absence, which is precisely the failure this exists to make visible.
	const unmatchedEntries = manifest.entries.filter((e) => !armById(e.armId)).length;

	// The pass-wide twin of ArmRollup.harnessEnded. Counted off `collectedEntries` rather than
	// summed from the arms' rollups because this tally counts the MANIFEST — including runs whose
	// armId matches no arm in MATRIX, which have no rollup to sum (see unmatchedEntries above).
	const harnessEnded = collectedEntries.filter((e) => HARNESS_ENDED.has(e.metrics?.failureKind ?? "")).length;

	return {
		date: manifest.date,
		generatedAt: new Date().toISOString(),
		autoCollect,
		...(defaultModel ? { defaultModel } : {}),
		...(unmatchedEntries ? { unmatchedEntries } : {}),
		progress: {
			planned: MATRIX.reduce((sum, a) => sum + a.n, 0),
			submitted: manifest.entries.length,
			collected: collectedEntries.length,
			running: allEntries.filter((e) => e.status === "running").length,
			queued: allEntries.filter((e) => e.status === "queued").length,
			successes: collectedEntries.filter((e) => e.metrics?.success === true).length,
			// `collected` above still counts these; only the hero's rate divides by verdictRuns.
			harnessEnded,
			verdictRuns: collectedEntries.length - harnessEnded,
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
	/**
	 * The graph is the RUNNING pass's checkpoint — the map so far, not a finished artifact.
	 * The page tags the tree LIVE and expires its detail cache so growth keeps arriving;
	 * absent the moment the pass writes its real appmap (which outranks the checkpoint).
	 */
	graphLive?: boolean;
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
	/**
	 * Explore arms only: the pass's discovery series folded off its events.jsonl — the
	 * convergence chart's data (frontier burn-down, map growth). Absent when the event log
	 * is not on this machine or the run predates run events.
	 */
	series?: ExplorePoint[];
	// NO `video` here on purpose. The take is reached from the board's own Take column, which
	// reads EntryView.video off the state frame — one source for "does this run have footage",
	// resolved by hasTake. A second copy on the detail would be a second thing to keep true.
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
	// APPMAP_VARIANT before axdomOff and short-circuited, so min-context-grounded — which
	// reads yarn.ax.noaxdom.novision — was attributed to explore-no-vision, which writes
	// yarn.ax.novision. The run itself was fine; the dash counted its path against a graph it
	// never read, which is exactly what the traversal-heat comment forbids. It also still named
	// explore-web-cdp, an arm deleted from the matrix.
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
	remoteCheckpoint?: Record<string, any>,
): { graph?: DashDetail["graph"]; source?: string; live?: boolean } {
	// The run's own copy — explore passes save RUN_FILES.appmapGraph inside their run dir, and
	// runFile walks out/bench/live → out/bench/archive → the pre-bench out/live and out/archive
	// homes. Task runs carry no appmap of their own and fall through to the arm-keyed copies.
	const own = readJsonFile(runFile(entry.jobId, RUN_FILES.appmapGraph, path.join(dataDir, "out")));
	if (own?.nodes) return { graph: shapeGraph(own), source: `${entry.jobId}/${RUN_FILES.appmapGraph} (run dir)` };
	// The pass's checkpoint — rewritten on every `record`, deliberately shaped as a valid
	// AppMap (explore/artifacts.ts), so a RUNNING (or killed) explore serves its map-so-far
	// through the same renderer. Sits below the final artifact (a finished pass has
	// appmapGraph above) and above the arm-keyed tiers, which for an in-flight run would
	// show a PREVIOUS pass's finished map instead of this run's growing one. The remote
	// copy (ssh-fetched off the busy Mac by serveDetail) outranks a local file, which for
	// a fleet run is at best a stale mid-run pull snapshot.
	if (!entry.collected) {
		const ckpt = remoteCheckpoint?.nodes ? remoteCheckpoint : readJsonFile(runFile(entry.jobId, RUN_FILES.checkpoint, path.join(dataDir, "out")));
		if (ckpt?.nodes) return { graph: shapeGraph(ckpt), source: `${RUN_FILES.checkpoint} (map so far — pass in flight)`, live: true };
	}
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
export function buildDetail(jobId: string, manifest: Manifest, opts: { dataDir?: string; benchRoot?: string; remoteCheckpoint?: Record<string, any> } = {}): DashDetail {
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
	const { graph, source, live } = resolveGraph(entry, exploreArmId, arm.app, benchRoot, dataDir, opts.remoteCheckpoint);

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

	// The pass's discovery series, folded off its own events.jsonl — runFile walks live →
	// archive → legacy, so evicted and archived passes keep their chart. Explore arms only:
	// a task run's events are steps, and the steps table already tells that story better.
	let series: ExplorePoint[] = [];
	if (arm.kind === "explore") {
		try {
			series = exploreSeries(parseRunEvents(fs.readFileSync(runFile(jobId, RUN_FILES.events, path.join(dataDir, "out")), "utf8")));
		} catch {
			// No event log on this machine (pre-events run, or not pulled yet) — chart simply absent.
		}
	}

	return {
		jobId,
		armId: entry.armId,
		...(task ? { task } : {}),
		...(graph ? { graph } : {}),
		...(source ? { graphSource: source } : {}),
		...(live ? { graphLive: true } : {}),
		steps,
		mutatedKeys,
		...(graph ? { heat: heatFor(graph, exploreArmId, entry.model, manifest, dataDir) } : {}),
		...(notes.length ? { note: notes.join("; ") } : {}),
		...(noteEv ? { narratorNote: { t: String(noteEv.t), text: String(noteEv.text), model: String(noteEv.model ?? "?") } } : {}),
		...(series.length ? { series } : {}),
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
	/**
	 * SHARE MODE — the posture for a dash serving a frozen snapshot to people who are not at
	 * this machine (see the hosting note in docs/deploying-the-dash.md).
	 *
	 * The local dash is a reader over a store it sits beside, and everything it does BEYOND
	 * reading that store reaches the colo Macs: the fleet poll ssh's every 5s, the detail pane
	 * fetches a running explore's checkpoint, the log pane falls through to `runnerctl logs`,
	 * and /peek opens tunnels and streams a Mac's screen. None of that has any meaning against
	 * a snapshot, and all of it is a live capability nobody viewing a published result should
	 * hold — so share mode withholds the inventory those branches gate on, silences the poll,
	 * and rejects /peek outright.
	 *
	 * It also stops the narrator, which is the one thing the default posture WRITES. A hosted
	 * container's disk is ephemeral, so a note minted there is lost on the next deploy while
	 * costing a model call — and the snapshot already carries the notes the pass earned.
	 */
	share?: boolean;
	/**
	 * Serve with NO auth gate. Only ever true because someone SAID so — `--public` or
	 * DASH_PUBLIC=1 — never inferred from a missing DASH_AUTH, which is the shape of a
	 * misconfigured deploy rather than a decision. See main()'s isPublic.
	 */
	public?: boolean;
	/**
	 * The store behind this dash is NOT being written — retire its non-terminal states for
	 * display (freezeStates). `--frozen`, or DASH_FROZEN=1.
	 *
	 * SPLIT OUT OF `share` (David, 2026-08-03), because share was answering two unrelated
	 * questions with one flag: "may this audience reach the fleet" and "is this data still
	 * moving". They came apart the moment the orchestrator moved to a droplet: collect pulls
	 * artifacts to whatever machine drives the pass, so a dash beside THAT store is public and
	 * live at once — the fleet must stay withheld, and the manifest must not be frozen.
	 *
	 * Freezing a live store is not a cosmetic error. It retires every in-flight run to
	 * `abandoned` and every queued one to `never-ran`, so a board watching an active drain would
	 * report that nothing is running and nothing is waiting — the exact opposite of what the
	 * viewer needs, stated with total confidence.
	 *
	 * Frozen is the right answer for the container image, which COPYs a snapshot at build time
	 * and can therefore never be live; Dockerfile.dash sets it for that reason. A dash run from
	 * a checkout defaults to live, because a checkout's store is the one the runner writes.
	 */
	frozen?: boolean;
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
		// PORT before DASH_PORT: a PaaS assigns the port and expects the process to take it
		// (Render, Heroku, Fly all inject PORT), while DASH_PORT is the operator's own choice on
		// a machine where 4642 might be taken. An explicit --port still outranks both.
		port: Number(flag("--port") ?? process.env.PORT ?? process.env.DASH_PORT ?? 4642),
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
		// Env as well as flag: a PaaS start command is a place where one env var beats arguing
		// with argv quoting, and the Electron shell shares this parser.
		...(args.includes("--share") || process.env.DASH_SHARE === "1" ? { share: true } : {}),
		// Env as well as flag, like --share: on a PaaS the posture travels as an env var, and it
		// must be as easy to declare "public on purpose" as it is to declare share mode.
		...(args.includes("--public") || process.env.DASH_PUBLIC === "1" ? { public: true } : {}),
		// Frozen is about the DATA, not the audience — see DashOptions.frozen for why it is no
		// longer inferred from --share.
		...(args.includes("--frozen") || process.env.DASH_FROZEN === "1" ? { frozen: true } : {}),
	};
}

/**
 * HTTP Basic auth from `DASH_AUTH=user:pass`, or `undefined` when the variable is unset —
 * which means WIDE OPEN, and is the right default for a dash bound to a laptop.
 *
 * Basic rather than a token in the query string, deliberately: the browser prompts once and
 * remembers, which is what makes a link shareable with a colleague, and a URL that carries
 * its own credential leaks it into history, referrers and any screenshot of the address bar.
 * Both halves are compared timing-safely — the header is attacker-controlled and the
 * comparison is the only thing standing in front of the data.
 *
 * Only the transport is trusted-by-assumption here: Basic sends the credential base64'd, not
 * encrypted, so this is safe exactly to the extent the connection is TLS. Render terminates
 * TLS on its own edge, which is the deployment this was written for.
 */
export function basicAuthGate(spec: string | undefined): ((header: string | undefined) => boolean) | undefined {
	if (!spec) return undefined;
	const expected = Buffer.from(spec, "utf8");

	return (header: string | undefined): boolean => {
		const m = /^Basic\s+(.+)$/i.exec(header ?? "");
		if (!m) return false;
		let got: Buffer;
		try {
			got = Buffer.from(Buffer.from(m[1] as string, "base64").toString("utf8"), "utf8");
		} catch {
			return false;
		}
		// timingSafeEqual THROWS on a length mismatch rather than returning false, so the lengths
		// are checked first — and a wrong length is not a secret worth hiding, only its contents.
		return got.length === expected.length && timingSafeEqual(got, expected);
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
	const { port, autoCollect, share = false, frozen = false } = opts;
	/**
	 * PUBLIC — serve the board with no gate at all (David, 2026-08-03: "the data isn't sensitive
	 * and I'd rather the team not have to authenticate to view it").
	 *
	 * A SEPARATE, EXPLICIT declaration rather than "no DASH_AUTH means no auth", because those are
	 * different situations and only one of them is a decision. An unset secret is the shape of a
	 * misconfigured deploy — a rotated key, a forgotten env var on a new service — and the refusal
	 * below exists to catch exactly that. Publishing openly is a choice someone has to make in so
	 * many words, and this is the words.
	 */
	const isPublic = opts.public === true || process.env.DASH_PUBLIC === "1";
	// Precedence, stated because the combination is contradictory config: an explicit DASH_PUBLIC
	// wins over a DASH_AUTH left behind by an earlier posture, and says so on the way up. The
	// alternative — refusing to start — would mean a deploy that cannot go public until someone
	// with dashboard access removes a secret, which is a worse failure than a loud log line.
	const authGate = isPublic ? undefined : basicAuthGate(process.env.DASH_AUTH);
	if (isPublic && process.env.DASH_AUTH) console.warn("DASH_PUBLIC=1 — serving UNAUTHENTICATED; the DASH_AUTH value present in this environment is deliberately ignored");
	// Two refusals rather than two silent downgrades, per env.ts's rule that a knob wrong enough
	// to matter should be heard: a share-mode dash is reachable by people who are not the
	// operator, so serving it unauthenticated BY ACCIDENT or letting it WRITE to the store it is
	// publishing are both worth dying over rather than logging.
	if (share && !authGate && !isPublic) throw new Error("--share requires DASH_AUTH=user:pass, or DASH_PUBLIC=1 to publish it openly on purpose — refusing to serve the store unauthenticated by accident");
	if (share && autoCollect) throw new Error("--share and --collect are contradictory: a published snapshot is read-only");
	// Mutable: a dash that did not have its date named follows the newest drained pass, so a
	// benchmark starting after the one it booted on does not leave it watching yesterday.
	let date = opts.date;

	// The ONE manifest read for this process — share mode retires the non-terminal states as the
	// bytes come in, so no downstream reader has to know whether it is looking at a snapshot.
	// `frozen`, never `share`: a public board over a LIVE store (the orchestrator's own machine)
	// must report its running and queued runs as what they are.
	const readCurrentManifest = (d: string): Manifest => (frozen ? freezeStates(readStoredManifest(d)) : readStoredManifest(d));
	let manifest = readCurrentManifest(date);
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

	/*
	 * Results-so-far transport for FLEET runs — dashboard-side only, the runner untouched.
	 *
	 * A running fleet job's events.jsonl lives on the colo Mac until collect's pull, so the
	 * live counters need their own read: `cat` the file over the same pinned, multiplexed
	 * ssh the fleet poll rides (one extra exec per busy host per poll — the master connection
	 * already exists). The remote path reaches a login shell, exactly like an rsync
	 * destination, so it passes the same gate (assertSafeRemotePath) and its variable parts
	 * are validated individually: the data root is what the host's own doctor reported
	 * (cached per host — it cannot change under a running runner), the job id must match the
	 * stamp alphabet. Whole-file each tick, no offset bookkeeping: an event log is ~15-25
	 * lines by contract (run-events.ts), so deltas would save bytes nobody is missing.
	 */
	const { assertSafeRemotePath, remoteDataRoot, runSsh } = await import("../remote/control/ssh.js");
	const { loadHosts, resolveHost } = await import("../remote/control/hosts.js");
	let inventory: Inventory | undefined;
	try {
		// Share mode leaves it undefined ON PURPOSE. Every branch in this file that shells ssh —
		// the remote event tail below, serveDetail's checkpoint fetch, serveLogs' remote tier —
		// already guards on `inventory` because a laptop-only checkout has no hosts.json, so
		// withholding it here disarms all three at once instead of three separate `if (share)`
		// checks that a fourth ssh call site could later forget to add.
		if (!share) inventory = loadHosts();
	} catch {
		// No hosts.json (a laptop-only checkout) — local runs still get live counters.
	}
	const remoteRuns = new Map<string, { host: string; raw: RawRunEvent[]; misses: number }>();
	const remoteRootCache = new Map<string, string>();
	// Same alphabet dispatch.ts enforces on job ids — path segments on both machines.
	const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

	const pollRemoteEvents = async (): Promise<void> => {
		const busy = fleet.rows.filter((r) => r.name !== "local" && r.state === "busy" && typeof r.jobId === "string");
		for (const r of busy) {
			const cur = remoteRuns.get(r.jobId as string);
			remoteRuns.set(r.jobId as string, cur ? { ...cur, host: r.name, misses: 0 } : { host: r.name, raw: [], misses: 0 });
		}
		// Grace fetches: the verdict/cleanup events are written as the run EXITS — after its
		// last busy sighting — so a departed job is tailed for two more polls to catch its
		// final words. Dropped the moment the truth exists locally (pull landed, or the entry
		// collected), which is also what keeps a line from reaching the merged feed twice.
		for (const [jobId, s] of [...remoteRuns]) {
			if (busy.some((r) => r.jobId === jobId)) continue;
			s.misses += 1;
			const entry = manifest.entries.find((en) => en.jobId === jobId);
			// runFile, matching what storeEvents now resolves: the two probes must agree on "the
			// truth exists locally", or a run whose log landed in the archive rather than in live
			// would be emitted by the local scan AND kept on the remote tail — every line twice.
			const localFile = runFile(jobId, RUN_FILES.events);
			if (s.misses > 2 || entry?.collected || fs.existsSync(localFile)) remoteRuns.delete(jobId);
		}
		// Parallel across hosts (≤3, one run each); per-job isolation — one dead host must
		// not starve the others' counters. Failures keep the last good tail rather than
		// blanking it: a 4s ssh timeout on a busy Mac is routine, not evidence.
		await Promise.all([...remoteRuns].map(async ([jobId, s]) => {
			if (!inventory || !SAFE_RUN_ID.test(jobId)) return;
			let host: HostEntry;
			try {
				host = resolveHost(s.host, inventory);
			} catch {
				return; // a fleet row not in the inventory (renamed host) — nothing to ssh to
			}
			let root = remoteRootCache.get(s.host);
			if (!root) {
				root = await remoteDataRoot(host, runSsh);
				if (!root) return; // host did not answer doctor — retry next poll

				remoteRootCache.set(s.host, root);
			}
			const remote = `${root}/out/${LIVE_DIR}/${jobId}/${RUN_FILES.events}`;
			try {
				assertSafeRemotePath(remote);
			} catch {
				return; // a doctor-reported root outside the safe alphabet — refuse, don't quote
			}
			const res = await runSsh(host, ["cat", remote], {});
			// Nonzero covers "no file yet" (just-started or a runner predating event logs)
			// and transport hiccups alike — keep what we had.
			if (res.code === 0) s.raw = parseRunEvents(res.stdout);
		}));
	};

	/**
	 * The remote tails as feed lines — what storeEvents' local scan cannot see yet. The
	 * existence probe re-checks at feed time, not only at poll time: a pull landing the
	 * local file between fleet ticks would otherwise double every line for one interval.
	 */
	const remoteFeed = (): DashEvent[] =>
		[...remoteRuns]
			// Same ladder as the local scan (see the poll-time probe above) — one answer to
			// "is this run's log already on this machine", or the merge doubles its lines.
			.filter(([jobId]) => !fs.existsSync(runFile(jobId, RUN_FILES.events)))
			.flatMap(([jobId, s]) =>
				// Usage events skip the feed (counter channel, not narrative — they render in the
				// metric columns); filtered BEFORE the tail cap so counters never eat the window.
				s.raw.filter((ev) => ev.kind !== "usage").slice(-EVENT_TAIL_LINES).map((ev) => ({ t: ev.t, line: runEventLine(ev.kind, ev.detail), runKey: jobId, source: "run" as const })));

	/** Results-so-far per uncollected entry: the remote tail while the fleet holds the run, the local file otherwise. */
	const liveProgress = (): Map<string, RunProgress> => {
		const map = new Map<string, RunProgress>();
		for (const e of manifest.entries) {
			if (e.collected) continue;
			const remote = remoteRuns.get(e.jobId);
			// Remote-first while a tail exists: a local copy of a still-running job (a manual
			// mid-run pull) is a snapshot; the tail is the run speaking now.
			const p = (remote?.raw.length ? aggregateRunEvents(remote.raw) : undefined) ?? localRunProgress(e.jobId);
			if (p) map.set(e.jobId, p);
		}

		return map;
	};

	// The ONE state builder for anything a client can receive. `narrative` used to be attached
	// only inside push(), so GET /api/state and the initial /events frame omitted it — a page
	// that connected after the note was minted showed nothing until an unrelated push came by.
	// The Events feed is the run folders' event logs merged with the dash's own ring —
	// recomputed per push (mtime-cached tails, see storeEvents), so run events reach the page
	// on the same cadence as everything else without any new watcher.
	const currentState = (): DashState => {
		const state = buildState(manifest, fleet, storeEvents(events, 200, outDir(), remoteFeed()), autoCollect, defaultModel, liveProgress());
		if (narrative) state.narrative = narrative;
		// Grafted here rather than threaded through buildState: the posture is a property of THIS
		// server, not of the manifest+fleet pair buildState is a pure function of. The page needs
		// it because its connection badge reads "live" off a healthy SSE socket — which is true of
		// the socket and misleading about the data, and "misleading about the data" is the one
		// thing a published board cannot be.
		if (share) state.share = true;

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
						// with no text at all. The prompt caps the visible output (2–3 sentences), so
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
				manifest = readCurrentManifest(date);
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
			execFile("pgrep", ["-f", "tsx src/core/(agent|explore|procedure-cli)\\.ts"], (err) => resolve(!err)));
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
			manifest = readCurrentManifest(date);
			// After the fleet snapshot and the manifest, before the push: the tail wants the
			// fresh busy set (which jobs to fetch) and the fresh manifest (which to drop), and
			// the push wants the tail's counters on the frame it is about to send.
			await pollRemoteEvents();
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
				manifest = readCurrentManifest(date);
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
	// The per-session sentinel (primary upgrade · tunnel health · SCK fallback) shares the
	// re-probe cadence; SILENCE is measured from the last frame OR engine event, so a static
	// page with a healthy tunnel is probed occasionally and left alone, while a wedged ssh
	// forward (accepts TCP, drops HTTP) is caught in ~12-15s instead of ServerAlive's ~45s.
	const SENTINEL_MS = WAIT_REPROBE_MS;
	const ENGINE_SILENCE_PROBE_MS = 12_000;
	// SCK window-capture fallback: when no CDP endpoint has delivered for this long, ask the
	// runner to spawn a view-only ScreenCaptureKit stream of the host's window (native/liveview,
	// the same engine the sign-in viewer uses) and relay its frames into the panel. This is the
	// ONLY path that shows an ax-arm run (no debug port ever) or a hardened Electron target —
	// pixels the CDP tunnel can never reach. Long enough that every normal CDP attach (8s probe
	// budget + first frames) wins first; the app-CDP path is always preferred and upgrades back
	// to it the moment :9222 appears. Requires the runner's `peek-capture` verb (fleet
	// re-provision + runner restart to go live).
	const SCK_FALLBACK_AFTER_MS = 20_000;
	// Budget for the peek-capture verb round trip: the runner swaps nothing and foregrounds
	// nothing, but spawns a detached liveview server and waits for its port — a couple of
	// seconds, generously bounded here so a slow colo link does not abandon a good request.
	const SCK_CAPTURE_TIMEOUT_MS = 20_000;
	// Consecutive respawns of one tunnel slot with no successful probe since = one loud event
	// line. Churn stays off the feed below this (three always-on sessions would drown it);
	// an ssh that dies instantly forever (revoked key, changed host key) crosses it in ~20s.
	const TUNNEL_STORM_RESPAWNS = 5;

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
		/** What the CURRENT engine is: a CDP screencast over a tunneled debug port, or the
		 *  runner's view-only SCK window capture relayed over its own tunnel. Drives the
		 *  sentinel's upgrade policy — app-CDP is always preferred, so both web-CDP and SCK are
		 *  upgraded away from the moment :9222 answers. */
		source?: "cdp" | "sck";
		/** Set on the first frame from the CURRENT engine attach — flips waiting→streaming once. */
		gotFrame: boolean;
		/** First successful attach already hit the event feed — later re-attaches stay quiet. */
		streamLogged: boolean;
		/** Which tunnel slot the CURRENT CDP engine attached through (0 app / 1 web) — the
		 *  sentinel's primary-upgrade check applies while it is 1 (or while source is "sck"). */
		primarySlot?: number;
		/** The engine's last word was a refusal (idle-parked / stream-stopped): alive, showing
		 *  nothing, and — unlike a static page — safe to upgrade away from. Cleared by frames. */
		refusing: boolean;
		/** Last frame OR engine event, ms epoch — the sentinel's silence clock. Also bumped by a
		 *  passed health probe, so a static-but-healthy target is probed once per silence window,
		 *  not once per tick. */
		lastActivityAt: number;
		/** Session build time — the SCK-fallback clock starts here, reset by every frame. */
		lastFrameAt: number;
		/** The SCK fallback's own tunnel to the runner's liveview server (separate from the two
		 *  CDP slots), and the ephemeral local port it binds. Killed when SCK tears down or an
		 *  app-CDP upgrade supersedes it. */
		sckTunnel?: ChildProcess;
		sckLocal?: number;
		/** A peek-capture request/attach is underway — the sentinel must not fire a second. */
		sckInFlight: boolean;
		state: PeekState;
		sockets: Set<Duplex>;
		idleTimer?: NodeJS.Timeout;
		reprobeTimer?: NodeJS.Timeout;
		heartbeatTimer?: NodeJS.Timeout;
		sentinelTimer?: NodeJS.Timeout;
		/** Sentinel work in flight — the 3s tick must not stack probes behind a slow one. */
		sentinelBusy: boolean;
		/** Last status/error JSON frame, replayed to late joiners so they render state instantly. */
		lastStatus?: Buffer;
		/** Last {ev:"window"} frame, replayed to late joiners. */
		lastWindow?: Buffer;
		/** Last JPEG while state is streaming — replayed to late joiners so a reconnect repaints
		 *  instantly instead of waiting for the next compositor commit (a static screen may not
		 *  produce one for minutes). Cleared when the session leaves streaming. */
		lastFrame?: Buffer;
		/** Per-slot: last stderr line the tunnel child wrote — the storm line's diagnosis. */
		tunnelErrs: Array<string | undefined>;
		/** Per-slot: the storm already hit the event feed this session. */
		stormLogged: boolean[];
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
		// A frame replayed outside "streaming" would flip a late joiner's panel to live over a
		// stream that is not delivering — the stale-frame lie the first-frame rule exists to kill.
		if (state !== "streaming") p.lastFrame = undefined;
		p.lastStatus = castJson(p, { ev: "status", state, message });
	};
	// One frame-delivery path for BOTH engine kinds (CDP screencast, SCK window capture): the
	// first frame flips the panel to streaming (never the attach — an alive engine can show
	// nothing), later frames just cast. `logOnce` hits the event feed only on the first stream
	// of a session, so an always-armed panel re-attaching per run does not flood it.
	const deliverFrame = (p: Peek, engine: EngineHandle, jpeg: Buffer, logOnce: string): void => {
		if (peeks.get(p.host) !== p || p.engine !== engine) return;
		p.lastFrameAt = p.lastActivityAt = Date.now();
		p.refusing = false;
		if (!p.gotFrame) {
			p.gotFrame = true;
			setStatus(p, "streaming", `streaming ${p.host}`);
			if (!p.streamLogged) {
				p.streamLogged = true;
				addEvent(logOnce);
			}
		}
		p.lastFrame = jpeg;
		cast(p, jpeg, "binary");
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
		clearInterval(p.sentinelTimer);
		for (const t of p.respawnTimers) clearTimeout(t);
		p.engine?.close();
		p.engine = undefined;
		// These are real non-mux clients (tunnelArgv orders its own mux-off options first),
		// so SIGTERM actually closes the forwards.
		for (const t of p.tunnels) t?.kill("SIGTERM");
		p.sckTunnel?.kill("SIGTERM"); // the SCK fallback's own tunnel, if one was up
		p.sckTunnel = undefined;
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

	// Liveness for the SCK fallback's tunnel: the liveview server answers ANY HTTP request (403
	// without the token, still a response), so a reply of any status means the tunnel and the
	// server are both up — only a network error (wedged/dead forward) is "down". Unlike
	// endpointUp, status is not checked: the token gate would 403 a valid server otherwise.
	const portResponds = async (port: number): Promise<boolean> => {
		try {
			await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });

			return true;
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
		// tunnelArgv emits its own anti-mux options ahead of the base block — no overrides needed
		// here. stderr is kept (last line only): when a tunnel dies instantly on every respawn,
		// ssh's own words ("Host key verification failed", "Permission denied") are the diagnosis,
		// and without them the storm line below could only say "it keeps dying".
		const child = spawn("ssh", tunnelArgv(p.hostCfg, remote, local), { stdio: ["ignore", "ignore", "pipe"] });
		child.stderr?.on("data", (buf: Buffer) => {
			const line = buf.toString("utf8").trim().split("\n").filter(Boolean).at(-1);
			if (line) p.tunnelErrs[slot] = line.slice(0, 160);
		});
		child.stderr?.on("error", () => {});
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
			// three always-on sessions would drown it (attach/first-stream/teardown only). The
			// ONE exception: a slot that keeps dying without ever passing a probe crosses the
			// storm threshold and gets a single feed line carrying ssh's own last words —
			// otherwise a revoked key or changed host key is an eternal silent spinner.
			p.lastStatus = castJson(p, { ev: "error", kind: "tunnel-died", message: `ssh tunnel for :${remote} on ${p.host} ${what} — respawning${p.tunnelErrs[slot] ? ` (${p.tunnelErrs[slot]})` : ""}` });
			const n = Math.min(p.respawnCounts[slot], TUNNEL_RESPAWN_MS.length - 1);
			p.respawnCounts[slot]++;
			// The storm line means "this session cannot connect at all" (a revoked/changed host
			// key = eternal spinner). Gate it on NEVER having streamed: a slot whose remote port
			// is legitimately silent (an ax arm leaves :9222 dead) is the idle connection and so
			// the likeliest idle-drop victim, and its reconnects across a multi-hour session
			// must not read as a failure while the other leg streams fine. probeOnce only resets
			// the ANSWERING slot's counter, so without this gate the silent slot's count is
			// monotone and eventually cries wolf.
			if (p.respawnCounts[slot] === TUNNEL_STORM_RESPAWNS && !p.stormLogged[slot] && !p.streamLogged) {
				p.stormLogged[slot] = true;
				addEvent(`view: ${p.host}'s :${remote} tunnel died ${TUNNEL_STORM_RESPAWNS}× without connecting${p.tunnelErrs[slot] ? ` — ${p.tunnelErrs[slot]}` : ""}`);
			}
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
		p.source = "cdp";
		p.primarySlot = eps.slot;
		p.refusing = false;
		p.lastActivityAt = Date.now();
		engine.onFrame((jpeg) => deliverFrame(p, engine, jpeg, `view: streaming ${p.host} via ${eps.endpoint} (+${eps.browserEndpoint})`));
		engine.onEvent((ev: any) => {
			if (peeks.get(p.host) !== p || p.engine !== engine) return;
			p.lastActivityAt = Date.now();
			// The engine's refusals (gate-refused residue, an emptied follow stack) are the
			// sentinel's license to act: alive-but-refusing is exactly the state a web-primary
			// wedge presents, where a static-but-delivered page must be left alone. Only a frame
			// clears it — a window/title event mid-refusal changes nothing about delivery.
			if (ev?.ev === "error" && (ev.kind === "idle-parked" || ev.kind === "stream-stopped")) {
				p.refusing = true;
				// A refusal AFTER frames were flowing: the engine emits it without dying, so
				// nothing else leaves "streaming" — the panel would keep its last JPEG labeled
				// live, and the late-joiner replay would hand a reconnecting viewer that frozen
				// frame. Drop to waiting so setStatus clears lastFrame; the next real frame
				// re-flips to streaming via gotFrame.
				if (p.gotFrame) {
					p.gotFrame = false;
					setStatus(p, "waiting", `${p.host} stopped delivering — waiting for it to resume`);
				}
			}
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

	/** Kill the SCK fallback's own tunnel and forget its port — the engine is handled separately. */
	const teardownSckTunnel = (p: Peek): void => {
		p.sckTunnel?.kill("SIGTERM");
		p.sckTunnel = undefined;
		p.sckLocal = undefined;
	};

	/**
	 * Wire a runner-spawned SCK window-capture engine (native/liveview, relayed over its own
	 * tunnel — see connectLiveviewClient) into the session, exactly as tryConnect wires a CDP
	 * engine. Frames flow through the shared deliverFrame; the panel renders them identically.
	 * SCK has no page/refusal model — it either captures or it errors — so the event handling is
	 * simpler than CDP's: a pre-first-frame error kind is a failed attach, anything else is
	 * status. Death (the liveview server's lifetime, or a dropped tunnel) fires onExit.
	 */
	const attachSckEngine = (p: Peek, engine: EngineHandle): void => {
		p.gotFrame = false;
		p.engine = engine;
		p.source = "sck";
		p.primarySlot = undefined; // SCK rides its own tunnel, not a CDP slot
		p.refusing = false;
		p.lastActivityAt = Date.now();
		engine.onFrame((jpeg) => deliverFrame(p, engine, jpeg, `view: window-capturing ${p.host} (SCK fallback — no debug port)`));
		engine.onEvent((ev: any) => {
			if (peeks.get(p.host) !== p || p.engine !== engine) return;
			p.lastActivityAt = Date.now();
			if (ev?.ev === "window") p.lastWindow = castJson(p, ev);
			else castJson(p, ev);
			// A capture error before the first frame is a failed attach: no Screen Recording
			// grant, no window to follow, or the engine binary is missing. Drop and re-enter
			// waiting — the CDP reprobe resumes, and the sentinel re-requests SCK after the
			// threshold if CDP still never appears. "spawn-failed" is the load-bearing one: the
			// native binary never started (ENOENT on an unbuilt fleet Mac) and, per liveview.ts,
			// fires NO onExit — so this branch is the ONLY recovery, and it must match the kind
			// spawnEngine actually emits ("spawn-failed", not "engine-spawn-failed").
			if (ev?.ev === "error" && !p.gotFrame && (ev.kind === "no-screen-recording" || ev.kind === "no-window" || ev.kind === "capture-failed" || ev.kind === "spawn-failed")) {
				engine.close();
				if (p.engine === engine) {
					p.engine = undefined;
					p.source = undefined;
				}
				teardownSckTunnel(p);
				enterWaiting(p, `window capture on ${p.host} failed (${ev.kind}) — waiting`);
			}
		});
		engine.onExit(() => {
			if (peeks.get(p.host) !== p || p.engine !== engine) return; // stale corpse — ignore
			p.engine = undefined;
			p.source = undefined;
			teardownSckTunnel(p);
			p.lastStatus = castJson(p, { ev: "error", kind: "stream-ended", message: "window capture ended — waiting" });
			enterWaiting(p, `window capture ended on ${p.host} — waiting`);
		});
		if (peeks.get(p.host) === p && p.engine === engine) setStatus(p, "waiting", `window-capturing ${p.host} — waiting for content`);
	};

	/**
	 * Ask the runner to spawn a view-only ScreenCaptureKit stream of the host's window, tunnel to
	 * it, and attach. This is the fallback the CDP path cannot cover — an ax-arm run opens no
	 * debug port ever, and a hardened Electron target strips it — so the ONLY way to see those
	 * runs is to capture pixels on the Mac (where the runner holds the Screen Recording grant)
	 * and relay them. No profile swap, no foregrounding, no credential: SCK just reads the
	 * window's pixels. Needs the runner's `peek-capture` verb; an un-upgraded runner rejects it
	 * on stderr, which logs once and leaves the session waiting (exactly its state already).
	 */
	const startSckFallback = async (p: Peek): Promise<void> => {
		p.sckInFlight = true;
		try {
			const { runSsh, runnerArgv, lastFrame, tunnelArgv } = await import("../remote/control/ssh.js");
			const frame = lastFrame((await runSsh(p.hostCfg, runnerArgv("peek-capture"), { timeoutMs: SCK_CAPTURE_TIMEOUT_MS })).stdout);
			if (peeks.get(p.host) !== p || p.closing) return;
			const port = Number(frame?.port);
			const token = String(frame?.token ?? "");
			if (frame?.ok !== true || !Number.isFinite(port) || port <= 0 || !token) {
				// Once per session (streamLogged-style would over-suppress; this is rare): the
				// most likely cause is a runner that predates the verb.
				addEvent(`view: SCK fallback unavailable on ${p.host}${frame?.error ? ` — ${String(frame.error).slice(0, 120)}` : " (runner may need the peek-capture verb — re-provision + restart)"}`);

				return;
			}
			const local = await freeLocalPort();
			if (peeks.get(p.host) !== p || p.closing) return;
			p.sckLocal = local;
			// A single dedicated tunnel (not the respawn machinery the CDP slots use): if it
			// dies, the WS drops, the engine fires onExit, and the outer loop re-requests SCK
			// after the threshold. tunnelArgv orders its own anti-mux options first.
			p.sckTunnel = spawn("ssh", tunnelArgv(p.hostCfg, port, local), { stdio: "ignore" });
			p.sckTunnel.once("error", () => {}); // an unlistened 'error' is an uncaught exception
			// The -L listener binds only after connect+auth; wait for the server to answer before
			// the WS client dials it, or the connect races the bind and fails spuriously.
			const dialByMs = Date.now() + 8000;
			while (Date.now() < dialByMs && !(await portResponds(local))) {
				if (peeks.get(p.host) !== p || p.closing) return teardownSckTunnel(p);
				await sleep(PROBE_STEP_MS);
			}
			if (peeks.get(p.host) !== p || p.closing) return teardownSckTunnel(p);
			const { connectLiveviewClient } = await import("../remote/liveview-client.js");
			const engine = await connectLiveviewClient(`ws://127.0.0.1:${local}/?t=${encodeURIComponent(token)}`);
			if (peeks.get(p.host) !== p || p.closing) {
				engine.close();
				teardownSckTunnel(p);

				return;
			}
			if (p.engine) {
				// An engine that started DELIVERING while the verb round-tripped won the race —
				// app/web CDP beats SCK, keep it. But a refusing or frameless engine (the parked
				// web leg on an ax arm, an attach that never produced a frame) is exactly what
				// sentinel #3 fired against, and it HOLDS p.engine: discarding the SCK engine
				// here re-runs the whole dance every tick — spawn a capture server, tunnel,
				// connect, throw it all away — and the panel stays dark forever. Displace it,
				// corpse-guarded like the primary-upgrade path.
				if (p.gotFrame && !p.refusing && Date.now() - p.lastFrameAt <= SCK_FALLBACK_AFTER_MS) {
					engine.close();
					teardownSckTunnel(p);

					return;
				}
				const loser = p.engine;
				p.engine = undefined; // BEFORE close — the corpse's onExit must no-op
				p.source = undefined;
				loser.close();
			}
			attachSckEngine(p, engine);
		} catch (err) {
			teardownSckTunnel(p);
			addEvent(`view: SCK fallback on ${p.host} errored — ${String(err).slice(0, 120)}`);
		} finally {
			p.sckInFlight = false;
		}
	};

	/**
	 * The per-session sentinel: the three recovery paths a LIVE engine otherwise blocks —
	 * reprobeTick deliberately owns nothing while `p.engine` is set, and each of these is a
	 * state an alive engine can hold forever.
	 *
	 *  1. PRIMARY UPGRADE. The app leg (:9222) is the only true primary: the CDP engine's whole
	 *     promotion model assumes it (secondary-leg adoptions park with no promotion channel —
	 *     browserPageDisposition), and SCK window capture is a strictly-degraded fallback (a
	 *     runner-side pixel stream, coarser and costlier than driving CDP). So BOTH a web-primary
	 *     CDP connect that is refusing AND any SCK stream are upgraded away from the moment
	 *     :9222 answers: the current engine is dropped and the normal attach path reconnects
	 *     app-CDP. The web-CDP case is gated on `refusing` (a web arm streaming a static page
	 *     emits no frames and must not be stolen); SCK is always upgraded, because app-CDP beats
	 *     it unconditionally.
	 *  2. TUNNEL HEALTH. A wedged ssh forward accepts TCP and drops HTTP, so frames stop while
	 *     the panel stays "live" on its last blob; ssh's own ServerAlive needs ~45s to notice.
	 *     After ENGINE_SILENCE_PROBE_MS without a frame or engine event, the engine's own local
	 *     port gets one HTTP probe (the CDP slot's /json/version, or the SCK tunnel's liveview
	 *     server): a reply means static-but-healthy (bump the clock — readiness is HTTP, never
	 *     TCP); a network error means drop the engine and recycle its tunnel.
	 *  3. SCK FALLBACK. When nothing has been delivered for SCK_FALLBACK_AFTER_MS — no engine
	 *     after the probe budget (an ax arm opens no debug port; peek-prep cannot repair a busy
	 *     host), a CDP engine refusing everything, or an attach that never produced a frame —
	 *     and no SCK stream is already up or in flight, ask the runner to window-capture the
	 *     host. Edge-guarded by sckInFlight; a delivered frame (from either engine) resets the
	 *     clock so it never fires against a working stream.
	 */
	const sentinelTick = async (p: Peek): Promise<void> => {
		if (peeks.get(p.host) !== p || p.closing || p.sentinelBusy) return;
		p.sentinelBusy = true;
		try {
			const engine = p.engine;
			// 1. PRIMARY UPGRADE — app-CDP beats a refusing web-CDP and beats SCK unconditionally.
			if (engine && ((p.source === "cdp" && p.primarySlot === 1 && p.refusing) || p.source === "sck")) {
				const appUp = await endpointUp(p.locals[0].local);
				if (peeks.get(p.host) !== p || p.closing) return;
				if (appUp && p.engine === engine) {
					const wasSck = p.source === "sck";
					p.engine = undefined; // BEFORE close — the corpse's onExit must no-op
					p.source = undefined;
					engine.close();
					if (wasSck) teardownSckTunnel(p);
					// enterWaiting, never a direct reprobeTick: the reprobe timer is the ONE
					// reconnect driver, and racing a second tick against an onExit-armed one
					// double-connects and leaks the loser.
					enterWaiting(p, `app endpoint appeared on ${p.host} — moving the stream to it`);

					return;
				}
			}
			// 2. TUNNEL HEALTH — probe the current engine's own local port after silence.
			if (engine && p.engine === engine && Date.now() - p.lastActivityAt > ENGINE_SILENCE_PROBE_MS) {
				const cdpSlot = p.source === "cdp" ? p.primarySlot : undefined;
				const alive = cdpSlot !== undefined
					? await endpointUp(p.locals[cdpSlot].local)
					: p.source === "sck" && p.sckLocal
						? await portResponds(p.sckLocal)
						: true; // unknown source — leave it to onExit
				if (peeks.get(p.host) !== p || p.closing) return;
				if (alive) {
					p.lastActivityAt = Date.now();
				} else if (p.engine === engine) {
					p.engine = undefined;
					p.source = undefined;
					engine.close();
					if (cdpSlot !== undefined) p.tunnels[cdpSlot]?.kill("SIGTERM"); // exit handler respawns it
					else teardownSckTunnel(p);
					enterWaiting(p, `tunnel to ${p.host} stopped answering — rebuilding it`);

					return;
				}
			}
			// 3. SCK FALLBACK — nothing delivering for the threshold, and none already up/in flight.
			const delivering = p.engine && p.gotFrame && !p.refusing;
			if (!delivering && p.source !== "sck" && !p.sckInFlight && Date.now() - p.lastFrameAt > SCK_FALLBACK_AFTER_MS) {
				await startSckFallback(p);
			}
		} catch {
			// A sentinel pass that failed (probe threw, import hiccup) tries again next tick —
			// it is a watchdog, and a watchdog that can crash its session is worse than none.
		} finally {
			p.sentinelBusy = false;
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

		const p: Peek = { host: hostName, hostCfg: host, locals, tunnels: [], respawnCounts: [0, 0], respawnTimers: [], gotFrame: false, streamLogged: false, refusing: false, lastActivityAt: Date.now(), lastFrameAt: Date.now(), state: "probing", sockets: new Set(), closing: false, sentinelBusy: false, sckInFlight: false, tunnelErrs: [], stormLogged: [false, false] };
		peeks.set(hostName, p);
		addEvent(`view: attach ${hostName}`);
		// No await from here to attachLoop: the caller's socket must attach before any engine
		// event can fire (the buffered-inert-error-to-zero-sockets bug, fixed structurally —
		// attach is fully asynchronous and this function never probes or connects).
		spawnTunnel(p, 0, tunnelArgv);
		spawnTunnel(p, 1, tunnelArgv);
		p.heartbeatTimer = setInterval(() => castJson(p, { ev: "ping" }), HEARTBEAT_MS);
		p.sentinelTimer = setInterval(() => void sentinelTick(p), SENTINEL_MS);
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
	/**
	 * Detail, with a fresh checkpoint off the run's busy Mac when one applies: a RUNNING
	 * fleet explore's map-so-far lives only in its run dir on the host (checkpoint.json —
	 * explore/artifacts.ts rewrites it on every `record`), so it is fetched ON DEMAND, per
	 * detail open, never on the fleet poll — nobody pays ssh for a pane nobody is looking
	 * at. Same guarded path machinery as the event tails; any failure (unreachable host,
	 * no file yet, torn JSON mid-write) simply serves the local tiers instead.
	 */
	const serveDetail = async (res: http.ServerResponse, job: string): Promise<void> => {
		let remoteCheckpoint: Record<string, any> | undefined;
		const entry = manifest.entries.find((e) => e.jobId === job);
		const arm = entry ? armById(entry.armId) : undefined;
		if (entry && !entry.collected && entry.host && arm?.kind === "explore" && inventory && SAFE_RUN_ID.test(job)) {
			try {
				const host = resolveHost(entry.host, inventory);
				let root = remoteRootCache.get(entry.host);
				if (!root) {
					root = await remoteDataRoot(host, runSsh);
					if (root) remoteRootCache.set(entry.host, root);
				}
				if (root) {
					const remote = `${root}/out/${LIVE_DIR}/${job}/${RUN_FILES.checkpoint}`;
					assertSafeRemotePath(remote);
					const r = await runSsh(host, ["cat", remote], {});
					if (r.code === 0) remoteCheckpoint = JSON.parse(r.stdout);
				}
			} catch {
				// Local tiers answer — a 4s ssh timeout on a busy Mac is routine, not evidence.
			}
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(buildDetail(job, manifest, remoteCheckpoint ? { remoteCheckpoint } : {})));
	};

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

	/**
	 * A filmed run's cursor render, ranged — `/api/video?job=<id>`.
	 *
	 * The one BINARY route, and the only one that streams rather than buffers: an mp4 read into
	 * a string to be written once would hold a megabyte per concurrent viewer and defeat seeking
	 * entirely. Range support is not optional for `<video>` — Chromium will not seek a resource
	 * that does not advertise `accept-ranges`, and Safari refuses to play one at all — so this
	 * answers 206 with a content-range or 200 with the whole file, exactly as the Electron
	 * gallery's protocol handler does (electron/main.ts). Both call the same parser.
	 *
	 * LOCAL FILES ONLY, on purpose. Every other per-run route has a remote tier that shells ssh
	 * for artifacts still on a colo Mac; this one deliberately has none. A 36 MB recording is not
	 * something to stream over an ssh pipe on a page render, and `bench collect` already pulls
	 * the render as part of banking the run — so "no video here" means "not collected yet",
	 * which is a true and useful thing for the board to say.
	 *
	 * Share mode needs no special case: it serves whatever the snapshot carried, and the
	 * snapshot carries exactly the renders (snapshot.ts's CURSOR_RENDER) and none of the frames.
	 */
	const serveVideo = (req: http.IncomingMessage, res: http.ServerResponse, job: string): void => {
		// LOG_JOB_RE, not the looser SAFE_RUN_ID: the id becomes a path segment here, and that
		// regex is the one that also rejects "." and ".." — see its comment.
		if (!LOG_JOB_RE.test(job)) {
			res.writeHead(400, { "content-type": "text/plain" });
			res.end("bad job id");

			return;
		}
		const file = path.join(runFile(job, RUN_FILES.recording), CURSOR_RENDER);
		let size: number;
		try {
			const st = fs.statSync(file);
			if (!st.isFile()) throw new Error("not a file");
			size = st.size;
		} catch {
			// Unfilmed, not yet collected, or the render has not been composited — all the same
			// answer to a viewer, and the dropdown only asks when buildDetail said `video`.
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("no cursor render for this run");

			return;
		}
		const range = parseByteRange(req.headers.range ?? null, size);
		if (range.kind === "unsatisfiable") {
			res.writeHead(416, { "content-range": `bytes */${size}` });
			res.end();

			return;
		}
		// A run's artifacts are written once and never edited (see paths.ts's archive note), so
		// the render at a given job id is immutable — worth saying out loud to a browser that
		// would otherwise re-fetch a megabyte every time a row is reopened.
		const headers = { "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "private, max-age=31536000, immutable" };
		if (range.kind === "part") {
			res.writeHead(206, { ...headers, "content-range": `bytes ${range.start}-${range.end}/${size}`, "content-length": String(range.end - range.start + 1) });
			fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);

			return;
		}
		res.writeHead(200, { ...headers, "content-length": String(size) });
		fs.createReadStream(file).pipe(res);
	};

	const server = http.createServer((req, res) => {
		const url = req.url ?? "/";
		// The ONE route in front of the auth gate, and the only one that may be.
		//
		// A PaaS health check is an unauthenticated GET that must answer 200 or the platform
		// concludes the service is down and restarts it forever — so a dash behind DASH_AUTH
		// would fail its own health check with a 401 and never come up. This answers the
		// liveness question and NOTHING else: no date, no counts, no store paths, nothing that
		// distinguishes one deployment from another. Everything a viewer would actually want is
		// on the far side of the gate.
		if (url === "/healthz") {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("ok");

			return;
		}
		// Before the route table, with no exemptions — not the page, not /api/state, not the SSE
		// stream. An unauthenticated "just the dashboard" route is the whole dataset, because the
		// page's only job is to render /api/state.
		if (authGate && !authGate(req.headers.authorization)) {
			// The realm string is what the browser shows in its prompt, so it names the thing.
			res.writeHead(401, { "www-authenticate": 'Basic realm="dash", charset="UTF-8"' });
			res.end("unauthorized");

			return;
		}
		if (url === "/" || url === "/index.html") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(fs.readFileSync(htmlPath));
		} else if (url === "/api/state") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(currentState(), null, "\t"));
		} else if (url.startsWith("/api/detail")) {
			// Async like /api/logs: a running fleet explore's detail may ssh for its checkpoint.
			void serveDetail(res, new URL(url, "http://localhost").searchParams.get("job") ?? "");
		} else if (url.startsWith("/api/logs")) {
			// Async by necessity (ssh); serveLogs answers every path itself, including throws.
			void serveLogs(res, new URL(url, "http://localhost").searchParams);
		} else if (url.startsWith("/api/video")) {
			serveVideo(req, res, new URL(url, "http://localhost").searchParams.get("job") ?? "");
		} else if (url === "/events") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			res.write(`data: ${JSON.stringify(currentState())}\n\n`);
			clients.add(res);
			req.on("close", () => clients.delete(res));
		} else if (url.startsWith("/graphs") || url.startsWith("/api/graphs/")) {
			if (!serveGraphs(req, res, url, { manifest: () => manifest, currentState })) {
				res.writeHead(404);
				res.end("not found");
			}
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
		// Share mode never streams a screen. The peek is the one dash capability that reaches
		// INTO a colo Mac and pulls live pixels off it, and a published URL must not be a window
		// into the fleet no matter who is behind the password. Destroyed rather than politely
		// closed: there is no session to explain, and the armed client treats a dead upgrade as
		// "no peek here", which is exactly true.
		if (share || url.pathname !== "/peek" || typeof key !== "string") {
			socket.destroy();

			return;
		}
		// The upgrade path carries the same credential as every other route — a WebSocket is not
		// a side door, and the browser sends Authorization on an upgrade it initiated.
		if (authGate && !authGate(req.headers.authorization)) {
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
		// The last JPEG, streaming sessions only (setStatus drops it on every exit from
		// "streaming"): a reconnecting viewer — the 12s staleness watchdog's force-close, a
		// reload — repaints instantly instead of holding a spinner until the target's next
		// compositor commit, which a static screen may not produce for minutes.
		if (session.lastFrame) {
			try {
				socket.write(wslib.encodeFrame(session.lastFrame, "binary"));
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
			// Share mode says what it withheld, not just what it is: "no fleet" is the difference
			// between a dash that cannot reach the Macs and one that was told not to try.
			console.log(share
				? `DASH (share): http://localhost:${port}  (date ${date}, ${frozen ? "frozen store — non-terminal states retired for display" : "LIVE store — states as the manifest reports them"}, no fleet, no peek, no narrator, ${authGate ? "auth ON" : "PUBLIC — no auth, anyone with the URL can read this board"})`
				: `DASH (David's Agent Supervision Hub): http://localhost:${port}  (date ${date}, fleet poll ${FLEET_POLL_SEC}s, ${autoCollect ? `auto-collect ${COLLECT_SEC}s` : "collect OFF — pure reader"}${authGate ? ", auth ON" : ""})`);
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
	// Share mode runs NEITHER loop. The fleet poll is the dash's steadiest outbound act — an ssh
	// fan-out to three colo Macs every 5s — and against a snapshot it can only ever report the
	// hosts as unreachable, which is noise dressed as a finding. The narrator is skipped because
	// it is the one thing that writes; the notes the pass earned already rode in with it.
	if (!share) {
		setInterval(pollFleet, FLEET_POLL_SEC * 1000);
		void pollFleet();
	}
	if (runCollect) {
		setInterval(runCollect, COLLECT_SEC * 1000);
		void runCollect();
	}
	// Piggybacks the collect cadence: a tick only calls the model when a run collected that
	// has no note yet, so a quiet hour costs nothing.
	if (!share) {
		setInterval(() => void narrate(), COLLECT_SEC * 1000);
		void narrate();
	}

	return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	startDash(parseDashArgs(process.argv.slice(2))).catch((err) => {
		console.error(`dash failed: ${err}`);
		process.exit(1);
	});
