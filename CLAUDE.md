# CLAUDE.md

## Phase 2 security tasks

A security review in Phase 1 deferred three fixes to Phase 2, because each one either goes away
with Cognito or needs AWS resources Phase 1 does not have. Whenever you work on Phase 2 (Cognito,
API Gateway, S3 or any AWS deployment), raise these tasks and do not consider Phase 2 done until
all three are finished. Full details, reasons and acceptance criteria are in
`Docs/phase2-security-checklist.md`. Check items off there as they land.

1. **Replace the dev JWT signer with Cognito.** The default `jwt_secret` in
   `core/parking_core/settings.py` is public in this repo, so anyone can forge an admin token.
   Implement the Cognito verifier that `build_aws_adapters` in
   `core/parking_core/adapters/aws.py` stubs with `NotImplementedError`, map `cognito:groups` to
   `Principal.groups`, and make sure no deployed image can run `AUTH_MODE=dev`.
2. **Throttle sign-in and the public routes.** The dev `/auth/login` has no rate limit. Turn on
   Cognito's protection against repeated failed sign-ins, confirm `/auth/login` returns 404 in
   Cognito mode, and add API Gateway throttling on the public routes, especially `GET /lots`.
3. **Cap upload size and delete abandoned uploads.** Presigned PUTs in
   `api/parking_api/routes/uploads.py` and `reference.py` cannot cap file size, and rejected or
   never-completed uploads are never deleted. Move to presigned POST with
   `content-length-range`, delete rejected and abandoned objects, and use the full SHA-256 in
   `reference_image_key` in `core/parking_core/keys.py`.

Until task 1 is done, never run the local stack with `APP_ENV=local` on a machine other people
can reach.
