import http from "node:http";
import { listApps, RunController, type RunOptions } from "./ui-core.js";
import { page } from "./ui-page.js";

/**
 * Zero-install demo UI: pick a target app, type a goal, watch the agent run.
 *
 * Dependency-free (node:http + one inline page) and needs no build step, which is why it
 * survives alongside the Electron shell — `npm run ui` is the fastest path to a demo on a
 * machine that just cloned the repo.
 *
 * The packaged shell (`npm run app`) is the one that matters for shipping: first-party
 * driver permission support, and signed-bundle screen capture. Both share `ui-core.ts`
 * (app list, single-run guard, spawning) and `ui-page.ts` (markup + script) so behaviour
 * cannot drift between them; only the transport differs.
 *
 * usage: npm run ui   → http://localhost:4319
 */

const PORT = Number(process.env.UI_PORT ?? 4319);

const runs = new RunController();
const listeners = new Set<http.ServerResponse>();

function broadcast(event: string, data: unknown): void {
	const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	for (const res of listeners) res.write(payload);
}

/** Injected before the shared app script; implements the `window.__bus` contract over HTTP. */
const BOOTSTRAP = String.raw`
const es = new EventSource('/stream');
window.__bus = {
  loadApps: () => fetch('/apps').then(r => r.json()),
  run: async (opts) => {
    const r = await fetch('/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts) });
    return r.ok ? undefined : await r.text();
  },
  stop: () => fetch('/stop', { method: 'POST' }),
  onStarted: (cb) => es.addEventListener('started', (e) => cb(JSON.parse(e.data))),
  onLine: (cb) => es.addEventListener('line', (e) => cb(JSON.parse(e.data))),
  onDone: (cb) => es.addEventListener('done', (e) => cb(JSON.parse(e.data))),
};
`;

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

	if (url.pathname === "/") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });

		return void res.end(page(BOOTSTRAP));
	}

	if (url.pathname === "/apps") {
		res.writeHead(200, { "content-type": "application/json" });

		return void res.end(JSON.stringify(listApps()));
	}

	if (url.pathname === "/stream") {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		res.write(": connected\n\n");
		listeners.add(res);
		req.on("close", () => listeners.delete(res));

		return;
	}

	if (url.pathname === "/run" && req.method === "POST") {
		let body = "";
		req.on("data", (c) => (body += c));

		return void req.on("end", () => {
			let opts: RunOptions;
			try {
				opts = JSON.parse(body);
			} catch {
				res.writeHead(400);

				return void res.end("bad json");
			}
			const err = runs.start(opts, {
				onLine: (line) => broadcast("line", line),
				onDone: (code, elapsed) => broadcast("done", { code, elapsed }),
			});
			if (err) {
				// 409 for the concurrency refusal, 400 for a bad request; the renderer prints
				// the body either way.
				res.writeHead(err.startsWith("a run is already") ? 409 : 400);

				return void res.end(err);
			}
			broadcast("started", { app: opts.app, task: opts.task });
			res.writeHead(200);
			res.end("ok");
		});
	}

	if (url.pathname === "/stop" && req.method === "POST") {
		runs.stop();
		res.writeHead(200);

		return void res.end("ok");
	}

	res.writeHead(404);
	res.end("not found");
});

server.listen(PORT, () => {
	console.log(`demo UI: http://localhost:${PORT}`);
	console.log("one run at a time — driver sessions are not concurrent-safe (LIMITATIONS §6)");
});
