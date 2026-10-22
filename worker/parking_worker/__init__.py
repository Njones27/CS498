"""Processing worker (HDD §4). `handler.process_message` is shared with the Phase 2 Lambda."""

import os

# Cap what OpenCV will decode (~134 MP) before anything imports cv2: a decompression bomb
# must fail in the codec, not allocate gigabytes. The scorer also rejects > 100 MP photos.
os.environ.setdefault("OPENCV_IO_MAX_IMAGE_PIXELS", str(2**27))
