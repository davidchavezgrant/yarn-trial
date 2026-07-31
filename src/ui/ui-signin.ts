import type { HostEntry } from "../remote/control/hosts.js";

/**
 * The GUI's sign-in portal: the window-scoped liveview login, owned end to end by the shell.
 *
 * `./run liveview` already does all of this for a terminal — asks the runner to spawn the
 * capture engine (which must descend from the runner, the process holding the TCC grants),
 * then prints an `ssh -L` one-liner and a URL for the operator to run and open by hand. This
 * module is those two manual steps done by the shell: it spawns the tunnel itself through the
 * same pinned-key argv every other fleet connection uses, waits for the local end to answer,
 * and opens the viewer in a window of ours. Nothing here sees a credential; the human types it
 * into the captured window and it lands in the app's own storage on the far Mac, exactly as
 * the screen-share path always worked.
 *
 * Screen sharing remains the FALLBACK, not a peer: the runner is what spawns the engine, so a
 * Mac whose runner is unreachable can only be reached by the full-desktop path. `open()` says
 * which case it hit so the caller can route there.
 *
 * One session at a time, on purpose. A sign-in is a human at a keyboard; two portals means two
 * apps half-signed-in and a tunnel port collision (the engine's port is fixed fleet-wide).
 * The second request is refused with the first one's name rather than queued.
 */

/** What the shell must provide. Everything with a side effect, so tests drive pure logic. */
export interface PortalDeps {
	/**
	 * Ask the runner to swap the profile, foreground the app and spawn the liveview engine.
	 * Resolves to the runner's reply frame, or undefined when nothing parseable came back —
	 * which is the "runner unreachable" case that falls back to screen sharing.
	 */
	requestLiveview(host: HostEntry, app: string, operator: string): Promise<Record<string, unknown> | undefined>;
	/** Spawn `ssh -L port:127.0.0.1:port -N` with the fleet argv. Kill must be idempotent. */
	spawnTunnel(host: HostEntry, port: number): { kill(): void };
	/**
	 * True once the viewer is actually SERVABLE through the tunnel — an HTTP response, not a
	 * TCP connect. Measured 2026-07-31: `ssh -L` accepts local connections the moment ssh is
	 * up, before anything listens on the far side, so a connect-only probe passed against a
	 * dead forward and the viewer loaded into an ECONNRESET — a blank white page, with nothing
	 * to retry it. The probe must speak the protocol the viewer will speak.
	 */
	portReady(port: number, deadlineMs: number): Promise<boolean>;
	/** Open the viewer window. `onClosed` must fire however the window dies, exactly once. */
	openViewer(url: string, title: string): { close(): void; onClosed(cb: () => void): void };
	/**
	 * Ask the runner to end the engine NOW. Fired best-effort on every teardown — without it,
	 * backing out of a sign-in left the engine holding its fixed port for up to its 20-minute
	 * lifetime, and the next attempt was refused for a server nobody wanted any more.
	 */
	stopEngine(host: HostEntry): Promise<void>;
	/** The session is gone, however it ended. The shell uses this to retire its cancel UI. */
	onSessionEnd?(): void;
	setTimeout(fn: () => void, ms: number): NodeJS.Timeout;
	clearTimeout(t: NodeJS.Timeout): void;
}

export type PortalOutcome =
	/** The window is up. `watch` feeds the same signin-wait flow the screen share uses. */
	| { kind: "open"; message: string; watch: { host: string; app: string } }
	/** The runner could not be asked — screen sharing is the only path left. */
	| { kind: "fallback"; reason: string }
	/** The runner (or this portal) said no, and retrying elsewhere would not help. */
	| { kind: "refused"; message: string };

/** How long the local tunnel end gets to come up before the attempt is abandoned. */
const TUNNEL_READY_MS = 10_000;

/** Ceiling when the runner's reply omits its own. Matches the engine's 20-minute lifetime. */
const DEFAULT_LIFETIME_MS = 20 * 60_000;

interface ActiveSession {
	host: string;
	app: string;
	/** The resolved entry, kept so the teardown can reach the runner without a re-lookup. */
	entry: HostEntry;
	tunnel: { kill(): void };
	viewer: { close(): void };
	lifetime: NodeJS.Timeout;
	/** Guards the teardown: every exit path funnels through close() exactly once. */
	closed: boolean;
}

export class SigninPortal {
	private readonly deps: PortalDeps;
	private session: ActiveSession | undefined;

	constructor(deps: PortalDeps) {
		this.deps = deps;
	}

	/** The sign-in currently on screen, for callers deciding whether a wait belongs to us. */
	get active(): { host: string; app: string } | undefined {
		return this.session ? { host: this.session.host, app: this.session.app } : undefined;
	}

	async open(host: HostEntry, app: string, operator: string): Promise<PortalOutcome> {
		if (this.session) {
			const s = this.session;
			// Same target twice is the double-click/second-refusal case — the window they need
			// is already up, so the message says where to look rather than opening another.
			return {
				kind: "refused",
				message:
					s.host === host.name && s.app === app
						? `The sign-in window for ${app} on ${host.name} is already open — finish there, or close it to start over.`
						: `A sign-in window is already open for ${s.app} on ${s.host} — finish or close that one first.`,
			};
		}

		let frame: Record<string, unknown> | undefined;
		try {
			frame = await this.deps.requestLiveview(host, app, operator);
		} catch (e) {
			frame = undefined;
			// Fall through: an ssh that threw and an ssh that answered nothing are the same
			// case — the runner cannot be asked, and screen sharing does not need the runner.
			void e;
		}
		if (!frame) return { kind: "fallback", reason: `the runner on ${host.name} did not answer` };

		if (frame.ok !== true) {
			// The runner's own refusals are final for THIS path: a run mid-recording or an
			// engine already serving will refuse the screen share's foregrounding too, so
			// falling back would just fail slower. The error names the holder.
			return { kind: "refused", message: String(frame.error ?? `the runner on ${host.name} refused the sign-in`) };
		}

		const port = Number(frame.port);
		const token = String(frame.token ?? "");
		if (!Number.isFinite(port) || port <= 0 || !token)
			return { kind: "fallback", reason: `the runner on ${host.name} answered without a port or token` };

		const tunnel = this.deps.spawnTunnel(host, port);
		if (!(await this.deps.portReady(port, TUNNEL_READY_MS))) {
			tunnel.kill();
			// The engine is up over there with nobody coming — stop it, or it holds the port
			// against the retry this fallback is about to suggest.
			void this.deps.stopEngine(host).catch(() => undefined);

			return { kind: "fallback", reason: `the tunnel to ${host.name} did not come up` };
		}

		const lifetimeMs = Number.isFinite(Number(frame.maxLifetimeSec)) && Number(frame.maxLifetimeSec) > 0
			? Number(frame.maxLifetimeSec) * 1000
			: DEFAULT_LIFETIME_MS;
		const viewer = this.deps.openViewer(`http://127.0.0.1:${port}/?t=${token}`, `Sign in — ${app} @ ${host.name}`);
		const session: ActiveSession = {
			host: host.name,
			app,
			entry: host,
			tunnel,
			viewer,
			// The engine self-terminates at its lifetime; a viewer of a dead stream plus a
			// tunnel to a closed port should not outlive it waiting for a click.
			lifetime: this.deps.setTimeout(() => this.close(), lifetimeMs),
			closed: false,
		};
		this.session = session;
		// However the window dies — the operator closing it, the lifetime closing it, a
		// crash — the tunnel goes with it. The engine's own idle-after-close exit handles
		// the far side.
		viewer.onClosed(() => this.close());

		return {
			kind: "open",
			message: `Opened a sign-in window for ${app} on ${host.name} — sign in there. It closes itself once ${app} reaches its home screen.`,
			watch: { host: host.name, app },
		};
	}

	/** Tear the session down. Safe to call from any path, any number of times. */
	close(): void {
		const s = this.session;
		if (!s || s.closed) return;
		s.closed = true;
		this.session = undefined;
		this.deps.clearTimeout(s.lifetime);
		// Viewer first: closing the window re-enters here via onClosed, which the `closed`
		// flag above has already made a no-op.
		s.viewer.close();
		s.tunnel.kill();
		// Best-effort and unawaited: the engine's own idle/lifetime exits are the backstop,
		// this just frees the port NOW so the next sign-in is not refused for a dead session.
		void this.deps.stopEngine(s.entry).catch(() => undefined);
		this.deps.onSessionEnd?.();
	}

	/** Close only if the session is the one named — a wait for an older sign-in must not kill a newer one. */
	closeFor(host: string, app: string): boolean {
		if (!this.session || this.session.host !== host || this.session.app !== app) return false;
		this.close();

		return true;
	}
}
