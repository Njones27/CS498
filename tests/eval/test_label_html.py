"""eval/label.html: self-contained, and its in-page self-test passes in headless Chrome."""

from __future__ import annotations

import html
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

LABEL_HTML = Path(__file__).resolve().parents[2] / "eval" / "label.html"
MAC_CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
RESULT = re.compile(r'<pre id="selftest-result"[^>]*>(.*?)</pre>', re.S)


def _chrome() -> str | None:
    if os.environ.get("CHROME_BIN"):
        return os.environ["CHROME_BIN"] if Path(os.environ["CHROME_BIN"]).is_file() else None
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        if found := shutil.which(name):
            return found
    return str(MAC_CHROME) if MAC_CHROME.is_file() else None


def test_self_contained():
    text = LABEL_HTML.read_text()
    assert not re.search(r"""(?:src|href)\s*=\s*["']?(?:https?:)?//""", text)
    assert "<link" not in text
    assert not re.search(r"<script[^>]*\bsrc=", text)
    assert "fetch(" not in text and "import(" not in text
    assert 'id="selftest-result"' in text


def test_selftest_in_headless_chrome(benchmark, tmp_path):
    chrome = _chrome()
    if chrome is None:
        pytest.skip("no Chrome or Chromium found (set CHROME_BIN to its executable)")
    cmd = [
        chrome,
        "--headless",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        # CI runners: /dev/shm is small in containers, and nothing should reach the network.
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-crash-reporter",
        "--disable-background-networking",
        f"--user-data-dir={tmp_path / 'profile'}",
        *(["--no-sandbox"] if sys.platform.startswith("linux") else []),
        "--dump-dom",
        LABEL_HTML.as_uri() + "#selftest",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired:
        pytest.fail("headless Chrome did not finish within 90 s")
    match = RESULT.search(proc.stdout)
    if not (match and match.group(1).strip()):
        pytest.fail(
            f"headless Chrome (exit {proc.returncode}) produced no self-test result; "
            f"stderr:\n{proc.stderr[-2000:]}"
        )
    result = json.loads(html.unescape(match.group(1)))
    failed = [f"{c['name']}: {c['detail']}" for c in result["checks"] if not c["ok"]]
    assert result["ok"] and not failed, failed
    assert len(result["checks"]) >= 15

    # The page's saved XML reads back with the benchmark's reader: stall 1 was cycled to unset
    # (not scored), stall 2 stayed empty, stall 3 was clicked to occupied, stall 4 is skipped.
    assert result["xml"].startswith('<?xml version="1.0"?>\n<parking id="selftest-V1">\n')
    xml = tmp_path / "selftest.xml"
    xml.write_text(result["xml"])
    source, labeled = benchmark.read_labels(xml, 200, 100)
    assert source == "selftest-V1"
    assert [(o.space_id, occupied) for o, occupied in labeled] == [("pk-2", False), ("pk-3", True)]
    assert labeled[1][0].polygon == [(0.55, 0.1), (0.7, 0.1), (0.7, 0.4), (0.55, 0.4)]
