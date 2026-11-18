"""The API behind API Gateway: HTTP API (payload 2.0) events through Mangum."""

from __future__ import annotations

import json

from parking_api import lambda_handler
from parking_api.lambda_handler import build_handler
from parking_core.settings import get_settings


def http_event(method: str, path: str, headers: dict[str, str] | None = None) -> dict:
    """An API Gateway HTTP API event, payload format 2.0, as the `ANY /api/{proxy+}` route
    delivers it: the path still carries the /api prefix CloudFront forwarded."""
    return {
        "version": "2.0",
        "routeKey": "ANY /api/{proxy+}",
        "rawPath": path,
        "rawQueryString": "",
        "headers": {"accept": "application/json", "host": "example.cloudfront.net"}
        | (headers or {}),
        "requestContext": {
            "accountId": "123456789012",
            "apiId": "abc123",
            "domainName": "abc123.execute-api.us-east-1.amazonaws.com",
            "http": {
                "method": method,
                "path": path,
                "protocol": "HTTP/1.1",
                "sourceIp": "203.0.113.9",
                "userAgent": "pytest",
            },
            "requestId": "req-1",
            "routeKey": "ANY /api/{proxy+}",
            "stage": "$default",
            "time": "17/Nov/2026:19:00:00 +0000",
            "timeEpoch": 1794942000000,
        },
        "isBase64Encoded": False,
    }


def test_api_prefix_is_stripped_before_routing(app):
    handler = build_handler(app)
    response = handler(http_event("GET", "/api/health"), None)
    assert response["statusCode"] == 200
    assert json.loads(response["body"]) == {"status": "ok"}

    response = handler(http_event("GET", "/api/lots"), None)
    assert response["statusCode"] == 200
    assert [lot["lotId"] for lot in json.loads(response["body"])] == ["test-lot"]


def test_admin_routes_see_the_bearer_token(app, admin_headers):
    handler = build_handler(app)
    denied = handler(http_event("GET", "/api/admin/lots"), None)
    assert denied["statusCode"] == 401
    assert json.loads(denied["body"])["error"] == "unauthenticated"

    headers = {"authorization": admin_headers["Authorization"]}
    allowed = handler(http_event("GET", "/api/admin/lots", headers), None)
    assert allowed["statusCode"] == 200


def test_unknown_paths_keep_the_error_envelope(app):
    response = build_handler(app)(http_event("GET", "/api/nope"), None)
    assert response["statusCode"] == 404
    assert json.loads(response["body"])["error"] == "http_error"


def test_handler_builds_the_app_once_from_the_environment(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    get_settings.cache_clear()
    monkeypatch.setattr(lambda_handler, "_handler", None)
    try:
        response = lambda_handler.handler(http_event("GET", "/api/health"), None)
        assert response["statusCode"] == 200
        built = lambda_handler._handler
        lambda_handler.handler(http_event("GET", "/api/health"), None)
        assert lambda_handler._handler is built
    finally:
        get_settings.cache_clear()
