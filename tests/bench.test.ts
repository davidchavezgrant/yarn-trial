import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { auditTaskPrompt } from "../src/core/harness.js";
import type { JobRecord } from "../src/remote/runner/jobs.js";
import {
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
import { armById, BACKENDS, MATRIX, phaseArms, phaseRunCount, perceptionLine } from "../src/bench/matrix.js";
import type { DispatchOptions } from "../src/remote/control/dispatch.js";
import {
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
	// Phase 1: ax + cdp Yarn explores, the cdp web-explore verification run, and the
	// vision-only grounding pass (added 2026-07-31 — the matrix previously had three
	// vision-only TASK arms and no vision-only GROUNDING, so the AX-hostile-app question
	// was only half-asked).
	assert.equal(phaseRunCount(1), 4);
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
	assert.equal(phaseRunCount(2), 12 + 24 + 4);
	// Phase 3: 2 local compiles + replay ×3 per backend + no-rescue ×3.
	assert.equal(phaseRunCount(3), 2 + 6 + 3);
	// Phase 4 (optional): 2 task cells × 2 + 1 compile + 2 replays.
	assert.equal(phaseRunCount(4), 7);
	// Phase 5 (filmed): one take per phase-2 task config (12) + one filmed replay per backend.
	assert.equal(phaseRunCount(5), 12 + 2);
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
		// Four: ax + cdp Yarn explores, the cdp web check, and the vision-only grounding pass.
		assert.equal(fake.calls.length, 4);
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
		// The web verification run carries its URL.
		const web = fake.calls.find((c) => c.url);
		assert.equal(web?.backend, "cdp");
		// The canonical web target is Notion (David, 2026-07-31) — a real application, where
	// Wikipedia was a portal that proved almost nothing about transfer.
	assert.match(web?.url ?? "", /app\.notion\.com/);
		// Every accepted job landed in the manifest, uncollected.
		const m = readManifest(DATE, dir);
		assert.equal(m.entries.length, 4);
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
		]);
		writeManifest(m, dir);

		const fake = fakeDispatch();
		const code = await runPhase(2, { go: true, date: DATE, outRoot: dir, dispatchFn: fake.fn, log: () => {} });
		assert.equal(code, EXIT_OK);
		assert.equal(fake.calls.length, 40);

		const byFlag = (pred: (c: DispatchOptions) => boolean): DispatchOptions[] => fake.calls.filter(pred);
		// Task text crosses verbatim and is goal-only for every call.
		for (const c of fake.calls) {
			assert.equal(c.kind, "task");
			assert.equal(auditTaskPrompt(c.task ?? "").hinted, false);
		}
		assert.equal(byFlag((c) => c.noGrounding === true && c.backend === "ax" && !c.noAx && c.app === "Yarn").length, 3);
		assert.equal(byFlag((c) => c.axdomOff === true).length, 3);
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
		// The web slice targets a URL, so every one of its dispatches must carry --url; a web
		// arm that lost it would silently drive whatever the backend opened by default.
		const web = byFlag((c) => c.app === "https://app.notion.com");
		assert.equal(web.length, 4);
		for (const c of web) {
			assert.equal(c.url, "https://app.notion.com", "web arm must carry its URL");
			assert.equal(c.backend, "cdp", "a browser page is the DOM — there is no second backend here");
		}
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
		assert.equal(fake.calls.length, 40);
	});
});

test("runPhase__SubmitsOnlyMissingSamples__When__ManifestAlreadyHoldsSome", async () => {
	await withTempAsync("bench-", async (dir) => {
		let m = readManifest(DATE, dir);
		m = recordSubmissions(m, [
			entry("p1-explore-ax", "explore-a"),
			entry("p1-explore-cdp", "explore-c"),
			entry("p1-explore-vision", "explore-v"),
		]);
		writeManifest(m, dir);

		const fake = fakeDispatch();
		const code = await runPhase(1, { go: true, date: DATE, outRoot: dir, dispatchFn: fake.fn, log: () => {} });
		assert.equal(code, EXIT_OK);
		// Only the web-explore run was missing.
		assert.equal(fake.calls.length, 1);
		assert.match(fake.calls[0].url ?? "", /app\.notion\.com/);
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
		assert.equal(a.calls.length, 4, "pass A submits the full phase");
		for (const c of a.calls) assert.equal(c.model, "openai/gpt-5.6-sol:nitro");

		const b = fakeDispatch();
		await runPhase(1, { go: true, date: DATE, outRoot: dir, dispatchFn: b.fn, log: () => {}, model: "claude-fable-5" });
		assert.equal(b.calls.length, 4, "pass B submits the full phase again — pass A's entries are not its samples");
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

test("archiveDirFor__KeysOnModelAndArm__When__TwoPassesShareOneManifest", () => {
	const base = { armId: "p1-explore-ax", jobId: "j", host: "mac1", submittedAt: "", state: "done", collected: true };
	const sol = archiveDirFor("/bench/2026-07-31", { ...base, model: "openai/gpt-5.6-sol:nitro" });
	const fable = archiveDirFor("/bench/2026-07-31", { ...base, model: "claude-fable-5" });
	assert.notEqual(sol, fable, "each pass archives its own maps");
	assert.match(sol, /appmaps\/openai-gpt-5.6-sol-nitro\/p1-explore-ax$/);
	assert.match(archiveDirFor("/b", base), /appmaps\/default\/p1-explore-ax$/);
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
	assert.equal(perceptionLine(arm({ backend: "ax", noAx: true })), "perception: screenshots only");
	assert.equal(perceptionLine(arm({ backend: "ax", noVision: true })), "perception: element list only");
	assert.equal(perceptionLine(arm({ backend: "ax" })), "perception: elements + screenshots");
	assert.equal(perceptionLine(arm({ backend: "cdp" })), "perception: elements + screenshots");
	// The actuator must not change the answer — that conflation is the whole bug.
	assert.equal(perceptionLine(arm({ backend: "cdp", noAx: true })), perceptionLine(arm({ backend: "ax", noAx: true })));
});

test("perceptionLine__ReportsTheEmptyCase__When__BothChannelsAreOff", () => {
	// The explore CLI refuses this combination (a window title and nothing else), but a label
	// that quietly cannot happen teaches nothing to whoever declares the arm that tries it.
	const both: any = { id: "x", phase: 2, kind: "task", app: "Yarn", n: 1, dispatch: { backend: "ax", noAx: true, noVision: true } };
	assert.equal(perceptionLine(both), "perception: NOTHING");
});
