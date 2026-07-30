# Motion data

`motion-constants.json` and `motion-segments.json` are the only files the render path reads. Both
are committed, and both are produced by `scripts/fit-motion.py` from two corpora that are **not**
in git — together they are 185MB, and nothing but a re-fit needs them.

## Committed

| File | What it is |
|---|---|
| `motion-constants.json` | Fitted statistics: click dwell, inter-key intervals, per-distance durations, curvature, speed ratios. |
| `motion-segments.json` | 1,654 real approach movements, normalized so they can be replayed onto new endpoints. ~2.3MB. |

Both carry a `fittedFrom` block naming the corpora and the generation timestamp.

## Not committed

| Directory | Source |
|---|---|
| `cursor-keyboard-dataset-2026-07-30/` | 113 raw `recording.input-events.json` objects from the `yarn-assets` S3 bucket, pattern `screenRecordings/<capture_id>/recording.input-events.json`. Filters and per-file checksums are in its `manifest.json`; verify with `shasum -a 256 -c SHA256SUMS`. |
| `cursor-smoothed-dataset/` | The same 113 recordings after Yarn's editor cursor pipeline (`hypersphere/src/utils/recordings/screenRecordings/getSmoothedCursorData.js`, default brand config). Regenerate with `npx tsx src/analysis/build-smoothed-dataset.ts <raw-dir> <out-dir>` in `agent-recorder-prototype`. |

To re-fit, restore both directories here and run `python3 scripts/fit-motion.py`.

## Which corpus feeds what

Motion comes from the **smoothed** set, because that is the motion a viewer actually sees: the
editor decimates raw input to every third sample and drives a critically-damped spring
(mass 1, stiffness 170, damping 26) over it. The difference is large enough to invert conclusions —
raw movement covers 51% of its distance by t=0.2 where rendered covers 18%, and peak speed falls
from 10.4x the mean to 2.5x. An earlier fit used the raw events and taught the synthesizer to
reproduce jitter the spring removes before anyone sees it.

Keystroke timing and click dwell still come from the **raw** set, which is the only place key and
button events exist. The smoothed set carries the click-squash animation instead, and that has a
12-frame minimum hold — dwell measured from it would be the animation's duration, not the press.
