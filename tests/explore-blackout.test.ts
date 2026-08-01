import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { provenanceHeader, writeArtifacts } from "../src/core/explore/artifacts.js";
import { blindAction, newPass } from "../src/core/explore/state.js";

/**
 * The blackout ladder and its accounting.
 *
 * Context, because these tests look fussy without it: on 2026-08-01 two exploration passes died
 * on the identical three actions — click Yarn's record control, Escape, cmd+W. The control opens
 * a native recording helper and the AX tree goes dark for good. The harness had a concede exit
 * for exactly this, and it was unreachable: the "call finish NOW" message was pushed into the
 * transcript and thrown past on the same tick.
 *
 * Two properties have to hold together, and they pull in opposite directions. The pass must be
 * able to RECOVER (or the run is wasted), and recovering must not quietly improve the benchmark
 * numbers (or the fix is worse than the crash).
 */

/**
 * Both paths a pass writes (`docs/appmaps` and the run folder) hang off `dataRoot()`, so
 * pointing YARN_RUNNER_DATA at a temp dir isolates the whole thing — a test that published a
 * map into the real docs/appmaps would become the grounding for the next real run.
 */
function inTempRoot(fn: () => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "explore-blackout-"));
	const prev = process.env.YARN_RUNNER_DATA;
	process.env.YARN_RUNNER_DATA = dir;
	try {
		fn();
	} finally {
		if (prev === undefined) delete process.env.YARN_RUNNER_DATA;
		else process.env.YARN_RUNNER_DATA = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("blindAction__Advises__When__TheModelStillHasObservationsLeft", () => {
	// The first two blank observations are the model's to fix: closing the offending window
	// often works, and restarting the app on strike one throws away a recoverable pass.
	assert.equal(blindAction(1, 0, 1, true), "advise");
	assert.equal(blindAction(2, 0, 1, true), "advise");
});

test("blindAction__Relaunches__When__TheModelExhaustedItsAttempts", () => {
	assert.equal(blindAction(3, 0, 1, true), "relaunch");
});

test("blindAction__OffersAConcedeTurn__When__TheRelaunchBudgetIsSpent", () => {
	// THE REGRESSION THIS FILE EXISTS FOR. The old code threw here, so the exit its own message
	// advertised could never be taken. There must be exactly one turn between running out of
	// instruments and killing the pass.
	assert.equal(blindAction(3, 1, 1, true), "concede-turn");
});

test("blindAction__OffersAConcedeTurn__When__NoRecoveryIsAvailableAtAll", () => {
	// A web target has no relaunch rung — quitting the profile Chrome takes the signed-in
	// session with it. It must still get its concede turn rather than dropping straight to fatal.
	assert.equal(blindAction(3, 0, 1, false), "concede-turn");
});

test("blindAction__IsFatal__When__TheConcedeTurnWasNotTaken", () => {
	assert.equal(blindAction(4, 1, 1, true), "fatal");
	assert.equal(blindAction(4, 0, 1, false), "fatal");
});

test("blindAction__RelaunchesAgain__When__TheBudgetAllowsMore", () => {
	// The budget is env-tunable; the ladder must read it rather than hardcode one restart.
	assert.equal(blindAction(3, 1, 2, true), "relaunch");
});

test("provenanceHeader__RecordsBlackouts__When__ThePassWentDark", () => {
	const header = provenanceHeader({
		app: "Yarn",
		actions: 90,
		elapsed: "20m",
		findings: 8,
		backend: "ax",
		findCalls: 0,
		vision: true,
		stopped: "frontier-empty",
		seen: 40,
		actuated: 20,
		dismissed: 5,
		surfaces: 9,
		chapters: 2,
		blackouts: 1,
		relaunches: 1,
	});
	// Without this the recovered pass is indistinguishable from one that never needed
	// recovering, and "2 of 4 ax passes hit an unrecoverable blackout" becomes unreportable.
	assert.match(header, /blackouts: 1 \| relaunches: 1/);
});

test("provenanceHeader__OmitsBlackouts__When__ThePassNeverWentDark", () => {
	const header = provenanceHeader({
		app: "Yarn",
		actions: 90,
		elapsed: "20m",
		findings: 8,
		backend: "ax",
		findCalls: 0,
		vision: true,
		stopped: "frontier-empty",
		seen: 40,
		actuated: 20,
		dismissed: 5,
		surfaces: 9,
		chapters: 2,
	});
	assert.doesNotMatch(header, /blackouts/);
});

test("writeArtifacts__WithholdsTheMap__When__ThePassConceded", () => {
	inTempRoot(() => {
		const p = newPass({ kind: "app", name: "Yarn" }, "Yarn", "ax", true, undefined, false);
		writeArtifacts(p, { document: "# map", findings: [] } as never, "frontier-conceded");
		// Conceding sets the same "the model called finish" flag as sweeping the frontier. If
		// that were allowed to publish, offering a graceful exit would have turned a crash into
		// a delivered sample — a truncated map standing in for a complete one, and phase 2
		// grounding on the pass that gave up.
		assert.equal(fs.existsSync(p.outPath), false, "a conceded pass must not publish to docs/appmaps");
		// It still records what it learned in its own folder. That is what conceding buys, and
		// it is the whole difference from a stack trace.
		assert.equal(fs.existsSync(p.appmapProsePath), true, "the run's own copy is always written");
	});
});

test("writeArtifacts__PublishesTheMap__When__ThePassSweptTheFrontier", () => {
	inTempRoot(() => {
		const p = newPass({ kind: "app", name: "Yarn" }, "Yarn", "ax", true, undefined, false);
		writeArtifacts(p, { document: "# map", findings: [] } as never, "frontier-empty");
		assert.equal(fs.existsSync(p.outPath), true);
	});
});
