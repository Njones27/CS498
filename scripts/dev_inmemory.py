"""Run API + worker in one process on the in-memory adapters, seeded with the test lot.

No Docker needed. Useful for frontend work and browser checks:

    uv run python scripts/dev_inmemory.py          # API on :8000
    cd web && npm run dev                           # Vite on :5173 proxies /api -> :8000

Presigned uploads go to the test-only route /_test/uploads/{imageId}; the worker thread picks
jobs off the in-memory queue and scores them with the stub scorer.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
from pathlib import Path

import uvicorn

ROOT = Path(__file__).resolve().parents[1]
# Put the workspace packages on the path directly instead of relying on uv's editable
# .pth files, which Python skips when macOS marks them hidden.
for pkg in ("core", "api", "worker", "seed"):
    sys.path.insert(0, str(ROOT / pkg))

from parking_api.main import create_app  # noqa: E402
from parking_core.settings import Settings, build_adapters  # noqa: E402
from parking_seed.loader import DEFAULT_LOT, FIXTURES_DIR, load_lot_file, seed_lot  # noqa: E402
from parking_worker.aligners import build_aligner  # noqa: E402
from parking_worker.poller import run_forever  # noqa: E402
from parking_worker.scorers import build_scorer  # noqa: E402


def main(port: int = 8000) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = Settings(app_env="test", _env_file=None)  # type: ignore[call-arg]
    adapters = build_adapters(settings)
    image = FIXTURES_DIR / f"{DEFAULT_LOT}.jpg"
    result = seed_lot(
        adapters, load_lot_file(DEFAULT_LOT), image.read_bytes() if image.exists() else None
    )
    print(result.summary())
    print(f"Dev admin: {settings.dev_admin_email} / {settings.dev_admin_password}")

    stop = threading.Event()
    worker = threading.Thread(
        target=run_forever,
        args=(
            adapters,
            build_aligner(settings, adapters),
            build_scorer(settings),
            settings.cutoffs,
            stop,
        ),
        daemon=True,
        name="worker",
    )
    worker.start()
    host = os.environ.get("HOST", "0.0.0.0")
    try:
        uvicorn.run(create_app(settings, adapters), host=host, port=port, log_level="info")
    finally:
        stop.set()


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 8000)
