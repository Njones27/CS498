"""Pilot benchmark for the ACPDS + YOLO26m scorer on labeled photos (detection plan p.6).

    uv run python eval/fetch_pklot_sample.py --count 30          # once: PKLot sample cache
    uv run python eval/benchmark.py eval/data/pklot \\
        --setup acpds --setup acpds_yolo --setup yolo \\
        [--overlap-mode box|box_lower_half|seg] [--outline-shift] [--json out.json] [--limit N]

Input: a directory of `<name>.jpg` + `<name>.xml` pairs in PKLot format (one `<space>` per
stall with `occupied="0|1"` and a `<contour>` in photo pixels). Pilot drone photos use the same
layout; see eval/README.md. Outlines are used as drawn (identity alignment, in frame).

Setups, all scored from one ACPDS pass and one YOLO pass per photo:

* `acpds`: ACPDS alone, `decide_state(score, None, ...)` with `require_car_check=False`.
* `acpds_yolo`: the production rule, `decide_state(score, overlap, ...)` with the settings'
  cutoffs (YOLO must agree before FREE; either model alone can say OCCUPIED).
* `yolo`: YOLO alone as a baseline. OCCUPIED if overlap >= the overlap cutoff, FREE if
  overlap <= the margin, UNKNOWN in between.

Metrics per setup: false-free rate (truly occupied reported FREE / truly occupied; NFR-3 pass
mark 5% or less), accuracy with UNKNOWN counted wrong (NFR-4, 90% or more), UNKNOWN rate
(NFR-11 suggested cap 10%) split into "ACPDS in-between" (low <= score <= high) and "box spill"
(score < low but margin < overlap < overlap cutoff), latency per photo (scoring only: decode
plus the models the setup needs, plus the overlap geometry when YOLO is used), model load
time (plus an untimed first-photo warm-up), and peak RSS of this process. Plus a cutoff
sweep and, with --outline-shift, how often ACPDS's call (score > 0.5) flips when every
outline moves right by 5/10/20/30% of its width.

Default cutoffs are never changed here; the sweep only reports what other cutoffs would do.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import resource
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for pkg in ("core", "worker"):  # don't depend on uv's editable .pth files (macOS hides them)
    sys.path.insert(0, str(ROOT / pkg))

import numpy as np  # noqa: E402
from parking_core.models import AlignedOutline, Cutoffs, SpaceState  # noqa: E402
from parking_core.settings import Settings  # noqa: E402
from parking_core.state_rules import decide_state  # noqa: E402
from parking_worker.scorers.acpds_yolo import (  # noqa: E402
    AcpdsYoloScorer,
    car_overlaps,
    decode_photo,
)

SETUPS = ("acpds", "acpds_yolo", "yolo")
SWEEP_LOW = (0.2, 0.3, 0.4)
SWEEP_HIGH = (0.6, 0.7, 0.8)
SHIFTS = (0.05, 0.10, 0.20, 0.30)


@dataclass
class Space:
    photo: str
    source: str
    space_id: str
    occupied: bool
    acpds: float
    overlap: float


@dataclass
class Timing:
    decode: list[float] = field(default_factory=list)
    acpds: list[float] = field(default_factory=list)
    yolo: list[float] = field(default_factory=list)  # detector + overlap geometry

    def per_photo(self, setup: str) -> list[float]:
        parts = {
            "acpds": (self.decode, self.acpds),
            "yolo": (self.decode, self.yolo),
            "acpds_yolo": (self.decode, self.acpds, self.yolo),
        }[setup]
        return [sum(p) for p in zip(*parts, strict=True)]


# --- data ------------------------------------------------------------------------------------


def load_pairs(data_dir: Path, limit: int | None) -> list[tuple[Path, Path]]:
    pairs = [(x.with_suffix(".jpg"), x) for x in sorted(data_dir.glob("*.xml"))]
    pairs = [(j, x) for j, x in pairs if j.is_file()]
    return pairs[:limit] if limit else pairs


def read_labels(
    xml: Path, width: int, height: int
) -> tuple[str, list[tuple[AlignedOutline, bool]]]:
    root = ET.parse(xml).getroot()
    out = []
    for sp in root.iter("space"):
        pts = [(float(p.get("x")), float(p.get("y"))) for p in sp.findall("./contour/point")]
        if len(pts) < 3 or sp.get("occupied") not in ("0", "1"):
            continue  # unlabeled: a human cannot judge it, so it is not scored
        polygon = [(x / width, y / height) for x, y in pts]
        out.append(
            (
                AlignedOutline(space_id=f"pk-{sp.get('id')}", polygon=polygon),
                sp.get("occupied") == "1",
            )
        )
    return root.get("id", "unknown"), out


def shifted(outline: AlignedOutline, fraction: float) -> AlignedOutline:
    xs = [x for x, _ in outline.polygon]
    dx = (max(xs) - min(xs)) * fraction
    return outline.model_copy(update={"polygon": [(x + dx, y) for x, y in outline.polygon]})


# --- states and metrics ----------------------------------------------------------------------


def state_for(setup: str, s: Space, cutoffs: Cutoffs) -> SpaceState:
    if setup == "acpds":
        return decide_state(
            s.acpds, None, True, cutoffs.model_copy(update={"require_car_check": False})
        )
    if setup == "acpds_yolo":
        return decide_state(s.acpds, s.overlap, True, cutoffs)
    if s.overlap >= cutoffs.overlap:
        return SpaceState.OCCUPIED
    if s.overlap <= cutoffs.margin:
        return SpaceState.FREE
    return SpaceState.UNKNOWN


def unknown_cause(setup: str, s: Space, cutoffs: Cutoffs) -> str:
    if setup != "yolo" and cutoffs.low <= s.acpds <= cutoffs.high:
        return "acpds_in_between"
    if setup != "acpds" and cutoffs.margin < s.overlap < cutoffs.overlap:
        return "box_spill"
    return "other"


def metrics(setup: str, spaces: list[Space], cutoffs: Cutoffs) -> dict:
    confusion: dict[str, Counter] = {"occupied": Counter(), "empty": Counter()}
    causes: Counter = Counter()
    correct = 0
    for s in spaces:
        state = state_for(setup, s, cutoffs)
        confusion["occupied" if s.occupied else "empty"][state.value] += 1
        if state == SpaceState.UNKNOWN:
            causes[unknown_cause(setup, s, cutoffs)] += 1
        correct += (state == SpaceState.OCCUPIED) if s.occupied else (state == SpaceState.FREE)
    n = len(spaces)
    n_occ = sum(s.occupied for s in spaces)
    unknown = sum(c["UNKNOWN"] for c in confusion.values())
    return {
        "spaces": n,
        "false_free_rate": confusion["occupied"]["FREE"] / n_occ if n_occ else None,
        "accuracy": correct / n if n else None,
        "unknown_rate": unknown / n if n else None,
        "unknown_acpds_in_between": causes["acpds_in_between"] / n if n else None,
        "unknown_box_spill": causes["box_spill"] / n if n else None,
        "unknown_other": causes["other"] / n if n else None,
        "confusion": {truth: dict(c) for truth, c in confusion.items()},
    }


def percentile(values: list[float], q: float) -> float:
    return float(np.percentile(values, q)) if values else float("nan")


def peak_rss_bytes() -> int:
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return rss if sys.platform == "darwin" else rss * 1024  # macOS: bytes, Linux: KiB


# --- environment header ----------------------------------------------------------------------


def _sysctl(name: str) -> str | None:
    try:
        return subprocess.run(
            ["sysctl", "-n", name], capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def hardware() -> dict:
    cpu = (
        _sysctl("machdep.cpu.brand_string") if sys.platform == "darwin" else None
    ) or platform.processor()
    if sys.platform.startswith("linux"):
        try:
            for line in Path("/proc/cpuinfo").read_text().splitlines():
                if line.startswith("model name"):
                    cpu = line.split(":", 1)[1].strip()
                    break
        except OSError:
            pass
    ram = None
    if sys.platform == "darwin":
        mem = _sysctl("hw.memsize")
        ram = int(mem) if mem and mem.isdigit() else None
    else:
        try:
            ram = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
        except (ValueError, OSError):
            ram = None
    import cv2
    import torch
    import ultralytics

    return {
        "cpu": cpu or "unknown",
        "cpu_count": os.cpu_count(),
        "ram_gb": round(ram / 2**30, 1) if ram else None,
        "os": platform.platform(),
        "python": platform.python_version(),
        "torch": torch.__version__,
        "torch_threads": torch.get_num_threads(),
        "ultralytics": ultralytics.__version__,
        "opencv": cv2.__version__,
    }


def model_hashes(settings: Settings) -> dict:
    manifest = json.loads((Path(settings.models_dir) / "manifest.json").read_text())
    yolo = (
        settings.yolo_seg_weights if settings.yolo_overlap_mode == "seg" else settings.yolo_weights
    )
    acpds = settings.acpds_weights
    return {
        "acpds": f"{acpds} sha256:{manifest[acpds]['sha256'][:12]}",
        "yolo": f"{yolo} sha256:{manifest[yolo]['sha256'][:12]}",
    }


# --- run -------------------------------------------------------------------------------------


def run(args: argparse.Namespace) -> dict:
    setups = args.setup or list(SETUPS)
    settings = Settings(
        _env_file=None,
        detector="acpds_yolo",
        models_dir=str(ROOT / "models"),
        yolo_overlap_mode=args.overlap_mode,
    )
    cutoffs = settings.cutoffs
    t0 = time.perf_counter()
    scorer = AcpdsYoloScorer.from_settings(settings)
    load_ms = (time.perf_counter() - t0) * 1000

    pairs = load_pairs(args.data_dir, args.limit)
    if not pairs:
        raise SystemExit(f"No .jpg + .xml pairs in {args.data_dir}")
    # Warm-up on the first photo: the first forward pass pays one-off allocator and kernel
    # setup costs that a long-running worker pays once, so it is reported but not timed.
    bgr = decode_photo(pairs[0][0].read_bytes())
    warm = [o for o, _ in read_labels(pairs[0][1], bgr.shape[1], bgr.shape[0])[1]]
    t0 = time.perf_counter()
    scorer.acpds_scores(bgr, warm)
    scorer.car_detector(bgr)
    warmup_ms = (time.perf_counter() - t0) * 1000
    spaces: list[Space] = []
    timing = Timing()
    flips: dict[float, list[int]] = defaultdict(lambda: [0, 0])  # shift -> [flipped, total]
    photos_by_source: Counter = Counter()
    for jpg, xml in pairs:
        t = time.perf_counter()
        bgr = decode_photo(jpg.read_bytes())
        timing.decode.append((time.perf_counter() - t) * 1000)
        height, width = bgr.shape[:2]
        source, labeled = read_labels(xml, width, height)
        outlines = [o for o, _ in labeled]
        photos_by_source[source] += 1

        t = time.perf_counter()
        acpds = scorer.acpds_scores(bgr, outlines)
        timing.acpds.append((time.perf_counter() - t) * 1000)
        t = time.perf_counter()
        overlaps = car_overlaps(
            outlines, scorer.car_detector(bgr), width, height, scorer.overlap_mode, scorer.yolo_conf
        )
        timing.yolo.append((time.perf_counter() - t) * 1000)

        for (o, occupied), a, v in zip(labeled, acpds, overlaps, strict=True):
            spaces.append(Space(jpg.stem, source, o.space_id, occupied, float(a), float(v)))
        if args.outline_shift:
            base = acpds > 0.5
            for shift in SHIFTS:
                moved = scorer.acpds_scores(bgr, [shifted(o, shift) for o in outlines]) > 0.5
                flips[shift][0] += int(np.count_nonzero(moved != base))
                flips[shift][1] += len(outlines)

    results = {}
    for setup in setups:
        m = metrics(setup, spaces, cutoffs)
        lat = timing.per_photo(setup)
        m["latency_ms_p50"] = percentile(lat, 50)
        m["latency_ms_p95"] = percentile(lat, 95)
        m["by_source"] = {
            src: metrics(setup, [s for s in spaces if s.source == src], cutoffs)
            for src in sorted({s.source for s in spaces})
        }
        results[setup] = m

    sweep = {}
    for setup in [s for s in setups if s in ("acpds", "acpds_yolo")]:
        rows = []
        for low in SWEEP_LOW:
            for high in SWEEP_HIGH:
                c = cutoffs.model_copy(update={"low": low, "high": high})
                m = metrics(setup, spaces, c)
                rows.append(
                    {
                        "low": low,
                        "high": high,
                        **{k: m[k] for k in ("false_free_rate", "accuracy", "unknown_rate")},
                    }
                )
        sweep[setup] = rows

    return {
        "data_dir": str(args.data_dir),
        "overlap_mode": args.overlap_mode,
        "sample": {
            "photos": len(pairs),
            "spaces": len(spaces),
            "occupied": sum(s.occupied for s in spaces),
            "photos_by_source": dict(sorted(photos_by_source.items())),
        },
        "hardware": hardware(),
        "models": model_hashes(settings),
        "model_version": scorer.model_version,
        "cutoffs": cutoffs.model_dump(),
        "model_load_ms": load_ms,
        "warmup_ms": warmup_ms,
        "peak_rss_mb": peak_rss_bytes() / 2**20,
        "setups": results,
        "sweep": sweep,
        "outline_shift": {f"{int(k * 100)}%": v[0] / v[1] for k, v in sorted(flips.items()) if v[1]}
        or None,
    }


# --- report ----------------------------------------------------------------------------------


def pct(v: float | None) -> str:
    return "n/a" if v is None else f"{100 * v:.1f}%"


def mark(v: float | None, ok) -> str:
    return "" if v is None else (" ✓" if ok(v) else " ✗")


def markdown(r: dict) -> str:
    hw, sample, c = r["hardware"], r["sample"], r["cutoffs"]
    by_src = ", ".join(f"{k} {v}" for k, v in sample["photos_by_source"].items())
    lines = [
        f"## Benchmark: overlap mode `{r['overlap_mode']}`",
        "",
        f"- Sample: {sample['photos']} photos ({by_src}), {sample['spaces']} labeled spaces, "
        f"{sample['occupied']} occupied ({r['data_dir']})",
        f"- Hardware: {hw['cpu']}, {hw['cpu_count']} logical CPUs, {hw['ram_gb']} GB RAM; "
        f"{hw['os']}",
        f"- Software: Python {hw['python']}, torch {hw['torch']} ({hw['torch_threads']} threads), "
        f"ultralytics {hw['ultralytics']}, OpenCV {hw['opencv']}",
        f"- Models: {r['models']['acpds']}; {r['models']['yolo']}",
        f"- Cutoffs: low {c['low']}, high {c['high']}, overlap {c['overlap']}, "
        f"margin {c['margin']}",
        f"- Model load {r['model_load_ms']:.0f} ms; first-photo warm-up {r['warmup_ms']:.0f} ms "
        f"(not in latency); peak RSS {r['peak_rss_mb']:.0f} MB",
        "",
        "| Setup | False-free (≤5%) | Accuracy (≥90%) | UNKNOWN (≤10%) | ACPDS in-between "
        "| Box spill | p50 ms | p95 ms | Occupied → F/O/U | Empty → F/O/U |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for setup, m in r["setups"].items():
        occ, emp = m["confusion"]["occupied"], m["confusion"]["empty"]
        fou = lambda d: f"{d.get('FREE', 0)}/{d.get('OCCUPIED', 0)}/{d.get('UNKNOWN', 0)}"  # noqa: E731
        lines.append(
            f"| {setup} "
            f"| {pct(m['false_free_rate'])}{mark(m['false_free_rate'], lambda v: v <= 0.05)} "
            f"| {pct(m['accuracy'])}{mark(m['accuracy'], lambda v: v >= 0.90)} "
            f"| {pct(m['unknown_rate'])}{mark(m['unknown_rate'], lambda v: v <= 0.10)} "
            f"| {pct(m['unknown_acpds_in_between'])} | {pct(m['unknown_box_spill'])} "
            f"| {m['latency_ms_p50']:.0f} | {m['latency_ms_p95']:.0f} | {fou(occ)} | {fou(emp)} |"
        )
    lines += [
        "",
        "Per camera (false-free / accuracy / UNKNOWN):",
        "",
        "| Setup | " + " | ".join(next(iter(r["setups"].values()))["by_source"]) + " |",
        "|---|" + "---|" * len(next(iter(r["setups"].values()))["by_source"]),
    ]
    for setup, m in r["setups"].items():
        cells = [
            f"{pct(s['false_free_rate'])} / {pct(s['accuracy'])} / {pct(s['unknown_rate'])}"
            for s in m["by_source"].values()
        ]
        lines.append(f"| {setup} | " + " | ".join(cells) + " |")
    for setup, rows in r["sweep"].items():
        lines += [
            "",
            f"Cutoff sweep, `{setup}` (false-free / accuracy / UNKNOWN):",
            "",
            "| low \\ high | " + " | ".join(str(h) for h in SWEEP_HIGH) + " |",
            "|---|" + "---|" * len(SWEEP_HIGH),
        ]
        for low in SWEEP_LOW:
            cells = [
                f"{pct(x['false_free_rate'])} / {pct(x['accuracy'])} / {pct(x['unknown_rate'])}"
                for x in rows
                if x["low"] == low
            ]
            lines.append(f"| {low} | " + " | ".join(cells) + " |")
    if r["outline_shift"]:
        lines += [
            "",
            "Outline shift (ACPDS call at 0.5 flips vs. unshifted):",
            "",
            "| Shift (% of stall width, +x) | " + " | ".join(r["outline_shift"]) + " |",
            "|---|" + "---|" * len(r["outline_shift"]),
            "| Flipped | " + " | ".join(pct(v) for v in r["outline_shift"].values()) + " |",
        ]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("data_dir", type=Path)
    p.add_argument("--setup", action="append", choices=SETUPS, help="repeatable; default all three")
    p.add_argument("--overlap-mode", choices=("box", "box_lower_half", "seg"), default="box")
    p.add_argument("--outline-shift", action="store_true")
    p.add_argument("--json", type=Path, help="also write the full results as JSON")
    p.add_argument("--limit", type=int, help="score only the first N photos")
    args = p.parse_args(argv)
    result = run(args)
    report = markdown(result)
    print(report)
    if args.json:
        args.json.write_text(json.dumps(result, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
