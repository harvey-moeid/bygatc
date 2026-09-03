"""
tests/test_selfimprove.py
=====================================================================
Gate the online-adaptation guard.

Everything here is a property with a KNOWN right answer -- a coverage
guarantee, a probability bound, a sign -- rather than a snapshot of numbers
this code happened to produce. A regression in any of them would be silent:
the system would keep emitting forecasts and keep reporting that it was safe.

The promotion-gate check in particular exists because that exact bug shipped
once already. The gate asked whether the e-process had EVER crossed its
threshold, so a single early spike unlocked promotion permanently, and the
first real run reported PROMOTABLE: True while the live e-value stood at
9.75e-186 -- a candidate refuted by 185 orders of magnitude.

    python model/tests/test_selfimprove.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from serve.selfimprove import ACI, EProcess, Guarded  # noqa: E402

FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  ' + detail if detail else ''}")
    if not ok:
        FAILURES.append(name)


def _norm_ppf(p: float) -> float:
    """Inverse standard normal, Acklam's rational approximation.

    Hand-rolled so this file stays NumPy-only, like the module it tests.
    Accurate to ~1e-9 over the range used here, which is far tighter than the
    Monte-Carlo error of the checks below.
    """
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    pl, ph = 0.02425, 1 - 0.02425
    if p < pl:
        q = np.sqrt(-2 * np.log(p))
        return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / \
               ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    if p > ph:
        q = np.sqrt(-2 * np.log(1 - p))
        return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / \
                ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    q, r = p - 0.5, (p - 0.5) ** 2
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / \
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)


def test_aci_closed_loop() -> None:
    """ACI must drive the REALISED breach rate to target under misspecification.

    Closed loop, which is the only version that tests anything: the breach
    depends on the level actually quoted. An open-loop test -- breach
    probability fixed regardless of the level -- makes the update a driftless
    random walk and would pass for a broken implementation.

    The world is Student-t(3); the model believes it is Gaussian. Right shape
    family, wrong tail: exactly the misspecification an unseen asset presents,
    and exactly what a fixed level cannot repair.
    """
    for target in (0.01, 0.05, 0.10):
        rng = np.random.default_rng(7)
        c = ACI(target)
        fixed = 0
        T = 6000
        thr_fixed = _norm_ppf(1 - target)
        for _ in range(T):
            x = rng.standard_t(3) / np.sqrt(3.0)         # unit variance
            c.update(bool(x > _norm_ppf(1 - c.level())))
            fixed += int(x > thr_fixed)
        e_aci, e_fix = c.gap(), abs(fixed / T - target)
        check(f"ACI beats a fixed level at alpha={target}", e_aci < e_fix,
              f"err {e_aci:.4f} vs {e_fix:.4f}")

    # The step must scale with the target, or one breach moves a 1% level by 2%.
    check("ACI step scales with the target", ACI(0.01).step <= 0.01 / 2,
          f"step {ACI(0.01).step:.4f} at target 0.01")


def test_ville_bound() -> None:
    """Under the null the process must cross 1/alpha at most alpha of the time.

    This is the guarantee the whole veto rests on. If it does not hold, the
    'safe to promote' verdict means nothing.
    """
    for alpha, reps, T in ((0.01, 600, 300), (0.10, 600, 300)):
        hits = 0
        for r in range(reps):
            g = np.random.default_rng(1000 + r)
            p = EProcess()
            for _ in range(T):
                p.update(g.random(), g.random())        # exchangeable: null true
            hits += p.crossed(alpha)
        rate = hits / reps
        # Monte-Carlo slack: the bound is on the true rate, not this estimate.
        check(f"Ville bound holds at alpha={alpha}", rate <= alpha + 3 * np.sqrt(
            alpha * (1 - alpha) / reps), f"crossing rate {rate:.4f}")


def test_power() -> None:
    """A genuinely better candidate must actually be detected."""
    p = EProcess()
    g = np.random.default_rng(3)
    for _ in range(400):
        ref = g.random()
        p.update(ref, max(ref - 0.05, 0.0))
    check("detects a real 0.05/episode edge", p.crossed(0.01, ever=False),
          f"log10(E) = {p.log_e / np.log(10):.1f}")


def test_veto_and_gate() -> None:
    """The two asymmetries that make the guard a guard."""
    # Better where it adapts, WORSE on the protected asset -> must not promote.
    gd = Guarded(targets=[0.05], adapt_on=["sol"], protect=["btc"])
    g = np.random.default_rng(4)
    for _ in range(500):
        r = g.random()
        gd.observe("sol", 0.05, r < 0.05, r, max(r - 0.05, 0.0))
        r = g.random()
        gd.observe("btc", 0.05, r < 0.05, r, min(r + 0.05, 1.0))
    check("harm on a protected asset vetoes", gd.vetoed() == ["btc"])
    check("veto blocks promotion", not gd.promotable())

    # A spike that later collapses must NOT leave promotion unlocked. This is
    # the shipped bug, reproduced: peak far above threshold, current far below.
    p = EProcess()
    g = np.random.default_rng(5)
    for _ in range(60):
        ref = g.random()
        p.update(ref, max(ref - 0.4, 0.0))            # build a large peak
    peak_crossed = p.crossed(0.01)
    for _ in range(4000):
        ref = g.random()
        p.update(ref, min(ref + 0.4, 1.0))            # then lose, decisively
    check("an early spike does not permanently unlock promotion",
          peak_crossed and not p.crossed(0.01, ever=False),
          f"peak {np.exp(p.peak):.3g}, now {p.e:.3g}")
    check("but the veto still ratchets on the supremum", p.crossed(0.01))


def test_causality() -> None:
    """The quoted level must never depend on the episode it is quoting for."""
    c = ACI(0.05)
    lv = c.level()
    c.update(True)
    check("level() is available before any update", np.isfinite(lv))
    check("an update changes the level only AFTERWARDS", c.level() != lv)


def main() -> int:
    print("selfimprove self-test\n")
    for fn in (test_aci_closed_loop, test_ville_bound, test_power,
               test_veto_and_gate, test_causality):
        print(f"{fn.__name__}:")
        fn()
    if FAILURES:
        print(f"\n{len(FAILURES)} FAILED: {FAILURES}")
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
