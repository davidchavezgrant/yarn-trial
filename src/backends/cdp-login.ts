import { CdpBackend } from "./cdp.js";
import { webTarget } from "../core/target.js";

/**
 * One-time sign-in for a web target: `./run browser-login https://www.notion.so`.
 *
 * The entire auth story for websites, and deliberately the dullest program in the repo — it
 * brings up the cdp backend's persistent-profile Chrome on a URL and then gets out of the
 * way. No credential handling, no form filling, no stored secrets: a human types their
 * password into a real browser, and the profile keeps the session for every later web run.
 *
 * Successor to the driver-owned `browser-login.ts` (deleted with the dom backend,
 * 2026-07-31). Simpler by construction: `CdpBackend.acquire` already launches Chrome
 * detached against the persistent profile and lands a page on the URL, and `close()` only
 * disconnects — the browser, and the session being typed into it, survive this process by
 * design. So unlike its predecessor there is nothing to hold open and no driver session to
 * heartbeat: acquire, disconnect, and let the human take their time.
 */
async function main(): Promise<void> {
	const raw = process.argv[2];
	if (!raw) {
		console.error("usage: tsx src/backends/cdp-login.ts <https://…>");
		process.exit(1);
	}

	let target;
	try {
		target = webTarget(raw);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
	// webTarget only ever produces the web kind; the check narrows the union for `url` below.
	if (target.kind !== "web") throw new Error("unreachable: webTarget returned a non-web target");

	const cdp = await CdpBackend.acquire(target);
	await cdp.close();
	console.log(`Chrome is up on ${target.url} with the persistent runner profile.`);
	console.log("Sign in there — take your time, second factors included. The session lands in the");
	console.log("profile every later web run attaches to. Close the window (or leave it; runs reuse it).");
}

void main();
