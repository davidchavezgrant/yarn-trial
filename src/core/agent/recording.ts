import fs from "node:fs";
import type { CdpBackend } from "../../backends/cdp.js";
import type { Driver } from "../driver.js";
import { stageWindowForRecording, type WindowRef } from "../harness.js";
import type { Overlay } from "../overlay.js";
import { TrajectoryWriter } from "../trajectory.js";
import { assembleVideo, pngSize } from "./video.js";

/** Frame-loop cadence right after an action, while the app is repainting. */
const RESPONSE_POLL_MS = 120;
/** ...and between actions, where the screen is static and extra frames are duplicates. */
const IDLE_POLL_MS = 400;
/** How long after an action counts as "responding". */
const RESPONSE_WINDOW_MS = 4000;

/** Window-size probes that must agree before recording starts, and the ceiling on waiting. */
const STAGE_SETTLE_HITS = 3;
const STAGE_SETTLE_MAX_MS = 12_000;

/**
 * The driver mutex, shared between the step loop and the recording frame loop: the frame
 * poller skips a capture while an action/observation holds the driver, and samples densely
 * for a moment after each action.
 */
export interface DriverSync {
	busy: boolean;
	/** When an action last finished, so the frame loop can sample its response densely. */
	lastActionAt: number;
}

export interface Recording {
	active: boolean;
	frameTimes: number[];
	frameDrops: string[];
	frameLoop?: Promise<void>;
	// CDP recordings write their own trajectory feed (no driver recorder to do it) — same
	// turn-NNNNN/action.json shape, so humanize/track read both backends' recordings alike.
	trajectory?: TrajectoryWriter;
}

export function newRecording(): Recording {
	return { active: false, frameTimes: [], frameDrops: [] };
}

/**
 * Start the frame poller (and, on the driver path, stage the window first). Returns the
 * window geometry recorded during staging, when there was any — the run log wants it for a
 * post-pass reconciling driver coordinates against the captured frames.
 */
export async function startRecording(opts: {
	cdp: CdpBackend | undefined;
	driver: Driver | undefined;
	win: WindowRef | undefined;
	app: string;
	overlay: Overlay;
	recordingDir: string;
	framesDir: string;
	rec: Recording;
	sync: DriverSync;
}): Promise<Record<string, unknown> | undefined> {
	const { cdp, driver, win, app, overlay, recordingDir, framesDir, rec, sync } = opts;
	let windowGeometry: Record<string, unknown> | undefined;
	if (cdp) {
		// No staging and no settle dance: the recording surface is the page viewport,
		// which playwright screenshots at CSS scale regardless of what covers the window —
		// the same occlusion-proof property the window-snapshot path has, and a viewport
		// does not resize when nobody resizes it. The trajectory feed is written by the
		// harness itself (TrajectoryWriter) since there is no driver recorder here.
		fs.mkdirSync(framesDir, { recursive: true });
		rec.active = true;
		rec.trajectory = new TrajectoryWriter(`${recordingDir}/trajectory`);
		fs.writeFileSync(`${recordingDir}/recording-started.json`, JSON.stringify({ epochMs: Date.now() }));
		rec.frameLoop = (async () => {
			while (rec.active) {
				// No mutex here, unlike the driver path below: there is no shared driver to
				// contend for, and playwright serializes CDP commands per connection anyway.
				// Capturing DURING an act is the point — the only frames that can show a
				// half-typed field or a hover dwell are the ones taken while the act still
				// holds sync.busy. (Demo typing is one pressSequentially call; skipping busy
				// windows here would put the atomic "text dump" right back on film.)
				const framePath = `${framesDir}/f-${String(rec.frameTimes.length).padStart(5, "0")}.png`;
				try {
					await cdp!.screenshot(framePath);
					rec.frameTimes.push(Date.now());
				} catch (err) {
					rec.frameDrops.push(`error: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
					fs.rmSync(framePath, { force: true });
				}
				// `sync.busy` counts as "responding": an act in flight is exactly when dense
				// sampling pays, and lastActionAt only advances at act COMPLETION, so a long
				// typing act would otherwise decay the cadence to the idle rate mid-word.
				const sinceAction = Date.now() - sync.lastActionAt;
				await new Promise((r) => setTimeout(r, sync.busy || sinceAction < RESPONSE_WINDOW_MS ? RESPONSE_POLL_MS : IDLE_POLL_MS));
			}
		})();
		console.log(`recording viewport frames -> ${framesDir}\n`);
	} else {
		// Staging raises the window and resizes it to fill the display — as intrusive as
		// any click, and the one moment an operator is most likely to reach for the mouse.
		overlay.setDriving(true);
		try {
			const stage = stageWindowForRecording(app);
			console.log(`recording stage: ${stage.detail}`);
			windowGeometry = { ...(win!.bounds ? { bounds: win!.bounds } : {}), ...(stage.geometry ? { staged: stage.geometry } : {}) };
			await new Promise((r) => setTimeout(r, 1500));
		} catch {
			console.log("could not stage window for recording; recording may be degraded");
		} finally {
			overlay.setDriving(false);
		}
		fs.mkdirSync(framesDir, { recursive: true });
		/**
		 * Wait for the window to hold one size before recording anything.
		 *
		 * Staging resizes the window, and the capture surface follows some time later. Starting
		 * immediately produced 25 opening frames at the wrong size on one run — and worse, at
		 * the wrong ASPECT RATIO, so they were not merely mis-shaped but showed the previous
		 * run's screen. Everything downstream then had to detect and discard them.
		 */
		const settleStart = Date.now();
		let lastSize = "";
		let stable = 0;
		while (Date.now() - settleStart < STAGE_SETTLE_MAX_MS && stable < STAGE_SETTLE_HITS) {
			const probe = `${framesDir}/.settle.png`;
			try {
				await driver!.act({
					kind: "tool",
					name: "get_window_state",
					args: { pid: win!.pid, window_id: win!.windowId, screenshot_out_file: probe },
				});
				const s = pngSize(probe);
				const key = `${s.w}x${s.h}`;
				stable = key === lastSize ? stable + 1 : 0;
				lastSize = key;
			} catch {
				stable = 0;
			}
			await new Promise((r) => setTimeout(r, 300));
		}
		fs.rmSync(`${framesDir}/.settle.png`, { force: true });
		console.log(
			stable >= STAGE_SETTLE_HITS
				? `window settled at ${lastSize} after ${((Date.now() - settleStart) / 1000).toFixed(1)}s`
				: `window never settled (last ${lastSize || "unknown"}); recording anyway`,
		);
		await driver!.act({ kind: "tool", name: "start_recording", args: { output_dir: `${recordingDir}/trajectory` } });
		rec.active = true;
		// Record the run, not the setup. start_recording backfills turns from earlier in the
		// driver session — the home reset's own clicks land in trajectory/ as turn-00001 and
		// friends, and the humanize pass then animates a cursor navigating out of wherever the
		// last run finished, before the task has begun. Marked here rather than filtered later
		// so the artifact says which turns predate the take.
		fs.writeFileSync(`${recordingDir}/recording-started.json`, JSON.stringify({ epochMs: Date.now() }));
		rec.frameLoop = (async () => {
			while (rec.active) {
				if (!sync.busy) {
					sync.busy = true;
					const framePath = `${framesDir}/f-${String(rec.frameTimes.length).padStart(5, "0")}.png`;
					try {
						// Capture everything; malformed frames are filtered at assembly by
						// majority vote on frame size (self-consistent — no external reference
						// that can go stale when the window resizes or the AX tree goes dark).
						await driver!.act({
							kind: "tool",
							name: "get_window_state",
							args: { pid: win!.pid, window_id: win!.windowId, screenshot_out_file: framePath },
						});
						// The driver reports success but writes no file when the window is
						// not composited — the same gap observe() guards. Pushing a timestamp
						// for a frame that never landed shifts every later frame's duration,
						// since assembly pairs times to files positionally.
						if (fs.existsSync(framePath)) rec.frameTimes.push(Date.now());
						else rec.frameDrops.push("driver reported success but wrote no frame");
					} catch (err) {
						rec.frameDrops.push(`error: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
						fs.rmSync(framePath, { force: true });
					} finally {
						sync.busy = false;
					}
				}
				/**
				 * Poll fast for a moment after each action, slowly otherwise.
				 *
				 * The app's response is the only part of a run worth watching frame by frame,
				 * and it arrives within a second or two. At a flat 250ms — which the driver
				 * stretches to about a second in practice — a repaint could fall entirely
				 * between two captures: one run's Screen Clips click took 2.1s to render with
				 * no frame in between, so the video jumped from before to after with nothing
				 * showing the transition. Between actions the screen is static and extra
				 * frames are pure duplicates, so the slow rate costs nothing there.
				 */
				const sinceAction = Date.now() - sync.lastActionAt;
				await new Promise((r) => setTimeout(r, sinceAction < RESPONSE_WINDOW_MS ? RESPONSE_POLL_MS : IDLE_POLL_MS));
			}
		})();
		console.log(`recording window-scoped frames -> ${framesDir}\n`);
	}

	return windowGeometry;
}

/** Stop the frame poller, report drops, stop the driver recorder, and assemble the mp4. */
export async function finishRecording(opts: {
	rec: Recording;
	driver: Driver | undefined;
	framesDir: string;
	videoPath: string;
}): Promise<void> {
	const { rec, driver, framesDir, videoPath } = opts;
	rec.active = false;
	// The loop's own try/catch absorbs capture errors; anything that still escapes
	// must not take the assembly and the log write below with it.
	await rec.frameLoop?.catch((err) => console.error("frame loop failed:", err));
	if (rec.frameDrops.length > 0) {
		const counts = new Map<string, number>();
		for (const d of rec.frameDrops) counts.set(d, (counts.get(d) ?? 0) + 1);
		for (const [reason, n] of counts) console.log(`frame drops x${n}: ${reason}`);
	}
	try {
		await driver?.act({ kind: "tool", name: "stop_recording", args: {} });
	} catch {}
	// Before assembly, so a failed encode still leaves usable timing. These are the only
	// record of WHEN each frame was captured: list.txt clamps every gap to five seconds,
	// which erases exactly the long thinking pauses a post-pass needs to compress.
	// Keyed by filename rather than position, so a stray png in the directory cannot
	// silently shift every timestamp by one.
	try {
		const times: Record<string, number> = {};
		for (let i = 0; i < rec.frameTimes.length; i++) times[`f-${String(i).padStart(5, "0")}.png`] = rec.frameTimes[i];
		fs.writeFileSync(`${framesDir}/times.json`, JSON.stringify(times));
	} catch (err) {
		console.error("could not write frame times:", err);
	}
	try {
		assembleVideo(framesDir, rec.frameTimes, videoPath);
	} catch (err) {
		console.error("video assembly failed:", err);
	}
}
