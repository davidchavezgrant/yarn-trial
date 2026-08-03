/**
 * ONE slug per target, across the write path, the gate and the read.
 *
 * A recipe is found by FILENAME and by nothing else, and the failure when the halves disagree is
 * silent by construction: `loadGrounding` misses the file, logs a warning on the child's console,
 * and falls back to the appmap tier — so the arm runs, reports, and is banked with the recipe
 * tier's label and the appmap tier's grounding. `groundingChecked` catches it at collect, hours
 * later, after the runs are paid for. That is this repo's most-repeated failure class.
 *
 * It was live for web targets until 2026-08-03: the run read `web-app.notion.com` (targetSlug)
 * while promote wrote and the bench gate looked for `https-app.notion.com` (appSlug, applied to
 * the arm's URL). These pin the three sites to the ONE authority — `targetSlug`, because it is
 * what the reader uses — and pin the Mac-app slug to what it has always been, since every recipe
 * already committed under docs/recipes/ is named `yarn.<backend>.<taskHash>[.ungrounded].recipe.md`
 * and a change there would invalidate all four.
 */
import "./data-tmp.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promotedSlug, promoteRecipe } from "../src/core/recipe-cli.js";
import { recipeFileFor, recipeHeader, type HarvestSource } from "../src/core/recipe.js";
import { appSlug, LIVE_DIR, RUN_FILES, recipesDir } from "../src/paths.js";
import { appmapSlug, targetSlug, webTarget } from "../src/core/target.js";
import { taskHash } from "../src/core/procedure.js";
import { recipeArms, SECOND_APP_URL } from "../src/bench/matrix.js";

const NOTION_URL = SECOND_APP_URL;
const TASK = "report the email address of the signed-in account";

/** The slug the RUN will look under — the authority all three write/gate sites must match. */
const readerSlug = (app: string, url?: string): string =>
	url ? targetSlug(webTarget(url)) : targetSlug({ kind: "app", name: app });

/**
 * A run directory as the fleet leaves one: the log, the harvested recipe, and — for a dispatched
 * run — the job record that is the only artifact carrying the URL. `promoteRecipe` reads all three.
 */
function stageRun(opts: { stamp: string; app: string; url?: string; backend: string; grounded: boolean }): {
	root: string;
	out: string;
	dir: string;
} {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "yarn-recipe-slug-"));
	const out = path.join(root, "out");
	const runDir = path.join(out, LIVE_DIR, opts.stamp);
	fs.mkdirSync(runDir, { recursive: true });
	const run: HarvestSource = {
		task: TASK,
		// The run log's `app` is the target LABEL, which for a web run is the bare HOST — never the
		// URL. That is exactly why promote cannot infer web-ness from this field alone.
		app: opts.url ? new URL(opts.url).host : opts.app,
		success: true,
		backend: opts.backend,
		...(opts.grounded ? { grounding: { provenance: "explore" } } : {}),
	};
	fs.writeFileSync(path.join(runDir, RUN_FILES.log), JSON.stringify(run));
	fs.writeFileSync(
		path.join(runDir, RUN_FILES.recipe),
		`${recipeHeader(run, opts.stamp, { trajectory: "PASS" })}1. Open the account menu.\n`,
	);
	fs.writeFileSync(
		path.join(runDir, "job.json"),
		JSON.stringify({ id: opts.stamp, kind: "task", app: opts.url ?? opts.app, ...(opts.url ? { url: opts.url } : {}) }),
	);
	const dir = path.join(root, "docs", "recipes");
	fs.mkdirSync(dir, { recursive: true });

	return { root, out, dir };
}

test("promotedSlug__MatchesTheRunTimeReadSlug__When__TheTargetIsAWebApp", () => {
	// The stamp carries appSlug OF THE URL, because a dispatched web run's job id is minted from
	// the arm's `app` (the full URL). Deriving the slug from that tail is what produced
	// `https-app.notion.com`; the job record's url is what recovers the reader's `web-<host>`.
	const stamp = `2026-08-03T10-02-53-366-${appSlug(NOTION_URL)}`;
	assert.match(stamp, /-https-app\.notion\.com$/, "the stamp tail is the old, wrong derivation");
	const { out } = stageRun({ stamp, app: NOTION_URL, url: NOTION_URL, backend: "cdp", grounded: true });

	const slug = promotedSlug(stamp, { app: "app.notion.com" }, out);
	assert.equal(slug, "web-app.notion.com");
	assert.equal(slug, readerSlug("app.notion.com", NOTION_URL));
	assert.notEqual(slug, appSlug(NOTION_URL));
});

test("promotedSlug__IsUnchanged__When__TheTargetIsAMacApp", () => {
	// The non-destructiveness proof. Committed recipes are named off `appSlug("Yarn")`, and an app
	// run's job record carries no url, so promote must land on exactly the same string it did when
	// it read the stamp's tail.
	const stamp = "2026-08-01T19-54-15-015-yarn";
	const { out } = stageRun({ stamp, app: "Yarn", backend: "ax", grounded: true });

	const slug = promotedSlug(stamp, { app: "Yarn" }, out);
	assert.equal(slug, "yarn");
	assert.equal(slug, appSlug("Yarn"), "appSlug is still the app branch — nothing about a name changed");
	assert.equal(slug, readerSlug("Yarn"));
	// The stamp tail, which is what the pre-fix derivation returned. Identical here and only here.
	assert.equal(slug, stamp.slice(stamp.lastIndexOf("-") + 1));

	// And with NO job record at all — a run started by hand rather than dispatched, where the run
	// log's `app` is the only thing left. Same answer, so the CLI path is not a special case.
	fs.rmSync(path.join(out, LIVE_DIR, stamp, "job.json"));
	assert.equal(promotedSlug(stamp, { app: "Yarn" }, out), "yarn");
});

test("promoteRecipe__WritesTheFileTheRunWillRead__When__PromotingANotionRun", () => {
	// The round trip the bug broke, end to end through the real promote for the app David is
	// adding recipe arms for. Both lineages, because they are separate files and the ungrounded
	// one — the run with provenance "none" — has no `grounding.path` to fall back on.
	for (const grounded of [true, false]) {
		const stamp = `2026-08-03T10-02-53-36${grounded ? 6 : 7}-${appSlug(NOTION_URL)}`;
		const { out, dir } = stageRun({ stamp, app: NOTION_URL, url: NOTION_URL, backend: "cdp", grounded });

		const dest = promoteRecipe(stamp, { out, dir, log: () => {} });

		const wanted = recipeFileFor(dir, readerSlug("app.notion.com", NOTION_URL), TASK, "cdp", grounded ? "grounded" : "ungrounded");
		assert.equal(dest, wanted, "promote wrote a name the run does not look for");
		assert.ok(fs.existsSync(wanted));
		assert.equal(
			path.basename(dest),
			`web-app.notion.com.cdp.${taskHash(TASK)}${grounded ? "" : ".ungrounded"}.recipe.md`,
		);
	}
});

test("promoteRecipe__KeepsTheCommittedFilenames__When__PromotingAYarnRun", () => {
	// docs/recipes/ holds yarn.ax.2c2e5fd5[.ungrounded].recipe.md and the cdp pair. If this drifts,
	// every committed recipe becomes unfindable while still sitting on disk.
	const stamp = "2026-08-01T19-54-15-015-yarn";
	const { out, dir } = stageRun({ stamp, app: "Yarn", backend: "ax", grounded: true });

	const dest = promoteRecipe(stamp, { out, dir, log: () => {} });

	assert.equal(path.basename(dest), `yarn.ax.${taskHash(TASK)}.recipe.md`);
	assert.equal(dest, recipeFileFor(dir, readerSlug("Yarn"), TASK, "ax", "grounded"));
});

test("appmapSlug__AgreesWithTargetSlug__When__ABenchArmNamesItsRecipeFile", () => {
	// The GATE's derivation (orchestrate.ts / autopilot.ts both call appmapSlug(arm.app)) against
	// the reader's. Asserted over the live matrix so a web recipe arm added later is covered the
	// day it lands — and it also catches the adjacent trap matrix.ts warns about: a web arm whose
	// `app` is a bare host rather than the full URL slugs to `app.notion.com` and misses the map.
	for (const arm of recipeArms()) {
		const expected = readerSlug(arm.app, arm.dispatch.url);
		assert.equal(appmapSlug(arm.app), expected, `${arm.id}: gate slug disagrees with the run's`);
	}
	// The web case explicitly, since today's recipe arms are all Yarn.
	assert.equal(appmapSlug(NOTION_URL), readerSlug(NOTION_URL, NOTION_URL));
	assert.equal(appmapSlug(NOTION_URL), "web-app.notion.com");
});

test("LoadGrounding__FindsThePromotedRecipe__When__AWebRunResolvesItsOwnSlug", async () => {
	// The whole point, through the real loader: promote writes, the run reads, provenance says
	// "recipe" instead of silently degrading to the appmap tier.
	const stamp = `2026-08-03T11-00-00-000-${appSlug(NOTION_URL)}`;
	const { root, out } = stageRun({ stamp, app: NOTION_URL, url: NOTION_URL, backend: "cdp", grounded: true });
	const prev = { data: process.env.YARN_RUNNER_DATA, use: process.env.USE_RECIPES };
	try {
		process.env.YARN_RUNNER_DATA = root;
		process.env.USE_RECIPES = "1";
		promoteRecipe(stamp, { out, dir: recipesDir(), log: () => {} });

		const { loadGrounding } = await import("../src/core/agent/grounding.js");
		const g = loadGrounding(targetSlug(webTarget(NOTION_URL)), "cdp", TASK);
		assert.equal(g.provenance, "recipe");
		assert.match(g.notes ?? "", /Open the account menu/);
		// And the pre-fix name is NOT what the run resolves, so the old file would have been dead
		// on disk rather than merely misnamed.
		assert.equal(loadGrounding(appSlug(NOTION_URL), "cdp", TASK).provenance, "none");
	} finally {
		if (prev.data === undefined) delete process.env.YARN_RUNNER_DATA;
		else process.env.YARN_RUNNER_DATA = prev.data;
		if (prev.use === undefined) delete process.env.USE_RECIPES;
		else process.env.USE_RECIPES = prev.use;
	}
});
