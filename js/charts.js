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
   *  and the bands answer "where is everybody?".
   *
   *  Owned by engine.js, because the simulator keeps exactly this many
   *  trajectories and discards the rest. Re-declaring it here would put two
   *  numbers in one namespace and let the chart ask for paths that were never
   *  stored. */
  const SAMPLE_PATHS = EP.SAMPLE_PATHS;

  /**
   * Points per drawn line, before the renderer starts paying for detail it
   * cannot show.
   *
   * A chart is ~1000 CSS pixels wide, so a 2000-round walk is putting two
   * vertices in every pixel column. Decimation below keeps the envelope (the
   * min and the max of each bucket) rather than sampling one value per bucket,
   * so spikes survive even though the vertex count halves.
   */
  const MAX_LINE_POINTS = 1200;

  /**
   * Envelope-preserving decimation of one series onto shared x positions.
   *
   * Returns null when the series is already short enough, so the caller can
   * skip the copy entirely in the common case.
   */
  function decimated(xs, ys, limit) {
    const n = ys.length;
    const cap = limit || MAX_LINE_POINTS;
    if (n <= cap) return null;
    const buckets = Math.floor(cap / 2);
    const width = n / buckets;
    const ox = [], oy = [];
    for (let b = 0; b < buckets; b++) {
      const from = Math.floor(b * width);
      const to = Math.min(n, Math.floor((b + 1) * width));
      if (to <= from) continue;
      let lo = from, hi = from;
      for (let i = from + 1; i < to; i++) {
        if (ys[i] < ys[lo]) lo = i;
        if (ys[i] > ys[hi]) hi = i;
      }
      // Emitted in index order so the line still reads left to right.
      const a = Math.min(lo, hi), z = Math.max(lo, hi);
      ox.push(xs[a], xs[z]);
      oy.push(ys[a], ys[z]);
    }
    return { x: ox, y: oy };
  }

  /**
   * Integer x positions 0..n-1, cached.
   *
   * Every trajectory chart shares one round axis, and rebuilding it per trace
   * per frame allocated tens of thousands of numbers a second for a value that
   * never changes. Handed out read-only by convention: Plotly does not mutate
   * the arrays it is given.
   */
  const rangeCache = new Map();
  function indices(n) {
    let a = rangeCache.get(n);
    if (!a) {
      a = new Array(n);
      for (let i = 0; i < n; i++) a[i] = i;
      rangeCache.set(n, a);
    }
    return a;
  }

  /**
   * The de-emphasised cloud of individual paths, as ONE trace.
   *
   * Plotly charges per trace as well as per point, and two dozen traces that
   * share a colour, a width and a hover setting are two dozen lots of that
   * overhead for one visual object. A null x/y pair breaks the line between
   * paths, so a single trace draws them all without joining the end of one to
   * the start of the next.
   */
  function cloudTrace(seriesList, xs, color) {
    const cx = [], cy = [];
    for (const ys of seriesList) {
      const thin = decimated(xs, ys);
      const px = thin ? thin.x : xs, py = thin ? thin.y : ys;
      for (let i = 0; i < py.length; i++) { cx.push(px[i]); cy.push(py[i]); }
      cx.push(null); cy.push(null);
    }
    return {
      x: cx, y: cy, type: "scatter", mode: "lines",
      line: { color, width: 1 },
      hoverinfo: "skip", showlegend: false,
    };
  }

  /** A band/median/mean line, decimated if it is longer than the axis is wide. */
  function lineTrace(xs, ys, rest) {
    const thin = decimated(xs, ys);
    return Object.assign(
      { x: thin ? thin.x : xs, y: thin ? thin.y : ys, type: "scatter", mode: "lines" },
      rest);
  }

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
      s4: v("--series-4"),
      neg: v("--diverging-neg"),
      deemph: v("--deemphasis"),
      cloud: v("--cloud"),
      // The two inks a filled mark can carry a label in. Which one applies is a
      // luminance decision made per cell (see readableInk), but the values
      // themselves still come from the stylesheet.
      inkOnLight: v("--ink-on-light"),
      inkOnDark: v("--ink-on-dark"),
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
    const { paths, stride, nPaths, rounds, stored } = sim;
    // Only the stored trajectories exist; the rest were summarised into the
    // histogram the bands come from and never materialised.
    const drawn = Math.min(stored === undefined ? nPaths : stored,
                           nPaths, SAMPLE_PATHS);

    const xs = indices(stride);
    const band = (arr) => Array.from(arr, clampFloor);
    const median = band(stats.median);
    const mean = band(stats.mean);

    // Band pairs are drawn lower-then-upper so the upper trace can fill down to
    // the one before it. Wider band first, so the narrower sits on top of it.
    const bandTrace = (arr, fill) => lineTrace(xs, band(arr), {
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
    const sample = [];
    for (let i = 0; i < drawn; i++) {
      const base = i * stride;
      const y = new Array(stride);
      for (let k = 0; k < stride; k++) {
        const v = clampFloor(paths[base + k]);
        y[k] = v;
        if (v > yHi) yHi = v;
        if (v < yLo) yLo = v;
      }
      sample.push(y);
    }
    if (sample.length) data.push(cloudTrace(sample, xs, t.cloud));

    // Linear interpolation, not spline: smoothing a stochastic median would draw
    // curvature that is not in the data.
    data.push(lineTrace(xs, mean, {
      line: { color: t.s2, width: 2 },
      name: "Mean of these players",
      hovertemplate: "<b>%{y:$,.2f}</b>  mean of these players<extra></extra>",
    }));
    data.push(lineTrace(xs, median, {
      line: { color: t.s1, width: 2 },
      name: "Median (typical player)",
      hovertemplate: "<b>%{y:$,.2f}</b>  median<extra></extra>",
    }));

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

  // ==========================================================================
  // Gambler's ruin
  // ==========================================================================
  /**
   * The walk itself: a linear-axis bankroll chart between two absorbing lines.
   *
   * Linear, unlike every wealth axis on the multiplicative tabs, and that is the
   * point of the contrast -- this game moves by a fixed number of dollars, so a
   * log axis would misrepresent the step size and squash the region near $0
   * where all the interesting behaviour is.
   *
   * The barriers are reference lines in chrome ink rather than series: they are
   * the rules of the game, not measurements taken from it.
   */
  function ruinWalks(el, d, pr) {
    const t = theme();
    const { sim, walk } = d;
    const { paths, stride, nPaths, rounds, bet, n } = sim;
    const drawn = Math.min(nPaths, RUIN_PATHS);
    const xs = indices(stride);
    const dollars = (arr) => Array.from(arr, (v) => v * bet);
    const target = n * bet;

    // No quantile bands here, deliberately, though the table view still carries
    // the percentiles. Once absorption dominates, the 5th percentile is pinned
    // at $0 and the 95th at the target, so the bands inflate to a solid block
    // covering the whole board -- true, and completely uninformative. Individual
    // walks are the readable form for an additive process: unlike the
    // multiplicative tabs there is no binomial lattice in log space to moire, so
    // a couple of dozen paths can be drawn without turning into texture.
    const data = [];

    const sample = [];
    for (let i = 0; i < drawn; i++) {
      const base = i * stride;
      const y = new Array(stride);
      for (let k = 0; k < stride; k++) y[k] = paths[base + k] * bet;
      sample.push(y);
    }
    // One trace, not two dozen: at 2000 rounds that was 48,000 vertices spread
    // over 24 traces, and the per-trace overhead alone dominated the redraw.
    if (sample.length) data.push(cloudTrace(sample, xs, t.cloud));

    data.push(lineTrace(xs, dollars(walk.median), {
      line: { color: t.s1, width: 2 },
      name: "Median player",
      hovertemplate: "<b>%{y:$,.0f}</b>  median<extra></extra>",
    }));

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: { text: "Round", font: { color: t.textSecondary, size: 12 } },
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, {
        title: { text: "Bankroll", font: { color: t.textSecondary, size: 12 } },
        tickprefix: "$", tickformat: ",d",
        // Both barriers always visible, with a little air above the target so
        // its label is not clipped by the plot edge.
        range: [-target * 0.04, target * 1.08],
      }),
      hovermode: "x unified",
      shapes: [
        // $0 and the target: absorbing, so a path that touches either stops.
        { type: "line", xref: "paper", x0: 0, x1: 1, yref: "y", y0: 0, y1: 0,
          line: { color: t.neg, width: 1 }, layer: "below" },
        { type: "line", xref: "paper", x0: 0, x1: 1, yref: "y",
          y0: target, y1: target,
          line: { color: t.s3, width: 1 }, layer: "below" },
        { type: "line", xref: "paper", x0: 0, x1: 1, yref: "y",
          y0: pr.bankroll, y1: pr.bankroll,
          line: { color: t.axis, width: 1 }, layer: "below" },
      ],
      annotations: [
        { x: 0, y: 0, xref: "paper", yref: "y", text: "broke — absorbing",
          showarrow: false, xanchor: "left", yanchor: "bottom", xshift: 4,
          font: { family: FONT, size: 11, color: t.textPrimary },
          bgcolor: t.surface, borderpad: 3 },
        { x: 0, y: target, xref: "paper", yref: "y",
          text: `target ${EP.fmt.money(target)} — absorbing`,
          showarrow: false, xanchor: "left", yanchor: "top", xshift: 4,
          font: { family: FONT, size: 11, color: t.textPrimary },
          bgcolor: t.surface, borderpad: 3 },
        { x: rounds, y: 0.02, xref: "x", yref: "paper",
          text: `${EP.fmt.pct(sim.ruined / sim.nPaths)} of these ` +
                `${EP.fmt.count(sim.nPaths)} players went broke`,
          showarrow: false, xanchor: "right", yanchor: "bottom",
          font: { family: FONT, size: 11, color: t.textSecondary },
          bgcolor: t.surface, borderpad: 3 },
      ],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  /** Individual walks drawn on the ruin chart. Many more than the multiplicative
   *  tabs get: an additive walk does not sit on a lattice that moires, and the
   *  pile-up of absorbed paths along each wall is the picture. */
  const RUIN_PATHS = 24;

  /**
   * P(ruin) against starting bankroll, closed form.
   *
   * Two series: the game as configured, and the same board with a fair coin, so
   * the vertical gap between them is what the house edge is worth. The player's
   * own position is a marker with a direct label rather than a third series.
   */
  function ruinOdds(el, d, pr) {
    const t = theme();
    const { curve, stats } = d;
    const xs = curve.ks.map((k) => k * curve.bet);
    const fair = curve.ks.map((k) =>
      k === 0 ? 1 : k === curve.n ? 0 : 1 - k / curve.n);

    const data = [
      { x: xs, y: fair, type: "scatter", mode: "lines",
        line: { color: t.deemph, width: 1 },
        name: "Fair coin",
        hovertemplate: "<b>%{y:.1%}</b> with a fair coin<extra></extra>" },
      { x: xs, y: curve.ruin, type: "scatter", mode: "lines",
        line: { color: t.s1, width: 2 },
        name: "This coin",
        hovertemplate: "<b>%{y:.1%}</b> chance of ruin<extra></extra>" },
      { x: [pr.bankroll], y: [stats.ruinProb], type: "scatter", mode: "markers",
        marker: { color: t.s1, size: 9, line: { color: t.surface, width: 2 } },
        name: "You",
        hovertemplate: "<b>you: %{y:.1%}</b><extra></extra>" },
    ];

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: {
          text: "Starting bankroll",
          font: { color: t.textSecondary, size: 12 },
        },
        tickprefix: "$", tickformat: ",d",
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, {
        title: {
          text: "Chance of going broke first",
          font: { color: t.textSecondary, size: 12 },
        },
        tickformat: ".0%", range: [0, 1.02],
      }),
      hovermode: "x unified",
      annotations: [
        { x: pr.bankroll, y: stats.ruinProb,
          text: `you: ${EP.fmt.pct(stats.ruinProb)}`,
          showarrow: false, xanchor: "left", yanchor: "bottom",
          xshift: 8, yshift: 4,
          font: { family: FONT, size: 11, color: t.textPrimary },
          bgcolor: t.surface, borderpad: 3 },
      ],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  /**
   * P(ruin) against bet size -- the bold-play curve.
   *
   * The direction of this curve flips with the sign of the edge, so it is drawn
   * in the diverging pair: red where betting bigger is safer (the edge is
   * against you) and blue where patience pays. Colour here encodes which lesson
   * applies, and the annotation names it in words as well.
   */
  function ruinBoldness(el, d, pr) {
    const t = theme();
    const { betCurve, stats } = d;
    const adverse = pr.p < 0.5;
    const color = adverse ? t.neg : t.s1;

    const data = [
      { x: betCurve.sizes, y: betCurve.ruin, type: "scatter", mode: "lines",
        line: { color, width: 2 },
        fill: "tozeroy", fillcolor: hexA(color, 0.1),
        name: "Chance of ruin",
        hovertemplate: "<b>%{y:.1%}</b> ruin at %{x:$,.0f} a round<extra></extra>" },
      { x: [pr.bet], y: [stats.ruinProb], type: "scatter", mode: "markers",
        marker: { color, size: 9, line: { color: t.surface, width: 2 } },
        name: "Your bet",
        hovertemplate: "<b>your bet: %{y:.1%}</b><extra></extra>" },
    ];

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: {
          text: "Bet per round",
          font: { color: t.textSecondary, size: 12 },
        },
        tickprefix: "$", tickformat: ",d",
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, {
        title: {
          text: "Chance of going broke first",
          font: { color: t.textSecondary, size: 12 },
        },
        tickformat: ".0%", rangemode: "tozero",
      }),
      hovermode: "x unified",
      shapes: [{
        type: "line", x0: pr.bet, x1: pr.bet, yref: "paper", y0: 0, y1: 1,
        line: { color: t.muted, width: 1 }, layer: "below",
      }],
      annotations: [
        { x: pr.bet, y: 0, yref: "paper", text: "your bet",
          showarrow: false, xanchor: "center", yanchor: "bottom", yshift: 2,
          font: { family: FONT, size: 11, color: t.muted },
          bgcolor: t.surface, borderpad: 2 },
        { x: 1, y: 1, xref: "paper", yref: "paper",
          text: adverse
            ? "edge against you — bolder is safer"
            : "edge in your favour — patience is safer",
          showarrow: false, xanchor: "right", yanchor: "top",
          font: { family: FONT, size: 11, color: t.textPrimary },
          bgcolor: t.surface, borderpad: 4 },
      ],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  // ==========================================================================
  // St Petersburg
  // ==========================================================================
  /**
   * Running average payout against games played, log-log.
   *
   * This is the emphasis form: every player is drawn, one is highlighted, and a
   * reference line marks where the average is expected to be loitering. Log x
   * because the interesting structure is per decade of play, log y because a
   * single deep run can move the average by orders of magnitude -- which is
   * exactly the behaviour on show.
   */
  function spRunningMean(el, d, pr) {
    const t = theme();
    const { sim, stats } = d;
    const xs = sim.xs;

    // The cloud is one trace with null separators, not one trace per run: the
    // legend is written by hand anyway and 24 traces would slow the redraw.
    const cx = [], cy = [];
    for (let r = 1; r < sim.curves.length; r++) {
      for (let i = 0; i < xs.length; i++) {
        cx.push(xs[i]);
        cy.push(clampFloor(sim.curves[r][i]));
      }
      cx.push(null); cy.push(null);
    }

    const lead = Array.from(sim.curves[0], clampFloor);
    let yLo = Infinity, yHi = -Infinity;
    for (const c of sim.curves) {
      for (let i = 0; i < xs.length; i++) {
        const v = clampFloor(c[i]);
        if (v < yLo) yLo = v;
        if (v > yHi) yHi = v;
      }
    }
    yHi = Math.max(yHi, stats.typicalMean);
    yLo = Math.min(yLo, stats.median);

    const data = [
      { x: cx, y: cy, type: "scatter", mode: "lines",
        line: { color: t.cloud, width: 1 },
        hoverinfo: "skip", showlegend: false },
      { x: xs, y: xs.map(() => stats.typicalMean), type: "scatter", mode: "lines",
        line: { color: t.s2, width: 2 },
        name: "Where it loiters",
        hovertemplate: `<b>${EP.fmt.money(stats.typicalMean)}</b> predicted<extra></extra>` },
      { x: xs, y: lead, type: "scatter", mode: "lines",
        line: { color: t.s1, width: 2 },
        name: "One player",
        hovertemplate: "<b>%{y:$,.2f}</b> average so far<extra></extra>" },
    ];

    const layout = baseLayout(t, {
      xaxis: axis(t, Object.assign({
        type: "log",
        title: {
          text: "Games played (log scale)",
          font: { color: t.textSecondary, size: 12 },
        },
      }, plainDecadeTicks(1, pr.plays))),
      yaxis: axis(t, Object.assign({
        type: "log",
        title: {
          text: "Average payout so far (log scale)",
          font: { color: t.textSecondary, size: 12 },
        },
      }, decadeTicks(yLo, yHi, true))),
      hovermode: "x unified",
      annotations: [{
        x: Math.log10(pr.plays), y: Math.log10(clampFloor(stats.typicalMean)),
        text: `predicted ${EP.fmt.money(stats.typicalMean)}`,
        showarrow: false, xanchor: "right", yanchor: "bottom",
        font: { family: FONT, size: 11, color: t.textPrimary },
        bgcolor: t.surface, borderpad: 3,
      }],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  /**
   * Each outcome's contribution to the expected payout.
   *
   * The paradox, drawn. Bar height is payout times probability, so a flat row of
   * bars is a divergent series: every further toss doubles the prize and halves
   * the odds, and the two cancel forever. One series, one colour.
   */
  function spContributions(el, d, pr) {
    const t = theme();
    const { tiers, stats } = d;

    const data = [{
      x: tiers.map((r) => r.tier),
      y: tiers.map((r) => r.contribution),
      type: "bar",
      marker: { color: t.s1 },
      hovertemplate:
        "<b>%{customdata[0]}</b> toward the expected value<br>" +
        "pays %{customdata[1]}, happens %{customdata[2]} of the time<extra></extra>",
      customdata: tiers.map((r) => [
        EP.fmt.money(r.contribution), EP.fmt.money(r.payout),
        `${(r.prob * 100).toFixed(r.prob < 0.001 ? 4 : 2)}%`,
      ]),
    }];

    const layout = baseLayout(t, {
      // 2px of surface between bars, per the mark spec.
      bargap: 0.18,
      xaxis: axis(t, {
        title: {
          text: "Tosses before the coin fails",
          font: { color: t.textSecondary, size: 12 },
        },
        tickmode: "linear", dtick: tiers.length > 12 ? 2 : 1,
        showgrid: false,
      }),
      yaxis: axis(t, {
        title: {
          text: "Contribution to expected payout",
          font: { color: t.textSecondary, size: 12 },
        },
        tickprefix: "$", tickformat: ",.2f", rangemode: "tozero",
      }),
      hovermode: "closest",
      annotations: [{
        x: 1, y: 1, xref: "paper", yref: "paper",
        text: stats.divergent
          ? `m·p = ${EP.fmt.num(stats.mp)} — the bars never shrink, so the sum never ends`
          : `m·p = ${EP.fmt.num(stats.mp)} — the bars shrink, so the sum converges to ${EP.fmt.money(stats.expected)}`,
        showarrow: false, xanchor: "right", yanchor: "top",
        font: { family: FONT, size: 11, color: t.textPrimary },
        bgcolor: t.surface, borderpad: 4,
      }],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  /**
   * Plain-integer decade ticks, for a count axis rather than a money axis.
   *
   * The range stops at the data rather than at the next whole decade -- 20,000
   * games would otherwise leave a third of the axis empty out to 100,000. Ticks
   * are still on whole decades, so the last one can sit inside the range.
   * `tickvals` in data units, `range` in log10: Plotly's two conventions.
   */
  function plainDecadeTicks(lo, hi) {
    const dLo = Math.floor(Math.log10(Math.max(lo, 1)));
    const dHi = Math.floor(Math.log10(Math.max(hi, 10)));
    const tickvals = [], ticktext = [];
    for (let dd = dLo; dd <= dHi; dd++) {
      tickvals.push(Math.pow(10, dd));
      ticktext.push(Math.pow(10, dd).toLocaleString("en-US"));
    }
    return {
      tickmode: "array", tickvals, ticktext,
      range: [dLo, Math.log10(Math.max(hi, 10))],
    };
  }

  /** Percentage label for a whole decade, down to hundredths of a percent. */
  function decadeLabelPct(d) {
    const v = Math.pow(10, d);
    return v >= 0.01 ? `${(v * 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}%`
      : `${(v * 100).toPrecision(1)}%`;
  }

  /**
   * Decade ticks for a log axis over PROBABILITIES (0 < p < 1), percentage
   * labelled. `plainDecadeTicks` above floors its input at 1 -- built for
   * count axes like "games played" -- so it silently collapses any all-
   * fractional range like a prevalence sweep down to a [1, 10] window with
   * nothing plotted in it. This is that same convention for values that are
   * never >= 1.
   */
  function probDecadeTicks(lo, hi) {
    const dLo = Math.floor(Math.log10(Math.max(lo, 1e-6)));
    const dHi = Math.ceil(Math.log10(Math.max(hi, lo * 10)));
    const tickvals = [], ticktext = [];
    for (let d = dLo; d <= dHi; d++) {
      tickvals.push(Math.pow(10, d));
      ticktext.push(decadeLabelPct(d));
    }
    return { tickmode: "array", tickvals, ticktext, range: [dLo, dHi] };
  }

  // ==========================================================================
  // Iterated prisoner's dilemma
  // ==========================================================================
  /** Fixed colour per strategy, so identity survives across all three charts.
   *
   *  Four validated categorical slots plus the neutral ink for the random
   *  player, which is the honest slot for it: it is the null baseline, not a
   *  strategy with a position to defend. */
  function strategyColors(t) {
    return { tft: t.s1, grim: t.s4, allc: t.s3, alld: t.s2, rand: t.deemph };
  }

  /**
   * Score per strategy, horizontal bars.
   *
   * Horizontal because the category labels are words, and sorted by value
   * because rank is the question the chart answers. One measure, one colour --
   * except that colour is already spoken for by strategy identity here, so each
   * bar keeps its own.
   */
  function pdScores(el, d) {
    const t = theme();
    const cols = strategyColors(t);
    const rows = EP.STRATEGIES
      .map((id, i) => ({ id, score: d.stats.scores[i] }))
      .sort((a, b) => a.score - b.score); // ascending: Plotly draws bottom-up

    const data = [{
      x: rows.map((r) => r.score),
      y: rows.map((r) => EP.STRATEGY_LABELS[r.id]),
      type: "bar", orientation: "h",
      marker: { color: rows.map((r) => cols[r.id]) },
      text: rows.map((r) => EP.fmt.num(r.score)),
      textposition: "outside",
      textfont: { family: FONT, size: 11, color: t.textPrimary },
      cliponaxis: false,
      hovertemplate: "<b>%{x:.3f}</b> per round<br>%{customdata}<extra></extra>",
      customdata: rows.map((r) => EP.STRATEGY_NOTES[r.id]),
    }];

    const layout = baseLayout(t, {
      margin: { l: 148, r: 48, t: 8, b: 48 },
      bargap: 0.28,
      xaxis: axis(t, {
        title: {
          text: "Average points per round, whole tournament",
          font: { color: t.textSecondary, size: 12 },
        },
        rangemode: "tozero",
      }),
      yaxis: axis(t, { showgrid: false, ticks: "" }),
      hovermode: "closest",
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  /**
   * The pairwise payoff matrix, as a heatmap.
   *
   * Sequential single hue built from the theme's own surface and primary, so it
   * inverts correctly with the mode instead of being a fixed Plotly colorscale.
   * Every cell carries its number, which is what makes the low-contrast end of
   * the ramp acceptable -- colour is the ordering cue, the label is the value.
   */
  function pdHeatmap(el, d) {
    const t = theme();
    const labels = EP.STRATEGIES.map((s) => EP.STRATEGY_LABELS[s]);
    const z = d.stats.matrix;
    let lo = Infinity, hi = -Infinity;
    for (const row of z) for (const v of row) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = hi - lo || 1;

    const data = [{
      z, x: labels, y: labels,
      type: "heatmap",
      colorscale: [[0, hexA(t.s1, 0.08)], [1, t.s1]],
      showscale: false,
      xgap: 2, ygap: 2, // the 2px surface gap, same as the bar charts
      hovertemplate:
        "<b>%{y}</b> vs <b>%{x}</b><br>%{z:.3f} points per round<extra></extra>",
    }];

    // Direct labels in every cell. Ink is chosen from the interpolated cell
    // colour's luminance, so it stays legible at both ends of the ramp and in
    // both themes -- the two ink values come from CSS, never hardcoded here.
    const annotations = [];
    for (let i = 0; i < z.length; i++) {
      for (let j = 0; j < z[i].length; j++) {
        const frac = (z[i][j] - lo) / span;
        const cell = mixHex(t.surface, t.s1, 0.08 + 0.92 * frac);
        annotations.push({
          x: labels[j], y: labels[i], text: EP.fmt.num(z[i][j]),
          showarrow: false,
          font: { family: FONT, size: 11, color: readableInk(cell, t) },
        });
      }
    }

    const layout = baseLayout(t, {
      margin: { l: 148, r: 24, t: 8, b: 132 },
      xaxis: axis(t, {
        // standoff clears the rotated tick labels; without it the axis title
        // lands in the middle of them.
        title: { text: "…against this strategy", standoff: 34,
                 font: { color: t.textSecondary, size: 12 } },
        showgrid: false, ticks: "", tickangle: -30,
      }),
      yaxis: axis(t, {
        title: { text: "This strategy scores…",
                 font: { color: t.textSecondary, size: 12 } },
        showgrid: false, ticks: "", autorange: "reversed",
      }),
      annotations,
      hovermode: "closest",
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  /**
   * Strategy shares over generations, stacked area.
   *
   * Stacked because the five shares are parts of a whole that always sums to
   * one; fixed slot order so a strategy keeps its colour and its band position
   * as the mix changes. Direct labels at the right edge for whichever strategies
   * still hold enough of the population to label.
   */
  function pdShares(el, d, pr) {
    const t = theme();
    const cols = strategyColors(t);
    const hist = d.stats.shares;
    const gens = hist.map((_, g) => g);

    const data = EP.STRATEGIES.map((id, i) => ({
      x: gens,
      y: hist.map((row) => row[i]),
      type: "scatter", mode: "lines",
      stackgroup: "one",
      line: { color: cols[id], width: 1 },
      fillcolor: hexA(cols[id], 0.85),
      name: EP.STRATEGY_LABELS[id],
      hovertemplate: `<b>%{y:.1%}</b> ${EP.STRATEGY_LABELS[id]}<extra></extra>`,
    }));

    // Label position is the middle of each band at the last generation, so the
    // labels sit on the thing they name. A band too thin to hold a label, or one
    // whose label would land on top of the last one drawn, is left to the legend
    // and the table view rather than allowed to collide.
    const final = hist[hist.length - 1];
    const annotations = [];
    let acc = 0, lastY = -Infinity;
    EP.STRATEGIES.forEach((id, i) => {
      const share = final[i];
      const mid = acc + share / 2;
      acc += share;
      if (share < 0.06 || mid - lastY < 0.07) return;
      lastY = mid;
      annotations.push({
        x: gens[gens.length - 1], y: mid,
        text: `${EP.STRATEGY_LABELS[id]} ${EP.fmt.pct(share)}`,
        showarrow: false, xanchor: "right", xshift: -6,
        font: { family: FONT, size: 11, color: t.textPrimary },
        bgcolor: t.surface, borderpad: 3,
      });
    });

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: { text: "Generation", font: { color: t.textSecondary, size: 12 } },
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, {
        title: {
          text: "Share of the population",
          font: { color: t.textSecondary, size: 12 },
        },
        tickformat: ".0%", range: [0, 1], showgrid: false,
      }),
      hovermode: "x unified",
      annotations,
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  // ==========================================================================
  // Monty Hall
  // ==========================================================================
  /**
   * Switching vs staying against the host's-knowledge dial.
   *
   * The two lines are the whole scenario: at know=1 (the classic puzzle)
   * switching wins two doors in three; at know=0 (a lucky host) the lines meet,
   * because a reveal that carries no information cannot change either odds.
   */
  function mhKnow(el, d, pr) {
    const t = theme();
    const { ks, switchP, stayP } = d.knowCurve;

    const data = [
      { x: ks, y: stayP, type: "scatter", mode: "lines",
        line: { color: t.deemph, width: 2 }, name: "Staying",
        hovertemplate: "<b>%{y:.1%}</b> staying wins<extra></extra>" },
      { x: ks, y: switchP, type: "scatter", mode: "lines",
        line: { color: t.s1, width: 2 }, name: "Switching",
        hovertemplate: "<b>%{y:.1%}</b> switching wins<extra></extra>" },
      { x: [pr.know], y: [d.stats.switchProb], type: "scatter", mode: "markers",
        marker: { color: t.s1, size: 9, line: { color: t.surface, width: 2 } },
        name: "Your dial",
        hovertemplate: "<b>you: %{y:.1%}</b><extra></extra>" },
    ];

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: { text: "P(the host knows where the prize is)",
                 font: { color: t.textSecondary, size: 12 } },
        tickformat: ".0%",
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, {
        title: { text: "Chance of winning", font: { color: t.textSecondary, size: 12 } },
        tickformat: ".0%", range: [0, 1.02],
      }),
      hovermode: "x unified",
      shapes: [{
        type: "line", x0: pr.know, x1: pr.know, yref: "paper", y0: 0, y1: 1,
        line: { color: t.muted, width: 1 }, layer: "below",
      }],
      annotations: [
        { x: pr.know, y: 0, yref: "paper", text: "your dial",
          showarrow: false, xanchor: "center", yanchor: "bottom", yshift: 2,
          font: { family: FONT, size: 11, color: t.muted },
          bgcolor: t.surface, borderpad: 2 },
      ],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  /**
   * Switching's win rate against the number of doors, for a knowing host and a
   * random one -- the comparison the scenario is actually about. Door count
   * changes the *size* of the advantage; the host's knowledge decides whether
   * there is one at all.
   */
  function mhDoors(el, d, pr) {
    const t = theme();
    const { xs, knowing, random } = d.doorsCurve;

    const data = [
      { x: xs, y: random, type: "scatter", mode: "lines+markers",
        line: { color: t.deemph, width: 2 }, marker: { size: 5 },
        name: "Random host",
        hovertemplate: "<b>%{y:.1%}</b> switching wins, random host<extra></extra>" },
      { x: xs, y: knowing, type: "scatter", mode: "lines+markers",
        line: { color: t.s1, width: 2 }, marker: { size: 5 },
        name: "Knowing host",
        hovertemplate: "<b>%{y:.1%}</b> switching wins, knowing host<extra></extra>" },
      { x: [pr.doors], y: [d.stats.switchKnowing], type: "scatter", mode: "markers",
        marker: { color: t.s1, size: 9, line: { color: t.surface, width: 2 } },
        name: "Your board",
        hovertemplate: "<b>%{y:.1%}</b><extra></extra>" },
    ];

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: { text: `Number of doors (${pr.opened} opened)`,
                 font: { color: t.textSecondary, size: 12 } },
        tickmode: "linear", dtick: xs.length > 12 ? 2 : 1,
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, {
        title: { text: "Chance switching wins",
                 font: { color: t.textSecondary, size: 12 } },
        tickformat: ".0%", rangemode: "tozero",
      }),
      hovermode: "x unified",
      shapes: [{
        type: "line", x0: pr.doors, x1: pr.doors, yref: "paper", y0: 0, y1: 1,
        line: { color: t.muted, width: 1 }, layer: "below",
      }],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  // ==========================================================================
  // Shannon's demon
  // ==========================================================================
  /**
   * The stock, buy-and-hold and rebalanced portfolios, all on the one seeded
   * price path -- the direct demonstration that the stock can finish flat while
   * the rebalanced line pulls away from it. Log scale for the same reason every
   * other wealth axis on the site is: a single lucky path must not flatten the
   * others onto the floor, though here all three paths share one draw so the
   * risk is milder than on the multiplicative tabs.
   */
  function sdPaths(el, d, pr) {
    const t = theme();
    const { price, hold, rebal, stride } = d.sim;
    const xs = indices(stride);
    const band = (arr) => Array.from(arr, clampFloor);
    const py = band(price), hy = band(hold), ry = band(rebal);

    let yLo = Infinity, yHi = -Infinity;
    for (const arr of [py, hy, ry]) {
      for (const v of arr) { if (v < yLo) yLo = v; if (v > yHi) yHi = v; }
    }

    const data = [
      lineTrace(xs, py, {
        line: { color: t.deemph, width: 2 }, name: "Stock (buy 100%, never touch)",
        hovertemplate: "<b>%{y:$,.2f}</b>  stock alone<extra></extra>",
      }),
      lineTrace(xs, hy, {
        line: { color: t.s2, width: 2 }, name: "Buy and hold the mix",
        hovertemplate: "<b>%{y:$,.2f}</b>  buy-and-hold<extra></extra>",
      }),
      lineTrace(xs, ry, {
        line: { color: t.s1, width: 2 }, name: "Rebalanced every " +
          `${pr.interval} period${pr.interval === 1 ? "" : "s"}`,
        hovertemplate: "<b>%{y:$,.2f}</b>  rebalanced<extra></extra>",
      }),
    ];

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: { text: "Period", font: { color: t.textSecondary, size: 12 } },
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, Object.assign({
        type: "log",
        title: { text: "Value (log scale)", font: { color: t.textSecondary, size: 12 } },
      }, decadeTicks(Math.min(yLo, pr.w0), Math.max(yHi, pr.w0), true))),
      hovermode: "x unified",
      shapes: [{
        type: "line", xref: "paper", x0: 0, x1: 1,
        yref: "y", y0: Math.log10(pr.w0), y1: Math.log10(pr.w0),
        line: { color: t.axis, width: 1 }, layer: "below",
      }],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  /**
   * Harvest (rebalanced growth minus buy-and-hold growth) against the
   * rebalancing interval -- the diverging pair, because zero is meaningful
   * here: above it rebalancing helps, below it costs are eating the harvest.
   */
  function sdSweep(el, d, pr) {
    const t = theme();
    const { xs, harvest } = d.harvestCurve;

    const posY = harvest.map((v) => (v < 0 ? null : v));
    const negY = harvest.map((v) => (v > 0 ? null : v));

    const data = [
      { x: xs, y: negY, type: "scatter", mode: "lines",
        line: { color: t.neg, width: 2 }, fill: "tozeroy",
        fillcolor: hexA(t.neg, 0.1), name: "Rebalancing costs more than it harvests",
        hovertemplate: "<b>%{y:+.4%}</b> per period<extra></extra>" },
      { x: xs, y: posY, type: "scatter", mode: "lines",
        line: { color: t.s1, width: 2 }, fill: "tozeroy",
        fillcolor: hexA(t.s1, 0.1), name: "Rebalancing harvests volatility",
        hovertemplate: "<b>%{y:+.4%}</b> per period<extra></extra>" },
      { x: [pr.interval], y: [d.stats.harvest], type: "scatter", mode: "markers",
        marker: { color: d.stats.harvest >= 0 ? t.s1 : t.neg, size: 9,
                  line: { color: t.surface, width: 2 } },
        name: "Your interval",
        hovertemplate: "<b>%{y:+.4%}</b> at your interval<extra></extra>" },
    ];

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: { text: "Rebalance every N periods",
                 font: { color: t.textSecondary, size: 12 } },
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, {
        title: { text: "Harvest vs buy-and-hold",
                 font: { color: t.textSecondary, size: 12 } },
        tickformat: "+.3%",
        zeroline: true, zerolinecolor: t.axis, zerolinewidth: 1,
      }),
      hovermode: "x unified",
      shapes: [{
        type: "line", x0: pr.interval, x1: pr.interval, yref: "paper",
        y0: 0, y1: 1, line: { color: t.muted, width: 1 }, layer: "below",
      }],
      annotations: [{
        x: d.stats.bestInterval, y: d.stats.bestGrowth - d.stats.holdGrowth,
        text: `best: every ${d.stats.bestInterval}`,
        showarrow: false, xanchor: "left", yanchor: "bottom",
        xshift: 8, yshift: 4,
        font: { family: FONT, size: 11, color: t.textPrimary },
        bgcolor: t.surface, borderpad: 3,
      }],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  // ==========================================================================
  // Insurance and risk pooling
  // ==========================================================================
  /**
   * Buyer's and seller's growth-equivalent value against the premium, with the
   * band where both are positive shaded -- the range expected value alone
   * cannot produce, because it can only ever show a transfer.
   */
  function insBand(el, d, pr) {
    const t = theme();
    const { xs, buyer, seller } = d.premiumCurve;
    const { buyerMax, sellerMin, bandOk } = d.stats;

    const data = [
      { x: xs, y: buyer, type: "scatter", mode: "lines",
        line: { color: t.s1, width: 2 }, name: "Buyer's value",
        hovertemplate: "<b>%{y:$,.2f}</b>/period, buyer<extra></extra>" },
      { x: xs, y: seller, type: "scatter", mode: "lines",
        line: { color: t.s3, width: 2 }, name: "Seller's value",
        hovertemplate: "<b>%{y:$,.2f}</b>/period, seller<extra></extra>" },
      { x: [pr.premium], y: [d.stats.buyerValue], type: "scatter", mode: "markers",
        marker: { color: t.s1, size: 9, line: { color: t.surface, width: 2 } },
        name: "Your premium (buyer)",
        hovertemplate: "<b>%{y:$,.2f}</b><extra></extra>" },
      { x: [pr.premium], y: [d.stats.sellerValue], type: "scatter", mode: "markers",
        marker: { color: t.s3, size: 9, line: { color: t.surface, width: 2 } },
        name: "Your premium (seller)",
        hovertemplate: "<b>%{y:$,.2f}</b><extra></extra>" },
    ];

    const shapes = [{
      type: "line", x0: xs[0], x1: xs[xs.length - 1], yref: "y", y0: 0, y1: 0,
      line: { color: t.axis, width: 1 }, layer: "below",
    }, {
      type: "line", x0: pr.premium, x1: pr.premium, yref: "paper", y0: 0, y1: 1,
      line: { color: t.muted, width: 1 }, layer: "below",
    }];
    if (bandOk) {
      shapes.unshift({
        type: "rect", x0: sellerMin, x1: buyerMax, yref: "paper", y0: 0, y1: 1,
        fillcolor: hexA(t.s1, 0.08), line: { width: 0 }, layer: "below",
      });
    }

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: { text: "Premium", font: { color: t.textSecondary, size: 12 } },
        tickprefix: "$", tickformat: ",d",
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, {
        title: { text: "Value (growth-equivalent $/period)",
                 font: { color: t.textSecondary, size: 12 } },
        tickprefix: "$", tickformat: ",.0f",
      }),
      hovermode: "x unified",
      shapes,
      annotations: bandOk ? [{
        x: (sellerMin + buyerMax) / 2, y: 1, yref: "paper",
        text: "both sides improve here",
        showarrow: false, xanchor: "center", yanchor: "top", yshift: -6,
        font: { family: FONT, size: 11, color: t.textSecondary },
        bgcolor: t.surface, borderpad: 3,
      }] : [],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  /**
   * Growth rate of one pool member against pool size, approaching the
   * infinite-pool limit -- nobody in this picture has taken the other side of
   * anything, unlike the buyer/seller band above.
   */
  function insPool(el, d, pr) {
    const t = theme();
    const { sizes, growth } = d.poolCurve;
    const { poolLimit } = d.stats;

    const data = [
      { x: sizes, y: growth, type: "scatter", mode: "lines",
        line: { color: t.s1, width: 2 }, name: "Pool of this size",
        hovertemplate: "<b>%{y:+.4%}</b>/period, n=%{x}<extra></extra>" },
      { x: [pr.members], y: [d.stats.poolGrowth], type: "scatter", mode: "markers",
        marker: { color: t.s1, size: 9, line: { color: t.surface, width: 2 } },
        name: "Your pool",
        hovertemplate: "<b>%{y:+.4%}</b><extra></extra>" },
    ];

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: { text: "Pool size (members)",
                 font: { color: t.textSecondary, size: 12 } },
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, {
        title: { text: "Growth per period, one member",
                 font: { color: t.textSecondary, size: 12 } },
        tickformat: "+.3%",
      }),
      hovermode: "x unified",
      shapes: [{
        type: "line", xref: "paper", x0: 0, x1: 1, yref: "y",
        y0: poolLimit, y1: poolLimit,
        line: { color: t.deemph, width: 1, dash: "dot" }, layer: "below",
      }, {
        type: "line", x0: pr.members, x1: pr.members, yref: "paper", y0: 0, y1: 1,
        line: { color: t.muted, width: 1 }, layer: "below",
      }],
      annotations: [{
        x: sizes[sizes.length - 1], y: poolLimit,
        text: `infinite pool: ${EP.fmt.pctSigned(poolLimit)}`,
        showarrow: false, xanchor: "right", yanchor: "bottom",
        font: { family: FONT, size: 11, color: t.textPrimary },
        bgcolor: t.surface, borderpad: 3,
      }],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  // -- colour helpers --------------------------------------------------------
  /** rgba() from a hex the browser resolved for us, for 10% area washes. */
  function hexA(hex, alpha) {
    const n = rgbOf(hex);
    return `rgba(${n[0]},${n[1]},${n[2]},${alpha})`;
  }

  function rgbOf(hex) {
    const h = hex.replace("#", "").trim();
    return h.length === 3
      ? h.split("").map((c) => parseInt(c + c, 16))
      : [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }

  /** Linear blend of two hexes, for previewing a point on a colorscale. */
  function mixHex(a, b, tt) {
    const x = rgbOf(a), y = rgbOf(b);
    const mix = x.map((v, i) => Math.round(v + (y[i] - v) * tt));
    return `#${mix.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }

  /** Whichever of the theme's two ink values reads on this background. */
  function readableInk(bg, t) {
    const [r, g, b] = rgbOf(bg).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // 0.18 is where the two candidate inks cross over on contrast ratio.
    return lum > 0.18 ? t.inkOnLight : t.inkOnDark;
  }
  // ==========================================================================
  // Parrondo's paradox
  // ==========================================================================
  /**
   * Drift against the mixing probability -- the diverging pair, since zero is
   * the meaningful reference: above it the mix is a winning game, below it a
   * losing one. Markers name the two pure games (both losing) and the reader's
   * own mix, so the "both endpoints down, the middle up" shape reads at a
   * glance rather than needing the tiles to explain it.
   */
  function paDrift(el, d, pr) {
    const t = theme();
    const { qs, drifts } = d.driftCurve;

    const posY = drifts.map((v) => (v < 0 ? null : v));
    const negY = drifts.map((v) => (v > 0 ? null : v));

    const data = [
      { x: qs, y: negY, type: "scatter", mode: "lines",
        line: { color: t.neg, width: 2 }, fill: "tozeroy",
        fillcolor: hexA(t.neg, 0.1), name: "Losing",
        hovertemplate: "<b>%{y:+.4f}</b> $/round<extra></extra>" },
      { x: qs, y: posY, type: "scatter", mode: "lines",
        line: { color: t.s1, width: 2 }, fill: "tozeroy",
        fillcolor: hexA(t.s1, 0.1), name: "Winning",
        hovertemplate: "<b>%{y:+.4f}</b> $/round<extra></extra>" },
      { x: [0], y: [d.stats.driftA], type: "scatter", mode: "markers",
        marker: { color: t.deemph, size: 8, line: { color: t.surface, width: 2 } },
        name: "Game A alone", hovertemplate: "<b>A alone: %{y:+.4f}</b><extra></extra>" },
      { x: [1], y: [d.stats.driftB], type: "scatter", mode: "markers",
        marker: { color: t.deemph, size: 8, line: { color: t.surface, width: 2 } },
        name: "Game B alone", hovertemplate: "<b>B alone: %{y:+.4f}</b><extra></extra>" },
      { x: [pr.q], y: [d.stats.driftMix], type: "scatter", mode: "markers",
        marker: { color: d.stats.driftMix >= 0 ? t.s1 : t.neg, size: 9,
                  line: { color: t.surface, width: 2 } },
        name: "Your mix", hovertemplate: "<b>your mix: %{y:+.4f}</b><extra></extra>" },
    ];

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: { text: "P(play game B this round)",
                 font: { color: t.textSecondary, size: 12 } },
        tickformat: ".0%",
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, {
        title: { text: "Drift ($/round)", font: { color: t.textSecondary, size: 12 } },
        zeroline: true, zerolinecolor: t.axis, zerolinewidth: 1,
      }),
      hovermode: "x unified",
      shapes: [{
        type: "line", x0: pr.q, x1: pr.q, yref: "paper", y0: 0, y1: 1,
        line: { color: t.muted, width: 1 }, layer: "below",
      }],
      annotations: [{
        x: d.stats.bestQ, y: d.stats.bestDrift, text: `best: q=${EP.fmt.pct(d.stats.bestQ)}`,
        showarrow: false, xanchor: "left", yanchor: "bottom", xshift: 8, yshift: 4,
        font: { family: FONT, size: 11, color: t.textPrimary },
        bgcolor: t.surface, borderpad: 3,
      }],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  /**
   * Three capital walks on the one shared seeded path -- game A alone, game B
   * alone, and the mix -- linear axis, since this is an additive walk like
   * gambler's ruin rather than a multiplicative one.
   */
  function paPaths(el, d, pr) {
    const t = theme();
    const { pathsA, pathsB, pathsMix } = d.sim;
    const xs = indices(pathsA[0].length);

    const data = [
      lineTrace(xs, pathsA[0], {
        line: { color: t.deemph, width: 2 }, name: "Game A alone",
        hovertemplate: "<b>%{y:+.0f}</b>  game A<extra></extra>",
      }),
      lineTrace(xs, pathsB[0], {
        line: { color: t.s2, width: 2 }, name: "Game B alone",
        hovertemplate: "<b>%{y:+.0f}</b>  game B<extra></extra>",
      }),
      lineTrace(xs, pathsMix[0], {
        line: { color: t.s1, width: 2 }, name: `Mixed (q=${EP.fmt.pct(pr.q)})`,
        hovertemplate: "<b>%{y:+.0f}</b>  mixed<extra></extra>",
      }),
    ];

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: { text: "Round", font: { color: t.textSecondary, size: 12 } },
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, {
        title: { text: "Capital ($)", font: { color: t.textSecondary, size: 12 } },
        zeroline: true, zerolinecolor: t.axis, zerolinewidth: 1,
      }),
      hovermode: "x unified",
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  // ==========================================================================
  // Base rates
  // ==========================================================================
  /** P(disease|positive) against prevalence, log-x -- the missing quantity
   *  that decides the whole answer, swept on its own axis. */
  function brPrevalence(el, d, pr) {
    const t = theme();
    const { xs, ys } = d.prevalenceCurve;

    const data = [
      lineTrace(xs, ys, {
        line: { color: t.s1, width: 2 }, name: "P(disease | positive)",
        hovertemplate: "<b>%{y:.1%}</b><extra></extra>",
      }),
      { x: [pr.prior], y: [d.stats.posteriorPos], type: "scatter", mode: "markers",
        marker: { color: t.s1, size: 9, line: { color: t.surface, width: 2 } },
        name: "Your prevalence",
        hovertemplate: "<b>you: %{y:.1%}</b><extra></extra>" },
    ];

    const layout = baseLayout(t, {
      xaxis: axis(t, Object.assign({
        type: "log",
        title: { text: "Prevalence (log scale)", font: { color: t.textSecondary, size: 12 } },
      }, probDecadeTicks(xs[0], xs[xs.length - 1]))),
      yaxis: axis(t, {
        title: { text: "P(disease | positive test)",
                 font: { color: t.textSecondary, size: 12 } },
        tickformat: ".0%", range: [0, 1.02],
      }),
      hovermode: "x unified",
      annotations: [{
        x: Math.log10(pr.prior), y: d.stats.posteriorPos,
        text: `you: ${EP.fmt.pct(d.stats.posteriorPos)}`,
        showarrow: false, xanchor: "left", yanchor: "bottom", xshift: 8, yshift: 4,
        font: { family: FONT, size: 11, color: t.textPrimary },
        bgcolor: t.surface, borderpad: 3,
      }],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  /**
   * The population grid, drawn directly: two stacked bars, "tested positive"
   * and "tested negative", each split into its true/false parts. This is
   * Bayes' theorem as counts instead of a ratio -- the natural-frequency form
   * the story is about.
   */
  function brGrid(el, d) {
    const t = theme();
    const { tp, fp, fn, tn } = d.stats;

    const data = [
      { y: ["Tested positive", "Tested negative"], x: [tp, fn], type: "bar",
        orientation: "h", name: "Actually sick",
        marker: { color: t.s1 },
        hovertemplate: "<b>%{x:,.0f}</b> actually sick<extra></extra>" },
      { y: ["Tested positive", "Tested negative"], x: [fp, tn], type: "bar",
        orientation: "h", name: "Actually healthy",
        marker: { color: t.deemph },
        hovertemplate: "<b>%{x:,.0f}</b> actually healthy<extra></extra>" },
    ];

    const layout = baseLayout(t, {
      barmode: "stack",
      bargap: 0.35,
      margin: { l: 128, r: 24, t: 16, b: 52 },
      xaxis: axis(t, {
        title: { text: "People", font: { color: t.textSecondary, size: 12 } },
        rangemode: "tozero",
      }),
      yaxis: axis(t, { showgrid: false, ticks: "" }),
      hovermode: "closest",
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  // ==========================================================================
  // The birthday problem
  // ==========================================================================
  /** P(collision) against group size, with the 50% line and the reader's own
   *  n marked -- the curve the "23 people" headline number comes off of. */
  function bdCollision(el, d, pr) {
    const t = theme();
    const { xs, ys } = d.collisionCurve;

    const data = [
      lineTrace(xs, ys, {
        line: { color: t.s1, width: 2 }, name: "P(collision)",
        hovertemplate: "<b>%{y:.1%}</b> at n=%{x}<extra></extra>",
      }),
      { x: [pr.n], y: [d.stats.collisionProb], type: "scatter", mode: "markers",
        marker: { color: t.s1, size: 9, line: { color: t.surface, width: 2 } },
        name: "Your group",
        hovertemplate: "<b>you: %{y:.1%}</b><extra></extra>" },
    ];

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: { text: "Group size", font: { color: t.textSecondary, size: 12 } },
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, {
        title: { text: "Chance of a shared birthday",
                 font: { color: t.textSecondary, size: 12 } },
        tickformat: ".0%", range: [0, 1.02],
      }),
      hovermode: "x unified",
      shapes: [{
        type: "line", xref: "paper", x0: 0, x1: 1, yref: "y", y0: 0.5, y1: 0.5,
        line: { color: t.deemph, width: 1, dash: "dot" }, layer: "below",
      }],
      annotations: [{
        x: 1, y: 0.5, xref: "paper", text: "50%", showarrow: false,
        xanchor: "right", yanchor: "bottom", yshift: 2,
        font: { family: FONT, size: 11, color: t.muted },
        bgcolor: t.surface, borderpad: 2,
      }],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  /** The hash-collision extension: bits vs the (approximate) items needed for
   *  50% collision odds, log-y since it spans many orders of magnitude. */
  function bdHash(el, d, pr) {
    const t = theme();
    const { xs, ys } = d.hashBitsCurve;

    const data = [
      lineTrace(xs, ys, {
        line: { color: t.s1, width: 2 }, name: "n for 50% odds (approx)",
        hovertemplate: "<b>%{y:.3e}</b> items<extra></extra>",
      }),
      { x: [pr.bits], y: [d.stats.hashN50], type: "scatter", mode: "markers",
        marker: { color: t.s1, size: 9, line: { color: t.surface, width: 2 } },
        name: "Your digest length",
        hovertemplate: "<b>%{y:.3e}</b><extra></extra>" },
    ];

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: { text: "Digest length (bits)", font: { color: t.textSecondary, size: 12 } },
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, Object.assign({
        type: "log",
        title: { text: "Items needed (log scale)", font: { color: t.textSecondary, size: 12 } },
      }, plainDecadeTicks(Math.max(1, Math.min(...ys)), Math.max(...ys)))),
      hovermode: "x unified",
      shapes: [{
        type: "line", x0: pr.bits, x1: pr.bits, yref: "paper", y0: 0, y1: 1,
        line: { color: t.muted, width: 1 }, layer: "below",
      }],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  // ==========================================================================
  // The secretary problem
  // ==========================================================================
  /** P(win) against the skip threshold, with the optimum and the reader's own
   *  threshold marked -- deliberately flat near the top, which is half the
   *  point: the exact threshold barely matters near the optimum. */
  function secThreshold(el, d, pr) {
    const t = theme();
    const { xs, ys } = d.winCurve;

    const data = [
      lineTrace(xs, ys, {
        line: { color: t.s1, width: 2 }, name: "P(win)",
        hovertemplate: "<b>%{y:.1%}</b> at skip=%{x}<extra></extra>",
      }),
      { x: [d.stats.bestS], y: [d.stats.bestProb], type: "scatter", mode: "markers",
        marker: { color: t.s1, size: 9, line: { color: t.surface, width: 2 } },
        name: "Optimal skip",
        hovertemplate: "<b>optimum: %{y:.1%}</b><extra></extra>" },
      { x: [pr.s], y: [d.stats.winProb], type: "scatter", mode: "markers",
        marker: { color: t.s2, size: 9, line: { color: t.surface, width: 2 } },
        name: "Your skip",
        hovertemplate: "<b>you: %{y:.1%}</b><extra></extra>" },
    ];

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: { text: "Candidates skipped before deciding",
                 font: { color: t.textSecondary, size: 12 } },
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, {
        title: { text: "Chance of choosing the best candidate",
                 font: { color: t.textSecondary, size: 12 } },
        tickformat: ".0%", rangemode: "tozero",
      }),
      hovermode: "x unified",
      annotations: [{
        x: d.stats.bestS, y: d.stats.bestProb, text: `best: skip ${d.stats.bestS}`,
        showarrow: false, xanchor: "left", yanchor: "bottom", xshift: 8, yshift: 4,
        font: { family: FONT, size: 11, color: t.textPrimary },
        bgcolor: t.surface, borderpad: 3,
      }],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  /** Optimal P(win) against n, converging to 1/e -- log-x since the
   *  convergence is a per-decade story. */
  function secAsymptotic(el, d, pr) {
    const t = theme();
    const { ns, ys } = d.asymptotic;
    const invE = 1 / Math.E;

    const data = [
      lineTrace(ns, ys, {
        line: { color: t.s1, width: 2 }, name: "Optimal P(win)",
        hovertemplate: "<b>%{y:.2%}</b> at n=%{x}<extra></extra>",
      }),
      { x: [pr.n], y: [d.stats.bestProb], type: "scatter", mode: "markers",
        marker: { color: t.s1, size: 9, line: { color: t.surface, width: 2 } },
        name: "Your n",
        hovertemplate: "<b>you: %{y:.2%}</b><extra></extra>" },
    ];

    const layout = baseLayout(t, {
      xaxis: axis(t, Object.assign(
        plainDecadeTicks(ns[0], ns[ns.length - 1]),
        {
          type: "log",
          title: { text: "Number of candidates (log scale)",
                   font: { color: t.textSecondary, size: 12 } },
          // Tick decades read better rounded, but the range itself is tight
          // to the actual data -- plainDecadeTicks floors its low end to the
          // decade below (n=5 rounds down to a tick at 1), which would
          // otherwise leave a quarter of the axis blank before the line ever
          // starts.
          range: [Math.log10(ns[0]), Math.log10(ns[ns.length - 1])],
        },
      )),
      yaxis: axis(t, {
        title: { text: "Optimal chance of winning",
                 font: { color: t.textSecondary, size: 12 } },
        tickformat: ".1%",
      }),
      hovermode: "x unified",
      shapes: [{
        type: "line", xref: "paper", x0: 0, x1: 1, yref: "y", y0: invE, y1: invE,
        line: { color: t.deemph, width: 1, dash: "dot" }, layer: "below",
      }],
      annotations: [{
        x: 1, y: invE, xref: "paper", text: `1/e = ${EP.fmt.pct(invE)}`,
        showarrow: false, xanchor: "right", yanchor: "bottom", yshift: 2,
        font: { family: FONT, size: 11, color: t.muted },
        bgcolor: t.surface, borderpad: 2,
      }],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  // ==========================================================================
  // The two-envelope paradox
  // ==========================================================================
  /** Expected gain from swapping against the amount found -- the diverging
   *  pair again, positive below the crossover and negative above it. */
  function teGain(el, d, pr) {
    const t = theme();
    const { xs, gains } = d.gainCurve;

    const posY = gains.map((v) => (v < 0 ? null : v));
    const negY = gains.map((v) => (v > 0 ? null : v));

    const data = [
      { x: xs, y: negY, type: "scatter", mode: "lines",
        line: { color: t.neg, width: 2 }, fill: "tozeroy",
        fillcolor: hexA(t.neg, 0.1), name: "Swapping loses on average",
        hovertemplate: "<b>%{y:$,.2f}</b> expected<extra></extra>" },
      { x: xs, y: posY, type: "scatter", mode: "lines",
        line: { color: t.s1, width: 2 }, fill: "tozeroy",
        fillcolor: hexA(t.s1, 0.1), name: "Swapping gains on average",
        hovertemplate: "<b>%{y:$,.2f}</b> expected<extra></extra>" },
      { x: [pr.x], y: [d.stats.swapGain], type: "scatter", mode: "markers",
        marker: { color: d.stats.swapGain >= 0 ? t.s1 : t.neg, size: 9,
                  line: { color: t.surface, width: 2 } },
        name: "What you found",
        hovertemplate: "<b>%{y:$,.2f}</b><extra></extra>" },
    ];

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: { text: "Amount found in your envelope",
                 font: { color: t.textSecondary, size: 12 } },
        tickprefix: "$", tickformat: ",.0f",
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, {
        title: { text: "Expected gain from swapping",
                 font: { color: t.textSecondary, size: 12 } },
        tickprefix: "$", tickformat: ",.0f",
        zeroline: true, zerolinecolor: t.axis, zerolinewidth: 1,
      }),
      hovermode: "x unified",
      shapes: [{
        type: "line", x0: d.stats.crossover, x1: d.stats.crossover,
        yref: "paper", y0: 0, y1: 1,
        line: { color: t.muted, width: 1, dash: "dot" }, layer: "below",
      }],
      annotations: [{
        x: d.stats.crossover, y: 1, yref: "paper",
        text: `crossover ${EP.fmt.money(d.stats.crossover)}`,
        showarrow: false, xanchor: "left", yanchor: "top", xshift: 6, yshift: -4,
        font: { family: FONT, size: 11, color: t.textSecondary },
        bgcolor: t.surface, borderpad: 3,
      }],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  /** P(you're holding the smaller half) against the amount found, declining
   *  from 50% toward 0% -- why the sign flips on the gain chart above. */
  function teProb(el, d, pr) {
    const t = theme();
    const { xs, probs } = d.gainCurve;

    const data = [
      lineTrace(xs, probs, {
        line: { color: t.s1, width: 2 }, name: "P(smaller half)",
        hovertemplate: "<b>%{y:.1%}</b><extra></extra>",
      }),
      { x: [pr.x], y: [d.stats.pSmaller], type: "scatter", mode: "markers",
        marker: { color: t.s1, size: 9, line: { color: t.surface, width: 2 } },
        name: "What you found",
        hovertemplate: "<b>you: %{y:.1%}</b><extra></extra>" },
    ];

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: { text: "Amount found in your envelope",
                 font: { color: t.textSecondary, size: 12 } },
        tickprefix: "$", tickformat: ",.0f",
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, {
        title: { text: "P(you're holding the smaller half)",
                 font: { color: t.textSecondary, size: 12 } },
        tickformat: ".0%", range: [0, 1.02],
      }),
      hovermode: "x unified",
      shapes: [{
        type: "line", xref: "paper", x0: 0, x1: 1, yref: "y", y0: 0.5, y1: 0.5,
        line: { color: t.deemph, width: 1, dash: "dot" }, layer: "below",
      }],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  // ==========================================================================
  // Optional stopping
  // ==========================================================================
  /** Cumulative false-positive rate against the number of looks, with the
   *  nominal alpha marked -- the Armitage effect, drawn directly. */
  function osCurve(el, d, pr) {
    const t = theme();
    const { xs, ys } = d.fpCurve;

    const data = [
      lineTrace(xs, ys, {
        line: { color: t.neg, width: 2 }, fill: "tozeroy", fillcolor: hexA(t.neg, 0.08),
        name: "Cumulative false-positive rate",
        hovertemplate: "<b>%{y:.1%}</b> by look %{x}<extra></extra>",
      }),
    ];

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: { text: "Look number", font: { color: t.textSecondary, size: 12 } },
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, {
        title: { text: "P(declared significant by now)",
                 font: { color: t.textSecondary, size: 12 } },
        tickformat: ".0%", rangemode: "tozero",
      }),
      hovermode: "x unified",
      shapes: [{
        type: "line", xref: "paper", x0: 0, x1: 1, yref: "y",
        y0: pr.alpha, y1: pr.alpha,
        line: { color: t.axis, width: 1, dash: "dot" }, layer: "below",
      }],
      annotations: [{
        x: 1, y: pr.alpha, xref: "paper", text: `nominal ${EP.fmt.pct(pr.alpha)}`,
        showarrow: false, xanchor: "right", yanchor: "bottom", yshift: 2,
        font: { family: FONT, size: 11, color: t.muted },
        bgcolor: t.surface, borderpad: 2,
      }],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  /** A handful of seeded z-statistic paths against the moving significance
   *  boundary -- gambler's ruin's absorbing walls, redrawn as curves that
   *  move outward with sqrt(n) instead of sitting flat. */
  function osPaths(el, d, pr) {
    const t = theme();
    const { allZ } = d.sim;
    const looks = pr.looks;
    const xs = indices(looks + 1);
    const z = EP.osZThreshold(pr.alpha);

    const boundary = new Array(looks + 1), negBoundary = new Array(looks + 1);
    boundary[0] = null; negBoundary[0] = null;
    for (let k = 1; k <= looks; k++) {
      boundary[k] = z;
      negBoundary[k] = -z;
    }

    const sample = allZ.slice(0, Math.min(allZ.length, 8)).map((zs) => [0, ...zs]);
    const data = [cloudTrace(sample, xs, t.cloud)];
    data.push(lineTrace(xs, boundary, {
      line: { color: t.neg, width: 1, dash: "dot" }, name: "Significance boundary",
      hoverinfo: "skip",
    }));
    data.push(lineTrace(xs, negBoundary, {
      line: { color: t.neg, width: 1, dash: "dot" }, hoverinfo: "skip", showlegend: false,
    }));

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: { text: "Look number", font: { color: t.textSecondary, size: 12 } },
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, {
        title: { text: "z-statistic", font: { color: t.textSecondary, size: 12 } },
        zeroline: true, zerolinecolor: t.axis, zerolinewidth: 1,
      }),
      hovermode: "x unified",
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  // ==========================================================================
  // Simpson's paradox
  // ==========================================================================
  /**
   * Success rate per treatment, in each subgroup and pooled -- grouped bars.
   *
   * The whole point is a comparison that survives twice and dies once, so the
   * two subgroup pairs and the pooled pair must read as different *kinds* of
   * thing rather than as three interchangeable categories. The pooled pair
   * therefore sits behind its own wash with a divider in front of it: it is
   * not a third subgroup, it is the same cases counted again with the
   * subgroup information thrown away.
   *
   * Every bar carries its own number. The aqua/low-contrast relief rule in
   * CLAUDE.md would require that on its own, but here it is load-bearing for
   * a second reason: the pooled flip can be a couple of percentage points,
   * which is a bar-height difference no reader should have to eyeball.
   */
  function simpsonBars(el, d) {
    const t = theme();
    const b = d.bars;
    const groups = b.groups;
    const last = groups.length - 1;

    // Ratios stay ratios in the data; the axis does the percent formatting.
    const bar = (ys, color, name) => ({
      x: groups, y: ys, type: "bar", name,
      marker: { color },
      text: ys.map((v) => EP.fmt.pct(v)),
      textposition: "outside",
      textfont: { family: FONT, size: 11, color: t.textPrimary },
      cliponaxis: false,
      hovertemplate: `<b>%{y:.1%}</b> ${name}, %{x}<extra></extra>`,
    });

    const data = [
      bar(b.a, t.s1, "Treatment A"),
      bar(b.b, t.s2, "Treatment B"),
    ];

    let hi = 0;
    for (const v of b.a.concat(b.b)) if (v > hi) hi = v;

    const pooledA = b.a[last], pooledB = b.b[last];
    const leader = pooledA >= pooledB ? "A" : "B";

    const shapes = [
      // The pooled pair's own ground, so it does not read as subgroup three.
      { type: "rect", xref: "x", x0: last - 0.5, x1: last + 0.5,
        yref: "paper", y0: 0, y1: 1,
        fillcolor: hexA(t.deemph, 0.1), line: { width: 0 }, layer: "below" },
      // ...and a hard divider in front of it.
      { type: "line", xref: "x", x0: last - 0.5, x1: last - 0.5,
        yref: "paper", y0: 0, y1: 1,
        line: { color: t.axis, width: 1 }, layer: "below" },
    ];

    const annotations = [{
      x: groups[last], y: 1, xref: "x", yref: "paper",
      text: b.reverses
        ? `order flips — ${leader} is ahead once the subgroups are merged`
        : `order holds — ${leader} is ahead here too`,
      showarrow: false, xanchor: "right", yanchor: "top", yshift: -4,
      font: { family: FONT, size: 11, color: t.textPrimary },
      bgcolor: t.surface, borderpad: 4,
    }, {
      x: groups[0], y: 1, xref: "x", yref: "paper",
      text: "A ahead in every subgroup",
      showarrow: false, xanchor: "left", yanchor: "top", yshift: -4,
      font: { family: FONT, size: 11, color: t.textSecondary },
      bgcolor: t.surface, borderpad: 4,
    }];

    const layout = baseLayout(t, {
      barmode: "group",
      // 2px of surface between the two bars of a pair, more between pairs.
      bargap: 0.34,
      bargroupgap: 0.1,
      xaxis: axis(t, {
        title: { text: "Case mix", font: { color: t.textSecondary, size: 12 } },
        showgrid: false,
      }),
      yaxis: axis(t, {
        title: { text: "Success rate", font: { color: t.textSecondary, size: 12 } },
        tickformat: ".0%", dtick: 0.2, range: [0, hi + 0.18],
      }),
      hovermode: "closest",
      shapes,
      annotations,
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  /**
   * The exact reversal boundary: the true treatment effect that a given
   * allocation gap can just barely swamp.
   *
   * One curve, and the region under it shaded, because under it is where the
   * paradox lives -- an effect smaller than the confounding budget does not
   * survive pooling. The reader's own (gap, effect) is a marked point, the
   * same "you are here" convention `ruin-curve` and `sec-threshold` use.
   */
  function simpsonBoundary(el, d) {
    const t = theme();
    const bd = d.boundary;
    const { gaps, deltaCrit } = bd;
    const here = bd.reverses ? t.neg : t.s1;

    const data = [
      { x: gaps, y: deltaCrit, type: "scatter", mode: "lines",
        line: { color: t.neg, width: 2 },
        fill: "tozeroy", fillcolor: hexA(t.neg, 0.1),
        name: "Reversal boundary",
        hovertemplate:
          "<b>%{y:.1%}</b> effect needed at a %{x:.0%} allocation gap<extra></extra>" },
      { x: [bd.gapNow], y: [bd.deltaNow], type: "scatter", mode: "markers",
        marker: { color: here, size: 9, line: { color: t.surface, width: 2 } },
        name: "You",
        hovertemplate: "<b>you: %{y:.1%} effect at a %{x:.0%} gap</b><extra></extra>" },
    ];

    let critHi = 0;
    for (const v of deltaCrit) if (v > critHi) critHi = v;
    const yHi = Math.max(critHi, bd.deltaNow, 1e-3) * 1.2;
    const yLo = Math.min(0, bd.deltaNow * 1.2);
    const midGap = gaps[Math.floor(gaps.length / 2)];

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: { text: "Allocation gap between the two treatments",
                 font: { color: t.textSecondary, size: 12 } },
        tickformat: ".0%",
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, {
        title: { text: "True treatment effect (A − B, same in both subgroups)",
                 font: { color: t.textSecondary, size: 12 } },
        tickformat: ".0%", range: [yLo, yHi],
      }),
      hovermode: "x unified",
      shapes: [{
        type: "line", x0: bd.gapNow, x1: bd.gapNow, yref: "paper", y0: 0, y1: 1,
        line: { color: t.muted, width: 1 }, layer: "below",
      }],
      annotations: [
        { x: midGap, y: 0, yref: "y",
          text: "below the line — pooling reverses the trend",
          showarrow: false, xanchor: "center", yanchor: "bottom", yshift: 4,
          font: { family: FONT, size: 11, color: t.textPrimary },
          bgcolor: t.surface, borderpad: 3 },
        { x: 0, y: 1, xref: "paper", yref: "paper",
          text: "above the line — the effect survives pooling",
          showarrow: false, xanchor: "left", yanchor: "top",
          font: { family: FONT, size: 11, color: t.textSecondary },
          bgcolor: t.surface, borderpad: 3 },
        { x: bd.gapNow, y: bd.deltaNow,
          text: `you: ${EP.fmt.pct(bd.deltaNow)} effect`,
          showarrow: false, xanchor: "left", yanchor: "bottom",
          xshift: 8, yshift: 4,
          font: { family: FONT, size: 11, color: t.textPrimary },
          bgcolor: t.surface, borderpad: 3 },
      ],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  // ==========================================================================
  // Bertrand's paradox
  // ==========================================================================
  /** Fixed colour per sampling rule, so a rule keeps its identity across the
   *  curve chart and anything else that names all three at once. */
  const BERTRAND_SERIES = [
    { key: "endpoints", colorKey: "s1", label: "Random endpoints" },
    { key: "radius", colorKey: "s2", label: "Random radius" },
    { key: "midpoint", colorKey: "s3", label: "Random midpoint" },
  ];

  /**
   * P(chord longer than the threshold) against the threshold, one line per
   * definition of "random".
   *
   * The payoff chart: three exact answers to one question, differing
   * everywhere except at the two degenerate ends. The reader's own threshold
   * is a vertical guide with a marker where it meets each curve, so the three
   * numbers can be read off the picture rather than only off the tiles.
   */
  function bertrandCurves(el, d) {
    const t = theme();
    const c = d.curves;

    const data = [];
    for (const s of BERTRAND_SERIES) {
      data.push(lineTrace(c.cs, c[s.key], {
        line: { color: t[s.colorKey], width: 2 }, name: s.label,
        hovertemplate: `<b>%{y:.1%}</b> ${s.label}<extra></extra>`,
      }));
    }
    for (const s of BERTRAND_SERIES) {
      data.push({
        x: [c.cNow], y: [c.pNow[s.key]], type: "scatter", mode: "markers",
        marker: { color: t[s.colorKey], size: 9,
                  line: { color: t.surface, width: 2 } },
        name: `${s.label} at your threshold`,
        hovertemplate: `<b>${s.label}: %{y:.1%}</b><extra></extra>`,
      });
    }

    // Direct labels: three numbers is the entire finding, so they go on the
    // chart rather than only in the legend. They sit left of the guide line
    // because the interesting threshold (the inscribed triangle's side) is
    // close to the right-hand edge.
    const annotations = BERTRAND_SERIES.map((s) => ({
      x: c.cNow, y: c.pNow[s.key],
      text: `${s.label} ${EP.fmt.pct(c.pNow[s.key])}`,
      showarrow: false, xanchor: "right", yanchor: "bottom",
      xshift: -8, yshift: 4,
      font: { family: FONT, size: 11, color: t.textPrimary },
      bgcolor: t.surface, borderpad: 3,
    }));

    const layout = baseLayout(t, {
      xaxis: axis(t, {
        title: { text: "Threshold: chord length ÷ diameter",
                 font: { color: t.textSecondary, size: 12 } },
        tickformat: ".1f", dtick: 0.1, range: [0, 1],
        showspikes: true, spikemode: "across", spikethickness: 1,
        spikecolor: t.axis, spikedash: "solid",
      }),
      yaxis: axis(t, {
        title: { text: "P(a random chord is longer than that)",
                 font: { color: t.textSecondary, size: 12 } },
        tickformat: ".0%", range: [0, 1.02],
      }),
      hovermode: "x unified",
      shapes: [{
        type: "line", x0: c.cNow, x1: c.cNow, yref: "paper", y0: 0, y1: 1,
        line: { color: t.muted, width: 1 }, layer: "below",
      }],
      annotations,
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  /** Points on a circle of radius r, closed, for drawing it as a trace. */
  function circlePoints(r, n) {
    const x = new Array(n + 1), y = new Array(n + 1);
    for (let i = 0; i <= n; i++) {
      const a = (2 * Math.PI * i) / n;
      x[i] = r * Math.cos(a);
      y[i] = r * Math.sin(a);
    }
    return { x, y };
  }

  /**
   * Every chord of one class (long or short) as ONE trace, with null
   * separators between segments -- the same trick `cloudTrace` uses on the
   * trajectory charts, and for the same reason: a few hundred two-point
   * traces is a few hundred lots of per-trace overhead for one visual object,
   * and the redraw crawls.
   */
  function chordTrace(c, keepLong, color, name) {
    const x = [], y = [];
    for (let i = 0; i < c.x0.length; i++) {
      if (!!c.long[i] !== keepLong) continue;
      x.push(c.x0[i], c.x1[i], null);
      y.push(c.y0[i], c.y1[i], null);
    }
    return {
      x, y, type: "scatter", mode: "lines",
      line: { color: hexA(color, 0.45), width: 1 },
      name, hoverinfo: "skip", showlegend: false,
    };
  }

  /**
   * The sampled chords themselves, as a diagram rather than a plot.
   *
   * Two things are load-bearing here. First, the axes are locked to equal
   * aspect (`scaleanchor`/`scaleratio`): a circle drawn as an ellipse would
   * make every "is this uniform?" judgement the chart invites into a lie.
   * Second, the ticks and grid are off entirely -- the coordinates carry no
   * meaning, only the shape of the cloud does, so axis chrome here is pure
   * noise dressed up as precision.
   *
   * The midpoint cloud is the real lesson: the same circle, the same
   * question, and three visibly different distributions of where the chords'
   * middles land. So the midpoints are drawn as full-strength dots over
   * washed-out chord strokes, not the other way round.
   */
  function bertrandChords(el, d) {
    const t = theme();
    const c = d.chords;
    const n = c.x0.length;

    let nLong = 0;
    for (let i = 0; i < n; i++) if (c.long[i]) nLong++;

    // A chord clears the threshold exactly when its midpoint is closer to the
    // centre than sqrt(1 - c^2) -- so the cloud is separable by eye, and this
    // circle is the line it is separable along.
    const uThresh = Math.sqrt(Math.max(0, 1 - c.cNow * c.cNow));
    const outer = circlePoints(1, 180);
    const inner = circlePoints(uThresh, 180);

    const mids = (keepLong, color, name) => {
      const x = [], y = [], cd = [];
      for (let i = 0; i < n; i++) {
        if (!!c.long[i] !== keepLong) continue;
        x.push(c.mx[i]); y.push(c.my[i]);
        cd.push(Math.hypot(c.mx[i], c.my[i]));
      }
      return {
        x, y, type: "scatter", mode: "markers",
        marker: { color, size: 6, line: { color: t.surface, width: 1 } },
        name, showlegend: false, customdata: cd,
        hovertemplate:
          `<b>${name}</b><br>midpoint %{customdata:.3f} from the centre<extra></extra>`,
      };
    };

    const data = [
      { x: outer.x, y: outer.y, type: "scatter", mode: "lines",
        line: { color: t.axis, width: 1 },
        hoverinfo: "skip", showlegend: false },
      { x: inner.x, y: inner.y, type: "scatter", mode: "lines",
        line: { color: t.deemph, width: 1, dash: "dot" },
        hoverinfo: "skip", showlegend: false },
      chordTrace(c, false, t.s2, "Shorter chord"),
      chordTrace(c, true, t.s1, "Longer chord"),
      mids(false, t.s2, "Short chord"),
      mids(true, t.s1, "Long chord"),
    ];

    // Equal aspect and no chrome. `constrain: "domain"` keeps the locked
    // aspect from stretching the plotting area past the card instead of
    // letting the shorter axis give up its spare room.
    const blank = {
      showgrid: false, zeroline: false, showline: false,
      showticklabels: false, ticks: "",
      range: [-1.08, 1.08], constrain: "domain",
    };

    const layout = baseLayout(t, {
      margin: { l: 16, r: 16, t: 16, b: 16 },
      xaxis: Object.assign({}, blank),
      yaxis: Object.assign({}, blank, { scaleanchor: "x", scaleratio: 1 }),
      hovermode: "closest",
      annotations: [
        { x: 0, y: 1, xref: "paper", yref: "paper", text: c.label,
          showarrow: false, xanchor: "left", yanchor: "top",
          font: { family: FONT, size: 12, color: t.textPrimary },
          bgcolor: t.surface, borderpad: 3 },
        { x: 0, y: 0, xref: "paper", yref: "paper",
          text: `${EP.fmt.count(nLong)} of ${EP.fmt.count(n)} chords ` +
                `(${EP.fmt.pct(n ? nLong / n : 0)}) clear the threshold`,
          showarrow: false, xanchor: "left", yanchor: "bottom",
          font: { family: FONT, size: 11, color: t.textSecondary },
          bgcolor: t.surface, borderpad: 3 },
      ],
    });

    return Plotly.react(el, data, layout, CONFIG);
  }

  Object.assign(EP, {
    // SAMPLE_PATHS is engine.js's -- charts.js only reads it.
    trajectory, histogram, sweep, theme, FLOOR, RUIN_PATHS,
    ruinWalks, ruinOdds, ruinBoldness, spRunningMean, spContributions,
    pdScores, pdHeatmap, pdShares, strategyColors,
    mhKnow, mhDoors, sdPaths, sdSweep, insBand, insPool,
    paDrift, paPaths, brPrevalence, brGrid, bdCollision, bdHash,
    secThreshold, secAsymptotic, teGain, teProb, osCurve, osPaths,
    simpsonBars, simpsonBoundary, bertrandCurves, bertrandChords,
    BERTRAND_SERIES,
  });
})(window.EP);
