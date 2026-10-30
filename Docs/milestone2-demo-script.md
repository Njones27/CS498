# Milestone 2 demo script (Nov 11, 2026)

A 13 to 15 minute live demo of the Phase 1 prototype, in user-story order, on one laptop with
the dev runner and the real detector. Every page, button and message below is taken from the
code on `main`; `Docs/milestone2-walkthrough.md` has the full per-criterion checklist and the
known gaps.

- Demo lot: **Drone Lot** (`seed/lots/drone-lot.json`): 124 spaces in rows B to G, one
  viewpoint V1 "Overhead", allowed data age 60 minutes. The real detector takes about 17 s per
  photo on it (`eval/README.md`); time it on the demo laptop.
- Everything runs on `localhost`. Once the setup below is done, no network is needed.

## Night before (Nov 10)

1. **Code and environment** (repo root, on `main`):

   ```bash
   git switch main && git pull
   uv sync --all-packages --extra vision            # torch, torchvision, ultralytics
   uv run python scripts/download_weights.py        # fetch + verify the three weights
   uv run python scripts/download_weights.py --check
   RUN_MODEL_TESTS=1 uv run pytest -m real_model    # real-model smoke test
   cd web && npm install && cd ..
   ```

   After this, start the runner with `uv run --no-sync` so nothing re-syncs the environment (a
   plain `uv sync --all-packages` without `--extra vision` removes torch).

2. **Photos** in `~/demo-photos` (the duplicate check compares bytes, so each upload needs its
   own variant; none of the fixtures has EXIF):

   ```bash
   REPO=$PWD; mkdir -p ~/demo-photos
   for n in 1 2 3; do cp eval/fixtures/drone-lot.jpg ~/demo-photos/drone-lot-$n.jpg; printf "$n" >> ~/demo-photos/drone-lot-$n.jpg; done
   # EXIF capture time on the morning of the demo, at least 2 hours before the slot (stale on purpose)
   uv run python -c "from PIL import Image; im=Image.open('eval/fixtures/drone-lot.jpg'); ex=im.getexif(); ex.get_ifd(0x8769)[36867]='2026:11:11 08:00:00'; im.save('$HOME/demo-photos/drone-lot-exif.jpg', exif=ex, quality=95)"
   cp eval/fixtures/test-lot.jpg ~/demo-photos/wrong-spot.jpg    # a photo of another lot
   ```

   Adjust `08:00:00` so it is more than 60 minutes before you upload it, and not in the future.

3. **Full rehearsal** with the demo command (below). Time each section, the model load at
   startup and the drone photo processing time. Rehearse once with Wi-Fi off.

4. **Fallback screenshots** during the rehearsal, into `~/demo-screens` (not committed), in run
   sheet order: empty lot list; empty map ("No observations yet"); EXIF-prefilled upload form;
   duplicate message; Snapshots with PROCESSING then COMPLETE; map with the stale banner; map
   with "Processing new photo"; fresh map with a tooltip; lot list with a percentage; photo
   overlay; Close spaces dialog; map with row B closed; mapping page with the reference photo;
   "Label already used"; validation blocking Publish; Versions after Publish; "Draft restored
   from v1"; New lot page and the picker; lot list with two lots; FAILED "Too few matches";
   Snapshot detail.

5. **Browser**: one Chrome profile for the demo. Clear site data for `localhost:5173` (the
   remembered admin lot can point at a lot from rehearsal; walkthrough Gaps G1). Zoom so the
   back row can read the summary bar. Turn off notifications.

6. **Presenters**: each person runs their section once in the rehearsal, on this laptop.

## Demo day: start (10 minutes before)

The runner keeps everything in memory, so it is started fresh on the day: it seeds Drone Lot
(v1, published by "seed") and nothing else.

```bash
# Terminal A (repo root). Sessions last 4 h instead of 60 min, so nobody is signed out mid-demo.
JWT_TTL_MINUTES=240 DETECTOR=acpds_yolo ALIGNER=orb uv run --no-sync python scripts/dev_inmemory.py --lot drone-lot
# Terminal B
cd web && npm run dev
```

Terminal A prints `Loaded Drone Lot with 124 spaces and 1 viewpoints` and the `Dev admin:` line
(admin `admin@example.edu`; the password is `dev_admin_password` in
`core/parking_core/settings.py`). Keep Terminal A off the projector.

Tabs (a sign-in lives in one tab's `sessionStorage`, so keep all admin work in one tab):

- **Driver tab**, in a guest or private window: http://localhost:5173/
- **Admin tab**, normal window: http://localhost:5173/admin/upload (do not sign in yet; section 2
  starts here)

## Run sheet

| # | Section | Presenter | Time |
|---|---|---|---|
| 0 | Opening | Nathan Jones | 0:30 |
| 1 | Driver view | Nathan Jones | 1:00 |
| 2 | Admin sign-in and upload | Nathan Jones | 1:45 |
| 3 | Processing | Nathan Jones | 2:00 |
| 4 | Photo overlay | Nathan Jones | 1:00 |
| 5 | Closures | Nathan Jones | 1:15 |
| 6a | Mapping: reference photo and outlines | Rylan Moseley | 1:15 |
| 6b | Mapping: schematic editor | David Eliassen | 1:00 |
| 6c | Validate, publish, versions, restore | Kevin Nguyen | 1:15 |
| 7 | Lots and lot picker | Nathan Galante (David for + Row) | 1:45 |
| 8 | Snapshots and retry | Nathan Galante | 1:15 |
| 9 | Close and Q&A handoff | Nathan Jones | 0:30 |
| | **Total** | | **14:30** |

Presenters follow code ownership: Nathan Jones (worker, vision, closures, aligner, upload,
eval, CI), Kevin Nguyen (mapping page, draft layout, validate/publish/versions/restore), David
Eliassen (schematic editor), Rylan Moseley (reference photo and outline panel), Nathan Galante
(lots admin, lot picker, New Lot, Snapshots/retry, dark mode). The driver view has no code owner
in that list; Nathan Jones presents it as owner of US-15 (Galante owns US-01 and David US-02,
so either can take it instead).

### 0. Opening (Nathan Jones, 0:30)

- One line: drone photos of a lot become a live map of free, occupied, unknown and closed
  spaces. Drivers never see a photo and never sign in; admins map lots, upload photos and close
  spaces.
- Phase 1 runs entirely on a laptop; Phase 2 (Dec 4) is the same code on AWS, chosen by
  environment variables only (NFR-7).

### 1. Driver view (Nathan Jones, 1:00) - US-15, US-01

Driver tab:

1. `/` "Parking lots": Drone Lot with a grey bar and "no recent data". No sign-in anywhere.
2. Click Drone Lot: the schematic, 124 labeled rectangles, all "?" (Unknown); summary
   "0 Free ... 124 Unknown" and "No observations yet". Point at the Legend.

Talking points: a lot with no photo shows Unknown, never Free; each state has its own shape, not
only a color (car, empty, "?", barrier), so the map works without color.

### 2. Admin sign-in and upload (Nathan Jones, 1:45) - US-03, US-04, US-05

Admin tab (on `/admin/upload`, not signed in):

1. The page sends you to "Admin sign in". Type a wrong password: "Email or password is
   incorrect". Sign in properly: you land back on "Upload photo" (it remembered where you were
   going).
2. Lot: Drone Lot, Viewpoint: Overhead (preselected, only one). Photo: `drone-lot-exif.jpg`.
   Capture time fills from the photo's EXIF and stays editable.
3. Upload: progress bar, then "Photo queued for processing".
4. Choose `drone-lot-exif.jpg` again and Upload: "This photo was already uploaded on Nov 11."
   with "View the original". Say: the check hashes the bytes, so a renamed copy is caught too.

Talking points: capture time comes from the photo, not the upload, and drives every "how old is
this" on the driver side; in the compose stack and on AWS the photo goes straight from the
browser to object storage through a presigned URL (the dev runner stands in for storage with a
test-only route).

### 3. Processing (Nathan Jones, 2:00) - US-06 #1, US-11, US-02, US-13

1. Admin home > Snapshots: the row goes QUEUED, PROCESSING, COMPLETE while the page says
   "Checking for updates every 5 s while jobs are running." Time (about 17 s) and Model
   "acpds_yolo" fill in.
2. Driver tab, Refresh: results are in, but dimmed, with "Some spaces are out of date. Check
   each space for its age." The photo was taken this morning and the lot allows 60 minutes.
   Back on `/` the row says "no recent data" and "Some data out of date".
3. Admin tab, Upload: `drone-lot-1.jpg`. No EXIF: the hint "This photo has no capture time.
   Enter when it was taken." and Upload stays disabled until you type the current time. Upload.
4. Driver tab, Refresh while it runs: the earlier results stay, with the note "Processing new
   photo". Refresh after it completes: banner gone, "Last observed N minutes ago", normal
   shading. Hover a space: "B-07: Occupied, observed Nov 11, ..." (state and capture time).
5. `/`: Drone Lot now shows its bar, "N% open", Plenty / Filling up / Nearly full, and
   "free/124 open".

Talking points: the worker aligns the photo to the viewpoint's reference with ORB + RANSAC,
scores every space with ACPDS and checks YOLO26m car boxes; a newer capture always wins, an
older one arriving late never overwrites it (US-13); a running job never blanks the map.

### 4. Photo overlay (Nathan Jones, 1:00) - US-11 #2, US-12

From the upload success link "View the photo with results" (or Snapshot detail > "View photo
with outlines"):

1. The photo with every aligned outline: solid is free, double is occupied, dotted is unknown;
   dashed boxes are YOLO detections. The counts line ends with "YOLO: N car ...".
2. Hover an outline for its ACPDS score and car overlap. Find the dotted (Unknown) stall next to
   a car whose box spills over the line (`eval/README.md`).

Talking points: the rule is asymmetric because a wrong "free" is the costly mistake: Free needs
a low ACPDS score and no car overlap; anything in between is Unknown and never counted as open.
This page is admin only; drivers never see photos.

### 5. Closures (Nathan Jones, 1:15) - US-10

Admin home > Closures ("Closures: Drone Lot"):

1. Press Row B (19 selected), Close spaces…. In "Close spaces" set Reason Event, Ends earlier
   than Starts, press Close spaces: "End time must be after start time". Set Ends two hours
   after now; Close spaces.
2. Driver tab, Refresh: row B shows the barrier glyph, Closed goes up by 19, and they leave the
   free count even where the photo says empty. `/`: the percentage changes (closed spaces leave
   the total).
3. Back on Closures, the table lists spaces, reason, window, who created it and when. Press
   End now; driver Refresh: row B shows its detected state again.

Optional: close row C starting 5 minutes from now and show it in section 9 after the page
reload: it went from Scheduled to Active with nobody touching it.

### 6a. Mapping: reference photo and outlines (Rylan Moseley, 1:15) - US-08

Admin home > Map: "Lot Mapping · Drone Lot · Draft based on v1". Schematic on the left,
reference photo on the right.

1. Hover a rectangle on the schematic: its outline lights up on the photo; hover an outline:
   the rectangle lights up.
2. + Viewpoint, name "Overhead 2", Add Viewpoint: "Viewpoint V2 has no reference photo." Upload
   reference photo: `eval/fixtures/drone-lot.jpg`.
3. Select B-02, click two corners ("Click the 4 corners of B-02 (2 of 4)"), press Esc: the
   partial outline is gone.
4. Select B-01, click its four corners: "B-01 outlined in V2"; the Spaces table says
   "B-01: 2 views". Drag one corner handle to fine-tune.

### 6b. Mapping: schematic editor (David Eliassen, 1:00) - US-07

1. Select B-03: drag it, drag a corner to resize, set Type to EV (badge appears).
2. Rename B-04 to B-05: both B-05 rectangles turn red with "Label already used".
3. Select G-21, Retire space: grey, dashed, "Retired".
4. Save: "Draft saved". The driver map is unchanged: only a published version reaches drivers
   and the worker.

### 6c. Validate, publish, versions, restore (Kevin Nguyen, 1:15) - US-09

1. Validate: "Validation Draft compared with v1" with
   "x Two spaces share the label B-05 ... blocks publish". Publish is disabled.
2. Rename the second B-05 back to B-04, Validate again (no errors), Publish: "Published v2".
   Driver Refresh: G-21 is gone, B-03 moved. Snapshot details from earlier still say
   "Processed with layout v1".
3. Versions: v2 "Live" by admin@example.edu, v1 by "seed", newest first.
4. Restore on v1, confirm: back on the mapping page with "Draft restored from v1. Publish to
   make it live." Publish: "Published v3", same contents as v1; v2 stays in the history.

Talking points: the draft is the only thing an admin edits; validation runs on the server, the
same rules the seed uses; every publish is a numbered version, and a rollback is a new version,
never an overwrite.

### 7. Lots and lot picker (Nathan Galante, 1:45) - US-16, US-15

1. "New lot" next to the header picker: Name "Drone Lot" (try the duplicate first): "A lot with
   this name already exists". Name "North Lot", any Location, Allowed data age 30, Create lot.
2. You land on its mapping page: "Not published yet", "No spaces yet. Press + Space or + Row to
   start." The picker lists "North Lot (not published)". Driver `/` Refresh: North Lot is not
   there.
3. David: + Row, Start label B-01, Number of spaces 10, Add row: ten evenly spaced rectangles
   B-01 to B-10 ("Added B-01 to B-10"). Save.
4. Validate: only the warning "10 spaces have no polygon in any view: they will show UNKNOWN".
   Publish: "Published v1". Driver `/` Refresh: North Lot appears with a grey "no recent data"
   bar; its map is all Unknown. Drone Lot's closures never touch it.
5. Picker back to Drone Lot: Snapshots shows only Drone Lot photos; to North Lot: "No photos
   uploaded for this lot yet." End on Drone Lot.
6. Optional, five seconds: the Theme select in the header (Auto, Light, Dark).

### 8. Snapshots and retry (Nathan Galante, 1:15) - US-06, US-12 #1

1. Upload `wrong-spot.jpg` (a photo of another lot) to Drone Lot / Overhead, captured now.
2. Snapshots: the row goes FAILED with "Too few matches" within seconds (alignment runs before
   any model). Driver map: unchanged; a rejected photo never marks anything free.
3. Retry: QUEUED, then FAILED again (same photo). COMPLETE rows have no Retry.
4. Click a COMPLETE row's time: "Snapshot detail" with "Processed with layout v1", attempts,
   model and the per-space State, Confidence, Car overlap, In frame table.

Talking point: transient errors are retried automatically up to three times, then the row says
"Failed after 3 attempts" and stops (`worker/parking_worker/handler.py`); Retry stays available.

### 9. Close (Nathan Jones, 0:30)

- If the optional scheduled closure was made, reload Closures: it is Active.
- Next: the drone pilot with labeled photos (false-free under 5%, NFR-3), measured latency and
  load time (NFR-1, NFR-2), then Phase 2 on AWS by Dec 4.
- Hand over to questions.

## Fallback plan

Decide quickly, say what you switched to, keep going in run sheet order.

| Problem | Switch to |
|---|---|
| Runner fails to start with the real detector (weights, torch) | Stub scorer, real aligner: `JWT_TTL_MINUTES=240 ALIGNER=orb uv run python scripts/dev_inmemory.py --lot drone-lot`. Everything in the run sheet works; results are hash-based placeholders (say so), processing is instant, so show the "Processing new photo" and PROCESSING screenshots instead. "Too few matches" still works (ORB needs only OpenCV). |
| OpenCV / ORB also fails | Drop `ALIGNER=orb` (identity aligner). Section 8 becomes the FAILED screenshot. |
| A job sits in PROCESSING over a minute | Move on to the next section and come back; if it never finishes, restart the runner (this wipes all data) and redo sections 2-3 quickly with `drone-lot-2.jpg` / `drone-lot-3.jpg`, or use screenshots. |
| Runner crash mid-demo | Restart with the same command (in-memory data is gone). Re-upload `drone-lot-2.jpg` captured now so the map has results, then continue. |
| Signed out unexpectedly | Sign in again in the same tab; you return to the page you were on. |
| Closures or Map link shows "Lot not found" | Remembered lot from rehearsal (Gaps G1): in DevTools console `localStorage.removeItem('parking.admin.lotId')`, reload. |
| Laptop or browser unusable | Screenshots from `~/demo-screens` in run sheet order; each presenter narrates their own. |
| Network down | Nothing to do: the demo is all `localhost` once weights and `node_modules` are installed. |

Do not run `uv sync` on the demo laptop on the day; it can remove the `vision` extra.
