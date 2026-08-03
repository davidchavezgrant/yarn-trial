import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { ActionRequest } from "../../types.js";
import type { Driver } from "../driver.js";
import type { InteractiveElement, WindowRef } from "./observation.js";

/**
 * Demo actuation for the AX backend: what a recorded run does instead of AXPress and atomic
 * writes.
 *
 * Forensic origin (run 2026-07-31T05-45-03-416-yarn): an AXPress "click" moves no pointer
 * and did not focus the field it pressed, so the following type_text fell to CGEvent-at-focus
 * and landed in a different, auto-focused field; set_value dumped whole paragraphs with no
 * pointer anchor for the cursor pass to animate; and on step 1 the AX frame AND the driver's
 * click_point were both ~43px off at the source, so the recorded highlight missed the button.
 * One mitigation covers all three: re-resolve the target against a FRESH snapshot — the same
 * geometry the recording frames capture — click it by coordinate, and type for real, in
 * chunks the frame poller can film mid-entry.
 */

/** Word-boundary chunk ceiling; short enough that frames land between chunk calls. */
const CHUNK_MAX = 14;
/** No break at a space earlier than this — tiny chunks read as stutter, not typing. */
const CHUNK_MIN = 8;
/** Per-keystroke delay on the driver's CGEvent path (it accepts 0-200ms). */
const TYPE_DELAY_MS = 70;
/** Past this text length the step's duration is bounded instead: bigger chunks, faster keys. */
const LONG_TEXT_CHARS = 200;
/** Chunk ceiling for long texts. */
const LONG_CHUNK_MAX = 20;
/** Keystroke delay for long texts. */
const LONG_TYPE_DELAY_MS = 40;

export interface FreshElement {
	role: string;
	name: string;
	/** Bounds in SCREENSHOT PIXELS — the space coordinate actions consume. */
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface FreshSnapshot {
	elements: FreshElement[];
	/** The screenshot this snapshot wrote; absent when the driver produced none. */
	shotPath?: string;
}

/**
 * One fresh get_window_state — elements plus screenshot, nothing else. Deliberately lighter
 * than observe(): no axdom sidecar, no haystack, no ancestor naming. The rects and the
 * screenshot come from the same driver call, so a click point computed from them cannot
 * disagree with what the video shows the way a stale observation's frame can.
 */
/**
 * Read until the layout stops moving, then return.
 *
 * A single snapshot can be taken mid-relayout, and a demo run makes that likely: `--record`
 * STAGES the window to fill its display at run start, so the first read lands while Chromium is
 * still reflowing. Measured on 2026-08-03 (run 2026-08-03T00-04-39-239): the SAME "New Draft"
 * button reported y=21 on the first observation and y=74 on the next. Step 1 clicked 53px above
 * the button and failed; step 2 clicked the settled rect and worked.
 *
 * That is the whole of the "~43px Library-page AX offset" that had been open since 07-31 and
 * read as a coordinate-mapping bug. It is not a mapping bug: the transform is identical on both
 * reads and its inputs check out (window 1570x970, shot 1568x969, heightGap 0.24pt). It is a
 * snapshot of a page that had not finished moving. AXPress hid it for unfilmed runs — it
 * actuates by identity and ignores coordinates — which is exactly why filmed ax collapsed to
 * 2/13 while unfilmed ax held 26/39.
 *
 * Two reads that AGREE, rather than a fixed sleep: a sleep long enough for the worst case is
 * paid by every step, and one tuned to the average still misses. Bounded, and the last read is
 * used regardless — a page that never settles must not hang the run.
 */
export async function freshSnapshot(driver: Driver, win: WindowRef, shotPath: string): Promise<FreshSnapshot> {
	const tries = Number(process.env.FRESH_SNAPSHOT_TRIES ?? 3);
	const waitMs = Number(process.env.FRESH_SNAPSHOT_SETTLE_MS ?? 250);
	let prev: FreshSnapshot | undefined;
	for (let i = 0; i < Math.max(1, tries); i++) {
		const shot = await freshSnapshotOnce(driver, win, shotPath);
		if (prev && geometryAgrees(prev.elements, shot.elements)) return shot;
		prev = shot;
		if (i < tries - 1) await new Promise((r) => setTimeout(r, waitMs));
	}

	return prev as FreshSnapshot;
}

/**
 * Do two reads describe the same layout? Compared over NAMED elements by (name, role) so a
 * list that merely reordered does not read as movement, and by position only — a control whose
 * rect is unchanged is settled whatever else the page did. One point of tolerance absorbs
 * rounding in the points→pixels scale.
 */
function geometryAgrees(a: FreshElement[], b: FreshElement[]): boolean {
	const key = (e: FreshElement): string => `${e.role}\u0000${e.name}`;
	const before = new Map(a.filter((e) => e.name).map((e) => [key(e), e]));
	let compared = 0;
	for (const e of b) {
		if (!e.name) continue;
		const was = before.get(key(e));
		if (!was) continue;
		compared++;
		if (Math.abs(was.x - e.x) > 1 || Math.abs(was.y - e.y) > 1) return false;
	}

	// Nothing comparable means nothing to trust — treat it as unsettled and read again.
	return compared > 0;
}

async function freshSnapshotOnce(driver: Driver, win: WindowRef, shotPath: string): Promise<FreshSnapshot> {
	// Shot names carry no run stamp, so a PNG from an earlier step sits at this exact path
	// and would aim the centroid at the previous screen (the trap observe() documents).
	try {
		fs.rmSync(shotPath, { force: true });
	} catch {}
	const state = await driver.act({
		kind: "tool",
		name: "get_window_state",
		args: { pid: win.pid, window_id: win.windowId, screenshot_out_file: shotPath },
	});
	const structured = JSON.parse(state.structuredJson ?? "{}");
	const elements: any[] = structured.elements ?? [];
	// The same frame→pixel conversion observe() derives (src/core/harness/observation.ts):
	// AX frames are screen-global logical points, screenshots are window-local pixels.
	const winEl = elements.find((e) => e.role === "AXWindow" && (e.frame?.w ?? 0) > 0);
	const shotW = Number(structured.screenshot_width ?? 0);
	const scale = winEl && shotW ? shotW / winEl.frame.w : 0;
	const out: FreshElement[] = [];
	if (scale)
		for (const e of elements) {
			if (!e.frame || e.frame.w <= 0 || e.frame.h <= 0) continue;
			out.push({
				role: String(e.role ?? ""),
				name: (e.label ?? "").toString().replace(/\s+/g, " "),
				x: Math.round((e.frame.x - winEl.frame.x) * scale),
				y: Math.round((e.frame.y - winEl.frame.y) * scale),
				w: Math.round(e.frame.w * scale),
				h: Math.round(e.frame.h * scale),
			});
		}

	return { elements: out, shotPath: fs.existsSync(shotPath) ? shotPath : undefined };
}

export interface ResolvedRect {
	x: number;
	y: number;
	w: number;
	h: number;
	/** "stale": the fresh tree could not answer unambiguously, so the model's rect stands. */
	source: "fresh" | "stale";
}

/**
 * Re-resolve a stale target against the fresh tree. Exact (role, name) identity first — the
 * same identity recipes and the journal match on — then rect overlap breaks ties. Ambiguity
 * falls back to the stale rect rather than guessing between distinct candidates (replay.ts's
 * rule, with a rect fallback instead of an error because a click must still land somewhere).
 */
export function resolveFresh(
	stale: { role: string; name: string; x: number; y: number; w: number; h: number },
	fresh: FreshElement[],
): ResolvedRect {
	const named = stale.name ? fresh.filter((e) => e.role === stale.role && e.name === stale.name) : [];
	if (named.length === 1) return { x: named[0].x, y: named[0].y, w: named[0].w, h: named[0].h, source: "fresh" };

	// Ambiguous or unnamed (a DOM-descriptor name has no AX label to match in this light
	// snapshot): the candidate overlapping the stale rect most is the same control after a
	// re-layout. The winner must be unique and actually overlap — equal claims are a tie.
	const pool = named.length > 1 ? named : fresh.filter((e) => e.role === stale.role);
	let best: FreshElement | undefined;
	let bestArea = 0;
	let tied = false;
	for (const e of pool) {
		const w = Math.min(stale.x + stale.w, e.x + e.w) - Math.max(stale.x, e.x);
		const h = Math.min(stale.y + stale.h, e.y + e.h) - Math.max(stale.y, e.y);
		const area = w > 0 && h > 0 ? w * h : 0;
		if (area > bestArea) {
			best = e;
			bestArea = area;
			tied = false;
		} else if (area === bestArea && area > 0) tied = true;
	}
	if (best && !tied) return { x: best.x, y: best.y, w: best.w, h: best.h, source: "fresh" };

	return { x: stale.x, y: stale.y, w: stale.w, h: stale.h, source: "stale" };
}

/**
 * Where inside the rect the click lands: the contrast-weighted centroid of the crop's
 * non-background pixels, clamped to the rect's middle half. A control's glyph is rarely
 * centred in its hit box, and a recorded click at the geometric centre of a wide row reads
 * as a miss. Background is the crop's modal tone; weight is contrast against it. Shelled to
 * python + PIL like pixelDelta — the node dependencies include no image decoder. Any failure
 * (no screenshot, flat crop, no PIL) answers the rect centre.
 */
export function visibleCentroid(
	shotPath: string | undefined,
	rect: { x: number; y: number; w: number; h: number },
): { x: number; y: number } {
	const centre = { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) };
	if (!shotPath || rect.w <= 0 || rect.h <= 0 || !fs.existsSync(shotPath)) return centre;

	const script = `
import sys
from collections import Counter
from PIL import Image
im = Image.open(sys.argv[1]).convert("L")
x, y, w, h = (int(v) for v in sys.argv[2:6])
box = (max(0, x), max(0, y), min(im.width, x + w), min(im.height, y + h))
if box[2] <= box[0] or box[3] <= box[1]:
    print("FLAT"); sys.exit(0)
crop = im.crop(box)
px = list(crop.getdata())
bg = Counter(px).most_common(1)[0][0]
tw = sx = sy = 0.0
for i, p in enumerate(px):
    wgt = abs(p - bg)
    if wgt <= 16: continue
    tw += wgt; sx += wgt * (i % crop.width); sy += wgt * (i // crop.width)
if tw == 0: print("FLAT")
else: print(sx / tw + box[0] - x, sy / tw + box[1] - y)
`;
	try {
		const out = execFileSync(
			"python3",
			["-W", "ignore::DeprecationWarning", "-c", script, shotPath, String(rect.x), String(rect.y), String(rect.w), String(rect.h)],
			{ encoding: "utf8" },
		).trim();
		if (out === "FLAT") return centre;
		const [cx, cy] = out.split(/\s+/).map(Number);
		if (!Number.isFinite(cx) || !Number.isFinite(cy)) return centre;
		// The middle-half clamp: content pulls the point toward itself, but the click stays
		// well inside the rect even when the crop caught a bright neighbour.
		const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

		return {
			x: Math.round(clamp(rect.x + cx, rect.x + rect.w / 4, rect.x + (rect.w * 3) / 4)),
			y: Math.round(clamp(rect.y + cy, rect.y + rect.h / 4, rect.y + (rect.h * 3) / 4)),
		};
	} catch {
		return centre;
	}
}

/** Split text into word-boundary chunks that concatenate back to the original exactly. */
export function chunkText(text: string): { chunks: string[]; delayMs: number } {
	const long = text.length > LONG_TEXT_CHARS;
	const max = long ? LONG_CHUNK_MAX : CHUNK_MAX;
	const chunks: string[] = [];
	let i = 0;
	while (i < text.length) {
		if (text.length - i <= max) {
			chunks.push(text.slice(i));
			break;
		}
		let end = i + max;
		// Prefer ending the chunk just after a space so words never split; a word longer
		// than the whole window is split hard rather than sent oversized.
		const space = text.lastIndexOf(" ", end - 1);
		if (space >= i + CHUNK_MIN) end = space + 1;
		chunks.push(text.slice(i, end));
		i = end;
	}

	return { chunks, delayMs: long ? LONG_TYPE_DELAY_MS : TYPE_DELAY_MS };
}

export interface DemoStep {
	request: ActionRequest;
	/** Set when this request types one chunk of the model's text — timed into typedChunks. */
	chunkText?: string;
}

export interface DemoPlan {
	/** Driver calls in order. The executor yields the recording mutex between elements. */
	seq: DemoStep[];
	/** What the run log records as the step's action; the seq is execution detail. */
	logRequest: ActionRequest;
	/** The rect the click point came from — fresh when re-resolution succeeded. */
	target?: { role: string; name: string; x: number; y: number; w: number; h: number; source: "fresh" | "stale" };
	clickPoint?: { x: number; y: number };
	/** The text goes in as real keystrokes; the humanizer keys off the step's typedLive. */
	typedLive?: boolean;
}

/**
 * Actions the demo path translates. Everything else keeps the normal request builder.
 *
 * CLICKS NO LONGER DO, and that is the point (2026-08-03). Demo mode translated element clicks
 * into coordinate clicks to avoid AXPress, "whose click moves no pointer". True — and, it turns
 * out, irrelevant: `src/cursor/track.ts` measured that CGEvent actuation does not move the
 * physical pointer either (1.2% of samples show any delta, and those are teleports). Neither
 * actuator puts a cursor in the frame; the cursor is composited in post from click points the
 * run records either way, which is also how Yarn's own pipeline works.
 *
 * So the reliability was bought for nothing. Filmed ax ran 2/13 against unfilmed ax at 26/39,
 * because a coordinate click depends on geometry being right at that instant while AXPress
 * invokes the element by identity. Clicks go back to identity; the film loses the app's real
 * :hover highlight on the ax path, which is the one genuine cost and is worth 4x reliability.
 *
 * TYPE_TEXT STILL DOES, and for the reason that never stopped being true: AXPress "may focus
 * nothing", and typed text once leaked into Yarn's composer because of it. Text entry needs a
 * real click to place focus, so it keeps the demo sequence.
 *
 * CDP is untouched — `locator.click()` resolves the element and scrolls it into view, so it
 * gets hover AND reliability (8/10 filmed, zero coordinate failures). This split is ax-only.
 */
export function demoTranslatable(a: any): boolean {
	return a?.name === "type_text" && typeof a?.text === "string" && a.text.length > 0;
}

/**
 * Translate a model action into its recorded-run sequence, or null when no demo variant
 * applies (painted-target coordinate clicks, an element handle the observation cannot
 * locate or size) — the caller then falls back to toActionRequest unchanged.
 */
export function demoTranslate(
	a: any,
	win: WindowRef,
	stale: InteractiveElement | undefined,
	snap: FreshSnapshot,
): DemoPlan | null {
	const base = { pid: win.pid, window_id: win.windowId };
	const clickish = a.name === "click" || a.name === "right_click" || a.name === "double_click";

	// Resolve the pointer anchor when the action addresses an element the stale observation
	// can locate. resolveFresh degrades to the stale rect; a zero rect means there is no
	// coordinate to aim at all, and the caller's normal translation is the only option left.
	let target: DemoPlan["target"];
	let point: { x: number; y: number } | undefined;
	if (a.element_index !== undefined && stale) {
		const r = resolveFresh(stale, snap.elements);
		if (r.w > 0 && r.h > 0) {
			target = { role: stale.role, name: stale.name, ...r };
			point = visibleCentroid(snap.shotPath, r);
		}
	}

	if (clickish) {
		if (!point) return null;
		// The painted-target branch shape (toActionRequest): coordinates, foreground — never
		// element_index, whose AXPress moves no pointer and may focus nothing.
		const request: ActionRequest = {
			kind: "tool",
			name: a.name,
			args: { ...base, x: point.x, y: point.y, delivery_mode: "foreground" },
		};

		return { seq: [{ request }], logRequest: request, target, clickPoint: point };
	}

	if (a.name === "type_text" && typeof a.text === "string" && a.text.length > 0) {
		// A named field the fresh tree cannot size is NOT typed at focus — that is the exact
		// leak being fixed. The element-directed write path handles it instead.
		if (a.element_index !== undefined && !point) return null;
		const { chunks, delayMs } = chunkText(a.text);
		const seq: DemoStep[] = chunks.map((c) => ({
			// NO element_index: that forces CGEvent-at-focus — the delivery path that actually
			// works (turn-00007 of the forensic run) and the one that films as typing.
			request: { kind: "tool", name: "type_text", args: { ...base, text: c, delay_ms: delayMs } },
			chunkText: c,
		}));
		if (point)
			seq.unshift({ request: { kind: "tool", name: "click", args: { ...base, x: point.x, y: point.y, delivery_mode: "foreground" } } });

		return {
			seq,
			logRequest: { kind: "tool", name: "type_text", args: { ...base, text: a.text } },
			...(target ? { target } : {}),
			...(point ? { clickPoint: point } : {}),
			typedLive: true,
		};
	}

	return null;
}
