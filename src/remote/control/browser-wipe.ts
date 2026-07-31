import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { resourcesRoot } from "../../paths.js";
import { loadHosts, resolveHost, type HostEntry } from "./hosts.js";
import { lastFrame, runnerArgv, runRsync, runSsh, rsyncShell, type SshRunner } from "./ssh.js";

/**
 * `./run browser-wipe [<mac>|all] [--go]` — remove every Chrome profile on the fleet Macs.
 *
 * WHY. Measured 2026-07-31: all three colo Macs had three people's PERSONAL Google accounts
 * signed into one shared Chrome profile (two of them `@gmail.com`), sync on, 801 saved
 * credentials each. The identical count is sync working as designed — one vault, replicated —
 * and a liveview sign-in put that autofill dropdown on screen for a teammate to read. Shared
 * infrastructure should not be signed into anybody's personal account.
 *
 * WHY THIS IS SAFE, when clearing passwords normally is not. The hazard is the sync TOMBSTONE:
 * deleting a credential through a RUNNING, signed-in Chrome emits `PasswordStoreChange::REMOVE`,
 * which propagates to that person's vault and every device they own. That is a property of
 * deleting through the browser. With Chrome closed, no process is connected to Google to report
 * anything, so removing the profile directory is purely local — the accounts keep their vaults
 * and this machine simply forgets them. The runner-side half quits Chrome first and REFUSES if
 * it will not exit; see `runner/browser-reset.ts`, where that ordering is the safety property.
 *
 * WHY IT IS NOT A `runnerctl` VERB. It needs no TCC grant — no capture, no accessibility, no
 * Apple Events — only file access as the login user, which plain ssh already has. The runner
 * exists to be the responsible process for the grants; borrowing it for a file delete would
 * add a deploy step to every fix here for nothing.
 *
 * GATED. Without `--go` it reports what WOULD be removed and exits 2, the same shape as
 * `bench phase`. Deleting somebody's saved passwords is not a thing to do on a typo.
 */

/** Runs on the far side. Delivered by rsync, never as shell text — the paths contain spaces. */
const REMOTE_SCRIPT = `#!/usr/bin/env python3
import glob, json, os, shutil, sqlite3, subprocess, sys, time

GO = "--go" in sys.argv
ROOT = os.path.expanduser("~/Library/Application Support/Google/Chrome")
EXEC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

def chrome_pids():
    # -f against the executable path: the app name contains a space, and pgrep -x wants it as
    # one argument, which does not survive every caller. Helpers exit with the browser.
    r = subprocess.run(["pgrep", "-f", "^" + EXEC.replace(" ", ".") + "$"], capture_output=True, text=True)
    return [int(p) for p in r.stdout.split() if p.strip().isdigit()]

def profiles():
    # A profile is a directory holding Preferences. The root is also full of caches and
    # component dirs (ShaderCache, Crashpad, Safe Browsing) that are NOT profiles, and
    # removing the root wholesale would take Chrome's install state with it.
    return sorted(d for d in glob.glob(os.path.join(ROOT, "*")) if os.path.isfile(os.path.join(d, "Preferences")))

report = {"host": os.uname().nodename, "profiles": [], "go": GO}
for d in profiles():
    entry = {"name": os.path.basename(d), "accounts": [], "logins": 0}
    try:
        p = json.load(open(os.path.join(d, "Preferences")))
        entry["accounts"] = [a.get("email", "?") for a in (p.get("account_info") or [])]
        entry["syncing"] = bool(((p.get("google") or {}).get("services") or {}).get("consented_to_sync"))
    except Exception:
        pass
    lp = os.path.join(d, "Login Data")
    if os.path.exists(lp):
        try:
            c = sqlite3.connect("file:" + lp.replace(" ", "%20") + "?immutable=1", uri=True)
            entry["logins"] = c.execute("select count(*) from logins").fetchone()[0]
            c.close()
        except Exception:
            entry["logins"] = -1
    report["profiles"].append(entry)

if GO:
    live = chrome_pids()
    report["quitChrome"] = bool(live)
    if live:
        # SIGTERM, never SIGKILL: Chrome flushes its databases on TERM, and a corrupt store is
        # the state this exists to avoid producing.
        subprocess.run(["kill"] + [str(p) for p in live])
        for _ in range(20):
            time.sleep(0.5)
            if not chrome_pids():
                break
    still = chrome_pids()
    if still:
        # Refuse rather than delete underneath a live Chrome: it holds these databases open and
        # writes them back on quit, so the deletion would silently undo itself.
        report["refused"] = "Chrome is still running (pid %s)" % ", ".join(map(str, still))
    else:
        removed = []
        for d in profiles():
            # The WHOLE directory, not selected files. Deleting Login Data alone leaves
            # sync_model_metadata behind, and the next launch re-downloads every credential
            # from the server — a deletion that appears to work and quietly reverses itself.
            shutil.rmtree(d, ignore_errors=True)
            removed.append(os.path.basename(d))
        report["removed"] = removed

print(json.dumps(report))
`;

export interface WipeReport {
	host: string;
	profiles: { name: string; accounts: string[]; syncing?: boolean; logins: number }[];
	go: boolean;
	quitChrome?: boolean;
	removed?: string[];
	refused?: string;
}

/** Deliver the script and run it. Nothing variable crosses as text; `--go` is a fixed token. */
export async function wipeHost(host: HostEntry, go: boolean, run: SshRunner = runSsh): Promise<WipeReport | { host: string; error: string }> {
	const local = `${resourcesRoot()}/out/browser-wipe.py`;
	fs.mkdirSync(`${resourcesRoot()}/out`, { recursive: true });
	fs.writeFileSync(local, REMOTE_SCRIPT, { mode: 0o700 });
	const put = await runRsync(["-q", "--rsh", rsyncShell(host), local, `${host.ssh.user}@${host.ssh.host}:/tmp/browser-wipe.py`], { timeoutMs: 30_000 });
	if (put.code !== 0) return { host: host.name, error: `could not deliver the script: ${put.stderr.trim() || put.code}` };

	const res = await run(host, ["python3", "/tmp/browser-wipe.py", ...(go ? ["--go"] : [])], { timeoutMs: 120_000 });
	await run(host, ["rm", "-f", "/tmp/browser-wipe.py"], { timeoutMs: 15_000 });
	const frame = lastFrame(res.stdout) as unknown as WipeReport | undefined;
	if (!frame) return { host: host.name, error: res.stderr.trim() || `no report (exit ${res.code})` };

	return { ...frame, host: host.name };
}

function describe(r: WipeReport): string {
	const lines = [`${r.host}:`];
	for (const p of r.profiles)
		lines.push(`    ${p.name}: ${p.logins} saved login(s)${p.syncing ? ", SYNC ON" : ""}${p.accounts.length ? ` — ${p.accounts.join(", ")}` : " — no account"}`);
	if (!r.profiles.length) lines.push("    no Chrome profiles");
	if (r.refused) lines.push(`    ✗ refused: ${r.refused}`);
	else if (r.removed) lines.push(`    ✓ removed ${r.removed.length} profile(s)${r.quitChrome ? " (quit Chrome first)" : ""}`);

	return lines.join("\n");
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const go = argv.includes("--go");
	const target = argv.find((a) => !a.startsWith("--")) ?? "all";
	const inv = loadHosts();
	const hosts = target === "all" ? inv.hosts : [resolveHost(target, inv)];

	console.log(go ? "Removing every Chrome profile on:" : "Would remove every Chrome profile on (preview — pass --go to do it):");
	let refused = false;
	for (const host of hosts) {
		const r = await wipeHost(host, go);
		if ("error" in r) {
			console.log(`${host.name}: ✗ ${r.error}`);
			refused = true;
			continue;
		}
		console.log(describe(r));
		if (r.refused) refused = true;
	}

	if (!go) {
		console.log("\nThis deletes the accounts, the saved passwords and the form history on those Macs.");
		console.log("Chrome is quit first, and with it closed the deletion is LOCAL — no sync tombstone");
		console.log("reaches anyone's Google account. Re-run with --go to proceed.");
		process.exit(2);
	}
	process.exit(refused ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	main().catch((e) => {
		console.error(`browser-wipe failed: ${e}`);
		process.exit(1);
	});
