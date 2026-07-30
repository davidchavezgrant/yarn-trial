import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { appmapsDir, outDir } from "../paths.js";

import { type HostEntry, type Inventory, loadHosts } from "./hosts.js";
import { assertSafeRemotePath, remoteDataRoot, type RsyncRunner, runRsync, runSsh, rsyncShell, type SshRunner } from "./ssh.js";

/**
 * Make a grounding pass done on one Mac count on all of them.
 *
 * `docs/appmaps/` is per-checkout, and until now three transports touched it and none of them
 * converged: `provision` pushes local→remote, `pull` brings one job's map back to whoever
 * dispatched it, and nothing moves a map sideways. Ground an app on mac1 and mac2 stays
 * ungrounded — the run does not fail, it just quietly runs without the map, which is the
 * expensive kind of wrong. `remoteApps().grounded` was already reporting this correctly; there
 * was simply nothing to act on it.
 *
 * HOW IT DECIDES. Newest `capturedAt` wins, read out of the graph. Deliberately not mtime:
 * `git checkout` restamps every file it writes, so a fresh clone would look newer than a
 * grounding pass that finished last week and would overwrite it. `capturedAt` is the pass's
 * own stamp and travels inside the artifact.
 *
 * HOW IT MOVES. rsync, host by host, into a staging directory under out/ so the comparison
 * happens here against real files rather than over a remote query. Two reasons that is the
 * right shape: the whole directory is ~70KB, so collecting the fleet costs less than inventing
 * a protocol for it; and it needs no new runnerctl verb, so the three Macs do not have to be
 * re-provisioned to gain this.
 *
 * WHAT IT IS NOT. Hub and spoke, not peer to peer: an operator's checkout is the hub, and two
 * operators on two laptops can still hold different views until one of them syncs. A shared
 * bucket would fix that and is the upgrade path if the fleet grows.
 */

/** Where collected copies land. Under out/ because it is derived and safe to delete. */
export function stagingDir(): string {
	return `${outDir()}/appmap-sync`;
}

export interface MapVersion {
	/** File stem, e.g. "notion-calendar". The unit of sharing. */
	slug: string;
	/** From the graph. Absent on prose-only maps, which predate it. */
	capturedAt?: string;
	/** Whether a `.json` sits beside the `.md`. */
	hasGraph: boolean;
	/** Basenames present, both halves when there are two. */
	files: string[];
}

/**
 * Read a directory of appmaps into one entry per app.
 *
 * A `.json` that does not parse is treated as absent rather than fatal: the realistic way to
 * meet one is to have rsynced a file an exploration pass was midway through writing, and the
 * right response to that is to leave the app alone this round, not to abort the sync.
 */
export function readAppmaps(dir: string): Map<string, MapVersion> {
	const out = new Map<string, MapVersion>();
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return out; // A host with no appmaps at all is a normal state, not an error.
	}

	for (const file of entries.sort()) {
		const m = /^(.+)\.(md|json)$/.exec(file);
		if (!m) continue;
		const [, slug, ext] = m;
		const v = out.get(slug) ?? { slug, hasGraph: false, files: [] };
		v.files.push(file);
		if (ext === "json") {
			const stamp = readCapturedAt(path.join(dir, file));
			if (stamp) {
				v.hasGraph = true;
				v.capturedAt = stamp;
			}
		}
		out.set(slug, v);
	}

	return out;
}

function readCapturedAt(file: string): string | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { capturedAt?: unknown };

		return typeof parsed.capturedAt === "string" && parsed.capturedAt ? parsed.capturedAt : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Does `a` beat `b`?
 *
 * Three rungs, weakest last. Two stamped maps compare by stamp. A stamped map beats an
 * unstamped one, because a graph carries the scope-collision data that prose cannot express
 * and losing it silently switches those warnings off. Two unstamped maps are held equal —
 * there is no evidence either way, and overwriting on no evidence is how a good map gets
 * replaced by a worse one.
 */
export function beats(a: MapVersion, b: MapVersion): boolean {
	if (a.capturedAt && b.capturedAt) return a.capturedAt > b.capturedAt;

	return !!a.capturedAt && !b.capturedAt;
}

export interface Source {
	/** Host name, or "local" for this checkout. */
	name: string;
	dir: string;
	maps: Map<string, MapVersion>;
}

export interface Transfer {
	slug: string;
	/** Where the winning copy is, as a source name. */
	from: string;
	/** Where it is going. */
	to: string;
	/** Why: "missing" (destination has none) or "older". */
	reason: "missing" | "older";
}

/**
 * Who should send what to whom.
 *
 * Pure, so the interesting half is testable without a fleet. Both halves of a map travel
 * together — a `.md` delivered without its `.json` is an appmap whose scope warnings are off,
 * which is the failure that lets an agent edit a per-document override instead of the default.
 */
export function planTransfers(sources: Source[]): Transfer[] {
	const slugs = new Set(sources.flatMap((s) => [...s.maps.keys()]));
	const transfers: Transfer[] = [];

	for (const slug of [...slugs].sort()) {
		// Ties go to the earlier source, and `local` is passed first, so a hub map and a remote
		// map stamped in the same millisecond do not ping-pong between syncs.
		let winner: Source | undefined;
		for (const s of sources) {
			const here = s.maps.get(slug);
			if (!here) continue;
			if (!winner || beats(here, winner.maps.get(slug)!)) winner = s;
		}
		if (!winner) continue;

		for (const dest of sources) {
			if (dest === winner) continue;
			const have = dest.maps.get(slug);
			if (!have) transfers.push({ slug, from: winner.name, to: dest.name, reason: "missing" });
			else if (beats(winner.maps.get(slug)!, have)) transfers.push({ slug, from: winner.name, to: dest.name, reason: "older" });
		}
	}

	return transfers;
}

export interface HostSync {
	host: string;
	/** Absent when the host could not be reached or did not report a data root. */
	root?: string;
	collected: boolean;
	sent: string[];
	received: string[];
	reason?: string;
}

export interface SyncResult {
	transfers: Transfer[];
	hosts: HostSync[];
	/** Apps whose local copy this sync replaced with a newer one from the fleet. */
	adopted: string[];
	dryRun: boolean;
}

export interface SyncOptions {
	inventory?: Inventory;
	/** Restrict to one app's map. Used by the post-grounding fan-out. */
	slug?: string;
	hosts?: HostEntry[];
	dryRun?: boolean;
	run?: SshRunner;
	rsync?: RsyncRunner;
	timeoutMs?: number;
	/** Local appmaps directory. Injected for tests; production always uses the real one. */
	localDir?: string;
	/** Staging root for collected copies. Injected for tests. */
	stageDir?: string;
}

const SYNC_TIMEOUT_MS = 60_000;
const REMOTE_REL = "docs/appmaps";

/**
 * Bring the fleet to one view of every app's map.
 *
 * Never throws and never fails a caller: this runs on the path of ordinary runs, and a Mac
 * that is asleep must cost a log line, not a refused dispatch. Every host is independent —
 * one unreachable machine does not stop the other two converging.
 */
export async function syncAppmaps(opts: SyncOptions = {}): Promise<SyncResult> {
	const run = opts.run ?? runSsh;
	const rsync = opts.rsync ?? runRsync;
	const timeoutMs = opts.timeoutMs ?? SYNC_TIMEOUT_MS;
	const localDir = opts.localDir ?? appmapsDir();
	const stage = opts.stageDir ?? stagingDir();
	const hosts = opts.hosts ?? inventoryHosts(opts.inventory);
	const dryRun = !!opts.dryRun;

	fs.mkdirSync(localDir, { recursive: true });
	const local: Source = { name: "local", dir: localDir, maps: readAppmaps(localDir) };
	const sources: Source[] = [local];
	const reports: HostSync[] = [];

	for (const host of hosts) {
		const report: HostSync = { host: host.name, collected: false, sent: [], received: [] };
		reports.push(report);
		const root = await remoteDataRoot(host, run).catch(() => undefined);
		if (!root) {
			report.reason = "unreachable, or did not report a data root";
			continue;
		}
		report.root = root;

		const dir = path.join(stage, host.name);
		fs.mkdirSync(dir, { recursive: true });
		const remote = `${root}/${REMOTE_REL}`;
		try {
			assertSafeRemotePath(remote);
		} catch (e) {
			report.reason = (e as Error).message;
			continue;
		}

		// --delete so the staging copy is that Mac's directory rather than an accumulation of
		// every map it has ever held; the comparison below is only sound if it reflects now.
		const got = await rsync(
			["-a", "--delete", "-e", rsyncShell(host), `${host.ssh.user}@${host.ssh.host}:${remote}/`, `${dir}/`],
			{ timeoutMs },
		);
		// A host with no appmaps directory yet is not a failed collection: it has no maps, which
		// is exactly what an empty staging directory says, and it is a destination either way.
		report.collected = got.code === 0 || isMissingSource(got.stderr);
		if (!report.collected) {
			report.reason = firstLine(got.stderr) || `rsync exited ${got.code}`;
			continue;
		}

		sources.push({ name: host.name, dir, maps: readAppmaps(dir) });
	}

	const all = planTransfers(sources);
	const transfers = opts.slug ? all.filter((t) => t.slug === opts.slug) : all;
	const byName = new Map(sources.map((s) => [s.name, s]));
	const adopted: string[] = [];
	if (dryRun) return { transfers, hosts: reports, adopted, dryRun };

	for (const t of transfers) {
		const from = byName.get(t.from);
		const files = from?.maps.get(t.slug)?.files ?? [];
		if (!from || !files.length) continue;

		if (t.to === "local") {
			for (const f of files) fs.copyFileSync(path.join(from.dir, f), path.join(localDir, f));
			adopted.push(t.slug);
			local.maps.set(t.slug, from.maps.get(t.slug)!);
			continue;
		}

		const host = hosts.find((h) => h.name === t.to);
		const report = reports.find((r) => r.host === t.to);
		if (!host || !report?.root) continue;

		const sent = await rsync(
			[
				"-a",
				"-e", rsyncShell(host),
				...files.map((f) => path.join(from.dir, f)),
				`${host.ssh.user}@${host.ssh.host}:${report.root}/${REMOTE_REL}/`,
			],
			{ timeoutMs },
		);
		if (sent.code === 0) {
			report.received.push(t.slug);
			reports.find((r) => r.host === t.from)?.sent.push(t.slug);
		} else report.reason = firstLine(sent.stderr) || `sending ${t.slug} failed (rsync ${sent.code})`;
	}

	return { transfers, hosts: reports, adopted, dryRun };
}

/** rsync says 23 with an ENOENT when the source path is simply not there. */
function isMissingSource(stderr: string): boolean {
	return /No such file or directory/i.test(stderr);
}

function firstLine(s: string): string {
	return (s || "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

function inventoryHosts(inv?: Inventory): HostEntry[] {
	try {
		return (inv ?? loadHosts()).hosts;
	} catch {
		return []; // No fleet configured is the local-only case, not a failure.
	}
}

/**
 * The automatic half.
 *
 * Called on the ordinary paths — before a dispatch, and after a grounding pass comes home —
 * where the operator has not asked for a sync and must not be made to wait on a bad one.
 * Swallows everything and answers with a one-line summary, or undefined when nothing moved.
 */
export async function autoSync(opts: SyncOptions = {}): Promise<string | undefined> {
	if (process.env.APPMAP_SYNC === "0") return undefined;

	let result: SyncResult;
	try {
		result = await syncAppmaps(opts);
	} catch (e) {
		return `appmap sync skipped: ${(e as Error).message}`;
	}

	const moved = result.transfers.length;
	const blocked = result.hosts.filter((h) => h.reason);
	if (!moved && !blocked.length) return undefined;

	const parts: string[] = [];
	if (moved) parts.push(`appmaps: ${summarise(result)}`);
	for (const h of blocked) parts.push(`appmaps: ${h.host} skipped (${h.reason})`);

	return parts.join("\n");
}

export function summarise(r: SyncResult): string {
	if (!r.transfers.length) return "already in sync";

	return r.transfers.map((t) => `${t.slug} ${t.from} → ${t.to} (${t.reason})`).join(", ");
}

const USAGE = `usage: ./run appmaps [--sync] [--app <name>]

Without --sync, reports which Mac holds which grounding and what a sync would move.
With --sync, converges the fleet: newest capturedAt wins, .md and .json travel together.
Runs automatically before a dispatch and after a grounding pass; APPMAP_SYNC=0 disables that.`;

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.includes("-h") || argv.includes("--help")) {
		console.log(USAGE);

		return;
	}

	const at = argv.indexOf("--app");
	const slug = at >= 0 ? argv[at + 1] : undefined;
	const dryRun = !argv.includes("--sync");
	const r = await syncAppmaps({ dryRun, ...(slug ? { slug } : {}) });

	for (const h of r.hosts) {
		const state = h.reason ? `✗ ${h.reason}` : `${h.received.length ? `received ${h.received.join(", ")}` : "up to date"}`;
		console.log(`  ${h.host.padEnd(10)} ${state}`);
	}
	console.log(dryRun ? `would move: ${summarise(r)}` : summarise(r));
	if (r.adopted.length) console.log(`local checkout adopted: ${r.adopted.join(", ")} — commit these`);
	if (dryRun && r.transfers.length) console.log("run with --sync to apply");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	main().catch((err) => {
		console.error(`appmaps failed: ${err}`);
		process.exit(1);
	});
