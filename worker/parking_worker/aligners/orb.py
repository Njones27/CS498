"""ORB features + RANSAC homography aligner (HDD §4.4).

Maps a viewpoint's outlines, drawn as fractions of its reference photo, onto a new photo
from the same camera position. The homography is estimated from ORB keypoint matches
between the reference and the photo; outlines whose corners land outside the photo are
marked `in_frame=False` so the state rules report them UNKNOWN.

A photo is rejected with "Too few matches" (US-06 #2, US-12 #1) unless all of these hold.
The thresholds are settings (`ORB_*`) and are expected to be tuned in the pilot:

- at least `min_matches` (30) matches pass Lowe's ratio test;
- at least `min_inliers` (25) of them agree on one RANSAC homography (`ransac_px`, 5 px);
- the inliers are at least `min_inlier_ratio` (0.4) of the good matches. A true match of the
  same scene typically scores about 0.9; an unrelated scene with similar texture can still
  produce a few dozen coincidental inliers, but usually as a small fraction of its matches;
- the homography is plausible for a camera that has only shifted a little: it is finite;
  every corner of the reference frame stays in front of the camera (so the frame maps to a
  convex quadrilateral, never a fold or "bow tie"); that quadrilateral is not mirrored; and
  it covers 0.1x to 10x the photo. Areas are in
  image fractions, so a photo at a different resolution than the reference is not
  penalised. This catches coincidental inlier clusters whose homography folds or collapses
  the image.
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from dataclasses import dataclass

import cv2
import numpy as np
from parking_core.errors import AlignmentError
from parking_core.interfaces import ObjectStore
from parking_core.models import AlignedOutline, Viewpoint

log = logging.getLogger(__name__)

TOO_FEW_MATCHES = "Too few matches"
"""Shown to admins on the Snapshots page (US-06 #2); keep the wording exact."""
NO_REFERENCE = "No reference image for viewpoint"
LOWE_RATIO = 0.75
EPS = 1e-6
"""Slack for `in_frame`: an outline flush with the border maps to e.g. -1.9e-17 or 1.0000000002."""
WORK_LONG_EDGE = 1280
"""References are downscaled to at most this long edge before ORB, and photos to at most the
reference's working long edge. ORB's scale pyramid only spans about 3.6x, so a 4032 px phone
photo would not match a 640 px reference otherwise; it also bounds runtime and memory on
large uploads."""
MIN_AREA, MAX_AREA = 0.1, 10.0
"""Allowed area of the mapped reference frame, as a fraction of the photo."""
_FRAME = np.array([[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], dtype=np.float64).T
"""The reference image's corners in homogeneous image-fraction coordinates (3 x 4)."""


@dataclass(frozen=True)
class _Features:
    """ORB features of one image at its working size (at most `WORK_LONG_EDGE`).

    Everything downstream works in this pixel space: the homography maps reference working
    pixels to photo working pixels, `ransac_px` is measured in it, and outlines go in and come
    out as fractions of `width` x `height`, which equal fractions of the original image.
    """

    points: np.ndarray
    """(N, 2) float32 keypoint coordinates in working-image pixels."""
    descriptors: np.ndarray | None
    width: int
    height: int


class OrbAligner:
    def __init__(
        self,
        object_store: ObjectStore,
        *,
        features: int = 2000,
        min_matches: int = 30,
        min_inliers: int = 25,
        min_inlier_ratio: float = 0.4,
        ransac_px: float = 5.0,
        cache_size: int = 8,
    ) -> None:
        self._store = object_store
        self._orb = cv2.ORB_create(nfeatures=features)
        self._matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
        self._min_matches = min_matches
        self._min_inliers = min_inliers
        self._min_inlier_ratio = min_inlier_ratio
        self._ransac_px = ransac_px
        self._cache_size = cache_size
        # Reference keys are content-addressed (keys.reference_image_key), so an entry can
        # never go stale: a new reference photo always arrives under a new key.
        self._cache: OrderedDict[str, _Features] = OrderedDict()

    def align(self, image: bytes, viewpoint: Viewpoint) -> list[AlignedOutline]:
        ref = self._reference_features(viewpoint.reference_image_key)
        photo = self._features(image, what="Photo", long_edge=max(ref.width, ref.height))
        h = self._homography(ref, photo, viewpoint)

        sids = list(viewpoint.outlines)
        if not sids:
            return []
        for sid in sids:
            if len(viewpoint.outlines[sid]) < 3:
                raise AlignmentError(f"Outline for {sid} has fewer than 3 points")
        corners = np.array(
            [pt for sid in sids for pt in viewpoint.outlines[sid]], dtype=np.float64
        ).reshape(-1, 1, 2)
        mapped = cv2.perspectiveTransform(corners * (ref.width, ref.height), h).reshape(-1, 2)
        mapped /= (photo.width, photo.height)

        out: list[AlignedOutline] = []
        i = 0
        for sid in sids:
            n = len(viewpoint.outlines[sid])
            polygon = [(float(x), float(y)) for x, y in mapped[i : i + n]]
            i += n
            in_frame = all(-EPS <= x <= 1 + EPS and -EPS <= y <= 1 + EPS for x, y in polygon)
            out.append(AlignedOutline(space_id=sid, polygon=polygon, in_frame=in_frame))
        return out

    def _reference_features(self, key: str | None) -> _Features:
        if key is None:
            raise AlignmentError(NO_REFERENCE)
        cached = self._cache.get(key)
        if cached is not None:
            self._cache.move_to_end(key)
            return cached
        try:
            data = self._store.get(key)
        except KeyError:
            raise AlignmentError(NO_REFERENCE) from None
        feats = self._features(data, what="Reference image")
        self._cache[key] = feats
        while len(self._cache) > self._cache_size:
            self._cache.popitem(last=False)
        return feats

    def _features(self, data: bytes, *, what: str, long_edge: int = WORK_LONG_EDGE) -> _Features:
        try:
            gray = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
            if gray is None:
                raise AlignmentError(f"{what} could not be decoded")
            if max(gray.shape[:2]) > long_edge:
                scale = long_edge / max(gray.shape[:2])
                gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            keypoints, descriptors = self._orb.detectAndCompute(gray, None)
        except cv2.error as exc:  # e.g. an image too small for ORB's border; never retryable
            raise AlignmentError(f"{what} could not be processed") from exc
        points = np.array([kp.pt for kp in keypoints], dtype=np.float32).reshape(-1, 2)
        height, width = gray.shape[:2]
        return _Features(points=points, descriptors=descriptors, width=width, height=height)

    def _homography(self, ref: _Features, photo: _Features, viewpoint: Viewpoint) -> np.ndarray:
        if ref.descriptors is None or photo.descriptors is None:
            raise AlignmentError(TOO_FEW_MATCHES)
        pairs = self._matcher.knnMatch(ref.descriptors, photo.descriptors, k=2)
        good = [p[0] for p in pairs if len(p) == 2 and p[0].distance < LOWE_RATIO * p[1].distance]
        inliers = 0
        h = None
        if len(good) >= self._min_matches:
            ref_pts = ref.points[[m.queryIdx for m in good]].reshape(-1, 1, 2)
            img_pts = photo.points[[m.trainIdx for m in good]].reshape(-1, 1, 2)
            h, mask = cv2.findHomography(ref_pts, img_pts, cv2.RANSAC, self._ransac_px)
            inliers = int(mask.sum()) if mask is not None else 0
        log.debug(
            "Aligned %s/%s: %d good matches, %d inliers",
            viewpoint.lot_id,
            viewpoint.view_id,
            len(good),
            inliers,
        )
        if (
            h is None
            or inliers < self._min_inliers
            or inliers < self._min_inlier_ratio * len(good)
            or not self._plausible(h, ref, photo)
        ):
            raise AlignmentError(TOO_FEW_MATCHES)
        return h

    @staticmethod
    def _plausible(h: np.ndarray, ref: _Features, photo: _Features) -> bool:
        """Reject homographies no small camera shift could produce: non-finite, folding the
        reference frame across the horizon, mirroring it, or collapsing or exploding it.
        Judged in image fractions, so photo resolution does not matter."""
        if not np.all(np.isfinite(h)):
            return False
        to_ref_px = np.diag([ref.width, ref.height, 1.0])
        to_photo_frac = np.diag([1.0 / photo.width, 1.0 / photo.height, 1.0])
        mapped = to_photo_frac @ h @ to_ref_px @ _FRAME
        w = mapped[2]
        if np.all(w < 0):  # H and -H are the same homography
            w, mapped = -w, -mapped
        # w is affine, so positive at all four corners means positive over the whole frame:
        # nothing crosses the horizon and the mapped quad is convex (no fold or "bow tie").
        if not np.all(w > 1e-9):
            return False
        quad = (mapped[:2] / w).T.astype(np.float32).reshape(-1, 1, 2)
        # Signed: the reference frame itself is +1.0, so a mirrored mapping goes negative.
        area = cv2.contourArea(quad, oriented=True)
        return MIN_AREA <= area <= MAX_AREA
