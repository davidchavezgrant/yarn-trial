import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ARCHIVE_DIR, LIVE_DIR, OLD_ARCHIVE_DIR, OLD_LIVE_DIR, RUN_FILES, outDir, runDir } from "../paths.js";
import { benchDir, readManifest, utcDate, type Manifest } from "./manifest.js";
import { storeRoot } from "./dash.js";

/**
 * `./run dash:snapshot` — freeze one benchmark pass into a shippable, metadata-only store.
 *
 * WHY THIS EXISTS: the dash is a reader co-located with the store (see dash.ts's store
 * adapter), and the store is 1.4 GB of step frames and mp4s that a hosted dash has no use
 * for. The numbers it actually renders — the manifest, every run's run.json / events.jsonl /
 * journal.jsonl / log.txt, the per-arm appmap copies, the narrator's log — are ~6 MB for a
 * 187-entry pass. That asymmetry is the whole trick: the heavy artifacts are the run's
 * EVIDENCE (frames, recordings), and the dash charts its METRICS.
 *
 * The output is not a new format. It is the same directory layout the dash already reads,
 * rooted somewhere else, so a dash pointed at it with YARN_RUNNER_DATA needs no snapshot
 * awareness at all — storeRoot's own live-first ladder resolves it unchanged. That is
 * deliberate: a snapshot the dash reads through a special case is a snapshot that drifts
 * from what the real dash shows, and the report/dashboard agreement rule (dash.ts's header)
 * has to survive the trip to a hosted copy.
 *
 * PURE READER over the source store, like collect and the dash itself: it opens the source
 * read-only and writes exclusively under `dest`.
 */

/**
 * Excluded from every run directory. Both are directories of bulk evidence — `steps/` is one
 * PNG per action, `recording/` the assembled mp4 and its frames — and together they are
 * ~36 MB of a ~36.03 MB run. Named off RUN_FILES rather than spelled here so a rename in
 * paths.ts moves the exclusion with it.
 */
const HEAVY: ReadonlySet<string> = new Set([RUN_FILES.steps, RUN_FILES.recording]);

export interface SnapshotResult {
	date: string;
	/** Where the snapshot's data root landed — the value to hand a dash as YARN_RUNNER_DATA. */
	dest: string;
	/** Manifest entries, and how many of their run directories actually existed to copy. */
	entries: number;
	runsCopied: number;
	/**
	 * Entries whose run directory is absent from the source store. NOT an error: a queued
	 * entry never produced one, and collect EVICTS a terminal failure's directory once its
	 * metrics are banked (collect.ts's one deliberate write). The manifest keeps the entry
	 * either way, and the dash renders it from metrics alone.
	 */
	runsMissing: number;
	files: number;
	bytes: number;
}

/** Recursive copy with an exclusion set, accounting bytes as it goes. Real copies, never hard links — the destination is meant to leave this filesystem. */
function copyTree(from: string, to: string, exclude: ReadonlySet<string>, acc: { files: number; bytes: number }): void {
	fs.mkdirSync(to, { recursive: true });
	for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
		if (exclude.has(ent.name)) continue;
		const src = path.join(from, ent.name);
		const dst = path.join(to, ent.name);
		if (ent.isDirectory()) {
			copyTree(src, dst, exclude, acc);
			continue;
		}
		if (!ent.isFile()) continue;
		fs.copyFileSync(src, dst);
		acc.files += 1;
		acc.bytes += fs.statSync(dst).size;
	}
}

/**
 * The run's directory in the SOURCE store, wherever it currently sits.
 *
 * paths.ts's runFile resolves per-artifact and defaults to the archive; here the whole
 * directory is wanted and live is the canonical home, so the ladder is walked directly —
 * live first, then the hard-linked archive backup, then the store's pre-bench homes.
 * Returns undefined when the run left no directory anywhere (see runsMissing).
 */
function sourceRunDir(jobId: string, srcRoot: string): string | undefined {
	const candidates = [LIVE_DIR, ARCHIVE_DIR, OLD_LIVE_DIR, OLD_ARCHIVE_DIR].map((d) => path.join(srcRoot, d, jobId));

	return candidates.find((d) => fs.existsSync(d));
}

/**
 * Copy one pass's readable surface into `dest`, laid out as `dest/out/bench/live/…`.
 *
 * Three things travel, and nothing else:
 *  - the date directory wholesale (manifest.json, the pass's report .md, the per-arm appmap
 *    copies under appmaps/<model>/<arm>/<job>/) — 764 KB for the 2026-08-01 pass, all of it
 *    something the detail panes read,
 *  - every referenced run directory minus HEAVY,
 *  - narrative.jsonl from the live root — the narrator's per-run notes. Without it a hosted
 *    dash shows no narrative at all, because share mode never mints new ones.
 */
export function exportSnapshot(opts: { date?: string; srcRoot?: string; dest: string }): SnapshotResult {
	const srcRoot = opts.srcRoot ?? outDir();
	const date = opts.date ?? utcDate();
	// The same resolution the dash applies, so the snapshot freezes exactly the manifest a
	// local dash would have shown for this date — never a different copy of it.
	const manifestRoot = storeRoot([date, "manifest.json"], srcRoot);
	const manifest: Manifest = readManifest(date, manifestRoot);
	if (!manifest.entries.length) throw new Error(`no entries in the ${date} manifest under ${manifestRoot} — nothing to snapshot`);

	const destOut = path.join(opts.dest, "out");
	const destLive = path.join(destOut, LIVE_DIR);
	const acc = { files: 0, bytes: 0 };

	copyTree(benchDir(date, manifestRoot), benchDir(date, destLive), HEAVY, acc);

	let runsCopied = 0;
	let runsMissing = 0;
	for (const e of manifest.entries) {
		const src = sourceRunDir(e.jobId, srcRoot);
		if (!src) {
			runsMissing += 1;
			continue;
		}
		copyTree(src, runDir(e.jobId, destOut), HEAVY, acc);
		runsCopied += 1;
	}

	// Best-effort: a pass whose narrator never ran simply has no log, which is not a failure.
	const narrative = path.join(srcRoot, LIVE_DIR, "narrative.jsonl");
	if (fs.existsSync(narrative)) {
		fs.copyFileSync(narrative, path.join(destLive, "narrative.jsonl"));
		acc.files += 1;
		acc.bytes += fs.statSync(narrative).size;
	}

	return { date, dest: opts.dest, entries: manifest.entries.length, runsCopied, runsMissing, files: acc.files, bytes: acc.bytes };
}

const MB = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const args = process.argv.slice(2);
	const flag = (name: string): string | undefined => {
		const i = args.indexOf(name);

		return i >= 0 ? args[i + 1] : undefined;
	};
	const dest = flag("--dest") ?? path.join(outDir(), "dash-snapshot");
	const date = flag("--date");
	const srcRoot = flag("--src");
	try {
		const r = exportSnapshot({ ...(date ? { date } : {}), ...(srcRoot ? { srcRoot } : {}), dest });
		console.log(`snapshot ${r.date}: ${r.runsCopied}/${r.entries} run dirs (${r.runsMissing} left no directory), ${r.files} files, ${MB(r.bytes)}`);
		console.log(`  → ${r.dest}`);
		console.log(`  serve it: YARN_RUNNER_DATA=${r.dest} DASH_AUTH=user:pass ./run dash --share --date ${r.date}`);
	} catch (err) {
		console.error(`snapshot failed: ${(err as Error).message}`);
		process.exit(1);
	}
}
