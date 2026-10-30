"""Tests for admin reference photo endpoints (US-08) and local photo serving."""

from __future__ import annotations

import hashlib
import struct
import zlib
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from parking_api.image_size import image_size
from parking_api.main import create_app
from parking_core import keys
from parking_core.settings import Settings

from .conftest import NOW, token
from .test_layout import as_body, get_draft, put


def jpeg(width: int, height: int, orientation: int | None = None, fill: bytes = b"\x00") -> bytes:
    """A JPEG header: JFIF, an optional EXIF orientation, a baseline frame header, then filler."""
    out = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    if orientation is not None:
        ifd = struct.pack(">H", 1) + struct.pack(">HHIHH", 0x0112, 3, 1, orientation, 0)
        app1 = b"Exif\x00\x00" + b"MM\x00\x2a" + struct.pack(">I", 8) + ifd + b"\x00" * 4
        out += b"\xff\xe1" + struct.pack(">H", len(app1) + 2) + app1
    sof = b"\x08" + struct.pack(">HH", height, width) + b"\x01\x01\x11\x00"
    return out + b"\xff\xc0" + struct.pack(">H", len(sof) + 2) + sof + fill * 100 + b"\xff\xd9"


def png(width: int, height: int) -> bytes:
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    chunk = b"IHDR" + ihdr
    return (
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I", len(ihdr))
        + chunk
        + struct.pack(">I", zlib.crc32(chunk))
        + b"\x00" * 100
    )


SAMPLE_BYTES = jpeg(4000, 3000)
SAMPLE_HASH = hashlib.sha256(SAMPLE_BYTES).hexdigest()

SAMPLE_BYTES_2 = jpeg(1200, 900, fill=b"\x01")
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
        {"json": {"sha256": SAMPLE_HASH}},
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
        json={"sha256": SAMPLE_HASH},
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


def test_png_reference_is_not_labelled_jpg(client, admin_headers, adapters):
    # The key has no extension; the photo's type is the Content-Type it was uploaded with.
    data = png(640, 480)
    sha = hashlib.sha256(data).hexdigest()
    r = client.post(
        "/admin/lots/test-lot/views/V1/reference",
        json={"contentType": "image/png", "sizeBytes": len(data), "sha256": sha},
        headers=admin_headers,
    )
    assert r.status_code == 201
    upload_url = r.json()["uploadUrl"].removeprefix("/api")
    up = client.put(upload_url, content=data, headers={"Content-Type": "image/png"})
    assert up.status_code == 204
    comp = client.post(
        "/admin/lots/test-lot/views/V1/reference/complete",
        json={"sha256": sha},
        headers=admin_headers,
    )
    assert comp.status_code == 200, comp.text
    ref = comp.json()["referenceImage"]
    assert (ref["width"], ref["height"]) == (640, 480)

    key = adapters.repository.get_viewpoint("test-lot", "V1").reference_image_key
    assert key == f"reference/test-lot/V1/{sha[:12]}"
    obj = client.get(comp.json()["referenceImage"]["url"].removeprefix("/api"))
    assert obj.content == data
    assert obj.headers["content-type"] == "image/png"


def test_complete_missing_object(client, admin_headers):
    r = client.post(
        "/admin/lots/test-lot/views/V1/reference/complete",
        json={"sha256": SAMPLE_HASH},
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
        json={"sha256": SAMPLE_HASH},
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
        json={"sha256": SAMPLE_HASH},
        headers=admin_headers,
    )
    assert r1.status_code == 200
    vp1 = adapters.repository.get_viewpoint("test-lot", "V1")
    assert vp1.reference_image_key == key1

    # Re-uploading the same bytes maps to the same key
    r1_repeat = client.post(
        "/admin/lots/test-lot/views/V1/reference/complete",
        json={"sha256": SAMPLE_HASH},
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
        json={"sha256": SAMPLE_HASH_2},
        headers=admin_headers,
    )
    assert r2.status_code == 200
    vp2 = adapters.repository.get_viewpoint("test-lot", "V1")
    assert vp2.reference_image_key == key2
    assert key2 != key1
    # Old object still exists in object store
    assert adapters.object_store.exists(key1)


def _complete(client, admin_headers, sha256: str, **extra):
    return client.post(
        "/admin/lots/test-lot/views/V1/reference/complete",
        json={"sha256": sha256, **extra},
        headers=admin_headers,
    )


def _stored(adapters, data: bytes, content_type: str = "image/jpeg") -> str:
    sha = hashlib.sha256(data).hexdigest()
    adapters.object_store.put(keys.reference_image_key("test-lot", "V1", sha), data, content_type)
    return sha


def test_complete_reads_the_size_from_the_file(client, admin_headers, adapters):
    # The client's numbers are ignored: the outlines and the aligner depend on the real size.
    sha = _stored(adapters, jpeg(1600, 900))
    r = _complete(client, admin_headers, sha, width=1, height=1)
    assert r.status_code == 200, r.text
    ref = r.json()["referenceImage"]
    assert (ref["width"], ref["height"]) == (1600, 900)
    vp = adapters.repository.get_viewpoint("test-lot", "V1")
    assert (vp.image_width, vp.image_height) == (1600, 900)


def test_complete_applies_the_exif_orientation(client, admin_headers, adapters):
    # A portrait phone photo is stored landscape with orientation 6; browsers show it upright.
    sha = _stored(adapters, jpeg(4032, 3024, orientation=6))
    r = _complete(client, admin_headers, sha)
    assert r.status_code == 200, r.text
    vp = adapters.repository.get_viewpoint("test-lot", "V1")
    assert (vp.image_width, vp.image_height) == (3024, 4032)


def test_complete_rejects_an_oversize_object_without_reading_it(
    settings, adapters, clock, admin_headers, monkeypatch
):
    small = settings.model_copy(update={"max_upload_bytes": 64})
    app = create_app(small, adapters)
    app.state.now = clock
    sha = _stored(adapters, SAMPLE_BYTES)  # over 64 bytes; a presigned PUT cannot stop that
    reads: list[str] = []
    monkeypatch.setattr(adapters.object_store, "get", lambda key: reads.append(key) or b"")
    r = _complete(TestClient(app), admin_headers, sha)
    assert r.status_code == 409
    assert r.json() == {"error": "too_large", "message": "Photos must be 15 MB or smaller"}
    assert reads == []
    assert adapters.repository.get_viewpoint("test-lot", "V1").image_width == 640  # unchanged


@pytest.mark.parametrize(
    ("data", "content_type"),
    [
        (SAMPLE_BYTES, "text/plain"),  # stored with a type that is not allowed
        (b"<html>not a photo</html>", "image/jpeg"),  # labelled JPEG, but is not one
        (png(10, 10), "image/jpeg"),  # a PNG labelled JPEG
        (SAMPLE_BYTES[:26], "image/jpeg"),  # a JPEG cut off inside its frame header
    ],
    ids=["type-not-allowed", "not-an-image", "png-labelled-jpeg", "truncated-jpeg"],
)
def test_complete_rejects_a_file_that_is_not_an_allowed_image(
    client, admin_headers, adapters, data, content_type
):
    sha = _stored(adapters, data, content_type)
    r = _complete(client, admin_headers, sha)
    assert r.status_code == 409, r.text
    assert r.json() == {"error": "unsupported_type", "message": "Photos must be JPEG or PNG"}
    vp = adapters.repository.get_viewpoint("test-lot", "V1")
    assert vp.reference_image_key != keys.reference_image_key("test-lot", "V1", sha)


@pytest.mark.parametrize(
    ("data", "content_type", "size"),
    [
        (jpeg(640, 360), "image/jpeg", (640, 360)),
        (jpeg(640, 360, orientation=1), "image/jpeg", (640, 360)),
        (jpeg(640, 360, orientation=3), "image/jpeg", (640, 360)),  # upside down: same size
        (jpeg(640, 360, orientation=8), "image/jpeg", (360, 640)),
        (png(33, 17), "image/png", (33, 17)),
        (png(33, 17), "image/gif", None),
        (jpeg(0, 360), "image/jpeg", None),
        (b"\xff\xd8\xff\xda\x00\x02", "image/jpeg", None),  # image data before a frame header
        (b"\x89PNG\r\n\x1a\n\x00\x00", "image/png", None),
    ],
    ids=[
        "jpeg",
        "jpeg-upright",
        "jpeg-upside-down",
        "jpeg-quarter-turn",
        "png",
        "other-type",
        "zero-width",
        "scan-before-frame",
        "truncated-png",
    ],
)
def test_image_size(data, content_type, size):
    assert image_size(data, content_type) == size


def test_photo_completed_during_a_draft_save_is_kept(client, admin_headers, adapters, monkeypatch):
    # The save reads the viewpoints, the photo's complete lands, then the save writes them.
    repo = adapters.repository
    body = as_body(get_draft(client, admin_headers))
    sha = _stored(adapters, jpeg(1600, 900))
    list_viewpoints = repo.list_viewpoints

    def complete_lands_mid_save(lot_id):
        views = list_viewpoints(lot_id)
        monkeypatch.setattr(repo, "list_viewpoints", list_viewpoints)
        assert _complete(client, admin_headers, sha).status_code == 200
        return views

    monkeypatch.setattr(repo, "list_viewpoints", complete_lands_mid_save)
    assert put(client, admin_headers, body).status_code == 200
    vp = repo.get_viewpoint("test-lot", "V1")
    assert vp.reference_image_key == keys.reference_image_key("test-lot", "V1", sha)
    assert (vp.image_width, vp.image_height) == (1600, 900)


def test_outlines_saved_during_a_photo_complete_are_kept(
    client, admin_headers, adapters, monkeypatch
):
    # complete reads the viewpoint, a draft save writes new outlines, then complete writes.
    repo = adapters.repository
    body = as_body(get_draft(client, admin_headers))
    v1 = next(v for v in body["viewpoints"] if v["viewId"] == "V1")
    v1["outlines"], v1["outlineReview"] = {}, {}
    sha = _stored(adapters, jpeg(1600, 900))
    get_viewpoint = repo.get_viewpoint

    def save_lands_mid_complete(lot_id, view_id):
        vp = get_viewpoint(lot_id, view_id)
        monkeypatch.setattr(repo, "get_viewpoint", get_viewpoint)
        assert put(client, admin_headers, body).status_code == 200
        return vp

    monkeypatch.setattr(repo, "get_viewpoint", save_lands_mid_complete)
    assert _complete(client, admin_headers, sha).status_code == 200
    vp = repo.get_viewpoint("test-lot", "V1")
    assert vp.outlines == {}
    assert vp.reference_image_key == keys.reference_image_key("test-lot", "V1", sha)


def test_image_size_matches_a_real_encoder():
    cv2 = pytest.importorskip("cv2")
    np = pytest.importorskip("numpy")
    img = np.zeros((23, 37, 3), dtype=np.uint8)
    for ext, content_type in ((".jpg", "image/jpeg"), (".png", "image/png")):
        ok, buf = cv2.imencode(ext, img)
        assert ok
        assert image_size(buf.tobytes(), content_type) == (37, 23)


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
