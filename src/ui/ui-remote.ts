import fs from "node:fs";
import path from "node:path";
import { outDir } from "../paths.js";
import {
	AUTO_HOST,
	type DispatchOptions,
	type DispatchResult,
	dispatch,
	type FollowOptions,
	dispatchNotes,
	type FollowResult,
	follow,
	type PullOptions,
	type PullResult,
	pull,
	type RemoteApp,
	type RemoteAppList,
	remoteApps,
	type StopResult,
	stopRemote,
} from "../fleet/remote/dispatch.js";
import { type FleetRow, fleetStatus } from "../fleet/remote/fleet.js";
import { type HostEntry, hostsPath, type Inventory, loadHosts, resolveHost } from "../fleet/remote/hosts.js";
import { autoSync, type SyncOptions } from "../fleet/remote/appmaps.js";
import { installApp, resolveAppSource } from "../fleet/remote/install.js";
import { clearAppAuth, deleteRemoteApp } from "../fleet/remote/manage.js";
import { closeScreenShare, forgetScreenShareLogin, planSignin, waitForHome } from "../fleet/remote/signin.js";
import { describeCredentials, setModelKey } from "../fleet/remote/team.js";
import type { JobKind } from "../fleet/runner/jobs.js";
import { UNREADY_EXIT } from "../core/harness.js";
import { LineSplitter, type RunHandlers } from "./ui-core.js";

/**
 * The fleet half of the shell: choosing a host, watching the fleet, and driving one remote
 * job the way `RunController` drives one local child.
 *
 * Split from `electron/main.ts` for the same reason `ui-core.ts` is — none of it needs
 * Electron, so all of it is testable in plain Node — and split from `ui-core.ts` because
 * local execution must not acquire a dependency on the remote stack. A checkout with no
 * `hosts.json` is the normal developer case, and nothing below may turn that into a
 * degraded local UI: every entry point here answers "no fleet" rather than throwing.
 *
 * Two rules this module inherits and does not get to reinterpret:
 *
 * - **The task text is not read here.** `auditTaskPrompt` in agent.ts is the one authoritative
 *   gate (CLAUDE.md, "Measurement rule"), and it runs on the machine that will execute the
 *   run. A local pre-screen would be a second copy of that rule that can disagree with the
 *   first, so submission checks length and nothing else.
 * - **No key value ever leaves this file.** `describeCredentials` returns a boolean by
 *   construction; the save path below returns that same boolean back and never echoes what
 *   was typed, because the credentials panel is the one part of this UI people screenshot.
 */

/** The pseudo-host meaning "this Mac" — `RunController`, exactly as before the fleet existed. */
export const LOCAL_HOST = "local";

/** Retries before a dropped log stream is reported as lost. The job itself is untouched either way. */
const FOLLOW_RETRIES = 5;

const RETRY_DELAY_MS = 3_000;

/**
 * How long a silent stream may stay silent before the UI says something.
 *
 * A single model turn on a hard step runs minutes with no output at all, and a log pane that
 * has printed nothing for four minutes is indistinguishable from an ssh connection that died
 * — which is the state an operator reacts to by killing a 40-minute grounding pass.
 */
const SILENCE_MS = 60_000;

const HEARTBEAT_MS = 15_000;

export interface HostChoices {
	/** `local`, then `auto` when there is a fleet, then every host in the inventory. */
	hosts: string[];
	/** Set only when an inventory exists and could not be understood. Absence is not an error. */
	error?: string;
}

/**
 * The host selector's options.
 *
 * An absent `hosts.json` is the local-only developer, not a fault, so it produces `[local]`
 * and no error — the whole fleet UI keys off that emptiness to stay hidden. A file that
 * exists but does not parse is the opposite case and must be loud: silently offering only
 * `local` there would look identical to having no fleet, and the operator would go looking
 * for the Macs instead of for the typo.
 */
export function hostChoices(load: () => Inventory = loadHosts, exists: (p: string) => boolean = fs.existsSync): HostChoices {
	let names: string[] = [];
	let error: string | undefined;
	try {
		names = load().hosts.map((h) => h.name);
	} catch (e) {
		if (exists(hostsPath())) error = (e as Error).message;
	}

	return { hosts: [LOCAL_HOST, ...(names.length ? [AUTO_HOST, ...names] : [])], ...(error ? { error } : {}) };
}

/** Anything that is not the local pseudo-host goes through dispatch, `auto` included. */
/** An app list with a note attached — the note is how an unreachable host explains an empty list. */
export interface AppChoices {
	apps: RemoteApp[];
	/** Where the list came from, for the search box's placeholder. */
	host: string;
	/** Set only when the list could not be fetched. An empty list with no note means an empty Mac. */
	note?: string;
}

/**
 * The app list for whichever host is selected.
 *
 * This exists because a list of the OPERATOR's apps, shown while a colo Mac is selected, is
 * worse than no list: every entry is clickable, most are not installed over there, and the
 * failure arrives minutes later as "no window found" from a machine nobody is looking at. The
 * `grounded` badge lies in the same direction, since it is computed against the appmaps of
 * whichever checkout answers.
 *
 * `auto` gets the fleet's intersection, never the local list. A run dispatched to `auto` lands
 * on a fleet Mac — `dispatch` walks the inventory and only the inventory, so LOCAL is not a
 * possible destination and this Mac's apps are exactly the wrong thing to offer. See
 * `autoAppChoices` for why the answer is an intersection.
 */
export async function appChoices(
	host: string | undefined,
	local: () => RemoteApp[],
	fetchRemote: typeof remoteApps = remoteApps,
	load: () => Inventory = loadHosts,
): Promise<AppChoices> {
	const name = (host ?? "").trim() || LOCAL_HOST;
	if (name === AUTO_HOST) return autoAppChoices(fetchRemote, load);
	if (!isRemoteHost(name)) return { apps: local(), host: LOCAL_HOST };

	try {
		const res = await fetchRemote(name);
		if (!res.ok) return { apps: [], host: name, note: `${name}: ${res.reason ?? "did not answer"}` };

		return { apps: res.apps, host: name };
	} catch (e) {
		// A fleet Mac being unreachable is routine, and it must not empty the window: the note
		// says why the list is empty and the rest of the shell keeps working.
		return { apps: [], host: name, note: `${name}: ${(e as Error).message}` };
	}
}

/**
 * The `auto` list: apps present on EVERY reachable fleet host.
 *
 * The scheduler is free to land the run on any idle Mac, so an app installed on two of three
 * hosts is a coin-flip that fails minutes later as "no window found" whenever the third one
 * wins the pick. Only the intersection is safe to offer. The same reasoning ANDs the badges:
 * "open" or "grounded" on one host says nothing about the host the run actually gets.
 *
 * Hosts that do not answer shrink the fan-out rather than emptying the list — a rebooting Mac
 * must not blank the picker — but they are named in the note, because an operator who knows
 * mac3 was silent also knows the list may be wider than shown. Nothing reachable at all means
 * `auto` has nowhere to run, and an empty list with a note saying so beats a local list whose
 * every entry would be refused at submit time.
 */
async function autoAppChoices(fetchRemote: typeof remoteApps, load: () => Inventory): Promise<AppChoices> {
	let hosts: HostEntry[];
	try {
		hosts = load().hosts;
	} catch (e) {
		return { apps: [], host: AUTO_HOST, note: (e as Error).message };
	}

	const lists = await Promise.all(
		hosts.map(async (h): Promise<RemoteAppList> => {
			try {
				// The entry, not the name: resolving a name would re-read the inventory that
				// `load` (an injected dependency, in tests) already answered for.
				return await fetchRemote(h);
			} catch (e) {
				return { host: h.name, ok: false, apps: [], reason: (e as Error).message };
			}
		}),
	);
	const reachable = lists.filter((l) => l.ok);
	const silent = lists.filter((l) => !l.ok).map((l) => l.host);
	if (!reachable.length)
		return { apps: [], host: AUTO_HOST, note: `no fleet host answered${silent.length ? ` (${silent.join(", ")})` : ""} — auto has nowhere to run` };

	// Intersection by name, in the first answering host's order (each runner already sorts
	// grounded/running/alphabetical, so re-sorting here would fight that).
	const [first, ...rest] = reachable;
	const everywhere = (name: string, flag: (a: RemoteApp) => boolean): boolean => rest.every((l) => l.apps.some((a) => a.name === name && flag(a)));
	const apps = first.apps
		.filter((a) => everywhere(a.name, () => true))
		.map((a) => ({
			name: a.name,
			running: a.running && everywhere(a.name, (b) => b.running),
			grounded: a.grounded && everywhere(a.name, (b) => b.grounded),
		}));

	return {
		apps,
		host: AUTO_HOST,
		note: silent.length
			? `apps present on every reachable fleet host — ${silent.join(", ")} did not answer`
			: "apps present on every fleet host — auto picks one at submit time",
	};
}

export function isRemoteHost(host: string | undefined): boolean {
	return !!host && host.trim().toLowerCase() !== LOCAL_HOST;
}

export interface FleetRowView {
	name: string;
	state: FleetRow["state"];
	/** Who/what/how long, when busy. Empty otherwise. */
	detail: string;
	/** Why the row is degraded. The column this whole panel exists for. */
	reason?: string;
	/** Present only when the grants were actually reported; `false` is a hard warning. */
	tccOk?: boolean;
	/**
	 * Set when `tccOk` is false because the grants landed after the runner started. A separate
	 * field rather than a variant of the same warning: the two have opposite remedies, and the
	 * badge that says "not granted" sends an operator to a checkbox that is already ticked.
	 */
	staleGrants?: string[];
	/** The in-flight job, which is what makes the row attachable. */
	jobId?: string;
}

/**
 * One fleet row, shaped for a table cell.
 *
 * The elapsed time is formatted rather than passed through because the runs this watches are
 * grounding passes: `2431` in a column is not a number anyone reads as forty minutes, and the
 * decision an operator makes from this panel — wait, or go and ask whoever holds the box — is
 * entirely a function of that duration.
 */
export function describeFleetRow(row: FleetRow): FleetRowView {
	const detail =
		row.state === "busy"
			? [row.operator ?? "?", row.app ?? "?", formatElapsed(row.elapsedSec ?? 0)].join(" · ")
			: "";

	return {
		name: row.name,
		state: row.state,
		detail,
		...(row.reason ? { reason: row.reason } : {}),
		...(typeof row.tccOk === "boolean" ? { tccOk: row.tccOk } : {}),
		...(row.staleGrants?.length ? { staleGrants: row.staleGrants } : {}),
		...(row.jobId ? { jobId: row.jobId } : {}),
	};
}

export function formatElapsed(sec: number): string {
	const whole = Math.max(0, Math.round(sec));
	if (whole < 60) return `${whole}s`;
	const m = Math.floor(whole / 60);
	if (m < 60) return `${m}m ${String(whole % 60).padStart(2, "0")}s`;

	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export interface FleetView {
	rows: FleetRowView[];
	/**
	 * Runs the shell could re-attach to, derived from the same probe rather than a second one.
	 * Computed here rather than in the renderer so "which rows are followable" stays one
	 * tested decision instead of a condition written twice across a process boundary.
	 */
	offers: AttachOffer[];
	/** The fan-out itself failing — a missing or malformed inventory. Per-host failures are rows. */
	error?: string;
}

/**
 * The panel's data, and it never rejects.
 *
 * `fleetStatus` already isolates per-host failures into rows, so the only way to get nothing
 * back is for the inventory to be unreadable — and an IPC handler that throws leaves the
 * renderer with a pending promise and a panel stuck on "loading" forever. An error string
 * paints; a rejection does not.
 */
export async function fleetView(status: typeof fleetStatus = fleetStatus): Promise<FleetView> {
	try {
		const rows = await status();

		return { rows: rows.map(describeFleetRow), offers: attachOffers(rows) };
	} catch (e) {
		return { rows: [], offers: [], error: (e as Error).message };
	}
}

export interface SigninView {
	/** A screen to connect to. Absent means nothing is worth opening and `message` says why. */
	url?: string;
	/** Shown in the fleet panel, whether or not it worked. */
	message: string;
	ok: boolean;
	/**
	 * What `completeSignin` should watch, when there is something to watch. Present only if an
	 * app was actually launched — the caller uses its absence to skip the wait entirely.
	 */
	watch?: { host: string; app: string };
}

/**
 * Put the operator in front of a colo Mac, from the fleet panel.
 *
 * The CLI half of this (`./run signin`) has existed since the sign-in wall first blocked a run,
 * and it works — but it is reached from a terminal, while the person who hits the wall is
 * looking at this window, has the host and the app already selected in it, and is told by a run
 * that just refused to start. Making them go and retype both in another program is the whole
 * friction being removed here.
 *
 * `planSignin` does the actual work and is unchanged: launch the app over ssh, hand back a
 * vnc:// URL. This adds only what the GUI needs and the CLI got for free from its argv — a
 * concrete host, since `local` and `auto` are selectable in this window and neither names a
 * machine to connect to.
 *
 * Still no credential anywhere in this path. The operator types it into Screen Sharing and then
 * into the app; nothing is read, stored, or passed to the model.
 */
export async function beginSignin(
	hostName: string,
	app: string | undefined,
	load: () => Inventory = loadHosts,
	plan: typeof planSignin = planSignin,
): Promise<SigninView> {
	const name = (hostName ?? "").trim();
	if (!isRemoteHost(name)) return { ok: false, message: "Sign-in over screen sharing is for the colo Macs — open the app yourself on this one." };
	// `auto` is a scheduling instruction, not a host. Resolving it to whichever Mac is free would
	// sign in on a machine the operator did not pick, and the next run could land on another one.
	if (name === AUTO_HOST) return { ok: false, message: "Pick a specific Mac to sign in on — auto chooses a host per run." };

	let host: HostEntry;
	try {
		host = resolveHost(name, load());
	} catch (e) {
		return { ok: false, message: (e as Error).message };
	}

	const result = await plan(host, app?.trim() || undefined);
	// A failed launch still returns the URL: an operator on the screen can start the app from the
	// Dock, which beats refusing to do the one thing that still works.
	const opened = result.launch
		? result.launch.ok
			? result.launch.foregrounded
				? `Opened ${result.launch.app} on ${host.name} and brought it to the front.`
				: `Opened ${result.launch.app} on ${host.name} behind the other windows — bring it forward there.`
			: `Could not open ${result.launch.app} (${result.launch.detail}) — start it from the Dock.`
		: `Connecting to ${host.name}.`;
	// Only when there is something to watch for. Without an app named, "signed in" has no
	// machine-checkable meaning and the panel must not promise to notice.
	const tail = result.launch ? "Sign in by hand — this closes the screen share once the app reaches its home screen." : "Sign in by hand.";

	return { ok: true, url: result.url, message: `${opened} ${tail}`, ...(result.launch ? { watch: { host: host.name, app: result.launch.app } } : {}) };
}

/**
 * Wait for a sign-in started by `beginSignin` to land, then put the viewer away.
 *
 * Split from `beginSignin` rather than tacked onto its end because the two have opposite
 * latencies: opening a screen share is a couple of seconds and the panel blocks on it, while
 * this is a human typing a password and reading a text message, and a button that stays spinning
 * for six minutes reads as a hang. The caller fires this after the URL has already opened.
 */
export async function completeSignin(
	hostName: string,
	app: string,
	load: () => Inventory = loadHosts,
	wait: typeof waitForHome = waitForHome,
	close: typeof closeScreenShare = closeScreenShare,
): Promise<{ ok: boolean; message: string }> {
	let host: HostEntry;
	try {
		host = resolveHost(hostName, load());
	} catch (e) {
		return { ok: false, message: (e as Error).message };
	}

	const outcome = await wait(host, app);
	if (!outcome.ready) return { ok: false, message: `${app} is still not at its home screen on ${host.name}: ${outcome.detail}` };

	// The close is best-effort and its failure is not the operator's problem to solve mid-flow:
	// the sign-in is what they came for and it worked. Its reason is still carried through,
	// because "close it yourself" with no cause given is how a missing Accessibility grant stays
	// missing for a month.
	const closed = await close(host);

	return {
		ok: true,
		message: closed.closed
			? `${app} is signed in on ${host.name} — ${closed.detail}.`
			: `${app} is signed in on ${host.name}. Close the screen share when you are ready — ${closed.detail}`,
	};
}

/**
 * The fleet panel's overflow actions, each reduced to `{ok, message}` — the same shape
 * `beginSignin` answers with, because they all land in the same transient message slot and the
 * renderer must not need to know which verb produced the text.
 *
 * All four share the host discipline `beginSignin` established: `local` and `auto` are
 * selectable in this window and neither names a machine, so each refuses them in words rather
 * than resolving them to something the operator did not pick. (`forgetLoginView` still needs a
 * concrete host too — the keychain item it deletes is keyed on that Mac's address.)
 */
function namedHost(hostName: string, load: () => Inventory): HostEntry | { ok: false; message: string } {
	const name = (hostName ?? "").trim();
	if (!isRemoteHost(name)) return { ok: false, message: "Pick one of the colo Macs — this action is about a machine in the fleet." };
	if (name === AUTO_HOST) return { ok: false, message: "Pick a specific Mac — auto chooses a host per run." };
	try {
		return resolveHost(name, load());
	} catch (e) {
		return { ok: false, message: (e as Error).message };
	}
}

export interface ActionView {
	ok: boolean;
	message: string;
}

/**
 * Sign the current operator out of an app on a Mac. The runner decides everything — whose
 * data is live, what is parked — and reports what it deleted; this turns that report into one
 * sentence, because "removed 3 paths" with no paths is unauditable and the full list belongs
 * in the CLI, not a panel cell.
 */
export async function clearAuthView(
	hostName: string,
	app: string | undefined,
	load: () => Inventory = loadHosts,
	clear: typeof clearAppAuth = clearAppAuth,
): Promise<ActionView> {
	const host = namedHost(hostName, load);
	if ("ok" in host) return host;
	const target = (app ?? "").trim();
	if (!target) return { ok: false, message: "Pick an app first — sign-out needs a target." };

	let res;
	try {
		res = await clear(host, target);
	} catch (e) {
		return { ok: false, message: (e as Error).message };
	}
	if (!res.ok) return { ok: false, message: `${host.name}: ${res.error ?? "the runner refused"}` };

	const bits = [
		res.removedLive.length ? `${res.removedLive.length} live path(s)` : "",
		res.removedProfile ? "the parked profile" : "",
	].filter(Boolean);
	const what = bits.length ? `deleted ${bits.join(" and ")}` : "nothing was stored for you there";
	const tail = res.liveOwner ? ` Live ${target} data was left alone — ${res.liveOwner} owns it.` : "";

	return { ok: true, message: `Signed out of ${target} on ${host.name}: ${what}.${tail}` };
}

/** Uninstall an app from a Mac: the bundle plus every operator's parked profile for it. */
export async function deleteAppView(
	hostName: string,
	app: string | undefined,
	load: () => Inventory = loadHosts,
	del: typeof deleteRemoteApp = deleteRemoteApp,
): Promise<ActionView> {
	const host = namedHost(hostName, load);
	if ("ok" in host) return host;
	const target = (app ?? "").trim();
	if (!target) return { ok: false, message: "Pick an app first — delete needs a target." };

	let res;
	try {
		res = await del(host, target);
	} catch (e) {
		return { ok: false, message: (e as Error).message };
	}
	if (!res.ok) return { ok: false, message: `${host.name}: ${res.error ?? "the runner refused"}` };

	const profiles = res.removedProfiles.length ? ` and ${res.removedProfiles.length} parked profile(s)` : "";

	return { ok: true, message: `Deleted ${res.bundle ?? `${target}.app`}${profiles} on ${host.name}.` };
}

/**
 * Install an app on a Mac from a release URL — the same path `./run install` takes, wired to
 * the panel: `resolveAppSource` decides what the link is, `installApp` stages, fetches on the
 * far side and verifies by a fresh presence probe. The grants note rides along on success
 * because a freshly installed bundle holds no TCC grant and the operator must hear that HERE,
 * before the demo, not from an empty AX tree during it.
 */
export async function installAppView(
	hostName: string,
	app: string | undefined,
	spec: string | undefined,
	load: () => Inventory = loadHosts,
	resolve: typeof resolveAppSource = resolveAppSource,
	install: typeof installApp = installApp,
): Promise<ActionView> {
	const host = namedHost(hostName, load);
	if ("ok" in host) return host;
	const target = (app ?? "").trim();
	if (!target) return { ok: false, message: "Name the app to install — the presence check needs it." };
	if (!(spec ?? "").trim()) return { ok: false, message: "Give an https URL to a .dmg or .zip." };

	try {
		const source = await resolve(target, spec as string);
		const res = await install(host, source);
		if (res.ok)
			return { ok: true, message: `Installed ${res.app} on ${host.name} at ${res.presence?.path ?? "an unknown path"}. ${res.grants}` };

		// The first failed step is the actionable one; everything after it never ran.
		const failed = res.steps.find((s) => !s.ok);

		return { ok: false, message: `${host.name}: install failed at ${failed?.step ?? "?"} — ${failed?.detail ?? "no detail"}` };
	} catch (e) {
		return { ok: false, message: (e as Error).message };
	}
}

/**
 * Forget the saved Screen Sharing password for a Mac. Local by nature — the item lives in THIS
 * operator's login keychain — so unlike its siblings above, nothing here crosses ssh.
 */
export async function forgetLoginView(
	hostName: string,
	load: () => Inventory = loadHosts,
	forget: typeof forgetScreenShareLogin = forgetScreenShareLogin,
): Promise<ActionView> {
	const host = namedHost(hostName, load);
	if ("ok" in host) return host;

	try {
		const res = await forget(host);

		// Zero removed is the wanted end state reached earlier, not a failure.
		return {
			ok: true,
			message: res.removed
				? `Forgot ${res.removed} saved screen-share login${res.removed === 1 ? "" : "s"} for ${host.name} — the next connection will ask again.`
				: `No screen-share login was saved for ${host.name}.`,
		};
	} catch (e) {
		return { ok: false, message: (e as Error).message };
	}
}

export interface AttachOffer {
	host: string;
	jobId: string;
	app?: string;
	operator?: string;
	elapsedSec?: number;
}

/**
 * Runs worth offering to re-attach to.
 *
 * This is the fleet's answer to the shell's oldest defect: closing the window used to throw
 * away every line a run had printed, and a grounding pass prints for forty minutes. The job
 * survived — it is a detached child on another Mac — so the log is still on disk there and
 * `follow` can replay it from byte zero. All that was ever missing locally was the id, and
 * the busy row carries it.
 *
 * Another operator's run is offered too, deliberately: watching it is read-only, and "who is
 * on mac2 and what are they doing" is the same question the panel exists to answer.
 */
export function attachOffers(rows: FleetRow[]): AttachOffer[] {
	return rows
		.filter((r) => r.state === "busy" && r.jobId)
		.map((r) => ({
			host: r.name,
			jobId: r.jobId as string,
			...(r.app ? { app: r.app } : {}),
			...(r.operator ? { operator: r.operator } : {}),
			...(r.elapsedSec !== undefined ? { elapsedSec: r.elapsedSec } : {}),
		}));
}

/**
 * Chunks off the wire into whole lines.
 *
 * `follow` hands over byte-boundary chunks — the remote frames the log by byte offset, so a
 * chunk ends wherever a poll happened to land — while the page's `onLine` contract is one
 * line per call and it classifies each by regex. Emitting chunks directly splits `[12] click`
 * across two rows and neither half matches the step pattern.
 *
 * The implementation moved to `ui-core.ts` once the local run path was found to have the exact
 * defect this comment warns about; re-exported so the name and its tests stay put.
 */
export { LineSplitter };

/** The "still there" line, or nothing. Split out from the timer so the threshold is testable. */
export function silenceNote(silentForMs: number, host: string, jobId: string): string | undefined {
	if (silentForMs < SILENCE_MS) return undefined;

	return `… attached to ${jobId} on ${host} — no output for ${formatElapsed(silentForMs / 1000)}`;
}

export interface RemoteRunOptions {
	host: string;
	app: string;
	/** Passed through untouched; see the module header. Empty for a grounding pass. */
	task: string;
	kind: JobKind;
	record: boolean;
	noVision: boolean;
	/**
	 * Website target. Declared so the shell's call site typechecks against something real —
	 * it was spreading `url` into this object already, and a spread bypasses excess-property
	 * checking, so the field was dropped in silence all the way down to the far Mac's argv.
	 * `start` refuses it below rather than running the wrong thing; see the note there.
	 */
	url?: string;
}

/** Every side effect the controller has, injected so tests never reach a Mac. */
export interface RemoteDeps {
	dispatch(opts: DispatchOptions): Promise<DispatchResult>;
	follow(host: string, jobId: string | undefined, onChunk: (text: string) => void, opts?: FollowOptions): Promise<FollowResult>;
	pull(host: string, jobId: string, opts?: PullOptions): Promise<PullResult>;
	stopRemote(host: string, jobId?: string): Promise<StopResult>;
	now(): number;
	sleep(ms: number): Promise<void>;
	/** Remember which Mac a pulled run came from, for the gallery. */
	record(jobId: string, host: string): void;
	/**
	 * Fan a freshly pulled appmap out to the rest of the fleet. Injected like everything else
	 * here so a test never rsyncs three real Macs; answers a note, or nothing when nothing moved.
	 */
	sync(opts?: SyncOptions): Promise<string | undefined>;
}

export function defaultRemoteDeps(): RemoteDeps {
	return {
		dispatch,
		follow: (host, jobId, onChunk, opts) => follow(host, jobId, onChunk, opts),
		pull: (host, jobId, opts) => pull(host, jobId, opts),
		stopRemote: (host, jobId) => stopRemote(host, jobId),
		now: () => Date.now(),
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		record: recordRemoteRun,
		sync: autoSync,
	};
}

/**
 * One remote job, followed live — the counterpart of `RunController`, and deliberately the
 * same `RunHandlers` shape so the page's log pane cannot tell the two apart.
 *
 * The asymmetry with the local controller is that the remote job outlives this object. Stop
 * ends the run; detaching (a closed window, a lost connection) does not, and must not: the
 * whole reason to dispatch a forty-minute pass to a colo Mac is that the laptop stops being
 * load-bearing. Every exit path below therefore says which of the two happened, because
 * "finished" and "we stopped watching" look identical in a log that simply stops.
 */
export class RemoteRunController {
	private readonly deps: RemoteDeps;
	private active: { host: string; jobId?: string; startedAt: number; abort: AbortController } | undefined;
	private lastHost: string | undefined;
	private lastJob: string | undefined;

	constructor(deps: RemoteDeps = defaultRemoteDeps()) {
		this.deps = deps;
	}

	get busy(): boolean {
		return this.active !== undefined;
	}

	/** Host and job of whatever is being followed, for a status line. */
	get attached(): { host: string; jobId?: string } | undefined {
		return this.active ? { host: this.active.host, jobId: this.active.jobId } : undefined;
	}

	/**
	 * Which Mac the most recent run actually ran on — kept AFTER the run ends, unlike `attached`.
	 *
	 * The moment a caller most needs the host is the moment `attached` is already gone: a run
	 * that exits refusing to drive names a machine somebody has to go and look at, and with
	 * `--host auto` the caller never chose one to begin with.
	 */
	get lastRunHost(): string | undefined {
		return this.lastHost;
	}

	/**
	 * The job id of the most recent run, kept after it ends for the same reason `lastRunHost`
	 * is: the job id IS the run stamp on the far side (the dispatcher hands it to the child as
	 * RUN_STAMP), so it names the pulled recording directory the humanize hook renders from.
	 */
	get lastRunJobId(): string | undefined {
		return this.lastJob;
	}

	/**
	 * Submit, then follow. Returns an error string for the refusals we can see instantly and
	 * `undefined` otherwise — the dispatch round trip itself takes seconds and reports through
	 * the log, so the caller can raise its `started` event before the first line arrives.
	 */
	start(opts: RemoteRunOptions, handlers: RunHandlers): string | undefined {
		if (this.active) return "already following a remote run — detach or stop it first";
		const app = opts.app.trim();
		if (!app) return "pick an app";
		// Length only. The content of the task is agent.ts's business on the far side.
		if (opts.kind === "task" && !opts.task.trim()) return "enter a task";
		// Refuse rather than run the wrong thing. `DispatchOptions` carries no url, so a website
		// target dispatched to a colo Mac silently became a run against an app named after the
		// host — which either does not exist there or, worse, exists and gets driven. Saying so
		// is a one-line fix; carrying the url through dispatch → job registry → argv is not, and
		// belongs with the fleet backend rather than here.
		if (opts.url) return "website targets only run on this Mac for now — fleet dispatch does not carry the URL yet";

		const abort = new AbortController();
		this.active = { host: opts.host, startedAt: this.deps.now(), abort };
		this.lastHost = opts.host;
		void this.submitThenFollow(opts, handlers, abort);

		return undefined;
	}

	/**
	 * Re-attach to a job that is already running, from the beginning of its log. Byte zero
	 * rather than the tail: the reason to re-attach after a restart is precisely to get back
	 * the output the closed window lost, and the remote still has all of it.
	 */
	attach(host: string, jobId: string, handlers: RunHandlers): string | undefined {
		if (this.active) return "already following a remote run — detach or stop it first";
		const abort = new AbortController();
		this.active = { host, jobId, startedAt: this.deps.now(), abort };
		this.lastJob = jobId;
		this.lastHost = host;
		handlers.onLine(`attaching to ${jobId} on ${host} — replaying its log from the start`);
		void this.followLoop(host, jobId, handlers, abort, 0);

		return undefined;
	}

	/** End the run on the remote. The follow stays up so the job's own last lines still arrive. */
	async stop(): Promise<string | undefined> {
		const current = this.active;
		if (!current) return undefined;
		// The window between submit and the dispatch reply is real — seconds of ssh — and the
		// page shows Stop the moment `started` echoes. In that window `host` can still read
		// `auto` (not a machine; stopRemote would throw resolving it) and `jobId` is unset,
		// which stopRemote treats as "stop whatever that Mac is doing" — possibly someone
		// else's run, the very one whose lease was about to refuse this dispatch.
		if (!current.jobId) return "the dispatch has not been accepted yet — try again in a moment";
		try {
			const result = await this.deps.stopRemote(current.host, current.jobId);

			return result.ok ? undefined : result.error;
		} catch (e) {
			return (e as Error).message;
		}
	}

	/** Stop watching. The remote job is untouched — this is what a closing window does. */
	detach(): void {
		this.active?.abort.abort();
	}

	private async submitThenFollow(opts: RemoteRunOptions, handlers: RunHandlers, abort: AbortController): Promise<void> {
		handlers.onLine(`dispatching ${opts.kind === "explore" ? "grounding pass" : "task"} to ${opts.host}…`);
		let result: DispatchResult;
		try {
			result = await this.deps.dispatch({
				host: opts.host,
				app: opts.app,
				kind: opts.kind,
				task: opts.task,
				record: opts.record,
				noVision: opts.noVision,
			});
		} catch (e) {
			return this.finish(handlers, `✗ dispatch failed: ${(e as Error).message}`, 1);
		}

		if (!result.ok) return this.finish(handlers, `✗ ${result.error}`, 1);

		// `auto` is not a machine anybody can be sent to. From here on the resolved name is the
		// only one worth remembering.
		this.lastHost = result.host.name;
		if (this.active) this.active.host = result.host.name;
		if (this.active) this.active.jobId = result.jobId;
		this.lastJob = result.jobId;
		// Tell the caller which machine this run actually occupies. The shell keys its
		// one-run-per-host bookkeeping on this, and until now the only holder of the resolved
		// name was this controller — after `done` fires, too late to matter.
		handlers.onHost?.(result.host.name);
		handlers.onLine(`${result.jobId} on ${result.host.name}`);
		for (const note of dispatchNotes(result)) handlers.onLine(note);
		await this.followLoop(result.host.name, result.jobId, handlers, abort, 0);
	}

	private async followLoop(host: string, jobId: string, handlers: RunHandlers, abort: AbortController, fromByte: number): Promise<void> {
		const splitter = new LineSplitter();
		let offset = fromByte;
		let lastOutput = this.deps.now();
		const emit = (text: string): void => {
			lastOutput = this.deps.now();
			for (const line of splitter.push(text)) handlers.onLine(line);
		};

		// Ticks faster than it speaks: the note is owed 60s after the LAST output, not on a
		// fixed minute boundary, so the interval samples and `silenceNote` decides.
		const beat = setInterval(() => {
			const note = silenceNote(this.deps.now() - lastOutput, host, jobId);
			if (!note) return;
			lastOutput = this.deps.now();
			handlers.onLine(note);
		}, HEARTBEAT_MS);
		// Unref'd: the shell's event loop is held open by Electron regardless, and a live timer
		// is the difference between a test process that exits and one that hangs on a follow
		// that was deliberately left pending.
		beat.unref?.();

		try {
			// CONSECUTIVE failures, not lifetime attempts. A lifetime counter declared the stream
			// lost on the sixth transient drop of a 40-minute pass even when every reattach in
			// between worked and streamed for minutes — progress has to buy the budget back.
			let failures = 0;
			for (;;) {
				const before = offset;
				let result: FollowResult;
				try {
					result = await this.deps.follow(host, jobId, emit, { fromByte: offset, signal: abort.signal });
				} catch (e) {
					result = { nextOffset: offset, done: false, error: (e as Error).message };
				}
				offset = result.nextOffset;

				if (result.done) {
					for (const line of splitter.flush()) handlers.onLine(line);
					await this.collect(host, jobId, handlers, result);

					return;
				}

				if (abort.signal.aborted) {
					for (const line of splitter.flush()) handlers.onLine(line);

					return this.finish(handlers, `⏸ detached — ${jobId} keeps running on ${host}. Re-attach from the fleet panel.`, 0);
				}

				failures = offset > before ? 1 : failures + 1;
				if (failures > FOLLOW_RETRIES) {
					// Flush like every other exit: the pending partial line is often the run's last words.
					for (const line of splitter.flush()) handlers.onLine(line);

					return this.finish(handlers, `✗ lost the log stream from ${host} (${result.error ?? "stream ended"}) — ${jobId} may still be running`, 1);
				}

				handlers.onLine(`log stream dropped (${result.error ?? "stream ended"}) — reattaching from byte ${offset}`);
				await this.deps.sleep(RETRY_DELAY_MS);
			}
		} finally {
			clearInterval(beat);
		}
	}

	/**
	 * Bring the artifacts home before declaring the run over.
	 *
	 * Ordered this way because the page reloads the gallery on `done`, and a pull that ran
	 * after it would leave the new recording invisible until the next four-second poll — or
	 * until a restart, if the poll had already been told the set of ids had not changed.
	 */
	private async collect(host: string, jobId: string, handlers: RunHandlers, result: FollowResult): Promise<void> {
		handlers.onLine(`run ${result.state ?? "ended"} on ${host} — pulling artifacts`);
		try {
			const pulled = await this.deps.pull(host, jobId);
			for (const a of pulled.artifacts)
				if (a.state !== "missing") handlers.onLine(`${a.state === "pulled" ? "✓" : "✗"} ${a.rel}${a.detail ? ` — ${a.detail}` : ""}`);
			this.deps.record(jobId, host);
			// Exit 3 is agent.ts refusing to drive an app that is not at its declared home state.
			// The remedy is the same whatever the cause — somebody looks at that Mac — and the
			// command has to be written here because the agent, running on the far side, does not
			// know what this inventory calls the machine it is on.
			if (result.exitCode === UNREADY_EXIT && pulled.job?.app) handlers.onLine(`→ sign in by hand: ./run signin ${host} "${pulled.job.app}"`);
			// A grounding pass costs forty minutes; it should cost them once. Only after the map
			// is actually home — a fan-out of a map we failed to pull would push the OLD one back
			// out over the new one on the Mac that just made it.
			if (pulled.job?.kind === "explore" && pulled.artifacts.some((a) => a.key === "appmap" && a.state === "pulled")) {
				const note = await this.deps.sync();
				if (note) handlers.onLine(note);
			}
		} catch (e) {
			handlers.onLine(`✗ pull failed: ${(e as Error).message} — retry with ./run dispatch ${host} pull ${jobId}`);
		}

		this.finish(handlers, undefined, result.exitCode ?? (result.state === "done" ? 0 : 1));
	}

	private finish(handlers: RunHandlers, line: string | undefined, code: number | null): void {
		const startedAt = this.active?.startedAt ?? this.deps.now();
		this.active = undefined;
		if (line) handlers.onLine(line);
		handlers.onDone(code, Math.round((this.deps.now() - startedAt) / 1000));
	}
}

/**
 * Which Mac each pulled run came from.
 *
 * Kept locally rather than read out of the pulled `job.json`, because that record is written
 * on the far side and carries the OPERATOR, not the host: a Mac does not know what this
 * inventory calls it, and two checkouts can name the same machine differently. The mapping is
 * knowledge the client had at pull time and nowhere else.
 */
const REMOTE_INDEX = (): string => `${outDir()}/remote-runs.json`;

export function recordRemoteRun(jobId: string, host: string): void {
	try {
		const index = remoteRunHosts();
		index[jobId] = host;
		fs.mkdirSync(path.dirname(REMOTE_INDEX()), { recursive: true });
		fs.writeFileSync(REMOTE_INDEX(), JSON.stringify(index, null, 2));
	} catch {
		// A gallery badge is not worth failing a completed pull over.
	}
}

export function remoteRunHosts(): Record<string, string> {
	try {
		const raw = JSON.parse(fs.readFileSync(REMOTE_INDEX(), "utf8"));
		const out: Record<string, string> = {};
		for (const [id, host] of Object.entries(raw ?? {})) if (typeof host === "string") out[id] = host;

		return out;
	} catch {
		return {};
	}
}

/**
 * Tag gallery entries with the host that produced them. Locally-run entries are left without
 * a host rather than labelled "local": the badge means "this came off the fleet", and putting
 * one on every row would make the distinction it exists to draw invisible.
 */
export function annotateRuns<T extends { id: string }>(runs: T[], index = remoteRunHosts()): (T & { host?: string })[] {
	return runs.map((r) => (index[r.id] ? { ...r, host: index[r.id] } : r));
}

export interface CredentialsView {
	present: boolean;
	fingerprint?: string;
	path: string;
	/** A boolean, forever. See `describeCredentials`. */
	modelKey: boolean;
}

export type SaveKeyResult = { ok: true; credentials: CredentialsView } | { ok: false; error: string };

/**
 * Store a model key typed into the GUI, and answer with the same boolean view the panel shows
 * when it loads — re-read from disk rather than assumed, so "saved" means the next run will
 * actually find it and not merely that a write did not throw.
 */
export function saveModelKey(key: string, set: (k: string) => void = setModelKey, describe: () => CredentialsView = describeCredentials): SaveKeyResult {
	try {
		set(key);
	} catch (e) {
		// The message comes from the validator, which is written to never quote the input back.
		return { ok: false, error: (e as Error).message };
	}

	return { ok: true, credentials: describe() };
}

export interface RemotePrefs {
	/** Host selected when the shell last closed. `local` when it has never been changed. */
	host: string;
}

/**
 * The host selection, persisted beside — not inside — the UI state.
 *
 * `pruneUiState` in ui-core.ts re-validates its input field by field and drops everything it
 * does not know, which is the right behaviour for a hand-editable file and also means an
 * extra key smuggled into that blob would be silently deleted on the next save. A separate
 * file is one more path and no shared invariant.
 */
const PREFS_PATH = (): string => `${outDir()}/ui-remote.json`;

export function readRemotePrefs(): RemotePrefs {
	try {
		const raw = JSON.parse(fs.readFileSync(PREFS_PATH(), "utf8"));

		return { host: typeof raw?.host === "string" && raw.host.trim() ? raw.host : LOCAL_HOST };
	} catch {
		return { host: LOCAL_HOST };
	}
}

export function writeRemotePrefs(prefs: unknown): void {
	try {
		const host = (prefs as Partial<RemotePrefs> | undefined)?.host;
		fs.mkdirSync(path.dirname(PREFS_PATH()), { recursive: true });
		fs.writeFileSync(PREFS_PATH(), `${JSON.stringify({ host: typeof host === "string" && host.trim() ? host : LOCAL_HOST }, null, 2)}\n`);
	} catch {
		// Same trade as writeUiState: losing a preference is not worth interrupting a run.
	}
}
