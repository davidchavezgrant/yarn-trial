import assert from "node:assert/strict";
import { test } from "node:test";
import { collapsedCohorts, frontierKey,
	frontierCredit,
	frontierDismiss,
	frontierIngest,
	frontierMatches,
	frontierRemaining,
	frontierSummary,
	isVagueSurface,
	mergeGraph,
	newFrontier,
} from "../src/core/harness.js";
import type { InteractiveElement, ObservationBundle } from "../src/core/harness.js";
import type { AppMapEdge, AppMapNode } from "../src/types.js";

const bundle: ObservationBundle = {
	elementsText: '[3] AXButton "Save" @(10,20 80x30)',
	frames: new Map([["Save", { x: 10, y: 20 }]]),
	haystack: "save",
	screenshotB64: "aGk=",
	title: "Settings",
	interactive: [{ handle: 3, role: "AXButton", name: "Save", surface: "", value: "", x: 10, y: 20, w: 80, h: 30 }],
	appContent: 1,
	domEnriched: 0,
};

// --- frontier ledger: the mechanical answer to "did the pass map the whole app?". Its
// predecessor was the model auditing its own coverage from a transcript that, by
// construction, contains only the surfaces it visited. These tests pin the two credit paths
// (handle and coordinate), the dismissal escape hatch, and the guards that stop one click
// from draining a panel it never touched.

const ie = (name: string, surface = "", box: Partial<InteractiveElement> = {}): InteractiveElement =>
	({ handle: 0, role: "AXButton", name, surface, value: "", x: 0, y: 0, w: 0, h: 0, ...box });

const obsWith = (interactive: InteractiveElement[]): ObservationBundle => ({ ...bundle, interactive });

test("frontier__ExcludesControl__When__ActionAddressesItsHandle", () => {
	const ledger = newFrontier();
	const obs = obsWith([ie("Save", "Toolbar", { handle: 3 }), ie("Cancel", "Toolbar", { handle: 4 })]);
	frontierIngest(ledger, obs);
	frontierCredit(ledger, { name: "click", element_index: 3 }, obs);
	assert.deepEqual(frontierRemaining(ledger).map((e) => e.name), ["Cancel"]);
});

test("frontier__CreditsOnlyTheHandle__When__ActionCarriesBothHandleAndCoordinates", () => {
	// toActionRequest drops x/y when a handle is present, so the driver clicks "Save" and never
	// the coordinate. Crediting the box under those unused coordinates too would retire "Delete"
	// — a control the run never operated — and overstate the coverage the stamp reports.
	const ledger = newFrontier();
	const obs = obsWith([
		ie("Save", "Toolbar", { handle: 3, x: 0, y: 0, w: 60, h: 20 }),
		ie("Delete", "Toolbar", { handle: 4, x: 100, y: 100, w: 60, h: 20 }),
	]);
	frontierIngest(ledger, obs);
	frontierCredit(ledger, { name: "click", element_index: 3, x: 120, y: 110 }, obs);
	assert.deepEqual(frontierRemaining(ledger).map((e) => e.name), ["Delete"]);
});

test("frontier__ExcludesControl__When__CoordinateClickLandsInItsFrame", () => {
	// The path that matters for apps whose rail only answers pixel clicks: there is no
	// handle in the action at all, so containment is the only way the ledger learns anything.
	const ledger = newFrontier();
	const obs = obsWith([ie("Library", "Rail", { x: 0, y: 0, w: 100, h: 40 }), ie("Drafts", "Rail", { x: 0, y: 40, w: 100, h: 40 })]);
	frontierIngest(ledger, obs);
	frontierCredit(ledger, { name: "click", x: 50, y: 60 }, obs);
	assert.deepEqual(frontierRemaining(ledger).map((e) => e.name), ["Library"]);
});

test("frontier__CreditsInnermostOnly__When__BoxesNest", () => {
	// Boxes nest, so a point inside a button is also inside its panel and the window. Crediting
	// every container would let one click drain a panel's worth of controls it never touched.
	const ledger = newFrontier();
	const obs = obsWith([
		ie("Panel", "", { x: 0, y: 0, w: 500, h: 500 }),
		ie("Save", "Panel", { x: 10, y: 10, w: 60, h: 20 }),
	]);
	frontierIngest(ledger, obs);
	frontierCredit(ledger, { name: "click", x: 20, y: 15 }, obs);
	assert.deepEqual(frontierRemaining(ledger).map((e) => e.name), ["Panel"]);
});

test("frontier__CreditsNothing__When__GeometryIsUnavailable", () => {
	// A backend that reports no boxes (DOM/CDP) must MISS rather than match wrongly — zero-size
	// entries would otherwise all contain the origin and be credited by any click at (0,0).
	const ledger = newFrontier();
	const obs = obsWith([ie("Save", "Toolbar"), ie("Cancel", "Toolbar")]);
	frontierIngest(ledger, obs);
	assert.deepEqual(frontierCredit(ledger, { name: "click", x: 0, y: 0 }, obs), []);
	assert.equal(frontierRemaining(ledger).length, 2);
});

test("frontier__ExcludesControl__When__DismissedBySurface", () => {
	// A panel of 80 repetitive rows must be clearable in one turn, or the frontier never
	// empties and every run burns the full time cap being nagged.
	const ledger = newFrontier();
	frontierIngest(ledger, obsWith([ie("Row 1", "Transcript"), ie("Row 2", "Transcript"), ie("Save", "Toolbar")]));
	const gone = frontierDismiss(ledger, { surface: "Transcript", reason: "transcript content, not navigation" });
	assert.equal(gone.length, 2);
	assert.deepEqual(frontierRemaining(ledger).map((e) => e.name), ["Save"]);
});

test("frontierMatches__LeavesTheFrontierIntact__When__SizingASweep", () => {
	// The cap has to know how wide a dismissal is BEFORE it happens, so sizing must not
	// itself dismiss anything — otherwise a refused sweep would still have cleared the list.
	const ledger = newFrontier();
	frontierIngest(ledger, obsWith([ie("Row 1", "Transcript"), ie("Row 2", "Transcript"), ie("Save", "Toolbar")]));
	const matches = frontierMatches(ledger, { surface: "Transcript" });
	assert.equal(matches.length, 2);
	assert.equal(frontierRemaining(ledger).length, 3);
});

test("frontierMatches__Throws__When__NeitherNamesNorSurfaceGiven", () => {
	assert.throws(() => frontierMatches(newFrontier(), {}), /needs names, a surface, or both/);
});

test("isVagueSurface__ReturnsTrue__When__SurfaceIsTheTopLevelPlaceholder", () => {
	// These are the strings the frontier listing prints for "no containing panel". A bulk
	// dismissal against them is a scatter, not a repetitive list.
	for (const s of [undefined, "<top level>", "&lt;top level&gt;", "  Top-Level  ", "none", "root", "unnamed"])
		assert.equal(isVagueSurface(s), true, `expected ${String(s)} to read as vague`);
});

test("isVagueSurface__StillReadsAsVague__When__TheBracketsArriveInAnotherEscaping", () => {
	// The named entities above are the forms we happened to observe; nothing guarantees they
	// are the only ones. Each spelling that slips through is a bulk dismissal that passes the
	// vagueness guard and sweeps unrelated controls — the exact failure EXPLORE_DISMISS_CAP
	// exists to stop (CLAUDE.md: 104 unrelated controls cleared in one call).
	for (const s of ["&#60;top level&#62;", "&#x3c;top level&#x3e;", "&amp;lt;top level&amp;gt;", "< top level >"])
		assert.equal(isVagueSurface(s), true, `expected ${s} to read as vague`);
});

test("isVagueSurface__ReturnsFalse__When__ARealPanelNameMerelyContainsAPlaceholderWord", () => {
	// The placeholder match is anchored, and must stay anchored: a panel genuinely called
	// "Root folder" is a specific surface, and reading it as the top-level scatter would let a
	// legitimate dismissal be refused — or a vague one be allowed.
	for (const s of ["Root folder", "Unnamed layers", "Top-Level Settings"]) assert.equal(isVagueSurface(s), false, s);
});

test("isVagueSurface__ReturnsFalse__When__SurfaceNamesARealPanel", () => {
	for (const s of ["Transcript", "Brand Kit", "Project actions"]) assert.equal(isVagueSurface(s), false, s);
});

test("frontierDismiss__ClearsTopLevel__When__SurfaceIsThePrintedPlaceholder", () => {
	// Top-level controls have surface "", which the listing must print as something. Observed
	// on a live run: four consecutive dismisses for "<top level>", "top level" and the
	// HTML-escaped form, each matching nothing and each costing a turn.
	for (const spelling of ["<top level>", "top level", "&lt;top level&gt;", "Top-Level", ""]) {
		const ledger = newFrontier();
		frontierIngest(ledger, obsWith([ie("Search", ""), ie("Save", "Toolbar")]));
		assert.equal(frontierDismiss(ledger, { surface: spelling, reason: "r" }).length, 1, spelling);
	}
});

test("frontierDismiss__Throws__When__NeitherNamesNorSurfaceGiven", () => {
	// An argument-less dismiss would silently clear the entire frontier and end the run.
	assert.throws(() => frontierDismiss(newFrontier(), { reason: "everything" }), /needs names/);
});

test("frontier__ReAddsControl__When__SeenAgainAfterDismissal", () => {
	// Re-observing must not resurrect a dismissal, or a control in a panel visited twice
	// can never be got rid of.
	const ledger = newFrontier();
	const obs = obsWith([ie("Row 1", "Transcript")]);
	frontierIngest(ledger, obs);
	frontierDismiss(ledger, { names: ["Row 1"], reason: "content" });
	frontierIngest(ledger, obs);
	assert.equal(frontierRemaining(ledger).length, 0);
});

test("frontierSummary__CountsAnonymousEntries__When__ControlsHaveNoLabel", () => {
	// Unnamed controls are the bulk on icon-heavy apps; listing them by empty string is noise,
	// but hiding them entirely would make the count unreconcilable with the listing.
	const ledger = newFrontier();
	frontierIngest(ledger, obsWith([ie("", "Rail", { role: "AXButton" }), ie("", "Rail", { role: "AXLink" }), ie("Save", "Rail")]));
	const s = frontierSummary(ledger);
	assert.match(s, /"Save"/);
	assert.match(s, /2 unnamed/);
});

test("frontier__CollapsesEntries__When__RoleNameAndSurfaceAllMatch", () => {
	// Deliberate under-count. Handles renumber on every redraw, so keying on them would make
	// the frontier regrow forever and the run never converge; identical role+name+surface
	// controls therefore share one entry, and operating either clears both.
	const ledger = newFrontier();
	frontierIngest(ledger, obsWith([ie("", "Rail", { handle: 1 }), ie("", "Rail", { handle: 2 })]));
	assert.equal(frontierRemaining(ledger).length, 1);
});

test("mergeGraph__OverwritesNode__When__SameIdRecordedTwice", () => {
	// The pass records a surface when it first sees the link to it and again with real detail
	// once inside; the later sighting is the better one.
	const nodes = new Map<string, AppMapNode>();
	const edges = new Map<string, AppMapEdge>();
	mergeGraph(nodes, edges, { nodes: [{ id: "brand-kit", title: "Brand Kit", kind: "surface", scope: "brand" }] });
	mergeGraph(nodes, edges, { nodes: [{ id: "brand-kit", title: "Brand Kit", kind: "surface", scope: "brand", notes: "nine tabs" }] });
	assert.equal(nodes.size, 1);
	assert.equal(nodes.get("brand-kit")?.notes, "nine tabs");
});

test("mergeGraph__DeduplicatesEdge__When__SameTraversalRecordedTwice", () => {
	const nodes = new Map<string, AppMapNode>();
	const edges = new Map<string, AppMapEdge>();
	const e = { from: "root", to: "brand-kit", action: 'click "Brand Kit"' };
	mergeGraph(nodes, edges, { edges: [e] });
	mergeGraph(nodes, edges, { edges: [e, { ...e, action: "cmd+2" }] });
	assert.equal(edges.size, 2);
});

const ref = (r: string, role: string, frame: string, name?: string) => ({ ref: r, role, name, frame });


test("frontierRemaining__RetiresAValueListAsAUnit__When__OneMemberIsOperated", () => {
	// Yarn's font picker put ~1,500 entries on the frontier. DISMISS_CAP forced them to be
	// retired 20 at a time, and the pass spent 13 of its 118 actions (11%) refreshing,
	// re-navigating and reopening the picker purely to dismiss its contents under a named
	// surface — learning nothing in any of them.
	const led = newFrontier();
	const fonts = Array.from({ length: 60 }, (_, i) => ({ role: "AXStaticText", name: `Font ${i}`, surface: "Font picker", handle: i, x: 0, y: i, w: 10, h: 10 }) as any);
	frontierIngest(led, { interactive: fonts } as any);
	assert.equal(frontierRemaining(led).length, 60);

	// Operating ONE teaches the interaction for all of them.
	led.actuated.add(frontierKey(fonts[0]));
	assert.equal(frontierRemaining(led).length, 0, "the cohort retires together");
	// And the collapse is reported rather than silent — a frontier that empties inexplicably
	// looks like it is lying.
	assert.deepEqual(collapsedCohorts(led), [{ role: "AXStaticText", surface: "Font picker", size: 60 }]);
	assert.match(frontierSummary(led), /retired as a group because you operated one/);
});

test("frontierRemaining__LeavesSmallGroupsAlone__When__TheyAreDistinctControls", () => {
	// The trade is explicit and bounded: a real settings panel rarely fields 25 identical-role
	// controls, so below the threshold every control is still owed its own action.
	const led = newFrontier();
	const toggles = Array.from({ length: 6 }, (_, i) => ({ role: "AXCheckBox", name: `Setting ${i}`, surface: "Screen Clips", handle: i, x: 0, y: i, w: 10, h: 10 }) as any);
	frontierIngest(led, { interactive: toggles } as any);
	led.actuated.add(frontierKey(toggles[0]));
	assert.equal(frontierRemaining(led).length, 5, "small cohorts are not collapsed");
	assert.deepEqual(collapsedCohorts(led), []);
});

test("frontierRemaining__KeepsCohortsSeparate__When__TheyShareARoleOnDifferentSurfaces", () => {
	// Surface is half the cohort identity: a font list in Brand Kit and one in the editor are
	// different lists, and operating in one says nothing about the other.
	const led = newFrontier();
	const mk = (surface: string) => Array.from({ length: 40 }, (_, i) => ({ role: "AXStaticText", name: `Font ${i}`, surface, handle: i, x: 0, y: i, w: 10, h: 10 }) as any);
	const brand = mk("Brand Kit font picker");
	frontierIngest(led, { interactive: [...brand, ...mk("Editor font picker")] } as any);
	led.actuated.add(frontierKey(brand[0]));
	assert.equal(frontierRemaining(led).length, 40, "only the operated surface's cohort retires");
});
