"""NFR-1 timing: worker processing time per photo, p95 <= 30 s in a 2-CPU, 4 GB container.

    # host (vision extra + weights):
    MODELS_DIR=models uv run python scripts/worker_timing.py --jobs-per-lot 3
    # the vision image, as CI runs it (see models/README.md):
    docker run --rm --network none --cpus=2 --cpuset-cpus=0,1 --memory=4g --memory-swap=4g \\
        -e OMP_NUM_THREADS=2 -e MKL_NUM_THREADS=2 \\
        -v "$PWD:/repo:ro" -v "$PWD/models:/app/models:ro" \\
        parking-worker:vision python /repo/scripts/worker_timing.py

Seeds each lot (seed/lots/<lot>.json, reference photo eval/fixtures/<lot>.jpg) on the in-memory
adapters, then times real worker jobs end to end through `poller.run_once`: receive, claim,
layout load, photo fetch, alignment (ALIGNER=orb), scoring (DETECTOR=acpds_yolo), observation
and status writes, COMPLETE. Each job's photo is the lot's reference shifted by a few pixels and
re-encoded, so every job has its own image id and bytes and ORB still has to match it.

Every lot is timed twice: at the fixture's size, and with the reference resized so its long
edge is --photo-long-edge (default 4032, a 12 MP phone photo's long edge, well inside the
15 MB upload limit) before the shift and re-encode. ACPDS runs at the photo's native
resolution, so large photos are the expensive case; the stored reference stays fixture-size,
as it would after an admin uploads a smaller reference. --photo-long-edge 0 skips them.

Model load (SHA-256 check + load) and one untimed warm-up job per lot (first forward pass,
ORB reference features) are reported apart from the per-job numbers, which is what a
long-running worker pays per photo. The gate is the p95 of per-job wall time over all jobs,
both photo sizes. Storage, queue and DB are in memory, so S3/SQS/DynamoDB round trips are not
included. Under a cgroup CPU quota (`docker --cpus`) torch and OpenCV get one thread per CPU of
the quota; without one their defaults are left alone.

--check-setup seeds the lots and runs one job per lot and photo size with the stub scorer
(no models, no weights), then exits: a quick check that the imports, the seed files and the
fixtures resolve, e.g. in the image before the weights are downloaded.

Exit status: 0 when p95 <= --limit-s (or the setup check passed), 1 when p95 is over, 2 when
the run itself failed (an import, missing weights, a job that did not complete, an unknown
lot). --markdown is written in every case, so a CI job summary always says what happened.
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

# ultralytics resolves two DNS names at import to decide whether it is online, and when it is,
# predict queues anonymous usage events and posts them from a background thread. The timing
# must not depend on the network (CI runs it under --network none), so it never goes online.
os.environ.setdefault("YOLO_OFFLINE", "1")

# A failed import is a run error (exit 2), reported by main(); exit 1 only ever means "over".
try:
    import cv2
    import numpy as np
    from parking_core.interfaces import Aligner, SpaceScorer
    from parking_core.keys import raw_photo_key
    from parking_core.models import Cutoffs, JobMessage, JobStatus, Snapshot
    from parking_core.settings import Adapters, Settings, build_adapters
    from parking_seed.loader import FIXTURES_DIR, load_lot_file, seed_lot
    from parking_worker.aligners import build_aligner
    from parking_worker.poller import run_once
    from parking_worker.scorers import StubScorer, build_scorer
    from parking_worker.scorers.acpds_yolo import header_size, missing_vision_packages
except Exception as _exc:  # any import failure, e.g. an OSError from a native library
    IMPORT_ERROR: Exception | None = _exc
else:
    IMPORT_ERROR = None

DEFAULT_LOTS = ("drone-lot", "pklot-ufpr04")
LIMIT_S = 30.0
DEFAULT_JOBS_PER_LOT = 10
DEFAULT_PHOTO_LONG_EDGE = 4032
"""A 12 MP phone photo is 4032 x 3024 and fits the 15 MB upload limit; the fixtures are
1-4 MP. ACPDS runs at the photo's native resolution, so this is the expensive allowed input."""
CGROUP_ROOT = Path("/sys/fs/cgroup")
T0 = datetime(2026, 11, 1, tzinfo=UTC)
UPLOADED_BY = "nfr1-timing"

EXIT_OK = 0
EXIT_OVER_LIMIT = 1
EXIT_ERROR = 2


class JobFailed(RuntimeError):
    """A timed job did not complete: the timing would be meaningless, so the run stops."""


@dataclass(frozen=True)
class Scope:
    """One lot at one photo size: the fixture's own (long_edge None), or the reference resized
    so its long edge is `long_edge` pixels."""

    lot_id: str
    long_edge: int | None = None

    @property
    def name(self) -> str:
        return self.lot_id if self.long_edge is None else f"{self.lot_id} @{self.long_edge}"


def build_scopes(lots: Sequence[str], long_edge: int | None) -> list[Scope]:
    """Every lot at fixture size, then (when `long_edge` is set) every lot resized."""
    native = [Scope(lot) for lot in lots]
    return native + [Scope(lot, long_edge) for lot in lots] if long_edge else native


@dataclass
class JobTiming:
    lot_id: str
    scope: str
    image_id: str
    wall_s: float
    """run_once from receive to delete, as seen by the poller."""
    processing_ms: int | None
    """What the handler records on the snapshot: everything after the claim."""
    spaces: int
    photo_px: tuple[int, int] | None = None
    """(width, height) of the uploaded photo."""
    photo_bytes: int | None = None


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

    def scopes(self) -> list[str]:
        return list(dict.fromkeys(j.scope for j in self.jobs))

    def wall(self, scope: str | None = None) -> dict[str, float]:
        return summarize([j.wall_s for j in self.jobs if scope in (None, j.scope)])

    def handler(self, scope: str | None = None) -> dict[str, float] | None:
        values = [
            j.processing_ms / 1000
            for j in self.jobs
            if scope in (None, j.scope) and j.processing_ms is not None
        ]
        return summarize(values) if values else None

    def photo(self, scope: str) -> tuple[str, tuple[int, int] | None, int | None]:
        """(lot_id, photo size, largest photo in bytes) of a scope's jobs."""
        jobs = [j for j in self.jobs if j.scope == scope]
        sizes = [j.photo_bytes for j in jobs if j.photo_bytes is not None]
        return jobs[0].lot_id, jobs[0].photo_px, max(sizes) if sizes else None

    def to_json(self) -> dict:
        return {
            "p95_s": self.p95_s,
            "limit_s": self.limit_s,
            "passed": self.passed,
            "model_load_s": self.model_load_s,
            "warmup_s": self.warmup_s,
            "stalls": self.stalls,
            "wall_s": {"all": self.wall(), **{s: self.wall(s) for s in self.scopes()}},
            "processing_s": {
                "all": self.handler(),
                **{s: self.handler(s) for s in self.scopes()},
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


def resized(width: int, height: int, long_edge: int) -> tuple[int, int]:
    """(width, height) scaled so the longer side is exactly `long_edge`."""
    if width >= height:
        return long_edge, max(1, round(height * long_edge / width))
    return max(1, round(width * long_edge / height)), long_edge


def photo_variant(reference: bytes, i: int, long_edge: int | None = None) -> bytes:
    """The reference photo, resized to `long_edge` when given, then shifted by a few pixels and
    re-encoded: deterministic, a different SHA-256 for each i, the same size for every i, and
    still the same scene for ORB."""
    img = cv2.imdecode(np.frombuffer(reference, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("reference photo could not be decoded")
    if long_edge is not None and max(img.shape[:2]) != long_edge:
        size = resized(img.shape[1], img.shape[0], long_edge)
        up = long_edge > max(img.shape[:2])
        img = cv2.resize(img, size, interpolation=cv2.INTER_CUBIC if up else cv2.INTER_AREA)
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
    scope: str | None = None,
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
        scope=scope or lot_id,
        image_id=image_id,
        wall_s=t1 - t0,
        processing_ms=snapshot.processing_ms if snapshot else None,
        spaces=result.spaces_written,
        photo_px=header_size(data),
        photo_bytes=len(data),
    )


def time_jobs(
    adapters: Adapters,
    aligner: Aligner,
    scorer: SpaceScorer,
    cutoffs: Cutoffs,
    lots: dict[str, tuple[str, bytes, int, int]],
    jobs_per_lot: int,
    scopes: Sequence[Scope] | None = None,
    max_photo_bytes: int | None = None,
    after_warmup: Callable[[], None] | None = None,
    clock: Callable[[], float] = time.perf_counter,
) -> tuple[dict[str, float], list[JobTiming]]:
    """One untimed warm-up job per lot (fixture size), `after_warmup`, then `jobs_per_lot`
    rounds over the scopes (default: every lot at fixture size).

    Capture times strictly increase, so every job's status writes go through. A photo over
    `max_photo_bytes` (the upload limit) is not an input the worker can get, so it stops the
    run instead of being timed."""
    seq = 0

    def job(scope: Scope, image_id: str, variant: int) -> JobTiming:
        nonlocal seq
        view_id, reference, version, _ = lots[scope.lot_id]
        data = photo_variant(reference, variant, scope.long_edge)  # outside the timed span
        if max_photo_bytes is not None and len(data) > max_photo_bytes:
            raise ValueError(
                f"{scope.name}: photo is {len(data)} bytes, over the {max_photo_bytes} byte "
                "upload limit"
            )
        seq += 1
        return run_job(
            adapters,
            aligner,
            scorer,
            cutoffs,
            lot_id=scope.lot_id,
            view_id=view_id,
            image_id=image_id,
            data=data,
            capture_time=T0 + timedelta(seconds=seq),
            layout_version=version,
            scope=scope.name,
            clock=clock,
        )

    def image_id(scope: Scope, n: int) -> str:
        edge = "" if scope.long_edge is None else f"{scope.long_edge}-"
        return f"nfr1-{scope.lot_id}-{edge}{n:03d}"

    scopes = list(scopes) if scopes is not None else [Scope(lot) for lot in lots]
    warmup = {lot: job(Scope(lot), f"nfr1-{lot}-warmup", 0).wall_s for lot in lots}
    if after_warmup is not None:
        after_warmup()
    timings = [
        job(scope, image_id(scope, n), n) for n in range(1, jobs_per_lot + 1) for scope in scopes
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


def cpu_affinity() -> int | None:
    return len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else None


def quota_threads(cgroup_root: Path = CGROUP_ROOT, affinity: int | None = None) -> int | None:
    """Threads for torch and OpenCV under a cgroup CPU quota, or None when there is none.

    `docker --cpus` is a CFS quota: it limits CPU time, not the CPUs a process sees, so torch
    (OpenMP) and OpenCV size their pools from every core on the host and then oversubscribe
    the quota. One thread per quota CPU, rounded up (1.5 CPUs -> 2), and never more than the
    CPUs the process may run on (`--cpuset-cpus`)."""
    cpus = _cgroup_cpus(read_cgroup(cgroup_root / "cpu.max"))
    if cpus is None:
        return None
    threads = max(1, math.ceil(cpus))
    return min(threads, affinity) if affinity else threads


def apply_thread_limit(threads: int | None) -> None:
    """Set OpenCV's and (when loaded) torch's intra-op threads; None leaves their defaults."""
    if threads is None:
        return
    cv2.setNumThreads(threads)
    torch = sys.modules.get("torch")
    if torch is not None:
        torch.set_num_threads(threads)


def environment(
    settings: Settings,
    scorer: SpaceScorer,
    cgroup_root: Path = CGROUP_ROOT,
    threads: int | None = None,
) -> dict:
    """Where and how the run happened; `threads` is what `quota_threads` gave, if anything."""
    env: dict[str, object] = {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "cpu_count": os.cpu_count(),
        "cpu_affinity": cpu_affinity(),
        "cgroup_cpus": _cgroup_cpus(read_cgroup(cgroup_root / "cpu.max")),
        "cgroup_memory_max": _cgroup_bytes(read_cgroup(cgroup_root / "memory.max")),
        "cgroup_memory_peak": _cgroup_bytes(read_cgroup(cgroup_root / "memory.peak")),
        "peak_rss": peak_rss_bytes(),
        "quota_threads": threads,
        "torch_threads": None,
        "opencv_threads": cv2.getNumThreads(),
        "omp_num_threads": os.environ.get("OMP_NUM_THREADS"),
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


def _mb(value: int | None) -> str:
    return "n/a" if value is None else f"{value / 2**20:.1f} MB"


def _scope_label(report: Report, scope: str) -> str:
    lot, px, size = report.photo(scope)
    photo = "?" if px is None else f"{px[0]}x{px[1]}"
    return f"{scope} ({report.stalls.get(lot, '?')} stalls, {photo}, {_mb(size)})"


def render_markdown(report: Report) -> str:
    verdict = "PASS" if report.passed else "FAIL"
    env = report.env
    scopes = report.scopes()
    lines = [
        f"### NFR-1 worker timing: {verdict} "
        f"(p95 {report.p95_s:.1f} s, limit {report.limit_s:g} s)",
        "",
        "Per-job wall time (`run_once`: receive, claim, fetch, align, score, writes):",
        "",
        "| scope | jobs | p50 s | p95 s | max s |",
        "|---|---|---|---|---|",
        _row("all", report.wall()),
        *(_row(_scope_label(report, s), report.wall(s)) for s in scopes),
        _row("handler `processingMs`: all", report.handler()),
        *(_row(f"handler `processingMs`: {s}", report.handler(s)) for s in scopes),
        "",
        f"- Startup (not in per-job stats): model load {report.model_load_s:.1f} s; warm-up "
        + ", ".join(f"{lot} {s:.1f} s" for lot, s in report.warmup_s.items()),
        f"- Container: CPUs {_na(env.get('cgroup_cpus'))} (cgroup `cpu.max`), "
        f"{_na(env.get('cpu_affinity'))} usable (affinity), `os.cpu_count()` "
        f"{_na(env.get('cpu_count'))}; memory limit {_gb(env.get('cgroup_memory_max'))}, peak "
        f"(incl. page cache) {_gb(env.get('cgroup_memory_peak'))}, process peak RSS "
        f"{_gb(env.get('peak_rss'))}",
        f"- Threads: torch {_na(env.get('torch_threads'))}, OpenCV "
        f"{_na(env.get('opencv_threads'))} (from the CPU quota: "
        f"{_na(env.get('quota_threads'))}); `OMP_NUM_THREADS` {_na(env.get('omp_num_threads'))}",
        f"- Config: detector `{env.get('detector')}`, aligner `{env.get('aligner')}`, imgsz "
        f"{_na(env.get('yolo_imgsz'))}, overlap mode `{env.get('yolo_overlap_mode')}`, ACPDS "
        f"input res {env.get('acpds_input_res') or 'native'}; `{env.get('model_version')}`",
        "",
        "Storage, queue and DB are in memory, so S3/SQS/DynamoDB round trips are not included. "
        "The gate is the p95 over all jobs, every lot and photo size; per-scope rows are for "
        "information.",
    ]
    return "\n".join(lines) + "\n"


def render_error_markdown(error: str) -> str:
    return f"### NFR-1 worker timing: ERROR\n\nThe run did not finish:\n\n```\n{error}\n```\n"


# --- main ------------------------------------------------------------------------------------


def _origin(module: str) -> str:
    spec = importlib.util.find_spec(module)
    return str(Path(spec.origin).parent) if spec and spec.origin else "?"


def check_setup(lots_ids: Sequence[str], aligner_name: str, detector: str, long_edge: int) -> str:
    """Seed the lots and run one job per scope with the stub scorer: imports, seed files,
    fixtures, photo sizes and alignment, without models. Raises on any problem."""
    if detector == "acpds_yolo" and (missing := missing_vision_packages()):
        raise RuntimeError(f"DETECTOR=acpds_yolo needs {', '.join(missing)}")
    settings = build_settings("stub", aligner_name)
    adapters = build_adapters(settings)
    lots = seed_lots(adapters, lots_ids)
    scopes = build_scopes(lots_ids, long_edge or None)
    _, jobs = time_jobs(
        adapters,
        build_aligner(settings, adapters),
        StubScorer(),
        settings.cutoffs,
        lots,
        1,
        scopes,
        settings.max_upload_bytes,
    )
    lines = [
        "NFR-1 setup OK (stub scorer, no models): "
        + ", ".join(
            f"{m} from {_origin(m)}" for m in ("parking_core", "parking_worker", "parking_seed")
        )
    ]
    for job in jobs:
        px = "?" if job.photo_px is None else f"{job.photo_px[0]}x{job.photo_px[1]}"
        lines.append(
            f"  {job.scope}: {job.spaces}/{lots[job.lot_id][3]} spaces, photo {px} "
            f"{_mb(job.photo_bytes)}, aligner {aligner_name}, {job.wall_s:.2f} s"
        )
    return "\n".join(lines)


def run(args: argparse.Namespace) -> Report:
    settings = build_settings(args.detector, args.aligner)
    adapters = build_adapters(settings)
    lots = seed_lots(adapters, args.lots)
    t0 = time.perf_counter()
    scorer = build_scorer(settings)
    model_load_s = time.perf_counter() - t0
    threads = quota_threads(affinity=cpu_affinity())
    apply_thread_limit(threads)  # after the scorer, which is what imports torch
    aligner = build_aligner(settings, adapters)
    # ...and again after the warm-up: ultralytics' first predict (select_device) resets torch
    # to min(8, os.cpu_count() - 1) threads, counting the host's cores, not the quota.
    warmup, jobs = time_jobs(
        adapters,
        aligner,
        scorer,
        settings.cutoffs,
        lots,
        args.jobs_per_lot,
        build_scopes(args.lots, args.photo_long_edge or None),
        settings.max_upload_bytes,
        after_warmup=lambda: apply_thread_limit(threads),
    )
    return Report(
        jobs=jobs,
        model_load_s=model_load_s,
        warmup_s=warmup,
        stalls={lot: info[3] for lot, info in lots.items()},
        limit_s=args.limit_s,
        env=environment(settings, scorer, threads=threads),
    )


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--lots", nargs="+", default=list(DEFAULT_LOTS), help="lot ids in seed/lots/")
    p.add_argument("--jobs-per-lot", type=int, default=DEFAULT_JOBS_PER_LOT)
    p.add_argument(
        "--photo-long-edge",
        type=int,
        default=DEFAULT_PHOTO_LONG_EDGE,
        help="also time every lot with its photo resized to this long edge (0: skip)",
    )
    p.add_argument("--limit-s", type=float, default=LIMIT_S, help="p95 gate in seconds")
    p.add_argument("--detector", choices=("stub", "acpds_yolo"), default="acpds_yolo")
    p.add_argument("--aligner", choices=("identity", "orb"), default="orb")
    p.add_argument("--json", type=Path, help="write the full report as JSON")
    p.add_argument("--markdown", type=Path, help="write the summary as markdown")
    p.add_argument(
        "--check-setup",
        action="store_true",
        help="seed the lots, run one stub-scorer job per lot and photo size, and exit",
    )
    args = p.parse_args(argv)
    if args.jobs_per_lot < 1:
        p.error("--jobs-per-lot must be at least 1")
    if args.photo_long_edge < 0:
        p.error("--photo-long-edge must be 0 (skip) or a size in pixels")
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s %(message)s")

    # Everything that can fail is in here, rendering and writing included, so an exception
    # always ends as exit 2 with an ERROR report and never as Python's own exit 1.
    try:
        if IMPORT_ERROR is not None:
            raise IMPORT_ERROR
        if args.check_setup:
            print(check_setup(args.lots, args.aligner, args.detector, args.photo_long_edge))
            return EXIT_OK
        report = run(args)
        text = render_markdown(report)
        print(text)
        if args.json:
            args.json.write_text(json.dumps(report.to_json(), indent=2) + "\n")
        if args.markdown:
            args.markdown.write_text(text)
    except Exception as exc:
        traceback.print_exc()
        if args.markdown:
            try:
                args.markdown.write_text(render_error_markdown(f"{type(exc).__name__}: {exc}"))
            except OSError:
                traceback.print_exc()
        return EXIT_ERROR
    return EXIT_OK if report.passed else EXIT_OVER_LIMIT


if __name__ == "__main__":
    raise SystemExit(main())
