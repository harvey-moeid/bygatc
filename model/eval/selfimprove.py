"""
eval/selfimprove.py
=====================================================================
Does online adaptation help on unseen instruments WITHOUT damaging the one
that ships?

That conjunction is the whole test. A self-improving model that gets better at
SOL by getting worse at BTC has not improved; it has moved the error somewhere
nobody was looking. So both halves are measured, and the protected half is
measured with a procedure that is valid under continuous inspection -- because
"we checked BTC every night and it was fine" is only meaningful if checking
every night does not itself manufacture the reassurance.

THE SETUP

Four altcoins NOCTUA has never seen -- ETH, SOL, XRP, LTC -- are the ADAPT-ON
stream. BTC is PROTECTED: it is the deployed product, its calibration is
already good (BENCHMARK.md section 6), and it is exactly what a naive online
learner would sacrifice.

Episodes from all five assets are merged and replayed in strict chronological
order, so the adapted state at any point depends only on episodes that had
already settled. Two arms are scored on identical episodes:

  incumbent   the SHIPPED system -- model + serve/adaptive.py's causal
              volatility recalibration -- quoting the nominal alpha-quantile
  candidate   the same corrected sigma, quoting the ACI-adapted level

The incumbent's definition is the part most easily got wrong, and getting it
wrong flatters the result. Scored against the RAW model, ACI showed a 15.9%
pinball gain on BTC -- but adaptive.py is already deployed and already removes
most of the level bias ACI would otherwise be credited with. Both arms now
start from the same causally-corrected sigma, so the only thing separating
them is the level that gets quoted, which is the only thing ACI actually
changes.

Loss is the PINBALL LOSS at the nominal alpha -- the strictly proper score for
a quantile, and the one an option seller actually pays: it charges asymmetric
prices for a strike that is too near versus too far. It is normalised by the
episode's realized volatility, which is necessary rather than cosmetic: SOL's
excursions are several times BTC's, and an unnormalised pooled loss would be a
statement about which asset moved more.

WHAT THE E-VALUES CAN AND CANNOT SAY

The bet is on the loss DIFFERENCE, clipped to +/-1, not on each loss clipped
separately. The first version clipped the losses and clipped 68% of episodes,
because a pinball loss at alpha = 1% is dominated on a quiet night by the
(1-alpha) x distance term and runs to several times the realized vol. The
difference between two arms quoting the same alpha is small and well behaved,
and symmetric clipping of it can only shrink the evidence toward zero -- it
costs power, never validity. The realised clip rate is reported (0.6% and
0.1%).

THE RESULT: THE GUARD REFUSED THE CANDIDATE

  asset    n   prot   pinball_inc   pinball_cand    delta   covE_inc  covE_cand
    btc  529   YES       1.769836       1.661424   -6.13%      0.761      0.418
    eth  529             1.581596       1.716803   +8.55%      1.043      0.491
    ltc  529             1.597204       1.558380   -2.43%      1.359      0.402
    sol  529             1.533370       1.569080   +2.33%      0.646      0.563
    xrp  529             1.590439       1.704414   +7.17%      0.570      0.718

  e(candidate better, adapt-on) = 9.75e-186        promote at 100
  e(candidate WORSE on btc)     = 1.40e-69         veto at 10
  PROMOTABLE: False

ACI does exactly what it promises and it is not enough. Coverage error falls on
every asset without exception -- that is the O(1/T) guarantee arriving on
schedule. But on the PROPER score it loses on three of the four instruments it
was adapting on, and the pooled e-value settles at 1e-185: the candidate is not
better, by a margin that leaves nothing to argue about.

The reason is the one BENCHMARK.md section 0 already established and this
result independently re-derives: COVERAGE IS NOT SKILL. Against an incumbent
whose calibration is already good, driving the empirical breach rate exactly to
nominal costs more in sharpness than it recovers in calibration, and pinball
charges for both. An arm that won on coverage error alone would have looked
like a clear improvement -- 0.761 -> 0.418 pp on BTC is a 45% reduction -- and
would have been shipped by anyone grading on the cheatable metric.

So the guard's first real job was to refuse a candidate its own author had
built and wanted, and it did. Note also that the veto never fired: BTC, the
protected asset, IMPROVED by 6.13%. The refusal came from the promotion side,
which is the correct division of labour -- "not harmful" is not a reason to
ship something that is not better.

An earlier version of this run reported PROMOTABLE: True while the live
e-value stood at 9.75e-186, because the gate tested whether the process had
EVER crossed its threshold rather than whether it stands past it now. One early
spike had unlocked promotion permanently. Fixed in EProcess.crossed, where the
two readings are now distinct and the asymmetry is deliberate: veto ratchets,
promotion does not.

    python -m model.eval.selfimprove
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from noctua.features import build_features                          # noqa: E402
from serve.runtime import load_model                                # noqa: E402
from serve.selfimprove import GAMMA, Guarded                        # noqa: E402

from .cross_asset import ASSET_DIR, H, production_anchors, realized  # noqa: E402

ALPHAS = (0.01, 0.02, 0.05, 0.10, 0.20)
PROTECT = ("btc",)


def pinball(level: np.ndarray, y: np.ndarray, alpha: float) -> np.ndarray:
    """Pinball loss for an UPPER quantile at exceedance probability alpha.

    The quoted level is the (1-alpha) quantile of the excursion, so a breach
    (y > level) is the alpha-weighted side and a quiet night is the (1-alpha)
    side. Strictly proper: it is minimised in expectation only by the true
    quantile, so an arm cannot win it by being timid.
    """
    d = y - level
    return np.where(d >= 0, alpha * d, (alpha - 1.0) * d)


def asset_stream(model, path: Path) -> pd.DataFrame | None:
    """Per-episode predictions and outcomes for one asset, chronological."""
    hours = pd.read_parquet(path)
    rows = production_anchors(hours)
    if len(rows) < 60:
        return None
    ts = hours["hour_ts"].to_numpy(np.int64)
    dt = pd.to_datetime(ts[rows], unit="s", utc=True)
    ep = pd.DataFrame({"anchor_ts": ts[rows], "H": H, "row": rows, "dt": dt,
                       "anchor_hour": dt.hour, "dow": dt.dayofweek})
    X = build_features(hours, ep)
    ok = np.isfinite(X.to_numpy()).all(1)
    X, rows, ep = X[ok], rows[ok], ep[ok]
    if len(rows) < 60:
        return None

    pred = model.predict(model.prepare(X, ep.H.to_numpy(np.float64)))
    truth = realized(hours, rows)
    rv = np.maximum(truth["RV"], 1e-12)

    # THE INCUMBENT IS THE SHIPPED SYSTEM, NOT THE RAW MODEL.
    #
    # serve/adaptive.py already applies a causal volatility recalibration, and
    # it is already deployed. Scoring ACI against the uncorrected model would
    # credit ACI with the correction adaptive.py is doing anyway -- a strawman
    # baseline, and one that would have shown a large and largely fake gain.
    # Both arms therefore start from the same causally-corrected sigma, and the
    # only difference between them is the LEVEL that gets quoted.
    #
    # Same estimator as eval/cross_asset.py: median of the settled ratio over
    # a trailing 60 days, minimum 20 episodes, clipped to [0.70, 1.40].
    sig0 = np.asarray(pred["sigma_med"], dtype=np.float64)
    ratio = truth["RV"] / np.maximum(sig0, 1e-12)
    at = ep.anchor_ts.to_numpy()
    c = np.ones(len(rows))
    for i in range(len(rows)):
        prior = (at + H * 3600 <= at[i]) & (at >= at[i] - 60 * 86400)
        if prior.sum() >= 20:
            c[i] = float(np.clip(np.median(ratio[prior]), 0.70, 1.40))
    pred = {k: v for k, v in pred.items() if not k.startswith("_pooled_")}
    pred["sigma_atoms"] = pred["sigma_atoms"] * c[:, None]
    pred["sigma_med"] = pred["sigma_med"] * c

    out = {"anchor_ts": ep.anchor_ts.to_numpy(), "rv": rv,
           "M_up": truth["M_up"], "M_dn": truth["M_dn"]}
    # Pre-compute the quoted level on a grid of alphas so the replay loop does
    # no model work: ACI only ever asks for a level between two grid points.
    grid = np.unique(np.concatenate([np.geomspace(0.002, 0.60, 60), ALPHAS]))
    for side in ("up", "dn"):
        out[f"lv_{side}"] = np.stack(
            [model.safe_level(pred, float(g), side == "up") for g in grid], axis=1)
    out["_grid"] = grid
    return out


def replay(streams: dict, gamma: float, alphas=ALPHAS) -> dict:
    """Chronological replay of every asset's episodes through the guard."""
    adapt = [a for a in streams if a not in PROTECT]
    g = Guarded(targets=list(alphas), adapt_on=adapt,
                protect=[a for a in PROTECT if a in streams], gamma=gamma)

    order = []
    for a, s in streams.items():
        for i, t in enumerate(s["anchor_ts"]):
            order.append((int(t), a, i))
    order.sort()

    acc = {a: {al: {"inc": [], "cand": [], "br_inc": 0, "br_cand": 0, "n": 0}
               for al in alphas} for a in streams}
    for _, a, i in order:
        s = streams[a]
        grid, rv = s["_grid"], s["rv"][i]
        for al in alphas:
            for side in ("up", "dn"):
                lv = s[f"lv_{side}"][i]
                y = s["M_up"][i] if side == "up" else s["M_dn"][i]
                inc = float(np.interp(al, grid, lv))
                a_t = g.level(a, al)
                cand = float(np.interp(a_t, grid, lv))

                l_inc = float(pinball(np.array(inc), np.array(y), al)) / rv
                l_cand = float(pinball(np.array(cand), np.array(y), al)) / rv
                # ACI is driven by the CANDIDATE's own breaches -- it must
                # learn from the level it actually quoted, not from a level it
                # did not use. Only the up side drives the update, so one
                # episode contributes one observation per alpha rather than
                # two correlated ones.
                if side == "up":
                    g.observe(a, al, bool(y > cand), l_inc, l_cand)
                d = acc[a][al]
                d["inc"].append(l_inc)
                d["cand"].append(l_cand)
                d["br_inc"] += int(y > inc)
                d["br_cand"] += int(y > cand)
                d["n"] += 1
    return {"guard": g, "acc": acc, "n_episodes": len(order)}


def table(res: dict, alphas=ALPHAS) -> pd.DataFrame:
    rows = []
    for a, per in res["acc"].items():
        pin_i = np.mean([np.mean(per[al]["inc"]) for al in alphas])
        pin_c = np.mean([np.mean(per[al]["cand"]) for al in alphas])
        ce_i = np.mean([abs(per[al]["br_inc"] / per[al]["n"] - al) for al in alphas])
        ce_c = np.mean([abs(per[al]["br_cand"] / per[al]["n"] - al) for al in alphas])
        rows.append({"asset": a, "n": per[alphas[0]]["n"] // 2,
                     "protected": a in PROTECT,
                     "pinball_inc": pin_i, "pinball_cand": pin_c,
                     "pinball_delta_pct": 100 * (pin_c / pin_i - 1),
                     "cov_err_inc_pp": 100 * ce_i, "cov_err_cand_pp": 100 * ce_c})
    return pd.DataFrame(rows).sort_values(["protected", "asset"],
                                          ascending=[False, True])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Guarded self-improvement")
    ap.add_argument("--assets", type=Path, default=ASSET_DIR)
    ap.add_argument("--gamma", type=float, default=GAMMA)
    ap.add_argument("--out", type=Path,
                    default=Path("model/artifacts/selfimprove.json"))
    a = ap.parse_args(argv)

    model = load_model()
    bundles = sorted(a.assets.glob("*_history.parquet"))
    if not bundles:
        print(f"no bundles in {a.assets} -- run the harvest workflow first")
        return 1

    streams = {}
    for b in bundles:
        name = b.stem.replace("_history", "")
        s = asset_stream(model, b)
        if s is not None:
            streams[name] = s
            print(f"  {name}: {len(s['anchor_ts'])} episodes")
    if not any(p in streams for p in PROTECT):
        print(f"protected asset {PROTECT} not among {list(streams)} -- refusing "
              "to measure adaptation with nothing to protect")
        return 1

    res = replay(streams, a.gamma)
    df = table(res)
    st = res["guard"].status()

    print(f"\nchronological replay of {res['n_episodes']} episodes, "
          f"gamma={a.gamma}\n")
    print(f"{'asset':>6} {'n':>5} {'prot':>5} {'pinball_inc':>12} "
          f"{'pinball_cand':>13} {'delta':>8} {'covE_inc':>9} {'covE_cand':>10}")
    for _, r in df.iterrows():
        print(f"{r.asset:>6} {int(r.n):5d} {'YES' if r.protected else '':>5} "
              f"{r.pinball_inc:12.6f} {r.pinball_cand:13.6f} "
              f"{r.pinball_delta_pct:+7.2f}% {r.cov_err_inc_pp:9.3f} "
              f"{r.cov_err_cand_pp:10.3f}")

    print(f"\n  e(candidate better, adapt-on): {st['e_win']:.4g} "
          f"(peak {st['e_win_peak']:.4g}, promote at {st['e_win_threshold']:.0f})")
    for k, v in st["e_harm"].items():
        print(f"  e(candidate WORSE, {k}):        {v:.4g} "
              f"(veto at {st['e_harm_threshold']:.0f})")
    print(f"\n  clip rate on the loss difference: win "
          f"{100*st['clip_rate_win']:.3f}%, harm "
          + ", ".join(f"{k} {100*v:.3f}%" for k, v in st['clip_rate_harm'].items()))
    print(f"  vetoed by: {st['vetoed_by'] or 'nothing'}")
    print(f"  PROMOTABLE: {st['promotable']}")

    a.out.write_text(json.dumps(
        {"gamma": a.gamma, "n_episodes": res["n_episodes"],
         "table": df.to_dict("records"), "guard": st},
        indent=2, default=float) + "\n")
    print(f"\nwritten -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
