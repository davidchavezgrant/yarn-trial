import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	checkinSession,
	checkoutSession,
	recordRunOutcome,
	runningElsewhere,
	sessionPlan,
	signoutEverywhere,
	vaultEnabled,
} from "../src/remote/control/creds.js";
import { bundleSource, getBundle, ledgerEntryFor, loadOrCreateKey, putBundle, readAudit } from "../src/remote/control/credstore.js";
import type { HostEntry, Inventory } from "../src/remote/control/hosts.js";
import type { FleetRow } from "../src/remote/control/fleet.js";
import type { SshResult, SshRunner } from "../src/remote/control/ssh.js";
import type { CommandRunner } from "../src/remote/control/creds.js";

/**
 * The laptop orchestration, with ssh and rsync faked so nothing leaves the machine. The fakes are
 * the interesting part: `run` answers each runnerctl subcommand with a canned frame, and `rsync`
 * MATERIALISES the tar on a "download" so checkin actually reads bytes and seals them — a stub that
 * returned success without moving a file would let a broken checkin pass.
 */

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "creds-test-"));
}

const HOST: HostEntry = { name: "mac1", ssh: { user: "op", host: "mac1.local", port: 22 }, vnc: { host: "mac1.local", port: 5900 }, hostKey: "SHA256:x" };
const INV: Inventory = { schema: "yarn-runner/hosts@1", hosts: [HOST] };

/** A runnerctl fake: `frames[subcommand]` is the reply. runnerArgv puts the subcommand at argv[1]. */
function fakeRun(frames: Record<string, unknown | ((argv: string[]) => unknown)>): { calls: string[]; run: SshRunner } {
	const calls: string[] = [];

	return {
		calls,
		run: async (_host, argv): Promise<SshResult> => {
			const sub = argv[1];
			calls.push(sub);
			const f = frames[sub];
			const frame = typeof f === "function" ? (f as (a: string[]) => unknown)(argv) : (f ?? { ok: false, error: `no fake for ${sub}` });

			return { code: 0, stdout: `${JSON.stringify(frame)}\n`, stderr: "" };
		},
	};
}

/** An rsync fake. On a download (source is `user@host:...`), it writes `downBytes` to the local dest. */
function fakeRsync(downBytes?: Buffer): CommandRunner {
	return async (_file, argv): Promise<SshResult> => {
		const src = argv[argv.length - 2];
		const dst = argv[argv.length - 1];
		const isDown = src.includes("@") && src.includes(":");
		if (isDown && downBytes) fs.writeFileSync(dst, downBytes);

		return { code: 0, stdout: "", stderr: "" };
	};
}

const DOCTOR = { ok: true, dataRoot: "/remote/data" };

// ── helpers ──────────────────────────────────────────────────────────────────────────────

test("vaultEnabled__DefaultsOff__And__OptsInWithTheFlag", () => {
	// Off by default while the snapshot fix is validated on the fleet; explicit opt-in re-enables.
	assert.equal(vaultEnabled({}), false, "default off pending live validation");
	assert.equal(vaultEnabled({ YARN_VAULT: "1" }), true, "explicit opt-in");
	assert.equal(vaultEnabled({ YARN_VAULT: "on" }), true);
	assert.equal(vaultEnabled({ YARN_VAULT: "0" }), false);
	assert.equal(vaultEnabled({ YARN_VAULT: "false" }), false);
});

test("runningElsewhere__FindsTheConflict__When__SameSessionLiveOnAnotherBox", () => {
	const rows: FleetRow[] = [
		{ name: "mac1", reachable: true, state: "busy", operator: "Dave", app: "Yarn" },
		{ name: "mac2", reachable: true, state: "idle" },
	];
	assert.equal(runningElsewhere(rows, "dave", "Yarn", "mac2"), "mac1");
	// Same box is not "elsewhere"; a different app does not conflict.
	assert.equal(runningElsewhere(rows, "dave", "Yarn", "mac1"), undefined);
	assert.equal(runningElsewhere(rows, "dave", "Notion", "mac2"), undefined);
});

// ── checkin ──────────────────────────────────────────────────────────────────────────────

test("checkinSession__SealsBundleAndRecordsLedger__When__BoxHasASession", async () => {
	const vault = tmp();
	const tar = Buffer.from("dave-session-tarball");
	const { run } = fakeRun({
		doctor: DOCTOR,
		credexport: { ok: true, found: true, source: "live", stagePath: "out/credstage/dave-yarn.export.tar.gz", paths: ["Library/Application Support/Yarn"], bytes: tar.length },
	});

	const res = await checkinSession({ host: HOST, app: "Yarn", operator: "dave", signedIn: true }, { inventory: INV, run, rsync: fakeRsync(tar), vaultRoot: vault, env: {} });

	assert.equal(res.ok, true);
	assert.equal(res.stored, true);
	const key = loadOrCreateKey(vault, {});
	assert.deepEqual(getBundle(vault, key, "dave", "yarn"), tar, "the exact session bytes are sealed in the vault");
	assert.equal(ledgerEntryFor(vault, "dave", "yarn")?.lastHost, "mac1");
	assert.equal(readAudit(vault).some((e) => e.event === "checkin"), true);
});

test("checkinSession__SealsLocalSession__When__HostIsLocal", async () => {
	// The preferred path: capture on the operator's OWN machine — no ssh, no remote box. The local
	// home has a signed-in app and the profile store has no ownership record (a personal Mac).
	const vault = tmp();
	const h = fs.mkdtempSync(path.join(os.tmpdir(), "creds-home-"));
	fs.mkdirSync(path.join(h, "Library/Application Support/VaultTestApp"), { recursive: true });
	fs.writeFileSync(path.join(h, "Library/Application Support/VaultTestApp/session.json"), "local-sesh");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "creds-store-"));

	const res = await checkinSession(
		{ host: "local", app: "VaultTestApp", operator: "dave" },
		{ vaultRoot: vault, env: {}, home: h, root, quit: async () => {} },
	);

	assert.equal(res.ok, true);
	assert.equal(res.host, "local", "captured from this machine, not a fleet box");
	assert.equal(res.stored, true);
	const key = loadOrCreateKey(vault, {});
	assert.ok(getBundle(vault, key, "dave", "vaulttestapp"), "the local session is sealed in the vault");
	assert.equal(ledgerEntryFor(vault, "dave", "vaulttestapp")?.lastHost, "local");
});

test("checkinSession__StoresNothing__When__BoxHasNoSession", async () => {
	const vault = tmp();
	const { run } = fakeRun({ doctor: DOCTOR, credexport: { ok: true, found: false, source: "none" } });
	const res = await checkinSession({ host: HOST, app: "Yarn", operator: "dave" }, { inventory: INV, run, rsync: fakeRsync(), vaultRoot: vault, env: {} });
	assert.equal(res.stored, false);
	assert.equal(ledgerEntryFor(vault, "dave", "yarn"), undefined);
});

// ── checkout ─────────────────────────────────────────────────────────────────────────────

test("checkoutSession__PushesAndInstalls__When__VaultHasABundle", async () => {
	const vault = tmp();
	const key = loadOrCreateKey(vault, {});
	putBundle(vault, key, "dave", "yarn", Buffer.from("stored-session"));

	let pushed = false;
	const rsync: CommandRunner = async (_f, argv) => {
		const dst = argv[argv.length - 1];
		if (dst.includes("@") && dst.includes(":")) pushed = true; // an upload

		return { code: 0, stdout: "", stderr: "" };
	};
	const { run, calls } = fakeRun({ doctor: DOCTOR, credimport: { ok: true, action: "installed" } });

	const res = await checkoutSession({ host: HOST, app: "Yarn", operator: "dave" }, { inventory: INV, run, rsync, vaultRoot: vault, env: {} });
	assert.equal(res.ok, true);
	assert.equal(res.action, "installed");
	assert.ok(pushed, "the sealed bundle was pushed up to the box");
	assert.ok(calls.includes("credimport"));
});

test("checkoutSession__IsANoBundleNoOp__When__VaultHasNothing", async () => {
	const vault = tmp();
	const { run, calls } = fakeRun({ doctor: DOCTOR });
	const res = await checkoutSession({ host: HOST, app: "Yarn", operator: "dave" }, { inventory: INV, run, rsync: fakeRsync(), vaultRoot: vault, env: {} });
	assert.equal(res.action, "no-bundle");
	assert.ok(!calls.includes("credimport"), "with no bundle there is nothing to push or install");
});

// ── portability learning + plan ──────────────────────────────────────────────────────────

test("recordRunOutcome__TeachesRoams__When__MovedRunSignedIn", () => {
	const vault = tmp();
	const e = recordRunOutcome({ host: "mac2", app: "Yarn", operator: "dave", signedIn: true, movedFrom: "mac1" }, { vaultRoot: vault });
	assert.equal(e.portability, "roams");
});

test("sessionPlan__PointsAtLastHost__After__ACheckin", async () => {
	const vault = tmp();
	const tar = Buffer.from("x");
	const { run } = fakeRun({ doctor: DOCTOR, credexport: { ok: true, found: true, source: "live", stagePath: "out/credstage/dave-yarn.export.tar.gz" } });
	await checkinSession({ host: HOST, app: "Yarn", operator: "dave" }, { inventory: INV, run, rsync: fakeRsync(tar), vaultRoot: vault, env: {} });

	assert.equal(sessionPlan({ app: "Yarn", operator: "dave" }, { vaultRoot: vault }).source, "mac1");
	assert.deepEqual(bundleSource(vault, "dave", "yarn")?.host, "mac1");
});

// ── signout everywhere ───────────────────────────────────────────────────────────────────

test("signoutEverywhere__ClearsEveryBoxAndTheVault__When__Invoked", async () => {
	const vault = tmp();
	const key = loadOrCreateKey(vault, {});
	putBundle(vault, key, "dave", "yarn", Buffer.from("session"));
	const { run, calls } = fakeRun({ authclear: { ok: true, removedLive: ["Library/Application Support/Yarn"], ownershipCleared: true, removedProfile: "dave/yarn" } });

	const res = await signoutEverywhere({ app: "Yarn", operator: "dave" }, { inventory: INV, run, vaultRoot: vault, env: {} });

	assert.equal(res.hosts[0].removedLive, 1);
	assert.equal(res.hosts[0].removedProfile, true);
	assert.equal(res.vault.hadBundle, true);
	assert.equal(getBundle(vault, key, "dave", "yarn"), undefined, "the vault bundle is gone — no box can restore it");
	assert.ok(calls.includes("authclear"));
	assert.equal(readAudit(vault).some((e) => e.event === "forget"), true);
});
