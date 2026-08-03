import { execFileSync } from "node:child_process";
import type { Driver } from "../core/driver.js";
import { ensureObservable, findWindow, observe, pickWindow, type ObservationBundle, type WindowCandidate, type WindowRef } from "../core/harness.js";
import type { Target } from "../core/target.js";
import { KEEP_RENDERING_FLAGS } from "./electron-attach.js";

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
		/**
		 * Launch an ELECTRON target with the anti-throttle flags, exactly as the cdp path does.
		 *
		 * Electron derives its accessibility tree from the renderer's DOM, so a renderer Chromium
		 * has backgrounded stops publishing one — not for a single window, for the whole app. On
		 * 2026-08-01 six AX passes died on that: Yarn opens a recording/media helper, the main
		 * renderer gets occluded and parked, and every window of the app reports zero elements.
		 * The recovery ladder below exhausts itself against it, and re-activation cannot help —
		 * `set frontmost` restores app activation, not a parked renderer.
		 *
		 * The cdp path never saw it because launchWithPort passes KEEP_RENDERING_FLAGS. That made
		 * the two arms differ in how the APP WAS LAUNCHED, not only in how it is read — so the
		 * ax-vs-cdp comparison was measuring a launch asymmetry alongside the backends.
		 *
		 * Best-effort and non-fatal: a non-Electron app has no such flags and `open --args` simply
		 * passes them to something that ignores them, so the failure mode is the status quo.
		 */
		await launchWithRenderingFlags(app);
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
		/**
		 * Pick a window that can actually ANSWER, then observe it.
		 *
		 * This was three patched branches and the patches left a hole. Each fix on 2026-08-01
		 * covered the case that had just bitten — the held window being gone, then the held
		 * window being silent — and the third crash went straight through the gap between them:
		 * a click opened an untitled window, the follow moved TO it because the pick returned a
		 * DIFFERENT id, and the "moved" branch adopted it without ever asking whether it had
		 * content. Three arms died on a window the harness had just chosen for them.
		 *
		 * So the flow is one ladder now, tried in order, and every rung is "can this thing
		 * answer" rather than "does this thing exist":
		 *
		 *   1. the app's front window, which is right almost always
		 *   2. any other window of the app — the studio or panel merely took the front; the
		 *      main window is usually still there and still populated
		 *   3. re-activate the app and look again — an AppKit app that is not KEY/MAIN has menu
		 *      validation disable everything and its AX tree collapses to the menu bar, which is
		 *      the activation-policy finding acquire() already exists for. A coordinate drag can
		 *      knock that loose mid-run, and nothing used to put it back.
		 *
		 * Falls through to the ordinary path when nothing answers, so the real error arrives with
		 * ensureObservable's recovery story rather than a shape invented here. observe() THROWS
		 * on an empty tree instead of returning one, so every rung treats a throw and a
		 * zero-content answer as the same signal.
		 */
		let candidates: WindowCandidate[] = [];
		try {
			const windows = await this.driver.act({ kind: "tool", name: "list_windows", args: {} });
			candidates = (JSON.parse(windows.structuredJson ?? "{}").windows ?? []).filter((w: WindowCandidate) => w.app_name === this.app);
		} catch {
			// A follow that cannot list windows must not fail the observation it serves.
		}

		if (candidates.length) {
			const mine = candidates.filter((w) => w.pid === this.currentWin.pid);
			const pool = mine.length ? mine : candidates;
			const front = pickWindow(candidates, this.app, this.currentWin.pid);
			const held = pool.find((w) => w.window_id === this.currentWin.windowId);
			// Front first, then the one we hold if it is still listed, then everything else.
			// Deduped by id so a window is never probed twice in one observation.
			const order = [front, held, ...pool].filter((w): w is WindowCandidate => Boolean(w));
			const seen = new Set<number>();

			for (const w of order) {
				if (seen.has(w.window_id)) continue;
				seen.add(w.window_id);
				const ref = { pid: w.pid, windowId: w.window_id, bounds: w.bounds };
				const got = await observe(this.driver, ref, name, {}).catch(() => undefined);
				if (!got || got.appContent === 0) continue;
				if (w.window_id !== this.currentWin.windowId) {
					console.log(`  window follow: "${this.lastTitle ?? ""}" -> "${w.title}" (id ${this.currentWin.windowId} -> ${w.window_id}, ${got.appContent} elements)`);
					this.currentWin = ref;
				}
				this.lastTitle = w.title ?? this.lastTitle;

				return got;
			}

			// Every window of the app came back empty: the problem is the app, not the choice.
			const woken = await activate(this.app, this.currentWin.pid);
			console.log(`  window follow: no window of "${this.app}" exposed AX content — re-activation ${woken.applied ? "applied" : `refused (${woken.error ?? "unknown"})`}`);
			if (woken.applied) {
				const target = front ?? held ?? pool[0]!;
				const ref = { pid: target.pid, windowId: target.window_id, bounds: target.bounds };
				const after = await observe(this.driver, ref, name, {}).catch(() => undefined);
				if (after && after.appContent > 0) {
					console.log(`  window follow: re-activated "${this.app}" and recovered (${after.appContent} elements)`);
					this.currentWin = ref;
					this.lastTitle = target.title ?? this.lastTitle;

					return after;
				}
			}
		}

		return observe(this.driver, this.currentWin, name, {});
	}
}

/**
 * Start the app with Chromium's anti-throttle flags before the driver's own launch_app.
 *
 * `open -a <app> --args <flags>` only passes arguments when open actually STARTS the process;
 * for an already-running app they are ignored, which is why cold start (coldstart.ts) matters
 * to this working — a run that inherits a live Yarn inherits its flags too.
 */
async function launchWithRenderingFlags(app: string): Promise<void> {
	try {
		const { openWithArgs } = await import("../core/appctl.js");
		await openWithArgs(app, KEEP_RENDERING_FLAGS);
	} catch {
		// Non-fatal by design: launch_app below starts the app regardless. Losing the flags costs
		// the blackout protection, not the run.
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
// the harness (verification, teardown, procedures) shares them, and moving them would churn
// every one of those imports for nothing.
export { ACT_TOOL, DEMO_ACT_TOOL, DEMO_DRIVER_RULES, DRIVER_RULES } from "../core/harness/actions.js";
