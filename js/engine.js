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
  /**
   * Simulate `nPaths` wealth trajectories.
   *
   * Returns flat Float64Arrays (nPaths x (rounds+1)) rather than nested arrays:
   * at 2000 paths x 500 rounds that is a million numbers, and the flat layout
   * keeps it a single allocation.
   */
  function simulatePaths(pr) {
    const { w0, rounds, p, up, down, f, nPaths, seed } = pr;
    const [mu, md] = multipliers(up, down, f);
    const rand = mulberry32(seed);
    const stride = rounds + 1;
    const paths = new Float64Array(nPaths * stride);
    const terminal = new Float64Array(nPaths);

    for (let i = 0; i < nPaths; i++) {
      const base = i * stride;
      let w = w0;
      paths[base] = w;
      for (let t = 1; t <= rounds; t++) {
        w *= rand() < p ? mu : md;
        paths[base + t] = w;
      }
      terminal[i] = w;
    }
    return { paths, terminal, stride, nPaths, rounds };
  }

  /** Empirical quantile (linear interpolation) of an already-sorted array. */
  function quantileSorted(sorted, q) {
    const n = sorted.length;
    if (!n) return NaN;
    const pos = (n - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
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

  function pathStats(sim) {
    const { paths, stride, nPaths } = sim;
    const out = {
      mean: new Float64Array(stride),
      q05: new Float64Array(stride),
      q25: new Float64Array(stride),
      median: new Float64Array(stride),
      q75: new Float64Array(stride),
      q95: new Float64Array(stride),
    };
    const keys = ["q05", "q25", "median", "q75", "q95"];
    const col = new Float64Array(nPaths);

    for (let t = 0; t < stride; t++) {
      let acc = 0;
      for (let i = 0; i < nPaths; i++) {
        const v = paths[i * stride + t];
        col[i] = v;
        acc += v;
      }
      out.mean[t] = acc / nPaths;
      // Sorted in place -- `col` is scratch, and TypedArray.sort() with no
      // comparator is already numeric-ascending (and much faster than passing
      // one). The caller's `paths` buffer is untouched.
      col.sort();
      for (let k = 0; k < keys.length; k++) {
        out[keys[k]][t] = quantileSorted(col, BAND_Q[k]);
      }
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

  Object.assign(EP, {
    mulberry32,
    binomPmf, binomCdf, binomPpf,
    multipliers, ensembleGrowth, timeGrowth, expectedFinal,
    medianFinal, quantileFinal, probBelow, kellyFraction, sigmaLog, summary,
    simulatePaths, pathStats, logHistogram, kellySweep, quantileSorted,
  });
})(window.EP);
