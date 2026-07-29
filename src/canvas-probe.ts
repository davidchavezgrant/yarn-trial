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
 * A canvas usually opens showing a fraction of its content, and off-viewport children report
 * degenerate frames. Most apps have some control that widens the view; its name is the app's
 * business, so match on a pattern the operator can override rather than a known class.
 */
const WIDEN = new RegExp(process.env.WIDEN ?? "zoom|fit", "i");
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
		const pre = await snap("canvas-probe-prewiden");
		const zoomBtn = pre.rows.find(
			(r) => /button/i.test(r.role) && WIDEN.test(`${r.label} ${r.descriptor}`),
		);
		if (zoomBtn && parseFrame(zoomBtn.frame)) {
			// Click by COORDINATE, not element_index. The driver re-walks the tree on every call
			// and indices are per-walk ordering, so an index read from a snapshot can address a
			// different node by the time the click lands — measured here: index 759 was the
			// Timeline Zoom button at snapshot time and an add-media item at click time, which
			// opened the wrong popover. A frame converted to pixels cannot drift that way.
			const [zx, zy, zw, zh] = parseFrame(zoomBtn.frame)!;
			const [cx, cyy] = toWindowPx(pre.rows, zx + Math.round(zw / 2), zy + Math.round(zh / 2));
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
				// SET the value rather than dragging to it. The AX node is the thumb, not the
				// track, so a drag would need the track's extent — app-specific layout this
				// probe must not encode — and it would seize the physical mouse for the
				// duration. AXValue is settable and normalized on any AXSlider in any
				// framework, so one call does it: no geometry, no pointer, no app knowledge.
				console.log(`widening: set slider AXValue ${slider.value} -> 0`);
				await driver.act({
					kind: "tool",
					name: "set_value",
					args: { element_index: slider.index, value: "0", pid: win.pid, window_id: win.windowId },
				});
				await new Promise((r) => setTimeout(r, 1000));
			} else console.log("no slider behind the widen control — assuming it acted directly");
			// Dismiss whatever the control opened; harmless if it opened nothing.
			await driver.act({ kind: "tool", name: "press_key", args: { key: "escape", pid: win.pid, window_id: win.windowId } });
			await new Promise((r) => setTimeout(r, 800));
		} else console.log(`no control matching ${WIDEN} — dumping the canvas as it opened`);

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

		// 1d's negative control, run first: a no-op drag (same from and to) measures the
		// pixel churn a static screen produces on its own — a playing preview or a blinking
		// caret. Without this number, any threshold on the real drag's delta is invented.
		await driver.act({
			kind: "tool",
			name: "drag",
			args: { from_x: x, from_y: y, to_x: x, to_y: y, duration_ms: 600, steps: 40, pid: win.pid, window_id: win.windowId, delivery_mode: "foreground" },
		});
		await new Promise((r) => setTimeout(r, 900));
		const noop = await snap("canvas-probe-noop");
		section("NEGATIVE CONTROL (no-op drag)");
		console.log(`baseline pixel delta: ${pixelDelta(before.shot, noop.shot) ?? "unavailable"}`);

		// Selecting a sync point is what would reveal a readout, if one exists.
		await driver.act({
			kind: "tool",
			name: "click",
			args: { x, y, pid: win.pid, window_id: win.windowId, delivery_mode: "foreground" },
		});
		await new Promise((r) => setTimeout(r, 900));
		const after = await snap("canvas-probe-1");
		report(`AFTER click @(${x},${y})`, after.rows);
		console.log(`click pixel delta: ${pixelDelta(noop.shot, after.shot) ?? "unavailable"}`);

		// What APPEARED is the signal. A timecode present both before and after is a clock
		// somewhere else in the UI; one that shows up on selection belongs to the selection.
		const seen = new Set(before.rows.map(key));
		const appeared = after.rows.filter((r) => !seen.has(key(r)) && text(r));
		section(`APPEARED after click: ${appeared.length}`);
		for (const r of appeared.slice(0, 40))
			console.log(`  [${r.index}] ${r.role} "${r.label}" value="${r.value}" ${r.descriptor} @(${r.frame})`);

		const newTimecodes = timecodes(appeared);
		section("VERDICT");
		if (newTimecodes.length > 0) {
			console.log(`TEXT AFFORDANCE FOUND — ${newTimecodes.length} timecode-shaped element(s) appeared on selection.`);
			console.log("The task is ordinarily text-verifiable. Build the drag action; skip the pixel machinery.");
			for (const r of newTimecodes) console.log(`  [${r.index}] ${r.role} "${r.label}" value="${r.value}" @(${r.frame})`);
		} else if (timecodes(after.rows).length > 0) {
			console.log("NO NEW timecode on selection, but the tree does contain timecodes (listed above).");
			console.log("Check whether any tracks the sync point: if one moves with the drag, that is the channel.");
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
