/**
 * The demo UI's markup and browser script, rendered by the Electron shell (`electron/`).
 *
 * The page reaches its host through `window.__bus`, injected before this script runs, so
 * nothing here imports Electron directly. That indirection is worth keeping even with one
 * shell: it is what let a browser-based shell exist earlier, and it keeps the renderer
 * testable without an Electron process.
 */
export interface UiBus {
	/** Apps installed on `host` — that Mac's list, not this one's. See appChoices in ui-remote.ts. */
	loadApps(host: string): Promise<{ apps: unknown[]; host: string; note?: string }>;
	/** Recorded runs, newest first, each carrying the prompt that produced it. */
	loadRuns(): Promise<unknown[]>;
	/** Repo-relative mp4 path -> a URL this shell can play. */
	videoUrl(rel: string): string;
	/**
	 * Start a grounding (exploration) pass. Resolves to an error string, or undefined.
	 *
	 * `url` is set for a web target, alongside — never instead of — `app`, which stays the
	 * display label and the key this page stores state under.
	 */
	ground(app: string, host: string, url?: string): Promise<string | undefined>;
	run(opts: { app: string; task: string; record: boolean; noVision: boolean; host: string; url?: string }): Promise<string | undefined>;
	/** Ends the run wherever it is. Closing the window only detaches; a remote job survives that. */
	stop(): void;
	/** Selector contents: always `local`, plus `auto` and the inventory when a fleet is configured. */
	loadHosts(): Promise<{ hosts: string[]; error?: string }>;
	/** One probe of every host. Never rejects — a dead fleet is an `error` string or degraded rows. */
	loadFleet(): Promise<{
		rows: { name: string; state: string; detail: string; reason?: string; tccOk?: boolean; staleGrants?: string[]; jobId?: string }[];
		offers: { host: string; jobId: string; app?: string }[];
		error?: string;
	}>;
	/** Follow a job already in flight on a remote Mac, replaying its log from the start. */
	attach(host: string, jobId: string, app?: string): Promise<string | undefined>;
	/**
	 * Open a screen-sharing session on a Mac so a person can clear a sign-in wall by hand.
	 * Resolves once the viewer has been asked to open — not once anyone has signed in.
	 */
	signin(host: string, app?: string): Promise<{ ok: boolean; message: string; url?: string }>;
	/** `modelKey` is a boolean by construction — the key itself never crosses this seam. */
	loadCreds(): Promise<{ present: boolean; fingerprint?: string; path: string; modelKey: boolean }>;
	saveKey(key: string): Promise<{ ok: true; credentials: { modelKey: boolean } } | { ok: false; error: string }>;
	loadHostPref(): Promise<{ host: string }>;
	/** Fire-and-forget, like saveState: a lost preference must never block a click. */
	saveHostPref(host: string): void;
		rows: { name: string; state: string; detail: string; reason?: string; tccOk?: boolean; jobId?: string }[];
	/** Per-app task text + log scrollback, and the app selected last. */
	loadState(): Promise<{ lastApp?: string; byApp: Record<string, { task: string; log: string[] }> }>;
	/** Fire-and-forget so it can also run from `beforeunload`, where a round trip would not finish. */
	saveState(state: { lastApp?: string; byApp: Record<string, { task: string; log: string[] }> }): void;
	onStarted(cb: (d: { app: string; task: string }) => void): void;
	onLine(cb: (line: string) => void): void;
	/**
	 * `app` and `host` ride along because the run's outcome is where a remedy has to be offered,
	 * and by then the controller has already let go of the run. `host` is the RESOLVED machine —
	 * `auto` is not somewhere a person can be sent — or `local`.
	 */
	onDone(cb: (d: { code: number | null; elapsed: number; app: string; host: string }) => void): void;
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
  input, textarea, button, select { font:inherit; color:var(--fg); background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:8px 10px; width:100%; }
  input:focus, textarea:focus, select:focus { outline:none; border-color:var(--accent); }
  textarea { resize:vertical; min-height:74px; }
  ul { list-style:none; margin:8px 0 0; padding:0; max-height:calc(100vh - 190px); overflow:auto; }
  li { padding:7px 10px; border-radius:6px; cursor:pointer; display:flex; align-items:center; gap:8px; }
  li:hover { background:var(--panel); }
  li.sel { background:#2b3550; }
  .badge { font-size:10px; padding:1px 6px; border-radius:99px; border:1px solid var(--line); color:var(--dim); }
  .badge.g { color:var(--ok); border-color:#2f5d45; }
  .badge.r { color:var(--accent); border-color:#3a4a7a; }
  .badge.w { color:#c9a0ff; border-color:#5a3f7a; }
  #urlrow { margin-bottom:12px; }
  .hint { font-size:11.5px; color:var(--dim); margin-top:5px; }
  .hint.bad { color:var(--bad); }
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
  .hostrow { display:flex; gap:8px; align-items:center; margin-top:12px; }
  .hostrow span { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); white-space:nowrap; }
  .hostrow select { width:auto; padding:5px 8px; }
  #attach { display:none; margin-top:12px; padding:8px 10px; border-radius:6px; background:#1d2a44; border:1px solid #3a4a7a; font-size:12.5px; }
  /* Amber rather than red: the run did not crash, it declined to start, and the next step is
     something a person does at the machine. */
  #unready { display:none; margin-top:12px; padding:8px 10px; border-radius:6px; background:#3a2f1c; border:1px solid #6b552c; color:#f0d9a8; font-size:12.5px; }
  #unready .umsg { margin-bottom:6px; }
  #unready button { width:auto; }
  .offer { display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:2px 0; }
  .offer span { flex:1; }
  .frow { padding:6px 0; border-bottom:1px solid var(--line); font-size:12.5px; }
  .frow:last-child { border-bottom:none; }
  .fhead { display:flex; gap:8px; align-items:center; }
  .fhead b { font-weight:600; flex:1; }
  .s-idle { color:var(--ok); }
  .s-busy { color:var(--accent); }
  .s-unknown { color:var(--dim); }
  /* The reason a host is degraded is the column this panel exists for, so it wraps in full
     rather than being clipped to the row width. */
  .fdetail, .freason { font-size:11.5px; color:var(--dim); word-break:break-word; }
  .freason { color:#e0a97e; }
  #creds { font-size:12px; color:var(--dim); }
  #creds .crow { padding:3px 0; word-break:break-all; }
  #creds input { margin-top:6px; }
  #creds button { margin-top:6px; }
  .ok { color:var(--ok); }
  .bad { color:var(--bad); }
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
    <div id="urlrow" style="display:none">
      <label for="url">Website to drive</label>
      <input id="url" placeholder="https://www.notion.so" autocomplete="off" spellcheck="false">
      <div id="urlhint" class="hint">A browser needs a URL — the run drives that site, and grounding maps it.</div>
    </div>
    <label for="task">Task (state the GOAL only — not the steps)</label>
    <textarea id="task" placeholder="show me how to change the cursor type"></textarea>
    <div id="warn"></div>
    <div class="hostrow">
      <span>Run on</span>
      <select id="host"><option value="local">local</option></select>
    </div>
    <div class="row">
      <label><input type="checkbox" id="record"> Record video</label>
      <label><input type="checkbox" id="novision"> No screenshots</label>
    </div>
    <div class="btnrow">
      <button class="go" id="go" disabled>Run</button>
      <button class="ground" id="ground" disabled title="Autonomous exploration pass — writes docs/appmaps/">Ground</button>
    </div>
    <button class="stop" id="stop" style="display:none">Stop run</button>
    <div id="attach"></div>
    <div id="unready"></div>
    <div id="log" style="margin-top:16px"><span class="empty">Output appears here.</span></div>
  </div>
  <div class="col">
    <div id="fleetwrap" style="display:none;margin-bottom:18px">
      <div class="panehead"><label>Fleet</label><button id="fleetrefresh" class="mini" title="Probe every host now">↻</button></div>
      <div id="fleet"><span class="empty">probing…</span></div>
      <details class="fold" style="margin-top:10px"><summary>Credentials</summary><div id="creds"></div></details>
    </div>
    <div class="panehead"><label>Recorded runs</label><button id="refresh" class="mini" title="Rescan out/runs">↻</button></div>
    <div id="runs"><span class="empty">No recordings yet — tick “Record video”.</span></div>
  </div>
</main>`;

export const APP_JS = String.raw`let apps = [], sel = null, running = false;

// Where the next Run/Ground goes. 'local' is the original in-process RunController and is the
// value on a machine with no hosts.json, so the local-only shell never takes a fleet branch.
let host = 'local';
// Re-attach candidates from the last fleet probe, and the ones this window has said no to —
// without that set the banner would reappear every ten seconds for the whole 40 minutes of
// someone else's grounding pass.
let offers = [], fleetRows = {}, dismissed = new Set(), probing = false;
// Outcome of the last sign-in click, kept outside the row markup because the fleet list is
// rebuilt every fifteen seconds and a message rendered into a row would vanish before it was read.
let signinMsg = null;
// The last run that turned around at the door — {app, host, msg} — or null.
//
// Deliberately NOT a judgement about what was on screen: the agent reports "not at home and I do
// not know why", and guessing "that looks like a login" from the controls it listed would be
// app-specific logic. The remedy is the same for every cause, so the panel offers it for every
// cause: put a human in front of that Mac.
let unready = null;

const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

// Log lines belong to the app whose run produced them, not to whatever happens to be
// selected when they arrive: switching targets mid-run must not splice this run's output
// into another app's terminal.
let runningApp = null;
let uiState = { byApp: {} };

const el = (id) => document.getElementById(id);

// A typed URL is offered as a target even before it has ever been explored, so the first
// grounding pass on a new site can be started from here. Held separately from the apps list
// because it is not a discovered entry — it exists only while the box says something navigable.
function typedUrl() {
  const q = el('q').value.trim();
  if (!/^https?:\/\/\S+$/i.test(q)) return null;
  try { return new URL(q).toString(); } catch { return null; }
}

/**
 * The URL for the current selection, or undefined for a Mac app.
 *
 * sel stays a bare string on purpose: it is simultaneously the display label, the byApp key,
 * an argv positional and an === join key against AppEntry.name and started.app. Making it an
 * object breaks all four silently — the renderer is not typechecked and has no tests — so the
 * URL is looked up beside it instead of carried inside it.
 */
function selUrl() {
  const hit = apps.find((a) => a.name === sel);
  // A browser is only a target once it has somewhere to go, so the URL box wins for one.
  if (hit && isBrowser(hit.name)) return urlBoxValue();
  if (hit && hit.kind === 'web') return hit.url;
  const typed = typedUrl();

  return typed && new URL(typed).host === sel ? typed : undefined;
}

// The host tags browser entries in listApps() — see AppEntry.browser. Deciding it there
// rather than re-listing the browser names in this string literal is what keeps the two from
// drifting; an unknown app is simply not a browser.
function isBrowser(name) {
  const hit = apps.find((a) => a.name === name);

  return !!(hit && hit.browser);
}

/** The URL box's contents, normalised, or undefined when it is empty or not navigable. */
function urlBoxValue() {
  const raw = el('url').value.trim();
  if (!raw) return undefined;
  // Typing "notion.so" is the common case and meaning it as https is unambiguous. The host
  // re-validates, so this only decides whether the Run button lights up.
  const withScheme = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  try {
    const u = new URL(withScheme);

    return u.hostname.includes('.') ? u.toString() : undefined;
  } catch { return undefined; }
}

/**
 * Show the URL box when the selected app is a browser, and report whether the run is blocked
 * on it. A browser with no URL is not a runnable target — it would open on whatever page it
 * happened to be showing.
 */
function syncUrlRow() {
  const browser = !!sel && isBrowser(sel);
  el('urlrow').style.display = browser ? 'block' : 'none';
  if (!browser) return false;
  const raw = el('url').value.trim();
  const ok = !!urlBoxValue();
  el('urlhint').textContent = raw && !ok
    ? 'That does not look like a web address.'
    : 'A browser needs a URL — the run drives that site, and grounding maps it.';
  el('urlhint').className = raw && !ok ? 'hint bad' : 'hint';

  return !ok;
}

function stateFor(app) {
  return uiState.byApp[app] || (uiState.byApp[app] = { task: '', log: [] });
}

// Mirrors LOG_LINES_KEPT in ui-core.ts, which re-caps on write. Duplicated because this
// script crosses the process boundary as a string and cannot import it; the host is
// authoritative, this bound just keeps the in-memory buffer and each save small.
const LOG_LINES_KEPT = 400;

// saveState is fire-and-forget, so coalesce bursts — a run emits lines continuously —
// into one write per second, and flush at the moments that would otherwise lose state.
let saveTimer = null;
function saveSoon() {
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 1000);
}
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  // The textarea is the source of truth for the selected app's task; snapshot it here so
  // every caller gets that for free rather than remembering to copy it.
  if (sel) { stateFor(sel).task = el('task').value; stateFor(sel).url = el('url').value.trim(); uiState.lastApp = sel; }
  bus.saveState(uiState);
}

async function loadApps() {
  // Snapshot the host: this is a round trip to another Mac and the selector can move during it.
  // Without the guard a slow answer from mac1 lands after the operator has switched to mac2 and
  // silently repopulates the list with the wrong machine's apps.
  const asked = host;
  el('q').placeholder = 'Searching ' + asked + '…';
  const res = await bus.loadApps(asked);
  if (asked !== host) return;

  apps = (res && res.apps) || [];
  el('q').placeholder = asked === 'local' ? 'Search apps…' : 'Search apps on ' + asked + '…';
  if (res && res.note) line('· ' + res.note);
  render();
}

/** Reselect the last app and repopulate its task + terminal before the first paint. */
async function restore() {
  const saved = await bus.loadState();
  uiState = saved && saved.byApp ? saved : { byApp: {} };
  if (uiState.lastApp) {
    sel = uiState.lastApp;
    el('task').value = stateFor(sel).task;
    el('url').value = stateFor(sel).url || '';
  }
  renderLog(sel);
  render();
  check();
}

function selectApp(name) {
  if (name === sel) return;
  // Keep what was typed for the app being left — both fields, or switching to Chrome and back
  // loses the site you had already chosen.
  if (sel) { stateFor(sel).task = el('task').value; stateFor(sel).url = el('url').value.trim(); }
  sel = name;
  el('task').value = stateFor(name).task;
  el('url').value = stateFor(name).url || '';
  renderLog(name);
  render();
  check();
  flush();
}

function render() {
  const q = el('q').value.toLowerCase();
  const hits = apps.filter(a => a.name.toLowerCase().includes(q)).slice(0, 60);
  // A navigable URL that is not already a known target gets an entry of its own, at the top:
  // a site nobody has explored yet has nothing on disk to enumerate, so without this the only
  // way to ground a new site would be the command line.
  const typed = typedUrl();
  const typedHost = typed ? new URL(typed).host : null;
  const fresh = typedHost && !apps.some(a => a.name === typedHost)
    ? [{ name: typedHost, grounded: false, running: false, kind: 'web', url: typed }]
    : [];
  el('apps').innerHTML = [...fresh, ...hits].map(a =>
    '<li data-n="' + encodeURIComponent(a.name) + '" class="' + (a.name === sel ? 'sel' : '') + '">' +
    '<span style="flex:1">' + esc(a.name) + '</span>' +
    (a.kind === 'web' ? '<span class="badge w">web</span>' : '') +
    (a.grounded ? '<span class="badge g">grounded</span>' : '') +
    (a.running ? '<span class="badge r">open</span>' : '') + '</li>').join('');
  for (const li of el('apps').children) {
    li.onclick = () => selectApp(decodeURIComponent(li.dataset.n));
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
  // A browser with no URL is not a runnable target: it would open on whatever page it
  // happened to be showing, which is nobody's intent and not reproducible.
  const needsUrl = syncUrlRow();
  el('go').disabled = running || !sel || !t || !!w || needsUrl;
  const site = selUrl();
  el('go').textContent = sel
    ? 'Run on ' + (site ? new URL(site).host : sel) + (host === 'local' ? '' : ' @ ' + host)
    : 'Run';
  // Grounding needs only a target — it explores the app, it does not perform a task.
  el('ground').disabled = running || !sel || needsUrl;
  // Keyed on the SITE when there is one: whether Chrome has an appmap says nothing about
  // whether notion.so does. A site never explored has no entry, so the button correctly
  // reads "Ground" — that is the first pass on it.
  const key = site ? new URL(site).host : sel;
  const g = key ? apps.find(a => a.name === key) : null;
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

// DOM only. Split out from line() because replaying a stored terminal must paint the same
// way without re-appending to the buffer it is being replayed from.
function appendLine(text) {
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

/** Repaint the terminal from an app's stored scrollback. */
function renderLog(app) {
  const log = el('log');
  log.innerHTML = '';
  foldEl = null; foldCount = 0;
  const lines = app ? stateFor(app).log : [];
  if (!lines.length) { log.innerHTML = '<span class="empty">Output appears here.</span>'; return; }
  for (const t of lines) appendLine(t);
}

function line(text) {
  const owner = runningApp || sel;
  if (owner) {
    const buf = stateFor(owner).log;
    buf.push(text);
    if (buf.length > LOG_LINES_KEPT) buf.splice(0, buf.length - LOG_LINES_KEPT);
  }
  // Paint only if the line belongs to what is on screen. Output for a background run is
  // still captured; it appears when you select that app again.
  if (!owner || owner === sel) appendLine(text);
  saveSoon();
}

const bus = window.__bus;   // {onStarted,onLine,onDone,loadApps,loadState,saveState,run,stop}
bus.onStarted((d) => {
  running = true; runningApp = d.app; check(); renderAttach();
  // The previous refusal is answered by trying again, whatever the outcome of the retry.
  unready = null; renderUnready();
  el('stop').style.display = 'block';
  el('status').textContent = 'running: ' + d.app;
  // A new run replaces that app's terminal rather than appending to the last one.
  stateFor(d.app).log = [];
  if (d.app === sel) { el('log').innerHTML = ''; foldEl = null; foldCount = 0; }
  line('▶ ' + d.task + '  —  ' + d.app);
});
bus.onLine((t) => line(t));
bus.onDone((d) => {
  running = false; check(); renderAttach();
  el('stop').style.display = 'none';
  el('status').textContent = 'idle';
  // Before clearing runningApp: this line belongs to the run's terminal, not the selection's.
  line((d.code === 0 ? '■ finished' : '■ exited with code ' + d.code) + ' after ' + d.elapsed + 's');
  // 3 is the agent's "not at home, reason unknown" — the one exit code with a remedy a person
  // can act on from here. Everything else is a run that ran.
  unready = d.code === 3 ? { app: d.app, host: d.host, msg: null } : null;
  renderUnready();
  runningApp = null;
  flush();
  loadApps();
  loadRuns();
});

/**
 * Populate the host selector, and decide whether this window has a fleet at all.
 *
 * Everything fleet-shaped hangs off hosts.length > 1: no hosts.json means no panel, no
 * credentials fold and — the part that matters — no poll timer, so a local-only machine never
 * pays for a feature it cannot use and the UI it sees is the one it had before any of this.
 */
async function loadHostList() {
  const info = await bus.loadHosts();
  const list = (info && info.hosts) || ['local'];
  const pref = await bus.loadHostPref();
  // Fall back rather than trust the saved value: a host removed from hosts.json since the last
  // session would otherwise leave the selector displaying something it cannot dispatch to.
  host = list.indexOf(pref && pref.host) >= 0 ? pref.host : 'local';
  el('host').innerHTML = list.map(h => '<option value="' + esc(h) + '"' + (h === host ? ' selected' : '') + '>' + esc(h) + '</option>').join('');
  // An inventory that exists but does not parse is loud on purpose: silently offering only
  // 'local' looks exactly like having no fleet, and sends the operator to the wrong problem.
  if (info && info.error) line('✗ hosts.json: ' + info.error);
  check();
  // The saved host arrives after boot's loadApps() has already asked, so re-ask once it is
  // known. Without this the window opens showing THIS Mac's apps under a selector reading
  // "mac1" — the exact confusion the per-host list exists to remove.
  if (host !== 'local') loadApps();
  if (list.length < 2) return;

  el('fleetwrap').style.display = 'block';
  loadCreds();
  loadFleet();
  // Each tick is a real ssh fan-out over every Mac, so this is slower than the gallery poll
  // and skips itself while one is still in flight — a host at its timeout would otherwise
  // stack probes faster than they drain.
  setInterval(loadFleet, 15000);
}

async function loadFleet() {
  if (probing) return;
  probing = true;
  let view;
  try {
    view = await bus.loadFleet();
  } finally {
    probing = false;
  }
  const box = el('fleet');
  if (view.error) { box.innerHTML = '<div class="frow"><span class="bad">' + esc(view.error) + '</span></div>'; return; }
  if (!view.rows.length) { box.innerHTML = '<span class="empty">No hosts configured.</span>'; return; }

  fleetRows = {};
  for (const r of view.rows) fleetRows[r.name] = r;
  box.innerHTML = view.rows.map(r =>
    '<div class="frow">' +
      '<div class="fhead"><b>' + esc(r.name) + '</b>' +
        '<span class="s-' + esc(r.state) + '">' + esc(r.state) + '</span>' +
        (r.staleGrants && r.staleGrants.length
          ? '<span class="bad" title="' + esc(r.staleGrants.join(' and ')) + ' was granted after the runner started, so it is not in effect. Run: ./run provision --restart">stale TCC</span>'
          : r.tccOk === false ? '<span class="bad" title="Accessibility / Screen Recording not granted">no TCC</span>' : '') +
        // Screen sharing, not a run: safe while the host is busy, and the only way past an app
        // that wants a human to type a password into it.
        '<button class="mini" data-signin="' + esc(r.name) + '" title="Open this Mac over screen sharing to sign in by hand">Sign in</button>' +
      '</div>' +
      (r.detail ? '<div class="fdetail">' + esc(r.detail) + '</div>' : '') +
      (r.reason ? '<div class="freason">' + esc(r.reason) + '</div>' : '') +
    '</div>').join('') +
    (signinMsg ? '<div class="' + (signinMsg.ok ? 'fdetail' : 'freason') + '">' + esc(signinMsg.text) + '</div>' : '');

  offers = view.offers || [];
  renderAttach();
}

/**
 * Offer to follow a run that is already going.
 *
 * This is what makes closing the window survivable: the job is a detached process on the
 * remote and its log is a file there, so the only thing a restart ever lost was the id — and
 * the busy fleet row carries it. Hidden while this window is already driving something,
 * because the host can only follow one stream into one log pane.
 */
function renderAttach() {
  const box = el('attach');
  const live = running ? [] : offers.filter(o => !dismissed.has(o.jobId));
  box.style.display = live.length ? 'block' : 'none';
  box.innerHTML = live.map(o => {
    const row = fleetRows[o.host];
    return '<div class="offer"><span>' + esc(o.host) + ' — ' + esc((row && row.detail) || o.app || o.jobId) + '</span>' +
      '<button class="mini" data-follow="' + esc(o.jobId) + '" data-host="' + esc(o.host) + '" data-app="' + esc(o.app || '') + '">Follow</button>' +
      '<button class="mini" data-dismiss="' + esc(o.jobId) + '">Dismiss</button></div>';
  }).join('');
}

/**
 * Offer the way out of a run that refused to start.
 *
 * Exit 3 is agent.ts saying the app is not at the home state its appmap declares, and that it
 * cannot tell why — a sign-in wall, a modal, a half-finished dialog all look the same from the
 * accessibility tree. So this panel does not name a cause. It offers the one remedy that covers
 * all of them: open the machine and let a person put the app back where it belongs. On a remote
 * host that is a screen share; locally the app is already right there, so there is nothing to
 * open and the panel just says what happened.
 */
function renderUnready() {
  const box = el('unready');
  box.style.display = unready ? 'block' : 'none';
  if (!unready) return;

  const where = unready.host && unready.host !== 'local' ? ' on ' + esc(unready.host) : ' on this Mac';
  box.innerHTML =
    '<div class="umsg">' + esc(unready.app || 'The app') + ' was not at its home screen' + where +
      ', so the run stopped before touching anything. Put it back at its home screen — signing in, if that is what it is asking for — then run again.</div>' +
    (unready.msg ? '<div class="fdetail">' + esc(unready.msg) + '</div>' : '') +
    (unready.host && unready.host !== 'local'
      ? '<button class="mini" data-fix="1">Open ' + esc(unready.host) + '</button>'
      : '');
}

async function loadCreds() {
  const c = await bus.loadCreds();
  // The key is never rendered, only its presence — this panel is the part of the UI people
  // screenshot when asking why a run could not authenticate.
  el('creds').innerHTML =
    '<div class="crow">' + (c.present ? 'fleet identity <span class="ok">' + esc(c.fingerprint || 'unreadable') + '</span>' : '<span class="bad">no fleet identity</span>') + '</div>' +
    '<div class="crow">' + esc(c.path) + '</div>' +
    '<div class="crow" id="keystate"></div>' +
    '<input id="key" type="password" placeholder="Paste your own OpenRouter key" autocomplete="off" spellcheck="false">' +
    '<button class="mini" id="savekey">Save key</button>' +
    '<div class="crow" id="keymsg"></div>';
  paintKeyState(c.modelKey);
  el('savekey').onclick = async () => {
    const r = await bus.saveKey(el('key').value);
    // Cleared unconditionally: the field is the only copy of the value in this renderer, and
    // leaving it populated is how a secret ends up in a screen recording of the app.
    el('key').value = '';
    // r.credentials is the host re-reading the file it just wrote, so repainting from it means
    // 'saved' asserts the next run will find the key, not merely that a write did not throw.
    if (r.ok) paintKeyState(r.credentials.modelKey);
    el('keymsg').innerHTML = r.ok
      ? (r.credentials.modelKey ? '<span class="ok">saved</span>' : '<span class="bad">saved, but nothing readable landed</span>')
      : '<span class="bad">' + esc(r.error) + '</span>';
  };
}

function paintKeyState(present) {
  el('keystate').innerHTML = 'model key ' + (present ? '<span class="ok">present</span>' : '<span class="bad">absent</span>');
}

let runSig = '';
async function loadRuns(force) {
  const runs = await bus.loadRuns();
  const box = el('runs');
  // Rebuilding innerHTML tears down any <video> mid-playback, and this runs on a timer —
  // so redraw only when the set of runs actually changed. Signature over ids, not the
  // whole payload: an in-flight run's log is rewritten as it goes.
  const sig = runs.map(r => r.id + (r.host || '')).join('|');
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
        // Only fleet runs are tagged. Badging local ones too would erase the distinction the
        // badge exists to draw.
        (r.host ? '<span class="badge r">' + esc(r.host) + '</span>' : '') +
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
// Same coverage as the task box: 'input' alone misses paste and IME paths, and the Run button
// must not stay enabled next to a URL that will be refused.
for (const ev of ['input', 'change', 'keyup', 'paste']) el('url').addEventListener(ev, () => setTimeout(() => { check(); saveSoon(); }, 0));
// 'input' alone misses programmatic setValue and some IME/paste paths, which left the
// Run button enabled next to a visible "this will be refused" warning. 'change' catches
// the stragglers; the server re-checks regardless.
for (const ev of ['input', 'change', 'keyup', 'paste']) el('task').addEventListener(ev, () => setTimeout(() => { check(); saveSoon(); }, 0));
el('go').onclick = async () => {
  const err = await bus.run({ app: sel, task: el('task').value.trim(), record: el('record').checked, noVision: el('novision').checked, host: host, url: selUrl() });
  if (err) line('✗ ' + err);
};
el('stop').onclick = () => bus.stop();
el('refresh').onclick = () => loadRuns(true);
el('ground').onclick = async () => {
  const err = await bus.ground(sel, host, selUrl());
  if (err) line('✗ ' + err);
};
// loadApps too: the list is per-host, so switching machines must re-ask rather than leave the
// previous Mac's inventory on screen looking like this one's.
el('host').onchange = () => { host = el('host').value; bus.saveHostPref(host); check(); loadApps(); };
el('fleetrefresh').onclick = () => loadFleet();
// Delegated for the same reason the offer list is: these buttons are rebuilt on every probe.
// The selected app rides along so the Mac opens with it already in front of you.
el('fleet').onclick = async (e) => {
  const b = e.target.closest ? e.target.closest('button[data-signin]') : null;
  if (!b) return;
  b.disabled = true;
  signinMsg = { ok: true, text: 'opening ' + b.dataset.signin + '…' };
  loadFleet();
  const r = await bus.signin(b.dataset.signin, sel || undefined);
  signinMsg = { ok: r.ok, text: r.message };
  loadFleet();
};
// Same two-step as the fleet row's Sign in — open the screen share, then wait for the app to
// reach home and close it — but keyed to the app the refused run was against rather than to
// whatever happens to be selected in the list on the left.
el('unready').onclick = async (e) => {
  const b = e.target.closest ? e.target.closest('button[data-fix]') : null;
  if (!b || !unready) return;
  const target = { app: unready.app, host: unready.host };
  b.disabled = true;
  unready = { app: target.app, host: target.host, msg: 'opening ' + target.host + '…' };
  renderUnready();
  const r = await bus.signin(target.host, target.app || undefined);
  unready = { app: target.app, host: target.host, msg: r.message };
  renderUnready();
  loadFleet();
  if (!r.watch) return;

  // Resolves when a person finishes signing in, which can be minutes. The panel clears itself
  // on success: the machine is ready and there is nothing left here to act on.
  const done = await bus.signinWait(r.watch.host, r.watch.app);
  if (done.ok) { unready = null; renderUnready(); line('✓ ' + done.message); }
  else { unready = { app: target.app, host: target.host, msg: done.message }; renderUnready(); }
  loadFleet();
};
// Delegated: the offer list is rebuilt on every probe, so per-button handlers would be
// re-bound fifteen times a minute for the life of a grounding pass.
el('attach').onclick = async (e) => {
  const b = e.target.closest ? e.target.closest('button') : null;
  if (!b) return;
  if (b.dataset.dismiss) { dismissed.add(b.dataset.dismiss); renderAttach(); return; }
  if (!b.dataset.follow) return;
  const err = await bus.attach(b.dataset.host, b.dataset.follow, b.dataset.app);
  if (err) line('✗ ' + err);
};

// Recordings also arrive from headless ./run invocations and other sessions, so the
// gallery cannot rely on the in-UI done event alone. Cheap poll: loadRuns() only
// redraws when the set of run ids changes, so this is a directory stat most ticks.
setInterval(() => loadRuns(false), 4000);

// Last chance to persist: a pending saveSoon() would die with the window. saveState is
// send-not-invoke precisely so it survives being called here.
window.addEventListener('beforeunload', flush);

// Restore first so the shell opens on the app you were last driving; loadApps() either way,
// since an unreadable state file must not leave the list empty.
restore().then(loadApps, loadApps);
// Independent of restore(): an unreadable ui-state.json must not cost the host selector, which
// is the one control that decides whether a click runs here or on another machine.
loadHostList().catch(() => {});
loadRuns();
</script>`;

/** Full standalone document; `bootstrap` installs window.__bus before the app script runs. */
export const page = (bootstrap: string): string =>
	`${CHROME}\n<script>${bootstrap}</script>\n<script>${APP_JS}</script>\n`;
