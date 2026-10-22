"""End-to-end test against the running Compose stack (HDD §11 "Integration").

Run after `docker compose up` and the seed script, with the host env loaded:

    set -a; . ./.env.ci-host; set +a
    RUN_COMPOSE_TESTS=1 uv run pytest -m compose tests/compose

It drives the real API: sign in, request an upload slot for a fixture photo, PUT the bytes to the
presigned MinIO URL, complete the upload, wait for the worker, and check the public status.
"""

from __future__ import annotations

import hashlib
import os
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest

pytestmark = pytest.mark.compose

API = os.environ.get("API_BASE_URL", "http://localhost:8000")
FIXTURES = Path(__file__).resolve().parents[2] / "eval" / "fixtures"


def _skip_unless_enabled() -> None:
    if os.environ.get("RUN_COMPOSE_TESTS") != "1":
        pytest.skip("set RUN_COMPOSE_TESTS=1 with the compose stack running")


def _fixture_photo() -> Path:
    photos = sorted(p for p in FIXTURES.glob("*.jpg") if p.is_file())
    if not photos:
        pytest.fail(f"no .jpg fixture in {FIXTURES}")
    return photos[0]


def _login(client: httpx.Client) -> dict[str, str]:
    r = client.post(
        f"{API}/auth/login",
        json={
            "email": os.environ.get("DEV_ADMIN_EMAIL", "admin@example.edu"),
            "password": os.environ.get("DEV_ADMIN_PASSWORD", "admin-password"),
        },
    )
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def _wait_for(client: httpx.Client, headers: dict[str, str], image_id: str) -> dict:
    deadline = time.time() + 120
    last: dict = {}
    while time.time() < deadline:
        r = client.get(f"{API}/admin/snapshots/{image_id}", headers=headers)
        assert r.status_code == 200, r.text
        last = r.json()
        if last["finished"]:
            return last
        time.sleep(2)
    pytest.fail(f"job did not finish within 120 s: {last}")


def _dt(value: str) -> datetime:
    """The API emits `...Z`; Python's isoformat emits `+00:00`. Compare as datetimes."""
    return datetime.fromisoformat(value)


def _slot_body(lot_id: str, view_id: str, capture_time: datetime, sha: str, size: int) -> dict:
    return {
        "lotId": lot_id,
        "viewId": view_id,
        "captureTime": capture_time.isoformat(),
        "sha256": sha,
        "contentType": "image/jpeg",
        "sizeBytes": size,
    }


def test_upload_to_status() -> None:
    _skip_unless_enabled()
    # Unique bytes per run so a re-run is not rejected as a duplicate (US-05).
    data = _fixture_photo().read_bytes() + b"\n" + str(time.time_ns()).encode()
    sha = hashlib.sha256(data).hexdigest()
    capture_time = (datetime.now(UTC) - timedelta(minutes=1)).replace(microsecond=0)

    with httpx.Client(timeout=30) as client:
        assert client.get(f"{API}/health").json() == {"status": "ok"}
        lots_r = client.get(f"{API}/lots")
        assert lots_r.status_code == 200, lots_r.text
        lots = lots_r.json()
        assert lots, "seed script must publish at least one lot"
        lot_id = lots[0]["lotId"]
        detail_r = client.get(f"{API}/lots/{lot_id}")
        assert detail_r.status_code == 200, detail_r.text
        detail = detail_r.json()
        view_id = detail["viewpoints"][0]["viewId"]
        headers = _login(client)

        body = _slot_body(lot_id, view_id, capture_time, sha, len(data))
        slot = client.post(f"{API}/admin/uploads", headers=headers, json=body)
        assert slot.status_code == 201, slot.text
        image_id = slot.json()["imageId"]
        upload_url = slot.json()["uploadUrl"]
        assert upload_url.startswith("http://localhost:9000/"), upload_url  # public endpoint

        put = client.put(upload_url, content=data, headers={"Content-Type": "image/jpeg"})
        assert put.status_code in (200, 204), put.text

        done = client.post(f"{API}/admin/uploads/{image_id}/complete", headers=headers)
        assert done.status_code == 200, done.text
        assert done.json()["jobStatus"] == "QUEUED"

        snap = _wait_for(client, headers, image_id)
        assert snap["jobStatus"] == "COMPLETE", snap
        assert snap["modelVersion"], snap
        assert snap["layoutVersion"] == detail["layout"]["version"]

        status_r = client.get(f"{API}/lots/{lot_id}/status")
        assert status_r.status_code == 200, status_r.text
        status = status_r.json()
        assert status["noObservations"] is False
        updated = [
            s for s in status["spaces"] if s["observedAt"] and _dt(s["observedAt"]) == capture_time
        ]
        assert updated, "no space carries this photo's capture time"
        # The stub scorer never lands in the UNKNOWN band, so every scored space is decided.
        assert all(s["state"] in ("FREE", "OCCUPIED", "CLOSED") for s in updated), updated
        assert _dt(status["lastObservedAt"]) == capture_time

        # Same bytes again are a duplicate (US-05).
        dup = client.post(f"{API}/admin/uploads", headers=headers, json=body)
        assert dup.status_code == 409, dup.text
        assert dup.json()["error"] == "duplicate"
        assert dup.json()["originalImageId"] == image_id
