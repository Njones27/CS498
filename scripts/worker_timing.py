"""NFR-1 timing: worker processing time per photo, p95 <= 30 s in a 2-CPU, 4 GB container.

    # host (vision extra + weights):
    MODELS_DIR=models uv run python scripts/worker_timing.py --jobs-per-lot 3
    # the vision image, as CI runs it (see models/README.md):
    docker run --rm --cpus=2 --memory=4g --memory-swap=4g \\
        -v "$PWD:/repo:ro" -v "$PWD/models:/app/models:ro" \\
        parking-worker:vision python /repo/scripts/worker_timing.py

Seeds each lot (seed/lots/<lot>.json, reference photo eval/fixtures/<lot>.jpg) on the in-memory
adapters, then times real worker jobs end to end through `poller.run_once`: receive, claim,
layout load, photo fetch, alignment (ALIGNER=orb), scoring (DETECTOR=acpds_yolo), observation
and status writes, COMPLETE. Each job's photo is the lot's reference shifted by a few pixels and
re-encoded, so every job has its own image id and bytes and ORB still has to match it.

Model load (SHA-256 check + load) and one untimed warm-up job per lot (first forward pass,
ORB reference features) are reported apart from the per-job numbers, which is what a
long-running worker pays per photo. The gate is the p95 of per-job wall time over all lots.
Storage, queue and DB are in memory, so S3/SQS/DynamoDB round trips are not included.

Exit status: 0 when p95 <= --limit-s, 1 when it is over, 2 when the run itself failed (missing
weights, a job that did not complete, an unknown lot). --markdown is written in every case,
so a CI job summary always says what happened.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import logging
import math
import os
import platform
import resource
import sys
import time
import traceback
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Add a workspace package only if it is not importable, so inside the image the INSTALLED
# core/worker are timed and only seed comes from the read-only /repo mount. On the host this
# also covers uv's editable .pth files, which Python skips when macOS marks them hidden.
for _pkg in ("core", "worker", "seed"):
    if importlib.util.find_spec(f"parking_{_pkg}") is None:
        sys.path.insert(0, str(ROOT / _pkg))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from parking_core.interfaces import Aligner, SpaceScorer  # noqa: E402
from parking_core.keys import raw_photo_key  # noqa: E402
from parking_core.models import Cutoffs, JobMessage, JobStatus, Snapshot  # noqa: E402
from parking_core.settings import Adapters, Settings, build_adapters  # noqa: E402
from parking_seed.loader import FIXTURES_DIR, load_lot_file, seed_lot  # noqa: E402
from parking_worker.aligners import build_aligner  # noqa: E402
from parking_worker.poller import run_once  # noqa: E402
from parking_worker.scorers import build_scorer  # noqa: E402

DEFAULT_LOTS = ("drone-lot", "pklot-ufpr04")
LIMIT_S = 30.0
DEFAULT_JOBS_PER_LOT = 10
T0 = datetime(2026, 11, 1, tzinfo=UTC)
UPLOADED_BY = "nfr1-timing"

EXIT_OK = 0
EXIT_OVER_LIMIT = 1
EXIT_ERROR = 2


class JobFailed(RuntimeError):
    """A timed job did not complete: the timing would be meaningless, so the run stops."""


@dataclass
class JobTiming:
    lot_id: str
    image_id: str
    wall_s: float
    """run_once from receive to delete, as seen by the poller."""
    processing_ms: int | None
    """What the handler records on the snapshot: everything after the claim."""
    spaces: int


@dataclass
class Report:
    jobs: list[JobTiming]
    model_load_s: float
    warmup_s: dict[str, float]
    """lot_id -> wall time of its first (untimed) job."""
    stalls: dict[str, int]
    """lot_id -> spaces in view of the timed viewpoint."""
    limit_s: float
    env: dict[str, object]

    @property
    def p95_s(self) -> float:
        return percentile([j.wall_s for j in self.jobs], 95)

    @property
    def passed(self) -> bool:
        return self.p95_s <= self.limit_s

    def lots(self) -> list[str]:
        return list(dict.fromkeys(j.lot_id for j in self.jobs))

    def wall(self, lot_id: str | None = None) -> dict[str, float]:
        return summarize([j.wall_s for j in self.jobs if lot_id in (None, j.lot_id)])

    def handler(self, lot_id: str | None = None) -> dict[str, float] | None:
        values = [
            j.processing_ms / 1000
            for j in self.jobs
            if lot_id in (None, j.lot_id) and j.processing_ms is not None
        ]
        return summarize(values) if values else None

    def to_json(self) -> dict:
        return {
            "p95_s": self.p95_s,
            "limit_s": self.limit_s,
            "passed": self.passed,
            "model_load_s": self.model_load_s,
            "warmup_s": self.warmup_s,
            "stalls": self.stalls,
            "wall_s": {"all": self.wall(), **{lot: self.wall(lot) for lot in self.lots()}},
            "processing_s": {
                "all": self.handler(),
                **{lot: self.handler(lot) for lot in self.lots()},
            },
            "env": self.env,
            "jobs": [asdict(j) for j in self.jobs],
        }


# --- stats -----------------------------------------------------------------------------------


def percentile(values: Sequence[float], q: float) -> float:
    """The q-th percentile (q in [0, 100]) with linear interpolation, as numpy's default."""
    if not values:
        raise ValueError("percentile of no values")
    if not 0 <= q <= 100:
        raise ValueError(f"percentile q must be in [0, 100], got {q}")
    ordered = sorted(values)
    rank = (len(ordered) - 1) * q / 100
    lo = math.floor(rank)
    hi = min(lo + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (rank - lo)


def summarize(values: Sequence[float]) -> dict[str, float]:
    return {
        "n": len(values),
        "mean": sum(values) / len(values),
        "p50": percentile(values, 50),
        "p95": percentile(values, 95),
        "max": max(values),
    }


# --- setup -----------------------------------------------------------------------------------


def build_settings(detector: str, aligner: str) -> Settings:
    """In-memory adapters whatever the environment says: init kwargs beat env vars, so an
    APP_ENV=aws left in the shell can never point this at AWS. MODELS_DIR, YOLO_* and the
    other worker settings still come from the environment, as they do for the poller."""
    return Settings(app_env="test", detector=detector, aligner=aligner, _env_file=None)  # type: ignore[call-arg]


def photo_variant(reference: bytes, i: int) -> bytes:
    """The reference photo shifted by a few pixels and re-encoded: deterministic, a different
    SHA-256 for each i, the same size, and still the same scene for ORB."""
    img = cv2.imdecode(np.frombuffer(reference, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("reference photo could not be decoded")
    dx, dy = i % 4, (i // 4) % 3
    shift = np.float32([[1, 0, dx], [0, 1, dy]])
    moved = cv2.warpAffine(
        img, shift, (img.shape[1], img.shape[0]), borderMode=cv2.BORDER_REPLICATE
    )
    ok, buf = cv2.imencode(".jpg", moved, [cv2.IMWRITE_JPEG_QUALITY, 88 + i % 7])
    if not ok:
        raise ValueError("photo could not be encoded")
    return buf.tobytes()


def seed_lots(adapters: Adapters, lots: Sequence[str]) -> dict[str, tuple[str, bytes, int, int]]:
    """Publish each lot as v1 with its fixture as the reference photo.

    Returns lot_id -> (first viewpoint, reference bytes, layout version, stalls in view)."""
    out = {}
    for lot_id in lots:
        data = load_lot_file(lot_id)
        reference = (FIXTURES_DIR / f"{lot_id}.jpg").read_bytes()
        result = seed_lot(adapters, data, reference)
        view = data["viewpoints"][0]
        out[lot_id] = (view["viewId"], reference, result.published_version, len(view["outlines"]))
    return out


# --- jobs ------------------------------------------------------------------------------------


def enqueue_job(
    adapters: Adapters,
    lot_id: str,
    view_id: str,
    image_id: str,
    data: bytes,
    capture_time: datetime,
    layout_version: int,
) -> None:
    """What upload completion leaves behind: the photo in storage, a QUEUED snapshot pinned to
    the lot's current layout version, and the job message (api/parking_api/jobs.py)."""
    key = raw_photo_key(lot_id, view_id, image_id)
    adapters.object_store.put(key, data, "image/jpeg")
    now = datetime.now(UTC)
    adapters.repository.put_snapshot(
        Snapshot(
            image_id=image_id,
            lot_id=lot_id,
            view_id=view_id,
            capture_time=capture_time,
            sha256=hashlib.sha256(data).hexdigest(),
            s3_key=key,
            content_type="image/jpeg",
            size_bytes=len(data),
            uploaded_by=UPLOADED_BY,
            job_status=JobStatus.QUEUED,
            layout_version=layout_version,
            created_at=now,
            queued_at=now,
        )
    )
    adapters.queue.send(JobMessage(image_id=image_id).model_dump_json())


def run_job(
    adapters: Adapters,
    aligner: Aligner,
    scorer: SpaceScorer,
    cutoffs: Cutoffs,
    *,
    lot_id: str,
    view_id: str,
    image_id: str,
    data: bytes,
    capture_time: datetime,
    layout_version: int,
    clock: Callable[[], float] = time.perf_counter,
) -> JobTiming:
    """Queue one photo and time the poller's handling of it (enqueueing is not timed)."""
    enqueue_job(adapters, lot_id, view_id, image_id, data, capture_time, layout_version)
    t0 = clock()
    result = run_once(adapters, aligner, scorer, cutoffs, wait_seconds=0)
    t1 = clock()
    if result is None or result.outcome != "completed":
        outcome = "no message" if result is None else f"{result.outcome} {result.error}"
        raise JobFailed(f"{image_id}: {outcome}")
    snapshot = adapters.repository.get_snapshot(image_id)
    return JobTiming(
        lot_id=lot_id,
        image_id=image_id,
        wall_s=t1 - t0,
        processing_ms=snapshot.processing_ms if snapshot else None,
        spaces=result.spaces_written,
    )


def time_jobs(
    adapters: Adapters,
    aligner: Aligner,
    scorer: SpaceScorer,
    cutoffs: Cutoffs,
    lots: dict[str, tuple[str, bytes, int, int]],
    jobs_per_lot: int,
    clock: Callable[[], float] = time.perf_counter,
) -> tuple[dict[str, float], list[JobTiming]]:
    """One untimed warm-up job per lot, then `jobs_per_lot` rounds over the lots.

    Capture times strictly increase, so every job's status writes go through."""
    seq = 0

    def job(lot_id: str, image_id: str, variant: int) -> JobTiming:
        nonlocal seq
        view_id, reference, version, _ = lots[lot_id]
        data = photo_variant(reference, variant)  # outside the timed span
        seq += 1
        return run_job(
            adapters,
            aligner,
            scorer,
            cutoffs,
            lot_id=lot_id,
            view_id=view_id,
            image_id=image_id,
            data=data,
            capture_time=T0 + timedelta(seconds=seq),
            layout_version=version,
            clock=clock,
        )

    warmup = {lot: job(lot, f"nfr1-{lot}-warmup", 0).wall_s for lot in lots}
    timings = [
        job(lot, f"nfr1-{lot}-{n:03d}", n) for n in range(1, jobs_per_lot + 1) for lot in lots
    ]
    return warmup, timings


# --- environment -----------------------------------------------------------------------------


def read_cgroup(path: Path) -> str | None:
    try:
        return path.read_text().strip()
    except OSError:
        return None


def _cgroup_cpus(raw: str | None) -> float | None:
    """cgroup v2 `cpu.max` is "<quota> <period>" in µs, or "max <period>" for no limit."""
    parts = (raw or "").split()
    if len(parts) != 2 or parts[0] == "max":
        return None
    try:
        return int(parts[0]) / int(parts[1])
    except (ValueError, ZeroDivisionError):
        return None


def _cgroup_bytes(raw: str | None) -> int | None:
    return int(raw) if raw and raw.isdigit() else None


def peak_rss_bytes() -> int:
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return rss if sys.platform == "darwin" else rss * 1024  # macOS: bytes, Linux: KiB


def environment(
    settings: Settings, scorer: SpaceScorer, cgroup_root: Path = Path("/sys/fs/cgroup")
) -> dict:
    env: dict[str, object] = {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "cpu_count": os.cpu_count(),
        "cpu_affinity": len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else None,
        "cgroup_cpus": _cgroup_cpus(read_cgroup(cgroup_root / "cpu.max")),
        "cgroup_memory_max": _cgroup_bytes(read_cgroup(cgroup_root / "memory.max")),
        "cgroup_memory_peak": _cgroup_bytes(read_cgroup(cgroup_root / "memory.peak")),
        "peak_rss": peak_rss_bytes(),
        "torch_threads": None,
        "detector": settings.detector,
        "aligner": settings.aligner,
        "yolo_imgsz": settings.yolo_imgsz,
        "yolo_overlap_mode": settings.yolo_overlap_mode,
        "acpds_input_res": settings.acpds_input_res,
        "model_version": scorer.model_version,
    }
    if "torch" in sys.modules:
        env["torch_threads"] = sys.modules["torch"].get_num_threads()
    for name, module in (("torch", "torch"), ("ultralytics", "ultralytics"), ("opencv", "cv2")):
        if module in sys.modules:
            env[name] = getattr(sys.modules[module], "__version__", None)
    return env


# --- report ----------------------------------------------------------------------------------


def _gb(value: object) -> str:
    return "n/a" if not isinstance(value, int) else f"{value / 2**30:.2f} GB"


def _na(value: object) -> str:
    return "n/a" if value is None else str(value)


def _row(scope: str, s: dict[str, float] | None) -> str:
    if s is None:
        return f"| {scope} | 0 | n/a | n/a | n/a |"
    return f"| {scope} | {s['n']} | {s['p50']:.2f} | {s['p95']:.2f} | {s['max']:.2f} |"


def render_markdown(report: Report) -> str:
    verdict = "PASS" if report.passed else "FAIL"
    env = report.env
    stalls = lambda lot: f"{lot} ({report.stalls.get(lot, '?')} stalls)"  # noqa: E731
    lines = [
        f"### NFR-1 worker timing: {verdict} "
        f"(p95 {report.p95_s:.1f} s, limit {report.limit_s:g} s)",
        "",
        "Per-job wall time (`run_once`: receive, claim, fetch, align, score, writes):",
        "",
        "| scope | jobs | p50 s | p95 s | max s |",
        "|---|---|---|---|---|",
        _row("all", report.wall()),
        *(_row(stalls(lot), report.wall(lot)) for lot in report.lots()),
        _row("handler `processingMs`: all", report.handler()),
        *(_row(f"handler `processingMs`: {lot}", report.handler(lot)) for lot in report.lots()),
        "",
        f"- Startup (not in per-job stats): model load {report.model_load_s:.1f} s; warm-up "
        + ", ".join(f"{lot} {s:.1f} s" for lot, s in report.warmup_s.items()),
        f"- Container: CPUs {_na(env.get('cgroup_cpus'))} (cgroup `cpu.max`), memory limit "
        f"{_gb(env.get('cgroup_memory_max'))}, peak {_gb(env.get('cgroup_memory_peak'))} "
        f"(process RSS {_gb(env.get('peak_rss'))}); torch threads "
        f"{_na(env.get('torch_threads'))}; `os.cpu_count()` {_na(env.get('cpu_count'))}",
        f"- Config: detector `{env.get('detector')}`, aligner `{env.get('aligner')}`, imgsz "
        f"{_na(env.get('yolo_imgsz'))}, overlap mode `{env.get('yolo_overlap_mode')}`, ACPDS "
        f"input res {env.get('acpds_input_res') or 'native'}; `{env.get('model_version')}`",
        "",
        "Storage, queue and DB are in memory, so S3/SQS/DynamoDB round trips are not included. "
        "The gate is the p95 over all jobs; per-lot rows are for information.",
    ]
    return "\n".join(lines) + "\n"


def render_error_markdown(error: str) -> str:
    return f"### NFR-1 worker timing: ERROR\n\nThe run did not finish:\n\n```\n{error}\n```\n"


# --- main ------------------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--lots", nargs="+", default=list(DEFAULT_LOTS), help="lot ids in seed/lots/")
    p.add_argument("--jobs-per-lot", type=int, default=DEFAULT_JOBS_PER_LOT)
    p.add_argument("--limit-s", type=float, default=LIMIT_S, help="p95 gate in seconds")
    p.add_argument("--detector", choices=("stub", "acpds_yolo"), default="acpds_yolo")
    p.add_argument("--aligner", choices=("identity", "orb"), default="orb")
    p.add_argument("--json", type=Path, help="write the full report as JSON")
    p.add_argument("--markdown", type=Path, help="write the summary as markdown")
    args = p.parse_args(argv)
    if args.jobs_per_lot < 1:
        p.error("--jobs-per-lot must be at least 1")
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s %(message)s")

    try:
        settings = build_settings(args.detector, args.aligner)
        adapters = build_adapters(settings)
        lots = seed_lots(adapters, args.lots)
        t0 = time.perf_counter()
        scorer = build_scorer(settings)
        model_load_s = time.perf_counter() - t0
        aligner = build_aligner(settings, adapters)
        warmup, jobs = time_jobs(
            adapters, aligner, scorer, settings.cutoffs, lots, args.jobs_per_lot
        )
        report = Report(
            jobs=jobs,
            model_load_s=model_load_s,
            warmup_s=warmup,
            stalls={lot: info[3] for lot, info in lots.items()},
            limit_s=args.limit_s,
            env=environment(settings, scorer),
        )
    except Exception as exc:
        traceback.print_exc()
        if args.markdown:
            args.markdown.write_text(render_error_markdown(f"{type(exc).__name__}: {exc}"))
        return EXIT_ERROR

    text = render_markdown(report)
    print(text)
    if args.json:
        args.json.write_text(json.dumps(report.to_json(), indent=2) + "\n")
    if args.markdown:
        args.markdown.write_text(text)
    return EXIT_OK if report.passed else EXIT_OVER_LIMIT


if __name__ == "__main__":
    raise SystemExit(main())
