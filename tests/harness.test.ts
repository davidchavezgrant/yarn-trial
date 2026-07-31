import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import { bestClass, descriptorFor, lookup, sidecarStatus } from "../src/core/axdom.js";
import { backendSeizesInput, NOOP_OVERLAY, overlayEnv, scriptEnvKeys, startOverlay, wantOverlay } from "../src/core/overlay.js";

// axdom: the DOM-attribute enrichment that recovers what the AX projection drops.
// These are the pure formatting decisions — the sidecar walk itself needs a live app.

test("bestClass__DropsFrameworkChrome__When__OnlyGenericTokensPresent", () => {
	assert.equal(bestClass("RootView"), "");
	assert.equal(bestClass("ClientView View"), "");
});

test("bestClass__PicksMostSpecificToken__When__BemChainPresent", () => {
	assert.equal(bestClass("icon icon--name--chevronDown"), "icon--name--chevronDown");
	assert.equal(
		bestClass("app libraryPage-sideMenu-personalTab-orgBadgeBtn"),
		"libraryPage-sideMenu-personalTab-orgBadgeBtn",
	);
});

test("descriptorFor__NamesAnonymousControl__When__DomClassPresent", () => {
	const d = descriptorFor({ x: 0, y: 0, w: 10, h: 10, role: "AXButton", domClass: "ag-editor-toolbar-playBtn" });
	assert.equal(d, ".ag-editor-toolbar-playBtn");
});

test("descriptorFor__OmitsId__When__IdIsFrameworkGenerated", () => {
	// Radix/MUI mint these per render: identical across siblings, unstable across renders.
	const d = descriptorFor({ x: 0, y: 0, w: 10, h: 10, role: "AXPopUpButton", domId: "radix-_r_sj_", domClass: "sceneHeader-dropdownBtn" });
	assert.equal(d, ".sceneHeader-dropdownBtn");
	assert.ok(!d.includes("radix"));
});

test("descriptorFor__KeepsId__When__IdIsAuthored", () => {
	const d = descriptorFor({ x: 0, y: 0, w: 10, h: 10, role: "AXGroup", domId: "settings-panel" });
	assert.equal(d, "#settings-panel");
});

test("descriptorFor__DropsChromiumImagePlaceholder__When__NoRealDescription", () => {
	const d = descriptorFor({
		x: 0, y: 0, w: 10, h: 10, role: "AXImage",
		description: "To get missing image descriptions, open the context menu.",
	});
	assert.equal(d, "");
});

test("descriptorFor__ReturnsEmpty__When__NothingUseful", () => {
	assert.equal(descriptorFor({ x: 0, y: 0, w: 10, h: 10, role: "AXGroup" }), "");
});

// --- sidecarStatus(). collect() swallows every one of these so a run can proceed without
// enrichment; the price is that a host with no sidecar is indistinguishable from a healthy one.
// On the fleet the binary is an rsync'd build artifact, so "never built" is a real state — all
// three Macs happened to have it, from whichever checkout provisioned them.

test("sidecarStatus__ReportsNotBuilt__When__TheBinaryIsAbsent", () => {
	const s = sidecarStatus(`${os.tmpdir()}/definitely-not-here-axdom`, () => {
		throw new Error("must not be executed");
	});
	assert.equal(s.usable, false);
	assert.match(s.problem ?? "", /build:native/);
});

test("sidecarStatus__ReportsUsable__When__ItRunsAndExitsWithUsage", () => {
	// No arguments means usage and exit 2, so execFileSync throws with a numeric status. That
	// throw is the success signal: a process that reported an exit code is a process that ran.
	const s = sidecarStatus(existingFile(), () => {
		throw Object.assign(new Error("Command failed"), { status: 2 });
	});
	assert.equal(s.usable, true);
	assert.equal(s.problem, undefined);
});

test("sidecarStatus__ReportsWrongArchitecture__When__TheBinaryCannotSpawn", () => {
	// The case a stat or an `ls` cannot see: the file is right there and this machine cannot
	// execute it. Provisioning from an Intel checkout onto arm64 Macs produces exactly this.
	const s = sidecarStatus(existingFile(), () => {
		throw Object.assign(new Error("spawnSync ENOEXEC"), { code: "ENOEXEC" });
	});
	assert.equal(s.usable, false);
	assert.match(s.problem ?? "", /ENOEXEC/);
	assert.match(s.problem ?? "", /architecture/);
});

test("sidecarStatus__SaysItIsSwitchedOff__When__AxdomIsZero", () => {
	// Distinct from broken: someone chose this, and doctor should not send them hunting for a
	// build problem that does not exist.
	const prev = process.env.AXDOM;
	process.env.AXDOM = "0";
	try {
		const s = sidecarStatus(existingFile(), () => {});
		assert.equal(s.usable, false);
		assert.match(s.problem ?? "", /AXDOM=0/);
	} finally {
		if (prev === undefined) delete process.env.AXDOM;
		else process.env.AXDOM = prev;
	}
});

/** Any real path will do — these tests are about the probe's outcome, not the file's contents. */
function existingFile(): string {
	return new URL(import.meta.url).pathname;
}

// overlay: the parent hands the JXA child a hand-built env, and a key the script reads but
// the parent never sets fails SILENTLY — read() returns its fallback and the feature simply
// does nothing. Exactly that happened to OVERLAY_PAUSE: show/hide was dead code for every
// run, the banner stayed up the whole time, and the parent went on writing pause files
// nothing was listening for. Scraping the script's own read() calls closes the class.

test("overlayEnv__SuppliesEveryKey__When__ScriptReadsIt", () => {
	const env = overlayEnv("drive", "banner text", 4242, "/tmp/go", "/tmp/pause");
	const missing = scriptEnvKeys().filter((k) => !(k in env));
	assert.deepEqual(missing, [], `JXA script reads these but the parent never sets them: ${missing.join(", ")}`);
});

test("overlayEnv__CarriesPauseFile__When__Built", () => {
	// Named explicitly rather than left to the scrape: this is the one that was missing, and
	// a regression here silently un-fixes the banner rather than failing anything.
	assert.equal(overlayEnv("drive", "t", 1, "/tmp/go", "/tmp/pause").OVERLAY_PAUSE, "/tmp/pause");
});

// The banner is gated on input DELIVERY: cdp injects into the renderer and never touches
// the operator's pointer, so warning there trains the operator to ignore the banner that
// matters. Everything else — including delivery strings that don't exist yet — warns,
// because a missing banner lets a hand into a live run and a surplus one is only noise.

test("backendSeizesInput__ReturnsFalse__When__BackendIsCdp", () => {
	assert.equal(backendSeizesInput("cdp"), false);
});

test("backendSeizesInput__ReturnsTrue__When__BackendIsAxOrUnknown", () => {
	assert.equal(backendSeizesInput("ax"), true);
	assert.equal(backendSeizesInput("some-future-backend"), true);
});

test("startOverlay__ReturnsNoop__When__BackendIsHandsOff", () => {
	// Identity, not behavior: NOOP_OVERLAY is the sentinel for "no child process was
	// spawned", which is the whole point — a cdp run must not put a JXA panel on screen.
	// OVERLAY is pinned unset so a forcing value in the shell cannot flash a real panel
	// mid-test-suite.
	const prev = process.env.OVERLAY;
	delete process.env.OVERLAY;
	try {
		assert.equal(startOverlay("drive", "t", "cdp"), NOOP_OVERLAY);
	} finally {
		if (prev !== undefined) process.env.OVERLAY = prev;
	}
});

// The env overrides are tested through wantOverlay (the pure gate startOverlay calls)
// rather than startOverlay itself: forcing OVERLAY=1 through the real thing would spawn
// an osascript child and flash a panel on every `npm test`.

test("wantOverlay__ShowsBanner__When__OverlayEnvForcesIt", () => {
	// The only way to see the banner over a cdp target (e.g. iterating on the banner
	// itself against a cheap web run).
	assert.equal(wantOverlay("cdp", { OVERLAY: "1" }), true);
});

test("wantOverlay__SuppressesBanner__When__OverlayEnvIsZero", () => {
	// OVERLAY=0 must keep winning on ax — it exists for filming takes where the banner
	// would be in frame, and those run on the driver.
	assert.equal(wantOverlay("ax", { OVERLAY: "0" }), false);
});
