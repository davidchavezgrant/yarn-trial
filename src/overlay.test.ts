import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The overlay's signal handlers, exercised in real subprocesses.
 *
 * These cannot be unit-tested in-process: the behavior under test IS what happens to the
 * process on a signal, and there is exactly one process. So each case is a tiny script that
 * reproduces the registration overlay does, receives a real SIGINT, and reports through its
 * exit code whether it terminated and whether the other handler got to run.
 *
 * The regression they guard is the one that skipped teardown on every Ctrl-C: overlay's
 * handler calling process.exit() before the run's own graceful handler could read its flag.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The handler registration from overlay.ts, standalone so the test needs no driver/JXA. */
const OVERLAY_HANDLERS = `
let stopped = false;
const stop = () => { if (stopped) return; stopped = true; process.stdout.write("STOP\\n"); };
for (const sig of ["SIGINT", "SIGTERM"]) {
  const onSignal = () => { stop(); if (process.listenerCount(sig) > 0) return; process.kill(process.pid, sig); };
  process.once(sig, onSignal);
}
`;

function runScript(body: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> {
	const dir = mkdtempSync(path.join(tmpdir(), "overlay-test-"));
	const file = path.join(dir, "case.mjs");
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", body], { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout.on("data", (b) => (out += b.toString()));
		child.on("spawn", () => setTimeout(() => child.kill("SIGINT"), 300));
		child.on("close", (code, signal) => {
			rmSync(dir, { recursive: true, force: true });
			resolve({ code, signal, out });
		});
	});
}

test("overlaySignals__TerminateTheProcess__When__NoOtherHandlerIsPresent", async () => {
	// canvas-probe uses the overlay without onInterrupt: a bare listener must not suppress the
	// default terminate and leave the probe hung on Ctrl-C.
	const { code, signal, out } = await runScript(`
${OVERLAY_HANDLERS}
setTimeout(() => { process.stdout.write("ALIVE\\n"); process.exit(2); }, 3000);
process.stdout.write("ready\\n");
`);
	assert.ok(out.includes("STOP"), "banner cleanup ran");
	assert.ok(!out.includes("ALIVE"), "process did not survive the signal");
	assert.ok(code === 130 || signal === "SIGINT", `terminated by signal (code=${code}, signal=${signal})`);
});

test("overlaySignals__DeferToTheGracefulHandler__When__OneIsRegisteredAfter", async () => {
	// agent/explore/cleanup register onInterrupt AFTER the overlay. The overlay must clear the
	// banner and then let that handler own termination, so the run log and teardown still run.
	const { code, out } = await runScript(`
${OVERLAY_HANDLERS}
process.on("SIGINT", () => { process.stdout.write("GRACEFUL\\n"); setTimeout(() => process.exit(0), 150); });
setTimeout(() => { process.stdout.write("TIMEOUT\\n"); process.exit(2); }, 3000);
process.stdout.write("ready\\n");
`);
	assert.ok(out.includes("STOP"), "banner cleanup still ran");
	assert.ok(out.includes("GRACEFUL"), "the graceful handler got to run");
	assert.ok(!out.includes("TIMEOUT"), "did not hang");
	assert.equal(code, 0, "graceful handler owned the exit code");
});
