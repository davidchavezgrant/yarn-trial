/**
 * The demo UI's markup and browser script, rendered by the Electron shell (`electron/`).
 *
 * The page reaches its host through `window.__bus`, injected before this script runs, so
 * nothing here imports Electron directly. That indirection is worth keeping even with one
 * shell: it is what let a browser-based shell exist earlier, and it keeps the renderer
 * testable without an Electron process. The bus contract's living definition is the
 * `window.__bus = {...}` object electron/main.ts installs; the `const bus` line below
 * lists the method surface this script actually calls.
 */

export const CHROME = String.raw`<meta charset="utf-8">
<title>Self-driving demo agent</title>
<style>
  :root { color-scheme: dark; --bg:#16181d; --panel:#1e2128; --line:#2e323c; --fg:#e6e8ec; --dim:#9aa1ad; --accent:#6c8cff; --ok:#57c98a; --bad:#e5736a; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 ui-sans-serif,-apple-system,system-ui,sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:12px; }
  h1 { font-size:15px; margin:0; font-weight:600; }
  header span { color:var(--dim); font-size:12px; }
  /* The left column sizes to its content (bounded, so a pathological app name cannot eat the
     window) — a fixed 250px put horizontal scrollbars under ordinary badge rows. */
  main { display:grid; grid-template-columns:fit-content(420px) 1fr 330px; gap:0; height:calc(100vh - 51px); }
  .col { padding:16px; overflow:auto; }
  .col + .col { border-left:1px solid var(--line); }
  /* The middle column is a flex stack so #log can be its own scrollbox. The autoscroll pin
     reads and writes the LOG's scroll geometry; if the log merely grows and the column does
     the scrolling, scrollTop clamps to 0, scroll events fire on the column and never bubble,
     and the pin can neither follow nor release. */
  .col.mid { display:flex; flex-direction:column; }
  .col.mid > * { flex:0 0 auto; }
  label { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); margin:0 0 6px; }
  input, textarea, button, select { font:inherit; color:var(--fg); background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:8px 10px; width:100%; }
  input:focus, textarea:focus, select:focus { outline:none; border-color:var(--accent); }
  textarea { resize:vertical; min-height:74px; }
  /* 240px, not the old 190px: the Run/Ground pair now sits under the list and needs its row. */
  ul { list-style:none; margin:8px 0 0; padding:0; max-height:calc(100vh - 240px); overflow:auto; }
  li { padding:7px 10px; border-radius:6px; cursor:pointer; display:flex; align-items:center; gap:8px; }
  /* Fixed box whether or not the icon has arrived, so rows do not shift when one lands. */
  .appicon { width:16px; height:16px; flex:0 0 16px; border-radius:3px; display:inline-block; }
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
  #log { font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; word-break:break-word; flex:1 1 0; min-height:80px; overflow-y:auto; }
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
  .vtoggle { display:flex; gap:6px; margin-top:6px; }
  .vtoggle .mini.on { color:var(--fg); border-color:var(--accent); }
  .hrow { margin-top:6px; }
  .hrow span { font-size:11px; color:var(--dim); }
  .hfail { font-size:11px; color:var(--bad); margin-top:4px; word-break:break-word; }
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
  /* One action per line, full width: four abbreviated buttons crammed on one row were
     unreadable, and the label IS the safety feature on a destructive action. */
  .factions { display:flex; flex-direction:column; gap:4px; margin:4px 0 6px; }
  .factions button { width:100%; text-align:left; }
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
  <button id="cancelsignin" class="mini" style="display:none;margin-left:auto" title="Close the sign-in view and stop its server">✕ cancel sign-in</button>
</header>
<main>
  <div class="col">
    <!-- The host decides everything below it — which apps are listed, where Run lands — so
         it sits above the search rather than buried in the middle column. -->
    <div class="hostrow" style="margin:0 0 12px">
      <span>Run on</span>
      <select id="host"><option value="local">local</option></select>
    </div>
    <label for="q">Target app</label>
    <input id="q" placeholder="Search apps…" autocomplete="off">
    <ul id="apps"></ul>
    <!-- Run and Ground live under the list because both act on the selection made there.
         Stop stays in the middle column, beside the log of the run it interrupts. -->
    <div class="btnrow">
      <button class="go" id="go" disabled>Run</button>
      <button class="ground" id="ground" disabled title="Autonomous exploration pass — writes docs/appmaps/">Ground</button>
    </div>
  </div>
  <div class="col mid">
    <div id="urlrow" style="display:none">
      <label for="url">Website to drive</label>
      <input id="url" placeholder="https://www.notion.so" autocomplete="off" spellcheck="false">
      <div id="urlhint" class="hint">A browser needs a URL — the run drives that site, and grounding maps it.</div>
    </div>
    <label for="task">Task (state the GOAL only — not the steps)</label>
    <textarea id="task" placeholder="show me how to change the cursor type"></textarea>
    <div id="warn"></div>
    <div class="row">
      <label><input type="checkbox" id="record"> Record video</label>
      <label title="Render the humanized cursor over the recording when the run finishes"><input type="checkbox" id="human"> Human cursor</label>
      <label><input type="checkbox" id="novision"> No screenshots</label>
    </div>
    <button class="stop" id="stop" style="display:none">Stop run</button>
    <div id="attach"></div>
    <div id="unready"></div>
    <div id="log" style="margin-top:16px"><span class="empty">Output appears here.</span></div>
  </div>
  <div class="col">
    <div id="fleetwrap" style="display:none;margin-bottom:18px">
      <!-- A fold, not an always-open panel: three Macs × five actions drowned the gallery,
           which is the column's actual deliverable. Closed by default; the state a person
           needs mid-run (busy/unready) surfaces through the attach offers and unready panel. -->
      <details class="fold" id="fleetfold">
        <summary>Fleet <button id="fleetrefresh" class="mini" title="Probe every host now">↻</button></summary>
        <div id="fleet"><span class="empty">probing…</span></div>
        <details class="fold" style="margin-top:10px"><summary>Credentials</summary><div id="creds"></div></details>
      </details>
    </div>
    <div class="panehead"><label>Recorded runs</label><button id="refresh" class="mini" title="Rescan out/runs">↻</button></div>
    <div id="runs"><span class="empty">No recordings yet — tick “Record video”.</span></div>
  </div>
</main>`;

export const APP_JS = String.raw`let apps = [], sel = null;

// Live runs, host -> app. The HOST is the unit of contention (one run per Mac — LIMITATIONS
// §6 — but different Macs do not contend), so busy checks key on it; the app names the pane
// the run's output fills. Log buffers stay keyed by APP NAME (stateFor), which means two runs
// of the SAME app on different hosts would interleave in one buffer — an accepted limitation:
// the common case is different apps, and re-keying every pane by app@host would ripple through
// selection, persistence and the gallery for a case the far side's lease makes rare.
let running = {};

// Where the next Run/Ground goes. 'local' is the original in-process RunController and is the
// value on a machine with no hosts.json, so the local-only shell never takes a fleet branch.
let host = 'local';
// Re-attach candidates from the last fleet probe, and the ones this window has said no to —
// without that set the banner would reappear every ten seconds for the whole 40 minutes of
// someone else's grounding pass.
let offers = [], fleetRows = {}, dismissed = new Set(), probing = false;
// Outcome of the last sign-in click, kept outside the row markup because the fleet list is
// rebuilt every fifteen seconds and a message rendered into a row would vanish before it was
// read. 'paints' counts repaints so the message can also retire: without that it outlived its
// moment, and "opening mac2…" sat under the panel for the rest of the session.
let signinMsg = null;
// The host whose sign-in is mid-flight. Disabling the clicked button was not enough: the very
// repaint that shows "opening mac2…" rebuilds the row from markup with the button enabled
// again, and a second click double-opens screen shares. The rebuild consults this instead.
let signinBusy = null;
// The last run that turned around at the door — {app, host, msg, busy} — or null.
//
// Deliberately NOT a judgement about what was on screen: the agent reports "not at home and I do
// not know why", and guessing "that looks like a login" from the controls it listed would be
// app-specific logic. The remedy is the same for every cause, so the panel offers it for every
// cause: put a human in front of that Mac.
//
// The generation counter is for the panel's own fix flow, whose signinWait leg resolves when a
// person finishes an SSO round trip — minutes later. By then this panel can be about a NEWER
// refusal, or gone because a new run started; a continuation still holding the old target must
// not write over that. Every write from outside the flow bumps the generation, and the flow
// re-checks it before each write.
let unready = null, unreadyGen = 0;

const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

// A rejected IPC call arrives as an Error, but a handler that threw a string or nothing does
// not — and "✗ undefined" in the log reads like something the agent printed.
const errText = (e) => (e && e.message) || (e ? String(e) : 'unknown error');

let uiState = { byApp: {} };

/** The host whose run owns the selected pane, or null. First match wins when the same app is
 * live on two hosts — those runs already share one log buffer (see the note on 'running'),
 * so the pane cannot tell them apart either. */
function paneRunHost() {
  for (const h of Object.keys(running)) if (running[h] === sel) return h;
  return null;
}

/** Header text: every live run, not just one — 'running: Yarn @ mac1, Notion Calendar @ local'. */
function paintStatus() {
  const live = Object.keys(running).map((h) => running[h] + ' @ ' + h);
  el('status').textContent = live.length ? 'running: ' + live.join(', ') : 'idle';
}

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
  // A fresh web selection is never in 'apps' — its URL was stashed at selection time.
  // Re-deriving it from the search box let an edit to the box silently strip the URL from a
  // selection that still read "Run on www.notion.so": the dispatch then treated the host name
  // as a Mac app. The host check keeps a browser's saved site from leaking in when the apps
  // list failed to load and the browser flag with it.
  const saved = sel && uiState.byApp[sel] && uiState.byApp[sel].url;
  if (saved) { try { if (new URL(saved).host === sel) return saved; } catch {} }
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
  let res;
  try {
    res = await bus.loadApps(asked);
  } catch (e) {
    // An unreachable Mac used to leave "Searching mac2…" up forever with nothing in the log
    // to say the request died rather than being slow — and the rejection escaped unhandled.
    // Owner is the SELECTION, like the note below: defaulting would file this under whatever
    // app is mid-run, invisibly, instead of the pane the operator is looking at.
    if (asked === host) { el('q').placeholder = 'Search apps…'; line('✗ listing apps on ' + asked + ': ' + errText(e), sel); }

    return;
  }
  if (asked !== host) return;

  apps = (res && res.apps) || [];
  el('q').placeholder = asked === 'local' ? 'Search apps…' : 'Search apps on ' + asked + '…';
  // Owner is the SELECTION: this note is about the list on screen, and defaulting would file
  // it into the running app's terminal whenever a run is in flight.
  if (res && res.note) line('· ' + res.note, sel);
  render();
  dropStaleSelection();
}

/** Reselect the last app and repopulate its task + terminal before the first paint. */
async function restore() {
  let saved = null;
  try {
    saved = await bus.loadState();
  } catch {
    // No memory is a working shell; a rejection here must not stop boot.
  }
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

// The saved selection can name an app that no longer exists on the selected host — deleted
// since last session, or the selector now points at a different Mac. The task pane stays (its
// text is still the user's), but Run must not offer to dispatch at a target the host will not
// resolve. Called after every loadApps(), which is the moment 'apps' becomes trustworthy.
function dropStaleSelection() {
  if (!sel || apps.some(a => a.name === sel)) return;
  // A typed URL is a legitimate selection that is never in 'apps'; keep it. The stashed URL
  // counts the same way — the selection stays a valid web target after the search box moves on.
  if (typedUrl() && new URL(typedUrl()).host === sel) return;
  if (selUrl()) return;
  // A run in flight owns the pane and its own app name; resolve the mismatch when it ends.
  if (paneRunHost()) return;
  const gone = sel;
  sel = null;
  renderLog(null);
  render();
  check();
  // After renderLog: painted into the now-empty pane, unowned, so it survives the repaint.
  line('· ' + gone + ' is not on ' + host + ' — pick a target from the list', null);
}

function selectApp(name, url) {
  // Re-clicking the selected entry after retyping its URL is a real re-target, not a no-op.
  if (name === sel) {
    if (url && stateFor(name).url !== url) { stateFor(name).url = url; el('url').value = url; check(); flush(); }
    return;
  }
  // Keep what was typed for the app being left — both fields, or switching to Chrome and back
  // loses the site you had already chosen.
  if (sel) { stateFor(sel).task = el('task').value; stateFor(sel).url = el('url').value.trim(); }
  sel = name;
  // A web entry's URL becomes part of the selection HERE, not re-derived from the search box
  // later: the box is free to change after the click, and a selection that silently loses its
  // URL dispatches the host name as a Mac app.
  if (url) stateFor(name).url = url;
  el('task').value = stateFor(name).task;
  el('url').value = stateFor(name).url || '';
  renderLog(name);
  render();
  check();
  flush();
}

// groundedAt is the pass's own capturedAt out of the appmap graph — never file mtime, which
// git restamps on every checkout. Prose-only maps predate the stamp and keep the plain badge.
function groundedBadge(a) {
  if (!a.grounded) return '';
  const when = a.groundedAt ? agoLabel(a.groundedAt) : '';

  return '<span class="badge g"' + (a.groundedAt ? ' title="grounded ' + esc(a.groundedAt) + '"' : '') +
    '>grounded' + (when ? ' ' + when : '') + '</span>';
}

// Bundle icons, local host only. A colo Mac's bundles are not on this disk and shipping icons
// over ssh is more plumbing than a list nicety earns; a web entry has no bundle at all. Both
// are skipped in silence.
const icons = new Map();       // name -> data URL, '' once the host has answered "none"
const iconPending = new Set(); // in flight, so every repaint does not re-ask

function appIconHtml(a) {
  if (host !== 'local' || a.kind === 'web') return '';
  const url = icons.get(a.name);

  // The empty span is a fixed-size placeholder so rows do not shift when the icon lands.
  return url ? '<img class="appicon" src="' + esc(url) + '" alt="">' : '<span class="appicon"></span>';
}

// Lazy, after the list paints: the lookup is one IPC per app and the first paint must not
// wait on sixty of them. Every outcome caches — a failure as "no icon" — so each name is
// asked about at most once per session and a missing icon can never break the list.
function requestIcons(entries) {
  if (host !== 'local' || !bus.appIcon) return;
  for (const a of entries) {
    if (a.kind === 'web' || icons.has(a.name) || iconPending.has(a.name)) continue;
    iconPending.add(a.name);
    bus.appIcon(a.name).then(
      (url) => { iconPending.delete(a.name); icons.set(a.name, url || ''); if (url) render(); },
      () => { iconPending.delete(a.name); icons.set(a.name, ''); },
    );
  }
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
    // data-u rides along for web entries so the URL is captured AT the click. The fresh entry
    // exists only in this markup — nothing else remembers what was typed once the box changes.
    '<li data-n="' + encodeURIComponent(a.name) + '"' + (a.kind === 'web' && a.url ? ' data-u="' + encodeURIComponent(a.url) + '"' : '') +
    ' class="' + (a.name === sel ? 'sel' : '') + '">' +
    appIconHtml(a) +
    '<span style="flex:1">' + esc(a.name) + '</span>' +
    (a.kind === 'web' ? '<span class="badge w">web</span>' : '') +
    groundedBadge(a) +
    (a.running ? '<span class="badge r">open</span>' : '') + '</li>').join('');
  for (const li of el('apps').children) {
    li.onclick = () => selectApp(decodeURIComponent(li.dataset.n), li.dataset.u ? decodeURIComponent(li.dataset.u) : undefined);
  }
  // Only what is on screen: names outside the filter are asked about when they first paint.
  requestIcons(hits);
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
  // Busy is PER HOST: a run on mac1 must not block a dispatch to mac2 or to this Mac — the
  // contention is one driver per machine, not one run per window. A busy host elsewhere is
  // the far side's lease to refuse; this only gates what this shell can already see.
  const hostBusy = !!running[host];
  el('go').disabled = hostBusy || !sel || !t || !!w || needsUrl;
  const site = selUrl();
  el('go').textContent = sel
    ? 'Run on ' + (site ? new URL(site).host : sel) + (host === 'local' ? '' : ' @ ' + host)
    : 'Run';
  // Grounding needs only a target — it explores the app, it does not perform a task.
  el('ground').disabled = hostBusy || !sel || needsUrl;
  // Stop follows the SELECTION: it ends the run whose output fills the pane on screen, so it
  // only shows when that pane has one. Other runs are stopped by selecting their app first.
  el('stop').style.display = paneRunHost() ? 'block' : 'none';
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
  schedulePaint();
}

// Whether the view is riding the bottom of the log. Autoscroll used to be unconditional,
// which made a live log unreadable: scroll up to see what step 6 did and the next line — a
// second later, for the whole run — yanks the view back down. Now scrolling away releases the
// pin and scrolling back to (near) the bottom re-arms it. The slack is one line's height-ish:
// "close enough to the bottom to mean 'following'".
let pinned = true;
function notePin() {
  const log = el('log');
  // Unlaid-out pane (first paint, fake DOM) measures 0/undefined everywhere; stay pinned.
  if (!log.clientHeight) { pinned = true; return; }
  pinned = log.scrollHeight - log.scrollTop - log.clientHeight <= 40;
}

// The pane is capped like the buffer always was. line() trims its array to LOG_LINES_KEPT,
// but nothing trimmed the DOM, so a 40-minute grounding pass grew it without bound and every
// append got costlier for the life of the run.
function trimLog() {
  const log = el('log');
  const over = log.children.length - LOG_LINES_KEPT;
  if (over <= 0) return;
  // The fold is one element holding many lines, and future foldable() calls append into it.
  // Removing it would detach them from the document silently, so it is never excess.
  const removable = [...log.children].filter(n => n !== foldEl);
  for (let i = 0; i < over && i < removable.length; i++) log.removeChild(removable[i]);
}

// One layout pass per animation frame instead of one per line. Reading scrollHeight forces a
// synchronous reflow, and the agent is chatty by design — per-line measuring turned a busy
// stretch into a stuttering window. Appends stay synchronous (order is preserved); only the
// measuring — trim and scroll — coalesces.
let paintQueued = false;
function schedulePaint() {
  // A hidden window gets no animation frames — Electron throttles rAF to zero — so during
  // exactly the workload the cap exists for (a 40-minute pass running while the operator does
  // something else) the queued paint never runs and appends grow the DOM without bound. Trim
  // synchronously once the pane is well past the cap; the deferred paint still handles the
  // common visible case without per-line reflow.
  if (el('log').children.length > LOG_LINES_KEPT * 2) trimLog();
  if (paintQueued) return;
  paintQueued = true;
  const paint = () => {
    paintQueued = false;
    trimLog();
    if (pinned) { const log = el('log'); log.scrollTop = log.scrollHeight; }
  };
  // The fake-DOM harness has no rAF; painting inline there keeps the behaviour observable.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(paint); else paint();
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
  // Before the failure bucket: the readiness refusal is the agent declining to guess at a
  // sign-in wall — expected and recoverable (the sign-in window opens itself), not a failure.
  else if (/^REFUSING TO RUN|sign-in needed/.test(text)) cls = 't-meta';
  else if (/✗|FAIL|WARNING|REFUS|error/i.test(text)) cls = 't-bad';
  else if (/^(stats|verification|home reset|target|task|loaded|recording|run log|visual judge)/.test(text)) cls = 't-meta';
  d.className = cls;
  d.textContent = text;
  const log = el('log');
  if (log.querySelector('.empty')) log.innerHTML = '';
  log.appendChild(d);
  schedulePaint();
}

/** Repaint the terminal from an app's stored scrollback. */
function renderLog(app) {
  const log = el('log');
  log.innerHTML = '';
  foldEl = null; foldCount = 0;
  // Switching apps means switching runs: follow the new one from its tail.
  pinned = true;
  const lines = app ? stateFor(app).log : [];
  if (!lines.length) { log.innerHTML = '<span class="empty">Output appears here.</span>'; return; }
  for (const t of lines) appendLine(t);
}

// 'owner' names whose terminal the text belongs to; the default is the selection, because
// every RUN line now arrives from the bus already carrying its app — with runs live on two
// hosts at once there is no single "the run in flight" to default to any more.
function line(text, owner) {
  owner = owner !== undefined ? owner : sel;
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

const bus = window.__bus;   // {onStarted,onLine,onHost,onDone,loadApps,loadState,saveState,run,stop}
bus.onStarted((d) => {
  // An accepted submit consumes the prompt. Cleared HERE and not at the click, because a
  // dispatch that fails answers an error string and never echoes 'started' — a refused task
  // stays in the box to be fixed rather than retyped. Matched against the echoed task so the
  // synthetic 'started' of a grounding pass or a followed job cannot wipe a prompt that was
  // typed but never run.
  if (d.app === sel && el('task').value.trim() === d.task) el('task').value = '';
  if (stateFor(d.app).task.trim() === d.task) stateFor(d.app).task = '';
  running[d.host] = d.app;
  check(); renderAttach(); paintStatus();
  // The previous refusal is answered by trying again, whatever the outcome of the retry.
  unready = null; unreadyGen++; renderUnready();
  // A new run replaces that app's terminal — unless the same app is still live on ANOTHER
  // host, whose transcript is in this buffer too and must not vanish mid-run. Buffers are
  // keyed by app, so two same-app runs share one; hostTag below keeps the interleave legible.
  if (!Object.keys(running).some(h => h !== d.host && running[h] === d.app)) {
    stateFor(d.app).log = [];
    if (d.app === sel) { el('log').innerHTML = ''; foldEl = null; foldCount = 0; }
  }
  line('▶ ' + d.task + '  —  ' + d.app + (d.host === 'local' ? '' : ' @ ' + d.host), d.app);
});
// Only while the app is genuinely live on more than one host: the common case (distinct
// apps) stays untagged, and the tag names which machine spoke when a buffer is shared.
function hostTag(app, host) {
  return Object.keys(running).filter(h => running[h] === app).length > 1 ? '[' + host + '] ' : '';
}
// The owner arrives WITH the line. Guessing it from a module variable was fine with one run;
// with one per host it would splice concurrent transcripts together.
bus.onLine((d) => line(hostTag(d.app, d.host) + d.text, d.app));
// 'auto' resolved to a machine: move the run's entry so the header, the busy check and the
// Stop button all name the Mac it actually occupies. At most one submit can sit unresolved
// under 'auto' at a time — the host-side busy check refuses a second while the first is.
if (bus.onHost) bus.onHost((d) => {
  if (running['auto'] === d.app) delete running['auto'];
  running[d.host] = d.app;
  check(); renderAttach(); paintStatus();
});
bus.onDone((d) => {
  // Tagged BEFORE the map entry goes: computed after, a shared buffer's finish line would
  // read as the only run the moment it stopped being one.
  const tag = hostTag(d.app, d.host);
  // d.host is the run's CURRENT name — resolved, if onHost ever fired — so this is the same
  // key onStarted/onHost left in the map.
  delete running[d.host];
  check(); renderAttach(); paintStatus();
  // Exit 3 is "needs a sign-in" — an expected, recoverable pause, not a failure, and the
  // sign-in window is about to open itself. Painting it as an error taught people to read
  // a routine first-run-on-a-Mac as something breaking.
  line(tag + (d.code === 0 ? '■ finished' : d.code === 3 ? '■ paused — sign-in needed' : '■ exited with code ' + d.code) + ' after ' + d.elapsed + 's', d.app);
  // 3 is the agent's "not at home, reason unknown" — the one exit code with a remedy a person
  // can act on from here. Everything else is a run that ran.
  unready = d.code === 3 ? { app: d.app, host: d.host, msg: null } : null;
  unreadyGen++;
  renderUnready();
  // A remote refusal with a known app goes straight to the sign-in window — the person was
  // just told the run needs one, and a button that says the same thing again is a step with
  // no decision in it. Local refusals keep the message only: the app is on this Mac, and
  // "put it back yourself" has no window to open.
  if (unready && unready.app && unready.host && unready.host !== 'local') runUnreadyFix();
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
  // Filed under the selection — this is about the window, not about whatever run is in flight.
  if (info && info.error) line('✗ hosts.json: ' + info.error, sel);
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
  let view, watchdog = null;
  try {
    // The race is what keeps 'probing' from latching true forever. A REJECTED probe already
    // released it via the finally, but a probe that never settles — one ssh wedged against a
    // Mac that answers TCP and nothing else — held it for the life of the window, and every
    // later 15s tick returned at the first line above. The panel froze on stale rows with no
    // error anywhere. Generous deadline: the point is only that it cannot be infinite.
    view = await Promise.race([
      bus.loadFleet(),
      new Promise((_, rej) => { watchdog = setTimeout(() => rej(new Error('fleet probe timed out')), 60000); }),
    ]);
  } catch (e) {
    view = { rows: [], offers: offers, error: errText(e) };
  } finally {
    if (watchdog !== null) clearTimeout(watchdog);
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
        // A sign-in, not a run: safe while the host is busy, and the only way past an app
        // that wants a human to type a password into it.
        '<button class="mini" data-signin="' + esc(r.name) + '"' + (signinBusy === r.name ? ' disabled' : '') + ' title="Open a sign-in window for this Mac">Sign in</button>' +
      '</div>' +
      // Management actions as plain buttons on their own line — a dropdown hid them behind a
      // click and an unlabeled ⋯. The destructive pair still confirm() before firing, and all
      // four disable while ANY action is mid-flight: they quit and delete things, and two at
      // once on different Macs is not worth the ambiguity in the one shared message slot.
      '<div class="factions">' +
        '<button class="mini" data-fact="signout" data-mac="' + esc(r.name) + '"' + (signinBusy ? ' disabled' : '') + '>Sign out' + (sel ? ' of ' + esc(sel) : '') + '…</button>' +
        '<button class="mini" data-fact="forget" data-mac="' + esc(r.name) + '"' + (signinBusy ? ' disabled' : '') + ' title="Forget the saved Screen Sharing password for this Mac (your local keychain)">Forget login</button>' +
        '<button class="mini" data-fact="install" data-mac="' + esc(r.name) + '"' + (signinBusy ? ' disabled' : '') + '>Install…</button>' +
        '<button class="mini" data-fact="delete" data-mac="' + esc(r.name) + '"' + (signinBusy ? ' disabled' : '') + '>Delete' + (sel ? ' ' + esc(sel) : '') + '…</button>' +
      '</div>' +
      (r.detail ? '<div class="fdetail">' + esc(r.detail) + '</div>' : '') +
      (r.reason ? '<div class="freason">' + esc(r.reason) + '</div>' : '') +
    '</div>').join('') +
    (signinMsg ? '<div class="' + (signinMsg.ok ? 'fdetail' : 'freason') + '">' + esc(signinMsg.text) + '</div>' : '');

  // Let a sign-in outcome survive two repaints (~30s at the probe cadence) and then retire it.
  if (signinMsg && ++signinMsg.paints >= 3) signinMsg = null;

  offers = view.offers || [];
  renderAttach();
}

/**
 * Offer to follow a run that is already going.
 *
 * This is what makes closing the window survivable: the job is a detached process on the
 * remote and its log is a file there, so the only thing a restart ever lost was the id — and
 * the busy fleet row carries it. Only jobs on hosts this shell already follows are hidden —
 * an operator mid-run on mac1 can still follow mac2, since each run's lines land in its own
 * app's pane now. (An 'auto' submit hides nothing until it resolves; following its own job
 * in that window is refused by the shell's per-host busy check, not by this filter.)
 */
function renderAttach() {
  const box = el('attach');
  const live = offers.filter(o => !dismissed.has(o.jobId) && !running[o.host]);
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
      // Disabled while its own flow is in flight: renderUnready() rebuilds this button on
      // every progress message, and a rebuilt-enabled button double-opens screen shares.
      ? '<button class="mini" data-fix="1"' + (unready.busy ? ' disabled' : '') + '>Open ' + esc(unready.host) + '</button>'
      : '');
}

async function loadCreds() {
  let c;
  try {
    c = await bus.loadCreds();
  } catch (e) {
    // This panel is what people open when a run cannot authenticate; a failure to read the
    // credentials must render as words there, not as an unhandled rejection and an empty fold.
    el('creds').innerHTML = '<div class="crow"><span class="bad">' + esc(errText(e)) + '</span></div>';

    return;
  }
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
    let r;
    try {
      r = await bus.saveKey(el('key').value);
    } catch (e) {
      r = { ok: false, error: errText(e) };
    }
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
let runsBusy = false;
// Per-stamp humanize state from the host, refreshed on the gallery's own cadence. Kept across
// a failed poll rather than reset, so an in-flight render does not flash back to a Render
// button for one tick and then forward again.
let hstates = {};

/**
 * Kick off the humanize pass for one card. The host's status map is authoritative for the
 * outcome; the local write below only bridges the gap until the next poll so the card reads
 * "rendering…" immediately instead of four seconds later.
 */
async function startHumanize(stamp, btn) {
  // Same double-click window as dispatchOnce: the IPC round trip is long enough to click
  // twice, and the second call would earn a pointless "already rendering" line.
  if (btn.disabled) return;
  btn.disabled = true;
  let err;
  try {
    err = await bus.humanize(stamp);
  } catch (e) {
    err = errText(e);
  }
  // A refusal (cap reached, bad stamp) is about THIS click, not about the run's stored state —
  // it lands in the log pane like every other refused dispatch does.
  if (err) line('✗ render human cursor: ' + err);
  else hstates[stamp] = { state: 'rendering' };
  loadRuns(true);
}

/**
 * When a run happened, as people say it: "2h ago", "yesterday", "Jul 28". Full precision
 * lives in the card's tooltip; this label is for scanning a column of cards. Null when the
 * input is empty or unparseable — no label beats "Invalid Date" in every card that predates
 * the field.
 *
 * The label goes deliberately stale between repaints: a redraw tears down any <video> mid-
 * playback, so "2h ago" ticking to "3h ago" is not worth interrupting the recording someone
 * is watching. It corrects itself whenever the gallery repaints for a real reason.
 */
function agoLabel(iso) {
  // '' rather than null on the empty/invalid path: both call sites — the grounded badge and
  // the gallery's recorded-at label — compose the result into markup strings.
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  // Fleet Macs' clocks can disagree by a little; a run "from the future" reads as fresh, not
  // as a negative number.
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  // Calendar days from local midnight, not 24h buckets: at 9am, "yesterday" has to mean
  // yesterday, and a run from 30 hours ago was.
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  if (Math.ceil((midnight.getTime() - d.getTime()) / 86400000) <= 1) return 'yesterday';
  return d.toLocaleDateString(undefined, d.getFullYear() === new Date().getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

async function loadRuns(force) {
  // Three callers race here — the 4s timer, the refresh button, onDone — and the host walks
  // every run log on disk to answer. Overlapping passes can resolve out of order and repaint
  // the OLDER answer over the newer, which right after a run finishes means the new recording
  // flashes in and vanishes until the next tick. One at a time; the next tick catches up.
  if (runsBusy) return;
  runsBusy = true;
  let runs;
  try {
    runs = await bus.loadRuns();
  } catch {
    // The gallery is a nicety — a failed rescan must not surface as an unhandled rejection
    // every 4 seconds. The next tick retries by construction.
    return;
  } finally {
    runsBusy = false;
  }
  // The render states ride the same tick. A thrown/missing humanizeStatus keeps the previous
  // map — the gallery is a nicety and must not surface a rejection every 4 seconds.
  try { hstates = (await bus.humanizeStatus()) || {}; } catch {}
  const box = el('runs');
  // Rebuilding innerHTML tears down any <video> mid-playback, and this runs on a timer —
  // so redraw only when the set of runs actually changed. Signature over ids, not the
  // whole payload: an in-flight run's log is rewritten as it goes. The humanized flag and the
  // render state are part of it because both change a card without changing the id — without
  // them a finished render would never repaint and the toggle would never appear.
  const sig = runs.map(r => r.id + (r.host || '') + (r.humanized ? '+h' : '') + ((hstates[r.id] || {}).state || '')).join('|');
  if (!force && sig === runSig) return;
  runSig = sig;

  if (!runs.length) { box.innerHTML = '<span class="empty">No recordings yet — tick “Record video”.</span>'; return; }

  // Preserve which cards were open across a redraw, so a new recording appearing does not
  // collapse the one being watched.
  const open = new Set([...box.querySelectorAll('.run')].filter(c => c.querySelector('video')).map(c => c.dataset.id));

  box.innerHTML = runs.map((r, i) => {
    const hs = hstates[r.id];
    const when = agoLabel(r.startedAt);
    // esc() everywhere, not a bare '<' swap: the task text is arbitrary user input landing in
    // markup, and data-id sits inside a quoted attribute where an unescaped quote breaks out.
    return '<div class="run" data-i="' + i + '" data-id="' + esc(r.id) + '">' +
      '<div class="task">' + esc(r.task) + '</div>' +
      '<div class="meta">' +
        '<span>' + esc(r.app) + '</span>' +
        // Only fleet runs are tagged. Badging local ones too would erase the distinction the
        // badge exists to draw.
        (r.host ? '<span class="badge r">' + esc(r.host) + '</span>' : '') +
        '<span class="' + (r.success ? 'ok' : 'bad') + '">' + (r.success ? '✓' : '✗') + ' ' + r.verified + '/' + r.actions + '</span>' +
        '<span>' + r.elapsedSec + 's</span>' +
        '<span>' + r.grounding + '</span>' +
        (r.visual ? '<span>judge ' + r.visual + '</span>' : '') +
        // NOT part of the redraw signature: ids are stable and a run's start time never
        // changes, so its arrival cannot be what a repaint waits on. See agoLabel for why
        // the label is allowed to go stale between repaints.
        (when ? '<span title="' + esc(new Date(r.startedAt).toLocaleString()) + '">' + esc(when) + '</span>' : '') +
      '</div>' +
      // A card with a humanized render offers it in the player (see attach); one without
      // offers to make it. Both never at once — the button's absence IS the "done" signal.
      (!r.humanized
        ? '<div class="hrow">' +
            (hs && hs.state === 'rendering'
              ? '<span>rendering human cursor…</span>'
              : '<button class="mini" data-render="1">' + (hs && hs.state === 'failed' ? 'Retry human cursor' : 'Render human cursor') + '</button>') +
            // The one line the controller kept from the child's output — the diagnosis
            // (missing motion constants, no trajectory turns, no frames), not a stack trace.
            (hs && hs.state === 'failed' ? '<div class="hfail">' + esc(hs.error || 'render failed') + '</div>' : '') +
          '</div>'
        : '') +
    '</div>';
  }).join('');

  const attach = (card, r, autoplay) => {
    const v = document.createElement('video');
    // The humanized render is the artifact this gallery exists to show once it exists; the
    // raw cursor-less capture stays one toggle away rather than becoming unreachable.
    let showing = r.humanized ? 'h' : 'raw';
    v.src = bus.videoUrl(showing === 'h' ? r.humanized : r.video);
    v.controls = true; v.autoplay = autoplay; v.loop = true; v.muted = true;
    card.appendChild(v);
    if (!r.humanized) return;
    const t = document.createElement('div');
    t.className = 'vtoggle';
    const paint = () => {
      t.innerHTML = '<button class="mini' + (showing === 'h' ? ' on' : '') + '" data-v="h">Humanized</button>' +
        '<button class="mini' + (showing === 'raw' ? ' on' : '') + '" data-v="raw">Raw</button>';
    };
    paint();
    t.onclick = (e) => {
      const b = e.target.closest ? e.target.closest('button[data-v]') : null;
      if (!b || b.dataset.v === showing) return;
      showing = b.dataset.v;
      v.src = bus.videoUrl(showing === 'h' ? r.humanized : r.video);
      // Swapping src resets the element to paused; resuming is what makes this read as a
      // toggle rather than a reload. play() can reject (autoplay policy), and an unhandled
      // rejection on every toggle is not worth the pause it reports.
      if (v.play) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
      paint();
    };
    card.appendChild(t);
  };

  // Load the mp4 only when a card is opened; autoloading every one would fetch the lot.
  for (const card of box.children) {
    const r = runs[Number(card.dataset.i)];
    if (open.has(card.dataset.id)) attach(card, r, false);
    const rb = card.querySelector('button[data-render]');
    if (rb) rb.onclick = () => startHumanize(r.id, rb);
    card.onclick = (e) => {
      if (e.target.tagName === 'VIDEO') return;   // clicking the player is not a toggle
      // Buttons inside the card (Render, Humanized/Raw) act on the run, not on whether the
      // card is open — their clicks bubble here and must not close the player under them.
      if (e.target.closest && e.target.closest('button')) return;
      const existing = card.querySelector('video');
      if (existing) {
        existing.remove();
        // The toggle exists only to steer the player; it leaves with it.
        const t = card.querySelector('.vtoggle');
        if (t) t.remove();
        return;
      }
      attach(card, r, true);
    };
  }
}

// check() too: a typed-URL selection reads through the box (typedUrl), so editing it can
// change what Run would dispatch — the button must not keep a label the box no longer backs.
el('q').addEventListener('input', () => { render(); check(); });
// Same coverage as the task box: 'input' alone misses paste and IME paths, and the Run button
// must not stay enabled next to a URL that will be refused.
for (const ev of ['input', 'change', 'keyup', 'paste']) el('url').addEventListener(ev, () => setTimeout(() => { check(); saveSoon(); }, 0));
// 'input' alone misses programmatic setValue and some IME/paste paths, which left the
// Run button enabled next to a visible "this will be refused" warning. 'change' catches
// the stragglers; the server re-checks regardless.
for (const ev of ['input', 'change', 'keyup', 'paste']) el('task').addEventListener(ev, () => setTimeout(() => { check(); saveSoon(); }, 0));
// Enter dispatches, like a chat box: the task is one goal sentence and the Run button now
// lives a column away under the app list. Shift+Enter keeps its newline for the rare
// multi-line prompt. check() first because the disabled flag is otherwise a keystroke stale
// — the input listeners above defer through setTimeout.
el('task').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  e.preventDefault();
  check();
  if (!el('go').disabled) el('go').onclick();
});
/**
 * Dispatch exactly once per click.
 *
 * 'running' only flips when the host echoes 'started', and getting there is an IPC round trip
 * plus a process spawn — long enough to click twice. The second click reached a controller
 * that had not registered the first run yet, so both dispatched, and two driver sessions kill
 * each other (LIMITATIONS §6). Disabling on the click closes the window; check() afterwards
 * restores the true state, which for a run that did start means staying disabled.
 */
async function dispatchOnce(id, send) {
  const b = el(id);
  if (b.disabled) return;
  b.disabled = true;
  let err;
  try {
    err = await send();
  } catch (e) {
    // An IPC rejection is a run that did not start; without this it was an unhandled
    // rejection and a button disabled until something else happened to call check().
    err = errText(e);
  }
  if (err) line('✗ ' + err);
  check();
}

el('go').onclick = () => dispatchOnce('go', () =>
  bus.run({ app: sel, task: el('task').value.trim(), record: el('record').checked, humanize: el('human').checked, noVision: el('novision').checked, host: host, url: selUrl() }));
// A humanized render is a render OF the recording, so the pair moves together: ticking Human
// cursor turns recording on, and turning recording off takes the render request with it.
el('human').addEventListener('change', () => { if (el('human').checked) el('record').checked = true; });
el('record').addEventListener('change', () => { if (!el('record').checked) el('human').checked = false; });
// A stop that could not be delivered must land in the pane: silence here is an operator
// watching a run they believe they ended. The button stays up — the run really is still going.
// It stops the run owning the SELECTED pane, which is the only run whose output is on screen.
el('stop').onclick = async () => {
  const target = paneRunHost();
  if (!target) return;
  let err;
  try {
    err = await bus.stop(target);
  } catch (e) {
    err = errText(e);
  }
  if (err) line('✗ stop failed: ' + err);
};
el('refresh').onclick = () => loadRuns(true);
el('ground').onclick = () => dispatchOnce('ground', () => bus.ground(sel, host, selUrl()));
// loadApps too: the list is per-host, so switching machines must re-ask rather than leave the
// previous Mac's inventory on screen looking like this one's.
el('host').onchange = () => { host = el('host').value; bus.saveHostPref(host); check(); loadApps(); };
// The refresh lives inside the fold's <summary>; without the preventDefault every probe
// click would also toggle the fold shut.
el('fleetrefresh').onclick = (e) => { if (e && e.preventDefault) { e.preventDefault(); e.stopPropagation(); } loadFleet(); };
// Delegated for the same reason the offer list is: these buttons are rebuilt on every probe.
// The selected app rides along so the Mac opens with it already in front of you.
el('fleet').onclick = async (e) => {
  const b = e.target.closest ? e.target.closest('button[data-signin]') : null;
  if (!b || signinBusy) return;
  // b.disabled alone does not survive the repaint two lines down — the row is rebuilt from
  // markup. signinBusy is what keeps the rebuilt button disabled until the flow settles.
  b.disabled = true;
  signinBusy = b.dataset.signin;
  signinMsg = { ok: true, text: 'opening ' + b.dataset.signin + '…', paints: 0 };
  loadFleet();
  let r;
  try {
    r = await bus.signin(b.dataset.signin, sel || undefined);
  } catch (err) {
    r = { ok: false, message: errText(err) };
  }
  signinBusy = null;
  signinMsg = { ok: r.ok, text: r.message, paints: 0 };
  loadFleet();
  if (!r.watch) return;
  // The wait leg, fire-and-forget: it resolves when a person finishes an SSO round trip —
  // minutes — and closes the sign-in window (the portal, or the screen share) for them.
  // Without it a portal opened from this button would sit open until its lifetime lapsed.
  let done;
  try {
    done = await bus.signinWait(r.watch.host, r.watch.app);
  } catch (err) {
    done = { ok: false, message: errText(err) };
  }
  signinMsg = { ok: done.ok, text: done.message, paints: 0 };
  loadFleet();
};
// The management buttons under each Mac. Delegated for the same reason the Sign in handler
// is: the rows are rebuilt on every probe. Outcomes land TWICE on purpose — the ✓/✗-prefixed
// transient under the panel (which retires after a few repaints), and a durable copy in the
// log pane — because "did it actually complete" was exactly the question the transient alone
// left open. signinBusy gates re-entry: these actions quit and delete things, and two at once
// on different Macs is not worth the ambiguity in the one shared message slot.
//
// The destructive pair (signout, delete) go through confirm() naming exactly what will be
// removed: the click opens the dialog, and only the dialog fires the verb — nothing
// destructive happens from a single interaction.
el('fleet').addEventListener('click', async (e) => {
  const b = e.target.closest ? e.target.closest('button[data-fact]') : null;
  if (!b || signinBusy) return;
  const mac = b.dataset.mac, act = b.dataset.fact;
  const say = (ok, text) => { signinMsg = { ok: ok, text: text, paints: 0 }; loadFleet(); };
  const ask = async (progress, send) => {
    signinBusy = mac;
    say(true, progress);
    let r;
    try { r = await send(); } catch (err) { r = { ok: false, message: errText(err) }; }
    signinBusy = null;
    // The confirmation the transient cannot give on its own: an explicit verdict mark, and a
    // durable line in the pane that survives the panel's repaints.
    say(r.ok, (r.ok ? '✓ ' : '✗ ') + r.message);
    line((r.ok ? '✓ ' : '✗ ') + r.message, null);
  };
  if (act === 'forget') return ask('forgetting the saved screen-share login for ' + mac + '…', () => bus.forgetVnc(mac));
  if (act === 'install') {
    const name = prompt('App to install on ' + mac + ' (bundle name):', sel || el('q').value.trim());
    if (!name || !name.trim()) return;
    const url = prompt('https URL of its .dmg or .zip (it downloads on ' + mac + '):');
    if (!url || !url.trim()) return;
    return ask('installing ' + name.trim() + ' on ' + mac + ' — the download happens over there and can take minutes…', () => bus.appInstall(mac, name.trim(), url.trim()));
  }
  // The two destructive verbs need a target, and the selection is it — same source of truth
  // the Sign in button rides along.
  if (!sel) return say(false, '✗ pick an app in the list first — ' + (act === 'signout' ? 'sign-out' : 'delete') + ' needs a target');
  if (act === 'signout') {
    if (!confirm('Sign out of ' + sel + ' on ' + mac + '?\n\nDeletes YOUR ' + sel + ' data on that Mac: the live copy if you own it, plus your parked profile. Other operators keep theirs.')) return;
    return ask('signing out of ' + sel + ' on ' + mac + '…', () => bus.authClear(mac, sel));
  }
  if (act === 'delete') {
    if (!confirm("Delete " + sel + ".app from " + mac + "?\n\nRemoves the app bundle, its live app data, and EVERY operator's parked " + sel + " profile on that Mac.")) return;
    return ask('deleting ' + sel + ' from ' + mac + '…', () => bus.appDelete(mac, sel));
  }
});

// The embedded sign-in view covers the page below the header, so its one control lives in
// the header: cancel closes the view, the tunnel, and the engine on the far Mac.
if (bus.onPortal) bus.onPortal((d) => {
  const b = el('cancelsignin');
  b.style.display = d.open ? 'inline-block' : 'none';
  if (d.open) b.textContent = '✕ cancel sign-in — ' + d.app + ' @ ' + d.host;
});
el('cancelsignin').onclick = async () => {
  let r;
  try {
    r = await bus.cancelSignin();
  } catch (err) {
    r = { ok: false, message: errText(err) };
  }
  if (r && r.message) line((r.ok ? '· ' : '✗ ') + r.message, null);
};
/**
 * The unready remedy, end to end: open the sign-in (the host side opens the liveview portal
 * window when the runner can spawn one, and falls back to full-desktop screen sharing when it
 * cannot), then wait for the app to reach home and clear the panel. One function because it
 * has two callers — the panel's button, and the automatic path in onDone that fires the
 * moment a remote run refuses for want of a sign-in.
 */
async function runUnreadyFix() {
  if (!unready || unready.busy) return;
  const target = { app: unready.app, host: unready.host };
  // The generation this flow owns. A new run or a newer refusal bumps unreadyGen, and every
  // write below re-checks it first: a signinWait leg resolving minutes later must not
  // reinstate a panel about a refusal the operator has already moved past.
  const gen = unreadyGen;
  const owns = () => unreadyGen === gen;
  const show = (msg, busy) => { unready = { app: target.app, host: target.host, msg: msg, busy: busy }; renderUnready(); };
  show('opening ' + target.host + '…', true);
  let r;
  try {
    r = await bus.signin(target.host, target.app || undefined);
  } catch (err) {
    r = { ok: false, message: errText(err) };
  }
  if (!owns()) return;
  // Still busy while the wait leg runs: the screen share is open and a second Open would
  // stack another viewer on top of it.
  show(r.message, !!r.watch);
  loadFleet();
  if (!r.watch) return;

  // Resolves when a person finishes signing in, which can be minutes. The panel clears itself
  // on success: the machine is ready and there is nothing left here to act on.
  let done;
  try {
    done = await bus.signinWait(r.watch.host, r.watch.app);
  } catch (err) {
    done = { ok: false, message: errText(err) };
  }
  if (!owns()) return;
  if (done.ok) { unready = null; renderUnready(); line('✓ ' + done.message); }
  else show(done.message, false);
  loadFleet();
}
el('unready').onclick = (e) => {
  const b = e.target.closest ? e.target.closest('button[data-fix]') : null;
  if (b) runUnreadyFix();
};
// Delegated: the offer list is rebuilt on every probe, so per-button handlers would be
// re-bound fifteen times a minute for the life of a grounding pass.
el('attach').onclick = async (e) => {
  const b = e.target.closest ? e.target.closest('button') : null;
  if (!b) return;
  if (b.dataset.dismiss) { dismissed.add(b.dataset.dismiss); renderAttach(); return; }
  if (!b.dataset.follow) return;
  let err;
  try {
    err = await bus.attach(b.dataset.host, b.dataset.follow, b.dataset.app);
  } catch (e) {
    err = errText(e);
  }
  if (err) line('✗ ' + err);
};

// Recordings also arrive from headless ./run invocations and other sessions, so the
// gallery cannot rely on the in-UI done event alone. Cheap poll: loadRuns() only
// redraws when the set of run ids changes, so this is a directory stat most ticks.
setInterval(() => loadRuns(false), 4000);

// Last chance to persist: a pending saveSoon() would die with the window. saveState is
// send-not-invoke precisely so it survives being called here.
window.addEventListener('beforeunload', flush);

// Passive: this fires on every wheel tick mid-scroll and must never be able to block one.
el('log').addEventListener('scroll', notePin, { passive: true });

// Restore first so the shell opens on the app you were last driving; loadApps() either way,
// since an unreadable state file must not leave the list empty.
restore().then(loadApps, loadApps);
// Independent of restore(): an unreadable ui-state.json must not cost the host selector, which
// is the one control that decides whether a click runs here or on another machine. Loud on
// failure — a silent catch here looks exactly like having no fleet.
loadHostList().catch((e) => line('✗ host list: ' + errText(e)));
loadRuns();
</script>`;

/** Full standalone document; `bootstrap` installs window.__bus before the app script runs. */
export const page = (bootstrap: string): string =>
	`${CHROME}\n<script>${bootstrap}</script>\n<script>${APP_JS}</script>\n`;
