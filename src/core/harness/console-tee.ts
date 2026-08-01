import fs from "node:fs";
import { RUN_FILES, runDir, runPath } from "../../paths.js";

/**
 * Mirror a run's console output into its own folder as `log.txt`.
 *
 * A dispatched job gets this file for free — the runner opens it and hands the child fd 1/2
 * (remote/runner/spawn.ts) — but a local `npm run agent` / `./run` run printed to a terminal
 * or an Electron pipe and kept nothing: the run folder claimed to be the whole record of a
 * run while missing the one artifact every debugging session starts from. Teeing in-process,
 * at the entry that minted the stamp, is what makes every launch path produce the same file
 * without any launcher having to know about it.
 */

/** The write()-shaped surface of process.stdout/stderr, so tests can hand in a capture. */
export interface TeeSink {
	write(chunk: string | Uint8Array, ...rest: unknown[]): boolean;
}

/** Whether an open descriptor and a path name the same file (false for a missing path). */
export function fdIsFile(fd: number, file: string): boolean {
	try {
		const a = fs.fstatSync(fd);
		const b = fs.statSync(file);

		return a.dev === b.dev && a.ino === b.ino;
	} catch {
		return false;
	}
}

/**
 * Wrap `stream.write` so every chunk is also appended to `fd`, then delivered unchanged.
 *
 * `fs.writeSync`, not a WriteStream: synchronous writes keep file order identical to console
 * order and survive the `process.exit()` every CLI here ends with — an async stream's buffer
 * is exactly what exit discards. The volume is console lines, so the cost is noise.
 */
export function teeWrites(stream: TeeSink, fd: number): void {
	const orig = stream.write.bind(stream);
	stream.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
		try {
			// write(chunk, encoding?, cb?) — honour a caller-supplied encoding; console.* never
			// passes one, but a hook on a global stream cannot assume only console calls it.
			const enc = typeof rest[0] === "string" ? (rest[0] as BufferEncoding) : "utf8";
			fs.writeSync(fd, typeof chunk === "string" ? Buffer.from(chunk, enc) : chunk);
		} catch {
			// A full disk or a closed fd loses the mirror, never the run's real output.
		}

		return orig(chunk, ...rest);
	};
}

/**
 * Start mirroring stdout+stderr into `<runDir>/log.txt`. Returns the file, or undefined when
 * the process's output ALREADY lands there.
 *
 * That guard is the runner case: spawnDetached redirects the child's fd 1/2 into this very
 * file, so teeing again would duplicate every line. File IDENTITY (fstat) detects it rather
 * than an env protocol — true exactly when a second writer would double-write, and false for
 * a local CLI, a RunController pipe, or a not-yet-synced runner still redirecting to the
 * legacy `out/jobs/` path (two distinct files, each getting one complete copy).
 */
export function teeConsole(stamp: string, streams: TeeSink[] = [process.stdout, process.stderr], checkFds: number[] = [1, 2]): string | undefined {
	const file = runPath(stamp, RUN_FILES.console);
	if (checkFds.some((fd) => fdIsFile(fd, file))) return undefined;
	fs.mkdirSync(runDir(stamp), { recursive: true });
	const fd = fs.openSync(file, "a");
	for (const s of streams) teeWrites(s, fd);

	return file;
}
