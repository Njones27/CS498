"""FastAPI dependencies: settings, adapters, admin auth.

Settings and adapters hang off `app.state` so tests can build an app with their own
Settings (APP_ENV=test -> memory adapters) without touching environment variables.
"""

from __future__ import annotations

import threading
from datetime import datetime
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request
from parking_core.models import Principal, utcnow
from parking_core.settings import Adapters, Settings, build_adapters


def get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings


_build_lock = threading.Lock()


def get_adapters_dep(request: Request) -> Adapters:
    state = request.app.state
    if getattr(state, "adapters", None) is None:
        with _build_lock:  # sync deps run in a threadpool; build exactly once
            if getattr(state, "adapters", None) is None:
                state.adapters = build_adapters(state.settings)
    return state.adapters


def get_now_dep(request: Request) -> datetime:
    """Current time. Tests freeze it by setting `app.state.now` to another callable."""
    return getattr(request.app.state, "now", utcnow)()


NowDep = Annotated[datetime, Depends(get_now_dep)]
SettingsDep = Annotated[Settings, Depends(get_settings_dep)]
AdaptersDep = Annotated[Adapters, Depends(get_adapters_dep)]


def error(status: int, code: str, message: str, **extra: object) -> HTTPException:
    """Every error body is {"error": code, "message": text, ...}."""
    return HTTPException(status_code=status, detail={"error": code, "message": message, **extra})


def require_admin(
    adapters: AdaptersDep,
    authorization: Annotated[str | None, Header()] = None,
) -> Principal:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise error(401, "unauthenticated", "Sign in to continue")
    principal = adapters.auth_verifier.verify(authorization[7:].strip())
    if principal is None:
        raise error(401, "unauthenticated", "Sign in to continue")
    if principal.expired:
        raise error(401, "session_expired", "Your session expired. Please sign in again")
    if not principal.is_admin:
        raise error(403, "forbidden", "You do not have admin access")
    return principal


AdminDep = Annotated[Principal, Depends(require_admin)]
