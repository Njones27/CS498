# Model weights

The worker's real detector (`DETECTOR=acpds_yolo`) needs three weight files. They are not
committed (`*.pt` is ignored); `manifest.json` pins each one by SHA-256 and size, and the
worker refuses to start if a file is missing or does not match.

| File | What | Source | License |
|---|---|---|---|
| `acpds/RCNN_128_square_gopro.pt` (94 MB) | ACPDS classifier, `RCNN(roi_res=128, pooling_type="square")`, trained on the ACPDS GoPro photos | [martin-marek/parking-space-occupancy](https://github.com/martin-marek/parking-space-occupancy); mirrored on the team's R2 bucket, upstream GCS as fallback | MIT |
| `yolo/yolo26m.pt` (44 MB) | YOLO26m COCO detector, the car safety net (`YOLO_OVERLAP_MODE=box` or `box_lower_half`) | Ultralytics assets release `v8.4.0` | AGPL-3.0 |
| `yolo/yolo26m-seg.pt` (55 MB) | YOLO26m-seg, used only with `YOLO_OVERLAP_MODE=seg` | Ultralytics assets release `v8.4.0` | AGPL-3.0 |

## Download and check

```bash
uv sync --all-packages --extra vision            # torch, torchvision, ultralytics
uv run python scripts/download_weights.py        # fetch what is missing, verify everything
uv run python scripts/download_weights.py --check   # verify only (exit 1 on missing/mismatch)
uv run python scripts/download_weights.py --only yolo26m
```

The ACPDS file is fetched over HTTPS (URLs tried in order). The YOLO files go through
Ultralytics' own downloader, so they need the `vision` extra installed. Every file is hashed
after download; a mismatch is deleted and reported.

`MODELS_DIR` (default `models`) points the worker at this directory. Docker Compose mounts
`./models` read-only at `/app/models`; the image never contains weights.

## NFR-1 timing (2 CPU / 4 GB)

`scripts/worker_timing.py` seeds `drone-lot` (124 stalls) and `pklot-ufpr04` (27) in memory,
runs 10 jobs per lot and photo size through the real worker path (photo fetch, ORB alignment,
ACPDS + YOLO26m, status writes) and reports p50/p95 per job, with model load and one warm-up
job per lot shown apart. It exits 1 when p95 is over 30 s (`--limit-s`) and 2 when the run
itself failed (an import, missing weights, a job that did not complete).

What is gated, so the number is not flattering:

- `ALIGNER=orb`, stricter than the compose default `ALIGNER=identity`: every job pays for
  ORB matching and the homography. `DETECTOR=acpds_yolo` with `YOLO_OVERLAP_MODE=box`
  (`yolo26m.pt`, `YOLO_IMGSZ=1280`) and ACPDS at the photo's native resolution.
- Two photo sizes per lot, all in the one p95: the fixture's own (`drone-lot` 1982x2000,
  `pklot-ufpr04` 1280x720) and the reference resized to a 4032 px long edge
  (`--photo-long-edge`, default 4032; 0 skips it), the long edge of a 12 MP phone photo
  and within the 15 MB upload limit (`drone-lot` becomes 3996x4032, 16 MP). The stored
  reference stays fixture-size; ORB matches at the reference's working size and outlines
  map as fractions, so the large photo aligns like the small one. Upscaled photos are
  smoother than real ones, so their JPEGs are smaller (1-2 MB) and may decode a bit faster.
- The worker's own thread settings, none of the script's: under a cgroup CPU quota the
  worker (`parking_worker/cpu_quota.py`) gives torch and OpenCV one thread per quota CPU at
  startup, after the scorer's warm-up predict (ultralytics' first predict resets torch to
  `min(8, os.cpu_count() - 1)`, counting the host's cores; later predicts do not). The script
  sets `YOLO_OFFLINE=1`, so ultralytics never checks connectivity or sends usage events; CI
  runs it with `--network none`.

In the vision image, with the repo mounted read-only for the seed files and fixtures:

```bash
docker build --build-arg WORKER_EXTRAS=vision -f worker/Dockerfile -t parking-worker:vision .
docker run --rm --network none --cpus=2 --cpuset-cpus=0,1 --memory=4g --memory-swap=4g -e OMP_NUM_THREADS=2 -e MKL_NUM_THREADS=2 -v "$PWD:/repo:ro" -v "$PWD/models:/app/models:ro" parking-worker:vision python /repo/scripts/worker_timing.py
```

`--cpus=2` is a CFS quota and leaves every host core visible, so `--cpuset-cpus=0,1` and the
OMP/MKL variables keep torch from running more threads than the quota pays for.
`--memory-swap=4g` keeps Docker from adding 4 GB of swap on top of the 4 GB limit. The memory
peak in the report is the cgroup's `memory.peak`, which includes page cache (the weights and
photos read); the process peak RSS is shown next to it. `--check-setup` seeds the lots and runs
one job per lot and photo size with the stub scorer, no weights needed, then exits. On the host
(no CPU or memory cap, so only a rough number):

```bash
MODELS_DIR=models uv run python scripts/worker_timing.py --jobs-per-lot 3
```

CI runs `--check-setup` in the image before the weights download, then the container version
in the `worker-vision-image` job (weights cached by `manifest.json`, the run capped at 20
minutes by `timeout`) and writes the table to the job summary; the JSON is uploaded as the
`nfr1-timing` artifact. GitHub's runners for public repositories have 4 vCPUs, so the two
pinned CPUs are the container's alone; a private repository's runner has 2 vCPUs, shared with
the runner agent and Docker, so its numbers are noisier and somewhat slower.

## Licenses

The ACPDS code (vendored in `worker/parking_worker/scorers/acpds/`) and its weights are MIT.
YOLO26 weights and the `ultralytics` package are AGPL-3.0. That is acceptable for this public
course repository; a closed-source deployment would need an Ultralytics Enterprise license.
