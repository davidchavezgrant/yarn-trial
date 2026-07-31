import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * End-to-end proof of the one path nothing else covers: a click in the LOCAL Electron window
 * starting a run on a REMOTE Mac, with that Mac's log streaming back into the pane.
 *
 * Every layer under it is already tested in isolation — ui-remote.ts, dispatch.ts and the
 * runner each have unit tests with the transport injected. What none of them can prove is the
 * wiring: that the renderer's `host` variable reaches `ipcMain.handle("run")`, that it takes
 * the remote branch there, and that the log events find their way back to the same pane. Those
 * are four process boundaries (renderer → IPC → ssh → remote runner) and the failure mode is
 * silent: a mis-wired host falls back to running locally, which looks like success.
 *
 * Why CDP rather than a click: driving the window with the mouse would seize the operator's
 * machine, and this is exactly the repo that argues against doing that. Electron's
 * remote-debugging port lets the assertions run *inside* the renderer, against the real
 * handlers — `el('go').click()` goes through the same onclick the operator's mouse would.
 * The page's own state (`host`, `apps`, `running`) is readable directly, so nothing is
 * inferred from pixels.
 *
 * NOT a unit test, and deliberately not named *.test.ts: it needs a real fleet, spends model
 * tokens on the far Mac, and opens a window. Run it by hand:
 *
 *   npx tsx src/ui/e2e-gui-remote.mts [--host mac2] [--app Yarn] [--keep]
 *
 * It stops the run the moment the remote has proved it is executing — the goal is the wiring,
 * not a completed task, and a full run here is someone's money for no extra information.
 */

const PORT = 9333;
const BOOT_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 90_000;

interface Target {
	type: string;
	title: string;
	url: string;
	webSocketDebuggerUrl?: string;
}

/** A CDP connection to one renderer, reduced to the two calls this file makes. */
class Page {
	private id = 0;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

	private constructor(private ws: WebSocket) {
		ws.addEventListener("message", (ev) => {
			const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
			if (msg.id === undefined) return;   // an event, not a reply — nothing here subscribes

			const waiter = this.pending.get(msg.id);
			if (!waiter) return;

			this.pending.delete(msg.id);
			if (msg.error) waiter.reject(new Error(msg.error.message));
			else waiter.resolve(msg.result);
		});
	}

	static async attach(url: string): Promise<Page> {
		const ws = new WebSocket(url);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error(`cannot open ${url}`)), { once: true });
		});

		return new Page(ws);
	}

	private send(method: string, params: unknown): Promise<unknown> {
		const id = ++this.id;
		const done = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
		this.ws.send(JSON.stringify({ id, method, params }));

		return done;
	}

	/**
	 * Evaluate in the page and bring the value back.
	 *
	 * awaitPromise, so an expression can be an async round trip to another Mac; returnByValue,
	 * because a RemoteObject handle would need a second call to read and everything here is
	 * JSON-shaped. An exception in the page is re-thrown locally rather than returned as a
	 * value — a typo in an assertion expression must not read as a failed assertion.
	 */
	async eval<T>(expression: string): Promise<T> {
		const res = (await this.send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		})) as { result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text: string } };
		if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);

		return res.result.value;
	}

	close(): void {
		this.ws.close();
	}
}

/**
 * Poll `expr` until it is truthy. Returns the value, so a wait can also be a read.
 *
 * A throw from the page counts as "not yet", not as a failure: the target appears on the
 * debugging port before its document is parsed, so the first few evaluations legitimately hit
 * a null `getElementById` or an undeclared `apps`. The last error is kept and reported on
 * timeout — otherwise a typo in an expression would present as a patient, silent hang.
 */
async function until<T>(page: Page, what: string, expr: string, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: T | undefined;
	let err: string | undefined;
	while (Date.now() < deadline) {
		try {
			last = await page.eval<T>(expr);
			err = undefined;
			if (last) return last;
		} catch (e) {
			err = (e as Error).message.split("\n")[0];
		}
		await sleep(400);
	}

	throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what} (${err ? `last error: ${err}` : `last value: ${JSON.stringify(last)}`})`);
}

async function findPage(): Promise<Target> {
	const deadline = Date.now() + BOOT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Target[];
			// Electron's devtools targets also answer here; the shell's window is the one whose
			// document is the data: URL the main process loads.
			const hit = targets.find((t) => t.type === "page" && t.url.startsWith("data:") && t.webSocketDebuggerUrl);
			if (hit) return hit;
		} catch {
			// Port not listening yet. Normal for the first second or two of an Electron start.
		}
		await sleep(300);
	}

	throw new Error(`no renderer appeared on the debugging port within ${BOOT_TIMEOUT_MS / 1000}s`);
}

/** A JS string literal, safe to paste into an expression. JSON.stringify is exactly that. */
const lit = (s: string) => JSON.stringify(s);

let child: ChildProcess | undefined;

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const arg = (flag: string, fallback: string) => {
		const at = argv.indexOf(flag);

		return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
	};
	const host = arg("--host", "mac2");
	const app = arg("--app", "Yarn");
	const keep = argv.includes("--keep");

	console.log(`building…`);
	await run("npx", ["tsc", "-p", "tsconfig.electron.json"]);

	console.log(`launching the shell with a debugging port on ${PORT}…`);
	child = spawn("npx", ["electron", "dist-electron/electron/main.js", `--remote-debugging-port=${PORT}`], {
		stdio: ["ignore", "inherit", "inherit"],
	});
	child.on("exit", (code) => {
		if (code !== 0 && code !== null) console.error(`the shell exited early with code ${code}`);
	});

	const target = await findPage();
	const page = await Page.attach(target.webSocketDebuggerUrl as string);
	console.log(`attached to the renderer`);
	await until(page, "the document to finish loading", `document.readyState === 'complete' && typeof loadApps === 'function' || null`, BOOT_TIMEOUT_MS);

	// 1. The fleet reached the selector. Waits, because loadHostList() is async and boot paints
	//    a selector with only 'local' in it.
	const hosts = await until<string[]>(page, "the host selector to fill", `(() => { const o = [...document.getElementById('host').options].map(x => x.value); return o.length > 1 ? o : null; })()`);
	console.log(`  hosts: ${hosts.join(", ")}`);
	assert(hosts.includes(host), `${host} is not in the selector (${hosts.join(", ")})`);

	// 2. Switch machines through the REAL handler, not by assigning to the page's `host`
	//    variable — the handler is what saves the preference and re-asks for the app list, and
	//    a test that skips it proves nothing about the control the operator uses.
	await page.eval(`(() => { const s = document.getElementById('host'); s.value = ${lit(host)}; s.onchange(); })()`);
	const shown = await until<string>(page, "the selector to settle", `host || null`);
	assert(shown === host, `selector says ${shown}, expected ${host}`);

	// 3. The app list is now THAT Mac's, fetched over ssh from its runner. This is the check
	//    that would have caught the local-only list: on this machine the list is different.
	const names = await until<string[]>(page, `${host}'s app list`, `apps.length ? apps.map(a => a.name) : null`);
	console.log(`  ${host} reports ${names.length} apps`);
	assert(names.includes(app), `${app} is not installed on ${host} (nearest: ${names.filter((n) => n.toLowerCase().includes(app.slice(0, 3).toLowerCase())).join(", ") || "nothing similar"})`);

	// 4. Fill the form the way a person does: click the app, type a goal-only task.
	await page.eval(`selectApp(${lit(app)})`);
	const task = "show me how to change the cursor type";
	await page.eval(`(() => { const t = document.getElementById('task'); t.value = ${lit(task)}; t.dispatchEvent(new Event('input')); })()`);
	const enabled = await until<boolean>(page, "the Run button to enable", `document.getElementById('go').disabled === false || null`);
	assert(enabled, "Run stayed disabled");
	const label = await page.eval<string>(`document.getElementById('go').textContent`);
	console.log(`  button reads: ${label}`);
	assert(label.includes(`@ ${host}`), `the button does not say where it will run: ${label}`);

	// 5. Click it. From here everything asserted is text that came back OVER SSH from the far
	//    Mac — a local fallback cannot produce it.
	console.log(`clicking Run…`);
	await page.eval(`document.getElementById('go').click()`);
	const log = () => `(stateFor(${lit(app)}).log || []).join('\\n')`;
	await until(page, "the run to start", `running || null`);

	// The job id is minted by the remote runner and echoed by dispatch; it is the single
	// strongest piece of evidence that this did not quietly run here.
	const started = await until<string>(page, `a job id from ${host}`, `(() => { const m = ${log()}.match(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]+-[a-z0-9-]+/); return m ? m[0] : null; })()`);
	console.log(`  remote job: ${started}`);

	// And its log is genuinely streaming: the agent's own preamble, produced by the process on
	// the far side, not by anything in this window.
	await until(page, "the remote agent's output", `/target|task|loaded|home reset|\\[1\\]/.test(${log()}) || null`);
	const excerpt = (await page.eval<string>(log())).split("\n").slice(0, 12);
	console.log(excerpt.map((l) => `    ${l}`).join("\n"));

	// 6. Stop it. Also the assertion that Stop reaches the far side: the pane returns to idle
	//    only when the remote job actually ends.
	console.log(`stopping…`);
	await page.eval(`document.getElementById('stop').click()`);
	await until(page, "the run to end", `running === false || null`);
	console.log(`  stopped; status is ${await page.eval<string>(`document.getElementById('status').textContent`)}`);

	page.close();
	console.log(`\nPASS — the local GUI started, streamed and stopped a run on ${host}.`);
	if (!keep) child.kill();
}

function assert(ok: unknown, message: string): asserts ok {
	if (!ok) throw new Error(message);
}

function run(cmd: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: "inherit" });
		p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
	});
}

main().catch((err) => {
	console.error(`\nFAIL — ${(err as Error).message}`);
	// The window is a child of this process and would otherwise outlive the failure, holding
	// the debugging port and blocking the next attempt.
	child?.kill();
	process.exit(1);
});
