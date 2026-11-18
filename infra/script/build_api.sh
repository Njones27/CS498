#!/usr/bin/env bash
# Builds the API Lambda's code into infra/.build/api: parking_api, parking_core and the dependencies uv.lock pins
# for them, as Linux wheels for the Lambda runtime (Python 3.12, x86_64), whatever machine this runs on.
#
#   infra/script/build_api.sh
#
# The Api stack zips that directory (Stack.Api.CodePath). Needs uv; nothing is installed into the project's .venv.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT="$REPO_ROOT/infra/.build/api"
REQUIREMENTS="$REPO_ROOT/infra/.build/api-requirements.txt"

rm -rf "$OUT"
mkdir -p "$OUT"
cd "$REPO_ROOT"

# Third-party packages only, exactly as locked; the two workspace packages are copied in as source below.
uv export --frozen --no-dev --package parking-api --no-emit-workspace --no-hashes --no-header -o "$REQUIREMENTS" >/dev/null
uv pip install --quiet --no-deps --target "$OUT" \
  --python-version 3.12 --python-platform x86_64-manylinux_2_28 --only-binary :all: \
  -r "$REQUIREMENTS"

cp -R core/parking_core api/parking_api "$OUT/"
find "$OUT" -type d \( -name __pycache__ -o -name tests \) -prune -exec rm -rf {} +
rm -rf "$OUT/bin"

echo "Built $OUT ($(du -sh "$OUT" | cut -f1))"
