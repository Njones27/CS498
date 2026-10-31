"""Auth on every admin route (US-03 #3-#5, NFR-6), enumerated from the OpenAPI document so a
new route is covered the day it is added, plus proof that a rejected write changes nothing."""

from __future__ import annotations

import re
from datetime import timedelta

import pytest
from parking_api.main import create_app
from parking_core.settings import Settings

from .conftest import NOW, token
from .integration_helpers import (
    as_put_body,
    auth,
    close,
    failing_scorer,
    fingerprint,
    put_photo,
    request_slot,
    run_worker,
    sha,
    upload_photo,
    upload_reference,
)

PUBLIC = {
    ("get", "/health"),
    ("get", "/lots"),
    ("get", "/lots/{lot_id}"),
    ("get", "/lots/{lot_id}/status"),
    ("post", "/auth/login"),
}
PATH_PARAMS = {
    "lot_id": "test-lot",
    "view_id": "V1",
    "version": "1",
    "image_id": "nope",
    "closure_id": "cl_x",
    "override_id": "ov_x",
    "key": "x",
}
_METHODS = {"get", "put", "post", "patch", "delete"}


def _operations() -> list[tuple[str, str]]:
    paths = create_app(Settings(app_env="test", _env_file=None)).openapi()["paths"]  # type: ignore[call-arg]
    return sorted((m, p) for p, ops in paths.items() for m in ops if m in _METHODS)


def _fill(path: str) -> str:
    # KeyError on a new path parameter: add a value for it to PATH_PARAMS.
    return re.sub(r"\{(\w+)(?::\w+)?\}", lambda m: PATH_PARAMS[m.group(1)], path)


OPERATIONS = _operations()
ADMIN_OPS = [(m, p) for m, p in OPERATIONS if p.startswith("/admin/")]


def test_every_route_is_public_admin_or_test_only():
    assert len(ADMIN_OPS) >= 18  # never pass on an empty or truncated enumeration
    stray = [
        (m, p)
        for m, p in OPERATIONS
        if (m, p) not in PUBLIC and not p.startswith(("/admin/", "/_test/"))
    ]
    assert stray == []
    assert {(m, p) for m, p in OPERATIONS if not p.startswith(("/admin/", "/_test/"))} == PUBLIC


def _bad_headers(settings, case: str) -> dict[str, str]:
    if case == "none":
        return {}
    if case == "basic":
        return {"Authorization": "Basic abc"}
    if case == "garbage":
        return auth("not-a-jwt")
    if case == "forged":
        forged = Settings(app_env="test", jwt_secret="someone-elses-secret", _env_file=None)  # type: ignore[call-arg]
        return auth(token(forged, settings.dev_admin_email, ["admin"]))
    if case == "expired":
        old = NOW - timedelta(days=1)
        return auth(token(settings, settings.dev_admin_email, ["admin"], now=old))
    if case == "viewer":
        return auth(token(settings, settings.dev_user_email, []))
    if case == "admin_email_no_group":
        return auth(token(settings, settings.dev_admin_email, ["drivers"]))
    raise AssertionError(case)


BAD_CASES = {
    "none": (401, "unauthenticated"),
    "basic": (401, "unauthenticated"),
    "garbage": (401, "unauthenticated"),
    "forged": (401, "unauthenticated"),
    "expired": (401, "session_expired"),
    "viewer": (403, "forbidden"),
    "admin_email_no_group": (403, "forbidden"),
}


@pytest.mark.parametrize("case", list(BAD_CASES))
@pytest.mark.parametrize(("method", "path"), ADMIN_OPS, ids=[f"{m} {p}" for m, p in ADMIN_OPS])
def test_admin_route_rejects_bad_credentials(client, settings, method, path, case):
    r = client.request(method.upper(), _fill(path), json={}, headers=_bad_headers(settings, case))
    code, error = BAD_CASES[case]
    assert r.status_code == code, r.text
    assert r.json()["error"] == error


@pytest.fixture
def busy_lot(client, admin_headers, adapters, settings, clock) -> dict[str, str]:
    """Test Lot with something for every write to touch: a FAILED snapshot, a pending upload
    whose bytes arrived, an active closure and an extra reference photo in the store."""
    failed = upload_photo(
        client, admin_headers, "test-lot", "V1", b"failed", NOW - timedelta(minutes=10)
    )
    assert run_worker(adapters, settings, failing_scorer(), clock).outcome == "failed_permanent"
    pending_slot = request_slot(
        client, admin_headers, "test-lot", "V1", b"pending", NOW - timedelta(minutes=5)
    )
    pending = put_photo(client, pending_slot, b"pending")
    r = close(client, admin_headers, "test-lot", ["B-01"], NOW - timedelta(minutes=1))
    assert r.status_code == 201, r.text
    upload_reference(client, admin_headers, "test-lot", "V2", b"new-v2-reference")
    return {"failed": failed, "pending": pending, "closure": r.json()["closureId"]}


@pytest.mark.parametrize("case", ["none", "viewer", "expired", "forged"])
def test_rejected_writes_change_nothing(client, admin_headers, adapters, settings, busy_lot, case):
    """US-03 #4 / NFR-6: "the photo is not uploaded, and nothing in the lot changes"."""
    bad = _bad_headers(settings, case)
    draft = client.get("/admin/lots/test-lot/layout/draft", headers=admin_headers).json()
    renamed = as_put_body(draft)
    renamed["spaces"][0]["label"] = "Renamed"
    renamed["viewpoints"][0]["name"] = "Renamed"
    fresh = b"never-uploaded"
    ref = b"another-reference"
    writes = [
        ("POST", "/admin/lots", {"name": "Sneaky Lot", "location": "", "staleAfterMinutes": 30}),
        ("PUT", "/admin/lots/test-lot/layout/draft", renamed),
        ("POST", "/admin/lots/test-lot/layout/publish", {"revision": draft["revision"]}),
        ("POST", "/admin/lots/test-lot/layout/versions/1/restore", None),
        (
            "POST",
            "/admin/lots/test-lot/closures",
            {"spaceIds": ["A-01"], "reason": "EVENT", "startsAt": NOW.isoformat()},
        ),
        ("DELETE", f"/admin/lots/test-lot/closures/{busy_lot['closure']}", None),
        (
            "POST",
            "/admin/uploads",
            {
                "lotId": "test-lot",
                "viewId": "V1",
                "captureTime": (NOW - timedelta(minutes=2)).isoformat(),
                "sha256": sha(fresh),
                "contentType": "image/jpeg",
                "sizeBytes": len(fresh),
            },
        ),
        ("POST", f"/admin/uploads/{busy_lot['pending']}/complete", None),
        ("POST", f"/admin/snapshots/{busy_lot['failed']}/retry", None),
        (
            "POST",
            "/admin/lots/test-lot/views/V1/reference",
            {"contentType": "image/jpeg", "sizeBytes": len(ref), "sha256": sha(ref)},
        ),
        (
            "POST",
            "/admin/lots/test-lot/views/V2/reference/complete",
            {"sha256": sha(b"new-v2-reference"), "width": 10, "height": 10},
        ),
    ]
    before = fingerprint(adapters)
    for method, path, body in writes:
        r = client.request(method, path, json=body, headers=bad)
        assert r.status_code in (401, 403), (method, path, r.status_code, r.text)
    assert fingerprint(adapters) == before

    # No hash claim leaked: the photo the rejected request named still uploads for an admin.
    r = request_slot(client, admin_headers, "test-lot", "V1", fresh, NOW - timedelta(minutes=2))
    assert r.status_code == 201, r.text
