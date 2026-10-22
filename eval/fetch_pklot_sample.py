"""Download a small, mixed PKLot sample as image + XML pairs for the benchmark.

    uv run python eval/fetch_pklot_sample.py --count 30 [--out eval/data/pklot] [--prefer ufpr04]
        [--revision main]

Source: the Hugging Face mirror Voxel51/PKLot (CC BY 4.0, no login), a FiftyOne export whose
`samples.json` (~267 MB, `{"samples": [{...}, ...]}`) holds every photo's labels. That file is
sorted by camera (pucpr, ufpr04, ufpr05) and then weather, so reading it from the start would
return one camera in one weather. Instead the script reads ~2 MB windows spread evenly across
the file with HTTP Range requests, parses the complete sample objects inside each window, and
picks samples round-robin over (source, weather) so every combination is represented.

For each picked sample it writes `<source>_<timestamp>.jpg` and a PKLot-format `.xml` that
`seed/parking_seed/pklot.py` reads (pixel coordinates, `occupied="0|1"`). Existing pairs are
kept, so reruns only fetch what is missing. Stdlib only; certifi's CA bundle is used when it is
installed (uv's standalone Python on macOS has no system CA store).

Downloaded data is untrusted: it is parsed with json / ElementTree only, file paths are
checked against a strict pattern, and nothing from it is executed.
"""

from __future__ import annotations

import argparse
import itertools
import json
import re
import ssl
import sys
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO_URL = "https://huggingface.co/datasets/Voxel51/PKLot/resolve/"
SAFE_REVISION = re.compile(r"^[A-Za-z0-9._-]{1,64}$")  # branch, tag or commit SHA
CHUNK = 2 * 1024 * 1024
WINDOWS = 24
SAMPLE_START = re.compile(r'\{"_id": \{"\$oid": "[0-9a-f]{24}"\}, "filepath": ')
SAFE_FILEPATH = re.compile(r"^data/[A-Za-z0-9_]+/[A-Za-z0-9_.-]+\.jpg$")
SAFE_WORD = re.compile(r"^[a-z0-9]+$")
USER_AGENT = "cs498-parking-eval/1"


def ssl_context() -> ssl.SSLContext:
    try:
        import certifi
    except ImportError:
        return ssl.create_default_context()
    return ssl.create_default_context(cafile=certifi.where())


def http_get(url: str, byte_range: tuple[int, int] | None = None) -> tuple[bytes, dict]:
    headers = {"User-Agent": USER_AGENT}
    if byte_range is not None:
        headers["Range"] = f"bytes={byte_range[0]}-{byte_range[1]}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=60, context=ssl_context()) as resp:
        if byte_range is not None and resp.status != 206:
            raise RuntimeError(f"{url}: server ignored the Range request")
        return resp.read(), dict(resp.headers)


def total_size(url: str) -> int:
    _, headers = http_get(url, (0, 0))
    content_range = {k.lower(): v for k, v in headers.items()}.get("content-range", "")
    match = re.fullmatch(r"bytes 0-0/(\d+)", content_range.strip())
    if not match:
        raise RuntimeError(f"unexpected Content-Range {content_range!r}")
    return int(match.group(1))


def parse_window(text: str) -> list[dict]:
    """Every complete sample object in a window of samples.json (partial ones are skipped)."""
    decoder = json.JSONDecoder()
    out = []
    for match in SAMPLE_START.finditer(text):
        try:
            sample, _ = decoder.raw_decode(text, match.start())
        except json.JSONDecodeError:
            continue  # cut off by the window edge
        if isinstance(sample, dict):
            out.append(sample)
    return out


def sample_key(sample: dict) -> tuple[str, str] | None:
    """(source, weather) for a well-formed sample, else None."""
    filepath = sample.get("filepath")
    source = sample.get("source")
    weather = (sample.get("weather") or {}).get("label")
    if not (isinstance(filepath, str) and SAFE_FILEPATH.fullmatch(filepath)):
        return None
    if not all(isinstance(v, str) and SAFE_WORD.fullmatch(v) for v in (source, weather)):
        return None
    if not isinstance((sample.get("parking_spaces") or {}).get("polylines"), list):
        return None
    return source, weather


def stem_of(sample: dict) -> str:
    return f"{sample['source']}_{Path(sample['filepath']).stem}"


def pick_round_robin(windows: list[list[dict]], count: int, prefer: str | None) -> list[dict]:
    """Round-robin over (source, weather) in order of appearance; the `prefer` source first.

    Within a group, the first sample of every window comes before the second of any, so picks
    are spread over the file (neighbouring samples are minutes apart on the same camera).
    """
    ranked = [(rank, w, s) for w, found in enumerate(windows) for rank, s in enumerate(found)]
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    seen: set[str] = set()
    for _, _, sample in sorted(ranked, key=lambda t: (t[0], t[1])):
        key = sample_key(sample)
        if key is None or stem_of(sample) in seen:
            continue
        seen.add(stem_of(sample))
        groups[key].append(sample)
    first_seen = {sample_key(s): i for i, (_, _, s) in reversed(list(enumerate(ranked)))}
    keys = sorted(groups, key=lambda k: (k[0] != prefer, first_seen[k]))
    picked: list[dict] = []
    for round_ in itertools.count():
        progressed = False
        for key in keys:
            if len(picked) == count:
                return picked
            if round_ < len(groups[key]):
                picked.append(groups[key][round_])
                progressed = True
        if not progressed:
            return picked
    return picked


def jpeg_size(data: bytes) -> tuple[int, int]:
    """(width, height) from a JPEG's SOF marker."""
    if data[:2] != b"\xff\xd8":
        raise ValueError("not a JPEG")
    i = 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            raise ValueError("bad JPEG marker")
        marker = data[i + 1]
        i += 2
        if marker == 0xFF:
            i -= 1  # fill byte
            continue
        if marker in (0x01, 0xD8) or 0xD0 <= marker <= 0xD7:
            continue
        seg_len = int.from_bytes(data[i : i + 2], "big")
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height = int.from_bytes(data[i + 3 : i + 5], "big")
            width = int.from_bytes(data[i + 5 : i + 7], "big")
            return width, height
        i += seg_len
    raise ValueError("no SOF marker")


def centroid(points: list[tuple[float, float]]) -> tuple[float, float]:
    area = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1], strict=True):
        cross = x0 * y1 - x1 * y0
        area += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if abs(area) < 1e-9:
        return sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points)
    return cx / (3 * area), cy / (3 * area)


def pklot_xml(sample: dict, width: int, height: int) -> str:
    """PKLot-format annotation in photo pixels (what seed/parking_seed/pklot.py parses)."""
    root = ET.Element("parking", id=sample["source"])
    for poly in sample["parking_spaces"]["polylines"]:
        if not isinstance(poly, dict):
            continue
        status = poly.get("occupancy_status")
        rings = poly.get("points") or []
        if status not in ("occupied", "not occupied") or not rings or len(rings[0]) < 3:
            continue
        try:
            pts = [(float(x) * width, float(y) * height) for x, y in rings[0]]
            space_id = int(poly.get("space_id", poly.get("index")))
        except (TypeError, ValueError):
            continue
        cx, cy = centroid(pts)
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        space = ET.SubElement(
            root, "space", id=str(space_id), occupied="1" if status == "occupied" else "0"
        )
        rect = ET.SubElement(space, "rotatedRect")
        ET.SubElement(rect, "center", x=str(round(cx)), y=str(round(cy)))
        ET.SubElement(
            rect, "size", w=str(round(max(xs) - min(xs))), h=str(round(max(ys) - min(ys)))
        )
        ET.SubElement(rect, "angle", d="0")
        contour = ET.SubElement(space, "contour")
        for x, y in pts:
            ET.SubElement(contour, "point", x=str(round(x)), y=str(round(y)))
    ET.indent(root, space="  ")
    return '<?xml version="1.0"?>\n' + ET.tostring(root, encoding="unicode") + "\n"


def collect_windows(samples_url: str, count: int) -> list[list[dict]]:
    size = total_size(samples_url)
    windows = max(WINDOWS, count)
    candidates: list[list[dict]] = []
    for i in range(windows):
        start = min(size - 1, i * size // windows)
        data, _ = http_get(samples_url, (start, min(size - 1, start + CHUNK - 1)))
        found = parse_window(data.decode("utf-8", errors="replace"))
        candidates.append(found)
        print(f"  window {i + 1}/{windows} @ {start / 1e6:6.1f} MB: {len(found)} samples")
    return candidates


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--count", type=int, default=30)
    p.add_argument("--out", type=Path, default=ROOT / "eval" / "data" / "pklot")
    p.add_argument("--prefer", default="ufpr04", help="source listed first (fixture candidate)")
    p.add_argument("--revision", default="main", help="dataset branch, tag or commit SHA")
    args = p.parse_args(argv)
    if args.count < 1:
        p.error("--count must be positive")
    if not SAFE_REVISION.fullmatch(args.revision):
        p.error("--revision must be a branch, tag or commit SHA")
    base = f"{REPO_URL}{args.revision}/"
    samples_url = base + "samples.json"

    print(f"Reading {samples_url} in {CHUNK // (1024 * 1024)} MB windows")
    picked = pick_round_robin(collect_windows(samples_url, args.count), args.count, args.prefer)
    args.out.mkdir(parents=True, exist_ok=True)
    mix: dict[tuple[str, str], int] = defaultdict(int)
    written = 0
    for sample in picked:
        stem = stem_of(sample)
        jpg, xml = args.out / f"{stem}.jpg", args.out / f"{stem}.xml"
        if not (jpg.is_file() and xml.is_file()):
            try:
                data, _ = http_get(base + sample["filepath"])
                width, height = jpeg_size(data)
                xml_text = pklot_xml(sample, width, height)
            except (ValueError, TypeError, AttributeError, KeyError, IndexError) as exc:
                print(f"  warning: skipping malformed sample {stem}: {exc}", file=sys.stderr)
                continue
            jpg.write_bytes(data)
            xml.write_text(xml_text)
            print(f"  {stem}: {width}x{height}, {xml_text.count('<space ')} spaces")
        mix[sample_key(sample)] += 1
        written += 1

    print(f"\n{written} pairs in {args.out}")
    for (source, weather), n in sorted(mix.items()):
        print(f"  {source:7s} {weather:7s} {n}")
    if picked:
        print(f"Fixture candidate: {stem_of(picked[0])}")
    return 0 if written == args.count else 1


if __name__ == "__main__":
    sys.exit(main())
