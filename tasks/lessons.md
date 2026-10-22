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
