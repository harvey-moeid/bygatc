#!/usr/bin/env python3
"""Regression tests for the temporal evaluation contract."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from noctua import splits  # noqa: E402
from noctua.calibrate import NoctuaCalibration, select_shrinkage  # noqa: E402
from noctua.spec import LEVELS  # noqa: E402


def synthetic_pred(n: int = 80, atoms: int = 4) -> dict:
    # Structurally valid predictive object for the calibration layer.
    base = np.asarray(LEVELS, dtype=float)
    q = np.tile(base, (n, atoms, 1))
    sigma = np.ones((n, atoms), dtype=float)
    return {
        "sigma_atoms": sigma,
        "q_r": q,
        "q_up": q + 0.5,
        "q_dn": q + 0.5,
    }


class EvaluationProtocolTests(unittest.TestCase):
    def test_time_splits_are_disjoint_and_embargoed(self):
        ts = pd.date_range("2022-01-01", "2025-12-31", freq="h", tz="UTC")
        ep = pd.DataFrame({
            "dt": ts,
            "anchor_ts": (ts.view("int64") // 10**9),
            "H": np.full(len(ts), 24, dtype=int),
        })
        masks = splits.time_splits(ep, train_end="2024-01-01",
                                    calib_end="2025-01-01", embargo_hours=24)
        self.assertFalse(np.any(masks["train"] & masks["calib"]))
        self.assertFalse(np.any(masks["calib"] & masks["test"]))
        self.assertFalse(np.any(masks["train"] & masks["test"]))

        # The latest training window must finish at least one full embargo
        # before the train/calibration boundary.
        train_end = ep.loc[masks["train"], "anchor_ts"].to_numpy() + 24 * 3600
        boundary = pd.Timestamp("2024-01-01", tz="UTC").timestamp()
        self.assertLessEqual(train_end.max(), boundary - 24 * 3600)

    def test_calibration_selector_uses_only_declared_candidates(self):
        rng = np.random.default_rng(7)
        n_fit, n_sel = 100, 100
        p_fit = synthetic_pred(n_fit)
        p_sel = synthetic_pred(n_sel)
        # Keep the observed excursions finite and positive.
        fit_up = np.abs(rng.normal(0.8, 0.15, n_fit))
        fit_dn = np.abs(rng.normal(0.8, 0.15, n_fit))
        sel_up = np.abs(rng.normal(0.8, 0.15, n_sel))
        sel_dn = np.abs(rng.normal(0.8, 0.15, n_sel))
        fit_r = rng.normal(0, 0.5, n_fit)

        chosen, scores = select_shrinkage(
            p_fit, fit_up, fit_dn, fit_r,
            p_sel, sel_up, sel_dn,
            candidates=(0.0, 0.5, 1.0),
        )
        self.assertIn(chosen, (0.0, 0.5, 1.0))
        self.assertEqual(set(scores), {"0.0", "0.5", "1.0"})
        self.assertTrue(all(np.isfinite(v) for v in scores.values()))

    def test_shrinkage_is_not_part_of_pit_fit(self):
        pred = synthetic_pred(80)
        rng = np.random.default_rng(3)
        up = np.abs(rng.normal(0.8, 0.1, 80))
        dn = np.abs(rng.normal(0.8, 0.1, 80))
        ret = rng.normal(0, 0.4, 80)

        a = NoctuaCalibration(shrink=0.0).fit(pred, up, dn, ret)
        b = NoctuaCalibration(shrink=1.0).fit(pred, up, dn, ret)
        # Shrinkage changes application, not the fitted PIT map.
        np.testing.assert_allclose(a.up.map, b.up.map)
        np.testing.assert_allclose(a.dn.map, b.dn.map)
        np.testing.assert_allclose(a.ret.map, b.ret.map)


if __name__ == "__main__":
    unittest.main()
