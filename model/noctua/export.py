"""
noctua/export.py
=====================================================================
Stage 8: export the trained model to a dependency-free NumPy artifact.

The served model must run on a Hugging Face free Space (2 vCPU / 16 GB). A
PyTorch install is ~2 GB and dominates both the image size and the cold start,
for a network of 49,866 parameters. So the weights, the standardizers, the
Log-HAR ensemble coefficients and the calibration maps are all written to a
single .npz that `serve/runtime.py` reads with nothing but NumPy and SciPy.

    python -m noctua.export --model model/artifacts/noctua.pt \
                            --out model/serve/noctua_weights.npz
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch

from .model import BASE_COLS, LEVELS, SHAPE_COLS


def export(model_path: Path, out: Path) -> dict:
    ck = torch.load(model_path, weights_only=False)
    sd = ck["state_dict"]

    arrays = {k: v.detach().numpy().astype(np.float32) for k, v in sd.items()}
    arrays["levels"] = LEVELS.astype(np.float64)
    for name, key in (("std_all", "std_all"), ("std_shape", "std_shape"), ("std_base", "std_base")):
        mu, sdv = ck[key]
        arrays[f"{name}_mu"] = np.asarray(mu, dtype=np.float64)
        arrays[f"{name}_sd"] = np.asarray(sdv, dtype=np.float64)
    arrays["har_beta"] = np.asarray(ck["har_beta"], dtype=np.float64)

    cal = ck.get("calibration", {})
    for side in ("up", "dn", "ret"):
        if side in cal:
            arrays[f"cal_{side}_grid"] = np.asarray(cal[side]["grid"], dtype=np.float64)
            arrays[f"cal_{side}_map"] = np.asarray(cal[side]["map"], dtype=np.float64)

    meta = {
        "feat_cols": ck["feat_cols"],
        "base_cols": BASE_COLS,
        "shape_cols": SHAPE_COLS,
        "hidden": ck["hidden"],
        "blend_w": float(ck.get("blend_w", 0.25)),
        "cal_shrink": float(cal.get("shrink", 0.5)),
        "n_params": int(sum(v.size for k, v in arrays.items() if k in sd)),
    }
    arrays["meta_json"] = np.frombuffer(json.dumps(meta).encode(), dtype=np.uint8)

    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out, **arrays)
    return {**meta, "artifact_kb": round(out.stat().st_size / 1024, 1)}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Export NOCTUA to NumPy")
    p.add_argument("--model", type=Path, default=Path("model/artifacts/noctua.pt"))
    p.add_argument("--out", type=Path, default=Path("model/serve/noctua_weights.npz"))
    a = p.parse_args(argv)
    print(json.dumps(export(a.model, a.out), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
