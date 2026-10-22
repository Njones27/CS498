"""Convert a PKLot image + XML pair into seed/lots/<lot-id>.json.

uv run python seed/import_pklot.py IMAGE XML --lot-id pklot-ufpr04 --name "UFPR04"
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from parking_seed.loader import LOTS_DIR
from parking_seed.pklot import build_lot
from PIL import Image


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("image", type=Path)
    p.add_argument("xml", type=Path)
    p.add_argument("--lot-id", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--out", type=Path, default=None)
    args = p.parse_args(argv)
    with Image.open(args.image) as im:
        size = im.size
    lot = build_lot(args.xml.read_text(), size, args.lot_id, args.name)
    out = args.out or LOTS_DIR / f"{args.lot_id}.json"
    out.write_text(json.dumps(lot, indent=2) + "\n")
    print(f"Wrote {out} with {len(lot['spaces'])} spaces")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
