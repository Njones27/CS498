"""Job errors. Permanent errors are never retried; anything else is (HDD §4.2)."""


class PermanentJobError(Exception):
    """Retrying cannot help: bad photo, unknown viewpoint, missing layout, alignment failed."""


class AlignmentError(PermanentJobError):
    """Raised by an Aligner when the photo does not match its viewpoint."""

    def __init__(self, message: str = "Too few matches") -> None:
        super().__init__(message)


class RetryableJobError(Exception):
    """Transient failure (storage hiccup, timeout). The queue redelivers."""


class NotPublishedError(Exception):
    """The lot has no published layout."""
