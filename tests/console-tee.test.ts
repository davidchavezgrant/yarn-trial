import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fdIsFile, teeConsole, teeWrites, type TeeSink } from "../src/core/harness/console-tee.js";
import { RUN_FILES, runPath } from "../src/paths.js";

/**
 * The tee is what gives LOCAL runs the same log.txt a dispatched job gets from the runner's
 * stdio redirection — and the guard is what keeps a dispatched job from getting every line
 * twice. Both sides are exercised here without touching the process's real stdout: the sinks
 * and the guarded fds are injectable for exactly this reason.
 */

/** Run `fn` with the data root pointed at a fresh temp dir; restore and delete afterwards. */
function inTempData(fn: (dir: string) => void): void {
	const prev = process.env.YARN_RUNNER_DATA;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-tee-test-"));
	try {
		process.env.YARN_RUNNER_DATA = dir;
		fn(dir);
	} finally {
		if (prev === undefined) delete process.env.YARN_RUNNER_DATA;
		else process.env.YARN_RUNNER_DATA = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** A sink that records what reached the "terminal", with a controllable return value. */
function makeSink(ret = true): TeeSink & { got: string[] } {
	const got: string[] = [];

	return {
		got,
		write(chunk: string | Uint8Array): boolean {
			got.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));

			return ret;
		},
	};
}

test("fdIsFile__ReturnsTrue__When__FdNamesTheSameFile", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-is-file-"));
	const file = path.join(dir, "log.txt");
	fs.writeFileSync(file, "");
	const fd = fs.openSync(file, "a");
	try {
		assert.equal(fdIsFile(fd, file), true);
	} finally {
		fs.closeSync(fd);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("fdIsFile__ReturnsFalse__When__PathIsAnotherFileOrMissing", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-is-file-"));
	const a = path.join(dir, "a.txt");
	const b = path.join(dir, "b.txt");
	fs.writeFileSync(a, "");
	fs.writeFileSync(b, "");
	const fd = fs.openSync(a, "a");
	try {
		assert.equal(fdIsFile(fd, b), false);
		assert.equal(fdIsFile(fd, path.join(dir, "never-written.txt")), false);
	} finally {
		fs.closeSync(fd);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("teeWrites__MirrorsToFileAndForwards__When__StreamIsWritten", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tee-writes-"));
	const file = path.join(dir, "log.txt");
	const fd = fs.openSync(file, "a");
	const sink = makeSink(false);
	try {
		teeWrites(sink, fd);
		// The wrapper must forward the original stream's return value, not invent its own:
		// backpressure signalling belongs to the real stream.
		assert.equal(sink.write("hello "), false);
		sink.write(Buffer.from("world\n"));
		assert.deepEqual(sink.got, ["hello ", "world\n"]);
		assert.equal(fs.readFileSync(file, "utf8"), "hello world\n");
	} finally {
		fs.closeSync(fd);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("teeWrites__KeepsStreamWorking__When__MirrorFdIsClosed", () => {
	// A full disk or a closed fd may lose the mirror; it must never lose the run's real output.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tee-writes-"));
	const file = path.join(dir, "log.txt");
	const fd = fs.openSync(file, "a");
	const sink = makeSink();
	teeWrites(sink, fd);
	fs.closeSync(fd);
	try {
		assert.equal(sink.write("still delivered\n"), true);
		assert.deepEqual(sink.got, ["still delivered\n"]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("teeConsole__WritesRunFolderLogTxt__When__OutputIsNotAlreadyRedirected", () => {
	inTempData(() => {
		const out = makeSink();
		const err = makeSink();
		const file = teeConsole("2026-08-01T12-00-00-yarn", [out, err]);
		assert.equal(file, runPath("2026-08-01T12-00-00-yarn", RUN_FILES.console));
		out.write("from stdout\n");
		err.write("from stderr\n");
		// One file, both streams, console order — the artifact the runner produces for
		// dispatched jobs, now produced by the run itself everywhere else.
		assert.equal(fs.readFileSync(file!, "utf8"), "from stdout\nfrom stderr\n");
	});
});

test("teeConsole__StandsDown__When__AnFdAlreadyPointsAtLogTxt", () => {
	// The runner case: spawnDetached hands the child fd 1/2 opened on the run folder's own
	// log.txt, so a second writer would double every line. The guard is file IDENTITY on the
	// checked fds — injected here so the test does not have to re-point the process's stdout.
	inTempData(() => {
		const key = "2026-08-01T13-00-00-yarn";
		const file = runPath(key, RUN_FILES.console);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "");
		const fd = fs.openSync(file, "a");
		const sink = makeSink();
		try {
			assert.equal(teeConsole(key, [sink], [fd]), undefined);
			sink.write("runner-managed line\n");
			// The sink was never hooked: the line reached the "terminal" (the runner's fd) only.
			assert.equal(fs.readFileSync(file, "utf8"), "");
		} finally {
			fs.closeSync(fd);
		}
	});
});
