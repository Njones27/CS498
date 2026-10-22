"""The small interfaces that make local and cloud interchangeable (HDD §3.2).

Every implementation lives in `parking_core.adapters`. Application code (API, worker,
seed) depends only on these Protocols and gets concrete objects from
`parking_core.settings.build_adapters`.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime
from typing import Protocol

from .models import (
    AlignedOutline,
    ClaimResult,
    Closure,
    JobStatus,
    LayoutVersion,
    Lot,
    Message,
    ObjectInfo,
    ParkingSpace,
    Principal,
    PublishedLayout,
    Snapshot,
    SpaceObservation,
    SpaceScore,
    SpaceStatus,
    Viewpoint,
)


class ObjectStore(Protocol):
    def put(self, key: str, data: bytes, content_type: str) -> None: ...
    def get(self, key: str) -> bytes: ...
    def exists(self, key: str) -> bool: ...
    def head(self, key: str) -> ObjectInfo | None:
        """Size and content type of the stored object; None if it does not exist."""
        ...

    def presign_put(self, key: str, content_type: str, expires_seconds: int = 300) -> str:
        """URL the *browser* can PUT to. Signed with the public endpoint when configured."""
        ...

    def presign_get(self, key: str, expires_seconds: int = 300) -> str: ...


class JobQueue(Protocol):
    def send(self, body: str) -> None: ...
    def receive(self, max_messages: int = 1, wait_seconds: int = 10) -> list[Message]: ...
    def delete(self, receipt: str) -> None: ...


class Repository(Protocol):
    # Lots and layouts
    def put_lot(self, lot: Lot) -> None: ...
    def get_lot(self, lot_id: str) -> Lot | None: ...
    def list_lots(self) -> list[Lot]:
        """All lots (published or not). DynamoDB: Query GSI1 with PK = keys.LOTS_INDEX_PK."""
        ...

    def put_spaces(self, spaces: Iterable[ParkingSpace]) -> None: ...
    def list_spaces(self, lot_id: str) -> list[ParkingSpace]: ...
    def put_viewpoint(self, viewpoint: Viewpoint) -> None: ...
    def get_viewpoint(self, lot_id: str, view_id: str) -> Viewpoint | None: ...
    def list_viewpoints(self, lot_id: str) -> list[Viewpoint]: ...
    def put_layout_version(self, layout: LayoutVersion) -> None: ...
    def list_layout_versions(self, lot_id: str) -> list[LayoutVersion]: ...
    def publish_layout(self, lot_id: str, layout: LayoutVersion) -> None:
        """Write the LayoutVersion item and move currentLayoutVersion in one transaction.
        Raises LookupError if the lot does not exist."""
        ...

    def get_published_layout(self, lot_id: str) -> PublishedLayout | None:
        """The lot's current layout snapshot from the object store; None if unpublished."""
        ...

    # Snapshots and jobs
    def put_snapshot(self, snapshot: Snapshot) -> None: ...
    def get_snapshot(self, image_id: str) -> Snapshot | None: ...
    def list_snapshots(self, lot_id: str, limit: int = 50) -> list[Snapshot]:
        """Newest capture time first (GSI1)."""
        ...

    def get_latest_snapshot(self, lot_id: str) -> Snapshot | None: ...
    def transition_job(
        self,
        image_id: str,
        from_states: set[JobStatus],
        to_state: JobStatus,
        **fields: object,
    ) -> bool:
        """Conditional update: succeeds only if the job is currently in `from_states`.
        Extra fields (error, attempts, finished, model_version, ...) are written with it."""
        ...

    # Duplicate detection (HDD §4.3)
    def claim_hash(
        self, sha256: str, image_id: str, claimed_at: datetime | None = None
    ) -> ClaimResult:
        """Conditional put on HASH#sha256 (stamped with `claimed_at`, default now).
        On conflict returns the original image id and when it was claimed."""
        ...

    def takeover_hash(
        self,
        sha256: str,
        old_image_id: str,
        new_image_id: str,
        claimed_at: datetime | None = None,
    ) -> bool:
        """Re-point an existing claim; succeeds only if it still points at `old_image_id`."""
        ...

    def release_hash(self, sha256: str, image_id: str) -> bool:
        """Delete the claim; succeeds only if it still points at `image_id`."""
        ...

    # Observations and status
    def put_observations(self, observations: Iterable[SpaceObservation]) -> None: ...
    def list_observations(self, image_id: str) -> list[SpaceObservation]: ...
    def update_status_if_newer(self, status: SpaceStatus) -> bool:
        """Conditional write: only when the stored observedAt is older (HDD §4.1 step 7)."""
        ...

    def get_statuses(self, lot_id: str) -> list[SpaceStatus]: ...

    # Closures (read side used by status; CRUD arrives in wave 2)
    def put_closure(self, closure: Closure) -> None: ...
    def list_closures(self, lot_id: str) -> list[Closure]: ...


class AuthVerifier(Protocol):
    def verify(self, token: str) -> Principal | None:
        """None for a malformed/invalid token; Principal(expired=True) for an expired one."""
        ...


class Aligner(Protocol):
    def align(self, image: bytes, viewpoint: Viewpoint) -> list[AlignedOutline]:
        """Map the viewpoint's outlines onto this photo. Raises AlignmentError on mismatch."""
        ...


class SpaceScorer(Protocol):
    model_version: str

    def score(self, image: bytes, outlines: list[AlignedOutline]) -> list[SpaceScore]: ...


class LayoutProposer(Protocol):
    """Proposes stall outlines from one photo (HDD §4.6). Implemented in wave 3."""

    def propose(self, image: bytes) -> list[AlignedOutline]: ...
