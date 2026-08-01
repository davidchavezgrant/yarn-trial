import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where this process reads and writes.
 *
 * Every path in src/ used to be built from `process.cwd()`, which is correct only because
 * `run` cds into the checkout before doing anything. Two deployments break that assumption
 * and neither reports an error: a LaunchAgent starts with cwd `/`, and so does a packaged
 * .app. Both would then create `/out/` at the filesystem root and read appmaps that are not
 * there — silently, because `mkdirSync -p` succeeds and a missing appmap merely degrades a
 * run to ungrounded. A wrong-but-plausible path is the worst failure shape available here,
 * so cwd is removed as an input entirely.
 *
 * Two roots, because packaging splits them:
 *
 *   DATA      writable — out/ and the appmaps the explorer generates
 *   RESOURCES read-only — the checkout itself: recipes, native sidecars, src/ for spawning
 *
 * In a checkout they are the same directory, and every path below resolves to exactly the
 * value it had when it was written from cwd. That equality is the point: this refactor is a
 * no-op in development and only diverges where cwd was already wrong.
 */

/** Explicit overrides. Set by the LaunchAgent plist, by the Electron shell when packaged, and by tests. */
const DATA_ENV = "YARN_RUNNER_DATA";
const RESOURCES_ENV = "YARN_RUNNER_RESOURCES";

let repoRootCache: string | undefined;

/**
 * The checkout, found by walking up from this module rather than from cwd — that is the
 * whole fix, since the module's own location is true regardless of who launched us or from
 * where. Compiled output (`dist-electron/src/paths.js`) walks up past `dist-electron` and
 * lands on the same root.
 *
 * Only the filesystem walk is cached. The env vars above are re-read on every call so a
 * test can point one root at a temp dir without the import order deciding the answer.
 */
function repoRoot(): string {
	if (repoRootCache) return repoRootCache;

	let dir = path.dirname(fileURLToPath(import.meta.url));
	while (true) {
		if (fs.existsSync(path.join(dir, "package.json"))) break;
		const up = path.dirname(dir);
		if (up === dir) {
			// Reaching the filesystem root means we are running from somewhere with no
			// package.json above it, which no supported deployment does. Falling back to cwd
			// restores the old behaviour rather than throwing from a path accessor.
			dir = process.cwd();
			break;
		}
		dir = up;
	}

	return (repoRootCache = dir);
}

/**
 * The filename-safe form of an app's name — the key every per-app artifact is filed under.
 *
 * Here rather than in harness.ts (which re-exports it, so no call site moved) because the
 * runner needs it too, and harness.ts pulls in the Anthropic SDK and the driver at import
 * time. A long-lived daemon should not load either to lowercase a string.
 *
 * Path separators and `:` fold into the dash alongside whitespace: "filename-safe" has to
 * mean it, or an app named "A/V Recorder" turns `out/runs/<stamp>-a/v-recorder.json` into a
 * write under a directory that does not exist — ENOENT at the exact moment a run or a
 * 40-minute explore pass saves its artifact — and a crafted name walks out of the data root.
 */
export function appSlug(app: string): string {
	return app.toLowerCase().replace(/[\s/\\:]+/g, "-");
}

/** Writable root. Everything under it is generated and safe to delete. */
export function dataRoot(): string {
	return process.env[DATA_ENV] || repoRoot();
}

/** Read-only root: the code and the assets shipped alongside it. */
export function resourcesRoot(): string {
	return process.env[RESOURCES_ENV] || repoRoot();
}

/** Run logs, screenshots, recordings, UI state. */
export function outDir(): string {
	return `${dataRoot()}/out`;
}

/**
 * ONE DIRECTORY PER RUN — `out/bench/live/<runKey>/`.
 *
 * A run's artifacts used to be scattered across three sibling trees keyed by the same string:
 * `out/runs/<key>.json` (plus `.journal.jsonl`, `.judge.json`, `-steps/`), `out/recording/<key>/`
 * and `out/jobs/<key>/`. The key correlated them, so nothing was ever LOST — but four different
 * questions ("what did this run produce", "is it safe to delete", "did it get archived", "pull
 * it off the Mac") each needed the same five-way fan-out, and each one was a place to forget a
 * branch. The fleet pull forgot `-steps/` for long enough that the offline judge returned VISUAL
 * UNAVAILABLE for an entire matrix.
 *
 * Consolidating is what makes the backup honest: preserving a finished run is one directory,
 * not a list of globs that has to stay in sync with everything that writes.
 *
 * `out/bench/live` IS THE CANONICAL RECORD — of runs in flight and of every run that has
 * finished. The dashboard, the offline judge, `cleanup` and `humanize` all read it, and nothing
 * moves out of it. `out/bench/archive/<key>/` is a BACKUP taken when a run terminates: a second
 * name for the same bytes, so that losing the live tree (the purges during the 2026-08-01 false
 * starts came close to taking the July 31 results with them) does not lose the results.
 *
 * Both sit under `out/bench/` because everything either of them holds belongs to the benchmark:
 * the runs, and the manifest family that indexes them (`out/bench/live/<date>/`, see
 * bench/manifest.ts). One directory to hand someone, one to back up, one to purge.
 */
export const LIVE_DIR = "bench/live";
export const ARCHIVE_DIR = "bench/archive";

/**
 * The same consolidated layout's PREVIOUS homes — `out/live` and `out/archive`, where the
 * store lived for the hours between the per-run consolidation and David's final decision to
 * house it under `out/bench/`. Runs landed there that night, and a fleet Mac running
 * un-synced code keeps writing job records whose rel paths say `out/live/<id>/…` until a
 * provision sync + runner restart. READS resolve these; nothing writes to them any more.
 */
export const OLD_LIVE_DIR = "live";
export const OLD_ARCHIVE_DIR = "archive";

/** The canonical names inside a run directory. Legacy locations are resolved by `runFile`. */
export const RUN_FILES = {
	log: "run.json",
	journal: "journal.jsonl",
	judge: "judge.json",
	judgeCross: "judge.cross.json",
	checkpoint: "checkpoint.json",
	/**
	 * A grounding pass's OWN copy of the map it produced. `docs/appmaps/<slug>.*` is the
	 * canonical INPUT — keyed by app so the task agent can find it, and therefore overwritten by
	 * the next pass on that variant. This copy is keyed by RUN, so it is the record of what THIS
	 * pass produced and nothing later can overwrite it.
	 *
	 * It is also where a DEMOTED pass's map lands and stops: one that did not sweep the frontier,
	 * or produced under half the committed node count, is written here and deliberately not
	 * copied over docs/appmaps (see writeArtifacts). Same filename either way — "was it good
	 * enough to publish" is a property of the pass, not a reason to file its output elsewhere.
	 */
	appmap: "appmap.md",
	appmapGraph: "appmap.json",
	/**
	 * The recipe compiled FROM this run (`recipe compile <stamp>`), or, on a replay, the recipe it
	 * replayed. `docs/recipes/` remains where a recipe is looked up BY NAME; this copy makes the
	 * run folder answer "what did this run do" without a second lookup that a rename can break.
	 */
	recipe: "recipe.json",
	/**
	 * Task-level procedural knowledge harvested FROM this run: prose describing how to accomplish
	 * the goal in this app, written for a future agent to read.
	 *
	 * Distinct from both neighbours. `appmap.md` is topology — where things are, task-agnostic,
	 * and it never says which route to take. `recipe.json` is a frozen click sequence replayed by
	 * machine with exact (name, surface, role) resolution, so a renamed control is an error rather
	 * than an adaptation. This is the middle tier: how to do this CLASS of task, prose a model can
	 * adapt when the control moved or the value differs.
	 */
	procedure: "procedure.md",
	/**
	 * The standalone cleanup CLI's receipt (src/core/cleanup.ts): what it planned per journal
	 * entry and what came of the attempt. An ordinary run folds this into run.json
	 * (`cleanupReport`); the crashed run the CLI exists for has no run log to fold into, and
	 * before this file its restore outcome lived only in whichever terminal ran it.
	 */
	cleanup: "cleanup.json",
	/**
	 * The run's structured event log: one JSON line per lifecycle moment ({t, kind, detail}),
	 * appended by `runEvent` (src/core/harness/run-events.ts) the instant it happens. log.txt
	 * already holds every console line, but it is prose for humans; this is the same story at
	 * coarse grain in a shape the dashboard's Events feed can tail and merge across runs
	 * without parsing free text. Append-only, never rewritten — same philosophy as the
	 * narrator log, so a reader racing an append sees at worst one torn tail line.
	 */
	events: "events.jsonl",
	console: "log.txt",
	steps: "steps",
	recording: "recording",
} as const;

/**
 * Repo-relative (posix) — the form job records use, because they are read on another machine.
 * LIVE_DIR already contains a separator, so it is joined as a posix segment rather than through
 * path.join: on a non-posix host that would emit backslashes into a string the far side splits.
 */
export const runRel = (key: string, ...parts: string[]): string => ["out", LIVE_DIR, key, ...parts].join("/");

/** The two roots themselves, for things keyed by something other than a run stamp. */
export const liveDir = (root = outDir()): string => path.join(root, LIVE_DIR);
export const archiveDir = (root = outDir()): string => path.join(root, ARCHIVE_DIR);

export const runDir = (key: string, root = outDir()): string => path.join(liveDir(root), key);
export const archiveRunDir = (key: string, root = outDir()): string => path.join(archiveDir(root), key);

/** Where a WRITER puts an artifact: always live, never the archive. */
export const runPath = (key: string, name: string, root = outDir()): string => path.join(runDir(key, root), name);

/**
 * Where a READER finds one: live, then the archive, then the same layout's pre-`bench/` homes
 * (`out/live/<key>`, `out/archive/<key>`), then the pre-consolidation scattered layout.
 *
 * The old-home fallback exists because runs landed under `out/live`/`out/archive` during the
 * hours the consolidated store lived there, and un-synced fleet runners keep reporting rel
 * paths that pull artifacts into those trees. The scattered-layout fallback exists because
 * runs recorded before the move are still in `out/runs/` and inside archived benchmark
 * passes, and the gallery, the offline judge and `cleanup` all have to keep opening them — a
 * layout change is not a reason to make last week's evidence unreadable. Nothing writes to
 * any fallback location any more, so those trees are fixed historical sets rather than second
 * layouts to maintain.
 *
 * Returns the live path when the artifact is nowhere, so an error message names where it was
 * supposed to be rather than where it last wasn't.
 */
export function runFile(key: string, name: string, root = outDir()): string {
	for (const dir of [runDir(key, root), archiveRunDir(key, root), path.join(root, OLD_LIVE_DIR, key), path.join(root, OLD_ARCHIVE_DIR, key)]) {
		const candidate = path.join(dir, name);
		if (fs.existsSync(candidate)) return candidate;
	}
	const old = legacyRunPath(key, name, root);

	return old && fs.existsSync(old) ? old : path.join(runDir(key, root), name);
}

/**
 * The run's directory wherever it currently is — live while in flight, archive once finished,
 * the pre-`bench/` homes for runs stranded there. Defaults to the archive when the run is
 * nowhere, preserving the pre-fallback contract.
 */
export function resolveRunDir(key: string, root = outDir()): string {
	for (const dir of [runDir(key, root), archiveRunDir(key, root), path.join(root, OLD_LIVE_DIR, key), path.join(root, OLD_ARCHIVE_DIR, key)]) {
		if (fs.existsSync(dir)) return dir;
	}

	return archiveRunDir(key, root);
}

/**
 * Back a finished run up: `out/bench/live/<key>` gains a second name at `out/bench/archive/<key>`.
 *
 * The live copy STAYS — it is the canonical record everything reads. This only guards against
 * losing it.
 *
 * HARD LINKS, not a byte copy, and the reason is size. One recorded run's `recording/frames/` is
 * a four-figure count of window PNGs; across a matrix of this size a literal second copy is tens
 * of gigabytes to defend against one specific accident. A hard link is a second directory entry
 * pointing at the same inode: it costs nothing, and — this is the part that matters — it SURVIVES
 * deletion of the live name, because the file is only released when its last name goes. That is
 * exactly the failure being defended against.
 *
 * What it does not defend against is in-place modification, since both names are one file. That
 * is acceptable here and only here: a run's artifacts are written once, when the run ends, and
 * nothing edits them afterwards. `copyFileSync` is the fallback for the cases a link cannot cover
 * (a different filesystem, a filesystem without them), so the guarantee degrades to a real copy
 * rather than to nothing.
 *
 * Re-callable: an already-backed-up file is left alone rather than throwing, because both the run
 * itself and a later `pull` of the same key may reasonably try.
 */
export function archiveRun(key: string, root = outDir()): string | undefined {
	const from = runDir(key, root);
	const to = archiveRunDir(key, root);
	if (!fs.existsSync(from)) return undefined;
	backupTree(from, to);

	return to;
}

/**
 * The backup mechanism itself, exported because a run is not the only thing worth backing up —
 * the benchmark manifest family is filed by DATE rather than by run stamp and uses this
 * directly (`archiveBench` in bench/manifest.ts). One implementation, so the two cannot end up
 * with different ideas of what "backed up" means.
 */
export function backupTree(from: string, to: string): void {
	fs.mkdirSync(to, { recursive: true });
	for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
		const src = path.join(from, ent.name);
		const dst = path.join(to, ent.name);
		if (ent.isDirectory()) {
			backupTree(src, dst);
			continue;
		}
		if (!ent.isFile() || fs.existsSync(dst)) continue;
		try {
			fs.linkSync(src, dst);
		} catch {
			// EXDEV (another filesystem) or a filesystem with no hard links. A real copy is the
			// correct answer there — slower and larger, but the backup still exists.
			try {
				fs.copyFileSync(src, dst);
			} catch {
				// One unreadable file must not abandon the rest of the run's backup.
			}
		}
	}
}

/** The pre-consolidation location of one artifact, or undefined if it had none. */
export function legacyRunPath(key: string, name: string, root = outDir()): string | undefined {
	if (name === RUN_FILES.log) return path.join(root, "runs", `${key}.json`);
	if (name === RUN_FILES.steps) return path.join(root, "runs", `${key}-steps`);
	if (name === RUN_FILES.recording) return path.join(root, "recording", key);
	if (name === RUN_FILES.console) return path.join(root, "jobs", key, "log.txt");
	// journal.jsonl / judge.json / judge.cross.json / checkpoint.json / salvage.* all shared the
	// `out/runs/<key>.<suffix>` shape, so one rule covers them.
	if (/^(journal|judge|judge\.cross|checkpoint|salvage)\./.test(name)) return path.join(root, "runs", `${key}.${name}`);

	return undefined;
}

/**
 * Explorer output. Writable because `explore` generates it, and separate from recipes
 * because the provenance split between them is load-bearing: stamped appmaps are machine
 * output, recipes are curated by hand, and conflating the two is what made an earlier
 * measurement report recipe-following as autonomous grounding.
 */
export function appmapsDir(): string {
	return `${dataRoot()}/docs/appmaps`;
}

/** Curated, hand-written, read-only at runtime. */
export function recipesDir(): string {
	return `${resourcesRoot()}/docs/recipes`;
}

/**
 * Harvested procedures — machine output, like docs/appmaps and unlike docs/recipes.
 *
 * A SEPARATE directory from recipes, not a filename convention inside it, because the two are
 * different classes of input and this project has already been burned once by letting curated
 * and generated grounding share a home: appmaps that were partly hand-written made a measurement
 * report recipe-following as autonomous grounding. `dataRoot`, not `resourcesRoot`, because
 * unlike recipes these are written at runtime.
 */
export function proceduresDir(): string {
	return `${dataRoot()}/docs/procedures`;
}

/** Compiled sidecars that ship with the code (`native/axdom`, `native/liveview`). */
export function nativeDir(): string {
	return `${resourcesRoot()}/native`;
}

/**
 * Make an absolute path relative to the data root for storage in a run log. Logs are read
 * on other machines once runs are pulled off the fleet, so an absolute path in one is
 * noise at best and misleading at worst. Paths outside the root are returned unchanged
 * rather than mangled into a `../../..` chain.
 */
export function relToData(abs: string): string {
	const root = `${dataRoot()}/`;

	return abs.startsWith(root) ? abs.slice(root.length) : abs;
}
