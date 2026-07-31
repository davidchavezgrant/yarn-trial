import assert from "node:assert/strict";
import { test } from "node:test";
import {
	connectionClosed,
	connectionOpened,
	lifecycleVerdict,
	startLiveViewServer,
	type LifecycleState,
} from "../src/remote/liveview-server.js";

// The detached-server self-termination clock. Pure, so tested with explicit clocks — no sockets,
// no real timers. Guards two failures: a server nobody opens listening forever (max-lifetime), and
// a walked-away sign-in holding a capture engine after the tab closed (idle-after-close).

const base = (over: Partial<LifecycleState> = {}): LifecycleState => ({
	startedAtMs: 1000,
	everConnected: false,
	openConnections: 0,
	...over,
});

test("lifecycleVerdict__Runs__When__NoDeadlinesSet", () => {
	// Local `./run liveview` sets neither deadline: it must run until Ctrl-C regardless of age.
	assert.equal(lifecycleVerdict(base(), 999_999, {}), "run");
});

test("lifecycleVerdict__ExpiresOnMaxLifetime__When__CeilingPassed", () => {
	const s = base({ startedAtMs: 0 });
	assert.equal(lifecycleVerdict(s, 60_000, { maxLifetimeMs: 60_000 }), "max-lifetime");
});

test("lifecycleVerdict__Runs__When__UnderMaxLifetime", () => {
	const s = base({ startedAtMs: 0 });
	assert.equal(lifecycleVerdict(s, 59_999, { maxLifetimeMs: 60_000 }), "run");
});

test("lifecycleVerdict__DoesNotArmIdle__When__NeverConnected", () => {
	// The operator needs time to click the link — idle must NOT fire before the first connection,
	// even long after start.
	const s = base({ everConnected: false, openConnections: 0 });
	assert.equal(lifecycleVerdict(s, 500_000, { idleAfterCloseMs: 10_000 }), "run");
});

test("lifecycleVerdict__Runs__When__ConnectedNow", () => {
	// A live viewer is never idle, however long it has been open.
	const s = base({ everConnected: true, openConnections: 1 });
	assert.equal(lifecycleVerdict(s, 500_000, { idleAfterCloseMs: 10_000 }), "run");
});

test("lifecycleVerdict__ExpiresIdle__When__ClosedLongerThanWindow", () => {
	const s = base({ everConnected: true, openConnections: 0, lastCloseMs: 100_000 });
	assert.equal(lifecycleVerdict(s, 110_000, { idleAfterCloseMs: 10_000 }), "idle");
});

test("lifecycleVerdict__Runs__When__RecentlyClosedWithinWindow", () => {
	// A closed tab that might be reopened: linger briefly.
	const s = base({ everConnected: true, openConnections: 0, lastCloseMs: 100_000 });
	assert.equal(lifecycleVerdict(s, 105_000, { idleAfterCloseMs: 10_000 }), "run");
});

test("lifecycleVerdict__PrefersMaxLifetime__When__BothDeadlinesPassed", () => {
	// max-lifetime is the harder guarantee; report it first.
	const s = base({ startedAtMs: 0, everConnected: true, openConnections: 0, lastCloseMs: 50_000 });
	assert.equal(lifecycleVerdict(s, 200_000, { maxLifetimeMs: 120_000, idleAfterCloseMs: 10_000 }), "max-lifetime");
});

// ---- Connection refcounting: overlapping viewers must not read as idle -------------------
// A browser reconnecting through a tunnel blip (or a second tab) means the OLD socket's close
// arrives while a NEW connection is live; a boolean here once killed the server mid-sign-in.

test("connectionOpened__MarksEverConnected__When__FirstViewerArrives", () => {
	const s = base();
	connectionOpened(s);
	assert.equal(s.everConnected, true);
	assert.equal(s.openConnections, 1);
});

test("connectionClosed__KeepsServerLive__When__OverlappingConnectionRemains", () => {
	const s = base();
	connectionOpened(s);
	connectionOpened(s);
	connectionClosed(s, 100_000);
	assert.equal(s.openConnections, 1);
	assert.equal(s.lastCloseMs, undefined);
	assert.equal(lifecycleVerdict(s, 500_000, { idleAfterCloseMs: 10_000 }), "run");
});

test("connectionClosed__ArmsIdle__When__LastConnectionCloses", () => {
	const s = base();
	connectionOpened(s);
	connectionOpened(s);
	connectionClosed(s, 100_000);
	connectionClosed(s, 200_000);
	assert.equal(s.openConnections, 0);
	assert.equal(s.lastCloseMs, 200_000);
	assert.equal(lifecycleVerdict(s, 210_000, { idleAfterCloseMs: 10_000 }), "idle");
});

test("connectionClosed__ClampsAtZero__When__CloseArrivesWithoutOpen", () => {
	// Defensive: a spurious close must not drive the count negative and mask a later real viewer.
	const s = base();
	connectionClosed(s, 100_000);
	connectionOpened(s);
	assert.equal(s.openConnections, 1);
	assert.equal(lifecycleVerdict(s, 500_000, { idleAfterCloseMs: 10_000 }), "run");
});

// ---- Supplied-token shape check: fail loud, never substitute ------------------------------
// Silently minting a replacement token leaves the caller's URL 403ing while a capture-capable
// server runs out its full lifetime under a token nobody knows.

test("startLiveViewServer__Throws__When__SuppliedTokenTooShort", () => {
	assert.throws(() => void startLiveViewServer({ token: "shorty" }), /invalid supplied token/);
});

test("startLiveViewServer__Throws__When__SuppliedTokenHasBadCharacters", () => {
	assert.throws(() => void startLiveViewServer({ token: "long enough but has spaces!!" }), /invalid supplied token/);
});
