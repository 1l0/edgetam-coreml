# EdgeTAM for Core ML

Meta's [EdgeTAM](https://github.com/facebookresearch/EdgeTAM) video object tracker, converted to four Core ML
packages that run on the Apple Neural Engine. Click an object once, and it is tracked through the video
at about 48 ms a frame on an M4.

![A river surfer tracked through spray and camera motion from one click on the first frame](docs/demo.webp)

<sub>22 seconds of [Die Ewige Welle und Surfers in Augsburg](https://commons.wikimedia.org/wiki/File:Die_Ewige_Welle_und_Surfers_in_Augsburg.ogv)
(Sillerkiil, CC0), tracked on the Neural Engine with `examples/track.py` from a single click on frame 0.</sub>

- **Whole per-frame graph on the Neural Engine.** The image encoder and the propagator have no CPU ops, and a
  tracked frame takes about 48 ms of model time.
- **Exact conversion.** The same graph built in fp32 matches EdgeTAM's PyTorch video predictor with cosine 1.0000 on
  features, memories and object pointers (see [Accuracy](#accuracy)).
- **Every SAM 2 prompt.** It takes 1–16 positive and negative points, a mask prompt, or both. It returns all three
  candidate masks with their predicted IoUs and object pointers, so you can disambiguate a click or build your own
  memory policy.
- **Drop-in for the community conversion.** Input and output names and shapes follow
  [AhmadYarAI/EdgeTAM-CoreML-Video](https://huggingface.co/AhmadYarAI/EdgeTAM-CoreML-Video) wherever the meaning is
  the same.

## Quick start

Prebuilt packages are on the [Releases](../../releases/latest) page: unzip them and skip to tracking below
(`examples/track.py` needs only `coremltools`, `numpy` and `Pillow`). To build them yourself, you need macOS on Apple
silicon, [uv](https://github.com/astral-sh/uv) and git. ffmpeg is needed only to read video files.

```bash
./convert.sh ~/work/edgetam
```

This clones EdgeTAM at the pinned commit, checks the checkpoint's SHA-256 and sets up a Python 3.12 environment. It
then writes the packages to `~/work/edgetam/out/` and runs the parity check described below. Add `--no-parity` to
skip the check.

To track an object:

```bash
~/work/edgetam/venv/bin/python examples/track.py --models ~/work/edgetam/out \
    --video clip.mp4 --point 400,300
```

This writes `masks/00000.png…` and an overlay for each frame. `--video` is a video file or a folder of JPEGs, and
`--point` is a pixel on the first frame. Add `--negative X,Y` (repeatable) to exclude something. A single click picks
the best of three nested masks (a shirt rather than the whole person), so use more points to get the whole object.

The demo above is the surfer clip at 15 fps, cropped to 960×540, with one click:

```bash
ffmpeg -t 22 -i surf.ogv -vf fps=15,crop=960:540:640:270 -q:v 2 frames/%05d.jpg
~/work/edgetam/venv/bin/python examples/track.py --models ~/work/edgetam/out --video frames --point 632,345
```

## The packages

| Package | Runs | Size | Neural Engine, median |
|---|---|---|---|
| `EdgeTAMVideoImageEncoder` | every frame | 10 MB | 13.4 ms |
| `EdgeTAMVideoPropagator` | every tracked frame | 29 MB | 35.0 ms |
| `EdgeTAMVideoInitializer` | a prompted frame (fp32) | 26 MB | 42.9 ms |
| `EdgeTAMVideoMemoryEncoder` | after a prompted frame | 4 MB | 5.8 ms |

- **Image encoder**: a 1024² RGB image → `raw_vision_features`, `initial_vision_features` and
  `high_res_feature_0/1`.
- **Initializer**: the features, `point_coords` [1, N, 2] in 1024² pixels, `point_labels` [1, N] (1 positive,
  0 negative, −1 none) and an optional `mask_input` [1, 1, 1024, 1024] → `low_res_mask`, `high_res_mask` (logits),
  `best_iou`, `object_pointer`, `object_score` and the three `candidate_masks`, `candidate_ious` and
  `candidate_pointers`.
- **Memory encoder**: `raw_vision_features`, a `high_res_mask` and `object_score` → `memory_features`,
  `memory_positions` and `temporal_positions`.
- **Propagator**: the features and the memory bank (`spatial_bank`, `spatial_positions` [1, 7, 512, 64],
  `pointer_bank` [1, 16, 256], `attention_bias`) → the initializer's outputs, plus this frame's `memory_features`
  and `memory_positions`.

The docstring of [`edgetam_coreml/convert.py`](edgetam_coreml/convert.py) has every shape and the exact semantics.

### The tracking loop

[`examples/track.py`](examples/track.py) is the whole loop, with coremltools alone:

1. Run the image encoder on every frame.
2. On the prompted frame, run the initializer with the click, then the memory encoder on its mask (binarized). That
   gives the seed memory and pointer.
3. On every later frame, run the propagator with the bank. Its mask is the answer, and its memory and pointer join
   the bank.

The bank is assembled the way SAM 2 does it:

| Slot | Spatial memory (`spatial_bank`) | Temporal row added to its positions |
|---|---|---|
| 0–5 | the 1st…6th previous frame | 0–5 |
| 6 | the prompted (seed) frame | 6 |

| Slot | Pointer (`pointer_bank`) |
|---|---|
| 0 | the seed's |
| 1–15 | the 15 previous frames', most recent first |

Leave slots that have no frame yet as zeros (see below).

## Accuracy

`edgetam_coreml.parity` runs EdgeTAM's PyTorch `SAM2VideoPredictor` and the packages side by side on EdgeTAM's bedroom video.
There are five sequences of 40 frames: three objects from frame 0, one from frame 120, and one with 8 black frames in
the middle, where the object leaves and comes back. Each is seeded by a click, and the Core ML side carries its own
memory from frame to frame. It also checks the click paths: one click must pick PyTorch's candidate, and several
points must give the same mask.

| Build, backend | mask IoU min / mean | memory cosine min | pointer cosine min | all bounds met |
|---|---|---|---|---|
| fp32, CPU | 0.981 / 0.9997 | 0.99997 | 1.0000 | 5 of 5 |
| fp16 (shipped), GPU | 0.963 / 0.998 | 0.905 | 0.944 | 3 of 5 |
| fp16 (shipped), Neural Engine | 0.839 / 0.984 | 0.815 | 0.671 | 0 of 5 |

The bounds are a mask IoU of at least 0.95 and cosines of at least 0.99 on every frame. The reports are in
[`results/`](results).

The fp32 row shows that the conversion itself is exact. What remains in the shipped packages is fp16 rounding, which
accumulates over long runs. The Neural Engine rounds most, and every click still picks PyTorch's candidate there.
`convert.sh` fails if the fp32 build falls short, and only reports the fp16 packages.

## Speed

Apple M4, warm, back to back, load average under 2 (`edgetam_coreml.speed`, `results/speed.jsonl`):

| | median | p95 |
|---|---|---|
| image encoder | 13.4 ms | 13.8 ms |
| propagator | 35.0 ms | 35.2 ms |
| **a tracked frame** | **48.4 ms** | |
| initializer (once per prompt) | 42.9 ms | 43.6 ms |
| memory encoder (once per prompt) | 5.8 ms | 5.9 ms |

The first load compiles for the Neural Engine and takes about 3 s for the propagator. The image encoder does not read
the memory bank, so an app can encode frame n + 1 while frame n propagates.

## Neural Engine and attention masks

Core ML on the Neural Engine **ignores an attention mask that comes into the model as an input**. With
`scaled_dot_product_attention(…, attn_mask=bias)` and `bias` a model input, the compiled graph gives bit-identical
outputs whatever the mask, while the GPU and CPU apply it. Any SAM 2 port that masks the empty slots of a fixed-size
memory bank this way therefore attends them on the Neural Engine, and differs between backends.

These packages make that behavior explicit:
- The empty slots are attended on every backend, as zero memories with zero positions.
- `attention_bias` stays an input, so the interface does not change, but it is not read.
- Tracking is the same on every backend and does not depend on the compiler.

`parity --attend-empty-slots` pads PyTorch's bank the same way, and the table above is against that reference.

`convert --mask-empty-slots` builds packages that mask the empty slots as PyTorch does. Compare them with stock
PyTorch (`parity` without the flag). On the Neural Engine their propagator takes about 89 ms instead of 35, because
the masked graph runs the decoder's tail on the CPU.

## Compared with the community conversion

[AhmadYarAI/EdgeTAM-CoreML-Video](https://huggingface.co/AhmadYarAI/EdgeTAM-CoreML-Video) uses the same names and
shapes where the meaning is the same, so code written for it runs these packages. Differences:

| | community | this repo |
|---|---|---|
| Prompts | one positive click | 1–16 points (positive and negative), a mask prompt, or both |
| Outputs | the chosen mask | the chosen mask plus all three candidates with IoUs and pointers |
| Rotary positions | `rotary_weight` input | fixed inside the propagator |
| Propagator, Neural Engine | ~45 ms | 35 ms |

## Building by hand

From the repository root, in the environment `convert.sh` made (or any Python 3.12 with `requirements.txt`):

```bash
python -m edgetam_coreml.convert --edgetam <EdgeTAM checkout> --out <folder> [options]
python -m edgetam_coreml.parity --edgetam <EdgeTAM checkout> --models <folder> --work <scratch> [--units ane|gpu|cpu] [--attend-empty-slots]
python -m edgetam_coreml.speed <folder> [--units ane|gpu|cpu]
```

| Option | Effect |
|---|---|
| `--only encoder,initializer,memory,propagator` | build some of the packages |
| `--fp32 <packages or none>` | packages computed in fp32 (default: `initializer`) |
| `--mask-empty-slots` | the propagator masks the bank's empty slots, as PyTorch does |
| `--weights pkg:int8,…` | weight compression: int8, pal4, pal6, pal8. EdgeTAM's small weights lose accuracy, so it is not recommended |
| `--smooth-seed-memory` | the memory encoder downsamples and upsamples its input the way SAM 2 treats a mask prompt |

Python 3.12 is required, because coremltools 9.0 has no wheels for 3.13 and later. The upstream source is
facebookresearch/EdgeTAM at commit `7711e01`, and `edgetam_coreml/upstream.py` pins the checkpoint's SHA-256.

## Repository layout

```
convert.sh               the clean build: clone EdgeTAM, venv, convert, parity
edgetam_coreml/
  convert.py             the conversion: PyTorch modules restated for Core ML, then ct.convert
  parity.py              the comparison with EdgeTAM's PyTorch video predictor
  speed.py               latency per package and compute unit
  upstream.py            the pinned EdgeTAM commit and checkpoint, and the predictor builder
examples/track.py        tracking from a click with coremltools alone
results/                 parity reports and speed
docs/                    the demo animation
```

## License

EdgeTAM is Apache-2.0 (Meta Platforms, Inc.), and so are the converted packages and this repository's code.
[`LICENSE`](LICENSE) is EdgeTAM's license. [`NOTICE`](NOTICE) names the upstream work and must travel with every copy
of the packages. The demo video is [CC0](https://creativecommons.org/publicdomain/zero/1.0/) from Wikimedia Commons.
