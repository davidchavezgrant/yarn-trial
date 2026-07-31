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

---

**Implemented 2026-07-31** (branch `screencast-engine`): `src/remote/liveview-cdp.ts` —
`connectCdpEngine()` behind the same `EngineHandle` seam as the SCK engine (which gained a
transport-neutral `onExit`; `child` is now optional). Selection is three-state and CDP-first:
AUTO (the default) probes the debug endpoint once at CLI start and streams over screencast
when it answers, SCK otherwise; `--cdp [url]` / `--sck` force a transport (flag > env
`LIVEVIEW_TRANSPORT=auto|cdp|sck` > auto; `LIVEVIEW_CDP_URL` names the endpoint, unset
`CDP_PORT`/9222). Fleet-wired the same day: the choice rides the liveview verb's spec to the
runner, which sets the env for the CLI it spawns and reports the requested transport in its
reply.

**Endpoint-hopping (2026-07-31, branch `endpoint-hopping`)**: the CDP engine now follows the
flow through target space, where the SCK engine follows it through screen space. Every
`BrowserContext` is watched for new pages — newest page wins the stream, a closing page pops
back to the most recent still-open one (the pure `FollowStack` in liveview-cdp.ts; the
deep-link return to the app page IS the pop) — and a second, OPTIONAL browser endpoint is
attached lazily (`LIVEVIEW_BROWSER_CDP_URL`, default `CDP_PORT`/9777 — the cdp backend's
web-Chrome port; silent means re-probe on an interval, never an error). So auto/cdp follows
the external-browser OAuth handoff WHEN the browser endpoint answers — which requires the
fleet Mac's default browser to be the debug-flagged Chrome; provisioning for that is landing
separately. onExit still fires only on primary-endpoint death; the browser leg dying just
pops the follow stack. Native dialogs and passkey sheets remain SCK territory — force
`--sck` for those.

**Validated live 2026-07-31** — the transport mechanics, end to end on a real Chrome
(local, `./run liveview --cdp`, viewer driven by a real browser; every assertion
machine-checked against the target's own `/json/list` titles, not eyeballed):

1. frames: viewer canvas painted the screencast, title bar tracked the page;
2. click: viewer fraction → `Input.dispatchMouseEvent` → page handler fired;
3. typing: text commands → `insertText` → input value landed intact ("hello cdp");
4. same-endpoint hop: `window.open` popup took the stream (title bar followed), a click
   through the viewer closed it, and the stream POPPED BACK to the opener;
5. cross-endpoint hop: a second Chrome launched on 9777 mid-session was lazily attached
   and its newest EXISTING page taken (the page predates the attach — the case a
   page-event listener alone would miss forever);
6. endpoint death: killing the 9777 Chrome popped the stream back to the primary, and a
   further click proved the popped-back session live, not a stale frame.

What this does NOT yet prove: a real OAuth sign-in (real provider, real yarn:// return
deep-link) and the fleet path (runner-spawned CLI over the tunnel). The `yarn` scheme and
its origin are now in `AUTO_LAUNCH_PROTOCOLS` — scheme read off Yarn.app's Info.plist,
origin off app.asar's auth endpoints — the origin still wants confirming against a real
handoff.

---

## Live fleet sign-in, mac3, 2026-07-31 — what a REAL OAuth run found

Ran the full path: `./run signout mac3 Yarn` → `./run liveview mac3 Yarn --cdp` → `ssh -L`
tunnel → viewer in a browser → real Google sign-in on `me@davidgrant.info`.

**Worked, first time**: the runner brought the app up on 9222 and streamed it; the viewer
showed Yarn's real login screen; clicks and typing landed; **the endpoint hop fired against a
real OAuth handoff** — the stream followed Yarn → the external Chrome (9777) across two
processes and two ports, and Google's 2-Step Verification appeared in the same viewer through
the same tunnel. 2FA was approved on a phone and passed.

**Three findings, in ascending order of how much they change the design:**

1. **The app's debug port is not enough — the OAuth browser needs one too.** Yarn's "Continue
   with Google" never opens a page in its own renderer: the click reaches the MAIN process,
   which asks macOS to open the provider URL externally (`redirectDeeplink yarn` in the
   renderer console, and nothing else in CDP's view). macOS hands that URL to whichever Chrome
   is ALREADY RUNNING — on mac3 a desktop-session Chrome with no flags, which no screencast can
   attach to. Fixed: `ensureBrowserEndpoint()` brings up a flagged Chrome on 9777 and the
   liveview verb calls it alongside the app's. It QUITS a flagless Chrome to do so, unlike
   `ensureElectronEndpoint` which refuses — a browser on a fleet Mac holds no unsaved work and
   is the exact blocker. Verified: after the fix the hop worked.
   *Generalisation*: any Electron app whose auth leaves through `shell.openExternal` has this
   shape. Verifying inside one channel cannot see an effect that leaves it — the same lesson as
   pixel-delta existing because canvas content is absent from the AX channel.

2. **`chrome://` WebUI is unreachable from CDP, by design.** A managed-Workspace account
   triggered `chrome://managed-user-profile-notice` ("Your organization will manage this
   profile"), which blocks the OAuth chain. Neither a synthetic `.click()` on its shadow-DOM
   `#proceed-button` nor a real `Input.dispatchMouseEvent` at the button's measured rect did
   anything: Chrome refuses injected input on privileged browser UI (the protection that stops
   a page driving your settings). `bringToFront()` did not move the stream either — the follow
   policy watches page CREATION, so a page that already exists cannot be selected.
   **This is the case SCK exists for**, and it is not fixable on the CDP path.

3. **The `"Open Yarn?"` dialog is real, and recommended-level policy does not suppress it.**
   Seen under SCK: `https://y-prod-api.onrender.com wants to open this application.` — the
   exact origin now in `AUTO_LAUNCH_PROTOCOLS`, confirming that data. The allowlist is
   mandatory-only and the fleet's unattended path reaches recommended, so the dialog still
   appears; the grader already reports this as set-but-ineffective. Root/MDM is the only fix.

**Consequence for the design**: a sign-in is not one transport's job. CDP covers the app and
the provider's own pages (the long, typed, credential-bearing part); SCK covers the browser's
chrome — external-protocol dialogs, enterprise interstitials, passkey sheets. The switch is
currently manual (`--sck`), which is the next thing to close.

**Correction, 2026-07-31 (same day): a configuration profile reaches Mandatory on macOS 26 —
MDM enrolment is NOT required.** An earlier note here concluded the opposite after
`sudo defaults write` into `/Library/Managed Preferences` returned 0 and managed nothing on
mac3. That much is real (the directory belongs to the profile subsystem on 26; e51ffcc
measured a byte-identical plist honoured on mac1/15.5 and discarded on mac2+mac3/26.4.1) — but
"therefore only MDM" did not follow. Measured on mac3: `profiles status -type enrollment`
reports **No** on all three Macs, while `chrome://policy` READ ON THAT HOST reports
`BrowserSignin=0` and `SyncDisabled=true` at **Mandatory / Platform / OK**, delivered by a
manually-installed `.mobileconfig`. So the allowlist belongs in that profile, and
`AutoLaunchProtocolsFromOrigins` is reachable on the current fleet after all.

Method note worth keeping: the wrong reading came from running the `chrome://policy` probe on
the OPERATOR's laptop against `127.0.0.1:9777` with no tunnel — it answered, plausibly, about
the wrong machine's browser. Probes of remote state must execute on the remote host (copy the
script over and run it there), the same discipline the run harness applies to observations.
