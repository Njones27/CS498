"""Public driver routes (HDD §6.1). Bodies are filled in by the backend wave-1 work."""

from __future__ import annotations

from fastapi import APIRouter

from ..deps import AdaptersDep, SettingsDep, error
from ..schemas import ErrorResponse, HealthResponse, LotDetail, LotListItem, LotStatusOut

router = APIRouter(tags=["public"])

NOT_IMPLEMENTED = error(501, "not_implemented", "Contract stub")


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse()


@router.get("/lots", response_model=list[LotListItem], summary="List published lots")
def list_lots(adapters: AdaptersDep, settings: SettingsDep) -> list[LotListItem]:
    raise NOT_IMPLEMENTED


@router.get(
    "/lots/{lot_id}",
    response_model=LotDetail,
    responses={404: {"model": ErrorResponse}},
    summary="Lot details, published schematic layout and viewpoints",
)
def get_lot(lot_id: str, adapters: AdaptersDep) -> LotDetail:
    raise NOT_IMPLEMENTED


@router.get(
    "/lots/{lot_id}/status",
    response_model=LotStatusOut,
    responses={404: {"model": ErrorResponse}},
    summary="Current state of every space (HDD §6.2)",
)
def get_status(lot_id: str, adapters: AdaptersDep) -> LotStatusOut:
    raise NOT_IMPLEMENTED
