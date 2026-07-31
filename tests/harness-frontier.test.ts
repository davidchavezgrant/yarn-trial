import assert from "node:assert/strict";
import { test } from "node:test";
import {
	frontierCredit,
	frontierDismiss,
	frontierIngest,
	frontierMatches,
	frontierRemaining,
	frontierSummary,
	isVagueSurface,
	mergeGraph,
	newFrontier,
	refSurfaces,
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

test("refSurfaces__NamesTheEnclosingLandmark__When__ControlSitsInside", () => {
	const m = refSurfaces([
		ref("p1:0", "navigation", "0,0,200,800", "Sidebar"),
		ref("p1:1", "button", "10,20,100,30", "Inbox"),
	]);
	assert.equal(m.get("p1:1"), "Sidebar");
});

test("refSurfaces__PicksTheInnermost__When__LandmarksNest", () => {
	const m = refSurfaces([
		ref("p1:0", "region", "0,0,1000,1000", "Page"),
		ref("p1:1", "dialog", "100,100,300,200", "Settings"),
		ref("p1:2", "button", "150,150,80,20", "Save"),
	]);
	assert.equal(m.get("p1:2"), "Settings");
});

test("refSurfaces__IgnoresMain__When__ItWouldSwallowTheWholePage", () => {
	// If `main` counted as a surface, isVagueSurface("main") would be false and ONE dismiss
	// naming it would retire the entire page — bypassing EXPLORE_DISMISS_CAP by another route.
	const m = refSurfaces([ref("p1:0", "main", "0,0,1000,1000", "Main"), ref("p1:1", "button", "10,10,50,20", "Go")]);
	assert.equal(m.get("p1:1"), undefined);
	assert.equal(isVagueSurface(m.get("p1:1")), true);
});

test("refSurfaces__FallsBackToTheRole__When__LandmarkHasNoName", () => {
	const m = refSurfaces([ref("p1:0", "toolbar", "0,0,500,50"), ref("p1:1", "button", "10,10,40,30", "Bold")]);
	assert.equal(m.get("p1:1"), "toolbar");
});

test("refSurfaces__ReturnsNothing__When__FramesAreUnreadable", () => {
	// The frame format is unverified against a live driver, so a wrong guess must make the
	// feature inert (today's behaviour: every surface "") rather than produce wrong groupings.
	const m = refSurfaces([ref("p1:0", "navigation", "who knows", "Side"), ref("p1:1", "button", "", "Inbox")]);
	assert.equal(m.size, 0);
});

test("refSurfaces__ToleratesOtherPunctuation__When__DriverFormatsFramesDifferently", () => {
	const m = refSurfaces([
		ref("p1:0", "navigation", "{x: 0, y: 0, w: 200, h: 800}", "Sidebar"),
		ref("p1:1", "button", "{x: 10, y: 20, w: 100, h: 30}", "Inbox"),
	]);
	assert.equal(m.get("p1:1"), "Sidebar");
});

test("refSurfaces__DoesNotMakeALandmarkItsOwnSurface__When__ItEnclosesItself", () => {
	const m = refSurfaces([ref("p1:0", "navigation", "0,0,200,800", "Sidebar")]);
	assert.equal(m.get("p1:0"), undefined);
});
