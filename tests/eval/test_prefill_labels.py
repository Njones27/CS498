"""eval/prefill_labels.py: ORB-aligned, unlabeled PKLot XML for new pilot photos."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

import cv2
import numpy as np
import pytest
from parking_seed.pklot import parse_xml

TOL_PX = 3.0
ROTATE_DEG, SHIFT = 4.0, (60.0, -40.0)


def _spaces(xml: Path) -> dict[str, list[tuple[float, float]]]:
    root = ET.parse(xml).getroot()
    return {
        sp.get("id"): [(float(p.get("x")), float(p.get("y"))) for p in sp.findall("contour/point")]
        for sp in root.iter("space")
    }


def _expected_px(outline, size, m=None) -> np.ndarray:
    pts = np.array(outline, dtype=np.float64) * size
    if m is None:
        return pts
    return np.hstack([pts, np.ones((len(pts), 1))]) @ m.T


def _reference_dir(tmp_path: Path, drone: dict, name: str = "ref.jpg") -> Path:
    photos = tmp_path / "photos"
    photos.mkdir(exist_ok=True)
    (photos / name).write_bytes(drone["reference"])
    return photos


def _shifted_rotated(tmp_path: Path, drone: dict) -> tuple[Path, np.ndarray]:
    w, h = drone["size"]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), ROTATE_DEG, 1.0)
    m[:, 2] += SHIFT
    img = cv2.imdecode(np.frombuffer(drone["reference"], np.uint8), cv2.IMREAD_COLOR)
    warped = cv2.warpAffine(img, m, (w, h))
    photos = tmp_path / "photos"
    photos.mkdir(exist_ok=True)
    ok, buf = cv2.imencode(".jpg", warped, [cv2.IMWRITE_JPEG_QUALITY, 90])
    assert ok
    (photos / "moved.jpg").write_bytes(buf.tobytes())
    return photos, m


def test_rotated_rect_matches_pklot_sample(prefill):
    # The sample space in eval/README.md ("Labeling format for pilot photos").
    quad = [(720, 549), (805, 665), (715, 698), (644, 582)]
    assert prefill.rotated_rect(quad) == (722, 625, 161, 149)


def test_reference_against_itself(prefill, drone, tmp_path):
    photos = _reference_dir(tmp_path, drone)
    [result] = prefill.prefill_dir(photos)
    assert result.status == "written"
    assert result.spaces == 124 and result.out_of_frame == []

    xml = photos / "ref.xml"
    root = ET.parse(xml).getroot()
    assert root.tag == "parking" and root.get("id") == "drone-lot-V1"
    assert xml.read_text().startswith('<?xml version="1.0"?>\n')
    spaces = list(root.iter("space"))
    assert [sp.get("id") for sp in spaces] == list(drone["outlines"])
    for sp in spaces:
        assert sp.get("occupied") is None  # unscored until a human labels it
        assert sp.find("rotatedRect/center") is not None
        assert sp.find("rotatedRect/size") is not None
        assert sp.find("rotatedRect/angle").get("d") == "0"
    for sid, pts in _spaces(xml).items():
        expected = _expected_px(drone["outlines"][sid], drone["size"])
        assert np.abs(np.array(pts) - expected).max() <= TOL_PX, sid


def test_shifted_rotated_copy(prefill, drone, tmp_path):
    photos, m = _shifted_rotated(tmp_path, drone)
    w, h = drone["size"]
    [result] = prefill.prefill_dir(photos)
    assert result.status == "written"
    written = _spaces(photos / "moved.xml")

    for sid, pts in written.items():
        expected = _expected_px(drone["outlines"][sid], drone["size"], m)
        assert np.abs(np.array(pts) - expected).max() <= TOL_PX, sid

    inside, outside = set(), set()
    for sid, outline in drone["outlines"].items():
        e = _expected_px(outline, drone["size"], m)
        if (e[:, 0] >= TOL_PX).all() and (e[:, 0] <= w - TOL_PX).all():
            if (e[:, 1] >= TOL_PX).all() and (e[:, 1] <= h - TOL_PX).all():
                inside.add(sid)
        if (e[:, 0] < -TOL_PX).any() or (e[:, 0] > w + TOL_PX).any():
            outside.add(sid)
        elif (e[:, 1] < -TOL_PX).any() or (e[:, 1] > h + TOL_PX).any():
            outside.add(sid)
    assert inside <= set(written)
    assert outside and not outside & set(written)
    assert set(result.out_of_frame) >= outside
    assert result.spaces + len(result.out_of_frame) == 124
    assert result.out_of_frame


def test_output_parses_with_benchmark_reader(prefill, benchmark, drone, tmp_path):
    photos = _reference_dir(tmp_path, drone)
    prefill.prefill_dir(photos)
    xml = photos / "ref.xml"
    w, h = drone["size"]
    assert benchmark.read_labels(xml, w, h) == ("drone-lot-V1", [])  # nothing labeled yet

    tree = ET.parse(xml)
    flags = {}
    for i, sp in enumerate(tree.getroot().iter("space")):
        flags[f"pk-{sp.get('id')}"] = i % 2 == 0
        sp.set("occupied", "1" if i % 2 == 0 else "0")
    tree.write(xml)

    source, labeled = benchmark.read_labels(xml, w, h)
    assert source == "drone-lot-V1"
    assert len(labeled) == 124
    assert {o.space_id: occupied for o, occupied in labeled} == flags
    for o, _ in labeled:
        expected = np.array(drone["outlines"][o.space_id.removeprefix("pk-")])
        assert np.abs((np.array(o.polygon) - expected) * (w, h)).max() <= TOL_PX
    # seed/import_pklot.py can turn a labeled photo into a lot too
    assert len(parse_xml(xml.read_text())) == 124


def test_skips_existing_unless_force(prefill, drone, tmp_path):
    photos = _reference_dir(tmp_path, drone)
    xml = photos / "ref.xml"
    xml.write_text("<parking/>")
    [result] = prefill.prefill_dir(photos)
    assert result.status == "skipped"
    assert xml.read_text() == "<parking/>"

    [result] = prefill.prefill_dir(photos, force=True)
    assert result.status == "written" and len(_spaces(xml)) == 124


def test_alignment_failure_not_written(prefill, tmp_path, capsys):
    photos = tmp_path / "photos"
    photos.mkdir()
    ok, buf = cv2.imencode(".jpg", np.full((800, 800, 3), 128, np.uint8))
    assert ok
    (photos / "grey.jpg").write_bytes(buf.tobytes())

    [result] = prefill.prefill_dir(photos)
    assert result.status == "failed" and result.error == "Too few matches"
    assert not (photos / "grey.xml").exists()

    assert prefill.main([str(photos)]) == 1
    out = capsys.readouterr().out
    assert "FAILED grey.jpg: Too few matches" in out
    assert not (photos / "grey.xml").exists()


def test_main_defaults(prefill, drone, tmp_path, capsys):
    photos = _reference_dir(tmp_path, drone, "DJI_0001.JPG")
    assert prefill.main([str(photos)]) == 0
    out = capsys.readouterr().out
    assert "wrote DJI_0001.xml: 124 stalls" in out
    assert "rename DJI_0001.JPG to .jpg" in out
    assert (photos / "DJI_0001.xml").is_file()
    assert "1 written, 0 skipped, 0 failed" in out

    assert prefill.main([str(photos)]) == 0
    assert "skip DJI_0001.JPG: DJI_0001.xml exists" in capsys.readouterr().out


def test_main_empty_dir_and_unknown_view(prefill, tmp_path, capsys):
    assert prefill.main([str(tmp_path)]) == 2
    assert "No .jpg photos" in capsys.readouterr().out
    with pytest.raises(SystemExit, match=r"No viewpoint 'V9' in lot 'drone-lot' \(has: V1\)"):
        prefill.main([str(tmp_path), "--view", "V9"])
