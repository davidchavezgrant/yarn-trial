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

