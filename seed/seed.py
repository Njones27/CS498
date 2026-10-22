"""Seed CLI: create local resources and load a lot.

uv run python seed/seed.py [--lot test-lot]
"""

from __future__ import annotations

import argparse

from parking_core.settings import build_adapters, get_settings
from parking_seed.loader import DEFAULT_LOT, FIXTURES_DIR, load_lot_file, seed_lot


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lot", default=DEFAULT_LOT, help="lot id under seed/lots/")
    args = parser.parse_args(argv)

    settings = get_settings()
    if settings.app_env != "test":
        from parking_core.adapters.aws import ensure_resources

        ensure_resources(settings)
        print("Created table, bucket and queue")
    adapters = build_adapters(settings)
    image_path = FIXTURES_DIR / f"{args.lot}.jpg"
    image = image_path.read_bytes() if image_path.exists() else None
    result = seed_lot(adapters, load_lot_file(args.lot), image)
    print(result.summary())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
