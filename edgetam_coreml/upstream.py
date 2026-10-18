"""Loads Meta's EdgeTAM (facebookresearch/EdgeTAM, Apache-2.0) from a checkout of the pinned commit.

The checkout is only put on sys.path; nothing runs from inside it. timm is asked for the RepViT trunk without its
ImageNet weights: the EdgeTAM checkpoint holds every weight, so nothing is downloaded.
"""

import os
import sys

# The upstream commit and checkpoint that convert.sh fetches and checks.
COMMIT = "7711e012a30a2402c4eaab637bdb00a521302c91"
CHECKPOINT_SHA256 = "ed2d4850b8792c239689b043c47046ec239b6e808a3d9b6ae676c803fd8780df"


def _use_checkout(src: str) -> None:
    src = os.path.abspath(src)
    if src not in sys.path:
        sys.path.insert(0, src)
    import timm.models

    create = timm.models.create_model

    def without_download(*args, **kwargs):
        kwargs["pretrained"] = False
        return create(*args, **kwargs)

    import sam2.modeling.backbones.timm as backbone

    backbone.create_model = without_download


def build_video_predictor(src: str):
    """The upstream SAM2VideoPredictor on the CPU, as build_sam2_video_predictor builds it (the video settings:
    dynamic multimask fallback, binarized click masks for memory, hole filling where the CUDA extension exists).
    It is both the model the packages are converted from and the parity reference."""
    _use_checkout(src)
    from sam2.build_sam import build_sam2_video_predictor

    ckpt = os.path.join(os.path.abspath(src), "checkpoints", "edgetam.pt")
    return build_sam2_video_predictor("edgetam.yaml", ckpt, device="cpu")
