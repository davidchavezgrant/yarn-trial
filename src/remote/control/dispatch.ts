import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { compileRecipe, readRecipe, recipeFileFor } from "../../core/recipe.js";
import { dataRoot, recipesDir } from "../../paths.js";
import { EXIT_REFUSED as CTL_REFUSED, EXIT_UNREACHABLE as CTL_UNREACHABLE } from "../runner/ctl.js";
import type { JobArtifacts, JobKind, JobRecord } from "../runner/jobs.js";
import { autoSync, autoSyncRecipes, type SyncOptions } from "./appmaps.js";
import { checkinSession, checkoutSession, recordRunOutcome, runningElsewhere, sessionPlan, vaultEnabled } from "./creds.js";
import { type FleetRow, type FleetState, fleetStatus, pickIdleHost, pickShortestQueue } from "./fleet.js";
import { defaultOperator, type HostEntry, type Inventory, loadHosts, resolveHost } from "./hosts.js";
import { assertSafeRemotePath, DEFAULT_SSH_TIMEOUT_MS, firstLine, lastFrame, remoteDataRoot, runnerArgv, runnerHome, runSsh, runTransport, rsyncShell, SPAWN_FAILED_EXIT, type SshResult, type SshRunner, sshArgv, TIMEOUT_EXIT } from "./ssh.js";

/**
 * The local half of a dispatched run: submit it to a Mac in the fleet, watch it, bring the
 * artifacts home.
 *
 * Three properties shape everything below.
 *
 * 1. THE TASK CROSSES VERBATIM. Not trimmed, not re-quoted, not screened. `auditTaskPrompt`
 *    in agent.ts is the one authoritative gate on hinted prompts (CLAUDE.md, "Measurement
 *    rule"), and a second copy of that rule on the wire would be a copy that can disagree —
 *    which destroys the property the gate exists to protect. Nothing here reads the task text.
 *
 * 2. NOTHING IS INTERPOLATED INTO AN ARGV. sshd joins the remote arguments into one string
 *    and hands it to a login shell, so every byte that reaches the far side is shell input.
 *    Every ssh command here is built by `sshArgv`/`runnerArgv` and every variable — task, app,
 *    job id, byte offset — travels inside the base64 spec. `pull` is the one exception and
 *    cannot use a spec, because rsync's protocol IS the remote path; it refuses a path that
 *    is not `[A-Za-z0-9._/-]+` rather than trying to quote one.
 *
 * 3. THE OPERATOR'S LAPTOP IS DISPOSABLE. A grounding pass runs for 40 minutes on a machine
 *    in a colo; a closed lid must cost nothing. `dispatch` returns as soon as the job exists,
 *    `follow` is resumable from a byte offset, and `pull` can be run at any time afterwards.
 *    No run's lifetime depends on this process staying alive.
 */

/** `--host auto`: let the fleet choose. Any other value is a name, alias or address. */
export const AUTO_HOST = "auto";

// CTL_REFUSED / CTL_UNREACHABLE are imported from ctl.ts rather than re-declared here. It
// costs a larger module graph — ctl.ts is the remote CLI and drags its socket client along —
// and that is the cheaper half of the trade: the code is produced on the Mac and interpreted
// on the laptop, and `--host auto` decides whether to try the next host from it. A second
// copy is a protocol that drifts while both sides still compile. ctl.ts's entry point is
// guarded, so importing it starts nothing.

/** Exit code we synthesise when ssh dies on the signal `follow` sent it. Matches `128 + SIGTERM`. */
const SIGTERM_EXIT = 143;

/**
 * agent.ts's readiness refusal: the target app is not at its declared home state, so the run
 * stopped before spending a budget on whatever is in the way. Defined here rather than imported
 * because dispatch talks to a remote checkout, which may be a different revision — this is a
 * wire value between two processes, not a shared constant.
 */
const READINESS_REFUSED = 3;

/**
 * A submit gets far more room than a status poll. The poll's 4s budget exists so one dead
 * host cannot hold up a 5s UI tick; a submit is a one-shot operator action whose ambiguous
 * failure — request delivered, reply lost — is the expensive one, because the only safe
 * response to it is to stop and let a human look. Time is the cheapest way to avoid it.
 */
const SUBMIT_TIMEOUT_MS = 20_000;

/** `job` and `doctor` are registry reads on an idle-or-busy host; neither does any work. */
const CALL_TIMEOUT_MS = 10_000;

/** An mp4 of a 40-minute run over a colo link. Generous because the alternative is a half-pull. */
const PULL_TIMEOUT_MS = 10 * 60_000;

/** Job ids are path segments on both machines. Same shape jobs.ts enforces when it mints one. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export interface DispatchOptions {
	/** Host name, alias, address, or `auto`. */
	host: string;
	app: string;
	kind?: JobKind;
	/** Passed through untouched. See property 1 above. */
	task?: string;
	record?: boolean;
	noVision?: boolean;
	/** `--backend <kind>` on the child argv, task and explore alike. Absent = the child's default. */
	backend?: "ax" | "cdp";
	/** Vision-only arm: `--no-ax` (task only). Invalid combinations are the child CLI's to refuse. */
	noAx?: boolean;
	/** `AXDOM=0` on the child: run without the DOM-enrichment sidecar. */
	axdomOff?: boolean;
	/** `NO_GROUNDING=1`: the ungrounded arm — the child ignores its appmap. */
	noGrounding?: boolean;
	/** `USE_RECIPE=1`: ground from the curated docs/recipes/<app>.md notes instead. */
	useRecipe?: boolean;
	/** Step budget override for the child run (AGENT_STEPS on the runner). */
	steps?: number;
	/** Replay only: recipe file path RELATIVE to the data root — the same key on both machines. */
	recipe?: string;
	/** Replay only: `--no-rescue`, the unattended posture — a broken step fails instead of calling the model. */
	noRescue?: boolean;
	/** Web target: `--url <url>` on the child argv (task and explore). The app field stays the display label. */
	url?: string;
	/** `APPMAP_VARIANT=vision` on the child: ground from the `<slug>.vision.*` map. A dedicated
	 *  option rather than a generic env dict — arbitrary env crossing the wire is a surface
	 *  nothing needs, and a named field is one the runner can validate. */
	appmapVariant?: "vision";
	/** `AGENT_MODEL=<id>` on the child: which model runs the loop (task/explore/replay alike).
	 *  Absent = the child's own default (makeClient). The benchmark's model dimension. */
	model?: string;
	/**
	 * Wait in line instead of being refused when the host is busy. Default true — the queue is
	 * why an operator can dispatch five runs and close the lid. `false` restores the old
	 * refusal for callers that want to react to busy themselves.
	 */
	queue?: boolean;
	/**
	 * Override the credential vault for this dispatch. Absent = follow `vaultEnabled()` (on unless
	 * `YARN_VAULT=0`). `false` runs the core submit path with no checkout/checkin — how the protocol
	 * tests and any caller that wants to manage sessions itself opt out.
	 */
	vault?: boolean;
	operator?: string;
	inventory?: Inventory;
	/** The ssh call, injected so tests exercise the fall-through logic without a network. */
	run?: SshRunner;
	/**
	 * The appmap fan-out that runs just before the submit, injected so tests do not rsync three
	 * real Macs. Its note reaches the caller as `syncNote`; it never blocks a dispatch.
	 */
	sync?: (opts: SyncOptions) => Promise<string | undefined>;
	/**
	 * The recipe fan-out, run before a replay submit only — the runner refuses a replay whose
	 * recipe is not already on its disk, and this is what puts it there. Injected for the same
	 * reason as `sync`.
	 */
	syncRecipes?: (opts: SyncOptions) => Promise<string | undefined>;
	timeoutMs?: number;
}

/** The holder of a host that refused, as the lease reported it. */
export interface BusyHolder {
	operator?: string;
	app?: string;
	kind?: string;
	jobId?: string;
	elapsedSec?: number;
}

export interface DispatchAttempt {
	host: string;
	reason: string;
	/** Present when the refusal was a live lease rather than an error. */
	busy?: BusyHolder;
	/** Whether asking another host after this one is safe. See `attemptFrom`. */
	fatal: boolean;
}

export interface DispatchAccepted {
	ok: true;
	host: HostEntry;
	jobId: string;
	kind: JobKind;
	app: string;
	pid?: number;
	/**
	 * Paths relative to the data root, which is the same key on both machines — `pull` writes
	 * them under the local root unchanged, so `out/runs/<id>.json` means one file wherever you
	 * are reading it from.
	 */
	artifacts: JobArtifacts;
	/** The job joined this host's line instead of starting; `position` is 1-based. */
	queued?: boolean;
	position?: number;
	/** The run the queued job is waiting behind, as the runner reported it. */
	behind?: BusyHolder;
	/** Hosts that refused before this one accepted. Empty for a direct hit. */
	attempts: DispatchAttempt[];
	/** What the pre-submit appmap fan-out moved, when it moved anything. For the operator's log. */
	syncNote?: string;
	/** One line on whose data is now inside the target app. See `runner/profiles.ts`. */
	profile?: string;
	/**
	 * The operator has no stored profile for this app on that Mac, so it came up factory-fresh
	 * and the run will almost certainly stop at the readiness check. Advisory, and deliberately
	 * not a refusal: an app that needs no sign-in at all is a perfectly good target.
	 */
	signinNeeded?: boolean;
}

export type DispatchResult = DispatchAccepted | { ok: false; error: string; attempts: DispatchAttempt[] };

/**
 * What the operator should be told between "accepted" and the first line of the run's log.
 *
 * Shared because there are two front ends and the CLI was already dropping `syncNote` on the
 * floor. Each note is something that changed on the remote Mac without being asked for, which
 * is exactly the category that has to be said out loud.
 */
export function dispatchNotes(r: DispatchAccepted): string[] {
	const notes: string[] = [];
	if (r.queued) {
		const wait = r.behind ? ` behind ${r.behind.operator ?? "?"}'s ${r.behind.kind ?? "run"} on ${r.behind.app ?? "?"} (${r.behind.elapsedSec ?? 0}s in)` : "";
		notes.push(`queued at position ${r.position ?? "?"}${wait} — it starts when the host frees; following its log now`);
	}
	if (r.syncNote) notes.push(r.syncNote);
	if (r.profile) notes.push(r.profile);
	// Named command over "you may need to sign in": this is the moment the operator can act, and
	// the app and host are both already known here.
	if (r.signinNeeded) notes.push(`↳ sign in once to continue: ./run signin ${r.host.name} ${JSON.stringify(r.app)}`);

	return notes;
}

/**
 * Submit a run and return once the remote has a job id for it.
 *
 * `auto` walks the idle hosts in the order `pickIdleHost` gives them. It has to walk rather
 * than pick once: that function is explicitly advisory, the window between the status poll and
 * the submit is a full round trip wide, and losing the race to another operator is a normal
 * Tuesday rather than an error.
 */
export async function dispatch(opts: DispatchOptions): Promise<DispatchResult> {
	const inv = opts.inventory ?? loadHosts();
	const run = opts.run ?? runSsh;
	const kind: JobKind = opts.kind === "explore" || opts.kind === "replay" ? opts.kind : "task";
	if (!opts.app?.trim()) throw new Error("dispatch needs an app");
	if (kind === "replay" && !opts.recipe?.trim()) throw new Error("a replay dispatch needs a recipe path (relative to the data root)");

	const spec = {
		kind,
		// Both strings go over as given. The remote trims the app name and refuses an empty
		// task; doing either here would put a second copy of a remote rule on the wire.
		app: opts.app,
		task: opts.task ?? "",
		record: Boolean(opts.record),
		noVision: Boolean(opts.noVision),
		// The arm flags cross as booleans exactly like record/noVision. No combination is
		// screened here — the child CLI refuses invalid ones itself, and a second copy of its
		// rules on the wire is the same mistake as a second copy of the task-text rule.
		noAx: Boolean(opts.noAx),
		axdomOff: Boolean(opts.axdomOff),
		noGrounding: Boolean(opts.noGrounding),
		useRecipe: Boolean(opts.useRecipe),
		noRescue: Boolean(opts.noRescue),
		...(opts.backend ? { backend: opts.backend } : {}),
		// The path is data-root-relative — the one key both machines share. The runner owns
		// its validation (path discipline, file presence); nothing here second-guesses it.
		...(kind === "replay" ? { recipe: opts.recipe } : {}),
		...(opts.url ? { url: opts.url } : {}),
		...(opts.appmapVariant ? { appmapVariant: opts.appmapVariant } : {}),
		...(opts.model ? { model: opts.model } : {}),
		...(opts.steps ? { steps: opts.steps } : {}),
		operator: opts.operator ?? defaultOperator(),
	};
	const wantQueue = opts.queue !== false;

	const attempts: DispatchAttempt[] = [];
	let targets: Array<{ host: HostEntry; queue: boolean }>;
	if (opts.host.trim().toLowerCase() === AUTO_HOST) {
		const rows = await fleetStatus({ inventory: inv, run, timeoutMs: DEFAULT_SSH_TIMEOUT_MS });
		// Idle hosts are asked WITHOUT the queue flag even when queueing is wanted: losing the
		// advisory race on one idle host must mean "ask the next idle host", not "join the line
		// on the first" while a free Mac sits two entries down the list.
		targets = idleHosts(rows, inv).map((host) => ({ host, queue: false }));
		if (!targets.length && wantQueue) {
			// Nobody idle: wait on the busy host with the shortest line. One target, asked once —
			// an enqueue cannot lose the race the idle walk exists for, because a busy host
			// accepts a queued job whatever else lands on it in between.
			const pick = pickShortestQueue(rows);
			const host = pick && inv.hosts.find((h) => h.name === pick.name);
			if (host) targets = [{ host, queue: true }];
		}
		if (!targets.length) return { ok: false, error: "no idle host in the fleet", attempts: rows.map(rowAttempt) };
	} else {
		targets = [{ host: resolveHost(opts.host, inv), queue: wantQueue }];
	}

	// Before the submit, not after: the run reads its appmap at startup, so a map that arrives
	// a second late is a map the run does not have. `opts.sync` is injected by tests, which
	// must not rsync three real Macs; production passes nothing and gets the real thing.
	//
	// The whole inventory, not just `targets`. Restricting it to the target would only ever push
	// what the hub already holds, and the case this feature exists for is a pass someone else
	// ran on another Mac — which reaches the target only if that Mac is collected from too.
	// Measured at ~3s for three Macs, against runs that last minutes.
	//
	// A replay adds the recipe fan-out on top (a replay still reads its appmap graph for the
	// teardown's scope resolution, so the appmap sync is not skipped for it). The recipe sync
	// runs first because the runner REFUSES a replay whose recipe file is absent — this is the
	// step that makes the submit below admissible.
	const recipeNote = kind === "replay" ? await (opts.syncRecipes ?? autoSyncRecipes)({ inventory: inv }) : undefined;
	const appmapNote = await (opts.sync ?? autoSync)({ inventory: inv });
	const syncNote = [recipeNote, appmapNote].filter(Boolean).join("\n") || undefined;

	// The credential vault (on by default; YARN_VAULT=0 disables). Two hooks around the submit:
	// refuse if this operator's session for this app is already live elsewhere (single-writer per
	// session), and check the session OUT onto the box just before its submit — the checkin is the
	// run's other end, in `attach`. A replay carries no per-operator session concern beyond the app
	// it drives, so it takes the same path. All best-effort: a vault that stumbles logs a note and
	// the run proceeds to sign in and verify itself, exactly as it would with the feature off.
	const vault = opts.vault ?? vaultEnabled();
	if (vault) {
		const rows = await fleetStatus({ inventory: inv, run, timeoutMs: DEFAULT_SSH_TIMEOUT_MS });
		const busyOn = runningElsewhere(rows, spec.operator, opts.app);
		if (busyOn) return { ok: false, error: `${spec.operator}'s ${opts.app} session is already running on ${busyOn} — one run per session at a time (fleet vault)`, attempts };
	}

	for (const { host, queue } of targets) {
		let vaultNote: string | undefined;
		if (vault) vaultNote = await checkoutOnto(host, opts.app, spec.operator, inv, run);
		const res = await run(host, runnerArgv("submit", queue ? { ...spec, queue: true } : spec), { timeoutMs: opts.timeoutMs ?? SUBMIT_TIMEOUT_MS });
		const frame = lastFrame(res.stdout);
		if (frame?.ok === true && typeof frame.jobId === "string")
			return {
				ok: true,
				host,
				jobId: frame.jobId,
				kind,
				app: String(frame.app ?? opts.app),
				...(typeof frame.pid === "number" ? { pid: frame.pid } : {}),
				artifacts: (frame.artifacts ?? { log: `out/jobs/${frame.jobId}/log.txt` }) as JobArtifacts,
				...(frame.queued === true ? { queued: true } : {}),
				...(typeof frame.position === "number" ? { position: frame.position } : {}),
				...(frame.behind && typeof frame.behind === "object" ? { behind: frame.behind as BusyHolder } : {}),
				attempts,
				...(() => {
					const combined = [syncNote, vaultNote].filter(Boolean).join("\n");

					return combined ? { syncNote: combined } : {};
				})(),
				...(typeof frame.profile === "string" ? { profile: frame.profile } : {}),
				...(frame.signinNeeded === true ? { signinNeeded: true } : {}),
			};

		const attempt = attemptFrom(host, res, frame, opts);
		attempts.push(attempt);
		if (attempt.fatal) break;
	}

	return { ok: false, error: attempts.map((a) => `${a.host}: ${a.reason}`).join("; ") || "no host accepted the run", attempts };
}

/**
 * Check an operator's session out onto the box about to run, returning the one-line note for the
 * operator's log. Best-effort by construction: any failure becomes a note and a `null`-ish return,
 * never a thrown error, because the run's own readiness gate and sign-in fallback are the safety
 * net — the vault is an optimisation over "sign in on every box", not a precondition for a run.
 */
async function checkoutOnto(host: HostEntry, app: string, operator: string, inv: Inventory, run: SshRunner): Promise<string | undefined> {
	try {
		const co = await checkoutSession({ host, app, operator }, { inventory: inv, run });
		if (co.action === "installed") return `vault: ${operator}'s ${app} session restored onto ${host.name}`;
		if (co.action === "skipped-owned") return `vault: ${operator}'s ${app} session already live on ${host.name}`;
		if (co.action === "no-bundle") return `vault: no stored ${app} session for ${operator} — ${host.name} will sign in`;

		return `vault: checkout to ${host.name} failed (${co.error}) — proceeding; the run will verify and sign in if needed`;
	} catch (e) {
		return `vault: checkout error (${(e as Error).message}) — proceeding`;
	}
}

/**
 * Classify a submit that did not come back with a job id.
 *
 * The split that matters is "the remote answered" versus "we do not know". A parsed refusal is
 * an answer: `busy` is the advisory-pick race and the next idle host is worth asking, while
 * any other refusal (no app, spawn failed) would repeat identically on every machine and only
 * multiply the noise. No parsed reply at all means a run may have started on a host we can no
 * longer see, and starting a second one elsewhere while an unseen first one drives a Mac is
 * worse than stopping — so only exit 3, which the remote itself defines as "nothing was
 * listening", is treated as safe to skip past.
 */
function attemptFrom(host: HostEntry, res: SshResult, frame?: Record<string, any>, opts?: { timeoutMs?: number }): DispatchAttempt {
	if (frame?.ok === false) {
		const busy = frame.busy === true;

		return {
			host: host.name,
			reason: String(frame.error ?? `runnerctl exited ${res.code}`),
			...(busy
				? {
						busy: {
							...(typeof frame.operator === "string" ? { operator: frame.operator } : {}),
							...(typeof frame.app === "string" ? { app: frame.app } : {}),
							...(typeof frame.kind === "string" ? { kind: frame.kind } : {}),
							...(typeof frame.jobId === "string" ? { jobId: frame.jobId } : {}),
							...(typeof frame.elapsedSec === "number" ? { elapsedSec: frame.elapsedSec } : {}),
						},
					}
				: {}),
			fatal: !busy,
		};
	}

	return {
		host: host.name,
		// A timeout has no stderr, and "runnerctl exited 124" tells an operator nothing about
		// what to do — observed 2026-07-31 on a submit whose runner was mid-launch of the target
		// app, which routinely outlasts the call budget. Name the condition and the fix instead;
		// the run itself may well be alive on that Mac, which is the part worth knowing.
		reason:
			res.code === TIMEOUT_EXIT
				? `no answer within ${Math.round((opts?.timeoutMs ?? SUBMIT_TIMEOUT_MS) / 1000)}s — the runner may still be launching the app; check ./run dispatch ${host.name} jobs`
				: firstLine(res.stderr) || `runnerctl exited ${res.code}`,
		fatal: res.code !== CTL_UNREACHABLE,
	};
}

/** Idle hosts in `pickIdleHost`'s order, so the "which host first" policy stays in fleet.ts. */
function idleHosts(rows: FleetRow[], inv: Inventory): HostEntry[] {
	const out: HostEntry[] = [];
	const remaining = [...rows];
	for (;;) {
		const pick = pickIdleHost(remaining);
		if (!pick) break;
		remaining.splice(0, remaining.indexOf(pick) + 1);
		const host = inv.hosts.find((h) => h.name === pick.name);
		if (host) out.push(host);
	}

	return out;
}

function rowAttempt(row: FleetRow): DispatchAttempt {
	const busy = row.state === "busy";

	return {
		host: row.name,
		reason: busy
			? `busy: ${row.operator ?? "?"}, ${row.app ?? "?"}, ${row.elapsedSec ?? 0}s`
			: (row.reason ?? `state ${row.state}`),
		...(busy
			? {
					busy: {
						...(row.operator ? { operator: row.operator } : {}),
						...(row.app ? { app: row.app } : {}),
						...(row.elapsedSec !== undefined ? { elapsedSec: row.elapsedSec } : {}),
					},
				}
			: {}),
		fatal: true,
	};
}

/** One ssh child, streaming. Injected in tests; the default is `sshStream` below. */
export interface RemoteStream {
	stdout: AsyncIterable<Buffer | string>;
	kill(): void;
	exit: Promise<number>;
	/** Last few KB of ssh's stderr, for the reason line on a failed follow. */
	stderrTail?: () => string;
}

export type StreamRunner = (host: HostEntry, remoteArgv: string[]) => RemoteStream;

export interface FollowOptions {
	/** Resume point from a previous `follow`. The remote replays nothing before it. */
	fromByte?: number;
	inventory?: Inventory;
	stream?: StreamRunner;
	/** Detach without ending the run. The remote job is untouched. */
	signal?: AbortSignal;
}

export interface FollowResult {
	jobId?: string;
	/** Where to resume. Feed straight back in as `fromByte`. */
	nextOffset: number;
	/** True only when the remote said the job ended; false means we detached from a live run. */
	done: boolean;
	state?: string;
	exitCode?: number | null;
	error?: string;
}

/**
 * Stream a job's log, resumably.
 *
 * Two decoders, and both are load-bearing. The remote frames log bytes as base64 with byte
 * offsets precisely because a chunk boundary can fall inside a multi-byte character, so
 * decoding each chunk on its own would turn every `→` unlucky enough to straddle a poll into
 * two replacement characters. `StringDecoder` holds the incomplete sequence until the rest
 * arrives — once for the NDJSON frames off the wire, once for the payload inside them.
 *
 * The same split is why detaching rewinds. Bytes still held by the decoder have already been
 * counted in the remote's `nextOffset`; resuming from it would drop them and corrupt exactly
 * one character. They are given back instead, and re-read on the next attach.
 */
export async function follow(
	host: HostEntry | string,
	jobId: string | undefined,
	onChunk: (text: string) => void,
	opts: FollowOptions = {},
): Promise<FollowResult> {
	const target = toHost(host, opts.inventory);
	const from = Math.max(0, Math.floor(opts.fromByte ?? 0));
	if (jobId !== undefined && !SAFE_ID.test(jobId)) throw new Error(`unsafe job id ${JSON.stringify(jobId)}`);

	// follow/fromByte ride in the spec rather than as `--follow --from N` flags: ctl merges a
	// decoded spec into the same params object either way, and keeping the base64 blob as the
	// only variable token means there is still no argv position to interpolate into.
	const stream = (opts.stream ?? sshStream)(target, runnerArgv("logs", { ...(jobId ? { jobId } : {}), follow: true, fromByte: from }));

	const result: FollowResult = { nextOffset: from, done: false, ...(jobId ? { jobId } : {}) };
	if (opts.signal?.aborted) {
		stream.kill();

		return result;
	}

	const frames = new StringDecoder("utf8");
	const text = new StringDecoder("utf8");
	let pending = "";
	let bytesIn = 0;
	let bytesOut = 0;
	const abort = (): void => stream.kill();
	opts.signal?.addEventListener("abort", abort, { once: true });

	try {
		for await (const data of stream.stdout) {
			pending += frames.write(Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8"));
			let nl: number;
			while ((nl = pending.indexOf("\n")) >= 0) {
				const line = pending.slice(0, nl).trim();
				pending = pending.slice(nl + 1);
				if (!line) continue;

				let frame: Record<string, any>;
				try {
					frame = JSON.parse(line);
				} catch {
					// A login banner, or ssh's own chatter. Not fatal: the frames after it are
					// still frames, and a run should not die because a Mac grew a MOTD.
					continue;
				}

				if (frame.ok === false) {
					result.error = String(frame.error ?? "the runner refused the log request");
					continue;
				}
				if (typeof frame.jobId === "string") result.jobId = frame.jobId;
				if (typeof frame.chunk === "string") {
					const bytes = Buffer.from(frame.chunk, "base64");
					bytesIn += bytes.length;
					const out = text.write(bytes);
					bytesOut += Buffer.byteLength(out, "utf8");
					if (out) onChunk(out);
				}
				if (typeof frame.nextOffset === "number") result.nextOffset = frame.nextOffset;
				if (frame.done === true) {
					result.done = true;
					result.state = typeof frame.state === "string" ? frame.state : undefined;
					result.exitCode = typeof frame.exitCode === "number" ? frame.exitCode : null;
				}
			}
		}
	} finally {
		opts.signal?.removeEventListener("abort", abort);
	}

	if (result.done) {
		// The job is over, so nothing will complete a half character: flush whatever is held,
		// even if it decodes to a replacement, rather than silently losing the tail.
		const tail = text.end();
		if (tail) onChunk(tail);
	} else {
		result.nextOffset = Math.max(from, result.nextOffset - Math.max(0, bytesIn - bytesOut));
	}

	const code = await stream.exit;
	// A signalled ssh is us detaching, and a nonzero exit on a finished-but-failed job is
	// ctl reporting the job's own outcome — neither is a transport error worth surfacing.
	if (!result.done && code !== 0 && code !== SIGTERM_EXIT && !result.error)
		result.error = firstLine(stream.stderrTail?.() ?? "") || `ssh exited ${code}`;

	return result;
}

function sshStream(host: HostEntry, remoteArgv: string[]): RemoteStream {
	const child = spawn("ssh", sshArgv(host, remoteArgv), { stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	// Drained rather than ignored: an unread pipe fills its buffer and blocks ssh mid-stream,
	// which on a 40-minute follow is indistinguishable from the run going quiet. Capped
	// because the only use for it is one reason line.
	child.stderr?.on("data", (d: Buffer) => {
		if (stderr.length < 4096) stderr += d.toString("utf8");
	});

	const exit = new Promise<number>((resolve) => {
		child.once("error", () => resolve(SPAWN_FAILED_EXIT));
		child.once("close", (code, signal) => resolve(code ?? (signal ? SIGTERM_EXIT : SPAWN_FAILED_EXIT)));
	});

	return { stdout: child.stdout, kill: () => void child.kill("SIGTERM"), exit, stderrTail: () => stderr };
}

/** How rsync is invoked. Same result shape as ssh so the two failure paths read alike. */
export type CommandRunner = (file: string, argv: string[], opts: { timeoutMs: number }) => Promise<SshResult>;

export interface PullOptions {
	inventory?: Inventory;
	run?: SshRunner;
	rsync?: CommandRunner;
	/** Local data root. Overridden in tests; production always writes beside every other run. */
	dest?: string;
	timeoutMs?: number;
}

export type PullState = "pulled" | "missing" | "failed";

export interface PulledArtifact {
	/** Which artifact this is: `job`, `runLog`, `journal`, `recording`, `appmap`, `appmapGraph`, `checkpoint`. */
	key: string;
	/** Path relative to either data root — the same string on both machines. */
	rel: string;
	local: string;
	state: PullState;
	detail?: string;
}

export interface PullResult {
	ok: boolean;
	jobId: string;
	job?: JobRecord;
	artifacts: PulledArtifact[];
	error?: string;
}

/**
 * Bring a finished (or still-running) job's artifacts home, under the same key they have on
 * the remote: `out/runs/<id>.json`, `out/recording/<id>/`, `out/jobs/<id>/`, and for a
 * grounding pass the appmap it wrote.
 *
 * One rsync per artifact rather than one with `--relative`. A task run has no appmap and an
 * explore run has no run log, so several sources are legitimately absent every time; per-file
 * invocations turn that into a per-file `missing` instead of a partial exit code the caller
 * has to interpret. They cost nothing extra — the ssh connection is multiplexed, so only the
 * first one handshakes.
 */
export async function pull(host: HostEntry | string, jobId: string, opts: PullOptions = {}): Promise<PullResult> {
	const target = toHost(host, opts.inventory);
	const run = opts.run ?? runSsh;
	// ssh.ts's transport mapping, not a local copy: a pull killed on its timeout reports 124,
	// the same vocabulary every other transport call here speaks.
	const rsync: CommandRunner = opts.rsync ?? ((file, argv, o) => runTransport(file, argv, o.timeoutMs));
	const localRoot = opts.dest ?? dataRoot();
	if (!SAFE_ID.test(jobId)) throw new Error(`unsafe job id ${JSON.stringify(jobId)}`);

	const jobFrame = lastFrame((await run(target, runnerArgv("job", { jobId }), { timeoutMs: CALL_TIMEOUT_MS })).stdout);
	const job = jobFrame?.ok === true ? (jobFrame.job as JobRecord | undefined) : undefined;
	if (!job) return { ok: false, jobId, artifacts: [], error: String(jobFrame?.error ?? `${target.name} knows nothing about job ${jobId}`) };

	const remoteRoot = await remoteDataRoot(target, run);
	if (!remoteRoot) return { ok: false, jobId, job, artifacts: [], error: `${target.name} did not report its data root` };

	const artifacts: PulledArtifact[] = [];
	for (const src of sourcesFor(job)) {
		const remote = `${remoteRoot}/${src.rel}`;
		const local = path.join(localRoot, src.rel);
		assertSafeRemotePath(remote);
		fs.mkdirSync(path.dirname(local), { recursive: true });

		const res = await rsync(
			"rsync",
			[
				"-a",
				// Partial transfers land in a side directory and are only renamed into place when
				// complete, so a lid closing mid-pull cannot leave a truncated mp4 sitting where
				// a whole one belongs — and the next pull resumes it instead of restarting.
				"--partial-dir=.rsync-partial",
				"-e", rsyncShell(target),
				`${target.ssh.user}@${target.ssh.host}:${remote}${src.dir ? "/" : ""}`,
				src.dir ? `${local}/` : local,
			],
			{ timeoutMs: opts.timeoutMs ?? PULL_TIMEOUT_MS },
		);

		artifacts.push({
			key: src.key,
			rel: src.rel,
			local,
			...classifyRsync(res),
		});
	}

	const failed = artifacts.filter((a) => a.state === "failed");

	return {
		ok: failed.length === 0,
		jobId,
		job,
		artifacts,
		...(failed.length ? { error: failed.map((a) => `${a.key}: ${a.detail ?? "rsync failed"}`).join("; ") } : {}),
	};
}

interface Source {
	key: string;
	rel: string;
	dir: boolean;
}

function sourcesFor(job: JobRecord): Source[] {
	const a = job.artifacts ?? ({} as JobArtifacts);
	// The whole job directory, not just log.txt: job.json is the record of what was asked for
	// and what it exited with, and reading a pulled log without it is guesswork.
	const out: Source[] = [{ key: "job", rel: `out/jobs/${job.id}`, dir: true }];
	if (a.runLog) {
		out.push({ key: "runLog", rel: a.runLog, dir: false });
		// The run's step frames, DERIVED like appmapGraph rather than declared, so records
		// written before this line still pull them: run.ts always writes them to
		// `out/runs/<stamp>-steps/`, and the stamp IS the job id.
		//
		// Without this every fleet run reached the offline judge with no trustworthy frames —
		// it believes a screenshot path only when it names a per-run `-steps/` directory
		// (judge.ts), precisely so one run cannot grade another's pixels — so VISUAL came back
		// UNAVAILABLE for the whole matrix and half the judge's signal was silently blank.
		out.push({ key: "stepFrames", rel: `out/runs/${job.id}-steps`, dir: true });
	}
	// A replay's mutation journal. Absent from the disk when the replay changed nothing, which
	// classifyRsync reads as `missing` — the ordinary per-file outcome, not a failed pull.
	if (a.journal) out.push({ key: "journal", rel: a.journal, dir: false });
	if (a.checkpoint) out.push({ key: "checkpoint", rel: a.checkpoint, dir: false });
	// `recording` is minted as `out/recording/<id>/window.mp4` (jobs.ts), so dirname is safe.
	if (a.recording) out.push({ key: "recording", rel: path.posix.dirname(a.recording), dir: true });
	if (a.appmap) {
		out.push({ key: "appmap", rel: a.appmap, dir: false });
		// The graph half of the appmap is written by the same pass but is absent from
		// JobArtifacts, which records the prose file only. Leaving it on the colo Mac would
		// land an appmap whose scope-collision warnings are silently switched off — the exact
		// failure that lets an agent change a per-document override instead of the default.
		out.push({ key: "appmapGraph", rel: a.appmap.replace(/\.md$/, ".json"), dir: false });
	}

	return out;
}

/** rsync's own vocabulary: 23/24 with an ENOENT is an absent source, not a broken transfer. */
function classifyRsync(res: SshResult): { state: PullState; detail?: string } {
	if (res.code === 0) return { state: "pulled" };
	const detail = firstLine(res.stderr) || `rsync exited ${res.code}`;
	if ((res.code === 23 || res.code === 24) && /No such file or directory|vanished/i.test(res.stderr)) return { state: "missing", detail };

	return { state: "failed", detail };
}

export interface StopResult {
	ok: boolean;
	jobId?: string;
	state?: string;
	note?: string;
	error?: string;
}

/** Stop a run. Omit the job id to stop whatever the host is doing — the lease knows. */
export async function stopRemote(host: HostEntry | string, jobId?: string, opts: { inventory?: Inventory; run?: SshRunner; timeoutMs?: number } = {}): Promise<StopResult> {
	const target = toHost(host, opts.inventory);
	const run = opts.run ?? runSsh;
	if (jobId !== undefined && !SAFE_ID.test(jobId)) throw new Error(`unsafe job id ${JSON.stringify(jobId)}`);

	const res = await run(target, runnerArgv("stop", jobId ? { jobId } : {}), { timeoutMs: opts.timeoutMs ?? CALL_TIMEOUT_MS });
	const frame = lastFrame(res.stdout);
	if (frame?.ok === true)
		return {
			ok: true,
			...(typeof frame.jobId === "string" ? { jobId: frame.jobId } : {}),
			...(typeof frame.state === "string" ? { state: frame.state } : {}),
			...(typeof frame.note === "string" ? { note: frame.note } : {}),
		};

	return { ok: false, error: String(frame?.error ?? firstLine(res.stderr) ?? "") || `runnerctl exited ${res.code}` };
}

/** One entry of a host's app list. Mirrors `listApps()`, which is what answers on the far side. */
export interface RemoteApp {
	name: string;
	running: boolean;
	/** Whether THAT host has a stamped appmap for the app — its checkout, not ours. */
	grounded: boolean;
	/** When that host's map was captured (`AppEntry.groundedAt`), when its runner reports one. */
	groundedAt?: string;
}

export interface RemoteAppList {
	host: string;
	ok: boolean;
	apps: RemoteApp[];
	/** Why the list is empty. Absent when the host answered. */
	reason?: string;
}

/**
 * What is installed on a fleet Mac.
 *
 * The runner already implements this (`case "apps"` in serve.ts) and answers from the machine
 * it runs on, so nothing here enumerates anything — it forwards and validates. Worth being
 * explicit about why the answer must come from over there: `grounded` is computed against the
 * appmaps directory of the checkout doing the computing, so asking locally about a remote host
 * gets both halves wrong at once — apps that Mac does not have, marked with grounding it does
 * not have either.
 */
export async function remoteApps(
	host: HostEntry | string,
	opts: { inventory?: Inventory; run?: SshRunner; timeoutMs?: number } = {},
): Promise<RemoteAppList> {
	const target = toHost(host, opts.inventory);
	const run = opts.run ?? runSsh;
	const res = await run(target, runnerArgv("apps"), { timeoutMs: opts.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS });
	const frame = lastFrame(res.stdout);
	if (!frame || frame.ok !== true)
		return {
			host: target.name,
			ok: false,
			apps: [],
			reason: String(frame?.error ?? firstLine(res.stderr) ?? "") || `runnerctl exited ${res.code}`,
		};

	// Shape-checked rather than cast. This crossed a network from a process we do not control
	// the version of, and a half-provisioned Mac running an older runner is a normal state for
	// this fleet — an entry with no name would reach the renderer and break the list.
	const apps = Array.isArray(frame.apps)
		? frame.apps
				.filter((a: unknown): a is Record<string, unknown> => !!a && typeof a === "object" && typeof (a as any).name === "string")
				.map((a) => ({
					name: String(a.name),
					running: a.running === true,
					grounded: a.grounded === true,
					// An older runner reports no stamp; anything that is not a string stays behind.
					...(typeof a.groundedAt === "string" && a.groundedAt ? { groundedAt: a.groundedAt } : {}),
				}))
		: [];

	return { host: target.name, ok: true, apps };
}

function toHost(host: HostEntry | string, inv?: Inventory): HostEntry {
	return typeof host === "string" ? resolveHost(host, inv ?? loadHosts()) : host;
}

const USAGE = `usage: dispatch <host|auto> "<task>" "<App>" [--record] [--no-vision]
       dispatch <host|auto> explore "<App>"
       dispatch <host|auto> replay <recipe-file-or-stamp> [--no-rescue]
       dispatch <host> follow <jobId> [--from <byte>]
       dispatch <host> pull <jobId>

Submits the run to a Mac in the fleet, streams its log, and pulls the artifacts back.
Ctrl-C detaches; the run keeps going and \`follow\` re-attaches to it.

\`explore\`, \`replay\`, \`follow\` and \`pull\` in the second position are subcommands, so a task
whose text is exactly one of those four words has to be dispatched through the API instead.`;

/**
 * What a `dispatch … replay <arg>` argument means: a recipe file, or a run stamp whose
 * compiled recipe already exists. The same resolution recipe-cli's replay verb applies,
 * MINUS compilation — dispatch never compiles, because compileRecipe is a gate (it refuses
 * failed/unverified/hinted runs) and minting a recipe as a side effect of a dispatch would
 * bury that refusal inside a submit error.
 *
 * The wire path is `docs/recipes/<basename>` regardless of where the local file sits: that
 * is where the fan-out lands recipes on every Mac, and the runner resolves the relative path
 * against ITS data root.
 */
function resolveReplayArg(arg: string): { app: string; recipe: string } {
	let file: string | undefined;
	if (fs.existsSync(arg)) file = arg;
	else {
		const logPath = path.join(dataRoot(), "out", "runs", `${arg}.json`);
		if (fs.existsSync(logPath)) {
			const runLog = JSON.parse(fs.readFileSync(logPath, "utf8"));
			const candidate = recipeFileFor(recipesDir(), compileRecipe(runLog, arg).slug, runLog.task);
			if (!fs.existsSync(candidate)) throw new Error(`no compiled recipe for ${arg} — run: ./run recipe compile ${arg}`);
			file = candidate;
		}
	}
	if (!file) throw new Error(`${arg} is neither a recipe file nor a run stamp`);

	// The app comes out of the recipe itself — the runner needs it for the profile swap and
	// the job key, and asking the operator to retype what the artifact already records is how
	// a replay ends up leased under the wrong app name.
	return { app: readRecipe(file).app, recipe: `docs/recipes/${path.basename(file)}` };
}

/**
 * The operator loop, end to end. Ctrl-C detaches rather than stopping the run — a grounding
 * pass costs 40 minutes and the whole point of dispatching it is that this process is not
 * load-bearing. The job id it prints is the resume handle.
 */
async function main(argv: string[]): Promise<number> {
	const host = argv[0];
	if (!host || argv.length < 2) {
		console.error(USAGE);

		return 2;
	}

	if (argv[1] === "follow") return attach(host, argv[2], Number(argv[argv.indexOf("--from") + 1]) || 0);
	if (argv[1] === "pull") return report(await pull(host, argv[2]));

	let opts: DispatchOptions;
	if (argv[1] === "explore") opts = { host, kind: "explore", app: argv[2] ?? "" };
	else if (argv[1] === "replay") {
		if (!argv[2]) {
			console.error(USAGE);

			return 2;
		}
		const { app, recipe } = resolveReplayArg(argv[2]);
		opts = { host, kind: "replay", app, recipe, noRescue: argv.includes("--no-rescue") };
	} else
		// argv[1] is the task and reaches the spec untouched. No trimming, no unquoting: the
		// shell already did its splitting, and anything further would be this file editing a
		// measurement input.
		opts = {
			host,
			kind: "task",
			task: argv[1],
			app: argv[2] ?? "Yarn",
			record: argv.includes("--record"),
			noVision: argv.includes("--no-vision"),
			// The curated-recipe grounding tier (docs/recipes/<app>.md), same knob the bench
			// arms use — app method knowledge belongs there, never in the task prompt.
			useRecipe: argv.includes("--use-recipe"),
			// --steps N: budget override for runs whose recovery overhead outgrows the
			// default 15 (validated to 1..100 on the runner).
			...(argv.includes("--steps") ? { steps: Number(argv[argv.indexOf("--steps") + 1]) || undefined } : {}),
		};

	const result = await dispatch(opts);

	if (!result.ok) {
		console.error(`dispatch refused: ${result.error}`);

		return 1;
	}
	console.error(`${result.jobId} on ${result.host.name}`);
	for (const note of dispatchNotes(result)) console.error(note);

	return attach(result.host.name, result.jobId, 0);
}

/**
 * The one-line remedy for a run that refused on readiness, or nothing.
 *
 * This is the run's own verdict, and it is why the `signinNeeded` prediction at submit time is
 * not enough on its own: that fires only for a brand-new profile, and stayed silent on all three
 * colo Macs because each ADOPTED an existing profile that turned out to be signed out anyway
 * (2026-07-30). Whether an app is signed in is app-specific and unknowable from here; whether it
 * refused to start is neither.
 *
 * Host and app are interpolated because by this point both are known, and the operator would
 * otherwise retype them out of the scrollback.
 */
export function signinRemedy(exitCode: number | null | undefined, host: string, app: string | undefined): string | undefined {
	if (exitCode !== READINESS_REFUSED || !app) return undefined;

	return `↳ sign in once to continue: ./run signin ${host} ${JSON.stringify(app)}`;
}

/** Follow to the end, then pull. Detaching leaves both for a later `follow`/`pull`. */
async function attach(host: string, jobId: string, fromByte: number): Promise<number> {
	const controller = new AbortController();
	process.on("SIGINT", () => {
		console.error(`\ndetached — the run continues on ${host}. Reattach: ./run dispatch ${host} follow ${jobId} --from <byte>`);
		controller.abort();
	});

	const followed = await follow(host, jobId, (text) => process.stdout.write(text), { fromByte, signal: controller.signal });
	if (followed.error) console.error(`log stream ended: ${followed.error}`);
	if (!followed.done) {
		console.error(`still running — resume with: ./run dispatch ${host} follow ${jobId} --from ${followed.nextOffset}`);

		return 0;
	}

	const result = await pull(host, jobId);
	const pulled = report(result);
	const remedy = signinRemedy(followed.exitCode, host, result.job?.app);
	if (remedy) console.error(remedy);

	// The vault's other end (on by default; YARN_VAULT=0 disables). The run just left a session on this box: if it
	// got past its readiness gate (exit 3 is a signed-out refusal), seal that now-current session
	// back into the vault so the next run — anywhere — starts from it, and fold the outcome into
	// the ledger so it LEARNS whether this app's session survived the move. A readiness refusal is
	// deliberately NOT checked in: overwriting the vault's good bundle with a signed-out one is the
	// one write that would make the feature lose sessions. `movedFrom` is read before the checkin,
	// since the checkin rewrites `lastHost`.
	if (vaultEnabled() && result.job) {
		const { app, operator } = result.job;
		const signedIn = followed.exitCode !== READINESS_REFUSED;
		try {
			const movedFrom = sessionPlan({ app, operator }).source;
			if (signedIn) {
				const ci = await checkinSession({ host, app, operator, signedIn });
				if (ci.stored) console.error(`vault: sealed ${operator}'s ${app} session from ${host} (${ci.bytes ?? 0}B)`);
			}
			recordRunOutcome({ host, app, operator, signedIn, ...(movedFrom ? { movedFrom } : {}) });
			if (movedFrom && movedFrom !== host)
				console.error(`vault: ${app} session ${signedIn ? "roams — install on any box worked" : "is device-bound on this app — steering future runs to sign in on the box"} (moved ${movedFrom} → ${host})`);
		} catch (e) {
			console.error(`vault: checkin skipped — ${(e as Error).message}`);
		}
	}
	// A grounding pass is only worth its forty minutes once; every other Mac should have it
	// without anyone remembering to ask. Best-effort by construction — the run already
	// succeeded, and a sleeping peer must not turn that into a failure.
	if (result.job?.kind === "explore" && result.artifacts.some((a) => a.key === "appmap" && a.state === "pulled")) {
		const note = await autoSync();
		if (note) console.error(note);
	}

	return followed.state === "done" ? pulled : 1;
}

function report(pulled: PullResult): number {
	for (const a of pulled.artifacts) if (a.state !== "missing") console.error(`${a.state === "pulled" ? "✓" : "✗"} ${a.rel}${a.detail ? ` — ${a.detail}` : ""}`);

	return pulled.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err) => {
			console.error(`dispatch failed: ${(err as Error).message}`);
			process.exit(1);
		},
	);
