import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { defaultOperator as currentOperator, type HostEntry, loadHosts, resolveHost } from "./hosts.js";
import { firstLine, lastFrame, runnerArgv, runSsh, type SshResult, type SshRunner } from "./ssh.js";

/**
 * Put a human in front of a colo Mac so they can sign an app in once, by hand.
 *
 * Why this exists at all: a freshly installed app is very often unusable until someone
 * authenticates, and the authentication is an SSO round trip through a browser, frequently
 * with MFA. `src/core/agent.ts` already refuses to drive an app whose declared home control is
 * unreachable (exit 3) rather than spending a run's budget fighting a login wall — this is
 * the other half of that refusal: the thing the operator is told to do instead.
 *
 * Why a human and not the agent:
 *
 *  - **Credentials must not enter the loop.** Every observation and every recorded frame goes
 *    to the model and into the demo video. An agent that types a password is a live leak
 *    vector into two artifacts we hand to other people. Nothing in this file has, reads, or
 *    can obtain a credential.
 *  - **MFA and SSO are not automatable in the general case**, and "the general case" is the
 *    requirement: this repo drives arbitrary applications, so anything that only works for
 *    apps with a scriptable login is not a solution.
 *  - **It is once per app per Mac.** The session then lives in the app's own storage and
 *    survives reboots and re-installs of this checkout. Three Macs is three sign-ins.
 *
 * This module is deliberately app-agnostic — the app name is a parameter and is used only to
 * ask LaunchServices to open it, so the operator lands on whatever screen that app shows.
 * Nothing here knows what a login looks like.
 */

/**
 * How long to wait on the remote launch. Generous: a cold app launch on a colo Mac is slow, and
 * on the runner path this also covers a profile swap, which quits the app and moves directories.
 */
const LAUNCH_TIMEOUT_MS = 60_000;

/**
 * How long to keep waiting for a human to finish. Twenty minutes is not a guess at how long an
 * SSO round trip takes — it is how long someone can plausibly be interrupted mid-way through one
 * and still come back to it. Reaching it closes nothing and loses nothing; the operator is told
 * to disconnect when they are done.
 */
const WAIT_TIMEOUT_MS = 20 * 60_000;
/** Between polls. Each one costs an ssh round trip and a driver session on the far side. */
const POLL_INTERVAL_MS = 10_000;
/** One `ready` call, generously over the runner's own 45s probe ceiling so its answer arrives. */
const READY_CALL_MS = 70_000;
const OSASCRIPT_TIMEOUT_MS = 10_000;

/**
 * Screen Sharing's URL scheme. The port is always written out — the fleet is not all on 5900.
 *
 * The username rides along because it turns two prompts into one, and then into none. macOS
 * files a remembered screen-sharing credential as an internet-password keychain item keyed on
 * (server, account, protocol `vnc `); a URL with no account cannot match one, so Screen Sharing
 * asks for the username every time even after the operator ticked "Remember this password".
 * With the account in the URL the item matches and the connection goes straight through.
 *
 * No password, deliberately, though `vnc://user:pass@host` is accepted. That would put the
 * operator's credential for the machine into an argv this process builds, a URL it logs, and
 * a string it hands to `open` — three places a secret has no reason to be, to save a prompt
 * that macOS only shows once per Mac anyway. The keychain is already the right store for it.
 *
 * The SSH user is reused: these are single-account colo Macs, and it is the account `provision`
 * and the runner already act as. If the fleet ever grows a machine where the GUI login differs
 * from the SSH login, that is the point to give `vnc` its own `user` field in hosts.json.
 */
export function vncUrl(host: HostEntry): string {
	const user = host.ssh.user ? `${encodeURIComponent(host.ssh.user)}@` : "";

	return `vnc://${user}${host.vnc.host}:${host.vnc.port}`;
}

/**
 * A remote command string that opens `app`, with the name carried as base64.
 *
 * sshd hands the remote argv to a login shell as ONE joined string, so an app name with a
 * space in it ("Notion Calendar" — the canonical case, not an edge case) is re-split on the
 * far side and `open -a Notion Calendar` looks for two apps. Base64 is the same trick
 * install.ts uses with its request file: the only operator-derived text on the command line
 * is `[A-Za-z0-9+/=]`, which no shell will do anything interesting with.
 */
export function launchCommand(app: string): string {
	const b64 = Buffer.from(app, "utf8").toString("base64");

	// -g: do NOT bring the app forward on the remote console. A run may be in flight on this Mac
	// and a window arriving in front of it would corrupt whatever it is recording.
	//
	// The runner's `signin` verb is the path that DOES foreground, because only the runner knows
	// whether a run is in flight and only the runner can put the operator's own profile in place
	// first. This is the fallback for when it cannot be reached, and in that state neither of
	// those two facts is available — so it takes the cautious option and leaves the operator to
	// click the Dock icon themselves.
	return `N=$(printf %s '${b64}' | base64 --decode) && open -g -a "$N"`;
}

export interface SigninPlan {
	host: HostEntry;
	url: string;
	/** Absent when no app was named — the operator just wants a screen. */
	launch?: { app: string; ok: boolean; foregrounded: boolean; detail: string };
	/** The profile swap the runner performed, when it was the one that opened the app. */
	profile?: string;
}

/**
 * Ask the Mac to bring the app up in front of the console, and work out the screen-sharing URL.
 * Does not open anything locally: the caller decides that, so a test and `--print` never spawn
 * a viewer.
 *
 * Two routes, and the difference is visible to the caller as `foregrounded`:
 *
 *  - **The runner's `signin` verb**, preferred. It refuses if a run is in flight, swaps the
 *    app's data to the requesting operator BEFORE the launch — so the sign-in lands in the
 *    profile that will still hold it next week — and then raises the window.
 *  - **A bare `open -g -a` over ssh**, when the runner is unreachable. The app starts but stays
 *    behind whatever else is on that desktop, because without the runner there is no way to
 *    know a recording is not in progress.
 *
 * A failed launch is reported, not thrown. The screen share is still worth opening — an
 * operator sitting in front of the machine can start the app from the Dock, and that is a
 * better outcome than a command that refuses to do the one thing it could still do.
 */
export async function planSignin(
	host: HostEntry,
	app: string | undefined,
	run: SshRunner = runSsh,
	operator: string = currentOperator(),
): Promise<SigninPlan> {
	const plan: SigninPlan = { host, url: vncUrl(host) };
	if (!app) return plan;

	let res: SshResult;
	try {
		res = await run(host, runnerArgv("signin", { app, operator }), { timeoutMs: LAUNCH_TIMEOUT_MS });
	} catch (e) {
		return { ...plan, launch: { app, ok: false, foregrounded: false, detail: (e as Error).message } };
	}

	const frame = lastFrame(res.stdout);
	if (frame?.ok === true)
		return {
			...plan,
			launch: { app, ok: true, foregrounded: true, detail: "opened and brought to the front" },
			...(typeof frame.profile === "string" ? { profile: frame.profile } : {}),
		};

	// A refusal is the runner's answer and must not be worked around: "someone is recording on
	// this Mac" is precisely the case where a fallback launch would do damage.
	if (frame?.ok === false)
		return { ...plan, launch: { app, ok: false, foregrounded: false, detail: String(frame.error ?? "the runner refused") } };

	return { ...plan, ...(await launchWithoutRunner(host, app, run)) };
}

/** The degraded path: no runner answered, so open the app without disturbing the desktop. */
async function launchWithoutRunner(host: HostEntry, app: string, run: SshRunner): Promise<Pick<SigninPlan, "launch">> {
	let res: SshResult;
	try {
		res = await run(host, [launchCommand(app)], { timeoutMs: LAUNCH_TIMEOUT_MS });
	} catch (e) {
		return { launch: { app, ok: false, foregrounded: false, detail: (e as Error).message } };
	}

	if (res.code === 0)
		return { launch: { app, ok: true, foregrounded: false, detail: "opened in the background — no runner answered, so bring it forward yourself" } };

	return { launch: { app, ok: false, foregrounded: false, detail: firstLine(res.stderr) || firstLine(res.stdout) || `exited ${res.code}` } };
}

/**
 * Poll the Mac until the app reaches its declared home state, which is the machine-checkable
 * meaning of "the sign-in took".
 *
 * It is the same check `agent.ts` refuses on (exit 3), on purpose: waiting for a weaker signal
 * would close the screen share on an operator whose next run is about to be turned away anyway.
 * Nothing here knows what a login looks like — see `probeHome`.
 *
 * `onPoll` exists so a caller can show progress across what may be several minutes of a human
 * typing a password and reading a text message.
 */
export async function waitForHome(
	host: HostEntry,
	app: string,
	opts: { timeoutMs?: number; intervalMs?: number; run?: SshRunner; onPoll?: (detail: string) => void } = {},
): Promise<{ ready: boolean; detail: string }> {
	const run = opts.run ?? runSsh;
	const interval = opts.intervalMs ?? POLL_INTERVAL_MS;
	const deadline = Date.now() + (opts.timeoutMs ?? WAIT_TIMEOUT_MS);
	let last = "no answer yet";

	for (;;) {
		let frame: Record<string, any> | undefined;
		try {
			frame = lastFrame((await run(host, runnerArgv("ready", { app }), { timeoutMs: READY_CALL_MS })).stdout);
		} catch (e) {
			// An ssh hiccup is not a verdict. The app is still whatever it was; try again.
			frame = { detail: (e as Error).message };
		}
		if (frame?.ready === true) return { ready: true, detail: String(frame.detail ?? "at home") };
		last = String(frame?.detail ?? frame?.error ?? last);
		opts.onPoll?.(last);

		// After the check, not before: a sign-in that was already finished when we were called
		// should return immediately rather than sleeping through one interval first.
		if (Date.now() + interval >= deadline) return { ready: false, detail: last };
		await new Promise((r) => setTimeout(r, interval));
	}
}

/**
 * How macOS files a remembered screen-sharing credential: an internet-password keychain item
 * whose protocol field is the four-character code `vnc ` — trailing space included, it IS the
 * code. execFile argv carries it exactly; there is no shell to eat the space.
 */
const VNC_PROTOCOL = "vnc ";

/**
 * Ceiling on deletions per invocation. `security` deletes ONE matching item per call, which is
 * why the loop exists — but a `security` that answered success without deleting (or a keychain
 * writer racing this) must cost a bounded number of subprocesses, not an infinite loop.
 */
const MAX_KEYCHAIN_DELETIONS = 20;

/** One `security` invocation reduced to its exit code. Injected in tests; argv only, never a shell. */
export type SecurityRunner = (args: string[]) => Promise<{ code: number }>;

const runSecurity: SecurityRunner = (args) =>
	new Promise((resolve) => {
		execFile("security", args, { timeout: OSASCRIPT_TIMEOUT_MS }, (err) => {
			const e = err as (Error & { code?: number | string }) | null;
			resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0 });
		});
	});

/**
 * Forget the remembered Screen Sharing password for one Mac, from the OPERATOR's own keychain.
 *
 * This is the local complement of `authclear`: signing an app out on the colo Mac does nothing
 * about the credential the operator's own machine saved when they ticked "Remember this
 * password" in Screen Sharing — that lives in their login keychain, keyed on (server, account,
 * protocol `vnc `), and macOS will keep replaying it into every future `vnc://` connection.
 *
 * `security delete-internet-password` removes ONE matching item per call and there can be
 * several (per-account entries, re-saves after a password change), so each variant is invoked
 * until it reports no matching item. Two variants: unconstrained by account — the broad match —
 * and explicitly keyed on the ssh user, because `vncUrl` puts that account in the URL and the
 * item is filed under it. The second usually finds nothing after the first, which is fine.
 *
 * Both outcomes are success shapes: `{removed: n}` says n items went, and `{removed: 0}` says
 * there was nothing to forget — the wanted end state, reached earlier.
 */
export async function forgetScreenShareLogin(host: HostEntry, exec: SecurityRunner = runSecurity): Promise<{ removed: number }> {
	const variants: string[][] = [
		["delete-internet-password", "-s", host.vnc.host, "-r", VNC_PROTOCOL],
		...(host.ssh.user ? [["delete-internet-password", "-s", host.vnc.host, "-a", host.ssh.user, "-r", VNC_PROTOCOL]] : []),
	];

	let removed = 0;
	for (const args of variants) {
		while (removed < MAX_KEYCHAIN_DELETIONS) {
			const { code } = await exec(args);
			// Nonzero is "no matching item" (or a keychain refusal, which repeating cannot fix
			// either) — the loop's exit, not an error.
			if (code !== 0) break;
			removed++;
		}
	}

	return { removed };
}

/**
 * Close the screen-sharing window for one host, and quit the viewer if that was its last.
 *
 * Window-by-window rather than `quit`, because an operator signing into mac2 may well have mac1
 * open beside it, and disconnecting a session they are using in order to tidy up after one they
 * are not is a worse outcome than leaving a window open. Screen Sharing titles its windows with
 * the host, which is the only handle available — it exposes no scripting dictionary of its own.
 *
 * Reports rather than throwing when it cannot: this runs at the end of a flow that has already
 * succeeded, and a viewer left open is a nuisance, not a failure.
 *
 * `detail` carries what osascript actually said, because the failure modes are not
 * distinguishable from the outside and the guess costs an afternoon. "not allowed assistive
 * access" is a missing Accessibility grant on whatever is running this; "Application isn't
 * running" is a viewer the operator already closed; a timeout is System Events wedged behind a
 * modal. Only the first is worth acting on, and a message that asserts it every time trains
 * people to ignore it.
 */
export async function closeScreenShare(host: HostEntry): Promise<{ closed: boolean; detail: string }> {
	// Both the alias and the address: the title follows whichever the URL used, and hosts.json
	// carries names ("mac2") that need not resemble the address Screen Sharing displays.
	const needles = [...new Set([host.vnc.host, host.name])].map((n) => `"${escapeForApplescript(n)}"`).join(", ");
	const script = [
		'tell application "System Events"',
		'  if not (exists process "Screen Sharing") then return "absent"',
		'  tell process "Screen Sharing"',
		`    repeat with n in {${needles}}`,
		"      repeat with w in (every window whose name contains n)",
		'        try',
		'          click (first button of w whose subrole is "AXCloseButton")',
		"        end try",
		"      end repeat",
		"    end repeat",
		"    if (count of windows) is 0 then",
		'      tell application "Screen Sharing" to quit',
		'      return "quit"',
		"    end if",
		"  end tell",
		'  return "closed"',
		"end tell",
	];

	return execOsascript(script).then(
		(out) => {
			const verdict = out.trim();

			// "absent" is the viewer not running at all, which is the wanted end state reached by
			// someone else — the operator closed it themselves while we were polling. Reporting
			// that as a failure would be a lie about a machine that is in exactly the right shape.
			if (verdict === "absent") return { closed: true, detail: "no screen-sharing window was open" };
			if (verdict === "quit") return { closed: true, detail: "closed the screen share" };
			if (verdict === "closed") return { closed: true, detail: "closed the screen share (other sessions left open)" };

			return { closed: false, detail: `System Events answered "${verdict}"` };
		},
		(e) => ({ closed: false, detail: explainCloseFailure((e as Error).message) }),
	);
}

/**
 * Keep osascript's own sentence and add the one instruction that answers it.
 *
 * -25211 is the only failure with a fix, and its wording ("osascript is not allowed assistive
 * access") names the helper rather than the process macOS actually blamed, which is whatever
 * launched it — the terminal, or this app. Measured 2026-07-30: `exists process "Screen Sharing"`
 * answers WITHOUT the grant, so the script gets as far as reporting "absent" and only fails once
 * a window is genuinely there to close. That is why this looked intermittent.
 */
export function explainCloseFailure(message: string): string {
	if (!/assistive access|-25211/.test(message)) return message;

	return `${message} — grant Accessibility to whatever ran this (the terminal, or this app) in System Settings ▸ Privacy & Security`;
}

function escapeForApplescript(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Run an AppleScript, rejecting with what osascript SAID rather than with what node wrapped it in.
 *
 * `execFile`'s own message is "Command failed: " followed by the whole command line — and this
 * command line is one `-e` per script line, so the useful sentence ("System Events got an error:
 * osascript is not allowed assistive access. (-25211)") arrives buried under a few hundred
 * characters of the script that produced it. The last line of stderr is that sentence.
 */
function execOsascript(lines: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("osascript", lines.flatMap((l) => ["-e", l]), { timeout: OSASCRIPT_TIMEOUT_MS }, (err, stdout, stderr) => {
			if (!err) return resolve(stdout);

			// A kill means the timeout fired: System Events is wedged, usually behind a modal
			// sheet on this Mac. stderr is empty in that case, so it has to be said here.
			const said = String(stderr ?? "").trim().split("\n").pop()?.trim();
			const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;

			reject(new Error(said || (killed ? `osascript timed out after ${OSASCRIPT_TIMEOUT_MS / 1000}s` : err.message)));
		});
	});
}

/** Hand the URL to the OS. macOS routes vnc:// to Screen Sharing.app. */
function openViewer(url: string): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile("open", [url], (err) => (err ? reject(err) : resolve()));
	});
}

const USAGE = `usage: ./run signin <mac> ["<App Name>"] [--print] [--no-wait]

  <mac>          host name or alias from hosts.json
  "<App Name>"   optional: bring this app to the front on that Mac, so you land on its sign-in screen
  --print        print the vnc:// URL instead of opening Screen Sharing
  --no-wait      do not watch for the app reaching its home screen; leave the viewer open

Sign in by hand, once per app per Mac. The session lives in the app's own storage from then
on; nothing is stored by this repo and no credential is ever given to the agent.

With an app named, this watches that Mac and closes the screen share by itself once the app
reaches the same home state a run would require — so finishing the sign-in is the only step.`;

async function main(): Promise<void> {
	// Loose parseArgs, matching what the hand-rolled parser accepted: unknown flags are
	// ignored rather than fatal.
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		options: { print: { type: "boolean" }, "no-wait": { type: "boolean" } },
		strict: false,
		allowPositionals: true,
	});
	const [name, app] = positionals;
	if (!name) {
		console.error(USAGE);
		process.exit(2);
	}

	const host = resolveHost(name, loadHosts());
	const plan = await planSignin(host, app);
	if (plan.profile) console.log(plan.profile);
	if (plan.launch) console.log(`${plan.launch.ok ? "" : "COULD NOT OPEN "}${plan.launch.app} on ${host.name} — ${plan.launch.detail}`);

	if (values.print === true) {
		console.log(plan.url);

		return;
	}

	console.log(`connecting to ${host.name} (${plan.url}) — Screen Sharing will ask for that Mac's login`);
	try {
		await openViewer(plan.url);
	} catch (e) {
		// Not fatal, and the URL is the actually useful output: on a machine with no handler for
		// vnc:// the operator pastes it into their own client.
		console.error(`could not open a viewer (${(e as Error).message}) — connect to ${plan.url} yourself`);
		process.exitCode = 1;
	}

	// Nothing to watch for without an app: "signed in" has no machine-checkable meaning when the
	// operator just wanted a screen, and a wait that can only time out is worse than no wait.
	if (!app || values["no-wait"] === true) {
		console.log(`
Then, on that Mac: sign the app in as you normally would. When its normal home screen is up,
leave it there and disconnect — the app keeps the session. Re-run your task afterwards; the
readiness check in agent.ts is what tells you it took.`);

		return;
	}

	console.log(`
Sign ${app} in as you normally would. Leave this running: it is watching that Mac, and will
close the screen share by itself once ${app} reaches the home screen a run needs. Ctrl-C to
stop watching — that only ends the watch, never the sign-in.
`);
	let previous = "";
	const outcome = await waitForHome(host, app, {
		onPoll: (detail) => {
			// Only on change. A poll every ten seconds for twenty minutes is 120 identical lines
			// otherwise, and the one line that matters is the one where the screen changed.
			if (detail === previous) return;
			previous = detail;
			console.log(`  waiting — ${detail}`);
		},
	});

	if (!outcome.ready) {
		console.log(`\nstopped watching — ${app} is still not at its home screen: ${outcome.detail}`);
		console.log("the screen share is still open, so you can carry on there.");
		process.exitCode = 1;

		return;
	}

	console.log(`\n${app} is signed in and at its home screen — ${outcome.detail}`);
	// The reason comes from closeScreenShare rather than being guessed here: the old line asserted
	// a missing Accessibility grant every time, which is right often enough to be believed and
	// wrong often enough to send someone to System Settings to fix a window they had closed.
	const closed = await closeScreenShare(host);
	console.log(closed.closed ? `${closed.detail}.` : `could not close the screen share — ${closed.detail}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	main().catch((err) => {
		console.error(`signin failed: ${err}`);
		process.exit(1);
	});
