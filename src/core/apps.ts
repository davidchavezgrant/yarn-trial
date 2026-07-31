import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { appmapsDir, appSlug } from "../paths.js";
import { readJsonOr } from "../fsutil.js";
import { isBrowserApp } from "./target.js";

/**
 * What this machine can be pointed at: installed apps, running apps, and grounded web targets.
 *
 * WHY IT IS NOT IN src/ui/. It lived in `ui/ui-core.ts` because the GUI's app picker was its
 * first caller, and that made the runner daemon — `remote/runner/serve.ts`, answering the
 * `apps` verb — import from `src/ui/`: the only BACKWARDS edge in the repo, and not a cosmetic
 * one. `ui-core.ts` reaches `remote/control/appmaps.ts` and through it `remote/control/ssh.ts`,
 * so a colo Mac's daemon statically loaded the operator-laptop SSH machinery (identity paths,
 * known_hosts, control sockets) at boot in order to answer one question about its own
 * /Applications. Nothing here is UI: it shells out to `osascript` and reads directories.
 *
 * `ui-core.ts` re-exports all of it, so the renderer's call sites are unchanged.
 */

export interface AppEntry {
	name: string;
	running: boolean;
	grounded: boolean;
	/**
	 * When the grounding pass ran — `capturedAt` out of the appmap graph, verbatim. Never the
	 * file's mtime: git restamps that on every checkout, so mtime would call a fresh clone
	 * newer than a pass that finished last week. Absent on prose-only maps, which predate the
	 * stamp; the list shows the plain badge for those.
	 */
	groundedAt?: string;
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
 * `capturedAt` out of one appmap graph, or undefined when the file is absent, mid-write, or
 * unstamped.
 *
 * Lives here rather than in `remote/control/appmaps.ts`, which re-exports it: two callers need
 * it — that module's sync comparisons and this module's app list — and they sit on opposite
 * sides of the fleet boundary. One reader is still the point (what counts as "stamped" must
 * not drift between the sync and what the operator sees); the definition simply had to sit at
 * the lower layer, or the runner daemon inherits the fleet's ssh machinery to read a JSON key.
 */
export function readCapturedAt(file: string): string | undefined {
	const parsed = readJsonOr<{ capturedAt?: unknown } | undefined>(file, undefined);

	return typeof parsed?.capturedAt === "string" && parsed.capturedAt ? parsed.capturedAt : undefined;
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
			.map((host) => {
				const groundedAt = readCapturedAt(`${appmapsDir()}/web-${host}.json`);

				return { name: host, running: false, grounded: true, kind: "web" as const, url: `https://${host}`, ...(groundedAt ? { groundedAt } : {}) };
			});
	} catch {
		return [];
	}
}

/** Directories `listApps` enumerates. */
function appDirectories(): string[] {
	return [
		"/Applications",
		"/System/Applications",
		"/System/Applications/Utilities",
		`${process.env.HOME}/Applications`,
	];
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
	for (const dir of appDirectories()) {
		try {
			for (const f of fs.readdirSync(dir)) if (f.endsWith(".app")) installed.add(f.replace(/\.app$/, ""));
		} catch {}
	}

	const apps: AppEntry[] = [...new Set([...installed, ...running])].map((name) => {
		const grounded = fs.existsSync(`${appmapsDir()}/${appSlug(name)}.md`);
		// Only looked for under a map that exists: grounded is the gate, the stamp the detail.
		const groundedAt = grounded ? readCapturedAt(`${appmapsDir()}/${appSlug(name)}.json`) : undefined;

		return {
			name,
			running: running.has(name),
			grounded,
			...(groundedAt ? { groundedAt } : {}),
			...(isBrowserApp(name) ? { browser: true } : {}),
		};
	});

	return [...apps, ...groundedWebTargets()].sort((a, b) => {
		// Grounded first, then running, then alphabetical: likeliest to work at the top.
		if (a.grounded !== b.grounded) return a.grounded ? -1 : 1;
		if (a.running !== b.running) return a.running ? -1 : 1;

		return a.name.localeCompare(b.name);
	});
}
