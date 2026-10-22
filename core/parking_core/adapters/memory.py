"""In-memory adapters for tests and APP_ENV=test. Filled in by the backend wave-1 work.

Must keep the same conditional semantics as the AWS adapters: `claim_hash` conflicts,
`takeover_hash`, `transition_job` from-state checks, `update_status_if_newer`, and a queue
that tracks `receive_count` and visibility.
"""

from __future__ import annotations

from ..settings import Adapters, Settings


def build_memory_adapters(settings: Settings) -> Adapters:
    raise NotImplementedError("memory adapters land in the backend wave-1 PR")
