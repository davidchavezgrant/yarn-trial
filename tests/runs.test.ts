/**
 * The run directory, its backup, and the two operations performed on them by hand.
 *
 * `out/bench/live/<key>/` is the canonical record; `out/bench/archive/<key>/` is a hard-linked backup taken
 * when a run ends. The properties worth testing are the ones a `rm -rf` depends on: that the
 * backup survives the live copy being deleted, and that nothing deletes a run it has not backed
 * up first. Everything else here is path arithmetic.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { archiveRun, archiveRunDir, legacyRunPath, RUN_FILES, runDir, runFile, runPath, runRel } from "../src/paths.js";
import { dropRun, listRuns } from "../src/core/runs-cli.js";

function withOut(fn: (root: string) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "yarn-runs-"));
	try {
		fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

/** A finished run on disk: log, journal, a step frame and a recording frame. */
function makeRun(root: string, key: string, log: Record<string, unknown> = { app: "Yarn", success: true }): string {
	const dir = runDir(key, root);
	fs.mkdirSync(path.join(dir, RUN_FILES.steps), { recursive: true });
	fs.mkdirSync(path.join(dir, RUN_FILES.recording, "frames"), { recursive: true });
	fs.writeFileSync(path.join(dir, RUN_FILES.log), JSON.stringify(log));
	fs.writeFileSync(path.join(dir, RUN_FILES.journal), '{"control":"Cursor style"}\n');
	fs.writeFileSync(path.join(dir, RUN_FILES.steps, "agent-step-1.png"), "PNG");
	fs.writeFileSync(path.join(dir, RUN_FILES.recording, "frames", "0001.png"), "PNG");

	return dir;
}

test("archiveRun__KeepsTheLiveCopy__When__ItBacksARunUp", () => {
	// The correction that shaped this design: live is the canonical record the dashboard reads,
	// not a staging area. Backing a run up must leave it exactly where every reader expects it.
	withOut((root) => {
		const dir = makeRun(root, "run-a");
		const to = archiveRun("run-a", root);

		assert.equal(to, archiveRunDir("run-a", root));
		assert.ok(fs.existsSync(path.join(dir, RUN_FILES.log)), "the live copy must survive its own backup");
		// The WHOLE tree, nested directories included — the step frames are the part a
		// hand-written glob forgot for long enough to blank the offline judge's visual channel.
		assert.ok(fs.existsSync(path.join(to!, RUN_FILES.steps, "agent-step-1.png")));
		assert.ok(fs.existsSync(path.join(to!, RUN_FILES.recording, "frames", "0001.png")));
	});
});

test("archiveRun__SurvivesTheLiveCopyBeingDeleted__When__ARunIsDroppedAndReRun", () => {
	// This is the whole reason the backup is a hard link rather than a copy: it has to cost
	// nothing on hundreds of megabytes of frames AND still be there after `rm -rf out/live`.
	// A symlink would dangle here; only a second directory entry for the same inode survives.
	withOut((root) => {
		makeRun(root, "run-b");
		archiveRun("run-b", root);
		fs.rmSync(runDir("run-b", root), { recursive: true, force: true });

		const backed = path.join(archiveRunDir("run-b", root), RUN_FILES.log);
		assert.ok(fs.existsSync(backed));
		assert.equal(JSON.parse(fs.readFileSync(backed, "utf8")).app, "Yarn");
	});
});

test("archiveRun__PicksUpWhatIsMissing__When__CalledTwice", () => {
	// Both the run itself and a later `pull` of the same key may back it up, and a file written
	// after the first attempt (a judge verdict, say) must still reach the archive.
	withOut((root) => {
		makeRun(root, "run-c");
		archiveRun("run-c", root);
		fs.writeFileSync(runPath("run-c", RUN_FILES.judge, root), '{"verdict":"PASS"}');
		archiveRun("run-c", root);

		assert.ok(fs.existsSync(path.join(archiveRunDir("run-c", root), RUN_FILES.judge)));
	});
});

test("runFile__FallsBackThroughArchiveToTheOldLayout__When__TheLiveCopyIsGone", () => {
	// Runs recorded before 2026-08-01 are still in out/runs and inside archived benchmark
	// passes. A layout change is not a reason to make last week's evidence unreadable.
	withOut((root) => {
		fs.mkdirSync(path.join(root, "runs"), { recursive: true });
		fs.writeFileSync(path.join(root, "runs", "old-run.json"), "{}");
		assert.equal(runFile("old-run", RUN_FILES.log, root), path.join(root, "runs", "old-run.json"));
		assert.equal(legacyRunPath("old-run", RUN_FILES.steps, root), path.join(root, "runs", "old-run-steps"));
		assert.equal(legacyRunPath("old-run", RUN_FILES.recording, root), path.join(root, "recording", "old-run"));

		// Archive beats legacy; live beats both.
		makeRun(root, "run-d");
		archiveRun("run-d", root);
		fs.rmSync(runDir("run-d", root), { recursive: true, force: true });
		assert.equal(runFile("run-d", RUN_FILES.log, root), path.join(archiveRunDir("run-d", root), RUN_FILES.log));
		makeRun(root, "run-d");
		assert.equal(runFile("run-d", RUN_FILES.log, root), path.join(runDir("run-d", root), RUN_FILES.log));

		// A run that exists nowhere resolves to where it SHOULD be, so the error names the
		// intended location rather than the last place something was not.
		assert.equal(runFile("nope", RUN_FILES.log, root), path.join(runDir("nope", root), RUN_FILES.log));
	});
});

test("runRel__StaysPosix__When__BuildingAWirePath", () => {
	// Job records cross to another machine and are joined against ITS data root, so these are
	// posix strings by contract — path.join would emit backslashes on a non-posix host.
	assert.equal(runRel("k"), "out/bench/live/k");
	assert.equal(runRel("k", RUN_FILES.recording, "window.mp4"), "out/bench/live/k/recording/window.mp4");
});

test("dropRun__RemovesFromLiveAndKeepsTheBackup__When__ARunNeedsReRunning", () => {
	// The stated workflow: a run fails, it comes out of live so the re-run is not confused with
	// it, and the evidence is still there afterwards.
	withOut((root) => {
		makeRun(root, "run-e", { app: "Yarn", success: false });
		const res = dropRun("run-e", root);

		assert.deepEqual(res, { dropped: true, backedUp: true });
		assert.equal(fs.existsSync(runDir("run-e", root)), false);
		assert.ok(fs.existsSync(path.join(archiveRunDir("run-e", root), RUN_FILES.log)));
		assert.deepEqual(listRuns(root), []);
	});
});

test("dropRun__Refuses__When__TheRunIsNotThere", () => {
	withOut((root) => {
		fs.mkdirSync(path.join(root, "bench", "live"), { recursive: true });
		const res = dropRun("ghost", root);

		assert.equal(res.dropped, false);
		assert.match(res.reason ?? "", /no such run/);
	});
});

test("listRuns__NamesRunsWithNoLogAsInFlight__When__TheyHaveNotFinished", () => {
	// A directory with no run log is either executing right now or died before writing one, and
	// `purge` refuses on the first reading. Reporting it as a failure would be the other way to
	// get that wrong: the run is not failed, it is unfinished.
	withOut((root) => {
		makeRun(root, "run-done", { app: "Yarn", success: true });
		makeRun(root, "run-bad", { app: "Yarn", success: false });
		fs.mkdirSync(runDir("run-going", root), { recursive: true });

		const rows = listRuns(root);
		assert.deepEqual(rows.map((r) => r.key), ["run-bad", "run-done", "run-going"]);
		assert.equal(rows.find((r) => r.key === "run-going")?.success, undefined);
		assert.equal(rows.find((r) => r.key === "run-done")?.success, true);
		assert.equal(rows.find((r) => r.key === "run-bad")?.success, false);
		assert.equal(rows.every((r) => !r.backedUp), true, "nothing is backed up until a run ends");
	});
});

test("RunArtifacts__AreAllRunScoped__When__EveryWriterIsChecked", () => {
	// The property David asked for: a run folder holds LITERALLY every artifact that run
	// produces. This is a source-level guard rather than a behavioural one because the failure
	// mode is silent — a writer that emits `out/agent-final.png` works perfectly until the
	// second run, then overwrites the first run's evidence with no error anywhere.
	//
	// That is not hypothetical. Three writers were doing it as of 2026-08-01: the final frame the
	// visual judge grades, the teardown's restore frames, and every explore pass's step frames.
	// A July 29 run's "step 7" resolving to July 30 pixels is what made the offline judge refuse
	// to trust bare filenames at all.
	const root = path.resolve(import.meta.dirname, "..", "src");
	const offenders: string[] = [];
	const walk = (dir: string): void => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) {
				// probes/ are one-off measurement instruments, not runs — they may write anywhere.
				if (e.name !== "probes") walk(p);
				continue;
			}
			if (!e.name.endsWith(".ts")) continue;
			const src = fs.readFileSync(p, "utf8");
			for (const [i, line] of src.split("\n").entries()) {
				if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue;
				// An observation's shot name reaches OUT/<name>.png. Run-scoped names interpolate a
				// steps directory; a bare string literal does not.
				const m = /doObserve\(\s*(["'`])([^"'`$]*)\1\s*\)/.exec(line);
				if (m) offenders.push(`${path.relative(root, p)}:${i + 1} doObserve("${m[2]}") — writes a shared out/${m[2]}.png`);
			}
		}
	};
	walk(root);
	assert.deepEqual(offenders, [], `these writers escape the run directory:\n  ${offenders.join("\n  ")}`);
});
