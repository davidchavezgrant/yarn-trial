# cua learnings

Living doc: everything we've learned driving macOS apps with `@trycua/cua-driver`.
Started 2026-07-29 for the yarn-trial prototype; written for people new to cua.
Raw session notes live in `docs/research/`; app-specific findings in `docs/appmaps/`
(autonomous exploration output) and `docs/recipes/` (hand-curated notes).

## What cua-driver is (as we use it)

A native (UniFFI/Rust) library, embedded in-process via the Node bindings — no daemon,
no VM. It drives real macOS apps through two channels:

- **Perception**: the Accessibility (AX) tree + screenshots, per-desktop or per-window.
- **Action**: AX actions (AXPress, AXShowMenu) and pid-targeted CGEvents (keys, clicks),
  which mostly work **without the target app being frontmost**.

Lifecycle: `CuaDriver.create()` → `isAvailable()` → `startSession({session})` → tools →
`endSession` → `shutdown()` → `uniffiDestroy()`. Every call carries the session name.
Generic input methods (`click`, `typeText`, `pressKey`, `hotkey`, `scroll`) take a
`DesktopScope`; the richer window-scoped operations are **dynamic tools** invoked by
name via `callTool(name, jsonArgs)` — discover them with `listToolsJson()`.

Tools we actually use: `check_permissions`, `launch_app`, `list_windows`,
`get_window_state`, `click`/`right_click`/`double_click` (by `element_index`),
`type_text`, `press_key`, `set_value`, `scroll`, `start_recording`/`stop_recording`.

We wrap all of this in one boundary module (`src/driver.ts`) so nothing else imports
the SDK — the actuator can be swapped without touching the agent loop.

## Setup & permissions

- Needs **Accessibility + Screen Recording** TCC grants for the *host process's*
  terminal/app. `check_permissions` reports both; run our `npm run probe "<App>"` as
  the smoke test (permissions → launch → window pick → elements + screenshot).
- macOS 15+, Node 22+. The native library refuses to load on unsupported hosts
  (`isAvailable()` — check it, the error otherwise is cryptic).

## Perception

- **`get_window_state` (pid + window_id) is the workhorse**: returns a markdown tree
  (`text`), structured JSON (`elements` with `element_index`, `role`, `label`, `value`,
  `frame`, `selected`, `enabled`), and optionally writes a window screenshot. A logged-in
  Electron window exposes a rich tree (~650–750 elements for Notion Calendar).
- **Element indices are per-snapshot.** They change every observation. Never cache an
  index across actions — re-observe, then resolve by role + label/value substring
  against the fresh snapshot.
- **Window picking needs care**: `list_windows` includes placeholder windows (untitled,
  500×500) and tooltips/panels. Filter by `app_name`, require area > ~50k px, prefer
  titled then largest. (`findWindow` in `src/harness.ts`.)
- **The window title is a cheap state signal** in Electron apps: Notion Calendar's
  title reflects the current surface ("Settings · …", "Create event · …"). Great for
  verification substrings.
- **Electron AX trees go intermittently dark under focus churn.** Rapid
  activate/deactivate cycling (which foreground delivery causes — see below) can make
  `get_window_state` return an empty/near-empty element list while the screenshot looks
  fine. It comes back after focus settles. Mitigation: fall back to keyboard nav +
  screenshot verification; longer-term, try the driver's `browser_*` CDP tools for
  Electron targets.

## Action & delivery modes

- **Two delivery modes.** `background` (default): events target the app by pid without
  fronting it — the killer feature; the user (or capture machine) can do other things.
  `foreground`: activates the app, sends the event, **then restores the previously
  frontmost app**. Consequences:
  - Menu-bar keyboard shortcuts (⌘, etc.) only dispatch via the NSMenu path →
    need `foreground`. Plain menu-item AXPress from background fails with **-25202**.
  - Escape to close overlays/popovers usually needs `foreground` too.
  - Background `scroll` is unavailable for Electron windows — use `foreground`.
  - Every foreground action is an activate→act→deactivate cycle: this is what churns
    focus and destabilizes Electron's AX tree. Batch foreground actions when possible.
- **AXPress warnings lie in both directions.** Web-content elements report "does not
  advertise AXPress; may have been a no-op" yet usually work (menu items, settings nav,
  result rows). But sometimes the click genuinely no-ops — and then your next keystrokes
  land on whatever *is* focused, hitting global shortcuts and opening random overlays
  (a stray "P" opened Notion Calendar's teammate-calendar picker). **Trust the next
  observation, never the warning — and verify every step before firing the next.**
- If an element only advertises `AXShowMenu` (labels that open context menus),
  use `right_click` — it routes to AXShowMenu.
- **`type_text` is always unverified** ("sent via CGEvent"). Confirm by re-reading the
  field's AX `value` in the next snapshot — typed text does show up there.
- **Text fields are often pre-filled.** Click to focus → ⌘A → type. Typing without
  select-all appends ("New YorkParis") and matches nothing.
- **Popovers can survive across driver sessions**, and window-scoped Escape doesn't
  always close them. Recovery: escape (foreground) repeatedly, re-snapshot, confirm no
  stray overlay elements remain.
- Allow a settle delay after every action before re-observing (we use ~900ms).

## Recording

- `start_recording`/`stop_recording` capture **the whole main display** plus a
  trajectory (`action.json`: click point + ISO timestamp per action — exactly the data
  a post-render cursor pipeline wants). Window-scoped *video* capture is a driver gap.
- **Display capture leaks unrelated content** (it happened to us in testing). Our
  workaround: window-scoped recording by polling `get_window_state` screenshots
  (~4fps) and assembling with ffmpeg — physically cannot contain other windows.
- Window-snapshot bugs to defend against (`assembleVideo` in `src/agent.ts`):
  - Snapshots **composite incorrectly for windows on non-retina (1x) displays**
    (upstream bug) — stage the window onto the main/retina display first.
  - During Space/display transitions the driver composites the window **at an offset**
    inside a correctly-sized canvas. We filter frames by majority-vote on frame size
    plus a leading-black-band content check.
  - The macOS **capture-indicator pill's window gets unioned into snapshots** —
    position the target window top-left (over the pill) to keep frames clean.
- Real 30fps window capture via ScreenCaptureKit needs a **signed app** —
  `tools/winrec.swift` documents that boundary (works, but suspends while the window
  is off its display's active Space).

## DOM access (browser_* / CDP) — VERIFIED on Notion Calendar, 2026-07-29

The driver speaks Chrome DevTools Protocol, so for browsers and Electron apps it can
read/act on the **DOM directly**, bypassing the AX layer. Two surfaces:

- **Legacy `page` tool**: `get_text`, `query_dom` (CSS selectors), `execute_javascript`,
  `click_element`, `insert_text`, `type_keystrokes`. Explicitly supports "Electron apps
  (via CDP)". Read-only actions work by default; mutations are gated behind
  `CUA_DRIVER_ENABLE_LEGACY_PAGE_MUTATIONS=1`.
- **Typed `browser_*` family** (preferred; what `src/dom.ts` uses):
  `get_browser_state` binds a native window (pid + window_id) to a CDP target
  ("exact-or-refuse"), then returns snapshots joining accessibility, DOM, layout, and
  viewport state as typed refs. Actions: `browser_click`/`browser_type`/
  `browser_pointer`/`browser_navigate`/`browser_dialog`/etc. — all on an exactly-bound
  tab, acting **without fronting the window**.

### Verified end-to-end (Notion Calendar, Electron 41)

- `open -a "Notion Calendar" --args --remote-debugging-port=9222` → full CDP endpoint
  (Electron passes Chromium switches through). Quirk: the app ignores the AppleScript
  quit event when it's in menu-bar/background mode (0 windows) — SIGTERM the main
  process to relaunch it with the flag.
- `get_browser_state(pid, window_id)` binds **exact** on the first try.
- **`snapshot_format: "semantic_v2"` — exact param name.** Any wrong name (`format`)
  silently falls back to `dom_refs_v1`, whose labels are junk (`type=button`, null).
  semantic_v2 gives accessible names, roles, values, and per-ref capabilities.
- **`query` is the killer feature**: a read-only semantic match over role/accessible
  name/visible text. `query: "Today"` → exactly one actionable ref. One-call
  resolve-by-label, no snapshot parsing.
- **Per-ref capabilities matter**: buttons advertise `click,pointer`; textboxes
  advertise `type,pointer` (NOT click) — `browser_type` focuses the field itself, no
  click first. `browser_pointer` handles right_click/double_click/hover/scroll/drag.
- **True background posture, proven**: typed into the search field and verified the
  DOM value read-back while another app stayed frontmost the whole time. Zero focus
  churn — the AX-darkness trigger simply doesn't exist on this path.
- **AX and DOM compose in one session**: after `browser_type` focuses a field,
  AX-path `press_key` (cmd+a, delete) lands in that field. Escape and OS-level
  shortcuts stay on the AX path (foreground) — CDP has no native-layer keys.
- During one cleanup, the AX tree went dark (`observe` saw nothing) while DOM queries
  kept answering correctly — directly confirms DOM robustness where AX fails.

### Limits found (the honest part)

- **Node budget truncates busy pages.** semantic_v2 caps at ~300 nodes; Notion
  Calendar's week view exposes ~650–750 AX elements, so unnamed/low-ranked elements
  (e.g. the timezone gutter label) get omitted (`omitted.page_occluded`, `offscreen`,
  …). A full agent run over the DOM backend (11/15 steps harness-verified, palette +
  keyboard flows all working) failed the canonical timezone task precisely because the
  gutter label never appeared as a ref — the AX backend wins that task. Mitigations to
  explore: `scope_ref` subtree reads, `continuation` paging, `query` as a model tool.
- Occlusion affects ranking: snapshots prioritize visible content, and an occluded
  window pushes hundreds of nodes into `page_occluded` omission.
- Verdict: **DOM and AX are complements, not substitutes** — semantic-first surfaces
  (palette, dialogs, fields) are stronger over DOM; dense custom canvases still need
  AX/vision. This is the backend-per-target-class architecture (`--backend dom|ax` on
  the agent).

## Patterns that work (harness-level)

- **One action per model turn, with a machine-checked expectation.** The harness
  re-observes and string-matches `textIncludes`/`textExcludes` against window title +
  all element labels/values, feeding PASS/FAIL back. The model may override a failed
  check with visual evidence (e.g. expected "CEST", saw "GMT+2" — correctly declared
  success), but the check catches silent no-ops that would otherwise cascade.
- **Ground first, then act.** A one-time exploration pass (`src/explore.ts`, safety
  rules + step budget) writes app notes that eliminate dead ends: on Notion Calendar,
  grounded runs hit 0 dead ends vs 2 (a Settings detour) ungrounded, and found quirks
  manual testing missed.
- **Verified sequences beat re-derivation.** Once a sequence works, record it
  (`docs/research/`, `docs/recipes/`) — the exact element roles, delivery modes, and
  verification substrings. This is the seed of recipe compilation.
- **Tolerate loose tool schemas.** OpenRouter doesn't enforce tool input schemas
  strictly — handle a missing `expectation` by flagging it in the tool result,
  not crashing.

## Open questions

- Can the DOM backend's truncation be beaten with `scope_ref` subtree reads,
  `continuation` paging, or exposing `query` to the model as its own tool? (The
  timezone task would likely pass with any of these.)
- Is the semantic_v2 node budget configurable (`set_config`)?
- Does grounding + the agent loop transfer to a second app unchanged? (Untested.)
- Is there a driver-native way to get window-scoped *video* (vs our snapshot polling)?
