import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { Driver } from "./driver.js";
import {
	auditTaskPrompt,
	destructiveTarget,
	findScopeAmbiguities,
	framesShifted,
	frontierCredit,
	frontierDismiss,
	frontierIngest,
	frontierMatches,
	frontierRemaining,
	frontierSummary,
	isTransientApiError,
	isVagueSurface,
	MAX_WAIT_MS,
	mergeGraph,
	newFrontier,
	observationBlocks,
	observe,
	pixelDelta,
	recoverLeakedGraph,
	retryTransient,
	scopeWarnings,
	settleMsFor,
	toActionRequest,
	unpaintedStreak,
	verificationTallies,
	verify,
} from "./harness.js";
import type { InteractiveElement, ObservationBundle } from "./harness.js";
import type { AppMap, AppMapEdge, AppMapNode, StepRecord } from "./types.js";
import { EMPTY, bestClass, descriptorFor, lookup } from "./axdom.js";
import { overlayEnv, scriptEnvKeys } from "./overlay.js";

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

// settleMsFor: the whole point is that ONE wait can cover a multi-minute operation. Before
// it existed the longest pause the agent could express was the settle delay, so waiting out
// an app's own agent cost hundreds of turns and hit the step budget instead.

test("settleMsFor__ReturnsTheDefault__When__ActionIsNotAWait", () => {
	assert.equal(settleMsFor({ name: "click", element_index: 3, seconds: 300 }, 900), 900);
});

test("settleMsFor__SleepsTheRequestedSpan__When__WaitCarriesSeconds", () => {
	assert.equal(settleMsFor({ name: "wait", seconds: 300 }, 900), 300_000);
});

test("settleMsFor__ClampsToTheMaximum__When__SecondsIsAbsurd", () => {
	// A model that means 100 and writes 100000 must cost one long step, not a hung run.
	assert.equal(settleMsFor({ name: "wait", seconds: 100_000 }, 900), MAX_WAIT_MS);
});

test("settleMsFor__FallsBackToTheDefault__When__SecondsIsMissingOrUnusable", () => {
	// `wait` predates the argument, so a bare wait must keep meaning a short settle rather
	// than becoming a zero-length no-op that re-observes before the app has redrawn.
	for (const seconds of [undefined, 0, -5, "soon", NaN])
		assert.equal(settleMsFor({ name: "wait", seconds }, 900), 900, `seconds=${String(seconds)}`);
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
	interactive: [{ handle: 3, role: "AXButton", name: "Save", surface: "", x: 10, y: 20, w: 80, h: 30 }],
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

// --- observe(): the frontier's only input. AX frames are screen-global LOGICAL POINTS while
// coordinate actions consume SCREENSHOT PIXELS, so observe() converts — and if that conversion
// is wrong the ledger silently credits the wrong control, which nothing downstream can detect.
// Measured on Yarn: a 1920-wide window shot at 1568 (scale 0.81667) on a display left of the
// primary, hence the negative origin in this fixture.

const fakeDriver = (payload: Record<string, unknown>, shotPath: string): Driver =>
	({
		act: async () => {
			fs.mkdirSync(shotPath.replace(/\/[^/]+$/, ""), { recursive: true });
			fs.writeFileSync(shotPath, "png");

			return { text: "", structuredJson: JSON.stringify(payload) };
		},
	}) as unknown as Driver;

const axWindow = { element_index: 0, role: "AXWindow", label: "", frame: { x: -2181, y: 763, w: 1920, h: 1080 } };

const observeFixture = async (elements: unknown[]): Promise<ObservationBundle> => {
	const shot = `${process.cwd()}/out/test-observe.png`;
	const prev = process.env.AXDOM;
	process.env.AXDOM = "0"; // the sidecar needs a live app; this test is about the join-free path
	try {
		return await observe(fakeDriver({ elements, screenshot_width: 1568, screenshot_height: 882 }, shot), { pid: 1, windowId: 1 }, "test-observe");
	} finally {
		if (prev === undefined) delete process.env.AXDOM;
		else process.env.AXDOM = prev;
	}
};

test("observe__ReportsInteractiveElements__When__ElementsAreClickable", async () => {
	const obs = await observeFixture([
		axWindow,
		{ element_index: 1, role: "AXGroup", label: "Toolbar", parent_index: 0, frame: { x: -2181, y: 763, w: 400, h: 60 } },
		{ element_index: 2, role: "AXButton", label: "Save", parent_index: 1, frame: { x: -2081, y: 823, w: 120, h: 40 } },
		{ element_index: 3, role: "AXStaticText", label: "Untitled", parent_index: 1, frame: { x: -2000, y: 900, w: 80, h: 20 } },
	]);
	// Static text is not actuatable, so it never joins the frontier however well-labelled.
	assert.deepEqual(obs.interactive.map((e) => e.name), ["Save"]);
	assert.equal(obs.interactive[0].surface, "Toolbar");
	// (-2081 - -2181) * 1568/1920 = 81.67 -> 82; (823 - 763) * 0.81667 = 49; 120 -> 98.
	assert.deepEqual([obs.interactive[0].x, obs.interactive[0].y, obs.interactive[0].w], [82, 49, 98]);
});

test("observe__OmitsControl__When__ItIsDisabled", async () => {
	// A disabled control cannot be actuated, so a frontier entry for it is one nothing can
	// ever clear — the run would then always end on the time cap.
	const obs = await observeFixture([
		axWindow,
		{ element_index: 1, role: "AXButton", label: "Publish", parent_index: 0, enabled: false, frame: { x: -2181, y: 763, w: 10, h: 10 } },
	]);
	assert.deepEqual(obs.interactive, []);
});

test("observe__ReportsZeroGeometry__When__WindowFrameIsUnavailable", async () => {
	// No AXWindow means no scale and no origin. Zeroing is what makes the ledger's
	// containment test MISS rather than match wrongly.
	const obs = await observeFixture([{ element_index: 1, role: "AXButton", label: "Save", frame: { x: 10, y: 20, w: 30, h: 40 } }]);
	assert.deepEqual([obs.interactive[0].x, obs.interactive[0].y, obs.interactive[0].w, obs.interactive[0].h], [0, 0, 0, 0]);
});

// --- frontier ledger: the mechanical answer to "did the pass map the whole app?". Its
// predecessor was the model auditing its own coverage from a transcript that, by
// construction, contains only the surfaces it visited. These tests pin the two credit paths
// (handle and coordinate), the dismissal escape hatch, and the guards that stop one click
// from draining a panel it never touched.

const ie = (name: string, surface = "", box: Partial<InteractiveElement> = {}): InteractiveElement =>
	({ handle: 0, role: "AXButton", name, surface, x: 0, y: 0, w: 0, h: 0, ...box });

const obsWith = (interactive: InteractiveElement[]): ObservationBundle => ({ ...bundle, interactive });

test("frontier__ExcludesControl__When__ActionAddressesItsHandle", () => {
	const ledger = newFrontier();
	const obs = obsWith([ie("Save", "Toolbar", { handle: 3 }), ie("Cancel", "Toolbar", { handle: 4 })]);
	frontierIngest(ledger, obs);
	frontierCredit(ledger, { name: "click", element_index: 3 }, obs);
	assert.deepEqual(frontierRemaining(ledger).map((e) => e.name), ["Cancel"]);
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

// --- transient-error retry. A 12h unattended pass died two minutes in on one mid-stream
// BodyTimeoutError, with nothing recorded and so nothing to salvage.

test("isTransientApiError__ReturnsTrue__When__StreamTerminatedMidBody", () => {
	// The observed shape: no status (headers were already 200), the real cause nested.
	const err = Object.assign(new Error("terminated"), { cause: new Error("BodyTimeoutError") });
	assert.equal(isTransientApiError(err), true);
});

test("isTransientApiError__ReturnsTrue__When__ServerIsOverloadedOrRateLimited", () => {
	for (const status of [429, 500, 503])
		assert.equal(isTransientApiError(Object.assign(new Error("nope"), { status })), true, String(status));
});

test("isTransientApiError__ReturnsFalse__When__RequestIsMalformed", () => {
	// A 400 fails identically forever; retrying it only makes the failure slower.
	assert.equal(isTransientApiError(Object.assign(new Error("bad request"), { status: 400 })), false);
	assert.equal(isTransientApiError(Object.assign(new Error("unauthorized"), { status: 401 })), false);
});

test("retryTransient__ReturnsResult__When__SecondAttemptSucceeds", async () => {
	let calls = 0;
	const result = await retryTransient(
		async () => {
			if (++calls === 1) throw new Error("terminated");

			return "mapped";
		},
		{ delaysMs: [0, 0] },
	);
	assert.equal(result, "mapped");
	assert.equal(calls, 2);
});

test("retryTransient__Rethrows__When__ErrorIsNotTransient", async () => {
	let calls = 0;
	await assert.rejects(
		retryTransient(
			async () => {
				calls++;
				throw Object.assign(new Error("bad request"), { status: 400 });
			},
			{ delaysMs: [0, 0] },
		),
		/bad request/,
	);
	assert.equal(calls, 1);
});

test("retryTransient__Rethrows__When__EveryAttemptIsExhausted", async () => {
	let calls = 0;
	await assert.rejects(
		retryTransient(
			async () => {
				calls++;
				throw new Error("terminated");
			},
			{ delaysMs: [0, 0] },
		),
		/terminated/,
	);
	assert.equal(calls, 3); // initial attempt plus one per delay
});

// --- leaked graph recovery. Observed live: the model writes its nodes/edges into the finding
// STRING as literal tool-call markup instead of the structured argument, so the graph stalls
// while the prose keeps growing. The payload is intact; only the envelope is wrong.

test("recoverLeakedGraph__ExtractsNodes__When__ModelWroteThemIntoTheFindingText", () => {
	const finding =
		'EDITOR captions: clicking the captions icon swaps the topbar.\n<parameter name="nodes">' +
		'[{"id":"editor/captions-toolbar","title":"Caption styling toolbar","kind":"surface","scope":"document"}]</parameter>';
	const out = recoverLeakedGraph(finding);
	assert.equal(out.nodes.length, 1);
	assert.equal(out.nodes[0].id, "editor/captions-toolbar");
	assert.doesNotMatch(out.cleaned, /<parameter/);
	assert.match(out.cleaned, /clicking the captions icon/);
});

test("recoverLeakedGraph__ExtractsBoth__When__NodesAndEdgesBothLeaked", () => {
	const out = recoverLeakedGraph(
		'Found it.\n<parameter name="nodes">[{"id":"a","title":"A","kind":"surface","scope":"app"}]</parameter>' +
			'<parameter name="edges">[{"from":"root","to":"a","action":"click \\"A\\""}]</parameter>',
	);
	assert.equal(out.nodes.length, 1);
	assert.equal(out.edges.length, 1);
	assert.equal(out.cleaned, "Found it.");
});

test("recoverLeakedGraph__ExtractsPayload__When__ClosingTagIsMissing", () => {
	// A generation cut off at max_tokens has the array but not the closing tag.
	const out = recoverLeakedGraph(
		'Notes here.\n<parameter name="nodes">[{"id":"a","title":"A","kind":"surface","scope":"app"}]',
	);
	assert.equal(out.nodes.length, 1);
});

test("recoverLeakedGraph__KeepsFinding__When__LeakedJsonIsTruncatedMidArray", () => {
	// Salvage must cost only the unparseable block, never the prose around it.
	const out = recoverLeakedGraph('Real knowledge worth keeping.\n<parameter name="nodes">[{"id":"a","tit');
	assert.equal(out.nodes.length, 0);
	assert.match(out.cleaned, /Real knowledge worth keeping/);
});

test("recoverLeakedGraph__ReturnsTextUnchanged__When__NothingLeaked", () => {
	const out = recoverLeakedGraph("An ordinary finding with no markup in it.");
	assert.equal(out.cleaned, "An ordinary finding with no markup in it.");
	assert.equal(out.nodes.length + out.edges.length, 0);
});

test("recoverLeakedGraph__FeedsMergeGraph__When__PayloadIsRecovered", () => {
	// The recovered entries must be the same shape mergeGraph already accepts.
	const nodes = new Map<string, AppMapNode>();
	const edges = new Map<string, AppMapEdge>();
	const out = recoverLeakedGraph(
		'x\n<parameter name="nodes">[{"id":"settings/theme","title":"Theme","kind":"control","scope":"app","settingKey":"theme"}]</parameter>',
	);
	assert.equal(mergeGraph(nodes, edges, out), 1);
	assert.equal(nodes.get("settings/theme")?.settingKey, "theme");
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

// overlay: the parent hands the JXA child a hand-built env, and a key the script reads but
// the parent never sets fails SILENTLY — read() returns its fallback and the feature simply
// does nothing. Exactly that happened to OVERLAY_PAUSE: show/hide was dead code for every
// run, the banner stayed up the whole time, and the parent went on writing pause files
// nothing was listening for. Scraping the script's own read() calls closes the class.

test("overlayEnv__SuppliesEveryKey__When__ScriptReadsIt", () => {
	const env = overlayEnv("drive", "banner text", 4242, "/tmp/go", "/tmp/pause");
	const missing = scriptEnvKeys().filter((k) => !(k in env));
	assert.deepEqual(missing, [], `JXA script reads these but the parent never sets them: ${missing.join(", ")}`);
});

test("overlayEnv__CarriesPauseFile__When__Built", () => {
	// Named explicitly rather than left to the scrape: this is the one that was missing, and
	// a regression here silently un-fixes the banner rather than failing anything.
	assert.equal(overlayEnv("drive", "t", 1, "/tmp/go", "/tmp/pause").OVERLAY_PAUSE, "/tmp/pause");
});

// verificationTallies exists because the run log used to be assembled independently at each
// exit path, and the two drifted. Keeping the counts in one function is half the fix; the
// other half is that both paths now write through a single writer in agent.ts.

function step(verified: boolean, channel?: StepRecord["verificationChannel"]): StepRecord {
	return {
		index: 0,
		timestamp: "",
		action: { kind: "tool", name: "click", args: {} },
		expectation: { textIncludes: ["x"] },
		verified,
		...(channel ? { verificationChannel: channel } : {}),
	} as StepRecord;
}

test("verificationTallies__SplitsByChannel__When__StepsUsedDifferentEvidence", () => {
	// Never summed into one number: a run carried by pixels must not read like one proven
	// by text. The split is the whole point of tracking a channel per step.
	const t = verificationTallies([step(true, "text"), step(true, "pixel"), step(true, "geometry"), step(false)]);
	assert.equal(t.verifiedSteps, 3);
	assert.equal(t.unverifiedSteps, 1);
	assert.deepEqual(t.verifiedByChannel, { text: 1, geometry: 1, pixel: 1 });
});

test("verificationTallies__ReportsZeroes__When__RunRecordedNoSteps", () => {
	// The step-limit path can log a run with nothing verified; it must still produce the
	// same shape rather than omitting the fields.
	assert.deepEqual(verificationTallies([]), {
		verifiedSteps: 0,
		unverifiedSteps: 0,
		verifiedByChannel: { text: 0, geometry: 0, pixel: 0 },
	});
});

// unpaintedStreak: the dead-window detector. Its whole safety argument is that it can only
// ever abort, so these pin the two ways the streak must break.

function paintStep(verified: boolean, pixelDelta?: number): StepRecord {
	return { ...step(verified), pixelDelta } as StepRecord;
}

test("unpaintedStreak__CountsEveryStep__When__NothingVerifiedAndNothingRepainted", () => {
	// The exact signature of the two frozen Notion runs: 0.0% on every step, nothing verified.
	assert.equal(unpaintedStreak([0, 0, 0, 0].map((d) => paintStep(false, d))), 4);
});

test("unpaintedStreak__Resets__When__AStepVerified", () => {
	// A verified step proves the app is alive even if it did not repaint, so a real run
	// can never be aborted by this.
	const steps = [paintStep(false, 0), paintStep(true, 0), paintStep(false, 0)];
	assert.equal(unpaintedStreak(steps), 1);
});

test("unpaintedStreak__Resets__When__PixelsMoved", () => {
	assert.equal(unpaintedStreak([paintStep(false, 0), paintStep(false, 0.4), paintStep(false, 0)]), 1);
});

test("unpaintedStreak__CountsNothing__When__DeltaIsUnknown", () => {
	// --no-vision captures no frames at all, so the delta is undefined every step. Absence
	// of evidence must not read as evidence of a frozen window.
	assert.equal(unpaintedStreak([paintStep(false), paintStep(false), paintStep(false)]), 0);
});

test("unpaintedStreak__CountsFromTheEnd__When__TheFreezeStartedMidRun", () => {
	const steps = [paintStep(true, 0.5), paintStep(false, 0.2), paintStep(false, 0), paintStep(false, 0)];
	assert.equal(unpaintedStreak(steps), 2);
});
