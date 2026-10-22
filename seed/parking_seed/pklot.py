"""Convert one PKLot image + XML annotation into a seed lot JSON (one viewpoint)."""

from __future__ import annotations

import statistics
import string
import xml.etree.ElementTree as ET
from dataclasses import dataclass

CANVAS_W, CANVAS_H = 1000.0, 600.0
MARGIN = 40.0


@dataclass
class PkSpace:
    pk_id: str
    cx: float
    cy: float
    w: float
    h: float
    contour: list[tuple[float, float]]


def parse_xml(xml_text: str) -> list[PkSpace]:
    root = ET.fromstring(xml_text)
    out = []
    for sp in root.iter("space"):
        rr = sp.find("rotatedRect")
        center = rr.find("center") if rr is not None else None
        size = rr.find("size") if rr is not None else None
        contour = [(float(p.get("x")), float(p.get("y"))) for p in sp.findall("./contour/point")]
        if center is None or size is None or len(contour) < 3:
            continue
        out.append(
            PkSpace(
                pk_id=sp.get("id", str(len(out) + 1)),
                cx=float(center.get("x")),
                cy=float(center.get("y")),
                w=float(size.get("w")),
                h=float(size.get("h")),
                contour=contour,
            )
        )
    return out


def cluster_rows(spaces: list[PkSpace]) -> list[list[PkSpace]]:
    """Group by center y; a gap above 0.6 * median height starts a new row."""
    if not spaces:
        return []
    ordered = sorted(spaces, key=lambda s: s.cy)
    median_h = statistics.median(min(s.w, s.h) for s in spaces)
    rows: list[list[PkSpace]] = [[ordered[0]]]
    for prev, cur in zip(ordered, ordered[1:], strict=False):
        if cur.cy - prev.cy > 0.6 * median_h:
            rows.append([])
        rows[-1].append(cur)
    return [sorted(r, key=lambda s: s.cx) for r in rows]


def build_lot(
    xml_text: str,
    image_size: tuple[int, int],
    lot_id: str,
    name: str,
    view_id: str = "V1",
    view_name: str = "Camera",
) -> dict:
    img_w, img_h = image_size
    rows = cluster_rows(parse_xml(xml_text))
    if len(rows) > len(string.ascii_uppercase):
        raise ValueError("too many rows")
    spaces, outlines = [], {}
    row_h = (CANVAS_H - 2 * MARGIN) / max(len(rows), 1)
    for r_idx, row in enumerate(rows):
        letter = string.ascii_uppercase[r_idx]
        stall_w = (CANVAS_W - 2 * MARGIN) / len(row)
        for c_idx, sp in enumerate(row):
            label = f"{letter}-{c_idx + 1:02d}"
            space_id = f"pk-{sp.pk_id}"
            spaces.append(
                {
                    "spaceId": space_id,
                    "label": label,
                    "spaceType": "STANDARD",
                    "rect": {
                        "x": round(MARGIN + c_idx * stall_w + 2, 2),
                        "y": round(MARGIN + r_idx * row_h + 4, 2),
                        "w": round(stall_w - 4, 2),
                        "h": round(row_h * 0.8, 2),
                    },
                }
            )
            outlines[space_id] = [[round(x / img_w, 4), round(y / img_h, 4)] for x, y in sp.contour]
    return {
        "lotId": lot_id,
        "name": name,
        "location": "",
        "staleAfterMinutes": 30,
        "schematic": {"width": CANVAS_W, "height": CANVAS_H},
        "spaces": spaces,
        "viewpoints": [
            {
                "viewId": view_id,
                "name": view_name,
                "imageWidth": img_w,
                "imageHeight": img_h,
                "outlines": outlines,
            }
        ],
    }
