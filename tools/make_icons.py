# -*- coding: utf-8 -*-
"""Generate Hydrix app icons (512/192) with PIL: deep-green tile + white droplet + green leaf."""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(OUT, exist_ok=True)

DEEP = (20, 83, 45, 255)      # #14532d
SPROUT = (34, 197, 94, 255)   # #22c55e
WHITE = (255, 255, 255, 255)


def make_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (512, 512), DEEP)
    d = ImageDraw.Draw(img)

    # White droplet: circle body + triangular tip
    d.ellipse((166, 210, 346, 390), fill=WHITE)
    d.polygon([(256, 118), (178, 268), (334, 268)], fill=WHITE)

    # Green leaf inside the droplet: ellipse rotated, pasted on transparent layer
    leaf = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    ld = ImageDraw.Draw(leaf)
    ld.ellipse((30, 66, 170, 134), fill=SPROUT)          # leaf body
    ld.line([(36, 100), (164, 100)], fill=DEEP, width=8)  # midrib
    leaf = leaf.rotate(-28, resample=Image.BICUBIC, center=(100, 100))
    img.alpha_composite(leaf, (156, 222))

    # Small water sparkles
    for cx, cy, r in [(150, 150, 9), (372, 170, 7), (352, 120, 5)]:
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(144, 222, 176, 255))

    return img.resize((size, size), Image.LANCZOS)


for s in (512, 192):
    make_icon(s).save(os.path.join(OUT, f"icon-{s}.png"))
make_icon(512).save(os.path.join(OUT, "icon-512-maskable.png"))
print("icons written to", os.path.abspath(OUT))
