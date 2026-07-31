import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJsonOr } from "../../fsutil.js";
import { runnerHome } from "./ssh.js";

/**
 * The credential vault: one place, on the operator's laptop, that holds every teammate's
 * signed-in session for every app — so a run can land on ANY free Mac and still be that
 * teammate inside the target app, rather than being routed back to whichever box they happened
 * to sign in on.
 *
 * This is the piece that removes the sticky-routing constraint. `runner/profiles.ts` already
 * solved the *one-box* half — park an operator's app data under their name, swap it in when
 * they run — but that store is box-local: a session signed in on mac1 does not exist on mac2,
 * so today the fleet must send the same operator back to the same Mac. This module makes the
 * parked bundle a movable artifact: it comes home from the box that has it, is held here, and
 * is pushed out to whichever box the next run picks. `creds.ts` drives the movement; this file
 * is only the store, the ledger, and the audit trail.
 *
 * THREE things live here, deliberately together because they are the whole persistent state of
 * the feature and share one root, exactly as profiles.ts bundles its own several concerns:
 *
 *  1. BUNDLES — the session bytes, one encrypted tarball per (operator, app). Encrypted at
 *     rest (AES-256-GCM) because a session cookie jar is a bearer credential: whoever holds the
 *     file can be that operator until the session expires. The bytes never live here in the
 *     clear. See `sealBytes`/`openBytes` and the key discipline below.
 *  2. LEDGER — for each (operator, app): which boxes are known to hold a working session, when
 *     each was last probe-verified, and a LEARNED `portability` (roams | bound | unknown). The
 *     ledger is what lets dispatch prefer a box that already has the session without ever being
 *     constrained to it, and it is where the "does this app's session survive moving" question
 *     is recorded as an answer rather than assumed. Google flipping on device-bound sessions
 *     someday changes a ledger field, not the architecture.
 *  3. AUDIT — an append-only log of every credential event: bundle in, bundle out, verified,
 *     signed-out. This is the difference between "where did my session go and who could have
 *     used it" being answerable and not. Boring to write, exactly what you produce under
 *     scrutiny.
 *
 * WHAT THIS IS NOT. It is not a multi-tenant secrets platform and does not pretend to isolate
 * operators from each other cryptographically — the fleet's trust boundary is "who can reach
 * the vault", and inside it this is a well-audited cache. Passwords never enter it: the vault
 * holds SESSIONS, which expire, never root credentials, which do not. That inheritance from
 * `signin.ts` is the single best security property here and is load-bearing, not incidental.
 */

/**
 * Where the vault lives. Under `~/.yarn-runner` beside the fleet identity and the pinned
 * known_hosts, so the same `chmod 700` that already guards the ssh key guards the sessions.
 * Overridable so a test never touches a real one.
 */
export function credRoot(home = runnerHome()): string {
	return path.join(home, "credstore");
}

function bundlesDir(root: string): string {
	return path.join(root, "bundles");
}

function ledgerFile(root: string): string {
	return path.join(root, "ledger.json");
}

function auditFile(root: string): string {
	return path.join(root, "audit.jsonl");
}

function keyFile(root: string): string {
	return path.join(root, "vault.key");
}

/**
 * Operator and slug become path segments, so they are constrained rather than trusted — the
 * same discipline `profiles.ts` applies, restated here because a vault key crafted to traverse
 * would read or write outside the store. Anything outside the set collapses to `-`, which
 * cannot name a parent and cannot be `.`/`..`.
 */
function sanitise(seg: string): string {
	const cleaned = seg.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+/, "");

	return cleaned || "unknown";
}

/** The vault path of one operator's bundle for one app. `.age` by convention: sealed, not a tar. */
export function bundlePath(root: string, operator: string, slug: string): string {
	return path.join(bundlesDir(root), sanitise(operator), `${sanitise(slug)}.tar.age`);
}

// ── Crypto ──────────────────────────────────────────────────────────────────────────────────

/**
 * The vault key, 32 bytes.
 *
 * `YARN_VAULT_KEY` (64 hex chars) wins when set, so the key can be sourced from the operator's
 * own keychain (`security find-generic-password … | YARN_VAULT_KEY=… ./run …`) and never touch
 * the disk beside the data it protects. That env path is the hardening move; the file below is
 * the default, and its weakness is stated plainly: a key file sitting next to the bundles means
 * one exfiltration of the store directory takes both. It is 0600 and under the same 0700 root
 * as the ssh identity, which is the same protection that identity already relies on — but a
 * laptop that is fully compromised loses the sessions regardless, and no on-disk key changes
 * that. Rotate by deleting the file (and re-signing in); a lost key means the bundles are
 * unreadable, which is the safe direction.
 */
export function loadOrCreateKey(root: string, env: NodeJS.ProcessEnv = process.env): Buffer {
	const fromEnv = env.YARN_VAULT_KEY?.trim();
	if (fromEnv) {
		if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) throw new Error("YARN_VAULT_KEY must be 64 hex characters (32 bytes)");

		return Buffer.from(fromEnv, "hex");
	}

	const file = keyFile(root);
	try {
		const raw = fs.readFileSync(file);
		if (raw.length === 32) return raw;
		// A wrong-length key file is corruption, not a fresh vault: overwriting it would orphan
		// every bundle sealed under the real key. Refuse rather than silently mint a new one.
		throw new Error(`vault key at ${file} is ${raw.length} bytes, expected 32 — refusing to overwrite; delete it to re-key`);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}

	const key = randomBytes(32);
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, key, { mode: 0o600 });

	return key;
}

/** `iv(12) ‖ tag(16) ‖ ciphertext`. GCM so a truncated or tampered bundle fails to open rather than decrypting to garbage. */
export function sealBytes(key: Buffer, plaintext: Buffer): Buffer {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);

	return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** Inverse of `sealBytes`. Throws on a wrong key or a modified blob — GCM's authentication tag is the check. */
export function openBytes(key: Buffer, blob: Buffer): Buffer {
	if (blob.length < 28) throw new Error("sealed bundle is too short to contain an IV and tag");
	const iv = blob.subarray(0, 12);
	const tag = blob.subarray(12, 28);
	const body = blob.subarray(28);
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);

	return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function sha256(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

/**
 * Seal a plaintext tarball into the vault at (operator, app). Returns the bundle path and the
 * plaintext digest — the digest is recorded in the ledger so a later `checkout` can tell the
 * runner what it should receive and refuse a corrupted push.
 */
export function putBundle(root: string, key: Buffer, operator: string, slug: string, tar: Buffer): { path: string; sha256: string } {
	const dest = bundlePath(root, operator, slug);
	fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
	const tmp = `${dest}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(tmp, sealBytes(key, tar), { mode: 0o600 });
		fs.renameSync(tmp, dest);
	} catch (e) {
		fs.rmSync(tmp, { force: true });
		throw e;
	}

	return { path: dest, sha256: sha256(tar) };
}

/** Open a sealed bundle back to its plaintext tarball, or undefined when the vault holds none. */
export function getBundle(root: string, key: Buffer, operator: string, slug: string): Buffer | undefined {
	const src = bundlePath(root, operator, slug);
	let blob: Buffer;
	try {
		blob = fs.readFileSync(src);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw e;
	}

	return openBytes(key, blob);
}

// ── Ledger ──────────────────────────────────────────────────────────────────────────────────

export type Portability = "unknown" | "roams" | "bound";

/** What is known about one box's copy of one (operator, app) session. */
export interface HolderState {
	/** ISO time the readiness probe last confirmed a working session on this host. */
	verifiedAt: string;
	/** The probe's verdict at that time — a box can hold a bundle that no longer signs in. */
	signedIn: boolean;
}

export interface LedgerEntry {
	operator: string;
	slug: string;
	/** The app's display name, kept for the CLI and audit — the slug is the key. */
	app: string;
	/**
	 * What the fleet has LEARNED about whether this app's session survives moving between boxes,
	 * never assumed. `unknown` until a restore-then-probe on a second box settles it; `roams`
	 * when one passed; `bound` when a freshly-restored bundle failed its probe on a box that did
	 * not sign it in. `bound` is not permanent — a later success flips it back — because the
	 * cause (a device-bound cookie, an IP heuristic) can itself change.
	 */
	portability: Portability;
	/** The box whose bundle is currently the freshest — where a checkout pulls from. */
	lastHost?: string;
	/** SHA-256 of the plaintext tar of the freshest bundle, for integrity on the wire. */
	sha256?: string;
	/** Per-box verification state, keyed by host name. */
	holders: Record<string, HolderState>;
	updatedAt: string;
}

export type Ledger = Record<string, LedgerEntry>;

/** `<operator>/<slug>` — the same key the bundle path is built from, sanitised identically. */
export function ledgerKey(operator: string, slug: string): string {
	return `${sanitise(operator)}/${sanitise(slug)}`;
}

export function readLedger(root: string): Ledger {
	const parsed = readJsonOr<unknown>(ledgerFile(root), undefined);

	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Ledger) : {};
}

/** Atomic replace, same sibling-temp-then-rename discipline the job registry uses. */
export function writeLedger(root: string, ledger: Ledger): void {
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	const target = ledgerFile(root);
	const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(tmp, target);
	} catch (e) {
		fs.rmSync(tmp, { force: true });
		throw e;
	}
}

function now(): string {
	return new Date().toISOString();
}

function entry(ledger: Ledger, operator: string, slug: string, app: string): LedgerEntry {
	const key = ledgerKey(operator, slug);

	return (ledger[key] ??= { operator: sanitise(operator), slug: sanitise(slug), app, portability: "unknown", holders: {}, updatedAt: now() });
}

/**
 * Record that a bundle just landed in the vault from `host` — the check-IN after a run. This is
 * the authoritative-new-state write: the box that just finished a run holds any rotated refresh
 * tokens, so its bundle becomes `lastHost` and its digest the one to trust. The probe verdict is
 * recorded per-host; `signedIn:false` is legitimate to store (the app may have signed itself
 * out) and is exactly what a later checkout needs to know so it does not push a dead session.
 */
export function recordCheckin(
	root: string,
	args: { operator: string; slug: string; app: string; host: string; sha256: string; signedIn: boolean },
): LedgerEntry {
	const ledger = readLedger(root);
	const e = entry(ledger, args.operator, args.slug, args.app);
	e.app = args.app;
	e.lastHost = args.host;
	e.sha256 = args.sha256;
	e.holders[args.host] = { verifiedAt: now(), signedIn: args.signedIn };
	e.updatedAt = now();
	writeLedger(root, ledger);
	appendAudit(root, { event: "checkin", operator: args.operator, app: args.app, host: args.host, detail: args.signedIn ? "signed in" : "signed out" });

	return e;
}

/**
 * Record the outcome of a restore-then-probe on a box that did NOT already hold the session —
 * the check-OUT verification. A pass teaches the entry that this app roams; a fail on a fresh
 * restore is the device-bound signal and flips it to `bound` so the operator is steered to sign
 * in on that box rather than the fleet retrying a move that cannot work.
 */
export function recordProbe(
	root: string,
	args: { operator: string; slug: string; app: string; host: string; signedIn: boolean; movedFrom?: string },
): LedgerEntry {
	const ledger = readLedger(root);
	const e = entry(ledger, args.operator, args.slug, args.app);
	e.holders[args.host] = { verifiedAt: now(), signedIn: args.signedIn };
	// Only a MOVED bundle teaches portability: a box signing in its own local session says
	// nothing about whether a session survives the trip. `movedFrom` is set only on a checkout
	// that actually pushed a bundle from another box.
	if (args.movedFrom && args.movedFrom !== args.host) e.portability = args.signedIn ? "roams" : "bound";
	e.updatedAt = now();
	writeLedger(root, ledger);
	appendAudit(root, {
		event: "probe",
		operator: args.operator,
		app: args.app,
		host: args.host,
		detail: `${args.signedIn ? "signed in" : "signed out"}${args.movedFrom ? ` (moved from ${args.movedFrom} → ${e.portability})` : ""}`,
	});

	return e;
}

/** The freshest holder to pull from for a checkout, or undefined when the vault has never seen this session. */
export function bundleSource(root: string, operator: string, slug: string): { host: string; sha256?: string } | undefined {
	const e = readLedger(root)[ledgerKey(operator, slug)];
	if (!e?.lastHost) return undefined;

	return { host: e.lastHost, ...(e.sha256 ? { sha256: e.sha256 } : {}) };
}

export function ledgerEntryFor(root: string, operator: string, slug: string): LedgerEntry | undefined {
	return readLedger(root)[ledgerKey(operator, slug)];
}

/**
 * Forget one operator's session for one app, everywhere the vault knows about — the ledger row,
 * the sealed bundle, and an audit line saying it happened. This is the vault half of
 * `signout --everywhere`; the live/parked copies on the boxes are cleared by the runner's
 * `authclear` verb, which this does not reach. Returns whether anything was held, so the caller
 * can tell "signed out" from "nothing to sign out of".
 */
export function forget(root: string, operator: string, slug: string, app?: string): { hadBundle: boolean; hadLedger: boolean } {
	const ledger = readLedger(root);
	const key = ledgerKey(operator, slug);
	const hadLedger = key in ledger;
	const name = app ?? ledger[key]?.app ?? slug;
	delete ledger[key];
	writeLedger(root, ledger);

	const bundle = bundlePath(root, operator, slug);
	let hadBundle = false;
	try {
		fs.rmSync(bundle, { force: false });
		hadBundle = true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}

	appendAudit(root, { event: "forget", operator: sanitise(operator), app: name, detail: `bundle:${hadBundle} ledger:${hadLedger}` });

	return { hadBundle, hadLedger };
}

// ── Audit ───────────────────────────────────────────────────────────────────────────────────

export interface AuditEvent {
	event: "checkin" | "checkout" | "probe" | "forget" | "keyseed";
	operator: string;
	app: string;
	host?: string;
	detail?: string;
}

/**
 * One JSON object per line, append-only. Append-only is the point: an audit trail a process can
 * rewrite is not one. Timestamped here so callers pass only what happened, and best-effort —
 * a full disk must not fail the credential operation the line describes, only the record of it,
 * which is the safe direction (the operation is what has security consequence).
 */
export function appendAudit(root: string, e: AuditEvent): void {
	try {
		fs.mkdirSync(root, { recursive: true, mode: 0o700 });
		fs.appendFileSync(auditFile(root), `${JSON.stringify({ at: now(), ...e })}\n`, { mode: 0o600 });
	} catch {}
}

/** The audit log, newest last, for `./run creds audit`. Best-effort read: an absent log is an empty history. */
export function readAudit(root: string, limit = 200): Array<AuditEvent & { at: string }> {
	let text: string;
	try {
		text = fs.readFileSync(auditFile(root), "utf8");
	} catch {
		return [];
	}
	const lines = text.split("\n").filter((l) => l.trim());

	return lines
		.slice(-limit)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return undefined;
			}
		})
		.filter((e): e is AuditEvent & { at: string } => !!e && typeof e.event === "string");
}
