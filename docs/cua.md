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

Two lifecycle facts that cost us runs before we understood them:

- **A session has a 300-second ABSOLUTE lifetime from `start_session` — not an idle TTL.**
  A session kept busy with an action every 5s still died at 300.1s. This killed two
  exploration passes at action 15 and looked exactly like a step limit, because it
  reproduced at the same action every time. `src/driver.ts` re-declares the session every
  90s (`start_session` is idempotent and refreshes the clock); verified 130 actions over
  650s. **Any run longer than five minutes needs this heartbeat.**
- **`shutdown()` kills the shared native driver, not just your session.** A second process
  that opens and closes a driver session takes down any run already in flight — the victim
  fails mid-action with `tool failed (session_ended)`. Never run two driver-using scripts
  at once (`pgrep -fl "src/(agent|explore).ts"` first); `./run` enforces this.
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
- **The driver's element projection discards attributes the AX tree actually has.** It
  keeps role/label/value/frame, so a Chromium icon button with no `aria-label` arrives as
  `AXButton ""` — unaddressable. But Chromium's Mac bridge still exposes the source DOM
  node as nonstandard AX attributes (`AXDOMIdentifier`, `AXDOMClassList`, plus `AXHelp`/
  `AXDescription`/`AXPlaceholderValue`/`AXURL`) and the driver simply never reads them.
  `native/axdom` (Swift, ~120 lines) walks the same tree and `src/axdom.ts` joins the
  result on by **frame geometry** — element indices come from two independent walks and
  are not comparable. Measured on Yarn: 955/1044 anonymous nodes named, including 37 of
  64 anonymous *interactive* controls, ~0.5s per observation. Buys nothing on native
  AppKit apps (no DOM) and nothing for canvas content (no DOM node either).
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
  a post-render cursor pipeline wants). The driver has no window-scoped *video* mode; we
  keep `start_recording` running purely for that trajectory feed, not for its video.
- **Our own capture IS window-scoped** — worth stating plainly, because "window-scoped
  capture is a gap" was written here once and was wrong. The polled `get_window_state`
  loop below is window-local by construction. Unrelated to this: the `capture_scope=window`
  string in the driver governs how input coordinates are interpreted, not what the
  recorder records.
- **Display capture leaks unrelated content** (it happened to us in testing). Our
  workaround: window-scoped recording by polling `get_window_state` screenshots
  (~4fps) and assembling with ffmpeg — physically cannot contain other windows.
- Window-snapshot bugs to defend against (`assembleVideo` in `src/agent.ts`):
  - ~~Snapshots composite incorrectly for windows on non-retina (1x) displays.~~
    **Retracted 2026-07-29 — not reproducible.** Yarn fullscreen on a 1920×1080 1x panel
    captured cleanly (1568×882, no bands, no offset). The claim had justified moving the
    user's window between monitors; staging now fills the window's *current* display and
    only warns on 1x. The frame gates below catch it if it ever reappears.
  - During Space/display transitions the driver composites the window **at an offset**
    inside a correctly-sized canvas. We filter frames by majority-vote on frame size
    plus a leading-black-band content check.
  - The macOS **capture-indicator pill's window gets unioned into snapshots** —
    position the target window top-left (over the pill) to keep frames clean.
- Real 30fps window capture via ScreenCaptureKit needs a **signed app** —
  `tools/winrec.swift` documents that boundary (works, but suspends while the window
  is off its display's active Space).

## Browser targets (browser_prepare) — measured 2026-07-30, cua-driver 0.12.6

Driving a WEBSITE rather than an Electron app means getting a driver-owned Chrome. Corrections
to what the section below assumes, all learned by calling the tool rather than reading strings:

- **`open -a … --args --remote-debugging-port=9222` is superseded.** The binary states
  "Chromium remote-debugging flags moved to browser_prepare so DevTools is never enabled on an
  unproven user profile"; `launch_app`'s `cdp_debugging_port` is retired with it.
- **`browser_prepare` takes a required `pid`** and prepares an existing process. Launch first.
- **Refusals are not errors** — `{"status":"refused","refusal":{…}}` with `isError` unset.
  Check the payload; an exception handler alone will miss it.
- **Consent is per-CALL, and the gate is a TTY rather than a human.** `browser-approve` mints a
  five-minute single-use token, so this is per run, not per machine. It refuses a pipe — but it
  is checking for a terminal, not for a person, so running it under a pty (`expect`) and
  answering `APPROVE` mints a token `browser_prepare` accepts. `mintApprovalToken()` in
  `src/browser.ts`. Bounded/unrestricted permission modes and the binary's magic token literal
  do NOT open this gate — all four measured. See LIMITATIONS §12.
- **The AX backend needs none of this.** It reads the window, not the DOM, so
  `--backend ax --url <site>` skips prepare entirely — `open -a <browser> <url>` is the whole
  acquisition, and the web-area filter keeps browser chrome out of the frontier.
- Verified arg shape (schema-confirmed via `cua-driver describe browser_prepare`):
  `{pid, allow_launch: true, profile: {mode: "isolated_named", name: "yarn-runner"}}`.
  Do NOT pass `strategy` alongside `profile`/`allow_launch` — the driver rejects the pair.
- **`viewport_x`/`viewport_y`/`pixel_to_css_scale_*` are NOT `get_browser_state` fields.** They
  belong to the `browser_screenshot` and legacy `page` clusters. The AX→viewport coordinate
  conversion for real Chrome therefore has no confirmed source yet, and the window-origin
  fallback is wrong by the height of the tab strip + omnibox. See LIMITATIONS §12.
- **`binding_quality` is a four-value enum** — `exact` / `heuristic` / `embedded_single_page` /
  `native_cdp_window`. Reject only `heuristic`; requiring `exact` would break Electron, which
  is the one DOM target that works today.

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

- **Node budget truncates busy pages, and is NOT configurable.** semantic_v2 caps each
  snapshot at 300 nodes; Notion Calendar's week view reports `total_nodes: 1176`.
  Confirmed against the driver binary: `node_budget` appears only as an OUTPUT field
  (beside `selected_nodes`/`total_nodes`), snapshot inputs accept no limit parameter,
  and `set_config` takes only `max_image_dimension` + the `experimental_pip` keys.
- **Paging solves it.** `snapshot.continuation` is an opaque token; passing it back
  returns the next 300 ranked nodes in the SAME ref namespace, so pages merge into one
  addressable set. Measured on the week view: 4 pages, 1176/1176 nodes,
  `omitted.budget` driven to 0, ~2.0s total vs ~1.9s for a single page — the first
  snapshot dominates, so exhaustive paging is nearly free in wall-clock (it costs
  context, not time). Implemented as `DomBackend.snapshotPaged`; exploration runs
  exhaustive, the agent loop runs one page + `find` on demand.
- Exhausting the chain is NOT the same as seeing everything: `omitted.budget` is what
  paging recovers, while `css_hidden`/`offscreen`/`page_occluded` (270 nodes here) stay
  withheld regardless. `PagedSnapshot.unreachable` reports that separately.
- **The real blocker was capability enforcement, not truncation.** The timezone gutter
  label was in page 1 all along. `browser_pointer`/`browser_click` refuse any ref that
  does not DECLARE the capability (`semantic ref p3:0 does not declare the pointer
  action`) — and Notion Calendar's gutter label and every context-menu row are bare
  `statictext` advertising nothing, though they handle clicks perfectly. Both tools
  accept **x/y coordinates instead of a ref**, which skips the check ("browser_click
  needs a ref or x/y coordinates"). That is the only way to reach these elements.
- Coordinates come from the AX tree (semantic refs carry no geometry; `query_dom`
  returned 0 elements on this Electron target). AX frames are SCREEN-space and
  browser_pointer wants VIEWPORT-space: the delta is exactly the window origin from
  `list_windows` bounds. Measured — EDT label at AX (295,129), DOM (285,95.5), window
  at (0,33). `DomBackend.axCentre` does the conversion and the fallback is automatic.
- Occlusion affects ranking: snapshots prioritize visible content, and an occluded
  window pushes hundreds of nodes into `page_occluded` omission.
- Verdict: **DOM and AX compose rather than compete.** The DOM path now completes the
  canonical timezone task end-to-end (verified 2026-07-29, both directions), but it
  does so by borrowing AX geometry for capability-refused elements and the AX key path
  for OS-level keys. A "pure DOM" backend is not achievable against this app; a hybrid
  one is, and it is strictly better than either alone.

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

- ~~Can the DOM backend's truncation be beaten by paging / `query` as a model tool?~~
  ANSWERED: yes — `continuation` paging exhausts the tree and `find` (query as a tool)
  reaches anything the ranker drops. But truncation was not what blocked the timezone
  task; capability enforcement was. See "Limits found".
- ~~Is the semantic_v2 node budget configurable?~~ ANSWERED: no. Output-only field.
- Does `scope_ref` (subtree reads) beat paging for cost? Untested — with exhaustive
  paging measured at ~2s, the motivation is context size, not latency.
- ~~Verification is the weak link: a presence-only check still passes.~~ **Structurally
  fixed 2026-07-29.** The origin was two DOM runs claiming success on the timezone task
  with `textIncludes ['GMT+2']` while the app sat in travel mode showing GMT+2 *beside* an
  unchanged EDT. `verify()` now rejects an expectation that is not **discriminating** —
  one already satisfied by the observation taken *before* the action never counts — and an
  act call with no checkable substrings is refused unexecuted. Two advisory layers sit
  behind it: per-step pixel delta (canvas content is invisible to AX, so "nothing
  repainted" is otherwise undetectable) and a visual judge at `done`.
- ~~Does grounding + the agent loop transfer to a second app unchanged?~~ **Yes** — Yarn,
  2026-07-29, no harness changes needed. But the honest caveat: both proven apps are
  Chromium/Electron. What transferred is untested on a native AppKit AX tree.
- **What verification still cannot do**: prove it verified the *right* control. It greps a
  flattened bag of labels and values, so a per-project override and a brand-wide default
  reading the same value are indistinguishable to it. Yarn has 16 settings in exactly that
  shape. Appmap scope warnings and the visual judge mitigate; nothing proves it.
- Is there a driver-native way to get window-scoped *video* (vs our snapshot polling)?
