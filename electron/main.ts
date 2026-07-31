import { app, BrowserWindow, desktopCapturer, ipcMain, net, protocol, shell, systemPreferences } from "electron";
import fs from "node:fs";
import { Readable } from "node:stream";
import { appBundlePath, listApps, listRecordedRuns, parseByteRange, readUiState, resolveVideo, RunController, writeUiState, type RunHandlers, type RunOptions } from "../src/ui-core.js";
import { page } from "../src/ui-page.js";
import { describeCredentials, provisionFromBundle } from "../src/remote/team.js";
import {
	annotateRuns,
	appChoices,
	beginSignin,
	completeSignin,
	fleetView,
	hostChoices,
	isRemoteHost,
	readRemotePrefs,
	RemoteRunController,
	saveModelKey,
	writeRemotePrefs,
} from "../src/ui-remote.js";
import { startRunner } from "../src/runner/serve.js";
import { PACKAGED_ENV } from "../src/runner/spawn.js";

/**
 * Electron shell for the demo agent.
 *
 * Why Electron rather than the node:http UI or a native Swift app: Yarn's product IS an
 * Electron app, so this is the deployment target rather than a middle ground, and
 * @trycua/cua-driver ships first-party Electron support for exactly this case. See
 * docs/research/2026-07-29-packaging-native-vs-electron.md.
 *
 * Two things this buys that the web UI cannot:
 * - **Permission attribution.** The driver's permission primitives run in the importing
 *   host process, so macOS attributes Accessibility/Screen Recording to THIS app rather
 *   than to whichever terminal ran npm. The README is explicit that the daemon must be
 *   spawned by the process owning the grants — launching via a terminal or `open` breaks
 *   the responsibility chain, which is what our current setup does.
 * - **Signed-bundle capture.** ScreenCaptureKit delivers no frames to an unsigned CLI on
 *   macOS 26 (LIMITATIONS §3), which is why recording is ~4fps snapshots + ffmpeg today.
 *   A signed .app is not subject to that.
 *
 * Packaging note for later: `cua-driver` must ship OUTSIDE ASAR with its executable bit
 * preserved, and be signed before the enclosing app is signed and notarized.
 *
 * The renderer's markup and script live in src/ui-page.ts and reach this process only
 * through `window.__bus`, injected below. That seam is why the page carries no Electron
 * import: the host is swappable and the page's logic stays testable without one.
 */

// Must be declared BEFORE app.whenReady(): a scheme registered later is not treated as
// privileged, and <video> then refuses to stream from it (no range support, no bypass of
// the data: document's null origin).
protocol.registerSchemesAsPrivileged([
	{ scheme: "agentvideo", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

const runs = new RunController();
const remote = new RemoteRunController();
let win: BrowserWindow | undefined;

/** Injected before the shared app script; implements the `window.__bus` contract. */
const BOOTSTRAP = String.raw`
const { ipcRenderer } = require('electron');
window.__videoBase = 'agentvideo:///';
window.__bus = {
  loadApps: (host) => ipcRenderer.invoke('apps', host),
  appIcon: (name) => ipcRenderer.invoke('appIcon', name),
  loadRuns: () => ipcRenderer.invoke('runs'),
  // Encode per SEGMENT: encodeURIComponent on the whole path turns every "/" into %2F,
  // leaving a standard-scheme URL with no path to route, so the request never reaches the
  // handler at all (symptom: a black video stuck at 0:00 and no protocol log line).
  videoUrl: (rel) => window.__videoBase + rel.split('/').map(encodeURIComponent).join('/'),
  run: (opts) => ipcRenderer.invoke('run', opts),
  ground: (app, host, url) => ipcRenderer.invoke('ground', { app, host, url }),
  stop: () => ipcRenderer.invoke('stop'),
  // Fleet. Every one of these answers something on a "no hosts.json" machine rather than
  // throwing, so the local-only shell needs no branch of its own.
  loadHosts: () => ipcRenderer.invoke('hosts'),
  loadFleet: () => ipcRenderer.invoke('fleet'),
  attach: (host, jobId, app) => ipcRenderer.invoke('attach', { host, jobId, app }),
  signin: (host, app) => ipcRenderer.invoke('signin', { host, app }),
  signinWait: (host, app) => ipcRenderer.invoke('signin:wait', { host, app }),
  loadCreds: () => ipcRenderer.invoke('creds'),
  saveKey: (key) => ipcRenderer.invoke('creds:save', key),
  loadHostPref: () => ipcRenderer.invoke('host:load'),
  saveHostPref: (host) => ipcRenderer.send('host:save', host),
  loadState: () => ipcRenderer.invoke('state:load'),
  // send, not invoke: this is also called from beforeunload, where the renderer will not
  // survive long enough to await a reply. The message is queued before teardown.
  saveState: (s) => ipcRenderer.send('state:save', s),
  onStarted: (cb) => ipcRenderer.on('started', (_e, d) => cb(d)),
  onLine: (cb) => ipcRenderer.on('line', (_e, t) => cb(t)),
  onDone: (cb) => ipcRenderer.on('done', (_e, d) => cb(d)),
};
`;

/**
 * Report macOS grants. Read-only: `getMediaAccessStatus` never prompts, and
 * `isTrustedAccessibilityClient(false)` explicitly suppresses the dialog — the agent
 * itself surfaces a clearer failure than a permission sheet fired at launch would.
 */
function permissionState(): { accessibility: boolean; screenRecording: boolean } {
	if (process.platform !== "darwin") return { accessibility: true, screenRecording: true };

	return {
		accessibility: systemPreferences.isTrustedAccessibilityClient(false),
		screenRecording: systemPreferences.getMediaAccessStatus("screen") === "granted",
	};
}

/**
 * ASK for the grants, as opposed to reading them.
 *
 * Needed because of an asymmetry in System Settings that costs an afternoon if you meet it
 * without knowing: **Accessibility has a `+` button and Screen & System Audio Recording does
 * not**. macOS builds the Screen Recording list out of processes that have called
 * `CGRequestScreenCaptureAccess` — an app that never asked has no row, and there is no way to
 * add one by browsing to the bundle. `permissionState()` above is deliberately non-prompting on
 * both counts, so a runner installed by `provision` has asked for nothing and is invisible in
 * exactly the pane an operator is told to go tick.
 *
 * The two calls below are the asking. Neither grants anything — TCC is SIP-protected and only a
 * human at the machine can flip the switch — they put the row on screen so there is a switch to
 * flip:
 *
 *   - `isTrustedAccessibilityClient(true)`: the `true` is "show the dialog", which also
 *     registers the app in the Accessibility list.
 *   - `desktopCapturer.getSources`: Electron has no direct binding for
 *     `CGRequestScreenCaptureAccess`, and `askForMediaAccess` handles only microphone and
 *     camera — never screen. Enumerating sources is what reaches it.
 *
 * Returns the state AFTER asking, which will normally still be false: the operator has not
 * touched the toggle yet, and macOS does not apply a new Screen Recording grant to an already
 * running process anyway. The caller says so rather than reporting failure.
 */
async function requestPermissions(): Promise<{ accessibility: boolean; screenRecording: boolean }> {
	if (process.platform !== "darwin") return permissionState();

	systemPreferences.isTrustedAccessibilityClient(true);
	try {
		// thumbnailSize 0: the pixels are thrown away. The call is made for the TCC registration
		// it triggers, and capturing full-size images of every display to discard them would be
		// slow on a multi-monitor Mac for no gain.
		await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
	} catch {
		// Denied or unavailable. The registration happens on the ATTEMPT, so the row appears
		// either way and there is nothing here worth failing the call over.
	}

	return permissionState();
}

function createWindow(): void {
	win = new BrowserWindow({
		width: 1180,
		height: 820,
		title: "Self-driving demo agent",
		backgroundColor: "#16181d",
		titleBarStyle: "hiddenInset",
		webPreferences: {
			// nodeIntegration is acceptable here and nowhere near a shipping default: this
			// renderer loads one local data: URL we generate, never remote content.
			nodeIntegration: true,
			contextIsolation: false,
		},
	});

	const perms = permissionState();
	const banner = perms.accessibility && perms.screenRecording
		? ""
		: `<div style="padding:9px 20px;background:#3a2f1c;border-bottom:1px solid #6b552c;color:#f0d9a8;font:13px ui-sans-serif,system-ui">` +
			`Missing macOS permission: ${[!perms.accessibility && "Accessibility", !perms.screenRecording && "Screen Recording"]
				.filter(Boolean)
				.join(" + ")}. ` +
			`Grant them to this app in System Settings ▸ Privacy &amp; Security, then relaunch — ` +
			`grants follow the app that spawns the driver.</div>`;

	const html = banner + page(BOOTSTRAP);
	void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
	win.on("closed", () => {
		runs.stop();
		// detach, not stop: a local run dies with the window because its child is ours, but a
		// remote job is a detached process on another Mac and closing a viewer must not kill it.
		// The fleet row keeps its id, so the next launch can offer to follow it again.
		remote.detach();
		win = undefined;
	});
}

// Answers for the SELECTED host, not for this Mac. A colo Mac's list comes from its own runner,
// which enumerates its own /Applications and its own appmaps — see appChoices.
ipcMain.handle("apps", (_event, host?: string) => appChoices(host, listApps));

/**
 * A local app's bundle icon as a data URL, "" when there is none to give.
 *
 * Cached per name for the life of the process: `getFileIcon` decodes the bundle's .icns on
 * every call and the list repaints on every keystroke. Failures cache as "" too — a missing
 * icon must never break the list, and re-statting a known-absent bundle buys nothing. Local
 * host only by construction: the renderer never asks for a remote list's entries, and a colo
 * Mac's bundles are not on this disk anyway.
 */
const appIcons = new Map<string, string>();
ipcMain.handle("appIcon", async (_event, name: unknown) => {
	const key = String(name ?? "");
	const cached = appIcons.get(key);
	if (cached !== undefined) return cached;

	let url = "";
	try {
		const bundle = appBundlePath(key);
		if (bundle) url = (await app.getFileIcon(bundle, { size: "small" })).toDataURL();
	} catch {
		// No icon is a fine answer; the renderer shows the name alone.
	}
	appIcons.set(key, url);

	return url;
});

/** Gallery entries, tagged with the Mac each one was pulled from. Local runs carry no tag. */
ipcMain.handle("runs", () => annotateRuns(listRecordedRuns()));

/**
 * Videos are served through a custom scheme rather than file:// — a data: document has a
 * null origin and cannot load file:// subresources, so <video src="file://…"> is blocked.
 */
function registerVideoProtocol(): void {
	protocol.handle("agentvideo", (request) => {
		// A `standard` scheme parses authority, so agentvideo:///out/x.mp4 puts "out" in
		// `host` and only "/x.mp4" in `pathname` — dropping the first path segment. Rejoin
		// them instead of reading pathname alone.
		const u = new URL(request.url);
		const rel = decodeURIComponent(`${u.host}${u.pathname}`).replace(/^\/+/, "");
		const full = resolveVideo(rel);
		if (!full) return new Response("not found", { status: 404 });

		// Serve ranges ourselves. net.fetch on a file:// URL answers 200 with the whole
		// body and no Accept-Ranges, and Chromium will not seek a resource it cannot range
		// -request — the symptom is a scrubber that does nothing, most visibly in
		// fullscreen where the timeline is the only control.
		//
		// Streamed, never readFileSync: this handler runs on the MAIN process, and a sync read
		// of a whole recording blocks every IPC in flight — including the live `line` events of
		// a run — once per seek.
		//
		// resolveVideo checked existence, but the file can go between that check and this stat —
		// a recording pruned mid-scrub has to answer 404, not throw inside the protocol handler.
		let size: number;
		try {
			size = fs.statSync(full).size;
		} catch {
			return new Response("not found", { status: 404 });
		}
		// A zero-byte mp4 is a recording mid-write. createReadStream rejects end:-1 where the
		// old readFileSync path served it, so answer the empty body directly.
		if (size === 0) return new Response(null, { status: 200, headers: { "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": "0" } });
		const stream = (start: number, end: number): ReadableStream =>
			Readable.toWeb(fs.createReadStream(full, { start, end })) as ReadableStream;
		const range = parseByteRange(request.headers.get("range"), size);
		if (range.kind === "unsatisfiable")
			return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
		if (range.kind === "part")
			return new Response(stream(range.start, range.end), {
				status: 206,
				headers: {
					"content-type": "video/mp4",
					"content-range": `bytes ${range.start}-${range.end}/${size}`,
					"accept-ranges": "bytes",
					"content-length": String(range.end - range.start + 1),
				},
			});

		return new Response(stream(0, size - 1), {
			status: 200,
			headers: { "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": String(size) },
		});
	});
}

/**
 * What the in-flight run is against, so `done` can name a remedy that points somewhere.
 *
 * Set at dispatch and deliberately NOT cleared afterwards: the page needs it precisely when the
 * run is over. The host is re-read from the controller rather than taken from here, because
 * `auto` is not a machine and only the controller learns which one it picked.
 */
let dispatched: { app: string; remote: boolean } | undefined;

/**
 * Deliver to the renderer if there still is one.
 *
 * `win` alone is not the test. Closing the window tears the webContents down before the
 * `closed` event clears `win`, and both shutdown paths emit MORE lines inside that gap: a
 * local child answers SIGINT with its exit output, and `remote.detach()` prints its own
 * farewell. `send` on a destroyed webContents throws, and that throw is in the main process —
 * so closing the window mid-run could take the app down instead of the window.
 */
function toRenderer(channel: string, payload: unknown): void {
	if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
	win.webContents.send(channel, payload);
}

const handlers: RunHandlers = {
	onLine: (line) => toRenderer("line", line),
	onDone: (code, elapsed) =>
		toRenderer("done", {
			code,
			elapsed,
			app: dispatched?.app ?? "",
			host: dispatched?.remote ? (remote.lastRunHost ?? "") : "local",
		}),
};

/**
 * One run at a time in this shell, local or remote.
 *
 * Not because two are technically impossible — a local run and a run on a colo Mac are on
 * different machines and do not contend — but because the window has one log pane, one status
 * line and one Stop button. Two streams into one pane is a transcript nobody can read, and a
 * Stop button whose target is ambiguous is worse than no Stop button.
 */
function alreadyBusy(): string | undefined {
	if (runs.active) return "a run is already in progress on this Mac";
	if (remote.busy) return `already following ${remote.attached?.jobId ?? "a remote run"} on ${remote.attached?.host} — stop or detach it first`;

	return undefined;
}

/** `host` rides along with the local RunOptions; `local` (or absent) takes the original path. */
type ShellRunOptions = RunOptions & { host?: string };

ipcMain.handle("run", (_event, opts: ShellRunOptions) => {
	const busy = alreadyBusy();
	if (busy) return busy;

	// The task text is handed to whichever controller runs it and read by neither: the audit
	// lives in agent.ts, on the machine that will execute the run (CLAUDE.md, "Measurement rule").
	dispatched = { app: opts.app, remote: isRemoteHost(opts.host) };
	const err = isRemoteHost(opts.host)
		? remote.start({ host: opts.host as string, app: opts.app, task: opts.task, kind: "task", record: opts.record, noVision: opts.noVision, ...(opts.url ? { url: opts.url } : {}) }, handlers)
		: runs.start(opts, handlers);
	if (!err) toRenderer("started", { app: opts.app, task: opts.task });

	return err;
});

ipcMain.handle("ground", (_event, { app, host, url }: { app: string; host?: string; url?: string }) => {
	const busy = alreadyBusy();
	if (busy) return busy;

	dispatched = { app, remote: isRemoteHost(host) };
	const err = isRemoteHost(host)
		? remote.start({ host: host as string, app, task: "", kind: "explore", record: false, noVision: false, ...(url ? { url } : {}) }, handlers)
		: runs.explore(app, handlers, url);
	if (!err) toRenderer("started", { app, task: `grounding pass — exploring ${app}` });

	return err;
});

/**
 * Re-attach to a run already in flight on a Mac.
 *
 * This is what makes closing the window survivable: the job is a detached child on the far
 * side and its log is a file there, so the only thing a restart ever lost was the id — which
 * the busy fleet row carries.
 */
ipcMain.handle("attach", async (_event, { host, jobId, app }: { host: string; jobId: string; app?: string }) => {
	const busy = alreadyBusy();
	if (busy) return busy;

	dispatched = { app: app || "", remote: true };
	const err = remote.attach(host, jobId, handlers);
	if (!err) toRenderer("started", { app: app || host, task: `following ${jobId} on ${host}` });

	return err;
});

/** Stop means stop the RUN, wherever it is. Detaching without stopping is what a close does. */
ipcMain.handle("stop", async () => (remote.busy ? remote.stop() : runs.stop()));

ipcMain.handle("hosts", () => hostChoices());

ipcMain.handle("fleet", () => fleetView());

/**
 * Open a screen-sharing session on a colo Mac so a human can clear a sign-in wall.
 *
 * `shell.openExternal` on a `vnc://` URL hands off to Screen Sharing.app, which owns the
 * credential prompt and the keychain entry for it. That is the point: nothing in this process
 * ever sees the operator's password for the machine or their password for the app under test.
 *
 * Not gated on `alreadyBusy()`. Signing in on one Mac while a run follows another is a normal
 * thing to want, and the far side refuses by itself if that Mac in particular is mid-run —
 * which it must, now that the app is brought to the FRONT over there rather than opened behind
 * everything. Only the runner knows whether a recording is in flight, so only the runner decides.
 */
ipcMain.handle("signin", async (_event, { host, app }: { host: string; app?: string }) => {
	const view = await beginSignin(String(host ?? ""), app);
	if (view.url) await shell.openExternal(view.url);

	return view;
});

/**
 * The second half of a sign-in: wait for the app to reach its home screen, then close the viewer.
 *
 * A separate call from `signin` because of how long it takes. This resolves when a human finishes
 * an SSO round trip — minutes, sometimes — and folding it into the handler above would leave the
 * panel's button spinning for all of it with the screen share already open and usable in front of
 * them. The renderer fires this after `signin` returns and lets the reply land whenever it lands.
 */
ipcMain.handle("signin:wait", (_event, { host, app }: { host: string; app: string }) =>
	completeSignin(String(host ?? ""), String(app ?? "")),
);

ipcMain.handle("creds", () => describeCredentials());

// The key never comes back out: saveModelKey re-reads the file and answers with the same
// present/absent boolean the panel shows on load.
ipcMain.handle("creds:save", (_event, key: string) => saveModelKey(String(key ?? "")));

ipcMain.handle("host:load", () => readRemotePrefs());

ipcMain.on("host:save", (_event, host: unknown) => writeRemotePrefs({ host: String(host ?? "") }));

ipcMain.handle("state:load", () => readUiState());

ipcMain.on("state:save", (_event, state: unknown) => writeUiState(state));


/**
 * Headless mode for the Macs in the fleet: hold the socket, spawn runs, show no window.
 *
 * It has to be THIS process rather than a node daemon because macOS attributes Accessibility
 * and Screen Recording to the responsible process and children inherit them. A run started
 * from an SSH session is responsible to sshd and gets an empty AX tree with no error to
 * explain it; a run started from here inherits the grants this app already holds.
 */
const serveMode = process.argv.includes("--serve");

void app.whenReady().then(async () => {
	// Read before anything spawns: resolveRunCommand and childEnv both branch on it, and a
	// packaged child needs ELECTRON_RUN_AS_NODE to behave as a node runtime.
	process.env[PACKAGED_ENV] = app.isPackaged ? "1" : "";

	// First launch on a teammate's Mac IS their enrollment: if the shipped bundle is present it
	// installs the fleet ssh key and the model key here, so nobody has to open a terminal, run
	// enroll, or be handed a password. Absent bundle is the normal developer case and not an
	// error; a machine that already has an identity keeps it.
	try {
		const provisioned = provisionFromBundle();
		if (provisioned) console.log(`team credentials (${provisioned.source}): identity ${provisioned.identity}, model key ${provisioned.modelKey}`);
	} catch (err) {
		// Never fatal. A malformed bundle must leave a usable local-only app rather than an app
		// that will not open, which is the one failure a teammate cannot work around.
		console.error(`team credentials ignored: ${(err as Error).message}`);
	}

	if (serveMode) {
		// No dock icon, no window: this runs under a LaunchAgent on a machine nobody is
		// sitting at, and a bouncing icon there is noise in a recording.
		app.dock?.hide();
		await startRunner(undefined, { permissions: permissionState, requestPermissions });

		return;
	}

	registerVideoProtocol();
	createWindow();
});

app.on("window-all-closed", () => {
	// In serve mode there never was a window, and Electron fires this once at startup on some
	// versions — quitting here would make the runner exit the moment launchd started it.
	if (serveMode) return;
	runs.stop();
	app.quit();
});

app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
