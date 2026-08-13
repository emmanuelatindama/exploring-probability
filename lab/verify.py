"""Verify the Python analytics, then emit golden values for the JS engine.

Two jobs:

1. Self-check the closed forms in analytics.py against a large Monte Carlo run.
   Closed forms are easy to get subtly wrong; a simulation is dumb but honest.

2. Write js/golden.js -- the expected values that tests.html checks the browser
   engine against. There is no JS runtime on the dev machine, so the JS side of
   the port is verified by opening tests.html, not from this script.

Run:  python lab/verify.py
"""

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
    for p, m in [(0.4, 2.0), (0.5, 1.5), (0.3, 2.5)]:
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
        for tier in (1, 3, 6):
            check(f"P(payout >= m^{tier - 1})",
                  float((tosses >= tier).mean()), A.sp_survival(tier, p), tol=2e-3)

    # The classic game: the expectation diverges, and the tier contributions are
    # the reason -- each one is worth exactly (1-p) = $0.50, forever.
    print("\n  classic game p=0.5 m=2.0")
    check("E[payout] diverges", A.sp_expected(0.5, 2.0), math.inf)
    check("median payout = $1", A.sp_median(0.5, 2.0), 1.0)
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


# -- 1g. insurance and risk pooling --------------------------------------------
def mc_pool_growth(members, wealth, loss, hazard, n=200_000, seed=99):
    rng = np.random.default_rng(seed)
    k = rng.binomial(members, hazard, n)
    m = 1.0 - (loss / wealth) * (k / members)
    return float(np.log(m).mean())


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
                "pBelowStart": s["p_below_start"],
                "pBelowOne": s["p_below_one"],
                "q05": s["q05"],
                "q95": s["q95"],
                "kellyF": s["kelly_f"],
                "sigmaLog": s["sigma_log"],
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
        monty.append({
            "params": c,
            "expect": {
                "doors": s["doors"], "opened": s["opened"],
                "switchProb": s["switch_prob"], "stayProb": s["stay_prob"],
                "goatProb": s["goat_prob"],
                "switchKnowing": s["switch_knowing"], "switchRandom": s["switch_random"],
            },
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
            },
            "intervalCurve": {"xs": cxs, "gs": cgs},
        })

    sd_cfg = dict(n_paths=4, rounds=40, w0=100.0, p=0.5, vol=0.3, w=0.5,
                  interval=5, cost=0.0, seed=7)
    (sd_first, sd_hold_terms, sd_rebal_terms) = A.simulate_rebalance(**sd_cfg)
    sd_sim = {
        "config": sd_cfg,
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
            "params": c,
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

    payload = {
        "prng": prng, "cases": cases, "sim": sim, "binom": binom,
        "strategies": list(A.STRATEGIES),
        "ruin": ruin, "ruinSim": ruin_sim,
        "stpete": stpete, "stpeteSim": sp_sim,
        "pd": pd,
        "monty": monty, "montySim": monty_sim,
        "shannon": shannon, "shannonSim": sd_sim,
        "insurance": insurance,
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
          f"{len(insurance)} insurance cases, "
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
