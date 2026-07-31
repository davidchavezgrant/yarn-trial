import assert from "node:assert/strict";
import { test } from "node:test";
import { actionTarget, destructiveTarget, externalityTarget, gatedId, gatedSection, reversibleTarget, sessionEndingChord } from "../src/core/harness.js";
import type { InteractiveElement, ObservationBundle } from "../src/core/harness.js";

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

const ie = (name: string, surface = "", box: Partial<InteractiveElement> = {}): InteractiveElement =>
	({ handle: 0, role: "AXButton", name, surface, value: "", x: 0, y: 0, w: 0, h: 0, ...box });

const obsWith = (interactive: InteractiveElement[]): ObservationBundle => ({ ...bundle, interactive });

test("actionTarget__ResolvesByHandle__When__ActionAddressesAnElement", () => {
	const obs = obsWith([ie("Save", "Toolbar", { handle: 3 }), ie("Cancel", "Toolbar", { handle: 4 })]);
	assert.equal(actionTarget({ name: "click", element_index: 3 }, obs)?.name, "Save");
	assert.equal(actionTarget({ name: "click", element_index: 99 }, obs), undefined);
});

test("actionTarget__ResolvesInnermostBox__When__ActionIsCoordinateAddressed", () => {
	// Boxes nest, so a point inside a button is also inside its panel. The innermost one is what
	// the click actually hits, and what the cursor pass must name to pick a pointer type.
	const obs = obsWith([
		ie("Panel", "", { x: 0, y: 0, w: 500, h: 500 }),
		ie("Save", "Panel", { x: 10, y: 10, w: 60, h: 20 }),
	]);
	assert.equal(actionTarget({ name: "click", x: 20, y: 15 }, obs)?.name, "Save");
	assert.equal(actionTarget({ name: "click", x: 300, y: 300 }, obs)?.name, "Panel");
});

test("actionTarget__ReturnsUndefined__When__ActionHasNoTarget", () => {
	const obs = obsWith([ie("Save", "Toolbar", { handle: 3 })]);
	assert.equal(actionTarget({ name: "press_key", key: "escape" }, obs), undefined);
});

// --- unattended-safety guard. A 12h pass on a real workspace is a different risk profile
// from a 5-minute one, and the prior protection was a paragraph in a system prompt.

test("guard__RefusesAction__When__TargetLabelIsDestructive", () => {
	const obs = obsWith([ie("Delete draft", "Menu", { handle: 9 })]);
	assert.equal(destructiveTarget({ name: "click", element_index: 9 }, obs), "Delete draft");
});

test("guard__RefusesAction__When__CoordinateClickLandsOnDestructiveControl", () => {
	// Coordinates are how the guard would otherwise be trivially bypassed.
	const obs = obsWith([ie("Publish", "Menu", { x: 0, y: 0, w: 100, h: 30 })]);
	assert.equal(destructiveTarget({ name: "click", x: 10, y: 10 }, obs), "Publish");
});

test("guard__AllowsAction__When__LabelMerelyContainsTheVerbInsideAWord", () => {
	// Word-boundary matching: "Undelete" and "Shareable" are not the verbs, and an
	// over-eager guard that blocks ordinary navigation makes the pass useless.
	const obs = obsWith([ie("Sharepoint sync status", "Menu", { handle: 9 })]);
	assert.equal(destructiveTarget({ name: "click", element_index: 9 }, obs), undefined);
});

test("guard__AllowsAction__When__ActionIsNotAClick", () => {
	// Hovering or scrolling over a Delete row actuates nothing; refusing those would block
	// the pass from reading a menu it is allowed to look at.
	const obs = obsWith([ie("Delete draft", "Menu", { handle: 9 })]);
	assert.equal(destructiveTarget({ name: "hover", element_index: 9 }, obs), undefined);
});

const webCtl = (name: string): ObservationBundle =>
	({ interactive: [{ handle: 7, role: "AXButton", name, surface: "", x: 0, y: 0, w: 0, h: 0 }] }) as ObservationBundle;

test("destructiveTarget__RefusesCommitVerbs__When__TargetIsWeb", () => {
	// A website's destructive act is usually a bare commit verb, and none of these appear in
	// the desktop verb set.
	for (const label of ["Confirm", "Submit", "Post", "Reply", "Accept", "Place order", "Pay now"])
		assert.equal(destructiveTarget({ name: "click", element_index: 7 }, webCtl(label), true), label);
});

test("destructiveTarget__AllowsDownload__When__TargetIsWeb", () => {
	// "Download" is on every docs page on the internet; blocking it would refuse a large
	// fraction of ordinary navigation. It is a local side effect, not an externally visible one.
	assert.equal(destructiveTarget({ name: "click", element_index: 7 }, webCtl("Download"), true), undefined);
	// ...but it stays guarded for a desktop app, where it means an export.
	assert.equal(destructiveTarget({ name: "click", element_index: 7 }, webCtl("Download"), false), "Download");
});

test("destructiveTarget__RefusesEnter__When__WebAndAimedAtANamedControl", () => {
	// On the web, Enter is a submit. Partial guard — see the documented hole.
	assert.equal(destructiveTarget({ name: "press_key", key: "return", element_index: 7 }, webCtl("Submit"), true), "Submit");
});

// --- the two-gate split. "Destructive" fuses two questions with opposite answers once
// descent exists: does this commit OFF the machine (externality — refuse always) vs does
// this mutate local state we could put back (reversible — descent-eligible). The tests pin
// the partition (every verb in exactly one gate) and the union (destructiveTarget refuses
// exactly what it refused before the split).

const DESKTOP_EXTERNALITY = ["Publish", "Send", "Share", "Invite", "Buy", "Purchase", "Subscribe", "Unsubscribe", "Sign out", "Log out", "Revoke", "Deactivate"];
const DESKTOP_REVERSIBLE = ["Delete", "Remove", "Discard", "Erase", "Trash", "Clear", "Export", "Download", "Reset", "Restore", "Merge", "Archive"];

test("externalityTarget__RefusesEveryOffMachineVerb__When__TargetIsDesktop", () => {
	for (const label of DESKTOP_EXTERNALITY) {
		const obs = obsWith([ie(label, "Menu", { handle: 9 })]);
		assert.equal(externalityTarget({ name: "click", element_index: 9 }, obs), label);
		assert.equal(reversibleTarget({ name: "click", element_index: 9 }, obs), undefined, `${label} must not also be reversible`);
	}
});

test("reversibleTarget__FlagsEveryLocalMutationVerb__When__TargetIsDesktop", () => {
	for (const label of DESKTOP_REVERSIBLE) {
		const obs = obsWith([ie(label, "Menu", { handle: 9 })]);
		assert.equal(reversibleTarget({ name: "click", element_index: 9 }, obs), label);
		assert.equal(externalityTarget({ name: "click", element_index: 9 }, obs), undefined, `${label} must not also be externality`);
	}
});

test("destructiveTarget__RefusesTheUnionOfBothGates__When__EitherMatches", () => {
	// The split must not change what the pre-split guard refused: teardown's restore guard
	// and the descent-off explore path both call destructiveTarget and must stay identical.
	for (const label of [...DESKTOP_EXTERNALITY, ...DESKTOP_REVERSIBLE]) {
		const obs = obsWith([ie(label, "Menu", { handle: 9 })]);
		assert.equal(destructiveTarget({ name: "click", element_index: 9 }, obs), label);
	}
	const benign = obsWith([ie("Open settings", "Menu", { handle: 9 })]);
	assert.equal(destructiveTarget({ name: "click", element_index: 9 }, benign), undefined);
});

test("externalityTarget__RefusesCommitVerbs__When__TargetIsWeb", () => {
	// Web commit verbs ship state to a server — all externality, none reversible.
	for (const label of ["Confirm", "Submit", "Post", "Reply", "Accept", "Place order", "Pay now"]) {
		assert.equal(externalityTarget({ name: "click", element_index: 7 }, webCtl(label), true), label);
		assert.equal(reversibleTarget({ name: "click", element_index: 7 }, webCtl(label), true), undefined);
	}
});

test("reversibleTarget__AllowsExportAndDownload__When__TargetIsWeb", () => {
	// Same web carve-out the union has always had: a download is a local side effect.
	for (const label of ["Download", "Export"]) {
		assert.equal(reversibleTarget({ name: "click", element_index: 7 }, webCtl(label), true), undefined);
		assert.equal(externalityTarget({ name: "click", element_index: 7 }, webCtl(label), true), undefined);
	}
});

// --- gated-boundary recording. gatedId slugs a control into a graph-style id; gatedSection
// renders the Tier-1 reads into the prose the task agent gets injected.

test("gatedId__JoinsSurfaceAndName__When__NodeResolved", () => {
	assert.equal(gatedId({ surface: "Brand Kit", name: "Delete Brand" }, "Delete Brand"), "brand-kit/delete-brand");
});

test("gatedId__FallsBackToLabel__When__ControlResolvedToNothing", () => {
	// The control the guard matched by coordinate may not resolve to a named node; the raw
	// label still has to produce a stable id, because a gated control with no node is exactly
	// what the boundary record exists to capture.
	assert.equal(gatedId(undefined, "Export…"), "export");
	assert.equal(gatedId({ surface: "", name: "" }, "Reset all"), "reset-all");
});

test("gatedSection__RendersOnlyTierOneReads__When__MixedTiers", () => {
	const section = gatedSection([
		{ id: "project/export", tierReached: 1, boundary: "confirm-dialog: formats {mp4, gif}", stoppedBecause: "descent:read-and-escape:confirm-dialog", scratchUsed: false },
		{ id: "acct/sign-out", tierReached: 0, boundary: "not opened — off-machine", stoppedBecause: "externality:label", scratchUsed: false },
	]);
	assert.match(section, /## Gated flows/);
	assert.match(section, /project\/export/);
	assert.match(section, /formats \{mp4, gif\}/);
	// A Tier-0 refusal is not something a task agent can act on, so it stays out of the prose.
	assert.doesNotMatch(section, /sign-out/);
});

test("gatedSection__IsEmpty__When__NoTierOneReads", () => {
	// A non-descent pass produces only refusals; its document must be byte-identical to before,
	// so the section contributes nothing rather than an empty heading.
	assert.equal(gatedSection([]), "");
	assert.equal(
		gatedSection([{ id: "x/y", tierReached: 0, boundary: "not opened", stoppedBecause: "descent:off", scratchUsed: false }]),
		"",
	);
});

test("destructiveTarget__IgnoresEnter__When__TargetIsAMacApp", () => {
	// Unchanged for apps: guessing at keystrokes would stop a pass from typing at all.
	assert.equal(destructiveTarget({ name: "press_key", key: "return", element_index: 7 }, webCtl("Submit"), false), undefined);
});

test("sessionEndingChord__RefusesTheChordsThatCloseTheApp__When__PressedWithCommand", () => {
	// Learned on 2026-07-31: an explore pass 162 actions into Yarn pressed cmd+Q. The label
	// guards saw a keystroke with no control attached and passed it, the driver then could not
	// observe the target, and the diagnostic blamed an inactive macOS Space — so the operator
	// would have hunted for a window that no longer existed.
	for (const key of ["q", "h", "m", "Q"]) {
		const verdict = sessionEndingChord({ name: "press_key", key, modifiers: ["cmd"] });
		assert.ok(verdict, `cmd+${key} must be refused`);
	}
	// Every accepted spelling of the modifier — a guard that only knows one is not a guard.
	for (const mod of ["cmd", "command", "meta", "Cmd"]) {
		assert.ok(sessionEndingChord({ name: "press_key", key: "q", modifiers: [mod] }), mod);
	}
});

test("sessionEndingChord__LeavesOrdinaryInputAlone__When__NoCommandOrHarmlessKey", () => {
	// The label guards deliberately refuse to judge keystrokes, because guessing at chords
	// would block the pass from typing. This list stays narrow for the same reason.
	assert.equal(sessionEndingChord({ name: "press_key", key: "q" }), undefined, "plain q is typing");
	assert.equal(sessionEndingChord({ name: "type_text", text: "quit" }), undefined);
	assert.equal(sessionEndingChord({ name: "press_key", key: "a", modifiers: ["cmd"] }), undefined, "cmd+a selects");
	assert.equal(sessionEndingChord({ name: "press_key", key: "s", modifiers: ["cmd"] }), undefined, "cmd+s saves");
	// cmd+W is deliberately allowed: closing a tab or dialog is ordinary navigation, and on a
	// browser target a pass may legitimately need it.
	assert.equal(sessionEndingChord({ name: "press_key", key: "w", modifiers: ["cmd"] }), undefined);
	assert.equal(sessionEndingChord({ name: "click", element_index: 3 }), undefined);
});
