import { execFile } from "node:child_process";

/**
 * Ask macOS to do things to an application, by name.
 *
 * Two callers need the same "make sure this app is actually gone" behaviour for unrelated
 * reasons — `runner/profiles.ts` before it moves an app's data out from under it, and
 * `harness.ts` when an app is running but unobservable — and getting it wrong is quiet in both
 * cases: the app keeps running, the next step succeeds, and the wrong thing happens later.
 *
 * Nothing here knows about any particular app. The name is a parameter and reaches AppleScript
 * and `pgrep`, both of which take it as data.
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const POLL_MS = 400;

/** AppleScript string literal escaping. The app name arrives from a dispatch parameter. */
function quoted(app: string): string {
	return app.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function osascript(lines: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
	return exec("osascript", lines.flatMap((l) => ["-e", l]), timeoutMs);
}

/** Whether any process with this name is running, as LaunchServices sees it. */
export async function isRunning(app: string): Promise<boolean> {
	const out = await osascript([
		`tell application "System Events" to return (exists (processes where name is "${quoted(app)}"))`,
	]).catch(() => "false");

	return out.trim() === "true";
}

/**
 * Open an app, choosing whether the console user is allowed to notice.
 *
 * The default is `open -g`: launch it, leave the window order alone. That is what a fleet Mac
 * needs almost always, because a run may be recording and a window arriving in front of it
 * corrupts the take.
 *
 * `foreground: true` is the sign-in case, where the opposite is true — an operator is about to
 * connect over screen sharing and the app being behind whatever else is open IS the problem.
 * The extra `activate` is not redundant with `open -a`: for an Electron app whose window the
 * last person closed, `activate` is what fires the reopen handler that builds a new one, and
 * a raised app with no window is indistinguishable over VNC from nothing having happened.
 * Its failure is not fatal — the app is open either way, which is most of the value.
 */
export async function openApp(app: string, opts: { foreground?: boolean } = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
	await exec("open", [...(opts.foreground ? [] : ["-g"]), "-a", app], timeoutMs);
	if (opts.foreground) await osascript([`tell application "${quoted(app)}" to activate`], timeoutMs).catch(() => {});
}

/**
 * Launch an app with extra process arguments.
 *
 * `open --args` passes them ONLY when open genuinely starts the process — an already-running app
 * ignores them entirely. That is why this pairs with the cold start: a run that inherits a live
 * app inherits whatever flags it was started with, which may be none.
 *
 * Backgrounded (`-g`) like openApp's default: acquisition activates deliberately a moment later
 * (AxBackend.acquire), and stealing focus twice makes the launch animation race the first
 * observation.
 */
export async function openWithArgs(app: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
	await exec("open", ["-g", "-a", app, "--args", ...args], timeoutMs);
}

/**
 * Quit an app and confirm it actually went.
 *
 * AppleScript `quit` rather than a signal: it is the documented shutdown path, so the app gets
 * to flush and close its own storage rather than leaving a cookie jar mid-write. An app that is
 * not running is not an error — quitting it is a no-op and this returns immediately.
 *
 * Escalates to `pkill` on timeout, which a modal "Save changes?" sheet will otherwise sit behind
 * forever. Both callers are about to discard or replace this app's state, so there is nothing in
 * the unsaved work worth leaving the app running for.
 */
export async function quitApp(app: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
	await osascript([`tell application "${quoted(app)}" to quit`], timeoutMs).catch(() => {});

	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await isRunning(app))) return;
		await new Promise((r) => setTimeout(r, POLL_MS));
	}

	await exec("pkill", ["-x", app], timeoutMs).catch(() => {});
	await new Promise((r) => setTimeout(r, 1500));
	if (await isRunning(app)) throw new Error(`"${app}" would not quit`);
}

function exec(cmd: string, args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
	});
}
