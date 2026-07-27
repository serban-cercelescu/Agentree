#!/usr/bin/env python3
"""
Turn logo.png (cream rounded square on a black field) into a transparent icon.

Deliberately NOT a "remove black pixels" pass: the artwork's own tree edges and
node outlines are near-black, so a global key would punch holes through it.
Instead we measure the rounded rectangle and rebuild its boundary as an
anti-aliased alpha mask.

    python3 scripts/make-icon.py
"""
from collections import Counter
from PIL import Image, ImageDraw

SRC, OUT_DIR = "logo.png", "assets"
DARK, SS = 70, 4  # luminance cutoff for "black surround"; mask supersampling

src = Image.open(SRC).convert("RGBA")
W, H = src.size
px = src.load()
lum = lambda p: 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]

cols = [x for x in range(W) if any(lum(px[x, y]) > DARK for y in range(0, H, 3))]
rows = [y for y in range(H) if any(lum(px[x, y]) > DARK for x in range(0, W, 3))]
left, right, top, bottom = cols[0], cols[-1], rows[0], rows[-1]

# On the shape's topmost row a rounded rect spans [left+r, right-r], so the
# inset at that row is the corner radius.
radius = max(0, next(x for x in range(W) if lum(px[x, top + 1]) > DARK) - left)

samples = [px[x, top + radius + 12] for x in range(left + radius + 12, right - radius - 12, 7)]
cream = Counter((p[0], p[1], p[2]) for p in samples).most_common(1)[0][0]

big = Image.new("L", (W * SS, H * SS), 0)
ImageDraw.Draw(big).rounded_rectangle(
    [left * SS, top * SS, (right + 1) * SS - 1, (bottom + 1) * SS - 1],
    radius=radius * SS, fill=255,
)
alpha = big.resize((W, H), Image.LANCZOS)

# Boundary pixels are cream-to-black blends; keeping their RGB under a partial
# alpha would leave a dark halo, so repaint them flat and let alpha do the work.
out, op, ap = src.copy(), None, alpha.load()
op = out.load()
for y in range(H):
    for x in range(W):
        a = ap[x, y]
        if a < 255:
            op[x, y] = (*cream, a)
        else:
            op[x, y] = (*op[x, y][:3], 255)

def flatten_boundary(im):
    """Repaint every non-opaque pixel to flat cream, keeping only its alpha.

    Pillow resizes RGBA with premultiplied alpha, which drags boundary RGB
    toward black — composited over a light page that reads as dark corner
    fringes. The mask edge only ever blends cream against nothing, so the
    correct straight-alpha RGB for every boundary pixel IS cream.
    """
    p = im.load()
    w, h = im.size
    for yy in range(h):
        for xx in range(w):
            a = p[xx, yy][3]
            if a < 255:
                p[xx, yy] = (*cream, a)
    return im

flatten_boundary(out).save(f"{OUT_DIR}/logo.png")
for size in (512, 256, 128):
    flatten_boundary(out.resize((size, size), Image.LANCZOS)).save(f"{OUT_DIR}/logo-{size}.png")
print(f"{W}x{H}, radius {radius}, fill rgb{cream} → {OUT_DIR}/")
