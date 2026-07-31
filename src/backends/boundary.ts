import type { InteractiveElement, ObservationBundle } from "../core/harness.js";

/**
 * Classify what a destructive-labelled press revealed, BEFORE anything else is decided.
 *
 * A well-formed destructive action is two-phase: the opening press surfaces a confirmation
 * dialog and commits nothing. Under guarded descent the exploration pass needs to know which
 * world it is in — "a modal appeared" (safe: read it and Escape) versus "no modal appeared"
 * (the press may have committed — flag for cleanup) — and to name the boundary kind so the
 * appmap can record what lives behind the gate without ever crossing it.
 *
 * HONESTY: this is a heuristic over an AX tree that routinely lacks dialog roles on Electron
 * (modals arrive as plain AXGroups), so it must never be treated as authoritative for SAFETY
 * decisions. Safety comes from the caller's invariant — inside a descent frame the harness
 * presses nothing and sends Escape itself; the classifier only decides what gets RECORDED and
 * whether to flag a possible commit. And `no-modal` does NOT mean "nothing happened": a
 * mutation may have committed silently, so the caller pairs that verdict with detectMutation.
 */

/** External auth/consent hosts. A press that opened one of these is an OAuth hand-off, not a dialog. */
const AUTH_HOST = /accounts\.google\.com|oauth|auth0|okta|login\.microsoftonline/i;

/** Vocabulary of the native save/open sheet — labels no confirmation dialog uses. */
const FILE_VOCAB = /\b(save as|where|file format|desktop|documents|downloads)\b/i;

/** The warning sentences confirmation dialogs are made of. `irreversibl` catches -e and -y. */
const DANGER_COPY = /\b(cannot be undone|can't be undone|are you sure|permanently|this will delete|will be removed|no longer|irreversibl)/i;

const CANCELISH = /\b(cancel|keep|go back|not now)\b/i;
const COMMITISH = /\b(delete|remove|confirm|archive|reset|discard|clear|erase)\b/i;

/**
 * The pair heuristic reads BUTTONS only. Menu items named "Delete" appear fresh whenever a
 * context menu opens, and a menu is not a confirmation — recording every menu as a confirm
 * dialog would flood the appmap with gates that do not exist. "button" is the DOM backend's
 * spelling of the same role.
 */
const isButton = (e: InteractiveElement): boolean => e.role === "AXButton" || e.role === "button";

/**
 * Identity across observations is `(name, surface)`, never the handle — element indices are
 * a walk order that renumbers whenever the tree changes shape, which is precisely what the
 * press causes. Same convention as detectMutation in src/core/journal.ts; same `|` separator as
 * frontierKey in src/core/harness.ts.
 */
const identityKey = (e: { name: string; surface: string }): string => `${e.name}|${e.surface}`;

/**
 * Elements present in `next` whose `(name, surface)` identity is absent from `prev`.
 *
 * Fully-anonymous elements (no name AND no surface) are skipped: they cannot be matched
 * across observations, so every redraw would report them as "new" — noise, not signal.
 */
export function newElements(prev: ObservationBundle, next: ObservationBundle): InteractiveElement[] {
	const before = new Set(prev.interactive.map(identityKey));

	return next.interactive.filter((e) => (e.name !== "" || e.surface !== "") && !before.has(identityKey(e)));
}

export type BoundaryKind = "confirm-dialog" | "file-sheet" | "oauth-window" | "no-modal";

export interface Boundary {
	kind: BoundaryKind;
	/** What the boundary surface says — the danger copy, option labels, external host. Human-readable, lands in the appmap. */
	detail: string;
	/** The new controls the boundary exposed, for recording. */
	controls: InteractiveElement[];
}

/** Deduped non-empty names, for details and descriptions. */
const controlNames = (els: InteractiveElement[]): string[] => [...new Set(els.map((e) => e.name).filter((n) => n !== ""))];

/**
 * Find an auth host in a piece of text. Prefers extracting a full URL so the appmap records
 * where the window points; the bare-host fallback exists because title bars ("Sign in —
 * accounts.google.com") and the AXURL values the axdom sidecar surfaces on Electron can
 * carry a host with no scheme.
 */
function authMatch(text: string): string | undefined {
	for (const u of text.match(/https?:\/\/[^\s"')]+/gi) ?? []) if (AUTH_HOST.test(u)) return u;
	const m = text.match(AUTH_HOST);

	return m ? m[0] : undefined;
}

/**
 * Haystack lines present in `next` and absent from `prev`. observe() builds the haystack as
 * the title plus every element label and value, one per line, lowercased — so a line-level
 * set difference is the textual analogue of newElements. It matters because dialog body copy
 * lives in AXStaticText, which never reaches `interactive`: the warning sentence is often
 * visible ONLY here.
 */
function haystackDelta(prev: ObservationBundle, next: ObservationBundle): string[] {
	const before = new Set(prev.haystack.split("\n"));

	return next.haystack.split("\n").filter((l) => l.trim() !== "" && !before.has(l));
}

/**
 * What did the press reveal? First match wins, computed over the fresh elements.
 *
 * Order is deliberate. An OAuth window is full of Cancel/Continue buttons and would satisfy
 * the confirm-dialog pair heuristic; a file sheet's Cancel/Save pair likewise. So the more
 * specific signatures are tested first and the generic dialog shape last. One narrowing of
 * the naive reading: an AXSheet alone is NOT a file sheet — on macOS the confirmation form
 * of a destructive action is itself often a sheet, so the role only reads as a file sheet
 * when file vocabulary accompanies it, and otherwise falls through to confirm-dialog.
 *
 * Electron modals are often plain AXGroups with no dialog role — the danger-copy and
 * button-pair heuristics are the load-bearing ones; roles are a bonus.
 */
export function classifyBoundary(prev: ObservationBundle, next: ObservationBundle): Boundary {
	const fresh = newElements(prev, next);
	const freshText = fresh.flatMap((e) => [e.name, e.value]).filter((t) => t !== "");

	// a. oauth-window. URL and title are checked before element text so the detail carries
	// the most precise thing available.
	for (const source of [next.url ?? "", next.title, ...freshText]) {
		if (!source) continue;
		const hit = authMatch(source);
		if (hit) return { kind: "oauth-window", detail: hit, controls: fresh };
	}

	const namesBlob = freshText.join("\n");

	// b. file-sheet: file vocabulary plus either the sheet role or the Save/Cancel pair.
	const fileVocab = FILE_VOCAB.test(namesBlob);
	const savePair =
		fresh.some((e) => isButton(e) && /\bsave\b/i.test(e.name))
		&& fresh.some((e) => isButton(e) && /\bcancel\b/i.test(e.name));
	if (fileVocab && (fresh.some((e) => e.role === "AXSheet") || savePair))
		return { kind: "file-sheet", detail: `native file sheet: ${controlNames(fresh).join(", ")}`, controls: fresh };

	// c. confirm-dialog: danger copy anywhere fresh, a cancel-ish/commit-ish button pair, or
	// a dialog-ish role. The detail prefers the copy — it is what the appmap reader wants.
	const dangerLine =
		freshText.find((t) => DANGER_COPY.test(t))
		?? haystackDelta(prev, next).find((l) => DANGER_COPY.test(l));
	const cancelBtn = fresh.find((e) => isButton(e) && CANCELISH.test(e.name));
	const commitBtn = fresh.find((e) => isButton(e) && COMMITISH.test(e.name));
	const dialogRole = fresh.find((e) => e.role === "AXSheet" || e.role === "AXDialog" || (e.role === "AXGroup" && DANGER_COPY.test(e.name)));
	if (dangerLine || (cancelBtn && commitBtn) || dialogRole) {
		const what = dangerLine
			? `"${dangerLine.trim().slice(0, 160)}"`
			: cancelBtn && commitBtn
				? `${cancelBtn.name} / ${commitBtn.name} button pair`
				: `${dialogRole?.role ?? "dialog"} appeared`;
		const names = controlNames(fresh);

		return { kind: "confirm-dialog", detail: names.length ? `${what}; controls: ${names.join(", ")}` : what, controls: fresh };
	}

	// d. no-modal. Say what WAS observed: "nothing matched" and "nothing appeared" are
	// different facts, and the caller flags the first for a possible silent commit.
	return {
		kind: "no-modal",
		detail:
			fresh.length === 0
				? "no new elements appeared"
				: `${fresh.length} fresh element(s) (${controlNames(fresh).slice(0, 5).join(", ") || "unnamed"}), no dialog signature`,
		controls: fresh,
	};
}

/**
 * One line for the appmap/frontier record: what kind of boundary, what it says, what it
 * offers. Capped because an OAuth consent page exposes dozens of links and the record is
 * read by a human deciding whether the gate is worth revisiting.
 */
export function boundaryDescription(b: Boundary): string {
	const names = controlNames(b.controls);
	const shown = names.slice(0, 12);
	const more = names.length > shown.length ? ` +${names.length - shown.length} more` : "";
	const options = names.length ? ` — options: ${shown.join(", ")}${more}` : "";

	return `${b.kind}: ${b.detail}${options}`;
}
