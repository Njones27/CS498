"""Tests for admin reference photo endpoints (US-08) and local photo serving."""

from __future__ import annotations

import hashlib
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from parking_api.main import create_app
from parking_core import keys
from parking_core.settings import Settings

from .conftest import NOW, token

SAMPLE_BYTES = b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"\x00" * 100
SAMPLE_HASH = hashlib.sha256(SAMPLE_BYTES).hexdigest()

SAMPLE_BYTES_2 = b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"\x01" * 100
SAMPLE_HASH_2 = hashlib.sha256(SAMPLE_BYTES_2).hexdigest()

REFERENCE_ROUTES = [
    (
        "post",
        "/admin/lots/test-lot/views/V1/reference",
        {"json": {"contentType": "image/jpeg", "sizeBytes": 1024, "sha256": SAMPLE_HASH}},
    ),
    (
        "post",
        "/admin/lots/test-lot/views/V1/reference/complete",
        {"json": {"sha256": SAMPLE_HASH, "width": 800, "height": 600}},
    ),
]


def test_reserve_upload_slot(client, admin_headers):
    r = client.post(
        "/admin/lots/test-lot/views/V1/reference",
        json={"contentType": "image/jpeg", "sizeBytes": len(SAMPLE_BYTES), "sha256": SAMPLE_HASH},
        headers=admin_headers,
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert "uploadUrl" in body
    assert "expiresAt" in body
    assert body["uploadUrl"].startswith("/api/_test/uploads/")


def test_reserve_unknown_lot_or_viewpoint(client, admin_headers):
    r = client.post(
        "/admin/lots/nope/views/V1/reference",
        json={"contentType": "image/jpeg", "sizeBytes": 100, "sha256": SAMPLE_HASH},
        headers=admin_headers,
    )
    assert r.status_code == 404
    assert r.json()["message"] == "Lot not found"

    r = client.post(
        "/admin/lots/test-lot/views/V99/reference",
        json={"contentType": "image/jpeg", "sizeBytes": 100, "sha256": SAMPLE_HASH},
        headers=admin_headers,
    )
    assert r.status_code == 404
    assert r.json()["message"] == "Viewpoint not found"


def test_reserve_validation(client, admin_headers, adapters, clock):
    # Too large (> 15 MB)
    r = client.post(
        "/admin/lots/test-lot/views/V1/reference",
        json={"contentType": "image/jpeg", "sizeBytes": 16 * 1024 * 1024, "sha256": SAMPLE_HASH},
        headers=admin_headers,
    )
    assert r.status_code == 422
    assert r.json()["error"] == "too_large"
    assert r.json()["message"] == "Photos must be 15 MB or smaller"

    # Unsupported content type via settings
    s = Settings(app_env="test", allowed_upload_types=("image/png",), _env_file=None)  # type: ignore[call-arg]
    custom_app = create_app(s, adapters)
    custom_app.state.now = clock
    r = TestClient(custom_app).post(
        "/admin/lots/test-lot/views/V1/reference",
        json={"contentType": "image/jpeg", "sizeBytes": 100, "sha256": SAMPLE_HASH},
        headers=admin_headers,
    )
    assert r.status_code == 422
    assert r.json()["error"] == "unsupported_type"
    assert r.json()["message"] == "Photos must be JPEG or PNG"

    # Contract-level schema rejection for non-enum types
    r = client.post(
        "/admin/lots/test-lot/views/V1/reference",
        json={"contentType": "image/gif", "sizeBytes": 100, "sha256": SAMPLE_HASH},
        headers=admin_headers,
    )
    assert r.status_code == 422
    assert r.json()["error"] == "validation_error"

    # Malformed sha256
    r = client.post(
        "/admin/lots/test-lot/views/V1/reference",
        json={"contentType": "image/jpeg", "sizeBytes": 100, "sha256": "not-a-hash"},
        headers=admin_headers,
    )
    assert r.status_code == 422
    assert r.json()["error"] == "validation_error"


def test_complete_upload_success(client, admin_headers, adapters):
    # Reserve slot
    r = client.post(
        "/admin/lots/test-lot/views/V1/reference",
        json={"contentType": "image/jpeg", "sizeBytes": len(SAMPLE_BYTES), "sha256": SAMPLE_HASH},
        headers=admin_headers,
    )
    assert r.status_code == 201
    upload_url = r.json()["uploadUrl"]

    # Upload bytes via test route
    test_upload_url = upload_url.removeprefix("/api")
    up = client.put(test_upload_url, content=SAMPLE_BYTES, headers={"Content-Type": "image/jpeg"})
    assert up.status_code == 204

    # Complete upload
    comp = client.post(
        "/admin/lots/test-lot/views/V1/reference/complete",
        json={"sha256": SAMPLE_HASH, "width": 4000, "height": 3000},
        headers=admin_headers,
    )
    assert comp.status_code == 200, comp.text
    res = comp.json()
    assert res["viewId"] == "V1"
    assert res["referenceImage"]["width"] == 4000
    assert res["referenceImage"]["height"] == 3000
    image_url = res["referenceImage"]["url"]
    assert image_url.startswith("/api/_test/objects/")

    # Viewpoint in repository is updated
    vp = adapters.repository.get_viewpoint("test-lot", "V1")
    assert vp is not None
    assert vp.reference_image_key == keys.reference_image_key("test-lot", "V1", SAMPLE_HASH)
    assert vp.image_width == 4000
    assert vp.image_height == 3000

    # Local object serving returns the image bytes
    test_obj_url = image_url.removeprefix("/api")
    obj_res = client.get(test_obj_url)
    assert obj_res.status_code == 200
    assert obj_res.content == SAMPLE_BYTES
    assert obj_res.headers["content-type"] == "image/jpeg"


def test_complete_missing_object(client, admin_headers):
    r = client.post(
        "/admin/lots/test-lot/views/V1/reference/complete",
        json={"sha256": SAMPLE_HASH, "width": 4000, "height": 3000},
        headers=admin_headers,
    )
    assert r.status_code == 409
    assert r.json()["error"] == "missing_object"
    assert r.json()["message"] == "The photo has not finished uploading"


def test_complete_hash_mismatch(client, admin_headers, adapters):
    # Store bytes under the key for SAMPLE_HASH
    key = keys.reference_image_key("test-lot", "V1", SAMPLE_HASH)
    adapters.object_store.put(key, b"different bytes than SAMPLE_HASH", "image/jpeg")

    # Call complete claiming it is SAMPLE_HASH
    r = client.post(
        "/admin/lots/test-lot/views/V1/reference/complete",
        json={"sha256": SAMPLE_HASH, "width": 4000, "height": 3000},
        headers=admin_headers,
    )
    assert r.status_code == 409
    assert r.json()["error"] == "hash_mismatch"
    assert r.json()["message"] == "Uploaded file does not match its hash"


def test_content_addressing_and_reupload(client, admin_headers, adapters):
    # Upload photo 1
    key1 = keys.reference_image_key("test-lot", "V1", SAMPLE_HASH)
    adapters.object_store.put(key1, SAMPLE_BYTES, "image/jpeg")
    r1 = client.post(
        "/admin/lots/test-lot/views/V1/reference/complete",
        json={"sha256": SAMPLE_HASH, "width": 1000, "height": 800},
        headers=admin_headers,
    )
    assert r1.status_code == 200
    vp1 = adapters.repository.get_viewpoint("test-lot", "V1")
    assert vp1.reference_image_key == key1

    # Re-uploading the same bytes maps to the same key
    r1_repeat = client.post(
        "/admin/lots/test-lot/views/V1/reference/complete",
        json={"sha256": SAMPLE_HASH, "width": 1000, "height": 800},
        headers=admin_headers,
    )
    assert r1_repeat.status_code == 200
    vp1_repeat = adapters.repository.get_viewpoint("test-lot", "V1")
    assert vp1_repeat.reference_image_key == key1

    # Uploading different photo gets a distinct key
    key2 = keys.reference_image_key("test-lot", "V1", SAMPLE_HASH_2)
    adapters.object_store.put(key2, SAMPLE_BYTES_2, "image/jpeg")
    r2 = client.post(
        "/admin/lots/test-lot/views/V1/reference/complete",
        json={"sha256": SAMPLE_HASH_2, "width": 1200, "height": 900},
        headers=admin_headers,
    )
    assert r2.status_code == 200
    vp2 = adapters.repository.get_viewpoint("test-lot", "V1")
    assert vp2.reference_image_key == key2
    assert key2 != key1
    # Old object still exists in object store
    assert adapters.object_store.exists(key1)


@pytest.mark.parametrize(("method", "path", "kw"), REFERENCE_ROUTES)
def test_reference_routes_require_admin(client, viewer_headers, settings, method, path, kw):
    assert getattr(client, method)(path, **kw).status_code == 401
    r = getattr(client, method)(path, headers=viewer_headers, **kw)
    assert r.status_code == 403 and r.json()["error"] == "forbidden"
    old = token(settings, settings.dev_admin_email, ["admin"], now=NOW - timedelta(days=1))
    r = getattr(client, method)(path, headers={"Authorization": f"Bearer {old}"}, **kw)
    assert r.status_code == 401 and r.json()["error"] == "session_expired"


def test_testonly_route_disabled_in_prod(settings, adapters):
    prod_settings = settings.model_copy(update={"app_env": "production"})
    prod_app = create_app(prod_settings, adapters)
    prod_client = TestClient(prod_app)
    r = prod_client.get("/_test/objects/reference/test-lot/V1/somephoto.jpg")
    assert r.status_code == 404
