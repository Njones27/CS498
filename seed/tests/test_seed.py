from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from parking_core import keys
from parking_core.layouts import (
    ValidationFailedError,
    ensure_draft_meta,
    load_draft,
    validate_draft,
)
from parking_core.models import Lot, utcnow
from parking_core.settings import Settings, build_adapters
from parking_seed.loader import load_lot_file, seed_lot
from parking_seed.pklot import build_lot, cluster_rows, parse_xml

HERE = Path(__file__).parent


def memory_adapters():
    return build_adapters(Settings(app_env="test", _env_file=None))  # type: ignore[call-arg]


def test_seed_twice_is_idempotent():
    adapters = memory_adapters()
    data = load_lot_file("test-lot")
    first = seed_lot(adapters, data, b"ref")
    second = seed_lot(adapters, data, b"ref")
    assert first.summary() == "Loaded Test Lot with 14 spaces and 2 viewpoints"
    assert second.summary() == "Test Lot is already published (v1); left it as is"
    assert first.created and not second.created
    assert (second.spaces, second.viewpoints, second.published_version) == (14, 2, 1)
    repo = adapters.repository
    assert [lot.lot_id for lot in repo.list_lots()] == ["test-lot"]
    assert len(repo.list_spaces("test-lot")) == 14
    assert [v.version for v in repo.list_layout_versions("test-lot")] == [1]
    layout = repo.get_published_layout("test-lot")
    assert layout is not None and len(layout.active_spaces()) == 14
    v1 = layout.viewpoint("V1")
    assert v1 is not None and len(v1.outlines) == 10
    assert len(layout.viewpoint("V2").outlines) == 7
    sha12 = hashlib.sha256(b"ref").hexdigest()[:12]
    assert v1.reference_image_key == f"reference/test-lot/V1/{sha12}.jpg"
    assert v1.reference_image_key == keys.reference_image_key(
        "test-lot", "V1", hashlib.sha256(b"ref").hexdigest()
    )
    assert adapters.object_store.exists(v1.reference_image_key)


def test_reseed_leaves_draft_edits_alone():
    """PR A decision 5: re-running the seed used to overwrite the draft's SPACE#/VIEW# items."""
    adapters = memory_adapters()
    repo = adapters.repository
    data = load_lot_file("test-lot")
    seed_lot(adapters, data, b"ref")
    a01 = next(s for s in repo.list_spaces("test-lot") if s.space_id == "A-01")
    repo.put_spaces([a01.model_copy(update={"label": "edited", "retired": True})])
    v1 = repo.get_viewpoint("test-lot", "V1")
    repo.put_viewpoint(v1.model_copy(update={"name": "edited view", "outlines": {}}))
    meta = ensure_draft_meta(repo, repo.get_lot("test-lot"), utcnow())

    assert not seed_lot(adapters, data, b"other photo").created
    a01 = next(s for s in repo.list_spaces("test-lot") if s.space_id == "A-01")
    assert (a01.label, a01.retired) == ("edited", True)
    v1_after = repo.get_viewpoint("test-lot", "V1")
    assert (v1_after.name, v1_after.outlines) == ("edited view", {})
    assert v1_after.reference_image_key == v1.reference_image_key
    assert repo.get_draft_meta("test-lot") == meta
    assert [v.version for v in repo.list_layout_versions("test-lot")] == [1]


def test_seed_publishes_through_validation():
    adapters = memory_adapters()
    data = load_lot_file("test-lot")
    data["spaces"][1]["label"] = data["spaces"][0]["label"]
    with pytest.raises(ValidationFailedError) as exc:
        seed_lot(adapters, data, b"ref")
    assert [i.code for i in exc.value.report.errors] == ["duplicate_label"]
    repo = adapters.repository
    assert repo.get_lot("test-lot") is None and repo.list_spaces("test-lot") == []
    assert not adapters.object_store.exists(
        keys.reference_image_key("test-lot", "V1", hashlib.sha256(b"ref").hexdigest())
    )


def test_seed_without_reference_photo_fails_validation():
    """Viewpoints with outlines need a reference photo (outlines_without_photo)."""
    with pytest.raises(ValidationFailedError) as exc:
        seed_lot(memory_adapters(), load_lot_file("test-lot"), None)
    assert {i.code for i in exc.value.report.errors} == {"outlines_without_photo"}


def test_seed_finishes_an_unpublished_lot():
    """A lot left unpublished (an interrupted seed) is loaded and published again; a draft
    meta someone created meanwhile moves to the next revision, based on the new version."""
    adapters = memory_adapters()
    repo = adapters.repository
    repo.put_lot(Lot(lot_id="test-lot", name="Old name", created_at=utcnow()))
    ensure_draft_meta(repo, repo.get_lot("test-lot"), utcnow())
    result = seed_lot(adapters, load_lot_file("test-lot"), b"ref")
    assert result.created and result.published_version == 1
    assert repo.get_lot("test-lot").name == "Test Lot"
    meta = repo.get_draft_meta("test-lot")
    assert (meta.revision, meta.based_on_version) == (1, 1)


def test_lot_json_outlines_are_normalized():
    data = load_lot_file("test-lot")
    ids = {s["spaceId"] for s in data["spaces"]}
    for vp in data["viewpoints"]:
        for sid, poly in vp["outlines"].items():
            assert sid in ids and len(poly) == 4
            assert all(0 <= x <= 1 and 0 <= y <= 1 for x, y in poly)


def test_import_pklot_fixture():
    xml = (HERE / "pklot_sample.xml").read_text()
    assert len(parse_xml(xml)) == 5
    assert [len(r) for r in cluster_rows(parse_xml(xml))] == [3, 2]
    lot = build_lot(xml, (1000, 500), "pk", "PK Test")
    assert [s["label"] for s in lot["spaces"]] == ["A-01", "A-02", "A-03", "B-01", "B-02"]
    # Row A sorted left to right regardless of XML order.
    assert [s["spaceId"] for s in lot["spaces"][:3]] == ["pk-1", "pk-2", "pk-3"]
    outline = lot["viewpoints"][0]["outlines"]["pk-1"]
    assert outline[0] == [0.05, 0.1]
    rects = [s["rect"] for s in lot["spaces"]]
    assert all(r["x"] + r["w"] <= 1000 and r["y"] + r["h"] <= 600 for r in rects)
    json.dumps(lot)  # serializable


def test_every_lot_file_loads_and_publishes():
    """Each seed lot has a well-formed layout: unique ids, 4-corner outlines in [0, 1]."""
    lots_dir = Path(__file__).resolve().parents[1] / "lots"
    for lot_file in sorted(lots_dir.glob("*.json")):
        data = load_lot_file(lot_file.stem)
        ids = [s["spaceId"] for s in data["spaces"]]
        assert len(ids) == len(set(ids)), lot_file.name
        for vp in data["viewpoints"]:
            for sid, poly in vp["outlines"].items():
                assert sid in ids, (lot_file.name, sid)
                assert len(poly) == 4, (lot_file.name, sid)
                inside = all(0.0 <= x <= 1.0 and 0.0 <= y <= 1.0 for x, y in poly)
                assert inside, (lot_file.name, sid)
        adapters = memory_adapters()
        result = seed_lot(adapters, data, b"ref")  # raises ValidationFailedError on errors
        assert result.spaces == len(ids) and result.published_version == 1
        repo = adapters.repository
        draft = load_draft(repo, repo.get_lot(data["lotId"]), utcnow())
        report = validate_draft(draft, repo.get_published_layout(data["lotId"]))
        assert report.ok and report.warnings == [], (lot_file.name, report)


def test_drone_lot_fixture_matches_layout():
    data = load_lot_file("drone-lot")
    assert len(data["spaces"]) == 124
    vp = data["viewpoints"][0]
    assert (vp["imageWidth"], vp["imageHeight"]) == (1982, 2000)
    fixture = Path(__file__).resolve().parents[2] / "eval" / "fixtures" / "drone-lot.jpg"
    assert fixture.exists()
