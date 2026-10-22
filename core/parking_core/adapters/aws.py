"""boto3 adapters (RustFS / ElasticMQ / DynamoDB Local in Phase 1, AWS in Phase 2).

Only endpoint URLs differ between phases. The S3 client used for *presigning* is built with
`settings.s3_public_endpoint_url` when set, because the hostname is part of the signature.

DynamoDB is a single table (HDD §5.2) keyed by the builders in `keys.py`. Items are the
model's camelCase fields plus PK/SK (and GSI1 keys for snapshots). Datetimes are stored as
fixed-width UTC ISO strings (`2026-01-01T12:00:00.000000Z`) so string comparison in
condition expressions and GSI1 sort order match chronological order.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from datetime import UTC, datetime
from decimal import Decimal
from enum import Enum
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key
from botocore.config import Config
from botocore.exceptions import ClientError, ParamValidationError
from pydantic import BaseModel
from pydantic.alias_generators import to_camel

from .. import keys as k
from ..auth import HS256Verifier
from ..errors import NotPublishedError
from ..models import (
    CarBox,
    ClaimResult,
    Closure,
    JobStatus,
    LayoutVersion,
    Lot,
    Message,
    ObjectInfo,
    ParkingSpace,
    PublishedLayout,
    Snapshot,
    SpaceObservation,
    SpaceStatus,
    Viewpoint,
)
from ..settings import Adapters, Settings

TYPE_ATTR = "entityType"
TTL_ATTR = "expiresAt"
_KEY_ATTRS = {k.PK, k.SK, k.GSI1PK, k.GSI1SK, TYPE_ATTR, TTL_ATTR}


# --- item (de)serialization ---------------------------------------------------


def format_dt(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def to_dynamo(value: Any) -> Any:
    """Python value -> something boto3's TypeSerializer accepts (floats become Decimal)."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, datetime):
        return format_dt(value)
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, int | str | Decimal):
        return value
    if isinstance(value, BaseModel):
        return to_dynamo(value.model_dump(by_alias=True))
    if isinstance(value, dict):
        return {str(key): to_dynamo(v) for key, v in value.items()}
    if isinstance(value, list | tuple):
        return [to_dynamo(v) for v in value]
    raise TypeError(f"cannot store {type(value).__name__} in DynamoDB")


def from_dynamo(value: Any) -> Any:
    """Inverse of `to_dynamo` for what boto3's TypeDeserializer returns."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {key: from_dynamo(v) for key, v in value.items()}
    if isinstance(value, list | set):
        return [from_dynamo(v) for v in value]
    return value


def model_to_item(model: BaseModel, pk: str, sk: str, **extra: Any) -> dict[str, Any]:
    item = to_dynamo(model.model_dump(by_alias=True))
    item.update({k.PK: pk, k.SK: sk, TYPE_ATTR: type(model).__name__})
    item.update({key: to_dynamo(v) for key, v in extra.items()})
    return item


def item_to_model[M: BaseModel](item: dict[str, Any], cls: type[M]) -> M:
    data = {key: v for key, v in from_dynamo(item).items() if key not in _KEY_ATTRS}
    return cls.model_validate(data)


def lot_item(lot: Lot) -> dict[str, Any]:
    gpk, gsk = k.gsi1_lot(lot.lot_id)
    return model_to_item(lot, k.lot_pk(lot.lot_id), k.META, **{k.GSI1PK: gpk, k.GSI1SK: gsk})


def space_item(space: ParkingSpace) -> dict[str, Any]:
    return model_to_item(space, k.lot_pk(space.lot_id), k.space_sk(space.space_id))


def viewpoint_item(view: Viewpoint) -> dict[str, Any]:
    return model_to_item(view, k.lot_pk(view.lot_id), k.view_sk(view.view_id))


def layout_item(layout: LayoutVersion) -> dict[str, Any]:
    return model_to_item(layout, k.lot_pk(layout.lot_id), k.layout_sk(layout.version))


def snapshot_item(snap: Snapshot) -> dict[str, Any]:
    gpk, gsk = k.gsi1_snapshot(snap.lot_id, snap.capture_time, snap.image_id)
    return model_to_item(snap, k.image_pk(snap.image_id), k.META, **{k.GSI1PK: gpk, k.GSI1SK: gsk})


def observation_item(obs: SpaceObservation) -> dict[str, Any]:
    return model_to_item(obs, k.image_pk(obs.image_id), k.obs_sk(obs.space_id))


DETECTIONS_TYPE = "Detections"


def detections_item(image_id: str, detections: list[CarBox]) -> dict[str, Any]:
    return {
        k.PK: k.image_pk(image_id),
        k.SK: k.detections_sk(),
        TYPE_ATTR: DETECTIONS_TYPE,
        "imageId": image_id,
        "detections": to_dynamo(detections),
    }


def item_to_detections(item: dict[str, Any] | None) -> list[CarBox]:
    if not item:
        return []
    return [CarBox.model_validate(d) for d in from_dynamo(item.get("detections", []))]


def status_item(status: SpaceStatus) -> dict[str, Any]:
    return model_to_item(status, k.lot_pk(status.lot_id), k.status_sk(status.space_id))


def closure_item(closure: Closure) -> dict[str, Any]:
    return model_to_item(closure, k.lot_pk(closure.lot_id), k.closure_sk(closure.closure_id))


def is_conditional_failure(exc: ClientError) -> bool:
    code = exc.response.get("Error", {}).get("Code", "")
    if code == "ConditionalCheckFailedException":
        return True
    if code == "TransactionCanceledException":
        reasons = exc.response.get("CancellationReasons", [])
        return any(r.get("Code") == "ConditionalCheckFailed" for r in reasons)
    return False


# --- S3 ----------------------------------------------------------------------


class S3ObjectStore:
    def __init__(self, settings: Settings) -> None:
        cfg = Config(signature_version="s3v4", s3={"addressing_style": "path"})
        self._bucket = settings.bucket_name
        self._client = boto3.client(
            "s3", region_name=settings.aws_region, endpoint_url=settings.s3_endpoint_url, config=cfg
        )
        self._signer = (
            boto3.client(
                "s3",
                region_name=settings.aws_region,
                endpoint_url=settings.s3_public_endpoint_url,
                config=cfg,
            )
            if settings.s3_public_endpoint_url
            else self._client
        )

    def put(self, key: str, data: bytes, content_type: str) -> None:
        self._client.put_object(Bucket=self._bucket, Key=key, Body=data, ContentType=content_type)

    def get(self, key: str) -> bytes:
        try:
            return self._client.get_object(Bucket=self._bucket, Key=key)["Body"].read()
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"NoSuchKey", "404"}:
                raise KeyError(key) from exc
            raise

    def exists(self, key: str) -> bool:
        return self.head(key) is not None

    def head(self, key: str) -> ObjectInfo | None:
        try:
            resp = self._client.head_object(Bucket=self._bucket, Key=key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
                return None
            raise
        return ObjectInfo(
            size_bytes=int(resp["ContentLength"]),
            content_type=resp.get("ContentType", "binary/octet-stream"),
        )

    def presign_put(self, key: str, content_type: str, expires_seconds: int = 300) -> str:
        return self._signer.generate_presigned_url(
            "put_object",
            Params={"Bucket": self._bucket, "Key": key, "ContentType": content_type},
            ExpiresIn=expires_seconds,
        )

    def presign_get(self, key: str, expires_seconds: int = 300) -> str:
        return self._signer.generate_presigned_url(
            "get_object", Params={"Bucket": self._bucket, "Key": key}, ExpiresIn=expires_seconds
        )


# --- SQS ---------------------------------------------------------------------


class SqsJobQueue:
    def __init__(self, settings: Settings) -> None:
        self._client = boto3.client(
            "sqs", region_name=settings.aws_region, endpoint_url=settings.sqs_endpoint_url
        )
        self._url = (
            settings.queue_url
            or self._client.get_queue_url(QueueName=settings.queue_name)["QueueUrl"]
        )

    def send(self, body: str) -> None:
        self._client.send_message(QueueUrl=self._url, MessageBody=body)

    def receive(self, max_messages: int = 1, wait_seconds: int = 10) -> list[Message]:
        kwargs = receive_kwargs(self._url, max_messages, wait_seconds)
        try:
            resp = self._client.receive_message(**kwargs)
        except ParamValidationError:
            # Older botocore without MessageSystemAttributeNames: use the deprecated name.
            kwargs["AttributeNames"] = kwargs.pop("MessageSystemAttributeNames")
            resp = self._client.receive_message(**kwargs)
        return [
            Message(
                body=m["Body"],
                receipt=m["ReceiptHandle"],
                receive_count=int(m.get("Attributes", {}).get("ApproximateReceiveCount", 1)),
            )
            for m in resp.get("Messages", [])
        ]

    def delete(self, receipt: str) -> None:
        self._client.delete_message(QueueUrl=self._url, ReceiptHandle=receipt)


SQS_MAX_WAIT_SECONDS = 20
QUEUE_VISIBILITY_TIMEOUT_SECONDS = 120


def receive_kwargs(queue_url: str, max_messages: int, wait_seconds: int) -> dict[str, Any]:
    """ReceiveMessage kwargs with SQS limits applied (1-10 messages, 0-20 s long poll)."""
    return {
        "QueueUrl": queue_url,
        "MaxNumberOfMessages": max(1, min(max_messages, 10)),
        "WaitTimeSeconds": max(0, min(wait_seconds, SQS_MAX_WAIT_SECONDS)),
        "MessageSystemAttributeNames": ["ApproximateReceiveCount"],
    }


# --- DynamoDB ----------------------------------------------------------------


class DynamoRepository:
    def __init__(self, settings: Settings, object_store: S3ObjectStore | None = None) -> None:
        self._resource = boto3.resource(
            "dynamodb", region_name=settings.aws_region, endpoint_url=settings.dynamodb_endpoint_url
        )
        self._table = self._resource.Table(settings.table_name)
        self._table_name = settings.table_name
        self._store = object_store

    # helpers
    def _get(self, pk: str, sk: str) -> dict[str, Any] | None:
        return self._table.get_item(Key={k.PK: pk, k.SK: sk}, ConsistentRead=True).get("Item")

    def _query_prefix(self, pk: str, prefix: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {
            "KeyConditionExpression": Key(k.PK).eq(pk) & Key(k.SK).begins_with(prefix),
            "ConsistentRead": True,
        }
        while True:
            resp = self._table.query(**kwargs)
            items.extend(resp.get("Items", []))
            if "LastEvaluatedKey" not in resp:
                return items
            kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]

    def _put_many(self, items: Iterable[dict[str, Any]]) -> None:
        with self._table.batch_writer(overwrite_by_pkeys=[k.PK, k.SK]) as batch:
            for item in items:
                batch.put_item(Item=item)

    # Lots and layouts
    def put_lot(self, lot: Lot) -> None:
        self._table.put_item(Item=lot_item(lot))

    def get_lot(self, lot_id: str) -> Lot | None:
        item = self._get(k.lot_pk(lot_id), k.META)
        return item_to_model(item, Lot) if item else None

    def list_lots(self) -> list[Lot]:
        items: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {
            "IndexName": k.GSI1,
            "KeyConditionExpression": Key(k.GSI1PK).eq(k.LOTS_INDEX_PK),
        }
        while True:
            resp = self._table.query(**kwargs)
            items.extend(resp.get("Items", []))
            if "LastEvaluatedKey" not in resp:
                break
            kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
        return [item_to_model(i, Lot) for i in items]

    def put_spaces(self, spaces: Iterable[ParkingSpace]) -> None:
        self._put_many(space_item(s) for s in spaces)

    def list_spaces(self, lot_id: str) -> list[ParkingSpace]:
        return [
            item_to_model(i, ParkingSpace) for i in self._query_prefix(k.lot_pk(lot_id), "SPACE#")
        ]

    def put_viewpoint(self, viewpoint: Viewpoint) -> None:
        self._table.put_item(Item=viewpoint_item(viewpoint))

    def get_viewpoint(self, lot_id: str, view_id: str) -> Viewpoint | None:
        item = self._get(k.lot_pk(lot_id), k.view_sk(view_id))
        return item_to_model(item, Viewpoint) if item else None

    def list_viewpoints(self, lot_id: str) -> list[Viewpoint]:
        return [item_to_model(i, Viewpoint) for i in self._query_prefix(k.lot_pk(lot_id), "VIEW#")]

    def put_layout_version(self, layout: LayoutVersion) -> None:
        self._table.put_item(Item=layout_item(layout))

    def list_layout_versions(self, lot_id: str) -> list[LayoutVersion]:
        items = self._query_prefix(k.lot_pk(lot_id), "LAYOUT#")
        return sorted((item_to_model(i, LayoutVersion) for i in items), key=lambda v: v.version)

    def publish_layout(self, lot_id: str, layout: LayoutVersion) -> None:
        client = self._resource.meta.client
        try:
            client.transact_write_items(
                TransactItems=[
                    {"Put": {"TableName": self._table_name, "Item": layout_item(layout)}},
                    {
                        "Update": {
                            "TableName": self._table_name,
                            "Key": {k.PK: k.lot_pk(lot_id), k.SK: k.META},
                            "UpdateExpression": "SET currentLayoutVersion = :v",
                            "ConditionExpression": "attribute_exists(PK)",
                            "ExpressionAttributeValues": {":v": layout.version},
                        }
                    },
                ]
            )
        except ClientError as exc:
            # The only condition in the transaction is that the lot item exists.
            if is_conditional_failure(exc):
                raise LookupError(f"Cannot publish a layout for unknown lot {lot_id!r}") from exc
            raise

    def get_published_layout(self, lot_id: str) -> PublishedLayout | None:
        lot = self.get_lot(lot_id)
        if lot is None or lot.current_layout_version is None:
            return None
        key = k.layout_snapshot_key(lot_id, lot.current_layout_version)
        if self._store is None:
            raise NotPublishedError("no object store configured for layout snapshots")
        try:
            raw = self._store.get(key)
        except KeyError as exc:
            raise NotPublishedError(f"layout snapshot missing: {key}") from exc
        return PublishedLayout.model_validate_json(raw)

    # Snapshots and jobs
    def put_snapshot(self, snapshot: Snapshot) -> None:
        self._table.put_item(Item=snapshot_item(snapshot))

    def get_snapshot(self, image_id: str) -> Snapshot | None:
        item = self._get(k.image_pk(image_id), k.META)
        return item_to_model(item, Snapshot) if item else None

    def list_snapshots(self, lot_id: str, limit: int = 50) -> list[Snapshot]:
        resp = self._table.query(
            IndexName=k.GSI1,
            KeyConditionExpression=Key(k.GSI1PK).eq(k.lot_pk(lot_id)),
            ScanIndexForward=False,
            Limit=limit,
        )
        return [item_to_model(i, Snapshot) for i in resp.get("Items", [])]

    def get_latest_snapshot(self, lot_id: str) -> Snapshot | None:
        items = self.list_snapshots(lot_id, limit=1)
        return items[0] if items else None

    def transition_job(
        self,
        image_id: str,
        from_states: set[JobStatus],
        to_state: JobStatus,
        **fields: object,
    ) -> bool:
        if not from_states:
            return False
        unknown = set(fields) - set(Snapshot.model_fields)
        if unknown:
            raise ValueError(f"unknown snapshot fields: {sorted(unknown)}")
        update = transition_update(from_states, to_state, fields)
        try:
            self._table.update_item(
                Key={k.PK: k.image_pk(image_id), k.SK: k.META},
                **update,
            )
            return True
        except ClientError as exc:
            if is_conditional_failure(exc):
                return False
            raise

    # Duplicate detection
    def claim_hash(
        self, sha256: str, image_id: str, claimed_at: datetime | None = None
    ) -> ClaimResult:
        try:
            self._table.put_item(
                Item={
                    k.PK: k.hash_pk(sha256),
                    k.SK: k.META,
                    TYPE_ATTR: "HashClaim",
                    "imageId": image_id,
                    "claimedAt": format_dt(claimed_at or datetime.now(UTC)),
                },
                ConditionExpression="attribute_not_exists(PK)",
            )
            return ClaimResult(claimed=True)
        except ClientError as exc:
            if not is_conditional_failure(exc):
                raise
        item = self._get(k.hash_pk(sha256), k.META) or {}
        raw_at = item.get("claimedAt")
        return ClaimResult(
            claimed=False,
            original_image_id=item.get("imageId"),
            claimed_at=datetime.fromisoformat(raw_at) if raw_at else None,
        )

    def takeover_hash(
        self,
        sha256: str,
        old_image_id: str,
        new_image_id: str,
        claimed_at: datetime | None = None,
    ) -> bool:
        try:
            self._table.update_item(
                Key={k.PK: k.hash_pk(sha256), k.SK: k.META},
                UpdateExpression="SET imageId = :new, claimedAt = :at",
                ConditionExpression="imageId = :old",
                ExpressionAttributeValues={
                    ":new": new_image_id,
                    ":old": old_image_id,
                    ":at": format_dt(claimed_at or datetime.now(UTC)),
                },
            )
            return True
        except ClientError as exc:
            if is_conditional_failure(exc):
                return False
            raise

    def release_hash(self, sha256: str, image_id: str) -> bool:
        try:
            self._table.delete_item(
                Key={k.PK: k.hash_pk(sha256), k.SK: k.META},
                ConditionExpression="imageId = :id",
                ExpressionAttributeValues={":id": image_id},
            )
            return True
        except ClientError as exc:
            if is_conditional_failure(exc):
                return False
            raise

    # Observations and status
    def put_observations(self, observations: Iterable[SpaceObservation]) -> None:
        self._put_many(observation_item(o) for o in observations)

    def list_observations(self, image_id: str) -> list[SpaceObservation]:
        items = self._query_prefix(k.image_pk(image_id), "OBS#")
        return [item_to_model(i, SpaceObservation) for i in items]

    def put_detections(self, image_id: str, detections: list[CarBox]) -> None:
        self._table.put_item(Item=detections_item(image_id, detections))

    def get_detections(self, image_id: str) -> list[CarBox]:
        return item_to_detections(self._get(k.image_pk(image_id), k.detections_sk()))

    def update_status_if_newer(self, status: SpaceStatus) -> bool:
        try:
            self._table.put_item(
                Item=status_item(status),
                ConditionExpression="attribute_not_exists(observedAt) OR observedAt < :new",
                ExpressionAttributeValues={":new": format_dt(status.observed_at)},
            )
            return True
        except ClientError as exc:
            if is_conditional_failure(exc):
                return False
            raise

    def get_statuses(self, lot_id: str) -> list[SpaceStatus]:
        items = self._query_prefix(k.lot_pk(lot_id), "STATUS#")
        return [item_to_model(i, SpaceStatus) for i in items]

    # Closures
    def put_closure(self, closure: Closure) -> None:
        self._table.put_item(Item=closure_item(closure))

    def list_closures(self, lot_id: str) -> list[Closure]:
        return [item_to_model(i, Closure) for i in self._query_prefix(k.lot_pk(lot_id), "CLOSURE#")]


def transition_update(
    from_states: set[JobStatus], to_state: JobStatus, fields: dict[str, object]
) -> dict[str, Any]:
    """UpdateItem kwargs for `transition_job` (pure, so it is unit-testable)."""
    names: dict[str, str] = {"#js": "jobStatus"}
    values: dict[str, Any] = {":to": to_state.value}
    sets = ["#js = :to"]
    for i, (name, value) in enumerate(sorted(fields.items())):
        names[f"#f{i}"] = to_camel(name)
        values[f":f{i}"] = to_dynamo(value)
        sets.append(f"#f{i} = :f{i}")
    placeholders = []
    for i, state in enumerate(sorted(s.value for s in from_states)):
        values[f":s{i}"] = state
        placeholders.append(f":s{i}")
    return {
        "UpdateExpression": "SET " + ", ".join(sets),
        "ConditionExpression": f"attribute_exists(PK) AND #js IN ({', '.join(placeholders)})",
        "ExpressionAttributeNames": names,
        "ExpressionAttributeValues": values,
    }


def build_aws_adapters(settings: Settings) -> Adapters:
    if settings.auth_mode == "cognito":
        raise NotImplementedError("Cognito verifier arrives in Phase 2")
    store = S3ObjectStore(settings)
    return Adapters(
        object_store=store,
        queue=SqsJobQueue(settings),
        repository=DynamoRepository(settings, store),
        auth_verifier=HS256Verifier(settings.jwt_secret),
    )


# --- resources ---------------------------------------------------------------


def _error_code(exc: ClientError) -> str:
    return exc.response.get("Error", {}).get("Code", "")


def ensure_resources(settings: Settings) -> None:
    """Create the table (PK/SK, GSI1, TTL), bucket, queue and DLQ idempotently."""
    _ensure_table(settings)
    _ensure_bucket(settings)
    _ensure_queues(settings)


def _ensure_table(settings: Settings) -> None:
    client = boto3.client(
        "dynamodb", region_name=settings.aws_region, endpoint_url=settings.dynamodb_endpoint_url
    )
    try:
        client.create_table(
            TableName=settings.table_name,
            BillingMode="PAY_PER_REQUEST",
            AttributeDefinitions=[
                {"AttributeName": name, "AttributeType": "S"}
                for name in (k.PK, k.SK, k.GSI1PK, k.GSI1SK)
            ],
            KeySchema=[
                {"AttributeName": k.PK, "KeyType": "HASH"},
                {"AttributeName": k.SK, "KeyType": "RANGE"},
            ],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": k.GSI1,
                    "KeySchema": [
                        {"AttributeName": k.GSI1PK, "KeyType": "HASH"},
                        {"AttributeName": k.GSI1SK, "KeyType": "RANGE"},
                    ],
                    "Projection": {"ProjectionType": "ALL"},
                }
            ],
        )
    except ClientError as exc:
        if _error_code(exc) != "ResourceInUseException":
            raise
    client.get_waiter("table_exists").wait(TableName=settings.table_name)
    try:
        client.update_time_to_live(
            TableName=settings.table_name,
            TimeToLiveSpecification={"Enabled": True, "AttributeName": TTL_ATTR},
        )
    except ClientError as exc:
        # Already enabled (ValidationException) or unsupported by the emulator.
        if _error_code(exc) not in {"ValidationException", "UnknownOperationException"}:
            raise


def _ensure_bucket(settings: Settings) -> None:
    client = boto3.client(
        "s3", region_name=settings.aws_region, endpoint_url=settings.s3_endpoint_url
    )
    kwargs: dict[str, Any] = {"Bucket": settings.bucket_name}
    if settings.aws_region != "us-east-1":
        kwargs["CreateBucketConfiguration"] = {"LocationConstraint": settings.aws_region}
    try:
        client.create_bucket(**kwargs)
    except ClientError as exc:
        if _error_code(exc) not in {"BucketAlreadyOwnedByYou", "BucketAlreadyExists"}:
            raise
    # Browsers PUT photos straight to presigned URLs, so the bucket must allow the web
    # origin. Set through the S3 API so the same code works on RustFS and on AWS S3.
    client.put_bucket_cors(
        Bucket=settings.bucket_name,
        CORSConfiguration={"CORSRules": [bucket_cors_rule(settings)]},
    )


def bucket_cors_rule(settings: Settings) -> dict[str, Any]:
    return {
        "AllowedOrigins": list(settings.cors_allowed_origins),
        "AllowedMethods": ["PUT", "GET", "HEAD"],
        "AllowedHeaders": ["*"],
        "ExposeHeaders": ["ETag"],
        "MaxAgeSeconds": 3000,
    }


def _ensure_queues(settings: Settings) -> None:
    client = boto3.client(
        "sqs", region_name=settings.aws_region, endpoint_url=settings.sqs_endpoint_url
    )
    dlq_url = client.create_queue(QueueName=f"{settings.queue_name}-dlq")["QueueUrl"]
    dlq_arn = client.get_queue_attributes(QueueUrl=dlq_url, AttributeNames=["QueueArn"])[
        "Attributes"
    ]["QueueArn"]
    attrs = {
        "RedrivePolicy": json.dumps({"deadLetterTargetArn": dlq_arn, "maxReceiveCount": "3"}),
        "VisibilityTimeout": str(QUEUE_VISIBILITY_TIMEOUT_SECONDS),
    }
    try:
        client.create_queue(QueueName=settings.queue_name, Attributes=attrs)
    except ClientError as exc:
        if _error_code(exc) not in {"QueueAlreadyExists", "QueueNameExists"}:
            raise
        url = client.get_queue_url(QueueName=settings.queue_name)["QueueUrl"]
        client.set_queue_attributes(QueueUrl=url, Attributes=attrs)
