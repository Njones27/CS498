# Phase 2 Security Checklist

A security review of the Phase 1 code found three issues that we chose to fix as part of the
move to AWS rather than now. Each one either goes away with Cognito or needs AWS resources that
Phase 1 does not have. This list keeps them from being forgotten. Check each item off before the
Phase 2 stack is reachable from the internet.

Two related issues were fixed in Phase 1. Docker Compose now binds every host port to
`127.0.0.1`, and draft saves reject space and viewpoint ids that are not 1 to 64 letters,
digits, `-` or `_`, along with labels over 40 characters and viewpoint names over 120.

## 1. Replace the dev JWT secret with Cognito

- [x] Implement the Cognito verifier that `build_aws_adapters` in
  `core/parking_core/adapters/aws.py` stubbed with `NotImplementedError`. Done: `CognitoVerifier` in
  `core/parking_core/auth.py`; the user pool is `infra/stack/auth-stack.ts`.
- [ ] Remove the dev signer and the dev users from any image that is deployed. Not removed, but
  unreachable on AWS: `APP_ENV=aws` refuses `AUTH_MODE=dev` at startup, the verifier in use
  rejects HS256 tokens, and `/auth/login` answers 404.

**Why it matters.** The default secret `dev-only-change-me` is public in this repository. Anyone
can use it to sign a token with the `admin` group, and the API accepts that token as a real
admin. On AWS that secret is never used: the startup check in `core/parking_core/settings.py`
refuses `AUTH_MODE=dev` when `APP_ENV=aws` and requires the user pool's ids. It still applies to
the local stack, so never run it with `APP_ENV=local` on a machine that other people can reach.

## 2. Throttle sign-in attempts

- [x] Confirm `/auth/login` returns 404 once `AUTH_MODE=cognito`, so the dev route is gone
  (`test_login_404_in_cognito_mode`; the deploy's smoke test checks the mode).
- [x] Turn on Cognito's built-in protection against repeated failed sign-ins. A user pool locks an
  account out for a growing time after five wrong passwords; that is always on. The web app shows
  "Too many failed sign-in attempts". Threat protection (the paid Plus tier) is not enabled.
- [x] Add API Gateway throttling on the public routes, since `GET /lots` reads every lot
  (`Api.ThrottleRateLimit` 20 requests a second, burst 40, in `infra/config/app-config-prod.json`).
  This is one limit for all callers together, so it bounds cost and load but lets one client crowd
  out the rest. A per-client limit needs AWS WAF and is not set up.

**Why it matters.** The dev login has no rate limit or lockout. A review sent 200 wrong
passwords in a row and every one returned an ordinary 401.

## 3. Limit upload sizes and clean up abandoned uploads

- [ ] Delete uploads that were never confirmed, or were rejected by the "complete" step. A
  cleanup job or an S3 lifecycle rule with object tags can do this for `raw/` and `reference/`.
- [ ] Consider presigned POST with a `content-length-range` condition in place of presigned PUT,
  so S3 itself refuses files over 15 MB.
- [ ] Consider using the full SHA-256 in `reference_image_key` in `core/parking_core/keys.py`
  instead of the first 12 characters, so one reference photo can never overwrite another.

**Why it matters.** A presigned PUT cannot cap the file size. The upload "complete" step rejects
a file that is too large, but it does not delete it, so an admin's upload link can leave a file
of any size in the bucket. Both risks need admin access, which is why they waited.

## Also worth deciding in Phase 2

- [ ] Access today is all or nothing. Any admin can edit, close or republish any lot. If some
  admins should manage only their own lots, the API needs a per-lot check alongside `AdminDep`
  in `api/parking_api/deps.py`.
- [x] Give the API and the worker separate IAM roles that can reach only their own table,
  bucket and queue (`infra/lib/app-environment.ts`, checked in `infra/test/stacks.test.ts`).
