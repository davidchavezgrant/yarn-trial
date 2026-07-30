import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dataRoot, resourcesRoot } from "../paths.js";

/**
 * Launching a run as a child that can outlive its parent.
 *
 * Three things are different from `RunController.spawn`, and each one is a bug it has:
 *
 * 1. **The child owns its log.** Today stdio are pipes owned by Electron, so restarting the
 *    shell keeps the detached child running and loses every line it produces — the run
 *    survives and its output does not. Handing the child a file descriptor on `log.txt`
 *    instead makes the output durable, and durable output is what makes byte-offset replay
 *    possible for both `logs --follow` and a UI re-attach.
 * 2. **The environment is built, not inherited.** Under launchd there is nothing useful to
 *    inherit: no Homebrew on PATH, no API key, cwd `/`. See `childEnv`.
 * 3. **The command adapts to packaging.** See `resolveRunCommand`.
 */

/**
 * Set by the Electron shell from `app.isPackaged` before starting the server. An env var
 * rather than an import because nothing in src/ may depend on electron — these modules run
 * under plain node in tests and under tsx on the Macs.
 */
export const PACKAGED_ENV = "YARN_RUNNER_PACKAGED";

export interface RunCommand {
	command: string;
	args: string[];
}

export interface SpawnOptions {
	/** Absolute path to the job's `log.txt`; stdout and stderr are both appended to it. */
	logFile: string;
	env: NodeJS.ProcessEnv;
	cwd?: string;
}

export interface Spawned {
	pid: number;
	child: ChildProcess;
}

export function isPackaged(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[PACKAGED_ENV] === "1";
}

/**
 * How to invoke `src/agent.ts` or `src/explore.ts`, which differs by deployment:
 *
 * - **Packaged**: `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, against the compiled JS
 *   under `dist-electron/`. Two things fall out of that and both are the point. The child is
 *   the same signed binary as the parent, so macOS attributes Accessibility and Screen
 *   Recording to it by inheritance rather than re-prompting for a second identity. And the
 *   machine needs no node, no npm and no tsx — Electron ships the runtime, so packaging is
 *   a copy rather than a provisioning exercise.
 * - **Dev and the Macs as they stand**: `npx tsx <script>`, unchanged from what the shell
 *   does today, which keeps edit-and-rerun working with no build step in the loop.
 *
 * Because both branches end at the same script with the same argv, packaging changes one
 * line of resolution and nothing about how a run behaves.
 */
export function resolveRunCommand(scriptRelPath: string, env: NodeJS.ProcessEnv = process.env): RunCommand {
	if (!isPackaged(env)) return { command: "npx", args: ["tsx", scriptRelPath] };

	// tsc emits alongside the source tree under dist-electron/ (see tsconfig.electron.json),
	// so the relative path carries over with only the extension rewritten.
	const compiled = scriptRelPath.replace(/\.mts$/, ".mjs").replace(/\.ts$/, ".js");

	return { command: process.execPath, args: [path.join(resourcesRoot(), "dist-electron", compiled)] };
}

/** Prepended to PATH: the agent shells out to `ffmpeg` and `python3`, neither of which is in launchd's PATH. */
const BREW_PATHS = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * Key/value file at `<runnerDir>/env`, holding the API key and any per-host overrides.
 *
 * It exists because launchd does not run a login shell: the operator's `.zshrc`, their
 * exported `OPENROUTER_API_KEY` and their PATH are all absent from a LaunchAgent's
 * environment, so a runner that inherited its way to a key would work when tested by hand
 * from a terminal and fail at every boot. The file is the declared place that key lives.
 *
 * Deliberately minimal parsing — `KEY=value`, `#` comments, optional surrounding quotes. A
 * dotenv library's variable expansion and multiline support would only add ways for a secret
 * to be mangled.
 */
export function loadRunnerEnv(runnerDir: string): Record<string, string> {
	let text: string;
	try {
		text = fs.readFileSync(path.join(runnerDir, "env"), "utf8");
	} catch {
		return {};
	}

	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
		const raw = trimmed.slice(eq + 1).trim();
		out[key] = /^(".*"|'.*')$/s.test(raw) ? raw.slice(1, -1) : raw;
	}

	return out;
}

export interface ChildEnvOptions {
	runnerDir: string;
	/** The job id, handed to the child so its run log and recording land on the same key. */
	stamp: string;
	/** The environment to extend. Injected so tests can present launchd's, which is nearly empty. */
	base?: NodeJS.ProcessEnv;
}

/**
 * The environment a run actually needs, assembled explicitly.
 *
 * Every entry here is a launchd failure that would otherwise present as something else: a
 * missing PATH looks like "ffmpeg is not installed", a missing key looks like an auth error
 * from the model, and a cwd of `/` looks like an ungrounded run because the appmap was not
 * found. The file's values win over the inherited ones — the point of setting a key
 * per-host is that it is the one used.
 */
export function childEnv(opts: ChildEnvOptions): NodeJS.ProcessEnv {
	const base = opts.base ?? process.env;
	const fromFile = loadRunnerEnv(opts.runnerDir);
	const existing = (fromFile.PATH ?? base.PATH ?? "").split(":").filter(Boolean);
	const pathEntries = [...BREW_PATHS, ...existing].filter((dir, i, all) => all.indexOf(dir) === i);

	return {
		...base,
		...fromFile,
		PATH: pathEntries.join(":"),
		RUN_STAMP: opts.stamp,
		// paths.ts reads these instead of cwd, which is `/` under launchd and inside a
		// packaged .app. Passing them through keeps the child writing to the same out/ the
		// runner reads its job registry from.
		YARN_RUNNER_DATA: dataRoot(),
		YARN_RUNNER_RESOURCES: resourcesRoot(),
		// Turns the Electron binary into a plain node runtime for the child. Only meaningful
		// alongside the packaged branch of resolveRunCommand, and set nowhere else.
		...(isPackaged(base) ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
	};
}

const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/**
 * Config as `doctor` may print it. Secrets are reduced to presence and length: "is the key
 * there and does it look truncated" is the entire diagnostic value, and the output of a
 * doctor command ends up pasted into messages and CI logs.
 */
export function maskEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) continue;
		out[k] = SECRETISH.test(k) ? `<set, ${v.length} chars>` : v;
	}

	return out;
}

/**
 * Start the run and let go of it.
 *
 * `detached` gives the child its own process group, which is what lets it survive the
 * runner and what lets `stop` signal the whole tree — the agent spawns ffmpeg and the
 * driver daemon beneath it, and signalling only the top of that tree leaves a driver session
 * alive to break the next job. `unref` removes it from our event loop without severing the
 * parent relationship, so exit events still arrive while the runner lives.
 */
export function spawnDetached(cmd: RunCommand, opts: SpawnOptions): Spawned {
	fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
	const fd = fs.openSync(opts.logFile, "a");
	try {
		const child = spawn(cmd.command, cmd.args, {
			// cwd is the checkout, never ours: relative script paths resolve against it, and
			// under launchd our own cwd is `/`.
			cwd: opts.cwd ?? resourcesRoot(),
			env: opts.env,
			detached: true,
			stdio: ["ignore", fd, fd],
		});
		child.unref();
		if (child.pid === undefined) throw new Error(`failed to spawn ${cmd.command}`);

		return { pid: child.pid, child };
	} finally {
		// The child holds its own duplicate of the descriptor; keeping ours open would pin
		// the file for the life of the runner.
		fs.closeSync(fd);
	}
}

/**
 * Signal a run's whole process group. SIGINT first so the agent's `finally` can close the
 * driver session, SIGKILL after the grace period because a wedged child holding a session
 * blocks every later job on the host — an unstoppable run is worse than an unclean one.
 */
export function stopGroup(pid: number, graceMs: number): void {
	if (!Number.isInteger(pid) || pid <= 1) return;
	try {
		process.kill(-pid, "SIGINT");
	} catch {
		return; // already gone
	}
	const timer = setTimeout(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
	}, graceMs);
	timer.unref();
}
