# Wave 1: walking skeleton (Phase 1, local)

Plan of record: `~/.claude/plans/tidy-bouncing-owl.md` (rev 2, approved Oct 21 2026).
One photo goes upload -> queue -> worker -> status -> driver map, fully local, scorer stubbed.

## Contract step (branch `wave1/contract`, PR 1)
- [x] uv workspace, `.python-version` 3.12, `.env.example`
- [x] `core/parking_core`: models, keys, errors, interfaces, settings (`build_adapters` switch)
- [x] `api/parking_api`: schemas, route stubs (501), app factory, error envelope, OpenAPI export
- [x] `contract/openapi.json` exported; `web/` scaffold with generated `types.gen.ts`, Vite `/api` proxy
- [x] README quickstart, this file

## Backend (PR 2: core/API/seed)
- [x] `adapters/memory.py` with conditional semantics (claim/takeover hash, transition_job, update_status_if_newer, queue receive_count)
- [x] `adapters/aws.py` (boto3; public endpoint for signing; `ensure_resources`)
- [x] `state_rules.decide_state` (+ `require_car_check`), `status.build_status` / `lot_summary`
- [x] `auth.py` dev signer + HS256 verifier
- [x] API route bodies incl. `/_test/uploads` and 15-min expiry takeover
- [x] `seed/seed.py` idempotent, `seed/import_pklot.py`, lot JSON, `eval/fixtures`
- [x] Tests listed in the plan ("Tests that gate wave 1": core, api, seed)

## Worker (PR 3)
- [ ] `handler.process_message` (viewpoint-scoped, permanent vs retryable, receive_count attempts)
- [ ] `poller.py`, `aligners/identity.py`, `scorers/stub.py`, `scorers/fake.py`, Dockerfile
- [ ] Worker tests listed in the plan

## Web (PR 4)
- [ ] Auth (sign-in, guard, expired/non-admin messages, sign out)
- [ ] Lot list (US-15), lot map (US-01/02), upload form (US-04/05)
- [ ] Vitest suite; `npm run typecheck`; `npm run build`
- [ ] Left for Nathan Galante: Snapshots page + Retry (US-06), admin lot picker (US-16 #3)

## Infra (PR 5)
- [ ] `docker-compose.yml` (6 services, MinIO CORS, elasticmq DLQ), `.github/workflows/ci.yml` with compose job
- [ ] Compose integration test (`-m compose`)

## Verification
- [ ] ruff, pytest, vitest, tsc, build all green
- [ ] Browser pass: sign in -> upload -> map updates (APP_ENV=test, in-process worker)
- [ ] CI compose job green on the PRs

## Review
(filled in when wave 1 lands)
