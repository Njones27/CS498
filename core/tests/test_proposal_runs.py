"""Layout proposer runs in both adapters (HDD §4.6)."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest
from botocore.stub import Stubber
from parking_core import keys
from parking_core.adapters import aws
from parking_core.adapters.memory import MemoryRepository
from parking_core.models import (
    OutlineReview,
    ProposalJobMessage,
    ProposalRun,
    ProposalStatus,
    ProposedStall,
    Rect,
    Viewpoint,
)
from parking_core.settings import Settings

NOW = datetime(2026, 10, 30, 12, 0, tzinfo=UTC)
AWS_SETTINGS = Settings(app_env="local", queue_url="http://sqs.local/q", _env_file=None)  # type: ignore[call-arg]

STALL = ProposedStall(
    polygon=[(0.1, 0.2), (0.15, 0.2), (0.15, 0.3), (0.1, 0.3)],
    evidence=0.65,
    row=0,
    col=3,
    map_rect=Rect(x=0.05, y=0.0, w=0.05, h=0.1),
)


def run(run_id: str = "r1", status: ProposalStatus = ProposalStatus.QUEUED) -> ProposalRun:
    return ProposalRun(
        lot_id="L",
        view_id="V1",
        run_id=run_id,
        status=status,
        reference_image_key="reference/L/V1/abc",
        requested_by="admin@example.edu",
        requested_at=NOW,
    )


@pytest.fixture
def aws_creds(monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")


def test_proposal_run_round_trip_memory():
    repo = MemoryRepository()
    assert repo.get_proposal_run("L", "V1") is None
    repo.put_proposal_run(run())
    assert repo.get_proposal_run("L", "V1") == run()
    assert repo.get_proposal_run("L", "V2") is None
    repo.put_proposal_run(run("r2"))  # a new run replaces the old one
    stored = repo.get_proposal_run("L", "V1")
    assert stored is not None and stored.run_id == "r2"


def test_transition_proposal_run_memory():
    repo = MemoryRepository()
    repo.put_proposal_run(run())
    working = {ProposalStatus.QUEUED, ProposalStatus.FAILED}
    assert not repo.transition_proposal_run("L", "V1", "old", working, ProposalStatus.PROCESSING)
    assert not repo.transition_proposal_run("L", "V9", "r1", working, ProposalStatus.PROCESSING)
    assert repo.transition_proposal_run(
        "L", "V1", "r1", working, ProposalStatus.PROCESSING, attempts=1
    )
    # Already moved on: a second worker cannot claim it.
    assert not repo.transition_proposal_run("L", "V1", "r1", working, ProposalStatus.PROCESSING)
    assert repo.transition_proposal_run(
        "L",
        "V1",
        "r1",
        {ProposalStatus.PROCESSING},
        ProposalStatus.COMPLETE,
        proposals=[STALL],
        completed_at=NOW,
        model_version="proposer-1|lines",
    )
    stored = repo.get_proposal_run("L", "V1")
    assert stored is not None
    assert stored.status == ProposalStatus.COMPLETE
    assert stored.attempts == 1 and stored.proposals == [STALL]


@pytest.mark.parametrize("field", ["status", "nope"])
def test_transition_proposal_run_rejects_identity_fields(field):
    repo = MemoryRepository()
    with pytest.raises(ValueError, match=field):
        repo.transition_proposal_run(
            "L", "V1", "r1", {ProposalStatus.QUEUED}, ProposalStatus.FAILED, **{field: "x"}
        )


def test_proposal_run_item_round_trip():
    item = aws.proposal_run_item(run().model_copy(update={"proposals": [STALL]}))
    assert item["PK"] == "LOT#L" and item["SK"] == keys.proposal_sk("V1") == "PROPOSAL#V1"
    assert item["proposals"][0]["evidence"] == Decimal("0.65")
    back = aws.item_to_model(item, ProposalRun)
    assert back.proposals == [STALL]


def test_proposal_transition_update_expression():
    upd = aws.proposal_transition_update(
        "r1",
        {ProposalStatus.QUEUED, ProposalStatus.FAILED},
        ProposalStatus.PROCESSING,
        {"attempts": 2},
    )
    assert upd == {
        "UpdateExpression": "SET #st = :to, #f0 = :f0",
        "ConditionExpression": "attribute_exists(PK) AND #run = :run AND #st IN (:s0, :s1)",
        "ExpressionAttributeNames": {"#st": "status", "#run": "runId", "#f0": "attempts"},
        "ExpressionAttributeValues": {
            ":to": "PROCESSING",
            ":run": "r1",
            ":f0": 2,
            ":s0": "FAILED",
            ":s1": "QUEUED",
        },
    }


def test_proposal_run_dynamo(aws_creds):
    repo = aws.DynamoRepository(AWS_SETTINGS)
    key = {"PK": "LOT#L", "SK": "PROPOSAL#V1"}
    with Stubber(repo._table.meta.client) as stub:
        stub.add_response(
            "get_item",
            {},
            {"TableName": AWS_SETTINGS.table_name, "Key": key, "ConsistentRead": True},
        )
        assert repo.get_proposal_run("L", "V1") is None
        stub.add_response("put_item", {})
        repo.put_proposal_run(run())
        stub.add_response("update_item", {})
        assert repo.transition_proposal_run(
            "L", "V1", "r1", {ProposalStatus.QUEUED}, ProposalStatus.PROCESSING
        )
        stub.add_client_error("update_item", service_error_code="ConditionalCheckFailedException")
        assert not repo.transition_proposal_run(
            "L", "V1", "r1", {ProposalStatus.QUEUED}, ProposalStatus.PROCESSING
        )
        stub.assert_no_pending_responses()
    # No allowed statuses never matches, without a call.
    assert not repo.transition_proposal_run("L", "V1", "r1", set(), ProposalStatus.PROCESSING)


def test_proposal_job_message_is_told_apart():
    body = ProposalJobMessage(lot_id="L", view_id="V1", run_id="r1").model_dump_json()
    assert '"kind":"propose"' in body and '"runId":"r1"' in body


def test_outline_review_evidence_is_optional():
    old = Viewpoint.model_validate(
        {
            "lotId": "L",
            "viewId": "V1",
            "name": "x",
            "outlineReview": {"A": {"source": "drawn", "status": "accepted"}},
        }
    )
    assert old.outline_review["A"].evidence is None
    with pytest.raises(ValueError):
        OutlineReview(source="proposed", status="pending", evidence=1.5)  # type: ignore[arg-type]
