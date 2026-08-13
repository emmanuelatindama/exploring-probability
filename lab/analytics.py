"""Closed-form analytics for the site's probability games.

This module is the source of truth. The browser engine (js/engine.js) must
reproduce these numbers; lab/verify.py asserts that it does.

Seven games live here, in this order:

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

Sections 6 and 7 are sums over a binomial distribution, so they are written
against numpy arrays rather than Python loops: one `binom.pmf` call over a
vector of outcomes instead of a term-at-a-time accumulation. The JS mirror
cannot do that, and gets a weight recurrence instead -- see js/engine.js.
"""

import math

import numpy as np
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


def ruin_summary(bankroll=100.0, target=200.0, p=0.49, bet=5.0, **_):
    """Everything the ruin scenario's tiles and table need."""
    k, n = ruin_units(bankroll, target, bet)
    return {
        "k": k,
        "n": n,
        "ruin_prob": ruin_prob(bankroll, target, p, bet),
        "reach_prob": reach_target_prob(bankroll, target, p, bet),
        "duration": ruin_duration(bankroll, target, p, bet),
        "ruin_unbounded": ruin_prob_unbounded(bankroll, p, bet),
        "fair_ruin_prob": ruin_prob(bankroll, target, 0.5, bet),
        "edge": 2.0 * p - 1.0,
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
    return {
        "expected": sp_expected(p, m),
        "median": sp_median(p, m),
        "q95": sp_quantile(0.95, p, m),
        "capped": sp_capped_expected(p, m, tiers),
        "cap_amount": sp_cap_amount(m, tiers),
        "typical_mean": sp_typical_mean(plays, p, m),
        "divergent": m * p >= 1.0,
        "mp": m * p,
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

    Tends to the accounting profit P - pi*L from above as the seller's wealth
    grows, so a very large insurer is exactly the expected-value maximiser that
    textbook insurance assumes.
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
