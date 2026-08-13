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
    if (a <= 0 || b <= 0) return NaN;
    const f = (p * a - q * b) / (a * b);
    return Math.max(0, Math.min(f, 1 / b - 1e-12));
  }

  function sigmaLog(p, up, down, f) {
    const [mu, md] = multipliers(up, down, f);
    if (mu <= 0 || md <= 0) return Infinity;
    return Math.sqrt(p * (1 - p)) * Math.abs(Math.log(mu) - Math.log(md));
  }

  /** Everything the stat tiles and table view need. */
  function summary(pr) {
    const { w0, rounds, p, up, down, f } = pr;
    return {
      ensembleGrowth: ensembleGrowth(p, up, down, f),
      timeGrowth: timeGrowth(p, up, down, f),
      expectedFinal: expectedFinal(w0, rounds, p, up, down, f),
      medianFinal: medianFinal(w0, rounds, p, up, down, f),
      pBelowStart: probBelow(w0, w0, rounds, p, up, down, f),
      pBelowOne: probBelow(1, w0, rounds, p, up, down, f),
      q05: quantileFinal(0.05, w0, rounds, p, up, down, f),
      q95: quantileFinal(0.95, w0, rounds, p, up, down, f),
      kellyF: kellyFraction(p, up, down),
      sigmaLog: sigmaLog(p, up, down, f),
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

  function ruinSummary(pr) {
    const { bankroll, target, p, bet } = pr;
    const [k, n] = ruinUnits(bankroll, target, bet);
    return {
      k, n,
      ruinProb: ruinProb(bankroll, target, p, bet),
      reachProb: reachTargetProb(bankroll, target, p, bet),
      duration: ruinDuration(bankroll, target, p, bet),
      ruinUnbounded: ruinProbUnbounded(bankroll, p, bet),
      fairRuinProb: ruinProb(bankroll, target, 0.5, bet),
      edge: 2 * p - 1,
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

  /** APPROXIMATION -- see the docstring in lab/analytics.py:sp_typical_mean. */
  function spTypicalMean(plays, p, m) {
    if (plays < 1 || p <= 0 || p >= 1) return spCappedExpected(p, m, 1);
    const L = Math.floor(Math.log(plays) / Math.log(1 / p)) + 1;
    return spCappedExpected(p, m, Math.max(1, L));
  }

  function spSummary(pr) {
    const { p, m, tiers, plays } = pr;
    return {
      expected: spExpected(p, m),
      median: spMedian(p, m),
      q95: spQuantile(0.95, p, m),
      capped: spCappedExpected(p, m, tiers),
      capAmount: spCapAmount(m, tiers),
      typicalMean: spTypicalMean(plays, p, m),
      divergent: m * p >= 1,
      mp: m * p,
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

  Object.assign(EP, {
    mulberry32,
    binomPmf, binomCdf, binomPpf, binomWeights,
    multipliers, ensembleGrowth, timeGrowth, expectedFinal,
    medianFinal, quantileFinal, probBelow, kellyFraction, sigmaLog, summary,
    simulatePaths, pathStats, walkStats, logHistogram, kellySweep,
    SAMPLE_PATHS,
    // gambler's ruin
    bets, ruinUnits, ruinProbUnits, ruinProb, reachTargetProb,
    ruinProbUnbounded, ruinDurationUnits, ruinDuration, ruinSummary,
    ruinCurve, ruinBetCurve, simulateRuin,
    // St Petersburg
    spExpected, spQuantile, spMedian, spSurvival, spTierContribution,
    spCapAmount, spCappedExpected, spTypicalMean, spSummary,
    simulateStPetersburg, logSpacedIndices,
    // prisoner's dilemma
    STRATEGIES, STRATEGY_LABELS, STRATEGY_NOTES, pdPayoffs, pdIsDilemma,
    pdPair, pdMatrix, pdTournament, pdReplicator, pdSummary,
    // Monty Hall
    mhBoard, mhGoatProb, mhSwitchJoint, mhSwitchProb, mhStayProb, mhSummary,
    simulateMonty,
    // Shannon's demon
    sdMoves, sdStockGrowth, sdStockDrift, sdCycleGrowth, sdHoldGrowth,
    sdHarvest, sdIntervalCurve, sdBestInterval, sdSummary, simulateRebalance,
    // insurance and risk pooling
    insUninsuredGrowth, insInsuredGrowth, insBuyerMaxPremium, insSellerGrowth,
    insSellerMinPremium, insBuyerValue, insSellerValue, insPoolGrowth,
    insPoolLimit, insPoolBreakEven, insSummary, insPremiumCurve, insPoolCurve,
  });
})(window.EP);
