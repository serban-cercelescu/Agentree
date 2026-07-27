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
# Inside the artwork = bright AND opaque: the original source keys the shape
# against a black field, a reprocessed logo.png against transparency. Testing
# both lets the script run on its own output.
inside = lambda p: p[3] > 128 and lum(p) > DARK

cols = [x for x in range(W) if any(inside(px[x, y]) for y in range(0, H, 3))]
rows = [y for y in range(H) if any(inside(px[x, y]) for x in range(0, W, 3))]
left, right, top, bottom = cols[0], cols[-1], rows[0], rows[-1]

# Fit the corner radius from MANY boundary points, not one row. A point (x, y)
# on the top-left arc of a circle centred (left+r, top+r) satisfies
# r = a + b + sqrt(2ab) with a = x-left, b = y-top; a single shallow row's
# estimate is off by tens of pixels (the chord is nearly tangent there), which
# once drew the mask arc INSIDE the artwork's corner and kept a band of the
# black field as opaque "stupid dark rounded corners".
import statistics

fits = []
for b in range(2, 90, 4):
    y = top + b
    x = next((x for x in range(W) if inside(px[x, y])), None)
    if x is None:
        continue
    a = x - left
    if a <= 0:
        break  # past the arc, on the straight edge
    fits.append(a + b + (2 * a * b) ** 0.5)
radius = int(statistics.median(fits)) if fits else 0

# Belt and braces: grow the radius until no opaque near-black artwork pixel
# survives just inside the arc — resampling artifacts can leave a thin ring
# even with a good fit.
def dark_on_arc(r):
    cx, cy = left + r, top + r
    for b in range(0, r):
        y = top + b
        # innermost x still inside the drawn arc at this row
        dx = (r * r - (b - r) ** 2) ** 0.5
        x = int(cx - dx) + 1
        if 0 <= x < W and 0 <= y < H:
            p = px[x + 2, y]
            if p[3] == 255 and lum(p) <= DARK:
                return True
    return False

while radius < min(W, H) // 2 and dark_on_arc(radius):
    radius += 2

samples = [px[x, top + radius + 12] for x in range(left + radius + 12, right - radius - 12, 7)]
cream = Counter((p[0], p[1], p[2]) for p in samples).most_common(1)[0][0]

# Inset the mask 2px inside the measured bounds: pixels exactly ON the artwork
# arc are its dark anti-alias blend at full opacity, and only pixels the mask
# leaves non-opaque get repainted cream.
INSET = 2
big = Image.new("L", (W * SS, H * SS), 0)
ImageDraw.Draw(big).rounded_rectangle(
    [(left + INSET) * SS, (top + INSET) * SS, (right + 1 - INSET) * SS - 1, (bottom + 1 - INSET) * SS - 1],
    radius=(radius - INSET) * SS, fill=255,
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
