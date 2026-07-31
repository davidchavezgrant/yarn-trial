import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { appSlug } from "../../paths.js";
import { sanitiseOperator } from "../runner/profiles.js";
import {
	bundleSource,
	credRoot,
	getBundle,
	type LedgerEntry,
	ledgerEntryFor,
	loadOrCreateKey,
	putBundle,
	readAudit,
	readLedger,
	recordCheckin,
	recordProbe,
	forget,
	sha256,
} from "./credstore.js";
import { clearAppAuth } from "./manage.js";
import type { FleetRow } from "./fleet.js";
import { defaultOperator, type HostEntry, type Inventory, loadHosts, resolveHost } from "./hosts.js";
import {
	assertSafeRemotePath,
	DEFAULT_SSH_TIMEOUT_MS,
	firstLine,
	lastFrame,
	remoteDataRoot,
	runnerArgv,
	runSsh,
	runTransport,
	rsyncShell,
	type SshResult,
	type SshRunner,
} from "./ssh.js";

/**
 * The laptop half of the credential vault: move an operator's session for an app between the
 * fleet's Macs and the local vault, so a run can land on ANY free box and still be that operator
 * inside the target app.
 *
 * This is the module that turns the vault (credstore.ts, the store) and the runner's export/import
 * verbs (the endpoints) into the two operations dispatch actually needs:
 *
 *  - CHECK-OUT, before a run: make sure the box the run will land on holds the operator's freshest
 *    session. The vault's sealed bundle is opened to a plaintext tar, pushed to the box over the
 *    fleet's own rsync channel, and installed live by the runner. If the vault has never seen this
 *    session, nothing is pushed and the run signs in for the first time — a first run, not a
 *    failure.
 *  - CHECK-IN, after a run: pull the box's now-current session home and re-seal it into the vault,
 *    so the next run — anywhere — starts from what this run left behind. This is the write that
 *    keeps the vault authoritative, and it carries any refresh token the run rotated.
 *
 * The two rules the rest of the fleet holds apply here unchanged: the app name and operator cross
 * ONLY inside a base64 spec (`runnerArgv`), and the only path that crosses is a staging path the
 * runner itself confines to `out/credstage/`. The session BYTES ride rsync, never the socket,
 * because the socket caps a request at 1 MB — the same split `pull` makes for artifacts.
 *
 * TRUST NOTE restated where it is enforced: the plaintext tar exists only in transit (inside the
 * host-key-pinned, key-authenticated ssh channel) and transiently on disk at each end; at rest in
 * the vault it is AES-GCM sealed. Passwords never enter any of this — the vault holds SESSIONS.
 */

/**
 * Whether dispatch automatically checks sessions out and in around every run — the productization
 * switch. Default OFF: turning it on changes what a dispatch DOES (an export/import round trip and
 * an app quit per run), and the mechanism ships built-and-tested so enabling it fleet-wide is a
 * deliberate choice, not a side effect of this change. The manual `./run creds` verbs work either
 * way. `YARN_VAULT=1|true|on`.
 */
export function vaultEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return /^(1|true|on)$/i.test((env.YARN_VAULT ?? "").trim());
}

/**
 * The name of a box already running this exact (operator, app), if any, other than `exceptHost`.
 *
 * This is the fleet-wide serialization the vault needs: two boxes driving one operator's session
 * for one app at once diverge, and an app that rotates single-use refresh tokens will sign one of
 * the copies out. Because each operator drives from their own laptop and their sessions live in
 * their own vault, the only way to have two concurrent runs of the same (operator, app) is from
 * this laptop — so a check against the live fleet status is sufficient to catch it.
 */
export function runningElsewhere(rows: FleetRow[], operator: string, app: string, exceptHost?: string): string | undefined {
	const op = sanitiseOperator(operator);
	const slug = appSlug(app);
	const hit = rows.find(
		(r) => r.state === "busy" && r.name !== exceptHost && r.operator && sanitiseOperator(r.operator) === op && r.app && appSlug(r.app) === slug,
	);

	return hit?.name;
}

/** Rsync, injected so the whole module tests without a network — the same seam `pull` uses. */
export type CommandRunner = (file: string, argv: string[], opts: { timeoutMs: number }) => Promise<SshResult>;

const CALL_TIMEOUT_MS = 15_000;
/** A session tarball is small (cookies + localStorage, Caches excluded), but the link is a colo one. */
const RSYNC_TIMEOUT_MS = 2 * 60_000;

export interface CredDeps {
	inventory?: Inventory;
	run?: SshRunner;
	rsync?: CommandRunner;
	/** Vault root override, for tests. Production is `~/.yarn-runner/credstore`. */
	vaultRoot?: string;
	/** Local staging dir for the plaintext tar in transit. Defaults to a fresh temp dir. */
	stageDir?: string;
	env?: NodeJS.ProcessEnv;
}

function deps(d: CredDeps): {
	inv: Inventory;
	run: SshRunner;
	rsync: CommandRunner;
	vault: string;
	key: Buffer;
	stage: string;
} {
	const inv = d.inventory ?? loadHosts();
	const vault = d.vaultRoot ?? credRoot();

	return {
		inv,
		run: d.run ?? runSsh,
		rsync: d.rsync ?? ((file, argv, o) => runTransport(file, argv, o.timeoutMs)),
		vault,
		key: loadOrCreateKey(vault, d.env ?? process.env),
		stage: d.stageDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "yarn-vault-")),
	};
}

function toHost(host: HostEntry | string, inv: Inventory): HostEntry {
	return typeof host === "string" ? resolveHost(host, inv) : host;
}

/** Push a local file up to a host path, and pull one down — thin wrappers so both directions read alike and both refuse an unsafe remote path. */
async function rsyncUp(rsync: CommandRunner, host: HostEntry, local: string, remote: string): Promise<SshResult> {
	assertSafeRemotePath(remote);

	return rsync("rsync", ["-a", "-e", rsyncShell(host), local, `${host.ssh.user}@${host.ssh.host}:${remote}`], { timeoutMs: RSYNC_TIMEOUT_MS });
}

async function rsyncDown(rsync: CommandRunner, host: HostEntry, remote: string, local: string): Promise<SshResult> {
	assertSafeRemotePath(remote);

	return rsync("rsync", ["-a", "-e", rsyncShell(host), `${host.ssh.user}@${host.ssh.host}:${remote}`, local], { timeoutMs: RSYNC_TIMEOUT_MS });
}

export interface CheckoutResult {
	ok: boolean;
	host: string;
	app: string;
	operator: string;
	/** What happened: pushed and installed, nothing to push (sign-in ahead), left local session, or an error. */
	action: "installed" | "skipped-owned" | "no-bundle" | "error";
	error?: string;
}

/**
 * Ensure `host` holds `operator`'s freshest session for `app` before a run.
 *
 * `movedFrom` is the box the vault's bundle was last checked in from; when it is set and differs
 * from `host`, the run's outcome will TEACH the ledger whether this app's session survives the
 * move (via `recordRunOutcome`). Nothing here probes — the run's own readiness gate is the
 * arbiter, so checkout ends at "installed" and the verdict is recorded when the run reports.
 */
export async function checkoutSession(
	args: { host: HostEntry | string; app: string; operator?: string },
	d: CredDeps = {},
): Promise<CheckoutResult> {
	const { inv, run, rsync, vault, key, stage } = deps(d);
	const host = toHost(args.host, inv);
	const operator = (args.operator ?? defaultOperator()).trim() || defaultOperator();
	const op = sanitiseOperator(operator);
	const slug = appSlug(args.app);

	const bundle = getBundle(vault, key, op, slug);
	if (!bundle) return { ok: true, host: host.name, app: args.app, operator, action: "no-bundle" };

	const remoteRoot = await remoteDataRoot(host, run);
	if (!remoteRoot) return { ok: false, host: host.name, app: args.app, operator, action: "error", error: `${host.name} did not report its data root` };

	const localTar = path.join(stage, `${op}-${slug}.import.tar.gz`);
	const stagePath = `out/credstage/${op}-${slug}.import.tar.gz`;
	fs.writeFileSync(localTar, bundle, { mode: 0o600 });
	try {
		const up = await rsyncUp(rsync, host, localTar, `${remoteRoot}/${stagePath}`);
		if (up.code !== 0) return { ok: false, host: host.name, app: args.app, operator, action: "error", error: firstLine(up.stderr) || `rsync up exited ${up.code}` };

		const frame = lastFrame((await run(host, runnerArgv("credimport", { app: args.app, operator, stagePath }), { timeoutMs: CALL_TIMEOUT_MS })).stdout);
		if (frame?.ok !== true)
			return { ok: false, host: host.name, app: args.app, operator, action: "error", error: String(frame?.error ?? "") || `credimport refused on ${host.name}` };

		const action = frame.action === "installed" || frame.action === "skipped-owned" || frame.action === "no-bundle" ? frame.action : "installed";

		return { ok: true, host: host.name, app: args.app, operator, action };
	} finally {
		fs.rmSync(localTar, { force: true });
	}
}

export interface CheckinResult {
	ok: boolean;
	host: string;
	app: string;
	operator: string;
	/** True when a bundle was pulled and sealed into the vault. False when the box had no session to export. */
	stored: boolean;
	bytes?: number;
	source?: string;
	error?: string;
}

/**
 * Pull `operator`'s current session for `app` off `host` and seal it into the vault — the write
 * that keeps the vault authoritative after a run. `signedIn` records the run's own verdict: a run
 * that got past its readiness gate proves the session works, and a later checkout must not push a
 * session the ledger knows is dead.
 */
export async function checkinSession(
	args: { host: HostEntry | string; app: string; operator?: string; signedIn?: boolean },
	d: CredDeps = {},
): Promise<CheckinResult> {
	const { inv, run, rsync, vault, key, stage } = deps(d);
	const host = toHost(args.host, inv);
	const operator = (args.operator ?? defaultOperator()).trim() || defaultOperator();
	const op = sanitiseOperator(operator);
	const slug = appSlug(args.app);

	const exp = lastFrame((await run(host, runnerArgv("credexport", { app: args.app, operator }), { timeoutMs: CALL_TIMEOUT_MS })).stdout);
	if (exp?.ok !== true) return { ok: false, host: host.name, app: args.app, operator, stored: false, error: String(exp?.error ?? "") || `credexport refused on ${host.name}` };
	if (exp.found !== true || typeof exp.stagePath !== "string") return { ok: true, host: host.name, app: args.app, operator, stored: false, source: String(exp.source ?? "none") };

	const remoteRoot = await remoteDataRoot(host, run);
	if (!remoteRoot) return { ok: false, host: host.name, app: args.app, operator, stored: false, error: `${host.name} did not report its data root` };

	const localTar = path.join(stage, `${op}-${slug}.checkin.tar.gz`);
	try {
		const down = await rsyncDown(rsync, host, `${remoteRoot}/${exp.stagePath}`, localTar);
		if (down.code !== 0) return { ok: false, host: host.name, app: args.app, operator, stored: false, error: firstLine(down.stderr) || `rsync down exited ${down.code}` };

		const tar = fs.readFileSync(localTar);
		const digest = sha256(tar);
		putBundle(vault, key, op, slug, tar);
		recordCheckin(vault, { operator: op, slug, app: args.app, host: host.name, sha256: digest, signedIn: args.signedIn !== false });

		return { ok: true, host: host.name, app: args.app, operator, stored: true, bytes: tar.length, source: String(exp.source ?? "live") };
	} finally {
		fs.rmSync(localTar, { force: true });
	}
}

/**
 * Fold a completed run's outcome into the ledger — the step that LEARNS portability. Called by
 * dispatch once a run that was checked out onto a box has reported: `signedIn` is whether the run
 * got past its readiness gate (exit code 3 is a signed-out refusal). A moved bundle that signed in
 * teaches `roams`; one that did not teaches `bound`, steering the next dispatch to sign in on the
 * box rather than retry a move that cannot work.
 */
export function recordRunOutcome(
	args: { host: string; app: string; operator?: string; signedIn: boolean; movedFrom?: string },
	d: CredDeps = {},
): LedgerEntry {
	const vault = d.vaultRoot ?? credRoot();
	const operator = (args.operator ?? defaultOperator()).trim() || defaultOperator();

	return recordProbe(vault, {
		operator: sanitiseOperator(operator),
		slug: appSlug(args.app),
		app: args.app,
		host: args.host,
		signedIn: args.signedIn,
		...(args.movedFrom ? { movedFrom: args.movedFrom } : {}),
	});
}

/** The box the vault would check this session out FROM, and what the ledger knows about it. */
export function sessionPlan(args: { app: string; operator?: string }, d: CredDeps = {}): { source?: string; entry?: LedgerEntry } {
	const vault = d.vaultRoot ?? credRoot();
	const op = sanitiseOperator((args.operator ?? defaultOperator()).trim() || defaultOperator());
	const slug = appSlug(args.app);

	return { source: bundleSource(vault, op, slug)?.host, entry: ledgerEntryFor(vault, op, slug) };
}

export interface SignoutResult {
	app: string;
	operator: string;
	/** Per-host authclear outcomes: which boxes still held a live or parked copy. */
	hosts: Array<{ host: string; ok: boolean; removedLive: number; removedProfile: boolean; error?: string }>;
	/** Whether the vault held a sealed bundle and/or a ledger row before this. */
	vault: { hadBundle: boolean; hadLedger: boolean };
}

/**
 * Sign an operator out of an app EVERYWHERE the fleet could restore it from: every box's live and
 * parked copy (the runner's `authclear`), and the vault's sealed bundle and ledger row (`forget`).
 * Revocation is not real until it is total — a bundle left in the vault would be pushed back onto
 * the next box the operator runs on, resurrecting the session this verb exists to destroy.
 *
 * What this does NOT do, and the runbook must: it destroys OUR copies, not the session on the
 * provider's side. A bundle exfiltrated before this ran keeps working until the provider expires
 * or revokes it, so a true sign-out ends at the provider's own device-sessions page. The audit log
 * says which sessions existed and therefore which to revoke there.
 */
export async function signoutEverywhere(args: { app: string; operator?: string }, d: CredDeps = {}): Promise<SignoutResult> {
	const { inv, run, vault } = deps(d);
	const operator = (args.operator ?? defaultOperator()).trim() || defaultOperator();
	const op = sanitiseOperator(operator);
	const slug = appSlug(args.app);

	const hosts: SignoutResult["hosts"] = [];
	for (const host of inv.hosts) {
		const r = await clearAppAuth(host, args.app, operator, { inventory: inv, run });
		hosts.push({
			host: host.name,
			ok: r.ok,
			removedLive: r.removedLive.length,
			removedProfile: Boolean(r.removedProfile),
			...(r.error ? { error: r.error } : {}),
		});
	}

	const v = forget(vault, op, slug, args.app);

	return { app: args.app, operator, hosts, vault: v };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────

const USAGE = `usage: ./run creds status                    what the vault holds, per operator + app
       ./run creds audit [n]                  the last n credential events (default 40)
       ./run creds checkin <mac> "<App>"      pull this box's current session into the vault
       ./run creds checkout <mac> "<App>"     push the vault's session onto this box
       ./run creds signout-everywhere "<App>" wipe this operator's session across the whole fleet

  Sessions move between Macs through the vault at ~/.yarn-runner/credstore, sealed at rest.
  checkin/checkout run automatically around a dispatch; the verbs here are the manual handles.`;

async function main(argv: string[]): Promise<number> {
	const [verb, ...rest] = argv;

	if (verb === "status") {
		const rows = Object.values(readLedger(credRoot()));
		if (!rows.length) {
			console.log("the vault holds no sessions yet");

			return 0;
		}
		for (const e of rows.sort((a, b) => (a.operator + a.slug < b.operator + b.slug ? -1 : 1))) {
			const boxes = Object.entries(e.holders)
				.map(([h, s]) => `${h}${s.signedIn ? "" : "(signed out)"}`)
				.join(", ");
			console.log(`${e.operator} · ${e.app}  [${e.portability}]  last=${e.lastHost ?? "?"}  holders: ${boxes || "none"}`);
		}

		return 0;
	}

	if (verb === "audit") {
		const n = Number(rest[0]) || 40;
		for (const e of readAudit(credRoot(), n)) console.log(`${e.at}  ${e.event.padEnd(9)} ${e.operator} · ${e.app}${e.host ? ` @ ${e.host}` : ""}${e.detail ? `  — ${e.detail}` : ""}`);

		return 0;
	}

	if (verb === "checkin" || verb === "checkout") {
		const [mac, app] = rest;
		if (!mac || !app?.trim()) {
			console.error(USAGE);

			return 2;
		}
		const res = verb === "checkin" ? await checkinSession({ host: mac, app }) : await checkoutSession({ host: mac, app });
		if (!res.ok) {
			console.error(`${verb} failed: ${"error" in res ? res.error : "unknown"}`);

			return 1;
		}
		if (verb === "checkin") {
			const r = res as CheckinResult;
			console.log(r.stored ? `✓ sealed ${r.operator}'s ${r.app} session from ${r.host} (${r.bytes}B, ${r.source})` : `nothing to check in — ${r.host} has no ${r.app} session for ${r.operator}`);
		} else {
			const r = res as CheckoutResult;
			const line = r.action === "installed" ? "installed onto" : r.action === "skipped-owned" ? "already live on" : "no vault session for";
			console.log(`✓ ${r.operator}'s ${r.app}: ${line} ${r.host}`);
		}

		return 0;
	}

	if (verb === "signout-everywhere") {
		const [app] = rest;
		if (!app?.trim()) {
			console.error(USAGE);

			return 2;
		}
		const res = await signoutEverywhere({ app });
		for (const h of res.hosts) console.log(`${h.ok ? "✓" : "✗"} ${h.host}: ${h.removedLive} live path(s)${h.removedProfile ? ", parked profile" : ""}${h.error ? ` — ${h.error}` : ""}`);
		console.log(`vault: ${res.vault.hadBundle ? "bundle deleted" : "no bundle"}, ${res.vault.hadLedger ? "ledger cleared" : "no ledger row"}`);
		console.log(`\n⚠ this wiped OUR copies. Revoke the session on ${app}'s own device-sessions page too — an exfiltrated bundle keeps working until the provider expires it.`);

		return 0;
	}

	console.error(USAGE);

	return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err) => {
			console.error(`creds failed: ${(err as Error).message}`);
			process.exit(1);
		},
	);
