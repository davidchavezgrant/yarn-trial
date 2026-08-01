import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { openApp } from "../../core/appctl.js";
import { ensureBrowserEndpoint, ensureElectronEndpoint } from "../../backends/electron-attach.js";
import { sidecarStatus } from "../../core/axdom.js";
import { screenIsLocked } from "../../core/harness/observation.js";
import { envNum } from "../../env.js";
import { dataRoot, outDir, resourcesRoot } from "../../paths.js";
import { type ChromePolicyState, inspectChromePolicy, MANDATORY_PLISTS } from "../chrome-policy.js";
import { firstLine } from "../control/ssh.js";
import { listApps } from "../../core/apps.js";
import {
	acquire,
	adopt,
	defaultRunnerDir,
	inspect,
	reclaimStale,
	release,
} from "./lease.js";
import {
	createJob,
	type JobKind,
	type JobRecord,
	jobsDir,
	listJobs,
	listQueued,
	logPath,
	mintJobId,
	pidAlive,
	readJob,
	readLog,
	sweepOrphans,
	updateJob,
} from "./jobs.js";
import {
	type AuthClear,
	clearOperatorData,
	describeAuthClear,
	describeSwap,
	type ProfileSwap,
	resolveBundleId,
	swapProfile,
} from "./profiles.js";
import { type AppDelete, deleteAppBundle, describeAppDelete } from "./uninstall.js";
import {
	childEnv,
	isPackaged,
	maskEnv,
	resolveRunCommand,
	type RunCommand,
	type Spawned,
	type SpawnOptions,
	spawnDetached,
	stopGroup,
} from "./spawn.js";

/**
 * The long-lived half of the runner: one Unix socket, one run at a time, on each Mac.
 *
 * Why a socket and not an HTTP port: the only client is `runnerctl`, invoked over SSH by a
 * user who already authenticated to the machine. A UDS inherits that — there is no second
 * authentication scheme to design, no token to distribute and rotate across the fleet, and
 * nothing listening on the network. macOS enforces filesystem permissions on socket connect,
 * so access control is `chmod`.
 *
 * Why it holds the socket at all rather than SSH invoking runs directly: TCC attributes
 * Accessibility and Screen Recording to the *responsible process*, and children inherit
 * them. A run spawned from an SSH session is responsible to sshd and gets nothing. This
 * process is the granted one, so every run must descend from it.
 *
 * `submit` returns as soon as the child exists. A grounding pass runs for tens of minutes
 * and an operator's laptop closing its lid must not be able to end it, so nothing about a
 * run's lifetime depends on the caller staying connected — the connection carries the
 * request and the job id, and everything after that is read back from the registry.
 */

const SOCKET_NAME = "run.sock";
/** How often to check whether a run we cannot get exit events for has ended. See `reap`. */
const REAP_MS = 5_000;
const FOLLOW_POLL_MS = 300;
/** Time between SIGINT and SIGKILL on `stop`. Long enough for the agent's finally to close the driver session. */
const STOP_GRACE_MS = 10_000;
/** Long enough for `restart`'s reply to reach the client before the process goes. */
const RESTART_DELAY_MS = 250;
/**
 * Ceiling on one readiness probe. Generous — the child pays a cua-driver session start before
 * it can observe anything — but bounded, because the app it is asking about is one a human is
 * mid-dialog with, and AX calls against those are exactly the ones that block forever.
 */
const READY_PROBE_MS = 45_000;
/**
 * Cap on one request line. A submit spec is a few KiB even with a long task; anything growing
 * past this without a newline is not a request, and an unbounded buffer would hand whatever
 * can write to the socket this process's memory.
 */
const MAX_REQUEST_BYTES = 1 << 20;

/**
 * Serialises every profile swap in this process. The lease serialises JOBS, but `signin`
 * deliberately checks the lease without taking it (see the note on `signin`), so nothing else
 * stops a signin racing a submit — or a second signin — into `swapProfile`, which awaits a
 * quit of the target app for many seconds mid-swap. Two interleaved swaps both read
 * owners.json before either writes it: the loser stashes nothing and writes a manifest with
 * `paths: []`, stranding the previous owner's profile in the store forever, and `move()`'s
 * rm-before-rename can delete the winner's just-restored live profile. One chain, no
 * reordering — a swap enters behind whatever swap is already in flight, failures included.
 */
let profileSwapChain: Promise<unknown> = Promise.resolve();

/**
 * Did the run declare its OWN failure, whatever its exit code said?
 *
 * An explore that throws still salvages its findings and exits 0, so the process looks clean
 * while the pass's own last lines say otherwise. Grading on exit code alone therefore files a
 * failed pass as `done` — which is how a 162-action run that quit the app it was exploring
 * came to sit in the fleet panel looking like a success next to a genuine one.
 *
 * Reads only the TAIL: these markers are written at the end, and a long explore log runs to
 * megabytes. Any read error means no verdict, so the exit code decides — a grading helper must
 * never be the thing that fails a healthy run.
 */
/**
 * The child's argv for one job — pure, so the flag plumbing is assertable.
 *
 * Extracted after a vision-only EXPLORE ran as an ordinary element-grounded pass: `noAx` was
 * recorded on the job, crossed the wire, and was then dropped here because only the TASK
 * branch spread the perception flags. Nothing failed — the arm reported `done`, with a map,
 * and only the map's `provenance` stamp revealed it had measured the wrong thing.
 *
 * Inline inside startJob this was unreachable from a test, which is why the omission survived.
 * A dropped flag is the worst kind of bug to leave untestable: it produces a plausible run.
 */
export function childRunArgs(kind: JobKind, rec: { url?: string; backend?: string; noVision?: boolean; noAx?: boolean; record?: boolean; noRescue?: boolean; recipe?: string }, app: string, task: string): string[] {
	// `--backend` rides both the task and the explore argv; every further rule about the
	// combination (e.g. --no-ax outside the ax backend) belongs to the child CLI, which
	// refuses invalid ones itself — a second copy of its validation here would drift.
	const backendArgs = rec.backend ? ["--backend", rec.backend] : [];
	// A web target's argv drops the app positional: both CLIs read `--url` as the target and
	// keep the label for display, and a stray positional would land in explore's guidance slot
	// — becoming a safety instruction nobody wrote.
	const urlArgs = rec.url ? ["--url", rec.url] : [];
	// Perception flags belong to BOTH kinds. This is the omission described above.
	const perception = [...(rec.noVision ? ["--no-vision"] : []), ...(rec.noAx ? ["--no-ax"] : [])];

	if (kind === "explore") return [...(rec.url ? [] : [app]), ...urlArgs, ...perception, ...backendArgs];
	// The recipe path was validated relative at submit time; the child resolves paths against
	// its cwd (the resources root), so hand it the data-root form.
	if (kind === "replay") return ["replay", path.join(dataRoot(), rec.recipe ?? ""), ...(rec.noRescue ? ["--no-rescue"] : []), ...(rec.url ? ["--url", rec.url] : [])];

	return [task, ...(rec.url ? [] : [app]), ...urlArgs, ...(rec.record ? ["--record"] : []), ...perception, ...backendArgs];
}

export function passErrored(file: string): boolean {
	try {
		const fd = fs.openSync(file, "r");
		try {
			const size = fs.fstatSync(fd).size;
			const span = Math.min(size, 8192);
			const buf = Buffer.alloc(span);
			fs.readSync(fd, buf, 0, span, size - span);

			return /^stopped: error|exploration threw|explore failed:/m.test(buf.toString("utf8"));
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return false;
	}
}

function withProfileLock<T>(fn: () => Promise<T>): Promise<T> {
	const r = profileSwapChain.then(fn, fn);
	profileSwapChain = r.then(() => undefined, () => undefined);

	return r;
}

/**
 * Why a relative path from the wire is refused, or undefined when it is safe to resolve
 * against the data root. The per-segment alphabet is SAFE_ID's (jobs.ts) — job ids are the
 * precedent for socket-supplied path material — with `/` allowed only as the separator, so
 * an absolute path (empty first segment), a `..` hop and a smuggled special character are
 * each named rather than collapsing into one opaque refusal.
 */
export function unsafeRelPath(p: string): string | undefined {
	const segments = p.split("/");
	for (const s of segments) {
		if (!s) return "empty path segment (absolute paths and doubled slashes are refused)";
		if (s === "." || s === "..") return "path traversal is refused";
		if (!/^[A-Za-z0-9._-]+$/.test(s)) return `segment ${JSON.stringify(s)} carries characters outside [A-Za-z0-9._-]`;
	}

	return undefined;
}

/** Fixed port for the liveview server, so the runner and the operator's `ssh -L` agree without a round trip. */
const LIVEVIEW_PORT = 7682;
/**
 * Hard ceiling on a liveview server's life. The runner spawns it DETACHED — nothing else reaps it
 * — so a sign-in walked away from must not leave a capture-capable, injectable server listening.
 * Generous: an SSO round trip with MFA on a phone is minutes, and this is the same 20-minute
 * budget `signin`'s `waitForHome` allows for exactly that.
 */
const LIVEVIEW_MAX_LIFETIME_MS = 20 * 60_000;
/** After the tab closes, exit unless it reopens within this. A closed tab is "done"; linger briefly. */
const LIVEVIEW_IDLE_AFTER_CLOSE_MS = 30_000;
/**
 * Frame rate of the login stream. 30 because a sign-in is typed: at 15 the caret and focus
 * ring step visibly and the whole view reads as laggy. Costs little — ScreenCaptureKit only
 * emits on actual window change, and the server drops frames under backpressure rather than
 * queueing them, so a slow tunnel loses the surplus instead of falling behind.
 */
const LIVEVIEW_FPS = 30;

/**
 * The debug port a liveview launch asks an Electron app for. 9222 to match the cdp backend's
 * own app-target default (cdp.ts), so a sign-in and a later agent run on this Mac find the
 * SAME endpoint instead of racing two instances of the app onto two ports.
 */
const CDP_APP_PORT = 9222;

/**
 * The debug port the OAuth browser gets — 9777, matching the cdp backend's own web-Chrome
 * default and the liveview engine's `browserEndpoint` default, so all three agree on where
 * the browser leg lives without anything being configured.
 */
const CDP_BROWSER_PORT = 9777;

/** The flagged Chrome's profile. Persistent and shared with the cdp backend's web runs: a
 *  human signing into a provider here leaves a session later runs inherit. */
function browserProfileDir(): string {
	return `${outDir()}/chrome-profile/${process.env.CDP_PROFILE ?? "yarn-runner"}`;
}


export interface Permissions {
	accessibility: boolean;
	screenRecording: boolean;
}

/**
 * Permissions that were absent when this process launched and are present now.
 *
 * A grant that lands mid-life is the one TCC state a running process cannot act on: macOS
 * hands a process its Screen Recording answer at launch and never revises it, so the database
 * says granted while the capture stays empty. Both directions of the comparison matter — a
 * permission that was true at boot is fine however it reads now (a revoked grant fails loudly
 * at the point of use), and one that is still false is an ordinary missing grant, already
 * reported as such. Only false → true is the invisible case.
 *
 * Returns names, not booleans, because the caller's job is to write them into a sentence.
 */
export function staleGrants(boot: Permissions | undefined, now: Permissions | undefined): string[] {
	if (!boot || !now) return [];

	return [
		!boot.accessibility && now.accessibility ? "Accessibility" : "",
		!boot.screenRecording && now.screenRecording ? "Screen Recording" : "",
	].filter(Boolean);
}

export type SpawnRun = (cmd: RunCommand, opts: SpawnOptions) => Spawned;

export interface ServeOptions {
	/**
	 * Injected by `electron/main.ts`, which is the only place `systemPreferences` may be
	 * touched. Absent in tests and under tsx, in which case `status` simply omits `tccOk` —
	 * the fleet client already treats a missing one as unknown rather than as a failure.
	 */
	permissions?: () => Permissions;
	/**
	 * Also injected by `electron/main.ts`, and separate from `permissions` because it is the
	 * only call in the process that shows the user a dialog. Absent under tsx and in tests,
	 * where `grant` reports that there is no Electron to ask on behalf of.
	 */
	requestPermissions?: () => Promise<Permissions>;
	/** Injected in tests so a submit can be exercised without a real agent seizing the machine. */
	spawn?: SpawnRun;
	/**
	 * Put the requesting operator's data into the target app before the run. Injected for the
	 * same reason as `spawn`: the real one quits applications and moves `~/Library` directories,
	 * which a test on a developer's machine must never do.
	 */
	swap?: (app: string, operator: string) => Promise<ProfileSwap>;
	/**
	 * How `restart` ends this process. Injected in tests for the obvious reason — the real one
	 * takes the test runner with it, so without this the only reachable branches are the refusals.
	 */
	exit?: () => void;
	/**
	 * Bring an app to the foreground. Injected for the same reason as `swap`: the real one shells
	 * out to `open -a`, which launches a real application on the developer machine running the
	 * suite. Used by `signin` and `liveview`.
	 */
	open?: (app: string, opts: { foreground?: boolean }) => Promise<void>;
	/**
	 * Bring up the app's CDP debug endpoint for a liveview screencast, launching it with
	 * `--remote-debugging-port` when nothing answers. Injected so the suite launches nothing.
	 */
	ensureEndpoint?: (app: string, preferredPort: number) => Promise<{ endpoint: string; port: number }>;
	/**
	 * Bring up the OAuth browser's debug endpoint, relaunching a flagless Chrome to do it.
	 * Injected so the suite neither launches nor QUITS a real browser.
	 */
	ensureBrowser?: (opts: { port: number; profileDir: string; prune?: boolean }) => Promise<{ endpoint: string; port: number; relaunched: boolean }>;
	/**
	 * Whether something is already listening on the liveview port. Injected so the "a login is
	 * already up" branch is testable without binding a real socket.
	 */
	portInUse?: (port: number) => Promise<boolean>;
	/**
	 * Kill whatever holds the liveview port and report whether it freed. Injected so the
	 * preemption branches are testable without real processes to signal.
	 */
	freeLiveviewPort?: () => Promise<boolean>;
	/**
	 * Sign an operator out of an app: quit it and delete their data. Injected for the same
	 * reason as `swap` — the real one quits applications and deletes `~/Library` directories,
	 * which a test on a developer's machine must never do.
	 */
	clearAuth?: (app: string, operator: string) => Promise<AuthClear>;
	/** Uninstall an app bundle plus its parked profiles. Injected: the real one rm -rf's under /Applications. */
	deleteApp?: (app: string) => Promise<AppDelete>;
	log?: (line: string) => void;
}

export interface RunnerHandle {
	socketPath: string;
	close(): Promise<void>;
}

export type RunnerResponse = { ok: true; [k: string]: unknown } | { ok: false; error: string; [k: string]: unknown };

type Params = Record<string, unknown>;

export async function startRunner(runnerDir = defaultRunnerDir(), opts: ServeOptions = {}): Promise<RunnerHandle> {
	const log = opts.log ?? ((line: string) => console.log(`[runner] ${line}`));
	const spawnRun = opts.spawn ?? spawnDetached;
	const root = jobsDir();

	/**
	 * The directory is the access control, not the socket. Node creates the socket file
	 * itself with the process umask (0755 in practice) and there is an unavoidable window
	 * between `listen` and any `chmod` we could apply — a race that a mode on the containing
	 * directory does not have, because it is in place before the socket exists. `mkdirSync`'s
	 * mode only applies to directories it creates, so an existing one is chmod'd explicitly:
	 * the common case is a runner dir created by hand at 0755 during setup.
	 */
	fs.mkdirSync(runnerDir, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(runnerDir, 0o700);
	} catch {
		// A dir owned by another user cannot be fixed from here; the connect will fail loudly.
	}

	const socketPath = path.join(runnerDir, SOCKET_NAME);

	// Startup reconciliation, in this order: the registry tells the truth about pids first,
	// then the lease is freed if its holder is among the dead. Both are logged — a host that
	// silently frees itself is unexplainable later.
	for (const job of sweepOrphans(root)) log(`orphaned ${job.id}: pid ${job.pid} is gone`);
	const stale = reclaimStale(runnerDir);
	if (stale) log(`reclaimed lease from dead pid ${stale.pid} (job ${stale.jobId})`);

	/**
	 * What TCC said the moment this process came up.
	 *
	 * macOS resolves Screen Recording for a process ONCE, at launch; a grant ticked afterwards
	 * changes the database but not this process's ability to capture. Every read after boot —
	 * including `getMediaAccessStatus`, which doctor reports — sees the database, so a stale
	 * runner looks perfectly healthy and its runs come back with an empty AX tree and zero
	 * frames. Comparing against this snapshot is what makes the difference visible. See
	 * `staleGrants`.
	 */
	const bootPermissions = opts.permissions?.();

	/** Children we can still get exit events for: those spawned since this runner started. */
	const children = new Map<string, Spawned>();
	/** Jobs stopped on request, so their exit reads as `stopped` rather than `failed`. */
	const stopping = new Set<string>();
	const sockets = new Set<net.Socket>();

	function finalise(id: string, state: JobRecord["state"], exitCode: number | null, signal?: string): void {
		// Ahead of the terminal-record check: a job another path already finalised still has to
		// drop its in-memory tracking here, or the `stopping` entry outlives the job it names.
		children.delete(id);
		stopping.delete(id);
		const rec = readJob(id, root);
		if (!rec || rec.state !== "running") return;
		updateJob(id, { state, exitCode, endedAt: new Date().toISOString(), ...(signal ? { signal } : {}) }, root);
		release(runnerDir, id);
		log(`job ${id} ${state}${exitCode === null ? "" : ` (exit ${exitCode})`}${signal ? ` (${signal})` : ""}`);
		// The host just freed; the queue's head is entitled to it before any new submit.
		void drain();
	}

	/**
	 * The late path. A detached run survives a runner restart, and the restarted runner is no
	 * longer its parent — no exit event will ever arrive, so its death has to be noticed by
	 * polling the pid the lease named. Without this a rebooted-then-crashed job leaves the
	 * host advertising itself as busy indefinitely.
	 */
	function reap(): void {
		const { stale: dead } = inspect(runnerDir);
		if (!dead) return;
		finalise(dead.jobId, "orphaned", null);
		// finalise is a no-op if the record was already terminal; the lease still has to go —
		// and with it gone, the queue's head is startable. finalise's own drain only fires on
		// the record-was-running path, so this one covers the already-terminal case.
		release(runnerDir, dead.jobId);
		log(`reaped ${dead.jobId}: holder pid ${dead.pid} exited unobserved`);
		void drain();
	}

	const reaper = setInterval(reap, REAP_MS);
	reaper.unref();

	function currentJobId(): string | undefined {
		return inspect(runnerDir).holder?.lease.jobId;
	}

	/**
	 * Read a boolean request field, refusing anything that merely looks like one.
	 *
	 * `Boolean(params.x)` was here and is wrong for a field arriving over a socket: the string
	 * `"false"` is truthy, so a client that stringified its flags — a shell wrapper, a curl, a
	 * second implementation of the protocol — would turn `noVision: "false"` into a run with
	 * vision switched OFF. That degrades the agent's perception silently and the run still
	 * reports success, which makes it a measurement problem and not just a wrong flag.
	 * `undefined` is the honest absent case and means false.
	 */
	function flag(params: Params, name: string): boolean | RunnerResponse {
		const v = params[name];
		if (v === undefined || typeof v === "boolean") return v ?? false;

		return { ok: false, error: `${name} must be a boolean, got ${JSON.stringify(v)}` };
	}

	/**
	 * Hand the target app to the requesting operator, so a demo is recorded against their own
	 * account rather than whoever signed in last. See `profiles.ts` for why the console account
	 * is shared and the separation has to happen here.
	 */
	const swapProfileFor =
		opts.swap ??
		(async (app: string, operator: string) => swapProfile({ app, operator, bundleId: await resolveBundleId(app) }));

	/** Foreground the app, injectable so the suite does not launch real applications. */
	const openAppFor = opts.open ?? openApp;

	/** Bring up the app's CDP endpoint, injectable for the same reason as `open`. */
	const ensureEndpointFor = opts.ensureEndpoint ?? ensureElectronEndpoint;

	/** Bring up the OAuth browser's CDP endpoint. Injectable — it can RELAUNCH Chrome. */
	const ensureBrowserFor = opts.ensureBrowser ?? ensureBrowserEndpoint;

	/** Sign an operator out, injectable so the suite deletes nothing real. */
	const clearAuthFor =
		opts.clearAuth ??
		(async (app: string, operator: string) => clearOperatorData({ app, operator, bundleId: await resolveBundleId(app) }));

	/** Uninstall an app, injectable for the same reason. */
	// Bundle id resolved HERE, not inside deleteAppBundle: LaunchServices needs the bundle to
	// still exist, and by the time the module wants the id it has already deleted it.
	const deleteAppFor = opts.deleteApp ?? (async (app: string) => deleteAppBundle({ app, bundleId: await resolveBundleId(app) }));

	/**
	 * Is the liveview port already taken? A connect that succeeds means a server is up; ECONNREFUSED
	 * means it is free. Injected for tests; the real one makes a one-shot loopback connect.
	 */
	const portInUse =
		opts.portInUse ??
		((port: number) =>
			new Promise<boolean>((resolve) => {
				const probe = net.connect({ host: "127.0.0.1", port });
				const done = (inUse: boolean) => {
					probe.destroy();
					resolve(inUse);
				};
				probe.setTimeout(1000);
				probe.once("connect", () => done(true));
				probe.once("timeout", () => done(false));
				probe.once("error", () => done(false));
			}));

	/** The engine this runner last spawned, so preemption can name it before reaching for lsof. */
	let liveviewPid: number | undefined;

	/**
	 * Kill whatever serves the liveview port and wait for it to actually free. The tracked pid
	 * covers the ordinary case; the lsof sweep covers an orphan from a previous runner
	 * incarnation, which the restart-heavy provision flow produces routinely — the port is a
	 * fixed constant of ours, so whatever answers on it is ours to end. Injected for tests.
	 */
	const freeLiveviewPort =
		opts.freeLiveviewPort ??
		(async (): Promise<boolean> => {
			const pids = new Set<number>();
			if (liveviewPid && pidAlive(liveviewPid)) pids.add(liveviewPid);
			liveviewPid = undefined;
			const swept = await new Promise<string>((resolve) =>
				execFile("lsof", ["-ti", `tcp:${LIVEVIEW_PORT}`], { timeout: 5000 }, (_err, stdout) => resolve(stdout ?? "")),
			);
			for (const lin of swept.split("\n")) {
				const pid = Number(lin.trim());
				if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
			}
			for (const pid of pids) {
				try {
					process.kill(pid, "SIGTERM");
				} catch {
					// Already gone, or not ours to signal — the port poll below is the verdict.
				}
			}
			for (let i = 0; i < 16; i++) {
				if (!(await portInUse(LIVEVIEW_PORT))) return true;
				await new Promise((r) => setTimeout(r, 250));
			}

			return false;
		});

	/**
	 * End the liveview engine on request — the "operator backed out" half of preemption. The
	 * GUI portal calls this the moment its window closes, so the port frees NOW rather than
	 * after the engine's own idle timeout (30s once a viewer connected, the full 20-minute
	 * lifetime if one never did). No lease interaction: stopping a login never conflicts
	 * with a run.
	 */
	async function liveviewStop(): Promise<RunnerResponse> {
		if (!(await portInUse(LIVEVIEW_PORT))) {
			liveviewPid = undefined;

			return { ok: true, stopped: false, note: "no liveview server was running" };
		}
		if (!(await freeLiveviewPort())) return { ok: false, error: `the liveview server on port ${LIVEVIEW_PORT} did not exit` };
		log("liveview: server stopped on request");

		return { ok: true, stopped: true };
	}

	/**
	 * Swap, spawn, adopt — the part of a submit that actually starts a run. Factored out of
	 * `submit` because the drain starts QUEUED jobs through the same door, and a second copy
	 * of the swap/spawn failure handling would be a copy that drifts.
	 *
	 * The caller must already hold the lease under `rec.id`, and the record must already say
	 * `running`; every failure path here marks the record failed and releases that lease.
	 *
	 * The swap happens HERE — at start time, not enqueue time — because between a job joining
	 * the queue and reaching the host's keyboard, any number of other operators' runs may have
	 * swapped the app's data. Only the swap that immediately precedes the spawn is the one the
	 * agent actually reads.
	 */
	async function startJob(rec: JobRecord): Promise<RunnerResponse> {
		const { id, kind, app, task, operator } = rec;
		let swap: ProfileSwap;
		try {
			swap = await withProfileLock(() => swapProfileFor(app, operator));
		} catch (e) {
			// Refuse rather than continue. A failed swap means the app may still hold the previous
			// operator's session, and a demo recorded against someone else's account is a worse
			// outcome than a dispatch that did not happen.
			updateJob(id, { state: "failed", exitCode: null, endedAt: new Date().toISOString() }, root);
			release(runnerDir, id);

			return { ok: false, error: `could not give ${operator} their own data in ${app}: ${(e as Error).message}`, jobId: id };
		}
		log(`job ${id}: ${describeSwap(swap)}`);

		const script = kind === "explore" ? "src/core/explore.ts" : kind === "replay" ? "src/core/recipe-cli.ts" : "src/core/agent.ts";
		const base = resolveRunCommand(script);
		const runArgs = childRunArgs(kind, rec, app, task);

		let spawned: Spawned;
		try {
			spawned = spawnRun(
				{ command: base.command, args: [...base.args, ...runArgs] },
				{
					logFile: logPath(id, root),
					// Arm variables layer on top of childEnv's output rather than inside it:
					// childEnv is the launchd-survival kit every child shares, and these are
					// per-job measurement inputs read straight off the persisted record.
					env: {
						...childEnv({ runnerDir, stamp: id }),
						...(rec.axdomOff ? { AXDOM: "0" } : {}),
						...(rec.noGrounding ? { NO_GROUNDING: "1" } : {}),
						...(rec.useRecipe ? { USE_RECIPE: "1" } : {}),
						...(rec.appmapVariant ? { APPMAP_VARIANT: rec.appmapVariant } : {}),
						...(rec.model ? { AGENT_MODEL: rec.model } : {}),
						...(rec.steps ? { AGENT_STEPS: String(rec.steps) } : {}),
						// Fleet posture: a dispatched cdp run owns the machine (the lease says so),
						// and the app it finds running portless was left by the previous job —
						// an ax arm, most often. Quit-and-relaunch beats failing every
						// cdp-after-ax arm in the queue; no operator is present to cmd+Q.
						BENCH_QUIT_PORTLESS: "1",
					},
					cwd: resourcesRoot(),
				},
			);
		} catch (e) {
			// A failed spawn must not strand the host. This is the one path where the lease is
			// released without a child ever having existed.
			updateJob(id, { state: "failed", exitCode: null, endedAt: new Date().toISOString() }, root);
			release(runnerDir, id);

			return { ok: false, error: `spawn failed: ${(e as Error).message}`, jobId: id };
		}

		updateJob(id, { pid: spawned.pid }, root);
		adopt(id, spawned.pid, runnerDir);
		children.set(id, spawned);
		spawned.child.on("exit", (code, signal) => {
			// Only a stop that was ASKED for reads as "stopped". A SIGSEGV or an OOM kill also
			// arrives as a signal, and filing those under an operator stop hides the crash; an
			// unrequested signal is a failure, with the signal's name kept in the record.
			const stopped = stopping.has(id);
			// Exit code grades the PROCESS; the pass grades ITSELF. They disagree whenever a run
			// fails and then cleans up successfully — an explore that threw still salvages its
			// findings and exits 0, so the job read `done` while its own last line read
			// `stopped: error`. Two people misread that as a completed pass on 2026-07-31, and a
			// GUI showing it green is worse than useless.
			const clean = code === 0 && !passErrored(logPath(id, root));
			finalise(id, stopped ? "stopped" : clean ? "done" : "failed", code, signal ?? undefined);
		});
		log(`job ${id} started: ${kind} ${app} (pid ${spawned.pid}, operator ${operator})`);

		// `signinNeeded` is a prediction, not a verdict: the operator has no stored profile for this
		// app, so it comes up factory-fresh and the readiness check will almost certainly refuse.
		// Saying so now saves them watching a run fail to find out.
		return {
			ok: true,
			jobId: id,
			pid: spawned.pid,
			kind,
			app,
			artifacts: rec.artifacts,
			profile: describeSwap(swap),
			...(swap.fresh ? { signinNeeded: true } : {}),
		};
	}

	/**
	 * Start the queue's head if the host is free. Called wherever the lease can have just
	 * freed — finalise, reap, startup — and safe to call anywhere else: an acquire against a
	 * held lease refuses, and the drain simply stands down until the next finalise.
	 *
	 * `draining`/`redrain` exist because a drain is async (the profile swap awaits an app
	 * quitting) and a job can end WHILE one is in flight — its finalise's drain call would
	 * find the flag up and return, and with nothing scheduled after it the queue would stall
	 * with a free host. A suppressed call instead marks `redrain`, and the running drain
	 * loops once more before putting the flag down.
	 */
	let draining = false;
	let redrain = false;
	async function drain(): Promise<void> {
		if (draining) {
			redrain = true;

			return;
		}
		draining = true;
		try {
			do {
				redrain = false;
				for (;;) {
					const next = listQueued(root)[0];
					if (!next) break;

					const claim = acquire(
						{ jobId: next.id, operator: next.operator, kind: next.kind, app: next.app, startedAt: new Date().toISOString(), pid: process.pid },
						runnerDir,
					);
					// Busy again — a submit won the host back. Its finalise drains; stand down.
					if (!claim.ok) break;
					if (claim.reclaimed) log(`reclaimed lease from dead pid ${claim.reclaimed.pid} (job ${claim.reclaimed.jobId})`);

					// `startedAt` is reset to NOW so elapsed time measures the run, not the wait;
					// `queuedAt` keeps the wait auditable. A record that vanished mid-drain (hand
					// deleted, disk gone) frees the claim and moves on.
					const rec = updateJob(next.id, { state: "running", startedAt: new Date().toISOString() }, root);
					if (!rec) {
						release(runnerDir, next.id);
						continue;
					}
					log(`job ${next.id} dequeued: ${rec.kind} ${rec.app} (operator ${rec.operator}, ${listQueued(root).length} still queued)`);

					const res = await startJob(rec);
					// Started: the host is busy and its finalise owns the next drain.
					if (res.ok) break;
					// A queued job that cannot start must not wedge the ones behind it: startJob
					// already marked it failed and released, so the loop offers the host to the next.
					log(`queued job ${next.id} failed to start: ${"error" in res ? res.error : "unknown"}`);
				}
			} while (redrain);
		} finally {
			draining = false;
		}
	}

	async function submit(params: Params): Promise<RunnerResponse> {
		if (params.kind !== undefined && params.kind !== "explore" && params.kind !== "task" && params.kind !== "replay")
			return { ok: false, error: `kind must be "task", "explore" or "replay", got ${JSON.stringify(params.kind)}` };
		const kind: JobKind = params.kind === "explore" || params.kind === "replay" ? params.kind : "task";
		const app = String(params.app ?? "").trim();
		// Verbatim, start to finish. `auditTaskPrompt` in agent.ts is the authoritative gate
		// and refuses a hinted prompt there (exit 2, visible in the job log); rewriting or
		// pre-screening the text here would put a second, divergent copy of that rule on the
		// wire — and the whole value of the gate is that there is exactly one.
		const task = typeof params.task === "string" ? params.task : "";
		const operator = String(params.operator ?? "unknown").trim() || "unknown";
		if (!app) return { ok: false, error: "app is required" };
		if (kind === "task" && !task.trim()) return { ok: false, error: "task is required" };

		// Before acquire(), not after: every return past this point has to release the lease, and
		// a validation branch that forgets to leaves the Mac permanently busy with no run on it.
		const record = flag(params, "record");
		const noVision = flag(params, "noVision");
		const noAx = flag(params, "noAx");
		const axdomOff = flag(params, "axdomOff");
		const noGrounding = flag(params, "noGrounding");
		const useRecipe = flag(params, "useRecipe");
		const noRescue = flag(params, "noRescue");
		const queue = flag(params, "queue");
		if (typeof record !== "boolean") return record;
		if (typeof noVision !== "boolean") return noVision;
		if (typeof noAx !== "boolean") return noAx;
		if (typeof axdomOff !== "boolean") return axdomOff;
		if (typeof noGrounding !== "boolean") return noGrounding;
		if (typeof useRecipe !== "boolean") return useRecipe;
		if (typeof noRescue !== "boolean") return noRescue;
		if (typeof queue !== "boolean") return queue;

		// Fixed vocabulary, like `kind`: anything else in this field is a client trying to put
		// text on the child's argv, and the child CLI's own usage error would only be visible in
		// the job log after the lease was already spent.
		if (params.backend !== undefined && params.backend !== "ax" && params.backend !== "cdp")
			return { ok: false, error: `backend must be "ax" or "cdp", got ${JSON.stringify(params.backend)}` };
		const backend = params.backend as "ax" | "cdp" | undefined;

		// Same fixed-vocabulary rule for the appmap variant — it becomes an env value, and the
		// only variant that exists is the vision map. A typo'd variant would silently ground the
		// run from the ELEMENT map while the manifest recorded a vision arm.
		// Both grounding tiers an explore pass can write. The allowlist stays an allowlist —
		// this value becomes an env var on the child, so an unbounded string here is an
		// injection lane — but it was too narrow: "novision" was rejected, and the caller
		// dropped it before it ever got here, so two arms read the wrong map in silence.
		if (params.appmapVariant !== undefined && params.appmapVariant !== "vision" && params.appmapVariant !== "novision")
			return { ok: false, error: `appmapVariant must be "vision" or "novision", got ${JSON.stringify(params.appmapVariant)}` };
		const appmapVariant = params.appmapVariant as "vision" | undefined;

		// A model id becomes an env VALUE, never argv — but it still gets a shape check, so a
		// typo'd or hostile id is refused before the lease is spent rather than dying in the
		// child's first model call. Provider-prefixed ids ("openai/gpt-5.6-sol:nitro") and
		// bare ones ("claude-fable-5") both fit.
		if (params.model !== undefined && (typeof params.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._\/:-]{0,127}$/.test(params.model)))
			return { ok: false, error: `model must be a model id, got ${JSON.stringify(params.model)}` };
		const model = params.model as string | undefined;
		// A step budget crosses as a number and becomes an env VALUE (AGENT_STEPS); bounded
		// so a typo cannot ask a fleet Mac for a thousand-step run.
		if (params.steps !== undefined && (typeof params.steps !== "number" || !Number.isInteger(params.steps) || params.steps < 1 || params.steps > 100))
			return { ok: false, error: `steps must be an integer 1..100, got ${JSON.stringify(params.steps)}` };
		const steps = params.steps as number | undefined;

		// The URL is child argv, but it is not free text: the child's own webTarget() gate
		// rejects non-http(s) later, and this earlier copy exists because by then the lease
		// and a profile swap are already spent. Scheme-only — everything else is the child's.
		if (params.url !== undefined && (typeof params.url !== "string" || !/^https?:\/\//.test(params.url)))
			return { ok: false, error: `url must be an http(s) URL, got ${JSON.stringify(params.url)}` };
		const url = params.url as string | undefined;

		// A replay names its recipe as a data-root-relative path — the same key the file has on
		// every machine. Checked for path discipline AND presence here: a missing recipe would
		// otherwise cost the operator a lease, a profile swap and a child that dies on its first
		// read, with the reason buried in the job log.
		let recipe: string | undefined;
		if (kind === "replay") {
			if (typeof params.recipe !== "string" || !params.recipe)
				return { ok: false, error: "a replay needs a recipe path (relative to the data root)" };
			recipe = params.recipe;
			const bad = unsafeRelPath(recipe);
			if (bad) return { ok: false, error: `unsafe recipe path ${JSON.stringify(recipe)}: ${bad}` };
			if (!fs.existsSync(path.join(dataRoot(), recipe)))
				return { ok: false, error: `no recipe at ${recipe} on this Mac — sync recipes before dispatching a replay` };
		}

		const id = mintJobId(kind, app);
		// One init for both the queued and the immediate path: a queued job spawns later —
		// possibly under a restarted runner — so the record is the only carrier of the options,
		// and two literals here would be two lists to keep identical.
		const init = {
			id,
			kind,
			app,
			task,
			operator,
			record,
			noVision,
			noAx,
			axdomOff,
			noGrounding,
			useRecipe,
			noRescue,
			...(backend !== undefined ? { backend } : {}),
			...(recipe !== undefined ? { recipe } : {}),
			...(url !== undefined ? { url } : {}),
			...(appmapVariant !== undefined ? { appmapVariant } : {}),
			...(model !== undefined ? { model } : {}),
			...(steps !== undefined ? { steps } : {}),
		};
		const claim = acquire(
			{ jobId: id, operator, kind, app, startedAt: new Date().toISOString(), pid: process.pid },
			runnerDir,
		);
		if (!claim.ok) {
			// The lease is a mutex over the DRIVER and stays one; the registry can hold any
			// number of queued records. `queue: false` keeps the refusal, because it is the
			// answer `--host auto`'s race depends on: a dispatcher walking idle hosts needs
			// "someone beat you to it" to mean "ask the next Mac", not "joined a line here".
			if (!queue)
				return {
					ok: false,
					error: claim.reason,
					busy: true,
					operator: claim.holder.lease.operator,
					app: claim.holder.lease.app,
					kind: claim.holder.lease.kind,
					jobId: claim.holder.lease.jobId,
					elapsedSec: claim.holder.heldSec,
				};

			const job = createJob({ ...init, queued: true }, root);
			// 1-based place in the drain order. Ids are minted here, monotonic within this
			// process, and the drain serves oldest-first — so the index is the wait.
			const position = listQueued(root).findIndex((q) => q.id === id) + 1;
			log(`job ${id} queued: ${kind} ${app} (operator ${operator}, position ${position} behind ${claim.holder.lease.jobId})`);

			return {
				ok: true,
				jobId: id,
				queued: true,
				position,
				kind,
				app,
				artifacts: job.artifacts,
				behind: {
					operator: claim.holder.lease.operator,
					app: claim.holder.lease.app,
					kind: claim.holder.lease.kind,
					jobId: claim.holder.lease.jobId,
					elapsedSec: claim.holder.heldSec,
				},
			};
		}
		if (claim.reclaimed) log(`reclaimed lease from dead pid ${claim.reclaimed.pid} (job ${claim.reclaimed.jobId})`);

		// The registry write itself can fail — ENOSPC, EACCES — and handle()'s generic catch
		// knows nothing about the lease. Left held it names pid=<this runner>, which is always
		// alive, so reap() never reclaims it and the host stays busy until a runner restart.
		let job: JobRecord;
		try {
			job = createJob(init, root);
		} catch (e) {
			release(runnerDir, id);
			throw e;
		}

		return startJob(job);
	}

	/**
	 * Put an app in front of whoever is about to connect over screen sharing, under the right
	 * operator's data.
	 *
	 * The profile swap is the reason this is a runner verb instead of an `ssh … open -a`. Every
	 * operator shares one console account (see profiles.ts), so the app's on-disk session belongs
	 * to whoever ran last. Sign in over the top of that and the credential lands in someone
	 * else's profile — and then the first job this operator submits swaps that data out from
	 * under them, parking their fresh sign-in under the previous owner's name and leaving that
	 * person signed in as this one. Swapping first makes the sign-in land where it will be found.
	 *
	 * Foreground, unlike every other launch on this machine: see `openApp`.
	 *
	 * **The lease is checked and not taken.** Checked, because foregrounding an app on a Mac
	 * that is mid-recording ruins the take. Not taken, because the holder would be this process
	 * — always alive, so never reclaimed as stale — and an operator who wandered off after
	 * connecting would remove the Mac from the fleet until someone noticed. The residual race is
	 * a dispatch arriving mid-sign-in, which swaps the profile again; it is narrow, an operator
	 * is present for all of it, and it is a better failure than a host that never comes back.
	 */
	async function signin(params: Params): Promise<RunnerResponse> {
		const app = String(params.app ?? "").trim();
		const operator = String(params.operator ?? "unknown").trim() || "unknown";
		if (!app) return { ok: false, error: "app is required" };

		const { holder } = inspect(runnerDir);
		if (holder)
			return {
				ok: false,
				error: `${holder.lease.operator} is running ${holder.lease.app} here (${holder.heldSec}s) — bringing an app forward would land in their recording`,
				busy: true,
				operator: holder.lease.operator,
				app: holder.lease.app,
				kind: holder.lease.kind,
				jobId: holder.lease.jobId,
				elapsedSec: holder.heldSec,
			};

		// Behind the swap lock like submit's, and for a sharper reason here: this path holds no
		// lease at all, so without the lock a signin racing a submit (or another signin) would
		// interleave two sets of directory moves — see the note on `withProfileLock`.
		let swap: ProfileSwap;
		try {
			swap = await withProfileLock(() => swapProfileFor(app, operator));
		} catch (e) {
			// Refuse. Signing in on top of the wrong profile is the exact outcome this verb exists
			// to prevent, so a swap that did not happen must not be followed by a launch.
			return { ok: false, error: `could not give ${operator} their own data in ${app}: ${(e as Error).message}` };
		}
		log(`signin: ${describeSwap(swap)}`);

		try {
			await openAppFor(app, { foreground: true });
		} catch (e) {
			return { ok: false, error: `could not open ${JSON.stringify(app)}: ${(e as Error).message}`, profile: describeSwap(swap) };
		}
		log(`signin: ${app} foregrounded for ${operator}`);

		return { ok: true, app, operator, profile: describeSwap(swap), fresh: swap.fresh };
	}

	/**
	 * Bring up a window-scoped live-view sign-in: the same as `signin`, but instead of opening
	 * full-desktop Screen Sharing, it starts the liveview server (native/liveview capture + input)
	 * so a teammate drives ONLY the window being signed into, from their own browser over the SSH
	 * tunnel `runnerctl` is already inside.
	 *
	 * WHY THIS IS A RUNNER VERB and not `ssh … ./run liveview` (measured on mac1, 2026-07-30): a
	 * liveview engine spawned from a bare SSH shell is DENIED screen capture — macOS attributes the
	 * Screen Recording and Accessibility grants to the responsible process, and an ssh child is not
	 * it. This process (the Electron runner) holds those grants, and a child it spawns inherits them
	 * by identity — exactly how the agent's window screenshots and the `axdom` sidecar already work.
	 * So the server has to be launched from here.
	 *
	 * Like `signin`: the lease is CHECKED and not TAKEN (a login is not a run, and taking the lease
	 * would strand the host if the operator wandered off), and the profile is swapped to the
	 * requesting operator BEFORE anything is shown, so the sign-in lands in the data that will still
	 * hold it next week.
	 *
	 * The server is spawned DETACHED with a runner-minted token and two self-termination deadlines
	 * (max-lifetime + idle-after-close), so a walked-away sign-in cannot leave a capture-capable
	 * server listening. We return the token and port; the operator's tunnel maps localhost:PORT to
	 * the same port here, so the URL they open is `http://127.0.0.1:PORT/?t=<token>`.
	 */
	async function liveview(params: Params): Promise<RunnerResponse> {
		const app = String(params.app ?? "").trim();
		const operator = String(params.operator ?? "unknown").trim() || "unknown";
		if (!app) return { ok: false, error: "app is required" };
		// Which engine streams the sign-in: auto (the CLI probes the CDP endpoint and falls back
		// to window capture), or a forced cdp/sck from the operator's flag. Validated here so a
		// typo comes back as a refusal instead of an env var the CLI rejects after the swap.
		const transport = String(params.transport ?? "auto").trim() || "auto";
		if (transport !== "auto" && transport !== "cdp" && transport !== "sck")
			return { ok: false, error: `unknown liveview transport ${JSON.stringify(transport)} — expected auto, cdp or sck` };
		const cdpUrl = typeof params.endpoint === "string" && params.endpoint.trim() ? params.endpoint.trim() : undefined;

		const { holder } = inspect(runnerDir);
		if (holder)
			return {
				ok: false,
				error: `${holder.lease.operator} is running ${holder.lease.app} here (${holder.heldSec}s) — a login stream would capture over their recording`,
				busy: true,
				operator: holder.lease.operator,
				app: holder.lease.app,
				kind: holder.lease.kind,
				jobId: holder.lease.jobId,
				elapsedSec: holder.heldSec,
			};

		// Last request wins. The port being held means an earlier sign-in's engine is still up —
		// walked away from, or superseded by this very request ("run it again"). The operator
		// asking NOW is the one at a keyboard, and the old server is a capture-capable process
		// nobody is watching; refusing (the old behavior) stranded the port for up to the
		// 20-minute lifetime with no way to start over. Preempted BEFORE the swap, so the kill
		// can never land after the app has been handed to the new operator.
		if (await portInUse(LIVEVIEW_PORT)) {
			log(`liveview: preempting the server holding port ${LIVEVIEW_PORT}`);
			if (!(await freeLiveviewPort()))
				return { ok: false, error: `could not free the liveview port ${LIVEVIEW_PORT} — the old server did not exit` };
		}

		// Under the profile lock like every other swap call site: liveview, like signin, checks
		// the lease without taking it, so the lock is the only thing keeping a concurrent
		// submit/signin from interleaving two sets of directory moves — see withProfileLock.
		let swap: ProfileSwap;
		try {
			swap = await withProfileLock(() => swapProfileFor(app, operator));
		} catch (e) {
			return { ok: false, error: `could not give ${operator} their own data in ${app}: ${(e as Error).message}` };
		}
		log(`liveview: ${describeSwap(swap)}`);

		// Foreground the app so it is the frontmost window the engine will follow when the operator
		// connects. Same rationale as signin's openApp.
		//
		// Unless CDP is in play: the screencast engine needs a debug port, and only a LAUNCH can
		// put that flag on the command line. `open -a` alone leaves nothing listening, so the
		// CLI's auto-probe would find a dead endpoint and silently pick SCK — a fleet that never
		// takes the CDP path however it is configured. `ensureElectronEndpoint` probes first and
		// launches with the flag only if nothing answers; it never touches an instance it did not
		// launch (a running app may hold unsaved work, and a port cannot be injected into a live
		// process). A failure here is NOT fatal: fall through to the plain open and let the
		// engine's own probe decide, which is exactly the SCK fallback the auto default promises.
		// An operator who named an endpoint means THAT endpoint — they may be pointing the
		// stream at something this Mac did not launch — so a named one is never overridden.
		let endpoint = cdpUrl;
		if (transport !== "sck" && !endpoint) {
			try {
				endpoint = (await ensureEndpointFor(app, CDP_APP_PORT)).endpoint;
				log(`liveview: ${app} listening for CDP on ${endpoint}`);
			} catch (e) {
				log(`liveview: no CDP endpoint for ${app} (${(e as Error).message}) — the engine will fall back to window capture`);
			}

			// And the browser the OAuth leg will land in. Measured on mac3, 2026-07-31: Yarn's
			// "Continue with Google" hands off through the MAIN process to macOS, which opens the
			// URL in whichever Chrome is already running — a desktop-session Chrome with no flags,
			// which no screencast can attach to. Bringing up a flagged one (and making it the
			// running instance) is what gives the engine's browser leg something to hop to.
			// Non-fatal for the same reason as above: without it the OAuth page is simply unseen,
			// which is the state we were already in.
			try {
				// prune: this is a fleet Mac the runner owns — every Chrome that is not the
				// flagged one is a hazard here (a stray portless instance swallows the OAuth
				// handoff; orphaned test browsers wedge and hoard memory). Never set on an
				// operator's own machine.
				const browser = await ensureBrowserFor({ port: CDP_BROWSER_PORT, profileDir: browserProfileDir(), prune: true });
				log(`liveview: Chrome listening for CDP on ${browser.endpoint}${browser.relaunched ? " (relaunched — it was running without the flag)" : ""}`);
			} catch (e) {
				log(`liveview: no CDP endpoint for Chrome (${(e as Error).message}) — an external OAuth leg will not be visible`);
			}
		}

		try {
			await openAppFor(app, { foreground: true });
		} catch (e) {
			return { ok: false, error: `could not open ${JSON.stringify(app)}: ${(e as Error).message}`, profile: describeSwap(swap) };
		}

		const token = randomBytes(18).toString("base64url");
		const cmd = resolveRunCommand("src/remote/liveview-cli.ts");
		try {
			liveviewPid = spawnRun(
				{ command: cmd.command, args: [...cmd.args] },
				{
					logFile: logPath(`liveview-${operator}`, root),
					cwd: resourcesRoot(),
					env: {
						...childEnv({ runnerDir, stamp: "liveview" }),
						PORT: String(LIVEVIEW_PORT),
						LIVEVIEW_TOKEN: token,
						LIVEVIEW_MAX_LIFETIME_MS: String(LIVEVIEW_MAX_LIFETIME_MS),
						LIVEVIEW_IDLE_AFTER_CLOSE_MS: String(LIVEVIEW_IDLE_AFTER_CLOSE_MS),
						// Names the sign-in target for the engine's constrained-browser mode: the
						// external OAuth browser gets cropped to its page content, Cmd-shortcuts
						// to its chrome are dropped, and "Open <App>" is pressed hands-free.
						LIVEVIEW_APP: app,
						// Frame rate for the login stream. Named here rather than left to the
						// engine's default so it is tunable per fleet without a rebuild.
						LIVEVIEW_FPS: String(LIVEVIEW_FPS),
						// The transport rides only when the operator forced one; absent, the
						// CLI's own auto-probe (or this host's runner.env, which childEnv layers
						// in) decides — the same flag > env > auto precedence as a local run.
						...(transport !== "auto" ? { LIVEVIEW_TRANSPORT: transport } : {}),
						// The endpoint the launch above actually opened, not just the one the
						// operator named — an auto run has no `--cdp <url>` to carry, and pointing
						// the probe at the port we just brought up beats re-deriving it.
						...(endpoint ? { LIVEVIEW_CDP_URL: endpoint } : {}),
					},
				},
			).pid;
		} catch (e) {
			return { ok: false, error: `could not start the liveview server: ${(e as Error).message}`, profile: describeSwap(swap) };
		}
		log(`liveview: server started for ${operator} on ${app} (port ${LIVEVIEW_PORT})`);

		return {
			ok: true,
			app,
			operator,
			profile: describeSwap(swap),
			fresh: swap.fresh,
			port: LIVEVIEW_PORT,
			token,
			url: `http://127.0.0.1:${LIVEVIEW_PORT}/?t=${token}`,
			maxLifetimeSec: LIVEVIEW_MAX_LIFETIME_MS / 1000,
			// As REQUESTED — auto resolves inside the spawned CLI (the probe runs there), and
			// plumbing the resolved choice back would mean waiting on a detached child. The
			// server's own job log records which engine actually ran.
			transport,
			...(cdpUrl ? { endpoint: cdpUrl } : {}),
		};
	}

	/**
	 * Bring up the web-Chrome debug endpoint for a dash peek — the browser leg only.
	 *
	 * Exists because a peek is deliberately runner-less (the dash tunnels straight to the debug
	 * ports), so it inherits whatever endpoint state the last run or liveview left behind. The
	 * one state nothing else repairs is a flagless Chrome: an OAuth handoff or a human's Dock
	 * click launches one, LaunchServices keeps delivering to it, and no later flagged launch can
	 * open the port — the singleton swallows the argv and exits. mac1 sat in exactly that state
	 * (flagless since a 17:45 launch, 22 days unrebooted) while its peek waited forever,
	 * 2026-08-01. Only liveview called ensureBrowser until now, so a fleet Mac that never hosted
	 * a sign-in had no repair path.
	 *
	 * The app leg (:9222) is deliberately not touched: it self-heals on the next job (the
	 * profile swap quits the app, electron-attach relaunches it flagged), and this verb cannot
	 * know which app a view-only stream will want — launching one on spec would be wrong.
	 *
	 * Busy is not an error: a running job owns this machine's endpoints, and pruning could kill
	 * the run's own browser. Report, touch nothing; the run's endpoints are the peek's feed.
	 */
	async function peekPrep(): Promise<RunnerResponse> {
		const { holder } = inspect(runnerDir);
		if (holder) return { ok: true, touched: false, busy: true, app: holder.lease.app, operator: holder.lease.operator };

		const browser = await ensureBrowserFor({ port: CDP_BROWSER_PORT, profileDir: browserProfileDir(), prune: true });
		log(`peek-prep: Chrome listening for CDP on ${browser.endpoint}${browser.relaunched ? " (relaunched — it was running without the flag)" : ""}`);

		return { ok: true, touched: true, endpoint: browser.endpoint, port: browser.port, relaunched: browser.relaunched };
	}

	/**
	 * Sign an app out for one operator on this Mac: quit it and delete THEIR data — the live
	 * copy only if owners.json says they own it, plus their parked profile. Another operator's
	 * live session is never touched; `clearOperatorData` documents the split.
	 *
	 * Refused outright while a run holds the lease (same busy shape as `signin`): the target
	 * app may be the one being driven, and quitting it — or deleting the profile a swap is
	 * about to restore — corrupts the run. Under the profile lock like every other call that
	 * moves app data, because a clear racing a submit's swap would interleave a delete with a
	 * set of directory moves over the same paths.
	 */
	async function authClear(params: Params): Promise<RunnerResponse> {
		const app = String(params.app ?? "").trim();
		const operator = String(params.operator ?? "").trim();
		if (!app) return { ok: false, error: "app is required" };
		if (!operator) return { ok: false, error: "operator is required" };

		const { holder } = inspect(runnerDir);
		if (holder)
			return {
				ok: false,
				error: `${holder.lease.operator} is running ${holder.lease.app} here (${holder.heldSec}s) — signing out would pull app data out from under their run`,
				busy: true,
				operator: holder.lease.operator,
				app: holder.lease.app,
				kind: holder.lease.kind,
				jobId: holder.lease.jobId,
				elapsedSec: holder.heldSec,
			};

		let cleared: AuthClear;
		try {
			cleared = await withProfileLock(() => clearAuthFor(app, operator));
		} catch (e) {
			return { ok: false, error: `could not sign ${operator} out of ${app}: ${(e as Error).message}` };
		}
		log(describeAuthClear(cleared));

		// The reply names exactly what went, path by path: `removedLive` is home-relative,
		// `removedProfile` is store-relative. A delete that reports only "ok" is one nobody can
		// audit after the fact.
		return {
			ok: true,
			app,
			operator: cleared.operator,
			removedLive: cleared.removedLive,
			ownershipCleared: cleared.ownershipCleared,
			...(cleared.removedProfile ? { removedProfile: cleared.removedProfile } : {}),
			...(cleared.liveOwner ? { liveOwner: cleared.liveOwner } : {}),
		};
	}

	/**
	 * Uninstall an app from this Mac: the bundle out of /Applications (or ~/Applications), and
	 * every operator's parked profile for it — an app that is gone must not leave orphaned
	 * session data to be restored over a future reinstall. `deleteAppBundle` owns the strict
	 * name resolution; no path ever crosses the wire, only the bare bundle name.
	 *
	 * Refused while the lease is held: deleting the app being driven kills the run. Under the
	 * profile lock because the parked-profile sweep must not interleave with a swap parking
	 * data into the very directories being deleted.
	 */
	async function appDelete(params: Params): Promise<RunnerResponse> {
		const app = String(params.app ?? "").trim();
		if (!app) return { ok: false, error: "app is required" };

		const { holder } = inspect(runnerDir);
		if (holder)
			return {
				ok: false,
				error: `${holder.lease.operator} is running ${holder.lease.app} here (${holder.heldSec}s) — deleting an app mid-run would kill it`,
				busy: true,
				operator: holder.lease.operator,
				app: holder.lease.app,
				kind: holder.lease.kind,
				jobId: holder.lease.jobId,
				elapsedSec: holder.heldSec,
			};

		let deleted: AppDelete;
		try {
			deleted = await withProfileLock(() => deleteAppFor(app));
		} catch (e) {
			return { ok: false, error: `could not delete ${app}: ${(e as Error).message}` };
		}
		log(describeAppDelete(deleted));

		return {
			ok: true,
			app: deleted.app,
			bundle: deleted.bundle,
			removedProfiles: deleted.removedProfiles,
			removedLive: deleted.removedLive,
			ownershipCleared: deleted.ownershipCleared,
		};
	}

	/**
	 * Whether an app is at its declared home — the signal that a sign-in took.
	 *
	 * Delegated to a child process rather than answered here; `src/core/ready.ts` documents why at
	 * length, but the short version is that an AX call against an app a human is mid-dialog with
	 * can block forever, and this process holds the whole machine's TCC grants.
	 *
	 * A child that fails, times out or prints nothing parseable is reported as "not ready" with
	 * whatever it did say. There is no error case: mid-sign-in, "the app has no window yet" and
	 * "the app is showing a login" are the same answer to the only question being asked.
	 */
	function ready(params: Params): Promise<RunnerResponse> {
		const app = String(params.app ?? "").trim();
		if (!app) return Promise.resolve({ ok: false, error: "app is required" });

		const cmd = resolveRunCommand("src/core/ready.ts");

		return new Promise((resolve) => {
			execFile(
				cmd.command,
				[...cmd.args, app],
				{ cwd: resourcesRoot(), env: childEnv({ runnerDir, stamp: "ready" }), timeout: READY_PROBE_MS },
				(err, stdout, stderr) => {
					const line = stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
					try {
						const v = JSON.parse(line);
						if (typeof v?.ready === "boolean") return resolve({ ok: true, app, ready: v.ready, detail: String(v.detail ?? "") });
					} catch {
						// Fall through: an unparseable line is a probe that broke, not an app that is ready.
					}
					// firstLine turns the child's noise into one reportable sentence.
				resolve({ ok: true, app, ready: false, detail: firstLine(stderr) || firstLine(line) || (err ? err.message : "the readiness probe said nothing") });
				},
			);
		});
	}

	/**
	 * Seconds since the running job's log last grew, or undefined when it cannot be read.
	 * The watchdog signal for a live-but-wedged run: the reaper catches DEAD holders, but a
	 * hung driver call holds the lease with a healthy pid forever. Advisory only — a hard
	 * model turn is legitimately minutes of silence, so nothing here kills anything; the
	 * status just says how long the silence has lasted and the operator (or the bench
	 * collector reading fleet status) decides.
	 */
	function logSilenceSec(jobId: string): number | undefined {
		try {
			return Math.max(0, Math.round((Date.now() - fs.statSync(logPath(jobId, root)).mtimeMs) / 1000));
		} catch {
			return undefined;
		}
	}

	/** Log silence past this is flagged `stalled: true` in status. Advisory, never a kill. */
	const STALL_SEC = envNum("JOB_STALL_MINS", 30) * 60;

	function status(): RunnerResponse {
		const perms = opts.permissions?.();
		// When this PROCESS started, so a caller can tell whether the runner predates the code
		// currently on disk. It matters because syncOnly deliberately does not restart the
		// runner (restarting orphans in-flight jobs), which means a runner-side fix sits on
		// disk unexecuted until someone bounces it. CHILD-side fixes take effect on the next
		// job because children are spawned fresh; runner-side ones do not, and the difference
		// is invisible — on 2026-07-31 a --no-ax fix in this file was synced twice and the
		// vision arm ran without it both times, reporting success each time.
		const startedAt = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
		const stale = staleGrants(bootPermissions, perms);
		// tccOk stays false while a grant is stale: the point of the flag is "can this host run
		// a demo", and a process that cannot capture cannot, whatever the database says.
		const tcc = perms
			? { tccOk: perms.accessibility && perms.screenRecording && stale.length === 0, permissions: perms, ...(stale.length ? { staleGrants: stale } : {}) }
			: {};
		// The queue rides on both states. On busy it is the wait an operator is deciding
		// against; on idle a non-empty queue is a drain in flight (the swap takes seconds),
		// and hiding it would make those jobs unfindable from the fleet panel.
		const queued = listQueued(root).map((q) => ({
			jobId: q.id,
			operator: q.operator,
			app: q.app,
			kind: q.kind,
			...(q.queuedAt ? { queuedAt: q.queuedAt } : {}),
		}));
		const queue = queued.length ? { queue: queued } : {};
		const { holder } = inspect(runnerDir);
		if (!holder) return { ok: true, state: "idle", startedAt, ...tcc, ...queue };

		const silence = logSilenceSec(holder.lease.jobId);

		return {
			ok: true,
			state: "busy",
			startedAt,
			jobId: holder.lease.jobId,
			operator: holder.lease.operator,
			app: holder.lease.app,
			kind: holder.lease.kind,
			elapsedSec: holder.heldSec,
			...(silence !== undefined ? { logSilenceSec: silence, ...(silence >= STALL_SEC ? { stalled: true } : {}) } : {}),
			...tcc,
			...queue,
		};
	}

	function stop(params: Params): RunnerResponse {
		// Defaulting to the current lease holder is a CLI convenience — `runnerctl stop` on the
		// host means "stop whatever this Mac is doing". A controller acting for one operator must
		// always pass an explicit jobId: in the window before its own dispatch reply arrives, the
		// current holder may be someone else's run entirely.
		const id = typeof params.jobId === "string" ? params.jobId : currentJobId();
		if (!id) return { ok: false, error: "nothing is running" };
		const rec = readJob(id, root);
		if (!rec) return { ok: false, error: `unknown job ${id}` };
		// A queued job has no child to signal — leaving the line is a registry write. `stopped`
		// rather than a deletion, because a cancelled request is still a thing that happened.
		if (rec.state === "queued") {
			updateJob(id, { state: "stopped", exitCode: null, endedAt: new Date().toISOString() }, root);
			log(`job ${id} cancelled while queued`);

			return { ok: true, jobId: id, state: "stopped", note: "cancelled while queued" };
		}
		if (rec.state !== "running") return { ok: true, jobId: id, state: rec.state, note: "already finished" };

		stopping.add(id);
		stopGroup(rec.pid, STOP_GRACE_MS);
		log(`job ${id} signalled (SIGINT, SIGKILL in ${STOP_GRACE_MS / 1000}s)`);

		return { ok: true, jobId: id, signalled: "SIGINT" };
	}

	function jobStatus(params: Params): RunnerResponse {
		const id = typeof params.jobId === "string" ? params.jobId : currentJobId();
		if (!id) {
			const limit = Number(params.limit);

			return { ok: true, jobs: listJobs(root).slice(0, Number.isFinite(limit) && limit > 0 ? limit : 20) };
		}
		const rec = readJob(id, root);

		return rec ? { ok: true, job: rec } : { ok: false, error: `unknown job ${id}` };
	}

	function doctor(): RunnerResponse {
		const env = childEnv({ runnerDir, stamp: "doctor" });
		const envFile = path.join(runnerDir, "env");
		let mode: string | undefined;
		try {
			mode = (fs.statSync(envFile).mode & 0o777).toString(8).padStart(4, "0");
		} catch {}

		return {
			ok: true,
			runnerDir,
			socketPath,
			packaged: isPackaged(),
			dataRoot: dataRoot(),
			resourcesRoot: resourcesRoot(),
			jobsDir: root,
			agentCommand: resolveRunCommand("src/core/agent.ts"),
			envFile: {
				path: envFile,
				present: mode !== undefined,
				mode,
				// 0600 is the documented mode; anything looser means another local account can
				// read the API key, which is worth saying out loud rather than only in a README.
				warning: mode !== undefined && mode !== "0600" ? `expected 0600, found ${mode}` : undefined,
			},
			tools: {
				ffmpeg: onPath("ffmpeg", env.PATH),
				python3: onPath("python3", env.PATH),
				npx: onPath("npx", env.PATH),
			},
			apiKey: env.OPENROUTER_API_KEY ? "openrouter" : env.ANTHROPIC_API_KEY ? "anthropic" : "MISSING",
			// Not in `tools`: those are looked up on PATH, this one ships with the checkout and
			// fails in a different way — present, wrong architecture, silently unused.
			sidecar: sidecarStatus(),
			// A locked screen makes every app on the host unobservable (LIMITATIONS.md §12), and
			// nothing else in this payload notices: permissions read as granted, the runner is
			// idle, the host grades clean. Before this line the only way to find out was to spend
			// a dispatch and read the failure.
			screenLocked: screenIsLocked(),
			// Read back from cfprefsd, not from what provisioning believes it wrote — the two
			// disagree exactly when a user or synced preference outranks a recommended policy,
			// which is the case worth catching (see src/remote/chrome-policy.ts).
			chromePolicy: chromePolicyHere(),
			permissions: opts.permissions?.() ?? null,
			staleGrants: staleGrants(bootPermissions, opts.permissions?.()),
			lease: inspect(runnerDir),
			// Masked: doctor output gets pasted into messages and issue trackers.
			env: maskEnv(env),
		};
	}

	/**
	 * Bounce this process so a grant ticked since launch takes effect.
	 *
	 * Exits rather than shelling out to `launchctl kickstart`: the plist sets KeepAlive, so
	 * launchd brings the runner straight back, and exiting needs neither the job label nor the
	 * uid — both of which this module would otherwise have to import from the operator-side
	 * provisioning code to say something launchd already knows.
	 *
	 * Refused while a job is in flight. The runner is not the run's parent (spawnDetached), so
	 * exiting would not kill it, but it WOULD orphan its log stream and its lease, and the point
	 * of restarting is to fix capture — not to wreck the recording that is mid-capture.
	 */
	function restart(params: Params): RunnerResponse {
		const force = params.force === true;
		const { holder } = inspect(runnerDir);
		if (holder && !force)
			return { ok: false, error: `job ${holder.lease.jobId} is running (${holder.heldSec}s) — stop it first, or pass force` };

		// launchd sets XPC_SERVICE_NAME to the job label for the processes it owns. A runner
		// started by hand has nothing to bring it back, and exiting would take the host out of
		// the fleet until someone notices.
		const managed = Boolean(process.env.XPC_SERVICE_NAME) && process.env.XPC_SERVICE_NAME !== "0";
		if (!managed && !force)
			return { ok: false, error: "this runner was not started by launchd, so nothing would restart it — restart it the way it was started, or pass force" };

		log(`restart requested${holder ? ` (forced over running job ${holder.lease.jobId})` : ""}; exiting for launchd to respawn`);
		// After the reply is written. unref'd so a hung socket cannot hold the exit open.
		setTimeout(opts.exit ?? (() => process.exit(0)), RESTART_DELAY_MS).unref();

		return { ok: true, restarting: true, managed, pid: process.pid, note: "launchd respawns this within a few seconds; re-check with doctor" };
	}

	/**
	 * Make this host appear in the System Settings panes an operator is told to go tick.
	 *
	 * Grants nothing. TCC is SIP-protected and only a human at the machine can flip a switch —
	 * what this fixes is that on a freshly provisioned Mac there is no switch to flip. The
	 * Screen & System Audio Recording pane has no `+` button and is populated only by processes
	 * that have called `CGRequestScreenCaptureAccess`, so a runner that has only ever *read* its
	 * permissions is absent from the list with no way to add it by browsing to the bundle.
	 *
	 * Returns the state after asking, which is normally still false — see `needsRestart`.
	 */
	async function grant(): Promise<RunnerResponse> {
		if (!opts.requestPermissions)
			return {
				ok: false,
				error: "this runner is not running under Electron, so there is no app for macOS to register — start it via the LaunchAgent",
			};

		const before = opts.permissions?.();
		const after = await opts.requestPermissions();
		log(`permission request: accessibility=${after.accessibility} screenRecording=${after.screenRecording}`);

		return {
			ok: true,
			permissions: after,
			before,
			bundle: process.execPath,
			// macOS does not apply a NEW Screen Recording grant to an already-running process, so
			// ticking the box changes nothing until this process restarts. Said here because the
			// symptom otherwise is a granted-looking checkbox and a still-empty capture, which
			// reads as a broken agent rather than a stale process.
			needsRestart: !(after.accessibility && after.screenRecording),
			hint: "tick both boxes in System Settings ▸ Privacy & Security, then restart the runner: launchctl kickstart -k gui/$(id -u)/com.yarn.runner",
		};
	}

	/**
	 * Log bytes, framed as NDJSON with the payload base64'd. Base64 rather than a JSON string
	 * because the offsets are byte offsets: a chunk boundary can fall inside a multi-byte
	 * character, and re-encoding a half character through UTF-8 would corrupt it permanently.
	 * The client concatenates buffers and decodes once.
	 */
	function streamLogs(conn: net.Socket, params: Params): void {
		const id = typeof params.jobId === "string" ? params.jobId : (currentJobId() ?? listJobs(root)[0]?.id);
		if (!id) {
			send(conn, { ok: false, error: "no jobs on this host" });
			conn.end();

			return;
		}
		const follow = params.follow === true;
		let offset = Number(params.fromByte ?? 0);
		if (!Number.isFinite(offset) || offset < 0) offset = 0;

		// One close handler for the whole stream, not one per poll: a follow of a long
		// grounding pass polls thousands of times, and registering per iteration would leak
		// listeners (and trip Node's max-listeners warning) within the first minute.
		let timer: NodeJS.Timeout | undefined;
		conn.once("close", () => clearTimeout(timer));

		const pump = (): void => {
			if (conn.destroyed) return;
			const chunk = readLog(id, offset, root);
			offset = chunk.nextOffset;
			if (chunk.bytes.length)
				send(conn, { ok: true, jobId: id, chunk: chunk.bytes.toString("base64"), nextOffset: offset });

			const rec = readJob(id, root);
			// A queued job is alive in the only sense that matters to a follower: its log will
			// grow once the drain starts it. Ending the stream here would make "dispatch, then
			// follow" impossible for exactly the jobs the queue exists for.
			const waiting = rec?.state === "queued";
			const running = (rec?.state === "running" && pidAlive(rec.pid)) || waiting;
			if (!follow || (!running && chunk.bytes.length === 0)) {
				send(conn, {
					ok: true,
					jobId: id,
					done: true,
					nextOffset: offset,
					state: rec?.state ?? "unknown",
					exitCode: rec?.exitCode ?? null,
				});
				conn.end();

				return;
			}
			timer = setTimeout(pump, FOLLOW_POLL_MS);
			timer.unref();
		};

		pump();
	}

	function handle(conn: net.Socket, line: string): void {
		let req: { method?: unknown; params?: unknown };
		try {
			req = JSON.parse(line);
		} catch {
			send(conn, { ok: false, error: "request was not JSON" });
			conn.end();

			return;
		}
		const params = (req.params ?? {}) as Params;

		if (req.method === "logs") return streamLogs(conn, params);

		// Async, so they cannot go through the switch below. Their own catch: an unhandled
		// rejection here would take down the process holding the fleet's TCC grants.
		//
		// `submit` joined them when it grew the profile swap, which quits the target app and
		// moves its data — seconds of real work that must not block the event loop, because the
		// same loop is streaming another job's log while it happens. `signin` does the same swap,
		// and `ready` waits on a child process that can take most of a minute.
		const handlers: Record<string, (() => Promise<RunnerResponse>) | undefined> = {
			grant,
			submit: () => submit(params),
			signin: () => signin(params),
			liveview: () => liveview(params),
			"liveview-stop": () => liveviewStop(),
				"peek-prep": () => peekPrep(),
			ready: () => ready(params),
			// Lowercase on the wire: `runnerArgv` only carries bare [a-z0-9-] subcommands, so the
			// method name IS the subcommand and cannot carry a capital.
			authclear: () => authClear(params),
			appdelete: () => appDelete(params),
		};
		const async = handlers[String(req.method)];
		if (async) {
			async().then(
				(res) => {
					send(conn, res);
					conn.end();
				},
				(e: Error) => {
					log(`method ${String(req.method)} threw: ${e.stack ?? e.message}`);
					send(conn, { ok: false, error: e.message });
					conn.end();
				},
			);

			return;
		}

		let res: RunnerResponse;
		try {
			switch (req.method) {
				case "status":
					res = status();
					break;
				case "job":
					res = jobStatus(params);
					break;
				case "stop":
					res = stop(params);
					break;
				case "apps":
					res = { ok: true, apps: listApps() };
					break;
				case "doctor":
					res = doctor();
					break;
				case "restart":
					res = restart(params);
					break;
				default:
					res = { ok: false, error: `unknown method ${JSON.stringify(req.method)}` };
			}
		} catch (e) {
			// One bad request must not take the runner down with it: the process holds the TCC
			// grants for the whole machine and is restarted only by launchd.
			res = { ok: false, error: (e as Error).message };
			log(`method ${String(req.method)} threw: ${(e as Error).stack ?? (e as Error).message}`);
		}
		send(conn, res);
		conn.end();
	}

	// A socket file left behind by a killed runner is not reused — bind fails with EADDRINUSE
	// against a path nothing is listening on, and it fails identically on every restart after
	// that, so the machine never comes back without a manual `rm`.
	//
	// But an unconditional rm is worse than the problem: launchd's KeepAlive plus a manual
	// start, or a provision that bootstraps while a runner is up, gives two processes here at
	// once. The second would unlink the FIRST one's socket and bind its own — leaving the
	// original serving a path no client can reach, still holding the lease, with runs in
	// flight and nothing logging that anything happened. So probe first: only a path with no
	// listener is ours to delete.
	if (await socketIsLive(socketPath)) throw new Error(`a runner is already listening on ${socketPath}`);
	fs.rmSync(socketPath, { force: true });

	const server = net.createServer((conn) => {
		sockets.add(conn);
		conn.on("close", () => sockets.delete(conn));
		conn.on("error", () => conn.destroy());
		// StringDecoder, not toString per chunk: the request is UTF-8 off a stream, and a chunk
		// boundary landing inside a multi-byte character would decode each half as U+FFFD — a
		// submit spec big enough to straddle chunks would run with silently corrupted task text.
		// The same rule streamPump and dispatch.follow already treat as load-bearing.
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		let served = false;
		conn.on("data", (data) => {
			// One request per connection: `ctl` opens, asks, reads, exits. Once served, nothing
			// more is buffered — a `logs --follow` stream must not be interleaved with replies,
			// and a peer that keeps writing must not grow this process's memory.
			if (served) return;
			buffer += decoder.write(data);
			if (buffer.length > MAX_REQUEST_BYTES) {
				served = true;
				buffer = "";
				send(conn, { ok: false, error: `request exceeded ${MAX_REQUEST_BYTES} bytes before a newline` });
				conn.end();

				return;
			}
			const nl = buffer.indexOf("\n");
			if (nl < 0) return;
			served = true;
			handle(conn, buffer.slice(0, nl));
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	log(`listening on ${socketPath}`);

	// Queued records survive a restart by construction (they are files); what does not survive
	// is the finalise whose drain would have started them. One drain here picks the queue back
	// up — after the socket is listening, so a slow profile swap cannot delay the first status
	// poll, and after the orphan sweep above, which is what freed the lease it will claim.
	if (listQueued(root).length) void drain();

	return {
		socketPath,
		close: async () => {
			clearInterval(reaper);
			for (const s of sockets) s.destroy();
			sockets.clear();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			fs.rmSync(socketPath, { force: true });
		},
	};
}

function send(conn: net.Socket, res: RunnerResponse): void {
	if (!conn.destroyed) conn.write(`${JSON.stringify(res)}\n`);
}

/**
 * Is something accepting connections on this path right now?
 *
 * Connecting is the only honest test. The socket file's existence says nothing — it outlives
 * the process that made it — and neither does a pid file, which is what this replaces. The
 * three codes below mean the path is dead and safe to unlink; anything else is treated as
 * live, because refusing to start is recoverable and stealing a working runner's socket is not.
 */
const DEAD_SOCKET_CODES = new Set([
	/** Nothing at the path at all — the ordinary first-boot case. */
	"ENOENT",
	/** A real socket file whose listener is gone: the classic leftover from a killed runner. */
	"ECONNREFUSED",
	/** Not a socket at all. Reached when something wrote a plain file over the path. */
	"ENOTSOCK",
]);

export function socketIsLive(socketPath: string, timeoutMs = 1000): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = net.connect(socketPath);
		const finish = (live: boolean): void => {
			probe.destroy();
			resolve(live);
		};
		// A path that accepts the connection but never speaks is still a listener holding the
		// address, so a timeout counts as live.
		probe.setTimeout(timeoutMs, () => finish(true));
		probe.once("connect", () => finish(true));
		probe.once("error", (err) => finish(!DEAD_SOCKET_CODES.has((err as NodeJS.ErrnoException).code ?? "")));
	});
}

/**
 * Chrome's effective autofill/password policy on this Mac, for `doctor`.
 *
 * Exists because provisioning cannot answer this question about itself: it writes a RECOMMENDED
 * policy, and a recommended policy is outranked by any explicit user preference — including one
 * delivered by Chrome sync. So the host is asked what it will actually do, via the same
 * preference daemon Chrome reads. Rationale in full: src/remote/chrome-policy.ts.
 *
 * Every probe is wrapped. This runs inside the process holding the fleet's TCC grants, and a
 * diagnostic that can throw is a diagnostic that can take the fleet down.
 */
function chromePolicyHere(): ChromePolicyState {
	const read1 = (domain: string, key: string): string | undefined => {
		try {
			// `defaults` exits nonzero for an unset key, which execFileSync turns into a throw —
			// that is the "unset" answer, not an error.
			return execFileSync("defaults", ["read", domain, key], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			return undefined;
		}
	};
	/**
	 * Managed domain FIRST, then the user domain — the order Chrome itself resolves in.
	 *
	 * A key delivered by a configuration profile exists ONLY under /Library/Managed
	 * Preferences; nothing writes it to the user domain. Reading just the user domain graded
	 * AutoLaunchProtocolsFromOrigins "unset" on 2026-07-31 while `chrome://policy` on the same
	 * host reported it Mandatory/OK — the grader calling a correctly-policed fleet unpoliced,
	 * which is the exact failure the level check exists to prevent, inverted.
	 */
	const readDefault = (domain: string, key: string): string | undefined => {
		for (const p of MANDATORY_PLISTS) {
			const hit = read1(p.replace("__HOME__", os.homedir()).replace("__USER__", os.userInfo().username).replace(/\.plist$/, ""), key);
			if (hit !== undefined) return hit;
		}

		return read1(domain, key);
	};
	const running = ((): boolean | undefined => {
		try {
			execFileSync("pgrep", ["-x", "Google Chrome"], { timeout: 5000, stdio: "ignore" });

			return true;
		} catch (e) {
			// pgrep exits 1 for "no match" and something else when it could not run at all. Only
			// the first is an answer; the second must stay undefined rather than become "no".
			return (e as { status?: number }).status === 1 ? false : undefined;
		}
	})();

	return inspectChromePolicy({
		home: os.homedir(),
		user: os.userInfo().username,
		readDefault,
		exists: (p) => fs.existsSync(p),
		chromeInstalled: fs.existsSync("/Applications/Google Chrome.app"),
		...(running === undefined ? {} : { chromeRunning: running }),
	});
}

/** Presence check without spawning anything: `doctor` runs on a host that may be mid-run. */
function onPath(bin: string, pathValue = ""): boolean {
	return pathValue.split(":").filter(Boolean).some((dir) => {
		try {
			fs.accessSync(path.join(dir, bin), fs.constants.X_OK);

			return true;
		} catch {
			return false;
		}
	});
}
