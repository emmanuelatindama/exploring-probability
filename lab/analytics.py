"""Closed-form analytics for the site's probability games.

This module is the source of truth. The browser engine (js/engine.js) must
reproduce these numbers; lab/verify.py asserts that it does.

Four games live here, in this order:

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
