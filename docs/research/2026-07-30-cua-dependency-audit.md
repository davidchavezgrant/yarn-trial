# cua dependency audit — what it actually brings, and whether we could move off it

2026-07-30. Method: read every call site in this repo, aggregated tool usage from all 61
run logs in `out/runs/`, inspected the installed binary and npm package, and ran three
fresh probes (unsigned Swift AX walk, CGWindowList enumeration, unsigned SCK one-shot
window capture) to test the hardest replacement claims empirically rather than from docs.

## TL;DR

We use a **narrow slice** of cua through a **clean boundary**, and the slice is narrower
than the code suggests: the typed SDK surface is dead code — every one of the 20 real call
sites goes through `callTool(name, json)`. What cua actually provides is four things:
the AX observe/act core, pid-targeted CGEvent input with delivery-mode semantics, the
`browser_*`/CDP stack, and the trajectory recorder. Two of those four we could rebuild in
about a week; one we already half-built ourselves (`native/axdom`); one (CDP) is the real
cost. **Recommendation: keep it through the trial; the exit is real, cheap-ish, and already
de-risked — but exercising it now buys nothing on the current frontier (reliability +
generalization) and burns a week-plus rebuilding mature actuation edge-case handling.**
The strongest move-off path isn't a rewrite at all: for Yarn's own app and web targets,
CDP-direct makes most of the AX machinery unnecessary — and Yarn controls their app's flags.

## 1. Inventory: where cua touches this repo

### The import boundary (holds)

`src/driver.ts` (184 lines) is the only module importing `@trycua/cua-driver` — verified
by grep, still true. It wraps: `CuaDriver.create` (in-process, no daemon), session
lifecycle (`startSession`/`endSession`/`shutdown`/`uniffiDestroy`), and dispatch.

**Finding: the typed SDK is functionally unused.** `driver.ts` handles six ActionRequest
kinds (`click`/`type`/`key`/`hotkey`/`scroll`/`tool`), but every non-test call site in the
repo — all 20 of them — sends `kind: "tool"`. The typed kinds are declared in `types.ts`
and dispatched in `driver.ts` and constructed nowhere. `Driver.observe()`
(→ `getDesktopState`) and `Driver.listTools()` also have zero callers. So the exercised
API is exactly: **session lifecycle + `callTool(name, jsonArgs)`** — the npm package is,
for us, a fast in-process JSON-RPC shim. (The same tool surface is exposed by the CLI
binary via `cua-driver call`, per `docs/research/2026-07-29-packaging-native-vs-electron.md`;
the npm path just avoids a subprocess per call. Note that doc's claim that the npm package
ships "only JS/TS bindings" is wrong: `@trycua/cua-driver-darwin-arm64` ships the 41MB
`libcua_driver_sdk.dylib` + N-API runtime. The in-process path is self-contained.)

### The vocabulary boundary (does not hold — by design, and it's fine)

While the *import* is contained, cua's **dialect** is all over the codebase: tool-name
strings and arg shapes (`element_index` ×22 in harness.ts, `delivery_mode` ×30,
`window_id` ×36, `structuredJson` parsing in 6 files, `snapshot_format: "semantic_v2"`,
`target_id`/`tab_id`, `binding_quality`). `harness.ts`, `dom.ts`, `browser.ts`,
`canvas-probe.ts`, and the agent's tool schema all speak cua's parameter names. A swap
behind `driver.ts` would still mean touching every file that builds args — the boundary
protects against *linking* a different actuator, not against *speaking* to one.

### Tools actually used

From code + all 61 run logs (counts are model-proposed actions across every run):

| Cluster | Tools | Usage |
|---|---|---|
| **Perception** | `get_window_state` | The workhorse: every observation (elements + screenshot), every recording frame (~4fps polling loop), every settle probe. Thousands of calls. |
| **Actuation (AX/CGEvent)** | `click` ×233, `press_key` ×30, `type_text` ×7, `set_value` ×7, `right_click` ×5, `drag` ×3, `scroll`, `double_click` | 97% of clicks go by `element_index` (AX path, background-capable); x/y only for canvas. `delivery_mode: "foreground"` on keys/drags. |
| **Browser/CDP** | `get_browser_state` (semantic_v2 + paging), `browser_click`/`type`/`pointer`/`navigate` ×~20 total, `browser_prepare` | `src/dom.ts` (633 lines) + `src/browser.ts` (411 lines). 4 of 61 runs used the DOM backend. |
| **Plumbing** | `launch_app`, `list_windows`, `bring_to_front`, `check_permissions`, `start_recording`/`stop_recording` | Trivial semantics; recording matters (below). |
| **CLI binary** | `permissions status` (doctor), `browser-approve` (token minting under `expect`) | `run` script + `src/browser.ts`. |

Unused: `zoom`, `replay_trajectory`, the agent-cursor tools, `page` (legacy), `hotkey`,
`get_desktop_state`, `escalate_session`, skills/MCP — the driver ships ~45 tools; we use ~17.

The Electron shell (`electron/main.ts`) documents cua's `/electron` permission primitives
but actually uses Electron's own `systemPreferences` — another cua surface we cite but
don't consume.

## 2. What cua genuinely brings (ranked by replacement cost)

**A. The `browser_*`/CDP stack — hardest to replace 1:1.** Exact window→CDP-target
binding, semantic_v2 snapshots with typed refs + per-ref capabilities, continuation
paging, `query` (one-call resolve-by-label), true-background DOM actions. `docs/cua.md`
records this working where AX went dark. Rebuilding this means raw CDP or playwright-core:
1–2k lines to match snapshots/refs, or accept a less polished substitute. *But* note the
alternative below — for Chromium targets you don't have to match it, you can go around it.

**B. AX actuation semantics — moderate to replace, and where the mature edge cases live.**
`element_index` AXPress that works on backgrounded/hidden windows, foreground
activate→act→restore cycles, `type_text`'s kAXSelectedText-with-CGEvent-fallback and its
web-content echo detection ("unverifiable" instead of a false confirm), `set_value`'s
popup-child matching, `-25202` menu routing. The primitives are public C API
(`AXUIElementPerformAction`, `CGEventPostToPid`) — the *polish* is what took Cua's team
their release cadence to accumulate, and it's what our verify-per-step loop currently
leans on.

**C. AX perception — cheap to replace; we effectively already did.** `native/axdom`
(120 lines of Swift) walks the same tree cua walks, because cua's projection drops
attributes we need. My probe today extended that: a 30-line unsigned Swift CLI enumerates
AXPress-actionable elements with roles/titles on a live app. The rest of
`get_window_state`'s value — filtering, parent chains, haystack building, pixel-space
conversion — **we already reimplement ourselves in `observe()`** because the driver's
projection wasn't enough. Element indices, roles, labels, values, frames: one walk.

**D. Window screenshots — cheap, and the blocker is disproven.** LIMITATIONS §3 says
ScreenCaptureKit delivers no frames to an unsigned CLI — true for *live SCStream*, but I
tested `SCScreenshotManager.captureImage` (one-shot) from an unsigned `swiftc` binary
today: **it works** (captured an Obsidian window by ID, correct pixels). Our recording is
already one-shot polling at ~4fps, so the exact capture mode we need is available without
signing. `list_windows` is `CGWindowListCopyWindowInfo` (probe: trivial). `launch_app` is
`open -a`.

**E. Trajectory recording — cheap to replace.** `action.json` (click point + timestamps)
and before/after PNGs feed `humanize`/`track` for Yarn's cursor rendering. But our own
StepRecords already carry `targetRect` + timestamps + per-step screenshots, and
`cursor.jsonl` proved the physical pointer never moves (1.2% of samples) — the motion is
synthesized from our data anyway. The harness could emit an equivalent trajectory from
what it already knows.

## 3. What cua costs us (documented liabilities, all worked around)

- **300s absolute session lifetime** → 90s heartbeat in `driver.ts` (0 revivals across 61
  logged runs since — working, but it's our code babysitting their timer).
- **`shutdown()` kills the shared daemon** → single-run lease per Mac; this is what caps
  the fleet at one run per machine (LIMITATIONS §6, §12).
- **Browser consent is a per-call TTY gate** → `mintApprovalToken()` answers a
  human-confirmation prompt under `expect` (LIMITATIONS §12). Defensible, ugly, fragile
  against a rewording.
- **Sealed element projection** → the entire `native/axdom` sidecar + frame-geometry join
  exists because we can't add four attribute reads to their walk.
- **No window-scoped video** → our polling + ffmpeg assembly, with all its settle/majority-
  vote/black-band defenses.
- **semantic_v2 node budget (300) non-configurable** → paging implementation in `dom.ts`.
- **Near-daily releases** → version pinned (npm 0.12.5 vs installed binary 0.12.6 — we're
  already skewed today).
- **49MB installed app + Developer ID trust boundary** on every fleet Mac and, if this
  ships client-side, on customer machines.

A pattern worth naming: **five of the seven workarounds are us re-adding capability the
driver has but doesn't expose the way we need.** That's the signature of a peripheral used
slightly off-label, not of a framework fitting well.

## 4. Could we move off it?

**Technically: yes, and it's already half de-risked.** The replacement is a grown
`axdom` — call it `yarn-driver`: one Swift sidecar speaking JSONL over stdio, implementing
observe (AX walk + one-shot SCK screenshot), act (AXPress/`AXSetAttributeValue`/
`CGEventPostToPid`), windows/launch/foreground. Today's probes confirmed each primitive
individually from unsigned Swift. `driver.ts` was built for exactly this swap
("the actuator can be swapped… without touching the loop"), and `observe()` already owns
projection, so the sidecar can emit raw and let existing code shape it — the axdom join
heuristic *disappears* rather than grows.

Estimated shape:

| Piece | Est. | Basis |
|---|---|---|
| AX walk + projection (elements/roles/values/frames/actions) | ~200 lines Swift | axdom is 120 and does most of the walk |
| Actuation (press, set value, keys, clicks by pid, drag) | ~200–300 lines | public APIs; **the edge cases are the real cost** |
| Screenshots + windows + launch | ~100 lines | probes today |
| Trajectory emission | ~50 lines TS | data already in StepRecords |
| Session/heartbeat/lease code | **deleted** | no daemon, no TTL |
| `driver.ts` rewrite to subprocess | ~150 lines | protocol already defined |
| **AX-parity total** | **~1–2 weeks** | including the week of edge-case whack-a-mole that estimate hides |
| DOM/CDP backend parity | +2–4 weeks, or playwright-core | the one genuinely expensive piece |

What we'd lose: cua's accumulated actuation robustness (B above — the biggest real loss),
the CDP stack, upstream maintenance, cross-platform reach (irrelevant: Mac-only product),
and the possibility of upstreaming axdom's attributes instead of maintaining a fork of
anything. What we'd gain: no session TTL, no shared-daemon kill (→ multiple runs per Mac),
no consent pty hack, no 49MB third-party binary in the trust chain, attribute access
without a join heuristic.

**The stronger move-off path is strategic, not a rewrite.** Yarn's primary targets are
their own Electron app and web apps. For both, CDP-direct is available — and for Yarn's
own app, *they control the build*: they can ship it with a debugging endpoint or an
automation IPC channel, at which point the entire AX layer (cua's and any replacement's)
becomes unnecessary for the flagship target. cua's irreplaceable surface then shrinks to
"generic third-party Mac apps," which is exactly the segment currently out of scope
(David, 2026-07-30: Electron only, no native Mac apps).

## 5. Recommendation

**Keep cua for the trial. Do not port now.** Three reasons:

1. **Wrong frontier.** The session priority is proving reliable multi-step task completion.
   A port advances zero of that and pauses it for 1–2+ weeks; the AX flakiness that costs
   one run in three (LIMITATIONS §10) lives in Chromium's AX tree, not in cua — a
   homegrown driver inherits it identically.
2. **The exit is cheap and stays cheap.** The boundary module, the probes run today, and
   axdom's existence mean the option doesn't decay. Nothing accrues that deepens the
   dependency — we use 17 of 45 tools and none of the typed SDK.
3. **The decision has a natural trigger, and it isn't now.** It's productization: if this
   ships inside Yarn's app driving *other* apps, choose between embedding cua (first-party
   Electron support, outside-ASAR signing) and the in-house sidecar — and make that call
   with Yarn's team, since a third-party Developer ID binary with Accessibility + Screen
   Recording on customer machines is a trust/procurement question as much as a technical
   one. If it ships driving Yarn's own app or the web, CDP-direct wins and the question
   dissolves.

Two cheap hedges to carry meanwhile:

- **Keep the dialect from spreading further.** New arg-building code goes through the
  existing choke points (`toActionRequest`, `DomBackend`), not fresh `act({kind:"tool"…})`
  literals in new files.
- **Say it plainly to Jasper when asked**: cua is a peripheral behind a 184-line boundary,
  exercised as a JSON tool bus; exit cost is ~1–2 weeks to AX parity (primitives proven),
  the CDP stack is the expensive part, and their own app never needed either layer if they
  expose an automation channel.
