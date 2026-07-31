import assert from "node:assert/strict";
import { test } from "node:test";
import {
	hasSafeStorage,
	readSafeStorage,
	readSecretArgv,
	safeStorageService,
	seedSafeStorage,
	seedSecretArgv,
} from "../src/remote/keychain.js";
import type { Exec } from "../src/remote/keychain.js";

/**
 * macOS keychain equalization, exercised with an injected `security`.
 *
 * The behaviour that matters and would be silently wrong otherwise: `errSecItemNotFound` (exit 44)
 * is "this app was never signed in here", an ANSWER, not an error — a version that threw on it
 * would make every fresh box look broken. And `-w` prints exactly the secret plus a trailing
 * newline, which must be stripped without otherwise touching opaque key bytes.
 */

function exec(map: Record<string, { code: number; stdout?: string; stderr?: string }>): { calls: string[][]; exec: Exec } {
	const calls: string[][] = [];

	return {
		calls,
		exec: async (bin, argv) => {
			calls.push([bin, ...argv]);
			const verb = argv[0];
			const r = map[verb] ?? { code: 0 };

			return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
		},
	};
}

test("safeStorageService__NamesTheItem__AsChromiumDoes", () => {
	assert.equal(safeStorageService("Yarn"), "Yarn Safe Storage");
});

test("readSecretArgv__CarriesServiceAndAccount__And__NoSecret", () => {
	const argv = readSecretArgv("Yarn");
	assert.ok(argv.includes("-s") && argv.includes("Yarn Safe Storage"));
	assert.ok(argv.includes("-a") && argv.includes("Yarn"));
	assert.ok(argv.includes("-w"));
});

test("seedSecretArgv__IsIdempotent__And__GrantsNoBlanketAcl", () => {
	const argv = seedSecretArgv("Yarn", "sekret");
	assert.ok(argv.includes("-U"), "-U updates in place, so re-seeding does not error");
	assert.ok(argv.includes("-w") && argv.includes("sekret"));
	assert.ok(!argv.includes("-A"), "never -A: that would let any process read the key unprompted");
	assert.ok(argv.includes("-T"), "an explicit empty trusted-app list instead");
});

test("readSafeStorage__ReturnsTrimmedSecret__When__Present", async () => {
	const { exec: e } = exec({ "find-generic-password": { code: 0, stdout: "the-key\n" } });
	assert.equal(await readSafeStorage("Yarn", e), "the-key");
});

test("readSafeStorage__ReturnsUndefined__When__ItemNotFound", async () => {
	const { exec: e } = exec({ "find-generic-password": { code: 44 } });
	assert.equal(await readSafeStorage("Yarn", e), undefined);
});

test("readSafeStorage__Throws__When__SecurityFailsOtherwise", async () => {
	const { exec: e } = exec({ "find-generic-password": { code: 1, stderr: "keychain locked" } });
	await assert.rejects(() => readSafeStorage("Yarn", e), /keychain locked/);
});

test("hasSafeStorage__IsPresenceOnly__And__NeverReturnsTheValue", async () => {
	const present = exec({ "find-generic-password": { code: 0, stdout: "key" } });
	assert.equal(await hasSafeStorage("Yarn", present.exec), true);
	const absent = exec({ "find-generic-password": { code: 44 } });
	assert.equal(await hasSafeStorage("Yarn", absent.exec), false);
});

test("seedSafeStorage__Throws__When__AddFails", async () => {
	const { exec: e } = exec({ "add-generic-password": { code: 45, stderr: "no write access" } });
	await assert.rejects(() => seedSafeStorage("Yarn", "k", e), /no write access/);
});

test("seedSafeStorage__Succeeds__When__SecurityReturnsZero", async () => {
	const { calls, exec: e } = exec({ "add-generic-password": { code: 0 } });
	await seedSafeStorage("Yarn", "k", e);
	assert.equal(calls.length, 1);
	assert.equal(calls[0][0], "security");
});
