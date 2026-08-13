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

    payload = {
        "prng": prng, "cases": cases, "sim": sim, "binom": binom,
        "strategies": list(A.STRATEGIES),
        "ruin": ruin, "ruinSim": ruin_sim,
        "stpete": stpete, "stpeteSim": sp_sim,
        "pd": pd,
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
          f"{len(prng)} PRNG streams, {len(binom)} binomial points)")


if __name__ == "__main__":
    verify_closed_forms()
    verify_kelly()
    verify_ruin()
    verify_st_petersburg()
    verify_pd()
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
