/**
 * Render a humanized cursor over a run's captured frames.
 *
 * This module may read ONLY the motion track and the frames. That restriction is the point: Yarn
 * reimposes a synthetic cursor in their own pipeline, and the track is the handoff format. If
 * rendering ever needs a field from the run log, the track schema is missing something and the
 * handoff would fail on their side too. Keeping the renderer blind is how that stays honest.
 *
 * Pixels go to python3 + PIL, following the same shell-out pattern badFrames() uses in
 * src/agent.ts. There are no image libraries in the node dependencies, and adding one to paste a
 * 32px bitmap would be the wrong trade. The compositor streams raw rgb24 into ffmpeg rather than
 * writing intermediate PNGs — at 60fps a several-minute run is thousands of files and gigabytes of
 * disk for frames that exist only to be immediately re-encoded.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { MotionTrack } from "./motion-types.js";

export interface RenderResult {
	outPath: string;
	frames: number;
	durationMs: number;
}

/**
 * Composite `track` over `framesDir` into an mp4.
 *
 * Rejects rather than guesses when the track and the frames disagree on size: a mismatch means the
 * track was built against a different recording, and rendering it anyway would silently place
 * every click at the wrong spot.
 */
export async function renderTrack(track: MotionTrack, framesDir: string, outPath: string): Promise<RenderResult> {
	if (!fs.existsSync(framesDir)) throw new Error(`no frames to render at ${framesDir}`);
	const frames = fs.readdirSync(framesDir).filter((f) => f.startsWith("f-") && f.endsWith(".png"));
	if (frames.length === 0) throw new Error(`no frames to render at ${framesDir}`);

	const { width, height } = track.space;
	const { fps, durationMs } = track.timeline;
	const total = Math.floor((durationMs / 1000) * fps);
	if (total <= 0) throw new Error("track has no duration to render");

	const trackFile = path.join(path.dirname(outPath), "motion-track.json");
	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	fs.writeFileSync(trackFile, JSON.stringify(track, null, 2));

	const script = new URL("../scripts/render_cursor.py", import.meta.url).pathname;
	const compositor = spawn("python3", [script, trackFile, framesDir], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	const encoder = spawn(
		"ffmpeg",
		[
			"-v", "error",
			"-f", "rawvideo",
			"-pix_fmt", "rgb24",
			"-s", `${width}x${height}`,
			"-r", String(fps),
			"-i", "pipe:0",
			// libx264 + yuv420p refuses odd dimensions, and a viewport is odd whenever the
			// page happens to lay out that way (first hit: a 1200x953 CDP recording). Pad by
			// at most one row/column rather than crop: added pixels shift nothing, removed
			// ones would put every composited click point half a pixel off the content.
			"-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=black",
			"-c:v", "libx264",
			"-preset", "medium",
			"-crf", "18",
			"-pix_fmt", "yuv420p",
			"-y", outPath,
		],
		{ stdio: ["pipe", "inherit", "inherit"] },
	);
	compositor.stdout.pipe(encoder.stdin);

	const wait = (child: ReturnType<typeof spawn>, name: string): Promise<void> =>
		new Promise((resolve, reject) => {
			child.on("error", reject);
			child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`))));
		});

	await Promise.all([wait(compositor, "compositor"), wait(encoder, "ffmpeg")]);

	return { outPath, frames: total, durationMs };
}
