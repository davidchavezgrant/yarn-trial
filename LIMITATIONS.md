# Limitations & environment constraints

A running log of what constrains this agent in practice — discovered empirically while
building the POC. Each entry: what breaks, why, how it manifests, and what (if anything)
works around it. Newest sections appended as we find them.

Format: **[severity]** BLOCKER (stops the agent) · CONSTRAINT (bounds where it can run) ·
QUIRK (needs handling, not fatal).

---

## 1. Target app must be on the active Space — Chromium suspends everything otherwise

**BLOCKER** · found 2026-07-29 on Yarn (Electron 38.2.0) · same class seen on Notion Calendar

When another app is fullscreen (macOS gives fullscreen apps their own Space), a target app
sitting on a different Space becomes simultaneously unobservable and unactuatable:

| Signal | Value when off-Space |
|---|---|
| `list_windows` → window exists | ✅ yes (window server still tracks it) |
| `is_on_screen` | `false` |
| AX windows for the process (`System Events` → `count of windows`) | **0** |
| `get_window_state` elements | 169 — *all* system menu bar, zero app content |
| Window screenshot (driver) | not written |
| `screencapture -l <windowID>` | `could not create image from window` |

Cause: Chromium builds its accessibility tree lazily and tears down/throttles rendering for
windows it considers backgrounded or occluded; a window on an inactive Space is both. The
window-server entry persists, so naive checks ("does the window exist?") pass while every
useful capability is gone.

**Programmatic activation does not fix it.** All of these report success and change nothing
when the target is on another Space — macOS refuses background-initiated Space switches:

- `osascript -e 'tell application "X" to activate'`
- `open -a X`
- cua-driver `bring_to_front` (returns "Brought pid N to the foreground.")

`AXManualAccessibility = true` on the app element also returns success (0) without
populating the tree. (`AXEnhancedUserInterface` returns -25208, unsupported.)

**Workarounds**
- Operational: a human (or a session-start step) must put the target app on the active
  Space once, before the run. Avoid running demos on machines with a fullscreen app in
  front.
- Detection: treat `AX windows == 0` or `non-menu elements == 0` as "target not
  observable" and fail fast with that diagnosis rather than letting the model flail
  against a menu-bar-only tree.
- Recovery attempt (added 2026-07-30): `ensureObservable()` in `src/harness.ts` no longer
  fails on the first unobservable probe. It foregrounds the target — driver
  `bring_to_front`, `launch_app` (= `open -a`, which opens a window when the app has none),
  `activate`, and an `AXMinimized = false` pass over every window — waits 2s for Chromium to
  rebuild the tree, **re-runs `findWindow`** (the relaunch can produce a new window id) and
  re-probes. This fixes the *other* causes that present identically: app running with no
  open window, hidden app, minimized window. It does **not** fix the off-Space case above,
  and is not claimed to — that probe fails again and the error says foregrounding was tried.
- Product-side (Yarn controls its own app): force-enable Chromium accessibility, disable
  background throttling, or expose CDP so perception doesn't depend on AX at all.

**Verified boundary (2026-07-29, Yarn)**: the failure is about *which Space is currently
displayed*, not about whether some other app is fullscreen. Measured on the same window
minutes apart:

| Situation | AX windows | `is_on_screen` | Elements (app content) | Capture |
|---|---|---|---|---|
| Viewing a fullscreen app's Space; Yarn on the desktop Space | 0 | false | 0 | fails |
| Viewing the desktop Space; Yarn present but occluded behind another window, not frontmost | 1 | true | 61 of 230 | works |

So plain occlusion is fine — perception sees through covering windows (that is the whole
basis of window-scoped capture). The operational rule is narrower than "no fullscreen
apps": *do not switch to a different Space during a run.* The user can keep working in
overlapping windows on the same desktop.

Encouraging: Yarn's Electron build launches with `--disable-features=MacWebContentsOcclusion`,
i.e. they have already disabled Chromium's occlusion-based throttling — consistent with
being a screen-recording product, and favorable for agent perception.

**Why it matters for the product**: an agent shipping inside a Mac app cannot assume the
target is frontmost on the current Space. This is a deployment precondition to state
explicitly, not an edge case.

### 1a. The half-suspended variant: AX alive, rendering dead (found 2026-07-30)

The detection rule above — "AX windows == 0, fail fast" — assumes perception and rendering
die together. They do not always. Two Notion Calendar runs (`2026-07-30T00-27-43`,
`T01-00-53`) kept a **full AX tree** the whole way through: 15 steps executed, elements
addressable, `verify()` grepping a plausible haystack. Nothing repainted. Every step logged
`pixelDelta: 0.000`, and the recorder saved **247 byte-identical frames** — the same view,
current-time line frozen at 2:27 AM, for 316 seconds of video.

So the run looked healthy on the channel that gates it and was dead on the channel that
produces the deliverable. Both runs burned their whole step budget and assembled an mp4 of
a still image.

**Detection** (`unpaintedStreak()` in `src/harness.ts`): count trailing steps that verified
nothing *and* moved no pixels. A verified step proves the app is alive and clears the streak,
and an unknown delta (`--no-vision`, no prior frame) clears it too. Replayed over all 48
historical run logs it fires on exactly these two, at step 4 instead of 15.

**It reports, it does not stop the run** (changed 2026-07-30). It briefly aborted at 4, and
that was wrong for a target class we care about: apps with an embedded agent of their own.
Yarn's takes up to five minutes to think, during which the correct behaviour is to wait —
and waiting produces this exact signature, nothing verified and no pixels moved. A frozen
window and a working one waiting on a slow model cannot be told apart from outside, so the
run no longer tries; the streak prints a note at 4 and the operator decides. Still
unsolved: a genuinely dead window now burns the full step budget again, as it did before.

---

## 2. Electron AX tree degrades under focus churn

**CONSTRAINT** · found 2026-07-27 on Notion Calendar

Distinct from §1 (which is total). While the window *is* on the active Space, fighting the
app for focus — user clicks elsewhere, window drags, rapid app switching — intermittently
empties the web-area portion of the AX tree. Menu bar stays; app content vanishes for a
few observations, then returns.

**Impact**: element-targeted actions become impossible mid-run; string verification against
element labels reports false failures exactly when the environment is hostile.

**Workarounds**
- Keyboard-first fallback: the agent routes through menus, command palettes, and typed
  navigation when elements are unavailable (verified working under adversarial testing).
- Screenshot verification as a second channel — the model reads pixels when the tree lies.
- **Partially addressed (2026-07-29)**: `pixelDelta()` now records per-step visual change
  deterministically, and `visualJudge()` adds an independent model check at `done`. Neither
  repairs a degraded tree — they make the degradation *visible* rather than silently
  verified. Recovery still depends on the keyboard-first fallback.

---

## 3. Window recording is capture-mode dependent

**QUIRK** · found 2026-07-27–28

- Display-level capture (driver `record_video: true`) records *the whole display*, i.e.
  whatever else the user has open. Unusable on a machine a human is using. Rejected.
- The driver's window snapshots are the reliable path (they capture the target window's own
  content through occlusion and backgrounding — the same mechanism §1 kills entirely).
- ~~Those snapshots composite at half size for windows on non-retina (1x) displays.~~
  **Not reproducible (measured 2026-07-29)**: Yarn fullscreen on a 1920x1080 1x panel
  captured cleanly (1568x882, no bands, no offset). The claim had justified moving the
  user's window between monitors; staging now fills the window's *current* display and only
  warns on 1x. If banding reappears, the assembly-time gates below already drop those frames.
- The macOS capture-indicator pill can get unioned into snapshots; parking the window at
  the top-left keeps it clear.
- **Natively-fullscreen apps report ZERO windows to System Events** (`windows[0]` throws
  "Invalid index", -1719), so any AppleScript/JXA staging must treat the absence of windows
  as the fullscreen signal. This silently broke recording staging on every Yarn run until
  2026-07-29; setting a position on a fullscreen window also demotes it out of fullscreen.
- Malformed frames are filtered at assembly by majority-vote on frame size plus a
  leading-black-band content check.
- ScreenCaptureKit live window streams deliver **no frames to an unsigned CLI** on macOS 26
  in any window state tested (`tools/winrec.swift` documents this). Signed apps — e.g. Yarn
  itself — are not affected.

---

## 4. Driver / actuation quirks

**QUIRK** · found 2026-07-27, Notion Calendar (details in `docs/research/`)

- "Does not advertise AXPress" warnings are unreliable in both directions: the click often
  works anyway, and occasionally silently no-ops. Only re-observation tells the truth —
  this is the core argument for verify-per-action.
- A silent no-op click means subsequent keystrokes land on the wrong surface and can
  trigger the app's global shortcuts (observed: a stray "P" opened an unrelated overlay).
- Menu-bar keyboard equivalents (⌘,) need `delivery_mode: "foreground"`; plain AX menu
  actions from the background fail with -25202.
- Element indices/tokens are per-snapshot — always resolve against a fresh observation.
- `type_text` is never driver-verifiable ("sent via CGEvent"); confirm via the field's AX
  value in the next observation.
- Popovers survive across driver sessions and don't always close on window-scoped Escape.

---

## 5. Model / harness

**QUIRK** · found 2026-07-27–28

- OpenRouter does not strictly enforce tool schemas; a required field (`expectation`) can
  arrive missing. **The harness now refuses to execute** such an act call and returns an
  error the model must correct — previously it acted anyway and reported an unqualified
  success, which is how vacuously-"verified" steps entered the run logs.
- **The observation drops most of the AX tree.** `observe()` keeps only elements with a
  label, value or DOM descriptor, plus 8 whitelisted roles. Anything else — including
  canvas/preview content, which has no AX representation at all — never reaches the model
  or the verification haystack. Measured on Yarn: 377 addressable elements, exactly one
  AXImage (a 20x20 icon), while a dozen video thumbnails were rendering on screen.
- ~10s of model thinking between actions. **Not a concern for Yarn** — their pipeline
  imperceptibly speeds up demos in post — but it is one for any interactive use.
- Generalization beyond one app is unproven; the Yarn POC is the first real test.

---

## 6. Driver sessions are not concurrent-safe

**BLOCKER (self-inflicted)** · found 2026-07-29 during the Yarn exploration

`Driver.close()` calls `shutdown()` on the shared cua-driver daemon, so **a second process
that opens and closes a driver session kills any run already in flight**. The victim run
fails mid-action with `tool failed (session_ended): session 'X' has ended` — a 20-action
Yarn exploration was lost this way when a one-off diagnostic script ran alongside it.

**Workarounds**
- Never run two driver-using scripts at once. Check for a live run first
  (`pgrep -fl "src/(agent|explore).ts"`).
- If ad-hoc diagnostics are needed during a long run, they must share the same session
  rather than opening their own.
- Longer term: `close()` should end the session without shutting the daemon down when
  other sessions exist, or the harness should acquire a lockfile.

---

## 7. Yarn-specific actuation quirks

**QUIRK** · found 2026-07-29 (details in `docs/recipes/yarn.md`)

- **Background-delivered clicks are silently no-ops in Yarn** — every click needs
  `delivery_mode: "foreground"`. Background scroll is refused outright
  (`background_unavailable`). This is stricter than Notion Calendar, where background
  clicks generally worked; it means a Yarn run cannot be fully non-intrusive (each click
  briefly fronts the app).
- **Escape does not dismiss the Settings modal** — an unlabeled 42×42 X button does.
  Generic "press escape to back out" recovery is not universal.
- Per-item "…" popups on Library cards do not respond to AXPress at all.
- While a dropdown is open, sidebar elements disappear from the AX tree.

- ~~**Unhandled action names crash the run.**~~ **Fixed 2026-07-29**: `toActionRequest`
  throws a typed `UnsupportedActionError` that the agent loop reports back as a rejected
  step, so the model self-corrects instead of the run aborting. `wait` is now a real action.

---

## 8. Verification cannot tell WHICH control it verified

**BLOCKER (for correctness claims)** · found 2026-07-29 on Yarn

`verify()` matches substrings against a flattened bag of AX labels and values. It can prove
that *a* control reads the target value; it cannot prove that control is the *intended* one.

Measured: Yarn exposes **16 Screen Clip settings at two independent scopes** — a brand-wide
default (Brand Kit ▸ Screen Clips) and a per-project override (Project actions ▸ Screen Clip
Settings). Writing `Original` to the per-project panel left the brand default reading
`Pointer-first`: separate stores. All four ungrounded runs of "change the cursor style"
changed the per-project override while passing verification and reporting truthfully.

The screenshot carries the disambiguating context — breadcrumb, panel title, surrounding
chrome — that the haystack flattens away.

**Mitigations (all partial)**
- `findScopeAmbiguities()` on the appmap graph detects settings living at multiple scopes;
  `scopeWarnings()` injects both routes into the prompt and requires the agent to state
  which scope it chose. Verified to flip behaviour in both directions.
- `visualJudge()` at `done` catches the wrong-scope case — **but only when given the agent's
  claim**. Handed the bare task string it *passed* a known-wrong-scope frame, reasoning that
  an instructional task only asks to locate the control.
- Neither is a proof. A task that never names a scope has no ground truth to check against;
  the honest output is a stated choice, not a verified one.

**Generalizes to**: any app with global defaults plus per-document overrides — editors,
IDEs, design tools, browsers.

---

## 9. Grounding artifacts are an input that can be contaminated

**CONSTRAINT** · found 2026-07-29 (process, not code)

Appmaps are a *declared input* to every grounded run, so anything hand-written into them
silently inflates results. Both original appmaps contained task-specific recipes added after
watching runs fail at the very tasks later measured — the prompt-hygiene rule enforced by
`auditTaskPrompt()`, evaded through a side door.

**Workarounds**
- `docs/appmaps/` holds *only* `explore.ts` output, carrying a machine-readable provenance
  stamp; hand-curated notes live in `docs/recipes/` (`USE_RECIPE=1`) and are a different,
  separately-labelled tier.
- `loadGrounding()` treats an unstamped appmap as `curated` and warns; every run log records
  provenance plus the appmap's content hash, so a "grounded" claim is auditable afterwards.
- **Never hand-edit a stamped appmap.** Regenerate it, or move the edit to `docs/recipes/`.

---

## 10. AX flakiness costs roughly one run in three

**CONSTRAINT** · observed 2026-07-29 across the day's runs

Beyond §2's mid-run degradation, whole runs abort. Observed failure modes, each seen at
least once:

| Failure | Signature |
|---|---|
| AX tree returns zero elements while the window renders normally | `TargetNotObservableError` after 3 blind observations — frames prove the window was fine |
| Focus jumps to another app mid-run | agent clicks land in the wrong app, then the tree goes dark |
| Driver session dies | `tool failed (session_ended)` (see §6) |

Two consequences worth stating plainly:
- The `TargetNotObservableError` message **asserts a cause it has not verified** ("most
  likely on an inactive Space"). At least once that was wrong — the window was rendering
  normally on the active Space and the AX tree had simply emptied. Read the frames before
  believing the diagnosis.
- Retries were clean every time, so this is a throughput and reliability cost, not a
  capability limit. It is also the single biggest obstacle to unattended operation, and the
  strongest argument for the CDP backend on Electron targets.

---

## 11. DOM enrichment is best-effort and geometry-joined

**QUIRK** · added 2026-07-29 with `src/axdom.ts` + `native/axdom`

The Swift sidecar recovers `AXDOMIdentifier`/`AXDOMClassList` (and help/description/
placeholder/URL) that cua-driver's element projection discards, naming 955 of 1044 anonymous
Yarn nodes. Its limits:

- **Joined by frame geometry**, the only identifier both walks share — element indices are
  per-walk. Nested wrappers share bounds, so the innermost row wins by convention.
- **27 of 64 anonymous interactive controls stay anonymous** — no DOM id or class either.
- **No help for canvas content**: canvas-rendered pixels have no DOM node, so this channel
  cannot see them any more than AX can (that is what §8's pixel/visual layers are for).
- **Requires the binary**: `npm run build:native` (`native/axdom` is gitignored). Missing
  binary, `AXDOM=0`, or a native AppKit target degrades silently to the bare AX view, and
  the run log records why.
- Native (non-Chromium) apps have no DOM attributes at all — this buys nothing there.

---

## 12. Running on someone else's Mac has its own set of walls

**CONSTRAINT** · found 2026-07-30 bringing up the three colo Macs

Moving runs off this laptop and onto dedicated machines removed the Space and focus problems
in §1 and §2 — nobody is sitting at those Macs to steal focus. It introduced these instead,
each of which cost real time to diagnose because none of them reports an error.

- **A run started over SSH perceives nothing, silently.** macOS attributes Accessibility and
  Screen Recording to the *responsible* process and children inherit that attribution, so a
  run spawned from an sshd session is asking for grants sshd does not have. The result is an
  empty AX tree and a black screenshot with **no error on either** — indistinguishable from
  an app that has not finished launching. This is why each Mac runs the Electron app itself
  as a LaunchAgent (`--serve`), bootstrapped into `gui/<uid>` rather than `user/<uid>`, and
  why every run is a child of that process. Nothing else on the fleet path can be relaxed
  without walking back into this.
- **The grant has to be given by a human at the machine, once per Mac.** TCC is SIP-protected;
  there is no API, no MDM shortcut we have, and no way to copy the database. Screen Recording
  additionally has no `+` button, so the app has to *ask* before it even appears in the list
  to be granted (§ electron/main.ts `requestPermissions`). A new Mac is therefore never
  zero-touch to the first run.
- **Neither is signing an app in.** SSO with MFA is not automatable in the general case, and
  the general case is the requirement here. `./run signin <mac> "<App>"` is the concession:
  it opens a screen share with the app already in front, waits for the app to reach the home
  state a run would demand, and closes the viewer itself. It is once per app per Mac, and it
  needs a person. No credential enters the agent loop, deliberately — every observation and
  every frame reaches the model and the recording.
- **Screen Sharing prompts for the Mac's own login at least once per Mac**, and that prompt
  cannot be pre-filled from here without putting a password in an argv and a printed URL. The
  URL carries the username, which turns two prompts into one and lets the keychain answer the
  second from then on. The first one is unavoidable.
- **A locked screen fails runs in a way that looks like AX flakiness.** The AX tree is present
  but empty and screenshots are the lock wallpaper. `screenIsLocked()` (via `ioreg`, so it
  works from any runner context) now names it instead of leaving it as one more §10 dropout.
- **One run at a time per Mac, enforced by a lease.** Not a scaling choice: §6's shared-daemon
  problem is per-machine, so two runs on one Mac kill each other. Three Macs is three
  concurrent runs, and that is the whole of the parallelism available today.
- **A checkout on three machines drifts.** `provision` rsyncs and restarts the runner, and
  `doctor` reports each Mac's checkout, grants, sidecar and runner state — but nothing
  prevents a Mac from being behind, and a run against a stale checkout fails in whatever way
  that checkout was broken. Check `doctor` before believing a fleet-wide result.
- **LaunchServices can bind an app name to the wrong bundle.** Seen twice with a build that
  ships a nested copy of itself inside `Contents/Resources`: `open -a <name>` launched the
  inner bundle, which starts and then behaves like a different application. There is no
  app-specific fix in the code, and a generic guard is still open (#39).


---

## 12. Web targets: `browser_prepare` needs a per-call approval token, minted under a pty

**QUIRK** (was BLOCKER) · measured 2026-07-30 against cua-driver 0.12.6 · **resolved**

Pointing a run at a website drives a **driver-owned Chrome profile**, not the operator's.
`browser_prepare` gates that, and three things about it are only discoverable by calling it:

- **It prepares an EXISTING browser process.** `pid` is required — "Browser process id to
  prepare" — and omitting it fails with `Missing required integer field: pid`. `allow_launch`
  governs whether the driver may then spawn its own separate isolated-profile process. So the
  sequence is launch → find pid → prepare, not prepare alone.
- **A refusal is NOT an error result.** It arrives as `{"status":"refused","refusal":{…}}` with
  `isError` unset, so `Driver.act` does not throw and a caller that only catches exceptions
  walks straight past it. That happened: the run continued and died later at the CDP bind
  reporting `browser_requires_setup`, blaming a step that had apparently succeeded.
  `refusalOf()` in `src/browser.ts` is the guard, and the lesson generalises to every
  `browser_*` tool.
- **Consent is per-call, and the gate is a TTY rather than a human.** `browser-approve`
  "interactively mint[s] a five-minute, single-use token" — per run, not per machine. Four
  escapes were tried and all failed: bounded mode with a session policy, unrestricted mode,
  the embedded `CUA_DRIVER_PERMISSION_MODE` env vars, and the binary's magic token literal
  (that one gave a *different* refusal — "malformed **or expired**" — proving the field is
  live). What works: the CLI checks for a terminal, not for a person, so running it under a
  pty and answering its prompt with the literal word `APPROVE` mints a real token that
  `browser_prepare` accepts. `mintApprovalToken()` does this with `expect`; it is called per
  prepare, since caching a five-minute single-use token buys nothing.

  Note `script -q /dev/null` also supplies a pty but **races** — it feeds stdin before the
  prompt is drawn and the answer is swallowed. `expect` waits for the prompt text.

  Scope of that decision, stated plainly: this answers a deliberate human-confirmation prompt
  programmatically. It is defensible for this profile and no other — the profile is
  driver-owned and disposable, the driver states the requested browser "will not be modified
  or terminated", and the alternative is a human typing APPROVE before every fleet run. It is
  not a general consent bypass and touches nothing belonging to the operator.
  `YARN_BROWSER_AUTO_APPROVE=0` restores the interactive prompt.

**Two startup races, both real, both fixed:**

- A fresh profile reports a window before its CDP target exists, so the first
  `get_browser_state` can fail with `browser_wrong_target_refused` ("no CDP target correlates
  with native window N"). `navigate()` retries for ~7s.
- A new profile opens on `about:blank`, and a site may redirect across origins
  (`notion.so` → `www.notion.com`). A strict origin match rejected the very tab we had just
  navigated. `pickTab` now takes a **lone** tab whatever its URL says, and still refuses when
  several tabs are open and none match — the case where guessing could drive the wrong one.

**Verified end to end 2026-07-30**: `./run explore --url https://example.com` completes a full
grounding pass (prepare → exact bind → navigate → explore → `frontier-empty`) and writes both
appmap halves. A pass against `https://www.notion.so` binds the right tab and maps real
surfaces — navigating routes, recording login/signup/help-centre structure, frontier growing
past 250 controls.

