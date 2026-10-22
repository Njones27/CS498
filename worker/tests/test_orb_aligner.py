"""ORB aligner against synthetic known transforms (HDD §11 "Alignment")."""

from __future__ import annotations

import hashlib

import cv2
import numpy as np
import pytest
from parking_core import keys
from parking_core.adapters.memory import MemoryObjectStore
from parking_core.errors import AlignmentError
from parking_core.models import Viewpoint
from parking_core.settings import Settings, build_adapters
from parking_worker.aligners import IdentityAligner, OrbAligner, build_aligner

W, H = 640, 480
TOLERANCE = 0.015
"""Recovered corners must be within 1.5% of the image size of the ground truth."""
OUTLINES = {
    "A-01": [(0.20, 0.30), (0.35, 0.30), (0.35, 0.55), (0.20, 0.55)],
    "A-02": [(0.45, 0.35), (0.60, 0.35), (0.60, 0.60), (0.45, 0.60)],
    "B-01": [(0.65, 0.55), (0.80, 0.55), (0.80, 0.80), (0.65, 0.80)],
}


def textured_image(seed: int = 0, size: tuple[int, int] = (W, H)) -> np.ndarray:
    """Grey canvas with random filled rectangles, circles and lines: plenty of ORB corners."""
    rng = np.random.default_rng(seed)
    w, h = size
    img = np.full((h, w), 128, dtype=np.uint8)
    for _ in range(60):
        colour = int(rng.integers(0, 256))
        x, y = int(rng.integers(0, w)), int(rng.integers(0, h))
        if rng.random() < 0.5:
            x2, y2 = x + int(rng.integers(15, 90)), y + int(rng.integers(15, 90))
            cv2.rectangle(img, (x, y), (x2, y2), colour, -1)
        else:
            cv2.circle(img, (x, y), int(rng.integers(8, 45)), colour, -1)
    for _ in range(25):
        p1 = (int(rng.integers(0, w)), int(rng.integers(0, h)))
        p2 = (int(rng.integers(0, w)), int(rng.integers(0, h)))
        cv2.line(img, p1, p2, int(rng.integers(0, 256)), int(rng.integers(1, 4)))
    return img


def encode(img: np.ndarray, ext: str = ".png") -> bytes:
    ok, buf = cv2.imencode(ext, img)
    assert ok
    return buf.tobytes()


def store_reference(
    store: MemoryObjectStore, img: np.ndarray, view_id: str = "V1", outlines=None
) -> Viewpoint:
    data = encode(img)
    key = keys.reference_image_key("lot", view_id, hashlib.sha256(data).hexdigest())
    store.put(key, data, "image/png")
    return Viewpoint(
        lot_id="lot",
        view_id=view_id,
        name=view_id,
        reference_image_key=key,
        image_width=img.shape[1],
        image_height=img.shape[0],
        outlines=OUTLINES if outlines is None else outlines,
    )


@pytest.fixture
def store() -> MemoryObjectStore:
    return MemoryObjectStore()


@pytest.fixture
def reference() -> np.ndarray:
    return textured_image(0)


def expected_corners(polygon, h: np.ndarray, out_size: tuple[int, int]) -> np.ndarray:
    pts = np.array(polygon, dtype=np.float64).reshape(-1, 1, 2) * (W, H)
    return cv2.perspectiveTransform(pts, h).reshape(-1, 2) / out_size


def translation(dx: float, dy: float) -> np.ndarray:
    return np.array([[1, 0, dx], [0, 1, dy], [0, 0, 1]], dtype=np.float64)


def rotation_scale(deg: float, scale: float) -> np.ndarray:
    return np.vstack([cv2.getRotationMatrix2D((W / 2, H / 2), deg, scale), [0, 0, 1]])


PERSPECTIVE = np.array([[1.02, 0.03, -10.0], [0.02, 0.98, 6.0], [1e-4, -8e-5, 1.0]])


@pytest.mark.parametrize(
    ("h", "out_size"),
    [
        pytest.param(translation(40, -25), (W, H), id="translation"),
        pytest.param(rotation_scale(8, 1.1), (W, H), id="rotation-scale"),
        pytest.param(PERSPECTIVE, (W + 80, H + 60), id="perspective-larger-canvas"),
    ],
)
def test_recovers_known_homography(store, reference, h, out_size):
    vp = store_reference(store, reference)
    photo = cv2.warpPerspective(reference, h, out_size)
    aligned = OrbAligner(store).align(encode(photo, ".jpg"), vp)

    assert [o.space_id for o in aligned] == list(OUTLINES)
    for outline in aligned:
        expected = expected_corners(OUTLINES[outline.space_id], h, out_size)
        got = np.array(outline.polygon)
        assert got.shape == (4, 2)
        assert np.abs(got - expected).max() < TOLERANCE, outline.space_id
        assert outline.in_frame
        assert all(isinstance(v, float) for pt in outline.polygon for v in pt)


def test_identity_photo_maps_outlines_onto_themselves(store, reference):
    vp = store_reference(store, reference)
    aligned = OrbAligner(store).align(encode(reference, ".jpg"), vp)
    for outline in aligned:
        assert np.abs(np.array(outline.polygon) - OUTLINES[outline.space_id]).max() < TOLERANCE


def test_outline_pushed_out_of_frame_is_flagged(store, reference):
    vp = store_reference(store, reference)
    h = translation(-150, 0)  # A-01 starts at x=0.20*640=128 px: its left edge leaves the frame
    photo = cv2.warpPerspective(reference, h, (W, H))
    aligned = {o.space_id: o for o in OrbAligner(store).align(encode(photo), vp)}

    assert not aligned["A-01"].in_frame
    assert min(x for x, _ in aligned["A-01"].polygon) < 0
    assert aligned["A-02"].in_frame and aligned["B-01"].in_frame
    expected = expected_corners(OUTLINES["A-01"], h, (W, H))
    assert np.abs(np.array(aligned["A-01"].polygon) - expected).max() < TOLERANCE


@pytest.mark.parametrize(
    ("ref_size", "factor"),
    [
        pytest.param((W, H), 2.5, id="2.5x"),
        pytest.param((320, 240), 6, id="6x-small-reference"),  # beyond ORB's ~3.6x pyramid
        pytest.param((W, H), 0.5, id="photo-smaller"),
    ],
)
def test_photo_at_different_resolution(store, ref_size, factor):
    """A phone photo is usually much larger than the reference; scale must not be rejected."""
    reference = textured_image(0, ref_size)
    vp = store_reference(store, reference)
    h = translation(0.03 * ref_size[0], 0.02 * ref_size[1]) @ np.diag([factor, factor, 1.0])
    out_size = (round(ref_size[0] * factor), round(ref_size[1] * factor))
    photo = cv2.warpPerspective(reference, h, out_size)
    aligned = OrbAligner(store).align(encode(photo, ".jpg"), vp)
    for outline in aligned:
        pts = np.array(OUTLINES[outline.space_id], dtype=np.float64).reshape(-1, 1, 2)
        expected = cv2.perspectiveTransform(pts * ref_size, h).reshape(-1, 2) / out_size
        assert np.abs(np.array(outline.polygon) - expected).max() < TOLERANCE


def test_large_images_are_downscaled_for_orb(store):
    """References above WORK_LONG_EDGE are processed (and cached) at the working size."""
    reference = textured_image(0, (2000, 1500))
    vp = store_reference(store, reference)
    aligner = OrbAligner(store)
    aligned = aligner.align(encode(reference, ".jpg"), vp)
    feats = aligner._cache[vp.reference_image_key]
    assert (feats.width, feats.height) == (1280, 960)
    assert feats.points[:, 0].max() < 1280 and feats.points[:, 1].max() < 960
    for outline in aligned:
        assert np.abs(np.array(outline.polygon) - OUTLINES[outline.space_id]).max() < TOLERANCE


def test_outline_flush_with_border_is_in_frame(store, reference):
    full = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
    outside = [(-0.02, 0.0), (1.0, 0.0), (1.0, 1.0), (-0.02, 1.0)]
    vp = store_reference(store, reference, outlines={"FULL": full, "OUT": outside})
    aligned = {o.space_id: o for o in OrbAligner(store).align(encode(reference), vp)}
    assert aligned["FULL"].in_frame
    assert not aligned["OUT"].in_frame


@pytest.mark.parametrize(
    "photo",
    [
        pytest.param(np.full((H, W), 128, dtype=np.uint8), id="flat-grey"),
        pytest.param(
            np.random.default_rng(42).integers(0, 256, (H, W), dtype=np.uint8), id="noise"
        ),
    ],
)
def test_unrelated_photo_is_too_few_matches(store, reference, photo):
    vp = store_reference(store, reference)
    with pytest.raises(AlignmentError) as exc:
        OrbAligner(store).align(encode(photo), vp)
    assert str(exc.value) == "Too few matches"


@pytest.mark.parametrize(
    "seed",
    [
        *range(10),
        # These pass the match, inlier and ratio gates and are caught only by `_plausible`.
        pytest.param(115, id="115-plausibility"),
        pytest.param(277, id="277-plausibility"),
    ],
)
def test_unrelated_scene_is_rejected(store, seed):
    """US-12 #1: a photo from the wrong spot is rejected, even when its texture is similar
    enough to the reference to produce coincidental ORB matches."""
    vp = store_reference(store, textured_image(seed))
    for ext in (".png", ".jpg"):
        with pytest.raises(AlignmentError) as exc:
            OrbAligner(store).align(encode(textured_image(seed + 1000), ext), vp)
        assert str(exc.value) == "Too few matches"


def test_min_inlier_ratio_is_enforced(store, reference):
    vp = store_reference(store, reference)
    photo = encode(cv2.warpPerspective(reference, translation(40, -25), (W, H)), ".jpg")
    assert OrbAligner(store, min_inlier_ratio=0.4).align(photo, vp)
    with pytest.raises(AlignmentError) as exc:
        OrbAligner(store, min_inlier_ratio=1.01).align(photo, vp)
    assert str(exc.value) == "Too few matches"


def test_flat_reference_is_too_few_matches(store, reference):
    vp = store_reference(store, np.full((H, W), 90, dtype=np.uint8))
    with pytest.raises(AlignmentError) as exc:
        OrbAligner(store).align(encode(reference), vp)
    assert str(exc.value) == "Too few matches"


def test_min_inliers_is_enforced(store, reference):
    vp = store_reference(store, reference)
    aligner = OrbAligner(store, min_inliers=100_000)
    with pytest.raises(AlignmentError) as exc:
        aligner.align(encode(reference), vp)
    assert str(exc.value) == "Too few matches"


def test_degenerate_homography_is_rejected(store, reference):
    """Collapsed, exploded, folded, mirrored or non-finite homographies are not plausible."""
    ref = OrbAligner(store)._features(encode(reference), what="Reference image")
    plausible = OrbAligner._plausible
    assert plausible(rotation_scale(8, 1.1), ref, ref)
    assert plausible(PERSPECTIVE, ref, ref)
    assert plausible(-np.eye(3), ref, ref)  # same homography as the identity
    assert not plausible(np.diag([0.25, 0.25, 1.0]), ref, ref)  # |det| 0.0625 < 0.1
    assert not plausible(np.diag([4.0, 4.0, 1.0]), ref, ref)  # |det| 16 > 10
    assert not plausible(np.full((3, 3), np.nan), ref, ref)
    assert not plausible(np.array([[1, 0, 0], [0, 1, 0], [0, 0, 0.0]]), ref, ref)
    assert not plausible(np.diag([-1.0, 1.0, 1.0]), ref, ref)  # mirrored
    behind = np.array([[1, 0, 0], [0, 1, 0], [-0.004, 0, 1.0]])  # right edge past the horizon
    assert not plausible(behind, ref, ref)
    # Corners swapped into a self-crossing "bow tie".
    src = np.array([[0, 0], [W, 0], [W, H], [0, H]], dtype=np.float32)
    bow_tie = cv2.getPerspectiveTransform(src, src[[0, 1, 3, 2]])
    assert not plausible(bow_tie, ref, ref)


def test_viewpoint_without_outlines_returns_nothing(store, reference):
    vp = store_reference(store, reference, outlines={})
    assert OrbAligner(store).align(encode(reference), vp) == []


def test_missing_reference_key(store, reference):
    vp = store_reference(store, reference).model_copy(update={"reference_image_key": None})
    with pytest.raises(AlignmentError) as exc:
        OrbAligner(store).align(encode(reference), vp)
    assert str(exc.value) == "No reference image for viewpoint"


def test_reference_not_in_store(store, reference):
    vp = store_reference(store, reference).model_copy(
        update={"reference_image_key": keys.reference_image_key("lot", "V1", "0" * 64)}
    )
    with pytest.raises(AlignmentError) as exc:
        OrbAligner(store).align(encode(reference), vp)
    assert str(exc.value) == "No reference image for viewpoint"


def test_undecodable_photo(store, reference):
    vp = store_reference(store, reference)
    with pytest.raises(AlignmentError) as exc:
        OrbAligner(store).align(b"not an image", vp)
    assert str(exc.value) == "Photo could not be decoded"


def test_photo_too_small_for_orb(store, reference):
    """ORB raises cv2.error on a 1x1 image; that must be a permanent AlignmentError."""
    vp = store_reference(store, reference)
    with pytest.raises(AlignmentError) as exc:
        OrbAligner(store).align(encode(np.zeros((1, 1), dtype=np.uint8)), vp)
    assert str(exc.value) == "Photo could not be processed"


def test_reference_too_small_for_orb(store, reference):
    vp = store_reference(store, np.zeros((1, 1), dtype=np.uint8))
    with pytest.raises(AlignmentError) as exc:
        OrbAligner(store).align(encode(reference), vp)
    assert str(exc.value) == "Reference image could not be processed"


def test_outline_with_too_few_points(store, reference):
    vp = store_reference(store, reference, outlines={"A": [(0.1, 0.1), (0.2, 0.2)]})
    with pytest.raises(AlignmentError) as exc:
        OrbAligner(store).align(encode(reference), vp)
    assert str(exc.value) == "Outline for A has fewer than 3 points"


def test_cache_is_keyed_by_reference(store):
    first_img, second_img = textured_image(0), textured_image(1)
    first = store_reference(store, first_img, "V1")
    second = store_reference(store, second_img, "V2")
    assert first.reference_image_key != second.reference_image_key
    aligner = OrbAligner(store)

    for img, vp, h in (
        (first_img, first, translation(30, 20)),
        (second_img, second, translation(-35, 15)),
    ):
        aligned = aligner.align(encode(cv2.warpPerspective(img, h, (W, H))), vp)
        for outline in aligned:
            expected = expected_corners(OUTLINES[outline.space_id], h, (W, H))
            assert np.abs(np.array(outline.polygon) - expected).max() < TOLERANCE
    assert list(aligner._cache) == [first.reference_image_key, second.reference_image_key]


def test_cache_hit_skips_storage_and_evicts_oldest(store, monkeypatch):
    imgs = [textured_image(i) for i in range(3)]
    vps = [store_reference(store, img, f"V{i}") for i, img in enumerate(imgs)]
    aligner = OrbAligner(store, cache_size=2)
    for img, vp in zip(imgs, vps, strict=True):
        aligner.align(encode(img), vp)
    assert list(aligner._cache) == [vps[1].reference_image_key, vps[2].reference_image_key]

    calls: list[str] = []
    monkeypatch.setattr(store, "get", calls.append)
    aligner.align(encode(imgs[1]), vps[1])
    assert calls == []
    assert list(aligner._cache)[-1] == vps[1].reference_image_key


def test_build_aligner_from_settings():
    default = Settings(app_env="test", _env_file=None)  # type: ignore[call-arg]
    adapters = build_adapters(default)
    assert isinstance(build_aligner(default, adapters), IdentityAligner)

    orb_settings = Settings(
        app_env="test",
        aligner="orb",
        orb_min_matches=12,
        orb_min_inliers=9,
        orb_min_inlier_ratio=0.5,
        orb_ransac_px=3.0,
        _env_file=None,  # type: ignore[call-arg]
    )
    aligner = build_aligner(orb_settings, adapters)
    assert isinstance(aligner, OrbAligner)
    assert (
        aligner._min_matches,
        aligner._min_inliers,
        aligner._min_inlier_ratio,
        aligner._ransac_px,
    ) == (12, 9, 0.5, 3.0)
    assert OrbAligner(adapters.object_store)._min_inliers == default.orb_min_inliers == 25
    assert OrbAligner(adapters.object_store)._min_inlier_ratio == default.orb_min_inlier_ratio
