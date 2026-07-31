import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { profileDirs, resetBrowserProfiles } from "../src/remote/runner/browser-reset.js";

/**
 * Offline by construction: every process call is injected, and the only filesystem writes are
 * into temp directories these tests create. Nothing here may signal a real Chrome or touch a
 * real profile — the verb under test deletes credentials for a living.
 */

function chromeTree(root: string, profiles: string[], junk: string[] = []): string {
	const chrome = path.join(root, "Library", "Application Support", "Google", "Chrome");
	for (const p of profiles) {
		fs.mkdirSync(path.join(chrome, p), { recursive: true });
		fs.writeFileSync(path.join(chrome, p, "Preferences"), "{}");
		fs.writeFileSync(path.join(chrome, p, "Login Data"), "sqlite");
	}
	// Caches and component dirs, which have no Preferences and must survive.
	for (const j of junk) fs.mkdirSync(path.join(chrome, j), { recursive: true });
	fs.writeFileSync(path.join(chrome, "Local State"), "{}");

	return chrome;
}

function inTemp(fn: (home: string) => void | Promise<void>): Promise<void> | void {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-reset-"));
	const done = () => fs.rmSync(home, { recursive: true, force: true });
	try {
		const r = fn(home);

		return r instanceof Promise ? r.finally(done) : void done();
	} catch (e) {
		done();
		throw e;
	}
}

test("profileDirs__FindsOnlyProfiles__When__TheRootIsFullOfCaches", () => {
	inTemp((home) => {
		// Chrome's user-data root holds ~40 non-profile directories. Deleting it wholesale would
		// take the install state with it; `Preferences` is the marker Chrome itself uses.
		const chrome = chromeTree(home, ["Default", "Profile 1", "System Profile"], ["ShaderCache", "Crashpad", "Safe Browsing"]);
		const found = profileDirs(chrome).map((d) => path.basename(d));

		assert.deepEqual(found, ["Default", "Profile 1", "System Profile"]);
	});
});

test("profileDirs__ReturnsNothing__When__ChromeWasNeverRun", () => {
	inTemp((home) => {
		// A Mac with no Chrome data is a clean state, not an error to report.
		assert.deepEqual(profileDirs(path.join(home, "nope")), []);
	});
});

test("resetBrowserProfiles__RemovesEveryProfile__When__ChromeIsAlreadyClosed", async () => {
	await inTemp(async (home) => {
		const chrome = chromeTree(home, ["Default", "Profile 1"], ["ShaderCache"]);
		const out = await resetBrowserProfiles({ home, pids: async () => [] });

		assert.deepEqual(out.removed.sort(), ["Default", "Profile 1"]);
		assert.equal(out.quitChrome, false, "nothing to quit");
		assert.equal(fs.existsSync(path.join(chrome, "Default")), false);
		// The caches and Chrome's own machine-level file are not ours to delete.
		assert.equal(fs.existsSync(path.join(chrome, "ShaderCache")), true);
		assert.equal(fs.existsSync(path.join(chrome, "Local State")), true);
	});
});

test("resetBrowserProfiles__QuitsFirst__When__ChromeIsRunning", async () => {
	await inTemp(async (home) => {
		chromeTree(home, ["Default"]);
		const termed: number[][] = [];
		let alive = [4242];
		const out = await resetBrowserProfiles({
			home,
			pids: async () => alive,
			term: async (p) => {
				termed.push(p);
				alive = []; // it exits, as a well-behaved Chrome does on TERM
			},
			sleep: async () => {},
		});

		// The ordering IS the safety property: a live Chrome holds these databases open and
		// writes them back on quit, so a delete underneath it resurrects what we removed.
		assert.deepEqual(termed, [[4242]]);
		assert.equal(out.quitChrome, true);
		assert.deepEqual(out.removed, ["Default"]);
	});
});

test("resetBrowserProfiles__RefusesAndTouchesNothing__When__ChromeWillNotDie", async () => {
	await inTemp(async (home) => {
		const chrome = chromeTree(home, ["Default", "Profile 1"]);
		const removedDirs: string[] = [];
		const out = await resetBrowserProfiles({
			home,
			// Never exits — a wedged browser, or one relaunched by something else.
			pids: async () => [99],
			term: async () => {},
			sleep: async () => {},
			rm: (d) => removedDirs.push(d),
		});

		assert.match(out.refused ?? "", /still running/);
		assert.deepEqual(out.removed, [], "refusing means NOTHING was deleted");
		assert.deepEqual(removedDirs, []);
		assert.equal(fs.existsSync(path.join(chrome, "Default")), true);
	});
});
