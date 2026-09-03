#!/usr/bin/env python3
"""
model/tests/test_adaptive.py
=====================================================================
Self-test for the causal volatility recalibration.

The property that actually matters here is CAUSALITY. This correction is only
defensible because it can see nothing but already-settled episodes; if that
guarantee slips, the model starts grading itself on the answer sheet and every
calibration number downstream becomes fiction. A look-ahead leak would also be
silent -- the forecasts would simply look better than they are -- so it gets an
explicit test rather than a comment.

The second group of checks covers the failure modes that would make the
correction dangerous rather than merely wrong: an unbounded factor, a factor
fitted on a handful of episodes, or a correction that quietly reshapes the
predictive distribution instead of moving its level.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from serve.adaptive import (CLIP_HI, CLIP_LO, MIN_EPISODES, STRIDE_HOURS,  # noqa: E402
                            _settled_anchors, apply_correction,
                            volatility_correction)
from serve.history import load_bundle                                      # noqa: E402
from serve.runtime import load_model                                       # noqa: E402

FAILS: list[str] = []


def check(name: str, ok: bool, detail: str = ""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  -> ' + detail}")
    if not ok:
        FAILS.append(name)


def main() -> int:
    print("NOCTUA adaptive-calibration self-test\n")
    H = 19

    # ---- causality, tested directly on the row selector -------------------
    # Every returned row r must satisfy r + H <= anchor: the episode's whole
    # window has to have closed before the anchor it informs.
    worst = None
    for anchor in (2000, 5000, 9000, 9599):
        rows = _settled_anchors(pd_hours_len(anchor), anchor, H, 60, STRIDE_HOURS)
        if len(rows) == 0:
            continue
        margin = int(anchor - (rows.max() + H))
        worst = margin if worst is None else min(worst, margin)
        check(f"no unsettled episode used (anchor={anchor})", margin >= 0,
              f"latest episode ends {-margin}h AFTER the anchor")
    check("causality margin is non-negative at every anchor tested",
          worst is not None and worst >= 0, str(worst))

    rows = _settled_anchors(None, 5000, H, 60, STRIDE_HOURS)
    check("window is bounded to the requested horizon",
          bool(len(rows) and (5000 - rows.min()) <= 60 * 24 + H + STRIDE_HOURS),
          f"reaches back {5000 - int(rows.min())}h")
    check("anchors are subsampled, not one-per-hour",
          bool(len(rows) > 1 and np.diff(rows).min() >= STRIDE_HOURS))

    # ---- the real thing, on the committed bundle --------------------------
    model = load_model()
    hours = load_bundle()
    row = len(hours) - 1
    cal = volatility_correction(model, hours, row, H, verbose=False)
    print(f"\n  (factor {cal['factor']:.4f} from {cal['n_episodes']} settled episodes)")

    check("correction was applied", bool(cal["applied"]), cal["reason"])
    check("factor is finite and positive",
          bool(np.isfinite(cal["factor"]) and cal["factor"] > 0), str(cal["factor"]))
    check("factor is inside the sanity band",
          CLIP_LO <= cal["factor"] <= CLIP_HI, str(cal["factor"]))
    check("enough settled episodes to estimate a median",
          cal["n_episodes"] >= MIN_EPISODES, str(cal["n_episodes"]))

    # a short history must REFUSE to correct rather than guess from noise
    early = volatility_correction(model, hours, 24 * 31, H)
    check("insufficient history declines to correct, factor stays 1.0",
          (not early["applied"]) and early["factor"] == 1.0,
          f"applied={early['applied']} factor={early['factor']}")

    # ---- the correction moves LEVEL, not SHAPE ----------------------------
    rng = np.random.default_rng(0)
    n = 16
    d = {"Xa": rng.normal(0, 1, (n, len(model.feat_cols))),
         "Xb": rng.normal(0, 1, (n, len(model.base_cols))),
         "Xs": rng.normal(0, 1, (n, len(model.shape_cols))),
         "H": np.full(n, float(H))}
    pred = model.predict(d)
    lvl0 = model.safe_level(pred, 0.05, True).copy()
    _ = model.committee_quantiles(pred, True)          # force the memo to populate
    check("pooled curve is memoised before correction", "_pooled_up" in pred)

    f = 0.90
    p2 = apply_correction(pred, f)
    check("stale memo is dropped by the correction", "_pooled_up" not in p2)
    check("sigma scales by exactly the factor",
          bool(np.allclose(p2["sigma_med"], pred["sigma_med"] * f)))
    check("sigma atoms scale by exactly the factor",
          bool(np.allclose(p2["sigma_atoms"], pred["sigma_atoms"] * f)))

    lvl1 = model.safe_level(p2, 0.05, True)
    check("a downward correction tightens every strike", bool(np.all(lvl1 < lvl0)))
    # level, not shape: the ratio between two quantiles must be preserved
    r0 = model.safe_level(pred, 0.01, True) / lvl0
    r1 = model.safe_level(p2, 0.01, True) / lvl1
    check("quantile RATIOS are preserved (level moved, shape did not)",
          bool(np.abs(r1 / r0 - 1).max() < 0.02),
          f"max ratio drift {np.abs(r1/r0 - 1).max():.4f}")

    check("factor of exactly 1.0 is a no-op",
          apply_correction(pred, 1.0) is pred)

    print()
    if FAILS:
        print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
        return 1
    print("all checks passed")
    return 0


def pd_hours_len(_n):
    """_settled_anchors only reads scalars, so the frame itself is irrelevant."""
    return None


if __name__ == "__main__":
    sys.exit(main())
