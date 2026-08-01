import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
	autopilot,
	DEFAULT_PHASES,
	driveToCompletion,
	type DriveContext,
	orderedPhases,
	overRetryBudget,
	passSpend,
	pendingWork,
	planStages,
	promoteForPhase6,
	stageTitle,
} from "../src/bench/autopilot.js";
import { type Manifest, type ManifestEntry, readManifest, utcDate, writeManifest } from "../src/bench/manifest.js";
import { BENCH_PRIMARY_MODEL, CANONICAL_TASK, type Phase, phaseArms } from "../src/bench/matrix.js";
import { EXIT_NEEDS_GO, EXIT_OK, EXIT_REFUSED, interruptedPass, runPhase } from "../src/bench/orchestrate.js";
import { watchPhase } from "../src/bench/watch.js";
import { procedureFileFor } from "../src/core/procedure.js";
import { liveDir } from "../src/paths.js";
import { host, withTempAsync } from "./fixtures.js";

/**
 * The autopilot, offline by construction — the same rule as bench.test.ts: every seam is an
 * injected fake, every file lands in a temp dir, and nothing may reach the fleet or a model.
 * What these tests pin is the ORCHESTRATION contract: which mistakes from the manual workflow
 * (see autopilot.ts's header) the driver refuses, retries, or moves past.
 */

const DATE = "2026-07-31";
const MODEL = BENCH_PRIMARY_MODEL;

const entry = (armId: string, jobId: string, over: Partial<ManifestEntry> = {}): ManifestEntry => ({
	armId,
	jobId,
	host: "mac1",
	submittedAt: "2026-07-31T06:00:00.000Z",
	state: "done",
	collected: true,
	model: MODEL,
	...over,
});

const manifest = (entries: ManifestEntry[]): Manifest => ({ date: DATE, createdAt: "2026-07-31T05:00:00.000Z", entries });

/** Every arm of a phase filled to its declared n with clean, collected entries. */
const filledPhase = (phase: Phase): ManifestEntry[] =>
	phaseArms(phase).flatMap((arm) => Array.from({ length: arm.n }, (_, i) => entry(arm.id, `${arm.id}-${i}`)));

const doneProgress = { outstanding: 0, inFlight: 0, done: true };

const ctxFor = (dir: string, over: Partial<DriveContext> = {}): DriveContext => ({
	date: DATE,
	model: MODEL,
	liveRoot: liveDir(dir),
	maxWaves: 4,
	maxTechnicalFailures: 2,
	runPhaseFn: async () => EXIT_OK,
	watchFn: async () => doneProgress,
	log: () => {},
	...over,
});

// --- stage planning ---

test("orderedPhases__PutsFilmedPassLast__When__Phase5Requested", () => {
	// Phase 5 films takes with a different action space; the plan doc says run it last, and the
	// planner enforces that regardless of how the operator ordered the flag.
	assert.deepEqual(orderedPhases([5, 1, 3, 2] as Phase[]), [1, 2, 3, 5]);
	assert.deepEqual(orderedPhases([2, 2, 1] as Phase[]), [1, 2]);
});

test("planStages__InsertsJudgeHarvestPromoteBeforePhase6__When__Phase6Requested", () => {
	const titles = planStages([1, 6] as Phase[]).map(stageTitle);
	assert.deepEqual(titles, ["phase 1", "judge", "harvest", "promote", "phase 6", "final"]);
	// Without phase 6 the pipeline stages don't appear — judging happens once, in final.
	assert.deepEqual(planStages([1, 2] as Phase[]).map(stageTitle), ["phase 1", "phase 2", "final"]);
});

// --- preflight ---

test("autopilot__DispatchesNothing__When__GoFlagAbsent", async () => {
	await withTempAsync("auto-", async (dir) => {
		let touched = 0;
		const lines: string[] = [];
		const code = await autopilot({
			date: DATE,
			outRoot: dir,
			dataDir: dir,
			proceduresDir: path.join(dir, "procs"),
			log: (l) => lines.push(l),
			runPhaseFn: async () => (touched++, EXIT_OK),
			watchFn: async () => (touched++, doneProgress),
			keyCheckFn: async () => {
				touched++;
			},
			fleetFn: async () => (touched++, []),
		});
		assert.equal(code, EXIT_NEEDS_GO);
		assert.equal(touched, 0, "preview must not dispatch, poll, or spend anything");
		assert.ok(lines.some((l) => /plan only/.test(l)));
	});
});

test("autopilot__RefusesToStart__When__YesterdayHoldsAnInterruptedPass", async () => {
	// The 07-31→08-01 rollover re-dispatched three finished explores. Unattended, the wrong
	// guess costs a whole duplicated pass — so with no --date and yesterday's manifest busy
	// while today's is empty, the autopilot refuses with both continuations spelled out.
	await withTempAsync("auto-", async (dir) => {
		const today = utcDate();
		const prev = new Date(`${today}T00:00:00Z`);
		prev.setUTCDate(prev.getUTCDate() - 1);
		const yday = prev.toISOString().slice(0, 10);
		writeManifest({ date: yday, createdAt: `${yday}T01:00:00.000Z`, entries: [entry("p1-explore-ax", "a")] }, liveDir(dir));

		const lines: string[] = [];
		const code = await autopilot({
			go: true,
			outRoot: dir,
			dataDir: dir,
			log: (l) => lines.push(l),
			runPhaseFn: async () => EXIT_OK,
			watchFn: async () => doneProgress,
			keyCheckFn: async () => {},
			fleetFn: async () => [{ name: "mac1", reachable: true, state: "idle" }],
		});
		assert.equal(code, EXIT_REFUSED);
		assert.ok(lines.some((l) => /rolled over/.test(l)));
		assert.ok(lines.some((l) => new RegExp(`--date ${yday}`).test(l)));
	});
});

test("interruptedPass__ReturnsNothing__When__TodayAlreadyHasEntries", async () => {
	await withTempAsync("auto-", async (dir) => {
		writeManifest(manifest([entry("p1-explore-ax", "a")]), liveDir(dir));
		assert.equal(interruptedPass(DATE, dir), undefined);
	});
});

test("autopilot__RefusesBeforeDispatching__When__TheJudgeKeyIsDead", async () => {
	// The 2026-07-31 near-miss: a key that existed and was dead (401) would have left all 62
	// runs ungradeable — discovered only because a preflight ran first. The check must gate
	// dispatch, not the judge stage hours later.
	await withTempAsync("auto-", async (dir) => {
		let dispatched = 0;
		const lines: string[] = [];
		const code = await autopilot({
			go: true,
			date: DATE,
			outRoot: dir,
			dataDir: dir,
			log: (l) => lines.push(l),
			runPhaseFn: async () => (dispatched++, EXIT_OK),
			watchFn: async () => doneProgress,
			keyCheckFn: async () => {
				throw new Error("401 User not found");
			},
			fleetFn: async () => [{ name: "mac1", reachable: true, state: "idle" }],
		});
		assert.equal(code, EXIT_REFUSED);
		assert.equal(dispatched, 0);
		assert.ok(lines.some((l) => /judge\/harvest model is unreachable/.test(l)));
	});
});

test("autopilot__Refuses__When__NoFleetHostIsReachable", async () => {
	await withTempAsync("auto-", async (dir) => {
		let dispatched = 0;
		const code = await autopilot({
			go: true,
			date: DATE,
			outRoot: dir,
			dataDir: dir,
			log: () => {},
			runPhaseFn: async () => (dispatched++, EXIT_OK),
			watchFn: async () => doneProgress,
			keyCheckFn: async () => {},
			fleetFn: async () => [
				{ name: "mac1", reachable: false, state: "unknown" },
				{ name: "mac2", reachable: false, state: "unknown" },
			],
		});
		assert.equal(code, EXIT_REFUSED);
		assert.equal(dispatched, 0);
	});
});

// --- the wave loop ---

test("driveToCompletion__StopsTheLine__When__TechnicalFailuresExceedTheBudget", async () => {
	// submittedCount frees a technical failure's slot so the next wave re-submits it — which
	// unattended means an arm dying on a broken host would be re-bought forever. Three deaths
	// against a budget of two stops the line instead.
	await withTempAsync("auto-", async (dir) => {
		const dead = (j: string): ManifestEntry => entry("p1-explore-ax", j, { state: "failed", collected: false, technical: { kind: "crashed", detail: "died on acquisition" } });
		writeManifest(manifest([dead("a"), dead("b"), dead("c")]), liveDir(dir));

		let dispatched = 0;
		const reason = await driveToCompletion(1, ctxFor(dir, { runPhaseFn: async () => (dispatched++, EXIT_OK) }));
		assert.ok(reason && /retry budget/.test(reason), reason);
		assert.ok(reason.includes("p1-explore-ax"));
		assert.equal(dispatched, 0, "over budget must stop BEFORE spending more");
	});
});

test("driveToCompletion__RunsASecondWave__When__ATechnicalFailureFreedASlot", async () => {
	await withTempAsync("auto-", async (dir) => {
		const live = liveDir(dir);
		let waves = 0;
		const reason = await driveToCompletion(
			1,
			ctxFor(dir, {
				runPhaseFn: async () => {
					waves++;
					if (waves === 1) {
						// First drain: every arm filled, but one run died producing nothing.
						const entries = filledPhase(1);
						entries[0] = entry(entries[0].armId, entries[0].jobId, { state: "failed", collected: false, technical: { kind: "orphaned", detail: "runner restarted" } });
						writeManifest(manifest(entries), live);
					} else {
						// Second wave re-submits just the freed slot.
						const m = readManifest(DATE, live);
						writeManifest({ ...m, entries: [...m.entries, entry(m.entries[0].armId, "retry-0")] }, live);
					}

					return EXIT_OK;
				},
			}),
		);
		assert.equal(reason, undefined);
		assert.equal(waves, 2, "the freed slot needs exactly one more wave");
	});
});

test("driveToCompletion__MovesOnWithAFinding__When__AWholeWaveChangesNothing", async () => {
	// Phase 3's replays wait on compiles, and a compile whose every source run failed on its
	// merits can never succeed this pass. That is a phase-3 finding — the loop must name it and
	// move on, not spin waves on it and not stop the line.
	await withTempAsync("auto-", async (dir) => {
		const live = liveDir(dir);
		// Every phase-3 TASK arm consumed its samples with honest (non-technical) failures:
		// nothing left to dispatch, no clean compile source, replays deferred forever.
		const entries = phaseArms(3)
			.filter((a) => a.kind === "task")
			.flatMap((arm) => Array.from({ length: arm.n }, (_, i) => entry(arm.id, `${arm.id}-${i}`, { metrics: { success: false } })));
		writeManifest(manifest(entries), live);

		const lines: string[] = [];
		let waves = 0;
		const reason = await driveToCompletion(3, ctxFor(dir, { log: (l) => lines.push(l), runPhaseFn: async () => (waves++, EXIT_OK) }));
		assert.equal(reason, undefined);
		assert.equal(waves, 1, "a no-progress wave must not repeat");
		assert.ok(lines.some((l) => /cannot progress this pass/.test(l)));
	});
});

test("driveToCompletion__StopsBeforeDispatch__When__TheSpendCeilingIsReached", async () => {
	await withTempAsync("auto-", async (dir) => {
		writeManifest(manifest([entry("p1-explore-ax", "a", { metrics: { inputTokens: 2_000_000, outputTokens: 100_000, model: "claude-fable-5" } })]), liveDir(dir));
		let dispatched = 0;
		const reason = await driveToCompletion(1, ctxFor(dir, { maxUsd: 0.5, runPhaseFn: async () => (dispatched++, EXIT_OK) }));
		assert.ok(reason && /spend ceiling/.test(reason), reason);
		assert.equal(dispatched, 0);
	});
});

test("driveToCompletion__StopsWithSigninGuidance__When__AWaveAddsAnUnreadyRun", async () => {
	// The dominant archived failure mode (41/140 job records): exit 3, app signed out. A
	// signed-out Mac does not heal itself, so the FIRST new one stops the line with the fix.
	await withTempAsync("auto-", async (dir) => {
		const live = liveDir(dir);
		const reason = await driveToCompletion(
			1,
			ctxFor(dir, {
				runPhaseFn: async () => {
					const entries = filledPhase(1);
					entries[0] = entry(entries[0].armId, entries[0].jobId, {
						state: "failed",
						host: "mac2",
						technical: { kind: "unready", detail: "refused at the home-state gate (exit 3)" },
					});
					writeManifest(manifest(entries), live);

					return EXIT_OK;
				},
			}),
		);
		assert.ok(reason && /signin mac2/.test(reason), reason);
	});
});

test("driveToCompletion__Resumes__When__UnreadyRunsPredateTheAutopilot", async () => {
	// Delta semantics: the operator signed the host in and re-ran. Old unready entries must
	// neither stop the line again nor trip the retry budget — their freed slots just refill.
	await withTempAsync("auto-", async (dir) => {
		const live = liveDir(dir);
		const stale = (j: string): ManifestEntry =>
			entry("p1-explore-ax", j, { state: "failed", collected: false, technical: { kind: "unready", detail: "exit 3" } });
		writeManifest(manifest([stale("u1"), stale("u2"), stale("u3")]), live);

		const reason = await driveToCompletion(
			1,
			ctxFor(dir, {
				runPhaseFn: async () => {
					const m = readManifest(DATE, live);
					writeManifest({ ...m, entries: [...m.entries, ...filledPhase(1)] }, live);

					return EXIT_OK;
				},
			}),
		);
		assert.equal(reason, undefined, "three FIXED unready failures must not stop a resumed pass");
	});
});

test("driveToCompletion__StopsTheLine__When__AWavePoisonsAHost", async () => {
	// poisonedHosts() (3 consecutive same-kind failures on one Mac) existed as a scrolling
	// collect warning with no consumer — queued arms kept landing on the broken Mac anyway.
	await withTempAsync("auto-", async (dir) => {
		const live = liveDir(dir);
		const reason = await driveToCompletion(
			1,
			ctxFor(dir, {
				runPhaseFn: async () => {
					const entries = filledPhase(1).map((e, i) =>
						i < 3 ? { ...e, host: "mac3", state: "failed", metrics: { success: false, failureKind: "gave-up" as const } } : e,
					);
					writeManifest(manifest(entries), live);

					return EXIT_OK;
				},
			}),
		);
		assert.ok(reason && /POISONED HOST/.test(reason) && /mac3/.test(reason), reason);
	});
});

test("autopilot__RefusesToResume__When__TheLiveManifestWasWiped", async () => {
	// After a purge, readManifest's live→archive fallback resurrected the finished manifest and
	// a re-fire reported "0 submitted" — every arm looked done. The autopilot must not adopt a
	// backup as the live pass.
	await withTempAsync("auto-", async (dir) => {
		writeManifest(manifest([entry("p1-explore-ax", "a")]), path.join(dir, "bench/archive"));
		let dispatched = 0;
		const lines: string[] = [];
		const code = await autopilot({
			go: true,
			date: DATE,
			outRoot: dir,
			dataDir: dir,
			log: (l) => lines.push(l),
			runPhaseFn: async () => (dispatched++, EXIT_OK),
			watchFn: async () => doneProgress,
			keyCheckFn: async () => {},
			fleetFn: async () => [{ name: "mac1", reachable: true, state: "idle" }],
		});
		assert.equal(code, EXIT_REFUSED);
		assert.equal(dispatched, 0);
		assert.ok(lines.some((l) => /live copy was wiped/.test(l)));
	});
});

test("watchPhase__StopsEarlyWithoutTouchingRuns__When__ProgressStallsPastTheBudget", async () => {
	// Seven archived job records sit in `running` forever (dead pid, record never updated) —
	// without this, a wedged run holds the phase for the full maxPolls ceiling. watchPhase
	// reads the production store, so use a date no pass will ever occupy: the empty manifest
	// makes every poll report the same "9 samples owed" line, which is exactly a stall.
	let polls = 0;
	const progress = await watchPhase({
		phase: 1,
		date: "2030-01-01",
		intervalSec: 15,
		stallPolls: 3,
		maxPolls: 50,
		log: () => {},
		collectFn: async () => {
			polls++;
		},
		sleepFn: async () => {},
	});
	assert.equal(progress.done, false);
	assert.ok(progress.outstanding > 0);
	assert.ok(polls <= 4, `stall must cut the watch short of maxPolls (polled ${polls}x)`);
});

test("driveToCompletion__SurfacesTheGate__When__RunPhaseRefuses", async () => {
	await withTempAsync("auto-", async (dir) => {
		const reason = await driveToCompletion(2, ctxFor(dir, { runPhaseFn: async () => EXIT_REFUSED }));
		assert.ok(reason && /refused dispatch/.test(reason), reason);
	});
});

test("pendingWork__CountsNoCompile__When__NoCleanSourceExists", async () => {
	// A compile arm with no viable source is BLOCKED, not pending — pendingWork saying
	// otherwise would make the wave loop treat a dead end as work forever.
	const m = manifest(
		phaseArms(3)
			.filter((a) => a.kind === "task")
			.flatMap((arm) => Array.from({ length: arm.n }, (_, i) => entry(arm.id, `${arm.id}-${i}`, { metrics: { success: false } }))),
	);
	assert.deepEqual(pendingWork(3, m, MODEL).compiles, []);
});

test("overRetryBudget__IgnoresHonestFailures__When__RunsFailedOnTheirMerits", () => {
	// Only TECHNICAL failures count against the budget: an agent that ran and gave up is a
	// measurement, and stopping the line on measurements would end every honest pass early.
	const m = manifest([
		entry("p2-ax-grounded", "a", { state: "failed", metrics: { success: false } }),
		entry("p2-ax-grounded", "b", { state: "failed", metrics: { success: false } }),
		entry("p2-ax-grounded", "c", { state: "failed", metrics: { success: false } }),
	]);
	assert.deepEqual(overRetryBudget(m, 2, MODEL, 2), []);
});

// --- promote stage ---

test("promoteForPhase6__FillsTheArm__When__AHarvestedCandidateExists", async () => {
	await withTempAsync("auto-", async (dir) => {
		const procDir = path.join(dir, "procs");
		const dataOut = path.join(dir, "out");
		// The judged-PASS grounded ax run, harvested into its own folder.
		const runDir = path.join(dataOut, "bench/live/run-1");
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(path.join(runDir, "procedure.md"), "route prose");

		const wanted = procedureFileFor(procDir, "yarn", CANONICAL_TASK, "ax", "grounded");
		const outcome = await promoteForPhase6({
			manifest: manifest([entry("p2-ax-grounded", "run-1")]),
			model: MODEL,
			dataOut,
			proceduresDir: procDir,
			promoteFn: async (stamp) => {
				// Stand-in for promoteProcedure: lineage/backend derive from the run log, which
				// for run-1 is (ax, grounded) — landing exactly the file the arm expects.
				assert.equal(stamp, "run-1");
				fs.mkdirSync(path.dirname(wanted), { recursive: true });
				fs.writeFileSync(wanted, "route prose");
			},
			log: () => {},
		});
		assert.deepEqual(outcome.promoted, ["run-1"]);
		// The other three arms (cdp, and both ungrounded lineages) have no candidates: blocked,
		// reported as findings — and phase 6 skips them rather than refusing outright.
		assert.equal(outcome.blocked.length, phaseArms(6).length - 1);
	});
});

test("promoteForPhase6__ReportsTheArmBlocked__When__NoSourceRunWasHarvested", async () => {
	await withTempAsync("auto-", async (dir) => {
		const outcome = await promoteForPhase6({
			manifest: manifest([]),
			model: MODEL,
			dataOut: path.join(dir, "out"),
			proceduresDir: path.join(dir, "procs"),
			promoteFn: async () => assert.fail("nothing to promote"),
			log: () => {},
		});
		assert.deepEqual(outcome.promoted, []);
		assert.equal(outcome.blocked.length, phaseArms(6).length);
	});
});

// --- the per-arm phase-6 gate (orchestrate) ---

test("runPhase__SkipsOnlyTheMissingArms__When__SomeProceduresArePromoted", async () => {
	// All-or-nothing held the runnable grounded arms hostage to the ungrounded lineage, which
	// is EXPECTED to be missing (a judged-PASS ungrounded run is rare by design).
	await withTempAsync("auto-", async (dir) => {
		const procDir = path.join(dir, "procs");
		for (const backend of ["ax", "cdp"]) {
			const f = procedureFileFor(procDir, "yarn", CANONICAL_TASK, backend, "grounded");
			fs.mkdirSync(path.dirname(f), { recursive: true });
			fs.writeFileSync(f, "prose");
		}
		const calls: string[] = [];
		let n = 0;
		const lines: string[] = [];
		const code = await runPhase(6, {
			go: true,
			date: DATE,
			outRoot: dir,
			proceduresDir: procDir,
			log: (l) => lines.push(l),
			dispatchFn: async (o) => {
				calls.push(String(o.task));

				return { ok: true as const, host: host("mac1"), jobId: `job-${++n}`, kind: "task" as const, app: "Yarn", artifacts: { log: "x" }, attempts: [] };
			},
		});
		assert.equal(code, EXIT_OK);
		const grounded = phaseArms(6).filter((a) => (a.dispatch.procedureLineage ?? "grounded") === "grounded");
		assert.equal(calls.length, grounded.reduce((s, a) => s + a.n, 0), "only the promoted arms dispatch");
		assert.ok(lines.some((l) => /SKIPPED/.test(l) && /from-ungrounded/.test(l)));
	});
});

test("runPhase__RefusesPhase6Outright__When__NoProcedureExistsAtAll", async () => {
	await withTempAsync("auto-", async (dir) => {
		const calls: string[] = [];
		const code = await runPhase(6, {
			go: true,
			date: DATE,
			outRoot: dir,
			proceduresDir: path.join(dir, "empty"),
			log: () => {},
			dispatchFn: async () => (calls.push("x"), { ok: false as const, error: "unreachable", attempts: [] }),
		});
		assert.equal(code, EXIT_REFUSED);
		assert.deepEqual(calls, []);
	});
});

// --- spend arithmetic ---

test("passSpend__PricesOnlyCollectedEntries__When__SomeAreStillInFlight", () => {
	const m = manifest([
		entry("p1-explore-ax", "a", { metrics: { inputTokens: 1_000_000, model: "claude-fable-5" } }),
		entry("p1-explore-ax", "b", { collected: false, state: "running", metrics: { inputTokens: 1_000_000, model: "claude-fable-5" } }),
	]);
	const one = passSpend(manifest([m.entries[0]]));
	assert.ok(one > 0);
	assert.equal(passSpend(m), one, "an uncollected entry's tokens are not yet real");
});

test("DEFAULT_PHASES__ExcludeOptionalAndFilmed__When__Unspecified", () => {
	// 4 is optional and 5 films with a different action space — both are opt-in via --phases.
	assert.deepEqual(DEFAULT_PHASES, [1, 2, 3, 6]);
});
