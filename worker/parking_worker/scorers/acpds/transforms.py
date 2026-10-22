# Vendored from https://github.com/martin-marek/parking-space-occupancy
# at commit 17da2c8b33055be8019483260f0efbcbdfda0478, file utils/transforms.py
# Copyright (c) 2021 Martin Marek. MIT License, see LICENSE in this directory.
# Local changes: kept only preprocess(); the training augmentations were dropped.

import torch
import torchvision.transforms as T
import torchvision.transforms.functional as TF


def preprocess(image, res=None):
    """
    Resizes, normalizes, and converts image to float32.
    """
    # resize image to model input size
    if res is not None:
        image = TF.resize(image, res)

    # convert image to float
    image = image.to(torch.float32) / 255

    # normalize image to default torchvision values
    image = T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])(image)

    return image
