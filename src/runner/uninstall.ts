import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { quitApp } from "../appctl.js";
import { appSlug } from "../paths.js";
import { profileDir, profilesRoot } from "./profiles.js";

/**
 * Remove an app from this Mac: the bundle, and every operator's parked profile for it.
 *
 * The bundle name is the hostile input, exactly as it is in `remote/install.ts` — it arrives
 * over the runner socket and becomes a path segment fed to a recursive delete, which is the
 * one operation with no second chance. So resolution is strict rather than clever:
 *
 *  - Only two roots are ever searched: `/Applications` and `~/Applications` — the same pair
 *    a run would launch from, and the pair `installApp` writes into. `/System` is not in the
 *    list, so no name can produce a path under it; nothing here takes a caller-supplied
 *    directory over the wire.
 *  - The name must be a single plain path segment: no separators, no leading dot (which also
 *    rules out `.` and `..`), no `..` anywhere. Real bundles satisfy all of that; the inputs
 *    that do not are the ones trying to name something other than an app.
 *  - A bundle that does not exist is a refusal, not a no-op. "Deleted" answered for a name
 *    that was never there hides the typo that will resurface as "app not found" mid-demo.
 *
 * Parked profiles go with the bundle for the reason the caller states: an app that is gone
 * should not leave per-operator session data orphaned in the store, silently restored over a
 * future reinstall. The LIVE data under `~/Library` is deliberately left — that is macOS's
 * own uninstall convention (drag to Trash keeps app data), and `authclear` is the verb for
 * data. Ownership in owners.json is likewise kept: it describes the live data, which is
 * still there.
 */

export interface AppDeleteOptions {
	app: string;
	home?: string;
	/**
	 * Application directories to search. Injected in tests; production always uses
	 * `/Applications` and `~/Applications` — never a wire-supplied path.
	 */
	appDirs?: string[];
	/** Profile store root. Defaults to `<runnerDir>/profiles`. */
	root?: string;
	/** Stop the app before its bundle is deleted. Injected in tests. */
	quit?: (app: string) => Promise<void>;
}

export interface AppDelete {
	app: string;
	/** Absolute path of the bundle that was removed. */
	bundle: string;
	/** Store-relative parked profiles removed, one per operator: `<operator>/<slug>`. */
	removedProfiles: string[];
}

/**
 * The name as a single safe path segment, or a thrown refusal. `.app` is stripped first so
 * "Yarn.app" and "Yarn" are the same request — the same equivalence `install.ts` grants.
 */
export function safeBundleName(app: string): string {
	const name = app.trim().replace(/\.app$/i, "").trim();
	if (!name) throw new Error("no app name given");
	if (name.includes("/") || name.includes("\\")) throw new Error(`app name ${JSON.stringify(app)} contains a path separator`);
	// Leading dot covers "." and ".." and every hidden path; no real bundle starts with one.
	// ".." anywhere is refused too — harmless inside a single segment, but nothing legitimate
	// carries it and this path ends at rm -rf.
	if (name.startsWith(".") || name.includes("..")) throw new Error(`app name ${JSON.stringify(app)} is not a plain bundle name`);

	return name;
}

export async function deleteAppBundle(opts: AppDeleteOptions): Promise<AppDelete> {
	const home = opts.home ?? os.homedir();
	const name = safeBundleName(opts.app);
	const dirs = opts.appDirs ?? ["/Applications", path.join(home, "Applications")];

	const bundle = dirs.map((d) => path.join(d, `${name}.app`)).find((p) => fs.existsSync(p));
	if (!bundle) throw new Error(`${name}.app is not in ${dirs.join(" or ")}`);
	// Belt and braces over the fixed root list: a future caller injecting appDirs must still
	// be unable to point a delete at the OS's own bundles.
	if (bundle.startsWith("/System/")) throw new Error(`refusing to delete ${bundle}: /System is not ours to touch`);

	// Quit before the delete: an app running out of a half-deleted bundle is a crash with a
	// misleading backtrace, and its exit hooks may write into directories mid-removal.
	await (opts.quit ?? quitApp)(name);
	fs.rmSync(bundle, { recursive: true, force: true });

	// Every operator's parked profile for this app. The store layout is <root>/<operator>/<slug>,
	// so the sweep is one readdir of the operator directories — owners.json at the root is a
	// file and drops out of the directory filter.
	const root = opts.root ?? profilesRoot();
	const slug = appSlug(name);
	const removedProfiles: string[] = [];
	let operators: fs.Dirent[] = [];
	try {
		operators = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
	} catch {
		// No store yet — nothing parked, nothing to sweep.
	}
	for (const op of operators) {
		const parked = profileDir(root, op.name, slug);
		if (!fs.existsSync(parked)) continue;
		fs.rmSync(parked, { recursive: true, force: true });
		removedProfiles.push(`${op.name}/${slug}`);
	}

	return { app: name, bundle, removedProfiles };
}

/** One line for the job log, same shape as `describeSwap`. */
export function describeAppDelete(d: AppDelete): string {
	return `appdelete: removed ${d.bundle}${d.removedProfiles.length ? ` and ${d.removedProfiles.length} parked profile(s)` : ""}`;
}
