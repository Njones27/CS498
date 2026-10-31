# eval: fixtures, PKLot sample and the pilot benchmark

## `fixtures/test-lot.jpg` (synthetic fallback)

A 640x360 JPEG drawn by `eval/make_fixture.py` from the V1 ("North corner") outlines in
`seed/lots/test-lot.json`: grey asphalt, white stall lines, dark rectangles as cars in
A-02, A-03, A-06 and B-02. The seed uploads it as the reference image for every viewpoint
of `test-lot`. Regenerate after editing the lot JSON:

    uv run python eval/make_fixture.py

It is not a realistic photo; it only exercises the upload -> worker -> status pipeline.

## `fixtures/drone-lot.jpg` (overhead test photo)

A straight-down 1982x2000 photo of a real lot (team test photo, Oct 22 2026) with
`seed/lots/drone-lot.json`: 124 stalls in six rows (B to G) outlined from the painted
lines (86 px pitch; the two rows cut off at the top and bottom edges are left out). With
the real models it processes in about 17 s and every stall matches the photo except one
empty stall marked UNKNOWN by a neighbour's car box spilling over the line. Seed it with:

    uv run python seed/seed.py --lot drone-lot

The dev runner seeds only `test-lot`; upload this photo to `drone-lot` / `V1` to see the
real pipeline on it (`DETECTOR=acpds_yolo ALIGNER=orb`, weights downloaded).

## PKLot (real photos)

Source: [PKLot](https://web.inf.ufpr.br/vri/databases/parking-lot-database/) (Almeida et al.,
2015), through the Hugging Face mirror [Voxel51/PKLot](https://huggingface.co/datasets/Voxel51/PKLot).
License: **CC BY 4.0** (credit the PKLot authors when showing these photos). No login needed.
Three fixed cameras: `pucpr` (100 spaces), `ufpr04` (28), `ufpr05` (40); sunny, cloudy and
rainy days; 1280x720 JPEGs.

### Sample cache (not committed)

    uv run python eval/fetch_pklot_sample.py --count 30            # -> eval/data/pklot/

`eval/data/` is git-ignored. The script reads small windows of the mirror's 267 MB label file
with HTTP Range requests, picks samples round-robin over camera and weather, and writes one
`<camera>_<timestamp>.jpg` plus a PKLot-format `.xml` per photo. Reruns skip pairs already on
disk.

### Committed fixture: `pklot-ufpr04`

- `fixtures/pklot/ufpr04_2012-12-18_13_15_09.jpg` + `.xml`: one UFPR04 photo (27 labeled
  spaces, 24 occupied) and its labels.
- `fixtures/pklot-ufpr04.jpg`: the same photo, uploaded by the seed as the lot's reference
  image.
- `seed/lots/pklot-ufpr04.json`: the lot, generated from the pair:

      uv run python seed/import_pklot.py eval/fixtures/pklot/ufpr04_2012-12-18_13_15_09.jpg \
          eval/fixtures/pklot/ufpr04_2012-12-18_13_15_09.xml --lot-id pklot-ufpr04 --name "PKLot UFPR04"
      uv run python seed/seed.py --lot pklot-ufpr04

  Rows are clustered by center y (a gap above 0.6 x median stall height starts a row),
  labelled A, B, C... with stalls numbered left to right; space ids are `pk-<PKLot id>`.

To use another photo, put its `.jpg` + `.xml` in `fixtures/pklot/`, rerun the two commands with
a new `--lot-id`, and copy the JPEG to `fixtures/<lot-id>.jpg`.

## Labeling pilot photos

The pilot benchmark needs 20-30 labeled drone photos per drone position. Two tools make that
quick: `prefill_labels.py` writes every stall's outline into a label file for each new photo,
and `label.html` lets a human click each stall occupied or empty.

1. **Take photos.** For each drone position, take 20-30 photos at the reference photo's
   altitude and heading, spread over times of day and occupancy levels. Put them in
   `eval/data/pilot/<position>/` (`eval/data/` is git-ignored) and rename `.JPG` to `.jpg`:
   `benchmark.py` pairs `<name>.xml` with `<name>.jpg` and finds nothing else on Linux. Each
   position needs a viewpoint in a lot JSON and a reference photo for it; the default is
   `seed/lots/drone-lot.json`, viewpoint `V1`, with `fixtures/drone-lot.jpg`.

2. **Prefill.** Align every photo to the reference with the worker's ORB aligner and write its
   outlines as unlabeled PKLot XML:

       uv run python eval/prefill_labels.py eval/data/pilot/<position> \
           [--lot seed/lots/drone-lot.json] [--reference eval/fixtures/drone-lot.jpg] \
           [--view V1] [--source NAME] [--force]

   One line per photo:

   - `wrote DJI_0001.xml: 118 stalls (6 out of frame: B-01, ...)`: stalls that map partly
     outside the photo are left out (the worker reports them UNKNOWN, and a half-visible stall
     cannot be labeled fairly).
   - `skip DJI_0001.jpg: DJI_0001.xml exists (--force to overwrite)`: labels are never
     overwritten unless you pass `--force`.
   - `FAILED DJI_0001.jpg: Too few matches`: no `.xml` is written. Retake the photo closer to
     the reference position, or loosen the aligner for the pilot with the same `ORB_*`
     settings the worker reads (`ORB_MIN_MATCHES=20 uv run python eval/prefill_labels.py ...`).
     A failure here is also what the worker would do with that photo.

   `--source` sets `<parking id>`, which the benchmark reports results by ("per camera");
   the default is `<lotId>-<viewId>`, e.g. `drone-lot-V1`. Exit code 1 if any photo failed.

3. **Label.** Open `eval/label.html` straight from Finder (`file://`, no server or install) in
   Chrome, Firefox or Safari, and drop the folder's `.jpg` and `.xml` files on it (or use
   **Open files**). Photos pair with label files by name. Click a stall to cycle unset ->
   occupied -> empty, or hover it and press `o` / `e` / `u`; `Shift+E` marks every remaining
   unset stall empty. Press `?` for all keys. Leave a stall unset when you cannot tell: it has
   no `occupied` attribute and is not scored. **Save** (`Ctrl/Cmd+S`) downloads the `.xml`
   under its own name, with only the `occupied` attributes changed (the browser also writes
   `<point x="1" y="2"/>` without the space before `/>`); move it from Downloads
   back over the prefilled file, and watch for a browser rename such as `DJI_0001 (1).xml`.
   Unsaved photos are marked `*` in the list.

4. **Benchmark.** Each position is scored separately (`benchmark.py` reads one flat folder):

       uv run python eval/benchmark.py eval/data/pilot/<position> --setup acpds_yolo \
           --json eval/data/pilot/<position>.json

The tools are tested by `uv run pytest tests/eval` (part of the normal `uv run pytest`): prefill
on the reference itself and on a shifted, rotated copy, read back with `benchmark.read_labels`;
and `label.html#selftest` run in headless Chrome (skipped when no Chrome or Chromium is found;
set `CHROME_BIN` to point at one).

## Labeling format for pilot photos

Label each pilot (drone) photo in the same PKLot XML layout, one `.xml` next to each `.jpg`
with the same name. Coordinates are photo pixels; `occupied` is the human call. Leave out a
space a human cannot judge (or omit its `occupied` attribute): it is then not scored.

```xml
<?xml version="1.0"?>
<parking id="lot-north">                      <!-- camera / viewpoint name -->
  <space id="12" occupied="1">                <!-- 1 = occupied, 0 = empty -->
    <rotatedRect>                             <!-- needed by import_pklot.py -->
      <center x="722" y="625" />              <!-- polygon centroid -->
      <size w="161" h="149" />                <!-- bounding box width and height -->
      <angle d="0" />
    </rotatedRect>
    <contour>                                 <!-- the stall outline, 4 corners in order -->
      <point x="720" y="549" />
      <point x="805" y="665" />
      <point x="715" y="698" />
      <point x="644" y="582" />
    </contour>
  </space>
</parking>
```

## Benchmark

Needs the vision extra and the weights (see the root README, "Model weights and detector"):

    uv run python eval/benchmark.py eval/data/pklot --setup acpds --setup acpds_yolo --setup yolo \
        [--overlap-mode box|box_lower_half|seg] [--outline-shift] [--json out.json] [--limit N]

It scores every pair once with ACPDS and once with YOLO26m and reports, per setup: false-free
rate (NFR-3, pass mark 5% or less), accuracy with UNKNOWN counted wrong (NFR-4, 90% or more),
UNKNOWN rate (cap 10%) split into "ACPDS in-between" and "box spill", latency p50/p95 per photo,
model load time, peak memory, per-camera results, a low/high cutoff sweep, and with
`--outline-shift` how often ACPDS's call flips when outlines move by 5-30% of a stall's width.
It never changes the default cutoffs. PKLot is an end-to-end check of the code, not the pilot:
the pilot uses the team's labeled drone photos in the layout above.

## Layout proposer benchmark

`propose_benchmark.py` runs the worker's layout proposer (HDD §4.6) on a photo and compares its
stall outlines with a hand-drawn layout:

    uv run --no-sync python eval/propose_benchmark.py eval/fixtures/drone-lot.jpg \
        seed/lots/drone-lot.json [--view V1] [--cars] [--out overlay.jpg]
    uv run --no-sync python eval/propose_benchmark.py eval/data/pklot [--limit N]   # PKLot pairs

Ground truth is a lot JSON (a viewpoint's `outlines`) or a PKLot-format `.xml`; a directory
runs every `<name>.jpg` + `<name>.xml` pair. Proposals match ground truth one to one at IoU 0.5
or more. It prints precision, recall, mean corner error of matched stalls (% of photo width),
stall counts and run time. `--cars` adds the production YOLO26m detector (vision extra and
weights needed; its time is printed apart). `--out` draws ground truth in white and proposals
coloured by evidence (red 0 to green 1), unmatched proposals thick.

On `drone-lot.jpg` (Oct 2026): lines only, precision 93.8% and recall 97.6% (129 proposed, 124
drawn), corner error 0.27% of width, 0.2 s on one core; with cars, 93.8% and 98.4% (130
proposed), plus 0.6 s of YOLO. The extra proposals are real stalls the hand-drawn layout leaves
out (the left column beside the hatched islands, row B's two ends); the two misses are row B's
four wide stalls, which the layout draws as six regular ones. Oblique pole cameras (PKLot) are
not what the proposer is for and score near zero.
