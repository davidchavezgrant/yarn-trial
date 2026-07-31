import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resourcesRoot } from "../paths.js";
import { type HostEntry, type Inventory, loadHosts, resolveHost } from "./hosts.js";
import { firstLine, runnerArgv, type RsyncRunner, runRsync, runSsh, rsyncDestination, SPAWN_FAILED_EXIT, type SshResult, sshArgv, type SshRunner, TIMEOUT_EXIT } from "./ssh.js";
import { checkModelKey, CREDENTIALS_FILENAME } from "./team.js";

/**
 * Turning a Mac into a host that accepts jobs, and asking one whether it still is.
 *
 * Three properties shape everything below.
 *
 * 1. THE RUNNER MUST BE THE ELECTRON PROCESS. macOS attributes Accessibility and Screen
 *    Recording to the *responsible* process and children inherit them. A run spawned from an
 *    sshd session is responsible to sshd, so it gets an empty AX tree and a black screenshot
 *    with NO error to explain either — the worst failure shape available, because it looks
 *    like a bad appmap. So provisioning does not install a node daemon: it installs a
 *    LaunchAgent that starts `electron … --serve`, which holds the socket, and every run
 *    descends from that. The agent is bootstrapped into `gui/<uid>` and never `user/<uid>`
 *    for the same reason — a job in the user domain has no window server session.
 *
 * 2. NOTHING VARIABLE CROSSES AS TEXT. sshd does not receive an argv; it joins the remote
 *    arguments into one string for a login shell (see the header of ssh.ts). Every remote
 *    command here is therefore built from tokens that are constants in this file, and
 *    everything with content — two shell shims, a plist, two installers — is written to a
 *    local tmpdir and delivered by rsync. rsync itself runs over the SAME ssh argv, so the
 *    pin, the identity and the multiplexed control socket are the ones ssh.ts defines rather
 *    than a second copy that can drift into not checking the host key.
 *
 * 3. A STEP FAILS, NOT THE PASS. Provisioning three colo machines has as many ways to fail as
 *    it has steps, and each one is actionable on its own — so every step reports, nothing
 *    throws for one step's sake, and the fan-out isolates per host exactly as fleetStatus
 *    does.
 */

/**
 * Where the checkout lands on every Mac: `~/yarn-trial`. Relative rather than absolute because
 * rsync resolves it against the login home and the shims read `$HOME` on the far side — the
 * one path this side genuinely does not know. Not an option: it is baked into the shims, the
 * plist and both installers, and a per-call override would be operator text on a command line
 * sshd is about to flatten into a shell string.
 */
export const REMOTE_CHECKOUT = "yarn-trial";

/** Provisioning payload inside the checkout: shims, plist template, installers. */
export const STAGE_DIR = ".provision";

export const LAUNCH_LABEL = "com.yarn.runner";

/**
 * Anchored where a name is the repo root's and unanchored where it can nest. `out/` is the
 * remote's own job registry and run logs — it must survive a re-provision, which is also why
 * `--delete` is absent below.
 */
const SYNC_EXCLUDES = [
	"node_modules",
	".git",
	".DS_Store",
	"/out/",
	// Rebuilt on the far side against the sources we just shipped; a stale build copied over
	// the top is a runner serving code nobody can find in the tree.
	"/dist-electron/",
	"/tmp/",
	// The two secrets, named rather than pattern-matched: a pattern that stops matching is
	// silent, and both of these grant more than the machine they would land on.
	"/.env",
	`/${CREDENTIALS_FILENAME}`,
];

/** Long enough for `launchctl bootstrap` and an installer, short enough to not hang a fan-out. */
const PROVISION_TIMEOUT_MS = 60_000;

/** A first sync ships the whole checkout minus node_modules over a colo link. */
const SYNC_TIMEOUT_MS = 900_000;

/**
 * First boot runs `npm install` and a tsc build against a tree that has just changed, so the
 * socket can legitimately be minutes away. A timeout here means "not yet", and the step says so.
 */
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 3_000;

export type StepName = "reach" | "sync" | "runnerctl" | "launchagent" | "ready";

const STEP_ORDER: StepName[] = ["reach", "sync", "runnerctl", "launchagent", "ready"];

export interface ProvisionStep {
	step: StepName;
	ok: boolean;
	detail?: string;
}

export interface ProvisionResult {
	host: string;
	ok: boolean;
	/** In `STEP_ORDER`, truncated where the first failure stopped the pass. */
	steps: ProvisionStep[];
}

export interface ProvisionOptions {
	run?: SshRunner;
	rsync?: RsyncRunner;
	/** Local tree to ship. Defaults to the checkout; overridden in tests so nothing real is read. */
	source?: string;
	timeoutMs?: number;
	syncTimeoutMs?: number;
	/** 0 makes `ready` a single probe with no sleep, which is what tests want. */
	readyTimeoutMs?: number;
}

/**
 * Make one Mac ready to accept jobs. Idempotent: every step either finds what it wants or
 * puts it there, so a re-run after adding a fourth machine — or after changing one line of
 * the agent — is the same call.
 */
export async function provisionHost(host: HostEntry, opts: ProvisionOptions = {}): Promise<ProvisionResult> {
	const run = opts.run ?? runSsh;
	const rsync = opts.rsync ?? runRsync;
	const source = opts.source ?? resourcesRoot();
	const timeoutMs = opts.timeoutMs ?? PROVISION_TIMEOUT_MS;
	const steps: ProvisionStep[] = [];
	const done = (): ProvisionResult => ({
		host: host.name,
		ok: steps.length === STEP_ORDER.length && steps.every((s) => s.ok),
		steps,
	});
	const fail = (step: StepName, detail: string): ProvisionResult => {
		steps.push({ step, ok: false, detail });

		return done();
	};

	// An unpinned host has no verified key. Syncing to it would hand the checkout — and,
	// through the shims, the shape of the whole fleet — to whatever answered the address.
	if (!host.hostKey) return fail("reach", "no pinned host key — pin it before provisioning");

	const reach = await attempt(() => run(host, ["true"], { timeoutMs }));
	if (!reach.ok) return fail("reach", reach.detail);
	steps.push({ step: "reach", ok: true, detail: `${host.ssh.user}@${host.ssh.host}` });

	// Both rsync destinations exist before either transfer: macOS ships openrsync, which
	// creates the last path component and not the parents, so a stage-only re-run against a
	// machine that has never been synced would otherwise fail on a missing checkout dir.
	const mk = await attempt(() => run(host, ["mkdir", "-p", `${REMOTE_CHECKOUT}/${STAGE_DIR}`], { timeoutMs }));
	if (!mk.ok) return fail("sync", `could not create ${REMOTE_CHECKOUT}/${STAGE_DIR}: ${mk.detail}`);

	const stage = fs.mkdtempSync(path.join(os.tmpdir(), "yarn-provision-"));
	let synced: Attempt;
	try {
		// Same source as every other entry point: `run` sources ../yarn/.env before exec'ing
		// node, so the key is in the environment or it does not exist. Absent is not an error —
		// a host can be provisioned by someone who has no key and get one later from the GUI.
		stageProvisioningFiles(stage, process.env.OPENROUTER_API_KEY);
		synced = await attempt(() => rsync(rsyncArgv(host, source, REMOTE_CHECKOUT), { timeoutMs: opts.syncTimeoutMs ?? SYNC_TIMEOUT_MS }));
		if (synced.ok) synced = await attempt(() => rsync(rsyncArgv(host, stage, `${REMOTE_CHECKOUT}/${STAGE_DIR}`), { timeoutMs }));
	} catch (e) {
		synced = { ok: false, detail: (e as Error).message, stdout: "" };
	} finally {
		// The staged copy is disposable the moment it is on the far side; the installers all
		// read it from the remote checkout.
		fs.rmSync(stage, { recursive: true, force: true });
	}
	if (!synced.ok) return fail("sync", synced.detail);
	steps.push({ step: "sync", ok: true, detail: `${source} -> ${REMOTE_CHECKOUT}/` });

	const shim = await attempt(() => run(host, ["sh", `${REMOTE_CHECKOUT}/${STAGE_DIR}/install-runnerctl.sh`], { timeoutMs }));
	if (!shim.ok) return fail("runnerctl", shim.detail);

	// Installed is not the same as findable. `ssh host runnerctl` runs a NON-interactive shell
	// whose PATH comes from /etc/paths via path_helper, which lists /usr/local/bin and does not
	// list ~/.local/bin — so the installer's fallback also has to have written the PATH line.
	// Exit 127 here is precisely the "command not found" every host answers today.
	const probe = await attempt(() => run(host, runnerArgv("status"), { timeoutMs }));
	if (probe.code === 127 || /command not found|: not found/i.test(probe.detail))
		return fail("runnerctl", `installed but not on the non-interactive PATH: ${probe.detail}`);
	steps.push({ step: "runnerctl", ok: true, detail: firstLine(shim.stdout) || "installed" });

	const agent = await attempt(() => run(host, ["sh", `${REMOTE_CHECKOUT}/${STAGE_DIR}/install-launchagent.sh`], { timeoutMs }));
	if (!agent.ok) return fail("launchagent", agent.detail);
	steps.push({ step: "launchagent", ok: true, detail: firstLine(agent.stdout) || LAUNCH_LABEL });

	const ready = await waitForRunner(host, run, timeoutMs, opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
	if (!ready.ok) return fail("ready", ready.detail);
	steps.push({ step: "ready", ok: true, detail: ready.detail });

	return done();
}

/**
 * Fan out, one row per host, in the same shape as fleetStatus — a powered-off colo box costs
 * its own row and nothing else. Parallel because the expensive step is a network copy, and
 * three of those overlap for free.
 */
export function provisionFleet(inv: Inventory, opts: ProvisionOptions = {}): Promise<ProvisionResult[]> {
	return Promise.all(
		inv.hosts.map(async (host) => {
			try {
				return await provisionHost(host, opts);
			} catch (e) {
				// provisionHost is written not to throw; this is the backstop that keeps a bug in
				// it from blanking the other two rows.
				return { host: host.name, ok: false, steps: [{ step: "reach" as StepName, ok: false, detail: (e as Error).message }] };
			}
		}),
	);
}

export interface RemoteEnvFile {
	path?: string;
	present?: boolean;
	mode?: string;
	warning?: string;
}

/** The half of serve.ts's `doctor` payload this module renders and grades. */
export interface RemoteDoctor {
	runnerDir?: string;
	socketPath?: string;
	packaged?: boolean;
	resourcesRoot?: string;
	envFile?: RemoteEnvFile;
	tools?: { ffmpeg?: boolean; python3?: boolean; npx?: boolean };
	apiKey?: string;
	permissions?: { accessibility?: boolean; screenRecording?: boolean } | null;
	/** Grants that landed after the runner process started, and so are not in effect. */
	staleGrants?: string[];
	/** The DOM-enrichment sidecar, which reaches the host as an rsync'd build artifact. */
	sidecar?: { path?: string; usable?: boolean; problem?: string };
	/** Whether the login window owns the display. Absent from older runners, which is not false. */
	screenLocked?: boolean;
	lease?: { holder?: { lease?: { operator?: string; app?: string }; heldSec?: number } };
}

export interface DoctorRow {
	host: string;
	reachable: boolean;
	report?: RemoteDoctor;
	/** Everything wrong that the operator can act on. Empty means the host is demo-ready. */
	problems: string[];
	/** Why there is no report. Absent when one parsed. */
	reason?: string;
}

export interface DoctorOptions {
	run?: SshRunner;
	timeoutMs?: number;
}

/** `runnerctl doctor` over ssh, graded. */
export async function doctorHost(host: HostEntry, opts: DoctorOptions = {}): Promise<DoctorRow> {
	const run = opts.run ?? runSsh;
	const timeoutMs = opts.timeoutMs ?? PROVISION_TIMEOUT_MS;

	if (!host.hostKey) return { host: host.name, reachable: false, problems: [], reason: "no pinned host key — run the known_hosts writer first" };

	const result = await attempt(() => run(host, runnerArgv("doctor"), { timeoutMs }));
	if (!result.ok) return { host: host.name, reachable: result.code !== SPAWN_FAILED_EXIT && result.code !== TIMEOUT_EXIT, problems: [], reason: result.detail };

	let parsed: unknown;
	try {
		parsed = JSON.parse(firstJsonLine(result.stdout));
	} catch {
		// A login banner or an npm warning on stdout is a live possibility on a machine nobody
		// has finished setting up, and it is a degraded row rather than a crash.
		return { host: host.name, reachable: true, problems: [], reason: "doctor output was not JSON" };
	}
	if (!parsed || typeof parsed !== "object") return { host: host.name, reachable: true, problems: [], reason: "doctor output was not an object" };

	const report = parsed as RemoteDoctor;

	return { host: host.name, reachable: true, report, problems: doctorProblems(report) };
}

export function doctorFleet(inv: Inventory, opts: DoctorOptions = {}): Promise<DoctorRow[]> {
	return Promise.all(
		inv.hosts.map(async (host) => {
			try {
				return await doctorHost(host, opts);
			} catch (e) {
				return { host: host.name, reachable: false, problems: [], reason: (e as Error).message };
			}
		}),
	);
}

export interface RestartRow {
	host: string;
	/** False when the host was skipped, refused, or unreachable. */
	restarted: boolean;
	detail: string;
}

/**
 * Bounce the runners whose grants are stale, and only those.
 *
 * Conditional by default because a restart is not free: it drops the process holding the
 * fleet's TCC grants for as long as launchd takes to bring it back, and doing that to a host
 * that was fine is a self-inflicted outage. `all` is the escape hatch for the case where doctor
 * cannot say — an unreachable or non-JSON host reports nothing to grade.
 *
 * A busy host is skipped rather than forced: the runner refuses anyway, and the useful thing to
 * print is which run is in the way.
 */
export async function restartFleet(inv: Inventory, opts: DoctorOptions & { all?: boolean } = {}): Promise<RestartRow[]> {
	const run = opts.run ?? runSsh;
	const timeoutMs = opts.timeoutMs ?? PROVISION_TIMEOUT_MS;

	return Promise.all(
		inv.hosts.map(async (host): Promise<RestartRow> => {
			if (!opts.all) {
				const row = await doctorHost(host, opts);
				if (row.reason) return { host: host.name, restarted: false, detail: `cannot tell: ${row.reason}` };
				if (!row.report?.staleGrants?.length) return { host: host.name, restarted: false, detail: "no stale grant — left alone" };
			}
			const res = await attempt(() => run(host, runnerArgv("restart"), { timeoutMs }));

			return { host: host.name, restarted: res.ok, detail: res.ok ? "restarting; launchd respawns it in a few seconds" : res.detail };
		}),
	);
}

/**
 * Grade a doctor payload.
 *
 * `permissions: null` is the one worth reading twice: serve.ts only reports permissions when
 * `electron/main.ts` injected the probe, so a null means the socket is being held by something
 * that is NOT the Electron process — which is the TCC failure this whole module exists to
 * avoid, and which is otherwise invisible until a run comes back with an empty AX tree.
 */
export function doctorProblems(report: RemoteDoctor): string[] {
	const problems: string[] = [];

	if (report.apiKey === undefined || report.apiKey === "MISSING")
		problems.push(`no model API key — put OPENROUTER_API_KEY in ${report.runnerDir ?? "~/.yarn-runner"}/env`);
	if (report.envFile?.warning) problems.push(report.envFile.warning);
	if (report.tools?.ffmpeg === false) problems.push("ffmpeg missing — --record cannot assemble an mp4");
	if (report.tools?.python3 === false) problems.push("python3 missing — pixel-delta verification degrades");
	// Only meaningful unpackaged: a packaged runner ships its own node runtime and never shells
	// out to npx (see resolveRunCommand).
	if (report.tools?.npx === false && !report.packaged) problems.push("npx missing — the runner cannot start a run");

	if (report.permissions === null || report.permissions === undefined)
		problems.push("the runner is not the Electron process — TCC grants attach to it, so runs will see an empty AX tree with no error");
	else {
		if (report.permissions.accessibility === false) problems.push("Accessibility not granted — grant it to Electron in System Settings > Privacy & Security");
		if (report.permissions.screenRecording === false) problems.push("Screen Recording not granted — grant it to Electron in System Settings > Privacy & Security");
	}

	// Reported even though the permission now reads as granted, which is the whole point: macOS
	// gives a process its answer at launch, so the box is ticked and the capture is still empty.
	// Without this the host grades clean and the run fails looking like a broken agent.
	if (report.staleGrants?.length)
		problems.push(`${report.staleGrants.join(" and ")} granted after the runner started, so not in effect — restart it: ./run provision --restart`);

	// Degraded, not broken: runs still complete, they just lose the names of every anonymous
	// control. That is precisely why it needs saying here — nothing else about the host looks
	// wrong, and the symptom shows up as an agent that cannot find buttons.
	if (report.sidecar && report.sidecar.usable === false)
		problems.push(`DOM enrichment sidecar unusable (${report.sidecar.problem ?? "unknown"}) — runs work but anonymous controls stay unnamed`);

	// Last because it is the most total: a locked host cannot run anything, whatever else it has.
	// Tested against `=== true` rather than truthiness so a runner too old to report the field
	// stays silent instead of being graded clean on a question it was never asked.
	if (report.screenLocked === true)
		problems.push("SCREEN LOCKED — no app windows are composited, so every run fails with an empty AX tree. Unlock it: ./run signin <host>");

	return problems;
}

/**
 * The `ssh …` word rsync needs for `--rsh`, taken off the front of the real argv rather than
 * restated. A second copy of these options would drift, and the copy that drifts is the one
 * that stops pinning the host key.
 */
export function rshCommand(host: HostEntry): string {
	// sshArgv puts `user@host` last when there is no remote command; the rest is transport.
	const transport = sshArgv(host, []).slice(0, -1);
	// rsync splits this string on whitespace itself and honours no quoting, so a path with a
	// space in it silently becomes two arguments. Refuse rather than ship that to three Macs.
	const spaced = transport.find((opt) => /\s/.test(opt));
	if (spaced) throw new Error(`ssh option ${JSON.stringify(spaced)} contains whitespace — rsync's --rsh cannot carry it (point YARN_RUNNER_HOME at a path without spaces)`);

	return ["ssh", ...transport].join(" ");
}

/**
 * Deliberately no `--delete`. The remote checkout is also the runner's data root: `out/` holds
 * the job registry and the logs of runs that may be in flight, and a sync that deletes is one
 * typo in the exclude list away from taking them with it.
 */
export function rsyncArgv(host: HostEntry, source: string, remoteDir: string): string[] {
	// Built before the argv, not inside it: rsyncDestination is the check, and taking its
	// return value is what makes skipping the check impossible rather than merely unlikely.
	const destination = rsyncDestination(host, remoteDir);

	return [
		// --archive keeps mtimes, which is what lets the remote build step notice that a source
		// file is newer than dist-electron and rebuild instead of serving the previous code.
		"--archive",
		"--compress",
		"--partial",
		...SYNC_EXCLUDES.flatMap((pattern) => ["--exclude", pattern]),
		"--rsh", rshCommand(host),
		`${source.replace(/\/+$/, "")}/`,
		`${destination}/`,
	];
}

/**
 * Write the files that make a Mac a runner. They exist as files rather than as remote commands
 * because their content is multi-line shell and XML — the one thing that must never be
 * interpolated into an argv sshd is about to flatten into a shell string.
 */
export function stageProvisioningFiles(dir: string, modelKey?: string): string[] {
	const files: [name: string, body: string, mode: number][] = [
		["runnerctl", RUNNERCTL_SHIM, 0o755],
		["yarn-runner-serve", SERVE_SHIM, 0o755],
		[`${LAUNCH_LABEL}.plist.in`, LAUNCH_PLIST, 0o644],
		["install-runnerctl.sh", INSTALL_RUNNERCTL, 0o755],
		["install-launchagent.sh", INSTALL_LAUNCHAGENT, 0o755],
	];

	// The key rides along as a FILE for the same reason the shims do, only more so. Anything in
	// an ssh argv is reassembled into a command line on the far side, where it is visible in
	// `ps` to every local account for as long as the command runs — a secret in an argv is a
	// secret published. Staged and rsync'd, it only ever exists as 0600 bytes on disk.
	//
	// 0600 here as well as on the far side: rsync --archive carries the mode across, and the
	// local staging dir sits in /tmp.
	if (modelKey) files.push(["env", `OPENROUTER_API_KEY='${checkModelKey(modelKey)}'\n`, 0o600]);

	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const [name, body, mode] of files) {
		const target = path.join(dir, name);
		fs.writeFileSync(target, body);
		// Explicit, because writeFileSync's mode applies only to a file it creates and rsync
		// --archive carries the bit across: a shim that arrives non-executable fails as
		// "Permission denied" from launchd, minutes later and on the far side.
		fs.chmodSync(target, mode);
	}

	return files.map(([name]) => name);
}

/**
 * Put node on PATH, for a shell that has no profile.
 *
 * Shared by both shims because they fail identically without it and had drifted into two
 * copies of the same literal. Neither `ssh host cmd` nor launchd runs a profile: both get
 * /etc/paths and nothing else, so the shim is found and then dies with "npx: not found".
 *
 * Homebrew's two prefixes are not enough, which is the part that had to be measured rather
 * than assumed. mac3 has no Homebrew node at all — node is nvm's, and **nvm is set up in
 * .zshrc**, an INTERACTIVE-only file. `zsh -lc 'command -v node'` finds nothing there while
 * `zsh -ic` finds it, so sourcing a login shell would not have rescued this either.
 *
 * So resolve nvm's layout directly instead of trying to run nvm: the default alias names the
 * version, and the glob is the fallback for a machine that never set one. Deliberately only
 * consulted when node is missing, so a Homebrew Mac behaves exactly as before. Doing it in the
 * shim rather than baking in a discovered path means a node upgrade does not need a
 * re-provision — the version directory is read at every invocation.
 */
const NODE_ON_PATH = `PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
	# The alias file holds a bare version ("20.16.0") but the directory is "v20.16.0", and some
	# setups write the "v" into the alias — so try both spellings before falling back to a glob.
	nvm_default=$(cat "$HOME/.nvm/alias/default" 2>/dev/null)
	for nvm_bin in \\
		"$HOME/.nvm/versions/node/v\${nvm_default#v}/bin" \\
		"$HOME/.nvm/versions/node"/*/bin
	do
		if [ -x "$nvm_bin/node" ]; then
			PATH="$nvm_bin:$PATH"
			break
		fi
	done
fi
export PATH`;

/**
 * `runnerctl` — the only thing SSH ever invokes on a Mac.
 */
const RUNNERCTL_SHIM = `#!/bin/sh
# Installed by src/remote/provision.ts. Edit there, not here — a re-provision overwrites this.
${NODE_ON_PATH}
# Exit 3 is runnerctl's own "cannot reach the runner": a missing checkout is a host problem,
# not an answer to the request, and the fleet client branches on the distinction.
cd "$HOME/${REMOTE_CHECKOUT}" || exit 3
exec npx tsx src/runner/ctl.ts "$@"
`;

/**
 * What launchd actually starts. `exec` at the end matters: launchd's KeepAlive watches the
 * process it spawned, and a shell that merely waited on Electron would be the thing being
 * kept alive while the runner underneath it had already died.
 */
const SERVE_SHIM = `#!/bin/sh
# Installed by src/remote/provision.ts. Edit there, not here — a re-provision overwrites this.
#
# This process must be Electron, not node: macOS attributes Accessibility and Screen Recording
# to the responsible process and children inherit them, so a runner that was a plain node
# daemon would hand every run an empty AX tree with no error to explain it.
${NODE_ON_PATH}
CHECKOUT="$HOME/${REMOTE_CHECKOUT}"
cd "$CHECKOUT" || exit 1
# paths.ts reads these instead of cwd, which launchd sets to /.
YARN_RUNNER_DATA="$CHECKOUT"
YARN_RUNNER_RESOURCES="$CHECKOUT"
export YARN_RUNNER_DATA YARN_RUNNER_RESOURCES

# Dependencies freshen the same way the build below does: rsync preserves mtimes, so a
# package manifest newer than npm's own install marker (rewritten by every install) means the
# sync brought a dependency change this node_modules predates. "[ -d node_modules ]" alone
# stranded every host provisioned before a new dependency landed — playwright-core was on
# disk in package.json and missing from node_modules on all three Macs (2026-07-31).
if [ ! -f node_modules/.package-lock.json ] ||
	[ package.json -nt node_modules/.package-lock.json ] ||
	[ package-lock.json -nt node_modules/.package-lock.json ]; then
	npm install --silent || exit 1
fi
# Same freshness test as ./run: rsync preserves mtimes, so a source file newer than the built
# entry point is exactly the signal that this host is about to serve the previous code.
if [ ! -f dist-electron/electron/main.js ] ||
	[ -n "$(find src electron -name '*.ts' -newer dist-electron/electron/main.js -print -quit 2>/dev/null)" ]; then
	npx tsc -p tsconfig.electron.json || exit 1
fi

# exec the Electron BINARY, not \`npx electron\`. Measured on mac3 during the first real
# provision: npx does not exec its child, it forks one, so launchd's direct child was
# \`npm exec electron\` with Electron two levels below it. Two consequences, both bad and
# neither visible from a status column:
#
#   - KeepAlive watches npm. Electron can die and npm stays up, so launchd never restarts it
#     — the exact failure the \`exec\` in this shim was written to prevent.
#   - TCC attributes Accessibility and Screen Recording to the RESPONSIBLE process, which is
#     the one launchd spawned. With npm in that slot the grant an operator gives to
#     Electron.app is not obviously the grant the run inherits.
#
# Both go away when launchd's child IS Electron.
ELECTRON="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ -x "$ELECTRON" ]; then
	exec "$ELECTRON" dist-electron/electron/main.js --serve
fi

# Unknown layout — still start, but say so: this is the degraded chain described above.
echo "warning: $ELECTRON not found, falling back to npx (launchd will be watching npm)" >&2
exec npx electron dist-electron/electron/main.js --serve
`;

/**
 * `__HOME__` is substituted on the far side. A plist has no variable expansion — every path in
 * it has to be absolute — and the remote home is the one value this side genuinely does not know.
 */
const LAUNCH_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCH_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>__HOME__/.local/bin/yarn-runner-serve</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<!-- Bounds a crash loop: without it a runner that dies on startup is respawned as fast as
	     launchd can fork, and the serve log becomes unreadable within a minute. -->
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<!-- Interactive, not Background: launchd caps the CPU and I/O of a Background job, and this
	     one drives a UI and encodes video. -->
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>WorkingDirectory</key>
	<string>__HOME__/${REMOTE_CHECKOUT}</string>
	<key>StandardOutPath</key>
	<string>__HOME__/.yarn-runner/serve.log</string>
	<key>StandardErrorPath</key>
	<string>__HOME__/.yarn-runner/serve.log</string>
	<key>EnvironmentVariables</key>
	<dict>
		<!-- launchd's PATH is /usr/bin:/bin:/usr/sbin:/sbin, which has neither node nor ffmpeg.
		     A starting point only: a plist has no variable expansion, so it cannot reach a
		     version manager's per-user directory. yarn-runner-serve re-derives PATH at launch
		     (NODE_ON_PATH) and that is what a run actually inherits. -->
		<key>PATH</key>
		<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>YARN_RUNNER_DATA</key>
		<string>__HOME__/${REMOTE_CHECKOUT}</string>
		<key>YARN_RUNNER_RESOURCES</key>
		<string>__HOME__/${REMOTE_CHECKOUT}</string>
	</dict>
</dict>
</plist>
`;

const INSTALL_RUNNERCTL = `#!/bin/sh
# Installed by src/remote/provision.ts. Puts runnerctl somewhere \`ssh host runnerctl\` finds it.
set -eu
SRC="$HOME/${REMOTE_CHECKOUT}/${STAGE_DIR}/runnerctl"

# /usr/local/bin first because it is in /etc/paths, and /etc/paths is the entire PATH a
# non-interactive \`ssh host cmd\` gets. ~/.local/bin is not there, so a shim installed only
# in the home directory is invisible to the fleet client no matter that it exists.
TARGET=""
if mkdir -p /usr/local/bin 2>/dev/null && [ -w /usr/local/bin ]; then TARGET=/usr/local/bin; fi

if [ -n "$TARGET" ]; then
	install -m 755 "$SRC" "$TARGET/runnerctl"
else
	TARGET="$HOME/.local/bin"
	mkdir -p "$TARGET"
	install -m 755 "$SRC" "$TARGET/runnerctl"
	# ~/.zshenv is the ONLY startup file a non-interactive zsh reads — .zprofile and .zshrc are
	# both skipped for \`ssh host cmd\` — so it is the one place this line has any effect.
	# Appended idempotently: this script re-runs on every provision.
	LINE='export PATH="$HOME/.local/bin:$PATH"'
	grep -qF "$LINE" "$HOME/.zshenv" 2>/dev/null || printf '%s\\n' "$LINE" >> "$HOME/.zshenv"
fi

echo "runnerctl=$TARGET/runnerctl"
`;

const INSTALL_LAUNCHAGENT = `#!/bin/sh
# Installed by src/remote/provision.ts. Loads the runner as a GUI-domain LaunchAgent.
set -eu
LABEL=${LAUNCH_LABEL}
PROV="$HOME/${REMOTE_CHECKOUT}/${STAGE_DIR}"
AGENTS="$HOME/Library/LaunchAgents"
PLIST="$AGENTS/$LABEL.plist"
U=$(id -u)

mkdir -p "$HOME/.local/bin" "$AGENTS" "$HOME/.yarn-runner"
# The runner dir is the access control for the socket inside it (see serve.ts); an existing
# one created by hand during setup is commonly 0755.
chmod 700 "$HOME/.yarn-runner"
install -m 755 "$PROV/yarn-runner-serve" "$HOME/.local/bin/yarn-runner-serve"

# The model key, if the provisioning side had one to send.
#
# KEPT, not overwritten, when the host already has one — matching applyModelKey() in team.ts. A
# host given a deliberate per-host key by hand must not silently lose it to whoever re-provisions
# next; the GUI credentials panel is the deliberate-overwrite path, and it says so.
#
# The staged copy is removed either way. It arrives at 0600, but .provision/ lives inside the
# synced checkout and the key's home is ~/.yarn-runner/env — one copy, one mode to reason about.
KEY=absent
if [ -f "$PROV/env" ]; then
	if grep -qE '^[[:space:]]*(export[[:space:]]+)?OPENROUTER_API_KEY[[:space:]]*=' "$HOME/.yarn-runner/env" 2>/dev/null; then
		KEY=kept
	else
		install -m 600 "$PROV/env" "$HOME/.yarn-runner/env"
		KEY=written
	fi
	rm -f "$PROV/env"
fi

sed "s|__HOME__|$HOME|g" "$PROV/$LABEL.plist.in" > "$PLIST"
chmod 644 "$PLIST"

# bootout first: bootstrap against a label that is already loaded fails with EALREADY, and the
# plist just written would never take effect — the host would keep serving the previous one.
launchctl bootout "gui/$U/$LABEL" 2>/dev/null || true

# ...and then WAIT for it. bootout is asynchronous: it returns before launchd has finished
# tearing the job down, and a bootstrap that lands in that window fails with EIO (5), not the
# EALREADY the bootout was guarding against. Measured on mac3 on the first re-provision of an
# already-running host — so it reproduces on exactly the path an operator takes most often and
# never on a first install.
n=0
while launchctl print "gui/$U/$LABEL" >/dev/null 2>&1 && [ $n -lt 50 ]; do
	sleep 0.2
	n=$((n + 1))
done

launchctl enable "gui/$U/$LABEL" 2>/dev/null || true

# gui/, never user/. A job in the user domain has no window server session: Screen Recording
# captures nothing and the AX tree comes back empty, both without an error.
#
# Retried because the wait above is a heuristic and launchd can still be settling.
n=0
until launchctl bootstrap "gui/$U" "$PLIST" 2>/dev/null; do
	n=$((n + 1))
	if [ $n -ge 10 ]; then
		# Out of retries: run it once more unsuppressed so the failure carries launchd's own
		# diagnosis rather than this script's guess at one.
		launchctl bootstrap "gui/$U" "$PLIST"
		break
	fi
	sleep 0.5
done
launchctl kickstart "gui/$U/$LABEL" 2>/dev/null || true

# One line, and it has to stay the first one: provisionHost reports firstLine(stdout) as this
# step's detail. modelKey rides on the same line rather than a second echo above, which would
# have quietly replaced the launchagent path in every provision summary.
echo "launchagent=$PLIST modelKey=$KEY"
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
 * resolving, and a provisioning pass must degrade the step and not unwind.
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
		detail: firstLine(result.stderr) || firstLine(result.stdout) || `exited ${result.code}`,
		stdout: result.stdout,
		code: result.code,
	};
}

/**
 * Poll until the socket answers. Separate from loading the agent because the two fail for
 * unrelated reasons and only one of them is usually the operator's problem: `bootstrap`
 * succeeding means launchd accepted the job, while the first start of that job installs
 * dependencies and compiles the shell.
 */
async function waitForRunner(host: HostEntry, run: SshRunner, timeoutMs: number, budgetMs: number): Promise<Attempt> {
	const deadline = Date.now() + budgetMs;
	let last: Attempt;
	for (;;) {
		last = await attempt(() => run(host, runnerArgv("status"), { timeoutMs }));
		if (last.ok) return { ok: true, detail: runnerState(last.stdout), stdout: last.stdout };
		if (Date.now() >= deadline) break;
		await sleep(READY_POLL_MS);
	}

	return {
		ok: false,
		detail: `the runner did not answer within ${Math.round(budgetMs / 1000)}s — first boot runs npm install and a tsc build, so re-check with --doctor before treating this as broken (${last.detail})`,
		stdout: "",
	};
}

function runnerState(stdout: string): string {
	try {
		const parsed = JSON.parse(firstJsonLine(stdout)) as { state?: unknown };

		return typeof parsed.state === "string" ? `runner is ${parsed.state}` : "runner answered";
	} catch {
		return "runner answered";
	}
}

/**
 * The first line that could be JSON. `npx tsx` on a cold checkout prints install notices ahead
 * of the payload, and those are not an error — treating them as one would fail a host that is
 * working.
 */
function firstJsonLine(stdout: string): string {
	return stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith("{")) ?? stdout;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const USAGE = `usage: tsx src/remote/provision.ts [--host <name>] [--doctor | --restart [--all]]

  (no flags)      provision every Mac in hosts.json: sync, runnerctl, LaunchAgent
  --host <name>   just that one (name, alias or address)
  --doctor        do not change anything; ask each host what it is missing
  --restart       bounce the runners whose TCC grants landed after they started
  --all           with --restart: bounce every host, not only the stale ones`;

/** `./run provision` and `./run provision --doctor` — the fleet as a table of what is wrong. */
async function main(): Promise<void> {
	const argv = process.argv.slice(2);

	const at = argv.indexOf("--host");
	const only = at >= 0 ? argv[at + 1] : undefined;
	if (at >= 0 && !only) {
		console.error(`--host needs a host name\n${USAGE}`);
		process.exit(2);
	}

	/**
	 * Every argument has to be accounted for, positionals included.
	 *
	 * The check used to be `a.startsWith("-")`, so a bare `./run provision mac3` — the spelling
	 * anyone reaches for first — dropped the word on the floor and provisioned the WHOLE FLEET.
	 * It happened here, on 2026-07-30. That is not a usage nit: provision rsyncs a checkout,
	 * rewrites a shim and restarts a LaunchAgent on each host, so silently widening a one-host
	 * command to three is a mutation nobody asked for, on machines that may be mid-demo.
	 * Erring out costs a retype; the silent version costs an explanation.
	 */
	const consumed = new Set(at >= 0 ? [at, at + 1] : []);
	const unknown = argv.find((a, i) => !consumed.has(i) && !["--doctor", "--restart", "--all"].includes(a));
	if (unknown) {
		const hint = unknown.startsWith("-") ? "" : ` (did you mean --host ${unknown}?)`;
		console.error(`unexpected argument ${JSON.stringify(unknown)}${hint}\n${USAGE}`);
		process.exit(2);
	}

	const all = loadHosts();
	const inv = only ? { schema: all.schema, hosts: [resolveHost(only, all)] } : all;

	if (argv.includes("--doctor")) {
		const rows = await doctorFleet(inv);
		for (const row of rows) {
			const state = row.reason ? "unknown" : row.problems.length ? `${row.problems.length} problem(s)` : "ready";
			console.log(`${row.host.padEnd(8)} ${state}${row.reason ? ` — ${row.reason}` : ""}`);
			for (const problem of row.problems) console.log(`  ✗ ${problem}`);
		}
		// Nonzero when any host is not demo-ready, so this can gate a script without parsing.
		if (rows.some((r) => r.reason || r.problems.length)) process.exitCode = 1;

		return;
	}

	if (argv.includes("--restart")) {
		const rows = await restartFleet(inv, { all: argv.includes("--all") });
		for (const row of rows) console.log(`${row.host.padEnd(8)} ${(row.restarted ? "restarting" : "skipped").padEnd(11)} ${row.detail}`);
		// Only a host that was ASKED and refused is a failure. "no stale grant" is the happy path
		// of this command and must not make a scripted `--restart` look broken.
		if (rows.some((r) => !r.restarted && !r.detail.startsWith("no stale grant"))) process.exitCode = 1;

		return;
	}

	console.log(`provisioning ${inv.hosts.length} host(s): ${inv.hosts.map((h) => h.name).join(", ")}`);
	const rows = await provisionFleet(inv);
	for (const row of rows) {
		// Every step, always — a pass that stopped at `sync` and one that stopped at `ready`
		// are the same word in a status column and completely different problems.
		console.log(`${row.host.padEnd(8)} ${(row.ok ? "ok" : "FAILED").padEnd(7)} ${row.steps.map((s) => `${s.step}${s.ok ? "" : " ✗"}`).join(" · ")}`);
		for (const step of row.steps) if (step.detail) console.log(`  ${step.step}: ${step.detail}`);
	}
	if (rows.some((r) => !r.ok)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	main().catch((err) => {
		console.error(`provision failed: ${err}`);
		process.exit(1);
	});
