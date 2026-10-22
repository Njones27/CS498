"""Single-table DynamoDB key design (HDD §5.2). Also used by the memory adapter."""

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


def status_sk(space_id: str) -> str:
    return f"STATUS#{space_id}"


def layout_sk(version: int) -> str:
    return f"LAYOUT#{version:06d}"


def closure_sk(closure_id: str) -> str:
    return f"CLOSURE#{closure_id}"


def image_pk(image_id: str) -> str:
    return f"IMG#{image_id}"


def obs_sk(space_id: str) -> str:
    return f"OBS#{space_id}"


def hash_pk(sha256: str) -> str:
    return f"HASH#{sha256}"


def raw_photo_key(lot_id: str, view_id: str, image_id: str, ext: str = "jpg") -> str:
    return f"raw/{lot_id}/{view_id}/{image_id}.{ext}"


def reference_image_key(lot_id: str, view_id: str) -> str:
    return f"reference/{lot_id}/{view_id}.jpg"


def layout_snapshot_key(lot_id: str, version: int) -> str:
    return f"layouts/{lot_id}/v{version}.json"
