import assert from "node:assert/strict";
import { test } from "node:test";
import { onInterrupt, runKey } from "../src/core/harness.js";

test("onInterrupt__CancelsTheGraceBackstop__When__TheCheckerAcknowledgesTheSignal", async () => {
	// The backstop exists for a signal nothing polls. Once the loop has READ the flag it owns
	// cleanup — which legitimately outlives the grace window (ffmpeg assembly alone can) — so
	// the timer must stand down, or it force-kills the run mid-cleanup and destroys the run
	// log the function exists to preserve.
	const beforeInt = process.listeners("SIGINT");
	const beforeTerm = process.listeners("SIGTERM");
	let closed = 0;
	const log = console.log; // the handler prints banners; keep the child-IPC channel quiet
	console.log = () => {};
	try {
		const check = onInterrupt(async () => {
			closed++;
			// Never resolves: even a regression cannot reach the process.exit in the timer's
			// .finally and kill the test runner — the count above is the failure signal.
			await new Promise<void>(() => {});
		}, 30);
		const added = process.listeners("SIGINT").filter((l) => !beforeInt.includes(l));
		assert.equal(added.length, 1);
		(added[0] as () => void)(); // the signal arrives; the backstop is armed
		assert.equal(check(), true); // the loop reads the flag — cleanup is its responsibility now
		await new Promise((r) => setTimeout(r, 120)); // well past graceMs
		assert.equal(closed, 0, "the backstop fired despite the acknowledgement");
	} finally {
		console.log = log;
		for (const l of process.listeners("SIGINT")) if (!beforeInt.includes(l)) process.removeListener("SIGINT", l);
		for (const l of process.listeners("SIGTERM")) if (!beforeTerm.includes(l)) process.removeListener("SIGTERM", l);
	}
});

function withRunStamp(value: string | undefined, fn: () => void): void {
	const prev = process.env.RUN_STAMP;
	if (value === undefined) delete process.env.RUN_STAMP;
	else process.env.RUN_STAMP = value;
	try {
		fn();
	} finally {
		if (prev === undefined) delete process.env.RUN_STAMP;
		else process.env.RUN_STAMP = prev;
	}
}

test("runKey__MintsTimestampedSlug__When__NoStampIsSupplied", () => {
	withRunStamp(undefined, () => {
		// out/runs/<key>.json is read by name elsewhere, so the format is a compatibility
		// surface — but it carries MILLISECONDS now: two runs started in the same second (a
		// runner dispatching several jobs) otherwise mint one key and clobber each other.
		assert.match(runKey("", "Notion Calendar"), /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}(-\d+)?-notion-calendar$/);
		assert.match(runKey("explore-", "Yarn"), /^explore-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}(-\d+)?-yarn$/);
	});
});

test("runKey__UsesTheSuppliedStamp__When__RunStampIsSet", () => {
	// A dispatcher pre-commits to the key so it knows which artifacts its child will write,
	// rather than guessing at "newest file in out/runs" after the fact.
	withRunStamp("2026-07-30T09-00-00-yarn", () => {
		assert.equal(runKey("", "Yarn"), "2026-07-30T09-00-00-yarn");
		// The prefix is the caller's convention, not part of the contract: an explicit key
		// wins whole, or the two sides could disagree about where the artifacts landed.
		assert.equal(runKey("explore-", "Yarn"), "2026-07-30T09-00-00-yarn");
	});
});

test("runKey__MintsFreshKey__When__RunStampIsBlank", () => {
	// launchd and `ssh host env RUN_STAMP=` both hand down empty strings for unset vars.
	withRunStamp("   ", () => {
		assert.match(runKey("", "Yarn"), /-yarn$/);
		assert.notEqual(runKey("", "Yarn"), "   ");
	});
});
