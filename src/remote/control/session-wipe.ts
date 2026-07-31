import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { resourcesRoot } from "../../paths.js";
import { HOSTS_SCHEMA, loadHosts, resolveHost, type HostEntry } from "./hosts.js";
import { encodeSpec, lastFrame, remoteDataRoot, runRsync, runSsh, rsyncShell, type RsyncRunner, type SshRunner } from "./ssh.js";
import { wipeHost, type WipeReport } from "./browser-wipe.js";
import { fleetStatus } from "./fleet.js";

/**
 * `./run session-wipe [<mac>|all] [--go] [--force]` — clear ALL session state on the fleet Macs.
 *
 * The full-strength sibling of `browser-wipe`, for handing a box back in a known-clean state:
 * nobody signed into anything, no app left running. Four stores go, in this order:
 *
 *   1. Every running GUI app is closed — SIGTERM first (Electron and Chromium flush their
 *      cookie jars and databases on TERM), SIGKILL for whatever ignored it. The escalation is
 *      deliberate and the ordering is the safety property: everything below deletes files a
 *      running app holds open and writes back on quit, so nothing is deleted until the
 *      process table says nothing is left to resurrect it. Chrome is in this set — a KILLed
 *      Chrome cannot emit a sync tombstone (there is no process left to report the deletion)
 *      and cannot corrupt a store that is about to be removed anyway.
 *   2. The cdp backend's persistent Chrome profiles (`<dataRoot>/out/chrome-profile/`) — the
 *      web sign-ins every later `--url` run inherits. `dataRoot` differs per Mac, so it is
 *      asked of the runner's `doctor` and crosses as a base64 spec, never as shell text.
 *   3. The per-operator profile store (`~/.yarn-runner/profiles`) — every parked session for
 *      every operator for every app, owners.json included: an owner row pointing at data this
 *      verb deletes would park the wrong operator's name on the next swap (see `clearOwner`
 *      in runner/profiles.ts).
 *   4. Every installed app's live data under ~/Library, using the same candidate list as
 *      `livePaths()` in runner/profiles.ts — a sweep of that module's existing theory of
 *      where sessions live, not a new one. Google Chrome is EXCLUDED from this sweep: its
 *      default profiles are `browser-wipe`'s job (reused below, not duplicated), which
 *      preserves `com.google.Chrome.plist` — the autofill lockdown policy a blanket
 *      Preferences delete would silently un-apply.
 *
 * WHAT SURVIVES, deliberately: the runner daemon (its Electron lives under the checkout's
 * node_modules, not /Applications, so the kill sweep never matches it — and launchd's
 * KeepAlive would restart it anyway), the rest of `~/.yarn-runner` (job registry, lease,
 * logs, the fleet identity), and Chrome's policy plist.
 *
 * NOT a `runnerctl` verb, same reasoning as browser-wipe: signals and file deletes as the
 * login user need no TCC grant, so plain ssh suffices and the runner does not have to be
 * healthy for a box to be wiped.
 *
 * GATED TWICE. Without `--go` it reports what WOULD happen and exits 2. A host whose runner
 * reports a live lease or a queue is refused without `--force` — killing every GUI app under
 * a run in flight destroys the run.
 */

/** Runs on the far side. Delivered by rsync, never as shell text — the paths contain spaces. */
const REMOTE_SCRIPT = `#!/usr/bin/env python3
import base64, glob, json, os, plistlib, shutil, subprocess, sys, time

GO = "--go" in sys.argv
SPEC = {}
if "--spec" in sys.argv:
    try:
        SPEC = json.loads(base64.b64decode(sys.argv[sys.argv.index("--spec") + 1]))
    except Exception:
        SPEC = {}

HOME = os.path.expanduser("~")
APP_ROOTS = ["/Applications", os.path.join(HOME, "Applications")]
KILL_ROOTS = APP_ROOTS + ["/System/Applications"]
PROFILES_STORE = os.path.join(HOME, ".yarn-runner", "profiles")

# The same candidate list as livePaths() in runner/profiles.ts, and it must stay that way:
# this sweep deletes what that module preserves, so a location added there is a session this
# misses until the lists agree again.
LIVE_TEMPLATES = [
    "Library/Application Support/%s",
    "Library/Caches/%s",
    "Library/Preferences/%s.plist",
    "Library/Containers/%s",
    "Library/Saved Application State/%s.savedState",
    "Library/WebKit/%s",
    "Library/HTTPStorages/%s",
    "Library/HTTPStorages/%s.binarycookies",
    "Library/Cookies/%s.binarycookies",
]

def gui_procs():
    # comm is the executable PATH on macOS ps, independent of argv — so the cdp backend's
    # Chrome (launched with --user-data-dir and debug flags) matches exactly like a Dock
    # launch, where an anchored pgrep -f over the argv string would not. Helpers live under
    # .app/Contents/Frameworks/<X> Helper.app/Contents/MacOS/ and match too, harmlessly.
    r = subprocess.run(["ps", "-axo", "pid=,comm="], capture_output=True, text=True)
    procs = []
    for line in r.stdout.splitlines():
        pid, _, comm = line.strip().partition(" ")
        comm = comm.strip()
        if not pid.isdigit() or "/Contents/MacOS/" not in comm:
            continue
        if any(comm.startswith(root + "/") for root in KILL_ROOTS):
            procs.append((int(pid), comm))
    return procs

def app_of(comm):
    # The OUTERMOST bundle name: a helper's path has two .app segments and the report should
    # say "Google Chrome", not "Google Chrome Helper (GPU)".
    i = comm.find(".app/")
    return os.path.basename(comm[:i]) if i >= 0 else os.path.basename(comm)

def signal_all(procs, sig):
    for pid, _ in procs:
        try:
            os.kill(pid, sig)
        except OSError:
            pass  # already gone, or not ours to signal — the re-poll decides what is left

def wait_gone(seconds):
    deadline = time.time() + seconds
    left = gui_procs()
    while left and time.time() < deadline:
        time.sleep(0.5)
        left = gui_procs()
    return left

def bundles():
    apps = []
    for root in APP_ROOTS:
        apps += glob.glob(os.path.join(root, "*.app"))
        apps += glob.glob(os.path.join(root, "*", "*.app"))  # /Applications/Utilities and friends
    out = []
    for bundle in sorted(set(apps)):
        name = os.path.basename(bundle)[:-4]
        bid = None
        try:
            with open(os.path.join(bundle, "Contents", "Info.plist"), "rb") as f:
                v = plistlib.load(f).get("CFBundleIdentifier")
                bid = v if isinstance(v, str) else None
        except Exception:
            pass
        out.append((name, bid))
    return out

def live_paths(name, bid):
    # Same constraint as livePaths(): a key becomes one path segment under ~/Library, so a
    # separator or a dot-segment would walk the delete out of it.
    keys = [k for k in (name, bid) if k and "/" not in k and k not in (".", "..")]
    rels = []
    for k in keys:
        for t in LIVE_TEMPLATES:
            rel = t % k
            if rel not in rels:
                rels.append(rel)
    return [rel for rel in rels if os.path.exists(os.path.join(HOME, rel))]

def rm(target, denied):
    try:
        if os.path.isdir(target) and not os.path.islink(target):
            shutil.rmtree(target)
        else:
            os.remove(target)
        return True
    except OSError as e:
        # TCC-protected containers EPERM under ssh. Collected and reported, never fatal:
        # a partial wipe that says what it could not reach beats one that dies half done.
        denied.append("%s: %s" % (target, e.strerror or str(e)))
        return False

report = {"host": os.uname().nodename, "go": GO}

# 1. Close every GUI app. Nothing may be left holding open the files the rest of this
#    script deletes — a deletion under a live app is written back on quit.
procs = gui_procs()
report["apps"] = sorted(set(app_of(c) for _, c in procs))
report["processes"] = len(procs)

if GO:
    signal_all(procs, 15)
    left = wait_gone(10)
    report["escalated"] = sorted(set(app_of(c) for _, c in left))
    if left:
        # SIGKILL is safe HERE and only here: the stores an unflushed quit could corrupt are
        # the stores about to be deleted, and a dead process cannot emit a sync tombstone.
        signal_all(left, 9)
        left = wait_gone(5)
    if left:
        report["refused"] = "still running after SIGKILL: " + ", ".join(sorted(set(app_of(c) for _, c in left)))
        print(json.dumps(report))
        sys.exit(0)

# 2. The cdp backend's persistent web-login profiles.
data_root = SPEC.get("dataRoot")
if not data_root:
    report["cdpProfiles"] = {"skipped": "dataRoot unknown - the runner did not answer doctor"}
else:
    cdp_root = os.path.join(data_root, "out", "chrome-profile")
    names = sorted(os.path.basename(p) for p in glob.glob(os.path.join(cdp_root, "*")) if os.path.isdir(p))
    entry = {"root": cdp_root, "profiles": names}
    if GO and names:
        denied = []
        entry["removed"] = rm(cdp_root, denied)
        if denied:
            entry["denied"] = denied
    report["cdpProfiles"] = entry

# 3. The per-operator profile store, owners.json included.
ops = sorted(d for d in os.listdir(PROFILES_STORE) if os.path.isdir(os.path.join(PROFILES_STORE, d))) if os.path.isdir(PROFILES_STORE) else []
store = {"root": PROFILES_STORE, "operators": ops}
if GO and os.path.isdir(PROFILES_STORE):
    denied = []
    store["removed"] = rm(PROFILES_STORE, denied)
    if denied:
        store["denied"] = denied
report["operatorStore"] = store

# 4. Live app data under ~/Library, every installed app. Chrome's default profiles are the
#    dedicated browser-wipe's job — it preserves the policy plist this sweep would take.
swept = []
for name, bid in bundles():
    if name == "Google Chrome" or bid == "com.google.Chrome":
        continue
    found = live_paths(name, bid)
    if not found:
        continue
    entry = {"app": name, "paths": len(found)}
    if GO:
        denied = []
        entry["removed"] = sum(1 for rel in found if rm(os.path.join(HOME, rel), denied))
        if denied:
            entry["denied"] = denied
    swept.append(entry)
report["appData"] = swept

print(json.dumps(report))
`;

export interface SessionWipeReport {
	host: string;
	go: boolean;
	/** GUI apps that were running (would be / were closed), as outermost bundle names. */
	apps: string[];
	processes: number;
	/** Apps that ignored SIGTERM and needed SIGKILL. */
	escalated?: string[];
	/** Set when something outlived even SIGKILL — nothing was deleted. */
	refused?: string;
	cdpProfiles?: { root?: string; profiles?: string[]; removed?: boolean; denied?: string[]; skipped?: string };
	operatorStore?: { root: string; operators: string[]; removed?: boolean; denied?: string[] };
	appData?: { app: string; paths: number; removed?: number; denied?: string[] }[];
	/** The default Chrome profiles, via the existing browser-wipe. */
	chrome?: WipeReport | { host: string; error: string };
}

/** Every effect is injectable so the suite never signals a process or crosses the wire. */
export interface SessionWipeDeps {
	run?: SshRunner;
	rsync?: RsyncRunner;
	dataRoot?: (host: HostEntry) => Promise<string | undefined>;
	chrome?: (host: HostEntry, go: boolean) => Promise<WipeReport | { host: string; error: string }>;
}

/** Deliver the script and run it. Nothing variable crosses as text — `dataRoot` rides a base64 spec. */
export async function sessionWipeHost(host: HostEntry, go: boolean, deps: SessionWipeDeps = {}): Promise<SessionWipeReport | { host: string; error: string }> {
	const run = deps.run ?? runSsh;
	const rsync = deps.rsync ?? runRsync;

	const local = `${resourcesRoot()}/out/session-wipe.py`;
	fs.mkdirSync(`${resourcesRoot()}/out`, { recursive: true });
	fs.writeFileSync(local, REMOTE_SCRIPT, { mode: 0o700 });
	const put = await rsync(["-q", "--rsh", rsyncShell(host), local, `${host.ssh.user}@${host.ssh.host}:/tmp/session-wipe.py`], { timeoutMs: 30_000 });
	if (put.code !== 0) return { host: host.name, error: `could not deliver the script: ${put.stderr.trim() || put.code}` };

	// Asked, not assumed: the fleet's checkouts need not live where this one does, and a wrong
	// guess here would delete nothing while reporting success. Unanswered means the remote
	// script skips the cdp profiles and says so.
	const dataRoot = await (deps.dataRoot ?? ((h: HostEntry) => remoteDataRoot(h, run)))(host);

	const argv = ["python3", "/tmp/session-wipe.py", ...(go ? ["--go"] : []), ...(dataRoot ? ["--spec", encodeSpec({ dataRoot })] : [])];
	// TERM wait (10s) + KILL wait (5s) + rmtree over browser-sized profile trees.
	const res = await run(host, argv, { timeoutMs: 180_000 });
	await run(host, ["rm", "-f", "/tmp/session-wipe.py"], { timeoutMs: 15_000 });
	const frame = lastFrame(res.stdout) as unknown as SessionWipeReport | undefined;
	if (!frame) return { host: host.name, error: res.stderr.trim() || `no report (exit ${res.code})` };
	// Something survived SIGKILL — do not go near the Chrome profiles either; a live process
	// writes back what a wipe deletes, and wipeHost would only rediscover the same refusal.
	if (frame.refused) return { ...frame, host: host.name };

	// The default Chrome profiles, through the existing verb so the sync-tombstone reasoning
	// lives in exactly one place. Every Chrome process is already dead, so its TERM-only
	// quit path finds nothing to refuse over.
	const chrome = await (deps.chrome ?? ((h: HostEntry, g: boolean) => wipeHost(h, g)))(host, go);

	return { ...frame, host: host.name, chrome };
}

function describe(r: SessionWipeReport): string {
	const lines = [`${r.host}:`];
	const verb = r.go ? "closed" : "would close";
	lines.push(`    ${verb} ${r.apps.length} GUI app(s)${r.apps.length ? `: ${r.apps.join(", ")}` : ""} (${r.processes} process(es))`);
	if (r.escalated?.length) lines.push(`    needed SIGKILL: ${r.escalated.join(", ")}`);
	if (r.refused) {
		lines.push(`    ✗ refused: ${r.refused}`);

		return lines.join("\n");
	}

	const cdp = r.cdpProfiles;
	if (cdp?.skipped) lines.push(`    cdp web-login profiles: skipped — ${cdp.skipped}`);
	else if (cdp) lines.push(`    cdp web-login profiles at ${cdp.root}: ${cdp.profiles?.length ? cdp.profiles.join(", ") : "none"}${cdp.removed ? " — removed" : ""}${cdp.denied?.length ? ` (denied: ${cdp.denied.join("; ")})` : ""}`);

	const store = r.operatorStore;
	if (store) lines.push(`    operator profile store: ${store.operators.length ? `${store.operators.length} operator(s) — ${store.operators.join(", ")}` : "empty"}${store.removed ? " — removed" : ""}${store.denied?.length ? ` (denied: ${store.denied.join("; ")})` : ""}`);

	for (const a of r.appData ?? [])
		lines.push(`    ${a.app}: ${a.paths} live data path(s)${a.removed !== undefined ? ` — removed ${a.removed}` : ""}${a.denied?.length ? ` (denied: ${a.denied.join("; ")})` : ""}`);

	const c = r.chrome;
	if (c && "error" in c) lines.push(`    ✗ chrome profiles: ${c.error}`);
	else if (c?.refused) lines.push(`    ✗ chrome profiles refused: ${c.refused}`);
	else if (c?.removed) lines.push(`    chrome profiles: removed ${c.removed.length}`);
	else if (c) lines.push(`    chrome profiles: ${c.profiles.length ? c.profiles.map((p) => `${p.name} (${p.logins} login(s)${p.accounts.length ? `, ${p.accounts.join(", ")}` : ""})`).join(", ") : "none"}`);

	return lines.join("\n");
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const go = argv.includes("--go");
	const force = argv.includes("--force");
	const target = argv.find((a) => !a.startsWith("--")) ?? "all";
	const inv = loadHosts();
	const hosts = target === "all" ? inv.hosts : [resolveHost(target, inv)];

	// A live lease or a queued job means someone's run dies with the apps. Refused, not raced:
	// the durable queue would drain the next job into a box this is mid-wipe on.
	const rows = await fleetStatus({ inventory: { schema: HOSTS_SCHEMA, hosts } });
	const busy = rows.filter((r) => r.state === "busy" || (r.queue?.length ?? 0) > 0);
	if (busy.length && !force) {
		for (const b of busy) console.error(`${b.name}: busy${b.app ? ` (${b.app})` : ""}${b.queue?.length ? `, ${b.queue.length} queued` : ""} — a wipe would kill the run. Pass --force to do it anyway.`);
		process.exit(1);
	}

	console.log(go ? "Clearing ALL session state on:" : "Would clear ALL session state on (preview — pass --go to do it):");
	let failed = false;
	for (const host of hosts) {
		const r = await sessionWipeHost(host, go);
		if ("error" in r) {
			console.log(`${host.name}: ✗ ${r.error}`);
			failed = true;
			continue;
		}
		console.log(describe(r));
		if (r.refused || (r.chrome && ("error" in r.chrome || r.chrome.refused))) failed = true;
	}

	if (!go) {
		console.log("\nThis closes every GUI app on those Macs (SIGTERM, then SIGKILL), signs everyone out of");
		console.log("everything — Chrome profiles, cdp web-login profiles, every operator's parked app");
		console.log("profiles, and every installed app's data under ~/Library. The runner daemon survives.");
		console.log("Re-run with --go to proceed.");
		process.exit(2);
	}
	process.exit(failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	main().catch((e) => {
		console.error(`session-wipe failed: ${e}`);
		process.exit(1);
	});

/** Exported for the test that compiles it with a real python3 — never for reuse as text. */
export { REMOTE_SCRIPT as SESSION_WIPE_SCRIPT };
