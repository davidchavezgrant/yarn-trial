import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	dispatch,
	dispatchNotes,
	follow,
	pull,
	remoteApps,
	type RemoteStream,
	stopRemote,
	type StreamRunner,
	signinRemedy,
} from "../src/remote/control/dispatch.js";
import type { SshRunner } from "../src/remote/control/ssh.js";
import type { HostEntry } from "../src/remote/control/hosts.js";
import { decodeSpec, type SshResult } from "../src/remote/control/ssh.js";
import { host, inventory, tempDir } from "./fixtures.js";

/**
 * The dispatch client, offline by construction: every ssh call, every rsync and every log
 * stream is an injected function, and the only filesystem writes go to a temp dir. Nothing
 * here may contact a real Mac — three of them are live, one operator's stray test submit
 * takes a machine out of the fleet for however long the run lasts.
 */

const FLEET = inventory(host("mac1", "10.0.0.1"), host("mac2", "10.0.0.2"), host("mac3", "10.0.0.3"));

function ok(body: Record<string, unknown>): SshResult {
	return { code: 0, stdout: `${JSON.stringify({ ok: true, ...body })}\n`, stderr: "" };
}

/** How `runnerctl` reports a refusal: exit 1, the frame on stdout, the reason on stderr. */
function refused(body: Record<string, unknown>): SshResult {
	return { code: 1, stdout: `${JSON.stringify({ ok: false, ...body })}\n`, stderr: `${String(body.error ?? "refused")}\n` };
}

/** The subcommand out of a `runnerctl` argv, which is always `[bin, sub, --json, ...]`. */
function subcommand(argv: string[]): string {
	return argv[1];
}

function specOf(argv: string[]): any {
	const at = argv.indexOf("--spec");

	return at < 0 ? undefined : decodeSpec(argv[at + 1]);
}

/**
 * Spread into every `dispatch` below. Without it `dispatch` calls the real `autoSync`, which
 * rsyncs the appmap directory to every host in the inventory — the 10.0.0.x addresses here are
 * not the fleet, but they are still outbound connections that sit until they time out. That is
 * both what the header above forbids and why this file took ~9s per dispatch test.
 */
const noSync = { sync: async () => undefined };

function recorder(reply: (host: HostEntry, argv: string[]) => SshResult): { run: SshRunner; calls: { host: string; argv: string[] }[] } {
	const calls: { host: string; argv: string[] }[] = [];

	return {
		calls,
		run: async (h, argv) => {
			calls.push({ host: h.name, argv });

			return reply(h, argv);
		},
	};
}

/**
 * A task string that is also a small shell program. Every byte of it has to reach agent.ts
 * unchanged: `auditTaskPrompt` there is the single authoritative gate on what a task may say
 * (CLAUDE.md, "Measurement rule"), and a dispatcher that trimmed or re-quoted en route would
 * be a second copy of that rule — one that can disagree with the first.
 */
const HOSTILE_TASK = `  show me how to "change" the $HOME cursor; rm -rf /\n\`id\` && echo 'done'  `;

test("dispatch__SendsTaskVerbatim__When__TaskContainsShellMetacharacters", async () => {
	const { run, calls } = recorder(() => ok({ jobId: "2026-07-30T12-00-00-yarn", pid: 4242, artifacts: { log: "out/jobs/2026-07-30T12-00-00-yarn/log.txt" } }));
	const result = await dispatch({ host: "mac2", app: "  Yarn  ", task: HOSTILE_TASK, record: true, operator: "david", inventory: FLEET, run, ...noSync });

	assert.equal(result.ok, true);
	assert.equal(calls.length, 1);
	assert.equal(subcommand(calls[0].argv), "submit");

	const spec = specOf(calls[0].argv);
	// Byte for byte, leading and trailing whitespace included.
	assert.equal(spec.task, HOSTILE_TASK);
	assert.equal(spec.app, "  Yarn  ", "the app name was normalised locally as well as remotely");
	assert.equal(spec.record, true);
	assert.equal(spec.operator, "david");

	// And none of it reached an argv position. sshd joins the remote arguments into one string
	// for a login shell, so a metacharacter anywhere in this array is a command on the far side.
	for (const arg of calls[0].argv)
		for (const meta of [";", "`", "$", "|", "&", "\n", "'", '"', ">", "<", "*", "(", ")"])
			assert.equal(arg.includes(meta), false, `argv entry ${JSON.stringify(arg)} carries ${meta}`);
});

test("dispatch__CarriesEveryArmFlagInTheSpec__When__BenchmarkOptionsAreSet", async () => {
	// The bench orchestrator's contract: these exact option names, crossing as base64 spec
	// fields — never argv text — and reaching the runner as typed booleans/strings.
	const { run, calls } = recorder(() => ok({ jobId: "j-arm", pid: 7, artifacts: { log: "out/jobs/j-arm/log.txt" } }));
	const result = await dispatch({
		host: "mac2",
		app: "Yarn",
		task: "show me how to change the cursor type",
		backend: "cdp",
		noAx: true,
		axdomOff: true,
		noGrounding: true,
		useCurated: true,
		inventory: FLEET,
		run,
		...noSync,
	});

	assert.equal(result.ok, true);
	const spec = specOf(calls[0].argv);
	assert.equal(spec.backend, "cdp");
	assert.equal(spec.noAx, true);
	assert.equal(spec.axdomOff, true);
	assert.equal(spec.noGrounding, true);
	assert.equal(spec.useCurated, true);
	// Booleans, not strings: the runner's flag() gate refuses "true"/"false" by design.
	for (const key of ["noAx", "axdomOff", "noGrounding", "useCurated", "record", "noVision", "noRescue"]) assert.equal(typeof spec[key], "boolean", key);
	// And none of it landed on an argv position.
	assert.equal(calls[0].argv.includes("--backend"), false);
	assert.equal(calls[0].argv.includes("cdp"), false);
});

test("dispatch__SendsAbsentFlagsAsFalse__When__NoArmIsAsked", async () => {
	const { run, calls } = recorder(() => ok({ jobId: "j-plain", pid: 7, artifacts: { log: "out/jobs/j-plain/log.txt" } }));
	const result = await dispatch({ host: "mac2", app: "Yarn", task: "t", inventory: FLEET, run, ...noSync });

	assert.equal(result.ok, true);
	const spec = specOf(calls[0].argv);
	// `backend` stays off the wire entirely, so the child CLI's own default decides.
	assert.equal("backend" in spec, false);
	assert.equal("procedure" in spec, false);
	assert.equal(spec.noAx, false);
	assert.equal(spec.axdomOff, false);
	assert.equal(spec.noGrounding, false);
	assert.equal(spec.useCurated, false);
});

test("dispatch__CarriesCleanupOffInTheSpec__When__CleanupOffIsAsked", async () => {
	// Cleanup crosses as a NAMED spec field the runner validates — never argv text, never a
	// generic env dict (the appmapVariant rationale in DispatchOptions).
	const { run, calls } = recorder(() => ok({ jobId: "j-cleanup", pid: 7, artifacts: { log: "out/jobs/j-cleanup/log.txt" } }));
	const result = await dispatch({ host: "mac2", app: "Yarn", task: "t", cleanup: "off", inventory: FLEET, run, ...noSync });

	assert.equal(result.ok, true);
	const spec = specOf(calls[0].argv);
	assert.equal(spec.cleanup, "off");
	assert.equal(calls[0].argv.includes("--no-cleanup"), false, "cleanup rides the spec, not an argv position");
});

test("dispatch__LeavesCleanupOffTheWire__When__ItIsNotAsked", async () => {
	const { run, calls } = recorder(() => ok({ jobId: "j-plain", pid: 7, artifacts: { log: "out/jobs/j-plain/log.txt" } }));
	await dispatch({ host: "mac2", app: "Yarn", task: "t", inventory: FLEET, run, ...noSync });

	// Absent entirely, like backend: the child's own default (advisory) decides.
	assert.equal("cleanup" in specOf(calls[0].argv), false);
});

test("dispatch__RelaysTheRunnersRefusal__When__CleanupValueIsInvalid", async () => {
	// The client neither validates the value (the runner owns that rule; a second copy here
	// could drift) nor DROPS it — a silently dropped option would run teardown over a filmed
	// take. It crosses verbatim, and the runner's typed refusal comes back as the error.
	const { run, calls } = recorder(() => refused({ error: `cleanup must be "off" when present, got "block"` }));
	const result = await dispatch({ host: "mac2", app: "Yarn", task: "t", cleanup: "block" as any, inventory: FLEET, run, ...noSync });

	assert.equal(specOf(calls[0].argv).cleanup, "block", "the invalid value crossed for the runner to refuse, not silently vanished");
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error, /cleanup must be "off"/);
});

test("dispatch__CarriesBothStoppingConditionsInTheSpec__When__AnArmTunesThem", async () => {
	// A run ends three ways: success, `stalled` after N consecutive steps with nothing verified,
	// or the runaway backstop — and the backstop is not supposed to be reachable at all. Only the
	// backstop was tunable down the wire, so an arm could adjust the guard it must never hit and
	// not the condition it actually ends on. Both cross as named numeric spec fields now.
	const { run, calls } = recorder(() => ok({ jobId: "j-stall", pid: 9, artifacts: { log: "out/jobs/j-stall/log.txt" } }));
	const result = await dispatch({ host: "mac2", app: "Yarn", task: "show me how to change the cursor type", steps: 250, stallSteps: 12, inventory: FLEET, run, ...noSync });

	assert.equal(result.ok, true);
	const spec = specOf(calls[0].argv);
	assert.equal(spec.stallSteps, 12);
	assert.equal(spec.steps, 250, "a backstop above the old 100 clamp still crosses; the runner owns the range");
	// Numbers, not strings: the runner type-checks both before it spends the lease.
	for (const key of ["steps", "stallSteps"]) assert.equal(typeof spec[key], "number", key);
	// And neither reached an argv position — same rule as every other arm field.
	for (const arg of ["--stall-steps", "--steps", "12", "250"]) assert.equal(calls[0].argv.includes(arg), false, `${arg} rides the spec, not the argv`);
});

test("dispatch__LeavesBothStoppingConditionsOffTheWire__When__NeitherIsAsked", async () => {
	const { run, calls } = recorder(() => ok({ jobId: "j-plain", pid: 7, artifacts: { log: "out/jobs/j-plain/log.txt" } }));
	await dispatch({ host: "mac2", app: "Yarn", task: "t", inventory: FLEET, run, ...noSync });

	// Absent entirely rather than sent as a zero: the child's own defaults (100 and 8) decide, and
	// a zero in either field is the one value that would end every run instantly.
	const spec = specOf(calls[0].argv);
	assert.equal("steps" in spec, false);
	assert.equal("stallSteps" in spec, false);
});

test("dispatch__StillSendsAZero__When__AStoppingConditionIsAskedForAsZero", async () => {
	// `steps` was threaded with a truthy check while every neighbouring number used `!== undefined`,
	// so a 0 vanished on the client instead of being refused on the runner. The values are equally
	// invalid either way; the difference is whether the operator gets a typed error or an arm that
	// quietly ran with the child's default — which is exactly how useRecipes lost 12 runs.
	const { run, calls } = recorder(() => refused({ error: "steps must be an integer 1..1000, got 0" }));
	const result = await dispatch({ host: "mac2", app: "Yarn", task: "t", steps: 0, stallSteps: 0, inventory: FLEET, run, ...noSync });

	const spec = specOf(calls[0].argv);
	assert.equal(spec.steps, 0, "the invalid value crossed for the runner to refuse, not silently vanished");
	assert.equal(spec.stallSteps, 0);
	assert.equal(result.ok, false);
});

test("dispatch__SyncsProceduresBeforeTheSubmit__When__TheKindIsReplay", async () => {
	// The runner refuses a replay whose procedure file is absent, so the fan-out must land the
	// file before the submit asks — order is the property under test.
	const order: string[] = [];
	const { run } = recorder((_h, argv) => {
		order.push(subcommand(argv));

		return ok({ jobId: "replay-j1", pid: 7, artifacts: { log: "out/jobs/replay-j1/log.txt" } });
	});
	const result = await dispatch({
		host: "mac2",
		kind: "replay",
		app: "Yarn",
		procedure: "docs/procedures/yarn.abc123.procedure.json",
		noRescue: true,
		inventory: FLEET,
		run,
		sync: async () => {
			order.push("appmap-sync");

			return undefined;
		},
		syncProcedures: async () => {
			order.push("procedure-sync");

			return "procedures: yarn.abc123.procedure local → mac2 (missing)";
		},
	});

	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(order, ["procedure-sync", "appmap-sync", "submit"]);
	// The fan-out's note reaches the operator like the appmap one does.
	assert.equal(result.syncNote, "procedures: yarn.abc123.procedure local → mac2 (missing)");
});

test("dispatch__PutsProcedureAndNoRescueInTheSpec__When__TheKindIsReplay", async () => {
	const { run, calls } = recorder(() => ok({ jobId: "replay-j1", pid: 7, artifacts: { log: "out/jobs/replay-j1/log.txt" } }));
	const result = await dispatch({
		host: "mac2",
		kind: "replay",
		app: "Yarn",
		procedure: "docs/procedures/yarn.abc123.procedure.json",
		noRescue: true,
		inventory: FLEET,
		run,
		...noSync,
		syncProcedures: async () => undefined,
	});

	assert.equal(result.ok, true);
	assert.equal(result.ok && result.kind, "replay");
	const spec = specOf(calls[0].argv);
	assert.equal(spec.kind, "replay");
	// Relative, exactly as given: the runner resolves it against ITS data root and owns the
	// path-discipline check — nothing here rewrites or absolutises it.
	assert.equal(spec.procedure, "docs/procedures/yarn.abc123.procedure.json");
	assert.equal(spec.noRescue, true);
});

test("dispatch__RefusesLocally__When__AReplayNamesNoProcedure", async () => {
	await assert.rejects(
		() => dispatch({ host: "mac1", kind: "replay", app: "Yarn", inventory: FLEET, run: async () => ok({}), ...noSync, syncProcedures: async () => undefined }),
		/needs a procedure path/,
	);
});

test("dispatch__RelaysTheProfileSwapAndPredictsASignin__When__TheOperatorIsNewToTheApp", async () => {
	// The moment a teammate learns they have to sign in. The runner knows at submit time —
	// it just swapped in a profile with nothing in it — and saying so here saves them watching
	// a run fail on the readiness guard several minutes later.
	const { run } = recorder(() =>
		ok({
			jobId: "2026-07-30T12-00-00-yarn",
			pid: 4242,
			artifacts: {},
			profile: "profile: Yarn swapped david → jasper, parked 3 path(s), no stored profile — the app will need signing in",
			signinNeeded: true,
		}),
	);
	const result = await dispatch({ host: "mac2", app: "Yarn", task: "show me how to change the cursor type", operator: "jasper", inventory: FLEET, run, ...noSync });
	assert.equal(result.ok, true);
	if (!result.ok) return;

	assert.match(result.profile ?? "", /david → jasper/);
	assert.equal(result.signinNeeded, true);

	const notes = dispatchNotes(result);
	assert.equal(notes.length, 2, "the swap and the sign-in are separate facts and both matter");
	// A runnable command, not a suggestion: the host and the app are both known here, and the
	// teammate should not have to reconstruct them.
	assert.equal(notes[1], '↳ sign in once to continue: ./run signin mac2 "Yarn"');
});

test("dispatchNotes__SaysNothingAboutSignin__When__TheRunnerRestoredAProfile", async () => {
	// The returning-teammate case, which is the common one. A sign-in line here would train
	// people to ignore the line, which is worse than not printing it.
	const { run } = recorder(() => ok({ jobId: "j1", pid: 1, artifacts: {}, profile: "profile: jasper already owns Yarn" }));
	const result = await dispatch({ host: "mac2", app: "Yarn", task: "t", operator: "jasper", inventory: FLEET, run, ...noSync });
	assert.equal(result.ok, true);
	if (!result.ok) return;

	assert.equal(result.signinNeeded, undefined);
	assert.deepEqual(dispatchNotes(result), ["profile: jasper already owns Yarn"]);
});

test("dispatchNotes__IsEmpty__When__TheRunnerReportedNothingWorthSaying", async () => {
	// An older runner, before profiles existed, replies without either field. The client is
	// deployed independently of the fleet, so it must stay silent rather than print undefined.
	const { run } = recorder(() => ok({ jobId: "j1", pid: 1, artifacts: {} }));
	const result = await dispatch({ host: "mac2", app: "Yarn", task: "t", operator: "jasper", inventory: FLEET, run, ...noSync });
	assert.equal(result.ok, true);
	if (!result.ok) return;

	assert.deepEqual(dispatchNotes(result), []);
});

test("dispatch__TriesNextIdleHost__When__FirstHostLostTheClaimRace", async () => {
	// pickIdleHost is advisory by design: the window between the status poll and the submit is
	// a full round trip, and another operator claiming the machine inside it is the expected
	// case, not an error. Losing it must cost one extra round trip, not the run.
	const { run, calls } = recorder((h, argv) => {
		if (subcommand(argv) === "status")
			return h.name === "mac2" ? ok({ state: "busy", operator: "jasper", app: "Notion Calendar", elapsedSec: 90 }) : ok({ state: "idle" });
		if (h.name === "mac1") return refused({ error: "busy: jasper, task Yarn, 4s", busy: true, operator: "jasper", app: "Yarn", kind: "task", jobId: "j-1", elapsedSec: 4 });

		return ok({ jobId: "j-2", pid: 7, artifacts: { log: "out/jobs/j-2/log.txt" } });
	});

	const result = await dispatch({ host: "auto", app: "Yarn", task: "show me how to change the cursor type", inventory: FLEET, run, ...noSync });

	assert.equal(result.ok, true);
	assert.equal(result.ok && result.host.name, "mac3", "the busy host was not skipped");
	assert.equal(result.ok && result.jobId, "j-2");
	assert.deepEqual(result.ok && result.attempts.map((a) => a.host), ["mac1"]);
	assert.equal(result.ok && result.attempts[0].busy?.operator, "jasper");
	assert.equal(result.ok && result.attempts[0].busy?.elapsedSec, 4);
	// mac2 was busy in the poll and is never asked; mac3 is asked only after mac1 refuses.
	assert.deepEqual(calls.filter((c) => subcommand(c.argv) === "submit").map((c) => c.host), ["mac1", "mac3"]);
});

test("dispatch__RefusesWithHolderDetails__When__WholeFleetIsBusyAndQueueingIsDeclined", async () => {
	// "no host available" is unactionable. Who has it and for how long is what tells an
	// operator whether to wait two minutes or go and ask someone. `queue: false` is the
	// caller saying it wants that refusal rather than a place in line.
	const { run, calls } = recorder((h) =>
		h.name === "mac3" ? { code: 255, stdout: "", stderr: "ssh: connect to host 10.0.0.3 port 22: Operation timed out\n" } : ok({ state: "busy", operator: h.name === "mac1" ? "david" : "jasper", app: "Yarn", elapsedSec: 1800 }),
	);

	const result = await dispatch({ host: "auto", app: "Yarn", task: "anything", queue: false, inventory: FLEET, run, ...noSync });

	assert.equal(result.ok, false);
	assert.equal(!result.ok && result.attempts.length, 3);
	assert.equal(!result.ok && result.attempts[0].busy?.operator, "david");
	assert.equal(!result.ok && result.attempts[1].busy?.operator, "jasper");
	assert.match(!result.ok ? (result.attempts[2].reason ?? "") : "", /Operation timed out/);
	assert.equal(calls.some((c) => subcommand(c.argv) === "submit"), false, "a submit was sent to a fleet with no idle host");
});

test("dispatch__QueuesOnTheShortestLine__When__WholeFleetIsBusy", async () => {
	// The default. mac1 already has one job waiting; mac2 is busy with an empty line, so the
	// submit goes there — with the queue flag, which is what turns the lease's refusal into a
	// place in line.
	const { run, calls } = recorder((h, argv) => {
		if (subcommand(argv) === "status") {
			if (h.name === "mac1") return ok({ state: "busy", operator: "david", app: "Yarn", elapsedSec: 60, queue: [{ jobId: "waiting-1", operator: "eve", app: "Yarn", kind: "task" }] });
			if (h.name === "mac2") return ok({ state: "busy", operator: "jasper", app: "Yarn", elapsedSec: 1800 });

			return { code: 255, stdout: "", stderr: "ssh: connect to host 10.0.0.3 port 22: Operation timed out\n" };
		}

		return ok({ jobId: "j-q", queued: true, position: 1, artifacts: { log: "out/jobs/j-q/log.txt" }, behind: { operator: "jasper", app: "Yarn", kind: "task", jobId: "j-running", elapsedSec: 1800 } });
	});

	const result = await dispatch({ host: "auto", app: "Yarn", task: "anything", inventory: FLEET, run, ...noSync });

	assert.equal(result.ok, true);
	assert.equal(result.ok && result.host.name, "mac2", "the shorter line wins");
	assert.equal(result.ok && result.queued, true);
	assert.equal(result.ok && result.position, 1);
	assert.equal(result.ok && result.behind?.operator, "jasper");
	const submits = calls.filter((c) => subcommand(c.argv) === "submit");
	assert.deepEqual(submits.map((c) => c.host), ["mac2"]);
	// The queue flag crossed inside the spec: without it the busy lease refuses.
	assert.equal(specOf(submits[0].argv).queue, true);
});

test("dispatch__AsksIdleHostsWithoutTheQueueFlag__When__QueueingIsWanted", async () => {
	// Losing the advisory race on an idle host must mean "ask the NEXT idle host", not "join
	// the first one's line while a free Mac sits below it" — so the walk itself never queues.
	const { run, calls } = recorder((h, argv) => {
		if (subcommand(argv) === "status") return h.name === "mac2" ? ok({ state: "busy", operator: "jasper", app: "Yarn", elapsedSec: 90 }) : ok({ state: "idle" });
		if (h.name === "mac1") return refused({ error: "busy: jasper, task Yarn, 4s", busy: true, operator: "jasper", app: "Yarn", kind: "task", jobId: "j-1", elapsedSec: 4 });

		return ok({ jobId: "j-2", pid: 7, artifacts: { log: "out/jobs/j-2/log.txt" } });
	});

	const result = await dispatch({ host: "auto", app: "Yarn", task: "anything", inventory: FLEET, run, ...noSync });

	assert.equal(result.ok, true);
	assert.equal(result.ok && result.host.name, "mac3");
	assert.equal(result.ok && result.queued, undefined);
	for (const c of calls.filter((c) => subcommand(c.argv) === "submit"))
		assert.notEqual(specOf(c.argv)?.queue, true, `the idle walk queued on ${c.host}`);
});

test("dispatch__QueuesOnTheNamedHost__When__ItIsBusy", async () => {
	// A named host is a decision already made; busy means wait there, not refuse.
	const { run } = recorder((_h, argv) =>
		subcommand(argv) === "status"
			? ok({ state: "busy", operator: "david", app: "Yarn", elapsedSec: 60 })
			: ok({ jobId: "j-q", queued: true, position: 2, artifacts: { log: "out/jobs/j-q/log.txt" } }),
	);

	const result = await dispatch({ host: "mac1", app: "Yarn", task: "anything", inventory: FLEET, run, ...noSync });

	assert.equal(result.ok, true);
	assert.equal(result.ok && result.queued, true);
	assert.equal(result.ok && result.position, 2);
});

test("dispatch__RefusesWithoutALocalFallback__When__AutoFindsNoIdleHost", async () => {
	// `auto` walks the inventory and ONLY the inventory. With zero idle fleet hosts the answer
	// is a refusal — never a run on the operator's own Mac, which would put an agent loose on
	// the machine they are sitting at because a colo box happened to be rebooting.
	const { run, calls } = recorder(() => ({ code: 255, stdout: "", stderr: "ssh: connect to host port 22: Operation timed out\n" }));

	const result = await dispatch({ host: "auto", app: "Yarn", task: "t", inventory: FLEET, run, ...noSync });

	assert.equal(result.ok, false);
	assert.match(!result.ok ? result.error : "", /no idle host in the fleet/);
	assert.equal(calls.some((c) => subcommand(c.argv) === "submit"), false, "something was submitted somewhere with no idle host");
	// Every wire call went to an inventory host; nothing ever addressed this machine.
	for (const c of calls) assert.ok(FLEET.hosts.some((h) => h.name === c.host), `${c.host} is not in the inventory`);
});

test("dispatch__StopsTrying__When__SubmitOutcomeIsUnknown", async () => {
	// A submit that timed out may have started a run we can no longer see. Falling through to
	// the next Mac would then have two agents driving two machines with one of them invisible,
	// which is worse than making a human look. Only exit 3 — the remote itself saying nothing
	// was listening — is safe to skip past.
	const { run, calls } = recorder((h, argv) => {
		if (subcommand(argv) === "status") return ok({ state: "idle" });
		if (h.name === "mac1") return { code: 3, stdout: "", stderr: "cannot reach the runner at /Users/x/.yarn-runner/run.sock\n" };

		return { code: 124, stdout: "", stderr: "" };
	});

	const result = await dispatch({ host: "auto", app: "Yarn", task: "anything", inventory: FLEET, run, ...noSync });

	assert.equal(result.ok, false);
	// mac1 had no runner listening, so mac2 was tried; mac2 timed out, so mac3 was not.
	assert.deepEqual(calls.filter((c) => subcommand(c.argv) === "submit").map((c) => c.host), ["mac1", "mac2"]);
	assert.equal(!result.ok && result.attempts[0].fatal, false);
	assert.equal(!result.ok && result.attempts[1].fatal, true);
});

test("dispatch__RefusesLocally__When__AppIsMissing", async () => {
	await assert.rejects(() => dispatch({ host: "mac1", app: "  ", task: "x", inventory: FLEET, run: async () => ok({}) }), /needs an app/);
});

/** One `runnerctl logs --json` frame. */
function frame(body: Record<string, unknown>): string {
	return `${JSON.stringify({ ok: true, ...body })}\n`;
}

function chunkFrame(bytes: Buffer, nextOffset: number, jobId = "j-1"): string {
	return frame({ jobId, chunk: bytes.toString("base64"), nextOffset });
}

function scriptedStream(lines: string[], opts: { exit?: number; onDrained?: () => void } = {}): { stream: StreamRunner; calls: string[][] } {
	const calls: string[][] = [];
	const stream: StreamRunner = (_host, argv): RemoteStream => {
		calls.push(argv);
		let unblock: () => void = () => {};
		const killed = new Promise<void>((resolve) => {
			unblock = resolve;
		});

		return {
			stdout: (async function* () {
				for (const line of lines) yield Buffer.from(line, "utf8");
				if (!opts.onDrained) return;
				// A live follow does not end when the frames stop; it sits there until the job
				// finishes or someone detaches. Reproducing that is the only way to test detach.
				opts.onDrained();
				await killed;
			})(),
			kill: () => unblock(),
			exit: Promise.resolve(opts.exit ?? 0),
		};
	};

	return { stream, calls };
}

test("follow__ResumesWithoutReplay__When__GivenAByteOffset", async () => {
	// The operator's laptop closing its lid must not end a 40-minute grounding pass, and
	// re-attaching must not reprint the 400 bytes already on screen. The offset is the whole
	// contract: it goes out in the request and comes back updated with every frame.
	const { stream, calls } = scriptedStream([
		chunkFrame(Buffer.from("action 12: click\n"), 417),
		frame({ jobId: "j-1", done: true, nextOffset: 417, state: "done", exitCode: 0 }),
	]);

	const seen: string[] = [];
	const result = await follow(host("mac1", "10.0.0.1"), "j-1", (t) => seen.push(t), { fromByte: 400, stream });

	const spec = specOf(calls[0]);
	assert.equal(subcommand(calls[0]), "logs");
	assert.equal(spec.fromByte, 400);
	assert.equal(spec.follow, true);
	assert.equal(spec.jobId, "j-1");
	assert.equal(seen.join(""), "action 12: click\n", "the log before the offset was replayed");
	assert.equal(result.nextOffset, 417);
	assert.equal(result.done, true);
	assert.equal(result.state, "done");
	assert.equal(result.exitCode, 0);
});

test("follow__DecodesWholeCharacter__When__ChunkBoundarySplitsUtf8", async () => {
	// Offsets are byte offsets into the remote log, so a poll boundary lands mid-character
	// whenever the agent prints one — and it does: the step lines are full of arrows. Decoding
	// each chunk on its own turns every such arrow into two replacement characters.
	const arrow = Buffer.from("→", "utf8");
	assert.equal(arrow.length, 3, "the fixture is only meaningful for a multi-byte character");

	const { stream } = scriptedStream([
		chunkFrame(Buffer.concat([Buffer.from("step 3 "), arrow.subarray(0, 2)]), 9),
		chunkFrame(Buffer.concat([arrow.subarray(2), Buffer.from(" done\n")]), 16),
		frame({ jobId: "j-1", done: true, nextOffset: 16, state: "done", exitCode: 0 }),
	]);

	const seen: string[] = [];
	await follow(host("mac1", "10.0.0.1"), "j-1", (t) => seen.push(t), { stream });

	assert.equal(seen.join(""), "step 3 → done\n");
	assert.equal(seen.join("").includes("�"), false, "a character was decoded in halves");
});

test("follow__RewindsOffset__When__DetachingMidCharacter", async () => {
	// Bytes still held by the decoder have already been counted in the remote's nextOffset.
	// Resuming from it as-is would skip them and corrupt exactly one character on re-attach,
	// so the held bytes are handed back and re-read next time.
	const arrow = Buffer.from("→", "utf8");
	const controller = new AbortController();
	const { stream } = scriptedStream([chunkFrame(Buffer.concat([Buffer.from("half "), arrow.subarray(0, 2)]), 107)], {
		exit: 143,
		onDrained: () => controller.abort(),
	});

	const seen: string[] = [];
	const result = await follow(host("mac1", "10.0.0.1"), "j-1", (t) => seen.push(t), { fromByte: 100, stream, signal: controller.signal });

	assert.equal(result.done, false, "detaching is not the job finishing");
	assert.equal(seen.join(""), "half ", "an incomplete character was emitted");
	assert.equal(result.nextOffset, 105, "the two held bytes were not given back");
	assert.equal(result.error, undefined, "a detach was reported as a transport failure");
});

test("follow__ReportsRefusal__When__RemoteHasNoSuchJob", async () => {
	const { stream } = scriptedStream([`${JSON.stringify({ ok: false, error: "no jobs on this host" })}\n`], { exit: 1 });
	const result = await follow(host("mac1", "10.0.0.1"), undefined, () => {}, { stream });

	assert.equal(result.done, false);
	assert.equal(result.error, "no jobs on this host");
	assert.equal(result.nextOffset, 0);
});

test("follow__SurvivesLoginBanner__When__HostPrintsNonJsonFirst", async () => {
	// Every Mac in the fleet can grow a MOTD without anyone telling us. A banner on stdout
	// must cost nothing: the frames after it are still frames.
	const { stream } = scriptedStream(["Last login: Tue Jul 30 09:14:02 2026\n", chunkFrame(Buffer.from("go\n"), 3), frame({ jobId: "j-1", done: true, nextOffset: 3, state: "done", exitCode: 0 })]);
	const seen: string[] = [];
	const result = await follow(host("mac1", "10.0.0.1"), "j-1", (t) => seen.push(t), { stream });

	assert.equal(seen.join(""), "go\n");
	assert.equal(result.done, true);
});

function jobFrame(over: Record<string, unknown> = {}): SshResult {
	return ok({
		job: {
			id: "2026-07-30T12-00-00-yarn",
			kind: "task",
			app: "Yarn",
			task: HOSTILE_TASK,
			operator: "david",
			state: "done",
			pid: 91,
			startedAt: "2026-07-30T12:00:00.000Z",
			artifacts: {
				log: "out/bench/live/2026-07-30T12-00-00-yarn/log.txt",
				runLog: "out/bench/live/2026-07-30T12-00-00-yarn/run.json",
				recording: "out/bench/live/2026-07-30T12-00-00-yarn/recording/window.mp4",
			},
			...over,
		},
	});
}

test("pull__WritesUnderTheSameKey__When__JobProducedArtifacts", async () => {
	// The job id IS the artifact key, on both machines, and since the 2026-08-01 consolidation
	// it names ONE directory rather than three siblings to keep correlated. That is the whole
	// point of the change: the previous shape needed a five-way fan-out of declared and derived
	// paths, and the derived branch (step frames) went missing long enough to blank the offline
	// judge's VISUAL channel for an entire matrix. A directory cannot forget its own contents.
	const dest = tempDir("yarn-dispatch-");
	try {
		const run: SshRunner = async (_h, argv) => (subcommand(argv) === "job" ? jobFrame() : ok({ dataRoot: "/Users/administrator/yarn-trial" }));
		const invocations: string[][] = [];
		const result = await pull(host("mac1", "10.0.0.1"), "2026-07-30T12-00-00-yarn", {
			run,
			dest,
			rsync: async (file, argv) => {
				assert.equal(file, "rsync");
				invocations.push(argv);

				return { code: 0, stdout: "", stderr: "" };
			},
		});

		assert.equal(result.ok, true);
		// One source, and it is a directory — the run log, the console log, the step frames the
		// judge needs and the recording all ride inside it with no path to forget.
		assert.deepEqual(result.artifacts.map((a) => a.key), ["run"]);
		assert.deepEqual(result.artifacts.map((a) => a.rel), ["out/bench/live/2026-07-30T12-00-00-yarn"]);
		for (const a of result.artifacts) assert.equal(a.local.startsWith(dest), true, `${a.local} landed outside the data root`);

		for (const argv of invocations) {
			// A partial transfer must never be renamed over a local file: --partial-dir keeps
			// the fragment aside, and --inplace would defeat rsync's own temp-and-rename.
			assert.equal(argv.includes("--partial-dir=.rsync-partial"), true);
			assert.equal(argv.includes("--inplace"), false);
			const shell = argv[argv.indexOf("-e") + 1];
			assert.match(shell, /^ssh /);
			assert.equal(shell.includes("administrator@10.0.0.1"), false, "the -e command carries the destination");
			assert.match(shell, /StrictHostKeyChecking=yes/);
			assert.match(shell, /IdentitiesOnly=yes/);
		}
		// Pulled as a directory — the trailing slash is what makes rsync copy the CONTENTS into
		// the matching local directory rather than nesting it one level deeper.
		assert.equal(invocations[0][invocations[0].length - 2], "administrator@10.0.0.1:/Users/administrator/yarn-trial/out/bench/live/2026-07-30T12-00-00-yarn/");
	} finally {
		fs.rmSync(dest, { recursive: true, force: true });
	}
});

test("pull__FetchesBothAppmapHalves__When__JobWasAGroundingPass", async () => {
	// The appmap is the one artifact that does NOT live in the run directory: it is a durable
	// input at a stable path, keyed by app rather than by run, and every later task run reads
	// it from there. So it stays a separate pull source even after the consolidation.
	//
	// JobArtifacts records the prose half only, but explore writes a .json graph beside it and
	// that is what scopeWarnings() reads. Leaving it on the colo Mac lands an appmap whose
	// scope-collision warnings are silently off — the failure that lets an agent change a
	// per-document override instead of the brand default.
	const dest = tempDir("yarn-dispatch-");
	try {
		const run: SshRunner = async (_h, argv) =>
			subcommand(argv) === "job"
				? jobFrame({
						id: "explore-2026-07-30T12-00-00-yarn",
						kind: "explore",
						artifacts: { log: "out/bench/live/explore-2026-07-30T12-00-00-yarn/log.txt", appmap: "docs/appmaps/yarn.md", checkpoint: "out/bench/live/explore-2026-07-30T12-00-00-yarn/checkpoint.json" },
					})
				: ok({ dataRoot: "/Users/administrator/yarn-trial" });

		const result = await pull(host("mac1", "10.0.0.1"), "explore-2026-07-30T12-00-00-yarn", {
			run,
			dest,
			rsync: async (_f, argv) => (argv.some((a) => a.endsWith("yarn.json")) ? { code: 23, stdout: "", stderr: 'rsync: link_stat "/Users/administrator/yarn-trial/docs/appmaps/yarn.json" failed: No such file or directory (2)\n' } : { code: 0, stdout: "", stderr: "" }),
		});

		assert.deepEqual(result.artifacts.map((a) => a.key), ["run", "appmap", "appmapGraph"]);
		assert.equal(result.artifacts.find((a) => a.key === "appmapGraph")?.rel, "docs/appmaps/yarn.json");
		// An absent source is a fact about the run, not a broken pull: a task run has no
		// appmap and an explore run has no run log, every single time.
		assert.equal(result.artifacts.find((a) => a.key === "appmapGraph")?.state, "missing");
		assert.equal(result.ok, true);
	} finally {
		fs.rmSync(dest, { recursive: true, force: true });
	}
});

test("pull__FetchesTheOldScatteredPaths__When__TheRecordPredatesTheConsolidation", async () => {
	// A job record outlives a layout change. This one was written before 2026-08-01, when a run
	// was three sibling trees, and pulling it must still bring every piece home — the journal
	// especially, since that is what `npm run cleanup` replays after a crashed replay; leaving
	// it on the Mac brings home a run log that says what happened and nothing that says what to
	// undo.
	//
	// The record says which layout it belongs to: `log` is the field every job kind declares,
	// and here it points outside out/live, so the derived legacy sources come along too.
	const dest = tempDir("yarn-dispatch-");
	try {
		const run: SshRunner = async (_h, argv) =>
			subcommand(argv) === "job"
				? jobFrame({
						id: "replay-2026-07-31T12-00-00-000-yarn",
						kind: "replay",
						artifacts: {
							log: "out/jobs/replay-2026-07-31T12-00-00-000-yarn/log.txt",
							runLog: "out/runs/replay-2026-07-31T12-00-00-000-yarn.json",
							journal: "out/runs/replay-2026-07-31T12-00-00-000-yarn.journal.jsonl",
						},
					})
				: ok({ dataRoot: "/Users/administrator/yarn-trial" });

		const result = await pull(host("mac1", "10.0.0.1"), "replay-2026-07-31T12-00-00-000-yarn", {
			run,
			dest,
			// A replay that mutated nothing writes no journal; that is a `missing`, not a failure.
			rsync: async (_f, argv) => (argv.some((a) => a.endsWith(".journal.jsonl")) ? { code: 23, stdout: "", stderr: 'rsync: link_stat "...journal.jsonl" failed: No such file or directory (2)\n' } : { code: 0, stdout: "", stderr: "" }),
		});

		assert.deepEqual(result.artifacts.map((a) => a.key), ["run", "job", "runLog", "stepFrames", "journal"]);
		assert.equal(result.artifacts.find((a) => a.key === "journal")?.rel, "out/runs/replay-2026-07-31T12-00-00-000-yarn.journal.jsonl");
		assert.equal(result.artifacts.find((a) => a.key === "journal")?.state, "missing");
		assert.equal(result.ok, true);
	} finally {
		fs.rmSync(dest, { recursive: true, force: true });
	}
});

test("pull__Refuses__When__RemotePathIsNotShellSafe", async () => {
	// rsync hands the remote path to a login shell, and unlike everything else here it cannot
	// be base64'd — the path is the protocol. So an unexpected data root is refused rather
	// than quoted.
	const dest = tempDir("yarn-dispatch-");
	try {
		const run: SshRunner = async (_h, argv) => (subcommand(argv) === "job" ? jobFrame() : ok({ dataRoot: "/Users/administrator/$(id)/yarn trial" }));
		let ran = false;

		await assert.rejects(
			() => pull(host("mac1", "10.0.0.1"), "2026-07-30T12-00-00-yarn", { run, dest, rsync: async () => { ran = true; return { code: 0, stdout: "", stderr: "" }; } }),
			/refusing to rsync/,
		);
		assert.equal(ran, false);
	} finally {
		fs.rmSync(dest, { recursive: true, force: true });
	}
});

test("pull__Refuses__When__SshOptionsCannotSurviveRsyncArgSplitting", async () => {
	// rsync splits -e on whitespace and does no unquoting, so a runner home with a space in it
	// silently becomes two arguments and ssh is handed a key path that does not exist.
	const dest = tempDir("yarn-dispatch-");
	const prev = process.env.YARN_RUNNER_HOME;
	process.env.YARN_RUNNER_HOME = path.join(dest, "runner home");
	try {
		const run: SshRunner = async (_h, argv) => (subcommand(argv) === "job" ? jobFrame() : ok({ dataRoot: "/Users/administrator/yarn-trial" }));

		await assert.rejects(() => pull(host("mac1", "10.0.0.1"), "2026-07-30T12-00-00-yarn", { run, dest, rsync: async () => ({ code: 0, stdout: "", stderr: "" }) }), /whitespace/);
	} finally {
		if (prev === undefined) delete process.env.YARN_RUNNER_HOME;
		else process.env.YARN_RUNNER_HOME = prev;
		fs.rmSync(dest, { recursive: true, force: true });
	}
});

test("pull__ReportsFailure__When__RsyncCannotReachTheHost", async () => {
	const dest = tempDir("yarn-dispatch-");
	try {
		const run: SshRunner = async (_h, argv) => (subcommand(argv) === "job" ? jobFrame() : ok({ dataRoot: "/Users/administrator/yarn-trial" }));
		const result = await pull(host("mac1", "10.0.0.1"), "2026-07-30T12-00-00-yarn", {
			run,
			dest,
			rsync: async () => ({ code: 255, stdout: "", stderr: "ssh: connect to host 10.0.0.1 port 22: Operation timed out\nrsync error: unexplained error\n" }),
		});

		assert.equal(result.ok, false);
		assert.equal(result.artifacts.every((a) => a.state === "failed"), true);
		assert.match(result.error ?? "", /Operation timed out/);
	} finally {
		fs.rmSync(dest, { recursive: true, force: true });
	}
});

test("pull__Refuses__When__JobIdIsNotAPathSegment", async () => {
	await assert.rejects(() => pull(host("mac1", "10.0.0.1"), "../../etc", { run: async () => ok({}) }), /unsafe job id/);
});

test("stopRemote__TargetsTheLeaseHolder__When__NoJobIdIsGiven", async () => {
	// The host knows what it is running; making the operator find the id first is how a run
	// that needs stopping keeps going for another two minutes.
	const { run, calls } = recorder(() => ok({ jobId: "j-9", signalled: "SIGINT" }));
	const result = await stopRemote(host("mac1", "10.0.0.1"), undefined, { run });

	assert.equal(result.ok, true);
	assert.equal(result.jobId, "j-9");
	assert.equal(subcommand(calls[0].argv), "stop");
	assert.deepEqual(specOf(calls[0].argv), {});
});

test("stopRemote__ReportsError__When__JobIsUnknown", async () => {
	const { run } = recorder(() => refused({ error: "unknown job j-404" }));
	const result = await stopRemote(host("mac1", "10.0.0.1"), "j-404", { run });

	assert.equal(result.ok, false);
	assert.equal(result.error, "unknown job j-404");
});

test("remoteApps__CarriesTheCaptureStamp__When__TheRunnerReportsOne", async () => {
	// The runner's `apps` verb answers listApps(), so groundedAt arrives free — but this
	// client rebuilds every entry field by field, and a field it does not copy is silently
	// dropped on the way to the renderer. An older runner reports no stamp, and a stamp that
	// is not a string (half-provisioned Mac, older schema) must stay behind.
	const { run } = recorder(() =>
		ok({
			apps: [
				{ name: "Yarn", running: true, grounded: true, groundedAt: "2026-07-27T10:00:00.000Z" },
				{ name: "Notes", running: false, grounded: true },
				{ name: "Weird", running: false, grounded: true, groundedAt: 42 },
			],
		}),
	);
	const list = await remoteApps(host("mac1", "10.0.0.1"), { run });

	assert.equal(list.ok, true);
	assert.equal(list.apps[0].groundedAt, "2026-07-27T10:00:00.000Z");
	assert.equal(list.apps[1].groundedAt, undefined);
	assert.equal(list.apps[2].groundedAt, undefined);
});

// signinRemedy: the second half of the sign-in story. The first half is the `signinNeeded`
// prediction at submit time, which fires only for a brand-new profile — and so said nothing on
// all three colo Macs, whose adopted profiles turned out to be signed out anyway.

test("signinRemedy__NamesTheHostAndApp__When__TheRunRefusedOnReadiness", () => {
	// Fully interpolated: the operator copies one line rather than reconstructing it from the
	// scrollback, and the app is JSON-quoted because "Notion Calendar" is the canonical case.
	assert.equal(signinRemedy(3, "mac2", "Notion Calendar"), '↳ sign in once to continue: ./run signin mac2 "Notion Calendar"');
});

test("signinRemedy__SaysNothing__When__TheRunEndedAnyOtherWay", () => {
	// Exit 3 specifically means "not at home state". A success, an ordinary failure, or a
	// signalled run (null) are all unrelated, and suggesting a sign-in for them would send the
	// operator to fix a thing that is not broken.
	for (const code of [0, 1, 2, 4, null, undefined]) assert.equal(signinRemedy(code, "mac2", "Yarn"), undefined, String(code));
});

test("signinRemedy__SaysNothing__When__TheJobRecordIsMissingItsApp", () => {
	// The remedy is only useful with an app name in it, and a pull that could not read the job
	// record leaves it undefined. Half a command is worse than none.
	assert.equal(signinRemedy(3, "mac2", undefined), undefined);
});

// ---- a timed-out submit says what happened -----------------------------------------------

test("dispatch__NamesTheTimeout__When__TheSubmitGetsNoAnswer", async () => {
	// Observed 2026-07-31: a submit whose runner was mid-launch of the target app outlasted the
	// call budget, and the panel showed "runnerctl exited 124" — a number that tells an operator
	// nothing, for a run that was in fact alive on that Mac. The reason now names the condition
	// and where to look, because the run continuing is the part worth knowing.
	const res = await dispatch({
		host: "mac1",
		app: "Yarn",
		task: "show me how to change the cursor type",
		inventory: FLEET,
		...noSync,
		run: async () => ({ code: 124, stdout: "", stderr: "" }),
	});

	assert.equal(res.ok, false);
	if (res.ok) return;
	assert.match(res.error, /no answer within \d+s/);
	assert.match(res.error, /may still be launching/);
	assert.equal(res.error.includes("runnerctl exited 124"), false, "the bare exit code is what this replaced");
});

test("dispatchCli__ParsesEveryArmFlag__When__AnOperatorSetsOneByHand", () => {
	// The bench arms set backend/noAx/axdomOff/noGrounding programmatically, so nothing noticed
	// the CLI never parsed them: `--backend ax` was accepted in silence and the run came back
	// cdp. Same shape as the runner dropping useRecipes — every layer agrees the field
	// exists, one link never touches it, nothing errors, and the run is quietly the wrong arm.
	const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "remote", "control", "dispatch.ts"), "utf8");
	for (const flag of ["--backend", "--no-ax", "--axdom-off", "--no-grounding", "--use-curated", "--use-recipes", "--model"])
		assert.ok(src.includes(`"${flag}"`), `the dispatch CLI must let an operator set ${flag}`);
	// And it must be documented, or an operator cannot discover it.
	const usage = src.slice(src.indexOf("const USAGE"), src.indexOf("const USAGE") + 400);
	for (const flag of ["--backend", "--no-ax", "--no-grounding"]) assert.ok(usage.includes(flag), `${flag} missing from usage`);
});
