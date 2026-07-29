import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { auditTaskPrompt, findScopeAmbiguities, framesShifted, observationBlocks, pixelDelta, scopeWarnings, toActionRequest, verify } from "./harness.js";
import type { ObservationBundle } from "./harness.js";
import type { AppMap } from "./types.js";
import { EMPTY, bestClass, descriptorFor, lookup } from "./axdom.js";

// Fixtures are synthetic, describing the CLASS of prompt rather than any specific
// historical run, so the tests stay meaningful as tasks change.

test("auditTaskPrompt__Flags__When__PromptNamesDriverInternals", () => {
	const audit = auditTaskPrompt("Add a note to the project (use set_value on the notes field)");
	assert.equal(audit.hinted, true);
	assert.match(audit.reasons.join(" "), /driver\/AX internals/);
});

test("auditTaskPrompt__Flags__When__PromptDictatesInteractionMechanics", () => {
	const audit = auditTaskPrompt(
		"Update the profile name: click the avatar, press cmd+a, then type the new name",
	);
	assert.equal(audit.hinted, true);
	assert.match(audit.reasons.join(" "), /interaction mechanics/);
});

test("auditTaskPrompt__Passes__When__PromptStatesGoalOnly", () => {
	for (const task of [
		"Change my primary time zone to Paris",
		"Create a draft and write a two-scene script, then set the narration voice",
		"Change the cursor style to Pointer-first",
		"Rename the current project to Q3 Launch",
	])
		assert.equal(auditTaskPrompt(task).hinted, false, task);
});

test("auditTaskPrompt__Passes__When__GoalNamesUiSurfacesButNotMechanics", () => {
	// Naming WHERE something lives is legitimate task specification; naming HOW to
	// operate it is not. Surface names alone must not trip the gate.
	const audit = auditTaskPrompt("Open the Script tab and set the voice to the second option");
	assert.equal(audit.hinted, false);
});

test("auditTaskPrompt__Passes__When__SingleIncidentalMechanicVerb", () => {
	// One mechanic verb is usually phrasing, not a recipe; two or more is a dictated path.
	assert.equal(auditTaskPrompt("Create an event by clicking the plus button").hinted, false);
});

test("auditTaskPrompt__ReportsEveryReason__When__PromptHasMultipleHintKinds", () => {
	const audit = auditTaskPrompt("Fix the title: click it, press cmd+a, then use set_value to write Hello");
	assert.equal(audit.hinted, true);
	assert.equal(audit.reasons.length, 2);
});

// verify(): historical run logs showed 2-6 steps per run "verified" by expectations
// that checked nothing, so an empty expectation must now FAIL, and a satisfied check
// must discriminate pre-action state from post-action state.

test("verify__Fails__When__ExpectationHasNoCheckableSubstrings", () => {
	const result = verify({ description: "the menu should open" }, "anything at all");
	assert.equal(result.verified, false);
	assert.match(result.note, /no checkable expectation/);
});

test("verify__Fails__When__ExpectedSubstringMissing", () => {
	const result = verify({ description: "", textIncludes: ["GMT+2"] }, "window title\nedt");
	assert.equal(result.verified, false);
	assert.match(result.note, /not found: GMT\+2/);
});

test("verify__Fails__When__ExcludedSubstringPresent", () => {
	const result = verify({ description: "", textExcludes: ["Untitled"] }, "your drafts\nuntitled");
	assert.equal(result.verified, false);
	assert.match(result.note, /expected absent but found/);
});

test("verify__Passes__When__IncludeAppearsAfterAction", () => {
	const result = verify({ description: "", textIncludes: ["GMT+2"] }, "gutter gmt+2", "gutter edt");
	assert.equal(result.verified, true);
});

test("verify__Fails__When__EveryCheckWasAlreadyTrueBeforeAction", () => {
	// Text the agent typed two steps ago must not verify a later action.
	const result = verify({ description: "", textIncludes: ["Meet Brew"] }, "script\nmeet brew", "script\nmeet brew");
	assert.equal(result.verified, false);
	assert.match(result.note, /ALREADY satisfied/);
});

test("verify__Passes__When__ExcludeDisappearsAfterAction", () => {
	const result = verify({ description: "", textExcludes: ["Settings"] }, "calendar week view", "settings · calendar");
	assert.equal(result.verified, true);
});

test("verify__Passes__When__NoPrevHaystackGiven", () => {
	// Final-state checks (done evidence) assert state, not change — no discrimination demand.
	const result = verify({ description: "", textIncludes: ["cassidy"] }, "select voice: cassidy");
	assert.equal(result.verified, true);
});

// --- painted targets. A canvas draws its contents instead of building them from controls,
// so there is no element to address and no label to grep. Two consequences are tested here:
// coordinate actuation must reach the driver with background delivery ruled out, and a
// success that rests on pixels must stay LABELLED as pixels all the way into the run log.

test("toActionRequest__EmitsForegroundDrag__When__ActionIsDrag", () => {
	const win = { pid: 42, windowId: 7, app: "Anything" };
	const req = toActionRequest({ name: "drag", from_x: 100, from_y: 200, to_x: 340, to_y: 200 }, win);
	assert.equal(req?.kind, "tool");
	const tool = req as { kind: "tool"; name: string; args: Record<string, unknown> };
	assert.equal(tool.name, "drag");
	assert.deepEqual([tool.args.from_x, tool.args.from_y, tool.args.to_x, tool.args.to_y], [100, 200, 340, 200]);
	// Pinned in code, not offered to the model: the driver states background drag is
	// unavailable on macOS, so a model-chosen delivery mode could only ever be wrong.
	assert.equal(tool.args.delivery_mode, "foreground");
});

test("toActionRequest__AddressesByCoordinate__When__ClickHasNoElementIndex", () => {
	const win = { pid: 42, windowId: 7, app: "Anything" };
	const tool = toActionRequest({ name: "click", x: 880, y: 610 }, win) as { args: Record<string, unknown> };
	assert.equal(tool.args.x, 880);
	assert.equal(tool.args.element_index, undefined);
});

test("toActionRequest__PrefersElementIndex__When__BothGiven", () => {
	// element_index is verifiable by label; a coordinate is not. When the model supplies
	// both, the stronger addressing wins.
	const win = { pid: 42, windowId: 7, app: "Anything" };
	const tool = toActionRequest({ name: "click", element_index: 12, x: 880, y: 610 }, win) as { args: Record<string, unknown> };
	assert.equal(tool.args.element_index, 12);
	assert.equal(tool.args.x, undefined);
});

test("verify__ReportsTextChannel__When__SubstringEvidenceSatisfied", () => {
	// The channel is what keeps a pixel run from being quoted as a text run, so the strong
	// channel has to name itself too — an untagged pass would be indistinguishable later.
	const result = verify({ description: "", textIncludes: ["paris"] }, "time zone: paris", "time zone: new york");
	assert.equal(result.verified, true);
	assert.equal(result.channel, "text");
});

test("auditTaskPrompt__Passes__When__PromptIsGoalOnlyAboutCanvasContent", () => {
	// Canvas work must not need method in the prompt. Naming what is wrong with the result
	// is a goal; naming the control or the gesture that fixes it is not.
	for (const task of [
		"The tiger appears before I mention tigers — line them up",
		"The cutaway lands too late in the voiceover; fix the timing",
	])
		assert.equal(auditTaskPrompt(task).hinted, false, task);
});

test("auditTaskPrompt__Flags__When__PromptNamesDragCoordinates", () => {
	// Coordinates are the purest form of method: they encode the answer the agent is
	// supposed to derive from looking at the screen.
	const audit = auditTaskPrompt("Drag the sync point from x=940 to x=1080 to line up the tiger");
	assert.equal(audit.hinted, true);
	assert.match(audit.reasons.join(" "), /screen coordinates/);
});

// framesShifted: the geometry channel. A drag on painted content has no element to grep,
// but the app re-lays-out addressable content around it, and those elements have frames.
// Observed on one timeline: a button went -617 -> -540 on a drag and back on undo.

const at = (pairs: Array<[string, number, number]>) => new Map(pairs.map(([n, x, y]) => [n, { x, y }]));

test("framesShifted__ReportsMover__When__ElementMovesByDragDistance", () => {
	const before = at([["Edit Skip", -617, 300], ["Sidebar", 10, 40]]);
	const after = at([["Edit Skip", -540, 300], ["Sidebar", 10, 40]]);
	const r = framesShifted(before, after, 63, 0);
	assert.equal(r.shifted, true);
	assert.deepEqual(r.movers.map((m) => m.name), ["Edit Skip"]);
});

test("framesShifted__ReportsNothing__When__NothingMoved", () => {
	const same = at([["Edit Skip", -617, 300]]);
	assert.equal(framesShifted(same, at([["Edit Skip", -617, 300]]), 63, 0).shifted, false);
});

test("framesShifted__Ignores__When__MovementIsOppositeTheDrag", () => {
	// Content sliding the wrong way is some other effect — a scroll, a panel opening —
	// not the drag being verified.
	const r = framesShifted(at([["Clip", 500, 0]]), at([["Clip", 437, 0]]), 63, 0);
	assert.equal(r.shifted, false);
});

test("framesShifted__Ignores__When__MovementIsWildlyLargerThanAsked", () => {
	// A page-sized jump in the same direction is a scroll or a navigation, and would
	// otherwise let any drag claim credit for whatever the app happened to do.
	const r = framesShifted(at([["Clip", 500, 0]]), at([["Clip", 1400, 0]]), 63, 0);
	assert.equal(r.shifted, false);
});

test("framesShifted__Ignores__When__NameIsAmbiguousAcrossSiblings", () => {
	// Several controls share a label; NaN marks the collision at observe() time. Identity
	// is not established, so the element cannot witness anything.
	const before = new Map([["Delete", { x: NaN, y: NaN }]]);
	const after = new Map([["Delete", { x: NaN, y: NaN }]]);
	assert.equal(framesShifted(before, after, 63, 0).shifted, false);
});

test("framesShifted__ReportsNothing__When__DragWasNegligible", () => {
	// A few pixels is not a request to move anything, and every ratio test degenerates.
	const r = framesShifted(at([["Clip", 500, 0]]), at([["Clip", 503, 0]]), 3, 0);
	assert.equal(r.shifted, false);
});

test("auditTaskPrompt__Passes__When__NumbersAreGoalNotPosition", () => {
	// The coordinate rule must not swallow numbers that specify the outcome. A resolution,
	// a duration, and a count all read as digits and none of them is a hint.
	for (const task of [
		"Export the draft at 1920 x 1080",
		"Trim the intro to 30 seconds",
		"Add 3 more scenes to the script",
	])
		assert.equal(auditTaskPrompt(task).hinted, false, task);
});

// --- appmap graph: the structured companion to the prose map. It earns its place by
// catching the wrong-scope failure prose could not — on Yarn, "Cursor Style" is editable
// brand-wide and per-draft (independent stores), and all four ungrounded runs changed the
// per-draft one while passing verification.

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

test("findScopeAmbiguities__ReportsSetting__When__SameKeyEditableAtTwoScopes", () => {
	const found = findScopeAmbiguities(yarnish);
	assert.equal(found.length, 1);
	assert.equal(found[0].settingKey, "cursor-style");
	assert.deepEqual(found[0].nodes.map((n) => n.scope).sort(), ["brand", "document"]);
});

test("findScopeAmbiguities__IgnoresSetting__When__EditableAtOneScopeOnly", () => {
	assert.equal(findScopeAmbiguities(yarnish).some((a) => a.settingKey === "theme"), false);
});

test("findScopeAmbiguities__ReturnsEmpty__When__NoControlsCarrySettingKeys", () => {
	const map: AppMap = { ...yarnish, nodes: yarnish.nodes.map(({ settingKey, ...n }) => n) };
	assert.deepEqual(findScopeAmbiguities(map), []);
});

test("scopeWarnings__NamesBothScopes__When__AmbiguityExists", () => {
	const w = scopeWarnings(yarnish);
	assert.match(w, /cursor-style/);
	// Entries name the SURFACE holding the control, since grouping keys on surface pairs.
	assert.match(w, /brand scope — brand-kit\/screen-clips/);
	assert.match(w, /document scope — editor\/screen-clip-settings/);
	assert.match(w, /SEPARATE stores/);
});

test("scopeWarnings__PresentsBothWithoutPickingOne__When__AmbiguityExists", () => {
	// The harness surfaces the options and the agent decides from task context; baking a
	// "always prefer the broadest scope" rule in here would make the wrong call whenever a
	// task is genuinely about one document.
	const w = scopeWarnings(yarnish);
	assert.match(w, /Both routes are given because either can be correct/);
	assert.match(w, /SAY WHICH YOU CHOSE AND WHY/);
	assert.equal(/prefer the broadest/.test(w), false);
});

test("scopeWarnings__GroupsBySurfacePair__When__ManySettingsShareTwoPanels", () => {
	// Yarn has 16 settings split across the same brand-vs-document panel pair. Listing each
	// separately repeated one pair of routes 15 times and produced a warning nearly twice the
	// size of the appmap it annotates, so entries group by surface pair.
	const many: AppMap = {
		...yarnish,
		nodes: [
			...yarnish.nodes,
			{ id: "brand-kit/screen-clips/shadow-blur", title: "Shadow Blur", kind: "control", scope: "brand", settingKey: "shadow-blur" },
			{ id: "editor/screen-clip-settings/shadow-blur", title: "Shadow Blur", kind: "control", scope: "document", settingKey: "shadow-blur" },
		],
	};
	const w = scopeWarnings(many);
	assert.equal(w.match(/These settings exist at/g)?.length, 1, "both settings share one grouped entry");
	assert.match(w, /cursor-style, shadow-blur/);
});

test("scopeWarnings__IncludesNavigationRoute__When__EdgesRecorded", () => {
	// A scope choice is only actionable if the agent can reach the one it picks.
	assert.match(scopeWarnings(yarnish), /route: click "Brand Kit"/);
});

test("scopeWarnings__ReturnsEmpty__When__NoAmbiguities", () => {
	assert.equal(scopeWarnings({ ...yarnish, nodes: [yarnish.nodes[3]] }), "");
});

// --no-vision A/B arm: the text block must be identical across arms so the only
// difference the model sees is the presence of the image.

const bundle: ObservationBundle = {
	elementsText: '[3] AXButton "Save" @(10,20 80x30)',
	frames: new Map([["Save", { x: 10, y: 20 }]]),
	haystack: "save",
	screenshotB64: "aGk=",
	title: "Settings",
	appContent: 1,
	domEnriched: 0,
};

test("observationBlocks__OmitsImageBlock__When__VisionDisabled", () => {
	const blocks = observationBlocks(bundle, false);
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].type, "text");
});

test("observationBlocks__KeepsTextIdentical__When__VisionDisabled", () => {
	const withVision = observationBlocks(bundle, true);
	const without = observationBlocks(bundle, false);
	assert.equal(withVision.length, 2);
	assert.equal(withVision[1].type, "image");
	assert.deepEqual(without[0], withVision[0]);
});

// --- pixelDelta: the cheap half of visual verification. Rendered content is absent from
// the AX haystack verify() greps, so this is the only signal that a canvas repainted.
// Fixtures are real run screenshots, not synthetic images.

const SHOT_A = `${process.cwd()}/out/blind-lib.png`;
const SHOT_B = `${process.cwd()}/out/agent-final.png`;

test("pixelDelta__ReturnsZero__When__ComparedWithItself", { skip: !fs.existsSync(SHOT_A) }, () => {
	assert.equal(pixelDelta(SHOT_A, SHOT_A), 0);
});

test("pixelDelta__ReturnsNonZero__When__ScreensDiffer", { skip: !fs.existsSync(SHOT_A) || !fs.existsSync(SHOT_B) }, () => {
	const d = pixelDelta(SHOT_A, SHOT_B);
	// Same-size frames of different surfaces; if sizes differ the diff is undefined, which
	// is also a valid answer — assert only that it never reports "identical".
	if (d !== undefined) assert.ok(d > 0.01, `expected a visible difference, got ${d}`);
});

test("pixelDelta__ReturnsUndefined__When__FileMissing", () => {
	assert.equal(pixelDelta(SHOT_A, `${process.cwd()}/out/does-not-exist.png`), undefined);
});

// axdom: the DOM-attribute enrichment that recovers what the AX projection drops.
// These are the pure formatting decisions — the sidecar walk itself needs a live app.

test("bestClass__DropsFrameworkChrome__When__OnlyGenericTokensPresent", () => {
	assert.equal(bestClass("RootView"), "");
	assert.equal(bestClass("ClientView View"), "");
});

test("bestClass__PicksMostSpecificToken__When__BemChainPresent", () => {
	assert.equal(bestClass("icon icon--name--chevronDown"), "icon--name--chevronDown");
	assert.equal(
		bestClass("app libraryPage-sideMenu-personalTab-orgBadgeBtn"),
		"libraryPage-sideMenu-personalTab-orgBadgeBtn",
	);
});

test("descriptorFor__NamesAnonymousControl__When__DomClassPresent", () => {
	const d = descriptorFor({ x: 0, y: 0, w: 10, h: 10, role: "AXButton", domClass: "ag-editor-toolbar-playBtn" });
	assert.equal(d, ".ag-editor-toolbar-playBtn");
});

test("descriptorFor__OmitsId__When__IdIsFrameworkGenerated", () => {
	// Radix/MUI mint these per render: identical across siblings, unstable across renders.
	const d = descriptorFor({ x: 0, y: 0, w: 10, h: 10, role: "AXPopUpButton", domId: "radix-_r_sj_", domClass: "sceneHeader-dropdownBtn" });
	assert.equal(d, ".sceneHeader-dropdownBtn");
	assert.ok(!d.includes("radix"));
});

test("descriptorFor__KeepsId__When__IdIsAuthored", () => {
	const d = descriptorFor({ x: 0, y: 0, w: 10, h: 10, role: "AXGroup", domId: "settings-panel" });
	assert.equal(d, "#settings-panel");
});

test("descriptorFor__DropsChromiumImagePlaceholder__When__NoRealDescription", () => {
	const d = descriptorFor({
		x: 0, y: 0, w: 10, h: 10, role: "AXImage",
		description: "To get missing image descriptions, open the context menu.",
	});
	assert.equal(d, "");
});

test("descriptorFor__ReturnsEmpty__When__NothingUseful", () => {
	assert.equal(descriptorFor({ x: 0, y: 0, w: 10, h: 10, role: "AXGroup" }), "");
});

test("lookup__ReturnsEmpty__When__ElementHasNoFrame", () => {
	assert.equal(lookup(EMPTY, undefined), "");
});
