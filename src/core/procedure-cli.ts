/**
 * `./run procedures harvest <stamp> | list | promote <stamp>` — turning judged-PASS runs into
 * reusable task knowledge.
 *
 * Offline by construction: this reads a finished run's log and judge verdict, makes ONE model
 * call, and writes prose. It never drives an app, and it is never invoked by a run — which is
 * what keeps the harvest out of the cost and latency of the runs being measured. See
 * procedure.ts for why that matters more than the convenience of doing it at `done()`.
 *
 * Two destinations, deliberately separate. `harvest` writes into the run's own folder, where it
 * is the record of what that run taught. `promote` copies it to docs/procedures/, where
 * `loadGrounding` can find it — and promotion is the step that makes a procedure an INPUT to
 * future runs, so it is the step that has to be deliberate. `harvest --promote` does both when
 * you already know you want it.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { archiveRun, proceduresDir, RUN_FILES, runFile, runPath } from "../paths.js";
import { makeClient, retryTransient } from "./harness.js";
import { readJsonOr } from "../fsutil.js";
import { slugOf } from "./recipe.js";
import {
	harvestPrompt,
	HARVEST_SYSTEM,
	harvestRefusal,
	type HarvestSource,
	type JudgeVerdict,
	procedureFileFor,
	procedureHeader,
	ProcedureError,
	writeProcedure,
} from "./procedure.js";

/**
 * Read a run and its verdict, refuse if the run may not become a procedure, otherwise ask the
 * model for the prose. Returns the body WITH its provenance stamp.
 *
 * `callModel` is injectable so the tests exercise refusals and prompt assembly without spending
 * anything — the same posture as the bench judge.
 */
export async function harvest(
	stamp: string,
	opts: { callModel?: (system: string, prompt: string) => Promise<string>; model?: string } = {},
): Promise<{ body: string; run: HarvestSource; judge: JudgeVerdict }> {
	const logPath = runFile(stamp, RUN_FILES.log);
	if (!fs.existsSync(logPath)) throw new ProcedureError(`no run log at ${logPath}`);
	const run = JSON.parse(fs.readFileSync(logPath, "utf8")) as HarvestSource;
	const judge = readJsonOr<JudgeVerdict | undefined>(runFile(stamp, RUN_FILES.judge), undefined);

	const refusal = harvestRefusal(run, judge);
	if (refusal) throw new ProcedureError(refusal);

	const call =
		opts.callModel ??
		(async (system: string, prompt: string): Promise<string> => {
			const { client, model } = makeClient(opts.model ?? process.env.PROCEDURE_MODEL);
			// No reasoning-effort field, matching the other small utility calls (judge, teardown,
			// replay rescue): this is a transcription task over an already-decided route, not a
			// problem to think about.
			const r = await retryTransient(() =>
				client.messages.create({ model, max_tokens: 1500, system, messages: [{ role: "user", content: prompt }] }),
			);

			return r.content
				.filter((b): b is Anthropic.TextBlock => b.type === "text")
				.map((b) => b.text)
				.join("\n")
				.trim();
		});

	const prose = await call(HARVEST_SYSTEM, harvestPrompt(run));
	if (!prose.trim()) throw new ProcedureError("model returned an empty procedure");

	return { body: procedureHeader(run, stamp, judge!) + prose, run, judge: judge! };
}

/** Every promoted procedure, for `list`. */
export function listProcedures(dir = proceduresDir()): Array<{ file: string; app?: string; task?: string; from?: string }> {
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter((n) => n.endsWith(".procedure.md"));
	} catch {
		return [];
	}

	return names.map((n) => {
		const head = fs.readFileSync(path.join(dir, n), "utf8").slice(0, 500);
		const field = (k: string): string | undefined => new RegExp(`${k}: ([^|>]*)`).exec(head)?.[1]?.trim();

		return { file: n, ...(field("app") ? { app: field("app") } : {}), ...(field("task") ? { task: field("task") } : {}), ...(field("from") ? { from: field("from") } : {}) };
	});
}

function usage(): never {
	console.error("usage: ./run procedures harvest <stamp> [--promote]   judged-PASS run -> its own procedure.md");
	console.error("       ./run procedures promote <stamp>               copy a harvested procedure into docs/procedures/");
	console.error("       ./run procedures list                          what future runs can be grounded on");
	process.exit(1);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const [verb, arg] = argv;

	if (!verb || verb === "list") {
		const rows = listProcedures();
		if (!rows.length) {
			console.log(`no procedures in ${proceduresDir()}`);
			console.log("harvest one from a judged-PASS run: ./run procedures harvest <stamp> --promote");

			return;
		}
		for (const r of rows) console.log(`${r.file}\n  ${r.app ?? "?"} — ${r.task ?? "?"}${r.from ? `  (from ${r.from})` : ""}`);
		console.log(`\n${rows.length} procedure(s) in ${proceduresDir()}`);

		return;
	}

	if (verb === "harvest") {
		if (!arg) usage();
		const { body, run } = await harvest(arg);
		const file = writeProcedure(runPath(arg, RUN_FILES.procedure), body);
		console.log(`harvested: ${file}`);
		// The run's backup was taken when it terminated; this write lands long after, so it
		// reaches the archive only if we re-link. Same obligation as the recipe compile.
		try {
			archiveRun(arg);
		} catch {}
		if (argv.includes("--promote")) promote(arg, run);
		else console.log(`promote it into docs/procedures/ (making it loadable by future runs): ./run procedures promote ${arg}`);

		return;
	}

	if (verb === "promote") {
		if (!arg) usage();
		const src = runFile(arg, RUN_FILES.procedure);
		if (!fs.existsSync(src)) throw new ProcedureError(`no harvested procedure for ${arg} — run: ./run procedures harvest ${arg}`);
		const run = JSON.parse(fs.readFileSync(runFile(arg, RUN_FILES.log), "utf8")) as HarvestSource;
		promote(arg, run);

		return;
	}

	usage();
}

function promote(stamp: string, run: HarvestSource): void {
	const src = runFile(stamp, RUN_FILES.procedure);
	const dest = procedureFileFor(proceduresDir(), slugOf(run as Record<string, unknown>, stamp), run.task ?? "");
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(src, dest);
	console.log(`promoted: ${dest}`);
	console.log(`future runs ground on it with USE_PROCEDURES=1 (run log will record provenance "procedure")`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main().catch((err) => {
		console.error(err instanceof ProcedureError ? `REFUSED: ${err.message}` : err);
		process.exit(1);
	});

