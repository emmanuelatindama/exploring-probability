"""Closed-form analytics for the site's probability games.

This module is the source of truth. The browser engine (js/engine.js) must
reproduce these numbers; lab/verify.py asserts that it does.

Sixteen games live here, in this order:

1. **The multiplicative coin toss** (and Kelly sizing). Start with W0. Each
   round, bet a fraction f of current wealth on a coin that comes up heads with
   probability p. Heads multiplies the staked amount by `up`, tails by `down`.
   So wealth is multiplied each round by

       heads:  m_up   = 1 + (up   - 1) * f
       tails:  m_down = 1 - (1 - down) * f

   With f = 1 (stake everything) and up/down = 1.5/0.6 this is the classic
   ergodicity-economics example: the ensemble average grows at +5%/round while
   the typical trajectory decays at -5.3%/round.

2. **Gambler's ruin.** Additive, not multiplicative: a fixed dollar bet each
   round against two absorbing barriers, $0 and a target. Ruin here comes from
   the barrier rather than from the geometry of the returns.

3. **The St Petersburg paradox.** A geometric payout whose expectation diverges,
   where the interesting quantities are the ones that stay finite.

4. **The iterated prisoner's dilemma.** Not a wealth process at all: expected
   per-round scores for a round robin of five strategies, computed exactly by a
   small DP over the pair's joint state rather than by simulation.

5. **Monty Hall.** Also not a wealth process: conditional probability, with the
   host's knowledge as a dial rather than an assumption.

6. **Shannon's demon.** A rebalanced portfolio on a trendless stock. Growth per
   period is an exact binomial sum over the moves inside one rebalancing cycle,
   which is what makes the sweep over the cycle length exact rather than
   simulated.

7. **Insurance and risk pooling.** Two parties with different wealths, and the
   band of premiums inside which both of their growth rates improve.

8. **The wheel strategy.** Sell cash-secured puts below a rolling high; if
   assigned, sell covered calls above the running all-time high; repeat. Unlike
   sections 1-7, this one has no closed form for the strategy itself -- the
   acquisition rule, the per-lot loss stop, and the dynamic cohort sizing are
   all path-dependent decisions with no tractable hitting-time distribution
   under GBM. What *is* exact here: the Black-Scholes price of any single
   option, the real-world (not risk-neutral) probability that a single sold
   option finishes in the money, and buy-and-hold's terminal distribution.
   Section 8 states each of those exactly and simulates everything else,
   flagged as such in every docstring that isn't.

9. **Parrondo's paradox.** Two losing games mixed into a winning one. The
   stationary distribution of a 3-state Markov chain (capital mod 3) is a
   linear-algebra problem, not a simulation.

10. **Base rates and the 95% test.** Bayes' theorem applied to a screening
    test, shown both as probabilities and as counts in a population -- the
    "natural frequency" form that fixes the intuition the probability form
    breaks.

11. **The birthday problem.** Collision probability among n items drawn from d
    categories, exact by a log-space product. Extended, as a stated
    approximation past the point exact enumeration is tractable, to
    cryptographic hash lengths.

12. **The secretary problem.** Optimal stopping over a random permutation --
    skip the first s candidates, then take the next one better than all of
    them. Exact, and vectorised over the skip count with one reversed
    cumulative sum rather than a term-at-a-time re-summation per threshold.

13. **The two-envelope paradox.** The "always swap" argument needs an
    improper (non-normalisable) prior to survive; handing the smaller amount
    a real one -- here, an exponential -- turns "always swap" into "swap
    below a threshold, keep above it," with an exact crossover point.

14. **Optional stopping.** Repeated significance testing as gambler's ruin: a
    driftless random walk against a boundary that moves outward with it.
    Exact by a forward DP over the walk's live distribution, convolving in
    one fresh batch of steps at a time -- the same binomial-weight idea
    sections 6 and 7 use, run forward instead of summed once.

15. **Simpson's paradox.** Two treatments across an easy and a hard subgroup.
    The pooled comparison reverses the subgroup one exactly when the true
    effect is smaller than the allocation gap times the difficulty gap, and
    that condition is an identity rather than a numerical accident.

16. **Bertrand's paradox.** Three sampling rules for "a random chord", three
    exact and different answers to the same question, all three of which are
    just one CDF of the chord midpoint's distance from the centre evaluated
    at the same threshold.

Sections 6, 7 and 14 are sums over a binomial distribution, so they are
written against numpy arrays rather than Python loops: one `binom.pmf` call
(or, for 14, one convolution) over a vector of outcomes instead of a
term-at-a-time accumulation. The JS mirror cannot do that, and gets a weight
recurrence instead -- see js/engine.js.
"""

import math

import numpy as np
from scipy.stats import binom, norm


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


def arithmetic_mean_multiplier(p=0.5, up=1.5, down=0.6, f=1.0):
    """E[m] = p*m_up + (1-p)*m_down. Exact.

    The ensemble multiplier: average one round over infinitely many players and
    this is the factor the *average* wealth grows by. Identical to
    1 + ensemble_growth(); stated as a multiplier because the scenario's whole
    point is the gap between two multipliers, not two rates.
    """
    mu, md = multipliers(up, down, f)
    return p * mu + (1 - p) * md


def geometric_mean_multiplier(p=0.5, up=1.5, down=0.6, f=1.0):
    """G = m_up^p * m_down^(1-p). Exact.

    The multiplier the typical path actually compounds at: after T rounds a
    player with the expected number of heads holds w0 * G^T, and
    ln G = time_growth() exactly. Returns 0.0 when either multiplier is
    non-positive -- a single such outcome takes the path to zero and the
    geometric mean of a set containing zero is zero, which matches
    time_growth()'s -inf.
    """
    mu, md = multipliers(up, down, f)
    if mu <= 0 or md <= 0:
        return 0.0
    return (mu ** p) * (md ** (1 - p))


def volatility_drag(p=0.5, up=1.5, down=0.6, f=1.0):
    """E[m] - G: the AM-GM gap between the ensemble and the typical multiplier.

    Exact, and >= 0 for every input by the AM-GM inequality, with equality if
    and only if m_up == m_down (that is, up == down, or f == 0). This single
    number is the whole disagreement the ergodicity scenario is about.
    """
    return (arithmetic_mean_multiplier(p, up, down, f)
            - geometric_mean_multiplier(p, up, down, f))


def median_half_life(p=0.5, up=1.5, down=0.6, f=1.0):
    """Rounds for the typical (geometric-mean) path to halve: ln(2)/|ln G|.

    Exact for the geometric-mean trajectory w0 * G^T, which is the sense in
    which "the median wealth halves" is usually meant here -- the *exact*
    binomial median (median_final) sits on a lattice and therefore steps rather
    than decays smoothly, so it has no continuous half-life.

    Sign convention: the return value is a positive number of rounds when the
    typical path is *decaying* (G < 1). When G >= 1 the typical path is flat or
    growing and there is no halving, so this returns +inf rather than a negative
    number -- a negative "half-life" would read as a doubling time and it is
    not one. See doubling_time() for the growing case.
    """
    g = geometric_mean_multiplier(p, up, down, f)
    if g <= 0.0:
        return 0.0   # instant ruin: an outcome takes wealth to zero in one round
    if g >= 1.0:
        return math.inf
    return math.log(2.0) / abs(math.log(g))


def break_even_heads(rounds=100, p=0.5, up=1.5, down=0.6, f=1.0):
    """Heads needed over `rounds` to finish at or above the starting stake.

    W_T = w0 * m_up^k * m_down^(T-k) >= w0
        <=>  k*ln(m_up) + (T-k)*ln(m_down) >= 0
        <=>  k >= T * ln(1/m_down) / ln(m_up/m_down)          (for m_up > m_down)

    Returned as an exact real threshold, deliberately *not* rounded: the point
    of the number is to sit next to rounds*p (see summary()'s `expected_heads`)
    and be compared with it, and rounding it first hides gaps smaller than one
    head. A player needs ceil() of this many actual heads.

    Degenerate cases, all handled without dividing by zero:
      * f == 0, or up == down  ->  m_up == m_down, wealth is deterministic.
        Returns 0.0 if that constant multiplier is >= 1 (every k breaks even)
        and +inf if it is < 1 (no k does).
      * m_down <= 0 (a loss wipes you out): only an all-heads run survives, so
        this returns `rounds` when m_up >= 1 and +inf when it does not.
    """
    T = float(rounds)
    mu, md = multipliers(up, down, f)
    if md <= 0:
        return T if mu >= 1.0 else math.inf
    if mu <= 0:
        return math.inf
    lu, ld = math.log(mu), math.log(md)
    if lu == ld:
        return 0.0 if ld >= 0.0 else math.inf
    return T * (-ld) / (lu - ld)


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

    Both degenerate coins are reachable from the page's own sliders (`up`
    bottoms out at 1.00 and `down` tops out at 1.00), and the closed form
    divides by a*b, so each needs its own answer rather than a NaN:

    - a = 0 (no upside): nothing to win, so stake nothing. f* = 0.
    - b = 0 (no downside): nothing can ever wipe you out, so Kelly is
      unbounded and the only thing binding is the page's own f <= 1. This is
      a free roll, NOT an edgeless coin -- returning NaN here previously sent
      the Kelly scenario down its "no edge, don't play" branch on a bet that
      cannot lose.
    """
    a, b, q = up - 1.0, 1.0 - down, 1.0 - p
    if a <= 0:
        return 0.0
    if b <= 0:
        return 1.0 if p > 0.0 else 0.0
    f = (p * a - q * b) / (a * b)
    return max(0.0, min(f, (1.0 / b) - 1e-12))


# `growth_at_fraction(f, p, up, down)` is not defined separately: it is exactly
# time_growth(p, up, down, f), which already exists. The three functions below
# are the quantities *around* that curve -- its maximum, its second zero, and
# the time it implies.


def kelly_growth(p=0.5, up=1.5, down=0.6):
    """The time-average growth rate achieved at f*: max_f time_growth. Exact.

    Composition of two exact closed forms -- kelly_fraction is the analytic
    argmax, and time_growth is the analytic objective -- so no search is
    involved. Zero for a non-positive edge, since f* is then 0 and standing
    aside neither grows nor shrinks the bankroll.
    """
    return time_growth(p, up, down, kelly_fraction(p, up, down))


def zero_growth_fraction(p=0.5, up=1.5, down=0.6, tol=1e-13, iters=200):
    """The positive f > f* at which time_growth returns to zero.

    Past this stake, betting more makes you *poorer* than not playing at all,
    even though the game has a positive edge. It is the second root of

        g(f) = p ln(1 + a f) + (1 - p) ln(1 - b f),   a = up - 1, b = 1 - down

    g(0) = 0, g rises to its maximum at f*, then falls to -inf as f -> 1/b.

    EXACT ONLY AT p = 1/2. There the equation collapses to (1+af)(1-bf) = 1,
    i.e. f(a - b - a b f) = 0, giving f0 = (a - b)/(a b) = 2 f* exactly. For any
    other p the equation is (1+af)^p (1-bf)^(1-p) = 1, a transcendental relation
    with no elementary solution, so this function is a NUMERICAL ROOT FIND for
    p != 1/2: bisection on the bracket [f*, 1/b), 200 halvings, stopping once
    the bracket is narrower than `tol` (1e-13 by default). js/engine.js runs the
    identical loop in the identical order so the two agree to the last bit.

    Returns 0.0 when the edge is non-positive: g(f) < 0 for every f > 0 there,
    so the only fraction with zero growth is zero itself.
    """
    a, b = up - 1.0, 1.0 - down
    if a <= 0 or b <= 0:
        return float("nan")
    f_star = kelly_fraction(p, up, down)
    if f_star <= 0.0:
        return 0.0
    if abs(p - 0.5) < 1e-15:
        return (a - b) / (a * b)          # exact: the (1+af)(1-bf) = 1 root
    lo, hi = f_star, (1.0 / b) * (1.0 - 1e-12)
    if lo >= hi or time_growth(p, up, down, hi) > 0.0:
        return hi                          # f* is already pinned to the barrier
    for _ in range(int(iters)):
        if hi - lo <= tol:
            break
        mid = 0.5 * (lo + hi)
        if time_growth(p, up, down, mid) > 0.0:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def doubling_time(p=0.5, up=1.5, down=0.6, f=1.0):
    """Rounds for the typical path to double: ln(2)/E[ln m]. Exact.

    +inf when the time-average growth is zero or negative -- the typical path
    never doubles, and a negative number here would read as a half-life. See
    median_half_life() for that case.
    """
    g = time_growth(p, up, down, f)
    if not math.isfinite(g) or g <= 0.0:
        return math.inf
    return math.log(2.0) / g


def sigma_log(p=0.5, up=1.5, down=0.6, f=1.0):
    """Per-round standard deviation of log wealth (the volatility drag driver)."""
    mu, md = multipliers(up, down, f)
    if mu <= 0 or md <= 0:
        return math.inf
    return math.sqrt(p * (1 - p)) * abs(math.log(mu) - math.log(md))


def variance_final(w0=100.0, rounds=100, p=0.5, up=1.5, down=0.6, f=1.0):
    """Var[W_T], exact.

    W_T = w0 * prod(M_i), M_i iid, so E[W_T^2] = w0^2 * E[M^2]^rounds and
    Var[W_T] = E[W_T^2] - E[W_T]^2. Grows relative to the mean whenever the
    multipliers are dispersed at all -- the reason a positive-ensemble-growth
    game can still look nothing like its own expectation on any one path.
    """
    mu, md = multipliers(up, down, f)
    e2 = w0 * w0 * (p * mu * mu + (1 - p) * md * md) ** rounds
    e1 = expected_final(w0, rounds, p, up, down, f)
    return max(0.0, e2 - e1 * e1)  # clamp: pure float roundoff, never real


def sd_final(w0=100.0, rounds=100, p=0.5, up=1.5, down=0.6, f=1.0):
    """SD[W_T], exact -- see variance_final."""
    return math.sqrt(variance_final(w0, rounds, p, up, down, f))


def summary(w0=100.0, rounds=100, p=0.5, up=1.5, down=0.6, f=1.0):
    """Everything the page's stat tiles and table view need, in one dict."""
    return {
        "ensemble_growth": ensemble_growth(p, up, down, f),
        "time_growth": time_growth(p, up, down, f),
        "expected_final": expected_final(w0, rounds, p, up, down, f),
        "median_final": median_final(w0, rounds, p, up, down, f),
        "sd_final": sd_final(w0, rounds, p, up, down, f),
        "p_below_start": prob_below(w0, w0, rounds, p, up, down, f),
        "p_below_one": prob_below(1.0, w0, rounds, p, up, down, f),
        "q05": quantile_final(0.05, w0, rounds, p, up, down, f),
        "q95": quantile_final(0.95, w0, rounds, p, up, down, f),
        "kelly_f": kelly_fraction(p, up, down),
        "sigma_log": sigma_log(p, up, down, f),
        # The two multipliers whose disagreement is the whole scenario, and the
        # AM-GM gap between them.
        "arithmetic_multiplier": arithmetic_mean_multiplier(p, up, down, f),
        "geometric_multiplier": geometric_mean_multiplier(p, up, down, f),
        "volatility_drag": volatility_drag(p, up, down, f),
        "median_half_life": median_half_life(p, up, down, f),
        # `break_even_heads` next to `expected_heads` is the "you need 55 and
        # expect 50" comparison; break_even_heads is deliberately unrounded.
        "break_even_heads": break_even_heads(rounds, p, up, down, f),
        "expected_heads": rounds * p,
        "kelly_growth": kelly_growth(p, up, down),
        "zero_growth_f": zero_growth_fraction(p, up, down),
        "doubling_time": doubling_time(p, up, down, f),
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


# =============================================================================
# 2. Gambler's ruin -- additive bets against two absorbing barriers
# =============================================================================
# Everything here works in units of one bet, because that is the only thing the
# walk can move by. A $5 bet from a $100 bankroll toward a $200 target is the
# same problem as a 1-step walk from 20 toward 40, and writing it that way is
# what keeps the closed forms from acquiring a bet-size term.


def bets(amount, bet):
    """`amount` expressed as a whole number of bets, at least one.

    floor(x + 0.5), not round(x): Python's round() is banker's rounding, so
    round(2.5) is 2 while JavaScript's Math.round(2.5) is 3. A $100 bankroll at
    a $40 bet lands exactly on such a tie, and the two engines would then
    disagree about the size of the board.
    """
    return max(1, int(math.floor(amount / max(bet, 1e-12) + 0.5)))


def ruin_units(bankroll=100.0, target=200.0, bet=5.0):
    """(k, n): start and target in whole bets, clamped so 0 < k < n."""
    k = bets(bankroll, bet)
    return k, max(k + 1, bets(target, bet))


def ruin_prob_units(k, n, p=0.49):
    """P(hit 0 before n) for a walk starting at k. The exact core.

        p = 1/2:  1 - k/n
        else:     (r^k - r^n) / (1 - r^n),  r = q/p

    The r > 1 case (an unfavourable game, which is the interesting one) is
    algebraically rearranged to use only negative powers of r. Written directly,
    r^n overflows for a long walk -- p = 0.45 with n = 4000 asks for 1.22^4000 --
    and the ratio of two infinities is a nan where the true answer is ~1.

    Taking (k, n) rather than dollars is what lets the bet-size sweep stay
    exact: it can walk integer k directly instead of dividing dollars by a bet
    size and rounding twice, which puts a sawtooth on an otherwise smooth curve.
    """
    if p <= 0.0:
        return 1.0
    if p >= 1.0:
        return 0.0
    if abs(p - 0.5) < 1e-15:
        return 1.0 - k / n
    r = (1.0 - p) / p
    if r > 1.0:
        return (1.0 - r ** (k - n)) / (1.0 - r ** (-n))
    return (r ** k - r ** n) / (1.0 - r ** n)


def ruin_prob(bankroll=100.0, target=200.0, p=0.49, bet=5.0):
    """P(hit $0 before hitting the target), in dollars. Exact."""
    k, n = ruin_units(bankroll, target, bet)
    return ruin_prob_units(k, n, p)


def reach_target_prob(bankroll=100.0, target=200.0, p=0.49, bet=5.0):
    """P(hit the target before $0). Exact -- the walk is certain to hit one."""
    return 1.0 - ruin_prob(bankroll, target, p, bet)


def ruin_prob_unbounded(bankroll=100.0, p=0.49, bet=5.0):
    """P(eventual ruin) with no target, against a house with unlimited money.

    The n -> inf limit: certain ruin at a fair or unfavourable coin, and (q/p)^k
    when the player has the edge. This is the number that makes "quit while
    you're ahead" a theorem rather than folk wisdom.
    """
    k = bets(bankroll, bet)
    if p <= 0.5:
        return 1.0
    return ((1.0 - p) / p) ** k


def ruin_duration_units(k, n, p=0.49):
    """E[steps until either barrier is hit] for a walk starting at k. Exact.

        p = 1/2:  k(n - k)
        else:     [k - n * (1 - r^k)/(1 - r^n)] / (q - p)

    Same overflow rearrangement as ruin_prob_units for r > 1.
    """
    if p <= 0.0:
        return float(k)
    if p >= 1.0:
        return float(n - k)
    if abs(p - 0.5) < 1e-15:
        return float(k * (n - k))
    r, q = (1.0 - p) / p, 1.0 - p
    if r > 1.0:
        ratio = (r ** (k - n) - r ** (-n)) / (1.0 - r ** (-n))
    else:
        ratio = (1.0 - r ** k) / (1.0 - r ** n)
    return (k - n * ratio) / (q - p)


def ruin_duration(bankroll=100.0, target=200.0, p=0.49, bet=5.0):
    """E[rounds until one barrier is hit], in dollars. Exact."""
    k, n = ruin_units(bankroll, target, bet)
    return ruin_duration_units(k, n, p)


def ruin_terminal_stats(bankroll=100.0, target=200.0, p=0.49, bet=5.0):
    """E and SD of terminal wealth, exact.

    The walk is certain to end at exactly one of two absorbing values, so
    terminal wealth is a two-point (Bernoulli-shaped) variable: `target` with
    probability q = reach_target_prob, $0 otherwise. That collapses the usual
    machinery to E = target*q and Var = target^2 * q*(1-q).
    """
    q = reach_target_prob(bankroll, target, p, bet)
    return target * q, target * math.sqrt(q * (1.0 - q))


def ruin_summary(bankroll=100.0, target=200.0, p=0.49, bet=5.0, **_):
    """Everything the ruin scenario's tiles and table need."""
    k, n = ruin_units(bankroll, target, bet)
    mean, sd = ruin_terminal_stats(bankroll, target, p, bet)
    return {
        "k": k,
        "n": n,
        "ruin_prob": ruin_prob(bankroll, target, p, bet),
        "reach_prob": reach_target_prob(bankroll, target, p, bet),
        "duration": ruin_duration(bankroll, target, p, bet),
        "ruin_unbounded": ruin_prob_unbounded(bankroll, p, bet),
        "fair_ruin_prob": ruin_prob(bankroll, target, 0.5, bet),
        "edge": 2.0 * p - 1.0,
        "terminal_mean": mean,
        "terminal_sd": sd,
    }


def ruin_curve(target=200.0, p=0.49, bet=5.0, points=None):
    """P(ruin) as a function of starting bankroll, in bets, over (0, target)."""
    n = max(2, bets(target, bet))
    step = max(1, n // (points or n))
    xs = list(range(0, n + 1, step))
    if xs[-1] != n:
        xs.append(n)
    # The endpoints are the barriers themselves, not walks: a player standing on
    # $0 is already ruined and one standing on the target has already won. Both
    # are outside ruin_prob's domain, which clamps to 0 < k < n.
    return xs, [
        1.0 if k == 0 else 0.0 if k == n else
        ruin_prob(k * bet, n * bet, p, bet) for k in xs
    ]


def ruin_bet_curve(bankroll=100.0, target=200.0, p=0.49, k_max=None):
    """P(ruin) as a function of bet size -- the bold-play curve.

    For an unfavourable coin this *decreases* with bet size: every extra round
    is another chance for the edge to bite, so the way to survive a bad game is
    to play it as few times as possible. For a favourable coin it increases.

    Swept over the integer number of bets k the bankroll is worth, not over
    dollar bet sizes. A dollar sweep has to divide and round twice -- once for k
    and once for n -- and the two roundings beat against each other, printing a
    sawtooth on a curve that is genuinely smooth. Here k is exact by
    construction and only the target rounds.
    """
    goal = target / max(bankroll, 1e-12)
    top = int(k_max or max(2, round(bankroll)))
    sizes, ruin = [], []
    for k in range(top, 1, -1):  # descending k is ascending bet size
        n = max(k + 1, int(math.floor(k * goal + 0.5)))
        sizes.append(bankroll / k)
        ruin.append(ruin_prob_units(k, n, p))
    return sizes, ruin


def simulate_ruin(n_paths=400, rounds=800, bankroll=100.0, target=200.0,
                  p=0.49, bet=5.0, seed=7):
    """Reference walk with both barriers absorbing, in units of one bet.

    Draws exactly one random number per live round and none once absorbed, so
    js/engine.js reproduces these paths only if it stops drawing at the same
    moment. That is the point of checking it.
    """
    k, n = ruin_units(bankroll, target, bet)
    rand = mulberry32(seed)
    paths = []
    for _ in range(n_paths):
        x, path = k, [k]
        for _ in range(rounds):
            if 0 < x < n:
                x += 1 if rand() < p else -1
            path.append(x)
        paths.append(path)
    return paths, k, n


# =============================================================================
# 3. St Petersburg -- a divergent expectation
# =============================================================================
# A coin is tossed until it fails. `p` is the probability it keeps going and `m`
# the factor the pot grows by, so a game ending on toss n pays m^(n-1) with
# probability p^(n-1)(1-p). The expectation is a geometric series in m*p, which
# is the whole paradox in one product: it diverges at m*p >= 1 and the classic
# game sits exactly on the boundary at 2 * 1/2 = 1.


def sp_expected(p=0.5, m=2.0):
    """E[payout] = (1-p)/(1-mp), or infinity once m*p >= 1. Exact."""
    if m * p >= 1.0:
        return math.inf
    return (1.0 - p) / (1.0 - m * p)


def sp_dispersion(p=0.5, m=2.0):
    """(mean, sd) of the payout, each either a finite number or +inf. Exact.

    E[X^2] = Sum_{n>=1} m^(2n-2) p^(n-1)(1-p) = (1-p)/(1-m^2 p), a *stricter*
    geometric series than the mean's -- it needs m^2 p < 1, not just m*p < 1.
    So there is a middle band, m*p < 1 <= m^2*p, where the mean is finite but
    the variance already is not: the payout has a well-defined average, and
    an undefined spread around it.
    """
    mean = sp_expected(p, m)
    if not math.isfinite(mean) or m * m * p >= 1.0:
        return mean, math.inf
    e2 = (1.0 - p) / (1.0 - m * m * p)
    return mean, math.sqrt(max(0.0, e2 - mean * mean))


def sp_quantile(q, p=0.5, m=2.0):
    """Exact q-quantile of the payout.

    The toss count N is geometric with P(N <= n) = 1 - p^n, and the payout is
    monotone in N, so the quantile is m^(n_q - 1) with n_q = ceil(ln(1-q)/ln p).
    No approximation is involved -- the payout distribution is discrete and this
    is its exact inverse CDF.
    """
    if p <= 0.0:
        return 1.0
    n = max(1, math.ceil(math.log1p(-q) / math.log(p)))
    return m ** (n - 1)


def sp_median(p=0.5, m=2.0):
    """Exact median payout. For the classic game this is $1."""
    return sp_quantile(0.5, p, m)


def sp_survival(tier, p=0.5):
    """P(payout >= m^(tier-1)) = P(N >= tier) = p^(tier-1). Exact."""
    return p ** (max(1, int(tier)) - 1)


def sp_tier_contribution(tier, p=0.5, m=2.0):
    """This tier's contribution to E[payout]: its payout times its probability.

    = (1-p) * (m*p)^(tier-1). Flat in `tier` exactly when m*p = 1, which is why
    the classic game's expectation diverges: every further doubling adds the same
    $0.50, forever.
    """
    return (1.0 - p) * (m * p) ** (max(1, int(tier)) - 1)


def sp_cap_amount(m=2.0, tiers=31):
    """The largest payout a house honouring `tiers` tosses can be asked for."""
    return m ** (max(1, int(tiers)) - 1)


def sp_capped_expected(p=0.5, m=2.0, tiers=31):
    """E[payout] when the house pays at most m^(tiers-1). Exact.

    A finite bankroll is the paradox's real resolution: the sum stops. For the
    classic game this is tiers/2 + 1/2, so a house good for $2^30 (about $1.07
    billion) turns an infinite expectation into $16.
    """
    L = max(1, int(tiers))
    x = m * p
    geo = float(L) if abs(x - 1.0) < 1e-15 else (1.0 - x ** L) / (1.0 - x)
    return (1.0 - p) * geo + (p ** L) * (m ** (L - 1))


def sp_log_utility(p=0.5, m=2.0):
    """E[ln X], Daniel Bernoulli's 1738 resolution. Exact, in closed form.

    X = m^(N-1) with N geometric on {1, 2, ...}, P(N = n) = p^(n-1) (1-p), so

        E[ln X] = ln(m) * E[N - 1]
                = ln(m) * (1-p) * Sum_{n>=1} (n-1) p^(n-1)
                = ln(m) * (1-p) * p/(1-p)^2
                = ln(m) * p / (1 - p)

    using Sum_{j>=0} j x^j = x/(1-x)^2 at x = p. Derived, not summed
    numerically. The key point: this converges for *every* p < 1 and every
    finite m, including the classic p = 1/2, m = 2 game whose E[X] is infinite.
    Log utility is what makes an infinite-expectation gamble finite-valued.

    +inf when p >= 1 (the coin never fails) and 0 when m <= 1 with p = 0.
    """
    if m <= 0.0:
        return -math.inf
    if p >= 1.0:
        return math.inf if m > 1.0 else (-math.inf if m < 1.0 else 0.0)
    if p <= 0.0:
        return 0.0
    return math.log(m) * p / (1.0 - p)


def sp_certainty_equivalent(p=0.5, m=2.0):
    """exp(E[ln X]) = m^(p/(1-p)): the sure amount a log player would swap for.

    Exact -- just the exponential of sp_log_utility's closed form.

    A note on the famous number: this module's payout convention is m^(N-1),
    so the classic p = 1/2, m = 2 game pays $1, $2, $4, ... and its certainty
    equivalent is exactly 2^1 = $2.00. The "about $4" figure usually quoted
    for Bernoulli's resolution belongs to the *other* common statement of the
    game, which pays 2^N ($2, $4, $8, ...) -- twice this payout at every tier,
    hence exactly twice the certainty equivalent. Same maths, different
    indexing; lab/verify.py checks this against a Monte Carlo of the game as
    this module actually defines it.
    """
    return math.exp(sp_log_utility(p, m))


def sp_typical_mean(plays=20000, p=0.5, m=2.0):
    """APPROXIMATION -- not a closed form for anything exact.

    In `plays` plays the deepest tier a player is likely to reach is about
    L = log(plays)/log(1/p), and beyond that the tail has not been sampled at
    all. So the sample mean behaves like the expectation capped at L, which for
    the classic game is the familiar (1/2)log2(plays). Verified against Monte
    Carlo to within a few tens of percent in lab/verify.py -- it predicts where
    the running mean will be loitering, not a limit, because there is no limit.
    """
    if plays < 1 or p <= 0.0 or p >= 1.0:
        return sp_capped_expected(p, m, 1)
    L = int(math.floor(math.log(plays) / math.log(1.0 / p))) + 1
    return sp_capped_expected(p, m, max(1, L))


def sp_summary(p=0.5, m=2.0, tiers=31, plays=20000, **_):
    """Everything the St Petersburg scenario's tiles and table need."""
    mean, sd = sp_dispersion(p, m)
    return {
        "expected": sp_expected(p, m),
        "median": sp_median(p, m),
        "q95": sp_quantile(0.95, p, m),
        "capped": sp_capped_expected(p, m, tiers),
        "cap_amount": sp_cap_amount(m, tiers),
        "typical_mean": sp_typical_mean(plays, p, m),
        "divergent": m * p >= 1.0,
        "mp": m * p,
        "sd": sd,
        "sd_divergent": not math.isfinite(sd),
        "m2p": m * m * p,
        # Bernoulli's own 1738 answer: E[ln X] converges where E[X] does not.
        "log_utility": sp_log_utility(p, m),
        "certainty_equivalent": sp_certainty_equivalent(p, m),
    }


def simulate_st_petersburg(runs=12, plays=20000, p=0.5, m=2.0, seed=7):
    """Reference play-out: `runs` independent players, `plays` games each.

    One random number per toss, so the draw order is the contract js/engine.js
    has to reproduce. Returns (final running mean per run, first run's opening
    payouts).
    """
    rand = mulberry32(seed)
    means, first_payouts = [], []
    for r in range(runs):
        total = 0.0
        for i in range(plays):
            tosses = 1
            while rand() < p:
                tosses += 1
            payout = m ** (tosses - 1)
            total += payout
            if r == 0 and i < 10:
                first_payouts.append(payout)
        means.append(total / plays)
    return means, first_payouts


# =============================================================================
# 4. Iterated prisoner's dilemma -- exact, by DP over the pair's joint state
# =============================================================================
# No Monte Carlo here. Each strategy needs at most two bits of history (the
# opponent's last move, and whether the opponent has ever defected), so a pair's
# joint state is one of 16 and the expected score is an exact forward pass over
# the rounds. That holds with a random player and with execution noise, which is
# where a simulation would otherwise have been the easy way out.

STRATEGIES = ("tft", "grim", "allc", "alld", "rand")

STRATEGY_LABELS = {
    "tft": "Tit for tat",
    "grim": "Grim trigger",
    "allc": "Always cooperate",
    "alld": "Always defect",
    "rand": "Random",
}


def pd_payoffs(t=5.0, r=3.0, pp=1.0, s=0.0):
    """The dilemma's four payoffs, as seen by one player.

    A prisoner's dilemma needs t > r > pp > s (defecting is individually better,
    whatever the opponent does) *and* 2r > t + s (mutual cooperation beats taking
    turns exploiting each other). The page's slider range enforces both.
    """
    return {"T": t, "R": r, "P": pp, "S": s}


def pd_is_dilemma(pay):
    """Whether these payoffs actually constitute a prisoner's dilemma."""
    return (pay["T"] > pay["R"] > pay["P"] > pay["S"]
            and 2 * pay["R"] > pay["T"] + pay["S"])


def _p_cooperate(strategy, first, opp_defected_last, triggered):
    """P(this strategy intends to cooperate) given the state it can see."""
    if strategy == "allc":
        return 1.0
    if strategy == "alld":
        return 0.0
    if strategy == "rand":
        return 0.5
    if strategy == "tft":
        return 1.0 if first else (0.0 if opp_defected_last else 1.0)
    if strategy == "grim":
        return 0.0 if triggered else 1.0
    raise ValueError(f"unknown strategy: {strategy}")


def _payoff(pay, me_coop, them_coop):
    if me_coop:
        return pay["R"] if them_coop else pay["S"]
    return pay["T"] if them_coop else pay["P"]


def pd_pair(sa, sb, rounds=50, payoffs=None, noise=0.0):
    """Exact expected per-round score for each side of one iterated match.

    State is (b defected last, a defected last, b ever defected, a ever
    defected) -- everything any of the five strategies can condition on. `noise`
    is a trembling hand: each intended move is flipped with that probability,
    and the flipped move is what both the payoff and the opponent's memory see.
    """
    pay = payoffs or pd_payoffs()
    e = noise
    dist = {(False, False, False, False): 1.0}
    total_a = total_b = 0.0

    for rnd in range(rounds):
        first = rnd == 0
        nxt = {}
        for (bl, al, be, ae), w in dist.items():
            # `bl`/`be` are what A can see about B, so they drive A's move.
            ca = _p_cooperate(sa, first, bl, be)
            cb = _p_cooperate(sb, first, al, ae)
            pa = ca * (1.0 - e) + (1.0 - ca) * e
            pb = cb * (1.0 - e) + (1.0 - cb) * e
            for a_coop, wa in ((True, pa), (False, 1.0 - pa)):
                if wa <= 0.0:
                    continue
                for b_coop, wb in ((True, pb), (False, 1.0 - pb)):
                    if wb <= 0.0:
                        continue
                    ww = w * wa * wb
                    total_a += ww * _payoff(pay, a_coop, b_coop)
                    total_b += ww * _payoff(pay, b_coop, a_coop)
                    key = (not b_coop, not a_coop,
                           be or not b_coop, ae or not a_coop)
                    nxt[key] = nxt.get(key, 0.0) + ww
        dist = nxt

    return total_a / rounds, total_b / rounds


def pd_matrix(rounds=50, payoffs=None, noise=0.0, strategies=STRATEGIES):
    """A[i][j] = expected per-round score of strategy i against strategy j."""
    return [[pd_pair(si, sj, rounds, payoffs, noise)[0] for sj in strategies]
            for si in strategies]


def pd_tournament(rounds=50, payoffs=None, noise=0.0, strategies=STRATEGIES):
    """Round-robin scores, every strategy against every strategy and itself.

    Axelrod's 1980 tournament included self-play, and it matters: the strategies
    that win are the ones that do well against copies of themselves.
    """
    A = pd_matrix(rounds, payoffs, noise, strategies)
    scores = [sum(row) / len(row) for row in A]
    return A, scores


def pd_replicator(A, generations=60, x0=None):
    """Discrete replicator dynamics on the tournament matrix.

    A strategy's share grows in proportion to how far its payoff against the
    current mix beats the mix's average. Payoffs are non-negative here, so the
    usual positivity requirement is satisfied without shifting the matrix.
    """
    n = len(A)
    x = list(x0) if x0 else [1.0 / n] * n
    history = [x[:]]
    for _ in range(max(0, int(generations))):
        fit = [sum(x[j] * A[i][j] for j in range(n)) for i in range(n)]
        tot = sum(x[i] * fit[i] for i in range(n))
        if tot <= 0.0:
            history.append(x[:])
            continue
        x = [x[i] * fit[i] / tot for i in range(n)]
        history.append(x[:])
    return history


def pd_summary(rounds=50, t=5.0, noise=0.0, generations=60, **_):
    """Everything the prisoner's dilemma scenario's tiles and table need."""
    pay = pd_payoffs(t=t)
    A, scores = pd_tournament(rounds, pay, noise)
    hist = pd_replicator(A, generations)
    best = max(range(len(scores)), key=lambda i: scores[i])
    final = hist[-1]
    dominant = max(range(len(final)), key=lambda i: final[i])
    return {
        "matrix": A,
        "scores": scores,
        "winner": STRATEGIES[best],
        "winner_score": scores[best],
        "shares": hist,
        "dominant": STRATEGIES[dominant],
        "dominant_share": final[dominant],
        "tft_vs_alld": pd_pair("tft", "alld", rounds, pay, noise)[0],
        "alld_vs_tft": pd_pair("alld", "tft", rounds, pay, noise)[0],
        "is_dilemma": pd_is_dilemma(pay),
    }


# =============================================================================
# 5. Monty Hall -- the host's knowledge as a dial, not an assumption
# =============================================================================
# N doors, one prize. You pick one, the host opens `k` of the others, and you are
# offered the switch. Everything turns on how the host chose which doors to open:
#
#   a knowing host  never opens the prize, so all of the probability mass sitting
#                   on the doors he opened moves onto the doors he did not
#   a random host   opens k of the N-1 doors you did not pick, prize or no prize
#
# `know` is the probability the host knows, so q = 1 recovers the 1990 puzzle and
# q = 0 the "host got lucky" version in which switching is worth nothing. The
# quantities below are conditional on only goats having been revealed, because
# that is the position the puzzle puts the reader in: a game in which the prize
# was revealed is already lost and is not offered a choice.


def mh_board(doors=3, opened=1):
    """(N, k) with k clamped so at least one unopened door remains to switch to.

    k = N - 1 would leave nothing to switch to and k > N - 1 is not a board at
    all, so the page's `opened` slider is clamped here rather than at the point
    of use -- the closed forms below divide by N - 1 - k.
    """
    n = max(3, int(doors))
    return n, min(max(1, int(opened)), n - 2)


def mh_goat_prob(doors=3, opened=1, know=1.0):
    """P(the host's k doors were all goats). Exact.

    A knowing host manages it every time; a random one fails whenever the prize
    was among the doors he opened, which happens with probability k/(N-1) once
    the prize is not behind the player's own door:

        P = q + (1 - q) * (N - k)/N
    """
    n, k = mh_board(doors, opened)
    q = min(max(float(know), 0.0), 1.0)
    return q + (1.0 - q) * (n - k) / n


def mh_switch_joint(doors=3, opened=1, know=1.0):
    """P(switching wins AND only goats were revealed). Exact.

    Two disjoint routes to the same event:

        knowing host  the prize is behind one of the N-1 doors you did not pick
                      (probability (N-1)/N), it is never revealed, and the door
                      you switch to is one of the N-1-k that survive
        random host   the prize is unchosen *and* unrevealed, probability
                      (N-1-k)/N, and again you land on it 1 time in N-1-k

    The second route cancels to 1/N exactly, which is the whole content of "a
    lucky host tells you nothing".
    """
    n, k = mh_board(doors, opened)
    q = min(max(float(know), 0.0), 1.0)
    return q * (n - 1.0) / (n * (n - 1.0 - k)) + (1.0 - q) / n


def mh_switch_prob(doors=3, opened=1, know=1.0):
    """P(switching wins | only goats were revealed). Exact.

    At q = 1 this is (N-1) / (N(N-1-k)) -- two thirds for the classic board --
    and at q = 0 it is 1/(N-k), exactly equal to staying.
    """
    return mh_switch_joint(doors, opened, know) / mh_goat_prob(doors, opened, know)


def mh_stay_prob(doors=3, opened=1, know=1.0):
    """P(staying wins | only goats were revealed) = (1/N) / P(goats). Exact.

    Note that this *rises* as the host opens more doors under a random host: the
    reveal is evidence about where the prize is not, and some of that evidence
    lands on the player's own door. Under a knowing host it cannot, which is why
    staying stays at 1/N there however many doors get opened.
    """
    n, _ = mh_board(doors, opened)
    return (1.0 / n) / mh_goat_prob(doors, opened, know)


def mh_summary(doors=3, opened=1, know=1.0, **_):
    """Everything the Monty Hall scenario's tiles and table need."""
    n, k = mh_board(doors, opened)
    switch = mh_switch_prob(doors, opened, know)
    stay = mh_stay_prob(doors, opened, know)
    return {
        "doors": n,
        "opened": k,
        "switch_prob": switch,
        "stay_prob": stay,
        "advantage": switch - stay,
        "ratio": switch / stay if stay > 0 else math.inf,
        "goat_prob": mh_goat_prob(doors, opened, know),
        # The two extremes the reader's `know` slider sits between.
        "switch_knowing": mh_switch_prob(doors, opened, 1.0),
        "switch_random": mh_switch_prob(doors, opened, 0.0),
        # Unconditional: a revealed prize counted as the loss it is.
        "switch_uncond": mh_switch_joint(doors, opened, know),
        "stay_uncond": 1.0 / n,
    }


def mh_know_curve(doors=3, opened=1, points=101, **_):
    """(know values, switch prob, stay prob) over the host's-knowledge dial.

    Every point is one evaluation of mh_switch_prob / mh_stay_prob -- the curve
    connects the two limits mh_summary already reports, and adds no new maths.
    """
    ks = [i / (points - 1) for i in range(points)]
    switch = [mh_switch_prob(doors, opened, k) for k in ks]
    stay = [mh_stay_prob(doors, opened, k) for k in ks]
    return ks, switch, stay


def mh_doors_curve(opened=1, max_doors=20, **_):
    """(doors, switch prob under a knowing host, switch prob under a random one),
    for door counts from 3 to max_doors, with `opened` held fixed.

    This is the comparison the scenario is actually about: the host's knowledge,
    not the door count, is what makes switching worth anything. Door counts that
    would leave nothing to switch to are skipped, same clamp as mh_board.
    """
    doors_list = [n for n in range(3, max(4, int(max_doors)) + 1)
                  if n - 2 >= opened]
    knowing = [mh_switch_prob(n, opened, 1.0) for n in doors_list]
    random_ = [mh_switch_prob(n, opened, 0.0) for n in doors_list]
    return doors_list, knowing, random_


def simulate_monty(games=20000, doors=3, opened=1, know=1.0, seed=7):
    """Reference play-out. Returns (valid, stay wins, switch wins, first games).

    Five draws per game, always, whether or not each one is needed: the prize
    door, the player's pick, whether the host knows, whether a random host
    stumbles onto the prize, and where the switch lands. Drawing conditionally
    would be faster and would also make the stream depend on the outcomes, so
    js/engine.js could only reproduce it by branching identically -- the same
    trap simulate_ruin documents about drawing past an absorbed walk.

    Only the outcome of the host's choice matters, never which doors he opened,
    so `p_reveal` and `p_switch` collapse the combinatorics into one draw each.
    """
    n, k = mh_board(doors, opened)
    q = min(max(float(know), 0.0), 1.0)
    p_reveal = k / (n - 1.0)          # a random host's chance of hitting a prize
    p_switch = 1.0 / (n - 1.0 - k)    # landing on the prize among the survivors
    rand = mulberry32(seed)
    valid = stay_wins = switch_wins = 0
    first = []
    for i in range(int(games)):
        car = int(rand() * n)
        pick = int(rand() * n)
        knows = rand() < q
        r_reveal = rand()
        r_switch = rand()
        revealed = (not knows) and car != pick and r_reveal < p_reveal
        stay = switch = False
        if not revealed:
            valid += 1
            stay = car == pick
            switch = car != pick and r_switch < p_switch
            stay_wins += stay
            switch_wins += switch
        if i < 10:
            first.append([car, pick, int(stay), int(switch)])
    return valid, stay_wins, switch_wins, first


# =============================================================================
# 6. Shannon's demon -- growth harvested from volatility
# =============================================================================
# A stock that moves by a constant factor up or down each period, split with cash
# at weight w and rebalanced back to w every `interval` periods. The default
# board is deliberately trendless: down = 1/up at p = 1/2, so the stock's own
# time-average growth is exactly zero and anything the portfolio earns came out
# of the volatility rather than out of the stock.
#
# Growth per period is exact. Over one cycle of n periods the stock multiplies by
# up^j * down^(n-j) with j ~ Binomial(n, p), so the portfolio's log return is a
# finite binomial sum -- no continuous-time limit, no log-normal approximation.


def sd_moves(vol=0.3):
    """(up, down) for a symmetric multiplicative move, with down = 1/up.

    One dial rather than two multipliers, so the "the stock ends where it
    started" case cannot be lost by dragging one slider: up * down = 1 holds by
    construction, and the trend is moved with `p` instead.
    """
    v = max(1e-9, float(vol))
    return 1.0 + v, 1.0 / (1.0 + v)


def sd_stock_growth(p=0.5, vol=0.3):
    """E[ln m] for the stock itself: p ln(up) + (1-p) ln(down). Exact.

    Zero at p = 0.5 by construction, and the sign of this number is what decides
    whether rebalancing helps or hurts.
    """
    up, down = sd_moves(vol)
    return p * math.log(up) + (1.0 - p) * math.log(down)


def sd_stock_drift(p=0.5, vol=0.3):
    """E[m] - 1 for the stock: the ensemble growth, positive even when the time
    average is zero. The gap between this and sd_stock_growth is the volatility
    drag that the demon feeds on."""
    up, down = sd_moves(vol)
    return p * up + (1.0 - p) * down - 1.0


def _log_mix(w, log_r):
    """ln(1 - w + w * exp(log_r)), evaluated without overflowing exp(log_r).

    A 500-period cycle at a 30% move asks for exp(135), which is finite, but a
    longer horizon or a bigger move is not -- and buy-and-hold *is* one cycle as
    long as the horizon. For log_r > 0 the exponent is factored out first:

        ln(1 - w + w e^L) = L + ln(w + (1 - w) e^-L)
    """
    log_r = np.asarray(log_r, dtype=float)
    out = np.empty_like(log_r)
    big = log_r > 0.0
    small = ~big
    out[small] = np.log1p(-w + w * np.exp(log_r[small]))
    out[big] = log_r[big] + np.log(w + (1.0 - w) * np.exp(-log_r[big]))
    return out


def sd_cycle_growth(interval=1, p=0.5, vol=0.3, w=0.5, cost=0.0, rounds=None):
    """Expected log growth per period when rebalancing every `interval` periods.

    Exact, as a sum over the n+1 possible cycles:

        g(n) = (1/n) * sum_j C(n,j) p^j q^(n-j)
                       [ ln(1 - w + w up^j down^(n-j)) + ln(1 - cost * turnover_j) ]

    The second term is the trading cost of the rebalance that closes the cycle.
    Turnover is the distance the stock's weight has drifted,
    |w' - w| with w' = w R / (1 - w + w R), so it is known per outcome rather
    than needing its own model. `rounds` is accepted and ignored, so the page can
    hand this function the same parameter dict as everything else.

    The value is per *complete* cycle: a horizon that is not a whole number of
    cycles leaves a partial one that is never rebalanced, and so is never charged.
    """
    n = max(1, int(interval))
    up, down = sd_moves(vol)
    j = np.arange(n + 1)
    log_r = j * math.log(up) + (n - j) * math.log(down)
    log_m = _log_mix(w, log_r)
    if cost > 0.0 and 0.0 < w < 1.0:
        w_after = np.exp(math.log(w) + log_r - log_m)
        log_c = np.log1p(-float(cost) * np.abs(w_after - w))
    else:
        # Nothing to trade at w = 0 or w = 1, and nothing to charge at zero cost.
        log_c = 0.0
    return float((binom.pmf(j, n, p) * (log_m + log_c)).sum()) / n


def sd_hold_growth(rounds=200, p=0.5, vol=0.3, w=0.5, **_):
    """Buy and hold, as expected log growth per period over `rounds`. Exact.

    Buy-and-hold is the interval = horizon case of the same formula: one cycle,
    never rebalanced, so never charged a cost. Stated over the horizon rather
    than asymptotically because the asymptote throws the interesting part away --
    a buy-and-hold portfolio of stock and cash converges to max(g_stock, 0), so
    on a trendless stock every horizon-dependent number in it collapses to zero.
    """
    return sd_cycle_growth(max(1, int(rounds)), p, vol, w, 0.0)


def sd_harvest(interval=1, rounds=200, p=0.5, vol=0.3, w=0.5, cost=0.0, **_):
    """The volatility harvest: rebalanced growth minus buy-and-hold growth."""
    return (sd_cycle_growth(interval, p, vol, w, cost)
            - sd_hold_growth(rounds, p, vol, w))


def sd_interval_curve(rounds=200, p=0.5, vol=0.3, w=0.5, cost=0.0,
                      max_interval=None):
    """(intervals, growth per period) for every rebalancing interval. Exact.

    Swept by brute force because the objective is a binomial sum over a
    *discrete* cycle length, so there is nothing to differentiate and set to
    zero. The whole sweep is sum_n (n+1) terms, which is a few tens of thousands
    of multiplications for a 200-period horizon.
    """
    top = int(max_interval or max(1, int(rounds)))
    xs = list(range(1, top + 1))
    return xs, [sd_cycle_growth(n, p, vol, w, cost) for n in xs]


def sd_best_interval(rounds=200, p=0.5, vol=0.3, w=0.5, cost=0.0):
    """(interval, growth) maximising growth per period.

    With no costs on a trendless stock the answer is 1 -- rebalance as often as
    you are allowed -- and the sweep is monotone. Costs are what put the optimum
    in the interior, which is the honest version of the story: the harvest is
    real, and it is not free.
    """
    xs, gs = sd_interval_curve(rounds, p, vol, w, cost)
    best = max(range(len(gs)), key=lambda i: gs[i])
    return xs[best], gs[best]


def sd_harvest_continuous(vol=0.3, w=0.5):
    """APPROXIMATION -- the continuous-time rebalancing premium, w(1-w)sigma^2/2.

    NOT exact for the game this page simulates. The identity is the Ito result
    for a continuously rebalanced two-asset portfolio of a driftless
    geometric Brownian motion and cash: the rebalanced portfolio's log-growth
    exceeds the weighted average of the components' log-growths by
    w(1-w)sigma^2/2. The page's stock instead takes discrete jumps of
    +-ln(1+vol) at p = 1/2, so sigma is taken as the per-period log move
    sigma = ln(1 + vol) and the formula is a small-move expansion: the two
    agree to O(sigma^2) and separate at O(sigma^4).

    The exact discrete answer for this game is sd_cycle_growth(1, 0.5, vol, w,
    0). lab/verify.py prints the size of the gap across several volatilities
    rather than asserting the two are equal, because they are not.
    """
    sigma = math.log1p(max(1e-9, float(vol)))
    return w * (1.0 - w) * sigma * sigma / 2.0


def sd_optimal_weight(p=0.5, vol=0.3):
    """The stock weight maximising growth. Exact at interval = 1.

    Rebalancing every period makes the portfolio's per-period log growth
    p ln(1 - w + w*up) + (1-p) ln(1 - w + w*down), which is term-for-term the
    multiplicative coin's time_growth with f = w -- so the maximising weight is
    literally kelly_fraction(p, up, down) and the closed form in section 1
    applies unchanged. For the symmetric trendless coin (p = 1/2,
    down = 1/up) it evaluates to exactly 1/2, Shannon's rule.

    For interval > 1 this is an approximation: the optimum then drifts with the
    cycle length and would have to be found by sweeping sd_cycle_growth over w.
    """
    up, down = sd_moves(vol)
    return kelly_fraction(p, up, down)


def sd_summary(rounds=200, p=0.5, vol=0.3, w=0.5, interval=1, cost=0.0, **_):
    """Everything the Shannon's demon scenario's tiles and table need."""
    up, down = sd_moves(vol)
    best_n, best_g = sd_best_interval(rounds, p, vol, w, cost)
    rebal = sd_cycle_growth(interval, p, vol, w, cost)
    hold = sd_hold_growth(rounds, p, vol, w)
    return {
        "up": up,
        "down": down,
        "stock_growth": sd_stock_growth(p, vol),
        "stock_drift": sd_stock_drift(p, vol),
        "rebal_growth": rebal,
        "hold_growth": hold,
        "harvest": rebal - hold,
        "best_interval": best_n,
        "best_growth": best_g,
        # The weight that harvests most is the Kelly fraction for this coin, and
        # for a symmetric trendless stock it is exactly 1/2 -- which is the rule
        # Shannon is said to have put on the board.
        "kelly_w": kelly_fraction(p, up, down),
        # APPROXIMATION -- the continuous-time identity, not the discrete game.
        "harvest_continuous": sd_harvest_continuous(vol, w),
        # Exact at interval = 1; see sd_optimal_weight.
        "optimal_weight": sd_optimal_weight(p, vol),
    }


def simulate_rebalance(n_paths=400, rounds=200, w0=100.0, p=0.5, vol=0.3, w=0.5,
                       interval=1, cost=0.0, seed=7):
    """Reference play-out: the stock, buy-and-hold, and the rebalanced portfolio.

    One draw per period per path, so the draw order is the contract js/engine.js
    reproduces. All three series start at w0 so they can share one axis: the
    stock is shown as a portfolio held 100% long rather than as a price.

    Returns (first path's (price, hold, rebal) series, terminal hold, terminal
    rebal).
    """
    up, down = sd_moves(vol)
    n = max(1, int(interval))
    rand = mulberry32(seed)
    price0 = hold0 = rebal0 = None
    term_hold, term_rebal = [], []

    for i in range(int(n_paths)):
        price, price_s = w0, [w0]
        h_stock, h_cash, hold_s = w * w0, (1.0 - w) * w0, [w0]
        r_stock, r_cash, rebal_s = w * w0, (1.0 - w) * w0, [w0]
        for t in range(1, int(rounds) + 1):
            m = up if rand() < p else down
            price *= m
            h_stock *= m
            r_stock *= m
            if t % n == 0:
                total = r_stock + r_cash
                turnover = abs(r_stock / total - w) if total > 0 else 0.0
                total *= 1.0 - cost * turnover
                r_stock, r_cash = w * total, (1.0 - w) * total
            if i == 0:
                price_s.append(price)
                hold_s.append(h_stock + h_cash)
                rebal_s.append(r_stock + r_cash)
        if i == 0:
            price0, hold0, rebal0 = price_s, hold_s, rebal_s
        term_hold.append(h_stock + h_cash)
        term_rebal.append(r_stock + r_cash)

    return (price0, hold0, rebal0), term_hold, term_rebal


# =============================================================================
# 7. Insurance and risk pooling -- a contract both sides are right to sign
# =============================================================================
# Per period a buyer of wealth W faces a loss L with probability pi. Uninsured,
# wealth is multiplied by (1 - L/W) when the loss lands and by 1 otherwise;
# insured, it is multiplied by (1 - P/W) every period and the loss never lands.
# The seller of wealth V collects P and pays L when it does.
#
# Expected wealth says this contract cannot help both of them: it is a transfer,
# and the premium exceeds the expected payout, so the buyer's expectation falls
# by exactly what the seller's expectation gains. Growth rates say otherwise, and
# the reason is that ln is concave while the two parties have different wealths:
# the same dollar of variance costs the small party more than it costs the large
# one. Everything below is one period at the current wealth, which is the
# quantity the parties are actually choosing over.


def ins_uninsured_growth(wealth=100000.0, loss=30000.0, hazard=0.05, **_):
    """pi * ln(1 - L/W): the exposed player's growth rate per period. Exact."""
    x = loss / wealth
    if x >= 1.0:
        return -math.inf
    return hazard * math.log1p(-x)


def ins_insured_growth(wealth=100000.0, premium=2000.0, **_):
    """ln(1 - P/W): the insured player's growth rate per period. Exact.

    Certain, because the premium is certain and the loss is gone. Nothing here
    is stochastic, which is the point -- the buyer has traded a distribution for
    a number.
    """
    if premium >= wealth:
        return -math.inf
    return math.log1p(-premium / wealth)


def ins_buyer_max_premium(wealth=100000.0, loss=30000.0, hazard=0.05, **_):
    """The most the buyer can pay and still improve. Exact, in closed form.

        ln(1 - P/W) = pi ln(1 - L/W)  ->  P = W [1 - (1 - L/W)^pi]

    This exceeds the expected payout pi*L for every 0 < pi < 1, strictly, by
    concavity -- which is why there is anything to trade.
    """
    x = loss / wealth
    if x >= 1.0:
        return wealth
    return wealth * (1.0 - (1.0 - x) ** hazard)


def ins_seller_growth(seller_wealth=1000000.0, premium=2000.0, loss=30000.0,
                      hazard=0.05, **_):
    """The seller's growth rate per period from writing one contract. Exact.

        pi ln(1 + (P - L)/V) + (1 - pi) ln(1 + P/V)

    -inf once P - L would take the seller below zero: a seller who cannot pay
    the claim is not a seller.
    """
    if seller_wealth + premium - loss <= 0.0:
        return -math.inf
    return (hazard * math.log1p((premium - loss) / seller_wealth)
            + (1.0 - hazard) * math.log1p(premium / seller_wealth))


def ins_seller_min_premium(seller_wealth=1000000.0, loss=30000.0, hazard=0.05,
                           tol=1e-12, **_):
    """The least the seller can accept, as the root of ins_seller_growth = 0.

    NOT a closed form -- it is a root, found by bisection. The function is
    strictly increasing in P and negative at P = pi*L (Jensen: the seller's
    expected log is below the log of its expected wealth, which is exactly zero
    there), so a bracket always exists and bisection is exact to floating point.

    That the root is above pi*L is the seller's half of the argument: expected
    value says a premium of pi*L is fair, and at a fair premium the seller's
    growth rate is negative.
    """
    lo = max(hazard * loss, loss - seller_wealth) + 1e-12
    hi = max(lo * 2.0, loss)
    for _ in range(200):
        if ins_seller_growth(seller_wealth, hi, loss, hazard) > 0.0:
            break
        hi *= 2.0
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if ins_seller_growth(seller_wealth, mid, loss, hazard) > 0.0:
            hi = mid
        else:
            lo = mid
        if hi - lo <= tol * max(1.0, hi):
            break
    return 0.5 * (lo + hi)


def ins_buyer_value(wealth=100000.0, premium=2000.0, loss=30000.0, hazard=0.05,
                    **_):
    """The buyer's gain, as growth-equivalent dollars per period: W * dg.

    Growth rates are not comparable across parties of different size -- the same
    contract is a rounding error to the insurer's rate and a lifeline to the
    buyer's -- so both sides are reported as their own wealth times their own
    change in growth rate. That puts a large and a small party on one axis
    without a second scale, and zero still means indifferent for both.
    """
    return wealth * (ins_insured_growth(wealth, premium)
                     - ins_uninsured_growth(wealth, loss, hazard))


def ins_seller_value(seller_wealth=1000000.0, premium=2000.0, loss=30000.0,
                     hazard=0.05, **_):
    """The seller's gain in the same growth-equivalent dollars per period.

    Tends to the accounting profit P - pi*L from *below* as the seller's wealth
    grows, so a very large insurer is exactly the expected-value maximiser that
    textbook insurance assumes. Below, not above: expanding V*ln(1 + x/V) to
    second order leaves a correction of

        -[ pi (P - L)^2 + (1 - pi) P^2 ] / (2V)

    which is a sum of squares over 2V and so is never positive. Concretely, at
    the scenario's defaults (P = 2000, L = 30000, pi = 0.05, accounting profit
    $500) this returns $238.7 at V = $100k, $478.1 at $1M, $497.8 at $10M and
    $499.998 at $10B -- approaching $500 from underneath the whole way. Risk
    only ever costs the seller something; it never pays a bonus.
    """
    return seller_wealth * ins_seller_growth(seller_wealth, premium, loss, hazard)


def ins_pool_growth(members=50, wealth=100000.0, loss=30000.0, hazard=0.05, **_):
    """Growth rate of one member of a mutual pool of `members`. Exact.

    Everyone pays an equal share of whatever the pool loses, so a member's
    multiplier is 1 - (L/W)(k/n) with k ~ Binomial(n, pi) losses among n members:

        g(n) = sum_k C(n,k) pi^k (1-pi)^(n-k) ln(1 - (L/W) k/n)

    n = 1 is the uninsured player and n -> inf tends to ln(1 - pi L/W), which is
    strictly better. Nobody has taken the other side of anything.
    """
    n = max(1, int(members))
    k = np.arange(n + 1)
    with np.errstate(divide="ignore"):
        val = np.log1p(-(loss / wealth) * (k / n))
    return float((binom.pmf(k, n, hazard) * val).sum())


def ins_pool_limit(wealth=100000.0, loss=30000.0, hazard=0.05, **_):
    """ln(1 - pi L/W): the n -> infinity growth rate of an infinite pool. Exact.

    The law of large numbers replaces the loss with its mean, so an infinite
    pool is the same thing as insurance at exactly the expected payout -- the
    best any premium could ever be, and an upper bound on the whole tab.
    """
    return math.log1p(-hazard * loss / wealth)


def ins_pool_break_even(premium=2000.0, wealth=100000.0, loss=30000.0,
                        hazard=0.05, max_members=100000, **_):
    """Smallest pool that beats buying insurance at `premium`.

    g(n) is increasing in n toward ln(1 - pi L/W), and any premium the seller
    would accept is above pi*L, so a finite answer always exists whenever the
    premium is one a seller could accept. Found by doubling to a bracket and then
    bisecting on the integer, never by scanning: each g(n) is an (n+1)-term sum,
    so a scan to n = 20,000 would be 200 million terms.
    """
    target = ins_insured_growth(wealth, premium)
    if ins_pool_growth(1, wealth, loss, hazard) >= target:
        return 1
    hi = 2
    while hi <= max_members:
        if ins_pool_growth(hi, wealth, loss, hazard) >= target:
            break
        hi *= 2
    if hi > max_members:
        return None
    lo = hi // 2
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if ins_pool_growth(mid, wealth, loss, hazard) >= target:
            hi = mid
        else:
            lo = mid
    return hi


def ins_premium_curve(wealth=100000.0, seller_wealth=1000000.0, loss=30000.0,
                      hazard=0.05, points=160, **_):
    """(premiums, buyer value, seller value), swept over a premium range. Exact.

    Every point is one evaluation of ins_buyer_value / ins_seller_value -- the
    sweep adds no new mathematics, only the shape that makes the band visible.
    The upper bound is sized around the band itself (rather than fixed) so the
    crossing where each curve turns negative sits comfortably inside the axis
    whatever wealth and loss are dialled to.
    """
    p_max = ins_buyer_max_premium(wealth, loss, hazard)
    p_min = ins_seller_min_premium(seller_wealth, loss, hazard)
    hi = min(wealth * 0.95, max(p_max, p_min) * 2.2)
    xs = [hi * i / (points - 1) for i in range(points)]
    buyer = [ins_buyer_value(wealth, x, loss, hazard) for x in xs]
    seller = [ins_seller_value(seller_wealth, x, loss, hazard) for x in xs]
    return xs, buyer, seller


def ins_pool_curve(wealth=100000.0, loss=30000.0, hazard=0.05, max_members=200,
                   **_):
    """(sizes, growth), one point per pool size from 1 to max_members. Exact.

    Not log-spaced: the curve is steepest at the smallest sizes, which is the
    part of "everyone is better off, immediately" the chart needs to resolve.
    """
    sizes = list(range(1, int(max_members) + 1))
    return sizes, [ins_pool_growth(n, wealth, loss, hazard) for n in sizes]


def ins_summary(wealth=100000.0, seller_wealth=1000000.0, premium=2000.0,
                loss=30000.0, hazard=0.05, members=50, **_):
    """Everything the insurance scenario's tiles and table need."""
    p_min = ins_seller_min_premium(seller_wealth, loss, hazard)
    p_max = ins_buyer_max_premium(wealth, loss, hazard)
    return {
        "expected_payout": hazard * loss,
        "buyer_max": p_max,
        "seller_min": p_min,
        "band_ok": p_min < p_max,
        "band_width": p_max - p_min,
        "uninsured_growth": ins_uninsured_growth(wealth, loss, hazard),
        "insured_growth": ins_insured_growth(wealth, premium),
        "seller_growth": ins_seller_growth(seller_wealth, premium, loss, hazard),
        "buyer_value": ins_buyer_value(wealth, premium, loss, hazard),
        "seller_value": ins_seller_value(seller_wealth, premium, loss, hazard),
        "pool_growth": ins_pool_growth(members, wealth, loss, hazard),
        "pool_limit": ins_pool_limit(wealth, loss, hazard),
        "pool_break_even": ins_pool_break_even(premium, wealth, loss, hazard),
    }


# =============================================================================
# 8. The wheel strategy -- selling premium against a rolling high and an ATH
# =============================================================================
# A cash-secured put sold below a rolling x-month high, held to expiry
# ("acquire": no take-profit, only a -30% loss stop); if assigned, a covered
# call sold at the next all-time high, closed at +70%/-30% or expiry; repeat.
# Compared against the same entry/exit signal traded in stock alone, and
# against buy-and-hold.
#
# Two contracts run on this project so far: a BIT-EXACT one for the shared
# PRNG (mulberry32 itself, and now the normal draws built on it) and a
# TOLERANCE-matched one for transcendental approximations (js/engine.js's
# rational Phi against this module's call into scipy). lab/verify.py checks
# the first at 1e-12 and the second at 1e-6 -- six correct decimal digits on a
# probability or a price is exact for every purpose this scenario has, and
# demanding bit-parity from two different Phi implementations would be
# demanding an accident.
#
# Every option here is priced European-style (no early exercise) and marked
# to its own Black-Scholes theoretical value between trades. The 90% sale /
# 100% buyback haircut is a REALIZED cost, paid once on the way in; it is not
# re-applied when marking a position for the stop-loss check, so a position
# that has not moved at all already shows an built-in paper loss of
# (0.9-1.0)/0.9 = -11.1% the instant it is marked. That is not a bug -- it is
# the honest cost of selling into a market maker's spread -- but it does mean
# the -30% stop has only about nineteen points of real room once a trade
# opens flat.

TRADING_DAYS = 252
TRADING_DAYS_PER_MONTH = 21


def norm_ppf(q):
    """Standard normal quantile. Used only for buy-and-hold's closed-form
    quantiles -- nothing path-dependent here needs an inverse CDF."""
    return float(norm.ppf(q))


def norm_cdf(x):
    """Standard normal CDF -- the Python side of a tolerance-matched (not
    bit-exact) contract with js/engine.js's rational approximation of Phi.
    See the section note above for why 1e-6 is the right bar, not 1e-12."""
    return float(norm.cdf(x))


def bs_d1_d2(s, k, t, sigma, r=0.0, q=0.0):
    """Black-Scholes d1 and d2 for a European option on a dividend-paying
    underlying. Exact, given the model's own assumptions (constant sigma,
    continuous trading, lognormal terminal price).

    d2's usual second form, (ln(S/K) + (r-q-sigma^2/2)T) / (sigma*sqrt(T)), is
    recovered algebraically by expanding d1 - sigma*sqrt(T) -- which is also
    what lets real_world_itm_prob below reuse this same function with mu in
    place of r rather than carrying a second formula that could drift from
    this one.
    """
    if t <= 0.0 or sigma <= 0.0:
        d = math.inf if s > k else (-math.inf if s < k else 0.0)
        return d, d
    vt = sigma * math.sqrt(t)
    d1 = (math.log(s / k) + (r - q + 0.5 * sigma * sigma) * t) / vt
    return d1, d1 - vt


def bs_call_price(s, k, t, sigma, r=0.0, q=0.0):
    """Black-Scholes European call. Exact under the model's own assumptions."""
    if t <= 0.0:
        return max(s - k, 0.0)
    d1, d2 = bs_d1_d2(s, k, t, sigma, r, q)
    return s * math.exp(-q * t) * norm_cdf(d1) - k * math.exp(-r * t) * norm_cdf(d2)


def bs_put_price(s, k, t, sigma, r=0.0, q=0.0):
    """Black-Scholes European put, from the same d1/d2 the call uses (put-call
    parity applied directly) rather than a second independent formula."""
    if t <= 0.0:
        return max(k - s, 0.0)
    d1, d2 = bs_d1_d2(s, k, t, sigma, r, q)
    return k * math.exp(-r * t) * norm_cdf(-d2) - s * math.exp(-q * t) * norm_cdf(-d1)


def real_world_itm_prob(s, k, t, sigma, mu=0.0, q=0.0, call=True):
    """P(a single option finishes in the money), under the *physical* measure
    (drift mu) rather than the risk-neutral one (rate r) Black-Scholes prices
    with. Exact -- S_T is lognormal under GBM, so this is one evaluation of
    Phi -- and it is the number this scenario actually cares about, since the
    question is what happens on a path drawn at mu, not what a risk-neutral
    hedger would assume.

    This is the exact anchor the wheel's own assignment rate is checked
    against: a single contract, held to expiry with no stop-loss at all. The
    simulated rate differs from it in two ways at once -- the stop can end a
    losing put early, before it would have reached expiry ITM, and the entry
    trigger is not "any day," it is "the day the price first crosses the dip
    line," which is not the unconditional distribution this formula assumes.
    """
    if t <= 0.0:
        return 1.0 if (s > k) == call else 0.0
    _, d2 = bs_d1_d2(s, k, t, sigma, r=mu, q=q)
    return norm_cdf(d2) if call else norm_cdf(-d2)


def hold_growth_rate(mu=0.08, sigma=0.20, q=0.0, **_):
    """E[ln(S_T/S_0)] / T = mu - q - sigma^2/2: the time-average growth rate of
    a continuously held position. Exact -- the continuous-time twin of
    time_growth in section 1, and the same lesson: positive drift can still
    carry a zero or negative typical outcome once volatility is large enough.
    """
    return mu - q - 0.5 * sigma * sigma


def hold_summary(w0=100000.0, mu=0.08, sigma=0.20, q=0.0, years=5.0, **_):
    """Exact terminal-wealth statistics for buy-and-hold under GBM.

    ln(S_T/S0) ~ Normal((mu-q-sigma^2/2)T, sigma^2 T), so every field below is
    a property of one lognormal distribution. Nothing here is simulated --
    contrast with the wheel, where nothing is exact.
    """
    g = hold_growth_rate(mu, sigma, q)
    vt = sigma * math.sqrt(max(years, 0.0))
    return {
        "growth_rate": g,
        "expected_final": w0 * math.exp((mu - q) * years),
        "median_final": w0 * math.exp(g * years),
        "p_below_start": norm_cdf(-(g * years) / vt) if vt > 0
                        else (1.0 if g < 0 else 0.0),
        "q05": w0 * math.exp(g * years + vt * norm_ppf(0.05)),
        "q95": w0 * math.exp(g * years + vt * norm_ppf(0.95)),
    }


def make_normal_generator(seed):
    """Standard-normal draws from the shared mulberry32 uniform stream, via
    Box-Muller.

    Two independent normals come out of every two uniforms; the second is
    cached and handed back on the *next* call rather than discarded, so
    js/engine.js must cache in the same slot for a seeded path to agree beyond
    its first draw -- the normal-draw extension of the PRNG contract that
    already covers mulberry32 itself.
    """
    rand = mulberry32(seed)
    spare = []

    def randn():
        if spare:
            return spare.pop()
        u1, u2 = rand(), rand()
        r = math.sqrt(-2.0 * math.log(max(u1, 1e-300)))
        theta = 2.0 * math.pi * u2
        z0, z1 = r * math.cos(theta), r * math.sin(theta)
        spare.append(z1)
        return z0

    return randn


def simulate_gbm_path(s0=100.0, mu=0.08, sigma=0.20, q=0.0, years=5.0, seed=7):
    """One daily-close price path under GBM. Not exact -- this is the shared
    randomness every arm of the scenario is compared on, so it is drawn once
    and read by all four rather than once per arm, which is what makes the
    *differences* between arms nearly noise-free even though none of the four
    (except buy-and-hold; see hold_summary) has a closed-form distribution.
    """
    randn = make_normal_generator(seed)
    dt = 1.0 / TRADING_DAYS
    n = max(1, round(years * TRADING_DAYS))
    drift = (mu - q - 0.5 * sigma * sigma) * dt
    vol = sigma * math.sqrt(dt)
    s, path = s0, [s0]
    for _ in range(n):
        s *= math.exp(drift + vol * randn())
        path.append(s)
    return path


def simulate_dip_strategy(path, x_months=6.0, dip_pct=0.05, stock_fee_pct=0.005,
                          r=0.03, w0=100000.0, **_):
    """Buy 100% into the stock the first time it reaches dip_pct below the
    rolling x-month high; sell everything the first time it reaches a new
    all-time high; repeat. No options anywhere -- the options-free twin of the
    wheel's own entry/exit signal, continuous rather than lot-quantized (see
    the scenario's `story` for why that asymmetry is left in on purpose).
    Not exact -- the entry/exit rule is path-dependent, same as the wheel's.
    """
    n = len(path) - 1
    window = max(1, round(x_months * TRADING_DAYS_PER_MONTH))
    dt = 1.0 / TRADING_DAYS
    cash, shares = w0, 0.0
    ath = path[0]
    dip_armed = True
    equity = [w0]
    for t in range(1, n + 1):
        s = path[t]
        cash *= math.exp(r * dt)
        hi = max(path[max(0, t - window):t + 1])
        dip_level = hi * (1.0 - dip_pct)
        if s > dip_level:
            dip_armed = True
        if s > ath:
            ath = s
        if shares == 0.0:
            if dip_armed and s <= dip_level:
                shares = (cash / (1.0 + stock_fee_pct)) / s
                cash = 0.0
                dip_armed = False
        elif s >= ath:
            cash = shares * s * (1.0 - stock_fee_pct)
            shares = 0.0
        equity.append(cash + shares * s)
    return equity


def simulate_wheel(path, x_months=6.0, y_months=3.0, dip_pct=0.05,
                   sell_haircut=0.10, share_sl=0.20, call_tp=0.70,
                   sigma_iv=0.24, r=0.03, q=0.0, stock_fee_pct=0.005,
                   opt_fee=0.65, w0=100000.0, include_calls=True, **_):
    """The wheel (or, with include_calls=False, the puts-only arm that isolates
    what the covered calls are worth) on an already-generated price path.

    The rule set is tuned to **maximise time holding the stock**, because that
    is where the return actually comes from -- premium is the smaller half of
    the story and idle cash earns only the risk-free rate:

      1. **Any idle cash sells a cash-secured put**, whether or not the account
         already holds shares. The moment there is enough free cash for one
         contract it is put to work.
      2. **Cash too small for a contract buys stock outright.** A cash-secured
         put needs 100 * strike of collateral; the remainder can never sell one
         and would otherwise sit earning `r` forever, so it buys whatever whole
         number of shares it can. This self-limits -- after the purchase, free
         cash is below one share, and it only buys again once premium and
         interest have accumulated past that.
      3. The put is **held to expiry; there is no stop on it.** In the money at
         expiry -> assigned, and the strike folds into a share-weighted average
         cost basis. Out of the money -> the premium is kept, and the freed
         collateral immediately sells the next put.
      4. Covered calls are written **only at a record high** -- a new maximum
         of the whole price history to date, not a rolling-window high -- and
         only above the cost basis. Everywhere else the shares are simply held.
      5. Call in the money at expiry -> called away at the strike; the cash
         goes straight back into puts. Otherwise the call is bought back at
         `call_tp` profit or left to expire.
      6. If the shares fall `share_sl` below the weighted basis, any open call
         is bought back and the shares are sold.

    Why the puts never wait, and the calls almost always do
    ------------------------------------------------------
    Two earlier rule sets each destroyed most of the return, and both are worth
    keeping on the record because they look reasonable on paper:

    - **Gating put re-entry on a dip.** Waiting in cash for a 5% dip before
      selling the next put left the S&P arm flat for 95% of 2009-2026. The put
      is the instrument that pays you to wait; waiting in cash *before* selling
      one is strictly worse.
    - **Writing the covered call as soon as the shares arrive.** Assignment
      happens precisely when the put finished in the money, i.e. with spot
      BELOW the strike that bought the shares, so `max(spot, basis)` collapses
      to `basis`: every call is struck at cost and being called away realises
      exactly zero on the shares. Measured on the S&P that rule struck 100% of
      its calls at the basis and held stock 4.6% of the time.

    Requiring a record high inverts the second one. A record high is, by
    construction, above every price the stock has ever traded at, so it is
    above any strike that ever bought shares -- the call is always struck at a
    profit, and the shares are held through every recovery that does not reach
    a new peak.

    Bookkeeping notes:
    - `cash` is free money; `collateral` is cash reserved against the open put
      and is held at *face value*, with the interest it earns credited to
      `cash`. So `collateral == contracts * 100 * strike` exactly whenever a
      put is open and 0 otherwise, which verify.py asserts.
    - `basis` is the share-weighted average of every price that bought shares,
      whether by assignment or by an outright odd-lot purchase.
    - The equity curve marks options to zero between transactions -- it is the
      realized cash-plus-collateral-plus-shares value, not a continuous
      mark-to-market of the open short option. The take-profit and share-stop
      decisions, unlike the curve, do mark to the live Black-Scholes price.

    Not a closed form: entry timing, the assignment cycle and the share stop
    are all path-dependent. real_world_itm_prob above is the exact quantity
    the assignment rate is checked against.
    """
    n = len(path) - 1
    dt = 1.0 / TRADING_DAYS
    put_tenor = max(1, round(x_months * TRADING_DAYS_PER_MONTH))
    call_tenor = max(1, round(y_months * TRADING_DAYS_PER_MONTH))

    cash, collateral, shares, basis = w0, 0.0, 0, 0.0
    put_lot = call_lot = None
    record_high = path[0]

    equity = [w0]
    events = []
    stats = {"puts_sold": 0, "puts_expired": 0, "assignments": 0,
             "calls_sold": 0, "calls_tp": 0, "calls_expired": 0,
             "called_away": 0, "calls_closed_on_stop": 0, "shares_stopped": 0,
             "shares_bought": 0, "puts_still_open": 0, "calls_still_open": 0}

    def add_shares(qty, price):
        """Fold a new lot into the share-weighted average cost basis."""
        nonlocal shares, basis
        basis = (basis * shares + price * qty) / (shares + qty)
        shares += qty

    for t in range(1, n + 1):
        s = path[t]
        g = math.exp(r * dt)
        cash = cash * g + collateral * (g - 1.0)

        # A *record* high: the running maximum of the whole path so far, not a
        # rolling window. This is the only moment a covered call is written,
        # and it is what guarantees the strike sits above every past purchase.
        at_record = s >= record_high
        if at_record:
            record_high = s

        # -- the put, held to expiry ---------------------------------------
        if put_lot is not None and t >= put_lot["expiry"]:
            face = put_lot["contracts"] * 100.0 * put_lot["strike"]
            collateral -= face
            if s < put_lot["strike"]:
                # The reserved collateral IS the purchase price; only the
                # transaction cost leaves the account.
                cash -= face * stock_fee_pct
                add_shares(put_lot["contracts"] * 100, put_lot["strike"])
                stats["assignments"] += put_lot["contracts"]
                events.append({"t": t, "kind": "assigned",
                               "contracts": put_lot["contracts"],
                               "strike": put_lot["strike"]})
            else:
                cash += face
                stats["puts_expired"] += put_lot["contracts"]
                events.append({"t": t, "kind": "put_expired",
                               "contracts": put_lot["contracts"],
                               "strike": put_lot["strike"]})
            put_lot = None

        # -- any idle cash sells a put, long or flat ------------------------
        if put_lot is None:
            strike = s
            n_new = int(cash // (100.0 * strike))
            if n_new > 0:
                theo = bs_put_price(s, strike, put_tenor / TRADING_DAYS,
                                    sigma_iv, r, q)
                premium = theo * (1.0 - sell_haircut)
                cash -= n_new * 100.0 * strike
                collateral += n_new * 100.0 * strike
                cash += n_new * (100.0 * premium - opt_fee)
                put_lot = {"contracts": n_new, "premium": premium,
                           "strike": strike, "expiry": t + put_tenor}
                stats["puts_sold"] += n_new
                events.append({"t": t, "kind": "sell_put",
                               "contracts": n_new, "strike": strike})

        # -- the stub that can never sell a contract buys stock outright ----
        odd = int(cash // (s * (1.0 + stock_fee_pct)))
        if odd > 0:
            cost = odd * s * (1.0 + stock_fee_pct)
            cash -= cost
            add_shares(odd, s)
            stats["shares_bought"] += odd
            events.append({"t": t, "kind": "buy_shares",
                           "contracts": odd, "strike": s})

        # -- the share stop, the strategy's only loss cap ------------------
        if shares > 0 and s < basis * (1.0 - share_sl):
            if call_lot is not None:
                texp = max(call_lot["expiry"] - t, 0) / TRADING_DAYS
                theo = (bs_call_price(s, call_lot["strike"], texp, sigma_iv, r, q)
                        if texp > 0 else max(s - call_lot["strike"], 0.0))
                cash -= call_lot["contracts"] * (100.0 * theo + opt_fee)
                # Its own bucket: a call closed because the SHARES stopped out
                # is neither a take-profit nor an expiry, and leaving it
                # uncounted silently broke the calls_sold identity.
                stats["calls_closed_on_stop"] += call_lot["contracts"]
                events.append({"t": t, "kind": "close_call_on_stop",
                               "contracts": call_lot["contracts"],
                               "strike": call_lot["strike"]})
                call_lot = None
            cash += shares * s * (1.0 - stock_fee_pct)
            events.append({"t": t, "kind": "stop_shares",
                           "contracts": shares // 100, "strike": basis})
            shares, basis = 0, 0.0
            stats["shares_stopped"] += 1

        # -- covered calls, only while long --------------------------------
        if shares > 0 and include_calls:
            if call_lot is not None:
                texp = max(call_lot["expiry"] - t, 0) / TRADING_DAYS
                theo = (bs_call_price(s, call_lot["strike"], texp, sigma_iv, r, q)
                        if texp > 0 else max(s - call_lot["strike"], 0.0))
                if t >= call_lot["expiry"]:
                    if s > call_lot["strike"]:
                        cash += (call_lot["contracts"] * 100.0
                                 * call_lot["strike"] * (1.0 - stock_fee_pct))
                        shares -= call_lot["contracts"] * 100
                        stats["called_away"] += call_lot["contracts"]
                        events.append({"t": t, "kind": "called_away",
                                       "contracts": call_lot["contracts"],
                                       "strike": call_lot["strike"]})
                        if shares == 0:
                            basis = 0.0
                    else:
                        stats["calls_expired"] += call_lot["contracts"]
                        events.append({"t": t, "kind": "call_expired",
                                       "contracts": call_lot["contracts"],
                                       "strike": call_lot["strike"]})
                    call_lot = None
                elif (call_lot["premium"] - theo) / call_lot["premium"] >= call_tp:
                    cash -= call_lot["contracts"] * (100.0 * theo + opt_fee)
                    stats["calls_tp"] += call_lot["contracts"]
                    events.append({"t": t, "kind": "close_call",
                                   "contracts": call_lot["contracts"],
                                   "strike": call_lot["strike"]})
                    call_lot = None

            # Only at a record high, and never below the basis. At a record
            # high the second condition is already implied -- it is kept as a
            # live assertion of the invariant the whole rule exists to create.
            if call_lot is None and shares >= 100 and at_record and s > basis:
                n_new = shares // 100
                strike = max(s, basis)
                theo = bs_call_price(s, strike, call_tenor / TRADING_DAYS,
                                     sigma_iv, r, q)
                premium = theo * (1.0 - sell_haircut)
                cash += n_new * (100.0 * premium - opt_fee)
                call_lot = {"contracts": n_new, "premium": premium,
                            "strike": strike, "expiry": t + call_tenor}
                stats["calls_sold"] += n_new
                events.append({"t": t, "kind": "sell_call",
                               "contracts": n_new, "strike": strike})

        equity.append(cash + collateral + shares * s)

    # A position open when the horizon ends has not resolved -- it is simply
    # still running past the edge of the chart. Counted separately so that
    # puts_sold and calls_sold stay exact sums of every lot's eventual bucket.
    if put_lot is not None:
        stats["puts_still_open"] = put_lot["contracts"]
    if call_lot is not None:
        stats["calls_still_open"] = call_lot["contracts"]

    return {"equity": equity, "events": events, "stats": stats}


def simulate_wheel_family(w0=100000.0, s0=100.0, mu=0.08, sigma_rv=0.20,
                          sigma_iv=0.24, r=0.03, q=0.0, years=5.0,
                          x_months=6.0, y_months=3.0, dip_pct=0.05,
                          sell_haircut=0.10, share_sl=0.20, call_tp=0.70,
                          stock_fee_pct=0.005, opt_fee=0.65,
                          seed=7, path=None, **_):
    """All four arms on one shared price path -- a paired comparison, so
    nearly all of the path's own randomness cancels out of the differences
    between arms even though three of the four have no distribution of their
    own to compare against.

    `path`, when given, is used verbatim instead of simulating one: the wheel
    scenario passes a real historical price series through here, in which case
    mu, sigma_rv and seed no longer describe the path at all.
    """
    if path is None:
        path = simulate_gbm_path(s0, mu, sigma_rv, q, years, seed)
    wheel = simulate_wheel(path, x_months, y_months, dip_pct, sell_haircut,
                          share_sl, call_tp, sigma_iv, r, q,
                          stock_fee_pct, opt_fee, w0, True)
    puts_only = simulate_wheel(path, x_months, y_months, dip_pct, sell_haircut,
                              share_sl, call_tp, sigma_iv, r, q,
                              stock_fee_pct, opt_fee, w0, False)
    dip = simulate_dip_strategy(path, x_months, dip_pct, stock_fee_pct, r, w0)
    hold_shares = (w0 / (1.0 + stock_fee_pct)) / path[0]
    hold = [hold_shares * s for s in path]
    return {"path": path, "wheel": wheel, "puts_only": puts_only,
            "dip": dip, "hold": hold}


def cagr(final, initial, years):
    """Annualized log return: ln(final/initial)/years. The metric every arm's
    equity curve is reduced to for the terminal-wealth comparison, since a
    fixed horizon otherwise favours whichever arm happened to be fully
    invested for more of it."""
    if final <= 0.0 or initial <= 0.0 or years <= 0.0:
        return -math.inf
    return math.log(final / initial) / years


def wheel_summary(w0=100000.0, s0=100.0, mu=0.08, sigma_rv=0.20, sigma_iv=0.24,
                  r=0.03, q=0.0, years=5.0, x_months=6.0, y_months=3.0,
                  dip_pct=0.05, sell_haircut=0.10, share_sl=0.20, call_tp=0.70,
                  stock_fee_pct=0.005, opt_fee=0.65, seed=7, path=None,
                  **_):
    """Everything the wheel scenario's tiles and table need: the exact
    single-contract anchors, buy-and-hold's exact distribution, and this one
    seed's simulated outcome for all four arms."""
    fam = simulate_wheel_family(w0, s0, mu, sigma_rv, sigma_iv, r, q, years,
                                x_months, y_months, dip_pct, sell_haircut,
                                share_sl, call_tp, stock_fee_pct,
                                opt_fee, seed, path)
    hold = hold_summary(w0, mu, sigma_rv, q, years)
    strike0 = s0 * (1.0 - dip_pct)
    put_prob_naive = real_world_itm_prob(strike0, strike0, x_months / 12.0,
                                         sigma_rv, mu, q, call=False)
    call_prob_naive = real_world_itm_prob(s0, s0, y_months / 12.0, sigma_rv,
                                          mu, q, call=True)
    wheel_stats = fam["wheel"]["stats"]
    assigned_rate = (wheel_stats["assignments"] /
                    max(1, wheel_stats["puts_sold"]))
    return {
        "wheel_final": fam["wheel"]["equity"][-1],
        "puts_only_final": fam["puts_only"]["equity"][-1],
        "dip_final": fam["dip"][-1],
        "hold_final_sample": fam["hold"][-1],
        "hold_final_exact": hold["expected_final"],
        "hold_median_exact": hold["median_final"],
        "wheel_cagr": cagr(fam["wheel"]["equity"][-1], w0, years),
        "puts_only_cagr": cagr(fam["puts_only"]["equity"][-1], w0, years),
        "dip_cagr": cagr(fam["dip"][-1], w0, years),
        "hold_cagr_sample": cagr(fam["hold"][-1], w0, years),
        "hold_cagr_exact": hold["growth_rate"],
        "put_naive_assign_prob": put_prob_naive,
        "call_naive_itm_prob": call_prob_naive,
        "sim_assign_rate": assigned_rate,
        "puts_sold": wheel_stats["puts_sold"],
        "puts_expired": wheel_stats["puts_expired"],
        "assignments": wheel_stats["assignments"],
        "calls_sold": wheel_stats["calls_sold"],
        "calls_tp": wheel_stats["calls_tp"],
        "calls_expired": wheel_stats["calls_expired"],
        "called_away": wheel_stats["called_away"],
        "calls_closed_on_stop": wheel_stats["calls_closed_on_stop"],
        "shares_stopped": wheel_stats["shares_stopped"],
    }


def wheel_iv_sweep(w0=100000.0, s0=100.0, mu=0.08, sigma_rv=0.20, r=0.03,
                   q=0.0, years=5.0, x_months=6.0, y_months=3.0, dip_pct=0.05,
                   sell_haircut=0.10, share_sl=0.20, call_tp=0.70,
                   stock_fee_pct=0.005, opt_fee=0.65, points=15, n_seeds=24,
                   spread_lo=-0.10, spread_hi=0.20, base_seed=1000,
                   path=None, **_):
    """Wheel CAGR against sigma_iv - sigma_rv, averaged over n_seeds paths per
    point. Explicitly a Monte Carlo sweep, not a closed form -- the entry
    timing, the rolling-high call trigger and the cash-driven cohort sizing
    are all path-dependent, so the "exact" sweep every other scenario has
    (Kelly's f*, the ruin curves, the insurance band) is not available here;
    this is the honest substitute, and the headline chart says so.

    With an explicit `path` there is only one history to average over, so
    n_seeds is ignored -- every seed would return the same number.
    """
    xs, gs = [], []
    for i in range(points):
        spread = spread_lo + (spread_hi - spread_lo) * i / max(1, points - 1)
        sigma_iv = max(0.01, sigma_rv + spread)
        seeds = 1 if path is not None else n_seeds
        total = 0.0
        for j in range(seeds):
            fam = simulate_wheel_family(w0, s0, mu, sigma_rv, sigma_iv, r, q,
                                        years, x_months, y_months, dip_pct,
                                        sell_haircut, share_sl, call_tp,
                                        stock_fee_pct, opt_fee,
                                        base_seed + i * seeds + j, path)
            total += cagr(fam["wheel"]["equity"][-1], w0, years)
        xs.append(spread)
        gs.append(total / seeds)
    return xs, gs


# =============================================================================
# 9. Parrondo's paradox -- two losing games, mixed into a winning one
# =============================================================================
# Capital moves by exactly one dollar each round (additive, like gambler's
# ruin), never absorbed. Game A is a coin with a flat, slightly unfavourable
# win probability. Game B's win probability depends on capital modulo 3: bad
# at residue 0, good otherwise. Both games lose on their own -- the point is
# what happens when the two are mixed.
#
# The chain of residues (capital mod 3) under any fixed mixing rule is a
# 3-state ergodic Markov chain, so its stationary distribution -- and the
# long-run drift it implies -- is a linear-algebra problem, not a simulation.


def pa_win_prob_a(eps=0.005):
    """Game A: a flat, slightly unfavourable coin. P(win) = 1/2 - eps."""
    return 0.5 - eps


def pa_win_prob_b(residue, eps=0.005, p_bad=0.1, p_good=0.75):
    """Game B: P(win) depends on capital mod 3 -- bad at residue 0, good
    otherwise. Both p_bad and p_good are shifted down by eps, same as game A,
    so neither game is handed an unfair edge relative to the other."""
    return (p_bad if residue % 3 == 0 else p_good) - eps


def pa_effective_win_prob(residue, q=0.5, eps=0.005, p_bad=0.1, p_good=0.75):
    """P(win this round), mixing game B in with probability q each round.

    q=0 is game A alone, q=1 is game B alone; independent per-round mixing
    (not a fixed alternating pattern) is what the classic demonstration uses.
    """
    return ((1.0 - q) * pa_win_prob_a(eps)
            + q * pa_win_prob_b(residue, eps, p_bad, p_good))


def pa_transition(q=0.5, eps=0.005, p_bad=0.1, p_good=0.75):
    """3x3 transition matrix over capital mod 3, for the mixed strategy.

    A win moves residue r -> r+1 (mod 3); a loss moves r -> r-1 (mod 3). Two
    step lengths (returning to the same residue in 2 rounds or in 3) share no
    common factor greater than 1, so the chain is aperiodic as well as
    irreducible -- a unique stationary distribution exists whenever every win
    probability is strictly interior to (0, 1).
    """
    P = np.zeros((3, 3))
    for r in range(3):
        p = pa_effective_win_prob(r, q, eps, p_bad, p_good)
        P[r, (r + 1) % 3] += p
        P[r, (r - 1) % 3] += 1.0 - p
    return P


def pa_stationary(q=0.5, eps=0.005, p_bad=0.1, p_good=0.75):
    """The stationary distribution over capital mod 3. Exact: solves
    pi P = pi, sum(pi) = 1 as a linear system -- a stationary distribution is
    the null space of (P^T - I) intersected with the simplex, which linear
    algebra finds directly rather than by iterating power steps or sampling.
    """
    P = pa_transition(q, eps, p_bad, p_good)
    A = np.vstack([P.T - np.eye(3), np.ones(3)])
    b = np.array([0.0, 0.0, 0.0, 1.0])
    pi, *_ = np.linalg.lstsq(A, b, rcond=None)
    return pi


def pa_drift(q=0.5, eps=0.005, p_bad=0.1, p_good=0.75):
    """E[capital change per round] under the mixed strategy. Exact.

    The stationary distribution weights how often each residue is visited;
    the drift is the stationary average of each residue's own (2p-1).
    """
    pi = pa_stationary(q, eps, p_bad, p_good)
    drift = 0.0
    for r in range(3):
        p = pa_effective_win_prob(r, q, eps, p_bad, p_good)
        drift += pi[r] * (2.0 * p - 1.0)
    return float(drift)


def pa_drift_curve(eps=0.005, p_bad=0.1, p_good=0.75, points=101):
    """(q values, drift) swept over the mixing probability. Exact -- every
    point is one stationary-distribution solve, not a simulated average."""
    qs = [i / (points - 1) for i in range(points)]
    drifts = [pa_drift(q, eps, p_bad, p_good) for q in qs]
    return qs, drifts


def pa_summary(q=0.5, eps=0.005, p_bad=0.1, p_good=0.75, **_):
    """Everything the Parrondo scenario's tiles and table need."""
    drift_a = pa_drift(0.0, eps, p_bad, p_good)
    drift_b = pa_drift(1.0, eps, p_bad, p_good)
    drift_mix = pa_drift(q, eps, p_bad, p_good)
    qs, drifts = pa_drift_curve(eps, p_bad, p_good, points=101)
    best_i = max(range(len(drifts)), key=lambda i: drifts[i])
    return {
        "drift_a": drift_a,
        "drift_b": drift_b,
        "drift_mix": drift_mix,
        "best_q": qs[best_i],
        "best_drift": drifts[best_i],
        "paradox": drift_a < 0.0 and drift_b < 0.0 and drifts[best_i] > 0.0,
    }


def simulate_parrondo(n_paths=6, rounds=2000, q=0.5, eps=0.005, p_bad=0.1,
                      p_good=0.75, w0=0, seed=7):
    """Reference walk: three series sharing draw order every round -- game A
    alone, game B alone, and the q-mixed strategy -- so the three stay aligned
    round for round however q is dialled.

    Draws five numbers a round regardless of which games actually consume
    them (one each for A, B, the mix's coin-choice, and the mix's two
    possible coins), the same unconditional-draw discipline simulate_monty
    uses -- a conditional draw would make the stream depend on the outcome,
    and the seeded paths could then only match js/engine.js by branching
    identically at every step.
    """
    rand = mulberry32(seed)
    paths_a, paths_b, paths_mix = [], [], []
    for _ in range(n_paths):
        xa = xb = xm = w0
        pa_path, pb_path, pm_path = [xa], [xb], [xm]
        for _ in range(rounds):
            ra, rb, rchoice, ra_mix, rb_mix = rand(), rand(), rand(), rand(), rand()
            xa += 1 if ra < pa_win_prob_a(eps) else -1
            xb += 1 if rb < pa_win_prob_b(xb, eps, p_bad, p_good) else -1
            if rchoice < q:
                xm += 1 if rb_mix < pa_win_prob_b(xm, eps, p_bad, p_good) else -1
            else:
                xm += 1 if ra_mix < pa_win_prob_a(eps) else -1
            pa_path.append(xa); pb_path.append(xb); pm_path.append(xm)
        paths_a.append(pa_path); paths_b.append(pb_path); paths_mix.append(pm_path)
    return paths_a, paths_b, paths_mix


# =============================================================================
# 10. Base rates -- Bayes' theorem, and the natural-frequency form that fixes it
# =============================================================================
# A test with sensitivity `sens` (P(positive | disease)) and specificity
# `spec` (P(negative | healthy)) is applied to a population with prevalence
# `prior`. Everything here is Bayes' theorem; the population-count numbers are
# the same theorem multiplied through by a headcount, which is the
# intervention this scenario exists to demonstrate.


def br_posterior_positive(prior=0.01, sens=0.95, spec=0.95, **_):
    """P(disease | positive test). Exact, by Bayes' theorem."""
    tp = sens * prior
    fp = (1.0 - spec) * (1.0 - prior)
    return tp / (tp + fp) if (tp + fp) > 0.0 else 0.0


def br_posterior_negative(prior=0.01, sens=0.95, spec=0.95, **_):
    """P(disease | negative test). Exact -- the reassuring number nobody asks
    for, which is worth showing next to the alarming one."""
    fn = (1.0 - sens) * prior
    tn = spec * (1.0 - prior)
    return fn / (fn + tn) if (fn + tn) > 0.0 else 0.0


def br_counts(prior=0.01, sens=0.95, spec=0.95, population=1000, **_):
    """(TP, FP, FN, TN) among `population` people. Exact -- Bayes' theorem
    multiplied through by a population size instead of left as a ratio, which
    is the natural-frequency form the 1978 Harvard study found people actually
    reason correctly with.
    """
    n = float(population)
    tp = n * prior * sens
    fn = n * prior * (1.0 - sens)
    fp = n * (1.0 - prior) * (1.0 - spec)
    tn = n * (1.0 - prior) * spec
    return tp, fp, fn, tn


def br_prevalence_curve(sens=0.95, spec=0.95, points=200, lo=1e-4, hi=0.5):
    """(prevalences, posterior P(disease|positive)) swept log-spaced from `lo`
    to `hi`. Exact -- every point is one evaluation of Bayes' theorem; the
    sweep exists only to show how much of the answer the prior is carrying.
    """
    log_lo, log_hi = math.log10(lo), math.log10(hi)
    xs = [10.0 ** (log_lo + (log_hi - log_lo) * i / (points - 1))
          for i in range(points)]
    ys = [br_posterior_positive(x, sens, spec) for x in xs]
    return xs, ys


def br_summary(prior=0.01, sens=0.95, spec=0.95, population=1000, **_):
    """Everything the base-rates scenario's tiles and table need."""
    tp, fp, fn, tn = br_counts(prior, sens, spec, population)
    return {
        "posterior_pos": br_posterior_positive(prior, sens, spec),
        "posterior_neg": br_posterior_negative(prior, sens, spec),
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "positives": tp + fp,
        "precision": tp / (tp + fp) if (tp + fp) > 0.0 else 0.0,
    }


# =============================================================================
# 11. The birthday problem -- collisions, pairs, and the security version
# =============================================================================
# P(no collision among n items drawn from d equally likely categories) is a
# product of n terms, computed in log space so it stays exact and finite even
# when d is a cryptographic digest space (d = 2^b for a b-bit hash) far too
# large to ever appear as an ordinary Python number.


def bd_log_no_collision(n=23, days=365.0):
    """ln P(no collision), exact via a sum of n log1p terms, vectorised: only
    the ratios i/days are ever computed, and every one of them stays near
    zero however astronomically large `days` is.
    """
    n = int(n)
    if n <= 0:
        return 0.0
    i = np.arange(n)
    return float(np.log1p(-i / days).sum())


def bd_collision_prob(n=23, days=365.0, **_):
    """P(at least one shared birthday among n people, `days` days a year).
    Exact. n > days forces a collision (the pigeonhole case), which the
    log-space product would otherwise hit log(0) trying to reach.
    """
    if n > days:
        return 1.0
    return 1.0 - math.exp(bd_log_no_collision(n, days))


def bd_pairs(n=23):
    """C(n, 2): how many pairs n people make. Exact, and the reason the curve
    above is not linear -- comparisons grow quadratically while people grow
    linearly."""
    return n * (n - 1) / 2.0


def bd_collision_curve(days=365.0, max_n=100):
    """(n, P(collision)) for every group size from 1 to max_n. Exact."""
    xs = list(range(1, int(max_n) + 1))
    return xs, [bd_collision_prob(n, days) for n in xs]


def bd_half_life_n(days=365.0):
    """Smallest n with P(collision) >= 0.5. Exact -- found by scanning up
    from n=1 rather than the sqrt(2 d ln 2) approximation, because the exact
    integer answer (23, for d=365) is the number the story is actually about.
    Only reachable at a `days` small enough for exact enumeration to be fast,
    which the page's control range respects; see bd_hash_n50_approx for the
    regime where it is not.
    """
    n = 1
    cap = int(days) + 1
    while bd_collision_prob(n, days) < 0.5:
        n += 1
        if n > cap:
            return n
    return n


def bd_hash_n50_approx(bits):
    """APPROXIMATION: n for 50% collision odds at a `bits`-bit digest.

    n(n-1) ~ 2 * days * ln(2) for n much smaller than days, because every term
    log1p(-i/days) in bd_log_no_collision is then close to -i/days, and the
    sum telescopes to -n(n-1)/(2*days); solving that quadratic for n gives the
    closed form below. Exact enumeration is infeasible here -- the answer
    itself is routinely in the billions once bits exceeds ~40 -- and the
    approximation gets *more* accurate as bits grows, the opposite of the
    usual scale/accuracy trade-off. Checked against exact enumeration at small
    bit counts in lab/verify.py.
    """
    days = 2.0 ** bits
    return math.sqrt(2.0 * days * math.log(2.0))


def bd_hash_bits_curve(min_bits=8, max_bits=64, points=57):
    """(bits, approximate n for 50% collision odds) over a digest length.
    See bd_hash_n50_approx -- this whole curve is the closed-form
    approximation, not exact enumeration."""
    bits_list = [min_bits + (max_bits - min_bits) * i / (points - 1)
                 for i in range(points)]
    return bits_list, [bd_hash_n50_approx(b) for b in bits_list]


def bd_summary(n=23, days=365.0, bits=8, **_):
    """Everything the birthday scenario's tiles and table need."""
    return {
        "collision_prob": bd_collision_prob(n, days),
        "pairs": bd_pairs(n),
        "half_life_n": bd_half_life_n(days),
        "hash_n50": bd_hash_n50_approx(bits),
    }


# =============================================================================
# 12. The secretary problem -- optimal stopping over a random permutation
# =============================================================================
# n candidates in a uniformly random order; reject the first s outright, then
# take the first one after that better than everyone seen so far. P(that
# candidate is the single best) has a well known closed form, sum-based
# rather than permutation-enumerated -- n! permutations would be infeasible
# past n ~ 12.


def sec_win_prob(s=0, n=100, **_):
    """P(the classic secretary strategy picks the single best candidate).
    Exact.

        s = 0:  1/n           (always take the first candidate)
        s > 0:  (s/n) * sum_{i=s+1}^{n} 1/(i-1)

    The best candidate sits at some position i with probability 1/n; the
    strategy wins exactly when i > s (it was not skipped) and the best of the
    first i-1 candidates fell within the skipped s -- probability s/(i-1),
    which is where the sum comes from.
    """
    s, n = int(s), int(n)
    if n <= 0:
        return 0.0
    if s <= 0:
        return 1.0 / n
    if s >= n:
        return 0.0
    return (s / n) * sum(1.0 / (i - 1) for i in range(s + 1, n + 1))


def sec_win_curve(n=100, **_):
    """(thresholds, win prob) for every skip count from 0 to n-1. Exact and
    vectorised: writing i = j+1, sec_win_prob(s) needs sum_{j=s}^{n-1} 1/j,
    and every one of those suffix sums comes out of a single reversed
    cumulative sum rather than n separate re-summations -- O(n) instead of
    O(n^2) for the whole curve, which is what keeps sec_asymptotic_curve
    responsive out to n in the hundreds.
    """
    n = int(n)
    if n <= 0:
        return [], []
    if n == 1:
        return [0], [1.0]
    j = np.arange(1, n)                        # j = 1 .. n-1
    suffix = np.cumsum((1.0 / j)[::-1])[::-1]   # suffix[k] = sum_{j=k+1}^{n-1} 1/j
    xs = list(range(n))
    ys = [1.0 / n] + [(s / n) * suffix[s - 1] for s in range(1, n)]
    return xs, ys


def sec_optimal(n=100, **_):
    """(best threshold, best win prob). Exact -- an argmax over the curve
    above, which is itself O(n) thanks to sec_win_curve's vectorisation."""
    xs, ys = sec_win_curve(n)
    best = max(range(len(ys)), key=lambda i: ys[i])
    return xs[best], ys[best]


def sec_asymptotic_curve(min_n=5, max_n=500, points=100):
    """(n, optimal win prob) over a range of n, showing convergence to 1/e.
    Exact at every point -- the 1/e limit is a fact ABOUT this curve, not an
    approximation used to draw it.
    """
    ns = sorted(set(int(round(min_n + (max_n - min_n) * i / max(1, points - 1)))
                    for i in range(points)))
    return ns, [sec_optimal(n)[1] for n in ns]


def sec_summary(s=37, n=100, **_):
    """Everything the secretary scenario's tiles and table need."""
    best_s, best_p = sec_optimal(n)
    return {
        "win_prob": sec_win_prob(s, n),
        "best_s": best_s,
        "best_prob": best_p,
        "best_fraction": best_s / n if n > 0 else 0.0,
        "inv_e": 1.0 / math.e,
    }


# =============================================================================
# 13. The two-envelope paradox -- a proper prior fixes what an improper one breaks
# =============================================================================
# The smaller amount S is drawn from Exponential(rate). The envelope you open
# holds X = S or X = 2S, each with probability 1/2. Given X = x, Bayes' rule
# over the two hypotheses ("x is the smaller half" vs "x is the larger half")
# gives an exact expected gain from swapping -- positive for small x, negative
# for large x, and exactly zero unconditionally (swapping always is a
# symmetric relabelling before you look at anything). The paradox's "the same
# argument applies at every x" claim is what breaks: the conditional argument
# is not the same argument at every x once a real prior is in the room.


def te_p_smaller(x, rate=0.01, **_):
    """P(x is the smaller half | observed x), under an Exponential(rate)
    prior on the smaller amount. Exact -- Bayes' rule between two hypotheses,
    weighted by their likelihoods as densities of the OBSERVED variable X:

        H_small (X = S):      likelihood f_S(x)              = rate e^{-rate x}
        H_large (X = 2S):     likelihood f_S(x/2) * |dS/dX|   = rate e^{-rate x/2} / 2

    The 1/2 is the Jacobian of S = X/2, and it is not optional: dropping it
    (i.e. treating "the density of 2S at x" as if it were just "the density of
    S at x/2") silently double-counts the larger-half hypothesis's mass and
    was caught only by a Monte Carlo check on this exact quantity -- the
    algebra downstream (te_swap_gain, te_crossover) looked internally
    consistent either way, because every one of its own identities (the sign
    flip, P(smaller) = 1/3 at the crossover) holds regardless of which
    constant sits here.
    """
    if x <= 0.0:
        return 1.0
    u = math.exp(rate * x / 2.0)
    return 1.0 / (1.0 + 0.5 * u)


def te_swap_gain(x, rate=0.01, **_):
    """E[gain from swapping | observed x]. Exact.

        swap to 2x with P(smaller|x): a gain of +x
        swap to x/2 with P(larger|x): a loss of -x/2

    Positive near x=0 (you are very likely holding the smaller half), crosses
    zero at x* = (4 ln 2)/rate (see te_crossover), and tends to -x/2 for large
    x (you are almost certainly holding the larger half already).
    """
    if x <= 0.0:
        return 0.0
    p_small = te_p_smaller(x, rate)
    return p_small * x - (1.0 - p_small) * (x / 2.0)


def te_crossover(rate=0.01, **_):
    """The amount x* above which swapping stops being worth it. Exact: solves
    te_swap_gain(x*) = 0, which reduces to p_smaller(x*) = 1/3 regardless of
    the prior (gain = p*x - (1-p)*(x/2) = 0 iff p = 1/3), then to
    exp(rate*x*/2) = 4 for the exponential prior's particular p_smaller.
    """
    return (4.0 * math.log(2.0)) / rate


def te_gain_curve(rate=0.01, points=200, hi=None):
    """(x values, expected swap gain, P(smaller|x)) swept over the amount
    found. Exact at every point. `hi` defaults to comfortably past the
    crossover so the sign change sits inside the axis."""
    top = hi if hi is not None else 6.0 / rate
    xs = [top * i / (points - 1) for i in range(points)]
    gains = [te_swap_gain(x, rate) for x in xs]
    probs = [te_p_smaller(x, rate) for x in xs]
    return xs, gains, probs


def te_summary(x=100.0, rate=0.01, **_):
    """Everything the two-envelope scenario's tiles and table need."""
    return {
        "p_smaller": te_p_smaller(x, rate),
        "swap_gain": te_swap_gain(x, rate),
        "crossover": te_crossover(rate),
        "mean_smaller": 1.0 / rate,
        "should_swap": te_swap_gain(x, rate) > 0.0,
    }


# =============================================================================
# 14. Optional stopping -- repeated significance testing as gambler's ruin
# =============================================================================
# A null-effect experiment accumulates data in `looks` batches of `batch`
# observations each, re-testing after every batch. Each observation is
# modelled as a fair +-1 step (driftless, since the null is true); after k
# batches the walk has taken k*batch steps, and a look is "significant" the
# moment the walk's value exceeds the two-sided z-threshold scaled to that
# many steps, |S| >= z_crit * sqrt(k*batch). The threshold moves outward like
# sqrt(n) while an undecided walk's typical spread also grows like sqrt(n) --
# neither wins outright, which is exactly why the false-positive rate climbs
# with every additional look instead of staying flat at the nominal alpha.
#
# Computed by forward DP over the distribution of "still not significant"
# paths: os_false_positive_curve tracks the live probability mass across
# batches, convolving in one fresh Binomial(batch, 1/2) increment per look --
# the same binomial-weight idea Shannon's demon and the insurance pool use,
# run forward across looks instead of summed once over a single horizon.


def os_z_threshold(alpha=0.05):
    """Two-sided z critical value for a nominal per-look significance level.
    Exact, via the normal quantile function."""
    return float(norm.ppf(1.0 - alpha / 2.0))


def os_false_positive_curve(looks=40, batch=20, alpha=0.05, **_):
    """(look number, cumulative P(declared significant by this look)). Exact
    forward DP, not simulated.

    `live` holds P(heads count = h AND never yet crossed the boundary) after
    each batch, indexed by h. Each step convolves the still-live distribution
    with a fresh Binomial(batch, 1/2) increment (an independent new batch of
    data), then whichever part of the result now sits outside the boundary
    |2h - n| >= z*sqrt(n) is peeled off into the cumulative total and zeroed
    out of `live` -- it does not get to un-happen on a later, calmer batch.
    """
    looks, batch = int(looks), int(batch)
    z = os_z_threshold(alpha)
    kernel = binom.pmf(np.arange(batch + 1), batch, 0.5)
    live = np.array([1.0])   # P(heads=0, not yet significant), n=0 so far
    cum_fp = 0.0
    xs, ys = [], []
    for look in range(1, looks + 1):
        live = np.convolve(live, kernel)
        n = look * batch
        h = np.arange(len(live))
        s = 2.0 * h - n
        boundary = z * math.sqrt(n)
        crossed = np.abs(s) >= boundary
        cum_fp += float(live[crossed].sum())
        live = np.where(crossed, 0.0, live)
        xs.append(look)
        ys.append(cum_fp)
    return xs, ys


def os_false_positive_rate(looks=40, batch=20, alpha=0.05, **_):
    """P(declared significant at least once in `looks` looks). Exact -- the
    last point of os_false_positive_curve."""
    _, ys = os_false_positive_curve(looks, batch, alpha)
    return ys[-1] if ys else 0.0


def os_bonferroni_alpha(looks=40, alpha=0.05, **_):
    """The per-look significance level that keeps the *cumulative* rate at
    the nominal alpha, to first order -- a Bonferroni correction. A
    conservative bound (the looks are not independent events, so the true
    required alpha is a little larger than this), simple and exact as such.
    """
    return alpha / max(1, int(looks))


def simulate_optional_stopping(n_paths=6, looks=40, batch=20, alpha=0.05,
                               seed=7):
    """Reference walk: each path is `looks * batch` fair +-1 steps, sampled at
    every look boundary so js/engine.js can reproduce it flip for flip.
    Returns (z-statistic at each look, per path; the look that first crossed
    the boundary, or None).
    """
    z = os_z_threshold(alpha)
    rand = mulberry32(seed)
    n = int(looks) * int(batch)
    all_z, first_sig = [], []
    for _ in range(n_paths):
        s = 0
        zs = []
        sig_at = None
        for step in range(1, n + 1):
            s += 1 if rand() < 0.5 else -1
            if step % batch == 0:
                look = step // batch
                zs.append(s / math.sqrt(step))
                if sig_at is None and abs(s) >= z * math.sqrt(step):
                    sig_at = look
        all_z.append(zs)
        first_sig.append(sig_at)
    return all_z, first_sig


def os_summary(looks=40, batch=20, alpha=0.05, **_):
    """Everything the optional-stopping scenario's tiles and table need."""
    xs, ys = os_false_positive_curve(looks, batch, alpha)
    return {
        "cum_fp": ys[-1] if ys else 0.0,
        "nominal_alpha": alpha,
        "bonferroni_alpha": os_bonferroni_alpha(looks, alpha),
        "total_n": int(looks) * int(batch),
        "z_crit": os_z_threshold(alpha),
    }


# =============================================================================
# 15. Simpson's paradox -- a trend in every subgroup, reversed in the pool
# =============================================================================
# Two treatments, A and B, applied across two subgroups of cases: "easy" (base
# success rate p_easy) and "hard" (base rate p_hard < p_easy). Treatment A is
# genuinely better by `delta` in BOTH subgroups:
#
#     rate_A(easy) = p_easy + delta      rate_B(easy) = p_easy
#     rate_A(hard) = p_hard + delta      rate_B(hard) = p_hard
#
# The only other dial is *who gets which treatment*: a fraction w_a of A's
# cases are easy ones, and w_b of B's. Pooling collapses each treatment's two
# subgroup rates into one weighted average, and those two averages use
# different weights, which is the whole mechanism:
#
#     pooled_A = w_a (p_easy + delta) + (1 - w_a)(p_hard + delta)
#              = p_hard + delta + w_a (p_easy - p_hard)
#     pooled_B = p_hard         + w_b (p_easy - p_hard)
#
#     pooled_A - pooled_B = delta - (w_b - w_a)(p_easy - p_hard)
#
# So the pooled comparison flips sign exactly when the true effect is smaller
# than the allocation gap times the difficulty gap:
#
#     delta_critical = (w_b - w_a) * (p_easy - p_hard)
#
# with reversal for 0 < delta < delta_critical (and, symmetrically, for
# delta_critical < delta < 0). Nothing here is approximate: the reversal
# condition is an identity in the four rate/weight parameters, and the counts
# below are the same identity multiplied through by group sizes.
#
# Note the caller's responsibility: the model does not clamp, so p_easy +
# delta must stay <= 1 (and p_hard + delta >= 0) for the rates to be
# probabilities. Clamping would break the identity above rather than fix it.


def simpsons_subgroup_rates(p_easy=0.9, p_hard=0.4, delta=0.05, **_):
    """(A-easy, A-hard, B-easy, B-hard) success rates. Exact by construction:
    A carries the same true advantage `delta` in both subgroups, so A is
    better in every subgroup whenever delta > 0."""
    return p_easy + delta, p_hard + delta, p_easy, p_hard


def simpsons_pooled_rates(p_easy=0.9, p_hard=0.4, delta=0.05, w_a=0.2, w_b=0.8,
                          **_):
    """(pooled A, pooled B) success rates. Exact -- each is the subgroup rates
    averaged with that treatment's own case mix, which is the step that loses
    the information the subgroup view keeps."""
    a_easy, a_hard, b_easy, b_hard = simpsons_subgroup_rates(p_easy, p_hard, delta)
    return (w_a * a_easy + (1.0 - w_a) * a_hard,
            w_b * b_easy + (1.0 - w_b) * b_hard)


def simpsons_delta_critical(p_easy=0.9, p_hard=0.4, w_a=0.2, w_b=0.8, **_):
    """The true effect size at which the pooled comparison flips. Exact:

        delta_critical = (w_b - w_a) * (p_easy - p_hard)

    the allocation gap times the difficulty gap. Independent of delta itself
    -- it is the whole confounding budget available to the case mix, and any
    true effect smaller than it gets swamped."""
    return (w_b - w_a) * (p_easy - p_hard)


def simpsons_pooled_diff(p_easy=0.9, p_hard=0.4, delta=0.05, w_a=0.2, w_b=0.8,
                         **_):
    """pooled_A - pooled_B. Exact, and algebraically equal to
    delta - delta_critical -- the derivation's punchline in one line."""
    pooled_a, pooled_b = simpsons_pooled_rates(p_easy, p_hard, delta, w_a, w_b)
    return pooled_a - pooled_b


def simpsons_reverses(p_easy=0.9, p_hard=0.4, delta=0.05, w_a=0.2, w_b=0.8,
                      **_):
    """True when the subgroup verdict and the pooled verdict disagree. Exact:
    the subgroup verdict has the sign of `delta` (A wins both subgroups iff
    delta > 0) and the pooled verdict has the sign of delta - delta_critical,
    so a reversal is exactly a sign disagreement between the two."""
    diff = simpsons_pooled_diff(p_easy, p_hard, delta, w_a, w_b)
    return (delta > 0.0 and diff < 0.0) or (delta < 0.0 and diff > 0.0)


def _round_half_up(x):
    """floor(x + 0.5), not round(x): Python's round() is banker's rounding and
    JavaScript's Math.round is not, and a 2x2 table of counts lands on exact
    .5 ties for perfectly ordinary inputs (a 50-case group split 50/50). Same
    treatment `bets()` already needs for the same reason."""
    return int(math.floor(x + 0.5))


def simpsons_counts(p_easy=0.9, p_hard=0.4, delta=0.05, w_a=0.2, w_b=0.8,
                    n_a=200, n_b=200, **_):
    """The 2x2x2 table of whole-case counts behind the rates.

    Returns a dict with, for each treatment, the easy/hard case counts, the
    successes in each, and the totals.

    Every total here is a SUM of its own parts, never an independent rounding
    of the corresponding product: `hard_a` is `n_a - easy_a` rather than
    round((1-w_a)*n_a), and `succ_a` is `succ_easy_a + succ_hard_a` rather
    than round(pooled_a * n_a). Rounding each cell on its own is what makes a
    displayed table whose parts sum to one more than its whole -- the four
    cells and the two margins here are consistent by construction, at the
    cost of the count-derived rates differing from the exact rates by up to
    half a case.
    """
    a_easy, a_hard, b_easy, b_hard = simpsons_subgroup_rates(p_easy, p_hard, delta)
    n_a, n_b = int(n_a), int(n_b)

    easy_a = min(n_a, max(0, _round_half_up(w_a * n_a)))
    hard_a = n_a - easy_a
    easy_b = min(n_b, max(0, _round_half_up(w_b * n_b)))
    hard_b = n_b - easy_b

    se_a = min(easy_a, max(0, _round_half_up(a_easy * easy_a)))
    sh_a = min(hard_a, max(0, _round_half_up(a_hard * hard_a)))
    se_b = min(easy_b, max(0, _round_half_up(b_easy * easy_b)))
    sh_b = min(hard_b, max(0, _round_half_up(b_hard * hard_b)))

    return {
        "easy_a": easy_a, "hard_a": hard_a, "n_a": n_a,
        "easy_b": easy_b, "hard_b": hard_b, "n_b": n_b,
        "succ_easy_a": se_a, "succ_hard_a": sh_a, "succ_a": se_a + sh_a,
        "succ_easy_b": se_b, "succ_hard_b": sh_b, "succ_b": se_b + sh_b,
        "rate_easy_a": se_a / easy_a if easy_a else 0.0,
        "rate_hard_a": sh_a / hard_a if hard_a else 0.0,
        "rate_easy_b": se_b / easy_b if easy_b else 0.0,
        "rate_hard_b": sh_b / hard_b if hard_b else 0.0,
        "rate_a": (se_a + sh_a) / n_a if n_a else 0.0,
        "rate_b": (se_b + sh_b) / n_b if n_b else 0.0,
    }


def simpsons_delta_curve(p_easy=0.9, p_hard=0.4, w_a=0.2, w_b=0.8, points=101,
                         lo=0.0, hi=None, **_):
    """(delta values, pooled_A - pooled_B) swept over the true effect size.
    Exact at every point -- a straight line of slope 1 crossing zero at
    delta_critical, which is the cleanest possible statement of the
    condition. `hi` defaults to twice the critical value so the crossing sits
    in the middle of the axis."""
    crit = simpsons_delta_critical(p_easy, p_hard, w_a, w_b)
    top = hi if hi is not None else max(2.0 * crit, 0.1)
    xs = [lo + (top - lo) * i / (points - 1) for i in range(points)]
    ys = [simpsons_pooled_diff(p_easy, p_hard, d, w_a, w_b) for d in xs]
    return xs, ys


def simpsons_summary(p_easy=0.9, p_hard=0.4, delta=0.05, w_a=0.2, w_b=0.8,
                     n_a=200, n_b=200, **_):
    """Everything the Simpson's-paradox scenario's tiles and table need."""
    a_easy, a_hard, b_easy, b_hard = simpsons_subgroup_rates(p_easy, p_hard, delta)
    pooled_a, pooled_b = simpsons_pooled_rates(p_easy, p_hard, delta, w_a, w_b)
    crit = simpsons_delta_critical(p_easy, p_hard, w_a, w_b)
    counts = simpsons_counts(p_easy, p_hard, delta, w_a, w_b, n_a, n_b)
    return {
        "rate_easy_a": a_easy, "rate_hard_a": a_hard,
        "rate_easy_b": b_easy, "rate_hard_b": b_hard,
        "pooled_a": pooled_a, "pooled_b": pooled_b,
        "subgroup_diff": delta,
        "pooled_diff": pooled_a - pooled_b,
        "delta_critical": crit,
        "reverses": simpsons_reverses(p_easy, p_hard, delta, w_a, w_b),
        "allocation_gap": w_b - w_a,
        "difficulty_gap": p_easy - p_hard,
        "counts": counts,
    }


# =============================================================================
# 16. Bertrand's paradox -- three "random" chords, three different answers
# =============================================================================
# "Draw a random chord of a circle of radius R; what is P(length > L)?" The
# question has no answer until "random" is pinned to a sampling rule, and the
# three classical rules give three different ones. Everything is written in
# terms of the threshold ratio
#
#     c = L / (2R)  in (0, 1)
#
# (the target length as a fraction of the diameter) and the midpoint's scaled
# distance from the centre, u = d / R. A chord at distance d has length
# 2*sqrt(R^2 - d^2), so
#
#     length > L  <=>  R^2 - d^2 > R^2 c^2  <=>  u < sqrt(1 - c^2)
#
# and every method's answer is just its own CDF of u evaluated at that
# threshold. The three rules induce three different distributions on u:
#
# 1. Random endpoints. Fix one endpoint by rotational symmetry and let the
#    other be uniform on the circumference; with theta the central angle the
#    chord is 2R sin(theta/2), so its midpoint sits at u = |cos(theta/2)| with
#    theta/2 uniform on [0, pi). Hence F(t) = (2/pi) arcsin t, and
#        P = F(sqrt(1-c^2)) = (2/pi) arcsin(sqrt(1-c^2)) = 1 - (2/pi) arcsin c.
#
# 2. Random radius. Pick a radius uniformly, then the midpoint uniformly along
#    it: u ~ Uniform(0,1), F(t) = t, and P = sqrt(1 - c^2).
#
# 3. Random midpoint. The midpoint is uniform over the disc, so P(u <= t) is
#    the area ratio t^2: F(t) = t^2, and P = 1 - c^2.
#
# At c = sqrt(3)/2 -- the side of the inscribed equilateral triangle -- these
# are exactly 1/3, 1/2 and 1/4, which is the classical statement of the
# paradox and the identity lab/verify.py asserts.
#
# The mean chord lengths are exact too, and disagree in the same way:
# 4R/pi, pi*R/2 and 4R/3.
#
# One thing that is easy to assume and is false: the three answers do NOT
# keep a fixed order. The random-radius rule is the largest throughout (0,1),
# but the midpoint and endpoints rules cross at exactly c = 1/sqrt(2) (where
# both equal 1/2) -- 1 - c^2 wins below it, 1 - (2/pi) arcsin c wins above.
# The classical c = sqrt(3)/2 sits above the crossing, which is why the
# textbook triple reads 1/3, 1/2, 1/4 rather than the other way round. An
# earlier version of lab/verify.py asserted a universal ordering and was
# right only for c > 1/sqrt(2).

BERTRAND_METHODS = ("endpoints", "radius", "midpoint")


def bertrand_threshold(c=0.8660254037844386, **_):
    """sqrt(1 - c^2): the largest scaled midpoint distance u = d/R at which a
    chord still clears the target length. Exact."""
    c = min(max(c, 0.0), 1.0)
    return math.sqrt(max(0.0, 1.0 - c * c))


def bertrand_chord_length(u, radius=1.0):
    """The length of a chord whose midpoint sits at scaled distance u = d/R.
    Exact: 2R sqrt(1 - u^2)."""
    return 2.0 * radius * math.sqrt(max(0.0, 1.0 - u * u))


def bertrand_cdf_endpoints(t):
    """P(u <= t) under the random-endpoints rule. Exact: (2/pi) arcsin t,
    from u = |cos(theta/2)| with theta/2 uniform on [0, pi)."""
    t = min(max(t, 0.0), 1.0)
    return (2.0 / math.pi) * math.asin(t)


def bertrand_cdf_radius(t):
    """P(u <= t) under the random-radius rule. Exact: t, because the midpoint
    is uniform along the radius."""
    return min(max(t, 0.0), 1.0)


def bertrand_cdf_midpoint(t):
    """P(u <= t) under the random-midpoint rule. Exact: t^2, the area ratio of
    two concentric discs."""
    t = min(max(t, 0.0), 1.0)
    return t * t


def bertrand_midpoint_cdf(method, t):
    """P(u <= t) under `method`. Exact; dispatches to the three above."""
    if method == "endpoints":
        return bertrand_cdf_endpoints(t)
    if method == "radius":
        return bertrand_cdf_radius(t)
    if method == "midpoint":
        return bertrand_cdf_midpoint(t)
    raise ValueError(f"unknown method: {method}")


def bertrand_prob_endpoints(c=0.8660254037844386, **_):
    """P(chord longer than 2Rc), both endpoints uniform on the circumference.
    Exact: 1 - (2/pi) arcsin c. Equals 1/3 at c = sqrt(3)/2."""
    c = min(max(c, 0.0), 1.0)
    return 1.0 - (2.0 / math.pi) * math.asin(c)


def bertrand_prob_radius(c=0.8660254037844386, **_):
    """P(chord longer than 2Rc), midpoint uniform along a uniform radius.
    Exact: sqrt(1 - c^2). Equals 1/2 at c = sqrt(3)/2."""
    c = min(max(c, 0.0), 1.0)
    return math.sqrt(max(0.0, 1.0 - c * c))


def bertrand_prob_midpoint(c=0.8660254037844386, **_):
    """P(chord longer than 2Rc), midpoint uniform over the disc. Exact:
    1 - c^2. Equals 1/4 at c = sqrt(3)/2."""
    c = min(max(c, 0.0), 1.0)
    return 1.0 - c * c


def bertrand_prob(method, c=0.8660254037844386):
    """P(chord longer than 2Rc) under `method`. Exact. Identically equal to
    1 - F_method(threshold complement); written directly here, and checked
    against `bertrand_midpoint_cdf(method, bertrand_threshold(c))` in
    lab/verify.py so the two statements cannot drift apart."""
    if method == "endpoints":
        return bertrand_prob_endpoints(c)
    if method == "radius":
        return bertrand_prob_radius(c)
    if method == "midpoint":
        return bertrand_prob_midpoint(c)
    raise ValueError(f"unknown method: {method}")


def bertrand_mean_length(method, radius=1.0):
    """E[chord length] under `method`. Exact, by integrating 2R sqrt(1-u^2)
    against each rule's density of u:

        endpoints  u = |cos(phi)|, phi ~ U[0,pi):  (2R/pi) * int_0^pi sin = 4R/pi
        radius     u ~ U(0,1):                     2R * int_0^1 sqrt(1-u^2) = pi R / 2
        midpoint   density 2u on (0,1):            2R * 2/3               = 4R / 3

    So the three rules disagree about the average chord as well as about the
    tail: 1.273R, 1.571R, 1.333R.
    """
    if method == "endpoints":
        return 4.0 * radius / math.pi
    if method == "radius":
        return math.pi * radius / 2.0
    if method == "midpoint":
        return 4.0 * radius / 3.0
    raise ValueError(f"unknown method: {method}")


def bertrand_cdf_curve(points=101, **_):
    """(t values, endpoints CDF, radius CDF, midpoint CDF) over u in [0,1].
    Exact -- the three midpoint-distance distributions on one axis, which is
    the picture that explains why the answers differ."""
    ts = [i / (points - 1) for i in range(points)]
    return (ts,
            [bertrand_cdf_endpoints(t) for t in ts],
            [bertrand_cdf_radius(t) for t in ts],
            [bertrand_cdf_midpoint(t) for t in ts])


def bertrand_c_curve(points=101, **_):
    """(c values, P_endpoints, P_radius, P_midpoint) swept over the threshold
    ratio. Exact at every point.

    The random-radius rule is the largest answer everywhere in (0,1), but the
    other two genuinely cross: 1 - c^2 beats 1 - (2/pi) arcsin c for small c
    and loses for large c, swapping where c^2 = (2/pi) arcsin c -- which is
    exactly c = 1/sqrt(2), where both equal 1/2. So there is no fixed
    ranking of the three rules, and the
    classical c = sqrt(3)/2 sits above that crossing -- which is why the
    textbook statement reads 1/3 > 1/4 rather than the other way round.
    lab/verify.py asserts both halves of this."""
    cs = [i / (points - 1) for i in range(points)]
    return (cs,
            [bertrand_prob_endpoints(c) for c in cs],
            [bertrand_prob_radius(c) for c in cs],
            [bertrand_prob_midpoint(c) for c in cs])


def bertrand_sample(method, n=200, radius=1.0, c=0.8660254037844386, seed=7):
    """Seeded chords under one sampling rule, using the shared mulberry32
    stream so js/engine.js reproduces them draw for draw.

    Exactly TWO uniforms are consumed per chord in every method, in this
    order, which is the part of the PRNG contract that matters here:

        endpoints  u1 -> first endpoint's angle,  u2 -> second endpoint's angle
        radius     u1 -> the radius's direction,  u2 -> distance along it
        midpoint   u1 -> squared radial position, u2 -> the midpoint's angle

    (`midpoint` takes sqrt(u1) for the radius: the disc-uniform inverse CDF.
    Drawing the distance uniformly instead is precisely the `radius` rule,
    which is the paradox in one line of code.)

    Returns a list of dicts: chord endpoints (x1,y1)-(x2,y2), the midpoint
    (mx,my), its scaled distance u = d/R, the chord length, and whether it
    clears the threshold.
    """
    rand = mulberry32(seed)
    thresh = bertrand_threshold(c)
    out = []
    for _ in range(int(n)):
        u1, u2 = rand(), rand()
        if method == "endpoints":
            a1 = 2.0 * math.pi * u1
            a2 = 2.0 * math.pi * u2
            x1, y1 = radius * math.cos(a1), radius * math.sin(a1)
            x2, y2 = radius * math.cos(a2), radius * math.sin(a2)
            mx, my = 0.5 * (x1 + x2), 0.5 * (y1 + y2)
            u = math.hypot(mx, my) / radius
        else:
            if method == "radius":
                phi = 2.0 * math.pi * u1
                u = u2
            elif method == "midpoint":
                u = math.sqrt(u1)
                phi = 2.0 * math.pi * u2
            else:
                raise ValueError(f"unknown method: {method}")
            mx, my = radius * u * math.cos(phi), radius * u * math.sin(phi)
            # The chord through this midpoint is perpendicular to the radius.
            half = radius * math.sqrt(max(0.0, 1.0 - u * u))
            dx, dy = -math.sin(phi), math.cos(phi)
            x1, y1 = mx + half * dx, my + half * dy
            x2, y2 = mx - half * dx, my - half * dy
        out.append({
            "x1": x1, "y1": y1, "x2": x2, "y2": y2,
            "mx": mx, "my": my, "u": u,
            "length": bertrand_chord_length(u, radius),
            "long": u < thresh,
        })
    return out


def bertrand_sample_all(n=200, radius=1.0, c=0.8660254037844386, seed=7, **_):
    """One seeded sample per method, each from its own fresh mulberry32
    stream at `seed`. Deliberately not one shared stream: the three clouds
    are meant to be compared as three independent draws of the same size, and
    restarting the stream keeps each method's chords unchanged when another
    method's sample size changes."""
    return {m: bertrand_sample(m, n, radius, c, seed) for m in BERTRAND_METHODS}


def bertrand_empirical(method, n=200, radius=1.0, c=0.8660254037844386, seed=7):
    """The seeded sample's own fraction of long chords. Simulated, not exact
    -- this is the number a page can print beside the closed form to show the
    sample agreeing with it."""
    chords = bertrand_sample(method, n, radius, c, seed)
    return sum(1 for ch in chords if ch["long"]) / len(chords) if chords else 0.0


def bertrand_summary(c=0.8660254037844386, radius=1.0, n=200, seed=7, **_):
    """Everything the Bertrand scenario's tiles and table need. Every `p_*`
    and `mean_len_*` is closed form; the `emp_*` values are the seeded
    sample's own fractions, for a page that wants to show the cloud agreeing
    with the formula."""
    p_e = bertrand_prob_endpoints(c)
    p_r = bertrand_prob_radius(c)
    p_m = bertrand_prob_midpoint(c)
    return {
        "c": c,
        "length": 2.0 * radius * c,
        "threshold": bertrand_threshold(c),
        "p_endpoints": p_e, "p_radius": p_r, "p_midpoint": p_m,
        "spread": max(p_e, p_r, p_m) - min(p_e, p_r, p_m),
        "mean_len_endpoints": bertrand_mean_length("endpoints", radius),
        "mean_len_radius": bertrand_mean_length("radius", radius),
        "mean_len_midpoint": bertrand_mean_length("midpoint", radius),
        "emp_endpoints": bertrand_empirical("endpoints", n, radius, c, seed),
        "emp_radius": bertrand_empirical("radius", n, radius, c, seed),
        "emp_midpoint": bertrand_empirical("midpoint", n, radius, c, seed),
        "classic_c": math.sqrt(3.0) / 2.0,
        "is_classic": abs(c - math.sqrt(3.0) / 2.0) < 1e-12,
    }


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

    r = ruin_summary(bankroll=100.0, target=200.0, p=0.49, bet=5.0)
    print(f"\ngambler's ruin  $100 -> $200, $5 bets, p=0.49  ({r['k']}/{r['n']} bets)")
    print(f"  P(ruin)           {r['ruin_prob']*100:.2f} %"
          f"   (fair coin: {r['fair_ruin_prob']*100:.2f} %)")
    print(f"  E[rounds]         {r['duration']:.1f}")
    print(f"  P(ruin), no target{r['ruin_unbounded']*100:8.2f} %")
    bold = ruin_prob(100.0, 200.0, 0.49, 50.0)
    print(f"  same game, $50 bets: P(ruin) {bold*100:.2f} %  <- bolder is safer")

    sp = sp_summary(p=0.5, m=2.0, tiers=31, plays=20000)
    print("\nSt Petersburg  p=0.5, m=2.0")
    print(f"  E[payout]         {sp['expected']}")
    print(f"  median payout     ${sp['median']:,.2f}")
    print(f"  capped at ${sp['cap_amount']:,.0f}: ${sp['capped']:,.2f}")
    print(f"  typical mean over 20k plays ~ ${sp['typical_mean']:,.2f}")

    pd = pd_summary(rounds=50, t=5.0, noise=0.0, generations=60)
    print("\niterated prisoner's dilemma  50 rounds, T=5, no noise")
    for name, sc in zip(STRATEGIES, pd["scores"]):
        print(f"  {STRATEGY_LABELS[name]:<18} {sc:.3f} per round")
    print(f"  tournament winner: {STRATEGY_LABELS[pd['winner']]}")
    print(f"  after 60 generations: {STRATEGY_LABELS[pd['dominant']]} at "
          f"{pd['dominant_share']*100:.1f} %")

    mh = mh_summary(doors=3, opened=1, know=1.0)
    print("\nMonty Hall  3 doors, 1 opened, knowing host")
    print(f"  P(switch wins)    {mh['switch_prob']*100:.2f} %")
    print(f"  P(stay wins)      {mh['stay_prob']*100:.2f} %")
    mh_random = mh_summary(doors=3, opened=1, know=0.0)
    print(f"  random host: P(switch wins) {mh_random['switch_prob']*100:.2f} % "
          f"(no better than staying)")

    sd = sd_summary(rounds=200, p=0.5, vol=0.3, w=0.5, interval=1, cost=0.0)
    print("\nShannon's demon  200 periods, up/down = "
          f"{sd['up']:.3f}/{sd['down']:.3f}, rebalanced every period")
    print(f"  stock time-avg growth   {sd['stock_growth']*100:+.4f} %/period")
    print(f"  rebalanced growth       {sd['rebal_growth']*100:+.4f} %/period")
    print(f"  buy-and-hold growth     {sd['hold_growth']*100:+.4f} %/period")
    print(f"  harvest                 {sd['harvest']*100:+.4f} %/period")
    print(f"  best interval           every {sd['best_interval']} period(s)")

    ins = ins_summary(wealth=100000.0, seller_wealth=1000000.0, premium=2000.0,
                      loss=30000.0, hazard=0.05, members=50)
    print("\nInsurance  $100k buyer, $1M seller, 5% chance of a $30k loss")
    print(f"  expected payout         ${ins['expected_payout']:,.2f}")
    print(f"  buyer's max premium     ${ins['buyer_max']:,.2f}")
    print(f"  seller's min premium    ${ins['seller_min']:,.2f}")
    print(f"  band is real:           {ins['band_ok']}  "
          f"(width ${ins['band_width']:,.2f})")
    print(f"  at $2,000: buyer growth {ins['insured_growth']*100:+.4f} %/period "
          f"vs uninsured {ins['uninsured_growth']*100:+.4f} %/period")
    print(f"  pool of 50 growth       {ins['pool_growth']*100:+.4f} %/period")
    print(f"  infinite pool growth    {ins['pool_limit']*100:+.4f} %/period")

    pa = pa_summary(q=0.5, eps=0.005)
    print("\nParrondo's paradox  eps=0.005, random 50/50 mix")
    print(f"  game A alone drift      {pa['drift_a']*100:+.4f} $/round")
    print(f"  game B alone drift      {pa['drift_b']*100:+.4f} $/round")
    print(f"  50/50 mix drift         {pa['drift_mix']*100:+.4f} $/round")
    print(f"  best mix                q={pa['best_q']:.2f} -> "
          f"{pa['best_drift']*100:+.4f} $/round")
    print(f"  paradox confirmed:      {pa['paradox']}")

    br = br_summary(prior=0.01, sens=0.95, spec=0.95, population=1000)
    print("\nBase rates  95% test, 1% prevalence, 1000 people")
    print(f"  P(disease | positive)   {br['posterior_pos']*100:.2f} %")
    print(f"  P(disease | negative)   {br['posterior_neg']*100:.4f} %")
    print(f"  TP={br['tp']:.1f}  FP={br['fp']:.1f}  FN={br['fn']:.1f}  TN={br['tn']:.1f}")

    bd = bd_summary(n=23, days=365.0, bits=8)
    print("\nBirthday problem  23 people, 365 days")
    print(f"  P(collision)            {bd['collision_prob']*100:.2f} %")
    print(f"  pairs                   {bd['pairs']:.0f}")
    print(f"  50% odds at n =         {bd['half_life_n']}")
    print(f"  8-bit hash, n for 50%   {bd['hash_n50']:.2f} (approx)")

    sec = sec_summary(s=37, n=100)
    print("\nSecretary problem  100 candidates")
    print(f"  skip 37: P(win)         {sec['win_prob']*100:.2f} %")
    print(f"  optimal skip            {sec['best_s']} "
          f"({sec['best_fraction']*100:.1f} % of n)")
    print(f"  optimal P(win)          {sec['best_prob']*100:.2f} %  "
          f"(1/e = {sec['inv_e']*100:.2f} %)")

    te = te_summary(x=100.0, rate=0.01)
    print("\nTwo-envelope paradox  exponential prior, mean $100")
    print(f"  P(x=$100 is the smaller half)  {te['p_smaller']*100:.2f} %")
    print(f"  E[gain from swapping]          ${te['swap_gain']:.2f}")
    print(f"  crossover amount                ${te['crossover']:.2f}")

    os_ = os_summary(looks=40, batch=20, alpha=0.05)
    print("\nOptional stopping  40 looks, batches of 20, nominal alpha=5%")
    print(f"  cumulative false-positive rate  {os_['cum_fp']*100:.2f} %")
    print(f"  Bonferroni-corrected alpha      {os_['bonferroni_alpha']*100:.4f} %")
    print(f"  total sample size               {os_['total_n']}")

    sp2 = simpsons_summary()
    c2 = sp2["counts"]
    print("\nSimpson's paradox  easy 90%, hard 40%, A better by 5pp")
    print(f"  easy cases:  A {sp2['rate_easy_a']*100:.1f} %  vs B {sp2['rate_easy_b']*100:.1f} %")
    print(f"  hard cases:  A {sp2['rate_hard_a']*100:.1f} %  vs B {sp2['rate_hard_b']*100:.1f} %")
    print(f"  pooled:      A {sp2['pooled_a']*100:.1f} %  vs B {sp2['pooled_b']*100:.1f} %")
    print(f"  delta_critical {sp2['delta_critical']*100:.1f} pp -> reverses: {sp2['reverses']}")
    print(f"  counts  A {c2['succ_a']}/{c2['n_a']}  = {c2['succ_easy_a']}/{c2['easy_a']}"
          f" + {c2['succ_hard_a']}/{c2['hard_a']}")
    print(f"  counts  B {c2['succ_b']}/{c2['n_b']}  = {c2['succ_easy_b']}/{c2['easy_b']}"
          f" + {c2['succ_hard_b']}/{c2['hard_b']}")

    bt = bertrand_summary()
    print("\nBertrand's paradox  c = sqrt(3)/2 (the inscribed triangle's side)")
    print(f"  random endpoints  {bt['p_endpoints']*100:.2f} %  (sample "
          f"{bt['emp_endpoints']*100:.1f} %)")
    print(f"  random radius     {bt['p_radius']*100:.2f} %  (sample "
          f"{bt['emp_radius']*100:.1f} %)")
    print(f"  random midpoint   {bt['p_midpoint']*100:.2f} %  (sample "
          f"{bt['emp_midpoint']*100:.1f} %)")
    print(f"  spread            {bt['spread']*100:.2f} pp for one question")
