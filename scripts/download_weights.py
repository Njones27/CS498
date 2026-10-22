"""Download the pinned model weights listed in models/manifest.json and verify them.

    uv run python scripts/download_weights.py              # fetch what is missing, verify all
    uv run python scripts/download_weights.py --check      # verify only, never download
    uv run python scripts/download_weights.py --only yolo26m

Each manifest entry is keyed by its path under models/ and pins a SHA-256 and a size. Entries
with "urls" are fetched over HTTPS, trying each URL in order. Entries with "via": "ultralytics"
are fetched with Ultralytics' own asset downloader (needs the worker's `vision` extra). A file
that is present but does not match its pin is never trusted: without --check it is downloaded
again, with --check the script fails. Exit status is 0 only when every selected file matches.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import ssl
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODELS_DIR = ROOT / "models"
CHUNK = 1 << 20


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while block := fh.read(CHUNK):
            digest.update(block)
    return digest.hexdigest()


def matches(path: Path, entry: dict) -> bool:
    return (
        path.is_file()
        and path.stat().st_size == entry["size"]
        and sha256_of(path) == entry["sha256"]
    )


def ssl_context() -> ssl.SSLContext:
    """Prefer certifi's CA bundle: uv's standalone Python on macOS has no system CA store."""
    try:
        import certifi
    except ImportError:
        return ssl.create_default_context()
    return ssl.create_default_context(cafile=certifi.where())


def fetch_url(url: str, dest: Path, entry: dict) -> None:
    """Stream `url` into dest.part, hashing as it goes; move it into place only if it matches.

    Never reads more than the pinned size (+1 byte to notice an oversized file), and a failed
    or mismatched download leaves nothing behind.
    """
    if not url.startswith("https://"):
        raise ValueError(f"refusing non-HTTPS URL {url}")
    part = dest.with_name(dest.name + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "cs498-parking-weights/1"})
    digest, received = hashlib.sha256(), 0
    try:
        with (
            urllib.request.urlopen(req, timeout=60, context=ssl_context()) as resp,
            part.open("wb") as out,
        ):
            while received <= entry["size"]:
                block = resp.read(min(CHUNK, entry["size"] + 1 - received))
                if not block:
                    break
                digest.update(block)
                out.write(block)
                received += len(block)
        if received != entry["size"] or digest.hexdigest() != entry["sha256"]:
            raise ValueError(f"SHA-256 or size mismatch ({received:,} bytes)")
        os.replace(part, dest)
    finally:
        part.unlink(missing_ok=True)


def fetch_ultralytics(name: str, entry: dict, dest: Path) -> None:
    try:
        from ultralytics.utils.downloads import attempt_download_asset
    except ImportError as exc:
        raise RuntimeError(
            "ultralytics is not installed; run `uv sync --all-packages --extra vision` first"
        ) from exc
    got = Path(attempt_download_asset(str(dest), release=entry.get("release", "v8.4.0")))
    if got.resolve() != dest.resolve() and got.is_file():  # found in Ultralytics' weights_dir
        dest.write_bytes(got.read_bytes())


def download(name: str, entry: dict, dest: Path) -> str | None:
    """Fetch one entry. Returns None on success or a reason string on failure."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if entry.get("via") == "ultralytics":
        sources = ["ultralytics"]
    else:
        sources = list(entry.get("urls", []))
    reasons = []
    for source in sources:
        dest.unlink(missing_ok=True)
        try:
            if source == "ultralytics":
                fetch_ultralytics(name, entry, dest)
            else:
                fetch_url(source, dest, entry)
        except Exception as exc:  # network, HTTP, missing package: try the next source
            reasons.append(f"{source}: {exc}")
            continue
        if matches(dest, entry):
            return None
        reasons.append(f"{source}: SHA-256 or size mismatch")
    dest.unlink(missing_ok=True)
    return "; ".join(reasons) or "no download source in the manifest"


def check_manifest(manifest: object) -> dict:
    """Entries must be relative paths inside models/ with a sha256 and a size."""
    if not isinstance(manifest, dict):
        raise SystemExit("models/manifest.json must be an object keyed by relative path")
    for name, entry in manifest.items():
        path = Path(name)
        if path.is_absolute() or ".." in path.parts or not path.parts:
            raise SystemExit(f"manifest key {name!r} must be a relative path inside models/")
        if not (
            isinstance(entry, dict)
            and isinstance(entry.get("sha256"), str)
            and isinstance(entry.get("size"), int)
        ):
            raise SystemExit(f"manifest entry {name!r} needs a sha256 string and an integer size")
    return manifest


def select(manifest: dict, only: list[str]) -> dict:
    if not only:
        return manifest
    picked = {}
    for want in only:
        hits = [k for k in manifest if want in (k, Path(k).name, Path(k).stem)]
        if not hits:
            raise SystemExit(f"--only {want}: no such manifest entry ({', '.join(manifest)})")
        picked.update({k: manifest[k] for k in hits})
    return picked


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--check", action="store_true", help="verify only; never download")
    p.add_argument(
        "--only",
        action="append",
        default=[],
        metavar="NAME",
        help="manifest key, file name or stem (repeatable)",
    )
    p.add_argument("--models-dir", type=Path, default=DEFAULT_MODELS_DIR)
    args = p.parse_args(argv)

    manifest = check_manifest(json.loads((args.models_dir / "manifest.json").read_text()))
    rows, failures = [], []
    for name, entry in select(manifest, args.only).items():
        dest = args.models_dir / name
        if matches(dest, entry):
            status = "ok"
        elif args.check:
            status = "MISMATCH" if dest.exists() else "MISSING"
        else:
            reason = download(name, entry, dest)
            status = "downloaded" if reason is None else "FAILED"
            if reason is not None:
                failures.append(f"{name}: {reason}")
        if status not in ("ok", "downloaded", "FAILED"):
            failures.append(f"{name}: {status.lower()}")
        rows.append((name, f"{entry['size']:,}", entry["sha256"][:16], status))

    headers = ("file", "bytes", "sha256 (16)", "status")
    widths = [max(len(r[i]) for r in [headers, *rows]) for i in range(4)]
    for row in [headers, tuple("-" * w for w in widths), *rows]:
        print("  ".join(cell.ljust(w) for cell, w in zip(row, widths, strict=True)).rstrip())
    sys.stdout.flush()
    if failures:
        print("\nSome weights are missing or do not match models/manifest.json:", file=sys.stderr)
        for line in failures:
            print(f"  {line}", file=sys.stderr)
        if args.check:
            print("Run: uv run python scripts/download_weights.py", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
