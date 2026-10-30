"""Long-poll loop. Run with `python -m parking_worker.poller`."""

from __future__ import annotations

import logging
import threading

from parking_core.interfaces import Aligner, SpaceScorer
from parking_core.models import Cutoffs
from parking_core.settings import Adapters, Settings, build_adapters, get_settings

from .aligners import build_aligner
from .cpu_quota import limit_threads_to_quota
from .handler import ProcessResult, process_message
from .scorers import build_scorer

log = logging.getLogger(__name__)


def run_once(
    adapters: Adapters,
    aligner: Aligner,
    scorer: SpaceScorer,
    cutoffs: Cutoffs,
    wait_seconds: int = 10,
) -> ProcessResult | None:
    """Receive at most one message and process it. None when the queue was empty."""
    messages = adapters.queue.receive(max_messages=1, wait_seconds=wait_seconds)
    if not messages:
        return None
    return process_message(messages[0], adapters, aligner, scorer, cutoffs)


def run_forever(
    adapters: Adapters,
    aligner: Aligner,
    scorer: SpaceScorer,
    cutoffs: Cutoffs,
    stop: threading.Event | None = None,
) -> None:
    stop = stop or threading.Event()
    log.info("Worker polling (model %s)", scorer.model_version)
    while not stop.is_set():
        try:
            result = run_once(adapters, aligner, scorer, cutoffs)
        except Exception:  # queue/network hiccup: never kill the loop
            log.exception("Poll iteration failed")
            stop.wait(1.0)
            continue
        if result is None:
            stop.wait(0.2)  # the memory queue does not block; avoid a busy loop


def build_worker(settings: Settings, adapters: Adapters) -> tuple[Aligner, SpaceScorer]:
    """The aligner and scorer the worker runs with, its threads sized to the CPU quota.

    OpenCV (ORB alignment, photo decoding) is limited first, whatever the scorer; the
    ACPDS + YOLO scorer limits again once its models are loaded, torch included."""
    limit_threads_to_quota()
    return build_aligner(settings, adapters), build_scorer(settings)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = get_settings()
    adapters = build_adapters(settings)
    aligner, scorer = build_worker(settings, adapters)
    run_forever(adapters, aligner, scorer, settings.cutoffs)


if __name__ == "__main__":
    main()
