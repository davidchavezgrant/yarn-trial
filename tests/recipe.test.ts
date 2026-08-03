/**
 * Recipes — the harvest gates and the grounding tier.
 *
 * Almost everything worth testing here is a REFUSAL. A recipe is prose a future agent will
 * act on, so the failure mode is not an exception, it is a confident and reusable wrong answer.
 * The gates are what stand between "this run succeeded" and "write down how it did it".
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { harvestPrompt, harvestRefusal, lineageOf, recipeFileFor, recipeHeader, routeOf, type HarvestSource } from "../src/core/recipe.js";
import { harvestSourceArms } from "../src/bench/harvest.js";
import { expectedProvenance } from "../src/bench/collect.js";
import { armById, phaseArms, recipeArms } from "../src/bench/matrix.js";
import { taskHash } from "../src/core/procedure.js";

const PASSING: HarvestSource = {
	task: "show me how to change the cursor type",
	app: "Yarn",
	success: true,
	backend: "cdp",
	steps: [
		{ index: 0, action: { name: "click" }, targetName: "Brand Kit", targetSurface: "home", verified: true, verificationChannel: "text", expectation: { textIncludes: ["Brand Kit"] } },
		{ index: 1, action: { name: "click" }, targetName: "Cursor Style", targetSurface: "Screen Clips", verified: true, verificationChannel: "text" },
	],
	finalCheck: { evidence: { textIncludes: ["Arrow"] } },
};

const PASS_VERDICT = { trajectory: "PASS", scopeDisclosed: "yes" };

test("harvestRefusal__Accepts__When__TheRunSucceededAndTheJudgePassed", () => {
	assert.equal(harvestRefusal(PASSING, PASS_VERDICT), undefined);
});

test("harvestRefusal__Refuses__When__TheJudgeDidNotPass", () => {
	// THE gate. The wrong-scope class is a run whose every internal check passed and which
	// accurately described what it did — where what it did was change a per-document override
	// instead of the brand default. All four ungrounded runs of the cursor task did this. A
	// recipe harvested from one would teach every later run to repeat it, and would present
	// as the recipe tier outperforming the appmap.
	assert.match(harvestRefusal(PASSING, { trajectory: "FAIL" }) ?? "", /only a judged-PASS run/);
	assert.match(harvestRefusal(PASSING, { trajectory: "UNPROVEN" }) ?? "", /TRAJECTORY UNPROVEN/);
	// No verdict at all is refused too — "not yet judged" must not read as "fine".
	assert.match(harvestRefusal(PASSING, undefined) ?? "", /no judge verdict/);
});

test("harvestRefusal__Refuses__When__TheRunWasHinted", () => {
	// compileProcedure refuses hinted runs for the same reason, and here it is worse: a procedure
	// replays one task, a recipe becomes a reusable input. Writing a dictated route down as
	// something an agent discovered turns a one-run measurement violation into a permanent one.
	assert.match(harvestRefusal({ ...PASSING, hintedPrompt: true }, PASS_VERDICT) ?? "", /dictated, not discovered/);
});

test("harvestRefusal__Refuses__When__NothingWasVerifiedAtAll", () => {
	assert.match(harvestRefusal({ ...PASSING, success: false }, PASS_VERDICT) ?? "", /did not succeed/);
	const none = { ...PASSING, steps: PASSING.steps!.map((s) => ({ ...s, verified: false })) };
	assert.match(harvestRefusal(none, PASS_VERDICT) ?? "", /no verified steps/);
});

test("harvestRefusal__AcceptsAPixelOnlyRun__When__TheJudgePassedIt", () => {
	// David's catch, and it is the difference between this and compileProcedure. A replay must
	// re-check an expectation mechanically, so "some pixels changed" is correctly refused there.
	// A recipe is prose for a model — and canvas content is invisible to BOTH the AX tree and
	// the DOM, which is the entire reason pixelDelta exists as a verification layer.
	//
	// A drag across Yarn's editor canvas, a timeline handle, anything inside the NLE behind the
	// template flow: real, necessary actions whose only evidence is that the right region
	// repainted. Refusing them would reject a judged-PASS canvas run outright, or harvest it with
	// a silent hole exactly where the hard part was.
	const canvas: HarvestSource = {
		...PASSING,
		steps: [
			{ index: 0, action: { name: "click" }, targetName: "Editor", targetSurface: "Project", verified: true, verificationChannel: "text" },
			{ index: 1, action: { name: "drag" }, targetSurface: "Canvas", verified: true, verificationChannel: "pixel" },
		],
	};
	assert.equal(harvestRefusal(canvas, PASS_VERDICT), undefined);

	// And the step survives into the route, LABELLED — the model has to describe it by where it
	// happened and what visibly changed, because there is no control name to hand the next agent.
	const route = routeOf(canvas);
	assert.match(route, /drag/);
	assert.match(route, /PIXELS ONLY/);
	assert.match(route, /no text label/);
});

test("routeOf__ShowsOnlyVerifiedSteps__When__TheRunMixedThem", () => {
	// The prompt must not contain steps nobody observed, or the model will happily write them
	// into the recipe as though they were part of the route.
	const mixed: HarvestSource = {
		...PASSING,
		steps: [...PASSING.steps!, { index: 2, action: { name: "click" }, targetName: "Never Verified", verified: false }],
	};
	const route = routeOf(mixed);
	assert.match(route, /Brand Kit/);
	assert.equal(route.includes("Never Verified"), false);
	// And the prompt carries the task and app, since a recipe is keyed by both.
	const prompt = harvestPrompt(mixed);
	assert.match(prompt, /show me how to change the cursor type/);
	assert.match(prompt, /Yarn/);
});

test("recipeFileFor__KeysOnAppAndTask__When__NamingTheFile", () => {
	// A recipe for one task must never be found by a run doing a different task on the same
	// app — that is the whole difference between this and an appmap. Same identity function as
	// compiled procedures, shared rather than reimplemented so the two cannot disagree.
	const task = "show me how to change the cursor type";
	assert.notEqual(recipeFileFor("/d", "yarn", task), recipeFileFor("/d", "yarn", "create a two-scene script"));
	assert.ok(recipeFileFor("/d", "yarn", task).endsWith(`yarn.${taskHash(task)}.recipe.md`));

	// And by BACKEND, for the reason appmaps already carry that axis: ax and cdp name the same
	// surfaces differently, so a recipe is no more backend-portable than a map. Without it
	// ax-recipe and cdp-recipe resolve to one file, the second promote overwrites
	// the first, and one arm grounds on the other backend's write-up with nothing to catch it.
	assert.notEqual(recipeFileFor("/d", "yarn", task, "ax"), recipeFileFor("/d", "yarn", task, "cdp"));
});

test("recipeHeader__StampsProvenance__When__Written", () => {
	// loadGrounding treats an unstamped file as curated, exactly as it does for appmaps: machine
	// output has to prove it is machine output, or a human's note wearing a generated filename
	// gets counted as a measured tier.
	const head = recipeHeader(PASSING, "2026-08-01T00-00-00-000-yarn", PASS_VERDICT);
	assert.match(head, /^<!-- provenance: recipe \|/);
	assert.match(head, /from: 2026-08-01T00-00-00-000-yarn/);
	assert.match(head, /judge: PASS/);
});

test("expectedProvenance__ExpectsRecipe__When__TheArmAsksForOne", () => {
	// The silent-fallback guard. USE_RECIPES with no file on disk degrades to the appmap, so
	// without this an arm that never received its recipe would report clean numbers under the
	// wrong tier label. groundingChecked compares this against what the run log recorded.
	for (const arm of recipeArms(3)) assert.equal(expectedProvenance(arm), "recipe", arm.id);
	assert.equal(expectedProvenance(armById("ax-grounded")!), "explore");
	assert.equal(expectedProvenance(armById("curated")!), "curated");
});

test("harvestSourceArms__CoversBothLineages__When__Phase6IsRead", () => {
	// Two experiments, and both must be harvestable: from a GROUNDED run ("does a frozen route
	// beat the map it came from") and from an UNGROUNDED one ("can a write-up replace the map").
	// Only the second can speak to whether the exploration pass needs to exist at all.
	//
	// Note the trap this replaced: the old check asserted /grounded$/, which "ax-ungrounded"
	// also matches — so it would have passed while proving nothing.
	const sources = harvestSourceArms();
	for (const id of sources) assert.ok(armById(id), `${id} is not a real arm`);
	assert.ok(sources.some((id) => /-ungrounded$/.test(id)), "no ungrounded source — the replacement question is unanswerable");
	assert.ok(sources.some((id) => /(?<!un)grounded$/.test(id)), "no grounded source");
	// And no OTHER tier may be a source: a curated-tier run's route would carry that tier's
	// knowledge into a recipe and make the recipe look better than it is.
	for (const id of sources) {
		const arm = armById(id)!;
		assert.equal(arm.dispatch.useCurated, undefined, `${id} is the curated tier`);
		assert.equal(arm.dispatch.useRecipes, undefined, `${id} is itself recipe-grounded`);
	}
});

test("recipeFileFor__SeparatesLineages__When__BothAreHarvestedForOneTask", () => {
	// Same app, same backend, same task, different experiments — they cannot share a filename or
	// the second promote silently overwrites the first and one arm reads the other's write-up.
	const task = "show me how to change the cursor type";
	assert.notEqual(recipeFileFor("/d", "yarn", task, "ax", "grounded"), recipeFileFor("/d", "yarn", task, "ax", "ungrounded"));
	// Lineage is DERIVED from the source run's own provenance, never typed by an operator.
	assert.equal(lineageOf({ ...PASSING, grounding: { provenance: "explore" } }), "grounded");
	assert.equal(lineageOf({ ...PASSING, grounding: { provenance: "none" } }), "ungrounded");
	assert.equal(lineageOf({ ...PASSING }), "ungrounded", "a run log with no grounding block had none");
});

test("Phase6Arms__ReplaceTheAppmapRatherThanStack__When__Declared", () => {
	// USE_RECIPES is a replacement tier, like USE_CURATED. An arm that carried both would
	// measure neither, and the question the phase exists to answer — can a write-up stand IN FOR
	// the exploration pass — would be unanswerable from its own data.
	const arms = recipeArms(3);
	assert.ok(arms.length > 0);
	for (const a of arms) {
		assert.equal(a.dispatch.useRecipes, true, a.id);
		// Lineage must match the source arm's tier, or the arm reads a recipe whose author
		// knew something different from what the arm's label claims.
		const src = armById(a.sourceArm!)!;
		assert.equal(a.dispatch.recipeLineage === "ungrounded", Boolean(src.dispatch.noGrounding), `${a.id} lineage disagrees with ${src.id}`);
		assert.equal(a.dispatch.useCurated, undefined, `${a.id} stacks the curated tier`);
		assert.equal(a.dispatch.noGrounding, undefined, `${a.id} stacks the ungrounded flag`);
		// Comparable to the arms it is measured against: same task, same n.
		assert.equal(a.task, armById(a.sourceArm!)!.task, a.id);
		assert.equal(a.n, armById(a.sourceArm!)!.n, a.id);
	}
});

test("LoadGrounding__ReadsARecipe__When__UseRecipesIsSetAndOneExists", async () => {
	// End to end through the real loader: the tier resolves, the stamp is honoured, and the run
	// log will record provenance "recipe".
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "yarn-proc-"));
	const prev = { data: process.env.YARN_RUNNER_DATA, use: process.env.USE_RECIPES };
	try {
		process.env.YARN_RUNNER_DATA = root;
		process.env.USE_RECIPES = "1";
		const task = "show me how to change the cursor type";
		const dir = path.join(root, "docs", "recipes");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(recipeFileFor(dir, "yarn", task, "cdp"), `${recipeHeader(PASSING, "s", PASS_VERDICT)}1. Open Brand Kit.\n`);

		const { loadGrounding } = await import("../src/core/agent/grounding.js");
		const g = loadGrounding("yarn", "cdp", task);
		assert.equal(g.provenance, "recipe");
		assert.match(g.notes ?? "", /Open Brand Kit/);

		// A DIFFERENT task on the same app must not find it — the appmap tier takes over, and
		// with no appmap on disk that is "none", never the other task's recipe.
		assert.equal(loadGrounding("yarn", "cdp", "create a two-scene script").provenance, "none");
		// Nor may the OTHER backend find it: ax and cdp name surfaces differently, so an
		// ax-derived write-up is not a cdp arm's grounding.
		assert.equal(loadGrounding("yarn", "ax", task).provenance, "none");
	} finally {
		if (prev.data === undefined) delete process.env.YARN_RUNNER_DATA;
		else process.env.YARN_RUNNER_DATA = prev.data;
		if (prev.use === undefined) delete process.env.USE_RECIPES;
		else process.env.USE_RECIPES = prev.use;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("LoadGrounding__Refuses__When__ARetiredTierNameIsSet", async () => {
	// The guard is only worth having if it is WIRED, and a call missing from the one function
	// that chooses a tier is exactly the shape of bug this rename could leave behind. Asserted
	// through loadGrounding rather than through refuseRetiredEnv, which tests itself elsewhere.
	const prev = process.env.USE_PROCEDURES;
	try {
		process.env.USE_PROCEDURES = "1";
		const { loadGrounding } = await import("../src/core/agent/grounding.js");
		assert.throws(() => loadGrounding("yarn", "cdp", "show me how to change the cursor type"), /USE_PROCEDURES/);
		// Even with NO_GROUNDING set, which returns before any file is looked at: a stale name
		// must not be answered with a clean ungrounded run either.
		process.env.NO_GROUNDING = "1";
		assert.throws(() => loadGrounding("yarn", "cdp", "t"), /retired/);
	} finally {
		delete process.env.NO_GROUNDING;
		if (prev === undefined) delete process.env.USE_PROCEDURES;
		else process.env.USE_PROCEDURES = prev;
	}
});

test("ScopeWarnings__AreWithheldFromNonExploreTiers__When__TheGraphIsOnDisk", () => {
	// The confound David caught. The appmap GRAPH is explore-pass output, and its scope-collision
	// warnings are the single most correctness-relevant thing grounding provides — they are what
	// stopped the wrong-scope failure that all four ungrounded cursor runs hit.
	//
	// The graph was being loaded whenever ANY grounding prose loaded, so a curated or recipe
	// arm was getting the explore pass's warnings while its run log said it was grounded on
	// something else. Both arms' questions — "explore pass vs human notes" and "can a write-up
	// replace the exploration pass" — are unanswerable if the pass is quietly in every arm.
	//
	// A source-level check, because the alternative is a full agent run: the gate is one
	// expression, and what matters is that it names the provenance rather than the graph.
	const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "core", "agent", "run.ts"), "utf8");
	assert.match(src, /const fromExplore = Boolean\(grounding\.notes\) && \(grounding\.provenance === "explore" \|\| grounding\.provenance === "explore-vision"\)/);
	assert.match(src, /const warnings = graph && fromExplore \? scopeWarnings\(graph\) : ""/);
	// The graph itself must load UNCONDITIONALLY — including for NO_GROUNDING arms. It never
	// reaches the model: detectMutation reads it to label a change's settingKey and scope, and
	// teardown reads it to plan restores. Gating it on grounding.notes inverted the sign of the
	// matrix's most important claim, because an ungrounded arm could then never journal a
	// document-scope mutation and the report would show grounding CAUSING wrong-scope changes.
	assert.match(src, /const graph = loadAppMapGraph\(slug, backendKind\);/);
	assert.equal(/const graph = grounding\.notes \? loadAppMapGraph/.test(src), false, "the analysis graph must not be gated on the tier");
});
