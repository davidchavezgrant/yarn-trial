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
 * Whether one ps line is a MAIN process of the app whose outer executable this is.
 *
 * Main process only — because that is the process that owns the debug flag and Chromium's
 * single-instance lock. Helper processes (crashpad, recordkit, renderers under
 * Contents/Frameworks/) routinely outlive a cmd+Q by design and hold neither; counting
 * them as "running" made a cleanly-quit app refuse to relaunch (observed with Yarn's
 * lingering crashpad handler, 2026-07-31).
 *
 * Matched by BUNDLE, not by exact binary path: Yarn ships an app-in-an-app, and
 * `open -a Yarn` runs the INNER bundle's binary
 * (`Yarn.app/Contents/Resources/Yarn.app/Contents/MacOS/Yarn`) while `appExecutable`
 * resolves the outer one. An exact-path match read that as "not running", launched a
 * second instance beside it, and the two fought over one user-data dir until the readiness
 * gate refused (observed 2026-07-31, the first BENCH_QUIT_PORTLESS seam test). A main
 * process is therefore any argv[0] under the bundle at `<something>/Contents/MacOS/<bin>`
 * that is not a Frameworks helper.
 */
export function isMainProcessOf(argv: string, executable: string): boolean {
	const bundle = executable.replace(/\/Contents\/MacOS\/[^/]+$/, "");
	if (bundle === executable) return argv === executable || argv.startsWith(`${executable} `);
	const bin = argv.split(" --")[0];

	return (
		bin.startsWith(`${bundle}/`) &&
		/\/Contents\/MacOS\/[^/]+$/.test(bin) &&
		!bin.includes("/Contents/Frameworks/")
	);
}

function mainProcessArgv(executable: string): string | undefined {
	// The pgrep pattern is the BUNDLE root, so nested-bundle mains match too; the filter
	// below is what separates them from Frameworks helpers.
	const bundle = executable.replace(/\/Contents\/MacOS\/[^/]+$/, "");
	let pids: string[];
	try {
		// pgrep -f takes a regex; escape the path's regex metacharacters (dots, spaces are fine).
		pids = execFileSync("pgrep", ["-f", bundle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")], { encoding: "utf8" })
			.trim()
			.split("\n");
	} catch {
		return undefined; // exit 1: no match at all, helpers included
	}
	for (const pid of pids) {
		try {
			const argv = execFileSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }).trim();
			if (isMainProcessOf(argv, executable)) return argv;
		} catch {}
	}

	return undefined;
}

/** The debug port an argv declares, if any. Pure, for tests. */
export function debugPortFromArgv(argv: string): number | undefined {
	const m = argv.match(/--remote-debugging-port=(\d+)/);

	return m ? Number(m[1]) : undefined;
}

/** Executable path of whatever is LISTENING on the port, or undefined when it is free. */
function portOwnerPath(port: number): string | undefined {
	try {
		const pid = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim().split("\n")[0];
		if (!pid) return undefined;

		return execFileSync("ps", ["-o", "comm=", "-p", pid], { encoding: "utf8" }).trim() || `pid ${pid}`;
	} catch {
		return undefined; // lsof exit 1: nothing listening
	}
}

/** Tries past ports squatted by other apps when picking a launch port. */
const PORT_SCAN_SPAN = 20;

/**
 * Bring up a CDP endpoint for the app and return where it landed. Process truth first,
 * endpoint second — the port number proves nothing about who owns it: the first live run
 * of this path attached to Notion Calendar (which happened to hold the default 9222) and
 * drove the wrong app. So:
 *
 *   app running WITH the flag    -> attach to the port ITS argv declares (CDP_PORT need not match)
 *   app running WITHOUT the flag -> refuse with the fix; quitting the user's app is not this code's call
 *   app not running              -> launch it on a port nothing else is listening on
 *
 * Lingering helper processes after a cmd+Q count as "not running" — see mainProcessArgv.
 *
 * `BENCH_QUIT_PORTLESS=1` softens the middle case to a polite quit-and-relaunch. It exists
 * for the benchmark fleet, where an ax arm leaves the app running portless and the cdp arm
 * behind it in the queue owns the machine anyway (the runner's lease says so) — refusing
 * there fails every cdp-after-ax arm for a reason no operator is present to fix. It stays
 * opt-in because on an operator's own Mac the refusal is the right answer: the running app
 * may hold their unsaved work, and quitting it is not this code's call.
 */
export async function ensureElectronEndpoint(appName: string, preferredPort: number): Promise<{ endpoint: string; port: number }> {
	const bin = appExecutable(appName);

	const argv = mainProcessArgv(bin);
	if (argv) {
		const declared = debugPortFromArgv(argv);
		if (declared === undefined) {
			if (process.env.BENCH_QUIT_PORTLESS !== "1")
				throw new Error(
					`${appName} is already running WITHOUT a debug port, and one cannot be added to a live process. ` +
						`Quit ${appName} (cmd+Q) and re-run — the run relaunches it with --remote-debugging-port=${preferredPort}.`,
				);
			console.log(`${appName} is running without a debug port — quitting it to relaunch with one (BENCH_QUIT_PORTLESS)`);
			const { quitApp } = await import("../core/appctl.js");
			await quitApp(appName);
			// Fall through to the launch path below: mainProcessArgv would now return
			// undefined, so the state is exactly the "not running" case.
		} else {
			const endpoint = `http://127.0.0.1:${declared}`;
			if (!(await endpointAlive(endpoint, 8, 250)))
				throw new Error(`${appName} is running with --remote-debugging-port=${declared} but ${endpoint} is not answering`);
			if (declared !== preferredPort) console.log(`${appName} already exposes its own debug port ${declared} — attaching there`);

			return { endpoint, port: declared };
		}
	}

	let port = preferredPort;
	for (let tries = 0; ; port++, tries++) {
		if (tries >= PORT_SCAN_SPAN)
			throw new Error(`no free debug port in ${preferredPort}..${port - 1} — every one has a listener already`);
		const owner = portOwnerPath(port);
		if (owner === undefined) break;
		console.log(`port ${port} is held by ${owner} — trying ${port + 1}`);
	}

	const endpoint = `http://127.0.0.1:${port}`;
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
	// The scan-then-launch above races anything else binding ports; one owner check after
	// the endpoint answers turns a lost race into an error instead of a wrong-app attach.
	const owner = portOwnerPath(port);
	if (owner && owner !== bin && !owner.startsWith(bin.replace(/\/Contents\/MacOS\/[^/]+$/, "")))
		throw new Error(`endpoint on ${port} answered but belongs to ${owner}, not ${appName} — re-run to retry on a fresh port`);

	return { endpoint, port };
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
