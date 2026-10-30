"""scripts/worker_timing.py (NFR-1): stats, report, gate and the job path, without torch.

The real-model run is the CI job `worker-vision-image`; here the stub scorer stands in for
ACPDS + YOLO and the real ORB aligner runs on the seeded fixtures.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import random
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest
from parking_core.adapters.memory import MemoryJobQueue, MemoryObjectStore, MemoryRepository
from parking_core.errors import PermanentJobError
from parking_core.models import JobStatus
from parking_core.settings import build_adapters
from parking_worker.aligners import OrbAligner, build_aligner
from parking_worker.scorers import StubScorer

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "eval" / "fixtures" / "pklot-ufpr04.jpg"


def _load():
    spec = importlib.util.spec_from_file_location(
        "worker_timing", ROOT / "scripts" / "worker_timing.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["worker_timing"] = module  # dataclasses resolve annotations through it
    spec.loader.exec_module(module)
    return module


wt = _load()


def _report(walls, limit_s=30.0, env=None, lot="drone-lot") -> wt.Report:
    jobs = [wt.JobTiming(lot, f"img-{i}", w, int(w * 900), 124) for i, w in enumerate(walls)]
    return wt.Report(
        jobs=jobs,
        model_load_s=4.25,
        warmup_s={lot: 21.5},
        stalls={lot: 124},
        limit_s=limit_s,
        env=env or {},
    )


@pytest.fixture
def world():
    settings = wt.build_settings("stub", "orb")
    adapters = build_adapters(settings)
    lots = wt.seed_lots(adapters, ["drone-lot", "pklot-ufpr04"])
    return settings, adapters, lots


# --- stats -----------------------------------------------------------------------------------


def test_percentile_interpolates_linearly():
    values = list(range(1, 21))
    assert wt.percentile(values, 50) == 10.5
    assert wt.percentile(values, 95) == pytest.approx(19.05)
    assert wt.percentile(values, 0) == 1
    assert wt.percentile(values, 100) == 20
    assert wt.percentile([7.5], 95) == 7.5
    shuffled = values[:]
    random.Random(1).shuffle(shuffled)
    assert wt.percentile(shuffled, 95) == wt.percentile(values, 95)


@pytest.mark.parametrize("values, q", [([], 50), ([1.0], -1), ([1.0], 100.5)])
def test_percentile_rejects_bad_input(values, q):
    with pytest.raises(ValueError):
        wt.percentile(values, q)


def test_percentile_matches_numpy():
    rng = random.Random(498)
    for _ in range(50):
        values = [rng.uniform(0, 60) for _ in range(rng.randint(1, 40))]
        for q in (50, 90, 95, 99):
            assert wt.percentile(values, q) == pytest.approx(float(np.percentile(values, q)))


def test_summarize_keys():
    s = wt.summarize([1.0, 2.0, 3.0])
    assert s == {"n": 3, "mean": 2.0, "p50": 2.0, "p95": pytest.approx(2.9), "max": 3.0}


def test_gate_passes_at_exactly_the_limit():
    report = _report([10.0] * 20)
    assert report.p95_s == 10.0
    assert wt.Report(**{**report.__dict__, "limit_s": 10.0}).passed
    assert not wt.Report(**{**report.__dict__, "limit_s": 10.0 - 1e-9}).passed
    assert not _report([10.0] * 19 + [10.0 + 1e-9], limit_s=10.0).passed


# --- report ----------------------------------------------------------------------------------


def test_render_markdown_pass_and_fail():
    jobs = [wt.JobTiming("drone-lot", f"d-{i}", 17.0 + i * 0.1, 16_900, 124) for i in range(10)]
    jobs += [wt.JobTiming("pklot-ufpr04", f"p-{i}", 3.0, 2_900, 27) for i in range(10)]
    env = {
        "cgroup_cpus": 2.0,
        "cgroup_memory_max": 4 * 2**30,
        "cgroup_memory_peak": 3 * 2**30,
        "torch_threads": 2,
        "cpu_count": 4,
        "detector": "acpds_yolo",
        "aligner": "orb",
        "yolo_imgsz": 1280,
        "yolo_overlap_mode": "box",
        "acpds_input_res": None,
        "model_version": "acpds_yolo|acpds=abc",
    }
    report = wt.Report(
        jobs=jobs,
        model_load_s=4.25,
        warmup_s={"drone-lot": 21.5, "pklot-ufpr04": 5.0},
        stalls={"drone-lot": 124, "pklot-ufpr04": 27},
        limit_s=30.0,
        env=env,
    )
    text = wt.render_markdown(report)
    assert text.startswith(f"### NFR-1 worker timing: PASS (p95 {report.p95_s:.1f} s, limit 30 s)")
    assert "| all | 20 |" in text
    assert "| drone-lot (124 stalls) | 10 |" in text
    assert "| pklot-ufpr04 (27 stalls) | 10 | 3.00 | 3.00 | 3.00 |" in text
    assert "| handler `processingMs`: drone-lot | 10 | 16.90 |" in text
    assert "model load 4.2 s" in text
    assert "drone-lot 21.5 s, pklot-ufpr04 5.0 s" in text
    assert "CPUs 2.0" in text and "memory limit 4.00 GB" in text and "peak 3.00 GB" in text
    assert "torch threads 2" in text and "`acpds_yolo|acpds=abc`" in text

    failing = wt.Report(**{**report.__dict__, "limit_s": 5.0})
    assert wt.render_markdown(failing).startswith("### NFR-1 worker timing: FAIL (p95 ")
    assert "limit 5 s)" in wt.render_markdown(failing)


def test_render_markdown_without_cgroup_values():
    env = {"cgroup_cpus": None, "cgroup_memory_max": None, "cgroup_memory_peak": None}
    jobs = [wt.JobTiming("drone-lot", "d-0", 1.0, None, 124)]
    report = wt.Report(jobs, 0.0, {"drone-lot": 1.0}, {"drone-lot": 124}, 30.0, env)
    text = wt.render_markdown(report)
    assert "CPUs n/a" in text and "memory limit n/a" in text and "peak n/a" in text
    assert "| handler `processingMs`: all | 0 | n/a | n/a | n/a |" in text


def test_report_json_round_trips():
    data = json.loads(json.dumps(_report([1.0, 2.0, 3.0]).to_json()))
    assert data["passed"] is True
    assert data["p95_s"] == pytest.approx(2.9)
    assert data["wall_s"]["drone-lot"]["n"] == 3
    assert len(data["jobs"]) == 3 and data["jobs"][0]["image_id"] == "img-0"


def test_error_markdown_carries_the_message():
    text = wt.render_error_markdown("FileNotFoundError: no such lot")
    assert text.startswith("### NFR-1 worker timing: ERROR")
    assert "FileNotFoundError: no such lot" in text


# --- setup -----------------------------------------------------------------------------------


def test_photo_variant_is_distinct_and_same_size():
    reference = FIXTURE.read_bytes()
    shape = cv2.imdecode(np.frombuffer(reference, np.uint8), cv2.IMREAD_COLOR).shape
    variants = [wt.photo_variant(reference, i) for i in range(25)]
    assert len({hashlib.sha256(v).hexdigest() for v in variants}) == 25
    assert hashlib.sha256(reference).hexdigest() not in {
        hashlib.sha256(v).hexdigest() for v in variants
    }
    for v in variants:
        assert cv2.imdecode(np.frombuffer(v, np.uint8), cv2.IMREAD_COLOR).shape == shape
    assert wt.photo_variant(reference, 3) == variants[3]  # deterministic


def test_photo_variant_rejects_undecodable_bytes():
    with pytest.raises(ValueError):
        wt.photo_variant(b"not a photo", 0)


def test_build_settings_ignores_app_env(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_ENV", "aws")
    monkeypatch.setenv("MODELS_DIR", str(tmp_path))
    settings = wt.build_settings("stub", "orb")
    assert settings.app_env == "test"
    assert settings.models_dir == str(tmp_path)
    assert (settings.detector, settings.aligner) == ("stub", "orb")
    adapters = build_adapters(settings)
    assert isinstance(adapters.object_store, MemoryObjectStore)
    assert isinstance(adapters.queue, MemoryJobQueue)
    assert isinstance(adapters.repository, MemoryRepository)


# --- jobs ------------------------------------------------------------------------------------


def test_time_jobs_runs_the_real_handler_path(world):
    settings, adapters, lots = world
    assert {lot: info[2:] for lot, info in lots.items()} == {
        "drone-lot": (1, 124),
        "pklot-ufpr04": (1, 27),
    }
    aligner = build_aligner(settings, adapters)
    assert isinstance(aligner, OrbAligner)
    warmup, jobs = wt.time_jobs(adapters, aligner, StubScorer(), settings.cutoffs, lots, 2)

    assert set(warmup) == {"drone-lot", "pklot-ufpr04"}
    assert all(s > 0 for s in warmup.values())
    assert [j.lot_id for j in jobs] == ["drone-lot", "pklot-ufpr04"] * 2
    ids = [j.image_id for j in jobs] + [f"nfr1-{lot}-warmup" for lot in lots]
    assert len(set(ids)) == 6
    assert all(j.wall_s > 0 for j in jobs)
    repo = adapters.repository
    for image_id in ids:
        snap = repo.get_snapshot(image_id)
        assert snap.job_status is JobStatus.COMPLETE
        assert snap.processing_ms is not None
        assert snap.layout_version == 1
    assert len(adapters.queue) == 0
    for lot, (_, _, _, stalls) in lots.items():
        assert [j.spaces for j in jobs if j.lot_id == lot] == [stalls, stalls]
        statuses = repo.get_statuses(lot)
        assert len(statuses) == stalls
        last = [j.image_id for j in jobs if j.lot_id == lot][-1]
        assert {s.source_image_id for s in statuses} == {last}


def test_run_job_raises_when_the_job_does_not_complete(world):
    settings, adapters, lots = world

    class Broken:
        model_version = "broken"
        last_detections: list = []

        def score(self, image, outlines):
            raise PermanentJobError("scorer exploded")

    view_id, reference, version, _ = lots["pklot-ufpr04"]
    with pytest.raises(wt.JobFailed, match="nfr1-x: failed_permanent scorer exploded"):
        wt.run_job(
            adapters,
            build_aligner(settings, adapters),
            Broken(),
            settings.cutoffs,
            lot_id="pklot-ufpr04",
            view_id=view_id,
            image_id="nfr1-x",
            data=wt.photo_variant(reference, 1),
            capture_time=wt.T0,
            layout_version=version,
        )


def test_run_job_times_with_the_given_clock(world):
    settings, adapters, lots = world
    ticks = iter([100.0, 112.5])
    view_id, reference, version, stalls = lots["pklot-ufpr04"]
    timing = wt.run_job(
        adapters,
        build_aligner(settings, adapters),
        StubScorer(),
        settings.cutoffs,
        lot_id="pklot-ufpr04",
        view_id=view_id,
        image_id="nfr1-clock",
        data=wt.photo_variant(reference, 2),
        capture_time=wt.T0,
        layout_version=version,
        clock=lambda: next(ticks),
    )
    assert timing.wall_s == 12.5
    assert timing.spaces == stalls


# --- main ------------------------------------------------------------------------------------


def _main(tmp_path, *extra):
    js, md = tmp_path / "nfr1.json", tmp_path / "nfr1.md"
    args = ["--detector", "stub", "--aligner", "orb", "--json", str(js), "--markdown", str(md)]
    return wt.main([*args, *extra]), js, md


def test_main_passes_and_writes_reports(tmp_path, capsys):
    rc, js, md = _main(tmp_path, "--lots", "pklot-ufpr04", "--jobs-per-lot", "2")
    assert rc == wt.EXIT_OK
    data = json.loads(js.read_text())
    assert data["passed"] is True and data["p95_s"] > 0
    assert len(data["jobs"]) == 2 and set(data["warmup_s"]) == {"pklot-ufpr04"}
    assert data["env"]["detector"] == "stub" and data["env"]["aligner"] == "orb"
    assert md.read_text().startswith("### NFR-1 worker timing: PASS")
    assert "NFR-1 worker timing: PASS" in capsys.readouterr().out


def test_main_fails_over_the_limit(tmp_path):
    rc, js, md = _main(
        tmp_path, "--lots", "pklot-ufpr04", "--jobs-per-lot", "2", "--limit-s", "1e-9"
    )
    assert rc == wt.EXIT_OVER_LIMIT
    assert json.loads(js.read_text())["passed"] is False
    assert md.read_text().startswith("### NFR-1 worker timing: FAIL")


def test_main_reports_a_run_that_could_not_finish(tmp_path):
    rc, js, md = _main(tmp_path, "--lots", "no-such-lot")
    assert rc == wt.EXIT_ERROR
    assert not js.exists()
    text = md.read_text()
    assert text.startswith("### NFR-1 worker timing: ERROR")
    assert "no-such-lot" in text


# --- environment -----------------------------------------------------------------------------


def test_environment_reads_cgroup_limits(tmp_path):
    (tmp_path / "cpu.max").write_text("200000 100000\n")
    (tmp_path / "memory.max").write_text("4294967296\n")
    (tmp_path / "memory.peak").write_text("3221225472\n")
    env = wt.environment(wt.build_settings("stub", "orb"), StubScorer(), cgroup_root=tmp_path)
    assert env["cgroup_cpus"] == 2.0
    assert env["cgroup_memory_max"] == 4294967296
    assert env["cgroup_memory_peak"] == 3221225472
    assert env["model_version"] == "stub-0"
    assert env["peak_rss"] > 0 and env["cpu_count"] >= 1


def test_environment_without_limits(tmp_path):
    (tmp_path / "cpu.max").write_text("max 100000\n")
    (tmp_path / "memory.max").write_text("max\n")
    env = wt.environment(wt.build_settings("stub", "orb"), StubScorer(), cgroup_root=tmp_path)
    assert env["cgroup_cpus"] is None
    assert env["cgroup_memory_max"] is None
    assert env["cgroup_memory_peak"] is None  # file missing
