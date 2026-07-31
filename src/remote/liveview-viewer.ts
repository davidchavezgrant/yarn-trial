// liveview-viewer — the single-page browser viewer, as a string.
//
// Kept as a TS module (not a static .html file) so the server has nothing to resolve on disk and
// the whole feature ships as compiled JS — the same self-contained instinct as the rest of the
// repo. It is intentionally dependency-free vanilla JS: a login viewer that pulls a framework
// off a CDN would both add a failure mode and, on a corporate network, a data-egress question.
//
// What it does: connects the WebSocket, paints incoming JPEG frames onto a <canvas>, and reports
// pointer/keyboard events back AS FRACTIONS of the rendered image (never pixels — see liveview.ts
// for why). It shows a status line driven by the engine's typed events, so a missing Screen
// Recording grant reads as an instruction rather than a black rectangle.

export function viewerHtml(token: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — window view</title>
<style>
  :root { color-scheme: dark; }
  /* #16181d, not #111/#000: this page is embedded in the Electron shell, and the letterbox
     around a crop that does not share the pane's aspect ratio is unavoidable — a 768x258 login
     form in a tall pane HAS empty space above and below it. Pure black read as broken video
     (reported 2026-07-31 as "those black bars"); the shell's own surface colour reads as the
     app's background, so the same pixels stop looking like a fault. */
  html, body { margin: 0; height: 100%; background: #16181d; color: #ddd; font: 13px/1.5 -apple-system, system-ui, sans-serif; }
  /* A bordered panel, because the host no longer gives this the whole window: it floats over
     the shell, and without an edge a dark panel on a dark shell has no boundary at all. The
     radius cannot round the WebContentsView itself (it is a native layer with square corners),
     so the border is what draws the line. */
  #wrap { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; border: 1px solid #2c313c; }
  #bar { padding: 6px 12px; background: #1c1c1e; border-bottom: 1px solid #333; display: flex; gap: 12px; align-items: center; }
  #bar b { color: #fff; font-weight: 600; }
  #status { color: #9a9; }
  #status.err { color: #f6a; }
  /* 6px, not 10: the host now sizes this view to the card rather than to the whole window, so
     the padding is a hairline around the stream instead of a margin inside a large empty pane. */
  #stage { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; padding: 6px; box-sizing: border-box; position: relative; }
  /* The LOCAL cursor stays — it is the operator's only pointer feedback, since the remote one
     is no longer composited into the stream (cfg.showsCursor = false). 'default' rather than
     'crosshair': this is a login form to click and type in, not a canvas to aim at, and an
     arrow is what every other window on their screen shows.
     No background on the canvas itself: an unpainted canvas should show the stage through it,
     not a black rectangle sized to the last frame. */
  canvas { max-width: 100%; max-height: 100%; cursor: default; border-radius: 6px; box-shadow: 0 2px 24px #0006; transition: opacity .18s ease; }
  /* Hidden, not absent: keeping it laid out means the first painted frame does not reflow. */
  canvas.settling { opacity: 0; }
  #settle { position: absolute; display: none; flex-direction: column; align-items: center; gap: 10px; color: #8b93a1; }
  #settle.on { display: flex; }
  #spin { width: 22px; height: 22px; border: 2px solid #333a45; border-top-color: #7aa2f7; border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  kbd { background:#333; border-radius:3px; padding:0 4px; }
</style>
</head>
<body>
<div id="wrap">
  <div id="bar">
    <b id="title">Connecting…</b>
    <span id="status">opening the window stream</span>
    <span style="margin-left:auto;color:#666">click the window to focus it, then type your login · <kbd>Esc</kbd> stays in the app · <kbd>⌘]</kbd> next page</span>
  </div>
  <div id="stage">
    <canvas id="c" class="settling" width="800" height="600"></canvas>
    <!-- Spinner only, no caption. "framing the sign-in window…" explained a wait the operator
         has no decision to make about, and the status line in the bar already carries the
         state for anyone who wants it. A bare spinner reads as "working" without asking to
         be read. -->
    <div id="settle" class="on"><div id="spin"></div></div>
  </div>
</div>
<script>
(() => {
  const token = ${JSON.stringify(token)};
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const statusEl = document.getElementById('status');
  const titleEl = document.getElementById('title');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + location.host + '/?t=' + token);
  ws.binaryType = 'arraybuffer';

  let imgW = 800, imgH = 600;         // last known rendered image size (canvas pixels)
  const setStatus = (t, err) => { statusEl.textContent = t; statusEl.className = err ? 'err' : ''; };

  // The canvas stays hidden until the first frame ARRIVES, independent of the engine's own
  // settling flag. Two different waits look the same to the operator — "no frame yet" and
  // "frames withheld until the crop lands" — and both must show the spinner rather than a
  // stale or empty canvas. The engine withholds foreign frames itself (framesAllowed), so a
  // frame reaching us is already proof it is safe to show.
  let painted = false;
  const settleEl = document.getElementById('settle');
  const setSettling = (on) => {
    canvas.classList.toggle('settling', on);
    settleEl.classList.toggle('on', on);
  };

  ws.onopen = () => setStatus('connected — waiting for the first frame');
  ws.onclose = () => setStatus('disconnected', true);
  ws.onerror = () => setStatus('connection error', true);

  ws.onmessage = (e) => {
    if (typeof e.data === 'string') { handleEvent(JSON.parse(e.data)); return; }
    // Binary: a JPEG frame.
    const blob = new Blob([e.data], { type: 'image/jpeg' });
    createImageBitmap(blob).then((bmp) => {
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width; canvas.height = bmp.height;
      }
      imgW = bmp.width; imgH = bmp.height;
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      if (!painted) { painted = true; setSettling(false); setStatus('live'); }
    });
  };

  function handleEvent(ev) {
    if (ev.ev === 'window') {
      titleEl.textContent = (ev.app || 'window') + (ev.title ? ' — ' + ev.title : '');
      // The engine's flag only ever RE-arms the wait (a handoff to a new browser window starts
      // settling again). It cannot clear it — only a painted frame does, above: the engine
      // says frames are allowed a moment before one actually arrives, and revealing an empty
      // canvas in that gap is the flash this whole mechanism exists to remove.
      if (ev.settling) { painted = false; setSettling(true); setStatus('framing'); }
      else if (painted) setStatus('live');
    }
    else if (ev.ev === 'auto') { setStatus('pressed \u201c' + ev.pressed + '\u201d for you'); }
    else if (ev.ev === 'error') { setStatus(ev.remedy || ev.detail || ev.kind, true); }
  }

  const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  // Pointer -> window fraction. The canvas is drawn at its intrinsic pixel size but CSS-scaled
  // to fit; getBoundingClientRect gives the on-screen box, so we normalise against that.
  function frac(e) {
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  canvas.addEventListener('mousedown', (e) => { const f = frac(e); send({ cmd:'mouse', type:'down', x:f.x, y:f.y, button: e.button===2?'right':'left' }); e.preventDefault(); });
  canvas.addEventListener('mouseup',   (e) => { const f = frac(e); send({ cmd:'mouse', type:'up',   x:f.x, y:f.y, button: e.button===2?'right':'left' }); e.preventDefault(); });
  canvas.addEventListener('mousemove', (e) => { const f = frac(e); send({ cmd:'mouse', type:'move', x:f.x, y:f.y, button:'left' }); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => { const f = frac(e); send({ cmd:'scroll', x:f.x, y:f.y, dy: -Math.round(e.deltaY), dx: -Math.round(e.deltaX) }); e.preventDefault(); }, { passive:false });

  // Keyboard: translate the browser event into the macOS virtual keycode the engine wants.
  // Printable characters go via the unicode 'text' path (no per-key table); named keys use a
  // small map of the ones a login needs (Tab/Return/Delete/arrows/Esc).
  const NAMED = { 'Enter':36, 'Tab':48, 'Backspace':51, 'Escape':53, 'ArrowLeft':123, 'ArrowRight':124, 'ArrowDown':125, 'ArrowUp':126, ' ':49 };
  window.addEventListener('keydown', (e) => {
    // Let the browser keep its own shortcuts (reload, devtools) — only forward when the canvas
    // is the focus of the login, which for a viewer is "always while this tab is active".
    if (e.metaKey && (e.key === 'r' || e.key === 'R')) return;
    // cmd+] — show me a different page. The CDP engine streams the newest page, which is a
    // heuristic, and on mac3 (2026-07-31) it lost: a blocking enterprise interstitial sat
    // behind the redirect page that opened after it, unreachable and invisible. This is the
    // way out of any such pick. The SCK engine has no pages and ignores it.
    if (e.metaKey && e.key === ']') { send({ cmd:'follow' }); e.preventDefault(); return; }
    if (e.key in NAMED) { send({ cmd:'key', down:true, code:NAMED[e.key], flags:flags(e) }); send({ cmd:'key', down:false, code:NAMED[e.key], flags:0 }); e.preventDefault(); return; }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) { send({ cmd:'text', s:e.key }); e.preventDefault(); }
    // cmd+V etc. would need clipboard bridging; a login rarely pastes, and the engine's 'text'
    // path already handles a pasted value if the viewer wires a paste handler (below).
  });
  window.addEventListener('paste', (e) => {
    const t = (e.clipboardData || window.clipboardData).getData('text');
    if (t) { send({ cmd:'text', s:t }); e.preventDefault(); }
  });
  function flags(e) { let f = 0; if (e.shiftKey) f |= 0x20000; if (e.metaKey) f |= 0x100000; if (e.altKey) f |= 0x80000; if (e.ctrlKey) f |= 0x40000; return f; }
})();
</script>
</body>
</html>`;
}
