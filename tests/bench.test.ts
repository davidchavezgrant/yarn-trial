import assert from "node:assert/strict";
import { appmapSlug } from "../src/core/target.js";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { auditTaskPrompt } from "../src/core/harness.js";
import type { JobRecord } from "../src/remote/runner/jobs.js";
import { expectedProvenance,
	archiveDirFor,
	collect,
	failureKind,
	poisonedHosts,
	jobTiming,
	journalScopes,
	parseAppmapStamp,
	parseGraphCounts,
	parseRunMetrics,
} from "../src/bench/collect.js";
import {
	type Manifest,
	type ManifestEntry,
	manifestPath,
	readManifest,
	recordSubmissions,
	submittedCount,
	updateEntry,
	writeManifest,
} from "../src/bench/manifest.js";
import { type Arm, armTitle, armAppmapSlug, armById, BACKENDS, MATRIX, phaseArms, phaseRunCount, perceptionLine } from "../src/bench/matrix.js";
import type { DispatchOptions } from "../src/remote/control/dispatch.js";
import { dateArg,
	auditPhase,
	dispatchOptionsFor,
	EXIT_NEEDS_GO,
	EXIT_OK,
	EXIT_REFUSED,
	findCompileSource,
	plannedRuns,
	runPhase,
} from "../src/bench/orchestrate.js";
import { renderReport, reportFileName, writeReport } from "../src/bench/report.js";
import { host, withTemp, withTempAsync } from "./fixtures.js";

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
	assert.equal(phaseRunCount(1), 9);
	// Phase 2: core 2 backends × 2 grounding × 3, plus 6 slices × 3. Two blocks were cut
	// 2026-07-31 after their prerequisites were CHECKED rather than assumed (matrix.ts holds
	// the full reasoning at each site): the Notion Calendar slice (4 arms × 2 = 8 runs — the
	// app is installed on none of the three Macs, so every run would refuse at the readiness
	// gate) and p2-vision-only-grounded (3 runs — its `.vision` appmap does not exist, and a
	// missing map degrades to provenance "none", making it a silent duplicate of the
	// ungrounded arm under a grounded label).
	// Phase 2: core 12, plus 8 slices × 3 — the vision-only tier is now four arms
	// (ungrounded floor / ax-written map / vision-written map / human notes).
	// Phase 2: core 12, 8 slices x 3, plus the web generalization slice (2 arms x 2). The web
	// arms restore the question the Notion Calendar cut lost — does anything transfer to a
	// second, larger app — on a target that needs a login rather than an install.
	// Phase 2: core 12 plus 8 slices x 3. The two web arms went with the web explore — they
	// grounded on its map and had nothing to ground on without it.
	// Phase 2: core 12, 8 slices x 3, plus the minimum-context PAIR x 3 — a bare AX tree with
	// no DOM attrs and no screenshots, grounded on an equally minimal map and ungrounded. The
	// ungrounded half is the floor of the whole matrix; every other arm should beat it.
	assert.equal(phaseRunCount(2), 12 + 24 + 6);
	// Phase 3: 2 local compiles + replay ×3 per backend + no-rescue ×3.
	assert.equal(phaseRunCount(3), 2 + 6 + 3);
	// Phase 4 (optional): 2 task cells × 2 + 1 compile + 2 replays.
	assert.equal(phaseRunCount(4), 7);
	// Phase 5 (filmed): one take per phase-2 task config (14, including the minimum-context
	// pair — derived from the phase-2 arms, so adding a config there adds a filmed take here)
	// plus one filmed replay per backend.
	assert.equal(phaseRunCount(5), 14 + 2);
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

test("MATRIX__KeepsVisionOnlyOnAxBackend__When__NoAxIsSet", () => {
	// Vision-only is ax-only by construction: cdp observations ARE ref lists.
	for (const arm of MATRIX) if (arm.dispatch.noAx) assert.equal(arm.dispatch.backend, "ax", arm.id);
});

test("MATRIX__LinksSourceArms__When__CompileOrReplay", () => {
	for (const arm of MATRIX) {
		if (arm.kind !== "compile" && arm.kind !== "replay") continue;
		assert.ok(arm.sourceArm && armById(arm.sourceArm), `${arm.id} sourceArm ${arm.sourceArm} not in matrix`);
	}
});

test("MATRIX__CarriesNoUnmetPrereqs__When__ArmsTargetASecondApp", () => {
	// The Notion Calendar slice is gone (see the phase-2 note above), so nothing in the
	// matrix should target a second app. This guards the restore path as much as the cut: an
	// arm reintroduced for an app the fleet does not have must carry its prereq, because the
	// prereq is what made the cut decidable instead of a surprise at run time.
	assert.deepEqual(MATRIX.filter((a) => a.app === "Notion Calendar"), []);
	for (const arm of MATRIX.filter((a) => a.prereq)) assert.match(arm.prereq ?? "", /signed in|installed/i, `${arm.id} prereq must name what is missing`);
});

test("MATRIX__ConfinesRecordingToTheFilmedPhase__When__ArmsAreDeclared", () => {
	// Recording is not a passive camera: it injects DEMO CONDUCT into the prompt, swaps in an
	// act tool without set_value, and changes actuation to hover-dwell-click. A measurement arm
	// that filmed itself would report demo-mode reliability as config reliability, so the split
	// is enforced rather than remembered.
	for (const arm of MATRIX) {
		if (arm.dispatch.record) assert.equal(arm.phase, 5, `${arm.id} films, so it belongs to phase 5`);
		if (arm.phase === 5) assert.equal(arm.dispatch.record, true, `${arm.id} is a filmed take and must set record`);
	}
	// Every filmed take is n=1 — footage, not statistics.
	for (const arm of MATRIX.filter((a) => a.phase === 5)) assert.equal(arm.n, 1, `${arm.id} must be a single take`);
	// And each one mirrors a real measured config rather than inventing flags, so a config
	// cannot be measured under one set of flags and filmed under another.
	const measured = new Set(MATRIX.filter((a) => a.phase === 2).map((a) => JSON.stringify({ ...a.dispatch, record: true })));
	for (const arm of MATRIX.filter((a) => a.phase === 5 && a.kind === "task")) {
		assert.ok(measured.has(JSON.stringify(arm.dispatch)), `${arm.id} does not mirror any phase-2 config`);
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
	collected: false,
	...over,
});

test("writeManifest__RoundTrips__When__ReadBack", () => {
	withTemp("bench-", (dir) => {
		const m: Manifest = { date: DATE, createdAt: "2026-07-31T09:00:00.000Z", entries: [entry("p1-explore-ax", "explore-j1")] };
		writeManifest(m, dir);
		assert.deepEqual(readManifest(DATE, dir), m);
		assert.ok(fs.existsSync(manifestPath(DATE, dir)));
	});
});

test("readManifest__ReturnsEmpty__When__FileAbsent", () => {
	withTemp("bench-", (dir) => {
		const m = readManifest(DATE, dir);
		assert.equal(m.date, DATE);
		assert.deepEqual(m.entries, []);
	});
});

test("recordSubmissions__DropsDuplicates__When__SameArmAndJobRecordedTwice", () => {
	const m: Manifest = { date: DATE, createdAt: "", entries: [entry("p2-ax-grounded", "j1")] };
	const next = recordSubmissions(m, [entry("p2-ax-grounded", "j1"), entry("p2-ax-grounded", "j2")]);
	assert.equal(next.entries.length, 2);
	assert.equal(submittedCount(next, "p2-ax-grounded"), 2);
});

test("updateEntry__ReplacesByKey__When__ArmAndJobMatch", () => {
	const m: Manifest = { date: DATE, createdAt: "", entries: [entry("p2-ax-grounded", "j1"), entry("p2-ax-grounded", "j2")] };
	const next = updateEntry(m, entry("p2-ax-grounded", "j2", { collected: true, state: "done" }));
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
		assert.equal(readManifest(DATE, dir).entries.length, 0);
		assert.ok(lines.some((l) => /Nothing was dispatched/.test(l)));
	});
});

test("runPhase__SubmitsEveryArmSample__When__GoIsSet", async () => {
	await withTempAsync("bench-", async (dir) => {
		const fake = fakeDispatch();
		const code = await runPhase(1, { go: true, date: DATE, outRoot: dir, dispatchFn: fake.fn, log: () => {} });
		assert.equal(code, EXIT_OK);
		// Nine: the two reference arms twice each, plus five single-condition cells.
		assert.equal(fake.calls.length, 9);
		// The two single-channel passes must differ ONLY in which channel they drop — same
		// backend, same app — or they are not a comparison.
		const single = fake.calls.filter((c) => c.noAx || c.noVision);
		// Four single-channel cells now: vision-only, ax-no-vision, ax-noaxdom-no-vision and
		// cdp-no-vision. Vision-only must stay on ax — cdp addresses actions by ref, so
		// dropping the element list drops the addressing with it.
		assert.equal(single.length, 4);
		assert.equal(single.filter((c) => c.noAx).length, 1, "exactly one screenshots-only pass");
		for (const c of single.filter((x) => x.noAx)) assert.equal(c.backend, "ax", "vision-only is ax-only by construction");
		assert.equal(single.filter((c) => c.noVision).length, 3);
		// The perception grid must span BOTH backends, or the screenshot question is only
		// answered on the fallback path and not on the one that ships.
		assert.ok(single.some((c) => c.backend === "cdp" && c.noVision), "cdp gets a no-vision cell too");
		// And the sidecar axis is present, which is the only test of whether axdom earns its
		// keep at grounding time rather than only at run time.
		assert.equal(fake.calls.filter((c) => c.axdomOff).length, 2);
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
		// Phase 1 is Yarn-only since 2026-08-01: no arm carries a URL, and every one targets
		// the same app so the four differ ONLY in perception and backend.
		assert.deepEqual(fake.calls.filter((c) => c.url), []);
		assert.ok(fake.calls.every((c) => c.app === "Yarn"), "every phase-1 arm targets Yarn");
		// Every accepted job landed in the manifest, uncollected.
		const m = readManifest(DATE, dir);
		assert.equal(m.entries.length, 9);
		assert.ok(m.entries.every((e) => !e.collected && e.host === "mac1"));
	});
});

test("runPhase__ShapesOptionsPerArm__When__Phase2Dispatches", async () => {
	await withTempAsync("bench-", async (dir) => {
		// Phase-1 gate satisfied: both Yarn explores collected.
		let m = readManifest(DATE, dir);
		m = recordSubmissions(m, [
			entry("p1-explore-ax", "explore-a", { collected: true, state: "done" }),
			entry("p1-explore-cdp", "explore-c", { collected: true, state: "done" }),
			// The vision-only pass has to be collected too, and the gate is right to insist:
			// p2-vision-only-grounded-visionmap reads the `.vision` map this pass writes, and
			// with no map loadGrounding degrades to provenance "none" — the arm would run as a
			// silent duplicate of the ungrounded one. Phase 2 refusing here IS the protection.
			entry("p1-explore-vision", "explore-v", { collected: true, state: "done" }),
			entry("p1-explore-no-vision", "explore-nv", { collected: true, state: "done" }),
			entry("p1-explore-ax-noaxdom", "explore-na", { collected: true, state: "done" }),
			entry("p1-explore-ax-noaxdom-no-vision", "explore-nanv", { collected: true, state: "done" }),
			entry("p1-explore-cdp-no-vision", "explore-cnv", { collected: true, state: "done" }),
		]);
		writeManifest(m, dir);

		const fake = fakeDispatch();
		const code = await runPhase(2, { go: true, date: DATE, outRoot: dir, dispatchFn: fake.fn, log: () => {} });
		assert.equal(code, EXIT_OK);
		assert.equal(fake.calls.length, 42);

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
		// Nine: the axdom-off arm at n=3, plus the minimum-context PAIR at n=3 each — both
		// halves of that pair run without the sidecar, which is half of what makes them
		// minimum-context.
		assert.equal(byFlag((c) => c.axdomOff === true).length, 9);
		// And the matrix floor is dispatched with everything off at once, which no other arm is.
		assert.equal(byFlag((c) => c.axdomOff === true && c.noVision === true && c.noGrounding === true).length, 3);
		assert.equal(byFlag((c) => c.noVision === true && c.backend === "cdp").length, 3);
		assert.equal(byFlag((c) => c.useRecipe === true && !c.noAx).length, 3);
		// Two vision-only arms remain (ungrounded floor + curated prose), 3 runs each. The
		// third — the machine-written-appmap arm — was cut, which is why no dispatch carries
		// appmapVariant: the variant it asked for resolves to a file that does not exist, and
		// a missing map degrades to no grounding at all rather than failing.
		// Four vision-only arms × 3. Exactly ONE carries appmapVariant: the arm grounded on the
		// vision-written map. The others are the ungrounded floor, the ax-written map, and the
		// curated notes — all four differ only in which grounding tier they read.
		assert.equal(byFlag((c) => c.noAx === true).length, 12);
		assert.equal(byFlag((c) => c.appmapVariant === "vision").length, 3);
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
		assert.equal(fake.calls.length, 42);
	});
});

test("runPhase__SubmitsOnlyMissingSamples__When__ManifestAlreadyHoldsSome", async () => {
	await withTempAsync("bench-", async (dir) => {
		let m = readManifest(DATE, dir);
		m = recordSubmissions(m, [
			entry("p1-explore-ax", "explore-a"),
			entry("p1-explore-cdp", "explore-c"),
			entry("p1-explore-vision", "explore-v"),
			entry("p1-explore-ax-noaxdom", "explore-na"),
			entry("p1-explore-ax-noaxdom-no-vision", "explore-nanv"),
			entry("p1-explore-cdp-no-vision", "explore-cnv"),
		]);
		writeManifest(m, dir);

		const fake = fakeDispatch();
		const code = await runPhase(1, { go: true, date: DATE, outRoot: dir, dispatchFn: fake.fn, log: () => {} });
		assert.equal(code, EXIT_OK);
		// ax and cdp are n=2, so seeding one sample of each leaves one of each outstanding,
		// plus the un-seeded no-vision pass.
		assert.equal(fake.calls.length, 3);
	});
});

test("runPhase__CompilesLocallyAndDispatchesReplays__When__Phase3HasCleanSources", async () => {
	await withTempAsync("bench-", async (dir) => {
		let m = readManifest(DATE, dir);
		m = recordSubmissions(m, [
			entry("p2-ax-grounded", "run-ax-1", { collected: true, state: "done", metrics: { success: true, finalCheckVerified: true } }),
			entry("p2-cdp-grounded", "run-cdp-1", { collected: true, state: "done", metrics: { success: false } }),
		]);
		writeManifest(m, dir);

		const fake = fakeDispatch();
		const compiled: string[] = [];
		const code = await runPhase(3, {
			go: true,
			date: DATE,
			outRoot: dir,
			dispatchFn: fake.fn,
			compileFn: (stamp) => {
				compiled.push(stamp);

				return { path: path.join(dir, "docs/recipes/yarn.abc.recipe.json") };
			},
			log: () => {},
		});
		assert.equal(code, EXIT_OK);
		// Only the ax source is clean; the cdp compile waits for a successful cdp run.
		assert.deepEqual(compiled, ["run-ax-1"]);

		// ax replays (3 + 3 no-rescue) dispatch with the compiled recipe; cdp replays defer.
		assert.equal(fake.calls.length, 6);
		for (const c of fake.calls) {
			assert.equal(c.kind, "replay");
			assert.match(c.recipe ?? "", /recipe\.json$/);
		}
		assert.equal(fake.calls.filter((c) => c.noRescue === true).length, 3);

		const after = readManifest(DATE, dir);
		const compileEntry = after.entries.find((e) => e.armId === "p3-compile-ax");
		assert.equal(compileEntry?.host, "local");
		assert.equal(compileEntry?.collected, true);
		assert.match(compileEntry?.recipe ?? "", /recipe\.json$/);
	});
});

test("runPhase__RecordsCompileRefusal__When__CompileFnThrows", async () => {
	await withTempAsync("bench-", async (dir) => {
		let m = readManifest(DATE, dir);
		m = recordSubmissions(m, [entry("p2-ax-grounded", "run-hinted", { collected: true, state: "done", metrics: { success: true } })]);
		writeManifest(m, dir);

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
		const after = readManifest(DATE, dir);
		const refusal = after.entries.find((e) => e.armId === "p3-compile-ax");
		assert.equal(refusal?.state, "failed");
		assert.match(refusal?.note ?? "", /--hinted/);
		// No recipe means every ax replay deferred rather than dispatched without one.
		assert.equal(fake.calls.length, 0);
	});
});

test("plannedRuns__ExcludesCompileArms__When__Phase3Planned", () => {
	const m: Manifest = { date: DATE, createdAt: "", entries: [] };
	assert.ok(plannedRuns(3, m).every((p) => p.arm.kind !== "compile"));
});

test("dispatchOptionsFor__CarriesRecipeAndQueue__When__ReplayArm", () => {
	const arm = armById("p3-replay-ax-norescue")!;
	const o = dispatchOptionsFor(arm, "docs/recipes/yarn.abc.recipe.json");
	assert.equal(o.kind, "replay");
	assert.equal(o.queue, true);
	assert.equal(o.noRescue, true);
	assert.equal(o.recipe, "docs/recipes/yarn.abc.recipe.json");
});

test("findCompileSource__SkipsTriedStamps__When__PreviousCompileRefused", () => {
	const m: Manifest = {
		date: DATE,
		createdAt: "",
		entries: [
			entry("p2-ax-grounded", "run-1", { collected: true, metrics: { success: true } }),
			entry("p2-ax-grounded", "run-2", { collected: true, metrics: { success: true } }),
		],
	};
	assert.equal(findCompileSource(m, "p2-ax-grounded", new Set(["run-1"]))?.jobId, "run-2");
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
	// The shape recipe-cli.ts writes for a replay: modelCalls top-level, replayOf set,
	// rescues marked in modelReasoning (see replay.ts).
	const m = parseRunMetrics({
		task: "t",
		app: "Yarn",
		backend: "ax",
		replayOf: "2026-07-31T02-18-03-799-www.wikipedia.org",
		recipeSteps: 3,
		modelCalls: 2,
		success: true,
		steps: [
			{ modelReasoning: "replayed from recipe x" },
			{ modelReasoning: "rescued after: target not found" },
			{ modelReasoning: "replayed from recipe x" },
		],
	});
	assert.equal(m.recipeSteps, 3);
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
		let m = readManifest(DATE, outRoot);
		m = recordSubmissions(m, [entry("p2-ax-grounded", "job-1")]);
		writeManifest(m, outRoot);

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
		let m = readManifest(DATE, outRoot);
		m = recordSubmissions(m, [entry("p2-ax-grounded", "job-1")]);
		writeManifest(m, outRoot);

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
		let m = readManifest(DATE, outRoot);
		m = recordSubmissions(m, [entry("p2-ax-grounded", "job-1")]);
		writeManifest(m, outRoot);

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
		let m = readManifest(DATE, outRoot);
		m = recordSubmissions(m, [entry("p2-ax-grounded", "job-1")]);
		writeManifest(m, outRoot);

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
		let m = readManifest(DATE, outRoot);
		m = recordSubmissions(m, [entry("p1-explore-ax", "explore-1")]);
		writeManifest(m, outRoot);

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
			entry("p2-ax-grounded", "job-1", { collected: true, state: "done", metrics: { success: true, steps: 4, elapsedSec: 52, modelCalls: 6, mutationScopes: ["brand"], queueWaitSec: 12, runSec: 60 } }),
			entry("p2-ax-ungrounded", "job-2"),
		],
	};
	const md = renderReport(m);
	assert.match(md, /## Phase 1 — node discovery/);
	assert.match(md, /## Phase 2 — backend × grounding \(core\)/);
	assert.match(md, /## Phase 2 — generalization \(Notion Calendar\)/);
	assert.match(md, /## Phase 3 — recipes/);
	assert.match(md, /## Timing/);
	assert.match(md, /## For Aman/);
	assert.match(md, /`job-1` \(mac1\)/);
	assert.match(md, /`job-2` \(mac1, uncollected\)/);
	// The collected arm's row carries its numbers; the arm with no collected runs shows —.
	assert.match(md, /\| p2-ax-grounded \|[^\n]*\| 1\/3 \| 1\/1 \| — \| 4 \| 52 \| 6 \|/);
	assert.match(md, /TODO: which backend/);
});

test("writeReport__WritesRegenerableFile__When__CalledTwice", () => {
	withTemp("bench-", (dir) => {
		const m: Manifest = { date: DATE, createdAt: "", entries: [] };
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
		assert.equal(a.calls.length, 9, "pass A submits the full phase");
		for (const c of a.calls) assert.equal(c.model, "openai/gpt-5.6-sol:nitro");

		const b = fakeDispatch();
		await runPhase(1, { go: true, date: DATE, outRoot: dir, dispatchFn: b.fn, log: () => {}, model: "claude-fable-5" });
		assert.equal(b.calls.length, 9, "pass B submits the full phase again — pass A's entries are not its samples");
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
		let m = readManifest(DATE, dir);
		for (const e of m.entries) m = updateEntry(m, { ...e, collected: true });
		writeManifest(m, dir);

		const b = fakeDispatch();
		const code = await runPhase(2, { go: true, date: DATE, outRoot: dir, dispatchFn: b.fn, log: () => {}, model: "claude-fable-5" });
		assert.equal(code, EXIT_REFUSED, "pass B's phase 2 refuses on pass A's maps");
		assert.equal(b.calls.length, 0);
	});
});

test("archiveDirFor__KeysOnModelArmAndJob__When__PassesOrSamplesShareOneManifest", () => {
	const base = { armId: "p1-explore-ax", jobId: "j", host: "mac1", submittedAt: "", state: "done", collected: true };
	const sol = archiveDirFor("/bench/2026-07-31", { ...base, model: "openai/gpt-5.6-sol:nitro" });
	const fable = archiveDirFor("/bench/2026-07-31", { ...base, model: "claude-fable-5" });
	assert.notEqual(sol, fable, "each model pass archives its own maps");
	assert.match(sol, /appmaps\/openai-gpt-5.6-sol-nitro\/p1-explore-ax\/j$/);
	assert.match(archiveDirFor("/b", base), /appmaps\/default\/p1-explore-ax\/j$/);

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
		armId: "p2-ax-grounded", jobId, host, submittedAt: "", state: "done", collected: true,
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
	assert.equal(perceptionLine(arm({ backend: "ax", noAx: true })), "screenshots only");
	// The element channel is named PER BACKEND, because they are different things: ax gives
	// the accessibility tree plus the DOM attributes the axdom sidecar joins on, cdp gives the
	// DOM itself and no AX at all. Calling both "elements" hid a real distinction.
	assert.equal(perceptionLine(arm({ backend: "ax", noVision: true })), "AX tree + DOM attrs");
	assert.equal(perceptionLine(arm({ backend: "ax" })), "AX tree + DOM attrs + screenshots");
	assert.equal(perceptionLine(arm({ backend: "cdp" })), "DOM + screenshots");
	// AXDOM=0 removes the second half of the ax element channel, and the label must show it —
	// that arm exists to measure whether the sidecar is worth shipping.
	assert.equal(perceptionLine(arm({ backend: "ax", axdomOff: true })), "AX tree (no DOM attrs) + screenshots");
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
	// p1-explore-ax and p1-explore-no-vision still collided. Neither was visible in any test
	// because the arms individually looked fine; only the pair was wrong.
	const explores = MATRIX.filter((a) => a.kind === "explore");
	const byslug = new Map<string, string[]>();
	for (const a of explores) byslug.set(armAppmapSlug(a), [...(byslug.get(armAppmapSlug(a)) ?? []), a.id]);
	const clashes = [...byslug].filter(([, ids]) => ids.length > 1);
	assert.deepEqual(clashes, [], `arms sharing an appmap file: ${clashes.map(([s, ids]) => `${s} <- ${ids.join(" + ")}`).join("; ")}`);

	// And every dimension that varies must actually appear in the name, or a future arm
	// varying only in that dimension collides silently.
	const yarnAx = explores.find((a) => a.id === "p1-explore-ax");
	assert.ok(yarnAx);
	assert.equal(armAppmapSlug(yarnAx), "yarn.ax", "backend in the name");
	assert.equal(armAppmapSlug(explores.find((a) => a.id === "p1-explore-no-vision")!), "yarn.ax.novision", "perception tier in the name");
	assert.equal(armAppmapSlug(explores.find((a) => a.id === "p1-explore-vision")!), "yarn.ax.vision", "vision-only tier in the name");
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
		const task = MATRIX.find((a) => a.id === `p2-${backend}-grounded`);
		const explore = exploreFor(backend);
		assert.ok(task && explore, backend);
		assert.equal(armAppmapSlug(task), armAppmapSlug(explore), `p2-${backend}-grounded must read what p1-explore-${backend} wrote`);
	}
});

test("armTitle__NamesTheArmWithoutRepeatingPerception__When__ShownBesideIt", () => {
	// Title and perception appear in adjacent columns, so the title stays silent about
	// channels — "grounded task | screenshots only" reads once, not twice.
	const arm = (kind: string, dispatch: any, env?: any): any => ({ id: "x", phase: 2, kind, app: "Yarn", n: 1, dispatch, ...(env ? { env } : {}) });
	assert.equal(armTitle(arm("explore", { backend: "ax" })), "grounding pass");
	assert.equal(armTitle(arm("explore", { backend: "cdp", url: "https://app.notion.com" })), "grounding pass (web)");
	assert.equal(armTitle(arm("task", { backend: "ax" })), "grounded task");
	assert.equal(armTitle(arm("task", { backend: "ax", noGrounding: true })), "ungrounded task");
	assert.equal(armTitle(arm("task", { backend: "ax", useRecipe: true })), "human-notes task");
	assert.equal(armTitle(arm("task", { backend: "ax", noAx: true }, { APPMAP_VARIANT: "vision" })), "vision-map grounded task");
	assert.equal(armTitle(arm("task", { backend: "ax", record: true })), "filmed grounded task");
	assert.equal(armTitle(arm("replay", { backend: "ax", noRescue: true })), "recipe replay (no rescue)");
	// Derived from the DISPATCH, never from the rendered flags string — the dash used to parse
	// flagsLine output, which fails silently the moment the wording changes.
	for (const a of MATRIX) assert.ok(armTitle(a).length > 0 && !armTitle(a).includes("undefined"), a.id);
});

test("MATRIX__ConsumesEveryMapItProduces__When__ExploresAndTaskArmsArePaired", () => {
	// A grounding pass costs ~30 minutes and ~$14. One whose map no arm reads is that spent
	// for a comparison alone — which is what p1-explore-no-vision was until APPMAP_VARIANT
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
	const consumers = MATRIX.filter((a) => a.kind === "task" && !a.dispatch.noGrounding && !a.dispatch.useRecipe);

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
	const grounded = MATRIX.find((a) => a.id === "p2-ax-grounded")!;
	const ungrounded = MATRIX.find((a) => a.id === "p2-ax-ungrounded")!;
	const curated = MATRIX.find((a) => a.id === "p2-ax-curated")!;
	const visionmap = MATRIX.find((a) => a.id === "p2-vision-only-grounded-visionmap")!;

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
	assert.equal(perceptionLine(min), "AX tree (no DOM attrs)");
});

test("MATRIX__FilmsEveryMeasuredConfig__When__PhaseFiveIsDerived", () => {
	// "Recordings of everything" is a coverage claim, so it should be a test rather than a
	// habit. Phase 5 derives from the phase-2 arms, so the guarantee holds automatically —
	// but only while nothing is added to phase 2 outside the derived set, which is exactly
	// the mistake a future edit would make.
	const measured = MATRIX.filter((a) => a.phase === 2 && a.kind === "task");
	const filmed = MATRIX.filter((a) => a.phase === 5 && a.kind === "task");
	const shape = (a: Arm) => JSON.stringify({ ...a.dispatch, record: undefined, env: a.env ?? null });

	assert.equal(filmed.length, measured.length, "every measured config needs a filmed twin");
	const filmedShapes = new Set(filmed.map(shape));
	for (const m of measured) assert.ok(filmedShapes.has(shape(m)), `${m.id} is measured but never filmed`);
	// Including the floor and the minimum-context pair — the reorder question (does demo
	// conduct break this config?) applies hardest where the config is already marginal.
	for (const id of ["p2-min-context-ungrounded", "p2-vision-only-ungrounded"]) {
		const m = MATRIX.find((a) => a.id === id);
		assert.ok(m && filmedShapes.has(shape(m)), `${id} has no filmed twin`);
	}
});

