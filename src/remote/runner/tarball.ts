import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * A directory ⇄ single-file tar, used to move a parked profile between a fleet Mac and the
 * credential vault as ONE artifact rather than a directory of many small files.
 *
 * Why a tarball at all, when the rest of the fleet moves directories with rsync `-a`: the vault
 * seals bundles at rest (AES-GCM), and you cannot seal a live directory tree — sealing needs one
 * byte stream. So the profile is tarred on the Mac, the single file crosses the wire, and the
 * vault encrypts that file. The tar is plaintext only in transit (inside the pinned, key-authed
 * ssh channel) and transiently on disk at each end; at rest in the vault it is sealed.
 *
 * `tar` over a Node tar library on purpose: it ships on every macOS and Linux box in the fleet,
 * it is the same tool the profiles are restored by if a human ever has to, and it keeps this repo
 * free of another dependency. Invoked with `execFile` and an explicit argv — never a shell — so
 * no path here is ever shell input, and `-C <root>` with relative members keeps absolute paths
 * out of the archive.
 */

/** How `tar` is run, injected so the argv and the caller logic test without touching a filesystem. */
export type TarExec = (bin: string, argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultExec: TarExec = (bin, argv) =>
	new Promise((resolve) => {
		execFile(bin, argv, { encoding: "utf8", maxBuffer: 8 << 20, timeout: 120_000 }, (err, stdout, stderr) => {
			const e = err as (Error & { code?: number | string }) | null;
			resolve({ code: typeof e?.code === "number" ? e.code : e ? 1 : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
		});
	});

/** argv to pack `dir`'s CONTENTS (not the dir itself) into `outFile`, gzipped. `-C dir .` keeps members relative. */
export function packArgv(dir: string, outFile: string): string[] {
	return ["-czf", outFile, "-C", dir, "."];
}

/** argv to unpack `tarFile` into `intoDir`. The caller creates and, when replacing, empties `intoDir` first. */
export function unpackArgv(tarFile: string, intoDir: string): string[] {
	return ["-xzf", tarFile, "-C", intoDir];
}

/**
 * Pack a directory tree into a gzipped tar. Returns the byte size, which the caller records so a
 * later unpack can be sanity-checked against what was stored. Throws with tar's own stderr on
 * failure rather than swallowing it — a half-made bundle must be a loud refusal, since the whole
 * point is that a checked-out session is intact.
 */
export async function packDir(dir: string, outFile: string, exec: TarExec = defaultExec): Promise<number> {
	fs.mkdirSync(path.dirname(outFile), { recursive: true });
	const res = await exec("tar", packArgv(dir, outFile));
	if (res.code !== 0) throw new Error(`tar pack failed (${res.code}): ${res.stderr.trim() || "unknown error"}`);

	return fs.statSync(outFile).size;
}

/**
 * Unpack a gzipped tar into a directory, replacing whatever is there.
 *
 * The directory is removed and recreated first, not merged: a restored profile must be exactly
 * what was stored, and merging would leave a path the operator has since dropped sitting in the
 * bundle. This is the same "rewrite from what was actually found, never merge" rule
 * `swapProfile` applies to its manifests.
 */
export async function unpackInto(tarFile: string, intoDir: string, exec: TarExec = defaultExec): Promise<void> {
	fs.rmSync(intoDir, { recursive: true, force: true });
	fs.mkdirSync(intoDir, { recursive: true, mode: 0o700 });
	const res = await exec("tar", unpackArgv(tarFile, intoDir));
	if (res.code !== 0) throw new Error(`tar unpack failed (${res.code}): ${res.stderr.trim() || "unknown error"}`);
}
