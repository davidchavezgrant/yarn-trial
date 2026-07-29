import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { makeClient } from "./harness.js";

/**
 * Can the MODEL locate a small painted target on a screenshot, accurately enough to drag it?
 *
 * Everything about canvas manipulation rests on this. The driver takes window-local pixels
 * and the app honours a synthetic drag (measured), so the only remaining unknown is whether
 * the coordinates fed to that drag can come from the model looking at a picture. A few pixels
 * of error is fine — a target has a hit radius. Tens of pixels is not.
 *
 * This is a capability probe, not a task run, so it names what to look for. That is not a
 * measurement-rule violation: nothing here grounds an agent, and no run log is written. The
 * agent gets its description of a canvas from the appmap, which is a declared input.
 *
 * The interesting failure is not "it missed" but "it was confidently wrong": vision models
 * report coordinates fluently whether or not they can see. So the probe also asks for a count
 * and renders crosshairs, because a returned list is only worth as much as a human glance at
 * where the crosses landed.
 *
 * usage: tsx src/vision-probe.ts <image> "<what to find>" [--scale N]
 */

/**
 * Longest edge the API accepts before it resamples for you. Exceed it and the image is scaled
 * DOWN server-side, so the coordinates come back in a frame neither end agreed on — measured:
 * a 3894px-wide upscale returned x values 1.69–1.99x off truth, not even a consistent ratio,
 * where the same picture at 1568 was accurate to a few pixels. Upscaling past the cap is
 * strictly worse than not upscaling.
 */
const API_MAX_EDGE = 1568;

const argv = process.argv.slice(2);
const scaleIdx = argv.indexOf("--scale");
/**
 * Upscaling before asking. A target a few pixels across survives the model's own downsampling
 * badly, so enlarging SHOULD help — but only up to API_MAX_EDGE, above which it inverts.
 * 1 = send as captured. The useful case is a small crop; a full window is usually already at
 * the cap, which is exactly why sending it unmodified measured best.
 */
const SCALE = scaleIdx >= 0 ? Number(argv[scaleIdx + 1]) : 1;
const rest = argv.filter((_, i) => scaleIdx < 0 || (i !== scaleIdx && i !== scaleIdx + 1));
const IMAGE = rest[0];
const TARGET = rest[1];

interface Found {
	count: number;
	points: { x: number; y: number; confidence?: string }[];
	notes?: string;
}

const TOOL = {
	name: "report",
	description: "Report every instance of the target you can see, in image pixel coordinates.",
	input_schema: {
		type: "object" as const,
		properties: {
			count: { type: "number", description: "How many instances you can see." },
			points: {
				type: "array",
				description: "One entry per instance, left to right. Coordinates are pixels in the image as given to you, origin top-left.",
				items: {
					type: "object",
					properties: {
						x: { type: "number" },
						y: { type: "number" },
						confidence: { type: "string", enum: ["high", "medium", "low"] },
					},
					required: ["x", "y"],
				},
			},
			notes: { type: "string", description: "Anything ambiguous: things that might be the target but might not, or regions you cannot resolve." },
		},
		required: ["count", "points"],
	},
};

/** Scale up, and mark the returned points, so a human can check the answer against the picture. */
function render(src: string, out: string, scale: number, points: { x: number; y: number }[]): void {
	const script = `
import sys, json
from PIL import Image, ImageDraw
src, out, scale, pts = sys.argv[1], sys.argv[2], float(sys.argv[3]), json.loads(sys.argv[4])
im = Image.open(src).convert("RGB")
if scale != 1:
    im = im.resize((int(im.width * scale), int(im.height * scale)), Image.NEAREST)
d = ImageDraw.Draw(im)
for p in pts:
    x, y = p["x"] * scale, p["y"] * scale
    d.line([(x - 14, y), (x + 14, y)], fill=(255, 0, 0), width=2)
    d.line([(x, y - 14), (x, y + 14)], fill=(255, 0, 0), width=2)
im.save(out)
print(f"{im.width}x{im.height}")
`;
	const size = execFileSync("python3", ["-c", script, src, out, String(scale), JSON.stringify(points)], {
		encoding: "utf8",
	}).trim();
	console.log(`wrote ${out} (${size})`);
}

function upscale(src: string, out: string, scale: number): void {
	execFileSync("python3", [
		"-c",
		`
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB")
s = float(sys.argv[3])
if s != 1: im = im.resize((int(im.width*s), int(im.height*s)), Image.NEAREST)
im.save(sys.argv[2])
`,
		src,
		out,
		String(scale),
	]);
}

async function main(): Promise<void> {
	if (!IMAGE || !TARGET) {
		console.error('usage: tsx src/vision-probe.ts <image> "<what to find>" [--scale N]');
		process.exit(1);
	}

	// Clamp rather than refuse: the caller asked for magnification, and the largest the API
	// will honour is still the best available answer to that request.
	const srcW = Number(execFileSync("python3", ["-c", "import sys;from PIL import Image;print(Image.open(sys.argv[1]).width)", IMAGE], { encoding: "utf8" }).trim());
	const scale = Math.min(SCALE, API_MAX_EDGE / srcW);
	if (scale < SCALE) console.log(`scale clamped ${SCALE} -> ${scale.toFixed(2)} (API resamples above ${API_MAX_EDGE}px)`);
	const sent = scale === 1 ? IMAGE : "/tmp/vision-probe-sent.png";
	if (scale !== 1) upscale(IMAGE, sent, scale);

	const { client, model } = makeClient();
	const response = await client.messages.create({
		model,
		max_tokens: 4000,
		tools: [TOOL],
		tool_choice: { type: "tool", name: "report" },
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text:
							`Find every instance of: ${TARGET}\n\n` +
							"Report coordinates in pixels of the image exactly as given to you, origin top-left. " +
							"Be precise about x — these will be used to point at the thing. " +
							"If you cannot see any, report count 0 rather than guessing; a wrong coordinate is worse than none.",
					},
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: fs.readFileSync(sent).toString("base64") },
					},
				],
			},
		],
	});

	const use = response.content.find((b): b is import("@anthropic-ai/sdk").Anthropic.ToolUseBlock => b.type === "tool_use");
	if (!use) {
		console.error("model returned no tool call");
		process.exit(1);
	}
	const found = use.input as Found;

	// Back to source pixels, which is the space the driver and every ground truth speak.
	const points = found.points.map((p) => ({ ...p, x: Math.round(p.x / scale), y: Math.round(p.y / scale) }));
	console.log(`\ntarget: ${TARGET}`);
	console.log(`image:  ${IMAGE}${scale === 1 ? "" : ` (sent at ${scale.toFixed(2)}x)`}`);
	console.log(`count:  ${found.count}`);
	console.log(`x (source px): ${points.map((p) => p.x).join(", ")}`);
	for (const p of points) console.log(`  (${p.x}, ${p.y})${p.confidence ? ` ${p.confidence}` : ""}`);
	if (found.notes) console.log(`notes: ${found.notes}`);

	render(IMAGE, "/tmp/vision-probe-marked.png", 3, points);
}

main().catch((err) => {
	console.error("vision-probe failed:", err);
	process.exit(1);
});
