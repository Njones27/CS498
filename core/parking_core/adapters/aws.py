"""boto3 adapters (MinIO / ElasticMQ / DynamoDB Local in Phase 1, AWS in Phase 2).

Only endpoint URLs differ between phases. The S3 client used for *presigning* is built with
`settings.s3_public_endpoint_url` when set, because the hostname is part of the signature.
"""

from __future__ import annotations

from ..settings import Adapters, Settings


def build_aws_adapters(settings: Settings) -> Adapters:
    raise NotImplementedError("AWS adapters land in the backend wave-1 PR")


def ensure_resources(settings: Settings) -> None:
    """Create the table (PK/SK, GSI1, TTL), bucket, queue and DLQ idempotently."""
    raise NotImplementedError("ensure_resources lands in the backend wave-1 PR")
