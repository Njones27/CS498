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
| `models/` | Weight manifest (SHA-256 pins); the weights are downloaded, not committed |
| `scripts/` | Dev runner and the weight downloader |
| `contract/openapi.json` | API contract exported from FastAPI; `web/` generates its types from it |

## Local development (Phase 1)

```bash
cp .env.example .env
docker compose up --build
set -a && . ./.env.ci-host && set +a && uv run python seed/seed.py --lot pklot-ufpr04
```

The seed runs on the host, so it loads `.env.ci-host` (the same stack at `localhost` ports);
`.env` holds the compose-internal hostnames the containers use.

Then open http://localhost:5173 and sign in with the dev admin from `.env`.

Without Docker you can still run everything in-process against in-memory adapters:

```bash
uv sync
APP_ENV=test uv run uvicorn parking_api.main:create_app --factory --reload --port 8000
cd web && npm install && npm run dev
```

## Model weights and detector

The worker scores spaces with `DETECTOR=stub` by default (fast, no ML). The real detector,
`DETECTOR=acpds_yolo`, runs ACPDS on every mapped space and YOLO26m as a car safety net
(`worker/parking_worker/scorers/acpds_yolo.py`, detection plan in `Docs/CV_processing_CS498.pdf`).
It needs the worker's `vision` extra and three pinned weight files (`models/README.md`):

```bash
uv sync --all-packages --extra vision                 # torch, torchvision, ultralytics
uv run python scripts/download_weights.py             # fetch + verify against models/manifest.json
uv run python scripts/download_weights.py --check     # verify only; exit 1 if missing/mismatched
```

The worker refuses to start with `DETECTOR=acpds_yolo` if a file is missing or its SHA-256
differs from the manifest. Settings (`.env`): `MODELS_DIR`, `YOLO_CONF` (0.25), `YOLO_IMGSZ` (1280),
`YOLO_OVERLAP_MODE` = `box` (default), `box_lower_half` or `seg` (loads `yolo26m-seg.pt`).

With Docker, build the worker with the extra; `./models` is mounted read-only into it:

```bash
WORKER_EXTRAS=vision docker compose up --build        # plus DETECTOR=acpds_yolo in .env
```

Pilot benchmark (PKLot sample first, then labeled drone photos; see `eval/README.md`):

```bash
uv run python eval/fetch_pklot_sample.py --count 30
uv run python eval/benchmark.py eval/data/pklot --setup acpds --setup acpds_yolo --setup yolo
RUN_MODEL_TESTS=1 uv run pytest -m real_model         # real-model smoke test on the fixture
```

### Licenses

The ACPDS code (vendored in `worker/parking_worker/scorers/acpds/`) and its weights are MIT.
The YOLO26 weights and the `ultralytics` package are AGPL-3.0, which is acceptable for this
public course repository; a closed-source deployment would need an Ultralytics Enterprise
license. The PKLot photos in `eval/fixtures/` are CC BY 4.0.

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
