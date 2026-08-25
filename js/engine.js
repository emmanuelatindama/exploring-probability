/* Simulation engine + closed-form analytics.
 *
 * Mirrors lab/analytics.py exactly -- same PRNG, same formulas. lab/verify.py
 * asserts the two agree; if you change a formula here, change it there.
 *
 * Deliberately a classic script (not an ES module) attaching to a single global
 * namespace: `type="module"` is blocked by CORS on file:// URLs, so modules
 * would break local preview-by-double-click. Classic scripts work both from
 * file:// and from GitHub Pages.
 */
window.EP = window.EP || {};

(function (EP) {
  "use strict";

  // -- seeded PRNG (mulberry32) ---------------------------------------------
  // Same algorithm as lab/analytics.py:mulberry32, so a given (seed, params)
  // yields identical paths in Python and in the browser.
  function mulberry32(seed) {
    let a = seed | 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // -- log-gamma / binomial (for the exact quantiles and tail probabilities) --
  const LANCZOS = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];

  function logGamma(z) {
    if (z < 0.5) {
      return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
    }
    z -= 1;
    let x = 0.99999999999980993;
    for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (z + i + 1);
    const t = z + LANCZOS.length - 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }

  const logChoose = (n, k) =>
    logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);

  /** P(X = k) for X ~ Binomial(n, p). */
  function binomPmf(k, n, p) {
    if (k < 0 || k > n) return 0;
    if (p <= 0) return k === 0 ? 1 : 0;
    if (p >= 1) return k === n ? 1 : 0;
    return Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p));
  }

  /** P(X <= k). Summed directly -- n here is at most a few thousand. */
  function binomCdf(k, n, p) {
    if (k < 0) return 0;
    if (k >= n) return 1;
    let acc = 0;
    for (let i = 0; i <= k; i++) acc += binomPmf(i, n, p);
    return Math.min(1, acc);
  }

  /** Smallest k with P(X <= k) >= q. Mirrors scipy's binom.ppf. */
  function binomPpf(q, n, p) {
    let acc = 0;
    for (let k = 0; k <= n; k++) {
      acc += binomPmf(k, n, p);
      if (acc >= q - 1e-12) return k;
    }
    return n;
  }

  // -- closed-form analytics (mirrors lab/analytics.py) ---------------------
  /** Per-round wealth multipliers for a win and a loss. */
  function multipliers(up, down, f) {
    return [1 + (up - 1) * f, 1 - (1 - down) * f];
  }

  /** E[m] - 1: arithmetic growth per round. What "expected value" means. */
  function ensembleGrowth(p, up, down, f) {
    const [mu, md] = multipliers(up, down, f);
    return p * mu + (1 - p) * md - 1;
  }

  /** E[ln m]: logarithmic growth per round. What one player actually gets. */
  function timeGrowth(p, up, down, f) {
    const [mu, md] = multipliers(up, down, f);
    if (mu <= 0 || md <= 0) return -Infinity;
    return p * Math.log(mu) + (1 - p) * Math.log(md);
  }

  /** E[m] = p*mUp + (1-p)*mDown -- the ensemble multiplier. Exact.
   *  Mirrors lab/analytics.py:arithmetic_mean_multiplier. */
  function arithmeticMeanMultiplier(p, up, down, f) {
    const [mu, md] = multipliers(up, down, f);
    return p * mu + (1 - p) * md;
  }

  /** G = mUp^p * mDown^(1-p) -- the multiplier the typical path compounds at.
   *  Exact; ln G is timeGrowth. Zero when either outcome is non-positive, which
   *  matches timeGrowth's -Infinity. Mirrors
   *  lab/analytics.py:geometric_mean_multiplier. */
  function geometricMeanMultiplier(p, up, down, f) {
    const [mu, md] = multipliers(up, down, f);
    if (mu <= 0 || md <= 0) return 0;
    return Math.pow(mu, p) * Math.pow(md, 1 - p);
  }

  /** E[m] - G: the AM-GM gap, >= 0 always and zero only when mUp === mDown.
   *  Mirrors lab/analytics.py:volatility_drag. */
  function volatilityDrag(p, up, down, f) {
    return arithmeticMeanMultiplier(p, up, down, f)
         - geometricMeanMultiplier(p, up, down, f);
  }

  /** Rounds for the typical (geometric-mean) path to halve: ln(2)/|ln G|.
   *
   *  Exact for the trajectory w0*G^T. Sign convention: positive rounds when
   *  G < 1 (the typical path is decaying) and +Infinity when G >= 1, where
   *  there is no halving at all -- see doublingTime for the growing case.
   *  Mirrors lab/analytics.py:median_half_life. */
  function medianHalfLife(p, up, down, f) {
    const g = geometricMeanMultiplier(p, up, down, f);
    if (g <= 0) return 0;
    if (g >= 1) return Infinity;
    return Math.LN2 / Math.abs(Math.log(g));
  }

  /** Heads needed over `rounds` to finish at or above the starting stake:
   *  k >= T * ln(1/mDown) / ln(mUp/mDown). Returned unrounded on purpose, to be
   *  read against summary()'s expectedHeads. Degenerate mUp === mDown and
   *  mDown <= 0 cases are handled without dividing by zero.
   *  Mirrors lab/analytics.py:break_even_heads. */
  function breakEvenHeads(rounds, p, up, down, f) {
    const T = rounds;
    const [mu, md] = multipliers(up, down, f);
    if (md <= 0) return mu >= 1 ? T : Infinity;
    if (mu <= 0) return Infinity;
    const lu = Math.log(mu), ld = Math.log(md);
    if (lu === ld) return ld >= 0 ? 0 : Infinity;
    return T * (-ld) / (lu - ld);
  }

  function expectedFinal(w0, rounds, p, up, down, f) {
    return w0 * Math.pow(1 + ensembleGrowth(p, up, down, f), rounds);
  }

  /** Exact q-quantile of W_T: W_T is monotone in the heads count. */
  function quantileFinal(q, w0, rounds, p, up, down, f) {
    const [mu, md] = multipliers(up, down, f);
    const k = binomPpf(q, rounds, p);
    return w0 * Math.pow(mu, k) * Math.pow(md, rounds - k);
  }

  const medianFinal = (w0, rounds, p, up, down, f) =>
    quantileFinal(0.5, w0, rounds, p, up, down, f);

  /** P(W_T < threshold), exact via the binomial CDF. */
  function probBelow(threshold, w0, rounds, p, up, down, f) {
    const [mu, md] = multipliers(up, down, f);
    if (mu <= 0 || md <= 0) return 1;
    const lu = Math.log(mu), ld = Math.log(md);
    const target = Math.log(threshold / w0);
    if (lu === ld) return rounds * lu < target ? 1 : 0;
    const kstar = (target - rounds * ld) / (lu - ld);
    if (lu > ld) {
      const kmax = Math.ceil(kstar) - 1;
      return kmax >= 0 ? binomCdf(kmax, rounds, p) : 0;
    }
    const kmin = Math.floor(kstar) + 1;
    return 1 - binomCdf(kmin - 1, rounds, p);
  }

  /** Bet fraction maximising time growth: f* = (p*a - q*b) / (a*b). */
  function kellyFraction(p, up, down) {
    const a = up - 1, b = 1 - down, q = 1 - p;
    // Both degenerate coins are reachable from the sliders and the closed
    // form divides by a*b. a = 0 is "nothing to win, stake nothing"; b = 0 is
    // a free roll where Kelly is unbounded and only the f <= 1 cap binds --
    // NOT an edgeless coin, which is what returning NaN used to imply.
    if (a <= 0) return 0;
    if (b <= 0) return p > 0 ? 1 : 0;
    const f = (p * a - q * b) / (a * b);
    return Math.max(0, Math.min(f, 1 / b - 1e-12));
  }

  // `growthAtFraction(f, p, up, down)` is not defined separately: it is exactly
  // timeGrowth(p, up, down, f). Same choice as lab/analytics.py.

  /** max_f timeGrowth -- the growth rate achieved at f*. Exact (a composition
   *  of two closed forms). Mirrors lab/analytics.py:kelly_growth. */
  function kellyGrowth(p, up, down) {
    return timeGrowth(p, up, down, kellyFraction(p, up, down));
  }

  /**
   * The positive f > f* at which timeGrowth returns to zero -- past it, staking
   * more makes you poorer than not playing.
   *
   * EXACT ONLY AT p = 1/2, where (1+af)(1-bf) = 1 gives f0 = (a-b)/(ab) = 2f*.
   * For any other p the equation (1+af)^p (1-bf)^(1-p) = 1 is transcendental,
   * so this is a NUMERICAL ROOT FIND: bisection on [f*, 1/b), 200 halvings,
   * stopping once the bracket is under `tol` = 1e-13. The loop is written in
   * the same order as lab/analytics.py:zero_growth_fraction so both sides land
   * on the same double. Returns 0 for a non-positive edge.
   */
  function zeroGrowthFraction(p, up, down, tol, iters) {
    if (tol === undefined) tol = 1e-13;
    if (iters === undefined) iters = 200;
    const a = up - 1, b = 1 - down;
    if (a <= 0 || b <= 0) return NaN;
    const fStar = kellyFraction(p, up, down);
    if (fStar <= 0) return 0;
    if (Math.abs(p - 0.5) < 1e-15) return (a - b) / (a * b);
    let lo = fStar;
    let hi = (1 / b) * (1 - 1e-12);
    if (lo >= hi || timeGrowth(p, up, down, hi) > 0) return hi;
    for (let i = 0; i < iters; i++) {
      if (hi - lo <= tol) break;
      const mid = 0.5 * (lo + hi);
      if (timeGrowth(p, up, down, mid) > 0) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
  }

  /** Rounds for the typical path to double: ln(2)/E[ln m], +Infinity when the
   *  time-average growth is not positive. Exact.
   *  Mirrors lab/analytics.py:doubling_time. */
  function doublingTime(p, up, down, f) {
    const g = timeGrowth(p, up, down, f);
    if (!isFinite(g) || g <= 0) return Infinity;
    return Math.LN2 / g;
  }

  function sigmaLog(p, up, down, f) {
    const [mu, md] = multipliers(up, down, f);
    if (mu <= 0 || md <= 0) return Infinity;
    return Math.sqrt(p * (1 - p)) * Math.abs(Math.log(mu) - Math.log(md));
  }

  /** Var[W_T], exact -- see analytics.py:variance_final. */
  function varianceFinal(w0, rounds, p, up, down, f) {
    const [mu, md] = multipliers(up, down, f);
    const e2 = w0 * w0 * Math.pow(p * mu * mu + (1 - p) * md * md, rounds);
    const e1 = expectedFinal(w0, rounds, p, up, down, f);
    return Math.max(0, e2 - e1 * e1);
  }

  const sdFinal = (w0, rounds, p, up, down, f) =>
    Math.sqrt(varianceFinal(w0, rounds, p, up, down, f));

  /** Everything the stat tiles and table view need. */
  function summary(pr) {
    const { w0, rounds, p, up, down, f } = pr;
    return {
      ensembleGrowth: ensembleGrowth(p, up, down, f),
      timeGrowth: timeGrowth(p, up, down, f),
      expectedFinal: expectedFinal(w0, rounds, p, up, down, f),
      medianFinal: medianFinal(w0, rounds, p, up, down, f),
      sdFinal: sdFinal(w0, rounds, p, up, down, f),
      pBelowStart: probBelow(w0, w0, rounds, p, up, down, f),
      pBelowOne: probBelow(1, w0, rounds, p, up, down, f),
      q05: quantileFinal(0.05, w0, rounds, p, up, down, f),
      q95: quantileFinal(0.95, w0, rounds, p, up, down, f),
      kellyF: kellyFraction(p, up, down),
      sigmaLog: sigmaLog(p, up, down, f),
      // The two multipliers whose disagreement is the whole scenario, and the
      // AM-GM gap between them.
      arithmeticMultiplier: arithmeticMeanMultiplier(p, up, down, f),
      geometricMultiplier: geometricMeanMultiplier(p, up, down, f),
      volatilityDrag: volatilityDrag(p, up, down, f),
      medianHalfLife: medianHalfLife(p, up, down, f),
      // breakEvenHeads next to expectedHeads is the "you need 55 and expect 50"
      // comparison; breakEvenHeads is deliberately unrounded.
      breakEvenHeads: breakEvenHeads(rounds, p, up, down, f),
      expectedHeads: rounds * p,
      kellyGrowth: kellyGrowth(p, up, down),
      zeroGrowthF: zeroGrowthFraction(p, up, down),
      doublingTime: doublingTime(p, up, down, f),
    };
  }

  // -- path simulation ------------------------------------------------------
  /** Individual paths kept in full and drawn on top of the quantile fan.
   *
   *  Deliberately small, for a reason that is about legibility rather than
   *  speed: every round multiplies wealth by one of two constants, so in log
   *  space the paths live on a binomial lattice and hundreds of them overplot
   *  into a diamond moire. charts.js reads this rather than defining its own. */
  const SAMPLE_PATHS = 8;

  /**
   * Simulate `nPaths` wealth trajectories.
   *
   * Two things come back, and the split is what keeps this cheap at 2000 paths
   * x 500 rounds:
   *
   *   paths   the first `stored` trajectories in full (a flat Float64Array,
   *           nPaths-major). Only the handful the chart actually draws are
   *           kept -- materialising all million values cost ~8MB and a third
   *           of the runtime to produce numbers nothing ever read.
   *   counts  the heads-count histogram, counts[h * stride + t] = how many
   *           players have h heads after t rounds. Indexed heads-major
   *           because the writer walks one player forward in time, where h
   *           barely moves and t always advances by one -- the transposed
   *           layout jumps a whole row per round and measurably slower.
   *
   * `counts` is the whole distribution at every round, in (rounds+1)^2 integers
   * instead of nPaths x (rounds+1) floats, and it is exact rather than a
   * summary: wealth after t rounds is w0 * mu^h * md^(t-h), a value that is
   * monotone in h, so the histogram fixes every order statistic. pathStats
   * reads ranks straight off it and never sorts anything.
   *
   * Draw order is untouched -- one number per round, paths in order -- so the
   * seeded paths still match lab/analytics.py bit for bit.
   */
  function simulatePaths(pr) {
    const { w0, rounds, p, up, down, f, nPaths, seed } = pr;
    const [mu, md] = multipliers(up, down, f);
    const rand = mulberry32(seed);
    const stride = rounds + 1;
    const stored = Math.min(nPaths, SAMPLE_PATHS);
    const paths = new Float64Array(stored * stride);
    const terminal = new Float64Array(nPaths);
    const counts = new Int32Array(stride * stride);

    // Powers of the two multipliers, accumulated the same way a path
    // accumulates them, so a reconstructed value matches the walked one.
    const muPow = new Float64Array(stride);
    const mdPow = new Float64Array(stride);
    muPow[0] = 1; mdPow[0] = 1;
    for (let i = 1; i < stride; i++) {
      muPow[i] = muPow[i - 1] * mu;
      mdPow[i] = mdPow[i - 1] * md;
    }

    counts[0] += nPaths; // t = 0: everybody at zero heads
    for (let i = 0; i < nPaths; i++) {
      const keep = i < stored;
      const base = i * stride;
      let w = w0, h = 0;
      if (keep) paths[base] = w;
      for (let t = 1; t <= rounds; t++) {
        if (rand() < p) { w *= mu; h++; } else { w *= md; }
        counts[h * stride + t]++;
        if (keep) paths[base + t] = w;
      }
      terminal[i] = w;
    }
    return {
      paths, terminal, stride, nPaths, rounds, stored,
      counts, muPow, mdPow, w0, ascending: mu >= md,
    };
  }

  /**
   * Per-round quantile bands and mean across all simulated paths.
   *
   * Returns a fan (5/25/50/75/95) rather than just the median because drawing
   * hundreds of individual paths is unreadable here: every step is a constant
   * factor, so on a log axis the paths sit on a binomial lattice and overplot
   * into a moire grid. Bands show where players actually are; a handful of
   * sample paths (drawn separately) show what one player's ride looks like.
   *
   * The mean rides along because its divergence from the median is the story.
   */
  const BAND_Q = [0.05, 0.25, 0.5, 0.75, 0.95];
  const BAND_KEYS = ["q05", "q25", "median", "q75", "q95"];

  function emptyBands(stride) {
    return {
      mean: new Float64Array(stride),
      q05: new Float64Array(stride),
      q25: new Float64Array(stride),
      median: new Float64Array(stride),
      q75: new Float64Array(stride),
      q95: new Float64Array(stride),
    };
  }

  /**
   * The integer ranks the five bands interpolate between, ascending.
   *
   * The empirical quantile is the value at pos = (n-1)q, linearly interpolated
   * between its two neighbouring order statistics when pos is not whole. So
   * each band needs the values at floor(pos) and ceil(pos): ten ranks, already
   * ascending because the quantiles are.
   */
  function bandRanks(nPaths) {
    const pos = [], lo = [], hi = [], ranks = [];
    for (const q of BAND_Q) {
      const x = (nPaths - 1) * q;
      pos.push(x);
      lo.push(Math.floor(x));
      hi.push(Math.ceil(x));
      ranks.push(Math.floor(x), Math.ceil(x));
    }
    return { pos, lo, hi, ranks };
  }

  /** Blend the ten rank values back into five band values. */
  function fillBands(out, t, vals, r) {
    for (let k = 0; k < BAND_KEYS.length; k++) {
      const a = vals[2 * k], b = vals[2 * k + 1];
      out[BAND_KEYS[k]][t] =
        r.lo[k] === r.hi[k] ? a : a + (r.pos[k] - r.lo[k]) * (b - a);
    }
  }

  /**
   * Bands for the multiplicative game, read off the heads-count histogram.
   *
   * No sorting and no pass over the trajectories at all: at round t the whole
   * sample is described by counts[h], and value(h) = w0 * mu^h * md^(t-h) is
   * monotone in h, so walking the buckets in value order walks the sample in
   * rank order. The mean falls out of the same walk as sum(count * value).
   *
   * That turns an O(rounds * nPaths * log nPaths) sort per frame into
   * O(rounds^2 / 2) arithmetic over a histogram -- at the top of the sliders,
   * ~400ms of sorting becomes a few milliseconds.
   */
  function pathStats(sim) {
    const { stride, nPaths, counts, muPow, mdPow, w0, ascending } = sim;
    const out = emptyBands(stride);
    const r = bandRanks(nPaths);
    const vals = new Float64Array(r.ranks.length);

    for (let t = 0; t < stride; t++) {
      let acc = 0, cum = 0, ri = 0;
      // Buckets in ascending *value* order. mu >= md for every reachable
      // control setting, so that is ascending h -- but a scenario that ever
      // configures a heads multiplier below the tails one would reverse the
      // lattice, and reading ranks off it backwards would silently swap the
      // 5th and 95th percentiles.
      for (let j = 0; j <= t; j++) {
        const h = ascending ? j : t - j;
        const c = counts[h * stride + t];
        if (c === 0) continue;
        const value = w0 * muPow[h] * mdPow[t - h];
        acc += c * value;
        const upTo = cum + c;
        // Ranks cum .. upTo-1 all hold this value.
        while (ri < r.ranks.length && r.ranks[ri] < upTo) vals[ri++] = value;
        cum = upTo;
      }
      out.mean[t] = acc / nPaths;
      fillBands(out, t, vals, r);
    }
    return out;
  }

  /**
   * Bands for the additive walk, by counting sort over bankroll positions.
   *
   * The walk is already an integer number of bets in [0, n], so the positions
   * are their own histogram buckets and no comparison sort is needed here
   * either. Only the occupied span is scanned, and the scan clears the buckets
   * behind it so the same scratch array serves every round.
   */
  function walkStats(sim) {
    const { paths, stride, nPaths, n } = sim;
    const out = emptyBands(stride);
    const r = bandRanks(nPaths);
    const vals = new Float64Array(r.ranks.length);
    const buckets = new Int32Array(n + 1);

    for (let t = 0; t < stride; t++) {
      let acc = 0, lo = n, hi = 0;
      for (let i = 0; i < nPaths; i++) {
        const x = paths[i * stride + t];
        buckets[x]++;
        acc += x;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
      out.mean[t] = acc / nPaths;

      let cum = 0, ri = 0;
      for (let x = lo; x <= hi; x++) {
        const c = buckets[x];
        if (c === 0) continue;
        buckets[x] = 0; // cleared behind the scan, so no separate clear pass
        const upTo = cum + c;
        while (ri < r.ranks.length && r.ranks[ri] < upTo) vals[ri++] = x;
        cum = upTo;
      }
      fillBands(out, t, vals, r);
    }
    return out;
  }

  /**
   * Log-spaced histogram of terminal wealth.
   *
   * Log bins because terminal wealth spans many orders of magnitude -- linear
   * bins would put every path in the first bucket. Non-positive values are
   * collected separately as a wiped-out count rather than silently dropped.
   */
  function logHistogram(terminal, nBins) {
    const positive = [];
    let wiped = 0;
    for (let i = 0; i < terminal.length; i++) {
      if (terminal[i] > 0) positive.push(terminal[i]);
      else wiped++;
    }
    if (!positive.length) return { edges: [], counts: [], wiped };

    let lo = Infinity, hi = -Infinity;
    for (const v of positive) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const lmin = Math.log10(lo), lmax = Math.log10(hi);
    const span = lmax - lmin || 1;
    const edges = new Array(nBins + 1);
    for (let i = 0; i <= nBins; i++) edges[i] = lmin + (span * i) / nBins;

    const counts = new Array(nBins).fill(0);
    for (const v of positive) {
      let b = Math.floor(((Math.log10(v) - lmin) / span) * nBins);
      if (b >= nBins) b = nBins - 1;
      if (b < 0) b = 0;
      counts[b]++;
    }
    return { edges, counts, wiped };
  }

  /** Time-growth curve over bet fraction -- the Kelly sweep. */
  function kellySweep(pr, steps) {
    const { p, up, down } = pr;
    const fMax = Math.min(1, 1 / (1 - down));
    const fs = [], g = [];
    for (let i = 0; i <= steps; i++) {
      const f = (fMax * i) / steps;
      fs.push(f);
      g.push(timeGrowth(p, up, down, f));
    }
    return { fs, g, fStar: kellyFraction(p, up, down) };
  }

  // ==========================================================================
  // Gambler's ruin -- mirrors lab/analytics.py section 2
  // ==========================================================================
  /** `amount` as a whole number of bets, at least one.
   *
   *  Math.round matches the Python side's floor(x + 0.5) deliberately: Python's
   *  round() is banker's rounding and would disagree on exact .5 ties. */
  function bets(amount, bet) {
    return Math.max(1, Math.round(amount / Math.max(bet, 1e-12)));
  }

  /** [k, n]: start and target in whole bets, clamped so 0 < k < n. */
  function ruinUnits(bankroll, target, bet) {
    const k = bets(bankroll, bet);
    return [k, Math.max(k + 1, bets(target, bet))];
  }

  /**
   * P(hit 0 before n) for a walk starting at k. The exact core.
   *
   * The r > 1 branch is algebraically rearranged to use only negative powers of
   * r; written directly, r^n overflows for a long unfavourable walk and the
   * ratio of two infinities is NaN where the true answer is ~1.
   *
   * Taking (k, n) rather than dollars is what lets the bet-size sweep stay
   * exact -- see ruinBetCurve.
   */
  function ruinProbUnits(k, n, p) {
    if (p <= 0) return 1;
    if (p >= 1) return 0;
    if (Math.abs(p - 0.5) < 1e-15) return 1 - k / n;
    const r = (1 - p) / p;
    if (r > 1) return (1 - Math.pow(r, k - n)) / (1 - Math.pow(r, -n));
    return (Math.pow(r, k) - Math.pow(r, n)) / (1 - Math.pow(r, n));
  }

  /** P(hit $0 before the target), in dollars. Exact. */
  function ruinProb(bankroll, target, p, bet) {
    const [k, n] = ruinUnits(bankroll, target, bet);
    return ruinProbUnits(k, n, p);
  }

  const reachTargetProb = (bankroll, target, p, bet) =>
    1 - ruinProb(bankroll, target, p, bet);

  /** P(eventual ruin) with no target, against a house with unlimited money. */
  function ruinProbUnbounded(bankroll, p, bet) {
    if (p <= 0.5) return 1;
    return Math.pow((1 - p) / p, bets(bankroll, bet));
  }

  /** E[steps until either barrier is hit] for a walk starting at k. Exact. */
  function ruinDurationUnits(k, n, p) {
    if (p <= 0) return k;
    if (p >= 1) return n - k;
    if (Math.abs(p - 0.5) < 1e-15) return k * (n - k);
    const r = (1 - p) / p, q = 1 - p;
    const ratio = r > 1
      ? (Math.pow(r, k - n) - Math.pow(r, -n)) / (1 - Math.pow(r, -n))
      : (1 - Math.pow(r, k)) / (1 - Math.pow(r, n));
    return (k - n * ratio) / (q - p);
  }

  /** E[rounds until one barrier is hit], in dollars. Exact. */
  function ruinDuration(bankroll, target, p, bet) {
    const [k, n] = ruinUnits(bankroll, target, bet);
    return ruinDurationUnits(k, n, p);
  }

  /** [E, SD] of terminal wealth, exact -- see analytics.py:ruin_terminal_stats.
   *  Terminal wealth is two-point (target or $0), so this collapses to the
   *  Bernoulli mean/SD scaled by target. */
  function ruinTerminalStats(bankroll, target, p, bet) {
    const q = reachTargetProb(bankroll, target, p, bet);
    return [target * q, target * Math.sqrt(q * (1 - q))];
  }

  function ruinSummary(pr) {
    const { bankroll, target, p, bet } = pr;
    const [k, n] = ruinUnits(bankroll, target, bet);
    const [terminalMean, terminalSd] = ruinTerminalStats(bankroll, target, p, bet);
    return {
      k, n,
      ruinProb: ruinProb(bankroll, target, p, bet),
      reachProb: reachTargetProb(bankroll, target, p, bet),
      duration: ruinDuration(bankroll, target, p, bet),
      ruinUnbounded: ruinProbUnbounded(bankroll, p, bet),
      fairRuinProb: ruinProb(bankroll, target, 0.5, bet),
      edge: 2 * p - 1,
      terminalMean, terminalSd,
    };
  }

  /** P(ruin) against starting bankroll, in bets, across the whole board. */
  function ruinCurve(pr, maxPoints) {
    const { target, p, bet } = pr;
    const n = Math.max(2, bets(target, bet));
    const step = Math.max(1, Math.ceil(n / (maxPoints || n)));
    const ks = [], ruin = [];
    for (let k = 0; k <= n; k += step) {
      ks.push(k);
      ruin.push(k === 0 ? 1 : k === n ? 0 : ruinProb(k * bet, n * bet, p, bet));
    }
    if (ks[ks.length - 1] !== n) { ks.push(n); ruin.push(0); }
    return { ks, ruin, n, bet };
  }

  /**
   * P(ruin) against bet size -- the bold-play curve.
   *
   * For an unfavourable coin this falls as the bet grows: each extra round is
   * another chance for the edge to bite, so the way to survive a bad game is to
   * play it as few times as possible. A favourable coin reverses it.
   */
  function ruinBetCurve(pr, steps) {
    const { bankroll, target, p } = pr;
    // Swept over the integer number of bets the bankroll is worth, not over
    // dollar bet sizes. A dollar sweep divides and rounds twice -- once for k,
    // once for n -- and the two roundings beat against each other, printing a
    // sawtooth on a curve that is genuinely smooth. Here k is exact by
    // construction and only the target rounds.
    const goal = target / Math.max(bankroll, 1e-12);
    const top = Math.max(2, Math.round(bankroll));
    const stride = Math.max(1, Math.ceil((top - 1) / (steps || top)));
    const sizes = [], ruin = [];
    for (let k = top; k >= 2; k -= stride) { // descending k, ascending bet size
      const n = Math.max(k + 1, Math.round(k * goal));
      sizes.push(bankroll / k);
      ruin.push(ruinProbUnits(k, n, p));
    }
    // The boldest playable bet -- half the bankroll -- is the end of the story,
    // so it is never allowed to fall off the end of a strided sweep.
    if (sizes[sizes.length - 1] !== bankroll / 2) {
      sizes.push(bankroll / 2);
      ruin.push(ruinProbUnits(2, Math.max(3, Math.round(2 * goal)), p));
    }
    return { sizes, ruin };
  }

  /**
   * Random walk with both barriers absorbing, in units of one bet.
   *
   * Draws exactly one number per live round and none once absorbed, matching
   * lab/analytics.py:simulate_ruin so the seeded paths agree bit for bit.
   */
  function simulateRuin(pr) {
    const { bankroll, target, p, bet, rounds, nPaths, seed } = pr;
    const [k, n] = ruinUnits(bankroll, target, bet);
    const rand = mulberry32(seed);
    const stride = rounds + 1;
    // Positions, not dollars: the walk moves one whole bet at a time, so these
    // are integers in [0, n]. Int32 halves the memory traffic of the old
    // Float64 buffer and lets walkStats use the positions as histogram buckets.
    const paths = new Int32Array(nPaths * stride);
    const terminal = new Int32Array(nPaths);
    let ruined = 0, reached = 0;
    // Absorption round per path, or -1 for the ones still walking at the end.
    const absorbedAt = new Int32Array(nPaths).fill(-1);

    for (let i = 0; i < nPaths; i++) {
      const base = i * stride;
      let x = k;
      paths[base] = x;
      for (let t = 1; t <= rounds; t++) {
        if (x > 0 && x < n) {
          x += rand() < p ? 1 : -1;
          if ((x <= 0 || x >= n) && absorbedAt[i] < 0) absorbedAt[i] = t;
        }
        paths[base + t] = x;
      }
      terminal[i] = x;
      if (x <= 0) ruined++;
      else if (x >= n) reached++;
    }
    return {
      paths, terminal, stride, nPaths, rounds, k, n, bet, absorbedAt,
      ruined, reached, undecided: nPaths - ruined - reached,
    };
  }

  // ==========================================================================
  // St Petersburg -- mirrors lab/analytics.py section 3
  // ==========================================================================
  /** E[payout] = (1-p)/(1-mp), or Infinity once m*p >= 1. Exact. */
  function spExpected(p, m) {
    if (m * p >= 1) return Infinity;
    return (1 - p) / (1 - m * p);
  }

  /** Exact q-quantile of the payout: the payout is monotone in the toss count. */
  function spQuantile(q, p, m) {
    if (p <= 0) return 1;
    const n = Math.max(1, Math.ceil(Math.log1p(-q) / Math.log(p)));
    return Math.pow(m, n - 1);
  }

  const spMedian = (p, m) => spQuantile(0.5, p, m);

  /** P(payout >= m^(tier-1)) = p^(tier-1). Exact. */
  const spSurvival = (tier, p) => Math.pow(p, Math.max(1, tier) - 1);

  /** This tier's share of E[payout]: (1-p)(mp)^(tier-1). Flat iff m*p = 1. */
  const spTierContribution = (tier, p, m) =>
    (1 - p) * Math.pow(m * p, Math.max(1, tier) - 1);

  const spCapAmount = (m, tiers) => Math.pow(m, Math.max(1, tiers) - 1);

  /** E[payout] when the house pays at most m^(tiers-1). Exact. */
  function spCappedExpected(p, m, tiers) {
    const L = Math.max(1, Math.round(tiers));
    const x = m * p;
    const geo = Math.abs(x - 1) < 1e-15 ? L : (1 - Math.pow(x, L)) / (1 - x);
    return (1 - p) * geo + Math.pow(p, L) * Math.pow(m, L - 1);
  }

  /**
   * E[ln X], Daniel Bernoulli's 1738 resolution. Exact, in closed form.
   *
   * X = m^(N-1) with N geometric, so E[ln X] = ln(m) * E[N-1] and
   * E[N-1] = p/(1-p) by the standard Sum j x^j = x/(1-x)^2 identity. Hence
   * E[ln X] = ln(m) * p/(1-p) -- convergent for every p < 1 and finite m,
   * including the classic game whose E[X] is infinite.
   * Mirrors lab/analytics.py:sp_log_utility.
   */
  function spLogUtility(p, m) {
    if (m <= 0) return -Infinity;
    if (p >= 1) return m > 1 ? Infinity : (m < 1 ? -Infinity : 0);
    if (p <= 0) return 0;
    return Math.log(m) * p / (1 - p);
  }

  /** exp(E[ln X]) = m^(p/(1-p)): what a log-utility player would swap the game
   *  for. Exact. With this module's m^(N-1) payout convention the classic
   *  p = 1/2, m = 2 game gives exactly $2.00; the "about $4" figure usually
   *  quoted belongs to the 2^N statement of the game, which pays double at
   *  every tier. Mirrors lab/analytics.py:sp_certainty_equivalent. */
  function spCertaintyEquivalent(p, m) {
    return Math.exp(spLogUtility(p, m));
  }

  /** APPROXIMATION -- see the docstring in lab/analytics.py:sp_typical_mean. */
  function spTypicalMean(plays, p, m) {
    if (plays < 1 || p <= 0 || p >= 1) return spCappedExpected(p, m, 1);
    const L = Math.floor(Math.log(plays) / Math.log(1 / p)) + 1;
    return spCappedExpected(p, m, Math.max(1, L));
  }

  /** [mean, sd] of the payout, each finite or Infinity -- see
   *  analytics.py:sp_dispersion. Variance needs the stricter m^2*p < 1, not
   *  just m*p < 1, so there is a band where the mean is finite and the
   *  spread around it is not. */
  function spDispersion(p, m) {
    const mean = spExpected(p, m);
    if (!isFinite(mean) || m * m * p >= 1) return [mean, Infinity];
    const e2 = (1 - p) / (1 - m * m * p);
    return [mean, Math.sqrt(Math.max(0, e2 - mean * mean))];
  }

  function spSummary(pr) {
    const { p, m, tiers, plays } = pr;
    const [, sd] = spDispersion(p, m);
    return {
      expected: spExpected(p, m),
      median: spMedian(p, m),
      q95: spQuantile(0.95, p, m),
      capped: spCappedExpected(p, m, tiers),
      capAmount: spCapAmount(m, tiers),
      typicalMean: spTypicalMean(plays, p, m),
      divergent: m * p >= 1,
      mp: m * p,
      sd,
      sdDivergent: !isFinite(sd),
      m2p: m * m * p,
      // Bernoulli's own 1738 answer: E[ln X] converges where E[X] does not.
      logUtility: spLogUtility(p, m),
      certaintyEquivalent: spCertaintyEquivalent(p, m),
    };
  }

  /**
   * Play the game out: `runs` independent players, `plays` games each.
   *
   * One random number per toss, matching the Python reference's draw order.
   * Running means are sampled at log-spaced plays because that is the axis the
   * chart uses -- keeping all `plays` points per run would be tens of millions
   * of numbers to plot a line that is smooth in log x anyway.
   */
  /**
   * Payout by toss count, memoised.
   *
   * The play-out calls Math.pow once per game -- over a million times at the
   * top of the sliders, for at most a few dozen distinct answers. The table is
   * filled with Math.pow itself rather than by repeated multiplication, so the
   * values are bit-identical to the ones the loop used to compute inline and
   * the seeded payouts still match lab/analytics.py exactly.
   */
  function payoutTable(m, upTo) {
    const tbl = new Float64Array(upTo + 1);
    for (let k = 0; k <= upTo; k++) tbl[k] = Math.pow(m, k);
    return tbl;
  }

  function simulateStPetersburg(pr) {
    const { runs, plays, p, m, seed } = pr;
    const rand = mulberry32(seed);
    const xs = logSpacedIndices(plays, 140);
    const curves = [], means = [], firstPayouts = [];
    let biggest = 0, longest = 0;
    // Deep runs are geometrically rare, so this covers every game that will
    // realistically come up; anything past it falls back to Math.pow.
    const POW_CAP = 256;
    const pows = payoutTable(m, POW_CAP);

    for (let r = 0; r < runs; r++) {
      let total = 0, at = 0;
      const curve = new Float64Array(xs.length);
      for (let i = 0; i < plays; i++) {
        let tosses = 1;
        while (rand() < p) tosses++;
        const payout = tosses <= POW_CAP + 1
          ? pows[tosses - 1]
          : Math.pow(m, tosses - 1);
        total += payout;
        if (payout > biggest) biggest = payout;
        if (tosses > longest) longest = tosses;
        if (r === 0 && i < 10) firstPayouts.push(payout);
        // xs is ascending and every play advances i by one, so a single cursor
        // walks it -- no search per play.
        while (at < xs.length && xs[at] === i + 1) {
          curve[at] = total / (i + 1);
          at++;
        }
      }
      while (at < xs.length) { curve[at] = total / plays; at++; }
      curves.push(curve);
      means.push(total / plays);
    }
    return { xs, curves, means, firstPayouts, biggest, longest, plays };
  }

  /** Ascending, de-duplicated, log-spaced integers in [1, n]. */
  function logSpacedIndices(n, count) {
    const out = [];
    const hi = Math.log10(Math.max(2, n));
    for (let i = 0; i < count; i++) {
      const v = Math.round(Math.pow(10, (hi * i) / (count - 1)));
      const c = Math.min(Math.max(1, v), n);
      if (!out.length || c > out[out.length - 1]) out.push(c);
    }
    if (out[out.length - 1] !== n) out.push(n);
    return out;
  }

  // ==========================================================================
  // Iterated prisoner's dilemma -- mirrors lab/analytics.py section 4
  // ==========================================================================
  const STRATEGIES = ["tft", "grim", "allc", "alld", "rand"];

  const STRATEGY_LABELS = {
    tft: "Tit for tat",
    grim: "Grim trigger",
    allc: "Always cooperate",
    alld: "Always defect",
    rand: "Random",
  };

  const STRATEGY_NOTES = {
    tft: "cooperates first, then copies you",
    grim: "cooperates until you defect once, then never again",
    allc: "always cooperates",
    alld: "always defects",
    rand: "cooperates half the time, at random",
  };

  const pdPayoffs = (t) => ({ T: t, R: 3, P: 1, S: 0 });

  /** T > R > P > S and 2R > T + S -- what makes it a dilemma at all. */
  const pdIsDilemma = (pay) =>
    pay.T > pay.R && pay.R > pay.P && pay.P > pay.S &&
    2 * pay.R > pay.T + pay.S;

  /** P(this strategy intends to cooperate) given what it can see. */
  function pCooperate(strategy, first, oppDefectedLast, triggered) {
    switch (strategy) {
      case "allc": return 1;
      case "alld": return 0;
      case "rand": return 0.5;
      case "tft": return first ? 1 : (oppDefectedLast ? 0 : 1);
      case "grim": return triggered ? 0 : 1;
      default: throw new Error(`unknown strategy: ${strategy}`);
    }
  }

  const payoffFor = (pay, meCoop, themCoop) =>
    meCoop ? (themCoop ? pay.R : pay.S) : (themCoop ? pay.T : pay.P);

  // Joint-state bits. Everything any of the five strategies can condition on
  // fits in four: 16 states, so the expectation is an exact forward pass.
  const B_LAST_D = 1;  // B defected last round     -> drives A's tit-for-tat
  const A_LAST_D = 2;  // A defected last round     -> drives B's tit-for-tat
  const B_EVER_D = 4;  // B has ever defected       -> has A's grim trigger fired
  const A_EVER_D = 8;  // A has ever defected       -> has B's grim trigger fired

  /**
   * Exact expected per-round score for each side of one iterated match.
   *
   * No Monte Carlo: the pair's joint state is one of 16, so the whole match is a
   * forward pass over a 16-vector. `noise` is a trembling hand -- each intended
   * move is flipped with that probability, and the flipped move is what both the
   * payoff and the opponent's memory see.
   */
  function pdPair(sa, sb, rounds, pay, noise) {
    const e = noise || 0;
    let dist = new Float64Array(16);
    let next = new Float64Array(16);
    dist[0] = 1;
    let totalA = 0, totalB = 0;

    for (let rnd = 0; rnd < rounds; rnd++) {
      const first = rnd === 0;
      next.fill(0);
      for (let s = 0; s < 16; s++) {
        const w = dist[s];
        if (w <= 0) continue;
        const bl = (s & B_LAST_D) !== 0, al = (s & A_LAST_D) !== 0;
        const be = (s & B_EVER_D) !== 0, ae = (s & A_EVER_D) !== 0;
        const ca = pCooperate(sa, first, bl, be);
        const cb = pCooperate(sb, first, al, ae);
        const pa = ca * (1 - e) + (1 - ca) * e;
        const pb = cb * (1 - e) + (1 - cb) * e;
        for (let ai = 0; ai < 2; ai++) {
          const aCoop = ai === 0;
          const wa = aCoop ? pa : 1 - pa;
          if (wa <= 0) continue;
          for (let bi = 0; bi < 2; bi++) {
            const bCoop = bi === 0;
            const wb = bCoop ? pb : 1 - pb;
            if (wb <= 0) continue;
            const ww = w * wa * wb;
            totalA += ww * payoffFor(pay, aCoop, bCoop);
            totalB += ww * payoffFor(pay, bCoop, aCoop);
            let key = 0;
            if (!bCoop) key |= B_LAST_D | B_EVER_D;
            if (!aCoop) key |= A_LAST_D | A_EVER_D;
            if (be) key |= B_EVER_D;
            if (ae) key |= A_EVER_D;
            next[key] += ww;
          }
        }
      }
      const swap = dist; dist = next; next = swap;
    }
    return [totalA / rounds, totalB / rounds];
  }

  /** A[i][j] = expected per-round score of strategy i against strategy j. */
  function pdMatrix(rounds, pay, noise, strategies) {
    const list = strategies || STRATEGIES;
    return list.map((si) =>
      list.map((sj) => pdPair(si, sj, rounds, pay, noise)[0]));
  }

  /** Round robin including self-play, as in Axelrod's 1980 tournament. */
  function pdTournament(rounds, pay, noise, strategies) {
    const matrix = pdMatrix(rounds, pay, noise, strategies);
    const scores = matrix.map((row) => row.reduce((a, b) => a + b, 0) / row.length);
    return { matrix, scores };
  }

  /** Discrete replicator dynamics on the tournament matrix. */
  function pdReplicator(matrix, generations, x0) {
    const n = matrix.length;
    let x = x0 ? x0.slice() : new Array(n).fill(1 / n);
    const history = [x.slice()];
    for (let g = 0; g < Math.max(0, Math.round(generations)); g++) {
      const fit = matrix.map((row) =>
        row.reduce((acc, v, j) => acc + x[j] * v, 0));
      const tot = fit.reduce((acc, f, i) => acc + x[i] * f, 0);
      if (tot <= 0) { history.push(x.slice()); continue; }
      x = x.map((xi, i) => (xi * fit[i]) / tot);
      history.push(x.slice());
    }
    return history;
  }

  function pdSummary(pr) {
    const { rounds, t, noise, generations } = pr;
    const pay = pdPayoffs(t);
    const { matrix, scores } = pdTournament(rounds, pay, noise);
    const shares = pdReplicator(matrix, generations);
    const argmax = (arr) =>
      arr.reduce((best, v, i) => (v > arr[best] ? i : best), 0);
    const best = argmax(scores);
    const final = shares[shares.length - 1];
    const dom = argmax(final);
    return {
      matrix, scores, shares, pay,
      winner: STRATEGIES[best],
      winnerScore: scores[best],
      dominant: STRATEGIES[dom],
      dominantShare: final[dom],
      tftVsAlld: pdPair("tft", "alld", rounds, pay, noise)[0],
      alldVsTft: pdPair("alld", "tft", rounds, pay, noise)[0],
      isDilemma: pdIsDilemma(pay),
    };
  }

  // ==========================================================================
  // Shared: binomial weights by recurrence
  // ==========================================================================
  /**
   * P(X = k) for k = 0..n, X ~ Binomial(n, p), by the standard recurrence
   *
   *     pmf(0)   = (1-p)^n
   *     pmf(k+1) = pmf(k) * (n-k)/(k+1) * p/(1-p)
   *
   * lab/analytics.py gets the same n+1 values from one vectorised numpy call
   * (binom.pmf over an array); there is no numpy here, so this is the
   * "vectorised" form JS gets instead -- one multiply per term rather than a
   * logGamma-based binomPmf call per term, which is what sdCycleGrowth and
   * insPoolGrowth both sum over. Stable for the n this project sweeps (at most
   * a few thousand): pmf(0) underflows to a hard 0 only once n exceeds ~1074
   * at p = 0.5, far past any control range on the page.
   */
  function binomWeights(n, p) {
    const w = new Float64Array(n + 1);
    if (p <= 0) { w[0] = 1; return w; }
    if (p >= 1) { w[n] = 1; return w; }
    const q = 1 - p, ratio = p / q;
    w[0] = Math.pow(q, n);
    for (let k = 0; k < n; k++) {
      w[k + 1] = Math.max(0, w[k] * ratio * (n - k) / (k + 1));
    }
    return w;
  }

  // ==========================================================================
  // Monty Hall -- mirrors lab/analytics.py section 5
  // ==========================================================================
  /** [N, k]: doors and opened doors, clamped so a door remains to switch to. */
  function mhBoard(doors, opened) {
    const n = Math.max(3, Math.round(doors));
    return [n, Math.min(Math.max(1, Math.round(opened)), n - 2)];
  }

  /** P(the host's k doors were all goats). Exact. */
  function mhGoatProb(doors, opened, know) {
    const [n, k] = mhBoard(doors, opened);
    const q = Math.min(Math.max(know, 0), 1);
    return q + (1 - q) * (n - k) / n;
  }

  /** P(switching wins AND only goats were revealed). Exact. */
  function mhSwitchJoint(doors, opened, know) {
    const [n, k] = mhBoard(doors, opened);
    const q = Math.min(Math.max(know, 0), 1);
    return (q * (n - 1)) / (n * (n - 1 - k)) + (1 - q) / n;
  }

  /** P(switching wins | only goats were revealed). Exact. */
  function mhSwitchProb(doors, opened, know) {
    return mhSwitchJoint(doors, opened, know) / mhGoatProb(doors, opened, know);
  }

  /** P(staying wins | only goats were revealed). Exact. */
  function mhStayProb(doors, opened, know) {
    const [n] = mhBoard(doors, opened);
    return (1 / n) / mhGoatProb(doors, opened, know);
  }

  function mhSummary(pr) {
    const { doors, opened, know } = pr;
    const [n, k] = mhBoard(doors, opened);
    const switchP = mhSwitchProb(doors, opened, know);
    const stayP = mhStayProb(doors, opened, know);
    return {
      doors: n, opened: k,
      switchProb: switchP, stayProb: stayP,
      advantage: switchP - stayP,
      ratio: stayP > 0 ? switchP / stayP : Infinity,
      goatProb: mhGoatProb(doors, opened, know),
      switchKnowing: mhSwitchProb(doors, opened, 1),
      switchRandom: mhSwitchProb(doors, opened, 0),
      switchUncond: mhSwitchJoint(doors, opened, know),
      stayUncond: 1 / n,
    };
  }

  /** (know values, switch prob, stay prob) over the host's-knowledge dial.
   *  Every point is one evaluation of mhSwitchProb / mhStayProb. */
  function mhKnowCurve(doors, opened, points) {
    const n = points || 101;
    const ks = new Array(n), switchP = new Array(n), stayP = new Array(n);
    for (let i = 0; i < n; i++) {
      const k = i / (n - 1);
      ks[i] = k;
      switchP[i] = mhSwitchProb(doors, opened, k);
      stayP[i] = mhStayProb(doors, opened, k);
    }
    return { ks, switchP, stayP };
  }

  /**
   * (doors, switch prob under a knowing host, switch prob under a random one)
   * for door counts from 3 to maxDoors, `opened` held fixed. The comparison the
   * scenario is actually about: the host's knowledge, not the door count.
   */
  function mhDoorsCurve(opened, maxDoors) {
    const top = Math.max(4, Math.round(maxDoors));
    const xs = [], knowing = [], random = [];
    for (let n = 3; n <= top; n++) {
      if (n - 2 < opened) continue;
      xs.push(n);
      knowing.push(mhSwitchProb(n, opened, 1));
      random.push(mhSwitchProb(n, opened, 0));
    }
    return { xs, knowing, random };
  }

  /**
   * Reference play-out, mirroring lab/analytics.py:simulate_monty exactly.
   *
   * Five draws every game, whether or not that game's outcome needs each one --
   * drawing conditionally would make the stream depend on the outcome, and the
   * seeded games could then only match the Python reference by branching
   * identically at every step, the same trap simulate_ruin documents.
   */
  function simulateMonty(pr) {
    const { games, doors, opened, know, seed } = pr;
    const [n, k] = mhBoard(doors, opened);
    const q = Math.min(Math.max(know, 0), 1);
    const pReveal = k / (n - 1);
    const pSwitch = 1 / (n - 1 - k);
    const rand = mulberry32(seed);
    let valid = 0, stayWins = 0, switchWins = 0;
    const first = [];
    for (let i = 0; i < games; i++) {
      const car = Math.floor(rand() * n);
      const pick = Math.floor(rand() * n);
      const knows = rand() < q;
      const rReveal = rand();
      const rSwitch = rand();
      const revealed = !knows && car !== pick && rReveal < pReveal;
      let stay = false, switchWin = false;
      if (!revealed) {
        valid++;
        stay = car === pick;
        switchWin = car !== pick && rSwitch < pSwitch;
        if (stay) stayWins++;
        if (switchWin) switchWins++;
      }
      if (i < 10) first.push([car, pick, stay ? 1 : 0, switchWin ? 1 : 0]);
    }
    return { valid, stayWins, switchWins, first };
  }

  // ==========================================================================
  // Shannon's demon -- mirrors lab/analytics.py section 6
  // ==========================================================================
  /** [up, down] for a symmetric multiplicative move, with down = 1/up. */
  function sdMoves(vol) {
    const v = Math.max(1e-9, vol);
    return [1 + v, 1 / (1 + v)];
  }

  /** E[ln m] for the stock alone. Zero at p = 0.5 by construction. */
  function sdStockGrowth(p, vol) {
    const [up, down] = sdMoves(vol);
    return p * Math.log(up) + (1 - p) * Math.log(down);
  }

  /** E[m] - 1 for the stock: positive even when the time-average growth above
   *  is zero. The gap between the two is the volatility drag the demon feeds
   *  on. */
  function sdStockDrift(p, vol) {
    const [up, down] = sdMoves(vol);
    return p * up + (1 - p) * down - 1;
  }

  /** ln(1 - w + w * exp(logR)), stable for large positive logR by factoring the
   *  exponent out first -- see lab/analytics.py:_log_mix for the same guard,
   *  vectorised there and evaluated once per binomial term here instead. */
  function logMix(w, logR) {
    if (logR > 0) return logR + Math.log(w + (1 - w) * Math.exp(-logR));
    return Math.log1p(-w + w * Math.exp(logR));
  }

  /**
   * Expected log growth per period, rebalancing every `interval` periods.
   *
   * Exact: a sum over the n+1 possible cycles, weighted by binomWeights rather
   * than by n+1 separate logGamma-based pmf calls -- see the comment on
   * binomWeights for why that is the point.
   */
  function sdCycleGrowth(interval, p, vol, w, cost) {
    const n = Math.max(1, Math.round(interval));
    const [up, down] = sdMoves(vol);
    const logUp = Math.log(up), logDown = Math.log(down);
    const weights = binomWeights(n, p);
    const doCost = cost > 0 && w > 0 && w < 1;
    let acc = 0;
    for (let j = 0; j <= n; j++) {
      const wt = weights[j];
      if (wt <= 0) continue;
      const logR = j * logUp + (n - j) * logDown;
      const logM = logMix(w, logR);
      let logC = 0;
      if (doCost) {
        const wAfter = Math.exp(Math.log(w) + logR - logM);
        logC = Math.log1p(-cost * Math.abs(wAfter - w));
      }
      acc += wt * (logM + logC);
    }
    return acc / n;
  }

  /** Buy and hold: the interval = horizon case of the same formula, so it is
   *  never charged a rebalancing cost. */
  function sdHoldGrowth(rounds, p, vol, w) {
    return sdCycleGrowth(Math.max(1, Math.round(rounds)), p, vol, w, 0);
  }

  /** Rebalanced growth minus buy-and-hold growth over the same horizon. */
  function sdHarvest(interval, rounds, p, vol, w, cost) {
    return sdCycleGrowth(interval, p, vol, w, cost) - sdHoldGrowth(rounds, p, vol, w);
  }

  /** (intervals, growth per period) for every rebalancing interval. Exact --
   *  a brute sweep because the objective is a binomial sum over a *discrete*
   *  cycle length, so there is nothing to differentiate and set to zero. */
  function sdIntervalCurve(rounds, p, vol, w, cost, maxInterval) {
    const top = Math.max(1, Math.round(maxInterval || rounds));
    const xs = new Array(top), gs = new Array(top);
    for (let n = 1; n <= top; n++) {
      xs[n - 1] = n;
      gs[n - 1] = sdCycleGrowth(n, p, vol, w, cost);
    }
    return [xs, gs];
  }

  /** [interval, growth] maximising growth per period. */
  function sdBestInterval(rounds, p, vol, w, cost) {
    const [xs, gs] = sdIntervalCurve(rounds, p, vol, w, cost);
    let best = 0;
    for (let i = 1; i < gs.length; i++) if (gs[i] > gs[best]) best = i;
    return [xs[best], gs[best]];
  }

  /**
   * APPROXIMATION -- the continuous-time rebalancing premium, w(1-w)sigma^2/2.
   *
   * NOT exact for the discrete binomial game this page simulates. It is the Ito
   * result for a continuously rebalanced portfolio of a driftless GBM and cash;
   * here sigma is taken as the per-period log move ln(1+vol), and the two agree
   * only to O(sigma^2). The exact discrete answer is
   * sdCycleGrowth(1, 0.5, vol, w, 0); lab/verify.py prints the gap between them
   * rather than asserting equality.
   * Mirrors lab/analytics.py:sd_harvest_continuous.
   */
  function sdHarvestContinuous(vol, w) {
    const sigma = Math.log1p(Math.max(1e-9, vol));
    return w * (1 - w) * sigma * sigma / 2;
  }

  /** The stock weight maximising growth. EXACT at interval = 1, where the
   *  per-period growth is term-for-term the coin's timeGrowth with f = w, so
   *  the maximiser is kellyFraction -- exactly 1/2 for the symmetric trendless
   *  stock. An approximation for interval > 1, where the optimum drifts with
   *  the cycle length. Mirrors lab/analytics.py:sd_optimal_weight. */
  function sdOptimalWeight(p, vol) {
    const [up, down] = sdMoves(vol);
    return kellyFraction(p, up, down);
  }

  function sdSummary(pr) {
    const { rounds, p, vol, w, interval, cost } = pr;
    const [up, down] = sdMoves(vol);
    const [bestN, bestG] = sdBestInterval(rounds, p, vol, w, cost);
    const rebal = sdCycleGrowth(interval, p, vol, w, cost);
    const hold = sdHoldGrowth(rounds, p, vol, w);
    return {
      up, down,
      stockGrowth: sdStockGrowth(p, vol),
      stockDrift: sdStockDrift(p, vol),
      rebalGrowth: rebal,
      holdGrowth: hold,
      harvest: rebal - hold,
      bestInterval: bestN,
      bestGrowth: bestG,
      // The weight that harvests most is the Kelly fraction for this coin --
      // exactly 1/2 for a symmetric trendless stock, Shannon's rule on the page.
      kellyW: kellyFraction(p, up, down),
      // APPROXIMATION -- the continuous-time identity, not the discrete game.
      harvestContinuous: sdHarvestContinuous(vol, w),
      // Exact at interval = 1; see sdOptimalWeight.
      optimalWeight: sdOptimalWeight(p, vol),
    };
  }

  /**
   * Reference play-out: the stock, buy-and-hold, and the rebalanced portfolio.
   *
   * One draw per period per path, matching lab/analytics.py:simulate_rebalance
   * so the seeded first path agrees bit for bit. All three series start at w0
   * so they can share one axis: the stock is drawn as a portfolio held 100%
   * long rather than as a bare price.
   */
  function simulateRebalance(pr) {
    const { nPaths, rounds, w0, p, vol, w, interval, cost, seed } = pr;
    const [up, down] = sdMoves(vol);
    const n = Math.max(1, Math.round(interval));
    const rand = mulberry32(seed);
    const stride = rounds + 1;
    const price = new Float64Array(stride);
    const hold = new Float64Array(stride);
    const rebal = new Float64Array(stride);
    const termHold = new Float64Array(nPaths);
    const termRebal = new Float64Array(nPaths);
    price[0] = hold[0] = rebal[0] = w0;

    for (let i = 0; i < nPaths; i++) {
      let px = w0;
      let hStock = w * w0, hCash = (1 - w) * w0;
      let rStock = w * w0, rCash = (1 - w) * w0;
      for (let t = 1; t <= rounds; t++) {
        const m = rand() < p ? up : down;
        px *= m; hStock *= m; rStock *= m;
        if (t % n === 0) {
          const total = rStock + rCash;
          const turnover = total > 0 ? Math.abs(rStock / total - w) : 0;
          const after = total * (1 - cost * turnover);
          rStock = w * after; rCash = (1 - w) * after;
        }
        if (i === 0) {
          price[t] = px; hold[t] = hStock + hCash; rebal[t] = rStock + rCash;
        }
      }
      termHold[i] = hStock + hCash;
      termRebal[i] = rStock + rCash;
    }
    return { price, hold, rebal, stride, nPaths, rounds, termHold, termRebal };
  }

  // ==========================================================================
  // Insurance and risk pooling -- mirrors lab/analytics.py section 7
  // ==========================================================================
  /** pi * ln(1 - L/W): the exposed player's growth rate per period. Exact. */
  function insUninsuredGrowth(wealth, loss, hazard) {
    const x = loss / wealth;
    if (x >= 1) return -Infinity;
    return hazard * Math.log1p(-x);
  }

  /** ln(1 - P/W): the insured player's growth rate per period. Exact and
   *  certain -- the premium is a number, not a distribution. */
  function insInsuredGrowth(wealth, premium) {
    if (premium >= wealth) return -Infinity;
    return Math.log1p(-premium / wealth);
  }

  /** The most the buyer can pay and still improve: W(1 - (1-L/W)^pi). Exact,
   *  and strictly above the expected payout pi*L for any 0 < pi < 1. */
  function insBuyerMaxPremium(wealth, loss, hazard) {
    const x = loss / wealth;
    if (x >= 1) return wealth;
    return wealth * (1 - Math.pow(1 - x, hazard));
  }

  /** The seller's growth rate per period from writing one contract. Exact. */
  function insSellerGrowth(sellerWealth, premium, loss, hazard) {
    if (sellerWealth + premium - loss <= 0) return -Infinity;
    return hazard * Math.log1p((premium - loss) / sellerWealth)
      + (1 - hazard) * Math.log1p(premium / sellerWealth);
  }

  /** The least the seller can accept: the root of insSellerGrowth = 0, found by
   *  bisection -- NOT a closed form. See lab/analytics.py:ins_seller_min_premium
   *  for why a bracket always exists. */
  function insSellerMinPremium(sellerWealth, loss, hazard, tol) {
    const t = tol === undefined ? 1e-12 : tol;
    let lo = Math.max(hazard * loss, loss - sellerWealth) + 1e-12;
    let hi = Math.max(lo * 2, loss);
    for (let i = 0; i < 200; i++) {
      if (insSellerGrowth(sellerWealth, hi, loss, hazard) > 0) break;
      hi *= 2;
    }
    for (let i = 0; i < 200; i++) {
      const mid = 0.5 * (lo + hi);
      if (insSellerGrowth(sellerWealth, mid, loss, hazard) > 0) hi = mid;
      else lo = mid;
      if (hi - lo <= t * Math.max(1, hi)) break;
    }
    return 0.5 * (lo + hi);
  }

  /** The buyer's gain in growth-equivalent dollars per period: W * dg. See
   *  lab/analytics.py:ins_buyer_value for why growth rates alone are not
   *  comparable across two parties of very different wealth. */
  function insBuyerValue(wealth, premium, loss, hazard) {
    return wealth * (insInsuredGrowth(wealth, premium)
      - insUninsuredGrowth(wealth, loss, hazard));
  }

  /** The seller's gain in the same growth-equivalent dollars per period. */
  function insSellerValue(sellerWealth, premium, loss, hazard) {
    return sellerWealth * insSellerGrowth(sellerWealth, premium, loss, hazard);
  }

  /** Growth rate of one member of a mutual pool of `members`. Exact -- the
   *  same binomWeights recurrence sdCycleGrowth uses, summed over the pool's
   *  loss count instead of over a rebalancing cycle's up/down count. */
  function insPoolGrowth(members, wealth, loss, hazard) {
    const n = Math.max(1, Math.round(members));
    const weights = binomWeights(n, hazard);
    const ratio = loss / wealth;
    let acc = 0;
    for (let k = 0; k <= n; k++) {
      const wt = weights[k];
      if (wt <= 0) continue;
      acc += wt * Math.log1p(-ratio * (k / n));
    }
    return acc;
  }

  /** ln(1 - pi L/W): the n -> infinity growth rate of an infinite pool. Exact,
   *  and an upper bound on every finite pool's growth rate. */
  function insPoolLimit(wealth, loss, hazard) {
    return Math.log1p((-hazard * loss) / wealth);
  }

  /** Smallest pool that beats buying insurance at `premium`: doubling to a
   *  bracket, then bisecting the integer -- never scanning, since each
   *  insPoolGrowth(n) call is itself an (n+1)-term sum. */
  function insPoolBreakEven(premium, wealth, loss, hazard, maxMembers) {
    const cap = maxMembers || 100000;
    const target = insInsuredGrowth(wealth, premium);
    if (insPoolGrowth(1, wealth, loss, hazard) >= target) return 1;
    let hi = 2;
    while (hi <= cap) {
      if (insPoolGrowth(hi, wealth, loss, hazard) >= target) break;
      hi *= 2;
    }
    if (hi > cap) return null;
    let lo = Math.floor(hi / 2);
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (insPoolGrowth(mid, wealth, loss, hazard) >= target) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  function insSummary(pr) {
    const { wealth, sellerWealth, premium, loss, hazard, members } = pr;
    const pMin = insSellerMinPremium(sellerWealth, loss, hazard);
    const pMax = insBuyerMaxPremium(wealth, loss, hazard);
    return {
      expectedPayout: hazard * loss,
      buyerMax: pMax, sellerMin: pMin,
      bandOk: pMin < pMax, bandWidth: pMax - pMin,
      uninsuredGrowth: insUninsuredGrowth(wealth, loss, hazard),
      insuredGrowth: insInsuredGrowth(wealth, premium),
      sellerGrowth: insSellerGrowth(sellerWealth, premium, loss, hazard),
      buyerValue: insBuyerValue(wealth, premium, loss, hazard),
      sellerValue: insSellerValue(sellerWealth, premium, loss, hazard),
      poolGrowth: insPoolGrowth(members, wealth, loss, hazard),
      poolLimit: insPoolLimit(wealth, loss, hazard),
      poolBreakEven: insPoolBreakEven(premium, wealth, loss, hazard),
    };
  }

  /** (premiums, buyer value, seller value), swept over a premium range. Exact
   *  -- every point is one evaluation of insBuyerValue / insSellerValue, sized
   *  around the band so its crossing sits inside the axis. */
  function insPremiumCurve(pr, points) {
    const { wealth, sellerWealth, loss, hazard } = pr;
    const n = points || 160;
    const pMax = insBuyerMaxPremium(wealth, loss, hazard);
    const pMin = insSellerMinPremium(sellerWealth, loss, hazard);
    const hi = Math.min(wealth * 0.95, Math.max(pMax, pMin) * 2.2);
    const xs = new Array(n), buyer = new Array(n), seller = new Array(n);
    for (let i = 0; i < n; i++) {
      const x = (hi * i) / (n - 1);
      xs[i] = x;
      buyer[i] = insBuyerValue(wealth, x, loss, hazard);
      seller[i] = insSellerValue(sellerWealth, x, loss, hazard);
    }
    return { xs, buyer, seller };
  }

  /** (sizes, growth), one point per pool size from 1 to maxMembers. Exact, and
   *  not log-spaced -- the curve is steepest at the smallest sizes. */
  function insPoolCurve(pr, maxMembers) {
    const { wealth, loss, hazard } = pr;
    const top = maxMembers || 200;
    const sizes = new Array(top), growth = new Array(top);
    for (let n = 1; n <= top; n++) {
      sizes[n - 1] = n;
      growth[n - 1] = insPoolGrowth(n, wealth, loss, hazard);
    }
    return { sizes, growth };
  }

  // ==========================================================================
  // The wheel strategy -- mirrors lab/analytics.py section 8
  // ==========================================================================
  // No closed form for the strategy itself -- see the section note in
  // analytics.py. What is exact: Black-Scholes prices, the real-world (not
  // risk-neutral) probability a single option finishes ITM, and buy-and-hold's
  // terminal distribution. Everything else is a seeded simulation.
  //
  // Phi and its inverse are approximated here (Abramowitz-Stegun 7.1.26 and
  // Acklam's algorithm), not computed exactly the way scipy.stats.norm does in
  // Python. That is a TOLERANCE-matched contract with analytics.py, not the
  // bit-exact one mulberry32 and the normal generator below are -- 1e-6 is the
  // bar tests.html holds this pair to, and both approximations clear it with
  // room to spare (worst-case absolute error ~1.5e-7 for Phi itself).

  const TRADING_DAYS = 252;
  const TRADING_DAYS_PER_MONTH = 21;

  /** Standard normal CDF, via the Abramowitz-Stegun rational approximation of
   *  erf (max absolute error ~1.5e-7). */
  function normCdf(x) {
    const z = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * z);
    const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 +
      t * (-1.453152027 + t * 1.061405429))));
    const erf = 1 - poly * Math.exp(-z * z);
    return 0.5 * (1 + (x < 0 ? -erf : erf));
  }

  /** Standard normal quantile, via Acklam's rational approximation (~2.6e-9
   *  relative error). Used only for buy-and-hold's closed-form quantiles --
   *  nothing path-dependent needs an inverse CDF. */
  function normPpf(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    const a = [-3.969683028665376e+01, 2.209460984245205e+02,
      -2.759285104469687e+02, 1.383577518672690e+02,
      -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02,
      -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01,
      -2.400758277161838e+00, -2.549732539343734e+00,
      4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01,
      2.445134137142996e+00, 3.754408661907416e+00];
    const plow = 0.02425, phigh = 1 - plow;
    if (p < plow) {
      const q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
             ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p <= phigh) {
      const q = p - 0.5, r = q * q;
      return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
             (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    }
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  /** Black-Scholes d1 and d2. Exact, given the model's own assumptions.
   *  d2 = d1 - sigma*sqrt(t) is the same expression real-world ITM
   *  probability reuses with mu in place of r -- see realWorldItmProb. */
  function bsD1D2(s, k, t, sigma, r, q) {
    r = r || 0; q = q || 0;
    if (t <= 0 || sigma <= 0) {
      const d = s > k ? Infinity : (s < k ? -Infinity : 0);
      return [d, d];
    }
    const vt = sigma * Math.sqrt(t);
    const d1 = (Math.log(s / k) + (r - q + 0.5 * sigma * sigma) * t) / vt;
    return [d1, d1 - vt];
  }

  /** Black-Scholes European call. Exact under the model's own assumptions. */
  function bsCallPrice(s, k, t, sigma, r, q) {
    r = r || 0; q = q || 0;
    if (t <= 0) return Math.max(s - k, 0);
    const [d1, d2] = bsD1D2(s, k, t, sigma, r, q);
    return s * Math.exp(-q * t) * normCdf(d1) - k * Math.exp(-r * t) * normCdf(d2);
  }

  /** Black-Scholes European put, from the same d1/d2 the call uses. */
  function bsPutPrice(s, k, t, sigma, r, q) {
    r = r || 0; q = q || 0;
    if (t <= 0) return Math.max(k - s, 0);
    const [d1, d2] = bsD1D2(s, k, t, sigma, r, q);
    return k * Math.exp(-r * t) * normCdf(-d2) - s * Math.exp(-q * t) * normCdf(-d1);
  }

  /** P(a single option finishes ITM) under the physical measure (drift mu),
   *  not the risk-neutral one (rate r) Black-Scholes prices with. Exact. */
  function realWorldItmProb(s, k, t, sigma, mu, q, call) {
    mu = mu || 0; q = q || 0;
    if (t <= 0) return (s > k) === call ? 1 : 0;
    const [, d2] = bsD1D2(s, k, t, sigma, mu, q);
    return call ? normCdf(d2) : normCdf(-d2);
  }

  /** E[ln(S_T/S_0)] / T: buy-and-hold's time-average growth rate. Exact. */
  function holdGrowthRate(mu, sigma, q) {
    return mu - (q || 0) - 0.5 * sigma * sigma;
  }

  /** Exact terminal-wealth statistics for buy-and-hold under GBM. Nothing
   *  here is simulated -- contrast with the wheel, where nothing is exact. */
  function holdSummary(pr) {
    const { w0, mu, sigma, q, years } = pr;
    const g = holdGrowthRate(mu, sigma, q);
    const vt = sigma * Math.sqrt(Math.max(years, 0));
    return {
      growthRate: g,
      expectedFinal: w0 * Math.exp((mu - (q || 0)) * years),
      medianFinal: w0 * Math.exp(g * years),
      pBelowStart: vt > 0 ? normCdf(-(g * years) / vt) : (g < 0 ? 1 : 0),
      q05: w0 * Math.exp(g * years + vt * normPpf(0.05)),
      q95: w0 * Math.exp(g * years + vt * normPpf(0.95)),
    };
  }

  /** Standard-normal draws from the shared mulberry32 uniform stream, via
   *  Box-Muller. The second of each pair is cached and returned on the next
   *  call rather than discarded -- lab/analytics.py:make_normal_generator
   *  caches in the same slot, which is what lets a seeded path agree beyond
   *  its first draw. */
  function makeNormalGenerator(seed) {
    const rand = mulberry32(seed);
    let spare = null;
    return function randn() {
      if (spare !== null) {
        const z = spare;
        spare = null;
        return z;
      }
      const u1 = rand(), u2 = rand();
      const r = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-300)));
      const theta = 2 * Math.PI * u2;
      spare = r * Math.sin(theta);
      return r * Math.cos(theta);
    };
  }

  /** One daily-close price path under GBM. Not exact -- the shared randomness
   *  every arm of the scenario is compared on, drawn once and read by all
   *  four rather than once per arm. */
  function simulateGbmPath(pr) {
    // sigmaRv, not the generic "sigma" bsD1D2 and friends use -- this path is
    // always drawn at the REALIZED vol; sigmaIv only prices the options
    // written against it, in simulateWheel.
    const { s0, mu, sigmaRv, q, years, seed } = pr;
    const randn = makeNormalGenerator(seed);
    const dt = 1 / TRADING_DAYS;
    const n = Math.max(1, Math.round(years * TRADING_DAYS));
    const drift = (mu - (q || 0) - 0.5 * sigmaRv * sigmaRv) * dt;
    const vol = sigmaRv * Math.sqrt(dt);
    const path = new Float64Array(n + 1);
    path[0] = s0;
    let s = s0;
    for (let i = 1; i <= n; i++) {
      s *= Math.exp(drift + vol * randn());
      path[i] = s;
    }
    return path;
  }

  /** Buy the dip, sell at the next all-time high, repeat. No options -- the
   *  options-free twin of the wheel's own entry/exit signal, continuous
   *  rather than lot-quantized on purpose (see the scenario's story). Not
   *  exact -- the entry/exit rule is path-dependent, same as the wheel's. */
  function simulateDipStrategy(path, pr) {
    const { xMonths, dipPct, stockFeePct, r, w0 } = pr;
    const n = path.length - 1;
    const window = Math.max(1, Math.round(xMonths * TRADING_DAYS_PER_MONTH));
    const dt = 1 / TRADING_DAYS;
    let cash = w0, shares = 0, ath = path[0], dipArmed = true;
    const equity = new Float64Array(n + 1);
    equity[0] = w0;
    for (let t = 1; t <= n; t++) {
      const s = path[t];
      cash *= Math.exp(r * dt);
      let hi = -Infinity;
      for (let i = Math.max(0, t - window); i <= t; i++) if (path[i] > hi) hi = path[i];
      const dipLevel = hi * (1 - dipPct);
      if (s > dipLevel) dipArmed = true;
      if (s > ath) ath = s;
      if (shares === 0) {
        if (dipArmed && s <= dipLevel) {
          shares = (cash / (1 + stockFeePct)) / s;
          cash = 0;
          dipArmed = false;
        }
      } else if (s >= ath) {
        cash = shares * s * (1 - stockFeePct);
        shares = 0;
      }
      equity[t] = cash + shares * s;
    }
    return equity;
  }

  /** The wheel, or with includeCalls=false the puts-only arm. Tuned to
   *  maximise time holding the stock: any idle cash sells a cash-secured put
   *  whether or not shares are already held, a stub too small for a contract
   *  buys stock outright, and covered calls are written only at a *record*
   *  high -- a new maximum of the whole path so far, which is by construction
   *  above every price that ever bought shares.
   *
   *  Mirrors analytics.py:simulate_wheel. See that docstring for the two rule
   *  sets this replaced and why each destroyed most of the return: gating put
   *  re-entry on a dip left the S&P arm flat 95% of 2009-2026, and writing the
   *  call the moment the shares arrived struck 100% of calls at the cost basis
   *  (assignment happens with spot BELOW the strike that bought them, so
   *  max(spot, basis) collapses to basis and being called away realises zero). */
  function simulateWheel(path, pr, includeCalls) {
    const { xMonths, yMonths, dipPct, sellHaircut, shareSl, callTp,
            sigmaIv, r, q, stockFeePct, optFee, w0 } = pr;
    const n = path.length - 1;
    const dt = 1 / TRADING_DAYS;
    const putTenor = Math.max(1, Math.round(xMonths * TRADING_DAYS_PER_MONTH));
    const callTenor = Math.max(1, Math.round(yMonths * TRADING_DAYS_PER_MONTH));

    let cash = w0, collateral = 0, shares = 0, basis = 0;
    let putLot = null, callLot = null;
    let recordHigh = path[0];

    const equity = new Float64Array(n + 1);
    equity[0] = w0;
    const events = [];
    const stats = { putsSold: 0, putsExpired: 0, assignments: 0,
      callsSold: 0, callsTp: 0, callsExpired: 0, calledAway: 0,
      callsClosedOnStop: 0, sharesStopped: 0, sharesBought: 0,
      putsStillOpen: 0, callsStillOpen: 0 };

    /** Fold a new lot into the share-weighted average cost basis. */
    const addShares = (qty, price) => {
      basis = (basis * shares + price * qty) / (shares + qty);
      shares += qty;
    };

    for (let t = 1; t <= n; t++) {
      const s = path[t];
      const g = Math.exp(r * dt);
      cash = cash * g + collateral * (g - 1);

      // A *record* high: the running maximum of the whole path so far, not a
      // rolling window. The only moment a covered call is written.
      const atRecord = s >= recordHigh;
      if (atRecord) recordHigh = s;

      // -- the put, held to expiry ---------------------------------------
      if (putLot !== null && t >= putLot.expiry) {
        const face = putLot.contracts * 100 * putLot.strike;
        collateral -= face;
        if (s < putLot.strike) {
          cash -= face * stockFeePct;
          addShares(putLot.contracts * 100, putLot.strike);
          stats.assignments += putLot.contracts;
          events.push({ t, kind: "assigned", contracts: putLot.contracts,
            strike: putLot.strike });
        } else {
          cash += face;
          stats.putsExpired += putLot.contracts;
          events.push({ t, kind: "put_expired", contracts: putLot.contracts,
            strike: putLot.strike });
        }
        putLot = null;
      }

      // -- any idle cash sells a put, long or flat ------------------------
      if (putLot === null) {
        const strike = s;
        const nNew = Math.floor(cash / (100 * strike));
        if (nNew > 0) {
          const theo = bsPutPrice(s, strike, putTenor / TRADING_DAYS, sigmaIv, r, q);
          const premium = theo * (1 - sellHaircut);
          cash -= nNew * 100 * strike;
          collateral += nNew * 100 * strike;
          cash += nNew * (100 * premium - optFee);
          putLot = { contracts: nNew, premium, strike, expiry: t + putTenor };
          stats.putsSold += nNew;
          events.push({ t, kind: "sell_put", contracts: nNew, strike });
        }
      }

      // -- the stub that can never sell a contract buys stock outright ----
      const odd = Math.floor(cash / (s * (1 + stockFeePct)));
      if (odd > 0) {
        cash -= odd * s * (1 + stockFeePct);
        addShares(odd, s);
        stats.sharesBought += odd;
        events.push({ t, kind: "buy_shares", contracts: odd, strike: s });
      }

      // -- the share stop, the strategy's only loss cap ------------------
      if (shares > 0 && s < basis * (1 - shareSl)) {
        if (callLot !== null) {
          const texp = Math.max(callLot.expiry - t, 0) / TRADING_DAYS;
          const theo = texp > 0
            ? bsCallPrice(s, callLot.strike, texp, sigmaIv, r, q)
            : Math.max(s - callLot.strike, 0);
          cash -= callLot.contracts * (100 * theo + optFee);
          stats.callsClosedOnStop += callLot.contracts;
          events.push({ t, kind: "close_call_on_stop",
            contracts: callLot.contracts, strike: callLot.strike });
          callLot = null;
        }
        cash += shares * s * (1 - stockFeePct);
        events.push({ t, kind: "stop_shares", contracts: Math.floor(shares / 100),
          strike: basis });
        shares = 0; basis = 0;
        stats.sharesStopped += 1;
      }

      // -- covered calls, only while long --------------------------------
      if (shares > 0 && includeCalls) {
        if (callLot !== null) {
          const texp = Math.max(callLot.expiry - t, 0) / TRADING_DAYS;
          const theo = texp > 0
            ? bsCallPrice(s, callLot.strike, texp, sigmaIv, r, q)
            : Math.max(s - callLot.strike, 0);
          if (t >= callLot.expiry) {
            if (s > callLot.strike) {
              cash += callLot.contracts * 100 * callLot.strike * (1 - stockFeePct);
              shares -= callLot.contracts * 100;
              stats.calledAway += callLot.contracts;
              events.push({ t, kind: "called_away", contracts: callLot.contracts,
                strike: callLot.strike });
              if (shares === 0) basis = 0;
            } else {
              stats.callsExpired += callLot.contracts;
              events.push({ t, kind: "call_expired", contracts: callLot.contracts,
                strike: callLot.strike });
            }
            callLot = null;
          } else if ((callLot.premium - theo) / callLot.premium >= callTp) {
            cash -= callLot.contracts * (100 * theo + optFee);
            stats.callsTp += callLot.contracts;
            events.push({ t, kind: "close_call", contracts: callLot.contracts,
              strike: callLot.strike });
            callLot = null;
          }
        }

        // Only at a record high, and never below the basis. At a record high
        // the second condition is already implied -- it is kept as a live
        // assertion of the invariant the whole rule exists to create.
        if (callLot === null && shares >= 100 && atRecord && s > basis) {
          const nNew = Math.floor(shares / 100);
          const strike = Math.max(s, basis);
          const theo = bsCallPrice(s, strike, callTenor / TRADING_DAYS, sigmaIv, r, q);
          const premium = theo * (1 - sellHaircut);
          cash += nNew * (100 * premium - optFee);
          callLot = { contracts: nNew, premium, strike, expiry: t + callTenor };
          stats.callsSold += nNew;
          events.push({ t, kind: "sell_call", contracts: nNew, strike });
        }
      }

      equity[t] = cash + collateral + shares * s;
    }

    if (putLot !== null) stats.putsStillOpen = putLot.contracts;
    if (callLot !== null) stats.callsStillOpen = callLot.contracts;

    return { equity, events, stats };
  }

  function simulateWheelFamily(pr) {
    const path = pr.realPath || simulateGbmPath(pr);
    const wheel = simulateWheel(path, pr, true);
    const putsOnly = simulateWheel(path, pr, false);
    const dip = simulateDipStrategy(path, pr);
    const holdShares = (pr.w0 / (1 + pr.stockFeePct)) / path[0];
    const hold = new Float64Array(path.length);
    for (let i = 0; i < path.length; i++) hold[i] = holdShares * path[i];
    return { path, wheel, putsOnly, dip, hold };
  }

  /** Annualized log return: ln(final/initial)/years -- the metric every arm's
   *  equity curve is reduced to, since a fixed horizon otherwise favours
   *  whichever arm happened to be fully invested for more of it. */
  function cagr(final, initial, years) {
    if (final <= 0 || initial <= 0 || years <= 0) return -Infinity;
    return Math.log(final / initial) / years;
  }

  /** Everything the wheel scenario's tiles and table need: the exact
   *  single-contract anchors, buy-and-hold's exact distribution, and this
   *  one seed's simulated outcome for all four arms. */
  function wheelSummary(pr) {
    const fam = simulateWheelFamily(pr);
    // holdSummary's own parameter is named "sigma" (it stands alone; see the
    // G.hold golden cases), so the wheel's sigmaRv is mapped in explicitly
    // rather than handed over inside a same-named pr object that has no
    // "sigma" key at all.
    const hold = holdSummary({ w0: pr.w0, mu: pr.mu, sigma: pr.sigmaRv,
      q: pr.q, years: pr.years });
    const strike0 = pr.s0 * (1 - pr.dipPct);
    const putProbNaive = realWorldItmProb(strike0, strike0, pr.xMonths / 12,
      pr.sigmaRv, pr.mu, pr.q, false);
    const callProbNaive = realWorldItmProb(pr.s0, pr.s0, pr.yMonths / 12,
      pr.sigmaRv, pr.mu, pr.q, true);
    const ws = fam.wheel.stats;
    const assignedRate = ws.assignments / Math.max(1, ws.putsSold);
    const last = (arr) => arr[arr.length - 1];
    return {
      wheelFinal: last(fam.wheel.equity),
      putsOnlyFinal: last(fam.putsOnly.equity),
      dipFinal: last(fam.dip),
      holdFinalSample: last(fam.hold),
      holdFinalExact: hold.expectedFinal,
      holdMedianExact: hold.medianFinal,
      wheelCagr: cagr(last(fam.wheel.equity), pr.w0, pr.years),
      putsOnlyCagr: cagr(last(fam.putsOnly.equity), pr.w0, pr.years),
      dipCagr: cagr(last(fam.dip), pr.w0, pr.years),
      holdCagrSample: cagr(last(fam.hold), pr.w0, pr.years),
      holdCagrExact: hold.growthRate,
      putNaiveAssignProb: putProbNaive,
      // Renamed from callNaiveCalledawayProb: nothing is ever called away
      // now, so this is just the chance the call finishes in the money and
      // has to be bought back.
      callNaiveItmProb: callProbNaive,
      simAssignRate: assignedRate,
      putsSold: ws.putsSold,
      putsExpired: ws.putsExpired,
      assignments: ws.assignments,
      callsSold: ws.callsSold,
      callsTp: ws.callsTp,
      calledAway: ws.calledAway,
      callsClosedOnStop: ws.callsClosedOnStop,
      sharesStopped: ws.sharesStopped,
      callsExpired: ws.callsExpired,
    };
  }

  /** Wheel CAGR against sigmaIv - sigmaRv, averaged over nSeeds paths per
   *  point. Explicitly a Monte Carlo sweep, not a closed form -- see
   *  lab/analytics.py:wheel_iv_sweep for why no exact version exists. */
  function wheelIvSweep(pr) {
    const { points, nSeeds, spreadLo, spreadHi, baseSeed, sigmaRv } = pr;
    const xs = [], gs = [];
    for (let i = 0; i < points; i++) {
      const spread = spreadLo + (spreadHi - spreadLo) * i / Math.max(1, points - 1);
      const sigmaIv = Math.max(0.01, sigmaRv + spread);
      let total = 0;
      for (let j = 0; j < nSeeds; j++) {
        const fam = simulateWheelFamily(Object.assign({}, pr, {
          sigmaIv, seed: baseSeed + i * nSeeds + j,
        }));
        total += cagr(fam.wheel.equity[fam.wheel.equity.length - 1], pr.w0, pr.years);
      }
      xs.push(spread);
      gs.push(total / nSeeds);
    }
    return { xs, gs };
  }

  // ==========================================================================
  // Parrondo's paradox -- mirrors lab/analytics.py section 9
  // ==========================================================================
  /** Game A: a flat, slightly unfavourable coin. P(win) = 1/2 - eps. */
  const paWinProbA = (eps) => 0.5 - eps;

  /** Game B: P(win) depends on capital mod 3 -- bad at residue 0, good
   *  otherwise, both shifted down by eps so neither game gets an unfair edge
   *  relative to the other. */
  const paWinProbB = (residue, eps, pBad, pGood) =>
    (((residue % 3) + 3) % 3 === 0 ? pBad : pGood) - eps;

  /** P(win this round), mixing game B in with probability q each round. */
  const paEffectiveWinProb = (residue, q, eps, pBad, pGood) =>
    (1 - q) * paWinProbA(eps) + q * paWinProbB(residue, eps, pBad, pGood);

  /** 3x3 transition matrix over capital mod 3, for the mixed strategy. */
  function paTransition(q, eps, pBad, pGood) {
    const P = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let r = 0; r < 3; r++) {
      const p = paEffectiveWinProb(r, q, eps, pBad, pGood);
      P[r][(r + 1) % 3] += p;
      P[r][(r + 2) % 3] += 1 - p; // (r - 1) mod 3
    }
    return P;
  }

  /**
   * The stationary distribution over capital mod 3. Exact: solves a 3x3
   * linear system (pi P = pi, sum pi = 1) by Cramer's rule rather than
   * iterating power steps -- no numpy.linalg here, but a 3x3 solve has a
   * short enough closed form to just write out.
   */
  function paStationary(q, eps, pBad, pGood) {
    const P = paTransition(q, eps, pBad, pGood);
    // (P^T - I) pi = 0, replace the (dependent) last row with sum(pi) = 1.
    const M = [
      [P[0][0] - 1, P[1][0], P[2][0]],
      [P[0][1], P[1][1] - 1, P[2][1]],
      [1, 1, 1],
    ];
    const b = [0, 0, 1];
    const det = (m) =>
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const d = det(M);
    const withCol = (col) => M.map((row, i) => row.map((v, j) => (j === col ? b[i] : v)));
    return [0, 1, 2].map((col) => det(withCol(col)) / d);
  }

  /** E[capital change per round] under the mixed strategy. Exact. */
  function paDrift(q, eps, pBad, pGood) {
    const pi = paStationary(q, eps, pBad, pGood);
    let drift = 0;
    for (let r = 0; r < 3; r++) {
      const p = paEffectiveWinProb(r, q, eps, pBad, pGood);
      drift += pi[r] * (2 * p - 1);
    }
    return drift;
  }

  /** (q values, drift) swept over the mixing probability. Exact. */
  function paDriftCurve(eps, pBad, pGood, points) {
    const n = points || 101;
    const qs = new Array(n), drifts = new Array(n);
    for (let i = 0; i < n; i++) {
      const q = i / (n - 1);
      qs[i] = q;
      drifts[i] = paDrift(q, eps, pBad, pGood);
    }
    return [qs, drifts];
  }

  function paSummary(pr) {
    const { q, eps, pBad, pGood } = pr;
    const driftA = paDrift(0, eps, pBad, pGood);
    const driftB = paDrift(1, eps, pBad, pGood);
    const driftMix = paDrift(q, eps, pBad, pGood);
    const [qs, drifts] = paDriftCurve(eps, pBad, pGood, 101);
    let best = 0;
    for (let i = 1; i < drifts.length; i++) if (drifts[i] > drifts[best]) best = i;
    return {
      driftA, driftB, driftMix,
      bestQ: qs[best], bestDrift: drifts[best],
      paradox: driftA < 0 && driftB < 0 && drifts[best] > 0,
    };
  }

  /**
   * Reference walk: three series sharing draw order every round -- game A
   * alone, game B alone, and the q-mixed strategy -- mirroring
   * lab/analytics.py:simulate_parrondo exactly, including its five
   * unconditional draws per round.
   */
  function simulateParrondo(pr) {
    const { nPaths, rounds, q, eps, pBad, pGood, w0, seed } = pr;
    const rand = mulberry32(seed);
    const pathsA = [], pathsB = [], pathsMix = [];
    for (let i = 0; i < nPaths; i++) {
      let xa = w0, xb = w0, xm = w0;
      const pa = [xa], pb = [xb], pm = [xm];
      for (let t = 0; t < rounds; t++) {
        const ra = rand(), rb = rand(), rchoice = rand(), raMix = rand(), rbMix = rand();
        xa += ra < paWinProbA(eps) ? 1 : -1;
        xb += rb < paWinProbB(xb, eps, pBad, pGood) ? 1 : -1;
        if (rchoice < q) {
          xm += rbMix < paWinProbB(xm, eps, pBad, pGood) ? 1 : -1;
        } else {
          xm += raMix < paWinProbA(eps) ? 1 : -1;
        }
        pa.push(xa); pb.push(xb); pm.push(xm);
      }
      pathsA.push(pa); pathsB.push(pb); pathsMix.push(pm);
    }
    return { pathsA, pathsB, pathsMix };
  }

  // ==========================================================================
  // Base rates -- mirrors lab/analytics.py section 10
  // ==========================================================================
  /** P(disease | positive test). Exact, by Bayes' theorem. */
  function brPosteriorPositive(prior, sens, spec) {
    const tp = sens * prior, fp = (1 - spec) * (1 - prior);
    return tp + fp > 0 ? tp / (tp + fp) : 0;
  }

  /** P(disease | negative test). Exact -- the reassuring number. */
  function brPosteriorNegative(prior, sens, spec) {
    const fn = (1 - sens) * prior, tn = spec * (1 - prior);
    return fn + tn > 0 ? fn / (fn + tn) : 0;
  }

  /** (TP, FP, FN, TN) among `population` people. Exact. */
  function brCounts(prior, sens, spec, population) {
    const n = population;
    return [
      n * prior * sens, n * (1 - prior) * (1 - spec),
      n * prior * (1 - sens), n * (1 - prior) * spec,
    ];
  }

  /** (prevalences, posterior P(disease|positive)) log-spaced from lo to hi. */
  function brPrevalenceCurve(sens, spec, points, lo, hi) {
    const n = points || 200;
    const logLo = Math.log10(lo || 1e-4), logHi = Math.log10(hi || 0.5);
    const xs = new Array(n), ys = new Array(n);
    for (let i = 0; i < n; i++) {
      const x = Math.pow(10, logLo + (logHi - logLo) * i / (n - 1));
      xs[i] = x;
      ys[i] = brPosteriorPositive(x, sens, spec);
    }
    return [xs, ys];
  }

  function brSummary(pr) {
    const { prior, sens, spec, population } = pr;
    const [tp, fp, fn, tn] = brCounts(prior, sens, spec, population);
    return {
      posteriorPos: brPosteriorPositive(prior, sens, spec),
      posteriorNeg: brPosteriorNegative(prior, sens, spec),
      tp, fp, fn, tn,
      positives: tp + fp,
      precision: tp + fp > 0 ? tp / (tp + fp) : 0,
    };
  }

  // ==========================================================================
  // The birthday problem -- mirrors lab/analytics.py section 11
  // ==========================================================================
  /** ln P(no collision), exact via a sum of n log1p terms -- only the ratios
   *  i/days are ever computed, so `days` can be an astronomically large
   *  digest space without ever needing to exist as an ordinary number. */
  function bdLogNoCollision(n, days) {
    n = Math.round(n);
    if (n <= 0) return 0;
    let total = 0;
    for (let i = 0; i < n; i++) total += Math.log1p(-i / days);
    return total;
  }

  /** P(at least one shared birthday among n people, `days` days a year).
   *  Exact; n > days is the pigeonhole certainty. */
  function bdCollisionProb(n, days) {
    if (n > days) return 1;
    return 1 - Math.exp(bdLogNoCollision(n, days));
  }

  /** C(n, 2): how many pairs n people make. Exact. */
  const bdPairs = (n) => (n * (n - 1)) / 2;

  /** (n, P(collision)) for every group size from 1 to maxN. Exact. */
  function bdCollisionCurve(days, maxN) {
    const n = Math.round(maxN);
    const xs = new Array(n), ys = new Array(n);
    for (let i = 1; i <= n; i++) { xs[i - 1] = i; ys[i - 1] = bdCollisionProb(i, days); }
    return [xs, ys];
  }

  /** Smallest n with P(collision) >= 0.5. Exact, scanning up from n=1. */
  function bdHalfLifeN(days) {
    let n = 1;
    const cap = Math.round(days) + 1;
    while (bdCollisionProb(n, days) < 0.5) {
      n++;
      if (n > cap) return n;
    }
    return n;
  }

  /** APPROXIMATION: n for 50% collision odds at a `bits`-bit digest -- see
   *  lab/analytics.py:bd_hash_n50_approx for the derivation. Exact
   *  enumeration is infeasible once bits exceeds ~40; this closed form gets
   *  more accurate, not less, as bits grows. */
  function bdHashN50Approx(bits) {
    const days = Math.pow(2, bits);
    return Math.sqrt(2 * days * Math.log(2));
  }

  /** (bits, approximate n for 50% collision odds) over a digest length. */
  function bdHashBitsCurve(minBits, maxBits, points) {
    const n = points || 57;
    const xs = new Array(n), ys = new Array(n);
    for (let i = 0; i < n; i++) {
      const b = minBits + (maxBits - minBits) * i / (n - 1);
      xs[i] = b;
      ys[i] = bdHashN50Approx(b);
    }
    return [xs, ys];
  }

  function bdSummary(pr) {
    const { n, days, bits } = pr;
    return {
      collisionProb: bdCollisionProb(n, days),
      pairs: bdPairs(n),
      halfLifeN: bdHalfLifeN(days),
      hashN50: bdHashN50Approx(bits),
    };
  }

  // ==========================================================================
  // The secretary problem -- mirrors lab/analytics.py section 12
  // ==========================================================================
  /** P(the classic secretary strategy picks the single best candidate).
   *  Exact -- see lab/analytics.py:sec_win_prob for the derivation. */
  function secWinProb(s, n) {
    s = Math.round(s); n = Math.round(n);
    if (n <= 0) return 0;
    if (s <= 0) return 1 / n;
    if (s >= n) return 0;
    let sum = 0;
    for (let i = s + 1; i <= n; i++) sum += 1 / (i - 1);
    return (s / n) * sum;
  }

  /**
   * (thresholds, win prob) for every skip count from 0 to n-1. Exact and
   * vectorised the same way as the Python side: a single reversed running
   * sum of 1/j gives every suffix sum sec_win_prob needs, so the whole curve
   * is O(n) instead of O(n^2).
   */
  function secWinCurve(n) {
    n = Math.round(n);
    if (n <= 0) return [[], []];
    if (n === 1) return [[0], [1]];
    // suffix[j-1] = sum_{m=j}^{n-1} 1/m: walk j down from n-1, accumulating
    // AFTER storing so each slot holds the sum from itself to the top.
    const suffix = new Float64Array(n);
    let acc = 0;
    for (let j = n - 1; j >= 1; j--) {
      acc += 1 / j;
      suffix[j - 1] = acc;
    }
    const xs = new Array(n), ys = new Array(n);
    xs[0] = 0; ys[0] = 1 / n;
    for (let s = 1; s < n; s++) {
      xs[s] = s;
      ys[s] = (s / n) * suffix[s - 1];
    }
    return [xs, ys];
  }

  /** (best threshold, best win prob). Exact -- argmax over secWinCurve. */
  function secOptimal(n) {
    const [xs, ys] = secWinCurve(n);
    let best = 0;
    for (let i = 1; i < ys.length; i++) if (ys[i] > ys[best]) best = i;
    return [xs[best], ys[best]];
  }

  /** (n, optimal win prob) over a range of n, showing convergence to 1/e. */
  function secAsymptoticCurve(minN, maxN, points) {
    const n = points || 100;
    const seen = new Set();
    const ns = [];
    for (let i = 0; i < n; i++) {
      const v = Math.round(minN + (maxN - minN) * i / Math.max(1, n - 1));
      if (!seen.has(v)) { seen.add(v); ns.push(v); }
    }
    ns.sort((a, b) => a - b);
    return [ns, ns.map((v) => secOptimal(v)[1])];
  }

  function secSummary(pr) {
    const { s, n } = pr;
    const [bestS, bestP] = secOptimal(n);
    return {
      winProb: secWinProb(s, n),
      bestS, bestProb: bestP,
      bestFraction: n > 0 ? bestS / n : 0,
      invE: 1 / Math.E,
    };
  }

  // ==========================================================================
  // The two-envelope paradox -- mirrors lab/analytics.py section 13
  // ==========================================================================
  /** P(x is the smaller half | observed x), Exponential(rate) prior. Exact --
   *  see lab/analytics.py:te_p_smaller for the Jacobian factor of 1/2 this
   *  needs (X = 2S is a change of variables, not a plain density lookup). */
  function tePSmaller(x, rate) {
    if (x <= 0) return 1;
    const u = Math.exp((rate * x) / 2);
    return 1 / (1 + 0.5 * u);
  }

  /** E[gain from swapping | observed x]. Exact -- see
   *  lab/analytics.py:te_swap_gain for the derivation. */
  function teSwapGain(x, rate) {
    if (x <= 0) return 0;
    const pSmall = tePSmaller(x, rate);
    return pSmall * x - (1 - pSmall) * (x / 2);
  }

  /** The amount above which swapping stops being worth it. Exact -- solves
   *  p_smaller of the crossover = 1/3, which for this prior reduces to
   *  exp(rate * crossover / 2) = 4. */
  const teCrossover = (rate) => (4 * Math.log(2)) / rate;

  /** (x values, expected swap gain, P(smaller|x)) swept over the amount
   *  found. Exact at every point. */
  function teGainCurve(rate, points, hi) {
    const n = points || 200;
    const top = hi || 6 / rate;
    const xs = new Array(n), gains = new Array(n), probs = new Array(n);
    for (let i = 0; i < n; i++) {
      const x = (top * i) / (n - 1);
      xs[i] = x;
      gains[i] = teSwapGain(x, rate);
      probs[i] = tePSmaller(x, rate);
    }
    return [xs, gains, probs];
  }

  function teSummary(pr) {
    const { x, rate } = pr;
    return {
      pSmaller: tePSmaller(x, rate),
      swapGain: teSwapGain(x, rate),
      crossover: teCrossover(rate),
      meanSmaller: 1 / rate,
      shouldSwap: teSwapGain(x, rate) > 0,
    };
  }

  // ==========================================================================
  // Optional stopping -- mirrors lab/analytics.py section 14
  // ==========================================================================
  /** Two-sided z critical value for a nominal per-look significance level.
   *  Exact enough for this purpose via the same normPpf the wheel scenario
   *  uses -- see engine.js's normPpf docstring for its own error bound. */
  const osZThreshold = (alpha) => normPpf(1 - alpha / 2);

  /**
   * (look number, cumulative P(declared significant by this look)). Exact
   * forward DP -- see lab/analytics.py:os_false_positive_curve for the full
   * derivation. `live` holds P(heads=h AND never yet crossed the boundary)
   * after each batch; binomWeights(batch, 0.5) is the fresh-batch kernel
   * convolved in at every look, and whatever now sits outside the moving
   * boundary is peeled into the cumulative total and zeroed so it cannot
   * un-happen on a calmer later batch.
   */
  function osFalsePositiveCurve(looks, batch, alpha) {
    looks = Math.round(looks); batch = Math.round(batch);
    const z = osZThreshold(alpha);
    const kernel = binomWeights(batch, 0.5);
    let live = new Float64Array([1]);
    let cumFp = 0;
    const xs = new Array(looks), ys = new Array(looks);
    for (let look = 1; look <= looks; look++) {
      const next = new Float64Array(live.length + kernel.length - 1);
      for (let i = 0; i < live.length; i++) {
        if (live[i] === 0) continue;
        for (let j = 0; j < kernel.length; j++) next[i + j] += live[i] * kernel[j];
      }
      const n = look * batch;
      const boundary = z * Math.sqrt(n);
      let newlySig = 0;
      for (let h = 0; h < next.length; h++) {
        const s = 2 * h - n;
        if (Math.abs(s) >= boundary) { newlySig += next[h]; next[h] = 0; }
      }
      cumFp += newlySig;
      live = next;
      xs[look - 1] = look;
      ys[look - 1] = cumFp;
    }
    return [xs, ys];
  }

  /** P(declared significant at least once in `looks` looks). Exact. */
  function osFalsePositiveRate(looks, batch, alpha) {
    const [, ys] = osFalsePositiveCurve(looks, batch, alpha);
    return ys.length ? ys[ys.length - 1] : 0;
  }

  /** The per-look alpha that keeps the cumulative rate at nominal, to first
   *  order -- a conservative Bonferroni bound, exact as such. */
  const osBonferroniAlpha = (looks, alpha) => alpha / Math.max(1, Math.round(looks));

  /**
   * Reference walk: each path is looks*batch fair +-1 steps, sampled at every
   * look boundary, mirroring lab/analytics.py:simulate_optional_stopping so
   * the seeded z-statistics agree exactly.
   */
  function simulateOptionalStopping(pr) {
    const { nPaths, looks, batch, alpha, seed } = pr;
    const z = osZThreshold(alpha);
    const rand = mulberry32(seed);
    const n = looks * batch;
    const allZ = [], firstSig = [];
    for (let p = 0; p < nPaths; p++) {
      let s = 0;
      const zs = [];
      let sigAt = null;
      for (let step = 1; step <= n; step++) {
        s += rand() < 0.5 ? 1 : -1;
        if (step % batch === 0) {
          const look = step / batch;
          zs.push(s / Math.sqrt(step));
          if (sigAt === null && Math.abs(s) >= z * Math.sqrt(step)) sigAt = look;
        }
      }
      allZ.push(zs);
      firstSig.push(sigAt);
    }
    return { allZ, firstSig };
  }

  function osSummary(pr) {
    const { looks, batch, alpha } = pr;
    const [, ys] = osFalsePositiveCurve(looks, batch, alpha);
    return {
      cumFp: ys.length ? ys[ys.length - 1] : 0,
      nominalAlpha: alpha,
      bonferroniAlpha: osBonferroniAlpha(looks, alpha),
      totalN: looks * batch,
      zCrit: osZThreshold(alpha),
    };
  }

  // ==========================================================================
  // Simpson's paradox -- mirrors lab/analytics.py section 15
  // ==========================================================================
  /** [A-easy, A-hard, B-easy, B-hard] success rates. Exact: A carries the
   *  same true advantage `delta` in both subgroups. */
  function simpsonsSubgroupRates(pEasy, pHard, delta) {
    return [pEasy + delta, pHard + delta, pEasy, pHard];
  }

  /** [pooled A, pooled B]. Exact -- each subgroup pair averaged with that
   *  treatment's own case mix, which is the step that loses the information. */
  function simpsonsPooledRates(pEasy, pHard, delta, wA, wB) {
    const [ae, ah, be, bh] = simpsonsSubgroupRates(pEasy, pHard, delta);
    return [wA * ae + (1 - wA) * ah, wB * be + (1 - wB) * bh];
  }

  /** The true effect size at which the pooled comparison flips. Exact:
   *  (w_b - w_a) * (p_easy - p_hard) -- the allocation gap times the
   *  difficulty gap, independent of delta itself. */
  const simpsonsDeltaCritical = (pEasy, pHard, wA, wB) =>
    (wB - wA) * (pEasy - pHard);

  /** pooled_A - pooled_B. Exact, and equal to delta - deltaCritical. */
  function simpsonsPooledDiff(pEasy, pHard, delta, wA, wB) {
    const [pa, pb] = simpsonsPooledRates(pEasy, pHard, delta, wA, wB);
    return pa - pb;
  }

  /** True when the subgroup verdict (sign of delta) and the pooled verdict
   *  (sign of delta - deltaCritical) disagree. Exact. */
  function simpsonsReverses(pEasy, pHard, delta, wA, wB) {
    const diff = simpsonsPooledDiff(pEasy, pHard, delta, wA, wB);
    return (delta > 0 && diff < 0) || (delta < 0 && diff > 0);
  }

  /** floor(x + 0.5) -- the same half-up convention lab/analytics.py uses, so
   *  a 50/50 split of an even group size rounds the same way on both sides. */
  const roundHalfUp = (x) => Math.floor(x + 0.5);

  /**
   * The 2x2x2 table of whole-case counts behind the rates.
   *
   * Every total is a SUM of its own parts, never an independent rounding of
   * the corresponding product -- `hardA` is `nA - easyA`, `succA` is
   * `succEasyA + succHardA`. Rounding each cell separately is what makes a
   * table whose parts sum to one more than its whole.
   */
  function simpsonsCounts(pEasy, pHard, delta, wA, wB, nA, nB) {
    const [ae, ah, be, bh] = simpsonsSubgroupRates(pEasy, pHard, delta);
    nA = Math.round(nA); nB = Math.round(nB);
    const clamp = (v, hi) => Math.min(hi, Math.max(0, v));

    const easyA = clamp(roundHalfUp(wA * nA), nA);
    const hardA = nA - easyA;
    const easyB = clamp(roundHalfUp(wB * nB), nB);
    const hardB = nB - easyB;

    const seA = clamp(roundHalfUp(ae * easyA), easyA);
    const shA = clamp(roundHalfUp(ah * hardA), hardA);
    const seB = clamp(roundHalfUp(be * easyB), easyB);
    const shB = clamp(roundHalfUp(bh * hardB), hardB);

    return {
      easyA, hardA, nA, easyB, hardB, nB,
      succEasyA: seA, succHardA: shA, succA: seA + shA,
      succEasyB: seB, succHardB: shB, succB: seB + shB,
      rateEasyA: easyA ? seA / easyA : 0,
      rateHardA: hardA ? shA / hardA : 0,
      rateEasyB: easyB ? seB / easyB : 0,
      rateHardB: hardB ? shB / hardB : 0,
      rateA: nA ? (seA + shA) / nA : 0,
      rateB: nB ? (seB + shB) / nB : 0,
    };
  }

  /** [delta values, pooled_A - pooled_B] over the true effect size. Exact --
   *  a line of slope 1 crossing zero at deltaCritical. */
  function simpsonsDeltaCurve(pEasy, pHard, wA, wB, points, lo, hi) {
    const n = points || 101;
    const crit = simpsonsDeltaCritical(pEasy, pHard, wA, wB);
    const loV = lo === undefined || lo === null ? 0 : lo;
    const hiV = hi === undefined || hi === null ? Math.max(2 * crit, 0.1) : hi;
    const xs = new Array(n), ys = new Array(n);
    for (let i = 0; i < n; i++) {
      const d = loV + (hiV - loV) * i / (n - 1);
      xs[i] = d;
      ys[i] = simpsonsPooledDiff(pEasy, pHard, d, wA, wB);
    }
    return [xs, ys];
  }

  function simpsonsSummary(pr) {
    const { pEasy, pHard, delta, wA, wB, nA, nB } = pr;
    const [ae, ah, be, bh] = simpsonsSubgroupRates(pEasy, pHard, delta);
    const [pooledA, pooledB] = simpsonsPooledRates(pEasy, pHard, delta, wA, wB);
    return {
      rateEasyA: ae, rateHardA: ah, rateEasyB: be, rateHardB: bh,
      pooledA, pooledB,
      subgroupDiff: delta,
      pooledDiff: pooledA - pooledB,
      deltaCritical: simpsonsDeltaCritical(pEasy, pHard, wA, wB),
      reverses: simpsonsReverses(pEasy, pHard, delta, wA, wB),
      allocationGap: wB - wA,
      difficultyGap: pEasy - pHard,
      counts: simpsonsCounts(pEasy, pHard, delta, wA, wB, nA, nB),
    };
  }

  // ==========================================================================
  // Bertrand's paradox -- mirrors lab/analytics.py section 16
  // ==========================================================================
  // c = L / (2R) is the target length as a fraction of the diameter, and
  // u = d / R the chord midpoint's scaled distance from the centre. A chord
  // is longer than L exactly when u < sqrt(1 - c^2), so every method's answer
  // is its own CDF of u at that one threshold. See the Python section for the
  // three derivations.
  const BERTRAND_METHODS = ["endpoints", "radius", "midpoint"];

  /** sqrt(1 - c^2): the largest u at which a chord still clears the target
   *  length. Exact. */
  function bertrandThreshold(c) {
    const cc = Math.min(Math.max(c, 0), 1);
    return Math.sqrt(Math.max(0, 1 - cc * cc));
  }

  /** 2R sqrt(1 - u^2): the length of a chord with midpoint at u = d/R. */
  const bertrandChordLength = (u, radius) =>
    2 * radius * Math.sqrt(Math.max(0, 1 - u * u));

  /** P(u <= t), random endpoints. Exact: (2/pi) arcsin t. */
  const bertrandCdfEndpoints = (t) =>
    (2 / Math.PI) * Math.asin(Math.min(Math.max(t, 0), 1));

  /** P(u <= t), random radius. Exact: t. */
  const bertrandCdfRadius = (t) => Math.min(Math.max(t, 0), 1);

  /** P(u <= t), random midpoint. Exact: t^2, the area ratio. */
  function bertrandCdfMidpoint(t) {
    const tt = Math.min(Math.max(t, 0), 1);
    return tt * tt;
  }

  /** P(u <= t) under `method`. Exact. */
  function bertrandMidpointCdf(method, t) {
    if (method === "endpoints") return bertrandCdfEndpoints(t);
    if (method === "radius") return bertrandCdfRadius(t);
    if (method === "midpoint") return bertrandCdfMidpoint(t);
    throw new Error("unknown method: " + method);
  }

  /** Both endpoints uniform on the circumference. Exact:
   *  1 - (2/pi) arcsin c. Equals 1/3 at c = sqrt(3)/2. */
  const bertrandProbEndpoints = (c) =>
    1 - (2 / Math.PI) * Math.asin(Math.min(Math.max(c, 0), 1));

  /** Midpoint uniform along a uniformly chosen radius. Exact: sqrt(1 - c^2).
   *  Equals 1/2 at c = sqrt(3)/2. */
  function bertrandProbRadius(c) {
    const cc = Math.min(Math.max(c, 0), 1);
    return Math.sqrt(Math.max(0, 1 - cc * cc));
  }

  /** Midpoint uniform over the disc. Exact: 1 - c^2. Equals 1/4 at
   *  c = sqrt(3)/2. */
  function bertrandProbMidpoint(c) {
    const cc = Math.min(Math.max(c, 0), 1);
    return 1 - cc * cc;
  }

  /** P(chord longer than 2Rc) under `method`. Exact. */
  function bertrandProb(method, c) {
    if (method === "endpoints") return bertrandProbEndpoints(c);
    if (method === "radius") return bertrandProbRadius(c);
    if (method === "midpoint") return bertrandProbMidpoint(c);
    throw new Error("unknown method: " + method);
  }

  /** E[chord length] under `method`. Exact: 4R/pi, pi R / 2, 4R/3 -- the
   *  three rules disagree about the average chord as well as the tail. */
  function bertrandMeanLength(method, radius) {
    if (method === "endpoints") return 4 * radius / Math.PI;
    if (method === "radius") return Math.PI * radius / 2;
    if (method === "midpoint") return 4 * radius / 3;
    throw new Error("unknown method: " + method);
  }

  /** [ts, endpoints CDF, radius CDF, midpoint CDF] over u in [0,1]. Exact. */
  function bertrandCdfCurve(points) {
    const n = points || 101;
    const ts = new Array(n), e = new Array(n), r = new Array(n), m = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      ts[i] = t;
      e[i] = bertrandCdfEndpoints(t);
      r[i] = bertrandCdfRadius(t);
      m[i] = bertrandCdfMidpoint(t);
    }
    return [ts, e, r, m];
  }

  /** [cs, P_endpoints, P_radius, P_midpoint] swept over the threshold ratio.
   *  Exact. The radius rule is the largest answer throughout (0,1), but the
   *  other two cross at exactly c = 1/sqrt(2), where both equal 1/2, so there
   *  is no fixed ranking of the three -- see lab/analytics.py section 16. */
  function bertrandCCurve(points) {
    const n = points || 101;
    const cs = new Array(n), e = new Array(n), r = new Array(n), m = new Array(n);
    for (let i = 0; i < n; i++) {
      const c = i / (n - 1);
      cs[i] = c;
      e[i] = bertrandProbEndpoints(c);
      r[i] = bertrandProbRadius(c);
      m[i] = bertrandProbMidpoint(c);
    }
    return [cs, e, r, m];
  }

  /**
   * Seeded chords under one sampling rule. Mirrors
   * lab/analytics.py:bertrand_sample, including the draw order -- exactly two
   * uniforms per chord:
   *
   *   endpoints  u1 -> first endpoint's angle,  u2 -> second endpoint's angle
   *   radius     u1 -> the radius's direction,  u2 -> distance along it
   *   midpoint   u1 -> squared radial position, u2 -> the midpoint's angle
   *
   * `midpoint` takes sqrt(u1) -- the disc-uniform inverse CDF. Drawing the
   * distance uniformly instead is precisely the `radius` rule, which is the
   * paradox in one line of code.
   */
  function bertrandSample(method, n, radius, c, seed) {
    const rand = mulberry32(seed);
    const thresh = bertrandThreshold(c);
    const out = new Array(Math.round(n));
    for (let i = 0; i < out.length; i++) {
      const u1 = rand(), u2 = rand();
      let x1, y1, x2, y2, mx, my, u;
      if (method === "endpoints") {
        const a1 = 2 * Math.PI * u1, a2 = 2 * Math.PI * u2;
        x1 = radius * Math.cos(a1); y1 = radius * Math.sin(a1);
        x2 = radius * Math.cos(a2); y2 = radius * Math.sin(a2);
        mx = 0.5 * (x1 + x2); my = 0.5 * (y1 + y2);
        u = Math.hypot(mx, my) / radius;
      } else {
        let phi;
        if (method === "radius") { phi = 2 * Math.PI * u1; u = u2; }
        else if (method === "midpoint") { u = Math.sqrt(u1); phi = 2 * Math.PI * u2; }
        else throw new Error("unknown method: " + method);
        mx = radius * u * Math.cos(phi);
        my = radius * u * Math.sin(phi);
        // The chord through this midpoint is perpendicular to the radius.
        const half = radius * Math.sqrt(Math.max(0, 1 - u * u));
        const dx = -Math.sin(phi), dy = Math.cos(phi);
        x1 = mx + half * dx; y1 = my + half * dy;
        x2 = mx - half * dx; y2 = my - half * dy;
      }
      out[i] = {
        x1, y1, x2, y2, mx, my, u,
        length: bertrandChordLength(u, radius),
        long: u < thresh,
      };
    }
    return out;
  }

  /** One seeded sample per method, each from its own fresh stream at `seed`,
   *  so changing one method's size leaves the other two clouds untouched. */
  function bertrandSampleAll(pr) {
    const { n, radius, c, seed } = pr;
    const out = {};
    for (const m of BERTRAND_METHODS) out[m] = bertrandSample(m, n, radius, c, seed);
    return out;
  }

  /** The seeded sample's own fraction of long chords. Simulated, not exact. */
  function bertrandEmpirical(method, n, radius, c, seed) {
    const chords = bertrandSample(method, n, radius, c, seed);
    if (!chords.length) return 0;
    let k = 0;
    for (const ch of chords) if (ch.long) k++;
    return k / chords.length;
  }

  function bertrandSummary(pr) {
    const { c, radius, n, seed } = pr;
    const pE = bertrandProbEndpoints(c);
    const pR = bertrandProbRadius(c);
    const pM = bertrandProbMidpoint(c);
    return {
      c,
      length: 2 * radius * c,
      threshold: bertrandThreshold(c),
      pEndpoints: pE, pRadius: pR, pMidpoint: pM,
      spread: Math.max(pE, pR, pM) - Math.min(pE, pR, pM),
      meanLenEndpoints: bertrandMeanLength("endpoints", radius),
      meanLenRadius: bertrandMeanLength("radius", radius),
      meanLenMidpoint: bertrandMeanLength("midpoint", radius),
      empEndpoints: bertrandEmpirical("endpoints", n, radius, c, seed),
      empRadius: bertrandEmpirical("radius", n, radius, c, seed),
      empMidpoint: bertrandEmpirical("midpoint", n, radius, c, seed),
      classicC: Math.sqrt(3) / 2,
      isClassic: Math.abs(c - Math.sqrt(3) / 2) < 1e-12,
    };
  }

  Object.assign(EP, {
    mulberry32,
    binomPmf, binomCdf, binomPpf, binomWeights,
    multipliers, ensembleGrowth, timeGrowth, expectedFinal,
    medianFinal, quantileFinal, probBelow, kellyFraction, sigmaLog, summary,
    arithmeticMeanMultiplier, geometricMeanMultiplier, volatilityDrag,
    medianHalfLife, breakEvenHeads, kellyGrowth, zeroGrowthFraction,
    doublingTime,
    simulatePaths, pathStats, walkStats, logHistogram, kellySweep,
    SAMPLE_PATHS,
    // gambler's ruin
    bets, ruinUnits, ruinProbUnits, ruinProb, reachTargetProb,
    ruinProbUnbounded, ruinDurationUnits, ruinDuration, ruinSummary,
    ruinCurve, ruinBetCurve, simulateRuin,
    // St Petersburg
    spExpected, spQuantile, spMedian, spSurvival, spTierContribution,
    spCapAmount, spCappedExpected, spTypicalMean, spSummary,
    spLogUtility, spCertaintyEquivalent,
    simulateStPetersburg, logSpacedIndices,
    // prisoner's dilemma
    STRATEGIES, STRATEGY_LABELS, STRATEGY_NOTES, pdPayoffs, pdIsDilemma,
    pdPair, pdMatrix, pdTournament, pdReplicator, pdSummary,
    // Monty Hall
    mhBoard, mhGoatProb, mhSwitchJoint, mhSwitchProb, mhStayProb, mhSummary,
    mhKnowCurve, mhDoorsCurve, simulateMonty,
    // Shannon's demon
    sdMoves, sdStockGrowth, sdStockDrift, sdCycleGrowth, sdHoldGrowth,
    sdHarvest, sdIntervalCurve, sdBestInterval, sdSummary, simulateRebalance,
    sdHarvestContinuous, sdOptimalWeight,
    // insurance and risk pooling
    insUninsuredGrowth, insInsuredGrowth, insBuyerMaxPremium, insSellerGrowth,
    insSellerMinPremium, insBuyerValue, insSellerValue, insPoolGrowth,
    insPoolLimit, insPoolBreakEven, insSummary, insPremiumCurve, insPoolCurve,
    // the wheel strategy
    normCdf, normPpf, bsD1D2, bsCallPrice, bsPutPrice, realWorldItmProb,
    holdGrowthRate, holdSummary, makeNormalGenerator, simulateGbmPath,
    simulateDipStrategy, simulateWheel, simulateWheelFamily, cagr,
    wheelSummary, wheelIvSweep,
    // Parrondo's paradox
    paWinProbA, paWinProbB, paEffectiveWinProb, paTransition, paStationary,
    paDrift, paDriftCurve, paSummary, simulateParrondo,
    // base rates
    brPosteriorPositive, brPosteriorNegative, brCounts, brPrevalenceCurve,
    brSummary,
    // the birthday problem
    bdLogNoCollision, bdCollisionProb, bdPairs, bdCollisionCurve, bdHalfLifeN,
    bdHashN50Approx, bdHashBitsCurve, bdSummary,
    // the secretary problem
    secWinProb, secWinCurve, secOptimal, secAsymptoticCurve, secSummary,
    // the two-envelope paradox
    tePSmaller, teSwapGain, teCrossover, teGainCurve, teSummary,
    // optional stopping
    osZThreshold, osFalsePositiveCurve, osFalsePositiveRate, osBonferroniAlpha,
    simulateOptionalStopping, osSummary,
    // Simpson's paradox
    simpsonsSubgroupRates, simpsonsPooledRates, simpsonsDeltaCritical,
    simpsonsPooledDiff, simpsonsReverses, simpsonsCounts, simpsonsDeltaCurve,
    simpsonsSummary,
    // Bertrand's paradox
    BERTRAND_METHODS, bertrandThreshold, bertrandChordLength,
    bertrandCdfEndpoints, bertrandCdfRadius, bertrandCdfMidpoint,
    bertrandMidpointCdf, bertrandProbEndpoints, bertrandProbRadius,
    bertrandProbMidpoint, bertrandProb, bertrandMeanLength, bertrandCdfCurve,
    bertrandCCurve, bertrandSample, bertrandSampleAll, bertrandEmpirical,
    bertrandSummary,
  });
})(window.EP);
