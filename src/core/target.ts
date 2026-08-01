import { appSlug } from "../paths.js";

/**
 * What a run is pointed at.
 *
 * Until now this was a bare app-name string, launched with `launch_app {name}` and matched
 * against `w.app_name`. That works for a Mac app and breaks for a website: the target would
 * be the *browser*, so `appSlug("Google Chrome")` collides every site on the web onto one
 * appmap, and the frontier fills with the tab strip and Chrome's own menu bar rather than the
 * app under test.
 *
 * A web target is therefore a distinct KIND rather than a specially-formatted app name. The
 * discriminant is what lets `explore`/`agent` choose between `launch_app` + `findWindow` and
 * the browser-acquisition path, without either one sniffing the string for "https".
 *
 * `cdpAttach` is a FIELD rather than a third kind on purpose: an Electron app reached over
 * a debug port is still the same app — same slug, same appmap, same artifact paths — so
 * every consumer that switches on the kind must keep treating it as an app. The field only
 * tells the cdp backend's acquisition that it may LAUNCH the app with
 * `--remote-debugging-port` (src/backends/electron-attach.ts); WHICH backend runs remains
 * the runner's decision, exactly as it is for web targets.
 */
export type Target =
	| { kind: "app"; name: string; cdpAttach?: boolean }
	| { kind: "web"; url: string; origin: string };

/**
 * Only what `browser_navigate` itself accepts. The driver refuses anything else with
 * "browser_navigate only accepts http/https/about URLs", and catching it here turns a
 * mid-run driver refusal into an argument error at startup. `about:` is deliberately not
 * offered: it is a legitimate navigation target but not a thing anyone grounds.
 */
const WEB_SCHEMES = new Set(["http:", "https:"]);

export class TargetError extends Error {}

/**
 * Parse a target out of argv, removing whatever it consumed.
 *
 * Returns the remaining positional arguments so callers keep their existing shape: `explore`
 * reads guidance from positional 1, `agent` reads the task from positional 0, and neither
 * should have to know whether a `--url` pair sat in front of it.
 */
export function parseTarget(
	argv: string[],
	fallbackApp: string,
): { target: Target; rest: string[] } {
	const i = argv.indexOf("--url");
	if (i < 0) {
		const rest = argv.slice();

		return { target: { kind: "app", name: fallbackApp }, rest };
	}

	const raw = argv[i + 1];
	if (!raw || raw.startsWith("--")) throw new TargetError("--url needs a URL, e.g. --url https://www.notion.so");

	return { target: webTarget(raw), rest: argv.filter((_, n) => n !== i && n !== i + 1) };
}

/**
 * Build a web target from a URL string, normalising it once here so no later stage has to
 * decide what "the same site" means.
 */
export function webTarget(raw: string): Target {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new TargetError(`not a valid URL: "${raw}" — include the scheme, e.g. https://www.notion.so`);
	}
	if (!WEB_SCHEMES.has(parsed.protocol))
		throw new TargetError(`--url must be http or https (the driver refuses anything else), got "${parsed.protocol}"`);

	return { kind: "web", url: parsed.toString(), origin: parsed.origin };
}

/**
 * An Electron app to be driven over CDP: attach by debug port, launching the app with one
 * when nothing is listening. Mirrors webTarget as the one documented construction point,
 * so the runner never hand-assembles the shape.
 */
export function electronTarget(name: string): Target {
	return { kind: "app", name, cdpAttach: true };
}

/**
 * Apps that are browsers, and therefore need a URL before they mean anything.
 *
 * Hardcoded, and the exception to `install.ts`'s "the app is a parameter, never a case" rule.
 * The justification is narrow: this list drives ONE thing, whether the shell shows a URL box.
 * Nothing downstream branches on it — a web run is a web run because it carries a URL, not
 * because the app was on this list — so the worst a missing entry can do is hide a text field,
 * and the user can still type the URL into the search box to get the same target.
 *
 * This is the only copy. `listApps()` tags each entry with `browser` so the renderer, which is
 * a string literal and cannot import, reads a flag instead of re-listing the names here.
 *
 * Matched case-insensitively against the whole app name, because that is how they appear in
 * `/Applications`: "Google Chrome", "Microsoft Edge", "Firefox Developer Edition".
 */
const BROWSER_APPS = [
	"google chrome",
	"google chrome canary",
	"chromium",
	"microsoft edge",
	"brave browser",
	"vivaldi",
	"opera",
	"arc",
	"safari",
	"firefox",
	"firefox developer edition",
	"zen browser",
	"orion",
];

/**
 * Is this app name a browser? Used by the shell to decide whether to ask for a URL.
 *
 * Prefix-matched rather than exact so channel builds come along for free — "Google Chrome Dev"
 * and "Google Chrome Beta" are the same product with a suffix.
 */
export function isBrowserApp(name: string): boolean {
	const n = name.trim().toLowerCase();

	return BROWSER_APPS.some((b) => n === b || n.startsWith(`${b} `));
}

/**
 * The join key for every artifact a run leaves: `docs/appmaps/<slug>.{md,json}`,
 * `out/runs/<stamp>-<slug>.json`, job ids, and the fleet's artifact pull.
 *
 * The app branch delegates to `appSlug` UNCHANGED and must keep doing so. That function has
 * six call sites across the runner, the fleet and the shell, and `paths.test.ts` pins the
 * paths it produces — so a Mac app's artifacts have to land exactly where they landed before
 * this type existed. Web targets still get their own sanitisation: `appSlug` now folds path
 * separators and colons too, but a host is full of dots and the slug here is derived from
 * the URL's host rather than trusting a raw string at all.
 *
 * Keyed on HOST, not the full URL: one exploration pass maps a site, and `notion.so/foo` and
 * `notion.so/bar` are two routes through one map rather than two apps. The `web-` prefix
 * keeps the two namespaces from ever colliding — an app really named "www.notion.so" is
 * far-fetched, but the prefix costs nothing and makes `docs/appmaps/web-*` a listable set,
 * which the shell uses to find grounded sites.
 */
/**
 * The appmap slug for an app name OR a URL, without needing a resolved Target.
 *
 * This exists because the slug was being derived independently at four call sites — the pass
 * that writes the file (explore/state.ts), the job record that points at it (runner/jobs.ts),
 * the collector that fetches it (bench/collect.ts), and the dashboard that reads it
 * (bench/dash.ts) — from different inputs, with nothing comparing the results. All four
 * agreed for app targets and diverged for web ones: `web-app.notion.com` from the writer,
 * `https-app.notion.com` from everyone else. Each divergence surfaced as "no appmap" for a
 * map that existed, and in the grounding path that degrades silently to provenance "none" —
 * an arm running ungrounded while the report calls it grounded.
 *
 * Anything that names an appmap file should call THIS, so there is one derivation to be
 * wrong rather than four to keep in step.
 *
 * `visionOnly` selects the `.vision` pair a screenshots-only pass writes, which is a separate
 * artifact precisely so it cannot overwrite the element-grounded map.
 */
export function appmapSlug(appOrUrl: string, opts: { visionOnly?: boolean; noVision?: boolean; axdomOff?: boolean; backend?: string } = {}): string {
	// The BACKEND is part of the filename because a map is not backend-portable. The ax pass
	// and the cdp pass name the same place differently — `editor` vs `draft-editor`, measured
	// 2026-08-01 — and a grounded run resolves controls BY NAME. Grounding an ax run on a
	// cdp-derived map therefore fails to resolve for vocabulary reasons that read as backend
	// weakness, corrupting the one comparison the backend arms exist for.
	//
	// Before this, every Yarn explore wrote docs/appmaps/yarn.json and the last one to finish
	// won: ax (156 nodes), cdp (196), no-vision (180) all overwrote each other, so which map
	// phase 2 grounded on was decided by explore ordering.
	// BOTH the backend and the perception tier, because all three vary independently and any
	// two arms sharing a filename means the later pass silently overwrites the earlier. An
	// earlier version of this fix included only the backend, and p1-explore-ax and
	// p1-explore-no-vision — same backend, different perception — collided exactly as before.
	// Three independent axes, all in the name. `axdomOff` joins them because the sidecar is a
	// SEPARATE element channel layered on AX — a pass without it names controls the bare AX
	// tree could name, which on Yarn was 955 of 1044 anonymous nodes fewer. Two passes whose
	// maps differ that much must not share a filename; without this they both write yarn.ax
	// and the later one wins.
	const tier = opts.visionOnly ? ".vision" : opts.noVision ? ".novision" : "";
	const variant = `${opts.backend ? `.${opts.backend}` : ""}${opts.axdomOff ? ".noaxdom" : ""}${tier}`;
	// A URL is recognised by being one, not by a caller remembering to say so.
	if (/^https?:\/\//i.test(appOrUrl.trim())) {
		try {
			return `${targetSlug({ kind: "web", url: appOrUrl, origin: new URL(appOrUrl).origin })}${variant}`;
		} catch {
			// Unparseable URL: fall through to app slugging rather than throw. A wrong-looking
			// filename is recoverable; a crash in a path that only names a file is not.
		}
	}

	return `${appSlug(appOrUrl)}${variant}`;
}

export function targetSlug(t: Target): string {
	if (t.kind === "app") return appSlug(t.name);

	const host = new URL(t.url).host.toLowerCase();

	return `web-${host.replace(/[^a-z0-9.-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "")}`.slice(0, 100);
}

/**
 * The human-readable name: what goes in prompts, log lines, the run log's `app` field and the
 * shell's picker. The origin rather than the full URL, so a run against a deep link still
 * reads as the site it is against.
 */
export function targetLabel(t: Target): string {
	return t.kind === "app" ? t.name : new URL(t.url).host;
}

/**
 * How to describe the target to the model.
 *
 * Both entry points open their system prompt with "a macOS app" and go on to frame the work in
 * native terms — `explore.ts` tells the model to visit "menus, settings panels and their tabs,
 * context menus, pickers", which is a native-app taxonomy. A website has a different one:
 * routes and URLs, nav, modals, drawers, forms, auth states, pagination. Handing a web target
 * the native taxonomy sends it hunting for a menu bar that does not exist.
 *
 * Kept here rather than in the two prompt templates so the vocabulary cannot drift between the
 * exploration pass and the task run — a map written against one taxonomy and consumed against
 * another is the subtle version of an ungrounded run.
 */
export interface TargetVocabulary {
	/** What the model is driving, as it appears mid-sentence: "driving <this>". */
	subject: string;
	/** What a container of controls is called, for the observation framing. */
	container: string;
	/** The surfaces an exploration pass should systematically visit. */
	surfaces: string;
	/** Kind-specific cautions appended to the prompt's rules. Empty for app targets. */
	cautions: string;
}

export function targetVocabulary(t: Target): TargetVocabulary {
	if (t.kind === "app")
		return {
			subject: "a macOS app",
			container: "the target window",
			surfaces: "menus, settings panels and their tabs, context menus on notable controls, pickers",
			cautions: "",
		};

	return {
		subject: `the web app at ${new URL(t.url).host}`,
		container: "the page",
		surfaces:
			"the main navigation and every route it reaches, settings/preferences pages, account and workspace scopes, " +
			"modals and drawers, forms and their validation states, and anything behind a tab or accordion",
		cautions:
			`You are driving a website in a browser. Two consequences:\n` +
			`- The URL is part of the observation and is legitimate evidence: a route change is often the cleanest ` +
			`thing to assert in an expectation ("the URL now contains /settings").\n` +
			`- Keyboard shortcuts with cmd reach the BROWSER, not the page — cmd+w closes the tab and ends the run, ` +
			`cmd+t opens a new one, cmd+r reloads and loses page state. Do not use them. Escape and plain keys are fine.\n` +
			`- Stay on ${new URL(t.url).host}. Following a link off-site (docs, status pages, an OAuth provider) leaves ` +
			`the app you are mapping; go back rather than exploring there.`,
	};
}

export interface RunArgOptions {
	task?: string;
	record?: boolean;
	noVision?: boolean;
	backend?: string;
}

/**
 * The argv a run is spawned with, in ONE place.
 *
 * Three callers build this today and they already duplicate each other: `RunController`
 * in the shell, `serve.ts` on the fleet side, and the `run` script. They agreed only by
 * being written from the same example, and a fourth divergence — a `--url` that one of them
 * forgets — would be a web run silently grounding the wrong target. The `run` script is bash
 * and cannot import this, but the two TypeScript callers can and do.
 *
 * Order matters and matches what `agent.ts`/`explore.ts` parse: task first (agent only),
 * then the app positional, then flags. A web target still passes a positional — the browser
 * app name is irrelevant to it, but `explore`'s guidance argument is positional 1, so the
 * slot has to stay occupied.
 */
export function buildRunArgs(t: Target, opts: RunArgOptions = {}): string[] {
	const args: string[] = [];
	if (opts.task !== undefined) args.push(opts.task);
	args.push(targetLabel(t));
	if (t.kind === "web") args.push("--url", t.url);
	if (opts.record) args.push("--record");
	if (opts.noVision) args.push("--no-vision");
	if (opts.backend) args.push("--backend", opts.backend);

	return args;
}
