"""Fixtures for the eval/ tools (eval/ is a scripts folder, not a package, so load by path)."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[2]
EVAL = ROOT / "eval"


def _load(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # dataclasses look their module up while the class is built
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="session")
def prefill() -> ModuleType:
    return _load("eval_prefill_labels", EVAL / "prefill_labels.py")


@pytest.fixture(scope="session")
def benchmark() -> ModuleType:
    return _load("eval_benchmark", EVAL / "benchmark.py")


@pytest.fixture(scope="session")
def drone() -> dict:
    """The drone-lot JSON, its reference photo and that photo's size."""
    lot = json.loads((ROOT / "seed" / "lots" / "drone-lot.json").read_text())
    return {
        "lot": lot,
        "reference": (EVAL / "fixtures" / "drone-lot.jpg").read_bytes(),
        "size": (1982, 2000),
        "outlines": lot["viewpoints"][0]["outlines"],
    }
