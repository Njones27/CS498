"""Long-poll loop. Run with `python -m parking_worker.poller`."""

from __future__ import annotations

import logging
import threading

from parking_core.interfaces import Aligner, LayoutProposer, SpaceScorer
from parking_core.models import Cutoffs
from parking_core.settings import Adapters, Settings, build_adapters, get_settings

from .aligners import build_aligner
from .cpu_quota import limit_threads_to_quota
from .handler import ProcessResult, process_message
from .proposals import ProposalResult, is_proposal_message, process_proposal
from .scorers import build_scorer

log = logging.getLogger(__name__)


def run_once(
    adapters: Adapters,
    aligner: Aligner,
    scorer: SpaceScorer,
    cutoffs: Cutoffs,
    wait_seconds: int = 10,
    proposer: LayoutProposer | None = None,
) -> ProcessResult | ProposalResult | None:
    """Receive at most one message and process it. None when the queue was empty.

    Layout proposer jobs share the queue with photo jobs and are told apart by `kind`."""
    messages = adapters.queue.receive(max_messages=1, wait_seconds=wait_seconds)
    if not messages:
        return None
    msg = messages[0]
    if is_proposal_message(msg.body):
        return process_proposal(msg, adapters, proposer)
    return process_message(msg, adapters, aligner, scorer, cutoffs)


def run_forever(
    adapters: Adapters,
    aligner: Aligner,
    scorer: SpaceScorer,
    cutoffs: Cutoffs,
    stop: threading.Event | None = None,
    proposer: LayoutProposer | None = None,
) -> None:
    stop = stop or threading.Event()
    log.info("Worker polling (model %s)", scorer.model_version)
    while not stop.is_set():
        try:
            result = run_once(adapters, aligner, scorer, cutoffs, proposer=proposer)
        except Exception:  # queue/network hiccup: never kill the loop
            log.exception("Poll iteration failed")
            stop.wait(1.0)
            continue
        if result is None:
            stop.wait(0.2)  # the memory queue does not block; avoid a busy loop


def build_worker(settings: Settings, adapters: Adapters) -> tuple[Aligner, SpaceScorer]:
    """The aligner and scorer the worker runs with, its threads sized to the CPU quota.

    The limit goes last: importing ultralytics sets OpenCV to 0 threads, and the YOLO
    detector's warm-up predict at load resets torch to a count of the host's cores."""
    aligner, scorer = build_aligner(settings, adapters), build_scorer(settings)
    limit_threads_to_quota()
    return aligner, scorer


def build_layout_proposer(settings: Settings, scorer: SpaceScorer) -> LayoutProposer:
    """The layout proposer, sharing the scorer's YOLO detector when it has one, so the worker
    loads one copy of the model. With the stub scorer it uses painted lines only."""
    from .proposer import build_proposer

    return build_proposer(settings, getattr(scorer, "car_detector", None))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = get_settings()
    adapters = build_adapters(settings)
    aligner, scorer = build_worker(settings, adapters)
    proposer = build_layout_proposer(settings, scorer)
    run_forever(adapters, aligner, scorer, settings.cutoffs, proposer=proposer)


if __name__ == "__main__":
    main()
