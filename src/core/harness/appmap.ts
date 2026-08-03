import fs from "node:fs";
import { appmapsDir, appSlug } from "../../paths.js";
import { Driver } from "../driver.js";
import type { AppMap, AppMapEdge, AppMapHome, AppMapNode, ScopeAmbiguity, SurfaceScope } from "../../types.js";
import { isAppContent, observe } from "./observation.js";
import type { ObservationBundle, WindowRef } from "./observation.js";

/**
 * The surface exploration started from: the one surface no edge leads to.
 *
 * Derived structurally rather than by looking for an id called "root", because that id is a
 * convention of one exploration pass and not part of the schema. Undefined unless exactly one
 * surface qualifies — zero means every surface is reachable (a cycle) and more than one means
 * the graph is disconnected; in both cases there is no single landing state to speak of, and
 * guessing between candidates is worse than admitting it.
 */
export function rootSurface(graph: AppMap): AppMapNode | undefined {
	const targets = new Set(graph.edges.map((e) => e.to));
	const roots = graph.nodes.filter((n) => n.kind === "surface" && !targets.has(n.id));

	return roots.length === 1 ? roots[0] : undefined;
}

/**
 * Labels of the controls that sit on the root surface, taken from the edges leaving it.
 *
 * Edge actions are prose ('click "Brand Kit" in bottom-left rail') and the quoted span is the
 * label the walk actually observed, so it is the one string in the graph that can be matched
 * against a live observation. Used only to answer "does this app look like itself right now" —
 * never to decide where to click.
 */
export function rootControlLabels(graph: AppMap): string[] {
	const root = rootSurface(graph);
	if (!root) return [];

	const labels = graph.edges.filter((e) => e.from === root.id).flatMap((e) => quotedLabels(e.action));

	return [...new Set(labels)];
}

/** The labels an edge action quotes — the only strings in the graph a live observation can match. */
function quotedLabels(action: string): string[] {
	return [...action.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((l) => l.trim());
}

/**
 * Accept a declared home only if the pass can show its own evidence for it.
 *
 * The surface must be a node the walk recorded, and the control label must appear in some edge
 * action — that is where the walk quotes labels it actually operated. Both are weak checks and
 * that is deliberate: they catch a fabricated or misremembered label at the end of a 40-minute,
 * context-reset transcript, which is the realistic failure, without pretending to validate
 * against a live app that is no longer running by the time this is called.
 *
 * Worth being strict about because this one field is written once and then silently governs the
 * start state of every future run: a label the pass never saw becomes a permanent, invisible
 * "failed" reset. Dropping it costs only the normalisation and keeps the readiness check.
 */
export function checkHome(
	home: AppMapHome | undefined,
	nodes: AppMapNode[],
	edges: AppMapEdge[],
): { home?: AppMapHome; problem?: string } {
	if (!home) return {};
	if (!home.surface?.trim() || !home.control?.trim()) return { problem: "surface and control are both required" };
	if (!nodes.some((n) => n.id === home.surface)) return { problem: `surface "${home.surface}" is not a node in the graph` };

	const quoted = new Set(edges.flatMap((e) => quotedLabels(e.action)));
	if (!quoted.has(home.control))
		return { problem: `control "${home.control}" appears in no edge action, so the pass never recorded operating it` };

	return { home };
}

export type HomeResetResult = "reset" | "already-home" | "none" | "failed" | "root-visible";

/**
 * Put the app in a known state before a run, and refuse to proceed if it is not in one.
 *
 * A run that begins wherever the last run happened to stop is not a measurement — it inherits
 * that run's navigation for free. (Measured: the Yarn cursor task took 3 actions starting on
 * the settings page it ends on, vs 4 from the app's home view; the difference is entirely the
 * navigation step the warm start skipped.)
 *
 * The home state is DECLARED IN THE APPMAP, not in this file. It used to be a table here
 * keyed by app slug, which was app-specific data in general-purpose code and, worse, meant the
 * unusable-app refusal in agent.ts only fired for the two apps that happened to be listed —
 * every newly onboarded app got "none" and was driven straight into its login wall.
 *
 * So there are two tiers, and the weaker one is the one that generalises:
 *
 *  - A declared home is clicked, which both normalises the start state and proves the app is
 *    usable.
 *  - With no declared home we can still ask whether ANY control from the app's landing surface
 *    is on screen. That does not normalise anything, so it is reported as `root-visible` and
 *    not as a reset — but it is a real answer to "is this app at a sign-in wall", and it works
 *    for any app with a map.
 *
 * Nothing here knows what a login looks like; that would be app-specific. It knows only
 * whether the app's own recorded landing state can be seen.
 */
/**
 * A short census of the named controls actually visible, for a diagnostic that would otherwise
 * only say what is missing.
 *
 * Deliberately app-agnostic: it reports labels, it does not try to classify them. Nothing here
 * knows what a login screen looks like — a reader does, from the labels.
 */
function onScreenSummary(obs: ObservationBundle): string {
	if (!obs.appContent) return " — and the app has NO content elements at all";

	// Menu-bar items last, not excluded: every Mac app carries the same ~70 of them ("About
	// This Mac", "System Settings…"), so unfiltered they crowd out the handful of labels that
	// identify the screen — on the first real use they pushed "Sign in with SSO" to fourth
	// place and filled the rest of the line. They still belong in the tail, because an app
	// whose ONLY named controls are menu items is itself the diagnosis.
	const named = obs.interactive.filter((e) => e.name.trim());
	const names = [
		...new Set([...named.filter(isAppContent), ...named.filter((e) => !isAppContent(e))].map((e) => e.name.trim())),
	];
	if (!names.length) return ` — ${obs.appContent} content elements, none of them a named control`;

	const shown = names.slice(0, 12);

	return ` — on screen instead: ${shown.map((n) => `"${n}"`).join(", ")}${names.length > shown.length ? `, +${names.length - shown.length} more` : ""}`;
}

/**
 * Which labels prove this app's landing surface is on screen — or why none can be named.
 *
 * Shared by the reset and the read-only probe below, because "is the app at home" has to mean
 * the same thing in both. They answer for different callers (one normalises a run's start
 * state, one waits for a human to finish signing in) and a second, drifting copy of the rule
 * would let a sign-in be declared complete against a screen the next run then refuses.
 */
function homeTargets(app: string, graph: AppMap | undefined): { home?: AppMap["home"]; wanted: string[]; problem?: string } {
	if (!graph) return { wanted: [], problem: `no appmap for "${app}" — run: npm run explore -- "${app}"` };

	// Any of the fallback labels will do; a declared home wants its own.
	const home = graph.home;
	const wanted = home ? [home.control] : rootControlLabels(graph);
	if (!wanted.length) return { wanted, problem: `appmap for "${app}" declares no home and has no identifiable landing surface` };

	return { home, wanted };
}

/**
 * The first observation line whose ELEMENT LABEL is one of `wanted`.
 *
 * Anchored to the role-label position — `[42] AXButton "Library"` — not a bare substring of
 * the rendered line. A line also carries `value="..."` and `in="..."` in the same quoted form,
 * so an unanchored `includes('"Library"')` matched a combobox reading value="Library", or any
 * control nested under a panel whose nearest named ancestor is "Library". Whichever such line
 * came first in walk order won, its index was parsed, and resetToHome clicked it — or probeHome
 * declared a sign-in wall "ready" because a dropdown happened to read the home label.
 */
function findHomeLine(text: string, wanted: string[]): string | undefined {
	return text.split("\n").find((l) => {
		const label = l.match(/^\[\d+\] \S+ "([^"]*)"/)?.[1];

		return label !== undefined && wanted.includes(label);
	});
}

/**
 * Is the app sitting at its declared home right now? Observes and answers — nothing else.
 *
 * The read-only counterpart to `resetToHome`, and the difference is the point. It exists to be
 * called repeatedly while a HUMAN is using the app (signing it in over screen sharing), where
 * the reset's two side effects are both destructive: the escape would dismiss the dialog they
 * are filling in, and the click would navigate away from it. So there is no escape and no
 * click here, and a run of these leaves the app exactly as it found it.
 *
 * Nothing here knows what a sign-in looks like. It knows whether the app's own recorded landing
 * state can be seen, which is as app-agnostic as the reset it shares its rules with.
 */
/**
 * The same home question, answered from an observation already in hand — no driver, no
 * clicks. Exists for the CDP path: an app target has no home URL for goHome to navigate,
 * and its element lines are ref-shaped so findHomeLine's `[42] AXRole "label"` anchor never
 * matches — but the observation's `interactive` list carries the same element LABELS on both
 * backends (never values, which is the trap findHomeLine's anchor exists to avoid).
 *
 * `ready: undefined` means the question cannot be answered (no appmap / no landing surface);
 * the caller keeps its "none" posture rather than refusing an unmapped app.
 */
/**
 * The control labels that mean "this app is at its signed-in home screen", for a caller that
 * has no ObservationBundle to hand `homeVisible`. Empty when the question cannot be answered
 * (no appmap, no landing surface) — a caller must treat that as "unknown", never "not home".
 *
 * Exists for liveview's CDP engine, which watches for the end of a sign-in by reading these
 * labels out of the page's own DOM. It cannot build an ObservationBundle: that needs a driver
 * session, and a sign-in stream is already holding the app.
 */
export function homeLabels(app: string, graph: AppMap | undefined = loadAppMapGraph(appSlug(app))): string[] {
	return homeTargets(app, graph).wanted;
}

export function homeVisible(
	app: string,
	obs: ObservationBundle,
	graph: AppMap | undefined = loadAppMapGraph(appSlug(app)),
): { ready: boolean | undefined; detail: string } {
	const target = homeTargets(app, graph);
	if (target.problem) return { ready: undefined, detail: target.problem };
	if (obs.interactive.some((e) => target.wanted.includes(e.name.trim())))
		return {
			ready: true,
			detail: target.home ? `home control "${target.home.control}" is on screen` : `the landing surface of "${app}" is on screen`,
		};

	return { ready: false, detail: `${target.wanted.map((l) => `"${l}"`).join(", ")} not on screen${onScreenSummary(obs)}` };
}

export async function probeHome(
	driver: Driver,
	win: WindowRef,
	app: string,
	graph: AppMap | undefined = loadAppMapGraph(appSlug(app)),
): Promise<{ ready: boolean; detail: string }> {
	const target = homeTargets(app, graph);
	if (target.problem) return { ready: false, detail: target.problem };

	const obs = await observe(driver, win, "home-probe");
	if (findHomeLine(obs.elementsText, target.wanted))
		return {
			ready: true,
			detail: target.home ? `home control "${target.home.control}" is on screen` : `the landing surface of "${app}" is on screen`,
		};

	return { ready: false, detail: `${target.wanted.map((l) => `"${l}"`).join(", ")} not on screen${onScreenSummary(obs)}` };
}

export async function resetToHome(
	driver: Driver,
	win: WindowRef,
	app: string,
	graph: AppMap | undefined = loadAppMapGraph(appSlug(app)),
): Promise<{ result: HomeResetResult; detail: string }> {
	// Loaded here rather than passed down from agent.ts on purpose: there, the graph is gated
	// on grounding being enabled, and a reset that only happens in the grounded arm would make
	// every A/B comparison measure the reset instead of the grounding.
	const target = homeTargets(app, graph);
	if (target.problem) return { result: "none", detail: target.problem };

	const home = target.home;
	const wanted = target.wanted;
	const findLine = (text: string): string | undefined => findHomeLine(text, wanted);

	// An overlay left open by the previous run hides the sidebar: Yarn's dropdowns overlay
	// the page and sidebar elements vanish from the AX tree entirely, so the home control
	// is simply not there. That surfaced as homeReset "failed" and a run that silently
	// started wherever the last one stopped — the exact non-comparability the reset exists
	// to prevent. Escape first, then retry once.
	let obs = await observe(driver, win, "home-reset-probe");
	let line = findLine(obs.elementsText);
	let dismissed = false;
	if (!line) {
		await driver.act({
			kind: "tool",
			name: "press_key",
			args: { pid: win.pid, window_id: win.windowId, key: "escape", delivery_mode: "foreground" },
		});
		await new Promise((r) => setTimeout(r, 900));
		obs = await observe(driver, win, "home-reset-probe");
		line = findLine(obs.elementsText);
		dismissed = true;
	}
	if (!line)
		return {
			result: "failed",
			detail:
				(home
					? `home control "${home.control}" not present, even after escape`
					: `nothing from the landing surface of "${app}" is on screen, even after escape (looked for ${wanted.map((l) => `"${l}"`).join(", ")})`) +
				// What IS on screen, because the absence alone is unactionable. A sign-in wall, a
				// leftover modal and a different view all produce the identical "not present", and
				// the operator's next move differs for each. Measured on mac1, 2026-07-30: the run
				// refused with only the missing name and nothing in the log said whether the app
				// wanted a password or had a dialog open.
				onScreenSummary(obs),
		};

	// Without a declared home there is nowhere specific to click: the labels above prove the
	// app is usable, which is the safety half, but normalising the start state needs to know
	// WHICH surface is home and that is exactly what the map is missing.
	if (!home)
		return {
			result: "root-visible",
			detail: `landing surface of "${app}" is on screen, but the appmap declares no home — start state is not normalised; re-run: npm run explore -- "${app}"`,
		};

	const index = Number(line.match(/^\[(\d+)\]/)?.[1]);
	if (!Number.isFinite(index)) return { result: "failed", detail: `could not parse index from: ${line}` };

	await driver.act({
		kind: "tool",
		name: "click",
		args: { pid: win.pid, window_id: win.windowId, element_index: index, delivery_mode: "foreground" },
	});
	await new Promise((r) => setTimeout(r, 1200));

	return {
		result: "reset",
		detail: `${dismissed ? "escaped a leftover overlay, then " : ""}clicked "${home.control}" → ${home.description}`,
	};
}

/**
 * Controls that edit the SAME setting from different scopes — the failure this graph exists
 * to surface. Measured on Yarn: "Cursor Style" is editable brand-wide (Brand Kit ▸ Screen
 * Clips) and per-draft (Project actions ▸ Screen Clip Settings), they are independent stores,
 * and all four ungrounded runs silently changed the per-draft one while passing verification.
 */
export function findScopeAmbiguities(map: AppMap): ScopeAmbiguity[] {
	const byKey = new Map<string, Array<{ id: string; scope: SurfaceScope }>>();
	for (const n of unifySettingKeys(map).nodes) {
		if (!n.settingKey) continue;
		const list = byKey.get(n.settingKey) ?? [];
		list.push({ id: n.id, scope: n.scope });
		byKey.set(n.settingKey, list);
	}

	const out: ScopeAmbiguity[] = [];
	for (const [settingKey, nodes] of byKey) {
		if (new Set(nodes.map((n) => n.scope)).size > 1) out.push({ settingKey, nodes });
	}

	return out.sort((a, b) => a.settingKey.localeCompare(b.settingKey));
}

/** Titles compare on letters and digits only: "Cursor Style", "cursor style" and "Cursor  Style" are one setting. */
const normTitle = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Repair settings that the explore model gave DIFFERENT keys at different scopes.
 *
 * `settingKey` is free text the model invents, and nothing validated it. The pairing is the
 * entire mechanism by which the next agent learns a setting has two stores — so a split key
 * does not degrade the warning, it DELETES it, silently and indistinguishably from a setting
 * that genuinely lives in one place.
 *
 * Measured on 2026-08-01, same app, same two controls:
 *   yarn.cdp  brand `cursor-style`              document `cursor-style`              -> paired
 *   yarn.ax   brand `screen-clip-cursor-style`  document `cursor-style`              -> SPLIT
 * The canonical task is "show me how to change the cursor type", so the ax-grounded arm would
 * have received no warning at all and the report would have read "CDP grounding prevents the
 * wrong-scope failure, AX grounding does not" — a backend conclusion caused by one prefix in
 * one transcript. Re-running does not fix that; it re-rolls the dice.
 *
 * The repair is deliberately narrow. Two nodes merge only when BOTH already carry a
 * settingKey (the model already judged each a setting), their titles match once punctuation
 * and case are stripped, and their scopes DIFFER. That last condition is what keeps it safe:
 * two same-scope controls sharing a title are two editors of one store, which is not an
 * ambiguity and must not become one. A false merge here can only ever produce a warning that
 * a setting exists at two scopes — which, given the scopes differ, is true.
 */
export function unifySettingKeys(map: AppMap): AppMap {
	const byTitle = new Map<string, AppMapNode[]>();
	for (const n of map.nodes) {
		if (!n.settingKey || !n.title) continue;
		const k = normTitle(n.title);
		byTitle.set(k, [...(byTitle.get(k) ?? []), n]);
	}

	const rewrite = new Map<string, string>();
	for (const [, nodes] of byTitle) {
		const keys = new Set(nodes.map((n) => n.settingKey as string));
		const scopes = new Set(nodes.map((n) => n.scope));
		if (keys.size < 2 || scopes.size < 2) continue;
		// Shortest key wins: the split is invariably one side carrying a surface prefix
		// ("screen-clip-cursor-style" vs "cursor-style"), and the unprefixed one is the
		// setting's own name. Ties break alphabetically so the choice is deterministic.
		const canonical = [...keys].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
		for (const k of keys) if (k !== canonical) rewrite.set(k, canonical);
	}
	if (!rewrite.size) return map;

	return { ...map, nodes: map.nodes.map((n) => (n.settingKey && rewrite.has(n.settingKey) ? { ...n, settingKey: rewrite.get(n.settingKey) as string } : n)) };
}

/**
 * Prompt text warning the agent about ambiguous settings, appended to the prose map. Prose
 * alone did not prevent the wrong-scope changes; naming each collision explicitly, with the
 * scope of every candidate, gives the model something it cannot skim past.
 */
/**
 * The click-path to a node, as recorded by exploration. Edges are keyed by node id, and a
 * control's route is the path to its parent surface — you navigate to the panel, not to the
 * combobox inside it.
 *
 * Lifted out of `scopeWarnings`, where it was a closure, because teardown needs the same walk
 * to tell a restore where its control lives (`restoreRoute` in src/core/journal.ts).
 */
export function routeTo(map: AppMap, nodeId: string): string {
	const surface = map.nodes.find((n) => n.id === nodeId)?.kind === "control"
		? nodeId.split("/").slice(0, -1).join("/")
		: nodeId;
	const hops: string[] = [];
	// VISITED, not just a hop budget. The old loop was bounded by node count so a cyclic graph
	// could not hang — but it happily emitted the cycle that many times: the vision map's
	// agent-effort route rendered as "click Library → click a draft card" repeated dozens of
	// times, 5,570 characters of scope warning on a 5,084-character map. Worse than bloat, it
	// is a nonsense instruction handed to the agent as navigation.
	//
	// Stopping at the first revisit yields the real tail of the path. It may not reach root —
	// a cycle means there is no clean parent chain to find — and a short honest prefix beats a
	// long fabricated one.
	const seen = new Set<string>();
	let cursor = surface;
	while (!seen.has(cursor)) {
		seen.add(cursor);
		const edge = map.edges.find((e) => e.to === cursor);
		if (!edge) break;
		hops.unshift(edge.action);
		if (edge.from === "root") break;
		cursor = edge.from;
	}

	return hops.length ? hops.join(" → ") : "(route not recorded)";
}

export function scopeWarnings(map: AppMap): string {
	const ambiguities = findScopeAmbiguities(map);
	if (ambiguities.length === 0) return "";


	// Group by the SURFACES involved, not per setting. Yarn has ten settings split across the
	// same brand-vs-document pair of panels; listing each separately made the warning 10.8k
	// chars — nearly twice the appmap it is supposed to annotate — by repeating one pair of
	// routes over and over. One entry per surface pair, with the settings it covers.
	const groups = new Map<string, { nodes: Array<{ id: string; scope: SurfaceScope }>; settings: string[] }>();
	for (const a of ambiguities) {
		const surfaceOf = (id: string) =>
			map.nodes.find((n) => n.id === id)?.kind === "control" ? id.split("/").slice(0, -1).join("/") : id;
		// Deduped by scope+surface: a setting with two editors on the SAME surface is one
		// bullet, not two — and the dedup must reach the group key too, or the duplicate
		// spelling splits an identical surface pair into two groups.
		const entries = [
			...new Map(a.nodes.map((n) => [`${n.scope}:${surfaceOf(n.id)}`, { id: surfaceOf(n.id), scope: n.scope }])).values(),
		];
		const pair = entries
			.map((n) => `${n.scope}:${n.id}`)
			.sort()
			.join(" | ");
		const g = groups.get(pair) ?? { nodes: entries, settings: [] };
		g.settings.push(a.settingKey);
		groups.set(pair, g);
	}

	const lines = [...groups.values()].map((g) => {
		const options = g.nodes
			.map((n) => `    · ${n.scope} scope — ${n.id}\n      route: ${routeTo(map, n.id)}`)
			.join("\n");
		// SCOPES, not nodes: two same-scope editors of one setting are one store, and this
		// sentence exists to say how many independent stores there are.
		const scopeCount = new Set(g.nodes.map((n) => n.scope)).size;

		return (
			`- These settings exist at ${scopeCount} scopes — SEPARATE stores, changing one does NOT change the other:\n` +
			`  ${g.settings.join(", ")}\n${options}`
		);
	});

	return (
		`\n\n# Settings that exist at more than one scope (from the structured appmap)\n` +
		`${lines.join("\n")}\n\n` +
		"Both routes are given because either can be correct — it depends on what the task is for. " +
		"Read the task and decide: a request about defaults, brand settings, or 'how it should always " +
		"look' points at the broad scope; a request about this document/project/recording points at the " +
		"override. If the task is genuinely ambiguous, pick the one you can best justify and SAY WHICH " +
		"YOU CHOSE AND WHY in your summary — an unstated choice is the actual failure, because a reader " +
		"cannot tell a deliberate decision from an accident. When it is cheap and non-destructive to do " +
		"so, you may set both and say so."
	);
}

/**
 * Which appmap pair grounds this run. "" is the element-grounded default;
 * APPMAP_VARIANT=vision selects the `.vision.*` pair a vision-only explore pass wrote
 * (`explore --no-ax`) — a benchmark arm, so the run log's grounding meta must say which
 * variant was used. Read per call, not at import, so a test can flip it.
 */
export const appmapVariant = (): string => {
	const v = process.env.APPMAP_VARIANT;

	// `novision` selects the pair an element-only pass wrote (`explore --no-vision`). The same
	// argument as `vision`: a run that cannot see the screen cannot act on guidance phrased as
	// "the button in the top-right", so it should ground on a map written by a pass that could
	// not see the screen either. Without this the element-only map was written and read by
	// nothing — 30 minutes and $14 of pass producing an artifact with no consumer.
	//
	// Deliberately NOT auto-derived from the run's own perception: vision-only-grounded-axmap
	// is a vision-only run that must read the ELEMENT map on purpose, and inferring the tier
	// would silently break exactly that arm.
	return v === "vision" ? ".vision" : v === "novision" ? ".novision" : "";
};

/**
 * The sidecar half of the ax element channel, as a filename fragment.
 *
 * Separate from appmapVariant because it is a separate axis: a pass can be
 * screenshots-only OR element-only AND with or without DOM attributes, and all four
 * combinations write different maps. Read from the env the sidecar itself reads, so the
 * name can never disagree with what actually ran.
 */
export const appmapAxdom = (): string => (process.env.AXDOM === "0" ? ".noaxdom" : "");

/**
 * Takes the artifact SLUG, not an app name: a web target's slug is derived from its origin
 * rather than by folding whitespace, so `appSlug` is no longer the right thing to apply here
 * and applying it twice would mangle one. Callers own the slug (see `targetSlug`).
 *
 * Honours APPMAP_VARIANT the same way loadGrounding does — a run grounded on the vision prose
 * must also take the vision GRAPH, or its scope warnings would come from a map the model
 * never read. Deliberately NO fallback to the default pair when the variant's graph is
 * absent: that would leak the element-grounded map's knowledge into a vision-grounded arm.
 * A missing graph merely switches the graph features off, same as ever.
 */
export function loadAppMapGraph(slug: string, backend?: string, opts: { plainVariant?: boolean } = {}): AppMap | undefined {
	// Backend-specific first, plain second — the same order and the same reason as
	// loadGrounding: a map is not backend-portable (ax and cdp name the same surface `editor`
	// and `draft-editor`), while curated and pre-split maps live under the plain slug.
	//
	// The variant still has NO fallback: a vision-grounded run taking the element-grounded
	// graph would leak knowledge the model never read into its scope warnings.
	// `plainVariant` asks for the FULL-PERCEPTION map for this backend, ignoring the arm's own
	// variant. Exactly one caller wants that: start-state normalisation (run.ts homeGraph). Home
	// is a property of the app, and the reduced-perception passes declare none — so without this
	// the vision-only and no-vision arms silently skipped the reset that every arm they are
	// compared against performed. It must never be used to pick GROUNDING: that would hand a
	// vision-grounded run the element-grounded map's knowledge.
	const variant = opts.plainVariant ? appmapAxdom() : `${appmapAxdom()}${appmapVariant()}`;
	const path = [...(backend ? [`${appmapsDir()}/${slug}.${backend}${variant}.json`] : []), `${appmapsDir()}/${slug}${variant}.json`].find((c) => fs.existsSync(c));
	if (!path) return undefined;

	try {
		return JSON.parse(fs.readFileSync(path, "utf8")) as AppMap;
	} catch (err) {
		console.log(`WARNING: could not parse ${path}: ${err instanceof Error ? err.message : String(err)}`);

		return undefined;
	}
}
