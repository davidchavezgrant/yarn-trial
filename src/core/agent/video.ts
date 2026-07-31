import { execSync } from "node:child_process";
import fs from "node:fs";

export function pngSize(path: string): { w: number; h: number } {
	const buf = Buffer.alloc(8);
	const fd = fs.openSync(path, "r");
	fs.readSync(fd, buf, 0, 8, 16);
	fs.closeSync(fd);

	return { w: buf.readUInt32BE(0), h: buf.readUInt32BE(4) };
}

function badFrames(framesDir: string): Set<number> {
	// Content-level gate, complementing the majority-vote size filter: catches
	// frames whose canvas size is right but whose content is offset (the driver
	// composites the window at an offset during Space/display transitions).
	// Measures leading pure-black columns; anything over ~6px is malformed.
	const script = `
import glob, sys
from PIL import Image
for i, p in enumerate(sorted(glob.glob("${framesDir}/f-*.png"))):
    im = Image.open(p).convert("RGB")
    w, h = im.size
    band = 0
    for x in range(0, min(w, 600), 2):
        if max(max(im.getpixel((x, y))) for y in range(0, h, 32)) < 12: band = x + 2
        else: break
    if band > 6: print(i)
`;
	let out: string;
	try {
		out = execSync(`python3 -c '${script.replace(/'/g, "'\\''")}'`).toString().trim();
	} catch {
		// python3/PIL is optional everywhere else (pixelDelta and dragMoved degrade to
		// undefined without it); a missing interpreter here must cost the black-band
		// filter, not the whole video.
		console.log("black-band frame filter skipped (python3/PIL unavailable) — frames pass unfiltered");

		return new Set();
	}

	return new Set(out ? out.split("\n").map(Number) : []);
}

export function assembleVideo(framesDir: string, times: number[], outPath: string): void {
	// A run that dies before the first frame lands never creates the directory — that is a
	// failed run, already reported, and an ENOENT stack on top of it only obscures the cause.
	if (!fs.existsSync(framesDir)) {
		console.log("no frames captured — skipping video assembly");

		return;
	}
	const all = fs.readdirSync(framesDir).filter((f) => f.endsWith(".png")).sort();
	// Majority vote: the modal frame size defines "tight" for this run; composite/
	// mis-scaled captures show up as size outliers.
	const sizeCounts = new Map<string, number>();
	const sizes = all.map((f) => {
		const s = pngSize(`${framesDir}/${f}`);
		const key = `${s.w}x${s.h}`;
		sizeCounts.set(key, (sizeCounts.get(key) ?? 0) + 1);
		return key;
	});
	const modal = [...sizeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
	const bad = badFrames(framesDir);
	const keep = all.map((_, i) => sizes[i] === modal && !bad.has(i));
	const dropped = keep.filter((k) => !k).length;
	if (dropped > 0) console.log(`dropping ${dropped} malformed frame(s) (modal size ${modal})`);
	const frames = all.filter((_, i) => keep[i]);
	times = times.filter((_, i) => keep[i]);
	if (frames.length < 2) {
		console.log("not enough frames for a video");
		return;
	}
	const { w, h } = pngSize(`${framesDir}/${frames[0]}`);
	const W = w & ~1;
	const H = h & ~1;
	let list = "";
	for (let i = 0; i < frames.length; i++) {
		const dur = i < times.length - 1 ? (times[i + 1] - times[i]) / 1000 : 0.25;
		list += `file '${frames[i]}'\nduration ${Math.max(0.05, Math.min(dur, 5)).toFixed(3)}\n`;
	}
	list += `file '${frames[frames.length - 1]}'\n`;
	fs.writeFileSync(`${framesDir}/list.txt`, list);
	execSync(
		`ffmpeg -v error -f concat -safe 0 -i list.txt -vf "scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x1a1a1a,format=yuv420p" -y "${outPath}"`,
		{ cwd: framesDir },
	);
	console.log(`window-scoped video: ${outPath} (${frames.length} frames)`);
}
