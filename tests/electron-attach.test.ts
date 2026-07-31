import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appExecutable, pickMainPage } from "../src/backends/electron-attach.js";

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
