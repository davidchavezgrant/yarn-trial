import fs from "node:fs";
import path from "node:path";
import { judgeRun } from "../core/judge.js";
import { dataRoot as dataRootDir, outDir } from "../paths.js";
import { armById } from "./matrix.js";
import { readManifest, utcDate } from "./manifest.js";

/**
 * The judge step: re-grade every landed task/replay run with the offline adversarial judge
 * (src/core/judge.ts), between the pull and the report read.
 *
 * The bench's headline metric is the run log's self-reported `success`, and that metric
 * provably passes wrong-scope runs — four text-verified runs changed a per-draft override
 * where the task meant the brand default, and every one reported success. The judge is the
 * second opinion the report's disagreement section is built on, so it has to run over the
 * whole manifest, not per run when someone remembers.
 *
 * Idempotent the same way collect is, but for a different reason: collect's reads are
 * deterministic, a judge call is a MODEL call and is not. The `.judge.json` artifact freezes
 * the verdict the first time, and an already-judged run is skipped — re-running the step
 * while the queue drains judges only what landed since, and never re-rolls a verdict.
 *
 * The bench pins the judge model to BENCH_JUDGE_MODEL (set by David): the agent arms vary
 * by model, and verdicts are only comparable across arms if the same judge graded all of
 * them. JUDGE_MODEL in the env still wins, as the operator override.
 */

/**
 * The same model, reached over the transport that actually works. It was
 * `openai/gpt-5.6-sol` (OpenRouter) until 2026-07-31, when a pre-flight check found that
 * key dead (401 "User not found") — which would have failed the judge step for every run
 * in the matrix AFTER all 62 had been spent. `azure/` routes to the Responses transport
 * (src/core/harness/responses.ts); the pinning argument is unchanged, since the point is
 * that ONE judge grades every arm.
 */
export const BENCH_JUDGE_MODEL = "azure/gpt-5.6-sol";

/**
 * The second grader for cross-judging. The pinned judge shares lineage with the PRIMARY
 * contestant now that OpenAI is the default model, and a grader from one contestant's family
 * scoring that contestant against another is a conflict — not necessarily a biased one, but
 * not one worth leaving unchecked on the comparison the whole exercise turns on.
 *
 * Cross-judged runs get a second `.judge.cross.json` beside the first. Agreement makes the
 * verdict solid; DISAGREEMENT is itself the finding, and the report says so rather than
 * averaging two verdicts into a number that means nothing.
 */
export const CROSS_JUDGE_MODEL = "claude-fable-5";

/** Terminal job states — same set collect uses; a run still in flight has no log to judge. */
const TERMINAL = new Set(["done", "failed", "stopped", "orphaned"]);

export interface BenchJudgeOutcome {
	judged: string[];
	skipped: string[];   // eligible but artifact already exists
	failed: Array<{ jobId: string; error: string }>;
}

export async function judgeBench(opts?: {
	date?: string;       // manifest date, default utcDate()
	outRoot?: string;    // default outDir()
	dataDir?: string;    // default dataRootDir() — where run logs + artifacts live
	log?: (s: string) => void;   // default console.error
	judge?: (stamp: string) => Promise<unknown>;   // injected for tests; default wraps judgeRun
	/** Also grade with CROSS_JUDGE_MODEL, writing a second tagged artifact. See that constant. */
	cross?: boolean;
	crossJudge?: (stamp: string) => Promise<unknown>;
}): Promise<BenchJudgeOutcome> {
	const date = opts?.date ?? utcDate();
	const outRoot = opts?.outRoot ?? outDir();
	const dataDir = opts?.dataDir ?? dataRootDir();
	const log = opts?.log ?? console.error;
	// NOTE the split roots: existence checks below use dataDir paths, but the default judge fn
	// (judgeRun) resolves the run log via outDir() internally. In production the two are the
	// same root, so the file this module checked is the file judgeRun reads; tests always
	// inject their own judge fn, so they never depend on that coincidence.
	const judge = opts?.judge ?? ((stamp: string) => judgeRun(stamp, { model: process.env.JUDGE_MODEL ?? BENCH_JUDGE_MODEL }));
	const crossJudge = opts?.crossJudge ?? ((stamp: string) => judgeRun(stamp, { model: process.env.CROSS_JUDGE_MODEL ?? CROSS_JUDGE_MODEL, tag: "cross" }));

	const manifest = readManifest(date, outRoot);
	const outcome: BenchJudgeOutcome = { judged: [], skipped: [], failed: [] };

	for (const entry of manifest.entries) {
		// Eligibility, not failure: explore/compile arms have no run to judge, a non-terminal
		// job has no log yet, and a terminal job that never wrote one is collect's "crashed"
		// datum — none of those belong in any of the three lists.
		const arm = armById(entry.armId);
		if (arm?.kind !== "task" && arm?.kind !== "replay") continue;
		if (!TERMINAL.has(entry.state)) continue;
		if (!fs.existsSync(path.join(dataDir, `out/runs/${entry.jobId}.json`))) continue;

		if (fs.existsSync(path.join(dataDir, `out/runs/${entry.jobId}.judge.json`))) {
			outcome.skipped.push(entry.jobId);
			log(`… ${entry.armId} ${entry.jobId}: already judged — skipping`);
			continue;
		}

		try {
			await judge(entry.jobId);
			outcome.judged.push(entry.jobId);
			log(`✓ ${entry.armId} ${entry.jobId}: judged`);
			if (opts?.cross && !fs.existsSync(path.join(dataDir, `out/runs/${entry.jobId}.judge.cross.json`))) {
				// A failed cross-judge must not undo a successful primary judgement: the run
				// stays judged, and the missing second opinion surfaces as an absent artifact
				// rather than as a run that looks ungraded.
				try {
					await crossJudge(entry.jobId);
					log(`  ↳ cross-judged by ${process.env.CROSS_JUDGE_MODEL ?? CROSS_JUDGE_MODEL}`);
				} catch (e) {
					log(`  ↳ cross-judge failed: ${(e as Error).message}`);
				}
			}
		} catch (e) {
			// One unreachable model (or one unparseable verdict) must not kill the batch —
			// the failure is recorded and the loop moves to the next run.
			outcome.failed.push({ jobId: entry.jobId, error: (e as Error).message });
			log(`✗ ${entry.armId} ${entry.jobId}: ${(e as Error).message}`);
		}
	}

	return outcome;
}
