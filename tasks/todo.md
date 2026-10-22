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
- [x] `handler.process_message` (viewpoint-scoped, permanent vs retryable, receive_count attempts)
- [x] `poller.py`, `aligners/identity.py`, `scorers/stub.py`, `scorers/fake.py`, Dockerfile
- [x] Worker tests listed in the plan

## Web (PR 4)
- [x] Auth (sign-in, guard, expired/non-admin messages, sign out)
- [x] Lot list (US-15), lot map (US-01/02), upload form (US-04/05)
- [x] Vitest suite; `npm run typecheck`; `npm run build`
- [ ] Left for Nathan Galante: Snapshots page + Retry (US-06), admin lot picker (US-16 #3)

## Infra (PR 5)
- [x] `docker-compose.yml` (6 services, RustFS with bucket CORS via the S3 API, elasticmq DLQ), `.github/workflows/ci.yml` with compose job
- [x] Compose integration test (`tests/compose`, `-m compose`); `scripts/dev_inmemory.py` for Docker-free runs

## Verification
- [x] ruff, pytest (98), vitest (27), tsc, build all green on the merged tree (Oct 21)
- [x] Browser pass: lot list -> map -> sign-in redirect -> upload (via API) -> map shows V1 spaces only, duplicate 409
- [ ] CI compose job green on the PRs (first real run of the boto3 adapters and seed against the emulators)

## Review (Oct 21, 2026)
- Five stacked PRs: contract (#1), core/API/seed (`wave1/backend`), worker (`wave1/worker`), web (`wave1/web`), infra (`wave1/infra`). Each needs a teammate review before merge.
- Not yet verified anywhere: the boto3 adapters, `ensure_resources`, RustFS path-style presigning and bucket CORS and the seed CLI against the compose emulators. The CI compose job is the first real run; expect fixes there.
- Known follow-ups: `Repository.transition_job` needs an atomic "unfinished only" condition so the worker's re-claim of a retryable FAILED job is race-free; `useFetch` has an exhaustive-deps lint warning; `AuthContext.tsx` exports a hook and a component (fast-refresh warning).
- Open for teammates: Snapshots page + Retry UI (US-06), admin lot picker (US-16 #3), PKLot fixture pair for a real seed lot.
- Wave 2 next: ACPDS + YOLO26m scorer and ORB alignment behind the existing interfaces, closures CRUD, admin create-lot.
