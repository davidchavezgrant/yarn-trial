import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostEntry } from "../src/remote/control/hosts.js";
import { SigninPortal, viewerBounds, VIEWER_MAX_H, VIEWER_MAX_W, type PortalDeps } from "../src/ui/ui-signin.js";

/**
 * The sign-in portal's lifecycle, entirely on injected deps: no ssh, no runner, no window.
 * The properties that matter are the teardown ones — every exit path must kill the tunnel,
 * because a leaked `ssh -L` is a live port-forward to a capture-capable server.
 */

function host(name: string): HostEntry {
	return { name, ssh: { host: "10.0.0.1", port: 22, user: "administrator" }, vnc: { host: "10.0.0.1", port: 5900 }, hostKey: "SHA256:x" };
}

const OK_FRAME = { ok: true, port: 7682, token: "tok-abc", maxLifetimeSec: 1200 };

/** A deps double that records everything and lets a test override any edge. */
function deps(overrides: Partial<PortalDeps> = {}) {
	const log: string[] = [];
	const closedCbs: (() => void)[] = [];
	const timers: { fn: () => void; ms: number }[] = [];
	const d: PortalDeps = {
		requestLiveview: async () => {
			log.push("verb");

			return { ...OK_FRAME };
		},
		spawnTunnel: () => {
			log.push("tunnel");

			return { kill: () => void log.push("tunnel-killed") };
		},
		portReady: async () => true,
		openViewer: (url, title) => {
			log.push(`viewer ${url} :: ${title}`);

			return { close: () => void log.push("viewer-closed"), onClosed: (cb) => void closedCbs.push(cb) };
		},
		stopEngine: async (h) => {
			log.push(`engine-stopped ${h.name}`);
		},
		freeLocalPort: async (p) => {
			log.push(`port-freed ${p}`);
		},
		onSessionEnd: () => void log.push("session-end"),
		setTimeout: (fn, ms) => {
			timers.push({ fn, ms });

			return 0 as unknown as NodeJS.Timeout;
		},
		clearTimeout: () => void log.push("timer-cleared"),
		...overrides,
	};

	return { d, log, closedCbs, timers };
}

test("open__OpensViewerThroughTunnel__When__TheRunnerAnswers", async () => {
	const { d, log, timers } = deps();
	const portal = new SigninPortal(d);

	const out = await portal.open(host("mac1"), "Yarn", "davidgrant");

	assert.equal(out.kind, "open");
	if (out.kind !== "open") return;
	assert.deepEqual(out.watch, { host: "mac1", app: "Yarn" });
	assert.deepEqual(log, [
		"verb",
		// The port is cleared before ssh binds it — see open__ClearsTheForwardPort.
		"port-freed 7682",
		"tunnel",
		"viewer http://127.0.0.1:7682/?t=tok-abc :: Sign in — Yarn @ mac1",
	]);
	assert.equal(timers[0].ms, 1_200_000, "the lifetime timer must come from the runner's reply");
	assert.deepEqual(portal.active, { host: "mac1", app: "Yarn" });
});

test("open__FallsBack__When__TheRunnerDoesNotAnswer", async () => {
	// undefined frame and a throwing ssh are the same case: the runner cannot be asked, and
	// screen sharing is the one path that does not need it.
	for (const requestLiveview of [async () => undefined, async () => Promise.reject(new Error("boom"))] as const) {
		const { d, log } = deps({ requestLiveview: requestLiveview as PortalDeps["requestLiveview"] });
		const out = await new SigninPortal(d).open(host("mac2"), "Yarn", "op");
		assert.equal(out.kind, "fallback");
		assert.equal(log.includes("tunnel"), false, "no tunnel may be spawned for a runner that never answered");
	}
});

test("open__RefusesWithoutFallback__When__TheRunnerRefuses", async () => {
	// A lease held or an engine already serving refuses the screen share's foregrounding too,
	// so falling back would only fail slower — the runner's own sentence is the answer.
	const { d } = deps({ requestLiveview: async () => ({ ok: false, error: "aman is running Yarn here (63s)" }) });
	const out = await new SigninPortal(d).open(host("mac1"), "Yarn", "op");

	assert.equal(out.kind, "refused");
	if (out.kind !== "refused") return;
	assert.match(out.message, /aman is running/);
});

test("open__WaitsForTheServer__When__TheTunnelAcceptsBeforeItExists", async () => {
	// The white-screen bug, pinned. `ssh -L` accepts local connections the moment ssh is up —
	// measured against a forward with nothing behind it — so readiness that resolves on the
	// FIRST probe would open the viewer into an ECONNRESET and paint a blank page. The portal
	// must not open the viewer until portReady says the server actually answered.
	const order: string[] = [];
	let settled = false;
	const { d } = deps({
		// The real probe polls until the server ANSWERS and only then resolves true; this fake
		// stands in for that latency. The property under test is the ordering it guarantees.
		portReady: async () => {
			order.push("probe-start");
			await new Promise((r) => setTimeout(r, 20));
			settled = true;
			order.push("probe-ready");

			return true;
		},
		openViewer: () => {
			order.push(settled ? "viewer-after-ready" : "viewer-too-early");

			return { close: () => {}, onClosed: () => {} };
		},
	});
	const out = await new SigninPortal(d).open(host("mac1"), "Yarn", "op");

	assert.equal(out.kind, "open");
	assert.deepEqual(order, ["probe-start", "probe-ready", "viewer-after-ready"]);
});

test("open__KillsTheTunnelAndFallsBack__When__TheLocalEndNeverComesUp", async () => {
	const { d, log } = deps({ portReady: async () => false });
	const out = await new SigninPortal(d).open(host("mac1"), "Yarn", "op");

	assert.equal(out.kind, "fallback");
	// The engine over there gets stopped too — it would otherwise hold its fixed port against
	// the very retry this fallback suggests.
	assert.deepEqual(
		log,
		["verb", "port-freed 7682", "tunnel", "tunnel-killed", "engine-stopped mac1"],
		"a dead tunnel must not leak, and no viewer may open on it",
	);
});

test("close__StopsTheEngineAndSignalsTheEnd__When__TheSessionEnds", async () => {
	// Backing out is the case the stop exists for: without it the engine held the port for up
	// to its 20-minute lifetime and every following sign-in was refused for a dead session.
	const { d, log } = deps();
	const portal = new SigninPortal(d);
	await portal.open(host("mac1"), "Yarn", "op");
	portal.close();
	portal.close(); // idempotent: the second is a no-op, not a second stop

	assert.equal(log.filter((l) => l === "engine-stopped mac1").length, 1);
	assert.equal(log.filter((l) => l === "session-end").length, 1);
	// Backing out releases the forward port too — the next attempt must not inherit a listener
	// that makes ssh refuse the new forward while the port still accepts and resets.
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(log.filter((l) => l === "port-freed 7682").length, 2, "freed once before the spawn, once on teardown");
});

test("open__ClearsTheForwardPort__When__StartingASession", async () => {
	// Always, not only after a failure: a leftover ssh -L from a previous session (or a hand-run
	// one) keeps the fixed port, and ssh then refuses the new forward while the port still
	// accepts and instantly resets — a blank viewer that looks exactly like a working tunnel.
	const { d, log } = deps();
	await new SigninPortal(d).open(host("mac1"), "Yarn", "op");

	assert.ok(log.indexOf("port-freed 7682") < log.indexOf("tunnel"), "the port must be cleared BEFORE ssh binds it");
});

test("open__RefusesTheSecond__When__ASessionIsAlreadyUp", async () => {
	const { d } = deps();
	const portal = new SigninPortal(d);
	await portal.open(host("mac1"), "Yarn", "op");

	const same = await portal.open(host("mac1"), "Yarn", "op");
	const other = await portal.open(host("mac2"), "Notion Calendar", "op");

	assert.equal(same.kind, "refused");
	if (same.kind === "refused") assert.match(same.message, /already open — finish there/);
	assert.equal(other.kind, "refused");
	if (other.kind === "refused") assert.match(other.message, /Yarn on mac1/, "the refusal must name what is in the way");
});

test("close__TearsDownOnce__When__TheViewerClosingReenters", async () => {
	// viewer.close() fires onClosed, which calls close() again — the guard is what keeps the
	// teardown from double-killing and the session usable state from lying.
	const { d, log, closedCbs } = deps({
		openViewer: () => ({
			close: () => {
				log.push("viewer-closed");
				for (const cb of closedCbs) cb();
			},
			onClosed: (cb) => void closedCbs.push(cb),
		}),
	});
	const portal = new SigninPortal(d);
	await portal.open(host("mac1"), "Yarn", "op");
	portal.close();

	assert.deepEqual(log.filter((l) => l === "viewer-closed").length, 1);
	assert.deepEqual(log.filter((l) => l === "tunnel-killed").length, 1);
	assert.equal(portal.active, undefined);
});

test("close__RunsTheFullTeardown__When__TheLifetimeTimerFires", async () => {
	const { d, log, timers } = deps();
	const portal = new SigninPortal(d);
	await portal.open(host("mac1"), "Yarn", "op");

	timers[0].fn();

	assert.equal(log.includes("viewer-closed"), true);
	assert.equal(log.includes("tunnel-killed"), true);
	assert.equal(portal.active, undefined, "a portal outliving its engine is a window on a dead stream");
});

test("closeFor__ClosesOnlyTheNamedSession__When__TargetsDiffer", async () => {
	const { d, log } = deps();
	const portal = new SigninPortal(d);
	await portal.open(host("mac1"), "Yarn", "op");

	assert.equal(portal.closeFor("mac2", "Yarn"), false);
	assert.equal(portal.closeFor("mac1", "Notion Calendar"), false);
	assert.equal(log.includes("tunnel-killed"), false, "a wait for some other sign-in must not kill this one");
	assert.equal(portal.closeFor("mac1", "Yarn"), true);
	assert.equal(log.includes("tunnel-killed"), true);
});

test("open__FallsBack__When__TheReplyLacksPortOrToken", async () => {
	// An old runner that predates the verb's full reply must degrade to the path that works,
	// not open a viewer on garbage.
	for (const frame of [{ ok: true, token: "t" }, { ok: true, port: 7682 }, { ok: true, port: -1, token: "t" }]) {
		const { d } = deps({ requestLiveview: async () => frame });
		const out = await new SigninPortal(d).open(host("mac1"), "Yarn", "op");
		assert.equal(out.kind, "fallback", `${JSON.stringify(frame)} must fall back`);
	}
});

test("viewerBounds__StaysAPanel__When__TheWindowIsLarge", () => {
	// The bug: the viewer was the full width and the whole height below the header, so a cropped
	// 840x402 login card floated in a field several times its size and the shell disappeared
	// behind it ("the live view panel is just too big", 2026-07-31).
	const b = viewerBounds({ width: 2560, height: 1440 }, 52);

	assert.equal(b.width, VIEWER_MAX_W, "capped, not proportional, once the window is roomy");
	assert.equal(b.height, VIEWER_MAX_H);
	// The shell has to remain visible around it, which is the whole point of a panel.
	assert.ok(b.x > 0 && b.width < 2560, "left/right margin");
	assert.ok(b.y > 52 && b.y + b.height < 1440, "top/bottom margin below the header");
});

test("viewerBounds__ShrinksToFit__When__TheWindowIsSmall", () => {
	// A cap alone would overflow a small window; the inset is what keeps it inside one.
	const b = viewerBounds({ width: 900, height: 600 }, 52);

	assert.ok(b.width < 900, "narrower than the window");
	assert.ok(b.y + b.height <= 600, `must not overflow the bottom (got ${b.y + b.height})`);
	assert.ok(b.x >= 0 && b.y >= 52, "never above the header or off the left edge");
});

test("viewerBounds__StaysOnScreen__When__TheWindowIsAbsurdlyShort", () => {
	// Degenerate geometry — a window dragged to nothing, or measured mid-resize — must not
	// produce a negative origin or a negative size. Electron accepts both and draws nonsense.
	for (const h of [0, 40, 52, 53]) {
		const b = viewerBounds({ width: 300, height: h }, 52);
		assert.ok(b.width >= 0 && b.height >= 0, `no negative size at height ${h}`);
		assert.ok(b.x >= 0 && b.y >= 0, `no negative origin at height ${h}`);
	}
});
