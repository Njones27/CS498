#!/usr/bin/env bash
# Loads a lot from seed/lots/ into the deployed stage, with your own AWS credentials (not through the API).
#
#   infra/script/seed.sh config/app-config-prod.json [--lot test-lot]
#
# The same seed CLI as local development (seed/seed.py), pointed at the stage's table and bucket. It never creates
# or reconfigures them: on AWS the CDK stacks own those.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <stage-config.json> [--lot <lot-id>]" >&2
  exit 64
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

APP_CONFIG="$(resolve_config "$1")"
shift
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PREFIX="$(stack_prefix "$APP_CONFIG")"
use_profile "$APP_CONFIG"
require_account "$APP_CONFIG"

APP_ENV=aws
AUTH_MODE=cognito
TABLE_NAME="$(stage_parameter "$PREFIX" TableName)"
BUCKET_NAME="$(stage_parameter "$PREFIX" PhotoBucketName)"
QUEUE_URL="$(stage_parameter "$PREFIX" JobQueueUrl)"
COGNITO_USER_POOL_ID="$(stage_parameter "$PREFIX" UserPoolId)"
COGNITO_CLIENT_ID="$(stage_parameter "$PREFIX" UserPoolClientId)"
export_credentials   # after the lookups above: the seed CLI is Python (boto3), not the AWS CLI
export APP_ENV AUTH_MODE TABLE_NAME BUCKET_NAME QUEUE_URL COGNITO_USER_POOL_ID COGNITO_CLIENT_ID
# The local .env names the emulators; never let it reach a run against AWS.
unset S3_ENDPOINT_URL S3_PUBLIC_ENDPOINT_URL SQS_ENDPOINT_URL DYNAMODB_ENDPOINT_URL

echo "Seeding $PREFIX (table $TABLE_NAME, bucket $BUCKET_NAME)"
cd "$REPO_ROOT/seed"   # away from the repository root, so the local .env there is not read
uv run python seed.py "$@"
