"""Benchmark the layout proposer (HDD §4.6) against hand-drawn stall outlines.

    uv run --no-sync python eval/propose_benchmark.py eval/fixtures/drone-lot.jpg \\
        seed/lots/drone-lot.json [--view V1] [--cars] [--out overlay.jpg]
    uv run --no-sync python eval/propose_benchmark.py eval/data/pklot [--limit N] [--cars]

Ground truth is a lot JSON (one viewpoint's `outlines`, photo fractions) or a PKLot-format
`.xml` (`<space><contour><point x y>` in photo pixels; every space counts, labeled or not). A
directory runs every `<name>.jpg` + `<name>.xml` pair in it.

Proposals and ground-truth outlines are matched one to one at IoU >= 0.5 (greedy, highest
IoU first). Reported: precision (matched / proposed), recall (matched / ground truth), mean
corner error of matched pairs (% of photo width, best corner correspondence), stall counts,
and the proposer's run time (decode included; with --cars the YOLO pass is timed apart).

--cars builds the production YOLO car detector from the settings (pinned weights in
`models/`, needs the worker's vision extra) and passes it to the proposer.
--out draws ground truth (white) and proposals coloured by evidence (red 0 -> green 1),
unmatched proposals with a thick outline; with a directory, one image per photo is written
next to OUT as `<OUT stem>-<photo stem>.jpg`.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for pkg in ("core", "worker"):  # don't depend on uv's editable .pth files (macOS hides them)
    sys.path.insert(0, str(ROOT / pkg))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from parking_core.models import ProposedStall  # noqa: E402
from parking_core.settings import Settings  # noqa: E402
from parking_worker.proposer import build_proposer  # noqa: E402
from parking_worker.scorers.acpds_yolo import CarDetector, decode_photo  # noqa: E402

IOU_MATCH = 0.5


@dataclass
class Result:
    photo: str
    proposed: int
    truth: int
    matched: int
    corner_err: list[float]
    seconds: float
    detect_seconds: float
    partial: int = 0
    """Stalls the photo cuts off, proposed as partial and left out of the scores."""


def read_truth(path: Path, width: int, height: int, view: str | None) -> list[np.ndarray]:
    """Ground-truth outlines as ``[K, 2]`` arrays in photo pixels."""
    if path.suffix == ".xml":
        out = []
        for sp in ET.parse(path).getroot().iter("space"):
            pts = [(float(p.get("x")), float(p.get("y"))) for p in sp.findall("./contour/point")]
            if len(pts) >= 3:
                out.append(np.array(pts))
        return out
    lot = json.loads(path.read_text())
    views = lot["viewpoints"]
    vp = next((v for v in views if v["viewId"] == view), None) if view else views[0]
    if vp is None:
        raise SystemExit(f"{path}: no viewpoint {view}")
    return [np.array(p) * [width, height] for p in vp["outlines"].values()]


def _convex(poly: np.ndarray) -> np.ndarray:
    return cv2.convexHull(poly.astype(np.float32)).reshape(-1, 2)


def iou(p: np.ndarray, q: np.ndarray) -> float:
    a, b = _convex(p), _convex(q)
    inter, _ = cv2.intersectConvexConvex(a, b)
    union = cv2.contourArea(a) + cv2.contourArea(b) - inter
    return float(inter / union) if union > 0 else 0.0


def corner_error(p: np.ndarray, q: np.ndarray) -> float:
    """Mean corner distance (px) under the best cyclic correspondence, either direction."""
    if len(p) != len(q):
        p, q = (
            cv2.boxPoints(cv2.minAreaRect(p.astype(np.float32))),
            cv2.boxPoints(cv2.minAreaRect(q.astype(np.float32))),
        )
    best = float("inf")
    for cand in (q, q[::-1]):
        for k in range(len(cand)):
            best = min(best, float(np.mean(np.linalg.norm(p - np.roll(cand, k, axis=0), axis=1))))
    return best


def match(props: list[np.ndarray], truth: list[np.ndarray]) -> list[tuple[int, int, float]]:
    pairs = []
    for i, p in enumerate(props):
        pb = (p.min(axis=0), p.max(axis=0))
        for j, t in enumerate(truth):
            if (t.min(axis=0) > pb[1]).any() or (t.max(axis=0) < pb[0]).any():
                continue
            v = iou(p, t)
            if v >= IOU_MATCH:
                pairs.append((v, i, j))
    used_p, used_t, out = set(), set(), []
    for v, i, j in sorted(pairs, reverse=True):
        if i not in used_p and j not in used_t:
            used_p.add(i)
            used_t.add(j)
            out.append((i, j, v))
    return out


def draw(bgr, props, stalls: list[ProposedStall], truth, matched_p: set[int], path: Path) -> None:
    img = bgr.copy()
    for t in truth:
        cv2.polylines(img, [np.round(t).astype(np.int32)], True, (255, 255, 255), 2)
    for i, (p, s) in enumerate(zip(props, stalls, strict=True)):
        e = s.evidence
        colour = (0, int(255 * e), int(255 * (1 - e)))
        thick = 2 if i in matched_p else 6
        pts = np.round(p).astype(np.int32)
        cv2.polylines(img, [pts], True, colour, thick)
        c = pts.mean(axis=0).astype(int)
        cv2.putText(img, f"{s.row}.{s.col}", (int(c[0]) - 18, int(c[1])), 0, 0.6, colour, 2)
    cv2.imwrite(str(path), img)
    print(f"  overlay -> {path}")


def run_one(
    photo: Path, gt: Path, view: str | None, detector: CarDetector | None, out: Path | None
) -> Result:
    data = photo.read_bytes()
    bgr = decode_photo(data)
    height, width = bgr.shape[:2]
    truth = read_truth(gt, width, height, view)
    detect_s = 0.0
    if detector is not None:
        t0 = time.perf_counter()
        dets = detector(bgr)
        detect_s = time.perf_counter() - t0

        def cached(_: np.ndarray) -> list:
            return dets

        proposer = build_proposer(Settings(_env_file=None), cached)
    else:
        proposer = build_proposer(Settings(_env_file=None))
    t0 = time.perf_counter()
    stalls = proposer.propose(data)
    seconds = time.perf_counter() - t0
    # The hand-drawn layouts outline whole stalls only; partial ones (cut off by the photo's
    # border) are counted apart.
    partial = sum(s.partial for s in stalls)
    stalls = [s for s in stalls if not s.partial]
    props = [np.array(s.polygon) * [width, height] for s in stalls]
    pairs = match(props, truth)
    errs = [100.0 * corner_error(props[i], truth[j]) / width for i, j, _ in pairs]
    if out is not None:
        draw(bgr, props, stalls, truth, {i for i, _, _ in pairs}, out)
    return Result(photo.name, len(props), len(truth), len(pairs), errs, seconds, detect_s, partial)


def report(r: Result) -> None:
    prec = r.matched / r.proposed if r.proposed else 0.0
    rec = r.matched / r.truth if r.truth else 0.0
    err = f"{np.mean(r.corner_err):.2f}%" if r.corner_err else "-"
    det = f" + detect {r.detect_seconds:.2f}s" if r.detect_seconds else ""
    print(
        f"{r.photo}: precision {prec:.1%} recall {rec:.1%} ({r.matched} matched, "
        f"{r.proposed} proposed, {r.truth} truth) corner error {err} of width, "
        f"time {r.seconds:.2f}s{det}; {r.partial} partial (cut off by the border, not scored)"
    )


def build_detector() -> CarDetector:  # pragma: no cover - needs ultralytics and the weights
    from parking_worker.scorers.acpds_yolo import (
        YoloCarDetector,
        missing_vision_packages,
        verify_weights,
    )

    missing = missing_vision_packages()
    if missing:
        raise SystemExit(f"--cars needs {', '.join(missing)} (the worker's vision extra)")
    settings = Settings(_env_file=None, models_dir=str(ROOT / "models"))
    path, _ = verify_weights(Path(settings.models_dir), settings.yolo_weights)
    return YoloCarDetector(path, conf=settings.yolo_conf, seg=False, imgsz=settings.yolo_imgsz)


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("inputs", nargs="+", type=Path, help="PHOTO TRUTH, or a directory of pairs")
    ap.add_argument("--view", help="viewpoint id in a lot JSON (default: the first)")
    ap.add_argument("--cars", action="store_true", help="add the YOLO car detector")
    ap.add_argument("--out", type=Path, help="write an overlay image")
    ap.add_argument("--limit", type=int, help="first N pairs of a directory")
    args = ap.parse_args()

    if len(args.inputs) == 1 and args.inputs[0].is_dir():
        pairs = [(x.with_suffix(".jpg"), x) for x in sorted(args.inputs[0].glob("*.xml"))]
        pairs = [(j, x) for j, x in pairs if j.is_file()][: args.limit or None]
    elif len(args.inputs) == 2:
        pairs = [(args.inputs[0], args.inputs[1])]
    else:
        ap.error("give PHOTO TRUTH or one directory")
    if not pairs:
        raise SystemExit("no photo / ground-truth pairs found")

    detector = build_detector() if args.cars else None
    print(f"proposer {build_proposer(Settings(_env_file=None), detector).model_version}")
    results = []
    for photo, gt in pairs:
        out = args.out
        if out is not None and len(pairs) > 1:
            out = out.with_name(f"{out.stem}-{photo.stem}{out.suffix or '.jpg'}")
        r = run_one(photo, gt, args.view, detector, out)
        report(r)
        results.append(r)
    if len(results) > 1:
        total = Result(
            "ALL",
            sum(r.proposed for r in results),
            sum(r.truth for r in results),
            sum(r.matched for r in results),
            [e for r in results for e in r.corner_err],
            float(np.mean([r.seconds for r in results])),
            float(np.mean([r.detect_seconds for r in results])),
        )
        report(total)
        print("  (time: mean per photo)")


if __name__ == "__main__":
    main()
