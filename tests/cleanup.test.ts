import assert from "node:assert/strict";
import { test } from "node:test";
import { appForStamp, exitCodeFor, formatPlan, planRestores, stampArtifacts } from "../src/core/cleanup.js";
import type { Mutation } from "../src/core/journal.js";

// Synthetic fixtures describing the CLASS of journal rather than any historical run, so the
// tests stay meaningful as the canonical task changes.

const setting = (control: string, before: string | undefined, after: string, step: number): Mutation => ({
	kind: "setting",
	control,
	surface: "Screen Clip Settings",
	scope: "brand",
	before,
	after,
	step,
});

test("planRestores__OrdersNewestFirst__When__JournalHasSeveralSteps", () => {
	const plan = planRestores([
		setting("Cursor Style", "Arrow-first", "Pointer-first", 1),
		setting("Text Cursor", "Show", "Hide", 2),
	]);
	assert.deepEqual(plan.map((p) => p.mutation.control), ["Text Cursor", "Cursor Style"]);
});

test("planRestores__RestoresToOldestBefore__When__OneControlWasChangedTwice", () => {
	// The value the app needs back is the one it held before the run started, not the one it
	// held between the run's own two edits.
	const plan = planRestores([
		setting("Cursor Style", "Arrow-first", "Pointer-first", 1),
		setting("Cursor Style", "Pointer-first", "Hidden", 2),
	]);
	assert.equal(plan.length, 1);
	assert.equal(plan[0].wanted, "Arrow-first");
	assert.equal(plan[0].mutation.after, "Hidden");
});

test("planRestores__MarksUnrestorable__When__BeforeValueIsMissing", () => {
	const plan = planRestores([setting("Draft title", undefined, "demo-3", 1)]);
	assert.equal(plan[0].disposition, "unrestorable");
});

test("planRestores__MarksRestorable__When__BeforeValueIsEmptyString", () => {
	// "" and undefined are different facts, and only the second is unrestorable. A field the
	// run typed into is put back by CLEARING it; calling that unrestorable would leave the
	// agent's text sitting where the user had left nothing. restoreOne() draws the same line.
	const plan = planRestores([setting("Notes", "", "written", 1)]);
	assert.equal(plan[0].disposition, "restore");
	assert.equal(plan[0].wanted, "");
});

test("planRestores__KeepsResourceEntries__When__CollapseWouldDropThem", () => {
	// collapseJournal filters kind !== "setting"; recovering those is why this wrapper exists.
	const plan = planRestores([
		setting("Cursor Style", "Arrow-first", "Pointer-first", 1),
		{ kind: "resource", control: "", surface: "", resource: "scratch draft", step: 2 },
	]);
	assert.deepEqual(plan.map((p) => p.disposition), ["restore", "resource"]);
});

test("appForStamp__PrefersRunLogName__When__RunLogRecordedTheApp", () => {
	assert.equal(appForStamp("2026-07-30T03-00-00-notion-calendar", "Notion Calendar"), "Notion Calendar");
});

test("appForStamp__DeslugsStampSuffix__When__NoRunLogExists", () => {
	assert.equal(appForStamp("2026-07-30T03-00-00-notion-calendar"), "Notion Calendar");
	assert.equal(appForStamp("2026-07-30T03-00-00-yarn"), "Yarn");
});

test("appForStamp__PrefersOverride__When__AppFlagIsGiven", () => {
	// The case de-slugging cannot serve: capitalisation the slug does not carry.
	assert.equal(appForStamp("2026-07-30T03-00-00-iterm2", "iTerm2 Wrong", "iTerm2"), "iTerm2");
});

test("formatPlan__NamesUnrestorableControls__When__EntriesLackABefore", () => {
	const text = formatPlan(planRestores([setting("Draft title", undefined, "demo-3", 1)]));
	assert.match(text, /Draft title/);
	assert.match(text, /no prior value recorded/);
});

test("exitCodeFor__ReturnsZero__When__NothingWasAttempted", () => {
	assert.equal(exitCodeFor({ attempted: 0, failed: 0 }), 0);
});

test("exitCodeFor__ReturnsZero__When__EveryAttemptSucceeded", () => {
	assert.equal(exitCodeFor({ attempted: 3, failed: 0 }), 0);
});

test("exitCodeFor__ReturnsNonZero__When__AnAttemptFailed", () => {
	assert.equal(exitCodeFor({ attempted: 3, failed: 1 }), 1);
});

// --- the unknown-stamp guard. "Nothing to clean" is only truthful for a run that exists.

test("stampArtifacts__FindsRunLogAndJournal__When__StampIsExact", () => {
	const names = [
		"2026-07-30T20-54-28-yarn.json",
		"2026-07-30T20-54-28-yarn.journal.jsonl",
		"2026-07-30T21-00-00-yarn.json",
	];
	assert.deepEqual(stampArtifacts(names, "2026-07-30T20-54-28-yarn"), [
		"2026-07-30T20-54-28-yarn.json",
		"2026-07-30T20-54-28-yarn.journal.jsonl",
	]);
});

test("stampArtifacts__MatchesNothing__When__StampIsOnlyAPrefix", () => {
	// A truncated stamp or a job id names a DIFFERENT run (or none). Matching it by prefix
	// would revive the silent exit-0 this guard exists to close.
	const names = ["2026-07-30T20-54-28-yarn.json", "2026-07-30T20-54-28-yarn.journal.jsonl"];
	assert.deepEqual(stampArtifacts(names, "2026-07-30T20-54"), []);
});
