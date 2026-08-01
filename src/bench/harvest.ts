/**
 * `./run bench harvest` — turn the pass's judged-PASS runs into procedures, in bulk.
 *
 * Mirrors `bench judge` deliberately: idempotent (a run whose procedure.md exists is skipped),
 * per-run failures recorded rather than fatal, and a separate operator verb rather than
 * something a phase does on its way past. That last property is the important one. Promoting a
 * procedure makes it an INPUT to every later run of the same task, and an input tier must never
 * appear as a side effect of dispatching a phase — that is how sample independence dies quietly.
 *
 * Workflow: runs land → `bench judge` → `bench harvest` → `bench phase 6 --go`.
 *
 * SOURCE ARMS ARE RESTRICTED to the arms phase 6 names as `sourceArm` — currently the grounded
 * AND ungrounded phase-2 arms, which are two different experiments:
 *
 *   grounded source   → "does a frozen route beat the map it came from, on that task"
 *   ungrounded source → "can a write-up by an agent that had no map REPLACE the map"
 *
 * They must not merge. `lineageOf` keys the promoted file on the source run's own recorded
 * provenance, so a procedure cannot be filed under a tier its author did not have.
 *
 * Harvesting from anything ELSE — a curated-tier run, say — would fold that tier's knowledge into
 * a procedure and make it look better than it is, which is why this is a whitelist.
 */
import fs from "node:fs";
import path from "node:path";
import { archiveRun, dataRoot as dataRootDir, liveDir, outDir, RUN_FILES, runFile, runPath } from "../paths.js";
import { harvest as harvestOne } from "../core/procedure-cli.js";
import { writeProcedure } from "../core/procedure.js";
import { armById, phaseArms } from "./matrix.js";
import { readManifest, utcDate } from "./manifest.js";

const TERMINAL = new Set(["done", "failed", "stopped", "orphaned"]);

export interface BenchHarvestOutcome {
	harvested: string[];
	skipped: string[];
	/** Refusals are DATA, not errors: "which runs were not good enough to teach from" is a result. */
	refused: Array<{ jobId: string; reason: string }>;
	failed: Array<{ jobId: string; error: string }>;
}

/** The arms phase 6 grounds on — the only runs eligible to become procedures. */
export const harvestSourceArms = (): string[] => [...new Set(phaseArms(6).map((a) => a.sourceArm).filter((x): x is string => Boolean(x)))];

export async function harvestBench(opts?: {
	date?: string;
	outRoot?: string;
	dataDir?: string;
	log?: (s: string) => void;
	/** Injected for tests, so the batch logic is exercised without a model call. */
	harvestFn?: (stamp: string) => Promise<{ body: string }>;
}): Promise<BenchHarvestOutcome> {
	const date = opts?.date ?? utcDate();
	const outRoot = opts?.outRoot ?? outDir();
	const dataDir = opts?.dataDir ?? dataRootDir();
	const log = opts?.log ?? console.error;
	const run = opts?.harvestFn ?? ((stamp: string) => harvestOne(stamp));

	const manifest = readManifest(date, liveDir(outRoot));
	const sources = new Set(harvestSourceArms());
	const outcome: BenchHarvestOutcome = { harvested: [], skipped: [], refused: [], failed: [] };

	for (const entry of manifest.entries) {
		if (!sources.has(entry.armId)) continue;
		const arm = armById(entry.armId);
		if (arm?.kind !== "task") continue;
		if (!TERMINAL.has(entry.state)) continue;

		const dataOut = path.join(dataDir, "out");
		if (!fs.existsSync(runFile(entry.jobId, RUN_FILES.log, dataOut))) continue;
		if (fs.existsSync(runFile(entry.jobId, RUN_FILES.procedure, dataOut))) {
			outcome.skipped.push(entry.jobId);
			log(`… ${entry.armId} ${entry.jobId}: already harvested — skipping`);
			continue;
		}

		try {
			const { body } = await run(entry.jobId);
			writeProcedure(runPath(entry.jobId, RUN_FILES.procedure, dataOut), body);
			// Post-terminal write: the run's backup was taken when it ended, so without this the
			// procedure lives only in live and a `runs purge` drops it — and harvest's own
			// idempotence check searches the archive, so it would then re-spend a model call.
			try {
				archiveRun(entry.jobId, dataOut);
			} catch {}
			outcome.harvested.push(entry.jobId);
			log(`✓ ${entry.armId} ${entry.jobId}: harvested`);
		} catch (e) {
			const msg = (e as Error).message;
			// A refusal and a transport failure are different findings and must not be one list:
			// "the judge did not pass this run" is the gate working, "the model was unreachable"
			// is a retry. Distinguished by the ProcedureError name rather than by prose.
			if ((e as Error).constructor?.name === "ProcedureError") {
				outcome.refused.push({ jobId: entry.jobId, reason: msg });
				log(`– ${entry.armId} ${entry.jobId}: refused — ${msg}`);
			} else {
				outcome.failed.push({ jobId: entry.jobId, error: msg });
				log(`✗ ${entry.armId} ${entry.jobId}: ${msg}`);
			}
		}
	}

	log(
		`harvest: ${outcome.harvested.length} harvested, ${outcome.skipped.length} already done, ` +
			`${outcome.refused.length} refused, ${outcome.failed.length} failed`,
	);
	if (outcome.harvested.length)
		log(`promote them so phase 6 can load them: ${outcome.harvested.map((s) => `./run procedures promote ${s}`).join(" && ")}`);

	return outcome;
}
