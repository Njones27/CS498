FROM python:3.12-slim-trixie AS base
WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:0.12.23 /uv /usr/local/bin/uv
# Headless OpenCV links against glib (no libGL needed).
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0t64 && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml uv.lock .python-version ./
COPY core/pyproject.toml ./core/pyproject.toml
COPY worker/pyproject.toml ./worker/pyproject.toml
COPY api/pyproject.toml ./api/pyproject.toml
COPY seed/pyproject.toml ./seed/pyproject.toml
# WORKER_EXTRAS=vision installs torch (CPU wheels), torchvision and ultralytics for
# DETECTOR=acpds_yolo. Empty (the default) builds the small stub-only worker. Several extras
# are separated by spaces: the Lambda image is built with "vision lambda".
ARG WORKER_EXTRAS=""
# Compiled at build time: Lambda's file system is read-only, so nothing could cache it later.
ENV UV_COMPILE_BYTECODE=1
# Third-party packages first, from the lockfile and the manifests only: this layer (torch is
# most of the image) stays cached until uv.lock or a pyproject changes, not on every code edit.
RUN uv sync --frozen --no-dev --no-install-workspace --package parking-worker \
    $(for extra in $WORKER_EXTRAS; do printf -- '--extra %s ' "$extra"; done)
COPY core ./core
COPY worker ./worker
RUN uv sync --frozen --no-dev --package parking-worker \
    $(for extra in $WORKER_EXTRAS; do printf -- '--extra %s ' "$extra"; done)
# The worker checks its weights against this manifest at startup.
COPY models/manifest.json ./models/manifest.json
ENV PATH="/app/.venv/bin:$PATH"

# Phase 2: the worker as a Lambda container image behind the SQS queue (infra/stack/worker-stack.ts).
#   docker build -f worker/Dockerfile --target lambda --build-arg WORKER_EXTRAS="vision lambda" .
# A Lambda has nowhere to mount weights from, so this image carries them: downloaded here and
# checked against the manifest's SHA-256 pins, never copied from the build context.
FROM base AS lambda
COPY scripts/download_weights.py ./scripts/download_weights.py
RUN python scripts/download_weights.py
# Only /tmp is writable in Lambda, and Ultralytics keeps a settings file. YOLO_OFFLINE stops its
# import-time connectivity probe and the usage events it would post after each predict.
ENV MODELS_DIR=/app/models \
    HOME=/tmp \
    YOLO_CONFIG_DIR=/tmp/ultralytics \
    YOLO_OFFLINE=1 \
    MPLCONFIGDIR=/tmp/matplotlib
ENTRYPOINT ["python", "-m", "awslambdaric"]
CMD ["parking_worker.lambda_handler.handler"]

# Phase 1 (the default target): the long-poll worker of docker-compose.yml. Its weights are
# never baked in: mount them at /app/models (compose does).
FROM base AS poller
CMD ["python", "-m", "parking_worker.poller"]
