"""Admin snapshot list, detail and retry (US-06)."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Query
from parking_core.models import CarBox, JobStatus, Snapshot, effective_status

from ..deps import AdaptersDep, AdminDep, NowDep, error
from ..jobs import enqueue_job
from ..schemas import CarBoxOut, ErrorResponse, ObservationOut, SnapshotDetail, SnapshotOut

router = APIRouter(prefix="/admin/snapshots", tags=["admin"])


def snapshot_out(s: Snapshot, now: datetime) -> dict[str, object]:
    return {
        "image_id": s.image_id,
        "lot_id": s.lot_id,
        "view_id": s.view_id,
        "capture_time": s.capture_time,
        "job_status": effective_status(s, now),
        "attempts": s.attempts,
        "finished": s.finished,
        "processing_ms": s.processing_ms,
        "model_version": s.model_version,
        "error": s.error,
        "layout_version": s.layout_version,
        "created_at": s.created_at,
    }


@router.get(
    "",
    response_model=list[SnapshotOut],
    responses={401: {"model": ErrorResponse}, 403: {"model": ErrorResponse}},
    summary="Recent snapshots for a lot, newest capture first",
)
def list_snapshots(
    admin: AdminDep,
    adapters: AdaptersDep,
    now: NowDep,
    lot_id: str = Query(alias="lotId"),
    limit: int = Query(50, ge=1, le=200),
) -> list[SnapshotOut]:
    snaps = adapters.repository.list_snapshots(lot_id, limit=limit)
    snaps.sort(key=lambda s: s.capture_time, reverse=True)
    return [SnapshotOut(**snapshot_out(s, now)) for s in snaps]


@router.get(
    "/{image_id}",
    response_model=SnapshotDetail,
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
    },
    summary="One snapshot with its observations, car detections and a photo URL",
)
def get_snapshot(
    image_id: str, admin: AdminDep, adapters: AdaptersDep, now: NowDep
) -> SnapshotDetail:
    repo = adapters.repository
    snap = repo.get_snapshot(image_id)
    if snap is None:
        raise error(404, "not_found", "Snapshot not found")
    observations = [
        ObservationOut(
            space_id=o.space_id,
            state=o.state,
            acpds_score=o.acpds_score,
            car_overlap=o.car_overlap,
            in_frame=o.in_frame,
            polygon=o.polygon,
            car_boxes=[car_box_out(b) for b in o.car_boxes],
        )
        for o in repo.list_observations(image_id)
    ]
    store = adapters.object_store
    photo_url = store.presign_get(snap.s3_key) if store.exists(snap.s3_key) else None
    return SnapshotDetail(
        **snapshot_out(snap, now),
        observations=observations,
        detections=[car_box_out(b) for b in snap.detections],
        photo_url=photo_url,
    )


def car_box_out(box: CarBox) -> CarBoxOut:
    return CarBoxOut(cls_name=box.cls_name, conf=box.conf, box=list(box.box))


@router.post(
    "/{image_id}/retry",
    response_model=SnapshotOut,
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        409: {
            "model": ErrorResponse,
            "description": "not_retryable: job not finished or not FAILED",
        },
    },
    summary="Requeue a finished, failed job",
)
def retry_snapshot(
    image_id: str, admin: AdminDep, adapters: AdaptersDep, now: NowDep
) -> SnapshotOut:
    repo = adapters.repository
    snap = repo.get_snapshot(image_id)
    if snap is None:
        raise error(404, "not_found", "Snapshot not found")
    not_retryable = error(409, "not_retryable", "Only finished, failed jobs can be retried")
    if not (snap.finished and snap.job_status is JobStatus.FAILED):
        raise not_retryable
    moved = repo.transition_job(
        image_id,
        {JobStatus.FAILED},
        JobStatus.QUEUED,
        finished=False,
        attempts=0,
        error=None,
        queued_at=now,
    )
    if not moved:
        raise not_retryable
    enqueue_job(adapters, image_id)
    updated = repo.get_snapshot(image_id)
    assert updated is not None
    return SnapshotOut(**snapshot_out(updated, now))
