"""AWS Lambda entry point for the worker (HDD §8): SQS event source -> the same
`process_message` / `process_proposal` the local poller runs.

Those functions delete a finished job's message themselves and return normally for a job that
must be tried again. Lambda deletes every message of a batch that returns normally, so the
ones to retry are reported back as partial batch failures (the event source mapping needs
`ReportBatchItemFailures`) and handed back to the queue for redelivery in under a minute or
two instead of after the whole visibility timeout. An invocation that is killed (timeout,
out of memory) hands nothing back: its message returns when the visibility timeout ends.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from parking_core.interfaces import Aligner, LayoutProposer, SpaceScorer
from parking_core.models import Cutoffs, Message
from parking_core.settings import Adapters, build_adapters, get_settings

from .handler import ProcessResult, process_message
from .proposals import ProposalResult, is_proposal_message, process_proposal

log = logging.getLogger(__name__)

RETRY_OUTCOMES = frozenset({"deferred", "failed_retryable"})
RETRY_DELAY_SECONDS = 30
"""Times the delivery count: 30 s before the second attempt, 60 s before the third, so a
short outage of DynamoDB or S3 does not use up every attempt at once."""


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
        if _retry(msg, runtime):
            failures.append({"itemIdentifier": record["messageId"]})
            try:
                runtime.adapters.queue.release(msg.receipt, RETRY_DELAY_SECONDS * msg.receive_count)
            except Exception:  # redelivered after the visibility timeout instead
                log.warning("Could not hand message %s back early", record["messageId"])
    return {"batchItemFailures": failures}


def _retry(msg: Message, runtime: Runtime) -> bool:
    """Run one job. True when its message must stay on the queue."""
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
        return True
    return result.outcome in RETRY_OUTCOMES or result.message_kept


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    return handle(event, _runtime())
