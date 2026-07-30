"""Fit cursor and keystroke constants from the Yarn corpus.

Motion is fitted from data/cursor-smoothed-dataset/ — the same 113 recordings AFTER Yarn's
editor cursor pipeline, which is the motion a viewer actually sees. Keystroke statistics still
come from the raw data/cursor-keyboard-dataset-2026-07-30/, which is the only place key events
exist. Writes two files the render path consumes:

    data/motion-constants.json   the fitted statistics
    data/motion-segments.json    real approach movements, replayable onto new endpoints

Both are committed so rendering never needs either corpus.

FIT AGAINST RENDERED MOTION, NOT RAW EVENTS. Yarn's editor decimates raw input to every third
sample and drives a critically-damped spring (mass 1, stiffness 170, damping 26) toward what
remains. That transformation is large enough to invert conclusions, and it did: measured on the
same gestures, raw motion covers 51% of its distance by t=0.2 and rendered covers 18%; peak speed
falls from 10.4x the mean to 2.5x; submovement peaks drop from a median of 7 to 2. An earlier
version of this script fitted the raw events and taught the synthesizer to reproduce a jitter the
viewer never sees.

WHY A SEGMENT LIBRARY AND NOT JUST CONSTANTS. Even smoothed, the motion is asymmetric (18% of
distance by t=0.2, 67% by t=0.5) and curved (median deviation 5.5% of distance), and duration
barely follows from distance. Replaying a real segment reproduces all of it for free.

Run: python3 scripts/fit-motion.py
"""

import json
import math
import os
import statistics
import sys
from collections import Counter, defaultdict

# Motion comes from the smoothed (rendered) corpus; keystrokes from the raw one, which is the
# only place key events exist — the cursor pipeline does not carry them.
SMOOTHED = "data/cursor-smoothed-dataset"
DATASET = "data/cursor-keyboard-dataset-2026-07-30"
OUT_CONSTANTS = "data/motion-constants.json"
OUT_SEGMENTS = "data/motion-segments.json"

# Segmentation. An "approach" is the motion burst that terminates in a click: walk back from each
# press until the pointer has been parked, or the movement is too long to be one reach.
IDLE_GAP_S = 0.25
MAX_APPROACH_S = 2.5
MIN_SAMPLES = 12
MIN_DISTANCE_PX = 50
MIN_DURATION_S = 0.15

# Below this the spring has settled and the pointer counts as parked. Smoothed frames are a
# continuous 60fps stream with no gaps, so idleness is a distance test, not a timestamp gap.
STILL_PX = 0.5

# The click-squash scale rests at 1.0 and springs toward 0.85 while a button is down, so a dip
# below this marks a press. The smoothed corpus carries no button events of its own.
SQUASH_THRESHOLD = 0.995

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


def extract_motion(path):
    """Pull approach segments and click dwells out of one SMOOTHED recording.

    Frames are already dense and uniform at 60fps, and a click is marked by the squash scale
    dipping below 1 rather than by a `down` event — the cursor pipeline carries the animation,
    not the input events.
    """
    with open(path) as f:
        doc = json.load(f)
    frames = doc["frames"]
    pts = [(f["time"], f["x"], f["y"], f.get("scale", 1.0), f.get("cursorType", "arrow")) for f in frames]

    segments = []

    # A press is a contiguous run of squashed frames. Its LENGTH is not the dwell: the squash
    # animation has a 12-frame minimum hold and its own spring, so runs quantize to the animation
    # (18 of 20 presses in one recording are exactly 20 frames) rather than tracking how long the
    # button was really down. Dwell still comes from raw button events; this only locates presses.
    press_start = None
    presses = []
    for i, p in enumerate(pts):
        squashed = p[3] < SQUASH_THRESHOLD
        if squashed and press_start is None:
            press_start = i
        elif not squashed and press_start is not None:
            presses.append(press_start)
            press_start = None

    for i in presses:
        # Walk back through continuous motion, stopping where the pointer has been parked.
        j = i - 1
        while j > 1 and pts[i][0] - pts[j][0] < MAX_APPROACH_S:
            step = math.hypot(pts[j][1] - pts[j - 1][1], pts[j][2] - pts[j - 1][2])
            if step < STILL_PX and pts[i][0] - pts[j][0] > IDLE_GAP_S:
                break
            j -= 1
        seg = pts[j:i + 1]
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

        cursor = seg[-1][4]
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

    return segments


def extract_keys(path):
    """Pull keystroke stats and click dwells out of one RAW recording.

    Both live here for the same reason: the smoothed corpus carries neither button events nor key
    events, only the rendered cursor and its squash animation.
    """
    with open(path) as f:
        events = json.load(f)

    ikis = []
    holds = []
    dwells = []
    key_types = Counter()

    # Press-to-release. Drags are kept: excluding them collapses the p90 and the renderer draws a
    # held button the same way regardless of whether the pointer moved during it.
    pending_down = None
    for e in events:
        if e.get("type") != "mouse":
            continue
        kind = e.get("mouseEventType")
        if kind == "down":
            pending_down = e["time"]["seconds"]
        elif kind == "up" and pending_down is not None:
            d = e["time"]["seconds"] - pending_down
            if 0 < d < 2:
                dwells.append(d * 1000)
            pending_down = None

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

    return ikis, holds, key_types, dwells


def main():
    for d in (DATASET, SMOOTHED):
        if not os.path.isdir(d):
            print(f"missing {d}", file=sys.stderr)

            return 1

    manifest = load_manifest()
    smoothed_manifest = json.load(open(os.path.join(SMOOTHED, "manifest.json")))
    all_segments = []
    dwells, holds = [], []
    ikis = []
    key_types = Counter()

    for record in smoothed_manifest["recordings"]:
        path = os.path.join(SMOOTHED, record["file"])
        if not os.path.exists(path):
            continue
        all_segments.extend(extract_motion(path))

    for record in manifest["recordings"]:
        path = os.path.join(DATASET, record["file"])
        if not os.path.exists(path):
            continue
        i, h, kt, d = extract_keys(path)
        ikis.extend(i)
        holds.extend(h)
        key_types.update(kt)
        dwells.extend(d)

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
            "dataset": f"{os.path.basename(SMOOTHED)} (motion) + {os.path.basename(DATASET)} (keys)",
            "recordings": len(smoothed_manifest["recordings"]),
            "movementEvents": sum(r["frames"] for r in smoothed_manifest["recordings"]),
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
        # The rendered pipeline's own rate. Generating at anything else and resampling to 60fps
        # would reintroduce interpolation the spring already decided.
        "sampleHz": smoothed_manifest["fps"],
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
