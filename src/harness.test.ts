import assert from "node:assert/strict";
import { test } from "node:test";
import { auditTaskPrompt, verify } from "./harness.js";

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
