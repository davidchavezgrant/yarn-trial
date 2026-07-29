/**
 * The demo UI's markup and browser script, rendered by the Electron shell (`electron/`).
 *
 * The page reaches its host through `window.__bus`, injected before this script runs, so
 * nothing here imports Electron directly. That indirection is worth keeping even with one
 * shell: it is what let a browser-based shell exist earlier, and it keeps the renderer
 * testable without an Electron process.
 */
export interface UiBus {
	loadApps(): Promise<unknown[]>;
	/** Recorded runs, newest first, each carrying the prompt that produced it. */
	loadRuns(): Promise<unknown[]>;
	/** Repo-relative mp4 path -> a URL this shell can play. */
	videoUrl(rel: string): string;
	/** Start a grounding (exploration) pass for an app. Resolves to an error string, or undefined. */
	ground(app: string): Promise<string | undefined>;
	run(opts: { app: string; task: string; record: boolean; noVision: boolean }): Promise<string | undefined>;
	stop(): void;
	onStarted(cb: (d: { app: string; task: string }) => void): void;
	onLine(cb: (line: string) => void): void;
	onDone(cb: (d: { code: number | null; elapsed: number }) => void): void;
}

export const CHROME = String.raw`<meta charset="utf-8">
<title>Self-driving demo agent</title>
<style>
  :root { color-scheme: dark; --bg:#16181d; --panel:#1e2128; --line:#2e323c; --fg:#e6e8ec; --dim:#9aa1ad; --accent:#6c8cff; --ok:#57c98a; --bad:#e5736a; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 ui-sans-serif,-apple-system,system-ui,sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:12px; }
  h1 { font-size:15px; margin:0; font-weight:600; }
  header span { color:var(--dim); font-size:12px; }
  main { display:grid; grid-template-columns:250px 1fr 330px; gap:0; height:calc(100vh - 51px); }
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
  .run { padding:8px 10px; border:1px solid var(--line); border-radius:8px; margin-bottom:8px; cursor:pointer; }
  .run:hover { border-color:var(--accent); }
  .run .task { font-size:12.5px; color:var(--fg); margin-bottom:4px; }
  .run .meta { font-size:11px; color:var(--dim); display:flex; gap:8px; flex-wrap:wrap; }
  .run video { width:100%; border-radius:6px; margin-top:8px; background:#000; display:block; }
  .run .ok { color:var(--ok); }
  .run .bad { color:var(--bad); }
  .panehead { display:flex; align-items:center; justify-content:space-between; }
  .mini { width:auto; padding:2px 8px; font-size:13px; line-height:1.2; color:var(--dim); cursor:pointer; }
  .mini:hover { color:var(--fg); border-color:var(--accent); }
  .btnrow { display:flex; gap:8px; margin-top:14px; }
  .btnrow button { margin-top:0; }
  button.ground { width:auto; padding-left:16px; padding-right:16px; background:transparent; color:var(--fg); cursor:pointer; }
  button.ground:hover:not(:disabled) { border-color:var(--accent); }
  button.ground:disabled { opacity:.5; cursor:not-allowed; }
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
    <div class="btnrow">
      <button class="go" id="go" disabled>Run</button>
      <button class="ground" id="ground" disabled title="Autonomous exploration pass — writes docs/appmaps/">Ground</button>
    </div>
    <button class="stop" id="stop" style="display:none">Stop run</button>
    <div id="log" style="margin-top:16px"><span class="empty">Output appears here.</span></div>
  </div>
  <div class="col">
    <div class="panehead"><label>Recorded runs</label><button id="refresh" class="mini" title="Rescan out/runs">↻</button></div>
    <div id="runs"><span class="empty">No recordings yet — tick “Record video”.</span></div>
  </div>
</main>`;

export const APP_JS = String.raw`let apps = [], sel = null, running = false;

const el = (id) => document.getElementById(id);

async function loadApps() {
  apps = await bus.loadApps();
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
  // Grounding needs only a target — it explores the app, it does not perform a task.
  el('ground').disabled = running || !sel;
  const g = sel ? apps.find(a => a.name === sel) : null;
  el('ground').textContent = g && g.grounded ? 'Reground' : 'Ground';
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

const bus = window.__bus;   // {onStarted,onLine,onDone,loadApps,run,stop}
bus.onStarted((d) => {
  running = true; check();
  el('stop').style.display = 'block';
  el('status').textContent = 'running: ' + d.app;
  el('log').innerHTML = ''; foldEl = null; foldCount = 0;
  line('▶ ' + d.task + '  —  ' + d.app);
});
bus.onLine((t) => line(t));
bus.onDone((d) => {
  running = false; check();
  el('stop').style.display = 'none';
  el('status').textContent = 'idle';
  line((d.code === 0 ? '■ finished' : '■ exited with code ' + d.code) + ' after ' + d.elapsed + 's');
  loadApps();
  loadRuns();
});

let runSig = '';
async function loadRuns(force) {
  const runs = await bus.loadRuns();
  const box = el('runs');
  // Rebuilding innerHTML tears down any <video> mid-playback, and this runs on a timer —
  // so redraw only when the set of runs actually changed. Signature over ids, not the
  // whole payload: an in-flight run's log is rewritten as it goes.
  const sig = runs.map(r => r.id).join('|');
  if (!force && sig === runSig) return;
  runSig = sig;

  if (!runs.length) { box.innerHTML = '<span class="empty">No recordings yet — tick “Record video”.</span>'; return; }

  // Preserve which cards were open across a redraw, so a new recording appearing does not
  // collapse the one being watched.
  const open = new Set([...box.querySelectorAll('.run')].filter(c => c.querySelector('video')).map(c => c.dataset.id));

  box.innerHTML = runs.map((r, i) =>
    '<div class="run" data-i="' + i + '" data-id="' + r.id + '">' +
      '<div class="task">' + r.task.replace(/</g,'&lt;') + '</div>' +
      '<div class="meta">' +
        '<span>' + r.app.replace(/</g,'&lt;') + '</span>' +
        '<span class="' + (r.success ? 'ok' : 'bad') + '">' + (r.success ? '✓' : '✗') + ' ' + r.verified + '/' + r.actions + '</span>' +
        '<span>' + r.elapsedSec + 's</span>' +
        '<span>' + r.grounding + '</span>' +
        (r.visual ? '<span>judge ' + r.visual + '</span>' : '') +
      '</div>' +
    '</div>').join('');

  const attach = (card, r, autoplay) => {
    const v = document.createElement('video');
    v.src = bus.videoUrl(r.video);
    v.controls = true; v.autoplay = autoplay; v.loop = true; v.muted = true;
    card.appendChild(v);
  };

  // Load the mp4 only when a card is opened; autoloading every one would fetch the lot.
  for (const card of box.children) {
    const r = runs[Number(card.dataset.i)];
    if (open.has(card.dataset.id)) attach(card, r, false);
    card.onclick = (e) => {
      if (e.target.tagName === 'VIDEO') return;   // clicking the player is not a toggle
      const existing = card.querySelector('video');
      if (existing) { existing.remove(); return; }
      attach(card, r, true);
    };
  }
}

el('q').addEventListener('input', render);
// 'input' alone misses programmatic setValue and some IME/paste paths, which left the
// Run button enabled next to a visible "this will be refused" warning. 'change' catches
// the stragglers; the server re-checks regardless.
for (const ev of ['input', 'change', 'keyup', 'paste']) el('task').addEventListener(ev, () => setTimeout(check, 0));
el('go').onclick = async () => {
  const err = await bus.run({ app: sel, task: el('task').value.trim(), record: el('record').checked, noVision: el('novision').checked });
  if (err) line('✗ ' + err);
};
el('stop').onclick = () => bus.stop();
el('refresh').onclick = () => loadRuns(true);
el('ground').onclick = async () => {
  const err = await bus.ground(sel);
  if (err) line('✗ ' + err);
};

// Recordings also arrive from headless ./run invocations and other sessions, so the
// gallery cannot rely on the in-UI done event alone. Cheap poll: loadRuns() only
// redraws when the set of run ids changes, so this is a directory stat most ticks.
setInterval(() => loadRuns(false), 4000);

loadApps();
loadRuns();
check();
</script>`;

/** Full standalone document; `bootstrap` installs window.__bus before the app script runs. */
export const page = (bootstrap: string): string =>
	`${CHROME}\n<script>${bootstrap}</script>\n<script>${APP_JS}</script>\n`;
