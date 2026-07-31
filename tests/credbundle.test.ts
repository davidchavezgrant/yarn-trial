import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { exportProfile, importProfile } from "../src/remote/runner/credbundle.js";
import { currentOwner, profileDir, readOwners, swapProfile } from "../src/remote/runner/profiles.js";
import { unpackInto } from "../src/remote/runner/tarball.js";

/**
 * The runner's export/import of a session, using the REAL `tar` on this machine so a bundle is
 * proven to survive an actual pack/unpack round trip rather than a stubbed one.
 *
 * The single most important assertion here is the SECURITY one: `exportProfile` must never tar a
 * session the requesting operator does not own. When someone else owns the live copy, the cookie
 * jar under $HOME is THEIR credential — a version that tarred it would seal one operator's session
 * into another's vault bundle. `export__RefusesOthersLiveSession` is the test that fails on that.
 */

const HOME_REL = "Library/Application Support/Yarn";

function tmp(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function home(session?: string): string {
	const dir = tmp("home");
	if (session !== undefined) {
		fs.mkdirSync(path.join(dir, HOME_REL), { recursive: true });
		fs.writeFileSync(path.join(dir, HOME_REL, "session.json"), session);
	}

	return dir;
}

function liveSession(dir: string): string | undefined {
	try {
		return fs.readFileSync(path.join(dir, HOME_REL, "session.json"), "utf8");
	} catch {
		return undefined;
	}
}

const noQuit = async (): Promise<void> => {};

test("exportProfile__TarsTheLiveSession__When__OperatorOwnsIt", async () => {
	const h = home("dave-session");
	const root = tmp("store");
	// Dave owns the live copy: adopt it via a swap on a fresh store.
	await swapProfile({ app: "Yarn", operator: "dave", home: h, root, quit: noQuit });
	assert.equal(currentOwner(root, "Yarn"), "dave");

	const out = path.join(tmp("stage"), "dave.tar.gz");
	const res = await exportProfile({ app: "Yarn", operator: "dave", outFile: out, home: h, root, quit: noQuit });
	assert.equal(res.found, true);
	assert.equal(res.source, "live");
	assert.ok(fs.existsSync(out) && fs.statSync(out).size > 0);
	// The live session is untouched — export copies, it does not move.
	assert.equal(liveSession(h), "dave-session");
});

test("exportProfile__RefusesOthersLiveSession__When__CallerDoesNotOwnIt", async () => {
	const h = home("eve-session");
	const root = tmp("store");
	// Eve owns the live copy. Dave has never signed in here.
	await swapProfile({ app: "Yarn", operator: "eve", home: h, root, quit: noQuit });
	assert.equal(currentOwner(root, "Yarn"), "eve");

	const out = path.join(tmp("stage"), "dave.tar.gz");
	const res = await exportProfile({ app: "Yarn", operator: "dave", outFile: out, home: h, root, quit: noQuit });
	assert.equal(res.found, false, "Dave has no session here — Eve's live session must NOT be exported as Dave's");
	assert.equal(res.source, "none");
	assert.ok(!fs.existsSync(out), "and nothing was written");
});

test("exportProfile__QuitsBeforeSnapshot__So__TheBundleReflectsTheFlushedProfile", async () => {
	const h = home("mid-write");
	const root = tmp("store");
	await swapProfile({ app: "Yarn", operator: "dave", home: h, root, quit: noQuit });

	// A quit that flushes, exactly as a graceful app quit does: it rewrites the live session to its
	// final consistent value. If export snapshotted BEFORE the quit, the bundle would still hold
	// "mid-write"; capturing AFTER the quit holds "flushed". This is the torn-DB fix asserted as an
	// ordering property — the reason a hot copy of a running Chromium profile crash-loops on restore.
	let quitCalled = false;
	const quit = async (): Promise<void> => {
		quitCalled = true;
		fs.writeFileSync(path.join(h, HOME_REL, "session.json"), "flushed");
	};
	const out = path.join(tmp("stage"), "dave.tar.gz");
	await exportProfile({ app: "Yarn", operator: "dave", outFile: out, home: h, root, quit });
	assert.ok(quitCalled, "the app was quit before snapshotting");

	const dst = tmp("unpack");
	await unpackInto(out, dst);
	assert.equal(fs.readFileSync(path.join(dst, HOME_REL, "session.json"), "utf8"), "flushed", "the bundle captured the post-quit, flushed state");
});

test("importProfile__RoundTripsASession__When__PushedToAFreshBox", async () => {
	// Box A: Dave signs in, export his session.
	const hA = home("dave-real-session");
	const rootA = tmp("storeA");
	await swapProfile({ app: "Yarn", operator: "dave", home: hA, root: rootA, quit: noQuit });
	const bundle = path.join(tmp("stage"), "dave.tar.gz");
	const exp = await exportProfile({ app: "Yarn", operator: "dave", outFile: bundle, home: hA, root: rootA, quit: noQuit });
	assert.equal(exp.found, true);

	// Box B: factory-fresh, nobody signed in. Import Dave's bundle.
	const hB = home(); // no session
	const rootB = tmp("storeB");
	const imp = await importProfile({ app: "Yarn", operator: "dave", tarFile: bundle, home: hB, root: rootB, quit: noQuit });

	assert.equal(imp.install.action, "installed");
	assert.equal(liveSession(hB), "dave-real-session", "Dave's session is now live on box B");
	assert.equal(currentOwner(rootB, "Yarn"), "dave");
});

test("importProfile__ParksTheOtherOperator__When__BoxIsOwnedBySomeoneElse", async () => {
	// Box B currently belongs to Eve, signed in.
	const hB = home("eve-on-B");
	const rootB = tmp("storeB");
	await swapProfile({ app: "Yarn", operator: "eve", home: hB, root: rootB, quit: noQuit });

	// A bundle for Dave arrives (built on box A).
	const hA = home("dave-on-A");
	const rootA = tmp("storeA");
	await swapProfile({ app: "Yarn", operator: "dave", home: hA, root: rootA, quit: noQuit });
	const bundle = path.join(tmp("stage"), "dave.tar.gz");
	await exportProfile({ app: "Yarn", operator: "dave", outFile: bundle, home: hA, root: rootA, quit: noQuit });

	const imp = await importProfile({ app: "Yarn", operator: "dave", tarFile: bundle, home: hB, root: rootB, quit: noQuit });
	assert.equal(imp.install.action, "installed");
	assert.equal(imp.install.previousOwner, "eve");
	assert.equal(liveSession(hB), "dave-on-A", "Dave's session is live");
	assert.equal(currentOwner(rootB, "Yarn"), "dave");

	// Eve was PARKED, not lost: swapping her back restores her exact session.
	const back = await swapProfile({ app: "Yarn", operator: "eve", home: hB, root: rootB, quit: noQuit });
	assert.equal(back.action, "swapped");
	assert.equal(liveSession(hB), "eve-on-B", "Eve's session survived Dave's checkout intact");
});

test("importProfile__SkipsOwned__When__OperatorAlreadyOwnsTheBox", async () => {
	// Dave already owns box B with a (possibly fresher) local session. A checkout must not clobber it.
	const hB = home("dave-local-fresh");
	const rootB = tmp("storeB");
	await swapProfile({ app: "Yarn", operator: "dave", home: hB, root: rootB, quit: noQuit });

	const hA = home("dave-stale-from-vault");
	const rootA = tmp("storeA");
	await swapProfile({ app: "Yarn", operator: "dave", home: hA, root: rootA, quit: noQuit });
	const bundle = path.join(tmp("stage"), "dave.tar.gz");
	await exportProfile({ app: "Yarn", operator: "dave", outFile: bundle, home: hA, root: rootA, quit: noQuit });

	const imp = await importProfile({ app: "Yarn", operator: "dave", tarFile: bundle, home: hB, root: rootB, quit: noQuit });
	assert.equal(imp.install.action, "skipped-owned");
	assert.equal(liveSession(hB), "dave-local-fresh", "the local session is preferred — checkout does not overwrite it");
});
