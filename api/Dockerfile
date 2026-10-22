FROM python:3.12-slim
WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:0.12.23 /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock .python-version ./
COPY core ./core
COPY api ./api
COPY worker/pyproject.toml ./worker/pyproject.toml
COPY seed/pyproject.toml ./seed/pyproject.toml
RUN uv sync --frozen --no-dev --package parking-api
ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
CMD ["uvicorn", "parking_api.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
