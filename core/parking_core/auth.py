"""Token checks (HDD §4.4). AUTH_MODE=dev: HS256 JWTs signed by the API itself.
AUTH_MODE=cognito: ID tokens issued by a Cognito user pool, checked against its public keys."""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any

import jwt

from .models import Principal, utcnow
from .settings import Settings

log = logging.getLogger(__name__)

ALGORITHM = "HS256"
COGNITO_ALGORITHM = "RS256"
COGNITO_GROUPS_CLAIM = "cognito:groups"
JWKS_CACHE_SECONDS = 3600
JWKS_TIMEOUT_SECONDS = 5
CLOCK_SKEW_SECONDS = 10
"""A token issued a moment ago must not read as "not valid yet" when this clock runs behind."""


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


class CognitoVerifier:
    """Verifies Cognito ID tokens: RS256 signature against the pool's published keys, issuer,
    audience (the web app's client id) and `token_use`. The ID token is used, not the access
    token, because it carries the email the API records with each admin action."""

    def __init__(
        self,
        region: str,
        user_pool_id: str,
        client_id: str,
        signing_key: Callable[[str], Any] | None = None,
    ) -> None:
        self._issuer = f"https://cognito-idp.{region}.amazonaws.com/{user_pool_id}"
        self._client_id = client_id
        if signing_key is None:
            # Fetched on the first token and cached: building the verifier needs no network.
            # The key set is cached for an hour, not each key forever: a key the pool rotates
            # out stops being trusted.
            jwks = jwt.PyJWKClient(
                f"{self._issuer}/.well-known/jwks.json",
                lifespan=JWKS_CACHE_SECONDS,
                timeout=JWKS_TIMEOUT_SECONDS,
            )

            def signing_key(token: str) -> Any:
                return jwks.get_signing_key_from_jwt(token).key

        self._signing_key = signing_key

    @classmethod
    def from_settings(cls, settings: Settings) -> CognitoVerifier:
        if not (settings.cognito_user_pool_id and settings.cognito_client_id):
            raise ValueError(
                "COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID must be set when AUTH_MODE=cognito"
            )
        return cls(settings.aws_region, settings.cognito_user_pool_id, settings.cognito_client_id)

    def verify(self, token: str) -> Principal | None:
        try:
            key = self._signing_key(token)
        except jwt.PyJWTError as exc:
            # A malformed token or a key this pool does not publish. Not being able to reach
            # the keys is the one case worth a log line.
            if isinstance(exc, jwt.PyJWKClientConnectionError):
                log.exception("Could not fetch the Cognito signing keys")
            return None
        except Exception:  # a dropped connection or bad JSON mid-fetch: fail closed, as a 401
            log.exception("Could not read the Cognito signing keys")
            return None
        expired = False
        try:
            claims = self._decode(token, key, verify_exp=True)
        except jwt.ExpiredSignatureError:
            try:
                claims = self._decode(token, key, verify_exp=False)
            except jwt.InvalidTokenError:
                return None
            expired = True
        except jwt.InvalidTokenError:
            return None
        email = claims.get("email")
        groups = claims.get(COGNITO_GROUPS_CLAIM) or []
        if claims.get("token_use") != "id" or not isinstance(email, str):
            return None
        if not isinstance(groups, list):
            return None
        return Principal(email=email, groups=[str(g) for g in groups], expired=expired)

    def _decode(self, token: str, key: Any, verify_exp: bool) -> dict[str, Any]:
        return jwt.decode(
            token,
            key,
            algorithms=[COGNITO_ALGORITHM],
            audience=self._client_id,
            issuer=self._issuer,
            options={"require": ["exp", "iss", "aud"], "verify_exp": verify_exp},
            leeway=CLOCK_SKEW_SECONDS,
        )


def dev_users(settings: Settings) -> dict[str, tuple[str, list[str]]]:
    """email -> (password, groups) for AUTH_MODE=dev."""
    return {
        settings.dev_admin_email: (settings.dev_admin_password, ["admin"]),
        settings.dev_user_email: (settings.dev_user_password, []),
    }
