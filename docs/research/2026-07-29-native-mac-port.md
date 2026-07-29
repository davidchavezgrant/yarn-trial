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

## Recommendation

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
`out/runs/*.json` the web UI already streams. An afternoon, no engine rewrite, and it makes
the recording question answerable independently (a signed Swift wrapper can own capture even
while Node owns the loop).
