/**
 * `./run recipes harvest <stamp> | list | promote <stamp>` — turning judged-PASS runs into
 * reusable task knowledge.
 *
 * Offline by construction: this reads a finished run's log and judge verdict, makes ONE model
 * call, and writes prose. It never drives an app, and it is never invoked by a run — which is
 * what keeps the harvest out of the cost and latency of the runs being measured. See
 * recipe.ts for why that matters more than the convenience of doing it at `done()`.
 *
 * Two destinations, deliberately separate. `harvest` writes into the run's own folder, where it
 * is the record of what that run taught. `promote` copies it to docs/recipes/, where
 * `loadGrounding` can find it — and promotion is the step that makes a recipe an INPUT to
 * future runs, so it is the step that has to be deliberate. `harvest --promote` does both when
 * you already know you want it.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { refuseRetiredEnv } from "../env.js";
import { archiveRun, recipesDir, RUN_FILES, runFile, runPath } from "../paths.js";
import { makeClient, retryTransient } from "./harness.js";
import { readJsonOr } from "../fsutil.js";
import { appmapSlug } from "./target.js";
import {
	harvestPrompt,
	HARVEST_SYSTEM,
	harvestRefusal,
	type HarvestSource,
	type JudgeVerdict,
	lineageOf,
	recipeFileFor,
	recipeHeader,
	RecipeError,
	writeRecipe,
} from "./recipe.js";

/**
 * Read a run and its verdict, refuse if the run may not become a recipe, otherwise ask the
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
	if (!fs.existsSync(logPath)) throw new RecipeError(`no run log at ${logPath}`);
	const run = JSON.parse(fs.readFileSync(logPath, "utf8")) as HarvestSource;
	const judge = readJsonOr<JudgeVerdict | undefined>(runFile(stamp, RUN_FILES.judge), undefined);

	const refusal = harvestRefusal(run, judge);
	if (refusal) throw new RecipeError(refusal);

	const call =
		opts.callModel ??
		(async (system: string, prompt: string): Promise<string> => {
			const { client, model } = makeClient(opts.model ?? process.env.RECIPE_MODEL);
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
	if (!prose.trim()) throw new RecipeError("model returned an empty recipe");

	return { body: recipeHeader(run, stamp, judge!) + prose, run, judge: judge! };
}

/** Every promoted recipe, for `list`. */
export function listRecipes(dir = recipesDir()): Array<{ file: string; app?: string; task?: string; from?: string }> {
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter((n) => n.endsWith(".recipe.md"));
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
	console.error("usage: ./run recipes harvest <stamp> [--promote]   judged-PASS run -> its own recipe.md");
	console.error("       ./run recipes promote <stamp>               copy a harvested recipe into docs/recipes/");
	console.error("       ./run recipes list                          what future runs can be grounded on");
	process.exit(1);
}

async function main(): Promise<void> {
	// The same obligation the replay entry point has, for the same reason. `RECIPE_MODEL` is read at
	// the top of this file; its retired name `PROCEDURE_MODEL` is one an operator types on a HARVEST,
	// and harvest never calls `loadGrounding` either — so before this, `PROCEDURE_MODEL=<id> ./run
	// recipes harvest` silently harvested on the default model. That is the exact failure the retired
	// map was extended to catch, arriving through the one door with no guard on it.
	refuseRetiredEnv();

	const argv = process.argv.slice(2);
	const [verb, arg] = argv;

	if (!verb || verb === "list") {
		const rows = listRecipes();
		if (!rows.length) {
			console.log(`no recipes in ${recipesDir()}`);
			console.log("harvest one from a judged-PASS run: ./run recipes harvest <stamp> --promote");

			return;
		}
		for (const r of rows) console.log(`${r.file}\n  ${r.app ?? "?"} — ${r.task ?? "?"}${r.from ? `  (from ${r.from})` : ""}`);
		console.log(`\n${rows.length} recipe(s) in ${recipesDir()}`);

		return;
	}

	if (verb === "harvest") {
		if (!arg) usage();
		const { body } = await harvest(arg);
		const file = writeRecipe(runPath(arg, RUN_FILES.recipe), body);
		console.log(`harvested: ${file}`);
		// The run's backup was taken when it terminated; this write lands long after, so it
		// reaches the archive only if we re-link. Same obligation as the procedure compile.
		try {
			archiveRun(arg);
		} catch {}
		if (argv.includes("--promote")) promoteRecipe(arg);
		else console.log(`promote it into docs/recipes/ (making it loadable by future runs): ./run recipes promote ${arg}`);

		return;
	}

	if (verb === "promote") {
		if (!arg) usage();
		promoteRecipe(arg);

		return;
	}

	usage();
}

/**
 * The app half of a promoted recipe's filename, derived the way the RUN THAT WILL READ IT
 * derives it.
 *
 * TWO slug functions exist and exactly one is correct at this call site. `targetSlug`
 * (src/core/target.ts) is the AUTHORITY, because it is what the reader uses: agent/run.ts calls
 * `loadGrounding(targetSlug(target), …)`, which resolves the recipe through the same
 * `recipeFileFor` this feeds — for a web target it yields `web-<host>`. `appSlug` (src/paths.ts)
 * is the other one: it folds whitespace, slashes and colons and knows nothing about URLs, so
 * given a URL it yields `https-app.notion.com`. Identical for a Mac app, divergent for the web,
 * and `appmapSlug` is the one derivation that routes a URL to the former and a name to the latter.
 *
 * This site had the wrong one until 2026-08-03. The slug came from `slugOf(run, stamp)` — the
 * stamp's `-<appSlug(app)>` tail — and a dispatched web run's stamp is minted from the ARM's
 * URL (`mintRunKey` ← jobs.ts's `init.app`). So promote wrote
 * `https-app.notion.com.cdp.<hash>.recipe.md`, the bench recipe gate looked for that same name
 * and was satisfied, and the RUN looked for `web-app.notion.com.cdp.<hash>.recipe.md`, found
 * nothing, and fell back to the appmap tier with only a console warning — an arm carrying the
 * recipe tier's label and the appmap tier's grounding. `groundingChecked` (bench/collect.ts)
 * catches it, but only at collect, after the runs are paid for.
 *
 * WEB-NESS COMES FROM THE JOB RECORD, not from a guess about the run log. The log has no url
 * field at all, and its `app` is the target LABEL — for a web run the bare HOST (agent/cli.ts),
 * so `app` alone cannot separate the website app.notion.com from a Mac app of that name.
 * `job.json` sits in the same run directory and carries the exact `--url` the child was spawned
 * with, so slugging it reproduces the reader's `targetSlug` by construction rather than by two
 * derivations happening to agree. Read as a literal filename because core may not statically
 * import src/remote/ (layering.test.ts).
 *
 * No job record — a run started by hand rather than dispatched — falls back to the log's `app`
 * through the same function, which for an app NAME is `appSlug` unchanged. That is what keeps a
 * Mac app's slug, and therefore every recipe already committed under docs/recipes/, byte-identical
 * to what the stamp tail produced.
 */
export function promotedSlug(stamp: string, run: HarvestSource, out?: string): string {
	const job = readJsonOr<{ url?: string } | undefined>(runFile(stamp, "job.json", out), undefined);

	return appmapSlug(job?.url ?? run.app ?? "unknown");
}

/**
 * Copy a run's harvested recipe into docs/recipes/, making it an INPUT to future runs.
 * Exported (with injectable roots) for the bench autopilot's promote stage; the deliberateness
 * argument still holds there — the operator's one `autopilot --go` covers a stage whose whole
 * job is promotion, printed in the plan, which is not a side effect of dispatching a phase.
 */
export function promoteRecipe(stamp: string, opts: { out?: string; dir?: string; log?: (s: string) => void } = {}): string {
	const log = opts.log ?? console.log;
	const src = runFile(stamp, RUN_FILES.recipe, opts.out);
	if (!fs.existsSync(src)) throw new RecipeError(`no harvested recipe for ${stamp} — run: ./run recipes harvest ${stamp}`);
	const run = JSON.parse(fs.readFileSync(runFile(stamp, RUN_FILES.log, opts.out), "utf8")) as HarvestSource;
	// run.backend is what actually DROVE (the run log records the post-fallback backend), which
	// is the right axis: a recipe written from an ax run names ax's surface labels.
	const dest = recipeFileFor(opts.dir ?? recipesDir(), promotedSlug(stamp, run, opts.out), run.task ?? "", run.backend, lineageOf(run));
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(src, dest);
	log(`promoted: ${dest}`);
	log(
		`future runs ground on it with USE_RECIPES=1${lineageOf(run) === "ungrounded" ? " RECIPE_LINEAGE=ungrounded" : ""} (run log will record provenance "recipe")`,
	);

	return dest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main().catch((err) => {
		console.error(err instanceof RecipeError ? `REFUSED: ${err.message}` : err);
		process.exit(1);
	});

