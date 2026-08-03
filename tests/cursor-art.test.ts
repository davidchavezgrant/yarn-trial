import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The arrow the compositor draws is the ONE cursor macOS does not ship as a PDF, so it is the one
 * that can silently stop looking like a macOS cursor. It did: draw_arrow() stroked a white outline
 * and then filled the same polygon black over it, and the rendered art measured zero white pixels
 * — a black arrow over Yarn's dark editor, invisible for most of every recording. The comment said
 * otherwise, review read the comment, and nothing measured the pixels.
 *
 * So measure the pixels. The compositor is python because PIL is the only image library in reach
 * (see scripts/render_cursor.py); the test shells out to it the same way badFrames() does in
 * src/core/agent/video.ts, and degrades the same way when python3/PIL is not installed.
 */
const script = fileURLToPath(new URL("../scripts/render_cursor.py", import.meta.url));

interface ArrowProbe {
	white: number;
	black: number;
	hotspot: [number, number];
	outsideTheLeftEdge: [number, number, number, number];
	insideTheBody: [number, number, number, number];
}

function probeArrow(): ArrowProbe | undefined {
	const probe = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("rc", ${JSON.stringify(script)})
rc = importlib.util.module_from_spec(spec); spec.loader.exec_module(rc)
art, (hotx, hoty) = rc.draw_arrow()
px = list(art.getdata())
print(json.dumps({
    "white": sum(1 for p in px if p[3] > 200 and min(p[:3]) > 200),
    "black": sum(1 for p in px if p[3] > 200 and max(p[:3]) < 60),
    "hotspot": [hotx, hoty],
    # A row down the arrow's vertical left edge: border outside it, body just inside.
    "outsideTheLeftEdge": list(art.getpixel((hotx - 1, hoty + 8))),
    "insideTheBody": list(art.getpixel((hotx + 2, hoty + 8))),
}))
`;
	try {
		return JSON.parse(execFileSync("python3", ["-c", probe], { encoding: "utf8" }));
	} catch {
		return undefined;
	}
}

test("DrawArrow__RendersAWhiteBorderAroundABlackBody", () => {
	const arrow = probeArrow();
	if (!arrow) return console.log("cursor art test skipped (python3/PIL unavailable)");

	assert.ok(arrow.black > 100, `arrow body should be black, saw ${arrow.black} opaque black pixels`);
	assert.ok(arrow.white > 50, `arrow should carry a white border, saw ${arrow.white} opaque white pixels`);

	const [r, g, b, a] = arrow.outsideTheLeftEdge;
	assert.ok(a > 200 && Math.min(r, g, b) > 200, `border outside the left edge should be opaque white, got ${arrow.outsideTheLeftEdge}`);
	const body = arrow.insideTheBody;
	assert.ok(body[3] > 200 && Math.max(body[0], body[1], body[2]) < 60, `body should be opaque black, got ${body}`);
});

test("DrawArrow__KeepsTheHotspotOnTheTip__When__TheBorderInsetsTheProfile", () => {
	const arrow = probeArrow();
	if (!arrow) return console.log("cursor art test skipped (python3/PIL unavailable)");

	// The profile starts at (0,0), so the border is only drawable if the art is inset by its width
	// — and then the hotspot has to move with it or every click renders offset by that inset.
	const [hotx, hoty] = arrow.hotspot;
	assert.ok(hotx > 0 && hoty > 0, `hotspot should follow the inset profile, got ${arrow.hotspot}`);
	assert.ok(hotx < 6 && hoty < 6, `hotspot should still be the arrow tip, got ${arrow.hotspot}`);
});
