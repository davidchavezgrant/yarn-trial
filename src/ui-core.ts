import { execFileSync, spawn as spawnProcess, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { appSlug, auditTaskPrompt } from "./harness.js";
import { appmapsDir, dataRoot, outDir, resourcesRoot } from "./paths.js";
import { buildRunArgs, isBrowserApp, type Target, webTarget } from "./target.js";

/**
 * Host-side logic for the Electron shell: app enumeration, the recorded-run gallery, the
 * single-run guard, and spawning the agent.
 *
 * Kept separate from `electron/main.ts` because none of it needs Electron — it is plain
 * Node, and testable as such. The single-run guard is not a UI nicety: a second driver
 * session shuts down the shared daemon and kills the run already in flight
 * (LIMITATIONS §6), so the shell must refuse rather than queue.
 */

export interface AppEntry {
	name: string;
	running: boolean;
	grounded: boolean;
	/**
	 * Absent means an installed Mac app — the only kind that existed before web targets, and
	 * the reason this is optional rather than required: every reader treats the entry field by
	 * field, so an absent discriminant keeps the app path byte-identical.
	 */
	kind?: "app" | "web";
	/** Web entries only: what to navigate to. The name stays the host, for display and keying. */
	url?: string;
	/**
	 * This app is a browser, so it needs a URL before it is a runnable target.
	 *
	 * Computed here rather than in the renderer, which cannot import: the browser list would
	 * otherwise have to be duplicated into a string literal and kept in sync by hand.
	 */
	browser?: boolean;
}

/**
 * Sites that have been explored, recovered from the appmaps they left behind.
 *
 * A web target has nothing to enumerate — there is no `/Applications` for the web, and a site
 * is not "installed". What we can enumerate is evidence that we have *grounded* one, which is
 * exactly the set worth offering in a picker: those runs will be grounded rather than
 * cold-start. Anything else the operator types as a URL.
 *
 * The origin is reconstructed as https, which is the scheme every real target uses and the one
 * `explore` would have been pointed at. A site only reachable over http has to be re-typed —
 * acceptable, since the slug deliberately keeps only the host.
 */
function groundedWebTargets(): AppEntry[] {
	try {
		return fs
			.readdirSync(appmapsDir())
			.filter((f) => f.startsWith("web-") && f.endsWith(".md"))
			.map((f) => f.slice("web-".length, -".md".length))
			.filter((host) => host.length > 0)
			.map((host) => ({ name: host, running: false, grounded: true, kind: "web" as const, url: `https://${host}` }));
	} catch {
		return [];
	}
}

/**
 * Installed apps ∪ currently-running apps. Running ones are surfaced because the driver
 * can only reach a target on the active Space (LIMITATIONS §1), so "already open" is a
 * real signal about whether a run will work, not decoration.
 */
export function listApps(): AppEntry[] {
	const running = new Set<string>();
	try {
		const out = execFileSync(
			"osascript",
			["-e", 'tell application "System Events" to get name of every process whose background only is false'],
			{ encoding: "utf8", timeout: 5000 },
		);
		for (const n of out.split(",")) running.add(n.trim());
	} catch {
		// Missing automation permission is not fatal — the list just loses its badges.
	}

	const installed = new Set<string>();
	for (const dir of [
		"/Applications",
		"/System/Applications",
		"/System/Applications/Utilities",
		`${process.env.HOME}/Applications`,
	]) {
		try {
			for (const f of fs.readdirSync(dir)) if (f.endsWith(".app")) installed.add(f.replace(/\.app$/, ""));
		} catch {}
	}

	const apps: AppEntry[] = [...new Set([...installed, ...running])].map((name) => ({
		name,
		running: running.has(name),
		grounded: fs.existsSync(`${appmapsDir()}/${appSlug(name)}.md`),
		...(isBrowserApp(name) ? { browser: true } : {}),
	}));

	return [...apps, ...groundedWebTargets()].sort((a, b) => {
		// Grounded first, then running, then alphabetical: likeliest to work at the top.
		if (a.grounded !== b.grounded) return a.grounded ? -1 : 1;
		if (a.running !== b.running) return a.running ? -1 : 1;

		return a.name.localeCompare(b.name);
	});
}

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
	startedAt: string;
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
		let d: any;
		try {
			d = JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8"));
		} catch {
			continue; // a half-written log during a live run is not an error worth surfacing
		}
		if (!d.video || !fs.existsSync(`${dataRoot()}/${d.video}`)) continue;
		out.push({
			id: f.replace(/\.json$/, ""),
			app: d.app ?? "",
			task: d.task ?? "",
			success: !!d.success,
			actions: Array.isArray(d.steps) ? d.steps.length : 0,
			verified: d.verifiedSteps ?? 0,
			elapsedSec: d.elapsedSec ?? 0,
			grounding: d.grounding?.provenance ?? "none",
			visual: d.visualCheck?.verdict,
			video: d.video,
			startedAt: d.steps?.[0]?.timestamp ?? "",
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
	try {
		return pruneUiState(JSON.parse(fs.readFileSync(STATE_PATH(), "utf8")));
	} catch {
		return { byApp: {} };
	}
}

/** Coerce untrusted input to the shape, cap scrollback, and drop entries holding nothing. */
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
}

/** Holds the single in-flight run. Both shells share one instance. */
export class RunController {
	private current: { child: ChildProcess; startedAt: number } | undefined;

	get active(): boolean {
		return this.current !== undefined;
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

		return this.spawn(["tsx", "src/agent.ts", ...buildRunArgs(target, { task, record: opts.record, noVision: opts.noVision })], handlers);
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

		return this.spawn(["tsx", "src/explore.ts", ...buildRunArgs(target)], handlers);
	}

	/** Shared launcher for task runs and grounding passes. */
	private spawn(args: string[], handlers: RunHandlers): undefined {
		// No shell: task text is user input and passes through as a single argv entry.
		// cwd is the checkout rather than ours: `src/explore.ts` in the argv is resolved
		// relative to it, and under a LaunchAgent our own cwd is `/`.
		const child = spawnProcess("npx", args, { cwd: resourcesRoot(), env: process.env });
		const startedAt = Date.now();
		this.current = { child, startedAt };

		const pump = (buf: Buffer) => {
			for (const line of buf.toString().split("\n")) if (line.trim()) handlers.onLine(line);
		};
		child.stdout?.on("data", pump);
		child.stderr?.on("data", pump);
		child.on("close", (code) => {
			this.current = undefined;
			handlers.onDone(code, Math.round((Date.now() - startedAt) / 1000));
		});

		return undefined;
	}

	stop(): void {
		this.current?.child.kill("SIGINT");
	}
}
