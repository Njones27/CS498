"""AWS Lambda entry point for the API (HDD §8): API Gateway HTTP API -> Mangum -> FastAPI.

CloudFront sends the site's `/api/*` requests to API Gateway with the prefix still on, the
same prefix the Vite dev proxy strips locally, so Mangum strips it here and the app serves
the HDD §6.1 paths at its root in both places.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from mangum import Mangum

from .main import create_app

API_BASE_PATH = "/api"

_handler: Mangum | None = None


def build_handler(app: FastAPI | None = None) -> Mangum:
    # lifespan off: the app has no startup hooks, and Lambda would run them on every cold start.
    return Mangum(app or create_app(), lifespan="off", api_gateway_base_path=API_BASE_PATH)


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Built on the first request, so importing this module never reads the environment."""
    global _handler
    if _handler is None:
        _handler = build_handler()
    return _handler(event, context)
