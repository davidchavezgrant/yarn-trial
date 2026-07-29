import { execFileSync, spawn as spawnProcess, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { appSlug, auditTaskPrompt } from "./harness.js";

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

	return [...new Set([...installed, ...running])]
		.map((name) => ({
			name,
			running: running.has(name),
			grounded: fs.existsSync(`${process.cwd()}/docs/appmaps/${appSlug(name)}.md`),
		}))
		.sort((a, b) => {
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
	const dir = `${process.cwd()}/out/runs`;
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
		if (!d.video || !fs.existsSync(`${process.cwd()}/${d.video}`)) continue;
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
	const root = `${process.cwd()}/out/recording/`;
	const full = path.resolve(process.cwd(), rel);
	if (!full.startsWith(root) || !full.endsWith(".mp4") || !fs.existsSync(full)) return undefined;

	return full;
}

export interface RunOptions {
	app: string;
	task: string;
	record: boolean;
	noVision: boolean;
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

		const args = ["tsx", "src/agent.ts", task, app];
		if (opts.record) args.push("--record");
		if (opts.noVision) args.push("--no-vision");

		return this.spawn(args, handlers);
	}

	/**
	 * Grounding pass for an app. Shares the single-run guard with start(): exploration
	 * drives the same driver, so running one alongside a task would kill both
	 * (LIMITATIONS §6). Overwrites docs/appmaps/<app>.{md,json}.
	 */
	explore(app: string, handlers: RunHandlers): string | undefined {
		if (this.current) return "a run is already in progress — driver sessions are not concurrent-safe (LIMITATIONS §6)";
		if (!app.trim()) return "pick an app to ground";

		return this.spawn(["tsx", "src/explore.ts", app.trim()], handlers);
	}

	/** Shared launcher for task runs and grounding passes. */
	private spawn(args: string[], handlers: RunHandlers): undefined {
		// No shell: task text is user input and passes through as a single argv entry.
		const child = spawnProcess("npx", args, { cwd: process.cwd(), env: process.env });
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
