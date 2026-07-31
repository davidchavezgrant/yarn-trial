import fs from "node:fs";
import path from "node:path";
import { findScopeAmbiguities } from "../core/harness.js";
import { readJournal } from "../core/journal.js";
import { appSlug, dataRoot as dataRootDir, outDir } from "../paths.js";
import type { JobRecord } from "../remote/runner/jobs.js";
import { armById } from "./matrix.js";
import { benchDir, type Manifest, type ManifestEntry, readManifest, type RunMetrics, updateEntry, utcDate, writeManifest } from "./manifest.js";
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

/** Metrics off a task or replay run log (out/runs/<stamp>.json). Absent fields stay absent. */
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
	const stamp = md.match(/<!--\s*provenance: explore\s*\|([^>]*)-->/)?.[1] ?? "";
	const field = (name: string): string | undefined => stamp.match(new RegExp(`\\b${name}:\\s*([^|]+)`))?.[1]?.trim();
	const num = (name: string): number | undefined => {
		const n = Number(field(name));

		return Number.isFinite(n) ? n : undefined;
	};
	const controls = field("controls")?.match(/(\d+)\s*actuated\s*\/\s*(\d+)\s*dismissed\s*\/\s*(\d+)\s*seen/);

	return {
		...(num("actions") !== undefined ? { exploreActions: num("actions") } : {}),
		...(field("elapsed") ? { exploreElapsed: field("elapsed") } : {}),
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
	let manifest = readManifest(date, outRoot);
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
			writeManifest(manifest, outRoot);
			pending.push(entry.jobId);
			log(`… ${entry.armId} ${entry.jobId}: still ${state}`);
			continue;
		}

		const next = collectEntry(entry, job, dataDir, state, benchDir(date, outRoot));
		manifest = updateEntry(manifest, next);
		writeManifest(manifest, outRoot);
		collected.push(entry.jobId);
		log(`✓ ${entry.armId} ${entry.jobId}: ${state}${next.note ? ` — ${next.note}` : ""}`);
	}

	const reportPath = writeReport(manifest, { ...(opts.reportDir ? { dir: opts.reportDir } : {}) });
	writeManifest(manifest, outRoot);

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

	return path.join(benchRoot, "appmaps", model, entry.armId);
}

/** Metrics for one terminal entry, from whatever artifacts landed. Missing files become notes. */
function collectEntry(entry: ManifestEntry, job: JobRecord | undefined, dataDir: string, state: string, benchRoot?: string): ManifestEntry {
	const arm = armById(entry.armId);
	const notes: string[] = [];
	let metrics: RunMetrics = job ? jobTiming(job) : {};

	if (arm?.kind === "explore") {
		// The job record names the exact artifact paths; the slug fallback covers a job record
		// that carries none (older runner, or a record written before the queue drain).
		const md = path.join(dataDir, job?.artifacts?.appmap ?? `docs/appmaps/${appSlug(arm.app)}.md`);
		const graphFile = job?.artifacts?.appmapGraph ? path.join(dataDir, job.artifacts.appmapGraph) : md.replace(/\.md$/, ".json");
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
		const runLog = readJson(path.join(dataDir, job?.artifacts?.runLog ?? `out/runs/${entry.jobId}.json`));
		if (runLog) metrics = { ...metrics, ...parseRunMetrics(runLog) };
		else {
			// A terminal job with no run log is itself the datum — the run died before writing
			// one. Recorded as a failure so the arm's success rate reflects it.
			metrics = { ...metrics, success: false };
			notes.push("no run log — counted as failure");
		}
		const scopes = journalScopes(path.join(dataDir, `out/runs/${entry.jobId}.journal.jsonl`));
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
