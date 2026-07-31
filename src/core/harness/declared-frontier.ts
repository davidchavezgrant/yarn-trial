import { normSurface } from "./frontier.js";

/**
 * The DECLARED frontier: the vision-only exploration pass's stand-in for the frontier
 * ledger in frontier.ts.
 *
 * The mechanical ledger is founded on element identity — every observation lists the app's
 * interactive controls, so seen − actuated − dismissed needs no self-report. A vision-only
 * pass cannot use it and stay honest: the frontier summary injected into the model's context
 * lists element names straight off the AX tree, which would hand the whole element list to a
 * model that is supposed to see only pixels. So here the MODEL declares what it can see (the
 * `survey` tool), names the control each action operates (`target` on act), and this ledger
 * does the same bookkeeping over those declarations.
 *
 * The inversion is the point AND the known weakness, and the artifact stamp says so: these
 * tallies are SELF-REPORTED coverage. A screen the model never surveyed is invisible to the
 * frontier and reads exactly like a screen that does not exist — the mechanical ledger cannot
 * be fooled that way; this one can. Nothing here reads an observation, on purpose: the moment
 * it did, it would stop being the declared frontier and start leaking perception.
 */
export interface DeclaredControl {
	name: string;
	surface: string;
	note?: string;
}

export interface DeclaredLedger {
	seen: Map<string, DeclaredControl>;
	operated: Set<string>;
	/** key -> the reason given for skipping it. */
	dismissed: Map<string, string>;
}

export const newDeclaredLedger = (): DeclaredLedger => ({ seen: new Map(), operated: new Set(), dismissed: new Map() });

/**
 * Identity of a declared control. No role — the model has no AX tree to read one from — so
 * name + surface is the whole identity. Normalised with the same surface rules dismissal
 * matching already uses (see normSurface's escaping lessons: `<top level>` comes back in at
 * least four spellings), because these strings round-trip through the model's context twice:
 * once when surveyed and again when an act names its target.
 */
export const declaredKey = (name: string, surface: string): string => `${name.trim().toLowerCase()}|${normSurface(surface)}`;

/**
 * The surface as stored and displayed. Placeholder spellings of "no containing panel"
 * collapse to "", so summaries group them under one printed `<top level>` the way the
 * mechanical frontier does, instead of one group per spelling the model happened to use.
 */
const storedSurface = (surface: string): string => (normSurface(surface) === "" ? "" : surface.trim());

/**
 * Ingest one survey: the controls the model declares it can SEE on a surface. Overwrite
 * rather than skip, so re-surveying a screen refreshes notes and stays idempotent — the model
 * can re-declare freely rather than having to remember what it already sent. Entries with no
 * name are dropped: an unnamed declaration can never be credited or dismissed, so it would be
 * a frontier entry nothing can clear. Returns how many entries were new.
 */
export function declaredIngest(ledger: DeclaredLedger, surface: string, controls: Array<{ name?: unknown; note?: unknown }>): number {
	let added = 0;
	for (const c of controls) {
		if (typeof c?.name !== "string" || !c.name.trim()) continue;
		const key = declaredKey(c.name, surface);
		if (!ledger.seen.has(key)) added++;
		ledger.seen.set(key, {
			name: c.name.trim(),
			surface: storedSurface(surface),
			...(typeof c.note === "string" && c.note ? { note: c.note } : {}),
		});
	}

	return added;
}

/**
 * Credit the control an action DECLARED it operated. Acting on a control is also seeing it,
 * so a target never surveyed is ingested at the same moment — under-declaring cannot hide an
 * OPERATED control from the map, only an unoperated one. Returns the key and whether the
 * entry had been surveyed before, so the caller can log the discrepancy.
 */
export function declaredCredit(ledger: DeclaredLedger, target: { name: string; surface: string }): { key: string; surveyed: boolean } {
	const key = declaredKey(target.name, target.surface);
	const surveyed = ledger.seen.has(key);
	if (!surveyed) ledger.seen.set(key, { name: target.name.trim(), surface: storedSurface(target.surface) });
	ledger.operated.add(key);

	return { key, surveyed };
}

export function declaredRemaining(ledger: DeclaredLedger): DeclaredControl[] {
	return [...ledger.seen]
		.filter(([k]) => !ledger.operated.has(k) && !ledger.dismissed.has(k))
		.map(([, e]) => e)
		.sort((a, b) => a.surface.localeCompare(b.surface) || a.name.localeCompare(b.name));
}

/**
 * What a dismiss WOULD clear, without clearing it — same contract as frontierMatches, so the
 * loop's dismissal cap (size the sweep BEFORE committing to it) works unchanged on declared
 * entries.
 */
export function declaredMatches(ledger: DeclaredLedger, opts: { names?: string[]; surface?: string }): DeclaredControl[] {
	if (!opts.names?.length && opts.surface === undefined) throw new Error("dismiss needs names, a surface, or both");
	const norm = (s: string) => s.trim().toLowerCase();
	const wanted = opts.names?.map(norm);

	return declaredRemaining(ledger).filter(
		(e) =>
			(opts.surface === undefined || normSurface(e.surface) === normSurface(opts.surface)) &&
			(!wanted || wanted.includes(norm(e.name))),
	);
}

export function declaredDismiss(ledger: DeclaredLedger, opts: { names?: string[]; surface?: string; reason: string }): DeclaredControl[] {
	const gone = declaredMatches(ledger, opts);
	for (const e of gone) ledger.dismissed.set(declaredKey(e.name, e.surface), opts.reason);

	return gone;
}

/**
 * The declared frontier as the model sees it — same grouping and caps as frontierSummary,
 * minus roles and anonymous counts (an unnamed declaration is refused at ingest). Not shared
 * with frontierSummary in code: that function reads InteractiveElements off a FrontierLedger,
 * and threading a second element shape through it would couple the perception-blind ledger to
 * the observation types this module exists to stay away from.
 */
export function declaredSummary(ledger: DeclaredLedger, maxSurfaces = 12, maxPerSurface = 14): string {
	if (ledger.seen.size === 0)
		return "Nothing has been surveyed yet: the declared frontier is built ONLY from your surveys, so call survey for the current screen before operating anything.";
	const rest = declaredRemaining(ledger);
	if (rest.length === 0) return "The declared frontier is empty: every control you surveyed has been operated or dismissed.";

	const bySurface = new Map<string, DeclaredControl[]>();
	for (const e of rest) bySurface.set(e.surface, [...(bySurface.get(e.surface) ?? []), e]);
	// Biggest groups first: they are where the undeclared bulk is.
	const groups = [...bySurface].sort((a, b) => b[1].length - a[1].length);
	const lines = groups.slice(0, maxSurfaces).map(([surface, items]) => {
		const shown = items.slice(0, maxPerSurface).map((e) => `"${e.name}"`).join(", ");
		const more = items.length > maxPerSurface ? `, +${items.length - maxPerSurface} more` : "";

		return `  in ${surface ? `"${surface}"` : "<top level>"} (${items.length}): ${shown}${more}`;
	});
	const hidden = groups.length > maxSurfaces ? `\n  ...and ${groups.length - maxSurfaces} more surface(s).` : "";

	return `${rest.length} declared control(s) never operated, across ${groups.length} surface(s):\n${lines.join("\n")}${hidden}`;
}
