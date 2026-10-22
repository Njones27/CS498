"""Dev sign-in (AUTH_MODE=dev). Cognito handles sign-in in Phase 2, so this route 404s there."""

from __future__ import annotations

import hmac

from fastapi import APIRouter
from parking_core.auth import DevJwtSigner, dev_users

from ..deps import NowDep, SettingsDep, error
from ..schemas import ErrorResponse, LoginRequest, LoginResponse

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post(
    "/login",
    response_model=LoginResponse,
    responses={401: {"model": ErrorResponse}, 404: {"model": ErrorResponse}},
    summary="Dev sign-in with email and password",
)
def login(body: LoginRequest, settings: SettingsDep, now: NowDep) -> LoginResponse:
    if settings.auth_mode != "dev":
        raise error(404, "not_found", "Not found")
    email = body.email.strip().lower()
    users = {k.lower(): v for k, v in dev_users(settings).items()}
    user = users.get(email)
    if user is None or not hmac.compare_digest(user[0].encode(), body.password.encode()):
        raise error(401, "invalid_credentials", "Email or password is incorrect")
    groups = user[1]
    signer = DevJwtSigner(settings.jwt_secret, settings.jwt_ttl_minutes)
    token, expires_at = signer.sign(email, groups, now=now)
    return LoginResponse(token=token, expires_at=expires_at, email=email, groups=groups)
