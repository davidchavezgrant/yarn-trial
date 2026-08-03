import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { envNum, refuseRetiredEnv } from "../src/env.js";

const NAME = "ENV_TEST_KNOB";

afterEach(() => {
	delete process.env[NAME];
});

test("envNum__ReturnsFallback__When__VariableIsUnset", () => {
	assert.equal(envNum(NAME, 15), 15);
});

test("envNum__ReturnsFallback__When__VariableIsEmpty", () => {
	// `CLEANUP_STEPS=` from an unset shell interpolation used to become 0 and silently
	// disable teardown; blank must mean "not configured", not "zero".
	process.env[NAME] = "";
	assert.equal(envNum(NAME, 10), 10);
});

test("envNum__ReturnsFallback__When__VariableIsWhitespace", () => {
	process.env[NAME] = "  ";
	assert.equal(envNum(NAME, 10), 10);
});

test("envNum__ParsesTheValue__When__VariableIsNumeric", () => {
	process.env[NAME] = "25";
	assert.equal(envNum(NAME, 15), 25);
});

test("envNum__ParsesZero__When__ZeroIsExplicit", () => {
	// COUNTDOWN=0 is a documented way to skip the overlay countdown.
	process.env[NAME] = "0";
	assert.equal(envNum(NAME, 3), 0);
});

test("envNum__Throws__When__VariableIsNotANumber", () => {
	// NaN answers false to every comparison, so a typo'd budget means zero iterations,
	// not unlimited — dying with the variable's name is the honest path.
	process.env[NAME] = "ten";
	assert.throws(() => envNum(NAME, 15), /ENV_TEST_KNOB/);
});

test("refuseRetiredEnv__Throws__When__ARetiredTierNameIsSet", () => {
	// The failure this exists to prevent is not a crash, it is a clean run under the wrong
	// label: USE_PROCEDURES used to select prose and now selects nothing, so the run grounds
	// on the appmap tier and reports plausible numbers for an arm that never happened.
	assert.throws(() => refuseRetiredEnv({ USE_PROCEDURES: "1" }), /USE_PROCEDURES.*USE_RECIPES/s);
	assert.throws(() => refuseRetiredEnv({ USE_RECIPE: "1" }), /USE_RECIPE -> USE_CURATED/);
	assert.throws(() => refuseRetiredEnv({ PROCEDURE_LINEAGE: "ungrounded" }), /RECIPE_LINEAGE/);
});

test("refuseRetiredEnv__Throws__When__ARenamedKnobWouldSilentlyNoOp", () => {
	// Neither of these is a tier name, which is why both were missed for days — and a knob that
	// no longer has a reader is the same silence as a tier that no longer has one: replay took
	// its 900ms settle default under RECIPE_SETTLE_MS, and a harvest ran on the default model
	// under PROCEDURE_MODEL. Both look like an operator's setting being honoured.
	assert.throws(() => refuseRetiredEnv({ RECIPE_SETTLE_MS: "0" }), /RECIPE_SETTLE_MS -> PROCEDURE_SETTLE_MS/);
	assert.throws(() => refuseRetiredEnv({ PROCEDURE_MODEL: "anthropic/claude-opus-4" }), /PROCEDURE_MODEL -> RECIPE_MODEL/);
});

test("refuseRetiredEnv__NamesAMechanismThatIsRead__When__TheReplacementIsNotAnEnvVar", () => {
	// The right-hand side has to have a reader or the guard swaps one silent no-op for another.
	// It said RECIPE_RESCUE -> PROCEDURE_RESCUE, and nothing reads PROCEDURE_RESCUE: an operator
	// who obeyed the error set a variable with no reader, rescue stayed on, and the guard had
	// vouched for it. `--no-rescue` (or supplying no model client) is the actual disable.
	let message = "";
	try {
		refuseRetiredEnv({ RECIPE_RESCUE: "0" });
	} catch (err) {
		message = err instanceof Error ? err.message : String(err);
	}
	assert.match(message, /--no-rescue/);
	assert.equal(/-> PROCEDURE_RESCUE/.test(message), false, "pointing at a variable with no reader re-creates the trap");
});

test("refuseRetiredEnv__Passes__When__OnlyCurrentNamesAreSet", () => {
	// Blank counts as unset, matching envNum: a plist that interpolates an unset shell
	// variable produces "", and that must not be read as an operator's intent.
	refuseRetiredEnv({ USE_RECIPES: "1", RECIPE_LINEAGE: "ungrounded", USE_CURATED: "1", USE_PROCEDURES: "" });
});
