import { app, BrowserWindow, ipcMain, net, protocol, systemPreferences } from "electron";
import fs from "node:fs";
import { listApps, listRecordedRuns, resolveVideo, RunController, type RunOptions } from "../src/ui-core.js";
import { page } from "../src/ui-page.js";

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
 * The renderer is the same markup and script the web shell serves (src/ui-page.ts); only
 * the transport differs — ipcRenderer here, fetch + EventSource there.
 */

// Must be declared BEFORE app.whenReady(): a scheme registered later is not treated as
// privileged, and <video> then refuses to stream from it (no range support, no bypass of
// the data: document's null origin).
protocol.registerSchemesAsPrivileged([
	{ scheme: "agentvideo", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

const runs = new RunController();
let win: BrowserWindow | undefined;

/** Injected before the shared app script; implements the `window.__bus` contract. */
const BOOTSTRAP = String.raw`
const { ipcRenderer } = require('electron');
window.__videoBase = 'agentvideo:///';
window.__bus = {
  loadApps: () => ipcRenderer.invoke('apps'),
  loadRuns: () => ipcRenderer.invoke('runs'),
  // Encode per SEGMENT: encodeURIComponent on the whole path turns every "/" into %2F,
  // leaving a standard-scheme URL with no path to route, so the request never reaches the
  // handler at all (symptom: a black video stuck at 0:00 and no protocol log line).
  videoUrl: (rel) => window.__videoBase + rel.split('/').map(encodeURIComponent).join('/'),
  run: (opts) => ipcRenderer.invoke('run', opts),
  stop: () => ipcRenderer.invoke('stop'),
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
		win = undefined;
	});
}

ipcMain.handle("apps", () => listApps());

ipcMain.handle("runs", () => listRecordedRuns());

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
		const size = fs.statSync(full).size;
		const range = request.headers.get("range");
		const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
		if (match) {
			const start = match[1] ? Number(match[1]) : 0;
			const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
			if (start >= size || start > end)
				return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });

			return new Response(fs.readFileSync(full).subarray(start, end + 1), {
				status: 206,
				headers: {
					"content-type": "video/mp4",
					"content-range": `bytes ${start}-${end}/${size}`,
					"accept-ranges": "bytes",
					"content-length": String(end - start + 1),
				},
			});
		}

		return new Response(fs.readFileSync(full), {
			status: 200,
			headers: { "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": String(size) },
		});
	});
}

ipcMain.handle("run", (_event, opts: RunOptions) => {
	const err = runs.start(opts, {
		onLine: (line) => win?.webContents.send("line", line),
		onDone: (code, elapsed) => win?.webContents.send("done", { code, elapsed }),
	});
	if (!err) win?.webContents.send("started", { app: opts.app, task: opts.task });

	return err;
});

ipcMain.handle("stop", () => runs.stop());


void app.whenReady().then(() => {
	registerVideoProtocol();
	createWindow();
});

app.on("window-all-closed", () => {
	runs.stop();
	app.quit();
});

app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
