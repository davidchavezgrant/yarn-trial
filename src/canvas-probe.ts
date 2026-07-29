import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { Driver } from "./driver.js";
import { findWindow, pixelDelta } from "./harness.js";
import { startOverlay } from "./overlay.js";
import * as axdom from "./axdom.js";

/**
 * Probe 1b: does Yarn's timeline surface a sync point as TEXT?
 *
 * The agent verifies by matching substrings in the next observation. A sync point is a dot
 * drawn on a timeline clip: no label, no value, probably no AX element. If dragging it
 * changes only pixels, the task cannot be verified the way every task so far has been.
 *
 * But it might not be that bad. Chromium derives AX from the DOM, and observe() throws away
 * most of what comes back: only 8 whitelisted roles with a label, value or DOM descriptor
 * survive. A timecode readout could already be in the tree and simply be dropped before the
 * model ever sees it. THAT is what this checks — the full element array, unfiltered, before
 * and after interacting with a sync point.
 *
 * The result decides the design:
 *   text found    -> ordinary text-verified task; only the drag action needs building.
 *   nothing found -> pixel channel only, and done(success) must stay un-provable.
 *
 * Read-only apart from one click and one no-op drag on the timeline, both of which Yarn
 * treats as ordinary editing gestures. Nothing is saved, sent or deleted.
 *
 * NOTHING HERE IS APP LOGIC. This is a measurement instrument, in the same category as
 * probe.ts and prior.ts: nothing imports it, and no production module may grow a special
 * case for a particular app. The target, the document to open and the control to widen the
 * canvas with are all arguments or pattern matches, because the next app will name them
 * differently. What graduates into src/ is the ANSWER (which verification channel a canvas
 * target affords), never these selectors.
 *
 * Usage: npx tsx src/canvas-probe.ts [x] [y]
 *   x,y  = window-local screenshot pixels of the canvas target, read off out/canvas-probe-0.png.
 *          Run once with no arguments to get that screenshot, then again with coordinates.
 *   env  APP=<app name>      target application (default Yarn)
 *        DOC=<title prefix>  document to open from the app's landing list (default AutoTime)
 *        WIDEN=<regex>       control that maximizes the canvas viewport (default /zoom|fit/i)
 */

const OUT = `${process.cwd()}/out`;
const APP = process.env.APP ?? "Yarn";
/** Document to open from the landing list; on Yarn this is Jasper's markers.mp4 demo project. */
const DOC = process.env.DOC ?? "AutoTime";
/**
 * OPT-IN. A canvas usually opens showing a fraction of its content, and some apps have a
 * control that widens the view. Off by default because it is a click into an unknown control
 * and it earned that: with a default of /zoom|fit/ it matched a transient "Add Zoom" button
 * that only exists while a clip is selected, opened an animation editor, and the run probed
 * the wrong screen entirely. Panning (SURVEY) reaches the same content without the risk.
 */
const WIDEN = process.env.WIDEN ? new RegExp(process.env.WIDEN, "i") : undefined;
/**
 * Apps reopen where the last session left them, so the probe cannot assume it starts on the
 * document list. Pattern, not a fixed label, for the same reason as WIDEN.
 */
const NAV = new RegExp(process.env.NAV ?? "^(library|home|projects|documents|files|recents)$", "i");
/** Timecodes (0:04, 1:23:45) — how a position along a media timeline would read. */
const TIMECODE = /\b\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\b/;
/**
 * Document lists are full of wall-clock modification stamps ("You - Today 4:27 PM"), which
 * match TIMECODE and are not timeline positions. 33 of them on Yarn's landing page alone —
 * without this the probe reports a text affordance that has nothing to do with the canvas.
 */
const WALL_CLOCK = /\b(AM|PM)\b|\b(Today|Yesterday|ago)\b/i;
/**
 * Frames to capture while panning the canvas right, looking for the region of interest.
 * SURVEY_X/Y is where the scroll is aimed — a point inside the canvas, in window-local
 * screenshot pixels, read off canvas-probe-0.png like every other coordinate here.
 */
const SURVEY = Number(process.env.SURVEY ?? 0);
const SURVEY_X = Number(process.env.SURVEY_X ?? 1000);
const SURVEY_Y = Number(process.env.SURVEY_Y ?? 800);
/** Pans left before surveying, to start from the viewport's origin. Overshoot is free. */
const HOME = Number(process.env.HOME_PANS ?? 12);
/**
 * Gate 1: drag the target this many pixels right and check whether it MOVED.
 *
 * Everything downstream of a canvas task assumes a synthetic drag actuates the app at all,
 * and that is not a given: set_value fails on this app's controls because it writes AX state
 * without firing a DOM event, and a canvas listening for pointer events could refuse a
 * synthesized drag the same way. Cheaper to find out here than after building the action.
 * 0 = skip.
 */
const DRAG_DX = Number(process.env.DRAG_DX ?? 0);
/**
 * A point on the same canvas that is NOT the target — empty space beside it. Clicking here
 * first shows what any click does, so the target click's diff can be read for what is
 * specific to the target. Without it the probe cannot tell a per-target readout from a
 * global one, and it got that exact call wrong on its first run.
 */
const DECOY_X = process.env.DECOY_X ? Number(process.env.DECOY_X) : undefined;
const DECOY_Y = process.env.DECOY_Y ? Number(process.env.DECOY_Y) : undefined;
/**
 * Where to click before sending undo, and how many times to send it.
 *
 * A shortcut goes to the focused control, so the click has to land INSIDE the canvas, on the
 * same row as the target but far from it — near the row's start, which is empty on any
 * left-to-right canvas. Presses default to 3 because one edit can be several undo steps
 * (this app's drag registered as two) and undoing past the probe's own edits is harmless:
 * the probe made every edit in the document since it opened.
 */
const UNDO_FOCUS_X = Number(process.env.UNDO_FOCUS_X ?? 700);
const UNDO_PRESSES = Number(process.env.UNDO_PRESSES ?? 3);

interface Row {
	index: number;
	role: string;
	label: string;
	value: string;
	descriptor: string;
	frame: string;
}

function section(title: string): void {
	console.log(`\n=== ${title} ===`);
}

/**
 * Every element the driver returns, with none of observe()'s filtering. The point is to see
 * what observe() is throwing away, so applying its whitelist here would defeat the probe.
 */
function dump(elements: any[], dom: axdom.DomEnrichment): Row[] {
	return elements.map((e) => ({
		index: e.element_index,
		role: e.role ?? "",
		label: (e.label ?? "").toString().replace(/\s+/g, " "),
		value: (e.value ?? "").toString().replace(/\s+/g, " "),
		descriptor: axdom.lookup(dom, e.frame),
		frame: e.frame ? `${e.frame.x},${e.frame.y} ${e.frame.w}x${e.frame.h}` : "",
	}));
}

const text = (r: Row) => `${r.label} ${r.value} ${r.descriptor}`.trim();
const key = (r: Row) => `${r.role}|${r.label}|${r.value}|${r.descriptor}|${r.frame}`;

const parseFrame = (f: string): [number, number, number, number] | undefined => {
	if (!f) return undefined;
	const [xy, wh] = f.split(" ");
	const [x, y] = xy.split(",").map(Number);
	const [w, h] = wh.split("x").map(Number);

	return [x, y, w, h];
};

/**
 * AX frame (logical points, screen origin) -> window-local screenshot pixels, the space
 * mouse_drag and coordinate clicks consume.
 *
 * Two conversions, and both matter. The window's own AX frame gives the origin to subtract;
 * the ratio of the screenshot's width to the window's logical width gives the scale. The
 * scale is DERIVED, not the hardcoded 0.8167 from planning — that number was measured on one
 * display, and a run on the laptop's Retina panel would silently mis-aim every drag.
 */
function toWindowPx(rows: Row[], ax: number, ay: number): [number, number] {
	const winRow = rows.find((r) => r.role === "AXWindow" && r.frame);
	const wf = winRow ? parseFrame(winRow.frame) : undefined;
	if (!wf) return [Math.round(ax), Math.round(ay)];
	const [ox, oy, ow] = wf;
	const scale = SHOT_WIDTH > 0 && ow > 0 ? SHOT_WIDTH / ow : 1;

	return [Math.round((ax - ox) * scale), Math.round((ay - oy) * scale)];
}

/** Inverse of toWindowPx: screenshot pixels back to the AX frame space. */
function fromWindowPx(rows: Row[], px: number, py: number): [number, number] {
	const winRow = rows.find((r) => r.role === "AXWindow" && r.frame);
	const wf = winRow ? parseFrame(winRow.frame) : undefined;
	if (!wf) return [px, py];
	const [ox, oy, ow] = wf;
	const scale = SHOT_WIDTH > 0 && ow > 0 ? SHOT_WIDTH / ow : 1;

	return [ox + px / scale, oy + py / scale];
}

/** Width of the last screenshot written, for the AX->pixel scale. */
let SHOT_WIDTH = 0;

/** PNG width, from the IHDR header — cheaper and dependency-free versus decoding the image. */
function pngWidth(path: string): number {
	try {
		const fd = fs.openSync(path, "r");
		const head = Buffer.alloc(24);
		fs.readSync(fd, head, 0, 24, 0);
		fs.closeSync(fd);

		return head.readUInt32BE(16);
	} catch {
		return 0;
	}
}

/**
 * Fraction of pixels changed in a small box around a point.
 *
 * The whole-window delta cannot answer the question this probe actually depends on — did the
 * click land on the target? Measured: clicking a sync point moved 0.00037 of the window and
 * clicking bare canvas moved 0.00032, indistinguishable, because a 5px dot is nothing against
 * 1568x882. Cropping to the target makes a hit unmissable (a dot that highlights changes most
 * of the box) and a miss read zero. No downscale here, for the same reason: an 8x reduction
 * would average the dot away.
 */
function localDelta(beforePath: string, afterPath: string, cx: number, cy: number, r = 12): number | undefined {
	const script = `
import sys
from PIL import Image, ImageChops
a = Image.open(sys.argv[1]).convert("RGB")
b = Image.open(sys.argv[2]).convert("RGB")
if a.size != b.size:
    print("SIZE_MISMATCH"); sys.exit(0)
cx, cy, r = (int(v) for v in sys.argv[3:6])
box = (max(0, cx - r), max(0, cy - r), min(a.width, cx + r), min(a.height, cy + r))
diff = ImageChops.difference(a.crop(box), b.crop(box)).convert("L")
data = list(diff.getdata())
print(sum(1 for p in data if p > 12) / float(len(data)))
`;
	try {
		const out = execFileSync("python3", ["-c", script, beforePath, afterPath, String(cx), String(cy), String(r)], {
			encoding: "utf8",
		}).trim();
		const v = Number(out);

		return Number.isFinite(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Pixels differing along the target's ROW — the horizontal strip the drag moves things in.
 *
 * Used to check a restore. Two instruments were tried first and both lie:
 *
 * - A local crop around the origin cannot distinguish "the object came back" from "an
 *   indicator arrived there", and cannot see a ripple further along the row at all.
 * - A whole-frame diff is swamped by content. This canvas has a live preview beside it, so
 *   moving the playhead one second repaints a third of the window: the restore check read
 *   569,597 changed pixels for a drag that moved one 5px mark. Any app with a preview, a
 *   video, an animation, or a clock behaves the same way.
 *
 * A row-height strip is the narrowest thing that still sees the whole edit. Not app-specific:
 * a drag along a row is what is being measured, so the row is the natural window.
 */
function rowDelta(beforePath: string, afterPath: string, y: number, half = 20): number | undefined {
	const script = `
import sys
from PIL import Image, ImageChops
a = Image.open(sys.argv[1]).convert("RGB")
b = Image.open(sys.argv[2]).convert("RGB")
if a.size != b.size:
    print("-1"); sys.exit(0)
y, h = int(sys.argv[3]), int(sys.argv[4])
box = (0, max(0, y - h), a.width, min(a.height, y + h))
print(sum(1 for p in ImageChops.difference(a.crop(box), b.crop(box)).convert("L").getdata() if p > 12))
`;
	try {
		const v = Number(
			execFileSync("python3", ["-c", script, beforePath, afterPath, String(y), String(half)], { encoding: "utf8" }).trim(),
		);

		return Number.isFinite(v) && v >= 0 ? v : undefined;
	} catch {
		return undefined;
	}
}

/** Rows whose text looks like a timeline position — the thing that would make this verifiable. */
function timecodes(rows: Row[]): Row[] {
	return rows.filter((r) => TIMECODE.test(text(r)) && !WALL_CLOCK.test(text(r)));
}

function report(label: string, rows: Row[]): void {
	const named = rows.filter((r) => text(r));
	section(`${label}: ${rows.length} elements, ${named.length} with any text`);
	const tc = timecodes(rows);
	console.log(`timecode-shaped: ${tc.length}`);
	for (const r of tc.slice(0, 25))
		console.log(`  [${r.index}] ${r.role} "${r.label}" value="${r.value}" ${r.descriptor} @(${r.frame})`);
}

async function main(): Promise<void> {
	const x = process.argv[2] ? Number(process.argv[2]) : undefined;
	const y = process.argv[3] ? Number(process.argv[3]) : undefined;

	fs.mkdirSync(OUT, { recursive: true });
	// A probe reads mostly, but it clicks and drags too — the machine is still not yours.
	const overlay = startOverlay("probe", `Agent probing ${APP} — do not touch`);
	const driver = await Driver.start("canvas-probe");

	try {
		await driver.act({ kind: "tool", name: "launch_app", args: { name: APP } });
		await new Promise((r) => setTimeout(r, 1500));
		const win = await findWindow(driver, APP);
		console.log(`target: ${APP} pid=${win.pid} window=${win.windowId}`);
		// Last chance to take your hands off before the probe owns the pointer.
		await overlay.countdown();

		const snap = async (name: string): Promise<{ rows: Row[]; shot: string }> => {
			const shot = `${OUT}/${name}.png`;
			const state = await driver.act({
				kind: "tool",
				name: "get_window_state",
				args: { pid: win.pid, window_id: win.windowId, screenshot_out_file: shot },
			});
			const elements: any[] = JSON.parse(state.structuredJson ?? "{}").elements ?? [];
			const rows = dump(elements, axdom.collect(win.pid));
			SHOT_WIDTH = pngWidth(shot);
			// The console prints a filtered view; the whole dump goes to disk so the tree can
			// be searched afterwards without paying for another run.
			fs.writeFileSync(`${OUT}/${name}.json`, JSON.stringify(rows, null, 1));

			return { rows, shot };
		};

		// An app reopens wherever the last session left it — this probe found Yarn sitting on a
		// settings page — so navigate to the document list before looking for anything. Match a
		// nav item by pattern: the words differ per app, the concept does not.
		const start = await snap("canvas-probe-start");
		const nav = start.rows.find(
			(r) => /button|link|cell|row/i.test(r.role) && NAV.test(r.label) && parseFrame(r.frame),
		);
		if (nav) {
			const [nx, ny, nw, nh] = parseFrame(nav.frame)!;
			const [npx, npy] = toWindowPx(start.rows, nx + Math.round(nw / 2), ny + Math.round(nh / 2));
			console.log(`resetting to document list via "${nav.label}" @px(${npx},${npy})`);
			await driver.act({
				kind: "tool",
				name: "click",
				args: { x: npx, y: npy, pid: win.pid, window_id: win.windowId, delivery_mode: "foreground" },
			});
			await new Promise((r) => setTimeout(r, 2500));
		} else console.log(`no nav item matching ${NAV} — probing from wherever the app opened`);

		// A fresh launch lands on the app's document list, and the canvas lives one level in.
		// Match the document by title so the probe is self-contained and repeatable; a card's
		// label usually carries a modification stamp too, hence the prefix match.
		const landing = await snap("canvas-probe-landing");
		const card = landing.rows.find(
			(r) => r.role === "AXButton" && r.label.startsWith(DOC) && !WALL_CLOCK.test(r.label),
		) ?? landing.rows.find((r) => r.label.trim() === DOC);
		if (card && parseFrame(card.frame)) {
			const [dx, dy, dw, dh] = parseFrame(card.frame)!;
			const [px, py] = toWindowPx(landing.rows, dx + Math.round(dw / 2), dy + Math.round(dh / 2));
			console.log(`opening "${DOC}" -> ${card.role} "${card.label.slice(0, 60)}" @px(${px},${py})`);
			await driver.act({
				kind: "tool",
				name: "double_click",
				args: { x: px, y: py, pid: win.pid, window_id: win.windowId, delivery_mode: "foreground" },
			});
			// A canvas view mounts media and a timeline; it needs longer to settle than a panel.
			await new Promise((r) => setTimeout(r, 6000));
		} else {
			console.log(`could not find a "${DOC}" document — probing whatever is on screen.`);
		}

		// Widen the canvas viewport before dumping. Yarn's timeline, for instance, opens showing
		// ~20s of a 3:22 video, so most clips (and every sync point on them) sit outside the
		// viewport and report degenerate 1x1 frames. The app's OWN magnification control is the
		// lever: screenshot `zoom` would downscale a ~1400px-wide timeline, not enlarge it.
		// WIDEN matches a control by name/class; if the app has no such control, skip it and dump
		// what is visible, since a partial dump still answers the text-affordance question.
		const pre = WIDEN ? await snap("canvas-probe-prewiden") : undefined;
		const zoomBtn = pre?.rows.find(
			(r) => /button/i.test(r.role) && WIDEN!.test(`${r.label} ${r.descriptor}`),
		);
		if (zoomBtn && parseFrame(zoomBtn.frame)) {
			// Click by COORDINATE, not element_index. The driver re-walks the tree on every call
			// and indices are per-walk ordering, so an index read from a snapshot can address a
			// different node by the time the click lands — measured here: index 759 was the
			// Timeline Zoom button at snapshot time and an add-media item at click time, which
			// opened the wrong popover. A frame converted to pixels cannot drift that way.
			const [zx, zy, zw, zh] = parseFrame(zoomBtn.frame)!;
			const [cx, cyy] = toWindowPx(pre!.rows, zx + Math.round(zw / 2), zy + Math.round(zh / 2));
			console.log(`widening via ${zoomBtn.role} "${zoomBtn.label}" ${zoomBtn.descriptor} @px(${cx},${cyy})`);
			await driver.act({
				kind: "tool",
				name: "click",
				args: { x: cx, y: cyy, pid: win.pid, window_id: win.windowId, delivery_mode: "foreground" },
			});
			await new Promise((r) => setTimeout(r, 1200));
			// The control may act directly (a fit button) or open a popup holding a slider.
			// Handle the slider case by dragging its handle to the minimum — the first real
			// mouse_drag this repo has issued, which doubles as the drag smoke test.
			const popup = await snap("canvas-probe-widenpopup");
			const slider = popup.rows.find((r) => r.role === "AXSlider" && parseFrame(r.frame));
			if (slider) {
				// MEASURED, NOT ASSUMED, and the measurement said no. set_value on this slider
				// changes nothing: both extremes rendered pixel-identical timelines. Same
				// failure as set_value on an Electron text field — it writes the AX value but
				// fires no DOM event, so React re-renders from its own state. Recorded here
				// because the next canvas app will tempt someone to try it again.
				console.log(`widen slider present (AXValue ${slider.value}) but set_value does not take on this app — skipping`);
			} else console.log("no slider behind the widen control — assuming it acted directly");
			// Dismiss whatever the control opened; harmless if it opened nothing.
			await driver.act({ kind: "tool", name: "press_key", args: { key: "escape", pid: win.pid, window_id: win.windowId } });
			await new Promise((r) => setTimeout(r, 800));
		} else if (WIDEN) console.log(`no control matching ${WIDEN} — dumping the canvas as it opened`);

		/**
		 * Pan the canvas instead of zooming it. A timeline opens at its start showing a
		 * fraction of the content, and the interesting region is somewhere to the right; the
		 * zoom control turned out to be unsettable, but scrolling a viewport is generic. Snap
		 * at each stop so the operator can pick a target off whichever frame shows one.
		 */
		if (SURVEY > 0) {
			const surveyAt = (n: number) => `canvas-probe-survey-${n}`;
			const pan = async (direction: "left" | "right") => {
				await driver.act({
					kind: "tool",
					name: "scroll",
					args: { direction, amount: 10, x: SURVEY_X, y: SURVEY_Y, pid: win.pid, window_id: win.windowId, delivery_mode: "foreground" },
				});
				await new Promise((r) => setTimeout(r, 700));
			};
			/**
			 * Home the viewport before surveying. An app restores the scroll position it was
			 * left at, so without this the Nth survey frame shows a different region on every
			 * run — measured: coordinates read off one run's frame landed on empty canvas the
			 * next. Panning to the origin first makes frame N mean the same thing every time,
			 * which is what lets an operator read a target off one run and use it in the next.
			 * Overshooting is free: a viewport clamps at its own edge.
			 */
			for (let i = 0; i < HOME; i++) await pan("left");
			await snap(surveyAt(0));
			for (let i = 1; i <= SURVEY; i++) {
				await pan("right");
				await snap(surveyAt(i));
			}
			console.log(`survey: ${SURVEY + 1} frames at ${OUT}/canvas-probe-survey-*.png`);
		}

		const before = await snap("canvas-probe-0");
		report("BEFORE", before.rows);
		console.log(`\nscreenshot: ${before.shot}`);

		if (x === undefined || y === undefined) {
			section("next step");
			console.log(
				`Read the canvas target's pixel coordinates off\n` +
					`${before.shot} and re-run:\n\n  npx tsx src/canvas-probe.ts <x> <y>\n`,
			);

			return;
		}

		/**
		 * Is the target an ELEMENT at all? Independent of, and stronger than, the text diff:
		 * if nothing in the tree covers the point, no click can ever reveal a readout for it
		 * and no expectation can ever address it, whatever the diff shows.
		 *
		 * Frames are logical points and the click point is screenshot pixels, so this converts
		 * back through the same window-derived scale as toWindowPx rather than comparing the
		 * two spaces directly. Smallest covering box wins: the window covers every point.
		 */
		const covering = before.rows
			.map((r) => ({ r, f: parseFrame(r.frame) }))
			.filter((e): e is { r: Row; f: [number, number, number, number] } => {
				if (!e.f) return false;
				const [ax, ay] = fromWindowPx(before.rows, x, y);

				return ax >= e.f[0] && ax <= e.f[0] + e.f[2] && ay >= e.f[1] && ay <= e.f[1] + e.f[3];
			})
			.sort((a, b) => a.f[2] * a.f[3] - b.f[2] * b.f[3]);
		section(`ELEMENTS COVERING (${x},${y})`);
		if (covering.length === 0) console.log("none — the point is not inside any element's frame");
		for (const { r, f } of covering.slice(0, 6))
			console.log(`  [${r.index}] ${r.role} "${r.label.slice(0, 40)}" ${r.descriptor} ${f[2]}x${f[3]}`);
		// A control the size of the whole canvas is the canvas, not the target. What would make
		// this addressable is a small box AT the point; anything else means the target is paint.
		const own = covering[0];
		const addressable = own !== undefined && own.f[2] < 120 && own.f[3] < 120;
		console.log(
			addressable
				? `smallest is ${own.f[2]}x${own.f[3]} — small enough to be the target itself`
				: "smallest covering element is canvas-sized — the target is painted, not an element",
		);

		/**
		 * Negative control: wait the same interval and touch nothing. Measures the pixel and
		 * text churn a supposedly-idle screen produces on its own — a playing preview, a
		 * blinking caret, a clock.
		 *
		 * This USED to be a same-from/same-to drag, which is not a null action on a canvas:
		 * on a timeline the mousedown alone scrubs the playhead, so the control moved the
		 * very clock the probe then read as evidence, and the run reported a text affordance
		 * that was really the drag's own side effect. A control that acts is not a control.
		 */
		await new Promise((r) => setTimeout(r, 1500));
		const idle = await snap("canvas-probe-idle");
		section("NEGATIVE CONTROL (idle, no action)");
		console.log(`baseline pixel delta: ${pixelDelta(before.shot, idle.shot) ?? "unavailable"}`);
		const idleChurn = idle.rows.filter((r) => !new Set(before.rows.map(key)).has(key(r)) && text(r));
		console.log(`elements that changed while idle: ${idleChurn.length}`);
		for (const r of idleChurn.slice(0, 10))
			console.log(`  [${r.index}] ${r.role} "${r.label}" value="${r.value}" @(${r.frame})`);

		/**
		 * Second control, and the one that matters: click a point on the SAME canvas that is
		 * not the target. A canvas responds to any click — a timeline scrubs its playhead —
		 * so text that appears after clicking the target is only evidence if it does NOT also
		 * appear after clicking beside it. Without this the probe reads the global playhead
		 * clock as a per-sync-point readout, which is exactly what it did on its first run.
		 */
		const decoyKeys = new Set<string>();
		if (DECOY_X !== undefined && DECOY_Y !== undefined) {
			await driver.act({
				kind: "tool",
				name: "click",
				args: { x: DECOY_X, y: DECOY_Y, pid: win.pid, window_id: win.windowId, delivery_mode: "foreground" },
			});
			await new Promise((r) => setTimeout(r, 900));
			const decoy = await snap("canvas-probe-decoy");
			const idleKeys = new Set(idle.rows.map(key));
			const changed = decoy.rows.filter((r) => !idleKeys.has(key(r)) && text(r));
			// Identify the SLOT, not its contents: role+frame. The playhead clock keeps its
			// place in the transport bar and only its text changes, so keying on the text
			// would let the same element re-qualify as evidence with a different number in it.
			// Not element_index either — indices are per-walk ordering and drift between calls.
			for (const r of changed) decoyKeys.add(`${r.role}|${r.frame}`);
			section(`DECOY CONTROL: click @(${DECOY_X},${DECOY_Y}) — same canvas, not the target`);
			console.log(`pixel delta: ${pixelDelta(idle.shot, decoy.shot) ?? "unavailable"} (window)`);
			console.log(`             ${localDelta(idle.shot, decoy.shot, DECOY_X, DECOY_Y) ?? "unavailable"} (around the click — should be ~0 for empty canvas)`);
			console.log(`elements that changed: ${changed.length} (these can never count as evidence)`);
			for (const r of changed.slice(0, 12))
				console.log(`  [${r.index}] ${r.role} "${r.label}" value="${r.value}" @(${r.frame})`);
		} else console.log("\nno DECOY_X/DECOY_Y given — cannot distinguish target-specific text from any-click churn");

		// Selecting a sync point is what would reveal a readout, if one exists.
		await driver.act({
			kind: "tool",
			name: "click",
			args: { x, y, pid: win.pid, window_id: win.windowId, delivery_mode: "foreground" },
		});
		await new Promise((r) => setTimeout(r, 900));
		const after = await snap("canvas-probe-1");
		report(`AFTER click @(${x},${y})`, after.rows);
		console.log(`click pixel delta: ${pixelDelta(idle.shot, after.shot) ?? "unavailable"} (window)`);
		/**
		 * Did the click land? Everything downstream is conditional on this, and a whole-window
		 * delta cannot say — a 5px dot is lost in 1568x882. If the target did not visibly
		 * react, "no text appeared" says nothing about the app.
		 */
		const hit = localDelta(idle.shot, after.shot, x, y);
		console.log(`                   ${hit ?? "unavailable"} (around the click)`);

		// What APPEARED is the signal, measured against the IDLE snapshot rather than the
		// original one: anything that also changed on its own is churn, not evidence.
		const seen = new Set(idle.rows.map(key));
		const appeared = after.rows.filter((r) => !seen.has(key(r)) && text(r));
		section(`APPEARED after click: ${appeared.length}`);
		for (const r of appeared.slice(0, 40)) {
			const churn = decoyKeys.has(`${r.role}|${r.frame}`) ? "  [also changed on the decoy click — not evidence]" : "";
			console.log(`  [${r.index}] ${r.role} "${r.label}" value="${r.value}" ${r.descriptor} @(${r.frame})${churn}`);
		}

		// Only text the decoy click did NOT also produce can be specific to the target.
		const specific = appeared.filter((r) => !decoyKeys.has(`${r.role}|${r.frame}`));
		const newTimecodes = timecodes(specific);
		/**
		 * GATE 1 — does a synthetic drag move the target?
		 *
		 * Detected WITHOUT knowing what the target looks like: crop the neighbourhood of the
		 * origin and of the destination, and compare each against itself before and after. A
		 * target that moved leaves its origin (origin changes) and arrives at the destination
		 * (destination changes). A target that ignored the drag leaves both roughly untouched.
		 * That reasoning holds for a dot, a handle, a node or a knob, which is the point — no
		 * colour, no shape, nothing about this app.
		 *
		 * The confound is a canvas that repaints on any pointer input (this timeline redraws
		 * its playhead wherever you press). Hence the same before/after crops are taken for the
		 * DECOY drag too: whatever a drag over inert canvas produces is the floor the real
		 * drag has to clear.
		 */
		if (DRAG_DX !== 0) {
			const dragFrom = async (fx: number, fy: number, tag: string) => {
				const pre = await snap(`canvas-probe-${tag}-pre`);
				await driver.act({
					kind: "tool",
					name: "drag",
					args: {
						from_x: fx,
						from_y: fy,
						to_x: fx + DRAG_DX,
						to_y: fy,
						duration_ms: 600,
						steps: 40,
						pid: win.pid,
						window_id: win.windowId,
						delivery_mode: "foreground",
					},
				});
				await new Promise((r) => setTimeout(r, 1200));
				const post = await snap(`canvas-probe-${tag}-post`);

				return {
					origin: localDelta(pre.shot, post.shot, fx, fy),
					dest: localDelta(pre.shot, post.shot, fx + DRAG_DX, fy),
					pre,
					post,
				};
			};

			section(`GATE 1: drag ${DRAG_DX}px right`);
			const real = await dragFrom(x, y, "drag");
			console.log(`target @(${x},${y}): origin ${real.origin}, destination ${real.dest}`);
			// Drag the decoy back the other way, so the control cannot double as a second nudge
			// of the real target and both drags end where they started.
			let floor = 0;
			if (DECOY_X !== undefined && DECOY_Y !== undefined) {
				const ctl = await dragFrom(DECOY_X, DECOY_Y, "dragctl");
				floor = Math.max(ctl.origin ?? 0, ctl.dest ?? 0);
				console.log(`decoy  @(${DECOY_X},${DECOY_Y}): origin ${ctl.origin}, destination ${ctl.dest}`);
			}
			const moved = (real.origin ?? 0) > floor * 1.5 && (real.dest ?? 0) > floor * 1.5;
			console.log(
				moved
					? `MOVED — both ends changed more than a drag over inert canvas (floor ${floor}). Actuation works.`
					: `NO MOVEMENT beyond what dragging inert canvas produces (floor ${floor}). Either the app` +
							"\nignores synthetic drags, or the drag missed the target. Check the -pre/-post frames.",
			);
			console.log(`frames: ${OUT}/canvas-probe-drag-{pre,post}.png`);

			/**
			 * Put it back. A probe that leaves the document edited is not read-only, and the next
			 * run's coordinates would be measured against a canvas this one changed.
			 *
			 * Undo, NOT a reverse drag — the reverse drag was tried first and did nothing, twice.
			 * Two generic reasons, both worth knowing before writing any coordinate action:
			 *
			 * 1. A canvas that draws an indicator at the last press point leaves that indicator
			 *    sitting ON the thing you just dropped. Pressing there again grabs the indicator,
			 *    not the target. Grabbing a moved object is therefore never symmetric with moving
			 *    it, and "drag back" is not an undo primitive.
			 * 2. A keyboard shortcut goes to the focused control, and a probe leaves focus
			 *    wherever it last acted — which may be a text field in a side panel. So click a
			 *    neutral point INSIDE the canvas before sending the shortcut. Without that click
			 *    four undos in a row reported success and changed nothing.
			 *
			 * Verified by comparing against the pre-drag frame rather than by local delta: a
			 * local crop cannot distinguish "the object came back" from "the indicator moved".
			 */
			await driver.act({
				kind: "tool",
				name: "click",
				args: { x: UNDO_FOCUS_X, y, pid: win.pid, window_id: win.windowId, delivery_mode: "foreground" },
			});
			await new Promise((r) => setTimeout(r, 900));
			for (let i = 0; i < UNDO_PRESSES; i++) {
				await driver.act({
					kind: "tool",
					name: "hotkey",
					args: { keys: ["cmd", "z"], pid: win.pid, window_id: win.windowId, delivery_mode: "foreground" },
				});
				await new Promise((r) => setTimeout(r, 1000));
			}
			const restored = await snap("canvas-probe-restored");
			const back = rowDelta(real.pre.shot, restored.shot, y);
			const moved_ = rowDelta(real.pre.shot, real.post.shot, y);
			console.log(
				`restore: ${back} px differ from the pre-drag frame along the target's row ` +
					`(the drag itself changed ${moved_}).` +
					(back !== undefined && moved_ !== undefined && back < moved_ / 4
						? " Document restored."
						: " NOT RESTORED — undo it by hand before the next run."),
			);
		}

		section("VERDICT");
		/**
		 * A dead click is not a measurement. But "did it land" cannot be answered by the pixels
		 * around the point either: on a timeline, clicking ANYWHERE draws the playhead there, so
		 * the decoy's local delta came out HIGHER than the target's (0.085 vs 0.049) while the
		 * target demonstrably did react — its dot brightened. Local delta stays as a printed
		 * diagnostic and is deliberately not a gate; the honest hit test is whether anything
		 * target-specific survived the decoy, which is the verdict itself.
		 */
		if (hit !== undefined && hit < 0.005 && appeared.length === 0) {
			console.log(`NO VERDICT — nothing changed anywhere near the click (${hit}) and no element`);
			console.log("changed either, so the probe most likely missed the target rather than");
			console.log("discovering it has no readout. Re-read the coordinates off the newest");
			console.log(`${OUT}/canvas-probe-survey-*.png and run again.`);
		} else if (newTimecodes.length > 0 && decoyKeys.size === 0 && DECOY_X === undefined) {
			console.log(`INCONCLUSIVE — ${newTimecodes.length} timecode-shaped element(s) appeared, but with no decoy`);
			console.log("click there is no way to tell them from what ANY click on this canvas produces.");
			console.log("Re-run with DECOY_X/DECOY_Y set to empty canvas space at the same height.");
			for (const r of newTimecodes) console.log(`  [${r.index}] ${r.role} "${r.label}" value="${r.value}" @(${r.frame})`);
		} else if (newTimecodes.length > 0) {
			console.log(`TEXT AFFORDANCE FOUND — ${newTimecodes.length} timecode-shaped element(s) appeared on selection`);
			console.log("and did NOT appear when clicking beside the target, so they are specific to it.");
			console.log("The task is ordinarily text-verifiable. Build the drag action; skip the pixel machinery.");
			for (const r of newTimecodes) console.log(`  [${r.index}] ${r.role} "${r.label}" value="${r.value}" @(${r.frame})`);
		} else if (timecodes(appeared).length > 0) {
			console.log("NO TEXT AFFORDANCE — every timecode that appeared on the target click also appeared");
			console.log("on the decoy click, so it reflects the canvas responding to a click at all (a playhead,");
			console.log("a hover readout), not the target's own state. Verification falls back to the pixel");
			console.log("channel, and done(success:true) must be rejected.");
			if (!addressable)
				console.log("Corroborated structurally: no element covers the target either (see above).");
		} else if (timecodes(after.rows).length > 0 && !addressable) {
			console.log("NO TEXT AFFORDANCE. The click landed (see the local delta above) and produced no");
			console.log("timecode the decoy did not also produce, and no element covers the target — it is");
			console.log("painted into the canvas. The timecodes the tree does hold belong to other things");
			console.log("(a playhead that any click moves, a total duration, ruler labels); none is a");
			console.log("readout of THIS target. Verification falls back to the pixel channel, and");
			console.log("done(success:true) must be rejected — a pixel delta proves movement, not correctness.");
		} else if (timecodes(after.rows).length > 0) {
			console.log("NO NEW timecode on selection, but the tree does contain timecodes (listed above)");
			console.log("and an element does cover the target. Check whether any tracks it: if one moves");
			console.log("with the drag, that is the channel.");
		} else {
			console.log("NO TEXT AFFORDANCE. Verification falls back to the pixel channel, and");
			console.log("done(success:true) must be rejected — a pixel delta proves movement, not correctness.");
		}
	} finally {
		await driver.close();
		overlay.stop();
	}
}

main().catch((err) => {
	console.error("canvas-probe failed:", err);
	process.exit(1);
});
