#!/usr/bin/env bash
# Tears down every stack of one config, Cicd included.
#
#   infra/script/destroy_stacks.sh config/app-config-prod.json
#
# Kept on purpose when RetainOnDelete is true, delete by hand when sure: the DynamoDB table and the photo bucket
# (Data), the Cognito user pool (Auth). Also kept: the <prefix>-AlertEmail SSM parameter and the CDK bootstrap stack.
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
STAGE="$(config_get "$APP_CONFIG" Project.Stage)"
PREFIX="$(stack_prefix "$APP_CONFIG")"
ACCOUNT="$(config_get "$APP_CONFIG" Project.Account)"
REGION="$(config_get "$APP_CONFIG" Project.Region)"
use_profile "$APP_CONFIG"
require_account "$APP_CONFIG"

cd "$SCRIPT_DIR/.."   # infra/

echo "==--------ListStacks---------=="
npx cdk list -c APP_CONFIG="$APP_CONFIG"
echo

echo "This destroys every stack above in account $ACCOUNT ($REGION)."
read -r -p "Type the stage name ($STAGE) to continue: " ANSWER
if [ "$ANSWER" != "$STAGE" ]; then
  echo "Aborted." >&2
  exit 1
fi

echo "==--------DestroyStacks---------=="
npx cdk destroy --all --force -c APP_CONFIG="$APP_CONFIG"
echo

echo "Left in place on purpose:"
if [ "$(config_get "$APP_CONFIG" Stack.Data.RetainOnDelete)" != "false" ]; then
  echo "- the $PREFIX DynamoDB table (deletion protection on) and photo bucket. See them with:"
  echo "    aws dynamodb list-tables --region $REGION"
  echo "    aws s3 ls | grep -i ${PREFIX}"
fi
if [ "$(config_get "$APP_CONFIG" Stack.Auth.RetainOnDelete)" != "false" ]; then
  echo "- the $PREFIX-Users Cognito user pool (deletion protection on), with every admin account in it."
fi
echo "- SSM parameter $PREFIX-AlertEmail:  aws ssm delete-parameter --name $PREFIX-AlertEmail --region $REGION"
echo "- the CDK bootstrap stack (CDKToolkit) with its asset bucket and image repository."
