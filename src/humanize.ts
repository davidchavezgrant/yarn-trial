/**
 * Post-process a finished run into a humanized recording.
 *
 * Deliberately a separate pass rather than part of `--record`: a run that drives the machine for
 * minutes is expensive to reproduce, and a failure in rendering must never cost one. It also means
 * a track can be rebuilt with different constants without re-running anything.
 *
 *   npm run humanize -- <stamp> [--no-video]
 *
 * Emits out/recording/<stamp>/motion-track.json (the handoff format for Yarn's own cursor
 * renderer) and, unless --no-video, humanized.mp4 alongside it.
 */

import fs from "node:fs";
import path from "node:path";
import type { MotionConstants, MotionSegmentLibrary } from "./motion-types.js";
import { renderTrack } from "./render.js";
import { buildTrack, readTrajectory, type RunLogStep } from "./track.js";

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

function main(): void {
	const argv = process.argv.slice(2);
	const stamp = argv.find((a) => !a.startsWith("--"));
	const wantVideo = !argv.includes("--no-video");
	if (!stamp) {
		console.error("usage: npm run humanize -- <run-stamp> [--no-video]");
		process.exit(1);
	}

	const recordingDir = path.join(OUT, "recording", stamp);
	const framesDir = path.join(recordingDir, "frames");
	const runLogPath = path.join(OUT, "runs", `${stamp}.json`);
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

	const frameFiles = fs.existsSync(framesDir)
		? fs.readdirSync(framesDir).filter((f) => f.startsWith("f-") && f.endsWith(".png")).sort()
		: [];
	if (frameFiles.length === 0) {
		console.error(`no frames in ${framesDir}`);
		process.exit(1);
	}
	const frameSize = pngSize(path.join(framesDir, frameFiles[0]));

	// The capture the driver reported click points in. before.png is the same window at its native
	// resolution, so its width is the denominator that converts those points into frame pixels.
	const firstBefore = path.join(turns[0].dir, "before.png");
	const captureSize = fs.existsSync(firstBefore) ? pngSize(firstBefore) : frameSize;

	let frameTimes = readFrameTimes(recordingDir, frameFiles);
	if (frameTimes.length === 0) {
		// Older recordings predate times.json. Fall back to file mtimes, which are within a frame
		// of the capture instant, and say so — the retiming is only as good as this input.
		console.log("no frames/times.json — falling back to file mtimes (recording predates timing capture)");
		frameTimes = frameFiles.map((f) => fs.statSync(path.join(framesDir, f)).mtimeMs);
	}

	const track = buildTrack({
		stamp,
		app,
		task,
		runLog: fs.existsSync(runLogPath) ? path.relative(process.cwd(), runLogPath) : "",
		steps,
		turns,
		frameTimes,
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

	const outPath = path.join(recordingDir, "humanized.mp4");
	renderTrack(track, framesDir, outPath)
		.then((r) => console.log(`humanized video: ${r.outPath} (${r.frames} frames)`))
		.catch((err) => {
			console.error("render failed:", err instanceof Error ? err.message : err);
			process.exit(1);
		});
}

main();
