"""Layout proposer on synthetic lots drawn with OpenCV, and on the drone test photo.

Everything here runs without torch: cars come from a fake detector. The YOLO test is opt-in:
RUN_MODEL_TESTS=1 uv run pytest -m real_model worker/tests/test_proposer.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import cv2
import numpy as np
import pytest
from parking_core.errors import PermanentJobError
from parking_core.settings import Settings
from parking_worker.proposer import build_proposer
from parking_worker.scorers.acpds_yolo import Detection

ROOT = Path(__file__).resolve().parents[2]
DRONE = ROOT / "eval" / "fixtures" / "drone-lot.jpg"
DRONE_LOT = ROOT / "seed" / "lots" / "drone-lot.json"
SIZE = 900
PITCH, DEPTH, LINE = 50, 110, 4
N_STALLS = 12
X0 = 150


def asphalt(h: int = SIZE, w: int = SIZE, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    img = np.full((h, w, 3), 95, np.uint8)
    noise = rng.normal(0, 6, (h, w, 1)).astype(np.int16)
    return np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)


def jpeg(bgr: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, 92])
    assert ok
    return buf.tobytes()


def double_row(img: np.ndarray, top: int, missing: dict[int, set[int]] | None = None) -> list:
    """Two back-to-back rows of `N_STALLS` stalls sharing a row line at ``top + DEPTH``.

    ``missing`` maps row (0 = upper) to divider indices left unpainted. Returns the stall
    rectangles (x0, y0, x1, y1) in photo px, upper row first."""
    missing = missing or {}
    white = (235, 235, 235)
    mid = top + DEPTH
    x1 = X0 + N_STALLS * PITCH
    cv2.line(img, (X0, mid), (x1, mid), white, LINE)
    stalls = []
    for r, (y0, y1) in enumerate([(top, mid), (mid, mid + DEPTH)]):
        for k in range(N_STALLS + 1):
            if k not in missing.get(r, set()):
                x = X0 + k * PITCH
                cv2.line(img, (x, y0), (x, y1), white, LINE)
        stalls += [(X0 + k * PITCH, y0, X0 + (k + 1) * PITCH, y1) for k in range(N_STALLS)]
    return stalls


def rect_poly(r) -> np.ndarray:
    x0, y0, x1, y1 = r
    return np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], np.float64)


def iou(p: np.ndarray, q: np.ndarray) -> float:
    a, b = p.astype(np.float32), q.astype(np.float32)
    inter, _ = cv2.intersectConvexConvex(a, b)
    return float(inter / (cv2.contourArea(a) + cv2.contourArea(b) - inter))


def to_px(stalls, w: int = SIZE, h: int = SIZE) -> list[np.ndarray]:
    return [np.array(s.polygon) * [w, h] for s in stalls]


def best_match(truth: np.ndarray, props: list[np.ndarray]) -> tuple[int, float]:
    scores = [iou(truth, p) for p in props]
    i = int(np.argmax(scores))
    return i, scores[i]


def proposer(car_detector=None):
    return build_proposer(Settings(_env_file=None), car_detector)


def test_double_row_fills_missing_dividers_with_lower_evidence():
    img = asphalt()
    truth = double_row(img, 200, missing={0: {4}, 1: {8}})
    stalls = proposer().propose(jpeg(img))

    assert len(stalls) == 2 * N_STALLS
    props = to_px(stalls)
    for k, rect in enumerate(truth):
        i, score = best_match(rect_poly(rect), props)
        assert score > 0.8, (k, score)
        assert stalls[i].row == k // N_STALLS and stalls[i].col == k % N_STALLS
    # The stalls beside a missing divider (upper row: 3 and 4, lower row: 7 and 8) are less
    # certain than stalls between two painted dividers.
    by_pos = {(s.row, s.col): s.evidence for s in stalls}
    weak = {(0, 3), (0, 4), (1, 7), (1, 8)}
    assert max(by_pos[k] for k in weak) < min(v for k, v in by_pos.items() if k not in weak)
    assert min(by_pos.values()) > 0
    # Sorted by row then column; map_rect is the stall in photo-width units, origin at 0.
    assert [(s.row, s.col) for s in stalls] == sorted((s.row, s.col) for s in stalls)
    assert min(s.map_rect.x for s in stalls) == pytest.approx(0)
    assert min(s.map_rect.y for s in stalls) == pytest.approx(0)
    first = stalls[0].map_rect
    assert first.w == pytest.approx(PITCH / SIZE, rel=0.1)
    assert first.h == pytest.approx(DEPTH / SIZE, rel=0.1)


def test_polygons_are_clockwise_fractions():
    img = asphalt()
    double_row(img, 200)
    for s in proposer().propose(jpeg(img)):
        pts = np.array(s.polygon)
        assert pts.shape == (4, 2) and (pts >= 0).all() and (pts <= 1).all()
        x, y = pts[:, 0], pts[:, 1]
        # Shoelace in image coordinates (y down): positive area = clockwise on screen.
        assert np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y) > 0


def test_back_to_back_rows_without_a_row_line_are_split():
    img = asphalt()
    truth = double_row(img, 200)
    cv2.line(img, (X0 - 5, 200 + DEPTH), (X0 + N_STALLS * PITCH + 5, 200 + DEPTH), (95, 95, 95), 8)
    stalls = proposer().propose(jpeg(img))
    assert len(stalls) == 2 * N_STALLS
    assert {s.row for s in stalls} == {0, 1}
    props = to_px(stalls)
    assert all(best_match(rect_poly(r), props)[1] > 0.7 for r in truth)


def test_rotated_lot_outlines_follow_the_rotation():
    big = 1200
    img = asphalt(big, big)
    offset = (big - SIZE) // 2
    truth = double_row(img[offset : offset + SIZE, offset : offset + SIZE], 200)
    angle = 15.0
    m = cv2.getRotationMatrix2D((big / 2, big / 2), angle, 1.0)
    rotated = cv2.warpAffine(img, m, (big, big), borderMode=cv2.BORDER_REFLECT)
    stalls = proposer().propose(jpeg(rotated))

    assert len(stalls) == 2 * N_STALLS
    props = to_px(stalls, big, big)
    for rect in truth:
        poly = rect_poly(rect) + offset
        turned = poly @ m[:, :2].T + m[:, 2]
        assert best_match(turned, props)[1] > 0.75
    # Edges run along the rotated rows: the top edge is 15 degrees off horizontal.
    p = props[0]
    edge = np.degrees(np.arctan2(p[1, 1] - p[0, 1], p[1, 0] - p[0, 0]))
    assert abs(abs(edge) - angle) < 2.0


def test_cars_without_paint_make_a_row():
    img = asphalt()
    slots = [0, 1, 2, 4, 5]  # slot 3 empty
    pitch, car_w, car_l, top = 60, 40, 90, 400
    boxes = []
    for k in slots:
        cx = 200 + k * pitch
        box = (cx - car_w / 2, top, cx + car_w / 2, top + car_l)
        cv2.rectangle(
            img, (int(box[0]), int(box[1])), (int(box[2]), int(box[3])), (120, 40, 20), -1
        )
        boxes.append(box)
    detections = [Detection("cell phone", 0.8, b) for b in boxes]
    calls = []

    def detector(bgr: np.ndarray) -> list[Detection]:
        calls.append(bgr.shape)
        return detections

    p = proposer(detector)
    stalls = p.propose(jpeg(img))

    assert calls == [(SIZE, SIZE, 3)]
    assert p.model_version.endswith("|lines+cars")
    assert len(stalls) == 6
    assert {s.row for s in stalls} == {0}
    centres = sorted(np.mean(np.array(s.polygon), axis=0)[0] * SIZE for s in stalls)
    assert np.allclose(centres, [200 + k * pitch for k in range(6)], atol=4)
    evidence = [s.evidence for s in sorted(stalls, key=lambda s: s.col)]
    assert evidence[3] < min(evidence[:3] + evidence[4:])


def test_cars_extend_a_painted_row():
    img = asphalt()
    truth = double_row(img, 200)
    # A car parked one stall past the upper row's last divider, which is not painted.
    x = X0 + N_STALLS * PITCH + PITCH / 2
    box = (x - 18, 215, x + 18, 300)
    cars = [Detection("car", 0.9, box)] * 1
    stalls = proposer(lambda _: cars).propose(jpeg(img))
    assert len(stalls) == 2 * N_STALLS + 1
    extra = rect_poly((X0 + N_STALLS * PITCH, 200, X0 + (N_STALLS + 1) * PITCH, 200 + DEPTH))
    i, score = best_match(extra, to_px(stalls))
    assert score > 0.75 and stalls[i].col == N_STALLS
    assert len(truth) == 2 * N_STALLS


def test_empty_photo_proposes_nothing():
    assert proposer().propose(jpeg(np.full((480, 640, 3), 100, np.uint8))) == []
    assert proposer().propose(jpeg(asphalt())) == []
    assert proposer(lambda _: []).propose(jpeg(asphalt())) == []


def test_undecodable_photo_is_permanent():
    with pytest.raises(PermanentJobError):
        proposer().propose(b"not a photo")
    with pytest.raises(PermanentJobError):
        proposer().propose(b"")


def test_model_version():
    assert proposer().model_version == "proposer-1|lines"
    assert proposer(lambda _: []).model_version == "proposer-1|lines+cars"


def _drone_scores(stalls) -> tuple[float, float]:
    lot = json.loads(DRONE_LOT.read_text())
    vp = lot["viewpoints"][0]
    size = [vp["imageWidth"], vp["imageHeight"]]  # in px: cv2's polygon maths wants px scale
    truth = [np.array(p) * size for p in vp["outlines"].values()]
    props = [np.array(s.polygon) * size for s in stalls]
    pairs = sorted(
        ((iou(t, p), i, j) for j, t in enumerate(truth) for i, p in enumerate(props)),
        reverse=True,
    )
    used_p: set[int] = set()
    used_t: set[int] = set()
    for score, i, j in pairs:
        if score < 0.5:
            break
        if i not in used_p and j not in used_t:
            used_p.add(i)
            used_t.add(j)
    matched = len(used_p)
    return matched / len(props), matched / len(truth)


def test_drone_photo_lines_only():
    """Measured: precision 93.8%, recall 97.6% (129 proposed, 124 hand-drawn). The extras
    are real stalls the hand-drawn layout leaves out (the left column beside the hatched
    island, row B's ends); two misses are row B's four wide stalls drawn as six."""
    stalls = proposer().propose(DRONE.read_bytes())
    precision, recall = _drone_scores(stalls)
    assert precision >= 0.9 and recall >= 0.93
    assert len({s.row for s in stalls}) == 6


@pytest.mark.real_model
def test_drone_photo_with_yolo():  # pragma: no cover - needs ultralytics and the weights
    if os.environ.get("RUN_MODEL_TESTS") != "1":
        pytest.skip("set RUN_MODEL_TESTS=1")
    from parking_worker.scorers.acpds_yolo import YoloCarDetector, verify_weights

    settings = Settings(_env_file=None, models_dir=str(ROOT / "models"))
    if not (ROOT / "models" / settings.yolo_weights).is_file():
        pytest.skip(f"models/{settings.yolo_weights} not downloaded")
    path, _ = verify_weights(Path(settings.models_dir), settings.yolo_weights)
    detector = YoloCarDetector(path, conf=settings.yolo_conf, seg=False, imgsz=settings.yolo_imgsz)
    stalls = build_proposer(settings, detector).propose(DRONE.read_bytes())
    precision, recall = _drone_scores(stalls)
    assert precision >= 0.9 and recall >= 0.95
    assert sum(s.evidence >= 0.7 for s in stalls) >= 0.8 * len(stalls)
