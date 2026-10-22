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
