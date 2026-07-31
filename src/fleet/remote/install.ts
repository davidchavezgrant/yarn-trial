import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type HostEntry, type Inventory, loadHosts, resolveHost } from "./hosts.js";
import { REMOTE_CHECKOUT, rshCommand } from "./provision.js";
import { firstLine, type RsyncRunner, runRsync, runSsh, rsyncDestination, SPAWN_FAILED_EXIT, type SshResult, type SshRunner, TIMEOUT_EXIT } from "./ssh.js";

/**
 * Getting a target app onto a fleet Mac before a run needs it, and asking whether it is
 * already there.
 *
 * Four properties shape everything below.
 *
 * 1. THE APP IS A PARAMETER, NEVER A CASE. Nothing here knows a bundle identifier, a vendor,
 *    or a download host. Presence is answered by enumerating what is actually on disk and
 *    matching a name against it; installation is answered by whatever archive the caller
 *    points at. A table of known apps would be the one thing guaranteed not to survive
 *    contact with the next app Yarn wants to demo.
 *
 * 2. AN APP NAME IS THE HOSTILE INPUT HERE, AND IT IS HOSTILE BY DEFAULT. sshd does not
 *    receive an argv — it joins the remote arguments into one string for a login shell (see
 *    the header of ssh.ts) — and the NORMAL case, "Notion Calendar", already carries a space.
 *    So the name never appears in a remote command at all: `appPresence` sends a fixed-token
 *    probe and matches locally, and `installApp` writes the name into a request FILE that
 *    rsync delivers, which the far side reads with sed into a quoted variable. A download URL
 *    gets the same treatment for the same reason — `&` is shell syntax and is also how every
 *    real release link separates its query parameters.
 *
 * 3. AN INSTALL IS ONLY AS TRUE AS THE PRESENCE CHECK AFTER IT. `curl` exiting 0 means a file
 *    arrived; `hdiutil` exiting 0 means an image mounted. Neither is evidence that a bundle
 *    the driver can launch is sitting in /Applications, and the failure they hide — an
 *    installer that unpacked something under a different name — is exactly the one that
 *    surfaces four minutes into a demo. So `ok` is defined by a fresh `appPresence`, not by
 *    the exit codes of the steps that preceded it.
 *
 * 4. INSTALLING CANNOT GRANT TCC, SO IT SAYS SO. A bundle that has just been copied into
 *    /Applications holds no Accessibility and no Screen Recording grant, and SIP blocks
 *    writing the TCC database from anywhere this code could reach. That is reported as a
 *    fact on every result rather than attempted: a run against an ungranted app degrades to
 *    an empty AX tree and a black frame with no error, which is the worst failure shape this
 *    repo has, and the operator needs to be told before the demo rather than after.
 */

/** Payload staging inside the remote checkout. Sibling of provision.ts's `.provision`. */
export const INSTALL_STAGE_DIR = ".install";

/**
 * Where the payload lands on the far side, always under this name whatever the app is called.
 *
 * Not cosmetic: the remote half of an rsync path is expanded by a shell on the far side, so a
 * destination built from a bundle name would put "Notion Calendar.app" — or worse — into shell
 * input. The real name is carried in the request file and applied by the installer script,
 * which reads it into a quoted variable.
 */
const PAYLOAD_STEM = "payload";

/** Default install location. Overridable so a test never writes outside its tmpdir. */
export const DEFAULT_DEST = "/Applications";

/**
 * Read-only, always: the same four directories `listApps()` enumerates on the local machine,
 * so a host's answer means the same thing the runner's own app list means. Relative
 * `Applications` is ~/Applications — a remote command starts in the login home, and `$HOME`
 * cannot be written here because `$` is shell syntax on the far side.
 */
const APP_DIRS = ["/Applications", "/System/Applications", "/System/Applications/Utilities", "Applications"];

/** Enough for a `find` across four directories on a busy machine, short enough not to hang a fan-out. */
const PRESENCE_TIMEOUT_MS = 20_000;

/** Mount, copy and verify. Not the download — that gets its own, larger budget. */
const INSTALL_TIMEOUT_MS = 300_000;

/** A release dmg is routinely a few hundred MB over a link nobody chose. */
const FETCH_TIMEOUT_MS = 900_000;

/** Same shape as provision.ts's steps, deliberately: one renderer reads both. */
export type InstallStepName = "reach" | "check" | "stage" | "deliver" | "install" | "verify";

const STEP_ORDER: InstallStepName[] = ["reach", "check", "stage", "deliver", "install", "verify"];

export interface InstallStep {
	step: InstallStepName;
	ok: boolean;
	detail?: string;
}

export interface AppPresence {
	host: string;
	/** The name asked about, with any `.app` suffix removed. */
	app: string;
	present: boolean;
	/** Absolute path of the bundle that matched. */
	path?: string;
	/**
	 * Bundles whose names are close but not equal. This is the field that explains a miss:
	 * "Yarn" absent while "Yarn Recorder" is present is a naming problem, not a missing app,
	 * and without the list it reads identically to an empty machine.
	 */
	near: string[];
	/** How many bundles the host reported. Zero with no `reason` means the probe saw nothing. */
	scanned: number;
	/** Why there is no answer. Absent when the host answered. */
	reason?: string;
}

export interface AppSource {
	/** Bundle name to verify afterwards. Without it an install cannot be checked, only claimed. */
	app: string;
	kind: "dmg" | "zip" | "app";
	/** Fetched ON THE REMOTE. https only. Exactly one of `url` and `path` is set. */
	url?: string;
	/** Local path rsynced up. Exactly one of `url` and `path` is set. */
	path?: string;
}

export interface InstallResult {
	host: string;
	app: string;
	/** True only when a fresh presence check found the bundle. Step exit codes do not decide this. */
	ok: boolean;
	/** In `STEP_ORDER`, truncated where the first failure stopped the pass. */
	steps: InstallStep[];
	/** What the host actually reported afterwards. */
	presence?: AppPresence;
	/** Always populated. Installation cannot grant TCC; this says so and what it means here. */
	grants: string;
}

export interface PresenceOptions {
	run?: SshRunner;
	timeoutMs?: number;
}

export interface InstallOptions extends PresenceOptions {
	rsync?: RsyncRunner;
	/** Where the bundle goes. Defaults to /Applications; the far side falls back to ~/Applications. */
	dest?: string;
	/** Reinstall over a bundle that is already present. Off by default: presence is the goal. */
	force?: boolean;
	fetchTimeoutMs?: number;
	installTimeoutMs?: number;
}

/**
 * Is this app on that Mac, and where?
 *
 * One remote command, every token of it a constant in this file. The app name is matched here
 * rather than there, which is not an optimisation: it is the reason a name with a space, a
 * quote or a `;` in it cannot become shell syntax on a machine three people share.
 */
export async function appPresence(host: HostEntry, appName: string, opts: PresenceOptions = {}): Promise<AppPresence> {
	const run = opts.run ?? runSsh;
	const app = bundleStem(appName);
	const base: AppPresence = { host: host.name, app, present: false, near: [], scanned: 0 };

	if (!app) return { ...base, reason: "no app name given" };
	// An unpinned host has no verified key, so whatever answers the address gets to decide what
	// this machine believes is installed. Refusing is the same rule provisionHost applies.
	if (!host.hostKey) return { ...base, reason: "no pinned host key — pin it before probing" };

	let result: SshResult;
	try {
		result = await run(host, presenceArgv(), { timeoutMs: opts.timeoutMs ?? PRESENCE_TIMEOUT_MS });
	} catch (e) {
		return { ...base, reason: (e as Error).message };
	}

	// Exit code is deliberately not consulted. `find` exits 1 when any root is missing, and
	// ~/Applications is absent on most Macs — treating that as a failed probe would report every
	// host as unknown while its stdout held the complete answer.
	const bundles = parseBundleList(result.stdout);
	if (!bundles.length) return { ...base, reason: firstLine(result.stderr) || `no application bundles found (exit ${result.code})` };

	return { ...base, ...matchBundle(app, bundles), scanned: bundles.length };
}

/**
 * Make the app present, and prove it.
 *
 * Stops at the first failed step and never throws — a fan-out over three colo machines has as
 * many ways to fail as it has steps, and each one is separately actionable.
 */
export async function installApp(host: HostEntry, source: AppSource, opts: InstallOptions = {}): Promise<InstallResult> {
	const run = opts.run ?? runSsh;
	const rsync = opts.rsync ?? runRsync;
	const timeoutMs = opts.timeoutMs ?? PRESENCE_TIMEOUT_MS;
	const installTimeoutMs = opts.installTimeoutMs ?? INSTALL_TIMEOUT_MS;
	const dest = opts.dest ?? DEFAULT_DEST;
	const app = bundleStem(source.app);
	const steps: InstallStep[] = [];
	/** Whether this pass copied a bundle over one that was already there. Drives the grants note. */
	let replaced = false;
	const done = (presence?: AppPresence): InstallResult => ({
		host: host.name,
		app,
		ok: steps.every((s) => s.ok) && presence?.present === true,
		steps,
		...(presence ? { presence } : {}),
		grants: grantsNote(app, presence, steps.some((s) => s.step === "install" && s.ok), replaced),
	});
	const fail = (step: InstallStepName, detail: string, presence?: AppPresence): InstallResult => {
		steps.push({ step, ok: false, detail });

		return done(presence);
	};

	// Validated before anything is sent, and validated here rather than only in parseAppSource:
	// a caller can build an AppSource by hand, and the check that matters is the one closest to
	// the wire. A non-https URL never reaches a remote command.
	let checked: AppSource;
	try {
		checked = assertSource({ ...source, app });
	} catch (e) {
		return fail("reach", (e as Error).message);
	}

	if (!host.hostKey) return fail("reach", "no pinned host key — pin it before installing");

	const reach = await attempt(() => run(host, ["true"], { timeoutMs }));
	if (!reach.ok) return fail("reach", reach.detail);
	steps.push({ step: "reach", ok: true, detail: `${host.ssh.user}@${host.ssh.host}` });

	const before = await appPresence(host, app, { run, timeoutMs });
	if (before.reason) return fail("check", before.reason, before);
	if (before.present && !opts.force) {
		// Presence IS the goal. Re-downloading a few hundred MB to end in the state we are
		// already in is the slowest possible no-op, and it replaces a bundle whose TCC grants
		// someone may have spent a support call establishing.
		steps.push({ step: "check", ok: true, detail: `already installed at ${before.path}` });

		return done(before);
	}
	replaced = before.present;
	steps.push({ step: "check", ok: true, detail: replaced ? `reinstalling over ${before.path}` : "not installed" });

	// openrsync — which is what macOS ships — creates the last path component and not its
	// parents, so a machine that has never been provisioned needs both made first.
	const mk = await attempt(() => run(host, ["mkdir", "-p", remoteStage()], { timeoutMs }));
	if (!mk.ok) return fail("stage", `could not create ${remoteStage()}: ${mk.detail}`, before);

	const stage = fs.mkdtempSync(path.join(os.tmpdir(), "yarn-install-"));
	let staged: Attempt;
	try {
		stageInstallFiles(stage, checked, dest);
		staged = await attempt(() => rsync(payloadRsyncArgv(host, stage, remoteStage(), "directory"), { timeoutMs: installTimeoutMs }));
	} catch (e) {
		staged = { ok: false, detail: (e as Error).message, stdout: "" };
	} finally {
		fs.rmSync(stage, { recursive: true, force: true });
	}
	if (!staged.ok) return fail("stage", staged.detail, before);
	steps.push({ step: "stage", ok: true, detail: `${remoteStage()}/request` });

	const delivered = checked.url
		? await attempt(() => run(host, ["sh", `${remoteStage()}/fetch.sh`], { timeoutMs: opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS }))
		: await attempt(() =>
				rsync(payloadRsyncArgv(host, checked.path as string, remotePayload(checked.kind), checked.kind === "app" ? "directory" : "file"), {
					timeoutMs: installTimeoutMs,
				}),
			);
	if (!delivered.ok) return fail("deliver", delivered.detail, before);
	steps.push({ step: "deliver", ok: true, detail: firstLine(delivered.stdout) || (checked.url ? "fetched" : `uploaded ${checked.path}`) });

	const installed = await attempt(() => run(host, ["sh", `${remoteStage()}/install-app.sh`], { timeoutMs: installTimeoutMs }));
	if (!installed.ok) return fail("install", installed.detail, before);
	steps.push({ step: "install", ok: true, detail: firstLine(installed.stdout) || "copied" });

	// The whole point. `installed.ok` means a script exited 0; this is the host being asked,
	// from scratch, whether a launchable bundle is now sitting where a run will look for it.
	const after = await appPresence(host, app, { run, timeoutMs });
	if (!after.present)
		return fail(
			"verify",
			after.reason ??
				`the installer reported success but ${app}.app is not in ${APP_DIRS.join(", ")}${after.near.length ? ` — closest bundles: ${after.near.join(", ")}` : ""}`,
			after,
		);
	steps.push({ step: "verify", ok: true, detail: after.path });

	return done(after);
}

/**
 * Fan out, one row per host, same isolation as provisionFleet: a powered-off colo box costs
 * its own row and nothing else. Parallel because the expensive step is a download.
 */
export function installFleet(inv: Inventory, source: AppSource, opts: InstallOptions = {}): Promise<InstallResult[]> {
	return Promise.all(
		inv.hosts.map(async (host) => {
			try {
				return await installApp(host, source, opts);
			} catch (e) {
				// installApp is written not to throw; this is the backstop that keeps a bug in it
				// from blanking the other rows.
				return {
					host: host.name,
					app: bundleStem(source.app),
					ok: false,
					steps: [{ step: "reach" as InstallStepName, ok: false, detail: (e as Error).message }],
					grants: GRANTS_UNKNOWN,
				};
			}
		}),
	);
}

/**
 * Turn what an operator types — a release link or a path on their disk — into a source.
 *
 * The scheme check lives here and is repeated in `assertSource` and again in the fetch script.
 * That is three copies on purpose: this one is the friendly error, the second is what protects
 * a caller that built the object itself, and the third is the only one running on the machine
 * that will actually make the request.
 */
export function parseAppSource(app: string, spec: string): AppSource {
	const trimmed = spec.trim();
	if (!trimmed) throw new Error("no source given — pass an https URL or a path to a .app, .dmg or .zip");

	// Scheme first, extension second. Both refuse, but only one of them is a security check, and
	// an `http://…/installer.exe` must be rejected for the scheme rather than for the suffix.
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
		const url = httpsUrl(trimmed);

		return assertSource({ app, kind: archiveKind(new URL(url).pathname, url), url });
	}

	const abs = path.resolve(trimmed);
	if (!fs.existsSync(abs)) throw new Error(`${abs}: no such file`);

	return assertSource({ app, kind: archiveKind(abs, abs), path: abs });
}

/**
 * Re-check a source built anywhere. Cheap, and it is the last thing standing between a
 * hand-built object and an argument to `curl` on someone else's Mac.
 */
export function assertSource(source: AppSource): AppSource {
	const app = bundleStem(source.app);
	if (!app) throw new Error("no app name given — the install cannot be verified without one");
	// The name is written into a line-oriented request file and used as a path component on the
	// far side. Both of those break on the same two characters, and no real bundle has either.
	if (/[\n\r]/.test(app)) throw new Error(`app name ${JSON.stringify(source.app)} contains a newline`);
	if (app.includes("/")) throw new Error(`app name ${JSON.stringify(source.app)} contains a path separator`);
	if (!!source.url === !!source.path) throw new Error("give exactly one of a URL and a local path");
	if (source.url) return { app, kind: source.kind, url: httpsUrl(source.url) };

	const abs = path.resolve(source.path as string);
	if (/[\n\r]/.test(abs)) throw new Error(`source path ${JSON.stringify(abs)} contains a newline`);

	return { app, kind: source.kind, path: abs };
}

/**
 * The presence probe's remote argv. Exported so a test can assert what every fleet Mac is
 * actually sent, which is the claim this module's safety rests on.
 */
export function presenceArgv(): string[] {
	// BSD find wants the roots before the expression. No `-name '*.app'`: the glob would be
	// expanded by the remote login shell before find ever saw it — under zsh, into a "no matches
	// found" error in the home directory. The suffix is filtered locally instead.
	return ["/usr/bin/find", ...APP_DIRS, "-maxdepth", "1", "-type", "d", "-print"];
}

/** `.app` bundles out of the probe's stdout, in the order the host reported them. */
export function parseBundleList(stdout: string): string[] {
	return stdout
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.endsWith(".app"));
}

/**
 * Which bundle, if any, is the one asked for.
 *
 * Case-insensitive because HFS+ and APFS are, by default, case-insensitive too: a `find` that
 * returns "Notion calendar.app" is naming the same directory a run would open. Everything that
 * merely resembles the name lands in `near` instead, where it explains the miss rather than
 * silently satisfying it.
 */
export function matchBundle(app: string, bundles: string[]): { present: boolean; path?: string; near: string[] } {
	const want = app.toLowerCase();
	const near: string[] = [];
	let hit: string | undefined;

	for (const bundle of bundles) {
		const stem = bundleStem(path.basename(bundle)).toLowerCase();
		if (stem === want) hit ??= bundle;
		else if (stem.includes(want) || want.includes(stem)) near.push(bundle);
	}

	return { present: !!hit, ...(hit ? { path: hit } : {}), near: near.slice(0, 8) };
}

/** "Notion Calendar.app" and "Notion Calendar" are the same request. */
export function bundleStem(name: string): string {
	return name.trim().replace(/\.app$/i, "").trim();
}

/**
 * Write the files the far side runs and reads. They are files rather than remote commands
 * because their content is multi-line shell and operator-supplied text — the two things that
 * must never be interpolated into an argv sshd is about to flatten into a shell string.
 *
 * Returns the names written, so a caller can log the payload without re-reading the directory.
 */
export function stageInstallFiles(dir: string, source: AppSource, dest: string): string[] {
	const checked = assertSource(source);
	if (/[\n\r]/.test(dest)) throw new Error(`destination ${JSON.stringify(dest)} contains a newline`);

	const files: [name: string, body: string, mode: number][] = [
		// Line-oriented and positional. Read on the far side with `sed -n Np` straight into a
		// quoted variable, so a value containing a space, a quote or a `;` is data there for the
		// same reason it is data here: it is never on a command line.
		["request", `${checked.kind}\n${checked.app}\n${dest}\n${checked.url ?? ""}\n`, 0o600],
		["fetch.sh", FETCH_SCRIPT, 0o755],
		["install-app.sh", INSTALL_SCRIPT, 0o755],
	];

	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const [name, body, mode] of files) {
		const target = path.join(dir, name);
		fs.writeFileSync(target, body);
		// Explicit, because writeFileSync's mode applies only to a file it creates, and rsync
		// --archive carries the bit across: a script that arrives non-executable fails as
		// "Permission denied" on the far side, minutes later.
		fs.chmodSync(target, mode);
	}

	return files.map(([name]) => name);
}

/**
 * rsync argv for a payload.
 *
 * Deliberately NOT provision.ts's `rsyncArgv`: that one excludes `node_modules`, and an
 * Electron .app carries one inside Contents/Resources/app. Syncing a bundle through those
 * excludes produces an app that copies cleanly, installs cleanly, verifies as present, and
 * crashes on launch — the exact class of failure this module's verify step exists to catch,
 * arriving in a form it cannot catch.
 */
export function payloadRsyncArgv(host: HostEntry, source: string, remoteDest: string, shape: "file" | "directory"): string[] {
	const destination = rsyncDestination(host, remoteDest);

	// A trailing slash on a directory is what stops rsync nesting the tree one level deeper; the
	// same slash on a FILE source is an error ("not a directory"), which is why the shape is a
	// parameter rather than a guess — a dmg and a bundle both arrive here as a path.
	const dir = shape === "directory";

	return [
		// --archive because a .app is a directory whose executable bits and symlinks are the
		// difference between an app and a folder.
		"--archive",
		"--compress",
		"--partial",
		// --delete here and nowhere else in the repo, and only for a directory: the destination is
		// a payload directory this module owns and recreates, so a stale bundle from a previous
		// install would otherwise be what the installer finds.
		...(dir ? ["--delete"] : []),
		"--rsh", rshCommand(host),
		dir ? `${source.replace(/\/+$/, "")}/` : source,
		dir ? `${destination}/` : destination,
	];
}

const GRANTS_UNKNOWN =
	"installing cannot grant Accessibility or Screen Recording — SIP blocks writing the TCC database. Grant them in System Settings > Privacy & Security if the demo needs the app itself to record or read the AX tree.";

/**
 * What the operator has to be told about permissions, every time.
 *
 * There is nothing to probe here: reading the TCC database needs Full Disk Access, which the
 * fleet identity does not have and should not be given. What IS knowable is whether this pass
 * put a new bundle on the machine, and that answers the question that matters — a bundle
 * copied a minute ago holds no grants at all, and a replaced one keeps its grants only while
 * its code signature is unchanged.
 */
function grantsNote(app: string, presence: AppPresence | undefined, installed: boolean, replaced: boolean): string {
	if (!installed) return GRANTS_UNKNOWN;

	return replaced
		? `${app} was replaced in place — an existing Accessibility or Screen Recording grant survives only while the code signature is unchanged, and a new build's is not. ${GRANTS_UNKNOWN}`
		: `${app} was installed just now at ${presence?.path ?? "an unknown path"} and therefore holds NO Accessibility or Screen Recording grant. ${GRANTS_UNKNOWN}`;
}

function remoteStage(): string {
	return `${REMOTE_CHECKOUT}/${INSTALL_STAGE_DIR}`;
}

function remotePayload(kind: AppSource["kind"]): string {
	return `${remoteStage()}/${PAYLOAD_STEM}.${kind}`;
}

/** https or nothing. A URL is attacker-influenced data, and `file:` and `http:` both fetch. */
function httpsUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new Error(`${JSON.stringify(raw)} is not a URL`);
	}
	if (url.protocol !== "https:") throw new Error(`refusing ${url.protocol}//… — an installer URL must be https (got ${JSON.stringify(raw)})`);

	// Re-serialised, not echoed: the parser is what decides what this string means, and shipping
	// the operator's original text would let the two disagree.
	return url.toString();
}

/** dmg, zip, or a bundle — or nothing, when the name carries no suffix we act on. */
function kindOf(name: string): AppSource["kind"] | undefined {
	const ext = path.extname(name).toLowerCase();
	if (ext === ".dmg") return "dmg";
	if (ext === ".zip") return "zip";
	if (ext === ".app") return "app";

	return undefined;
}

/** The throwing form, for a local path — where there is no server to ask and the name is all there is. */
function archiveKind(pathname: string, shown: string): AppSource["kind"] {
	const kind = kindOf(pathname);
	if (kind) return kind;

	throw new Error(`${shown}: expected a .dmg, .zip or .app, got ${path.extname(pathname).toLowerCase() || "no extension"}`);
}

/** What a HEAD told us about where a download link actually goes. */
export interface DownloadFacts {
	/** The URL after redirects. */
	finalUrl: string;
	/** Raw `Content-Disposition`, if the server sent one. */
	disposition?: string;
}

/**
 * The kind of a download that does not admit it in its path.
 *
 * A vendor "latest for this platform" link is the normal shape of a release URL — ours is
 * `https://dl.yarn.so/download/mac_arm64` — and it names no file at all. The filename exists,
 * but it is in a `Content-Disposition` header, and sometimes only there: the GitHub release
 * asset that link redirects to has an opaque UUID path and announces
 * `attachment; filename=Yarn-0.0.119-arm64.dmg`.
 *
 * Header first, then the redirect target's path. The header is what the browser would name the
 * file, so when both are present it is the more truthful of the two.
 */
export function kindFromDownload(facts: DownloadFacts): AppSource["kind"] | undefined {
	const named = dispositionFilename(facts.disposition);
	if (named) {
		const kind = kindOf(named);
		if (kind) return kind;
	}

	try {
		return kindOf(new URL(facts.finalUrl).pathname);
	} catch {
		return undefined;
	}
}

/**
 * The filename out of a `Content-Disposition`, reduced to a bare basename.
 *
 * Only the suffix is ever used, but the value is server-controlled and reaches `path.extname`,
 * so a `filename="../../x.dmg"` is cut down to `x.dmg` here rather than trusted to be harmless
 * because of what the caller happens to do with it today.
 */
function dispositionFilename(disposition?: string): string | undefined {
	if (!disposition) return undefined;

	// filename* (RFC 5987, `UTF-8''name`) wins over filename when a server sends both, which is
	// what the RFC asks of a recipient that understands it.
	const extended = /filename\*\s*=\s*[^']*''([^;\s]+)/i.exec(disposition);
	const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition);
	const raw = extended?.[1] ?? plain?.[1] ?? plain?.[2];
	if (!raw) return undefined;

	let decoded = raw.trim();
	try {
		decoded = decodeURIComponent(decoded);
	} catch {
		// A stray % is not a reason to discard an otherwise usable name.
	}

	return path.posix.basename(decoded.replace(/\\/g, "/")).trim() || undefined;
}

/** Ask the server where a link goes. Overridable so the parser can be tested without a network. */
export type DownloadProbe = (url: string) => Promise<DownloadFacts>;

/** Long enough for a redirect chain across a CDN, short enough not to look like a hang. */
const PROBE_TIMEOUT_MS = 20_000;

async function headProbe(url: string): Promise<DownloadFacts> {
	// HEAD, not GET: this is a 284MB dmg on the other end and the only interesting part of the
	// answer is the header. The body is downloaded once, on the remote, by the fetch script.
	const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`HEAD ${url} answered ${res.status} ${res.statusText}`);

	return { finalUrl: res.url || url, disposition: res.headers.get("content-disposition") ?? undefined };
}

/**
 * `parseAppSource`, plus one network round trip for the case it cannot decide alone.
 *
 * Kept separate from the parser rather than folded into it: `parseAppSource` is pure and every
 * other caller wants it to stay that way. Only the CLI, which has an operator and a network in
 * front of it, pays for the probe.
 *
 * The source keeps the ORIGINAL url. The redirect we followed here resolved, for our link, to a
 * signed asset URL with a one-hour expiry and a signature bound to this request — sending that
 * to three Macs would be sending three copies of a credential that may already be stale. The
 * remote's `curl --location` follows the same chain itself and gets its own.
 */
export async function resolveAppSource(app: string, spec: string, probe: DownloadProbe = headProbe): Promise<AppSource> {
	const trimmed = spec.trim();
	if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return parseAppSource(app, spec);

	const url = httpsUrl(trimmed);
	const fromPath = kindOf(new URL(url).pathname);
	if (fromPath) return assertSource({ app, kind: fromPath, url });

	let facts: DownloadFacts;
	try {
		facts = await probe(url);
	} catch (e) {
		throw new Error(`${url}: the link names no .dmg, .zip or .app, and asking the server where it goes failed — ${(e as Error).message}`);
	}

	const kind = kindFromDownload(facts);
	if (!kind)
		throw new Error(
			`${url}: expected a .dmg, .zip or .app. It redirects to ${facts.finalUrl}` +
				`${facts.disposition ? ` and offers ${JSON.stringify(facts.disposition)}` : " and offers no filename"}, ` +
				`neither of which names one.`,
		);

	return assertSource({ app, kind, url });
}

/**
 * Fetch on the REMOTE. The download has to happen there rather than here and be rsynced up:
 * pulling a 400MB dmg down an operator's laptop link and pushing it back over a colo link is
 * two transfers to accomplish one, and on three hosts it is six.
 */
const FETCH_SCRIPT = `#!/bin/sh
# Written by src/fleet/remote/install.ts. Edit there, not here — every install overwrites this.
set -eu
STAGE="$HOME/${REMOTE_CHECKOUT}/${INSTALL_STAGE_DIR}"
REQ="$STAGE/request"

KIND=$(sed -n '1p' "$REQ")
URL=$(sed -n '4p' "$REQ")
[ -n "$URL" ] || { echo "no url in the request — nothing to fetch" >&2; exit 2; }

# Checked on the sending side too. This copy is the one running on the machine that makes the
# request, and it is the only one that still applies if the request file is ever written by
# something else.
case "$URL" in
https://*) ;;
*) echo "refusing to fetch a non-https url" >&2; exit 2 ;;
esac

OUT="$STAGE/${PAYLOAD_STEM}.$KIND"
rm -f "$OUT"
# --fail: without it curl writes the 404 body to the file and exits 0, and the mount below then
# fails with a message about a corrupt disk image instead of about a dead link.
# --location: a release URL is almost always a redirect to a CDN.
curl --fail --location --silent --show-error --max-time 900 --output "$OUT" -- "$URL"
# A login wall answers 200 with HTML. Size alone does not prove it is an archive, but zero bytes
# proves it is not, and that is the failure that otherwise reads as a broken installer.
[ -s "$OUT" ] || { echo "downloaded 0 bytes" >&2; exit 2; }

printf 'fetched %s bytes\\n' "$(wc -c < "$OUT" | tr -d ' ')"
`;

/**
 * Mount or expand the payload, copy the bundle into place, and leave nothing mounted.
 *
 * The trap is the load-bearing line. An image left attached because the copy failed makes the
 * NEXT attach of the same image fail with "resource busy", so a single failure poisons every
 * retry until someone logs in over VNC and ejects it by hand — on a headless colo Mac that is
 * the difference between a retry and a support call.
 */
const INSTALL_SCRIPT = `#!/bin/sh
# Written by src/fleet/remote/install.ts. Edit there, not here — every install overwrites this.
set -eu
STAGE="$HOME/${REMOTE_CHECKOUT}/${INSTALL_STAGE_DIR}"
REQ="$STAGE/request"

# sed into a quoted variable, never a command line: these three values are operator text, and
# "Notion Calendar" is the normal case rather than the adversarial one.
KIND=$(sed -n '1p' "$REQ")
NAME=$(sed -n '2p' "$REQ")
DEST=$(sed -n '3p' "$REQ")
[ -n "$NAME" ] || { echo "request carries no app name" >&2; exit 2; }

MNT=""
WORK=""
PART=""
cleanup() {
	# Detach first and unconditionally, before anything that could itself fail. Whatever went
	# wrong above, an attached image is a machine that cannot retry.
	if [ -n "$MNT" ]; then
		hdiutil detach "$MNT" -force >/dev/null 2>&1 || true
		rmdir "$MNT" >/dev/null 2>&1 || true
	fi
	[ -z "$WORK" ] || rm -rf "$WORK" || true
	# A half-copied bundle under a dot name is invisible to Launch Services but not to disk.
	[ -z "$PART" ] || rm -rf "$PART" || true
	# Payloads are hundreds of MB and the remote checkout is rsynced but never pruned, so one
	# left behind is permanent.
	rm -rf "$STAGE/${PAYLOAD_STEM}.dmg" "$STAGE/${PAYLOAD_STEM}.zip" "$STAGE/${PAYLOAD_STEM}.app" || true
}
trap cleanup EXIT

case "$KIND" in
dmg)
	MNT=$(mktemp -d "\${TMPDIR:-/tmp}/yarn-install-mnt.XXXXXX")
	# -nobrowse and -noautoopen: the fleet Macs are watched over VNC and recorded. An image that
	# mounts into the Finder sidebar and opens its own window steals focus from whatever a run
	# is capturing.
	hdiutil attach "$STAGE/${PAYLOAD_STEM}.dmg" -nobrowse -readonly -noautoopen -mountpoint "$MNT" >/dev/null
	SRC="$MNT"
	;;
zip)
	WORK=$(mktemp -d "\${TMPDIR:-/tmp}/yarn-install-zip.XXXXXX")
	# ditto, not unzip: unzip drops the extended attributes and resource forks a bundle's code
	# signature is computed over, and the unpacked app is then refused by Gatekeeper.
	ditto -x -k "$STAGE/${PAYLOAD_STEM}.zip" "$WORK"
	SRC="$WORK"
	;;
app)
	SRC="$STAGE"
	;;
*)
	echo "unknown payload kind: $KIND" >&2
	exit 2
	;;
esac

# Prefer the bundle actually asked for. A dmg routinely carries more than one — an uninstaller,
# a bundled helper — and picking the first would install whichever one sorts earliest.
APP=""
if [ -d "$SRC/$NAME.app" ]; then
	APP="$SRC/$NAME.app"
else
	LIST=$(mktemp "\${TMPDIR:-/tmp}/yarn-install-list.XXXXXX")
	# -prune so find stops at the bundle instead of walking into it; depth 2 because a dmg
	# commonly nests the app in a folder beside the Applications symlink.
	find "$SRC" -maxdepth 2 -name '*.app' -prune -print > "$LIST" 2>/dev/null || true
	N=$(wc -l < "$LIST" | tr -d ' ')
	if [ "$N" = "1" ]; then
		APP=$(cat "$LIST")
	else
		echo "expected one .app in the payload, found $N:" >&2
		cat "$LIST" >&2 || true
		rm -f "$LIST"
		exit 2
	fi
	rm -f "$LIST"
fi

BASE=$(basename "$APP")
# The payload stem is a placeholder: an rsync destination is shell input on this side, so a
# bundle uploaded from a local path cannot be named after the app until it is already here.
[ "$BASE" != "${PAYLOAD_STEM}.app" ] || BASE="$NAME.app"

mkdir -p "$DEST" 2>/dev/null || true
if [ ! -w "$DEST" ]; then
	# /Applications is writable by admin; a standard account is not one. Falling back keeps an
	# unattended install working, and the caller's verify step reports which directory it landed
	# in — the two are not equivalent, since a per-user copy is invisible to other accounts.
	DEST="$HOME/Applications"
	mkdir -p "$DEST"
fi

# Copy beside the target and move into place. ditto straight over a live bundle leaves a mixture
# of two versions when it fails halfway, and a mixed .app launches and then crashes.
PART="$DEST/.yarn-install-$$.app"
rm -rf "$PART"
ditto "$APP" "$PART"
# curl sets no quarantine bit, but an operator's browser-downloaded dmg rsynced up does, and
# Gatekeeper's confirmation is a modal dialog — on an unattended machine it is a hang.
xattr -dr com.apple.quarantine "$PART" >/dev/null 2>&1 || true
rm -rf "$DEST/$BASE"
mv "$PART" "$DEST/$BASE"
PART=""

printf 'installed=%s\\n' "$DEST/$BASE"
`;

interface Attempt {
	ok: boolean;
	/** One line, ready for a table cell. */
	detail: string;
	stdout: string;
	code?: number;
}

/**
 * Run one remote thing and reduce it to pass/fail plus a line. Catches as well as checking the
 * exit code: an injected runner, or an ssh that cannot be spawned at all, throws rather than
 * resolving, and a step must degrade rather than unwind the pass.
 */
async function attempt(fn: () => Promise<SshResult>): Promise<Attempt> {
	let result: SshResult;
	try {
		result = await fn();
	} catch (e) {
		return { ok: false, detail: (e as Error).message, stdout: "" };
	}

	if (result.code === 0) return { ok: true, detail: firstLine(result.stdout), stdout: result.stdout, code: 0 };

	return {
		ok: false,
		detail: firstLine(result.stderr) || firstLine(result.stdout) || describeExit(result.code),
		stdout: result.stdout,
		code: result.code,
	};
}

function describeExit(code: number): string {
	if (code === TIMEOUT_EXIT) return "timed out";
	if (code === SPAWN_FAILED_EXIT) return "could not be started";

	return `exited ${code}`;
}

const USAGE = `usage: tsx src/fleet/remote/install.ts "<App Name>" <https://… | /path/to/App.{app,dmg,zip}> [--host <name>] [--force]
       tsx src/fleet/remote/install.ts "<App Name>" --check [--host <name>]

  (no --host)     every Mac in hosts.json
  --check         do not change anything; ask each host whether the app is there
  --force         reinstall over a bundle that is already present`;

/** \`./run install "Notion Calendar" https://…\` — the fleet as a table of what is where. */
async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const at = argv.indexOf("--host");
	const only = at >= 0 ? argv[at + 1] : undefined;
	if (at >= 0 && !only) {
		console.error(`--host needs a host name\n${USAGE}`);
		process.exit(2);
	}

	// `at + 1` is the host name, which is a value and not a positional. Guarded, because with no
	// --host at all `at` is -1 and the arithmetic would otherwise swallow the app name.
	const hostValueAt = at >= 0 ? at + 1 : -1;
	const positional = argv.filter((a, i) => !a.startsWith("--") && i !== hostValueAt);
	const [app, spec] = positional;
	const check = argv.includes("--check");
	if (!app || (!spec && !check)) {
		console.error(USAGE);
		process.exit(2);
	}

	const all = loadHosts();
	const inv = only ? { schema: all.schema, hosts: [resolveHost(only, all)] } : all;

	if (check) {
		const rows = await Promise.all(inv.hosts.map((h) => appPresence(h, app)));
		for (const row of rows) {
			const state = row.reason ? "unknown" : row.present ? row.path : "MISSING";
			console.log(`${row.host.padEnd(8)} ${state}${row.reason ? ` — ${row.reason}` : ""}`);
			if (!row.present && row.near.length) console.log(`  closest: ${row.near.join(", ")}`);
		}
		if (rows.some((r) => !r.present)) process.exitCode = 1;

		return;
	}

	let source: AppSource;
	try {
		source = await resolveAppSource(app, spec);
	} catch (e) {
		console.error(`${(e as Error).message}\n${USAGE}`);
		process.exit(2);
	}

	console.log(`installing ${source.app} on ${inv.hosts.length} host(s) from ${source.url ?? source.path}`);
	const rows = await installFleet(inv, source, { force: argv.includes("--force") });
	for (const row of rows) {
		// Every step, always: a pass that stopped at `deliver` and one that stopped at `verify`
		// are the same word in a status column and completely different problems.
		console.log(`${row.host.padEnd(8)} ${(row.ok ? "ok" : "FAILED").padEnd(7)} ${row.steps.map((s) => `${s.step}${s.ok ? "" : " ✗"}`).join(" · ")}`);
		for (const step of row.steps) if (step.detail) console.log(`  ${step.step}: ${step.detail}`);
		console.log(`  grants: ${row.grants}`);
	}
	if (rows.some((r) => !r.ok)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	main().catch((err) => {
		console.error(`install failed: ${err}`);
		process.exit(1);
	});
