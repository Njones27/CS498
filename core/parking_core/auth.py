"""Dev-mode auth: HS256 JWTs signed by the API itself (HDD §4.4, AUTH_MODE=dev)."""

from __future__ import annotations

from datetime import datetime, timedelta

import jwt

from .models import Principal, utcnow
from .settings import Settings

ALGORITHM = "HS256"


class DevJwtSigner:
    def __init__(self, secret: str, ttl_minutes: int = 60) -> None:
        self._secret = secret
        self._ttl = timedelta(minutes=ttl_minutes)

    def sign(
        self, email: str, groups: list[str], now: datetime | None = None
    ) -> tuple[str, datetime]:
        issued = now or utcnow()
        expires_at = issued + self._ttl
        payload = {
            "sub": email,
            "email": email,
            "groups": list(groups),
            "iat": int(issued.timestamp()),
            "exp": int(expires_at.timestamp()),
        }
        return jwt.encode(payload, self._secret, algorithm=ALGORITHM), expires_at


class HS256Verifier:
    def __init__(self, secret: str) -> None:
        self._secret = secret

    def verify(self, token: str) -> Principal | None:
        expired = False
        try:
            claims = jwt.decode(
                token, self._secret, algorithms=[ALGORITHM], options={"require": ["exp"]}
            )
        except jwt.ExpiredSignatureError:
            try:
                claims = jwt.decode(
                    token,
                    self._secret,
                    algorithms=[ALGORITHM],
                    options={"verify_exp": False, "require": ["exp"]},
                )
            except jwt.InvalidTokenError:
                return None
            expired = True
        except jwt.InvalidTokenError:
            return None
        email = claims.get("email") or claims.get("sub")
        groups = claims.get("groups") or []
        if not isinstance(email, str) or not isinstance(groups, list):
            return None
        return Principal(email=email, groups=[str(g) for g in groups], expired=expired)


def dev_users(settings: Settings) -> dict[str, tuple[str, list[str]]]:
    """email -> (password, groups) for AUTH_MODE=dev."""
    return {
        settings.dev_admin_email: (settings.dev_admin_password, ["admin"]),
        settings.dev_user_email: (settings.dev_user_password, []),
    }
