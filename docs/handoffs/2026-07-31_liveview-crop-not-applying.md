# Handoff: the sign-in live view still shows the whole Chrome window

**RESOLVED 2026-07-31** — root cause: Chromium builds its web-content AX tree **lazily**, and
READING the tree is not what wakes it. A fresh Chrome process (which is what a fleet Mac
launches for every OAuth leg) exposes no `AXWebArea` at all — 37 chrome-only nodes — no matter
how many times a trusted client walks it. The wake is an app-element attribute WRITE:
`AXEnhancedUserInterface` (what VoiceOver sets — the one Google Chrome honors) or
`AXManualAccessibility` (the CEF/Electron equivalent — what axdom relies on; Chrome ignores it).
Measured A/B on virgin `--user-data-dir` Chromes at accounts.google.com: no wake after 8s of
reads; no wake after 8s with only `AXManualAccessibility`; web area up 2s after
`AXEnhancedUserInterface`. Chrome returns `-25208 notImplemented` for the set *and wakes
anyway* — the write is processed as a client announcement, so the return code must be ignored.

This also resolves the two mysteries below: the crop "worked locally" because a daily-driven
Chrome has long been woken by some AX client (the wake latches for the process lifetime), and
axdom "worked on the fleet" because its targets are Electron apps and it already sets
`AXManualAccessibility` (axdom.swift:39). The leading hypothesis (TCC attribution) was wrong:
the runner-spawned engine reports `AXIsProcessTrusted=true` and, once the tree is awake, scans
Chrome fine.

Fix: `wakeBrowserAX()` in `native/liveview.swift` — both attributes, once per pid, on the scan
queue before the first walk. Plus a startup `{"ev":"ax","trusted":…}` event so trusted-vs-asleep
is never ambiguous again. Verified live on mac2 (runner-spawned engine, real Google OAuth leg):
`scan source:none` at t+0, `source:"ink" leaves:23 web:1739x855 ink:1000x474` at t+2s, frame
snapshot shows the "Choose an account" card with all browser chrome cropped away.

The dead-ends list below is kept for its measurement value.

**Original status**: unsolved after three attempts. Each attempt fixed a real, separately-verified bug —
none of them was *this* bug. Read "What is already ruled out" before forming a theory; the
value in this document is mostly the list of dead ends.

**Branch**: `worktree-liveview-crop-jobs`, merged to `main` through `37cb355`. Fleet is
deployed and restarted at that commit.

---

## The symptom

Sign in to Yarn on a fleet Mac (`mac2` is David's test host). When the OAuth handoff reaches
Google, the embedded viewer shows the **entire Chrome window** — tab strip, URL bar, the lot —
instead of just the login card.

The most recent screenshot (2026-07-31 02:40) is the sharpest evidence available, and it
narrows the fault a long way:

- The viewer's own title bar reads **"Google Chrome — Untitled"** and status **"live"**.
- Frames are arriving and the stream is healthy.

So: the engine IS following Chrome, it HAS classified it as foreign (that title only renders
from a `window` event), and it is streaming — **but no crop is being applied**. The bug is
downstream of window-follow and upstream of the encoder: the AX scan is returning nothing
usable, or `cropFraction()` is rejecting what it returns.

The desired output is `docs/` reference image: just the "Choose an account" card, filling the
frame, no browser chrome.

---

## Where the code lives

| Concern | File |
|---|---|
| Capture, AX scan, crop, input injection | `native/liveview.swift` (the engine) |
| Engine spawn + event/frame parsing | `src/remote/liveview.ts` |
| WS server bridging engine ↔ viewer | `src/remote/liveview-server.ts` |
| Browser viewer (canvas, input) | `src/remote/liveview-viewer.ts` |
| Runner verb that spawns it on a fleet Mac | `src/remote/runner/serve.ts` (`liveview`, `liveview-stop`) |
| Portal: tunnel, embedded view, lifecycle | `src/ui/ui-signin.ts` + `electron/main.ts` |

The crop path, in order:

1. `frontmostWindow()` — picks the window. Restricted to the target app or a browser.
2. `scheduleForeignScan()` — every 500ms while following a *foreign* window, off the main queue.
3. `axWindowElement(pid:matching:)` — finds the AX window matching the streamed CGWindow.
4. `scanForeignWindow(_:appName:)` — largest `AXWebArea`, then the union of `INK_ROLES` inside it.
5. `applyScan(...)` — prefers ink + padding over web area, stores it in **global points**.
6. `cropFraction()` — converts to fractions against live bounds; gates on ≥200×160pt.
7. `stream(_:didOutputSampleBuffer:...)` — crops the CGImage before JPEG encode.
8. `globalPoint(fx:fy:)` — remaps input fractions onto the crop.

---

## What is already ruled out (do not re-investigate)

Every one of these was *measured*, not reasoned about.

1. **The crop math is correct.** Captured real frames locally against
   `accounts.google.com` through the engine: the crop lands on the card, chrome gone. Frames
   are in the job tmpdir history; reproduce with the probe script below.
2. **`AXWebArea` exists and is reachable.** Chrome exposes two — the page at depth 8
   (748×812) and a degenerate 0×0 at depth 11. `AXManualAccessibility` is **not** required
   (tested before/after: identical). First-match DFS used to pick the 0×0 one; now largest-wins.
3. **The node budget was too small** (900 → 12000). The real web area sits behind ~30 groups.
4. **Ink detection is the right target.** Web area 748×812 vs ink union 468×488 — the web
   area alone still framed mostly empty page.
5. **The white screen was the tunnel, not the crop.** `ssh -L` inherits `ControlMaster=auto`
   from `sshArgv`; with a master socket already open (the 15s fleet poll keeps one), ssh
   REFUSES the forward while the local port still accepts and resets. Fixed in `tunnelArgv`
   (`ControlPath=none`, `ExitOnForwardFailure=yes`) — verified ECONNRESET → HTTP 200.
6. **A stale local `ssh -L` holding port 7682** produces the same symptom. `freeLocalPort`
   now runs before every spawn and on teardown.
7. **System Settings stealing the stream.** `frontmostWindow()` accepted any layer-0 window;
   macOS raises "Login Items & Extensions" when a browser first launches. Now restricted.
8. **The deploy is real.** Binary md5 matches local, `LIVEVIEW_APP` is in both source and
   `dist-electron`, runner uptime confirms restarts (Yarn and the machines are untouched —
   only the runner bounces, which is correct and sufficient).

---

## The leading hypothesis (untested)

**The runner-spawned engine cannot read Chrome's accessibility tree, while a locally-spawned
one can.**

This is the one difference between the environment where the crop demonstrably works (my Mac,
engine spawned from a terminal) and where it demonstrably fails (fleet, engine spawned by the
runner). It fits every observation: capture works (Screen Recording is granted), window-follow
works (CGWindowList needs no grant at all), and only the AX-dependent step silently produces
nothing.

Measured supporting fact: an engine spawned from a **bare SSH shell** on mac1 reports
`AXIsProcessTrusted=false` and `axWindows=DENIED` for every app. The runner is supposed to fix
this by being the responsible process — but *whether that inheritance actually reaches the
engine for a THIRD-PARTY app's tree* has never been verified. Reading your own app's tree and
reading Chrome's are different permissions questions.

**How to test it decisively**: the engine already emits a `scan` event
(`{"ev":"scan","source":"ink|webarea|none","leaves":N,"web":"WxH","ink":"WxH"}`) on every scan
whose shape changes. Attach to a live session and read it:

- `source:"none"`, `web:"nil"` → the AX scan found nothing → **hypothesis confirmed**, it is a
  permissions/attribution problem, not geometry.
- `source:"webarea"`, `leaves:0` → AX works but ink detection fails → geometry problem.
- No `scan` event at all → `scheduleForeignScan` is not running (check `foreign` is true and
  `targetApp` is non-empty in the engine's env).

If confirmed, the fix direction is TCC attribution for the engine binary — likely signing it,
or having the runner pass its own AX-trusted context differently. `native/axdom.swift` reads
Chromium trees successfully **on the fleet** and is spawned the same way; diffing how it is
launched vs the liveview engine is the fastest lead. That axdom works is the strongest
counter-evidence to this hypothesis, so check it early — it may falsify the whole theory.

---

## Reproducing, without a human at the Mac

The hard constraint: the OAuth leg needs a real click on "Continue with Google". `open -b
com.google.Chrome` over SSH does not reliably launch-and-raise (macOS refuses
background-initiated foregrounding), and Chrome is often not even running on mac2.

Working probe scripts (recreate under `$CLAUDE_JOB_DIR/tmp`):

```ts
// Start a session on mac2 and print the token.
import { loadHosts, resolveHost } from "src/remote/control/hosts.js";
import { lastFrame, runnerArgv, runSsh } from "src/remote/control/ssh.js";
const h = resolveHost("mac2", loadHosts());
await runSsh(h, runnerArgv("liveview-stop"), { timeoutMs: 20000 });
const f = lastFrame((await runSsh(h, runnerArgv("liveview",
  { app: "Yarn", operator: "davidgrant" }), { timeoutMs: 90000 })).stdout);
console.log("TOKEN", f?.token);
```

Then a minimal RFC6455 client through the tunnel prints every engine event and saves frames.
**Critical**: `lsof -ti tcp:7682 | xargs kill -9` before connecting, or a stale forward gives
ECONNRESET and you will misdiagnose it as a server fault (this cost an hour).

To read a session David has open, pull the token from the running process rather than
preempting him:

```sh
p=$(lsof -ti tcp:7682 | head -1); ps eww -p $p | tr ' ' '\n' | grep '^LIVEVIEW_TOKEN='
```

The runner's `liveview` verb foregrounds the target app on every call, so a session you start
yourself will follow Yarn, not Chrome. You need Chrome frontmost *after* the session is up.

---

## Rules that constrain the fix

- **No table of known apps.** Names are parameters. `LOGIN_HOST_APPS` lists browser *engines*,
  which is the closest thing to an exception and should not grow into a vendor list.
- **No provider detection.** No URL matching, no page fingerprinting. The mechanism must stay
  "is this the target app" + "where is the ink".
- **Fail to no-crop, never a wrong crop.** Uncropped is the old behavior; a wrong crop maps
  clicks onto the wrong pixels.
- **Never log or persist frames.** They carry a human typing a password.
- Do not force-restart a runner while a job is in flight; `--restart` refuses for a reason.

---

## If the hypothesis is wrong

The other live possibility is that Chrome's AX tree differs on the fleet Macs — different
Chrome version, or a profile with different flags. `axprobe2`/`axprobe4`-style scripts (role
census and web-area enumeration in DFS order, see git history of this doc's sibling research
file) can be compiled and run **on mac2** to compare against the local measurements quoted
above. That is a direct A/B and worth doing before any speculative fix.
