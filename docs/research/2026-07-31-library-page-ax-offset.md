# The Library-page AX offset: ~43px, source-level, cause not identified

**Status: open.** This documents an observed defect and the instrumentation added around it.
The root cause has not been identified — do not treat the mitigation as an explanation.

## What was observed

Run `2026-07-31T05-45-03-416-yarn` (Brew two-scene script task, ax backend, recorded).
Step 1 clicks `AXButton "New Draft"` on Yarn's Library page. In the humanized video the
cursor and hover highlight sit ~43px ABOVE the button.

The error is in the source data, not the render pipeline:

- Recording frame `f-00014.png` (1568×794): the button's blue box spans (1416,61)–(1505,82).
- Driver capture `trajectory/turn-00001/before.png` (1920×972): button at (1733,74)–(1843,101),
  which × 0.81667 = (1415,60)–(1505,82). The scale-only transform in `src/cursor/track.ts`
  (`toFramePixels`) is therefore correct.
- Run-log `targetRect` for the step: (1408,17,91,23) → bottom at y=40. **~43 frame px too high.**
- Driver `click_point` (1779.5, 35.0) → frame (1453, 29) vs true center (1460, 71.5). **Same
  ~43px error.** The driver's own `click.png` crosshair confirms it — drawn above the button.

So the AX frame reported for the element AND the click point the driver derived from it were
both wrong *together*, by the same amount. `rectAgrees` in the cursor pass cannot catch this
class (both sources share the error), and `correctToChange` — the independent pixel check —
self-disabled because the click navigated the whole page, exceeding `MAX_CORRECTION_AREA`.

The click still "succeeded" because AXPress actuates the element by identity, ignoring
coordinates — which is exactly why the recording lies: the video shows a miss, the app
registered a hit.

## What it is NOT

- Not run-wide: step 10's rect (410,38,88,23) matches its control, and step 11's rect
  (252,123,132,22) contains the "Cassidy" glyphs measured at (281,130)–(321,139). Only the
  Library page's rect was offset in this run.
- Not the humanizer transform (verified above; scale ratio and origin both check out).
- Not a stale observation from a previous page: the observation was taken on the Library page.

## Hypotheses, none confirmed

- Chromium's AX frame cache lagging a layout pass on the Library grid (the page had just
  finished a home-reset navigation).
- A transient banner/toolbar shifting content after the AX tree snapshot but before the
  screenshot — 43px is plausibly a toolbar height.
- An Electron window-inset accounting difference on this page only (traffic-light inset is
  ~25–28px, which does not match 43px cleanly).

## Mitigation shipped instead of a root cause

Demo actuation (recorded runs) re-resolves the target against a FRESH `get_window_state`
immediately before acting and clicks a real coordinate derived from that same snapshot —
so the rect the video is annotated with, the point the click lands on, and the pixels on
film all come from one snapshot. A stale-frame click then fails verification honestly and
the agent retries, instead of AXPress silently succeeding while the film shows a miss.

On the CDP backend the class is structurally absent: element boxes and screenshots come
from the same renderer space.

## Instrumentation added (to catch it if it recurs)

- Run logs now record the model id and per-step screenshot dimensions.
- Step screenshots land in a per-run directory instead of the shared `out/agent-step-N.png`
  (cross-run overwrites polluted this investigation).
- Evidence for this instance: `out/runs/2026-07-31T05-45-03-416-yarn.json` (step 1),
  `out/recording/2026-07-31T05-45-03-416-yarn/trajectory/turn-00001/` (before.png, click.png).
