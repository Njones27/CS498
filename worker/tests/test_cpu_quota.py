"""Thread limits from the cgroup CPU quota (no torch needed: torch is faked when present)."""

from __future__ import annotations

import logging
import sys
import types

import cv2
import pytest
from parking_core.settings import Settings, build_adapters
from parking_worker import cpu_quota, poller
from parking_worker.scorers import StubScorer


@pytest.mark.parametrize(
    "cpu_max, affinity, threads",
    [
        ("200000 100000", None, 2),
        ("200000 100000", 2, 2),
        ("150000 100000", None, 2),
        ("50000 100000", None, 1),
        ("400000 100000", 2, 2),
        ("100000 100000", 8, 1),
        ("max 100000", 2, None),
        (None, 2, None),
    ],
)
def test_quota_threads_from_the_cgroup_quota(tmp_path, cpu_max, affinity, threads):
    if cpu_max is not None:
        (tmp_path / "cpu.max").write_text(cpu_max + "\n")
    assert cpu_quota.quota_threads(tmp_path, affinity=affinity) == threads


@pytest.mark.parametrize("cpu_max", ["", "200000", "abc 100000", "200000 0"])
def test_quota_cpus_ignores_a_malformed_cpu_max(tmp_path, cpu_max):
    (tmp_path / "cpu.max").write_text(cpu_max)
    assert cpu_quota.quota_cpus(tmp_path) is None


def test_apply_thread_limit_sets_torch_and_opencv(monkeypatch):
    torch_calls, cv2_calls = [], []
    monkeypatch.setitem(
        sys.modules, "torch", types.SimpleNamespace(set_num_threads=torch_calls.append)
    )
    monkeypatch.setattr(cv2, "setNumThreads", cv2_calls.append)  # macOS reports GCD's count
    cpu_quota.apply_thread_limit(None)
    assert torch_calls == cv2_calls == []
    cpu_quota.apply_thread_limit(2)
    assert torch_calls == cv2_calls == [2]


def test_apply_thread_limit_without_torch_only_sets_opencv(monkeypatch):
    cv2_calls = []
    monkeypatch.delitem(sys.modules, "torch", raising=False)
    monkeypatch.setattr(cv2, "setNumThreads", cv2_calls.append)
    cpu_quota.apply_thread_limit(3)
    assert cv2_calls == [3] and "torch" not in sys.modules


def test_limit_threads_to_quota_applies_and_logs(tmp_path, monkeypatch, caplog):
    (tmp_path / "cpu.max").write_text("200000 100000\n")
    applied = []
    monkeypatch.setattr(cpu_quota, "cpu_affinity", lambda: None)
    monkeypatch.setattr(cpu_quota, "apply_thread_limit", applied.append)
    monkeypatch.setitem(sys.modules, "torch", types.SimpleNamespace(get_num_threads=lambda: 2))
    with caplog.at_level(logging.INFO, logger="parking_worker.cpu_quota"):
        assert cpu_quota.limit_threads_to_quota(tmp_path) == 2
    assert applied == [2]
    assert "Threads: torch 2, OpenCV" in caplog.text and "CPU quota: 2" in caplog.text


def test_limit_threads_to_quota_without_a_quota_keeps_defaults(tmp_path, monkeypatch, caplog):
    applied = []
    monkeypatch.setattr(cpu_quota, "apply_thread_limit", applied.append)
    monkeypatch.delitem(sys.modules, "torch", raising=False)
    with caplog.at_level(logging.INFO, logger="parking_worker.cpu_quota"):
        assert cpu_quota.limit_threads_to_quota(tmp_path) is None
    assert applied == [None]
    assert "torch not loaded" in caplog.text and "no cgroup CPU quota" in caplog.text


def test_build_worker_limits_threads_before_building(monkeypatch):
    calls = []
    monkeypatch.setattr(poller, "limit_threads_to_quota", lambda: calls.append("limit"))
    monkeypatch.setattr(poller, "build_scorer", lambda s: calls.append("scorer") or StubScorer())
    settings = Settings(app_env="test", _env_file=None)
    aligner, scorer = poller.build_worker(settings, build_adapters(settings))
    assert calls == ["limit", "scorer"]
    assert isinstance(scorer, StubScorer) and hasattr(aligner, "align")
