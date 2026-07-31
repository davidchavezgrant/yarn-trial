import { firstLine, SPAWN_FAILED_EXIT, type SshResult, TIMEOUT_EXIT } from "./ssh.js";

/**
 * One remote step reduced to pass/fail plus a line, for the step-by-step fan-outs
 * (provision.ts, install.ts) that report each step as a table row. Extracted from two
 * verbatim copies; the only divergence was the fallback detail for a silent nonzero exit,
 * where install.ts's `describeExit` names the two synthesised codes instead of printing
 * them raw — kept here, because "timed out" is actionable and "exited 124" is a lookup.
 */
export interface Attempt {
	ok: boolean;
	/** One line, ready for a table cell. */
	detail: string;
	stdout: string;
	code?: number;
}

/**
 * Run one remote thing and reduce it to pass/fail plus a line. Catches as well as checking the
 * exit code: an injected runner, or an ssh that cannot be spawned at all, throws rather than
 * resolving, and a step must degrade rather than unwind the pass.
 */
export async function attempt(fn: () => Promise<SshResult>): Promise<Attempt> {
	let result: SshResult;
	try {
		result = await fn();
	} catch (e) {
		return { ok: false, detail: (e as Error).message, stdout: "" };
	}

	if (result.code === 0) return { ok: true, detail: firstLine(result.stdout), stdout: result.stdout, code: 0 };

	return {
		ok: false,
		detail: firstLine(result.stderr) || firstLine(result.stdout) || describeExit(result.code),
		stdout: result.stdout,
		code: result.code,
	};
}

function describeExit(code: number): string {
	if (code === TIMEOUT_EXIT) return "timed out";
	if (code === SPAWN_FAILED_EXIT) return "could not be started";

	return `exited ${code}`;
}
