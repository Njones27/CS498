# Shared helpers for the infra scripts. Sourced, not run.
# Config values are read with node (already required for CDK), so jq is not needed.

# Absolute path of a file, resolved against the caller's working directory.
abspath() {
  node -e 'process.stdout.write(require("path").resolve(process.argv[1]))' "$1"
}

# resolve_config <path>: absolute path of a stage config, given relative to where the script was called from or
# to infra/ (so `config/app-config-prod.json` works from the repository root too). Stops when there is no such file.
INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # fixed when sourced, before any cd

resolve_config() {
  if [ -f "$1" ]; then
    abspath "$1"
  elif [ -f "$INFRA_DIR/$1" ]; then
    echo "$INFRA_DIR/$1"
  else
    echo "No config file at $1 (looked in $(pwd) and in $INFRA_DIR). The stage configs are:" >&2
    ls "$INFRA_DIR"/config/*.json >&2
    return 1
  fi
}

# config_get <config.json> <dotted.key>  -> prints the value ('' when missing)
config_get() {
  node -e '
    const config = require(process.argv[1]);
    const value = process.argv[2].split(".").reduce((o, k) => (o == null ? undefined : o[k]), config);
    process.stdout.write(value == null ? "" : String(value));
  ' "$1" "$2"
}

# stack_prefix <config.json>: <Name><Stage>, e.g. ParkingProd. Every stack and SSM parameter name starts with it.
stack_prefix() {
  echo "$(config_get "$1" Project.Name)$(config_get "$1" Project.Stage)"
}

# use_profile <config.json>: export AWS_PROFILE and the region when the config names them (cdk and aws honour both).
use_profile() {
  local profile
  profile="$(config_get "$1" Project.Profile)"
  if [ -n "$profile" ] && [ -z "${AWS_ACCESS_KEY_ID:-}" ]; then
    export AWS_PROFILE="$profile"
    echo "Using AWS profile: $AWS_PROFILE"
  fi
  AWS_REGION="$(config_get "$1" Project.Region)"
  export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
}

# require_account <config.json>: stop unless the current credentials belong to the config's account.
require_account() {
  local expected actual
  expected="$(config_get "$1" Project.Account)"
  if ! actual="$(aws sts get-caller-identity --query Account --output text)"; then
    echo "No valid AWS credentials${AWS_PROFILE:+ for profile $AWS_PROFILE}. For an SSO profile run: aws sso login${AWS_PROFILE:+ --profile $AWS_PROFILE}" >&2
    exit 1
  fi
  if [ "$actual" != "$expected" ]; then
    echo "Credentials are for account $actual but $1 targets $expected. Fix the profile or the config." >&2
    exit 1
  fi
}

# export_credentials: put the profile's temporary credentials into the environment, for tools other than the AWS
# CLI and CDK. boto3 cannot read every kind of profile itself (`aws login` sessions need an extra package).
export_credentials() {
  local exported
  exported="$(aws configure export-credentials --format env)"
  eval "$exported"
  unset AWS_PROFILE
}

# The stage stacks CI deploys, in order. Cicd is left out on purpose: it holds the role CI runs as, so only
# setup_initial.sh changes it. Keep in step with lib/create-stacks.ts and .github/workflows/deploy-stage.yml.
stage_stack_patterns() {
  local prefix="$1"
  echo "$prefix-Data $prefix-Auth $prefix-Api $prefix-Worker $prefix-Web $prefix-Ops"
}

# stage_parameter <prefix> <key>: the value a stack published as SSM parameter <prefix>-<key>.
stage_parameter() {
  aws ssm get-parameter --name "$1-$2" --query Parameter.Value --output text
}

# build_assets: what `cdk synth` packages. The web app (web/dist) and the API Lambda's code (infra/.build/api).
# The worker image is built by `cdk deploy` itself, from worker/Dockerfile.
build_assets() {
  local repo_root="$1"
  echo "==--------BuildWeb---------=="
  (cd "$repo_root/web" && { [ -d node_modules ] || npm ci; } && npm run build)
  echo
  echo "==--------BuildApi---------=="
  "$repo_root/infra/script/build_api.sh"
  echo
}
