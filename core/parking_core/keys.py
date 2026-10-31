"""Single-table DynamoDB key design (HDD §5.2). Also used by the memory adapter."""

from datetime import UTC, datetime

PK = "PK"
SK = "SK"
GSI1 = "GSI1"
GSI1PK = "GSI1PK"
GSI1SK = "GSI1SK"
META = "META"


def lot_pk(lot_id: str) -> str:
    return f"LOT#{lot_id}"


def space_sk(space_id: str) -> str:
    return f"SPACE#{space_id}"


def view_sk(view_id: str) -> str:
    return f"VIEW#{view_id}"


def status_sk(space_id: str, view_id: str | None = None) -> str:
    """One reading per space and viewpoint: views never overwrite each other's readings, and
    the API fuses them (`fusion.fuse`). Readings stored before that have no view part."""
    return f"STATUS#{space_id}" if view_id is None else f"STATUS#{space_id}#{view_id}"


def layout_sk(version: int) -> str:
    return f"LAYOUT#{version:06d}"


def closure_sk(closure_id: str) -> str:
    return f"CLOSURE#{closure_id}"


def override_sk(override_id: str) -> str:
    """An admin's override of some spaces' state (`StateOverride`)."""
    return f"OVERRIDE#{override_id}"


def draft_sk() -> str:
    """The one LOT#{lotId} item holding the draft layout's header (`DraftMeta`)."""
    return "DRAFT"


def proposal_sk(view_id: str) -> str:
    """The one LOT#{lotId} item per viewpoint holding its latest layout proposer run."""
    return f"PROPOSAL#{view_id}"


def gsi1_snapshot(lot_id: str, capture_time: datetime, image_id: str) -> tuple[str, str]:
    """GSI1 keys for an IMG#/META item so snapshots list newest capture first per lot.

    The sort key is a fixed-width UTC ISO timestamp with the image id as tie-break, so two
    photos captured in the same second never collide.
    """
    utc = capture_time.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")
    return lot_pk(lot_id), f"{utc}#{image_id}"


LOTS_INDEX_PK = "LOTS"
"""GSI1 partition key shared by every LOT#/META item, so `list_lots` is a Query, not a Scan.
GSI1SK is the lot id."""


def gsi1_lot(lot_id: str) -> tuple[str, str]:
    return LOTS_INDEX_PK, lot_id


def image_pk(image_id: str) -> str:
    return f"IMG#{image_id}"


def obs_sk(space_id: str) -> str:
    return f"OBS#{space_id}"


def detections_sk() -> str:
    """The one IMG#{imageId} item holding every detection on that photo (admin overlay). Kept
    out of the snapshot's META item so status and snapshot listings never read it."""
    return "DET#"


def hash_pk(sha256: str) -> str:
    return f"HASH#{sha256}"


def raw_photo_key(lot_id: str, view_id: str, image_id: str, ext: str = "jpg") -> str:
    return f"raw/{lot_id}/{view_id}/{image_id}.{ext}"


def reference_image_key(lot_id: str, view_id: str, sha256: str) -> str:
    """Content-addressed: the key embeds the first 12 hex chars of the image's SHA-256.

    A re-uploaded reference photo gets a new key, so it never changes what an already
    published layout points at (each `PublishedLayout` snapshot stores its viewpoints'
    `reference_image_key`), and the worker's aligner can cache features by key without
    them ever going stale.

    No file extension: `complete` rebuilds this key from the hash alone, and the object's
    real type (JPEG or PNG) is the Content-Type pinned by the presigned PUT. Keys published
    earlier end in `.jpg` and stay valid, since layouts store the full key.
    """
    return f"reference/{lot_id}/{view_id}/{sha256[:12]}"


def layout_snapshot_key(lot_id: str, version: int) -> str:
    return f"layouts/{lot_id}/v{version}.json"
