"""Pixel size of a JPEG or PNG read from its header, as a browser shows it (US-08).

The API has no image library, and a header is all it needs: PNG puts the size in its first
chunk (IHDR), JPEG in its frame header (SOFn). A JPEG's EXIF orientation is applied, because
browsers and the worker's decoder (OpenCV) both show a phone photo upright. A PNG's rare eXIf
chunk is not read: its size is taken as stored.
"""

from __future__ import annotations

import struct

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# SOFn markers carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) share the range but do not.
_SOF_MARKERS = frozenset(range(0xC0, 0xD0)) - {0xC4, 0xC8, 0xCC}
_SOS = 0xDA
_APP1 = 0xE1
# EXIF orientations 5-8 turn the picture a quarter turn, so the shown width is the stored height.
_QUARTER_TURNS = frozenset({5, 6, 7, 8})


def image_size(data: bytes, content_type: str) -> tuple[int, int] | None:
    """(width, height) of `data` as displayed, or None when it is not a `content_type` image."""
    try:
        if content_type == "image/png":
            size = _png_size(data)
        elif content_type == "image/jpeg":
            size = _jpeg_size(data)
        else:
            return None
    except struct.error:  # truncated header
        return None
    if size is None or size[0] <= 0 or size[1] <= 0:
        return None
    return size


def _png_size(data: bytes) -> tuple[int, int] | None:
    # The first chunk is always IHDR: length (4), type (4), width (4), height (4).
    if not data.startswith(_PNG_SIGNATURE) or data[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", data[16:24])
    return width, height


def _jpeg_size(data: bytes) -> tuple[int, int] | None:
    if not data.startswith(b"\xff\xd8"):
        return None
    orientation = 1
    i = 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            return None
        marker = data[i + 1]
        if marker == 0xFF:  # fill byte before a marker
            i += 1
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:  # TEM and RSTn have no length
            i += 2
            continue
        (length,) = struct.unpack(">H", data[i + 2 : i + 4])
        segment = data[i + 4 : i + 2 + length]
        if marker in _SOF_MARKERS:
            height, width = struct.unpack(">HH", segment[1:5])  # after the sample precision
            return (height, width) if orientation in _QUARTER_TURNS else (width, height)
        if marker == _SOS:  # image data started without a frame header
            return None
        if marker == _APP1 and segment.startswith(b"Exif\x00\x00"):
            orientation = _exif_orientation(segment[6:])
        i += 2 + length
    return None


def _exif_orientation(tiff: bytes) -> int:
    """The Orientation tag (0x0112) of IFD0; 1 (upright) when it is missing or unreadable."""
    order = {b"II": "<", b"MM": ">"}.get(tiff[:2])
    if order is None:
        return 1
    try:
        (ifd,) = struct.unpack(order + "I", tiff[4:8])
        (count,) = struct.unpack(order + "H", tiff[ifd : ifd + 2])
        for n in range(count):
            entry = ifd + 2 + 12 * n
            # tag, type, count, then a SHORT value left-aligned in the 4-byte value field
            tag, _type, _count, value = struct.unpack(order + "HHIH", tiff[entry : entry + 10])
            if tag == 0x0112:
                return value
    except struct.error:
        return 1
    return 1
