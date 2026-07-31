import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appExecutable, canMintTargets, chooseFlaggedChrome, debugPortFromArgv, isMainProcessOf, pickMainPage, strayChromes } from "../src/backends/electron-attach.js";

// The shape a real Electron endpoint presents: the app's window is NOT alone — its
// devtools, extension machinery and hidden background window are all page targets too,
// and picking any of them drives the wrong surface while every call still "works".
const YARN_TARGETS = [
	{ url: "devtools://devtools/bundled/devtools_app.html", title: "DevTools", viewport: { width: 1200, height: 800 } },
	{ url: "chrome-extension://abcdef/background.html", title: "", viewport: null },
	{ url: "file:///Applications/Yarn.app/Contents/Resources/app/background.html", title: "", viewport: { width: 800, height: 600 } },
	{ url: "file:///Applications/Yarn.app/Contents/Resources/app/index.html", title: "Yarn — Untitled", viewport: { width: 1440, height: 900 } },
];

test("pickMainPage__PicksMainPage__When__MultipleTargets", () => {
	// The devtools page has a LARGE viewport and the background page a real one — size
	// alone is not enough, the non-window URLs must be excluded first.
	assert.equal(pickMainPage(YARN_TARGETS, "Yarn"), 3);
});

test("pickMainPage__PrefersTheLargerViewport__When__SeveralWindowsQualify", () => {
	// A settings window is a real window with a real title; the main window wins on size,
	// not on listing order.
	const pages = [
		{ url: "file:///Applications/Yarn.app/Contents/Resources/app/settings.html", title: "Yarn Settings", viewport: { width: 480, height: 360 } },
		{ url: "file:///Applications/Yarn.app/Contents/Resources/app/index.html", title: "Yarn", viewport: { width: 1440, height: 900 } },
	];
	assert.equal(pickMainPage(pages, "Yarn"), 1);
});

test("pickMainPage__TieBreaksByTitle__When__ViewportsMatch", () => {
	// Attached pages frequently report no measurable viewport at all (area 0 across the
	// board) — the title carrying the app name is then the only signal left.
	const pages = [
		{ url: "file:///Applications/Yarn.app/x.html", title: "Preferences", viewport: null },
		{ url: "file:///Applications/Yarn.app/index.html", title: "Yarn — Brew ad", viewport: null },
	];
	assert.equal(pickMainPage(pages, "Yarn"), 1);
});

test("pickMainPage__ReturnsMinusOne__When__NothingLooksLikeAWindow", () => {
	const pages = [
		{ url: "devtools://devtools/bundled/devtools_app.html", title: "DevTools", viewport: { width: 1200, height: 800 } },
		{ url: "chrome-extension://abcdef/background.html", title: "", viewport: null },
	];
	assert.equal(pickMainPage(pages, "Yarn"), -1);
});

test("appExecutable__ErrorsClearly__When__BinaryNotFound", () => {
	// The message must carry the name and where it looked — this error reaches the
	// operator's terminal, and "no app" without the search path is not actionable.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attach-"));
	assert.throws(() => appExecutable("Definitely Not An App", [dir]), (e: Error) => {
		assert.match(e.message, /Definitely Not An App/);
		assert.ok(e.message.includes(dir));

		return true;
	});
});

test("appExecutable__ReadsCFBundleExecutable__When__TheBinaryIsNotNamedAfterTheApp", () => {
	// The common Electron shape: "Visual Studio Code.app" runs "Electron". Guessing the
	// binary from the bundle name would launch nothing.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attach-"));
	const macos = path.join(dir, "Fake.app/Contents/MacOS");
	fs.mkdirSync(macos, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "Fake.app/Contents/Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Electron</string></dict></plist>
`,
	);
	fs.writeFileSync(path.join(macos, "Electron"), "");
	assert.equal(appExecutable("Fake", [dir]), path.join(macos, "Electron"));
});

test("appExecutable__FallsBackToTheAppName__When__ThePlistIsMissing", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attach-"));
	const macos = path.join(dir, "Plain.app/Contents/MacOS");
	fs.mkdirSync(macos, { recursive: true });
	fs.writeFileSync(path.join(macos, "Plain"), "");
	assert.equal(appExecutable("Plain", [dir]), path.join(macos, "Plain"));
});

test("debugPortFromArgv__ReadsThePort__When__TheFlagIsPresent", () => {
	assert.equal(
		debugPortFromArgv("/Applications/Notion Calendar.app/Contents/MacOS/Notion Calendar --remote-debugging-port=9222 --soft-quit-relaunch"),
		9222,
	);
});

test("debugPortFromArgv__ReturnsUndefined__When__TheFlagIsAbsent", () => {
	assert.equal(debugPortFromArgv("/Applications/Yarn.app/Contents/MacOS/Yarn --disable-renderer-backgrounding"), undefined);
});

test("isMainProcessOf__MatchesTheNestedBundleMain__When__OpenLaunchedTheInnerApp", () => {
	// Yarn ships an app-in-an-app: `open -a Yarn` runs the INNER bundle's binary while
	// appExecutable resolves the outer one. Both are main processes of the same app —
	// missing the inner one launched a second instance beside it (seam test, 2026-07-31).
	const outer = "/Applications/Yarn.app/Contents/MacOS/Yarn";
	assert.equal(isMainProcessOf("/Applications/Yarn.app/Contents/MacOS/Yarn", outer), true);
	assert.equal(isMainProcessOf("/Applications/Yarn.app/Contents/Resources/Yarn.app/Contents/MacOS/Yarn", outer), true);
	assert.equal(isMainProcessOf("/Applications/Yarn.app/Contents/MacOS/Yarn --remote-debugging-port=9223 --disable-renderer-backgrounding", outer), true);
});

test("isMainProcessOf__RefusesHelpers__When__TheyLiveUnderFrameworks", () => {
	const outer = "/Applications/Yarn.app/Contents/MacOS/Yarn";
	assert.equal(
		isMainProcessOf("/Applications/Yarn.app/Contents/Frameworks/Yarn Helper (GPU).app/Contents/MacOS/Yarn Helper (GPU) --type=gpu-process", outer),
		false,
	);
	assert.equal(
		isMainProcessOf("/Applications/Yarn.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler --database=x", outer),
		false,
	);
	// A different app entirely, even if the prefix is superficially close.
	assert.equal(isMainProcessOf("/Applications/Yarn Beta.app/Contents/MacOS/Yarn", outer), false);
});

// ---- canMintTargets: the health probe is the operation, not a proxy for it -----------------
// mac1, 2026-07-31: a Chrome answered /json/version for hours while /json/list reported zero
// targets and Target.createTarget hung — every reuse path trusted it, OAuth handoffs opened
// blank tab shells, web runs timed out. The probe is a create/close round trip against the
// same HTTP interface, so a fake devtools server is the whole harness.

interface FakeDevtools {
	url: string;
	hits: string[];
	close: () => void;
}

/** A devtools-shaped HTTP server; per-path handlers, "hang" leaves the request unanswered. */
function fakeDevtools(behaviour: { create?: "ok" | "hang" | "empty" | "error"; close?: "ok" | "error" }): Promise<FakeDevtools> {
	return new Promise((resolve) => {
		const hits: string[] = [];
		const server = http.createServer((req, res) => {
			hits.push(`${req.method} ${req.url}`);
			if (req.url?.startsWith("/json/new")) {
				const mode = behaviour.create ?? "ok";
				if (mode === "hang") return; // never answered — the zombie's signature
				if (mode === "error") return void (res.statusCode = 500, res.end());
				if (mode === "empty") return void res.end("{}");

				return void res.end(JSON.stringify({ id: "probe-target-1", type: "page", url: "about:blank" }));
			}
			if (req.url?.startsWith("/json/close/")) {
				if ((behaviour.close ?? "ok") === "error") return void (res.statusCode = 404, res.end());

				return void res.end("Target is closing");
			}
			res.statusCode = 404;
			res.end();
		});
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as { port: number };
			resolve({ url: `http://127.0.0.1:${addr.port}`, hits, close: () => server.closeAllConnections?.() ?? server.close() });
		});
		server.unref();
	});
}

test("canMintTargets__ReturnsTrue__When__CreateAndCloseSucceed", async () => {
	const dt = await fakeDevtools({});
	assert.equal(await canMintTargets(dt.url, 1_000), true);
	// The probe must clean up after itself: the created target is closed, by id.
	assert.ok(dt.hits.includes("GET /json/close/probe-target-1"), `close never arrived — hits: ${dt.hits.join(", ")}`);
	dt.close();
});

test("canMintTargets__ReturnsFalse__When__CreateHangs", async () => {
	// The mac1 zombie: the HTTP thread is alive, target creation never completes.
	const dt = await fakeDevtools({ create: "hang" });
	assert.equal(await canMintTargets(dt.url, 150), false);
	dt.close();
});

test("canMintTargets__ReturnsFalse__When__CreateAnswersWithoutAnId", async () => {
	const dt = await fakeDevtools({ create: "empty" });
	assert.equal(await canMintTargets(dt.url, 1_000), false);
	dt.close();
});

test("canMintTargets__ReturnsFalse__When__CreateErrors", async () => {
	const dt = await fakeDevtools({ create: "error" });
	assert.equal(await canMintTargets(dt.url, 1_000), false);
	dt.close();
});

test("canMintTargets__ReturnsTrue__When__OnlyTheCleanupCloseFails", async () => {
	// The create IS the verdict; a failed best-effort close costs one blank tab, not the probe.
	const dt = await fakeDevtools({ close: "error" });
	assert.equal(await canMintTargets(dt.url, 1_000), true);
	dt.close();
});

test("canMintTargets__ReturnsFalse__When__NothingListens", async () => {
	assert.equal(await canMintTargets("http://127.0.0.1:1", 500), false);
});

// ---- stray-Chrome pruning: one Chrome per Mac, and it is the flagged one -------------------
// Three incidents in one day (2026-07-31): a second portless Chrome swallowing the OAuth
// handoff (LaunchServices delivers the URL to whichever instance registered first, invisible
// to the screencast), and orphaned "Chrome for Testing" zombies beside the real one. The
// selection is pure so the kill list is testable: the keeper must never be in it.

const FLAGGED = { pid: 100, argv: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9777 --user-data-dir=/x" };
const PORTLESS = { pid: 200, argv: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" };
const CFT = { pid: 300, argv: "/Users/x/cache/chrome-for-testing/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --allow-pre-commit-input" };

test("chooseFlaggedChrome__PicksTheFlaggedMain__When__APortlessOneRunsBeside", () => {
	assert.deepEqual(chooseFlaggedChrome([PORTLESS, FLAGGED]), { ...FLAGGED, port: 9777 });
});

test("chooseFlaggedChrome__ReturnsUndefined__When__NoMainDeclaresAPort", () => {
	assert.equal(chooseFlaggedChrome([PORTLESS, CFT]), undefined);
});

test("strayChromes__ListsEverythingButTheKeeper__When__StraysRunBesideIt", () => {
	assert.deepEqual(strayChromes([FLAGGED, PORTLESS, CFT], FLAGGED.pid), [PORTLESS, CFT]);
});

test("strayChromes__ListsEveryMain__When__ThereIsNoKeeper", () => {
	// No healthy flagged instance: everything goes before the relaunch.
	assert.deepEqual(strayChromes([FLAGGED, PORTLESS], undefined), [FLAGGED, PORTLESS]);
});

test("strayChromes__ListsNothing__When__OnlyTheKeeperRuns", () => {
	assert.deepEqual(strayChromes([FLAGGED], FLAGGED.pid), []);
});
