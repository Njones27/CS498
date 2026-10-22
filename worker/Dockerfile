FROM python:3.12-slim
WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:0.12.23 /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock .python-version ./
COPY core ./core
COPY worker ./worker
COPY api/pyproject.toml ./api/pyproject.toml
COPY seed/pyproject.toml ./seed/pyproject.toml
RUN uv sync --frozen --no-dev --package parking-worker
ENV PATH="/app/.venv/bin:$PATH"
CMD ["python", "-m", "parking_worker.poller"]
