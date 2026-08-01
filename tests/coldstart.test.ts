/**
 * Cold start and dead-window recovery — the two fixes for the 2026-08-01 native-dialog wedge.
 *
 * One pass clicked a control that opened a native Open panel, escaped it correctly without
 * touching a user file, and then died: the harness kept the dismissed panel's window id and
 * observed nothing for the rest of the run. The app was left in that state for whatever ran on
 * that Mac next.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { COLD_START_ON, coldStart } from "../src/core/coldstart.js";

test("coldStart__SkipsWebTargets__When__TheAppIsTheProfileBrowser", async () => {
	// On a web target the "app" is the profile Chrome HOLDING the signed-in session. Killing it
	// between passes turns a grounding run into a sign-in run, which is a much more expensive
	// failure than a dirty start.
	const said: string[] = [];
	await coldStart({ kind: "web", url: "https://example.com", origin: "https://example.com" }, "Google Chrome", (l) => said.push(l));
	assert.deepEqual(said, [], "a web target must never be quit");
});

test("coldStart__IsReachedByEveryRunKind__When__TheSourceIsRead", () => {
	// David, 2026-08-01: "each new session should kill the target app if it's still alive and
	// relaunch from scratch". It began as an explore-only normalisation; the wedge above is why
	// it belongs to every run kind. A test on the SOURCE because the alternative is three live
	// runs against a real app.
	const root = path.resolve(import.meta.dirname, "..", "src", "core");
	for (const f of ["explore.ts", "agent/run.ts", "recipe-cli.ts"])
		assert.match(fs.readFileSync(path.join(root, f), "utf8"), /coldStart\(/, `${f} must cold-start its target`);

	// And in recipe-cli it must precede acquisition: quitting after findWindow leaves the run
	// holding a window id for a process that no longer exists — the very failure being fixed.
	const replay = fs.readFileSync(path.join(root, "recipe-cli.ts"), "utf8");
	assert.ok(replay.indexOf("coldStart(") < replay.indexOf("findWindow("), "cold start must run before the window is acquired");
});

test("ColdStart__CanBeDisabled__When__DebuggingAPreservedState", () => {
	// The escape hatch exists because the whole point of some debugging sessions is the state a
	// cold start would destroy.
	assert.equal(COLD_START_ON, process.env.COLD_START !== "0");
});
