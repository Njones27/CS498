#!/usr/bin/env bash
# One-time setup of the AWS account, run by hand from a shell with administrator credentials for it:
#
#   infra/script/setup_initial.sh config/app-config-prod.json
#
# After telemachus and AWS_Spark (script/setup_initial.sh), from aws-samples/aws-cdk-project-template-for-devops. It:
# 1. reports the account's Lambda concurrency quota (new accounts start at 10)
# 2. runs `cdk bootstrap aws://<account>/<region>` (the default bootstrap: CloudFormation deploys as administrator)
# 3. caps the bootstrap image repository at the 5 newest worker images, each about 2 GB
# 4. stores the address alarms and budget alerts are emailed to in SSM parameter <prefix>-AlertEmail
# 5. deploys <prefix>-Cicd: GitHub's OIDC provider and the role the deploy workflow assumes
# 6. prints the GitHub environment and variables to create
#
# The alert address comes from ALERT_EMAIL, else the parameter's current value, else a prompt. It is kept in SSM and
# never written to this public repository.
# Safe to re-run. Run `npm ci` in infra/ first. SETUP_YES=1 skips CDK's interactive IAM review.
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
cd "$SCRIPT_DIR/.."   # infra/, where cdk.json lives

APPROVAL=(--require-approval broadening)
if [ "${SETUP_YES:-}" = "1" ]; then APPROVAL=(--require-approval never); fi

echo "==--------CheckDependencies---------=="
aws --version
node --version
npx cdk --version
uv --version
echo

ACCOUNT="$(config_get "$APP_CONFIG" Project.Account)"
REGION="$(config_get "$APP_CONFIG" Project.Region)"
PREFIX="$(stack_prefix "$APP_CONFIG")"
use_profile "$APP_CONFIG"
require_account "$APP_CONFIG"

echo "==--------LambdaConcurrencyQuota---------=="
QUOTA="$(aws lambda get-account-settings --query AccountLimit.ConcurrentExecutions --output text)"
WORKERS="$(config_get "$APP_CONFIG" Stack.Worker.MaxConcurrency)"
echo "ConcurrentExecutions quota in $REGION: $QUOTA (the worker uses at most ${WORKERS:-2}; the API uses the rest)"
if [ "$QUOTA" -lt 1000 ]; then
  echo "Below the default of 1000, which is normal for a new account and enough for a pilot. To request the default:"
  echo "  aws service-quotas request-service-quota-increase --region $REGION --service-code lambda --quota-code L-B99A9384 --desired-value 1000"
fi
echo

# Every cdk command synthesizes the whole app, which packages web/dist and the API code.
build_assets "$REPO_ROOT"

echo "==--------BootstrapCDKEnvironment---------=="
npx cdk bootstrap "aws://$ACCOUNT/$REGION" -c APP_CONFIG="$APP_CONFIG"
echo

echo "==--------WorkerImageRetention---------=="
# `cdk deploy` pushes a new worker image whenever core/ or worker/ changes and never deletes the old ones.
IMAGE_REPO="cdk-hnb659fds-container-assets-$ACCOUNT-$REGION"
aws ecr put-lifecycle-policy --repository-name "$IMAGE_REPO" --lifecycle-policy-text '{
  "rules": [{
    "rulePriority": 1,
    "description": "Keep the 5 newest worker images",
    "selection": { "tagStatus": "any", "countType": "imageCountMoreThan", "countNumber": 5 },
    "action": { "type": "expire" }
  }]
}' >/dev/null
echo "$IMAGE_REPO keeps its 5 newest images."
echo

echo "==--------AlertEmail---------=="
ALERT_PARAM="$PREFIX-AlertEmail"
looks_like_email() { [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; }
CURRENT_EMAIL="$(aws ssm get-parameter --name "$ALERT_PARAM" --query Parameter.Value --output text 2>/dev/null || true)"
WANT_EMAIL="${ALERT_EMAIL:-$CURRENT_EMAIL}"
if ! looks_like_email "$WANT_EMAIL" && [ -t 0 ]; then
  read -r -p "Email for $PREFIX alarms and budget alerts: " WANT_EMAIL
fi
if ! looks_like_email "$WANT_EMAIL"; then
  echo "No alert email. Re-run with ALERT_EMAIL=you@example.com $0 $*" >&2
  exit 1
fi
if [ "$WANT_EMAIL" = "$CURRENT_EMAIL" ]; then
  echo "SSM parameter $ALERT_PARAM already set, keeping it."
else
  aws ssm put-parameter --name "$ALERT_PARAM" --type String --overwrite \
    --description "Where $PREFIX alarms and budget alerts are emailed" --value "$WANT_EMAIL" >/dev/null
  echo "Set SSM parameter $ALERT_PARAM. After the first deploy, AWS emails that address a link to confirm the alarms."
fi
echo

echo "==--------DeployCicd---------=="
npx cdk deploy "$PREFIX-Cicd" "${APPROVAL[@]}" -c APP_CONFIG="$APP_CONFIG"
echo

ROLE_ARN="$(stage_parameter "$PREFIX" DeployRoleArn)"
GITHUB_ENV_NAME="$(config_get "$APP_CONFIG" Stack.Cicd.GitHubEnvironment)"
GITHUB_REPO="$(config_get "$APP_CONFIG" Stack.Cicd.GitHubRepo)"
APP_CONFIG_REL="$(node -e 'process.stdout.write(require("path").relative(process.cwd(), process.argv[1]))' "$APP_CONFIG")"

echo "==--------GitHubEnvironment---------=="
cat <<SETUP
Create the GitHub environment '$GITHUB_ENV_NAME' in $GITHUB_REPO, limited to the main branch, and give it these
variables (none of them is a secret). With the GitHub CLI:

  gh api -X PUT repos/$GITHUB_REPO/environments/$GITHUB_ENV_NAME \\
    -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
  gh api -X POST repos/$GITHUB_REPO/environments/$GITHUB_ENV_NAME/deployment-branch-policies -f name=main -f type=branch
  gh variable set AWS_DEPLOY_ROLE_ARN --repo $GITHUB_REPO --env $GITHUB_ENV_NAME --body '$ROLE_ARN'
  gh variable set AWS_REGION          --repo $GITHUB_REPO --env $GITHUB_ENV_NAME --body '$REGION'
  gh variable set AWS_ACCOUNT_ID      --repo $GITHUB_REPO --env $GITHUB_ENV_NAME --body '$ACCOUNT'
  gh variable set APP_CONFIG          --repo $GITHUB_REPO --env $GITHUB_ENV_NAME --body '$APP_CONFIG_REL'

Then every push to main deploys once its CI run passes (.github/workflows/deploy.yml). For the first deploy from this machine:
  infra/script/deploy_stacks.sh $APP_CONFIG_REL
SETUP
