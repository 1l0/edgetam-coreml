"""Per-package latency of a package folder on one compute unit: median and p95 of warm predictions on realistic shapes.

    python -m edgetam_coreml.speed <packages> [--units ane|gpu|all|cpu] [--runs 30] [--label name] [--json results/speed.jsonl]

The load (with the first Neural Engine compile) is timed separately. Run it on an idle machine: another process on
the Neural Engine or GPU shows up directly in the numbers. Each package also reports where Core ML's compute plan
puts its operations (`ops`: count per device, constants left out).
"""

import argparse
import json
import os
import platform
import subprocess
import time

import numpy as np

NAMES = ["EdgeTAMVideoImageEncoder", "EdgeTAMVideoInitializer", "EdgeTAMVideoMemoryEncoder", "EdgeTAMVideoPropagator"]


def inputs(name):
    from PIL import Image

    rng = np.random.default_rng(0)
    h = lambda *s: rng.standard_normal(s).astype(np.float16)  # noqa: E731
    features = {"high_res_feature_0": h(1, 32, 256, 256), "high_res_feature_1": h(1, 64, 128, 128)}
    if name == NAMES[0]:
        return {"image": Image.fromarray(rng.integers(0, 255, (1024, 1024, 3), np.uint8))}
    if name == NAMES[1]:
        return {"initial_vision_features": h(1, 256, 64, 64), **features,
                "point_coords": np.array([[[500, 400]]], np.float16), "point_labels": np.ones((1, 1), np.int32)}
    if name == NAMES[2]:
        return {"raw_vision_features": h(1, 256, 64, 64), "high_res_mask": h(1, 1, 1024, 1024) * 10,
                "object_score": np.full((1, 1), 10, np.float16)}
    bias = np.zeros((1, 1, 1, 3648), np.float16)
    return {"raw_vision_features": h(1, 256, 64, 64), **features, "spatial_bank": h(1, 7, 512, 64),
            "spatial_positions": h(1, 7, 512, 64), "pointer_bank": h(1, 16, 256), "attention_bias": bias}


def devices(path, unit):
    """Operations per compute device in Core ML's plan for the package on `unit`, constants left out."""
    import coremltools as ct
    from coremltools.models.compute_device import MLCPUComputeDevice, MLGPUComputeDevice, MLNeuralEngineComputeDevice
    from coremltools.models.compute_plan import MLComputePlan

    kinds = {MLCPUComputeDevice: "cpu", MLGPUComputeDevice: "gpu", MLNeuralEngineComputeDevice: "ane"}
    plan = MLComputePlan.load_from_path(ct.models.utils.compile_model(path), compute_units=unit)
    counts = {}

    def walk(operations):
        for op in operations:
            usage = plan.get_compute_device_usage_for_mlprogram_operation(op)
            if usage is not None:
                kind = kinds.get(type(usage.preferred_compute_device), "other")
                counts[kind] = counts.get(kind, 0) + 1
            for block in op.blocks:
                walk(block.operations)

    walk(plan.model_structure.program.functions["main"].block.operations)
    return counts


def main():
    import coremltools as ct

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("models")
    parser.add_argument("--units", default="ane")
    parser.add_argument("--runs", type=int, default=30)
    parser.add_argument("--label", default="")
    parser.add_argument("--json")
    args = parser.parse_args()
    unit = {"gpu": ct.ComputeUnit.CPU_AND_GPU, "ane": ct.ComputeUnit.CPU_AND_NE, "all": ct.ComputeUnit.ALL,
            "cpu": ct.ComputeUnit.CPU_ONLY}[args.units]
    row = {"label": args.label or os.path.basename(os.path.abspath(args.models)), "units": args.units}
    for name in NAMES:
        start = time.time()
        model = ct.models.MLModel(os.path.join(args.models, name + ".mlpackage"), compute_units=unit)
        load = time.time() - start
        x = inputs(name)
        for _ in range(3):
            model.predict(x)
        times = []
        for _ in range(args.runs):
            start = time.perf_counter()
            model.predict(x)
            times.append(time.perf_counter() - start)
        size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in
                   os.walk(os.path.join(args.models, name + ".mlpackage")) for f in fs)
        row[name] = {"median_ms": round(1000 * float(np.median(times)), 2),
                     "p95_ms": round(1000 * float(np.percentile(times, 95)), 2), "min_ms": round(1000 * min(times), 2),
                     "load_s": round(load, 2), "mb": round(size / 1e6, 1),
                     "ops": devices(os.path.join(args.models, name + ".mlpackage"), unit)}
    row["frame_ms"] = round(row[NAMES[0]]["median_ms"] + row[NAMES[3]]["median_ms"], 2)
    row["chip"] = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True,
                                 text=True).stdout.strip() or platform.machine()
    row["load_avg"] = round(os.getloadavg()[0], 2)
    print(json.dumps(row), flush=True)
    if args.json:
        with open(args.json, "a") as f:
            f.write(json.dumps(row) + "\n")


if __name__ == "__main__":
    main()
