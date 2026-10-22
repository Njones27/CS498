"""ensure_resources sets the bucket CORS rule the browser upload needs."""

from __future__ import annotations

import boto3
from botocore.stub import Stubber
from parking_core.adapters import aws
from parking_core.settings import Settings


def test_ensure_bucket_creates_bucket_and_sets_cors(monkeypatch):
    settings = Settings(
        app_env="local",
        _env_file=None,
        s3_endpoint_url="http://localhost:9000",
        cors_allowed_origins=("http://localhost:5173",),
    )  # type: ignore[call-arg]
    client = boto3.client(
        "s3",
        region_name="us-east-1",
        aws_access_key_id="x",
        aws_secret_access_key="x",
        endpoint_url="http://localhost:9000",
    )
    stub = Stubber(client)
    stub.add_client_error(
        "create_bucket", service_error_code="BucketAlreadyOwnedByYou", http_status_code=409
    )
    stub.add_response(
        "put_bucket_cors",
        {},
        {
            "Bucket": settings.bucket_name,
            "CORSConfiguration": {
                "CORSRules": [
                    {
                        "AllowedOrigins": ["http://localhost:5173"],
                        "AllowedMethods": ["PUT", "GET", "HEAD"],
                        "AllowedHeaders": ["*"],
                        "ExposeHeaders": ["ETag"],
                        "MaxAgeSeconds": 3000,
                    }
                ]
            },
        },
    )
    monkeypatch.setattr(aws.boto3, "client", lambda *a, **k: client)
    with stub:
        aws._ensure_bucket(settings)
    stub.assert_no_pending_responses()
