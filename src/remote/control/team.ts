import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resourcesRoot } from "../../paths.js";
import { type HostEntry, loadHosts } from "./hosts.js";
import { identityFile, runnerHome } from "./ssh.js";

/**
 * Zero-step fleet access for everyone after the first person.
 *
 * EVERY PATH HERE IS THE OPERATOR'S OWN LAPTOP, so every one of them goes through
 * `runnerHome()`. There are two accessors for `~/.yarn-runner` and they are NOT
 * interchangeable: `runnerHome()` (ssh.ts, `YARN_RUNNER_HOME`) is this machine's — the
 * identity, known_hosts, the control sockets — while `defaultRunnerDir()` (runner/lease.ts,
 * `YARN_RUNNER_DIR`) is the COLO MAC's, and the LaunchAgent relocates it with that variable.
 * They share a default, which is why using the wrong one works until someone sets one env
 * var: this file wrote the credentials bundle under `runnerHome()` and the env file under
 * `defaultRunnerDir()`, so setting either alone split them across two directories.
 *
 * `enroll` cannot be run by a teammate: installing a public key requires already being able
 * to log in, and the only credential that proves that is the Macs' admin password. Handing
 * that password around is worse than what this module does, and the alternative — each
 * teammate mails a public key to whoever is already enrolled — is a manual step in an
 * onboarding flow that is otherwise "install the app and open it".
 *
 * So the fleet identity is a TEAM credential, minted once and shipped with the app. What that
 * buys and what it costs, stated plainly because it is a real trade:
 *
 * - Anyone holding the bundle can log into all three Macs as `administrator`. The bundle is
 *   therefore exactly as sensitive as the Macs are, and belongs wherever the team already
 *   keeps the OpenRouter key — not in git. `.gitignore` covers the filename, and
 *   `exportCredentials` writes 0600.
 * - Revocation is rotation: mint a new key, re-run enroll, ship a new bundle. There is no
 *   per-person revoke, because there are no per-person keys.
 * - SSH no longer says WHO ran something. Attribution moves to the `operator` field the
 *   client puts in the lease, which is a label rather than a check — honest for a small team
 *   deciding who to interrupt, not a security control, and it is not treated as one.
 *
 * The private key is never read into a log or a UI: `describeCredentials` reports the
 * fingerprint of the PUBLIC half, which identifies the key without disclosing it.
 */

export const TEAM_SCHEMA = "yarn-runner/team@1";
export const CREDENTIALS_FILENAME = "team-credentials.json";

/** Set to a file path to override discovery entirely — how CI and tests point at a fixture. */
const CREDENTIALS_ENV = "YARN_TEAM_CREDENTIALS";

export interface TeamCredentials {
	schema: string;
	/** OpenSSH private key text, the whole `-----BEGIN…END-----` block including its newline. */
	sshPrivateKey: string;
	/** Optional so a team that distributes the model key another way is not forced to duplicate it. */
	openrouterKey?: string;
	/**
	 * The colo Macs' console login password, for screen sharing only.
	 *
	 * This is the password to a machine, not to anything of anyone's — a shared `administrator`
	 * account on three colo Macs that exist to be driven. Carrying it is what turns "every
	 * teammate types a password they have to be told" into a keychain item their Mac already
	 * has, which is the difference between the sign-in flow working and being routed around.
	 *
	 * It never reaches an agent, a run, or a recording. `applyCredentials` puts it straight into
	 * the local login keychain and nothing else reads it back.
	 */
	vncPassword?: string;
}

/**
 * Where a bundle may come from, in order. Each entry is a real deployment:
 *
 * 1. The env var — a fixture in tests, a mounted secret in CI.
 * 2. Inside the .app. `resourcesRoot()` is the bundle's Resources dir when packaged and the
 *    checkout when not, so the packaged case needs no extra plumbing: dropping the file into
 *    the build makes the installed app self-provisioning on first launch.
 * 3. `~/.yarn-runner/`. The rsync-and-run workflow that predates any packaging still works —
 *    copy one file next to the key it installs, and the app finds it there.
 */
export function credentialsSearchPath(): string[] {
	const override = process.env[CREDENTIALS_ENV]?.trim();
	if (override) return [override];

	return [path.join(resourcesRoot(), CREDENTIALS_FILENAME), path.join(runnerHome(), CREDENTIALS_FILENAME)];
}

export function findCredentials(): string | undefined {
	return credentialsSearchPath().find((p) => fs.existsSync(p));
}

export function parseCredentials(text: string): TeamCredentials {
	let parsed: any;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("team credentials file is not valid JSON");
	}
	if (parsed?.schema !== TEAM_SCHEMA) throw new Error(`unsupported team credentials schema ${JSON.stringify(parsed?.schema)}`);
	if (typeof parsed.sshPrivateKey !== "string" || !parsed.sshPrivateKey.includes("PRIVATE KEY"))
		throw new Error("team credentials carry no OpenSSH private key");
	if (parsed.openrouterKey !== undefined && typeof parsed.openrouterKey !== "string")
		throw new Error("openrouterKey must be a string when present");
	if (parsed.vncPassword !== undefined && typeof parsed.vncPassword !== "string")
		throw new Error("vncPassword must be a string when present");

	return {
		schema: TEAM_SCHEMA,
		sshPrivateKey: parsed.sshPrivateKey,
		...(parsed.openrouterKey ? { openrouterKey: parsed.openrouterKey } : {}),
		...(parsed.vncPassword ? { vncPassword: parsed.vncPassword } : {}),
	};
}

export interface ApplyResult {
	identity: "installed" | "kept";
	/** Fingerprint of the public half, so a caller can show WHICH key is in use. */
	fingerprint?: string;
	/** "written" only when the bundle carried a model key and the machine did not already have one. */
	modelKey: "written" | "kept" | "absent";
	/** Hosts whose screen-sharing password is now in this Mac's login keychain. */
	vncSeeded: string[];
}

/**
 * Test seams, both for the same reason: this function writes to the login keychain and reads the
 * fleet inventory, and a unit test must do neither on a developer's machine.
 */
export interface ApplyOptions {
	hosts?: HostEntry[];
	runSecurity?: (args: string[]) => boolean;
}

/**
 * Put the screen-sharing password into THIS Mac's login keychain, one item per host.
 *
 * Why the keychain rather than anywhere this code can read: it is where Screen Sharing already
 * looks. macOS files a remembered screen-sharing credential as an internet-password item keyed
 * on (server, account, protocol `vnc `) — the same triple `vncUrl` now puts in the URL — so
 * writing the item ourselves is indistinguishable from the operator having ticked "Remember
 * this password" once, and Screen Sharing connects without a prompt. No daemon, no agent, and
 * nothing new that holds a secret at rest.
 *
 * `-U` updates an existing item rather than adding a duplicate, so re-enrolling after a
 * password change fixes the stored one instead of leaving two and picking the older.
 *
 * Best-effort per host, and never fatal: a locked keychain or a `security` that refuses is a
 * teammate who types a password once, which is exactly where they were before this existed.
 *
 * KNOWN EXPOSURE. `security` takes the password as an argument, so it is in this process's argv
 * for the length of one exec. It is the teammate's own machine, and macOS does not show other
 * users' arguments to a non-root `ps`, but it is real and there is no stdin form of the command
 * to use instead. Weighed against the alternative — the password living in a chat message, a
 * note, or a wiki, which is where it goes when nothing automates this — the keychain wins.
 */
function applyVncPassword(password: string | undefined, hosts: HostEntry[] | undefined, exec = runSecurity): string[] {
	// Ahead of resolving the inventory, so a bundle without a password reads no files at all.
	if (!password) return [];

	const seeded: string[] = [];
	for (const host of hosts ?? inventoryHosts()) {
		const account = host.ssh.user;
		if (!account) continue;
		const ok = exec([
			"add-internet-password",
			"-s", host.vnc.host,
			"-a", account,
			// A FourCC, and the trailing space is part of it. Without the exact protocol the item
			// is filed under a different key and Screen Sharing never finds it.
			"-r", "vnc ",
			"-P", String(host.vnc.port),
			"-w", password,
			"-U",
			// Screen Sharing reads the item without prompting for keychain access. Omit this and
			// the operator trades a password prompt for an "allow access?" prompt. BOTH paths:
			// the app moved to /System/Applications/Utilities on modern macOS (verified absent
			// from CoreServices on 26.2), and an ACL naming only the dead path grants nothing.
			"-T", "/System/Applications/Utilities/Screen Sharing.app",
			"-T", "/System/Library/CoreServices/Screen Sharing.app",
		]);
		if (ok) seeded.push(host.name);
	}

	return seeded;
}

function runSecurity(args: string[]): boolean {
	try {
		execFileSync("security", args, { stdio: "ignore", timeout: 10_000 });

		return true;
	} catch {
		return false;
	}
}

/** The fleet, or nothing when this machine has no inventory yet. Never throws. */
function inventoryHosts(): HostEntry[] {
	try {
		return loadHosts().hosts;
	} catch {
		return [];
	}
}

export interface VncSeedOutcome {
	/** A team bundle exists on this machine (env override, resources root, or ~/.yarn-runner). */
	hadBundle: boolean;
	/** That bundle carries a vncPassword — absent means every vnc:// connection may prompt. */
	hadPassword: boolean;
	/** Hosts whose screen-sharing password is now (re)written in the login keychain. */
	seeded: string[];
}

/**
 * (Re)seed the screen-sharing keychain items from the retained team bundle — and ONLY those:
 * no identity install, no model key. Exists for callers that want passwordless vnc:// on
 * demand (the dash's peek fallback) without re-running full provisioning; `-U` makes it
 * idempotent, so calling it right before opening Screen Sharing costs one `security` exec per
 * host and repairs a stale or missing item in the same motion.
 *
 * Throws on a malformed bundle (same contract as parseCredentials) — a bundle that exists but
 * cannot be read is worth surfacing, not eating.
 */
export function seedVncKeychain(hosts?: HostEntry[], exec: (args: string[]) => boolean = runSecurity): VncSeedOutcome {
	const file = findCredentials();
	if (!file) return { hadBundle: false, hadPassword: false, seeded: [] };
	const creds = parseCredentials(fs.readFileSync(file, "utf8"));
	if (!creds.vncPassword) return { hadBundle: true, hadPassword: false, seeded: [] };

	return { hadBundle: true, hadPassword: true, seeded: applyVncPassword(creds.vncPassword, hosts, exec) };
}

/**
 * Install the team identity, unless this machine already has one.
 *
 * Never clobbers: the first person enrolled with a key of their own, and overwriting it would
 * take away the access they have in exchange for access they may not need. "kept" is a normal
 * outcome, not a failure.
 */
export function applyCredentials(creds: TeamCredentials, opts: ApplyOptions = {}): ApplyResult {
	fs.mkdirSync(runnerHome(), { recursive: true, mode: 0o700 });
	const modelKey = applyModelKey(creds.openrouterKey);
	// Outside the identity branch on purpose: someone who enrolled with their own key ("kept")
	// still has no screen-sharing password, and that is the case where being sent a bundle is
	// the only way they get one.
	const vncSeeded = applyVncPassword(creds.vncPassword, opts.hosts, opts.runSecurity);
	const key = identityFile();
	if (fs.existsSync(key)) return { identity: "kept", fingerprint: fingerprintOf(key), modelKey, vncSeeded };

	// 0600 at creation rather than after: ssh refuses a key others can read, and a window in
	// which it is world-readable is a window in which it can be copied.
	fs.writeFileSync(key, creds.sshPrivateKey.endsWith("\n") ? creds.sshPrivateKey : `${creds.sshPrivateKey}\n`, { mode: 0o600 });
	// Derived, not shipped: the public half is a pure function of the private one, so carrying
	// it in the bundle would only create a way for the two to disagree.
	fs.writeFileSync(`${key}.pub`, publicHalf(key), { mode: 0o644 });

	return { identity: "installed", fingerprint: fingerprintOf(key), modelKey, vncSeeded };
}

/**
 * Put the model key where a run will actually find it: `<runnerDir>/env`, the file `childEnv`
 * reads.
 *
 * Not the shell profile and not this process's environment, because the machine that matters
 * most is the one running under launchd — no login shell, no `.zshrc`, no inherited exports.
 * A teammate who never opens a terminal has no other way to supply it, and a key that is only
 * present when a human typed it is the difference between "works when I test it" and "works
 * at boot".
 *
 * Appends rather than rewrites, and never overrides an existing OPENROUTER_API_KEY: a host
 * with a deliberate per-host key set by hand must keep it.
 */
function applyModelKey(key: string | undefined): ApplyResult["modelKey"] {
	if (!key) return "absent";

	const file = path.join(runnerHome(), "env");
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	if (/^\s*(export\s+)?OPENROUTER_API_KEY\s*=/m.test(existing)) return "kept";

	// Single-quoted: an OpenRouter key is base64-ish and safe, but this file is read by a shell
	// on the provisioning path too, and quoting it there costs nothing.
	fs.writeFileSync(file, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}OPENROUTER_API_KEY='${key}'\n`, { mode: 0o600 });
	// Chmods as well as passing `mode`, because `mode` applies at CREATION only: a hand-made
	// env file that already existed at 0644 would keep it with the key appended.
	fs.chmodSync(file, 0o600);

	return "written";
}

/**
 * What may appear in a model key. Deliberately narrow, and the narrowness is the point: the
 * value below is written inside single quotes into a file that the provisioning path SOURCES
 * with a shell, so a key containing `'` would close the quote and hand the rest to sh. There
 * is no escaping that survives both readers (`childEnv` parses the same line without a
 * shell), so an unrepresentable key is refused rather than mangled.
 *
 * The ranges skip exactly two code points, and the gaps are the whole point. This was
 * `[\x21-\x7e]`, and that range CONTAINS `'` (0x27) — so the character the paragraph above
 * names as the entire hazard was the one character it let through. `a'; rm -rf ~ #` passed
 * validation and became live shell in a sourced file. Caught 2026-07-30 by testing the
 * rejection rather than reading the comment.
 *
 *   0x27 `'`  — closes the quote. The documented hazard.
 *   0x5c `\`  — literal inside single quotes in sh, but `childEnv` is the other reader and
 *               need not agree. A key the two readers disagree about is not worth supporting
 *               for a value that is hex in practice.
 */
const SAFE_MODEL_KEY = /^[\x21-\x26\x28-\x5b\x5d-\x7e]+$/;

/**
 * The one place a model key is judged acceptable.
 *
 * Exported because provisioning writes the same value into the same single-quoted line on a
 * REMOTE host, and a second copy of this rule would be a copy that drifts — the failure it
 * guards against (a `'` closing the quote and handing the remainder to sh) would then be
 * caught on one path and not the other, on the machine that is harder to inspect.
 *
 * Returns the trimmed value so callers cannot accidentally write the untrimmed one.
 */
export function checkModelKey(key: string): string {
	const value = key.trim();
	if (!value) throw new Error("no key given");
	if (!SAFE_MODEL_KEY.test(value))
		throw new Error("that does not look like an API key — keys may not contain spaces, quotes or control characters");

	return value;
}

/**
 * Overwrite the model key, on purpose.
 *
 * The sibling `applyModelKey` deliberately KEEPS an existing key, because a bundle arriving on
 * a machine that already authenticates must not silently take that away. This is the opposite
 * situation and needs the opposite rule: a teammate typing their own key into the credentials
 * panel is telling us the current one is wrong, and a save that reported success while leaving
 * the old key in place would be the single most confusing outcome available.
 *
 * Rewrites the OPENROUTER_API_KEY line in place rather than appending a second one — `childEnv`
 * takes the last assignment, but a file that accumulates one line per correction is unreadable
 * by the human who has to debug it, and the shell reader takes the last one too only by luck.
 *
 * Chmods as well as passing `mode`, because `mode` applies at CREATION only: an env file that
 * already existed at 0644 would keep it, which is how a secret typed into a GUI ends up
 * world-readable on a shared Mac.
 */
export function setModelKey(key: string): void {
	const value = checkModelKey(key);

	const file = path.join(runnerHome(), "env");
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	const kept = existing
		.split("\n")
		.filter((line) => !/^\s*(export\s+)?OPENROUTER_API_KEY\s*=/.test(line))
		.join("\n")
		.replace(/\n+$/, "");

	fs.writeFileSync(file, `${kept ? `${kept}\n` : ""}OPENROUTER_API_KEY='${value}'\n`, { mode: 0o600 });
	fs.chmodSync(file, 0o600);
}

/** The whole first-launch path: find a bundle, install it. Absent bundle is not an error. */
export function provisionFromBundle(): (ApplyResult & { source: string }) | undefined {
	const file = findCredentials();
	if (!file) return undefined;

	return { ...applyCredentials(parseCredentials(fs.readFileSync(file, "utf8"))), source: file };
}

/**
 * Produce the bundle to hand out, from the identity this machine already has. Run by whoever
 * enrolled first; the result is the file a teammate never has to think about.
 */
export function exportCredentials(target: string, openrouterKey?: string, vncPassword?: string): string {
	const key = identityFile();
	if (!fs.existsSync(key)) throw new Error(`no fleet identity at ${key} — run ./run enroll first`);

	const creds: TeamCredentials = {
		schema: TEAM_SCHEMA,
		sshPrivateKey: fs.readFileSync(key, "utf8"),
		...(openrouterKey ? { openrouterKey } : {}),
		...(vncPassword ? { vncPassword } : {}),
	};
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
	// Chmods as well as passing `mode`, because `mode` applies at CREATION only: re-exporting
	// over an existing looser-permission file would leave the private key at that mode.
	fs.chmodSync(target, 0o600);

	return target;
}

/**
 * Identity without disclosure — safe for a log line, a UI row or a message.
 *
 * `modelKey` is a boolean and stays one. The UI wants to say whether a run can authenticate,
 * and the moment this returns even a prefix of the key it becomes something that can be
 * screenshotted.
 */
export function describeCredentials(): { present: boolean; fingerprint?: string; path: string; modelKey: boolean; modelKeySource?: "saved" | "environment" } {
	const key = identityFile();
	const envFile = path.join(runnerHome(), "env");
	const saved = fs.existsSync(envFile) && /^\s*(export\s+)?(OPENROUTER|ANTHROPIC)_API_KEY\s*=\s*\S/m.test(fs.readFileSync(envFile, "utf8"));
	// The saved file is not the only way a run gets a key: local runs inherit this process's
	// environment (a team bundle, a shell export, ../yarn/.env sourced at launch). Reporting
	// "absent" while every run authenticates fine sent people hunting for a problem that did
	// not exist — presence is presence, and the source rides along for the panel to name.
	const inherited = !!(process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY);
	const modelKey = saved || inherited;

	return {
		present: fs.existsSync(key),
		...(fs.existsSync(key) ? { fingerprint: fingerprintOf(key) } : {}),
		path: key,
		modelKey,
		...(modelKey ? { modelKeySource: saved ? ("saved" as const) : ("environment" as const) } : {}),
	};
}

function publicHalf(keyFile: string): string {
	// -y derives the public key from the private one. It reads the file and writes stdout; the
	// private material never reaches an argument list.
	return execFileSync("ssh-keygen", ["-y", "-f", keyFile], { encoding: "utf8" });
}

function fingerprintOf(keyFile: string): string | undefined {
	try {
		// Fingerprinting the PUBLIC half: -lf on a private key works but reads the secret for no
		// reason, and the two produce the same digest.
		const pub = fs.existsSync(`${keyFile}.pub`) ? `${keyFile}.pub` : keyFile;

		return execFileSync("ssh-keygen", ["-lf", pub], { encoding: "utf8" }).trim().split(/\s+/)[1];
	} catch {
		return undefined;
	}
}
