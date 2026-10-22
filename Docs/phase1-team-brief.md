# Phase 1 team brief: remaining features for Milestone 2 (Nov 11)

Audience: each teammate **and their coding agent**. Read sections 1–4 and 9 first, then your own section (5–8).
Paste the "Agent kickoff prompt" from your section into your coding agent to start.

| Section | For |
|---|---|
| 1. Where things stand | everyone |
| 2. Ground rules (branches, contract, shared files, tests) | everyone |
| 3. Already done: closures and vision (do not touch) | everyone |
| 4. Shared mapping contract (draft layout API + component props) | David, Rylan, Kevin |
| 5. Nathan Galante: Snapshots, lot picker, create lot | Nathan Galante |
| 6. David Eliassen: schematic editor | David |
| 7. Rylan Moseley: reference photo and outlines | Rylan |
| 8. Kevin Nguyen: draft storage, validation, publish, versions | Kevin |
| 9. Merge order, timeline, non-coding work | everyone |
| 10. Appendix: commands, helpers, conventions | everyone (agents especially) |

Source documents: `Docs/CS498_High_Level_Design_v0.3.docx` (HDD), `Docs/CS498 Milestone 1 User Stories - Final.pdf` (stories, acceptance criteria quoted below), `Docs/CV_processing_CS498.pdf` (detection plan).

---

## 1. Where things stand

Wave 1 built a working skeleton of Phase 1. An admin signs in, uploads a photo, the worker processes it, and the driver map updates. Everything runs on a laptop.

**Already built (do not rebuild):**

| Area | What exists | Where |
|---|---|---|
| Driver lot list (US-15) | Fullness bar, Plenty / Filling up / Nearly full, "no recent data" | `web/src/pages/LotListPage.tsx` |
| Driver lot map (US-01, US-02) | SVG schematic, state icons + legend, counts, "Last observed…", stale banner, tooltips | `web/src/pages/LotMapPage.tsx`, `web/src/components/LotMapSvg.tsx` |
| Admin sign-in (US-03) | Dev JWT login, `RequireAdmin` guard, expired/non-admin handling, sign out | `api/parking_api/routes/auth.py`, `web/src/auth/` |
| Upload (US-04, US-05) | Presigned upload, EXIF time, validation, duplicate 409 | `api/parking_api/routes/uploads.py`, `web/src/pages/UploadPage.tsx` |
| Snapshot API (US-06 backend) | List, detail, retry | `api/parking_api/routes/snapshots.py` |
| Worker (US-11, US-13) | Queue poller, per-viewpoint scoring, newer-capture-wins, retries | `worker/parking_worker/` |
| Storage | Repository/ObjectStore/JobQueue interfaces with in-memory and AWS (boto3) adapters | `core/parking_core/interfaces.py`, `core/parking_core/adapters/` |
| Status + closures read side | Status builder already overlays active closures as CLOSED | `core/parking_core/status.py` |
| Local stack (US-14) | Docker Compose (RustFS, ElasticMQ, DynamoDB Local), seed, Docker-free dev runner | `docker-compose.yml`, `seed/`, `scripts/dev_inmemory.py` |
| CI | ruff, pytest (70% coverage gate), contract freshness, web typecheck/test/build, compose end-to-end, vision worker image | `.github/workflows/ci.yml` |
| Closures (US-10) | Admin API to close spaces now, on a schedule or open-ended, and end them early; `/admin/closures` page | `api/parking_api/routes/closures.py`, `web/src/pages/ClosuresPage.tsx` |
| Vision pipeline | ORB/RANSAC aligner (`ALIGNER=orb`) and ACPDS + YOLO26m scorer (`DETECTOR=acpds_yolo`), pinned weights, PKLot benchmark | `worker/parking_worker/aligners/orb.py`, `worker/parking_worker/scorers/acpds_yolo.py`, `models/`, `eval/` |

**Added after wave 1 (section 3), now on `main` via PRs #7, #8 and #9:** closures, plus the real aligner and scorer, which replace the wave-1 stand-ins (`IdentityAligner`, `DETECTOR=stub`) when `ALIGNER=orb` and `DETECTOR=acpds_yolo` are set. The dev runner and CI stay on the stand-ins for speed. Nothing in sections 5–8 depends on which scorer runs.

**Run it without Docker** (in-memory, resets on restart):

```bash
uv sync
uv run python scripts/dev_inmemory.py
```

```bash
cd web && npm install && npm run dev
```

Open http://localhost:5173. Admin login: `admin@example.edu` / `admin-password`. Non-admin login: `viewer@example.edu` / `viewer-password`.

---

## 2. Ground rules

### 2.1 Branches and PRs
- **Start from `main`** only after the wave-1 PRs (#1–#5) **and** Nathan Jones's closures and vision PRs (#7, #8, #9) are merged (sections 3 and 9). Run `git pull` first.
- One feature branch per person per PR: `wave2/<name>-<feature>`, e.g. `wave2/kevin-draft-api`.
- Keep PRs small. Each PR needs **one reviewer who is not the author** (HDD §8.3). CI must be green.
- Do not edit files another person owns (tables in each section). If you need a change there, ask the owner or make a one-line change and call it out in the PR description.
- Claude Code commit attribution is turned off for this repo (`.claude/settings.json`). Commits show the person who made them.

### 2.2 The API contract workflow (important)
The API schemas are the source of truth. The web app's types are generated from them.

1. Change or add schemas and routes in `api/`.
2. Export the contract:
   ```bash
   uv run python -m parking_api.export_openapi > contract/openapi.json
   ```
3. Regenerate web types:
   ```bash
   cd web && npm run gen:types
   ```
4. Commit `contract/openapi.json` and `web/src/api/types.gen.ts` with your change. CI fails if either is stale.

**Generated files never get hand-merged.** On a rebase conflict in `contract/openapi.json` or `web/src/api/types.gen.ts`, take either side, then rerun steps 2–3.

### 2.3 Shared files: where conflicts happen and how to avoid them

| File | Rule |
|---|---|
| `api/parking_api/main.py` | Add **one** `include_router` line for your new route module. |
| `api/parking_api/schemas.py` | **Do not add to it.** Put your schemas in your own module, e.g. `api/parking_api/lots_admin_schemas.py`. |
| `web/src/App.tsx` | Add your `<Route>` lines only. |
| `web/src/api/schemas.ts` | Don't add to it. Add type aliases in your own file, e.g. `web/src/api/layout.ts`. |
| `web/src/pages/AdminHomePage.tsx` | Nathan Galante owns it. Others: add your one link to the list and mention it in the PR. |
| `web/src/components/AppShell.tsx` | Nathan Galante owns it (lot picker). |
| `web/src/index.css` | Append a clearly commented block for your feature; don't restyle existing classes. |
| `core/parking_core/interfaces.py`, `adapters/memory.py`, `adapters/aws.py` | If you add a Repository method, add it to **all three** plus a test in `core/tests/`. Append; don't reorder. |
| `core/parking_core/models.py` | Add fields as optional with defaults so old stored JSON still loads (`extra="ignore"` is on). |

### 2.4 Tests (required in every PR)
- **Every acceptance criterion in your stories gets a test**, named after it (e.g. `test_duplicate_label_warning`).
- **Every new `/admin/*` route** gets three auth tests: 401 without a token, 403 for the viewer account, 401 `session_expired` for an expired token (NFR-6). Copy the parametrized `test_admin_routes_require_admin` in `api/tests/test_api.py` into your own test file with your routes.
- API tests use the fixtures in `api/tests/conftest.py`: `client`, `admin_headers`, `viewer_headers`, `clock` (frozen time; set `clock.now`), `adapters` (memory adapters seeded with Test Lot plus an unpublished "Draft Lot").
- Web tests use `mockFetch`, `renderApp`, `deferred` and `ADMIN` from `web/src/test/helpers.tsx`.
- Before pushing:
  ```bash
  uv run ruff check . && uv run ruff format --check . && uv run pytest
  ```
  ```bash
  cd web && npm run typecheck && npm test && npm run build
  ```

### 2.5 Conventions agents must follow
- **API schemas** subclass `CamelModel` (`parking_core.models`): snake_case in Python, camelCase in JSON.
- **Errors** use `deps.error(status, code, message, **extra)`, which produces `{"error": code, "message": text}`. Use the exact user-facing messages from the stories.
- **Route dependencies:** `AdminDep` (signed-in admin), `AdaptersDep` (repository, object_store, queue), `SettingsDep`, `NowDep` (current time; tests freeze it). Never call `datetime.now()` in a route.
- **Storage** goes only through the `Repository` / `ObjectStore` interfaces, never boto3 directly in `api/`. Local vs AWS is chosen only by settings (NFR-7).
- **Web** calls the API with `api.get` / `api.post` from `web/src/api/client.ts` and loads data with `useFetch`. Types come from `types.gen.ts`, never hand-written response shapes.
- **`api.delete` exists** (added with closures). **`api.put` does not yet**: Kevin adds it in PR A, a one-line wrapper around `apiRequest`. If you need it before PR A merges, add the same line; the identical change merges cleanly.
- **States are never shown by color alone** (NFR-8): pair icons or patterns with a legend.

---

## 3. Already done before you start: closures and the vision pipeline

**Precondition:** before anyone starts sections 5–8, Nathan Jones merges PRs #7 (closures), #8 (aligner) and #9 (scorer) to `main`. Check with `git log main` that they are there. If they aren't, stop and ask him.

1. **Closures (US-10).**
   - API: `GET/POST /admin/lots/{lotId}/closures`, and `DELETE /admin/lots/{lotId}/closures/{closureId}` to end a closure early.
   - Page: `/admin/closures`.
   - The driver map shows CLOSED spaces and leaves them out of the free count.
2. **Real vision pipeline.**
   - The ACPDS + YOLO26m `SpaceScorer` (`DETECTOR=acpds_yolo`) and the ORB/homography `Aligner` (`ALIGNER=orb`), which fails photos that don't match their viewpoint with "Too few matches".
   - Pinned model weights and the pilot benchmark in `eval/`.
   - The worker's processing flow is unchanged; only the pieces plugged into it changed.

**Files owned by Nathan Jones (do not edit):**
- `worker/` (all of it)
- `eval/`, `models/`, `scripts/download_weights.py`
- `core/parking_core/state_rules.py`
- `core/parking_core/keys.py::reference_image_key` (call it; don't change it)
- the closure parts of `core/parking_core/status.py`
- `api/parking_api/routes/closures.py` and `api/parking_api/closures_schemas.py`
- `web/src/pages/ClosuresPage.tsx`, `web/src/lib/closures.ts`, `web/src/api/closures.ts`

The `api.delete` client method used by closures already exists.

**What's built:**

- **Closures endpoints** (`api/parking_api/routes/closures.py`, schemas in `api/parking_api/closures_schemas.py`; PR #7):
  - `GET /admin/lots/{lotId}/closures` → `ClosureOut[]`, every closure including ended ones, newest start first. 404 `not_found` for an unknown lot.
  - `ClosureOut = {closureId, lotId, spaceIds, reason, startsAt, endsAt, createdBy, createdAt, endedAt, active, status}`. `status` is `SCHEDULED | ACTIVE | ENDED`, computed by the server. Never derive it from the browser clock.
  - `POST /admin/lots/{lotId}/closures` body `{spaceIds, reason: CONSTRUCTION|EVENT|MAINTENANCE|RESERVED, startsAt, endsAt?}` → 201 `ClosureOut`. Datetimes must carry a timezone; `endsAt` null means open-ended; duplicate ids are dropped. Errors: 404 `not_found`; 409 `not_published` (spaces can only be closed on a published layout); 422 `invalid_window` "End time must be after start time"; 422 `unknown_space` "Unknown or retired space: X"; 422 `validation_error` for an empty `spaceIds` or a datetime without a timezone.
  - `DELETE /admin/lots/{lotId}/closures/{closureId}` → 200 `ClosureOut` with `endedAt` set. The record is kept. 404 `not_found` (also for another lot's closure), 409 `already_ended`.
  - Page `/admin/closures` (`web/src/pages/ClosuresPage.tsx`, helpers in `web/src/lib/closures.ts`, type aliases in `web/src/api/closures.ts`). It selects spaces on the driver map component, `LotMapSvg`, through its new optional multi-select props `selectedIds` / `onToggle`. Without those props the driver map behaves as before.
  - When several active closures cover one space, `core/parking_core/status.py` shows the open-ended one first, then the latest end, then the lowest `closureId`.
- **Vision: aligner** (`worker/parking_worker/aligners/orb.py`, `build_aligner` in `aligners/__init__.py`; PR #8):
  - `ALIGNER=identity|orb` (default `identity`).
  - `OrbAligner` matches ORB features between the viewpoint's reference photo and the upload, fits a RANSAC homography, maps every outline onto the photo, and sets `in_frame` only when all corners land inside it.
  - A wrong-spot photo fails permanently with "Too few matches": too few ratio-test matches or inliers, an inlier ratio below `ORB_MIN_INLIER_RATIO`, or an implausible homography (folded, mirrored, or covering less than 0.1x or more than 10x the photo).
  - Settings: `ORB_FEATURES=2000`, `ORB_MIN_MATCHES=30`, `ORB_MIN_INLIERS=25`, `ORB_MIN_INLIER_RATIO=0.4`, `ORB_RANSAC_PX=5.0` (pixels at the 1280 px working size). Pilot photos decide the final values.
  - Reference features are cached by object key. `keys.reference_image_key(lotId, viewId, sha256)` → `reference/{lotId}/{viewId}/{sha12}.jpg` is content-addressed, so that cache never goes stale (see 4.2).
  - Packaging: the worker depends on `opencv-python-headless`; a uv `override-dependencies` entry in the root `pyproject.toml` drops `opencv-python` (pulled in by ultralytics). The worker image is `python:3.12-slim-trixie` with `libglib2.0-0t64`.
- **Vision: scorer** (`worker/parking_worker/scorers/acpds_yolo.py`, vendored MIT ACPDS code in `scorers/acpds/`; PR #9):
  - `DETECTOR=stub|acpds_yolo` (default `stub`). Needs the worker's `vision` extra (torch CPU, torchvision, ultralytics).
  - ACPDS scores every outline that is wholly in the photo. An out-of-frame space gets a null ACPDS score (so it is never FREE) but keeps its car overlap.
  - YOLO26m finds cars, trucks and buses. `carOverlap` is the largest share of each outline covered by any one detection: the whole box (`box`), its lower half (`box_lower_half`) or the seg mask (`seg`).
  - States still come from `state_rules.decide_state` with the unchanged cutoffs. `modelVersion` records the scorer, both weight hashes, the overlap mode, the cutoffs and the YOLO and ACPDS input settings, e.g. `acpds_yolo|acpds=96901e9003a3|yolo=401cea9ab23a|overlap=box|low=0.3|high=0.7|…`.
  - Settings (defaults): `MODELS_DIR=models` (compose sets `/app/models`), `ACPDS_WEIGHTS=acpds/RCNN_128_square_gopro.pt`, `YOLO_WEIGHTS=yolo/yolo26m.pt`, `YOLO_SEG_WEIGHTS=yolo/yolo26m-seg.pt` (only for `seg`), `YOLO_CONF=0.25`, `YOLO_IMGSZ=1280` (a multiple of 32, at least 320; 640 misses small, distant cars), `YOLO_OVERLAP_MODE=box`, `ACPDS_INPUT_RES` unset (the photo's native resolution).
  - Weights: `models/manifest.json` pins the three files by SHA-256 and size; `.pt` files are git-ignored. The worker refuses to start if one is missing or doesn't match, and the error names `scripts/download_weights.py`. Details and licenses (ACPDS MIT, YOLO26/ultralytics AGPL-3.0) in `models/README.md` and the root README, "Model weights and detector".
    ```bash
    uv sync --all-packages --extra vision                # torch, torchvision, ultralytics
    uv run python scripts/download_weights.py            # fetch and verify
    uv run python scripts/download_weights.py --check    # verify only
    ```
  - Docker: `WORKER_EXTRAS=vision docker compose up --build` with `DETECTOR=acpds_yolo` in `.env`; compose mounts `./models` read-only. In CI the compose job still builds the stub worker; the `worker-vision-image` job builds the vision image and checks its imports.
  - Benchmark (results in PR #9: on 30 PKLot photos, `acpds_yolo` in `box` mode had 2.8% false-free, 91.7% accuracy and 5.8% UNKNOWN at about 0.6 s p50 per photo on an M2 Max; ACPDS alone and YOLO alone both miss the 5% false-free target):
    ```bash
    uv run python eval/fetch_pklot_sample.py --count 30        # -> eval/data/pklot/ (git-ignored)
    uv run python eval/benchmark.py eval/data/pklot --setup acpds --setup acpds_yolo --setup yolo
    RUN_MODEL_TESTS=1 uv run pytest -m real_model              # real weights on the fixture
    ```
  - Seed lot `pklot-ufpr04`: one real PKLot photo (fixture in `eval/fixtures/pklot/`) as its reference image. `uv run python seed/seed.py --lot pklot-ufpr04`.
  - Labeling format for pilot photos: PKLot-style XML, one `.xml` per photo; see `eval/README.md`, "Labeling format for pilot photos".

**Which aligner and scorer run where:**
- The dev runner and CI stay on `ALIGNER=identity` + `DETECTOR=stub` (the defaults): fast, no torch, no weights. Their states are not real.
- `ALIGNER=orb` needs a reference photo for every viewpoint that gets uploads. Without one, jobs fail with "No reference image for viewpoint".
- Real drone photos must be processed with `DETECTOR=acpds_yolo ALIGNER=orb`, after `uv run python scripts/download_weights.py`.

The lot onboarding proposer (HDD §4.6, proposals from one photo) is **not in this wave**. It comes next and reuses the YOLO code. Section 4 already includes `outlineReview`, so the outline editor and validation will be ready for it.

---

## 4. Shared mapping contract (David, Rylan, Kevin)

The lot mapping page (Sketch 5 in the stories) is one screen built by three people:

```
/admin/lots/:lotId/map                      (page shell: Kevin)
+----------------------------------------------------------------------+
| Lot Mapping  Test Lot  Draft based on v3  [Save] [Validate] [Publish] |  <- Kevin
+---------------------------+------------------------------------------+
| SCHEMATIC (David)         | REFERENCE PHOTO (Rylan)   View [V1 v]    |
|  rectangles, + Space,     |  photo, polygons, click 4 corners        |
|  + Row, select, label,    |                                          |
|  type, retire             |                                          |
+---------------------------+------------------------------------------+
| Validation panel (Kevin)                                             |
+----------------------------------------------------------------------+
```

To keep the three of you independent, the API and the component props are **fixed here**. Code against this section, not against each other's code. If you need to change something in it, agree with the other two first and update this file in the same PR.

### 4.1 Draft layout API (Kevin implements; David and Rylan call it)

The draft is the only editable copy of a lot's layout. Drivers and the worker only ever read the **published** snapshot, so draft edits never change the driver view until Publish (US-07 #3).

**`GET /admin/lots/{lotId}/layout/draft`** returns 200 `DraftLayout`, or 404 `not_found`.

```jsonc
// DraftLayout
{
  "lotId": "test-lot",
  "revision": 7,                 // bumps on every successful save; used for conflict detection
  "basedOnVersion": 3,           // published version this draft started from; null if never published
  "updatedAt": "2026-10-28T14:05:00Z",
  "updatedBy": "admin@example.edu",
  "schematic": { "width": 1000, "height": 600 },
  "spaces": [
    {
      "spaceId": "A-01",         // stable id; never changes once created
      "label": "A-01",           // editable display label
      "type": "STANDARD",        // STANDARD | ADA | EV
      "rect": { "x": 80, "y": 80, "w": 110, "h": 180 },   // schematic units
      "retired": false
    }
  ],
  "viewpoints": [
    {
      "viewId": "V1",
      "name": "North corner",
      "referenceImage": {        // null until a reference photo is uploaded (Rylan's endpoints)
        "url": "https://…presigned GET…",   // read-only, short-lived
        "width": 4000, "height": 3000
      },
      "outlines": {              // spaceId -> 4 corners as fractions of the photo, 0..1, clockwise
        "A-01": [[0.10, 0.20], [0.18, 0.20], [0.19, 0.31], [0.09, 0.31]]
      },
      "outlineReview": {         // optional per outline; used by the future proposer
        "A-01": { "source": "drawn", "status": "accepted" }   // source: drawn|proposed, status: pending|accepted
      }
    }
  ]
}
```

**`PUT /admin/lots/{lotId}/layout/draft`**
- **Body:** the same shape, without `updatedAt`, `updatedBy` and `referenceImage`.
- **`revision`:** must equal the stored revision.
- **200:** returns the new `DraftLayout` with `revision + 1`.
- **409 `stale_revision`** "This draft changed in another window. Reload to see the latest." when the revision doesn't match. This is how US-07 #7 (draft survives reload / another laptop) stays safe.
- **422 `cannot_delete_published_space`** when a space that exists in any published version is missing from the body. Published spaces are **retired**, never deleted, so history stays valid. Spaces that were never published may be removed.
- **422 `validation_error`** for a malformed body: a polygon without exactly 4 points, an unknown `type`, a non-unique `spaceId`.
- The server **keeps each viewpoint's reference image fields**. PUT never changes them, because only Rylan's endpoints set them.
- **New `spaceId`s** are generated by the client as `sp_` + 8 random lowercase letters or digits. Labels are separate and editable.
- **New viewpoints** are added by including them in `viewpoints`, with a client-chosen `viewId` like `V3`.

**Saving model:** one page holds one draft in memory (Kevin's `useDraftLayout` hook). Panels change it through `onChange`. Kevin's hook saves on the **Save** button and before Validate and Publish. Saving after every change is optional, and should be debounced if added.

### 4.2 Reference photo API (Rylan implements)

- **`POST /admin/lots/{lotId}/views/{viewId}/reference`**
  - Body `{contentType, sizeBytes, sha256}` returns 201 `{uploadUrl, expiresAt}`.
  - `sha256` is the file's lowercase hex SHA-256, computed by the browser exactly as `/admin/uploads` already does for photos (`sha256Hex` in `web/src/lib/sha256.ts`, same `^[0-9a-f]{64}$` check).
  - The API presigns the PUT to the content-addressed key `keys.reference_image_key(lotId, viewId, sha256)`.
  - JPEG/PNG only, 15 MB maximum, same messages as US-04.
  - 404 if the viewpoint is not in the draft.
- **`PUT uploadUrl`**: the browser uploads the file directly.
- **`POST /admin/lots/{lotId}/views/{viewId}/reference/complete`**
  - Body `{sha256, width, height}`: the same hash, and the size the browser reads from the loaded image.
  - Rebuilds the key from `sha256`, verifies the object exists (409 `missing_object` if not), reads it back and checks its SHA-256 matches (409 `hash_mismatch` "Uploaded file does not match its hash" otherwise; reference photos are at most 15 MB, so this is cheap), then sets the viewpoint's `reference_image_key`, `image_width` and `image_height`. The check matters because the key is content-addressed: a wrong hash could overwrite the photo an already published layout points at.
  - Returns 200 `{viewId, referenceImage}`.
  - Does **not** bump the draft revision, so it never conflicts with an open editor.
  - A re-upload of the same bytes maps to the same key, so it changes nothing.
- **Storage key:** `keys.reference_image_key(lotId, viewId, sha256)` → `reference/{lotId}/{viewId}/{sha12}.jpg` (first 12 hex chars of the hash). It is content-addressed: a new photo gets a new key, so a re-upload never changes what an already published layout points at, and the worker's aligner caches reference features by key. Old objects stay, because published versions still reference them.
- **Re-uploading** a reference photo **keeps** existing outlines. The editor shows a warning that outlines may need adjusting.

### 4.3 Validate, publish, versions (Kevin implements)

- **`POST /admin/lots/{lotId}/layout/draft/validate`**
  - Returns 200 `ValidationReport`:
    `{ok, errors: Issue[], warnings: Issue[], comparedWith: int|null, diff: {added: string[], retired: string[], changed: string[]}}`
  - `Issue = {code, message, spaceIds: string[], viewId: string|null}`.
- **`POST /admin/lots/{lotId}/layout/publish`**
  - Body `{revision}`.
  - 201 returns `LayoutVersionOut {version, publishedBy, publishedAt}`.
  - 409 `validation_failed` carries the report in a `report` field.
  - 409 `stale_revision`.
- **`GET /admin/lots/{lotId}/layout/versions`**: `LayoutVersionOut[]`, newest first.
- **`POST /admin/lots/{lotId}/layout/versions/{version}/restore`**
  - Replaces the draft with that version's contents (bumps revision) and returns `DraftLayout`.
  - The admin then publishes, which creates a new version (US-09 #7).

The issue codes are listed in section 8.4. David may show duplicate labels live in the editor (US-07 #5), but the server report is authoritative.

### 4.4 Front-end component contract

All mapping types go in `web/src/mapping/types.ts`, which Kevin creates in his first PR as aliases of the generated types: `DraftLayout`, `DraftSpace`, `DraftViewpoint`, `Issue`. Until it lands, David and Rylan import from `types.gen.ts` directly.

```ts
// Shared by both panels. All callbacks are pure; panels never call the API for draft data.
interface MappingSelection {
  selectedSpaceId: string | null
  onSelectSpace: (spaceId: string | null) => void
  hoveredSpaceId: string | null          // linked highlight between panels (US-08 #6)
  onHoverSpace: (spaceId: string | null) => void
}

// David: web/src/mapping/SchematicEditor.tsx
export interface SchematicEditorProps extends MappingSelection {
  draft: DraftLayout
  onChange: (next: DraftLayout) => void
  issues: Issue[]                         // from Kevin's last validation; highlight affected spaces in red
}

// Rylan: web/src/mapping/ReferencePhotoPanel.tsx
export interface ReferencePhotoPanelProps extends MappingSelection {
  lotId: string
  draft: DraftLayout
  viewId: string | null
  onViewChange: (viewId: string) => void
  onChange: (next: DraftLayout) => void   // outline add/move/delete, new viewpoint
  onReferenceUploaded: () => void         // Kevin's page reloads the draft (picks up referenceImage)
  issues: Issue[]
}
```

**Independence rule:** both panels must work when rendered alone with a fixture `DraftLayout`. Each of you keeps your own fixture in `web/src/mapping/fixtures/<yourname>.ts`, and your tests render the panel alone. Kevin's page imports both panels. Until a panel exists, Kevin uses a placeholder `<div>`, so all three PRs can merge in any order after Kevin's first PR.

---

## 5. Nathan Galante: Snapshots page, admin lot picker, create a lot

**Stories:** US-06 (Monitor and Retry Processing Jobs), US-16 (Add and Switch Between Lots). The US-06 API already exists, so that part is UI only.

**You own:**
- Pages: `web/src/pages/SnapshotsPage.tsx` (replaces `SnapshotsPlaceholderPage.tsx`, delete that file), `web/src/pages/NewLotPage.tsx`
- Lot picker: `web/src/admin/` (picker component and `useAdminLot` hook)
- Admin shell: `web/src/components/AppShell.tsx`, `web/src/pages/AdminHomePage.tsx`
- API: `api/parking_api/routes/lots_admin.py` + `api/parking_api/lots_admin_schemas.py`
- Tests: `api/tests/test_lots_admin.py`, and web tests next to your files

### 5.1 API you build
- **`GET /admin/lots`**: every lot, published or not:
  `[{lotId, name, location, staleAfterMinutes, published: bool, layoutVersion: int|null, createdAt}]`, sorted by name.
- **`POST /admin/lots`**
  - Body `{name, location, staleAfterMinutes}` returns 201 with the same item shape.
  - `lotId` is a slug of the name (`"North Lot"` → `north-lot`), with `-2`, `-3` appended if that id is taken.
  - `name` is required and trimmed. `staleAfterMinutes` is an integer from 1 to 1440, otherwise 422 `validation_error`.
  - 409 `duplicate_lot_name` "A lot with this name already exists", comparing names trimmed and case-insensitive (US-16 #2).
  - Writes the `Lot` through `repository.put_lot`, with no spaces or viewpoints. That makes an empty draft.
  - Does **not** publish. Unpublished lots are already hidden from drivers by `GET /lots` (US-16 #4); keep a test that proves it.

### 5.2 Lot picker (US-16 #3)
- **Hook:** `useAdminLot()` returns `{lotId, setLotId, lots}`. It reads and writes `localStorage['parking.admin.lotId']`, the key the upload page already uses (`ADMIN_LOT_KEY` in `UploadPage.tsx`), and gets the lot list from `GET /admin/lots`.
- **Picker:** a select in the admin header (`AppShell`), shown only to a signed-in admin.
- **Effect of switching:**
  - Upload, Snapshots and Closures use the picked lot. The Closures page already reads `localStorage['parking.admin.lotId']` (via `ADMIN_LOT_KEY`) when it opens, falling back to the first lot, so it needs no change.
  - Routes that carry `:lotId` in the URL (Kevin's `/admin/lots/:lotId/map`) navigate to the same page for the new lot.
  - Change the Upload page's initial lot to come from `useAdminLot`. That's a one-line change, so note it in your PR.
- **No lots:** with zero lots the picker shows "No lots yet" and a link to New Lot.

### 5.3 Snapshots page (US-06), route `/admin/snapshots`

Layout follows Sketch 4. The table columns are Captured, View, State, Time, Model and Error, plus a Retry button.
- **Data:** `GET /admin/snapshots?lotId=<picked lot>` is already sorted newest capture first. Time shows `processingMs` as "18 s", or "-".
- **Polling:** every 5 s while any row is `UPLOAD_PENDING`, `QUEUED` or `PROCESSING`. Stop when none are.
- **Expired uploads:** `EXPIRED` rows show "Expired" (US-04 #7).
- **Retry button:**
  - Shown **only** when `jobStatus === "FAILED" && finished` (US-06 #4).
  - Calls `POST /admin/snapshots/{imageId}/retry`.
  - Shows a 409 `not_retryable` message inline.
- **Detail:** clicking a row opens a detail panel from `GET /admin/snapshots/{imageId}`. It shows "Processed with layout v{layoutVersion}" (US-06 #6, US-09 #5) and, per space:
  - state;
  - ACPDS score (`acpdsScore`, may be null for an out-of-frame space; show "-");
  - car overlap (`carOverlap`);
  - in-frame flag (`inFrame`).
- **Model column:** `modelVersion` is `stub-0` from the stub scorer, or with `DETECTOR=acpds_yolo` a long string encoding the scorer, weight hashes, overlap mode and cutoffs (`acpds_yolo|acpds=96901e9003a3|yolo=401cea9ab23a|overlap=box|…`). Show the part before the first `|` in the table and the full string in the detail panel.
- **Anchor:** `/admin/snapshots#<imageId>` (linked from the duplicate-upload message) scrolls to and highlights that row.

### 5.4 New Lot page, route `/admin/lots/new`
- **Form:** name, location, allowed data age in minutes.
- **On success:** set the picker to the new lot and go to `/admin` (or to `/admin/lots/<id>/map` once Kevin's page exists).
- **Errors:** show "A lot with this name already exists" for a 409.

### 5.5 Acceptance criteria → tests
- **US-06 #1:** rows newest capture first, with viewpoint, state, time, model and error.
- **US-06 #2:** a FAILED row shows "Too few matches". Seed it with `repository.transition_job` in the test.
- **US-06 #3:** pressing Retry makes the row show QUEUED.
- **US-06 #4:** no Retry button for COMPLETE, QUEUED or PROCESSING.
- **US-06 #5:** "Failed after 3 attempts" still shows Retry.
- **US-06 #6:** the detail view shows per-space state, confidence, overlap and layout version.
- **US-16 #1:** creating a lot adds it to the picker with an empty draft.
- **US-16 #2:** a duplicate name gets the message and nothing is created.
- **US-16 #3:** switching lots changes what Upload and Snapshots show.
- **US-16 #4:** an unpublished lot is not in `GET /lots`.
- **US-16 #6:** closing row B of Test Lot does not affect North Lot's counts. Create a closure with `repository.put_closure` in the test.
- **Auth:** 401/403/expired tests for `GET/POST /admin/lots`.

### 5.6 Out of scope
- US-16 #5 (a published lot appears for drivers) works once Kevin's publish exists. Add that test after his PR merges.
- No lot editing or deletion.

### 5.7 Agent kickoff prompt
> Read `Docs/phase1-team-brief.md` sections 1, 2, 3 and 5, and `Docs/CS498 Milestone 1 User Stories - Final.pdf` for US-06 and US-16. Implement section 5 on branch `wave2/galante-lots-snapshots` from an up-to-date `main`. Follow section 2's rules exactly: own schema module, one `include_router` line, regenerate `contract/openapi.json` and `web/src/api/types.gen.ts`, a test per acceptance criterion, and auth tests for every admin route. Do not edit files owned by others. Run the checks in 2.4 before every commit. Open a PR describing which criteria are covered.

---

## 6. David Eliassen: schematic editor

**Story:** US-07 (Draw the Lot Schematic). It's the biggest UI piece. Pure front end: you call no API directly, because Kevin's page loads and saves the draft.

**You own:**
- Editor: `web/src/mapping/SchematicEditor.tsx`, plus any helpers in `web/src/mapping/schematic/`
- Fixture: `web/src/mapping/fixtures/david.ts`
- Tests: alongside your files
- Optional library: `react-konva` + `konva` for drag and resize (named in HDD §3.1). Plain SVG with pointer events is fine too; pick one and note it in the PR.

### 6.1 Behavior (props in section 4.4)
- **Render:** one rectangle per space at `rect`, inside a `viewBox` of `0 0 schematic.width schematic.height`, labeled with `label`. ADA and EV spaces show a small type badge. Retired spaces are greyed with a "Retired" marker and are not editable.
- **+ Space (US-07 #1):** adds a rectangle with the **next unused label**. Next unused means: the highest number in the selected row, or in row A when nothing is selected, plus 1, formatted `A-08`. The new space gets a new `sp_…` id and a default size matching the row's median rectangle. Call `onChange`.
- **+ Row (US-07 #2):** a small dialog asks for the start label (e.g. `B-01`) and the count (e.g. 10). It places evenly spaced rectangles `B-01`…`B-10` in a line below the lowest row, each with a new id.
- **Select:** click a rectangle to select it (`onSelectSpace`). Hovering calls `onHoverSpace`. Highlight `selectedSpaceId` and `hoveredSpaceId` (a hover from the photo panel highlights here too, US-08 #6).
- **Move and resize (US-07 #3):** dragging moves and corner handles resize. Snap to whole units. Keep rectangles inside the schematic bounds. Call `onChange` on pointer up, not on every move.
- **Side panel for the selected space (US-07 #4):** label text field, type select (Standard, ADA, EV), and a **Retire space** button (US-07 #6). Retire sets `retired: true` and keeps its outlines.
- **Delete:** shown only for spaces that were never published (`basedOnVersion === null`, or the id isn't in the published layout). Published spaces are retired, never deleted (see 4.1). Put the published-id check in a pure helper, so a test can pass the published ids in.
- **Duplicate labels (US-07 #5):** when two active spaces share a label, outline **both** in red with the note "Label already used". Do this live in the component. Also outline in red any space listed in `issues` (from Kevin's validation).
- **Keyboard:** arrow keys move the selected space by 1 unit (10 with Shift). Esc clears the selection.
- **Accessibility:** each rectangle gets `role="button"` and an `aria-label` like "A-03, standard".

### 6.2 Acceptance criteria → tests
Render the component alone with your fixture and assert on the `onChange` payloads.
- **US-07 #1:** + Space appends one space with the next unused label.
- **US-07 #2:** + Row 10 from B-01 gives B-01…B-10, evenly spaced on one line.
- **US-07 #3:** a drag or resize emits updated `rect` values. The driver view staying unchanged until publish is Kevin's test.
- **US-07 #4:** changing type to ADA or EV shows it in the editor and emits it.
- **US-07 #5:** renaming to an existing label marks both spaces red with "Label already used".
- **US-07 #6:** Retire greys the space and emits `retired: true`. Hiding it from drivers after publish is Kevin's test.
- **US-07 #7:** the draft surviving a reload is covered by Kevin's API. You only test that your component renders whatever draft it's given.

### 6.3 Out of scope
- Saving, loading, validation and publish (Kevin).
- Photo outlines (Rylan).
- Selecting spaces for closures. That is done on the driver map component (`LotMapSvg`), not the editor. `LotMapSvg` now has optional `selectedIds` / `onToggle` multi-select props; you may reuse them or ignore them.

### 6.4 Agent kickoff prompt
> Read `Docs/phase1-team-brief.md` sections 1, 2, 3, 4 and 6, and US-07 and US-08 #6 in `Docs/CS498 Milestone 1 User Stories - Final.pdf`. Implement `SchematicEditor` exactly to the props in section 4.4 on branch `wave2/david-schematic-editor` from an up-to-date `main`. It must work rendered alone with the fixture in `web/src/mapping/fixtures/david.ts`. It never calls the API. Write a Vitest test per acceptance criterion in 6.2. Keep `npm run typecheck`, `npm test` and `npm run build` green. Do not edit files owned by others, and don't build closure selection into the editor (6.3). If Kevin's `web/src/mapping/types.ts` isn't on `main` yet, alias the generated types locally and switch when it lands.

---

## 7. Rylan Moseley: reference photo and space outlines

**Story:** US-08 (Outline Spaces on a Reference Photo). It has a small backend (4.2) and a UI panel.

**You own:**
- Photo panel: `web/src/mapping/ReferencePhotoPanel.tsx`, plus helpers in `web/src/mapping/photo/`
- Fixture: `web/src/mapping/fixtures/rylan.ts`
- API: `api/parking_api/routes/reference.py` + `api/parking_api/reference_schemas.py`
- Local photo serving: the memory adapter's `presign_get` and a test-only GET route (7.2)
- Tests: `api/tests/test_reference.py`, and web tests next to your files

### 7.1 Backend (section 4.2)
- Implement the two endpoints exactly as in 4.2, with auth tests. Build the key only with `keys.reference_image_key(lotId, viewId, sha256)`; don't write your own path.
- Test the content addressing: the same bytes uploaded twice leave the viewpoint unchanged, and a different photo gets a new key while a published layout keeps the old one.
- Reuse the upload validation rules and messages from `api/parking_api/routes/uploads.py` (type, 15 MB). Don't duplicate them: move them into a small shared helper module if needed and note that in the PR.
- `complete` must return 409 `missing_object` when the file never arrived.

### 7.2 Making the photo visible locally (required for the dev runner)
- **The problem:** in the memory adapter, `presign_get` returns `memory://…`, which a browser can't load.
- **The fix, part 1:** make `MemoryObjectStore.presign_get(key)` return `/api/_test/objects/<key>`.
- **The fix, part 2:** add `GET /_test/objects/{key:path}` to `api/parking_api/routes/testonly.py`. It returns the stored bytes with their content type, or 404. It only exists when `APP_ENV=test`, like the existing test upload route. Reference keys have one more path segment now (`reference/{lotId}/{viewId}/{sha12}.jpg`); `{key:path}` already handles it.
- **With RustFS or AWS** nothing changes: the presigned GET URL works directly.
- **Kevin's `GET …/draft`** builds `referenceImage.url` with `object_store.presign_get`, so this change makes his endpoint work locally too.

### 7.3 Panel behavior (props in section 4.4)
- **View selector:** a select of the draft's viewpoints, plus **+ Viewpoint**. That asks for a name and adds `{viewId: "V<n>", name, outlines: {}}` via `onChange`. Kevin's Save persists it.
- **Upload reference photo (US-08 #1):**
  - Shown when the viewpoint has no `referenceImage`, and as "Replace photo" when it has one.
  - Flow: hash the file with `sha256Hex` (`web/src/lib/sha256.ts`), request the slot with the hash, PUT the file with progress (reuse `web/src/lib/putFile.ts`), call `complete` with the hash and the image's natural width and height, then `onReferenceUploaded()`.
  - After a replace, show "Check outlines: the photo changed."
- **Photo and polygons:**
  - Show the photo scaled to fit. Draw every outline in this viewpoint as a polygon, mapping 0..1 coordinates to displayed pixels.
  - Label each polygon with its space's label. Retired spaces' outlines are dashed grey.
- **Outline a space (US-08 #2):**
  - With a space selected (from the schematic or the space list), click 4 corners.
  - Show "Click the 4 corners of A-03 (n of 4)".
  - After the 4th click, order the corners clockwise and convert them to fractions.
  - Emit `onChange` with `outlines[spaceId]` set and `outlineReview[spaceId] = {source: "drawn", status: "accepted"}`.
  - Then show "A-03 outlined in V1".
- **Adjust (US-08 #3):** drag a corner handle to move it, emitting on pointer up. Clamp to 0..1.
- **Cancel (US-08 #5):** Esc during an outline discards the partial clicks and emits nothing.
- **Delete outline:** shown for the selected space, if it has an outline in this view.
- **Two viewpoints (US-08 #4):** one space can have outlines in several views. Show "A-03: 2 views" in the panel's space list. Count across `draft.viewpoints`.
- **Linked highlight (US-08 #6):** hovering a polygon calls `onHoverSpace`. When `hoveredSpaceId` is set (from the schematic), highlight that polygon.
- **Issues:** highlight polygons listed in `issues` in red, e.g. outside the photo.
- **Proposed outlines (forward-compatible):** if `outlineReview[spaceId].status === "pending"`, draw the polygon in a distinct dashed style with Accept and Reject buttons. Accept sets `status: "accepted"` and Reject removes the outline. The proposer that creates these comes later; test it with a fixture.

### 7.4 Acceptance criteria → tests
- **US-08 #1:** after a reference upload for V1, the panel shows the photo. API test: `complete` sets `referenceImage` on the draft. UI test: the upload flow, with mocked fetch.
- **US-08 #2:** clicking 4 points while A-03 is selected emits a 4-point outline linked to A-03, and shows "A-03 outlined in V1".
- **US-08 #3:** dragging a handle emits the updated polygon.
- **US-08 #4:** outlining A-03 in V1 and V2 stores both, and shows a 2-view count.
- **US-08 #5:** Esc after 2 clicks emits nothing.
- **US-08 #6:** hover links both ways, via the props.
- **Auth:** 401/403/expired tests for both reference endpoints.
- **Test-only route:** returns 404 when `APP_ENV` is not `test`.

### 7.5 Out of scope
- The proposer.
- Schematic rectangles (David).
- Saving the draft (Kevin's page does it via `onChange`).

### 7.6 Agent kickoff prompt
> Read `Docs/phase1-team-brief.md` sections 1, 2, 3, 4 and 7, and US-08 in `Docs/CS498 Milestone 1 User Stories - Final.pdf`. Implement section 7 on branch `wave2/rylan-reference-outlines` from an up-to-date `main`: the reference photo endpoints (4.2) with tests, the memory `presign_get` plus test-only object route (7.2), and `ReferencePhotoPanel` exactly to the props in 4.4. It must work rendered alone with `web/src/mapping/fixtures/rylan.ts`. Follow section 2's contract workflow and add a test per criterion. Do not edit files owned by others.

---

## 8. Kevin Nguyen: draft storage, validation, publish, versions

**Stories:** US-09 (Validate and Publish a Layout) as the main piece, the US-07 #7 draft persistence, and US-14 (verify the full stack from a clean clone). You also own the mapping page shell, so **land a first small PR fast** (8.1). David and Rylan plug into it.

**You own:**
- API: `api/parking_api/routes/layout.py` + `api/parking_api/layout_schemas.py`
- Core logic: `core/parking_core/layouts.py` (validation and publish), and new Repository methods (8.2) in `interfaces.py`, `memory.py`, `aws.py`
- Web: `web/src/mapping/LotMappingPage.tsx`, `useDraftLayout.ts`, `ValidationPanel.tsx`, `VersionsPage.tsx`, `types.ts`
- Routes: `/admin/lots/:lotId/map`, `/admin/lots/:lotId/versions`
- Tests: `api/tests/test_layout.py`, `core/tests/test_layouts.py`, and web tests next to your files

### 8.1 PR A, first and small (target: two days)
- `GET` and `PUT /admin/lots/{lotId}/layout/draft` exactly as in 4.1, including `revision`, `stale_revision` and `cannot_delete_published_space`.
- The draft-meta storage from 8.2.
- `web/src/mapping/types.ts`, the `useDraftLayout(lotId)` hook (load, local state, `save()`, `reload()`, stale-revision handling), and `LotMappingPage` with placeholder panels and a working Save button.
- Admin home link "Map" pointing to `/admin/lots/<picked lot>/map`. Until Nathan Galante's picker lands, use `localStorage['parking.admin.lotId']`, falling back to the first lot.

### 8.2 Data you add (append only; all three adapters plus tests)
- **Draft meta item**
  - Key: PK `LOT#<id>`, SK `DRAFT`. Add `keys.draft_sk()`.
  - Fields: `schematic`, `revision`, `basedOnVersion`, `updatedAt`, `updatedBy`.
  - `Repository.get_draft_meta(lot_id) -> DraftMeta | None`.
  - `Repository.put_draft_meta(meta, expected_revision: int | None) -> bool`: a conditional write on `revision`, with `None` meaning the item must not exist.
- **`Repository.delete_space(lot_id, space_id) -> None`**: for never-published spaces only. The route enforces that.
- **Model field:** `Viewpoint.outline_review: dict[str, OutlineReview] = {}`, with `OutlineReview(source, status)`, in `core/parking_core/models.py`. It's optional and old data still loads.
- **Draft storage:** draft spaces and viewpoints reuse the existing `SPACE#` / `VIEW#` items (`put_spaces`, `list_spaces`, `put_viewpoint`, `list_viewpoints`). The seed already writes them, so Test Lot has a draft from day one. A lot with no draft meta yet gets one on first GET: `revision 0`, `basedOnVersion` = current published version or null, schematic from the published layout or 1000×600.
- **Not a full transaction:** the draft PUT writes the meta and the items separately. Write the items first and the meta last, so a failed save never advances the revision.

### 8.3 Publish logic (`core/parking_core/layouts.py`)
1. Validate (8.4). If there are errors, return 409 `validation_failed` with the report.
2. Build a `PublishedLayout` from the draft: all spaces including retired ones, all viewpoints, and the schematic. Use `version = (current or 0) + 1`, `published_by = admin email`, `published_at = now`. Copy each viewpoint's `reference_image_key` into the snapshot as-is (the `Viewpoint` model already carries it); never rebuild or rename it. The key is content-addressed (4.2), so a later reference re-upload can't change what this version points at.
3. Write the snapshot JSON to `keys.layout_snapshot_key(lot, version)`, then call `repository.publish_layout(...)`. That writes the LayoutVersion and moves the pointer in one transaction (HDD §6.5).
4. Set the draft meta's `basedOnVersion = version`.

`seed/parking_seed/loader.py` publishes the same way, so move that code into `layouts.py` and have the seed call it. Note it in the PR.

**Already handled elsewhere:**
- The worker reads the lot's current version at the start of each job and pins it on the snapshot, together with the scorer's `modelVersion`. A photo processing during a publish therefore keeps v3 (US-09 #5).
- The driver app refetches the schematic when `layoutVersion` changes (US-09 #4).

### 8.4 Validation rules: the core of your work
The function must be pure: `validate_draft(draft, published: PublishedLayout | None) -> ValidationReport`, unit-tested in `core/tests/test_layouts.py`.

**Errors (block publishing, US-09 #2):**

| code | rule | message (example) |
|---|---|---|
| `duplicate_label` | two **active** spaces share a label (case-insensitive, trimmed) | "Two spaces share the label B-04" |
| `empty_label` | an active space has a blank label | "A space has no label" |
| `polygon_outside_photo` | any outline corner outside 0..1 | "A-09 polygon is outside the V2 photo" |
| `bad_polygon` | not 4 points, zero area, or self-intersecting | "A-09 outline in V2 is not a valid four-sided shape" |
| `outline_unknown_space` | an outline references a spaceId not in the draft | "V1 has an outline for a space that does not exist" |
| `outlines_without_photo` | a viewpoint has outlines but no reference photo | "V2 has outlines but no reference photo" |
| `pending_proposals` | any `outlineReview.status == "pending"` | "3 proposed outlines are still waiting for review" |
| `rect_outside_schematic` | a schematic rectangle extends past the schematic bounds | "B-10 is outside the map area" |
| `no_active_spaces` | the draft has no active spaces | "The layout has no spaces" |

**Warnings (shown, don't block, US-09 #3):**

| code | rule | message (example) |
|---|---|---|
| `unmapped_spaces` | active spaces with no outline in any viewpoint | "3 spaces have no polygon in any view: they will show UNKNOWN" |
| `retired_with_outlines` | retired spaces that still have outlines (ignored by the worker) | "A-07 is retired but still outlined in V1" |
| `viewpoint_without_outlines` | a viewpoint with a photo but no outlines | "V3 has no outlined spaces" |
| `overlapping_rects` | two active rectangles overlap on the schematic | "A-03 and A-04 overlap on the map" |

The report also includes `comparedWith` (the published version) and `diff` (space ids added, retired, and changed in rect, label, type or outlines). Sketch 6 shows the "Draft compared with v3" header.

### 8.5 UI
- **Mapping page header:** "Lot Mapping · {lot name} · Draft based on v{basedOnVersion}", or "Not published yet", with Save, **Validate** and **Publish**.
- **Validate** saves first, then shows the report in `ValidationPanel`: x for errors, ! for warnings, each issue listing its spaces. Clicking an issue selects its first space. Pass `issues` to both panels.
- **Publish** is disabled while the last report has errors (US-09 #2). On success, show "Published v{n}". On `stale_revision`, prompt to reload.
- **Versions page:** a list of versions newest first, with who published each and when (US-09 #6), and **Restore** per row (US-09 #7). Restore loads that version into the draft and returns to the mapping page with a note: "Draft restored from v3. Publish to make it live."

### 8.6 US-14: verify a clean clone (non-feature work, but yours)
On your own laptop with OrbStack or Docker Desktop installed, follow `README.md` from a fresh clone:
```bash
cp .env.example .env && docker compose up --build
```
```bash
set -a; . ./.env.ci-host; set +a; uv run python seed/seed.py
```
Then upload a photo through the browser at http://localhost:5173 and confirm the map updates.

Fix any README gaps. Report anything broken in the RustFS / compose setup to Nathan Jones; don't change `docker-compose.yml` without telling him.

### 8.7 Acceptance criteria → tests
- **US-09 #1:** a draft with a duplicate label, an out-of-bounds polygon and unmapped spaces lists each as error or warning.
- **US-09 #2:** publish returns 409 `validation_failed` while errors exist, and the UI button is disabled.
- **US-09 #3:** a draft with warnings only publishes, and the unmapped spaces show UNKNOWN in `GET /lots/{id}/status`.
- **US-09 #4:**
  - v3 then Publish makes v4 with publisher and time.
  - `GET /lots/{id}` returns version 4.
  - A snapshot queued after the publish is processed with v4. Use the worker handler in a test with memory adapters; reading it is fine, don't edit `worker/`.
  - The worker pins `modelVersion` on the snapshot too (`stub-0` with the stub scorer), so you can assert both.
- **US-09 #5:** a snapshot pinned to v3 keeps `layoutVersion 3` after v4 is published.
- **US-09 #6:** versions are listed newest first with who and when.
- **US-09 #7:** Restore v3 then publish creates v5 with v3's contents, and v4 is unchanged.
- **US-07 #3:** editing the draft does not change `GET /lots/{id}` until publish.
- **US-07 #6:** a retired space disappears from the driver view after publish, and its observations stay.
- **US-07 #7:** after PUT, a new client's GET returns the edits. Stale revision returns 409.
- **Draft rules:** deleting a published space returns 422 `cannot_delete_published_space`.
- **Auth:** 401/403/expired tests for every route in 4.1 and 4.3.

### 8.8 Agent kickoff prompt
> Read `Docs/phase1-team-brief.md` sections 1, 2, 3, 4 and 8, and US-07 #3/#6/#7, US-09 and US-14 in `Docs/CS498 Milestone 1 User Stories - Final.pdf`. Start with PR A (8.1) on branch `wave2/kevin-draft-api` from an up-to-date `main` and keep it small. Then PR B on `wave2/kevin-validate-publish`: validation (8.4) as a pure, fully unit-tested function, then publish, versions and restore (4.3, 8.3) and the UI (8.5). Follow section 2's rules: add every new Repository method to the interface, the memory adapter and the AWS adapter with tests, regenerate the contract and types, and write a test per criterion in 8.7. Do not edit `worker/` or other people's files.

---

## 9. Merge order, timeline, non-coding work

### 9.1 Merge order
1. **Wave 1 is on `main` (done).** #1–#5 merged into their stacked branches; #6 carried the whole stack to `main`.
2. **Nathan Jones:** #7 closures, #8 aligner, #9 vision, in any order. Each is reviewed by a teammate and merged with **Create a merge commit**. `uv.lock` is regenerated on rebase (`uv lock`), like the contract files; never hand-merge it.
3. **Then this brief**, with section 3 filled in.
4. **Teammates start here.** Kevin's PR A (draft API and page shell) merges first.
5. **Any order after that:** Nathan Galante, David, Rylan, Kevin PR B. Rebase on `main` before merging, then regenerate the contract and types.

### 9.2 Timeline (proposed; edit together)

| Dates | Work |
|---|---|
| Oct 22 | Closures (#7), aligner (#8) and vision (#9) PRs opened. Review them. |
| Oct 22–23 | Pilot photos and labeling (9.3). Detector decision Oct 23, from the PKLot numbers in PR #9 plus the pilot photos once they exist. |
| Oct 23–28 | Nathan Jones: land #7–#9, then the pilot benchmark (cutoffs, overlap mode, `ORB_*`). Teammates: pilot photos and labeling. |
| Oct 28–29 | Brief merged to `main`, tasks handed out. Kevin: PR A. |
| Oct 29–Nov 6 | Features in sections 5–8 land, each with a teammate review. |
| Nov 7–10 | Integration on `main`: full walkthrough of the stories, edge-case tests, demo script. |
| Nov 11 | Milestone 2 demo. |

### 9.3 Non-coding work, everyone, needed by Oct 23
- **Test lot:** pick it and confirm permission to photograph it (HDD §13.2). Check the FAA and university drone rules.
- **Photos:** fly the fixed positions. Collect 20–30 photos per position across 3 times of day, with at least 300 occupied spaces in total, for the pilot (HDD §4.4).
- **Labeling:** label the photos as free or occupied per space, in PKLot-style XML: one `.xml` next to each photo, with one `<space id occupied>` element (and its 4-corner contour) per outlined space. Format and example in `eval/README.md`, "Labeling format for pilot photos". Leave out a space nobody can judge.
- **Reviews:** #7, #8 and #9 each need one reviewer who isn't the author.

### 9.4 Definition of done (every PR)
- Every acceptance criterion of your stories has a passing test, and the PR description lists them.
- All checks in 2.4 pass locally, and CI is green.
- The contract and generated types are regenerated if the API changed.
- You walked through the feature in the dev runner (section 1).
- One teammate reviewed and approved.

---

## 10. Appendix: reference for coding agents

### 10.1 Repository layout (relevant parts)
```
api/parking_api/
  main.py              # create_app(); include_router lines
  deps.py              # AdminDep, AdaptersDep, SettingsDep, NowDep, error()
  schemas.py           # wave-1 schemas (don't add; make your own module)
  routes/              # one module per feature
  routes/closures.py   # closures API (US-10)
  export_openapi.py    # python -m parking_api.export_openapi
core/parking_core/
  models.py            # Lot, ParkingSpace, Viewpoint, PublishedLayout, LayoutVersion, Snapshot, Closure, CamelModel
  keys.py              # DynamoDB and object key builders (lot_pk, space_sk, view_sk, layout_sk, reference_image_key, ...)
  interfaces.py        # Repository, ObjectStore, JobQueue, AuthVerifier, Aligner, SpaceScorer
  adapters/memory.py   # in-memory implementations (tests, dev runner)
  adapters/aws.py      # boto3 implementations (compose stack, AWS)
  status.py            # driver status builder (closures overlay)
worker/parking_worker/
  aligners/            # identity.py, orb.py (ALIGNER), build_aligner
  scorers/             # stub.py, acpds_yolo.py (DETECTOR), acpds/ (vendored), build_scorer
models/                # manifest.json pins the weights; *.pt downloaded, not committed
scripts/download_weights.py   # fetch + verify weights (--check to verify only)
eval/benchmark.py      # pilot benchmark (false-free, accuracy, UNKNOWN, latency)
eval/fetch_pklot_sample.py    # PKLot sample -> eval/data/pklot/ (git-ignored)
seed/                  # seed CLI, lot JSON, PKLot importer
web/src/
  api/client.ts        # api.get/post/delete (put added by Kevin, see 2.5), ApiError, errorMessage
  api/types.gen.ts     # GENERATED from contract/openapi.json
  lib/useFetch.ts      # data loading hook
  lib/putFile.ts       # PUT a file to a presigned URL with progress
  auth/RequireAdmin.tsx
  components/LotMapSvg.tsx, StateIcon.tsx
  test/helpers.tsx     # mockFetch, renderApp, deferred, ADMIN
contract/openapi.json  # GENERATED; commit it
```

### 10.2 Existing API (wave 1 and closures)

| Method | Path | Auth |
|---|---|---|
| GET | `/health` | public |
| POST | `/auth/login` | public (dev only) |
| GET | `/lots`, `/lots/{lotId}`, `/lots/{lotId}/status` | public |
| POST | `/admin/uploads`, `/admin/uploads/{imageId}/complete` | admin |
| GET | `/admin/snapshots?lotId=`, `/admin/snapshots/{imageId}` | admin |
| POST | `/admin/snapshots/{imageId}/retry` | admin |
| GET, POST | `/admin/lots/{lotId}/closures` | admin |
| DELETE | `/admin/lots/{lotId}/closures/{closureId}` | admin |
| PUT | `/_test/uploads/{imageId}` | test env only |

The browser calls these with an `/api` prefix (`/api/lots`). The Vite dev server strips it.

### 10.3 Troubleshooting
- **`ModuleNotFoundError: parking_core` / `parking_api`:** run `uv sync`. On macOS, if a tool hides files, run `chflags nohidden .venv/lib/python3.12/site-packages/*.pth`. The dev runner and pytest no longer depend on these files.
- **CI "OpenAPI contract is up to date" fails:** rerun the export (2.2) and commit.
- **CI "Generated TS types are up to date" fails:** run `npm run gen:types` in `web/` and commit.
- **`DETECTOR=acpds_yolo` fails at startup naming `scripts/download_weights.py`:** the weights are missing or don't match the manifest. Run `uv run python scripts/download_weights.py`.
- **`uv sync` removed torch / "needs torch, torchvision, ultralytics":** a plain `uv sync` drops optional extras. Use `uv sync --all-packages --extra vision`.
- **Port 8000 or 5173 in use:** stop old dev servers. The dev runner accepts a port, e.g. `uv run python scripts/dev_inmemory.py 8010`; point Vite at it with `API_PROXY_TARGET=http://localhost:8010 npm run dev`.
