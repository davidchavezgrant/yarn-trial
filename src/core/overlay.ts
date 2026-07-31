import { spawn, type ChildProcess } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { envNum } from "../env.js";

/**
 * An always-on-top banner saying the machine is being driven.
 *
 * Runs on the ax backend seize the pointer and keyboard for minutes at a time, and from the
 * outside a driven app is indistinguishable from an idle one until a click lands somewhere
 * unexpected. The banner exists so a human in front of the machine can tell, at a glance and
 * without reading a terminal, whether it is safe to touch anything.
 *
 * It is keyed to the backend's input DELIVERY, not to the run's mode or observation channel
 * (see backendSeizesInput): a cdp run never touches the operator's pointer, so it gets no
 * banner at all — a warning that is up when nothing is being taken over trains the operator
 * to ignore the one that matters.
 *
 * There is no banner primitive in the driver, so this shells to JXA — the same escape hatch
 * stageWindowForRecording() already uses — and builds a borderless NSPanel. It is a separate
 * PROCESS for the same reason the axdom sidecar is: the panel needs its own run loop, which
 * Node cannot host, and a crashed parent must not be able to strand a red bar across the
 * user's screen. The script self-destructs when its parent pid disappears, so kill -9 on the
 * agent, an uncaught throw, or a closed terminal all clear it within a second.
 *
 * Cosmetic and best-effort: every failure path leaves the run untouched and unannounced,
 * which is worse for the human but never wrong for the task.
 *
 * HOW TO CHECK IT ACTUALLY SHOWS AND HIDES. Two instruments were tried and both lied.
 * System Events does not enumerate NSPanels, so it reports zero panels whether or not one
 * is on screen; screencapture-plus-pixel-sampling cannot tell this banner from another
 * run's, since they land in the same place on the same display. The one that works is
 * CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, ...) filtered by
 * kCGWindowOwnerPID — it sees panels, and the pid tells concurrent runs apart. Two JXA
 * traps in it: several kCGWindowList* constants are undefined (an undefined in the option
 * mask makes it NaN and the result empty, so spell 1|16 numerically), and the CFArrayRef
 * comes back unbridged, so .count is undefined until ObjC.castRefToObject(). Measured on
 * a three-display Mac: 3 panels shown, 0 after setDriving(false), 3 again, 0 after stop().
 */

/** Where the banner sits. Top edge is where a status bar is looked for. */
const WIDTH = 460;
const HEIGHT = 34;
const MARGIN = 6;

/**
 * AppKit constants, spelled numerically. JXA exposes some enum names and not others
 * depending on the SDK, and a missing one silently evaluates to undefined — which here
 * would mean a normal window that steals focus mid-run.
 */
const STYLE_BORDERLESS_NONACTIVATING = 128; // NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
const BACKING_BUFFERED = 2;
const LEVEL_ABOVE_EVERYTHING = 1000; // NSScreenSaverWindowLevel — clears the menu bar and fullscreen apps
const BEHAVIOR_ALL_SPACES_STATIONARY_FULLSCREEN = 1 | 16 | 256;
/**
 * NSTextAlignmentCenter. Modern macOS uses UIKit's ordering (left 0, center 1, right 2), not
 * the legacy AppKit one (left 0, right 1, center 2) — 2 renders the banner right-aligned.
 */
const TEXT_ALIGN_CENTER = 1;

/**
 * Countdown fill. Every mode colour below is warm, so a cold blue reads as "not yet" and the
 * flip to the mode colour is unmistakable out of the corner of an eye — which is the only
 * way this banner is ever actually read.
 */
const COUNTDOWN_RGB = "0.10,0.40,0.85";

const SCRIPT = `
ObjC.import("AppKit");
ObjC.import("stdlib");
ObjC.import("unistd");

/**
 * Is the parent still running? NSRunningApplication is NOT the way to ask: it only knows
 * registered GUI applications, so a node process reads as dead the instant the banner
 * appears (measured — the panel vanished within one tick). kill -0 was wrong too, one step
 * more subtly: it answers "does SOME process with this pid exist", and macOS recycles pids,
 * so after a SIGKILL of the agent a same-user process inheriting the number keeps a
 * stranded bar up indefinitely — the exact failure the self-destruct exists to prevent.
 * This process is spawned as a DIRECT CHILD of the agent, so the agent's death reparents it
 * to launchd (pid 1) and its own ppid stops being the agent's. getppid() asks exactly that
 * question, in-process — no fork, and pid reuse cannot fool it.
 */
function parentAlive(pid) {
  if (!(pid > 0)) return true;
  return $.getppid() === pid;
}

const env = $.NSProcessInfo.processInfo.environment;
const read = (k, fallback) => {
  const v = env.objectForKey(k);
  return v.isNil() ? fallback : v.js;
};

const text = read("OVERLAY_TEXT", "Agent driving this Mac");
const parentPid = parseInt(read("OVERLAY_PARENT", "0"), 10);
const rgb = read("OVERLAY_RGB", "0.80,0.11,0.18").split(",").map(Number);
/**
 * Blue until the pointer is actually taken, mode colour after: the colour flip is what is
 * visible from across the room, before any of the words are legible.
 *
 * The countdown does NOT start at launch — the parent has setup to do first (start the
 * driver, launch the app, find its window) and how long that takes varies. So the banner
 * opens blue and holds there until the parent touches the go-file, which is also why this
 * process is spawned exactly once: respawning to change state flashed the mode colour for
 * a frame before the countdown, which reads as "it already started".
 */
const countRgb = [${COUNTDOWN_RGB}];
const fill = (c) => $.NSColor.colorWithCalibratedRedGreenBlueAlpha(c[0], c[1], c[2], 0.95).CGColor;
const total = parseInt(read("OVERLAY_COUNTDOWN", "0"), 10) || 0;
const goFile = read("OVERLAY_GO", "");
let left = -1; // -1 = waiting for go, >0 = ticking, 0 = run in progress
if (total <= 0) left = 0;
// A no-countdown run starts already flipped: the panels below are built in mode colour.
let flipped = left === 0;

const app = $.NSApplication.sharedApplication;
// Accessory policy: no Dock tile, no menu bar, and crucially no activation, so showing
// the banner cannot pull focus away from the app being driven.
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);

/**
 * One banner PER DISPLAY. Placing it only on the target app's screen assumes we know which
 * monitor the operator is looking at, and we do not — they may be reading mail on another
 * while the run works. A warning that has to be hunted for is not a warning, and three thin
 * bars cost nothing.
 */
const screens = $.NSScreen.screens;
const W = ${WIDTH}, H = ${HEIGHT};
const labels = [];

for (let i = 0; i < screens.count; i++) {
  const screen = screens.objectAtIndex(i);
  // visibleFrame, NOT frame: frame's top edge runs behind the menu bar, and on a notched
  // laptop that is precisely where the notch eats the banner. visibleFrame starts below both.
  const f = screen.visibleFrame;
  // AppKit's origin is bottom-left, so "near the top" is frame height minus the banner.
  const x = f.origin.x + (f.size.width - W) / 2;
  const y = f.origin.y + f.size.height - H - ${MARGIN};

  const panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(x, y, W, H), ${STYLE_BORDERLESS_NONACTIVATING}, ${BACKING_BUFFERED}, false);
  panel.setLevel(${LEVEL_ABOVE_EVERYTHING});
  panel.setCollectionBehavior(${BEHAVIOR_ALL_SPACES_STATIONARY_FULLSCREEN});
  panel.setOpaque(false);
  panel.setBackgroundColor($.NSColor.clearColor);
  // The banner must never eat a click meant for the app underneath it.
  panel.setIgnoresMouseEvents(true);
  panel.setHasShadow(true);

  const view = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
  view.setWantsLayer(true);
  view.layer.backgroundColor = fill(left === 0 ? rgb : countRgb);
  view.layer.cornerRadius = 8;
  panel.setContentView(view);

  const label = $.NSTextField.alloc.initWithFrame($.NSMakeRect(10, 7, W - 20, 20));
  label.setStringValue(left === 0 ? text : text + "  —  getting ready");
  label.setBezeled(false);
  label.setDrawsBackground(false);
  label.setEditable(false);
  label.setSelectable(false);
  label.setTextColor($.NSColor.whiteColor);
  label.setFont($.NSFont.boldSystemFontOfSize(13));
  label.setAlignment(${TEXT_ALIGN_CENTER});
  view.addSubview(label);

  panel.orderFrontRegardless;
  // Retained so the countdown can rewrite every banner, and so ARC does not collect the
  // panels the moment this iteration ends.
  labels.push({panel: panel, label: label, view: view});
}

const exists = (p) => p && $.NSFileManager.defaultManager.fileExistsAtPath(p);

/**
 * Hide while the model thinks, show while the pointer is actually being driven.
 *
 * A banner that is up for the whole run stops being read: most of a run's wall clock is
 * model thinking, during which the machine is safe to touch, so a permanent bar trains the
 * operator to ignore exactly the thing meant to warn them. Appearing only around real
 * actuation makes its presence informative again.
 *
 * Same one-bit file handshake as the go-file, for the same reason: this process is blocked
 * in its own run loop and there is no IPC channel into JXA.
 */
const pauseFile = read("OVERLAY_PAUSE", "");
let hidden = false;
const setHidden = (want) => {
  if (want === hidden) return;
  hidden = want;
  for (let i = 0; i < labels.length; i++) {
    if (want) labels[i].panel.orderOut(null);
    else labels[i].panel.orderFrontRegardless;
  }
};

/**
 * The countdown ticks in the banner rather than the terminal, because the banner is where
 * the operator is already looking. The parent sleeps for the same duration; this only draws
 * it, and the go-file is the whole handshake — one bit, no IPC channel into a JXA process.
 *
 * Self-destruct rather than trusting the parent to clean up: a stranded always-on-top bar
 * with no process to kill is worse than never showing one, and a run can die by uncaught
 * throw, SIGKILL or a closed terminal — none of which run a finally block.
 */
while (true) {
  // Never hide during the countdown — that phase exists to be seen.
  if (left === 0 && pauseFile) setHidden(exists(pauseFile));
  if (left < 0 && exists(goFile)) left = total;
  const ticking = left > 0;
  // Flip on the tick AFTER the final rendered second: "starting in 1" has had its full
  // second on screen by now, and the parent's countdown() sleep ends at the same moment, so
  // the colour change coincides with the pointer actually being taken — which is what the
  // flip is documented to mean. Flipping inside the render branch overwrote "1" in the same
  // iteration and released the colour a second early.
  if (left === 0 && !flipped) {
    flipped = true;
    for (let i = 0; i < labels.length; i++) {
      labels[i].label.setStringValue(text);
      labels[i].view.layer.backgroundColor = fill(rgb);
    }
  }
  if (ticking) {
    const s = text + "  —  starting in " + left;
    for (let i = 0; i < labels.length; i++) labels[i].label.setStringValue(s);
    left--;
  }
  // 1s per rendered count, so each number gets its full second on screen — the sleep keys
  // off ticking, captured BEFORE the decrement; 0.2s otherwise, so show/hide tracks
  // individual actions instead of lagging a second behind them.
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(ticking ? 1 : 0.2));
  if (!parentAlive(parentPid)) $.exit(0);
}
`;

export interface Overlay {
	/**
	 * Count down in every banner, then resolve. Call it at the LAST moment before the first
	 * pointer action — everything before it (driver startup, launching the app, finding its
	 * window) happens while the banner sits blue saying "getting ready", so the countdown
	 * means what it says. Resolves immediately when COUNTDOWN=0.
	 */
	countdown(): Promise<void>;
	/**
	 * Hide the banner while the model thinks; show it while the pointer is being driven.
	 *
	 * Most of a run's wall clock is model thinking, and during that the machine is safe to
	 * touch. A bar that is up the whole time therefore teaches the operator to ignore it —
	 * so it is only up when it means something.
	 */
	setDriving(driving: boolean): void;
	stop(): void;
}

/** Exported so a test can assert by identity that a hands-off backend got no banner. */
export const NOOP_OVERLAY: Overlay = { async countdown() {}, setDriving() {}, stop() {} };

/**
 * Does this backend's input delivery take the operator's pointer/keyboard?
 *
 * This is the banner's whole gate, and it is keyed on DELIVERY, not on mode or observation
 * channel. cdp injects input over the debug protocol straight into the renderer: the OS
 * pointer never moves, focus never changes, and the run works with the app occluded — a
 * banner there warns about a takeover that is not happening, which trains the operator to
 * ignore the banner that matters. ax (the cua driver) posts real CGEvents — coordinate
 * clicks and drags are pinned foreground in toActionRequest() — so it takes the machine
 * over regardless of what the model was shown; a vision-only (--no-ax) run rides this same
 * delivery and warns like any other ax run.
 *
 * Unknown backends warn. A banner that should not be up is an annoyance; one that should
 * have been up and was not lets a hand into a live run.
 */
export const backendSeizesInput = (backend: string): boolean => backend !== "cdp";

/**
 * The whole gate, pure so it is testable without spawning a JXA child: OVERLAY=0 always
 * wins (recordings where the banner would be in frame), OVERLAY=1 forces the banner up
 * even on a hands-off backend (iterating on the banner itself against a cheap web run),
 * and otherwise the backend's delivery decides.
 */
export const wantOverlay = (backend: string, env: NodeJS.ProcessEnv = process.env): boolean => {
	if (env.OVERLAY === "0") return false;
	if (env.OVERLAY === "1") return true;

	return backendSeizesInput(backend);
};

/** Seconds of warning before a run takes the pointer. COUNTDOWN=0 skips it. */
const COUNTDOWN_SECONDS = envNum("COUNTDOWN", 3);

/**
 * One colour for every mode: red.
 *
 * The banner answers exactly one question — "can I touch this machine right now" — and for
 * a task run, a grounding pass and a diagnostic probe the answer is identically no; all
 * three drive the pointer. Mode-specific colours (orange for explore, violet for probe)
 * implied a difference in that answer and invited reading anything non-red as "safe to
 * interrupt". The MODE is still in the banner's text, where a difference that does not
 * change the answer belongs.
 */
const MODE_RGB = "0.80,0.11,0.18";
const MODES = { drive: MODE_RGB, explore: MODE_RGB, probe: MODE_RGB };

/**
 * Every key the JXA script reads, scraped from its own source.
 *
 * The parent builds the child's env by hand, and a key the script reads but the parent
 * never sets does not fail — read() returns its fallback and the feature silently does
 * nothing. That happened: OVERLAY_PAUSE was missing, so `pauseFile` was "" in the child,
 * the show/hide branch was dead, and the banner stayed up for entire runs while the parent
 * wrote and deleted pause files nobody was reading. Pairing this with overlayEnv() in a
 * test makes the whole class of omission loud instead of invisible.
 */
export const scriptEnvKeys = (): string[] => [
	...new Set([...SCRIPT.matchAll(/read\("(\w+)"/g)].map((m) => m[1])),
];

/** The child's env, extracted from the spawn call so scriptEnvKeys() can be checked against it. */
export const overlayEnv = (
	mode: keyof typeof MODES,
	text: string,
	parentPid: number,
	goFile: string,
	pauseFile: string,
): Record<string, string> => ({
	OVERLAY_TEXT: text,
	OVERLAY_RGB: MODES[mode],
	OVERLAY_PARENT: String(parentPid),
	OVERLAY_COUNTDOWN: String(COUNTDOWN_SECONDS),
	OVERLAY_GO: goFile,
	OVERLAY_PAUSE: pauseFile,
});

/**
 * Show the banner until `stop()`. Never throws and never blocks: if osascript is missing or
 * the panel fails to build, the run proceeds silently.
 *
 * `backend` is required so every caller declares its input delivery: a backend that never
 * touches the operator's pointer (cdp) gets no banner at all — countdown() resolving
 * immediately included, since a "starting in 3" for a run the operator can type through
 * is noise. Set OVERLAY=0 to suppress it unconditionally (recordings where the banner
 * would be in frame); OVERLAY=1 forces it up even for a hands-off backend.
 */
export function startOverlay(mode: keyof typeof MODES, text: string, backend: string): Overlay {
	if (!wantOverlay(backend)) return NOOP_OVERLAY;

	let child: ChildProcess | undefined;
	let stopped = false;
	// Touched to release the countdown. A file, not a signal or a pipe: the JXA process is
	// blocked in its own run loop and this is one bit of state, checked once a second.
	const goFile = `${tmpdir()}/agent-overlay-go-${process.pid}`;
	// Present = hidden. Same one-bit file handshake as goFile: the JXA process sits in its
	// own run loop, so there is no channel to signal it through.
	const pauseFile = `${tmpdir()}/agent-overlay-pause-${process.pid}`;

	/**
	 * Clear both handshake files before the child can read them. They are named by pid and
	 * only stop() removes them, so a run killed with SIGKILL — or a closed terminal — leaves
	 * them in /tmp forever, and macOS recycles pids (they wrap at 99999). A later run that
	 * inherits one of those pids finds its own go-file ALREADY THERE: the child fires the
	 * countdown at launch, it burns down during driver startup while nobody is looking, and
	 * the banner is red by the time the run actually takes the pointer. Reproduced by planting
	 * a go-file: the banner read "Agent exploring Yarn — do not touch" in full mode colour six
	 * seconds before countdown() was called. A stale pause-file is the same hazard mirrored —
	 * the banner starts hidden and the warning never appears at all.
	 */
	try {
		rmSync(goFile, { force: true });
		rmSync(pauseFile, { force: true });
	} catch {}

	try {
		child = spawn("osascript", ["-l", "JavaScript", "-e", SCRIPT], {
			stdio: "ignore",
			env: { ...process.env, ...overlayEnv(mode, text, process.pid, goFile, pauseFile) },
		});
		child.on("error", () => {});
	} catch {
		child = undefined;
	}

	const stop = () => {
		if (stopped) return;
		stopped = true;
		try {
			child?.kill("SIGTERM");
		} catch {}
		try {
			rmSync(goFile, { force: true });
			rmSync(pauseFile, { force: true });
		} catch {}
	};

	// Present = hidden. The banner starts visible; the agent hides it the moment it begins
	// waiting on the model and shows it again around each actuation.
	const setDriving = (driving: boolean): void => {
		if (stopped) return;
		try {
			if (driving) rmSync(pauseFile, { force: true });
			else writeFileSync(pauseFile, "");
		} catch {}
	};

	const countdown = async (): Promise<void> => {
		if (stopped || !(COUNTDOWN_SECONDS > 0)) return;
		try {
			writeFileSync(goFile, "");
		} catch {}
		await new Promise((r) => setTimeout(r, COUNTDOWN_SECONDS * 1000));
	};

	// Belt to the script's own braces: clear it on the paths Node does get to run.
	process.once("exit", stop);

	/**
	 * Clear the banner on a signal, then get out of the way of whoever else is listening.
	 *
	 * The banner is cosmetic; the run's own SIGINT handler (`onInterrupt`, installed AFTER this
	 * in agent/explore/cleanup) is not — it flags a graceful stop so the run log is written, the
	 * app is put back, and the driver session is closed. This handler used to call
	 * `process.exit()` outright, which ran FIRST (it registers first) and killed the process
	 * before that flag was ever read: every Ctrl-C and every `runnerctl stop` skipped teardown
	 * and orphaned the driver session for up to its 300s lifetime — and since OVERLAY is on by
	 * default, that was the default behaviour.
	 *
	 * So: remove the banner, then check whether anyone else is still listening for this signal.
	 * If so (the run's handler), do nothing more and let it own termination. If not (canvas-probe,
	 * which runs the overlay without `onInterrupt`), restore the default action by re-raising —
	 * a bare listener would otherwise SUPPRESS Node's default terminate and hang the probe on
	 * Ctrl-C. `stop()` is idempotent, so the re-raise re-entering here is harmless.
	 */
	for (const sig of ["SIGINT", "SIGTERM"] as const) {
		const onSignal = (): void => {
			stop();
			if (process.listenerCount(sig) > 0) return;
			process.kill(process.pid, sig);
		};
		process.once(sig, onSignal);
	}

	return { countdown, setDriving, stop };
}
