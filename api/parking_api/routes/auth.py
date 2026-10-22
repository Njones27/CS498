"""Dev sign-in (AUTH_MODE=dev). Cognito handles sign-in in Phase 2, so this route 404s there."""

from __future__ import annotations

from fastapi import APIRouter

from ..deps import SettingsDep, error
from ..schemas import ErrorResponse, LoginRequest, LoginResponse

router = APIRouter(prefix="/auth", tags=["auth"])

NOT_IMPLEMENTED = error(501, "not_implemented", "Contract stub")


@router.post(
    "/login",
    response_model=LoginResponse,
    responses={401: {"model": ErrorResponse}, 404: {"model": ErrorResponse}},
    summary="Dev sign-in with email and password",
)
def login(body: LoginRequest, settings: SettingsDep) -> LoginResponse:
    raise NOT_IMPLEMENTED
