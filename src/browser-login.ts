import { browserLogin } from "./browser.js";
import { Driver } from "./driver.js";
import { onInterrupt } from "./harness.js";
import { webTarget } from "./target.js";

/**
 * One-time sign-in for a web target: `./run browser-login https://www.notion.so`.
 *
 * The entire auth story for websites, and deliberately the dullest program in the repo — it
 * opens the driver-owned Chrome profile on a URL and then gets out of the way. No credential
 * handling, no form filling, no stored secrets: a human types their password into a real
 * browser, and the profile keeps the session.
 *
 * It has to be a separate entry point rather than a flag on `explore` because the two want
 * opposite things from the process. Exploration drives the machine and exits; this waits,
 * doing nothing, for as long as a person needs — including a second factor on a phone.
 */
async function main(): Promise<void> {
	const raw = process.argv[2];
	if (!raw) {
		console.error("usage: tsx src/browser-login.ts <https://…>");
		process.exit(1);
	}

	let target;
	try {
		target = webTarget(raw);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}

	const driver = await Driver.start("browser-login");
	// Ctrl-C is the documented way to end this, so it must close the session rather than leave
	// it to expire — the next run would otherwise collide with it (LIMITATIONS §6). onInterrupt
	// only sets a flag for a run loop to read, and this file has no run loop, so the poll below
	// is it: parked on a forever-promise instead, the first Ctrl-C waits out the whole grace
	// period and a second one exits with the session still open.
	const interrupted = onInterrupt(() => driver.close());
	try {
		await browserLogin(driver, target);
		// Hold the process open until the operator is done. The driver session heartbeats
		// itself, and the browser window belongs to the driver-owned profile, so leaving is
		// what would end the sign-in.
		while (!interrupted()) await new Promise((r) => setTimeout(r, 300));
		await driver.close();
		process.exit(0);
	} catch (err) {
		console.error(`\nbrowser-login failed: ${err instanceof Error ? err.message : String(err)}`);
		await driver.close();
		process.exit(1);
	}
}

void main();
