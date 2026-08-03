import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import {
	auditTaskPrompt,
	checkableCount,
	framesShifted,
	pixelDelta,
	unpaintedStreak,
	verificationTallies,
	verify,
} from "../src/core/harness.js";
import type { StepRecord } from "../src/types.js";

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
	// One mechanic verb is usually phrasing, not a procedure; two or more is a dictated path.
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
	// A complete method procedure spelling "click" four times is four hints, not one — deduping
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

test("auditTaskPrompt__Refuses__When__ThePromptEnumeratesARoute", () => {
	// Where a control LIVES is method knowledge — exactly what the appmap is a declared,
	// budgeted input FOR. The gate had no pattern for it, and the hole was live: the only run of
	// Yarn's real product flow said "Create a new draft, then open the Script tab and write a
	// two-scene script… then set the voice to Cassidy" and recorded hintedPrompt: false. No
	// driver vocab, no AX role, no keystroke, no coordinate, and "open" was in no verb set.
	const coffee =
		"Create a new draft, then open the Script tab and write a two-scene script introducing a coffee ordering app called Brew, then set the voice to Cassidy.";
	const a = auditTaskPrompt(coffee);
	assert.equal(a.hinted, true, "a dictated route must be refused");
	assert.match(a.reasons.join(" "), /enumerates a route/);
});

test("auditTaskPrompt__Accepts__When__ReachingASurfaceIsItselfTheGoal", () => {
	// The counterweight, and the reason navigation is not a one-strike rule. "show me how to
	// open the Script tab" names a surface, but reaching it IS the goal — refusing that would
	// ban the task class the demo product exists to perform. One directive is tolerated exactly
	// as one incidental "click" is; a ROUTE (two or more chained steps) is what trips the gate.
	assert.equal(auditTaskPrompt("show me how to open the Script tab").hinted, false);
	assert.equal(auditTaskPrompt("Make a two-scene video script for a coffee ordering app called Brew, narrated by Cassidy.").hinted, false);
	// And the two tasks the entire matrix ran on must still pass.
	assert.equal(auditTaskPrompt("show me how to change the cursor type").hinted, false);
	assert.equal(auditTaskPrompt("show me how to change the motion blur").hinted, false);
});
