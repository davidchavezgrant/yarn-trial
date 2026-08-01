import fs from "node:fs";
import path from "node:path";
import { outDir } from "../paths.js";
import type { Phase } from "./matrix.js";

/**
 * The benchmark's durable memory: which runs were submitted, where, and what came back.
 *
 * The manifest is the source of truth for `bench collect` and for phase gating (phase 2
 * refuses without phase-1 explore stamps), so it must survive the orchestrator process the
 * same way the job registry survives the runner — the fleet drains a queue for hours after
 * the submit, and the laptop that submitted is allowed to close its lid. Same atomic
 * write discipline as writeJob in src/remote/runner/jobs.ts: sibling temp file + rename,
 * cleaned up on failure, so a poll mid-write reads the previous manifest, never half of one.
 *
 * One manifest per benchmark day (out/bench/<UTC-date>/manifest.json): re-running a phase
 * appends samples to the same file, and a fresh benchmark on another day starts clean
 * without archaeology.
 */

export interface RunMetrics {
	/** Task/replay runs — straight off the pulled run log. */
	success?: boolean;
	steps?: number;
	verifiedSteps?: number;
	unverifiedSteps?: number;
	verifiedByChannel?: { text: number; geometry: number; pixel: number };
	expectationRejections?: number;
	elapsedSec?: number;
	inputTokens?: number;
	outputTokens?: number;
	meanChosenDepth?: number;
	meanChosenIndex?: number;
	maxChosenIndex?: number;
	cacheReadTokens?: number;
	/** Cache WRITES. Bills at 1.25x input against reads' 0.1x, so it dominates run cost. */
	cacheCreationTokens?: number;
	modelCalls?: number;
	provenance?: string;
	/** What actually ran, off the run log — the manifest entry's `model` is only what was asked for. */
	model?: string;
	/** Which wire served it: anthropic | openrouter | azure-responses. See makeClient. */
	transport?: string;
	backend?: string;
	vision?: boolean;
	ax?: boolean;
	finalCheckVerified?: boolean;
	visualVerdict?: string;
	/**
	 * Per-mutation scopes from the journal, in step order. Recorded raw — the report decides
	 * what counts as wrong-scope for a given task; this module holds no judgment.
	 */
	mutationScopes?: string[];
	/**
	 * Comparability caveat, not a metric: `reset`/`none`/`failed`/`skipped` off the run log.
	 * The first cdp smoke reported `none` where ax reported `reset` — arms whose runs did not
	 * start from the declared home state are flagged in the report rather than compared raw.
	 */
	homeReset?: string;
	/**
	 * WHY a run failed, when it did — `success: false` alone collapses distinctions the
	 * report's conclusions turn on. `unready` (exit 3: the app was not at home — usually
	 * signed out; a host problem, not a model problem), `gave-up` (the agent ran and
	 * concluded failure), `hinted-refused` (exit 2: the prompt audit), `stopped` (an
	 * operator), `crashed` (terminal with no run log, an orphan, or a kill signal).
	 * Absent on successes.
	 */
	/**
	 * "grounding-mismatch" is not a run failure — the run completed. It means the run did not
	 * receive the grounding its arm declares (a map that never reached the host, a variant
	 * that never crossed the wire, a slug naming a sibling's file), so its number is real but
	 * mislabelled. Kept in the same field because it disqualifies a row from its arm's
	 * average exactly as a failure does.
	 */
	failureKind?: "unready" | "gave-up" | "hinted-refused" | "stopped" | "crashed" | "grounding-mismatch";
	/**
	 * The attention question, per run: mean interactive elements per pre-action observation,
	 * and mean element-list lines actually rendered into the prompt (0 on vision-only arms).
	 * The ax/cdp gap here is "leaner"; whether leaner is denser or blinder is answered by the
	 * explore metrics below (controls/graph size), not by these.
	 */
	meanObservationNodes?: number;
	meanListShownToModel?: number;
	/**
	 * The offline adversarial judge (src/core/judge.ts), off the run's `.judge.json` artifact.
	 * A second opinion, not a replacement verdict: `success` is the run grading itself, the
	 * judge is a separate model refuting it against the appmap scope rubric — DISAGREEMENT
	 * between the two is the finding the report surfaces. Frozen into the artifact when the
	 * judge step runs, so collect stays a deterministic reader: re-collecting never re-rolls
	 * the model call.
	 */
	judgeTrajectory?: string;  // PASS | FAIL | UNPROVEN
	judgeVisual?: string;      // PASS | FAIL | UNPROVEN | UNAVAILABLE
	judgeScope?: string;
	judgeModel?: string;       // what actually judged, off the artifact
	judgeFrames?: number;      // framesUsed
	/** Replay runs. */
	recipeSteps?: number;
	rescuedSteps?: number;
	/** Explore passes — parsed from the appmap stamp + graph. */
	controlsActuated?: number;
	controlsDismissed?: number;
	controlsSeen?: number;
	surfaces?: number;
	exploreActions?: number;
	exploreElapsed?: string;
	graphNodes?: number;
	graphEdges?: number;
	scopeAmbiguities?: number;
	/** Job-record timing: queue wait vs run time, per the plan's metrics list. */
	queuedAt?: string;
	startedAt?: string;
	endedAt?: string;
	queueWaitSec?: number;
	runSec?: number;
}

export interface ManifestEntry {
	armId: string;
	/** The remote job id (== run stamp). Compiles are local: jobId is the compile stamp source. */
	jobId: string;
	/** Host name, or "local" for phase-3 compiles. */
	host: string;
	submittedAt: string;
	/** Last known job state; collect refreshes it from the pulled job record. */
	state: string;
	collected: boolean;
	/** Pre-run env the runner must carry (e.g. APPMAP_VARIANT=vision) — see Arm.env. */
	env?: Record<string, string>;
	/**
	 * Which model this run was dispatched under (`bench phase --model <id>`). Absent on
	 * entries from before the model dimension; the run log's own `model` field is the
	 * ground truth either way and collect records it into metrics.
	 */
	model?: string;
	/** Replay arms: the recipe file the run replays, data-root-relative. */
	recipe?: string;
	metrics?: RunMetrics;
	/** Why collect could not finish this entry (missing artifact, unreadable log). */
	note?: string;
}

export interface Manifest {
	/** UTC date the benchmark started; also the directory name. */
	date: string;
	createdAt: string;
	entries: ManifestEntry[];
}

/** UTC calendar date, the manifest's identity. */
export const utcDate = (now = new Date()): string => now.toISOString().slice(0, 10);

export const benchDir = (date = utcDate(), root = outDir()): string => path.join(root, "bench", date);

export const manifestPath = (date = utcDate(), root = outDir()): string => path.join(benchDir(date, root), "manifest.json");

export function readManifest(date = utcDate(), root = outDir()): Manifest {
	const file = manifestPath(date, root);
	try {
		const m = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
		if (Array.isArray(m.entries)) return m;
	} catch {
		// Absent or unparseable both mean "no benchmark yet today" — writeManifest creates it.
	}

	return { date, createdAt: new Date().toISOString(), entries: [] };
}

/** Atomic replace, the writeJob pattern: sibling temp + rename, removed on any failure. */
export function writeManifest(m: Manifest, root = outDir()): void {
	const dir = benchDir(m.date, root);
	fs.mkdirSync(dir, { recursive: true });
	const target = path.join(dir, "manifest.json");
	const tmp = path.join(dir, `.manifest.json.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(m, null, "\t")}\n`);
		fs.renameSync(tmp, target);
	} catch (e) {
		fs.rmSync(tmp, { force: true });
		throw e;
	}
}

/**
 * Append accepted submissions. Duplicate (armId, jobId) pairs are dropped rather than
 * doubled, so a phase re-run that re-records an already-known job cannot inflate an arm's
 * sample count — the collect and the report both trust entry multiplicity.
 */
export function recordSubmissions(m: Manifest, entries: ManifestEntry[]): Manifest {
	const known = new Set(m.entries.map((e) => `${e.armId} ${e.jobId}`));
	const fresh = entries.filter((e) => !known.has(`${e.armId} ${e.jobId}`));

	return { ...m, entries: [...m.entries, ...fresh] };
}

/**
 * Replace one entry by (armId, jobId), the manifest's primary key. Collect calls this per
 * pulled run; calling it twice with the same result is a no-op by construction, which is
 * what makes collect idempotent.
 */
export function updateEntry(m: Manifest, entry: ManifestEntry): Manifest {
	return {
		...m,
		entries: m.entries.map((e) => (e.armId === entry.armId && e.jobId === entry.jobId ? entry : e)),
	};
}

/**
 * An arm's entries, scoped to one model pass. Model matters everywhere samples are counted:
 * the benchmark runs the whole matrix once per model (self-grounded — each model explores,
 * writes, and consumes its own maps), and pass B's top-up arithmetic reading pass A's
 * entries as its own samples would silently halve pass B. `model: undefined` matches only
 * pre-model-dimension entries, so old manifests keep their counts.
 */
export const entriesForArm = (m: Manifest, armId: string, model?: string): ManifestEntry[] =>
	m.entries.filter((e) => e.armId === armId && e.model === model);

/** How many samples an arm already has in this model's pass — the top-up arithmetic. */
export const submittedCount = (m: Manifest, armId: string, model?: string): number => entriesForArm(m, armId, model).length;

/**
 * Phase-2 gate: grounded arms read their own backend's phase-1 map, so a phase-1 explore
 * entry must exist AND have been collected (the pull is what lands the map + graph locally
 * and fans it out to the fleet) — FOR THIS MODEL'S PASS: self-grounding means pass B's
 * task runs must consume pass B's maps, and pass A's collected explores prove nothing
 * about what is on disk once pass B's explores overwrite them. `--force` overrides for a
 * benchmark that reuses maps from an earlier pass.
 */
export const hasCollectedExplores = (m: Manifest, phase1ArmIds: string[], model?: string): boolean =>
	phase1ArmIds.every((id) => entriesForArm(m, id, model).some((e) => e.collected));

export const phaseOf = (armId: string): Phase | undefined => {
	const n = Number(armId.match(/^p(\d)-/)?.[1]);

	return n === 1 || n === 2 || n === 3 || n === 4 ? n : undefined;
};
