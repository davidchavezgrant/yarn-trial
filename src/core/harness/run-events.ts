import fs from "node:fs";
import path from "node:path";
import { RUN_FILES, runPath } from "../../paths.js";

/**
 * The run's structured event log: `runEvent(stamp, kind, detail)` appends one JSON line
 * ({t: ISO, kind, detail}) to `<runDir>/events.jsonl`.
 *
 * This exists for the dashboard's Events feed. log.txt already records everything, but as
 * free text — a reader wanting "which runs verified their last step" would be regexing
 * console prose. The event log is the same lifecycle story at coarse grain (run start,
 * per-step verdicts, final verdict, cleanup, fatal errors — ~15-25 lines for an 8-action
 * run, never one per element) in a shape any reader can tail and merge across runs.
 *
 * Append-only and immutable once written, same philosophy as the narrator log: a reader
 * racing an append sees at worst one torn tail line, which every reader here skips.
 *
 * BEST-EFFORT BY CONTRACT. An event is a courtesy to the dashboard; the run it describes
 * is the thing that matters. A full disk, a bad data root, a permissions hiccup — none of
 * these may fail a step or abort a run, so every failure is swallowed after at most one
 * console warning per process (the first failure names itself; repeats are silent because
 * a dying disk would otherwise interleave a warning into every step of the run's real log).
 */
let appendWarned = false;

export function runEvent(stamp: string, kind: string, detail: Record<string, unknown> = {}): void {
	try {
		const file = runPath(stamp, RUN_FILES.events);
		// Defensive: every wired call site runs after the run dir was created, but the fatal
		// paths can fire before/after that guarantee and an event log must not depend on it.
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), kind, detail })}\n`);
	} catch (err) {
		if (!appendWarned) console.warn(`run-events: append failed (${err instanceof Error ? err.message : String(err)}) — further event-log failures are silent`);
		appendWarned = true;
	}
}
