import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { InteractiveElement, ObservationBundle } from "./harness.js";
import { appendMutation, detectMutation, type Mutation, readJournal, restoreRoute } from "./journal.js";
import type { AppMap } from "./types.js";

/**
 * The journal is what makes a run reversible, and both ways it can be wrong are silent. A
 * missed mutation leaves the workspace altered for every later measurement; a fabricated one
 * sends teardown to "restore" a value nothing changed, which fights the app.
 */

const ie = (name: string, surface = "", box: Partial<InteractiveElement> = {}): InteractiveElement =>
	({ handle: 0, role: "AXPopUpButton", name, surface, value: "", x: 0, y: 0, w: 0, h: 0, ...box });

const obsWith = (interactive: InteractiveElement[]): ObservationBundle => ({
	elementsText: "",
	haystack: "",
	screenshotB64: "",
	title: "Yarn",
	interactive,
	appContent: interactive.length,
	domEnriched: 0,
	frames: new Map(),
});

/**
 * Mirrors the `yarnish` fixture in harness.test.ts: BOTH cursor-style controls carry the title
 * "Cursor Style", which is the ambiguity the surface disambiguation has to resolve.
 *
 * Only the brand parent exists as a node — `editor/screen-clip-settings` deliberately does not.
 * That exercises both halves of the parent-surface derivation in one fixture: title lookup for
 * the brand side, raw-id-segment fallback for the document side. A real explore pass does emit
 * control nodes whose parent surface it never recorded, so this is the shape, not a gap.
 */
const yarnish: AppMap = {
	app: "Yarn",
	capturedAt: "2026-07-29T00:00:00.000Z",
	provenance: "explore",
	nodes: [
		{ id: "brand-kit/screen-clips", title: "Screen Clip Settings", kind: "surface", scope: "brand" },
		{ id: "brand-kit/screen-clips/cursor-style", title: "Cursor Style", kind: "control", scope: "brand", settingKey: "cursor-style" },
		{ id: "editor/screen-clip-settings/cursor-style", title: "Cursor Style", kind: "control", scope: "document", settingKey: "cursor-style" },
		{ id: "settings/theme", title: "Theme", kind: "control", scope: "app", settingKey: "theme" },
	],
	edges: [{ from: "root", to: "brand-kit/screen-clips", action: 'click "Brand Kit"' }],
};

test("detectMutation__RecordsChange__When__ComboboxValueDiffers", () => {
	const prev = obsWith([ie("Cursor Style", "Screen Clip Settings", { handle: 100, value: "Arrow-first" })]);
	const next = obsWith([ie("Cursor Style", "Screen Clip Settings", { handle: 118, value: "Pointer-first" })]);
	const m = detectMutation({ name: "click", element_index: 100 }, prev, next, undefined, 3);
	assert.equal(m?.kind, "setting");
	assert.equal(m?.control, "Cursor Style");
	assert.equal(m?.surface, "Screen Clip Settings");
	assert.equal(m?.before, "Arrow-first");
	assert.equal(m?.after, "Pointer-first");
	assert.equal(m?.step, 3);
});

test("detectMutation__ReturnsUndefined__When__TargetHasNoName", () => {
	// A coordinate click resolves to the smallest box under the point, which can be an
	// unlabeled control. Matching it across observations by name "" would pair it with the first
	// anonymous element on the surface — routinely a different control — fabricating a mutation.
	const prev = obsWith([ie("", "Canvas", { handle: 0, value: "0:00", x: 100, y: 100, w: 50, h: 20 })]);
	const next = obsWith([ie("", "Canvas", { handle: 0, value: "0:05", x: 100, y: 100, w: 50, h: 20 })]);
	assert.equal(detectMutation({ name: "click", x: 120, y: 110 }, prev, next, undefined, 1), undefined);
});

test("detectMutation__ReturnsUndefined__When__ClickOnlyNavigates", () => {
	// The false positive that matters: most clicks in a run open a panel and change nothing,
	// and a teardown trying to "restore" one would fight the app.
	const prev = obsWith([ie("Brand Kit", "Rail", { handle: 48 }), ie("Cursor Style", "Screen Clip Settings", { value: "Arrow-first" })]);
	const next = obsWith([ie("Brand Kit", "Rail", { handle: 51 }), ie("Cursor Style", "Screen Clip Settings", { value: "Arrow-first" })]);
	assert.equal(detectMutation({ name: "click", element_index: 48 }, prev, next, undefined, 1), undefined);
});

test("detectMutation__ReturnsUndefined__When__ControlIsGoneAfterTheAction", () => {
	// A menu item that dismisses its own menu is absent from the next observation. Absence is
	// not a value change, and reading it as one would journal every menu interaction.
	const prev = obsWith([ie("Arrow-first", "Cursor Style menu", { handle: 110, value: "Arrow-first" })]);
	assert.equal(detectMutation({ name: "click", element_index: 110 }, prev, obsWith([]), undefined, 2), undefined);
});

test("detectMutation__MatchesControl__When__ElementHandlesRenumber", () => {
	// Handles are a walk order that renumbers whenever the tree changes shape — which is what
	// an action causes. Matching on them would miss every mutation that reorders the tree.
	const prev = obsWith([
		ie("Cursor Scale", "Screen Clip Settings", { handle: 99, value: "1.0x" }),
		ie("Cursor Style", "Screen Clip Settings", { handle: 100, value: "Arrow-first" }),
	]);
	const next = obsWith([
		ie("Cursor Style", "Screen Clip Settings", { handle: 7, value: "Pointer-first" }),
		ie("Cursor Scale", "Screen Clip Settings", { handle: 12, value: "1.0x" }),
	]);
	const m = detectMutation({ name: "click", element_index: 100 }, prev, next, undefined, 4);
	assert.equal(m?.before, "Arrow-first");
	assert.equal(m?.after, "Pointer-first");
});

test("detectMutation__ResolvesSettingKeyAndScope__When__GraphNamesTheControl", () => {
	const prev = obsWith([ie("Theme", "Settings", { handle: 5, value: "Light" })]);
	const next = obsWith([ie("Theme", "Settings", { handle: 5, value: "Dark" })]);
	const m = detectMutation({ name: "click", element_index: 5 }, prev, next, yarnish, 1);
	assert.equal(m?.settingKey, "theme");
	assert.equal(m?.scope, "app");
});

test("detectMutation__ResolvesScopeFromSurface__When__TitleMatchesTwoScopes", () => {
	// Two nodes titled "Cursor Style" at different scopes. The observed surface is the panel
	// the click landed in, so it is evidence about the store rather than a guess from the label.
	const prev = obsWith([ie("Cursor Style", "Screen Clip Settings", { handle: 100, value: "Arrow-first" })]);
	const next = obsWith([ie("Cursor Style", "Screen Clip Settings", { handle: 100, value: "Pointer-first" })]);
	const m = detectMutation({ name: "click", element_index: 100 }, prev, next, yarnish, 3);
	assert.equal(m?.settingKey, "cursor-style");
	assert.equal(m?.scope, "brand");
});

test("detectMutation__ResolvesTheOtherScope__When__SurfaceNamesTheDocumentPanel", () => {
	// The document candidate's parent is NOT a node, so this resolves through the raw
	// id-segment fallback — and proves the tie-break reads the surface rather than taking
	// whichever candidate comes first.
	const prev = obsWith([ie("Cursor Style", "screen-clip-settings", { handle: 100, value: "Arrow-first" })]);
	const next = obsWith([ie("Cursor Style", "screen-clip-settings", { handle: 100, value: "Pointer-first" })]);
	const m = detectMutation({ name: "click", element_index: 100 }, prev, next, yarnish, 3);
	assert.equal(m?.settingKey, "cursor-style");
	assert.equal(m?.scope, "document");
});

test("detectMutation__LeavesScopeUnset__When__SurfaceMatchesNeitherCandidate", () => {
	// An inferred-from-nothing scope would send teardown to the wrong store. settingKey still
	// resolves, because both candidates agree on it — teardown can name the setting either way.
	const prev = obsWith([ie("Cursor Style", "Somewhere Else", { handle: 100, value: "Arrow-first" })]);
	const next = obsWith([ie("Cursor Style", "Somewhere Else", { handle: 100, value: "Pointer-first" })]);
	const m = detectMutation({ name: "click", element_index: 100 }, prev, next, yarnish, 3);
	assert.equal(m?.settingKey, "cursor-style");
	assert.equal(m?.scope, undefined);
});

test("detectMutation__JournalsWithoutSettingKey__When__GraphDoesNotNameTheControl", () => {
	// An unmapped control is still a mutation. before/after is what teardown actually needs.
	const prev = obsWith([ie("Narration Voice", "Script", { handle: 20, value: "Ava" })]);
	const next = obsWith([ie("Narration Voice", "Script", { handle: 20, value: "Kai" })]);
	const m = detectMutation({ name: "click", element_index: 20 }, prev, next, yarnish, 6);
	assert.equal(m?.settingKey, undefined);
	assert.equal(m?.scope, undefined);
	assert.equal(m?.before, "Ava");
	assert.equal(m?.after, "Kai");
});

test("detectMutation__JournalsWithoutSettingKey__When__NoGraphSupplied", () => {
	// An ungrounded run has no appmap at all, and must still be reversible.
	const prev = obsWith([ie("Theme", "Settings", { handle: 5, value: "Light" })]);
	const next = obsWith([ie("Theme", "Settings", { handle: 5, value: "Dark" })]);
	const m = detectMutation({ name: "click", element_index: 5 }, prev, next, undefined, 1);
	assert.equal(m?.settingKey, undefined);
	assert.equal(m?.before, "Light");
});

test("detectMutation__PreservesEmptyBefore__When__FieldWasBlank", () => {
	// "" and undefined are different facts and restoreOne() in src/teardown.ts treats them
	// differently. A blank field that got filled must not be normalised into "unrestorable".
	const prev = obsWith([ie("Project Name", "Details", { handle: 8, role: "AXTextField", value: "" })]);
	const next = obsWith([ie("Project Name", "Details", { handle: 8, role: "AXTextField", value: "Q3 Launch" })]);
	const m = detectMutation({ name: "type_text", element_index: 8 }, prev, next, undefined, 2);
	assert.equal(m?.before, "");
	assert.equal(m?.after, "Q3 Launch");
});

test("detectMutation__ResolvesTargetByCoordinates__When__ActionCarriesNoHandle", () => {
	// Painted controls are addressed by point, and the smallest containing box wins — boxes
	// nest, so the panel also contains the click.
	const prev = obsWith([
		ie("Panel", "", { x: 0, y: 0, w: 500, h: 500, value: "" }),
		ie("Cursor Style", "Panel", { x: 10, y: 10, w: 60, h: 20, value: "Arrow-first" }),
	]);
	const next = obsWith([
		ie("Panel", "", { x: 0, y: 0, w: 500, h: 500, value: "" }),
		ie("Cursor Style", "Panel", { x: 10, y: 10, w: 60, h: 20, value: "Pointer-first" }),
	]);
	const m = detectMutation({ name: "click", x: 20, y: 15 }, prev, next, undefined, 5);
	assert.equal(m?.control, "Cursor Style");
	assert.equal(m?.after, "Pointer-first");
});

// --- the journal on disk. Append-per-mutation exists because runs get killed; these pin that
// a partial file still reads.

const tmpJournal = (): string =>
	path.join(fs.mkdtempSync(path.join(os.tmpdir(), "yarn-journal-")), "run.journal.jsonl");

const setting = (control: string, before: string, after: string, step: number): Mutation =>
	({ kind: "setting", control, surface: "Screen Clip Settings", before, after, step });

test("appendMutation__RoundTrips__When__JournalIsReadBack", () => {
	const file = tmpJournal();
	appendMutation(file, setting("Cursor Style", "Arrow-first", "Pointer-first", 3));
	appendMutation(file, setting("Cursor Scale", "1.0x", "1.5x", 5));
	const back = readJournal(file);
	assert.equal(back.length, 2);
	assert.deepEqual(back.map((m) => m.control), ["Cursor Style", "Cursor Scale"]);
	assert.equal(back[0].before, "Arrow-first");
	assert.equal(back[1].step, 5);
});

test("appendMutation__CreatesTheDirectory__When__RunDirDoesNotExist", () => {
	// The first mutation of a run can land before anything else has written to out/runs.
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "yarn-journal-")), "nested", "run.journal.jsonl");
	appendMutation(file, setting("Theme", "Light", "Dark", 1));
	assert.equal(readJournal(file).length, 1);
});

test("readJournal__ReturnsEmpty__When__FileDoesNotExist", () => {
	// The ordinary case of a run that changed nothing — not an error.
	assert.deepEqual(readJournal(path.join(os.tmpdir(), "yarn-journal-absent", "nope.jsonl")), []);
});

test("readJournal__KeepsGoodRecords__When__LastLineIsTorn", () => {
	// A process killed mid-append is exactly what JSONL is here to survive. Throwing away the
	// complete records in front of a half-written one would give up the whole point.
	const file = tmpJournal();
	appendMutation(file, setting("Cursor Style", "Arrow-first", "Pointer-first", 3));
	fs.appendFileSync(file, '{"kind":"setting","control":"Cursor Sc');
	const back = readJournal(file);
	assert.equal(back.length, 1);
	assert.equal(back[0].control, "Cursor Style");
});

test("restoreRoute__ReturnsNavigationRoute__When__GraphHasEdges", () => {
	assert.equal(restoreRoute(yarnish, "cursor-style", "brand"), 'click "Brand Kit"');
});

test("restoreRoute__ReturnsEmpty__When__SettingIsNotInTheGraph", () => {
	// Teardown treats "" as "navigate on your own" and still gets control/surface/scope, so a
	// missing route degrades a restore rather than killing the entry.
	assert.equal(restoreRoute(yarnish, "narration-voice"), "");
});

test("restoreRoute__PicksTheScopedNode__When__SettingExistsAtTwoScopes", () => {
	// The document node's route is not recorded in this fixture, so the two scopes must give
	// different answers — proof the scope argument selects rather than being ignored.
	assert.equal(restoreRoute(yarnish, "cursor-style", "document"), "(route not recorded)");
});
