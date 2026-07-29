import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { appSlug, auditTaskPrompt } from "./harness.js";

/**
 * Local demo UI: pick a target app, type a goal, watch the agent run.
 *
 * Deliberately dependency-free (plain node:http + one inline page) — the repo has exactly
 * two runtime deps and a demo harness is not a reason to add a web framework.
 *
 * Two things it must get right, both from LIMITATIONS:
 * - §6 driver sessions are NOT concurrent-safe: a second session shuts down the shared
 *   daemon and kills the run already in flight. So this refuses to start a second run
 *   rather than queueing or racing.
 * - §3/prompt hygiene: it surfaces auditTaskPrompt() BEFORE spawning, so a hinted prompt
 *   is explained in the UI instead of failing with exit code 2 in a log nobody reads.
 *
 * usage: npm run ui   → http://localhost:4319
 */

const PORT = Number(process.env.UI_PORT ?? 4319);

interface AppEntry {
	name: string;
	running: boolean;
	grounded: boolean;
}

/**
 * Installed apps ∪ currently-running apps. Running ones are surfaced because the driver
 * can only reach a target on the active Space (§1), so "already open" is a useful signal,
 * not decoration.
 */
function listApps(): AppEntry[] {
	const running = new Set<string>();
	try {
		const out = execFileSync(
			"osascript",
			["-e", 'tell application "System Events" to get name of every process whose background only is false'],
			{ encoding: "utf8", timeout: 5000 },
		);
		for (const n of out.split(",")) running.add(n.trim());
	} catch {
		// A missing automation permission is not fatal — the list just loses its badges.
	}

	const installed = new Set<string>();
	for (const dir of ["/Applications", "/System/Applications", `${process.env.HOME}/Applications`]) {
		try {
			for (const f of fs.readdirSync(dir)) if (f.endsWith(".app")) installed.add(f.replace(/\.app$/, ""));
		} catch {}
	}
	// Nested folders like /Applications/Utilities.
	try {
		for (const f of fs.readdirSync("/System/Applications/Utilities")) {
			if (f.endsWith(".app")) installed.add(f.replace(/\.app$/, ""));
		}
	} catch {}

	const names = new Set([...installed, ...running]);

	return [...names]
		.map((name) => ({
			name,
			running: running.has(name),
			grounded: fs.existsSync(`${process.cwd()}/docs/appmaps/${appSlug(name)}.md`),
		}))
		.sort((a, b) => {
			// Grounded first, then running, then alphabetical: the ones most likely to work.
			if (a.grounded !== b.grounded) return a.grounded ? -1 : 1;
			if (a.running !== b.running) return a.running ? -1 : 1;

			return a.name.localeCompare(b.name);
		});
}

/** The single in-flight run, if any. Enforces LIMITATIONS §6. */
let current: { child: ChildProcess; app: string; task: string; startedAt: number } | undefined;
const listeners = new Set<http.ServerResponse>();

function broadcast(event: string, data: unknown): void {
	const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	for (const res of listeners) res.write(payload);
}

function startRun(app: string, task: string, opts: { record: boolean; noVision: boolean }): string | undefined {
	if (current) return "a run is already in progress — driver sessions are not concurrent-safe (LIMITATIONS §6)";

	const args = ["tsx", "src/agent.ts", task, app];
	if (opts.record) args.push("--record");
	if (opts.noVision) args.push("--no-vision");

	// No shell: task text is user input and goes straight through as one argv entry.
	const child = spawn("npx", args, { cwd: process.cwd(), env: process.env });
	current = { child, app, task, startedAt: Date.now() };
	broadcast("started", { app, task, record: opts.record, noVision: opts.noVision });

	const pump = (buf: Buffer) => {
		for (const line of buf.toString().split("\n")) if (line.trim()) broadcast("line", line);
	};
	child.stdout?.on("data", pump);
	child.stderr?.on("data", pump);
	child.on("close", (code) => {
		const elapsed = Math.round((Date.now() - (current?.startedAt ?? Date.now())) / 1000);
		current = undefined;
		broadcast("done", { code, elapsed });
	});

	return undefined;
}

const PAGE = String.raw`<!doctype html>
<meta charset="utf-8">
<title>Self-driving demo agent</title>
<style>
  :root { color-scheme: dark; --bg:#16181d; --panel:#1e2128; --line:#2e323c; --fg:#e6e8ec; --dim:#9aa1ad; --accent:#6c8cff; --ok:#57c98a; --bad:#e5736a; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 ui-sans-serif,-apple-system,system-ui,sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:12px; }
  h1 { font-size:15px; margin:0; font-weight:600; }
  header span { color:var(--dim); font-size:12px; }
  main { display:grid; grid-template-columns:300px 1fr; gap:0; height:calc(100vh - 51px); }
  .col { padding:16px; overflow:auto; }
  .col + .col { border-left:1px solid var(--line); }
  label { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); margin:0 0 6px; }
  input, textarea, button { font:inherit; color:var(--fg); background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:8px 10px; width:100%; }
  input:focus, textarea:focus { outline:none; border-color:var(--accent); }
  textarea { resize:vertical; min-height:74px; }
  ul { list-style:none; margin:8px 0 0; padding:0; max-height:calc(100vh - 190px); overflow:auto; }
  li { padding:7px 10px; border-radius:6px; cursor:pointer; display:flex; align-items:center; gap:8px; }
  li:hover { background:var(--panel); }
  li.sel { background:#2b3550; }
  .badge { font-size:10px; padding:1px 6px; border-radius:99px; border:1px solid var(--line); color:var(--dim); }
  .badge.g { color:var(--ok); border-color:#2f5d45; }
  .badge.r { color:var(--accent); border-color:#3a4a7a; }
  .row { display:flex; gap:10px; align-items:center; margin-top:12px; }
  .row label { margin:0; text-transform:none; letter-spacing:0; font-size:13px; color:var(--fg); display:flex; align-items:center; gap:6px; }
  .row input[type=checkbox] { width:auto; }
  button.go { margin-top:14px; background:var(--accent); border-color:var(--accent); color:#0d1020; font-weight:600; cursor:pointer; }
  button.go:disabled { opacity:.5; cursor:not-allowed; }
  button.stop { margin-top:8px; background:transparent; color:var(--bad); border-color:#5c3230; cursor:pointer; }
  #warn { margin-top:10px; padding:9px 11px; border-radius:6px; background:#3a2f1c; border:1px solid #6b552c; color:#f0d9a8; font-size:12.5px; display:none; }
  #log { font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; word-break:break-word; }
  #log div { padding:1px 0; }
  .t-step { color:var(--accent); }
  .t-ok { color:var(--ok); }
  .t-bad { color:var(--bad); }
  .t-meta { color:var(--dim); }
  .empty { color:var(--dim); font-style:italic; }
  .fold summary { color:var(--dim); cursor:pointer; padding:2px 0; }
  .fold > div { border-left:2px solid var(--line); margin-left:4px; padding-left:8px; }
</style>
<header>
  <h1>Self-driving demo agent</h1>
  <span id="status">idle</span>
</header>
<main>
  <div class="col">
    <label for="q">Target app</label>
    <input id="q" placeholder="Search apps…" autocomplete="off">
    <ul id="apps"></ul>
  </div>
  <div class="col">
    <label for="task">Task (state the GOAL only — not the steps)</label>
    <textarea id="task" placeholder="show me how to change the cursor type"></textarea>
    <div id="warn"></div>
    <div class="row">
      <label><input type="checkbox" id="record"> Record video</label>
      <label><input type="checkbox" id="novision"> No screenshots</label>
    </div>
    <button class="go" id="go" disabled>Run</button>
    <button class="stop" id="stop" style="display:none">Stop run</button>
    <div id="log" style="margin-top:16px"><span class="empty">Output appears here.</span></div>
  </div>
</main>
<script>
let apps = [], sel = null, running = false;

const el = (id) => document.getElementById(id);

async function loadApps() {
  apps = await (await fetch('/apps')).json();
  render();
}

function render() {
  const q = el('q').value.toLowerCase();
  const hits = apps.filter(a => a.name.toLowerCase().includes(q)).slice(0, 60);
  el('apps').innerHTML = hits.map(a =>
    '<li data-n="' + encodeURIComponent(a.name) + '" class="' + (a.name === sel ? 'sel' : '') + '">' +
    '<span style="flex:1">' + a.name.replace(/</g,'&lt;') + '</span>' +
    (a.grounded ? '<span class="badge g">grounded</span>' : '') +
    (a.running ? '<span class="badge r">open</span>' : '') + '</li>').join('');
  for (const li of el('apps').children) {
    li.onclick = () => { sel = decodeURIComponent(li.dataset.n); render(); check(); };
  }
}

// Mirror auditTaskPrompt() in the browser so a hinted prompt is explained before the run
// starts, not after the process exits. The server re-checks; this is UX, not enforcement.
function hintWarning(t) {
  const vocab = t.match(/\b(set_value|type_text|press_key|right_click|double_click|element_index|delivery_mode|AXPress|AX[A-Z]\w+)\b/g);
  const mech = t.match(/\b(click|clicks|clicking|clicked|press|presses|pressing|keystroke\w*|select all|scroll\w*|hover\w*|drag\w*|cmd\+|ctrl\+|option\+|shift\+)/gi);
  const uniq = mech ? [...new Set(mech.map(m => m.toLowerCase()))] : [];
  if (vocab) return 'Names driver internals (' + [...new Set(vocab)].join(', ') + '). The agent will refuse: task prompts state the goal only.';
  if (uniq.length >= 2) return 'Reads like a recipe (' + uniq.join(', ') + '). The agent will refuse — describe WHAT to achieve, not HOW.';
  return '';
}

function check() {
  const t = el('task').value.trim();
  const w = t ? hintWarning(t) : '';
  el('warn').style.display = w ? 'block' : 'none';
  el('warn').textContent = w;
  el('go').disabled = running || !sel || !t || !!w;
  el('go').textContent = sel ? 'Run on ' + sel : 'Run';
}

// Startup diagnostics (17 scope-ambiguity lines on Yarn) pushed the actual steps off
// screen. Fold them into one expandable row so the log opens on the run, not the preamble.
let foldEl = null, foldCount = 0;
function foldable(text) {
  const log = el('log');
  if (log.querySelector('.empty')) log.innerHTML = '';
  if (!foldEl) {
    foldEl = document.createElement('details');
    foldEl.className = 'fold';
    foldEl.innerHTML = '<summary></summary><div></div>';
    log.appendChild(foldEl);
  }
  foldEl.querySelector('div').appendChild(Object.assign(document.createElement('div'), { textContent: text, className: 't-meta' }));
  foldEl.querySelector('summary').textContent = ++foldCount + ' setup line' + (foldCount === 1 ? '' : 's') + ' (grounding, scope ambiguities) — click to expand';
  log.scrollTop = log.scrollHeight;
}

function line(text) {
  // Only the scope-ambiguity dump is folded; everything else stays inline.
  if (/^\s+scope ambiguity:/.test(text)) return foldable(text);
  const d = document.createElement('div');
  let cls = '';
  if (/^\[\d+\]/.test(text)) cls = 't-step';
  else if (/✓|PASSED|=== DONE/.test(text)) cls = 't-ok';
  else if (/✗|FAIL|WARNING|REFUS|error/i.test(text)) cls = 't-bad';
  else if (/^(stats|verification|home reset|target|task|loaded|recording|run log|visual judge)/.test(text)) cls = 't-meta';
  d.className = cls;
  d.textContent = text;
  const log = el('log');
  if (log.querySelector('.empty')) log.innerHTML = '';
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

const es = new EventSource('/stream');
es.addEventListener('started', (e) => {
  const d = JSON.parse(e.data);
  running = true; check();
  el('stop').style.display = 'block';
  el('status').textContent = 'running: ' + d.app;
  el('log').innerHTML = ''; foldEl = null; foldCount = 0;
  line('▶ ' + d.task + '  —  ' + d.app);
});
es.addEventListener('line', (e) => line(JSON.parse(e.data)));
es.addEventListener('done', (e) => {
  const d = JSON.parse(e.data);
  running = false; check();
  el('stop').style.display = 'none';
  el('status').textContent = 'idle';
  line((d.code === 0 ? '■ finished' : '■ exited with code ' + d.code) + ' after ' + d.elapsed + 's');
  loadApps();
});

el('q').addEventListener('input', render);
// 'input' alone misses programmatic setValue and some IME/paste paths, which left the
// Run button enabled next to a visible "this will be refused" warning. 'change' catches
// the stragglers; the server re-checks regardless.
for (const ev of ['input', 'change', 'keyup', 'paste']) el('task').addEventListener(ev, () => setTimeout(check, 0));
el('go').onclick = async () => {
  const r = await fetch('/run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: sel, task: el('task').value.trim(), record: el('record').checked, noVision: el('novision').checked }),
  });
  if (!r.ok) line('✗ ' + (await r.text()));
};
el('stop').onclick = () => fetch('/stop', { method: 'POST' });

loadApps();
check();
</script>
`;

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

	if (url.pathname === "/") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });

		return void res.end(PAGE);
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
		if (current) broadcast("started", { app: current.app, task: current.task });
		req.on("close", () => listeners.delete(res));

		return;
	}

	if (url.pathname === "/run" && req.method === "POST") {
		let body = "";
		req.on("data", (c) => (body += c));

		return void req.on("end", () => {
			let parsed: { app?: string; task?: string; record?: boolean; noVision?: boolean };
			try {
				parsed = JSON.parse(body);
			} catch {
				res.writeHead(400);

				return void res.end("bad json");
			}
			const app = (parsed.app ?? "").trim();
			const task = (parsed.task ?? "").trim();
			if (!app || !task) {
				res.writeHead(400);

				return void res.end("pick an app and enter a task");
			}
			// Server-side hygiene check: the browser mirror is UX, this is the real gate,
			// and it explains the refusal here rather than as an opaque exit code 2.
			const audit = auditTaskPrompt(task);
			if (audit.hinted) {
				res.writeHead(400);

				return void res.end(`prompt states method, not just the goal — ${audit.reasons.join("; ")}`);
			}
			const err = startRun(app, task, { record: !!parsed.record, noVision: !!parsed.noVision });
			if (err) {
				res.writeHead(409);

				return void res.end(err);
			}
			res.writeHead(200);
			res.end("ok");
		});
	}

	if (url.pathname === "/stop" && req.method === "POST") {
		current?.child.kill("SIGINT");
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
