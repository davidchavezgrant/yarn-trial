import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { compileProcedure, readProcedure, procedureFileFor } from "../../core/procedure.js";
import { TargetError, webTarget } from "../../core/target.js";
import { LIVE_DIR, RUN_FILES, archiveRun, dataRoot, proceduresDir, runFile, runRel } from "../../paths.js";
import { EXIT_REFUSED as CTL_REFUSED, EXIT_UNREACHABLE as CTL_UNREACHABLE } from "../runner/ctl.js";
import type { JobArtifacts, JobKind, JobRecord } from "../runner/jobs.js";
import { autoSync, autoSyncRecipes, autoSyncProcedures, type SyncOptions } from "./appmaps.js";
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
 *
 * 20s was that budget until 2026-08-03, when three consecutive submits to three different Macs
 * reported "no answer within 20s" and had in fact delivered nothing — the ambiguous failure this
 * comment names, arriving in triplicate. The condition is the one the error text already guessed
 * at: the runner is mid-launch of the target app, which on a cold Mac routinely outlasts 20s.
 *
 * 60s because nothing reads this budget except the submit itself, and the asymmetry is stark. A
 * submit that waits an extra 40s costs 40s once. A submit that gives up early costs a run the
 * autopilot then counts as a dispatch failure and re-dispatches — against a per-arm retry budget
 * that exists to stop a sick host, so spending it on a healthy one that was merely slow is how a
 * pass stops for the wrong reason. Across a 378-run pass the first dispatch to each Mac meets
 * exactly the cold-start condition above.
 */
const SUBMIT_TIMEOUT_MS = 60_000;

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
	/** `USE_RECIPES=1`: ground on the PROSE write-up harvested from a judged-PASS run of this
	 *  exact task. A recipe is READ, not executed — the model still chooses every action — which
	 *  is what separates it from a procedure (machine-readable JSON, replayed step by step under
	 *  `kind: "replay"` above). The comment that sat here belonged to `useCurated` and was left
	 *  behind by that swap, which is why both fields carry their own now. */
	useRecipes?: boolean;
	/** Which harvested recipe to load: the write-up by an agent that HAD its appmap, or the one by
	 *  an agent that did not. Two different experiments, so they never share an artifact. */
	recipeLineage?: "grounded" | "ungrounded";
	/** Injected in tests, like `sync`/`syncProcedures`. */
	syncRecipes?: (opts: { inventory?: Inventory }) => Promise<string | undefined>;
	/** `USE_CURATED=1`: ground from docs/curated/<app>.md — prose a HUMAN wrote, rather than prose
	 *  an earlier run earned. It is the hand-authored tier the recipe tiers are measured against,
	 *  which is why it stays a separate field instead of another recipe lineage. */
	useCurated?: boolean;
	/**
	 * The runaway backstop for the child run (AGENT_STEPS on the runner). NOT a budget: a run is
	 * never meant to fail because it ran out of steps, so this exists only so a model looping
	 * forever cannot hold a fleet Mac. `stallSteps` below is what actually ends a run. Absent =
	 * the child's own default (100).
	 */
	steps?: number;
	/**
	 * `AGENT_STALL_STEPS` on the child: consecutive steps with nothing verified before the run is
	 * called stuck. THE stopping condition, which is exactly why it is tunable per arm — the
	 * backstop above was threaded all the way down the wire while the number that actually ends
	 * runs stayed a constant nobody could reach. Absent = the child's own default (8).
	 */
	stallSteps?: number;
	/** SNAP_PX on the child: snap a coordinate action to a control within N px. 0 = off. */
	snapPx?: number;
	/** Replay only: procedure file path RELATIVE to the data root — the same key on both machines. */
	procedure?: string;
	/** Replay only: `--no-rescue`, the unattended posture — a broken step fails instead of calling the model. */
	noRescue?: boolean;
	/** Web target: `--url <url>` on the child argv (task and explore). The app field stays the display label. */
	url?: string;
	/** `APPMAP_VARIANT=vision` on the child: ground from the `<slug>.vision.*` map. A dedicated
	 *  option rather than a generic env dict — arbitrary env crossing the wire is a surface
	 *  nothing needs, and a named field is one the runner can validate. */
	appmapVariant?: "vision" | "novision";
	/** `AGENT_MODEL=<id>` on the child: which model runs the loop (task/explore/replay alike).
	 *  Absent = the child's own default (makeClient). The benchmark's model dimension. */
	model?: string;
	/** `CLEANUP=off` on the child: skip the post-run teardown, so the run ends on the changed
	 *  state. One literal, not the child's whole off|advisory|block vocabulary: advisory is the
	 *  child's default and needs no field on the wire, and block stays operator-local — the two
	 *  callers this exists for (filmed takes, state-restoring maintenance runs) both want off,
	 *  and widening the union later is additive. A named field rather than a generic env dict,
	 *  for exactly the appmapVariant rationale above. */
	cleanup?: "off";
	/**
	 * Wait in line instead of being refused when the host is busy. Default true — the queue is
	 * why an operator can dispatch five runs and close the lid. `false` restores the old
	 * refusal for callers that want to react to busy themselves.
	 */
	queue?: boolean;
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
	 * The procedure fan-out, run before a replay submit only — the runner refuses a replay whose
	 * procedure is not already on its disk, and this is what puts it there. Injected for the same
	 * reason as `sync`.
	 */
	syncProcedures?: (opts: SyncOptions) => Promise<string | undefined>;
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
	 * them under the local root unchanged, so `out/bench/live/<id>/run.json` means one file wherever you
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
	if (kind === "replay" && !opts.procedure?.trim()) throw new Error("a replay dispatch needs a procedure path (relative to the data root)");

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
		useCurated: Boolean(opts.useCurated),
		useRecipes: Boolean(opts.useRecipes),
		...(opts.snapPx !== undefined ? { snapPx: opts.snapPx } : {}),
		...(opts.recipeLineage ? { recipeLineage: opts.recipeLineage } : {}),
		noRescue: Boolean(opts.noRescue),
		...(opts.backend ? { backend: opts.backend } : {}),
		// The path is data-root-relative — the one key both machines share. The runner owns
		// its validation (path discipline, file presence); nothing here second-guesses it.
		...(kind === "replay" ? { procedure: opts.procedure } : {}),
		...(opts.url ? { url: opts.url } : {}),
		...(opts.appmapVariant ? { appmapVariant: opts.appmapVariant } : {}),
		...(opts.model ? { model: opts.model } : {}),
		...(opts.cleanup ? { cleanup: opts.cleanup } : {}),
		// `!== undefined`, not a truthy check, for both numbers. A truthy check silently drops 0,
		// and while 0 is invalid for either field today, "the runner refuses it" and "the wire
		// swallowed it" are different outcomes — the first is an error an operator can read, the
		// second is the arm quietly running with the child's default. That is the same failure
		// mode as useRecipes never being parsed, and it is not worth re-earning for a keystroke.
		...(opts.steps !== undefined ? { steps: opts.steps } : {}),
		...(opts.stallSteps !== undefined ? { stallSteps: opts.stallSteps } : {}),
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
	// A replay adds the procedure fan-out on top (a replay still reads its appmap graph for the
	// teardown's scope resolution, so the appmap sync is not skipped for it). The procedure sync
	// runs first because the runner REFUSES a replay whose procedure file is absent — this is the
	// step that makes the submit below admissible.
	const procedureNote = kind === "replay" ? await (opts.syncProcedures ?? autoSyncProcedures)({ inventory: inv }) : undefined;
	// A USE_RECIPES run needs its recipe on the target Mac for the same reason a replay
	// needs its procedure. Unlike the replay the runner does NOT refuse when it is missing — the
	// child just falls back to the appmap tier and reports the wrong label — so this sync is the
	// only thing standing between phase 6 and six runs of mislabelled data.
	const recipeNote = opts.useRecipes ? await (opts.syncRecipes ?? autoSyncRecipes)({ inventory: inv }) : undefined;
	const appmapNote = await (opts.sync ?? autoSync)({ inventory: inv });
	const syncNote = [procedureNote, recipeNote, appmapNote].filter(Boolean).join("\n") || undefined;

	for (const { host, queue } of targets) {
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
				...(syncNote ? { syncNote } : {}),
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
	/**
	 * Back the pulled run up locally. The run's OWN archiveRun fired on the colo Mac, so the
	 * backup exists there and not here — and "every finished run has a backup" is the invariant
	 * `./run runs purge` is safe under. `drop`/`purge` do back up before deleting, so nothing was
	 * ever at risk; this closes the gap between the documented rule and the disk.
	 *
	 * Non-fatal, and after the artifacts land: a backup that cannot be taken must not turn a
	 * successful pull into a failed one.
	 */
	if (!failed.length)
		try {
			archiveRun(jobId, path.join(localRoot, "out"));
		} catch {}

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
	// ONE directory, because that is now what a run IS (paths.ts): job.json, the console log,
	// the run log, the journal, the step frames and the recording all live under out/bench/live/<id>.
	//
	// This used to be a five-way fan-out of declared and DERIVED paths, and the derived ones
	// were where it broke: step frames had to be inferred from the run log's existence because
	// no artifact field named them, and for a while nothing inferred them at all. The offline
	// judge trusts a screenshot only when its path names a per-run steps directory, precisely
	// so one run cannot grade another's pixels — so a whole matrix came back VISUAL UNAVAILABLE
	// with half the judge's signal silently blank. A directory cannot forget its own contents.
	const out: Source[] = [{ key: "run", rel: runRel(job.id), dir: true }];
	// The pre-consolidation trees, for records written before 2026-08-01. A job record outlives
	// a layout change — one dispatched before the move and pulled after it must still bring its
	// artifacts home — and the record itself says which layout it belongs to: `log` is the one
	// field every kind of job declares, so where IT points is what the rest followed.
	//
	// Derived rather than declared is what made this fragile before: step frames had no artifact
	// field at all and were inferred from the run log's existence, and for a while nothing
	// inferred them, which blanked the offline judge's VISUAL channel across a whole matrix.
	if (!(a.log ?? "").startsWith(`out/${LIVE_DIR}/`)) {
		out.push({ key: "job", rel: `out/jobs/${job.id}`, dir: true });
		if (a.runLog) {
			out.push({ key: "runLog", rel: a.runLog, dir: false });
			out.push({ key: "stepFrames", rel: `out/runs/${job.id}-steps`, dir: true });
		}
		if (a.journal) out.push({ key: "journal", rel: a.journal, dir: false });
		if (a.checkpoint) out.push({ key: "checkpoint", rel: a.checkpoint, dir: false });
		if (a.recording) out.push({ key: "recording", rel: path.posix.dirname(a.recording), dir: true });
	}
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

const USAGE = `usage: dispatch <host|auto> "<task>" "<App>" [--backend ax|cdp] [--record] [--no-vision] [--no-ax] [--axdom-off] [--no-grounding] [--use-curated] [--use-recipes [--recipe-lineage grounded|ungrounded]] [--model <id>] [--no-cleanup] [--steps N] [--stall-steps N] [--snap-px N]
       dispatch <host|auto> "<task>" --url <https://site>
       dispatch <host|auto> explore "<App>" [--backend ax|cdp] [--no-vision] [--no-ax] [--axdom-off] [--model <id>]
       dispatch <host|auto> explore --url <https://site> [same perception flags]
       dispatch <host|auto> replay <procedure-file-or-stamp> [--no-rescue]
       dispatch <host> follow <jobId> [--from <byte>]
       dispatch <host> pull <jobId>

Submits the run to a Mac in the fleet, streams its log, and pulls the artifacts back.
Ctrl-C detaches; the run keeps going and \`follow\` re-attaches to it.
\`--no-follow\` (any submit form) skips the stream entirely: submit, print the job id, exit —
for callers whose own lifetime is capped and must not hold a 40-minute run's leash.

\`--stall-steps N\` is the stopping condition: N consecutive steps with nothing verified ends the
run (default 8). \`--steps N\` is only the runaway backstop (default 100) — raise it for a long
honest route, but a run reaching it at all is the outcome this pair exists to prevent.

\`explore\`, \`replay\`, \`follow\` and \`pull\` in the second position are subcommands, so a task
whose text is exactly one of those four words has to be dispatched through the API instead.`;

/**
 * What a `dispatch … replay <arg>` argument means: a procedure file, or a run stamp whose
 * compiled procedure already exists. The same resolution procedure-cli's replay verb applies,
 * MINUS compilation — dispatch never compiles, because compileProcedure is a gate (it refuses
 * failed/unverified/hinted runs) and minting a procedure as a side effect of a dispatch would
 * bury that refusal inside a submit error.
 *
 * The wire path is `docs/procedures/<basename>` regardless of where the local file sits: that
 * is where the fan-out lands procedures on every Mac, and the runner resolves the relative path
 * against ITS data root.
 */
function resolveReplayArg(arg: string): { app: string; procedure: string } {
	let file: string | undefined;
	if (fs.existsSync(arg)) file = arg;
	else {
		const logPath = runFile(arg, RUN_FILES.log, path.join(dataRoot(), "out"));
		if (fs.existsSync(logPath)) {
			const runLog = JSON.parse(fs.readFileSync(logPath, "utf8"));
			// Backend-keyed first, legacy second — see procedureFileFor.
			const slug_ = compileProcedure(runLog, arg).slug;
			const candidate = [procedureFileFor(proceduresDir(), slug_, runLog.task, runLog.backend), procedureFileFor(proceduresDir(), slug_, runLog.task)].find((p) => fs.existsSync(p)) ?? procedureFileFor(proceduresDir(), slug_, runLog.task, runLog.backend);
			if (!fs.existsSync(candidate)) throw new Error(`no compiled procedure for ${arg} — run: ./run procedure compile ${arg}`);
			file = candidate;
		}
	}
	if (!file) throw new Error(`${arg} is neither a procedure file nor a run stamp`);

	// The app comes out of the procedure itself — the runner needs it for the profile swap and
	// the job key, and asking the operator to retype what the artifact already records is how
	// a replay ends up leased under the wrong app name.
	return { app: readProcedure(file).app, procedure: `docs/procedures/${path.basename(file)}` };
}

/**
 * The web target, off the CLI's own argv.
 *
 * `DispatchOptions.url` was declared, `dispatch()` put it on the wire and the runner read it
 * (`serve.ts` builds `--url` onto the child argv) — and this CLI never parsed it, so the only
 * way to dispatch a web run was the bench arms' programmatic path. An operator typing the URL
 * where the app label goes got it treated as a bundle name: three notion runs on 2026-08-03
 * died with `no "https://app.notion.com.app" in /Applications`, and a fourth with `--url needs
 * a URL` because the flag itself landed in the app slot.
 *
 * The same shape as `--backend` (19550e6) and `useProcedures` (61fe8a2): every layer agrees the
 * field exists, one link never touches it, nothing errors, and the run is quietly wrong. The
 * regression test walks the CLI's parse rather than the wire, because the wire was always fine.
 *
 * `app` stays the DISPLAY LABEL and defaults to the URL, which is what the notion arms already
 * put on it — the appmap slugger recognises a target by being a URL, so a bare host would slug
 * to a name no map is written under and the run would ground on nothing.
 */
export function parseUrlArg(argv: string[]): { url?: string } | { error: string } {
	const i = argv.indexOf("--url");
	if (i < 0) return {};

	const raw = argv[i + 1];
	if (!raw || raw.startsWith("--")) return { error: "--url needs a URL, e.g. --url https://app.notion.com" };
	try {
		// VALIDATE here, but hand on the operator's RAW string. webTarget normalises through
		// `new URL()`, which appends a trailing slash to a bare origin — and that slash is not
		// cosmetic downstream: `appSlug` turns it into a run key ending "-", and the app LABEL is
		// what claims the per-operator profile. The matrix arms carry `https://app.notion.com`
		// unnormalised, so normalising here would give a CLI run a different run key and a
		// different profile claim than the arm it is meant to reproduce. (The appmap slug is
		// host-derived and identical either way, so grounding was never at risk — which is
		// exactly why this would have gone unnoticed.)
		webTarget(raw);

		return { url: raw };
	} catch (e) {
		return { error: e instanceof TargetError ? e.message : `not a valid URL: ${JSON.stringify(raw)}` };
	}
}

/**
 * A URL in the app slot is refused rather than passed through. Left alone it reaches
 * `appExecutable()`, which appends `.app` and reports a missing bundle — an error that names
 * /Applications and sends the reader to `install`, for what is a typo in the invocation.
 */
export function appSlotError(app: string | undefined, url: string | undefined): string | undefined {
	if (url || !app || !/^https?:\/\//i.test(app)) return undefined;

	return `"${app}" is a URL, not an installed app — dispatch a web target as: --url ${app}`;
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

	const parsedUrl = parseUrlArg(argv);
	if ("error" in parsedUrl) {
		console.error(parsedUrl.error);

		return 2;
	}
	const { url } = parsedUrl;
	// The positional app label, with `--url`'s own two tokens excluded: `explore --url <URL>`
	// otherwise reads "--url" as the app name, which is the fourth of the four failures above.
	const positionalApp = argv[2] && !argv[2].startsWith("--") ? argv[2] : undefined;
	const slotError = appSlotError(positionalApp, url);
	if (slotError) {
		console.error(slotError);

		return 2;
	}

	let opts: DispatchOptions;
	if (argv[1] === "explore") {
		const app = positionalApp ?? url ?? "";
		if (!app) {
			console.error(USAGE);

			return 2;
		}
		/**
		 * The PERCEPTION flags, which this branch dropped entirely.
		 *
		 * Same defect as `--url` two commits ago and the same shape as `--backend` (19550e6):
		 * `DispatchOptions` declares these, dispatch() puts them on the wire and the runner
		 * builds them onto the explore child's argv — and the CLI's explore branch parsed none
		 * of them, so `./run dispatch mac1 explore --url … --no-ax` submitted a BASELINE pass in
		 * silence. Caught 2026-08-03 by reading the queued job records rather than the console:
		 * four passes dispatched as two vision + one no-vision + one baseline all carried no
		 * flags and an appmap path of `web-app.notion.com.md` — the plain slug — where a real
		 * no-vision pass writes `web-app.notion.com.cdp.novision.md`.
		 *
		 * That is the failure this repo keeps paying for: three arms' worth of fleet time
		 * producing correctly-shaped runs under the wrong label, detectable only by inspecting
		 * an artifact path nobody looks at until collect.
		 */
		opts = {
			host,
			kind: "explore",
			app,
			...(url ? { url } : {}),
			noVision: argv.includes("--no-vision"),
			noAx: argv.includes("--no-ax"),
			axdomOff: argv.includes("--axdom-off"),
			...(argv.includes("--backend") ? { backend: argv[argv.indexOf("--backend") + 1] as "ax" | "cdp" } : {}),
			...(argv.includes("--model") ? { model: argv[argv.indexOf("--model") + 1] } : {}),
		};
	} else if (argv[1] === "replay") {
		if (!argv[2]) {
			console.error(USAGE);

			return 2;
		}
		const { app, procedure } = resolveReplayArg(argv[2]);
		opts = { host, kind: "replay", app, procedure, noRescue: argv.includes("--no-rescue") };
	} else
		// argv[1] is the task and reaches the spec untouched. No trimming, no unquoting: the
		// shell already did its splitting, and anything further would be this file editing a
		// measurement input.
		opts = {
			host,
			kind: "task",
			task: argv[1],
			// A web run's label defaults to its URL — matching what the notion arms set — so the
			// appmap slugger sees a URL and resolves the map the run is meant to ground on.
			app: positionalApp ?? url ?? "Yarn",
			...(url ? { url } : {}),
			record: argv.includes("--record"),
			noVision: argv.includes("--no-vision"),
			/**
			 * The perception/actuation flags the BENCH arms have always set programmatically and
			 * an operator could not.
			 *
			 * DispatchOptions declared `backend`, dispatch() put it on the wire and the runner
			 * read it — the CLI simply never parsed it, so `--backend ax` was accepted in silence
			 * and the run came back cdp. Same shape as useRecipes being dropped by the runner:
			 * every layer agrees the field exists and one link never touches it, so nothing
			 * errors and the run is quietly the wrong arm.
			 */
			...(argv.includes("--backend") ? { backend: argv[argv.indexOf("--backend") + 1] as "ax" | "cdp" } : {}),
			noAx: argv.includes("--no-ax"),
			axdomOff: argv.includes("--axdom-off"),
			noGrounding: argv.includes("--no-grounding"),
			...(argv.includes("--model") ? { model: argv[argv.indexOf("--model") + 1] } : {}),
			...(argv.includes("--recipe-lineage")
				? { recipeLineage: argv[argv.indexOf("--recipe-lineage") + 1] as "grounded" | "ungrounded" }
				: {}),
			// The curated-notes grounding tier (docs/curated/<app>.md), same knob the bench
			// arms use — app method knowledge belongs there, never in the task prompt.
			useCurated: argv.includes("--use-curated"),
			useRecipes: argv.includes("--use-recipes"),
			// --no-cleanup: CLEANUP=off on the child — the run ends on the changed state.
			// For filmed takes and maintenance runs whose change IS the deliverable.
			...(argv.includes("--no-cleanup") ? { cleanup: "off" as const } : {}),
			// --steps N: the runaway backstop, for a flow whose honest route outgrows the default
			// 100 (validated to an integer 1..1000 on the runner).
			...(argv.includes("--steps") ? { steps: Number(argv[argv.indexOf("--steps") + 1]) || undefined } : {}),
			...(argv.includes("--snap-px") ? { snapPx: Number(argv[argv.indexOf("--snap-px") + 1]) || undefined } : {}),
			// --stall-steps N: how patient the stall detector is, and therefore when a run ends.
			// The operator-facing knob for the ONE number that stops a run — worth reaching by
			// hand while a task's shape is still being learned, since a route with a long
			// unverifiable stretch is indistinguishable from a stuck one until you have watched it.
			...(argv.includes("--stall-steps") ? { stallSteps: Number(argv[argv.indexOf("--stall-steps") + 1]) || undefined } : {}),
		};

	const result = await dispatch(opts);

	if (!result.ok) {
		console.error(`dispatch refused: ${result.error}`);

		return 1;
	}
	console.error(`${result.jobId} on ${result.host.name}`);
	for (const note of dispatchNotes(result)) console.error(note);

	// --no-follow: submit-only is a first-class invocation, not a Ctrl-C habit. The job was
	// always runner-owned and durable; what kept dying was the CALLER — an agent session's
	// foreground tool call is killed at its 600s cap, and on 2026-08-01 that turned into a
	// cleanup reflex stopping healthy 40-minute explores at the 10-minute mark on every Mac.
	// A watcher's death must never imply the run's; this flag makes the decoupled posture
	// the invocation itself.
	if (argv.includes("--no-follow")) {
		console.error(`submitted — not following. Attach: ./run dispatch ${result.host.name} follow ${result.jobId}; artifacts when done: ./run dispatch ${result.host.name} pull ${result.jobId}`);

		return 0;
	}

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
