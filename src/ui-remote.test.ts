import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DispatchOptions, DispatchResult, FollowOptions, FollowResult, PullResult, StopResult } from "./remote/dispatch.js";
import type { FleetRow } from "./remote/fleet.js";
import { type HostEntry, HOSTS_SCHEMA, type Inventory } from "./remote/hosts.js";
import { setModelKey } from "./remote/team.js";
import {
	annotateRuns,
	appChoices,
	attachOffers,
	beginSignin,
	completeSignin,
	describeFleetRow,
	fleetView,
	hostChoices,
	LineSplitter,
	readRemotePrefs,
	type RemoteDeps,
	RemoteRunController,
	recordRemoteRun,
	saveModelKey,
	silenceNote,
	writeRemotePrefs,
} from "./ui-remote.js";

/**
 * The fleet-aware shell, offline by construction. Every dispatch, follow, pull and stop is an
 * injected function and every filesystem write goes to a temp root — the three Macs are live,
 * and a stray submit from a test run takes one out of the fleet for as long as the run lasts.
 */

const PIN = "SHA256:724od0jL8u9KOWHaFi+t710VcSUmsFnN79hdOcoOI2c";

function host(name: string, addr: string): HostEntry {
	return { name, ssh: { host: addr, port: 22, user: "administrator" }, vnc: { host: addr, port: 5900 }, hostKey: PIN };
}

const FLEET: Inventory = { schema: HOSTS_SCHEMA, hosts: [host("mac1", "10.0.0.1"), host("mac2", "10.0.0.2")] };

function inTempRoot(fn: () => void): void {
	const prev = process.env.YARN_RUNNER_DATA;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-remote-"));
	try {
		process.env.YARN_RUNNER_DATA = dir;
		fn();
	} finally {
		if (prev === undefined) delete process.env.YARN_RUNNER_DATA;
		else process.env.YARN_RUNNER_DATA = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("hostChoices__OffersLocalAlone__When__NoInventoryExists", () => {
	// The local-only developer is the normal case and must see no fleet UI at all — which the
	// page decides from this list being length one. A missing file is therefore not an error.
	const choices = hostChoices(
		() => {
			throw new Error("hosts.json: cannot read inventory (ENOENT)");
		},
		() => false,
	);

	assert.deepEqual(choices.hosts, ["local"]);
	assert.equal(choices.error, undefined);
});

test("hostChoices__ReportsError__When__InventoryExistsButDoesNotParse", () => {
	// The opposite case, and it has to be loud: silently offering only `local` here is
	// indistinguishable from having no fleet, and sends the operator looking for the Macs
	// instead of for the typo.
	const choices = hostChoices(
		() => {
			throw new Error('hosts.json: hosts[1]: "hostKey" must be null or a SHA256:… fingerprint');
		},
		() => true,
	);

	assert.deepEqual(choices.hosts, ["local"]);
	assert.match(choices.error ?? "", /hostKey/);
});

test("hostChoices__ListsAutoAndEveryHost__When__FleetIsConfigured", () => {
	assert.deepEqual(hostChoices(() => FLEET, () => true).hosts, ["local", "auto", "mac1", "mac2"]);
});

test("describeFleetRow__KeepsTheReason__When__HostIsUnreachable", () => {
	// The reason column is the entire value of the panel: "mac3 unknown" tells an operator
	// nothing, "no pinned host key" tells them what to do next.
	const view = describeFleetRow({ name: "mac3", reachable: false, state: "unknown", reason: "no pinned host key — run the known_hosts writer first" });

	assert.equal(view.detail, "");
	assert.match(view.reason ?? "", /no pinned host key/);
});

test("describeFleetRow__ReadsElapsedAsMinutes__When__HostIsRunningAGroundingPass", () => {
	// A finished exploration pass is ~40 minutes. Rendered as "2431" nobody reads it as a
	// duration, and the decision this panel supports — wait, or go and ask — is a duration.
	const view = describeFleetRow({ name: "mac2", reachable: true, state: "busy", operator: "jasper", app: "Yarn", elapsedSec: 2431, jobId: "explore-j1", tccOk: true });

	assert.equal(view.detail, "jasper · Yarn · 40m 31s");
	assert.equal(view.jobId, "explore-j1");
	assert.equal(view.tccOk, true);
});

test("describeFleetRow__KeepsTheStaleGrantSeparate__When__ItLandedAfterTheRunnerStarted", () => {
	// Both surface as tccOk: false, and they have opposite remedies — a plain missing grant
	// sends you to System Settings, a stale one sends you to a restart because the box in
	// System Settings is already ticked. The badge has to be able to tell them apart.
	const stale = describeFleetRow({ name: "mac1", reachable: true, state: "idle", tccOk: false, staleGrants: ["Screen Recording"] });
	assert.deepEqual(stale.staleGrants, ["Screen Recording"]);

	const missing = describeFleetRow({ name: "mac3", reachable: true, state: "idle", tccOk: false });
	assert.equal(missing.staleGrants, undefined);
});

test("fleetView__DegradesToAnErrorString__When__TheInventoryCannotBeRead", async () => {
	// A rejected IPC leaves the renderer with a pending promise and a panel stuck on "loading"
	// forever. An error string paints; a rejection does not.
	const view = await fleetView(async () => {
		throw new Error("hosts.json: not valid JSON");
	});

	assert.deepEqual(view.rows, []);
	assert.deepEqual(view.offers, []);
	assert.match(view.error ?? "", /not valid JSON/);
});

test("fleetView__RendersEveryRow__When__OneHostIsDegraded", async () => {
	const rows: FleetRow[] = [
		{ name: "mac1", reachable: true, state: "idle" },
		{ name: "mac2", reachable: false, state: "unknown", reason: "Operation timed out" },
		{ name: "mac3", reachable: true, state: "busy", jobId: "explore-j9", app: "Yarn", operator: "david", elapsedSec: 2431 },
	];
	const view = await fleetView(async () => rows);

	assert.deepEqual(view.rows.map((r) => r.name), ["mac1", "mac2", "mac3"]);
	assert.equal(view.rows[1].reason, "Operation timed out");
	// The re-attach offers ride on the same probe rather than a second fan-out: the panel and
	// the banner disagreeing about who is busy would mean offering a job that had just ended.
	assert.deepEqual(view.offers.map((o) => o.jobId), ["explore-j9"]);
	assert.equal(view.error, undefined);
});

test("attachOffers__FindsTheLiveJob__When__AHostIsBusy", () => {
	// The single most valuable thing the fleet panel does: a closed window used to lose every
	// line a 40-minute pass printed, and all that was ever missing locally was this id.
	const offers = attachOffers([
		{ name: "mac1", reachable: true, state: "idle" },
		{ name: "mac2", reachable: true, state: "busy", jobId: "explore-j1", app: "Yarn", operator: "david", elapsedSec: 900 },
		{ name: "mac3", reachable: true, state: "busy", app: "Yarn" },
	]);

	assert.deepEqual(offers, [{ host: "mac2", jobId: "explore-j1", app: "Yarn", operator: "david", elapsedSec: 900 }]);
});

test("push__EmitsWholeLines__When__ChunkBoundarySplitsALine", () => {
	// follow() delivers byte-boundary chunks; the page classifies each onLine by regex. A step
	// line split across two calls matches neither half.
	const s = new LineSplitter();

	assert.deepEqual(s.push("[12] cli"), []);
	assert.deepEqual(s.push("ck settings\n[13] "), ["[12] click settings"]);
	assert.deepEqual(s.push("verify\n"), ["[13] verify"]);
	assert.deepEqual(s.flush(), []);
});

test("flush__EmitsTheTail__When__LogDoesNotEndInANewline", () => {
	const s = new LineSplitter();
	s.push("=== DONE");

	assert.deepEqual(s.flush(), ["=== DONE"]);
	assert.deepEqual(s.flush(), [], "the tail was emitted twice");
});

test("silenceNote__SaysNothing__When__OutputIsRecent", () => {
	assert.equal(silenceNote(30_000, "mac1", "j-1"), undefined);
});

test("silenceNote__Announces__When__StreamHasBeenQuietForAMinute", () => {
	// A single model turn on a hard step runs minutes with no output, and a pane that has
	// printed nothing for four of them is indistinguishable from a dead ssh — which is the
	// state that gets a legitimate 40-minute pass killed.
	assert.match(silenceNote(240_000, "mac2", "j-7") ?? "", /j-7 on mac2.*no output for 4m 00s/);
});

/** Collects everything the page's log pane would show, plus the terminal `done`. */
function sink(): { handlers: { onLine(l: string): void; onDone(c: number | null, e: number): void }; lines: string[]; done: Promise<{ code: number | null }> } {
	const lines: string[] = [];
	let settle: (v: { code: number | null }) => void = () => {};
	const done = new Promise<{ code: number | null }>((r) => {
		settle = r;
	});

	return { lines, done, handlers: { onLine: (l) => void lines.push(l), onDone: (code) => settle({ code }) } };
}

function accepted(jobId: string, name = "mac1"): DispatchResult {
	return { ok: true, host: host(name, "10.0.0.1"), jobId, kind: "task", app: "Yarn", artifacts: { log: `out/jobs/${jobId}/log.txt` }, attempts: [] };
}

function fakeDeps(over: Partial<RemoteDeps> = {}): RemoteDeps {
	return {
		dispatch: async () => accepted("j-1"),
		follow: async () => ({ nextOffset: 0, done: true, state: "done", exitCode: 0 }),
		pull: async (_h, jobId) => ({ ok: true, jobId, artifacts: [] }) as PullResult,
		stopRemote: async () => ({ ok: true }) as StopResult,
		now: () => 0,
		sleep: async () => {},
		record: () => {},
		// Default to "nothing moved" rather than to the real fan-out: the tests below run a
		// grounding pass to completion, and the real one would go looking for Macs.
		sync: async () => undefined,
		...over,
	};
}

/**
 * A task that `auditTaskPrompt` would refuse. It must still cross the wire untouched: agent.ts
 * on the far side is the one authoritative gate (CLAUDE.md, "Measurement rule"), and a local
 * pre-screen in the shell would be a second copy of that rule that can disagree with the first.
 */
const HINTED_TASK = "  click the gear, then press cmd+, and set_value on the cursor field  ";

test("start__SendsTheTaskVerbatim__When__PromptWouldFailTheAudit", async () => {
	let seen: DispatchOptions | undefined;
	const deps = fakeDeps({
		dispatch: async (opts) => {
			seen = opts;

			return accepted("j-1");
		},
	});
	const s = sink();
	const err = new RemoteRunController(deps).start({ host: "mac1", app: "Yarn", task: HINTED_TASK, kind: "task", record: true, noVision: false }, s.handlers);

	assert.equal(err, undefined, "the shell screened the task locally");
	await s.done;
	assert.equal(seen?.task, HINTED_TASK);
	assert.equal(seen?.record, true);
	assert.equal(seen?.kind, "task");
});

test("start__RefusesLocally__When__NoAppIsSelected", () => {
	const s = sink();
	assert.match(new RemoteRunController(fakeDeps()).start({ host: "auto", app: "  ", task: "x", kind: "task", record: false, noVision: false }, s.handlers) ?? "", /pick an app/);
});

test("start__ReportsThroughTheLog__When__NoHostAccepted", async () => {
	// The dispatch round trip is seconds long, so a refusal cannot be the return value the page
	// awaits — it arrives as a log line and a `done`, the same way a failed run does.
	const deps = fakeDeps({ dispatch: async () => ({ ok: false, error: "no idle host in the fleet", attempts: [] }) });
	const s = sink();
	const controller = new RemoteRunController(deps);

	assert.equal(controller.start({ host: "auto", app: "Yarn", task: "t", kind: "task", record: false, noVision: false }, s.handlers), undefined);
	assert.equal((await s.done).code, 1);
	assert.match(s.lines.join("\n"), /no idle host in the fleet/);
	assert.equal(controller.busy, false, "a refused dispatch left the controller stuck");
});

test("start__PullsBeforeDone__When__TheRunFinishes", async () => {
	// The page reloads the gallery on `done`. A pull that ran after it would leave the new
	// recording invisible until the next poll — and that poll skips the redraw when the set of
	// run ids has not changed, so it can be invisible until a restart.
	const order: string[] = [];
	const recorded: string[] = [];
	const deps = fakeDeps({
		follow: async (_h, _j, onChunk) => {
			onChunk("[1] click\n✓ verified\n");

			return { nextOffset: 24, done: true, state: "done", exitCode: 0 };
		},
		pull: async (_h, jobId) => {
			order.push("pull");

			return { ok: true, jobId, artifacts: [{ key: "recording", rel: `out/recording/${jobId}`, local: "/tmp/x", state: "pulled" }] } as PullResult;
		},
		record: (jobId, h) => void recorded.push(`${jobId}@${h}`),
	});
	const s = sink();
	s.handlers.onDone = () => order.push("done");
	const controller = new RemoteRunController(deps);
	controller.start({ host: "mac1", app: "Yarn", task: "t", kind: "task", record: true, noVision: false }, s.handlers);
	// The controller settles on its own microtask chain; one turn of the loop is enough here
	// because every injected dependency resolves immediately.
	await new Promise((r) => setImmediate(r));

	assert.deepEqual(order, ["pull", "done"]);
	assert.deepEqual(recorded, ["j-1@mac1"]);
	assert.deepEqual(s.lines.filter((l) => l.startsWith("[") || l.startsWith("✓")), ["[1] click", "✓ verified", "✓ out/recording/j-1"]);
});

test("start__ResumesFromTheOffset__When__TheLogStreamDrops", async () => {
	// A 40-minute follow over a colo link WILL be interrupted. Restarting from byte zero would
	// reprint the whole run into the pane; giving up would lose the rest of it.
	const offsets: (number | undefined)[] = [];
	const deps = fakeDeps({
		follow: async (_h, _j, onChunk, opts?: FollowOptions): Promise<FollowResult> => {
			offsets.push(opts?.fromByte);
			if (offsets.length === 1) {
				onChunk("first half\n");

				return { nextOffset: 411, done: false, error: "ssh exited 255" };
			}
			onChunk("second half\n");

			return { nextOffset: 800, done: true, state: "done", exitCode: 0 };
		},
	});
	const s = sink();
	new RemoteRunController(deps).start({ host: "mac1", app: "Yarn", task: "t", kind: "task", record: false, noVision: false }, s.handlers);
	await s.done;

	assert.deepEqual(offsets, [0, 411]);
	assert.deepEqual(s.lines.filter((l) => l.endsWith("half")), ["first half", "second half"]);
});

test("start__StopsRetrying__When__TheStreamKeepsFailing", async () => {
	let calls = 0;
	const deps = fakeDeps({
		follow: async (): Promise<FollowResult> => {
			calls++;

			return { nextOffset: 0, done: false, error: "no jobs on this host" };
		},
	});
	const s = sink();
	new RemoteRunController(deps).start({ host: "mac1", app: "Yarn", task: "t", kind: "task", record: false, noVision: false }, s.handlers);

	assert.equal((await s.done).code, 1);
	assert.equal(calls, 6, "the retry budget is unbounded");
	assert.match(s.lines.at(-1) ?? "", /may still be running/);
});

test("detach__LeavesTheRunAlive__When__TheWindowCloses", async () => {
	// The whole reason to dispatch a 40-minute pass to a colo Mac is that the laptop stops being
	// load-bearing. A closing window that stopped the run would give exactly that back.
	let stopped = 0;
	const deps = fakeDeps({
		stopRemote: async () => {
			stopped++;

			return { ok: true } as StopResult;
		},
		follow: async (_h, _j, _c, opts?: FollowOptions): Promise<FollowResult> => {
			await new Promise((r) => setImmediate(r));

			return { nextOffset: 120, done: false, ...(opts?.signal?.aborted ? {} : { error: "stream ended" }) };
		},
	});
	const s = sink();
	const controller = new RemoteRunController(deps);
	controller.start({ host: "mac1", app: "Yarn", task: "t", kind: "task", record: false, noVision: false }, s.handlers);
	await new Promise((r) => setImmediate(r));
	controller.detach();

	assert.equal((await s.done).code, 0, "detaching was reported as a failure");
	assert.equal(stopped, 0, "closing the window stopped the remote run");
	assert.match(s.lines.join("\n"), /keeps running on mac1/);
});

test("stop__EndsTheRemoteJob__When__TheOperatorAsks", async () => {
	const stops: (string | undefined)[] = [];
	const deps = fakeDeps({
		dispatch: async () => accepted("j-9", "mac2"),
		follow: async () => {
			await new Promise((r) => setTimeout(r, 5));

			return { nextOffset: 0, done: true, state: "stopped", exitCode: null };
		},
		stopRemote: async (_h, jobId) => {
			stops.push(jobId);

			return { ok: true } as StopResult;
		},
	});
	const s = sink();
	const controller = new RemoteRunController(deps);
	controller.start({ host: "auto", app: "Yarn", task: "t", kind: "task", record: false, noVision: false }, s.handlers);
	await new Promise((r) => setImmediate(r));

	assert.deepEqual(controller.attached, { host: "mac2", jobId: "j-9" }, "auto did not resolve to the host that accepted");
	assert.equal(await controller.stop(), undefined);
	assert.deepEqual(stops, ["j-9"]);
	await s.done;
});

test("stop__Refuses__When__TheDispatchHasNotBeenAcceptedYet", async () => {
	// The page shows Stop the moment `started` echoes — seconds before the ssh dispatch
	// resolves. In that window the host can still read `auto` (stopRemote would throw resolving
	// it) and there is no jobId, which stopRemote treats as "stop whatever that Mac is doing" —
	// possibly someone ELSE's run. Neither is acceptable; the stop waits.
	let dispatched: (v: DispatchResult) => void = () => {};
	const gate = new Promise<DispatchResult>((r) => {
		dispatched = r;
	});
	const stops: (string | undefined)[] = [];
	const deps = fakeDeps({
		dispatch: () => gate,
		stopRemote: async (_h, jobId) => {
			stops.push(jobId);

			return { ok: true } as StopResult;
		},
	});
	const s = sink();
	const controller = new RemoteRunController(deps);
	controller.start({ host: "auto", app: "Yarn", task: "t", kind: "task", record: false, noVision: false }, s.handlers);

	assert.match((await controller.stop()) ?? "", /not been accepted yet/);
	assert.deepEqual(stops, [], "a stop before the jobId exists reached the remote");
	dispatched(accepted("j-1"));
	await s.done;
});

test("stop__AnswersWithTheFailure__When__TheStopItselfThrows", async () => {
	// A rejected stopRemote used to escape through the IPC handler as an unhandled rejection;
	// the operator watched a run they believed they had ended.
	const deps = fakeDeps({
		dispatch: async () => accepted("j-2"),
		follow: async () => {
			await new Promise((r) => setTimeout(r, 5));

			return { nextOffset: 0, done: true, state: "stopped", exitCode: null } as FollowResult;
		},
		stopRemote: async () => {
			throw new Error("ssh exited 255");
		},
	});
	const s = sink();
	const controller = new RemoteRunController(deps);
	controller.start({ host: "mac1", app: "Yarn", task: "t", kind: "task", record: false, noVision: false }, s.handlers);
	await new Promise((r) => setImmediate(r));

	assert.match((await controller.stop()) ?? "", /ssh exited 255/);
	await s.done;
});

test("start__KeepsRetrying__When__DropsAreTransientAndTheStreamMakesProgress", async () => {
	// A lifetime attempt counter declared the stream lost on the sixth drop of a 40-minute
	// pass even when every reattach worked. Progress must buy the budget back: eight drops,
	// each followed by real bytes, end with the run's own `done`, not with "lost the stream".
	let calls = 0;
	const deps = fakeDeps({
		follow: async (_h, _j, onChunk, opts?: FollowOptions): Promise<FollowResult> => {
			calls++;
			const at = opts?.fromByte ?? 0;
			if (calls > 8) return { nextOffset: at, done: true, state: "done", exitCode: 0 };
			onChunk(`chunk ${calls}\n`);

			return { nextOffset: at + 10, done: false, error: "ssh exited 255" };
		},
	});
	const s = sink();
	new RemoteRunController(deps).start({ host: "mac1", app: "Yarn", task: "t", kind: "task", record: false, noVision: false }, s.handlers);

	assert.equal((await s.done).code, 0, "a stream that always recovered was declared lost");
	assert.equal(calls, 9);
});

test("start__FlushesTheTail__When__TheStreamIsDeclaredLost", async () => {
	// The lost-stream exit was the one terminal path that dropped the splitter's pending
	// partial line — often the run's last words, since a dying stream rarely ends on a newline.
	// The chunk arrives once, on the first attempt: retries resume from the same offset and a
	// truly dead stream hands over nothing more.
	let first = true;
	const deps = fakeDeps({
		follow: async (_h, _j, onChunk): Promise<FollowResult> => {
			if (first) {
				first = false;
				onChunk("half a final line");
			}

			return { nextOffset: 0, done: false, error: "gone" };
		},
	});
	const s = sink();
	new RemoteRunController(deps).start({ host: "mac1", app: "Yarn", task: "t", kind: "task", record: false, noVision: false }, s.handlers);

	assert.equal((await s.done).code, 1);
	assert.ok(s.lines.includes("half a final line"), "the pending partial line was dropped on the lost-stream exit");
});

test("start__ReportsTheResolvedHostThroughOnHost__When__AutoPicksAMac", async () => {
	// The shell keys its one-run-per-host bookkeeping on this callback: until it fires, the run
	// sits under `auto`, and only the controller ever learns which machine the dispatch chose.
	const deps = fakeDeps({ dispatch: async () => accepted("j-9", "mac3") });
	const s = sink();
	const resolved: string[] = [];
	new RemoteRunController(deps).start(
		{ host: "auto", app: "Yarn", task: "t", kind: "task", record: false, noVision: false },
		{ ...s.handlers, onHost: (h) => void resolved.push(h) },
	);
	await s.done;

	assert.deepEqual(resolved, ["mac3"]);
});

test("lastRunHost__StillNamesTheMac__When__TheRunHasAlreadyFinished", async () => {
	// `attached` is cleared before `done` fires, and `done` is exactly when a caller needs the
	// host: a run that refuses to drive names a machine someone has to go and look at. With
	// `auto` the caller never picked one, so this is the only place the answer exists.
	const deps = fakeDeps({ dispatch: async () => accepted("j-9", "mac3") });
	const s = sink();
	const controller = new RemoteRunController(deps);
	controller.start({ host: "auto", app: "Yarn", task: "t", kind: "task", record: false, noVision: false }, s.handlers);
	await s.done;

	assert.equal(controller.attached, undefined);
	assert.equal(controller.lastRunHost, "mac3");
});

test("collect__NamesTheSigninCommand__When__TheAgentExitedUnready", async () => {
	// The agent knows it is not at home; it does not know what this inventory calls the Mac it
	// is running on, so the remedy has to be written on this side.
	const deps = fakeDeps({
		dispatch: async () => accepted("j-4", "mac1"),
		follow: async () => ({ nextOffset: 0, done: true, state: "done", exitCode: 3 }),
		pull: async (_h, jobId) =>
			({ ok: true, jobId, job: { id: jobId, app: "Notion Calendar" }, artifacts: [] }) as unknown as PullResult,
	});
	const s = sink();
	new RemoteRunController(deps).start({ host: "auto", app: "Notion Calendar", task: "t", kind: "task", record: false, noVision: false }, s.handlers);
	await s.done;

	// Quoted: the canonical target names have spaces in them.
	assert.ok(s.lines.some((l) => l.includes('./run signin mac1 "Notion Calendar"')), s.lines.join("\n"));
});

test("collect__SaysNothingAboutSigningIn__When__TheRunActuallyRan", async () => {
	// Every other non-zero exit is a run that started and went wrong. Offering a sign-in there
	// would send an operator to a screen share to fix something a screen share cannot fix.
	const deps = fakeDeps({
		follow: async () => ({ nextOffset: 0, done: true, state: "done", exitCode: 1 }),
		pull: async (_h, jobId) => ({ ok: true, jobId, job: { id: jobId, app: "Yarn" }, artifacts: [] }) as unknown as PullResult,
	});
	const s = sink();
	new RemoteRunController(deps).start({ host: "mac1", app: "Yarn", task: "t", kind: "task", record: false, noVision: false }, s.handlers);
	await s.done;

	assert.ok(!s.lines.some((l) => l.includes("signin")), s.lines.join("\n"));
});

test("attach__ReplaysFromByteZero__When__ReattachingAfterARestart", async () => {
	// Byte zero and not the tail: the point of re-attaching is to recover the output the closed
	// window lost, and the remote still holds all of it.
	let from: number | undefined;
	const deps = fakeDeps({
		dispatch: async () => {
			throw new Error("attach must not dispatch");
		},
		follow: async (_h, _j, onChunk, opts?: FollowOptions) => {
			from = opts?.fromByte;
			onChunk("[1] earlier line\n");

			return { nextOffset: 17, done: true, state: "done", exitCode: 0 };
		},
	});
	const s = sink();
	new RemoteRunController(deps).attach("mac2", "explore-j1", s.handlers);
	await s.done;

	assert.equal(from, 0);
	assert.match(s.lines[0], /attaching to explore-j1 on mac2/);
	assert.equal(s.lines.includes("[1] earlier line"), true);
});

test("attach__Refuses__When__AlreadyFollowingSomething", async () => {
	const deps = fakeDeps({ follow: async () => new Promise<FollowResult>(() => {}) });
	const controller = new RemoteRunController(deps);
	const s = sink();
	controller.attach("mac1", "j-1", s.handlers);

	assert.match(controller.attach("mac2", "j-2", s.handlers) ?? "", /already following/);
});

test("annotateRuns__TagsOnlyFleetRuns__When__GalleryMixesLocalAndRemote", () => {
	// The badge means "this came off the fleet". Labelling local runs too would erase the
	// distinction it exists to draw.
	const tagged = annotateRuns([{ id: "j-remote" }, { id: "j-local" }], { "j-remote": "mac2" });

	assert.deepEqual(tagged, [{ id: "j-remote", host: "mac2" }, { id: "j-local" }]);
});

test("recordRemoteRun__RoundTrips__When__ArtifactsArePulled", () => {
	inTempRoot(() => {
		recordRemoteRun("j-1", "mac1");
		recordRemoteRun("j-2", "mac3");

		assert.deepEqual(annotateRuns([{ id: "j-2" }]), [{ id: "j-2", host: "mac3" }]);
	});
});

test("readRemotePrefs__ReturnsLocal__When__NothingWasEverSaved", () => {
	inTempRoot(() => {
		assert.deepEqual(readRemotePrefs(), { host: "local" });
	});
});

test("writeRemotePrefs__RoundTripsTheHost__When__SelectorChanges", () => {
	inTempRoot(() => {
		writeRemotePrefs({ host: "mac2" });
		assert.deepEqual(readRemotePrefs(), { host: "mac2" });
		// The file is hand-editable like every other state file here, so a junk value degrades
		// to local rather than sending a run at a host that does not exist.
		writeRemotePrefs({ host: 42 });
		assert.deepEqual(readRemotePrefs(), { host: "local" });
	});
});

function inTempRunnerDir(fn: (dir: string) => void): void {
	const prev = process.env.YARN_RUNNER_DIR;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-remote-runner-"));
	try {
		process.env.YARN_RUNNER_DIR = dir;
		fn(dir);
	} finally {
		if (prev === undefined) delete process.env.YARN_RUNNER_DIR;
		else process.env.YARN_RUNNER_DIR = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// Assembled rather than written out: a literal of this shape trips GitHub push protection,
// which scans for the pattern and cannot tell 64 zeros from a live credential.
const FAKE_KEY = ["sk", "or", "v1", "0".repeat(64)].join("-");

test("setModelKey__OverwritesTheExistingKey__When__SavedFromTheGui", () => {
	// applyCredentials deliberately KEEPS an existing key; an explicit save is the opposite
	// instruction. A save that reported success while leaving the old key in place is the most
	// confusing outcome available here.
	inTempRunnerDir((dir) => {
		const file = path.join(dir, "env");
		fs.writeFileSync(file, "OPENROUTER_API_KEY='old-key'\nAGENT_MODEL=claude-opus-5\n");
		setModelKey(FAKE_KEY);

		const text = fs.readFileSync(file, "utf8");
		assert.equal(text.includes("old-key"), false);
		assert.equal(text.includes("AGENT_MODEL=claude-opus-5"), true, "an unrelated setting was dropped");
		assert.equal((text.match(/OPENROUTER_API_KEY/g) ?? []).length, 1, "a second assignment was appended");
		// mode applies at creation only, so an env file that already existed 0644 would keep it —
		// which is how a key typed into a GUI ends up world-readable on a shared Mac.
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	});
});

test("setModelKey__Refuses__When__KeyCouldBreakOutOfItsQuotes", () => {
	// The value is written inside single quotes into a file the provisioning path sources with
	// a shell. There is no escaping that survives both readers, so it is refused, not mangled.
	inTempRunnerDir(() => {
		// Every case below is SPACE-FREE, deliberately. The original test here was
		// "sk-or-'; rm -rf /" and it passed against a regex that permitted `'` — the space is
		// what failed it. So the test asserted the right outcome for the wrong reason and went
		// on passing while the one character it was named after went through.
		for (const hostile of ["sk-or-'", "a';id;'", "sk-or-';rm", "sk-\\or", "sk-or-'\n"])
			assert.throws(() => setModelKey(hostile), /does not look like an API key/, `${JSON.stringify(hostile)} must be refused`);

		assert.throws(() => setModelKey("sk-or-v1 abc"), /does not look like an API key/);
		assert.throws(() => setModelKey("   "), /no key given/);

		// A realistic key still has to be accepted — a check this strict is only safe if it
		// passes the values it exists to protect.
		assert.doesNotThrow(() => setModelKey("sk-or-v1-0123456789abcdef_ABCDEF-xyz.09"));
	});
});

test("saveModelKey__AnswersWithBooleansOnly__When__KeyIsAccepted", () => {
	// The credentials panel is the one part of this UI people screenshot. Nothing it renders may
	// contain the key, not even a prefix.
	inTempRunnerDir(() => {
		const result = saveModelKey(FAKE_KEY);

		assert.equal(result.ok, true);
		assert.equal(result.ok && result.credentials.modelKey, true);
		assert.equal(JSON.stringify(result).includes(FAKE_KEY.slice(0, 12)), false, "the saved key was echoed back to the renderer");
	});
});

test("saveModelKey__ReportsTheReason__When__KeyIsRejected", () => {
	inTempRunnerDir(() => {
		const bad = "sk-or-v1 with spaces";
		const result = saveModelKey(bad);

		assert.equal(result.ok, false);
		assert.equal(!result.ok && result.error.includes(bad), false, "the rejected input was quoted back into the UI");
	});
});

/** The local enumerator, stubbed. Nothing in these tests reads a real /Applications. */
const LOCAL_APPS = [{ name: "Safari", running: true, grounded: false }];

test("appChoices__AsksTheHost__When__ARemoteMacIsSelected", async () => {
	// The point of the whole change: a colo Mac's list must come from that Mac. Safari being
	// absent from the answer is the assertion — it would only appear if we enumerated locally.
	let asked: string | undefined;
	const res = await appChoices("mac1", () => LOCAL_APPS, async (host) => {
		asked = String(host);

		return { host: "mac1", ok: true, apps: [{ name: "Yarn", running: false, grounded: true }] };
	});

	assert.equal(asked, "mac1");
	assert.deepEqual(res.apps.map((a) => a.name), ["Yarn"]);
	assert.equal(res.note, undefined);
});

test("appChoices__EnumeratesLocally__When__TheHostIsLocalOrUnset", async () => {
	const reject = async () => {
		throw new Error("a local host must not open an ssh connection");
	};

	assert.deepEqual((await appChoices("local", () => LOCAL_APPS, reject as never)).apps, LOCAL_APPS);
	assert.deepEqual((await appChoices(undefined, () => LOCAL_APPS, reject as never)).apps, LOCAL_APPS);
	assert.deepEqual((await appChoices("  ", () => LOCAL_APPS, reject as never)).apps, LOCAL_APPS);
});

/** The local enumerator as a tripwire: `auto` never runs locally, so it must never be asked. */
const NO_LOCAL = (): never => {
	throw new Error("auto must not enumerate this Mac's apps — auto never runs locally");
};

test("appChoices__OffersTheFleetIntersection__When__TheHostIsAuto", async () => {
	// A run dispatched to `auto` can land on ANY fleet host, so only an app present on all of
	// them is safe to offer — and the local list is exactly wrong, because dispatch walks the
	// inventory and only the inventory. The badges AND together for the same reason: "open" on
	// one host says nothing about the host the scheduler actually picks.
	const asked: string[] = [];
	const res = await appChoices(
		"auto",
		NO_LOCAL,
		async (h) => {
			const name = typeof h === "string" ? h : h.name;
			asked.push(name);

			return name === "mac1"
				? { host: "mac1", ok: true, apps: [{ name: "Yarn", running: true, grounded: true }, { name: "Notion Calendar", running: false, grounded: true }, { name: "Hex Fiend", running: false, grounded: false }] }
				: { host: "mac2", ok: true, apps: [{ name: "Notion Calendar", running: true, grounded: false }, { name: "Yarn", running: true, grounded: true }] };
		},
		() => FLEET,
	);

	assert.deepEqual(asked.sort(), ["mac1", "mac2"], "auto must ask every fleet host, and nothing else");
	// Hex Fiend is only on mac1, so it is not offerable; flags survive only when true everywhere.
	assert.deepEqual(res.apps, [
		{ name: "Yarn", running: true, grounded: true },
		{ name: "Notion Calendar", running: false, grounded: false },
	]);
	assert.equal(res.host, "auto");
	assert.match(String(res.note), /every fleet host/);
});

test("appChoices__NamesTheSilentMac__When__OneFleetHostDoesNotAnswer", async () => {
	// A rebooting Mac shrinks the fan-out rather than blanking the picker, but the operator has
	// to be told the list may be wider than shown — and which machine to go look at.
	const res = await appChoices(
		"auto",
		NO_LOCAL,
		async (h) => {
			const name = typeof h === "string" ? h : h.name;
			if (name === "mac2") throw new Error("ssh timed out");

			return { host: name, ok: true, apps: [{ name: "Yarn", running: false, grounded: true }] };
		},
		() => FLEET,
	);

	assert.deepEqual(res.apps.map((a) => a.name), ["Yarn"]);
	assert.match(String(res.note), /mac2 did not answer/);
});

test("appChoices__ExplainsTheEmptyList__When__NoFleetHostAnswers", async () => {
	// Nothing reachable means auto has nowhere to run. An empty list with a note saying so
	// beats a local fallback whose every entry would be refused at submit time.
	const res = await appChoices(
		"auto",
		NO_LOCAL,
		async () => {
			throw new Error("ssh timed out");
		},
		() => FLEET,
	);

	assert.deepEqual(res.apps, []);
	assert.match(String(res.note), /no fleet host answered.*mac1, mac2.*nowhere to run/);
});

test("appChoices__ExplainsTheEmptyList__When__TheHostIsUnreachable", async () => {
	// An unreachable Mac must not fall back to local apps: that is the original bug wearing a
	// different hat, and every entry would be a run that fails minutes later on the far side.
	const refused = await appChoices("mac2", () => LOCAL_APPS, async () => ({ host: "mac2", ok: false, apps: [], reason: "connection refused" }));
	assert.deepEqual(refused.apps, []);
	assert.match(String(refused.note), /mac2: connection refused/);

	const threw = await appChoices("mac2", () => LOCAL_APPS, async () => {
		throw new Error("ssh timed out");
	});
	assert.deepEqual(threw.apps, []);
	assert.match(String(threw.note), /ssh timed out/);
});

/**
 * Sign-in from the fleet panel. `planSignin` is injected, so nothing here launches an app or
 * opens a viewer — what is under test is the part the CLI got for free from its argv: turning
 * a selector value that may say `local` or `auto` into a machine worth connecting to, and
 * saying something useful when it does not.
 */
const noPlan = async () => {
	throw new Error("must not plan a sign-in for a host that is not a Mac");
};

test("beginSignin__OpensTheViewer__When__AMacIsSelected", async () => {
	let asked: [string, string | undefined] | undefined;
	const view = await beginSignin("mac1", "Yarn", () => FLEET, async (h, app) => {
		asked = [h.name, app];

		return { host: h, url: "vnc://10.0.0.1:5900", launch: { app: "Yarn", ok: true, foregrounded: true, detail: "" } };
	});

	assert.deepEqual(asked, ["mac1", "Yarn"]);
	assert.equal(view.url, "vnc://10.0.0.1:5900");
	assert.equal(view.ok, true);
	assert.match(view.message, /Opened Yarn on mac1/);
});

test("beginSignin__StillOffersTheScreen__When__TheAppWouldNotLaunch", async () => {
	// An operator looking at the Mac can start it from the Dock, which beats refusing to do the
	// one part that still works.
	const view = await beginSignin("mac1", "Yarn", () => FLEET, async (h) => ({
		host: h,
		url: "vnc://10.0.0.1:5900",
		launch: { app: "Yarn", ok: false, foregrounded: false, detail: "not installed" },
	}));

	assert.equal(view.url, "vnc://10.0.0.1:5900");
	assert.equal(view.ok, true);
	assert.match(view.message, /not installed.*Dock/s);
});

test("beginSignin__Refuses__When__TheSelectorSaysLocal", async () => {
	const view = await beginSignin("local", "Yarn", () => FLEET, noPlan as never);
	assert.equal(view.ok, false);
	assert.equal(view.url, undefined);
	assert.match(view.message, /colo Macs/);
});

test("beginSignin__Refuses__When__TheSelectorSaysAuto", async () => {
	// `auto` is a scheduling instruction. Resolving it here would sign in on a machine nobody
	// picked, and the next run could land on a different one.
	const view = await beginSignin("auto", "Yarn", () => FLEET, noPlan as never);
	assert.equal(view.ok, false);
	assert.match(view.message, /Pick a specific Mac/);
});

test("beginSignin__ReportsTheReason__When__TheHostIsNotInTheInventory", async () => {
	const view = await beginSignin("mac9", "Yarn", () => FLEET, noPlan as never);
	assert.equal(view.ok, false);
	assert.equal(view.url, undefined);
	assert.match(view.message, /mac9/);
});

test("beginSignin__ConnectsWithoutLaunching__When__NoAppIsSelected", async () => {
	// Nothing is selected in the shell on first open, and the wall is still worth clearing.
	let appArg: string | undefined = "unset";
	const view = await beginSignin("mac2", "   ", () => FLEET, async (h, app) => {
		appArg = app;

		return { host: h, url: "vnc://10.0.0.2:5900" };
	});

	assert.equal(appArg, undefined);
	assert.equal(view.url, "vnc://10.0.0.2:5900");
	assert.match(view.message, /Connecting to mac2/);
});

/**
 * completeSignin: the half that runs while a person is typing. Its whole job is to answer the
 * one question the panel cannot answer for itself — did the sign-in take — and then tidy up.
 */

test("completeSignin__ClosesTheShare__When__TheAppReachesItsHome", async () => {
	let closed = "";
	const out = await completeSignin(
		"mac1",
		"Yarn",
		() => FLEET,
		async () => ({ ready: true, detail: 'home control "Library" is on screen' }),
		async (h) => {
			closed = h.name;

			return { closed: true, detail: "closed the screen share" };
		},
	);

	assert.equal(out.ok, true);
	assert.equal(closed, "mac1");
	assert.match(out.message, /closed the screen share/);
});

test("completeSignin__StillReportsSuccess__When__TheViewerWillNotClose", async () => {
	// Closing needs an Accessibility grant this process may not have, and a viewer left open is a
	// nuisance. Reporting the sign-in as failed because of it would send the operator back to redo
	// the one thing that actually worked.
	const out = await completeSignin("mac1", "Yarn", () => FLEET, async () => ({ ready: true, detail: "at home" }), async () => ({
		closed: false,
		detail: "System Events got an error: osascript is not allowed assistive access. (-25211)",
	}));

	assert.equal(out.ok, true);
	assert.match(out.message, /Close the screen share when you are ready/);
	// The reason travels with the nag. Told only to close it themselves, an operator closes it
	// themselves every time and never learns there is a grant that would stop them having to.
	assert.match(out.message, /assistive access/);
});

test("completeSignin__LeavesTheShareOpen__When__TheAppNeverGetsThere", async () => {
	// The detail is what the operator acts on, so it is carried through verbatim: still sitting on
	// a login screen and "the runner stopped answering" call for different next moves.
	let closed = 0;
	const out = await completeSignin(
		"mac1",
		"Yarn",
		() => FLEET,
		async () => ({ ready: false, detail: 'on screen instead: "Continue with Google"' }),
		async () => {
			closed++;

			return { closed: true, detail: "closed the screen share" };
		},
	);

	assert.equal(out.ok, false);
	assert.equal(closed, 0, "a share the operator may still need must not be taken away");
	assert.match(out.message, /Continue with Google/);
});

test("completeSignin__ReportsTheReason__When__TheHostIsNotInTheInventory", async () => {
	const out = await completeSignin("mac9", "Yarn", () => FLEET, async () => {
		throw new Error("should not have been asked");
	});

	assert.equal(out.ok, false);
	assert.match(out.message, /unknown host "mac9"/);
});
