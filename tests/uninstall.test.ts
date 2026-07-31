import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deleteAppBundle, describeAppDelete, safeBundleName } from "../src/fleet/runner/uninstall.js";

/**
 * Uninstalling an app, entirely on temp directories: `appDirs`, `home`, the profile store and
 * `quit` are all injected, so nothing here goes near /Applications, ~/Library or a live
 * process. `home` is NOT optional in these tests — the live-data sweep defaults it to
 * os.homedir(), and a test that omits it would delete the developer's real app data for
 * whatever name it made up. The assertions that matter most are the refusals — this module's
 * output feeds `rm -rf`, so the property under test is what it will NOT delete.
 */

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "uninstall-test-"));
}

/** A quit recorder, so "the app was gone before its bundle was" is assertable. */
function quitter(log: string[] = []) {
	return { log, quit: async (app: string) => void log.push(app) };
}

test("safeBundleName__StripsTheSuffix__When__GivenADotApp", () => {
	// "Yarn.app" and "Yarn" are the same request — the equivalence install.ts already grants.
	assert.equal(safeBundleName("Yarn.app"), "Yarn");
	assert.equal(safeBundleName("  Notion Calendar  "), "Notion Calendar");
});

test("safeBundleName__Refuses__When__TheNameIsNotAPlainSegment", () => {
	// Every one of these would otherwise become a path segment handed to a recursive delete.
	for (const bad of ["", "  ", "../Safari", "a/b", "a\\b", ".", "..", ".hidden", "x..y", ".app"])
		assert.throws(() => safeBundleName(bad), Error, `${JSON.stringify(bad)} must be refused`);
});

test("deleteAppBundle__RemovesBundleAndEveryParkedProfile__When__ItExists", async () => {
	const apps = tmp();
	const store = tmp();
	fs.mkdirSync(path.join(apps, "Yarn.app", "Contents"), { recursive: true });
	fs.writeFileSync(path.join(apps, "Yarn.app", "Contents", "Info.plist"), "x");
	// Two operators parked Yarn; alice also parked Chrome, which must survive; owners.json at
	// the store root is a file and must not read as an operator directory.
	for (const op of ["alice", "bob"]) fs.mkdirSync(path.join(store, op, "yarn"), { recursive: true });
	fs.mkdirSync(path.join(store, "alice", "chrome"), { recursive: true });
	fs.writeFileSync(path.join(store, "owners.json"), "{}");

	const q = quitter();
	const res = await deleteAppBundle({ app: "Yarn.app", appDirs: [apps], root: store, quit: q.quit, home: tmp() });

	assert.deepEqual(q.log, ["Yarn"], "quit first, under the stem name — a live app out of a half-deleted bundle crashes");
	assert.equal(res.bundle, path.join(apps, "Yarn.app"));
	assert.equal(fs.existsSync(path.join(apps, "Yarn.app")), false);
	assert.deepEqual(res.removedProfiles.sort(), ["alice/yarn", "bob/yarn"]);
	assert.equal(fs.existsSync(path.join(store, "alice", "chrome")), true, "another app's parked profile stays");
	assert.match(describeAppDelete(res), /2 parked profile/);
});

test("deleteAppBundle__RemovesLiveDataAndOwnership__When__TheAppHasASession", async () => {
	// The orphaned-session half: an app that is gone must not leave a signed-in cookie jar
	// under ~/Library for a future reinstall to silently adopt, nor an owners.json row
	// describing directories that no longer exist.
	const apps = tmp();
	const store = tmp();
	const home = tmp();
	fs.mkdirSync(path.join(apps, "Yarn.app"), { recursive: true });
	fs.mkdirSync(path.join(home, "Library", "Application Support", "Yarn"), { recursive: true });
	fs.mkdirSync(path.join(home, "Library", "Caches", "com.yarn.app"), { recursive: true });
	fs.mkdirSync(path.join(home, "Library", "Application Support", "Chrome"), { recursive: true });
	fs.mkdirSync(store, { recursive: true });
	fs.writeFileSync(path.join(store, "owners.json"), JSON.stringify({ yarn: "alice", chrome: "bob" }));

	const res = await deleteAppBundle({ app: "Yarn", appDirs: [apps], root: store, quit: quitter().quit, home, bundleId: "com.yarn.app" });

	assert.deepEqual(res.removedLive.sort(), ["Library/Application Support/Yarn", "Library/Caches/com.yarn.app"]);
	assert.equal(fs.existsSync(path.join(home, "Library", "Application Support", "Yarn")), false);
	assert.equal(fs.existsSync(path.join(home, "Library", "Caches", "com.yarn.app")), false);
	assert.equal(fs.existsSync(path.join(home, "Library", "Application Support", "Chrome")), true, "another app's live data stays");
	assert.equal(res.ownershipCleared, true);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store, "owners.json"), "utf8")), { chrome: "bob" });
	assert.match(describeAppDelete(res), /2 live path/);
});

test("deleteAppBundle__FallsToTheSecondRoot__When__TheFirstLacksTheBundle", async () => {
	// The two production roots are /Applications and ~/Applications, in that order — the same
	// pair the installer writes into when the system-wide one is not writable.
	const system = tmp();
	const user = tmp();
	fs.mkdirSync(path.join(user, "Thing.app"), { recursive: true });

	const res = await deleteAppBundle({ app: "Thing", appDirs: [system, user], root: tmp(), quit: quitter().quit, home: tmp() });

	assert.equal(res.bundle, path.join(user, "Thing.app"));
	assert.equal(fs.existsSync(path.join(user, "Thing.app")), false);
});

test("deleteAppBundle__Refuses__When__TheBundleDoesNotExist", async () => {
	// A refusal, not a no-op: "deleted" answered for a typo hides the miss until a run fails.
	const q = quitter();
	await assert.rejects(() => deleteAppBundle({ app: "Ghost", appDirs: [tmp()], root: tmp(), quit: q.quit, home: tmp() }), /is not in/);
	assert.deepEqual(q.log, [], "nothing is quit over a bundle that was never there");
});

test("deleteAppBundle__Refuses__When__ThePathWouldLandUnderSystem", async () => {
	// Production never searches /System, so this is the belt-and-braces guard for an injected
	// root. Safari genuinely exists there on the Mac running this suite, which is what makes
	// the guard — not the presence check — the thing that refuses.
	const q = quitter();
	await assert.rejects(
		() => deleteAppBundle({ app: "Safari", appDirs: ["/System/Applications"], root: tmp(), quit: q.quit, home: tmp() }),
		/\/System is not ours|is not in/,
	);
	assert.deepEqual(q.log, [], "the OS's own bundle is never even quit");
});

test("deleteAppBundle__SweepsNothing__When__TheProfileStoreDoesNotExistYet", async () => {
	const apps = tmp();
	fs.mkdirSync(path.join(apps, "Yarn.app"), { recursive: true });

	const res = await deleteAppBundle({ app: "Yarn", appDirs: [apps], root: path.join(tmp(), "never-created"), quit: quitter().quit, home: tmp() });

	assert.deepEqual(res.removedProfiles, []);
});
