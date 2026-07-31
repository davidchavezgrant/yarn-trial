import { app, BrowserWindow, desktopCapturer, ipcMain, net, protocol, shell, systemPreferences, WebContentsView } from "electron";
import { execFile, spawn as spawnProcess } from "node:child_process";
import fs from "node:fs";
import { Readable } from "node:stream";
import { defaultOperator, loadHosts, resolveHost, type HostEntry } from "../src/remote/control/hosts.js";
import { lastFrame, runnerArgv, runSsh, tunnelArgv } from "../src/remote/control/ssh.js";
import { SigninPortal } from "../src/ui/ui-signin.js";
import { HumanizeController, listApps, listRecordedRuns, parseByteRange, readUiState, resolveVideo, RunController, writeUiState, type RunHandlers, type RunOptions } from "../src/ui/ui-core.js";
import { page } from "../src/ui/ui-page.js";
import { describeCredentials, provisionFromBundle } from "../src/remote/control/team.js";
import {
	annotateRuns,
	appChoices,
	beginSignin,
	cancelQueuedView,
	clearAuthView,
	completeSignin,
	deleteAppView,
	fleetView,
	hostChoices,
	installAppView,
	isRemoteHost,
	readRemotePrefs,
	RemoteRunController,
	saveModelKey,
	writeRemotePrefs,
} from "../src/ui/ui-remote.js";
import { startRunner } from "../src/remote/runner/serve.js";
import { PACKAGED_ENV } from "../src/remote/runner/spawn.js";

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
 * The renderer's markup and script live in src/ui/ui-page.ts and reach this process only
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
/**
 * One live remote follow per HOST, keyed by the host the run was submitted under (`auto`
 * included). The moment dispatch resolves `auto` — or an alias — to a real machine, the
 * run's own `onHost` handler re-keys the entry, so lookups by either name land on it and a
 * second `auto` submit is free to go while this one runs. Entries are removed on `done` by
 * identity, never by key alone: keys can move under a controller mid-run.
 */
const remotes = new Map<string, RemoteRunController>();
// Its own controller, not a verb on RunController: rendering a cursor is local ffmpeg work
// with no driver session, so it must stay OUTSIDE the single-run guard and keep working while
// an agent run is in flight.
const humanizer = new HumanizeController();

/**
 * The sign-in portal: the window-scoped liveview login as the GUI's default sign-in path.
 * The pure lifecycle lives in ui-signin.ts; these deps are the Electron-and-network edges —
 * asking the runner for an engine, holding the `ssh -L` tunnel, and owning the viewer window.
 */
const portal = new SigninPortal({
	requestLiveview: async (host, app, operator) => {
		// Generous: the runner quits/swaps/foregrounds the app before it answers.
		const res = await runSsh(host, runnerArgv("liveview", { app, operator }), { timeoutMs: 60_000 });

		return lastFrame(res.stdout);
	},
	freeLocalPort: async (port) => {
		// lsof names the holders; SIGKILL because a wedged ssh ignores TERM, and this only ever
		// targets processes listening on OUR fixed forward port on loopback.
		await new Promise<void>((resolve) => {
			execFile("/bin/sh", ["-c", `lsof -ti tcp:${port} | xargs kill -9 2>/dev/null; exit 0`], () => resolve());
		});
		// Give the kernel a moment to release the listener before ssh tries to bind it.
		await new Promise((r) => setTimeout(r, 400));
	},
	spawnTunnel: (host, port) => {
		// stdio ignored: the tunnel's only output is noise, and an unread pipe would block it.
		const child = spawnProcess("ssh", tunnelArgv(host, port), { stdio: "ignore" });

		return { kill: () => void child.kill("SIGTERM") };
	},
	portReady: async (port, deadlineMs) => {
		// An HTTP request, not a TCP connect: the forward accepts connections before the remote
		// server exists, so a connect-only probe is not evidence the viewer can load. Any HTTP
		// status counts — 403 without the token still proves a server answered.
		const startedAt = Date.now();
		for (;;) {
			try {
				const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
				void res.body?.cancel();

				return true;
			} catch {
				if (Date.now() - startedAt >= deadlineMs) return false;
				await new Promise((r) => setTimeout(r, 250));
			}
		}
	},
	openViewer: (url, title) => {
		// Embedded in the main window rather than floating: the sign-in was asked for from
		// this window, and a separate one reads as a separate app — the header stays visible
		// above it, which is where the renderer's "cancel sign-in" control lives.
		if (win && !win.isDestroyed()) {
			const owner = win;
			const view = new WebContentsView({
				// The viewer page is ours, but it streams a machine a human is typing a
				// password into — it gets no node access on principle.
				webPreferences: { nodeIntegration: false, contextIsolation: true },
			});
			// Match the shell. A WebContentsView defaults to a WHITE base layer and paints black
			// before its first frame, which is what produced the slab of black around the stream
			// (reported 2026-07-31). The viewer page paints the same colour, so the seam between
			// the two disappears rather than reading as a broken video pane.
			view.setBackgroundColor("#16181d");
			// Measured, not assumed: a hardcoded offset drifted the first time a header control
			// changed its height, leaving the view overlapping the cancel button it depends on.
			let headerPx = 52;
			const layout = (): void => {
				if (owner.isDestroyed()) return;
				const b = owner.getContentBounds();
				view.setBounds({ x: 0, y: headerPx, width: b.width, height: Math.max(0, b.height - headerPx) });
			};
			void owner.webContents
				.executeJavaScript(`(document.querySelector("header") || { offsetHeight: 51 }).offsetHeight`)
				.then((h) => {
					if (typeof h === "number" && h > 0) headerPx = Math.ceil(h) + 1;
					layout();
				})
				.catch(() => undefined);
			owner.contentView.addChildView(view);
			layout();
			owner.on("resize", layout);

			// Belt and braces behind the HTTP readiness probe: if the load still fails (the
			// tunnel dropping mid-handshake, the engine dying at startup), an embedded view has
			// no reload of its own and would sit there as a blank white rectangle — the exact
			// symptom that made this bug hard to read. Retry a few times, then SAY so.
			let attempts = 0;
			const load = (): void => {
				attempts += 1;
				view.webContents.loadURL(url).catch(() => {
					if (attempts <= 5) return void setTimeout(load, 600);
					void view.webContents.loadURL(
						`data:text/html,${encodeURIComponent(
							`<body style="margin:0;background:#16181d;color:#e6e8ec;font:14px ui-sans-serif,system-ui;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center"><div><p>The sign-in view could not reach the Mac.</p><p style="color:#9aa1ad;font-size:12.5px">The tunnel or the capture server went away. Cancel the sign-in and try again.</p></div></body>`,
						)}`,
					);
				});
			};
			load();

			let closedCb: (() => void) | undefined;

			return {
				close: () => {
					owner.removeListener("resize", layout);
					if (!owner.isDestroyed()) owner.contentView.removeChildView(view);
					view.webContents.close();
					closedCb?.();
				},
				onClosed: (cb) => {
					closedCb = cb;
				},
			};
		}

		// No main window to embed in (should not happen — the portal is only reachable from
		// the renderer). A plain window beats refusing the sign-in over a layout concern.
		const view = new BrowserWindow({
			width: 1100,
			height: 800,
			title,
			backgroundColor: "#16181d",
			webPreferences: { nodeIntegration: false, contextIsolation: true },
		});
		void view.loadURL(url);

		return {
			close: () => {
				if (!view.isDestroyed()) view.close();
			},
			onClosed: (cb) => view.once("closed", cb),
		};
	},
	stopEngine: async (host) => {
		// Best-effort by contract: the engine's own idle and lifetime exits are the backstop,
		// this only frees the fixed port immediately so the next sign-in is not refused.
		await runSsh(host, runnerArgv("liveview-stop"), { timeoutMs: 10_000 }).catch(() => undefined);
	},
	onSessionEnd: () => toRenderer("portal", { open: false }),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (t) => clearTimeout(t),
});

let win: BrowserWindow | undefined;

/** Injected before the shared app script; implements the `window.__bus` contract. */
const BOOTSTRAP = String.raw`
const { ipcRenderer } = require('electron');
window.__videoBase = 'agentvideo:///';
window.__bus = {
  loadApps: (host) => ipcRenderer.invoke('apps', host),
  // Reveal a recording in Finder — the mp4 is the deliverable, and the gallery is where
  // people go looking for the file they are about to send.
  reveal: (rel) => ipcRenderer.invoke('reveal', rel),
  loadRuns: () => ipcRenderer.invoke('runs'),
  // Encode per SEGMENT: encodeURIComponent on the whole path turns every "/" into %2F,
  // leaving a standard-scheme URL with no path to route, so the request never reaches the
  // handler at all (symptom: a black video stuck at 0:00 and no protocol log line).
  videoUrl: (rel) => window.__videoBase + rel.split('/').map(encodeURIComponent).join('/'),
  run: (opts) => ipcRenderer.invoke('run', opts),
  ground: (app, host, url) => ipcRenderer.invoke('ground', { app, host, url }),
  // Humanized-cursor render for a gallery card. Fire once, then poll the status map — the
  // render outlives any single IPC round trip and the gallery already repaints on a timer.
  humanize: (stamp) => ipcRenderer.invoke('humanize', stamp),
  humanizeStatus: () => ipcRenderer.invoke('humanize:status'),
  // Stop names the machine whose run should end — with runs live on several hosts at once,
  // a bare stop would have to guess which one the operator meant.
  stop: (host) => ipcRenderer.invoke('stop', host),
  // Fleet. Every one of these answers something on a "no hosts.json" machine rather than
  // throwing, so the local-only shell needs no branch of its own.
  loadHosts: () => ipcRenderer.invoke('hosts'),
  loadFleet: () => ipcRenderer.invoke('fleet'),
  attach: (host, jobId, app) => ipcRenderer.invoke('attach', { host, jobId, app }),
  signin: (host, app) => ipcRenderer.invoke('signin', { host, app }),
  signinWait: (host, app) => ipcRenderer.invoke('signin:wait', { host, app }),
  cancelSignin: () => ipcRenderer.invoke('signin:cancel'),
  // {open, app?, host?}: the embedded sign-in view appeared or went away. Drives the
  // header's cancel control — the view covers the page, so the page cannot own a button in it.
  onPortal: (cb) => ipcRenderer.on('portal', (_e, d) => cb(d)),
  // Fleet-panel overflow actions. All answer {ok, message} for the same transient slot.
  authClear: (host, app) => ipcRenderer.invoke('auth:clear', { host, app }),
  appDelete: (host, app) => ipcRenderer.invoke('app:delete', { host, app }),
  cancelQueued: (host, jobId) => ipcRenderer.invoke('queue:cancel', { host, jobId }),
  appInstall: (host, app, url) => ipcRenderer.invoke('app:install', { host, app, url }),
  loadCreds: () => ipcRenderer.invoke('creds'),
  saveKey: (key) => ipcRenderer.invoke('creds:save', key),
  loadHostPref: () => ipcRenderer.invoke('host:load'),
  saveHostPref: (host) => ipcRenderer.send('host:save', host),
  loadState: () => ipcRenderer.invoke('state:load'),
  // send, not invoke: this is also called from beforeunload, where the renderer will not
  // survive long enough to await a reply. The message is queued before teardown.
  saveState: (s) => ipcRenderer.send('state:save', s),
  onStarted: (cb) => ipcRenderer.on('started', (_e, d) => cb(d)),
  // Lines carry {text, app, host}: with two live runs, bare text cannot say whose terminal
  // it belongs to, and the page would file it under whatever happened to be running first.
  onLine: (cb) => ipcRenderer.on('line', (_e, d) => cb(d)),
  onHost: (cb) => ipcRenderer.on('host', (_e, d) => cb(d)),
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
		// The fleet rows keep their ids, so the next launch can offer to follow them again.
		for (const controller of remotes.values()) controller.detach();
		// The portal is the opposite case: its view lived INSIDE this window, so the session
		// is over — and the teardown is what stops the engine and frees the port over there.
		portal.close();
		win = undefined;
	});
}

/**
 * Kick the humanized-cursor render off the moment a recorded run finishes cleanly. The
 * checkbox rides RunOptions, but the render itself is always local: a remote run's recording
 * is pulled home BEFORE its `done` fires (collect() orders it so), which is exactly when the
 * stamp-named directory exists here. A refused or crashed run has no take worth rendering.
 */
function withHumanize(handlers: RunHandlers, wanted: boolean, stamp: () => string | undefined, app: string, host: string): RunHandlers {
	if (!wanted) return handlers;

	return {
		...handlers,
		onDone: (code, elapsed) => {
			handlers.onDone(code, elapsed);
			const id = stamp();
			if (code !== 0 || !id) return;
			const refused = humanizer.start(id);
			toRenderer("line", {
				text: refused ? `✗ human cursor: ${refused}` : `rendering human cursor — it lands on the gallery card for ${id} when done`,
				app,
				host,
			});
		},
	};
}

// Answers for the SELECTED host, not for this Mac. A colo Mac's list comes from its own runner,
// which enumerates its own /Applications and its own appmaps — see appChoices.
ipcMain.handle("apps", (_event, host?: string) => appChoices(host, listApps));

/**
 * Reveal a recording in Finder. `resolveVideo` is the gate: it rejects anything outside
 * out/recording, so the renderer cannot point Finder at an arbitrary path.
 */
ipcMain.handle("reveal", (_event, rel: unknown) => {
	const full = resolveVideo(String(rel ?? ""));
	if (full) shell.showItemInFolder(full);
});

/** Gallery entries, tagged with the Mac each one was pulled from. Local runs carry no tag. */
ipcMain.handle("runs", () => annotateRuns(listRecordedRuns()));

/**
 * Render a human cursor over a recorded run. NOT gated on alreadyBusy(): no driver session is
 * involved, so a render alongside an agent run is exactly the concurrency the split into its
 * own controller exists to allow. Answers an error string or undefined — never throws across
 * IPC; the controller is written to guarantee that.
 */
ipcMain.handle("humanize", (_event, stamp: unknown) => humanizer.start(String(stamp ?? "")));

ipcMain.handle("humanize:status", () => humanizer.status());

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
 * Deliver to the renderer if there still is one.
 *
 * `win` alone is not the test. Closing the window tears the webContents down before the
 * `closed` event clears `win`, and both shutdown paths emit MORE lines inside that gap: a
 * local child answers SIGINT with its exit output, and a detached remote follow prints its own
 * farewell. `send` on a destroyed webContents throws, and that throw is in the main process —
 * so closing the window mid-run could take the app down instead of the window.
 */
function toRenderer(channel: string, payload: unknown): void {
	if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
	win.webContents.send(channel, payload);
}

/**
 * Event plumbing for ONE run, with its ownership baked in.
 *
 * Every event names {app, host}: two live runs into one window are only readable because each
 * line says whose terminal it belongs to, and the page files them into per-app buffers on that
 * name. A single shared handlers object plus a `dispatched` variable — the old shape — cannot
 * do this, because the second dispatch overwrote the first run's identity.
 *
 * `current` starts as the submitted host and follows `onHost` to the resolved one, so `done`
 * still names the real machine after the controller has let go of the run — that is when the
 * page's unready panel needs somewhere to send a person.
 */
function handlersFor(app: string, submittedHost: string, controller?: RemoteRunController): RunHandlers {
	let current = submittedHost;

	return {
		onLine: (line) => toRenderer("line", { text: line, app, host: current }),
		onHost: (resolved) => {
			if (resolved === current) return;
			// Re-key so busyOn/stop find this run under the name the rest of the UI now uses,
			// and the `auto` slot frees up for the next submit. Identity-checked, and never
			// clobbering: if the resolved slot is somehow taken (a race the far side's lease
			// makes near-impossible), the run stays reachable under its old key and by the
			// attached-host scan in remoteOn().
			if (controller && remotes.get(current) === controller && !remotes.has(resolved)) {
				remotes.delete(current);
				remotes.set(resolved, controller);
			}
			current = resolved;
			toRenderer("host", { app, host: resolved });
		},
		onDone: (code, elapsed) => {
			// By identity across the whole map — the key may have moved under this controller.
			if (controller) for (const [key, c] of remotes) if (c === controller) remotes.delete(key);
			toRenderer("done", { code, elapsed, app, host: current });
		},
	};
}

/** The live controller for a host, under its submitted key or the machine it resolved to. */
function remoteOn(host: string): RemoteRunController | undefined {
	const direct = remotes.get(host);
	if (direct?.busy) return direct;
	for (const c of remotes.values()) if (c.busy && c.attached?.host === host) return c;

	return undefined;
}

/**
 * One run per HOST in this shell — not one per shell.
 *
 * The real constraint is the machine: a second driver session on one Mac shuts down the shared
 * daemon and kills the run already in flight (LIMITATIONS §6). Runs on DIFFERENT Macs do not
 * contend, so a local run and a mac2 run, or runs on two colo Macs, coexist freely. This check
 * only covers what THIS shell has in flight; the far side's job lease enforces the same rule
 * fleet-wide across all operators, and its refusal is the backstop when two shells collide.
 */
function busyOn(host: string): string | undefined {
	if (host === "local") return runs.active ? "a run is already in progress on this Mac" : undefined;
	const c = remoteOn(host);
	if (c) return `already following ${c.attached?.jobId ?? "a remote run"} on ${c.attached?.host ?? host} — stop or detach it first`;

	return undefined;
}

/** `host` rides along with the local RunOptions; `local` (or absent) takes the original path. */
type ShellRunOptions = RunOptions & { host?: string };

ipcMain.handle("run", (_event, opts: ShellRunOptions) => {
	const target = isRemoteHost(opts.host) ? String(opts.host).trim() : "local";
	const busy = busyOn(target);
	if (busy) return busy;

	// The task text is handed to whichever controller runs it and read by neither: the audit
	// lives in agent.ts, on the machine that will execute the run (CLAUDE.md, "Measurement rule").
	let err: string | undefined;
	const wantsHuman = opts.record === true && opts.humanize === true;
	if (target === "local") {
		err = runs.start(opts, withHumanize(handlersFor(opts.app, "local"), wantsHuman, () => runs.lastStamp, opts.app, "local"));
	} else {
		const controller = new RemoteRunController();
		remotes.set(target, controller);
		err = controller.start(
			{ host: target, app: opts.app, task: opts.task, kind: "task", record: opts.record, noVision: opts.noVision, ...(opts.url ? { url: opts.url } : {}) },
			withHumanize(handlersFor(opts.app, target, controller), wantsHuman, () => controller.lastRunJobId, opts.app, target),
		);
		// A synchronous refusal never reaches onDone, so the map entry is ours to take back.
		if (err) remotes.delete(target);
	}
	if (!err) toRenderer("started", { app: opts.app, task: opts.task, host: target });

	return err;
});

ipcMain.handle("ground", (_event, { app, host, url }: { app: string; host?: string; url?: string }) => {
	const target = isRemoteHost(host) ? String(host).trim() : "local";
	const busy = busyOn(target);
	if (busy) return busy;

	let err: string | undefined;
	if (target === "local") {
		err = runs.explore(app, handlersFor(app, "local"), url);
	} else {
		const controller = new RemoteRunController();
		remotes.set(target, controller);
		err = controller.start(
			{ host: target, app, task: "", kind: "explore", record: false, noVision: false, ...(url ? { url } : {}) },
			handlersFor(app, target, controller),
		);
		if (err) remotes.delete(target);
	}
	if (!err) toRenderer("started", { app, task: `grounding pass — exploring ${app}`, host: target });

	return err;
});

/**
 * Re-attach to a run already in flight on a Mac.
 *
 * This is what makes closing the window survivable: the job is a detached child on the far
 * side and its log is a file there, so the only thing a restart ever lost was the id — which
 * the busy fleet row carries. Refused only when THIS shell already follows that host: a run
 * of our own elsewhere is no reason not to watch someone else's.
 */
ipcMain.handle("attach", async (_event, { host, jobId, app }: { host: string; jobId: string; app?: string }) => {
	const busy = busyOn(host);
	if (busy) return busy;

	// The pane the followed lines land in. The host stands in when the fleet row carried no
	// app name — the page keys buffers by this string, and "" would be a terminal with no tab.
	const owner = app || host;
	const controller = new RemoteRunController();
	remotes.set(host, controller);
	const err = controller.attach(host, jobId, handlersFor(owner, host, controller));
	if (err) remotes.delete(host);
	if (!err) toRenderer("started", { app: owner, task: `following ${jobId} on ${host}`, host });

	return err;
});

/**
 * Stop means stop the RUN on the named machine. Detaching without stopping is what a close
 * does. The host must be named because several runs can be live at once, and a stop that
 * guessed would end somebody's forty-minute pass on the wrong Mac.
 */
ipcMain.handle("stop", async (_event, host?: string) => {
	const name = String(host ?? "local");
	if (!isRemoteHost(name)) {
		runs.stop();

		return undefined;
	}
	const c = remoteOn(name);
	if (!c) return `no run on ${name} to stop`;

	return c.stop();
});

ipcMain.handle("hosts", () => hostChoices());

ipcMain.handle("fleet", () => fleetView());

/**
 * Open a screen-sharing session on a colo Mac so a human can clear a sign-in wall.
 *
 * `shell.openExternal` on a `vnc://` URL hands off to Screen Sharing.app, which owns the
 * credential prompt and the keychain entry for it. That is the point: nothing in this process
 * ever sees the operator's password for the machine or their password for the app under test.
 *
 * Not gated on `busyOn()`. Signing in on one Mac while a run follows another is a normal
 * thing to want, and the far side refuses by itself if that Mac in particular is mid-run —
 * which it must, now that the app is brought to the FRONT over there rather than opened behind
 * everything. Only the runner knows whether a recording is in flight, so only the runner decides.
 */
ipcMain.handle("signin", async (_event, { host, app }: { host: string; app?: string }) => {
	const name = String(host ?? "").trim();
	const target = (app ?? "").trim();
	// Portal first, wherever it CAN work: a concrete remote host and a named app — the
	// runner's profile swap and the home watch both need one. Local, `auto` and app-less
	// requests keep the screen-share path, whose own messages already explain those cases.
	if (isRemoteHost(name) && name.toLowerCase() !== "auto" && target) {
		let entry: HostEntry | undefined;
		try {
			entry = resolveHost(name, loadHosts());
		} catch {
			entry = undefined; // an unknown host falls through; beginSignin names it in its refusal
		}
		if (entry) {
			const out = await portal.open(entry, target, defaultOperator());
			if (out.kind === "open") {
				// The renderer shows its cancel control off this event; the matching
				// {open:false} arrives from the portal's onSessionEnd, whatever ends it.
				toRenderer("portal", { open: true, app: target, host: name });

				return { ok: true, message: out.message, watch: out.watch };
			}
			if (out.kind === "refused") return { ok: false, message: out.message };
			// kind === "fallback": the runner could not be asked. Screen sharing is the one
			// path that does not need it, so the request continues there — with the reason
			// carried into the message, because a silently different window is a mystery.
			const view = await beginSignin(name, app);
			if (view.url) await shell.openExternal(view.url);

			return { ...view, message: `${out.reason} — falling back to screen sharing. ${view.message}` };
		}
	}
	const view = await beginSignin(name, app);
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
/**
 * The operator backing out: tear the portal down — window, tunnel, and the engine on the far
 * Mac, so the port is free for the next attempt instead of held by a sign-in nobody finishes.
 */
ipcMain.handle("signin:cancel", () => {
	const was = portal.active;
	portal.close();

	return was ? { ok: true, message: `Cancelled the ${was.app} sign-in on ${was.host}.` } : { ok: true, message: "No sign-in was open." };
});

ipcMain.handle("signin:wait", (_event, { host, app }: { host: string; app: string }) => {
	const h = String(host ?? "");
	const a = String(app ?? "");
	const ours = portal.active;
	// When the sign-in on screen is the portal's window, the thing to put away once the app
	// reaches home is that window, not Screen Sharing — the wait logic itself is shared.
	if (ours && ours.host === h && ours.app === a)
		return completeSignin(h, a, undefined, undefined, async () =>
			portal.closeFor(h, a)
				? { closed: true, detail: "closed the sign-in window" }
				: { closed: true, detail: "the sign-in window was already closed" },
		);

	return completeSignin(h, a);
});

/**
 * Fleet-panel overflow actions. The confirm() dialogs live in the renderer — the destructive
 * verbs must never fire from a single click — and by the time these handlers run, the question
 * has been asked and answered. Each resolves to {ok, message} for the panel's transient slot;
 * `auth:clear` acts for the CURRENT operator, decided on the far side of clearAppAuth by the
 * same defaultOperator() every dispatch uses, so the sign-out hits the same profile a run would.
 */
ipcMain.handle("auth:clear", (_event, { host, app }: { host: string; app?: string }) =>
	clearAuthView(String(host ?? ""), typeof app === "string" ? app : undefined),
);

ipcMain.handle("app:delete", (_event, { host, app }: { host: string; app?: string }) =>
	deleteAppView(String(host ?? ""), typeof app === "string" ? app : undefined),
);

// Cancel a job waiting in a host's queue. Not destructive — the job never started — which is
// why it is the one fleet verb without a confirm() in front of it on the renderer side.
ipcMain.handle("queue:cancel", (_event, { host, jobId }: { host: string; jobId?: string }) =>
	cancelQueuedView(String(host ?? ""), String(jobId ?? "")),
);

// Long-running by design: the download happens on the far Mac and can take minutes. The
// renderer paints its own "installing…" note and lets this reply land whenever it lands —
// the same shape signin:wait already has.
ipcMain.handle("app:install", (_event, { host, app, url }: { host: string; app?: string; url?: string }) =>
	installAppView(String(host ?? ""), typeof app === "string" ? app : undefined, typeof url === "string" ? url : undefined),
);

// Local by nature: the saved credential lives in THIS operator's login keychain, not on the Mac.

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

// The tunnel is a child of this process; a quit that leaves it running leaves a live
// port-forward to a capture-capable server with nothing watching either end.
app.on("before-quit", () => portal.close());

app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
