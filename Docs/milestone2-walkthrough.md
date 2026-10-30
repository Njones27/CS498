# Milestone 2 acceptance walkthrough

A hand check of every acceptance criterion in `Docs/CS498 Milestone 1 User Stories - Final.pdf`,
to run on `main` between Nov 7 and Nov 10, 2026 (demo: Nov 11). One section per story, one
checkbox per criterion. Tick a box only after you saw the expected result in the browser.
Criteria the app does not meet yet are collected in [Gaps](#gaps) at the end.

## Tags

| Tag | What you need |
|---|---|
| `[stub]` | The default dev runner below. No Docker, no weights. |
| `[orb]` | The dev runner started with `ALIGNER=orb` (OpenCV only; no weights needed). |
| `[models]` | The real detector: `DETECTOR=acpds_yolo ALIGNER=orb`, the `vision` extra and the weights (`models/README.md`). |
| `[compose]` | The Docker Compose stack (`docker compose up --build`). Docker is not installed on Nathan's laptop; the CI job "Compose stack end to end" (`.github/workflows/ci.yml`) runs it on every push. |
| `[tests]` | Not practical by hand; the named automated test is the evidence. Run it and tick the box when it passes. |

## Setup

### Start the app (dev runner)

```bash
git switch main && git pull
uv sync --all-packages
cd web && npm install && cd ..        # first time only

# Terminal A: API + worker in one process, in-memory adapters, seeds one lot
uv run python scripts/dev_inmemory.py --lot test-lot

# Terminal B: Vite on http://localhost:5173, proxies /api to :8000
cd web && npm run dev
```

Terminal A prints `Loaded Test Lot with 14 spaces and 2 viewpoints` and a `Dev admin:` line
with the admin email and password.

- Admin account: `admin@example.edu`. The password is `dev_admin_password` in
  `core/parking_core/settings.py`; the dev runner prints it on start. Do not paste it into docs
  or slides.
- Non-admin account (US-03 #5): `dev_user_email` / `dev_user_password` in the same file. The
  runner does not print it.
- Everything lives in memory: stopping the runner wipes every upload, closure, lot and version.
  The runner seeds exactly one lot (`--lot test-lot`, `drone-lot` or `pklot-ufpr04` from
  `seed/lots/`); create more with New lot (US-16).
- If Terminal A fails with `ModuleNotFoundError: parking_core`, run
  `chflags nohidden .venv/lib/python3.12/site-packages/*.pth`.
- The sign-in is kept in `sessionStorage`, so every new browser tab signs in again. The admin
  lot choice is kept in `localStorage` (`parking.admin.lotId`); after restarting the runner with
  a different `--lot`, clear it (see Gaps G1).

### Runner variants

```bash
# [orb] real photo-to-reference alignment, stub scores (no weights)
ALIGNER=orb uv run python scripts/dev_inmemory.py --lot test-lot

# [models] real detector; once: install the extra and the weights
uv sync --all-packages --extra vision
uv run python scripts/download_weights.py          # verify: --check
DETECTOR=acpds_yolo ALIGNER=orb uv run --no-sync python scripts/dev_inmemory.py --lot drone-lot

# US-03 #4: sessions that expire after one minute
JWT_TTL_MINUTES=1 uv run python scripts/dev_inmemory.py --lot test-lot
```

The runner reads these settings from environment variables (it ignores `.env`). `--no-sync`
keeps `uv run` from re-syncing the environment; a plain `uv sync --all-packages` without
`--extra vision` removes torch again.

### Test photos

None of the fixtures carries EXIF, and the duplicate check compares bytes, so make a folder of
variants once (run from the repo root):

```bash
REPO=$PWD; mkdir -p ~/demo-photos
# Same picture, different bytes (one extra byte after the JPEG): each uploads as a new photo
for n in 1 2 3 4 5 6; do
  cp eval/fixtures/test-lot.jpg ~/demo-photos/test-lot-$n.jpg;  printf "$n" >> ~/demo-photos/test-lot-$n.jpg
  cp eval/fixtures/drone-lot.jpg ~/demo-photos/drone-lot-$n.jpg; printf "$n" >> ~/demo-photos/drone-lot-$n.jpg
done
# Renamed copy, same bytes as test-lot-1.jpg (US-05 #2)
cp ~/demo-photos/test-lot-1.jpg ~/demo-photos/lot-north.jpg
# EXIF DateTimeOriginal (US-04 #1); pick a time earlier than now
uv run python -c "from PIL import Image; im=Image.open('eval/fixtures/test-lot.jpg'); ex=im.getexif(); ex.get_ifd(0x8769)[36867]='2026:11:07 09:15:00'; im.save('$HOME/demo-photos/test-lot-exif.jpg', exif=ex, quality=95)"
# Over 15 MB (US-04 #5)
cp eval/fixtures/test-lot.jpg ~/demo-photos/big.jpg && head -c 16000000 /dev/zero >> ~/demo-photos/big.jpg
# Drone drifted: left 12% cut off (US-12 #2); ORB marks B-01, C-01, C-02, D-01 ... G-02 out of frame
uv run python -c "from PIL import Image; im=Image.open('eval/fixtures/drone-lot.jpg'); w,h=im.size; im.crop((int(w*0.12),0,w,h)).save('$HOME/demo-photos/drone-lot-cropped.jpg', quality=92)"
```

`test-lot` (Test Lot, 14 spaces, allowed data age 30 min): V1 "North corner" outlines A-01 to
A-07 and B-01 to B-03; V2 "South corner" outlines B-01 to B-07. `drone-lot` (Drone Lot,
124 spaces in rows B to G, allowed data age 60 min): one viewpoint, V1 "Overhead". The seed
uses the fixture photo as the reference photo of every viewpoint.

The stub scorer marks each space FREE or OCCUPIED from a hash of the photo bytes and the space
id: results look random, change with every byte variant, and are never UNKNOWN for a space the
photo covers.

### Upload steps used below

"Upload `<file>` to `<lot>` / `<view>` captured `<time>`" means: Admin > Upload, pick Lot and
Viewpoint, choose the file under Photo, type the time in Capture time (the fixtures have no
EXIF, so the hint "This photo has no capture time. Enter when it was taken." shows and Upload
stays disabled until you do), press Upload. Expect a progress bar, then
"Photo queued for processing" with a "View the photo with results" link.

---

## US-01 See Open Spaces at a Glance (Nathan Galante)

Driver page: `/lots/<lotId>` (`web/src/pages/LotMapPage.tsx`), reached from the lot list at `/`.

- [ ] **#1 Dashboard shows the schematic** `[stub]`. Upload `test-lot-1.jpg` to Test Lot / North
  corner captured now. In a private window open http://localhost:5173/ and click Test Lot.
  Expect: heading "Test Lot", a schematic with one rectangle per space, each labeled A-01 ...
  B-07, a Legend (Free, Occupied, Unknown, Closed, "Dimmed: out of date"), and no sign-in
  prompt.
- [ ] **#2 Occupied spaces show a car** `[stub]`. Hover any space whose tooltip says
  "Occupied": it has the car glyph.
- [ ] **#3 Free spaces are empty** `[stub]`. Hover a space whose tooltip says "Free": empty
  outline, no glyph.
- [ ] **#4 Summary counts match the map** `[stub]`. Count rectangles per state; the summary
  bar shows "N Free", "N Occupied", "N Unknown", "N Closed" with the same numbers. Close one
  free space (US-10 #1) and Refresh: Free drops by one, Closed rises by one.
- [ ] **#5 No photos yet** `[stub]`. Restart the runner, close B-01 (US-10 #1) before any
  upload, open the Test Lot map. Expect: every other space Unknown ("?" glyph), B-01 Closed
  (barrier glyph), summary "0 Free" and "No observations yet".
- [ ] **#6 Page loads quickly (NFR-2)** `[stub]`. DevTools > Network, "Disable cache", reload
  `/lots/test-lot` five times and record the load time; schematic and counts visible in under
  2 s. Record device, browser, network and run count (NFR-2). Campus Wi-Fi: see Gaps G5.

## US-02 Know How Old the Data Is (David Eliassen)

- [ ] **#1 Last observed time** `[stub]`. Upload `test-lot-2.jpg` to Test Lot / North corner
  captured 20 minutes ago. Expect "Last observed 20 minutes ago" (from the capture time, not
  the upload time).
- [ ] **#2 Per-space time on hover or tap** `[stub]`. Hover (or tap/focus) A-03. A popover reads
  like "A-03: Occupied, observed Nov 7, 2:05 PM" (state and capture time).
- [ ] **#3 Stale banner appears** `[stub]`. Restart the runner. Upload `test-lot-1.jpg` to
  North corner captured 45 minutes ago (Test Lot allows 30). Expect the banner
  "Some spaces are out of date. Check each space for its age." and the V1 spaces dimmed
  (grey, half opacity). B-04 to B-07 (never observed) show Unknown, not dimmed. Close B-02
  (US-10 #1): it shows Closed, not dimmed.
- [ ] **#4 Fresh data clears the banner** `[stub]`. Upload `test-lot-2.jpg` to North corner
  captured 40 minutes ago: banner stays. Upload `test-lot-3.jpg` captured now and press Refresh:
  banner gone, spaces normal.
- [ ] **#5 Only stale spaces are greyed** `[stub]`. Restart. Upload `test-lot-1.jpg` to South
  corner captured 45 minutes ago, then `test-lot-2.jpg` to North corner captured now. Expect
  only B-04 to B-07 (seen only from V2) dimmed and the banner still showing; B-01 to B-03 (in
  both views) take the fresh V1 result.

## US-03 Admin Sign-In (Rylan Moseley)

- [ ] **#1 Valid credentials** `[stub]`. Open `/signin` ("Admin sign in"), enter the dev admin.
  Expect `/admin` ("Admin") with links Upload, Snapshots, Closures, Map, New lot; the header
  shows the lot picker, Admin, the email and Sign out.
- [ ] **#2 Wrong password** `[stub]`. Enter a wrong password. Expect
  "Email or password is incorrect", still on `/signin`, header without Sign out.
- [ ] **#3 Admin pages redirect to sign-in** `[stub]`. In a fresh tab open
  http://localhost:5173/admin/upload. Expect `/signin?next=%2Fadmin%2Fupload`; after signing in
  you land on "Upload photo".
- [ ] **#4 Expired session (NFR-6)** `[stub]`. Start the runner with `JWT_TTL_MINUTES=1`, sign
  in, open Upload, fill the form, wait over a minute, press Upload. Expect `/signin` with
  "Your session expired. Please sign in again"; after signing in, Snapshots shows no new row.
- [ ] **#5 Account without admin access** `[stub]`. Sign in with the non-admin dev account.
  Expect "You do not have admin access" and no upload, mapping or closure controls (no lot
  picker in the header).
- [ ] **#6 Sign out** `[stub]`. Signed in on `/admin/upload`, press Sign out. Expect the lot list
  at `/` and no Sign out button. Press Back: you get the sign-in page, never an admin page.

## US-04 Upload a Drone Photo (Kevin Nguyen)

Page: `/admin/upload` ("Upload photo"; fields Lot, Viewpoint, Photo, Capture time).

- [ ] **#1 Capture time from EXIF** `[stub]`. Choose `test-lot-exif.jpg`. Capture time fills
  with 2026-11-07 09:15:00 and stays editable.
- [ ] **#2 Missing EXIF requires a time** `[stub]`. Choose `test-lot-4.jpg`. Capture time stays
  empty, the hint "This photo has no capture time. Enter when it was taken." shows, Upload is
  disabled until you type a time.
- [ ] **#3 Successful upload is queued** `[stub]`. Pick lot, viewpoint, photo, time; press
  Upload. Expect the progress bar, then "Photo queued for processing". Snapshots lists the
  photo. With the stub it moves from QUEUED to COMPLETE within a second; to see QUEUED and
  PROCESSING on screen use `[models]` (about 17 s per drone photo, `eval/README.md`).
- [ ] **#4 Wrong file type** `[stub]`. The file dialog only offers JPEG and PNG; drag
  `Docs/CV_processing_CS498.pdf` (or a .heic) onto the Photo input. Expect
  "Only JPEG or PNG photos are accepted"; Upload stays disabled, nothing in Snapshots.
- [ ] **#5 File too large** `[stub]`. Choose `big.jpg`. Expect "Photos must be 15 MB or
  smaller" as soon as the file is selected (the story says on Upload; see Gaps G6); Upload
  stays disabled.
- [ ] **#6 Capture time in the future** `[stub]`. Enter a time an hour ahead, press Upload.
  Expect "Capture time cannot be in the future"; Network tab shows no `POST /api/admin/uploads`.
- [ ] **#7 Abandoned upload expires** `[stub]`. DevTools > Network > throttling "Slow 3G",
  upload `drone-lot-1.jpg` to a lot and close the tab while the bar is moving. Wait 15 minutes,
  open Snapshots: the row shows "Expired", never gets processed, and the driver map is
  unchanged. (Expiry rule: `UPLOAD_EXPIRY` in `core/parking_core/models.py`; also
  `api/tests/test_api.py::test_snapshot_list_and_expiry`.)

## US-05 Block Duplicate Uploads (Nathan Jones)

- [ ] **#1 Same file twice** `[stub]`. Upload `test-lot-1.jpg`, then upload it again. Expect
  "This photo was already uploaded on Nov 7." (the first upload's date) and a
  "View the original" link to `/admin/snapshots#<imageId>`, which highlights the original row.
  Snapshots has one row for it.
- [ ] **#2 Renamed copy** `[stub]`. Upload `lot-north.jpg` (same bytes as `test-lot-1.jpg`).
  Same duplicate message.
- [ ] **#3 Edited photo is accepted** `[stub]`. Upload `test-lot-5.jpg` (one byte different).
  "Photo queued for processing"; a new Snapshots row.
- [ ] **#4 Two admins at once** `[tests]`. `uv run pytest -q api/tests/test_api.py::test_duplicate_race_one_wins`.

## US-06 Monitor and Retry Processing Jobs (Nathan Galante)

Page: `/admin/snapshots` ("Snapshots" + lot name), for the lot in the header picker.

- [ ] **#1 Recent snapshots listed** `[stub]`. After a few uploads, columns Captured, View,
  State, Time, Model, Error, newest capture first. Stub rows show Model "stub-0"; `[models]`
  rows show "acpds_yolo" and a processing time like "17 s". While a job runs the page shows
  "Checking for updates every 5 s while jobs are running."
- [ ] **#2 Failed job shows its error** `[orb]`. Upload `drone-lot-1.jpg` to Test Lot / North
  corner. Expect FAILED with error "Too few matches". The driver map is unchanged: prior states
  and "Last observed" stay, never-seen spaces stay Unknown, closures stay Closed.
- [ ] **#3 Retry a failed job** `[orb]`. Press Retry on that row: State goes to QUEUED, then
  FAILED again (same photo). A retry that completes changes the driver map only if it is the
  newest capture for its spaces (US-13).
- [ ] **#4 Retry only where it makes sense** `[stub]`. COMPLETE, QUEUED and PROCESSING rows have
  no Retry button.
- [ ] **#5 Repeated failures stop** `[tests]`. `uv run pytest -q worker/tests/test_handler.py::test_retryable_error_keeps_message_then_exhausts`
  (error text `Failed after 3 attempts`, `MAX_ATTEMPTS = 3` in
  `worker/parking_worker/handler.py`). The Retry button shows for any finished FAILED row.
- [ ] **#6 Snapshot detail** `[stub]`. Click a COMPLETE row's Captured time. "Snapshot detail"
  shows "Processed with layout v1", Attempts, Model, and a per-space table (Space, State,
  Confidence, Car overlap, In frame), plus "View photo with outlines".

## US-07 Draw the Lot Schematic (David Eliassen)

Page: `/admin/lots/<lotId>/map` ("Lot Mapping · Test Lot · Draft based on v1"), Schematic
panel on the left. Autosave is off by default: press Save (note "Draft saved") or tick
Autosave (saves 1.5 s after the last edit).

- [ ] **#1 Add a single space** `[stub]`. Select A-07, press + Space. A rectangle labeled A-08
  appears (note "Added A-08"); Save, then reload the page: A-08 is still there.
- [ ] **#2 Add a whole row** `[stub]`. On a new lot (US-16 #1) press + Row, Start label B-01,
  Number of spaces 10, Add row. Ten evenly spaced rectangles B-01 to B-10 in a line
  ("Added B-01 to B-10"). On Test Lot the schematic is full, so a new row is clamped to the
  bottom edge and the validator warns that spaces overlap.
- [ ] **#3 Move and resize** `[stub]`. Drag A-03, then drag a corner handle. Save. The driver
  page for the lot is unchanged until Publish (US-09 #4).
- [ ] **#4 Set label and type** `[stub]`. Select A-03, set Type to EV (or ADA). The space shows
  an "EV" badge; Save and reload keeps it.
- [ ] **#5 Duplicate label warning** `[stub]`. Rename B-05 to B-04. Both B-04 rectangles get a red
  outline with "Label already used"; the Label field shows the same note.
- [ ] **#6 Retire a space** `[stub]`. Select A-07, press Retire space. It is greyed, dashed,
  marked "Retired" ("Retired: its history is kept, and drivers stop seeing it after the next
  publish."). Publish: A-07 is gone from the driver map; its rows in earlier Snapshot details
  are still there.
- [ ] **#7 Draft survives a reload** `[stub]`. Edit, Save, reload or open the page in another
  browser signed in as the admin: edits are there. Unsaved edits are lost on reload (the
  browser asks first); see Gaps G7.

## US-08 Outline Spaces on a Reference Photo (Rylan Moseley)

Reference photo panel on the right of the mapping page; viewpoint select shows "V1 (North
corner)".

- [ ] **#1 Upload a reference photo** `[stub]`. Press + Viewpoint, name "East corner", Add
  Viewpoint. Expect "Viewpoint V3 has no reference photo." with Upload reference photo; upload
  `eval/fixtures/test-lot.jpg`: it shows in the panel.
- [ ] **#2 Outline a space** `[stub]`. Select A-03 on the schematic with V3 showing, click four
  corners. While clicking: "Click the 4 corners of A-03 (3 of 4)". After the fourth: a polygon
  and "A-03 outlined in V3".
- [ ] **#3 Adjust a polygon** `[stub]`. Drag one corner handle of A-03; Save; reload: the moved
  corner stays.
- [ ] **#4 One space in two viewpoints** `[stub]`. In the Spaces table under the photo, the
  Views column reads "B-01: 2 views" for B-01, B-02 and B-03 (outlined in V1 and V2); A-03
  reads "A-03: 2 views" after #2.
- [ ] **#5 Cancel an outline midway** `[stub]`. Select A-04, click two corners, press Esc. The
  partial outline disappears; the Spaces table still says "Not outlined" for it.
- [ ] **#6 Linked highlight** `[stub]`. Hover A-03 on the schematic: its polygon highlights;
  hover the polygon or its Spaces row: the rectangle highlights.

## US-09 Validate and Publish a Layout (Kevin Nguyen)

Buttons in the mapping header: Versions, Undo, Redo, Autosave, Save, Validate, Publish.

- [ ] **#1 Validate lists problems** `[stub]`. With the duplicate B-04 (US-07 #5) and a new
  space without outlines (US-07 #1), press Validate. "Validation Draft compared with v1"
  lists "x Two spaces share the label B-04 · B-04, B-04" tagged "blocks publish" and
  "! 1 space has no polygon in any view: it will show UNKNOWN". The out-of-photo error
  ("A-09 polygon is outside the V2 photo") cannot be produced from the UI, which keeps
  corners inside the photo: `uv run pytest -q core/tests/test_layouts.py -k polygon_outside_photo`.
- [ ] **#2 Errors block publishing** `[stub]`. Publish is disabled (tooltip "Fix the errors in
  the validation report first") until you fix the label and Validate again.
- [ ] **#3 Warnings do not block** `[stub]`. With only the warning, Publish: "Published v2"; the
  unmapped space is Unknown on the driver map.
- [ ] **#4 Publish creates a new version** `[stub]`. Versions page
  (`/admin/lots/test-lot/versions`) shows v2 "Live", Published by admin@example.edu and the
  time; the driver map shows the v2 layout after Refresh; the next upload's Snapshot detail says
  "Processed with layout v2".
- [ ] **#5 Photos in progress keep their version** `[models]`. Upload a drone photo and publish
  a new version while it is PROCESSING. Its detail says "Processed with layout v<old>". (The
  version is pinned when the upload completes: `api/parking_api/routes/uploads.py`.)
- [ ] **#6 Version history** `[stub]`. Versions lists v2, v1 newest first with publisher (v1 is
  "seed") and time.
- [ ] **#7 Roll back** `[stub]`. Restore on v1, confirm "Replace the draft with v1? Draft changes
  that are not published will be lost." The mapping page says "Draft restored from v1. Publish
  to make it live."; Publish gives "Published v3" with v1's contents; v2 is still listed.

## US-10 Close Spaces for an Event (Nathan Jones)

Page: `/admin/closures` ("Closures: Test Lot"): a map to select spaces, row buttons, and the
closures table. The table's Status (Scheduled, Active, Ended) is computed by the server when
the page loads; reload the page to see it change.

- [ ] **#1 Close a row** `[stub]`. Press Row B ("7 selected"), Close spaces…, dialog
  "Close spaces" with "Spaces: B-01 to B-07 (7 selected)", Reason Event, Starts now, Ends in two
  hours, press Close spaces. Driver map after Refresh: B-01 to B-07 show the barrier glyph,
  "7 Closed", and are not in the free count.
- [ ] **#2 Closure beats detection** `[stub]`. Upload a photo where B-03 comes out Free (try
  `test-lot-N.jpg` variants to North corner and check its Snapshot detail), with B-03 closed:
  the driver map shows B-03 Closed.
- [ ] **#3 Scheduled closure starts on its own** `[stub]`. Close A-01 starting in 3 minutes.
  The table shows "Scheduled" and the driver map its detected state; after the start time,
  Refresh: Closed, with nobody touching it.
- [ ] **#4 Closure ends on its own** `[stub]`. Close A-02 from now to 3 minutes from now; after
  the end, Refresh: its detected state again, and the table says "Ended".
- [ ] **#5 End a closure early** `[stub]`. Press End now on an active closure. Driver Refresh:
  detected state again.
- [ ] **#6 Open-ended closure** `[stub]`. Leave Ends empty ("optional; leave empty until further
  notice"). The Window column reads "from <start>, open-ended"; Closed until End now.
- [ ] **#7 End before start is rejected** `[stub]`. Ends earlier than Starts, press Close spaces.
  Expect "End time must be after start time"; no new row.
- [ ] **#8 Closures are recorded** `[stub]`. The table lists Spaces, Reason, Window, Created
  (admin email and time) and Status for every closure.

## US-11 Turn a Photo into Space States (Nathan Galante)

- [ ] **#1 Clear photo updates the map** `[models]`. Seed `--lot drone-lot`, upload
  `drone-lot-1.jpg` to Drone Lot / Overhead captured now. Map spaces with a car show Occupied,
  the rest Free (compare with "View photo with outlines"). With the stub the states are
  hash-based, not real (on `test-lot.jpg` the drawn cars are in A-02, A-03, A-06 and B-02,
  `eval/README.md`).
- [ ] **#2 Car over a line** `[models]`. On the drone photo, one empty stall next to a car whose
  box spills over the line shows Unknown, not Free (`eval/README.md`). Find it on the photo page
  (dotted outline).
- [ ] **#3 Spaces outside the photo keep their state** `[stub]`. Upload to South corner, then a
  newer photo to North corner. B-04 to B-07 (V2 only) keep their state and observed time
  (popover).
- [ ] **#4 Results within a minute (NFR-1)** `[models]`. Time upload completion to the map
  showing results, ten photos; record sample size, photo size, hardware, model version and
  method (NFR-1). See Gaps G5.
- [ ] **#5 Processing never blanks the map** `[models]`. With results on the map, upload a newer
  drone photo and Refresh the driver page while it runs: old results and "Last observed" stay,
  plus the note "Processing new photo".

## US-12 Never Call a Space Free Without Evidence (David Eliassen)

- [ ] **#1 Photo does not match its viewpoint** `[orb]`. Same as US-06 #2: FAILED
  "Too few matches", no space changes, never-seen spaces stay Unknown, closures stay Closed,
  stale spaces stay dimmed.
- [ ] **#2 Space outside the frame** `[models]`. Upload `drone-lot-cropped.jpg` to Drone Lot /
  Overhead. B-01, C-01, C-02, D-01, D-02, E-01, E-02, F-01, F-02, G-01 and G-02 have
  In frame "No" and show Unknown (or Occupied when a detected car overlaps them; they are never
  Free); fully visible spaces get normal results.
- [ ] **#3 Hard-to-see space** `[models]`. A space whose ACPDS score lands between the cutoffs
  (0.3 to 0.7, `CUTOFF_LOW`/`CUTOFF_HIGH`) shows Unknown. Needs a photo with heavy shade; none in
  the fixtures (Gaps G4). Rule tests: `uv run pytest -q core/tests/test_rules_status_auth.py`.
- [ ] **#4 Unknown never counts as free** `[stub]`. On any lot with Unknown spaces, the Free count
  equals the number of Free rectangles and the lot list's open count matches (US-15 #7).
- [ ] **#5 A wrong free is rare (NFR-3)** `[models]`. `uv run python eval/fetch_pklot_sample.py --count 30`
  then `uv run python eval/benchmark.py eval/data/pklot --setup acpds_yolo`; false-free must be
  5% or less. This is PKLot, not the team's labeled drone photos (Gaps G4).

## US-13 Newer Photos Win (Rylan Moseley)

The clock times below are examples; use times earlier than now, in the same order.

- [ ] **#1 Late older photo does not overwrite** `[stub]`. Upload `test-lot-1.jpg` to North
  corner captured 14:05 today, note A-03's popover, then `test-lot-2.jpg` captured 13:50. A-03
  keeps the 14:05 state and time. Test: `worker/tests/test_handler.py::test_older_photo_does_not_overwrite_newer_status`.
- [ ] **#2 Capture time decides** `[stub]`. Upload a photo captured 13:35, then one captured
  13:20: the map shows the 13:35 results and "Last observed" from 13:35.
- [ ] **#3 Same photo processed twice** `[tests]`. The duplicate check blocks a second upload
  (US-05 #1); redelivery of the same job is a no-op:
  `uv run pytest -q worker/tests/test_handler.py::test_reprocessing_same_message_is_noop`.
- [ ] **#4 Two viewpoints in either order** `[stub]`. Upload to North corner captured 14:10,
  then to South corner captured 14:05. B-01 to B-03 show the V1 (14:10) result.

## US-14 Run the Whole System on a Laptop (Kevin Nguyen)

- [ ] **#1 Clean clone starts** `[compose]`. `cp .env.example .env && docker compose up --build`.
  Six services: web (5173), api (8000), worker, rustfs (9000, the S3 stand-in instead of MinIO),
  elasticmq (9324), dynamodb-local (8001). `curl localhost:8000/health` returns
  `{"status":"ok"}`.
- [ ] **#2 Seed loads the test lot** `[compose]`. `set -a && . ./.env.ci-host && set +a && uv run python seed/seed.py --lot test-lot`
  prints "Created table, bucket and queue" and "Loaded Test Lot with 14 spaces and 2
  viewpoints"; Test Lot is on http://localhost:5173/. (Use `.env.ci-host`, as CI does; Gaps G2.)
- [ ] **#3 Upload to map, fully local** `[compose]`. Sign in as the dev admin, upload
  `eval/fixtures/test-lot.jpg`; the map updates. Automated:
  `RUN_COMPOSE_TESTS=1 uv run pytest -m compose tests/compose` (with `.env.ci-host` loaded).
- [ ] **#4 No cloud credentials** `[compose]`. The stack uses the emulator keys in `.env.example`;
  no `~/.aws` needed. The dev runner needs none either.
- [ ] **#5 Only configuration differs (NFR-7)** `[stub]`. Read `core/parking_core/settings.py`
  (`build_adapters` picks memory or boto3 adapters from `APP_ENV`) and confirm no local-vs-AWS
  branch elsewhere: `grep -rn app_env api/parking_api worker/parking_worker core/parking_core seed`.
  Besides `settings.py`, the hits only concern the in-memory test mode
  (`api/parking_api/main.py` mounts the test-only upload route, `export_openapi.py` builds a
  test app, `seed/seed.py` skips resource creation in memory mode); none picks local vs AWS.
- [ ] **#6 Seeding twice is safe** `[compose]`. Run the seed again: "Test Lot is already
  published (v1); left it as is", no duplicates. Automated: `uv run pytest -q seed/tests`.

## US-15 See How Full Each Lot Is (Nathan Jones)

Page: `/` ("Parking lots", Refresh).

- [ ] **#1 Lot list appears** `[stub]`. Each published lot shows its name, a bar, "N% open" and
  "free/total open" (e.g. "12/24 open"); no sign-in.
- [ ] **#2 Color and label** `[stub]`. 30% or more open: green bar, "Plenty"; 10 to 29%: amber
  (`--filling` in `web/src/index.css`), "Filling up"; under 10%: red, "Nearly full". The label
  is always shown next to the color. Change the percentage with photo variants and closures
  (closed spaces leave the total).
- [ ] **#3 Only free spaces count as open** `[stub]`. Compare with the map: open = Free count,
  total = all spaces minus Closed; Unknown is in the total but never open.
- [ ] **#4 Some data out of date** `[stub]`. With the US-02 #5 state (some spaces stale, some
  fresh), the row shows its bar plus "Some data out of date".
- [ ] **#5 No recent data** `[stub]`. A lot with no observation inside its allowed age (fresh
  runner, or only stale uploads) shows a grey full bar and "no recent data", no percentage.
- [ ] **#6 Open a lot** `[stub]`. Click a row: its map at `/lots/<lotId>`; browser Back (or
  "← All lots") returns to the list.
- [ ] **#7 List matches the map** `[stub]`. The row's open count equals the map's "N Free".

## US-16 Add and Switch Between Lots (Nathan Galante)

- [ ] **#1 Create a lot** `[stub]`. Admin > New lot (or "New lot" next to the picker): Name
  "North Lot", Location, Allowed data age (minutes) 30, Create lot. You land on its mapping page
  ("Not published yet", "No spaces yet. Press + Space or + Row to start.", "No viewpoints yet.
  Add a viewpoint to get started."); the picker lists "North Lot (not published)".
- [ ] **#2 Duplicate lot name** `[stub]`. Create "Test Lot" again (any case). Expect
  "A lot with this name already exists"; the picker is unchanged.
- [ ] **#3 Lot picker on every admin page** `[stub]`. With two published lots, pick North Lot in
  the header picker on the mapping, Upload, Closures and Snapshots pages: each shows only North
  Lot's data until you switch back. (An unpublished lot: see Gaps G3.)
- [ ] **#4 Unpublished lot stays hidden** `[stub]`. Before publishing, `/` does not list North
  Lot.
- [ ] **#5 Published lot appears** `[stub]`. On North Lot: + Row (B-01, 10), Save, Validate
  (warnings only), Publish ("Published v1"). Refresh `/`: North Lot with a grey "no recent data"
  bar; its map shows all spaces Unknown and "No observations yet".
- [ ] **#6 Lots stay separate** `[stub]`. Close row B on Test Lot; North Lot's map shows
  "0 Closed" and its counts are unchanged.

---

## Gaps

Found while checking the criteria against the code on `main` at b23ea0a (Oct 30). Re-check each
during the walkthrough; strike it when fixed.

- **G1 Remembered lot can point at a lot that no longer exists.** The Closures page
  (`web/src/pages/ClosuresPage.tsx`) and the admin home Map link (`web/src/mapping/MapLink.tsx`)
  read `localStorage['parking.admin.lotId']` directly instead of the picker's validated lot.
  After restarting the dev runner with another `--lot` (or deleting a lot), Closures shows
  "Lot not found" and Map opens a missing lot. Workaround: in DevTools,
  `localStorage.removeItem('parking.admin.lotId')`, or pick the lot in the header picker. Fix:
  use `useAdminLot()` on both, as Upload and Snapshots do.
- **G2 README seeds the compose stack with the wrong env.** README "Local development" runs
  `uv run python seed/seed.py --lot pklot-ufpr04` from the host, which reads `.env` whose
  endpoints are compose-internal hostnames (`http://rustfs:9000`, ...). CI seeds with
  `.env.ci-host` loaded. US-14 #2 also names `--lot test-lot`, the seed default.
- **G3 Unpublished lot on Closures.** With an unpublished lot picked, Closures shows
  "Lot not found" (it loads the public lot detail) instead of saying the lot must be published
  first (the API's own message is "Publish the lot before closing spaces"). Upload shows no lot
  selected, since it lists published lots only. Acceptable for US-16 #3, but unfriendly.
- **G4 No labeled drone photos yet.** US-12 #5 / NFR-3 asks for the team's labeled test photos;
  only the PKLot sample benchmark exists (`eval/README.md`, "Labeling format for pilot photos").
  There is also no shaded-space photo for US-12 #3.
- **G5 NFR measurements not recorded.** NFR-1 (results within 60 s, US-11 #4) and NFR-2 (page
  under 2 s on campus Wi-Fi, US-01 #6) have no recorded runs with the conditions the NFRs ask
  for. The dev runner on a laptop is not the target setup.
- **G6 Size check fires on file selection, not on Upload.** US-04 #5 says the message appears
  when Upload is pressed; the page shows "Photos must be 15 MB or smaller" as soon as the file
  is chosen and keeps Upload disabled. Nothing is uploaded either way (the API repeats the check).
- **G7 Draft edits are not saved automatically by default.** US-07 #1, #3, #7 and US-08 #3 say
  an edit "is saved to the draft"; with Autosave off (the default) edits are saved only on Save,
  Validate or Publish, and a reload without saving loses them (the browser warns first).
  Turning Autosave on meets the stories.
- **G8 Not reproducible by hand.** US-05 #4 (simultaneous uploads), US-06 #5 (three failed
  attempts) and US-13 #3 (same job processed twice) are covered only by automated tests; US-09
  #5 needs the slow real detector to catch a photo mid-processing.
