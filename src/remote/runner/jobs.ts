import fs from "node:fs";
import path from "node:path";
import { appSlug, mintRunKey } from "../../core/harness.js";
import { readJsonOr } from "../../fsutil.js";
import { outDir } from "../../paths.js";

/**
 * Durable record of every run a Mac has been asked to perform.
 *
 * The registry exists because the run outlives the thing that asked for it. An operator
 * submits over SSH and disconnects; a multi-hour grounding pass keeps going; the runner
 * itself may be restarted or the machine rebooted underneath it. Anything held only in the
 * serve process's memory is therefore lost exactly when it is most needed — which is the
 * failure the shell has today, where restarting Electron keeps the child alive but throws
 * away every line it ever printed.
 *
 * Two properties follow from that and shape everything below:
 *
 * - **Writes are atomic.** A `status` poll can land at any instant, including between the
 *   truncate and the write of a plain `writeFileSync`. Same-directory temp file plus
 *   `rename` makes a half-written record unobservable rather than merely unlikely.
 * - **State is re-derived, never trusted.** A record saying `running` is a claim about a pid,
 *   and the honest way to check it is to ask the kernel. `sweepOrphans()` does that on
 *   startup so a killed runner leaves behind a registry that says `orphaned`, not one that
 *   lies about three jobs still being in flight.
 */

export type JobKind = "task" | "explore" | "replay";

/**
 * `orphaned` is deliberately distinct from `failed`: the run's own exit status is unknown
 * (nobody was there to collect it) and its artifacts may be complete, truncated, or absent.
 * Collapsing it into `failed` would assert something we did not observe.
 *
 * `queued` is a job accepted while another held the lease: no child exists yet (pid 0), and
 * the runner starts it when the lease frees. The record is durable like every other state,
 * which is what lets a queue survive a runner restart.
 */
export type JobState = "queued" | "running" | "done" | "failed" | "orphaned" | "stopped";

/**
 * Where a finished job's output landed, as paths relative to the data root — the same
 * convention run logs already use (`relToData`), and for the same reason: these are read on
 * another machine after the artifacts are pulled off the fleet, where an absolute path from
 * some colo Mac is noise at best.
 */
export interface JobArtifacts {
	/** Combined stdout+stderr of the child. Always present; the child owns this file. */
	log: string;
	/** `out/runs/<id>.json`, written by agent.ts (task) or recipe-cli.ts (replay). */
	runLog?: string;
	/**
	 * `out/runs/<id>.journal.jsonl`, the mutation journal a replay appends as it detects
	 * changes. Listed for replay jobs because the journal is what `npm run cleanup` replays
	 * after a crash — a pull that left it on the Mac would bring home a run log that says what
	 * happened and nothing that says what to undo. Absent from the disk when the replay
	 * changed nothing, which `pull` reports as `missing` rather than failed.
	 */
	journal?: string;
	/** `out/recording/<id>/window.mp4`. Only when the run was submitted with `record`. */
	recording?: string;
	/** `docs/appmaps/<slug>.md`, overwritten by a finished grounding pass. Explore only. */
	appmap?: string;
	/**
	 * `docs/appmaps/<slug>.json`, the graph half of the same pass. Listed separately and not
	 * inferred by a caller, because it is the file `findScopeAmbiguities()` reads: a pull that
	 * fetched only the prose would leave the agent's scope-collision warnings silently off and
	 * every subsequent run would look grounded while changing per-document overrides.
	 */
	appmapGraph?: string;
	/** Crash insurance written continuously by explore.ts, useful precisely when it dies. */
	checkpoint?: string;
}

export interface JobRecord {
	/** Also the run stamp — see `mintJobId`. */
	id: string;
	kind: JobKind;
	app: string;
	/** Verbatim task text. Never rewritten here: `auditTaskPrompt` in agent.ts stays the gate. */
	task: string;
	/** Who submitted it, for the busy message on a refused acquire. */
	operator: string;
	state: JobState;
	/** The child's pid, or 0 while the job is queued or in the instant before the spawn. */
	pid: number;
	startedAt: string;
	/**
	 * When the job entered the queue, set only for jobs that waited. `startedAt - queuedAt` is
	 * the wait, and the drain overwrites `startedAt` at spawn time so elapsed math stays honest.
	 */
	queuedAt?: string;
	endedAt?: string;
	/** Null when the child was signalled rather than exiting, or when nobody collected it. */
	exitCode?: number | null;
	/**
	 * The signal the child died to, when it died to one. Kept because an UNREQUESTED signal —
	 * a SIGSEGV, an OOM kill — is a `failed`, not a `stopped`, and the record has to say which
	 * crash it was or the distinction is unactionable.
	 */
	signal?: string;
	/**
	 * The submit flags, persisted because a queued job is spawned later — possibly by a
	 * different runner process after a restart — and the record is the only place the options
	 * survive. Absent on records written before the queue existed, which reads as false.
	 */
	record?: boolean;
	noVision?: boolean;
	/** `--backend` on the child argv (task and explore). Absent = the child CLI's own default. */
	backend?: "ax" | "cdp";
	/** Vision-only arm: `--no-ax` on the child argv. Task kind only; the agent CLI refuses invalid combos. */
	noAx?: boolean;
	/** `AXDOM=0` in the child's environment: the sidecar arm switched off. */
	axdomOff?: boolean;
	/** `NO_GROUNDING=1`: the child ignores its appmap — the ungrounded benchmark arm. */
	noGrounding?: boolean;
	/** `USE_RECIPE=1`: the child loads the curated docs/recipes/<app>.md notes tier. */
	useRecipe?: boolean;
	/** Replay only: the recipe file, relative to the data root — the same key on both machines. */
	recipe?: string;
	/** Replay only: `--no-rescue` — a broken step fails the replay, the unattended fleet posture. */
	noRescue?: boolean;
	/** Web target: `--url <url>` on the child argv. The app field stays the display label. */
	url?: string;
	/** `APPMAP_VARIANT=vision` in the child's environment: ground from the vision-variant map. */
	appmapVariant?: "vision";
	/** `AGENT_MODEL=<id>` in the child's environment. Absent = the child's default model. */
	model?: string;
	artifacts: JobArtifacts;
}

export interface JobInit {
	/**
	 * From `mintJobId`. Passed in rather than minted here because the lease is claimed under
	 * this id BEFORE anything touches the filesystem — a refused submit must not leave a job
	 * directory behind for a run that never started.
	 */
	id: string;
	kind: JobKind;
	app: string;
	task: string;
	operator: string;
	record?: boolean;
	noVision?: boolean;
	backend?: "ax" | "cdp";
	noAx?: boolean;
	axdomOff?: boolean;
	noGrounding?: boolean;
	useRecipe?: boolean;
	recipe?: string;
	noRescue?: boolean;
	url?: string;
	appmapVariant?: "vision";
	model?: string;
	/** Accepted behind a held lease: the record starts `queued` and the drain spawns it later. */
	queued?: boolean;
}

/** Job ids are used as path segments and arrive over a socket, so they are pattern-checked. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/**
 * The job id IS the run stamp, so `out/jobs/<id>/`, `out/runs/<id>.json` and
 * `out/recording/<id>/` are one key rather than three things to correlate by timestamp
 * proximity. The shapes here reproduce exactly what the two scripts build today —
 * `<stamp>-<slug>` for a task run, and explore's `explore-` prefix, which is why `kind`
 * is an input. Both honour `RUN_STAMP` so the child lands on the id we minted.
 *
 * Uniqueness rests on the lease: two runs on the same app cannot start in the same second
 * when only one may be in flight at a time.
 */
export function mintJobId(kind: JobKind, app: string): string {
	// The same prefixes the child scripts already stamp their artifacts with (explore.ts's
	// `explore-`, recipe-cli.ts's `replay-`), so the job id and the run key stay one string.
	const prefix = kind === "task" ? "" : `${kind}-`;
	// mintRunKey, never runKey: the runner is long-lived and mints an id per job. runKey
	// returns RUN_STAMP when it is set, and this process sets that variable on every child it
	// spawns — so a plist or a shell that exported it once would give every job on this Mac
	// the same id, the same directory and the same log.
	const id = mintRunKey(prefix, app);

	// The last line of defence between a remote operator's `app` string and a path segment.
	// appSlug is not a security boundary and was never written as one.
	return SAFE_ID.test(id) ? id : id.replace(/[^A-Za-z0-9._-]/g, "") || mintRunKey(prefix, "app");
}

export function jobsDir(): string {
	return `${outDir()}/jobs`;
}

export function jobDir(id: string, root = jobsDir()): string {
	return path.join(root, id);
}

export function logPath(id: string, root = jobsDir()): string {
	return path.join(root, id, "log.txt");
}

/**
 * Liveness, the only definition of "still running" this system uses.
 *
 * `EPERM` means the process exists and is not ours to signal — that is alive, and reading it
 * as dead would hand out a host that is busy. Non-positive pids are refused outright because
 * `kill(0, sig)` and `kill(-n, sig)` address process GROUPS: a placeholder pid reaching this
 * function must be a `false`, never a broadcast.
 */
export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);

		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Create the job directory and its log file, and record the job as running.
 *
 * The log file is created empty here rather than by the child, so that `logs --follow` can
 * attach to a job that has not yet printed anything without special-casing ENOENT.
 */
export function createJob(init: JobInit, root = jobsDir()): JobRecord {
	const id = init.id;
	if (!SAFE_ID.test(id)) throw new Error(`unsafe job id ${JSON.stringify(id)}`);
	const dir = jobDir(id, root);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "log.txt"), "", { flag: "a" });

	const now = new Date().toISOString();
	const rec: JobRecord = {
		id,
		kind: init.kind,
		app: init.app,
		task: init.task,
		operator: init.operator,
		state: init.queued ? "queued" : "running",
		// Filled in by the caller the moment the child exists. A crash in that window leaves
		// a pid of 0, which `pidAlive` reads as dead and the sweep resolves to `orphaned` —
		// the correct answer, since no child was ever confirmed.
		pid: 0,
		startedAt: now,
		...(init.queued ? { queuedAt: now } : {}),
		...(init.record ? { record: true } : {}),
		...(init.noVision ? { noVision: true } : {}),
		...(init.backend ? { backend: init.backend } : {}),
		...(init.noAx ? { noAx: true } : {}),
		...(init.axdomOff ? { axdomOff: true } : {}),
		...(init.noGrounding ? { noGrounding: true } : {}),
		...(init.useRecipe ? { useRecipe: true } : {}),
		...(init.recipe ? { recipe: init.recipe } : {}),
		...(init.noRescue ? { noRescue: true } : {}),
		...(init.url ? { url: init.url } : {}),
		...(init.appmapVariant ? { appmapVariant: init.appmapVariant } : {}),
		...(init.model ? { model: init.model } : {}),
		artifacts: artifactsFor(id, init),
	};
	writeJob(rec, root);

	return rec;
}

function artifactsFor(id: string, init: JobInit): JobArtifacts {
	const log = `out/jobs/${id}/log.txt`;
	if (init.kind === "explore")
		return {
			log,
			appmap: `docs/appmaps/${appSlug(init.app)}.md`,
			appmapGraph: `docs/appmaps/${appSlug(init.app)}.json`,
			checkpoint: `out/runs/${id}.checkpoint.json`,
		};
	// recipe-cli.ts writes exactly these two under the run key: the run log always, the
	// journal only when a step mutated something (`pull` reads an absent one as `missing`).
	if (init.kind === "replay")
		return {
			log,
			runLog: `out/runs/${id}.json`,
			journal: `out/runs/${id}.journal.jsonl`,
		};

	return {
		log,
		runLog: `out/runs/${id}.json`,
		...(init.record ? { recording: `out/recording/${id}/window.mp4` } : {}),
	};
}

/**
 * Atomic replace. The temp file is a sibling — `rename` is only atomic within a filesystem,
 * and `os.tmpdir()` is frequently a different one — and it is removed on any failure so a
 * crashed write leaves the previous record intact rather than a drift of `.tmp` debris that
 * a later reader has to learn to ignore.
 */
export function writeJob(rec: JobRecord, root = jobsDir()): void {
	const dir = jobDir(rec.id, root);
	fs.mkdirSync(dir, { recursive: true });
	const target = path.join(dir, "job.json");
	const tmp = path.join(dir, `.job.json.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
		fs.renameSync(tmp, target);
	} catch (e) {
		fs.rmSync(tmp, { force: true });
		throw e;
	}
}

export function readJob(id: string, root = jobsDir()): JobRecord | undefined {
	if (!SAFE_ID.test(id)) return undefined;
	const rec = readJsonOr<JobRecord | undefined>(path.join(jobDir(id, root), "job.json"), undefined);

	return rec && typeof rec.id === "string" ? rec : undefined;
}

/**
 * Read-modify-write. Not concurrency-safe against a second writer and does not need to be:
 * exactly one process owns the registry, which is the same invariant the lease enforces for
 * the driver.
 */
export function updateJob(id: string, patch: Partial<JobRecord>, root = jobsDir()): JobRecord | undefined {
	const rec = readJob(id, root);
	if (!rec) return undefined;
	const next = { ...rec, ...patch, id: rec.id };
	writeJob(next, root);

	return next;
}

/**
 * Newest first. The id's timestamp portion sorts lexicographically by time, but explore and
 * replay ids carry a kind prefix and letters outrank every digit — sorted raw, every prefixed
 * job sat above every task job regardless of age, and `runnerctl logs` on an idle host
 * streamed a week-old explore log. Compare on the timestamp with the prefix stripped; still
 * no stat calls.
 */
export function listJobs(root = jobsDir()): JobRecord[] {
	let names: string[];
	try {
		names = fs.readdirSync(root);
	} catch {
		return [];
	}
	const stamp = (n: string): string => n.replace(/^(?:explore|replay)-/, "");

	return names
		.filter((n) => SAFE_ID.test(n))
		.sort((a, b) => (stamp(a) < stamp(b) ? 1 : stamp(a) > stamp(b) ? -1 : 0))
		.map((n) => readJob(n, root))
		.filter((r): r is JobRecord => r !== undefined);
}

/**
 * The queue, oldest first — the drain order. Derived from the registry on every call rather
 * than held in memory, so the queue IS the set of `queued` records and survives a runner
 * restart with no reconciliation step of its own. `listJobs` sorts newest-first for display;
 * this reverses it because a queue that served newest-first would starve its oldest entry.
 */
export function listQueued(root = jobsDir()): JobRecord[] {
	return listJobs(root)
		.filter((r) => r.state === "queued")
		.reverse();
}

/**
 * Reconcile the registry with the kernel. Run at startup, which is where the lie would
 * otherwise originate: the runner is killed (or the Mac reboots) mid-run, every job stays
 * marked `running` forever, and a `status` poll reports a busy host that is doing nothing.
 *
 * A job whose pid is still alive is left alone — detached children survive a runner restart
 * on purpose, and marking one orphaned would be exactly as wrong in the other direction.
 */
export function sweepOrphans(root = jobsDir()): JobRecord[] {
	const swept: JobRecord[] = [];
	for (const rec of listJobs(root)) {
		if (rec.state !== "running" || pidAlive(rec.pid)) continue;
		const next = updateJob(
			rec.id,
			{ state: "orphaned", endedAt: new Date().toISOString(), exitCode: null },
			root,
		);
		if (next) swept.push(next);
	}

	return swept;
}

/**
 * Byte-offset log read.
 *
 * Offsets rather than whole-file reads because both consumers resume: the UI re-attaches to
 * a run already in progress, and `logs --follow` polls. Bytes, not characters, because the
 * offset must be meaningful against the file itself — a UTF-8 string slice would desync the
 * moment a multi-byte character straddles a poll boundary, so the caller gets a Buffer and
 * decodes whole frames.
 *
 * A missing job returns empty rather than throwing: a job that has not printed yet and a job
 * id that never existed are both "nothing to show", and the caller distinguishes them from
 * the record, not from an exception.
 */
export function readLog(id: string, fromByte = 0, root = jobsDir()): { bytes: Buffer; nextOffset: number } {
	const from = Math.max(0, Math.floor(fromByte));
	if (!SAFE_ID.test(id)) return { bytes: Buffer.alloc(0), nextOffset: from };
	let fd: number | undefined;
	try {
		fd = fs.openSync(logPath(id, root), "r");
		const size = fs.fstatSync(fd).size;
		// A truncated or rotated file would leave us reading past the end; restart from 0
		// rather than returning a permanently empty stream.
		const start = from > size ? 0 : from;
		if (start === size) return { bytes: Buffer.alloc(0), nextOffset: size };
		const bytes = Buffer.alloc(size - start);
		const read = fs.readSync(fd, bytes, 0, bytes.length, start);

		return { bytes: bytes.subarray(0, read), nextOffset: start + read };
	} catch {
		return { bytes: Buffer.alloc(0), nextOffset: from };
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}
