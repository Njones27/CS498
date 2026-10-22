"""ACPDS + YOLO26m space scorer (HDD §4.5; detection plan, "Model stack").

ACPDS gives every mapped space an occupied score; YOLO26m finds cars, and the share of each
space they cover is the car overlap. `state_rules.decide_state` turns both into a state.

Both models sit behind plain callables so tests can inject fakes without torch or weights:

* ``acpds_model(image, rois) -> logits [N, 2]``: image is the preprocessed RGB float32 tensor
  ``[3, H, W]``, rois are ``[N, 4, 2]`` corner fractions in ACPDS' convention.
* ``car_detector(bgr) -> list[Detection]`` on the decoded BGR uint8 photo. It returns every
  class; only car/truck/bus count towards car overlap, the rest are kept for the admin overlay.

The five ACPDS details that fail silently when missed (detection plan p.2) live here:
``RCNN(roi_res=128, pooling_type="square")``, corners as x / (width - 1), BGR -> RGB, logit
index 1 = occupied, and weights pinned by SHA-256 (``models/manifest.json``).
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, get_args

import cv2
import numpy as np
from parking_core.errors import PermanentJobError
from parking_core.models import AlignedOutline, CarBox, Cutoffs, Point, SpaceScore

if TYPE_CHECKING:
    from parking_core.settings import Settings

OverlapMode = Literal["box", "box_lower_half", "seg"]
OVERLAP_MODES: tuple[str, ...] = get_args(OverlapMode)
CAR_CLASSES = frozenset({"car", "truck", "bus"})
ACPDS_ROI_RES = 128
ACPDS_POOLING = "square"
ACPDS_MAX_BATCH = 32
"""Spaces per ACPDS forward pass. ACPDS runs a ResNet-50 on every space's 128 px crop, so peak
memory grows with the batch (measured on CPU: about +1.4 GB for 100 spaces in one pass, +0.9 GB
in passes of 32, at the same speed). Chunking keeps big lots inside the worker's memory cap."""
MANIFEST_NAME = "manifest.json"
DOWNLOAD_HINT = "Run `uv run python scripts/download_weights.py` (see models/README.md)."
VISION_PACKAGES = ("torch", "torchvision", "ultralytics")
YOLO_MAX_DET = 600
"""Per-photo detection cap (ultralytics defaults to 300). Every class is kept for the overlay,
so a busy lot's misread non-car boxes must not push real cars out of the cap."""
MAX_PIXELS = 100_000_000
"""Photos above 100 MP are refused (a drone frame is ~12-50 MP); checked from the header."""
_MAX_COORD = 1e6  # px; keeps absurd outline coordinates inside int32 for cv2.fillPoly
_SUBPIXEL_SHIFT = 4  # cv2.fillPoly fixed-point bits: vertices at 1/16 pixel


@dataclass(frozen=True)
class Detection:
    """One detected object in photo pixels.

    ``mask`` (seg mode only) is a boolean array whose top-left pixel sits at ``mask_xy0`` in the
    photo: the default (0, 0) means a full-frame ``H x W`` mask. The YOLO wrapper stores each
    mask cropped to its own bounding box so a busy lot does not hold one full-frame array per
    car.
    """

    cls_name: str
    conf: float
    box_xyxy: tuple[float, float, float, float]
    mask: np.ndarray | None = None
    mask_xy0: tuple[int, int] = (0, 0)


AcpdsModel = Callable[[Any, Any], Any]
CarDetector = Callable[[np.ndarray], list[Detection]]


# --- photo and geometry helpers (numpy + OpenCV only) ---------------------------------------


def header_size(image: bytes) -> tuple[int, int] | None:
    """(width, height) from a PNG IHDR or JPEG SOF header without decoding, else None."""
    if image[:8] == b"\x89PNG\r\n\x1a\n" and image[12:16] == b"IHDR":
        return int.from_bytes(image[16:20], "big"), int.from_bytes(image[20:24], "big")
    if image[:2] != b"\xff\xd8":
        return None
    i = 2
    while i + 9 <= len(image):
        if image[i] != 0xFF:
            return None
        marker = image[i + 1]
        if marker == 0xFF:  # fill byte
            i += 1
            continue
        if marker in (0x01, 0xD8) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height = int.from_bytes(image[i + 5 : i + 7], "big")
            width = int.from_bytes(image[i + 7 : i + 9], "big")
            return width, height
        i += 2 + int.from_bytes(image[i + 2 : i + 4], "big")
    return None


def decode_photo(image: bytes) -> np.ndarray:
    """JPEG/PNG bytes -> BGR uint8 ``H x W x 3``. Undecodable bytes are a permanent failure.

    The pixel count is checked from the header before decoding and again after, so an
    oversized photo (or a decompression bomb) fails with "Photo is too large".
    """
    size = header_size(image) if image else None
    if size is not None and size[0] * size[1] > MAX_PIXELS:
        raise PermanentJobError("Photo is too large")
    bgr = None
    if image:
        try:
            bgr = cv2.imdecode(np.frombuffer(image, dtype=np.uint8), cv2.IMREAD_COLOR)
        except cv2.error:
            bgr = None
    if bgr is None or bgr.ndim != 3 or bgr.shape[0] < 2 or bgr.shape[1] < 2:
        raise PermanentJobError("Photo could not be decoded")
    if bgr.shape[0] * bgr.shape[1] > MAX_PIXELS:
        raise PermanentJobError("Photo is too large")
    return bgr


def bgr_to_rgb_chw(bgr: np.ndarray) -> np.ndarray:
    """OpenCV's BGR ``H x W x 3`` -> RGB ``3 x H x W`` (ACPDS was trained on RGB)."""
    return np.ascontiguousarray(bgr[:, :, ::-1].transpose(2, 0, 1))


def quad(polygon: Sequence[Point]) -> np.ndarray:
    """The 4 corners ACPDS pools from. Other polygons use their minimum-area rectangle."""
    pts = np.asarray(polygon, dtype=np.float32).reshape(-1, 2)
    if len(pts) == 4:
        return pts
    if len(pts) == 0:
        return np.zeros((4, 2), dtype=np.float32)
    return cv2.boxPoints(cv2.minAreaRect(pts)).astype(np.float32)


def acpds_rois(outlines: Sequence[AlignedOutline], width: int, height: int) -> np.ndarray:
    """``[N, 4, 2]`` float32 corners in ACPDS' convention: pixel x / (width - 1).

    Outline points are fractions of the photo size (pixel x = fx * width), so the ACPDS value
    is fx * width / (width - 1). ACPDS samples with ``align_corners=True``, where 1.0 is the
    centre of the last pixel; passing the raw fraction would shift every crop slightly. Values
    are not clamped: only in-frame outlines are scored, and ACPDS' square pooling zero-pads
    the rare corner that rounds a hair past the edge instead of distorting the crop.
    """
    if not outlines:
        return np.zeros((0, 4, 2), dtype=np.float32)
    rois = np.stack([quad(o.polygon) for o in outlines]).astype(np.float64)
    rois[..., 0] *= width / max(width - 1, 1)
    rois[..., 1] *= height / max(height - 1, 1)
    return rois.astype(np.float32)


def rasterize(points_px: np.ndarray, width: int, height: int) -> tuple[np.ndarray, int, int]:
    """Fill a polygon given in continuous pixel coordinates (pixel i spans [i, i + 1)).

    Returns ``(mask, x0, y0)``: a boolean mask over the polygon's bounding box, clipped to the
    photo, and the box's top-left pixel. Pixels whose centres fall inside are set, and so are
    the pixels ``cv2.fillPoly`` draws along the edges (it includes the boundary), so a slanted
    edge can add up to one pixel. Coordinates are clipped to +-1e6 px before the int32 cast.
    """
    pts = np.clip(np.asarray(points_px, dtype=np.float64).reshape(-1, 2), -_MAX_COORD, _MAX_COORD)
    if len(pts) < 3:
        return np.zeros((0, 0), dtype=bool), 0, 0
    x0 = max(0, math.floor(pts[:, 0].min()))
    y0 = max(0, math.floor(pts[:, 1].min()))
    x1 = min(width, math.ceil(pts[:, 0].max()))
    y1 = min(height, math.ceil(pts[:, 1].max()))
    if x1 <= x0 or y1 <= y0:
        return np.zeros((0, 0), dtype=bool), 0, 0
    mask = np.zeros((y1 - y0, x1 - x0), dtype=np.uint8)
    scale = 1 << _SUBPIXEL_SHIFT
    # Pixel centres sit at i + 0.5; fillPoly works on centres, hence the -0.5.
    local = np.round((pts - [x0 + 0.5, y0 + 0.5]) * scale).astype(np.int32)
    cv2.fillPoly(mask, [local], 1, lineType=cv2.LINE_8, shift=_SUBPIXEL_SHIFT)
    return mask.astype(bool), x0, y0


def _box_pixels(lo: float, hi: float) -> tuple[int, int]:
    """Half-open pixel range whose centres lie in [lo, hi]."""
    return math.ceil(lo - 0.5), math.floor(hi - 0.5) + 1


def _covered(
    poly: np.ndarray,
    px0: int,
    py0: int,
    x0: int,
    y0: int,
    x1: int,
    y1: int,
    region: np.ndarray | None = None,
) -> int:
    """Polygon pixels inside the rectangle [x0, x1) x [y0, y1), optionally AND a region mask
    whose top-left pixel is (x0, y0)."""
    ax0, ay0 = max(x0, px0), max(y0, py0)
    ax1, ay1 = min(x1, px0 + poly.shape[1]), min(y1, py0 + poly.shape[0])
    if ax1 <= ax0 or ay1 <= ay0:
        return 0
    sub = poly[ay0 - py0 : ay1 - py0, ax0 - px0 : ax1 - px0]
    if region is not None:
        sub = sub & region[ay0 - y0 : ay1 - y0, ax0 - x0 : ax1 - x0]
    return int(np.count_nonzero(sub))


def car_pixels(poly: np.ndarray, px0: int, py0: int, det: Detection, mode: OverlapMode) -> int:
    """Pixels of the rasterized space covered by one detection's car region."""
    bx1, by1, bx2, by2 = det.box_xyxy
    if mode == "seg" and det.mask is not None:
        mx0, my0 = det.mask_xy0
        mask = det.mask.astype(bool, copy=False)
        return _covered(poly, px0, py0, mx0, my0, mx0 + mask.shape[1], my0 + mask.shape[0], mask)
    if mode == "box_lower_half":
        by1 = (by1 + by2) / 2
    x0, x1 = _box_pixels(bx1, bx2)
    y0, y1 = _box_pixels(by1, by2)
    return _covered(poly, px0, py0, x0, y0, x1, y1)


def car_overlaps(
    outlines: Sequence[AlignedOutline],
    detections: Sequence[Detection],
    width: int,
    height: int,
    mode: OverlapMode = "box",
    min_conf: float = 0.25,
    classes: frozenset[str] = CAR_CLASSES,
) -> list[float]:
    """Per outline, max over car detections of |car region ∩ space| / |space| (0.0 if none).

    Only ``classes`` at ``conf >= min_conf`` count. Seg mode falls back to the box for a
    detection without a mask. A space with no pixels in the photo gets 0.0.
    """
    cars = [d for d in detections if d.cls_name in classes and d.conf >= min_conf]
    out: list[float] = []
    for outline in outlines:
        pts = np.asarray(outline.polygon, dtype=np.float64).reshape(-1, 2) * [width, height]
        poly, px0, py0 = rasterize(pts, width, height)
        area = int(np.count_nonzero(poly))
        if area == 0 or not cars:
            out.append(0.0)
            continue
        best = max(car_pixels(poly, px0, py0, d, mode) for d in cars)
        out.append(min(1.0, best / area))
    return out


def detection_box(det: Detection, width: int, height: int) -> CarBox:
    """A detection's box as photo fractions (clamped to 0..1) for storage and the overlay."""
    x1, y1, x2, y2 = det.box_xyxy
    fx = [min(1.0, max(0.0, v / width)) for v in (x1, x2)]
    fy = [min(1.0, max(0.0, v / height)) for v in (y1, y2)]
    return CarBox(cls_name=det.cls_name, conf=det.conf, box=(fx[0], fy[0], fx[1], fy[1]))


# --- pinned weights --------------------------------------------------------------------------


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while block := fh.read(1 << 20):
            digest.update(block)
    return digest.hexdigest()


def missing_vision_packages() -> list[str]:
    return [m for m in VISION_PACKAGES if importlib.util.find_spec(m) is None]


def verify_weights(models_dir: Path, rel_path: str) -> tuple[Path, str]:
    """Check ``models_dir/rel_path`` against ``models_dir/manifest.json``; return (path, sha256).

    Raises RuntimeError (the worker must not start) when the manifest is missing or
    malformed, has no entry, the file is missing, or its size or SHA-256 differs from the pin.
    """
    manifest_path = models_dir / MANIFEST_NAME
    if not manifest_path.is_file():
        raise RuntimeError(f"Model manifest not found at {manifest_path}. {DOWNLOAD_HINT}")
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            f"Model manifest {manifest_path} is unreadable. {DOWNLOAD_HINT}"
        ) from exc
    entry = manifest.get(rel_path) if isinstance(manifest, dict) else None
    if entry is None:
        raise RuntimeError(f"{rel_path} is not pinned in {manifest_path}. {DOWNLOAD_HINT}")
    if not (
        isinstance(entry, dict)
        and isinstance(entry.get("sha256"), str)
        and isinstance(entry.get("size"), int)
    ):
        raise RuntimeError(
            f"{rel_path} in {manifest_path} needs a sha256 string and a size. {DOWNLOAD_HINT}"
        )
    path = models_dir / rel_path
    if not path.is_file():
        raise RuntimeError(f"Model weights missing: {path}. {DOWNLOAD_HINT}")
    if path.stat().st_size != entry["size"]:
        raise RuntimeError(f"Model weights size mismatch: {path}. {DOWNLOAD_HINT}")
    sha = sha256_file(path)
    if sha != entry["sha256"]:
        raise RuntimeError(f"Model weights SHA-256 mismatch: {path}. {DOWNLOAD_HINT}")
    return path, sha


def load_acpds(path: Path) -> AcpdsModel:  # pragma: no cover - needs torch and the weights
    import torch

    from .acpds.rcnn import RCNN

    model = RCNN(roi_res=ACPDS_ROI_RES, pooling_type=ACPDS_POOLING)
    model.load_state_dict(torch.load(path, map_location="cpu", weights_only=True))
    model.eval()
    return model


class YoloCarDetector:  # pragma: no cover - needs ultralytics and the weights
    """``ultralytics.YOLO`` as a ``CarDetector``: boxes (and masks when seg) of every class, or
    only ``classes`` when given. The scorer picks the car classes itself."""

    def __init__(
        self,
        path: Path,
        conf: float,
        seg: bool,
        imgsz: int = 1280,
        classes: frozenset[str] | None = None,
    ) -> None:
        from ultralytics import YOLO

        self.model = YOLO(str(path))
        self.conf = conf
        self.seg = seg
        self.imgsz = imgsz
        self.class_ids = (
            None
            if classes is None
            else [i for i, name in self.model.names.items() if name in classes]
        )

    def __call__(self, bgr: np.ndarray) -> list[Detection]:
        height, width = bgr.shape[:2]
        result = self.model.predict(
            bgr,
            conf=self.conf,
            imgsz=self.imgsz,
            classes=self.class_ids,
            max_det=YOLO_MAX_DET,
            device="cpu",
            verbose=False,
        )[0]
        boxes = result.boxes
        xyxy = boxes.xyxy.cpu().numpy()
        confs = boxes.conf.cpu().numpy()
        cls_ids = boxes.cls.cpu().numpy().astype(int)
        polygons = result.masks.xy if self.seg and result.masks is not None else None
        detections = []
        for i in range(len(xyxy)):
            mask, xy0 = None, (0, 0)
            cls_name = self.model.names[int(cls_ids[i])]
            if polygons is not None and cls_name in CAR_CLASSES:
                # Masks come back as polygons in photo pixels (masks.data is at the letterboxed
                # inference size); rasterize each one cropped to its own bounding box. Only car
                # classes use masks (overlap), so other classes keep mask=None.
                mask, mx0, my0 = rasterize(polygons[i], width, height)
                xy0 = (mx0, my0)
            detections.append(
                Detection(
                    cls_name=cls_name,
                    conf=float(confs[i]),
                    box_xyxy=tuple(float(v) for v in xyxy[i]),
                    mask=mask,
                    mask_xy0=xy0,
                )
            )
        return detections


# --- the scorer ------------------------------------------------------------------------------


class AcpdsYoloScorer:
    def __init__(
        self,
        acpds_model: AcpdsModel,
        car_detector: CarDetector,
        cutoffs: Cutoffs,
        weight_hashes: dict[str, str],
        *,
        yolo_conf: float = 0.25,
        overlap_mode: OverlapMode = "box",
        input_res: int | None = None,
        yolo_imgsz: int = 1280,
    ) -> None:
        if overlap_mode not in OVERLAP_MODES:
            raise ValueError(f"overlap_mode must be one of {OVERLAP_MODES}")
        if not 0 < yolo_conf <= 1:
            raise ValueError("yolo_conf must be in (0, 1]")
        self.acpds_model = acpds_model
        self.car_detector = car_detector
        self.cutoffs = cutoffs
        self.weight_hashes = dict(weight_hashes)
        self.yolo_conf = yolo_conf
        self.overlap_mode: OverlapMode = overlap_mode
        self.input_res = input_res
        self.yolo_imgsz = yolo_imgsz
        self.last_detections: list[CarBox] = []

    @classmethod
    def from_settings(cls, settings: Settings) -> AcpdsYoloScorer:
        """Check the vision packages and the pinned weights, then load both models on CPU."""
        missing = missing_vision_packages()
        if missing:
            raise RuntimeError(
                f"DETECTOR=acpds_yolo needs {', '.join(missing)}: install the worker's vision "
                "extra (`uv sync --all-packages --extra vision`, or WORKER_EXTRAS=vision in Docker)"
            )
        models_dir = Path(settings.models_dir)
        seg = settings.yolo_overlap_mode == "seg"
        acpds_path, acpds_sha = verify_weights(models_dir, settings.acpds_weights)
        yolo_rel = settings.yolo_seg_weights if seg else settings.yolo_weights
        yolo_path, yolo_sha = verify_weights(models_dir, yolo_rel)
        return cls(  # pragma: no cover - needs torch, ultralytics and the weights
            load_acpds(acpds_path),
            YoloCarDetector(yolo_path, conf=settings.yolo_conf, seg=seg, imgsz=settings.yolo_imgsz),
            settings.cutoffs,
            {"acpds": acpds_sha[:12], "yolo": yolo_sha[:12]},
            yolo_conf=settings.yolo_conf,
            overlap_mode=settings.yolo_overlap_mode,
            input_res=settings.acpds_input_res,
            yolo_imgsz=settings.yolo_imgsz,
        )

    @property
    def model_version(self) -> str:
        c = self.cutoffs
        return (
            f"acpds_yolo|acpds={self.weight_hashes.get('acpds', '?')}"
            f"|yolo={self.weight_hashes.get('yolo', '?')}|overlap={self.overlap_mode}"
            f"|low={c.low}|high={c.high}|overlap_cut={c.overlap}|margin={c.margin}"
            f"|require_car_check={c.require_car_check}|yolo_conf={self.yolo_conf}"
            f"|imgsz={self.yolo_imgsz}|input_res={self.input_res or 'native'}"
        )

    def score(self, image: bytes, outlines: list[AlignedOutline]) -> list[SpaceScore]:
        """Score every outline. Also sets ``last_detections`` to every detection on the photo at
        ``conf >= yolo_conf``, any class (a debug view); only cars count towards overlap."""
        self.last_detections = []
        bgr = decode_photo(image)
        if not outlines:
            return []
        height, width = bgr.shape[:2]
        # ACPDS only sees spaces wholly in the photo: a crop of a half-visible stall would give
        # a confident but meaningless score. Out-of-frame spaces keep their car overlap, so a
        # visible car can still mark them OCCUPIED; without an ACPDS score they are never FREE.
        visible = [o for o in outlines if o.in_frame]
        scores = iter(self.acpds_scores(bgr, visible)) if visible else iter(())
        acpds = [float(next(scores)) if o.in_frame else None for o in outlines]
        found = [d for d in self.car_detector(bgr) if d.conf >= self.yolo_conf]
        overlaps = car_overlaps(outlines, found, width, height, self.overlap_mode, self.yolo_conf)
        self.last_detections = [detection_box(d, width, height) for d in found]
        return [
            SpaceScore(
                space_id=o.space_id,
                acpds_score=a,
                car_overlap=float(v),
                in_frame=o.in_frame,
            )
            for o, a, v in zip(outlines, acpds, overlaps, strict=True)
        ]

    def acpds_scores(self, bgr: np.ndarray, outlines: Sequence[AlignedOutline]) -> np.ndarray:
        """Occupied probability per outline: batched ACPDS calls of up to ACPDS_MAX_BATCH."""
        import torch

        from .acpds.transforms import preprocess

        height, width = bgr.shape[:2]
        image = preprocess(torch.from_numpy(bgr_to_rgb_chw(bgr)), res=self.input_res)
        rois = torch.from_numpy(acpds_rois(outlines, width, height))
        scores = []
        with torch.no_grad():
            for start in range(0, len(rois), ACPDS_MAX_BATCH):
                batch = rois[start : start + ACPDS_MAX_BATCH]
                logits = torch.as_tensor(self.acpds_model(image, batch), dtype=torch.float32)
                scores.append(torch.softmax(logits, dim=1)[:, 1])  # index 1 = occupied
        return torch.cat(scores).cpu().numpy() if scores else np.zeros(0, dtype=np.float32)
