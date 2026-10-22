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
