import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appSlug } from "../../paths.js";
import { readJsonOr } from "../../fsutil.js";
import { osascript, quitApp } from "../../core/appctl.js";
import { defaultRunnerDir } from "./lease.js";

/**
 * Give every team member their own data inside the target app.
 *
 * The fleet is three colo Macs sharing one console account, because screen sharing into a
 * non-console account opens a *separate* login session and the app's window and signed-in
 * state live in the console one. That is load-bearing and not going away — so at the OS level
 * everyone is the same user, and without this module everyone is also the same person inside
 * every app they drive. Whoever signs Yarn in first, everyone else demos as.
 *
 * So the separation has to happen a layer up: park the app's on-disk data under the operator
 * who owns it, and swap it when the operator changes. Each teammate keeps a real, persistent
 * profile — sign in once and it is still there next week, behind whatever anyone else did in
 * between — and a teammate the app has never seen gets a genuinely fresh app, which the
 * readiness check in `agent.ts` then reports as "sign in once on this Mac".
 *
 * The sign-in request is therefore not a feature of this file. It is what the existing guard
 * already does when it meets a signed-out app; all this has to do is stop handing one
 * operator another operator's session.
 *
 * NOTHING HERE IS APP-SPECIFIC, and that is a hard requirement of the repo: the agent drives
 * arbitrary applications. The paths below are derived from the two identifiers macOS itself
 * gives every app — its name and its bundle id — against the standard `~/Library` layout that
 * every Mac app writes into. There is no table of known apps and there must never be one.
 *
 * WHAT THIS DOES NOT COVER. An app that keeps its session token in the login keychain rather
 * than in its own container is not isolated by moving directories, because the keychain is
 * shared by the account. Electron apps — the declared scope — keep session state in the
 * Chromium cookie jar and localStorage under Application Support, which is exactly what moves.
 * A native app doing keychain auth would need `security` surgery per item, which is a much
 * sharper instrument than this and is not worth building until something needs it.
 */

/** One app, as macOS identifies it. `bundleId` is absent when LaunchServices could not resolve it. */
export interface AppIdentity {
	name: string;
	bundleId?: string;
}

/**
 * Where an app of this identity keeps per-user state, as paths relative to the home directory.
 *
 * Candidates, not findings — most will not exist for any given app, and `capturePaths` filters.
 * Both the name and the bundle id are tried against every location because the two conventions
 * genuinely coexist: Electron names `Application Support/<productName>` after the app while
 * macOS frameworks key `Preferences`, `Containers` and `Saved Application State` on the bundle
 * id, and an app may use either for any of them.
 *
 * The list errs towards including a location. Moving a cache that did not need moving costs a
 * cold start; missing one that held a session cookie costs the isolation this module exists for.
 */
export function livePaths(id: AppIdentity): string[] {
	// No separators, and no `.`/`..`: the key becomes one path segment under ~/Library, and an
	// app named ".." would make `Library/Application Support/..` — ~/Library itself — a
	// candidate for the swap's recursive move.
	const keys = [id.name, id.bundleId].filter((k): k is string => !!k && !k.includes("/") && k !== "." && k !== "..");
	const out: string[] = [];
	for (const key of keys) {
		out.push(
			`Library/Application Support/${key}`,
			`Library/Caches/${key}`,
			`Library/Preferences/${key}.plist`,
			`Library/Containers/${key}`,
			`Library/Saved Application State/${key}.savedState`,
			`Library/WebKit/${key}`,
			`Library/HTTPStorages/${key}`,
			`Library/HTTPStorages/${key}.binarycookies`,
			`Library/Cookies/${key}.binarycookies`,
		);
	}

	// The same key can appear under both identifiers when an app names itself after its bundle id.
	return [...new Set(out)];
}

/** The subset of `livePaths` that is actually on disk. */
export function capturePaths(id: AppIdentity, home: string): string[] {
	return livePaths(id).filter((rel) => fs.existsSync(path.join(home, rel)));
}

/** Recorded beside the stored data so a restore moves back exactly what was taken. */
export interface ProfileManifest {
	app: string;
	operator: string;
	bundleId?: string;
	storedAt: string;
	/** Home-relative paths, the same strings `livePaths` produced. */
	paths: string[];
}

export interface OwnerRecord {
	/** App slug → the operator whose data is currently live. */
	[slug: string]: string;
}

export type SwapAction =
	/** The requester already owns the live data. Nothing moved, nothing quit. */
	| "kept"
	/** No owner was recorded, so the live data is claimed for the requester as-is. */
	| "adopted"
	/** Someone else owned it: their data was parked and the requester's was put in place. */
	| "swapped";

export interface ProfileSwap {
	action: SwapAction;
	app: string;
	operator: string;
	previousOwner?: string;
	/** Home-relative paths parked under the previous owner. */
	stashed: string[];
	/** Home-relative paths restored from the requester's profile. */
	restored: string[];
	/**
	 * True when the requester had no stored profile, so the app comes up in its factory state.
	 * The caller uses this to predict a sign-in — it does not mean anything failed.
	 */
	fresh: boolean;
}

export interface SwapOptions {
	app: string;
	operator: string;
	/** Injected in tests. Production resolves it through LaunchServices. */
	bundleId?: string;
	home?: string;
	/** Profile store root. Defaults to `<runnerDir>/profiles`. */
	root?: string;
	/** Stop the app before its files move. Injected in tests; must resolve only once it is gone. */
	quit?: (app: string) => Promise<void>;
}

export function profilesRoot(): string {
	return path.join(defaultRunnerDir(), "profiles");
}

function ownersFile(root: string): string {
	return path.join(root, "owners.json");
}

export function readOwners(root: string): OwnerRecord {
	// Absent on first use, and an unreadable one means "nobody owns anything yet".
	const parsed = readJsonOr<unknown>(ownersFile(root), undefined);

	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as OwnerRecord) : {};
}

function writeOwners(root: string, owners: OwnerRecord): void {
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	fs.writeFileSync(ownersFile(root), `${JSON.stringify(owners, null, 2)}\n`);
}

/**
 * Drop an app's ownership entry, answering whether one existed. For the callers that delete
 * the live data the entry describes — an owners.json row pointing at directories that are
 * gone would hand the NEXT swap a manifest of nothing and park the wrong operator's name.
 */
export function clearOwner(root: string, slug: string): boolean {
	const owners = readOwners(root);
	if (!(slug in owners)) return false;
	delete owners[slug];
	writeOwners(root, owners);

	return true;
}

/** Where one operator's copy of one app lives. Mirrored home-relative, so it reads on disk. */
export function profileDir(root: string, operator: string, slug: string): string {
	return path.join(root, sanitise(operator), slug);
}

/**
 * Operator names reach here from `YARN_OPERATOR` or a login name and end up as a path segment,
 * so they are constrained rather than trusted. Anything outside the set collapses to `-`, which
 * cannot traverse and cannot name a parent.
 */
function sanitise(operator: string): string {
	const cleaned = operator.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+/, "");

	return cleaned || "unknown";
}

function manifestFile(dir: string): string {
	return path.join(dir, "manifest.json");
}

function readManifest(dir: string): ProfileManifest | undefined {
	return readJsonOr<ProfileManifest | undefined>(manifestFile(dir), undefined);
}

/**
 * A manifest entry is trusted at exactly one point — the restore, where it is joined to both
 * the profile store and the home directory and fed to a recursive move. The manifest is a
 * plain file on disk that anything could have edited, so an absolute entry or one with `.`
 * or `..` segments is refused rather than resolved: a `Library/../.ssh` entry restored
 * "into" home would overwrite real credentials with store contents, and the reverse move on
 * the next stash would carry them out. Fresh `livePaths` output always passes.
 */
function safeManifestPath(rel: unknown): rel is string {
	if (typeof rel !== "string" || !rel || path.isAbsolute(rel)) return false;

	return rel.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * Move a path, falling back to copy-and-delete.
 *
 * `rename` is the right call — atomic, and instant regardless of how large a browser cache has
 * grown — but it fails with EXDEV across volumes, and the profile store sits under the runner
 * directory which an operator may well have pointed at another disk.
 */
function move(from: string, to: string): void {
	fs.mkdirSync(path.dirname(to), { recursive: true });
	fs.rmSync(to, { recursive: true, force: true });
	try {
		fs.renameSync(from, to);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
		fs.cpSync(from, to, { recursive: true });
		fs.rmSync(from, { recursive: true, force: true });
	}
}

/**
 * Put the requesting operator's data in place, parking whoever's was there.
 *
 * Ordering matters and is not obvious: the app is quit BEFORE anything moves, because a running
 * app holds its cookie jar open and writes it back out on quit — park the directory first and
 * the app recreates and repopulates it a second later, leaving the previous operator's session
 * live under the new operator's name. That is precisely the failure this module exists to
 * prevent, so the quit is not an optimisation.
 *
 * Throws if it cannot complete a swap it has started. A caller must NOT proceed with the run in
 * that case: a half-swapped profile means the operator on the recording is not the operator who
 * asked, which is worse than a refused dispatch.
 */
export async function swapProfile(opts: SwapOptions): Promise<ProfileSwap> {
	const home = opts.home ?? os.homedir();
	const root = opts.root ?? profilesRoot();
	const slug = appSlug(opts.app);
	const operator = sanitise(opts.operator);
	const owners = readOwners(root);
	const previousOwner = owners[slug];
	const id: AppIdentity = { name: opts.app, ...(opts.bundleId ? { bundleId: opts.bundleId } : {}) };

	if (previousOwner === operator) return { action: "kept", app: opts.app, operator, previousOwner, stashed: [], restored: [], fresh: false };

	const mine = profileDir(root, operator, slug);
	const stored = readManifest(mine);

	// First use on this Mac. Whatever is live is claimed for the requester rather than thrown
	// away: the alternative is that turning this feature on signs everyone out of everything,
	// including the sign-ins that made the fleet usable in the first place.
	if (previousOwner === undefined) {
		owners[slug] = operator;
		writeOwners(root, owners);
		const live = capturePaths(id, home);

		return { action: "adopted", app: opts.app, operator, stashed: [], restored: [], fresh: !live.length && !stored };
	}

	await (opts.quit ?? quitApp)(opts.app);

	// Park the outgoing operator's data. Their manifest is rewritten from what was actually
	// found, not merged with an older one, so a path they no longer use stops being restored.
	const theirs = profileDir(root, previousOwner, slug);
	const stashed = capturePaths(id, home);
	fs.mkdirSync(theirs, { recursive: true, mode: 0o700 });
	for (const rel of stashed) move(path.join(home, rel), path.join(theirs, rel));
	const outgoing: ProfileManifest = {
		app: opts.app,
		operator: previousOwner,
		...(opts.bundleId ? { bundleId: opts.bundleId } : {}),
		storedAt: new Date().toISOString(),
		paths: stashed,
	};
	fs.writeFileSync(manifestFile(theirs), `${JSON.stringify(outgoing, null, 2)}\n`);

	// Restore the requester's, if they have one. If they do not, nothing is put back and the app
	// starts factory-fresh — which is the sign-in case, and is a success, not a fallback.
	const restored: string[] = [];
	for (const rel of stored?.paths ?? []) {
		// Skipped, not fatal: the entry's data stays parked in the store, which is the safe
		// direction, and the rest of the profile still comes back.
		if (!safeManifestPath(rel)) continue;
		const from = path.join(mine, rel);
		if (!fs.existsSync(from)) continue;
		move(from, path.join(home, rel));
		restored.push(rel);
	}
	fs.rmSync(manifestFile(mine), { force: true });

	owners[slug] = operator;
	writeOwners(root, owners);

	return { action: "swapped", app: opts.app, operator, previousOwner, stashed, restored, fresh: !restored.length };
}

export interface AuthClearOptions {
	app: string;
	operator: string;
	/** Injected in tests. Production resolves it through LaunchServices. */
	bundleId?: string;
	home?: string;
	/** Profile store root. Defaults to `<runnerDir>/profiles`. */
	root?: string;
	/** Stop the app before its files are deleted. Injected in tests; must resolve only once it is gone. */
	quit?: (app: string) => Promise<void>;
}

export interface AuthClear {
	app: string;
	operator: string;
	/** Home-relative live paths deleted from under `$HOME`. Empty unless the requester owned the live copy. */
	removedLive: string[];
	/** Store-relative path of the parked profile that was deleted (`<operator>/<slug>`), when one existed. */
	removedProfile?: string;
	/** True when the requester owned the live data and the owners.json entry was cleared. */
	ownershipCleared: boolean;
	/** Who owns the live copy when it is NOT the requester — named so the reply can say why it was left alone. */
	liveOwner?: string;
}

/**
 * Sign one operator out of one app on this Mac, by deleting their data for it — the inverse of
 * what `swapProfile` preserves. Both stores are covered: the LIVE copy under `$HOME`, but only
 * if owners.json says this operator owns it, and their PARKED profile under the store, if one
 * exists. Another operator's live session is never touched — that is the same isolation promise
 * the swap makes, applied to deletion, where getting it wrong is unrecoverable rather than
 * merely embarrassing.
 *
 * The app is quit only when live data is about to go. A running app holds its cookie jar open
 * and writes it back out on quit — delete the directory first and the session this verb exists
 * to destroy is resurrected a second later (the same failure ordering `swapProfile` documents).
 * When only a parked profile is deleted the app never had those files open, and quitting it
 * would disrupt whoever's session is currently live for no benefit.
 *
 * Every path deleted comes from `livePaths()` (traversal-constrained at construction) or
 * `profileDir()` (operator sanitised, slug checked below). Nothing arriving over the wire is
 * ever joined into a path directly.
 */
export async function clearOperatorData(opts: AuthClearOptions): Promise<AuthClear> {
	const home = opts.home ?? os.homedir();
	const root = opts.root ?? profilesRoot();
	const slug = appSlug(opts.app);
	// appSlug folds separators into dashes, so a slug cannot traverse — except as a bare dot
	// segment, which it passes through: an app named ".." would make profileDir() resolve to
	// the operator's whole profile directory, and this function deletes what that names.
	if (!slug || slug === "." || slug === "..") throw new Error(`refusing app name ${JSON.stringify(opts.app)}: its slug would not name a directory of its own`);
	const operator = sanitise(opts.operator);
	const owners = readOwners(root);
	const owner = owners[slug];
	const out: AuthClear = { app: opts.app, operator, removedLive: [], ownershipCleared: false };

	if (owner === operator) {
		await (opts.quit ?? quitApp)(opts.app);
		const id: AppIdentity = { name: opts.app, ...(opts.bundleId ? { bundleId: opts.bundleId } : {}) };
		for (const rel of capturePaths(id, home)) {
			fs.rmSync(path.join(home, rel), { recursive: true, force: true });
			out.removedLive.push(rel);
		}
		delete owners[slug];
		writeOwners(root, owners);
		out.ownershipCleared = true;
	} else if (owner !== undefined) {
		out.liveOwner = owner;
	}

	// The parked profile goes either way: it is this operator's own store entry, and the whole
	// point of signing out is that nothing brings the session back on their next swap.
	const mine = profileDir(root, operator, slug);
	if (fs.existsSync(mine)) {
		fs.rmSync(mine, { recursive: true, force: true });
		out.removedProfile = `${operator}/${slug}`;
	}

	return out;
}

/** One line for the job log and the CLI, same shape as `describeSwap`. */
export function describeAuthClear(c: AuthClear): string {
	const bits = [
		c.removedLive.length ? `deleted ${c.removedLive.length} live path(s)` : "",
		c.removedProfile ? `deleted parked profile ${c.removedProfile}` : "",
		c.ownershipCleared ? "cleared live ownership" : "",
		c.liveOwner ? `live data left alone (${c.liveOwner} owns it)` : "",
	].filter(Boolean);

	return `authclear: ${c.operator} signed out of ${c.app} — ${bits.join(", ") || "nothing was stored for them"}`;
}

/** One line for the job log and the dispatch reply. */
export function describeSwap(s: ProfileSwap): string {
	if (s.action === "kept") return `profile: ${s.operator} already owns ${s.app}`;
	if (s.action === "adopted") return `profile: ${s.app} claimed for ${s.operator} (first run on this Mac)`;
	const tail = s.fresh ? "no stored profile — the app will need signing in" : `restored ${s.restored.length} path(s)`;

	return `profile: ${s.app} swapped ${s.previousOwner} → ${s.operator}, parked ${s.stashed.length} path(s), ${tail}`;
}

/**
 * The app's bundle id, via LaunchServices. Absent rather than fatal when it cannot be resolved:
 * the name alone still covers the Electron layout, which is the declared scope.
 */
export async function resolveBundleId(app: string): Promise<string | undefined> {
	const out = await osascript([`id of app "${app.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`]).catch(() => "");
	const id = out.trim();

	return /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(id) ? id : undefined;
}
