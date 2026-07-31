// liveview-cli — `./run liveview` entry point.
//
// Two modes, mirroring how signin.ts relates to the fleet:
//
//   ./run liveview                 start the viewer server HERE, capturing THIS Mac's frontmost
//                                  window. For local dev and for a Mac you are sitting at.
//   ./run liveview <mac> ["App"]   start the viewer for a FLEET Mac. Because the engine must run
//                                  where the window is (capture and input are local to the OS),
//                                  this prints the `ssh -L` one-liner that tunnels the remote
//                                  viewer to a localhost URL — the stream never crosses the
//                                  network unencrypted, exactly as the runner's UDS leans on SSH.
//                                  Optionally foregrounds "App" first, reusing signin.ts's launch.
//
// This is the window-scoped counterpart to `./run signin`. signin.ts opens full-desktop Screen
// Sharing; this shows only the window being signed into. Neither stores a credential or shows it
// to a model — a human drives, the session lands in the app's own storage.

import { pathToFileURL } from "node:url";
import { planSignin } from "./remote/signin.js";
import { loadHosts, resolveHost } from "./remote/hosts.js";
import { loginBlockedByRun } from "./liveview.js";
import { startLiveViewServer } from "./liveview-server.js";

const USAGE = `usage: ./run liveview [<mac>] ["<App Name>"] [--lan] [--fps N]

  (no args)      capture this Mac's frontmost window; open the viewer URL locally
  <mac>          a host from hosts.json — prints the ssh -L tunnel to reach its viewer
  "<App Name>"   with a mac: bring this app to the front there first (reuses signin's launch)
  --lan          bind beyond loopback for a quick same-network demo (a raw login stream — avoid)
  --fps N        capture frame rate (default 15)

Window-scoped sign-in: the teammate sees ONLY the window being signed into, drives it in their
own browser, and closes the tab. The session lands in the app's own storage; nothing is stored
here and no credential is ever given to the agent.`;

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(USAGE);

		return;
	}
	const positional = argv.filter((a) => !a.startsWith("--"));
	const lan = argv.includes("--lan");
	const fpsArg = argv[argv.indexOf("--fps") + 1];
	const fps = argv.includes("--fps") && fpsArg ? Number(fpsArg) : undefined;

	const [mac, app] = positional;

	// Fleet mode: we cannot capture a remote window from here — the engine runs where the window
	// is. So resolve the host, optionally foreground the app, and print the tunnel + remote cmd.
	//
	// MEASURED CONSTRAINT (mac1, 2026-07-30): a liveview engine spawned from a bare SSH shell hits
	// `no-screen-recording` — "The user declined TCCs for … capture". This is not a missing grant
	// to add; it is the same rule the whole runner design turns on (provision.ts): macOS attributes
	// Screen Recording and Accessibility to the RESPONSIBLE process, and an ssh-spawned child is not
	// it. The recording capture already works only because the RUNNER (the Electron process,
	// com.yarn.runner) spawns it and TCC attributes to that. So the engine must likewise be launched
	// BY the runner, via a serve.ts verb (not yet built — see the design doc's next steps). CGEvent
	// injection has the same requirement (Accessibility). The tunnel command below is therefore the
	// TRANSPORT half only; the engine-launch half has to move under the runner before capture works
	// on the fleet. Printed with that caveat rather than as a working recipe.
	if (mac) {
		const host = resolveHost(mac, loadHosts());
		if (app) {
			const plan = await planSignin(host, app);
			if (plan.launch)
				console.log(`${plan.launch.ok ? "" : "COULD NOT OPEN "}${plan.launch.app} on ${host.name} — ${plan.launch.detail}`);
		}
		const port = 7682; // fixed so the printed tunnel and the remote server agree
		console.log(`
Window-scoped sign-in for ${host.name}${app ? ` (${app})` : ""}.

The engine has to run on ${host.name} (capture + input are local to that Mac), and — measured on
the fleet — it must be spawned by the RUNNER, not a bare SSH shell, or macOS denies screen capture
(TCC attributes to the responsible process). That runner verb is not built yet; until it is, this
prints the transport half so the flow is ready to complete:

  ssh -L ${port}:127.0.0.1:${port} ${host.ssh.user}@${host.vnc.host} \\
    'cd ~/yarn-trial && PORT=${port} ./run liveview --fps ${fps ?? 15}'   # capture works only once the runner launches the engine

Then open the http://127.0.0.1:${port}/?t=… URL it prints, here in your browser. The stream stays
inside the SSH tunnel; close the tab when the app reaches its home screen.`);

		return;
	}

	// Local mode: run the server here. This is where capture actually happens, so this is where
	// the run-in-flight guard belongs — refuse to bring up a login stream while a demo recording
	// holds this Mac, or the two capture sessions collide (and a password could land in the take).
	const blocked = loginBlockedByRun();
	if (blocked) {
		console.error(blocked);
		process.exit(1);
	}
	const port = process.env.PORT ? Number(process.env.PORT) : undefined;
	const srv = await startLiveViewServer({ lan, fps, port });
	console.log(`\nviewer ready — open this in your browser:\n\n  ${srv.url}\n`);
	console.log("it shows the frontmost window on this Mac. click it, sign in, close the tab when done.");
	console.log("(Ctrl-C to stop the server.)");

	const stop = async () => {
		await srv.close();
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	main().catch((err) => {
		console.error(`liveview failed: ${err}`);
		process.exit(1);
	});
