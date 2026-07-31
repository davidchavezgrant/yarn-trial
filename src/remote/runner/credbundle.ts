import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { quitApp } from "../../core/appctl.js";
import { appSlug } from "../../paths.js";
import {
	type AppIdentity,
	capturePaths,
	installProfile,
	ownsLive,
	type ProfileInstall,
	type ProfileManifest,
	profileDir,
	profilesRoot,
	sanitiseOperator,
} from "./profiles.js";
import { packDir, type TarExec, unpackInto } from "./tarball.js";

/**
 * The runner half of the credential vault: turn an operator's session for an app into a single
 * tarball the laptop can carry to the vault (`exportProfile`), and turn one carried back into a
 * live session on this box (`importProfile`).
 *
 * Both speak the SAME on-disk shape the profile store already uses — a directory of home-relative
 * paths plus a `manifest.json` — so a bundle IS a portable `profileDir`. That is what lets import
 * hand the unpacked directory straight to `installProfile` with no translation, and it means a
 * human who ever has to inspect a bundle finds exactly the files they would find parked on a Mac.
 *
 * The security line these two hold, and the reason export is not just "tar whatever is live":
 * a bundle must contain ONLY the requesting operator's session. When someone else owns the live
 * copy of the app, the live cookie jar under $HOME is THEIR session — tarring it would seal
 * another operator's credentials into this operator's vault bundle. So export snapshots the live
 * data only when this operator owns it, and otherwise tars their PARKED profile, and otherwise
 * reports nothing to export. `ownsLive` is that guard.
 */

export interface ExportResult {
	/** False when this operator has no session for the app on this box — nothing was written. */
	found: boolean;
	/** Where the tar came from: the live session, the parked profile, or nowhere. */
	source: "live" | "parked" | "none";
	/** Home-relative paths the bundle contains. */
	paths: string[];
	/** Bytes of the written tar, 0 when nothing was written. */
	bytes: number;
}

export interface ExportOptions {
	app: string;
	operator: string;
	/** Absolute path the tar is written to — a runner-owned staging path, never from the wire. */
	outFile: string;
	bundleId?: string;
	home?: string;
	root?: string;
	exec?: TarExec;
	/** Stop the app before its live profile is copied. Injected in tests; production uses `quitApp`. */
	quit?: (app: string) => Promise<void>;
}

/**
 * Pack this operator's session for the app into `outFile`. Snapshots the LIVE data when the
 * operator owns it, or tars their parked profile otherwise.
 *
 * QUIT BEFORE SNAPSHOT — this is load-bearing, not hygiene. A running Electron/Chromium app holds
 * its cookie jar and localStorage open as LevelDB/SQLite with un-flushed writes, so copying those
 * files WHILE THE APP RUNS captures a torn database the app then refuses to load — it crash-loops
 * on the restoring box (observed live on Yarn: stacked crashpad handlers, no window). `quitApp`
 * does a graceful AppleScript quit so the app flushes and closes its own storage, and WAITS until
 * it is gone, so the copy that follows is of a quiesced, consistent profile. This is the exact
 * rule `swapProfile` already follows for the same reason. The caller (checkin, post-run) can
 * afford the quit; the app reopens on the next run.
 */
export async function exportProfile(opts: ExportOptions): Promise<ExportResult> {
	const home = opts.home ?? os.homedir();
	const root = opts.root ?? profilesRoot();
	const slug = appSlug(opts.app);
	const operator = sanitiseOperator(opts.operator);
	const id: AppIdentity = { name: opts.app, ...(opts.bundleId ? { bundleId: opts.bundleId } : {}) };

	if (ownsLive(root, opts.app, opts.operator)) {
		// Nothing to capture if the app has no data at all; skip the quit in that case so an empty
		// export never disturbs a running app for no reason.
		if (!capturePaths(id, home).length) return { found: false, source: "live", paths: [], bytes: 0 };

		// Quit FIRST, then re-capture against the quiesced app — the paths on disk are the same set,
		// but now flushed and closed.
		await (opts.quit ?? quitApp)(opts.app);
		const paths = capturePaths(id, home);
		if (!paths.length) return { found: false, source: "live", paths: [], bytes: 0 };

		// Stage a profileDir-shaped copy of the live paths, then tar that. Copy, not move: the
		// operator keeps their live session on this box — export takes a picture, it does not
		// remove anything.
		const stage = fs.mkdtempSync(path.join(os.tmpdir(), "yarn-cred-"));
		try {
			for (const rel of paths) {
				const to = path.join(stage, rel);
				fs.mkdirSync(path.dirname(to), { recursive: true });
				fs.cpSync(path.join(home, rel), to, { recursive: true });
			}
			const manifest: ProfileManifest = {
				app: opts.app,
				operator,
				...(opts.bundleId ? { bundleId: opts.bundleId } : {}),
				storedAt: new Date().toISOString(),
				paths,
			};
			fs.writeFileSync(path.join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
			const bytes = await packDir(stage, opts.outFile, opts.exec);

			return { found: true, source: "live", paths, bytes };
		} finally {
			fs.rmSync(stage, { recursive: true, force: true });
		}
	}

	// Not the live owner: their session, if any, is parked. Tar the parked directory as-is.
	const mine = profileDir(root, operator, slug);
	const manifest = readManifestOf(mine);
	if (!manifest) return { found: false, source: "none", paths: [], bytes: 0 };
	const bytes = await packDir(mine, opts.outFile, opts.exec);

	return { found: true, source: "parked", paths: manifest.paths, bytes };
}

export interface ImportResult {
	install: ProfileInstall;
	/** Home-relative paths the received bundle carried. */
	paths: string[];
}

export interface ImportOptions {
	app: string;
	operator: string;
	/** Absolute path of the received tar — a runner-owned staging path, never from the wire. */
	tarFile: string;
	bundleId?: string;
	home?: string;
	root?: string;
	quit?: (app: string) => Promise<void>;
	exec?: TarExec;
}

/**
 * Unpack a received bundle into the operator's parked store and make it the live session.
 *
 * The two steps are one operation on purpose: unpack replaces the parked profile with the vault's
 * copy, and `installProfile` then makes that copy live — parking any other operator's session
 * first. Caller holds the profile lock so this never interleaves with a concurrent swap over the
 * same paths.
 */
export async function importProfile(opts: ImportOptions): Promise<ImportResult> {
	const root = opts.root ?? profilesRoot();
	const slug = appSlug(opts.app);
	const operator = sanitiseOperator(opts.operator);
	const mine = profileDir(root, operator, slug);

	await unpackInto(opts.tarFile, mine, opts.exec);
	const manifest = readManifestOf(mine);

	const install = await installProfile({
		app: opts.app,
		operator: opts.operator,
		...(opts.bundleId ? { bundleId: opts.bundleId } : {}),
		...(opts.home ? { home: opts.home } : {}),
		root,
		...(opts.quit ? { quit: opts.quit } : {}),
	});

	return { install, paths: manifest?.paths ?? [] };
}

function readManifestOf(dir: string): ProfileManifest | undefined {
	try {
		const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

		return m && typeof m === "object" && Array.isArray(m.paths) ? (m as ProfileManifest) : undefined;
	} catch {
		return undefined;
	}
}
