/**
 * Quit the target app so acquisition relaunches it from scratch.
 *
 * EVERY RUN, not just exploration (David, 2026-08-01). It began as an explore-only
 * normalisation — wave 2 of a phase starts wherever wave 1 left the box, and the arms that
 * repeat to measure run-to-run variance would otherwise be measuring start-state variance
 * instead. But the stronger reason showed up when a pass wedged: a run clicked something that
 * opened a native Open panel, escaped it correctly, and Yarn never became observable again.
 * The pass died, and the app was left in that state for whatever ran on that Mac next.
 *
 * A kill is better than a navigate-home, and better than a reset:
 *
 * - It needs no map, so it behaves identically on every arm, including tiers whose map records
 *   no home at all (the vision-only and no-vision passes declare none — measured).
 * - It clears in-memory state no navigation reaches: open modals, native dialogs holding focus,
 *   scroll positions, undo stacks, half-filled fields.
 * - It recovers from the wedge above without anyone diagnosing it. The previous run's failure
 *   stops being the next run's starting condition.
 *
 * WHAT IT DOES NOT DO, and the distinction matters: relaunching does not undo a PERSISTED
 * change. A brand-wide cursor style the agent saved is still saved. Teardown owns that, and a
 * cold start is not a reason to weaken it — this clears transient dirt, teardown clears the
 * durable kind.
 *
 * APP TARGETS ONLY. On a web target the "app" is the profile Chrome that HOLDS the signed-in
 * session, and killing it between passes is how a grounding run becomes a sign-in run.
 */
import type { Target } from "./target.js";

/** `COLD_START=0` disables — for debugging a state you are trying to preserve. */
export const COLD_START_ON = process.env.COLD_START !== "0";

export async function coldStart(target: Target, app: string, log: (s: string) => void = console.log): Promise<void> {
	if (target.kind !== "app" || !COLD_START_ON) return;
	const { quitApp } = await import("./appctl.js");
	try {
		await quitApp(app);
		log(`cold start: quit "${app}" — acquisition relaunches it`);
	} catch (err) {
		// Non-fatal. An app that will not quit is a dirtier start, not a dead run, and refusing
		// to run over a normalisation nicety trades a small problem for a total one.
		log(`cold start: could not quit "${app}" (${err instanceof Error ? err.message.slice(0, 80) : err}) — starting from the state it is in`);
	}
}
