import fs from "node:fs";
import path from "node:path";
import { findScopeAmbiguities } from "../core/harness.js";
import { readJournal } from "../core/journal.js";
import { RUN_FILES, appSlug, dataRoot as dataRootDir, liveDir, outDir, resourcesRoot, runFile } from "../paths.js";
import { appmapSlug } from "../core/target.js";
import type { JobRecord } from "../remote/runner/jobs.js";
import { type Arm, armAppmapSlug, armById } from "./matrix.js";
import { archiveBench, benchDir, readManifest, type Manifest, type ManifestEntry, type RunMetrics, updateEntry, utcDate, writeManifest } from "./manifest.js";
import { writeReport } from "./report.js";

/**
 * Turn pulled artifacts into manifest metrics.
 *
 * Collect is a pure reader over what the fleet already produced: it never dispatches, never
 * re-runs anything, and computing the same entry twice writes the same bytes — which is what
 * lets it run repeatedly while the queue drains, folding in whatever has landed since. The
 * parse functions are exported and pure so tests feed them fixture files instead of out/.
 *
 * Judgment stays out of this module by design. The journal's `scope` values are recorded
 * per mutation exactly as written; whether a document-scope mutation was WRONG for a given
 * task is the report's (and ultimately the reader's) call — see the plan's wrong-scope note.
 * The judge fields below don't break that rule: the judgment lives in the `.judge.json`
 * artifact the judge step froze, and collect only carries it — reading a verdict someone
 * else wrote is still reading.
 */

/** Terminal job states — the ones where waiting longer changes nothing. */
const TERMINAL = new Set(["done", "failed", "stopped", "orphaned"]);

const seconds = (from?: string, to?: string): number | undefined => {
	if (!from || !to) return undefined;
	const ms = Date.parse(to) - Date.parse(from);

	return Number.isFinite(ms) ? Math.round(ms / 1000) : undefined;
};

/** Mean of a numeric step field, one decimal, or undefined when no step carries it. */
const mean = (steps: Array<Record<string, any>>, field: string): number | undefined => {
	const vals = steps.map((s) => s[field]).filter((v): v is number => typeof v === "number");

	return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : undefined;
};

/** Metrics off a task or replay run log (out/bench/live/<stamp>/run.json). Absent fields stay absent. */
export function parseRunMetrics(runLog: Record<string, any>): RunMetrics {
	const usage = runLog.usage ?? {};
	const steps: Array<Record<string, any>> = Array.isArray(runLog.steps) ? runLog.steps : [];

	return {
		...(typeof runLog.success === "boolean" ? { success: runLog.success } : {}),
		steps: steps.length,
		...(typeof runLog.verifiedSteps === "number" ? { verifiedSteps: runLog.verifiedSteps } : {}),
		...(typeof runLog.unverifiedSteps === "number" ? { unverifiedSteps: runLog.unverifiedSteps } : {}),
		...(runLog.verifiedByChannel ? { verifiedByChannel: runLog.verifiedByChannel } : {}),
		...(typeof runLog.expectationRejections === "number" ? { expectationRejections: runLog.expectationRejections } : {}),
		...(typeof runLog.elapsedSec === "number" ? { elapsedSec: runLog.elapsedSec } : {}),
		...(typeof usage.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
		...(typeof usage.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
		...(typeof usage.cacheReadTokens === "number" ? { cacheReadTokens: usage.cacheReadTokens } : {}),
		...(typeof usage.cacheCreationTokens === "number" ? { cacheCreationTokens: usage.cacheCreationTokens } : {}),
		// Replay logs put modelCalls at the top level; live runs put it in usage.
		...(typeof usage.modelCalls === "number"
			? { modelCalls: usage.modelCalls }
			: typeof runLog.modelCalls === "number"
				? { modelCalls: runLog.modelCalls }
				: {}),
		...(runLog.grounding?.provenance ? { provenance: String(runLog.grounding.provenance) } : {}),
		// The run log's model is ground truth (makeClient records what actually ran); the
		// manifest's model field is only what dispatch asked for. Divergence is a finding.
		...(runLog.model ? { model: String(runLog.model) } : {}),
		// The wire that served the model. Grouping arms by model alone would merge a Sol run
		// routed through OpenRouter with one through Azure Responses.
		...(runLog.transport ? { transport: String(runLog.transport) } : {}),
		...(runLog.backend ? { backend: String(runLog.backend) } : {}),
		...(typeof runLog.vision === "boolean" ? { vision: runLog.vision } : {}),
		...(typeof runLog.ax === "boolean" ? { ax: runLog.ax } : {}),
		// Comparability caveat, not a metric: the first cdp smoke reported `none` where ax
		// reported `reset`, meaning the arms may not have started from the same app state.
		// Carried per run so the report can flag arms whose runs were not normalised.
		...(runLog.homeReset ? { homeReset: String(runLog.homeReset) } : {}),
		// The attention question: how much did each backend's channel say about the same
		// screen (observationNodes), and how much of that reached the prompt. Means over
		// steps, because step counts differ across runs of one arm.
		...(mean(steps, "observationNodes") !== undefined ? { meanObservationNodes: mean(steps, "observationNodes") } : {}),
		...(mean(steps, "listShownToModel") !== undefined ? { meanListShownToModel: mean(steps, "listShownToModel") } : {}),
		// The attention proxy proper: how deep into the offered list the model actually
		// reached. Steps that chose no element are absent from the field, so mean() skips
		// them rather than scoring them as index 0 — see the StepRecord comment.
		...(mean(steps, "chosenDepth") !== undefined ? { meanChosenDepth: mean(steps, "chosenDepth") } : {}),
		...(mean(steps, "chosenIndex") !== undefined ? { meanChosenIndex: mean(steps, "chosenIndex") } : {}),
		// The lever itself: the deepest index the arm ever needed. A list truncated below this
		// would have broken THIS run — it is the empirical floor for the observation budget.
		...(steps.some((st) => typeof st.chosenIndex === "number")
			? { maxChosenIndex: Math.max(...steps.filter((st) => typeof st.chosenIndex === "number").map((st) => st.chosenIndex as number)) }
			: {}),
		...(typeof runLog.finalCheck?.verified === "boolean" ? { finalCheckVerified: runLog.finalCheck.verified } : {}),
		...(runLog.visualCheck?.verdict ? { visualVerdict: String(runLog.visualCheck.verdict) } : {}),
		...(typeof runLog.recipeSteps === "number" ? { recipeSteps: runLog.recipeSteps } : {}),
		// Replay records mark a rescue in modelReasoning ("rescued after: …") — see replay.ts.
		...(typeof runLog.replayOf === "string"
			? { rescuedSteps: steps.filter((s) => typeof s.modelReasoning === "string" && s.modelReasoning.startsWith("rescued")).length }
			: {}),
	};
}

/**
 * The judge's verdict off a run's `.judge.json` artifact (src/core/judge.ts JudgeReport).
 * Absent fields stay absent, same as parseRunMetrics — a malformed artifact contributes
 * nothing rather than empty strings. `model` here is what actually judged, off the artifact,
 * which is the field that catches an operator's JUDGE_MODEL override splitting the pass.
 */
export function parseJudgeMetrics(report: Record<string, any>): RunMetrics {
	return {
		...(report.trajectory ? { judgeTrajectory: String(report.trajectory) } : {}),
		...(report.visual ? { judgeVisual: String(report.visual) } : {}),
		...(report.scope ? { judgeScope: String(report.scope) } : {}),
		...(report.model ? { judgeModel: String(report.model) } : {}),
		...(typeof report.framesUsed === "number" ? { judgeFrames: report.framesUsed } : {}),
	};
}

/**
 * Per-mutation scopes from the run's journal, in step order. `unset` is the journal's honest
 * refusal to guess (see attributeMutation in src/core/journal.ts) and is preserved as its
 * own value rather than folded into "unknown".
 */
export function journalScopes(journalPath: string): string[] {
	return readJournal(journalPath)
		.filter((m) => m.kind === "setting")
		.map((m) => m.scope ?? "unset");
}

/**
 * The stamp block atop an explore-produced appmap:
 * `<!-- provenance: explore | app: Yarn | … | actions: 96 | elapsed: 40m |
 *  controls: 47 actuated / 350 dismissed / 396 seen | surfaces: 34 | … -->`
 */
export function parseAppmapStamp(md: string): RunMetrics {
	// `explore-vision` must match too — the earlier `explore\s*\|` required the pipe right
	// after "explore", so a vision-only pass's appmap parsed to NOTHING and p1-explore-vision
	// would have collected no metrics at all while looking like a healthy arm.
	const stamp = md.match(/<!--\s*provenance: explore(?:-vision)?\s*\|([^>]*)-->/)?.[1] ?? "";
	const field = (name: string): string | undefined => stamp.match(new RegExp(`\\b${name}:\\s*([^|]+)`))?.[1]?.trim();
	const num = (name: string): number | undefined => {
		const n = Number(field(name));

		return Number.isFinite(n) ? n : undefined;
	};
	// Match the stamp directly, not via field(): a vision-only pass labels its tallies
	// `controls (DECLARED):` — self-reported, no element list to count against — and the
	// bare `controls:` lookup missed it, so the vision arm collected every metric EXCEPT
	// its control counts. Second divergence of the same class as the provenance regex fix
	// four lines up; tolerate the marker rather than normalise it away (it is a caveat).
	const controls = stamp.match(/\bcontrols(?:\s*\(DECLARED\))?:\s*(\d+)\s*actuated\s*\/\s*(\d+)\s*dismissed\s*\/\s*(\d+)\s*seen/);

	return {
		...(num("actions") !== undefined ? { exploreActions: num("actions") } : {}),
		...(field("elapsed") ? { exploreElapsed: field("elapsed") } : {}),
		// Token fields are absent from stamps written before 2026-07-31; an older appmap
		// simply contributes no cost, which is what "unknown" should look like.
		...(num("tokens-in") !== undefined ? { inputTokens: num("tokens-in") } : {}),
		...(num("tokens-out") !== undefined ? { outputTokens: num("tokens-out") } : {}),
		...(num("cache-read") !== undefined ? { cacheReadTokens: num("cache-read") } : {}),
		...(num("cache-write") !== undefined ? { cacheCreationTokens: num("cache-write") } : {}),
		...(num("calls") !== undefined ? { modelCalls: num("calls") } : {}),
		...(controls ? { controlsActuated: Number(controls[1]), controlsDismissed: Number(controls[2]), controlsSeen: Number(controls[3]) } : {}),
		...(num("surfaces") !== undefined ? { surfaces: num("surfaces") } : {}),
	};
}

/** Node/edge/ambiguity counts off the graph half of an appmap. Missing graph = no counts. */
export function parseGraphCounts(json: Record<string, any>): RunMetrics {
	const nodes = Array.isArray(json.nodes) ? json.nodes : [];
	const edges = Array.isArray(json.edges) ? json.edges : [];

	return {
		graphNodes: nodes.length,
		graphEdges: edges.length,
		scopeAmbiguities: findScopeAmbiguities({ nodes, edges } as any).length,
	};
}

/** Queue wait vs run time, off the job record — the split the plan's timing section wants. */
export function jobTiming(job: JobRecord): RunMetrics {
	return {
		...(job.queuedAt ? { queuedAt: job.queuedAt } : {}),
		...(job.startedAt ? { startedAt: job.startedAt } : {}),
		...(job.endedAt ? { endedAt: job.endedAt } : {}),
		...(seconds(job.queuedAt, job.startedAt) !== undefined ? { queueWaitSec: seconds(job.queuedAt, job.startedAt) } : {}),
		...(seconds(job.startedAt, job.endedAt) !== undefined ? { runSec: seconds(job.startedAt, job.endedAt) } : {}),
	};
}

const readJson = (file: string): Record<string, any> | undefined => {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};

export interface CollectPull {
	ok: boolean;
	job?: JobRecord;
	error?: string;
}

export interface CollectOptions {
	date?: string;
	/** The out/-shaped root the manifest lives under. Tests point this at a temp dir. */
	outRoot?: string;
	/** Where pulled artifacts are read from (out/runs, docs/appmaps under it). */
	dataDir?: string;
	/** The artifact fetch, injected so tests never rsync a real Mac. */
	pull?: (host: string, jobId: string) => Promise<CollectPull>;
	/** Where the report is (re)written. Tests point this at a temp dir. */
	reportDir?: string;
	log?: (line: string) => void;
}

export interface CollectOutcome {
	manifest: Manifest;
	collected: string[];
	pending: string[];
	reportPath?: string;
}

/**
 * One collect pass: for every manifest entry not yet collected, pull, read, compute, mark.
 * The manifest is rewritten after every entry (a crash mid-pass loses one entry's work, not
 * the pass) and the report skeleton is rewritten once at the end.
 */
export async function collect(opts: CollectOptions = {}): Promise<CollectOutcome> {
	const date = opts.date ?? utcDate();
	const outRoot = opts.outRoot ?? outDir();
	const dataDir = opts.dataDir ?? dataRootDir();
	const log = opts.log ?? console.error;
	const pull = opts.pull ?? (await defaultPull());
	const liveRoot = liveDir(outRoot);
	let manifest = readManifest(date, liveRoot);
	const collected: string[] = [];
	const pending: string[] = [];

	for (const entry of manifest.entries) {
		if (entry.collected) continue;
		// Local compiles are recorded collected at compile time; an uncollected "local" entry
		// is a bug upstream, reported rather than silently skipped forever.
		if (entry.host === "local") {
			pending.push(entry.jobId);
			log(`? ${entry.armId} ${entry.jobId}: local entry left uncollected — orchestrate should have marked it`);
			continue;
		}

		const pulled = await pull(entry.host, entry.jobId);
		const job = pulled.job;
		if (!pulled.ok && !job) {
			pending.push(entry.jobId);
			log(`✗ ${entry.armId} ${entry.jobId}: pull failed — ${pulled.error ?? "unknown"}`);
			continue;
		}

		const state = job?.state ?? entry.state;
		if (!TERMINAL.has(state)) {
			manifest = updateEntry(manifest, { ...entry, state });
			writeManifest(manifest, liveRoot);
			pending.push(entry.jobId);
			log(`… ${entry.armId} ${entry.jobId}: still ${state}`);
			continue;
		}

		const next = groundingChecked(collectEntry(entry, job, dataDir, state, benchDir(date, liveRoot)));
		await humanizePulled(entry, job, dataDir, log);
		manifest = updateEntry(manifest, next);
		writeManifest(manifest, liveRoot);
		collected.push(entry.jobId);
		log(`✓ ${entry.armId} ${entry.jobId}: ${state}${next.note ? ` — ${next.note}` : ""}`);
	}

	// After the pass, before the report: a host that is failing everything identically will
	// quietly eat every arm queued on it, and the operator finds out one 9-hour day later.
	// Advisory — nothing is dispatched or stopped from here — but LOUD, with the remedy named.
	for (const warning of poisonedHosts(manifest)) log(warning);

	const reportPath = writeReport(manifest, { ...(opts.reportDir ? { dir: opts.reportDir } : {}) });
	// A second copy beside the manifest it was rendered from. docs/research/ is where the report
	// is READ (committed, linked, shared); this one keeps the pass folder self-contained, so
	// handing someone out/bench/archive/<date>/ hands them the numbers and their provenance
	// together rather than a manifest plus instructions.
	try {
		fs.copyFileSync(reportPath, path.join(benchDir(date, liveRoot), path.basename(reportPath)));
	} catch (err) {
		log(`report copy into the pass folder failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	writeManifest(manifest, liveRoot);
	// Back the manifest family up on every collect, not only on the last one. Collect is where
	// the pass acquires the facts that cannot be recomputed — each arm's cost and tokens, the
	// per-job appmap copies, the judge verdicts — and it is idempotent and re-run repeatedly by
	// the dashboard, so "the last collect wins" is not a schedule anyone controls. Hard links
	// on kilobytes: cheap enough that there is no reason to be selective.
	try {
		archiveBench(date, outRoot);
	} catch (err) {
		log(`backup: could not copy the manifest to out/bench/archive — ${err instanceof Error ? err.message : String(err)}`);
	}

	return { manifest, collected, pending, reportPath };
}

/**
 * Where an explore arm's appmap pair is archived under the bench dir, keyed on
 * (model, armId) — the pair the report compares. Exists because docs/appmaps/<slug>.* is
 * ONE file per app by convention, so a second model's pass overwrites the first's on disk;
 * the run logs pin each run's map by sha256, but the content itself would be gone.
 */
export function archiveDirFor(benchRoot: string, entry: ManifestEntry): string {
	const model = (entry.model ?? "default").replace(/[^A-Za-z0-9._-]+/g, "-");
	// Per JOB, not per arm. An explore arm with n>1 runs the same pass twice, and both write
	// the same live filename (yarn.ax.md) on their own Macs — so an arm-keyed archive keeps
	// only whichever was collected last, discarding the second sample and with it the entire
	// reason for repeating. The repeats exist to give the backend comparison an error bar;
	// an archive that holds one of two is worse than not repeating, because it looks complete.
	return path.join(benchRoot, "appmaps", model, entry.armId, entry.jobId);
}

/**
 * Composite the synthetic cursor over a filmed run, as part of collecting it.
 *
 * The recording the fleet produces has no cursor in it: Yarn reimposes one in post, and
 * `humanize` draws it from the run's OWN trajectory — click points, target rects, and the
 * real typing timings the run recorded. Until now that was a manual `npm run humanize --
 * <stamp>` per filmed run, which for a 16-take phase 5 is 16 commands nobody will remember to
 * run, on artifacts that are ~200MB each and cannot be re-rendered once the frames are gone.
 *
 * Shelled out rather than called: humanize is a script whose work lives inside main(), and it
 * spawns a Python renderer anyway, so a subprocess is the honest shape.
 *
 * Idempotent and non-fatal, like the rest of collect. A run whose cursor render already
 * exists is skipped, and a render failure is a log line — the measurement is already banked
 * by the time this runs, and losing it to a video step would be the wrong trade. HUMANIZE=0
 * turns it off.
 */
async function humanizePulled(entry: ManifestEntry, job: Record<string, any> | undefined, dataDir: string, log: (s: string) => void): Promise<void> {
	if (process.env.HUMANIZE === "0") return;
	// Only filmed runs have a recording to draw on; the arm's own flag is the authority
	// because a job record can predate the flag being persisted.
	if (!armById(entry.armId)?.dispatch.record && !job?.artifacts?.recording) return;
	const dir = runFile(entry.jobId, RUN_FILES.recording, path.join(dataDir, "out"));
	if (!fs.existsSync(path.join(dir, "frames"))) return;
	// humanize.ts writes humanized.mp4 beside the raw window.mp4; present means done.
	if (fs.existsSync(path.join(dir, "humanized.mp4"))) return;

	try {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		await promisify(execFile)("npx", ["tsx", "src/cursor/humanize.ts", entry.jobId], { cwd: resourcesRoot(), timeout: 10 * 60_000 });
		log(`  ↳ cursor composited for ${entry.jobId}`);
	} catch (e) {
		log(`  ↳ cursor render failed for ${entry.jobId}: ${(e as Error).message.slice(0, 120)}`);
	}
}

/**
 * Did this run actually get the grounding its arm declares? Recorded provenance vs intent.
 *
 * `loadGrounding` returns provenance "none" for a missing map, so an arm whose map never
 * reached the Mac it landed on runs UNGROUNDED and reports a plausible, slightly-worse number
 * under a grounded label. The field has been written since the collector was built and read
 * by NOTHING — the matrix delegated the check to a human remembering to look at it.
 *
 * This is the cheapest detector for a whole class of defect rather than one bug: a map that
 * was not synced to the host, a variant that never crossed the wire, a slug that named a
 * sibling's file, a tier that silently fell back. Each of those produces a number; this turns
 * every one of them into a red row instead.
 *
 * Advisory on the entry, not a hard refusal: the run happened and its artifacts are real, and
 * a collector that discarded them would lose the evidence needed to diagnose the mismatch.
 */
export function expectedProvenance(arm: Arm): RunMetrics["provenance"] {
	if (arm.dispatch.noGrounding) return "none";
	if (arm.dispatch.useProcedures) return "procedure";
	if (arm.dispatch.useRecipe) return "curated";

	return arm.env?.APPMAP_VARIANT === "vision" ? "explore-vision" : "explore";
}

function groundingChecked(entry: ManifestEntry): ManifestEntry {
	const arm = armById(entry.armId);
	// Only task-shaped runs load grounding; an explore pass HAS no provenance of its own, and
	// a run that never produced a log has a more basic problem already recorded.
	if (!arm || arm.kind !== "task" || !entry.metrics || entry.metrics.provenance === undefined) return entry;
	const want = expectedProvenance(arm);
	if (entry.metrics.provenance === want) return entry;

	return {
		...entry,
		metrics: { ...entry.metrics, failureKind: "grounding-mismatch" },
		note: `${entry.note ? `${entry.note}; ` : ""}GROUNDING MISMATCH: arm declares ${want}, run reports ${entry.metrics.provenance} — this run did not get the grounding its row claims`,
	};
}

/** Consecutive identical failures on one host before it is called poisoned. */
const POISON_STREAK = 3;

/** The remedy each failure kind calls for, printed with the warning so it is actionable. */
const POISON_REMEDY: Record<string, string> = {
	unready: 'the app is not at its home state there — usually signed out. Fix: ./run signin <host> "<App>"',
	crashed: "runs are dying before writing a log — check the Mac (runner log, disk, TCC grants): ./run provision --doctor",
	"hinted-refused": "the prompt audit is refusing on that host — its checkout may be stale: ./run provision",
	"gave-up": "the agent runs but keeps failing there — compare its runs against the same arm on other hosts before trusting arm numbers",
};

/**
 * Hosts whose last POISON_STREAK collected runs ALL failed the same way.
 *
 * The failure shape this exists for happened before the matrix ever ran: Yarn signed out on
 * two of three Macs, which fails every run queued there with exit 3 while the third Mac's
 * runs sail through — and an arm's "1/3 success" then measures the FLEET, not the model.
 * Same-kind is required because three different failures are more likely three unlucky runs
 * than one broken host. Entries are ordered by collection (manifest append order).
 */
export function poisonedHosts(m: Manifest): string[] {
	const byHost = new Map<string, ManifestEntry[]>();
	for (const e of m.entries) {
		if (!e.collected || e.host === "local" || !e.metrics) continue;
		byHost.set(e.host, [...(byHost.get(e.host) ?? []), e]);
	}

	const warnings: string[] = [];
	for (const [host, entries] of byHost) {
		const tail = entries.slice(-POISON_STREAK);
		if (tail.length < POISON_STREAK) continue;
		const kinds = tail.map((e) => e.metrics?.failureKind).filter(Boolean);
		if (kinds.length < POISON_STREAK || new Set(kinds).size !== 1) continue;
		const kind = kinds[0] as string;
		warnings.push(
			`⚠ POISONED HOST: the last ${POISON_STREAK} runs on ${host} all failed as "${kind}" ` +
				`(${tail.map((e) => e.jobId).join(", ")}). ${POISON_REMEDY[kind] ?? "investigate before queuing more arms there"}. ` +
				`Runs already queued on ${host} will likely fail the same way — cancel them from the fleet panel if the cause is host-side.`,
		);
	}

	return warnings;
}

/**
 * WHY a run failed — the classification the arm rollups aggregate. `success: false` alone
 * collapses a signed-out host, an agent that honestly gave up, and a SIGKILL into one
 * number, and those three call for entirely different responses (sign in / read the run /
 * check the Mac). Exit codes come off the job record; the run log's own verdict wins when
 * one exists, because the child's exit code can be lost (`null`) while the log is intact.
 */
export function failureKind(
	job: JobRecord | undefined,
	metrics: RunMetrics,
	hasRunLog: boolean,
): RunMetrics["failureKind"] | undefined {
	if (metrics.success === true) return undefined;
	if (job?.state === "stopped") return "stopped";
	if (job?.exitCode === 3) return "unready";
	if (job?.exitCode === 2) return "hinted-refused";
	// A run log that says success:false is the agent's own conclusion — it ran to a verdict.
	if (hasRunLog && metrics.success === false) return "gave-up";
	// No run log on a terminal job: orphaned, signalled, or died before the first write.
	return "crashed";
}

/** Metrics for one terminal entry, from whatever artifacts landed. Missing files become notes. */
function collectEntry(entry: ManifestEntry, job: JobRecord | undefined, dataDir: string, state: string, benchRoot?: string): ManifestEntry {
	const arm = armById(entry.armId);
	const notes: string[] = [];
	let metrics: RunMetrics = job ? jobTiming(job) : {};

	if (arm?.kind === "explore") {
		// The job record names the exact artifact paths; the slug fallback covers a job record
		// that carries none (older runner, or a record written before the queue drain) — and a
		// record whose path names a file that DOES NOT EXIST. That last case is real: a runner
		// running pre-unification code recorded `https-app.notion.com.md` for a pass that wrote
		// `web-app.notion.com.md`, and honoring the stale record over the shared derivation
		// re-froze empty metrics on every re-collect. The record wins only when its file is there.
		// armAppmapSlug, not a hand-assembled call: this one omitted axdomOff, so
		// p1-explore-ax-noaxdom was graded against p1-explore-ax's map — the existsSync guard
		// passing precisely BECAUSE the sibling's file was sitting there. The two arms would
		// have reported byte-identical numbers and the sidecar would have looked worthless.
		//
		// FIRST CHOICE is the run's OWN copy (out/bench/live/<jobId>/appmap.md), written by the
		// pass itself since 2026-08-01. docs/appmaps is keyed by APP, so a second pass on the same
		// variant overwrites it — and on a three-Mac fleet the passes that share a variant finish
		// minutes apart. Reading the app-keyed file has always been a race that collect happened
		// to win; the run-keyed copy cannot be overwritten by anything.
		const dataOut = path.join(dataDir, "out");
		const own = runFile(entry.jobId, RUN_FILES.appmap, dataOut);
		const derived = path.join(dataDir, `docs/appmaps/${armAppmapSlug(arm)}.md`);
		const recorded = job?.artifacts?.appmap ? path.join(dataDir, job.artifacts.appmap) : undefined;
		const md = fs.existsSync(own) ? own : recorded && fs.existsSync(recorded) ? recorded : derived;
		const ownGraph = runFile(entry.jobId, RUN_FILES.appmapGraph, dataOut);
		const recordedGraph = job?.artifacts?.appmapGraph ? path.join(dataDir, job.artifacts.appmapGraph) : undefined;
		const graphFile = md === own && fs.existsSync(ownGraph) ? ownGraph : recordedGraph && fs.existsSync(recordedGraph) ? recordedGraph : md.replace(/\.md$/, ".json");
		try {
			metrics = { ...metrics, ...parseAppmapStamp(fs.readFileSync(md, "utf8")) };
		} catch {
			notes.push(`no appmap at ${md}`);
		}
		const graph = readJson(graphFile);
		if (graph) metrics = { ...metrics, ...parseGraphCounts(graph) };
		else notes.push("no appmap graph");
		// Archive the map pair beside the manifest — see archiveDirFor for why losing the
		// live file to the next pass's overwrite is otherwise unrecoverable.
		if (benchRoot) {
			const keep = archiveDirFor(benchRoot, entry);
			try {
				fs.mkdirSync(keep, { recursive: true });
				fs.copyFileSync(md, path.join(keep, path.basename(md)));
				if (fs.existsSync(graphFile)) fs.copyFileSync(graphFile, path.join(keep, path.basename(graphFile)));
			} catch (e) {
				notes.push(`appmap archive failed: ${(e as Error).message}`);
			}
		}
	} else {
		const runLog = readJson(job?.artifacts?.runLog ? path.join(dataDir, job.artifacts.runLog) : runFile(entry.jobId, RUN_FILES.log, path.join(dataDir, "out")));
		if (runLog) metrics = { ...metrics, ...parseRunMetrics(runLog) };
		else {
			// A terminal job with no run log is itself the datum — the run died before writing
			// one. Recorded as a failure so the arm's success rate reflects it.
			metrics = { ...metrics, success: false };
			notes.push("no run log — counted as failure");
		}
		const kind = failureKind(job, metrics, runLog !== undefined);
		if (kind) metrics = { ...metrics, failureKind: kind };
		// A missing judge artifact is NOT a note: judging is optional and may run after this
		// collect — the step is batched between pull and report, and collect is re-run as the
		// queue drains, so a later pass folds the verdict in when it lands.
		const judgeReport = readJson(runFile(entry.jobId, RUN_FILES.judge, path.join(dataDir, "out")));
		if (judgeReport) metrics = { ...metrics, ...parseJudgeMetrics(judgeReport) };
		const scopes = journalScopes(runFile(entry.jobId, RUN_FILES.journal, path.join(dataDir, "out")));
		if (scopes.length) metrics = { ...metrics, mutationScopes: scopes };
	}

	return {
		...entry,
		state,
		collected: true,
		metrics,
		...(notes.length ? { note: notes.join("; ") } : {}),
	};
}

/** Production pull, loaded lazily so tests (which always inject) never touch ssh machinery. */
async function defaultPull(): Promise<(host: string, jobId: string) => Promise<CollectPull>> {
	const { pull } = await import("../remote/control/dispatch.js");

	return async (host, jobId) => {
		const r = await pull(host, jobId);

		return { ok: r.ok, ...(r.job ? { job: r.job } : {}), ...(r.error ? { error: r.error } : {}) };
	};
}
