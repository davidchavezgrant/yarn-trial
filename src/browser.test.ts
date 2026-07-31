import assert from "node:assert/strict";
import test from "node:test";
import { BrowserUnavailableError, mintApprovalToken, pickWindowByPid, prepareArgs, preparedPid, readPrepareReport, refusalOf } from "./browser.js";

test("prepareArgs__AsksForANamedIsolatedProfile__When__Defaulted", () => {
	// isolated_named, not isolated_new: a fresh profile every run would throw away the login
	// this whole design exists to keep.
	const a = prepareArgs(4242);
	assert.equal((a.profile as Record<string, unknown>).mode, "isolated_named");
	assert.equal((a.profile as Record<string, unknown>).name, "yarn-runner");
	// The driver refuses to start a browser for an isolated profile without this.
	assert.equal(a.allow_launch, true);
	// Learned from a live call: browser_prepare prepares an EXISTING process and refuses with
	// "Missing required integer field: pid" without one.
	assert.equal(a.pid, 4242);
});

test("prepareArgs__NeverRequestsTheOperatorsProfile__When__Defaulted", () => {
	// existing_profile attaches to the operator's OWN browser and its grant is anchored to an
	// exact pid+window; this path deliberately drives a disposable driver-owned profile
	// instead, so the strategy must never appear in these args.
	assert.equal(JSON.stringify(prepareArgs(4242)).includes("existing_profile"), false);
});

test("readPrepareReport__ListsTheEffects__When__DriverSetsThemAtTopLevel", () => {
	const r = readPrepareReport({ launched_browser: true, created_profile: true, foregrounded_window: false });
	assert.deepEqual(r.effects.sort(), ["created_profile", "launched_browser"]);
});

test("readPrepareReport__FindsTheEffects__When__TheyAreNested", () => {
	// The envelope is unverified against a live driver, so both plausible nestings are read.
	assert.deepEqual(readPrepareReport({ browser: { enabled_remote_debugging: true } }).effects, ["enabled_remote_debugging"]);
	assert.deepEqual(readPrepareReport({ result: { reused_driver_profile: true } }).effects, ["reused_driver_profile"]);
});

test("readPrepareReport__ReportsNothing__When__PayloadIsUnrecognised", () => {
	// Guessing the envelope wrong must degrade the run log, never throw: an exception here
	// would fail a browser that actually came up fine.
	for (const payload of [null, undefined, {}, "surprise", 42, []])
		assert.deepEqual(readPrepareReport(payload).effects, []);
});

test("readPrepareReport__IgnoresUnknownKeys__When__DriverAddsThem", () => {
	assert.deepEqual(readPrepareReport({ launched_browser: true, some_new_effect: true }).effects, ["launched_browser"]);
});

test("readPrepareReport__KeepsTheRawPayload__When__EffectsAreEmpty", () => {
	// The effect list is a summary; a diagnosis it does not cover has to stay reachable.
	const raw = { unexpected: "shape" };
	assert.deepEqual(readPrepareReport(raw).raw, raw);
});

test("BrowserUnavailableError__NamesTheOperatorAction__When__BindingIsAmbiguous", () => {
	const e = new BrowserUnavailableError("browser_binding_ambiguous", "multiple CDP targets match");
	assert.match(e.message, /Close spare windows/);
	// The raw code survives for anyone grepping the driver's own docs.
	assert.match(e.message, /browser_binding_ambiguous/);
	assert.equal(e.code, "browser_binding_ambiguous");
});

test("BrowserUnavailableError__DiagnosesMintingFailure__When__ConsentIsRefused", () => {
	// Corrected twice by measurement, and the second correction matters most: this was called a
	// "one-time consent grant" until the driver's own help revealed browser-approve mints a
	// FIVE-MINUTE, SINGLE-USE token. That is per-run, not per-machine, which changes the answer
	// to "can the fleet run web targets unattended" from yes to no. The message must not imply
	// a one-off setup step that does not exist.
	const e = new BrowserUnavailableError("browser_consent_required", "consent needed");
	assert.match(e.message, /five-minute single-use/);
	assert.match(e.message, /browser-approve --pid/);
	// This path is now only reached when minting FAILED, so the message must diagnose that
	// rather than tell the operator the gate is impassable — it is not.
	assert.match(e.message, /expect/);
	assert.doesNotMatch(e.message, /Approve it by hand, once per machine/);
	// Points at the measured table rather than restating it.
	assert.match(e.message, /LIMITATIONS §12/);
});

test("BrowserUnavailableError__StillReadsUsefully__When__CodeIsUnknown", () => {
	const e = new BrowserUnavailableError("", "something odd");
	assert.match(e.message, /could not be prepared/);
	assert.match(e.message, /something odd/);
});

test("preparedPid__FindsThePid__When__ReportedAtAnyKnownNesting", () => {
	assert.equal(preparedPid({ prepared_pid: 4242 }), 4242);
	assert.equal(preparedPid({ attachment: { pid: 99 } }), 99);
	assert.equal(preparedPid({ browser: { endpoint_owner_pid: 7 } }), 7);
});

test("preparedPid__ReturnsUndefined__When__NoPidIsReported", () => {
	// Must not invent one: the caller falls back to a name match and warns, which is the
	// honest degradation. A bogus pid would silently match no window at all.
	for (const p of [{}, null, { prepared_pid: 0 }, { prepared_pid: "4242" }]) assert.equal(preparedPid(p), undefined);
});

/** list_windows, as the driver returns it. */
function fakeDriver(windows: unknown[]) {
	return { act: async () => ({ structuredJson: JSON.stringify({ windows }) }) } as never;
}

const BIG = { width: 1440, height: 900 };

test("pickWindowByPid__IgnoresTheOperatorsChrome__When__BothAreRunning", async () => {
	// THE failure this function exists to prevent: both processes are named "Google Chrome",
	// so a name match can return the operator's window — and we would then drive the very
	// profile browser_prepare promises never to touch.
	const win = await pickWindowByPid(
		fakeDriver([
			{ pid: 111, window_id: 1, app_name: "Google Chrome", title: "operator's tabs", bounds: BIG },
			{ pid: 222, window_id: 2, app_name: "Google Chrome", title: "driver-owned", bounds: BIG },
		]),
		222,
	);
	assert.deepEqual(win, { pid: 222, windowId: 2 });
});

test("pickWindowByPid__SkipsPanels__When__ThePidHasSmallWindows", async () => {
	const win = await pickWindowByPid(
		fakeDriver([
			{ pid: 222, window_id: 9, app_name: "Google Chrome", title: "tooltip", bounds: { width: 120, height: 40 } },
			{ pid: 222, window_id: 3, app_name: "Google Chrome", title: "real", bounds: BIG },
		]),
		222,
	);
	assert.equal(win?.windowId, 3);
});

test("pickWindowByPid__PrefersATitledWindow__When__ThePidHasSeveral", async () => {
	const win = await pickWindowByPid(
		fakeDriver([
			{ pid: 222, window_id: 4, app_name: "Google Chrome", title: "", bounds: { width: 1600, height: 1000 } },
			{ pid: 222, window_id: 5, app_name: "Google Chrome", title: "Notion", bounds: BIG },
		]),
		222,
	);
	assert.equal(win?.windowId, 5);
});

test("pickWindowByPid__ReturnsUndefined__When__ThePidHasNoWindowYet", async () => {
	// The caller polls on this, so "not yet" must be an absence rather than a throw.
	assert.equal(await pickWindowByPid(fakeDriver([{ pid: 111, window_id: 1, bounds: BIG }]), 222), undefined);
});

test("refusalOf__ReportsTheRefusal__When__DriverAnswersWithoutErroring", () => {
	// Measured against the live driver: a consent problem comes back as a NON-error result, so
	// nothing throws and a caller that only catches exceptions proceeds as if it worked. That
	// really happened — the run died later at the bind blaming a step that had "succeeded".
	const r = refusalOf({
		status: "refused",
		refusal: { code: "browser_consent_required", message: "browser preparation needs MCP host approval" },
	});
	assert.equal(r?.code, "browser_consent_required");
	assert.match(r?.message ?? "", /MCP host approval/);
});

test("refusalOf__ReturnsUndefined__When__TheCallSucceeded", () => {
	for (const ok of [{}, null, { status: "ok" }, { launched_browser: true }]) assert.equal(refusalOf(ok), undefined);
});

test("refusalOf__StillReports__When__RefusalCarriesNoCode", () => {
	assert.equal(refusalOf({ status: "refused" })?.message, "the driver refused the call");
});

test("BrowserUnavailableError__NamesTheApprovalCommand__When__ConsentIsRequired", () => {
	// The remedy is a specific one-time command, so the message must carry it rather than
	// leaving an operator to search the driver's docs for it.
	assert.match(new BrowserUnavailableError("browser_consent_required", "x").message, /browser-approve --pid/);
});

test("mintApprovalToken__RefusesTheProfileName__When__ItIsNotAPlainToken", () => {
	// The name reaches expect as argv (no shell), but it also names an on-disk profile
	// directory and a CLI flag value — a value with separators or metacharacters is an
	// operator config error, and it must die loudly here, before anything is spawned.
	const saved = process.env.YARN_BROWSER_AUTO_APPROVE;
	delete process.env.YARN_BROWSER_AUTO_APPROVE;
	try {
		for (const bad of ["../escape", "a profile", "x;rm", "a}b", "$HOME", ""])
			assert.throws(() => mintApprovalToken(4242, bad), /profile name/, `accepted "${bad}"`);
	} finally {
		if (saved !== undefined) process.env.YARN_BROWSER_AUTO_APPROVE = saved;
	}
});
