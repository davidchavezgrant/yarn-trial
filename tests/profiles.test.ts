import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { capturePaths, clearOperatorData, describeAuthClear, describeSwap, livePaths, profileDir, readOwners, swapProfile } from "../src/fleet/runner/profiles.js";

/**
 * Per-operator app data, entirely on temp directories.
 *
 * Nothing here goes near a real `~/Library`, and `quit` is always injected — the default one
 * would tell a live app to exit, and these tests run on a machine that is also the hub.
 *
 * The assertions worth the most are the ones about SESSION LEAKAGE: the whole point of the
 * module is that operator B never sees operator A's signed-in app, so a test that only checks
 * "some files moved" would pass on a version that leaks. Each swap test therefore checks the
 * actual content that ends up live, not just the shape of the result.
 */

const HOME_REL = "Library/Application Support/Yarn";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "profiles-test-"));
}

/** A home directory with the app's data dir holding one identifying string. */
function home(session?: string): string {
	const dir = tmp();
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

/** Records that it was called, so "did anything quit the app" is assertable. */
function quitter(log: string[] = []) {
	return { log, quit: async (app: string) => void log.push(app) };
}

// ── path derivation ──────────────────────────────────────────────────────────────────────

test("livePaths__CoversBothConventions__When__ABundleIdIsKnown", () => {
	const p = livePaths({ name: "Yarn", bundleId: "com.yarn.desktop" });
	assert.ok(p.includes("Library/Application Support/Yarn"), "Electron names its dir after the app");
	assert.ok(p.includes("Library/Preferences/com.yarn.desktop.plist"), "macOS keys preferences on the bundle id");
	assert.ok(p.includes("Library/Saved Application State/com.yarn.desktop.savedState"));
});

test("livePaths__StillCoversTheAppSupportDir__When__NoBundleIdResolved", () => {
	assert.ok(livePaths({ name: "Yarn" }).includes("Library/Application Support/Yarn"));
});

/** An app named after its own bundle id must not produce the same path twice. */
test("livePaths__ReturnsNoDuplicates__When__TheNameEqualsTheBundleId", () => {
	const p = livePaths({ name: "com.acme.app", bundleId: "com.acme.app" });
	assert.equal(p.length, new Set(p).size);
});

/**
 * The name reaches here from a dispatch parameter. A separator in it would let a candidate path
 * escape the `~/Library` tree, and every one of these paths is later fed to a recursive move.
 */
test("livePaths__DropsTheIdentifier__When__ItContainsAPathSeparator", () => {
	assert.deepEqual(livePaths({ name: "../../etc" }), []);
});

test("livePaths__ExcludesDotSegments__When__AppNameIsTraversal", () => {
	// "Library/Application Support/.." IS ~/Library. An app named ".." — no separator, so the
	// old filter passed it — would hand the swap the operator's entire Library to move into
	// the profile store.
	assert.deepEqual(livePaths({ name: ".." }), []);
	assert.deepEqual(livePaths({ name: "." }), []);
	assert.deepEqual(livePaths({ name: "Yarn", bundleId: ".." }).filter((p) => p.split("/").includes("..")), []);
});

test("capturePaths__ReturnsOnlyWhatExists__When__MostLocationsAreUnused", () => {
	const dir = home("a");
	assert.deepEqual(capturePaths({ name: "Yarn" }, dir), [HOME_REL]);
});

// ── first use ────────────────────────────────────────────────────────────────────────────

/**
 * Turning this on must not sign the fleet out. The Macs already have hand-signed-in apps and
 * that state is expensive; the first operator to run inherits it rather than losing it.
 */
test("swapProfile__ClaimsTheLiveData__When__NoOwnerIsRecordedYet", async () => {
	const h = home("alice-session");
	const root = tmp();
	const q = quitter();

	const r = await swapProfile({ app: "Yarn", operator: "alice", home: h, root, quit: q.quit });

	assert.equal(r.action, "adopted");
	assert.equal(liveSession(h), "alice-session", "adoption must not disturb the live data");
	assert.deepEqual(q.log, [], "nothing needs quitting when nothing moves");
	assert.equal(readOwners(root).yarn, "alice");
});

test("swapProfile__ReportsFresh__When__TheFirstOperatorMeetsAnAppWithNoData", async () => {
	const r = await swapProfile({ app: "Yarn", operator: "alice", home: home(), root: tmp(), quit: quitter().quit });
	assert.equal(r.fresh, true);
});

// ── the same operator again ──────────────────────────────────────────────────────────────

test("swapProfile__MovesNothing__When__TheSameOperatorRunsAgain", async () => {
	const h = home("alice-session");
	const root = tmp();
	const q = quitter();
	await swapProfile({ app: "Yarn", operator: "alice", home: h, root, quit: q.quit });

	const r = await swapProfile({ app: "Yarn", operator: "alice", home: h, root, quit: q.quit });

	assert.equal(r.action, "kept");
	assert.equal(r.fresh, false, "a returning operator is never asked to sign in");
	assert.equal(liveSession(h), "alice-session");
	assert.deepEqual(q.log, [], "a repeat request must not restart the app");
});

/** Operator names arrive from env or a login name; they must compare as one person regardless. */
test("swapProfile__TreatsThemAsTheSamePerson__When__TheNameDiffersOnlyInCase", async () => {
	const h = home("alice-session");
	const root = tmp();
	await swapProfile({ app: "Yarn", operator: "alice", home: h, root, quit: quitter().quit });

	assert.equal((await swapProfile({ app: "Yarn", operator: "Alice", home: h, root, quit: quitter().quit })).action, "kept");
});

// ── a different operator ─────────────────────────────────────────────────────────────────

test("swapProfile__ParksTheOwnersDataAndStartsFresh__When__ANewOperatorRequests", async () => {
	const h = home("alice-session");
	const root = tmp();
	const q = quitter();
	await swapProfile({ app: "Yarn", operator: "alice", home: h, root, quit: q.quit });

	const r = await swapProfile({ app: "Yarn", operator: "bob", home: h, root, quit: q.quit });

	assert.equal(r.action, "swapped");
	assert.equal(r.previousOwner, "alice");
	assert.equal(r.fresh, true, "bob has no stored profile, so the app must need signing in");
	assert.equal(liveSession(h), undefined, "bob must not inherit alice's session");
	assert.deepEqual(q.log, ["Yarn"], "the app has to be down before its cookie jar moves");
	assert.equal(readOwners(root).yarn, "bob");
});

/**
 * The headline requirement: sign in once, and it is still yours after someone else has used the
 * Mac in between.
 */
test("swapProfile__RestoresTheirOwnSession__When__AnEarlierOperatorReturns", async () => {
	const h = home("alice-session");
	const root = tmp();
	await swapProfile({ app: "Yarn", operator: "alice", home: h, root, quit: quitter().quit });
	await swapProfile({ app: "Yarn", operator: "bob", home: h, root, quit: quitter().quit });
	// Bob signs in; his session is what is live now.
	fs.mkdirSync(path.join(h, HOME_REL), { recursive: true });
	fs.writeFileSync(path.join(h, HOME_REL, "session.json"), "bob-session");

	const back = await swapProfile({ app: "Yarn", operator: "alice", home: h, root, quit: quitter().quit });

	assert.equal(back.fresh, false, "alice signed in once already");
	assert.deepEqual(back.restored, [HOME_REL]);
	assert.equal(liveSession(h), "alice-session");
	assert.equal(
		fs.readFileSync(path.join(profileDir(root, "bob", "yarn"), HOME_REL, "session.json"), "utf8"),
		"bob-session",
		"and bob's is parked, not destroyed",
	);
});

test("swapProfile__KeepsEachAppSeparate__When__OneOperatorOwnsAnother", async () => {
	const h = home("alice-session");
	fs.mkdirSync(path.join(h, "Library/Application Support/Chrome"), { recursive: true });
	fs.writeFileSync(path.join(h, "Library/Application Support/Chrome/session.json"), "alice-chrome");
	const root = tmp();
	await swapProfile({ app: "Yarn", operator: "alice", home: h, root, quit: quitter().quit });
	await swapProfile({ app: "Chrome", operator: "alice", home: h, root, quit: quitter().quit });

	await swapProfile({ app: "Yarn", operator: "bob", home: h, root, quit: quitter().quit });

	assert.equal(readOwners(root).chrome, "alice", "swapping Yarn must not touch who owns Chrome");
	assert.equal(
		fs.readFileSync(path.join(h, "Library/Application Support/Chrome/session.json"), "utf8"),
		"alice-chrome",
		"nor Chrome's live data",
	);
});

/** Three-way, because two operators can hide an ordering bug that a third exposes. */
test("swapProfile__KeepsAllThreeSeparate__When__ThreeOperatorsInterleave", async () => {
	const h = home();
	const root = tmp();
	for (const who of ["alice", "bob", "carol"]) {
		await swapProfile({ app: "Yarn", operator: who, home: h, root, quit: quitter().quit });
		fs.mkdirSync(path.join(h, HOME_REL), { recursive: true });
		fs.writeFileSync(path.join(h, HOME_REL, "session.json"), `${who}-session`);
	}

	for (const who of ["alice", "bob", "carol"]) {
		await swapProfile({ app: "Yarn", operator: who, home: h, root, quit: quitter().quit });
		assert.equal(liveSession(h), `${who}-session`, `${who} got the wrong session back`);
	}
});

/** A path the outgoing operator stopped using must not be restored from a stale manifest. */
test("swapProfile__RewritesTheManifest__When__TheOwnersPathsChangedSinceLastTime", async () => {
	const h = home("alice-session");
	const root = tmp();
	fs.mkdirSync(path.join(h, "Library/Caches/Yarn"), { recursive: true });
	fs.writeFileSync(path.join(h, "Library/Caches/Yarn/x"), "cache");
	await swapProfile({ app: "Yarn", operator: "alice", home: h, root, quit: quitter().quit });
	await swapProfile({ app: "Yarn", operator: "bob", home: h, root, quit: quitter().quit });
	// Alice comes back, and this time the cache is gone before she hands over again.
	await swapProfile({ app: "Yarn", operator: "alice", home: h, root, quit: quitter().quit });
	fs.rmSync(path.join(h, "Library/Caches/Yarn"), { recursive: true });

	await swapProfile({ app: "Yarn", operator: "bob", home: h, root, quit: quitter().quit });
	const back = await swapProfile({ app: "Yarn", operator: "alice", home: h, root, quit: quitter().quit });

	assert.deepEqual(back.restored, [HOME_REL]);
	assert.equal(fs.existsSync(path.join(h, "Library/Caches/Yarn")), false);
});

// ── hardening ────────────────────────────────────────────────────────────────────────────

/** `YARN_OPERATOR` is operator-supplied and ends up as a directory name. */
test("swapProfile__ContainsTheProfile__When__TheOperatorNameLooksLikeAPath", async () => {
	const root = tmp();
	await swapProfile({ app: "Yarn", operator: "../../etc", home: home("x"), root, quit: quitter().quit });
	const owner = Object.values(readOwners(root))[0];
	assert.ok(!owner.includes(".."), `operator name escaped: ${owner}`);
	assert.ok(profileDir(root, "../../etc", "yarn").startsWith(root));
});

/**
 * The manifest is a plain file on disk that anything could have edited, and every path in it
 * is fed to a recursive move joined against the home directory. An entry that traverses must
 * be skipped — its data stays parked, which is the safe direction — never resolved.
 */
test("swapProfile__RefusesTheManifestEntry__When__ItEscapesTheProfileStore", async () => {
	const h = home("bob-session");
	const root = tmp();
	await swapProfile({ app: "Yarn", operator: "bob", home: h, root, quit: quitter().quit });

	// Alice's stored profile, built by hand the way a tampered one would look: one honest
	// entry, one that walks out of her profile directory.
	const mine = profileDir(root, "alice", "yarn");
	fs.mkdirSync(path.join(mine, HOME_REL), { recursive: true });
	fs.writeFileSync(path.join(mine, HOME_REL, "session.json"), "alice-session");
	fs.writeFileSync(path.join(root, "escape-hatch"), "loot");
	fs.writeFileSync(
		path.join(mine, "manifest.json"),
		JSON.stringify({ app: "Yarn", operator: "alice", storedAt: new Date().toISOString(), paths: ["../../escape-hatch", HOME_REL] }),
	);

	const back = await swapProfile({ app: "Yarn", operator: "alice", home: h, root, quit: quitter().quit });

	assert.deepEqual(back.restored, [HOME_REL], "only the contained entry may move");
	assert.equal(liveSession(h), "alice-session");
	assert.equal(fs.readFileSync(path.join(root, "escape-hatch"), "utf8"), "loot", "the traversing source is untouched");
	assert.equal(fs.existsSync(path.join(h, "..", "..", "escape-hatch")), false, "nothing landed outside the home directory");
});

test("readOwners__ReturnsEmpty__When__TheFileIsAbsent", () => {
	assert.deepEqual(readOwners(tmp()), {});
});

test("describeSwap__NamesBothOperatorsAndTheSignin__When__AFreshOperatorTookOver", () => {
	const line = describeSwap({ action: "swapped", app: "Yarn", operator: "bob", previousOwner: "alice", stashed: ["a"], restored: [], fresh: true });
	assert.match(line, /alice → bob/);
	assert.match(line, /signing in/);
});

// ── signing out ──────────────────────────────────────────────────────────────────────────

test("clearOperatorData__DeletesLiveDataAndOwnership__When__TheRequesterOwnsTheLiveCopy", async () => {
	const root = tmp();
	const h = home("alice-session");
	// alice adopts the live data — the ordinary first-use-on-this-Mac path.
	await swapProfile({ app: "Yarn", operator: "alice", home: h, root, quit: quitter().quit });

	const q = quitter();
	const cleared = await clearOperatorData({ app: "Yarn", operator: "alice", home: h, root, quit: q.quit });

	// Quit BEFORE the delete: a running app writes its cookie jar back out on exit, which
	// resurrects the exact session this verb exists to destroy.
	assert.deepEqual(q.log, ["Yarn"]);
	assert.deepEqual(cleared.removedLive, [HOME_REL]);
	assert.equal(cleared.ownershipCleared, true);
	assert.equal(liveSession(h), undefined, "the live session is gone");
	assert.equal(readOwners(root).yarn, undefined, "nobody owns the app any more");
});

test("clearOperatorData__LeavesTheLiveCopyAlone__When__AnotherOperatorOwnsIt", async () => {
	const root = tmp();
	const h = home("alice-session");
	await swapProfile({ app: "Yarn", operator: "alice", home: h, root, quit: quitter().quit });
	// bob has only a parked profile — the state a previous swap leaves behind.
	const parked = profileDir(root, "bob", "yarn");
	fs.mkdirSync(path.join(parked, HOME_REL), { recursive: true });
	fs.writeFileSync(path.join(parked, HOME_REL, "session.json"), "bob-parked");

	const q = quitter();
	const cleared = await clearOperatorData({ app: "Yarn", operator: "bob", home: h, root, quit: q.quit });

	// This is the isolation promise applied to deletion: bob signing out must not sign alice out.
	assert.equal(liveSession(h), "alice-session", "alice's live session is untouched");
	assert.equal(readOwners(root).yarn, "alice");
	assert.deepEqual(cleared.removedLive, []);
	assert.equal(cleared.liveOwner, "alice");
	assert.equal(cleared.ownershipCleared, false);
	assert.equal(cleared.removedProfile, "bob/yarn");
	assert.equal(fs.existsSync(parked), false, "bob's parked profile is gone");
	// No live data goes, so nothing needed quitting — the app may be mid-use by alice.
	assert.deepEqual(q.log, []);
});

test("clearOperatorData__LeavesUnownedLiveData__When__NobodyHasClaimedIt", async () => {
	// Pre-feature sign-ins live as unowned data until someone adopts them. Deleting them on a
	// sign-out from someone who never owned anything would destroy a session that is not theirs.
	const root = tmp();
	const h = home("somebody-was-here");
	const cleared = await clearOperatorData({ app: "Yarn", operator: "carol", home: h, root, quit: quitter().quit });

	assert.equal(liveSession(h), "somebody-was-here");
	assert.deepEqual(cleared.removedLive, []);
	assert.equal(cleared.liveOwner, undefined, "there is no owner to name");
	assert.match(describeAuthClear(cleared), /nothing was stored/);
});

test("clearOperatorData__Refuses__When__TheAppSlugCannotNameADirectory", async () => {
	// appSlug folds separators, but passes bare dot segments through — and profileDir(root, op, "..")
	// resolves to the operator's whole profile tree, which this function deletes.
	await assert.rejects(
		() => clearOperatorData({ app: "..", operator: "alice", home: tmp(), root: tmp(), quit: quitter().quit }),
		/slug/,
	);
});
