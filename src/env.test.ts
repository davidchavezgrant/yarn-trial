import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { envNum } from "./env.js";

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
