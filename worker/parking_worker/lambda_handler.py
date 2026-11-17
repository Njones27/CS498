"""AWS Lambda entry point for the worker (HDD §8): SQS event source -> the same
`process_message` / `process_proposal` the local poller runs.

Those functions delete a finished job's message themselves and return normally for a job that
must be tried again. Lambda deletes every message of a batch that returns normally, so the
ones to retry are reported back as partial batch failures (the event source mapping needs
`ReportBatchItemFailures`).

A job that failed is also handed back to the queue for redelivery in a minute or so. A job
that could not be claimed, or whose message was kept because another worker changed it, is
not: that worker may still be running it, and the queue's visibility timeout (longer than
the function's own timeout) is what keeps the job from being run twice. The same wait
applies after an invocation that was killed (timeout, out of memory).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Literal

from parking_core.interfaces import Aligner, LayoutProposer, SpaceScorer
from parking_core.models import Cutoffs, Message
from parking_core.settings import Adapters, build_adapters, get_settings

from .handler import ProcessResult, process_message
from .proposals import ProposalResult, is_proposal_message, process_proposal

log = logging.getLogger(__name__)

RETRY_DELAY_SECONDS = 30
"""Times the delivery count: 30 s before the second attempt, 60 s before the third, so a
short outage of DynamoDB or S3 does not use up every attempt at once."""

Verdict = Literal["done", "retry_soon", "retry_later"]
"""What becomes of a record's message. `done`: Lambda may delete it (the job code already
has). `retry_soon`: the job ran and failed; redeliver after `RETRY_DELAY_SECONDS`.
`retry_later`: someone else may hold the job; redeliver when the visibility timeout ends."""


@dataclass
class Runtime:
    adapters: Adapters
    aligner: Aligner
    scorer: SpaceScorer
    proposer: LayoutProposer | None
    cutoffs: Cutoffs


@lru_cache(maxsize=1)
def _runtime() -> Runtime:
    """Loaded on the first invocation and kept for the life of the execution environment.
    Not at import, and neither is `.poller` (OpenCV, then torch): Lambda allows its init phase
    10 s and starts over when that runs out. On a new image the first read of those libraries
    alone takes longer, and the models come after."""
    from .poller import build_layout_proposer, build_worker

    logging.getLogger().setLevel(logging.INFO)  # the Lambda runtime installs the handler
    settings = get_settings()
    adapters = build_adapters(settings)
    aligner, scorer = build_worker(settings, adapters)
    proposer = build_layout_proposer(settings, scorer)
    log.info("Worker ready (model %s)", scorer.model_version)
    return Runtime(adapters, aligner, scorer, proposer, settings.cutoffs)


def handle(event: dict[str, Any], runtime: Runtime) -> dict[str, Any]:
    """Process every SQS record of the event; returns the records Lambda must not delete."""
    failures: list[dict[str, str]] = []
    for record in event.get("Records", []):
        msg = Message(
            body=record["body"],
            receipt=record["receiptHandle"],
            receive_count=int(record.get("attributes", {}).get("ApproximateReceiveCount", 1)),
        )
        verdict = _run(msg, runtime)
        if verdict == "done":
            continue
        failures.append({"itemIdentifier": record["messageId"]})
        if verdict == "retry_soon":
            try:
                runtime.adapters.queue.release(msg.receipt, RETRY_DELAY_SECONDS * msg.receive_count)
            except Exception:  # redelivered after the visibility timeout instead
                log.warning("Could not hand message %s back early", record["messageId"])
    return {"batchItemFailures": failures}


def _run(msg: Message, runtime: Runtime) -> Verdict:
    """Run one job and say what becomes of its message."""
    result: ProcessResult | ProposalResult
    try:
        if is_proposal_message(msg.body):
            result = process_proposal(msg, runtime.adapters, runtime.proposer)
        else:
            result = process_message(
                msg, runtime.adapters, runtime.aligner, runtime.scorer, runtime.cutoffs
            )
    except Exception:  # a failure outside the job itself (DynamoDB, S3): try again
        log.exception("Job message failed outside the job: %r", msg.body[:200])
        return "retry_soon"
    if result.outcome == "failed_retryable":
        return "retry_soon"
    if result.outcome == "deferred" or result.message_kept:
        return "retry_later"
    return "done"


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    return handle(event, _runtime())
