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
  html, body { margin: 0; height: 100%; background: #111; color: #ddd; font: 13px/1.5 -apple-system, system-ui, sans-serif; }
  #wrap { display: flex; flex-direction: column; height: 100%; }
  #bar { padding: 6px 12px; background: #1c1c1e; border-bottom: 1px solid #333; display: flex; gap: 12px; align-items: center; }
  #bar b { color: #fff; font-weight: 600; }
  #status { color: #9a9; }
  #status.err { color: #f6a; }
  #stage { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  canvas { max-width: 100%; max-height: 100%; cursor: crosshair; background: #000; box-shadow: 0 0 40px #0008; }
  kbd { background:#333; border-radius:3px; padding:0 4px; }
</style>
</head>
<body>
<div id="wrap">
  <div id="bar">
    <b id="title">Connecting…</b>
    <span id="status">opening the window stream</span>
    <span style="margin-left:auto;color:#666">click the window to focus it, then type your login · <kbd>Esc</kbd> stays in the app</span>
  </div>
  <div id="stage"><canvas id="c" width="800" height="600"></canvas></div>
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
    });
  };

  function handleEvent(ev) {
    if (ev.ev === 'window') { titleEl.textContent = (ev.app || 'window') + (ev.title ? ' — ' + ev.title : ''); setStatus('live'); }
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
