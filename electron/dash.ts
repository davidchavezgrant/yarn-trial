import { app, BrowserWindow } from "electron";
import { parseDashArgs, startDash } from "../src/bench/dash.js";

/**
 * Electron shell for the bench dashboard — a window over the same HTTP+SSE server
 * `./run dash --web` runs headless. The server stays HTTP rather than moving to IPC on
 * purpose: the page needs no Electron API, stays viewable from a plain browser (a second
 * operator, a colo box), and the shell reduces to "start the server, open a window on it".
 *
 * A taken port is treated as "a dash is already serving" rather than an error: launching
 * the shell while a headless dash runs attaches the window to it instead of dying — the
 * dashboard is a READER, and two readers over one manifest would double the fleet polling
 * and collect traffic for nothing.
 */

const opts = parseDashArgs(process.argv.slice(2));

app.whenReady().then(async () => {
	try {
		await startDash(opts);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
		console.log(`bench dash: port ${opts.port} already serving — attaching the window to it`);
	}

	const win = new BrowserWindow({
		width: 1440,
		height: 1000,
		title: "bench dash",
		// The page is dark-only; a white flash on load is the one thing this line prevents.
		backgroundColor: "#0d0d0d",
		webPreferences: { contextIsolation: true, nodeIntegration: false },
	});
	win.removeMenu?.();
	void win.loadURL(`http://127.0.0.1:${opts.port}/`);
});

app.on("window-all-closed", () => app.quit());
