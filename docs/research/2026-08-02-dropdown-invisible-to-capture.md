# The cursor-style dropdown never reaches the recording

**Date**: 2026-08-02
**Trigger**: `PASS-cdp-grounded-no-vision-humanized.mp4` — at ~23s the cursor clicks the Cursor
Style control and nothing opens. It clicks again 4s later, 2px away, and the value has changed.
**Status**: phenomenon proven and reproducible; the mechanism is narrowed to two candidates and
needs one live check against Yarn to close.

## What is proven

Source run: `out/bench/live/2026-08-02T18-51-49-069-yarn` (cdp, grounded, no-vision, judged PASS).

**The dropdown is open — the tree says so, the pixels do not.** Step 5 clicks the Cursor Style
combobox; its expectation ("Pointer-first and Original appear") verifies against the post-action
observation, and step 6 clicks `ref=f1e1885`, an option with rect `(1434, 248.47, 116, 24)` —
directly below the combobox at `(1433, 223.97, 112, 25)`. The interactive-node count collapses
102 → 15 for that one observation, which is what an open modal layer looks like.

Over the same interval the capture shows nothing:

- `pixelDelta` for the open-the-dropdown step is **exactly 0**.
- The post-click observation frame (`steps/agent-step-5.png`) shows the control closed, reading
  "Arrow-first".
- **26 consecutive recording frames** spanning the 4.4s the dropdown is open (31.4s → 35.7s of
  the capture, sampled ~every 350ms) are pixel-identical in the region the dropdown occupies.
  The only motion is the text caret. This rules out undersampling: it is not that the poller
  missed the open state, it is that no captured pixel ever contained it.

**It is not this run.** Every cdp run in the matrix that opens this control records
`pixelDelta: 0` on that step (~30 runs across 2026-08-01 and 2026-08-02). It is not one bad take.

**It is not the cdp channel either — the ax backend misses it too.** On ax the options come back
as `AXMenuItem` and the observation screenshot is a macOS *window* snapshot from the cua driver,
a completely different capture path. `out/bench/live/2026-08-01T19-54-15-015-yarn/steps/agent-step-4.png`
is that window snapshot taken immediately after the click that opened the dropdown, and it shows
the panel with Cursor Style closed on "Arrow-first". Both capture channels, both backends, no
dropdown. So the dropdown is not painted into the Yarn **window**.

## The control experiment

`scripts`-free probe, headful Chrome, a page holding a native `<select>` and a DOM listbox with
identical options, captured through both channels at the same instant (display capture first, so
the page screenshot cannot be accused of dismissing anything):

| control | ai snapshot | `page.screenshot()` | `screencapture` (display) |
|---|---|---|---|
| native `<select>`, popup open | options have **no ref**, `[box=0,0,0,0]` | **absent** | **present** — a real macOS popup floating outside the window |
| DOM listbox, open | options have refs and real boxes | **present** | present |

So a native popup is an OS window: invisible to `Page.captureScreenshot`, invisible to a
window-scoped capture, visible only to a display capture. That is a real and sufficient mechanism
for what the video shows — and it is worth knowing on its own, because it applies to every native
`<select>` in every target app we will ever film.

## What is not proven

Yarn's control matches **neither** row cleanly: its options carry refs and real boxes (the DOM
row) yet appear in no capture (the native row). Two candidates remain:

1. **Electron's Chromium exposes an open native popup's geometry** where the Chrome I probed did
   not, making Yarn a plain native `<select>` after all. Version skew (Electron 38 / Chromium
   140 vs installed Chrome) is a plausible cause.
2. **The dropdown renders in a separate Electron child window.** This would also explain the
   102 → 15 node collapse — 15 interactive nodes is about the size of a popup window's whole
   tree, not of a modal layer inside a large app.

These predict different fixes, so the difference is worth one experiment and not worth guessing.

**The experiment**: quit Yarn, relaunch it under `src/backends/electron-attach.ts` so the debug
port is up, click Cursor Style over CDP, and take `page.screenshot()`, `screencapture`, and
`chrome://inspect`'s target list at the same moment. Two minutes. It needs the app quit, which is
the operator's call — Yarn was running without a debug port when this was written.

## Why it matters beyond the video

The four verification layers all passed this run and the judge graded it PASS, correctly: the
setting really did change. What no layer can see is that **the demo does not show the work**. A
filmed run whose central action is invisible is a failed deliverable even when it is a successful
run, and `pixelDelta` — the layer built for exactly "the pixels did not move" — recorded 0 and
stayed advisory, as designed.

If the mechanism turns out to be a separate window, the capture fix is **application-scoped**
capture rather than window-scoped: ScreenCaptureKit's filter can include every window belonging
to one application, which catches the app's own popups while still keeping unrelated personal
content off the recording. `native/liveview.swift` already links SCK.

The other option is to synthesize the open menu at humanize time from data the run already has
(option names, rects, selected index, open/close timestamps), the way the renderer already
synthesizes the hover tint the app never painted. It is cheaper and it is a fabrication; the
hover-tint precedent argues it is the same kind of fabrication, but that is a call to make
deliberately rather than by drifting into it.

Worth telling Jasper either way: Yarn's own recorder is an OS-level screen recorder, so this is
most likely an artifact of the POC's capture channel rather than something their pipeline would
inherit. Whether their capture is display-, application-, or window-scoped decides it, and that
is a question we can just ask.
