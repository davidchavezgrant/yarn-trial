import { pathToFileURL } from "node:url";
import { Driver } from "./driver.js";
import { findWindow, probeHome } from "./harness.js";

/**
 * Answer one question about one app, in a process that then exits: **is it at its home state?**
 *
 * This is what makes an unattended sign-in possible. A human at a screen share finishes an SSO
 * round trip at a moment nothing on the laptop can predict, so the alternative to polling is
 * asking them to tell us — which they will forget, and which is exactly the step the flow was
 * supposed to remove. Polling this instead lets `./run signin` close the screen share the
 * moment the app's own landing screen appears.
 *
 * **A separate process, per poll, deliberately.** Three reasons, in order of how much they cost
 * when ignored:
 *
 *  1. **Hang isolation.** Accessibility calls block on the target app, and the app being polled
 *     here is by definition one a human is mid-interaction with — modal sheets, OAuth windows,
 *     a spinning login. A blocked AX call inside the runner takes the whole Mac out of the
 *     fleet; a blocked child gets killed and the poll reports nothing this round.
 *  2. **TCC identity.** The grants live on the runner and are inherited by its children. Nothing
 *     else on the machine can see an AX tree at all (measured: an ssh-launched probe reports
 *     "Accessibility NOT granted" and zero elements on a host that is perfectly healthy).
 *  3. **Driver session lifetime.** Sessions die 300s after `start_session` regardless of use.
 *     A long-lived prober would need the same heartbeat a run does; a short-lived one is over
 *     in seconds and the question does not arise.
 *
 * **It does not launch the app and it does not touch it.** `probeHome` observes and returns; it
 * never presses escape and never clicks, because both would interfere with the human whose work
 * it is watching for. If the app is not running, that is an answer — `not ready` — not a reason
 * to start it under someone's hands.
 *
 * Output is one JSON line on stdout, so the caller parses rather than greps.
 */

interface Verdict {
	ready: boolean;
	detail: string;
}

export async function checkReady(app: string): Promise<Verdict> {
	const driver = await Driver.start("ready");
	try {
		return await probeHome(driver, await findWindow(driver, app), app);
	} finally {
		await driver.close().catch(() => {});
	}
}

async function main(): Promise<void> {
	const app = process.argv[2];
	if (!app) {
		process.stderr.write('usage: ready.ts "<App Name>"\n');
		process.exit(2);
	}

	// Every failure is a verdict of "not ready", never a crash: the app not being running yet,
	// having no window yet, or being mid-relaunch are all normal mid-sign-in states, and a
	// poller that has to distinguish a thrown error from a negative answer will get it wrong.
	const verdict: Verdict = await checkReady(app).catch((e) => ({ ready: false, detail: (e as Error).message }));
	process.stdout.write(`${JSON.stringify(verdict)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	main().then(
		() => process.exit(0),
		(err) => {
			process.stdout.write(`${JSON.stringify({ ready: false, detail: String(err) })}\n`);
			process.exit(0);
		},
	);
