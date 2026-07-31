import assert from "node:assert/strict";
import { test } from "node:test";
import { collapseJournal, controlReads, runTeardown, tallyEntries } from "./teardown.js";
import type { TeardownEntry } from "./teardown.js";
import { destructiveTarget } from "./harness.js";
import type { InteractiveElement, ObservationBundle } from "./harness.js";
import type { Mutation } from "./journal.js";

const el = (name: string, value: string, surface = "Screen Clip Settings"): InteractiveElement => ({
	handle: 0,
	role: "AXPopUpButton",
	name,
	surface,
	value,
	x: 0,
	y: 0,
	w: 0,
	h: 0,
});

const obsWith = (interactive: InteractiveElement[], haystack = ""): ObservationBundle => ({
	elementsText: "",
	haystack: haystack.toLowerCase(),
	screenshotB64: "",
	title: "Yarn",
	interactive,
	appContent: interactive.length,
	domEnriched: 0,
	frames: new Map(),
});

const mut = (control: string, before: string, after: string, step: number, surface = "Screen Clip Settings"): Mutation => ({
	kind: "setting",
	control,
	surface,
	before,
	after,
	step,
});

// --- controlReads: the value scan that replaced a haystack grep.
//
// The grep passed on an OPEN PICKER — the original value is rendered as one of the options
// at exactly the moment the setting has not been put back — which would have let teardown
// report a restore it never performed. These pin the distinction.

test("controlReads__ReturnsTrue__When__NamedControlHoldsTheValue", () => {
	const obs = obsWith([el("Cursor Style", "Arrow-first")]);
	assert.equal(controlReads(obs, "Cursor Style", "Screen Clip Settings", "Arrow-first"), true);
});

test("controlReads__ReturnsFalse__When__ValueIsOnlyAnOpenPickerOption", () => {
	// The picker is open on the unchanged control: "Arrow-first" is on screen as an option,
	// but the control itself still reads what the run left it at.
	const obs = obsWith(
		[el("Cursor Style", "Pointer-first"), el("Arrow-first", "", "Cursor Style menu")],
		"Cursor Style Arrow-first Pointer-first",
	);
	assert.equal(controlReads(obs, "Cursor Style", "Screen Clip Settings", "Arrow-first"), false);
});

test("controlReads__ReturnsFalse__When__ControlIsAbsentFromTheObservation", () => {
	const obs = obsWith([el("Motion Blur", "Off")]);
	assert.equal(controlReads(obs, "Cursor Style", "Screen Clip Settings", "Arrow-first"), false);
});

test("controlReads__IgnoresASameNamedControlOnAnotherSurface__When__SurfaceIsKnown", () => {
	// The per-project override reading the target value must not satisfy a brand-scope
	// restore: same label, different store. This is the scope failure the appmap graph
	// exists to catch, arriving here as two controls that differ only in `surface`.
	const obs = obsWith([
		el("Cursor Style", "Pointer-first", "Screen Clip Settings"),
		el("Cursor Style", "Arrow-first", "Screen Recording Settings"),
	]);
	assert.equal(controlReads(obs, "Cursor Style", "Screen Clip Settings", "Arrow-first"), false);
});

test("controlReads__ReturnsTrue__When__RestoringAFieldToBlankAndItIsBlank", () => {
	// Restoring to "" is a real target — a field the run typed into. Substring containment
	// cannot express it, since every string contains the empty string, so emptiness is
	// checked exactly.
	const obs = obsWith([el("Project Name", "", "Details")]);
	assert.equal(controlReads(obs, "Project Name", "Details", ""), true);
});

test("controlReads__ReturnsFalse__When__RestoringToBlankButTheFieldStillHasText", () => {
	const obs = obsWith([el("Project Name", "Q3 Launch", "Details")]);
	assert.equal(controlReads(obs, "Project Name", "Details", ""), false);
});

test("controlReads__MatchesCaseInsensitively__When__AppRendersDifferentCasing", () => {
	const obs = obsWith([el("Cursor Style", "ARROW-FIRST")]);
	assert.equal(controlReads(obs, "Cursor Style", "Screen Clip Settings", "Arrow-first"), true);
});

test("controlReads__ReturnsFalse__When__ValueIsAPrefixOfWhatTheControlReads", () => {
	// Detection compares with ===, so restoration must too. A substring test would report
	// restoring "Auto" as satisfied by the control reading "Auto-hide" — and Yarn's settings
	// carry exactly such prefix-overlapping options.
	const obs = obsWith([el("Cursor Mode", "Auto-hide")]);
	assert.equal(controlReads(obs, "Cursor Mode", "Screen Clip Settings", "Auto"), false);
});

test("controlReads__IgnoresABlankSurfacedTwin__When__TheJournalRecordedASurface", () => {
	// A document-scope twin whose nearest named ancestor is unlabeled renders with surface "".
	// It must not wildcard-match a brand-scope restore whose surface WAS recorded — that is the
	// dual-scope confusion the whole scope machinery exists to prevent.
	const obs = obsWith([
		el("Cursor Style", "Pointer-first", "Screen Clip Settings"),
		el("Cursor Style", "Arrow-first", ""),
	]);
	assert.equal(controlReads(obs, "Cursor Style", "Screen Clip Settings", "Arrow-first"), false);
});

test("collapseJournal__KeepsControlsApart__When__SurfaceAndControlWordsWouldJoinAmbiguously", () => {
	// "Screen Clip" + "Style" and "Screen" + "Clip Style" both space-join to "Screen Clip Style".
	// A JSON key keeps them distinct so one control's mutation is not silently merged into the
	// other's.
	const out = collapseJournal([
		mut("Style", "Arrow-first", "Hand", 1, "Screen Clip"),
		mut("Clip Style", "On", "Off", 2, "Screen"),
	]);
	assert.equal(out.length, 2);
});

// --- collapseJournal: one entry per control, earliest `before`, latest `after`.
//
// A run that cycles a combobox writes an entry per change. Replaying all of them walks the
// control back through every intermediate value to reach the same place, and each extra
// action is another chance to fail.

test("collapseJournal__KeepsTheEarliestBeforeAndLatestAfter__When__OneControlChangedTwice", () => {
	const out = collapseJournal([
		mut("Cursor Style", "Arrow-first", "Hand", 1),
		mut("Cursor Style", "Hand", "Pointer-first", 2),
	]);
	assert.equal(out.length, 1);
	assert.equal(out[0].before, "Arrow-first");
	assert.equal(out[0].after, "Pointer-first");
});

test("collapseJournal__KeepsControlsApart__When__TheyShareANameOnDifferentSurfaces", () => {
	const out = collapseJournal([
		mut("Cursor Style", "Arrow-first", "Hand", 1, "Screen Clip Settings"),
		mut("Cursor Style", "Arrow-first", "Hand", 2, "Screen Recording Settings"),
	]);
	assert.equal(out.length, 2);
});

test("collapseJournal__DropsResourceEntries__When__TheJournalMixesKinds", () => {
	// Resources have no prior value to write back; they are disposed of, not restored, so
	// they must not reach the restore loop at all.
	const out = collapseJournal([
		mut("Cursor Style", "Arrow-first", "Hand", 1),
		{ kind: "resource", control: "", surface: "", step: 2, resource: "scratch-demo-7f3a" },
	]);
	assert.equal(out.length, 1);
	assert.equal(out[0].kind, "setting");
});

test("collapseJournal__ReturnsEmpty__When__NothingWasMutated", () => {
	assert.deepEqual(collapseJournal([]), []);
});

// --- the destructive guard restoreOne() runs on every action the restore model proposes.
//
// The in-run teardown loop had no such guard: it runs unattended, after the run it is tidying
// has already reported, so a model that went looking for its control on the wrong surface
// could press "Delete" with nobody watching. Restoring a value never needs a destructive verb,
// which is what makes refusing it free.

test("destructiveTarget__FlagsTheLabel__When__ARestoreStepWouldPressDelete", () => {
	const obs = obsWith([el("Delete Project", "", "Project menu")]);
	assert.equal(destructiveTarget({ name: "click", element_index: 0 }, obs), "Delete Project");
});

test("destructiveTarget__AllowsTheAction__When__ItPressesAnOrdinaryControl", () => {
	const obs = obsWith([el("Cursor Style", "Arrow-first")]);
	assert.equal(destructiveTarget({ name: "click", element_index: 0 }, obs), undefined);
});

// --- the receipt's arithmetic, which CLEANUP=block reads to decide a run's verdict.

const entry = (control: string, wanted: string | undefined, restored: boolean): TeardownEntry => ({
	control,
	surface: "Screen Clip Settings",
	wanted,
	restored,
	why: "",
});

test("tallyEntries__ExcludesUnattemptedEntriesFromFailures__When__NoPriorValueWasRecorded", () => {
	// The bug this pins: counting an entry with no `before` as a failure would let
	// CLEANUP=block fail a run because the harness honestly declined to guess a value.
	const t = tallyEntries([
		entry("Cursor Style", "Arrow-first", true),
		entry("Ghost Control", undefined, false),
	]);
	assert.equal(t.attempted.length, 1);
	assert.equal(t.restored.length, 1);
	assert.equal(t.dirty.length, 0);
	assert.equal(t.unrestorable.length, 1);
});

test("tallyEntries__CountsADirtyEntry__When__ARestoreWasTriedAndMissed", () => {
	const t = tallyEntries([entry("Motion Blur", "Off", false)]);
	assert.equal(t.attempted.length, 1);
	assert.equal(t.dirty.length, 1);
	assert.equal(t.unrestorable.length, 0);
});

test("tallyEntries__TreatsABlankTargetAsAttempted__When__TheFieldWasOriginallyEmpty", () => {
	// "" is a restorable target, so it belongs in `attempted` — the same line restoreOne()
	// and planRestores() draw.
	const t = tallyEntries([entry("Project Name", "", true)]);
	assert.equal(t.attempted.length, 1);
	assert.equal(t.unrestorable.length, 0);
});

test("runTeardown__Throws__When__BothOrNeitherActuatorIsGiven", async () => {
	// The rest of the args never matter: the guard runs before the journal is read.
	const base = {
		client: {} as never,
		model: "m",
		app: "A",
		journal: [],
		claimed: [],
		steps: [],
		budget: 1,
		mode: "advisory",
		vision: false,
		usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, modelCalls: 0 },
	};
	await assert.rejects(() => runTeardown({ ...base }), /exactly one of driver\/cdp/);
	await assert.rejects(
		() => runTeardown({ ...base, driver: {} as never, cdp: {} as never }),
		/exactly one of driver\/cdp/,
	);
});
