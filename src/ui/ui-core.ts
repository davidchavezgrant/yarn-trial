import { execFileSync, spawn as spawnProcess, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { appSlug, auditTaskPrompt, mintRunKey } from "../core/harness.js";
import { appmapsDir, dataRoot, outDir, resourcesRoot } from "../paths.js";
import { readJsonOr } from "../fsutil.js";
// One capturedAt reader for the whole codebase — the sync's. A second parser here could
// disagree with it about what counts as stamped. It is a pure local-file read; importing it
// pulls no ssh behaviour into the local shell, at module load or at call time.
import { readCapturedAt } from "../remote/control/appmaps.js";
import { buildRunArgs, isBrowserApp, type Target, webTarget } from "../core/target.js";

/**
 * Host-side logic for the Electron shell: app enumeration, the recorded-run gallery, the
 * single-run guard, and spawning the agent.
 *
 * Kept separate from `electron/main.ts` because none of it needs Electron — it is plain
 * Node, and testable as such. The single-run guard is not a UI nicety: a second driver
 * session shuts down the shared daemon and kills the run already in flight
 * (LIMITATIONS §6), so the shell must refuse rather than queue.
 */

/**
 * App inventory moved to `src/core/apps.ts` and is re-exported here, so every renderer and
 * IPC call site is unchanged. It had to leave this file because the runner daemon answers the
 * same `apps` query: importing it from `src/ui/` was the repo's only backwards edge, and it
 * quietly loaded the fleet's ssh machinery onto a colo Mac. See that file's header.
 */
export { type AppEntry, listApps } from "../core/apps.js";


export interface PastRun {
	id: string;
	app: string;
	task: string;
	success: boolean;
	actions: number;
	verified: number;
	elapsedSec: number;
	grounding: string;
	visual?: string;
	/** Repo-relative path to the run's mp4, when it was recorded. */
	video?: string;
	/**
	 * Repo-relative path to the humanized render (the `npm run humanize` output beside the raw
	 * capture), present only once that pass has produced it. The gallery keys everything off
	 * this field's presence: default playback, the Humanized/Raw toggle, and whether to offer
	 * the "Render human cursor" button at all.
	 */
	humanized?: string;
	/**
	 * Whether the source artifacts a render needs (frames/, trajectory/) exist locally. The
	 * gallery offers "render cursor" only when they do — a button whose only possible outcome
	 * is "no frames" is an error taught as a feature.
	 */
	renderable?: boolean;
	/**
	 * ISO instant the run began: the first step's timestamp when the log has one, else the
	 * instant recovered from the stamp itself (see stampTime), else "". The renderer turns it
	 * into the card's "2h ago" label, so "" simply means no label.
	 */
	startedAt: string;
}

/**
 * The instant encoded in a run stamp, as a real ISO string — or undefined for an id that
 * carries none.
 *
 * mintRunKey builds the stamp by folding `new Date().toISOString()`'s `:` and `.` into `-`,
 * so the prefix of every run id is a UTC datetime wearing filename-safe punctuation. Undoing
 * the fold recovers it exactly. Both stamp generations are handled: millisecond precision
 * (`2026-07-30T23-19-59-123-yarn`, minted after the precision bump) and the older
 * seconds-only shape (`2026-07-30T17-31-22-yarn`). The trailing `Z` matters — the stamp is
 * UTC, and without it Date() would read the time as local and shift every label by the
 * timezone offset.
 *
 * The optional millis group must be followed by `-` or end-of-string so a three-digit
 * fragment inside an app slug cannot be mistaken for it; an app slug that itself starts with
 * three digits is misread as millis, which errs by under a second and is accepted.
 */
export function stampTime(id: string): string | undefined {
	const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?(?=-|$)/.exec(id);
	if (!m) return undefined;

	return `${m[1]}T${m[2]}:${m[3]}:${m[4]}${m[5] ? `.${m[5]}` : ""}Z`;
}

/**
 * Recorded runs, newest first, for the gallery.
 *
 * Only runs with a video are listed: the gallery exists to play them back, and a run log
 * without one is already readable in `out/runs/`. The task text ships with each entry
 * because a video of a settings page is meaningless without the prompt that produced it —
 * that pairing is the whole point of showing them together.
 */
export function listRecordedRuns(limit = 40): PastRun[] {
	const dir = `${outDir()}/runs`;
	if (!fs.existsSync(dir)) return [];

	const out: PastRun[] = [];
	for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort().reverse()) {
		if (out.length >= limit) break;
		const d: any = readJsonOr(`${dir}/${f}`, undefined);
		if (d === undefined) continue; // a half-written log during a live run is not an error worth surfacing
		if (!d.video || !fs.existsSync(`${dataRoot()}/${d.video}`)) continue;
		// The humanize pass writes its render beside the raw capture, so the path is derived from
		// the video's own directory rather than rebuilt from the id — one source of truth for
		// where a run's recording lives. Existence is checked per scan, not cached: the file
		// appears when a render finishes and the next gallery poll must see it.
		const recordingDir = path.posix.dirname(d.video);
		const humanized = `${recordingDir}/humanized.mp4`;
		const renderable =
			fs.existsSync(`${dataRoot()}/${recordingDir}/frames`) && fs.existsSync(`${dataRoot()}/${recordingDir}/trajectory`);
		const id = f.replace(/\.json$/, "");
		out.push({
			id,
			app: d.app ?? "",
			task: d.task ?? "",
			success: !!d.success,
			actions: Array.isArray(d.steps) ? d.steps.length : 0,
			verified: d.verifiedSteps ?? 0,
			elapsedSec: d.elapsedSec ?? 0,
			grounding: d.grounding?.provenance ?? "none",
			visual: d.visualCheck?.verdict,
			video: d.video,
			...(fs.existsSync(`${dataRoot()}/${humanized}`) ? { humanized } : {}),
			...(renderable ? { renderable } : {}),
			// `||`, not `??`: an empty-string timestamp on step 0 must fall through to the stamp,
			// which encodes the same instant for every run that crashed before writing a step.
			startedAt: d.steps?.[0]?.timestamp || stampTime(id) || "",
		});
	}

	return out;
}

/**
 * Resolve a repo-relative video path for serving, rejecting anything outside out/recording.
 * The path arrives from the renderer, so it is untrusted even though the renderer is ours.
 */
export function resolveVideo(rel: string): string | undefined {
	const root = `${outDir()}/recording/`;
	const full = path.resolve(dataRoot(), rel);
	if (!full.startsWith(root) || !full.endsWith(".mp4") || !fs.existsSync(full)) return undefined;

	return full;
}

export type ByteRange = { kind: "whole" } | { kind: "part"; start: number; end: number } | { kind: "unsatisfiable" };

/**
 * Interpret a Range header against a file of `size` bytes.
 *
 * Here rather than inline in the protocol handler so the suffix case is testable: a suffix
 * range (`bytes=-500`) names the LAST 500 bytes, and parsing it as 0–500 serves the head of
 * the file labelled as its tail. Chromium's media stack mostly asks `bytes=N-`, which is why
 * that mistake can sit latent until some player sends the other form.
 *
 * Anything unparseable answers `whole` — a full 200 is always a correct response to a Range
 * the server did not understand — and `unsatisfiable` maps to 416.
 */
export function parseByteRange(header: string | null, size: number): ByteRange {
	const m = header ? /bytes=(\d*)-(\d*)/.exec(header) : null;
	if (!m || (!m[1] && !m[2])) return { kind: "whole" };
	const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
	const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
	if (start >= size || start > end) return { kind: "unsatisfiable" };

	return { kind: "part", start, end };
}

/** What the middle column held for one app: the typed task, and the log pane's scrollback. */
export interface AppUiState {
	task: string;
	log: string[];
	/**
	 * The site a browser target was pointed at. Only meaningful when the app is a browser.
	 *
	 * Needs its own branch in `pruneUiState` below, and that is the whole reason this comment
	 * exists: prune rebuilds each entry field by field and silently drops anything it does not
	 * know, so a field added here and forgotten there vanishes on the next save with no error —
	 * the user would retype the URL every time they switched apps and never learn why.
	 */
	url?: string;
}

export interface UiState {
	/** App selected when the shell last closed, reselected on launch. */
	lastApp?: string;
	byApp: Record<string, AppUiState>;
}

const STATE_PATH = (): string => `${outDir()}/ui-state.json`;

/**
 * Per-app scrollback cap. A grounding pass emits a few hundred lines, so this keeps a whole
 * recent run while bounding the file — the alternative is a state blob that grows for the
 * life of the checkout.
 */
const LOG_LINES_KEPT = 400;

/**
 * Read persisted UI state. Every field is re-validated rather than trusted: the file is
 * hand-editable and a malformed one must degrade to "no memory", never break the shell.
 */
export function readUiState(): UiState {
	// An absent or corrupt file prunes to the same empty state a fresh install starts with.
	return pruneUiState(readJsonOr(STATE_PATH(), {}));
}

/**
 * Coerce untrusted input to the shape, cap scrollback, and drop entries holding nothing.
 *
 * Rebuilds each entry field by field — so a field the renderer writes but this function
 * omits looks safe in the page and silently fails to round-trip. When adding a field to
 * the UI state, it must appear in BOTH the renderer's save shape and here.
 */
export function pruneUiState(raw: any): UiState {
	const byApp: Record<string, AppUiState> = {};
	for (const [app, v] of Object.entries(raw?.byApp ?? {})) {
		const entry = v as Partial<AppUiState>;
		const task = typeof entry?.task === "string" ? entry.task : "";
		const log = (Array.isArray(entry?.log) ? entry.log : []).filter((l): l is string => typeof l === "string");
		const url = typeof entry?.url === "string" && entry.url ? entry.url : undefined;
		// A remembered URL is worth keeping an entry alive for: it is the whole target of a
		// browser run, and dropping it would silently clear the box on the next launch.
		if (!task && !log.length && !url) continue;
		byApp[app] = { task, log: log.slice(-LOG_LINES_KEPT), ...(url ? { url } : {}) };
	}

	return { ...(typeof raw?.lastApp === "string" ? { lastApp: raw.lastApp } : {}), byApp };
}

export function writeUiState(raw: unknown): void {
	try {
		fs.mkdirSync(path.dirname(STATE_PATH()), { recursive: true });
		fs.writeFileSync(STATE_PATH(), JSON.stringify(pruneUiState(raw), null, 2));
	} catch {
		// Losing UI memory is not worth interrupting a run for.
	}
}

export interface RunOptions {
	app: string;
	task: string;
	record: boolean;
	noVision: boolean;
	/**
	 * Render the humanized cursor over the recording once the run completes. Meaningless
	 * without `record`; the render itself happens on the OPERATOR's Mac either way, since a
	 * remote run's recording is pulled home before its `done` fires.
	 */
	humanize?: boolean;
	/**
	 * Set when the target is a website rather than an installed app. Additive on purpose: `app`
	 * stays the display label and the `byApp` key, because the renderer uses that string as an
	 * identity in four places and `pruneUiState` silently drops anything it does not recognise —
	 * a `Target` object here would stop selection persisting with no error to show for it.
	 */
	url?: string;
}

export interface RunHandlers {
	onLine(line: string): void;
	onDone(code: number | null, elapsedSec: number): void;
	/**
	 * The dispatch resolved `auto` (or an alias) to a concrete machine. Optional because only
	 * the remote controller ever learns something here — a local run's host is `local` before
	 * it starts. The shell uses this to move the run's bookkeeping onto the real host name, so
	 * a second run can be dispatched to `auto` while this one is still going.
	 */
	onHost?(host: string): void;
}

/**
 * Reassemble whole lines from a stream that arrives in arbitrary pieces.
 *
 * A process writes bytes, not rows. Splitting each chunk on "\n" independently emits
 * `[12] click` and ` "Save" ✓ verified` as two separate lines — neither matches the step
 * pattern the log pane colours by, so a torn step silently loses its formatting and reads as
 * two unrelated fragments. The carry buffer is the whole fix: hold the tail until its newline
 * actually arrives.
 *
 * Lives here rather than beside its first caller in `ui-remote.ts` because the LOCAL run path
 * needs it too and this module may not depend on the remote stack. `ui-remote.ts` re-exports
 * it, so the name and its tests are unchanged.
 */
export class LineSplitter {
	private pending = "";

	push(text: string): string[] {
		this.pending += text;
		const parts = this.pending.split("\n");
		this.pending = parts.pop() ?? "";

		return parts.filter((l) => l.trim());
	}

	/** The last line of a log rarely ends in a newline. Called once the stream is finished. */
	flush(): string[] {
		const rest = this.pending;
		this.pending = "";

		return rest.trim() ? [rest] : [];
	}
}

/**
 * A child stream's bytes, delivered as intact lines.
 *
 * Two independent corruptions live at a chunk boundary and the log pane showed both. The line
 * tearing is `LineSplitter`'s job above. The second is narrower and worse-looking: a boundary
 * that falls INSIDE a multi-byte character makes `Buffer.toString()` emit replacement
 * characters, and every verdict this agent prints is a ✓ or a ✗ — three bytes each. A chunk cut
 * mid-glyph turned `✓ verified` into `�� verified`, which reads as a failed run. `StringDecoder`
 * holds the partial code point instead.
 */
export function streamPump(emit: (line: string) => void): { push: (buf: Buffer) => void; end: () => void } {
	const decoder = new StringDecoder("utf8");
	const splitter = new LineSplitter();

	return {
		push: (buf) => {
			for (const line of splitter.push(decoder.write(buf))) emit(line);
		},
		end: () => {
			for (const line of splitter.push(decoder.end())) emit(line);
			for (const line of splitter.flush()) emit(line);
		},
	};
}

/** Holds the single in-flight run. Both shells share one instance. */
export class RunController {
	private current: { child: ChildProcess; startedAt: number } | undefined;
	private stamp: string | undefined;

	get active(): boolean {
		return this.current !== undefined;
	}

	/**
	 * The run key of the most recent task run — kept after it ends, because the moment a
	 * caller needs it (rendering the recording it named) is the moment the run is over.
	 */
	get lastStamp(): string | undefined {
		return this.stamp;
	}

	/**
	 * Validate and start. Returns an error string instead of throwing, because every
	 * caller renders it in the UI rather than crashing the shell.
	 */
	start(opts: RunOptions, handlers: RunHandlers): string | undefined {
		if (this.current) return "a run is already in progress — driver sessions are not concurrent-safe (LIMITATIONS §6)";

		const app = opts.app.trim();
		const task = opts.task.trim();
		if (!app || !task) return "pick an app and enter a task";

		// The real hygiene gate. The renderer mirrors it for immediate feedback, but a
		// hinted prompt must be refused here even if that mirror is bypassed.
		const audit = auditTaskPrompt(task);
		if (audit.hinted) return `prompt states method, not just the goal — ${audit.reasons.join("; ")}`;

		let target: Target;
		try {
			target = opts.url ? webTarget(opts.url) : { kind: "app", name: app };
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}

		// The stamp is minted HERE, not left for the agent, so the shell knows the recording
		// directory of the run it just started — the humanize-after-run hook needs it the
		// moment `done` fires, and scraping it back out of the child's stdout is a parse that
		// breaks the day the log line changes shape.
		this.stamp = mintRunKey("", app);

		return this.spawn(["tsx", "src/core/agent.ts", ...buildRunArgs(target, { task, record: opts.record, noVision: opts.noVision })], handlers, this.stamp);
	}

	/**
	 * Grounding pass for an app. Shares the single-run guard with start(): exploration
	 * drives the same driver, so running one alongside a task would kill both
	 * (LIMITATIONS §6). Overwrites docs/appmaps/<app>.{md,json}.
	 */
	explore(app: string, handlers: RunHandlers, url?: string): string | undefined {
		if (this.current) return "a run is already in progress — driver sessions are not concurrent-safe (LIMITATIONS §6)";
		if (!app.trim() && !url) return "pick an app to ground";

		let target: Target;
		try {
			target = url ? webTarget(url) : { kind: "app", name: app.trim() };
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}

		return this.spawn(["tsx", "src/core/explore.ts", ...buildRunArgs(target)], handlers);
	}

	/** Shared launcher for task runs and grounding passes. */
	private spawn(args: string[], handlers: RunHandlers, stamp?: string): undefined {
		// No shell: task text is user input and passes through as a single argv entry.
		// cwd is the checkout rather than ours: `src/core/explore.ts` in the argv is resolved
		// relative to it, and under a LaunchAgent our own cwd is `/`.
		const child = spawnProcess("npx", args, {
			cwd: resourcesRoot(),
			// RUN_STAMP is how the child adopts the key we minted — the same contract the
			// runner's dispatcher uses. Absent for passes whose key nobody needs to predict.
			env: stamp ? { ...process.env, RUN_STAMP: stamp } : process.env,
		});
		const startedAt = Date.now();
		this.current = { child, startedAt };

		// One decoder and one splitter PER STREAM. Sharing a single pair across stdout and
		// stderr would splice one stream's partial line onto the other's next chunk, which is
		// the same defect in a form that is much harder to spot in a log.
		const out = streamPump(handlers.onLine);
		const err = streamPump(handlers.onLine);
		child.stdout?.on("data", out.push);
		child.stderr?.on("data", err.push);

		// Settle exactly once. A child that cannot be spawned emits `error` and then `close`,
		// and a second onDone would tell the page a run it is no longer watching has ended.
		let settled = false;
		const settle = (code: number | null): void => {
			if (settled) return;
			settled = true;
			this.current = undefined;
			// Flush before reporting: a process's final line usually has no trailing newline, so
			// without this the last thing the agent said — often the reason it stopped — is lost.
			out.end();
			err.end();
			handlers.onDone(code, Math.round((Date.now() - startedAt) / 1000));
		};
		// Without this listener a child that will not spawn — `npx` missing from a packaged
		// app's PATH, no toolchain on a fresh Mac — raises an unhandled 'error' event, which
		// throws out of the Electron main process and takes the whole shell down with it. It
		// also left `current` set, so even a survivable failure latched the UI as busy forever.
		child.on("error", (e) => {
			handlers.onLine(`✗ could not start the run: ${e.message}`);
			settle(1);
		});
		child.on("close", settle);

		return undefined;
	}

	stop(): void {
		this.current?.child.kill("SIGINT");
	}
}

/** One recording's render state. A stamp absent from the map is idle — never rendered this session. */
export type HumanizeState =
	| { state: "rendering" }
	| { state: "failed"; error: string }
	| { state: "done" };

/**
 * How many humanize passes may run at once.
 *
 * Two is a bound on fan-out, not a tuned number: each render pins a core streaming raw rgb24
 * into ffmpeg, and a gallery's worth of clicks must not become a render per card.
 */
const HUMANIZE_CONCURRENCY = 2;

/**
 * Spawns `npm run humanize`'s work (tsx src/cursor/humanize.ts <stamp>) for gallery cards.
 *
 * Deliberately NOT behind RunController's single-run guard: that guard exists because two
 * driver sessions kill each other (LIMITATIONS §6), and a humanize pass opens no driver
 * session — it is local ffmpeg/CPU work over files a finished run left behind, safe to run
 * while an agent run is in flight. Its own guards are narrower: never two renders of the SAME
 * stamp (they would race on motion-track.json and humanized.mp4), and a small cap across
 * different stamps.
 *
 * States survive after settle rather than being deleted, so the renderer's poll can see
 * `failed` (and its last error line) instead of a job that silently vanished. The map is
 * bounded by the gallery size in practice — one entry per stamp ever rendered this session.
 */
export class HumanizeController {
	private readonly states = new Map<string, HumanizeState>();

	/**
	 * Start the render for a recorded run's stamp. Returns an error string instead of throwing:
	 * the reply crosses IPC and the renderer paints it, so nothing here may take the main
	 * process down.
	 */
	start(stamp: string): string | undefined {
		const id = stamp.trim();
		// The stamp names a directory under out/recording and rides into argv; anything that is
		// not stamp-shaped (path separators, a leading dash that reads as a flag) is refused here
		// rather than passed along to become a confusing child-process error.
		if (!/^[A-Za-z0-9][\w.-]*$/.test(id)) return "not a run stamp";
		if (this.states.get(id)?.state === "rendering") return `already rendering ${id}`;
		const inFlight = [...this.states.values()].filter((s) => s.state === "rendering").length;
		if (inFlight >= HUMANIZE_CONCURRENCY) return `${HUMANIZE_CONCURRENCY} renders already in flight — wait for one to finish`;

		this.states.set(id, { state: "rendering" });

		let child: ChildProcess;
		try {
			child = this.launch(id);
		} catch (err) {
			// spawn() itself can throw (EMFILE and friends) before a child exists to emit 'error'.
			const msg = err instanceof Error ? err.message : String(err);
			this.states.set(id, { state: "failed", error: msg });

			return `could not start the render: ${msg}`;
		}

		// The card's failed state shows ONE line. humanize.ts exits nonzero right after a
		// console.error naming the missing input (no motion constants, no trajectory turns, no
		// frames), so the last stderr line is the diagnosis; the last stdout line is the fallback
		// for a child that died without one.
		let lastErr = "";
		let lastOut = "";
		const errPump = streamPump((l) => (lastErr = l));
		const outPump = streamPump((l) => (lastOut = l));
		child.stdout?.on("data", outPump.push);
		child.stderr?.on("data", errPump.push);

		// Settle exactly once: a child that cannot be spawned emits `error` and then `close`, and
		// the second event must not overwrite a failure with "exited with code null".
		let settled = false;
		const settle = (code: number | null): void => {
			if (settled) return;
			settled = true;
			// Flush before reporting — the reason a render died is usually its unterminated last line.
			outPump.end();
			errPump.end();
			this.states.set(id, code === 0 ? { state: "done" } : { state: "failed", error: lastErr || lastOut || `exited with code ${code}` });
		};
		child.on("error", (e) => {
			// Stream output wins when there is any; this message covers the no-toolchain case
			// where npx never produced a byte.
			lastErr = lastErr || `could not start the render: ${e.message}`;
			settle(1);
		});
		child.on("close", settle);

		return undefined;
	}

	/** Snapshot for the renderer's poll. A plain object because it crosses IPC. */
	status(): Record<string, HumanizeState> {
		return Object.fromEntries(this.states);
	}

	/** The real launch, patched out in tests the way RunController.spawn is. */
	private launch(stamp: string): ChildProcess {
		// Same launch shape as RunController.spawn: no shell (the stamp passes as one argv
		// entry), cwd is the checkout so tsx resolves src/cursor/humanize.ts — and so humanize.ts's own
		// cwd-derived out/ and data/ land where the gallery reads them.
		return spawnProcess("npx", ["tsx", "src/cursor/humanize.ts", stamp], { cwd: resourcesRoot(), env: process.env });
	}
}
