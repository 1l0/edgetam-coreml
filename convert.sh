#!/bin/zsh
# Builds the EdgeTAM Core ML packages from a clean folder, then checks them against PyTorch.
#
#   ./convert.sh <work folder> [--no-parity]
#
# In <work folder> (outside the repo): a checkout of facebookresearch/EdgeTAM at the pinned commit (upstream.py), its
# checkpoint checked against the pinned SHA-256, a Python 3.12 venv from requirements.txt (uv), and out/ with the four
# .mlpackage files. The parity check then compares the same graph in fp32 with the PyTorch video predictor on EdgeTAM's
# bedroom video and exits non-zero if it falls short, and reports how the fp16 packages compare.
set -euo pipefail

# Refuse to start with under 2 GB free: conversions and mask outputs fill a tight disk fast.
free_kb=$(df -k / | awk 'NR == 2 {print $4}')
((free_kb > 2 * 1024 * 1024)) || { print -u2 "under 2 GB free on /; clean up first"; exit 75; }

work=${1:?usage: convert.sh <work folder> [--no-parity]}
here=${0:A:h}
commit=$(sed -n 's/^COMMIT = "\(.*\)"/\1/p' "$here/edgetam_coreml/upstream.py")
sha=$(sed -n 's/^CHECKPOINT_SHA256 = "\(.*\)"/\1/p' "$here/edgetam_coreml/upstream.py")
# The package from this checkout; -P keeps the current folder off sys.path.
py=(env PYTHONPATH="$here" venv/bin/python -P -m)
cap() { perl -e 'alarm shift; exec @ARGV' "$@"; }
mkdir -p "$work"
cd "$work"

if [[ ! -d EdgeTAM ]]; then
    cap 300 git clone -q https://github.com/facebookresearch/EdgeTAM.git EdgeTAM
fi
git -C EdgeTAM fetch -q origin "$commit" 2>/dev/null || true
git -C EdgeTAM checkout -q "$commit"
[[ $(shasum -a 256 EdgeTAM/checkpoints/edgetam.pt | cut -d' ' -f1) == "$sha" ]] || {
    print -u2 "EdgeTAM/checkpoints/edgetam.pt does not match $sha"
    exit 1
}

if [[ ! -x venv/bin/python ]]; then
    cap 300 uv python install 3.12
    uv venv -q -p 3.12 venv
fi
cap 900 uv pip install -q -p venv/bin/python -r "$here/requirements.txt"

cap 1200 $py edgetam_coreml.convert --edgetam EdgeTAM --out out
if [[ ${2:-} != --no-parity ]]; then
    # The conversion itself: the same graph in fp32 on the CPU must match PyTorch (its bank padded the packages'
    # way) within the parity bounds. Then the shipped fp16 packages on the GPU, reported: fp16 drifts on long runs.
    cap 1200 $py edgetam_coreml.convert --edgetam EdgeTAM --out out-fp32 \
        --fp32 encoder,initializer,memory,propagator
    cap 2400 $py edgetam_coreml.parity --edgetam EdgeTAM --models out-fp32 --work frames --units cpu \
        --attend-empty-slots --json parity.json
    rm -rf out-fp32
    cap 1200 $py edgetam_coreml.parity --edgetam EdgeTAM --models out --work frames --units gpu \
        --attend-empty-slots --json parity-fp16.json || print "fp16 packages: see parity-fp16.json"
fi
print "packages: $work/out"
