import { pathToFileURL } from "node:url";
import { defaultOperator, type HostEntry, type Inventory, loadHosts, resolveHost } from "./hosts.js";
import { firstLine, lastFrame, runnerArgv, runSsh, type SshRunner } from "./ssh.js";

/**
 * The laptop half of remote app/auth management: sign an operator out of an app on a fleet
 * Mac (`authclear`), and uninstall an app from one (`appdelete`). Thin on purpose, like
 * `stopRemote` — every decision lives in the runner, which is the process that owns the lease,
 * the profile lock and the filesystem being changed. This module forwards a spec, parses one
 * frame, and shapes the result for a caller.
 *
 * Both verbs are destructive, so the two wire rules this repo holds everywhere are worth
 * restating here: the app name and the operator cross ONLY inside the base64 spec
 * (`runnerArgv` refuses anything else), and no path of any kind is ever sent — the runner
 * derives every path it deletes from its own constrained helpers.
 */

/**
 * Generous, because both verbs quit an app first — `quitApp` waits up to 20s and escalates to
 * pkill — and `appdelete` then rm -rf's an Electron bundle that can run to hundreds of MB.
 */
const MANAGE_TIMEOUT_MS = 60_000;

export interface AuthClearResult {
	ok: boolean;
	host: string;
	app: string;
	operator: string;
	/** Home-relative live paths the runner deleted. Empty when the requester did not own the live copy. */
	removedLive: string[];
	/** Store-relative parked profile deleted (`<operator>/<slug>`), when one existed. */
	removedProfile?: string;
	ownershipCleared: boolean;
	/** Who owns the live copy when it was left alone. */
	liveOwner?: string;
	/** Present when the refusal was a live lease rather than an error. */
	busy?: boolean;
	error?: string;
}

/** Sign `operator` (defaulting to whoever is running this) out of `app` on a fleet Mac. */
export async function clearAppAuth(
	host: HostEntry | string,
	app: string,
	operator?: string,
	opts: { inventory?: Inventory; run?: SshRunner; timeoutMs?: number } = {},
): Promise<AuthClearResult> {
	const target = toHost(host, opts.inventory);
	const run = opts.run ?? runSsh;
	const op = (operator ?? defaultOperator()).trim() || defaultOperator();

	const res = await run(target, runnerArgv("authclear", { app, operator: op }), { timeoutMs: opts.timeoutMs ?? MANAGE_TIMEOUT_MS });
	const frame = lastFrame(res.stdout);
	if (frame?.ok === true)
		return {
			ok: true,
			host: target.name,
			app: typeof frame.app === "string" ? frame.app : app,
			operator: typeof frame.operator === "string" ? frame.operator : op,
			removedLive: stringList(frame.removedLive),
			ownershipCleared: frame.ownershipCleared === true,
			...(typeof frame.removedProfile === "string" ? { removedProfile: frame.removedProfile } : {}),
			...(typeof frame.liveOwner === "string" ? { liveOwner: frame.liveOwner } : {}),
		};

	return {
		ok: false,
		host: target.name,
		app,
		operator: op,
		removedLive: [],
		ownershipCleared: false,
		...(frame?.busy === true ? { busy: true } : {}),
		error: String(frame?.error ?? firstLine(res.stderr) ?? "") || `runnerctl exited ${res.code}`,
	};
}

export interface AppDeleteResult {
	ok: boolean;
	host: string;
	app: string;
	/** Absolute path of the bundle the runner removed. */
	bundle?: string;
	/** Store-relative parked profiles removed, one per operator. */
	removedProfiles: string[];
	busy?: boolean;
	error?: string;
}

/** Uninstall `app` from a fleet Mac: the bundle plus every operator's parked profile for it. */
export async function deleteRemoteApp(
	host: HostEntry | string,
	app: string,
	opts: { inventory?: Inventory; run?: SshRunner; timeoutMs?: number } = {},
): Promise<AppDeleteResult> {
	const target = toHost(host, opts.inventory);
	const run = opts.run ?? runSsh;

	const res = await run(target, runnerArgv("appdelete", { app }), { timeoutMs: opts.timeoutMs ?? MANAGE_TIMEOUT_MS });
	const frame = lastFrame(res.stdout);
	if (frame?.ok === true)
		return {
			ok: true,
			host: target.name,
			app: typeof frame.app === "string" ? frame.app : app,
			...(typeof frame.bundle === "string" ? { bundle: frame.bundle } : {}),
			removedProfiles: stringList(frame.removedProfiles),
		};

	return {
		ok: false,
		host: target.name,
		app,
		removedProfiles: [],
		...(frame?.busy === true ? { busy: true } : {}),
		error: String(frame?.error ?? firstLine(res.stderr) ?? "") || `runnerctl exited ${res.code}`,
	};
}

/** Shape-checked, never cast: the array crossed a network from a runner of unknown vintage. */
function stringList(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : [];
}

function toHost(host: HostEntry | string, inv?: Inventory): HostEntry {
	return typeof host === "string" ? resolveHost(host, inv ?? loadHosts()) : host;
}

const USAGE = `usage: ./run signout <mac> "<App Name>"
       ./run uninstall <mac> "<App Name>"

signout    sign YOU out of that app on that Mac: quits it and deletes your data there —
           the live copy if you own it, plus your parked profile. Other operators keep theirs.
uninstall  remove the app bundle from that Mac, plus EVERY operator's parked profile for it.
           Live app data under ~/Library stays; use signout for that.`;

/** \`./run signout\` / \`./run uninstall\` — the CLI half of the fleet panel's overflow menu. */
async function main(argv: string[]): Promise<number> {
	const [verb, mac, app] = argv;
	if ((verb !== "signout" && verb !== "uninstall") || !mac || !app?.trim()) {
		console.error(USAGE);

		return 2;
	}

	const host = resolveHost(mac, loadHosts());

	if (verb === "signout") {
		const res = await clearAppAuth(host, app);
		if (!res.ok) {
			console.error(`signout refused: ${res.error}`);

			return 1;
		}
		for (const rel of res.removedLive) console.log(`✓ deleted ~/${rel} (live, on ${host.name})`);
		if (res.removedProfile) console.log(`✓ deleted profiles/${res.removedProfile} (parked, on ${host.name})`);
		if (res.liveOwner) console.log(`· live ${app} data left alone — ${res.liveOwner} owns it`);
		if (!res.removedLive.length && !res.removedProfile) console.log(`nothing was stored for ${res.operator} on ${host.name}`);
		else console.log(`${res.operator} is signed out of ${app} on ${host.name}`);

		return 0;
	}

	const res = await deleteRemoteApp(host, app);
	if (!res.ok) {
		console.error(`uninstall refused: ${res.error}`);

		return 1;
	}
	console.log(`✓ deleted ${res.bundle} on ${host.name}`);
	for (const rel of res.removedProfiles) console.log(`✓ deleted profiles/${rel} (parked)`);

	return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err) => {
			console.error(`manage failed: ${(err as Error).message}`);
			process.exit(1);
		},
	);
