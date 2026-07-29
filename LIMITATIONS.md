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
  (Engineering this properly — pixel-level corroboration rather than model judgment — is
  still open.)

---

## 3. Window recording is capture-mode dependent

**QUIRK** · found 2026-07-27–28

- Display-level capture (driver `record_video: true`) records *the whole display*, i.e.
  whatever else the user has open. Unusable on a machine a human is using. Rejected.
- The driver's window snapshots are the reliable path (they capture the target window's own
  content through occlusion and backgrounding — the same mechanism §1 kills entirely).
- Those snapshots composite **at half size for windows on non-retina (1x) displays**,
  producing constant black bands — upstream cua-driver bug. `--record` stages the window
  onto the main retina display first.
- The macOS capture-indicator pill can get unioned into snapshots; parking the window at
  the top-left keeps it clear.
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
  arrive missing. The harness flags it in the tool result rather than crashing.
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

- **Unhandled action names crash the run.** `toActionRequest` throws on any action the
  model invents (seen: `wait`). It should return a no-op with an explanatory tool result
  so the model can correct itself, rather than aborting a run mid-task.
