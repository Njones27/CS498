"""Prefill PKLot-format label files for new pilot photos from a lot's outlines.

    uv run python eval/prefill_labels.py PHOTOS_DIR [--lot seed/lots/drone-lot.json]
        [--reference eval/fixtures/drone-lot.jpg] [--view V1] [--source NAME] [--force]

Every `.jpg` in PHOTOS_DIR is aligned to the viewpoint's reference photo with the worker's ORB
aligner (the same code and `ORB_*` settings as production), the viewpoint's outlines are mapped
into the photo, and `<photo>.xml` is written next to it in the layout of eval/README.md
("Labeling format for pilot photos"): one `<space>` per stall with its contour and rotatedRect
in photo pixels and **no** `occupied` attribute, so nothing is scored until a human labels it
(eval/label.html). Stalls that map partly outside the photo are left out and listed: the worker
reports them UNKNOWN anyway, and a half-visible stall cannot be labeled fairly.

Photos that already have an `.xml` are skipped unless --force. Photos that fail alignment are
reported and get no `.xml`. Exit code 1 if any photo failed, 2 if PHOTOS_DIR has no photos.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

ROOT = Path(__file__).resolve().parents[1]
for pkg in ("core", "worker"):  # don't depend on uv's editable .pth files (macOS hides them)
    sys.path.insert(0, str(ROOT / pkg))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # fetch_pklot_sample, when loaded by path

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from fetch_pklot_sample import centroid  # noqa: E402
from parking_core.adapters.memory import MemoryObjectStore  # noqa: E402
from parking_core.errors import AlignmentError  # noqa: E402
from parking_core.keys import reference_image_key  # noqa: E402
from parking_core.models import Viewpoint  # noqa: E402
from parking_core.settings import Settings  # noqa: E402
from parking_worker.aligners.orb import OrbAligner  # noqa: E402

DEFAULT_LOT = ROOT / "seed" / "lots" / "drone-lot.json"
DEFAULT_REFERENCE = ROOT / "eval" / "fixtures" / "drone-lot.jpg"
PHOTO_SUFFIXES = {".jpg", ".jpeg"}  # compared lowercased


@dataclass
class PrefillResult:
    photo: Path
    status: Literal["written", "skipped", "failed"]
    spaces: int = 0
    out_of_frame: list[str] = field(default_factory=list)
    error: str | None = None


# --- alignment -------------------------------------------------------------------------------


def load_viewpoint(lot: dict, view_id: str | None, reference_key: str | None) -> Viewpoint:
    """The lot JSON's viewpoint `view_id` (the first one when None), pointing at the reference."""
    views = lot.get("viewpoints") or []
    match = next((v for v in views if view_id is None or v.get("viewId") == view_id), None)
    if match is None:
        ids = ", ".join(v.get("viewId", "?") for v in views) or "none"
        raise SystemExit(f"No viewpoint {view_id!r} in lot {lot.get('lotId')!r} (has: {ids})")
    return Viewpoint.model_validate(
        {**match, "lotId": lot["lotId"], "referenceImageKey": reference_key}
    )


def make_aligner(
    reference: bytes, lot: dict, view_id: str | None, settings: Settings | None = None
) -> tuple[OrbAligner, Viewpoint]:
    settings = settings or Settings(_env_file=None)  # ORB_* env vars still apply
    viewpoint = load_viewpoint(lot, view_id, None)
    key = reference_image_key(
        viewpoint.lot_id, viewpoint.view_id, hashlib.sha256(reference).hexdigest()
    )
    store = MemoryObjectStore()
    store.put(key, reference, "image/jpeg")
    aligner = OrbAligner(
        store,
        features=settings.orb_features,
        min_matches=settings.orb_min_matches,
        min_inliers=settings.orb_min_inliers,
        min_inlier_ratio=settings.orb_min_inlier_ratio,
        ransac_px=settings.orb_ransac_px,
    )
    return aligner, viewpoint.model_copy(update={"reference_image_key": key})


def photo_size(data: bytes) -> tuple[int, int]:
    """(width, height) as the aligner decodes the photo (EXIF orientation applied)."""
    gray = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise AlignmentError("Photo could not be decoded")
    height, width = gray.shape[:2]
    return width, height


# --- XML -------------------------------------------------------------------------------------


def rotated_rect(points: list[tuple[float, float]]) -> tuple[int, int, int, int]:
    """(center x, center y, width, height) in whole pixels, as PKLot's rotatedRect stores it."""
    cx, cy = centroid(points)
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return round(cx), round(cy), round(max(xs) - min(xs)), round(max(ys) - min(ys))


def labels_xml(source: str, spaces: list[tuple[str, list[tuple[float, float]]]]) -> str:
    """Unlabeled PKLot-format annotation (no `occupied`), same shape as fetch_pklot_sample's."""
    root = ET.Element("parking", id=source)
    for space_id, pts in spaces:
        cx, cy, w, h = rotated_rect(pts)
        space = ET.SubElement(root, "space", id=space_id)
        rect = ET.SubElement(space, "rotatedRect")
        ET.SubElement(rect, "center", x=str(cx), y=str(cy))
        ET.SubElement(rect, "size", w=str(w), h=str(h))
        ET.SubElement(rect, "angle", d="0")
        contour = ET.SubElement(space, "contour")
        for x, y in pts:
            ET.SubElement(contour, "point", x=str(round(x)), y=str(round(y)))
    ET.indent(root, space="  ")
    return '<?xml version="1.0"?>\n' + ET.tostring(root, encoding="unicode") + "\n"


# --- run -------------------------------------------------------------------------------------


def prefill_photo(
    photo: Path, aligner: OrbAligner, viewpoint: Viewpoint, source: str, *, force: bool
) -> PrefillResult:
    xml_path = photo.with_suffix(".xml")
    if xml_path.exists() and not force:
        return PrefillResult(photo, "skipped")
    data = photo.read_bytes()
    try:
        aligned = aligner.align(data, viewpoint)
        width, height = photo_size(data)
    except AlignmentError as exc:
        return PrefillResult(photo, "failed", error=str(exc))
    spaces, out_of_frame = [], []
    for o in aligned:  # viewpoint.outlines order, i.e. the lot JSON's
        if o.in_frame:
            spaces.append((o.space_id, [(x * width, y * height) for x, y in o.polygon]))
        else:
            out_of_frame.append(o.space_id)
    xml_path.write_text(labels_xml(source, spaces))
    return PrefillResult(photo, "written", spaces=len(spaces), out_of_frame=out_of_frame)


def find_photos(photos_dir: Path) -> list[Path]:
    return sorted(
        p for p in photos_dir.iterdir() if p.is_file() and p.suffix.lower() in PHOTO_SUFFIXES
    )


def prefill_dir(
    photos_dir: Path,
    *,
    lot_path: Path = DEFAULT_LOT,
    reference_path: Path = DEFAULT_REFERENCE,
    view_id: str | None = None,
    source: str | None = None,
    force: bool = False,
    settings: Settings | None = None,
) -> list[PrefillResult]:
    lot = json.loads(lot_path.read_text())
    aligner, viewpoint = make_aligner(reference_path.read_bytes(), lot, view_id, settings)
    source = source or f"{viewpoint.lot_id}-{viewpoint.view_id}"
    return [
        prefill_photo(photo, aligner, viewpoint, source, force=force)
        for photo in find_photos(photos_dir)
    ]


def describe(r: PrefillResult) -> str:
    xml_name = r.photo.with_suffix(".xml").name
    if r.status == "skipped":
        return f"skip {r.photo.name}: {xml_name} exists (--force to overwrite)"
    if r.status == "failed":
        return f"FAILED {r.photo.name}: {r.error}"
    line = f"wrote {xml_name}: {r.spaces} stalls"
    if r.out_of_frame:
        line += f" ({len(r.out_of_frame)} out of frame: {', '.join(r.out_of_frame)})"
    return line


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("photos_dir", type=Path)
    p.add_argument("--lot", type=Path, default=DEFAULT_LOT, help="lot JSON with the outlines")
    p.add_argument("--reference", type=Path, default=DEFAULT_REFERENCE, help="reference photo")
    p.add_argument("--view", help="viewpoint id (default: the lot's first viewpoint)")
    p.add_argument("--source", help="<parking id>, the benchmark's camera (default lot-view)")
    p.add_argument("--force", action="store_true", help="overwrite existing .xml files")
    args = p.parse_args(argv)
    if not args.photos_dir.is_dir():
        p.error(f"{args.photos_dir} is not a directory")

    results = prefill_dir(
        args.photos_dir,
        lot_path=args.lot,
        reference_path=args.reference,
        view_id=args.view,
        source=args.source,
        force=args.force,
    )
    if not results:
        print(f"No .jpg photos in {args.photos_dir}")
        return 2
    for r in results:
        print(describe(r))
        if r.photo.suffix != ".jpg":
            print(f"  warning: rename {r.photo.name} to .jpg: benchmark.py pairs by .jpg")
    counts = {s: sum(r.status == s for r in results) for s in ("written", "skipped", "failed")}
    print(
        f"\n{len(results)} photos: {counts['written']} written, {counts['skipped']} skipped, "
        f"{counts['failed']} failed"
    )
    return 1 if counts["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
