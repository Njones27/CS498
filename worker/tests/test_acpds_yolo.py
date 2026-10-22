"""AcpdsYoloScorer with fake models: tensor conventions, overlap geometry, weights pinning.

Tests that run the ACPDS tensor path need torch (the worker's `vision` extra) and are skipped
without it; the geometry and weight checks run everywhere. The real-model test is opt-in:
RUN_MODEL_TESTS=1 uv run pytest -m real_model
"""

from __future__ import annotations

import hashlib
import json
import os
import xml.etree.ElementTree as ET
from pathlib import Path

import cv2
import numpy as np
import pytest
from parking_core.errors import PermanentJobError
from parking_core.models import AlignedOutline, Cutoffs, SpaceState
from parking_core.settings import Settings
from parking_core.state_rules import decide_state
from parking_worker.scorers import StubScorer, build_scorer
from parking_worker.scorers.acpds_yolo import (
    AcpdsYoloScorer,
    Detection,
    acpds_rois,
    bgr_to_rgb_chw,
    car_overlaps,
    decode_photo,
    header_size,
    quad,
    rasterize,
    verify_weights,
)

ROOT = Path(__file__).resolve().parents[2]
W, H = 100, 100
# A 40 x 40 px space at x 20..60, y 20..60 of a 100 x 100 photo.
SPACE = [(0.2, 0.2), (0.6, 0.2), (0.6, 0.6), (0.2, 0.6)]
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


def png(bgr: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", bgr)
    assert ok
    return buf.tobytes()


def blank(h: int = H, w: int = W) -> np.ndarray:
    return np.zeros((h, w, 3), dtype=np.uint8)


def outline(space_id: str = "S1", polygon=SPACE, in_frame: bool = True) -> AlignedOutline:
    return AlignedOutline(space_id=space_id, polygon=polygon, in_frame=in_frame)


def car(box, cls_name: str = "car", conf: float = 0.9, **kw) -> Detection:
    return Detection(cls_name=cls_name, conf=conf, box_xyxy=box, **kw)


class FakeAcpds:
    """Records what it is given; returns fixed logits (or neutral ones)."""

    def __init__(self, logits=None) -> None:
        self.logits = logits
        self.calls: list[tuple] = []

    def __call__(self, image, rois):
        self.calls.append((image, rois))
        if self.logits is not None:
            return self.logits
        return np.zeros((rois.shape[0], 2), dtype=np.float32)


class FakeDetector:
    def __init__(self, detections: list[Detection] | None = None) -> None:
        self.detections = detections or []
        self.calls = 0

    def __call__(self, bgr: np.ndarray) -> list[Detection]:
        self.calls += 1
        return self.detections


def scorer(acpds=None, detector=None, **kw) -> AcpdsYoloScorer:
    return AcpdsYoloScorer(
        acpds or FakeAcpds(),
        detector or FakeDetector(),
        kw.pop("cutoffs", Cutoffs()),
        kw.pop("weight_hashes", {"acpds": "aaaaaaaaaaaa", "yolo": "bbbbbbbbbbbb"}),
        **kw,
    )


# --- ACPDS tensor conventions (need torch) --------------------------------------------------


def test_acpds_gets_rgb_chw_normalized_image():
    torch = pytest.importorskip("torch")
    bgr = blank(4, 6)
    bgr[1, 2] = (255, 0, 0)  # pure blue in OpenCV's BGR order
    fake = FakeAcpds()
    scorer(acpds=fake).score(png(bgr), [outline()])

    image, rois = fake.calls[0]
    assert isinstance(image, torch.Tensor) and image.dtype == torch.float32
    assert tuple(image.shape) == (3, 4, 6)  # CHW at native resolution
    mean, std = np.array(IMAGENET_MEAN), np.array(IMAGENET_STD)
    blue_rgb = (np.array([0.0, 0.0, 1.0]) - mean) / std  # blue lands in RGB channel 2
    np.testing.assert_allclose(image[:, 1, 2].numpy(), blue_rgb, rtol=1e-5)
    np.testing.assert_allclose(image[:, 0, 0].numpy(), -mean / std, rtol=1e-5)
    assert tuple(rois.shape) == (1, 4, 2) and rois.dtype == torch.float32


def test_acpds_rois_use_width_minus_one():
    pytest.importorskip("torch")
    fake = FakeAcpds()
    last = (100 / 101, 50 / 51)  # the last pixel: x = 100 of 101, y = 50 of 51
    corners = [(0.5, 0.5), (last[0], 0.5), last, (0.5, 1.0)]
    scorer(acpds=fake).score(png(blank(51, 101)), [outline(polygon=corners)])
    rois = fake.calls[0][1].numpy()[0]
    assert rois[2].tolist() == pytest.approx([1.0, 1.0])  # pixel 100 / (101 - 1)
    assert rois[0, 0] == pytest.approx(0.5 * 101 / 100)  # pixel 50.5 / (101 - 1)
    assert rois[0, 1] == pytest.approx(0.5 * 51 / 50)
    assert rois[3, 1] == pytest.approx(51 / 50)  # fraction 1.0 is past the last pixel centre


def test_logit_index_one_is_occupied():
    torch = pytest.importorskip("torch")
    fake = FakeAcpds(logits=torch.tensor([[5.0, 0.0], [0.0, 5.0]]))
    out = scorer(acpds=fake).score(png(blank()), [outline("A"), outline("B")])
    assert [s.acpds_score for s in out] == pytest.approx([0.0067, 0.9933], abs=1e-4)
    assert len(fake.calls) == 1  # one batched call for every space


def test_many_spaces_are_scored_in_bounded_batches():
    torch = pytest.importorskip("torch")
    from parking_worker.scorers.acpds_yolo import ACPDS_MAX_BATCH

    class Ramp:
        def __init__(self) -> None:
            self.calls: list[int] = []

        def __call__(self, image, rois):
            self.calls.append(len(rois))
            occupied = rois[:, 0, 0] * 10  # logit grows with the space's x position
            return torch.stack([torch.zeros_like(occupied), occupied], dim=1)

    n = ACPDS_MAX_BATCH + 6
    spaces = [
        outline(f"S{i}", [(i / n, 0.1), (i / n, 0.1), (i / n, 0.2), (i / n, 0.2)]) for i in range(n)
    ]
    fake = Ramp()
    out = scorer(acpds=fake).score(png(blank()), spaces)
    assert fake.calls == [ACPDS_MAX_BATCH, 6]
    assert [s.space_id for s in out] == [f"S{i}" for i in range(n)]
    scores = [s.acpds_score for s in out]
    assert scores == sorted(scores) and scores[0] == pytest.approx(0.5)


def test_input_res_resizes_before_acpds():
    pytest.importorskip("torch")
    fake = FakeAcpds()
    scorer(acpds=fake, input_res=50).score(png(blank(100, 200)), [outline()])
    assert tuple(fake.calls[0][0].shape) == (3, 50, 100)


def test_score_combines_acpds_and_overlap_in_input_order():
    torch = pytest.importorskip("torch")
    fake = FakeAcpds(logits=torch.tensor([[0.0, 5.0], [5.0, 0.0]]))
    detector = FakeDetector([car((20, 20, 60, 60))])
    other = [(0.7, 0.7), (0.9, 0.7), (0.9, 0.9), (0.7, 0.9)]
    out = scorer(acpds=fake, detector=detector).score(
        png(blank()), [outline("B-02", SPACE), outline("A-01", other)]
    )
    assert [s.space_id for s in out] == ["B-02", "A-01"]
    assert out[0].car_overlap == 1.0 and out[1].car_overlap == 0.0
    assert out[0].acpds_score > 0.99 and out[1].acpds_score < 0.01
    assert detector.calls == 1


def test_out_of_frame_space_gets_no_acpds_score_and_is_never_free():
    torch = pytest.importorskip("torch")
    fake = FakeAcpds(logits=torch.tensor([[5.0, 0.0]]))  # the visible space looks empty
    hanging = [(0.8, 0.2), (1.2, 0.2), (1.2, 0.6), (0.8, 0.6)]  # half outside the photo
    spaces = [outline("IN", SPACE), outline("OUT", hanging, in_frame=False)]
    out = scorer(acpds=fake).score(png(blank()), spaces)

    rois = fake.calls[0][1]
    assert len(fake.calls) == 1 and tuple(rois.shape) == (1, 4, 2)  # only the in-frame ROI
    assert rois[0, 1, 0].item() == pytest.approx(0.6 * 100 / 99)
    assert [s.in_frame for s in out] == [True, False]
    assert out[0].acpds_score < 0.01 and out[1].acpds_score is None
    assert out[1].car_overlap == 0.0
    cutoffs = Cutoffs()
    assert decide_state(out[1].acpds_score, out[1].car_overlap, False, cutoffs) != SpaceState.FREE
    lenient = cutoffs.model_copy(update={"require_car_check": False})
    assert decide_state(None, 0.0, False, lenient) == SpaceState.UNKNOWN
    # A visible car still marks it OCCUPIED.
    parked = scorer(acpds=FakeAcpds(), detector=FakeDetector([car((80, 20, 100, 60))]))
    seen = parked.score(png(blank()), [outline("OUT", hanging, in_frame=False)])[0]
    assert seen.acpds_score is None and seen.car_overlap == 1.0
    assert decide_state(None, seen.car_overlap, False, cutoffs) == SpaceState.OCCUPIED


def test_all_out_of_frame_skips_acpds():
    fake = FakeAcpds()
    out = scorer(acpds=fake).score(png(blank()), [outline(in_frame=False)])
    assert fake.calls == [] and out[0].acpds_score is None


def test_zero_area_space_still_gets_acpds_score():
    pytest.importorskip("torch")
    degenerate = [(0.3, 0.3)] * 4
    out = scorer(detector=FakeDetector([car((0, 0, 100, 100))])).score(
        png(blank()), [outline(polygon=degenerate)]
    )
    assert out[0].car_overlap == 0.0
    assert out[0].acpds_score == pytest.approx(0.5)


# --- conversions (numpy only) ---------------------------------------------------------------


def test_bgr_to_rgb_chw_swaps_channels():
    bgr = blank(2, 3)
    bgr[0, 1] = (255, 10, 0)
    rgb = bgr_to_rgb_chw(bgr)
    assert rgb.shape == (3, 2, 3) and rgb.flags["C_CONTIGUOUS"]
    assert rgb[:, 0, 1].tolist() == [0, 10, 255]


def test_acpds_rois_convention_without_clamping():
    rois = acpds_rois([outline(polygon=[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.5, 0.5)])], 101, 51)
    assert rois.dtype == np.float32 and rois.shape == (1, 4, 2)
    assert rois[0, 0].tolist() == [0.0, 0.0]
    assert rois[0, 2].tolist() == pytest.approx([1.01, 1.02])  # 101/100, 51/50: not clamped
    assert rois[0, 3].tolist() == pytest.approx([0.505, 0.51])
    assert acpds_rois([], 10, 10).shape == (0, 4, 2)


def test_non_quad_outlines_use_min_area_rect():
    pentagon = [(0.1, 0.1), (0.3, 0.1), (0.3, 0.2), (0.2, 0.25), (0.1, 0.2)]
    corners = quad(pentagon)
    assert corners.shape == (4, 2)
    assert corners[:, 0].min() == pytest.approx(0.1) and corners[:, 1].max() == pytest.approx(0.25)
    assert quad([]).shape == (4, 2)


def test_rasterize_counts_pixel_centres():
    mask, x0, y0 = rasterize(np.array([[20, 20], [60, 20], [60, 60], [20, 60]]), W, H)
    assert (x0, y0, mask.shape, int(mask.sum())) == (20, 20, (40, 40), 1600)
    assert rasterize(np.array([[0, 0], [1, 1]]), W, H)[0].size == 0  # < 3 points
    assert rasterize(np.array([[200, 0], [300, 0], [300, 50]]), W, H)[0].size == 0  # off-photo
    huge = np.array([[-1e12, -1e12], [1e12, -1e12], [1e12, 1e12], [-1e12, 1e12]])
    mask, x0, y0 = rasterize(huge, W, H)  # clipped before the int32 cast: covers the photo
    assert (x0, y0, int(mask.sum())) == (0, 0, W * H)


def test_undecodable_photo_is_permanent():
    for bad in (b"", b"not a jpeg"):
        with pytest.raises(PermanentJobError, match="Photo could not be decoded"):
            decode_photo(bad)
    with pytest.raises(PermanentJobError):
        scorer().score(b"garbage", [outline()])


def png_header(width: int, height: int) -> bytes:
    ihdr = width.to_bytes(4, "big") + height.to_bytes(4, "big") + bytes([8, 2, 0, 0, 0])
    return b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR" + ihdr + b"\0" * 4


def jpeg_header(width: int, height: int) -> bytes:
    app0 = b"\xff\xe0" + (16).to_bytes(2, "big") + b"JFIF\0" + b"\0" * 9
    sof = b"\xff\xc0" + (17).to_bytes(2, "big") + b"\x08"
    sof += height.to_bytes(2, "big") + width.to_bytes(2, "big") + b"\x03" + b"\0" * 9
    return b"\xff\xd8" + app0 + sof


def test_header_size_reads_png_and_jpeg_without_decoding():
    assert header_size(png(blank(7, 9))) == (9, 7)
    ok, buf = cv2.imencode(".jpg", blank(7, 9))
    assert header_size(buf.tobytes()) == (9, 7)
    assert header_size(jpeg_header(12_000, 9_000)) == (12_000, 9_000)
    assert header_size(b"GIF89a") is None


def test_oversized_photo_is_refused_before_decoding():
    # 20000 x 20000 = 400 MP: refused from the header alone (the bytes are not a real image).
    for bomb in (png_header(20_000, 20_000), jpeg_header(12_000, 9_000)):
        with pytest.raises(PermanentJobError, match="Photo is too large"):
            decode_photo(bomb)


def test_oversized_photo_is_refused_after_decoding(monkeypatch):
    monkeypatch.setattr("parking_worker.scorers.acpds_yolo.header_size", lambda image: None)
    monkeypatch.setattr("parking_worker.scorers.acpds_yolo.MAX_PIXELS", 99)
    with pytest.raises(PermanentJobError, match="Photo is too large"):
        decode_photo(png(blank(10, 10)))
    assert decode_photo(png(blank(9, 11))).shape == (9, 11, 3)


def test_worker_caps_opencv_decode_size():
    import parking_worker  # noqa: F401  (sets the variable before cv2 is imported)

    assert int(os.environ["OPENCV_IO_MAX_IMAGE_PIXELS"]) <= 2**27


def test_empty_outlines_return_nothing_without_running_models():
    fake, detector = FakeAcpds(), FakeDetector()
    assert scorer(acpds=fake, detector=detector).score(png(blank()), []) == []
    assert fake.calls == [] and detector.calls == 0


# --- car overlap geometry -------------------------------------------------------------------


def overlap(detections, mode="box", polygon=SPACE, conf=0.25) -> float:
    return car_overlaps([outline(polygon=polygon)], detections, W, H, mode, conf)[0]


def test_box_covering_space_is_full_overlap():
    assert overlap([car((10, 10, 70, 70))]) == 1.0


def test_box_over_left_half_is_half_overlap():
    assert overlap([car((20, 20, 40, 60))]) == pytest.approx(0.5, abs=0.02)


def test_disjoint_box_is_zero_and_no_detections_is_zero():
    assert overlap([car((70, 70, 90, 90))]) == 0.0
    assert overlap([]) == 0.0


def test_overlap_takes_the_best_single_car():
    left, right = car((20, 20, 40, 60)), car((40, 20, 50, 60))
    assert overlap([left, right]) == pytest.approx(0.5, abs=0.02)


def test_lower_half_mode_ignores_the_top_of_a_box():
    # A car parked in the row below: seen from an angle, the top of its box reaches up into
    # this space, but its lower half (where the car meets the ground) stays in its own row.
    below = car((20, 40, 60, 100))
    assert overlap([below], "box") == pytest.approx(0.5, abs=0.03)
    assert overlap([below], "box_lower_half") == 0.0
    assert overlap([car((20, 0, 60, 60))], "box_lower_half") == pytest.approx(0.75, abs=0.03)


def test_seg_mode_uses_the_mask():
    mask = np.zeros((H, W), dtype=bool)
    mask[20:60, 20:30] = True  # the car's pixels: the left quarter of the space
    det = car((0, 0, 100, 100), mask=mask)
    assert overlap([det], "seg") == pytest.approx(0.25, abs=0.01)
    assert overlap([det], "box") == 1.0
    cropped = car((20, 20, 30, 60), mask=np.ones((40, 10), dtype=bool), mask_xy0=(20, 20))
    assert overlap([cropped], "seg") == pytest.approx(0.25, abs=0.01)
    assert overlap([car((20, 20, 40, 60))], "seg") == pytest.approx(0.5, abs=0.02)  # no mask


def test_only_cars_trucks_and_buses_count():
    assert overlap([car((0, 0, 100, 100), cls_name="person")]) == 0.0
    assert overlap([car((0, 0, 100, 100), cls_name="truck")]) == 1.0
    assert overlap([car((0, 0, 100, 100), cls_name="bus")]) == 1.0


def test_low_confidence_cars_are_ignored():
    assert overlap([car((0, 0, 100, 100), conf=0.2)], conf=0.25) == 0.0
    assert overlap([car((0, 0, 100, 100), conf=0.25)], conf=0.25) == 1.0


def test_space_partly_outside_the_photo_uses_its_visible_pixels():
    hanging = [(0.8, 0.2), (1.2, 0.2), (1.2, 0.6), (0.8, 0.6)]
    assert overlap([car((80, 20, 100, 60))], polygon=hanging) == 1.0


def test_zero_area_space_has_zero_overlap():
    assert overlap([car((0, 0, 100, 100))], polygon=[(0.3, 0.3)] * 4) == 0.0


# --- scorer identity and construction -------------------------------------------------------


def test_model_version_names_weights_mode_and_cutoffs():
    s = scorer(
        cutoffs=Cutoffs(low=0.25, high=0.75, overlap=0.3, margin=0.05),
        weight_hashes={"acpds": "96901e9003a3", "yolo": "401cea9ab23a"},
        overlap_mode="box_lower_half",
    )
    assert s.model_version == (
        "acpds_yolo|acpds=96901e9003a3|yolo=401cea9ab23a|overlap=box_lower_half"
        "|low=0.25|high=0.75|overlap_cut=0.3|margin=0.05|require_car_check=True"
        "|yolo_conf=0.25|imgsz=1280|input_res=native"
    )
    other = scorer(
        yolo_conf=0.4, yolo_imgsz=640, input_res=720, cutoffs=Cutoffs(require_car_check=False)
    )
    assert other.model_version.endswith(
        "|require_car_check=False|yolo_conf=0.4|imgsz=640|input_res=720"
    )


def test_constructor_rejects_bad_mode_and_conf():
    with pytest.raises(ValueError, match="overlap_mode"):
        scorer(overlap_mode="polygon")
    with pytest.raises(ValueError, match="yolo_conf"):
        scorer(yolo_conf=0.0)


def test_settings_reject_yolo_conf_out_of_range():
    with pytest.raises(ValueError, match="YOLO_CONF"):
        Settings(_env_file=None, yolo_conf=1.5)
    for bad in (256, 1000):
        with pytest.raises(ValueError, match="YOLO_IMGSZ"):
            Settings(_env_file=None, yolo_imgsz=bad)
    assert Settings(_env_file=None, yolo_imgsz=640).yolo_imgsz == 640
    assert Settings(_env_file=None).yolo_imgsz == 1280
    assert Settings(_env_file=None).yolo_overlap_mode == "box"


def test_build_scorer_stub_unchanged():
    assert isinstance(build_scorer(Settings(_env_file=None, detector="stub")), StubScorer)


def write_models_dir(tmp_path: Path, files: dict[str, bytes], pins: dict[str, bytes]) -> Path:
    manifest = {
        rel: {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
        for rel, data in pins.items()
    }
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))
    for rel, data in files.items():
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_bytes(data)
    return tmp_path


def vision_settings(models_dir: Path, **kw) -> Settings:
    return Settings(_env_file=None, detector="acpds_yolo", models_dir=str(models_dir), **kw)


@pytest.fixture
def vision_installed(monkeypatch):
    """Weight checks run after the package check; pretend torch is there (CI has none)."""
    monkeypatch.setattr("parking_worker.scorers.acpds_yolo.missing_vision_packages", lambda: [])


@pytest.mark.usefixtures("vision_installed")
def test_from_settings_fails_clearly_when_weights_are_missing(tmp_path):
    models = write_models_dir(tmp_path, {}, {"acpds/RCNN_128_square_gopro.pt": b"x"})
    with pytest.raises(RuntimeError, match="scripts/download_weights.py") as exc:
        build_scorer(vision_settings(models))
    assert "Model weights missing" in str(exc.value)


@pytest.mark.usefixtures("vision_installed")
def test_from_settings_rejects_weights_that_do_not_match_the_pin(tmp_path):
    rel = "acpds/RCNN_128_square_gopro.pt"
    models = write_models_dir(tmp_path, {rel: b"tampered"}, {rel: b"original"})
    with pytest.raises(RuntimeError, match="SHA-256 mismatch"):
        AcpdsYoloScorer.from_settings(vision_settings(models))
    models = write_models_dir(tmp_path, {rel: b"short"}, {rel: b"original"})
    with pytest.raises(RuntimeError, match="size mismatch"):
        AcpdsYoloScorer.from_settings(vision_settings(models))


@pytest.mark.usefixtures("vision_installed")
def test_from_settings_checks_the_yolo_file_for_the_chosen_mode(tmp_path):
    acpds, yolo = "acpds/RCNN_128_square_gopro.pt", "yolo/yolo26m.pt"
    files = {acpds: b"a", yolo: b"y"}
    models = write_models_dir(tmp_path, files, files)
    with pytest.raises(RuntimeError, match="yolo26m-seg.pt is not pinned"):
        AcpdsYoloScorer.from_settings(vision_settings(models, yolo_overlap_mode="seg"))


def test_from_settings_checks_the_vision_extra_before_hashing(tmp_path, monkeypatch):
    def no_hashing(path):
        raise AssertionError("hashed weights before checking the packages")

    monkeypatch.setattr("parking_worker.scorers.acpds_yolo.sha256_file", no_hashing)
    monkeypatch.setattr(
        "importlib.util.find_spec", lambda name: None if name == "torchvision" else object()
    )
    with pytest.raises(RuntimeError, match="needs torchvision: install the worker's vision extra"):
        AcpdsYoloScorer.from_settings(vision_settings(tmp_path))


@pytest.mark.parametrize(
    "manifest",
    ["{not json", "[]", '{"acpds/RCNN_128_square_gopro.pt": {"sha256": "ab"}}'],
)
def test_malformed_manifest_is_a_clear_error(tmp_path, manifest):
    (tmp_path / "manifest.json").write_text(manifest)
    with pytest.raises(RuntimeError, match="scripts/download_weights.py"):
        verify_weights(tmp_path, "acpds/RCNN_128_square_gopro.pt")


def test_verify_weights_needs_a_manifest(tmp_path):
    with pytest.raises(RuntimeError, match="manifest not found"):
        verify_weights(tmp_path, "acpds/x.pt")
    path, sha = verify_weights(write_models_dir(tmp_path, {"a.pt": b"ok"}, {"a.pt": b"ok"}), "a.pt")
    assert path == tmp_path / "a.pt" and sha == hashlib.sha256(b"ok").hexdigest()


def test_committed_manifest_pins_every_default_weight_file():
    manifest = json.loads((ROOT / "models" / "manifest.json").read_text())
    s = Settings(_env_file=None)
    for rel in (s.acpds_weights, s.yolo_weights, s.yolo_seg_weights):
        assert len(manifest[rel]["sha256"]) == 64 and manifest[rel]["size"] > 1_000_000


# --- real models (opt-in) -------------------------------------------------------------------


def pklot_fixture() -> tuple[Path, Path, Path] | None:
    xmls = sorted((ROOT / "eval" / "fixtures" / "pklot").glob("*.xml"))
    if not xmls:
        return None
    xml = xmls[0]
    source = ET.parse(xml).getroot().get("id", "")
    lot = ROOT / "seed" / "lots" / f"pklot-{source}.json"
    return xml.with_suffix(".jpg"), xml, lot


@pytest.mark.real_model
def test_real_models_score_pklot_fixture():
    if os.environ.get("RUN_MODEL_TESTS") != "1":
        pytest.skip("set RUN_MODEL_TESTS=1")
    settings = Settings(_env_file=None, detector="acpds_yolo", models_dir=str(ROOT / "models"))
    for rel in (settings.acpds_weights, settings.yolo_weights):
        if not (ROOT / "models" / rel).is_file():
            pytest.skip(f"models/{rel} not downloaded")
    fixture = pklot_fixture()
    assert fixture is not None, "eval/fixtures/pklot/*.xml is committed"
    jpg, xml, lot_file = fixture

    lot = json.loads(lot_file.read_text())
    outlines = [
        AlignedOutline(space_id=sid, polygon=[tuple(p) for p in poly])
        for sid, poly in lot["viewpoints"][0]["outlines"].items()
    ]
    labels = {
        f"pk-{sp.get('id')}": sp.get("occupied") == "1"
        for sp in ET.parse(xml).getroot().iter("space")
    }
    scorer = AcpdsYoloScorer.from_settings(settings)
    scores = scorer.score(jpg.read_bytes(), outlines)

    assert len(scores) == len(outlines) > 0
    for s in scores:
        assert 0.0 <= s.acpds_score <= 1.0 and 0.0 <= s.car_overlap <= 1.0
    occupied = [s.acpds_score for s in scores if labels.get(s.space_id) is True]
    empty = [s.acpds_score for s in scores if labels.get(s.space_id) is False]
    assert occupied and max(occupied) > 0.5
    assert empty and min(empty) < 0.5
    assert scorer.model_version.startswith("acpds_yolo|acpds=96901e9003a3|yolo=401cea9ab23a|")
