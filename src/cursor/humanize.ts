/**
 * Post-process a finished run into a humanized recording.
 *
 * Deliberately a separate pass rather than part of `--record`: a run that drives the machine for
 * minutes is expensive to reproduce, and a failure in rendering must never cost one. It also means
 * a track can be rebuilt with different constants without re-running anything.
 *
 *   npm run humanize -- <stamp> [--no-video]
 *
 * Emits out/live/<stamp>/recording/motion-track.json (the handoff format for Yarn's own cursor
 * renderer) and, unless --no-video, humanized.mp4 alongside it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { MotionConstants, MotionSegmentLibrary } from "./motion-types.js";
import { renderTrack } from "./render.js";
import { buildTrack, readTrajectory, type RunLogStep, type TrajectoryTurn } from "./track.js";
import { RUN_FILES, runFile } from "../paths.js";

const OUT = `${process.cwd()}/out`;
const DATA = `${process.cwd()}/data`;

/** PNG dimensions from the IHDR header, avoiding an image-decoding dependency. */
function pngSize(file: string): { width: number; height: number } {
	const buf = Buffer.alloc(8);
	const fd = fs.openSync(file, "r");
	fs.readSync(fd, buf, 0, 8, 16);
	fs.closeSync(fd);

	return { width: buf.readUInt32BE(0), height: buf.readUInt32BE(4) };
}

/**
 * Frame capture times in epoch ms, aligned to `files`.
 *
 * Written by the run itself as a filename-keyed map, so a stray PNG in the directory cannot shift
 * every timestamp by one the way a positional array would.
 *
 * frames/list.txt is NOT a fallback: assembleVideo() clamps every duration to at most five
 * seconds, so a run's long thinking gaps are already compressed there and the timeline it implies
 * is not the one the actions happened on.
 *
 * Throws on an unrecognized shape rather than returning empty. Returning empty would fall through
 * to the mtime path, which prints one line and otherwise looks like success — so a format change
 * here would silently degrade the retiming of every run instead of failing where it broke.
 */
function readFrameTimes(recordingDir: string, files: string[]): number[] {
	const file = path.join(recordingDir, "frames", "times.json");
	if (!fs.existsSync(file)) return [];
	const raw = JSON.parse(fs.readFileSync(file, "utf8"));
	if (raw === null || typeof raw !== "object" || Array.isArray(raw))
		throw new Error(`${file}: expected a {"f-00000.png": epochMs} map, got ${Array.isArray(raw) ? "an array" : typeof raw}`);
	const times = files.map((f) => raw[f]);
	const missing = files.filter((f, i) => typeof times[i] !== "number");
	if (missing.length > 0)
		throw new Error(`${file}: no timestamp for ${missing.length} frame(s), first ${missing[0]}`);

	return times as number[];
}

/**
 * Measure what actually changed on screen for each turn, in its own capture pixels.
 *
 * The independent check on AX geometry: a tree can report a control's position from a stale layout
 * or name two controls the same, but the before/after diff cannot. Shelled to python + PIL, the
 * same pattern badFrames() uses in src/core/agent.ts, because there is no image decoder in the node
 * dependencies and this needs one for a handful of files.
 */
function attachChangeBoxes(turns: TrajectoryTurn[]): void {
	const dirs = turns.map((t) => t.dir).filter((d) => fs.existsSync(path.join(d, "before.png")));
	if (dirs.length === 0) return;
	const script = `
import json, sys
from PIL import Image, ImageChops
out = {}
for d in sys.argv[1:]:
    try:
        a = Image.open(d + "/before.png").convert("L")
        b = Image.open(d + "/after.png").convert("L")
        if a.size != b.size: continue
        bb = ImageChops.difference(a, b).point(lambda p: 255 if p > 40 else 0).getbbox()
        if bb: out[d] = list(bb)
    except Exception: pass
print(json.dumps(out))
`;
	try {
		const raw = execFileSync("python3", ["-c", script, ...dirs], { encoding: "utf8", maxBuffer: 1 << 22 });
		const boxes: Record<string, [number, number, number, number]> = JSON.parse(raw);
		for (const t of turns) {
			const bb = boxes[t.dir];
			if (bb) t.changeBox = { x: bb[0], y: bb[1], w: bb[2] - bb[0], h: bb[3] - bb[1] };
		}
	} catch (err) {
		// Advisory only: without it, click points stand as the driver reported them.
		console.log(`could not measure changed regions: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
	}
}

function main(): void {
	// Loose parseArgs, matching what the hand-rolled parser accepted: unknown flags are
	// ignored rather than fatal.
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		options: { "no-video": { type: "boolean" } },
		strict: false,
		allowPositionals: true,
	});
	const stamp = positionals[0];
	const wantVideo = values["no-video"] !== true;
	if (!stamp) {
		console.error("usage: npm run humanize -- <run-stamp> [--no-video]");
		process.exit(1);
	}

	const recordingDir = runFile(stamp, RUN_FILES.recording);
	const framesDir = path.join(recordingDir, "frames");
	const runLogPath = runFile(stamp, RUN_FILES.log);
	if (!fs.existsSync(recordingDir)) {
		console.error(`no recording at ${recordingDir}`);
		process.exit(1);
	}

	const constantsFile = path.join(DATA, "motion-constants.json");
	const libraryFile = path.join(DATA, "motion-segments.json");
	if (!fs.existsSync(constantsFile)) {
		console.error(`missing ${constantsFile} — run scripts/fit-motion.py first`);
		process.exit(1);
	}
	const constants: MotionConstants = JSON.parse(fs.readFileSync(constantsFile, "utf8"));
	const library: MotionSegmentLibrary = fs.existsSync(libraryFile)
		? JSON.parse(fs.readFileSync(libraryFile, "utf8"))
		: { fittedFrom: { dataset: "none", generatedAt: "" }, segments: [] };

	const turns = readTrajectory(recordingDir);
	if (turns.length === 0) {
		console.error(`no driver turns in ${recordingDir}/trajectory — nothing to animate`);
		process.exit(1);
	}
	attachChangeBoxes(turns);

	// The run log is optional: without it there are no element roles, so every pointer stays an
	// arrow, but the geometry and timing all come from the trajectory and the track still builds.
	let steps: RunLogStep[] = [];
	let app = "unknown";
	let task = "";
	if (fs.existsSync(runLogPath)) {
		const log = JSON.parse(fs.readFileSync(runLogPath, "utf8"));
		steps = log.steps ?? [];
		app = log.app ?? app;
		task = log.task ?? task;
	} else {
		console.log(`no run log at ${runLogPath} — pointer types will default to arrow`);
	}

	const allFrames = fs.existsSync(framesDir)
		? fs.readdirSync(framesDir).filter((f) => f.startsWith("f-") && f.endsWith(".png")).sort()
		: [];
	if (allFrames.length === 0) {
		console.error(`no frames in ${framesDir}`);
		process.exit(1);
	}
	// Modal frame size, then DROP everything that is not it — the same majority vote and the same
	// discard that assembleVideo does. Off-size frames are captured while the window is still
	// settling: one run opened with 25 of them, showing a completely different screen (the previous
	// run's editor, before the home reset landed) at a 1.18 aspect ratio against the capture's 1.78.
	// Letterboxing those into the output was the source of the black bars and false starts — they
	// are not merely mis-shaped, they are frames of the wrong moment.
	const sizeCounts = new Map<string, { size: { width: number; height: number }; n: number }>();
	for (const f of allFrames) {
		const s = pngSize(path.join(framesDir, f));
		const key = `${s.width}x${s.height}`;
		const seen = sizeCounts.get(key);
		if (seen) seen.n++;
		else sizeCounts.set(key, { size: s, n: 1 });
	}
	const ranked = [...sizeCounts.values()].sort((a, b) => b.n - a.n);
	const frameSize = ranked[0].size;
	const frameFiles = allFrames.filter((f) => {
		const s = pngSize(path.join(framesDir, f));

		return s.width === frameSize.width && s.height === frameSize.height;
	});
	if (frameFiles.length < allFrames.length)
		console.log(
			`dropping ${allFrames.length - frameFiles.length} malformed frame(s) ` +
				`(modal size ${frameSize.width}x${frameSize.height}; saw ${ranked.map((r) => `${r.size.width}x${r.size.height} x${r.n}`).join(", ")})`,
		);
	if (frameFiles.length < 2) {
		console.error("not enough usable frames to render");
		process.exit(1);
	}

	// The capture the driver reported click points in. before.png is the same window at its native
	// resolution, so its width is the denominator that converts those points into frame pixels.
	// Per-turn widths override this; it is only the fallback for a turn with no before.png.
	const firstBefore = path.join(turns[0].dir, "before.png");
	const captureSize = fs.existsSync(firstBefore) ? pngSize(firstBefore) : frameSize;

	// Stamped by the agent when recording actually starts. start_recording backfills turns from
	// earlier in the driver session, so without this the home reset's clicks are animated as part
	// of the take. Absent on recordings made before the agent wrote it.
	const startedFile = path.join(recordingDir, "recording-started.json");
	const recordedFromMs = fs.existsSync(startedFile)
		? (JSON.parse(fs.readFileSync(startedFile, "utf8")).epochMs as number)
		: undefined;

	let frameTimes = readFrameTimes(recordingDir, frameFiles);
	if (frameTimes.length === 0) {
		// Older recordings predate times.json. Fall back to file mtimes, which are within a frame
		// of the capture instant, and say so — the retiming is only as good as this input.
		console.log("no frames/times.json — falling back to file mtimes (recording predates timing capture)");
		frameTimes = frameFiles.map((f) => fs.statSync(path.join(framesDir, f)).mtimeMs);
	}

	// Cheap content signature per frame: size plus a sparse byte sample. Enough to tell a repeated
	// static screen from a real repaint without decoding 160 PNGs.
	const frameHashes = frameFiles.map((f) => {
		const buf = fs.readFileSync(path.join(framesDir, f));
		let h = 0;
		for (let i = 0; i < buf.length; i += 4093) h = (h * 31 + buf[i]) >>> 0;

		return `${buf.length}:${h}`;
	});

	const track = buildTrack({
		stamp,
		app,
		task,
		runLog: fs.existsSync(runLogPath) ? path.relative(process.cwd(), runLogPath) : "",
		steps,
		turns,
		frameTimes,
		frameHashes,
		recordedFromMs,
		frameFiles,
		frameSize,
		captureSize,
		constants,
		library,
	});

	const trackPath = path.join(recordingDir, "motion-track.json");
	fs.writeFileSync(trackPath, JSON.stringify(track, null, 2));
	console.log(
		`motion track: ${trackPath} (${track.cursor.length} cursor samples, ${track.events.length} events, ` +
			`${(track.timeline.durationMs / 1000).toFixed(1)}s at ${track.timeline.fps}fps)`,
	);

	if (!wantVideo) return;

	// Render to a partial name and rename into place on success. humanized.mp4's EXISTENCE is
	// the "rendered" signal everywhere (the gallery, listRecordedRuns) — an encoder killed
	// mid-write would otherwise leave a truncated file that reads as a finished render forever.
	// The rename is atomic on the same filesystem; a stale partial from a crashed pass is
	// overwritten by the next render and never surfaces anywhere.
	const outPath = path.join(recordingDir, "humanized.mp4");
	const partial = path.join(recordingDir, "humanized.partial.mp4");
	renderTrack(track, framesDir, partial)
		.then((r) => {
			fs.renameSync(partial, outPath);
			console.log(`humanized video: ${outPath} (${r.frames} frames)`);
		})
		.catch((err) => {
			fs.rmSync(partial, { force: true });
			console.error("render failed:", err instanceof Error ? err.message : err);
			process.exit(1);
		});
}

main();
