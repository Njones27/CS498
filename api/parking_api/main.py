"""FastAPI application factory. Run with `uvicorn parking_api.main:create_app --factory`."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from parking_core.models import utcnow
from parking_core.settings import Adapters, Settings, get_settings
from starlette.exceptions import HTTPException as StarletteHTTPException

from .routes import auth, closures, layout, public, reference, snapshots, testonly, uploads
from .schemas import ErrorResponse

API_VERSION = "0.1.0"


def create_app(settings: Settings | None = None, adapters: Adapters | None = None) -> FastAPI:
    """Build the app. Pass `adapters` to inject fakes; else they are built lazily from settings."""
    settings = settings or get_settings()
    app = FastAPI(
        title="Parking Availability API",
        version=API_VERSION,
        description="REST contract between the web app and the backend (HDD §6.1).",
        responses={422: {"model": ErrorResponse, "description": "validation_error"}},
    )
    app.state.settings = settings
    app.state.adapters = adapters
    app.state.now = utcnow
    app.include_router(public.router)
    app.include_router(auth.router)
    app.include_router(uploads.router)
    app.include_router(snapshots.router)
    app.include_router(closures.router)
    app.include_router(layout.router)
    app.include_router(reference.router)
    if settings.app_env == "test":
        app.include_router(testonly.router)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        detail = exc.detail
        body = (
            detail if isinstance(detail, dict) else {"error": "http_error", "message": str(detail)}
        )
        return JSONResponse(status_code=exc.status_code, content=body)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "error": "validation_error",
                "message": "Invalid request",
                "details": jsonable_encoder(exc.errors()),
            },
        )

    return app
