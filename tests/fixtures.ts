import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type HostEntry, HOSTS_SCHEMA, type Inventory } from "../src/fleet/remote/hosts.js";
import type { SshResult } from "../src/fleet/remote/ssh.js";

/**
 * Shared fixtures for the fleet tests. Not a `.test.ts` file on purpose — the test glob is
 * `tests/*.test.ts`, and a fixtures module that ran as a suite would count as an empty file
 * of passing nothing.
 *
 * Only fixtures whose copies were byte-identical (or strict generalisations whose output is
 * identical at every existing call site) live here. Variants that genuinely differ stay in
 * their own files: signin's `host` carries a vnc port, dispatch's and manage's `ok` builds a
 * runnerctl reply frame rather than raw stdout.
 */

/** A valid-format ed25519 fingerprint. The tests never verify it against a real key. */
export const PIN = "SHA256:724od0jL8u9KOWHaFi+t710VcSUmsFnN79hdOcoOI2c";

export function host(name: string, addr = "10.0.0.1", hostKey: string | null = PIN): HostEntry {
	return { name, ssh: { host: addr, port: 22, user: "administrator" }, vnc: { host: addr, port: 5900 }, hostKey };
}

export function inventory(...hosts: HostEntry[]): Inventory {
	return { schema: HOSTS_SCHEMA, hosts };
}

export function ok(stdout = ""): SshResult {
	return { code: 0, stdout, stderr: "" };
}

export function tempDir(prefix: string): string {
	// Short prefix: a Unix socket path is capped near 104 bytes and os.tmpdir() already
	// spends ~49 of them on macOS.
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function withTemp(prefix: string, fn: (dir: string) => void): void {
	const dir = tempDir(prefix);
	try {
		fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

export async function withTempAsync(prefix: string, fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = tempDir(prefix);
	try {
		await fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** `withTempAsync` that hands back the callback's value — what install/provision's copies did. */
export async function inTempDir<T>(prefix: string, fn: (dir: string) => T | Promise<T>): Promise<T> {
	const dir = tempDir(prefix);
	try {
		return await fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
