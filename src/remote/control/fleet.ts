import { pathToFileURL } from "node:url";
import { type HostEntry, type Inventory, loadHosts } from "./hosts.js";
import { DEFAULT_SSH_TIMEOUT_MS, firstLine, lastFrame, runnerArgv, runSsh, type SshResult, type SshRunner } from "./ssh.js";

/**
 * Fleet-wide status, and the host pick that follows from it.
 *
 * The organising constraint is per-host error isolation. A fan-out over three machines has
 * three independent ways to fail — unreachable, hung mid-handshake, runner not installed —
 * and the useful behaviour in all three is the same: that ROW degrades and the other two
 * still render. A rejected Promise.all would blank the whole view because one colo box is
 * rebooting, which is exactly when an operator most needs to see the other two.
 */

export type FleetState = "idle" | "busy" | "unknown";

/** One waiting job, as the runner's `status` reports it. */
export interface FleetQueueEntry {
	jobId: string;
	operator?: string;
	app?: string;
	kind?: string;
	queuedAt?: string;
}

export interface FleetRow {
	name: string;
	reachable: boolean;
	state: FleetState;
	/** Who claimed the host, when busy. */
	operator?: string;
	/** App the in-flight run is driving. */
	app?: string;
	/** Seconds the current run has been going. */
	elapsedSec?: number;
	/**
	 * The in-flight job, when busy. `serve.status()` has always returned it and this row used
	 * to drop it, which meant nothing built on a fleet row could follow or stop the very run it
	 * was displaying — the UI would show "mac2, busy, 12 min" next to a button it could not
	 * wire up.
	 */
	jobId?: string;
	/**
	 * Jobs waiting behind the current run, oldest first. Depth is what an operator decides
	 * against ("two ahead of me — use another Mac"); the entries are what the panel renders
	 * with a cancel button, so both cross rather than just a count.
	 */
	queue?: FleetQueueEntry[];
	/** Seconds since the running job's log last grew — the live-but-wedged signal. */
	logSilenceSec?: number;
	/** The runner's own verdict that the silence passed its stall threshold. Advisory. */
	stalled?: boolean;
	/**
	 * Whether the remote has its Accessibility and Screen Recording grants. A host can be
	 * perfectly reachable and still unable to run anything, and that failure is invisible
	 * until an agent gets a degraded observation — so it is surfaced as a column.
	 */
	tccOk?: boolean;
	/**
	 * Grants that exist in the TCC database but not in the running process, because they were
	 * ticked after it launched. Distinguished from a plain missing grant because the fix is the
	 * opposite: System Settings already shows the box ticked, and sending someone back there is
	 * the loop this field exists to break. Only ever set alongside `tccOk: false`.
	 */
	staleGrants?: string[];
	/** Why the row is `unknown`, short enough for a table cell. Absent when the status parsed. */
	reason?: string;
}

export interface FleetOptions {
	inventory?: Inventory;
	run?: SshRunner;
	timeoutMs?: number;
}

/**
 * One row per host, always — same length and order as the inventory, whatever happened on
 * the wire. Hosts are probed in parallel, so the fan-out costs one timeout rather than N.
 */
export function fleetStatus(opts: FleetOptions = {}): Promise<FleetRow[]> {
	const inv = opts.inventory ?? loadHosts();
	const run = opts.run ?? runSsh;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS;

	return Promise.all(inv.hosts.map((host) => hostStatus(host, run, timeoutMs)));
}

async function hostStatus(host: HostEntry, run: SshRunner, timeoutMs: number): Promise<FleetRow> {
	if (!host.hostKey) return unknown(host, "no pinned host key — run the known_hosts writer first");

	let result: SshResult;
	try {
		// Belt and braces over runSsh's own timeout. The runner is injectable, and an
		// injected one that never settles — or an ssh whose kill does not take — would
		// otherwise stall every other row through the Promise.all.
		result = await withTimeout(run(host, runnerArgv("status"), { timeoutMs }), timeoutMs);
	} catch (e) {
		return unknown(host, (e as Error).message);
	}
	if (result.code !== 0) return unknown(host, firstLine(result.stderr) || `runnerctl exited ${result.code}`);

	// Record<string, unknown>, not any: this is a remote process's stdout, so every field below
	// is checked before use and `any` would silently let a future field skip that check.
	// `lastFrame` rather than JSON.parse over the whole stdout, because a login banner or an
	// ssh warning ahead of the reply frame used to throw here — degrading a healthy idle host
	// to "unknown", which `--host auto` reads as no idle host in the fleet at all.
	const parsed: Record<string, unknown> | undefined = lastFrame(result.stdout);
	// runnerctl does not exist yet, and a host without it answers with nothing parseable.
	// That is a degraded row, not a crash.
	if (!parsed) return { name: host.name, reachable: true, state: "unknown", reason: "status output was not JSON" };

	const state: FleetState = parsed?.state === "idle" || parsed?.state === "busy" ? parsed.state : "unknown";

	// Shape-checked like everything else off the wire: an entry with no jobId cannot be
	// followed or cancelled, so it is dropped rather than rendered as a dead row.
	const queue = Array.isArray(parsed?.queue)
		? parsed.queue
				.filter((q: unknown): q is Record<string, unknown> => !!q && typeof q === "object" && typeof (q as any).jobId === "string")
				.map((q) => ({
					jobId: String(q.jobId),
					...(typeof q.operator === "string" ? { operator: q.operator } : {}),
					...(typeof q.app === "string" ? { app: q.app } : {}),
					...(typeof q.kind === "string" ? { kind: q.kind } : {}),
					...(typeof q.queuedAt === "string" ? { queuedAt: q.queuedAt } : {}),
				}))
		: [];

	return {
		name: host.name,
		reachable: true,
		state,
		...(typeof parsed?.operator === "string" ? { operator: parsed.operator } : {}),
		...(typeof parsed?.app === "string" ? { app: parsed.app } : {}),
		...(typeof parsed?.elapsedSec === "number" ? { elapsedSec: parsed.elapsedSec } : {}),
		...(typeof parsed?.jobId === "string" ? { jobId: parsed.jobId } : {}),
		...(typeof parsed?.logSilenceSec === "number" ? { logSilenceSec: parsed.logSilenceSec } : {}),
		...(parsed?.stalled === true ? { stalled: true } : {}),
		...(queue.length ? { queue } : {}),
		...(typeof parsed?.tccOk === "boolean" ? { tccOk: parsed.tccOk } : {}),
		...(Array.isArray(parsed?.staleGrants) && parsed.staleGrants.length ? { staleGrants: parsed.staleGrants.map(String) } : {}),
		...(state === "unknown" ? { reason: `runner reported state ${JSON.stringify(parsed?.state)}` } : {}),
	};
}

function unknown(host: HostEntry, reason: string): FleetRow {
	return { name: host.name, reachable: false, state: "unknown", reason };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		// Not unref'd: a hung host means nothing else is holding the event loop open, and an
		// unref'd timer would let the process drain with the fan-out still pending — the
		// exact stall this exists to prevent.
		const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
		p.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}

/**
 * Host to use for `--host auto`.
 *
 * ADVISORY. Between this pick and the submit that follows, another operator can claim the
 * same machine — the window is a full round trip wide and no amount of local bookkeeping
 * closes it. The claim is therefore atomic on the remote side, and losing the race is an
 * expected outcome: the caller takes the rejection and tries the next idle host rather than
 * treating it as an error. Anything read here is a hint about which host to ask first.
 */
export function pickIdleHost(rows: FleetRow[]): FleetRow | undefined {
	return rows.find((r) => r.reachable && r.state === "idle");
}

/**
 * Host to QUEUE on when nobody is idle: the busy host with the shortest line, ties going to
 * inventory order. Same advisory nature as `pickIdleHost` — the length read here can be
 * stale by a round trip, and the submit's `position` reply is the truth.
 */
export function pickShortestQueue(rows: FleetRow[]): FleetRow | undefined {
	const busy = rows.filter((r) => r.reachable && r.state === "busy");
	if (!busy.length) return undefined;

	return busy.reduce((best, r) => ((r.queue?.length ?? 0) < (best.queue?.length ?? 0) ? r : best));
}

/**
 * Queued jobs that should move, because a host went idle after they were queued elsewhere.
 *
 * The queue is PER HOST and jobs never migrate: `dispatch auto` picks a host at submit time,
 * and once no host is idle it queues on the shortest line. That choice is right at submit
 * time and wrong a minute later — whichever host finishes FIRST may not be the one holding
 * the line. Observed 2026-07-31: mac2 sat idle for six minutes while an explore waited behind
 * a long-running pass on mac1.
 *
 * Moving a QUEUED job is cheap and safe: it has no process yet (pid 0), so cancelling it
 * destroys no work — only the bookkeeping. A RUNNING job is never touched.
 *
 * Returns pairs oldest-queued-first, one per idle host, so a caller moving them cannot
 * oversubscribe a Mac. Advisory like the pickers above: the state read here can be a round
 * trip stale, and the re-submit's reply is the truth.
 */
export function stranded(rows: FleetRow[]): Array<{ job: FleetQueueEntry; from: string; to: string }> {
	const idle = rows.filter((r) => r.reachable && r.state === "idle");
	if (!idle.length) return [];
	// Oldest first across all queues: the job that has waited longest has the best claim on
	// the first free Mac, regardless of which line it is standing in.
	const waiting = rows
		.filter((r) => r.reachable && (r.queue?.length ?? 0) > 0)
		.flatMap((r) => (r.queue ?? []).map((job) => ({ job, from: r.name })))
		// queuedAt is an ISO string; oldest first means SMALLEST timestamp. An entry without
		// one sorts last rather than first — an unknown wait is not evidence of a long one.
		.sort((a, b) => (a.job.queuedAt ?? "9999").localeCompare(b.job.queuedAt ?? "9999"));

	return waiting.slice(0, idle.length).map((w, i) => ({ ...w, to: idle[i].name }));
}

/** `./run hosts` — the fleet as a table. The `reason` column is the whole value of this view. */
async function main(): Promise<void> {
	const rows = await fleetStatus();
	for (const r of rows) {
		// The job id is here because it is the argument to the next command someone types:
		// seeing a busy host is only useful if you can follow or stop the run on it.
		const line = r.queue?.length ? ` · +${r.queue.length} queued` : "";
		const busy = r.state === "busy" ? ` ${r.operator ?? "?"} · ${r.app ?? "?"} · ${r.elapsedSec ?? 0}s${r.jobId ? ` · ${r.jobId}` : ""}${line}` : "";
		const tcc = r.staleGrants?.length
			? ` [${r.staleGrants.join(" + ")} GRANTED TOO LATE — ./run provision --restart]`
			: r.tccOk === false
				? " [NO TCC GRANTS]"
				: "";
		console.log(`${r.name.padEnd(8)} ${r.state.padEnd(8)}${busy}${tcc}${r.reason ? ` — ${r.reason}` : ""}`);
	}
	// Nonzero when nothing is usable, so a script can gate on it without parsing the table.
	if (!pickIdleHost(rows)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	main().catch((err) => {
		console.error(`fleet status failed: ${err}`);
		process.exit(1);
	});
