import { execFileSync } from "node:child_process";
import type { Driver } from "../core/driver.js";
import { ensureObservable, findWindow, observe, type ObservationBundle, type WindowRef } from "../core/harness.js";
import type { Target } from "../core/target.js";

/**
 * AX-tree actuation backend: drives a Mac app through cua's Driver (src/core/driver.ts) —
 * accessibility-tree perception via get_window_state, OS-level input for actuation.
 *
 * Two roles:
 * - The actuator for NATIVE Mac apps. AX and OS input are what macOS gives every app for
 *   free, so this is the only path that needs no debug port.
 * - The fallback for Electron apps whose --remote-debugging-port never comes up: apps that
 *   sanitize their argv strip the flag, leaving the cdp backend nothing to attach to.
 *   The cdp→ax fallback wiring is a follow-up task, not in this file yet.
 *
 * Scope, stated plainly: this class owns ACQUISITION (launch → settle → find the window),
 * OBSERVATION, and the WINDOW STATE that recovery can move. Per-step actuation stays where
 * it was — step.ts dispatches driver.act directly, and recording, resetToHome and teardown
 * reach the driver the same way. The Driver itself is created and closed by the CALLER
 * (run.ts/explore.ts open it before backend selection and close it from their interrupt
 * handler and finally); this class never closes it.
 */
export class AxBackend {
	private constructor(
		/** Caller-owned — see the header. Exposed because step.ts, recording and teardown
		 *  actuate through it directly; the backend only adds window-state bookkeeping. */
		readonly driver: Driver,
		private readonly app: string,
		private currentWin: WindowRef,
		/** Outcome of the run-start activation, recorded into the run log so a failed run's
		 *  forensics can rule activation in or out without re-running. */
		readonly activation: { applied: boolean; error?: string },
	) {}

	/** The window every observation targets. Reassigned by ensureObservable() when
	 *  recovery relaunches the app onto a new window — read it fresh, never cache it. */
	get win(): WindowRef {
		return this.currentWin;
	}

	/**
	 * Launch (or front — launch_app is `open -a` under the hood) the app and find its main
	 * window, then activate it once for real. The pause lets the launch animation land before
	 * list_windows is asked, so a still-materialising window is not mistaken for absent.
	 *
	 * Activation happens HERE, inside acquire, so every path that acquires this backend —
	 * run.ts, explore.ts, and the cdp→ax fallback that calls acquire directly — inherits it
	 * before the callers' overlay countdown runs.
	 *
	 * Observability recovery is deliberately NOT here: both callers run their operator
	 * countdown between acquisition and the first probe, and recovery can cost a relaunch —
	 * see ensureObservable() below.
	 */
	static async acquire(target: Target, driver: Driver, app: string): Promise<AxBackend> {
		// Both entry points refuse web targets before selecting this backend; the guard is
		// the invariant for callers that do not — the cdp→ax fallback lands on acquire directly.
		if (target.kind !== "app") throw new Error(`the ax backend drives Mac apps, not ${target.kind} targets`);
		await driver.act({ kind: "tool", name: "launch_app", args: { name: app } });
		await new Promise((r) => setTimeout(r, 1500));
		const win = await findWindow(driver, app);

		return new AxBackend(driver, app, win, await activate(app, win.pid));
	}

	/**
	 * Assert the window is observable, recovering if not (foreground, then quit-and-relaunch
	 * — src/core/harness/observation.ts). Recovery can put the app on a NEW window, so the
	 * result replaces the held ref: every later observe() and win read uses the recovered one.
	 */
	async ensureObservable(): Promise<void> {
		this.currentWin = await ensureObservable(this.driver, this.currentWin, this.app);
	}

	observe(name: string): Promise<ObservationBundle> {
		return observe(this.driver, this.currentWin, name, {});
	}
}

/**
 * One genuine AppKit activation at run start — the activation-policy fix from
 * docs/research/2026-07-30-native-mac-apps-investigation.md. An AppKit app launched without
 * ever becoming ACTIVE has no key/main window, so menu validation disables every
 * document-scoped item and menu AXPress silently no-ops (Hex Fiend: 0/15, DISABLED
 * throughout). cua's `delivery_mode: "foreground"` cannot fix it — its <1ms
 * SLPSSetFrontProcessWithOptions flicker never completes an AppKit activation. One real
 * System Events `set frontmost` does, and the probe showed it STICKS: menu items stay
 * enabled after the app is backgrounded again.
 *
 * Runs for every app target, Electron included: a single run-start activation is harmless
 * there (the churn concern in the investigation doc is about per-action foreground cycles,
 * not one activation), and detecting "is this Electron" reliably is machinery this doesn't
 * need — YAGNI.
 *
 * Targets by PID, not name: two apps can share a name, and the pid is the process whose
 * window findWindow just returned. The pid interpolates as a NUMBER into a fixed script, so
 * nothing user-controlled reaches osascript.
 *
 * Failure is non-fatal: an activation refusal (macOS 14+ cooperative-activation rules can
 * refuse a background caller) shouldn't kill a run that might still work — Calculator
 * passed without activation. The outcome is recorded either way for the run log.
 */
async function activate(app: string, pid: number): Promise<{ applied: boolean; error?: string }> {
	try {
		execFileSync(
			"osascript",
			["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`],
			{ encoding: "utf8", timeout: 5000 },
		);
	} catch (err: any) {
		// osascript puts the useful diagnostic on stderr; err.message is just the echoed
		// command (the observation.ts staging path learned this the hard way).
		const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
		const error = (stderr || (err instanceof Error ? err.message : String(err))).split("\n")[0].slice(0, 200);
		console.warn(`  activation of "${app}" (pid ${pid}) failed — continuing anyway: ${error}`);

		return { applied: false, error };
	}
	// Let AppKit finish the activation (key/main window assignment, menu revalidation)
	// before the caller's first observation — same settle idiom as the launch pause above.
	await new Promise((r) => setTimeout(r, 400));

	return { applied: true };
}

// The ax path's model-facing surface, re-exported so this module is the one-stop shop —
// mirroring cdp.ts's cdpActTool/cdpRules. The definitions STAY in actions.ts: the rest of
// the harness (verification, teardown, recipes) shares them, and moving them would churn
// every one of those imports for nothing.
export { ACT_TOOL, DEMO_ACT_TOOL, DEMO_DRIVER_RULES, DRIVER_RULES } from "../core/harness/actions.js";
