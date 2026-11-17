"""CognitoVerifier against tokens signed with a throwaway RSA key (no network)."""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from parking_core.adapters import aws
from parking_core.auth import CognitoVerifier, HS256Verifier
from parking_core.settings import Settings

REGION = "us-east-1"
POOL = "us-east-1_Example"
CLIENT = "client-123"
ISSUER = f"https://cognito-idp.{REGION}.amazonaws.com/{POOL}"

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def id_token(key=KEY, **overrides) -> str:
    now = int(time.time())
    claims = {
        "sub": "5f0c2d0e-user",
        "email": "admin@example.edu",
        "cognito:groups": ["admin"],
        "token_use": "id",
        "iss": ISSUER,
        "aud": CLIENT,
        "iat": now,
        "exp": now + 3600,
    }
    claims.update(overrides)
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": "k1"})


@pytest.fixture
def verifier() -> CognitoVerifier:
    return CognitoVerifier(REGION, POOL, CLIENT, signing_key=lambda _token: KEY.public_key())


def test_accepts_a_pool_id_token(verifier):
    principal = verifier.verify(id_token())
    assert principal is not None
    assert (principal.email, principal.groups, principal.expired) == (
        "admin@example.edu",
        ["admin"],
        False,
    )
    assert principal.is_admin


def test_user_without_groups_is_not_admin(verifier):
    principal = verifier.verify(id_token(**{"cognito:groups": None}))
    assert principal is not None and principal.groups == [] and not principal.is_admin


def test_expired_token_is_flagged_not_rejected(verifier):
    now = int(time.time())
    principal = verifier.verify(id_token(iat=now - 7200, exp=now - 3600))
    assert principal is not None and principal.expired


@pytest.mark.parametrize(
    "overrides",
    [
        {"aud": "another-client"},
        {"iss": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Other"},
        {"token_use": "access"},
        {"email": None},
        {"exp": None},
        {"cognito:groups": "admin"},
    ],
)
def test_rejects_tokens_not_meant_for_this_api(verifier, overrides):
    assert verifier.verify(id_token(**overrides)) is None


def test_rejects_a_token_signed_by_another_key(verifier):
    assert verifier.verify(id_token(key=OTHER_KEY)) is None
    now = int(time.time())  # also when it has expired: the signature is checked first
    assert verifier.verify(id_token(key=OTHER_KEY, iat=now - 7200, exp=now - 3600)) is None


def test_rejects_dev_tokens_and_garbage(verifier):
    hs256 = jwt.encode(
        {"email": "admin@example.edu", "groups": ["admin"], "exp": int(time.time()) + 60},
        "dev-only-change-me",
        algorithm="HS256",
    )
    assert verifier.verify(hs256) is None
    assert verifier.verify("not-a-token") is None


def test_unknown_signing_key_and_unreachable_keys_fail_closed():
    def unknown(_token):
        raise jwt.PyJWKClientError("no key with that kid")

    def unreachable(_token):
        raise jwt.PyJWKClientConnectionError("timed out")

    assert CognitoVerifier(REGION, POOL, CLIENT, signing_key=unknown).verify(id_token()) is None
    assert CognitoVerifier(REGION, POOL, CLIENT, signing_key=unreachable).verify(id_token()) is None


def test_any_failure_reading_the_keys_is_a_401_not_a_crash():
    def dropped(_token):
        raise ConnectionResetError("reset mid-read")  # not a PyJWT error

    assert CognitoVerifier(REGION, POOL, CLIENT, signing_key=dropped).verify(id_token()) is None


def test_small_clock_skew_is_tolerated(verifier):
    now = int(time.time())
    # The issuer's clock a little ahead of ours, then far ahead.
    assert verifier.verify(id_token(iat=now + 5, exp=now + 3600)) is not None
    assert verifier.verify(id_token(iat=now + 120, exp=now + 3600)) is None
    barely = verifier.verify(id_token(iat=now - 3600, exp=now - 5))
    assert barely is not None and not barely.expired
    assert verifier.verify(id_token(iat=now - 3600, exp=now - 60)).expired


def test_default_key_source_is_the_pool_jwks_and_needs_no_network_to_build(monkeypatch):
    seen: dict[str, str] = {}

    class FakeJwks:
        def __init__(self, uri, **kwargs):
            seen["uri"] = uri

        def get_signing_key_from_jwt(self, token):
            return type("K", (), {"key": KEY.public_key()})()

    monkeypatch.setattr(jwt, "PyJWKClient", FakeJwks)
    verifier = CognitoVerifier(REGION, POOL, CLIENT)
    assert seen["uri"] == f"{ISSUER}/.well-known/jwks.json"
    assert verifier.verify(id_token()) is not None


# --- settings and adapter selection -------------------------------------------


def settings(**kwargs) -> Settings:
    return Settings(_env_file=None, **kwargs)  # type: ignore[call-arg]


def test_aws_refuses_dev_auth():
    with pytest.raises(ValueError, match="AUTH_MODE=dev is not allowed"):
        settings(app_env="aws")


def test_aws_needs_the_user_pool_settings():
    with pytest.raises(ValueError, match="COGNITO_USER_POOL_ID"):
        settings(app_env="aws", auth_mode="cognito", cognito_user_pool_id=POOL)
    s = settings(
        app_env="aws", auth_mode="cognito", cognito_user_pool_id=POOL, cognito_client_id=CLIENT
    )
    assert s.auth_mode == "cognito"


def test_aws_adapters_pick_the_verifier_from_auth_mode(monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")
    base = {"app_env": "local", "queue_url": "http://sqs.local/q"}
    assert isinstance(aws.build_aws_adapters(settings(**base)).auth_verifier, HS256Verifier)
    cognito = settings(
        **base, auth_mode="cognito", cognito_user_pool_id=POOL, cognito_client_id=CLIENT
    )
    assert isinstance(aws.build_aws_adapters(cognito).auth_verifier, CognitoVerifier)
    with pytest.raises(ValueError, match="COGNITO_USER_POOL_ID"):
        aws.build_aws_adapters(settings(**base, auth_mode="cognito"))


def test_s3_urls_are_path_style_for_emulators_and_virtual_hosted_on_aws(monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")
    local = aws.S3ObjectStore(
        settings(
            s3_endpoint_url="http://rustfs:9000",
            s3_public_endpoint_url="http://localhost:9000",
            bucket_name="parking-local",
        )
    )
    assert local.presign_get("raw/a.jpg").startswith("http://localhost:9000/parking-local/raw/")
    real = aws.S3ObjectStore(settings(bucket_name="parkingprod-photos"))
    url = real.presign_put("raw/a.jpg", "image/jpeg")
    assert url.startswith("https://parkingprod-photos.s3.")
    assert "/raw/a.jpg?" in url and "/parkingprod-photos/" not in url
