#!/usr/bin/env bash
# Creates a sign-in for the deployed stage. Nobody can sign themselves up: an administrator runs this.
#
#   infra/script/create_user.sh config/app-config-prod.json someone@example.edu --admin
#
# Asks for the person's password (at least 12 characters with a lower-case letter, an upper-case letter and a
# digit) without echoing it, and sets it as permanent, so they can sign in on the site straight away. --admin adds
# them to the `admin` group, which is what opens /admin. Without it the account can sign in but manage nothing.
# Re-run with the same email to set a new password or to add --admin.
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ] || { [ "$#" -eq 3 ] && [ "$3" != "--admin" ]; }; then
  echo "Usage: $0 <stage-config.json> <email> [--admin]" >&2
  exit 64
fi

if ! [ -t 0 ]; then
  echo "Run this in a terminal: it asks for the password, which is typed and not shown." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

APP_CONFIG="$(resolve_config "$1")"
EMAIL="$2"
PREFIX="$(stack_prefix "$APP_CONFIG")"
use_profile "$APP_CONFIG"
require_account "$APP_CONFIG"
POOL_ID="$(stage_parameter "$PREFIX" UserPoolId)"

# Asked before anything is created, so a typo or Ctrl-C here changes nothing. IFS= keeps the password exactly as typed.
IFS= read -r -s -p "Password for $EMAIL: " PASSWORD
echo
IFS= read -r -s -p "Again: " PASSWORD_AGAIN
echo
if [ "$PASSWORD" != "$PASSWORD_AGAIN" ]; then
  echo "The passwords differ; nothing changed. Run this again to set one." >&2
  exit 1
fi

if LOOKUP="$(aws cognito-idp admin-get-user --user-pool-id "$POOL_ID" --username "$EMAIL" 2>&1)"; then
  echo "$EMAIL already has an account in $PREFIX-Users; updating it."
  # The API accepts only tokens whose email is verified. Someone who changed their own address lost that mark
  # and cannot sign in until an administrator vouches for the address again, which is what running this is.
  aws cognito-idp admin-update-user-attributes --user-pool-id "$POOL_ID" --username "$EMAIL" \
    --user-attributes Name=email_verified,Value=true
elif [[ "$LOOKUP" == *UserNotFoundException* ]]; then
  # SUPPRESS: no invitation email with a temporary password; the password is set below. The API accepts only
  # tokens whose email is verified, and an administrator typing the address here is that verification.
  aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" --username "$EMAIL" --message-action SUPPRESS \
    --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true >/dev/null
  echo "Created $EMAIL in $PREFIX-Users."
else
  echo "$LOOKUP" >&2
  exit 1
fi
# Through a file only this user can read, deleted on the way out, not as an argument: arguments show in the
# machine's process list. (The AWS CLI cannot read --cli-input-json from a pipe.)
REQUEST=""
trap 'rm -f "$REQUEST"' EXIT
# bash skips the EXIT trap when a signal kills it (Ctrl-C, a closed terminal): turn those into exits.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
REQUEST="$(umask 077 && mktemp)"
POOL_ID="$POOL_ID" EMAIL="$EMAIL" PASSWORD="$PASSWORD" node -e '
  const { POOL_ID, EMAIL, PASSWORD } = process.env;
  process.stdout.write(JSON.stringify({ UserPoolId: POOL_ID, Username: EMAIL, Password: PASSWORD, Permanent: true }));
' > "$REQUEST"
unset PASSWORD PASSWORD_AGAIN
if ! aws cognito-idp admin-set-user-password --cli-input-json "file://$REQUEST"; then
  echo "The password was not set. It needs at least 12 characters with a lower-case letter, an upper-case letter" >&2
  echo "and a digit. Run this again to choose another." >&2
  exit 1
fi
echo "Password set."

if [ "${3:-}" = "--admin" ]; then
  aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL_ID" --username "$EMAIL" --group-name admin
  echo "$EMAIL is an administrator."
fi
echo "Sign in at https://$(stage_parameter "$PREFIX" DistributionDomain)/signin"
