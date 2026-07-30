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
 */
export function appSlug(app: string): string {
	return app.toLowerCase().replace(/\s+/g, "-");
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

/** Compiled sidecars that ship with the code (`native/axdom`, `tools/winrec`). */
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
