import type Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { envNum } from "./env.js";
import { MAX_WAIT_MS, OUT, type ObservationBundle } from "./harness.js";
import type { Target } from "./target.js";
import { webTarget } from "./target.js";
import type { ActionRequest } from "./types.js";

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
 *   LIMITATIONS §12) protects arbitrary users' profiles. This backend launches its OWN
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

/** Same verb set as the DOM backend, so the model-facing contract stays familiar. */
const CDP_ACTIONS = ["click", "right_click", "double_click", "hover", "type_text", "press_key", "scroll", "wait", "navigate"] as const;

/** Where the persistent profile lives. Persistent by design: a human signs into the
 *  target site once per machine, and every later run inherits the session — the same
 *  reason `src/browser.ts` uses a named driver profile. */
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
	// (indent, name) of every open ancestor; surface lookup walks it backwards.
	const stack: Array<{ indent: number; name: string }> = [];

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

		const flags = new Set<string>();
		let ref = "";
		let box = { x: 0, y: 0, w: 0, h: 0 };
		for (const b of rest.matchAll(/\[([^\]]+)\]/g)) {
			const body = b[1];
			if (body.startsWith("ref=")) ref = body.slice(4);
			else if (body.startsWith("box=")) {
				const [x, y, w, h] = body.slice(4).split(",").map(Number);
				box = { x, y, w, h };
			} else flags.add(body);
		}

		// The node's own value sits after the last bracket; a bare ":" only announces children.
		const valueMatch = rest.match(/(?:^|\])\s*:\s(.+)$/);
		let value = valueMatch ? unquote(valueMatch[1].trim()) : "";

		// A closed <select> renders its options as children; the [selected] one IS the
		// combobox's value, and the value is what the mutation journal diffs.
		if (flags.has("selected") && name && rows.length) {
			const parent = [...rows].reverse().find((r) => r.role === "combobox" || r.role === "listbox");
			if (parent && !parent.value) parent.value = name;
		}

		if (ref || name || value) {
			rows.push({
				ref,
				role,
				name,
				value,
				surface,
				...box,
				flags,
				interactive:
					!!ref && !flags.has("disabled") && (INTERACTIVE_ROLES.has(role) || flags.has("cursor=pointer")),
			});
		}
		stack.push({ indent, name });
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

/** Poll a debugging endpoint until it answers, or give up. */
async function endpointAlive(url: string, attempts: number, delayMs: number): Promise<boolean> {
	for (let i = 0; i < attempts; i++) {
		try {
			const r = await fetch(`${url}/json/version`);
			if (r.ok) return true;
		} catch {}
		await new Promise((r) => setTimeout(r, delayMs));
	}

	return false;
}

export class CdpBackend {
	/** The page URL as of the last observation. Empty until the first observe(). */
	url = "";

	private lastRows: SnapshotRow[] = [];

	private constructor(
		private browser: Browser,
		private page: Page,
		/** The declared start URL, so goHome() is a navigation rather than a guess. */
		private home?: string,
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
	 * App target (Electron): attach only. The app must already be running with
	 * `--remote-debugging-port` — how it gets the flag is the operator's business
	 * (`open -a "App" --args --remote-debugging-port=9222`), and launching someone
	 * else's app with injected switches is not something to do implicitly.
	 */
	static async acquire(target: Target): Promise<CdpBackend> {
		const port = DEFAULT_PORT;
		const endpoint = process.env.CDP_URL ?? `http://127.0.0.1:${target.kind === "app" ? 9222 : port}`;

		if (target.kind === "web" && !process.env.CDP_URL && !(await endpointAlive(endpoint, 1, 0))) {
			fs.mkdirSync(PROFILE_DIR, { recursive: true });
			console.log(`launching Chrome (profile ${PROFILE_DIR}, port ${port})`);
			// Detached and left running on close: the browser is the session holder, and a
			// signed-in session that dies with the run defeats the reason the profile exists.
			spawn(CHROME_BIN, [
				`--remote-debugging-port=${port}`,
				`--user-data-dir=${PROFILE_DIR}`,
				"--no-first-run",
				"--no-default-browser-check",
			], { stdio: "ignore", detached: true }).unref();
			if (!(await endpointAlive(endpoint, 50, 200)))
				throw new Error(`Chrome did not expose a debugging endpoint at ${endpoint} within 10s`);
		}

		if (!(await endpointAlive(endpoint, 1, 0)))
			throw new Error(
				`no CDP endpoint at ${endpoint}. For an Electron app, launch it with the flag first:\n` +
					`  open -a "<App>" --args --remote-debugging-port=9222\n` +
					`or point CDP_URL at an existing endpoint.`,
			);

		const browser = await chromium.connectOverCDP(endpoint);
		const context = browser.contexts()[0];
		if (!context) throw new Error(`attached to ${endpoint} but it has no browser context`);

		let page: Page;
		if (target.kind === "web") {
			const origin = target.origin;
			const matching = context.pages().filter((p) => p.url().startsWith(origin));
			// Two tabs on the target site: driving the wrong one looks like it worked, the
			// same trap pickTab refuses in src/dom.ts. Refuse identically.
			if (matching.length > 1)
				throw new Error(`${matching.length} tabs are open on ${origin} — close the spares so the target is unambiguous`);
			page = matching[0]
				?? context.pages().find((p) => p.url() === "about:blank")
				?? (await context.newPage());
			if (!page.url().startsWith(origin)) await page.goto(target.url, { waitUntil: "domcontentloaded" });
		} else {
			// Electron: one window is one page; take the largest-URL... no — take the first
			// non-devtools page, which is the app's window.
			page = context.pages().find((p) => !p.url().startsWith("devtools://")) ?? context.pages()[0];
			if (!page) throw new Error(`attached to ${endpoint} but found no page`);
		}

		// Chrome throttles rendering for backgrounded tabs, and a throttled tab times out
		// every screenshot — observed on the first run that ATTACHED instead of launching
		// (the launched-Chrome case worked only because a fresh tab starts frontmost). The
		// snapshot channel is unaffected either way; this is for the pixel channel.
		await page.bringToFront().catch(() => {});

		return new CdpBackend(browser, page, target.kind === "web" ? target.url : undefined);
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
			// Same posture as the DOM backend: perception is the snapshot; a missed frame
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
			frames: new Map(interactive.filter((r) => r.name && r.w > 0).map((r) => [r.name, { x: r.x, y: r.y }])),
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
				else
					await loc.click({
						button: a.name === "right_click" ? "right" : "left",
						clickCount: a.name === "double_click" ? 2 : 1,
					});

				return `${a.name} on [${ref}]`;
			}
			case "type_text": {
				const ref = await this.resolveRef(a);
				// fill() replaces — the pre-filled-field trap ("New YorkParis") cannot happen,
				// so the rules stop telling the model to cmd+a first.
				await this.page.locator(`aria-ref=${ref}`).fill(String(a.text ?? ""));

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
				webTarget(url); // throws on a non-http(s) scheme, same gate as the DOM backend
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

export const CDP_RULES = `Rules for this backend (CDP-direct via playwright, follow them):
- The observation is the WHOLE accessibility tree — nothing is budget-omitted. "find" exists as a search convenience on long pages, not as an escape hatch.
- Address elements by their [ref]. Refs are re-issued on every observation and invalidated by navigate; never reuse a ref across a navigate.
- Any act may pass "query" instead of "ref" to resolve the target by name at action time; it fails cleanly if the name is ambiguous.
- type_text REPLACES the field's content (it is a fill, not an insert) — no select-all is needed first.
- Keys go to the PAGE RENDERER only. Escape closes in-page overlays; cmd/ctrl combos reach the page (an editor's cmd+b works) but can NEVER trigger the browser's or the OS's own shortcuts — cmd+w cannot close the tab, and there is no menu bar to reach. Native OS dialogs (file pickers, permission prompts) are NOT driveable from here; if one opens, say so and stop.
- The observation opens with the page URL. It is the strongest evidence available: navigation changes it, so a URL check cannot already have been true before the action.
- "navigate" goes straight to an http/https URL and discards every ref you hold.
- Element boxes and the screenshot share one coordinate space; trust the fresh observation over any assumption about layout.`;

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

/** The act tool this backend presents. Same shape as the DOM backend's, minus what CDP has no use for (delivery_mode) — the model should never see a knob that does nothing. */
export const CDP_ACT_TOOL: Anthropic.Tool = {
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
					text: { type: "string", description: "For type_text. Replaces the field's existing content." },
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
