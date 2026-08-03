import type Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { envNum } from "../env.js";
import { MAX_WAIT_MS, OUT, type ObservationBundle } from "../core/harness.js";
import type { Target } from "../core/target.js";
import { webTarget } from "../core/target.js";
import type { ActionRequest } from "../types.js";
import { endpointAlive, ensureElectronEndpoint, KEEP_RENDERING_FLAGS, type PageCandidate, pickMainPage } from "./electron-attach.js";
import { chunkText } from "../core/harness/fresh-target.js";

// Re-exported so the runner's cdp→ax fallback can make its decision through the lazily
// loaded cdp module (run.ts reaches backends ONLY through its selection-branch imports) —
// same one-stop-shop posture as ax.ts's re-exports.
export { EndpointUnavailableError, fallbackEligible } from "./electron-attach.js";

/**
 * CDP-direct backend: drives a Chromium target through playwright-core attached over
 * --remote-debugging-port, with no cua-driver anywhere in the loop.
 *
 * Exists as the productization path named in
 * docs/research/2026-07-30-cua-learnings-for-real-implementation.md: for the in-scope
 * target classes (web apps, Electron), cua's `browser_*` tools are a middleman over the
 * same protocol this speaks directly. Going direct deletes, by construction rather than
 * by workaround, four of that document's liabilities:
 *
 * - **No consent gate.** `browser_prepare`'s per-call token (minted under a pty — see
 *   LIMITATIONS §13) protects arbitrary users' profiles. This backend launches its OWN
 *   Chrome against its own persistent profile, so there is nothing to protect and no
 *   prompt to answer.
 * - **No session lifetime.** The 300s TTL and its 90s heartbeat are cua session
 *   bookkeeping; a CDP connection lives as long as the browser does.
 * - **No shared daemon.** `Driver.close()` killing concurrent runs is what forces the
 *   one-run-per-Mac lease; two CdpBackends on different ports do not know about each
 *   other.
 * - **No node budget.** semantic_v2 caps snapshots at 300 nodes and the cap is not
 *   configurable; `ariaSnapshot` returns the whole tree, so the paging machinery and the
 *   budget-escape framing of `find` are unnecessary (find survives as a convenience).
 *
 * What it does NOT replace, stated plainly: OS-level input. Keys here go through CDP's
 * Input domain to the RENDERER — menu-bar shortcuts, browser-chrome shortcuts, and
 * anything the OS handles never fire. For a web page that is a feature (cmd+w cannot end
 * the run); for native menus it is the gap the AX path or a Swift sidecar covers. Same
 * for window staging and AX-tree perception of non-web chrome.
 *
 * Perception is `page.ariaSnapshot({ mode: "ai", boxes: true })` — the same ref-bearing
 * snapshot playwright-mcp ships on — and actuation resolves those refs with the
 * `aria-ref=` locator engine. Both verified live before this file was written: refs
 * actuate, boxes are viewport CSS pixels, combobox values ride along as [selected]
 * options, and a ref survives unrelated DOM churn while its element stays attached.
 */

/** The verb set the model drives pages with; names match the AX tool where verbs overlap. */
const CDP_ACTIONS = ["click", "right_click", "double_click", "hover", "type_text", "press_key", "scroll", "wait", "navigate"] as const;

/** Where the persistent profile lives. Persistent by design: a human signs into the
 *  target site once per machine (./run browser-login), and every later run inherits
 *  the session. */
const PROFILE_DIR = process.env.CDP_PROFILE_DIR ?? `${OUT}/chrome-profile/${process.env.CDP_PROFILE ?? "yarn-runner"}`;

const CHROME_BIN = process.env.CDP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Off cua's 9222 convention on purpose: a driver-owned Chrome and ours must never collide. */
const DEFAULT_PORT = envNum("CDP_PORT", 9777);

/** Does the endpoint have at least one attachable page? `[ ]` means Chrome has no windows. */
async function hasPageTarget(endpoint: string): Promise<boolean> {
	try {
		const res = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(4000) });
		const list = (await res.json()) as Array<{ type?: string }>;

		return Array.isArray(list) && list.some((t) => t.type === "page");
	} catch {
		// Unreachable or unparseable: let connectOverCDP produce the real error rather than
		// guessing here. Returning true skips the repair, which is the conservative choice.
		return true;
	}
}

/**
 * The no-endpoint refusal, built from what acquire actually knew. The extra clause is the
 * lesson of the 2026-07-31 bench kill: an app target WITHOUT `cdpAttach` never calls
 * ensureElectronEndpoint, so after a caller's cold-start quit there is nothing listening
 * and nothing that would relaunch — and the old message ("launch it with the flag first")
 * read as an operator problem when the real fault was the target's construction. Pure,
 * so the string an unattended run dies with is pinned by tests.
 */
export function noEndpointMessage(target: Target, endpoint: string, port: number, cdpUrlSet: boolean): string {
	const base =
		`no CDP endpoint at ${endpoint}. For an Electron app, launch it with the flag first:\n` +
		`  open -a "<App>" --args --remote-debugging-port=${port}\n` +
		`or point CDP_URL at an existing endpoint.`;
	if (target.kind !== "app" || target.cdpAttach || cdpUrlSet) return base;

	return (
		`${base}\n` +
		`(this app target is not marked cdpAttach, so acquisition never launches "${target.name}" itself — ` +
		`callers that quit the app before acquiring must build the target with electronTarget(), or nothing relaunches it)`
	);
}

/** Open one blank tab over the DevTools HTTP API, giving Playwright a context to attach to. */
async function openBlankPage(endpoint: string): Promise<void> {
	// PUT is what current Chrome requires for /json/new; older builds accepted GET.
	try {
		await fetch(`${endpoint}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(5000) });
	} catch {
		// Non-fatal: if this fails, connectOverCDP fails next with its own message, and a
		// swallowed repair attempt must not mask that.
	}
}

/**
 * Locator timeout. Playwright's 30s default is tuned for tests that wait for apps to
 * settle; here a ref that does not resolve within a few seconds is a stale ref, and the
 * right outcome is a failed step the model can correct, not half a minute of hanging.
 */
const ACTION_TIMEOUT_MS = 5_000;

/** One parsed row of the ai-mode aria snapshot. */
export interface SnapshotRow {
	ref: string;
	role: string;
	name: string;
	/** Current value: a textbox's contents, a combobox's [selected] option. "" when none. */
	value: string;
	/** Nearest NAMED ancestor, from the snapshot's indentation. "" at top level. */
	surface: string;
	/** Viewport CSS pixels, from [box=...]. All zero when the snapshot carried no box. */
	x: number;
	y: number;
	w: number;
	h: number;
	/** Bracket flags on the row: selected, checked, disabled, expanded, active, cursor=pointer… */
	flags: Set<string>;
	interactive: boolean;
	/** True when `name` came from the synthesis pass (nearby row text), not from Chromium's
	 *  accessible-name computation. The wire format is unchanged on purpose — journal,
	 *  teardown and grounding consume the name transparently — the flag exists so nothing
	 *  ever mistakes a synthesized name for author-provided labeling. */
	nameSynthesized?: boolean;
}

/**
 * Roles that take actions. `cursor=pointer` extends this per element: ai-mode marks
 * anything styled clickable, which is how an onclick-bearing div earns a place in the
 * frontier despite its generic role.
 */
const INTERACTIVE_ROLES = new Set([
	"button", "link", "textbox", "searchbox", "combobox", "listbox", "option",
	"checkbox", "radio", "switch", "slider", "spinbutton", "menuitem",
	"menuitemcheckbox", "menuitemradio", "tab", "menubar", "treeitem",
]);

/*
 * ---- Name synthesis for anonymous form controls ---------------------------------------
 *
 * The CDP analogue of the axdom sidecar's enrichment (src/core/axdom.ts): Yarn's settings
 * <select>s carry no aria-label and no associated <label>, so the snapshot yields
 * `combobox [ref=..]` with an EMPTY name while a sibling static text carries the label the
 * human reads ("Cursor Style" — the live run's steps recorded targetRole "combobox",
 * name "", with exactly that text adjacent). Downstream, everything keys controls by
 * (name, surface): detectMutation refuses anonymous targets and optionCommit skips
 * anonymous owners (src/core/journal.ts), so a cdp run that changed the brand cursor
 * journaled NOTHING, teardown restored nothing, and wrong-scope accounting read zero on
 * cdp arms while the axdom-enriched AX path journaled normally. Synthesizing the row label
 * into the name fixes every consumer at once, because they all read the name transparently.
 *
 * Why each source in the brief's priority order is (or is not) trustworthy here:
 * (1) An associated <label>/aria-label needs no synthesis: Chromium's accessible-name
 *     computation already folds those into the snapshot name, so an empty name is PROOF
 *     no author-provided association exists. Source (1) is satisfied before this runs.
 * (2) The nearest static text on the same settings ROW is the label a human reads the
 *     control by — label-left/control-right is the diagnosed Yarn pattern and the dominant
 *     settings-page convention (text trailing a checkbox is the same convention mirrored).
 *     "Same row" is structural (a shared immediate container), never visual guesswork.
 * (3) aria-describedby has no channel on this backend: ai-mode snapshots carry no
 *     description attribute, so there is nothing already-parsed to fall back to.
 *
 * The guards are the moral equivalent of axdom's GENERATED_ID suppression — text that
 * LOOKS like a name but is really a value, helper copy, or another control's label is
 * worse than no name at all, because the journal would pair a mutation onto the wrong
 * control (journal.ts's rationale for refusing anonymous targets applies doubly to
 * misnamed ones). Hence: role-gated to value-bearing form controls, length-capped,
 * value-echo / number-led / sentence-shaped text rejected, pairing never reads across
 * another control, and a label claimed from both sides names neither.
 */

/** Form controls eligible for synthesis — the journal's clientele (value-bearing).
 *  Buttons/links/menuitems are excluded on purpose: an icon button's neighbor text is
 *  routinely unrelated (the axdom sidecar names those from DOM classes instead), and a
 *  wrongly-named control poisons (name, surface) matching everywhere. */
const SYNTH_ROLES = new Set([
	"combobox", "listbox", "textbox", "searchbox", "checkbox", "radio", "switch", "slider", "spinbutton",
]);

/** Roles whose text reads as a row label. Headings are excluded — they title SECTIONS,
 *  and adopting one would name a control after its page ("Probe page", "Screen Clip
 *  Settings"). Interactive roles are excluded wholesale: never synthesize from another
 *  control's name. */
const LABEL_ROLES = new Set(["generic", "paragraph", "strong", "emphasis", "caption", "legend", "term", "definition"]);

/**
 * Clean a candidate label, or reject it with "". Rejections are the garbage guards:
 * - length cap: a paragraph-sized string is helper copy, not a label;
 * - no letters / leading digit: "24", "1.5x", "4px" are VALUES rendered as text;
 * - sentence-shaped (terminal punctuation or an internal sentence break): the description
 *   under a label, which sits closer to the control than the label itself in the common
 *   label/description/control stack — rejecting it lets the scan reach the real label.
 * A trailing colon is presentation ("Cursor Style:"), not part of the name.
 */
function labelText(raw: string): string {
	const t = raw.trim().replace(/:\s*$/, "").trim();
	if (!t || t.length > 60) return "";
	if (!/\p{L}/u.test(t) || /^\d/.test(t)) return "";
	if (/[.!?]$/.test(t) || t.includes(". ")) return "";

	return t;
}

/**
 * Do a label and a control share a settings row? True when one of them is a DIRECT child
 * of the pair's nearest common ancestor and the other is at most one wrapper deeper —
 * which admits plain siblings, a label wrapped in a span beside the control, and a control
 * wrapped in a div beside its label, while refusing cousins under two different row
 * containers (both one deep under a shared section — indistinguishable from a
 * both-wrapped row by depth alone, so BOTH shapes are refused; an occasionally-anonymous
 * control beats one named from the neighboring row).
 */
function sameRow(a: number[], b: number[]): boolean {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	const da = a.length - i;
	const db = b.length - i;

	return Math.min(da, db) === 0 && Math.max(da, db) <= 1;
}

/** One document-order event the synthesis scan walks. Label and blocker are disjoint by
 *  construction (labels are non-interactive roles); claimants are also blockers, so a
 *  pairing can never read ACROSS a control to text on its far side. */
interface SynthEvent {
	/** Ancestor ids, root-down, excluding the node itself. */
	chain: number[];
	/** A control-shaped row (interactive role or clickably-styled). */
	blocker: boolean;
	/** Pre-cleaned candidate label text; "" on non-label events. */
	text: string;
	/** An anonymous form control that wants a name. */
	claimant?: SnapshotRow;
}

/**
 * Nearest qualifying label for the claimant at `ci`, scanning one direction. Disqualified
 * texts (wrong row, or an echo of the control's own value — a custom dropdown renders its
 * current value as adjacent text) are skipped NEUTRALLY, so the scan can reach the real
 * label behind them; any control-shaped row ends the scan cold.
 */
function nearestLabel(events: SynthEvent[], ci: number, dir: -1 | 1): number | undefined {
	const c = events[ci];
	const value = (c.claimant?.value ?? "").trim().toLowerCase();
	for (let j = ci + dir; j >= 0 && j < events.length; j += dir) {
		const e = events[j];
		if (e.text && sameRow(e.chain, c.chain) && e.text.trim().toLowerCase() !== value) return j;
		if (e.blocker) return undefined;
	}

	return undefined;
}

/**
 * Assign synthesized names. Preceding text wins over following (label-left is the
 * diagnosed pattern; the trailing-text direction exists for checkboxes and only fires
 * when nothing precedes). A label with claimants on BOTH sides (control–text–control)
 * names neither: naming either is a guess, and the journal's own rationale ranks a wrong
 * pairing worse than an anonymous control.
 */
function synthesizeNames(events: SynthEvent[]): void {
	const claims = new Map<number, SnapshotRow[]>();
	for (let ci = 0; ci < events.length; ci++) {
		const claimant = events[ci].claimant;
		if (!claimant) continue;
		const li = nearestLabel(events, ci, -1) ?? nearestLabel(events, ci, +1);
		if (li === undefined) continue;
		claims.set(li, [...(claims.get(li) ?? []), claimant]);
	}
	for (const [li, rows] of claims) {
		if (rows.length !== 1) continue;
		rows[0].name = events[li].text;
		rows[0].nameSynthesized = true;
	}
}

/**
 * Parse the ai-mode aria snapshot into flat rows.
 *
 * The format is YAML-shaped but regular enough that a real YAML parser buys only new
 * failure modes: every node is one line of
 * `<indent>- <role> ["name"]? [flag]* [ref=eN]? [box=x,y,w,h]? (: value)?`.
 * Names are double-quoted with backslash escapes; bracket groups never contain `]`;
 * a trailing bare `:` means children follow, while `: text` is the node's own value.
 * Plain text nodes arrive as `- text: …` and matter only as haystack material.
 */
export function parseAiSnapshot(snapshot: string): { rows: SnapshotRow[]; texts: string[] } {
	const rows: SnapshotRow[] = [];
	const texts: string[] = [];
	// (indent, name, row) of every open ancestor; surface lookup walks the names, the
	// [selected]-option value-lift walks the rows — ancestry is what the indentation
	// encodes, and reverse document-order search is not ancestry. The id keys the
	// ancestor chains the name-synthesis pass compares (sameRow above).
	const stack: Array<{ indent: number; name: string; row?: SnapshotRow; id: number }> = [];
	let nextId = 0;
	const events: SynthEvent[] = [];

	for (const raw of snapshot.split("\n")) {
		const m = raw.match(/^(\s*)- (.*)$/);
		if (!m) continue;
		const indent = m[1].length;
		let rest = m[2];

		while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
		const surface = [...stack].reverse().find((s) => s.name)?.name ?? "";
		// Ancestors of THIS node (text lines never push, rows are pushed after their event).
		const chain = stack.map((s) => s.id);
		// Text inside a control is that control's own content (a button's caption, a custom
		// dropdown's value echo) — never a sibling's label. Without this, the second of two
		// dropdowns sharing a row adopts the first one's echo as its name, and a name derived
		// from a neighbor's CURRENT VALUE changes whenever that value does, which breaks the
		// journal's (name, surface) matching across observations. Real control roles only:
		// a cursor=pointer generic is a clickable row CONTAINER, and the label inside one is
		// exactly the wrapped-label shape synthesis exists to read.
		const insideControl = stack.some((s) => s.row && INTERACTIVE_ROLES.has(s.row.role));

		if (rest.startsWith("text:")) {
			const t = rest.slice(5).trim();
			if (t) {
				texts.push(unquote(t));
				// The value-echo lift below, for the bare-text rendering of the same shape.
				const owner = [...stack].reverse().find((s) => s.row?.role === "combobox")?.row;
				if (owner && !owner.value) owner.value = unquote(t);
				const label = labelText(unquote(t));
				if (label && !insideControl) events.push({ chain, blocker: false, text: label });
			}
			continue;
		}

		const roleMatch = rest.match(/^([a-z]+)/);
		if (!roleMatch) continue;
		const role = roleMatch[1];
		rest = rest.slice(role.length);

		let name = "";
		const nameMatch = rest.match(/^ "((?:[^"\\]|\\.)*)"/);
		if (nameMatch) {
			name = nameMatch[1].replace(/\\(.)/g, "$1");
			rest = rest.slice(nameMatch[0].length);
		}

		// The node's own value sits after the last bracket; a bare ":" only announces
		// children. Located FIRST: bracket groups are only meaningful before the separator,
		// and a value that happens to contain a literal "[disabled]" or "[box=…]" must not
		// scan as a flag or geometry.
		const valueMatch = rest.match(/(?:^|\])\s*:\s(.+)$/);
		const value = valueMatch ? unquote(valueMatch[1].trim()) : "";
		const flagRegion = valueMatch ? rest.slice(0, valueMatch.index! + (valueMatch[0].startsWith("]") ? 1 : 0)) : rest;

		const flags = new Set<string>();
		let ref = "";
		let box = { x: 0, y: 0, w: 0, h: 0 };
		for (const b of flagRegion.matchAll(/\[([^\]]+)\]/g)) {
			const body = b[1];
			if (body.startsWith("ref=")) ref = body.slice(4);
			else if (body.startsWith("box=")) {
				const [x, y, w, h] = body.slice(4).split(",").map(Number);
				box = { x, y, w, h };
			} else flags.add(body);
		}

		// A closed <select> renders its options as children; the [selected] one IS the
		// combobox's value, and the value is what the mutation journal diffs. Only `option`
		// rows qualify — every active TAB also carries [selected] — and the receiver must
		// be an ANCESTOR on the stack: the nearest combobox in document order can be an
		// unrelated control in a page header, and lifting onto it makes switching tabs
		// read as a combobox mutation the teardown then tries to "restore".
		if (role === "option" && flags.has("selected") && name) {
			const parent = [...stack].reverse().find((s) => s.row?.role === "combobox" || s.row?.role === "listbox")?.row;
			if (parent && !parent.value) parent.value = name;
		}

		// A CUSTOM dropdown (Radix-style) mounts its options only while OPEN: closed, there
		// is no [selected] child to lift and the current value renders as a plain text child
		// of the trigger instead (`- generic: Pointer-first` under the combobox — the live
		// Yarn shape, probed 2026-08-01). Lift the first text-bearing non-interactive
		// descendant, first-wins like the option lift, or the combobox parses with value ""
		// and the mutation journal can never match a clicked option's label against it.
		// Combobox ONLY: a listbox renders its options as children always, so its first text
		// child is its first option, not a current value.
		if (!INTERACTIVE_ROLES.has(role) && (name || value)) {
			const owner = [...stack].reverse().find((s) => s.row?.role === "combobox")?.row;
			if (owner && !owner.value) owner.value = name || value;
		}

		let row: SnapshotRow | undefined;
		if (ref || name || value) {
			row = {
				ref,
				role,
				name,
				value,
				surface,
				...box,
				flags,
				interactive:
					!!ref && !flags.has("disabled") && (INTERACTIVE_ROLES.has(role) || flags.has("cursor=pointer")),
			};
			rows.push(row);
			// Role-based, not interactive-flag-based, for the blocker: a disabled or
			// ref-less control is still a control, and label pairing must not read past it.
			const blocker = INTERACTIVE_ROLES.has(role) || row.interactive;
			const claimant = SYNTH_ROLES.has(role) && !name.trim() ? row : undefined;
			// Named (or value-only, e.g. `- generic: Cursor Style`) static rows are label
			// material too — the name is preferred as the label-ier of the two.
			const label = !blocker && !insideControl && LABEL_ROLES.has(role) ? labelText(name || value) : "";
			if (blocker || claimant || label) events.push({ chain, blocker, text: label, claimant });
		}
		stack.push({ indent, name, row, id: nextId++ });
	}

	// After the loop, so [selected]-option value-lifts have landed: the value-echo guard
	// in nearestLabel needs each combobox's FINAL value.
	synthesizeNames(events);

	return { rows, texts };
}

function unquote(s: string): string {
	return s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1).replace(/\\(.)/g, "$1") : s;
}

/**
 * Model key names → playwright's. The model speaks the same vocabulary on every backend
 * ("escape", "return", modifiers cmd/option/ctrl/shift); playwright wants DOM key values.
 */
export function playwrightKey(key: string, modifiers?: string[]): string {
	const KEYS: Record<string, string> = {
		escape: "Escape", esc: "Escape", return: "Enter", enter: "Enter", tab: "Tab",
		space: "Space", backspace: "Backspace", delete: "Delete",
		up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
		pageup: "PageUp", pagedown: "PageDown", home: "Home", end: "End",
	};
	const MODS: Record<string, string> = { cmd: "Meta", command: "Meta", meta: "Meta", option: "Alt", alt: "Alt", ctrl: "Control", control: "Control", shift: "Shift" };
	const base = KEYS[key.toLowerCase()] ?? (key.length === 1 ? key : key);
	const mods = (modifiers ?? []).map((m) => MODS[m.toLowerCase()] ?? m);

	return [...mods, base].join("+");
}

/**
 * Exact-origin equality. A prefix match (`startsWith`) adopts https://x.community as
 * https://x.com and then drives it; anything unparseable (a page that has not committed a
 * URL) never matches.
 */
export function originMatches(pageUrl: string, origin: string): boolean {
	try {
		return new URL(pageUrl).origin === origin;
	} catch {
		return false;
	}
}

/**
 * Which existing tab a web run should drive, and whether the run OWNS what it drives.
 *
 * Ownership is what close() needs: a tab the run created — or a blank one it colonized,
 * whose entire content is run residue — is the run's to close on the way out. An adopted
 * tab already on the target origin is the operator's (or browser-login's seed) and must
 * survive the run. Left unclosed, run tabs pile up in the shared flagged Chrome: a bench
 * run's Wikipedia tab was what an operator's sign-in viewer opened onto (2026-07-31).
 *
 * `index: -1` means no usable tab exists — the caller creates one, and owns it.
 */
export function webPageChoice(urls: string[], origin: string): { index: number; owned: boolean } {
	const matching = urls.map((u, i) => i).filter((i) => originMatches(urls[i], origin));
	// Two tabs on the target site: driving the wrong one looks like it worked. Refuse.
	if (matching.length > 1) throw new Error(`${matching.length} tabs are open on ${origin} — close the spares so the target is unambiguous`);
	if (matching.length === 1) return { index: matching[0], owned: false };

	return { index: urls.indexOf("about:blank"), owned: true };
}

/**
 * Slowest observed gap between two captured frames during an act: p90 579ms, max 634ms over
 * the 146 frames of run 2026-08-02T18-51-49-069. The frame loop ASKS for 120ms
 * (RESPONSE_POLL_MS in src/core/agent/recording.ts), but each page.screenshot() costs ~220ms
 * on top, and that is the number that governs — not one gap in that run came in under 220ms.
 */
const FRAME_GAP_CEILING_MS = 640;

/**
 * Demo-mode pointer pacing. The dwell sits between the move and the press so a :hover
 * transition has real wall-clock to render before the click's effect replaces it.
 *
 * It must also outlast the camera, which is what the original 200ms missed: the app really
 * does paint a hover here (an injected mouse.move fires genuine :hover), but at 200ms the
 * dwell was shorter than the FASTEST gap between frames ever observed, so the one moment
 * demo mode exists to film could not land in a frame. Not "often missed" — uncatchable.
 * Nothing surfaced it because the humanizer synthesizes a hover tint unconditionally
 * (src/cursor/track.ts), so every recording looked like hover worked.
 *
 * So: clear FRAME_GAP_CEILING_MS with room. It reads as a deliberate pause rather than
 * hesitation, and inter-action latency is explicitly not a cost here — Jasper's pipeline
 * speeds demos up in post (see CLAUDE.md, "From Jasper's reply").
 *
 * The press delay holds the button down like a finger, not a zero-width tap.
 */
const DEMO_DWELL_MS = 700;
const DEMO_PRESS_MS = 60;
/** Per-character delay for demo typing — the plate shows text arriving, not appearing. */
const DEMO_TYPE_DELAY_MS = 70;

/**
 * The visible half of a demo click, as data: where the pointer goes, how long it hovers,
 * which button, how many down/up cycles. Pure so tests pin it without a browser. The box
 * is playwright's boundingBox() shape, in the same CSS pixels as the screenshots — centre
 * is exact here BY CONSTRUCTION (no capture-scale offset exists on this backend).
 */
export interface DemoClickPlan {
	point: { x: number; y: number };
	dwellMs: number;
	/** ms between mousedown and mouseup of each cycle. */
	pressMs: number;
	button: "left" | "right";
	/** mouse.click performs this many down/up cycles with escalating clickCount. */
	clickCount: 1 | 2;
}

export function demoClickPlan(
	box: { x: number; y: number; width: number; height: number },
	verb: "click" | "right_click" | "double_click",
): DemoClickPlan {
	return {
		point: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
		dwellMs: DEMO_DWELL_MS,
		pressMs: DEMO_PRESS_MS,
		button: verb === "right_click" ? "right" : "left",
		clickCount: verb === "double_click" ? 2 : 1,
	};
}

export class CdpBackend {
	/** The page URL as of the last observation. Empty until the first observe(). */
	url = "";

	/** Which CDP target an app attach chose (port, page URL, title). Undefined for web
	 *  targets. The run log records it, so a run that drove the wrong window says which. */
	attachInfo?: { port: number; url: string; title: string };

	/**
	 * Where the last demo pointer action actually went: click point + the box it was
	 * resolved from, both from the SAME boundingBox call the mouse events used, in the
	 * same CSS pixels as the frames. Cleared at the start of every act(), so it is only
	 * ever the CURRENT turn's resolution — the trajectory write reads it in preference to
	 * re-deriving a point from the (possibly stale) observation box.
	 */
	lastActuation?: { point: { x: number; y: number }; box: { x: number; y: number; w: number; h: number } };
	/** Where the last real CLICK landed, retained across acts (lastActuation is per-act).
	 *  Ref-less typing checks the caret against this: "click here, then type" must put the
	 *  text where the pointer story says, or put nothing. */
	private lastClickPoint?: { x: number; y: number };

	private lastRows: SnapshotRow[] = [];

	private constructor(
		private browser: Browser,
		private page: Page,
		/** The declared start URL, so goHome() is a navigation rather than a guess. */
		private home?: string,
		/** Demo actuation: recorded runs get visible pointer choreography and per-key typing. */
		private demo = false,
		/** The app name for re-picking a window when the driven one closes (Electron only). */
		private appName?: string,
		/** The tab this run created or colonized (web only) — the run's to close on the way
		 *  out. Held as the PAGE, not a flag: ensurePage can re-point `this.page` mid-run,
		 *  and close() must never shut a tab the run did not open. */
		private ownedPage?: Page,
	) {
		page.setDefaultTimeout(ACTION_TIMEOUT_MS);
	}

	/**
	 * Get a driveable page for the target.
	 *
	 * Web target: ensure OUR Chrome is up on the port (launching it with the debugging
	 * flag and the persistent profile if not — idempotent across runs, which is exactly
	 * the signed-in-session model), attach, and land a page on the target URL.
	 *
	 * App target (Electron): attach when an endpoint is up. When it is not, a target
	 * marked `cdpAttach` gets the app LAUNCHED with the debug port (see
	 * src/backends/electron-attach.ts for the posture: launch freely, never touch an
	 * instance the user started). A plain app target keeps the old contract — the
	 * operator launches it themselves (`open -a "App" --args --remote-debugging-port=9222`).
	 *
	 * `demo: true` (recorded runs) switches actuation to the visible kind: pointer
	 * move + hover dwell + real down/up for clicks, per-character typing for text.
	 */
	static async acquire(target: Target, opts: { demo?: boolean } = {}): Promise<CdpBackend> {
		// An explicit CDP_PORT wins for BOTH kinds — the operator who launched their
		// Electron app with --remote-debugging-port=9333 means it. Unset (or blank, which
		// envNum already treats as unset), the kinds keep their separate defaults: 9777 for
		// the Chrome this backend launches, 9222 for the documented `open -a` example.
		const portConfigured = (process.env.CDP_PORT ?? "").trim() !== "";
		let port = target.kind === "app" && !portConfigured ? 9222 : DEFAULT_PORT;
		let endpoint = process.env.CDP_URL ?? `http://127.0.0.1:${port}`;

		if (target.kind === "web" && !process.env.CDP_URL && !(await endpointAlive(endpoint, 1, 0))) {
			fs.mkdirSync(PROFILE_DIR, { recursive: true });
			console.log(`launching Chrome (profile ${PROFILE_DIR}, port ${port})`);
			// Detached and left running on close: the browser is the session holder, and a
			// signed-in session that dies with the run defeats the reason the profile exists.
			// KEEP_RENDERING_FLAGS: same anti-throttle pair the Electron launch carries — a
			// covered or backgrounded Chrome otherwise throttles rendering and flips page
			// visibility while the operator multitasks, which reads as flicker on film and
			// stalls the frame poller. bringToFront() below still matters for the case where
			// this launch is skipped because a flagless-but-alive Chrome already held the port.
			const child = spawn(CHROME_BIN, [
				`--remote-debugging-port=${port}`,
				`--user-data-dir=${PROFILE_DIR}`,
				"--no-first-run",
				"--no-default-browser-check",
				...KEEP_RENDERING_FLAGS,
			], { stdio: "ignore", detached: true });
			// A missing CHROME_BIN emits an async ENOENT that would otherwise be an uncaught
			// exception, killing the process before agent.ts's finally writes the run log.
			// The endpointAlive poll below already produces the honest failure message; the
			// spawn error adds nothing but the crash.
			child.on("error", () => {});
			child.unref();
			if (!(await endpointAlive(endpoint, 50, 200)))
				throw new Error(`Chrome did not expose a debugging endpoint at ${endpoint} within 10s`);
		}

		// Electron attach: when the target asked for it (and no CDP_URL points elsewhere),
		// bring the endpoint up ourselves and attach WHERE IT LANDED — the app's own argv
		// decides the port when it is already flag-launched, and a launch scans past ports
		// held by other apps (the first live run attached to Notion Calendar squatting on
		// 9222 and drove the wrong app). A live endpoint on the preferred port proves
		// nothing; ensureElectronEndpoint works from process truth.
		if (target.kind === "app" && target.cdpAttach && !process.env.CDP_URL)
			({ endpoint, port } = await ensureElectronEndpoint(target.name, port));

		if (!(await endpointAlive(endpoint, 1, 0)))
			throw new Error(noEndpointMessage(target, endpoint, port, !!process.env.CDP_URL));

		// A Chrome whose last window was closed keeps RUNNING on macOS: the process lives, the
		// endpoint answers /json/version, and endpointAlive above is satisfied — but
		// /json/list is `[ ]` and there is no browser context. connectOverCDP then dies on
		// `Browser.setDownloadBehavior: Browser context management is not supported`, which
		// names neither the cause nor the fix.
		//
		// Reached on mac3 on 2026-07-31 after a human signed a site in and closed the window,
		// so it is the NORMAL aftermath of the sign-in flow this profile exists to support,
		// not an exotic state. Materialise a page before connecting rather than relaunching:
		// the browser is the session holder, and killing it to fix a missing tab would throw
		// away the very sign-in that made the profile worth keeping.
		if (target.kind === "web" && !(await hasPageTarget(endpoint))) {
			console.log(`${endpoint} is alive but has no page (Chrome outlived its last window) — opening one`);
			await openBlankPage(endpoint);
		}

		const browser = await chromium.connectOverCDP(endpoint);
		try {
			const context = browser.contexts()[0];
			if (!context) throw new Error(`attached to ${endpoint} but it has no browser context`);

			let page: Page;
			let ownedPage: Page | undefined;
			let attachInfo: CdpBackend["attachInfo"];
			if (target.kind === "web") {
				const pages = context.pages();
				const choice = webPageChoice(pages.map((p) => p.url()), target.origin);
				page = choice.index >= 0 ? pages[choice.index] : await context.newPage();
				if (choice.owned) ownedPage = page;
				if (!originMatches(page.url(), target.origin)) await page.goto(target.url, { waitUntil: "domcontentloaded" });
			} else {
				// Electron: the endpoint exposes every window plus devtools and background
				// pages. Gather the facts (across ALL contexts — Electron does not promise a
				// single one) and let the pure, tested chooser decide which is the app.
				// viewportSize() is null on attached pages, so the size comes from the page
				// itself; a page that cannot be measured competes with area 0.
				//
				// Polled, not read once: the endpoint answers /json/version BEFORE the app has
				// created its first BrowserWindow (observed live — a fresh Yarn launch attached
				// cleanly and listed zero pages), so an early attach must wait for the window,
				// not report an appless endpoint.
				const windowDeadline = Date.now() + 15_000;
				let pages: Page[] = [];
				let candidates: PageCandidate[] = [];
				let idx = -1;
				for (;;) {
					pages = browser.contexts().flatMap((c) => c.pages());
					candidates = [];
					for (const p of pages)
						candidates.push({
							url: p.url(),
							title: await p.title().catch(() => ""),
							viewport:
								p.viewportSize()
								?? ((await p.evaluate("({ width: window.innerWidth, height: window.innerHeight })").catch(() => null)) as PageCandidate["viewport"]),
						});
					idx = pickMainPage(candidates, target.name);
					if (idx >= 0 || Date.now() > windowDeadline) break;
					await new Promise((r) => setTimeout(r, 250));
				}
				if (idx < 0)
					throw new Error(
						`attached to ${endpoint} but no page looked like an app window within 15s — saw: ${candidates.map((c) => c.url || "(blank)").join(", ") || "(no pages)"}`,
					);
				page = pages[idx];
				const attachPort = (() => {
					try {
						return Number(new URL(endpoint).port) || port;
					} catch {
						return port;
					}
				})();
				attachInfo = { port: attachPort, url: candidates[idx].url, title: candidates[idx].title };
			}

			// Chrome throttles rendering for backgrounded tabs, and a throttled tab times out
			// every screenshot — observed on the first run that ATTACHED instead of launching
			// (the launched-Chrome case worked only because a fresh tab starts frontmost). Web
			// only: raising an Electron window is exactly the focus theft this backend exists
			// to avoid, and the electron-attach launch flags keep its renderer painting while
			// hidden instead.
			if (target.kind === "web") await page.bringToFront().catch(() => {});

			const backend = new CdpBackend(
				browser,
				page,
				target.kind === "web" ? target.url : undefined,
				opts.demo === true,
				target.kind === "app" ? target.name : undefined,
				ownedPage,
			);
			backend.attachInfo = attachInfo;

			return backend;
		} catch (e) {
			// Every refusal above would otherwise leave the CDP connection dangling. close()
			// on an attached browser only disconnects — the browser itself, and the signed-in
			// profile it holds, survive for the next attempt.
			await browser.close().catch(() => {});
			throw e;
		}
	}

	/** Where a run starts. Web targets have a declared home BY CONSTRUCTION — the URL. */
	async goHome(): Promise<string> {
		if (!this.home) return "none — Electron target has no declared home URL";
		await this.page.goto(this.home, { waitUntil: "domcontentloaded" });

		return `navigated to ${this.home}`;
	}

	/**
	 * Re-point `page` at the app's current main window if ours has closed.
	 *
	 * A freshly launched Electron app can present a page that later CLOSES: Yarn boots
	 * through a splash/loading window, pickMainPage legitimately selects it (it is the only
	 * window), and the handle dies when the real window replaces it — observed on the
	 * BENCH_QUIT_PORTLESS seam test (2026-07-31) as "Target page … has been closed" on the
	 * first post-reset observation. The browser connection is still fine; only the page
	 * handle is stale, and the same picker that chose the first window chooses its successor.
	 */
	private async ensurePage(): Promise<void> {
		if (!this.page.isClosed()) return;
		const pages = this.browser.contexts().flatMap((c) => c.pages());
		const candidates: PageCandidate[] = [];
		for (const p of pages)
			candidates.push({
				url: p.url(),
				title: await p.title().catch(() => ""),
				viewport:
					p.viewportSize()
					?? ((await p.evaluate("({ width: window.innerWidth, height: window.innerHeight })").catch(() => null)) as PageCandidate["viewport"]),
			});
		const idx = pickMainPage(candidates, this.appName ?? "");
		if (idx < 0)
			throw new Error(
				`the page this run was driving closed and no successor window appeared — saw: ${candidates.map((c) => c.url || "(blank)").join(", ") || "(no pages)"}`,
			);
		this.page = pages[idx];
		this.page.setDefaultTimeout(ACTION_TIMEOUT_MS);
		console.log(`the driven window closed — re-attached to its successor (${candidates[idx].title || candidates[idx].url})`);
	}

	async observe(shotName: string): Promise<ObservationBundle> {
		await this.ensurePage();
		const snapshot = await this.page.ariaSnapshot({ mode: "ai", boxes: true });
		const { rows, texts } = parseAiSnapshot(snapshot);
		this.lastRows = rows;
		const title = await this.page.title().catch(() => "");
		this.url = this.page.url();

		const shotPath = `${OUT}/${shotName}.png`;
		let shot = "";
		try {
			// scale:"css" keeps screenshot pixels 1:1 with the snapshot's [box=...] coordinates,
			// so targetRect and the click points derived from it need no conversion — the exact
			// mismatch observe() in harness.ts spends thirty lines correcting on the AX path.
			await this.page.screenshot({ path: shotPath, scale: "css" });
			shot = fs.readFileSync(shotPath).toString("base64");
		} catch {
			// Perception is the snapshot; a missed frame
			// degrades the pixel channel, it does not end the run.
			console.log("  (no frame captured for this observation)");
		}

		const interactive = rows.filter((r) => r.interactive);
		const lines = interactive.map((r) => {
			const val = r.value && r.value !== r.name ? ` value="${r.value.slice(0, 80)}"` : "";
			const inSurface = r.surface ? ` (in ${r.surface.slice(0, 40)})` : "";

			return `[${r.ref}] ${r.role} "${r.name.slice(0, 80)}"${val}${inSurface}`;
		});

		const seen = new Set<string>();
		const visibleTexts: string[] = [];
		for (const t of [...texts, ...rows.filter((r) => !r.interactive && r.name).map((r) => r.name)]) {
			if (seen.has(t)) continue;
			seen.add(t);
			visibleTexts.push(t);
		}

		const haystackParts = [title, this.url];
		for (const r of rows) {
			if (r.name) haystackParts.push(r.name);
			if (r.value) haystackParts.push(r.value);
		}
		haystackParts.push(...texts);

		// Same contract as observe() in harness.ts: a name shared by several elements
		// poisons the entry with NaN, so framesShifted can never mis-identify a mover.
		const frames = new Map<string, { x: number; y: number }>();
		for (const r of interactive) {
			if (!r.name || !(r.w > 0)) continue;
			frames.set(r.name, frames.has(r.name) ? { x: NaN, y: NaN } : { x: r.x, y: r.y });
		}

		return {
			elementsText:
				`URL: ${this.url}\n\nInteractive refs:\n${lines.join("\n")}\n\n` +
				`Visible text: ${visibleTexts.slice(0, 120).map((t) => JSON.stringify(t.slice(0, 60))).join(", ")}\n` +
				`(coverage: full tree, ${rows.length} nodes — nothing is budget-omitted on this backend)`,
			haystack: haystackParts.join("\n").toLowerCase(),
			screenshotB64: shot,
			title,
			url: this.url,
			interactive: interactive.map((r) => ({
				handle: r.ref,
				role: r.role,
				name: r.name,
				value: r.value,
				surface: r.surface,
				x: r.x,
				y: r.y,
				w: r.w,
				h: r.h,
			})),
			appContent: rows.length,
			domEnriched: 0,
			domUnavailable: "not applicable — CDP backend reads the DOM directly",
			frames,
		};
	}

	/**
	 * Search the current tree by role, name, or value. On this backend the observation
	 * already carries the whole tree, so this is a re-snapshot plus a substring filter —
	 * kept because a long page's element list is still easier to search than to read.
	 */
	async find(query: string): Promise<Array<{ ref: string; role: string; name: string; value: string; actions: string[]; visibility: string }>> {
		const snapshot = await this.page.ariaSnapshot({ mode: "ai" });
		const { rows } = parseAiSnapshot(snapshot);
		this.lastRows = rows;
		const q = query.toLowerCase();

		return rows
			.filter((r) => r.ref && (r.name.toLowerCase().includes(q) || r.value.toLowerCase().includes(q) || r.role === q))
			.map((r) => ({
				ref: r.ref,
				role: r.role,
				name: r.name,
				value: r.value,
				actions: r.interactive ? ["act"] : [],
				visibility: "in_viewport",
			}));
	}

	/** Refuse unknown verbs before anything runs, mirroring toActionRequest's contract. */
	assertSupported(name: string): void {
		if (name !== undefined && !(CDP_ACTIONS as readonly string[]).includes(name))
			throw new Error(`unsupported action "${name}" — CDP backend supports: ${CDP_ACTIONS.join(", ")}`);
	}

	/** What the run log records for a step — the model's own arguments, no driver shape. */
	requestForLog(a: any): ActionRequest {
		const args: Record<string, unknown> = {};
		for (const k of ["ref", "query", "text", "key", "url", "modifiers", "direction", "amount", "seconds"])
			if (a[k] !== undefined) args[k] = a[k];

		return { kind: "tool", name: a.name, args };
	}

	/**
	 * Perform one model-proposed action. Returns a result line for the transcript;
	 * throws on a stale ref, an ambiguous query, or an unsupported verb — all of which
	 * become a failed step the model corrects, not a dead run.
	 */
	async act(a: any): Promise<string> {
		this.assertSupported(a.name);
		// Refs resolve against the page the OBSERVATION used; a window swap between then and
		// now (splash → main, a reload) would address handles into a dead page. ensurePage
		// re-points at the successor, and the stale-ref error that follows is the honest one.
		await this.ensurePage();
		// Only ever the CURRENT act's resolution — a stale point must never attach to a
		// later turn's trajectory.
		this.lastActuation = undefined;
		switch (a.name) {
			case "wait":
				return "waited (no page action)";
			case "click":
			case "right_click":
			case "double_click":
			case "hover": {
				// Coordinate form, mirroring the AX tool's painted-target branch: the escape
				// hatch for things a ref cannot measure — canvas content, and rich-editor
				// pseudo-content like Yarn's script placeholder, which resolves to a ref whose
				// element reports no box by ANY means (boundingBox, getBoundingClientRect, the
				// snapshot row all came back empty on a live round). The model aims from the
				// screenshot it already sees; coordinates are viewport CSS pixels, same space.
				if (a.ref === undefined && a.query === undefined && a.x !== undefined && a.y !== undefined) {
					const x = Number(a.x);
					const y = Number(a.y);
					if (a.name === "hover") {
						await this.page.mouse.move(x, y);

						return `hover at (${x}, ${y})`;
					}
					const plan = demoClickPlan({ x: x - 1, y: y - 1, width: 2, height: 2 }, a.name);
					if (this.demo) await this.page.evaluate("(() => { const set = new WeakSet(); for (const el of document.querySelectorAll('input, textarea, [contenteditable]')) set.add(el); window.__demoPreClick = set; })()").catch(() => {});
					if (this.demo) {
						await this.page.mouse.move(plan.point.x, plan.point.y);
						await new Promise((r) => setTimeout(r, plan.dwellMs));
					}
					await this.page.mouse.click(x, y, { button: plan.button, clickCount: plan.clickCount, delay: this.demo ? plan.pressMs : undefined });
					this.lastActuation = { point: { x, y }, box: { x: x - 1, y: y - 1, w: 2, h: 2 } };
					this.lastClickPoint = { x, y };

					return `${a.name} at (${x}, ${y})`;
				}
				const ref = await this.resolveRef(a);
				const loc = this.page.locator(`aria-ref=${ref}`);
				if (a.name === "hover") await loc.hover();
				else if (this.demo) {
					const p = await this.demoPointer(loc, a.name, ref);

					return `${a.name} on [${ref}] at (${Math.round(p.x)}, ${Math.round(p.y)})`;
				} else
					await loc.click({
						button: a.name === "right_click" ? "right" : "left",
						clickCount: a.name === "double_click" ? 2 : 1,
					});

				return `${a.name} on [${ref}]`;
			}
			case "type_text": {
				const text = String(a.text ?? "");
				if (this.demo) {
					// Who holds the caret, as tag.class — an IIFE because evaluate strings
					// are expressions (see FOCUS_CHECK below).
					// "E:" prefix marks an editable holder (contenteditable / input / textarea),
					// so the chunk loop below can tell focus ARRIVING at an editor from focus
					// LEAVING one — the two directions get opposite treatment.
					// Classes are SORTED: Yarn re-mounts its editor with the same class set
					// in a different order ("tiptap ProseMirror" vs "ProseMirror tiptap"),
					// and a first-token desc read that as a different element mid-typing.
					const ACTIVE_DESC =
						"(() => { const a = document.activeElement; if (!a) return 'nothing'; const e = a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'; const c = a.classList ? Array.from(a.classList).sort().slice(0, 3).join('.') : ''; return (e ? 'E:' : '') + a.tagName.toLowerCase() + (c ? '.' + c : ''); })()";
					// Focus arrives by a visible click, then the text by real keystrokes.
					// The keystrokes are page.keyboard events, NOT locator.pressSequentially:
					// the locator form runs playwright's editability check, which rejects
					// anything that is not an input/textarea/contenteditable HOST — and in a
					// ProseMirror editor every addressable ref is an INNER node (paragraph,
					// placeholder), so on Yarn every single typing attempt errored with zero
					// pixels moved (mac1 run 2026-07-31T09-26-31). A human's keystrokes go to
					// whatever holds focus; so do these.
					//
					// No ref means "type at the current caret" — the escape hatch for editors
					// whose focus target is not addressable at all.
					if (a.ref || a.query) {
						const ref = await this.resolveRef(a);
						const loc = this.page.locator(`aria-ref=${ref}`);
						// The click is SKIPPED when focus is already inside the target (or the
						// target is inside the focused element — an inner ProseMirror node vs
						// its contenteditable host): a click collapses any selection, and the
						// documented pre-filled recovery (click the field, cmd+a, type_text)
						// depends on the selection surviving into the typing.
						// Real functions, not strings: playwright treats a STRING as an
						// expression, so an arrow-function string evaluates to a function
						// object and serializes to undefined — every check built that way
						// silently answered false/undefined (found live on round 6: the
						// theft error blamed "<undefined>"). tsx strips the `any` casts and
						// playwright serializes the compiled source, so globalThis keeps the
						// DOM references compiling without lib.dom.
						const FOCUS_CHECK = (el: any): boolean => {
							const d = (globalThis as any).document;
							return el === d.activeElement || el.contains(d.activeElement) || Boolean(d.activeElement && d.activeElement.contains(el));
						};
						const focused = (await loc.evaluate(FOCUS_CHECK).catch(() => false)) as boolean;
						if (!focused) {
							// Who holds focus BEFORE the click, so "did focus move" is answerable
							// even when the clicked node itself is replaced (see below).
							const before = (await this.page.evaluate(ACTIVE_DESC).catch(() => "")) as string;
							await this.demoPointer(loc, "click", ref);
							// Never type into whatever kept focus. Yarn's agent composer holds
							// default focus and silently swallowed two runs' narration — the
							// honest outcome of a click the field refused is a FAILED step
							// naming the thief, not a paragraph in the wrong box.
							//
							// "Took" cannot be just containment against the clicked node: a rich
							// editor REPLACES its placeholder node on focus (detaching what was
							// clicked, so containment reads false forever), and focus can arrive a
							// beat after mouseup. So poll briefly, and accept EITHER containment
							// OR focus having MOVED onto something editable since before the click.
							// Editable + WHERE: focus moving to "some editable" is not enough — a
							// click that spawned Yarn's canvas comment composer moved focus to a
							// perfectly editable element on the far side of the screen, and the
							// narration followed it (round 7). The caret's container must contain
							// the point that was clicked.
							const MOVED_CHECK =
								"(() => { const a = document.activeElement; if (!a) return null; const editable = a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'; if (!editable) return null; const r = a.getBoundingClientRect(); const c = a.classList ? Array.from(a.classList).sort().slice(0, 3).join('.') : ''; return { desc: a.tagName.toLowerCase() + (c ? '.' + c : ''), x: r.x, y: r.y, w: r.width, h: r.height }; })()";
							let took = false;
							for (let tries = 0; tries < 6 && !took; tries++) {
								await new Promise((r) => setTimeout(r, 200));
								if ((await loc.evaluate(FOCUS_CHECK).catch(() => false)) as boolean) took = true;
								else {
									const active = (await this.page.evaluate(MOVED_CHECK).catch(() => null)) as
										| { desc: string; x: number; y: number; w: number; h: number }
										| null;
									const p = (this.lastActuation as { point: { x: number; y: number } } | undefined)?.point;
									// Pre-existence closes the spawn hole: a comment pin or
									// text-overlay tool mounts an editable AT the click point,
									// so geometry alone blesses exactly the wrong element.
									const preexisting = (await this.page.evaluate("(() => { const s = window.__demoPreClick; return !!(s && document.activeElement && s.has(document.activeElement)); })()").catch(() => false)) as boolean;
									if (
										active
										&& preexisting
										&& active.desc !== before
										&& p
										&& p.x >= active.x - 8
										&& p.x <= active.x + active.w + 8
										&& p.y >= active.y - 8
										&& p.y <= active.y + active.h + 8
									)
										took = true;
								}
							}
							if (!took) {
								const thief = (await this.page.evaluate(ACTIVE_DESC).catch(() => "unknown")) as string;
								throw new Error(
									`clicked [${ref}] but keyboard focus stayed on <${thief}> — the target refused focus. ` +
										`Nothing was typed. Click a control that takes the caret, or type_text WITHOUT a ref to type at the current caret deliberately.`,
								);
							}
						}
					}
					// Chunked, with the caret holder re-checked between chunks — the AX path
					// types this way for frame capture; here it is for INTEGRITY: Yarn's
					// scene-splitting re-render blurred the editor mid-sentence on a live
					// round and the tail of the narration leaked wherever focus went. A
					// holder change stops the typing at a chunk boundary and reports exactly
					// how much landed, instead of spraying the rest.
					// Yarn taught both failure directions live: its TipTap editor mounts
					// ASYNCHRONOUSLY (focus sits on <body> for a beat, then the editor grabs
					// it — keystrokes sent early go nowhere), and its scene-splitting
					// re-render can blur the editor mid-sentence and take the tail of the
					// narration with it. So: refuse to START at a non-editable holder (wait
					// briefly for the editor to wake), ADOPT focus that arrives at an
					// editable, POLL for focus that leaves one to come back, and abort with
					// exact progress only when it provably went elsewhere.
					let holder = (await this.page.evaluate(ACTIVE_DESC).catch(() => "")) as string;
					for (let tries = 0; tries < 6 && !holder.startsWith("E:"); tries++) {
						await new Promise((r) => setTimeout(r, 200));
						holder = (await this.page.evaluate(ACTIVE_DESC).catch(() => "")) as string;
					}
					if (!holder.startsWith("E:"))
						throw new Error(
							`nothing editable holds the caret (focus is on <${holder}>) — nothing was typed. Click the field first, or pass its ref so the harness clicks it.`,
						);
					// Anchor the pointer where the text will actually APPEAR: the caret's own
					// screen rect, read live. Without this, ref-less typing had no pointer
					// anchor at all — text materialized across the screen from a parked
					// cursor, the original complaint #7 reintroduced through the escape
					// hatch. Falls back to whatever the focus click recorded (or nothing).
					const caret = (await this.page
						.evaluate(
							"(() => { const s = window.getSelection(); const a = document.activeElement; const f = a ? a.getBoundingClientRect() : null; let r = null; if (s && s.rangeCount > 0) { const c = s.getRangeAt(0).getBoundingClientRect(); if (c.width || c.height) r = c; } const b = r || f; if (!b) return null; return { x: b.x, y: b.y, w: Math.max(b.width, 2), h: Math.max(b.height, 14), fromCaret: !!r, field: f ? { x: f.x, y: f.y, w: f.width, h: f.height } : null }; })()",
						)
						.catch(() => null)) as { x: number; y: number; w: number; h: number; fromCaret: boolean; field: { x: number; y: number; w: number; h: number } | null } | null;
					// Click-caret coherence, for the REF-LESS path only (a ref names its own
					// target): the viewer just watched the pointer click somewhere, so the text
					// must land in the field that click focused — on film the composer kept the
					// blinking caret while the pointer stood on the script panel, and a typed
					// probe spawned a canvas overlay. If the caret's field does not contain the
					// last click, nothing is typed and the error says where the caret really is.
					if (!(a.ref || a.query) && this.lastClickPoint && caret?.field) {
						const preexisting = (await this.page.evaluate("(() => { const s = window.__demoPreClick; return !!(s && document.activeElement && s.has(document.activeElement)); })()").catch(() => true)) as boolean;
						if (!preexisting) {
							const thief = (await this.page.evaluate(ACTIVE_DESC).catch(() => "unknown")) as string;
							throw new Error(
								`the caret is in <${thief}>, an editor that APPEARED FROM your last click (a comment pin or text tool, not the field itself). Nothing was typed. ` +
									`Dismiss it if unwanted; to type into it deliberately, re-observe and pass its ref.`,
							);
						}
						const f = caret.field;
						const p = this.lastClickPoint;
						const PAD = 16;
						if (p.x < f.x - PAD || p.x > f.x + f.w + PAD || p.y < f.y - PAD || p.y > f.y + f.h + PAD) {
							const thief = (await this.page.evaluate(ACTIVE_DESC).catch(() => "unknown")) as string;
							throw new Error(
								`the caret is in <${thief}> at (${Math.round(f.x)}, ${Math.round(f.y)}), which does not contain your last click at (${Math.round(p.x)}, ${Math.round(p.y)}) — that click did not focus the field you meant. Nothing was typed. ` +
									`Click the field's visible text itself (not empty panel space), or pass its ref.`,
							);
						}
					}
					if (caret) {
						// A collapsed caret in an empty editor reports a zero rect, so `caret`
						// may really be the FIELD's rect — and centering on a pane-sized
						// ProseMirror parked the pointer in empty panel space on film (round
						// 16, t≈24s). When the true caret rect is unavailable, anchor at the
						// last click point (the coherence check above proved the field
						// contains it) or the field's text origin — never the rect center.
						let p = { x: caret.x + caret.w / 2, y: caret.y + caret.h / 2 };
						let box = { x: caret.x, y: caret.y, w: caret.w, h: caret.h };
						const f = caret.field;
						if (!caret.fromCaret && f) {
							const c = this.lastClickPoint;
							const inField = c && c.x >= f.x && c.x <= f.x + f.w && c.y >= f.y && c.y <= f.y + f.h;
							p = inField && c ? { x: c.x, y: c.y } : { x: f.x + 12, y: f.y + 14 };
							box = { x: p.x - 1, y: p.y - 8, w: 2, h: 16 };
						}
						this.lastActuation = { point: p, box };
					}
					const { chunks } = chunkText(text);
					let typed = "";
					for (const chunk of chunks) {
						if (typed) {
							let now = (await this.page.evaluate(ACTIVE_DESC).catch(() => "")) as string;
							if (!now.startsWith("E:"))
								// 3s, not the arrival-wait's 1.2s: Yarn's debounced scene sync
								// re-mounts the editor ~1s into typing and takes a further beat
								// to hand focus back — a poll that gives up first turns every
								// long sentence into an interrupted step (observed at ~13 chars,
								// twice in one run). Riding it out keeps one typing action whole.
								for (let tries = 0; tries < 15 && !now.startsWith("E:"); tries++) {
									await new Promise((r) => setTimeout(r, 200));
									now = (await this.page.evaluate(ACTIVE_DESC).catch(() => "")) as string;
								}
							// Only the SAME holder continues — a re-mounted editor of the same
							// class produces an identical desc, so Yarn's mid-typing re-mounts
							// pass. Focus at a DIFFERENT editable gets a short grace first:
							// Yarn's first-scene sync parks focus on a timeline comment input
							// (editor-timeline-commentsThread-input-*) ~11 chars into typing
							// (reproduced two runs in a row) — if the original holder takes
							// focus back, no character went astray (typing only resumes on a
							// holder match), so aborting was pure noise. Staying away is a
							// real theft and aborts with exact progress as before.
							if (now !== holder && now.startsWith("E:"))
								for (let tries = 0; tries < 10 && now !== holder; tries++) {
									await new Promise((r) => setTimeout(r, 200));
									now = (await this.page.evaluate(ACTIVE_DESC).catch(() => "")) as string;
								}
							if (now !== holder)
								throw new Error(
									`typing interrupted after ${typed.length} of ${text.length} characters — focus moved from <${holder}> to <${now}>. ` +
										`Landed so far: "…${typed.slice(-40)}". Re-observe, put the caret back, and continue with the REMAINING text only.`,
								);
						}
						await this.page.keyboard.type(chunk, { delay: DEMO_TYPE_DELAY_MS });
						typed += chunk;
					}

					return `typed at the caret${a.ref ? ` after clicking [${a.ref}]` : ""} (existing content NOT replaced — cmd+a first if it must be cleared)`;
				}
				const ref = await this.resolveRef(a);
				// fill() replaces — the pre-filled-field trap ("New YorkParis") cannot happen,
				// so the rules stop telling the model to cmd+a first.
				await this.page.locator(`aria-ref=${ref}`).fill(text);

				return `typed into [${ref}] (replaced existing content)`;
			}
			case "press_key": {
				const key = playwrightKey(String(a.key ?? ""), a.modifiers);
				await this.page.keyboard.press(key);

				return `pressed ${key} (delivered to the page renderer)`;
			}
			case "scroll": {
				const notches = Number(a.amount ?? 3);
				const dx = a.direction === "left" ? -notches * 120 : a.direction === "right" ? notches * 120 : 0;
				const dy = a.direction === "up" ? -notches * 120 : a.direction === "down" ? notches * 120 : 0;
				if (a.ref || a.query) await this.page.locator(`aria-ref=${await this.resolveRef(a)}`).hover();
				await this.page.mouse.wheel(dx, dy);

				return `scrolled ${a.direction ?? "down"} ${notches} notches`;
			}
			case "navigate": {
				const url = String(a.url ?? "");
				webTarget(url); // throws on a non-http(s) scheme
				await this.page.goto(url, { waitUntil: "domcontentloaded" });

				return `navigated to ${url} (all previous refs are invalid)`;
			}
			default:
				throw new Error(`unsupported action "${a.name}"`);
		}
	}

	/** One frame for the recording loop. Viewport-scoped by construction. */
	async screenshot(path: string): Promise<void> {
		await this.page.screenshot({ path, scale: "css" });
	}

	/**
	 * The demo pointer approach: scroll the element into reach, move the (injected)
	 * pointer onto it so real `:hover` fires, dwell, then press with genuine down/up
	 * cycles (mouse.click escalates clickCount exactly the way dblclick does). The point
	 * and the box come from ONE boundingBox call and are recorded on `lastActuation`, so
	 * the trajectory carries the same resolution the mouse events used — the "both wrong
	 * together" class of coordinate bug has nowhere to live.
	 *
	 * Throws when the element has no visible box: pressing at a guessed point would be
	 * exactly the invisible-actuation this mode exists to kill.
	 */
	private async demoPointer(loc: Locator, verb: "click" | "right_click" | "double_click", ref?: string): Promise<{ x: number; y: number }> {
		// The scroll a locator click would have done implicitly; without it the box below
		// can sit outside the viewport and the mouse events land on nothing. Best-effort:
		// the row-box fallback below still needs a chance when the node cannot scroll.
		await loc.scrollIntoViewIfNeeded().catch(() => {});
		// boundingBox() is null for the nodes rich editors expose — ProseMirror's
		// placeholder line has a ref and painted pixels but no box playwright will report,
		// and clicking it is the ONLY way to focus Yarn's script editor (both mac1 runs
		// burned their budget on this). Fallback order is freshness: playwright's strict
		// live box, then the DOM's own live answer (getBoundingClientRect ignores
		// playwright's visibility bookkeeping), then the observation-time snapshot row.
		// A human clicks what they see; verification downstream catches anything stale.
		let box = await loc.boundingBox().catch(() => null);
		if (!box || box.width <= 0 || box.height <= 0)
			box = (await loc
				.evaluate((el: any) => {
					const r = el.getBoundingClientRect();

					return { x: r.x, y: r.y, width: r.width, height: r.height };
				})
				.catch(() => null)) as { x: number; y: number; width: number; height: number } | null;
		if (!box || box.width <= 0 || box.height <= 0) {
			const row = ref ? this.lastRows.find((r) => r.ref === ref) : undefined;
			if (row && row.w > 0 && row.h > 0) box = { x: row.x, y: row.y, width: row.w, height: row.h };
		}
		if (!box || box.width <= 0 || box.height <= 0)
			throw new Error("target resolved but has no visible box to click — it may have just closed; re-observe");
		const plan = demoClickPlan(box, verb);
		// Editables that exist BEFORE this click, so typing can tell a field the click
		// FOCUSED from an editor the click SPAWNED (comment pins, text-overlay tools —
		// both mount an editable at the click point and both have eaten narration).
		await this.page.evaluate("(() => { const set = new WeakSet(); for (const el of document.querySelectorAll('input, textarea, [contenteditable]')) set.add(el); window.__demoPreClick = set; })()").catch(() => {});
		await this.page.mouse.move(plan.point.x, plan.point.y);
		await new Promise((r) => setTimeout(r, plan.dwellMs));
		await this.page.mouse.click(plan.point.x, plan.point.y, { button: plan.button, clickCount: plan.clickCount, delay: plan.pressMs });
		this.lastActuation = { point: plan.point, box: { x: box.x, y: box.y, w: box.width, h: box.height } };
		this.lastClickPoint = plan.point;

		return plan.point;
	}

	private async resolveRef(a: any): Promise<string> {
		if (a.ref) return String(a.ref);
		if (!a.query) throw new Error(`action "${a.name}" needs either a ref (from the observation) or a query (to resolve by name)`);
		const q = String(a.query).toLowerCase();
		const rows = this.lastRows.filter((r) => r.ref && (r.name.toLowerCase().includes(q) || r.value.toLowerCase().includes(q)));
		const interactive = rows.filter((r) => r.interactive);
		const candidates = interactive.length > 0 ? interactive : rows;
		if (candidates.length === 0) throw new Error(`query "${a.query}" matched nothing in the current observation — use "find" first`);
		if (candidates.length > 1) {
			const list = candidates.slice(0, 8).map((r) => `[${r.ref}] ${r.role} "${r.name}"`).join("; ");
			throw new Error(`query "${a.query}" matched ${candidates.length} elements — pass an explicit ref instead: ${list}`);
		}

		return candidates[0].ref;
	}

	/**
	 * Disconnect WITHOUT closing the browser we attached to or launched: it holds the
	 * signed-in profile, and the next run reattaches to it in milliseconds. This is the
	 * inverse of the cua posture, where close() tears down a shared daemon (LIMITATIONS
	 * §6) — here there is nothing shared to tear down.
	 *
	 * The run's OWN tab does close: leaving it is how a bench run's Wikipedia tab ended up
	 * on an operator's sign-in screen (2026-07-31). Adopted tabs (webPageChoice) and app
	 * windows are never owned, so they survive as before. Runs after teardown — this is the
	 * last call in a run's life, so the journal replay has already used the page.
	 *
	 * The LAST tab is blanked, not closed: a window-less Chrome keeps answering its debug
	 * endpoint but connectOverCDP refuses it ("Browser context management is not supported",
	 * reproduced locally 2026-07-31 — one tab present, same Chrome, connects fine), so
	 * closing the final tab would break the NEXT run's acquire. Blanking removes the content
	 * — which is the clutter — and leaves exactly the tab webPageChoice colonizes.
	 */
	async close(): Promise<void> {
		if (this.ownedPage && !this.ownedPage.isClosed()) {
			const lastTab = this.browser.contexts().flatMap((c) => c.pages()).length <= 1;
			if (lastTab) await this.ownedPage.goto("about:blank").catch(() => {});
			else await this.ownedPage.close().catch(() => {});
		}
		await this.browser.close().catch(() => {});
	}
}

/** The one rule that differs by mode is type_text's contract — stated per mode because a
 *  model told "replaces" in demo mode types over pre-filled content and gets "New YorkParis". */
export function cdpRules(demo: boolean): string {
	return `Rules for this backend (CDP-direct via playwright, follow them):
- The observation is the WHOLE accessibility tree — nothing is budget-omitted. "find" exists as a search convenience on long pages, not as an escape hatch.
- Address elements by their [ref]. Refs are re-issued on every observation and invalidated by navigate; never reuse a ref across a navigate.
- Any act may pass "query" instead of "ref" to resolve the target by name at action time; it fails cleanly if the name is ambiguous.
- ${demo
		? `type_text CLICKS the field, then types at the caret character by character — it does NOT replace existing content. If the field may be pre-filled: click it, press cmd+a, then type_text (type_text skips its own click when the field already has focus, so the selection survives and your text replaces it).`
		: `type_text REPLACES the field's content (it is a fill, not an insert) — no select-all is needed first.`}
- Keys go to the PAGE RENDERER only. Escape closes in-page overlays; cmd/ctrl combos reach the page (an editor's cmd+b works) but can NEVER trigger the browser's or the OS's own shortcuts — cmd+w cannot close the tab, and there is no menu bar to reach. Native OS dialogs (file pickers, permission prompts) are NOT driveable from here; if one opens, say so and stop.
- The observation opens with the page URL. It is the strongest evidence available: navigation changes it, so a URL check cannot already have been true before the action.
- "navigate" goes straight to an http/https URL and discards every ref you hold.
- Element boxes and the screenshot share one coordinate space; trust the fresh observation over any assumption about layout.`;
}

/** The demo=false text, for the importers wired before demo mode existed. */
export const CDP_RULES = cdpRules(false);

/** Same role as dom.ts's FIND_TOOL, but honest about this backend: the observation is
 *  already complete, so find is a search aid, not an escape hatch from truncation. */
export const CDP_FIND_TOOL: Anthropic.Tool = {
	name: "find",
	description:
		"Search the page's elements by role, accessible name, or visible text. " +
		"Read-only: it performs no action and does not count as your action for the turn. " +
		"The observation already contains the full tree — use this to search a long page rather than reading it.",
	input_schema: {
		type: "object",
		properties: {
			query: { type: "string", description: 'Text to match, e.g. "Time zone" or "GMT+2". Shorter, distinctive strings match best.' },
		},
		required: ["query"],
	},
};

/** The act tool this backend presents. No delivery_mode — the model should never see a knob that does nothing. A function for the same reason as cdpRules: the type_text semantics differ by mode, and the schema must not contradict the rules. */
export function cdpActTool(demo: boolean): Anthropic.Tool {
	return {
		name: "act",
		description: "Perform one UI action on the target page and state the expected observable effect.",
		input_schema: {
			type: "object",
			properties: {
				reasoning: { type: "string", description: "One sentence: why this action now." },
				action: {
					type: "object",
					properties: {
						name: { type: "string", enum: [...CDP_ACTIONS] },
						ref: {
							type: "string",
							description: demo
								? "Target ref from the current observation (click/right_click/double_click/hover, optional for scroll). For type_text it names the field to click before typing — omit it to type at the CURRENT caret (useful in rich editors whose focused surface has no addressable ref)."
								: "Target ref from the current observation (click/right_click/double_click/hover/type_text, optional for scroll).",
						},
						query: { type: "string", description: "Alternative to ref: resolve the target by name at action time. Refused if it matches more than one element." },
						x: { type: "number", description: "With y and NO ref/query: pointer actions at viewport CSS-pixel coordinates read off the screenshot — the escape hatch for painted or unmeasurable targets (canvas, rich-editor placeholders). To type there: click the spot first, then type_text without a ref." },
						y: { type: "number", description: "See x." },
						text: {
							type: "string",
							description: demo
								? "For type_text. Typed at the caret after clicking the field — does NOT replace existing content."
								: "For type_text. Replaces the field's existing content.",
						},
						key: { type: "string", description: "For press_key: return, tab, escape, up, down, a-z, 0-9, etc." },
						url: { type: "string", description: "For navigate: an http/https URL. Invalidates every ref from the current observation." },
						modifiers: { type: "array", items: { type: "string" }, description: "For press_key: cmd, shift, option, ctrl — delivered to the page, never the OS." },
						direction: { type: "string", enum: ["up", "down", "left", "right"], description: "For scroll." },
						amount: { type: "integer", description: "For scroll: wheel notches." },
						seconds: { type: "integer", description: `For wait: how long to wait before re-observing, up to ${MAX_WAIT_MS / 1000}. One wait of 120 costs a single step; 120 waits of 1 cost 120. Use it whenever the app is working on something slow.` },
					},
					required: ["name"],
				},
				expectation: {
					type: "object",
					properties: {
						description: { type: "string" },
						textIncludes: { type: "array", items: { type: "string" }, description: "REQUIRED unless textExcludes is given. Substrings that should appear in the next observation." },
						textExcludes: { type: "array", items: { type: "string" }, description: "Substrings that should NOT appear in the next observation. Satisfies the checkable-expectation requirement on its own." },
					},
					required: ["description"],
					description: "You MUST supply textIncludes and/or textExcludes. An act call with only a prose description is REJECTED WITHOUT BEING EXECUTED.",
				},
			},
			required: ["action", "expectation"],
		},
	};
}

/** The demo=false tool, for the importers wired before demo mode existed. */
export const CDP_ACT_TOOL: Anthropic.Tool = cdpActTool(false);
