# Parking Availability Web App (CS 498, Fall 2026)

Turns periodic photos of outdoor parking lots into a simple map of open and occupied spaces.
Design docs live in `Docs/` (High-Level Design v0.3, Milestone 1 user stories, detection plan).

## Repository layout (HDD §3.3)

| Path | What |
|---|---|
| `web/` | React + Vite + TypeScript app: driver routes and `/admin` console |
| `api/` | FastAPI service (REST, dev auth, presigned uploads, job creation) |
| `worker/` | Queue poller: alignment, scoring, state rules, status writes |
| `core/` | Shared Python package: domain models, the interfaces and their adapters |
| `seed/` | Seed CLI and lot definition files |
| `eval/` | Fixture photos and the benchmark script |
| `contract/openapi.json` | API contract exported from FastAPI; `web/` generates its types from it |

## Local development (Phase 1)

```bash
cp .env.example .env
docker compose up --build
uv run python seed/seed.py --lot pklot-ufpr04
```

Then open http://localhost:5173 and sign in with the dev admin from `.env`.

Without Docker you can still run everything in-process against in-memory adapters:

```bash
uv sync
APP_ENV=test uv run uvicorn parking_api.main:create_app --factory --reload --port 8000
cd web && npm install && npm run dev
```

## Contract workflow

The API schemas are the source of truth. After changing `api/parking_api/schemas.py` or a route:

```bash
uv run python -m parking_api.export_openapi > contract/openapi.json
cd web && npm run gen:types
```

CI fails when the committed `contract/openapi.json` or `web/src/api/types.gen.ts` is stale.

## Tests

```bash
uv run ruff check . && uv run pytest
cd web && npm test && npm run typecheck && npm run build
RUN_COMPOSE_TESTS=1 uv run pytest -m compose   # needs the compose stack
```
