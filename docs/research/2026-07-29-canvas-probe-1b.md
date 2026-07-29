# Canvas probe 1b — does a canvas target surface its state as text?

Date: 2026-07-29. Instrument: `src/canvas-probe.ts`. Target: Yarn's editor timeline, sync
points (the dots on a clip that Jasper's `markers.mp4` demos dragging).

## Answer

**No.** A sync point has no text readout and no AX element. Canvas verification cannot use
the text channel, and `done(success: true)` on a pure-canvas task must stay un-provable —
exactly the "honest limit" the plan reserved.

This is the expensive branch. It was worth measuring rather than assuming: the cheap branch
(a timecode appears when you select a sync point) would have made the whole task an ordinary
text-verified one.

## Three independent lines of evidence

1. **Structural.** The only elements whose frames cover the dot are `AXWindow` and
   `AXWebArea`, both 1920x1080. Nothing smaller. The dot is painted, not built.
2. **Neighbourhood.** Filtering the full tree to small elements inside the clip's band finds
   25 — every one a skip-segment widget (`AXButton "Edit Skip"`,
   `.ag-editor-timeline-clip-segment--skip-openSkipBtn`) or an icon. So the app *does* expose
   some timeline furniture to AX; sync points are simply not among it. The absence is
   specific, not a general AX blackout on that row.
3. **Behavioural.** Clicking the dot (local pixel delta 0.049 — it visibly highlighted; the
   decoy click on bare clip measured 0) added no timecode that a decoy click did not also
   add.

The tree does hold 42 timecode-shaped strings. All belong to other things: a playhead clock
that ANY click on the timeline moves, a total duration beside it, and ruler labels. None is a
readout of a particular sync point.

## What the probe had to grow to earn that answer

Each of these exists because an earlier version of the probe returned a **false**
"TEXT AFFORDANCE FOUND", and the correction is the transferable part.

- **A decoy click.** The original probe compared before/after around a single click, so the
  playhead clock — which moves on any click — read as evidence. On a canvas, "text appeared
  after I clicked the target" means nothing until you show the same text does *not* appear
  after clicking beside it. Keyed on `role|frame`, not on text: the clock keeps its slot and
  only its digits change, so a text key would let it re-qualify with a new number in it.
- **An idle control, not a no-op drag.** The first negative control was a same-from/same-to
  drag, which is not a null action: the mousedown alone scrubs the playhead. The control
  moved the very clock the probe then read as evidence. A control that acts is not a control.
- **Homing the viewport before surveying.** The app restores its last scroll position, so
  frame N showed a different region every run and coordinates read off one run landed on
  empty canvas the next. Panning to the origin first makes the survey reproducible — verified
  across two runs.
- **`WIDEN` made opt-in.** Defaulting to `/zoom|fit/` matched a transient "Add Zoom" button
  that only exists while a clip is selected, opened an animation editor, and sent an entire
  run probing the wrong screen (333 elements instead of 912). Panning reaches the same
  content without clicking into an unknown control.

## Two things that do not work on this app, measured

- **`set_value` on an `AXSlider`** (Timeline Zoom): both extremes rendered pixel-identical.
  Same failure as `set_value` on an Electron text field — it writes the AX value, fires no
  DOM event, React re-renders from its own state. Third confirmation of this pattern.
- **Local pixel delta as a hit test.** Intuitive and wrong here: because any click draws the
  playhead at the click point, the decoy's local delta once came out *higher* than the
  target's while the target demonstrably reacted. It is printed as a diagnostic and
  deliberately not a gate.

## Consequences for the design

- Step 4's **text channel is unavailable** for sync points; the **measure channel** was
  already ruled out (F4: no DOM route reaches this app). **Pixel is all that remains**, and
  it proves movement, not correctness.
- So a drag task here can be *performed* and *recorded* but not *verified* to the standard
  every other task in this repo meets. Do not let one pass as the other.
- The one genuinely promising lead: skip segments ARE addressable
  (`AXButton "Edit Skip"` with a stable class). A canvas task built on those would be
  text-verifiable. Worth knowing before choosing which canvas task to demo.

## Reproduce

```
SURVEY=5 DECOY_X=1270 DECOY_Y=812 npx tsx src/canvas-probe.ts 1019 812
```

Coordinates are read off `out/canvas-probe-survey-5.png` and are only stable because of the
homing pan; re-read them if the app's window size changes.
