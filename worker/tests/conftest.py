from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest
from parking_core.adapters.memory import build_memory_adapters
from parking_core.keys import layout_snapshot_key, raw_photo_key
from parking_core.models import (
    JobStatus,
    LayoutVersion,
    Lot,
    ParkingSpace,
    PublishedLayout,
    Rect,
    Snapshot,
    Viewpoint,
)
from parking_core.settings import Adapters, Settings

LOT = "lot-1"
T0 = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
V1_SPACES = ["A-01", "A-02", "A-03", "A-04", "B-01"]
V2_SPACES = ["B-01", "B-02", "B-03", "B-04"]
ALL_SPACES = sorted(set(V1_SPACES) | set(V2_SPACES))


def _square(i: int) -> list[tuple[float, float]]:
    x = 0.1 * i
    return [(x, 0.1), (x + 0.05, 0.1), (x + 0.05, 0.2), (x, 0.2)]


@dataclass
class World:
    adapters: Adapters

    @property
    def repo(self):
        return self.adapters.repository

    @property
    def queue(self):
        return self.adapters.queue

    def add_snapshot(
        self,
        image_id: str,
        view_id: str = "V1",
        capture_time: datetime = T0,
        data: bytes | None = None,
        enqueue: bool = True,
    ) -> Snapshot:
        data = data if data is not None else f"photo-{image_id}".encode()
        key = raw_photo_key(LOT, view_id, image_id)
        self.adapters.object_store.put(key, data, "image/jpeg")
        snap = Snapshot(
            image_id=image_id,
            lot_id=LOT,
            view_id=view_id,
            capture_time=capture_time,
            sha256=hashlib.sha256(data).hexdigest(),
            s3_key=key,
            content_type="image/jpeg",
            size_bytes=len(data),
            uploaded_by="admin@example.edu",
            job_status=JobStatus.QUEUED,
            created_at=capture_time,
            queued_at=capture_time,
        )
        self.repo.put_snapshot(snap)
        if enqueue:
            self.queue.send(json.dumps({"imageId": image_id}))
        return snap


def seed_lot(adapters: Adapters) -> None:
    repo = adapters.repository
    repo.put_lot(Lot(lot_id=LOT, name="Test Lot", created_at=T0 - timedelta(days=1)))
    spaces = [
        ParkingSpace(lot_id=LOT, space_id=s, label=s, rect=Rect(x=40 * i, y=0, w=30, h=60))
        for i, s in enumerate(ALL_SPACES)
    ]
    repo.put_spaces(spaces)
    viewpoints = [
        Viewpoint(
            lot_id=LOT,
            view_id=vid,
            name=vid,
            outlines={s: _square(i) for i, s in enumerate(ids)},
        )
        for vid, ids in (("V1", V1_SPACES), ("V2", V2_SPACES))
    ]
    for v in viewpoints:
        repo.put_viewpoint(v)
    layout = PublishedLayout(
        lot_id=LOT,
        version=1,
        spaces=spaces,
        viewpoints=viewpoints,
        published_at=T0 - timedelta(days=1),
        published_by="admin@example.edu",
    )
    key = layout_snapshot_key(LOT, 1)
    adapters.object_store.put(key, layout.model_dump_json().encode(), "application/json")
    repo.publish_layout(
        LOT,
        LayoutVersion(
            lot_id=LOT,
            version=1,
            published_by="admin@example.edu",
            published_at=T0 - timedelta(days=1),
            snapshot_key=key,
        ),
    )


@pytest.fixture
def world() -> World:
    adapters = build_memory_adapters(Settings(app_env="test", _env_file=None))
    seed_lot(adapters)
    return World(adapters)
