import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { HostEntry } from "../src/remote/control/hosts.js";
import { decodeSpec, type SshResult } from "../src/remote/control/ssh.js";
import { SESSION_WIPE_SCRIPT, sessionWipeHost, type SessionWipeReport } from "../src/remote/control/session-wipe.js";
import type { WipeReport } from "../src/remote/control/browser-wipe.js";

/**
 * Offline by construction: ssh, rsync, doctor and the Chrome wipe are all injected, so
 * nothing here crosses the wire or signals a process. The verb under test kills every GUI
 * app on a fleet Mac and deletes session data for a living — the suite must never be the
 * thing that does either for real.
 */

const HOST: HostEntry = {
	name: "mac1",
	ssh: { host: "203.0.113.10", port: 22, user: "yarn" },
	vnc: { host: "203.0.113.10", port: 5900 },
	hostKey: "SHA256:0000000000000000000000000000000000000000000",
};

const ok = (stdout = ""): SshResult => ({ code: 0, stdout, stderr: "" });

function remoteFrame(extra: Partial<SessionWipeReport> = {}): string {
	return `${JSON.stringify({ host: "mac1-local", go: true, apps: ["Yarn"], processes: 3, ...extra })}\n`;
}

const CHROME_OK: WipeReport = { host: "mac1", profiles: [], go: true, removed: ["Default"] };

interface Captured {
	sshCalls: string[][];
	rsyncCalls: string[][];
	chromeCalls: number;
}

function deps(frame: string, opts: { dataRoot?: string; rsyncCode?: number; chrome?: WipeReport } = {}) {
	const captured: Captured = { sshCalls: [], rsyncCalls: [], chromeCalls: 0 };
	const d = {
		run: async (_host: HostEntry, argv: string[]) => {
			captured.sshCalls.push(argv);

			return ok(argv[0] === "python3" ? frame : "");
		},
		rsync: async (argv: string[]) => {
			captured.rsyncCalls.push(argv);

			return { code: opts.rsyncCode ?? 0, stdout: "", stderr: opts.rsyncCode ? "connection refused" : "" };
		},
		dataRoot: async () => opts.dataRoot,
		chrome: async () => {
			captured.chromeCalls++;

			return opts.chrome ?? CHROME_OK;
		},
	};

	return { d, captured };
}

test("SessionWipeScript__CompilesCleanly__When__PythonParsesIt", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-wipe-"));
	const file = path.join(dir, "session-wipe.py");
	fs.writeFileSync(file, SESSION_WIPE_SCRIPT);
	try {
		await new Promise<void>((resolve, reject) => {
			execFile("python3", ["-m", "py_compile", file], { timeout: 30_000 }, (err, _stdout, stderr) => {
				if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
					t.skip("no python3 on this machine");
					resolve();
				} else if (err) reject(new Error(`the embedded script does not compile: ${stderr}`));
				else resolve();
			});
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("SessionWipeHost__PassesDataRootAsSpec__When__DoctorAnswered", async () => {
	const { d, captured } = deps(remoteFrame(), { dataRoot: "/Users/fleet/yarn-trial" });
	await sessionWipeHost(HOST, true, d);

	const argv = captured.sshCalls[0];
	assert.equal(argv[0], "python3");
	assert.ok(argv.includes("--go"));
	const spec = argv[argv.indexOf("--spec") + 1];
	assert.deepEqual(decodeSpec(spec), { dataRoot: "/Users/fleet/yarn-trial" });
});

test("SessionWipeHost__OmitsSpec__When__DataRootUnknown", async () => {
	const { d, captured } = deps(remoteFrame(), {});
	await sessionWipeHost(HOST, true, d);

	assert.ok(!captured.sshCalls[0].includes("--spec"));
});

test("SessionWipeHost__OmitsGoToken__When__Previewing", async () => {
	const { d, captured } = deps(remoteFrame({ go: false }));
	await sessionWipeHost(HOST, false, d);

	assert.ok(!captured.sshCalls[0].includes("--go"));
	// Preview still runs the Chrome inventory — as a preview.
	assert.equal(captured.chromeCalls, 1);
});

test("SessionWipeHost__SkipsChromeWipe__When__RemoteRefused", async () => {
	const { d, captured } = deps(remoteFrame({ refused: "still running after SIGKILL: Yarn" }));
	const r = await sessionWipeHost(HOST, true, d);

	assert.ok(!("error" in r));
	assert.equal((r as SessionWipeReport).refused, "still running after SIGKILL: Yarn");
	// A survivor writes back what a wipe deletes — the Chrome pass must not even be attempted.
	assert.equal(captured.chromeCalls, 0);
});

test("SessionWipeHost__MergesChromeReport__When__RemoteSucceeds", async () => {
	const { d } = deps(remoteFrame(), { chrome: CHROME_OK });
	const r = (await sessionWipeHost(HOST, true, d)) as SessionWipeReport;

	assert.equal(r.host, "mac1"); // the inventory name, not the remote's nodename
	assert.deepEqual(r.chrome, CHROME_OK);
	assert.deepEqual(r.apps, ["Yarn"]);
});

test("SessionWipeHost__ReturnsError__When__ScriptDeliveryFails", async () => {
	const { d, captured } = deps(remoteFrame(), { rsyncCode: 12 });
	const r = await sessionWipeHost(HOST, true, d);

	assert.ok("error" in r && r.error.includes("could not deliver"));
	assert.equal(captured.sshCalls.length, 0);
	assert.equal(captured.chromeCalls, 0);
});

test("SessionWipeHost__ReturnsError__When__RemotePrintsNoReport", async () => {
	const { d } = deps("ssh banner, no JSON\n");
	const r = await sessionWipeHost(HOST, true, d);

	assert.ok("error" in r);
});
