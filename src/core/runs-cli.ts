/**
 * `./run runs list|drop|purge` — operating on out/bench/live, which is the canonical record.
 *
 * This exists because the two operations David actually performs on run data are "this run
 * failed, take it out and re-run it" and "we screwed the whole attempt up, start over", and
 * both were being done by hand with `rm -rf` against a tree whose layout had to be remembered.
 * On 2026-08-01 that came close to deleting the July 31 results, which were siblings of the
 * disposable data under similar names.
 *
 * The safety property is not a confirmation prompt. It is that `drop` and `purge` REFUSE to
 * remove a run that has no backup in out/bench/archive, and take one first instead. Backups are hard
 * links (paths.ts), so a backed-up run survives its live copy being deleted at zero disk cost —
 * which is what makes "remove it and re-run" a safe default rather than a decision.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ARCHIVE_DIR, archiveRun, archiveRunDir, LIVE_DIR, OLD_ARCHIVE_DIR, OLD_LIVE_DIR, outDir, RUN_FILES, runDir } from "../paths.js";
import { readJsonOr } from "../fsutil.js";

interface RunRow {
	key: string;
	app?: string;
	success?: boolean;
	backedUp: boolean;
	mtimeMs: number;
	bytes: number;
	/**
	 * The run sits in the store's pre-bench home (out/live), not the canonical out/bench/live.
	 * Listed so leftovers stay visible, but drop/purge NEVER touch these — they operate on the
	 * canonical location only, and deleting from a tree the tooling no longer writes to is a
	 * by-hand decision.
	 */
	legacy?: boolean;
}

function dirBytes(dir: string): number {
	let total = 0;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) total += dirBytes(p);
		else if (e.isFile())
			try {
				total += fs.statSync(p).size;
			} catch {}
	}

	return total;
}

export function listRuns(root = outDir()): RunRow[] {
	// Canonical store first; the pre-bench home second so leftovers written the night the store
	// lived at out/live stay visible (labeled) instead of silently falling off the inventory.
	const scan = (liveRel: string, archiveRel: string, legacy: boolean): RunRow[] => {
		let names: string[];
		try {
			names = fs.readdirSync(path.join(root, liveRel), { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => d.name);
		} catch {
			return [];
		}

		return names
			// A pass index, not a run: the manifest family is keyed by date and shares this directory
			// (out/bench/live/2026-08-01 beside out/bench/live/2026-08-01T03-07-52-979-yarn). Without
			// this it lists as a run with no log, which reads as "still executing" and blocks purge.
			.filter((key) => !fs.existsSync(path.join(root, liveRel, key, "manifest.json")))
			.map((key) => {
				const dir = path.join(root, liveRel, key);
				// The run log is the only place the outcome is recorded; a run still in flight has
				// none, and that is exactly the state `drop` must not treat as a finished failure.
				const log = readJsonOr<{ app?: string; success?: boolean } | undefined>(path.join(dir, RUN_FILES.log), undefined);

				return {
					key,
					...(log?.app ? { app: log.app } : {}),
					...(typeof log?.success === "boolean" ? { success: log.success } : {}),
					// A legacy run's backup, if it has one, was taken to the OLD archive beside it.
					backedUp: fs.existsSync(path.join(root, archiveRel, key)),
					mtimeMs: fs.statSync(dir).mtimeMs,
					bytes: dirBytes(dir),
					...(legacy ? { legacy: true } : {}),
				};
			});
	};

	return [...scan(LIVE_DIR, ARCHIVE_DIR, false), ...scan(OLD_LIVE_DIR, OLD_ARCHIVE_DIR, true)].sort((a, b) => a.key.localeCompare(b.key));
}

const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(1)} MB`;

/**
 * Remove one run from out/bench/live, backing it up first if it is not already.
 *
 * Returns what happened rather than printing, so the purge path can report a total and the
 * tests can assert on it without capturing stdout.
 */
export function dropRun(key: string, root = outDir()): { dropped: boolean; backedUp: boolean; reason?: string } {
	const dir = runDir(key, root);
	if (!fs.existsSync(dir)) {
		// Canonical only, by design — but say WHERE the run actually is when the answer is the
		// pre-bench leftover tree, so the refusal reads as a fact rather than a lie.
		const reason = fs.existsSync(path.join(root, OLD_LIVE_DIR, key))
			? `run is a leftover in the pre-bench out/${OLD_LIVE_DIR} — drop operates on out/${LIVE_DIR} only; remove it by hand if you mean it`
			: "no such run in out/bench/live";

		return { dropped: false, backedUp: false, reason };
	}
	// Back up FIRST, unconditionally. An already-backed-up run re-links only the files the
	// archive is missing, so this is cheap and closes the window where a run finished writing
	// after its backup was taken.
	let backedUp = false;
	try {
		backedUp = Boolean(archiveRun(key, root));
	} catch {
		backedUp = false;
	}
	if (!backedUp) return { dropped: false, backedUp: false, reason: "backup failed — refusing to delete the only copy" };
	fs.rmSync(dir, { recursive: true, force: true });

	return { dropped: true, backedUp: true };
}

function usage(): never {
	console.error("usage: ./run runs list");
	console.error("       ./run runs drop <stamp> [<stamp> …]   remove from out/bench/live, keeping the backup");
	console.error("       ./run runs purge [--yes]              remove every run from out/bench/live, keeping backups");
	process.exit(1);
}

function main(): void {
	const [verb, ...rest] = process.argv.slice(2);
	const root = outDir();

	if (!verb || verb === "list") {
		const rows = listRuns(root);
		if (!rows.length) {
			console.log(`no runs in ${path.join(root, LIVE_DIR)}`);

			return;
		}
		for (const r of rows) {
			const state = r.success === undefined ? "in flight / no log" : r.success ? "success" : "FAILED";
			console.log(`${r.key}  ${state}${r.app ? `  ${r.app}` : ""}  ${mb(r.bytes)}${r.backedUp ? "" : "  [NOT BACKED UP]"}${r.legacy ? `  [legacy out/${OLD_LIVE_DIR}]` : ""}`);
		}
		console.log(`\n${rows.length} run(s), ${mb(rows.reduce((n, r) => n + r.bytes, 0))} in ${path.join(root, LIVE_DIR)}`);
		console.log(`backups: ${path.join(root, ARCHIVE_DIR)}`);
		const leftovers = rows.filter((r) => r.legacy);
		if (leftovers.length) console.log(`${leftovers.length} leftover(s) in the pre-bench out/${OLD_LIVE_DIR} — listed only; drop/purge never touch them`);

		return;
	}

	if (verb === "drop") {
		if (!rest.length) usage();
		let failed = 0;
		for (const key of rest) {
			const res = dropRun(key, root);
			if (res.dropped) console.log(`dropped ${key} from out/${LIVE_DIR} (backup at out/${ARCHIVE_DIR}/${key})`);
			else {
				console.error(`${key}: ${res.reason}`);
				failed++;
			}
		}
		process.exit(failed ? 1 : 0);
	}

	if (verb === "purge") {
		// Canonical rows ONLY: leftovers in the pre-bench out/live are inventory, not targets —
		// dropRun would not find them and deleting from that tree is a by-hand decision.
		const legacyCount = listRuns(root).filter((r) => r.legacy).length;
		if (legacyCount) console.log(`leaving ${legacyCount} leftover(s) in the pre-bench out/${OLD_LIVE_DIR} untouched`);
		const rows = listRuns(root).filter((r) => !r.legacy);
		if (!rows.length) {
			console.log(`nothing to purge in ${path.join(root, LIVE_DIR)}`);

			return;
		}
		// Naming what is about to go is the whole confirmation. A run with no log is either in
		// flight right now or died before writing one, and purging the first is a mistake no
		// backup undoes — the child keeps running and writes into a directory nothing reads.
		const inFlight = rows.filter((r) => r.success === undefined);
		if (inFlight.length && !rest.includes("--yes")) {
			console.error(`${inFlight.length} run(s) have no run log — they may still be executing:`);
			for (const r of inFlight) console.error(`  ${r.key}`);
			console.error(`\nStop them first (./run fleet stop, or Ctrl-C locally), or pass --yes to purge anyway.`);
			process.exit(1);
		}
		let dropped = 0;
		let bytes = 0;
		for (const r of rows) {
			const res = dropRun(r.key, root);
			if (res.dropped) {
				dropped++;
				bytes += r.bytes;
			} else console.error(`${r.key}: ${res.reason}`);
		}
		console.log(`purged ${dropped}/${rows.length} run(s), ${mb(bytes)} — backups kept in out/${ARCHIVE_DIR}`);
		process.exit(dropped === rows.length ? 0 : 1);
	}

	usage();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
