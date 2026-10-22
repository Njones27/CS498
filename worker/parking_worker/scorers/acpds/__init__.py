"""ACPDS parking-space classifier (Marek, 2021), vendored for the acpds_yolo scorer.

Upstream: https://github.com/martin-marek/parking-space-occupancy at commit
17da2c8b33055be8019483260f0efbcbdfda0478. MIT License, see LICENSE in this directory.

Import the submodules directly (`from .acpds.rcnn import RCNN`). This package imports nothing
on its own so that `parking_worker.scorers` never pulls in torch unless the real detector runs.
"""
