#!/usr/bin/env python3
"""Annotate a screenshot with red underlines, boxes, captions and blur redactions.

Usage:
  python3 scripts/annotate-screenshot.py IN.png OUT.png SPEC.json

SPEC.json is a list of ops. Coordinates are pixels of IN.png, except that after a
crop op every other op uses the cropped image's coordinates (subtract the crop x1, y1):
  {"op": "underline", "x1": 100, "x2": 300, "y": 220}
  {"op": "box",       "x1": 100, "y1": 200, "x2": 300, "y2": 240}
  {"op": "arrow",     "x1": 400, "y1": 300, "x2": 310, "y2": 232}
  {"op": "label",     "x": 410, "y": 290, "text": "1. Click here"}
  {"op": "step",      "x": 90,  "y": 220, "n": 1}
  {"op": "blur",      "x1": 10,  "y1": 10, "x2": 200, "y2": 40}   # hide emails, names, tokens
  {"op": "crop",      "x1": 0, "y1": 0, "x2": 1200, "y2": 700}    # must come first
"""
import json
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

RED = (229, 25, 25)
WHITE = (255, 255, 255)


def font(size):
    for path in (
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/Library/Fonts/Arial.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main(src, dst, spec_path):
    img = Image.open(src).convert("RGB")
    ops = json.load(open(spec_path))
    for op in ops:
        if op["op"] == "crop":
            img = img.crop((op["x1"], op["y1"], op["x2"], op["y2"]))
    scale = max(1, round(img.width / 1400))
    w = 3 * scale
    for op in ops:
        kind = op["op"]
        if kind == "blur":
            box = (op["x1"], op["y1"], op["x2"], op["y2"])
            region = img.crop(box).filter(ImageFilter.GaussianBlur(14 * scale))
            img.paste(region, box)
    d = ImageDraw.Draw(img)
    for op in ops:
        kind = op["op"]
        if kind == "underline":
            d.line((op["x1"], op["y"], op["x2"], op["y"]), fill=RED, width=w)
        elif kind == "box":
            d.rectangle((op["x1"], op["y1"], op["x2"], op["y2"]), outline=RED, width=w)
        elif kind == "arrow":
            import math

            x1, y1, x2, y2 = op["x1"], op["y1"], op["x2"], op["y2"]
            d.line((x1, y1, x2, y2), fill=RED, width=w)
            a = math.atan2(y2 - y1, x2 - x1)
            h = 16 * scale
            for s in (-0.5, 0.5):
                d.line((x2, y2, x2 - h * math.cos(a + s), y2 - h * math.sin(a + s)), fill=RED, width=w)
        elif kind == "label":
            f = font(18 * scale)
            x, y = op["x"], op["y"]
            l, t, r, b = d.textbbox((x, y), op["text"], font=f)
            p = 6 * scale
            d.rounded_rectangle((l - p, t - p, r + p, b + p), radius=6 * scale, fill=RED)
            d.text((x, y), op["text"], font=f, fill=WHITE)
        elif kind == "step":
            r = 14 * scale
            x, y = op["x"], op["y"]
            d.ellipse((x - r, y - r, x + r, y + r), fill=RED)
            f = font(16 * scale)
            d.text((x, y), str(op["n"]), font=f, fill=WHITE, anchor="mm")
    img.save(dst, optimize=True)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
