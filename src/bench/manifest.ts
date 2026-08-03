import fs from "node:fs";
import path from "node:path";
import { archiveDir, backupTree, liveDir, OLD_ARCHIVE_DIR, OLD_LIVE_DIR, outDir } from "../paths.js";
// A VALUE import, unlike the type-only one it replaces: readManifest canonicalises arm ids on
// the way in. Safe from a cycle — matrix.ts imports only core/target.js, never this file.
import { canonicalArmId, type Phase } from "./matrix.js";

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
 * One manifest per benchmark day (out/bench/live/<UTC-date>/manifest.json): re-running a
 * phase appends samples to the same file, and a fresh benchmark on another day starts clean
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
	/**
	 * `step-ceiling` | `stalled` — set when the HARNESS ended the run, not the agent. Absent on
	 * a run that reached its own verdict, which is what "gave-up" then means.
	 */
	stopReason?: string;
	/**
	 * Node count of the appmap graph this run was grounded on. The TIER alone is not the
	 * condition: phase 1's maps ranged 89–234 nodes, so two runs both reading `explore` can have
	 * had very different inputs. Present on ungrounded runs too — it records what was on the box,
	 * not what was injected — which is exactly what makes the comparison separable.
	 */
	groundingNodes?: number;
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
	/**
	 * `step-ceiling` and `stalled` are the HARNESS ending a run, not the agent. Distinct from
	 * gave-up on purpose: folding them together made a 15-step budget read as "the agent cannot
	 * make a video" for seven runs whose task needs 19.
	 */
	failureKind?: "unready" | "gave-up" | "hinted-refused" | "stopped" | "crashed" | "grounding-mismatch" | "step-ceiling" | "stalled";
	/**
	 * The attention question, per run: mean interactive elements per pre-action observation,
	 * and mean element-list lines actually rendered into the prompt (0 on vision-only arms).
	 * The ax/cdp gap here is "leaner"; whether leaner is denser or blinder is answered by the
	 * explore metrics below (controls/graph size), not by these.
	 */
	meanObservationNodes?: number;
	meanListShownToModel?: number;
	/**
	 * PIXEL-SNAP, aggregated per run — the question the eight snap arms (16 runs) exist to answer.
	 *
	 * The per-step facts have been recorded since the diagnostic landed (StepRecord.snap* in
	 * src/types.ts, written in src/core/agent/step.ts) and were read by NOTHING: not collect, not
	 * the report, not the dash, not the judge. Telling a snapped action from a raw one meant
	 * opening run logs by hand, which is the same as not having measured it.
	 *
	 * What these license: decomposing a vision-only miss into SPATIAL (the model named the right
	 * control and missed its pixels — `snapMeanDistancePx`, `snapInsideSteps`) and SEMANTIC (the
	 * point landed on exactly the control the model named and the step still failed). Those two
	 * have opposite remedies, which is why the split is worth five fields.
	 *
	 * What they do NOT license: any claim about whether snapping WORKED. `snapAppliedSteps` counts
	 * actions the harness retargeted, not actions that then succeeded — a rewrite that rescued a
	 * step and one that ruined it are the same tally mark. The success rate is `success`, and only
	 * the arm-vs-arm comparison speaks to the rewrite's value.
	 *
	 * `snapDeclaredMismatches` is why a snap arm is an UPPER BOUND rather than a clean result. At a
	 * 48px tolerance the nearest control can be one the model never asked for — a label's
	 * neighbour, a widget across a gap — and the harness deliberately does NOT veto that rewrite: a
	 * veto would make the arm measure the harness's veto rule instead of vision-only actuation,
	 * which is the thing being measured. So the mismatch count is the discount a reader applies by
	 * hand. Of the arm's applied steps, this many were retargeted to a control the model never
	 * named, and at most (applied − mismatched) of them are refinement rather than luck.
	 *
	 * Present on NON-SNAP arms too, and that is the point: the diagnostic in step.ts runs on every
	 * coordinate-addressed action unconditionally, while only the REWRITE is gated on SNAP_PX. A
	 * vision-only arm with SNAP_PX unset therefore reports candidates, distances and inside-hits
	 * with `snapAppliedSteps: 0` — which is what makes snap-vs-no-snap a comparison between two
	 * measured populations rather than a measured arm against a blank one.
	 *
	 * ABSENT, not zero, when no step carried snap data. An element-addressed arm names no pixels,
	 * so it has no denominator at all, and a 0 would read as "the point was never near a control"
	 * rather than "the question does not apply to this arm".
	 */
	/** Steps whose click point had a nearest interactive control at all — the denominator. */
	snapCandidateSteps?: number;
	/** Steps the snap stage actually rewrote to address by handle (SNAP_PX > 0, within tolerance). */
	snapAppliedSteps?: number;
	/** Applied steps whose control did NOT match the target the model declared. The confound. */
	snapDeclaredMismatches?: number;
	/** Mean distance from the model's point to that control over candidate steps; 0 = inside it. */
	snapMeanDistancePx?: number;
	/** Candidate steps whose point landed INSIDE a control — the pixel needed no refinement. */
	snapInsideSteps?: number;
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
	procedureSteps?: number;
	rescuedSteps?: number;
	/** Explore passes — parsed from the appmap stamp + graph. */
	controlsActuated?: number;
	controlsDismissed?: number;
	controlsSeen?: number;
	surfaces?: number;
	/**
	 * Times the app went dark for the full blind budget, and times the harness restarted it to
	 * recover. Carried into the report so a rescued pass stays distinguishable from one that
	 * never needed rescuing — a recovered run has a discontinuity in the middle of it, and the
	 * retry policy used to hide that class of run entirely by re-running it until it stopped
	 * happening.
	 */
	blackouts?: number;
	relaunches?: number;
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
	/**
	 * Something about this run is a fact about the HARNESS rather than the agent. Set by collect;
	 * see `technicalFailure`.
	 *
	 * Most kinds mean nothing was measured — it died before writing its primary artifact, or the
	 * runner was killed under it — and those must not consume one of the arm's samples.
	 * `submittedCount` skips them, which is the whole mechanism: re-running `bench phase N --go`
	 * sees the arm short and re-submits. The entry STAYS in the manifest — "three runs died
	 * acquiring the app" is worth knowing, and deleting the evidence would make a broken Mac look
	 * like a slow one.
	 *
	 * `map-superseded` is the exception and is NOT retryable — see RETRYABLE_TECHNICAL.
	 */
	technical?: { kind: string; detail: string };
	/** Pre-run env the runner must carry (e.g. APPMAP_VARIANT=vision) — see Arm.env. */
	env?: Record<string, string>;
	/**
	 * Which model this run was dispatched under (`bench phase --model <id>`). Absent on
	 * entries from before the model dimension; the run log's own `model` field is the
	 * ground truth either way and collect records it into metrics.
	 */
	model?: string;
	/** Replay arms: the procedure file the run replays, data-root-relative. */
	procedure?: string;
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

/**
 * The benchmark manifest family: `out/bench/live/<date>/` — manifest.json, the per-arm archived
 * appmaps collect files there, and the dash's narrative.md.
 *
 * Beside the runs it indexes, because it IS their index and the two were separated only by
 * history. `root` is an OUT-ROOT VARIANT, not the out dir: the default is out/bench/live, and
 * the dashboard passes out/bench/archive, the pre-bench out/live or out/archive, or the legacy
 * out/bench when reading a pass that exists only in one of those (see storeRoot in dash.ts).
 * One reader opens a live pass, a backed-up pass and a pre-2026-08-01 pass with the same call.
 *
 * A pass is keyed by DATE and a run by stamp, so the two share this directory without colliding
 * — `2026-08-01` next to `2026-08-01T03-07-52-979-yarn`. Neither is mistaken for the other:
 * listJobs maps every name through readJob and a directory with no job.json drops out, and
 * listRuns skips any directory holding a manifest.json.
 */
export const benchDir = (date = utcDate(), root = liveDir()): string => path.join(root, date);

/**
 * Hard-link the day's manifest family into out/bench/archive/<date>/, the same backup a run
 * gets when it terminates.
 *
 * Called from collect, which is the point at which the manifest has just been told something
 * durable — what each arm cost, which appmap it produced, how the judge graded it. Cheap enough
 * to do unconditionally: the family is manifests and appmaps, kilobytes, and the links are free.
 */
export function archiveBench(date = utcDate(), outRoot = outDir()): string {
	const to = benchDir(date, archiveDir(outRoot));
	backupTree(benchDir(date, liveDir(outRoot)), to);

	return to;
}

export const manifestPath = (date = utcDate(), root = liveDir()): string => path.join(benchDir(date, root), "manifest.json");

/**
 * Where an explore arm's appmap pair is archived under the bench dir, keyed on
 * (model, armId) — the pair the report compares. Exists because docs/appmaps/<slug>.* is
 * ONE file per app by convention, so a second model's pass overwrites the first's on disk;
 * the run logs pin each run's map by sha256, but the content itself would be gone.
 *
 * Here rather than in collect.ts (2026-08-03), where it lived until the dashboard needed it:
 * it is a path builder over benchDir and belongs beside it, while collect.ts does I/O and
 * reaches the core/harness barrel. dash.ts imported this ONE pure function and inherited the
 * barrel with it, which is how a read-only dashboard came to statically require the Anthropic
 * SDK, the cua driver and playwright-core.
 *
 * That is now one of three such paths rather than the only one, so moving it did NOT make the
 * dash npm-free — `src/core/journal.ts` imports the barrel outright, and graphs.ts reaches
 * playwright via cursor/track.ts → agent/recording.ts → backends/cdp.ts. Measure with a
 * transitive trace before claiming otherwise: dash.ts's own header says it never imports the
 * barrel, and that is true only of its DIRECT imports.
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
 * Bring a manifest's arm ids to their current spelling, on the way in.
 *
 * THE ONE PLACE, because everything downstream matches entries to arms by string equality and
 * would otherwise each need the rename knowledge. The stages collapse (109bf7a) dropped the phase
 * prefix from every id, and before this the 2026-08-01 pass rendered as an EMPTY BOARD under
 * current code — 0 arms, 0 of 198 entries — because nothing resolved and an entry with no arm has
 * nothing to render.
 *
 * A NOTE ON WRITES, since this is the honest consequence: a read-modify-write (collect banking
 * metrics, orchestrate appending an entry) now persists the canonical ids, so a legacy manifest
 * heals on its next write rather than being converted by a migration script. That is intended —
 * it is the same file describing the same runs under the names the code now uses — but it does
 * mean the id rewrite is one-way, and `out/bench/archive` holds the pre-rewrite copy if the old
 * spelling is ever needed as evidence.
 *
 * Ids it does not recognise are left exactly as they are; canonicalArmId explains why guessing
 * would be worse than leaving them visible.
 */
const canonicaliseArmIds = (m: Manifest): Manifest => ({
	...m,
	entries: m.entries.map((e) => {
		const id = canonicalArmId(e.armId);

		return id === e.armId ? e : { ...e, armId: id };
	}),
});

export function readManifest(date = utcDate(), root = liveDir()): Manifest {
	// Live, then the backup, then the store's pre-bench homes (out/live, out/archive — a few
	// hours of passes landed there), then the legacy out/bench/<date> layout — the same fallback
	// walk runFile does for run artifacts, and for the same reason: a layout change must not make
	// a finished pass unreadable. An explicit non-default `root` is honoured as given, because
	// the dashboard has already resolved which root holds the pass it wants.
	const candidates =
		root === liveDir()
			? [root, archiveDir(), path.join(outDir(), OLD_LIVE_DIR), path.join(outDir(), OLD_ARCHIVE_DIR), path.join(outDir(), "bench")]
			: [root];
	for (const r of candidates) {
		try {
			const m = JSON.parse(fs.readFileSync(manifestPath(date, r), "utf8")) as Manifest;
			if (Array.isArray(m.entries)) return canonicaliseArmIds(m);
		} catch {
			// Absent or unparseable both mean "not here" — try the next root, then start fresh.
		}
	}

	return { date, createdAt: new Date().toISOString(), entries: [] };
}

/** Atomic replace, the writeJob pattern: sibling temp + rename, removed on any failure. */
export function writeManifest(m: Manifest, root = liveDir()): void {
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

/**
 * Technical kinds meaning NOTHING WAS MEASURED, so the sample slot must be refilled.
 *
 * `map-superseded` is deliberately absent (David, 2026-08-03). That run completed — frontier
 * swept, a real map with real coverage written to its own run folder, which `writeArtifacts`
 * always writes first at a path nothing can overwrite. The only thing it lacks is being the
 * PUBLISHED map, and with n=2 samples sharing one `docs/appmaps/<slug>` filename exactly one of
 * them can be, always. Counting it as a lost sample makes every two-sample arm permanently read
 * 1/2, so each `bench phase --go` re-dispatches it, the replacement supersedes its sibling in
 * turn, and the arm never converges. Observed live: explore-notion-cdp-no-vision sat at 1/2 with
 * both of its runs finished and its 218-node map on disk.
 */
export const RETRYABLE_TECHNICAL: ReadonlySet<string> = new Set(["crashed", "orphaned", "unready", "never-ran"]);

/**
 * How many samples an arm already has in this model's pass — the top-up arithmetic.
 *
 * A run that died producing nothing says nothing about the arm, so leaving it in the tally would
 * silently shrink n: an arm declared n=3 whose first attempt died on acquisition would go out
 * with two real samples and report as complete. A run that finished and was merely superseded is
 * the opposite case and counts.
 */
export const submittedCount = (m: Manifest, armId: string, model?: string): number =>
	entriesForArm(m, armId, model).filter((e) => !e.technical || !RETRYABLE_TECHNICAL.has(e.technical.kind)).length;

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
