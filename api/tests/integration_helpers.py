"""Shared steps for the cross-feature integration tests (test_integration_*.py).

Not a test module, so pytest does not collect it: each step drives the real admin and
public routes the way the web app does, and the worker runs with the real handler and a
scripted scorer, so the states a test expects never depend on the photo bytes."""

from __future__ import annotations

import copy
import hashlib
from collections.abc import Callable, Mapping
from datetime import datetime
from typing import Any

from fastapi.testclient import TestClient
from httpx import Response
from parking_core.errors import PermanentJobError
from parking_core.models import AlignedOutline, SpaceScore
from parking_core.settings import Adapters, Settings
from parking_worker.aligners import build_aligner
from parking_worker.handler import ProcessResult, process_message
from parking_worker.scorers.fake import FakeScorer

from .test_reference import jpeg

FREE, OCCUPIED, UNKNOWN, CLOSED = "FREE", "OCCUPIED", "UNKNOWN", "CLOSED"

# (acpdsScore, carOverlap) that the default cutoffs turn into each state.
_SCORES = {FREE: (0.1, 0.0), OCCUPIED: (0.9, 1.0), UNKNOWN: (0.5, 0.0)}


def auth(tok: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {tok}"}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --- lots and layouts ---------------------------------------------------------


def create_lot(
    client: TestClient, headers: dict, name: str, location: str = "", stale: int = 30
) -> dict:
    r = client.post(
        "/admin/lots",
        json={"name": name, "location": location, "staleAfterMinutes": stale},
        headers=headers,
    )
    assert r.status_code == 201, r.text
    return r.json()


def get_draft(client: TestClient, headers: dict, lot_id: str) -> dict:
    r = client.get(f"/admin/lots/{lot_id}/layout/draft", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def space(
    space_id: str, i: int, label: str | None = None, type: str = "STANDARD", retired: bool = False
) -> dict:
    """A schematic space in slot `i`: rows of eight, so up to 24 fit the default 1000x600
    schematic without overlapping."""
    return {
        "spaceId": space_id,
        "label": label if label is not None else space_id,
        "type": type,
        "rect": {"x": 10 + 120 * (i % 8), "y": 10 + 200 * (i // 8), "w": 100, "h": 180},
        "retired": retired,
    }


def quad(i: int) -> list[list[float]]:
    """A valid outline in slot `i` of the reference photo."""
    x = 0.1 * i
    return [[x, 0.1], [x + 0.05, 0.1], [x + 0.05, 0.2], [x, 0.2]]


def as_put_body(draft: dict) -> dict:
    """A GET response turned into a PUT body (what useDraftLayout sends)."""
    body = copy.deepcopy(draft)
    for key in ("lotId", "updatedAt", "updatedBy", "basedOnVersion"):
        body.pop(key, None)
    for v in body["viewpoints"]:
        v.pop("referenceImage", None)
    return body


def save_draft(
    client: TestClient, headers: dict, lot_id: str, *, spaces: list[dict], viewpoints: list[dict]
) -> dict:
    """Replace the draft's spaces and viewpoints, keeping its revision and schematic."""
    current = get_draft(client, headers, lot_id)
    body = {
        "revision": current["revision"],
        "schematic": current["schematic"],
        "spaces": spaces,
        "viewpoints": viewpoints,
    }
    r = client.put(f"/admin/lots/{lot_id}/layout/draft", json=body, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def edit_draft(
    client: TestClient, headers: dict, lot_id: str, change: Callable[[dict], None]
) -> dict:
    """Load the draft, apply `change` to the PUT body, save it."""
    body = as_put_body(get_draft(client, headers, lot_id))
    change(body)
    r = client.put(f"/admin/lots/{lot_id}/layout/draft", json=body, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def upload_reference(
    client: TestClient,
    headers: dict,
    lot_id: str,
    view_id: str,
    data: bytes,
    width: int = 640,
    height: int = 360,
) -> dict:
    """Upload a reference photo: a JPEG header of `width` x `height` (complete reads the size
    from the stored file), with `data` after it so each call's bytes and hash differ."""
    data = jpeg(width, height) + data
    base = f"/admin/lots/{lot_id}/views/{view_id}/reference"
    digest = sha(data)
    slot = client.post(
        base,
        json={"contentType": "image/jpeg", "sizeBytes": len(data), "sha256": digest},
        headers=headers,
    )
    assert slot.status_code == 201, slot.text
    url = slot.json()["uploadUrl"].removeprefix("/api")
    assert client.put(url, content=data, headers={"content-type": "image/jpeg"}).status_code == 204
    r = client.post(
        f"{base}/complete",
        json={"sha256": digest},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


def publish(client: TestClient, headers: dict, lot_id: str) -> Response:
    revision = get_draft(client, headers, lot_id)["revision"]
    return client.post(
        f"/admin/lots/{lot_id}/layout/publish", json={"revision": revision}, headers=headers
    )


def publish_ok(client: TestClient, headers: dict, lot_id: str) -> dict:
    r = publish(client, headers, lot_id)
    assert r.status_code == 201, r.text
    return r.json()


# --- photos and the worker ----------------------------------------------------


def request_slot(
    client: TestClient,
    headers: dict,
    lot_id: str,
    view_id: str,
    data: bytes,
    captured: datetime,
) -> Response:
    return client.post(
        "/admin/uploads",
        json={
            "lotId": lot_id,
            "viewId": view_id,
            "captureTime": captured.isoformat(),
            "sha256": sha(data),
            "contentType": "image/jpeg",
            "sizeBytes": len(data),
        },
        headers=headers,
    )


def put_photo(client: TestClient, slot: Response, data: bytes) -> str:
    """PUT the bytes to a slot's presigned URL; returns the image id."""
    assert slot.status_code == 201, slot.text
    url = slot.json()["uploadUrl"].removeprefix("/api")
    assert client.put(url, content=data, headers={"content-type": "image/jpeg"}).status_code == 204
    return slot.json()["imageId"]


def upload_photo(
    client: TestClient,
    headers: dict,
    lot_id: str,
    view_id: str,
    data: bytes,
    captured: datetime,
) -> str:
    """Slot, PUT, complete: the photo is QUEUED. Returns its image id."""
    image_id = put_photo(
        client, request_slot(client, headers, lot_id, view_id, data, captured), data
    )
    r = client.post(f"/admin/uploads/{image_id}/complete", headers=headers)
    assert r.status_code == 200, r.text
    return image_id


def scripted_scorer(states: Mapping[str, str], default: str = FREE) -> FakeScorer:
    """Scores each outlined space so the state rule yields `states[space_id]` (else default)."""

    def score(o: AlignedOutline) -> SpaceScore:
        acpds, overlap = _SCORES[states.get(o.space_id, default)]
        return SpaceScore(space_id=o.space_id, acpds_score=acpds, car_overlap=overlap)

    return FakeScorer(score)


def failing_scorer(message: str = "Too few matches") -> FakeScorer:
    """Fails the job permanently, as a photo that does not match its viewpoint does."""
    return FakeScorer(raise_exc=PermanentJobError(message))


def run_worker(
    adapters: Adapters, settings: Settings, scorer: FakeScorer, now: Callable[[], datetime]
) -> ProcessResult:
    """Process the next queued job with the real worker handler."""
    messages = adapters.queue.receive(max_messages=1, wait_seconds=0)
    assert messages, "no queued job"
    return process_message(
        messages[0],
        adapters,
        build_aligner(settings, adapters),
        scorer,
        settings.cutoffs,
        now=now,
    )


def snapshot(client: TestClient, headers: dict, image_id: str) -> dict:
    r = client.get(f"/admin/snapshots/{image_id}", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def retry(client: TestClient, headers: dict, image_id: str) -> dict:
    r = client.post(f"/admin/snapshots/{image_id}/retry", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


# --- the driver side ----------------------------------------------------------


def status(client: TestClient, lot_id: str) -> dict:
    r = client.get(f"/lots/{lot_id}/status")
    assert r.status_code == 200, r.text
    return r.json()


def states(client: TestClient, lot_id: str) -> dict[str, tuple[str, str | None]]:
    """spaceId -> (state, observedAt) as drivers see it."""
    return {s["spaceId"]: (s["state"], s["observedAt"]) for s in status(client, lot_id)["spaces"]}


def driver_lots(client: TestClient) -> dict[str, dict]:
    r = client.get("/lots")
    assert r.status_code == 200, r.text
    return {lot["lotId"]: lot for lot in r.json()}


def close(
    client: TestClient,
    headers: dict,
    lot_id: str,
    space_ids: list[str],
    starts: datetime,
    ends: datetime | None = None,
) -> Response:
    return client.post(
        f"/admin/lots/{lot_id}/closures",
        json={
            "spaceIds": space_ids,
            "reason": "EVENT",
            "startsAt": starts.isoformat(),
            "endsAt": ends.isoformat() if ends else None,
        },
        headers=headers,
    )


def at(value: str | None) -> datetime | None:
    """An API timestamp parsed back, so tests compare instants rather than spellings."""
    return datetime.fromisoformat(value) if value is not None else None


# --- whole-state comparison ---------------------------------------------------


def fingerprint(adapters: Adapters) -> dict[str, Any]:
    """Everything an admin write could change, through public Repository reads only."""
    repo = adapters.repository

    def dump(items: Any) -> Any:
        if items is None:
            return None
        if isinstance(items, list):
            return [i.model_dump(mode="json") for i in items]
        return items.model_dump(mode="json")

    lots = sorted(repo.list_lots(), key=lambda lot: lot.lot_id)
    out: dict[str, Any] = {"lots": dump(lots), "queue": len(adapters.queue)}  # type: ignore[arg-type]
    for lot in lots:
        lid = lot.lot_id
        out[lid] = {
            "spaces": dump(repo.list_spaces(lid)),
            "viewpoints": dump(repo.list_viewpoints(lid)),
            "draft": dump(repo.get_draft_meta(lid)),
            "versions": dump(repo.list_layout_versions(lid)),
            "closures": dump(repo.list_closures(lid)),
            "snapshots": dump(repo.list_snapshots(lid, limit=200)),
            "statuses": dump(repo.get_statuses(lid)),
        }
    return out
