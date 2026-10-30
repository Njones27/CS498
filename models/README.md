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
runs 10 jobs per lot through the real worker path (photo fetch, ORB alignment, ACPDS + YOLO26m,
status writes) and reports p50/p95 per job, with model load and one warm-up job per lot shown
apart. It exits 1 when p95 is over 30 s (`--limit-s`). In the vision image, with the repo
mounted read-only for the seed files and fixtures:

```bash
docker build --build-arg WORKER_EXTRAS=vision -f worker/Dockerfile -t parking-worker:vision .
docker run --rm --cpus=2 --memory=4g --memory-swap=4g -v "$PWD:/repo:ro" -v "$PWD/models:/app/models:ro" parking-worker:vision python /repo/scripts/worker_timing.py
```

`--memory-swap=4g` keeps Docker from adding 4 GB of swap on top of the 4 GB limit. On the host
(no CPU or memory cap, so only a rough number):

```bash
MODELS_DIR=models uv run python scripts/worker_timing.py --jobs-per-lot 3
```

CI runs the container version in the `worker-vision-image` job (weights cached by
`manifest.json`) and writes the table to the job summary; the JSON is uploaded as the
`nfr1-timing` artifact.

## Licenses

The ACPDS code (vendored in `worker/parking_worker/scorers/acpds/`) and its weights are MIT.
YOLO26 weights and the `ultralytics` package are AGPL-3.0. That is acceptable for this public
course repository; a closed-source deployment would need an Ultralytics Enterprise license.
