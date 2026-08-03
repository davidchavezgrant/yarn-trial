import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { appmapsDir, outDir, recipesDir, proceduresDir } from "../../paths.js";

import { readJsonOr } from "../../fsutil.js";
import { readCapturedAt, readGraphStamp } from "../../core/apps.js";
import { type HostEntry, type Inventory, loadHosts } from "./hosts.js";
import { assertSafeRemotePath, firstLine, remoteDataRoot, type RsyncRunner, runRsync, runSsh, rsyncShell, type SshRunner } from "./ssh.js";

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

/**
 * Compiled procedures stage apart from appmaps: each collect rsyncs with `--delete`, so sharing
 * one directory would have the procedure collect erase the appmap staging mid-dispatch.
 */
export function procedureStagingDir(): string {
	return `${outDir()}/procedure-sync`;
}

/** And recipes apart from both, for the same `--delete` reason. */
export function recipeStagingDir(): string {
	return `${outDir()}/recipe-sync`;
}

export interface MapVersion {
	/** File stem, e.g. "notion-calendar". The unit of sharing. */
	slug: string;
	/** From the graph. Absent on prose-only maps, which predate it. */
	capturedAt?: string;
	/** Graph node count — how much of the app this map covers. Absent on prose-only maps. */
	nodes?: number;
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
			const { capturedAt, nodes } = readGraphStamp(path.join(dir, file));
			if (capturedAt) {
				v.hasGraph = true;
				v.capturedAt = capturedAt;
				if (nodes !== undefined) v.nodes = nodes;
			}
		}
		out.set(slug, v);
	}

	return out;
}

/**
 * `capturedAt` out of one appmap graph — DEFINED in `src/core/apps.ts`, re-exported here.
 *
 * Two callers need it and they sit on opposite sides of the fleet boundary: this module's
 * sync comparisons, and the app list the runner and the shell both serve. One reader is the
 * point — "what counts as stamped" must not drift between what the sync compares and what
 * the operator is looking at — but the definition had to move DOWN to core, because importing
 * it from here dragged this module's `ssh.js` import into the runner daemon (see the header
 * of core/apps.ts). Re-exported rather than relocated-and-rewired so every call site here is
 * untouched.
 */
export { readCapturedAt };

/**
 * Read a directory's compiled procedures, one entry per `.procedure.json` file.
 *
 * `compiledAt` plays the role `capturedAt` plays for appmaps: the stamp travels inside the
 * artifact, so a `git checkout`'s mtimes cannot make an old procedure look fresh. A file that
 * does not parse — rsynced mid-write, same as the appmap case — reads as unstamped and never
 * overwrites anything. The curated prose beside these (`docs/curated/<app>.md`) is
 * deliberately excluded: it is hand-written and committed, so it arrives with the checkout;
 * machine output is what has to move.
 */
export function readProcedures(dir: string): Map<string, MapVersion> {
	const out = new Map<string, MapVersion>();
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return out; // A host with no procedures directory is a normal state, not an error.
	}

	for (const file of entries.sort()) {
		if (!file.endsWith(".procedure.json")) continue;
		// The whole stem — `<slug>.<taskhash>.procedure` — because one app legitimately has one
		// compiled procedure per task, and keying on the app alone would make them shadow each other.
		const slug = file.slice(0, -".json".length);
		const parsed = readJsonOr<{ compiledAt?: unknown } | undefined>(path.join(dir, file), undefined);
		const stamp = typeof parsed?.compiledAt === "string" && parsed.compiledAt ? parsed.compiledAt : undefined;
		out.set(slug, { slug, hasGraph: false, ...(stamp ? { capturedAt: stamp } : {}), files: [file] });
	}

	return out;
}

/**
 * Harvested recipes. Same shape as procedures — one file per (app, backend, task) — but the
 * version stamp lives in a markdown provenance header rather than in JSON, so it is read out of
 * the first line: `<!-- provenance: recipe | app: … | from: <run stamp> | … -->`.
 *
 * The run stamp IS the version: stamps are ISO-derived and sort chronologically, so "newest
 * promoted recipe wins" falls out of the same `beats` comparison every other tree uses. An
 * unstamped file (a hand-written one wearing the filename) never overwrites a stamped one, which
 * is the same protection appmaps have and for the same reason.
 */
export function readRecipes(dir: string): Map<string, MapVersion> {
	const out = new Map<string, MapVersion>();
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return out; // No recipes yet is the normal state before phase 6, not an error.
	}

	for (const file of entries.sort()) {
		if (!file.endsWith(".recipe.md")) continue;
		const slug = file.slice(0, -".md".length);
		let stamp: string | undefined;
		try {
			stamp = /<!--\s*provenance: recipe\b[^>]*\bfrom: ([^|>\s]+)/.exec(fs.readFileSync(path.join(dir, file), "utf8").slice(0, 500))?.[1];
		} catch {}
		out.set(slug, { slug, hasGraph: false, ...(stamp ? { capturedAt: stamp } : {}), files: [file] });
	}

	return out;
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
/** Two maps belong to the same pass when they were captured on the same UTC day — a pass is keyed by date. */
const sameCapture = (a?: string, b?: string): boolean => Boolean(a && b && a.slice(0, 10) === b.slice(0, 10));

export function beats(a: MapVersion, b: MapVersion): boolean {
	// COVERAGE FIRST, recency second (David, 2026-08-03). Two samples of one arm land minutes
	// apart on different Macs, and the old rule handed the slot to whichever finished later —
	// which is run duration, not map quality. It matched the larger map about two thirds of the
	// time by accident: on 2026-08-01 `explore-cdp` and `explore-vision-cdp` both had the longer
	// pass produce more nodes, while `explore-ax` had the shorter one produce 166 against 120,
	// so recency picked the map with 46 fewer nodes.
	//
	// Measured caveat, recorded so nobody re-derives it as a discovery: map size does NOT predict
	// how a grounded run goes. Across 86–234 nodes on the 08-01 pass the correlation with success
	// is 0.068 on the setting task and 0.063 on the create task, and NEGATIVE (-0.511) on
	// vision-only arms, where matching the map's perception channel matters more than its size.
	// This is a data-hygiene rule — the better sample should be the one that survives — not a
	// performance fix, and it should not be cited as one.
	//
	// The freshness the old rule guaranteed is given up knowingly: the fleet pins one app build
	// (0.0.119 on all three Macs, checked) and these maps are structural, so a larger older map
	// does not describe a UI that has moved. If the target app ever ships a UI change mid-pass,
	// this rule will hold the pre-change map until someone promotes the new one by hand.
	// SAME PASS ONLY (David, 2026-08-03). Coverage beats recency between two samples of one pass,
	// which is the case it was built for; across passes recency wins, or a pass stops grounding on
	// itself. Observed the day the rule landed: a fresh 158-node yarn.cdp.novision was refused by
	// an 08-01 map of 170, and 5 of 11 arm maps at phase-2 dispatch belonged to an earlier pass —
	// while `hasCollectedExplores` still reported the pass self-grounded, because its premise is
	// that this pass's explores overwrite the last one's.
	if (sameCapture(a.capturedAt, b.capturedAt) && a.nodes !== undefined && b.nodes !== undefined && a.nodes !== b.nodes) return a.nodes > b.nodes;
	// Equal coverage, or either side prose-only: fall back to the stamp. Strictly-greater keeps
	// the tie behaviour the transfer planner depends on — ties go to the earlier source, and
	// `local` is passed first, so two maps stamped in the same millisecond do not ping-pong.
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
const PROCEDURES_REMOTE_REL = "docs/procedures";
const RECIPES_REMOTE_REL = "docs/recipes";

/**
 * Bring the fleet to one view of every app's map.
 *
 * Never throws and never fails a caller: this runs on the path of ordinary runs, and a Mac
 * that is asleep must cost a log line, not a refused dispatch. Every host is independent —
 * one unreachable machine does not stop the other two converging.
 */
export function syncAppmaps(opts: SyncOptions = {}): Promise<SyncResult> {
	return syncTree(opts, {
		localDir: opts.localDir ?? appmapsDir(),
		stageDir: opts.stageDir ?? stagingDir(),
		remoteRel: REMOTE_REL,
		read: readAppmaps,
	});
}

/**
 * The same convergence for compiled procedures, which a dispatched replay needs on its target
 * Mac before the submit — the runner refuses a replay whose procedure file is not already there.
 * Same rules by construction: newest stamp wins (`compiledAt`), unstamped never overwrites,
 * unreachable hosts cost a note.
 */
export function syncProcedures(opts: SyncOptions = {}): Promise<SyncResult> {
	return syncTree(opts, {
		localDir: opts.localDir ?? proceduresDir(),
		stageDir: opts.stageDir ?? procedureStagingDir(),
		remoteRel: PROCEDURES_REMOTE_REL,
		read: readProcedures,
	});
}

/**
 * The same convergence for harvested recipes, which a USE_RECIPES run needs on its target
 * Mac before it starts. Without this, phase 6 dispatches to a Mac with an empty
 * docs/recipes/, `loadGrounding` silently falls back to the appmap tier, and the arm reports
 * clean numbers under the wrong label — caught by groundingChecked, but only at collect time
 * after six runs have been paid for.
 */
export function syncRecipes(opts: SyncOptions = {}): Promise<SyncResult> {
	return syncTree(opts, {
		localDir: opts.localDir ?? recipesDir(),
		stageDir: opts.stageDir ?? recipeStagingDir(),
		remoteRel: RECIPES_REMOTE_REL,
		read: readRecipes,
	});
}

interface TreeConfig {
	localDir: string;
	stageDir: string;
	/** Data-root-relative directory on every host — the same key everywhere. */
	remoteRel: string;
	/** How a directory becomes versions: appmap pairs or procedure files. */
	read: (dir: string) => Map<string, MapVersion>;
}

/** The shared engine behind syncAppmaps and syncProcedures: collect, plan, move. */
async function syncTree(opts: SyncOptions, cfg: TreeConfig): Promise<SyncResult> {
	const run = opts.run ?? runSsh;
	const rsync = opts.rsync ?? runRsync;
	const timeoutMs = opts.timeoutMs ?? SYNC_TIMEOUT_MS;
	const localDir = cfg.localDir;
	const stage = cfg.stageDir;
	const hosts = opts.hosts ?? inventoryHosts(opts.inventory);
	const dryRun = !!opts.dryRun;

	fs.mkdirSync(localDir, { recursive: true });
	const local: Source = { name: "local", dir: localDir, maps: cfg.read(localDir) };
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
		const remote = `${root}/${cfg.remoteRel}`;
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

		sources.push({ name: host.name, dir, maps: cfg.read(dir) });
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
				`${host.ssh.user}@${host.ssh.host}:${report.root}/${cfg.remoteRel}/`,
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
	return autoNote("appmaps", "appmap", syncAppmaps, opts);
}

/**
 * The procedure fan-out that runs before a replay dispatch, exactly as `autoSync` runs before a
 * task/explore dispatch — and under the same `APPMAP_SYNC=0` switch, because both are "move
 * grounding artifacts around the fleet automatically" and an operator turning that off means
 * all of it.
 */
export async function autoSyncProcedures(opts: SyncOptions = {}): Promise<string | undefined> {
	return autoNote("procedures", "procedure", syncProcedures, opts);
}

export async function autoSyncRecipes(opts: SyncOptions = {}): Promise<string | undefined> {
	return autoNote("recipes", "recipe", syncRecipes, opts);
}

async function autoNote(
	label: string,
	noun: string,
	sync: (opts: SyncOptions) => Promise<SyncResult>,
	opts: SyncOptions,
): Promise<string | undefined> {
	if (process.env.APPMAP_SYNC === "0") return undefined;

	let result: SyncResult;
	try {
		result = await sync(opts);
	} catch (e) {
		return `${noun} sync skipped: ${(e as Error).message}`;
	}

	const moved = result.transfers.length;
	const blocked = result.hosts.filter((h) => h.reason);
	if (!moved && !blocked.length) return undefined;

	const parts: string[] = [];
	if (moved) parts.push(`${label}: ${summarise(result)}`);
	for (const h of blocked) parts.push(`${label}: ${h.host} skipped (${h.reason})`);

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
