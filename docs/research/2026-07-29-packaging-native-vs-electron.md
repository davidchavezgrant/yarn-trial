# How hard is a native Mac tool instead of the web UI? — feasibility, measured

Question: could this run as a native Mac app rather than `npm run ui` + a browser?

Short answer: **the driver is not the obstacle, and that is the surprise.** The work is a
straight port of ~1,500 lines of orchestration logic, not a fight with the automation stack.
Roughly **2–4 days for a real SwiftUI tool**, or **an afternoon** for a native shell around
the existing TypeScript.

## The finding that decides it

The npm package `@trycua/cua-driver` ships **only JS/TS bindings** — no `.dylib`, no headers,
no Swift. On first reading that suggests a native port needs an FFI bridge or a fork.

It does not, because the actual driver is a **standalone 49MB binary** at
`/Applications/CuaDriver.app/Contents/MacOS/cua-driver`, and it exposes the whole tool surface
on the command line. Verified directly:

```
$ cua-driver call list_windows '{}'
{ "current_space_id": null, "windows": [ { "app_name": "Google Chrome", ... } ] }

$ cua-driver call get_window_state '{"pid":67507,"window_id":24047}'
{ "element_count": 333, "elements": [ ... ] }
```

Same JSON our TypeScript receives, no session handshake, no Node. `serve` additionally runs
it as a daemon over a socket. So **a Swift app can drive the target app today** via
`Process` + JSON, or over the socket for lower per-call overhead.

This also means our existing `src/driver.ts` boundary (the one module importing the package)
is the *only* file with a hard Node dependency, and it is 120 lines.

## What a native port actually costs

| Piece | Lines | Port difficulty | Why |
|---|---|---|---|
| `driver.ts` | 120 | **Easy** | Replace UniFFI calls with `Process`/socket + `Codable`. The tool names and JSON payloads are unchanged. |
| `types.ts` | 92 | **Easy** | Interfaces → `Codable` structs. |
| `harness.ts` | 762 | **Moderate** | Pure logic (verify, scope graph, prompt audit, staging). Mostly mechanical; the AppleScript/JXA staging becomes *simpler* in Swift — direct AppKit `NSScreen` and AX API calls instead of shelling out to `osascript`. |
| `agent.ts` | 723 | **Moderate** | The loop is straightforward; the work is the Anthropic tool-use protocol. |
| `ui.ts` | 375 | **Rewrite** | HTML → SwiftUI. Genuinely nicer natively: a real list, `NSWorkspace` app enumeration with icons, no SSE plumbing. |
| `axdom.swift` | 120 | **Delete** | Already Swift. In a native app it stops being a subprocess and becomes a function call — the frame-geometry join and the 4s timeout guard both disappear. |

**Net: ~1,500 lines to port, ~500 to rewrite, 120 to delete.**

## The one real gap: no official Anthropic Swift SDK

`anthropics/anthropic-sdk-swift` does not exist (404). Options, cheapest first:

1. **Hand-roll the Messages API over `URLSession`.** We use one endpoint with tool use and
   image blocks. Perhaps 200–300 lines of `Codable`, and we control retry/streaming.
2. **A community SwiftAnthropic package** — faster to start, a dependency to vet, and our
   tool-use + vision usage is exactly where third-party wrappers tend to lag.
3. **Keep the model calls in a Node sidecar** and let Swift own only UI + driver. Hybrid,
   defeats much of the point.

This is the single largest chunk of genuinely new code, and it is well-understood work.

## What gets better natively

- **`axdom` stops being a subprocess.** Today we shell out to a Swift binary and rejoin its
  output by frame geometry because Node cannot call the Accessibility C API (LIMITATIONS
  §11). In-process, that whole join heuristic and its failure modes vanish.
- **Window staging gets more reliable.** Today's `osascript -l JavaScript` is why we hit
  "fullscreen apps report zero windows" (LIMITATIONS §3) and why an error surfaced as
  `Command failed: osascript -l JavaScript -e`. Native `NSScreen` + `AXUIElement` is direct,
  typed, and debuggable.
- **App picker.** `NSWorkspace.runningApplications` + `NSMetadataQuery` gives names, bundle
  IDs and **icons**, replacing our directory scan of `/Applications`.
- **Screen recording.** ScreenCaptureKit delivers no frames to an *unsigned CLI* on macOS 26
  (LIMITATIONS §3) — the reason we assemble ~4fps snapshots via ffmpeg. A **signed app
  bundle is not subject to that**, so a native tool could do real 30–60fps window capture
  and drop the ffmpeg dependency entirely. For a company shipping demo videos this is the
  strongest single argument.
- **Permissions.** One signed bundle holds Accessibility + Screen Recording, instead of the
  grants attaching to whichever terminal ran `npm`.

## What gets worse

- **Iteration speed.** Today: edit a `.ts`, re-run. Native: compile, and the measurement
  scripts (`prior.ts`, `canvas-probe.ts`) that we write and throw away become expensive.
- **Two languages, or a rewrite.** Half-porting means maintaining both.
- **The docs and measurement discipline are in this repo.** All the correction notes,
  provenance rules and A/B artifacts assume this codebase.

## Electron changes the answer (David, 2026-07-29)

The framing above compares "Node CLI" against "native Swift" and misses the option that
matters: **Yarn proper is an Electron app**, so an Electron host is not a compromise between
the two — it is the actual deployment target. Checking the driver package settles it.

`@trycua/cua-driver` ships a **dedicated `/electron` entry point** and documents Electron
integration explicitly. This is first-party support, not a workaround:

- `requestMacOSPermissions()` / `hasRequiredMacOSPermissions()` / `openMacOSScreenRecordingSettings()`,
  callable from the Electron main process after `app.whenReady()`.
- Critically on permissions: *"These functions run in the importing host process, so macOS
  attributes their requests to the host rather than to the npm package or child driver."*
  That is precisely the attribution problem that makes our terminal-granted permissions
  awkward today.
- The package ships a **copy-mode build of the `@ubjs/node` N-API runtime** specifically
  because "upstream returns Rust-owned memory through external ArrayBuffers, which Electron
  20+ intentionally reject because of V8's memory cage." Someone already hit that wall and
  fixed it upstream — we would not.
- `EmbeddedCuaDriverHost` (the `/embedded` subpath) manages the daemon lifecycle in-process:
  concurrency-safe `start()`, idempotent `stop()`, generation-tracked connections, and a
  parent-liveness pipe so the daemon cannot outlive a host crash.

Two operational notes from the README that we would otherwise have discovered the hard way:
the app **must spawn the daemon from the process owning the grants** (going through a
terminal, `open`, or `NSWorkspace` breaks the responsibility chain — which is exactly what
our current setup does), and the `cua-driver` executable must ship **outside ASAR** with its
executable bit preserved, signed before the enclosing app is signed and notarized.

### Code cost: the lowest of the three options

| Option | New code | Reused |
|---|---|---|
| **Electron shell** | **~200–250 lines** | *All* of `agent.ts`, `harness.ts`, `driver.ts`, `types.ts`, `explore.ts` — unchanged |
| SwiftUI shell | ~250–300 | Engine reused, but via subprocess |
| Full native port | ~1,800–2,200 | Nothing |

The Electron figure is the smallest *and* the least risky, because it is the only one where
the agent engine is imported rather than ported or shelled out to. Concretely: a `main.ts`
(BrowserWindow, permission gate, IPC — ~120 lines) and a renderer that is largely our
existing `PAGE` markup with `ipcRenderer.on('line')` in place of `EventSource` (~100 lines).
`ui.ts`'s HTTP server, SSE plumbing and `/apps` endpoint all disappear; app enumeration
becomes `systemPreferences` + a directory scan we already have.

### What it buys over the web UI

- **Permissions attributed to one signed app**, not to whichever terminal ran `npm` —
  and this is the supported path, not a hack.
- **Signed bundle** ⇒ ScreenCaptureKit delivers frames (LIMITATIONS §3), so real 30–60fps
  window capture instead of ~4fps snapshots + ffmpeg. Same win as the Swift option.
- **It is the environment the feature actually ships into.** Anything we learn about
  permissions, daemon lifecycle, or capture transfers directly to Yarn's app instead of
  being re-learned.
- Distribution is a `.app` rather than "install Node, clone a repo".

### What it does not fix

Electron is a packaging decision, not a capability one. The AX flakiness (§10), the
wrong-scope verification gap (§8), and native-AppKit generalization are all untouched. It
also adds a build/packaging step (electron-builder, signing, notarization) that the current
`npm run ui` does not have.

## Recommendation

**Superseded by the Electron section above.** The reasoning below still holds for *Swift*
specifically — it remains the wrong investment right now. Electron is the cheaper and more
faithful option whenever a packaged UI is wanted, because it is both the smallest diff and
the actual deployment target.

**Not yet, and the reason is scope rather than difficulty.** The current frontier is
reliability and generalization (native AppKit targets, ~1-in-3 AX aborts). A port advances
neither and pauses both for several days.

Two thresholds that would flip it:

1. **Demo quality becomes the deliverable** — signed-bundle ScreenCaptureKit at 30–60fps is
   a real product difference over 4fps snapshots.
2. **It ships on customer machines** — a signed app with its own permissions is the only
   sane distribution; nobody installs Node to watch a demo.

Cheap middle path if a native feel is wanted sooner: keep the TypeScript engine and put a
thin SwiftUI front end over it, launching runs as subprocesses and reading the same
`out/runs/*.json` the web UI already streams. No engine rewrite, and it makes the recording
question answerable independently (a signed Swift wrapper can own capture even while Node
owns the loop).

## How much code, exactly

Today's `src/ui.ts` is 376 lines:

| Part | Lines |
|---|---|
| Server logic (app list, spawn, SSE, hygiene gate) | 197 |
| Inline HTML + CSS | 64 |
| Browser JS (search filter, hint mirror, log rendering) | 115 |

### Option A — SwiftUI shell over the existing engine: **~250–300 lines**

*Smaller than what it replaces*, because most of `ui.ts` exists to bridge a browser to a
process, and that bridge disappears when the UI **is** the process. Both load-bearing pieces
verified compiling and running today under plain `swiftc`, no Xcode project:

```swift
NSWorkspace.shared.runningApplications        // 13 apps WITH icons, one expression
    .filter { $0.activationPolicy == .regular }
Process() + Pipe()                            // subprocess + stdout streaming
```

| Piece | Lines | Note |
|---|---|---|
| App list + search | ~40 | `NSWorkspace` replaces the `/Applications` scan; `.searchable` replaces the filter JS |
| Run launch + live stdout | ~60 | `Process` + `FileHandle.readabilityHandler` replaces spawn + SSE + EventSource |
| Log view with colour rules | ~70 | The one place SwiftUI is wordier than HTML |
| Prompt-hygiene mirror | ~30 | Port the `auditTaskPrompt` regexes, or shell out to the real one |
| Concurrency guard, chrome, state | ~60 | `@State` replaces the server-side `current` singleton |

**Deleted outright**: the HTTP server, SSE plumbing, the `/apps` JSON endpoint, the
duplicated browser-vs-server hygiene check, and `osascript` for app enumeration.

### Option B — full native port: **~1,800–2,200 lines**

`driver.ts` (120) + `types.ts` (92) + `harness.ts` (762) + `agent.ts` (723) + the ~250–300
above, minus `axdom.swift` (120 — becomes an in-process call), plus ~200–300 for a
hand-rolled Anthropic client. 2–4 days.

Not counted in either: `explore.ts` (315) and the probes. Exploration can stay a CLI — it
runs once per app and nobody watches it.
