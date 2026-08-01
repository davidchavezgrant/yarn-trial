import assert from "node:assert/strict";
import test from "node:test";
import { activationFailure, AxBackend, ACT_TOOL, DEMO_ACT_TOOL, DEMO_DRIVER_RULES, DRIVER_RULES } from "../src/backends/ax.js";
import { EndpointUnavailableError, fallbackEligible } from "../src/backends/electron-attach.js";
import * as actions from "../src/core/harness/actions.js";
import type { Driver } from "../src/core/driver.js";
import type { Target } from "../src/core/target.js";

// ---------------------------------------------------------------------------------------
// EndpointUnavailableError: the marked-error contract the cdp→ax fallback discriminates on.
// ---------------------------------------------------------------------------------------

test("EndpointUnavailableError__PreservesReasonNameAndInstanceof__When__ConstructedWithEitherReason", () => {
	for (const reason of ["port-stripped", "running-without-port"] as const) {
		const err = new EndpointUnavailableError(reason, `endpoint gone (${reason})`);
		assert.equal(err.reason, reason);
		assert.equal(err.name, "EndpointUnavailableError");
		assert.equal(err.message, `endpoint gone (${reason})`);
		assert.ok(err instanceof Error);
		assert.ok(err instanceof EndpointUnavailableError);
	}
});

test("EndpointUnavailableError__DoesNotClaimAPlainError__When__TheMessageTextIsIdentical", () => {
	// The no-regex-over-prose contract: eligibility is the TYPE, never the message. A plain
	// Error wearing the exact same words must stay on the fatal path.
	const marked = new EndpointUnavailableError("port-stripped", "Yarn is running with --remote-debugging-port=9777 but nothing answers");
	const plain = new Error(marked.message);
	assert.equal(plain instanceof EndpointUnavailableError, false);
	assert.ok(marked instanceof EndpointUnavailableError);
});

// ---------------------------------------------------------------------------------------
// fallbackEligible: the runner's whole cdp→ax fallback decision (run.ts calls exactly this).
// ---------------------------------------------------------------------------------------

test("fallbackEligible__ReturnsTrue__When__AppTargetFailsWithPortStripped", () => {
	assert.equal(fallbackEligible(new EndpointUnavailableError("port-stripped", "no endpoint"), "app"), true);
});

test("fallbackEligible__ReturnsTrue__When__AppTargetFailsWithRunningWithoutPort", () => {
	assert.equal(fallbackEligible(new EndpointUnavailableError("running-without-port", "quit and re-run"), "app"), true);
});

test("fallbackEligible__ReturnsFalse__When__TheTargetIsWeb", () => {
	// A web target's endpoint failure is about OUR Chrome — there is no app to drive over AX.
	assert.equal(fallbackEligible(new EndpointUnavailableError("port-stripped", "no endpoint"), "web"), false);
});

test("fallbackEligible__ReturnsFalse__When__AnAppTargetFailsWithAPlainError", () => {
	// Same prose as a real endpoint failure, wrong type: not-installed, port collisions and
	// wrong-owner endpoints all arrive as plain Errors and must stay fatal.
	assert.equal(fallbackEligible(new Error("Yarn launched but exposed no debugging endpoint"), "app"), false);
	assert.equal(fallbackEligible("a thrown string", "app"), false);
	assert.equal(fallbackEligible(undefined, "app"), false);
});

// ---------------------------------------------------------------------------------------
// AxBackend surface: what is testable without a live driver.
// ---------------------------------------------------------------------------------------

test("AxBackend__ReExportsTheActionsSurface__When__ImportedFromAx", () => {
	// ax.ts is the one-stop shop but the definitions STAY in actions.ts (shared by
	// verification, teardown, recipes) — the re-exports must be the SAME objects, not copies.
	assert.equal(ACT_TOOL, actions.ACT_TOOL);
	assert.equal(DEMO_ACT_TOOL, actions.DEMO_ACT_TOOL);
	assert.equal(DRIVER_RULES, actions.DRIVER_RULES);
	assert.equal(DEMO_DRIVER_RULES, actions.DEMO_DRIVER_RULES);
});

test("acquire__RefusesTheTarget__When__ItIsNotAnApp", async () => {
	// The guard is the invariant for callers that do not pre-check — the cdp→ax fallback
	// lands on acquire directly. It fires BEFORE the driver is touched, which is what makes
	// the null driver below safe: reaching driver.act would be the test failing.
	const web: Target = { kind: "web", url: "https://example.com/", origin: "https://example.com" };
	await assert.rejects(
		AxBackend.acquire(web, null as unknown as Driver, "Google Chrome"),
		/drives Mac apps, not web targets/,
	);
});

// ---------------------------------------------------------------------------------------
// activationFailure: classifying an osascript refusal into the run log's activation record.
// ---------------------------------------------------------------------------------------

test("activationFailure__PrefersStderr__When__TheErrorCarriesIt", () => {
	// osascript puts the diagnostic on stderr; err.message is just the echoed command.
	const err = Object.assign(new Error("Command failed: osascript -e tell application ..."), {
		stderr: "execution error: Not authorized to send Apple events to System Events. (-1743)\n",
	});
	assert.deepEqual(activationFailure(err), {
		applied: false,
		error: "execution error: Not authorized to send Apple events to System Events. (-1743)",
	});
});

test("activationFailure__FallsBackToTheMessage__When__ThereIsNoStderr", () => {
	// A spawn-level failure (ETIMEDOUT, ENOENT) has no stderr worth reading.
	assert.deepEqual(activationFailure(new Error("spawnSync osascript ETIMEDOUT")), {
		applied: false,
		error: "spawnSync osascript ETIMEDOUT",
	});
});

test("activationFailure__KeepsTheFirstLineOnly__When__TheDiagnosticIsMultiline", () => {
	const err = Object.assign(new Error("echoed command"), { stderr: "first line of the refusal\nstack noise\nmore noise" });
	assert.equal(activationFailure(err).error, "first line of the refusal");
});

test("activationFailure__CapsTheErrorAt200Chars__When__TheLineRunsLong", () => {
	const err = Object.assign(new Error("x"), { stderr: "e".repeat(500) });
	assert.equal(activationFailure(err).error.length, 200);
});

test("activationFailure__StringifiesTheThrow__When__ItIsNotAnError", () => {
	// execFileSync only throws Errors, but the classifier is called on an unknown catch.
	assert.deepEqual(activationFailure("plain string throw"), { applied: false, error: "plain string throw" });
});

test("AxBackend__RecoversFromADeadWindow__When__ADialogItFollowedIsDismissed", async () => {
	// The 2026-08-01 wedge. A click opened a native Open panel; the follow correctly moved onto
	// it; the agent pressed Escape without touching a user file — exactly right — and the panel
	// vanished. pickWindow then found nothing passing its 50,000px floor while the app settled,
	// and the old code KEPT the held ref on the principle that observe/ensureObservable own that
	// failure. But the held ref was the dismissed panel: every later observation addressed a
	// window id that no longer existed, and three empty ones in a row ended the pass at action
	// 60 with a 197-control frontier still open.
	//
	// "Cannot pick one" and "the one we hold is gone" are different states. Only the first is
	// safe to wait out.
	const listed: unknown[] = [];
	let observedWindowId: number | undefined;
	const driver = {
		act: async (a: any) => {
			if (a.name === "list_windows") return { structuredJson: JSON.stringify({ windows: listed }) };
			// get_window_state carries the window the observation is addressed to.
			observedWindowId = a.args?.window_id;

			return { structuredJson: JSON.stringify({ elements: [] }), text: "" };
		},
	} as unknown as Driver;

	const back = new (AxBackend as any)(driver, "Yarn", { pid: 42, windowId: 853, bounds: { x: 0, y: 0, width: 900, height: 700 } }, { applied: true });

	// The panel (853) is gone. Yarn's real window survives but is BELOW the area floor, so
	// pickWindow returns nothing — the exact shape that stranded the run.
	listed.push({ app_name: "Yarn", pid: 42, window_id: 812, title: "Yarn", is_on_screen: true, bounds: { x: 0, y: 0, width: 120, height: 90 } });
	// The observation itself still fails here — the fake returns an empty tree, and that path is
	// owned by ensureObservable. What this pins is WHICH WINDOW was addressed, which is the whole
	// of the fix: the run must stop talking to the dismissed panel.
	await back.observe("probe").catch(() => undefined);
	assert.equal(observedWindowId, 812, "a live window — even one the area floor rejects — beats a dead one, which is never addressable");
});
