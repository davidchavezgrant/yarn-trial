"""Fit cursor and keystroke constants from the human input corpus.

Reads data/cursor-keyboard-dataset-2026-07-30/ (113 recordings, 4.6 hours, 365k events from 8
creators, captured by Yarn's own app) and writes two files the render path consumes:

    data/motion-constants.json   the fitted statistics
    data/motion-segments.json    real approach movements, replayable onto new endpoints

Both are committed so rendering never needs the 82MB corpus.

WHY A SEGMENT LIBRARY AND NOT JUST CONSTANTS. Human pointer motion is wrong in three independent
ways from the obvious model of a smooth symmetric glide along a straight line: it is asymmetric
(median 90% of distance covered in the first half of the time), it is not smooth (peak speed ~10x
the mean, with a third of mid-flight samples nearly stopped), and it is not straight (median
deviation ~9% of the distance). Duration barely follows from distance either — within one distance
bucket the p10-to-p90 spread is 3-5x, which is why Fitts's law fits at R^2=0.09. Replaying a real
segment reproduces all of that for free.

Run: python3 scripts/fit-motion.py
"""

import json
import math
import os
import statistics
import sys
from collections import Counter, defaultdict

DATASET = "data/cursor-keyboard-dataset-2026-07-30"
OUT_CONSTANTS = "data/motion-constants.json"
OUT_SEGMENTS = "data/motion-segments.json"

# Segmentation. An "approach" is the motion burst that terminates in a click: walk back from each
# mouse `down` until the trail goes idle or the movement has been running too long to be one reach.
IDLE_GAP_S = 0.25
MAX_APPROACH_S = 2.5
MIN_SAMPLES = 12
MIN_DISTANCE_PX = 50
MIN_DURATION_S = 0.15

# Inter-key gaps above this are the user stopping to think, not typing rhythm. Uncapped, the p99
# lands at 36 seconds and describes idle time rather than the distribution we want to reproduce.
MAX_IKI_MS = 2000

# Cap on stored samples per segment, holding the library near 3MB. Endpoints are always kept.
MAX_SEGMENT_SAMPLES = 120

# The renderer's cursor vocabulary. The corpus also contains `custom`, `resizeUpDown` and a
# `windowResize*` family with no counterpart in the renderer; those fall back to arrow rather than
# widening the vocabulary for cursors we cannot draw.
KNOWN_CURSORS = {
    "arrow", "pointingHand", "iBeam", "closedHand", "openHand",
    "resizeLeftRight", "operationNotAllowed",
}


def percentile(values, p):
    """Linear-interpolated percentile. Avoids a numpy dependency nothing else here needs."""
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    k = (len(ordered) - 1) * p
    lo = math.floor(k)
    hi = math.ceil(k)
    if lo == hi:
        return float(ordered[int(k)])

    return float(ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo))


def load_manifest():
    with open(os.path.join(DATASET, "manifest.json")) as f:
        return json.load(f)


def octant_of(dx, dy):
    """Direction octant 0-7. Must match octantOf() in src/track.ts or replay picks wrong shapes."""
    angle = (math.atan2(dy, dx) + math.tau) % math.tau

    return int(angle / math.tau * 8) % 8


def decimate(indices, limit):
    """Uniformly thin a sample list, always keeping the first and last."""
    if len(indices) <= limit:
        return indices
    step = (len(indices) - 1) / (limit - 1)
    picked = [indices[min(len(indices) - 1, round(i * step))] for i in range(limit)]

    return sorted(set(picked))


def extract(path, width, height):
    """Pull approach segments and typing/click statistics out of one recording."""
    with open(path) as f:
        events = json.load(f)

    segments = []
    dwells = []
    ikis = []
    holds = []
    key_types = Counter()
    move_dts = []

    # Mouse samples in pixels, keeping `down`/`up` so an approach can terminate on its click.
    mouse = [
        (e["time"]["seconds"], e["x"] * width, e["y"] * height, e["mouseEventType"],
         e.get("cursorType", "arrow"))
        for e in events
        if e.get("type") == "mouse" and e.get("mouseEventType") in ("moved", "dragged", "down", "up")
    ]

    for a, b in zip(mouse, mouse[1:]):
        if a[3] in ("moved", "dragged") and b[3] in ("moved", "dragged"):
            dt = b[0] - a[0]
            if 0 < dt < 1:
                move_dts.append(dt)

    # Press-to-release. Drags are kept: excluding them collapses the p90 and the renderer draws a
    # held button the same way regardless of whether the pointer moved during it.
    pending_down = None
    for t, x, y, kind, _cursor in mouse:
        if kind == "down":
            pending_down = t
        elif kind == "up" and pending_down is not None:
            d = t - pending_down
            if 0 < d < 2:
                dwells.append(d * 1000)
            pending_down = None

    for i, (t, x, y, kind, cursor) in enumerate(mouse):
        if kind != "down":
            continue
        j = i - 1
        while j > 0 and t - mouse[j][0] < MAX_APPROACH_S and mouse[j][0] - mouse[j - 1][0] < IDLE_GAP_S:
            j -= 1
        # The `down` itself is the segment's terminal sample; without it the approach is truncated
        # short of the target and every fitted duration reads ~20% low.
        seg = mouse[j:i + 1]
        if len(seg) < MIN_SAMPLES:
            continue
        x0, y0 = seg[0][1], seg[0][2]
        x1, y1 = seg[-1][1], seg[-1][2]
        distance = math.hypot(x1 - x0, y1 - y0)
        duration = seg[-1][0] - seg[0][0]
        if distance < MIN_DISTANCE_PX or not MIN_DURATION_S < duration < MAX_APPROACH_S:
            continue

        ux, uy = (x1 - x0) / distance, (y1 - y0) / distance
        keep = decimate(list(range(len(seg))), MAX_SEGMENT_SAMPLES)
        par, perp, times = [], [], []
        for k in keep:
            dx, dy = seg[k][1] - x0, seg[k][2] - y0
            par.append((dx * ux + dy * uy) / distance)
            # SIGNED projection onto the perpendicular basis. Storing the absolute value would bend
            # every replayed curve the same direction, which reads as obviously synthetic.
            perp.append((-dx * uy + dy * ux) / distance)
            times.append((seg[k][0] - seg[0][0]) * 1000)

        segments.append({
            "logDistance": int(math.floor(math.log2(max(distance, 1)))),
            "octant": octant_of(x1 - x0, y1 - y0),
            "distancePx": round(distance, 2),
            "durationMs": round(duration * 1000, 2),
            "par": [round(v, 5) for v in par],
            "perp": [round(v, 5) for v in perp],
            "t": [round(v, 2) for v in times],
            "cursorType": cursor if cursor in KNOWN_CURSORS else "arrow",
        })

    keys = [e for e in events if e.get("type") == "keyboard"]
    downs = [e for e in keys if e.get("keyboardEventType") == "down" and not e.get("isARepeat")]
    for e in downs:
        key_types[e.get("keyType", "character")] += 1
    for a, b in zip(downs, downs[1:]):
        gap = (b["time"]["seconds"] - a["time"]["seconds"]) * 1000
        if 0 < gap <= MAX_IKI_MS:
            ikis.append((gap, a.get("keyType")))

    # Hold matches on keyType AND keySymbol: keyType alone pairs a down with an unrelated key's up
    # and drags the median down by ~13ms.
    pending_keys = {}
    for e in keys:
        ident = (e.get("keyType"), e.get("keySymbol"))
        if e["keyboardEventType"] == "down":
            pending_keys[ident] = e["time"]["seconds"]
        elif ident in pending_keys:
            held = e["time"]["seconds"] - pending_keys.pop(ident)
            if 0 < held < 1:
                holds.append(held * 1000)

    return segments, dwells, ikis, holds, key_types, move_dts


def main():
    if not os.path.isdir(DATASET):
        print(f"missing {DATASET}", file=sys.stderr)

        return 1

    manifest = load_manifest()
    all_segments = []
    dwells, holds, move_dts = [], [], []
    ikis = []
    key_types = Counter()

    for record in manifest["recordings"]:
        path = os.path.join(DATASET, record["file"])
        if not os.path.exists(path):
            continue
        s, d, i, h, kt, dts = extract(path, record["width"], record["height"])
        all_segments.extend(s)
        dwells.extend(d)
        ikis.extend(i)
        holds.extend(h)
        key_types.update(kt)
        move_dts.extend(dts)

    # Speed metrics use the UNWEIGHTED mean of instantaneous speeds. Time-weighting (path length
    # over duration) gives a peak ratio near 221 and a near-stopped fraction of 0.06, because 19% of
    # intra-segment steps are under 2ms and dominate a weighted average.
    peak_ratios, near_stopped, perp_fracs = [], [], []
    for seg in all_segments:
        speeds = []
        for k in range(1, len(seg["t"])):
            dt = seg["t"][k] - seg["t"][k - 1]
            if dt <= 0:
                continue
            step = math.hypot(
                (seg["par"][k] - seg["par"][k - 1]) * seg["distancePx"],
                (seg["perp"][k] - seg["perp"][k - 1]) * seg["distancePx"],
            )
            speeds.append(step / dt)
        if not speeds:
            continue
        mean = sum(speeds) / len(speeds)
        if mean > 0:
            peak_ratios.append(max(speeds) / mean)
            near_stopped.append(sum(1 for s in speeds if s < 0.05 * mean) / len(speeds))
        perp_fracs.append(max(abs(v) for v in seg["perp"]))

    by_bucket = defaultdict(list)
    for seg in all_segments:
        by_bucket[seg["logDistance"]].append(seg["durationMs"])

    iki_values = [g for g, _ in ikis]
    after_space = [g for g, kind in ikis if kind == "space"]
    mid_word = [g for g, kind in ikis if kind != "space"]
    corrections = key_types.get("delete", 0)
    total_keys = sum(key_types.values())

    constants = {
        "fittedFrom": {
            "dataset": os.path.basename(DATASET),
            "recordings": len(manifest["recordings"]),
            "movementEvents": sum(r["movement_event_count"] for r in manifest["recordings"]),
            "generatedAt": manifest["generated_at"],
        },
        "durationByLogDistance": {
            str(b): {
                "p10": round(percentile(v, 0.10), 1),
                "p50": round(percentile(v, 0.50), 1),
                "p90": round(percentile(v, 0.90), 1),
                "n": len(v),
            }
            for b, v in sorted(by_bucket.items())
        },
        "clickDwellMs": {
            "p10": round(percentile(dwells, 0.10), 1),
            "p50": round(percentile(dwells, 0.50), 1),
            "p90": round(percentile(dwells, 0.90), 1),
        },
        "ikiMs": {
            "p10": round(percentile(iki_values, 0.10), 1),
            "p25": round(percentile(iki_values, 0.25), 1),
            "p50": round(percentile(iki_values, 0.50), 1),
            "p75": round(percentile(iki_values, 0.75), 1),
            "p90": round(percentile(iki_values, 0.90), 1),
            "p99": round(percentile(iki_values, 0.99), 1),
        },
        "ikiAfterSpaceMs": round(statistics.median(after_space), 1) if after_space else 0,
        "keyHoldMs": round(statistics.median(holds), 1) if holds else 0,
        "correctionRate": round(corrections / total_keys, 4) if total_keys else 0,
        "perpDeviationFrac": {
            "p50": round(percentile(perp_fracs, 0.50), 4),
            "p75": round(percentile(perp_fracs, 0.75), 4),
            "p90": round(percentile(perp_fracs, 0.90), 4),
        },
        "peakSpeedRatio": {
            "p10": round(percentile(peak_ratios, 0.10), 2),
            "p50": round(percentile(peak_ratios, 0.50), 2),
            "p90": round(percentile(peak_ratios, 0.90), 2),
        },
        "nearStoppedFrac": {
            "p50": round(percentile(near_stopped, 0.50), 3),
            "p90": round(percentile(near_stopped, 0.90), 3),
        },
        "sampleHz": round(1 / statistics.median(move_dts), 1) if move_dts else 0,
    }

    with open(OUT_CONSTANTS, "w") as f:
        json.dump(constants, f, indent=1)
    with open(OUT_SEGMENTS, "w") as f:
        json.dump({
            "fittedFrom": {
                "dataset": os.path.basename(DATASET),
                "generatedAt": manifest["generated_at"],
            },
            "segments": all_segments,
        }, f)

    buckets = len({(s["logDistance"], s["octant"]) for s in all_segments})
    print(f"{len(all_segments)} segments across {buckets} (distance, direction) buckets")
    print(f"  {OUT_CONSTANTS}  {os.path.getsize(OUT_CONSTANTS) / 1024:.0f} KB")
    print(f"  {OUT_SEGMENTS}  {os.path.getsize(OUT_SEGMENTS) / 1024 / 1024:.1f} MB")
    print()
    print(f"sample rate      {constants['sampleHz']} Hz")
    print("click dwell      p10 {p10} / p50 {p50} / p90 {p90} ms".format(**constants["clickDwellMs"]))
    print("inter-key        p10 {p10} / p50 {p50} / p90 {p90} / p99 {p99} ms".format(**constants["ikiMs"]))
    print(f"  after space    {constants['ikiAfterSpaceMs']} ms (vs {round(statistics.median(mid_word), 1)} mid-word)")
    print(f"key hold         {constants['keyHoldMs']} ms")
    print(f"correction rate  {constants['correctionRate'] * 100:.2f}%")
    print("perp deviation   p50 {p50} / p75 {p75} / p90 {p90} of distance".format(**constants["perpDeviationFrac"]))
    print("peak/mean speed  p10 {p10} / p50 {p50} / p90 {p90}".format(**constants["peakSpeedRatio"]))
    print("near-stopped     p50 {p50} / p90 {p90} of mid-flight samples".format(**constants["nearStoppedFrac"]))
    print()
    # An exploratory pass over a 40-50 file subset reported dwell p10 8ms / p90 464ms and perp
    # deviation p50 0.076. These full-corpus figures supersede those. Re-running identical code on
    # different 45-file subsets swings dwell p10 between 12 and 61ms, so the gap is selection
    # variance in the old subset, not a regression here. Do not "correct" these toward the old ones.
    print("NOTE: these supersede earlier subset estimates; the differences are selection variance.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
