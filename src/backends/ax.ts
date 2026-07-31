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
 *   The activation-policy fix and the cdp→ax fallback wiring are follow-up tasks, not in
 *   this file yet.
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
	) {}

	/** The window every observation targets. Reassigned by ensureObservable() when
	 *  recovery relaunches the app onto a new window — read it fresh, never cache it. */
	get win(): WindowRef {
		return this.currentWin;
	}

	/**
	 * Launch (or front — launch_app is `open -a` under the hood) the app and find its main
	 * window. The pause lets the launch animation land before list_windows is asked, so a
	 * still-materialising window is not mistaken for absent.
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

		return new AxBackend(driver, app, await findWindow(driver, app));
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

// The ax path's model-facing surface, re-exported so this module is the one-stop shop —
// mirroring cdp.ts's cdpActTool/cdpRules. The definitions STAY in actions.ts: the rest of
// the harness (verification, teardown, recipes) shares them, and moving them would churn
// every one of those imports for nothing.
export { ACT_TOOL, DEMO_ACT_TOOL, DEMO_DRIVER_RULES, DRIVER_RULES } from "../core/harness/actions.js";
