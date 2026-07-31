import { appSlug, outDir } from "../../paths.js";

/**
 * Snapshot at load, unlike the accessors in paths.ts: this is a CLI process whose data root
 * is fixed before it starts (by `run`, or by the LaunchAgent plist), and dozens of call
 * sites interpolate it as a plain string.
 */
export const OUT = outDir();

/**
 * What agent.ts exits with when the app is not at its declared home state.
 *
 * A CROSS-MACHINE contract, like the codes in runner/ctl.ts: the agent exits with it on a colo
 * Mac and the client on the laptop reads the number to decide whether to offer a sign-in. Two
 * independent copies of the literal is a protocol that drifts the first time one of them moves,
 * so there is one and both ends import it.
 */
export const UNREADY_EXIT = 3;

/**
 * The key every artifact of one run shares: `out/runs/<key>.json`, `out/recording/<key>/`,
 * and — when the run was dispatched rather than started by hand — `out/jobs/<key>/`.
 *
 * `RUN_STAMP` exists so a dispatcher can decide the key BEFORE the child exists. Without it
 * the runner would have to guess which log a spawned process went on to write, and guessing
 * by "newest file in out/runs" is wrong the moment two runs land in the same second or a
 * previous run failed before writing anything. The child still owns the format; the caller
 * only pre-commits to a value.
 */
export function runKey(prefix: string, app: string): string {
	const override = process.env.RUN_STAMP?.trim();
	if (override) return override;

	return mintRunKey(prefix, app);
}

/**
 * The same key, minted rather than inherited. Separate from `runKey` because the runner is a
 * long-lived process that mints an id per job and then hands it to the child as `RUN_STAMP`:
 * if it ever read that variable out of its own environment — a launchd plist, a shell that
 * exported it once — every job it started would share one id, one job directory and one log.
 */
let _lastMintMs = 0;
let _mintDedup = 0;

export function mintRunKey(prefix: string, app: string): string {
	// Milliseconds, not seconds. `runKey`'s own comment names "two runs land in the same second"
	// as the collision RUN_STAMP exists to avoid — and a runner dispatching several jobs, or an
	// explore and an agent run started together, does exactly that. At seconds precision both
	// mint one key and clobber each other's run log, recording and job directory. The ISO string
	// is `...T23-19-59.123Z`; taking 23 chars keeps the millis, and `:`/`.` are folded to `-`.
	const now = new Date();
	const ms = now.getTime();
	// Even at millisecond precision a tight dispatch loop can mint twice inside one millisecond.
	// A per-process counter disambiguates only that case, so the common path keeps the clean
	// `...-123-app` shape and only a genuine collision gets a `-1`/`-2` suffix. Monotonic within
	// the process, which is where the runner mints; across processes the millis already differ
	// because two OS processes do not start a job on the same millisecond and the same clock.
	_mintDedup = ms === _lastMintMs ? _mintDedup + 1 : 0;
	_lastMintMs = ms;
	const suffix = _mintDedup > 0 ? `-${_mintDedup}` : "";

	return `${prefix}${now.toISOString().replace(/[:.]/g, "-").slice(0, 23)}${suffix}-${appSlug(app)}`;
}

/**
 * Make SIGINT and SIGTERM a clean stop instead of an instant kill, and report whether one
 * has arrived.
 *
 * Node's default action for both is to terminate the process on the spot, so every `finally`
 * in the script is skipped: the driver session stays open until its own 300-second lifetime
 * expires, and the run writes no log at all. That is not hypothetical — `runnerctl stop`
 * signals the whole process group, so under the default a stopped run would be both invisible
 * to the gallery and a hazard to whichever job started next on that Mac.
 *
 * The handler only sets a flag. The caller reads it between actions and leaves through its
 * ordinary cleanup path, which is what keeps the run log. `graceMs` covers the case the flag
 * cannot: a signal landing in the middle of a model call, where nothing will read it for
 * several seconds. At that deadline the session is closed directly and the process exits —
 * the value sits below the runner's own SIGINT→SIGKILL interval so that this, and not
 * SIGKILL, is what ends the run.
 *
 * The backstop stands down the moment the checker reports the signal: a loop that has read
 * the flag owns cleanup from then on, and cleanup legitimately outlives the grace window —
 * ffmpeg assembly alone can take longer than 8s, and force-killing it mid-write destroys the
 * run log this function exists to preserve. The timer only ever fires when nothing polls the
 * flag at all; a second signal still exits immediately.
 */
export function onInterrupt(closeDriver: () => Promise<void>, graceMs = 8000): () => boolean {
	let interrupted = false;
	let backstop: NodeJS.Timeout | undefined;

	for (const sig of ["SIGINT", "SIGTERM"] as const) {
		process.on(sig, () => {
			// A second signal is an operator saying the first one did not work. Honour it.
			if (interrupted) process.exit(130);
			interrupted = true;
			console.log(`\n=== ${sig} received — finishing the current action and stopping ===`);
			backstop = setTimeout(() => {
				console.log("=== cleanup did not finish in time; closing the driver session ===");
				closeDriver().finally(() => process.exit(130));
			}, graceMs);
			backstop.unref();
		});
	}

	return () => {
		// The caller reading a true flag IS the acknowledgement: cleanup is now in hands that
		// keep the run log, so the backstop would only destroy what it exists to protect.
		if (interrupted && backstop) {
			clearTimeout(backstop);
			backstop = undefined;
		}

		return interrupted;
	};
}
