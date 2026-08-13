/* Plotly wrappers.
 *
 * Colors are never hardcoded here -- every one is read from the CSS custom
 * properties defined in index.html, so light/dark is one stylesheet swap and
 * the charts follow. Mark specs (2px lines, >=8px markers, hairline solid
 * gridlines, 2px surface gaps) follow the dataviz reference.
 */
window.EP = window.EP || {};

(function (EP) {
  "use strict";

  /** Wealth floor for the log axis. Below a cent, a player is broke. */
  const FLOOR = 0.01;
  /** Individual paths drawn on top of the quantile fan.
   *
   *  Deliberately small. Every round multiplies wealth by one of two constants,
   *  so in log space the paths live on a binomial lattice; drawing hundreds of
   *  them produces a diamond moire that reads as decorative texture and hides
   *  the distribution. A few paths answer "what does one player experience?"
   *  and the bands answer "where is everybody?". */
  const SAMPLE_PATHS = 8;

  /** Read the live theme values off the document. */
  function theme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return {
      surface: v("--surface-1"),
      textPrimary: v("--text-primary"),
      textSecondary: v("--text-secondary"),
      muted: v("--muted"),
      grid: v("--gridline"),
      axis: v("--baseline"),
      s1: v("--series-1"),
      s2: v("--series-2"),
      s3: v("--series-3"),
      neg: v("--diverging-neg"),
      deemph: v("--deemphasis"),
      cloud: v("--cloud"),
    };
  }

  const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

  /** Layout shared by every chart: recessive chrome, generous padding. */
  function baseLayout(t, over) {
    return Object.assign({
      paper_bgcolor: t.surface,
      plot_bgcolor: t.surface,
      font: { family: FONT, size: 12, color: t.textSecondary },
      margin: { l: 64, r: 24, t: 16, b: 52 },
      hoverlabel: {
        bgcolor: t.surface,
        bordercolor: t.axis,
        font: { family: FONT, size: 12, color: t.textPrimary },
      },
      showlegend: false,
      dragmode: false,
    }, over || {});
  }

  /** Axis defaults: solid hairline grid one step off the surface, never dashed. */
  function axis(t, over) {
    return Object.assign({
      showgrid: true,
      gridcolor: t.grid,
      gridwidth: 1,
      zeroline: false,
      linecolor: t.axis,
      linewidth: 1,
      ticks: "outside",
      ticklen: 4,
      tickcolor: t.axis,
      tickfont: { color: t.muted, size: 11 },
      automargin: true,
    }, over || {});
  }

  const CONFIG = { displayModeBar: false, responsive: true, doubleClick: false };

  const clampFloor = (v) => (v > FLOOR ? v : FLOOR);

  // -- trajectory (spaghetti) ------------------------------------------------
  /**
   * Log-scale wealth trajectories: a de-emphasised cloud of individual players
   * with the median and the ensemble mean drawn over it.
   *
   * The cloud is one Plotly trace with null separators between paths rather than
   * one trace per path -- 300 traces would make the chart unusable.
   */
  function trajectory(el, sim, stats, pr) {
    const t = theme();
    const { paths, stride, nPaths, rounds } = sim;
    const drawn = Math.min(nPaths, SAMPLE_PATHS);

    const xs = Array.from({ length: stride }, (_, k) => k);
    const band = (arr) => Array.from(arr, clampFloor);
    const median = band(stats.median);
    const mean = band(stats.mean);

    // Band pairs are drawn lower-then-upper so the upper trace can fill down to
    // the one before it. Wider band first, so the narrower sits on top of it.
    const bandTrace = (arr, fill) => ({
      x: xs, y: band(arr), type: "scatter", mode: "lines",
      line: { color: "rgba(0,0,0,0)", width: 0 },
      fill: fill ? "tonexty" : undefined,
      fillcolor: fill || undefined,
      hoverinfo: "skip", showlegend: false,
    });

    const data = [
      bandTrace(stats.q05),
      bandTrace(stats.q95, hexA(t.s1, 0.1)),
      bandTrace(stats.q25),
      bandTrace(stats.q75, hexA(t.s1, 0.18)),
    ];

    // Track the drawn extent so the axis covers what is on screen and no more.
    // Anchoring the low end at FLOOR instead would waste decades of empty space
    // whenever the stake is small enough that nobody approaches ruin.
    let yHi = -Infinity, yLo = Infinity;
    for (const arr of [stats.q95, stats.q05, stats.mean]) {
      for (let k = 0; k < stride; k++) {
        const v = clampFloor(arr[k]);
        if (v > yHi) yHi = v;
        if (v < yLo) yLo = v;
      }
    }

    // A few real paths: the bands say where everyone is, these say what the ride
    // feels like for one person.
    for (let i = 0; i < drawn; i++) {
      const base = i * stride;
      const y = new Array(stride);
      for (let k = 0; k < stride; k++) {
        const v = clampFloor(paths[base + k]);
        y[k] = v;
        if (v > yHi) yHi = v;
        if (v < yLo) yLo = v;
      }
      data.push({
        x: xs, y, type: "scatter", mode: "lines",
        line: { color: t.cloud, width: 1 },
        hoverinfo: "skip", showlegend: false,
      });
    }

    // Linear interpolation, not spline: smoothing a stochastic median would draw
    // curvature that is not in the data.
    data.push({
      x: xs, y: mean, type: "scatter", mode: "lines",
      line: { color: t.s2, width: 2 },
      name: "Mean of these players",
      hovertemplate: "<b>%{y:$,.2f}</b>  mean of these players<extra></extra>",
    });
    data.push({
      x: xs, y: median, type: "scatter", mode: "lines",
      line: { color: t.s1, width: 2 },
      name: "Median (typical player)",
      hovertemplate: "<b>%{y:$,.2f}</b>  median<extra></extra>",
    });

    // Selective direct labels: the two endpoints, which are the whole story.
    const annot = (y, text, color) => ({
      x: rounds, y: Math.log10(y), xref: "x", yref: "y",
      text, showarrow: false, xanchor: "right", yanchor: "bottom",
      font: { family: FONT, size: 11, color: t.textPrimary },
      bgcolor: t.surface, borderpad: 3,
      bordercolor: color, borderwidth: 0,
    });

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: { text: "Round", font: { color: t.textSecondary, size: 12 } },
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      // Explicit decade ticks, never Plotly's SI format: ",.3~s" renders $0.10
      // as "$100m", which reads as "$100 million" and is worse than no label.
      yaxis: axis(t, Object.assign({
        type: "log",
        title: { text: "Wealth (log scale)", font: { color: t.textSecondary, size: 12 } },
      }, decadeTicks(Math.min(yLo, pr.w0), Math.max(yHi, pr.w0), true))),
      hovermode: "x unified",
      annotations: [
        annot(mean[rounds], `mean ${EP.fmt.money(stats.mean[rounds])}`, t.s2),
        annot(median[rounds], `median ${EP.fmt.money(stats.median[rounds])}`, t.s1),
      ],
      shapes: [{
        type: "line", xref: "paper", x0: 0, x1: 1,
        yref: "y", y0: Math.log10(pr.w0), y1: Math.log10(pr.w0),
        line: { color: t.axis, width: 1 },
        layer: "below",
      }],
    });

    return Plotly.react(el, data, layout, CONFIG).then(() => ({
      drawn, total: nPaths,
    }));
  }

  // -- terminal-wealth histogram -------------------------------------------
  /**
   * Distribution of final wealth on a log x-axis.
   *
   * One series, so one color (slot 1) and no legend box -- the title names it.
   * Median and mean are reference lines in chrome ink with direct labels, not
   * extra series: they are annotations on this distribution, not members of it.
   */
  function histogram(el, hist, stats, pr) {
    const t = theme();
    const { edges, counts } = hist;
    const centers = counts.map((_, i) => (edges[i] + edges[i + 1]) / 2);
    const widths = counts.map((_, i) => edges[i + 1] - edges[i]);
    const total = counts.reduce((a, b) => a + b, 0) + hist.wiped;

    const data = [{
      x: centers, y: counts, type: "bar",
      width: widths.map((w) => w * 0.86), // the remaining 14% is the surface gap
      marker: { color: t.s1 },
      hovertemplate:
        "<b>%{customdata[0]} players</b><br>%{customdata[1]}<extra></extra>",
      customdata: counts.map((c, i) => [
        c,
        `${EP.fmt.money(Math.pow(10, edges[i]))} – ${EP.fmt.money(Math.pow(10, edges[i + 1]))}`,
      ]),
    }];

    const refLine = (value) => ({
      type: "line", x0: Math.log10(clampFloor(value)), x1: Math.log10(clampFloor(value)),
      yref: "paper", y0: 0, y1: 1,
      line: { color: t.textSecondary, width: 1 },
    });

    const refLabel = (value, label, ypos) => ({
      x: Math.log10(clampFloor(value)), y: ypos, xref: "x", yref: "paper",
      text: label, showarrow: false, xanchor: "left", yanchor: "top",
      font: { family: FONT, size: 11, color: t.textPrimary },
      bgcolor: t.surface, borderpad: 3,
    });

    const layout = baseLayout(t, {
      bargap: 0,
      xaxis: axis(t, Object.assign({
        title: {
          text: "Final wealth (log scale)",
          font: { color: t.textSecondary, size: 12 },
        },
      }, (function () {
        // Ticks span the bins and both reference lines, so no label sits off-axis.
        const lo = Math.min(Math.pow(10, edges[0]), clampFloor(stats.medianFinal), pr.w0);
        const hi = Math.max(Math.pow(10, edges[edges.length - 1]), stats.expectedFinal, pr.w0);
        // Linear axis over pre-logged values, so tickvals stay in log10 units.
        const cfg = decadeTicks(lo, hi, false);
        delete cfg.range; // let the bars set the range; ticks may extend past them
        return cfg;
      })())),
      yaxis: axis(t, {
        title: { text: "Players", font: { color: t.textSecondary, size: 12 } },
        rangemode: "tozero",
      }),
      hovermode: "closest",
      shapes: [
        refLine(stats.medianFinal),
        refLine(stats.expectedFinal),
        { type: "line", x0: Math.log10(pr.w0), x1: Math.log10(pr.w0),
          yref: "paper", y0: 0, y1: 1, line: { color: t.axis, width: 1 } },
      ],
      annotations: [
        refLabel(stats.medianFinal, "median", 0.99),
        refLabel(stats.expectedFinal, "mean", 0.88),
        refLabel(pr.w0, "start", 0.77),
      ],
    });

    return Plotly.react(el, data, layout, CONFIG).then(() => ({ total }));
  }

  /** Money label for a whole decade. `money()` alone is wrong here: it drops to
   *  exponential below a cent, so a tick would read "$1.0e-4". */
  function decadeLabel(d) {
    if (d >= 4) return EP.fmt.money(Math.pow(10, d));
    if (d >= 0) return `$${Math.pow(10, d).toLocaleString("en-US")}`;
    if (d >= -4) return `$${Math.pow(10, d).toFixed(-d)}`;
    return `$10^${d}`;
  }

  /**
   * Tick config for an axis spanning [lo, hi] in dollars, labelled on whole
   * decades.
   *
   * Two reasons this is hand-rolled. First, Plotly's SI tick format is wrong for
   * currency -- it renders $0.10 as "$100m" (milli), which reads as "$100
   * million". Second, Plotly's log-axis unit convention is genuinely
   * inconsistent: `range`, `shapes` and `annotations` take log10 units, but
   * `tickvals` takes DATA units. Passing log10 values as tickvals silently
   * drops the non-positive ones and misplaces the rest, so `logAxis` selects
   * which convention to emit. A linear axis plotting pre-logged values (the
   * histogram) wants the log10 form instead.
   */
  function decadeTicks(lo, hi, logAxis) {
    const dLo = Math.floor(Math.log10(Math.max(lo, Number.MIN_VALUE)));
    const dHi = Math.ceil(Math.log10(Math.max(hi, lo * 10)));
    const span = Math.max(1, dHi - dLo);
    const stepSize = span > 24 ? 6 : span > 15 ? 4 : span > 9 ? 3 : span > 5 ? 2 : 1;
    const tickvals = [], ticktext = [];
    for (let d = dLo; d <= dHi; d += stepSize) {
      tickvals.push(logAxis ? Math.pow(10, d) : d);
      ticktext.push(decadeLabel(d));
    }
    return { tickmode: "array", tickvals, ticktext, range: [dLo, dHi] };
  }

  // -- Kelly sweep ----------------------------------------------------------
  /**
   * Long-run growth rate against bet fraction.
   *
   * The value has a polarity (growing vs shrinking) around a meaningful zero,
   * so this is the diverging case: blue above the line, red below, neutral gray
   * at zero. One series, so no legend box.
   */
  function sweep(el, sw, pr) {
    const t = theme();
    const finite = sw.g.map((v) => (isFinite(v) ? v : null));

    // Split into positive and negative segments so each arm carries its own
    // pole color. The shared boundary point keeps the two halves connected.
    const posY = finite.map((v) => (v === null || v < 0 ? null : v));
    const negY = finite.map((v) => (v === null || v > 0 ? null : v));

    const data = [
      { x: sw.fs, y: negY, type: "scatter", mode: "lines",
        line: { color: t.neg, width: 2 }, fill: "tozeroy",
        fillcolor: hexA(t.neg, 0.1), name: "Shrinking",
        hovertemplate: "<b>%{y:+.3%}</b> per round<extra></extra>" },
      { x: sw.fs, y: posY, type: "scatter", mode: "lines",
        line: { color: t.s1, width: 2 }, fill: "tozeroy",
        fillcolor: hexA(t.s1, 0.1), name: "Growing",
        hovertemplate: "<b>%{y:+.3%}</b> per round<extra></extra>" },
    ];

    const gStar = EP.timeGrowth(pr.p, pr.up, pr.down, sw.fStar);
    if (isFinite(gStar)) {
      data.push({
        x: [sw.fStar], y: [gStar], type: "scatter", mode: "markers",
        marker: {
          color: t.s1, size: 9,
          line: { color: t.surface, width: 2 }, // 2px surface ring
        },
        name: "Optimum",
        hovertemplate: `<b>f* = ${EP.fmt.pct(sw.fStar)}</b><br>%{y:+.3%} per round<extra></extra>`,
      });
    }

    // The reader's current stake, so the slider has a visible anchor.
    const gNow = EP.timeGrowth(pr.p, pr.up, pr.down, pr.f);

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: {
          text: "Fraction of wealth staked each round",
          font: { color: t.textSecondary, size: 12 },
        },
        tickformat: ".0%",
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, {
        title: {
          text: "Growth per round, typical player",
          font: { color: t.textSecondary, size: 12 },
        },
        tickformat: "+.1%",
        zeroline: true, zerolinecolor: t.axis, zerolinewidth: 1,
      }),
      hovermode: "x unified",
      shapes: [{
        type: "line", x0: pr.f, x1: pr.f, yref: "paper", y0: 0, y1: 1,
        line: { color: t.muted, width: 1 }, layer: "below",
      }],
      annotations: [
        isFinite(gStar) ? {
          x: sw.fStar, y: gStar, text: `optimum ${EP.fmt.pct(sw.fStar)}`,
          showarrow: false, xanchor: "left", yanchor: "bottom",
          xshift: 8, yshift: 4,
          font: { family: FONT, size: 11, color: t.textPrimary },
          bgcolor: t.surface, borderpad: 3,
        } : null,
        isFinite(gNow) ? {
          x: pr.f, y: 0, yref: "paper", text: "your stake",
          showarrow: false, xanchor: "center", yanchor: "bottom", yshift: 2,
          font: { family: FONT, size: 11, color: t.muted },
          bgcolor: t.surface, borderpad: 2,
        } : null,
      ].filter(Boolean),
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  /** rgba() from a hex the browser resolved for us, for 10% area washes. */
  function hexA(hex, alpha) {
    const h = hex.replace("#", "");
    const n = h.length === 3
      ? h.split("").map((c) => parseInt(c + c, 16))
      : [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return `rgba(${n[0]},${n[1]},${n[2]},${alpha})`;
  }

  Object.assign(EP, { trajectory, histogram, sweep, theme, FLOOR, SAMPLE_PATHS });
})(window.EP);
