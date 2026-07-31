import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Wipe every Chrome profile on this Mac: the accounts, the saved passwords, the form history.
 *
 * WHY THIS EXISTS. Measured 2026-07-31, all three colo Macs had THREE people's personal Google
 * accounts signed into one shared Chrome profile — two of them `@gmail.com` — with sync on and
 * 801 saved credentials each. The identical count across three machines is sync working as
 * designed: one vault, replicated. A liveview sign-in put that autofill dropdown on screen for
 * a teammate to read, which is what started this.
 *
 * WHY DELETING FILES IS THE SAFE ROUTE, AND THE UI IS NOT. The hazard with clearing passwords
 * is the sync TOMBSTONE: a delete through a running, signed-in Chrome emits
 * `PasswordStoreChange::REMOVE`, which propagates to the account's vault and every other device
 * that person owns. Irreversible, and not ours to do. But that is a property of deleting
 * THROUGH CHROME. With the browser closed there is no process connected to Google to report
 * anything — removing the directory is purely local, and the account simply keeps its vault.
 *
 * Hence the ordering below, which is the whole safety property:
 *   1. Quit Chrome and VERIFY it is gone. A running Chrome holds these databases open, writes
 *      them back on quit (resurrecting what we deleted), and is the only thing that could emit
 *      a tombstone. This refuses rather than proceeding if the browser will not die.
 *   2. Remove whole PROFILE DIRECTORIES, not selected files. Deleting `Login Data` alone leaves
 *      `sync_model_metadata` behind, so the next launch re-runs initial sync and re-downloads
 *      every credential from the server — the deletion would appear to work and quietly undo
 *      itself. A profile with no account has nothing to sync from.
 *
 * WHAT SURVIVES, deliberately: `Local State` (Chrome's own machine-level file, which is
 * recreated anyway) and the autofill POLICY at `~/Library/Preferences/com.google.Chrome.plist`,
 * which lives OUTSIDE the profile — verified, so a wipe cannot silently un-apply the lockdown
 * that stops the dropdown coming back.
 *
 * Not a general "delete a directory" verb: the roots are constants in this file and the only
 * thing that varies is which profile subdirectories exist. Nothing from the wire reaches a path.
 */

/** Chrome's user-data root, the parent of every profile. */
function chromeRoot(home: string): string {
	return path.join(home, "Library", "Application Support", "Google", "Chrome");
}

/**
 * A profile directory is one that holds a `Preferences` file. Chrome's user-data root is full of
 * caches and component directories that are NOT profiles (`Safe Browsing`, `ShaderCache`,
 * `Crashpad`…), and deleting the root wholesale would take Chrome's install state with it.
 * `Preferences` is the marker Chrome itself uses.
 */
export function profileDirs(root: string, readdir = fs.readdirSync, exists = fs.existsSync): string[] {
	let entries: string[];
	try {
		entries = readdir(root) as string[];
	} catch {
		return []; // No Chrome data at all is a clean state, not an error.
	}

	return entries
		.map((e) => path.join(root, e))
		.filter((dir) => exists(path.join(dir, "Preferences")))
		.sort();
}

export interface BrowserResetResult {
	/** Profile directories removed, as basenames. */
	removed: string[];
	/** Chrome was running and had to be stopped first. */
	quitChrome: boolean;
	/** Set when the reset REFUSED: Chrome would not exit, so nothing was touched. */
	refused?: string;
}

export interface BrowserResetOptions {
	home?: string;
	/** Injected in tests so the suite never signals a real process. */
	pids?: () => Promise<number[]>;
	term?: (pids: number[]) => Promise<void>;
	rm?: (dir: string) => void;
	sleep?: (ms: number) => Promise<void>;
}

const CHROME_EXEC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function runningChrome(): Promise<number[]> {
	return new Promise((resolve) => {
		// -f against the full executable path: `pgrep -x "Google Chrome"` needs the name as ONE
		// argument, and the space in it does not survive every caller. The renderer/GPU helpers
		// are deliberately not matched — they exit with the browser process.
		execFile("pgrep", ["-f", `^${CHROME_EXEC.replace(/ /g, ".")}$`], (err, stdout) => {
			resolve((stdout ?? "").trim().split("\n").filter(Boolean).map(Number).filter(Number.isFinite));
		});
	});
}

function termChrome(pids: number[]): Promise<void> {
	return new Promise((resolve) => {
		// SIGTERM, never SIGKILL. Chrome flushes its databases on TERM; killing it outright on a
		// box holding hundreds of credentials risks a corrupt store, which is the state this verb
		// exists to avoid producing.
		execFile("kill", pids.map(String), () => resolve());
	});
}

/**
 * Do it. Returns what was removed, or refuses with nothing touched.
 *
 * The refusal is not politeness: deleting a profile out from under a live Chrome gets the files
 * written back on quit, so a "success" that left the browser running would be a lie.
 */
export async function resetBrowserProfiles(opts: BrowserResetOptions = {}): Promise<BrowserResetResult> {
	const home = opts.home ?? os.homedir();
	const pids = opts.pids ?? runningChrome;
	const term = opts.term ?? termChrome;
	const rm = opts.rm ?? ((dir: string) => fs.rmSync(dir, { recursive: true, force: true }));
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

	let quitChrome = false;
	const live = await pids();
	if (live.length) {
		quitChrome = true;
		await term(live);
		// Give it time to flush and exit, then CHECK — the check is the point, not the wait.
		for (let i = 0; i < 20; i++) {
			await sleep(500);
			if (!(await pids()).length) break;
		}
		const still = await pids();
		if (still.length)
			return { removed: [], quitChrome, refused: `Chrome is still running (pid ${still.join(", ")}) — refusing to delete profiles it has open` };
	}

	const removed: string[] = [];
	for (const dir of profileDirs(chromeRoot(home))) {
		rm(dir);
		removed.push(path.basename(dir));
	}

	return { removed, quitChrome };
}
