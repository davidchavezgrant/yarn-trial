import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	bundlePath,
	bundleSource,
	forget,
	getBundle,
	ledgerEntryFor,
	ledgerKey,
	loadOrCreateKey,
	openBytes,
	putBundle,
	readAudit,
	readLedger,
	recordCheckin,
	recordProbe,
	sealBytes,
	sha256,
} from "../src/remote/control/credstore.js";

/**
 * The vault, entirely on temp directories.
 *
 * The assertions that matter most are the ones that would still let a broken vault "work": that a
 * bundle sealed under one key does NOT open under another (confidentiality), that a moved bundle
 * only teaches portability when it actually moved (no false `roams`), and that a readiness failure
 * checked in as `signed out` is preserved rather than smoothed into a healthy-looking holder — the
 * ledger fact a later checkout depends on to not push a dead session.
 */

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "credstore-test-"));
}

const KEY = Buffer.alloc(32, 7);

// ── crypto ───────────────────────────────────────────────────────────────────────────────

test("sealBytes__RoundTrips__When__SameKey", () => {
	const plain = Buffer.from("cookie-jar-bytes");
	assert.deepEqual(openBytes(KEY, sealBytes(KEY, plain)), plain);
});

test("openBytes__Throws__When__WrongKey", () => {
	const blob = sealBytes(KEY, Buffer.from("secret"));
	assert.throws(() => openBytes(Buffer.alloc(32, 9), blob));
});

test("openBytes__Throws__When__BlobTampered", () => {
	const blob = sealBytes(KEY, Buffer.from("secret session"));
	blob[blob.length - 1] ^= 0xff; // flip a ciphertext byte — GCM tag must reject it
	assert.throws(() => openBytes(KEY, blob));
});

test("sealBytes__ProducesDifferentCiphertext__When__SamePlaintext", () => {
	const p = Buffer.from("same");
	assert.notDeepEqual(sealBytes(KEY, p), sealBytes(KEY, p), "a fresh IV per seal means no two ciphertexts match");
});

// ── key discipline ───────────────────────────────────────────────────────────────────────

test("loadOrCreateKey__Creates0600File__When__NoneAndNoEnv", () => {
	const root = tmp();
	const key = loadOrCreateKey(root, {});
	assert.equal(key.length, 32);
	const file = path.join(root, "vault.key");
	assert.equal(fs.readFileSync(file).length, 32);
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(loadOrCreateKey(root, {}), key, "the key is stable across calls");
});

test("loadOrCreateKey__UsesEnv__When__YarnVaultKeySet", () => {
	const hex = "aa".repeat(32);
	const key = loadOrCreateKey(tmp(), { YARN_VAULT_KEY: hex });
	assert.equal(key.toString("hex"), hex);
});

test("loadOrCreateKey__Throws__When__EnvKeyMalformed", () => {
	assert.throws(() => loadOrCreateKey(tmp(), { YARN_VAULT_KEY: "not-hex" }));
	assert.throws(() => loadOrCreateKey(tmp(), { YARN_VAULT_KEY: "aa" }), /64 hex/);
});

test("loadOrCreateKey__RefusesToOverwrite__When__FileWrongLength", () => {
	const root = tmp();
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "vault.key"), Buffer.alloc(16));
	assert.throws(() => loadOrCreateKey(root, {}), /refusing to overwrite/);
});

// ── bundles ──────────────────────────────────────────────────────────────────────────────

test("putBundle__SealsAtRest__And__getBundleRecovers", () => {
	const root = tmp();
	const tar = Buffer.from("a whole tarball");
	const { path: dest, sha256: digest } = putBundle(root, KEY, "Dave", "yarn", tar);

	assert.equal(digest, sha256(tar));
	assert.notDeepEqual(fs.readFileSync(dest), tar, "the file on disk is sealed, not the plaintext tar");
	assert.deepEqual(getBundle(root, KEY, "Dave", "yarn"), tar, "and it opens back to the exact tar");
});

test("getBundle__ReturnsUndefined__When__NoBundleStored", () => {
	assert.equal(getBundle(tmp(), KEY, "nobody", "nothing"), undefined);
});

test("bundlePath__SanitisesOperatorAndSlug__When__KeyingTheStore", () => {
	const p = bundlePath("/root", "Dave Grant", "yarn app");
	assert.ok(p.startsWith("/root/bundles/dave-grant/"));
	assert.ok(p.endsWith("yarn-app.tar.age"));
});

test("ledgerKey__CollapsesTraversal__When__OperatorIsHostile", () => {
	// Slashes fold to dashes and a leading run of dots/dashes is stripped, so no `..` segment survives.
	const key = ledgerKey("../../etc", "yarn");
	assert.equal(key, "etc/yarn");
	assert.ok(!key.split("/").includes(".."), "the key can never name a parent directory");
});

// ── ledger transitions ───────────────────────────────────────────────────────────────────

test("recordCheckin__SetsLastHostAndHolder__And__bundleSourcePointsThere", () => {
	const root = tmp();
	recordCheckin(root, { operator: "dave", slug: "yarn", app: "Yarn", host: "mac1", sha256: "abc", signedIn: true });

	const e = ledgerEntryFor(root, "dave", "yarn");
	assert.equal(e?.lastHost, "mac1");
	assert.equal(e?.sha256, "abc");
	assert.equal(e?.holders.mac1?.signedIn, true);
	assert.deepEqual(bundleSource(root, "dave", "yarn"), { host: "mac1", sha256: "abc" });
});

test("recordCheckin__PreservesSignedOutHolder__When__SessionDied", () => {
	const root = tmp();
	recordCheckin(root, { operator: "dave", slug: "yarn", app: "Yarn", host: "mac2", sha256: "z", signedIn: false });
	assert.equal(ledgerEntryFor(root, "dave", "yarn")?.holders.mac2?.signedIn, false, "a dead session must stay recorded as dead");
});

test("recordProbe__LearnsRoams__When__MovedBundleSignedIn", () => {
	const root = tmp();
	const e = recordProbe(root, { operator: "dave", slug: "yarn", app: "Yarn", host: "mac2", signedIn: true, movedFrom: "mac1" });
	assert.equal(e.portability, "roams");
});

test("recordProbe__LearnsBound__When__MovedBundleFailed", () => {
	const root = tmp();
	const e = recordProbe(root, { operator: "dave", slug: "yarn", app: "Yarn", host: "mac2", signedIn: false, movedFrom: "mac1" });
	assert.equal(e.portability, "bound");
});

test("recordProbe__StaysUnknown__When__NoMoveHappened", () => {
	const root = tmp();
	// A box signing in its OWN local session (movedFrom === host, or unset) teaches nothing.
	const same = recordProbe(root, { operator: "dave", slug: "yarn", app: "Yarn", host: "mac1", signedIn: true, movedFrom: "mac1" });
	assert.equal(same.portability, "unknown");
	const none = recordProbe(root, { operator: "eve", slug: "yarn", app: "Yarn", host: "mac1", signedIn: true });
	assert.equal(none.portability, "unknown");
});

// ── forget + audit ───────────────────────────────────────────────────────────────────────

test("forget__RemovesBundleAndLedger__And__ReportsWhatWasHeld", () => {
	const root = tmp();
	putBundle(root, KEY, "dave", "yarn", Buffer.from("tar"));
	recordCheckin(root, { operator: "dave", slug: "yarn", app: "Yarn", host: "mac1", sha256: "s", signedIn: true });

	const res = forget(root, "dave", "yarn", "Yarn");
	assert.deepEqual(res, { hadBundle: true, hadLedger: true });
	assert.equal(getBundle(root, KEY, "dave", "yarn"), undefined);
	assert.equal(ledgerEntryFor(root, "dave", "yarn"), undefined);
});

test("forget__ReportsNothing__When__VaultNeverHeldIt", () => {
	assert.deepEqual(forget(tmp(), "ghost", "app"), { hadBundle: false, hadLedger: false });
});

test("readAudit__ReturnsEventsNewestLast__And__RespectsLimit", () => {
	const root = tmp();
	recordCheckin(root, { operator: "dave", slug: "yarn", app: "Yarn", host: "mac1", sha256: "s", signedIn: true });
	recordProbe(root, { operator: "dave", slug: "yarn", app: "Yarn", host: "mac2", signedIn: true, movedFrom: "mac1" });
	forget(root, "dave", "yarn", "Yarn");

	const all = readAudit(root);
	assert.deepEqual(all.map((e) => e.event), ["checkin", "probe", "forget"]);
	assert.equal(readAudit(root, 1).length, 1);
	assert.equal(readAudit(root, 1)[0].event, "forget", "the limit keeps the newest");
});

test("readLedger__ReturnsEmpty__When__Absent", () => {
	assert.deepEqual(readLedger(tmp()), {});
});
