import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import type { HostEntry } from "../src/remote/control/hosts.js";
import { explainCloseFailure, forgetScreenShareLogin, launchCommand, planSignin, vncUrl, waitForHome } from "../src/remote/control/signin.js";
import type { SshResult } from "../src/remote/control/ssh.js";
import { ok, PIN } from "./fixtures.js";

/**
 * Screen-sharing to a Mac so a human can sign an app in.
 *
 * Offline by construction: the ssh call is injected and nothing here opens a viewer. The one
 * thing that IS executed is the remote command string, against `sh` with a fake `open` on a
 * PATH built here — a regex proving the app name was base64'd would still pass if the decode
 * on the far side put it back on the command line unquoted, which is the whole bug the
 * encoding exists to prevent.
 */

/** A space is the NORMAL case ("Notion Calendar"); the rest is the adversarial part. */
const HOSTILE_NAME = 'Notion "Calendar"; touch $HOME/pwned';

/** Local rather than fixtures': the vnc port varies here, which no other suite needs. */
function host(name = "mac1", addr = "10.0.0.1", vncPort = 5900): HostEntry {
	return { name, ssh: { host: addr, port: 22, user: "administrator" }, vnc: { host: addr, port: vncPort }, hostKey: PIN };
}

/**
 * Run a remote command string the way sshd does — joined into ONE string, handed to a shell —
 * with `open` replaced by a recorder that prints its argv one entry per line.
 */
function runRemote(command: string): { code: number; args: string[] } {
	const script = `open() { for a in "$@"; do printf '%s\\n' "$a"; done; }\n${command}`;
	const res = spawnSync("sh", ["-c", script], { encoding: "utf8", env: { ...process.env, HOME: "/nonexistent" } });

	return { code: res.status ?? -1, args: res.stdout.split("\n").filter(Boolean) };
}

test("vncUrl__WritesThePortOut__When__ItIsTheDefault", () => {
	// Not cosmetic: the fleet is not guaranteed to be all-5900, and a URL that omits the port
	// silently means 5900 to Screen Sharing.
	assert.equal(vncUrl(host("mac1", "10.0.0.1")), "vnc://administrator@10.0.0.1:5900");
	assert.equal(vncUrl(host("mac2", "10.0.0.2", 5901)), "vnc://administrator@10.0.0.2:5901");
});

/**
 * Without the account, macOS cannot match the internet-password item it filed under
 * (server, account, protocol) when the operator ticked "Remember this password", so it
 * re-asks for the username on every connect and the stored secret goes unused.
 */
test("vncUrl__CarriesTheAccount__When__TheHostDeclaresAnSshUser", () => {
	assert.match(vncUrl(host("mac1", "10.0.0.1")), /^vnc:\/\/administrator@/);
});

/** A name needing escaping must not be able to change the URL's shape. */
test("vncUrl__EscapesTheAccount__When__ItContainsUrlSyntax", () => {
	const h = host("mac1", "10.0.0.1");
	h.ssh.user = "ad min@evil";
	assert.equal(vncUrl(h), "vnc://ad%20min%40evil@10.0.0.1:5900");
});

test("launchCommand__PassesTheNameAsOneArgument__When__ItContainsSpaces", () => {
	const { code, args } = runRemote(launchCommand("Notion Calendar"));
	assert.equal(code, 0);
	assert.deepEqual(args, ["-g", "-a", "Notion Calendar"]);
});

test("launchCommand__PassesTheNameAsOneArgument__When__ItContainsShellMetacharacters", () => {
	const { code, args } = runRemote(launchCommand(HOSTILE_NAME));
	assert.equal(code, 0);
	assert.deepEqual(args, ["-g", "-a", HOSTILE_NAME]);
});

test("launchCommand__CarriesNoOperatorTextOnTheCommandLine__When__TheNameIsHostile", () => {
	// The decoded name reaching `open` correctly is one property; the encoded form never
	// appearing as shell source is the other, and only this assertion covers it.
	assert.ok(!launchCommand(HOSTILE_NAME).includes("touch"));
	assert.match(launchCommand(HOSTILE_NAME), /'[A-Za-z0-9+/=]+'/);
});

test("launchCommand__DoesNotRaiseTheApp__When__ItOpensIt", () => {
	// -g matters: a run may be in flight on this Mac, and stealing its focus corrupts what it
	// is recording.
	assert.ok(runRemote(launchCommand("Yarn")).args.includes("-g"));
});

test("planSignin__SkipsTheLaunch__When__NoAppIsNamed", async () => {
	let asked = 0;
	const plan = await planSignin(host(), undefined, async () => {
		asked++;

		return ok();
	});
	assert.equal(asked, 0);
	assert.equal(plan.launch, undefined);
	assert.equal(plan.url, "vnc://administrator@10.0.0.1:5900");
});

/** One NDJSON frame, the way runnerctl prints a reply. */
function frame(obj: Record<string, unknown>): SshResult {
	return { code: obj.ok === false ? 1 : 0, stdout: `${JSON.stringify(obj)}\n`, stderr: "" };
}

test("planSignin__GoesThroughTheRunner__When__ItAnswers", async () => {
	// The runner path is preferred because it is the only one that can swap the app's data to
	// this operator BEFORE the launch. Sign in over someone else's profile and the credential
	// is parked under their name by the next dispatch.
	const seen: string[][] = [];
	const plan = await planSignin(
		host(),
		"Notion Calendar",
		async (_h, argv) => {
			seen.push(argv);

			return frame({ ok: true, app: "Notion Calendar", profile: "profile: Notion Calendar claimed for dg" });
		},
		"dg",
	);

	assert.equal(plan.launch?.ok, true);
	assert.equal(plan.launch?.foregrounded, true);
	assert.equal(plan.profile, "profile: Notion Calendar claimed for dg");
	// One call, and the app name rides in the base64 spec rather than on the command line.
	assert.equal(seen.length, 1);
	assert.deepEqual(seen[0].slice(0, 3), ["runnerctl", "signin", "--json"]);
	assert.ok(!seen[0].join(" ").includes("Notion"));
});

test("planSignin__FallsBackToABackgroundOpen__When__NoRunnerAnswers", async () => {
	// A Mac whose runner is down is still worth connecting to, but without the runner there is
	// no way to know a recording is not in progress — so the app goes up behind everything and
	// the reply says so rather than claiming a foreground it did not perform.
	const seen: string[][] = [];
	const plan = await planSignin(host(), "Yarn", async (_h, argv) => {
		seen.push(argv);

		return ok();
	});

	assert.equal(plan.launch?.ok, true);
	assert.equal(plan.launch?.foregrounded, false);
	assert.match(plan.launch?.detail ?? "", /background/);
	assert.equal(seen.length, 2, "runner first, then the plain open");
	assert.ok(seen[1].join(" ").includes("base64"));
});

test("planSignin__DoesNotFallBack__When__TheRunnerRefuses", async () => {
	// The refusal that matters is "someone is recording on this Mac", and that is precisely the
	// case where opening the app anyway would do the damage the runner just prevented. A parsed
	// no is an answer, not a failure to reach anyone.
	let calls = 0;
	const plan = await planSignin(host(), "Yarn", async () => {
		calls++;

		return frame({ ok: false, error: "sam is running Yarn here (42s) — bringing an app forward would land in their recording", busy: true });
	});

	assert.equal(calls, 1);
	assert.equal(plan.launch?.ok, false);
	assert.match(plan.launch?.detail ?? "", /sam is running Yarn/);
	// Still connectable: watching someone else's run is a legitimate reason to want the screen.
	assert.equal(plan.url, "vnc://administrator@10.0.0.1:5900");
});

test("planSignin__StillOffersTheScreen__When__TheLaunchFails", async () => {
	// The operator can start the app from the Dock once they are looking at it. Refusing to
	// connect because LaunchServices said no would remove the only remaining way forward.
	const plan = await planSignin(host(), "Missing App", async () => ({ code: 1, stdout: "", stderr: "Unable to find application\n" }));
	assert.equal(plan.url, "vnc://administrator@10.0.0.1:5900");
	assert.equal(plan.launch?.ok, false);
	assert.equal(plan.launch?.detail, "Unable to find application");
});

test("planSignin__StillOffersTheScreen__When__SshCannotBeSpawned", async () => {
	const plan = await planSignin(host(), "Yarn", async () => {
		throw new Error("spawn ssh ENOENT");
	});
	assert.equal(plan.url, "vnc://administrator@10.0.0.1:5900");
	assert.deepEqual(plan.launch, { app: "Yarn", ok: false, foregrounded: false, detail: "spawn ssh ENOENT" });
});

/**
 * waitForHome: what turns "sign in, then remember to come back and disconnect" into a flow that
 * ends itself. It polls the same readiness check `agent.ts` refuses on, so a share closed here
 * means the next run will start rather than turn around at the door.
 */

test("waitForHome__StopsPolling__When__TheAppReachesItsHome", async () => {
	const answers = [frame({ ok: true, ready: false, detail: '"Library" not on screen' }), frame({ ok: true, ready: true, detail: 'home control "Library" is on screen' })];
	let calls = 0;
	const seen: string[] = [];
	const out = await waitForHome(host(), "Yarn", {
		intervalMs: 1,
		run: async () => answers[calls++] ?? answers[1],
		onPoll: (d) => seen.push(d),
	});

	assert.equal(out.ready, true);
	assert.match(out.detail, /"Library" is on screen/);
	assert.equal(calls, 2);
	// The negative poll is reported so an operator watching sees the app being looked at; the
	// positive one is the return value, not a progress line.
	assert.deepEqual(seen, ['"Library" not on screen']);
});

test("waitForHome__ReturnsWhatItLastSaw__When__TheDeadlinePasses", async () => {
	// The detail is the payload: "still showing Continue with Google" tells the operator the
	// sign-in did not take, where a bare timeout tells them nothing.
	const out = await waitForHome(host(), "Yarn", {
		timeoutMs: 5,
		intervalMs: 1,
		run: async () => frame({ ok: true, ready: false, detail: 'on screen instead: "Continue with Google"' }),
	});

	assert.equal(out.ready, false);
	assert.match(out.detail, /Continue with Google/);
});

test("waitForHome__KeepsWaiting__When__AnSshCallFails", async () => {
	// A dropped connection says nothing about the app. Treating it as "not signed in and give
	// up" would abandon a sign-in that is going fine over a blip in the network.
	let calls = 0;
	const out = await waitForHome(host(), "Yarn", {
		intervalMs: 1,
		run: async () => {
			if (++calls === 1) throw new Error("kex_exchange_identification");

			return frame({ ok: true, ready: true, detail: "at home" });
		},
	});

	assert.equal(out.ready, true);
	assert.equal(calls, 2);
});

test("waitForHome__AsksOnceMore__When__TheProbeIsNotReadyAndTimeIsUp", async () => {
	// The check comes before the sleep, so an app that was ALREADY at home when this was called
	// returns immediately instead of paying an interval to find out.
	let calls = 0;
	const out = await waitForHome(host(), "Yarn", {
		timeoutMs: 0,
		intervalMs: 60_000,
		run: async () => {
			calls++;

			return frame({ ok: true, ready: true, detail: "at home" });
		},
	});

	assert.equal(calls, 1);
	assert.equal(out.ready, true);
});

/**
 * closeScreenShare's failure reporting. The close itself is not tested here — it drives another
 * app's windows through System Events, so exercising it would depend on what is on the screen of
 * whichever Mac runs the suite.
 */

test("explainCloseFailure__NamesTheGrant__When__SystemEventsWasRefused", () => {
	// -25211 names osascript, but the grant macOS is actually missing belongs to whatever launched
	// it. An operator reading the raw sentence goes looking for an "osascript" row that does not
	// exist in System Settings.
	const out = explainCloseFailure("System Events got an error: osascript is not allowed assistive access. (-25211)");

	assert.match(out, /not allowed assistive access/, "the original sentence is the evidence and stays");
	assert.match(out, /Accessibility/);
});

test("explainCloseFailure__AddsNothing__When__TheFailureIsSomethingElse", () => {
	// A timeout is System Events wedged behind a modal, and a grant will not fix it. The old
	// message asserted Accessibility for every failure, which is how a real cause stays hidden.
	assert.equal(explainCloseFailure("osascript timed out after 10s"), "osascript timed out after 10s");
});

/**
 * forgetScreenShareLogin: the operator's own keychain, so the `security` call is injected and
 * only its argv and the loop's shape are under test — a real invocation would delete whatever
 * credential the developer running this suite has saved for their own fleet.
 */

test("forgetScreenShareLogin__DeletesUntilNoneMatch__When__SeveralItemsExist", async () => {
	// `security delete-internet-password` removes ONE item per call; a Mac whose password was
	// re-saved after a change carries several. Two answer yes here, then the not-found exit.
	const calls: string[][] = [];
	let remaining = 2;
	const res = await forgetScreenShareLogin(host(), async (args) => {
		calls.push(args);
		if (remaining > 0) {
			remaining--;

			return { code: 0 };
		}

		return { code: 44 };
	});

	assert.equal(res.removed, 2);
	// The argv is data, never a shell string: the server and account ride as separate entries,
	// and the protocol code keeps its trailing space — it IS the four-character code.
	assert.deepEqual(calls[0], ["delete-internet-password", "-s", "10.0.0.1", "-r", "vnc "]);
	// Both variants ended on a not-found answer: the broad match first, then the one keyed on
	// the ssh account — the shape vncUrl files the item under.
	assert.deepEqual(calls.at(-1), ["delete-internet-password", "-s", "10.0.0.1", "-a", "administrator", "-r", "vnc "]);
	assert.equal(calls.length, 4, "two deletions, then one miss per variant");
});

test("forgetScreenShareLogin__ReportsZero__When__NothingWasSaved", async () => {
	// Not-found is the wanted end state reached earlier — a success shape, not an error.
	const res = await forgetScreenShareLogin(host(), async () => ({ code: 44 }));
	assert.deepEqual(res, { removed: 0 });
});

test("forgetScreenShareLogin__StopsAtTheCap__When__SecurityKeepsAnsweringSuccess", async () => {
	// A `security` that reports success without deleting would otherwise loop forever.
	let calls = 0;
	const res = await forgetScreenShareLogin(host(), async () => {
		calls++;

		return { code: 0 };
	});

	assert.equal(res.removed, 20);
	assert.equal(calls, 20);
});
