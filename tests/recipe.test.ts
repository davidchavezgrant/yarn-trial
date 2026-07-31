import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { InteractiveElement, ObservationBundle } from "../src/core/harness.js";
import {
	armAction,
	compileRecipe,
	needsTarget,
	type Recipe,
	RecipeCompileError,
	recipeFileFor,
	resolveTarget,
} from "../src/core/recipe.js";
import { readRecipe } from "../src/core/recipe.js";
import { replayRecipe, type ReplayDeps } from "../src/core/replay.js";
import type { StepRecord } from "../src/types.js";

// --- fixtures -------------------------------------------------------------------------

const ie = (name: string, over: Partial<InteractiveElement> = {}): InteractiveElement => ({
	handle: 0,
	role: "AXButton",
	name,
	surface: "",
	value: "",
	x: 0,
	y: 0,
	w: 0,
	h: 0,
	...over,
});

const obsWith = (interactive: InteractiveElement[], haystack = ""): ObservationBundle => ({
	elementsText: "",
	haystack: haystack.toLowerCase(),
	screenshotB64: "",
	title: "",
	interactive,
	appContent: interactive.length,
	domEnriched: 0,
	frames: new Map(),
});

const step = (over: Partial<StepRecord> = {}): StepRecord => ({
	index: 1,
	timestamp: "2026-07-31T00:00:00Z",
	action: { kind: "tool", name: "click", args: { pid: 1, window_id: 2, element_index: 18 } },
	expectation: { description: "opens", textIncludes: ["Settings"] },
	verified: true,
	verificationChannel: "text",
	verificationNote: "ok",
	targetName: "Open Settings",
	targetRole: "AXButton",
	...over,
});

const runLog = (over: Record<string, unknown> = {}): Record<string, any> => ({
	task: "show me how to change the cursor type",
	app: "Yarn",
	backend: "ax",
	success: true,
	grounding: { tier: "explore" },
	finalCheck: { verified: true, evidence: { description: "done", textIncludes: ["Pointer-first"] } },
	steps: [step()],
	...over,
});

// --- compile --------------------------------------------------------------------------

test("compileRecipe__StripsVolatileHandles__When__StepsCarryThem", () => {
	const r = compileRecipe(runLog(), "2026-07-31T00-00-00-000-yarn");
	assert.deepEqual(r.steps[0].action.args, {});
	assert.equal(r.steps[0].target?.name, "Open Settings");
	assert.equal(r.steps[0].target?.role, "AXButton");
});

test("compileRecipe__CarriesTheTargetSurface__When__TheStepRecordedOne", () => {
	// The gap that made the dual-scope tests below vacuous for months: resolveTarget was well
	// covered with a surface HANDED to it, but nothing checked that compileRecipe ever produces
	// one. It did not — surfaceOf() read `targetSurface` through an `as any` while step.ts never
	// wrote the field — so every compiled recipe carried name+role only, and the narrowing
	// branch those tests exercise could not fire on a real replay.
	const r = compileRecipe(runLog({ steps: [step({ targetSurface: "Brand Kit" })] }), "s-yarn");
	assert.equal(r.steps[0].target?.surface, "Brand Kit");
});

test("compileRecipe__OmitsTheSurface__When__TheStepPredatesTheField", () => {
	// Old recipes and old run logs stay replayable: absent means "resolve by name and role",
	// which is exactly what they have always done.
	const r = compileRecipe(runLog(), "s-yarn");
	assert.equal(r.steps[0].target?.surface, undefined);
	assert.equal(r.steps[0].target?.name, "Open Settings");
});

test("compileRecipe__KeepsPayloadArgs__When__ActionCarriesTextAndKeys", () => {
	const r = compileRecipe(
		runLog({
			steps: [
				step({
					action: { kind: "tool", name: "type_text", args: { pid: 1, window_id: 2, element_index: 4, text: "Fritz Lang" } },
					targetName: "Search",
					targetRole: "AXTextField",
				}),
			],
		}),
		"s-yarn",
	);
	assert.deepEqual(r.steps[0].action.args, { text: "Fritz Lang" });
});

test("compileRecipe__CarriesFinalEvidence__When__TheRunHadAGoalCheck", () => {
	const r = compileRecipe(runLog(), "s-yarn");
	assert.deepEqual(r.finalEvidence, { description: "done", textIncludes: ["Pointer-first"] });
});

test("compileRecipe__Refuses__When__TheRunFailed", () => {
	assert.throws(() => compileRecipe(runLog({ success: false }), "s-yarn"), RecipeCompileError);
});

test("compileRecipe__Refuses__When__AStepWasNotVerified", () => {
	assert.throws(
		() => compileRecipe(runLog({ steps: [step({ verified: false })] }), "s-yarn"),
		/was not verified/,
	);
});

test("compileRecipe__Refuses__When__AStepVerifiedByPixelsOnly", () => {
	// A pixel delta proves SOMETHING changed; a recipe's value is knowing WHAT to check.
	assert.throws(
		() => compileRecipe(runLog({ steps: [step({ verificationChannel: "pixel" })] }), "s-yarn"),
		/pixels only/,
	);
});

test("compileRecipe__DropsWaits__When__TheRunContainedThem", () => {
	const r = compileRecipe(
		runLog({
			steps: [
				step(),
				step({ index: 2, action: { kind: "tool", name: "wait", args: { seconds: 300 } }, targetName: undefined }),
			],
		}),
		"s-yarn",
	);
	assert.equal(r.steps.length, 1);
});

test("compileRecipe__StampsProvenance__When__Compiled", () => {
	const r = compileRecipe(runLog(), "2026-07-31T00-00-00-000-yarn");
	assert.equal(r.compiledFrom, "2026-07-31T00-00-00-000-yarn");
	assert.equal(r.slug, "yarn");
	assert.deepEqual(r.grounding, { tier: "explore" });
});

test("recipeFileFor__SeparatesTasks__When__OneAppHasSeveral", () => {
	const a = recipeFileFor("/r", "yarn", "change the cursor type");
	const b = recipeFileFor("/r", "yarn", "create a new draft");
	assert.notEqual(a, b);
	assert.match(a, /^\/r\/yarn\.[0-9a-f]{8}\.recipe\.json$/);
});

test("readRecipe__RoundTrips__When__WrittenToDisk", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-"));
	const r = compileRecipe(runLog(), "s-yarn");
	const p = path.join(dir, "x.recipe.json");
	fs.writeFileSync(p, JSON.stringify(r));
	assert.deepEqual(readRecipe(p), r);
	assert.throws(() => {
		fs.writeFileSync(p, JSON.stringify({ ...r, version: 2 }));
		readRecipe(p);
	}, /version/);
});

// --- target resolution ----------------------------------------------------------------

test("resolveTarget__ResolvesByName__When__TheNameIsUnique", () => {
	const obs = obsWith([ie("Save", { handle: 7 }), ie("Cancel", { handle: 8 })]);
	assert.deepEqual(resolveTarget({ name: "Save" }, obs), { handle: 7 });
});

test("resolveTarget__NarrowsBySurface__When__TwoControlsShareAName", () => {
	// The dual-scope trap: same control name on the brand panel and the document panel.
	// Resolution must pick by the RECORDED surface, never guess.
	const obs = obsWith([
		ie("Cursor Style", { handle: 3, surface: "Brand Kit" }),
		ie("Cursor Style", { handle: 9, surface: "Screen Recording Settings" }),
	]);
	assert.deepEqual(resolveTarget({ name: "Cursor Style", surface: "Brand Kit" }, obs), { handle: 3 });
});

test("resolveTarget__ReportsAmbiguity__When__NothingSeparatesTwins", () => {
	const obs = obsWith([ie("Save Changes", { handle: 1 }), ie("Save Changes", { handle: 2 })]);
	const r = resolveTarget({ name: "Save Changes" }, obs);
	assert.ok("error" in r && /2 controls/.test(r.error));
});

test("resolveTarget__ResolvesByName__When__TheSurfaceWasRenamed", () => {
	// Progressive narrowing, not absolute gating: a renamed panel must not strand a
	// control whose name is still unique.
	const obs = obsWith([ie("Save", { handle: 5, surface: "Renamed Panel" })]);
	assert.deepEqual(resolveTarget({ name: "Save", surface: "Old Panel" }, obs), { handle: 5 });
});

test("resolveTarget__ReportsMissing__When__TheControlIsGone", () => {
	const r = resolveTarget({ name: "Save" }, obsWith([ie("Cancel")]));
	assert.ok("error" in r && /no control named "Save"/.test(r.error));
});

// --- arming ---------------------------------------------------------------------------

test("armAction__UsesRef__When__BackendIsCdp", () => {
	const s = { action: { name: "click", args: {} }, expectation: { description: "" } };
	assert.deepEqual(armAction(s, "e12", "cdp"), { name: "click", ref: "e12" });
	assert.deepEqual(armAction(s, 18, "ax"), { name: "click", element_index: 18 });
});

test("needsTarget__False__When__CoordinatesArePayload", () => {
	// A canvas drag recorded x/y because there was never an element; its target field is
	// provenance, not addressing, and resolution must not be attempted.
	assert.equal(
		needsTarget({
			action: { name: "click", args: { x: 100, y: 200 } },
			target: { name: "timeline" },
			expectation: { description: "" },
		}),
		false,
	);
	assert.equal(
		needsTarget({ action: { name: "click", args: {} }, target: { name: "Save" }, expectation: { description: "" } }),
		true,
	);
});

// --- replay ---------------------------------------------------------------------------

/**
 * A scripted CDP-shaped backend: observations come from a queue, acts are recorded. The
 * engine's contract is observe/act, so the fake implements exactly that — the same pattern
 * as cleanup's scripted driver.
 */
function fakeDeps(observations: ObservationBundle[], opts: Partial<ReplayDeps> = {}) {
	const acts: any[] = [];
	let i = 0;
	const cdp = {
		act: async (a: any) => {
			acts.push(a);

			return "ok";
		},
	} as any;

	return {
		acts,
		deps: {
			cdp,
			observe: async () => observations[Math.min(i++, observations.length - 1)],
			log: () => {},
			...opts,
		} as ReplayDeps,
	};
}

const recipeOf = (steps: Recipe["steps"], over: Partial<Recipe> = {}): Recipe => ({
	version: 1,
	task: "t",
	app: "A",
	slug: "a",
	backend: "cdp",
	compiledFrom: "src-stamp",
	compiledAt: "2026-07-31T00:00:00Z",
	steps,
	...over,
});

test("replayRecipe__VerifiesWithZeroModelCalls__When__TheAppMatchesTheRecording", async () => {
	process.env.RECIPE_SETTLE_MS = "0";
	const r = recipeOf(
		[
			{
				action: { name: "click", args: {} },
				target: { name: "Open Settings" },
				expectation: { description: "", textIncludes: ["Settings Panel"] },
			},
		],
		{ finalEvidence: { description: "", textIncludes: ["Settings Panel"] } },
	);
	const { deps, acts } = fakeDeps([
		obsWith([ie("Open Settings", { handle: "e5" })], "Library"),
		obsWith([ie("Close", { handle: "e9" })], "Settings Panel"),
		obsWith([], "Settings Panel"),
	]);
	const result = await replayRecipe(r, deps);
	assert.equal(result.ok, true);
	assert.equal(result.modelCalls, 0);
	assert.deepEqual(acts, [{ name: "click", ref: "e5" }]);
	assert.equal(result.steps[0].outcome, "verified");
});

test("replayRecipe__FailsTheStep__When__TheCheckDoesNotDiscriminate", async () => {
	process.env.RECIPE_SETTLE_MS = "0";
	// The recorded text is already on screen BEFORE the action: same verify() authority as
	// a live run — a non-discriminating pass proves nothing and must not count.
	const r = recipeOf([
		{
			action: { name: "click", args: {} },
			target: { name: "Open Settings" },
			expectation: { description: "", textIncludes: ["Library"] },
		},
	]);
	const { deps } = fakeDeps([
		obsWith([ie("Open Settings", { handle: "e5" })], "Library"),
		obsWith([], "Library"),
	]);
	const result = await replayRecipe(r, deps);
	assert.equal(result.ok, false);
	assert.equal(result.steps[0].outcome, "failed");
	assert.match(result.steps[0].note, /check failed/);
});

test("replayRecipe__StopsAtTheBrokenStep__When__ATargetCannotResolve", async () => {
	process.env.RECIPE_SETTLE_MS = "0";
	const r = recipeOf([
		{ action: { name: "click", args: {} }, target: { name: "Gone" }, expectation: { description: "", textIncludes: ["x"] } },
		{ action: { name: "click", args: {} }, target: { name: "Never Reached" }, expectation: { description: "", textIncludes: ["y"] } },
	]);
	const { deps, acts } = fakeDeps([obsWith([ie("Other")], "start")]);
	const result = await replayRecipe(r, deps);
	assert.equal(result.ok, false);
	assert.equal(result.steps.length, 1);
	assert.deepEqual(acts, [], "an unresolved target must not act at all");
	assert.match(result.steps[0].note, /no control named "Gone"/);
});

test("replayRecipe__InvokesRescueOnce__When__AStepBreaksAndRescueIsWired", async () => {
	process.env.RECIPE_SETTLE_MS = "0";
	const rescueCalls: string[] = [];
	const r = recipeOf(
		[
			{
				action: { name: "click", args: {} },
				target: { name: "Moved Button" },
				expectation: { description: "", textIncludes: ["Opened"] },
			},
		],
		{ finalEvidence: { description: "", textIncludes: ["Opened"] } },
	);
	const { deps } = fakeDeps(
		[
			obsWith([ie("Renamed Button", { handle: "e2" })], "start"),
			obsWith([], "start"), // pre-rescue re-observation
			obsWith([], "Opened"), // post-rescue observation
			obsWith([], "Opened"), // final check
		],
		{
			client: {} as any,
			model: "m",
			rescue: async (a) => {
				rescueCalls.push(a.problem);

				return { ok: true, note: "rescued in 1 action(s)", calls: 1 };
			},
		},
	);
	const result = await replayRecipe(r, deps);
	assert.equal(result.ok, true);
	assert.equal(result.modelCalls, 1);
	assert.equal(result.steps[0].outcome, "rescued");
	assert.match(rescueCalls[0], /no control named "Moved Button"/);
});

test("replayRecipe__FailsHonestly__When__RescueIsDisabled", async () => {
	process.env.RECIPE_SETTLE_MS = "0";
	const r = recipeOf([
		{ action: { name: "click", args: {} }, target: { name: "Gone" }, expectation: { description: "", textIncludes: ["x"] } },
	]);
	// No client/rescue in deps: the deterministic-only mode a fleet runs unattended.
	const { deps } = fakeDeps([obsWith([], "start")]);
	const result = await replayRecipe(r, deps);
	assert.equal(result.ok, false);
	assert.equal(result.modelCalls, 0);
});

test("replayRecipe__GatesOnFinalEvidence__When__TheRecipeCarriesIt", async () => {
	process.env.RECIPE_SETTLE_MS = "0";
	// Every step verifies but the goal state is absent from the final observation: the
	// replay must fail overall, same authority as done(success) grading in the live loop.
	const r = recipeOf(
		[
			{
				action: { name: "click", args: {} },
				target: { name: "Open Settings" },
				expectation: { description: "", textIncludes: ["Settings Panel"] },
			},
		],
		{ finalEvidence: { description: "", textIncludes: ["Pointer-first"] } },
	);
	const { deps } = fakeDeps([
		obsWith([ie("Open Settings", { handle: "e5" })], "Library"),
		obsWith([], "Settings Panel"),
		obsWith([], "Settings Panel but not the goal value"),
	]);
	const result = await replayRecipe(r, deps);
	assert.equal(result.ok, false);
	assert.equal(result.finalCheck?.verified, false);
});

test("replayRecipe__WritesStepRecords__When__Replaying", async () => {
	process.env.RECIPE_SETTLE_MS = "0";
	const r = recipeOf([
		{
			action: { name: "click", args: {} },
			target: { name: "Open Settings" },
			expectation: { description: "", textIncludes: ["Settings Panel"] },
		},
	]);
	const { deps } = fakeDeps([
		obsWith([ie("Open Settings", { handle: "e5" })], "Library"),
		obsWith([], "Settings Panel"),
	]);
	const result = await replayRecipe(r, deps);
	assert.equal(result.records.length, 1);
	assert.equal(result.records[0].verified, true);
	assert.equal(result.records[0].verificationChannel, "text");
	assert.match(result.records[0].modelReasoning ?? "", /src-stamp/);
});
