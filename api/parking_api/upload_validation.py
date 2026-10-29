"""Shared validation rules for photo uploads."""

from __future__ import annotations

from parking_core.settings import Settings

from .deps import error


def validate_photo_type_and_size(content_type: str, size_bytes: int, settings: Settings) -> None:
    if size_bytes > settings.max_upload_bytes:
        raise error(422, "too_large", "Photos must be 15 MB or smaller")
    if content_type not in settings.allowed_upload_types:
        raise error(422, "unsupported_type", "Photos must be JPEG or PNG")
