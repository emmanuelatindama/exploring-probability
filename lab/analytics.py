"""Closed-form analytics for the multiplicative coin-toss game.

This module is the source of truth. The browser engine (js/engine.js) must
reproduce these numbers; lab/verify.py asserts that it does.

The game: start with W0. Each round, bet a fraction f of current wealth on a
coin that comes up heads with probability p. Heads multiplies the staked amount
by `up`, tails by `down`. So wealth is multiplied each round by

    heads:  m_up   = 1 + (up   - 1) * f
    tails:  m_down = 1 - (1 - down) * f

With f = 1 (stake everything) and up/down = 1.5/0.6 this is the classic
ergodicity-economics example: the ensemble average grows at +5%/round while the
typical trajectory decays at -5.3%/round.
"""

import math

from scipy.stats import binom


def multipliers(up=1.5, down=0.6, f=1.0):
    """Per-round wealth multipliers for a win and a loss."""
    return 1.0 + (up - 1.0) * f, 1.0 - (1.0 - down) * f


def ensemble_growth(p=0.5, up=1.5, down=0.6, f=1.0):
    """E[m] - 1: expected *arithmetic* growth per round (the ensemble average).

    This is what "expected value" means and why the game looks attractive.
    """
    mu, md = multipliers(up, down, f)
    return p * mu + (1 - p) * md - 1.0


def time_growth(p=0.5, up=1.5, down=0.6, f=1.0):
    """E[ln m]: expected *logarithmic* growth per round (the time average).

    This is what a single player actually experiences over many rounds. Returns
    -inf when an outcome can wipe you out (m <= 0), which is the correct answer:
    ruin is absorbing.
    """
    mu, md = multipliers(up, down, f)
    if mu <= 0 or md <= 0:
        return -math.inf
    return p * math.log(mu) + (1 - p) * math.log(md)


def expected_final(w0=100.0, rounds=100, p=0.5, up=1.5, down=0.6, f=1.0):
    """E[W_T]. Grows without bound whenever ensemble_growth > 0."""
    return w0 * (1.0 + ensemble_growth(p, up, down, f)) ** rounds


def median_final(w0=100.0, rounds=100, p=0.5, up=1.5, down=0.6, f=1.0):
    """Exact median of W_T.

    W_T is monotone in the number of heads k, so the median wealth is the
    wealth at the median k of Binomial(rounds, p) -- no normal approximation.
    """
    mu, md = multipliers(up, down, f)
    k = int(binom.ppf(0.5, rounds, p))
    return w0 * (mu ** k) * (md ** (rounds - k))


def quantile_final(q, w0=100.0, rounds=100, p=0.5, up=1.5, down=0.6, f=1.0):
    """Exact q-quantile of W_T, via the quantile of the heads count."""
    mu, md = multipliers(up, down, f)
    k = int(binom.ppf(q, rounds, p))
    return w0 * (mu ** k) * (md ** (rounds - k))


def prob_below(threshold, w0=100.0, rounds=100, p=0.5, up=1.5, down=0.6, f=1.0):
    """P(W_T < threshold), exact via the binomial CDF.

    W_T < threshold  <=>  k * ln(m_up) + (T - k) * ln(m_down) < ln(threshold/w0)
    which is monotone in k, so it reduces to k < k*.
    """
    mu, md = multipliers(up, down, f)
    if mu <= 0 or md <= 0:
        return 1.0
    lu, ld = math.log(mu), math.log(md)
    target = math.log(threshold / w0)
    if lu == ld:  # degenerate: wealth is deterministic
        return 1.0 if rounds * lu < target else 0.0
    # k * (lu - ld) < target - T*ld
    kstar = (target - rounds * ld) / (lu - ld)
    if lu > ld:
        # need k < kstar  ->  k <= ceil(kstar) - 1
        kmax = math.ceil(kstar) - 1
        return float(binom.cdf(kmax, rounds, p)) if kmax >= 0 else 0.0
    kmin = math.floor(kstar) + 1
    return float(binom.sf(kmin - 1, rounds, p))


def kelly_fraction(p=0.5, up=1.5, down=0.6):
    """The bet fraction f* maximising time_growth, in closed form.

    With gain fraction a = up - 1 and loss fraction b = 1 - down:
        d/df [ p ln(1+af) + q ln(1-bf) ] = 0  ->  f* = (p*a - q*b) / (a*b)

    Clamped to [0, 1/b): above 1/b a single loss wipes you out. Returns 0 when
    the edge is negative -- the correct Kelly answer is "don't play".
    """
    a, b, q = up - 1.0, 1.0 - down, 1.0 - p
    if a <= 0 or b <= 0:
        return float("nan")
    f = (p * a - q * b) / (a * b)
    return max(0.0, min(f, (1.0 / b) - 1e-12))


def sigma_log(p=0.5, up=1.5, down=0.6, f=1.0):
    """Per-round standard deviation of log wealth (the volatility drag driver)."""
    mu, md = multipliers(up, down, f)
    if mu <= 0 or md <= 0:
        return math.inf
    return math.sqrt(p * (1 - p)) * abs(math.log(mu) - math.log(md))


def summary(w0=100.0, rounds=100, p=0.5, up=1.5, down=0.6, f=1.0):
    """Everything the page's stat tiles and table view need, in one dict."""
    return {
        "ensemble_growth": ensemble_growth(p, up, down, f),
        "time_growth": time_growth(p, up, down, f),
        "expected_final": expected_final(w0, rounds, p, up, down, f),
        "median_final": median_final(w0, rounds, p, up, down, f),
        "p_below_start": prob_below(w0, w0, rounds, p, up, down, f),
        "p_below_one": prob_below(1.0, w0, rounds, p, up, down, f),
        "q05": quantile_final(0.05, w0, rounds, p, up, down, f),
        "q95": quantile_final(0.95, w0, rounds, p, up, down, f),
        "kelly_f": kelly_fraction(p, up, down),
        "sigma_log": sigma_log(p, up, down, f),
    }


# -- seeded PRNG, byte-for-byte identical to the JS engine --------------------
MASK = 0xFFFFFFFF


def _imul(a, b):
    return (a * b) & MASK


def mulberry32(seed):
    """Port of the mulberry32 generator used in js/engine.js.

    Deliberately the same algorithm on both sides so a given (seed, params)
    produces the same paths in Python and in the browser, which is what makes
    lab/verify.py able to check the JS engine at all.
    """
    a = seed & MASK

    def rand():
        nonlocal a
        a = (a + 0x6D2B79F5) & MASK
        t = _imul(a ^ (a >> 15), a | 1)
        t = ((t + _imul(t ^ (t >> 7), t | 61)) & MASK) ^ t
        return ((t ^ (t >> 14)) & MASK) / 4294967296.0

    return rand


def simulate_paths(n_paths=500, rounds=100, w0=100.0, p=0.5, up=1.5, down=0.6,
                   f=1.0, seed=7):
    """Reference simulation using the shared PRNG. Returns a list of paths."""
    mu, md = multipliers(up, down, f)
    rand = mulberry32(seed)
    paths = []
    for _ in range(n_paths):
        w, path = w0, [w0]
        for _ in range(rounds):
            w *= mu if rand() < p else md
            path.append(w)
        paths.append(path)
    return paths


if __name__ == "__main__":
    for label, f in (("stake everything (f=1.0)", 1.0), ("Kelly-sized", None)):
        ff = kelly_fraction() if f is None else f
        s = summary(f=ff)
        print(f"\n{label}  f={ff:.4f}")
        print(f"  ensemble growth   {s['ensemble_growth']*100:+.3f} %/round")
        print(f"  time growth       {s['time_growth']*100:+.3f} %/round")
        print(f"  E[W_100]          ${s['expected_final']:>14,.2f}")
        print(f"  median W_100      ${s['median_final']:>14,.2f}")
        print(f"  P(below $100)     {s['p_below_start']*100:.2f} %")
        print(f"  P(below $1)       {s['p_below_one']*100:.2f} %")
        print(f"  5-95% range       ${s['q05']:,.2f} .. ${s['q95']:,.2f}")
