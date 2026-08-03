/**
 * Dismissal categories, and the verification that stops them being free text with a shorter
 * vocabulary.
 *
 * Measured across three grounding passes on 2026-08-01: "would change state" was the reason
 * for 51%, 70% and 50% of every control skipped, while the mechanical guards refused 7-12
 * per pass — about 1% of skips. The model's own conservatism, expressed in fluent prose
 * ("mapped but not operated to preserve state"), was the frontier's bottleneck by two orders
 * of magnitude and cost an entire template editor.
 *
 * A reason FIELD would not have caught any of it. The tests that matter here are the ones
 * asserting a claim gets refused when the observation does not support it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDismissal, DISMISS_REASON_HELP, DISMISS_REASONS } from "../src/core/harness.js";
import type { InteractiveElement, ObservationBundle } from "../src/core/harness.js";

const el = (over: Partial<InteractiveElement> & { handle: number; name: string }): InteractiveElement =>
	({ role: "AXButton", surface: "Brand Kit", value: "", x: 0, y: 0, w: 40, h: 20, ...over }) as InteractiveElement;

const obsOf = (...items: InteractiveElement[]): ObservationBundle =>
	({ interactive: items, elementsText: "", frames: new Map(), domEnriched: 0 }) as unknown as ObservationBundle;

test("DISMISS_REASONS__OffersNoWayToSayItWouldChangeSomething__When__EnumerationIsRead", () => {
	// The single most important property of this list is what is NOT in it. The reason that
	// accounted for most of the loss is now inexpressible rather than merely discouraged —
	// a stronger guarantee than a prompt instruction, which is what it replaced.
	const all = [...DISMISS_REASONS, ...Object.values(DISMISS_REASON_HELP)].join(" ").toLowerCase();
	assert.ok(!/would change|changes state|state-changing|persist/.test(all), `a mutation-avoidance category crept back in: ${all}`);
	// And every category has a definition the model can read, or the enum is a guessing game.
	for (const r of DISMISS_REASONS) assert.ok(DISMISS_REASON_HELP[r]?.length > 20, `${r} needs a real description`);
});

test("checkDismissal__RefusesExternal__When__NoLabelCommitsOffTheMachine", () => {
	// "external" is the easiest category to reach for and the easiest to check: if the guard
	// would not refuse the control anyway, the claim is decoration.
	const target = el({ handle: 1, name: "New Template" });
	const verdict = checkDismissal("external", [target], obsOf(target));
	assert.ok(verdict.refusal, "New Template commits nothing off the machine");
	// The refusal must also correct the underlying belief, not just say no — this is the exact
	// control three passes skipped, and the reason they gave was that it changes state.
	assert.match(verdict.refusal ?? "", /reverted automatically/);
});

test("checkDismissal__AcceptsExternal__When__TheLabelReallyCommits", () => {
	const target = el({ handle: 1, name: "Publish to web" });
	assert.equal(checkDismissal("external", [target], obsOf(target)).refusal, undefined);
});

test("checkDismissal__RefusesDestroysUserData__When__TheControlOnlyCreates", () => {
	// Creating is not destroying. This is the confusion that lost the template editor.
	const target = el({ handle: 1, name: "New Draft" });
	const verdict = checkDismissal("destroys-user-data", [target], obsOf(target));
	assert.match(verdict.refusal ?? "", /Creating something new is not destroying/);

	// A real destructive label passes.
	const del = el({ handle: 2, name: "Delete Template" });
	assert.equal(checkDismissal("destroys-user-data", [del], obsOf(del)).refusal, undefined);
});

test("checkDismissal__RefusesRepetitiveValue__When__TheCohortIsSmall", () => {
	// A "repetitive" group of three is a panel of distinct controls with a convenient label.
	// The threshold is the same one the frontier uses to collapse a value list, so the two
	// mechanisms cannot disagree about what counts as repetitive.
	const items = [1, 2, 3].map((i) => el({ handle: i, name: `Setting ${i}`, role: "AXCheckBox" }));
	const verdict = checkDismissal("repetitive-value", items, obsOf(...items), { cohortSize: () => 3 });
	assert.match(verdict.refusal ?? "", /largest group here has 3/);

	// A genuine value list passes — one font stands for the other 1,499.
	const fonts = [1, 2].map((i) => el({ handle: i, name: `Font ${i}`, role: "AXStaticText", surface: "Font picker" }));
	assert.equal(checkDismissal("repetitive-value", fonts, obsOf(...fonts), { cohortSize: () => 1500 }).refusal, undefined);
});

test("checkDismissal__AcceptsJudgementCategories__When__TheHarnessCannotCheckThem", () => {
	// content and dead-end rest on judgements no code can make — is this row the user's data?
	// did you already try an equivalent? Accepting them is honest; the point of the enum was
	// to remove the ONE category doing the damage, not to pretend everything is checkable.
	const row = el({ handle: 1, name: "Q3 planning doc" });
	assert.equal(checkDismissal("content", [row], obsOf(row)).refusal, undefined);
	assert.equal(checkDismissal("dead-end", [row], obsOf(row)).refusal, undefined);
});

test("checkDismissal__UsesTheWebVerbSet__When__TheTargetIsAWebsite", () => {
	// A bare "Confirm" ships state to a server on the web and is ordinary navigation in a
	// desktop app. Checking the claim against the wrong verb set would refuse a correct
	// dismissal on the web, and accept a hollow one in an app.
	const confirm = el({ handle: 1, name: "Confirm" });
	assert.equal(checkDismissal("external", [confirm], obsOf(confirm), { web: true }).refusal, undefined);
	assert.ok(checkDismissal("external", [confirm], obsOf(confirm), { web: false }).refusal);
});

/**
 * Every refusal must leave the model somewhere to go.
 *
 * On the 2026-08-03 Notion pass the model attempted four dismissals, was refused all four at
 * actions 3, 23 and 24, and then never attempted another for 137 actions while the frontier
 * climbed 57 -> 394. The rule was right and the correction was a dead end: it said "under a
 * reason that fits" without naming one, and the closed set lives in a tool schema many turns
 * back. These pin the fix as behaviour rather than wording — a refusal that names no remaining
 * category is the regression.
 */
for (const [reason, mk] of [
	["external", () => ({ targets: [el({ handle: 1, name: "Rename draft" })], size: 3 })],
	["destroys-user-data", () => ({ targets: [el({ handle: 1, name: "New page" })], size: 3 })],
	["repetitive-value", () => ({ targets: [el({ handle: 1, name: "Roadmap" }), el({ handle: 2, name: "Notes" })], size: 3 })],
] as const) {
	test(`checkDismissal__NamesARemainingCategory__When__ItRefuses_${reason}`, () => {
		const { targets, size } = mk();
		const verdict = checkDismissal(reason, [...targets], obsOf(...targets), { cohortSize: () => size });

		assert.ok(verdict.refusal, `${reason} was supposed to be refused here`);
		assert.match(verdict.refusal, /content/, "the refusal must name a category still open");
		assert.match(verdict.refusal, /dead-end/, "the refusal must name a category still open");
	});
}

test("checkDismissal__SuggestsNeitherGuardBackedCategory__When__ItRefuses", () => {
	// Proposing `external` or `destroys-user-data` to a model that just failed one of them
	// invites relabelling rather than reconsidering — the theatre the closed set exists to stop.
	const target = el({ handle: 1, name: "New page" });
	const refusal = String(checkDismissal("destroys-user-data", [target], obsOf(target)).refusal);
	const suggestion = refusal.slice(refusal.indexOf("categories still open"));

	assert.equal(/\bexternal\b/.test(suggestion), false, "must not offer a guard-backed category as the way out");
});

test("checkDismissal__AcceptsTheCategoriesItSuggests__When__TheModelTakesTheAdvice", () => {
	// The suggestion is only honest if following it actually works: content and dead-end rest on
	// judgements the harness cannot check and are accepted unconditionally. If that ever changes,
	// the refusal starts sending the model into a second dead end and this fails.
	const target = el({ handle: 1, name: "Roadmap" });
	assert.equal(checkDismissal("content", [target], obsOf(target)).refusal, undefined);
	assert.equal(checkDismissal("dead-end", [target], obsOf(target)).refusal, undefined);
});

test("DISMISS_REASONS__IsUnchangedByTheRefusalWording__When__TheClosedSetIsRead", () => {
	// The 2026-08-03 change edits refusal TEXT only. If a future edit widens the set to make
	// dismissal easier, that is a measurement change and must be made deliberately, not as a
	// side effect of improving an error message.
	assert.deepEqual([...DISMISS_REASONS], ["external", "destroys-user-data", "repetitive-value", "content", "dead-end"]);
});
