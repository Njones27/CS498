from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from botocore.exceptions import ParamValidationError
from botocore.stub import ANY, Stubber
from parking_core.adapters import aws
from parking_core.adapters.memory import (
    MemoryJobQueue,
    MemoryObjectStore,
    MemoryRepository,
    build_memory_adapters,
    image_id_from_raw_key,
)
from parking_core.errors import NotPublishedError
from parking_core.keys import layout_snapshot_key, raw_photo_key
from parking_core.models import (
    CarBox,
    JobStatus,
    LayoutVersion,
    Lot,
    OutlineReview,
    ParkingSpace,
    PublishedLayout,
    Rect,
    Snapshot,
    SpaceObservation,
    SpaceState,
    SpaceStatus,
    Viewpoint,
)
from parking_core.settings import Settings

NOW = datetime(2026, 10, 21, 12, 0, tzinfo=UTC)


def snap(image_id="i1", minutes=0, status=JobStatus.UPLOAD_PENDING):
    return Snapshot(
        image_id=image_id,
        lot_id="L",
        view_id="v",
        capture_time=NOW + timedelta(minutes=minutes),
        sha256="a" * 64,
        s3_key=raw_photo_key("L", "v", image_id),
        content_type="image/jpeg",
        size_bytes=10,
        uploaded_by="admin@x.edu",
        job_status=status,
        created_at=NOW,
    )


def status(observed_at, state=SpaceState.FREE):
    return SpaceStatus(
        lot_id="L",
        space_id="s1",
        state=state,
        confidence=0.2,
        observed_at=observed_at,
        source_image_id="x",
    )


@pytest.fixture
def repo():
    return MemoryRepository(MemoryObjectStore())


def test_update_status_if_newer(repo):
    assert repo.update_status_if_newer(status(NOW))
    assert not repo.update_status_if_newer(status(NOW, SpaceState.OCCUPIED))  # equal
    assert not repo.update_status_if_newer(status(NOW - timedelta(seconds=1)))  # older
    assert repo.get_statuses("L")[0].state is SpaceState.FREE
    assert repo.update_status_if_newer(status(NOW + timedelta(seconds=1), SpaceState.OCCUPIED))
    assert repo.get_statuses("L")[0].state is SpaceState.OCCUPIED


def test_claim_and_takeover(repo):
    assert repo.claim_hash("h", "a").claimed
    conflict = repo.claim_hash("h", "b")
    assert not conflict.claimed and conflict.original_image_id == "a"
    assert not repo.takeover_hash("h", "zzz", "b")
    assert repo.takeover_hash("h", "a", "b")
    assert not repo.takeover_hash("h", "a", "c")  # no longer points at a
    assert repo.claim_hash("h", "d").original_image_id == "b"


def test_transition_job(repo):
    repo.put_snapshot(snap())
    assert not repo.transition_job("missing", {JobStatus.UPLOAD_PENDING}, JobStatus.QUEUED)
    assert not repo.transition_job("i1", {JobStatus.QUEUED}, JobStatus.PROCESSING)
    assert repo.transition_job(
        "i1", {JobStatus.UPLOAD_PENDING}, JobStatus.QUEUED, queued_at=NOW, attempts=0
    )
    assert repo.transition_job(
        "i1",
        {JobStatus.QUEUED, JobStatus.PROCESSING},
        JobStatus.FAILED,
        error="Too few matches",
        finished=True,
        attempts=1,
    )
    s = repo.get_snapshot("i1")
    assert s.job_status is JobStatus.FAILED and s.finished and s.error == "Too few matches"
    assert s.queued_at == NOW and s.attempts == 1
    with pytest.raises(ValueError):
        repo.transition_job("i1", {JobStatus.FAILED}, JobStatus.QUEUED, bogus=1)


def test_snapshots_order(repo):
    repo.put_snapshot(snap("old", -10))
    repo.put_snapshot(snap("new", 5))
    repo.put_snapshot(snap("mid", 0))
    assert [s.image_id for s in repo.list_snapshots("L")] == ["new", "mid", "old"]
    assert repo.list_snapshots("L", limit=1)[0].image_id == "new"
    assert repo.get_latest_snapshot("L").image_id == "new"
    assert repo.get_latest_snapshot("other") is None


def test_published_layout():
    store = MemoryObjectStore()
    repo = MemoryRepository(store)
    repo.put_lot(Lot(lot_id="L", name="Lot", created_at=NOW))
    assert repo.get_published_layout("L") is None
    assert repo.get_published_layout("nope") is None
    layout = PublishedLayout(
        lot_id="L",
        version=1,
        spaces=[ParkingSpace(lot_id="L", space_id="s1", label="1", rect=Rect(x=0, y=0, w=1, h=1))],
        viewpoints=[],
        published_at=NOW,
        published_by="a",
    )
    key = layout_snapshot_key("L", 1)
    version = LayoutVersion(
        lot_id="L", version=1, published_by="a", published_at=NOW, snapshot_key=key
    )
    repo.publish_layout("L", version)
    assert repo.get_lot("L").current_layout_version == 1
    with pytest.raises(NotPublishedError):
        repo.get_published_layout("L")
    store.put(key, layout.model_dump_json().encode(), "application/json")
    assert repo.get_published_layout("L") == layout
    assert [v.version for v in repo.list_layout_versions("L")] == [1]


def test_queue_receive_count_and_visibility():
    q = MemoryJobQueue(visibility_timeout=30)
    q.send("a")
    q.send("b")
    first = q.receive(max_messages=1)
    assert [(m.body, m.receive_count) for m in first] == [("a", 1)]
    second = q.receive(max_messages=5)
    assert [m.body for m in second] == ["b"]
    assert q.receive() == []  # both in flight
    q.advance(31)
    again = q.receive(max_messages=5)
    assert [(m.body, m.receive_count) for m in again] == [("a", 2), ("b", 2)]
    q.delete(first[0].receipt)  # stale receipt does nothing
    assert len(q) == 2
    q.delete(again[0].receipt)
    q.requeue_inflight()
    assert [(m.body, m.receive_count) for m in q.receive(5)] == [("b", 3)]


def test_object_store_test_upload():
    adapters = build_memory_adapters(Settings(app_env="test", _env_file=None))
    store = adapters.object_store
    key = raw_photo_key("L", "v", "img-1", "png")
    assert image_id_from_raw_key(key) == "img-1"
    assert store.presign_put(key, "image/png") == "/api/_test/uploads/img-1"
    assert not store.put_for_image("unknown", b"x", "image/png")
    assert store.put_for_image("img-1", b"data", "image/png")
    assert store.exists(key) and store.get(key) == b"data"
    with pytest.raises(ValueError):
        image_id_from_raw_key("layouts/L/v1.json")


# --- aws item (de)serialization ----------------------------------------------


def test_snapshot_item_round_trip():
    s = snap().model_copy(update={"processing_ms": 12, "completed_at": NOW})
    item = aws.snapshot_item(s)
    assert item["PK"] == "IMG#i1" and item["SK"] == "META"
    assert item["GSI1PK"] == "LOT#L"
    assert item["GSI1SK"] == "2026-10-21T12:00:00.000000#i1"
    assert item["captureTime"] == "2026-10-21T12:00:00.000000Z"
    assert item["jobStatus"] == "UPLOAD_PENDING"
    assert aws.item_to_model(item, Snapshot) == s


def test_float_fields_become_decimal_and_back():
    v = Viewpoint(
        lot_id="L",
        view_id="v",
        name="North",
        outlines={"s1": [(0.1, 0.2), (0.3, 0.4), (0.5, 0.25)]},
        camera_height_m=4.5,
    )
    item = aws.viewpoint_item(v)
    assert item["SK"] == "VIEW#v"
    assert item["outlines"]["s1"][0] == [Decimal("0.1"), Decimal("0.2")]
    assert item["cameraHeightM"] == Decimal("4.5")
    assert aws.item_to_model(item, Viewpoint) == v

    obs = SpaceObservation(
        image_id="i",
        lot_id="L",
        space_id="s1",
        state=SpaceState.FREE,
        acpds_score=0.12,
        car_overlap=None,
        capture_time=NOW,
    )
    assert aws.item_to_model(aws.observation_item(obs), SpaceObservation) == obs
    st = status(NOW)
    assert aws.status_item(st)["SK"] == "STATUS#s1"
    assert aws.item_to_model(aws.status_item(st), SpaceStatus) == st


BOX = CarBox(cls_name="car", conf=0.87, box=(0.1, 0.2, 0.35, 0.5))
TRUCK = CarBox(cls_name="truck", conf=0.4, box=(0.6, 0.6, 0.9, 1.0))


def overlay_observation() -> SpaceObservation:
    return SpaceObservation(
        image_id="i1",
        lot_id="L",
        space_id="s1",
        state=SpaceState.OCCUPIED,
        acpds_score=0.93,
        car_overlap=0.71,
        capture_time=NOW,
        polygon=[(0.1, 0.2), (0.3, 0.2), (0.3, 0.45), (0.1, 0.45)],
    )


def test_overlay_fields_round_trip_memory(repo):
    assert repo.get_detections("i1") == []  # nothing stored yet
    repo.put_detections("i1", [BOX, TRUCK])
    assert repo.get_detections("i1") == [BOX, TRUCK]
    repo.put_detections("i1", [TRUCK])  # a re-run overwrites
    assert repo.get_detections("i1") == [TRUCK]
    obs = overlay_observation()
    repo.put_observations([obs])
    assert repo.list_observations("i1") == [obs]  # the DET# data is not an observation


def test_overlay_fields_round_trip_dynamo_items():
    item = aws.detections_item("i1", [BOX, TRUCK])
    assert (item["PK"], item["SK"], item["entityType"]) == ("IMG#i1", "DET#", "Detections")
    assert item["detections"][0] == {
        "clsName": "car",
        "conf": Decimal("0.87"),
        "box": [Decimal("0.1"), Decimal("0.2"), Decimal("0.35"), Decimal("0.5")],
    }
    assert aws.item_to_detections(item) == [BOX, TRUCK]
    assert aws.item_to_detections(None) == []
    assert "detections" not in aws.snapshot_item(snap())  # never on the snapshot item

    obs = overlay_observation()
    item = aws.observation_item(obs)
    assert item["polygon"][1] == [Decimal("0.3"), Decimal("0.2")]
    assert aws.item_to_model(item, SpaceObservation) == obs
    # Items written before the overlay existed still load.
    old = {k: v for k, v in item.items() if k != "polygon"}
    assert aws.item_to_model(old, SpaceObservation).polygon is None


def test_detections_dynamo_get_and_put(aws_creds):
    repo = aws.DynamoRepository(AWS_SETTINGS)
    key = {"PK": "IMG#i1", "SK": "DET#"}
    with Stubber(repo._table.meta.client) as stub:
        stub.add_response(
            "get_item",
            {},
            {"TableName": AWS_SETTINGS.table_name, "Key": key, "ConsistentRead": True},
        )
        assert repo.get_detections("i1") == []  # missing item
        stored = {
            "PK": {"S": "IMG#i1"},
            "SK": {"S": "DET#"},
            "detections": {
                "L": [
                    {
                        "M": {
                            "clsName": {"S": "car"},
                            "conf": {"N": "0.87"},
                            "box": {"L": [{"N": v} for v in ("0.1", "0.2", "0.35", "0.5")]},
                        }
                    }
                ]
            },
        }
        stub.add_response("get_item", {"Item": stored})
        assert repo.get_detections("i1") == [BOX]
        stub.add_response("put_item", {})
        repo.put_detections("i1", [BOX])
        stub.assert_no_pending_responses()


def test_memory_presign_get_points_at_test_route():
    store = MemoryObjectStore()
    key = raw_photo_key("L", "v", "img-1")
    assert store.presign_get(key) == f"/api/_test/objects/{key}"


def test_format_dt_is_sortable():
    a = aws.format_dt(NOW)
    b = aws.format_dt(NOW + timedelta(microseconds=500))
    c = aws.format_dt(NOW + timedelta(seconds=1))
    assert a < b < c
    assert aws.format_dt(NOW.astimezone(timezone(timedelta(hours=-5)))) == a
    assert aws.format_dt(datetime(2026, 1, 1)) == "2026-01-01T00:00:00.000000Z"


def test_transition_update_expression():
    upd = aws.transition_update(
        {JobStatus.QUEUED, JobStatus.PROCESSING}, JobStatus.FAILED, {"error": "x", "attempts": 3}
    )
    assert upd["ConditionExpression"] == "attribute_exists(PK) AND #js IN (:s0, :s1)"
    assert upd["ExpressionAttributeValues"][":s0"] == "PROCESSING"
    assert upd["ExpressionAttributeValues"][":to"] == "FAILED"
    assert upd["ExpressionAttributeNames"]["#f0"] == "attempts"
    assert upd["ExpressionAttributeNames"]["#f1"] == "error"
    assert upd["UpdateExpression"] == "SET #js = :to, #f0 = :f0, #f1 = :f1"


def test_lot_item_keys():
    lot = Lot(lot_id="L", name="Lot", created_at=NOW, current_layout_version=2)
    item = aws.lot_item(lot)
    assert (item["PK"], item["SK"]) == ("LOT#L", "META")
    assert (item["GSI1PK"], item["GSI1SK"]) == ("LOTS", "L")
    assert aws.item_to_model(item, Lot) == lot


# --- release_hash, head, publish_layout, SQS, cognito -------------------------


def test_release_hash(repo):
    assert repo.claim_hash("h", "a", claimed_at=NOW).claimed
    conflict = repo.claim_hash("h", "b")
    assert conflict.original_image_id == "a" and conflict.claimed_at == NOW
    assert not repo.release_hash("h", "b")  # not the owner
    assert repo.release_hash("h", "a")
    assert not repo.release_hash("h", "a")  # already gone
    assert repo.claim_hash("h", "b").claimed


def test_memory_head():
    store = MemoryObjectStore()
    assert store.head("k") is None
    store.put("k", b"12345", "image/png")
    info = store.head("k")
    assert info is not None and (info.size_bytes, info.content_type) == (5, "image/png")


def test_update_viewpoint_sets_only_the_given_fields(repo):
    outlines = {"s1": [(0.1, 0.1), (0.2, 0.1), (0.2, 0.2), (0.1, 0.2)]}
    repo.put_viewpoint(
        Viewpoint(lot_id="L", view_id="V1", name="North", outlines=outlines, camera_height_m=4.0)
    )
    assert repo.update_viewpoint(
        "L", "V1", reference_image_key="reference/L/V1/abc", image_width=640, image_height=360
    )
    vp = repo.get_viewpoint("L", "V1")
    assert (vp.reference_image_key, vp.image_width, vp.image_height) == (
        "reference/L/V1/abc",
        640,
        360,
    )
    assert (vp.name, vp.outlines, vp.camera_height_m) == ("North", outlines, 4.0)

    assert not repo.update_viewpoint("L", "V9", name="x")  # never creates one
    assert repo.get_viewpoint("L", "V9") is None
    with pytest.raises(ValueError, match="view_id"):
        repo.update_viewpoint("L", "V1", view_id="V2")
    with pytest.raises(ValueError, match="none given"):
        repo.update_viewpoint("L", "V1")


def test_viewpoint_update_expression():
    upd = aws.viewpoint_update(
        {
            "outlines": {"s1": [(0.1, 0.2)]},
            "outline_review": {"s1": OutlineReview(source="drawn", status="accepted")},
        }
    )
    assert upd["UpdateExpression"] == "SET #f0 = :f0, #f1 = :f1"
    assert upd["ConditionExpression"] == "attribute_exists(PK)"
    assert upd["ExpressionAttributeNames"] == {"#f0": "outlineReview", "#f1": "outlines"}
    assert upd["ExpressionAttributeValues"] == {
        ":f0": {"s1": {"source": "drawn", "status": "accepted"}},
        ":f1": {"s1": [[Decimal("0.1"), Decimal("0.2")]]},
    }
    with pytest.raises(ValueError, match="lot_id"):
        aws.viewpoint_update({"lot_id": "M"})


def test_update_viewpoint_dynamo(aws_creds):
    repo = aws.DynamoRepository(AWS_SETTINGS)
    with Stubber(repo._table.meta.client) as stub:
        stub.add_response(
            "update_item",
            {},
            {
                "TableName": AWS_SETTINGS.table_name,
                "Key": {"PK": "LOT#L", "SK": "VIEW#V1"},
                "UpdateExpression": "SET #f0 = :f0, #f1 = :f1",
                "ConditionExpression": "attribute_exists(PK)",
                "ExpressionAttributeNames": {"#f0": "imageWidth", "#f1": "referenceImageKey"},
                "ExpressionAttributeValues": {":f0": 640, ":f1": "reference/x"},
            },
        )
        stub.add_client_error("update_item", service_error_code="ConditionalCheckFailedException")
        assert repo.update_viewpoint("L", "V1", reference_image_key="reference/x", image_width=640)
        assert not repo.update_viewpoint("L", "V9", image_width=640)
        stub.assert_no_pending_responses()


def _version(lot_id: str) -> LayoutVersion:
    return LayoutVersion(
        lot_id=lot_id, version=1, published_by="a", published_at=NOW, snapshot_key="x"
    )


def test_publish_layout_unknown_lot_memory(repo):
    with pytest.raises(LookupError, match="unknown lot 'nope'"):
        repo.publish_layout("nope", _version("nope"))


AWS_SETTINGS = Settings(app_env="local", queue_url="http://sqs.local/q", _env_file=None)  # type: ignore[call-arg]


@pytest.fixture
def aws_creds(monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")


def test_publish_layout_unknown_lot_dynamo(aws_creds):
    repo = aws.DynamoRepository(AWS_SETTINGS)
    with Stubber(repo._resource.meta.client) as stub:
        stub.add_client_error(
            "transact_write_items",
            service_error_code="TransactionCanceledException",
            modeled_fields={
                "CancellationReasons": [{"Code": "None"}, {"Code": "ConditionalCheckFailed"}]
            },
        )
        with pytest.raises(LookupError, match="unknown lot 'nope'"):
            repo.publish_layout("nope", _version("nope"))


def test_put_lot_if_absent_memory(repo):
    first = Lot(lot_id="L", name="Lot", created_at=NOW, current_layout_version=2)
    assert repo.put_lot_if_absent(first)
    assert not repo.put_lot_if_absent(Lot(lot_id="L", name="Other", created_at=NOW))
    assert repo.get_lot("L") == first  # the published pointer survives


def test_put_lot_if_absent_dynamo(aws_creds):
    repo = aws.DynamoRepository(AWS_SETTINGS)
    lot = Lot(lot_id="L", name="Lot", created_at=NOW)
    expected = {
        "TableName": AWS_SETTINGS.table_name,
        "Item": ANY,
        "ConditionExpression": "attribute_not_exists(PK)",
    }
    with Stubber(repo._table.meta.client) as stub:
        stub.add_response("put_item", {}, expected)
        stub.add_client_error(
            "put_item",
            service_error_code="ConditionalCheckFailedException",
            expected_params=expected,
        )
        assert repo.put_lot_if_absent(lot)
        assert not repo.put_lot_if_absent(lot)
        stub.assert_no_pending_responses()


def test_release_hash_dynamo(aws_creds):
    repo = aws.DynamoRepository(AWS_SETTINGS)
    with Stubber(repo._table.meta.client) as stub:
        stub.add_response("delete_item", {})
        stub.add_client_error("delete_item", service_error_code="ConditionalCheckFailedException")
        assert repo.release_hash("h", "a")
        assert not repo.release_hash("h", "a")


def test_s3_head(aws_creds):
    store = aws.S3ObjectStore(AWS_SETTINGS)
    with Stubber(store._client) as stub:
        stub.add_response("head_object", {"ContentLength": 42, "ContentType": "image/jpeg"})
        stub.add_client_error("head_object", service_error_code="404", http_status_code=404)
        info = store.head("raw/L/v/i.jpg")
        assert info is not None and (info.size_bytes, info.content_type) == (42, "image/jpeg")
        assert store.head("raw/L/v/missing.jpg") is None


def test_receive_kwargs_clamp():
    kw = aws.receive_kwargs("u", max_messages=50, wait_seconds=60)
    assert kw["MaxNumberOfMessages"] == 10 and kw["WaitTimeSeconds"] == 20
    assert kw["MessageSystemAttributeNames"] == ["ApproximateReceiveCount"]
    assert "AttributeNames" not in kw
    kw = aws.receive_kwargs("u", max_messages=0, wait_seconds=-1)
    assert kw["MaxNumberOfMessages"] == 1 and kw["WaitTimeSeconds"] == 0


def test_sqs_receive_falls_back_to_attribute_names(aws_creds):
    calls: list[dict] = []

    class OldClient:
        def receive_message(self, **kwargs):
            calls.append(dict(kwargs))
            if "MessageSystemAttributeNames" in kwargs:
                raise ParamValidationError(report="unknown parameter")
            attrs = {"ApproximateReceiveCount": "2"}
            return {"Messages": [{"Body": "b", "ReceiptHandle": "r", "Attributes": attrs}]}

    q = aws.SqsJobQueue(AWS_SETTINGS)
    q._client = OldClient()
    [m] = q.receive(wait_seconds=30)
    assert (m.body, m.receive_count) == ("b", 2)
    assert calls[-1]["AttributeNames"] == ["ApproximateReceiveCount"]
    assert calls[-1]["WaitTimeSeconds"] == 20


def test_build_aws_adapters_rejects_cognito():
    s = Settings(app_env="local", auth_mode="cognito", _env_file=None)  # type: ignore[call-arg]
    with pytest.raises(NotImplementedError, match="Phase 2"):
        aws.build_aws_adapters(s)


def _versioned(observed_at, version, state=SpaceState.FREE):
    return status(observed_at, state).model_copy(update={"layout_version": version})


def test_same_photo_rescored_with_a_newer_layout_replaces_the_status(repo):
    assert repo.update_status_if_newer(status(NOW))  # stored before statuses carried a version
    assert repo.update_status_if_newer(_versioned(NOW, 1, SpaceState.OCCUPIED))  # tie, versioned
    assert not repo.update_status_if_newer(_versioned(NOW, 1))  # tie, same version: first wins
    assert repo.update_status_if_newer(_versioned(NOW, 2))  # tie, newer layout: re-score wins
    assert not repo.update_status_if_newer(_versioned(NOW, 1, SpaceState.OCCUPIED))
    assert not repo.update_status_if_newer(_versioned(NOW - timedelta(seconds=1), 9))  # older
    assert repo.get_statuses("L")[0].state is SpaceState.FREE
    assert repo.get_statuses("L")[0].layout_version == 2


def test_status_condition_expression():
    assert aws.status_condition(status(NOW)) == {
        "ConditionExpression": "attribute_not_exists(observedAt) OR observedAt < :new",
        "ExpressionAttributeValues": {":new": aws.format_dt(NOW)},
    }
    cond = aws.status_condition(_versioned(NOW, 3))
    assert cond["ExpressionAttributeValues"] == {":new": aws.format_dt(NOW), ":ver": 3}
    assert (
        "observedAt = :new AND (attribute_not_exists(layoutVersion) OR layoutVersion < :ver)"
        in (cond["ConditionExpression"])
    )
    # A status without a version stores no layoutVersion attribute, so the tie check sees none.
    assert "layoutVersion" not in aws.status_item(status(NOW))
    assert aws.status_item(_versioned(NOW, 3))["layoutVersion"] == 3
