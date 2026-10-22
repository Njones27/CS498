"""Draw the synthetic reference photo for seed/lots/test-lot.json.

uv run python eval/make_fixture.py   ->  eval/fixtures/test-lot.jpg (640x360 JPEG)
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
LOT = ROOT / "seed" / "lots" / "test-lot.json"
OUT = ROOT / "eval" / "fixtures" / "test-lot.jpg"
W, H = 640, 360
CARS = {"A-02", "A-03", "A-06", "B-02"}


def main() -> None:
    lot = json.loads(LOT.read_text())
    outlines = lot["viewpoints"][0]["outlines"]  # V1 "North corner"
    im = Image.new("RGB", (W, H), (92, 92, 96))
    draw = ImageDraw.Draw(im)
    for space_id, poly in outlines.items():
        pts = [(x * W, y * H) for x, y in poly]
        draw.line([*pts, pts[0]], fill=(235, 235, 235), width=2)
        if space_id in CARS:
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            pad_x, pad_y = (max(xs) - min(xs)) * 0.18, (max(ys) - min(ys)) * 0.12
            box = (min(xs) + pad_x, min(ys) + pad_y, max(xs) - pad_x, max(ys) - pad_y)
            draw.rectangle(box, fill=(30, 32, 40))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    im.save(OUT, "JPEG", quality=85)
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
