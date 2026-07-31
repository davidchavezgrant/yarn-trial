# Native Mac apps without cua — can we, and what would it cost?

2026-07-30, follow-up to `2026-07-30-native-mac-apps-investigation.md` (the activation-policy
diagnosis) and `2026-07-30-cua-dependency-audit.md` (the system-wide keep/port call). Question
from David: **can we build the native path without cua at all?**

The audit had already proven perception, window enumeration, and one-shot window capture from
unsigned Swift. The one empirical gap was **actuation**: every prior "AX actuation works" data
point went through cua's dylib or System Events (which is Apple-signed and has its own TCC
grant). Today's probes closed that gap from our own unsigned `swiftc` binaries
(`tmp/actuate-probe.swift`, `type-probe`, `click-probe(2)`, `clickstate-probe`, `fulluser-probe`,
`clean-probe`, `final-probe`, `cmda-probe`, `hid-probe` — all against TextEdit on macOS 26.2,
AX permission inherited from the parent terminal).

## TL;DR

**Yes.** Every actuation primitive the native segment needs works from an unsigned Swift CLI:
activation, menu AXPress (foreground and background), value-setting, typing, HID clicks. The
constraints that remain are properties of **AppKit**, not of who calls the API — and both are
free under the keep-active run policy the native fix ladder already prescribes. A native-only
sidecar is **~700 lines of Swift, roughly a week** to parity, because the native segment never
touches cua's one genuinely expensive surface (the CDP stack). If native returns to scope,
build it in-house and keep cua for Electron; cua's native delivery model (background launch +
<1ms SLPS flicker) is the very thing the previous brief showed breaks native targets.

## 1. Probe results (what is now empirically proven cua-free)

| Primitive | Result | Evidence |
|---|---|---|
| Activate another app from unsigned CLI | **works** (macOS 26.2, interactive session) | `NSRunningApplication.activate` → `isActive=true`; setting `kAXFrontmostAttribute` also works. Cooperative-activation refusal did not occur. |
| Menu AXPress, app active | **works** | `clean-probe`: activate → AXPress `Edit ▸ Select All` → selection reads `hello world` in the focused window |
| Menu AXPress, app **backgrounded** (after one activation) | **works** | `actuate-probe` step 5: `File ▸ New` while `isActive=false`, windows 2→3, items stay enabled — the stickiness result reproduced from our own binary |
| Never-active state detection | **works** | pre-activation `Select All` reads `enabled=false` — the Hex Fiend signature is visible to our walk |
| `kAXSelectedText` insertion (cua `type_text`'s primary path) | **works, fully backgrounded** | `type-probe` A: err=0, value `[]→[ABC]`, `isActive=false` |
| Plain-text typing via `CGEventPostToPid` | **works, even backgrounded**, given AX-set focus | `type-probe` B: `[ABC]→[ABCXYZ]` with `isActive=false`; `actuate-probe` 4b same |
| Menu key-equivalents (⌘A) via `postToPid` | **need the app ACTIVE** | `final-probe`: works active (A, B), fails backgrounded (C). This is the exact constraint cua's `foreground` delivery mode exists to paper over — moot under keep-active |
| Coordinate clicks via `postToPid` | **do NOT drive AppKit views** — active or not, with or without `clickState` | caret never moved in `click-probe`/`clickstate-probe`. AppKit's NSView click machinery doesn't run on pid-posted mouse events |
| Coordinate clicks via **HID tap** | **work** (app must be frontmost at the point) | `click-probe2`: caret 6→7; `fulluser-probe`: HID click + HID ⌘A → full selection |
| Closed-menu harvesting incl. ⌘-equivalents | **works** | menu walks throughout read titles/enabled/children of closed menus (also in yesterday's probes) |

### A correction that matters: the mid-investigation "failures" were probe bugs

Several early cells looked like our binary's AXPress and ⌘A "fail where System Events
succeeds." All of those probes read the selection back via a walk over **all windows**
(`stack.popLast()` → last window first), while TextEdit had silently reopened autosaved
documents from earlier probe rounds — so they read a *different window's* empty selection.
`clean-probe` (reads every window + `AXFocusedWindow` explicitly) settled it: the press had
worked all along, in the focused window. **The 2×2 matrix collapsed — activation method and
press method both don't matter.** Our AXPress ≡ System Events' click. The only real
constraints are the two AppKit facts above (key-equivalents need active; coordinate clicks
need HID tap), and both bind cua equally.

Lesson worth keeping: **read-back must target `AXFocusedWindow`, never "first text area in
any window"** — the sidecar's verify path should inherit this.

## 2. What this changes about the build-vs-keep picture

The dependency audit scoped "move off cua" as ~1–2 weeks to AX parity **plus 2–4 weeks for
CDP** — and recommended keeping it because the frontier is Electron, where CDP is the moat.
The native segment inverts every term of that:

- **CDP is irrelevant** — native apps have no DOM. The expensive part of the port simply
  isn't in this scope.
- **cua's native delivery model is counterproductive** — the previous brief established that
  `launch_app` launches in the background by design and `foreground` mode is a <1ms
  SLPS flicker that never completes an AppKit activation. Native-on-cua *requires* the same
  keep-active harness work as native-without-cua; after that work, cua's delivery machinery
  contributes nothing the raw primitives don't.
- **The mature-edge-case moat shrinks** for native: stock AppKit controls are well-labeled
  (no axdom join needed), `set_value`/AXPress are single calls, and the two typing paths are
  now proven. What's left of cua's polish that we did *not* reproduce today: popup-child
  matching for `set_value` on NSPopUpButton, drag synthesis, secure-field/IME typing edge
  cases, and `type_text`'s echo-detection ("unverifiable" instead of a false confirm). That
  list is the honest hidden cost in the week estimate.
- **Trust surface improves**: the sidecar rides the parent process's existing AX + Screen
  Recording grants (probes did today), vs. cua's 49MB Developer ID binary needing its own
  TCC entries on every machine.

## 3. The shape of the native sidecar

Extend `native/axdom` (120 lines, already shipping) into a native driver speaking JSONL over
stdio behind the existing `driver.ts` boundary — the swap `driver.ts` was explicitly built
for. `observe()` already owns projection, so the sidecar emits raw.

| Piece | Est. | Status |
|---|---|---|
| Activate / launch / list windows | ~80 lines | proven today |
| Menu walk + AXPress + closed-menu harvest (incl. ⌘-equivalents) | ~120 lines | proven today |
| Typing: `kAXSelectedText` primary, focused `postToPid` fallback, echo check | ~100 lines | paths proven; echo check to port |
| HID click + drag | ~80 lines | click proven; **drag unproven** |
| Observe: AX walk + `SCScreenshotManager` one-shot capture | ~150 lines | walk shipping (axdom); capture proven in audit |
| `driver.ts` tool dispatch for native targets | ~150 lines TS | boundary already designed for this |
| **Total** | **~700 lines, ~1 week** | including the edge-case tail and a stock-app sweep |

Deleted along the way, for native runs: the 300s session TTL + heartbeat, the shared-daemon
kill (→ the single-run-per-Mac lease could lift for native), the consent pty hack, the
foreground-restore churn.

Two constraints the sidecar inherits (both already true or already policy):
- **Keep-active is a prerequisite**, not an option — HID clicks and ⌘-equivalents need the
  app frontmost. This is Phase 1 of the fix ladder verbatim.
- **HID tap serializes runs per machine** — the HID stream is global. The fleet already runs
  one job per Mac, so nothing changes.

## 4. What stays unproven

- **n=1 app for actuation** (TextEdit; Calculator's button-AXPress success came via cua).
  Same primitives, same C API — low risk, but the Phase 3 sweep is where it becomes a number.
- **Fleet TCC context**: `NSRunningApplication.activate` from an unsigned CLI worked in an
  interactive session; macOS cooperative activation may behave differently under a
  LaunchAgent. Same Phase 0 caveat as the previous brief (LIMITATIONS §12 lesson).
- **Drag synthesis** and the `set_value` popup edge cases — the residue of cua's polish.
- TextEdit autosave polluted mid-session probes; the final state is clean (all probe
  documents closed unsaved, app quit), but a fleet sidecar should assume target apps
  resurrect state across launches.

## 5. Recommendation

Unchanged for the system: **keep cua for the Electron frontier** — the audit's reasoning
stands and nothing today touches it.

Changed for native: the previous brief's fix ladder implicitly assumed cua underneath. If
native returns to scope, run Phase 0 (half-day activation experiment) on cua as written —
it's the fastest validation of the diagnosis — but build Phases 1–3 on the **in-house
sidecar**: the activation-policy work is required either way, cua contributes nothing
distinctive to native after it, and the native segment is precisely where cua's real moat
(CDP) does not reach. Expected cost to a cua-free native path: **~1 week**, on top of which
the two drivers coexist behind `driver.ts` — cua for Electron targets, sidecar for native —
with the agent loop unchanged.
