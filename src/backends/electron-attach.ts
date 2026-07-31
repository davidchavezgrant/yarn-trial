import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

/**
 * Electron attach for the CDP backend: resolve an app NAME into a debuggable endpoint,
 * launching the app with `--remote-debugging-port` when nothing is listening yet.
 *
 * Why launching is now this side's job (plan 2026-07-31, demo actuation): driving an
 * Electron app over CDP injects input into the RENDERER — the machine's real mouse,
 * keyboard and focus are never touched, and element geometry + screenshots come from one
 * renderer space, so the AX path's coordinate-mismatch class of bug cannot exist. All of
 * that requires the debug port, and the only process that can put the flag on the command
 * line is a launch. What this module will NOT do is touch an instance it did not launch:
 * a running app may hold the user's unsaved work, and a debug port cannot be injected into
 * a live process anyway — "running without the port" is an error naming the fix, never a
 * kill.
 */

/** Where installed bundles live. The exact-name lookup is deliberate: the app name is the
 *  same string the AX path launches by, and a fuzzy match that finds "Yarn Beta" for
 *  "Yarn" would silently drive the wrong build. */
const APP_DIRS = ["/Applications", `${os.homedir()}/Applications`];

/**
 * Launch flags beyond the port. Chromium throttles rendering (timers, rAF, compositing)
 * for occluded and backgrounded windows; a recorded run screenshots the page while the
 * operator works elsewhere, so throttling would freeze the exact frames the recording
 * needs. These two switches keep the renderer painting with the app fully hidden.
 */
const KEEP_RENDERING_FLAGS = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"];

/** How long a cold app launch gets to expose its endpoint. Electron boots slower than
 *  Chrome (updaters, single-instance locks), so this is double the Chrome budget. */
const LAUNCH_TIMEOUT_MS = 20_000;
const LAUNCH_POLL_MS = 250;

/** Poll a debugging endpoint until it answers, or give up. */
export async function endpointAlive(url: string, attempts: number, delayMs: number): Promise<boolean> {
	for (let i = 0; i < attempts; i++) {
		try {
			const r = await fetch(`${url}/json/version`);
			if (r.ok) return true;
		} catch {}
		await new Promise((r) => setTimeout(r, delayMs));
	}

	return false;
}

/**
 * App name -> the bundle's main executable, erroring with where it looked.
 *
 * CFBundleExecutable is authoritative — the binary is frequently NOT named after the
 * bundle ("Visual Studio Code.app" runs "Electron") — and plutil ships with macOS. A
 * bundle whose Info.plist is unreadable falls back to the conventional name, and the
 * existence check below turns either miss into the honest error.
 */
export function appExecutable(appName: string, dirs: string[] = APP_DIRS): string {
	for (const dir of dirs) {
		const bundle = `${dir}/${appName}.app`;
		if (!fs.existsSync(bundle)) continue;
		let exe = appName;
		try {
			exe = execFileSync("plutil", ["-extract", "CFBundleExecutable", "raw", `${bundle}/Contents/Info.plist`], { encoding: "utf8" }).trim() || appName;
		} catch {}
		const bin = `${bundle}/Contents/MacOS/${exe}`;
		if (!fs.existsSync(bin)) throw new Error(`${bundle} exists but has no executable at Contents/MacOS/${exe}`);

		return bin;
	}
	throw new Error(
		`no "${appName}.app" in ${dirs.join(" or ")} — install the app, or check the name matches the bundle exactly (case included)`,
	);
}

/**
 * Is any process of the bundle up? Matched on the bundle path so the app's Helper
 * processes (which live under Contents/Frameworks/) count too — a half-quit app whose
 * main process died but whose helpers linger still holds the single-instance lock, and
 * relaunching under it produces a silent no-op instead of a debug port.
 */
function bundleRunning(executable: string): boolean {
	const bundle = executable.replace(/\/Contents\/MacOS\/[^/]+$/, "");
	try {
		// pgrep -f takes a regex; the path's dots widen the match only trivially.
		execFileSync("pgrep", ["-f", `${bundle}/`], { stdio: "ignore" });

		return true;
	} catch {
		return false; // exit 1: no match
	}
}

/**
 * Bring up a CDP endpoint for the app: attach if one is already listening, launch the
 * app with the debug flag when it is not running at all, and refuse — with the fix in
 * the message — when it is running WITHOUT the flag. Quitting the user's app is the
 * operator's call, not this code's.
 */
export async function ensureElectronEndpoint(appName: string, endpoint: string, port: number): Promise<void> {
	if (await endpointAlive(endpoint, 1, 0)) return; // already running WITH the port

	const bin = appExecutable(appName);
	if (bundleRunning(bin))
		throw new Error(
			`${appName} is already running WITHOUT a debug port, and one cannot be added to a live process. ` +
				`Quit ${appName} (cmd+Q) and re-run — the run relaunches it with --remote-debugging-port=${port}. ` +
				`If you launched it with a debug port on another number, set CDP_PORT to match instead.`,
		);

	console.log(`launching ${appName} with --remote-debugging-port=${port}`);
	// Detached and left running on close, same as the Chrome launch in cdp.ts: the app is
	// the session holder, and the next run reattaches in milliseconds.
	const child = spawn(bin, [`--remote-debugging-port=${port}`, ...KEEP_RENDERING_FLAGS], { stdio: "ignore", detached: true });
	// The poll below produces the honest failure message; an async spawn error would only
	// add an uncaught crash before it.
	child.on("error", () => {});
	child.unref();
	if (!(await endpointAlive(endpoint, Math.ceil(LAUNCH_TIMEOUT_MS / LAUNCH_POLL_MS), LAUNCH_POLL_MS)))
		throw new Error(
			`${appName} launched but exposed no debugging endpoint at ${endpoint} within ${LAUNCH_TIMEOUT_MS / 1000}s — ` +
				`it may ignore Chromium switches, or an updater relaunched it without them`,
		);
}

/** One CDP page target, reduced to what the chooser needs. viewport is window.innerWidth/
 *  innerHeight in CSS pixels; null when the page could not be measured. */
export interface PageCandidate {
	url: string;
	title: string;
	viewport: { width: number; height: number } | null;
}

/** Never the app's window: devtools, extension machinery, background/worker pages. */
const NON_WINDOW_URL = /^(devtools:|chrome:|chrome-extension:|chrome-untrusted:)|background[^/]*\.(html?|js)([?#]|$)|service[-_]?worker/i;

/**
 * Which page target is the app's main window. An Electron endpoint exposes every window
 * plus devtools and background pages; heuristic: drop the obvious non-windows, prefer the
 * largest viewport, break exact-area ties toward the title naming the app. Pure over the
 * candidate list so it is testable without a browser. Returns the index into `pages`;
 * -1 when nothing qualifies (the caller reports the list it saw).
 */
export function pickMainPage(pages: PageCandidate[], appName: string): number {
	const app = appName.toLowerCase();
	let best = -1;
	let bestArea = -1;
	let bestTitled = false;
	for (let i = 0; i < pages.length; i++) {
		const p = pages[i];
		if (NON_WINDOW_URL.test(p.url)) continue;
		const area = p.viewport ? p.viewport.width * p.viewport.height : 0;
		const titled = p.title.toLowerCase().includes(app);
		if (area > bestArea || (area === bestArea && titled && !bestTitled)) {
			best = i;
			bestArea = area;
			bestTitled = titled;
		}
	}

	return best;
}
