FROM python:3.12-slim-trixie
WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:0.12.23 /uv /usr/local/bin/uv
# Headless OpenCV links against glib (no libGL needed).
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0t64 && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml uv.lock .python-version ./
COPY core ./core
COPY worker ./worker
COPY api/pyproject.toml ./api/pyproject.toml
COPY seed/pyproject.toml ./seed/pyproject.toml
# WORKER_EXTRAS=vision installs torch (CPU wheels), torchvision and ultralytics for
# DETECTOR=acpds_yolo. Empty (the default) builds the small stub-only worker.
ARG WORKER_EXTRAS=""
RUN uv sync --frozen --no-dev --package parking-worker ${WORKER_EXTRAS:+--extra $WORKER_EXTRAS}
# Weights are never baked in: mount them at /app/models (compose does) and the worker checks
# them against this manifest at startup.
COPY models/manifest.json ./models/manifest.json
ENV PATH="/app/.venv/bin:$PATH"
CMD ["python", "-m", "parking_worker.poller"]
