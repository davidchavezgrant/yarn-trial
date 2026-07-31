import type { AppMapEdge, AppMapNode } from "../../types.js";
import type { InteractiveElement, ObservationBundle } from "./observation.js";

/**
 * The frontier ledger: which controls a pass has SEEN versus which it has OPERATED.
 *
 * Coverage used to be the model's own answer to "did you cover the app?", reached from
 * inside a transcript that by construction contains only the surfaces it visited. This is
 * the mechanical replacement — every observation already lists the app's interactive
 * elements, so the difference between the two sets is computable and needs no self-report.
 *
 * Frontier = seen − actuated − dismissed. It is a moving target rather than a fixed
 * denominator: a closed popover contributes zero elements, so opening one surface can add
 * twenty entries. That is the point. The pass ends when nothing is left, not when a step
 * budget runs out.
 *
 * Nothing here knows anything about any particular app.
 */
export interface FrontierLedger {
	seen: Map<string, InteractiveElement>;
	actuated: Set<string>;
	/** key -> the reason given for skipping it. */
	dismissed: Map<string, string>;
}

export const newFrontier = (): FrontierLedger => ({ seen: new Map(), actuated: new Set(), dismissed: new Map() });

/**
 * Identity of a control across observations. Deliberately NOT the addressing handle, which
 * is a walk order that renumbers on every redraw. Controls sharing a role, label and
 * containing surface collapse into one entry — an under-count of distinct controls, taken
 * on purpose so the frontier converges instead of regrowing whenever the tree reshuffles.
 */
export const frontierKey = (e: { role: string; name: string; surface: string }): string => `${e.role}|${e.name}|${e.surface}`;

export function frontierIngest(ledger: FrontierLedger, obs: ObservationBundle): void {
	// Overwrite rather than skip: geometry and handle must track the LATEST observation,
	// since that is the one any credit will be resolved against.
	for (const e of obs.interactive) ledger.seen.set(frontierKey(e), e);
}

/**
 * Mark whatever an action operated as actuated, resolved against the observation the model
 * was looking at when it chose the action. Returns the keys credited.
 */
export function frontierCredit(ledger: FrontierLedger, action: any, before: ObservationBundle): string[] {
	const hits = new Set<string>();
	const handle = action?.element_index ?? action?.ref;
	if (handle !== undefined && handle !== null) {
		for (const e of before.interactive) if (e.handle === handle) hits.add(frontierKey(e));
		// A resolved handle is the whole action: toActionRequest DROPS x/y when a handle is
		// present, so the driver never clicks the coordinate. Crediting the box under those
		// unused coordinates too would retire a second control the run never operated, and
		// `controls: N actuated` — the breadth number the stamp reports — would overstate
		// coverage. Mirror actionTarget's precedence and stop here.
		if (hits.size > 0) {
			for (const k of hits) ledger.actuated.add(k);

			return [...hits];
		}
	}

	// Coordinate actions name no element, so credit whatever box the point lands in — needed
	// because some controls only respond to pixel clicks, and painted surfaces have no
	// element at all. Smallest containing box only: boxes nest, and crediting every
	// container under the point would let one click drain a panel's worth of entries it
	// never touched.
	for (const [x, y] of [
		[action?.x, action?.y],
		[action?.from_x, action?.from_y],
	]) {
		if (typeof x !== "number" || typeof y !== "number") continue;
		let best: InteractiveElement | undefined;
		for (const e of before.interactive) {
			if (e.w <= 0 || e.h <= 0) continue; // no geometry -> never matches, never wrongly credits
			if (x < e.x || x >= e.x + e.w || y < e.y || y >= e.y + e.h) continue;
			if (!best || e.w * e.h < best.w * best.h) best = e;
		}
		if (best) hits.add(frontierKey(best));
	}
	for (const k of hits) ledger.actuated.add(k);

	return [...hits];
}

export function frontierRemaining(ledger: FrontierLedger): InteractiveElement[] {
	return [...ledger.seen]
		.filter(([k]) => !ledger.actuated.has(k) && !ledger.dismissed.has(k))
		.map(([, e]) => e)
		.sort((a, b) => a.surface.localeCompare(b.surface) || a.name.localeCompare(b.name));
}

/**
 * Deliberately skip frontier entries, by name and/or by whole surface.
 *
 * Without this the frontier can never empty and every run burns its full wall-clock cap:
 * most unactuated controls are content, not navigation — transcript chunks, list rows, the
 * eight hundredth item in a library. The escape has to exist, but it is recorded and
 * reported rather than silent, so "we skipped 240 controls, here is why" survives into the
 * artifact instead of looking like coverage.
 */
/**
 * Round-trip the summary's name for the unnamed surface.
 *
 * Top-level controls have `surface: ""`, which the listing has to render as something
 * printable — and the model then quotes that placeholder straight back. Observed: four
 * consecutive dismiss calls for "<top level>", "top level" and the HTML-escaped
 * "&lt;top level&gt;", each matching nothing and each costing a turn, while the frontier
 * sat unchanged. Whatever the listing prints must resolve back to the empty surface.
 */
const normSurface = (s: string): string =>
	s
		.trim()
		.toLowerCase()
		// Every spelling of a bracket that can reach here, not just the two that were observed.
		// The listing prints `<top level>`; whatever escapes it on the way through the model's
		// context decides the form it comes back in, and named entities are only the first one
		// we happened to see. Decimal (`&#60;`), hex (`&#x3c;`) and the doubly-escaped
		// `&amp;lt;` an escaper applied twice produces are the same string to a reader and were
		// four different non-matches to this function.
		.replace(/&(?:amp;)*(?:lt|gt|#0*6[02]|#x0*3[ce]);|[<>]/g, "")
		// After the brackets go, not before: `< top level >` leaves inner padding that would
		// otherwise stop the placeholder below from anchoring.
		.trim()
		.replace(/^(top[- ]?level|none|root|unnamed)$/, "");

/**
 * What a dismiss WOULD clear, without clearing it. Separate from frontierDismiss so the
 * caller can size a sweep before committing to it: one call that retires a hundred
 * heterogeneous controls under a single sentence is how a pass reaches "frontier-empty"
 * without having looked at much, and the count is the only signal available beforehand.
 */
export function frontierMatches(
	ledger: FrontierLedger,
	opts: { names?: string[]; surface?: string },
): InteractiveElement[] {
	if (!opts.names?.length && opts.surface === undefined) throw new Error("dismiss needs names, a surface, or both");
	const norm = (s: string) => s.trim().toLowerCase();
	const wanted = opts.names?.map(norm);

	return frontierRemaining(ledger).filter(
		(e) =>
			(opts.surface === undefined || normSurface(e.surface) === normSurface(opts.surface)) &&
			(!wanted || wanted.includes(norm(e.name))),
	);
}

/**
 * True when a surface name does not identify a real panel — the top-level scatter, where a
 * bulk dismissal is a sweep across unrelated controls rather than "this list is repetitive".
 */
export const isVagueSurface = (surface?: string): boolean => surface === undefined || normSurface(surface) === "";

export function frontierDismiss(
	ledger: FrontierLedger,
	opts: { names?: string[]; surface?: string; reason: string },
): InteractiveElement[] {
	const gone = frontierMatches(ledger, opts);
	for (const e of gone) ledger.dismissed.set(frontierKey(e), opts.reason);

	return gone;
}

/** The frontier as the model sees it: grouped by surface, capped, unnamed entries counted. */
export function frontierSummary(ledger: FrontierLedger, maxSurfaces = 12, maxPerSurface = 14): string {
	const rest = frontierRemaining(ledger);
	if (rest.length === 0) return "The frontier is empty: every interactive control seen so far has been operated or dismissed.";

	const bySurface = new Map<string, InteractiveElement[]>();
	for (const e of rest) bySurface.set(e.surface, [...(bySurface.get(e.surface) ?? []), e]);
	// Biggest groups first: they are where the unexplored bulk is.
	const groups = [...bySurface].sort((a, b) => b[1].length - a[1].length);
	const lines = groups.slice(0, maxSurfaces).map(([surface, items]) => {
		const named = items.filter((e) => e.name);
		const anon = items.length - named.length;
		const shown = named.slice(0, maxPerSurface).map((e) => `"${e.name}"`).join(", ");
		const more = named.length > maxPerSurface ? `, +${named.length - maxPerSurface} more` : "";
		const unnamed = anon ? `${named.length ? "; " : ""}${anon} unnamed (dismiss by surface, or click them to find out)` : "";

		return `  in ${surface ? `"${surface}"` : "<top level>"} (${items.length}): ${shown}${more}${unnamed}`;
	});
	const hidden = groups.length > maxSurfaces ? `\n  ...and ${groups.length - maxSurfaces} more surface(s).` : "";

	return `${rest.length} control(s) seen but never operated, across ${groups.length} surface(s):\n${lines.join("\n")}${hidden}`;
}

/**
 * Fold a batch of nodes/edges into the accumulating graph, last write winning.
 *
 * Overwrite rather than merge-fields because a later sighting is a better one: the pass
 * records a surface when it first sees the link to it, then again with real detail once
 * inside. Nodes key on `id` and edges on the whole triple, so re-recording is idempotent
 * and the model can re-emit freely rather than having to remember what it already sent.
 * Returns how many entries were written, for the tool_result.
 */
export function mergeGraph(
	nodes: Map<string, AppMapNode>,
	edges: Map<string, AppMapEdge>,
	g: { nodes?: AppMapNode[]; edges?: AppMapEdge[] },
): number {
	let n = 0;
	for (const node of g.nodes ?? []) if (node?.id) (nodes.set(node.id, node), n++);
	for (const e of g.edges ?? []) if (e?.from && e?.to) (edges.set(`${e.from}|${e.to}|${e.action}`, e), n++);

	return n;
}
