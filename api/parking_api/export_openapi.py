"""Write the OpenAPI document that web/ generates its types from.

uv run python -m parking_api.export_openapi > contract/openapi.json
"""

from __future__ import annotations

import json
import sys

from parking_core.settings import Settings

from .main import create_app


def export() -> str:
    # Always export with the test-only route included so the generated types cover it.
    app = create_app(Settings(app_env="test", _env_file=None))  # type: ignore[call-arg]
    return json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n"


if __name__ == "__main__":
    sys.stdout.write(export())
