# Liveview transport: CDP screencast for Chromium targets — decision + rejected alternatives

Decision record. 2026-07-31, worktree `screencast-liveview`. Context: the window-scoped
sign-in feature (`docs/research/2026-07-30-window-scoped-liveview-login.md`,
`src/remote/liveview.ts`). Two alternatives were evaluated and NOT chosen; this writes down
why, so the reasoning survives the people who did it.

## The decision

For Chromium targets — anything the `cdp` backend can reach: its own launched Chrome, or an
Electron app relaunched with `--remote-debugging-port` — liveview's remote sign-in leg
streams **CDP `Page.startScreencast` frames** through the existing token-gated viewer and
injects input via **`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`**, instead of
ScreenCaptureKit window capture + CGEvent injection.

Why:

- **Page-scoped by construction.** The foreign-window crop / settling / `framesAllowed`
  machinery in the SCK engine exists for exactly one reason: to keep non-auth content out of
  a captured window's frames. A page stream has no outside-the-page to leak — the entire
  problem class disappears rather than being mitigated.
- **Input is target-scoped.** No CGEvent, so injection doesn't move the machine's real
  cursor, works with the window occluded or backgrounded, and matches the CDP-first backend
  direction set 2026-07-31 (see the Backends section of CLAUDE.md and
  `docs/research/2026-07-30-cua-learnings-for-real-implementation.md`).
- **Transport rides the SSH story we already have.** Chrome binds the debug port
  localhost-only, so tunneling is mandatory — and the host-key-pinned `ssh.ts` tunnel is
  already the security model for everything else crossing to a fleet Mac. Nothing new to
  secure.
- **One viewer, two engines.** The viewer's fraction-based input contract (see the
  `src/remote/liveview.ts` header — nothing above the engine speaks pixels) is
  transport-agnostic, so the SCK and CDP engines sit behind the same viewer and the same
  token-gated WS bridge.

**SCK stays.** The Swift engine remains the fallback and the ONLY path for: native windows
and dialogs (the external-protocol "Open Yarn.app" sheet, passkey / Touch ID / WebAuthn
prompts, TCC dialogs), hardened Electron apps that strip `--remote-debugging-port` (the
Figma-style argv-sanitize pattern), and any non-Chromium browser leg.

Two caveats, stated up front:

- **Security.** A raw tunneled debug port is whole-browser control — every tab, the
  profile's cookies, `Runtime.evaluate`. If least-privilege ever matters, the bridge should
  allowlist `Page.screencast*` / `Input.*` on one targetId and refuse everything else.
- **Operational precondition, unverified.** The OAuth handoff opens the DEFAULT browser. For
  the browser leg to be CDP-visible, the fleet Macs' default browser must be the backend's
  debug-flagged persistent-profile Chrome. Not yet verified on the fleet as of this writing.

## Rejected: client-side DOM reconstruction (rrweb-style mirroring)

Serialize the DOM server-side, rebuild and render it in the teammate's browser, send
interactions back. Rejected for five reasons, in descending severity:

1. **Login pages are the adversarial worst case for DOM serialization.** Cross-origin
   iframes (SSO buttons, hCaptcha/Turnstile) are walled off by the same-origin policy.
   CAPTCHAs render to canvas *deliberately* so that serialization yields an empty tag.
   Closed shadow roots and WebAuthn dialogs are invisible. The one page class this feature
   exists for is the one the technique handles worst.
2. **Reconstruction needs the page's subresources.** Fetching CORS- and cookie-gated
   stylesheets, fonts, and images means proxying authenticated requests with the session's
   cookies — a credential-bearing proxy, built to support a rendering optimization.
3. **The uncanny valley of interactivity.** A replica that LOOKS like a live page sets
   native-latency expectations it can't meet. Either every effect round-trips (~100ms focus
   rings read as broken) or you build optimistic local echo plus reconciliation — OT-style
   state sync, where the replica can visibly disagree with server truth in a password field.
4. **Fidelity errors land in the highest-stakes place.** The user aims clicks and types
   secrets by what they see; 20px of layout drift misdirects real input. A pixel stream is
   ground truth by construction.
5. **Cost/benefit.** Bidirectional DOM mirroring is the core IP of co-browsing vendors,
   versus one CDP command that ships in every Chrome.

Principle worth recording: **replicating STATE is hard (sync, security, fidelity);
replicating OUTPUT is easy.** Same reason the mutation journal diffs observed values instead
of trusting the model's claims.

## Deferred: WebRTC tab capture (explicit revisit trigger below)

`chrome.tabCapture` or `getDisplayMedia` with auto-accept flags: the browser hardware-encodes
the tab as VP8/VP9/H.264 and ships it over WebRTC media transport. Strictly better output
under MOTION — delta-compressed video vs a full JPEG per frame, 30–60fps vs screencast's
ack-throttled ~10–20, adaptive bitrate, jitter buffering. Not adopted now:

- A sign-in session is a mostly-static page (two fields, three clicks), and screencast's
  static-content behavior — no change, no frames, near-zero bandwidth — is exactly right
  for it.
- Capture must be initiated from inside the browser (an extension or companion page),
  versus one CDP command on a connection we already hold.
- WebRTC wants UDP plus signaling — a second transport plane next to the SSH/TCP story
  `ssh.ts` already secures.
- Input returns over CDP regardless, so it's two channels where screencast needs one.
- The UX metric that dominates here — input echo latency — is unchanged by the codec.
  Client-side cursor rendering and local key feedback buy more than frame rate.

**Trigger for revisiting:** a real sign-in flow with sustained motion (long scrolling consent
pages, animated verification) where the viewer visibly stutters. That is the moment WebRTC
pays; until then it's cost without benefit.

Insight to keep: remote-UX has two independent axes — **output smoothness** (codec/fps, what
WebRTC improves) and **input responsiveness** (echo round-trip, what local prediction
improves) — and users weight the second far higher.
