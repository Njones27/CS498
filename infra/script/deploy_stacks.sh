#!/usr/bin/env bash
# Break-glass deploy of the stage from a laptop, and the very first deploy. Mirrors
# .github/workflows/deploy-stage.yml, which is the normal path (every push to main, once CI passes).
#
#   infra/script/deploy_stacks.sh config/app-config-prod.json
#
# Builds the web app and the API code, then deploys Data, Auth, Api, Worker, Web and Ops in order. The worker image
# is built by `cdk deploy` and needs Docker running. Cicd is deployed only by setup_initial.sh.
# Run `npm ci` in infra/ first.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <stage-config.json>" >&2
  exit 64
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

APP_CONFIG="$(resolve_config "$1")"
export APP_CONFIG
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PREFIX="$(stack_prefix "$APP_CONFIG")"

echo "==--------ConfigInfo---------=="
echo "Config: $APP_CONFIG"
echo "Stacks: $(stage_stack_patterns "$PREFIX")"
use_profile "$APP_CONFIG"
require_account "$APP_CONFIG"
echo

build_assets "$REPO_ROOT"

cd "$SCRIPT_DIR/.."   # infra/
echo "==--------DeployStacks---------=="
# Lambda only accepts a plain image manifest, not the attestation index newer Docker builds add by default.
export BUILDX_NO_DEFAULT_ATTESTATIONS=1
# shellcheck disable=SC2046  # word-splitting the stack list is intended
npx cdk deploy $(stage_stack_patterns "$PREFIX") --require-approval never -c APP_CONFIG="$APP_CONFIG"
echo

echo "Site: https://$(stage_parameter "$PREFIX" DistributionDomain)"
