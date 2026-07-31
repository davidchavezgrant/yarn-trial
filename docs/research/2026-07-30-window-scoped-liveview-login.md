# Window-scoped live-view login

Design + build notes. 2026-07-30. Built in worktree `liveview-login`.

## What this is

A second way to get a human-completed sign-in onto a fleet Mac, alongside the existing
full-desktop screen share (`src/remote/signin.ts`). The teammate opens a **URL in their own
browser**, sees **only the window being signed into**, drives it (mouse + keyboard), and closes
the tab. The session lands in the app's own storage exactly as it does today; nothing here
stores a credential or shows one to a model.

It exists because the conversation that led to it landed on three constraints at once:

1. **Runs must use the teammate's own data**, not a service account's and not mine. So the
   teammate is the human who logs in — this is the mechanism by which *their* identity, and only
   theirs, establishes the session. (This is why the "demo account + credential vault" path,
   sketched in `2026-07-30-cloud-vm-authentication-brief.md` as "E", is the wrong tool here: E
   holds a stored secret to log in unattended; "their data" forbids holding their secret.)
2. **Screen sharing "isn't tenable"** as the everyday flow — a VNC client into the whole console
   desktop. A URL that shows one window is the lighter thing.
3. **Both grades of "window-scoped" were wanted**: focus (the teammate shouldn't have to see or
   navigate the rest of a shared Mac's desktop) *and* capture isolation (only the target
   window's pixels should ever leave the Mac).

## The one idea that makes it simple: capture the window natively, and the two grades collapse

Cropping a full-desktop VNC stream would give focus (Grade 1) but not isolation — the whole
desktop's pixels still cross the wire, cropped in the browser. Capturing a **single window** with
ScreenCaptureKit gives both at once: SCK composites only that window's surface, so no other
window's pixels are ever in a frame we could encode (Grade 2), and the viewer therefore shows
only that window (Grade 1). One mechanism, both goals. The desktop-crop path is kept in mind only
as a fallback for moments SCK can't isolate a window; it isn't built, because the native path
covered the requirement.

## The one idea that makes OAuth-with-a-browser work for free: follow the key window

A login is exactly the flow that hands off between windows — "Sign in with Google" launches a
browser (on native apps, an `ASWebAuthenticationSession` agent in a *separate process*), the
human logs in there, focus returns to the app. If the stream were pinned to the app's window by
pid, the teammate would watch a frozen app while the real login happened in an invisible window.

So the engine **tracks whatever window is frontmost**, re-resolving it every 250ms and rebuilding
the capture when the key window changes. The Google popup becomes frontmost → the stream follows;
focus returns → it follows back. No per-app OAuth detector, and it catches the native
separate-process auth agent that a pid-pinned follow would miss entirely. A caller can still
`pin` a specific window id to refuse to ever switch (e.g. to guarantee the desktop is never
shown).

## Shape

```
teammate's browser  ──ws──►  Node server (liveview-server.ts)  ──stdin JSONL──►  native/liveview (Swift)
   <canvas>         ◄─ws──   (RFC6455, hand-rolled)            ◄─fd3 frames───   SCK capture + CGEvent inject
                                                               ◄─stdout events─
```

- **`native/liveview.swift`** — the only part that must be native. Single-window SCK capture,
  CGWindowList enumeration (no TCC needed for geometry), CGEvent input injection. Persistent
  process; line-command protocol on stdin; `"F" <uint32 BE len> <jpeg>` frames on fd 3; typed
  JSON events on stdout. Same "why a sidecar" reasoning as `native/axdom.swift` — the C APIs are
  unreachable from Node, Swift needs CLT only to build, a separate process buys hang isolation.
- **`src/liveview.ts`** — the pure, unit-tested half: the frame parser (`"F"` framing is the
  off-by-one-prone part), the event parser, and viewport-fraction input translation. The contract
  is that **nothing above the engine speaks pixels** — the viewer reports a click as a fraction of
  the rendered image, the engine maps that fraction onto the current window bounds, so window
  switches and tab resizes never need renegotiation. Clamped to [0,1] so a drag leaving the image
  can't inject onto the desktop behind the window.
- **`src/liveview-ws.ts`** — a minimal RFC 6455 codec (accept-key hash, unmasking client frames,
  the three length forms). Hand-rolled rather than adding `ws`, because the repo keeps to two
  runtime deps and the viewer needs a fraction of a WebSocket library. The fiddly pure parts are
  unit-tested against the RFC's own canonical vectors.
- **`src/liveview-server.ts`** — HTTP + upgrade + engine-per-connection bridge. I/O; smoke-tested,
  not unit-tested.
- **`src/liveview-viewer.ts`** — the dependency-free vanilla-JS viewer, as a string.
- **`src/liveview-cli.ts`** — `./run liveview [<mac>] ["App"]`. Local mode runs the server here;
  fleet mode prints the `ssh -L` tunnel because the engine must run where the window is.

## Security posture (stated plainly, matching `team.ts`'s candor)

- The link carries a random token in the path; without it the server serves nothing and refuses
  the upgrade. This stops a curious local process, not a determined attacker on the wire.
- Binds to **127.0.0.1** by default. The teammate reaches a fleet Mac's viewer over an **SSH
  port-forward**, so the stream (a human typing a password) never crosses the network
  unencrypted — the SSH tunnel is the transport security, the same way the runner's UDS leans on
  SSH for auth. `--lan` exists for a quick same-network demo and is gated because a raw `ws://`
  login stream on the LAN is a credential-adjacent leak.
- The engine injects real input as the console user; whoever holds the token can drive that Mac.
  Treat the URL like a password.
- **The stream is never persisted or logged.** It carries a human typing a password. The server
  forwards bytes and forgets them. The demo *recording* is a separate capture that starts after
  login — this stream is transient.

## What is verified, and what is not (measurement honesty, per the repo's rule)

**Verified on this machine (macOS 26.2, Swift 6.2, Apple Silicon):**
- `native/liveview` compiles clean and runs.
- `follow` enumerates the frontmost window and emits correct geometry (tested against a real
  multi-monitor setup — negative coordinates confirmed the fraction-mapping was the right call).
- End-to-end smoke: HTTP server → token-gated WS handshake → engine spawn → window event →
  **valid JPEG frames streaming** (12 frames in 3.5s at 5fps; first frame confirmed `ff d8` JPEG
  magic). Full path works.
- **Input injection actually lands in a real app** (`src/liveview-e2e.mts`, 2026-07-30). Injected
  a marker string via the engine's `text` command into a fresh TextEdit document and read it back
  out via AppleScript — the characters arrived. Finding worth keeping: AppKit auto-capitalized the
  leading character ("liveview" → "Liveview"), which is proof the keystrokes went through the real
  text system, and a reminder that a naive exact-match test would false-fail. Password fields
  disable auto-capitalization, so live logins are unaffected; the harness now compares
  case-insensitively.
- **Window-follow switches on a frontmost-app change** (same harness). Bringing Calculator forward
  after TextEdit produced a fresh `window` event naming Calculator. This is the same switch a
  "Sign in with Google" popup causes, so the OAuth-handoff mechanism is confirmed at the
  window-tracking level (a real Google popup, end to end, is still on the list below).
- 32 unit tests (`liveview.test.ts` 22, `liveview-ws.test.ts` 10) pass, including the byte-boundary
  frame reassembly and the RFC 6455 canonical accept-key vector. Full suite: 649 pass / 0 fail.
- Typecheck clean.

**Verified on the fleet (mac1, macOS 15.5, over SSH, 2026-07-30):**
- **The Swift engine compiles clean on macOS 15.5**, not just the newer local 26.2 — the SCK APIs
  used are available on the fleet's actual OS. Same 128 KB binary.
- **CGWindowList enumerates windows with NO grant** — 12 windows listed from a plain SSH shell,
  confirming the design choice to use it for window-follow selection so the engine can still name a
  target and emit a precise error when capture is denied. (The frontmost were Yarn / Google Chrome
  / Hex Fiend / System Settings — a real working desktop.)
- **The TCC constraint is real and the engine handles it correctly.** An engine spawned from a bare
  SSH shell emits the typed `no-screen-recording` error ("The user declined TCCs for … capture")
  every tick, rather than crashing or hanging — which is exactly what the typed error path exists
  for. Confirmed the runner (`com.yarn.runner` = Electron `--serve`, pid 49262) is the
  TCC-responsible process, so the engine **must be spawned by the runner**, the same way the
  recording capture already is. The CLI's fleet output now says this explicitly, and building the
  runner verb is the top item under "next steps".

**NOT yet verified (needs the runner verb and/or a human login):**
- **Capture/injection under the runner on the fleet.** Confirmed to work locally (this terminal
  holds the grants) and confirmed to correctly REFUSE from an SSH shell (no grant); the middle case
  — spawned by the runner, which does hold the grants — needs the serve.ts verb below.
- **A real OAuth handoff end to end** — the window-follow switch is confirmed locally, but an actual
  "Sign in with Google" flow (app → external browser → complete login → back) has not been driven
  through the viewer.
- **Native `ASWebAuthenticationSession`** capture — asserted to work (normal on-screen window in a
  separate process that `frontmostWindow()` selects; cross-app-switch follow is confirmed), but the
  specific auth-session case is untested.
- **The `ssh -L` tunnel** serving the viewer to a remote browser end to end.
- Performance/latency of interactive typing at 15fps over a real tunnel.

**The one architectural change the fleet run forced:** fleet mode cannot be "SSH in and run
`./run liveview`" — the engine has to be launched by the runner (a new `serve.ts` verb, e.g.
`liveview`, parallel to the existing `signin` verb) so TCC attributes correctly. Local mode is
unaffected.

**That verb is now built** (2026-07-31):
- `serve.ts` gains a `liveview` verb that mirrors `signin` — lease checked-not-taken, profile
  swapped to the operator, app foregrounded — then spawns the liveview server as a
  runner-descended detached child (via `resolveRunCommand`/`childEnv`, the same path the agent and
  the `axdom` sidecar use to inherit the runner's TCC grants). It returns `{port, token, url,
  maxLifetimeSec}`.
- The server (`liveview-server.ts`) grew a detached-child lifecycle: a caller-pinned token, a
  20-minute max-lifetime ceiling, and a 30s idle-after-close exit, so a walked-away sign-in cannot
  leave a capture-capable server (and an injectable window) listening. The decision logic is the
  pure, unit-tested `lifecycleVerdict`.
- `ctl.ts` learns the verb; `liveview-cli.ts` fleet mode now actually calls it over SSH and prints
  the real `ssh -L` tunnel + `http://127.0.0.1:PORT/?t=TOKEN` URL from the reply.
- `openApp` was made injectable in `ServeOptions` so the verb (and, incidentally, `signin`) is
  unit-testable without launching a real app.

Tested: 4 new runner-verb tests (returns port+token and spawns the server; refuses when a run
holds the lease; refuses + does not spawn when the profile swap fails; requires an app) + 8
lifecycle tests. Full suite 664 pass / 0 fail; typecheck clean; native builds on mac1 (macOS 15.5).

**The one thing still unverified, and why:** confirming a *runner-spawned* engine actually captures
on the fleet requires restarting the live `com.yarn.runner` so it loads the new `serve.ts`. That is
shared fleet state (a running Mac other people use), so it was NOT done without sign-off. Everything
up to it is verified: the SSH-spawned engine is *denied* capture (measured), the runner is the
grant-holder (measured), and a runner-spawned child inherits grants by the same mechanism the agent
already relies on. The remaining step is: deploy via `./run provision`, restart the runner, and run
one real login — a deploy + restart, not new code.

## How this composes with what exists

- It's a **peer of `signin.ts`, not a replacement.** signin.ts (full-desktop screen share)
  remains the fallback for anything this can't show cleanly, and for operators who prefer a VNC
  client. Both leave the session in the app's own storage; both keep credentials out of the loop.
- **Web/Electron vs native.** SCK capture + frontmost-follow is surface-agnostic — a Chrome tab,
  an Electron window, and a native Cocoa window are all just windows. So the login half works for
  all three. (The *driving* half after login is unchanged and out of scope here — native still
  needs the activation-policy fix from `2026-07-30-native-mac-apps-investigation.md`, and native
  session *persistence* still has the login-keychain gap documented in `runner/profiles.ts`.)
- It does **not** change the login *count*: a session is still established per Mac. One login for
  the whole fleet would need the consented session-distribution ("session as artifact") spine,
  which is a separate build and gated on the Step-0 transfer-survival measurement.

## Fleet deploy + live verification (2026-07-31)

Deployed to all three Macs via `./run provision` (every step green), restarted each runner onto
the new `serve.ts`, and built `native/liveview` on each. Then called the `liveview` verb for real:

- **mac1: full capture confirmed.** The runner-spawned engine streamed valid JPEG frames
  (41,831-byte first frame, `ff d8` magic) — where a bare-SSH-spawned engine got
  `no-screen-recording`. TCC grant inheritance through the runner works. By timing luck the
  frontmost window was a **Google "Sign in - Google Accounts"** page (the fresh profile made Yarn
  open its OAuth flow), so the OAuth-handoff follow was captured live on real hardware — the exact
  case the design targets, with no per-app detector.
- **mac2 & mac3: verb works; capture returned zero frames, for a legitimate reason.** CGWindowList
  showed **zero normal foreground windows** on those two (Yarn running but presenting no window;
  screens not locked). The engine correctly captures nothing when nothing is frontmost — not a
  defect. mac1 differed only because Yarn had a live window.

Two findings from the live run:
1. **Port-in-use guard (fixed).** A second `liveview` while one is already serving used to spawn a
   second server that died on `EADDRINUSE`. The verb now checks the port first (before the profile
   swap, so a duplicate call cannot quit the app out from under an in-progress sign-in) and reports
   the existing server instead. Tested.
2. Dev-path server trees (`npm → tsx → node`) are harder to reap than packaged; the
   max-lifetime/idle-exit deadlines cover normal use. Left as-is.

Fleet left clean: davidgrant restored as Yarn owner on all three, throwaway `verify` profiles and
job logs removed, no stray processes.

## Next steps to make it real

1. **One real end-to-end login** on a Mac that has a foreground app window: open the tunnel, sign
   in through the viewer, confirm input actuates and the session persists. Everything mechanical
   around this is now proven on the fleet; the remaining unknown is the human keystroke path over
   the tunnel.
2. Confirm the native `ASWebAuthenticationSession` case (a native app's "Sign in with Apple/Google"
   sheet) is followed and captured.
3. If injection latency at 15fps is poor over the tunnel, raise `--fps`/`--quality` or move to a
   delta encoder (out of scope for the POC).

Built and fleet-deployed: the `liveview` runner verb (with port-in-use guard), the detached-server
lifecycle, the CLI fleet flow, the login/recording mutual-exclusion guard, and `native/liveview`
on all three Macs (macOS 15.5) — all with tests. Runner-spawned capture verified on mac1.
