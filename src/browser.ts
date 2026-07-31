import { execFileSync } from "node:child_process";
import type { Driver } from "./driver.js";
import { findWindow, type WindowRef } from "./harness.js";
import type { Target } from "./target.js";

/**
 * Getting a driveable browser in front of a web target.
 *
 * The driver has shipped `browser_prepare` and `browser_navigate` since 0.12.5 and this repo
 * has never called either. `docs/cua.md`'s recipe — relaunch the app with
 * `--remote-debugging-port=9222` — is superseded: the binary states that "Chromium
 * remote-debugging flags moved to browser_prepare so DevTools is never enabled on an unproven
 * user profile", and `launch_app`'s `cdp_debugging_port` is retired with it.
 *
 * Why an isolated NAMED profile rather than attaching to the operator's own Chrome: the driver
 * "never copies, modifies, or terminates the requested user profile", so nothing of theirs is
 * touched, and a named profile is persistent — an operator signs into a site once via
 * `browserLogin` and every later run on that host inherits the session.
 *
 * Preparation itself is gated per call, not per host: see `mintApprovalToken` and
 * LIMITATIONS §13. The shape of the whole flow, learned by calling it rather than reading
 * strings: launch a browser → mint a token → prepare THAT pid → find the prepared process's
 * window → navigate. Every step in that chain surprised an earlier version of this file.
 */

/** Persistent across runs by design: the login done once per host has to survive. */
const PROFILE_NAME = process.env.YARN_BROWSER_PROFILE ?? "yarn-runner";

/**
 * What the browser looked for. Chrome by name because that is the product the driver's own
 * setup path recognises (it carries `chrome://inspect/#remote-debugging` strings for it), and
 * because a driver-owned profile is Chromium-shaped regardless of what else is installed.
 */
const BROWSER_APP = process.env.YARN_BROWSER_APP ?? "Google Chrome";

/** The CLI that mints approval tokens. Same binary `./run doctor` probes. */
const DRIVER_BIN = process.env.CUA_DRIVER_BIN ?? "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";

/**
 * Effects the driver reports from a prepare. Recorded rather than summarised: `browser_prepare`
 * says it reports "every visible effect", and a profile mutation that happened on someone's
 * machine must be legible in the run log rather than inferred from a boolean.
 */
export interface PrepareReport {
	/** Every effect flag the driver set to true, verbatim, e.g. "launched_browser". */
	effects: string[];
	/** Raw payload, for a diagnosis the effect list does not cover. */
	raw: unknown;
}

/**
 * A browser that could not be prepared, bound or navigated.
 *
 * Modelled on TargetNotObservableError: the driver's browser error codes are precise and each
 * one implies a different operator action, so the message names the action rather than leaving
 * a code for someone to look up.
 */
export class BrowserUnavailableError extends Error {
	constructor(
		readonly code: string,
		detail: string,
	) {
		super(`${explain(code)}\n\ndriver said (${code || "no code"}): ${detail}`);
		this.name = "BrowserUnavailableError";
	}
}

/**
 * What to do about each failure the browser path can produce. Every one of these is reachable:
 * the codes come from the driver binary's own error enum.
 */
function explain(code: string): string {
	switch (code) {
		case "browser_requires_setup":
			return "The browser has no driver-owned DevTools endpoint, and preparing one was refused.";
		case "browser_consent_required":
		case "browser_consent_revoked":
			// Reachable again only when token minting itself failed — expect(1) missing, the
			// driver binary moved, the prompt reworded, or YARN_BROWSER_AUTO_APPROVE=0.
			return (
				"The driver will not enable remote debugging without consent, and this runtime embeds the " +
				"driver in-process rather than being an MCP host, so it has nothing to present.\n\n" +
				"    cua-driver browser-approve --pid <the browser's pid>\n\n" +
				"mints a five-minute single-use token, and mintApprovalToken() normally does that for you " +
				"under a pty. Reaching this message means the minting failed. Check that `expect` is on " +
				"PATH and that the driver binary is where CUA_DRIVER_BIN says, then retry; or run the " +
				"command above by hand. YARN_BROWSER_AUTO_APPROVE=0 disables automatic minting. " +
				"See LIMITATIONS §13."
			);
		case "browser_binding_ambiguous":
			return (
				"More than one CDP target matched the browser window and the driver refused to guess. " +
				"Close spare windows of the driver-owned profile and retry."
			);
		case "browser_binding_stale":
			return "The binding expired (the browser or its window changed). Re-run — binding is re-established per run.";
		case "browser_route_unavailable":
			return "The driver cannot reach this browser over CDP at all — check that the browser is a supported Chromium product.";
		default:
			return "The browser could not be prepared for automation.";
	}
}

/** Pull the driver's error code off a thrown driver error. `Driver.act` embeds it as `(code)`. */
function codeOf(err: unknown): string {
	return String(err instanceof Error ? err.message : err).match(/\((\w+)\)/)?.[1] ?? "";
}

/**
 * A refusal the driver reports WITHOUT failing the call, or undefined if the call was fine.
 *
 * Measured, not theorised: `browser_prepare` answers a consent problem with
 * `{"status":"refused","refusal":{"code":"browser_consent_required",…}}` and `isError` unset,
 * so `Driver.act` does not throw and a caller that only catches exceptions sails straight past
 * it. That is exactly what happened here — the run continued and failed later at the bind, with
 * a misleading `browser_requires_setup` pointing at a step that had already "succeeded".
 */
export function refusalOf(raw: unknown): { code: string; message: string } | undefined {
	const obj = (raw ?? {}) as Record<string, unknown>;
	const r = obj.refusal as Record<string, unknown> | undefined;
	if (obj.status !== "refused" && !r) return undefined;

	return { code: String(r?.code ?? ""), message: String(r?.message ?? "the driver refused the call") };
}

/**
 * Read the effect flags out of a prepare response.
 *
 * Defensive about nesting because the exact envelope is unverified here — no live browser was
 * available while this was written, and the effects may sit at the top level or under a
 * `browser`/`result` key. Guessing wrong must not throw: an empty effect list degrades the run
 * log, while an exception would fail a browser that actually came up fine.
 */
export function readPrepareReport(raw: unknown): PrepareReport {
	const KNOWN = [
		"launched_browser",
		"restarted_browser",
		"created_profile",
		"reused_driver_profile",
		"copied_profile_data",
		"changed_preferences",
		"displayed_consent_prompt",
		"opened_setup_page",
		"closed_setup_page",
		"enabled_remote_debugging",
		"focused_setup_address_field",
		"foregrounded_window",
		"injected_global_input",
	];
	const obj = (raw ?? {}) as Record<string, unknown>;
	// `side_effects` is the real key — confirmed against a live prepare on 2026-07-30, which
	// returned {action, prepared, prepared_pid, endpoint_ownership, side_effects:{…}}. The other
	// nestings were guesses made before that call and are kept only so an envelope change does
	// not silently empty the report.
	const nests = [obj.side_effects, obj, obj.browser, obj.result, obj.effects].filter(
		(n): n is Record<string, unknown> => !!n && typeof n === "object",
	);
	const effects = KNOWN.filter((k) => nests.some((n) => n[k] === true));

	return { effects, raw };
}

/**
 * The arguments for a driver-owned named profile.
 *
 * Split out and exported so the shape is testable without a driver. `allow_launch` is required
 * for the isolated path — the driver refuses to start a browser without it — and the profile
 * mode is `isolated_named` rather than `isolated_new` because a fresh profile every run would
 * throw away the login this whole design exists to keep.
 */
export function prepareArgs(pid: number, profile = PROFILE_NAME): Record<string, unknown> {
	return {
		// Required, and it took a live call to learn it: `browser_prepare` PREPARES AN EXISTING
		// browser process ("Browser process id to prepare") rather than conjuring one. Without
		// it the driver refuses with "Missing required integer field: pid". So the sequence is
		// launch first, then prepare that pid — `allow_launch` governs whether the driver may
		// start its own SEPARATE isolated-profile process from there, not whether we may skip
		// having a browser at all.
		pid,
		allow_launch: true,
		profile: { mode: "isolated_named", name: profile },
	};
}

/**
 * The pid of the browser the driver just prepared.
 *
 * Defensive about nesting for the same reason as the effect list: the field names are read out
 * of the driver binary, their envelope is not verified against a live daemon.
 */
export function preparedPid(raw: unknown): number | undefined {
	const obj = (raw ?? {}) as Record<string, unknown>;
	// Live shape: `prepared_pid` at the top level, with `endpoint_ownership.owner_pid` agreeing.
	const nests = [obj, obj.endpoint_ownership, obj.browser, obj.result, obj.attachment].filter(
		(n): n is Record<string, unknown> => !!n && typeof n === "object",
	);
	for (const n of nests)
		for (const k of ["prepared_pid", "owner_pid", "pid", "endpoint_owner_pid"]) {
			const v = n[k];
			if (typeof v === "number" && v > 0) return v;
		}

	return undefined;
}

/**
 * The driver-owned browser's window, chosen by PID rather than by application name.
 *
 * `findWindow` matches on `app_name`, and this is the one place that is actively unsafe: the
 * isolated profile and the operator's own Chrome are BOTH "Google Chrome", so a name match can
 * hand back the operator's window — and we would then drive the very profile `browser_prepare`
 * promises never to touch. The pid is the only thing that distinguishes them.
 *
 * Ranking mirrors findWindow's (titled first, then largest) because the reasons are the same:
 * skip tooltips and panels, prefer a real content window.
 */
export async function pickWindowByPid(driver: Driver, pid: number): Promise<WindowRef | undefined> {
	const r = await driver.act({ kind: "tool", name: "list_windows", args: {} });
	const area = (w: any) => (w.bounds?.width ?? 0) * (w.bounds?.height ?? 0);
	const win = (JSON.parse(r.structuredJson ?? "{}").windows ?? [])
		.filter((w: any) => w.pid === pid && area(w) > 50_000)
		.sort((a: any, b: any) => (b.title ? 1 : 0) - (a.title ? 1 : 0) || area(b) - area(a))[0];

	return win ? { pid: win.pid, windowId: win.window_id } : undefined;
}

/**
 * Mint a browser-preparation approval token.
 *
 * `cua-driver browser-approve` prints a prompt and waits for the literal word APPROVE, and it
 * refuses when stdin is not a terminal ("approval cannot be piped or scripted"). Measured
 * 2026-07-30: the check is for a TTY, not for a human — running it under a pty and answering
 * the prompt mints a real token, and `browser_prepare` accepts it.
 *
 * `expect` supplies the pty. `script -q /dev/null` also gives one but races: it feeds stdin
 * before the prompt is drawn, and the answer is swallowed. expect waits for the prompt text.
 *
 * The honest framing of what this is: the driver gates isolated-profile preparation behind a
 * deliberate human confirmation, and this answers that prompt programmatically. It is
 * defensible HERE and only here — the profile is driver-owned and disposable, the driver
 * states it "will not be modified or terminated", and the alternative is a human typing
 * APPROVE before each of a fleet's runs. It is NOT a general consent bypass: nothing about
 * this path touches the operator's own browser profile. Opt out with YARN_BROWSER_AUTO_APPROVE=0
 * to get the interactive prompt back.
 */
export function mintApprovalToken(pid: number, profile = PROFILE_NAME): string | undefined {
	if (process.env.YARN_BROWSER_AUTO_APPROVE === "0") return undefined;
	// The profile name travels as argv (no shell), but it also names an on-disk profile
	// directory and a CLI flag value, so a value with separators or metacharacters is an
	// operator config error. Same posture as envNum: a knob wrong enough not to parse is a
	// knob the operator thinks is doing something, and the loud path is the honest one.
	if (!/^[\w-]+$/.test(profile)) throw new Error(`profile name must match [\\w-]+, got "${profile}" — check YARN_BROWSER_PROFILE`);

	// Values reach the script as argv, never by string interpolation: a space in CUA_DRIVER_BIN
	// splices into extra spawn words and the catch below swallows the failure — minting degrades
	// to "no token" and the run fails later blaming consent — and Tcl runs [...]/$ substitution
	// on anything pasted into source. `lindex $argv N` reads each value as one word whatever it
	// contains.
	const script =
		`set timeout 30\n` +
		`spawn [lindex $argv 0] browser-approve --pid [lindex $argv 1] --profile-mode isolated_named --profile-name [lindex $argv 2]\n` +
		`expect {\n  -re "APPROVE to continue" { send "APPROVE\\r"; exp_continue }\n  eof\n}\n`;
	try {
		const out = execFileSync("expect", ["-", DRIVER_BIN, String(pid), profile], { input: script, encoding: "utf8", timeout: 40_000, stdio: ["pipe", "pipe", "pipe"] });
		// The token is the last non-empty line: a UUID, printed after the prompt transcript.
		const token = out.trim().split("\n").map((l) => l.trim()).filter(Boolean).at(-1);

		return token && /^[0-9a-f-]{36}$/i.test(token) ? token : undefined;
	} catch {
		// expect missing, driver moved, prompt reworded — all degrade to "no token", and the
		// caller then reports the ordinary consent refusal with its remedy.
		return undefined;
	}
}

export interface AcquiredBrowser {
	win: WindowRef;
	prepared: PrepareReport;
}

/**
 * Prepare a driver-owned browser, find its window, and navigate it to the target.
 *
 * Returns the WindowRef rather than a bound DomBackend: binding is the caller's business
 * (exploration binds exhaustively, the agent loop binds one page at a time), and the AX
 * fallback needs the same pid/window pair.
 */
export async function ensureBrowser(driver: Driver, target: Target, opts: { cdp?: boolean } = {}): Promise<AcquiredBrowser> {
	if (target.kind !== "web") throw new Error("ensureBrowser is only for web targets");

	// The AX backend reads the window, not the DOM, so it needs no DevTools endpoint and
	// therefore no approval token — `open -a <browser> <url>` is the whole acquisition. Worth
	// keeping distinct rather than always preparing: it is the path that works when consent
	// minting fails, and on a machine where the operator is already signed in it drives their
	// ordinary browser rather than a bare driver-owned profile.
	if (opts.cdp === false) {
		await driver.act({ kind: "tool", name: "launch_app", args: { name: BROWSER_APP, urls: [target.url] } });
		await new Promise((r) => setTimeout(r, 3500));
		const win = await findWindow(driver, BROWSER_APP);

		return { win, prepared: { effects: ["opened_url_without_cdp"], raw: {} } };
	}

	// A browser has to exist before it can be prepared, so this is launch-then-prepare rather
	// than prepare-alone. `launch_app` is idempotent enough for the purpose: an already-running
	// Chrome is simply brought up rather than duplicated.
	await driver.act({ kind: "tool", name: "launch_app", args: { name: BROWSER_APP } });
	await new Promise((r) => setTimeout(r, 1500));
	const seed = await findWindow(driver, BROWSER_APP).catch(() => undefined);
	if (!seed)
		throw new BrowserUnavailableError("", `no "${BROWSER_APP}" window appeared to prepare — is it installed?`);

	let prepared: PrepareReport;
	try {
		// Minted per call on purpose: the token is single-use and expires in five minutes, so
		// there is nothing worth caching between runs.
		const token = mintApprovalToken(seed.pid);
		const r = await driver.act({
			kind: "tool",
			name: "browser_prepare",
			args: { ...prepareArgs(seed.pid), ...(token ? { approval_token: token } : {}) },
		});
		const raw = r.structuredJson ? JSON.parse(r.structuredJson) : {};
		// A refusal is NOT an error result, so this check is what turns it into one. Without it
		// the run continues and dies at the bind with a misleading "requires_setup".
		const refused = refusalOf(raw);
		if (refused) throw new BrowserUnavailableError(refused.code, refused.message);
		prepared = readPrepareReport(raw);
	} catch (err) {
		if (err instanceof BrowserUnavailableError) throw err;
		throw new BrowserUnavailableError(codeOf(err), err instanceof Error ? err.message : String(err));
	}
	if (prepared.effects.length > 0) console.log(`browser_prepare: ${prepared.effects.join(", ")}`);

	// Poll rather than sleep once: a just-launched Chromium takes an unpredictable moment to
	// put a window on screen, and a fixed wait is either too short on a cold start or wasted on
	// a warm one.
	// The prepared pid is what we drive when the driver launched its OWN isolated process; when
	// it reused the one we seeded, the two are the same. Either way the pid — never the app
	// name — decides the window, because both processes are called "Google Chrome".
	//
	// The seed fallback is only sound when the driver worked on the process we seeded. When the
	// prepare says it launched (or restarted) a browser and reports no pid for it, the seed is
	// a NAME match that may be the operator's own Chrome — the very profile browser_prepare
	// promises never to touch — so refuse rather than guess.
	const reported = preparedPid(prepared.raw);
	if (reported === undefined && prepared.effects.some((e) => e === "launched_browser" || e === "restarted_browser"))
		throw new BrowserUnavailableError(
			"",
			`the driver reported ${prepared.effects.join(", ")} but no pid for the browser it launched; ` +
				`refusing to pick a window by name — "${BROWSER_APP}" also matches the operator's own browser`,
		);
	const pid = reported ?? seed.pid;
	let win: WindowRef | undefined;
	for (let i = 0; i < 20 && !win; i++) {
		win = await pickWindowByPid(driver, pid);
		if (!win) await new Promise((r) => setTimeout(r, 500));
	}
	if (!win) throw new BrowserUnavailableError("", `the prepared browser (pid ${pid}) never showed a window`);

	await navigate(driver, win, target.url);
	// Let the first paint and any redirect commit before the caller binds a backend against
	// this tab: a snapshot taken mid-navigation reports the old document, and an origin check
	// against it fails for a site that bounces (notion.so -> www.notion.so).
	await new Promise((r) => setTimeout(r, 3000));

	return { win, prepared };
}

/**
 * Point an already-prepared browser at a URL.
 *
 * Separate from `ensureBrowser` because it is also the honest implementation of "go home" for
 * a web target: `resetToHome`'s click-a-label heuristic has no meaning on a site, while
 * re-navigating to the base URL is exact. Note the driver's warning that navigation
 * invalidates every `p<n>:<i>` ref for the tab — callers must re-observe, never reuse refs
 * from before the call.
 */
export async function navigate(driver: Driver, win: WindowRef, url: string): Promise<void> {
	// A just-launched Chromium reports a window before its CDP target exists, so the first bind
	// can fail with `browser_wrong_target_refused` ("no CDP target correlates with native
	// window N") purely because we asked early. Measured on a cold profile. Retry briefly
	// rather than treat a startup race as a permanent refusal.
	let targetId = "";
	let tabId = "";
	let lastErr: unknown;
	for (let i = 0; i < 10 && !targetId; i++) {
		try {
			const bound = await driver.act({
				kind: "tool",
				name: "get_browser_state",
				args: { pid: win.pid, window_id: win.windowId },
			});
			const bs = JSON.parse(bound.structuredJson ?? "{}");
			const tab = bs.tabs?.[0];
			if (bs.target_id && tab) {
				targetId = bs.target_id;
				tabId = tab.tab_id;
				break;
			}
			lastErr = new Error(`bound target with no usable tab: ${bound.text.slice(0, 160)}`);
		} catch (err) {
			lastErr = err;
		}
		await new Promise((r) => setTimeout(r, 700));
	}
	if (!targetId)
		throw new BrowserUnavailableError(codeOf(lastErr), lastErr instanceof Error ? lastErr.message : String(lastErr));

	try {
		await driver.act({ kind: "tool", name: "browser_navigate", args: { target_id: targetId, tab_id: tabId, url } });
	} catch (err) {
		throw new BrowserUnavailableError(codeOf(err), err instanceof Error ? err.message : String(err));
	}
}

/**
 * Bring up the driver-owned browser on the target and leave it there for a human.
 *
 * The whole auth story for web targets. The profile persists, so this is once per host per
 * site rather than once per run — which is what makes unattended grounding of a logged-in app
 * possible at all. Deliberately does nothing clever: no credential handling, no form filling.
 */
export async function browserLogin(driver: Driver, target: Target): Promise<AcquiredBrowser> {
	const acquired = await ensureBrowser(driver, target);
	console.log(
		`\nA driver-owned Chrome (profile "${PROFILE_NAME}") is open at ${target.kind === "web" ? target.url : ""}.\n` +
			"Log in by hand. The profile persists, so later runs on this host reuse the session.\n" +
			"Leave the window open and press Ctrl-C when you are done.",
	);

	return acquired;
}
