/**
 * `./run bench watch <phase> [--then <phase>] [--interval <sec>]` — the loop between phases.
 *
 * What was already automated, and why this is not that: `collect` pulls artifacts (which is
 * what triggers the appmap fan-out to the rest of the fleet — `autoSync` rides inside `pull`),
 * and the dashboard runs collect on a 60s timer. So results come home on their own.
 *
 * What nobody did was NOTICE. A phase finishing produced no event: an operator had to keep
 * asking `./run hosts` for two hours, and the session driving it had to poll — which on
 * 2026-08-01 is how five batches of 40-minute explores died, because a foreground follow hit a
 * caller's timeout and the cleanup took the runs with it. The fix is not a better poll, it is
 * one process whose whole job is waiting, holding no leash on anything.
 *
 * SAFETY. `--then` dispatches, so it is opt-in and it fires exactly one phase, once. Chaining
 * further would mean an unattended process spending the rest of the matrix on a judgement
 * nobody made — and phase 2 wants a human to read the phase-1 maps first (`controls: N
 * actuated / M dismissed / K seen` is the whole point of the frontier work). The next phase's
 * own gates still apply: it refuses if the maps it needs were not collected.
 *
 * A watcher dying must never touch the runs. Nothing here stops, kills or signals a job — it
 * reads the manifest, calls the idempotent collect, and waits.
 */
import { liveDir, outDir } from "../paths.js";
import { collect } from "./collect.js";
import { type Manifest, readManifest, submittedCount, utcDate } from "./manifest.js";
import { BENCH_PRIMARY_MODEL, type Phase, phaseArms } from "./matrix.js";

/** Terminal job states — the ones where waiting longer changes nothing. */
const TERMINAL = new Set(["done", "failed", "stopped", "orphaned"]);

export interface PhaseProgress {
	/** Samples the arms still owe, counting technical failures as owed (they get retried). */
	outstanding: number;
	/** Submitted and not yet terminal. */
	inFlight: number;
	done: boolean;
}

/**
 * Is this phase finished?
 *
 * Two conditions, and both matter. Nothing in flight is not enough — a technical failure frees
 * its sample slot (`submittedCount` skips it), so a phase can have zero running jobs and still
 * owe runs. And every arm having its samples is not enough while one is still executing.
 */
export function phaseProgress(phase: Phase, m: Manifest, model = BENCH_PRIMARY_MODEL): PhaseProgress {
	const ids = new Set(phaseArms(phase).map((a) => a.id));
	const inFlight = m.entries.filter((e) => ids.has(e.armId) && e.model === model && !TERMINAL.has(e.state)).length;
	const outstanding = phaseArms(phase).reduce((n, a) => n + Math.max(0, a.n - submittedCount(m, a.id, model)), 0);

	return { outstanding, inFlight, done: inFlight === 0 && outstanding === 0 };
}

export interface WatchOptions {
	phase: Phase;
	/** Dispatch this phase once the watched one completes. Opt-in; fires once, never chains. */
	then?: Phase;
	intervalSec?: number;
	date?: string;
	model?: string;
	log?: (s: string) => void;
	/** Injected by tests so the loop runs without a fleet, a clock, or a dispatch. */
	collectFn?: () => Promise<unknown>;
	runPhaseFn?: (phase: Phase) => Promise<number>;
	sleepFn?: (ms: number) => Promise<void>;
	/** Stop after this many polls regardless — a backstop against watching a wedged fleet forever. */
	maxPolls?: number;
	/**
	 * Stop early (returning not-done) when progress is unchanged for this many CONSECUTIVE
	 * polls. Off by default. Exists because a job record can wedge in `running` forever — the
	 * archive holds seven, the oldest days-stale — and the only other exit is maxPolls, which
	 * defaults to hours. Size it well above the longest legitimate quiet stretch: a full Yarn
	 * explore holds the same (inFlight, outstanding) line for ~40 minutes while it works.
	 */
	stallPolls?: number;
}

export async function watchPhase(opts: WatchOptions): Promise<PhaseProgress> {
	const log = opts.log ?? console.error;
	const date = opts.date ?? utcDate();
	const model = opts.model ?? BENCH_PRIMARY_MODEL;
	const intervalMs = Math.max(15, opts.intervalSec ?? 120) * 1000;
	const sleep = opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	// Collect is what brings artifacts home AND fans the appmaps out; the dash may be doing it
	// too, and that is fine — it is idempotent and the manifest write is atomic.
	// The default COLLECTS, which pulls from the fleet — so a test that forgets to inject one
	// would reach across ssh to real Macs mid-benchmark. Refusing under NODE_TEST_CONTEXT makes
	// that a failure instead of interference nobody would attribute to a test run.
	if (!opts.collectFn && process.env.NODE_TEST_CONTEXT)
		throw new Error("watchPhase: inject collectFn under test — the default pulls from the live fleet");
	const collectFn = opts.collectFn ?? (() => collect({ date }));
	const maxPolls = opts.maxPolls ?? Number.POSITIVE_INFINITY;

	let progress = phaseProgress(opts.phase, readManifest(date, liveDir(outDir())), model);
	let polls = 0;
	let last = "";
	let unchanged = 0;
	while (!progress.done && polls < maxPolls) {
		await sleep(intervalMs);
		polls++;
		try {
			await collectFn();
		} catch (e) {
			// A failed collect is a bad moment, not a bad run — one unreachable Mac must not end
			// the watch. The next poll tries again.
			log(`collect failed (retrying): ${(e as Error).message}`);
		}
		progress = phaseProgress(opts.phase, readManifest(date, liveDir(outDir())), model);
		const line = `phase ${opts.phase}: ${progress.inFlight} in flight, ${progress.outstanding} sample(s) still owed`;
		// Only on change: a two-hour watch at 120s is sixty identical lines otherwise.
		if (line !== last) log(line);
		unchanged = line === last ? unchanged + 1 : 0;
		last = line;
		if (opts.stallPolls !== undefined && unchanged >= opts.stallPolls) {
			log(`phase ${opts.phase}: no progress in ${opts.stallPolls} consecutive polls — a run is likely wedged. Stopping the watch, NOT the runs.`);
			break;
		}
	}

	if (!progress.done) {
		log(`phase ${opts.phase} still incomplete after ${polls} poll(s) — stopping the watch, NOT the runs`);

		return progress;
	}

	log(`phase ${opts.phase} complete.`);
	if (opts.then === undefined) return progress;

	// One phase, once. The gates inside runPhase still apply — it refuses if the maps this
	// phase needs were never collected.
	log(`dispatching phase ${opts.then} (--then), which fires once and does not chain further`);
	const runPhaseFn = opts.runPhaseFn ?? (async (p: Phase) => (await import("./orchestrate.js")).runPhase(p, { go: true, date, model }));
	const code = await runPhaseFn(opts.then);
	log(code === 0 ? `phase ${opts.then} dispatched` : `phase ${opts.then} refused (exit ${code}) — read the reason above`);

	return progress;
}
