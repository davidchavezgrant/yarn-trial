# Native Mac apps: what it would take — investigation brief

2026-07-30. Native targets are **out of scope** (David, 2026-07-30) — this brief is the
reopen-from-task-#24 homework: diagnose the Hex Fiend 0/15 failure, work out the fix
ladder and its cost, and say what stays hard. Method: anatomy of the two native run logs
(`out/runs/2026-07-30T17-21-55-hex-fiend.json`, `...17-15-59-calculator.json`), inspection
of the cua dylib's actuation strings/symbols, and three fresh probes run today against
TextEdit on this Mac (macOS 26.2) that reproduce the failure minimally and test the fix.

## TL;DR

The Hex Fiend failure was **not** an AX-perception gap, not AX flakiness, and mostly not
cua's fault. It is an **activation-policy bug in how we run native targets**: the harness
launches the app without ever making it *active* in the AppKit sense (`open -g`-style
`launch_app`, staging via System Events which doesn't activate, `ensureObservable` only
foregrounds when perception fails — and perception was fine). An AppKit app that has never
been active has no key/main window, so **menu validation disables every document-scoped
menu item and menu AXPress silently no-ops** — exactly the "DISABLED throughout, pixels
0.0%" signature in the run log. cua's `delivery_mode: "foreground"` does not fix it
because it fronts via `SLPSSetFrontProcessWithOptions` for <1ms and restores the prior
frontmost — a window-server-level flicker, not a real AppKit activation.

Probes today confirm: one genuine activation at run start flips menu items to enabled and
makes menu AXPress work — **and it keeps working after the app is backgrounded again**.
The likely fix is a run-start "activate and keep active" policy for native targets:
roughly a day of harness work plus a re-run of the Hex Fiend task to validate, then a few
days of measurement across a sample of native apps. What stays hard is the same thing
that's hard on Electron: custom-drawn views (Hex Fiend's hex view has no AX text), which
the pixel-delta and visual-judge channels only partially cover.

## 1. Evidence

### The failure (Hex Fiend, 15 steps, 0 verified)

- Perception was **fine**: the agent saw the Font menu, the Size submenu, individual size
  items, the Settings window, the data inspector — full tree, correct labels.
- Every actuation route failed: menu AXPress (steps 3–5), ⌘⇧= via foreground delivery
  (step 6), coordinate clicks with foreground delivery (steps 1, 7, 13), window-raise via
  element 0 (step 12, errored). `pixelDelta` 0.0% on 13 of 15 steps — nothing repainted.
- The tell: menu items reported `DISABLED` **throughout the entire run**, including after
  actions specifically intended to activate the app (clicking the window, Window-menu
  items, Hide Others).

### The control (Calculator, same day, success)

Same harness, same launch path, native app — **passed** with machine-checked final
evidence and a visual-judge PASS. The difference: Calculator's task lived entirely in
**window content** (AXButtons). Button AXPress goes straight to the control's action; it
does not pass through menu validation and does not need a key window. Hex Fiend's task
lived in the **menu bar**, which is exactly the surface activation gates.

### The minimal repro + fix probe (TextEdit, today)

1. `open -g TextEdit` (never activated), create a document via AppleScript, then AXPress
   `Edit ▸ Select All`: AppleScript **returns success**, menu item reports
   `enabled=false`, and the selection does not happen (`AXSelectedText` stays empty).
   This is the Hex Fiend signature in two commands.
2. `System Events → set frontmost to true`, same AXPress: `enabled=true`, selection reads
   `"hello world"`. **Activation is the whole difference.**
3. Activate once, background it again (front another app), then AXPress `File ▸ New`:
   **works** (document count 1→2), menu items stay enabled. So one real activation at
   run start is sticky — the responder chain exists from then on, and background menu
   AXPress works for the rest of the run.

### Why cua's foreground mode doesn't cover this

The dylib's own tool description: *"foreground: briefly front the window (NSMenu path,
< 1 ms via SLPSSetFrontProcessWithOptions) so native menu key-equivalents dispatch, then
restore the prior frontmost."* `SLPSSetFrontProcessWithOptions` is the private SkyLight
call that changes the window server's front process without the app's cooperation — and
with a <1ms front-then-restore, AppKit never completes an activation, no window becomes
key/main, and menu validation never re-runs. This trick is sufficient for Electron
(Chromium routes input itself and doesn't use NSMenu validation for in-window UI) and
insufficient for AppKit menus. The driver also ships `bring_to_front`
(`activateWithOptions:`, with a "macOS rejected activation for pid" failure path — under
macOS 14+ cooperative activation rules a background caller can be refused). The System
Events `set frontmost` path worked in today's probe and is what the harness already uses
elsewhere (staging, `foregroundApp`), with Automation permission already granted on fleet
Macs.

### One native-specific perception hazard (also visible in the run log)

On AppKit apps the **entire closed menu tree is enumerable via AX** — names, enabled
state, and key equivalents (`AXMenuItemCmdChar`/`AXMenuItemCmdModifiers`; probe read
TextEdit's whole Edit menu, closed, including ⌘-equivalents). Two consequences:

- **Gift**: explore can harvest complete menu maps *without actuating anything* —
  including every keyboard shortcut — into the appmap. Cheaper and safer grounding than
  the Electron click-to-discover loop.
- **Trap**: "the Font menu opens" is unverifiable by text presence, because the items are
  in the haystack whether the menu is open or not. The strictness layer caught this
  correctly (all those "already satisfied before the action" notes); native-target
  expectations need to discriminate on `enabled`/`SELECTED`/value changes instead.

## 2. The fix ladder

**Phase 0 — validate the diagnosis (half a day).** Re-run the exact Hex Fiend task,
goal-only prompt unchanged, with one harness change: a real activation at run start.
Prediction from today's probes: menu items report enabled, Font ▸ Size ▸ 24 AXPresses
work, run verifies. Activation is harness policy (like `resetToHome`), not task-prompt
method knowledge — no measurement-rule tension.

**Phase 1 — "activate and keep active" policy for native targets (~1–2 days).** At run
start, after `launch_app`: activate genuinely (System Events `set frontmost`, falling
back to `bring_to_front`/AppleScript `activate`) and verify activation took (AX
`frontmost` attribute — a discriminating check, not fire-and-forget). Then prefer
**background delivery** for the rest of the run: the app is already front, so AXPress and
pid-posted CGEvents land correctly, and we stop paying cua's activate→act→restore churn
entirely. On fleet Macs keep-active is free — nobody multitasks there, and recording
staging wants the app frontmost anyway. Note this likely helps **Electron too**: focus
churn is what degrades Electron AX trees (LIMITATIONS §2), and Yarn's
every-click-needs-foreground quirk (§7) may simply dissolve when the app just stays
front. Worth an A/B on the canonical Yarn task while measuring.

**Phase 2 — menu harvesting in explore (~1–2 days).** For native targets, enumerate the
menu bar tree (closed) into the appmap: full command inventory + key equivalents, zero
actuation. Prompt guidance: on native apps prefer the harvested key equivalent (CGEvent
to an active app) or direct menu-item AXPress; expectations must discriminate on state,
not menu-item presence.

**Phase 3 — measurement sweep (a few days).** The native claim is currently n=2 (one
pass, one fail, both single runs). Sweep 5–8 stock apps (TextEdit, Preview, Notes,
Calculator, System Settings, Finder) with goal-only tasks, 2 samples per condition, same
run-log discipline. That gives a real success-rate number and a catalogue of which
native surfaces break next.

Total to a defensible "native works / doesn't" answer: **roughly a week**, with the go/no-go
signal after the half-day Phase 0.

## 3. What this does NOT fix

- **Custom-drawn views.** Hex Fiend's hex view renders text AX can't see — same class as
  Electron canvas content. Activation gets the *menus* working (enough for the font-size
  task); driving or verifying the canvas itself stays on the pixel-delta/visual-judge
  channels and coordinate clicks. Any native app whose core surface is custom-drawn
  (DAWs, NLEs, games) stays hard.
- **Apps with no/weak AX adoption.** Stock AppKit controls label themselves well —
  generally *better* than anonymous Electron buttons (and axdom is irrelevant here: no
  DOM to enrich, and less need). But third-party custom controls with no AX actions
  advertise nothing; coordinate clicks while active are the only route.
- **Activation refusal edge cases.** macOS cooperative activation can reject
  background-initiated activation; the System Events path worked today on 26.2, but the
  fleet LaunchAgent context should be verified in Phase 0 (the SSH-attribution lesson in
  LIMITATIONS §12 says assume nothing about fleet TCC contexts).
- **The irreversibility carve-out, cleanup, scope ambiguity** — all actuator-agnostic and
  unchanged.

## 4. Revision this forces on earlier conclusions

`2026-07-30-cua-learnings-for-real-implementation.md` calls cua's native-AX actuation
core "its genuine moat (background AXPress, foreground restore cycles… years of edge
cases)" and cites the Hex Fiend failure as the segment's evidence. Today's probes weaken
both halves: the Hex Fiend failure was **our activation policy**, and cua's
foreground-restore cycle is actually **counterproductive** on native targets (the <1ms
SLPS flicker is precisely what left the app never-active). The type_text fallbacks and
edge-case handling remain real cua value, but "native = cua's moat" should be downgraded
to "native = an activation policy plus the same AX primitives we already probed from
unsigned Swift." If native ever returns to scope, that moves the build-vs-keep needle
toward the thin in-house sidecar for this segment too.

## 5. Independent re-verification (second session, same day)

A later session on 2026-07-30 re-checked every load-bearing claim from scratch rather than
trusting this doc:

- **Run logs**: Hex Fiend 15 steps / 0 verified / `success:false`, pixelDelta exactly 0 on
  13 of 15 steps, DISABLED present throughout; Calculator passed. Matches §1.
- **TextEdit probes 1–3 re-run live** (fresh TextEdit launch, cleaned up after): never-activated
  → `Select All` reports `enabled=false`, AXPress returns success, selection stays empty;
  one System Events activation → `enabled=true`, selection reads `hello world`; backgrounded
  again → `File ▸ New` AXPress works (docs 2→3) and items stay enabled. All three reproduce.
- **Dylib strings**: `foreground` mode self-describes as "< 1 ms via
  SLPSSetFrontProcessWithOptions … then restore prior frontmost"; `bring_to_front` carries the
  "macOS rejected activation for pid" failure path; and `launch_app` is documented verbatim as
  **"Launch a macOS app in the background"** — direct confirmation of the `open -g`-style
  launch claimed in the TL;DR, not just an inference from behavior.

## 6. Recommendation

Stay out of scope — nothing here argues for reprioritizing. But the Phase 0 experiment is
half a day, converts a wrong diagnosis in our docs into a right one, and likely yields a
side payoff on the in-scope Electron path (keep-active vs. focus churn). When native
matters — e.g. a customer whose product is an AppKit app — run the ladder as written;
the expected cost to a credible answer is about a week, not the open-ended "generalization
frontier" the 0/15 run made it look like.
