// liveview-e2e — manual integration check for the two things unit tests cannot prove:
// (1) input injection actually LANDS in a real app, and (2) window-follow switches when the
// frontmost window changes (the OAuth-handoff proxy). Run by hand on a Mac you are sitting at:
//
//   npx tsx src/fleet/liveview-e2e.mts
//
// It is not part of `npm test` — it opens real apps and needs the Accessibility grant. It reports
// PASS/FAIL for each check by reading state back out of the OS, never by asserting the call
// "looked ok". Same spirit as e2e-gui-remote.mts.
//
// What it does:
//   - launches TextEdit with a fresh document, brings it frontmost,
//   - spawns the engine in `follow` mode, waits for a `window` event naming TextEdit,
//   - injects a known string via the engine's `text` command,
//   - reads the document body back via AppleScript and checks the string arrived (injection PASS),
//   - opens a second app (Calculator), confirms the engine emits a NEW `window` event for it
//     (follow PASS) — this is the same switch an OAuth "Sign in with Google" popup would cause.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawnEngine, type WindowEvent } from "./liveview.js";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function osa(script: string): Promise<string> {
	const { stdout } = await exec("osascript", ["-e", script]);

	return stdout.trim();
}

function line(ok: boolean, label: string, detail = ""): void {
	console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
	console.log("\x1b[1mliveview integration check\x1b[0m (real apps; needs Accessibility)\n");

	// Start from a clean slate: quit TextEdit first, so a document left open by a previous run (or
	// a "save?" modal it is sitting behind) cannot make `get text of front document` ambiguous or
	// wedge osascript. Measured 2026-07-30: accumulated documents across repeated runs are what
	// made the read-back intermittently fail even though injection had succeeded.
	await osa('tell application "TextEdit" to quit saving no').catch(() => {});
	await sleep(1000);

	// A fresh TextEdit document, empty, frontmost. Disable the smart-substitution features that
	// would otherwise rewrite an injected marker (auto-capitalization turns "liveview" into
	// "Liveview", smart quotes/dashes rewrite punctuation) — measured 2026-07-30: without this the
	// injection genuinely lands but the first character is capitalized, which is a real property of
	// AppKit text views, not of the injection. (Password fields disable these, so live logins are
	// unaffected; this only matters for a plain TextEdit document used as a test target.)
	await osa('tell application "TextEdit" to activate');
	await sleep(600);
	await osa('tell application "TextEdit" to make new document');
	await sleep(400);
	await osa('tell application "TextEdit" to set text of front document to ""');
	await osa('tell application "System Events" to tell process "TextEdit" to set frontmost to true');
	await sleep(600);

	const engine = spawnEngine({ fps: 8, quality: 0.4 });
	let lastWindow: WindowEvent | undefined;
	const seenApps: string[] = [];
	engine.onEvent((ev) => {
		if (ev.ev === "window") {
			lastWindow = ev;
			if (!seenApps.includes(ev.app)) seenApps.push(ev.app);
		} else if (ev.ev === "error") {
			console.log(`    \x1b[33mengine error:\x1b[0m ${ev.kind} — ${ev.detail}`);
		}
	});

	// Give the engine a moment to resolve the frontmost window.
	await sleep(1200);
	const followedTextEdit = !!lastWindow && /textedit/i.test(lastWindow.app);
	line(followedTextEdit, "engine followed the frontmost window", lastWindow ? `saw "${lastWindow.app}"` : "no window event");

	// Inject a known marker string and read it back out of the document. Compare
	// case-insensitively: AppKit may still capitalize the leading character even with
	// substitutions off, and what we are proving is "the keystrokes arrived", not "TextEdit left
	// them verbatim". The marker is all-lowercase alphanumerics with a hyphen, so a
	// case-insensitive substring match cannot pass by accident.
	const marker = `liveview-inject-${Date.now() % 100000}`;
	engine.send({ cmd: "text", s: marker });
	await sleep(1500);
	let body = "";
	try {
		body = await osa('tell application "TextEdit" to get text of front document');
	} catch (e) {
		body = `(read failed: ${(e as Error).message})`;
	}
	const landed = body.toLowerCase().includes(marker.toLowerCase());
	line(landed, "text injection landed in the document", landed ? `read back "${body.trim()}"` : `doc contained: ${JSON.stringify(body.slice(0, 40))}`);

	// Window-follow across an app switch — the OAuth-handoff proxy.
	await osa('tell application "Calculator" to activate');
	await osa('tell application "System Events" to tell process "Calculator" to set frontmost to true');
	await sleep(1500);
	const followedSwitch = !!lastWindow && /calculator/i.test(lastWindow.app);
	line(followedSwitch, "engine followed a frontmost-app switch", `apps seen: ${seenApps.join(", ") || "none"}`);

	engine.close();
	await osa('tell application "Calculator" to quit').catch(() => {});

	console.log("");
	const injectionKnown = followedTextEdit; // injection result only meaningful if we were on TextEdit
	if (!injectionKnown) {
		console.log("NOTE: engine never reported TextEdit frontmost, so the injection result is inconclusive,");
		console.log("      not a true fail — check Screen Recording + Accessibility grants for this terminal.");
	}
	const allPass = followedTextEdit && landed && followedSwitch;
	console.log(allPass ? "\x1b[32mall checks passed\x1b[0m" : "\x1b[33msome checks did not pass — see above\x1b[0m");
	process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
	console.error(`e2e failed to run: ${err}`);
	process.exit(2);
});
