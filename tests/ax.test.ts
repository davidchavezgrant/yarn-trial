import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
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
	// verification, teardown, procedures) — the re-exports must be the SAME objects, not copies.
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


test("AxBackend__PicksAWindowThatCanAnswer__When__TheFrontOneIsSilent", () => {
	// Four AX passes died on 2026-08-01, all with "no addressable elements for 3 consecutive
	// observations", all ~15-20 minutes deep in the parts of Yarn that publish no AX tree.
	//
	// The first three fixes each covered the case that had just bitten — the held window being
	// GONE, then the held window being SILENT — and the fourth crash walked straight through the
	// gap between them: a click opened an untitled window, the pick returned a DIFFERENT id, and
	// the "moved" branch adopted it without ever asking whether it had content. The harness chose
	// a mute window for the agent and then blamed the app.
	//
	// So the rule is no longer "does this window exist" at three separate sites; it is "can this
	// window answer", once, as a ladder. A source-level check because exercising observe() needs
	// a driver double rich enough for a real get_window_state round trip — screenshot path, tool
	// vocabulary, element shapes — and a double that elaborate is testing itself.
	const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "backends", "ax.ts"), "utf8");

	// One ladder, not per-branch patches: every candidate is PROBED and skipped when it answers
	// nothing, whether or not it is the one we already hold.
	//
	// The predicate must be the SHARED one. `appContent === 0` was the original spelling and it
	// cost a 47-minute pass on 2026-08-03: Yarn's recorder child answers with exactly one
	// element, which cleared this bar and permanently reassigned the window every later
	// observation reads — while the explore ladder, testing `=== 0`, never armed. A window that
	// is good enough to follow but not blind enough to recover is the gap, so both sides ask
	// `isBlind` and neither may drift back to a bare zero-check.
	assert.match(src, /if \(!got \|\| isBlind\(got\.appContent\)\) continue;/, "candidates must be skipped via the shared blindness floor, not a bare zero-check");
	assert.equal(/appContent === 0|appContent > 0/.test(src), false, "the follow must not re-introduce its own content threshold");
	assert.match(src, /const order = \[front, held, \.\.\.pool\]/, "front, then held, then the rest — deduped");
	// The old per-branch helpers must be GONE, or the hole they left can reopen.
	assert.equal(/const heldAlive = all\.some/.test(src), false, "the dead-handle branch should be subsumed by the ladder");
	// A DEAD held window needs no special case now: the pool comes from the live listing, so a
	// window that no longer exists is simply not in it and the ladder never returns to it. That
	// was the first of the four crashes — a dismissed panel's id, addressed forever.
	assert.match(src, /const held = pool\.find\(\(w\) => w\.window_id === this\.currentWin\.windowId\)/, "the held window must come from the LIVE listing");

	// Re-activation is the last rung: an AppKit app that is not KEY/MAIN collapses its AX tree to
	// the menu bar (the activation-policy finding acquire() exists for), and a coordinate drag can
	// knock that loose mid-run. It costs an osascript round trip, so it may only run once every
	// window has come back empty.
	assert.ok(src.indexOf("for (const w of order)") < src.indexOf("const woken = await activate("), "re-activation must follow the window ladder, not precede it");
	// And it reports either way. The previous version logged only success, so a refused
	// activation was indistinguishable from one that never ran.
	assert.match(src, /re-activation \$\{woken\.applied \? "applied" : /, "a refused activation must say so");
});
