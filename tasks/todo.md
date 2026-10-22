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

# Wave 2 (Nathan Jones): closures, vision, brief

Plan of record: `~/.claude/plans/glimmering-sleeping-blum.md` (approved Oct 22 2026 after review).
Four PRs, each from up-to-date `main`, never stacked; Opus 5.5 subagents implement, code review before `gh pr create`.

## PR1 Closures (US-10), `wave2/nathan-closures` (by Oct 24)
- [x] `closures_schemas.py`, `routes/closures.py` (GET/POST/DELETE), one `include_router`
- [x] Validate space ids against the published layout (409 `not_published`), 422 `invalid_window` / `unknown_space`
- [x] `api.delete`, `LotMapSvg` toggle props, `ClosuresPage.tsx`, admin home link
- [x] Test per US-10 criterion + auth tests; contract and types regenerated
- [x] Reviewed; PR #7 open (Oct 22), CI green

## PR2a ORB aligner, `wave2/nathan-aligner` (by Oct 26)
- [x] Content-addressed `reference_image_key(lot, view, sha256)`; seed loader hashes bytes
- [x] `ALIGNER` settings, `aligners/orb.py`, `build_aligner`, cache keyed by object key
- [x] opencv-python-headless + uv override for `opencv-python`
- [x] Synthetic known-transform tests; reviewed; PR #8 open (Oct 22), CI green

## PR2b ACPDS + YOLO26m, `wave2/nathan-vision` (by Oct 28)
- [x] Vendored ACPDS (MIT, weights=None), `scorers/acpds_yolo.py`, `YOLO_OVERLAP_MODE`
- [x] `models/manifest.json`, `scripts/download_weights.py`, `.pt` ignored
- [x] `vision` extra, pytorch-cpu index, `WORKER_EXTRAS` build arg, `worker-vision-image` CI job
- [x] `eval/fetch_pklot_sample.py --count 30`, one committed fixture, `eval/benchmark.py`
- [x] Benchmark tables in PR #9; cutoffs unchanged (Nathan decides; YOLO_IMGSZ=1280 default added)
- [x] README weights + AGPL note; reviewed; PR #9 open (Oct 22), CI green

## PR3 Brief, `wave2/nathan-brief` (after the three merge)
- [x] Fill section 3 TBDs, fix 4.2/7.2 reference key, 5-8, 10 (drafted in the working tree Oct 22)
- [x] Branched from main (`wave2/nathan-brief`, local), `README 2.md` removed, brief + lessons + this file committed and reviewed (Oct 22)
- [x] #7, #8 and #9 merged to main (Oct 22); rebased onto main, re-reviewed, pushed, PR opened (Oct 22)

## Review (Oct 22, 2026)
- PRs #7 (closures), #8 (aligner), #9 (scorer + benchmark) are merged to main (merge commits, Oct 22). The brief PR needs one teammate review and a merge commit.
- PKLot (30 photos): acpds_yolo box mode false-free 2.8%, accuracy 91.7%, UNKNOWN 5.8% with YOLO at 1280 px; ACPDS alone 14.5% false-free. Cutoffs unchanged; the pilot decides cutoffs, overlap mode and ORB thresholds.
- Decided for Rylan's reference upload: `complete` re-hashes the object before pointing a viewpoint at it (brief 4.2).
