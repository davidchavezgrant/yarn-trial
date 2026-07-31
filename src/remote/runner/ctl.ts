import net from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { defaultRunnerDir } from "./lease.js";

/**
 * `runnerctl` — the only thing SSH ever invokes on a Mac in the fleet.
 *
 * Thin on purpose. Everything that decides anything lives in the serve process, which is the
 * one holding the TCC grants; this connects to a socket, sends one line, prints what comes
 * back, and exits with a code the caller can branch on. Nothing here needs to be updated
 * when the runner learns a new method.
 *
 * **Data arrives base64-encoded, never as argv text.** `sshd` does not preserve argv: it
 * joins the remote arguments into a single string and hands it to the login shell, which
 * re-splits it. A task string containing a quote, a `$`, or a `;` is therefore shell input on
 * the far side. base64's alphabet has no intersection with shell syntax, so `--spec` survives
 * that round trip with no quoting at all — see `encodeSpec` in src/remote/control/ssh.ts, which is
 * the other end of this contract.
 */

const USAGE = `usage: runnerctl <status|submit|logs|stop|apps|job|doctor|grant|restart|signin|liveview|liveview-stop|ready|authclear|appdelete> [options]

  --spec <base64>   request parameters, base64-encoded JSON (the only way to pass data)
  --json            emit JSON (default for everything except logs)
  --follow          logs only: stream until the job ends
  --from <byte>     logs only: resume from a byte offset
  --socket <path>   override the socket path`;

/**
 * Codes are the fleet client's signal, so they distinguish "the host said no" from "no host".
 *
 * Exported because they are a CROSS-MACHINE contract: this file runs on the Mac and the
 * dispatcher interprets the number on the laptop, and `--host auto` decides whether to try
 * the next host from it. Two independent copies of the mapping would be a protocol that
 * drifts silently, so there is one.
 */
export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;
export const EXIT_UNREACHABLE = 3;

const METHODS = new Set(["status", "submit", "logs", "stop", "apps", "job", "doctor", "grant", "restart", "signin", "liveview", "liveview-stop", "ready", "authclear", "appdelete"]);
const TERMINAL_FAILURES = new Set(["failed", "orphaned", "stopped"]);

export interface CtlArgs {
	method: string;
	params: Record<string, unknown>;
	json: boolean;
	socketPath: string;
}

export function parseArgs(argv: string[], runnerDir = defaultRunnerDir()): CtlArgs | { error: string } {
	const method = argv[0];
	if (!method || !METHODS.has(method)) return { error: `unknown subcommand ${JSON.stringify(method ?? "")}` };

	let params: Record<string, unknown> = {};
	let json = false;
	let socketPath = path.join(runnerDir, "run.sock");

	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		const next = (): string | undefined => argv[++i];
		switch (arg) {
			case "--json":
				json = true;
				break;
			case "--follow":
				params.follow = true;
				break;
			case "--from": {
				const v = Number(next());
				if (!Number.isFinite(v)) return { error: "--from needs a byte offset" };
				params.fromByte = v;
				break;
			}
			case "--socket": {
				const v = next();
				if (!v) return { error: "--socket needs a path" };
				socketPath = v;
				break;
			}
			case "--spec": {
				const v = next();
				if (!v) return { error: "--spec needs base64 JSON" };
				let decoded: unknown;
				try {
					decoded = JSON.parse(Buffer.from(v, "base64").toString("utf8"));
				} catch {
					return { error: "--spec was not base64-encoded JSON" };
				}
				if (typeof decoded !== "object" || decoded === null) return { error: "--spec must decode to an object" };
				// Merged, not replaced: --follow and --spec can legitimately both appear.
				params = { ...params, ...(decoded as Record<string, unknown>) };
				break;
			}
			default:
				return { error: `unexpected argument ${JSON.stringify(arg)}` };
		}
	}

	return { method, params, json, socketPath };
}

export async function main(argv: string[]): Promise<number> {
	const parsed = parseArgs(argv);
	if ("error" in parsed) {
		process.stderr.write(`${parsed.error}\n${USAGE}\n`);

		return EXIT_USAGE;
	}

	let conn: net.Socket;
	try {
		conn = await connect(parsed.socketPath);
	} catch (e) {
		// Distinct from a refusal: the runner is not listening, which is a host problem
		// (LaunchAgent unloaded, machine still booting) rather than an answer to the request.
		process.stderr.write(`cannot reach the runner at ${parsed.socketPath}: ${(e as Error).message}\n`);

		return EXIT_UNREACHABLE;
	}

	let exit = EXIT_OK;
	const raw: Buffer[] = [];
	try {
		conn.write(`${JSON.stringify({ method: parsed.method, params: parsed.params })}\n`);
		for await (const frame of frames(conn)) {
			if (frame.ok === false) {
				// stderr as well as stdout: the fleet client reads the first stderr line as the
				// reason for a nonzero exit, and JSON in a table cell is unreadable.
				process.stderr.write(`${String(frame.error ?? "request failed")}\n`);
				process.stdout.write(`${JSON.stringify(frame)}\n`);
				exit = EXIT_REFUSED;
				break;
			}
			if (parsed.method === "logs" && !parsed.json) {
				if (typeof frame.chunk === "string") raw.push(Buffer.from(frame.chunk, "base64"));
				// A finished-but-unsuccessful run exits nonzero so `ssh host runnerctl logs`
				// can be used as a wait-and-check. A still-running one is not a failure.
				if (frame.done && TERMINAL_FAILURES.has(String(frame.state))) exit = EXIT_REFUSED;
				continue;
			}
			process.stdout.write(`${JSON.stringify(frame)}\n`);
		}
	} finally {
		conn.destroy();
	}

	// Written once at the end so a partial UTF-8 sequence split across two frames is decoded
	// whole rather than as two replacement characters.
	if (raw.length) process.stdout.write(Buffer.concat(raw));

	return exit;
}

function connect(socketPath: string): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const conn = net.createConnection({ path: socketPath });
		conn.once("error", reject);
		conn.once("connect", () => {
			conn.removeListener("error", reject);
			conn.on("error", () => conn.destroy());
			resolve(conn);
		});
	});
}

/** NDJSON frames off the socket. A `logs --follow` reply is many; everything else is one. */
async function* frames(conn: net.Socket): AsyncGenerator<Record<string, any>> {
	// StringDecoder, not toString per chunk: a multi-byte character straddling a chunk boundary
	// would decode each half as U+FFFD and corrupt the frame it lands in. Log payloads dodge
	// this by riding as base64 (see `streamLogs`), but the frames themselves must not rely on
	// where the kernel happens to cut a read.
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	for await (const data of conn) {
		buffer += decoder.write(data as Buffer);
		let nl: number;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			if (!line.trim()) continue;
			try {
				yield JSON.parse(line);
			} catch {
				yield { ok: false, error: `runner sent a malformed frame: ${line.slice(0, 120)}` };
			}
		}
	}
}

// Runs only when invoked as a program, so importing this module (a test, or a future
// in-process caller) does not start talking to a socket.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err) => {
			process.stderr.write(`runnerctl failed: ${(err as Error).message}\n`);
			process.exit(EXIT_UNREACHABLE);
		},
	);
