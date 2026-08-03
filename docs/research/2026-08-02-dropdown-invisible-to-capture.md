# The cursor-style dropdown never reaches the recording

**Date**: 2026-08-02
**Trigger**: `PASS-cdp-grounded-no-vision-humanized.mp4` — at ~23s the cursor clicks the Cursor
Style control and nothing opens. It clicks again 4s later, 2px away, and the value has changed.
**Verdict**: **a Yarn rendering bug, not a capture bug.** The menu opens in the DOM and paints
zero pixels — for a human at the keyboard as much as for the agent. The recording is accurate.

## What the video shows is what was on screen

Source run: `out/bench/live/2026-08-02T18-51-49-069-yarn` (cdp, grounded, no-vision, judged PASS).

The dropdown is open by every measure the DOM offers, and absent from every pixel anyone can
capture. Reproduced live against Yarn 0.0.119 over CDP on 2026-08-02:

| channel | sees the menu? |
|---|---|
| `page.screenshot()` (what `--record` captures every frame through) | no |
| `screencapture` of the whole display | no |
| element-scoped raster of the listbox's own bounding box | no — renders the page *underneath* |
| cua driver window snapshot (the ax backend's channel, different code entirely) | no |
| **David clicking it by hand** | **no** |

Meanwhile the page insists it is there and visible:

```
listbox [ref=e447] [box=1430,219,124,82]
  option "Arrow-first"  [active] [selected] [box=1434,224,116,24]
  option "Pointer-first"                    [box=1434,248,116,24]
  option "Original"                         [box=1434,272,116,24]
```

`div.dpSelectMenu.forceDarkTheme`, `data-state="open"`, `opacity: 1`, `visibility: visible`,
`display: flex`, `z-index: 500`, no transform, no clip, no filter, no pending animations. And
`document.elementFromPoint()` at the menu's centre returns a `SPAN` **inside the listbox** — so
Chromium's hit-testing puts it topmost. It is laid out, it is hit-testable, and the compositor
draws nothing for it.

Not an artifact of how it was opened. Same result for a CDP mouse click, for keyboard `Enter`,
for keyboard `Space`, and with Yarn made genuinely key at the AppKit level first (System Events
`set frontmost`, the same activation `AxBackend.acquire` performs) rather than merely raised by
`bringToFront()`.

## What was ruled out along the way

**Undersampling.** 26 consecutive recording frames spanning the 4.4s the dropdown is open
(31.4s → 35.7s of the capture, ~every 350ms) are pixel-identical in the region it occupies. The
only motion is the text caret. `pixelDelta` for that step is exactly 0, and so is every other cdp
run in the matrix that opens this control (~30 runs across 08-01 and 08-02).

**The capture channel.** The ax backend misses it through a completely different path — cua's
macOS window snapshot — and so does a full-display `screencapture`, which is by definition what a
human sees.

**A native `<select>` popup.** Worth recording as a separate true finding, because it will bite a
different target app one day: a real native popup **is** invisible to `Page.captureScreenshot` and
to window-scoped capture, and visible only to a display capture. Measured in a control page,
headful Chrome, both channels at the same instant:

| control | ai snapshot | `page.screenshot()` | display capture |
|---|---|---|---|
| native `<select>`, open | options have **no ref**, `[box=0,0,0,0]` | absent | **present** |
| DOM listbox, open | refs and real boxes | present | present |

Yarn's control is the second row on addressability — real refs, real boxes, options that mount
only while open — so it is a DOM menu, and a DOM menu is page content that a page screenshot
cannot miss. That is what forced the conclusion that it is not being painted at all.

**A separate Electron window.** The CDP target list is unchanged while the menu is open: one page,
plus the extension service worker and a blob worker. No new target, no new window.

## Two things follow

**For Yarn (the product).** `div.dpSelectMenu` mounts, lays out, and never paints. The settings
panel it lives in renders fine, so this is specific to the select menu — worth a bug with the
build (0.0.119), the selector, and the note that hit-testing still targets it, which means the
control is *operable while invisible*: keyboard-navigable, clickable if you know where the items
are, and completely unusable if you don't. That is a nastier failure than a menu that refuses to
open, because nothing about it looks broken until you try to read it.

**For the demo.** The agent succeeded because it drives the DOM, and the DOM was fully functional.
That is a genuinely good property to be able to state — the agent completed a task through a
control a human cannot see — but the filmed artifact of it is four seconds of nothing. Until Yarn
fixes the menu, a filmed take of the cursor-style task cannot show its central action, and no
amount of capture work changes that. Options, in order of honesty:

1. **Wait for the fix.** The task is the canonical one precisely because it is small; this is a
   rendering bug in the target, and the recording is correct to show what happened.
2. **Film a different task.** Any control whose state change is visible in the page.
3. **Synthesize the menu at humanize time** from data the run already has (option names, rects,
   selected index, open/close timestamps), the way the renderer already synthesizes the hover tint
   the app never painted. This would draw a menu that *no one ever saw* — a further step than the
   hover tint, which reconstructs a state the app genuinely entered. Available, and it should be a
   deliberate choice, not a drift.

Application-scoped capture (SCK filtered to all of one app's windows, which `native/liveview.swift`
already has the machinery for) remains worth doing for the native-`<select>` class above — but it
would not have fixed this one, and should not be built on the premise that it would.

## Where the evidence lives

Run `2026-08-02T18-51-49-069-yarn` (`steps/agent-step-5.png` is the post-click frame with the
control closed); ax counterpart `2026-08-01T19-54-15-015-yarn/steps/agent-step-4.png`. The live
probes were throwaway scripts against Yarn 0.0.119 over `--remote-debugging-port=9333`; the
captures are in the session scratchpad, not committed.
