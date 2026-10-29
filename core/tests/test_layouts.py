"""Draft storage (brief §8.2): the Repository draft methods in both adapters, the draft-meta
item, `Viewpoint.outline_review`, and the helpers in `parking_core.layouts`."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from botocore.stub import Stubber
from parking_core import keys
from parking_core.adapters import aws
from parking_core.adapters.memory import MemoryObjectStore, MemoryRepository
from parking_core.layouts import ensure_draft_meta, new_draft_meta, published_space_ids
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
