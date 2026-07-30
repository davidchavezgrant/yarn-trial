import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import { Driver } from "./driver.js";
import { MAX_WAIT_MS, OUT, type ObservationBundle, refSurfaces, type WindowRef } from "./harness.js";
import { webTarget } from "./target.js";
import type { ActionRequest } from "./types.js";

const DOM_ACTIONS = ["click", "right_click", "double_click", "hover", "type_text", "press_key", "scroll", "wait", "navigate"] as const;

/**
 * semantic_v2 caps each snapshot at `node_budget` nodes (300, and NOT configurable —
 * it is an output field; snapshot inputs accept no limit and set_config only takes
 * max_image_dimension + the experimental_pip keys). Busy pages exceed it: Notion
 * Calendar's week view reports total_nodes 1176. The driver's answer is `continuation`,
 * an opaque token that returns the next 300 ranked nodes in the SAME ref namespace,
 * so pages merge into one coherent addressable set.
 *
 * Paging is bounded rather than always-exhaustive because the agent re-observes after
 * every action: exhausting 1176 nodes 15 times per run costs far more context than the
 * one element a step actually needs (that is what `find` is for). Exploration inverts
 * the tradeoff — it runs once and wants total coverage — so it passes maxPages Infinity.
 */
const DEFAULT_MAX_PAGES = Number(process.env.DOM_MAX_PAGES ?? 1);

interface SemanticRef {
	ref: string;
	role: string;
	name: string | null;
	value: string | null;
	actions: string[];
	visibility: string;
	frame: string;
}

interface SnapshotMeta {
	complete?: boolean;
	continuation?: string | null;
	node_budget?: number;
	selected_nodes?: number;
	total_nodes?: number;
	omitted?: Record<string, number>;
}

export interface PagedSnapshot {
	refs: SemanticRef[];
	contentRefs: SemanticRef[];
	title: string;
	/**
	 * The tab's URL. Read from the same page payload as the title, which the repo has never
	 * looked at — and it is the single most useful signal a web target has that a native one
	 * does not. It goes into the verification haystack below, where it gives `verify()` a
	 * channel that is discriminating BY CONSTRUCTION: navigation changes the URL, so a route
	 * check cannot be satisfied by the observation taken before the action.
	 */
	url: string;
	outline: string;
	meta: SnapshotMeta;
	pages: number;
	/** True when the continuation chain ran out — every budget-omitted node was retrieved. */
	exhausted: boolean;
	/** Nodes the driver withheld for reasons paging cannot fix (hidden, offscreen, occluded). */
	unreachable: number;
}

/**
 * DOM backend: observes and acts on an Electron/browser target over CDP via the
 * driver's browser_* tools, instead of the AX tree. Requires the target to expose
 * a DevTools endpoint (Electron: relaunch with --remote-debugging-port=<port>).
 * press_key stays on the AX path — OS-level keys (escape, cmd-shortcuts) have no
 * CDP equivalent that reaches the app's native layer.
 */
/**
 * Bindings the driver will accept mutations on.
 *
 * Deliberately a rejection of `heuristic` alone, NOT a requirement of `exact`. The enum also
 * carries `embedded_single_page` and `native_cdp_window`, and an Electron app — the only DOM
 * target that works today — reports one of those; demanding `exact` would brick it. The driver
 * refuses mutations only on a title-only heuristic match ("mutations require an exact bounds-
 * or cardinality-correlated binding"), so that is the one to catch here rather than at the
 * first click.
 */
function assertBindable(quality: string | undefined): void {
	if (quality === "heuristic")
		throw new Error(
			"CDP binding is heuristic (title-only) — the driver refuses mutations on it. " +
				"Close duplicate windows of the target so the window can be matched exactly.",
		);
}

/**
 * Choose the tab to drive.
 *
 * Without an origin this keeps the historical behaviour exactly — the first tab, which is the
 * right and only answer for an Electron app that has one. With one, a real browser's twenty
 * tabs are filtered to the target site, and an ambiguous match is REFUSED rather than guessed:
 * driving the wrong tab of the right site is worse than losing the run, because it looks like
 * it worked. This mirrors resolveRef's treatment of an ambiguous query.
 */
export function pickTab(tabs: unknown, wantOrigin?: string): { tab_id: string; title?: string; url?: string } | undefined {
	const all = (Array.isArray(tabs) ? tabs : []) as Array<{ tab_id: string; title?: string; url?: string }>;
	if (!wantOrigin) return all[0];

	const sameOrigin = all.filter((t) => {
		try {
			return new URL(t.url ?? "").origin === wantOrigin;
		} catch {
			return false;
		}
	});
	// A lone tab is the answer whatever its URL says. Two measured cases need this: a
	// driver-launched profile opens on about:blank before navigation commits, and a site that
	// redirects across origins (notion.so -> www.notion.so, an SSO bounce) lands somewhere the
	// requested origin does not match. Refusing there would reject the very tab we just
	// navigated. Ambiguity among SEVERAL tabs is still refused below — that is the case where
	// guessing could drive the wrong one.
	if (sameOrigin.length === 0) return all.length === 1 ? all[0] : undefined;
	if (sameOrigin.length > 1)
		throw new Error(
			`${sameOrigin.length} tabs are open on ${wantOrigin} and the driver cannot tell which to drive: ` +
				`${sameOrigin.map((t) => JSON.stringify(t.title ?? t.url ?? t.tab_id)).join(", ")}. Close the spares.`,
		);

	return sameOrigin[0];
}

/**
 * Driver errors that mean "the binding you hold is no longer the one to use". Both the codes
 * and the driver's own prose are matched: the codes are stable identifiers, the prose covers
 * the cases the driver reports without one, and matching either alone would silently stop
 * working if that half were reworded.
 */
const STALE_BINDING =
	/browser_binding_stale|browser_ref_stale|browser_tab_not_found|tab moved to a different browser window|connection generation changed|re-run get_browser_state/i;

/**
 * Screen-space origin of the rendered page, for converting AX frames to viewport coordinates.
 *
 * The AXWebArea when there is one (a real browser, where browser chrome occupies the top of
 * the window and the page starts below it), else the window origin (Electron, where the window
 * is the page). Returns undefined only when neither is available, which makes the caller skip
 * the coordinate route rather than click somewhere arbitrary.
 *
 * The largest web area is chosen deliberately: a page with iframes reports several, and the
 * outermost is the one whose origin the viewport is measured from.
 */
export function viewportOrigin(
	elements: Array<{ role?: string; frame?: { x: number; y: number; w: number; h: number } }>,
	windowBounds?: { x: number; y: number },
): { x: number; y: number } | undefined {
	const web = elements
		.filter((e) => e.role === "AXWebArea" && e.frame && e.frame.w > 0 && e.frame.h > 0)
		.sort((a, b) => b.frame!.w * b.frame!.h - a.frame!.w * a.frame!.h)[0];
	if (web?.frame) return { x: web.frame.x, y: web.frame.y };

	return windowBounds ? { x: windowBounds.x, y: windowBounds.y } : undefined;
}

export class DomBackend {
	/** Times the CDP binding was re-established mid-run. Surfaced in the run log. */
	rebinds = 0;
	/** The tab's URL as of the last observation. Empty until the first observe(). */
	url = "";

	private constructor(
		private driver: Driver,
		private win: WindowRef,
		private targetId: string,
		private tabId: string,
		private maxPages: number,
		/** Origin the run is pinned to, so a rebind lands on the same site rather than tab 0. */
		private wantOrigin?: string,
	) {}

	static async bind(driver: Driver, win: WindowRef, maxPages = DEFAULT_MAX_PAGES, wantOrigin?: string): Promise<DomBackend> {
		const r = await driver.act({
			kind: "tool",
			name: "get_browser_state",
			args: { pid: win.pid, window_id: win.windowId },
		});
		const bs = JSON.parse(r.structuredJson ?? "{}");
		const tab = pickTab(bs.tabs, wantOrigin);
		if (!bs.target_id || !tab)
			throw new Error(`CDP bind failed for pid=${win.pid}: ${r.text.slice(0, 200)}`);
		assertBindable(bs.binding_quality);

		console.log(
			`DOM backend bound: ${bs.target_id} (${bs.binding_quality}) tab "${tab.title}" ` +
				`maxPages=${maxPages === Infinity ? "exhaustive" : maxPages}`,
		);

		return new DomBackend(driver, win, bs.target_id, tab.tab_id, maxPages, wantOrigin);
	}

	/**
	 * Re-run the bind and adopt the new ids.
	 *
	 * A live site invalidates a binding as a matter of course — a redirect, an OAuth bounce, a
	 * tab dragged to another window — so this is a normal event rather than a fault, and the
	 * same shape as the session revival in driver.ts: recover once, count it, and let a second
	 * failure be a real error.
	 */
	private async rebind(): Promise<void> {
		const r = await this.driver.act({
			kind: "tool",
			name: "get_browser_state",
			args: { pid: this.win.pid, window_id: this.win.windowId },
		});
		const bs = JSON.parse(r.structuredJson ?? "{}");
		const tab = pickTab(bs.tabs, this.wantOrigin);
		if (!bs.target_id || !tab) throw new Error(`CDP rebind failed for pid=${this.win.pid}: ${r.text.slice(0, 200)}`);
		assertBindable(bs.binding_quality);
		this.targetId = bs.target_id;
		this.tabId = tab.tab_id;
		this.rebinds++;
	}

	/**
	 * Run a call, and on a staleness error rebind and run it once more.
	 *
	 * Matches the thrown MESSAGE rather than an error code because `Driver.act` converts every
	 * error result into a thrown Error (`throwIfError`), so `errorCode` never reaches a caller.
	 * Both the codes and the driver's prose are matched: either alone would silently stop
	 * working if the driver reworded one of them.
	 */
	private async withRebind<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (err) {
			const m = String(err instanceof Error ? err.message : err);
			if (!STALE_BINDING.test(m)) throw err;
			console.log(`  CDP binding went stale — rebinding and retrying once`);
			await this.rebind();

			return fn();
		}
	}

	private get target(): Record<string, unknown> {
		return { target_id: this.targetId, tab_id: this.tabId };
	}

	private async snapshot(extra: Record<string, unknown>): Promise<any> {
		const r = await this.driver.act({
			kind: "tool",
			name: "get_browser_state",
			args: { ...this.target, snapshot_format: "semantic_v2", ...extra },
		});

		return JSON.parse(r.structuredJson ?? "{}");
	}

	/**
	 * Walk the continuation chain up to `maxPages`. Pages share one ref namespace, so
	 * the merged set is addressable as a whole. A continuation is invalidated by
	 * navigation or staleness ("the page navigated since this semantic continuation was
	 * minted") — that is a normal race on a live app, not a run-ending error, so we keep
	 * the pages already collected and report the chain as unexhausted.
	 */
	async snapshotPaged(maxPages = this.maxPages): Promise<PagedSnapshot> {
		const byRef = new Map<string, SemanticRef>();
		const contentByRef = new Map<string, SemanticRef>();
		let continuation: string | undefined;
		let meta: SnapshotMeta = {};
		let title = "";
	let url = "";
		let outline = "";
		let pages = 0;
		let stalled = false;

		while (pages < maxPages) {
			let sj: any;
			try {
				sj = await this.snapshot(continuation ? { continuation } : {});
			} catch (err) {
				if (!continuation) throw err; // page 1 failing is a real error
				console.log(`  continuation invalidated after ${pages} page(s): ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
				stalled = true;
				break;
			}
			pages++;
			for (const r of sj.refs ?? []) byRef.set(r.ref, r);
			for (const r of sj.content_refs ?? []) contentByRef.set(r.ref, r);
			meta = sj.snapshot ?? {};
			if (pages === 1) {
				title = sj.page?.title ?? "";
				url = sj.page?.url ?? sj.tab?.url ?? "";
				outline = sj.outline ?? "";
			}
			continuation = meta.continuation ?? undefined;
			if (!continuation) break;
		}

		const om = meta.omitted ?? {};
		// omitted.budget is what paging recovers; the rest is withheld for reasons more
		// pages cannot fix, so exhausting the chain is not the same as seeing everything.
		const unreachable = Object.entries(om)
			.filter(([k]) => k !== "budget")
			.reduce((n, [, v]) => n + (v ?? 0), 0);

		return {
			refs: [...byRef.values()],
			contentRefs: [...contentByRef.values()],
			title,
			url,
			outline,
			meta,
			pages,
			exhausted: !stalled && !continuation,
			unreachable,
		};
	}

	/**
	 * Read-only semantic match over role, accessible name, and visible text. Resolves by
	 * meaning rather than layout rank, so it reaches elements the ranker dropped from a
	 * budgeted snapshot — one call instead of paging the whole tree.
	 */
	async find(query: string): Promise<SemanticRef[]> {
		const sj = await this.snapshot({ query });

		return [...(sj.refs ?? []), ...(sj.content_refs ?? [])];
	}

	async observe(shotName: string, maxPages = this.maxPages): Promise<ObservationBundle> {
		const snap = await this.snapshotPaged(maxPages);

		const lines: string[] = [];
		const haystackParts: string[] = [];
		for (const r of snap.refs) {
			if (r.name) haystackParts.push(r.name);
			if (r.value) haystackParts.push(r.value);
			const val = r.value && r.value !== r.name ? ` value="${r.value.slice(0, 80)}"` : "";
			const vis = r.visibility !== "in_viewport" ? ` ${r.visibility}` : "";
			lines.push(`[${r.ref}] ${r.role} "${(r.name ?? "").slice(0, 80)}"${val} (${r.actions.join(",")})${vis}`);
		}
		const texts = new Set<string>();
		for (const r of snap.contentRefs) {
			if (!r.name || texts.has(r.name)) continue;
			texts.add(r.name);
			haystackParts.push(r.name);
		}

		// An exhaustive pass exists to be complete; truncating its text would defeat it.
		const textCap = maxPages === Infinity ? Number.POSITIVE_INFINITY : 120;
		const shownTexts = [...texts].slice(0, textCap === Infinity ? texts.size : textCap);
		const m = snap.meta;
		const coverage =
			`\n(coverage: ${snap.pages} page(s), ${m.selected_nodes ?? "?"}/${m.total_nodes ?? "?"} nodes` +
			`${snap.exhausted ? ", chain exhausted" : `, MORE AVAILABLE — ${m.omitted?.budget ?? 0} node(s) still budget-omitted`}` +
			`${snap.unreachable ? `; ${snap.unreachable} node(s) hidden/offscreen/occluded and unreachable by paging` : ""}` +
			`. Elements missing here can still be reached by name with the "find" tool.)`;
		// The URL leads, because on a web target it is the cheapest orientation the model gets:
		// which route it is on answers "where am I" before any element list has to be read.
		const where = snap.url ? `URL: ${snap.url}\n\n` : "";
		const elementsText =
			`${where}Interactive refs:\n${lines.join("\n")}\n\nVisible text: ${shownTexts.map((t) => JSON.stringify(t.slice(0, 60))).join(", ")}${coverage}`;

		const surfaces = refSurfaces(snap.refs);
		this.url = snap.url;

		const shotPath = `${OUT}/${shotName}.png`;
		await this.driver.act({
			kind: "tool",
			name: "get_window_state",
			args: { pid: this.win.pid, window_id: this.win.windowId, screenshot_out_file: shotPath },
		});
		// The driver reports success but writes NO FILE when the window is not composited —
		// which happens routinely here, because a navigate can leave the window mid-repaint.
		// Measured: a Notion pass died at action 24 with ENOENT on this exact read, after
		// mapping 27 nodes. The DOM path does not need the image (its perception is the CDP
		// snapshot, and the pixel channel is advisory), so a missing frame degrades the
		// observation instead of ending the run. `observe()` on the AX path throws in the same
		// situation, and correctly: there the screenshot IS the second perception channel.
		const shot = fs.existsSync(shotPath) ? fs.readFileSync(shotPath).toString("base64") : "";
		if (!shot) console.log("  (no frame captured for this observation — window not composited)");

		return {
			elementsText,
			// The geometry channel is an AX-frame comparison and this backend reports no
			// frames, so it simply never fires here — an empty map degrades it silently.
			frames: new Map(),
			// Frontier ledger input. "Advertises an action" is this backend's equivalent of
			// the AX role list; geometry is zero because CDP refs carry no box here, so the
			// ledger's coordinate-containment path never credits anything and the ref path
			// carries it alone. That is correct rather than degraded: this backend has no
			// reason to issue coordinate actions.
			interactive: snap.refs
				.filter((r) => r.actions.length > 0)
				.map((r) => ({
					handle: r.ref,
					role: r.role,
					name: r.name ?? "",
					value: r.value ?? "",
					// Derived geometrically from enclosing ARIA landmarks (see refSurfaces).
					// Without it every ref is surface-less, which both collapses distinct
					// controls in frontierKey and makes every bulk dismissal hit the
					// unnamed-surface cap of 20 — unworkable on a page with hundreds.
					surface: surfaces.get(r.ref) ?? "",
					x: 0,
					y: 0,
					w: 0,
					h: 0,
				})),
			haystack: `${snap.title}\n${snap.url}\n${haystackParts.join("\n")}`.toLowerCase(),
			screenshotB64: shot,
			title: snap.title,
			url: snap.url,
			appContent: snap.refs.length,
			// The CDP path reads the DOM directly, so the axdom sidecar has nothing to add.
			domEnriched: 0,
			domUnavailable: "not applicable — DOM backend already reads the DOM over CDP",
		};
	}

	/**
	 * Resolve an action's target. `ref` addresses an element from the current
	 * observation; `query` resolves by name at action time, which is how the model
	 * reaches an element the budget dropped. Ambiguity is refused rather than guessed —
	 * clicking the wrong one of five matches is worse than losing a turn.
	 */
	private async resolveRef(a: any): Promise<{ ref: string; el?: SemanticRef }> {
		if (a.ref) return { ref: a.ref };
		if (!a.query) throw new Error(`action "${a.name}" needs either a ref (from the observation) or a query (to resolve by name)`);

		const matches = await this.find(a.query);
		if (matches.length === 0)
			throw new Error(`query "${a.query}" matched nothing — try "find" with a shorter or different string`);

		// Advertised actions disambiguate, they do not gate: the timezone gutter label
		// advertises none yet right-clicks fine, so a lone match is always attempted and
		// the driver gets to be the one that refuses.
		const actionable = matches.filter((r) => r.actions.length > 0);
		const candidates = actionable.length > 0 ? actionable : matches;
		if (candidates.length > 1) {
			const list = candidates.slice(0, 8).map((r) => `[${r.ref}] ${r.role} "${r.name ?? ""}"`).join("; ");
			throw new Error(`query "${a.query}" matched ${candidates.length} elements — pass an explicit ref instead: ${list}`);
		}

		return { ref: candidates[0].ref, el: candidates[0] };
	}

	/**
	 * Locate an element by name on the AX side and return its centre in the viewport
	 * coordinates browser_pointer expects.
	 *
	 * semantic refs carry no geometry and query_dom returns nothing for this Electron
	 * target, so the AX tree is the only coordinate source — but AX frames are in SCREEN
	 * space while browser_pointer wants viewport space. On Electron the difference is exactly
	 * the window origin: measured on Notion Calendar, the EDT label sits at AX (295,129) and
	 * DOM (285,95.5) with the window at (0,33) — x matches within rounding, y differs by the
	 * window's y origin.
	 *
	 * That equivalence holds only because an Electron window IS its page. In a real browser
	 * the tab strip, omnibox and bookmarks bar sit INSIDE the window, roughly 80–90px of it,
	 * so subtracting the window origin lands every click that far too high — a silent
	 * mis-click, the failure LIMITATIONS §4 warns about.
	 *
	 * The fix uses a source we already fetch rather than a guess. `viewport_x`/`viewport_y`
	 * are NOT `get_browser_state` fields (they belong to browser_screenshot and the legacy
	 * page tool — checked against the driver binary), but the AX tree carries the answer
	 * directly: the AXWebArea element's own frame origin IS the top-left of the rendered page.
	 * Prefer it, and fall back to the window origin when there is no web area, which is the
	 * Electron case and reproduces the old behaviour exactly.
	 */
	private async axCentre(name: string): Promise<{ x: number; y: number } | undefined> {
		const [st, lw] = await Promise.all([
			this.driver.act({ kind: "tool", name: "get_window_state", args: { pid: this.win.pid, window_id: this.win.windowId } }),
			this.driver.act({ kind: "tool", name: "list_windows", args: {} }),
		]);
		const els: any[] = JSON.parse(st.structuredJson ?? "{}").elements ?? [];
		const target = name.trim().toLowerCase();
		const hit = els.find((e) => String(e.label ?? "").trim().toLowerCase() === target)
			?? els.find((e) => String(e.value ?? "").trim().toLowerCase() === target)
			?? els.find((e) => String(e.label ?? "").toLowerCase().includes(target));
		if (!hit?.frame) return undefined;

		const bounds = (JSON.parse(lw.structuredJson ?? "{}").windows ?? [])
			.find((w: any) => w.window_id === this.win.windowId)?.bounds;
		const origin = viewportOrigin(els, bounds);
		if (!origin) return undefined;

		return {
			x: Math.round(hit.frame.x + hit.frame.w / 2 - origin.x),
			y: Math.round(hit.frame.y + hit.frame.h / 2 - origin.y),
		};
	}

	/**
	 * Same contract as harness.toActionRequest: null for wait, throws for
	 * unsupported actions (caller reports back to the model, run continues).
	 */
	async toRequest(a: any): Promise<ActionRequest | null> {
		switch (a.name) {
			case "wait":
				return null;
			case "click": {
				// Same capability wall as pointer actions, and it bites hardest inside
				// context menus: Notion Calendar's menu rows are bare statictext with no
				// declared click, so a ref click is refused for every item in the menu a
				// right-click just opened. browser_click accepts x/y in place of a ref
				// ("browser_click needs a ref or x/y coordinates"), which skips the check.
				const { ref, el } = await this.resolveRef(a);
				if (el && !el.actions.includes("click") && el.name) {
					const pt = await this.axCentre(el.name);
					if (pt) return { kind: "tool", name: "browser_click", args: { ...this.target, x: pt.x, y: pt.y } };
				}

				return { kind: "tool", name: "browser_click", args: { ...this.target, ref } };
			}
			case "right_click":
			case "double_click":
			case "hover": {
				// browser_pointer enforces DECLARED capabilities: a ref that does not
				// advertise "pointer" is refused even when the element handles the event
				// perfectly well (Notion Calendar's timezone gutter label is a bare
				// statictext, yet right-clicking it opens the real context menu). The
				// coordinate route takes no ref and so skips that check — measured as the
				// only way to reach these elements over CDP.
				const { ref, el } = await this.resolveRef(a);
				if (el && !el.actions.includes("pointer") && el.name) {
					const pt = await this.axCentre(el.name);
					if (pt)
						return { kind: "tool", name: "browser_pointer", args: { ...this.target, action: a.name, x: pt.x, y: pt.y } };
				}

				return { kind: "tool", name: "browser_pointer", args: { ...this.target, action: a.name, ref } };
			}
			case "type_text":
				return { kind: "tool", name: "browser_type", args: { ...this.target, ref: (await this.resolveRef(a)).ref, text: a.text, ...(a.mode ? { mode: a.mode } : {}) } };
			case "scroll":
				return {
					kind: "tool",
					name: "browser_pointer",
					args: {
						...this.target,
						action: "scroll",
						...(a.ref || a.query ? { ref: (await this.resolveRef(a)).ref } : {}),
						delta_x: a.direction === "left" ? -(a.amount ?? 3) * 120 : a.direction === "right" ? (a.amount ?? 3) * 120 : 0,
						delta_y: a.direction === "up" ? -(a.amount ?? 3) * 120 : a.direction === "down" ? (a.amount ?? 3) * 120 : 0,
					},
				};
			case "navigate": {
				// Scheme-checked by the same function the CLI uses, so "http/https only" is
				// stated once. The driver refuses anything else anyway; failing here turns a
				// mid-run refusal into a rejected step the model can correct.
				const url = webTarget(String(a.url ?? "")).kind === "web" ? String(a.url) : "";

				return { kind: "tool", name: "browser_navigate", args: { ...this.target, url } };
			}
			case "press_key":
				return {
					kind: "tool",
					name: "press_key",
					args: {
						pid: this.win.pid,
						window_id: this.win.windowId,
						key: a.key,
						...(a.modifiers ? { modifiers: a.modifiers } : {}),
						...(a.delivery_mode ? { delivery_mode: a.delivery_mode } : {}),
					},
				};
			default:
				throw new Error(`unsupported action "${a.name}" — DOM backend supports: ${DOM_ACTIONS.join(", ")}`);
		}
	}
}

export const DOM_RULES = `Rules learned from this driver's DOM/CDP path (follow them):
- Address elements by ref (like "p3:7") from the CURRENT observation only — refs are invalidated by newer snapshots.
- The observation is BUDGET-LIMITED: busy pages have far more elements than the snapshot shows, and the coverage line tells you how many are missing. An element you expect but cannot see is probably omitted, NOT absent.
- Use the "find" tool to reach those: it matches by role, accessible name, and visible text over the whole page, ignoring the budget. When a control you need is not in the observation, find it by name before concluding it does not exist.
- Any act targeting an element may pass "query" instead of "ref" to resolve it by name at action time. Use that when the element is not in the observation; it fails cleanly if the name is ambiguous.
- Each ref lists its capabilities: only "click" refs take click; "pointer" refs take right_click/double_click/hover/scroll; "type" refs (textboxes) take type_text directly — type_text focuses the field itself, no click needed first.
- type_text INSERTS at the cursor. To replace existing text: type_text once to focus, then press_key cmd+a, press_key delete, then type_text the new value.
- press_key goes through the OS, not CDP: escape to close overlays and menu shortcuts (cmd+,) need delivery_mode "foreground". Everything else runs fully backgrounded — the app never needs focus.
- The visible-text list is your verification surface; element names come from the accessibility name, so unnamed containers appear as "".
- The observation opens with the page URL. It is real evidence and it is the strongest kind available here: navigation changes it, so a URL check cannot already have been true before the action.
- "navigate" goes straight to a URL (http/https). It DISCARDS every ref you are holding — the next observation renumbers them, so never reuse a ref across a navigate.
- OS-level keys reach the browser, not the page. Escape and plain keys are fine; anything with cmd is the BROWSER's shortcut, not the app's.`;

export const FIND_TOOL: Anthropic.Tool = {
	name: "find",
	description:
		"Search the WHOLE page for elements by role, accessible name, or visible text, ignoring the snapshot's node budget. " +
		"Read-only: it performs no action and does not count as your action for the turn. " +
		"Use it when a control you need is missing from the observation — the observation is truncated, so absence there is not evidence the element does not exist.",
	input_schema: {
		type: "object",
		properties: {
			query: { type: "string", description: 'Text to match, e.g. "Time zone" or "GMT+2". Shorter, distinctive strings match best.' },
		},
		required: ["query"],
	},
};

export const DOM_ACT_TOOL: Anthropic.Tool = {
	name: "act",
	description: "Perform one UI action on the target page and state the expected observable effect.",
	input_schema: {
		type: "object",
		properties: {
			reasoning: { type: "string", description: "One sentence: why this action now." },
			action: {
				type: "object",
				properties: {
					name: { type: "string", enum: [...DOM_ACTIONS] },
					ref: { type: "string", description: "Target ref from the current observation (click/right_click/double_click/hover/type_text, optional for scroll)." },
					query: { type: "string", description: "Alternative to ref: resolve the target by name at action time. Use for elements omitted from the observation. Refused if it matches more than one element." },
					text: { type: "string", description: "For type_text." },
					key: { type: "string", description: "For press_key: return, tab, escape, up, down, a-z, 0-9, etc." },
					url: { type: "string", description: "For navigate: an http/https URL. Invalidates every ref from the current observation." },
					modifiers: { type: "array", items: { type: "string" }, description: "For press_key: cmd, shift, option, ctrl." },
					delivery_mode: { type: "string", enum: ["background", "foreground"], description: "For press_key." },
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
