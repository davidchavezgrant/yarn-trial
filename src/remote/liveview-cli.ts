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
import { loadHosts, resolveHost } from "./control/hosts.js";
import { lastFrame, runnerArgv, runSsh } from "./control/ssh.js";
import { loginBlockedByRun } from "./liveview.js";
import { connectCdpEngine } from "./liveview-cdp.js";
import { startLiveViewServer, type ServerOptions } from "./liveview-server.js";

const USAGE = `usage: ./run liveview [<mac>] ["<App Name>"] [--lan] [--fps N]

  (no args)      capture this Mac's frontmost window; open the viewer URL locally
  <mac>          a host from hosts.json — prints the ssh -L tunnel to reach its viewer
  "<App Name>"   with a mac: bring this app to the front there first (reuses signin's launch)
  --lan          bind beyond loopback for a quick same-network demo (a raw login stream — avoid)
  --fps N        capture frame rate (default 15; SCK engine only)

  LIVEVIEW_TRANSPORT=cdp   stream a Chromium target over Page.startScreencast instead of
                           window capture (LIVEVIEW_CDP_URL names the debug endpoint;
                           unset, CDP_PORT/9222 applies). Local mode only.

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

	// Fleet mode: ask the host's RUNNER to start the liveview server. It must be the runner, not a
	// bare SSH shell — measured on mac1 (2026-07-30), an ssh-spawned engine is denied screen capture
	// because macOS attributes the grant to the responsible process, and the runner (Electron) is
	// the one that holds it. The verb foregrounds the app under the operator's profile and returns a
	// port + token; we print the `ssh -L` tunnel that maps that port to localhost and the URL to open.
	if (mac) {
		const host = resolveHost(mac, loadHosts());
		if (!app) {
			console.error("fleet mode needs an app name: ./run liveview <mac> \"<App Name>\"");
			process.exit(2);
		}
		const operator = process.env.YARN_OPERATOR || undefined;
		const res = await runSsh(host, runnerArgv("liveview", { app, ...(operator ? { operator } : {}) }), { timeoutMs: 60_000 });
		const frame = lastFrame(res.stdout);
		if (!frame?.ok) {
			// A refusal is the runner's answer (busy, swap failed, no grant): report it, do not retry.
			console.error(`could not start liveview on ${host.name}: ${frame?.error ?? (res.stderr.trim() || `runnerctl exited ${res.code}`)}`);
			process.exit(1);
		}
		const port = Number(frame.port);
		console.log(`liveview started on ${host.name} for ${frame.app} (${frame.profile ?? "profile unchanged"}).`);
		console.log(`\nOpen the tunnel, then the URL:\n`);
		console.log(`  ssh -L ${port}:127.0.0.1:${port} ${host.ssh.user}@${host.vnc.host} -N &`);
		console.log(`  open 'http://127.0.0.1:${port}/?t=${frame.token}'\n`);
		console.log(`You'll see only ${frame.app}'s window. Sign in, then close the tab — the server exits on its own`);
		console.log(`(idle after you close it, or ${Math.round(Number(frame.maxLifetimeSec) / 60)} min max).`);

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
	// The runner spawns this detached and passes a pinned token + lifetime deadlines by env, so it
	// can hand out a complete URL and so a walked-away sign-in cannot leave a capture server
	// listening forever. Absent (a human running it by hand) the server mints its own token and
	// runs until Ctrl-C.
	const port = process.env.PORT ? Number(process.env.PORT) : undefined;
	const token = process.env.LIVEVIEW_TOKEN || undefined;
	const maxLifetimeMs = process.env.LIVEVIEW_MAX_LIFETIME_MS ? Number(process.env.LIVEVIEW_MAX_LIFETIME_MS) : undefined;
	const idleAfterCloseMs = process.env.LIVEVIEW_IDLE_AFTER_CLOSE_MS ? Number(process.env.LIVEVIEW_IDLE_AFTER_CLOSE_MS) : undefined;
	// The runner names the sign-in target so the engine can crop/guard the browser leg; a local
	// second positional does the same for a human running this by hand.
	const targetApp = process.env.LIVEVIEW_APP || app || undefined;
	// LIVEVIEW_TRANSPORT=cdp streams the target over Page.startScreencast instead of SCK —
	// for Chromium targets already up with --remote-debugging-port (LIVEVIEW_CDP_URL points
	// at the endpoint; unset, the CDP_PORT default applies). Local/env selection only for
	// now; the runner verb stays on SCK until the fleet wiring lands.
	const engine: ServerOptions["engine"] | undefined =
		process.env.LIVEVIEW_TRANSPORT === "cdp"
			? () => connectCdpEngine({ endpoint: process.env.LIVEVIEW_CDP_URL, app: targetApp })
			: undefined;
	const srv = await startLiveViewServer({ lan, fps, port, token, maxLifetimeMs, idleAfterCloseMs, app: targetApp, engine });
	// An env-supplied token means runner mode, where stdout lands in a persistent job log
	// (out/jobs/.../log.txt) readable locally and via the runner's `logs` verb — printing the
	// full URL would park a live capture+inject credential there for its whole lifetime. The
	// runner already returned the real token to the caller over the socket. Only a token minted
	// in-process (interactive local mode, stdout is a human's terminal) is safe to show.
	const shownUrl = token ? srv.url.replace(`t=${token}`, "t=<redacted>") : srv.url;
	console.log(`\nviewer ready — open this in your browser:\n\n  ${shownUrl}\n`);
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
