"""Draft storage (brief §8.2): the Repository draft methods in both adapters, the draft-meta
item, `Viewpoint.outline_review`, and the helpers in `parking_core.layouts`. Then validation
(§8.4), publish (§8.3), versions and restore (§4.3)."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from botocore.stub import Stubber
from parking_core import keys
from parking_core.adapters import aws
from parking_core.adapters.memory import MemoryObjectStore, MemoryRepository
from parking_core.layouts import (
    Draft,
    StaleRevisionError,
    ValidationFailedError,
    diff_draft,
    ensure_draft_meta,
    is_valid_quad,
    list_versions,
    load_draft,
    new_draft_meta,
    publish_draft,
    published_space_ids,
    restore_version,
    validate_draft,
)
from parking_core.models import (
    DraftMeta,
    LayoutVersion,
    Lot,
    OutlineReview,
    OutlineSource,
    OutlineStatus,
    ParkingSpace,
    PublishedLayout,
    Rect,
    Schematic,
    SpaceType,
    Viewpoint,
)
from parking_core.settings import Settings

NOW = datetime(2026, 10, 28, 14, 5, tzinfo=UTC)
AWS_SETTINGS = Settings(app_env="local", queue_url="http://sqs.local/q", _env_file=None)  # type: ignore[call-arg]


def meta(revision: int = 0, **kw) -> DraftMeta:
    return DraftMeta(lot_id="L", revision=revision, updated_at=NOW, **kw)


def space(space_id: str, retired: bool = False) -> ParkingSpace:
    return ParkingSpace(
        lot_id="L",
        space_id=space_id,
        label=space_id,
        rect=Rect(x=0, y=0, w=1, h=1),
        retired=retired,
    )


@pytest.fixture
def store():
    return MemoryObjectStore()


@pytest.fixture
def repo(store):
    return MemoryRepository(store)


@pytest.fixture
def aws_creds(monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")


def publish(repo, store, version: int, spaces: list[ParkingSpace], schematic=None) -> None:
    layout = PublishedLayout(
        lot_id="L",
        version=version,
        schematic=schematic or Schematic(),
        spaces=spaces,
        viewpoints=[],
        published_at=NOW,
        published_by="a",
    )
    key = keys.layout_snapshot_key("L", version)
    store.put(key, layout.model_dump_json().encode(), "application/json")
    repo.publish_layout(
        "L",
        LayoutVersion(
            lot_id="L", version=version, published_by="a", published_at=NOW, snapshot_key=key
        ),
    )


# --- memory adapter -------------------------------------------------------------


def test_draft_meta_conditional_write_memory(repo):
    assert repo.get_draft_meta("L") is None
    assert not repo.put_draft_meta(meta(1), expected_revision=0)  # nothing stored yet
    assert repo.put_draft_meta(meta(0), expected_revision=None)
    assert not repo.put_draft_meta(meta(0), expected_revision=None)  # already exists
    assert not repo.put_draft_meta(meta(1, updated_by="b"), expected_revision=5)  # stale
    assert repo.put_draft_meta(meta(1, updated_by="a"), expected_revision=0)
    stored = repo.get_draft_meta("L")
    assert stored == meta(1, updated_by="a")
    stored.revision = 99  # callers get copies
    assert repo.get_draft_meta("L").revision == 1
    assert repo.get_draft_meta("other") is None


def test_delete_space_memory(repo):
    repo.put_spaces([space("a"), space("b")])
    repo.delete_space("L", "a")
    repo.delete_space("L", "missing")  # no error
    assert [s.space_id for s in repo.list_spaces("L")] == ["b"]


def test_outline_review_round_trip_memory(repo):
    review = OutlineReview(source=OutlineSource.PROPOSED, status=OutlineStatus.PENDING)
    v = Viewpoint(lot_id="L", view_id="V1", name="N", outline_review={"a": review})
    repo.put_viewpoint(v)
    assert repo.get_viewpoint("L", "V1").outline_review == {"a": review}


# --- AWS adapter ----------------------------------------------------------------


def test_draft_meta_item_round_trip():
    m = meta(7, schematic=Schematic(width=1200.5, height=600), based_on_version=3, updated_by="a@x")
    item = aws.draft_meta_item(m)
    assert (item["PK"], item["SK"], item["entityType"]) == ("LOT#L", "DRAFT", "DraftMeta")
    assert item["revision"] == 7 and item["basedOnVersion"] == 3
    assert item["schematic"] == {"width": Decimal("1200.5"), "height": 600}
    assert item["updatedAt"] == "2026-10-28T14:05:00.000000Z"
    assert aws.item_to_model(item, DraftMeta) == m


def test_draft_meta_condition():
    assert aws.draft_meta_condition(None) == {"ConditionExpression": "attribute_not_exists(PK)"}
    assert aws.draft_meta_condition(4) == {
        "ConditionExpression": "#rev = :rev",
        "ExpressionAttributeNames": {"#rev": "revision"},
        "ExpressionAttributeValues": {":rev": 4},
    }


def test_draft_meta_dynamo(aws_creds):
    repo = aws.DynamoRepository(AWS_SETTINGS)
    table = AWS_SETTINGS.table_name
    key = {"PK": "LOT#L", "SK": "DRAFT"}
    with Stubber(repo._table.meta.client) as stub:
        stub.add_response("get_item", {}, {"TableName": table, "Key": key, "ConsistentRead": True})
        assert repo.get_draft_meta("L") is None
        stored = {
            "PK": {"S": "LOT#L"},
            "SK": {"S": "DRAFT"},
            "lotId": {"S": "L"},
            "schematic": {"M": {"width": {"N": "1000"}, "height": {"N": "600"}}},
            "revision": {"N": "2"},
            "basedOnVersion": {"NULL": True},
            "updatedAt": {"S": "2026-10-28T14:05:00.000000Z"},
            "updatedBy": {"S": "a@x"},
        }
        stub.add_response("get_item", {"Item": stored})
        assert repo.get_draft_meta("L") == meta(2, updated_by="a@x")

        new = meta(3, updated_by="a@x")
        stub.add_response(
            "put_item",
            {},
            {
                "TableName": table,
                "Item": aws.draft_meta_item(new),
                "ConditionExpression": "#rev = :rev",
                "ExpressionAttributeNames": {"#rev": "revision"},
                "ExpressionAttributeValues": {":rev": 2},
            },
        )
        assert repo.put_draft_meta(new, expected_revision=2)
        stub.add_client_error("put_item", service_error_code="ConditionalCheckFailedException")
        assert not repo.put_draft_meta(new, expected_revision=2)
        stub.add_client_error("put_item", service_error_code="InternalServerError")
        with pytest.raises(aws.ClientError):
            repo.put_draft_meta(new, expected_revision=2)
        stub.assert_no_pending_responses()


def test_delete_space_dynamo(aws_creds):
    repo = aws.DynamoRepository(AWS_SETTINGS)
    with Stubber(repo._table.meta.client) as stub:
        stub.add_response(
            "delete_item",
            {},
            {"TableName": AWS_SETTINGS.table_name, "Key": {"PK": "LOT#L", "SK": "SPACE#sp_1"}},
        )
        repo.delete_space("L", "sp_1")
        stub.assert_no_pending_responses()


def test_outline_review_round_trip_dynamo_items():
    review = OutlineReview(source=OutlineSource.DRAWN, status=OutlineStatus.ACCEPTED)
    v = Viewpoint(
        lot_id="L",
        view_id="V1",
        name="N",
        outlines={"a": [(0.1, 0.2), (0.3, 0.2), (0.3, 0.4), (0.1, 0.4)]},
        outline_review={"a": review},
    )
    item = aws.viewpoint_item(v)
    assert item["outlineReview"] == {"a": {"source": "drawn", "status": "accepted"}}
    assert aws.item_to_model(item, Viewpoint) == v
    # Viewpoints stored before outlineReview existed still load.
    old = {k: val for k, val in item.items() if k != "outlineReview"}
    assert aws.item_to_model(old, Viewpoint).outline_review == {}
    assert (
        Viewpoint.model_validate_json('{"lotId":"L","viewId":"V1","name":"N"}').outline_review == {}
    )


# --- parking_core.layouts --------------------------------------------------------


def test_new_draft_meta_defaults():
    lot = Lot(lot_id="L", name="Lot", created_at=NOW)
    m = new_draft_meta(lot, None, NOW)
    assert (m.revision, m.based_on_version, m.updated_by) == (0, None, None)
    assert m.schematic == Schematic(width=1000, height=600)


def test_ensure_draft_meta_from_published_layout(repo, store):
    repo.put_lot(Lot(lot_id="L", name="Lot", created_at=NOW))
    publish(repo, store, 1, [space("a")])
    publish(repo, store, 2, [space("a")], schematic=Schematic(width=800, height=400))
    lot = repo.get_lot("L")
    m = ensure_draft_meta(repo, lot, NOW)
    assert m.based_on_version == 2 and m.schematic == Schematic(width=800, height=400)
    assert repo.get_draft_meta("L") == m
    # Existing meta wins over the published layout.
    assert ensure_draft_meta(repo, lot, NOW + timedelta(hours=1)) == m


def test_ensure_draft_meta_with_missing_snapshot(repo):
    lot = Lot(lot_id="L", name="Lot", created_at=NOW, current_layout_version=3)
    repo.put_lot(lot)  # points at v3, but no snapshot object exists
    m = ensure_draft_meta(repo, lot, NOW)
    assert m.based_on_version is None and m.schematic == Schematic()


def test_ensure_draft_meta_lost_race(repo):
    lot = Lot(lot_id="L", name="Lot", created_at=NOW)
    theirs = meta(0, updated_by="other")
    real_put = repo.put_draft_meta

    def racing_put(m, expected_revision):
        real_put(theirs, None)  # another request creates it first
        return real_put(m, expected_revision)

    repo.put_draft_meta = racing_put
    assert ensure_draft_meta(repo, lot, NOW) == theirs


def test_published_space_ids_covers_every_version(repo, store):
    repo.put_lot(Lot(lot_id="L", name="Lot", created_at=NOW))
    assert published_space_ids(repo, store, "L") == set()
    publish(repo, store, 1, [space("a"), space("old")])
    publish(repo, store, 2, [space("a"), space("b", retired=True)])
    assert published_space_ids(repo, store, "L") == {"a", "b", "old"}


def test_published_space_ids_refuses_missing_snapshot(repo, store):
    repo.put_lot(Lot(lot_id="L", name="Lot", created_at=NOW))
    repo.publish_layout(
        "L",
        LayoutVersion(
            lot_id="L", version=1, published_by="a", published_at=NOW, snapshot_key="gone"
        ),
    )
    with pytest.raises(KeyError):
        published_space_ids(repo, store, "L")


# --- Validation (brief §8.4) -------------------------------------------------------

SQ = [(0.1, 0.1), (0.2, 0.1), (0.2, 0.2), (0.1, 0.2)]


def sq(i: int) -> list[tuple[float, float]]:
    """A small square outline, one per space, side by side on the photo."""
    x = 0.05 * i
    return [(x, 0.1), (x + 0.04, 0.1), (x + 0.04, 0.2), (x, 0.2)]


def sp(space_id: str, label: str | None = None, x: float = 0, **kw) -> ParkingSpace:
    return ParkingSpace(
        lot_id="L",
        space_id=space_id,
        label=space_id if label is None else label,
        rect=kw.pop("rect", Rect(x=x, y=0, w=50, h=80)),
        **kw,
    )


def vp(view_id: str, outlines: dict | None = None, photo: bool = True, **kw) -> Viewpoint:
    return Viewpoint(
        lot_id="L",
        view_id=view_id,
        name=view_id,
        reference_image_key=f"reference/L/{view_id}/abc.jpg" if photo else None,
        outlines=outlines or {},
        **kw,
    )


def mk(spaces: list[ParkingSpace], views: list[Viewpoint], schematic=None) -> Draft:
    return Draft(meta(schematic=schematic or Schematic()), spaces, views)


def clean() -> Draft:
    """Two spaces side by side, both outlined in V1, which has a photo."""
    return mk(
        [sp("A-01", x=0), sp("A-02", x=60)],
        [vp("V1", {"A-01": sq(0), "A-02": sq(1)})],
    )


def codes(issues) -> list[str]:
    return [i.code for i in issues]


def only(issues, code: str):
    found = [i for i in issues if i.code == code]
    assert len(found) == 1, issues
    return found[0]


def test_clean_draft_has_no_issues():
    report = validate_draft(clean(), None)
    assert report.ok
    assert (report.errors, report.warnings) == ([], [])
    assert report.compared_with is None


# US-09 #1: duplicate labels, an out-of-bounds polygon and unmapped spaces are each listed
# as an error or a warning (Sketch 6).
def test_validate_lists_problems_as_errors_and_warnings():
    d = mk(
        [sp("B-04", x=0), sp("sp_x", "B-04", x=60), sp("A-09", x=120)]
        + [sp(f"C-0{i}", x=200 + 60 * i) for i in range(1, 4)],
        [
            vp("V1", {"B-04": sq(0), "sp_x": sq(1)}),
            vp("V2", {"A-09": [(0.9, 0.1), (1.2, 0.1), (1.2, 0.3), (0.9, 0.3)]}),
        ],
    )
    report = validate_draft(d, None)
    assert not report.ok
    assert [(i.code, i.message) for i in report.errors] == [
        ("duplicate_label", "Two spaces share the label B-04"),
        ("polygon_outside_photo", "A-09 polygon is outside the V2 photo"),
    ]
    assert [(i.code, i.message) for i in report.warnings] == [
        ("unmapped_spaces", "3 spaces have no polygon in any view: they will show UNKNOWN"),
    ]
    assert report.errors[0].space_ids == ["B-04", "sp_x"]
    assert (report.errors[1].space_ids, report.errors[1].view_id) == (["A-09"], "V2")
    assert report.warnings[0].space_ids == ["C-01", "C-02", "C-03"]


def test_duplicate_label_is_case_insensitive_and_trimmed():
    d = clean()
    d.spaces[1].label = " a-01 "
    issue = only(validate_draft(d, None).errors, "duplicate_label")
    assert issue.message == "Two spaces share the label A-01"
    assert issue.space_ids == ["A-01", "A-02"]


def test_duplicate_label_ignores_retired_spaces():
    d = clean()
    d.spaces.append(sp("old", "A-01", x=500, retired=True))
    assert "duplicate_label" not in codes(validate_draft(d, None).errors)


def test_three_spaces_share_a_label():
    d = mk(
        [sp(sid, "B-04", x=60 * n) for n, sid in enumerate("abc")],
        [vp("V1", {"a": sq(0), "b": sq(1), "c": sq(2)})],
    )
    issue = only(validate_draft(d, None).errors, "duplicate_label")
    assert issue.message == "3 spaces share the label B-04"


def test_empty_label():
    d = clean()
    d.spaces[0].label = "   "
    issue = only(validate_draft(d, None).errors, "empty_label")
    assert (issue.message, issue.space_ids) == ("A space has no label", ["A-01"])
    d.spaces[1].label = ""
    assert only(validate_draft(d, None).errors, "empty_label").message == "2 spaces have no label"


@pytest.mark.parametrize(
    "corner",
    [(-0.01, 0.1), (1.01, 0.1), (0.1, -0.5), (0.1, 1.0001)],
    ids=["left", "right", "top", "bottom"],
)
def test_polygon_outside_photo(corner):
    d = clean()
    d.viewpoints[0].outlines["A-02"] = [corner, (0.3, 0.1), (0.3, 0.2), (0.2, 0.2)]
    issue = only(validate_draft(d, None).errors, "polygon_outside_photo")
    assert (issue.message, issue.space_ids, issue.view_id) == (
        "A-02 polygon is outside the V1 photo",
        ["A-02"],
        "V1",
    )


def test_polygon_on_the_photo_edge_is_inside():
    d = clean()
    d.viewpoints[0].outlines["A-02"] = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
    assert validate_draft(d, None).ok


@pytest.mark.parametrize(
    "polygon",
    [
        [(0.1, 0.1), (0.2, 0.1), (0.2, 0.2)],
        [(0.1, 0.1), (0.2, 0.1), (0.2, 0.2), (0.1, 0.2), (0.1, 0.15)],
        [(0.1, 0.1), (0.2, 0.1), (0.3, 0.1), (0.4, 0.1)],
        [(0.1, 0.1), (0.2, 0.2), (0.2, 0.1), (0.1, 0.2)],
        [(0.1, 0.1), (0.2, 0.1), (0.2, 0.1), (0.1, 0.2)],
        [(0.1, 0.1), (0.2, 0.1), (0.1, 0.1), (0.1, 0.2)],
    ],
    ids=["three-corners", "five-corners", "zero-area", "bowtie", "repeated-corner", "folded"],
)
def test_bad_polygon(polygon):
    assert not is_valid_quad(polygon)
    d = clean()
    d.viewpoints[0].outlines["A-02"] = polygon
    issue = only(validate_draft(d, None).errors, "bad_polygon")
    assert issue.message == "A-02 outline in V1 is not a valid four-sided shape"
    assert (issue.space_ids, issue.view_id) == (["A-02"], "V1")


@pytest.mark.parametrize(
    "polygon",
    [SQ, list(reversed(SQ)), [(0.1, 0.1), (0.3, 0.1), (0.2, 0.15), (0.2, 0.3)]],
    ids=["clockwise", "counter-clockwise", "concave"],
)
def test_valid_quads(polygon):
    assert is_valid_quad(polygon)


def test_outline_unknown_space():
    d = clean()
    d.viewpoints[0].outlines["ghost"] = SQ
    issue = only(validate_draft(d, None).errors, "outline_unknown_space")
    assert issue.message == "V1 has an outline for a space that does not exist"
    assert (issue.space_ids, issue.view_id) == (["ghost"], "V1")
    d.viewpoints[0].outlines["ghost2"] = [(5, 5)] * 4  # no geometry errors on top
    report = validate_draft(d, None)
    assert codes(report.errors) == ["outline_unknown_space"]
    assert report.errors[0].message == "V1 has outlines for 2 spaces that do not exist"


def test_outlines_without_photo():
    d = clean()
    d.viewpoints.append(vp("V2", {"A-01": SQ}, photo=False))
    issue = only(validate_draft(d, None).errors, "outlines_without_photo")
    assert (issue.message, issue.space_ids, issue.view_id) == (
        "V2 has outlines but no reference photo",
        ["A-01"],
        "V2",
    )


def test_viewpoint_without_photo_or_outlines_is_fine():
    d = clean()
    d.viewpoints.append(vp("V2", photo=False))
    report = validate_draft(d, None)
    assert report.ok and report.warnings == []


def review(status: str) -> OutlineReview:
    return OutlineReview(source=OutlineSource.PROPOSED, status=OutlineStatus(status))


def test_pending_proposals():
    d = mk(
        [sp(f"A-0{i}", x=60 * i) for i in range(1, 5)],
        [
            vp(
                "V1",
                {f"A-0{i}": sq(i) for i in range(1, 5)},
                outline_review={
                    "A-01": review("pending"),
                    "A-02": review("pending"),
                    "A-03": review("pending"),
                    "A-04": review("accepted"),
                    "gone": review("pending"),  # orphaned: its outline was deleted
                },
            )
        ],
    )
    issue = only(validate_draft(d, None).errors, "pending_proposals")
    assert issue.message == "3 proposed outlines are still waiting for review"
    assert (issue.space_ids, issue.view_id) == (["A-01", "A-02", "A-03"], "V1")


def test_pending_proposals_across_views():
    d = clean()
    d.viewpoints[0].outline_review = {"A-01": review("pending")}
    d.viewpoints.append(vp("V2", {"A-02": SQ}, outline_review={"A-02": review("pending")}))
    issue = only(validate_draft(d, None).errors, "pending_proposals")
    assert issue.message == "2 proposed outlines are still waiting for review"
    assert issue.view_id is None
    d.viewpoints[1].outline_review = {}
    issue = only(validate_draft(d, None).errors, "pending_proposals")
    assert issue.message == "1 proposed outline is still waiting for review"


@pytest.mark.parametrize(
    "rect",
    [Rect(x=-1, y=0, w=50, h=80), Rect(x=960, y=0, w=50, h=80), Rect(x=0, y=530, w=50, h=80)],
    ids=["left", "right", "bottom"],
)
def test_rect_outside_schematic(rect):
    d = clean()
    d.spaces.append(sp("B-10", rect=rect))
    d.viewpoints[0].outlines["B-10"] = sq(5)
    issue = only(validate_draft(d, None).errors, "rect_outside_schematic")
    assert (issue.message, issue.space_ids) == ("B-10 is outside the map area", ["B-10"])


def test_rect_on_the_schematic_edge_and_retired_rects_are_fine():
    d = clean()
    d.spaces.append(sp("edge", rect=Rect(x=950, y=520, w=50, h=80)))
    d.viewpoints[0].outlines["edge"] = sq(5)
    d.spaces.append(sp("gone", rect=Rect(x=5000, y=0, w=50, h=80), retired=True))
    assert validate_draft(d, None).ok


def test_no_active_spaces():
    d = mk([sp("A-01", retired=True)], [vp("V1")])
    issue = only(validate_draft(d, None).errors, "no_active_spaces")
    assert (issue.message, issue.space_ids) == ("The layout has no spaces", [])
    assert codes(validate_draft(mk([], []), None).errors) == ["no_active_spaces"]


# US-09 #3: warnings never block (report.ok stays True).
def test_unmapped_spaces_warning():
    d = clean()
    d.spaces.append(sp("A-03", x=120))
    report = validate_draft(d, None)
    assert report.ok
    issue = only(report.warnings, "unmapped_spaces")
    assert issue.message == "1 space has no polygon in any view: it will show UNKNOWN"
    assert issue.space_ids == ["A-03"]


def test_retired_with_outlines_warning():
    d = clean()
    d.spaces.append(sp("A-07", x=120, retired=True))
    d.viewpoints[0].outlines["A-07"] = sq(3)
    report = validate_draft(d, None)
    assert report.ok
    issue = only(report.warnings, "retired_with_outlines")
    assert (issue.message, issue.space_ids, issue.view_id) == (
        "A-07 is retired but still outlined in V1",
        ["A-07"],
        "V1",
    )
    d.viewpoints.append(vp("V2", {"A-07": SQ}))
    issue = only(validate_draft(d, None).warnings, "retired_with_outlines")
    assert issue.message == "A-07 is retired but still outlined in V1 and V2"
    assert issue.view_id is None


def test_viewpoint_without_outlines_warning():
    d = clean()
    d.viewpoints.append(vp("V3"))
    report = validate_draft(d, None)
    assert report.ok
    issue = only(report.warnings, "viewpoint_without_outlines")
    assert (issue.message, issue.view_id) == ("V3 has no outlined spaces", "V3")


def test_overlapping_rects_warning():
    d = clean()
    d.spaces[0].label = "A-03"
    d.spaces[1].label = "A-04"
    d.spaces[1].rect = Rect(x=40, y=0, w=50, h=80)
    report = validate_draft(d, None)
    assert report.ok
    issue = only(report.warnings, "overlapping_rects")
    assert issue.message == "A-03 and A-04 overlap on the map"
    assert issue.space_ids == ["A-01", "A-02"]


def test_touching_rects_do_not_overlap():
    d = clean()
    d.spaces[1].rect = Rect(x=50, y=0, w=50, h=80)  # shares an edge with A-01
    assert validate_draft(d, None).warnings == []


def published_of(d: Draft, version: int = 3) -> PublishedLayout:
    return PublishedLayout(
        lot_id="L",
        version=version,
        spaces=[s.model_copy(deep=True) for s in d.spaces],
        viewpoints=[v.model_copy(deep=True) for v in d.viewpoints],
        published_at=NOW,
        published_by="a",
    )


# Sketch 6: "Draft compared with v3".
def test_report_compares_with_the_published_version():
    d = clean()
    d.spaces.append(sp("gone", x=500, retired=True))
    published = published_of(d)
    assert validate_draft(d, published).diff.model_dump() == {
        "added": [],
        "retired": [],
        "changed": [],
    }

    d.spaces.append(sp("new", x=200))
    d.viewpoints[0].outlines["new"] = sq(4)
    d.spaces[0].retired = True  # A-01
    d.spaces[1].space_type = SpaceType.EV  # A-02
    d.spaces[2].retired = False  # "gone" is active again, so it counts as added
    report = validate_draft(d, published)
    assert report.compared_with == 3
    assert report.diff.model_dump() == {
        "added": ["gone", "new"],
        "retired": ["A-01"],
        "changed": ["A-02"],
    }


@pytest.mark.parametrize("edit", ["label", "rect", "outline", "outline-removed", "outline-added"])
def test_diff_changed(edit):
    d = clean()
    d.viewpoints.append(vp("V2"))
    published = published_of(d)
    if edit == "label":
        d.spaces[0].label = "A-1"
    elif edit == "rect":
        d.spaces[0].rect = Rect(x=1, y=0, w=50, h=80)
    elif edit == "outline":
        d.viewpoints[0].outlines["A-01"] = sq(7)
    elif edit == "outline-removed":
        del d.viewpoints[0].outlines["A-01"]
    else:
        d.viewpoints[1].outlines["A-01"] = SQ
    assert diff_draft(d, published).changed == ["A-01"]


def test_diff_against_nothing_published():
    assert diff_draft(clean(), None).model_dump() == {
        "added": ["A-01", "A-02"],
        "retired": [],
        "changed": [],
    }


def test_validate_draft_is_pure():
    d = clean()
    published = published_of(d)
    before = (d.meta.model_copy(deep=True), [s.model_copy(deep=True) for s in d.spaces])
    validate_draft(d, published)
    assert (d.meta, d.spaces) == before


# --- Publish, versions, restore (brief §8.3, §4.3) ------------------------------------


@pytest.fixture
def lot_l(repo, store):
    """Lot L at v1 with two spaces outlined in V1, and its draft saved up to revision 2."""
    repo.put_lot(Lot(lot_id="L", name="Lot", created_at=NOW))
    v1 = vp("V1", {"A-01": sq(0), "A-02": sq(1)})
    repo.put_spaces([sp("A-01", x=0), sp("A-02", x=60)])
    repo.put_viewpoint(v1)
    store.put(v1.reference_image_key, b"ref", "image/jpeg")
    first = publish_draft(repo, store, repo.get_lot("L"), 0, "seed", NOW - timedelta(days=1))
    assert first.version == 1
    m = repo.get_draft_meta("L")
    assert repo.put_draft_meta(m.model_copy(update={"revision": 2}), expected_revision=1)
    return repo.get_lot("L")


def stored(repo, lot) -> Draft:
    return load_draft(repo, lot, NOW)


# US-09 #4: publish makes the next version with the publisher and time; the lot points at it.
def test_publish_draft(repo, store, lot_l):
    repo.put_spaces([sp("A-03", x=120, retired=True)])
    v = publish_draft(repo, store, lot_l, 2, "admin@example.edu", NOW)
    assert (v.version, v.published_by, v.published_at) == (2, "admin@example.edu", NOW)
    assert v.snapshot_key == keys.layout_snapshot_key("L", 2)
    assert repo.get_lot("L").current_layout_version == 2
    layout = repo.get_published_layout("L")
    assert (layout.version, layout.published_by) == (2, "admin@example.edu")
    # Retired spaces stay in the snapshot; the reference key is copied as-is.
    assert [(s.space_id, s.retired) for s in layout.spaces] == [
        ("A-01", False),
        ("A-02", False),
        ("A-03", True),
    ]
    assert layout.viewpoint("V1").reference_image_key == "reference/L/V1/abc.jpg"
    m = repo.get_draft_meta("L")
    assert (m.revision, m.based_on_version) == (3, 2)


def test_publish_stale_revision_writes_nothing(repo, store, lot_l):
    with pytest.raises(StaleRevisionError):
        publish_draft(repo, store, lot_l, 1, "a", NOW)
    assert [v.version for v in repo.list_layout_versions("L")] == [1]
    assert repo.get_draft_meta("L").revision == 2


# US-09 #2: a draft with errors is not published.
def test_publish_with_errors_writes_nothing(repo, store, lot_l):
    repo.put_spaces([sp("A-02", "A-01", x=60)])
    with pytest.raises(ValidationFailedError) as exc:
        publish_draft(repo, store, lot_l, 2, "a", NOW)
    assert codes(exc.value.report.errors) == ["duplicate_label"]
    assert [v.version for v in repo.list_layout_versions("L")] == [1]
    assert repo.get_draft_meta("L").revision == 2


def test_publish_loses_race_on_the_draft_meta(repo, store, lot_l, monkeypatch):
    monkeypatch.setattr(repo, "put_draft_meta", lambda meta, expected_revision: False)
    with pytest.raises(StaleRevisionError):
        publish_draft(repo, store, lot_l, 2, "a", NOW)
    assert [v.version for v in repo.list_layout_versions("L")] == [1]
    assert not store.exists(keys.layout_snapshot_key("L", 2))


def test_versions_newest_first(repo, store, lot_l):
    publish_draft(repo, store, lot_l, 2, "b@x", NOW)
    publish_draft(repo, store, lot_l, 3, "c@x", NOW + timedelta(hours=1))
    assert [(v.version, v.published_by) for v in list_versions(repo, "L")] == [
        (3, "c@x"),
        (2, "b@x"),
        (1, "seed"),
    ]


def test_restore_replaces_the_draft(repo, store, lot_l):
    # v2 renames A-01, moves A-02's outline, adds viewpoint V2 and resizes the schematic.
    repo.put_spaces([sp("A-01", "First", x=0)])
    v1 = repo.get_viewpoint("L", "V1")
    repo.put_viewpoint(v1.model_copy(update={"outlines": {"A-01": sq(0), "A-02": sq(5)}}))
    repo.put_viewpoint(vp("V2", {"A-01": SQ}))
    m = repo.get_draft_meta("L")
    resized = m.model_copy(update={"schematic": Schematic(width=900, height=500)})
    assert repo.put_draft_meta(resized, expected_revision=2)
    publish_draft(repo, store, lot_l, 2, "a", NOW)

    d = restore_version(repo, store, lot_l, 1, "admin@example.edu", NOW + timedelta(hours=1))
    assert (d.meta.revision, d.meta.based_on_version) == (4, 1)
    assert d.meta.updated_by == "admin@example.edu"
    again = stored(repo, lot_l)
    assert again.meta == d.meta
    assert again.meta.schematic == Schematic()
    assert {s.space_id: s.label for s in again.spaces} == {"A-01": "A-01", "A-02": "A-02"}
    views = {v.view_id: v for v in again.viewpoints}
    assert views["V1"].outlines == {"A-01": sq(0), "A-02": sq(1)}
    # V2 is not in v1, but viewpoints are never removed: it stays, without outlines.
    assert views["V2"].outlines == {} and views["V2"].reference_image_key is not None


# Restore keeps a space that a later version published as retired, since published spaces are
# never deleted. A space that was never published is dropped.
def test_restore_keeps_later_published_spaces_as_retired(repo, store, lot_l):
    repo.put_spaces([sp("A-03", x=120)])
    v1 = repo.get_viewpoint("L", "V1")
    repo.put_viewpoint(v1.model_copy(update={"outlines": {**v1.outlines, "A-03": sq(2)}}))
    publish_draft(repo, store, lot_l, 2, "a", NOW)  # v2 adds A-03
    repo.put_spaces([sp("draft-only", x=200)])

    d = restore_version(repo, store, lot_l, 1, "a", NOW)
    by_id = {s.space_id: s for s in stored(repo, lot_l).spaces}
    assert set(by_id) == {"A-01", "A-02", "A-03"}
    assert by_id["A-03"].retired and not by_id["A-01"].retired
    assert "A-03" not in repo.get_viewpoint("L", "V1").outlines
    assert {s.space_id for s in d.spaces} == set(by_id)

    report = validate_draft(stored(repo, lot_l), repo.get_published_layout("L"))
    assert report.ok and report.diff.retired == ["A-03"]


def test_restore_unknown_version(repo, store, lot_l):
    with pytest.raises(LookupError):
        restore_version(repo, store, lot_l, 9, "a", NOW)


def test_restore_loses_race(repo, store, lot_l, monkeypatch):
    monkeypatch.setattr(repo, "put_draft_meta", lambda meta, expected_revision: False)
    with pytest.raises(StaleRevisionError):
        restore_version(repo, store, lot_l, 1, "a", NOW)
