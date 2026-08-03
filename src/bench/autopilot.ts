import fs from "node:fs";
import path from "node:path";
import { archiveDir, dataRoot as dataRootDir, liveDir, outDir, recipesDir as recipesDirDefault, RUN_FILES, relToData, runFile } from "../paths.js";
import { appmapSlug } from "../core/target.js";
import { execSync } from "node:child_process";
import { poisonedHosts as poisonedHostsFn } from "./collect.js";
import { manifestCost, usd } from "./cost.js";
import type { BenchHarvestOutcome } from "./harvest.js";
import type { BenchJudgeOutcome } from "./judge.js";
import { entriesForArm, type Manifest, manifestPath, readManifest, utcDate } from "./manifest.js";
import { type Arm, BENCH_PRIMARY_MODEL, PHASES, STAGES, orderStages, type Phase, phaseArms, recipeArms, stageOf } from "./matrix.js";
import { EXIT_NEEDS_GO, EXIT_OK, EXIT_REFUSED, auditPhase, findCompileSource, interruptedPass, plannedRuns, runPhase } from "./orchestrate.js";
import { type PhaseProgress, phaseProgress, watchPhase } from "./watch.js";

/**
 * `./run bench autopilot [--phases all|1,2,3] [--go]` — the whole benchmark pass, hands off.
 *
 * Exists because the manual workflow (phase --go, poll hosts, collect, judge, harvest, promote,
 * next phase) is a two-day interactive relay with a dozen documented ways to fumble the baton,
 * and it kept being driven step-by-step from a chat session — which is exactly the caller whose
 * timeouts killed five batches of explores on 2026-08-01. This module is those steps as ONE
 * process an operator (or an agent) starts once and watches.
 *
 * David's HARD CONSTRAINT — no benchmark run fires without an explicit go — is intact: the
 * autopilot's own `--go` is that go, given once for the span it prints in preview. `bench watch`
 * once carried a `--then` that advanced one phase and deliberately refused to chain further,
 * because chaining was "a judgement nobody made"; invoking the autopilot IS that judgement, made
 * explicitly, so chaining lives here and `--then` is gone rather than sitting alongside as a
 * second, weaker way to do the same job.
 *
 * The gotchas it encodes, each one paid for before it got here:
 *  - UTC rollover: the date is pinned ONCE at launch and carried through every step. A pass
 *    that crosses midnight keeps one manifest; re-running after the 07-31→08-01 rollover
 *    re-dispatched three finished explores. Launching over an interrupted prior-day pass
 *    REFUSES with guidance instead of silently starting a parallel pass.
 *  - Dead judge key: the key-and-transport check runs BEFORE anything is dispatched. On
 *    2026-07-31 a preflight found the judge's OpenRouter key dead (401) — discovering that
 *    after the matrix has been spent means 62 runs nobody can grade.
 *  - Foreground follows: nothing here follows or holds a leash on any run. Dispatch is
 *    submit-and-exit (`bench phase`), waiting is `bench watch`'s poll+collect loop, and a dead
 *    autopilot never takes a run with it — re-running resumes from the manifest.
 *  - Technical failures: `submittedCount` frees the slot of a run that died producing nothing,
 *    so the next wave re-submits it automatically — but an arm whose runs KEEP dying is a
 *    harness/host problem, and more submissions are money down the same hole. The retry budget
 *    stops the line instead (default 2 technical failures per arm).
 *  - Phase 3/4 second waves: compiles need collected clean sources and replays need compiled
 *    procedures, so those phases legitimately take more than one dispatch→drain round. The wave
 *    loop re-runs the phase until nothing is pending — and a wave that changes NOTHING
 *    (blocked compile, refused source) is recorded as a finding and moved past, never spun on.
 *  - Judge before harvest, harvest before promote, promote before Reuse: the stage planner
 *    inserts them in that order automatically when Reuse is requested, off that stage's own
 *    `before` declaration rather than a phase number. A Reuse arm whose
 *    recipe cannot exist (no judged-PASS source run — likely for the ungrounded lineage) is
 *    reported as the finding it is; the runnable arms still run.
 *  - Spend: `--max-usd` is a hard ceiling checked before every dispatch wave, so an unattended
 *    pass cannot silently burn past what the operator meant to spend.
 *  - Sign-in refusals (exit 3, "unready"): 41 of 140 archived job records — 29%, the dominant
 *    failure mode — and a signed-out Mac does not heal itself, so the line stops on the FIRST
 *    new one with the exact signin command. Delta-based, so a resumed autopilot never stops on
 *    refusals the operator already fixed.
 *  - Poisoned hosts: `poisonedHosts()` (three consecutive same-kind failures on one Mac) had
 *    no consumer — it scrolled past as a collect warning while queued arms kept failing the
 *    same way. A NEW poison streak stops the line.
 *  - Wedged runs: seven archived job records sit in `running` forever (dead pid, record never
 *    updated). The watch aborts after `stallMinutes` (default 90) of flat progress instead of
 *    holding the phase for the full 8-hour ceiling.
 *  - Wiped live store: readManifest's live→archive fallback once made a purged pass report
 *    "0 submitted" — every arm looked done in the resurrected archive manifest. Refused at
 *    preflight with the restore-or-move-aside choice spelled out.
 *  - Mid-pass commits: each phase rsyncs the CURRENT checkout to the fleet, so a moved HEAD
 *    means phases ran different code. Warned loudly, not refused — parallel sessions commit
 *    here constantly, and only the operator knows whether the change touches the arms.
 *
 * What it deliberately does NOT do: `--force` past any gate (a refused gate stops the line —
 * gates are where measurement integrity lives), stop or kill runs, restart runners, or run
 * phase 5 unasked (filming changes the action space; cursor compositing after it is manual).
 */

export const DEFAULT_PHASES: Phase[] = STAGES.filter((s) => s.inCorePass).map((s) => s.n);

/** Per-phase drain backstop: 8 hours at the default 120s poll. */
const DEFAULT_MAX_POLLS = (intervalSec: number): number => Math.max(1, Math.ceil((8 * 3600) / intervalSec));

export type Stage = { kind: "phase"; phase: Phase } | { kind: "judge" } | { kind: "harvest" } | { kind: "promote" } | { kind: "final" };

export interface AutopilotOptions {
	phases?: Phase[];
	go?: boolean;
	model?: string;
	/** Pin the pass's manifest date. Defaults to today (UTC), fixed at launch — see rollover note. */
	date?: string;
	/** Pin every dispatch to one Mac (the sick-Mac case) — passed through to `runPhase`. */
	host?: string;
	intervalSec?: number;
	maxWaves?: number;
	maxTechnicalFailures?: number;
	maxPollsPerPhase?: number;
	/** Abort a phase's watch when progress is flat this long (default 90 — see watch.ts stallPolls). */
	stallMinutes?: number;
	/** Hard spend ceiling over the pass's collected entries; checked before every dispatch wave. */
	maxUsd?: number;
	outRoot?: string;
	dataDir?: string;
	recipesDir?: string;
	log?: (s: string) => void;
	/** Injected by tests. Production lazily loads the real implementations. */
	runPhaseFn?: (phase: Phase) => Promise<number>;
	watchFn?: (phase: Phase) => Promise<PhaseProgress>;
	collectFn?: () => Promise<{ reportPath?: string }>;
	judgeFn?: () => Promise<BenchJudgeOutcome>;
	harvestFn?: () => Promise<BenchHarvestOutcome>;
	promoteFn?: (stamp: string) => Promise<void>;
	fleetFn?: () => Promise<Array<{ name: string; reachable: boolean; state: string }>>;
	keyCheckFn?: () => Promise<void>;
}

/** Requested phases in execution order — topological over each stage's declared `needs`. */
export function orderedPhases(phases: Phase[]): Phase[] {
	return orderStages(phases);
}

/**
 * The stage list, in execution order. A stage's own `before` declares the workflow steps that
 * must precede it — Reuse asks for judge→harvest→promote, because harvest refuses unjudged runs
 * and the recipe gate refuses unpromoted ones.
 *
 * This used to be `if (p === 6)`. Moving it onto the stage means a future stage that needs the
 * same preparation gets it by saying so, rather than by someone editing this loop.
 */
export function planStages(phases: Phase[]): Stage[] {
	const stages: Stage[] = [];
	const done = new Set<string>();
	for (const p of orderedPhases(phases)) {
		// Each prep step runs once per pass, not once per stage that wants it.
		for (const step of stageOf(p)?.before ?? []) {
			if (done.has(step)) continue;
			done.add(step);
			stages.push({ kind: step });
		}
		stages.push({ kind: "phase", phase: p });
	}
	stages.push({ kind: "final" });

	return stages;
}

export const stageTitle = (s: Stage): string => (s.kind === "phase" ? `phase ${s.phase}` : s.kind);

/**
 * What a phase still owes: dispatchable runs (incl. deferred replays) plus compile arms that
 * have no procedure yet but DO have an untried clean source. A compile with no viable source is
 * not pending — it is blocked, and the wave loop's no-progress check is what names that.
 */
export interface PendingWork {
	runs: number;
	compiles: string[];
	total: number;
}

export function pendingWork(phase: Phase, m: Manifest, model?: string): PendingWork {
	const runs = plannedRuns(phase, m, model).length;
	const compiles = phaseArms(phase)
		.filter((a) => a.kind === "compile" && !entriesForArm(m, a.id, model).some((e) => e.procedure))
		.filter((a) => {
			const tried = new Set(entriesForArm(m, a.id, model).map((e) => e.jobId));

			return findCompileSource(m, a.sourceArm ?? "", tried, model) !== undefined;
		})
		.map((a) => a.id);

	return { runs, compiles, total: runs + compiles.length };
}

/**
 * Arms whose technical-failure count exceeds the budget — the stop-the-line condition.
 *
 * `unready` technicals are EXCLUDED: they are governed by the stop-on-unready guard below,
 * which fires on the first NEW one. Counting them here would refuse to resume forever — an
 * operator who signed the host in and re-ran the autopilot would trip the budget on failures
 * that are already fixed, while crashes/orphans genuinely do warrant a hard per-arm cap.
 */
export const overRetryBudget = (m: Manifest, phase: Phase, model: string | undefined, max: number): string[] =>
	phaseArms(phase)
		.filter((a) => entriesForArm(m, a.id, model).filter((e) => e.technical && e.technical.kind !== "unready").length > max)
		.map((a) => a.id);

/** This phase's unready (sign-in refused) entries, as `jobId on host` — for delta detection. */
export const unreadyRuns = (m: Manifest, phase: Phase, model?: string): string[] =>
	phaseArms(phase)
		.flatMap((a) => entriesForArm(m, a.id, model))
		.filter((e) => e.technical?.kind === "unready" || e.metrics?.failureKind === "unready")
		.map((e) => `${e.jobId} on ${e.host}`);

/** The pass's spend so far, off collected entries — same arithmetic as the report and truecost. */
export const passSpend = (m: Manifest): number => manifestCost(m.entries).usd;

/**
 * Progress fingerprint for one phase: entry count, procedures, collected. A full wave
 * (dispatch → drain → collect) that leaves this unchanged cannot be helped by another wave.
 */
const fingerprint = (m: Manifest, phase: Phase, model?: string): string => {
	const ids = new Set(phaseArms(phase).map((a) => a.id));
	const mine = m.entries.filter((e) => ids.has(e.armId) && e.model === model);

	return `${mine.length}:${mine.filter((e) => e.procedure).length}:${mine.filter((e) => e.collected).length}`;
};

export interface DriveContext {
	date: string;
	model: string;
	liveRoot: string;
	maxWaves: number;
	maxTechnicalFailures: number;
	maxUsd?: number;
	runPhaseFn: (p: Phase) => Promise<number>;
	watchFn: (p: Phase) => Promise<PhaseProgress>;
	log: (s: string) => void;
}

/**
 * Drive one phase to completion: dispatch, wait for the fleet to drain, re-dispatch what
 * technical failures and second-wave compiles/replays still owe, bounded by the wave budget.
 * Returns a stop reason, or undefined when the phase owes nothing more this pass.
 */
export async function driveToCompletion(phase: Phase, ctx: DriveContext): Promise<string | undefined> {
	for (let wave = 1; wave <= ctx.maxWaves; wave++) {
		let m = readManifest(ctx.date, ctx.liveRoot);

		const over = overRetryBudget(m, phase, ctx.model, ctx.maxTechnicalFailures);
		if (over.length)
			return (
				`arm(s) over the technical-failure retry budget (${ctx.maxTechnicalFailures}): ${over.join(", ")} — ` +
				`runs that keep dying before producing anything are a harness/host problem, not something more submissions fix. ` +
				`Check the host (./run provision --doctor), drop the dead runs if needed, then re-run the autopilot.`
			);
		if (ctx.maxUsd !== undefined && passSpend(m) > ctx.maxUsd)
			return `spend ceiling reached: ${usd(passSpend(m))} collected > --max-usd ${usd(ctx.maxUsd)} — nothing further dispatched`;

		const pending = pendingWork(phase, m, ctx.model);
		const progress = phaseProgress(phase, m, ctx.model);
		if (!pending.total && progress.done) {
			ctx.log(`phase ${phase}: complete — nothing owed`);

			return undefined;
		}

		const before = fingerprint(m, phase, ctx.model);
		// DELTA baselines, not absolutes: a resumed autopilot must not stop on failures the
		// operator already fixed, only on ones the wave it just ran ADDED.
		const unreadyBefore = new Set(unreadyRuns(m, phase, ctx.model));
		const poisonBefore = new Set(poisonedHostsFn(m));
		ctx.log(`phase ${phase}, wave ${wave}/${ctx.maxWaves}: ${pending.runs} run(s) to submit${pending.compiles.length ? `, ${pending.compiles.length} compile(s)` : ""}`);
		const code = await ctx.runPhaseFn(phase);
		if (code === EXIT_REFUSED)
			return `phase ${phase} refused dispatch — the gate's own message above says why. Fix it and re-run the autopilot; it resumes from the manifest.`;

		const drained = await ctx.watchFn(phase);
		if (!drained.done)
			return `phase ${phase}: the watch gave up with ${drained.inFlight} in flight and ${drained.outstanding} owed — a wedged run or fleet, most likely. No run was touched; check ./run hosts and re-run the autopilot.`;

		m = readManifest(ctx.date, ctx.liveRoot);

		// Sign-in refusals stop the line on the FIRST new one: a signed-out Mac does not heal
		// itself, and this was the dominant archived failure mode (41 of 140 job records).
		// Unattended retries against it are pure spend.
		const newUnready = unreadyRuns(m, phase, ctx.model).filter((r) => !unreadyBefore.has(r));
		if (newUnready.length) {
			const hosts = [...new Set(newUnready.map((r) => r.split(" on ")[1]))];

			return (
				`run(s) refused at the home-state gate this wave (${newUnready.join("; ")}) — the app is not signed in / not at home there. ` +
				`Sign it in (${hosts.map((h) => `./run signin ${h}`).join(" or ")}, or ./run liveview <mac>), then re-run the autopilot; the freed slots re-submit.`
			);
		}

		// A poisoned host (three consecutive same-kind failures) is consuming queued arms.
		// poisonedHosts() has always computed this; nothing consumed it until now.
		const newPoison = poisonedHostsFn(m).filter((w) => !poisonBefore.has(w));
		if (newPoison.length) return newPoison.join("\n");

		const still = pendingWork(phase, m, ctx.model);
		if (!still.total) {
			ctx.log(`phase ${phase}: complete after wave ${wave}`);

			return undefined;
		}
		if (fingerprint(m, phase, ctx.model) === before) {
			// A whole wave moved nothing. Dispatch refusals returned EXIT_REFUSED above, so what
			// remains is work this pass cannot unblock — a compile whose every source run failed
			// on its merits, and the replays behind it. Those refusals are phase-3 findings, not
			// autopilot errors; spinning more waves on them would change nothing.
			ctx.log(`phase ${phase}: ${still.runs} run(s)/${still.compiles.length} compile(s) cannot progress this pass (no clean source run) — recorded as findings, moving on`);

			return undefined;
		}
	}

	return `phase ${phase} still owes work after ${ctx.maxWaves} waves — raise --max-waves if this is genuine second-wave churn, or read the collect notes for what keeps failing`;
}

/** One Reuse arm's promote state: the file it needs, and the harvested candidates that could fill it. */
export interface PromoteOutcome {
	promoted: string[];
	/** Arm ids Reuse will skip — no promotable recipe exists. A finding, not an error. */
	blocked: string[];
}

/**
 * Promote harvested recipes until every Reuse arm's expected file exists, or its
 * candidates run out. Promotion derives lineage/backend from the run log itself (never from the
 * arm), so a candidate is verified by re-checking the expected path after each promote — a
 * grounded-lineage file cannot satisfy an ungrounded arm by construction.
 */
export async function promoteForReuse(opts: {
	manifest: Manifest;
	model?: string;
	dataOut: string;
	recipesDir: string;
	promoteFn: (stamp: string) => Promise<void>;
	log: (s: string) => void;
}): Promise<PromoteOutcome> {
	const { recipeFileFor } = await import("../core/recipe.js");
	const outcome: PromoteOutcome = { promoted: [], blocked: [] };

	/**
	 * One promotion per recipe FILE, not per arm.
	 *
	 * Several arms share a slot — a filmed twin wants the same (app, task, backend, lineage)
	 * recipe as the arm it films, and the Claude cell wants the same one its Sol twin does.
	 * Iterating arms promoted the identical file up to three times and, worse, reported one
	 * missing recipe as three blocked arms. Deduping on the path the loop already computes
	 * fixes both, and the representative is the arm that can actually fill it: an arm with no
	 * `sourceArm` has no candidate run to harvest from and would report the slot unfillable
	 * while its twin sat there able to fill it.
	 */
	const slots = new Map<string, Arm>();
	for (const arm of recipeArms()) {
		/**
		 * `appmapSlug`, never `appSlug` — this slot key must be the filename the RUN will read, or
		 * promote fills a slot no run ever opens.
		 *
		 * The reader derives its slug with `targetSlug` (src/core/target.ts): `web-<host>` for a web
		 * target, `appSlug(name)` for a Mac app. `appSlug` (src/paths.ts) folds only
		 * whitespace/slashes/colons, so a web arm's URL becomes `https-app.notion.com` — a name the
		 * gate and promote agreed on and the run never looked for, leaving the arm on the appmap
		 * tier under a recipe label. `appmapSlug` routes a URL to the first and a name to the second,
		 * and `promoteRecipe` (core/recipe-cli.ts) derives its destination the same way, so the two
		 * halves of this stage cannot drift from each other or from the run.
		 */
		const key = recipeFileFor(opts.recipesDir, appmapSlug(arm.app), arm.task ?? "", arm.dispatch.backend, arm.dispatch.recipeLineage ?? "grounded");
		const held = slots.get(key);
		if (!held || (!held.sourceArm && arm.sourceArm)) slots.set(key, arm);
	}

	for (const [wanted, arm] of slots) {
		if (fs.existsSync(wanted)) {
			opts.log(`… ${arm.id}: recipe already promoted (${relToData(wanted)})`);
			continue;
		}

		const candidates = entriesForArm(opts.manifest, arm.sourceArm ?? "", opts.model).filter((e) =>
			fs.existsSync(runFile(e.jobId, RUN_FILES.recipe, opts.dataOut)),
		);
		let filled = false;
		for (const c of candidates) {
			try {
				await opts.promoteFn(c.jobId);
			} catch (e) {
				opts.log(`✗ ${arm.id}: promoting ${c.jobId} failed — ${(e as Error).message}`);
				continue;
			}
			if (fs.existsSync(wanted)) {
				outcome.promoted.push(c.jobId);
				opts.log(`✓ ${arm.id}: promoted ${c.jobId}`);
				filled = true;
				break;
			}
			// The promote landed a real file under a different lineage/backend key — someone
			// else's arm may want it, but this one keeps looking.
		}
		if (!filled) {
			outcome.blocked.push(arm.id);
			opts.log(`– ${arm.id}: no promotable recipe from ${arm.sourceArm} — Reuse skips this arm. That refusal is a finding (see harvest's refused list for why each source run declined).`);
		}
	}

	return outcome;
}

export async function autopilot(opts: AutopilotOptions = {}): Promise<number> {
	const log = opts.log ?? console.log;
	const model = opts.model ?? BENCH_PRIMARY_MODEL;
	const date = opts.date ?? utcDate();
	const outRoot = opts.outRoot ?? outDir();
	const liveRoot = liveDir(outRoot);
	const dataOut = path.join(opts.dataDir ?? dataRootDir(), "out");
	const procDir = opts.recipesDir ?? recipesDirDefault();
	const intervalSec = Math.max(15, opts.intervalSec ?? 120);
	const phases = orderedPhases(opts.phases ?? DEFAULT_PHASES);
	if (!phases.length) {
		log(`no valid phases requested — --phases wants a comma list from ${PHASES.join(", ")}`);

		return EXIT_REFUSED;
	}
	const stages = planStages(phases);

	const describePhase = (p: Phase): string => {
		const m = readManifest(date, liveRoot);
		const prog = phaseProgress(p, m, model);
		const pending = pendingWork(p, m, model);

		return `phase ${p}: ${pending.runs} run(s) to submit${pending.compiles.length ? ` + ${pending.compiles.length} compile(s)` : ""}, ${prog.inFlight} in flight${prog.done && !pending.total ? " — already complete" : ""}`;
	};

	if (!opts.go) {
		log(`bench autopilot — plan only, nothing dispatched (add --go to run it)`);
		log(`pass: date ${date}, model ${model}${opts.host ? `, pinned to ${opts.host}` : ""}`);
		log(`stages: ${stages.map(stageTitle).join(" → ")}`);
		for (const p of phases) log(`  ${describePhase(p)}`);
		const spend = passSpend(readManifest(date, liveRoot));
		log(`spend so far this pass: ${usd(spend)}${opts.maxUsd !== undefined ? ` (ceiling ${usd(opts.maxUsd)})` : " (no ceiling — set --max-usd for unattended runs)"}`);
		if (phases.some((p) => stageOf(p)?.kind === "deliverable")) log(`NOTE: this pass films takes; cursor compositing stays manual afterwards (npm run humanize -- <stamp>).`);
		log(`Safe to Ctrl-C at any point once running — it holds no leash on runs, and re-running resumes from the manifest.`);

		return EXIT_NEEDS_GO;
	}

	// --- preflight: every check here is cheaper than the first run it would have wasted ---
	const hinted = phases.flatMap((p) => auditPhase(p));
	if (hinted.length) {
		log(`REFUSED: hinted task prompt(s) in the matrix — the task text is the measurement:`);
		for (const h of hinted) log(`  ${h}`);

		return EXIT_REFUSED;
	}

	if (!opts.date) {
		const prior = interruptedPass(date, outRoot);
		if (prior) {
			log(`REFUSED: today's manifest (${date}) is empty but ${prior.date} holds ${prior.entries} entr(ies) — the UTC date rolled over mid-pass.`);
			log(`Continue that pass:   ./run bench autopilot --date ${prior.date} --go`);
			log(`Start a new one:      ./run bench autopilot --date ${date} --go`);

			return EXIT_REFUSED;
		}
	}

	// readManifest falls back live → archive, which is right for reading a finished pass and a
	// trap for the submit path: after a `runs purge`, re-firing read the ARCHIVED manifest,
	// concluded all nine arms were done, and submitted nothing. If the pass is readable but its
	// live file is gone, neither resuming nor restarting does what the operator thinks.
	if (!fs.existsSync(manifestPath(date, liveDir(outRoot))) && readManifest(date, archiveDir(outRoot)).entries.length) {
		log(`REFUSED: the ${date} manifest is readable only from a backup — the live copy was wiped.`);
		log(`To resume that pass, restore it:  cp ${manifestPath(date, archiveDir(outRoot))} ${manifestPath(date, liveDir(outRoot))}`);
		log(`To restart from scratch, move the archived manifest aside first — the fallback chain resurrects it otherwise.`);

		return EXIT_REFUSED;
	}

	const keyCheck =
		opts.keyCheckFn ??
		(async () => {
			// A real one-token call, not a presence check: the 2026-07-31 near-miss was a key
			// that EXISTED and was dead (401). Costs a fraction of a cent; catches the failure
			// that would otherwise surface after the whole matrix is spent unjudgeable.
			const [{ makeClient }, { BENCH_JUDGE_MODEL }] = await Promise.all([import("../core/harness.js"), import("./judge.js")]);
			const { client, model: judgeModel } = makeClient(process.env.JUDGE_MODEL ?? BENCH_JUDGE_MODEL);
			await client.messages.create({ model: judgeModel, max_tokens: 1, messages: [{ role: "user", content: "ping" }] });
		});
	try {
		await keyCheck();
		log(`preflight: judge model key OK`);
	} catch (e) {
		log(`REFUSED: the judge/harvest model is unreachable from this machine — ${(e as Error).message}`);
		log(`Fix the key first: grading after the runs are spent is not optional (judge.ts, 2026-07-31).`);

		return EXIT_REFUSED;
	}

	const fleetFn =
		opts.fleetFn ??
		(async () => {
			const { fleetStatus } = await import("../remote/control/fleet.js");

			return fleetStatus();
		});
	try {
		const rows = await fleetFn();
		const reachable = rows.filter((r) => r.reachable);
		log(`preflight: fleet ${rows.map((r) => `${r.name}:${r.reachable ? r.state : "UNREACHABLE"}`).join(" ")}`);
		if (!reachable.length) {
			log(`REFUSED: no fleet host is reachable — nothing to dispatch to. ./run provision --doctor`);

			return EXIT_REFUSED;
		}
	} catch (e) {
		log(`REFUSED: fleet status failed — ${(e as Error).message}`);

		return EXIT_REFUSED;
	}

	const ctx: DriveContext = {
		date,
		model,
		liveRoot,
		maxWaves: opts.maxWaves ?? 4,
		maxTechnicalFailures: opts.maxTechnicalFailures ?? 2,
		...(opts.maxUsd !== undefined ? { maxUsd: opts.maxUsd } : {}),
		runPhaseFn: opts.runPhaseFn ?? ((p: Phase) => runPhase(p, { go: true, model, date, outRoot, ...(opts.host ? { host: opts.host } : {}) })),
		watchFn:
			opts.watchFn ??
			((p: Phase) =>
				watchPhase({
					phase: p,
					date,
					model,
					intervalSec,
					maxPolls: opts.maxPollsPerPhase ?? DEFAULT_MAX_POLLS(intervalSec),
					stallPolls: Math.max(1, Math.ceil(((opts.stallMinutes ?? 90) * 60) / intervalSec)),
					log,
				})),
		log,
	};
	const judgeFn =
		opts.judgeFn ??
		(async () => {
			const { judgeBench } = await import("./judge.js");

			return judgeBench({ date, log });
		});
	const harvestFn =
		opts.harvestFn ??
		(async () => {
			const { harvestBench } = await import("./harvest.js");

			return harvestBench({ date, log });
		});
	const promoteFn =
		opts.promoteFn ??
		(async (stamp: string) => {
			const { promoteRecipe } = await import("../core/recipe-cli.js");
			promoteRecipe(stamp, { log });
		});
	const collectFn =
		opts.collectFn ??
		(async () => {
			const { collect } = await import("./collect.js");

			return collect({ date });
		});

	const started = Date.now();
	const elapsed = (): string => `${Math.round((Date.now() - started) / 60000)}m`;
	const stop = (stage: Stage, reason: string): number => {
		log(`\nAUTOPILOT STOPPED at ${stageTitle(stage)} (+${elapsed()}): ${reason}`);
		log(`Everything submitted so far keeps running and lands via collect. Re-running the autopilot resumes from the manifest.`);

		return EXIT_REFUSED;
	};

	// Comparability watch, not a gate: 39 commits once landed inside the 4-hour window that
	// produced every phase-1 number, and parallel sessions commit constantly here — refusing
	// would make the autopilot unusable, but each phase syncs the CURRENT checkout to the
	// fleet, so a moved HEAD means later arms run different code than earlier ones.
	const headSha = (): string | undefined => {
		try {
			return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
		} catch {
			return undefined;
		}
	};
	let lastHead = headSha();

	log(`bench autopilot: date ${date}, model ${model}, stages ${stages.map(stageTitle).join(" → ")}`);
	let phase6Blocked: string[] = [];
	for (const stage of stages) {
		log(`\n── ${stageTitle(stage)} (+${elapsed()}) ──`);

		if (stage.kind === "phase") {
			const head = headSha();
			if (head && lastHead && head !== lastHead)
				log(`⚠ HEAD moved since the last phase (${lastHead.slice(0, 7)} → ${head.slice(0, 7)}) — this phase's runs will execute DIFFERENT code than the previous phase's. Comparability across phases is now on you.`);
			lastHead = head ?? lastHead;
			if (recipeArms(stage.phase).length > 0 && phase6Blocked.length === recipeArms(stage.phase).length) {
				log(`the Reuse recipe half is skipped entirely: no arm has a promoted recipe. That is the finding — no judged-PASS source run produced one (the likely case for the ungrounded lineage; see harvest's refusals).`);
				continue;
			}
			if (stageOf(stage.phase)?.kind === "deliverable") log(`filmed pass — cursor compositing stays manual afterwards: npm run humanize -- <stamp>`);
			const reason = await driveToCompletion(stage.phase, ctx);
			if (reason) return stop(stage, reason);
			log(`spend so far: ${usd(passSpend(readManifest(date, liveRoot)))}`);
		}

		if (stage.kind === "judge") {
			let outcome = await judgeFn();
			if (outcome.failed.length) {
				// Idempotent: the second call re-attempts only what failed. One retry — a judge
				// that fails twice is an outage, and harvest's own gate reports the unjudged runs.
				log(`judge: retrying ${outcome.failed.length} failure(s) once`);
				outcome = await judgeFn();
			}
			log(`judge: ${outcome.judged.length} judged, ${outcome.skipped.length} already done, ${outcome.failed.length} failed`);
		}

		if (stage.kind === "harvest") {
			const outcome = await harvestFn();
			log(`harvest: ${outcome.harvested.length} harvested, ${outcome.refused.length} refused (refusals are findings), ${outcome.failed.length} failed`);
		}

		if (stage.kind === "promote") {
			const outcome = await promoteForReuse({ manifest: readManifest(date, liveRoot), model, dataOut, recipesDir: procDir, promoteFn, log });
			phase6Blocked = outcome.blocked;
		}

		if (stage.kind === "final") {
			// Final judge sweep catches runs that landed after the pre-Reuse pass (stages 3/4/5
			// themselves); then one collect rewrites the report with everything included.
			if (phases.some((p) => p !== 1)) {
				const outcome = await judgeFn();
				log(`final judge sweep: ${outcome.judged.length} judged, ${outcome.failed.length} failed`);
			}
			const collected = await collectFn();
			const m = readManifest(date, liveRoot);
			log(`\nautopilot complete (+${elapsed()}). Spend: ${usd(passSpend(m))}.`);
			for (const p of phases) log(`  ${describePhase(p)}`);
			if (phase6Blocked.length && phase6Blocked.length < recipeArms().length) log(`  reuse ran without: ${phase6Blocked.join(", ")} (no promotable recipe — a finding)`);
			if (collected.reportPath) log(`report: ${collected.reportPath}`);
			if (phases.some((p) => stageOf(p)?.kind === "deliverable")) log(`filmed stamps need manual compositing: npm run humanize -- <stamp>`);
			if (process.env.ANTHROPIC_ADMIN_KEY) log(`reconcile against Anthropic's accounting: ./run bench truecost`);
		}
	}

	return EXIT_OK;
}
