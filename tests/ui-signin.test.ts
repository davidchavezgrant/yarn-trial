import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostEntry } from "../src/fleet/remote/hosts.js";
import { SigninPortal, type PortalDeps } from "../src/ui/ui-signin.js";

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
	assert.deepEqual(log, ["verb", "tunnel", "viewer http://127.0.0.1:7682/?t=tok-abc :: Sign in — Yarn @ mac1"]);
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

test("open__KillsTheTunnelAndFallsBack__When__TheLocalEndNeverComesUp", async () => {
	const { d, log } = deps({ portReady: async () => false });
	const out = await new SigninPortal(d).open(host("mac1"), "Yarn", "op");

	assert.equal(out.kind, "fallback");
	// The engine over there gets stopped too — it would otherwise hold its fixed port against
	// the very retry this fallback suggests.
	assert.deepEqual(log, ["verb", "tunnel", "tunnel-killed", "engine-stopped mac1"], "a dead tunnel must not leak, and no viewer may open on it");
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
