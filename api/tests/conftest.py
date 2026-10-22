from __future__ import annotations

from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from parking_api.main import create_app
from parking_core.auth import DevJwtSigner
from parking_core.models import Lot
from parking_core.settings import Settings, build_adapters
from parking_seed.loader import load_lot_file, seed_lot

NOW = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)


class Clock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


@pytest.fixture
def settings() -> Settings:
    return Settings(app_env="test", _env_file=None)  # type: ignore[call-arg]


@pytest.fixture
def adapters(settings):
    a = build_adapters(settings)
    seed_lot(a, load_lot_file("test-lot"), b"ref")
    a.repository.put_lot(Lot(lot_id="draft", name="Draft Lot", created_at=NOW))
    return a


@pytest.fixture
def clock() -> Clock:
    return Clock(NOW)


@pytest.fixture
def app(settings, adapters, clock):
    app = create_app(settings, adapters)
    app.state.now = clock
    return app


@pytest.fixture
def client(app) -> TestClient:
    return TestClient(app)


def token(settings: Settings, email: str, groups: list[str], now: datetime | None = None) -> str:
    signer = DevJwtSigner(settings.jwt_secret, settings.jwt_ttl_minutes)
    return signer.sign(email, groups, now=now)[0]


@pytest.fixture
def admin_headers(settings):
    return {"Authorization": f"Bearer {token(settings, settings.dev_admin_email, ['admin'])}"}


@pytest.fixture
def viewer_headers(settings):
    return {"Authorization": f"Bearer {token(settings, settings.dev_user_email, [])}"}
