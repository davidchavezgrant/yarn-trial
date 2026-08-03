import assert from "node:assert/strict";
import { appmapSlug } from "../src/core/target.js";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { auditTaskPrompt } from "../src/core/harness.js";
import type { JobRecord } from "../src/remote/runner/jobs.js";
import { collect, collectEntry, expectedProvenance, failureKind, jobTiming, journalScopes, parseAppmapStamp, parseGraphCounts, parseRunMetrics, poisonedHosts, technicalFailure } from "../src/bench/collect.js";
import { archiveDirFor, entriesForArm, manifestPath, readManifest, recordSubmissions, submittedCount, type Manifest, type ManifestEntry, updateEntry, writeManifest } from "../src/bench/manifest.js";
import { BACKENDS, BENCH_ALT_MODEL, BENCH_APP, BENCH_PRIMARY_MODEL, CREATION_EXCLUDED, EXPLORE_SAMPLES, armModel, MATRIX, armAppmapSlug, armById, armTitle, discoveryArmsFor, orderStages, perceptionLine, phaseArms, phaseRunCount, recipeArms, STAGES, stageNeedsMaps, stageOf, type Arm } from "../src/bench/matrix.js";
import type { DispatchOptions } from "../src/remote/control/dispatch.js";
import { EXIT_NEEDS_GO, EXIT_OK, EXIT_REFUSED, auditPhase, dateArg, dispatchOptionsFor, findCompileSource, plannedRuns, runPhase } from "../src/bench/orchestrate.js";
import { renderReport, reportFileName, writeReport } from "../src/bench/report.js";
import { host, withTemp, withTempAsync } from "./fixtures.js";
import { ARCHIVE_DIR, RUN_FILES, archiveRunDir, liveDir, runDir, runPath } from "../src/paths.js";
import { phaseProgress, watchPhase } from "../src/bench/watch.js";

/**
 * The bench orchestrator, offline by construction — the same rule as dispatch.test.ts:
 * every dispatch is an injected fake and every file lands in a temp dir. Nothing here may
 * contact the fleet; a stray real submit takes a colo Mac out for the length of a run.
 *
 * The matrix-integrity tests are the executable copy of the plan doc's totals (as amended
 * 2026-07-31: dom cut, web-explore check, then the Notion Calendar slice and
 * vision-only-grounded cut). When the plan changes, change matrix.ts and these numbers
 * TOGETHER — a drifting pair is the failure mode.
 */

const DATE = "2026-07-31";

// --- matrix integrity ---

test("MATRIX__HasUniqueArmIds__When__Defined", () => {
	const ids = MATRIX.map((a) => a.id);
	assert.equal(new Set(ids).size, ids.length);
});

test("MATRIX__MatchesPlanPhaseTotals__When__Counted", () => {
	// Phase 1: ax and cdp explores at n=2 each — every number here was a point estimate with
	// no error bar, and the vision arm gave 8 surfaces then 3 under identical code, so a
	// backend gap of 63-vs-31 could not be told from noise. Free in wall-clock: four arms on
	// three Macs is already two waves and six is still two. Plus the two single-channel passes. The web
	// (Notion) explore was dropped 2026-08-01 — the prompt and frontier fixes force a re-run
	// of every grounding pass, and at 1h14m it was the longest in the matrix. Its data is
	// kept as a one-off; only the re-running stopped. The vision-only one landed 2026-07-31 (three vision-only TASK arms
	// existed with no vision-only GROUNDING); the element-only one 2026-08-01, closing the
	// mirror gap — phase 2 tested dropping screenshots during a task but never during
	// grounding, which is where they cost the most.
	// Nine: ax x2 and cdp x2 (the reference arms, repeated for an error bar), plus the five
	// single-condition cells that complete the perception grid — element channel in four
	// states crossed with screenshots on/off, minus the refused empty one.
	// Ten since 2026-08-02: the vision-only cdp explore arm joined, both to write the map its
	// task arm reads and to separate "vision-only discovers little" from "vision-only could not
	// open what it clicked".
	// +2 since 2026-08-03: the second app brings its own Discovery, full-perception and
	// no-vision, because a map is per-target and Yarn's says nothing about Notion.
	// EVERY explore arm at EXPLORE_SAMPLES since 2026-08-03 (the sampling policy): 10 arms
	// x 2. It was 3 arms at n=2 and 7 at n=1, which left the widest-spread arm in the matrix
	// (explore-vision, 9 vs 21 surfaces) as the one with no error bar.
	assert.equal(phaseRunCount(1), 10 * EXPLORE_SAMPLES);
	// Phase 2: core 2 backends × 2 grounding × 3, plus 6 slices × 3. Two blocks were cut
	// 2026-07-31 after their prerequisites were CHECKED rather than assumed (matrix.ts holds
	// the full reasoning at each site): the Notion Calendar slice (4 arms × 2 = 8 runs — the
	// app is installed on none of the three Macs, so every run would refuse at the readiness
	// gate) and vision-only-grounded (3 runs — its `.vision` appmap does not exist, and a
	// missing map degrades to provenance "none", making it a silent duplicate of the
	// ungrounded arm under a grounded label).
	// Phase 2: core 12, plus 8 slices × 3 — the vision-only tier is now four arms
	// (ungrounded floor / ax-written map / vision-written map / human notes).
	// Phase 2: core 12, 8 slices x 3, plus the web generalization slice (2 arms x 2). The web
	// arms restore the question the Notion Calendar cut lost — does anything transfer to a
	// second, larger app — on a target that needs a login rather than an install.
	// Phase 2: core 12 plus 8 slices x 3. The two web arms went with the web explore — they
	// grounded on its map and had nothing to ground on without it.
	// Phase 2: core 12, 8 slices x 3, plus the minimum-context PAIR x 3 — bare AX with
	// no DOM attrs and no screenshots, grounded on an equally minimal map and ungrounded. The
	// ungrounded half is the floor of the whole matrix; every other arm should beat it.
	// core 12 (2 backends x grounded/ungrounded x 3), slices 27, recipes-tier comparators 6.
	// Slices went 24 -> 27 on 2026-08-01: the native-equivalent grid (AXDOM=0, i.e. AX
	// with no DOM behind it) was missing its cold+screenshots cell.
	// Stage 2 Configuration (2026-08-03): the old phase-2 grid (12 core + 27 slices + 6
	// recipe-tier comparators = 45) plus the five cdp cells that came home from phase 7 —
	// four vision-only and one grounded on a vision-written map. They vary perception and
	// grounding tier on the canonical task, which is this stage's definition.
	// 45 + 15 + 6: the two snap arms joined stage 2 on 2026-08-03 — vision-only reasoning with
	// element-precise actuation, the refinement stage the redaction pipeline has and UI driving
	// lacked.
	assert.equal(phaseRunCount(2), 45 + 15 + 6);
	// Stage 3 Reuse: both frozen-artifact tiers together, so the report can finally compare
	// them. Procedures (2 local compiles + 6 replays + 3 no-rescue) and recipes (4 arms x 3).
	assert.equal(phaseRunCount(3), 11 + 12);
	// Stage 4 Generalization: second task (7), the creation task on every stage-2 config
	// carried over from phase 7 (15 x 3), the model axis (3 x 3), and — since 2026-08-03 — the
	// second APP: three cdp cells crossed with a simple and a complex task (6 x 3).
	// 51, not 45: the creation task derives from EVERY stage-2 config, so the two snap arms added
	// there carry creation twins here automatically. That propagation is the derivation working —
	// the alternative is remembering to add them.
	// +3 since 2026-08-03: the three blur cells took TASK_SAMPLES like every other measured
	// cell instead of the n=2 the old ~5-8 run budget bought.
	assert.equal(phaseRunCount(4), 7 + 51 + 9 + 18 + 3);
	// Stage 9 Diagnostics: the AX-offset pair at n=2. Off the ladder — it measures the rig.
	assert.equal(phaseRunCount(9), 4);
	// The collapse REGROUPED; it did not add or drop a run. This is the guard on that claim, and
	// the +16 is kept as its own term rather than folded in so the claim stays checkable: the
	// snap pair adds 6 in stage 2, 6 more as creation twins in stage 4 (derived from every
	// stage-2 config), and 4 filmed takes in stage 5. Three derivations firing off two arms —
	// which is the structure working, and also why the number moves more than it looks like it
	// should.
	assert.equal(
		STAGES.reduce((t, st) => t + phaseRunCount(st.n), 0),
		// +10 since 2026-08-03: 7 explore repeats and 3 blur samples, from making the counts
		// uniform per family rather than per arm.
		207 + 20 + 16 + 10,
	);
	// Phase 5 (filmed): one take per phase-2 task config (14, including the minimum-context
	// pair — derived from the phase-2 arms, so adding a config there adds a filmed take here)
	// plus one filmed replay per backend.
	// Phase 5 films EVERY task and replay arm in the matrix at n=1 (David, 2026-08-01: the
	// deliverable is a corpus showing how each lever moves outcomes, not one good video), so it
	// is derived rather than counted — a hardcoded number here would just be a second place to
	// update whenever an arm is added anywhere upstream.
	// Phase 8 is excluded: it is a diagnostics PAIR (one plain arm, one filmed) and the filmed
	// half is the measurement, not a take of the other. Deriving a twin for it would film the
	// same config twice and compare a run against itself.
	// BENCH_APP-scoped, matching production: the second app is measured and deliberately unfilmed.
	const filmable = MATRIX.filter((a) => a.app === BENCH_APP && stageOf(a.phase)?.kind === "measurement" && (a.kind === "task" || a.kind === "replay"));
	assert.equal(phaseRunCount(5), filmable.length);
});

/**
 * The guards the old numbering never had. Five hand-maintained copies of `[1..8]` and seven
 * behaviours keyed on literal values meant a new stage was correct only if someone remembered
 * every site; these assert the table itself instead.
 */
test("STAGES__DeclareAnAcyclicOrder__When__EveryStageIsRequested", () => {
	const order = orderStages(STAGES.map((st) => st.n));
	assert.equal(order.length, STAGES.length, "every declared stage is orderable — a cycle drops one");
	for (const [i, p] of order.entries()) {
		for (const dep of stageOf(p)?.needs ?? []) {
			assert.ok(order.indexOf(dep) < i, `stage ${p} runs before its dependency ${dep}`);
		}
	}
});

test("STAGES__PutDeliverablesLast__When__AllRequested", () => {
	// This used to be a special case in the sort ("ascending, except 5 always runs last").
	// It is now a CONSEQUENCE of Deliverables declaring needs: [2, 4] — delete that and the
	// test fails, which is the point.
	const order = orderStages(STAGES.map((st) => st.n));
	const deliverable = STAGES.find((st) => st.kind === "deliverable")!;
	for (const m of STAGES.filter((st) => st.kind === "measurement")) {
		assert.ok(order.indexOf(m.n) < order.indexOf(deliverable.n), `${m.title} must run before filming`);
	}
	// And the off-ladder stage yields to all of it: Diagnostics blocks nothing, so it waits
	// rather than putting harness runs in front of the pass the operator asked for.
	assert.equal(order.at(-1), STAGES.find((st) => st.kind === "diagnostic")!.n);
});

test("STAGES__AreUniqueAndCoverEveryArm__When__TheMatrixIsWalked", () => {
	assert.equal(new Set(STAGES.map((st) => st.n)).size, STAGES.length, "two stages share a number");
	assert.equal(new Set(STAGES.map((st) => st.id)).size, STAGES.length, "two stages share an id");
	for (const arm of MATRIX) assert.ok(stageOf(arm.phase), `${arm.id} sits in stage ${arm.phase}, which no StageDef declares`);
});

test("STAGES__KeepFilmingOutOfMeasurementStages__When__ArmsSetRecord", () => {
	// Diagnostics films as its own measurement and must not be filmed-twinned. That used to be
	// two exceptions written against phase 8 by name; both now fall out of `kind`.
	for (const arm of MATRIX) {
		if (arm.dispatch.record) assert.notEqual(stageOf(arm.phase)?.kind, "measurement", `${arm.id} films inside a measurement stage`);
	}
	const filmedTwins = MATRIX.filter((a) => stageOf(a.phase)?.kind === "deliverable");
	for (const t of filmedTwins) assert.equal(t.dispatch.record, true, `${t.id} is a deliverable and must film`);
});

/**
 * The three gates, asserted against the ARMS rather than against a stage flag.
 *
 * The 2026-08-03 audit found six of ten recipe arms unprotected — a Claude cell and five
 * filmed twins sat in stages nobody had marked `recipeGate: true`, so they could dispatch
 * with nothing promoted and bank runs labelled "recipe" that measured the appmap tier. The
 * flag was attached to the stage; the risk belongs to the arm. Same shape for the map gate,
 * which missed Generalization's ten grounded creation arms entirely.
 */
test("RecipeGate__CoversEveryArmThatGroundsOnARecipe__When__TheMatrixIsWalked", () => {
	const consumers = MATRIX.filter((a) => a.dispatch.useRecipes);
	assert.ok(consumers.length >= 10, "guard assumes the recipe tier is non-trivial");
	for (const a of consumers) {
		assert.ok(recipeArms(a.phase).length > 0, `${a.id} grounds on a recipe in an ungated stage ${a.phase}`);
	}
});

test("MapGate__CoversEveryStageHoldingAGroundedArm__When__ExceptDiagnostics", () => {
	const readsAMap = (a: (typeof MATRIX)[number]) => a.kind === "task" && !a.dispatch.noGrounding && !a.dispatch.useCurated && !a.dispatch.useRecipes;
	for (const st of STAGES) {
		const grounded = phaseArms(st.n).filter(readsAMap);
		if (!grounded.length) continue;
		if (st.kind === "diagnostic") {
			// Exempt on purpose: it measures the AX→screenshot transform, and whether grounding
			// prose loaded says nothing about that. Exempt BY KIND, so a second diagnostic stage
			// inherits the exemption without anyone remembering it.
			assert.equal(stageNeedsMaps(st.n), false, `${st.title} should not wait on Discovery`);
			continue;
		}
		assert.equal(stageNeedsMaps(st.n), true, `stage ${st.n} ${st.title} holds ${grounded.length} map-reading arms but does not wait for Discovery`);
	}
});

test("CreationExcluded__NamesLiveStageTwoCells__When__TheTaskAxisIsNarrowed", () => {
	// Moving the cdp perception cells into Configuration would have widened the task axis from
	// 15 twins to 20 as a side effect of a tidy-up. The exclusion is a judgement, so it is named
	// — and an id renamed out from under the list has to fail here rather than quietly rejoin.
	const s2 = new Set(phaseArms(2).filter((a) => a.kind === "task").map((a) => a.id));
	for (const id of CREATION_EXCLUDED) assert.ok(s2.has(id), `${id} is excluded from the task axis but is no longer a stage-2 cell`);
	// Stage 4 only: the filmed twins are `create-…-filmed` and would double the count.
	const twins = phaseArms(4).filter((a) => a.id.startsWith("create-"));
	assert.equal(twins.length, s2.size - CREATION_EXCLUDED.length, "every stage-2 cell that is not excluded has exactly one creation twin");
});

test("GroundedArms__ReadAMapSomeExploreWrites__When__EveryArmIsResolved", () => {
	// The guard the second app needed immediately: its two vision-only cells resolved to
	// `web-app.notion.com.cdp.vision`, a map no explore arm in the matrix produces, so they
	// would have dispatched and loaded nothing — provenance "none" under a grounded label, the
	// failure that cost six runs last pass and was only caught at collect.
	const written = new Set(MATRIX.filter((a) => a.kind === "explore").map(armAppmapSlug));
	for (const a of MATRIX) {
		if (a.kind !== "task" || a.dispatch.noGrounding || a.dispatch.useCurated || a.dispatch.useRecipes) continue;
		const wanted = a.env?.APPMAP_VARIANT ? undefined : armAppmapSlug(a);
		// Arms pinned to an explicit variant resolve through APPMAP_VARIANT, not the slug.
		if (!wanted) continue;
		assert.ok(written.has(wanted), `${a.id} grounds on ${wanted}, which no explore arm writes`);
	}
});

test("SecondAppArms__AreCdpOnlyAndUnfilmed__When__TheTargetIsAUrl", () => {
	const web = MATRIX.filter((a) => a.dispatch.url);
	assert.ok(web.length > 0, "guard assumes a web target exists");
	for (const a of web) {
		// run.ts throws "web targets run on the cdp backend" — an ax web arm is not a worse
		// measurement, it is a guaranteed crash.
		assert.equal(a.dispatch.backend, "cdp", `${a.id} targets a URL on the ${a.dispatch.backend} backend`);
		assert.notEqual(a.dispatch.record, true, `${a.id} films a second app; the deliverable is footage of the product`);
	}
	assert.equal(MATRIX.filter((x) => x.app !== BENCH_APP && x.id.endsWith("-filmed")).length, 0);
});

test("MATRIX__UsesOnlyAxAndCdp__When__DomIsDeleted", () => {
	assert.deepEqual([...BACKENDS], ["ax", "cdp"]);
	for (const arm of MATRIX) assert.notEqual(arm.dispatch.backend, "dom", `${arm.id} names the deleted dom backend`);
});

test("MATRIX__PassesGoalOnlyAudit__When__EveryTaskArmIsChecked", () => {
	for (const arm of MATRIX) {
		if (arm.kind !== "task") continue;
		assert.ok(arm.task, `${arm.id} is a task arm with no task`);
		const audit = auditTaskPrompt(arm.task!);
		assert.equal(audit.hinted, false, `${arm.id} task is hinted: ${audit.reasons.join("; ")}`);
	}
});

test("MATRIX__MeasuresVisionOnlyOnBothBackends__When__NoAxIsSet", () => {
	// This invariant INVERTED, deliberately. It used to assert vision-only was ax-only, on the
	// reasoning that "a cdp observation IS a ref list, so 'Vision only' cannot be expressed on
	// that backend". The suppression never lived in the backend — the agent loop hides the list
	// from the model (observationBlocks(obs, vision, !noAx)) while the harness keeps the full
	// observation for its gates — and cdp.act has taken a raw x/y point for some time.
	//
	// It matters because every vision-only arm went 0/3 and I read that as perception. The
	// failure classification says aiming: 87 `target-never-appeared` events, on the one backend
	// whose reported frames and screen pixels disagree. Measuring it on cdp, where scale:"css"
	// ties the two together, is what separates the two explanations.
	const vo = MATRIX.filter((a) => a.dispatch.noAx);
	assert.ok(vo.some((a) => a.dispatch.backend === "cdp"), "vision-only must be measured on cdp");
	assert.ok(vo.some((a) => a.dispatch.backend === "ax"), "and still on ax, or there is no comparison");
	// A vision-only arm must never also be handed the element channel by another flag.
	for (const a of vo) assert.notEqual(a.dispatch.axdomOff, true, `${a.id} combines --no-ax with AXDOM=0, which is redundant and confusing`);
});

test("MATRIX__LinksSourceArms__When__CompileOrReplay", () => {
	for (const arm of MATRIX) {
		if (arm.kind !== "compile" && arm.kind !== "replay") continue;
		assert.ok(arm.sourceArm && armById(arm.sourceArm), `${arm.id} sourceArm ${arm.sourceArm} not in matrix`);
	}
});

test("MATRIX__CarriesNoUnmetPrereqs__When__ArmsTargetASecondApp", () => {
	// A second app is BACK (2026-08-03, Notion web) — but as a URL, not an install. The Notion
	// Calendar app slice stays cut for the reason it was cut: it is installed on none of the
	// three Macs. The rule the cut established still binds the restore — an arm for a target the
	// fleet may not be ready for must carry its prereq, because the prereq is what makes that
	// decidable at plan time instead of a surprise at run time.
	assert.deepEqual(MATRIX.filter((a) => a.app === "Notion Calendar"), []);
	for (const arm of MATRIX.filter((a) => a.prereq)) assert.match(arm.prereq ?? "", /signed in|installed/i, `${arm.id} prereq must name what is missing`);
	// Every second-app EXPLORE carries one: the map is the artifact everything downstream reads,
	// and a signed-out pass maps the login wall — which is exactly what the 07-30 notion.so pass
	// did before anyone noticed.
	for (const arm of MATRIX.filter((a) => a.kind === "explore" && a.app !== BENCH_APP))
		assert.ok(arm.prereq, `${arm.id} explores a second app and must declare its sign-in prereq`);
});

test("MATRIX__ConfinesRecordingToTheFilmedPhase__When__ArmsAreDeclared", () => {
	// Recording is not a passive camera: it injects DEMO CONDUCT into the prompt, swaps in an
	// act tool without set_value, and changes actuation to hover-dwell-click. A measurement arm
	// that filmed itself would report demo-mode reliability as config reliability, so the split
	// is enforced rather than remembered.
	for (const arm of MATRIX) {
		// Phase 8 is the exception, and a narrow one: its filmed arm exists BECAUSE recording
		// changes the action space. It stages the window, which is the perturbation under
		// measurement — a diagnostic that could not film would be measuring nothing.
		if (arm.dispatch.record) assert.ok(stageOf(arm.phase)?.kind !== "measurement", `${arm.id} films, so it cannot sit in a measurement stage — filming changes the action space`);
		if (arm.phase === 5) assert.equal(arm.dispatch.record, true, `${arm.id} is a filmed take and must set record`);
	}
	// Every filmed take is n=1 — footage, not statistics.
	for (const arm of MATRIX.filter((a) => a.phase === 5)) assert.equal(arm.n, 1, `${arm.id} must be a single take`);
	// And each one mirrors a real measured config rather than inventing flags, so a config
	// cannot be measured under one set of flags and filmed under another.
	const measured = new Set(
		MATRIX.filter((a) => a.phase !== 5 && (a.kind === "task" || a.kind === "replay")).map((a) => JSON.stringify({ ...a.dispatch, record: true })),
	);
	for (const arm of MATRIX.filter((a) => a.phase === 5)) {
		assert.ok(measured.has(JSON.stringify(arm.dispatch)), `${arm.id} does not mirror any measured config`);
	}
	// Explores are not filmed: a 40-minute video of the agent operating every control it can
	// find is not a demo, and nothing downstream consumes it.
	assert.deepEqual(MATRIX.filter((a) => a.kind === "explore" && a.dispatch.record), []);
});

test("auditPhase__ReturnsNoProblems__When__RunOverEveryPhase", () => {
	for (const phase of [1, 2, 3, 4, 5] as const) assert.deepEqual(auditPhase(phase), []);
});

// --- manifest ---

const entry = (armId: string, jobId: string, over: Partial<ManifestEntry> = {}): ManifestEntry => ({
	armId,
	jobId,
	host: "mac1",
	submittedAt: "2026-07-31T10:00:00.000Z",
	state: "queued",
	// Entries are keyed by (armId, model) — runPhase stamps every dispatch with the pass's
	// declared model now, so a fixture without one belongs to a different pass and the top-up
	// arithmetic correctly ignores it.
	model: BENCH_PRIMARY_MODEL,
	collected: false,
	...over,
});

test("writeManifest__RoundTrips__When__ReadBack", () => {
	withTemp("bench-", (dir) => {
		const m: Manifest = { date: DATE, createdAt: "2026-07-31T09:00:00.000Z", entries: [entry("explore-ax", "explore-j1")] };
		writeManifest(m, liveDir(dir));
		assert.deepEqual(readManifest(DATE, liveDir(dir)), m);
		assert.ok(fs.existsSync(manifestPath(DATE, liveDir(dir))));
	});
});

test("readManifest__ReturnsEmpty__When__FileAbsent", () => {
	withTemp("bench-", (dir) => {
		const m = readManifest(DATE, liveDir(dir));
		assert.equal(m.date, DATE);
		assert.deepEqual(m.entries, []);
	});
});

test("recordSubmissions__DropsDuplicates__When__SameArmAndJobRecordedTwice", () => {
	const m: Manifest = { date: DATE, createdAt: "", entries: [entry("ax-grounded", "j1")] };
	const next = recordSubmissions(m, [entry("ax-grounded", "j1"), entry("ax-grounded", "j2")]);
	assert.equal(next.entries.length, 2);
	assert.equal(submittedCount(next, "ax-grounded", BENCH_PRIMARY_MODEL), 2);
});

test("updateEntry__ReplacesByKey__When__ArmAndJobMatch", () => {
	const m: Manifest = { date: DATE, createdAt: "", entries: [entry("ax-grounded", "j1"), entry("ax-grounded", "j2")] };
	const next = updateEntry(m, entry("ax-grounded", "j2", { collected: true, state: "done" }));
	assert.equal(next.entries[0].collected, false);
	assert.equal(next.entries[1].collected, true);
	assert.equal(next.entries[1].state, "done");
});

// --- orchestrate: the human gate ---

const accepted = (jobId: string, hostName = "mac1") => ({
	ok: true as const,
	host: host(hostName),
	jobId,
	kind: "task" as const,
	app: "Yarn",
	artifacts: { log: `out/jobs/${jobId}/log.txt` },
	attempts: [],
});

function fakeDispatch(): { calls: DispatchOptions[]; fn: (o: DispatchOptions) => Promise<any> } {
	const calls: DispatchOptions[] = [];
	let n = 0;

	return {
		calls,
		fn: async (o: DispatchOptions) => {
			calls.push(o);

			return accepted(`job-${++n}`);
		},
	};
}

test("runPhase__DispatchesNothingAndExits2__When__GoFlagAbsent", async () => {
	await withTempAsync("bench-", async (dir) => {
		const fake = fakeDispatch();
		const lines: string[] = [];
		const code = await runPhase(1, { date: DATE, outRoot: dir, dispatchFn: fake.fn, log: (l) => lines.push(l) });
		assert.equal(code, EXIT_NEEDS_GO);
		assert.deepEqual(fake.calls, []);
		assert.equal(readManifest(DATE, liveDir(dir)).entries.length, 0);
		assert.ok(lines.some((l) => /Nothing was dispatched/.test(l)));
	});
});

test("runPhase__SubmitsEveryArmSample__When__GoIsSet", async () => {
	await withTempAsync("bench-", async (dir) => {
		const fake = fakeDispatch();
		const code = await runPhase(1, { go: true, date: DATE, outRoot: dir, dispatchFn: fake.fn, log: () => {} });
		assert.equal(code, EXIT_OK);
		// Every discovery arm at EXPLORE_SAMPLES since 2026-08-03 — 8 Yarn cells and the second
		// app's 2, twice each. Derived rather than counted: the whole point of the policy is that
		// this number follows from the grid times one constant.
		assert.equal(fake.calls.length, phaseRunCount(1));
		// The two single-channel passes must differ ONLY in which channel they drop — same
		// backend, same app — or they are not a comparison.
		const single = fake.calls.filter((c) => c.noAx || c.noVision);
		// Five single-channel cells: vision-only on BOTH backends, ax-no-vision,
		// ax-noaxdom-no-vision and cdp-no-vision.
		//
		// Vision-only used to be pinned to ax here, on the reasoning that "cdp addresses actions
		// by ref, so dropping the element list drops the addressing with it". The cdp act tool
		// takes x/y — "pointer actions at viewport CSS-pixel coordinates read off the
		// screenshot" — so pixel addressing was available on that backend all along. Running it
		// on both is what separates vision-only's 0/3 into a perception result or an aiming one.
		// CALLS, not arms: six single-channel arms — vision-only on both backends, ax-no-vision,
		// ax-noaxdom-no-vision, cdp-no-vision, and the second app's no-vision — each at
		// EXPLORE_SAMPLES.
		assert.equal(single.length, 6 * EXPLORE_SAMPLES, "five single-channel cells on Yarn, plus the second app's no-vision discovery");
		assert.equal(single.filter((c) => c.noAx).length, 2 * EXPLORE_SAMPLES, "a screenshots-only pass per backend, both repeated for an error bar");
		// Backends PRESENT, not call counts — cdp repeats for an error bar and that is not a
		// second condition.
		assert.deepEqual(
			[...new Set(single.filter((c) => c.noAx).map((c) => c.backend))].sort(),
			["ax", "cdp"],
			"vision-only must be measured on the actuator that aims AND the one that does not",
		);
		assert.equal(single.filter((c) => c.noVision).length, 4 * EXPLORE_SAMPLES, "…plus the second app's no-vision pass");
		// The perception grid must span BOTH backends, or the screenshot question is only
		// answered on the fallback path and not on the one that ships.
		assert.ok(single.some((c) => c.backend === "cdp" && c.noVision), "cdp gets a no-vision cell too");
		// And the sidecar axis is present, which is the only test of whether axdom earns its
		// keep at grounding time rather than only at run time.
		// Two arms carry axdomOff (with and without Vision), each at EXPLORE_SAMPLES.
		assert.equal(fake.calls.filter((c) => c.axdomOff).length, 2 * EXPLORE_SAMPLES);
		// The vision-only pass is the one that drops the element list; it must still keep
		// vision, which the explore CLI enforces (--no-ax --no-vision leaves nothing).
		const visionPass = fake.calls.find((c) => c.noAx === true);
		assert.equal(visionPass?.kind, "explore");
		assert.equal(visionPass?.noVision, undefined);
		// Explore arms cross with kind explore, their backend, queue semantics, host auto.
		const ax = fake.calls.find((c) => c.backend === "ax");
		assert.equal(ax?.kind, "explore");
		assert.equal(ax?.host, "auto");
		assert.equal(ax?.queue, true);
		assert.equal(ax?.app, "Yarn");
		// Discovery stopped being Yarn-only on 2026-08-03: the second app brings its own passes,
		// because a map is per-target and Yarn's says nothing about Notion. What still holds is
		// the property the old assertion was really protecting — every URL-carrying pass names
		// the SAME target as the app it declares, so a web arm can never silently ground one
		// site's map onto another's runs.
		const web = fake.calls.filter((c) => c.url);
		assert.equal(web.length, 2 * EXPLORE_SAMPLES, "the second app's full-perception and no-vision passes, each at EXPLORE_SAMPLES");
		for (const c of web) assert.equal(c.app, c.url, `${c.url} dispatched under app ${c.app}`);
		assert.ok(
			fake.calls.every((c) => c.app === "Yarn" || c.url),
			"a Discovery arm targets Yarn or declares the URL it targets — never neither",
		);
		// Every accepted job landed in the manifest, uncollected.
		const m = readManifest(DATE, liveDir(dir));
		assert.equal(m.entries.length, phaseRunCount(1));
		assert.ok(m.entries.every((e) => !e.collected && e.host === "mac1"));
	});
});

test("runPhase__ShapesOptionsPerArm__When__Phase2Dispatches", async () => {
	await withTempAsync("bench-", async (dir) => {
		// Phase-1 gate satisfied: both Yarn explores collected.
		let m = readManifest(DATE, liveDir(dir));
		m = recordSubmissions(m, [
			entry("explore-ax", "explore-a", { collected: true, state: "done" }),
			entry("explore-cdp", "explore-c", { collected: true, state: "done" }),
			// The vision-only pass has to be collected too, and the gate is right to insist:
			// vision-only-grounded-visionmap reads the `.vision` map this pass writes, and
			// with no map loadGrounding degrades to provenance "none" — the arm would run as a
			// silent duplicate of the ungrounded one. Phase 2 refusing here IS the protection.
			entry("explore-vision", "explore-v", { collected: true, state: "done" }),
			entry("explore-no-vision", "explore-nv", { collected: true, state: "done" }),
			entry("explore-ax-noaxdom", "explore-na", { collected: true, state: "done" }),
			entry("explore-ax-noaxdom-no-vision", "explore-nanv", { collected: true, state: "done" }),
			entry("explore-cdp-no-vision", "explore-cnv", { collected: true, state: "done" }),
			entry("explore-vision-cdp", "explore-vcdp", { collected: true, state: "done" }),
		]);
		writeManifest(m, liveDir(dir));

		const fake = fakeDispatch();
		const code = await runPhase(2, { go: true, date: DATE, outRoot: dir, dispatchFn: fake.fn, log: () => {} });
		assert.equal(code, EXIT_OK);
		assert.equal(fake.calls.length, phaseRunCount(2));

		const byFlag = (pred: (c: DispatchOptions) => boolean): DispatchOptions[] => fake.calls.filter(pred);
		// Task text crosses verbatim and is goal-only for every call.
		for (const c of fake.calls) {
			assert.equal(c.kind, "task");
			assert.equal(auditTaskPrompt(c.task ?? "").hinted, false);
		}
		// Two ungrounded ax arms now — the full-perception floor and the minimum-context floor —
		// so the predicate has to name which, or it counts both and reads like one.
		assert.equal(byFlag((c) => c.noGrounding === true && c.backend === "ax" && !c.noAx && !c.axdomOff && !c.noVision).length, 3);
		assert.equal(byFlag((c) => c.noGrounding === true && c.backend === "ax" && c.axdomOff === true && c.noVision === true).length, 3);
		// TWELVE — the native-equivalent tier, complete since 2026-08-01. AXDOM=0 leaves an AX
		// tree with no DOM behind it, which is the surface a native AppKit app presents, so the
		// grid is {grounded, cold} x {screenshots, none} at n=3 each. It was nine while the
		// cold+screenshots cell was missing.
		assert.equal(byFlag((c) => c.axdomOff === true).length, 12);
		// And the matrix floor is dispatched with everything off at once, which no other arm is.
		assert.equal(byFlag((c) => c.axdomOff === true && c.noVision === true && c.noGrounding === true).length, 3);
		assert.equal(byFlag((c) => c.noVision === true && c.backend === "cdp").length, 3);
		assert.equal(byFlag((c) => c.useCurated === true && !c.noAx).length, 3);
		// Two vision-only arms remain (ungrounded floor + curated prose), 3 runs each. The
		// third — the machine-written-appmap arm — was cut, which is why no dispatch carries
		// appmapVariant: the variant it asked for resolves to a file that does not exist, and
		// a missing map degrades to no grounding at all rather than failing.
		// EIGHT vision-only arms x 3 since the stage reorganisation (2026-08-03), which brought
		// the four cdp vision-only cells home from phase 7. They were never a separate question:
		// same task, same model, a grounding tier the ax half of the grid already had — one of
		// them says exactly that in its own `informs` ("completes the grid ax already has").
		// 30 since the snap pair: both are vision-only (they refine ACTUATION, not perception),
		// so they carry --no-ax like every other vision-only cell.
		assert.equal(byFlag((c) => c.noAx === true).length, 30);
		// Split by actuator, so the perception condition is measured against both rather than
		// only the one whose click path misses by ~40px on this app.
		assert.equal(byFlag((c) => c.noAx === true && c.backend === "ax").length, 12);
		// 18 on cdp: the four original vision-only cdp cells plus the snap pair, which is
		// vision-only by construction — it refines the coordinate, never the perception.
		assert.equal(byFlag((c) => c.noAx === true && c.backend === "cdp").length, 18);
		// THREE arms read the vision-written map, x3 each: the vision-only ax consumer, its cdp
		// twin, and — the interesting one — a full-perception cdp agent handed the same pixel-written
		// map, which is what separates "bad map" from "reader that cannot act on a good one".
		assert.equal(byFlag((c) => c.appmapVariant === "vision").length, 9);
		// The Notion Calendar slice was cut, so phase 2 must dispatch nothing for it — the
		// assertion is kept (inverted) rather than deleted, so a careless restore that skips
		// the fleet-install prereq trips a test instead of burning 8 runs on exit 3.
		assert.equal(byFlag((c) => c.app === "Notion Calendar").length, 0);
		// No web arms remain — dropped 2026-08-01 with the web explore. The assertion is kept
		// INVERTED rather than deleted, so restoring one arm without its explore trips a test
		// instead of grounding on a map that is not there.
		assert.equal(byFlag((c) => String(c.app).startsWith("http")).length, 0);
		// Samples interleave across arms rather than running one arm's n back-to-back.
		assert.notEqual(fake.calls[0].noGrounding, fake.calls[1].noGrounding);
	});
});

test("runPhase__RefusesPhase2__When__NoCollectedPhase1Explores", async () => {
	await withTempAsync("bench-", async (dir) => {
		const fake = fakeDispatch();
		const lines: string[] = [];
		const code = await runPhase(2, { go: true, date: DATE, outRoot: dir, dispatchFn: fake.fn, log: (l) => lines.push(l) });
		assert.equal(code, EXIT_REFUSED);
		assert.deepEqual(fake.calls, []);
		assert.ok(lines.some((l) => /phase-1 maps/.test(l)));
	});
});

test("runPhase__BypassesPhase1Gate__When__ForceIsSet", async () => {
	await withTempAsync("bench-", async (dir) => {
		const fake = fakeDispatch();
		const code = await runPhase(2, { go: true, force: true, date: DATE, outRoot: dir, dispatchFn: fake.fn, log: () => {} });
		assert.equal(code, EXIT_OK);
		assert.equal(fake.calls.length, phaseRunCount(2));
	});
});

test("runPhase__SubmitsOnlyMissingSamples__When__ManifestAlreadyHoldsSome", async () => {
	await withTempAsync("bench-", async (dir) => {
		let m = readManifest(DATE, liveDir(dir));
		m = recordSubmissions(m, [
			entry("explore-ax", "explore-a"),
			entry("explore-cdp", "explore-c"),
			entry("explore-vision", "explore-v"),
			entry("explore-ax-noaxdom", "explore-na"),
			entry("explore-ax-noaxdom-no-vision", "explore-nanv"),
			entry("explore-cdp-no-vision", "explore-cnv"),
		]);
		writeManifest(m, liveDir(dir));

		const fake = fakeDispatch();
		const code = await runPhase(1, { go: true, date: DATE, outRoot: dir, dispatchFn: fake.fn, log: () => {} });
		assert.equal(code, EXIT_OK);
		// Every explore arm is EXPLORE_SAMPLES now, so seeding ONE sample of six arms leaves one
		// of each outstanding plus every sample of the un-seeded arms. Derived, not counted: a
		// literal here would be a second place to edit whenever the policy or the grid changes.
		assert.equal(fake.calls.length, phaseRunCount(1) - 6);
	});
});

test("runPhase__CompilesLocallyAndDispatchesReplays__When__Phase3HasCleanSources", async () => {
	await withTempAsync("bench-", async (dir) => {
		let m = readManifest(DATE, liveDir(dir));
		m = recordSubmissions(m, [
			entry("ax-grounded", "run-ax-1", { collected: true, state: "done", metrics: { success: true, finalCheckVerified: true } }),
			entry("cdp-grounded", "run-cdp-1", { collected: true, state: "done", metrics: { success: false } }),
		]);
		writeManifest(m, liveDir(dir));

		const fake = fakeDispatch();
		const compiled: string[] = [];
		const code = await runPhase(3, {
			go: true,
			date: DATE,
			outRoot: dir,
			dispatchFn: fake.fn,
			compileFn: (stamp) => {
				compiled.push(stamp);

				return { path: path.join(dir, "docs/procedures/yarn.abc.procedure.json") };
			},
			log: () => {},
		});
		assert.equal(code, EXIT_OK);
		// Only the ax source is clean; the cdp compile waits for a successful cdp run.
		assert.deepEqual(compiled, ["run-ax-1"]);

		// Only the ax replay arm dispatches: replay-norescue moved to cdp on 2026-08-01 (it
		// measures the unattended FLEET posture, a question about the shipping actuator), so it
		// waits on the cdp compile like every other cdp replay.
		// Reuse holds procedures AND recipes since 2026-08-03, so the stage dispatches both tiers
		// in one go and the replay claim has to name its own slice. The mixed readiness is the
		// wave loop's job: replays wait on compiles, recipe arms on promote.
		const replays = fake.calls.filter((c) => c.kind === "replay");
		assert.equal(replays.length, 3);
		for (const c of replays) assert.match(c.procedure ?? "", /procedure\.json$/);
		assert.equal(replays.filter((c) => c.noRescue === true).length, 0, "the no-rescue arm is cdp now and defers with the others");

		const after = readManifest(DATE, liveDir(dir));
		const compileEntry = after.entries.find((e) => e.armId === "compile-ax");
		assert.equal(compileEntry?.host, "local");
		assert.equal(compileEntry?.collected, true);
		assert.match(compileEntry?.procedure ?? "", /procedure\.json$/);
	});
});

test("runPhase__RecordsCompileRefusal__When__CompileFnThrows", async () => {
	await withTempAsync("bench-", async (dir) => {
		let m = readManifest(DATE, liveDir(dir));
		m = recordSubmissions(m, [entry("ax-grounded", "run-hinted", { collected: true, state: "done", metrics: { success: true } })]);
		writeManifest(m, liveDir(dir));

		const fake = fakeDispatch();
		await runPhase(3, {
			go: true,
			date: DATE,
			outRoot: dir,
			dispatchFn: fake.fn,
			compileFn: () => {
				throw new Error("run was --hinted");
			},
			log: () => {},
		});
		const after = readManifest(DATE, liveDir(dir));
		const refusal = after.entries.find((e) => e.armId === "compile-ax");
		assert.equal(refusal?.state, "failed");
		assert.match(refusal?.note ?? "", /--hinted/);
		// No procedure means every ax replay deferred rather than dispatching without one. Scoped to
		// replays: Reuse also dispatches the recipe tier, which does not wait on a compile.
		assert.equal(fake.calls.filter((c) => c.kind === "replay").length, 0);
	});
});

test("plannedRuns__ExcludesCompileArms__When__Phase3Planned", () => {
	const m: Manifest = { date: DATE, createdAt: "", entries: [] };
	assert.ok(plannedRuns(3, m).every((p) => p.arm.kind !== "compile"));
});

test("dispatchOptionsFor__CarriesProcedureAndQueue__When__ReplayArm", () => {
	const arm = armById("replay-norescue")!;
	const o = dispatchOptionsFor(arm, "docs/procedures/yarn.abc.procedure.json");
	assert.equal(o.kind, "replay");
	assert.equal(o.queue, true);
	assert.equal(o.noRescue, true);
	assert.equal(o.procedure, "docs/procedures/yarn.abc.procedure.json");
});

test("findCompileSource__SkipsTriedStamps__When__PreviousCompileRefused", () => {
	const m: Manifest = {
		date: DATE,
		createdAt: "",
		entries: [
			entry("ax-grounded", "run-1", { collected: true, metrics: { success: true } }),
			entry("ax-grounded", "run-2", { collected: true, metrics: { success: true } }),
		],
	};
	assert.equal(findCompileSource(m, "ax-grounded", new Set(["run-1"]), BENCH_PRIMARY_MODEL)?.jobId, "run-2");
});

// --- collect: metrics off fixture artifacts ---

/** The shape out/runs/<stamp>.json has today (copied from a real 2026-07-31 run log). */
const RUN_LOG = {
	task: "show me how to change the cursor type",
	app: "Yarn",
	backend: "ax",
	vision: true,
	ax: true,
	grounding: { provenance: "explore", path: "docs/appmaps/yarn.md", sha256: "ab493c45e2ac", graph: { nodes: 150, edges: 71, scopeAmbiguities: [] } },
	homeReset: "reset",
	hintedPrompt: false,
	expectationRejections: 1,
	elapsedSec: 52,
	usage: { inputTokens: 10, outputTokens: 1389, cacheReadTokens: 240733, modelCalls: 6 },
	verifiedSteps: 4,
	unverifiedSteps: 0,
	verifiedByChannel: { text: 4, geometry: 0, pixel: 0 },
	success: true,
	finalCheck: { verified: true, note: "expectation met", channel: "text" },
	visualCheck: { verdict: "PASS", scope: "brand" },
	steps: [
		{ index: 1, observationNodes: 221, listShownToModel: 503 },
		{ index: 2, observationNodes: 180, listShownToModel: 410 },
		{ index: 3, observationNodes: 200, listShownToModel: 450 },
		// The instrumentation landed mid-matrix on some logs; a step without it must not
		// poison the mean.
		{ index: 4 },
	],
};

test("parseRunMetrics__ExtractsRunFields__When__GivenLiveRunLog", () => {
	const m = parseRunMetrics(RUN_LOG);
	assert.equal(m.success, true);
	assert.equal(m.steps, 4);
	assert.equal(m.verifiedSteps, 4);
	assert.equal(m.unverifiedSteps, 0);
	assert.deepEqual(m.verifiedByChannel, { text: 4, geometry: 0, pixel: 0 });
	assert.equal(m.expectationRejections, 1);
	assert.equal(m.elapsedSec, 52);
	assert.equal(m.modelCalls, 6);
	assert.equal(m.outputTokens, 1389);
	assert.equal(m.cacheReadTokens, 240733);
	assert.equal(m.provenance, "explore");
	assert.equal(m.backend, "ax");
	assert.equal(m.vision, true);
	assert.equal(m.ax, true);
	assert.equal(m.finalCheckVerified, true);
	assert.equal(m.visualVerdict, "PASS");
	assert.equal(m.homeReset, "reset");
	// Means over only the steps that carry the fields (three of four here).
	assert.equal(m.meanObservationNodes, 200.3);
	assert.equal(m.meanListShownToModel, 454.3);
});

test("parseRunMetrics__OmitsAttentionMeans__When__NoStepCarriesTheCounts", () => {
	const m = parseRunMetrics({ ...RUN_LOG, steps: [{ index: 1 }, { index: 2 }] });
	assert.equal(m.meanObservationNodes, undefined);
	assert.equal(m.meanListShownToModel, undefined);
});

test("parseRunMetrics__CountsRescuedSteps__When__GivenReplayRunLog", () => {
	// The shape procedure-cli.ts writes for a replay: modelCalls top-level, replayOf set,
	// rescues marked in modelReasoning (see replay.ts).
	const m = parseRunMetrics({
		task: "t",
		app: "Yarn",
		backend: "ax",
		replayOf: "2026-07-31T02-18-03-799-www.wikipedia.org",
		procedureSteps: 3,
		modelCalls: 2,
		success: true,
		steps: [
			{ modelReasoning: "replayed from procedure x" },
			{ modelReasoning: "rescued after: target not found" },
			{ modelReasoning: "replayed from procedure x" },
		],
	});
	assert.equal(m.procedureSteps, 3);
	assert.equal(m.rescuedSteps, 1);
	assert.equal(m.modelCalls, 2);
});

test("journalScopes__ReturnsScopesInStepOrder__When__JournalHasMutations", () => {
	withTemp("bench-", (dir) => {
		const file = path.join(dir, "run.journal.jsonl");
		// Real journal shape (src/core/journal.ts Mutation): scope absent = the honest "unset".
		fs.writeFileSync(
			file,
			[
				JSON.stringify({ kind: "setting", control: "Cursor Style", surface: "Screen Clip Settings", scope: "document", before: "Arrow-first", after: "Pointer-first", step: 3 }),
				JSON.stringify({ kind: "setting", control: "Search", surface: "", before: "", after: "x", step: 4 }),
				JSON.stringify({ kind: "resource", control: "New Draft", surface: "Library", step: 5, resource: "scratch" }),
			].join("\n"),
		);
		assert.deepEqual(journalScopes(file), ["document", "unset"]);
	});
});

test("journalScopes__ReturnsEmpty__When__JournalAbsent", () => {
	assert.deepEqual(journalScopes("/nonexistent/run.journal.jsonl"), []);
});

test("parseAppmapStamp__ExtractsCoverage__When__GivenRealStampLine", () => {
	// Verbatim shape of the committed Yarn map's stamp.
	const md =
		"<!-- provenance: explore | app: Yarn | date: 2026-07-30 | backend: ax | actions: 96 | elapsed: 40m | findings: 36 | finds: 0 | controls: 47 actuated / 350 dismissed / 396 seen | surfaces: 34 | chapters: 9 | stopped: frontier-empty -->\n# Yarn";
	const m = parseAppmapStamp(md);
	assert.equal(m.exploreActions, 96);
	assert.equal(m.exploreElapsed, "40m");
	assert.equal(m.controlsActuated, 47);
	assert.equal(m.controlsDismissed, 350);
	assert.equal(m.controlsSeen, 396);
	assert.equal(m.surfaces, 34);
});

test("parseGraphCounts__CountsNodesEdgesAmbiguities__When__GraphHasDualScopeSetting", () => {
	const m = parseGraphCounts({
		nodes: [
			{ id: "a/x", title: "X", kind: "control", scope: "brand", settingKey: "x" },
			{ id: "b/x", title: "X (project)", kind: "control", scope: "document", settingKey: "x" },
			{ id: "a", title: "A", kind: "surface", scope: "brand" },
		],
		edges: [{ from: "a", to: "b", action: "click" }],
	});
	assert.equal(m.graphNodes, 3);
	assert.equal(m.graphEdges, 1);
	assert.equal(m.scopeAmbiguities, 1);
});

test("jobTiming__SplitsQueueWaitFromRunTime__When__JobRecordHasAllTimestamps", () => {
	const m = jobTiming({
		queuedAt: "2026-07-31T10:00:00.000Z",
		startedAt: "2026-07-31T10:02:00.000Z",
		endedAt: "2026-07-31T10:03:30.000Z",
	} as JobRecord);
	assert.equal(m.queueWaitSec, 120);
	assert.equal(m.runSec, 90);
});

const doneJob = (id: string, artifacts: Record<string, string>): JobRecord =>
	({
		id,
		kind: "task",
		app: "Yarn",
		task: "t",
		operator: "op",
		state: "done",
		pid: 0,
		startedAt: "2026-07-31T10:02:00.000Z",
		queuedAt: "2026-07-31T10:00:00.000Z",
		endedAt: "2026-07-31T10:03:00.000Z",
		artifacts: { log: `out/jobs/${id}/log.txt`, ...artifacts },
	}) as JobRecord;

test("collect__MarksEntryWithMetrics__When__TaskRunArtifactsArePresent", async () => {
	await withTempAsync("bench-", async (dir) => {
		const outRoot = path.join(dir, "out");
		fs.mkdirSync(path.join(dir, "out/runs"), { recursive: true });
		fs.writeFileSync(path.join(dir, "out/runs/job-1.json"), JSON.stringify(RUN_LOG));
		fs.writeFileSync(
			path.join(dir, "out/runs/job-1.journal.jsonl"),
			`${JSON.stringify({ kind: "setting", control: "Cursor Style", surface: "Screen Clip Settings", scope: "brand", before: "Arrow-first", after: "Pointer-first", step: 3 })}\n`,
		);
		let m = readManifest(DATE, liveDir(outRoot));
		m = recordSubmissions(m, [entry("ax-grounded", "job-1")]);
		writeManifest(m, liveDir(outRoot));

		const outcome = await collect({
			date: DATE,
			outRoot,
			dataDir: dir,
			pull: async () => ({ ok: true, job: doneJob("job-1", { runLog: "out/runs/job-1.json" }) }),
			reportDir: path.join(dir, "report"),
			log: () => {},
		});
		assert.deepEqual(outcome.collected, ["job-1"]);
		const e = outcome.manifest.entries[0];
		assert.equal(e.collected, true);
		assert.equal(e.state, "done");
		assert.equal(e.metrics?.success, true);
		assert.equal(e.metrics?.queueWaitSec, 120);
		assert.deepEqual(e.metrics?.mutationScopes, ["brand"]);
		assert.ok(fs.existsSync(outcome.reportPath!));
	});
});

test("collect__PullsNothingAgain__When__RunASecondTime", async () => {
	await withTempAsync("bench-", async (dir) => {
		const outRoot = path.join(dir, "out");
		fs.mkdirSync(path.join(dir, "out/runs"), { recursive: true });
		fs.writeFileSync(path.join(dir, "out/runs/job-1.json"), JSON.stringify(RUN_LOG));
		let m = readManifest(DATE, liveDir(outRoot));
		m = recordSubmissions(m, [entry("ax-grounded", "job-1")]);
		writeManifest(m, liveDir(outRoot));

		let pulls = 0;
		const opts = {
			date: DATE,
			outRoot,
			dataDir: dir,
			pull: async () => {
				pulls++;

				return { ok: true, job: doneJob("job-1", { runLog: "out/runs/job-1.json" }) };
			},
			reportDir: path.join(dir, "report"),
			log: () => {},
		};
		const first = await collect(opts);
		const second = await collect(opts);
		assert.equal(pulls, 1);
		assert.deepEqual(second.collected, []);
		// Idempotent by content, not just by count: the entry is byte-identical either way.
		assert.deepEqual(second.manifest.entries, first.manifest.entries);
	});
});

test("collect__LeavesEntryPending__When__JobStillRunning", async () => {
	await withTempAsync("bench-", async (dir) => {
		const outRoot = path.join(dir, "out");
		let m = readManifest(DATE, liveDir(outRoot));
		m = recordSubmissions(m, [entry("ax-grounded", "job-1")]);
		writeManifest(m, liveDir(outRoot));

		const outcome = await collect({
			date: DATE,
			outRoot,
			dataDir: dir,
			pull: async () => ({ ok: true, job: { ...doneJob("job-1", {}), state: "running" } as JobRecord }),
			reportDir: path.join(dir, "report"),
			log: () => {},
		});
		assert.deepEqual(outcome.pending, ["job-1"]);
		assert.equal(outcome.manifest.entries[0].collected, false);
		assert.equal(outcome.manifest.entries[0].state, "running");
	});
});

test("collect__CountsRunAsFailure__When__TerminalJobHasNoRunLog", async () => {
	await withTempAsync("bench-", async (dir) => {
		const outRoot = path.join(dir, "out");
		let m = readManifest(DATE, liveDir(outRoot));
		m = recordSubmissions(m, [entry("ax-grounded", "job-1")]);
		writeManifest(m, liveDir(outRoot));

		const outcome = await collect({
			date: DATE,
			outRoot,
			dataDir: dir,
			pull: async () => ({ ok: true, job: { ...doneJob("job-1", {}), state: "failed" } as JobRecord }),
			reportDir: path.join(dir, "report"),
			log: () => {},
		});
		const e = outcome.manifest.entries[0];
		assert.equal(e.collected, true);
		assert.equal(e.metrics?.success, false);
		assert.match(e.note ?? "", /no run log/);
	});
});

test("collect__EvictsFailedRunFromLiveKeepingItsManifestRow__When__EntryIsTerminalFailure", async () => {
	await withTempAsync("bench-", async (dir) => {
		const outRoot = path.join(dir, "out");
		// Both runs sit in the CONSOLIDATED store — the tree eviction operates on.
		fs.mkdirSync(runDir("job-ok", outRoot), { recursive: true });
		fs.writeFileSync(path.join(runDir("job-ok", outRoot), RUN_FILES.log), JSON.stringify(RUN_LOG));
		fs.mkdirSync(runDir("job-bad", outRoot), { recursive: true });
		fs.writeFileSync(path.join(runDir("job-bad", outRoot), RUN_FILES.log), JSON.stringify({ ...RUN_LOG, success: false }));
		let m = readManifest(DATE, liveDir(outRoot));
		m = recordSubmissions(m, [entry("ax-grounded", "job-ok"), entry("ax-grounded", "job-bad")]);
		writeManifest(m, liveDir(outRoot));

		const outcome = await collect({
			date: DATE,
			outRoot,
			dataDir: dir,
			pull: async (_host, jobId) => ({ ok: true, job: doneJob(jobId, {}) }),
			reportDir: path.join(dir, "report"),
			log: () => {},
		});

		// The failure left live; its artifacts survive in the backup; its manifest row stays —
		// evidence of failure remains on the board, only the directory moved.
		assert.equal(fs.existsSync(runDir("job-bad", outRoot)), false);
		assert.ok(fs.existsSync(path.join(archiveRunDir("job-bad", outRoot), RUN_FILES.log)));
		const bad = outcome.manifest.entries.find((e) => e.jobId === "job-bad");
		assert.equal(bad?.collected, true);
		assert.equal(bad?.metrics?.success, false);
		// The success is untouched: live is exactly the in-flight-plus-successes set.
		assert.ok(fs.existsSync(path.join(runDir("job-ok", outRoot), RUN_FILES.log)));
	});
});

test("collect__RefusesEvictionAndNotesWhy__When__TheBackupCannotBeTaken", async () => {
	await withTempAsync("bench-", async (dir) => {
		const outRoot = path.join(dir, "out");
		fs.mkdirSync(runDir("job-bad", outRoot), { recursive: true });
		fs.writeFileSync(path.join(runDir("job-bad", outRoot), RUN_FILES.log), JSON.stringify({ ...RUN_LOG, success: false }));
		let m = readManifest(DATE, liveDir(outRoot));
		m = recordSubmissions(m, [entry("ax-grounded", "job-bad")]);
		writeManifest(m, liveDir(outRoot));
		// A FILE where the archive root belongs: every mkdir under it fails, so the backup cannot
		// be taken and eviction must refuse rather than delete the only copy.
		fs.writeFileSync(path.join(outRoot, ARCHIVE_DIR), "not a directory");

		const outcome = await collect({
			date: DATE,
			outRoot,
			dataDir: dir,
			pull: async () => ({ ok: true, job: doneJob("job-bad", {}) }),
			reportDir: path.join(dir, "report"),
			log: () => {},
		});

		const e = outcome.manifest.entries[0];
		assert.equal(e.collected, true);
		assert.ok(fs.existsSync(path.join(runDir("job-bad", outRoot), RUN_FILES.log)), "the only copy must survive a failed backup");
		assert.match(e.note ?? "", /eviction refused/);
	});
});

test("collect__ParsesAppmapArtifacts__When__ExploreEntryIsTerminal", async () => {
	await withTempAsync("bench-", async (dir) => {
		const outRoot = path.join(dir, "out");
		fs.mkdirSync(path.join(dir, "docs/appmaps"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "docs/appmaps/yarn.md"),
			"<!-- provenance: explore | app: Yarn | date: 2026-07-31 | backend: ax | actions: 96 | elapsed: 40m | controls: 47 actuated / 350 dismissed / 396 seen | surfaces: 34 | stopped: frontier-empty -->\n# Yarn",
		);
		fs.writeFileSync(
			path.join(dir, "docs/appmaps/yarn.json"),
			JSON.stringify({ nodes: [{ id: "a", title: "A", kind: "surface", scope: "brand" }], edges: [] }),
		);
		let m = readManifest(DATE, liveDir(outRoot));
		m = recordSubmissions(m, [entry("explore-ax", "explore-1")]);
		writeManifest(m, liveDir(outRoot));

		const job = { ...doneJob("explore-1", {}), kind: "explore", artifacts: { log: "out/jobs/explore-1/log.txt", appmap: "docs/appmaps/yarn.md", appmapGraph: "docs/appmaps/yarn.json" } } as JobRecord;
		const outcome = await collect({
			date: DATE,
			outRoot,
			dataDir: dir,
			pull: async () => ({ ok: true, job }),
			reportDir: path.join(dir, "report"),
			log: () => {},
		});
		const e = outcome.manifest.entries[0];
		assert.equal(e.metrics?.exploreActions, 96);
		assert.equal(e.metrics?.controlsActuated, 47);
		assert.equal(e.metrics?.graphNodes, 1);
	});
});

// --- report ---

test("renderReport__ListsStampsAndSections__When__ManifestHasEntries", () => {
	const m: Manifest = {
		date: DATE,
		createdAt: "",
		entries: [
			entry("ax-grounded", "job-1", { collected: true, state: "done", metrics: { success: true, steps: 4, elapsedSec: 52, modelCalls: 6, mutationScopes: ["brand"], queueWaitSec: 12, runSec: 60 } }),
			entry("ax-ungrounded", "job-2"),
		],
	};
	const md = renderReport(m);
	assert.match(md, /## Stage 1 — Discovery/);
	assert.match(md, /## Stage 2 — Configuration: backend × grounding \(core\)/);
	// Notion was killed as an approach (David, 2026-08-01), so the SECTION it rendered — empty
	// ever since the slice was cut — goes with it. An empty table reads as "we measured this and
	// found nothing", which is the opposite of what happened.
	//
	// Narrowly a check on HEADINGS, not on the word: the report should still say in prose that
	// every Notion arm was cut and cross-app transfer is therefore unmeasured. Dropping that
	// sentence with the table would turn an admitted gap into an unmentioned one.
	const headings = md.split("\n").filter((l) => l.startsWith("## "));
	assert.deepEqual(headings.filter((h) => /notion/i.test(h)), [], "no section may exist for arms that do not");
	assert.match(md, /Notion arm was cut|Notion cut entirely/, "the cut should stay visible as a stated limit");
	assert.match(md, /## Stage 3 — Reuse: procedures/);
	assert.match(md, /## Timing/);
	assert.match(md, /## For Aman/);
		// The stamp line now names the MODEL too, because the pass declares one — that is the
	// transparency whose absence let a whole phase display the wrong model on 2026-08-01.
	assert.match(md, /`job-1` \(mac1, azure\/gpt-5\.6-sol\)/);
	assert.match(md, /`job-2` \(mac1, azure\/gpt-5\.6-sol, uncollected\)/);
	// The collected arm's row carries its numbers; the arm with no collected runs shows —.
	assert.match(md, /\| ax-grounded \|[^\n]*\| 1\/3 \| 1\/1 \| — \| 4 \| 52 \| 6 \|/);
	assert.match(md, /TODO: which backend/);
});

test("writeReport__WritesRegenerableFile__When__CalledTwice", () => {
	withTemp("bench-", (dir) => {
		// Needs a ROW: an empty manifest deliberately writes nothing now (see
		// writeReport__WritesNothing__When__TheManifestIsEmpty). This test is about the output
		// being regenerable, which an empty pass cannot demonstrate either way.
		const m: Manifest = { date: DATE, createdAt: "", entries: [entry("ax-grounded", "job-1", { collected: true, state: "done" })] };
		const file = writeReport(m, { dir });
		assert.equal(path.basename(file), reportFileName(DATE));
		const first = fs.readFileSync(file, "utf8");
		writeReport(m, { dir });
		assert.equal(fs.readFileSync(file, "utf8"), first);
	});
});

test("runPhase__ScopesSampleCountsToTheModelPass__When__TwoModelsRunTheMatrix", async () => {
	// Self-grounded passes: pass B's top-up arithmetic must not read pass A's entries as
	// its own samples, or the second model silently runs a fraction of the matrix.
	await withTempAsync("bench-", async (dir) => {
		const a = fakeDispatch();
		await runPhase(1, { go: true, date: DATE, outRoot: dir, dispatchFn: a.fn, log: () => {}, model: "openai/gpt-5.6-sol:nitro" });
		assert.equal(a.calls.length, phaseRunCount(1), "pass A submits the full phase");
		for (const c of a.calls) assert.equal(c.model, "openai/gpt-5.6-sol:nitro");

		const b = fakeDispatch();
		await runPhase(1, { go: true, date: DATE, outRoot: dir, dispatchFn: b.fn, log: () => {}, model: "claude-fable-5" });
		assert.equal(b.calls.length, phaseRunCount(1), "pass B submits the full phase again — pass A's entries are not its samples");
		for (const c of b.calls) assert.equal(c.model, "claude-fable-5");

		// And a re-run of pass A tops up nothing.
		const a2 = fakeDispatch();
		await runPhase(1, { go: true, date: DATE, outRoot: dir, dispatchFn: a2.fn, log: () => {}, model: "openai/gpt-5.6-sol:nitro" });
		assert.equal(a2.calls.length, 0);
	});
});

test("runPhase__GatesPhase2OnThisPassesExplores__When__AnotherModelAlreadyExplored", async () => {
	// Pass A's collected explores prove nothing about pass B: B grounds itself, and its
	// phase 2 must wait for B's own maps.
	await withTempAsync("bench-", async (dir) => {
		const a = fakeDispatch();
		await runPhase(1, { go: true, date: DATE, outRoot: dir, dispatchFn: a.fn, log: () => {}, model: "openai/gpt-5.6-sol:nitro" });
		let m = readManifest(DATE, liveDir(dir));
		for (const e of m.entries) m = updateEntry(m, { ...e, collected: true });
		writeManifest(m, liveDir(dir));

		const b = fakeDispatch();
		const code = await runPhase(2, { go: true, date: DATE, outRoot: dir, dispatchFn: b.fn, log: () => {}, model: "claude-fable-5" });
		assert.equal(code, EXIT_REFUSED, "pass B's phase 2 refuses on pass A's maps");
		assert.equal(b.calls.length, 0);
	});
});

test("archiveDirFor__KeysOnModelArmAndJob__When__PassesOrSamplesShareOneManifest", () => {
	const base = { armId: "explore-ax", jobId: "j", host: "mac1", submittedAt: "", state: "done", collected: true };
	const sol = archiveDirFor("/bench/2026-07-31", { ...base, model: "openai/gpt-5.6-sol:nitro" });
	const fable = archiveDirFor("/bench/2026-07-31", { ...base, model: "claude-fable-5" });
	assert.notEqual(sol, fable, "each model pass archives its own maps");
	assert.match(sol, /appmaps\/openai-gpt-5.6-sol-nitro\/explore-ax\/j$/);
	assert.match(archiveDirFor("/b", base), /appmaps\/default\/explore-ax\/j$/);

	// And per JOB, because an explore arm now runs n=2: both samples write the same live
	// filename on their own Macs, so an arm-keyed archive would keep only the one collected
	// last — discarding the second sample and the entire reason for repeating.
	const a = archiveDirFor("/b", { ...base, jobId: "explore-A" });
	const b = archiveDirFor("/b", { ...base, jobId: "explore-B" });
	assert.notEqual(a, b, "two samples of one arm must not share an archive directory");
});

test("failureKind__ClassifiesEachShape__When__RunsFailDifferently", () => {
	const job = (over: Record<string, unknown>) => ({ id: "j", kind: "task", app: "Yarn", task: "t", operator: "d", state: "failed", pid: 0, startedAt: "", artifacts: { log: "" }, ...over }) as any;
	// Success: no kind at all.
	assert.equal(failureKind(job({}), { success: true }, true), undefined);
	// Exit 3 is the readiness gate — a host problem (signed out), not a model problem.
	assert.equal(failureKind(job({ exitCode: 3 }), { success: false }, false), "unready");
	// Exit 2 is the prompt audit.
	assert.equal(failureKind(job({ exitCode: 2 }), { success: false }, false), "hinted-refused");
	// An operator stop is its own bucket — neither the model's nor the host's fault.
	assert.equal(failureKind(job({ state: "stopped" }), { success: false }, false), "stopped");
	// A run log with success:false is the agent's own verdict.
	assert.equal(failureKind(job({ exitCode: 1 }), { success: false, steps: 7 }, true), "gave-up");
	// Terminal with no run log: orphan/signal/died-before-first-write.
	assert.equal(failureKind(job({ exitCode: null, signal: "SIGKILL" }), { success: false }, false), "crashed");
	assert.equal(failureKind(undefined, { success: false }, false), "crashed");
});

test("poisonedHosts__FlagsTheHost__When__LastThreeRunsFailIdentically", () => {
	const entry = (host: string, jobId: string, kind?: string, success = false) => ({
		armId: "ax-grounded", jobId, host, submittedAt: "", state: "done", collected: true,
		metrics: { success, ...(kind ? { failureKind: kind } : {}) },
	}) as any;
	const m = (entries: any[]) => ({ date: "2026-07-31", createdAt: "", entries }) as any;

	// Three identical failures: flagged, with the remedy named.
	const warned = poisonedHosts(m([entry("mac2", "a", "unready"), entry("mac2", "b", "unready"), entry("mac2", "c", "unready")]));
	assert.equal(warned.length, 1);
	assert.match(warned[0], /POISONED HOST/);
	assert.match(warned[0], /mac2/);
	assert.match(warned[0], /signin/);

	// A success inside the window breaks the streak.
	assert.deepEqual(poisonedHosts(m([entry("mac2", "a", "unready"), entry("mac2", "b", undefined, true), entry("mac2", "c", "unready")])), []);
	// Three DIFFERENT failures are three unlucky runs, not one broken host.
	assert.deepEqual(poisonedHosts(m([entry("mac2", "a", "unready"), entry("mac2", "b", "crashed"), entry("mac2", "c", "gave-up")])), []);
	// Two failures are not enough evidence.
	assert.deepEqual(poisonedHosts(m([entry("mac2", "a", "unready"), entry("mac2", "b", "unready")])), []);
	// Local compiles never poison anything.
	assert.deepEqual(poisonedHosts(m([entry("local", "a", "crashed"), entry("local", "b", "crashed"), entry("local", "c", "crashed")])), []);
});

test("perceptionLine__SaysWhatTheModelSees__When__FlagsLookContradictory", () => {
	// `--backend ax --no-ax` reads as a contradiction and is not one: --backend names the
	// ACTUATOR (cua driver vs CDP), --no-ax/--no-vision name PERCEPTION. David read the
	// vision arm as "vision + AX" on 2026-07-31 — the opposite of what it measures — because
	// the plan printed only the flags and left the reader to decode them.
	const arm = (dispatch: any): any => ({ id: "x", phase: 2, kind: "task", app: "Yarn", n: 1, dispatch });
	assert.equal(perceptionLine(arm({ backend: "ax", noAx: true })), "Vision only");
	// The element channel is named PER BACKEND, because they are different things: ax gives
	// the AX elements plus the DOM attributes the axdom sidecar joins on, cdp gives the
	// DOM itself and no AX at all. Calling both "elements" hid a real distinction.
	assert.equal(perceptionLine(arm({ backend: "ax", noVision: true })), "AX + DOM attrs");
	assert.equal(perceptionLine(arm({ backend: "ax" })), "AX + DOM attrs + Vision");
	assert.equal(perceptionLine(arm({ backend: "cdp" })), "DOM + Vision");
	// AXDOM=0 removes the second half of the ax element channel, and the label must show it —
	// that arm exists to measure whether the sidecar is worth shipping.
	assert.equal(perceptionLine(arm({ backend: "ax", axdomOff: true })), "AX (no DOM attrs) + Vision");
	// With NO element channel the actuator cannot change the answer — that conflation was the
	// original bug, and it is the one case where ax and cdp must read identically.
	assert.equal(perceptionLine(arm({ backend: "cdp", noAx: true })), perceptionLine(arm({ backend: "ax", noAx: true })));
});

test("perceptionLine__ReportsTheEmptyCase__When__BothChannelsAreOff", () => {
	// The explore CLI refuses this combination (a window title and nothing else), but a label
	// that quietly cannot happen teaches nothing to whoever declares the arm that tries it.
	const both: any = { id: "x", phase: 2, kind: "task", app: "Yarn", n: 1, dispatch: { backend: "ax", noAx: true, noVision: true } };
	assert.equal(perceptionLine(both), "nothing");
});

test("dateArg__PinsAPassToOneManifest__When__ItWillCrossMidnight", () => {
	// Manifests are keyed by UTC date and a phase runs for hours. On the 07-31→08-01 rollover
	// a fresh manifest read three collected explores as unsubmitted and re-dispatched all
	// three; they had to be stopped by hand within seconds. Phase 2 is 40 runs and will
	// certainly cross midnight.
	assert.equal(dateArg(["phase", "2", "--date", "2026-07-31", "--go"]), "2026-07-31");
	assert.equal(dateArg(["phase", "2", "--go"]), undefined);
	// A malformed value must not silently become a manifest key — that would write the pass
	// to a file nobody looks in, which is worse than ignoring the flag.
	for (const bad of ["yesterday", "2026-7-31", "--go", ""]) {
		assert.equal(dateArg(["phase", "2", "--date", bad]), undefined, bad);
	}
	assert.equal(dateArg(["phase", "2", "--date"]), undefined, "a trailing --date has no value");
});

test("armAppmapSlug__GivesEveryExploreArmItsOwnFile__When__TheMatrixIsWalked", () => {
	// Two arms sharing a filename means the later pass silently overwrites the earlier, and
	// the survivor is decided by explore ordering. That happened twice on 2026-08-01: first
	// every Yarn explore wrote yarn.json (ax 156 nodes, cdp 196, no-vision 180 — last writer
	// won), then the first fix added the BACKEND but not the perception tier, so
	// explore-ax and explore-no-vision still collided. Neither was visible in any test
	// because the arms individually looked fine; only the pair was wrong.
	const explores = MATRIX.filter((a) => a.kind === "explore");
	const byslug = new Map<string, string[]>();
	for (const a of explores) byslug.set(armAppmapSlug(a), [...(byslug.get(armAppmapSlug(a)) ?? []), a.id]);
	const clashes = [...byslug].filter(([, ids]) => ids.length > 1);
	assert.deepEqual(clashes, [], `arms sharing an appmap file: ${clashes.map(([s, ids]) => `${s} <- ${ids.join(" + ")}`).join("; ")}`);

	// And every dimension that varies must actually appear in the name, or a future arm
	// varying only in that dimension collides silently.
	const yarnAx = explores.find((a) => a.id === "explore-ax");
	assert.ok(yarnAx);
	assert.equal(armAppmapSlug(yarnAx), "yarn.ax", "backend in the name");
	assert.equal(armAppmapSlug(explores.find((a) => a.id === "explore-no-vision")!), "yarn.ax.novision", "perception tier in the name");
	assert.equal(armAppmapSlug(explores.find((a) => a.id === "explore-vision")!), "yarn.ax.vision", "vision-only tier in the name");
	// The web arms are gone, but the derivation must still handle a URL target — restoring
	// them must not require rediscovering that a host and a backend both belong in the name.
	assert.equal(appmapSlug("https://app.notion.com", { backend: "cdp" }), "web-app.notion.com.cdp");
});

test("armAppmapSlug__IsWhatTaskArmsWillRead__When__TheyGroundOnAPass", () => {
	// The grounded TASK arms have to read the map their matching explore wrote, or phase 2
	// measures the wrong vocabulary — the ax and cdp passes name the same surface `editor`
	// and `draft-editor`, so a run grounded on the other backend's map fails to resolve
	// controls for reasons that read as backend weakness.
	const exploreFor = (backend: string) => MATRIX.find((a) => a.kind === "explore" && a.dispatch.backend === backend && !a.dispatch.noAx && !a.dispatch.noVision && a.app === "Yarn");
	for (const backend of ["ax", "cdp"]) {
		const task = MATRIX.find((a) => a.id === `${backend}-grounded`);
		const explore = exploreFor(backend);
		assert.ok(task && explore, backend);
		assert.equal(armAppmapSlug(task), armAppmapSlug(explore), `${backend}-grounded must read what explore-${backend} wrote`);
	}
});

test("armTitle__NamesTheArmWithoutRepeatingPerception__When__ShownBesideIt", () => {
	// Title and perception appear in adjacent columns, so the title stays silent about
	// channels — "grounded task | Vision only" reads once, not twice.
	const arm = (kind: string, dispatch: any, env?: any): any => ({ id: "x", phase: 2, kind, app: "Yarn", n: 1, dispatch, ...(env ? { env } : {}) });
	assert.equal(armTitle(arm("explore", { backend: "ax" })), "grounding pass");
	assert.equal(armTitle(arm("explore", { backend: "cdp", url: "https://app.notion.com" })), "grounding pass (web)");
	assert.equal(armTitle(arm("task", { backend: "ax" })), "grounded task");
	assert.equal(armTitle(arm("task", { backend: "ax", noGrounding: true })), "ungrounded task");
	assert.equal(armTitle(arm("task", { backend: "ax", useCurated: true })), "human-notes task");
	assert.equal(armTitle(arm("task", { backend: "ax", noAx: true }, { APPMAP_VARIANT: "vision" })), "vision-map grounded task");
	assert.equal(armTitle(arm("task", { backend: "ax", record: true })), "filmed grounded task");
	assert.equal(armTitle(arm("replay", { backend: "ax", noRescue: true })), "procedure replay (no rescue)");
	// Derived from the DISPATCH, never from the rendered flags string — the dash used to parse
	// flagsLine output, which fails silently the moment the wording changes.
	for (const a of MATRIX) assert.ok(armTitle(a).length > 0 && !armTitle(a).includes("undefined"), a.id);
});

test("MATRIX__ConsumesEveryMapItProduces__When__ExploresAndTaskArmsArePaired", () => {
	// A grounding pass costs ~30 minutes and ~$14. One whose map no arm reads is that spent
	// for a comparison alone — which is what explore-no-vision was until APPMAP_VARIANT
	// learned "novision". The reverse is worse: an arm reading a map nothing writes finds
	// nothing, and loadGrounding degrades a miss to provenance "none" — ungrounded under a
	// grounded label, the failure mode this matrix has hit three separate ways.
	const reads = (a: Arm): string => {
		const v = a.env?.APPMAP_VARIANT;
		const tier = v === "vision" ? ".vision" : v === "novision" ? ".novision" : "";
		// The runner sets AXDOM=0 for an axdomOff arm and the reader appends .noaxdom from it,
		// so the sidecar is part of the lookup exactly as the backend and tier are. Modelling
		// only two of the three axes is how this check passed while a map went unread.
		const sidecar = a.dispatch.axdomOff ? ".noaxdom" : "";

		return `${appmapSlug(a.app)}.${a.dispatch.backend}${sidecar}${tier}`;
	};
	const written = new Set(MATRIX.filter((a) => a.kind === "explore").map(armAppmapSlug));
	const consumers = MATRIX.filter((a) => a.kind === "task" && !a.dispatch.noGrounding && !a.dispatch.useCurated);

	// THE CORRECTNESS DIRECTION: every grounded arm's map is written by some explore arm.
	// A miss here is not a wasted run — loadGrounding degrades an absent map to provenance
	// "none", so the arm runs UNGROUNDED while the report calls it grounded.
	for (const a of consumers) assert.ok(written.has(reads(a)), `${a.id} grounds on ${reads(a)}, which no explore arm writes`);

	// THE COST DIRECTION: a map nothing reads is ~30 minutes and ~$14 spent on a comparison
	// alone. Legitimate — a grounding pass measures map size, surfaces and cost by itself —
	// but it must be a DECLARED choice, not an oversight, so the arm carries comparisonOnly.
	const read = new Set(consumers.map(reads));
	for (const e of MATRIX.filter((a) => a.kind === "explore")) {
		if (read.has(armAppmapSlug(e)) || e.comparisonOnly) continue;
		assert.fail(`${e.id} writes ${armAppmapSlug(e)}, which nothing reads — wire a consumer or mark it comparisonOnly`);
	}
});

test("groundingChecked__FlagsARunThatDidNotGetItsDeclaredGrounding__When__ProvenanceDisagrees", () => {
	// provenance has been recorded since the collector was built and read by NOTHING; the
	// matrix delegated the check to a human remembering to look. It is the cheapest detector
	// for a whole class: a map that never synced to the host, a variant that never crossed the
	// wire, a slug naming a sibling's file. Each produces a plausible number under a confident
	// label, and loadGrounding turns a missing map into provenance "none" without complaint.
	const grounded = MATRIX.find((a) => a.id === "ax-grounded")!;
	const ungrounded = MATRIX.find((a) => a.id === "ax-ungrounded")!;
	const curated = MATRIX.find((a) => a.id === "curated")!;
	const visionmap = MATRIX.find((a) => a.id === "vision-only-grounded-visionmap")!;

	assert.equal(expectedProvenance(grounded), "explore");
	assert.equal(expectedProvenance(ungrounded), "none");
	assert.equal(expectedProvenance(curated), "curated");
	// The arm that explicitly selects the vision tier must expect the vision stamp, or the
	// check would fire on every correct run of it.
	assert.equal(expectedProvenance(visionmap), "explore-vision");

	// And every arm in the matrix resolves to something — an unhandled combination would make
	// the detector itself the source of false positives.
	for (const a of MATRIX.filter((x) => x.kind === "task")) assert.ok(expectedProvenance(a), a.id);
});

test("MATRIX__PairsEveryPerceptionFloorWithAnUngroundedArm__When__AConditionIsMeasured", () => {
	// An ungrounded arm is the floor its grounded siblings are read against. Without one, a
	// grounded arm's number has nothing to be better THAN — "grounding helps" is a comparison
	// or it is nothing. The minimum-context pair was added 2026-08-01 because the most
	// impoverished condition had a grounded arm and no floor.
	const perceptionOf = (a: Arm) => `${a.dispatch.backend}|${Boolean(a.dispatch.noAx)}|${Boolean(a.dispatch.noVision)}|${Boolean(a.dispatch.axdomOff)}`;
	const task = MATRIX.filter((a) => a.kind === "task" && a.phase === 2);
	const ungroundedConfigs = new Set(task.filter((a) => a.dispatch.noGrounding).map(perceptionOf));

	// Every ungrounded arm is a floor for at least one grounded arm — an orphan floor measures
	// a condition nothing is compared against.
	const groundedConfigs = new Set(task.filter((a) => !a.dispatch.noGrounding).map(perceptionOf));
	for (const c of ungroundedConfigs) assert.ok(groundedConfigs.has(c), `ungrounded config ${c} has no grounded sibling to be the floor for`);

	// And the floor of the whole matrix exists: least perception AND no map.
	const min = task.find((a) => a.dispatch.noGrounding && a.dispatch.axdomOff && a.dispatch.noVision);
	assert.ok(min, "no minimum-context ungrounded arm — nothing establishes the matrix floor");
	assert.equal(perceptionLine(min), "AX (no DOM attrs)");
});

test("MATRIX__FilmsEveryMeasuredConfig__When__PhaseFiveIsDerived", () => {
	// "Recordings of everything" is a coverage claim, so it should be a test rather than a
	// habit. Phase 5 derives from the phase-2 arms, so the guarantee holds automatically —
	// but only while nothing is added to phase 2 outside the derived set, which is exactly
	// the mistake a future edit would make.
	// Every arm that PERFORMS something gets a filmed twin — phases 2, 3, 4, 6 and 7, not just 2.
	// Phase 8 is excluded: it is a diagnostics PAIR (one plain arm, one filmed) where the filmed
	// half IS the measurement — staging the window is the perturbation under test. Deriving a
	// twin would film the same config twice and compare a run against itself.
	// Scoped to BENCH_APP since 2026-08-03: the deliverable is footage of the PRODUCT, so the
	// second-app arms are measured and deliberately unfilmed.
	const measured = MATRIX.filter((a) => a.app === BENCH_APP && stageOf(a.phase)?.kind === "measurement" && (a.kind === "task" || a.kind === "replay"));
	const filmed = MATRIX.filter((a) => a.phase === 5);
	const shape = (a: Arm) => JSON.stringify({ ...a.dispatch, record: undefined, env: a.env ?? null });

	assert.equal(filmed.length, measured.length, "every measured config needs a filmed twin");
	const filmedShapes = new Set(filmed.map(shape));
	for (const m of measured) assert.ok(filmedShapes.has(shape(m)), `${m.id} is measured but never filmed`);
	// Including the floor and the minimum-context pair — the reorder question (does demo
	// conduct break this config?) applies hardest where the config is already marginal.
	for (const id of ["min-context-ungrounded", "vision-only-ungrounded"]) {
		const m = MATRIX.find((a) => a.id === id);
		assert.ok(m && filmedShapes.has(shape(m)), `${id} has no filmed twin`);
	}
});


test("dispatchOptionsFor__ForwardsEveryDeclaredFlag__When__AnyArmDeclaresIt", () => {
	// THE structural guard, and it is the third time this class of bug has shipped here.
	//
	// dispatchOptionsFor spells out every field by hand, so a flag added to ArmDispatch and set
	// on an arm reaches the child only if someone also remembered this function. Twice it was
	// not remembered: APPMAP_VARIANT=novision never crossed the wire (two grounding passes had
	// no consumer, and `bench plan` printed a claim that was false), and today `record` and
	// `useRecipes` were both missing — which would have made all 16 phase-5 runs unfilmed
	// duplicates of their phase-2 siblings and all 6 phase-6 runs measure the appmap tier.
	//
	// Checking the MATRIX declares the flags — which the tests already did — catches none of
	// this. Only walking every arm's actual dispatch object does.
	const missed: string[] = [];
	for (const arm of MATRIX) {
		const opts = dispatchOptionsFor(arm) as unknown as Record<string, unknown>;
		for (const [key, value] of Object.entries(arm.dispatch)) {
			if (value === undefined || value === false) continue;
			if (opts[key] === undefined) missed.push(`${arm.id}: dispatch.${key}=${JSON.stringify(value)} never reaches DispatchOptions`);
			else if (opts[key] !== value) missed.push(`${arm.id}: dispatch.${key}=${JSON.stringify(value)} arrives as ${JSON.stringify(opts[key])}`);
		}
	}
	assert.deepEqual(missed, [], `flags declared on an arm but not forwarded:\n  ${missed.join("\n  ")}`);
});

test("submittedCount__SkipsTechnicalFailures__When__ARunDiedProducingNothing", () => {
	// David's rule (2026-08-01): a run that failed for a TECHNICAL reason is thrown out and
	// retried, because it is a data point about the harness rather than about the agent.
	//
	// The mechanism is deliberately not a retry loop. submittedCount is the top-up arithmetic
	// `bench phase --go` uses, so excluding these makes the next run of the phase refill them —
	// one code path for "submit what is missing", whatever the reason it is missing.
	const e = (jobId: string, over: Partial<ManifestEntry> = {}): ManifestEntry => ({
		armId: "explore-cdp",
		jobId,
		host: "mac1",
		submittedAt: "2026-08-01T06:00:00.000Z",
		state: "done",
		collected: true,
		...over,
	});
	const m: Manifest = {
		date: "2026-08-01",
		createdAt: "2026-08-01T06:00:00.000Z",
		entries: [e("a"), e("b", { state: "failed", technical: { kind: "crashed", detail: "died on acquisition" } }), e("c")],
	};
	assert.equal(submittedCount(m, "explore-cdp"), 2, "the crashed run must not consume a sample");
	// The entry STAYS — "two runs died acquiring the app" is worth knowing, and deleting the
	// evidence would make a broken Mac look like a slow one.
	assert.equal(entriesForArm(m, "explore-cdp").length, 3);
});

test("technicalFailure__SeparatesHarnessFromAgent__When__ARunFails", () => {
	const explore = armById("explore-cdp");
	// Died before producing anything → not a result.
	assert.equal(technicalFailure("orphaned", {}, explore, [])?.kind, "orphaned");
	assert.equal(technicalFailure("failed", { failureKind: "crashed" }, explore, [])?.kind, "crashed");
	assert.equal(technicalFailure("failed", {}, explore, ["no appmap at docs/appmaps/yarn.cdp.md"])?.kind, "crashed");

	// Refused at the home-state gate before measuring anything — a host problem (usually
	// signed out), not a sample. 29% of archived runs died this way, each one silently
	// consuming a sample slot until 2026-08-01.
	assert.equal(technicalFailure("failed", { failureKind: "unready" }, explore, [])?.kind, "unready");

	// Ran to a verdict, or a human intervened → these ARE the measurement, and auto-retrying
	// them would either discard real failures or fight the operator who stopped the run.
	assert.equal(technicalFailure("failed", { failureKind: "gave-up" }, explore, []), undefined);
	assert.equal(technicalFailure("stopped", { failureKind: "stopped" }, explore, []), undefined);
	assert.equal(technicalFailure("failed", { failureKind: "hinted-refused" }, explore, []), undefined);
	assert.equal(technicalFailure("done", { success: true }, explore, []), undefined);
});

test("MATRIX__JustifiesEveryAxArm__When__CdpIsTheDefault", () => {
	// CDP is the production actuator — it backgrounds, never steals the operator's pointer, and
	// carries none of cua's liabilities. FOR_AMAN's second bullet already says so, and the `dom`
	// backend was deleted as dominated. So AX is the FALLBACK, and an arm that uses it owes a
	// reason.
	//
	// Without this the matrix drifted to 73% ax (77 runs against 28) — not by anyone deciding
	// that, but because `task()` callers kept typing `backend: "ax"` out of habit and nothing
	// asked why. A default is not a decision.
	//
	// Three reasons are legitimate, and they are checked structurally rather than by trusting a
	// comment:
	//   1. the arm IS the ax-vs-cdp comparison — a cdp twin of the same shape exists
	//   2. the variable cannot exist on cdp — axdomOff, since the sidecar enriches the AX elements
	//      and cdp already has the real DOM (this is also the native-equivalent tier)
	//   3. an explicit written axRationale
	const shape = (a: Arm) => JSON.stringify({ ...a.dispatch, backend: null }) + `|${a.phase}|${a.kind}|${a.task ?? ""}`;
	const cdpShapes = new Set(MATRIX.filter((a) => a.dispatch.backend === "cdp").map(shape));
	const unjustified = MATRIX.filter(
		(a) => a.dispatch.backend === "ax" && !a.dispatch.axdomOff && !cdpShapes.has(shape(a)) && !a.axRationale,
	).map((a) => a.id);
	assert.deepEqual(unjustified, [], `ax arms with no stated reason — pair them with a cdp twin or add axRationale:\n  ${unjustified.join("\n  ")}`);
});

test("MATRIX__CoversTheNativeEquivalentGrid__When__AxdomIsOff", () => {
	// "Yarn with only the tools a native app would give you" (David, 2026-08-01): AXDOM=0 removes
	// the DOM attributes that exist only because the target is Chromium, leaving an accessibility
	// tree with nothing behind it, actuated through the accessibility API. Holding the APP
	// constant is what makes it a measurement instead of an anecdote.
	//
	// All four cells must exist or the tier cannot be read: dropping the map and dropping the
	// screenshots are separate losses, and a native app can be onboarded or not independently of
	// whether the agent can see.
	const native = MATRIX.filter((a) => a.phase === 2 && a.dispatch.axdomOff);
	const cell = (grounded: boolean, vision: boolean) =>
		native.find((a) => Boolean(a.dispatch.noGrounding) === !grounded && Boolean(a.dispatch.noVision) === !vision);
	for (const [g, v, label] of [
		[true, true, "grounded + screenshots"],
		[true, false, "grounded, no screenshots"],
		[false, true, "cold + screenshots"],
		[false, false, "cold, no screenshots — the floor"],
	] as Array<[boolean, boolean, string]>)
		assert.ok(cell(g, v), `the native-equivalent grid is missing: ${label}`);

	// Every one of them must be ax: a cdp run has the real DOM, so it cannot be native-equivalent
	// however many other channels are switched off.
	for (const a of native) assert.equal(a.dispatch.backend, "ax", `${a.id} claims the native tier but actuates over cdp`);
	// And each must be grounded on a map built under the SAME limit, or the arm measures the
	// sidecar's absence at run time only while reading a map the sidecar helped write.
	for (const a of native.filter((x) => !x.dispatch.noGrounding))
		assert.ok(
			MATRIX.some((e) => e.kind === "explore" && e.dispatch.axdomOff && Boolean(e.dispatch.noVision) === Boolean(a.dispatch.noVision)),
			`${a.id} has no sidecar-less explore pass to ground on`,
		);
});

test("runPhase__StampsTheDeclaredModel__When__NoOverrideIsGiven", async () => {
	// The model is a MEASUREMENT VARIABLE — the headline comparison is Claude against OpenAI —
	// so it must be a property of the pass, never of whichever machine dequeued the job.
	//
	// It was inferred. makeClient resolves (default) from whatever API keys a host carries, so
	// on 2026-08-01 the fleet Macs ran azure/gpt-5.6-sol from their own AGENT_MODEL while the
	// operator's laptop — Anthropic key, no Azure key — resolved the same "(default)" to
	// claude-fable-5 and the dashboard displayed that for the whole pass. Nothing was wrong with
	// the runs and everything was wrong with what a human could see.
	await withTempAsync("bench-model-", async (dir) => {
		const fake = fakeDispatch();
		await runPhase(1, { go: true, date: DATE, outRoot: dir, dispatchFn: fake.fn, log: () => {} });
		assert.ok(fake.calls.length > 0);
		for (const c of fake.calls) assert.equal(c.model, BENCH_PRIMARY_MODEL, "every dispatch must carry the pass's declared model");

		// And it reaches the manifest, so a re-collect months later can still say what ran.
		const m = readManifest(DATE, liveDir(dir));
		for (const e of m.entries) assert.equal(e.model, BENCH_PRIMARY_MODEL);
	});
});

test("phaseProgress__WaitsForOwedSamples__When__NothingIsInFlight", () => {
	// Two conditions, and BOTH matter. "Nothing running" is not "finished": a technical failure
	// frees its sample slot (submittedCount skips it), so a phase can have an idle fleet and
	// still owe runs — which is exactly the state a retry is supposed to fill.
	const arms = phaseArms(1);
	const full: Manifest = {
		date: DATE,
		createdAt: "",
		entries: arms.flatMap((a) =>
			Array.from({ length: a.n }, (_, i) => entry(a.id, `${a.id}-${i}`, { state: "done", collected: true })),
		),
	};
	assert.deepEqual(phaseProgress(1, full), { outstanding: 0, inFlight: 0, done: true });

	// One still running → not done, nothing owed.
	const running = { ...full, entries: full.entries.map((e, i) => (i === 0 ? { ...e, state: "running" } : e)) };
	assert.equal(phaseProgress(1, running).done, false);
	assert.equal(phaseProgress(1, running).inFlight, 1);
	assert.equal(phaseProgress(1, running).outstanding, 0);

	// One crashed → terminal, so nothing is in flight, but the sample is owed again.
	const crashed = {
		...full,
		entries: full.entries.map((e, i) => (i === 0 ? { ...e, state: "failed", technical: { kind: "crashed", detail: "died on acquisition" } } : e)),
	};
	assert.deepEqual(phaseProgress(1, crashed), { outstanding: 1, inFlight: 0, done: false });
});

test("watchPhase__DispatchesTheNextPhaseOnce__When__ThenIsGiven", async () => {
	// The loop nobody had: results already came home on their own (collect pulls, and the dash
	// collects on a timer), but nothing NOTICED a phase finishing. An operator polled for two
	// hours, and the session doing it is how five batches of explores died to a caller's timeout.
	const arms = phaseArms(1);
	const complete: Manifest = {
		date: DATE,
		createdAt: "",
		entries: arms.flatMap((a) => Array.from({ length: a.n }, (_, i) => entry(a.id, `${a.id}-${i}`, { state: "done", collected: true }))),
	};
	await withTempAsync("bench-watch-", async (dir) => {
		// liveDir(path.join(dir, "out")), not liveDir(dir): watchPhase resolves through outDir(),
		// which is <dataRoot>/out. Getting this wrong made the manifest read empty, the phase
		// never complete, and — with sleepFn stubbed and no maxPolls — the loop spin forever.
		process.env.YARN_RUNNER_DATA = dir;
		writeManifest(complete, liveDir(path.join(dir, "out")));
		const prev = process.env.YARN_RUNNER_DATA;
		try {
			const fired: number[] = [];
			const lines: string[] = [];
			const p = await watchPhase({
				// The live default polls the fleet and can CANCEL queued jobs; watchPhase refuses to run
				// without an injected one under test, for the same reason collectFn does.
				rebalanceFn: async () => [],
				phase: 1,
				then: 2,
				date: DATE,
				log: (l) => lines.push(l),
				collectFn: async () => undefined,
				// A backstop even on the happy path: a test that stubs sleep and reaches a
				// not-done state would otherwise spin at full CPU until something kills it.
				maxPolls: 5,
				runPhaseFn: async (n) => {
					fired.push(n);

					return 0;
				},
				sleepFn: async () => undefined,
			});
			assert.equal(p.done, true);
			// Exactly one dispatch, of exactly the named phase. Chaining further would spend the
			// rest of the matrix on a judgement nobody made.
			assert.deepEqual(fired, [2]);
			assert.ok(lines.some((l) => /phase 1 complete/.test(l)));
		} finally {
			if (prev === undefined) delete process.env.YARN_RUNNER_DATA;
			else process.env.YARN_RUNNER_DATA = prev;
		}
	});
});

test("watchPhase__NeverTouchesRuns__When__ItGivesUp", async () => {
	// A watcher's death must not imply the run's — the lesson from 2026-08-01, where a foreground
	// follow hitting its caller's 600s cap turned into healthy 40-minute explores being stopped.
	// The backstop exits; it does not stop, kill or signal anything.
	const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "bench", "watch.ts"), "utf8");
	for (const forbidden of ["stopRemote", "runnerctl", "SIGTERM", "SIGINT", "kill("])
		assert.equal(src.includes(forbidden), false, `watch.ts must never ${forbidden} — a dead watcher must not kill a run`);
});

test("technicalFailure__CatchesADemotedExplore__When__NothingWasPublished", () => {
	// The miscount from 2026-08-01, as a test. explore-no-vision and explore-ax-noaxdom
	// both published NO map — one left the previous day's file in place, the other wrote none —
	// yet both were classified non-technical and counted as delivered samples, so re-running the
	// phase would not have replaced them.
	//
	// The cause was an interaction between two changes made hours apart the same day.
	// writeArtifacts was made to ALWAYS write the run-local appmap.md, including for a DEMOTED
	// pass (correct: the run folder should record what the pass produced), and collect prefers
	// that copy — which made the "no appmap at" note this classifier keyed on impossible to emit.
	//
	// The product of an explore arm is a PUBLISHED map, because that is what the next phase
	// reads. So publication is the test.
	const explore = armById("explore-ax-noaxdom");
	assert.ok(explore, "fixture arm must exist");
	assert.equal(technicalFailure("failed", {}, explore, ["map not published to docs/appmaps/yarn.ax.noaxdom.md — pass was demoted or superseded"])?.kind, "crashed");
	// Still catches the older shape, where nothing was written at all.
	assert.equal(technicalFailure("failed", {}, explore, ["no appmap at docs/appmaps/yarn.ax.noaxdom.md"])?.kind, "crashed");
	// A published pass is a result, whatever else the notes say.
	assert.equal(technicalFailure("done", {}, explore, ["appmap archive failed: disk full"]), undefined);
});

test("collectEntry__FlagsAnUnpublishedMap__When__TheRunOnlyWroteItsOwnCopy", () => {
	// End to end through the real collect, because the miscount lived in the SEAM between
	// writeArtifacts and the classifier — a unit test that feeds the note directly (which the
	// original did) passes while production silently does the wrong thing.
	withTemp("collect-pub-", (dir) => {
		const arm = armById("explore-ax-noaxdom")!;
		const slug = armAppmapSlug(arm);
		const jobId = "explore-demoted";
		const dataOut = path.join(dir, "out");
		const stamp = "<!-- provenance: explore | app: Yarn | actions: 24 -->\n";

		// The run folder holds a map (a demoted pass writes one); docs/appmaps holds an OLDER,
		// different file for the same slug — exactly what explore-no-vision left behind.
		fs.mkdirSync(runDir(jobId, dataOut), { recursive: true });
		fs.writeFileSync(runPath(jobId, RUN_FILES.appmap, dataOut), `${stamp}demoted pass\n`);
		fs.mkdirSync(path.join(dir, "docs", "appmaps"), { recursive: true });
		fs.writeFileSync(path.join(dir, "docs", "appmaps", `${slug}.md`), `${stamp}yesterday's pass\n`);

		const out = collectEntry(entry(arm.id, jobId, { state: "failed" }), undefined, dir, "failed");
		assert.ok(out.technical, "a pass whose map never reached docs/appmaps produced no grounding");
		assert.equal(out.technical?.kind, "crashed");
		assert.match(out.note ?? "", /map not published/);
	});
});

test("renderReport__ShowsEveryRun__When__AnArmHasRepeatedSamples", () => {
	// The phase-1 table used to `.find()` the first collected entry, so an n=2 arm rendered ONE
	// sample and its repeat was invisible. That defeats the only reason those arms repeat: on
	// 2026-08-01 the two cdp passes stamped 44 and 12 surfaces, and the report showed one of
	// them as "the" result — which is how a metric with a 6x spread got quoted as a finding.
	const m: Manifest = {
		date: DATE,
		createdAt: "",
		entries: [
			entry("explore-cdp", "job-a", { collected: true, state: "done", metrics: { controlsActuated: 136, graphNodes: 207, surfaces: 44 } }),
			entry("explore-cdp", "job-b", { collected: true, state: "done", metrics: { controlsActuated: 119, graphNodes: 144, surfaces: 12 } }),
		],
	};
	// Scoped to the Phase 1 SECTION — later sections (Timing) list the same arm ids — and matched
	// on the exact cell, because `explore-cdp` is a prefix of `explore-cdp-no-vision`.
	const md = renderReport(m);
	const phase1 = md.slice(md.indexOf("## Stage 1")).split("\n## ")[0];
	const rows = phase1.split("\n").filter((l) => /^\| explore-cdp \|/.test(l));
	assert.equal(rows.length, 2, "both samples must render");
	assert.ok(
		rows.some((r) => r.includes("| 136 |")) && rows.some((r) => r.includes("| 119 |")),
		"each row carries its own run's numbers, not a shared or first-wins value",
	);
});

test("renderReport__RanksColumnsByTrust__When__RenderingPhase1", () => {
	const md = renderReport({ date: DATE, createdAt: "", entries: [] });
	const header = md.split("\n").find((l) => l.includes("| actuated |"));
	assert.ok(header, "phase 1 must have an actuated column");
	// Measured before ledger-derived. `surfaces` and `seen` count the surface LABELS a model
	// attached to controls it noticed, and disagree with the graph the same pass wrote (76
	// stamped over a 66-surface-node graph; 12 over 22). They stay in the table — they are
	// cheap and occasionally suggestive — but they must not sit where the eye lands first.
	assert.ok(header!.indexOf("| actuated |") < header!.indexOf("surfaces"), "actuated precedes surfaces");
	assert.ok(header!.indexOf("| nodes |") < header!.indexOf("surfaces"), "nodes precedes surfaces");
	assert.match(md, /do not quote these two/, "the caveat must travel with the numbers");
});

test("renderReport__MarksRescuedPasses__When__ARunSurvivedABlackout", () => {
	// A restarted pass carries a discontinuity a clean one does not, and the old retry policy
	// hid this class of run by re-running it until it stopped happening.
	const m: Manifest = {
		date: DATE,
		createdAt: "",
		entries: [entry("explore-ax", "job-x", { collected: true, state: "done", metrics: { controlsActuated: 85, blackouts: 1, relaunches: 1 } })],
	};
	assert.match(renderReport(m), /explore-ax ⟲1/);
});

test("dispatchOptionsFor__PinsTheArmsOwnModel__When__ThePassRunsAnother", () => {
	// Model was a pass-level choice only, so all 115 runs of the first matrix were one model and
	// "some runs with Claude" had nowhere to live short of re-dispatching a 45-run phase. An
	// arm pin lets a few Claude cells sit beside their Sol twins in one pass — which is also the
	// only way the report's per-model rows become a comparison instead of two separate tables.
	const claude = MATRIX.find((a) => a.id === "claude-cdp-grounded");
	assert.ok(claude, "the Claude comparison arm must exist");
	assert.equal(dispatchOptionsFor(claude!, undefined, "azure/gpt-5.6-sol").model, BENCH_ALT_MODEL);
	// An unpinned arm still follows the pass.
	const sol = MATRIX.find((a) => a.id === "create-cdp-grounded");
	assert.equal(dispatchOptionsFor(sol!, undefined, "azure/gpt-5.6-sol").model, "azure/gpt-5.6-sol");
});

test("armModel__AgreesWithDispatch__When__CountingSamples", () => {
	// Counting has to resolve the model the same way dispatch does. A pinned arm records its
	// entries under the PINNED model; if submittedCount looks for the pass model it finds none,
	// concludes the arm owes runs, and re-dispatches it forever.
	for (const a of MATRIX) assert.equal(armModel(a, "pass-model"), dispatchOptionsFor(a, undefined, "pass-model").model);
});

test("matrixTasks__StateGoalsOnly__When__DeclaredInAnyPhase", () => {
	// The measurement rule, enforced over the matrix itself rather than trusted. The creation
	// task is the one most at risk: its only previous outing dictated a route and passed the
	// gate, which is the hole NAV_HINT/SEQUENCE_HINT closed.
	for (const a of MATRIX) {
		if (!a.task) continue;
		const audit = auditTaskPrompt(a.task);
		assert.equal(audit.hinted, false, `${a.id} declares a hinted task: ${audit.reasons.join("; ")}`);
	}
});

test("visionOnlyArms__NeverOfferElementSearch__When__RunningOnEitherBackend", () => {
	// A vision-only run must not be handed `find`: searching a snapshot the model cannot see
	// returns element identity through the side door, and the arm stops being vision-only while
	// still being labelled it. Asserted over source because the tool list is assembled at run
	// time from the backend and noAx together.
	const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "core", "agent", "run.ts"), "utf8");
	assert.match(src, /noAx \? \[\] : \[cdpMod!\.CDP_FIND_TOOL\]/, "find must be withheld from a vision-only run");
});

test("visionOnlyArms__RunOnCdpToo__When__TheOffsetIsTheSuspect", () => {
	// Vision-only was ax-only by an explicit refusal whose reason ("cdp observations ARE ref
	// lists") stopped being true once cdp.act took raw x/y. The arms exist so the 0/3 result can
	// be attributed: perception, or aiming.
	const vo = MATRIX.filter((a) => a.dispatch.noAx);
	assert.ok(vo.some((a) => a.dispatch.backend === "cdp"), "vision-only must be measured on cdp");
	assert.ok(vo.some((a) => a.dispatch.backend === "ax"), "and still on ax, or the comparison is gone");
});

test("runPhase__RecordsTheArmsOwnModel__When__AnArmIsPinnedToAnother", async () => {
	// The manifest entry must name the model the run was DISPATCHED with. Recording the pass
	// model on a pinned arm is not a cosmetic mismatch: submittedCount then looks for entries
	// under the pinned model, finds none, and re-dispatches the arm on every pass. Three Claude
	// arms reached n=6 with "azure/gpt-5.6-sol" on all six rows before this was caught.
	await withTempAsync("bench-pin-", async (dir) => {
		// Generalization is map-gated now (2026-08-03): its creation arms are grounded, and
		// dispatching them before Discovery lands would run them on provenance "none" under a
		// grounded label. The old `phase === 2 || phase === 5` check missed this stage entirely.
		// Seed the stage's OWN discovery dependencies. Hardcoding the Yarn explores broke the
		// moment a second app joined Generalization — which is the point of discoveryArmsFor.
		const seeded = recordSubmissions(
			readManifest(DATE, liveDir(dir)),
			discoveryArmsFor(4).map((a) => entry(a.id, `explore-${a.id}`, { collected: true, state: "done" })),
		);
		writeManifest(seeded, liveDir(dir));

		const fake = fakeDispatch();
		await runPhase(4, { go: true, date: DATE, outRoot: dir, dispatchFn: fake.fn, log: () => {} });
		const claude = fake.calls.filter((c) => c.model === BENCH_ALT_MODEL);
		assert.ok(claude.length > 0, "the Claude arms must dispatch as Claude");
		const m = readManifest(DATE, liveDir(dir));
		for (const e of m.entries.filter((x) => x.armId.includes("claude")))
			assert.equal(e.model, BENCH_ALT_MODEL, `${e.armId} recorded ${e.model}, so counting will re-dispatch it forever`);
	});
});

test("creationArms__CarryAStepBudgetThatFitsTheTask__When__TheDefaultWouldCutThemOff", () => {
	// The default is 15 and the settings tasks finish in 5-13, so it was never questioned. The
	// creation task cannot: the only known-successful run of that flow took 19, and every
	// creation arm in the first pass stopped at EXACTLY 15 with `gave-up` — measuring the
	// ceiling, not the agent.
	// The EFFECTIVE budget is the arm's override or the runaway backstop (100). An arm-level 30
	// was the right fix against a default of 15 and the wrong one against a default of 100 with
	// a stall detector: it put a ceiling back in front of a run that was still making progress.
	// Three runs hit 30 with verified steps inside their last eight.
	const create = MATRIX.filter((a) => a.id.startsWith("create-"));
	assert.ok(create.length >= 15, "the creation task covers the phase-2 grid");
	for (const a of create)
		assert.ok(a.dispatch.steps === undefined || a.dispatch.steps > 19, `${a.id} caps below a known-good run's 19 steps`);
});

test("failureKind__SeparatesTheHarnessEndingARun__From__TheAgentsOwnVerdict", () => {
	// Every non-success used to collapse to "gave-up", so a run stopped by a 15-step budget was
	// indistinguishable from one that ran to its own conclusion. Seven creation runs stopped at
	// exactly 15 and read as "the agent cannot make a video" — the only known-good run of that
	// flow takes 19. The distinction has to survive into the metrics or the report cannot make
	// it either.
	const ceiling = failureKind(undefined, { success: false, stopReason: "step-ceiling" }, true);
	assert.equal(ceiling, "step-ceiling");
	assert.equal(failureKind(undefined, { success: false, stopReason: "stalled" }, true), "stalled");
	// An agent that reached its own verdict still reads as gave-up — that label keeps its
	// meaning precisely because the other two left it.
	assert.equal(failureKind(undefined, { success: false }, true), "gave-up");
});

test("agentLoop__KeepsTheStallVerdict__When__ItStopsBeforeTheBackstop", () => {
	// A dangling `if (!outcome)` — no braces — guarded a blank line, so the backstop assignment
	// below it ran unconditionally and overwrote the stall verdict one line after it was set.
	// Every stalled run reported "runaway backstop (100 steps) reached" having stopped at 8.
	// The detection worked; its answer was destroyed, which looks exactly like a feature that
	// was never built.
	const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "core", "agent", "run.ts"), "utf8");
	assert.match(src, /if \(!outcome\) \{/, "the backstop assignment must be BRACED, or it clobbers every earlier verdict");
	// And the two exits must stay distinguishable, or the report cannot tell a stuck run from a
	// long one — the whole reason stopReason exists.
	assert.match(src, /stopReason: "stalled"/);
	assert.match(src, /stopReason: "step-ceiling"/);
});

test("visionOnly__IsAllowedOnCdp__When__EitherEntryPointDispatchesIt", () => {
	// The task agent's CLI dropped its --no-ax refusal and EXPLORE's did not, so both
	// p1-explore-vision-cdp passes died on "--no-ax only applies to the ax backend" and the two
	// arms grounding on their map ran with provenance "none" — flagged, correctly, as a
	// grounding mismatch. The reasoning had expired identically in both files; only one was
	// edited. Asserted over both, so the pair cannot drift again.
	for (const rel of ["agent/cli.ts", "explore/cli.ts"]) {
		const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "core", rel), "utf8");
		assert.doesNotMatch(src, /only applies to the ax backend/, `${rel} still refuses vision-only on a non-ax backend`);
	}
	// And both loops must give a vision-only cdp run the pixel-addressed path, not cdp's
	// ref-based rules — a prompt for a tool the model is not holding.
	for (const rel of ["agent/run.ts", "explore.ts"]) {
		const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "core", rel), "utf8");
		assert.match(src, /cdp && !noAx/, `${rel} must let vision-only outrank the backend`);
	}
});

test("writeReport__WritesNothing__When__TheManifestIsEmpty", () => {
	// A pass is keyed by UTC date, so a collect without --date opens TODAY's manifest — which,
	// once midnight passes mid-pass, is a different and empty day. It used to write the full
	// report anyway: every heading, all 65 arm rows, every cell an em-dash, indistinguishable
	// from a benchmark where nothing worked. That happened five times on 2026-08-03 while the
	// real pass ran under 2026-08-01, and each file had to be spotted and moved by hand.
	withTemp("empty-report-", (dir) => {
		const file = writeReport({ date: "2026-08-03", createdAt: "", entries: [] }, { dir });
		assert.equal(fs.existsSync(file), false, "an empty pass must leave no report on disk");
		// A pass with data still writes, or the guard has eaten the feature.
		const withRow = writeReport(
			{ date: "2026-08-03", createdAt: "", entries: [entry("ax-grounded", "job-1", { collected: true, state: "done" })] },
			{ dir },
		);
		assert.equal(fs.existsSync(withRow), true);
	});
});

test("snapPx__ReachesTheChild__When__AnArmDeclaresIt", () => {
	// The wire has swallowed a declared field four separate times: useRecipes at the runner,
	// --backend at the CLI, record and recipeLineage on the control side. Walk it end to end
	// rather than trusting each layer to have been updated.
	const arm = MATRIX.find((a) => a.id === "vision-only-cdp-snap24");
	assert.ok(arm, "the snap arm must exist");
	assert.equal(dispatchOptionsFor(arm!, undefined, BENCH_PRIMARY_MODEL).snapPx, 24);
	const disp = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "remote", "control", "dispatch.ts"), "utf8");
	assert.match(disp, /snapPx: opts\.snapPx/, "dispatch must put snapPx on the wire");
	const serve = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "remote", "runner", "serve.ts"), "utf8");
	assert.match(serve, /params\.snapPx/, "the runner must READ snapPx out of the request");
	assert.match(serve, /SNAP_PX: String\(rec\.snapPx\)/, "and set it on the child");
	const jobs = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "remote", "runner", "jobs.ts"), "utf8");
	assert.match(jobs, /init\.snapPx/, "and persist it, or a queued job loses it across a runner restart");
});

test("snapArms__StayVisionOnly__When__TheyRefineActuation", () => {
	// The snap stage must not become a back door to element PERCEPTION. The model still sees
	// only pixels and still names its own target; only the coordinate is refined. An arm that
	// dropped --no-ax would be plain element addressing under a name that claims otherwise.
	for (const a of MATRIX.filter((x) => x.dispatch.snapPx))
		assert.equal(a.dispatch.noAx, true, `${a.id} snaps but is not vision-only — that is just element addressing`);
});
