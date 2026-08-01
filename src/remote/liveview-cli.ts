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
import { cdpEndpoint, connectCdpEngine, endpointAnswers, localBrowserCdpEndpoint } from "./liveview-cdp.js";
import { startLiveViewServer, type ServerOptions } from "./liveview-server.js";

const USAGE = `usage: ./run liveview [<mac>] ["<App Name>"] [--cdp [url] | --sck] [--lan] [--fps N]

  (no args)      capture this Mac's frontmost window; open the viewer URL locally
  <mac>          a host from hosts.json — prints the ssh -L tunnel to reach its viewer
  "<App Name>"   with a mac: bring this app to the front there first (reuses signin's launch)
  --cdp [url]    force the CDP screencast transport (Page.startScreencast against a Chromium
                 target already up with --remote-debugging-port). The optional url names the
                 debug endpoint — it must start with http(s):// or it reads as the <mac>
                 positional; bare, CDP_PORT/9222 applies. Unreachable is an error with a
                 remedy, never a silent fallback.
  --sck          force the window-capture (ScreenCaptureKit) transport
  --lan          bind beyond loopback for a quick same-network demo (a raw login stream — avoid)
  --fps N        capture frame rate (SCK engine only; the engine's own default is 30)

  The transport defaults to AUTO: the CDP debug endpoint is probed once at start — answers,
  and the session streams over Page.startScreencast; silent, and the SCK window engine runs
  instead (one log line says which and why). LIVEVIEW_TRANSPORT=auto|cdp|sck picks by env
  with the same semantics; a flag beats the env, which beats the auto default.
  LIVEVIEW_CDP_URL names the endpoint (the --cdp url beats it). Works locally and on the
  fleet: with a <mac>, the choice rides the spec to that host's runner and an endpoint means
  a port on THAT Mac.

  The CDP engine follows the sign-in flow through target space: a page opened mid-flow (an
  in-app OAuth popup, a new tab) streams the moment it appears, and closing it pops the view
  back. The external-browser handoff is followed onto the persistent-profile Chrome WHEN its
  debug endpoint answers (LIVEVIEW_BROWSER_CDP_URL, default CDP_PORT/9777) — that requires
  the Mac's default browser to be the debug-flagged Chrome; provisioning for that lands
  separately. Native dialogs and passkey sheets remain SCK territory — force --sck for those.

Window-scoped sign-in: the teammate sees ONLY the window being signed into, drives it in their
own browser, and closes the tab. The session lands in the app's own storage; nothing is stored
here and no credential is ever given to the agent.`;

export type LiveviewTransport = "auto" | "cdp" | "sck";

export interface LiveviewArgs {
	help: boolean;
	lan: boolean;
	fps?: number;
	mac?: string;
	app?: string;
	transport: LiveviewTransport;
	/** CDP debug endpoint, when one was named — the --cdp value beats LIVEVIEW_CDP_URL. */
	endpoint?: string;
	/** A refusal (conflicting flags, a value outside the vocabulary). Nothing else is meaningful. */
	error?: string;
}

/** A --cdp value is consumed only when it READS as an endpoint, so `--cdp mac1` keeps mac1
 *  as the host positional — the flag's value is optional and a hostname is not a URL. */
const ENDPOINT_RE = /^(https?|wss?):\/\//;

/**
 * The whole command line as data, so the transport selection is testable without a process.
 * Pure: argv and env come in as arguments, precedence is flag > env > auto, and an unusable
 * combination comes back as `error` rather than half-applied defaults.
 */
export function parseLiveviewArgs(argv: string[], env: Record<string, string | undefined>): LiveviewArgs {
	const positional: string[] = [];
	let help = false;
	let lan = false;
	let fps: number | undefined;
	let cdp = false;
	let sck = false;
	let flagEndpoint: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--help" || a === "-h") help = true;
		else if (a === "--lan") lan = true;
		else if (a === "--fps") {
			const v = argv[i + 1];
			if (v !== undefined && !v.startsWith("--")) {
				fps = Number(v);
				i++;
			}
		} else if (a === "--sck") sck = true;
		else if (a === "--cdp") {
			cdp = true;
			const v = argv[i + 1];
			if (v !== undefined && ENDPOINT_RE.test(v)) {
				flagEndpoint = v;
				i++;
			}
		} else if (a.startsWith("--cdp=")) {
			cdp = true;
			flagEndpoint = a.slice("--cdp=".length);
		} else if (a.startsWith("--")) {
			// Unknown flags were always ignored here; stay that way rather than growing a strict
			// mode in a bugfix-shaped change.
		} else positional.push(a);
	}

	const [mac, app] = positional;
	const base: LiveviewArgs = { help, lan, fps, mac, app, transport: "auto" };
	if (cdp && sck) return { ...base, error: "--cdp and --sck are mutually exclusive — pick one transport" };

	const endpoint = flagEndpoint?.trim() || env.LIVEVIEW_CDP_URL?.trim() || undefined;
	if (cdp) return { ...base, transport: "cdp", endpoint };
	if (sck) return { ...base, transport: "sck", endpoint };

	const fromEnv = (env.LIVEVIEW_TRANSPORT ?? "").trim();
	if (fromEnv && fromEnv !== "auto" && fromEnv !== "cdp" && fromEnv !== "sck")
		return { ...base, error: `unknown LIVEVIEW_TRANSPORT ${JSON.stringify(fromEnv)} — expected auto, cdp or sck` };

	return { ...base, transport: (fromEnv || "auto") as LiveviewTransport, endpoint };
}

/**
 * Turn the requested transport into the engine that will actually run. Forced choices never
 * probe — a forced --cdp against a dead endpoint must surface the cdp-unreachable remedy, not
 * quietly become window capture. Only AUTO asks the endpoint, once, and falls back silently;
 * `why` is the one log line owed to the operator, because which engine runs changes what the
 * teammate sees (page-scoped stream vs followed window).
 */
export async function resolveTransport(
	transport: LiveviewTransport,
	endpoint: string,
	probe: (endpoint: string) => Promise<boolean>,
): Promise<{ engine: "cdp" | "sck"; why: string }> {
	switch (transport) {
		case "cdp":
			return { engine: "cdp", why: `cdp screencast (forced) against ${endpoint}` };
		case "sck":
			return { engine: "sck", why: "sck window capture (forced)" };
		case "auto":
			return (await probe(endpoint))
				? { engine: "cdp", why: `cdp screencast — ${endpoint} answered the auto-probe` }
				: { engine: "sck", why: `sck window capture — nothing answered at ${endpoint}` };
	}
}

async function main(): Promise<void> {
	const args = parseLiveviewArgs(process.argv.slice(2), process.env);
	if (args.error) {
		console.error(args.error);
		process.exit(2);
	}
	if (args.help) {
		console.log(USAGE);

		return;
	}
	const { mac, app, lan, fps, transport, endpoint } = args;

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
		// The transport rides the spec only when this side chose one: absent, the host's own
		// runner.env (or the CLI's auto-probe there) decides. An endpoint names a port on the
		// REMOTE Mac — the server runs where the window is.
		const spec = {
			app,
			...(operator ? { operator } : {}),
			...(transport !== "auto" ? { transport } : {}),
			...(endpoint ? { endpoint } : {}),
		};
		const res = await runSsh(host, runnerArgv("liveview", spec), { timeoutMs: 60_000 });
		const frame = lastFrame(res.stdout);
		if (!frame?.ok) {
			// A refusal is the runner's answer (busy, swap failed, no grant): report it, do not retry.
			console.error(`could not start liveview on ${host.name}: ${frame?.error ?? (res.stderr.trim() || `runnerctl exited ${res.code}`)}`);
			process.exit(1);
		}
		const port = Number(frame.port);
		// The reply reports the transport as REQUESTED — resolution happens inside the spawned
		// CLI on that Mac (auto probes there), and its log records which engine actually ran.
		const t = String(frame.transport ?? "auto");
		const tDesc =
			t === "cdp" ? `cdp screencast (forced)${frame.endpoint ? ` against ${frame.endpoint}` : ""}`
			: t === "sck" ? "sck window capture (forced)"
			: `auto — cdp screencast if ${frame.app}'s debug endpoint answers on that Mac, else sck window capture (its server log records which)`;
		console.log(`liveview started on ${host.name} for ${frame.app} (${frame.profile ?? "profile unchanged"}).`);
		console.log(`transport: ${tDesc}`);
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
	// Transport: auto probes the CDP endpoint once and streams over Page.startScreencast when it
	// answers, else the SCK window engine — forced choices skip the probe (a dead endpoint under
	// --cdp must show the cdp-unreachable remedy, never fall back). The fleet runs THIS same
	// selection: the runner spawns this CLI with LIVEVIEW_TRANSPORT/LIVEVIEW_CDP_URL when the
	// operator forced a choice, and leaves them unset for auto.
	const probeTarget = cdpEndpoint(endpoint);
	const resolved = await resolveTransport(transport, probeTarget, endpointAnswers);
	console.log(`transport: ${resolved.why}`);
	// The browser leg is explicit now: THIS process runs on the Mac whose flagged Chrome the
	// OAuth handoff lands in (runner-spawned there in fleet mode, or run by hand at the
	// machine), so the local loopback endpoint is correct HERE — and since the engine no
	// longer assumes any default (browserCdpEndpoint's comment has the why), the one caller
	// that wants it has to say so.
	const engine: ServerOptions["engine"] | undefined =
		resolved.engine === "cdp"
			? () => connectCdpEngine({ endpoint: probeTarget, browserEndpoint: localBrowserCdpEndpoint(), app: targetApp })
			: undefined;
	const srv = await startLiveViewServer({ lan, fps, port, token, maxLifetimeMs, idleAfterCloseMs, app: targetApp, engine });
	// An env-supplied token means runner mode, where stdout lands in a persistent job log
	// (out/jobs/.../log.txt) readable locally and via the runner's `logs` verb — printing the
	// full URL would park a live capture+inject credential there for its whole lifetime. The
	// runner already returned the real token to the caller over the socket. Only a token minted
	// in-process (interactive local mode, stdout is a human's terminal) is safe to show.
	const shownUrl = token ? srv.url.replace(`t=${token}`, "t=<redacted>") : srv.url;
	console.log(`\nviewer ready — open this in your browser:\n\n  ${shownUrl}\n`);
	console.log(
		resolved.engine === "cdp"
			? "it shows the page on the debug endpoint and follows the flow across popups. sign in, close the tab when done."
			: "it shows the frontmost window on this Mac. click it, sign in, close the tab when done.",
	);
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
