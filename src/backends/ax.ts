import { execFileSync } from "node:child_process";
import type { Driver } from "../core/driver.js";
import { ensureObservable, findWindow, observe, pickWindow, type ObservationBundle, type WindowCandidate, type WindowRef } from "../core/harness.js";
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
 *   The cdp→ax fallback lives in run.ts's acquisition branch; the decision itself is
 *   fallbackEligible (src/backends/electron-attach.ts), keyed on EndpointUnavailableError.
 *
 * Scope, stated plainly: this class owns ACQUISITION (launch → settle → find the window),
 * OBSERVATION, and the WINDOW STATE that recovery can move. Per-step actuation stays where
 * it was — step.ts dispatches driver.act directly, and recording, resetToHome and teardown
 * reach the driver the same way. The Driver itself is created and closed by the CALLER
 * (run.ts/explore.ts open it before backend selection and close it from their interrupt
 * handler and finally); this class never closes it.
 *
 * Known limitation: recording captures ax.win ONCE at start, so a run whose window moves
 * (the per-observation follow below) records only the window it started on.
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

	/** Title of the last window the follow resolved, for the switch log's "from" side —
	 *  WindowRef itself carries no title. */
	private lastTitle?: string;

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

	/**
	 * Re-resolve to the app's FRONT window, then observe it.
	 *
	 * A run drives the app's front window the way a human reads the screen: whatever the
	 * app brings forward — ⌘N opening a document, a dialog replacing it — is where the
	 * next look must land. Pinning the window once at acquire is how run
	 * 2026-07-31T10-29-05-036 read a stale TextEdit document for 11 straight steps while
	 * its actions landed in the window ⌘N had actually opened (0/11 verified, pixels 0.0%).
	 *
	 * The follow is one list_windows round-trip per observation — cheap next to the
	 * get_window_state that follows — and deliberately uncached: caching would recreate the
	 * pin-once bug on a longer period. Pid-pinned, so two instances sharing a name cannot
	 * cross-capture, and each follow re-resolves against whatever pid ensureObservable's
	 * recovery last installed. Every switch is logged: the run transcript must show each
	 * move, or a wrong-window run's forensics would have nothing to rule the follow in
	 * or out with.
	 */
	async observe(name: string): Promise<ObservationBundle> {
		try {
			const windows = await this.driver.act({ kind: "tool", name: "list_windows", args: {} });
			const all: WindowCandidate[] = JSON.parse(windows.structuredJson ?? "{}").windows ?? [];
			const front = pickWindow(all, this.app, this.currentWin.pid);
			/**
			 * KEEPING THE HELD REF IS ONLY SAFE WHILE IT STILL EXISTS.
			 *
			 * The comment here used to say a failed pick keeps the current window because
			 * observe/ensureObservable own that failure. True when the held window is merely
			 * unpickable — off-screen, shrunk below the area floor — and catastrophic when it is
			 * GONE, because every later observation addresses a window id that no longer exists
			 * and returns nothing. Three of those in a row is a TargetNotObservableError.
			 *
			 * That killed a pass on 2026-08-01. A click opened a native Open panel, the follow
			 * correctly moved to it, the agent pressed Escape without touching a user file —
			 * exactly right — and the panel vanished. The pick then found no window passing the
			 * 50,000px floor while the app settled, so the run kept the DEAD panel's id and
			 * observed nothing for the rest of its life.
			 *
			 * So: distinguish "cannot pick one" from "the one we hold is gone". If the held id is
			 * absent from the listing it is dead, and ANY live window of this app beats it —
			 * including one the floor would reject, since a small real window is still
			 * addressable and a dead one never is.
			 */
			const heldAlive = all.some((w) => w.window_id === this.currentWin.windowId);
			if (!front && !heldAlive) {
				const survivor = all.find((w) => w.app_name === this.app && w.pid === this.currentWin.pid) ?? all.find((w) => w.app_name === this.app);
				if (survivor) {
					console.log(`  window follow: held window ${this.currentWin.windowId} is GONE (dialog dismissed?) — recovering onto "${survivor.title}" (id ${survivor.window_id})`);
					this.currentWin = { pid: survivor.pid, windowId: survivor.window_id, bounds: survivor.bounds };
					this.lastTitle = survivor.title ?? this.lastTitle;

					return observe(this.driver, this.currentWin, name, {});
				}
				// Nothing of this app is listed at all: a genuinely dead app, which
				// ensureObservable's relaunch path owns. Falling through keeps that story intact.
			}
			/**
			 * A LIVE WINDOW WITH NO ACCESSIBILITY CONTENT IS AS UNUSABLE AS A DEAD ONE, and
			 * unlike a dead one nothing above notices — pickWindow is perfectly happy with it.
			 *
			 * Three passes died this way on 2026-08-01, all AX, all around action 80-140 and
			 * ~20 minutes in, all reaching the parts of Yarn that publish no AX tree: a
			 * dismissed native Open panel's ghost, a recording-studio window that is pure
			 * canvas, and Yarn exposing only its menu bar after a coordinate drag moved focus.
			 * One agent said it outright — "the screenshot is Yarn but accessibility is exposing
			 * only menus". All three diagnosed it correctly and were trying to escape; the
			 * harness threw first, at three empty observations.
			 *
			 * So when the window we hold yields nothing, try the app's OTHER windows before
			 * giving up. The main window is usually still there and still populated — the studio
			 * or panel merely took the front. This is the same rule as the dead-handle recovery
			 * above ("do not keep talking to something that cannot answer"), applied to the case
			 * where the thing is alive but silent.
			 */
			if (front && front.window_id === this.currentWin.windowId && all.length > 1) {
				// observe() THROWS on an empty tree rather than returning one, so the probe has to
				// tolerate that: a throw and a zero-content answer are the same signal here.
				const probe = await observe(this.driver, this.currentWin, name, {}).catch(() => undefined);
				if (probe && probe.appContent > 0) return probe;
				for (const alt of all.filter((w) => w.app_name === this.app && w.pid === this.currentWin.pid && w.window_id !== this.currentWin.windowId)) {
					const other = await observe(this.driver, { pid: alt.pid, windowId: alt.window_id, bounds: alt.bounds }, name, {}).catch(() => undefined);
					if (!other || other.appContent === 0) continue;
					console.log(`  window follow: "${this.lastTitle ?? ""}" had no AX content — switching to "${alt.title}" (id ${alt.window_id}, ${other.appContent} elements)`);
					this.currentWin = { pid: alt.pid, windowId: alt.window_id, bounds: alt.bounds };
					this.lastTitle = alt.title ?? this.lastTitle;

					return other;
				}
				/**
				 * NO WINDOW OF THIS APP CAN ANSWER — so the problem is not which window we hold,
				 * it is the app itself, and there is one known cause with a known remedy.
				 *
				 * An AppKit app that is not KEY/MAIN has menu validation disable everything and
				 * its AX tree collapses to the menu bar. That is the activation-policy finding
				 * from the native-apps investigation, and it is why acquire() performs one
				 * genuine System Events activation at run start (Hex Fiend: 0/15, DISABLED
				 * throughout, until it did).
				 *
				 * On 2026-08-01 a pass hit the same signature MID-RUN. Its own step note reads
				 * "the coordinate drag unexpectedly changed foreground focus", and the next
				 * observation reported "the screenshot is Yarn but accessibility is exposing only
				 * menus" — the app lost activation and never got it back. Activation was treated
				 * as a start-up concern; nothing re-established it when a run knocked it loose.
				 *
				 * Once per observation at most, and only when every window has already come back
				 * empty: this costs an osascript round trip, so it must not run on the happy path.
				 * A refusal is non-fatal — the fall-through below reports the real error with
				 * ensureObservable's recovery story attached.
				 */
				const woken = await activate(this.app, this.currentWin.pid);
				if (woken.applied) {
					const after = await observe(this.driver, this.currentWin, name, {}).catch(() => undefined);
					if (after && after.appContent > 0) {
						console.log(`  window follow: "${this.app}" exposed no AX content — re-activated it and recovered (${after.appContent} elements)`);

						return after;
					}
				}
				// Still nothing. Fall through to the ordinary path so the real error — with
				// ensureObservable's recovery story attached — is what surfaces, rather than a
				// shape invented here.
			}
			if (front && front.window_id !== this.currentWin.windowId) {
				console.log(`  window follow: "${this.lastTitle ?? ""}" -> "${front.title}" (id ${this.currentWin.windowId} -> ${front.window_id})`);
				this.currentWin = { pid: front.pid, windowId: front.window_id, bounds: front.bounds };
			}
			this.lastTitle = front?.title ?? this.lastTitle;
		} catch {
			// A follow that cannot list windows must not fail the observation it serves.
		}

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
	} catch (err) {
		const failure = activationFailure(err);
		console.warn(`  activation of "${app}" (pid ${pid}) failed — continuing anyway: ${failure.error}`);

		return failure;
	}
	// Let AppKit finish the activation (key/main window assignment, menu revalidation)
	// before the caller's first observation — same settle idiom as the launch pause above.
	await new Promise((r) => setTimeout(r, 400));

	return { applied: true };
}

/**
 * Classify an osascript failure into the run log's activation record. osascript puts the
 * useful diagnostic on STDERR; err.message is just the echoed command (the observation.ts
 * staging path learned this the hard way). First line only, capped at 200 chars — the log
 * field is forensic breadcrumb, not a transcript. Pure, exported for tests.
 */
export function activationFailure(err: unknown): { applied: false; error: string } {
	const stderr = typeof (err as any)?.stderr === "string" ? (err as any).stderr.trim() : "";
	const error = (stderr || (err instanceof Error ? err.message : String(err))).split("\n")[0].slice(0, 200);

	return { applied: false, error };
}

// The ax path's model-facing surface, re-exported so this module is the one-stop shop —
// mirroring cdp.ts's cdpActTool/cdpRules. The definitions STAY in actions.ts: the rest of
// the harness (verification, teardown, recipes) shares them, and moving them would churn
// every one of those imports for nothing.
export { ACT_TOOL, DEMO_ACT_TOOL, DEMO_DRIVER_RULES, DRIVER_RULES } from "../core/harness/actions.js";
