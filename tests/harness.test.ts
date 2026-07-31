import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { test } from "node:test";
import { Driver } from "../src/core/driver.js";
import {
	auditTaskPrompt,
	checkableCount,
	checkHome,
	actionTarget,
	destructiveTarget,
	externalityTarget,
	gatedId,
	gatedSection,
	reversibleTarget,
	failedProvider,
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
	refSurfaces,
	MAX_WAIT_MS,
	mergeGraph,
	newFrontier,
	observationBlocks,
	onInterrupt,
	observe,
	pixelDelta,
	providerRouting,
	recoverLeakedGraph,
	resetToHome,
	retryTransient,
	rootControlLabels,
	rootSurface,
	runKey,
	scopeWarnings,
	screenIsLocked,
	settleMsFor,
	TargetNotObservableError,
	toActionRequest,
	unpaintedStreak,
	verificationTallies,
	verify,
} from "../src/core/harness.js";
import type { InteractiveElement, ObservationBundle } from "../src/core/harness.js";
import type { ActionRequest, AppMap, AppMapEdge, AppMapNode, StepRecord } from "../src/types.js";
import { bestClass, descriptorFor, lookup, sidecarStatus } from "../src/core/axdom.js";
import { overlayEnv, scriptEnvKeys } from "../src/core/overlay.js";

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
	// Three distinct hint kinds here: the mechanic verbs (click, press), the keystroke (cmd+a),
	// and the driver-internal name (set_value). Each is reported separately.
	const audit = auditTaskPrompt("Fix the title: click it, press cmd+a, then use set_value to write Hello");
	assert.equal(audit.hinted, true);
	assert.equal(audit.reasons.length, 3);
});

test("auditTaskPrompt__Flags__When__DictatedClickPathRepeatsOneVerb", () => {
	// A complete method recipe spelling "click" four times is four hints, not one — deduping
	// them before the threshold used to pass this as goal-only.
	const audit = auditTaskPrompt("Click Brand Kit, click Screen Clips, click Cursor Style, click Pointer-first");
	assert.equal(audit.hinted, true);
	assert.match(audit.reasons.join(" "), /interaction mechanics/);
});

test("auditTaskPrompt__Flags__When__PromptHandsOverACmdKeystrokeGlyph", () => {
	// `⌘` is a non-word char, so it was dead inside the boundary-anchored verb group and a
	// prompt naming the exact shortcut slipped through with zero hits.
	const audit = auditTaskPrompt("Open settings with the keyboard shortcut ⌘+,");
	assert.equal(audit.hinted, true);
	assert.match(audit.reasons.join(" "), /keystroke/);
});

test("auditTaskPrompt__Flags__When__DriverNameIsCapitalised", () => {
	assert.equal(auditTaskPrompt("use Set_Value on the notes field").hinted, true);
});

test("auditTaskPrompt__Passes__When__GoalContainsClickableOrPressure", () => {
	// Both words embed a mechanic verb but describe an outcome; bounding the verbs on both
	// sides stops them refusing a legitimate goal-only prompt.
	assert.equal(auditTaskPrompt("Make the header clickable and fix the pressure warning").hinted, false);
});

test("auditTaskPrompt__Allows__When__TaskNamesAnAxis", () => {
	// Under /i the ax- prefix read ordinary words as driver internals and hard-refused
	// goal-only prompts — and a video tool WILL see "axis" in a legitimate goal.
	for (const task of ["Flip the clip on its vertical axis", "Rotate both axes of the chart"])
		assert.equal(auditTaskPrompt(task).hinted, false, task);
});

test("auditTaskPrompt__Flags__When__TaskNamesAnAXRole", () => {
	// Real AX role names carry their case; the case-sensitive pattern keeps them flagged.
	const audit = auditTaskPrompt("Open the toolbar and pick the AXButton next to the title");
	assert.equal(audit.hinted, true);
	assert.match(audit.reasons.join(" "), /driver\/AX internals/);
});

// verify(): historical run logs showed 2-6 steps per run "verified" by expectations
// that checked nothing, so an empty expectation must now FAIL, and a satisfied check
// must discriminate pre-action state from post-action state.

test("verify__Fails__When__TextIncludesIsBlank", () => {
	// Every string contains "" and every screen contains " ", so a blank check passes the
	// presence test against ANY observation. On the done path there is no prevHaystack to catch
	// it, which made done(success, evidence:{textIncludes:[""]}) accepted anywhere. Blanks are
	// dropped, then a check with nothing left fails as uncheckable.
	for (const blank of ["", " ", "\t"]) {
		const result = verify({ description: "", textIncludes: [blank] }, "a totally unrelated screen");
		assert.equal(result.verified, false, JSON.stringify(blank));
		assert.match(result.note, /no checkable expectation/);
	}
});

test("verify__IgnoresBlankSubstrings__When__MixedWithRealOnes", () => {
	// A real include alongside a blank must still be checked as if the blank were not there.
	assert.equal(verify({ description: "", textIncludes: ["", "paris"] }, "timezone: paris").verified, true);
	assert.equal(verify({ description: "", textIncludes: ["", "paris"] }, "timezone: new york").verified, false);
});

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

test("verify__RejectsExcludesOnlyEvidence__When__ThereIsNoPriorHaystack", () => {
	// With no prevHaystack the discrimination guard never runs, so an exclude naming a string
	// that was never on ANY screen used to verify against every final observation — the
	// excludes-only twin of the blank-substring hole. done() passes no prev; this is its gate.
	const result = verify({ description: "", textExcludes: ["flurble"] }, "a totally unrelated screen");
	assert.equal(result.verified, false);
	assert.match(result.note, /excludes-only/);
});

test("verify__AcceptsExcludesOnlyEvidence__When__PriorHaystackMakesItDiscriminating", () => {
	// The act path always passes prev, and there an exclude proves a change: present before,
	// gone now. The done-boundary gate must key on the MISSING prev, not on excludes-only.
	const result = verify({ description: "", textExcludes: ["Loading"] }, "library view", "loading your drafts");
	assert.equal(result.verified, true);
	assert.equal(result.channel, "text");
});

test("checkableCount__ReturnsZero__When__IncludesIsNotAnArray", () => {
	// Tool input is model output and OpenRouter does not enforce schemas; a malformed call
	// must read as "nothing checkable" and cost a turn, not throw out of the gate.
	for (const bad of ["Paris", 42, { 0: "x" }, null])
		assert.equal(checkableCount({ description: "", textIncludes: bad as unknown as string[] }), 0, String(bad));
});

test("verify__DoesNotThrow__When__EvidenceEntriesAreNumbers", () => {
	// Non-string entries are dropped, the real one still checks.
	const result = verify(
		{ description: "", textIncludes: [1080, "paris"] as unknown as string[] },
		"timezone: paris",
		"timezone: new york",
	);
	assert.equal(result.verified, true);
	// All-malformed leaves nothing checkable, which is the same failure an empty list gets.
	const allBad = verify({ description: "", textIncludes: [1, 2] as unknown as string[] }, "anything");
	assert.equal(allBad.verified, false);
	assert.match(allBad.note, /no checkable expectation/);
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

test("framesShifted__ReportsMover__When__DisplayScaleHalvesTheDelta", () => {
	// Frames are logical points and drags are screenshot pixels: at 2x backing scale — the
	// common macOS case — an honest mover sits at EXACTLY half the requested distance, and a
	// strict > 0.5 bound rejected it on every Retina display.
	const r = framesShifted(at([["Clip", 500, 0]]), at([["Clip", 550, 0]]), 100, 0);
	assert.equal(r.shifted, true);
	assert.deepEqual(r.movers.map((m) => m.name), ["Clip"]);
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

test("scopeWarnings__CountsScopesNotNodes__When__ASettingHasTwoSameScopeEditors", () => {
	// Two editors of one setting on the same document surface are ONE store and one bullet;
	// counting nodes said "exist at 3 scopes" for a two-store setting and printed the same
	// scope—surface line twice.
	const twoEditors: AppMap = {
		...yarnish,
		nodes: [
			...yarnish.nodes,
			{ id: "editor/screen-clip-settings/cursor-style-quick", title: "Cursor Style (quick)", kind: "control", scope: "document", settingKey: "cursor-style" },
		],
	};
	const w = scopeWarnings(twoEditors);
	assert.match(w, /exist at 2 scopes/);
	assert.equal(w.match(/document scope — editor\/screen-clip-settings/g)?.length, 1, "duplicate scope—surface bullets must dedupe");
});

test("scopeWarnings__ReturnsEmpty__When__NoAmbiguities", () => {
	assert.equal(scopeWarnings({ ...yarnish, nodes: [yarnish.nodes[3]] }), "");
});

// --- Landing surface. Used to answer "is this app usable right now, or sitting at a login
// wall" for any app with a map — the weaker of resetToHome's two tiers, and the one that does
// not need the appmap to declare a home. It never decides where to click.

/** yarnish plus the surfaces an exploration pass records around its starting point. */
const rooted: AppMap = {
	...yarnish,
	nodes: [
		...yarnish.nodes,
		{ id: "root", title: "Yarn", kind: "surface", scope: "app" },
		{ id: "library", title: "Library", kind: "surface", scope: "workspace" },
	],
	edges: [
		...yarnish.edges,
		{ from: "root", to: "library", action: 'click "Library" in the left rail' },
		{ from: "library", to: "editor", action: 'double-click a draft row' },
	],
};

test("rootSurface__FindsStartingPoint__When__OneSurfaceIsNeverAnEdgeTarget", () => {
	// Structural, not a lookup for an id called "root": that spelling is a convention of one
	// exploration pass rather than part of the schema.
	assert.equal(rootSurface(rooted)?.id, "root");
});

test("rootSurface__ReturnsUndefined__When__SeveralSurfacesQualify", () => {
	// A disconnected graph has no single landing state, and picking between candidates would
	// silently pin every future run's start to whichever one sorted first.
	const split: AppMap = { ...rooted, nodes: [...rooted.nodes, { id: "orphan", title: "Orphan", kind: "surface", scope: "app" }] };
	assert.equal(rootSurface(split), undefined);
});

test("rootSurface__ReturnsUndefined__When__EverySurfaceIsReachable", () => {
	const cyclic: AppMap = { ...rooted, edges: [...rooted.edges, { from: "library", to: "root", action: 'click "Home"' }] };
	assert.equal(rootSurface(cyclic), undefined);
});

test("rootControlLabels__QuotesFromOutboundEdges__When__RootIsIdentifiable", () => {
	// The quoted span in an edge action is the label the walk actually observed, so it is the
	// one string in the graph that can be matched against a live observation.
	assert.deepEqual(rootControlLabels(rooted), ["Brand Kit", "Library"]);
});

test("rootControlLabels__IgnoresEdgesLeavingOtherSurfaces__When__CollectingLabels", () => {
	// A label only proves the app is on its landing surface if it LIVES there; a control reached
	// two screens in would report "ready" from wherever the last run happened to stop.
	const deeper: AppMap = { ...rooted, edges: [...rooted.edges, { from: "library", to: "editor", action: 'click "Rename"' }] };
	assert.equal(rootControlLabels(deeper).includes("Rename"), false);
});

test("rootControlLabels__Dedupes__When__TheSameControlAppearsOnSeveralEdges", () => {
	const twice: AppMap = { ...rooted, edges: [...rooted.edges, { from: "root", to: "library", action: 'click "Library" again' }] };
	assert.deepEqual(twice.edges.filter((e) => e.action.includes("Library")).length, 2);
	assert.deepEqual(rootControlLabels(twice), ["Brand Kit", "Library"]);
});

test("rootControlLabels__ReturnsEmpty__When__NoRootCanBeIdentified", () => {
	assert.deepEqual(rootControlLabels(yarnish), []);
});

// --- checkHome(). The declared home is written once by an exploration pass and then governs
// the start state of every later run, with nothing downstream able to tell a wrong label from
// an app that genuinely moved on. So it is checked against the pass's own evidence at write
// time, and discarded rather than trusted — losing normalisation, keeping the readiness check.

const HOME = { surface: "library", control: "Library", description: "left-rail Library view" };

test("checkHome__Accepts__When__SurfaceIsANodeAndControlWasOperated", () => {
	assert.deepEqual(checkHome(HOME, rooted.nodes, rooted.edges), { home: HOME });
});

test("checkHome__Rejects__When__SurfaceIsNotInTheGraph", () => {
	const { home, problem } = checkHome({ ...HOME, surface: "dashboard" }, rooted.nodes, rooted.edges);
	assert.equal(home, undefined);
	assert.match(problem ?? "", /"dashboard" is not a node/);
});

test("checkHome__Rejects__When__NoEdgeActionEverQuotedTheControl", () => {
	// The realistic failure: a plausible label recalled at the end of a long, context-reset
	// transcript rather than read off an observation.
	const { home, problem } = checkHome({ ...HOME, control: "Home" }, rooted.nodes, rooted.edges);
	assert.equal(home, undefined);
	assert.match(problem ?? "", /never recorded operating it/);
});

test("checkHome__Rejects__When__FieldsAreBlank", () => {
	assert.match(checkHome({ ...HOME, control: "  " }, rooted.nodes, rooted.edges).problem ?? "", /both required/);
});

test("checkHome__StaysSilent__When__ThePassDeclaredNoHome", () => {
	// Not an error. Older maps have no home at all, and resetToHome degrades to `root-visible`.
	assert.deepEqual(checkHome(undefined, rooted.nodes, rooted.edges), {});
});

// --no-vision A/B arm: the text block must be identical across arms so the only
// difference the model sees is the presence of the image.

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

test("observationBlocks__OmitsElements__When__AxDisabled", () => {
	// The vision-only arm: the model loses the element list but keeps the screenshot and the
	// window title. The bundle itself is untouched — verify()/journal/teardown still read it.
	const blocks = observationBlocks(bundle, true, false);
	assert.equal(blocks.length, 2);
	assert.equal(blocks[0].type, "text");
	const text = (blocks[0] as { text: string }).text;
	assert.match(text, /Settings/);
	assert.doesNotMatch(text, /AXButton/);
	assert.doesNotMatch(text, /Save/);
	assert.equal(blocks[1].type, "image");
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

// --- sidecarStatus(). collect() swallows every one of these so a run can proceed without
// enrichment; the price is that a host with no sidecar is indistinguishable from a healthy one.
// On the fleet the binary is an rsync'd build artifact, so "never built" is a real state — all
// three Macs happened to have it, from whichever checkout provisioned them.

test("sidecarStatus__ReportsNotBuilt__When__TheBinaryIsAbsent", () => {
	const s = sidecarStatus(`${os.tmpdir()}/definitely-not-here-axdom`, () => {
		throw new Error("must not be executed");
	});
	assert.equal(s.usable, false);
	assert.match(s.problem ?? "", /build:native/);
});

test("sidecarStatus__ReportsUsable__When__ItRunsAndExitsWithUsage", () => {
	// No arguments means usage and exit 2, so execFileSync throws with a numeric status. That
	// throw is the success signal: a process that reported an exit code is a process that ran.
	const s = sidecarStatus(existingFile(), () => {
		throw Object.assign(new Error("Command failed"), { status: 2 });
	});
	assert.equal(s.usable, true);
	assert.equal(s.problem, undefined);
});

test("sidecarStatus__ReportsWrongArchitecture__When__TheBinaryCannotSpawn", () => {
	// The case a stat or an `ls` cannot see: the file is right there and this machine cannot
	// execute it. Provisioning from an Intel checkout onto arm64 Macs produces exactly this.
	const s = sidecarStatus(existingFile(), () => {
		throw Object.assign(new Error("spawnSync ENOEXEC"), { code: "ENOEXEC" });
	});
	assert.equal(s.usable, false);
	assert.match(s.problem ?? "", /ENOEXEC/);
	assert.match(s.problem ?? "", /architecture/);
});

test("sidecarStatus__SaysItIsSwitchedOff__When__AxdomIsZero", () => {
	// Distinct from broken: someone chose this, and doctor should not send them hunting for a
	// build problem that does not exist.
	const prev = process.env.AXDOM;
	process.env.AXDOM = "0";
	try {
		const s = sidecarStatus(existingFile(), () => {});
		assert.equal(s.usable, false);
		assert.match(s.problem ?? "", /AXDOM=0/);
	} finally {
		if (prev === undefined) delete process.env.AXDOM;
		else process.env.AXDOM = prev;
	}
});

/** Any real path will do — these tests are about the probe's outcome, not the file's contents. */
function existingFile(): string {
	return new URL(import.meta.url).pathname;
}

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

const observeFixture = async (elements: unknown[], opts: { webAreaOnly?: boolean } = {}): Promise<ObservationBundle> => {
	const shot = `${process.cwd()}/out/test-observe.png`;
	const prev = process.env.AXDOM;
	process.env.AXDOM = "0"; // the sidecar needs a live app; this test is about the join-free path
	try {
		return await observe(fakeDriver({ elements, screenshot_width: 1568, screenshot_height: 882 }, shot), { pid: 1, windowId: 1 }, "test-observe", opts);
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

test("observe__KeepsTheTrueValue__When__ValueDuplicatesTheLabel", async () => {
	// The rendered line suppresses a value that repeats the label; the STRUCT must not. The
	// mutation journal restores from this field, and a text field whose content equals its
	// label used to reach it as before:"" — teardown then "restored" a field that had text
	// by clearing it.
	const obs = await observeFixture([
		axWindow,
		{ element_index: 1, role: "AXTextField", label: "Untitled", value: "Untitled", parent_index: 0, frame: { x: -2181, y: 763, w: 100, h: 20 } },
	]);
	assert.equal(obs.interactive[0].value, "Untitled");
	assert.doesNotMatch(obs.elementsText, /value="Untitled"/);
});

// --- resetToHome(). Two tiers, because the strong one needs a map that declares a home and the
// weak one has to work for every app that does not. The weak tier normalises nothing; it only
// answers "can the app's own landing state be seen", which is what catches a sign-in wall
// without this file knowing what a sign-in wall looks like.

/** Serves one AX payload per observation, in order, and records every act for inspection. */
const scriptedDriver = (screens: unknown[][], acts: ActionRequest[]): Driver => {
	let shown = 0;

	return {
		act: async (req: ActionRequest) => {
			acts.push(req);
			if (req.kind !== "tool" || req.name !== "get_window_state") return { text: "" };
			// Write the file observe() will actually look for. The driver names the screenshot
			// from its own argument, so a fixture writing some other path only passed here
			// because a real run had left a same-named PNG in out/ — these tests failed on any
			// clean checkout, and passed locally for a reason unrelated to what they assert.
			const shot = String((req.args as Record<string, unknown>).screenshot_out_file);
			fs.mkdirSync(shot.replace(/\/[^/]+$/, ""), { recursive: true });
			fs.writeFileSync(shot, "png");
			const elements = screens[Math.min(shown++, screens.length - 1)];

			return { text: "", structuredJson: JSON.stringify({ elements, screenshot_width: 1920, screenshot_height: 1080 }) };
		},
	} as unknown as Driver;
};

const railButton = (label: string) => [
	{ element_index: 0, role: "AXWindow", label: "", frame: { x: 0, y: 0, w: 1920, h: 1080 } },
	{ element_index: 7, role: "AXButton", label, parent_index: 0, frame: { x: 20, y: 100, w: 160, h: 40 } },
];

const withHome: AppMap = { ...rooted, home: HOME };

/**
 * The graph is passed explicitly in all but one case. Omitting it is not the same as passing
 * `undefined` — the parameter defaults to loading the app's real appmap off disk, which is the
 * production path and the only way to test the no-map branch honestly.
 */
const resetIn = async (screens: unknown[][], graph?: AppMap, app = "Yarn") => {
	const acts: ActionRequest[] = [];
	const driver = scriptedDriver(screens, acts);
	const win = { pid: 1, windowId: 1 };
	const prev = process.env.AXDOM;
	process.env.AXDOM = "0"; // the sidecar needs a live app
	try {
		const r = graph ? await resetToHome(driver, win, app, graph) : await resetToHome(driver, win, app);

		return { ...r, acts };
	} finally {
		if (prev === undefined) delete process.env.AXDOM;
		else process.env.AXDOM = prev;
	}
};

test("resetToHome__ClicksTheDeclaredControl__When__TheMapNamesAHome", async () => {
	const { result, detail, acts } = await resetIn([railButton("Library")], withHome);
	assert.equal(result, "reset");
	assert.match(detail, /left-rail Library view/);
	// By element index parsed out of the observation, not by coordinate: the index is the only
	// addressing that survives the window being on a differently-scaled display.
	const click = acts.find((a) => a.kind === "tool" && a.name === "click");
	assert.deepEqual((click as { args: Record<string, unknown> }).args.element_index, 7);
});

test("resetToHome__ReportsRootVisible__When__TheMapHasNoHomeButItsLandingControlsShow", async () => {
	// Deliberately NOT "reset": one of root's controls being on screen proves the app is past
	// its login wall, and proves nothing at all about which surface the run will start on.
	const { result, detail, acts } = await resetIn([railButton("Brand Kit")], rooted);
	assert.equal(result, "root-visible");
	assert.match(detail, /not normalised/);
	assert.equal(acts.some((a) => a.kind === "tool" && a.name === "click"), false);
});

test("resetToHome__Fails__When__NothingFromTheLandingSurfaceIsOnScreen", async () => {
	// What a sign-in wall looks like from here. agent.ts turns this into a refusal to run,
	// which before #28 only fired for the two apps that happened to be in a hardcoded table.
	const { result, detail, acts } = await resetIn([railButton("Sign in with Google")], rooted);
	assert.equal(result, "failed");
	assert.match(detail, /nothing from the landing surface/);
	// One escape first: an overlay left open by a previous run hides the rail from the AX tree
	// entirely, and that used to read as "app is unusable".
	assert.equal(acts.filter((a) => a.kind === "tool" && a.name === "press_key").length, 1);
});

test("resetToHome__RecoversAfterEscape__When__AnOverlayHidTheHomeControl", async () => {
	const { result, detail } = await resetIn([railButton("Cancel"), railButton("Library")], withHome);
	assert.equal(result, "reset");
	assert.match(detail, /escaped a leftover overlay/);
});

test("resetToHome__ReportsNone__When__TheAppHasNoMapAtAll", async () => {
	const { result, detail, acts } = await resetIn([railButton("Library")], undefined, "No Such App");
	assert.equal(result, "none");
	assert.match(detail, /npm run explore/);
	assert.deepEqual(acts, [], "an app with no map is not probed at all");
});

test("resetToHome__ReportsNone__When__TheMapHasNoHomeAndNoIdentifiableRoot", async () => {
	// yarnish's only surface is an edge target, so there is no landing state to look for.
	assert.equal((await resetIn([railButton("Library")], yarnish)).result, "none");
});

// --- frontier ledger: the mechanical answer to "did the pass map the whole app?". Its
// predecessor was the model auditing its own coverage from a transcript that, by
// construction, contains only the surfaces it visited. These tests pin the two credit paths
// (handle and coordinate), the dismissal escape hatch, and the guards that stop one click
// from draining a panel it never touched.

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

// --- routing around a broken upstream. OpenRouter fans one model id out to several hosts, so a
// failure can belong to the route rather than to the request. Five consecutive 404
// DeploymentNotFound burned a run while the same key got 200s seconds later.

test("failedProvider__NamesTheUpstream__When__TheRouterAttributesTheError", () => {
	const err = { error: { error: { metadata: { provider_name: "Azure" } } } };
	assert.equal(failedProvider(err), "Azure");
});

test("failedProvider__NamesTheUpstream__When__ItOnlySurvivesInTheMessage", () => {
	// The SDK stringifies the body into the message for some error classes; that is the only
	// copy left by the time it reaches the catch.
	const err = new Error(`404 {"error":{"metadata":{"provider_name":"Google Vertex"}}}`);
	assert.equal(failedProvider(err), "Google Vertex");
});

test("failedProvider__ReturnsUndefined__When__NothingIsAttributed", () => {
	assert.equal(failedProvider(new Error("terminated")), undefined);
	assert.equal(failedProvider(undefined), undefined);
	assert.equal(failedProvider({ error: { error: { metadata: { provider_name: "  " } } } }), undefined);
});

test("isTransientApiError__ReturnsTrue__When__AProviderIsNamed", () => {
	// Not a general claim about 404s — a 404 from OUR request stays fatal. It is specific to a
	// router: if the upstream named itself, a different upstream may well answer.
	const err = Object.assign(new Error("no deployment"), { status: 404, error: { error: { metadata: { provider_name: "Azure" } } } });
	assert.equal(isTransientApiError(err), true);
	assert.equal(isTransientApiError(Object.assign(new Error("no such model"), { status: 404 })), false);
});

test("providerRouting__SendsNothing__When__NoProviderHasFailed", () => {
	// An empty ignore list must not appear in the body at all: it would pin routing decisions
	// for every healthy run, which is the overwhelming majority of them.
	assert.deepEqual(providerRouting([]), {});
});

test("providerRouting__ListsEachProviderOnce__When__OneFailedRepeatedly", () => {
	assert.deepEqual(providerRouting(["Azure", "Azure", "Fireworks"]), { provider: { ignore: ["Azure", "Fireworks"] } });
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

test("onInterrupt__CancelsTheGraceBackstop__When__TheCheckerAcknowledgesTheSignal", async () => {
	// The backstop exists for a signal nothing polls. Once the loop has READ the flag it owns
	// cleanup — which legitimately outlives the grace window (ffmpeg assembly alone can) — so
	// the timer must stand down, or it force-kills the run mid-cleanup and destroys the run
	// log the function exists to preserve.
	const beforeInt = process.listeners("SIGINT");
	const beforeTerm = process.listeners("SIGTERM");
	let closed = 0;
	const log = console.log; // the handler prints banners; keep the child-IPC channel quiet
	console.log = () => {};
	try {
		const check = onInterrupt(async () => {
			closed++;
			// Never resolves: even a regression cannot reach the process.exit in the timer's
			// .finally and kill the test runner — the count above is the failure signal.
			await new Promise<void>(() => {});
		}, 30);
		const added = process.listeners("SIGINT").filter((l) => !beforeInt.includes(l));
		assert.equal(added.length, 1);
		(added[0] as () => void)(); // the signal arrives; the backstop is armed
		assert.equal(check(), true); // the loop reads the flag — cleanup is its responsibility now
		await new Promise((r) => setTimeout(r, 120)); // well past graceMs
		assert.equal(closed, 0, "the backstop fired despite the acknowledgement");
	} finally {
		console.log = log;
		for (const l of process.listeners("SIGINT")) if (!beforeInt.includes(l)) process.removeListener("SIGINT", l);
		for (const l of process.listeners("SIGTERM")) if (!beforeTerm.includes(l)) process.removeListener("SIGTERM", l);
	}
});

function withRunStamp(value: string | undefined, fn: () => void): void {
	const prev = process.env.RUN_STAMP;
	if (value === undefined) delete process.env.RUN_STAMP;
	else process.env.RUN_STAMP = value;
	try {
		fn();
	} finally {
		if (prev === undefined) delete process.env.RUN_STAMP;
		else process.env.RUN_STAMP = prev;
	}
}

test("runKey__MintsTimestampedSlug__When__NoStampIsSupplied", () => {
	withRunStamp(undefined, () => {
		// out/runs/<key>.json is read by name elsewhere, so the format is a compatibility
		// surface — but it carries MILLISECONDS now: two runs started in the same second (a
		// runner dispatching several jobs) otherwise mint one key and clobber each other.
		assert.match(runKey("", "Notion Calendar"), /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}(-\d+)?-notion-calendar$/);
		assert.match(runKey("explore-", "Yarn"), /^explore-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}(-\d+)?-yarn$/);
	});
});

test("runKey__UsesTheSuppliedStamp__When__RunStampIsSet", () => {
	// A dispatcher pre-commits to the key so it knows which artifacts its child will write,
	// rather than guessing at "newest file in out/runs" after the fact.
	withRunStamp("2026-07-30T09-00-00-yarn", () => {
		assert.equal(runKey("", "Yarn"), "2026-07-30T09-00-00-yarn");
		// The prefix is the caller's convention, not part of the contract: an explicit key
		// wins whole, or the two sides could disagree about where the artifacts landed.
		assert.equal(runKey("explore-", "Yarn"), "2026-07-30T09-00-00-yarn");
	});
});

test("runKey__MintsFreshKey__When__RunStampIsBlank", () => {
	// launchd and `ssh host env RUN_STAMP=` both hand down empty strings for unset vars.
	withRunStamp("   ", () => {
		assert.match(runKey("", "Yarn"), /-yarn$/);
		assert.notEqual(runKey("", "Yarn"), "   ");
	});
});

// TargetNotObservableError: one symptom, two causes. Until 2026-07-30 the class asserted the
// wrong one unconditionally, and two Macs with locked screens were read as a Spaces problem
// and answered with a relaunch that could not possibly have helped. These pin the split.

test("TargetNotObservableError__NamesTheLockScreen__When__TheDisplayIsLocked", () => {
	const msg = new TargetNotObservableError("Yarn", "1974 AX elements, none of them app content", true).message;
	assert.match(msg, /THE SCREEN IS LOCKED/);
	// The operator must be sent to the unlock, not to a Space. Naming Spaces here is the
	// regression itself: it is advice that cannot work on a locked machine.
	assert.doesNotMatch(msg, /Space/);
	assert.match(msg, /\.\/run signin/);
});

test("TargetNotObservableError__KeepsTheSpacesGuidance__When__TheDisplayIsUnlocked", () => {
	// Still the right answer for the other cause, and it must say the screen is unlocked so
	// the reader knows the lock was checked rather than never considered.
	const msg = new TargetNotObservableError("Yarn", "3 AX elements, none of them app content", false).message;
	assert.match(msg, /inactive\s+macOS Space/);
	assert.match(msg, /screen is unlocked/);
	assert.doesNotMatch(msg, /LOCKED/);
});

test("TargetNotObservableError__AssumesUnlocked__When__NoLockStateIsPassed", () => {
	// The default must be the message that merely misdirects, never the one that asserts a
	// lock: telling someone to unlock an already-unlocked Mac is an unanswerable instruction.
	assert.doesNotMatch(new TargetNotObservableError("Yarn", "no content").message, /LOCKED/);
});

test("screenIsLocked__ReturnsABoolean__When__AskedOnThisMachine", () => {
	// Deliberately not asserting WHICH: this test runs on developer laptops and colo Macs
	// alike. What matters is that it answers instead of throwing — it is called from inside
	// an error path and from ensureObservable's catch, where a throw would replace a real
	// diagnosis with a diagnostic's own failure.
	assert.equal(typeof screenIsLocked(), "boolean");
});

// resetToHome's failure detail. "home control X not present" is true and unactionable: a
// sign-in wall, a leftover modal and a different view all produce it, and the operator's next
// move differs for each. These pin the census that tells them apart — without teaching the
// harness what any of those screens look like, which would be app-specific.

const homeGraph: AppMap = {
	app: "Anything",
	capturedAt: "2026-07-30T00:00:00Z",
	provenance: "explore",
	home: { surface: "landing", control: "Library", description: "the library view" },
	nodes: [{ id: "landing", label: "Landing", scope: "app", controls: [] }] as unknown as AppMapNode[],
	edges: [{ from: "landing", to: "landing", action: 'click "Library"' }] as unknown as AppMapEdge[],
};

/** A driver that answers every observation with one fixed element list. */
function driverShowing(elements: { role: string; label: string }[]): Driver {
	// `label` is the driver's key for an element's name — `name` is what the parsed
	// InteractiveElement calls it, and using that here silently produced unnamed controls.
	const payload = JSON.stringify({
		elements: elements.map((e, i) => ({ element_index: i, role: e.role, label: e.label, enabled: true })),
	});

	return {
		act: async (req: ActionRequest) => {
			// Write the PNG observe() looks for, keyed off the driver's own argument. Without
			// this the fixture passed only because a real run had left a same-named file in out/;
			// observe() now deletes any stale frame before capture, so the mock must produce one.
			const shot = req.kind === "tool" ? (req.args as Record<string, unknown>).screenshot_out_file : undefined;
			if (typeof shot === "string") {
				fs.mkdirSync(shot.replace(/\/[^/]+$/, ""), { recursive: true });
				fs.writeFileSync(shot, "png");
			}

			return { text: "", structuredJson: payload };
		},
	} as unknown as Driver;
}

test("resetToHome__NamesWhatIsOnScreen__When__TheHomeControlIsMissing", async () => {
	const driver = driverShowing([
		{ role: "AXTextField", label: "Email" },
		{ role: "AXButton", label: "Continue with Google" },
	]);
	const out = await resetToHome(driver, { pid: 1, windowId: 2 }, "Anything", homeGraph);
	assert.equal(out.result, "failed");
	assert.match(out.detail, /"Library" not present/);
	// The labels are the whole point: a reader recognises a sign-in wall from these, and the
	// harness never has to.
	assert.match(out.detail, /"Email"/);
	assert.match(out.detail, /"Continue with Google"/);
});

test("resetToHome__PutsAppControlsBeforeMenuItems__When__BothAreOnScreen", async () => {
	// Every Mac app exposes the same ~70 menu items. In walk order they arrive first and, on
	// the first real use of this census, buried the four labels that identified the screen.
	const driver = driverShowing([
		{ role: "AXMenuItem", label: "About This Mac" },
		{ role: "AXMenuItem", label: "System Settings…" },
		{ role: "AXButton", label: "Sign in with SSO" },
	]);
	const out = await resetToHome(driver, { pid: 1, windowId: 2 }, "Anything", homeGraph);
	assert.match(out.detail, /instead: "Sign in with SSO"/);
	// Kept, not dropped: an app whose only named controls are menu items is itself a finding.
	assert.match(out.detail, /"About This Mac"/);
});

test("resetToHome__SaysTheAppIsEmpty__When__ThereIsNoContentAtAll", async () => {
	// Distinct from "wrong screen" and pointing somewhere entirely different — this is the
	// locked-display / off-Space shape (LIMITATIONS §1, §12), not an app-state problem.
	const out = await resetToHome(driverShowing([]), { pid: 1, windowId: 2 }, "Anything", homeGraph);
	assert.match(out.detail, /NO content elements/);
});
/**
 * A Chrome window as AX reports it: browser furniture hanging off the window, and the page
 * itself nested under an AXWebArea. Deliberately nests the page button DEEP — real page
 * controls sit tens of levels below their web area, which is why the filter cannot borrow
 * ancestorOf's 12-hop bound.
 */
function chromeWindowElements(pageDepth = 30): unknown[] {
	const els: unknown[] = [
		axWindow,
		{ element_index: 1, role: "AXButton", label: "Reload", parent_index: 0, frame: { x: -2181, y: 763, w: 30, h: 30 } },
		{ element_index: 2, role: "AXTextField", label: "Address and search bar", parent_index: 0, frame: { x: -2100, y: 763, w: 800, h: 30 } },
		{ element_index: 3, role: "AXButton", label: "New Tab", parent_index: 0, frame: { x: -1200, y: 763, w: 30, h: 30 } },
		{ element_index: 4, role: "AXMenuItem", label: "Bookmarks", parent_index: 0, frame: { x: -2181, y: 740, w: 90, h: 20 } },
		{ element_index: 10, role: "AXWebArea", label: "", parent_index: 0, frame: { x: -2181, y: 800, w: 1920, h: 1000 } },
	];
	let parent = 10;
	for (let i = 0; i < pageDepth; i++) {
		els.push({ element_index: 100 + i, role: "AXGroup", label: "", parent_index: parent, frame: { x: -2181, y: 800, w: 1920, h: 1000 } });
		parent = 100 + i;
	}
	els.push({ element_index: 900, role: "AXButton", label: "Share page", parent_index: parent, frame: { x: -2000, y: 900, w: 100, h: 30 } });

	return els;
}

test("observe__KeepsBrowserChrome__When__WebAreaOnlyIsOff", async () => {
	// The default must be byte-identical to the Mac-app path: no existing caller opts in.
	const obs = await observeFixture(chromeWindowElements());
	assert.ok(obs.interactive.some((e) => e.name === "Reload"));
	assert.ok(obs.interactive.some((e) => e.name === "Share page"));
});

test("observe__DropsBrowserChromeFromTheFrontier__When__WebAreaOnly", async () => {
	// The tab strip, omnibox and Chrome's menu bar are perfectly good AXButtons. Left in the
	// frontier they dominate it, and the pass spends its dismiss budget on browser furniture
	// instead of the app it was pointed at.
	const obs = await observeFixture(chromeWindowElements(), { webAreaOnly: true });
	assert.deepEqual(obs.interactive.map((e) => e.name), ["Share page"]);
});

test("observe__KeepsDeeplyNestedPageControls__When__WebAreaOnly", async () => {
	// The bound must be the element count, not ancestorOf's 12: a page control 40 levels down
	// is ordinary, and dropping it would look like a site with almost no controls.
	const obs = await observeFixture(chromeWindowElements(40), { webAreaOnly: true });
	assert.deepEqual(obs.interactive.map((e) => e.name), ["Share page"]);
});

test("observe__StillListsBrowserChrome__When__WebAreaOnlyFiltersTheFrontier", async () => {
	// Filtering the frontier must not blind the model: if a page fails to load, the omnibox is
	// how it sees where it actually is.
	const obs = await observeFixture(chromeWindowElements(), { webAreaOnly: true });
	assert.match(obs.elementsText, /Address and search bar/);
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

test("observationBlocks__OmitsImageBlock__When__FrameWasNotCaptured", () => {
	// The DOM path degrades a missing screenshot to "" rather than throwing, so this is the
	// guard that stops that empty string reaching the API as a malformed image block — which
	// would fail the request and end the run, the very outcome the degradation prevents.
	const blocks = observationBlocks({ ...bundle, screenshotB64: "" }, true);
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].type, "text");
});
