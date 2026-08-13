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
    if rel:
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


# -- 2. golden values for the JS engine --------------------------------------
GOLDEN_CASES = [
    dict(w0=100.0, rounds=100, p=0.5, up=1.5, down=0.6, f=1.0),
    dict(w0=100.0, rounds=100, p=0.5, up=1.5, down=0.6, f=0.25),
    dict(w0=100.0, rounds=250, p=0.5, up=1.5, down=0.6, f=0.5),
    dict(w0=100.0, rounds=60, p=0.6, up=1.4, down=0.7, f=0.5),
    dict(w0=100.0, rounds=40, p=0.35, up=1.9, down=0.5, f=0.3),
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

    payload = {"prng": prng, "cases": cases, "sim": sim, "binom": binom}
    out = os.path.join(ROOT, "js", "golden.js")
    with open(out, "w") as fh:
        fh.write("/* GENERATED by lab/verify.py -- do not edit by hand.\n"
                 " * Expected values from the Python source of truth; tests.html\n"
                 " * checks js/engine.js against them in the browser. */\n")
        fh.write("window.EP_GOLDEN = ")
        json.dump(payload, fh, indent=2)
        fh.write(";\n")
    print(f"  wrote {out} ({len(cases)} analytics cases, "
          f"{len(prng)} PRNG streams, {len(binom)} binomial points)")


if __name__ == "__main__":
    verify_closed_forms()
    verify_kelly()
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
