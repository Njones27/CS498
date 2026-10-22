# Lessons

- 2026-10-21 Plan review: presigned URLs must be signed with the browser-facing host
  (S3_PUBLIC_ENDPOINT_URL), not the compose-internal one; the host is part of the signature.
- 2026-10-21 Plan review: keep alignment out of the scorer; permanent failures must not be
  retried; count attempts from the queue's receive count, not a DB counter; only allow Retry
  once a job is finished; let a new upload take over a hash claim whose original expired.
- 2026-10-21 Plan review: fix the API contract (schemas -> openapi.json -> generated TS types)
  before splitting work across agents or teammates.
- 2026-10-21 Tooling: openapi-typescript 7 needs TypeScript 5.x; Vite's template installs TS 6.
- 2026-10-21 Claude Code: parallel Bash calls share one working directory, so a `cd` in one
  shell moves the other. Always use absolute paths when running shells in parallel.
- 2026-10-21 Tooling: something set the macOS `hidden` flag (UF_HIDDEN) on every `.pth` in `.venv`
  while subagent worktrees ran `uv sync`; Python 3.12 silently skips hidden .pth files, so the
  editable workspace packages vanished (`ModuleNotFoundError: parking_core`). Check with
  `ls -lO .venv/lib/python3.12/site-packages/*.pth`, fix with `chflags nohidden`.
- 2026-10-21 Subagent worktrees start from `main`, not the current branch; every brief must name
  the base branch explicitly (`git checkout -b x <base>`). Two agents each adding the same file
  (worker/Dockerfile) conflicts at integration: give one owner per file.
- 2026-10-21 A root `tests/__init__.py` collides with `api/tests` etc. under pytest's default
  import mode; keep the end-to-end tests package-less.
- 2026-10-21 ship-gate records a review only when the reviewing turn ends, so a review and
  `gh pr create` cannot share one turn; a code-reviewer subagent's completion counts.
- 2026-10-21 Shell: a failing command inside a long `&&` chain silently skips the rest; check
  `git show --stat` after every multi-step commit command.
- 2026-10-22 `minio/minio` disappeared from Docker Hub (pull access denied). Check that pinned
  images still exist (Docker Hub tags API) before relying on them; prefer configuring storage
  through the S3 API (PutBucketCors) over vendor env vars so the emulator stays swappable.
- 2026-10-22 Stacked PRs merged in order still landed in their base branches, not `main`, because each
  base branch wasn't deleted (and the next PR retargeted) before the next merge. For stacks, either
  merge top-down into `main` after retargeting, or land the stack with one PR from its tip.
- 2026-10-22 The repo lives in iCloud-synced ~/Documents: iCloud created "name 2" duplicates inside
  `.git/refs`, which broke `git fetch`. Keep git repos outside iCloud Drive.
- 2026-10-22 ship-gate fingerprints the *working tree* (tracked edits via `git add -u`, plus all
  non-ignored files) when a reviewer agent is spawned, and opens `gh pr create` only when HEAD's
  committed tree equals one of those fingerprints. So: stash uncommitted tracked edits (e.g.
  tasks/*.md notes) before spawning the final review, or the review never matches HEAD. Untracked
  files don't matter (the tracked-only tree still matches), dirty tracked files do.
- 2026-10-22 Review finding worth keeping: never derive a record's lifecycle state in the browser from
  `Date.now()` when the server already knows it (a scheduled closure flipped to "Ended" on the
  client). Return the state from the API and render it.
- 2026-10-22 YOLO's default 640 px inference size silently missed most small, distant cars in
  1280 px photos. Always set `imgsz` explicitly for high-resolution photos and benchmark it.
- 2026-10-22 Never let a clamped or out-of-frame ROI reach a classifier: a crop of a half-visible
  space gets a confident, meaningless score. Null the score instead and let the rules handle it.
- 2026-10-22 uv optional extras are removed by a plain `uv sync`; use `uv sync --all-packages --extra <name>`.
- 2026-10-22 ultralytics pulls in `opencv-python`, which installs a second, GUI-linked `cv2` over the
  headless one. Override it away (uv `override-dependencies`) and keep only `opencv-python-headless`.
- 2026-10-22 The PKLot `samples.json` is sorted by camera, so streaming from the start yields one
  camera only. Sample ranged windows across the file instead.
