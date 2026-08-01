import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import type { HostEntry, Inventory } from "./hosts.js";

/**
 * The single place that builds an ssh command line.
 *
 * Two properties are load-bearing and both are the reason this is one function rather than
 * an ssh call at each call site:
 *
 * 1. SELF-CONTAINED. Every invocation names its identity, its known_hosts and its config
 *    explicitly, so the fleet neither depends on nor mutates the operator's ~/.ssh. A
 *    machine that reaches the fleet only because the operator happens to have an agent
 *    loaded and a `Host mac*` stanza is a machine that stops working on someone else's
 *    laptop, and a first connection that appends to ~/.ssh/known_hosts has already accepted
 *    whatever answered the address.
 *
 * 2. INJECTION-SAFE. sshd does not receive an argv. It joins the remote arguments into ONE
 *    string and hands it to the login shell, so anything that reaches this layer as text is
 *    shell input on the far side no matter how carefully it was quoted locally. The API
 *    below therefore refuses to carry free text at all: variable data crosses as a base64
 *    spec (encodeSpec) and the remote command is assembled from fixed tokens.
 */

/**
 * Everything the fleet client owns on the local disk: the identity, the pinned known_hosts,
 * and the control sockets. Overridable so a test — or a second operator profile — never
 * touches the real one.
 */
const RUNNER_HOME_ENV = "YARN_RUNNER_HOME";

export function runnerHome(): string {
	return process.env[RUNNER_HOME_ENV] || `${os.homedir()}/.yarn-runner`;
}

export function identityFile(): string {
	return `${runnerHome()}/id_ed25519`;
}

export function knownHostsFile(): string {
	return `${runnerHome()}/known_hosts`;
}

/**
 * Short enough that one dead host cannot hold up a poll tick. The UI refreshes the fleet
 * every 5s across three hosts in parallel, so a fan-out has to finish inside one tick or the
 * next one starts on top of it.
 */
const CONNECT_TIMEOUT_S = 3;

/** Same reasoning, one step out: the wall clock on the whole ssh invocation. */
export const DEFAULT_SSH_TIMEOUT_MS = 4000;

/** Exit code for a run we killed rather than one the remote returned. Matches timeout(1). */
export const TIMEOUT_EXIT = 124;

/** Exit code when ssh itself could not be started (not installed, EACCES). Distinct from 255. */
export const SPAWN_FAILED_EXIT = 127;

export const RUNNER_BIN = "runnerctl";

/** Subcommands are fixed vocabulary; anything else is a caller trying to smuggle data in. */
const BARE_TOKEN = /^[a-z][a-z0-9-]*$/;

export interface SshResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** The option block every ssh invocation shares — pinning, identity, batch, multiplexing. */
function sshBaseArgv(host: HostEntry): string[] {
	return [
		// -F /dev/null: no ~/.ssh/config. An operator's `Host *` stanza can set
		// StrictHostKeyChecking, ProxyJump or an IdentityAgent, and the whole point of this
		// argv is that its security properties do not depend on a file we do not control.
		"-F", "/dev/null",
		"-i", identityFile(),
		// Without IdentitiesOnly, ssh offers every key in a loaded agent first and can trip
		// MaxAuthTries before reaching ours — a failure that looks like a rejected key.
		"-o", "IdentitiesOnly=yes",
		"-o", `UserKnownHostsFile=${knownHostsFile()}`,
		// /etc/ssh/ssh_known_hosts is not ours either; pinning is exclusively what we wrote.
		"-o", "GlobalKnownHostsFile=/dev/null",
		"-o", "StrictHostKeyChecking=yes",
		// No password or passphrase prompt: a run that would block on stdin must fail fast
		// instead, because nothing here is attached to a terminal.
		"-o", "BatchMode=yes",
		// Multiplexing is required, not a tuning knob. The UI polls three hosts every 5s, so
		// without a shared connection that is a fresh TCP handshake plus a public-key
		// exchange every 1.7s, forever — enough to look like a port scan and slow enough to
		// make the poll itself the reason a tick is late.
		"-o", "ControlMaster=auto",
		"-o", `ControlPath=${runnerHome()}/cm-%r@%h:%p`,
		"-o", "ControlPersist=60s",
		"-o", `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
		"-p", String(host.ssh.port),
	];
}

/**
 * Build the argv for `ssh`, ready for execFile. Never returns a shell string, and the caller
 * cannot get one: every element is a separate argv entry locally.
 */
export function sshArgv(host: HostEntry, remoteArgv: string[]): string[] {
	return [...sshBaseArgv(host), `${host.ssh.user}@${host.ssh.host}`, ...remoteArgv];
}

/**
 * The argv for a local port-forward: `-L local:127.0.0.1:remote -N`. `localPort` defaults to
 * the remote port; callers that must not squat a well-known local port (the dash's peek
 * tunnels) pass an ephemeral one instead.
 *
 * Shares `sshBaseArgv` rather than restating it so the tunnel can never drift into weaker
 * pinning than the command channel — a forwarded viewer stream through an unpinned tunnel
 * would be the one unauthenticated hop in an otherwise key-checked fleet. `-N` because the
 * tunnel is the whole job: there is no remote command, so nothing here can ever be shell text.
 */
export function tunnelArgv(host: HostEntry, port: number, localPort = port): string[] {
	if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`not a forwardable port: ${port}`);
	if (!Number.isInteger(localPort) || localPort <= 0 || localPort > 65535) throw new Error(`not a forwardable port: ${localPort}`);

	// Multiplexing OFF for the tunnel, and this is the whole bug behind the "white sign-in
	// screen" (measured 2026-07-31). sshBaseArgv turns on ControlMaster=auto so the fleet's
	// 15s status poll reuses one connection — correct there, fatal here: when a master socket
	// for this host already EXISTS, a new `ssh -L` joins it as a client and ssh refuses the
	// forward with "Could not request local forwarding", exiting nonzero. The local port then
	// accepts and instantly resets (ECONNRESET), so the viewer loads into a dead socket and
	// paints blank. A tunnel is long-lived and single-purpose — it gains nothing from sharing —
	// so it takes its own connection: ControlPath=none overrides the base block's setting.
	return [
		...sshBaseArgv(host),
		"-o", "ControlPath=none",
		"-o", "ControlMaster=no",
		// Notice a dead tunnel instead of holding a port open against a wedged link.
		"-o", "ServerAliveInterval=15",
		"-o", "ServerAliveCountMax=3",
		"-o", "ExitOnForwardFailure=yes",
		"-L", `${localPort}:127.0.0.1:${port}`,
		"-N",
		`${host.ssh.user}@${host.ssh.host}`,
	];
}

/**
 * Run a command on a host. Resolves with the exit code rather than throwing on a nonzero
 * one: every caller here is a status probe where "the remote said no" and "the remote is
 * unreachable" are both data, and neither should unwind a fan-out.
 */
export function runSsh(host: HostEntry, remoteArgv: string[], opts: { timeoutMs?: number } = {}): Promise<SshResult> {
	return runTransport("ssh", sshArgv(host, remoteArgv), opts.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS);
}

/**
 * The injection seam for anything that talks to a host. `fleet.ts`, `provision.ts` and
 * `install.ts` each used to declare their own identical alias for this; one name means a
 * fake written for one of them works in all three.
 */
export type SshRunner = (host: HostEntry, remoteArgv: string[], opts: { timeoutMs: number }) => Promise<SshResult>;

/** Same, for rsync — which takes a prebuilt argv rather than a host, because `rsyncArgv` builds it. */
export type RsyncRunner = (argv: string[], opts: { timeoutMs: number }) => Promise<SshResult>;

/** Default rsync. Shares runSsh's exit-code mapping because a kill is not a refusal in either. */
export function runRsync(argv: string[], opts: { timeoutMs: number }): Promise<SshResult> {
	return runTransport("rsync", argv, opts.timeoutMs);
}

/**
 * Run a transport binary and turn however it died into an exit code.
 *
 * The mapping is the whole point and is why ssh and rsync share this rather than each writing
 * it out: `killed` means WE ended it on the timeout, which is not the remote answering, and
 * reading it as the remote's exit status turns a slow host into a host that said no. A
 * non-numeric `code` means the binary never started at all — a third outcome that must not
 * collapse into either of the first two.
 */
export function runTransport(bin: string, argv: string[], timeoutMs: number): Promise<SshResult> {
	return new Promise((resolve) => {
		execFile(bin, argv, { timeout: timeoutMs, maxBuffer: 8 << 20, encoding: "utf8" }, (err, stdout, stderr) => {
			const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
			let code = 0;
			if (e?.killed) code = TIMEOUT_EXIT;
			else if (typeof e?.code === "number") code = e.code;
			else if (e) code = SPAWN_FAILED_EXIT;

			resolve({ code, stdout: stdout ?? "", stderr: (stderr ?? "") || (code === SPAWN_FAILED_EXIT ? String(e) : "") });
		});
	});
}

/**
 * Refuse an rsync destination that a remote shell would read as anything but a path.
 *
 * This is a security check, and it exists here because it had grown two copies — one in
 * `provision.ts`, one in `install.ts` — that already disagreed about whether the remote
 * DIRECTORY was checked as well as the `user@host`. Unlike ssh's own `user@host`, which ssh
 * consumes locally and never transmits, the remote half of an rsync path is expanded by a
 * shell on the far side. hosts.json requires only that these be non-empty strings.
 *
 * Returns the destination so the caller cannot use one without having checked it. No trailing
 * slash is added: on an rsync destination that slash is the difference between a directory and
 * a file, and a helper that decided it silently would be deciding something it cannot see.
 */
export function rsyncDestination(host: HostEntry, remotePath: string): string {
	const target = `${host.ssh.user}@${host.ssh.host}`;
	if (!SAFE_RSYNC_PATH.test(target))
		throw new Error(`refusing to rsync to ${JSON.stringify(target)}: an rsync destination is shell input on the remote side`);
	if (!SAFE_RSYNC_PATH.test(remotePath))
		throw new Error(`refusing to rsync to ${JSON.stringify(remotePath)}: an rsync destination is shell input on the remote side`);

	return `${target}:${remotePath}`;
}

/** No `~`, no `$`, no space: the remote half is expanded by a shell, so `/` is the only syntax allowed through. */
const SAFE_RSYNC_PATH = /^[A-Za-z0-9._@/-]+$/;

/** First non-blank line — how every fan-out here turns a wall of stderr into a table cell. */
export function firstLine(s: string): string {
	return s.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

/**
 * Encode a payload for the remote side.
 *
 * base64's alphabet is `A-Za-z0-9+/=` — not one character of it is special to any shell, so
 * the encoded string survives sshd's argv-to-string join and the remote login shell's
 * re-split with no quoting at all. That is the property being bought: not obfuscation, but
 * an encoding with no intersection with shell syntax.
 */
export function encodeSpec(obj: unknown): string {
	return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

export function decodeSpec<T = unknown>(str: string): T {
	return JSON.parse(Buffer.from(str, "base64").toString("utf8")) as T;
}

/**
 * The remote command line. The only way to pass variable data is `spec`, which is encoded;
 * `subcommand` must be a bare token and throws otherwise. Callers wanting to send a task
 * string therefore cannot interpolate it — the shape of the API is the mitigation.
 */
export function runnerArgv(subcommand: string, spec?: unknown): string[] {
	if (!BARE_TOKEN.test(subcommand)) throw new Error(`runnerctl subcommand must be a bare token, got ${JSON.stringify(subcommand)} — pass data as a spec, not as a command`);

	return [RUNNER_BIN, subcommand, "--json", ...(spec === undefined ? [] : ["--spec", encodeSpec(spec)])];
}

/** A source of known_hosts-format lines for a host. Injected so the writer is testable offline. */
export type KeyScanner = (host: HostEntry) => Promise<string[]>;

export interface KnownHostsResult {
	/** Hosts whose scanned key matched the pinned fingerprint and were written. */
	pinned: string[];
	/** Hosts with `hostKey: null` — imported but never verified, so nothing can be written. */
	unpinned: string[];
	/** Hosts that answered with a key that is NOT the pinned one. Investigate before retrying. */
	mismatched: string[];
	/** Hosts that did not answer the scan. */
	unreachable: string[];
}

/**
 * Write ~/.yarn-runner/known_hosts from the inventory, so the FIRST connection to a host is
 * verified instead of trust-on-first-use.
 *
 * The inventory stores fingerprints, and known_hosts needs whole public keys — there is no
 * fingerprint-only line format — so the key has to come off the wire. That is not a hole:
 * the scanned key is treated as untrusted input and is written only if its own SHA-256
 * digest equals the pinned fingerprint. A machine-in-the-middle can therefore change what
 * the scan returns and the only effect is that the host lands in `mismatched` and is never
 * written. TOFU is what this replaces, so a scan result is never accepted on its own.
 */
export async function writeKnownHosts(inv: Inventory, opts: { scan?: KeyScanner } = {}): Promise<KnownHostsResult> {
	const scan = opts.scan ?? scanHostKeys;
	const out: KnownHostsResult = { pinned: [], unpinned: [], mismatched: [], unreachable: [] };
	const lines: string[] = [];

	// Entries already on disk, so a host that fails its scan keeps the line it had instead of
	// losing it. Running this on a flaky network otherwise wipes every pin and the next
	// connection has nothing to check against. Retaining is not a widening of trust: a line
	// is only ever written after its key matched the pinned fingerprint.
	const existing = new Map<string, string>();
	try {
		for (const line of fs.readFileSync(knownHostsFile(), "utf8").split("\n")) {
			const token = line.trim().split(/\s+/)[0];
			if (token && !token.startsWith("#")) existing.set(token, line.trim());
		}
	} catch {}

	for (const host of inv.hosts) {
		const keep = (): void => {
			const prev = existing.get(hostToken(host));
			if (prev) lines.push(prev);
		};

		if (!host.hostKey) {
			out.unpinned.push(host.name);
			keep();
			continue;
		}

		let scanned: string[];
		try {
			scanned = await scan(host);
		} catch {
			out.unreachable.push(host.name);
			keep();
			continue;
		}

		const match = scanned.find((line) => keyFingerprint(line) === host.hostKey);
		if (!match) {
			(scanned.length ? out.mismatched : out.unreachable).push(host.name);
			keep();
			continue;
		}

		// Rewrite the host field rather than trusting ssh-keyscan's, because ssh looks the
		// entry up under exactly the string it was asked to connect to.
		const [, ...key] = match.trim().split(/\s+/);
		lines.push(`${hostToken(host)} ${key.join(" ")}`);
		out.pinned.push(host.name);
	}

	fs.mkdirSync(runnerHome(), { recursive: true, mode: 0o700 });
	fs.writeFileSync(knownHostsFile(), lines.length ? `${lines.join("\n")}\n` : "", { mode: 0o600 });

	return out;
}

/** How ssh keys a known_hosts lookup: bare hostname on 22, `[host]:port` otherwise. */
function hostToken(host: HostEntry): string {
	return host.ssh.port === 22 ? host.ssh.host : `[${host.ssh.host}]:${host.ssh.port}`;
}

/**
 * OpenSSH's fingerprint of a known_hosts line: `SHA256:` + unpadded base64 of the SHA-256 of
 * the raw key blob. Computed here rather than shelling out to `ssh-keygen -lf` — it is six
 * lines, and it keeps the verification step free of a subprocess whose absence would
 * otherwise have to be handled as "cannot verify".
 *
 * Field order tolerant: the key type is located rather than assumed at index 1, so a line
 * carrying a marker (`@cert-authority host type key`) parses the same way.
 */
export function keyFingerprint(line: string): string | undefined {
	const fields = line.trim().split(/\s+/);
	const at = fields.findIndex((f) => /^(ssh-|ecdsa-|sk-)/.test(f));
	const b64 = at >= 0 ? fields[at + 1] : undefined;
	if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return undefined;

	const blob = Buffer.from(b64, "base64");
	if (!blob.length) return undefined;

	return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** Default scanner. Deliberately the only outbound call in this module that is not ssh itself. */
function scanHostKeys(host: HostEntry): Promise<string[]> {
	return new Promise((resolve, reject) => {
		execFile(
			"ssh-keyscan",
			["-t", "ed25519", "-p", String(host.ssh.port), host.ssh.host],
			{ timeout: DEFAULT_SSH_TIMEOUT_MS, encoding: "utf8" },
			(err, stdout) => {
				const lines = (stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
				if (err && !lines.length) reject(err);
				else resolve(lines);
			},
		);
	});
}

/**
 * The `-e` command rsync uses to reach the host — the same ssh options as every other call,
 * derived from `sshArgv` rather than rebuilt, so the identity, the pinned known_hosts and the
 * control socket cannot drift between the two transports.
 */
export function rsyncShell(host: HostEntry): string {
	const argv = sshArgv(host, []);
	const dest = `${host.ssh.user}@${host.ssh.host}`;
	const at = argv.lastIndexOf(dest);
	const options = at < 0 ? argv : argv.slice(0, at);

	// rsync splits -e on whitespace and does no unquoting whatsoever, so an option carrying a
	// space silently becomes two arguments and ssh is handed a file that does not exist.
	// Refusing beats transferring against a mis-parsed command line.
	const spaced = options.find((a) => /\s/.test(a));
	if (spaced) throw new Error(`ssh option ${JSON.stringify(spaced)} contains whitespace, which rsync's -e cannot carry — move ${runnerHome()} to a path without spaces`);

	return ["ssh", ...options].join(" ");
}

const SAFE_REMOTE_PATH = /^[A-Za-z0-9._/-]+$/;

/**
 * rsync hands the remote path to a login shell, exactly as sshd does with everything else
 * here. A spec cannot help — the path IS rsync's protocol — so the answer is to refuse
 * anything outside a conservative alphabet rather than to invent a quoting scheme.
 */
export function assertSafeRemotePath(p: string): void {
	if (!SAFE_REMOTE_PATH.test(p)) throw new Error(`refusing to rsync ${JSON.stringify(p)}: a remote path reaches a login shell, so it may only contain letters, digits, dot, dash, underscore and slash`);
}

/**
 * The reply, out of whatever else came down the pipe. The LAST parseable object rather than
 * the first, because a login banner or an ssh warning can precede it and `runnerctl` writes
 * exactly one reply frame per request.
 */
export function lastFrame(stdout: string): Record<string, any> | undefined {
	let found: Record<string, any> | undefined;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			found = JSON.parse(trimmed);
		} catch {
			// Truncated or interleaved output. An earlier good frame still stands.
		}
	}

	return found;
}

/**
 * Where that Mac keeps its writable tree.
 *
 * Not derivable from here: the fleet's checkouts need not live at the same path as this one,
 * and a packaged runner splits data from resources entirely. `doctor` is the only thing that
 * reports it, so it is asked rather than assumed. Undefined means the host did not answer —
 * every caller treats that as "skip this host", never as a default path to write into.
 *
 * Lives here rather than in dispatch.ts so that appmaps.ts can reach it without the two
 * modules importing each other.
 */
export async function remoteDataRoot(host: HostEntry, run: SshRunner): Promise<string | undefined> {
	const frame = lastFrame((await run(host, runnerArgv("doctor"), { timeoutMs: DEFAULT_SSH_TIMEOUT_MS })).stdout);

	return typeof frame?.dataRoot === "string" ? frame.dataRoot.replace(/\/+$/, "") : undefined;
}
