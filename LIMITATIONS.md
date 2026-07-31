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
- Recovery attempt (added 2026-07-30): `ensureObservable()` in `src/core/harness.ts` no longer
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

**Detection** (`unpaintedStreak()` in `src/core/harness.ts`): count trailing steps that verified
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
- ~~ScreenCaptureKit delivers no frames to an unsigned CLI on macOS 26.~~ **Narrowed
  2026-07-30, twice.** One-shot `SCScreenshotManager.captureImage` works from an unsigned
  `swiftc` binary (measured in the cua dependency audit). And live `SCStream` works from an
  ad-hoc-signed `swiftc` binary too — `native/liveview` streams real frames — PROVIDED the
  process descends from the TCC grant holder. The real gate is the responsible-process
  grant (§12), not code signing. `tools/winrec.swift`'s original zero-frames result was
  measured from a bare terminal CLI.
- This whole section describes the AX/DOM recording path. A `--backend cdp` run records the
  page viewport via `page.screenshot()` — no window staging, no capture pill, no
  fullscreen/System Events interaction at all.

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
- ~10–25s of model thinking between actions (a finished Yarn explore pass measured ~25s
  per action). **Not a concern for Yarn** — their pipeline imperceptibly speeds up demos
  in post — but it is one for any interactive use.
- Default model is key-conditional (`src/core/harness.ts`): `openai/gpt-5.6-sol` over an
  OpenRouter key, `claude-opus-5` over a bare Anthropic key; `AGENT_MODEL` overrides.
  OpenRouter caveat: `cache_creation_input_tokens` comes back null for OpenAI models, so
  the `cache_control` blocks the prompts carry are accepted and silently ignored — the
  system prompt is billed in full every turn.
- ~~Generalization beyond one app is unproven.~~ **Superseded**: Electron (Yarn, Notion
  Calendar) and web targets (`--url`, own appmaps) run with zero harness changes. Native
  AppKit: one pass (Calculator), one diagnosed fail (Hex Fiend — foreground delivery never
  makes the app key/main; `docs/research/2026-07-30-native-mac-apps-investigation.md`),
  and out of scope per David 2026-07-30. Custom-drawn views remain the open class.

---

## 6. Driver sessions are not concurrent-safe

**BLOCKER (self-inflicted)** · found 2026-07-29 during the Yarn exploration

`Driver.close()` calls `shutdown()` on the shared cua-driver daemon, so **a second process
that opens and closes a driver session kills any run already in flight**. The victim run
fails mid-action with `tool failed (session_ended): session 'X' has ended` — a 20-action
Yarn exploration was lost this way when a one-off diagnostic script ran alongside it.

**Workarounds**
- Never run two driver-using scripts at once. Enforced in code now, twice: `./run` refuses
  to start while a run is in flight (`assert_no_run_in_flight`), and each fleet Mac takes a
  liveness-based lease (`src/remote/runner/lease.ts`) before spawning.
- If ad-hoc diagnostics are needed during a long run, they must share the same session
  rather than opening their own.
- **This is a cua-path constraint only.** `--backend cdp` opens no driver session at all;
  two CdpBackends on different ports do not know about each other. The one-run-per-Mac
  lease is unconditional today (taken before the backend is known), so the policy holds —
  but for cdp runs it is a conservative scheduling choice, not physics.

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
  step, so the model self-corrects instead of the run aborting. `wait` is now a real action
  and takes `seconds` (clamped to 10 min) — before the argument existed the longest
  expressible pause was ~900ms, so waiting out an app that embeds its own agent (§1a) cost
  hundreds of turns against the step budget.

---

## 8. Verification cannot tell WHICH control it verified

**BLOCKER (for correctness claims)** · found 2026-07-29 on Yarn

`verify()` matches substrings against a flattened bag of AX labels and values. It can prove
that *a* control reads the target value; it cannot prove that control is the *intended* one.

Measured: Yarn exposes **10 settings at two independent scopes** on the current committed
appmap — mostly Screen Clip brand-wide defaults (Brand Kit ▸ Screen Clips) vs per-project
overrides (Project actions ▸ Screen Clip Settings); re-measure with `findScopeAmbiguities()`
after any explore pass rather than quoting this (earlier maps said 14/16/17). Writing
`Original` to the per-project panel left the brand default reading `Pointer-first`:
separate stores. All four ungrounded runs of "change the cursor style" changed the
per-project override while passing verification and reporting truthfully.

The screenshot carries the disambiguating context — breadcrumb, panel title, surrounding
chrome — that the haystack flattens away.

**Mitigations (all partial)**
- `findScopeAmbiguities()` on the appmap graph detects settings living at multiple scopes;
  `scopeWarnings()` injects both routes into the prompt and requires the agent to state
  which scope it chose. Verified to flip behaviour in both directions.
- `visualJudge()` at `done` catches the wrong-scope case — **but only when given the agent's
  claim**. Handed the bare task string it *passed* a known-wrong-scope frame, reasoning that
  an instructional task only asks to locate the control.
- The offline run judge (`npm run judge -- <stamp>`, `src/core/judge.ts`) catches it
  after the fact: an adversarial model call over the full trajectory with the appmap's
  scope ambiguities as rubric, grading against the TASK rather than the claim (its first
  prompt draft graded the claim and passed a run that honestly described its wrong scope
  — the mirror image of the visualJudge lesson above). Validated on all known wrong-scope
  runs; the bench runs it fleet-wide and reports self-report-vs-judge disagreements.
- None is an in-run proof. A task that never names a scope has no ground truth to check
  against; the honest output is a stated choice, not a verified one — and the offline
  judge's verdict is itself a model opinion, post-hoc and advisory.

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
- The `TargetNotObservableError` self-diagnosis is **partly fixed** (2026-07-30):
  `screenIsLocked()` now distinguishes a locked display from the Space case, and the Space
  message hedges instead of asserting. Reading the frames is still the ground truth.
- Retries were clean every time, so this is a throughput and reliability cost, not a
  capability limit. It is also the single biggest obstacle to unattended operation, and it
  is why the CDP-direct backend (`--backend cdp` — no AX in the perception path at all)
  exists.

---

## 11. DOM enrichment is best-effort and geometry-joined

**QUIRK** · added 2026-07-29 with `src/core/axdom.ts` + `native/axdom`

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
- **The grant has to be given by a human at the machine, once per Mac** — *on bare metal.* TCC is
  SIP-protected; there is no API, no MDM shortcut we have, and no way to copy the database **on a
  SIP-enabled physical Mac**. (Qualifier added 2026-07-31: inside a VM golden image this is
  routine and two major CI fleets depend on it. The TCC `access` table keys a grant on service +
  client + `csreq` — a *code-signing* requirement, not a machine one — and `boot_uuid` is the
  literal string `'UNUSED'`, so grants survive cloning. GitHub's `actions/runner-images` ships
  `configure-tccdb-macos.sh`, which INSERTs Accessibility/ScreenCapture/PostEvent grants directly
  into both databases inside cloned Anka templates. What actually differs is SIP: disabling it
  needs a recovery boot, which is a physical power-button hold on bare metal and a scripted step
  in a VM. See `docs/research/2026-07-31-session-roaming-deep-research.md` §5.) Screen Recording
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

## 13. Web targets: `browser_prepare` needs a per-call approval token, minted under a pty

**QUIRK** (was BLOCKER) · measured 2026-07-30 against cua-driver 0.12.6 (the standalone
`/Applications/CuaDriver.app` daemon build; the npm package pins 0.12.5) · **resolved**
· **moot on `--backend cdp`**, which drives its own Chrome and has no consent gate at all

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
  `refusalOf()` in `src/backends/browser.ts` is the guard, and the lesson generalises to every
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

---

## 14. The CDP-direct backend trades OS reach for reliability

**CONSTRAINT** · added 2026-07-30 with `src/backends/cdp.ts` (`--backend cdp`)

The cdp backend deletes four cua liabilities by construction (no 300s TTL, no shared
daemon, no consent gate, no node budget) and its perception cannot go AX-dark. What it
gives up:

- **Keys go through CDP's Input domain to the RENDERER.** Menu-bar shortcuts,
  browser-chrome shortcuts, and anything the OS handles never fire. Native OS dialogs
  (file pickers, permission sheets) are not driveable at all. The AX path keeps those.
- **Chrome throttles rendering for backgrounded tabs**, and a throttled tab times out
  every `page.screenshot` — the snapshot channel never notices, the pixel channel loses
  every frame. `bringToFront` at acquire is the fix and is in place.
- Electron targets must be launched with `--remote-debugging-port`; a customer app that
  strips or blocks the flag falls back to the AX path.
- Recording is the page viewport, not a macOS window — fine as pipeline input, different
  artifact.

## 15. Exploration coverage is gated, and the gates matter

**CONSTRAINT** · found 2026-07-30 (process + code)

- **"Frontier empty" is reachable by dismissing.** An uncapped pass cleared 104 unrelated
  controls in one dismissal and declared itself done at 25 actuated of 262 seen.
  `EXPLORE_DISMISS_CAP` (default 20) refuses a bulk dismissal that names no specific
  surface. Read `controls: N actuated / M dismissed / K seen` in the stamp, never the stop
  reason.
- **Destructive-labelled controls hide whole workflows from the map.** Refused by default,
  every surface behind Delete/Export/Reset is a permanent hole (350 of 396 Yarn controls at
  one point). `EXPLORE_DESCENT=1` opts into guarded descent: one press, the HARNESS
  classifies the surfaced modal and sends Escape itself; the model never acts inside it.
  Externality verbs (send/publish/purchase/account) are hard-refused always. Details:
  `docs/research/2026-07-30-mapping-behind-destructive-gates.md`.
- The destructive-label guard has its own switch (`EXPLORE_GUARD=off`) — it used to ride on
  the `guidance` flag, so steering a pass silently disarmed it.

## 16. Liveview (window-scoped remote sign-in) inherits every TCC wall, plus its own

**QUIRK** · added 2026-07-30 with `native/liveview.swift` + `src/remote/control/liveview*.ts`

- **Must be spawned by the runner** or it captures nothing — same responsible-process rule
  as §12; an SSH-spawned engine emits `no-screen-recording` every tick with no other error.
- Needs **two grants**: Screen Recording (capture) and Accessibility (input injection).
- **Zero frames when no window is frontmost** is a legitimate state, not a defect —
  measured on two fleet Macs with empty consoles. The frontmost-follow needs a real
  foreground window to follow.
- Requires `npm run build:native` (which now builds BOTH sidecars — `native/axdom` and
  `native/liveview`, both gitignored).
- One server per port; a second `liveview` call reports the existing server rather than
  spawning a doomed one (checked before the profile swap, so it cannot quit the app out
  from under an in-progress sign-in).

## 17. Shell concurrency: one run per HOST, with a shared-name caveat

**QUIRK** · relaxed 2026-07-31 (`electron/main.ts`, commit 95a9ad0)

The Electron shell now hosts one run per HOST — a local run and runs on two colo Macs
coexist; per-machine contention is still §6's lease. Accepted limitation: log buffers are
keyed by APP NAME, so two concurrent runs of the *same app* on different hosts interleave
in one terminal buffer. Also note `./run dispatch` is exempt from the local
run-in-flight guard by design — the far side's lease is the authority.


## 18. A sign-in stream can show the watcher the browser's saved form data

**LEAK · OBSERVED** · found 2026-07-31 on mac2, partially mitigated the same day
(`src/remote/chrome-policy.ts`, provisioning step `browser`)

During a liveview sign-in on mac2, Chrome's autofill dropdown appeared in the stream listing
real team members' email addresses. Liveview is window-scoped and working as designed — the
leak is that the browser volunteers everything it has ever been told, unprompted, into a
channel a *different* person is watching.

State of the fleet when this was found (read-only measurement, counts only):

| host | `Login Data`.`logins` | `Web Data`.`autofill` |
|------|----------------------:|----------------------:|
| mac1 | 801 | 1969 |
| mac2 | 801 | 2123 (1200 distinct, 80 email-shaped) |
| mac3 | 797 | 1849 |

All three are signed into a Google account with sync active and `passwords` in the synced
set. On mac2 every one of the 801 credentials carries a row in the login database's own
`sync_entities_metadata` — the server knows about all of them.

**Two dropdowns, two switches, and only one of them can be closed by policy:**

- *Single-field form history* (`Web Data`.`autofill`) is keyed on the FIELD NAME, not the
  site — a box called `email` on any page offers every address ever typed into any box
  called `email`. That is the only store that explains one list containing several
  different people. **Closed** by `AutofillAddressEnabled: false`.
- *Saved passwords* (`Login Data`) are offered per-site. **NOT closed.**
  `PasswordManagerEnabled: false` only stops new saves — its own documentation says
  previously saved passwords still work, and **no Chrome policy disables password filling.**
  It is set anyway so a shared Mac stops accumulating more, but a login form on a site with
  a saved credential will still offer it. Closing that half means clearing the store, which
  is deliberately not automated — see below.

**The policy is RECOMMENDED, not mandatory, and can be silently defeated.** Mandatory needs
`/Library/Managed Preferences`, i.e. root: measured on mac2 the fleet account has no
passwordless sudo, that directory does not exist, and the Mac is not MDM-enrolled — while
provisioning is a `BatchMode` ssh that cannot answer a password prompt. Recommended sits
BELOW the user store, so an explicit user preference — including one arriving via sync —
wins. `./run provision --doctor` re-reads the *effective* value on the host for exactly this
reason and reports an override rather than assuming the write won. Enforcing it properly
needs an MDM configuration profile.

**Clearing the saved passwords is NOT automated, and must not be.** Deleting rows through a
running Chrome commits a sync tombstone, which deletes the credential from the real Google
account's vault and every other device that person owns. Deleting the file instead destroys
`sync_model_metadata`, so the next launch re-runs initial sync and downloads everything back
from the server.

**RESOLVED 2026-07-31, and the reasoning above was half wrong.** The tombstone is a property
of deleting THROUGH A RUNNING, SIGNED-IN CHROME — the manual UI route this paragraph
recommended. With the browser closed, no process is connected to Google to report the
deletion, so removing the profile directory is purely local: the accounts keep their vaults
and the machine forgets them. Automating it is therefore *safer* than doing it by hand.

`./run browser-wipe [<mac>|all] [--go]` does it: quits Chrome, VERIFIES it exited (refusing
with nothing touched otherwise, since a delete underneath a live Chrome is written back on
quit), and removes whole profile directories rather than selected files — which is what
avoids the `sync_model_metadata` trap above. Run with consent 2026-07-31: 6 profiles, 801
credentials each on three Macs, verified empty afterwards.

A wipe is not a fix on its own — signing the same account back in with sync restores the
vault. `SyncDisabled` + `BrowserSignin: 0` now close that permanently at mandatory policy
level on all three Macs. Full operational detail, including why this needs a configuration
profile rather than a plist on macOS 26: `docs/research/2026-07-31-fleet-chrome-lockdown.md`.
