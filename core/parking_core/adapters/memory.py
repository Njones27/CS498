"""In-memory adapters for tests and APP_ENV=test.

Same conditional semantics as the AWS adapters: `claim_hash` conflicts, `takeover_hash`,
`transition_job` from-state checks, `update_status_if_newer`, and a queue that tracks
`receive_count` and visibility. One lock guards every mutation so the API threadpool is safe.
"""

from __future__ import annotations

import threading
import time
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import quote

from ..auth import HS256Verifier
from ..errors import NotPublishedError
from ..keys import layout_snapshot_key
from ..models import (
    CarBox,
    ClaimResult,
    Closure,
    DraftMeta,
    JobStatus,
    LayoutVersion,
    Lot,
    Message,
    ObjectInfo,
    ParkingSpace,
    PublishedLayout,
    Snapshot,
    SpaceObservation,
    SpaceStatus,
    Viewpoint,
    utcnow,
)
from ..settings import Adapters, Settings

TEST_UPLOAD_PREFIX = "/api/_test/uploads/"
TEST_OBJECT_PREFIX = "/api/_test/objects/"


def image_id_from_raw_key(key: str) -> str:
    """`raw/{lotId}/{viewId}/{imageId}.ext` -> imageId."""
    parts = key.split("/")
    if len(parts) != 4 or parts[0] != "raw" or not parts[3]:
        raise ValueError(f"not a raw photo key: {key}")
    return parts[3].rsplit(".", 1)[0]


class MemoryObjectStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._objects: dict[str, tuple[bytes, str]] = {}
        self._pending: dict[str, str] = {}  # imageId -> key registered at presign time

    def put(self, key: str, data: bytes, content_type: str) -> None:
        with self._lock:
            self._objects[key] = (bytes(data), content_type)

    def get(self, key: str) -> bytes:
        with self._lock:
            if key not in self._objects:
                raise KeyError(key)
            return self._objects[key][0]

    def content_type(self, key: str) -> str:
        with self._lock:
            return self._objects[key][1]

    def exists(self, key: str) -> bool:
        with self._lock:
            return key in self._objects

    def head(self, key: str) -> ObjectInfo | None:
        with self._lock:
            if key not in self._objects:
                return None
            data, content_type = self._objects[key]
            return ObjectInfo(size_bytes=len(data), content_type=content_type)

    def presign_put(self, key: str, content_type: str, expires_seconds: int = 300) -> str:
        try:
            image_id = image_id_from_raw_key(key)
        except ValueError:
            image_id = uuid.uuid4().hex
        with self._lock:
            self._pending[image_id] = key
        return f"{TEST_UPLOAD_PREFIX}{image_id}"

    def presign_get(self, key: str, expires_seconds: int = 300) -> str:
        """Served by the test-only route GET /_test/objects/{key} (APP_ENV=test)."""
        return f"{TEST_OBJECT_PREFIX}{quote(key, safe='/')}"

    def put_for_image(self, image_id: str, data: bytes, content_type: str) -> bool:
        """Store bytes under the key registered by `presign_put`. False if none was."""
        with self._lock:
            key = self._pending.get(image_id)
            if key is None:
                return False
            self._objects[key] = (bytes(data), content_type)
            return True


@dataclass
class _QueuedMessage:
    body: str
    message_id: str
    receive_count: int = 0
    invisible_until: float = 0.0
    receipt: str | None = None


class MemoryJobQueue:
    def __init__(
        self, visibility_timeout: float = 30.0, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self.visibility_timeout = visibility_timeout
        self._clock = clock
        self._lock = threading.Lock()
        self._messages: list[_QueuedMessage] = []
        self._offset = 0.0

    def _now(self) -> float:
        return self._clock() + self._offset

    def send(self, body: str) -> None:
        with self._lock:
            self._messages.append(_QueuedMessage(body=body, message_id=uuid.uuid4().hex))

    def receive(self, max_messages: int = 1, wait_seconds: int = 10) -> list[Message]:
        """Never blocks (tests drive the queue synchronously); `wait_seconds` is ignored."""
        out: list[Message] = []
        with self._lock:
            now = self._now()
            for m in self._messages:
                if len(out) >= max_messages:
                    break
                if m.invisible_until > now:
                    continue
                m.receive_count += 1
                m.invisible_until = now + self.visibility_timeout
                m.receipt = f"{m.message_id}:{m.receive_count}"
                out.append(Message(body=m.body, receipt=m.receipt, receive_count=m.receive_count))
        return out

    def delete(self, receipt: str) -> None:
        with self._lock:
            self._messages = [m for m in self._messages if m.receipt != receipt]

    # --- test helpers ---------------------------------------------------------
    def advance(self, seconds: float) -> None:
        """Move the queue's clock forward (visibility timeouts expire)."""
        with self._lock:
            self._offset += seconds

    def requeue_inflight(self) -> None:
        """Make every in-flight message visible again, as if its visibility timed out."""
        with self._lock:
            for m in self._messages:
                m.invisible_until = 0.0

    def __len__(self) -> int:
        with self._lock:
            return len(self._messages)


class MemoryRepository:
    def __init__(self, object_store: MemoryObjectStore | None = None) -> None:
        self._store = object_store
        self._lock = threading.RLock()
        self._lots: dict[str, Lot] = {}
        self._spaces: dict[tuple[str, str], ParkingSpace] = {}
        self._viewpoints: dict[tuple[str, str], Viewpoint] = {}
        self._layouts: dict[tuple[str, int], LayoutVersion] = {}
        self._snapshots: dict[str, Snapshot] = {}
        self._hashes: dict[str, tuple[str, datetime]] = {}  # sha256 -> (imageId, claimedAt)
        self._observations: dict[tuple[str, str], SpaceObservation] = {}
        self._detections: dict[str, list[CarBox]] = {}
        self._statuses: dict[tuple[str, str], SpaceStatus] = {}
        self._closures: dict[tuple[str, str], Closure] = {}
        self._drafts: dict[str, DraftMeta] = {}

    # Lots and layouts
    def put_lot(self, lot: Lot) -> None:
        with self._lock:
            self._lots[lot.lot_id] = lot.model_copy(deep=True)

    def get_lot(self, lot_id: str) -> Lot | None:
        with self._lock:
            lot = self._lots.get(lot_id)
            return lot.model_copy(deep=True) if lot else None

    def list_lots(self) -> list[Lot]:
        with self._lock:
            return [lot.model_copy(deep=True) for lot in self._lots.values()]

    def put_spaces(self, spaces: Iterable[ParkingSpace]) -> None:
        with self._lock:
            for s in spaces:
                self._spaces[(s.lot_id, s.space_id)] = s.model_copy(deep=True)

    def list_spaces(self, lot_id: str) -> list[ParkingSpace]:
        with self._lock:
            return [
                s.model_copy(deep=True) for (lid, _), s in self._spaces.items() if lid == lot_id
            ]

    def put_viewpoint(self, viewpoint: Viewpoint) -> None:
        with self._lock:
            key = (viewpoint.lot_id, viewpoint.view_id)
            self._viewpoints[key] = viewpoint.model_copy(deep=True)

    def update_viewpoint(self, lot_id: str, view_id: str, /, **fields: object) -> bool:
        unknown = set(fields) - (set(Viewpoint.model_fields) - {"lot_id", "view_id"})
        if not fields or unknown:
            raise ValueError(f"not updatable viewpoint fields: {sorted(unknown) or 'none given'}")
        with self._lock:
            current = self._viewpoints.get((lot_id, view_id))
            if current is None:
                return False
            data = current.model_dump(by_alias=False)
            data.update(fields)
            self._viewpoints[(lot_id, view_id)] = Viewpoint.model_validate(data)
            return True

    def get_viewpoint(self, lot_id: str, view_id: str) -> Viewpoint | None:
        with self._lock:
            v = self._viewpoints.get((lot_id, view_id))
            return v.model_copy(deep=True) if v else None

    def list_viewpoints(self, lot_id: str) -> list[Viewpoint]:
        with self._lock:
            return [
                v.model_copy(deep=True) for (lid, _), v in self._viewpoints.items() if lid == lot_id
            ]

    def put_layout_version(self, layout: LayoutVersion) -> None:
        with self._lock:
            self._layouts[(layout.lot_id, layout.version)] = layout.model_copy(deep=True)

    def list_layout_versions(self, lot_id: str) -> list[LayoutVersion]:
        with self._lock:
            items = [v for (lid, _), v in self._layouts.items() if lid == lot_id]
            return [v.model_copy(deep=True) for v in sorted(items, key=lambda v: v.version)]

    def publish_layout(self, lot_id: str, layout: LayoutVersion) -> None:
        with self._lock:
            lot = self._lots.get(lot_id)
            if lot is None:
                raise LookupError(f"Cannot publish a layout for unknown lot {lot_id!r}")
            self._layouts[(lot_id, layout.version)] = layout.model_copy(deep=True)
            self._lots[lot_id] = lot.model_copy(update={"current_layout_version": layout.version})

    def get_published_layout(self, lot_id: str) -> PublishedLayout | None:
        """None when the lot is unknown or unpublished; NotPublishedError if the snapshot
        object the lot points at is missing."""
        lot = self.get_lot(lot_id)
        if lot is None or lot.current_layout_version is None:
            return None
        key = layout_snapshot_key(lot_id, lot.current_layout_version)
        if self._store is None or not self._store.exists(key):
            raise NotPublishedError(f"layout snapshot missing: {key}")
        return PublishedLayout.model_validate_json(self._store.get(key))

    # Snapshots and jobs
    def put_snapshot(self, snapshot: Snapshot) -> None:
        with self._lock:
            self._snapshots[snapshot.image_id] = snapshot.model_copy(deep=True)

    def get_snapshot(self, image_id: str) -> Snapshot | None:
        with self._lock:
            s = self._snapshots.get(image_id)
            return s.model_copy(deep=True) if s else None

    def list_snapshots(self, lot_id: str, limit: int = 50) -> list[Snapshot]:
        with self._lock:
            items = [s for s in self._snapshots.values() if s.lot_id == lot_id]
            items.sort(key=lambda s: s.capture_time, reverse=True)
            return [s.model_copy(deep=True) for s in items[:limit]]

    def get_latest_snapshot(self, lot_id: str) -> Snapshot | None:
        items = self.list_snapshots(lot_id, limit=1)
        return items[0] if items else None

    def transition_job(
        self,
        image_id: str,
        from_states: set[JobStatus],
        to_state: JobStatus,
        **fields: object,
    ) -> bool:
        unknown = set(fields) - set(Snapshot.model_fields)
        if unknown:
            raise ValueError(f"unknown snapshot fields: {sorted(unknown)}")
        with self._lock:
            snap = self._snapshots.get(image_id)
            if snap is None or snap.job_status not in from_states:
                return False
            data = snap.model_dump(by_alias=False)
            data.update(fields)
            data["job_status"] = to_state
            self._snapshots[image_id] = Snapshot.model_validate(data)
            return True

    # Duplicate detection
    def claim_hash(
        self, sha256: str, image_id: str, claimed_at: datetime | None = None
    ) -> ClaimResult:
        with self._lock:
            existing = self._hashes.get(sha256)
            if existing is not None:
                original_id, original_at = existing
                return ClaimResult(
                    claimed=False, original_image_id=original_id, claimed_at=original_at
                )
            self._hashes[sha256] = (image_id, claimed_at or utcnow())
            return ClaimResult(claimed=True)

    def takeover_hash(
        self,
        sha256: str,
        old_image_id: str,
        new_image_id: str,
        claimed_at: datetime | None = None,
    ) -> bool:
        with self._lock:
            existing = self._hashes.get(sha256)
            if existing is None or existing[0] != old_image_id:
                return False
            self._hashes[sha256] = (new_image_id, claimed_at or utcnow())
            return True

    def release_hash(self, sha256: str, image_id: str) -> bool:
        with self._lock:
            existing = self._hashes.get(sha256)
            if existing is None or existing[0] != image_id:
                return False
            del self._hashes[sha256]
            return True

    # Observations and status
    def put_observations(self, observations: Iterable[SpaceObservation]) -> None:
        with self._lock:
            for o in observations:
                self._observations[(o.image_id, o.space_id)] = o.model_copy(deep=True)

    def list_observations(self, image_id: str) -> list[SpaceObservation]:
        with self._lock:
            return [
                o.model_copy(deep=True)
                for (iid, _), o in sorted(self._observations.items())
                if iid == image_id
            ]

    def put_detections(self, image_id: str, detections: list[CarBox]) -> None:
        with self._lock:
            self._detections[image_id] = [d.model_copy(deep=True) for d in detections]

    def get_detections(self, image_id: str) -> list[CarBox]:
        with self._lock:
            return [d.model_copy(deep=True) for d in self._detections.get(image_id, [])]

    def update_status_if_newer(self, status: SpaceStatus) -> bool:
        key = (status.lot_id, status.space_id)
        with self._lock:
            current = self._statuses.get(key)
            if current is not None and not current.observed_at < status.observed_at:
                return False
            self._statuses[key] = status.model_copy(deep=True)
            return True

    def get_statuses(self, lot_id: str) -> list[SpaceStatus]:
        with self._lock:
            return [
                s.model_copy(deep=True) for (lid, _), s in self._statuses.items() if lid == lot_id
            ]

    # Closures
    def put_closure(self, closure: Closure) -> None:
        with self._lock:
            self._closures[(closure.lot_id, closure.closure_id)] = closure.model_copy(deep=True)

    def list_closures(self, lot_id: str) -> list[Closure]:
        with self._lock:
            return [
                c.model_copy(deep=True) for (lid, _), c in self._closures.items() if lid == lot_id
            ]

    # Draft layout
    def get_draft_meta(self, lot_id: str) -> DraftMeta | None:
        with self._lock:
            meta = self._drafts.get(lot_id)
            return meta.model_copy(deep=True) if meta else None

    def put_draft_meta(self, meta: DraftMeta, expected_revision: int | None) -> bool:
        with self._lock:
            current = self._drafts.get(meta.lot_id)
            stored = None if current is None else current.revision
            if stored != expected_revision:
                return False
            self._drafts[meta.lot_id] = meta.model_copy(deep=True)
            return True

    def delete_space(self, lot_id: str, space_id: str) -> None:
        with self._lock:
            self._spaces.pop((lot_id, space_id), None)


def build_memory_adapters(settings: Settings) -> Adapters:
    store = MemoryObjectStore()
    return Adapters(
        object_store=store,
        queue=MemoryJobQueue(),
        repository=MemoryRepository(store),
        auth_verifier=HS256Verifier(settings.jwt_secret),
    )
