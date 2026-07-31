import type Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { envNum } from "../env.js";
import { MAX_WAIT_MS, OUT, type ObservationBundle } from "../core/harness.js";
import type { Target } from "../core/target.js";
import { webTarget } from "../core/target.js";
import type { ActionRequest } from "../types.js";
import { endpointAlive, ensureElectronEndpoint, type PageCandidate, pickMainPage } from "./electron-attach.js";

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
	// encodes, and reverse document-order search is not ancestry.
	const stack: Array<{ indent: number; name: string; row?: SnapshotRow }> = [];

	for (const raw of snapshot.split("\n")) {
		const m = raw.match(/^(\s*)- (.*)$/);
		if (!m) continue;
		const indent = m[1].length;
		let rest = m[2];

		while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
		const surface = [...stack].reverse().find((s) => s.name)?.name ?? "";

		if (rest.startsWith("text:")) {
			const t = rest.slice(5).trim();
			if (t) texts.push(unquote(t));
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
		}
		stack.push({ indent, name, row });
	}

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
 * Demo-mode pointer pacing. The dwell sits between the move and the press so a :hover
 * transition has real wall-clock to render before the click's effect replaces it —
 * 150–250ms per the plan; long enough for a CSS transition, short enough not to read as
 * hesitation. The press delay holds the button down like a finger, not a zero-width tap.
 */
const DEMO_DWELL_MS = 200;
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

	private lastRows: SnapshotRow[] = [];

	private constructor(
		private browser: Browser,
		private page: Page,
		/** The declared start URL, so goHome() is a navigation rather than a guess. */
		private home?: string,
		/** Demo actuation: recorded runs get visible pointer choreography and per-key typing. */
		private demo = false,
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
			const child = spawn(CHROME_BIN, [
				`--remote-debugging-port=${port}`,
				`--user-data-dir=${PROFILE_DIR}`,
				"--no-first-run",
				"--no-default-browser-check",
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
			throw new Error(
				`no CDP endpoint at ${endpoint}. For an Electron app, launch it with the flag first:\n` +
					`  open -a "<App>" --args --remote-debugging-port=${port}\n` +
					`or point CDP_URL at an existing endpoint.`,
			);

		const browser = await chromium.connectOverCDP(endpoint);
		try {
			const context = browser.contexts()[0];
			if (!context) throw new Error(`attached to ${endpoint} but it has no browser context`);

			let page: Page;
			let attachInfo: CdpBackend["attachInfo"];
			if (target.kind === "web") {
				const origin = target.origin;
				const matching = context.pages().filter((p) => originMatches(p.url(), origin));
				// Two tabs on the target site: driving the wrong one looks like it worked. Refuse.
				if (matching.length > 1)
					throw new Error(`${matching.length} tabs are open on ${origin} — close the spares so the target is unambiguous`);
				page = matching[0]
					?? context.pages().find((p) => p.url() === "about:blank")
					?? (await context.newPage());
				if (!originMatches(page.url(), origin)) await page.goto(target.url, { waitUntil: "domcontentloaded" });
			} else {
				// Electron: the endpoint exposes every window plus devtools and background
				// pages. Gather the facts (across ALL contexts — Electron does not promise a
				// single one) and let the pure, tested chooser decide which is the app.
				// viewportSize() is null on attached pages, so the size comes from the page
				// itself; a page that cannot be measured competes with area 0.
				const pages = browser.contexts().flatMap((c) => c.pages());
				const candidates: PageCandidate[] = [];
				for (const p of pages)
					candidates.push({
						url: p.url(),
						title: await p.title().catch(() => ""),
						viewport:
							p.viewportSize()
							?? ((await p.evaluate("({ width: window.innerWidth, height: window.innerHeight })").catch(() => null)) as PageCandidate["viewport"]),
					});
				const idx = pickMainPage(candidates, target.name);
				if (idx < 0)
					throw new Error(
						`attached to ${endpoint} but no page looks like an app window — saw: ${candidates.map((c) => c.url || "(blank)").join(", ") || "(no pages)"}`,
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

			const backend = new CdpBackend(browser, page, target.kind === "web" ? target.url : undefined, opts.demo === true);
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

	async observe(shotName: string): Promise<ObservationBundle> {
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
				const ref = await this.resolveRef(a);
				const loc = this.page.locator(`aria-ref=${ref}`);
				if (a.name === "hover") await loc.hover();
				else if (this.demo) {
					const p = await this.demoPointer(loc, a.name);

					return `${a.name} on [${ref}] at (${Math.round(p.x)}, ${Math.round(p.y)})`;
				} else
					await loc.click({
						button: a.name === "right_click" ? "right" : "left",
						clickCount: a.name === "double_click" ? 2 : 1,
					});

				return `${a.name} on [${ref}]`;
			}
			case "type_text": {
				const ref = await this.resolveRef(a);
				const loc = this.page.locator(`aria-ref=${ref}`);
				const text = String(a.text ?? "");
				if (this.demo) {
					// Focus arrives by a visible click, then the text by real keystrokes —
					// the plate shows the field being chosen and the characters landing.
					// The click is SKIPPED when the field already has focus: a click
					// collapses any selection, and the documented pre-filled recovery
					// (click the field, cmd+a, type_text) depends on the selection
					// surviving into the typing.
					const focused = (await loc.evaluate("el => el === document.activeElement").catch(() => false)) as boolean;
					if (!focused) await this.demoPointer(loc, "click");
					// The locator timeout is tuned for stale-ref failures; typing time is
					// real work proportional to the text, so it gets its own budget.
					await loc.pressSequentially(text, { delay: DEMO_TYPE_DELAY_MS, timeout: ACTION_TIMEOUT_MS + text.length * DEMO_TYPE_DELAY_MS });

					return `typed into [${ref}] at the caret (existing content NOT replaced — cmd+a first if it must be cleared)`;
				}
				// fill() replaces — the pre-filled-field trap ("New YorkParis") cannot happen,
				// so the rules stop telling the model to cmd+a first.
				await loc.fill(text);

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
	private async demoPointer(loc: Locator, verb: "click" | "right_click" | "double_click"): Promise<{ x: number; y: number }> {
		// The scroll a locator click would have done implicitly; without it the box below
		// can sit outside the viewport and the mouse events land on nothing.
		await loc.scrollIntoViewIfNeeded();
		const box = await loc.boundingBox();
		if (!box || box.width <= 0 || box.height <= 0)
			throw new Error("target resolved but has no visible box to click — it may have just closed; re-observe");
		const plan = demoClickPlan(box, verb);
		await this.page.mouse.move(plan.point.x, plan.point.y);
		await new Promise((r) => setTimeout(r, plan.dwellMs));
		await this.page.mouse.click(plan.point.x, plan.point.y, { button: plan.button, clickCount: plan.clickCount, delay: plan.pressMs });
		this.lastActuation = { point: plan.point, box: { x: box.x, y: box.y, w: box.width, h: box.height } };

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
	 */
	async close(): Promise<void> {
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
						ref: { type: "string", description: "Target ref from the current observation (click/right_click/double_click/hover/type_text, optional for scroll)." },
						query: { type: "string", description: "Alternative to ref: resolve the target by name at action time. Refused if it matches more than one element." },
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
