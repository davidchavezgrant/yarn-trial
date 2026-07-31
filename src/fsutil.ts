import fs from "node:fs";

/**
 * Read and parse a JSON file, or hand back `fallback` when the file is absent, unreadable, or
 * not JSON. The one shape shared by every registry/state read whose answer to a missing or
 * corrupt file is "then it holds nothing": job records, leases, profile owners, UI state.
 *
 * Deliberately NOT for files where a parse failure must be heard — a reader whose corrupt
 * input should throw (humanize's frame-times map, hosts.json) keeps its own JSON.parse.
 * Shape validation stays at the call site: this knows that bytes parsed, not that they mean
 * anything.
 */
export function readJsonOr<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}
