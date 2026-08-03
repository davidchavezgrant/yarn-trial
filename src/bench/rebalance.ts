import { dispatch as dispatchFleet, type DispatchResult, stopRemote } from "../remote/control/dispatch.js";
import { type FleetRow, fleetStatus, stranded } from "../remote/control/fleet.js";
import { type Manifest, manifestPath, readManifest, writeManifest } from "./manifest.js";
import { armById } from "./matrix.js";
import { dispatchOptionsFor } from "./orchestrate.js";

/**
 * Move queued jobs onto Macs that went idle after those jobs were queued elsewhere.
 *
 * `stranded()` has computed these moves since 2026-07-31 and nothing ever called it — the same
 * shape as `poisonedHosts()`, which sat unconsumed until it was wired up. This is its consumer.
 *
 * WHY it is needed at all: `dispatch auto` binds a job to a host at SUBMIT time — the first idle
 * Mac, or when none is idle the shortest queue — and the queue is per host with no migration.
 * Submission is even (measured 2026-08-03: 62/69/63 across 198 runs); SERVICE TIME is not. One
 * burst that day had mac1 finish a single job in 3534s while mac2 did five and mac3 six, so both
 * drained and idled while mac1 held six jobs nobody could take. The imbalance is emergent, which
 * is why balancing the submission never fixed it.
 *
 * The manifest surgery is the part worth reading twice. A move REPLACES the entry rather than
 * stopping one and adding another, because `stopped` is deliberately not a technical failure
 * (collect.ts: auto-retrying what a human killed is the wrong instinct) — so a stop-and-resubmit
 * would leave a row that still counts as a sample, and the arm would quietly finish one short.
 * A moved job is the SAME sample on a different Mac; there is nothing to record but the new
 * host and job id.
 */
export interface RebalanceDeps {
	rows?: FleetRow[];
	stopFn?: (host: string, jobId: string) => Promise<unknown>;
	dispatchFn?: (opts: ReturnType<typeof dispatchOptionsFor> & { host: string }) => Promise<DispatchResult>;
	date?: string;
	model?: string;
	root?: string;
	log?: (s: string) => void;
}

export interface Move {
	armId: string;
	from: string;
	to: string;
	oldJobId: string;
	newJobId: string;
}

export async function rebalanceStranded(deps: RebalanceDeps = {}): Promise<Move[]> {
	const log = deps.log ?? (() => {});
	const rows = deps.rows ?? (await fleetStatus());
	const moves = stranded(rows);
	if (!moves.length) return [];

	const stop = deps.stopFn ?? ((host: string, jobId: string) => stopRemote(host, jobId));
	const send = deps.dispatchFn ?? ((o: Parameters<typeof dispatchFleet>[0]) => dispatchFleet(o));
	let manifest: Manifest = readManifest(deps.date, deps.root);
	const done: Move[] = [];
	let dropped = false;

	for (const m of moves) {
		const entry = manifest.entries.find((e) => e.jobId === m.job.jobId);
		if (!entry) {
			// An ad-hoc run — dispatched by hand, no matrix row. Real work on a real Mac, and not
			// ours to move: nothing here knows how to rebuild a spec the manifest never held.
			log(`\u2013 ${m.job.jobId} on ${m.from}: no manifest row (ad-hoc run) — left where it is`);
			continue;
		}
		const arm = armById(entry.armId);
		if (!arm) {
			log(`\u2013 ${entry.armId}: no such arm in this matrix — left on ${m.from}`);
			continue;
		}

		// STOP FIRST. A queued job holds no process (pid 0), so cancelling destroys no work — but
		// re-dispatching before the cancel lands would put the same sample on two Macs, and the
		// second one to finish would overwrite the first is not a race worth having.
		try {
			await stop(m.from, m.job.jobId);
		} catch (e) {
			log(`\u2013 ${entry.armId}: could not cancel on ${m.from} (${(e as Error).message}) — left where it is`);
			continue;
		}

		const res = await send({ ...dispatchOptionsFor(arm, entry.recipe, entry.model), host: m.to, queue: false });
		if (!res.ok) {
			// The job is now cancelled on `from` and not accepted on `to`. Say so loudly: the
			// sample still owes a run, and the next dispatch wave is what re-submits it.
			log(`\u2717 ${entry.armId}: cancelled on ${m.from} but ${m.to} refused it (${res.error}) — the sample is owed and will re-dispatch`);
			manifest = { ...manifest, entries: manifest.entries.filter((e) => e.jobId !== m.job.jobId) };
			dropped = true;
			continue;
		}

		// NOT updateEntry: that matches on (armId, jobId), the manifest's primary key, and a move
		// changes the jobId — so it would match nothing and silently leave the old row. A move is
		// a RE-KEY of an existing sample, which is a different operation from an update.
		manifest = {
			...manifest,
			entries: manifest.entries.map((e) =>
				e.jobId === m.job.jobId ? { ...entry, jobId: res.jobId, host: res.host.name, state: res.queued ? ("queued" as const) : ("running" as const) } : e,
			),
		};
		done.push({ armId: entry.armId, from: m.from, to: m.to, oldJobId: m.job.jobId, newJobId: res.jobId });
		log(`\u2192 ${entry.armId}: ${m.from} \u2192 ${m.to} (${m.job.jobId} \u2192 ${res.jobId})`);
	}

	// `dropped` covers the refusal path, which changes the manifest without producing a move.
	if (done.length || dropped) writeManifest(manifest, deps.root);

	return done;
}

/** Where the manifest this wrote lives — for callers that log a path. */
export const rebalancedManifestPath = manifestPath;
