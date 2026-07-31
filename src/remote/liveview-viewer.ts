// liveview-viewer — the single-page browser viewer, as a string.
//
// Kept as a TS module (not a static .html file) so the server has nothing to resolve on disk and
// the whole feature ships as compiled JS — the same self-contained instinct as the rest of the
// repo. It is intentionally dependency-free vanilla JS: a login viewer that pulls a framework
// off a CDN would both add a failure mode and, on a corporate network, a data-egress question.
//
// What it does: connects the WebSocket, paints incoming JPEG frames onto a <canvas>, and reports
// pointer/keyboard events back AS FRACTIONS of the rendered image (never pixels — see liveview.ts
// for why).
//
// The page is a NATURAL OVERLAY, not a panel (set by David 2026-07-31: the bordered card with a
// title bar, status line and hint strip read as "something we dumped on top" inside the shell —
// and a second pass removed the hints entirely: "it should feel like we own the window").
// The only painted things are the stream itself — floating with a shadow on the shell-matched
// background — a dismiss button hanging off its corner, and a toast that speaks ONLY when
// something is wrong (errors with remedies, disconnection) or decisive ("signed in — closing",
// an auto-press). Live and healthy shows NOTHING but the window, ever.

/**
 * What the page sets `document.title` to when the operator dismisses it. The embedded
 * WebContentsView deliberately gets no preload and no IPC (it streams a machine a human is
 * typing a password into), so the title is the one channel the shell can watch — see
 * electron/main.ts, which retires the panel and tears the session down when this appears.
 */
export const VIEWER_DISMISS_TITLE = "liveview:dismiss";

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
     app's background, so the same pixels stop looking like a fault. With no border and no bar,
     that colour match is the whole trick: the page has no visible edge of its own, so the
     stream reads as a window floating on the shell. */
  html, body { margin: 0; height: 100%; background: #16181d; color: #ddd; font: 13px/1.5 -apple-system, system-ui, sans-serif; }
  #stage { height: 100%; display: flex; align-items: center; justify-content: center; overflow: hidden; position: relative; }
  /* The LOCAL cursor stays — it is the operator's only pointer feedback, since the remote one
     is no longer composited into the stream (cfg.showsCursor = false). 'default' rather than
     'crosshair': this is a login form to click and type in, not a canvas to aim at, and an
     arrow is what every other window on their screen shows.
     No background on the canvas itself: an unpainted canvas should show the stage through it,
     not a black rectangle sized to the last frame. The shadow is deep on purpose — with the
     panel chrome gone it is the only thing saying "this floats". */
  canvas { max-width: 100%; max-height: 100%; cursor: default; border-radius: 6px; box-shadow: 0 8px 40px #000a, 0 2px 12px #0008; transition: opacity .18s ease; }
  /* Hidden, not absent: keeping it laid out means the first painted frame does not reflow. */
  canvas.settling { opacity: 0; }
  /* Anchored to the STREAM's corner by script (placeClose), not the page's: the dismiss belongs
     to the floating window, and in a letterboxed pane the page corner can be nowhere near it.
     Top-RIGHT because the remote window's own traffic lights are top-left — ours must never
     sit over the button that closes the remote app. */
  #close { position: absolute; top: 0; right: 0; width: 26px; height: 26px; border-radius: 50%; border: 1px solid #ffffff22; background: #000a; color: #cfd3da; font: 15px/24px -apple-system, system-ui, sans-serif; text-align: center; cursor: pointer; padding: 0; }
  #close:hover { background: #000d; color: #fff; border-color: #ffffff44; }
  /* One pill for everything the old status bar said, floating over the stream's lower edge.
     pointer-events: none — a message must never eat a click aimed at the window behind it. */
  #toast { position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); max-width: 82%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: #000b; border: 1px solid #ffffff1a; border-radius: 999px; padding: 5px 14px; color: #c8cdd6; opacity: 0; transition: opacity .25s ease; pointer-events: none; }
  #toast.show { opacity: 1; }
  #toast.err { color: #ff9bbd; border-color: #ff9bbd44; }
  #settle { position: absolute; display: none; flex-direction: column; align-items: center; gap: 10px; color: #8b93a1; }
  #settle.on { display: flex; }
  #spin { width: 22px; height: 22px; border: 2px solid #333a45; border-top-color: #7aa2f7; border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div id="stage">
  <canvas id="c" class="settling" width="800" height="600"></canvas>
  <!-- Spinner only, no caption. "framing the sign-in window…" explained a wait the operator
       has no decision to make about. A bare spinner reads as "working" without asking to
       be read. -->
  <div id="settle" class="on"><div id="spin"></div></div>
  <button id="close" title="End this sign-in session" aria-label="End this sign-in session">&#10005;</button>
  <div id="toast"></div>
</div>
<script>
(() => {
  const token = ${JSON.stringify(token)};
  const DISMISS_TITLE = ${JSON.stringify(VIEWER_DISMISS_TITLE)};
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const toastEl = document.getElementById('toast');
  const closeEl = document.getElementById('close');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + location.host + '/?t=' + token);
  ws.binaryType = 'arraybuffer';

  let imgW = 800, imgH = 600;         // last known rendered image size (canvas pixels)

  // The one voice the page has. Transient by default (the old status bar was a permanent
  // fixture saying "live", which is exactly the chrome this page no longer has); sticky is for
  // states the operator must not miss looking away — errors, disconnection, the sign-in landing.
  let toastTimer;
  const toast = (msg, opts) => {
    const o = opts || {};
    toastEl.textContent = msg;
    toastEl.className = 'show' + (o.err ? ' err' : '');
    clearTimeout(toastTimer);
    if (!o.sticky) toastTimer = setTimeout(() => { toastEl.className = toastEl.className.replace('show', ''); }, 4000);
  };

  // The dismiss hangs just off the stream's top-right corner, clamped inside the page. Placed
  // by measurement because the canvas is centred and CSS-scaled — its box moves with every
  // resize and every crop change.
  const placeClose = () => {
    const r = canvas.getBoundingClientRect();
    closeEl.style.top = Math.max(6, r.top - 13) + 'px';
    closeEl.style.right = Math.max(6, (window.innerWidth - r.right) - 13) + 'px';
  };
  window.addEventListener('resize', placeClose);

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

  // Set on the ✕ so the socket dying reads as "you ended this", not as a fault.
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    // Order matters: the title first (the shell acts on it and removes this view — anything
    // after may never run there), then the socket (the server tears the engine down on the
    // close frame), then the tab-case fallbacks.
    document.title = DISMISS_TITLE;
    try { ws.close(); } catch {}
    toast('session ended — you can close this tab', { sticky: true });
    window.close();
  };
  closeEl.addEventListener('click', dismiss);

  ws.onclose = () => { if (!dismissed) toast('disconnected', { err: true, sticky: true }); };
  ws.onerror = () => { if (!dismissed) toast('connection error', { err: true, sticky: true }); };

  ws.onmessage = (e) => {
    if (typeof e.data === 'string') { handleEvent(JSON.parse(e.data)); return; }
    // Binary: a JPEG frame.
    const blob = new Blob([e.data], { type: 'image/jpeg' });
    createImageBitmap(blob).then((bmp) => {
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width; canvas.height = bmp.height;
        placeClose();
      }
      imgW = bmp.width; imgH = bmp.height;
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      if (!painted) {
        painted = true;
        setSettling(false);
        placeClose();
        // No hint, no greeting (set by David 2026-07-31: "it should feel like we own the
        // window"). Esc and ⌘] still work — they are documented in the CLI's own help text,
        // not on the stream.
      }
    });
  };

  function handleEvent(ev) {
    if (ev.ev === 'window') {
      // The engine's flag only ever RE-arms the wait (a handoff to a new browser window starts
      // settling again). It cannot clear it — only a painted frame does, above: the engine
      // says frames are allowed a moment before one actually arrives, and revealing an empty
      // canvas in that gap is the flash this whole mechanism exists to remove.
      // No hop toast either: a hop repaints the entire stream, which is its own announcement.
      if (ev.settling) { painted = false; setSettling(true); }
    }
    else if (ev.ev === 'auto') { toast('pressed “' + ev.pressed + '” for you'); }
    // The sign-in landed and the server is about to close this. Say so plainly: a stream that
    // simply stops looks like a crash, and the teammate is left wondering whether it took.
    else if (ev.ev === 'home') { dismissed = true; toast('✓ signed in — closing', { sticky: true }); }
    else if (ev.ev === 'error') { toast(ev.remedy || ev.detail || ev.kind, { err: true, sticky: true }); }
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
