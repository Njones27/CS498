"""Size torch's and OpenCV's thread pools to the container's CPU quota.

`docker --cpus` (and an ECS task's CPU units) is a cgroup CFS quota: it limits CPU time, not
the CPUs a process sees, so torch (OpenMP) and OpenCV size their pools from every core on the
host and then oversubscribe the quota. The worker gives them one thread per quota CPU instead.
Without a quota (a laptop, plain `uv run`) their defaults are left alone.

torch is never imported here: it is limited only when something else (the ACPDS + YOLO
scorer) has already loaded it, so the stub worker and CI run without it.
"""

from __future__ import annotations

import logging
import math
import os
import sys
from pathlib import Path

import cv2

CGROUP_ROOT = Path("/sys/fs/cgroup")

log = logging.getLogger(__name__)


def cpu_affinity() -> int | None:
    """CPUs this process may run on (`--cpuset-cpus`), or None where the OS cannot say."""
    return len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else None


def quota_cpus(cgroup_root: Path = CGROUP_ROOT) -> float | None:
    """CPUs of the cgroup v2 quota (`cpu.max`), or None when there is no quota or no cgroup.

    `cpu.max` is "<quota> <period>" in microseconds, or "max <period>" for no limit."""
    try:
        parts = (cgroup_root / "cpu.max").read_text().split()
    except OSError:
        return None
    if len(parts) != 2 or parts[0] == "max":
        return None
    try:
        return int(parts[0]) / int(parts[1])
    except (ValueError, ZeroDivisionError):
        return None


def quota_threads(cgroup_root: Path = CGROUP_ROOT, affinity: int | None = None) -> int | None:
    """Threads for torch and OpenCV under a cgroup CPU quota, or None when there is none.

    One thread per quota CPU, rounded up (1.5 CPUs -> 2), and never more than `affinity`, the
    CPUs the process may run on."""
    cpus = quota_cpus(cgroup_root)
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


def limit_threads_to_quota(cgroup_root: Path = CGROUP_ROOT) -> int | None:
    """Apply `quota_threads` (capped at the CPU affinity) and log what torch and OpenCV now
    use. Returns the limit, or None when there is no quota."""
    threads = quota_threads(cgroup_root, affinity=cpu_affinity())
    apply_thread_limit(threads)
    torch = sys.modules.get("torch")
    log.info(
        "Threads: torch %s, OpenCV %s (%s)",
        torch.get_num_threads() if torch is not None else "not loaded",
        cv2.getNumThreads(),
        "no cgroup CPU quota, defaults" if threads is None else f"CPU quota: {threads}",
    )
    return threads
