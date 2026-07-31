import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_WAIT_MS, settleMsFor, toActionRequest } from "../src/core/harness.js";

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
