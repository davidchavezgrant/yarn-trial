import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { InteractiveElement, ObservationBundle } from "../src/core/harness.js";
import {
	armAction,
	compileProcedure,
	needsTarget,
	type Procedure,
	ProcedureCompileError,
	procedureFileFor,
	resolveTarget,
} from "../src/core/procedure.js";
import { readProcedure } from "../src/core/procedure.js";
import { replayProcedure, type ReplayDeps } from "../src/core/replay.js";
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

test("compileProcedure__StripsVolatileHandles__When__StepsCarryThem", () => {
	const r = compileProcedure(runLog(), "2026-07-31T00-00-00-000-yarn");
	assert.deepEqual(r.steps[0].action.args, {});
	assert.equal(r.steps[0].target?.name, "Open Settings");
	assert.equal(r.steps[0].target?.role, "AXButton");
});

test("compileProcedure__CarriesTheTargetSurface__When__TheStepRecordedOne", () => {
	// The gap that made the dual-scope tests below vacuous for months: resolveTarget was well
	// covered with a surface HANDED to it, but nothing checked that compileProcedure ever produces
	// one. It did not — surfaceOf() read `targetSurface` through an `as any` while step.ts never
	// wrote the field — so every compiled procedure carried name+role only, and the narrowing
	// branch those tests exercise could not fire on a real replay.
	const r = compileProcedure(runLog({ steps: [step({ targetSurface: "Brand Kit" })] }), "s-yarn");
	assert.equal(r.steps[0].target?.surface, "Brand Kit");
});

test("compileProcedure__OmitsTheSurface__When__TheStepPredatesTheField", () => {
	// Old procedures and old run logs stay replayable: absent means "resolve by name and role",
	// which is exactly what they have always done.
	const r = compileProcedure(runLog(), "s-yarn");
	assert.equal(r.steps[0].target?.surface, undefined);
	assert.equal(r.steps[0].target?.name, "Open Settings");
});

test("compileProcedure__KeepsPayloadArgs__When__ActionCarriesTextAndKeys", () => {
	const r = compileProcedure(
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

test("compileProcedure__CarriesFinalEvidence__When__TheRunHadAGoalCheck", () => {
	const r = compileProcedure(runLog(), "s-yarn");
	assert.deepEqual(r.finalEvidence, { description: "done", textIncludes: ["Pointer-first"] });
});

test("compileProcedure__Refuses__When__TheRunFailed", () => {
	assert.throws(() => compileProcedure(runLog({ success: false }), "s-yarn"), ProcedureCompileError);
});

test("compileProcedure__Refuses__When__AStepWasNotVerified", () => {
	assert.throws(
		() => compileProcedure(runLog({ steps: [step({ verified: false })] }), "s-yarn"),
		/was not verified/,
	);
});

test("compileProcedure__Refuses__When__AStepVerifiedByPixelsOnly", () => {
	// A pixel delta proves SOMETHING changed; a procedure's value is knowing WHAT to check.
	assert.throws(
		() => compileProcedure(runLog({ steps: [step({ verificationChannel: "pixel" })] }), "s-yarn"),
		/pixels only/,
	);
});

test("compileProcedure__DropsWaits__When__TheRunContainedThem", () => {
	const r = compileProcedure(
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

test("compileProcedure__StampsProvenance__When__Compiled", () => {
	const r = compileProcedure(runLog(), "2026-07-31T00-00-00-000-yarn");
	assert.equal(r.compiledFrom, "2026-07-31T00-00-00-000-yarn");
	assert.equal(r.slug, "yarn");
	assert.deepEqual(r.grounding, { tier: "explore" });
});

test("procedureFileFor__SeparatesTasks__When__OneAppHasSeveral", () => {
	const a = procedureFileFor("/r", "yarn", "change the cursor type");
	const b = procedureFileFor("/r", "yarn", "create a new draft");
	assert.notEqual(a, b);
	assert.match(a, /^\/r\/yarn\.[0-9a-f]{8}\.procedure\.json$/);
});

test("readProcedure__RoundTrips__When__WrittenToDisk", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "procedure-"));
	const r = compileProcedure(runLog(), "s-yarn");
	const p = path.join(dir, "x.procedure.json");
	fs.writeFileSync(p, JSON.stringify(r));
	assert.deepEqual(readProcedure(p), r);
	assert.throws(() => {
		fs.writeFileSync(p, JSON.stringify({ ...r, version: 2 }));
		readProcedure(p);
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

const procedureOf = (steps: Procedure["steps"], over: Partial<Procedure> = {}): Procedure => ({
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

test("replayProcedure__VerifiesWithZeroModelCalls__When__TheAppMatchesTheRecording", async () => {
	process.env.PROCEDURE_SETTLE_MS = "0";
	const r = procedureOf(
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
	const result = await replayProcedure(r, deps);
	assert.equal(result.ok, true);
	assert.equal(result.modelCalls, 0);
	assert.deepEqual(acts, [{ name: "click", ref: "e5" }]);
	assert.equal(result.steps[0].outcome, "verified");
});

test("replayProcedure__FailsTheStep__When__TheCheckDoesNotDiscriminate", async () => {
	process.env.PROCEDURE_SETTLE_MS = "0";
	// The recorded text is already on screen BEFORE the action: same verify() authority as
	// a live run — a non-discriminating pass proves nothing and must not count.
	const r = procedureOf([
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
	const result = await replayProcedure(r, deps);
	assert.equal(result.ok, false);
	assert.equal(result.steps[0].outcome, "failed");
	assert.match(result.steps[0].note, /check failed/);
});

test("replayProcedure__StopsAtTheBrokenStep__When__ATargetCannotResolve", async () => {
	process.env.PROCEDURE_SETTLE_MS = "0";
	const r = procedureOf([
		{ action: { name: "click", args: {} }, target: { name: "Gone" }, expectation: { description: "", textIncludes: ["x"] } },
		{ action: { name: "click", args: {} }, target: { name: "Never Reached" }, expectation: { description: "", textIncludes: ["y"] } },
	]);
	const { deps, acts } = fakeDeps([obsWith([ie("Other")], "start")]);
	const result = await replayProcedure(r, deps);
	assert.equal(result.ok, false);
	assert.equal(result.steps.length, 1);
	assert.deepEqual(acts, [], "an unresolved target must not act at all");
	assert.match(result.steps[0].note, /no control named "Gone"/);
});

test("replayProcedure__InvokesRescueOnce__When__AStepBreaksAndRescueIsWired", async () => {
	process.env.PROCEDURE_SETTLE_MS = "0";
	const rescueCalls: string[] = [];
	const r = procedureOf(
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
	const result = await replayProcedure(r, deps);
	assert.equal(result.ok, true);
	assert.equal(result.modelCalls, 1);
	assert.equal(result.steps[0].outcome, "rescued");
	assert.match(rescueCalls[0], /no control named "Moved Button"/);
});

test("replayProcedure__FailsHonestly__When__RescueIsDisabled", async () => {
	process.env.PROCEDURE_SETTLE_MS = "0";
	const r = procedureOf([
		{ action: { name: "click", args: {} }, target: { name: "Gone" }, expectation: { description: "", textIncludes: ["x"] } },
	]);
	// No client/rescue in deps: the deterministic-only mode a fleet runs unattended.
	const { deps } = fakeDeps([obsWith([], "start")]);
	const result = await replayProcedure(r, deps);
	assert.equal(result.ok, false);
	assert.equal(result.modelCalls, 0);
});

test("replayProcedure__GatesOnFinalEvidence__When__TheProcedureCarriesIt", async () => {
	process.env.PROCEDURE_SETTLE_MS = "0";
	// Every step verifies but the goal state is absent from the final observation: the
	// replay must fail overall, same authority as done(success) grading in the live loop.
	const r = procedureOf(
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
	const result = await replayProcedure(r, deps);
	assert.equal(result.ok, false);
	assert.equal(result.finalCheck?.verified, false);
});

test("replayProcedure__WritesStepRecords__When__Replaying", async () => {
	process.env.PROCEDURE_SETTLE_MS = "0";
	const r = procedureOf([
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
	const result = await replayProcedure(r, deps);
	assert.equal(result.records.length, 1);
	assert.equal(result.records[0].verified, true);
	assert.equal(result.records[0].verificationChannel, "text");
	assert.match(result.records[0].modelReasoning ?? "", /src-stamp/);
});

test("replayEntryPoints__MarkTheAppTargetForAttach__When__DrivingOverCdp", () => {
	// An app target driven over CDP must carry cdpAttach: that flag is what lets acquisition
	// (re)launch the app with --remote-debugging-port. agent/cli.ts and explore/cli.ts both do
	// it; procedure-cli.ts did not, and the gap was invisible locally because a hand-run replay
	// always followed a flagged launch by some earlier command.
	//
	// The first fleet dispatch of phase 3 failed 6 for 6 across two Macs: nothing listening on
	// :9222, nothing permitted to relaunch Yarn, runs dead before they wrote a log — which
	// collect read as two poisoned hosts, blaming the machines for a one-line omission.
	//
	// A CANARY over source, not a proof: standing up a CDP endpoint in a unit test costs more
	// than it is worth, and the three call sites word the branch differently. What it catches is
	// an entry point that loses the upgrade entirely — which is exactly how this shipped.
	for (const rel of ["agent/cli.ts", "explore/cli.ts", "procedure-cli.ts"]) {
		const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "core", rel), "utf8");
		assert.ok(
			/=\s*electronTarget\(/.test(src),
			`${rel} drives an app over cdp and must upgrade its target with electronTarget(), or acquisition cannot relaunch the app`,
		);
	}
});

test("replay__QuitsTheAppBeforeAcquiring__When__ColdStartingARun", () => {
	// Ordering, asserted as ordering. coldStart quits the target so acquisition relaunches it
	// clean; run it AFTER a backend has attached and it kills the very page/window the replay
	// just connected to.
	//
	// That is what happened: the call sat inside the try block ahead of the AX `findWindow`,
	// which reads as "before acquisition" on the AX path only — the CDP acquire is earlier in
	// the function. Every fleet replay died with "the page this run was driving closed and no
	// successor window appeared — saw: (no pages)". Locally it never showed, because the app was
	// already running and the post-quit relaunch restored an endpoint before the first observe.
	const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "core", "procedure-cli.ts"), "utf8");
	const cold = src.indexOf("await coldStart(");
	assert.ok(cold > 0, "replay must cold-start the app");
	for (const acquire of ["CdpBackend.acquire(target)", "await findWindow(driver!"])
		assert.ok(cold < src.indexOf(acquire), `coldStart must precede ${acquire} — quitting after attach kills what was attached`);
});

test("procedureFileFor__SeparatesBackends__When__OneTaskIsRecordedOnBoth", () => {
	// ax and cdp name the same controls differently, so a procedure — a frozen sequence of
	// (name, surface, role) resolutions — is per BACKEND, not merely per task. Keyed on
	// (app, task) alone, phase 3's two compile arms wrote one path: the cdp compile's 9 steps
	// overwrote the ax compile's 11, and replay-ax deferred forever because its gate wanted
	// an ax procedure and the only file present was cdp's.
	const ax = procedureFileFor("/r", "yarn", "change the cursor type", "ax");
	const cdp = procedureFileFor("/r", "yarn", "change the cursor type", "cdp");
	assert.notEqual(ax, cdp);
	assert.match(ax, /\.ax\.procedure\.json$/);
	// Omitting the backend still yields the legacy name, so procedures compiled before the key
	// changed remain findable rather than silently unreplayable.
	assert.match(procedureFileFor("/r", "yarn", "change the cursor type"), /^\/r\/yarn\.[0-9a-f]{8}\.procedure\.json$/);
});

test("replay__WaitsForTheAppToPaint__When__TheColdStartJustRelaunchedIt", () => {
	// On CDP, acquisition returns as soon as the DEBUG PORT answers — which Electron's main
	// process opens well before the renderer has content. Without a wait, step 1 resolves
	// against a blank page: every no-rescue replay died on `[1/9] click "New Draft" — no
	// control named "New Draft"` with zero model calls, while the rescued arm needed just ONE
	// rescue and then completed, which is impossible if the control is genuinely absent.
	//
	// explore/loop.ts hit the same race after its own cold start and polls; this asserts replay
	// does too, and that the poll precedes the step loop rather than trailing it.
	const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "core", "procedure-cli.ts"), "utf8");
	const poll = src.indexOf("FIRST_OBSERVATION_TRIES; attempt++");
	assert.ok(poll > 0, "replay must poll for first paint after the cold start");
	assert.ok(poll < src.indexOf("await replayProcedure("), "the paint wait must precede the step loop");
});

/**
 * Invoke the real CLI as a child process, exactly as an operator would. In-process this test
 * cannot exist: `main` is not exported, and the thing under test is the guard's POSITION relative
 * to everything else main does, which only a real entry point can show.
 *
 * A bogus stamp is deliberate. It gives the run a second, LOUDER failure to race — resolving the
 * argument — so "which error came out" answers "did the guard run first" without asserting on line
 * numbers or reaching a driver.
 */
function runProcedureCli(argv: string[], extraEnv: Record<string, string> = {}): { code: number; output: string } {
	const r = spawnSync("npx", ["tsx", "src/core/procedure-cli.ts", ...argv], {
		cwd: path.resolve(import.meta.dirname, ".."),
		encoding: "utf8",
		env: { ...process.env, ...extraEnv },
	});

	return { code: r.status ?? -1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

test("replay__RefusesARetiredEnvName__When__TheReplayEntryPointStarts", () => {
	// RECIPE_RESCUE, RECIPE_RESCUE_STEPS and RECIPE_SETTLE_MS are REPLAY-side knobs retired by the
	// 2026-08-03 swap, and this CLI is the only command an operator would ever set them for. Yet
	// refuseRetiredEnv had exactly one caller — loadGrounding, which a replay never reaches, because
	// a replay executes frozen steps and chooses no grounding tier. So on the one code path where
	// those names get typed, the guard could not fire: setting RECIPE_SETTLE_MS did what an unset
	// variable does (replay took the 900ms default) and RECIPE_RESCUE left rescue on, silently.
	// That is the exact silent-no-op class the guard exists to prevent, and it was unreachable
	// precisely where it mattered.
	//
	// Asserted through the ORDERING: the bogus stamp below fails loudly on its own, so seeing the
	// retirement message instead proves the guard ran ahead of any replay work.
	const stale = runProcedureCli(["replay", "definitely-not-a-run-stamp"], { RECIPE_RESCUE: "1" });
	assert.equal(stale.code, 1);
	assert.match(stale.output, /RECIPE_RESCUE was retired/);
	assert.match(stale.output, /--no-rescue flag/);
	assert.doesNotMatch(stale.output, /neither a procedure file nor a run stamp/);

	// The control, and the half that makes the assertion above mean something: with a clean
	// environment the same argv gets PAST the guard and dies on the stamp. A guard that refused
	// every invocation would satisfy the first half alone.
	//
	// Blanked rather than merely omitted, because the child inherits this process's environment: a
	// developer who has RECIPE_RESCUE exported for their own reasons would otherwise see this
	// control fail. The guard reads blank as unset, which is the same contract envNum honours.
	const clean = runProcedureCli(["replay", "definitely-not-a-run-stamp"], { RECIPE_RESCUE: "", RECIPE_RESCUE_STEPS: "", RECIPE_SETTLE_MS: "" });
	assert.equal(clean.code, 1);
	assert.match(clean.output, /neither a procedure file nor a run stamp/);
});

test("resolveTarget__PicksTheRecordedTwin__When__NothingElseSeparatesThem", () => {
	// Yarn's Library carries two controls named "New Draft". Identity cannot separate them, so
	// resolution refused — correctly, but that stopped every no-rescue replay dead on step 1
	// (0/3, zero model calls). The recording always knew which one it used.
	const obs = obsWith([ie("New Draft", { handle: 4 }), ie("New Draft", { handle: 9 })]);
	assert.deepEqual(resolveTarget({ name: "New Draft", ordinal: 1 }, obs), { handle: 9 });
	assert.deepEqual(resolveTarget({ name: "New Draft", ordinal: 0 }, obs), { handle: 4 });
});

test("resolveTarget__StillRefuses__When__TheTwinCountChanged", () => {
	// An index into a DIFFERENT list is not evidence. If the page no longer has the number of
	// twins the recording saw, it is not the page that was recorded and the ordinal means
	// nothing — refusing beats clicking the wrong control confidently.
	const obs = obsWith([ie("New Draft", { handle: 4 }), ie("New Draft", { handle: 9 }), ie("New Draft", { handle: 11 })]);
	const r = resolveTarget({ name: "New Draft", ordinal: 5 }, obs);
	assert.ok("error" in r && /ambiguous/.test(r.error));
});

test("resolveTarget__PrefersIdentity__When__SurfaceAlreadySeparatesTwins", () => {
	// The ordinal is a LAST resort: document order is weaker evidence than a name, and letting
	// it win would send a click to the wrong panel whenever a list reordered.
	const obs = obsWith([
		ie("Cursor Style", { handle: 3, surface: "Brand Kit" }),
		ie("Cursor Style", { handle: 9, surface: "Screen Recording Settings" }),
	]);
	assert.deepEqual(resolveTarget({ name: "Cursor Style", surface: "Brand Kit", ordinal: 1 }, obs), { handle: 3 });
});

test("compileProcedure__Parameterises__When__TheRecordedValueWasGeneratedPerRun", () => {
	// Replay typed the recorded scratch name verbatim, so the SECOND replay found the field
	// already reading it: "expectation met, but every check was ALREADY satisfied before the
	// action — no evidence the action changed anything." The check is right; the procedure was
	// wrong to promise a value that stops being new after one use.
	const r = compileProcedure(
		runLog({
			steps: [
				step({
					action: { kind: "tool", name: "type_text", args: { element_index: 4, text: "Scratch Cursor Type Demo 1337700534" } },
					targetName: "Untitled",
					targetRole: "textbox",
					expectation: { description: "title updates", textIncludes: ["Scratch Cursor Type Demo 1337700534"], textExcludes: ["Untitled Draft"] },
				}),
			],
		}),
		"s-yarn",
	);
	// Text and the checks that quote it must move TOGETHER, or replay types one value and
	// asserts another.
	assert.equal(r.steps[0].action.args.text, "Scratch Cursor Type Demo {{unique}}");
	assert.deepEqual(r.steps[0].expectation.textIncludes, ["Scratch Cursor Type Demo {{unique}}"]);
	assert.deepEqual(r.steps[0].expectation.textExcludes, ["Untitled Draft"]);
});

test("compileProcedure__LeavesMeaningfulNumbersAlone__When__TheyAreNotGeneratedIds", () => {
	// "2 scenes" and "1080" are content, not a per-run token. Six-plus digits is the line.
	const r = compileProcedure(
		runLog({
			steps: [
				step({
					action: { kind: "tool", name: "type_text", args: { element_index: 4, text: "Scene 2 at 1080p" } },
					targetName: "Script",
					expectation: { description: "typed", textIncludes: ["Scene 2 at 1080p"] },
				}),
			],
		}),
		"s-yarn",
	);
	assert.equal(r.steps[0].action.args.text, "Scene 2 at 1080p");
});
