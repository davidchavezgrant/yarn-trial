/**
 * HTTP Range parsing, alone in its own module because it now has two consumers that must not
 * be able to reach each other.
 *
 * It was born in `src/ui/ui-core.ts` for the Electron gallery's video protocol handler, and
 * the bench dash needs exactly the same arithmetic to serve a run's cursor render. Importing
 * it FROM ui-core would drag `core/harness/verification.ts` and `remote/control/appmaps.ts`
 * into the dash's static import graph — the very bulk docs/deploying-the-dash.md is trying to
 * sever from a read-only board (444 MB of image, most of it packages share mode never calls).
 * Eight lines of byte arithmetic depend on nothing, so they live somewhere that depends on
 * nothing. ui-core re-exports it, so its own callers and tests are unchanged.
 */

export type ByteRange = { kind: "whole" } | { kind: "part"; start: number; end: number } | { kind: "unsatisfiable" };

/**
 * Interpret a Range header against a file of `size` bytes.
 *
 * Here rather than inline in the protocol handler so the suffix case is testable: a suffix
 * range (`bytes=-500`) names the LAST 500 bytes, and parsing it as 0–500 serves the head of
 * the file labelled as its tail. Chromium's media stack mostly asks `bytes=N-`, which is why
 * that mistake can sit latent until some player sends the other form.
 *
 * Anything unparseable answers `whole` — a full 200 is always a correct response to a Range
 * the server did not understand — and `unsatisfiable` maps to 416.
 */
export function parseByteRange(header: string | null, size: number): ByteRange {
	const m = header ? /bytes=(\d*)-(\d*)/.exec(header) : null;
	if (!m || (!m[1] && !m[2])) return { kind: "whole" };
	const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
	const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
	if (start >= size || start > end) return { kind: "unsatisfiable" };

	return { kind: "part", start, end };
}
