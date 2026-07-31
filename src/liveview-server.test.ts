import assert from "node:assert/strict";
import { test } from "node:test";
import { lifecycleVerdict, type LifecycleState } from "./liveview-server.js";

// The detached-server self-termination clock. Pure, so tested with explicit clocks — no sockets,
// no real timers. Guards two failures: a server nobody opens listening forever (max-lifetime), and
// a walked-away sign-in holding a capture engine after the tab closed (idle-after-close).

const base = (over: Partial<LifecycleState> = {}): LifecycleState => ({
	startedAtMs: 1000,
	everConnected: false,
	connectedNow: false,
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
	const s = base({ everConnected: false, connectedNow: false });
	assert.equal(lifecycleVerdict(s, 500_000, { idleAfterCloseMs: 10_000 }), "run");
});

test("lifecycleVerdict__Runs__When__ConnectedNow", () => {
	// A live viewer is never idle, however long it has been open.
	const s = base({ everConnected: true, connectedNow: true });
	assert.equal(lifecycleVerdict(s, 500_000, { idleAfterCloseMs: 10_000 }), "run");
});

test("lifecycleVerdict__ExpiresIdle__When__ClosedLongerThanWindow", () => {
	const s = base({ everConnected: true, connectedNow: false, lastCloseMs: 100_000 });
	assert.equal(lifecycleVerdict(s, 110_000, { idleAfterCloseMs: 10_000 }), "idle");
});

test("lifecycleVerdict__Runs__When__RecentlyClosedWithinWindow", () => {
	// A closed tab that might be reopened: linger briefly.
	const s = base({ everConnected: true, connectedNow: false, lastCloseMs: 100_000 });
	assert.equal(lifecycleVerdict(s, 105_000, { idleAfterCloseMs: 10_000 }), "run");
});

test("lifecycleVerdict__PrefersMaxLifetime__When__BothDeadlinesPassed", () => {
	// max-lifetime is the harder guarantee; report it first.
	const s = base({ startedAtMs: 0, everConnected: true, connectedNow: false, lastCloseMs: 50_000 });
	assert.equal(lifecycleVerdict(s, 200_000, { maxLifetimeMs: 120_000, idleAfterCloseMs: 10_000 }), "max-lifetime");
});
