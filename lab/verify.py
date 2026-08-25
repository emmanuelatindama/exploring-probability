"""Verify the Python analytics, then emit golden values for the JS engine.

Two jobs:

1. Self-check the closed forms in analytics.py against a large Monte Carlo run.
   Closed forms are easy to get subtly wrong; a simulation is dumb but honest.

2. Write js/golden.js -- the expected values that tests.html checks the browser
   engine against. There is no JS runtime on the dev machine, so the JS side of
   the port is verified by opening tests.html, not from this script.

Run:  python lab/verify.py
"""

import itertools
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analytics as A  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

FAILURES = []


def check(name, got, want, tol=1e-9, rel=False):
    """Compare and record, rather than assert, so one run reports everything.

    `rel` is explicit and never inferred from magnitude. Inferring it bit once:
    a probability of 8e-7 was auto-promoted to a relative comparison, giving a
    tolerance of ~1e-9 on a Monte Carlo estimate of an event that occurs less
    than once per million draws. Probabilities want absolute tolerance.
    """
    if math.isinf(want) or math.isinf(got):
        # St Petersburg's expectation is genuinely +inf, and abs(inf - inf) is
        # nan, so a tolerance test reports a false failure. Equality is the only
        # meaningful comparison once either side is infinite.
        ok = got == want
    elif rel:
        ok = abs(got - want) <= tol * max(abs(want), 1e-300)
    else:
        ok = abs(got - want) <= tol
    if not ok:
        FAILURES.append((name, got, want))
    print(f"  [{'ok  ' if ok else 'FAIL'}] {name}: got {got:.10g}, want {want:.10g}")
    return ok


# -- 1. closed forms vs Monte Carlo ------------------------------------------
def monte_carlo(w0, rounds, p, up, down, f, n=400_000, seed=1234):
    rng = np.random.default_rng(seed)
    mu, md = A.multipliers(up, down, f)
    draws = rng.random((n, rounds)) < p
    logs = np.where(draws, math.log(mu), math.log(md)).sum(axis=1)
    final = w0 * np.exp(logs)
    return final


def verify_closed_forms():
    print("\nClosed forms vs Monte Carlo (400k paths)")
    cases = [
        dict(w0=100.0, rounds=100, p=0.5, up=1.5, down=0.6, f=1.0),
        dict(w0=100.0, rounds=100, p=0.5, up=1.5, down=0.6, f=0.25),
        dict(w0=100.0, rounds=60, p=0.6, up=1.4, down=0.7, f=0.5),
    ]
    for c in cases:
        print(f"\n  case {c}")
        final = monte_carlo(**c)

        # Median is exact (W_T is monotone in the heads count), so it should match
        # the empirical median to within the discreteness of the binomial.
        check("median", float(np.median(final)), A.median_final(**c), tol=1e-6, rel=True)

        # P(below start) and P(below 1) are exact binomial tail probabilities;
        # sampling error at 400k paths is ~0.1pp.
        check("P(< start)", float((final < c["w0"]).mean()),
              A.prob_below(c["w0"], **c), tol=3e-3)
        check("P(< $1)", float((final < 1.0).mean()),
              A.prob_below(1.0, **c), tol=3e-3)

        # The mean of a heavy-tailed variable is badly estimated by sampling --
        # that is a fact about the game, not a bug -- so this one is checked
        # against the log-space identity instead of the sample mean.
        g_ens = A.ensemble_growth(c["p"], c["up"], c["down"], c["f"])
        mu, md = A.multipliers(c["up"], c["down"], c["f"])
        check("E[m] identity", 1 + g_ens, c["p"] * mu + (1 - c["p"]) * md)

        # Quantiles bracket the median.
        q05 = A.quantile_final(0.05, **c)
        q95 = A.quantile_final(0.95, **c)
        med = A.median_final(**c)
        assert q05 <= med <= q95, f"quantiles out of order: {q05} {med} {q95}"
        print(f"  [ok  ] quantile ordering: {q05:.6g} <= {med:.6g} <= {q95:.6g}")

        # SD, like the mean, is only checkable against a sample when the tail
        # is not too heavy -- f=1.0 here is the same heavy-tailed case the
        # mean is already excused from above, for the identical reason.
        if c["f"] < 1.0:
            check("SD[W_T]", float(final.std()), A.sd_final(**c), tol=2e-2, rel=True)
        else:
            print(f"  [skip] SD[W_T] vs sample: f=1.0 is heavy-tailed, "
                  f"same as E[W_T] above -- checked by identity instead")
        e2_identity = c["w0"] ** 2 * (c["p"] * mu ** 2 + (1 - c["p"]) * md ** 2) ** c["rounds"]
        check("Var[W_T] identity", A.variance_final(**c),
              e2_identity - A.expected_final(**c) ** 2)

        # -- the two multipliers and the AM-GM gap between them ---------------
        p, up, down, f = c["p"], c["up"], c["down"], c["f"]
        am = A.arithmetic_mean_multiplier(p, up, down, f)
        gm = A.geometric_mean_multiplier(p, up, down, f)
        check("E[m] = 1 + ensemble_growth", am, 1 + g_ens)
        # A bounded two-point variable, so its sample mean is a legitimate
        # check -- unlike E[W_T], which is a product of `rounds` of them.
        rng_m = np.random.default_rng(9001)
        draws = np.where(rng_m.random(2_000_000) < p, mu, md)
        check("E[m] vs one-round sample mean", float(draws.mean()), am, tol=2e-3)
        # ln m is thin-tailed too, so exp(mean of the log) is a fair estimate of
        # the geometric mean -- the whole reason the time average is estimable
        # when the ensemble average is not.
        check("G vs sample geometric mean", float(np.exp(np.log(draws).mean())),
              gm, tol=2e-3)
        check("ln G = time_growth", math.log(gm),
              A.time_growth(p, up, down, f), tol=1e-12)
        # AM-GM: the gap is non-negative, and zero only when the two
        # multipliers coincide.
        drag = A.volatility_drag(p, up, down, f)
        ok = drag >= 0.0 and abs(drag - (am - gm)) < 1e-15
        if not ok:
            FAILURES.append(("volatility drag = AM - GM >= 0", drag, am - gm))
        print(f"  [{'ok  ' if ok else 'FAIL'}] volatility drag (AM-GM gap): "
              f"{am:.6f} - {gm:.6f} = {drag:.6f}")

        # median_half_life: G^h must be exactly 1/2 when the typical path decays.
        h = A.median_half_life(p, up, down, f)
        if math.isfinite(h):
            check("G^half_life = 1/2", gm ** h, 0.5, tol=1e-12)
        else:
            ok = gm >= 1.0
            if not ok:
                FAILURES.append(("half-life inf only when G >= 1", gm, ">= 1"))
            print(f"  [{'ok  ' if ok else 'FAIL'}] half-life is +inf because "
                  f"G = {gm:.6f} >= 1 (nothing is decaying)")
        d = A.doubling_time(p, up, down, f)
        if math.isfinite(d):
            check("G^doubling_time = 2", gm ** d, 2.0, tol=1e-12)
        # The two are mutually exclusive: a path cannot both halve and double.
        ok = not (math.isfinite(h) and math.isfinite(d))
        if not ok:
            FAILURES.append(("half-life and doubling time both finite", h, d))
        print(f"  [{'ok  ' if ok else 'FAIL'}] half-life {h:.4g} / doubling "
              f"time {d:.4g} -- exactly one is finite")

        # break_even_heads against a brute-force integer search, and against
        # the exact tail probability prob_below already computes.
        T = c["rounds"]
        kstar = A.break_even_heads(T, p, up, down, f)
        if math.isfinite(kstar):
            k_int = math.ceil(kstar)
            hi = c["w0"] * mu ** k_int * md ** (T - k_int)
            lo = c["w0"] * mu ** (k_int - 1) * md ** (T - k_int + 1)
            ok = hi >= c["w0"] * (1 - 1e-12) and lo < c["w0"] * (1 + 1e-12)
            if not ok:
                FAILURES.append((f"break-even brute force k={k_int}", (lo, hi), c["w0"]))
            print(f"  [{'ok  ' if ok else 'FAIL'}] break-even needs {kstar:.4f} "
                  f"heads (ceil {k_int}); {k_int} heads -> ${hi:.2f}, "
                  f"{k_int - 1} -> ${lo:.2f}, start ${c['w0']:.2f}")
            check("P(k >= break-even) = 1 - P(W_T < w0)",
                  float(A.binom.sf(k_int - 1, T, p)),
                  1.0 - A.prob_below(c["w0"], **c), tol=1e-12)
            # And the Monte Carlo agrees the paths that clear it are the
            # paths that finished whole.
            check("MC P(finish >= start)", float((final >= c["w0"]).mean()),
                  float(A.binom.sf(k_int - 1, T, p)), tol=3e-3)
        s = A.summary(**c)
        check("expected_heads = rounds * p", s["expected_heads"], T * p)


def verify_kelly():
    """f* should be the argmax of time_growth -- check against a brute sweep."""
    print("\nKelly optimum vs brute-force sweep")
    for p, up, down in [(0.5, 1.5, 0.6), (0.6, 1.4, 0.7), (0.5, 2.0, 0.5),
                        (0.45, 1.8, 0.55)]:
        f_star = A.kelly_fraction(p, up, down)
        b = 1 - down
        grid = np.linspace(0, min(1.0, 1 / b) * 0.999, 200_001)
        g = np.array([A.time_growth(p, up, down, f) for f in grid])
        f_brute = grid[int(np.nanargmax(g))]
        # 1e-3 because the brute grid is discrete, and because f* can be clamped
        # to the 1/b ruin boundary, where the sweep's last usable point sits just
        # inside it.
        ok = abs(f_star - f_brute) < 1e-3
        if not ok:
            FAILURES.append((f"kelly p={p}", f_star, f_brute))
        print(f"  [{'ok  ' if ok else 'FAIL'}] p={p} up={up} down={down}: "
              f"closed form {f_star:.6f}, brute {f_brute:.6f}")

    # Negative-edge games: the right answer is "don't play".
    f = A.kelly_fraction(0.3, 1.5, 0.6)
    if f != 0.0:
        FAILURES.append(("kelly negative edge", f, 0.0))
    print(f"  [{'ok  ' if f == 0.0 else 'FAIL'}] negative edge -> f*={f} (expect 0)")

    # -- kelly_growth: the value at the argmax, against the same brute sweep --
    print("\nGrowth at f*, and the fraction where growth returns to zero")
    for p, up, down in [(0.5, 1.5, 0.6), (0.6, 1.4, 0.7), (0.5, 2.0, 0.5),
                        (0.55, 1.6, 0.65)]:
        b = 1 - down
        grid = np.linspace(0, min(1.0, 1 / b) * 0.999, 200_001)
        g = np.array([A.time_growth(p, up, down, x) for x in grid])
        # An inequality, not an equality: the brute grid can only *under*state
        # the maximum, and it can understate it badly when f* is clamped to the
        # edge of the domain (p=0.6, up=1.4, down=0.7 has f* = 1.0 exactly,
        # while the grid stops at 0.999). So: kelly_growth must dominate every
        # grid point, and must not exceed the best of them by more than the
        # curvature over one grid step allows.
        g_star = A.kelly_growth(p, up, down)
        g_brute = float(np.nanmax(g))
        ok = g_star >= g_brute - 1e-12 and (g_star - g_brute) < 1e-6
        if not ok:
            FAILURES.append((f"kelly_growth p={p}", g_star, g_brute))
        print(f"  [{'ok  ' if ok else 'FAIL'}] kelly_growth p={p} up={up} "
              f"down={down}: closed form {g_star:.10f} >= brute max "
              f"{g_brute:.10f} (by {g_star - g_brute:.2e})")

        # zero_growth_fraction: g must actually vanish there, it must sit above
        # f*, and it must be the *second* root (g > 0 strictly between).
        f0 = A.zero_growth_fraction(p, up, down)
        f_star = A.kelly_fraction(p, up, down)
        check(f"g(f0) = 0 at p={p}", A.time_growth(p, up, down, f0), 0.0, tol=1e-10)
        ok = (f0 > f_star > 0
              and A.time_growth(p, up, down, 0.5 * (f_star + f0)) > 0
              and A.time_growth(p, up, down, min(f0 * 1.05, (1 / b) * 0.999)) < 0)
        if not ok:
            FAILURES.append((f"zero-growth bracketing p={p}", f0, f_star))
        print(f"  [{'ok  ' if ok else 'FAIL'}] p={p}: f*={f_star:.6f}, "
              f"growth returns to zero at f0={f0:.6f} (ratio {f0 / f_star:.4f})")

    # At p = 1/2 the second root is available in closed form, f0 = 2 f*, and
    # zero_growth_fraction takes that exact branch rather than bisecting.
    for up, down in [(1.5, 0.6), (2.0, 0.5), (1.2, 0.9)]:
        a, b = up - 1, 1 - down
        check(f"p=1/2 closed form f0 = (a-b)/(ab), up={up}",
              A.zero_growth_fraction(0.5, up, down), (a - b) / (a * b), tol=1e-12)
        check(f"p=1/2: f0 = 2 f*, up={up}", A.zero_growth_fraction(0.5, up, down),
              2 * A.kelly_fraction(0.5, up, down), tol=1e-12)

    # A negative edge has no positive zero-growth fraction: growth is negative
    # for every f > 0, so the only root is f = 0 itself.
    f0 = A.zero_growth_fraction(0.3, 1.5, 0.6)
    ok = f0 == 0.0
    if not ok:
        FAILURES.append(("zero-growth fraction, negative edge", f0, 0.0))
    print(f"  [{'ok  ' if ok else 'FAIL'}] negative edge -> f0={f0} (expect 0)")

    # -- doubling time -------------------------------------------------------
    for p, up, down, f in [(0.6, 1.4, 0.7, 0.25), (0.5, 1.5, 0.6, 0.25),
                           (0.5, 1.5, 0.6, 1.0)]:
        t = A.doubling_time(p, up, down, f)
        g = A.time_growth(p, up, down, f)
        if math.isfinite(t):
            check(f"exp(g*T2) = 2 at p={p} f={f}", math.exp(g * t), 2.0, tol=1e-12)
        else:
            ok = g <= 0
            if not ok:
                FAILURES.append(("doubling time inf only when g <= 0", g, "<= 0"))
            print(f"  [{'ok  ' if ok else 'FAIL'}] doubling time is +inf because "
                  f"g = {g:.6f} <= 0")

    # -- half Kelly: an APPROXIMATION, true in the small-edge limit only ------
    # The classic claim is that betting f*/2 keeps 3/4 of the Kelly growth
    # rate. That is the second-order Taylor picture -- g(f) ~ g''(f*)(f-f*)^2/2
    # around a parabola through the origin -- and it is exact only as the edge
    # goes to zero. Reported at several edges rather than asserted as identity.
    print("\nHalf Kelly vs 3/4 of Kelly growth (approximation, small-edge limit)")
    ratios = []
    for label, (p, up, down) in [
        ("tiny edge   p=0.5005 up=1.01 down=0.99", (0.5005, 1.01, 0.99)),
        ("small edge  p=0.51   up=1.05 down=0.95", (0.51, 1.05, 0.95)),
        ("scenario    p=0.6    up=1.4  down=0.7 ", (0.6, 1.4, 0.7)),
        ("defaults    p=0.5    up=1.5  down=0.6 ", (0.5, 1.5, 0.6)),
    ]:
        f_star = A.kelly_fraction(p, up, down)
        g_full = A.kelly_growth(p, up, down)
        g_half = A.time_growth(p, up, down, 0.5 * f_star)
        ratio = g_half / g_full
        ratios.append((label, ratio))
        print(f"  [info] {label}: g(f*)={g_full:.6g}, g(f* / 2)={g_half:.6g}, "
              f"ratio {ratio:.6f} (3/4 = 0.75, off by {ratio - 0.75:+.2e})")
    # The tolerance is set from what the maths actually delivers, not from what
    # would make the test pass: the tiny-edge case lands within 1e-4 of 3/4, and
    # the drift away from it is the honest content of "this is an
    # approximation". Only the small-edge limit is asserted.
    tiny = ratios[0][1]
    check("half-Kelly ratio -> 3/4 in the small-edge limit", tiny, 0.75, tol=1e-4)
    # Every case must at least stay in the neighbourhood, and must never exceed
    # 3/4 by much -- g is concave, so half Kelly cannot beat the parabola badly.
    for label, ratio in ratios:
        ok = 0.70 <= ratio <= 0.78
        if not ok:
            FAILURES.append((f"half-Kelly ratio {label}", ratio, "in [0.70, 0.78]"))
        print(f"  [{'ok  ' if ok else 'FAIL'}] {label}: ratio {ratio:.6f} "
              f"within [0.70, 0.78]")


# -- 1b. gambler's ruin ------------------------------------------------------
def mc_ruin(bankroll, target, p, bet, n=200_000, seed=99):
    """Walk n players to absorption. Returns (ruined fraction, mean duration)."""
    rng = np.random.default_rng(seed)
    k, cap = A.ruin_units(bankroll, target, bet)
    x = np.full(n, k, dtype=np.int64)
    steps = np.zeros(n, dtype=np.int64)
    live = np.ones(n, dtype=bool)
    # Cap the walk length generously: E[duration] for these cases is in the
    # hundreds, and any straggler still live at the cap is counted where it sits,
    # which biases both statistics by less than the Monte Carlo error.
    for _ in range(200_000):
        idx = np.nonzero(live)[0]
        if idx.size == 0:
            break
        x[idx] += np.where(rng.random(idx.size) < p, 1, -1)
        steps[idx] += 1
        live[idx] = (x[idx] > 0) & (x[idx] < cap)
    return float((x <= 0).mean()), float(steps.mean())


def verify_ruin():
    print("\nGambler's ruin: closed forms vs Monte Carlo (200k players)")
    cases = [
        dict(bankroll=100.0, target=200.0, p=0.49, bet=5.0),
        dict(bankroll=100.0, target=200.0, p=0.50, bet=5.0),
        dict(bankroll=100.0, target=200.0, p=0.49, bet=50.0),
        dict(bankroll=50.0, target=250.0, p=0.55, bet=10.0),
    ]
    for c in cases:
        print(f"\n  case {c}")
        ruined, dur = mc_ruin(**c)
        check("P(ruin)", ruined, A.ruin_prob(**c), tol=4e-3)
        check("E[rounds]", dur, A.ruin_duration(**c), tol=6e-3, rel=True)
        # Absorption is certain, so the two outcomes must exhaust the space.
        total = A.ruin_prob(**c) + A.reach_target_prob(**c)
        check("P(ruin) + P(target) = 1", total, 1.0)
        # Terminal wealth is two-point, so E and SD are pinned by P(ruin) alone.
        q = A.reach_target_prob(**c)
        mean, sd = A.ruin_terminal_stats(**c)
        check("E[terminal] identity", mean, c["target"] * q)
        check("SD[terminal] identity", sd, c["target"] * math.sqrt(q * (1 - q)))

    # The fair-coin case has an elementary closed form worth pinning separately:
    # ruin probability is 1 - k/n and duration is k(n-k), both in bets.
    k, n = A.ruin_units(100.0, 250.0, 5.0)
    check("fair P(ruin) = 1 - k/n", A.ruin_prob(100.0, 250.0, 0.5, 5.0), 1 - k / n)
    check("fair E[rounds] = k(n-k)", A.ruin_duration(100.0, 250.0, 0.5, 5.0),
          float(k * (n - k)))

    # A long unfavourable walk is where the naive (r^k - r^n)/(1 - r^n) overflows
    # to nan. The rearranged form must stay finite and monotone.
    deep = A.ruin_prob(1000.0, 100000.0, 0.45, 1.0)
    ok = math.isfinite(deep) and 0.999 < deep <= 1.0
    if not ok:
        FAILURES.append(("deep walk overflow", deep, "finite, ~1.0"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] deep unfavourable walk stays finite: {deep!r}")

    # Bold play: with the house edge against you, fewer, larger bets are safer.
    # With the edge in your favour it reverses. Both directions are the lesson.
    small = A.ruin_prob(100.0, 200.0, 0.49, 1.0)
    large = A.ruin_prob(100.0, 200.0, 0.49, 25.0)
    ok = large < small
    if not ok:
        FAILURES.append(("bold play, p<0.5", large, f"< {small}"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] p=0.49: $25 bets ruin {large:.4f} "
          f"< $1 bets {small:.4f}")
    small = A.ruin_prob(100.0, 200.0, 0.53, 1.0)
    large = A.ruin_prob(100.0, 200.0, 0.53, 25.0)
    ok = large > small
    if not ok:
        FAILURES.append(("cautious play, p>0.5", large, f"> {small}"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] p=0.53: $25 bets ruin {large:.4f} "
          f"> $1 bets {small:.4f}")


# -- 1c. St Petersburg -------------------------------------------------------
def verify_st_petersburg():
    print("\nSt Petersburg: closed forms vs Monte Carlo")

    # The convergent regime (m*p < 1) is the only one where a sample mean is a
    # legitimate check on E[payout]. Below m^2 p < 1 the variance is finite too,
    # so the estimate actually settles.
    rng = np.random.default_rng(4242)
    # (0.3, 1.5) is the odd one out: m^2 p = 0.675 < 1, so unlike the other
    # three it has a genuinely finite variance -- the branch that checks SD
    # against a sample needs at least one case where that check can pass.
    for p, m in [(0.4, 2.0), (0.5, 1.5), (0.3, 2.5), (0.3, 1.5)]:
        n = 2_000_000
        tosses = rng.geometric(1 - p, size=n)  # tosses until the first failure
        payouts = m ** (tosses - 1.0)
        want = A.sp_expected(p, m)
        finite_var = m * m * p < 1.0
        tol = 4e-3 if finite_var else 5e-2
        print(f"\n  case p={p} m={m}  (m*p={m*p:.3f}, "
              f"{'finite' if finite_var else 'infinite'} variance)")
        check("E[payout]", float(payouts.mean()), want, tol=tol, rel=True)
        check("median payout", float(np.median(payouts)), A.sp_median(p, m))
        # Variance needs the stricter m^2*p < 1 -- a case can have a
        # perfectly finite mean and an infinite spread around it.
        d_mean, d_sd = A.sp_dispersion(p, m)
        check("dispersion mean = sp_expected", d_mean, want)
        if finite_var:
            check("SD[payout]", float(payouts.std()), d_sd, tol=3e-2, rel=True)
        else:
            ok = math.isinf(d_sd)
            if not ok:
                FAILURES.append((f"SD[payout] should diverge p={p} m={m}", d_sd, "inf"))
            print(f"  [{'ok  ' if ok else 'FAIL'}] SD[payout] diverges "
                  f"(m^2p={m*m*p:.3f} >= 1): {d_sd}")
        for tier in (1, 3, 6):
            check(f"P(payout >= m^{tier - 1})",
                  float((tosses >= tier).mean()), A.sp_survival(tier, p), tol=2e-3)

    # The classic game: the expectation diverges, and the tier contributions are
    # the reason -- each one is worth exactly (1-p) = $0.50, forever.
    print("\n  classic game p=0.5 m=2.0")
    check("E[payout] diverges", A.sp_expected(0.5, 2.0), math.inf)
    check("median payout = $1", A.sp_median(0.5, 2.0), 1.0)
    classic_mean, classic_sd = A.sp_dispersion(0.5, 2.0)
    check("dispersion mean diverges too", classic_mean, math.inf)
    ok = math.isinf(classic_sd)
    if not ok:
        FAILURES.append(("classic SD[payout] should diverge", classic_sd, "inf"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] classic SD[payout] diverges: {classic_sd}")
    for tier in (1, 5, 20, 200):
        check(f"tier {tier} contributes", A.sp_tier_contribution(tier, 0.5, 2.0), 0.5)
    # Capping the house's bankroll is what makes the game worth something: for
    # the classic game E = tiers/2 + 1/2 exactly.
    for tiers in (10, 31, 64):
        check(f"capped at {tiers} tosses", A.sp_capped_expected(0.5, 2.0, tiers),
              tiers / 2 + 0.5, tol=1e-9, rel=True)
    # The capped expectation must converge to the uncapped one when it exists.
    check("cap -> E[payout] when m*p < 1", A.sp_capped_expected(0.4, 2.0, 400),
          A.sp_expected(0.4, 2.0), tol=1e-9, rel=True)

    # -- Bernoulli's log-utility resolution ----------------------------------
    # E[ln X] is the one moment that converges everywhere, including on the
    # classic game where E[X] does not. ln X is thin-tailed (it is a linear
    # function of a geometric count), so unlike E[X] it *is* legitimate to
    # check against a sample mean -- which is exactly the distinction
    # CLAUDE.md warns about.
    print("\n  log utility E[ln X] and the certainty equivalent exp(E[ln X])")
    for p, m in [(0.5, 2.0), (0.4, 2.0), (0.6, 1.5), (0.5, 3.0), (0.3, 2.5)]:
        n = 2_000_000
        tosses = rng.geometric(1 - p, size=n)
        log_payouts = (tosses - 1.0) * math.log(m)
        want = A.sp_log_utility(p, m)
        print(f"\n  case p={p} m={m}  (E[X] "
              f"{'diverges' if m * p >= 1 else 'is finite'})")
        check("E[ln X]", float(log_payouts.mean()), want, tol=4e-3)
        # exp of a sample mean, not a sample mean of exp -- the second would be
        # the heavy-tailed quantity this file refuses to check.
        check("certainty equivalent", float(np.exp(log_payouts.mean())),
              A.sp_certainty_equivalent(p, m), tol=6e-3, rel=True)
        # The closed form itself, against the series it came from, summed far
        # enough out that the tail is below float noise.
        series = sum((nn - 1) * math.log(m) * p ** (nn - 1) * (1 - p)
                     for nn in range(1, 4000))
        check("E[ln X] = ln(m) p/(1-p) vs the series", want, series, tol=1e-10)

    # The classic game, stated exactly. This module's payout convention is
    # m^(N-1) -- $1, $2, $4, ... -- so the log player's certainty equivalent is
    # 2^(0.5/0.5) = exactly $2.00. The "about $4" figure quoted for Bernoulli's
    # resolution belongs to the 2^N statement of the game (payouts $2, $4, $8),
    # which is twice this one at every tier and so has exactly twice the CE.
    ce = A.sp_certainty_equivalent(0.5, 2.0)
    check("classic game E[ln X] = ln 2", A.sp_log_utility(0.5, 2.0), math.log(2.0))
    check("classic game certainty equivalent = $2.00 exactly", ce, 2.0, tol=1e-12)
    print(f"  [info] classic game: E[X] is infinite, median is $1.00, and the "
          f"log player's certainty equivalent is ${ce:.4f} "
          f"(${2 * ce:.4f} under the 2^N statement of the same game)")
    # And the number stays finite across the whole divergent regime, which is
    # the entire point of the resolution.
    for p, m in [(0.5, 2.0), (0.5, 3.0), (0.9, 10.0)]:
        u = A.sp_log_utility(p, m)
        ok = math.isfinite(u) and not math.isfinite(A.sp_expected(p, m))
        if not ok:
            FAILURES.append((f"log utility finite where E[X] is not, p={p} m={m}",
                             u, "finite"))
        print(f"  [{'ok  ' if ok else 'FAIL'}] p={p} m={m}: E[X]=inf but "
              f"E[ln X]={u:.6f}, CE=${A.sp_certainty_equivalent(p, m):.4f}")

    # sp_typical_mean is an approximation and is checked as one: it should land
    # within a few tens of percent of the median sample mean, which is all the
    # claim is. A tight tolerance here would be checking noise.
    print("\n  typical running mean (approximation, loose tolerance)")
    for plays in (2_000, 50_000):
        runs = 400
        tosses = rng.geometric(0.5, size=(runs, plays))
        means = (2.0 ** (tosses - 1.0)).mean(axis=1)
        got = float(np.median(means))
        want = A.sp_typical_mean(plays, 0.5, 2.0)
        ratio = got / want
        ok = 0.7 <= ratio <= 1.4
        if not ok:
            FAILURES.append((f"typical mean @{plays}", got, want))
        print(f"  [{'ok  ' if ok else 'FAIL'}] {plays} plays: median sample mean "
              f"${got:.2f} vs predicted ${want:.2f} (ratio {ratio:.2f})")


# -- 1d. iterated prisoner's dilemma -----------------------------------------
def mc_pd(sa, sb, rounds, pay, noise, n=40_000, seed=5150):
    """Play n independent matches, the dumb way, to check the exact DP."""
    rng = np.random.default_rng(seed)
    tot_a = tot_b = 0.0
    for _ in range(n):
        a_last = b_last = None
        a_ever = b_ever = False  # has *this* side ever defected
        for rnd in range(rounds):
            first = rnd == 0
            ca = A._p_cooperate(sa, first, b_last is False, b_ever)
            cb = A._p_cooperate(sb, first, a_last is False, a_ever)
            a_coop = rng.random() < ca
            b_coop = rng.random() < cb
            if noise > 0:
                if rng.random() < noise:
                    a_coop = not a_coop
                if rng.random() < noise:
                    b_coop = not b_coop
            tot_a += A._payoff(pay, a_coop, b_coop)
            tot_b += A._payoff(pay, b_coop, a_coop)
            a_last, b_last = a_coop, b_coop
            a_ever = a_ever or not a_coop
            b_ever = b_ever or not b_coop
    return tot_a / (n * rounds), tot_b / (n * rounds)


def verify_pd():
    print("\nIterated prisoner's dilemma: exact DP vs Monte Carlo")
    pay = A.pd_payoffs()
    T, R, P, S = pay["T"], pay["R"], pay["P"], pay["S"]

    # Hand-derived cases first. These do not need a simulation to check, and if
    # the DP disagrees with any of them the DP is wrong.
    rounds = 50
    print("\n  hand-derived, no noise")
    check("TFT vs TFT", A.pd_pair("tft", "tft", rounds, pay, 0.0)[0], R)
    check("ALLD vs ALLD", A.pd_pair("alld", "alld", rounds, pay, 0.0)[0], P)
    check("ALLC vs ALLD (exploited)", A.pd_pair("allc", "alld", rounds, pay, 0.0)[0], S)
    check("ALLD vs ALLC (exploiter)", A.pd_pair("alld", "allc", rounds, pay, 0.0)[0], T)
    # TFT loses the first round to a defector, then matches it: S + (n-1)P.
    check("TFT vs ALLD", A.pd_pair("tft", "alld", rounds, pay, 0.0)[0],
          (S + (rounds - 1) * P) / rounds)
    check("ALLD vs TFT", A.pd_pair("alld", "tft", rounds, pay, 0.0)[0],
          (T + (rounds - 1) * P) / rounds)
    # Grim behaves exactly like TFT against these three, by different means.
    check("GRIM vs ALLD", A.pd_pair("grim", "alld", rounds, pay, 0.0)[0],
          (S + (rounds - 1) * P) / rounds)
    check("GRIM vs TFT", A.pd_pair("grim", "tft", rounds, pay, 0.0)[0], R)
    # A random opponent cooperates half the time and ALLC cannot react.
    check("ALLC vs RAND", A.pd_pair("allc", "rand", rounds, pay, 0.0)[0],
          0.5 * R + 0.5 * S)
    check("RAND vs ALLC", A.pd_pair("rand", "allc", rounds, pay, 0.0)[0],
          0.5 * R + 0.5 * T)
    # RAND against itself is the flat average of the whole matrix.
    check("RAND vs RAND", A.pd_pair("rand", "rand", rounds, pay, 0.0)[0],
          0.25 * (R + S + T + P))

    # Now the cases with no hand answer: a random player, and a trembling hand.
    print("\n  vs Monte Carlo (40k matches each)")
    for sa, sb, rnds, noise in [
        ("tft", "rand", 30, 0.0),
        ("grim", "rand", 30, 0.0),
        ("tft", "tft", 30, 0.05),
        ("tft", "alld", 30, 0.05),
        ("grim", "grim", 30, 0.10),
        ("tft", "grim", 20, 0.02),
    ]:
        got_a, got_b = A.pd_pair(sa, sb, rnds, pay, noise)
        mc_a, mc_b = mc_pd(sa, sb, rnds, pay, noise)
        check(f"{sa} vs {sb} (noise {noise}) — A", mc_a, got_a, tol=2e-2)
        check(f"{sa} vs {sb} (noise {noise}) — B", mc_b, got_b, tol=2e-2)

    # Structural properties of the tournament and the replicator dynamics.
    print("\n  tournament structure")
    mat, scores = A.pd_tournament(rounds, pay, 0.0)
    # Nobody beats ALLD head to head -- and ALLD still loses the tournament.
    alld = A.STRATEGIES.index("alld")
    row_ok = all(mat[i][alld] <= mat[alld][i] + 1e-12
                 for i in range(len(A.STRATEGIES)))
    if not row_ok:
        FAILURES.append(("ALLD unbeatable head-to-head", row_ok, True))
    print(f"  [{'ok  ' if row_ok else 'FAIL'}] no strategy outscores ALLD in a "
          f"direct match")
    winner = A.STRATEGIES[max(range(len(scores)), key=lambda i: scores[i])]
    ok = winner != "alld"
    if not ok:
        FAILURES.append(("tournament winner", winner, "not alld"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] tournament winner is {winner!r}, "
          f"not the strategy that never loses")

    hist = A.pd_replicator(mat, 60)
    for gen, row in enumerate(hist):
        tot = sum(row)
        if abs(tot - 1.0) > 1e-9 or min(row) < -1e-12:
            FAILURES.append((f"replicator shares gen {gen}", tot, 1.0))
            break
    print(f"  [{'ok  ' if not FAILURES or FAILURES[-1][0][:10] != 'replicator' else 'FAIL'}]"
          f" replicator shares stay a distribution over {len(hist)} generations")

    # The payoff sliders must not be able to leave the prisoner's dilemma.
    for t in (3.1, 5.0, 5.9):
        ok = A.pd_is_dilemma(A.pd_payoffs(t=t))
        if not ok:
            FAILURES.append((f"is_dilemma T={t}", ok, True))
        print(f"  [{'ok  ' if ok else 'FAIL'}] T={t} is a valid dilemma")


# -- 1e. Monty Hall -----------------------------------------------------------
def mc_monty(doors, opened, know, n=400_000, seed=77):
    """Vectorised Monte Carlo, independent of mulberry32 -- this checks the
    formula, not the seeded-draw contract (that is simulate_monty's job)."""
    rng = np.random.default_rng(seed)
    n_doors, k = A.mh_board(doors, opened)
    car = rng.integers(0, n_doors, n)
    pick = rng.integers(0, n_doors, n)
    knows = rng.random(n) < know
    # A random host reveals a goat with probability (n_doors-k)/(n_doors-1) once
    # the prize is not behind the player's own door; collapse the combinatorics
    # into one draw exactly as simulate_monty does.
    p_reveal = k / (n_doors - 1.0)
    revealed = (~knows) & (car != pick) & (rng.random(n) < p_reveal)
    valid = ~revealed
    stay_win = valid & (car == pick)
    p_switch = 1.0 / (n_doors - 1.0 - k)
    switch_win = valid & (car != pick) & (rng.random(n) < p_switch)
    return (float(valid.mean()), float(stay_win.sum()) / valid.sum(),
            float(switch_win.sum()) / valid.sum())


def verify_monty():
    print("\nMonty Hall: closed forms vs Monte Carlo (400k games)")
    cases = [
        dict(doors=3, opened=1, know=1.0),   # the classic puzzle
        dict(doors=3, opened=1, know=0.0),   # lucky host: no information
        dict(doors=3, opened=1, know=0.5),   # a dial in between
        dict(doors=5, opened=3, know=1.0),   # more doors, more opened
        dict(doors=10, opened=1, know=1.0),  # opens only one of nine
        dict(doors=10, opened=8, know=0.7),
    ]
    for c in cases:
        print(f"\n  case {c}")
        valid_frac, stay_mc, switch_mc = mc_monty(**c)
        want_goat = A.mh_goat_prob(**c)
        check("P(only goats revealed)", valid_frac, want_goat, tol=3e-3)
        check("P(stay wins | valid)", stay_mc, A.mh_stay_prob(**c), tol=3e-3)
        check("P(switch wins | valid)", switch_mc, A.mh_switch_prob(**c), tol=3e-3)
        # Whatever the host's knowledge, staying and switching are the only two
        # ways to win, and one of the N-2 other doors is never picked.
        total = A.mh_stay_prob(**c) + A.mh_switch_prob(**c) * (
            A.mh_board(c["doors"], c["opened"])[0] - 1 - A.mh_board(c["doors"], c["opened"])[1])
        check("stay + (unopened others)*switch = 1", total, 1.0)

    # The two endpoints of the `know` dial, exactly.
    classic = A.mh_summary(doors=3, opened=1, know=1.0)
    check("classic switch = 2/3", classic["switch_prob"], 2.0 / 3.0)
    check("classic stay = 1/3", classic["stay_prob"], 1.0 / 3.0)
    lucky = A.mh_summary(doors=3, opened=1, know=0.0)
    check("lucky host: switch = stay", lucky["switch_prob"], lucky["stay_prob"])

    # Opening more doors under a knowing host cannot move the stay probability:
    # a knowing host never reveals anything about the player's own door.
    for opened in (1, 2, 3, 7):
        s = A.mh_summary(doors=10, opened=opened, know=1.0)
        check(f"knowing host, opened={opened}: stay stays 1/10", s["stay_prob"], 0.1)

    # The two sweep curves are literal evaluations of formulas already checked
    # above, so this is a spot check that the sweep wiring agrees with them.
    ks, sw, st = A.mh_know_curve(doors=5, opened=2, points=11)
    check("know curve endpoint (know=0) matches mh_switch_prob",
          sw[0], A.mh_switch_prob(5, 2, 0.0))
    check("know curve endpoint (know=1) matches mh_switch_prob",
          sw[-1], A.mh_switch_prob(5, 2, 1.0))
    xs, know_line, rand_line = A.mh_doors_curve(opened=1, max_doors=12)
    check("doors curve matches mh_switch_prob at doors=6",
          know_line[xs.index(6)], A.mh_switch_prob(6, 1, 1.0))
    # With one door opened regardless of how many are on offer, a random host's
    # reveal carries less and less information as the board grows -- there are
    # more doors it could have opened that would have meant nothing -- so
    # switching's edge shrinks toward zero rather than staying at a constant.
    ok = all(a >= b - 1e-12 for a, b in zip(rand_line, rand_line[1:]))
    print(f"  [{'ok  ' if ok else 'FAIL'}] random-host switch prob is "
          f"non-increasing in door count: {ok}")
    if not ok:
        FAILURES.append(("random host switch prob monotone in doors", rand_line, "non-increasing"))


# -- 1f. Shannon's demon -------------------------------------------------------
def mc_rebalance_growth(interval, p, vol, w, cost, n=300_000, rounds_mult=1,
                        seed=88):
    """Vectorised Monte Carlo of the exact per-cycle growth formula.

    Simulates exactly one rebalancing cycle of `interval` periods, n_paths times,
    which checks sd_cycle_growth directly rather than composing many cycles --
    composing would also work (growth per period is the same by construction)
    but this isolates the one formula under test.
    """
    rng = np.random.default_rng(seed)
    up, down = A.sd_moves(vol)
    heads = rng.random((n, interval)) < p
    log_r = np.where(heads, math.log(up), math.log(down)).sum(axis=1)
    r = np.exp(log_r)
    m = 1.0 - w + w * r
    log_m = np.log(m)
    if cost > 0.0 and 0.0 < w < 1.0:
        w_after = w * r / m
        log_c = np.log1p(-cost * np.abs(w_after - w))
    else:
        log_c = 0.0
    return float((log_m + log_c).mean()) / interval


def verify_shannon():
    print("\nShannon's demon: closed forms vs Monte Carlo (300k cycles)")
    cases = [
        dict(interval=1, p=0.5, vol=0.3, w=0.5, cost=0.0),
        dict(interval=5, p=0.5, vol=0.3, w=0.5, cost=0.0),
        dict(interval=1, p=0.5, vol=0.3, w=0.5, cost=0.01),
        dict(interval=3, p=0.5, vol=0.15, w=0.3, cost=0.0),
        dict(interval=1, p=0.55, vol=0.3, w=0.5, cost=0.0),  # a trending stock
    ]
    for c in cases:
        print(f"\n  case {c}")
        got = mc_rebalance_growth(**c)
        want = A.sd_cycle_growth(**c)
        check("growth per period", got, want, tol=3e-4)

    # A trendless stock (down = 1/up, p = 1/2) has exactly zero time-average
    # growth by construction -- no Monte Carlo needed, this is algebra.
    check("trendless stock growth = 0", A.sd_stock_growth(0.5, 0.3), 0.0)
    # ...but positive ensemble growth, which is the seed of the whole paradox:
    # E[m] > 1 while E[ln m] = 0.
    drift = A.sd_stock_drift(0.5, 0.3)
    ok = drift > 0.0
    if not ok:
        FAILURES.append(("stock ensemble drift > 0", drift, "> 0"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] trendless stock still has positive "
          f"ensemble drift: {drift*100:.3f} %/period")

    # No cost: rebalancing every period beats every longer interval, on a
    # trendless stock. The curve need not be globally monotone once a trend or a
    # cost is present, but the two endpoints bracketing the interior optimum
    # must hold at zero cost.
    xs, gs = A.sd_interval_curve(rounds=200, p=0.5, vol=0.3, w=0.5, cost=0.0)
    ok = gs[0] == max(gs)
    if not ok:
        FAILURES.append(("best interval is 1 at zero cost", gs.index(max(gs)) + 1, 1))
    print(f"  [{'ok  ' if ok else 'FAIL'}] zero-cost optimum is interval=1")

    # A large enough cost must eventually push the optimum away from 1: there is
    # a trade-off, not a free lunch.
    _, g_cheap = A.sd_best_interval(rounds=200, p=0.5, vol=0.3, w=0.5, cost=0.0)
    best_n, g_costly = A.sd_best_interval(rounds=200, p=0.5, vol=0.3, w=0.5, cost=0.05)
    ok = best_n > 1
    if not ok:
        FAILURES.append(("cost pushes optimal interval above 1", best_n, "> 1"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] a 5% turnover cost moves the optimum "
          f"to every {best_n} periods")

    # A trending stock (p far from 1/2) needn't be helped by rebalancing at all
    # -- the honest caveat the story has to carry.
    trend = A.sd_summary(rounds=200, p=0.7, vol=0.3, w=0.5, interval=1, cost=0.0)
    ok = trend["harvest"] < 0.0
    if not ok:
        FAILURES.append(("trending stock: rebalancing hurts", trend["harvest"], "< 0"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] a trending stock (p=0.7) makes "
          f"rebalancing every period cost {-trend['harvest']*100:.3f} %/period "
          f"relative to holding")

    # kelly_w should be 1/2 for the symmetric trendless coin, matching the claim
    # that Shannon's 50/50 split is exactly the Kelly fraction.
    check("Kelly fraction of the symmetric trendless coin = 1/2",
          A.sd_summary(rounds=200, p=0.5, vol=0.3, w=0.5)["kelly_w"], 0.5, tol=1e-6)

    # -- sd_optimal_weight: EXACT at interval = 1, checked by brute sweep -----
    # Per-period rebalancing makes the portfolio's growth term-for-term the
    # coin's time_growth with f = w, so the closed-form Kelly fraction is the
    # exact argmax. A grid sweep over w confirms it.
    print("\n  optimal weight (exact at interval=1) vs a brute sweep over w")
    for p, vol in [(0.5, 0.3), (0.5, 0.1), (0.55, 0.3), (0.45, 0.2)]:
        grid = np.linspace(0.0, 1.0, 100_001)
        gs = np.array([A.sd_cycle_growth(1, p, vol, float(x), 0.0) for x in grid])
        w_brute = float(grid[int(np.nanargmax(gs))])
        w_form = A.sd_optimal_weight(p, vol)
        ok = abs(w_form - w_brute) < 1e-4      # the grid's own spacing is 1e-5
        if not ok:
            FAILURES.append((f"optimal weight p={p} vol={vol}", w_form, w_brute))
        print(f"  [{'ok  ' if ok else 'FAIL'}] p={p} vol={vol}: closed form "
              f"{w_form:.6f}, brute {w_brute:.6f}")

    # -- the continuous-time harvest identity, as an APPROXIMATION ------------
    # w(1-w)sigma^2/2 is the Ito result for a continuously rebalanced portfolio
    # of a driftless GBM and cash. The page simulates a discrete binomial move
    # instead, so this is NOT the same quantity and is not asserted equal to
    # it. What follows is a report of the size of the gap, which grows like
    # sigma^4 -- negligible at a 5% move and a percent of the answer at 60%.
    print("\n  continuous-time harvest w(1-w)sigma^2/2 vs the EXACT discrete "
          "sd_cycle_growth(interval=1), p=0.5, trendless stock")
    print(f"    {'vol':>6}  {'sigma':>9}  {'exact discrete':>15}  "
          f"{'continuous':>12}  {'abs gap':>11}  {'rel gap':>9}")
    worst = 0.0
    for w in (0.5, 0.3):
        for vol in (0.05, 0.10, 0.20, 0.30, 0.45, 0.60):
            exact = A.sd_cycle_growth(1, 0.5, vol, w, 0.0)
            approx = A.sd_harvest_continuous(vol, w)
            rel = (approx - exact) / exact
            worst = max(worst, abs(rel))
            print(f"    w={w}  {vol:>6.2f}  {math.log1p(vol):>9.6f}  "
                  f"{exact:>15.9f}  {approx:>12.9f}  "
                  f"{approx - exact:>+11.2e}  {rel:>+9.4%}")
    # The only thing asserted is the *shape* of the error: the approximation is
    # an over-estimate that vanishes with the move size. A tolerance pinning
    # them together would be asserting something untrue.
    ok = worst < 0.02
    if not ok:
        FAILURES.append(("continuous harvest gap over the sweep", worst, "< 2%"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] worst relative gap across the sweep: "
          f"{worst:.4%} (at the largest move; it is 1e-4 at vol=0.05)")
    # Fourth-order shape check: halving the move should cut the relative gap by
    # roughly four, since the leading error term is O(sigma^4) against an
    # O(sigma^2) answer.
    g1 = abs(A.sd_harvest_continuous(0.20, 0.5) / A.sd_cycle_growth(1, 0.5, 0.20, 0.5, 0.0) - 1)
    g2 = abs(A.sd_harvest_continuous(0.10, 0.5) / A.sd_cycle_growth(1, 0.5, 0.10, 0.5, 0.0) - 1)
    ratio = g1 / g2
    ok = 3.0 < ratio < 5.0
    if not ok:
        FAILURES.append(("continuous harvest error is O(sigma^4)", ratio, "~4"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] halving the move divides the relative "
          f"gap by {ratio:.2f} (expect ~4: the error is O(sigma^4))")


# -- 1g. insurance and risk pooling --------------------------------------------
def mc_pool_growth(members, wealth, loss, hazard, n=200_000, seed=99):
    rng = np.random.default_rng(seed)
    k = rng.binomial(members, hazard, n)
    m = 1.0 - (loss / wealth) * (k / members)
    return float(np.log(m).mean())


def mc_bs_price(s, k, t, sigma, r, q, call, n=2_000_000, seed=99):
    """Monte Carlo cross-check for bs_call_price / bs_put_price: the
    discounted expected payoff under the RISK-NEUTRAL measure (drift r).
    Independent of the analytic formula -- a bug shared between the formula
    and this check would have to reproduce the exact same closed-form error,
    which a totally different computation (simulate, don't integrate) is not
    going to do by accident.
    """
    rng = np.random.default_rng(seed)
    z = rng.standard_normal(n)
    st = s * np.exp((r - q - 0.5 * sigma * sigma) * t + sigma * math.sqrt(t) * z)
    payoff = np.maximum(st - k, 0.0) if call else np.maximum(k - st, 0.0)
    return math.exp(-r * t) * float(payoff.mean())


def mc_real_world_itm(s, k, t, sigma, mu, q, call, n=2_000_000, seed=98):
    """Monte Carlo cross-check for real_world_itm_prob, drawn at the PHYSICAL
    drift mu -- the measure the pricing check above deliberately does not
    use, since the two functions are exact under two different drifts and
    mixing them up is exactly the bug this pair of checks would catch."""
    rng = np.random.default_rng(seed)
    z = rng.standard_normal(n)
    st = s * np.exp((mu - q - 0.5 * sigma * sigma) * t + sigma * math.sqrt(t) * z)
    hit = (st > k) if call else (st < k)
    return float(hit.mean())


def verify_wheel():
    print("\nThe wheel strategy: Black-Scholes and real-world probabilities vs Monte Carlo")
    cases = [
        (100.0, 95.0, 0.5, 0.24, 0.03, 0.0),
        (100.0, 100.0, 0.25, 0.20, 0.02, 0.01),
        (50.0, 55.0, 1.0, 0.35, 0.04, 0.0),
    ]
    for s, k, t, sigma, r, q in cases:
        for call in (True, False):
            kind = "call" if call else "put"
            price = (A.bs_call_price(s, k, t, sigma, r, q) if call
                     else A.bs_put_price(s, k, t, sigma, r, q))
            mc = mc_bs_price(s, k, t, sigma, r, q, call)
            check(f"BS {kind} price s={s} k={k} t={t}", price, mc, tol=0.02, rel=True)
            prob = A.real_world_itm_prob(s, k, t, sigma, mu=0.08, q=q, call=call)
            mc_p = mc_real_world_itm(s, k, t, sigma, 0.08, q, call)
            check(f"real-world ITM prob {kind} s={s} k={k} t={t}", prob, mc_p, tol=5e-3)

    print("\n  put-call parity holds exactly, from the shared d1/d2")
    for s, k, t, sigma, r, q in cases:
        c = A.bs_call_price(s, k, t, sigma, r, q)
        p = A.bs_put_price(s, k, t, sigma, r, q)
        check(f"parity s={s} k={k} t={t}", c - p,
              s * math.exp(-q * t) - k * math.exp(-r * t))

    print("\n  buy-and-hold's closed form vs Monte Carlo terminal wealth")
    for w0, mu, sigma, q, years in [(100000.0, 0.08, 0.20, 0.0, 5.0),
                                    (50000.0, 0.05, 0.35, 0.02, 3.0)]:
        h = A.hold_summary(w0, mu, sigma, q, years)
        rng = np.random.default_rng(97)
        z = rng.standard_normal(1_000_000)
        st = w0 * np.exp((mu - q - 0.5 * sigma * sigma) * years
                        + sigma * math.sqrt(years) * z)
        check(f"E[W_T] w0={w0}", h["expected_final"], float(st.mean()),
              tol=0.01, rel=True)
        check(f"median W_T w0={w0}", h["median_final"], float(np.median(st)),
              tol=0.01, rel=True)
        check(f"P(below start) w0={w0}", h["p_below_start"],
              float((st < w0).mean()), tol=5e-3)

    print("\n  Box-Muller normal draws: mean 0, variance 1 over a long run")
    randn = A.make_normal_generator(seed=42)
    draws = np.array([randn() for _ in range(200_000)])
    check("E[Z]", float(draws.mean()), 0.0, tol=0.02)
    check("Var[Z]", float(draws.var()), 1.0, tol=0.02, rel=True)

    print("\n  with the call take-profit disabled, calls resolve only at expiry")
    fam = A.simulate_wheel_family(seed=7, call_tp=50.0)
    s_ = fam["wheel"]["stats"]
    ok = (s_["calls_tp"] == 0
          and s_["puts_sold"] == s_["assignments"] + s_["puts_expired"]
             + s_["puts_still_open"]
          and s_["calls_sold"] == s_["called_away"] + s_["calls_expired"]
             + s_["calls_closed_on_stop"] + s_["calls_still_open"])
    if not ok:
        FAILURES.append(("take-profit disabled -> only expiry outcomes", s_,
                        "no early closes"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] puts {s_['puts_sold']} = "
          f"{s_['assignments']} assigned + {s_['puts_expired']} expired; "
          f"calls {s_['calls_sold']} = {s_['called_away']} called away + "
          f"{s_['calls_expired']} expired -- no early close on either side")

    print("\n  the acquisition leg must actually acquire")
    # Regression guard for a defect that has now bitten twice. A stop on the
    # put's own marked value cannot coexist with assignment, because a put on
    # its way to being assigned must first balloon in value and trip the stop.
    # Measured over the S&P's 2009-2026 history, -30%, -50% and -100% stops
    # each produced ZERO assignments in seventeen years -- the arm sat in cash
    # while the index went up eightfold. If this count ever returns to zero,
    # the wheel has silently stopped being the wheel.
    assigned_any = sum(A.simulate_wheel_family(seed=s)["wheel"]["stats"]["assignments"]
                       for s in range(1, 9))
    ok = assigned_any > 0
    if not ok:
        FAILURES.append(("wheel acquires shares over 8 seeds", assigned_any, "> 0"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] {assigned_any} contracts assigned "
          f"across 8 seeds")

    print("\n  the income leg must leave the shares room to appreciate")
    # The mirror-image defect of the one above, and it bit just as hard. If a
    # covered call is written the instant the shares arrive, `max(spot, basis)`
    # is `basis` -- assignment happens precisely when spot is BELOW the strike
    # that bought them -- so every call is struck at cost and being called away
    # realises exactly zero on the shares. Measured on the S&P over 2009-2026
    # that rule struck 100% of its calls at the basis and, with the account
    # flat 95% of the time, turned an 8.35x index into +8.8%/yr. Writing only
    # when price is back near its rolling high is what fixes it, so: some
    # meaningful share of calls must be struck strictly ABOVE the basis.
    above, total = 0, 0
    for seed in range(1, 9):
        w = A.simulate_wheel(A.simulate_gbm_path(seed=seed))
        basis = None
        for e in w["events"]:
            if e["kind"] == "assigned":
                basis = e["strike"]
            elif e["kind"] == "sell_call" and basis is not None:
                total += 1
                if e["strike"] > basis * (1 + 1e-12):
                    above += 1
    frac = above / total if total else 0.0
    ok = total > 0 and frac >= 0.25
    if not ok:
        FAILURES.append(("calls struck above cost basis", f"{above}/{total}",
                         ">= 25%"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] {above}/{total} calls struck above "
          f"the basis ({frac * 100:.0f}%) across 8 seeds")

    print("\n  the account is not left sitting in cash")
    # The put leg re-sells the same day a put resolves, so an account that is
    # neither long nor short a put should be a rounding error, not a regime.
    # Gating put re-entry on a dip (an earlier rule) left the S&P arm flat for
    # 95% of seventeen years, earning the cash rate through an eightfold rally.
    for seed in (1, 4, 7):
        path = A.simulate_gbm_path(seed=seed)
        w = A.simulate_wheel(path)
        n = len(path) - 1
        put_open = long_now = False
        idle = 0
        by_t = {}
        for e in w["events"]:
            by_t.setdefault(e["t"], []).append(e["kind"])
        for t in range(1, n + 1):
            for k in by_t.get(t, ()):
                if k == "sell_put":
                    put_open = True
                elif k == "put_expired":
                    put_open = False
                elif k == "assigned":
                    put_open, long_now = False, True
                elif k in ("called_away", "stop_shares"):
                    long_now = False
            if not put_open and not long_now:
                idle += 1
        ok = idle / n < 0.05
        if not ok:
            FAILURES.append((f"wheel idle fraction (seed={seed})",
                             f"{idle / n:.1%}", "< 5%"))
        print(f"  [{'ok  ' if ok else 'FAIL'}] seed {seed}: idle "
              f"{idle / n * 100:.1f}% of days")

    print("\n  one position at a time: never short a put while holding shares")
    for seed in (1, 4, 7):
        path = A.simulate_gbm_path(seed=seed)
        w = A.simulate_wheel(path)
        # Replay the event tape: a sell_put may only follow a flat account.
        long_now, bad = False, 0
        for e in w["events"]:
            if e["kind"] == "assigned":
                long_now = True
            elif e["kind"] in ("called_away", "stop_shares"):
                long_now = False
            elif e["kind"] == "sell_put" and long_now:
                bad += 1
        ok = bad == 0
        if not ok:
            FAILURES.append((f"single position (seed={seed})", bad, 0))
        print(f"  [{'ok  ' if ok else 'FAIL'}] seed {seed}: {bad} puts sold "
              f"while long")

    print("\n  lot bookkeeping balances across a batch of seeds")
    for seed in range(1, 9):
        fam = A.simulate_wheel_family(seed=seed)
        s_ = fam["wheel"]["stats"]
        puts_ok = (s_["puts_sold"] == s_["assignments"] + s_["puts_expired"]
                  + s_["puts_still_open"])
        calls_ok = (s_["calls_sold"] == s_["called_away"]
                   + s_["calls_expired"] + s_["calls_tp"]
                   + s_["calls_closed_on_stop"] + s_["calls_still_open"])
        equity_ok = min(fam["wheel"]["equity"]) > -1e-6
        ok = puts_ok and calls_ok and equity_ok
        if not ok:
            FAILURES.append((f"wheel bookkeeping balances (seed={seed})", s_,
                            "sold = every closed-lot category, summed"))
        print(f"  [{'ok  ' if ok else 'FAIL'}] seed {seed}: puts balance "
              f"{puts_ok}, calls balance {calls_ok}, equity never negative "
              f"{equity_ok}")


def verify_insurance():
    print("\nInsurance and risk pooling: closed forms vs Monte Carlo")
    print("\n  buyer's max premium is where insured growth = uninsured growth")
    for wealth, loss, hazard in [(100000.0, 30000.0, 0.05), (50000.0, 40000.0, 0.1),
                                 (200000.0, 10000.0, 0.02)]:
        p_max = A.ins_buyer_max_premium(wealth, loss, hazard)
        check(f"insured(p_max) = uninsured  (W={wealth}, L={loss}, pi={hazard})",
              A.ins_insured_growth(wealth, p_max),
              A.ins_uninsured_growth(wealth, loss, hazard))
        # Strictly above the expected payout -- the concavity gap that makes the
        # trade possible at all.
        ok = p_max > hazard * loss
        if not ok:
            FAILURES.append((f"buyer_max > E[payout] W={wealth}", p_max, f"> {hazard*loss}"))
        print(f"  [{'ok  ' if ok else 'FAIL'}] p_max ${p_max:,.2f} > expected "
              f"payout ${hazard*loss:,.2f}")

    print("\n  seller's min premium is the root of seller growth = 0")
    for sv, loss, hazard in [(1000000.0, 30000.0, 0.05), (500000.0, 40000.0, 0.1),
                             (2000000.0, 10000.0, 0.02)]:
        p_min = A.ins_seller_min_premium(sv, loss, hazard)
        check(f"seller_growth(p_min) = 0  (V={sv}, L={loss}, pi={hazard})",
              A.ins_seller_growth(sv, p_min, loss, hazard), 0.0, tol=1e-8)
        ok = p_min > hazard * loss
        if not ok:
            FAILURES.append((f"seller_min > E[payout] V={sv}", p_min, f"> {hazard*loss}"))
        print(f"  [{'ok  ' if ok else 'FAIL'}] p_min ${p_min:,.2f} > expected "
              f"payout ${hazard*loss:,.2f}")

    # The band: at the textbook numbers, a real range exists where both sides
    # improve. This is the thing expected value alone cannot produce.
    p_max = A.ins_buyer_max_premium(100000.0, 30000.0, 0.05)
    p_min = A.ins_seller_min_premium(1000000.0, 30000.0, 0.05)
    ok = p_min < p_max
    if not ok:
        FAILURES.append(("premium band exists", p_min, f"< {p_max}"))
    print(f"\n  [{'ok  ' if ok else 'FAIL'}] band exists: seller_min ${p_min:,.2f} "
          f"< buyer_max ${p_max:,.2f}")
    mid = 0.5 * (p_min + p_max)
    ok = (A.ins_insured_growth(100000.0, mid) > A.ins_uninsured_growth(100000.0, 30000.0, 0.05)
          and A.ins_seller_growth(1000000.0, mid, 30000.0, 0.05) > 0.0)
    if not ok:
        FAILURES.append(("midpoint premium improves both sides", ok, True))
    print(f"  [{'ok  ' if ok else 'FAIL'}] a premium in the middle of the band "
          f"improves both sides' growth rate")

    print("\n  risk pooling vs Monte Carlo (200k draws per pool size)")
    for members in (2, 10, 50, 500):
        got = mc_pool_growth(members, 100000.0, 30000.0, 0.05)
        want = A.ins_pool_growth(members, 100000.0, 30000.0, 0.05)
        check(f"pool growth, n={members}", got, want, tol=3e-4)

    print("\n  pool growth rises monotonically toward the infinite-pool limit")
    sizes = [1, 2, 5, 10, 50, 200, 2000]
    growths = [A.ins_pool_growth(n, 100000.0, 30000.0, 0.05) for n in sizes]
    limit = A.ins_pool_limit(100000.0, 30000.0, 0.05)
    mono = all(b >= a - 1e-12 for a, b in zip(growths, growths[1:]))
    bounded = all(g <= limit + 1e-9 for g in growths)
    ok = mono and bounded
    if not ok:
        FAILURES.append(("pool growth monotone & bounded by limit", growths, limit))
    print(f"  [{'ok  ' if ok else 'FAIL'}] monotone: {mono}, bounded by the limit "
          f"({limit*100:.4f} %/period): {bounded}")
    check("n=1 pool equals the uninsured player",
          A.ins_pool_growth(1, 100000.0, 30000.0, 0.05),
          A.ins_uninsured_growth(100000.0, 30000.0, 0.05))

    # Break-even pool size: one smaller must fail to beat the premium, this size
    # must succeed (or n=1 already wins).
    n_be = A.ins_pool_break_even(2000.0, 100000.0, 30000.0, 0.05)
    target = A.ins_insured_growth(100000.0, 2000.0)
    ok = A.ins_pool_growth(n_be, 100000.0, 30000.0, 0.05) >= target - 1e-12
    if n_be > 1:
        ok = ok and A.ins_pool_growth(n_be - 1, 100000.0, 30000.0, 0.05) < target
    if not ok:
        FAILURES.append(("break-even pool is the smallest that wins", n_be, target))
    print(f"  [{'ok  ' if ok else 'FAIL'}] break-even pool size {n_be} is the "
          f"smallest that beats a $2,000 premium")

    print("\n  chart sweeps agree with the scalar functions they sample")
    xs, buyer, seller = A.ins_premium_curve(100000.0, 1000000.0, 30000.0, 0.05)
    i = len(xs) // 3
    check("premium curve buyer value", buyer[i],
          A.ins_buyer_value(100000.0, xs[i], 30000.0, 0.05))
    check("premium curve seller value", seller[i],
          A.ins_seller_value(1000000.0, xs[i], 30000.0, 0.05))
    # The band read off the curve (last positive-buyer, first positive-seller)
    # must bracket the same interval ins_summary reports from the closed forms.
    crosses = [x for x, b, s in zip(xs, buyer, seller) if b > 0 and s > 0]
    ok = bool(crosses) and min(crosses) >= p_min - 1e-6 and max(crosses) <= p_max + 1e-6
    if not ok:
        FAILURES.append(("premium curve band matches closed-form band", crosses,
                         (p_min, p_max)))
    print(f"  [{'ok  ' if ok else 'FAIL'}] every premium where the curve shows "
          f"both sides positive lies inside [${p_min:,.2f}, ${p_max:,.2f}]")

    sizes, growth = A.ins_pool_curve(100000.0, 30000.0, 0.05, max_members=200)
    check("pool curve at n=50", growth[49], A.ins_pool_growth(50, 100000.0, 30000.0, 0.05))


# -- 1h. Parrondo's paradox ---------------------------------------------------
def mc_parrondo_drift(q, eps=0.005, p_bad=0.1, p_good=0.75, n_paths=2000,
                      rounds=4000, seed=606):
    """Vectorised Monte Carlo of the long-run drift under the mixed strategy,
    independent of mulberry32 -- this checks the stationary-distribution
    formula, not the seeded-draw contract (simulate_parrondo's job)."""
    rng = np.random.default_rng(seed)
    x = np.zeros(n_paths, dtype=np.int64)
    for _ in range(rounds):
        residue = x % 3
        p_win = np.where(rng.random(n_paths) < q,
                         np.where(residue == 0, p_bad, p_good) - eps,
                         0.5 - eps)
        x += np.where(rng.random(n_paths) < p_win, 1, -1)
    return float(x.mean()) / rounds


def verify_parrondo():
    print("\nParrondo's paradox: stationary-distribution drift vs Monte Carlo")
    for q, eps in [(0.0, 0.005), (1.0, 0.005), (0.5, 0.005), (0.5, 0.01)]:
        got = mc_parrondo_drift(q, eps)
        want = A.pa_drift(q, eps)
        check(f"drift q={q} eps={eps}", got, want, tol=5e-3)

    print("\n  the paradox itself")
    s = A.pa_summary(q=0.5, eps=0.005)
    ok = s["drift_a"] < 0.0 and s["drift_b"] < 0.0 and s["drift_mix"] > 0.0
    if not ok:
        FAILURES.append(("Parrondo paradox at classic parameters", s, "A<0, B<0, mix>0"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] A alone {s['drift_a']*100:+.3f} %, "
          f"B alone {s['drift_b']*100:+.3f} %, 50/50 mix "
          f"{s['drift_mix']*100:+.3f} % -- both lose, the mix wins")

    pi = A.pa_stationary(0.5, 0.005)
    ok = abs(pi.sum() - 1.0) < 1e-9 and bool((pi >= -1e-12).all())
    if not ok:
        FAILURES.append(("Parrondo stationary distribution valid", list(pi),
                         "sums to 1, non-negative"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] stationary distribution sums to 1 "
          f"and is non-negative: {pi}")

    # Each PURE game is exactly fair at eps=0 -- q=0 trivially (game A never
    # depends on the residue, so its stationary distribution is uniform and
    # its drift is 2*0.5-1=0 identically); q=1 because game B's own
    # stationary distribution happens to weight p_bad and p_good into an
    # exact wash. Neither claim extends to a MIX of the two: mixing what is
    # individually fair still couples the residue you tend to be in with
    # which game's probability applies there, and that coupling alone -- not
    # eps -- is enough to produce a non-zero drift. That a q=0.5 mix of two
    # eps=0 games is *not* fair is a fact about this game, not a bug; an
    # earlier version of this check wrongly asserted it should be zero
    # everywhere and flagged a false failure.
    check("pure A is exactly fair at eps=0", A.pa_drift(0.0, 0.0, 0.1, 0.75), 0.0)
    check("pure B is exactly fair at eps=0", A.pa_drift(1.0, 0.0, 0.1, 0.75), 0.0,
          tol=1e-9)
    mix_drift = A.pa_drift(0.5, 0.0, 0.1, 0.75)
    ok = abs(mix_drift) > 1e-6
    if not ok:
        FAILURES.append(("mixing two fair eps=0 games stays biased", mix_drift, "!= 0"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] a 50/50 mix of two individually-fair "
          f"eps=0 games is itself biased ({mix_drift*100:+.3f} %/round) -- the "
          f"coupling, not the house edge, is what Parrondo's mechanism runs on")


# -- 1i. Base rates ------------------------------------------------------------
def verify_base_rates():
    print("\nBase rates: Bayes' theorem vs Monte Carlo, and internal identities")
    rng = np.random.default_rng(707)
    for prior, sens, spec in [(0.01, 0.95, 0.95), (0.1, 0.9, 0.8), (0.001, 0.99, 0.99)]:
        n = 2_000_000
        sick = rng.random(n) < prior
        pos = np.where(sick, rng.random(n) < sens, rng.random(n) < (1 - spec))
        got = float(sick[pos].mean()) if pos.any() else 0.0
        want = A.br_posterior_positive(prior, sens, spec)
        check(f"P(disease|+) prior={prior} sens={sens} spec={spec}", got, want, tol=5e-3)
        got_neg = float(sick[~pos].mean()) if (~pos).any() else 0.0
        want_neg = A.br_posterior_negative(prior, sens, spec)
        check(f"P(disease|-) prior={prior} sens={sens} spec={spec}", got_neg, want_neg,
              tol=5e-3)

    tp, fp, fn, tn = A.br_counts(0.01, 0.95, 0.95, 1000)
    check("counts reproduce posterior", tp / (tp + fp),
          A.br_posterior_positive(0.01, 0.95, 0.95))
    check("population accounted for", tp + fp + fn + tn, 1000.0)

    classic = A.br_posterior_positive(0.01, 0.95, 0.95)
    ok = abs(classic - 0.161) < 0.001
    if not ok:
        FAILURES.append(("classic 95%/95%/1% posterior ~ 16.1%", classic, 0.161))
    print(f"  [{'ok  ' if ok else 'FAIL'}] classic parameters give "
          f"{classic*100:.2f} % (not 95 %) -- the base-rate fallacy in one number")

    xs, ys = A.br_prevalence_curve(0.95, 0.95)
    ok = all(a <= b + 1e-12 for a, b in zip(ys, ys[1:]))
    if not ok:
        FAILURES.append(("posterior monotone increasing in prevalence", ys, "non-decreasing"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] P(disease|+) rises monotonically with prevalence")


# -- 1j. The birthday problem --------------------------------------------------
def verify_birthday():
    print("\nBirthday problem: closed form vs Monte Carlo, and the hash extension")
    rng = np.random.default_rng(808)
    for n, days in [(23, 365), (10, 365), (50, 365), (5, 30)]:
        trials = 200_000
        draws = rng.integers(0, days, size=(trials, n))
        # Sort each row and look for an adjacent equal pair -- a vectorised
        # stand-in for "fewer than n unique values" that needs no per-row set.
        sorted_draws = np.sort(draws, axis=1)
        collided = (np.diff(sorted_draws, axis=1) == 0).any(axis=1)
        got = float(collided.mean())
        want = A.bd_collision_prob(n, days)
        check(f"P(collision) n={n} days={days}", got, want, tol=5e-3)

    check("n=23, d=365 is the classic ~50.7%", A.bd_collision_prob(23, 365), 0.5073,
          tol=2e-4)
    check("pairs(23) = 253", A.bd_pairs(23), 253.0)
    check("half-life n for d=365 is 23", A.bd_half_life_n(365), 23)
    check("n > days forces a collision", A.bd_collision_prob(400, 365), 1.0)

    print("\n  hash-bits approximation vs exact enumeration (small bit counts)")
    for bits in (8, 10, 12, 14):
        days = 2 ** bits
        exact = A.bd_half_life_n(float(days))
        approx = A.bd_hash_n50_approx(bits)
        ratio = approx / exact
        ok = 0.85 <= ratio <= 1.15
        if not ok:
            FAILURES.append((f"hash approx @ {bits} bits", approx, f"~{exact}"))
        print(f"  [{'ok  ' if ok else 'FAIL'}] {bits} bits: exact {exact}, "
              f"approx {approx:.1f} (ratio {ratio:.3f})")


# -- 1k. The secretary problem --------------------------------------------------
def exact_secretary(s, n):
    """Brute-force reference: enumerate all n! permutations exactly. Only
    used for small n -- an independent check on the closed form, not how it
    is computed."""
    wins = total = 0
    for perm in itertools.permutations(range(n)):
        total += 1
        best_before = min(perm[:s]) if s > 0 else n
        pick = n - 1
        for i in range(s, n):
            if perm[i] < best_before:
                pick = i
                break
        if perm[pick] == 0:
            wins += 1
    return wins / total


def mc_secretary(s, n, trials=50_000, seed=909):
    rng = np.random.default_rng(seed)
    wins = 0
    for _ in range(trials):
        perm = rng.permutation(n)
        best_before = perm[:s].min() if s > 0 else n
        pick = n - 1
        for i in range(s, n):
            if perm[i] < best_before:
                pick = i
                break
        if perm[pick] == 0:
            wins += 1
    return wins / trials


def verify_secretary():
    print("\nSecretary problem: closed form vs brute-force enumeration (small n)")
    for s, n in [(0, 6), (1, 6), (2, 6), (3, 7), (0, 8)]:
        got = exact_secretary(s, n)
        want = A.sec_win_prob(s, n)
        check(f"exact n={n} s={s}", got, want, tol=1e-9)

    print("\n  hand cases")
    check("n=1", A.sec_win_prob(0, 1), 1.0)
    check("n=2, s=0", A.sec_win_prob(0, 2), 0.5)
    check("n=2, s=1", A.sec_win_prob(1, 2), 0.5)

    print("\n  larger n vs Monte Carlo")
    for s, n in [(37, 100), (10, 50), (0, 100)]:
        got = mc_secretary(s, n)
        want = A.sec_win_prob(s, n)
        check(f"MC n={n} s={s}", got, want, tol=8e-3)

    print("\n  convergence to 1/e")
    ns, ys = A.sec_asymptotic_curve(min_n=50, max_n=2000, points=30)
    ok = abs(ys[-1] - (1.0 / math.e)) < 0.01
    if not ok:
        FAILURES.append(("optimal win prob converges to 1/e", ys[-1], 1.0 / math.e))
    print(f"  [{'ok  ' if ok else 'FAIL'}] at n={ns[-1]}: optimal P(win) = "
          f"{ys[-1]*100:.3f} % (1/e = {100/math.e:.3f} %)")

    best_s, best_p = A.sec_optimal(100)
    check("optimal skip at n=100 is 37", float(best_s), 37.0)
    ok = abs(best_s / 100 - 1 / math.e) < 0.05
    print(f"  [{'ok  ' if ok else 'FAIL'}] optimal fraction {best_s/100:.3f} "
          f"~ 1/e = {1/math.e:.3f}")


# -- 1l. The two-envelope paradox ----------------------------------------------
def verify_two_envelope():
    print("\nTwo-envelope paradox: closed form vs Monte Carlo")
    rng = np.random.default_rng(1010)
    for rate in (0.01, 0.05, 0.002):
        n = 4_000_000
        s = rng.exponential(1.0 / rate, size=n)
        smaller_shown = rng.random(n) < 0.5
        x = np.where(smaller_shown, s, 2.0 * s)
        for frac in (0.3, 1.0, 3.0):
            x0 = frac / rate
            width = 0.2 / rate
            in_bin = (x >= x0 - width / 2) & (x < x0 + width / 2)
            if in_bin.sum() < 1000:
                continue
            got = float(smaller_shown[in_bin].mean())
            want = A.te_p_smaller(x0, rate)
            check(f"P(smaller | x~{frac}/rate) rate={rate}", got, want, tol=2e-2)

    print("\n  exact identities")
    for rate in (0.01, 0.05):
        xstar = A.te_crossover(rate)
        check(f"gain(x*) = 0, rate={rate}", A.te_swap_gain(xstar, rate), 0.0, tol=1e-6)
        check(f"P(smaller|x*) = 1/3, rate={rate}", A.te_p_smaller(xstar, rate),
              1.0 / 3.0, tol=1e-9)

    rate = 0.02
    n = 4_000_000
    s = rng.exponential(1.0 / rate, size=n)
    smaller_shown = rng.random(n) < 0.5
    x = np.where(smaller_shown, s, 2.0 * s)
    other = np.where(smaller_shown, 2.0 * s, s)
    unconditional_gain = float((other - x).mean())
    ok = abs(unconditional_gain) < 0.05 * (1.0 / rate)
    if not ok:
        FAILURES.append(("unconditional swap gain ~ 0", unconditional_gain, 0.0))
    print(f"  [{'ok  ' if ok else 'FAIL'}] unconditional E[gain from always "
          f"swapping] ~ 0: got {unconditional_gain:.3f} "
          f"(mean smaller = {1/rate:.1f})")

    xstar = A.te_crossover(0.01)
    below = A.te_swap_gain(xstar * 0.5, 0.01)
    above = A.te_swap_gain(xstar * 1.5, 0.01)
    ok = below > 0.0 and above < 0.0
    if not ok:
        FAILURES.append(("swap gain changes sign at crossover", (below, above), "(+, -)"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] gain is positive below the crossover "
          f"({below:+.2f}) and negative above it ({above:+.2f})")


# -- 1m. Optional stopping ------------------------------------------------------
def mc_optional_stopping(looks, batch, alpha, n=60_000, seed=1111):
    """Vectorised Monte Carlo, independent of the forward DP: walk n paths all
    the way out and check, at each look boundary, whether the moving boundary
    was ever crossed."""
    rng = np.random.default_rng(seed)
    z = A.os_z_threshold(alpha)
    total = looks * batch
    steps = np.where(rng.random((n, total)) < 0.5, 1, -1).astype(np.int32)
    cum = np.cumsum(steps, axis=1)
    ever = np.zeros(n, dtype=bool)
    for look in range(1, looks + 1):
        idx = look * batch - 1
        boundary = z * math.sqrt(look * batch)
        ever |= np.abs(cum[:, idx]) >= boundary
    return float(ever.mean())


def verify_optional_stopping():
    print("\nOptional stopping: forward DP vs Monte Carlo")
    for looks, batch, alpha in [(40, 20, 0.05), (10, 50, 0.05), (20, 10, 0.10)]:
        got = mc_optional_stopping(looks, batch, alpha)
        want = A.os_false_positive_rate(looks, batch, alpha)
        check(f"cumulative FP rate looks={looks} batch={batch} alpha={alpha}",
              got, want, tol=8e-3)

    print("\n  structural properties")
    # A single look is exactly a discrete two-sided binomial tail test, so it
    # can be checked against scipy's own binomial CDF directly -- an
    # independent exact computation, not another Monte Carlo estimate. It is
    # NOT expected to equal the nominal continuous alpha: at batch=50 the
    # z=1.96 boundary (13.86 in S-units) snaps up to the nearest reachable
    # even integer (14), and that discreteness alone moves the true rate to
    # ~6.5%. An earlier version of this check wrongly asserted equality to
    # the nominal 5% and flagged this real, expected gap as a failure.
    batch = 50
    z = A.os_z_threshold(0.05)
    h_hi = math.ceil((z * math.sqrt(batch) + batch) / 2)
    exact_single_look = float(A.binom.sf(h_hi - 1, batch, 0.5)
                              + A.binom.cdf(batch - h_hi, batch, 0.5))
    xs, ys = A.os_false_positive_curve(looks=1, batch=batch, alpha=0.05)
    check("single look matches the exact binomial tail (not the nominal alpha)",
          ys[0], exact_single_look, tol=1e-9)

    # The discreteness gap narrows as the per-look sample size grows -- a much
    # larger batch should land close to the nominal continuous alpha.
    xs, ys = A.os_false_positive_curve(looks=1, batch=4000, alpha=0.05)
    ok = abs(ys[0] - 0.05) < 3e-3
    if not ok:
        FAILURES.append(("large-batch single look approaches nominal alpha", ys[0], 0.05))
    print(f"  [{'ok  ' if ok else 'FAIL'}] batch=4000: single-look rate "
          f"{ys[0]*100:.3f} % is close to the nominal 5 % "
          f"(batch=50 gives {exact_single_look*100:.2f} % -- discreteness, not error)")

    xs, ys = A.os_false_positive_curve(looks=60, batch=15, alpha=0.05)
    ok = all(a <= b + 1e-12 for a, b in zip(ys, ys[1:]))
    if not ok:
        FAILURES.append(("cumulative FP rate monotone non-decreasing", ys, "non-decreasing"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] cumulative false-positive rate never "
          f"decreases across {len(ys)} looks")

    late = ys[-1]
    ok = late > 3.0 * 0.05
    if not ok:
        FAILURES.append(("many looks inflate FP rate well past nominal", late, "> 0.15"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] after {len(ys)} looks: cumulative "
          f"rate {late*100:.1f} % vs nominal 5 %")

    check("Bonferroni alpha = 0.05/40", A.os_bonferroni_alpha(looks=40, alpha=0.05),
          0.05 / 40)


# -- 1n. Simpson's paradox ------------------------------------------------------
def mc_simpsons(p_easy, p_hard, delta, w_a, w_b, n=1_000_000, seed=2024):
    """Monte Carlo, independent of the algebra: draw each treatment's cases
    from its own easy/hard mix, flip a success for each at that subgroup's
    own rate, and report the four subgroup rates and the two pooled rates as
    plain sample fractions."""
    rng = np.random.default_rng(seed)
    out = {}
    for tag, w, bump in (("a", w_a, delta), ("b", w_b, 0.0)):
        easy = rng.random(n) < w
        rate = np.where(easy, p_easy + bump, p_hard + bump)
        succ = rng.random(n) < rate
        out[f"easy_{tag}"] = float(succ[easy].mean()) if easy.any() else 0.0
        out[f"hard_{tag}"] = float(succ[~easy].mean()) if (~easy).any() else 0.0
        out[f"pooled_{tag}"] = float(succ.mean())
    return out


def verify_simpsons():
    print("\nSimpson's paradox: closed forms vs Monte Carlo, and the reversal "
          "condition brute-forced")
    cases = [
        dict(p_easy=0.9, p_hard=0.4, delta=0.05, w_a=0.2, w_b=0.8),
        dict(p_easy=0.7, p_hard=0.3, delta=0.15, w_a=0.35, w_b=0.65),
        dict(p_easy=0.6, p_hard=0.5, delta=0.20, w_a=0.1, w_b=0.9),
    ]
    for c in cases:
        print(f"\n  case {c}")
        mc = mc_simpsons(**c)
        s = A.simpsons_summary(**c)
        # Absolute tolerance, as always for probabilities. The pooled rates
        # get all 1e6 draws (SE ~5e-4), but a subgroup rate only gets its own
        # share: at w_b = 0.9 the hard-B cell is 100k draws, SE ~1.6e-3, so
        # the subgroup bar has to be the looser one. Tightening it to 3e-3
        # flagged a 2-sigma sample as a formula error.
        check("rate A|easy", mc["easy_a"], s["rate_easy_a"], tol=8e-3)
        check("rate A|hard", mc["hard_a"], s["rate_hard_a"], tol=8e-3)
        check("rate B|easy", mc["easy_b"], s["rate_easy_b"], tol=8e-3)
        check("rate B|hard", mc["hard_b"], s["rate_hard_b"], tol=8e-3)
        check("pooled A", mc["pooled_a"], s["pooled_a"], tol=3e-3)
        check("pooled B", mc["pooled_b"], s["pooled_b"], tol=3e-3)
        check("pooled diff = delta - delta_critical", s["pooled_diff"],
              c["delta"] - s["delta_critical"])
        # The simulation must reproduce the qualitative verdict too, not just
        # the six numbers -- that is the claim the scenario actually makes.
        mc_reverses = ((mc["easy_a"] > mc["easy_b"]) and (mc["hard_a"] > mc["hard_b"])
                       and (mc["pooled_a"] < mc["pooled_b"]))
        ok = mc_reverses == s["reverses"]
        if not ok:
            FAILURES.append(("simulated verdict matches `reverses`", mc_reverses,
                             s["reverses"]))
        print(f"  [{'ok  ' if ok else 'FAIL'}] simulated verdict: "
              f"reverses={mc_reverses} (closed form: {s['reverses']})")

    print("\n  reversal condition brute-forced over a parameter grid")
    grid_n = grid_bad = 0
    for p_hard in (0.1, 0.3, 0.5):
        for gap in (0.05, 0.2, 0.4):
            p_easy = p_hard + gap
            for w_a in (0.1, 0.3, 0.5, 0.7, 0.9):
                for w_b in (0.1, 0.3, 0.5, 0.7, 0.9):
                    for delta in (-0.25, -0.1, -0.02, 0.0, 0.02, 0.05, 0.1, 0.25):
                        if not (0.0 <= p_hard + delta and p_easy + delta <= 1.0):
                            continue
                        crit0 = (w_b - w_a) * (p_easy - p_hard)
                        if abs(delta - crit0) < 1e-12:
                            # Exactly on the boundary. (w_b - w_a)*(p_easy -
                            # p_hard) is a product of two floats and lands a
                            # few ULPs away from the delta it is being
                            # compared with -- 0.4 * 0.05 is
                            # 0.020000000000000004, not 0.02 -- so a strict
                            # inequality and a sign test can genuinely
                            # disagree here while both are right about every
                            # point that is not measure-zero. Skipped rather
                            # than papered over with a fuzzy comparison,
                            # which would weaken the test everywhere else.
                            continue
                        grid_n += 1
                        # Brute force: recompute both pooled rates from the
                        # four subgroup rates directly, with no reference to
                        # delta_critical, and read the verdict off them.
                        ae, ah = p_easy + delta, p_hard + delta
                        pa = w_a * ae + (1 - w_a) * ah
                        pb = w_b * p_easy + (1 - w_b) * p_hard
                        brute = ((ae > p_easy and ah > p_hard and pa < pb)
                                 or (ae < p_easy and ah < p_hard and pa > pb))
                        got = A.simpsons_reverses(p_easy, p_hard, delta, w_a, w_b)
                        crit = A.simpsons_delta_critical(p_easy, p_hard, w_a, w_b)
                        # And the closed-form criterion, stated as the
                        # inequality rather than as a sign comparison.
                        crit_form = (0.0 < delta < crit) or (crit < delta < 0.0)
                        if not (brute == got == crit_form):
                            grid_bad += 1
                            if grid_bad <= 3:
                                FAILURES.append(
                                    (f"reversal grid p_easy={p_easy:.2f} "
                                     f"p_hard={p_hard} w_a={w_a} w_b={w_b} "
                                     f"delta={delta}",
                                     (brute, got, crit_form), "all equal"))
    ok = grid_bad == 0
    print(f"  [{'ok  ' if ok else 'FAIL'}] {grid_n} parameter combinations: "
          f"brute force, `simpsons_reverses`, and delta < (w_b - w_a)(p_easy - "
          f"p_hard) agree in {grid_n - grid_bad} of them")

    print("\n  the reversal boundary is exactly delta_critical")
    for c in cases:
        crit = A.simpsons_delta_critical(c["p_easy"], c["p_hard"], c["w_a"], c["w_b"])
        eps = 1e-9
        just_below = A.simpsons_reverses(c["p_easy"], c["p_hard"], crit - eps,
                                         c["w_a"], c["w_b"])
        just_above = A.simpsons_reverses(c["p_easy"], c["p_hard"], crit + eps,
                                         c["w_a"], c["w_b"])
        ok = just_below and not just_above
        if not ok:
            FAILURES.append((f"boundary at delta_critical={crit:.6f}",
                             (just_below, just_above), "(True, False)"))
        print(f"  [{'ok  ' if ok else 'FAIL'}] crit={crit:.4f}: reverses just "
              f"below ({just_below}) and not just above ({just_above})")

    print("\n  the counts table is internally consistent (no off-by-one margins)")
    bad = 0
    for c in cases:
        for n_a, n_b in ((200, 200), (37, 91), (1, 1000), (50, 50), (7, 13)):
            k = A.simpsons_counts(n_a=n_a, n_b=n_b, **c)
            checks = [
                k["easy_a"] + k["hard_a"] == k["n_a"],
                k["easy_b"] + k["hard_b"] == k["n_b"],
                k["succ_easy_a"] + k["succ_hard_a"] == k["succ_a"],
                k["succ_easy_b"] + k["succ_hard_b"] == k["succ_b"],
                0 <= k["succ_easy_a"] <= k["easy_a"],
                0 <= k["succ_hard_a"] <= k["hard_a"],
                0 <= k["succ_easy_b"] <= k["easy_b"],
                0 <= k["succ_hard_b"] <= k["hard_b"],
                k["succ_a"] <= k["n_a"], k["succ_b"] <= k["n_b"],
            ]
            if not all(checks):
                bad += 1
                FAILURES.append((f"counts consistent n_a={n_a} n_b={n_b}", k,
                                 "parts sum to the whole"))
    ok = bad == 0
    print(f"  [{'ok  ' if ok else 'FAIL'}] 15 count tables: every margin is the "
          f"sum of its own cells, every cell within its total")

    # The counts view must not flip the verdict at a sensible group size --
    # a rounded table that disagrees with the rates it came from is worse
    # than no table.
    k = A.simpsons_counts(**cases[0], n_a=200, n_b=200)
    ok = (k["rate_easy_a"] > k["rate_easy_b"] and k["rate_hard_a"] > k["rate_hard_b"]
          and k["rate_a"] < k["rate_b"])
    if not ok:
        FAILURES.append(("counts table shows the same reversal as the rates", k,
                         "reversal preserved"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] the 200/200 count table reverses too: "
          f"A {k['succ_easy_a']}/{k['easy_a']} and {k['succ_hard_a']}/{k['hard_a']} "
          f"beats B {k['succ_easy_b']}/{k['easy_b']} and "
          f"{k['succ_hard_b']}/{k['hard_b']}, but {k['succ_a']}/{k['n_a']} loses to "
          f"{k['succ_b']}/{k['n_b']}")

    xs, ys = A.simpsons_delta_curve(**{k2: v for k2, v in cases[0].items()
                                       if k2 != "delta"})
    ok = all(b - a > -1e-12 for a, b in zip(ys, ys[1:]))
    if not ok:
        FAILURES.append(("pooled diff increases with delta", ys, "non-decreasing"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] pooled difference rises monotonically "
          f"with the true effect, crossing zero once")


# -- 1o. Bertrand's paradox -----------------------------------------------------
def mc_bertrand(method, c, n=2_000_000, seed=3131, radius=1.0):
    """Monte Carlo that implements the three sampling rules *geometrically*
    and reads the chord length off the two endpoints with Pythagoras -- no
    reference to any of the closed forms, which is the whole point: a
    simulation that reused `1 - c^2` would only prove `1 - c^2 == 1 - c^2`.

    Returns (fraction longer than 2Rc, mean length, midpoint distances / R).
    """
    rng = np.random.default_rng(seed)
    if method == "endpoints":
        a1 = rng.random(n) * 2 * math.pi
        a2 = rng.random(n) * 2 * math.pi
        x1, y1 = radius * np.cos(a1), radius * np.sin(a1)
        x2, y2 = radius * np.cos(a2), radius * np.sin(a2)
    else:
        phi = rng.random(n) * 2 * math.pi
        if method == "radius":
            # Uniform along a uniformly chosen radius.
            d = radius * rng.random(n)
        elif method == "midpoint":
            # Uniform over the disc, by rejection sampling in the bounding
            # square -- deliberately not the sqrt() inverse-CDF trick the
            # sampler in analytics.py uses, so the two cannot share a bug.
            xs, ys = [], []
            need = n
            while need > 0:
                bx = rng.random(need * 2) * 2 - 1
                by = rng.random(need * 2) * 2 - 1
                keep = bx * bx + by * by <= 1.0
                xs.append(bx[keep]); ys.append(by[keep])
                need -= int(keep.sum())
            mxa = np.concatenate(xs)[:n] * radius
            mya = np.concatenate(ys)[:n] * radius
            d = np.hypot(mxa, mya)
            phi = np.arctan2(mya, mxa)
        else:
            raise ValueError(method)
        mx, my = d * np.cos(phi), d * np.sin(phi)
        half = np.sqrt(np.maximum(0.0, radius * radius - d * d))
        dx, dy = -np.sin(phi), np.cos(phi)
        x1, y1 = mx + half * dx, my + half * dy
        x2, y2 = mx - half * dx, my - half * dy
    length = np.hypot(x2 - x1, y2 - y1)
    u = np.hypot(0.5 * (x1 + x2), 0.5 * (y1 + y2)) / radius
    return float((length > 2.0 * radius * c).mean()), float(length.mean()), u


def verify_bertrand():
    print("\nBertrand's paradox: three closed forms vs three geometric Monte Carlos")
    root3_2 = math.sqrt(3.0) / 2.0
    for c in (root3_2, 0.5, 0.25, 0.95):
        print(f"\n  c = L/(2R) = {c:.6f}")
        for method in A.BERTRAND_METHODS:
            got, mean_len, u = mc_bertrand(method, c)
            want = A.bertrand_prob(method, c)
            # Absolute tolerance: probabilities, ~3.5e-4 standard error at 2M.
            check(f"P(long) {method}", got, want, tol=3e-3)
            check(f"E[length] {method}", mean_len,
                  A.bertrand_mean_length(method, 1.0), tol=3e-3)
            # The midpoint-distance CDF is what a scatter of the three clouds
            # actually shows, so check it away from the one threshold above.
            for t in (0.2, 0.5, 0.8):
                check(f"F_u({t}) {method}", float((u <= t).mean()),
                      A.bertrand_midpoint_cdf(method, t), tol=3e-3)

    print("\n  the classical identity at c = sqrt(3)/2 (inscribed triangle's side)")
    check("random endpoints = 1/3", A.bertrand_prob_endpoints(root3_2), 1.0 / 3.0,
          tol=1e-12)
    check("random radius    = 1/2", A.bertrand_prob_radius(root3_2), 1.0 / 2.0,
          tol=1e-12)
    check("random midpoint  = 1/4", A.bertrand_prob_midpoint(root3_2), 1.0 / 4.0,
          tol=1e-12)

    print("\n  structural identities")
    for c in (0.1, root3_2, 0.5, 0.9, 0.999):
        thresh = A.bertrand_threshold(c)
        for method in A.BERTRAND_METHODS:
            check(f"P = F_u(sqrt(1-c^2)) {method} c={c:.4f}",
                  A.bertrand_prob(method, c),
                  A.bertrand_midpoint_cdf(method, thresh), tol=1e-12)
    check("c -> 0: every rule says 'certainly longer' (endpoints)",
          A.bertrand_prob_endpoints(0.0), 1.0)
    check("c -> 1: every rule says 'never longer' (midpoint)",
          A.bertrand_prob_midpoint(1.0), 0.0)

    # The random-radius rule is the most generous everywhere in (0,1):
    # sqrt(1-c^2) > 1-c^2 trivially, and with c = sin(theta) the comparison
    # against the endpoints rule is cos(theta) > 1 - 2*theta/pi, which holds
    # strictly on (0, pi/2) and touches only at the two ends.
    bad = 0
    for i in range(1, 1000):
        c = i / 1000.0
        pe, pr, pm = (A.bertrand_prob_endpoints(c), A.bertrand_prob_radius(c),
                      A.bertrand_prob_midpoint(c))
        if not (pr > pm and pr > pe):
            bad += 1
    ok = bad == 0
    if not ok:
        FAILURES.append(("random radius is the largest answer on (0,1)", bad, 0))
    print(f"  [{'ok  ' if ok else 'FAIL'}] the random-radius rule gives the "
          f"largest probability at all 999 interior c values")

    # The other two DO cross, which an earlier version of this check wrongly
    # asserted they did not: P_midpoint = 1 - c^2 beats P_endpoints for small
    # c and loses for large c, swapping where c^2 = (2/pi) arcsin c. So there
    # is no fixed ranking of the three rules -- only the radius rule keeps its
    # place -- and the crossing sits below the classical c = sqrt(3)/2, which
    # is why the classical statement reads 1/3 > 1/4 rather than the other way
    # round.
    lo, hi = 0.3, 0.99
    gap = lambda x: A.bertrand_prob_midpoint(x) - A.bertrand_prob_endpoints(x)
    ok = gap(lo) > 0 > gap(hi)
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if gap(mid) > 0:
            lo = mid
        else:
            hi = mid
    cross = 0.5 * (lo + hi)
    ok = ok and abs(gap(cross)) < 1e-12 and cross < root3_2
    if not ok:
        FAILURES.append(("midpoint and endpoints cross exactly once below "
                         "sqrt(3)/2", cross, "a root in (0.3, 0.99)"))
    print(f"  [{'ok  ' if ok else 'FAIL'}] P_midpoint and P_endpoints swap "
          f"order at c = {cross:.9f} (below the classical {root3_2:.6f}), so "
          f"only the radius rule has a fixed place in the ranking")

    # And that root is exactly 1/sqrt(2): c^2 = (2/pi) arcsin c has the
    # solution arcsin c = pi/4, where both rules give exactly 1/2. Found
    # numerically first, then recognised -- so it is asserted as an identity
    # rather than as "the bisection landed near 0.7071".
    inv_root2 = 1.0 / math.sqrt(2.0)
    check("the crossing is exactly 1/sqrt(2)", cross, inv_root2, tol=1e-12)
    check("P_midpoint(1/sqrt2) = 1/2", A.bertrand_prob_midpoint(inv_root2), 0.5,
          tol=1e-12)
    check("P_endpoints(1/sqrt2) = 1/2", A.bertrand_prob_endpoints(inv_root2), 0.5,
          tol=1e-12)

    print("\n  the seeded samplers reproduce their own rules")
    for method in A.BERTRAND_METHODS:
        emp = A.bertrand_empirical(method, n=60000, radius=1.0, c=root3_2, seed=4242)
        check(f"seeded sample P(long) {method}", emp,
              A.bertrand_prob(method, root3_2), tol=8e-3)
    # Geometry sanity: every sampled chord's endpoints sit on the circle, and
    # its midpoint is where the sampler says it is.
    bad = 0
    for method in A.BERTRAND_METHODS:
        for ch in A.bertrand_sample(method, n=500, radius=2.5, c=root3_2, seed=11):
            r1 = math.hypot(ch["x1"], ch["y1"])
            r2 = math.hypot(ch["x2"], ch["y2"])
            mid = math.hypot(0.5 * (ch["x1"] + ch["x2"]),
                             0.5 * (ch["y1"] + ch["y2"]))
            leng = math.hypot(ch["x2"] - ch["x1"], ch["y2"] - ch["y1"])
            if (abs(r1 - 2.5) > 1e-9 or abs(r2 - 2.5) > 1e-9
                    or abs(mid - 2.5 * ch["u"]) > 1e-9
                    or abs(leng - ch["length"]) > 1e-9):
                bad += 1
    ok = bad == 0
    if not ok:
        FAILURES.append(("sampled chords are chords", bad, 0))
    print(f"  [{'ok  ' if ok else 'FAIL'}] 1500 sampled chords: both endpoints on "
          f"the circle, reported midpoint distance and length match the geometry")


# -- 2. golden values for the JS engine --------------------------------------
GOLDEN_CASES = [
    dict(w0=100.0, rounds=100, p=0.5, up=1.5, down=0.6, f=1.0),
    dict(w0=100.0, rounds=100, p=0.5, up=1.5, down=0.6, f=0.25),
    dict(w0=100.0, rounds=250, p=0.5, up=1.5, down=0.6, f=0.5),
    dict(w0=100.0, rounds=60, p=0.6, up=1.4, down=0.7, f=0.5),
    dict(w0=100.0, rounds=40, p=0.35, up=1.9, down=0.5, f=0.3),
]

RUIN_GOLDEN = [
    dict(bankroll=100.0, target=200.0, p=0.49, bet=5.0),
    dict(bankroll=100.0, target=200.0, p=0.50, bet=5.0),
    dict(bankroll=100.0, target=200.0, p=0.49, bet=50.0),
    dict(bankroll=50.0, target=250.0, p=0.55, bet=10.0),
    # A long unfavourable walk: the case where the unrearranged formula overflows.
    dict(bankroll=1000.0, target=100000.0, p=0.45, bet=1.0),
]

SP_GOLDEN = [
    dict(p=0.5, m=2.0, tiers=31, plays=20000),   # the classic, on the boundary
    dict(p=0.4, m=2.0, tiers=31, plays=20000),   # convergent: E is finite
    dict(p=0.5, m=3.0, tiers=20, plays=5000),    # divergent faster than classic
    dict(p=0.6, m=1.5, tiers=40, plays=50000),   # m*p = 0.9, convergent
]

PD_GOLDEN = [
    dict(rounds=50, t=5.0, noise=0.0, generations=60),
    dict(rounds=20, t=4.0, noise=0.05, generations=30),
    dict(rounds=100, t=5.9, noise=0.15, generations=40),
]

MH_GOLDEN = [
    dict(doors=3, opened=1, know=1.0),   # the classic puzzle
    dict(doors=3, opened=1, know=0.0),   # lucky host: no information at all
    dict(doors=3, opened=1, know=0.6),   # a dial in between
    dict(doors=5, opened=3, know=1.0),
    dict(doors=10, opened=1, know=0.8),
]

SD_GOLDEN = [
    dict(rounds=200, p=0.5, vol=0.3, w=0.5, interval=1, cost=0.0),
    dict(rounds=200, p=0.5, vol=0.3, w=0.5, interval=5, cost=0.0),
    dict(rounds=200, p=0.5, vol=0.15, w=0.3, interval=1, cost=0.01),
    dict(rounds=400, p=0.55, vol=0.3, w=0.5, interval=1, cost=0.0),
]

INS_GOLDEN = [
    dict(wealth=100000.0, seller_wealth=1000000.0, premium=2000.0, loss=30000.0,
         hazard=0.05, members=50),
    dict(wealth=50000.0, seller_wealth=500000.0, premium=5000.0, loss=40000.0,
         hazard=0.1, members=20),
    dict(wealth=200000.0, seller_wealth=5000000.0, premium=300.0, loss=10000.0,
         hazard=0.02, members=200),
]


PA_GOLDEN = [
    dict(q=0.5, eps=0.005, p_bad=0.1, p_good=0.75),
    dict(q=0.0, eps=0.005, p_bad=0.1, p_good=0.75),
    dict(q=1.0, eps=0.005, p_bad=0.1, p_good=0.75),
    dict(q=0.6, eps=0.01, p_bad=0.15, p_good=0.7),
]

BR_GOLDEN = [
    dict(prior=0.01, sens=0.95, spec=0.95, population=1000),
    dict(prior=0.1, sens=0.9, spec=0.8, population=1000),
    dict(prior=0.001, sens=0.99, spec=0.99, population=100000),
]

BD_GOLDEN = [
    dict(n=23, days=365.0, bits=8),
    dict(n=10, days=365.0, bits=16),
    dict(n=50, days=1000.0, bits=32),
]

SEC_GOLDEN = [
    dict(s=37, n=100),
    dict(s=7, n=20),
    dict(s=0, n=50),
]

TE_GOLDEN = [
    dict(x=100.0, rate=0.01),
    dict(x=500.0, rate=0.01),
    dict(x=50.0, rate=0.05),
]

SIMPSONS_GOLDEN = [
    dict(p_easy=0.9, p_hard=0.4, delta=0.05, w_a=0.2, w_b=0.8, n_a=200, n_b=200),
    dict(p_easy=0.7, p_hard=0.3, delta=0.15, w_a=0.35, w_b=0.65, n_a=137, n_b=91),
    # delta above the critical value: no reversal, so the JS side is checked
    # on the false branch as well as the true one.
    dict(p_easy=0.9, p_hard=0.4, delta=0.35, w_a=0.2, w_b=0.8, n_a=50, n_b=50),
    # w_a == w_b: delta_critical is exactly zero, the degenerate boundary.
    dict(p_easy=0.8, p_hard=0.2, delta=0.05, w_a=0.5, w_b=0.5, n_a=100, n_b=100),
]

BERTRAND_GOLDEN = [
    dict(c=math.sqrt(3.0) / 2.0, radius=1.0, n=200, seed=7),   # the classic
    dict(c=0.5, radius=1.0, n=120, seed=7),
    dict(c=0.25, radius=2.5, n=80, seed=99),
]

OS_GOLDEN = [
    dict(looks=40, batch=20, alpha=0.05),
    dict(looks=10, batch=50, alpha=0.05),
    dict(looks=20, batch=10, alpha=0.10),
]

WHEEL_BS_GOLDEN = [
    dict(s=100.0, k=95.0, t=0.5, sigma=0.24, r=0.03, q=0.0, mu=0.08),
    dict(s=100.0, k=100.0, t=0.25, sigma=0.20, r=0.02, q=0.01, mu=0.05),
    dict(s=50.0, k=55.0, t=1.0, sigma=0.35, r=0.04, q=0.0, mu=0.10),
]

HOLD_GOLDEN = [
    dict(w0=100000.0, mu=0.08, sigma=0.20, q=0.0, years=5.0),
    dict(w0=50000.0, mu=0.05, sigma=0.35, q=0.02, years=3.0),
]

# Small enough that a 1-year path still produces at least one full put-to-
# assignment cycle at seed=7 (checked against the same trigger days the
# manual investigation during development found: sell at t=89, assign at
# t=215), while staying light enough for tests.html to check bit for bit.
WHEEL_SIM_CFG = dict(w0=20000.0, s0=100.0, mu=0.08, sigma_rv=0.20, sigma_iv=0.24,
                     r=0.03, q=0.0, years=1.0, x_months=6.0, y_months=3.0,
                     dip_pct=0.05, sell_haircut=0.10, share_sl=0.20,
                     call_tp=0.70,
                     stock_fee_pct=0.005, opt_fee=0.65, seed=7)

# Deliberately tiny -- this is only checking that engine.js's sweep loop
# agrees with analytics.py's, not producing a chart-quality curve.
WHEEL_SWEEP_CFG = dict(w0=20000.0, s0=100.0, mu=0.08, sigma_rv=0.20, r=0.03,
                       q=0.0, years=1.0, x_months=6.0, y_months=3.0,
                       dip_pct=0.05, sell_haircut=0.10, share_sl=0.20,
                       call_tp=0.70, stock_fee_pct=0.005,
                       opt_fee=0.65, points=4, n_seeds=3, spread_lo=-0.05,
                       spread_hi=0.10, base_seed=500)


def emit_golden():
    print("\nEmitting js/golden.js")

    prng = {}
    for seed in (7, 12345, 0):
        rand = A.mulberry32(seed)
        prng[str(seed)] = [rand() for _ in range(8)]

    cases = []
    for c in GOLDEN_CASES:
        s = A.summary(**c)
        cases.append({
            "params": c,
            "expect": {
                "ensembleGrowth": s["ensemble_growth"],
                "timeGrowth": s["time_growth"],
                "expectedFinal": s["expected_final"],
                "medianFinal": s["median_final"],
                "sdFinal": s["sd_final"],
                "pBelowStart": s["p_below_start"],
                "pBelowOne": s["p_below_one"],
                "q05": s["q05"],
                "q95": s["q95"],
                "kellyF": s["kelly_f"],
                "sigmaLog": s["sigma_log"],
                # medianHalfLife and doublingTime are +Infinity in the cases
                # where the typical path is not decaying / not growing. json
                # writes the bare token `Infinity`, which is invalid JSON and
                # valid JavaScript -- golden.js is loaded as a script, and
                # tests.html's default comparison already has a non-finite
                # equality branch, the same one St Petersburg's `expected`
                # relies on.
                "arithmeticMultiplier": s["arithmetic_multiplier"],
                "geometricMultiplier": s["geometric_multiplier"],
                "volatilityDrag": s["volatility_drag"],
                "medianHalfLife": s["median_half_life"],
                "breakEvenHeads": s["break_even_heads"],
                "expectedHeads": s["expected_heads"],
                "kellyGrowth": s["kelly_growth"],
                "zeroGrowthF": s["zero_growth_f"],
                "doublingTime": s["doubling_time"],
            },
        })

    # A small seeded simulation: if the PRNG ports correctly, the JS engine must
    # reproduce these terminal values bit for bit.
    sim_cfg = dict(n_paths=5, rounds=20, w0=100.0, p=0.5, up=1.5, down=0.6,
                   f=1.0, seed=7)
    paths = A.simulate_paths(**sim_cfg)
    sim = {
        "config": {
            "nPaths": sim_cfg["n_paths"], "rounds": sim_cfg["rounds"],
            "w0": sim_cfg["w0"], "p": sim_cfg["p"], "up": sim_cfg["up"],
            "down": sim_cfg["down"], "f": sim_cfg["f"], "seed": sim_cfg["seed"],
        },
        "terminal": [pth[-1] for pth in paths],
        "firstPath": paths[0],
    }

    binom = [
        {"k": k, "n": n, "p": p,
         "pmf": float(A.binom.pmf(k, n, p)), "cdf": float(A.binom.cdf(k, n, p))}
        for k, n, p in [(50, 100, 0.5), (3, 10, 0.3), (0, 20, 0.5), (17, 20, 0.6)]
    ]

    # -- gambler's ruin: closed forms plus a seeded walk ---------------------
    ruin = []
    for c in RUIN_GOLDEN:
        s = A.ruin_summary(**c)
        ruin.append({
            "params": c,
            "expect": {
                "k": s["k"], "n": s["n"],
                "ruinProb": s["ruin_prob"],
                "reachProb": s["reach_prob"],
                "duration": s["duration"],
                "ruinUnbounded": s["ruin_unbounded"],
                "fairRuinProb": s["fair_ruin_prob"],
                "terminalMean": s["terminal_mean"],
                "terminalSd": s["terminal_sd"],
            },
        })

    ruin_cfg = dict(n_paths=6, rounds=60, bankroll=100.0, target=200.0,
                    p=0.49, bet=5.0, seed=7)
    ruin_paths, rk, rn = A.simulate_ruin(**ruin_cfg)
    ruin_sim = {
        "config": {
            "nPaths": ruin_cfg["n_paths"], "rounds": ruin_cfg["rounds"],
            "bankroll": ruin_cfg["bankroll"], "target": ruin_cfg["target"],
            "p": ruin_cfg["p"], "bet": ruin_cfg["bet"], "seed": ruin_cfg["seed"],
        },
        "k": rk, "n": rn,
        "terminal": [pth[-1] for pth in ruin_paths],
        "firstPath": ruin_paths[0],
    }

    # -- St Petersburg -------------------------------------------------------
    # sp_expected is +inf for the divergent cases. json.dump writes that as the
    # bare token `Infinity`, which is not valid JSON but is valid JavaScript --
    # and golden.js is loaded as a script, never parsed as JSON. tests.html
    # compares it with an isFinite guard.
    stpete = []
    for c in SP_GOLDEN:
        s = A.sp_summary(**c)
        stpete.append({
            "params": c,
            "expect": {
                "expected": s["expected"],
                "median": s["median"],
                "q95": s["q95"],
                "capped": s["capped"],
                "capAmount": s["cap_amount"],
                "typicalMean": s["typical_mean"],
                "survival5": A.sp_survival(5, c["p"]),
                "contribution5": A.sp_tier_contribution(5, c["p"], c["m"]),
                "sd": s["sd"],
                "m2p": s["m2p"],
                "logUtility": s["log_utility"],
                "certaintyEquivalent": s["certainty_equivalent"],
            },
        })

    sp_cfg = dict(runs=4, plays=200, p=0.5, m=2.0, seed=7)
    sp_means, sp_first = A.simulate_st_petersburg(**sp_cfg)
    sp_sim = {"config": sp_cfg, "means": sp_means, "firstPayouts": sp_first}

    # -- prisoner's dilemma --------------------------------------------------
    pd = []
    for c in PD_GOLDEN:
        s = A.pd_summary(**c)
        pd.append({
            "params": c,
            "expect": {
                "matrix": s["matrix"],
                "scores": s["scores"],
                "winner": s["winner"],
                "finalShares": s["shares"][-1],
                "tftVsAlld": s["tft_vs_alld"],
                "alldVsTft": s["alld_vs_tft"],
            },
        })

    # -- Monty Hall -----------------------------------------------------------
    monty = []
    for c in MH_GOLDEN:
        s = A.mh_summary(**c)
        kks, kswitch, kstay = A.mh_know_curve(c["doors"], c["opened"], points=21)
        dxs, dknow, drand = A.mh_doors_curve(c["opened"], max_doors=15)
        monty.append({
            "params": c,
            "expect": {
                "doors": s["doors"], "opened": s["opened"],
                "switchProb": s["switch_prob"], "stayProb": s["stay_prob"],
                "goatProb": s["goat_prob"],
                "switchKnowing": s["switch_knowing"], "switchRandom": s["switch_random"],
            },
            "knowCurve": {"ks": kks, "switch": kswitch, "stay": kstay},
            "doorsCurve": {"xs": dxs, "knowing": dknow, "random": drand},
        })

    monty_cfg = dict(games=200, doors=3, opened=1, know=1.0, seed=7)
    m_valid, m_stay, m_switch, m_first = A.simulate_monty(**monty_cfg)
    monty_sim = {
        "config": monty_cfg, "valid": m_valid, "stayWins": m_stay,
        "switchWins": m_switch, "first": m_first,
    }

    # -- Shannon's demon --------------------------------------------------------
    shannon = []
    for c in SD_GOLDEN:
        s = A.sd_summary(**c)
        cxs, cgs = A.sd_interval_curve(c["rounds"], c["p"], c["vol"], c["w"],
                                       c["cost"], max_interval=30)
        shannon.append({
            "params": c,
            "expect": {
                "up": s["up"], "down": s["down"],
                "stockGrowth": s["stock_growth"], "stockDrift": s["stock_drift"],
                "rebalGrowth": s["rebal_growth"], "holdGrowth": s["hold_growth"],
                "harvest": s["harvest"],
                "bestInterval": s["best_interval"], "bestGrowth": s["best_growth"],
                "kellyW": s["kelly_w"],
                "harvestContinuous": s["harvest_continuous"],
                "optimalWeight": s["optimal_weight"],
            },
            "intervalCurve": {"xs": cxs, "gs": cgs},
        })

    sd_cfg = dict(n_paths=4, rounds=40, w0=100.0, p=0.5, vol=0.3, w=0.5,
                  interval=5, cost=0.0, seed=7)
    (sd_first, sd_hold_terms, sd_rebal_terms) = A.simulate_rebalance(**sd_cfg)
    sd_sim = {
        "config": {
            "nPaths": sd_cfg["n_paths"], "rounds": sd_cfg["rounds"],
            "w0": sd_cfg["w0"], "p": sd_cfg["p"], "vol": sd_cfg["vol"],
            "w": sd_cfg["w"], "interval": sd_cfg["interval"],
            "cost": sd_cfg["cost"], "seed": sd_cfg["seed"],
        },
        "firstPrice": sd_first[0], "firstHold": sd_first[1], "firstRebal": sd_first[2],
        "termHold": sd_hold_terms, "termRebal": sd_rebal_terms,
    }

    # -- insurance and risk pooling ---------------------------------------------
    insurance = []
    for c in INS_GOLDEN:
        s = A.ins_summary(**c)
        pxs, pbuy, psell = A.ins_premium_curve(
            c["wealth"], c["seller_wealth"], c["loss"], c["hazard"], points=40)
        psizes, pgrowth = A.ins_pool_curve(
            c["wealth"], c["loss"], c["hazard"], max_members=60)
        insurance.append({
            # Re-keyed to camelCase: ins_summary's kwarg is seller_wealth (Python
            # convention), but tests.html hands "params" straight to EP.insSummary,
            # which destructures pr.sellerWealth.
            "params": {
                "wealth": c["wealth"], "sellerWealth": c["seller_wealth"],
                "premium": c["premium"], "loss": c["loss"],
                "hazard": c["hazard"], "members": c["members"],
            },
            "expect": {
                "expectedPayout": s["expected_payout"],
                "buyerMax": s["buyer_max"], "sellerMin": s["seller_min"],
                "bandOk": s["band_ok"], "bandWidth": s["band_width"],
                "uninsuredGrowth": s["uninsured_growth"],
                "insuredGrowth": s["insured_growth"],
                "sellerGrowth": s["seller_growth"],
                "buyerValue": s["buyer_value"], "sellerValue": s["seller_value"],
                "poolGrowth": s["pool_growth"], "poolLimit": s["pool_limit"],
                "poolBreakEven": s["pool_break_even"],
            },
            "premiumCurve": {"xs": pxs, "buyer": pbuy, "seller": psell},
            "poolCurve": {"sizes": psizes, "growth": pgrowth},
        })

    # -- Parrondo's paradox ---------------------------------------------------
    parrondo = []
    for c in PA_GOLDEN:
        s = A.pa_summary(**c)
        qs, drifts = A.pa_drift_curve(c["eps"], c["p_bad"], c["p_good"], points=21)
        parrondo.append({
            "params": c,
            "expect": {
                "driftA": s["drift_a"], "driftB": s["drift_b"],
                "driftMix": s["drift_mix"], "bestQ": s["best_q"],
                "bestDrift": s["best_drift"], "paradox": s["paradox"],
            },
            "driftCurve": {"qs": qs, "drifts": drifts},
        })

    pa_cfg = dict(n_paths=4, rounds=60, q=0.5, eps=0.005, p_bad=0.1, p_good=0.75,
                  w0=0, seed=7)
    pa_a, pa_b, pa_mix = A.simulate_parrondo(**pa_cfg)
    parrondo_sim = {
        "config": pa_cfg,
        "firstA": pa_a[0], "firstB": pa_b[0], "firstMix": pa_mix[0],
        "termA": [p[-1] for p in pa_a], "termB": [p[-1] for p in pa_b],
        "termMix": [p[-1] for p in pa_mix],
    }

    # -- base rates -------------------------------------------------------------
    baserates = []
    for c in BR_GOLDEN:
        s = A.br_summary(**c)
        pxs, pys = A.br_prevalence_curve(c["sens"], c["spec"], points=40)
        baserates.append({
            "params": c,
            "expect": {
                "posteriorPos": s["posterior_pos"], "posteriorNeg": s["posterior_neg"],
                "tp": s["tp"], "fp": s["fp"], "fn": s["fn"], "tn": s["tn"],
                "positives": s["positives"], "precision": s["precision"],
            },
            "prevalenceCurve": {"xs": pxs, "ys": pys},
        })

    # -- the birthday problem -----------------------------------------------
    birthday = []
    for c in BD_GOLDEN:
        s = A.bd_summary(**c)
        cxs, cys = A.bd_collision_curve(c["days"], max_n=80)
        bxs, bys = A.bd_hash_bits_curve(min_bits=8, max_bits=64, points=20)
        birthday.append({
            "params": c,
            "expect": {
                "collisionProb": s["collision_prob"], "pairs": s["pairs"],
                "halfLifeN": s["half_life_n"], "hashN50": s["hash_n50"],
            },
            "collisionCurve": {"xs": cxs, "ys": cys},
            "hashBitsCurve": {"xs": bxs, "ys": bys},
        })

    # -- the secretary problem -----------------------------------------------
    secretary = []
    for c in SEC_GOLDEN:
        s = A.sec_summary(**c)
        wxs, wys = A.sec_win_curve(c["n"])
        secretary.append({
            "params": c,
            "expect": {
                "winProb": s["win_prob"], "bestS": s["best_s"],
                "bestProb": s["best_prob"], "bestFraction": s["best_fraction"],
                "invE": s["inv_e"],
            },
            "winCurve": {"xs": wxs, "ys": wys},
        })

    asym_ns, asym_ys = A.sec_asymptotic_curve(min_n=5, max_n=500, points=30)
    secretary_asymptotic = {"ns": asym_ns, "ys": asym_ys}

    # -- the two-envelope paradox ---------------------------------------------
    twoenv = []
    for c in TE_GOLDEN:
        s = A.te_summary(**c)
        gxs, ggains, gprobs = A.te_gain_curve(c["rate"], points=40)
        twoenv.append({
            "params": c,
            "expect": {
                "pSmaller": s["p_smaller"], "swapGain": s["swap_gain"],
                "crossover": s["crossover"], "meanSmaller": s["mean_smaller"],
                "shouldSwap": s["should_swap"],
            },
            "gainCurve": {"xs": gxs, "gains": ggains, "probs": gprobs},
        })

    # -- optional stopping ----------------------------------------------------
    optstop = []
    for c in OS_GOLDEN:
        s = A.os_summary(**c)
        cxs, cys = A.os_false_positive_curve(c["looks"], c["batch"], c["alpha"])
        optstop.append({
            "params": c,
            "expect": {
                "cumFp": s["cum_fp"], "nominalAlpha": s["nominal_alpha"],
                "bonferroniAlpha": s["bonferroni_alpha"], "totalN": s["total_n"],
                "zCrit": s["z_crit"],
            },
            "fpCurve": {"xs": cxs, "ys": cys},
        })

    os_cfg = dict(n_paths=4, looks=10, batch=20, alpha=0.05, seed=7)
    os_z, os_first_sig = A.simulate_optional_stopping(**os_cfg)
    optstop_sim = {
        "config": os_cfg, "zPaths": os_z, "firstSig": os_first_sig,
    }

    # -- Simpson's paradox ----------------------------------------------------
    # `params` is emitted in camelCase because tests.html hands it straight to
    # EP.simpsonsSummary(p); the Python call above uses the snake_case case
    # dict. Same split the wheel's config already needs.
    simpsons = []
    for c in SIMPSONS_GOLDEN:
        s = A.simpsons_summary(**c)
        k = s["counts"]
        dxs, dys = A.simpsons_delta_curve(c["p_easy"], c["p_hard"], c["w_a"],
                                          c["w_b"], points=41)
        simpsons.append({
            "params": {
                "pEasy": c["p_easy"], "pHard": c["p_hard"], "delta": c["delta"],
                "wA": c["w_a"], "wB": c["w_b"], "nA": c["n_a"], "nB": c["n_b"],
            },
            "expect": {
                "rateEasyA": s["rate_easy_a"], "rateHardA": s["rate_hard_a"],
                "rateEasyB": s["rate_easy_b"], "rateHardB": s["rate_hard_b"],
                "pooledA": s["pooled_a"], "pooledB": s["pooled_b"],
                "subgroupDiff": s["subgroup_diff"], "pooledDiff": s["pooled_diff"],
                "deltaCritical": s["delta_critical"], "reverses": s["reverses"],
                "allocationGap": s["allocation_gap"],
                "difficultyGap": s["difficulty_gap"],
            },
            "counts": {
                "easyA": k["easy_a"], "hardA": k["hard_a"], "nA": k["n_a"],
                "easyB": k["easy_b"], "hardB": k["hard_b"], "nB": k["n_b"],
                "succEasyA": k["succ_easy_a"], "succHardA": k["succ_hard_a"],
                "succA": k["succ_a"],
                "succEasyB": k["succ_easy_b"], "succHardB": k["succ_hard_b"],
                "succB": k["succ_b"],
                "rateEasyA": k["rate_easy_a"], "rateHardA": k["rate_hard_a"],
                "rateEasyB": k["rate_easy_b"], "rateHardB": k["rate_hard_b"],
                "rateA": k["rate_a"], "rateB": k["rate_b"],
            },
            "deltaCurve": {"xs": dxs, "ys": dys},
        })

    # -- Bertrand's paradox ---------------------------------------------------
    bertrand = []
    for c in BERTRAND_GOLDEN:
        s = A.bertrand_summary(**c)
        ts, ce, cr, cm = A.bertrand_cdf_curve(points=41)
        cs, pe, pr_, pm = A.bertrand_c_curve(points=41)
        samples = {}
        for m in A.BERTRAND_METHODS:
            chords = A.bertrand_sample(m, n=6, radius=c["radius"], c=c["c"],
                                       seed=c["seed"])
            samples[m] = chords
        bertrand.append({
            "params": c,
            "expect": {
                "c": s["c"], "length": s["length"], "threshold": s["threshold"],
                "pEndpoints": s["p_endpoints"], "pRadius": s["p_radius"],
                "pMidpoint": s["p_midpoint"], "spread": s["spread"],
                "meanLenEndpoints": s["mean_len_endpoints"],
                "meanLenRadius": s["mean_len_radius"],
                "meanLenMidpoint": s["mean_len_midpoint"],
                "empEndpoints": s["emp_endpoints"], "empRadius": s["emp_radius"],
                "empMidpoint": s["emp_midpoint"],
                "classicC": s["classic_c"], "isClassic": s["is_classic"],
            },
            "cdfCurve": {"ts": ts, "endpoints": ce, "radius": cr, "midpoint": cm},
            "cCurve": {"cs": cs, "endpoints": pe, "radius": pr_, "midpoint": pm},
            "samples": samples,
        })

    # -- the wheel strategy ---------------------------------------------------
    wheel_bs = []
    for c in WHEEL_BS_GOLDEN:
        d1, d2 = A.bs_d1_d2(c["s"], c["k"], c["t"], c["sigma"], c["r"], c["q"])
        wheel_bs.append({
            "params": c,
            "expect": {
                "d1": d1, "d2": d2,
                "callPrice": A.bs_call_price(c["s"], c["k"], c["t"], c["sigma"],
                                             c["r"], c["q"]),
                "putPrice": A.bs_put_price(c["s"], c["k"], c["t"], c["sigma"],
                                           c["r"], c["q"]),
                "realWorldCallProb": A.real_world_itm_prob(
                    c["s"], c["k"], c["t"], c["sigma"], c["mu"], c["q"], call=True),
                "realWorldPutProb": A.real_world_itm_prob(
                    c["s"], c["k"], c["t"], c["sigma"], c["mu"], c["q"], call=False),
            },
        })

    hold = []
    for c in HOLD_GOLDEN:
        h = A.hold_summary(**c)
        hold.append({
            "params": c,
            "expect": {
                "growthRate": h["growth_rate"],
                "expectedFinal": h["expected_final"],
                "medianFinal": h["median_final"],
                "pBelowStart": h["p_below_start"],
                "q05": h["q05"], "q95": h["q95"],
            },
        })

    normals = {}
    for seed in (42, 7):
        randn = A.make_normal_generator(seed)
        normals[str(seed)] = [randn() for _ in range(8)]

    fam = A.simulate_wheel_family(**WHEEL_SIM_CFG)
    wheel_sim = {
        "config": {
            "w0": WHEEL_SIM_CFG["w0"], "s0": WHEEL_SIM_CFG["s0"],
            "mu": WHEEL_SIM_CFG["mu"], "sigmaRv": WHEEL_SIM_CFG["sigma_rv"],
            "sigmaIv": WHEEL_SIM_CFG["sigma_iv"], "r": WHEEL_SIM_CFG["r"],
            "q": WHEEL_SIM_CFG["q"], "years": WHEEL_SIM_CFG["years"],
            "xMonths": WHEEL_SIM_CFG["x_months"], "yMonths": WHEEL_SIM_CFG["y_months"],
            "dipPct": WHEEL_SIM_CFG["dip_pct"], "sellHaircut": WHEEL_SIM_CFG["sell_haircut"],
            "shareSl": WHEEL_SIM_CFG["share_sl"], "callTp": WHEEL_SIM_CFG["call_tp"],
            "stockFeePct": WHEEL_SIM_CFG["stock_fee_pct"],
            "optFee": WHEEL_SIM_CFG["opt_fee"], "seed": WHEEL_SIM_CFG["seed"],
        },
        "path": fam["path"],
        "wheelEquity": fam["wheel"]["equity"],
        "wheelStats": fam["wheel"]["stats"],
        "wheelEvents": fam["wheel"]["events"],
        "putsOnlyEquity": fam["puts_only"]["equity"],
        "dipEquity": fam["dip"],
        "holdEquity": fam["hold"],
    }

    sweep_xs, sweep_gs = A.wheel_iv_sweep(**WHEEL_SWEEP_CFG)
    wheel_sweep = {
        "config": {
            "w0": WHEEL_SWEEP_CFG["w0"], "s0": WHEEL_SWEEP_CFG["s0"],
            "mu": WHEEL_SWEEP_CFG["mu"], "sigmaRv": WHEEL_SWEEP_CFG["sigma_rv"],
            "r": WHEEL_SWEEP_CFG["r"], "q": WHEEL_SWEEP_CFG["q"],
            "years": WHEEL_SWEEP_CFG["years"], "xMonths": WHEEL_SWEEP_CFG["x_months"],
            "yMonths": WHEEL_SWEEP_CFG["y_months"], "dipPct": WHEEL_SWEEP_CFG["dip_pct"],
            "sellHaircut": WHEEL_SWEEP_CFG["sell_haircut"],
            "shareSl": WHEEL_SWEEP_CFG["share_sl"],
            "callTp": WHEEL_SWEEP_CFG["call_tp"],
            "stockFeePct": WHEEL_SWEEP_CFG["stock_fee_pct"], "optFee": WHEEL_SWEEP_CFG["opt_fee"],
            "points": WHEEL_SWEEP_CFG["points"], "nSeeds": WHEEL_SWEEP_CFG["n_seeds"],
            "spreadLo": WHEEL_SWEEP_CFG["spread_lo"], "spreadHi": WHEEL_SWEEP_CFG["spread_hi"],
            "baseSeed": WHEEL_SWEEP_CFG["base_seed"],
        },
        "xs": sweep_xs, "gs": sweep_gs,
    }

    payload = {
        "prng": prng, "cases": cases, "sim": sim, "binom": binom,
        "strategies": list(A.STRATEGIES),
        "ruin": ruin, "ruinSim": ruin_sim,
        "stpete": stpete, "stpeteSim": sp_sim,
        "pd": pd,
        "monty": monty, "montySim": monty_sim,
        "shannon": shannon, "shannonSim": sd_sim,
        "insurance": insurance,
        "parrondo": parrondo, "parrondoSim": parrondo_sim,
        "baserates": baserates,
        "birthday": birthday,
        "secretary": secretary, "secretaryAsymptotic": secretary_asymptotic,
        "twoenv": twoenv,
        "optstop": optstop, "optstopSim": optstop_sim,
        "simpsons": simpsons, "bertrand": bertrand,
        "wheelBs": wheel_bs, "hold": hold, "normals": normals,
        "wheelSim": wheel_sim, "wheelSweep": wheel_sweep,
    }
    out = os.path.join(ROOT, "js", "golden.js")
    with open(out, "w") as fh:
        fh.write("/* GENERATED by lab/verify.py -- do not edit by hand.\n"
                 " * Expected values from the Python source of truth; tests.html\n"
                 " * checks js/engine.js against them in the browser. */\n")
        fh.write("window.EP_GOLDEN = ")
        json.dump(payload, fh, indent=2)
        fh.write(";\n")
    print(f"  wrote {out} ({len(cases)} coin cases, {len(ruin)} ruin cases, "
          f"{len(stpete)} St Petersburg cases, {len(pd)} dilemma cases, "
          f"{len(monty)} Monty Hall cases, {len(shannon)} Shannon cases, "
          f"{len(insurance)} insurance cases, {len(parrondo)} Parrondo cases, "
          f"{len(baserates)} base-rate cases, {len(birthday)} birthday cases, "
          f"{len(secretary)} secretary cases, {len(twoenv)} two-envelope cases, "
          f"{len(optstop)} optional-stopping cases, "
          f"{len(simpsons)} Simpson cases, {len(bertrand)} Bertrand cases, "
          f"{len(prng)} PRNG streams, {len(binom)} binomial points)")


if __name__ == "__main__":
    verify_closed_forms()
    verify_kelly()
    verify_ruin()
    verify_st_petersburg()
    verify_pd()
    verify_monty()
    verify_shannon()
    verify_insurance()
    verify_wheel()
    verify_parrondo()
    verify_base_rates()
    verify_birthday()
    verify_secretary()
    verify_two_envelope()
    verify_optional_stopping()
    verify_simpsons()
    verify_bertrand()
    emit_golden()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for name, got, want in FAILURES:
            print(f"  {name}: got {got!r}, want {want!r}")
        sys.exit(1)
    print("Python side: all checks pass.")
    print("JS side: open tests.html in a browser to check engine.js "
          "against js/golden.js.")
