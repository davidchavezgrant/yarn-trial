import fs from "node:fs";
import path from "node:path";

/**
 * Write the trajectory feed for a recording without cua's `start_recording`.
 *
 * The driver's recorder produces `trajectory/turn-NNNNN/action.json` plus before/after
 * captures per action — the click-point + timestamp feed Yarn's cursor renderer wants, and
 * the exact shape `readTrajectory()` in src/cursor/track.ts consumes. On the CDP backend there is
 * no driver, but every field of that feed is already in the harness's hands: the action,
 * its target's rect (the click lands at its centre — playwright clicks element centres),
 * real dispatch/completion instants, and the per-step observation screenshots.
 *
 * Emitted at act time rather than reconstructed from StepRecords afterwards, because the
 * step record's one timestamp is taken after act + settle + re-observe — the dispatch
 * instant it would reconstruct is exactly the number the motion pass cares most about.
 *
 * Coordinate note, and why this is SIMPLER than the driver's feed: cdp screenshots and
 * snapshot boxes share one CSS-pixel space (scale:"css" — see src/backends/cdp.ts), so click points,
 * before.png and the polled frames all agree and `toFramePixels`' capture-width scaling
 * degenerates to 1:1. The driver path needs that scaling because its captures are
 * native-resolution windows.
 */

export interface TrajectoryTurnInput {
	tool: string;
	args: Record<string, unknown>;
	/** Where the pointer acted, in the same CSS pixels as before.png. Omit for keyboard-only. */
	clickPoint?: { x: number; y: number };
	startedAtMs: number;
	endedAtMs: number;
	/** Pre-/post-action observation screenshots; copied in, missing files tolerated. */
	beforePng?: string;
	afterPng?: string;
	resultSummary?: string;
}

export class TrajectoryWriter {
	private turnIndex = 0;

	/** Mirrors the driver's session clock: t_*_ms fields are relative to this. */
	private readonly sessionStartMs = Date.now();

	constructor(private readonly dir: string) {
		fs.mkdirSync(dir, { recursive: true });
	}

	record(t: TrajectoryTurnInput): void {
		const turnDir = path.join(this.dir, `turn-${String(++this.turnIndex).padStart(5, "0")}`);
		fs.mkdirSync(turnDir, { recursive: true });
		fs.writeFileSync(
			path.join(turnDir, "action.json"),
			JSON.stringify(
				{
					tool: t.tool,
					arguments: t.args,
					...(t.clickPoint ? { click_point: { x: t.clickPoint.x, y: t.clickPoint.y } } : {}),
					t_start_ms_from_session_start: Math.max(0, t.startedAtMs - this.sessionStartMs),
					t_ms_from_session_start: Math.max(0, t.endedAtMs - this.sessionStartMs),
					// Seconds as a string, at COMPLETION — matching the driver's field exactly:
					// readTrajectory derives dispatch as epochMs - (endMs - startMs).
					timestamp: (t.endedAtMs / 1000).toFixed(3),
					...(t.resultSummary ? { result_summary: t.resultSummary } : {}),
				},
				null,
				2,
			),
		);
		// Copies, not links: OUT/agent-step-N.png is overwritten by the next run with the
		// same step numbers, and the trajectory must outlive it.
		for (const [name, src] of [
			["before.png", t.beforePng],
			["after.png", t.afterPng],
		] as const) {
			if (!src) continue;
			try {
				fs.copyFileSync(src, path.join(turnDir, name));
			} catch {
				// A missed frame degrades the change-box channel, same posture as observe().
			}
		}
	}
}
