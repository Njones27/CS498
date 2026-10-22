"""Environment configuration (HDD §7.2). The only place that picks local vs AWS."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .interfaces import AuthVerifier, JobQueue, ObjectStore, Repository
from .models import Cutoffs


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: Literal["local", "aws", "test"] = "local"
    """local: boto3 against the compose emulators. aws: boto3 defaults. test: in-memory."""
    auth_mode: Literal["dev", "cognito"] = "dev"
    detector: Literal["stub", "acpds_yolo"] = "stub"

    aws_region: str = "us-east-1"
    s3_endpoint_url: str | None = None
    s3_public_endpoint_url: str | None = None
    """Used only to sign browser-facing URLs (the hostname is part of the signature)."""
    sqs_endpoint_url: str | None = None
    dynamodb_endpoint_url: str | None = None

    bucket_name: str = "parking-local"
    queue_name: str = "parking-jobs"
    queue_url: str | None = None
    table_name: str = "parking"

    jwt_secret: str = "dev-only-change-me"
    jwt_ttl_minutes: int = 60
    dev_admin_email: str = "admin@example.edu"
    dev_admin_password: str = "admin-password"
    dev_user_email: str = "viewer@example.edu"
    dev_user_password: str = "viewer-password"

    cutoff_low: float = 0.3
    cutoff_high: float = 0.7
    cutoff_overlap: float = 0.30
    cutoff_margin: float = 0.05
    require_car_check: bool = True

    upload_url_ttl_seconds: int = 300
    max_upload_bytes: int = 15 * 1024 * 1024
    allowed_upload_types: tuple[str, ...] = Field(default=("image/jpeg", "image/png"))
    cors_allowed_origins: tuple[str, ...] = Field(default=("http://localhost:5173",))
    """Browser origins allowed to PUT to presigned URLs; written to the bucket's CORS rules."""

    aligner: Literal["identity", "orb"] = "identity"
    """identity: photo assumed to match the reference. orb: ORB + RANSAC homography (HDD §4.4)."""
    orb_features: int = 2000
    orb_min_matches: int = 30
    orb_min_inliers: int = 25
    orb_min_inlier_ratio: float = 0.4
    """RANSAC inliers / good matches below this reject the photo (wrong spot, US-12 #1)."""
    orb_ransac_px: float = 5.0

    @model_validator(mode="after")
    def _guard_production(self) -> Settings:
        if self.app_env == "aws":
            if self.auth_mode == "dev":
                raise ValueError("AUTH_MODE=dev is not allowed with APP_ENV=aws")
            if self.jwt_secret == "dev-only-change-me":
                raise ValueError("JWT_SECRET must be set when APP_ENV=aws")
        if not self.cutoff_low < self.cutoff_high:
            raise ValueError("CUTOFF_LOW must be below CUTOFF_HIGH")
        return self

    @property
    def cutoffs(self) -> Cutoffs:
        return Cutoffs(
            low=self.cutoff_low,
            high=self.cutoff_high,
            overlap=self.cutoff_overlap,
            margin=self.cutoff_margin,
            require_car_check=self.require_car_check,
        )


@dataclass
class Adapters:
    object_store: ObjectStore
    queue: JobQueue
    repository: Repository
    auth_verifier: AuthVerifier


def build_adapters(settings: Settings) -> Adapters:
    """Pick implementations from settings. `test` -> memory adapters, else boto3 (NFR-7).

    Implemented by the backend wave-1 work in `parking_core.adapters`.
    """
    if settings.app_env == "test":
        from .adapters.memory import build_memory_adapters

        return build_memory_adapters(settings)
    from .adapters.aws import build_aws_adapters

    return build_aws_adapters(settings)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
