import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonOr } from "../../fsutil.js";
import { type JobKind, pidAlive } from "./jobs.js";

/**
 * One run at a time, per Mac.
 *
 * This is a mutex, deliberately. A second driver session shuts down the shared daemon and
 * kills the run already in flight (LIMITATIONS §6) — the damage lands on the run that was
 * already working, so the only safe answer to "start another NOW" is no. The UI's
 * single-run guard in `RunController` says the same thing; this is that guard promoted to a
 * file, because the claimants are now separate SSH invocations rather than clicks in one
 * process. The job QUEUE (serve.ts `drain`, `queued` records in the registry) is not an
 * exception to this: queued jobs wait their turn for this same mutex, one claim at a time.
 *
 * **Validity is liveness, never a TTL.** A lease expiring on a clock is wrong in both
 * directions and there is no interval that isn't: too short and a grounding pass loses its
 * host at minute 40 of a legitimate multi-hour run, too long and a crashed job strands a
 * machine for the rest of the afternoon. The runner spawns the child and can simply ask the
 * kernel whether it is still there, which is knowledge, not an estimate.
 *
 * The file is created with `wx` rather than written after a read, so the check and the claim
 * are one syscall. Two operators racing over SSH is the expected case — `pickIdleHost` in
 * the fleet client is explicitly advisory and tells its callers to expect to lose — and a
 * read-then-write would hand both of them the same host.
 */

/** Override so tests never touch a real home directory. Also how the LaunchAgent relocates it. */
export const RUNNER_DIR_ENV = "YARN_RUNNER_DIR";

export function defaultRunnerDir(): string {
	return process.env[RUNNER_DIR_ENV] || path.join(os.homedir(), ".yarn-runner");
}

export interface Lease {
	jobId: string;
	operator: string;
	kind: JobKind;
	app: string;
	startedAt: string;
	/**
	 * The process whose death frees the host. Initially the runner's own pid, because the
	 * claim has to be atomic BEFORE the child exists; `adopt()` hands it to the child as soon
	 * as there is one. That handover matters: a detached job survives a runner restart, and a
	 * lease pinned to the runner would declare the host idle while a run was still driving it.
	 */
	pid: number;
}

export interface LeaseHolder {
	lease: Lease;
	heldSec: number;
}

export type AcquireResult =
	| { ok: true; lease: Lease; reclaimed?: Lease }
	| { ok: false; holder: LeaseHolder; reason: string };

const LEASE_NAME = "lease.json";

function leasePath(runnerDir: string): string {
	return path.join(runnerDir, LEASE_NAME);
}

function readLease(runnerDir: string): Lease | undefined {
	const l = readJsonOr<Lease | undefined>(leasePath(runnerDir), undefined);

	return typeof l?.jobId === "string" && typeof l?.pid === "number" ? l : undefined;
}

function holderOf(lease: Lease): LeaseHolder {
	const started = Date.parse(lease.startedAt);

	return { lease, heldSec: Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0 };
}

/** `busy: dave, explore Yarn, 14m` — a refusal has to say who and how long, or it is unactionable. */
export function describeHolder(h: LeaseHolder): string {
	return `busy: ${h.lease.operator}, ${h.lease.kind} ${h.lease.app}, ${duration(h.heldSec)}`;
}

function duration(sec: number): string {
	if (sec < 60) return `${sec}s`;
	if (sec < 3600) return `${Math.floor(sec / 60)}m`;

	return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}m`;
}

/**
 * Claim the host, or report who has it.
 *
 * Reclamation of a dead holder's lease is automatic but never silent — it comes back in
 * `reclaimed` so the caller can log it. A host quietly freeing itself is how you end up
 * unable to explain, a week later, why two runs appear to have overlapped.
 */
export function acquire(lease: Lease, runnerDir = defaultRunnerDir()): AcquireResult {
	fs.mkdirSync(runnerDir, { recursive: true, mode: 0o700 });
	const file = leasePath(runnerDir);
	let reclaimed: Lease | undefined;

	// Two passes at most: claim, and if the existing lease turns out to be dead, claim again
	// after removing it. A third would mean someone is winning the race repeatedly, which is
	// a refusal rather than something to keep retrying.
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = fs.openSync(file, "wx", 0o600);
			try {
				fs.writeFileSync(fd, `${JSON.stringify(lease, null, 2)}\n`);
			} finally {
				fs.closeSync(fd);
			}

			return { ok: true, lease, ...(reclaimed ? { reclaimed } : {}) };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}

		const existing = readLease(runnerDir);
		if (existing && pidAlive(existing.pid)) {
			const holder = holderOf(existing);

			return { ok: false, holder, reason: describeHolder(holder) };
		}
		// Unparseable counts as stale: a lease we cannot read cannot be proven live, and the
		// alternative is a corrupt file locking the machine out until someone SSHes in.
		if (existing) reclaimed = existing;
		fs.rmSync(file, { force: true });
	}

	const existing = readLease(runnerDir);
	const holder = holderOf(existing ?? lease);

	return { ok: false, holder, reason: `${describeHolder(holder)} (lost the claim race)` };
}

/**
 * Hand the lease to the child now that it exists. Separate from `acquire` because the claim
 * must precede the spawn — see the note on `Lease.pid`.
 */
export function adopt(jobId: string, pid: number, runnerDir = defaultRunnerDir()): boolean {
	const existing = readLease(runnerDir);
	if (!existing || existing.jobId !== jobId) return false;
	fs.writeFileSync(leasePath(runnerDir), `${JSON.stringify({ ...existing, pid }, null, 2)}\n`, { mode: 0o600 });

	return true;
}

/**
 * Release, scoped to a job id when one is given. The scoping is what stops a late exit
 * handler for a finished run from freeing the host out from under the run that replaced it.
 */
export function release(runnerDir = defaultRunnerDir(), jobId?: string): boolean {
	const existing = readLease(runnerDir);
	if (!existing) return false;
	if (jobId !== undefined && existing.jobId !== jobId) return false;
	fs.rmSync(leasePath(runnerDir), { force: true });

	return true;
}

/**
 * Who holds the host right now. `stale` is reported rather than acted on, so a read-only
 * status call stays read-only — reclamation belongs to `acquire` and `reclaimStale`, which
 * are the calls that can log it.
 */
export function inspect(runnerDir = defaultRunnerDir()): { holder?: LeaseHolder; stale?: Lease } {
	const existing = readLease(runnerDir);
	if (!existing) return {};

	return pidAlive(existing.pid) ? { holder: holderOf(existing) } : { stale: existing };
}

/** Startup reconciliation, paired with `sweepOrphans`: drop a lease whose holder is gone. */
export function reclaimStale(runnerDir = defaultRunnerDir()): Lease | undefined {
	const { stale } = inspect(runnerDir);
	if (!stale) return undefined;
	fs.rmSync(leasePath(runnerDir), { force: true });

	return stale;
}
