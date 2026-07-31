import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	createJob,
	type JobRecord,
	listJobs,
	mintJobId,
	pidAlive,
	readJob,
	readLog,
	sweepOrphans,
	updateJob,
	writeJob,
} from "./runner/jobs.js";
import { acquire, adopt, defaultRunnerDir, describeHolder, inspect, type Lease, release } from "./runner/lease.js";
import { childEnv, isPackaged, PACKAGED_ENV, resolveRunCommand, spawnDetached } from "./runner/spawn.js";
import { parseArgs } from "./runner/ctl.js";
import { staleGrants, startRunner } from "./runner/serve.js";
import { resourcesRoot } from "./paths.js";

/**
 * Spread into every `startRunner` below. The real profile swap quits the target app and moves
 * `~/Library` directories out from under it — correct on a colo Mac, unacceptable on the
 * developer machine that also runs this suite. `src/profiles.test.ts` covers the real one
 * against temp directories.
 */
const noSwap = {
	swap: async (app: string, operator: string) => ({
		action: "kept" as const,
		app,
		operator,
		stashed: [],
		restored: [],
		fresh: false,
	}),
};

/**
 * Every test owns a temp directory and nothing here touches `~/.yarn-runner` — the runner
 * dir is a parameter precisely so these can run on a machine that has a live one.
 *
 * Liveness is tested with real processes rather than a stubbed `process.kill`, because the
 * behaviour under test IS the kernel's answer: a mock would let a wrong reading of ESRCH
 * versus EPERM pass, which is the one distinction that decides whether a busy host gets
 * handed to a second operator.
 */

/**
 * A pid that cannot be in use. macOS wraps pids well below this (`kern.maxproc` defaults to
 * 2048, the printable ceiling is 99998), so nothing can be occupying it.
 */
const DEAD_PID = 4_194_303;

function tempDir(prefix: string): string {
	// Short prefix: a Unix socket path is capped near 104 bytes and os.tmpdir() already
	// spends ~49 of them on macOS.
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withTemp(prefix: string, fn: (dir: string) => void): void {
	const dir = tempDir(prefix);
	try {
		fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

async function withTempAsync(prefix: string, fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = tempDir(prefix);
	try {
		await fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function lease(over: Partial<Lease> = {}): Lease {
	return {
		jobId: "2026-07-30T12-00-00-yarn",
		operator: "dave",
		kind: "task",
		app: "Yarn",
		startedAt: new Date().toISOString(),
		pid: process.pid,
		...over,
	};
}

function job(over: Partial<JobRecord> = {}): JobRecord {
	return {
		id: "2026-07-30T12-00-00-yarn",
		kind: "task",
		app: "Yarn",
		task: "show me how to change the cursor type",
		operator: "dave",
		state: "running",
		pid: process.pid,
		startedAt: new Date().toISOString(),
		artifacts: { log: "out/jobs/2026-07-30T12-00-00-yarn/log.txt" },
		...over,
	};
}

/**
 * Poll until a condition holds. Used instead of awaiting a child's `exit` event because the
 * children here are `unref`'d: nothing about them keeps the event loop alive, so a promise
 * settled only from their exit handler can never resolve in a test process with no other
 * work. A timer is work.
 */
async function waitFor(what: string, cond: () => boolean, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

/** A child that exits on its own, for the cases that need a pid which is briefly real. */
function shortLivedChild(): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
		const pid = child.pid;
		if (pid === undefined) return reject(new Error("no pid"));
		child.on("exit", () => resolve(pid));
	});
}

test("pidAlive__ReportsSelfAlive__When__AskedAboutThisProcess", () => {
	assert.equal(pidAlive(process.pid), true);
	assert.equal(pidAlive(DEAD_PID), false);
	// Non-positive pids address process GROUPS in kill(2) and must never read as alive.
	assert.equal(pidAlive(0), false);
	assert.equal(pidAlive(-1), false);
});

test("lease__RefusesAcquire__When__AnotherLeaseIsAlive", () => {
	withTemp("yr-lease-", (dir) => {
		const first = acquire(lease(), dir);
		assert.equal(first.ok, true);

		const second = acquire(lease({ jobId: "other", operator: "sam" }), dir);
		assert.equal(second.ok, false);
		// Refused, not queued: a second driver session kills the run in flight (LIMITATIONS §6).
		assert.equal(inspect(dir).holder?.lease.jobId, "2026-07-30T12-00-00-yarn");
	});
});

test("lease__ReclaimsHost__When__HolderPidIsDead", async () => {
	await withTempAsync("yr-lease-", async (dir) => {
		const deadPid = await shortLivedChild();
		assert.equal(acquire(lease({ pid: deadPid }), dir).ok, true);
		assert.equal(inspect(dir).holder, undefined, "a dead holder is not a holder");

		const next = acquire(lease({ jobId: "next", operator: "sam", pid: process.pid }), dir);
		assert.equal(next.ok, true);
		// Reported rather than silent — a host that frees itself invisibly is unexplainable later.
		assert.equal(next.ok && next.reclaimed?.pid, deadPid);
		assert.equal(inspect(dir).holder?.lease.jobId, "next");
	});
});

test("lease__ReportsHolder__When__AcquireIsRefused", () => {
	withTemp("yr-lease-", (dir) => {
		const startedAt = new Date(Date.now() - 14 * 60_000).toISOString();
		acquire(lease({ operator: "dave", kind: "explore", app: "Notion Calendar", startedAt }), dir);

		const refused = acquire(lease({ jobId: "other", operator: "sam" }), dir);
		assert.equal(refused.ok, false);
		if (refused.ok) return;
		assert.equal(refused.holder.lease.operator, "dave");
		assert.equal(refused.holder.lease.app, "Notion Calendar");
		assert.ok(refused.holder.heldSec >= 840);
		assert.equal(describeHolder(refused.holder), "busy: dave, explore Notion Calendar, 14m");
		assert.equal(refused.reason, "busy: dave, explore Notion Calendar, 14m");
	});
});

test("lease__StaysHeld__When__ReleaseNamesADifferentJob", () => {
	withTemp("yr-lease-", (dir) => {
		acquire(lease(), dir);
		// A late exit handler for a finished run must not free the host from under its successor.
		assert.equal(release(dir, "some-older-job"), false);
		assert.equal(inspect(dir).holder?.lease.jobId, "2026-07-30T12-00-00-yarn");
		assert.equal(release(dir, "2026-07-30T12-00-00-yarn"), true);
		assert.equal(inspect(dir).holder, undefined);
	});
});

test("adopt__PointsLeaseAtTheChild__When__SpawnSucceeds", () => {
	withTemp("yr-lease-", (dir) => {
		acquire(lease({ pid: process.pid }), dir);
		// The claim is made under the runner's pid before the child exists; adoption is what
		// keeps the host marked busy if the runner restarts while the run continues.
		assert.equal(adopt("2026-07-30T12-00-00-yarn", process.pid, dir), true);
		assert.equal(adopt("a-job-that-is-not-holding-it", 1234, dir), false);
	});
});

test("defaultRunnerDir__HonoursOverride__When__EnvVarIsSet", () => {
	const prev = process.env.YARN_RUNNER_DIR;
	try {
		process.env.YARN_RUNNER_DIR = "/tmp/yr-override";
		assert.equal(defaultRunnerDir(), "/tmp/yr-override");
	} finally {
		if (prev === undefined) delete process.env.YARN_RUNNER_DIR;
		else process.env.YARN_RUNNER_DIR = prev;
	}
});

test("mintJobId__MatchesTheRunLogStamp__When__AppNameHasSpaces", () => {
	const id = mintJobId("task", "Notion Calendar");
	// Exactly the shape agent.ts builds for out/runs/<stamp>-<slug>.json, so the job dir, the
	// run log and the recording dir share one key. Carries milliseconds so a runner dispatching
	// several jobs in the same second does not mint one id for all of them.
	assert.match(id, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}(-\d+)?-notion-calendar$/);
	assert.match(mintJobId("explore", "Yarn"), /^explore-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}(-\d+)?-yarn$/);
	// The app string arrives over a socket and becomes a path segment.
	assert.equal(mintJobId("task", "../../etc").includes("/"), false);
});

test("mintJobId__YieldsDistinctIds__When__TwoAreMintedInTheSameSecond", () => {
	// The collision the millis precision exists to prevent: a runner dispatching two jobs back
	// to back would otherwise give both the same id, directory and log.
	const prev = process.env.RUN_STAMP;
	delete process.env.RUN_STAMP;
	try {
		const ids = new Set(Array.from({ length: 20 }, () => mintJobId("task", "Yarn")));
		assert.equal(ids.size, 20);
	} finally {
		if (prev !== undefined) process.env.RUN_STAMP = prev;
	}
});

test("mintJobId__YieldsAFreshId__When__TheRunnerAlreadySetRunStamp", () => {
	// The runner exports RUN_STAMP into every child it spawns. If it ever minted ids through
	// runKey() instead, one exported value would give every job on the Mac the same id — same
	// directory, same log, same run log — and each run would overwrite the last.
	const prev = process.env.RUN_STAMP;
	process.env.RUN_STAMP = "2026-01-01T00-00-00-stale";
	try {
		assert.equal(mintJobId("task", "Yarn").includes("stale"), false);
	} finally {
		if (prev === undefined) delete process.env.RUN_STAMP;
		else process.env.RUN_STAMP = prev;
	}
});

test("createJob__ListsTheAppmapGraph__When__TheJobIsAnExplorePass", async () => {
	await withTempAsync("yr-jobs-", async (dir) => {
		const rec = createJob({ id: "explore-job", kind: "explore", app: "Notion Calendar", task: "", operator: "dave" }, dir);
		// Both halves, because the .json is what findScopeAmbiguities() reads: a pull that
		// fetched only the prose would silently switch off the scope-collision warnings while
		// every later run still looked grounded.
		assert.equal(rec.artifacts.appmap, "docs/appmaps/notion-calendar.md");
		assert.equal(rec.artifacts.appmapGraph, "docs/appmaps/notion-calendar.json");

		// A task run has neither — it consumes appmaps, it does not produce them.
		const task = createJob({ id: "task-job", kind: "task", app: "Notion Calendar", task: "t", operator: "dave" }, dir);
		assert.equal(task.artifacts.appmapGraph, undefined);
		assert.equal(task.artifacts.runLog, "out/runs/task-job.json");
	});
});

test("sweepOrphans__MarksJobOrphaned__When__PidIsGone", async () => {
	await withTempAsync("yr-jobs-", async (dir) => {
		const deadPid = await shortLivedChild();
		writeJob(job({ id: "dead-job", pid: deadPid }), dir);
		writeJob(job({ id: "live-job", pid: process.pid }), dir);
		writeJob(job({ id: "old-job", pid: deadPid, state: "done", exitCode: 0 }), dir);

		const swept = sweepOrphans(dir);

		assert.deepEqual(swept.map((j) => j.id), ["dead-job"]);
		assert.equal(readJob("dead-job", dir)?.state, "orphaned");
		// Not "failed": nobody collected an exit status, so none is asserted.
		assert.equal(readJob("dead-job", dir)?.exitCode, null);
		// A detached run survives a runner restart on purpose.
		assert.equal(readJob("live-job", dir)?.state, "running");
		assert.equal(readJob("old-job", dir)?.state, "done");
	});
});

test("listJobs__OrdersNewestFirst__When__ExploreAndTaskJobsCoexist", () => {
	withTemp("yr-jobs-", (dir) => {
		// `explore-` begins with a letter and letters outrank digits, so a raw lexicographic
		// sort pinned every explore job above every task job regardless of age — `runnerctl
		// logs` on an idle host streamed a week-old explore log instead of yesterday's run.
		// Order must follow the timestamp portion of the id alone.
		writeJob(job({ id: "explore-2026-07-23T10-00-00-000-yarn", kind: "explore" }), dir);
		writeJob(job({ id: "2026-07-30T12-00-00-000-yarn" }), dir);
		writeJob(job({ id: "explore-2026-07-30T13-00-00-000-yarn", kind: "explore" }), dir);

		assert.deepEqual(listJobs(dir).map((j) => j.id), [
			"explore-2026-07-30T13-00-00-000-yarn",
			"2026-07-30T12-00-00-000-yarn",
			"explore-2026-07-23T10-00-00-000-yarn",
		]);
	});
});

test("writeJob__NeverYieldsPartialRead__When__WriteIsInterrupted", () => {
	withTemp("yr-jobs-", (dir) => {
		const big = "x".repeat(200_000);
		writeJob(job({ id: "atomic", task: big }), dir);

		// The property under test is that a reader never observes an intermediate file. Assert
		// it structurally: every write lands via rename, so the target parses after each one
		// and no temp file is ever left to be mistaken for a record.
		for (let i = 0; i < 25; i++) {
			updateJob("atomic", { task: `${big}${i}` }, dir);
			assert.equal(readJob("atomic", dir)?.task.endsWith(String(i)), true);
			assert.deepEqual(fs.readdirSync(path.join(dir, "atomic")).filter((f) => f.endsWith(".tmp")), []);
		}

		// A crashed write leaves its temp file behind at worst; readers must not see it as a job.
		fs.writeFileSync(path.join(dir, "atomic", ".job.json.999.abcdef.tmp"), "{ truncated");
		assert.equal(readJob("atomic", dir)?.id, "atomic");
		assert.deepEqual(listJobs(dir).map((j) => j.id), ["atomic"]);
	});
});

test("writeJob__LeavesNoTempFile__When__SerialisationFails", () => {
	withTemp("yr-jobs-", (dir) => {
		const cyclic = job({ id: "cyclic" }) as any;
		cyclic.self = cyclic;
		assert.throws(() => writeJob(cyclic, dir));
		assert.deepEqual(fs.readdirSync(path.join(dir, "cyclic")), []);
	});
});

test("readLog__ResumesFromOffset__When__CalledWithNextOffset", () => {
	withTemp("yr-jobs-", (dir) => {
		const rec = createJob({ id: "logs", kind: "task", app: "Yarn", task: "t", operator: "dave" }, dir);
		const file = path.join(dir, rec.id, "log.txt");

		fs.appendFileSync(file, "first line\n");
		const a = readLog(rec.id, 0, dir);
		assert.equal(a.bytes.toString(), "first line\n");
		assert.equal(a.nextOffset, 11);

		// Nothing new: the poll costs an empty frame, not a re-send of the whole file.
		const b = readLog(rec.id, a.nextOffset, dir);
		assert.equal(b.bytes.length, 0);
		assert.equal(b.nextOffset, 11);

		fs.appendFileSync(file, "second line\n");
		const c = readLog(rec.id, b.nextOffset, dir);
		assert.equal(c.bytes.toString(), "second line\n");
		assert.equal(c.nextOffset, 23);

		// Byte offsets, not character offsets: a multi-byte character split across two reads
		// must survive being concatenated.
		fs.appendFileSync(file, "café ✓\n");
		const d = readLog(rec.id, c.nextOffset, dir);
		assert.equal(Buffer.concat([c.bytes, d.bytes]).toString("utf8"), "second line\ncafé ✓\n");

		// An unknown job is "nothing to show", not an exception.
		assert.equal(readLog("no-such-job", 0, dir).bytes.length, 0);
		// An offset past the end means the file was truncated or rotated under us: re-read
		// from the start rather than returning empty frames forever.
		const rewound = readLog(rec.id, 10_000, dir);
		assert.equal(rewound.bytes.toString(), fs.readFileSync(file, "utf8"));
		assert.equal(rewound.nextOffset, fs.statSync(file).size);
	});
});

test("resolveRunCommand__UsesNpxTsx__When__NotPackaged", () => {
	const cmd = resolveRunCommand("src/agent.ts", {});
	// Unchanged from what the Electron shell does today: no build step between an edit and a run.
	assert.deepEqual(cmd, { command: "npx", args: ["tsx", "src/agent.ts"] });
	assert.equal(isPackaged({}), false);
});

test("resolveRunCommand__UsesElectronAsNode__When__Packaged", () => {
	const env = { [PACKAGED_ENV]: "1" };
	const cmd = resolveRunCommand("src/explore.ts", env);
	// The same signed binary as the parent, so the child inherits the TCC grants; and the
	// machine needs no node, npm or tsx of its own.
	assert.equal(cmd.command, process.execPath);
	assert.deepEqual(cmd.args, [path.join(resourcesRoot(), "dist-electron", "src/explore.js")]);
	assert.equal(isPackaged(env), true);
});

test("childEnv__IncludesHomebrewPath__When__LaunchedFromLaunchd", () => {
	withTemp("yr-env-", (dir) => {
		// launchd's environment: a bare PATH, no key, no shell profile ever sourced.
		const env = childEnv({ runnerDir: dir, stamp: "2026-07-30T12-00-00-yarn", base: { PATH: "/usr/bin:/bin" } });
		const entries = (env.PATH ?? "").split(":");
		assert.equal(entries[0], "/opt/homebrew/bin");
		assert.equal(entries[1], "/usr/local/bin");
		// The inherited entries survive, in order, after the prepended ones.
		assert.deepEqual(entries.slice(2), ["/usr/bin", "/bin"]);
		// The job id reaches the child so its run log and recording land on the same key.
		assert.equal(env.RUN_STAMP, "2026-07-30T12-00-00-yarn");
		// paths.ts must not fall back to cwd, which is `/` under launchd.
		assert.ok(env.YARN_RUNNER_DATA);
		assert.ok(env.YARN_RUNNER_RESOURCES);
		assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
	});
});

test("childEnv__SuppliesTheApiKey__When__RunnerDirHasAnEnvFile", () => {
	withTemp("yr-env-", (dir) => {
		fs.writeFileSync(
			path.join(dir, "env"),
			"# the key launchd cannot inherit\nOPENROUTER_API_KEY='sk-or-secret'\nexport AGENT_MODEL=anthropic/claude-opus-5\n",
			{ mode: 0o600 },
		);
		const env = childEnv({ runnerDir: dir, stamp: "s", base: { PATH: "/usr/bin", OPENROUTER_API_KEY: "inherited" } });
		// The file wins: the point of setting a key per host is that it is the one used.
		assert.equal(env.OPENROUTER_API_KEY, "sk-or-secret");
		assert.equal(env.AGENT_MODEL, "anthropic/claude-opus-5");
	});
});

test("spawnDetached__WritesChildOutputToItsOwnLog__When__ChildIsDetached", async () => {
	await withTempAsync("yr-spawn-", async (dir) => {
		const rec = createJob({ id: "spawned", kind: "task", app: "Yarn", task: "t", operator: "dave" }, dir);
		const logFile = path.join(dir, rec.id, "log.txt");
		const spawned = spawnDetached(
			{ command: "/bin/sh", args: ["-c", "echo to-stdout; echo to-stderr 1>&2"] },
			{ logFile, env: { PATH: "/usr/bin:/bin" }, cwd: dir },
		);
		assert.ok(spawned.pid > 0);
		await waitFor("the child to write both streams", () => fs.readFileSync(logFile, "utf8").includes("to-stderr"));

		// The child owns the file, so the output survives the runner restarting — which is
		// exactly what the pipe-based spawn in RunController loses.
		const text = fs.readFileSync(logFile, "utf8");
		assert.match(text, /to-stdout/);
		assert.match(text, /to-stderr/);
		assert.equal(readLog(rec.id, 0, dir).bytes.length, text.length);
	});
});

/** Records what the runner would have spawned, so a submit can be tested without driving the Mac. */
function fakeSpawner(): { calls: Array<{ command: string; args: string[] }>; spawn: any } {
	const calls: Array<{ command: string; args: string[] }> = [];

	return {
		calls,
		spawn: (cmd: { command: string; args: string[] }, opts: { logFile: string }) => {
			calls.push(cmd);
			fs.appendFileSync(opts.logFile, "pretend agent output\n");
			// A long-lived stand-in for the agent: alive until the test kills it, which is what
			// makes the lease it holds a real one.
			const child = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
			child.unref();

			return { pid: child.pid as number, child };
		},
	};
}

/**
 * Like fakeSpawner, but creates the log directory first — as the real spawnDetached does. The
 * liveview verb spawns into out/jobs/liveview-<op>/, a dir that does not exist until the spawner
 * makes it; fakeSpawner appends without mkdir (fine for submit, which reuses an existing job dir).
 * The child exits on its own so nothing lingers after the test.
 */
function mkdirSpawner(): { calls: Array<{ command: string; args: string[] }>; spawn: any } {
	const calls: Array<{ command: string; args: string[] }> = [];

	return {
		calls,
		spawn: (cmd: { command: string; args: string[] }, opts: { logFile: string }) => {
			calls.push(cmd);
			fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
			fs.appendFileSync(opts.logFile, "pretend liveview server\n");
			const child = spawn("/bin/sh", ["-c", "sleep 1"], { detached: true, stdio: "ignore" });
			child.unref();

			return { pid: child.pid as number, child };
		},
	};
}

test("grant__AsksMacOSToRegisterTheApp__When__TheRunnerRunsUnderElectron", async () => {
	await withTempAsync("yr-grant-", async (dir) => {
		// Exists because of an asymmetry in System Settings: Accessibility has a `+` button and
		// Screen & System Audio Recording does not. That pane lists only processes that have
		// CALLED for access, so a runner which merely reads its permissions never appears there
		// and an operator has no row to tick. Hit for real on all three Macs, 2026-07-30.
		const perms = { accessibility: false, screenRecording: false };
		let asked = 0;
		const runner = await startRunner(dir, {
			...noSwap,
			log: () => {},
			permissions: () => perms,
			requestPermissions: async () => {
				asked++;

				return perms;
			},
		});
		try {
			const [res] = await request(runner.socketPath, "grant");
			assert.equal(res.ok, true);
			assert.equal(asked, 1, "the prompting call must actually be made");
			// Still false afterwards, and that is the CORRECT answer rather than a failure: only a
			// human can flip a SIP-protected switch, and macOS does not hand a new Screen Recording
			// grant to an already-running process. Reporting it as a failed call would send an
			// operator looking for a bug instead of at System Settings.
			assert.deepEqual(res.permissions, perms);
			assert.equal(res.needsRestart, true);
			assert.match(res.hint, /launchctl kickstart -k/);
		} finally {
			await runner.close();
		}
	});
});

// --- stale grants. mac1 graded "ready" — getMediaAccessStatus reads the TCC database — while
// the live process still could not capture, because macOS resolves Screen Recording once at
// launch. The run came back TargetNotObservableError, steps 0, frames 0: the shape of a broken
// agent, not of a stale process. Fixed by hand with launchctl kickstart on 2026-07-30.

test("staleGrants__NamesThePermission__When__ItWasGrantedAfterBoot", () => {
	const boot = { accessibility: true, screenRecording: false };
	assert.deepEqual(staleGrants(boot, { accessibility: true, screenRecording: true }), ["Screen Recording"]);
	assert.deepEqual(
		staleGrants({ accessibility: false, screenRecording: false }, { accessibility: true, screenRecording: true }),
		["Accessibility", "Screen Recording"],
	);
});

test("staleGrants__ReturnsNothing__When__TheGrantWasAlreadyThereAtBoot", () => {
	const both = { accessibility: true, screenRecording: true };
	assert.deepEqual(staleGrants(both, both), []);
});

test("staleGrants__ReturnsNothing__When__ThePermissionIsStillMissing", () => {
	// An ungranted permission is an ordinary problem, already reported as one. Listing it here
	// too would tell an operator to restart a process that a restart cannot help.
	const none = { accessibility: false, screenRecording: false };
	assert.deepEqual(staleGrants(none, none), []);
});

test("staleGrants__ReturnsNothing__When__ThereIsNoPermissionProbe", () => {
	// Under tsx and in tests nothing injects one; a missing probe is unknown, not stale.
	assert.deepEqual(staleGrants(undefined, { accessibility: true, screenRecording: true }), []);
});

test("status__ReportsTccNotOk__When__AGrantLandedAfterTheRunnerStarted", async () => {
	await withTempAsync("yr-stale-", async (dir) => {
		// Flipped between startRunner and the request, which is exactly what an operator ticking
		// the box in System Settings does to a live runner.
		const perms = { accessibility: false, screenRecording: false };
		const runner = await startRunner(dir, { ...noSwap, log: () => {}, permissions: () => ({ ...perms }) });
		try {
			perms.screenRecording = true;
			perms.accessibility = true;
			const [res] = await request(runner.socketPath, "status");
			// Both permissions read as granted, and the host is still not demo-ready. That gap is
			// the entire bug: without it this host advertises itself as usable.
			assert.deepEqual(res.permissions, { accessibility: true, screenRecording: true });
			assert.equal(res.tccOk, false);
			assert.deepEqual(res.staleGrants, ["Accessibility", "Screen Recording"]);

			const [report] = await request(runner.socketPath, "doctor");
			assert.deepEqual(report.staleGrants, ["Accessibility", "Screen Recording"]);
		} finally {
			await runner.close();
		}
	});
});

test("restart__Refuses__When__NothingWouldBringTheRunnerBack", async () => {
	await withTempAsync("yr-restart-", async (dir) => {
		// A hand-started runner has no KeepAlive behind it, so exiting would silently drop the
		// host out of the fleet — worse than the stale grant it was meant to fix.
		const was = process.env.XPC_SERVICE_NAME;
		delete process.env.XPC_SERVICE_NAME;
		let exited = 0;
		const runner = await startRunner(dir, { ...noSwap, log: () => {}, exit: () => exited++ });
		try {
			const [res] = await request(runner.socketPath, "restart");
			assert.equal(res.ok, false);
			assert.match(res.error, /not started by launchd/);
			assert.equal(exited, 0);
		} finally {
			await runner.close();
			if (was !== undefined) process.env.XPC_SERVICE_NAME = was;
		}
	});
});

test("restart__Refuses__When__AJobIsInFlight", async () => {
	await withTempAsync("yr-restart-", async (dir) => {
		const runner = await startRunner(dir, { ...noSwap, log: () => {}, exit: () => {}, spawn: fakeSpawner().spawn });
		try {
			const [submitted] = await request(runner.socketPath, "submit", { kind: "task", app: "Anything", task: "show me how to change a setting", operator: "test" });
			assert.equal(submitted.ok, true);
			const [res] = await request(runner.socketPath, "restart", { force: false });
			assert.equal(res.ok, false);
			// Names the run in the way, because "busy" alone leaves the operator guessing whether
			// to wait or to go stop something.
			assert.match(res.error, new RegExp(submitted.jobId));
		} finally {
			await runner.close();
		}
	});
});

test("restart__Exits__When__LaunchdOwnsTheProcess", async () => {
	await withTempAsync("yr-restart-", async (dir) => {
		const was = process.env.XPC_SERVICE_NAME;
		process.env.XPC_SERVICE_NAME = "com.yarn.runner";
		let exited = 0;
		const runner = await startRunner(dir, { ...noSwap, log: () => {}, exit: () => exited++ });
		try {
			const [res] = await request(runner.socketPath, "restart");
			assert.equal(res.ok, true);
			assert.equal(res.restarting, true);
			// The reply has to reach the client BEFORE the process goes, so the exit is deferred.
			assert.equal(exited, 0, "exiting before replying would look like a dropped connection");
			await new Promise((r) => setTimeout(r, 400));
			assert.equal(exited, 1);
		} finally {
			await runner.close();
			if (was === undefined) delete process.env.XPC_SERVICE_NAME;
			else process.env.XPC_SERVICE_NAME = was;
		}
	});
});

test("grant__SaysThereIsNothingToAskWith__When__TheRunnerIsNotUnderElectron", async () => {
	await withTempAsync("yr-grant-", async (dir) => {
		// Under tsx there is no app bundle for macOS to register, so the honest answer is that
		// this runner cannot ask — not a silent success that leaves the pane just as empty.
		const runner = await startRunner(dir, { ...noSwap, log: () => {} });
		try {
			const [res] = await request(runner.socketPath, "grant");
			assert.equal(res.ok, false);
			assert.match(res.error, /not running under Electron/);
		} finally {
			await runner.close();
		}
	});
});

async function request(socketPath: string, method: string, params: Record<string, unknown> = {}): Promise<any[]> {
	const conn = net.createConnection({ path: socketPath });
	const out: any[] = [];
	await new Promise<void>((resolve, reject) => {
		conn.once("error", reject);
		conn.once("connect", () => resolve());
	});
	conn.write(`${JSON.stringify({ method, params })}\n`);
	let buffer = "";
	for await (const chunk of conn) {
		buffer += (chunk as Buffer).toString("utf8");
		let nl: number;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			if (line.trim()) out.push(JSON.parse(line));
		}
	}

	return out;
}

test("startRunner__ReportsIdle__When__NoLeaseIsHeld", async () => {
	await withTempAsync("yr-serve-", async (dir) => {
		const runner = await startRunner(dir, { ...noSwap, log: () => {} });
		try {
			const [res] = await request(runner.socketPath, "status");
			// Exactly the shape src/remote/fleet.ts parses.
			assert.equal(res.ok, true);
			assert.equal(res.state, "idle");
			// The directory is the access control: Node creates the socket 0755 and there is a
			// bind-then-chmod race, so the mode that matters is the one on the parent.
			assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
		} finally {
			await runner.close();
		}
		// The socket must not survive: a leftover path makes every later bind fail EADDRINUSE.
		assert.equal(fs.existsSync(path.join(dir, "run.sock")), false);
	});
});

test("startRunner__RemovesStaleSocket__When__APreviousRunnerWasKilled", async () => {
	await withTempAsync("yr-serve-", async (dir) => {
		fs.writeFileSync(path.join(dir, "run.sock"), "leftover from a killed runner");
		const runner = await startRunner(dir, { ...noSwap, log: () => {} });
		try {
			const [res] = await request(runner.socketPath, "status");
			assert.equal(res.state, "idle");
		} finally {
			await runner.close();
		}
	});
});

test("startRunner__RefusesToStart__When__AnotherRunnerHoldsTheSocket", async () => {
	await withTempAsync("yr-serve-", async (dir) => {
		// The dangerous shape, and the reason the stale-socket cleanup probes instead of just
		// unlinking: launchd's KeepAlive plus a manual start puts two runners here at once. An
		// unconditional rm would let the second one unlink the first's socket and bind its own,
		// leaving the original serving a path no client can reach while still holding the lease.
		const first = await startRunner(dir, { ...noSwap, log: () => {} });
		try {
			await assert.rejects(startRunner(dir, { ...noSwap, log: () => {} }), /already listening/);
			// And the incumbent is untouched — the point of refusing.
			const [res] = await request(first.socketPath, "status");
			assert.equal(res.state, "idle");
		} finally {
			await first.close();
		}
	});
});

test("submit__ReturnsJobIdImmediately__When__HostIsIdle", async () => {
	await withTempAsync("yr-serve-", async (dir) => {
		const prevData = process.env.YARN_RUNNER_DATA;
		process.env.YARN_RUNNER_DATA = dir;
		const spawner = fakeSpawner();
		const runner = await startRunner(dir, { ...noSwap, log: () => {}, spawn: spawner.spawn });
		let pid = 0;
		try {
			const [res] = await request(runner.socketPath, "submit", {
				kind: "task",
				app: "Yarn",
				task: "show me how to change the cursor type",
				operator: "dave",
			});
			assert.equal(res.ok, true);
			assert.match(res.jobId, /-yarn$/);
			pid = res.pid;

			// The task text reaches the agent verbatim — no rewriting, no second copy of the
			// prompt-hygiene rule on this side of the wire.
			assert.deepEqual(spawner.calls[0].args.slice(-2), ["show me how to change the cursor type", "Yarn"]);

			// Busy the instant submit returns, and busy against the CHILD's pid.
			const [status] = await request(runner.socketPath, "status");
			assert.equal(status.state, "busy");
			assert.equal(status.operator, "dave");
			assert.equal(status.app, "Yarn");
			assert.equal(inspect(dir).holder?.lease.pid, pid);

			const [refused] = await request(runner.socketPath, "submit", {
				kind: "explore",
				app: "Yarn",
				operator: "sam",
			});
			assert.equal(refused.ok, false);
			assert.equal(refused.busy, true);
			assert.match(String(refused.error), /^busy: dave, task Yarn/);
			assert.equal(spawner.calls.length, 1, "a refused submit spawns nothing");

			const [logs] = await request(runner.socketPath, "logs", { jobId: res.jobId });
			assert.equal(Buffer.from(logs.chunk, "base64").toString(), "pretend agent output\n");
		} finally {
			if (pid) try { process.kill(-pid, "SIGKILL"); } catch {}
			await runner.close();
			if (prevData === undefined) delete process.env.YARN_RUNNER_DATA;
			else process.env.YARN_RUNNER_DATA = prevData;
		}
	});
});

/**
 * The operator has no stored profile for this app, so it starts factory-fresh and the readiness
 * check is about to refuse. Saying so in the submit reply is what turns "the run failed" into
 * "run ./run signin first" without anyone reading a log.
 */
test("submit__PredictsASignin__When__TheOperatorHasNoProfileForThatApp", async () => {
	await withTempAsync("yr-serve-", async (dir) => {
		const spawner = fakeSpawner();
		const runner = await startRunner(dir, {
			log: () => {},
			spawn: spawner.spawn,
			swap: async (app, operator) => ({ action: "swapped", app, operator, previousOwner: "alice", stashed: ["Library/Application Support/Yarn"], restored: [], fresh: true }),
		});
		let pid = 0;
		try {
			const [res] = await request(runner.socketPath, "submit", { kind: "task", app: "Yarn", task: "show me how to change the cursor type", operator: "bob" });
			assert.equal(res.ok, true);
			assert.equal(res.signinNeeded, true);
			assert.match(String(res.profile), /alice → bob/);
			pid = res.pid;
		} finally {
			if (pid) try { process.kill(-pid, "SIGKILL"); } catch {}
			await runner.close();
		}
	});
});

/** A returning operator gets their own data back and must not be told to sign in again. */
test("submit__SaysNothingAboutSignin__When__TheOperatorAlreadyOwnsTheApp", async () => {
	await withTempAsync("yr-serve-", async (dir) => {
		const spawner = fakeSpawner();
		const runner = await startRunner(dir, { ...noSwap, log: () => {}, spawn: spawner.spawn });
		let pid = 0;
		try {
			const [res] = await request(runner.socketPath, "submit", { kind: "task", app: "Yarn", task: "show me how to change the cursor type", operator: "dave" });
			assert.equal(res.signinNeeded, undefined);
			pid = res.pid;
		} finally {
			if (pid) try { process.kill(-pid, "SIGKILL"); } catch {}
			await runner.close();
		}
	});
});

/** open is injected wherever the liveview/signin verbs run, so the suite never launches a real app. */
const noOpen = { open: async () => {} };

/**
 * The liveview verb foregrounds the app under the operator's profile and starts the capture server
 * as a runner-spawned child — the whole point being that a bare SSH shell cannot capture (measured
 * on mac1, 2026-07-30), so the grant-holding runner has to launch it. The reply must carry a port
 * and a token, because the operator's `ssh -L` tunnel and viewer URL are built from them.
 */
test("liveview__StartsTheServerAndReturnsPortAndToken__When__TheHostIsFree", async () => {
	await withTempAsync("yr-serve-", async (dir) => {
		// The verb passes logFile: out/jobs/liveview-<op>/log.txt and relies on the spawner to
		// create the directory, exactly as the real spawnDetached does (fakeSpawner appends without
		// mkdir, which the real one never would).
		const spawner = mkdirSpawner();
		const runner = await startRunner(dir, { ...noSwap, ...noOpen, log: () => {}, spawn: spawner.spawn });
		try {
			const [res] = await request(runner.socketPath, "liveview", { app: "Yarn", operator: "dave" });
			assert.equal(res.ok, true);
			assert.equal(typeof res.port, "number");
			assert.match(String(res.token), /^[A-Za-z0-9_-]{16,}$/);
			assert.equal(res.url, `http://127.0.0.1:${res.port}/?t=${res.token}`);
			// The server was actually spawned (as a child of the runner, which holds the grants).
			assert.equal(spawner.calls.length, 1);
		} finally {
			await runner.close();
		}
	});
});

/** A run in flight means a recording is capturing; a login stream would capture over it. Refuse. */
test("liveview__Refuses__When__ARunHoldsTheLease", async () => {
	await withTempAsync("yr-serve-", async (dir) => {
		const spawner = fakeSpawner();
		const runner = await startRunner(dir, { ...noSwap, ...noOpen, log: () => {}, spawn: spawner.spawn });
		let pid = 0;
		try {
			const [run] = await request(runner.socketPath, "submit", { kind: "task", app: "Yarn", task: "show me how to change the cursor type", operator: "sam" });
			pid = run.pid;
			const [res] = await request(runner.socketPath, "liveview", { app: "Yarn", operator: "dave" });
			assert.equal(res.ok, false);
			assert.equal(res.busy, true);
			assert.equal(res.operator, "sam");
			// Only the run was spawned; no liveview server came up on top of it.
			assert.equal(spawner.calls.length, 1);
		} finally {
			if (pid) try { process.kill(-pid, "SIGKILL"); } catch {}
			await runner.close();
		}
	});
});

/** A swap that throws must not be followed by a launch — the sign-in would land in the wrong data. */
test("liveview__RefusesAndDoesNotSpawn__When__TheProfileSwapFails", async () => {
	await withTempAsync("yr-serve-", async (dir) => {
		const spawner = fakeSpawner();
		const runner = await startRunner(dir, {
			log: () => {},
			...noOpen,
			spawn: spawner.spawn,
			swap: async () => {
				throw new Error("could not move ~/Library/Application Support/Yarn");
			},
		});
		try {
			const [res] = await request(runner.socketPath, "liveview", { app: "Yarn", operator: "dave" });
			assert.equal(res.ok, false);
			assert.match(String(res.error), /could not give dave their own data/);
			assert.equal(spawner.calls.length, 0);
		} finally {
			await runner.close();
		}
	});
});

test("liveview__RequiresAnApp__When__NoneGiven", async () => {
	await withTempAsync("yr-serve-", async (dir) => {
		const runner = await startRunner(dir, { ...noSwap, ...noOpen, log: () => {} });
		try {
			const [res] = await request(runner.socketPath, "liveview", { operator: "dave" });
			assert.equal(res.ok, false);
			assert.match(String(res.error), /app is required/);
		} finally {
			await runner.close();
		}
	});
});

/**
 * A half-done swap can leave the previous operator's session live, so the run must not happen —
 * and the Mac must not be left leased to a job that never started.
 */
test("submit__RefusesAndFreesTheHost__When__TheProfileSwapFails", async () => {
	await withTempAsync("yr-serve-", async (dir) => {
		const spawner = fakeSpawner();
		const runner = await startRunner(dir, {
			log: () => {},
			spawn: spawner.spawn,
			swap: async () => { throw new Error(`"Yarn" would not quit`); },
		});
		try {
			const [res] = await request(runner.socketPath, "submit", { kind: "task", app: "Yarn", task: "show me how to change the cursor type", operator: "bob" });
			assert.equal(res.ok, false);
			assert.match(String(res.error), /could not give bob their own data in Yarn/);
			assert.equal(spawner.calls.length, 0, "no agent may run against another operator's session");

			const [status] = await request(runner.socketPath, "status");
			assert.equal(status.state, "idle", "a refused swap must not strand the lease");
		} finally {
			await runner.close();
		}
	});
});

/**
 * createJob sits between acquire() and the spawn, and its registry write can fail on its own —
 * ENOSPC, EACCES, or (here) something squatting on the jobs directory. The lease it would
 * strand names pid=<the runner>, which is always alive, so reap() could never reclaim it and
 * the Mac would advertise busy until someone restarted the runner.
 */
test("submit__FreesTheHost__When__TheJobRegistryWriteFails", async () => {
	await withTempAsync("yr-serve-", async (dir) => {
		const prevData = process.env.YARN_RUNNER_DATA;
		process.env.YARN_RUNNER_DATA = dir;
		const spawner = fakeSpawner();
		try {
			const runner = await startRunner(dir, { ...noSwap, log: () => {}, spawn: spawner.spawn });
			try {
				// A file where the jobs directory should go: createJob's mkdir throws the way a
				// full disk would — after the lease is taken, before any child exists.
				fs.mkdirSync(path.join(dir, "out"), { recursive: true });
				fs.writeFileSync(path.join(dir, "out", "jobs"), "not a directory");

				const [res] = await request(runner.socketPath, "submit", { kind: "task", app: "Yarn", task: "t", operator: "dave" });
				assert.equal(res.ok, false);
				assert.equal(spawner.calls.length, 0, "nothing may spawn without a registry record");

				const [status] = await request(runner.socketPath, "status");
				assert.equal(status.state, "idle", "a failed registry write must not strand the lease");
			} finally {
				await runner.close();
			}
		} finally {
			if (prevData === undefined) delete process.env.YARN_RUNNER_DATA;
			else process.env.YARN_RUNNER_DATA = prevData;
		}
	});
});

test("submit__RecordsACrashAsFailed__When__TheChildDiesToAnUnrequestedSignal", async () => {
	await withTempAsync("yr-serve-", async (dir) => {
		const prevData = process.env.YARN_RUNNER_DATA;
		process.env.YARN_RUNNER_DATA = dir;
		try {
			const runner = await startRunner(dir, { ...noSwap, log: () => {}, spawn: fakeSpawner().spawn });
			try {
				const [res] = await request(runner.socketPath, "submit", { kind: "task", app: "Yarn", task: "t", operator: "dave" });
				assert.equal(res.ok, true);

				// Nobody called stop. This is the SIGSEGV/OOM-kill shape, and recording it as
				// "stopped" would file a crash under an operator's decision.
				process.kill(res.pid, "SIGTERM");
				const root = path.join(dir, "out", "jobs");
				await waitFor("the exit to be finalised", () => readJob(res.jobId, root)?.state !== "running");
				const rec = readJob(res.jobId, root);
				assert.equal(rec?.state, "failed");
				assert.equal(rec?.signal, "SIGTERM", "the record has to name which crash it was");
			} finally {
				await runner.close();
			}
		} finally {
			if (prevData === undefined) delete process.env.YARN_RUNNER_DATA;
			else process.env.YARN_RUNNER_DATA = prevData;
		}
	});
});

test("submit__IsRejected__When__AFlagArrivesAsSomethingOtherThanABoolean", async () => {
	await withTempAsync("yr-serve-", async (dir) => {
		const spawner = fakeSpawner();
		const runner = await startRunner(dir, { ...noSwap, log: () => {}, spawn: spawner.spawn });
		try {
			// The string "false" is truthy. Boolean() was here, so a client that stringified its
			// flags — a shell wrapper, a curl, a second implementation of this protocol — used to
			// get a run with vision switched OFF while asking for it on. That degrades the agent's
			// perception silently and the run still reports success, so it is a measurement bug.
			const bad: Record<string, unknown>[] = [
				{ kind: "task", app: "Yarn", task: "t", noVision: "false" },
				{ kind: "task", app: "Yarn", task: "t", record: "true" },
				{ kind: "task", app: "Yarn", task: "t", record: 1 },
				{ kind: "wander", app: "Yarn", task: "t" },
			];
			for (const params of bad) {
				const [res] = await request(runner.socketPath, "submit", params);
				assert.equal(res.ok, false, `${JSON.stringify(params)} should be refused`);
				// Refused BEFORE the lease is taken. A validation branch that returns after
				// acquire() leaves the Mac permanently busy with no run on it.
				assert.equal(inspect(dir).holder, undefined, `${JSON.stringify(params)} left the lease held`);
			}
			assert.equal(spawner.calls.length, 0, "nothing was spawned");

			// Absent is the honest false, and must still be accepted.
			const [ok] = await request(runner.socketPath, "submit", { kind: "task", app: "Yarn", task: "t", operator: "dave" });
			assert.equal(ok.ok, true);
			assert.equal(spawner.calls[0].args.includes("--no-vision"), false);
			assert.equal(spawner.calls[0].args.includes("--record"), false);
			if (ok.pid) try { process.kill(-ok.pid, "SIGKILL"); } catch {}
		} finally {
			await runner.close();
		}
	});
});

test("submit__IsRejected__When__AppIsMissing", async () => {
	await withTempAsync("yr-serve-", async (dir) => {
		const runner = await startRunner(dir, { ...noSwap, log: () => {}, spawn: fakeSpawner().spawn });
		try {
			const [res] = await request(runner.socketPath, "submit", { kind: "task", task: "do a thing" });
			assert.equal(res.ok, false);
			assert.match(res.error, /app is required/);
			assert.equal(inspect(dir).holder, undefined, "a rejected submit leaves the host idle");
		} finally {
			await runner.close();
		}
	});
});

test("parseArgs__DecodesSpec__When__TaskTextWouldBeShellSyntax", () => {
	// The exact hazard --spec exists for: sshd joins remote argv into one string and the login
	// shell re-splits it, so this task text as an argument would be three commands.
	const task = `show me how to "change" the cursor; rm -rf $HOME && echo 'oops'`;
	const spec = Buffer.from(JSON.stringify({ kind: "task", app: "Yarn", task }), "utf8").toString("base64");
	// base64's alphabet has nothing a shell reacts to, which is the property being relied on.
	assert.match(spec, /^[A-Za-z0-9+/=]+$/);

	const parsed = parseArgs(["submit", "--json", "--spec", spec], "/tmp/yr-not-used");
	assert.ok(!("error" in parsed));
	if ("error" in parsed) return;
	assert.equal(parsed.method, "submit");
	assert.equal(parsed.params.task, task);
	assert.equal(parsed.json, true);

	assert.deepEqual(parseArgs(["submit", "--spec", "not-base64-json"], "/tmp/x"), {
		error: "--spec was not base64-encoded JSON",
	});
	assert.ok("error" in parseArgs(["rm", "-rf", "/"], "/tmp/x"));
});

/**
 * Invoke the real CLI as a child process rather than calling `main` in-process. Capturing
 * output by patching `process.stdout.write` would also capture the test runner's own
 * reporter stream, which shares that descriptor — and this way the exit code, the
 * argv handling and the entrypoint guard are all exercised as SSH will exercise them.
 */
function runCtl(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("npx", ["tsx", "src/runner/ctl.ts", ...argv], { cwd: resourcesRoot() });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
	});
}

test("ctl__PrintsStatusJson__When__RunnerIsListening", async () => {
	await withTempAsync("yr-ctl-", async (dir) => {
		const runner = await startRunner(dir, { ...noSwap, log: () => {} });
		try {
			const res = await runCtl(["status", "--json", "--socket", runner.socketPath]);
			assert.equal(res.code, 0);
			// One JSON object on stdout, which is what fleetStatus parses.
			assert.equal(JSON.parse(res.stdout).state, "idle");
		} finally {
			await runner.close();
		}
	});
});

test("ctl__ExitsUnreachable__When__NoRunnerIsListening", async () => {
	await withTempAsync("yr-ctl-", async (dir) => {
		const res = await runCtl(["status", "--json", "--socket", path.join(dir, "absent.sock")]);
		// Distinct from exit 1: "the LaunchAgent is not loaded" is a different row in the
		// fleet table from "the runner answered no".
		assert.equal(res.code, 3);
		assert.match(res.stderr, /cannot reach the runner/);
		assert.equal(res.stdout, "");
	});
});

test("startRunner__ReportsUnknownMethod__When__RequestIsNotAMethod", async () => {
	await withTempAsync("yr-serve-", async (dir) => {
		const runner = await startRunner(dir, { ...noSwap, log: () => {} });
		try {
			const [res] = await request(runner.socketPath, "nonsense");
			assert.equal(res.ok, false);
			assert.match(res.error, /unknown method/);
			// Still serving: one bad request must not take down the process holding the grants.
			const [after] = await request(runner.socketPath, "status");
			assert.equal(after.state, "idle");
		} finally {
			await runner.close();
		}
	});
});

test("startRunner__KeepsTheTaskTextIntact__When__AChunkBoundarySplitsACharacter", async () => {
	await withTempAsync("yr-serve-", async (dir) => {
		const spawner = fakeSpawner();
		const runner = await startRunner(dir, { ...noSwap, log: () => {}, spawn: spawner.spawn });
		let pid = 0;
		try {
			const task = "café ✓ — change the cursor";
			const payload = Buffer.from(
				`${JSON.stringify({ method: "submit", params: { kind: "task", app: "Yarn", task, operator: "dave" } })}\n`,
				"utf8",
			);
			// Cut INSIDE the é. Decoding each chunk independently turns both halves into U+FFFD,
			// and the run would execute — and report success — against corrupted task text.
			const cut = payload.indexOf(Buffer.from("é", "utf8")) + 1;
			const conn = net.createConnection({ path: runner.socketPath });
			await new Promise<void>((resolve, reject) => {
				conn.once("error", reject);
				conn.once("connect", () => resolve());
			});
			conn.write(payload.subarray(0, cut));
			await new Promise((r) => setTimeout(r, 25));
			conn.write(payload.subarray(cut));
			let buffer = "";
			for await (const chunk of conn) buffer += (chunk as Buffer).toString("utf8");
			const res = JSON.parse(buffer.trim().split("\n")[0]);
			assert.equal(res.ok, true);
			pid = res.pid;
			assert.equal(spawner.calls[0].args.slice(-2)[0], task);
		} finally {
			if (pid) try { process.kill(-pid, "SIGKILL"); } catch {}
			await runner.close();
		}
	});
});

test("startRunner__RefusesTheRequest__When__ItGrowsWithoutANewline", async () => {
	await withTempAsync("yr-serve-", async (dir) => {
		const runner = await startRunner(dir, { ...noSwap, log: () => {} });
		try {
			const conn = net.createConnection({ path: runner.socketPath });
			await new Promise<void>((resolve, reject) => {
				conn.once("error", reject);
				conn.once("connect", () => resolve());
			});
			// One byte past the cap and no newline anywhere: not a request, just growth. The
			// runner must answer with an error frame and stop buffering, not hold it all.
			conn.write(Buffer.alloc((1 << 20) + 1, 0x61));
			let buffer = "";
			for await (const chunk of conn) buffer += (chunk as Buffer).toString("utf8");
			assert.match(buffer, /exceeded/);

			// Still serving: the oversized peer cost itself its connection, nothing more.
			const [after] = await request(runner.socketPath, "status");
			assert.equal(after.state, "idle");
		} finally {
			await runner.close();
		}
	});
});
