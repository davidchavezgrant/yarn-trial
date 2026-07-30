"""Composite a humanized cursor over a run's captured frames and emit raw video on stdout.

Reads a motion track (yarn-motion-track/v1) plus the recording's frames/ directory, and writes
rgb24 frames to stdout for ffmpeg to encode. Nothing is written to disk: a 60fps render of a
several-minute run is thousands of intermediate PNGs and multiple gigabytes, and the pipe costs
nothing.

The track is the ONLY input describing what happens. This script deliberately cannot see the run
log — if it ever needs something from there, the track schema is incomplete and that is the signal.

Usage:
    render_cursor.py <track.json> <frames-dir> [--cursors <dir>]
"""

import json
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw

# macOS ships its cursors as PDFs with a hotspot in an adjacent plist. PIL cannot read PDF, so
# sips rasterizes them. The standard arrow is NOT in this directory (checked) and is drawn instead.
SYSTEM_CURSORS = (
    "/System/Library/Frameworks/ApplicationServices.framework/Versions/A/Frameworks"
    "/HIServices.framework/Versions/A/Resources/cursors"
)

# Track cursorType -> the system cursor directory holding it.
CURSOR_FILES = {
    "pointingHand": "pointinghand",
    "iBeam": "ibeamvertical",
    "closedHand": "closedhand",
    "openHand": "openhand",
    "resizeLeftRight": "resizeleftright",
    "operationNotAllowed": "notallowed",
}

# Rasterize at 2x and downsample when pasting, so the cursor stays crisp against a scaled frame.
RASTER = 64

CARET_BLINK_MS = 530

# The art is rasterized into a RASTER-px box representing 32 logical points, so RASTER/32 px per
# point. Drawing it unscaled sized the cursor for an unscaled display; against a 1920pt window
# captured at 1568px it came out ~1.5x too big and towered over the UI text beside it.
POINTS_PER_BOX = 32.0

# Click ring radius in points, scaled the same way.
CLICK_RING_PT = 18.0

# Ramp on the synthetic hover tint, so it reads as a response rather than a compositing glitch.
HOVER_FADE_MS = 120


def load_system_cursor(name, tmpdir):
    """Rasterize one system cursor, returning (image, hotspot) or None when unavailable."""
    src = os.path.join(SYSTEM_CURSORS, name)
    pdf = os.path.join(src, "cursor.pdf")
    plist = os.path.join(src, "info.plist")
    if not os.path.exists(pdf):
        return None
    out = os.path.join(tmpdir, name + ".png")
    try:
        subprocess.run(
            ["sips", "-s", "format", "png", "-Z", str(RASTER), pdf, "--out", out],
            check=True, capture_output=True,
        )
        image = Image.open(out).convert("RGBA")
    except (subprocess.CalledProcessError, OSError):
        return None
    # Hotspots in the plist are in the cursor's native 32pt space.
    hotx, hoty = 0, 0
    try:
        raw = subprocess.run(["plutil", "-convert", "json", "-o", "-", plist],
                             check=True, capture_output=True).stdout
        info = json.loads(raw)
        scale = image.size[0] / 32.0
        hotx = int(info.get("hotx", 0) * scale)
        hoty = int(info.get("hoty", 0) * scale)
    except (subprocess.CalledProcessError, OSError, ValueError):
        pass

    return image, (hotx, hoty)


def draw_arrow():
    """The standard arrow, drawn rather than loaded.

    macOS does not ship it in the cursors directory alongside the others, and drawing it avoids
    committing an Apple asset to the repo along with the licensing question that raises.
    """
    image = Image.new("RGBA", (RASTER, RASTER), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    s = RASTER / 32.0
    body = [(0, 0), (0, 21), (5, 16), (9, 25), (13, 23), (9, 15), (16, 15)]
    points = [(x * s, y * s) for x, y in body]
    # White outline under a black fill is what makes a cursor legible over any background.
    draw.polygon(points, fill=(255, 255, 255, 255), outline=(255, 255, 255, 255), width=int(3 * s))
    draw.polygon(points, fill=(0, 0, 0, 255))

    return image, (0, 0)


def load_cursors(tmpdir):
    cursors = {"arrow": draw_arrow()}
    for kind, name in CURSOR_FILES.items():
        loaded = load_system_cursor(name, tmpdir)
        # A missing system cursor degrades to the arrow rather than failing the render.
        cursors[kind] = loaded if loaded else cursors["arrow"]

    return cursors


def sample_cursor(samples, t_ms):
    """Cursor position at an output instant, interpolated between track samples."""
    if not samples:
        return None
    if t_ms <= samples[0]["tMs"]:
        return samples[0]
    lo, hi = 0, len(samples) - 1
    while lo < hi - 1:
        mid = (lo + hi) // 2
        if samples[mid]["tMs"] <= t_ms:
            lo = mid
        else:
            hi = mid
    a, b = samples[lo], samples[hi]
    span = b["tMs"] - a["tMs"]
    if span <= 0:
        return b
    f = (t_ms - a["tMs"]) / span

    return {
        "x": a["x"] + (b["x"] - a["x"]) * f,
        "y": a["y"] + (b["y"] - a["y"]) * f,
        "type": a["type"],
    }


def frame_at(plan, t_ms):
    """Which captured frame is held at an output instant.

    Returns the plan entry so the caller can prefer `frameFile`. Resolving by index would require
    this script to filter the directory exactly as the track builder did — it did not, and every
    entry pointed at the wrong frame once malformed captures were dropped.
    """
    for entry in plan:
        if entry["startMs"] <= t_ms < entry["endMs"]:
            return entry

    return plan[-1] if plan else None


def hover_at(hovers, t_ms):
    """The control the cursor is resting on right now, if any."""
    for h in hovers:
        if h["startMs"] <= t_ms < h["endMs"]:
            return h

    return None


def draw_hover(frame, box, strength):
    """Tint a control to look hovered.

    The app never painted one: AX actuation leaves the physical pointer elsewhere, so no mouseover
    fires. Multiplicative darkening rather than a flat grey fill, so text and icons inside the
    control stay legible instead of being washed over — the same thing a CSS hover background does.
    """
    pad = 4
    x0 = max(0, int(box["x"]) - pad)
    y0 = max(0, int(box["y"]) - pad)
    x1 = min(frame.size[0], int(box["x"] + box["w"]) + pad)
    y1 = min(frame.size[1], int(box["y"] + box["h"]) + pad)
    if x1 <= x0 or y1 <= y0:
        return frame
    region = frame.crop((x0, y0, x1, y1))
    factor = 1.0 - 0.06 * strength
    frame.paste(region.point(lambda p: int(p * factor)), (x0, y0))

    return frame


def pressed_at(events, t_ms):
    """Is a mouse button down? Drives the click ring."""
    down = False
    for e in events:
        if e["tMs"] > t_ms:
            break
        if e["kind"] == "mousedown":
            down = True
        elif e["kind"] == "mouseup":
            down = False

    return down


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        print(__doc__, file=sys.stderr)

        return 2
    track = json.load(open(args[0]))
    frames_dir = args[1]

    fps = track["timeline"]["fps"]
    duration = track["timeline"]["durationMs"]
    width = track["space"]["width"]
    height = track["space"]["height"]
    samples = track["cursor"]
    events = track["events"]
    plan = track["framePlan"]
    hovers = track.get("hovers", [])
    # Output pixels per logical point of the captured window. Everything drawn on top of the frame
    # — cursor, click ring — has to shrink by the same factor the app's own UI did.
    src = track["space"].get("sourceCapture", {})
    frame_scale = (width / src["width"]) if src.get("width") else 1.0
    cursor_scale = POINTS_PER_BOX / RASTER * frame_scale

    files = sorted(f for f in os.listdir(frames_dir) if f.startswith("f-") and f.endswith(".png"))
    index_of = set(files)
    if not files:
        print("no frames to render", file=sys.stderr)

        return 1

    with tempfile.TemporaryDirectory() as tmpdir:
        cursors = load_cursors(tmpdir)
        total = int(duration / 1000.0 * fps)
        cached_index, cached_plate = None, None
        out = sys.stdout.buffer

        for n in range(total):
            t_ms = n * 1000.0 / fps
            entry = frame_at(plan, t_ms)
            name = (entry or {}).get("frameFile")
            index = files.index(name) if name in index_of else min((entry or {}).get("frameIndex", 0), len(files) - 1)
            # Consecutive output frames almost always share a plate at ~1fps capture, so decoding
            # once per source frame rather than per output frame is the whole cost of the render.
            if index != cached_index:
                plate = Image.open(os.path.join(frames_dir, files[index])).convert("RGB")
                if plate.size != (width, height):
                    # Off-size frames are captured while the window is still settling and have a
                    # different aspect ratio, so stretching one to fit puts the whole image — and
                    # the control the cursor is aimed at — in the wrong place. Letterbox instead,
                    # matching what assembleVideo does with the same frames.
                    fitted = Image.new("RGB", (width, height), (26, 26, 26))
                    scale = min(width / plate.size[0], height / plate.size[1])
                    scaled = plate.resize((max(1, int(plate.size[0] * scale)), max(1, int(plate.size[1] * scale))))
                    fitted.paste(scaled, ((width - scaled.size[0]) // 2, (height - scaled.size[1]) // 2))
                    plate = fitted
                cached_index, cached_plate = index, plate
            frame = cached_plate.copy()

            hover = hover_at(hovers, t_ms)
            if hover:
                # Fade in and out rather than snapping: an instant tint on a held frame looks like
                # a compositing glitch, where a ramp reads as the control responding to the pointer.
                since = t_ms - hover["startMs"]
                until = hover["endMs"] - t_ms
                strength = min(1.0, since / HOVER_FADE_MS, max(0.0, until / HOVER_FADE_MS))
                if strength > 0:
                    frame = draw_hover(frame, hover, strength)

            spot = sample_cursor(samples, t_ms)
            if spot:
                art, (hotx, hoty) = cursors.get(spot["type"], cursors["arrow"])
                size = (max(1, round(art.size[0] * cursor_scale)), max(1, round(art.size[1] * cursor_scale)))
                scaled = art.resize(size, Image.LANCZOS)
                # The hotspot is the point the cursor is AT, so it scales with the art.
                x = int(round(spot["x"] - hotx * cursor_scale))
                y = int(round(spot["y"] - hoty * cursor_scale))
                if pressed_at(events, t_ms):
                    r = CLICK_RING_PT * frame_scale
                    ring = Image.new("RGBA", frame.size, (0, 0, 0, 0))
                    ImageDraw.Draw(ring).ellipse(
                        [spot["x"] - r, spot["y"] - r, spot["x"] + r, spot["y"] + r],
                        outline=(40, 110, 255, 190), width=max(1, round(2 * frame_scale)),
                    )
                    frame = Image.alpha_composite(frame.convert("RGBA"), ring).convert("RGB")
                frame.paste(scaled, (x, y), scaled)

            out.write(frame.tobytes())

        out.flush()

    return 0


if __name__ == "__main__":
    sys.exit(main())
