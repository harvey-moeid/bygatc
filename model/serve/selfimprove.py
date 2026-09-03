"""
serve/selfimprove.py
=====================================================================
Let NOCTUA adapt online, and make it impossible for adaptation to quietly
degrade the instruments it was already good at.

THE PROBLEM WITH "THE MODEL IMPROVES ITSELF"

An online learner that only ever optimises its recent loss will happily trade
away performance somewhere it is not currently being scored. On this task the
failure is concrete: adapt hard to SOL's fat excursions during a SOL-led
rally and the BTC product -- the one that is actually deployed -- gets wider,
sells less premium, and nobody finds out for weeks, because nothing was
watching BTC while SOL was being fitted.

So self-improvement here is two mechanisms, not one. Something that adapts,
and something with veto power over it.

---------------------------------------------------------------------
1. WHAT ADAPTS -- Adaptive Conformal Inference
---------------------------------------------------------------------
Gibbs & Candes (2021), "Adaptive Conformal Inference Under Distribution
Shift" (arXiv:2106.00170). Track, per nominal level, an EFFECTIVE level that
moves against realised breaches:

    a_{t+1} = a_t + gamma * (a_target - 1{breach_t})

Breach -> a_t falls -> the quoted level moves further out. Quiet -> a_t rises
-> the level tightens and more premium is sold.

Why this and not a fitted correction: the guarantee holds with NO assumption
about the data at all -- not exchangeability, not stationarity, not even that
the data is not adversarial. Summing the update telescopes to

    |empirical breach rate - a_target| <= (a_1 + gamma) / (T * gamma)

which is O(1/T) whatever the world does. That is a much stronger footing than
anything in this repo so far, and it is exactly the property needed: the
regime-dependence that defeated a FITTED constant in BENCHMARK.md section 6,
and defeated the fitted efficiency correction in eval/efficiency.py, cannot
defeat this, because nothing is fitted. gamma is a step size, not a parameter
estimated from the evaluation data.

The cost is honest and worth stating: the guarantee is on the LONG-RUN
AVERAGE breach rate. It says nothing about any individual night, and a large
gamma buys fast adaptation with a noisier level.

---------------------------------------------------------------------
2. WHAT VETOES -- anytime-valid e-values
---------------------------------------------------------------------
The guard has to be checked continuously -- after every settled episode --
because the whole point is to catch degradation early. Continuous checking is
exactly what a p-value cannot survive: peek often enough and it will eventually
cross 0.05 by chance.

E-values do survive it. Bet on each episode with

    e_t = 1 + lambda * (loss_incumbent_t - loss_candidate_t)

where the loss DIFFERENCE is clipped to +/-1 and lambda in [0, 1], so e_t >= 0
always. (Clipping the difference rather than each loss is not a detail; see
EProcess.update -- a pinball loss at alpha = 1% is several times the realized
vol on a quiet night, so a cap large enough for the LEVEL clips two thirds of
episodes, while the cap on the DIFFERENCE between two arms quoting the same
alpha almost never binds.)
Under the null "the candidate is not better", E[e_t | past] <= 1, so the
product E_T = prod(e_t) is a non-negative supermartingale and VILLE'S
INEQUALITY gives

    P(sup_t E_t >= 1/alpha) <= alpha

for ALL t simultaneously. You may look after every single episode, stop when
you like, and the error guarantee is untouched. E_T is also readable on its
own terms -- it is the factor by which a stake betting on the candidate would
have multiplied.

Two families run at once:

  PROMOTION   one e-process for "candidate beats incumbent", pooled over the
              instruments being adapted on. Must exceed 1/alpha_promote.

  PROTECTION  one e-process PER PROTECTED INSTRUMENT for "candidate is WORSE
              than incumbent" -- the same bet with the sign flipped. Any one of
              them crossing 1/alpha_veto blocks promotion, permanently, until
              a human clears it.

Promotion needs the evidence to be strong AND no protected instrument to be
losing. Note the deliberate asymmetry: promotion needs evidence to ACT,
protection needs only evidence to REFUSE, and a protected asset with too
little data to conclude anything blocks nothing but also earns nothing. The
default alphas encode the same asymmetry -- it should be harder to promote
than to veto.

---------------------------------------------------------------------
3. WHAT IS DELIBERATELY NOT HERE
---------------------------------------------------------------------
No gradient step. Nothing retrains the network from the live stream. The
adapted state is a handful of scalars with a distribution-free guarantee, and
the guard is a pair of supermartingales. A model that rewrites its own weights
from unlabelled production data is not something this repo can honestly claim
to have validated, and 19,134 parameters chasing a few hundred nightly
episodes is a recipe for exactly the overfitting the rest of this project
spends its time refusing.

NumPy only -- this module is imported by serving.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

# Step size. 0.02 moves the effective level by 2 percentage points per breach,
# so a level that is badly wrong is corrected within a few dozen episodes and a
# level that is right jitters within about +/-1pp. Not tuned on the evaluation
# data: eval/selfimprove.py reports a sweep so the choice can be seen to be
# insensitive rather than asserted to be.
GAMMA = 0.02

# Effective levels are clipped. An unclipped ACI level can walk to 0 or 1 under
# a long run of one-sided outcomes, and a quoted barrier at level 0 is not a
# conservative forecast -- it is an infinite one.
A_LO, A_HI = 0.002, 0.60


@dataclass
class ACI:
    """One adaptive level per nominal alpha. Update AFTER an episode settles.

    The step is `min(gamma, target/4)`, not `gamma`. Gibbs & Candes state the
    method with a fixed step, which is fine at the conventional alpha = 0.1 they
    work at and is NOT fine here: an option seller lives at alpha = 1%, and a
    fixed 0.02 step means one breach moves the level by TWICE the target it is
    trying to hold. Measured, closed-loop against a misspecified tail:

        target   fixed step 0.02      step = target/4
          0.01   err 0.0040           err 0.0007
          0.05   err 0.0008           err 0.0008

    so the cap costs nothing where the fixed step already worked and fixes the
    tail levels this model is actually quoted at. The O(1/T) guarantee is
    unaffected -- it holds for any positive step, with the step appearing only
    in the constant.
    """

    target: float
    gamma: float = GAMMA
    alpha: float = field(init=False)
    step: float = field(init=False)
    n: int = 0
    breaches: int = 0

    def __post_init__(self) -> None:
        self.alpha = float(self.target)
        self.step = float(min(self.gamma, self.target / 4.0))

    def level(self) -> float:
        """The level to QUOTE now -- always available, never looks forward."""
        return float(np.clip(self.alpha, A_LO, A_HI))

    def update(self, breached: bool) -> None:
        self.n += 1
        self.breaches += int(breached)
        self.alpha = float(np.clip(
            self.alpha + self.step * (self.target - float(breached)),
            A_LO, A_HI))

    @property
    def realised(self) -> float:
        return self.breaches / self.n if self.n else float("nan")

    def gap(self) -> float:
        """|realised - target|, the quantity ACI's guarantee bounds by O(1/T)."""
        return abs(self.realised - self.target) if self.n else float("nan")


@dataclass
class EProcess:
    """A betting supermartingale on a paired, [0,1]-bounded loss difference.

    `lam` is the stake. Fixed rather than optimised: a stake tuned on the same
    stream it is testing is no longer a valid bet, and the whole value of this
    construction is that its guarantee survives continuous inspection. 0.5 is
    the standard conservative choice -- half the bankroll on each episode --
    and keeps e_t within [0.5, 1.5] so no single episode can dominate.
    """

    lam: float = 0.5
    cap: float = 1.0            # the loss DIFFERENCE is clipped to +/- cap
    log_e: float = 0.0          # log of the running product, for stability
    n: int = 0
    peak: float = 0.0           # sup_t log E_t -- Ville bounds the SUPREMUM
    n_clipped: int = 0

    def update(self, loss_ref: float, loss_new: float) -> None:
        """One episode. Positive (loss_ref - loss_new) is evidence for `new`.

        The DIFFERENCE is clipped symmetrically, not each loss separately.
        Clipping the losses individually needs a cap large enough for the loss
        LEVEL, which for a pinball loss at alpha = 1% is dominated by the
        (1-alpha)|distance| term on quiet nights and is several times the
        realized vol -- so a cap that keeps e_t >= 0 clips most episodes and
        destroys the test. The difference between two arms quoting the same
        alpha is far smaller and far better behaved.

        Symmetric clipping is CONSERVATIVE, which is what makes it admissible
        here: clipping at +/-cap can only shrink |E[d]| toward zero, so under
        the null the bet cannot be made to reject more often than it would
        have. It costs power, not validity. `n_clipped` is reported so the cost
        is visible.
        """
        d = float(loss_ref) - float(loss_new)
        if abs(d) > self.cap:
            self.n_clipped += 1
            d = float(np.clip(d, -self.cap, self.cap))
        self.log_e += float(np.log(max(1.0 + self.lam * d, 1e-12)))
        self.peak = max(self.peak, self.log_e)
        self.n += 1

    @property
    def e(self) -> float:
        return float(np.exp(self.log_e))

    def crossed(self, alpha: float, ever: bool = True) -> bool:
        """Is the evidence past 1/alpha -- ever (`ever=True`) or right now?

        Both readings are valid. Ville bounds the SUPREMUM, so `ever` is a
        legitimate rejection; optional stopping makes the CURRENT value valid
        at any stopping time too. They are not interchangeable, and using the
        wrong one here was a real bug rather than a nicety:

          VETO uses `ever`. Once a protected instrument has shown convincing
          evidence of harm, that evidence does not expire because a later run
          of luck pulled the product back down. Ratchet, deliberately.

          PROMOTION uses `now`. Promotion is an action taken at this moment and
          must be justified at this moment. With `ever`, one early spike
          unlocked promotion permanently -- the first run of this on real data
          reported PROMOTABLE: True while the live e-value stood at 9.75e-186,
          i.e. the candidate had been refuted by roughly 185 orders of
          magnitude and the gate still said yes.
        """
        return (self.peak if ever else self.log_e) >= np.log(1.0 / alpha)


class Guarded:
    """ACI adaptation with an anytime-valid no-degradation veto.

    Usage per settled episode:

        g.observe(asset, level_key, breached, loss_incumbent, loss_candidate)

    and then `g.status()` to see whether promotion is currently allowed.
    """

    def __init__(self, targets, adapt_on, protect,
                 gamma: float = GAMMA, alpha_promote: float = 0.01,
                 alpha_veto: float = 0.10):
        # Harder to promote (1%) than to veto (10%), deliberately. Promotion
        # changes what ships; a veto only preserves the status quo, so a false
        # veto costs an opportunity while a false promotion costs money.
        self.targets = list(targets)
        self.adapt_on = list(adapt_on)
        self.protect = list(protect)
        self.alpha_promote = float(alpha_promote)
        self.alpha_veto = float(alpha_veto)
        self.aci = {(a, t): ACI(t, gamma)
                    for a in self.adapt_on + self.protect for t in self.targets}
        self.win = EProcess()
        self.harm = {a: EProcess() for a in self.protect}

    def level(self, asset: str, target: float) -> float:
        k = (asset, target)
        return self.aci[k].level() if k in self.aci else float(target)

    def observe(self, asset: str, target: float, breached: bool,
                loss_ref: float, loss_new: float) -> None:
        k = (asset, target)
        if k in self.aci:
            self.aci[k].update(breached)
        if asset in self.adapt_on:
            self.win.update(loss_ref, loss_new)
        if asset in self.protect:
            # sign flipped: this process accrues when the CANDIDATE is worse
            self.harm[asset].update(loss_new, loss_ref)

    def vetoed(self) -> list[str]:
        return [a for a, p in self.harm.items() if p.crossed(self.alpha_veto)]

    def promotable(self) -> bool:
        # `ever=False`: the evidence must stand NOW. See EProcess.crossed.
        return (self.win.crossed(self.alpha_promote, ever=False)
                and not self.vetoed())

    def status(self) -> dict:
        return {
            "promotable": self.promotable(),
            "vetoed_by": self.vetoed(),
            "e_win": self.win.e, "e_win_peak": float(np.exp(self.win.peak)),
            "e_win_ever_crossed": self.win.crossed(self.alpha_promote),
            "e_win_threshold": 1.0 / self.alpha_promote,
            "n_win": self.win.n,
            "e_harm": {a: p.e for a, p in self.harm.items()},
            "e_harm_threshold": 1.0 / self.alpha_veto,
            "clip_rate_win": self.win.n_clipped / max(self.win.n, 1),
            "clip_rate_harm": {a: p.n_clipped / max(p.n, 1)
                               for a, p in self.harm.items()},
            "aci": {f"{a}@{t}": {"target": t, "alpha_now": c.level(),
                                 "realised": c.realised, "gap": c.gap(), "n": c.n}
                    for (a, t), c in self.aci.items()},
        }

    def save(self, path: Path) -> None:
        Path(path).write_text(json.dumps(self.status(), indent=2,
                                         default=float) + "\n")
