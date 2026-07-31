import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { nativeDir } from "./paths.js";

/**
 * DOM enrichment for the AX observation, without CDP.
 *
 * Chromium derives its AX tree from the DOM and then discards most of the source node:
 * `class`, `id`, `data-*` are not part of the ARIA mapping, so an icon button with no
 * aria-label reaches us as AXButton "" — an anonymous control the model can only address
 * by frame. CDP would give the DOM back, but it needs a Chromium target with a reachable
 * debugging port, which we cannot assume on customer machines and which does not exist at
 * all for native AppKit apps.
 *
 * What Chromium *does* keep is a pair of nonstandard NSAccessibility attributes carrying
 * the originating node's id and class list (AXDOMIdentifier / AXDOMClassList), plus
 * AXHelp, AXDescription, AXPlaceholderValue and AXURL. cua-driver never reads them. The
 * `native/axdom` sidecar walks the same tree and emits exactly those, and this module
 * joins them onto the driver's elements.
 *
 * Why a native sidecar and not more TypeScript: these attributes only exist behind the
 * macOS Accessibility C API (AXUIElementCopyAttributeValue), which Node cannot call —
 * something compiled has to exist somewhere. The driver's Rust core is that something
 * today, but its element projection is sealed in a published binary; the remaining
 * options are an FFI bridge package (still a native addon, plus manual CFRelease /
 * CFGetTypeID juggling in-process), forking the driver's Rust, or 120 lines of Swift.
 * The sidecar is the smallest of the three. Running it as a separate process is then
 * nearly free and buys hang isolation: AX calls block synchronously on the target app,
 * so a wedged app costs a killed subprocess at the timeout below instead of a frozen
 * agent. Swift needs CLT only to BUILD — the compiled binary runs on any Mac (Swift
 * runtime ships with macOS since 10.14.4), so end users never need a toolchain.
 * Durable exit: upstream the attribute passthrough into cua-driver, then delete
 * native/ and the frame-join outright.
 *
 * What we lose without it: names for anonymous interactive controls. On Yarn that is
 * 37 of 64 (play button, toolbar icons); the agent falls back to guessing from frame
 * geometry and screenshots. Note the sidecar does NOT cover canvas-rendered content —
 * that has no DOM at all and is handled by the pixel-delta and visual-judge layers.
 *
 * Measured on Yarn (1488 nodes): 955 of 1044 anonymous nodes gain a name, including 37 of
 * the 64 anonymous interactive controls.
 *
 * Everything here is best-effort and non-fatal. A missing binary, a native app with no
 * DOM attributes, or a slow walk degrades to exactly the observation we had before.
 */

const BIN = `${nativeDir()}/axdom`;

/** Frame-keyed row from the sidecar. */
interface DomRow {
	x: number;
	y: number;
	w: number;
	h: number;
	role: string;
	domId?: string;
	domClass?: string;
	help?: string;
	description?: string;
	placeholderValue?: string;
	uRL?: string;
	roleDescription?: string;
}

export interface DomEnrichment {
	/** Extra descriptor for an element, already formatted for the observation line. */
	byFrame: Map<string, string>;
	/** Rows the sidecar produced, for diagnostics. */
	rows: number;
	/** Why enrichment is unavailable, when it is. */
	unavailable?: string;
}

export const EMPTY: DomEnrichment = { byFrame: new Map(), rows: 0, unavailable: "not attempted" };

/**
 * Frame geometry is the only identifier both walks observe: element_index is per-walk
 * ordering and the two walks visit different node sets, so indices are not comparable.
 *
 * The sidecar emits whole points — Swift's `.rounded()`, half away from zero — so the
 * driver's raw frame values must round the same way before keying, or any sub-point AX
 * coordinate silently unjoins its element (it just stays anonymous, and the measured join
 * rate holds only while driver frames happen to be integral). `Math.round` alone is not
 * that rounding: it takes -0.5 to 0 where Swift takes it to -1.
 */
const round = (n: number) => Math.sign(n) * Math.round(Math.abs(n));
const frameKey = (x: number, y: number, w: number, h: number) =>
	`${round(x)},${round(y)},${round(w)},${round(h)}`;

/**
 * Class lists are noisy in both directions: framework chrome (`RootView`, `ClientView`)
 * says nothing about the app, and BEM chains repeat their ancestors. Keep the most
 * specific-looking token and drop the generic ones.
 */
const FRAMEWORK_CLASSES = new Set([
	"RootView", "NonClientView", "NativeFrameViewMac", "ClientView", "View", "app", "root",
]);

export function bestClass(domClass: string): string {
	const tokens = domClass.split(/\s+/).filter((t) => t && !FRAMEWORK_CLASSES.has(t));
	if (!tokens.length) return "";

	// `icon icon--name--chevronDown` -> the modifier carries the meaning; BEM chains
	// like `libraryPage-sideMenu-orgBadgeBtn` are already the most specific token.
	return tokens.sort((a, b) => b.length - a.length)[0];
}

/**
 * Component libraries mint DOM ids at render time (Radix: `radix-_r_sj_`, MUI: `:r3:`).
 * They are unstable across renders and identical across siblings, so they are worse than
 * useless as identifiers — they look addressable and are not.
 */
const GENERATED_ID = /^(radix-|:r|mui-|headlessui-|react-aria|:R[0-9a-z]+:)|_r_[0-9a-z]+_$/i;

/** Build the parenthetical we append to an element line, or "" if nothing useful. */
export function descriptorFor(row: DomRow): string {
	const parts: string[] = [];
	if (row.domId && !GENERATED_ID.test(row.domId)) parts.push(`#${row.domId}`);
	const cls = row.domClass ? bestClass(row.domClass) : "";
	if (cls) parts.push(`.${cls}`);
	if (row.help) parts.push(`help="${row.help.slice(0, 60)}"`);
	if (row.description && row.description !== row.help) {
		// Chromium's stock placeholder for unlabeled images is pure noise.
		if (!row.description.startsWith("To get missing image descriptions"))
			parts.push(`desc="${row.description.slice(0, 60)}"`);
	}
	if (row.placeholderValue) parts.push(`placeholder="${row.placeholderValue.slice(0, 40)}"`);
	if (row.uRL) parts.push(`url="${row.uRL.slice(0, 60)}"`);

	return parts.join(" ");
}

export interface SidecarStatus {
	path: string;
	/** The binary is present AND this machine can execute it. */
	usable: boolean;
	/** Why not, or why it is switched off. Absent when usable. */
	problem?: string;
}

/**
 * Whether this machine can actually run the sidecar — asked by `doctor`, not by the agent.
 *
 * `collect()` deliberately swallows all of this, because a run without enrichment is still a
 * run. The cost of that kindness is that a host missing the sidecar looks identical to a host
 * that has it: the only trace is `domEnrichment.unavailable` buried in a run log nobody grades.
 * On the fleet the binary arrives purely as an rsync'd build artifact from whichever checkout
 * provisioned it, so "never built" and "built for the other architecture" are both live, and
 * both cost 37 of 64 anonymous interactive controls on the app we measured.
 *
 * Executes it rather than stat'ing it or parsing `file` output, because the question is
 * whether it RUNS here — an arm64 binary on an Intel Mac, or one whose linkage is broken,
 * passes every test that does not try. With no arguments it prints usage and exits 2, so any
 * numeric exit status is proof it ran; only a failure to spawn at all is disqualifying.
 */
export function sidecarStatus(bin: string = BIN, exec: (b: string) => void = probeSidecar): SidecarStatus {
	if (process.env.AXDOM === "0") return { path: bin, usable: false, problem: "disabled by AXDOM=0" };
	if (!fs.existsSync(bin))
		return { path: bin, usable: false, problem: "not built — run npm run build:native, then re-provision" };

	try {
		exec(bin);
	} catch (e) {
		const err = e as { status?: number; code?: string; message?: string };
		if (typeof err.status === "number") return { path: bin, usable: true };

		return { path: bin, usable: false, problem: `present but will not run here (${err.code ?? err.message}) — rebuild it on this machine's architecture` };
	}

	return { path: bin, usable: true };
}

function probeSidecar(bin: string): void {
	execFileSync(bin, [], { timeout: 5000, stdio: "ignore" });
}

/**
 * Run the sidecar for a pid and index its rows by frame.
 *
 * Never throws: enrichment is an upgrade, and an observation without it is still the
 * observation the agent ran on before this existed.
 */
export function collect(pid: number, timeoutMs = 4000): DomEnrichment {
	if (process.env.AXDOM === "0") return { byFrame: new Map(), rows: 0, unavailable: "disabled by AXDOM=0" };
	if (!fs.existsSync(BIN))
		return { byFrame: new Map(), rows: 0, unavailable: `sidecar not built (${BIN}) — run npm run build:native` };

	let stdout: string;
	try {
		stdout = execFileSync(BIN, [String(pid)], {
			timeout: timeoutMs,
			maxBuffer: 32 * 1024 * 1024,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch (e: any) {
		return { byFrame: new Map(), rows: 0, unavailable: `sidecar failed: ${e.code ?? e.message}` };
	}

	const byFrame = new Map<string, string>();
	let rows = 0;
	for (const line of stdout.split("\n")) {
		if (!line.startsWith("{")) continue;
		let row: DomRow;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		rows++;
		const descriptor = descriptorFor(row);
		if (!descriptor) continue;
		const key = frameKey(row.x, row.y, row.w, row.h);
		// Frames collide: nested wrappers share their child's bounds. The first row at a
		// frame is the outermost; the last is the innermost and most specific, which is
		// the one whose class actually names the control.
		byFrame.set(key, descriptor);
	}

	return { byFrame, rows };
}

/** Look up the descriptor for a driver element's frame. */
export function lookup(enrichment: DomEnrichment, frame: { x: number; y: number; w: number; h: number } | undefined): string {
	if (!frame) return "";

	return enrichment.byFrame.get(frameKey(frame.x, frame.y, frame.w, frame.h)) ?? "";
}
