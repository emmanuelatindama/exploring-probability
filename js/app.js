/* Page wiring: scenario picker, the filter row, KPI tiles, charts, table views.
 *
 * Series/category labels go into the DOM via textContent, never innerHTML string
 * concatenation -- they are treated as untrusted data on principle, so that this
 * stays true when a future scenario's labels come from a data file.
 *
 * The chart dispatch is a registry keyed by chart kind (CHART_KINDS below), not
 * a chain of conditionals: a scenario names the kinds it wants, each kind knows
 * how to draw itself, its legend and its table view from the scenario's computed
 * data, and neither side has to know how many of the other exist.
 */
(function (EP) {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const state = { id: null, values: {}, sim: null };

  const getVar = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // -- theme ----------------------------------------------------------------
  const THEME_KEY = "ep-theme";

  function systemDark() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function applyTheme(mode) {
    document.documentElement.setAttribute("data-theme", mode);
    const btn = $("#theme-toggle");
    btn.textContent = mode === "dark" ? "Light mode" : "Dark mode";
    btn.setAttribute("aria-label", `Switch to ${mode === "dark" ? "light" : "dark"} mode`);
  }

  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* private mode */ }
    applyTheme(saved || (systemDark() ? "dark" : "light"));
    $("#theme-toggle").addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "dark"
        ? "light" : "dark";
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
      render(); // charts read their colors from CSS, so they must redraw
    });
  }

  // -- scenario picker ------------------------------------------------------
  function buildPicker() {
    const nav = $("#picker");
    nav.textContent = "";
    for (const sc of EP.SCENARIOS) {
      const b = el("button", null, sc.name);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.dataset.id = sc.id;
      if (sc.status === "planned") {
        b.appendChild(el("span", "soon", "planned"));
      }
      b.addEventListener("click", () => selectScenario(sc.id));
      nav.appendChild(b);
    }
  }

  function markPicker() {
    for (const b of $("#picker").querySelectorAll("button")) {
      b.setAttribute("aria-selected", b.dataset.id === state.id ? "true" : "false");
    }
  }

  function selectScenario(id) {
    const sc = EP.byId(id);
    if (!sc) return;
    state.id = id;
    state.values = EP.defaultValues(sc);
    delete state.seed; // Reset also means back to the reproducible default draw.
    if (location.hash.slice(1) !== id) history.replaceState(null, "", `#${id}`);
    markPicker();
    buildBody(sc);
    render();
  }

  // -- body -----------------------------------------------------------------
  function buildBody(sc) {
    $("#sc-title").textContent = sc.name;
    $("#sc-blurb").textContent = sc.blurb;
    const body = $("#scenario-body");
    body.textContent = "";

    if (sc.story) {
      const story = el("aside", "story");
      story.appendChild(el("h3", null, "Where this comes from"));
      story.appendChild(el("p", null, sc.story));
      body.appendChild(story);
    }

    if (sc.status !== "ready") {
      const box = el("div", "card planned");
      box.appendChild(el("span", "badge", "Not built yet"));
      box.appendChild(el("p", null, sc.note));
      body.appendChild(box);
      return;
    }

    body.appendChild(buildControls(sc));
    const tiles = el("div", "tiles");
    tiles.id = "tiles";
    body.appendChild(tiles);

    for (const kind of sc.charts) {
      body.appendChild(buildCard(kind));
    }
    body.appendChild(el("p", "note", sc.note));
  }

  function buildCard(kind) {
    const meta = CHART_KINDS[kind];
    const card = el("div", "card");
    card.appendChild(el("h3", null, meta.title));
    card.appendChild(el("p", "cap", meta.cap));

    const plot = el("div", `plot${meta.short ? " short" : ""}${meta.tall ? " tall" : ""}`);
    plot.id = `plot-${kind}`;
    card.appendChild(plot);

    const legend = el("div", "legend");
    legend.id = `legend-${kind}`;
    card.appendChild(legend);

    const details = el("details", "table-view");
    details.appendChild(el("summary", null, "Table view"));
    const holder = el("div");
    holder.id = `table-${kind}`;
    details.appendChild(holder);
    card.appendChild(details);
    return card;
  }

  // -- controls -------------------------------------------------------------
  function buildControls(sc) {
    const row = el("div", "controls");

    for (const c of sc.controls) {
      const box = el("div", "ctl");
      const id = `ctl-${c.key}`;

      const label = el("label", null, c.label);
      label.setAttribute("for", id);
      box.appendChild(label);

      const val = el("div", "val", c.fmt(state.values[c.key]));
      val.id = `${id}-val`;
      box.appendChild(val);

      const input = document.createElement("input");
      input.type = "range";
      input.id = id;
      input.min = c.min; input.max = c.max; input.step = c.step;
      input.value = state.values[c.key];
      input.setAttribute("aria-label", c.label);
      input.addEventListener("input", () => {
        state.values[c.key] = parseFloat(input.value);
        val.textContent = c.fmt(state.values[c.key]);
        scheduleRender();
      });
      box.appendChild(input);
      row.appendChild(box);
    }

    const actions = el("div", "ctl-actions");

    const reseed = el("button", "ghost", "New random draw");
    reseed.type = "button";
    reseed.addEventListener("click", () => {
      state.seed = (Math.random() * 0x7fffffff) | 0;
      render();
    });
    actions.appendChild(reseed);

    const reset = el("button", "ghost", "Reset");
    reset.type = "button";
    reset.addEventListener("click", () => selectScenario(sc.id));
    actions.appendChild(reset);

    row.appendChild(actions);
    return row;
  }

  // -- chart registry -------------------------------------------------------
  /** rgba() from a resolved hex, for band swatches. */
  function withAlpha(hex, alpha) {
    const h = hex.replace("#", "");
    const n = h.length === 3
      ? h.split("").map((c) => parseInt(c + c, 16))
      : [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return `rgba(${n[0]},${n[1]},${n[2]},${alpha})`;
  }

  const F = () => EP.fmt;

  /**
   * One entry per chart form.
   *
   *   title / cap    card heading and caption
   *   short / tall   plot height class
   *   render(el, d, pr) -> { plot, legend, table }
   *
   * `d` is whatever the scenario's compute() returned, so a chart form reads its
   * own data by name and never touches the engine or the scenario list.
   */
  const CHART_KINDS = {
    trajectory: {
      title: "Every player's wealth over time",
      cap: "Log scale — on a linear axis one lucky path would flatten all the others into the floor.",
      render: (node, d, pr) => ({
        plot: EP.trajectory(node, d.sim, d.pathStats, pr),
        legend: [
          { color: getVar("--series-1"), label: "Median — the typical player" },
          { color: getVar("--series-2"),
            label: `Mean of these ${F().count(pr.nPaths)} players` },
          { shape: "band", fill: withAlpha(getVar("--series-1"), 0.18),
            label: "Middle 50% of players" },
          { shape: "band", fill: withAlpha(getVar("--series-1"), 0.1),
            label: "Middle 90% of players" },
          { color: getVar("--deemphasis"),
            label: `${Math.min(pr.nPaths, EP.SAMPLE_PATHS)} individual players` },
        ],
        table: tableTrajectory(d.pathStats, pr),
      }),
    },

    histogram: {
      title: "Where everyone ended up",
      cap: "Log-spaced bins. The distribution is heavily right-skewed, which is why the mean sits so far from the bulk.",
      render: (node, d, pr) => ({
        plot: EP.histogram(node, d.hist, d.stats, pr),
        legend: [
          { color: getVar("--series-1"), shape: "rect",
            label: `Players per wealth bin (${F().count(pr.nPaths)} total)` },
        ],
        table: tableHistogram(d.hist, pr),
      }),
    },

    sweep: {
      title: "Long-run growth vs how much you stake",
      cap: "Closed form, not simulated — this is the exact growth rate for every possible bet size.",
      short: true,
      render: (node, d, pr) => ({
        plot: EP.sweep(node, d.sweep, pr),
        legend: [
          { color: getVar("--series-1"), label: "Wealth grows over time" },
          { color: getVar("--diverging-neg"), label: "Wealth shrinks over time" },
        ],
        table: tableSweep(d.sweep, pr),
      }),
    },

    "ruin-paths": {
      title: "Bankrolls walking between two walls",
      cap: "Linear scale, unlike the multiplicative tabs: this game moves by a fixed number of dollars, and both walls are absorbing — a path that touches either one stops there for good.",
      render: (node, d, pr) => ({
        plot: EP.ruinWalks(node, d, pr),
        legend: [
          { color: getVar("--series-1"),
            label: `Median of all ${F().count(pr.nPaths)} players` },
          { color: getVar("--deemphasis"),
            label: `${Math.min(pr.nPaths, EP.RUIN_PATHS)} individual players` },
          { color: getVar("--diverging-neg"), label: "Broke — absorbing" },
          { color: getVar("--series-3"), label: "Target — absorbing" },
        ],
        table: tableRuinPaths(d, pr),
      }),
    },

    "ruin-curve": {
      title: "Chance of ruin vs the bankroll you start with",
      cap: "Closed form, not simulated. The gap between the two lines is what the house edge is worth.",
      short: true,
      render: (node, d, pr) => ({
        plot: EP.ruinOdds(node, d, pr),
        legend: [
          { color: getVar("--series-1"),
            label: `This coin (${F().pct(pr.p)} to win)` },
          { color: getVar("--deemphasis"), label: "A perfectly fair coin" },
          { color: getVar("--series-1"), shape: "dot",
            label: `Where you start (${F().money(pr.bankroll)})` },
        ],
        table: tableRuinCurve(d, pr),
      }),
    },

    "ruin-bet": {
      title: "Chance of ruin vs how much you bet each round",
      cap: "Closed form. Which way this curve slopes is decided entirely by the sign of your edge.",
      short: true,
      render: (node, d, pr) => {
        const adverse = pr.p < 0.5;
        const c = adverse ? getVar("--diverging-neg") : getVar("--series-1");
        return {
          plot: EP.ruinBoldness(node, d, pr),
          legend: [
            { color: c,
              label: adverse
                ? "Chance of ruin — falls as you bet bigger"
                : "Chance of ruin — rises as you bet bigger" },
            { color: c, shape: "dot", label: `Your bet (${F().money(pr.bet)})` },
          ],
          table: tableRuinBet(d, pr),
        };
      },
    },

    "sp-mean": {
      title: "The running average, refusing to settle",
      cap: "Both axes are logarithmic. Every player's average payout so far, over their whole run of games.",
      render: (node, d, pr) => ({
        plot: EP.spRunningMean(node, d, pr),
        legend: [
          { color: getVar("--series-1"), label: "One player, highlighted" },
          { color: getVar("--deemphasis"),
            label: `The other ${Math.max(0, pr.runs - 1)} players` },
          { color: getVar("--series-2"),
            label: "Where the average is predicted to loiter" },
        ],
        table: tableSpMean(d, pr),
      }),
    },

    "sp-octaves": {
      title: "What each outcome contributes to the expected value",
      cap: "Payout times probability, one bar per possible game length. A flat row of bars is a sum that never converges.",
      render: (node, d, pr) => ({
        plot: EP.spContributions(node, d, pr),
        legend: [
          { color: getVar("--series-1"), shape: "rect",
            label: "Contribution to the expected payout" },
        ],
        table: tableSpOctaves(d, pr),
      }),
    },

    "pd-scores": {
      title: "Who won the tournament",
      cap: "Average points per round across every match, including one against a copy of itself. Exact, not simulated.",
      short: true,
      render: (node, d, pr) => ({
        plot: EP.pdScores(node, d, pr),
        legend: strategyLegend(),
        table: tablePdScores(d, pr),
      }),
    },

    "pd-matrix": {
      title: "Every matchup",
      cap: "Row scores against column, in points per round. Darker is a higher score; every cell carries its number.",
      render: (node, d, pr) => ({
        plot: EP.pdHeatmap(node, d, pr),
        legend: [
          { color: withAlpha(getVar("--series-1"), 0.12), shape: "rect",
            label: "Lower score" },
          { color: getVar("--series-1"), shape: "rect", label: "Higher score" },
        ],
        table: tablePdMatrix(d, pr),
      }),
    },

    "pd-shares": {
      title: "Letting the winners breed",
      cap: "Replicator dynamics: each generation, a strategy's share grows in proportion to how well it does against the current mix.",
      render: (node, d, pr) => ({
        plot: EP.pdShares(node, d, pr),
        legend: strategyLegend(),
        table: tablePdShares(d, pr),
      }),
    },
  };

  /** Shared legend for the two charts that colour by strategy. */
  function strategyLegend() {
    const cols = EP.strategyColors(EP.theme());
    return EP.STRATEGIES.map((id) => ({
      color: cols[id], shape: "rect",
      label: `${EP.STRATEGY_LABELS[id]} — ${EP.STRATEGY_NOTES[id]}`,
    }));
  }

  // -- render ---------------------------------------------------------------
  let pending = null;

  /** Coalesce slider input into one render per frame; hold the old chart at
   *  reduced opacity meanwhile rather than flashing a skeleton. */
  function scheduleRender() {
    const body = $("#scenario-body");
    body.classList.add("busy");
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      pending = null;
      render();
    });
  }

  function render() {
    const sc = EP.byId(state.id);
    if (!sc || sc.status !== "ready") return;

    const pr = EP.resolveParams(sc, state.values);
    if (state.seed !== undefined) pr.seed = state.seed;

    const d = sc.compute(pr);
    renderTiles(sc, pr, d.stats);

    const jobs = [];
    for (const kind of sc.charts) {
      const node = $(`#plot-${kind}`);
      if (!node) continue;
      const out = CHART_KINDS[kind].render(node, d, pr);
      jobs.push(out.plot);
      legendFor(kind, out.legend);
      buildTable(`table-${kind}`, out.table.head, out.table.rows);
    }

    Promise.all(jobs).then(() => {
      $("#scenario-body").classList.remove("busy");
    });
  }

  function renderTiles(sc, pr, stats) {
    const holder = $("#tiles");
    if (!holder) return;
    holder.textContent = "";
    for (const t of sc.tiles(pr, stats)) {
      const tile = el("div", "tile");
      tile.appendChild(el("div", "label", t.label));
      tile.appendChild(el("div", "value", t.value));
      if (t.note) tile.appendChild(el("div", "note", t.note));
      holder.appendChild(tile);
    }
  }

  /** Legend keys mirror the mark they stand for: a 2px stroke for lines, a
   *  filled block for bars and bands, a dot for point markers. Always present
   *  for >=2 series; a single-series chart still gets one row naming the marks. */
  function legendFor(kind, items) {
    const holder = document.getElementById(`legend-${kind}`);
    if (!holder) return;
    holder.textContent = "";
    for (const it of items) {
      const row = el("div", "item");
      const key = el("span", "key");
      key.style.background = it.fill || it.color;
      if (it.shape === "rect") {
        key.style.height = "10px";
        key.style.borderRadius = "2px";
      } else if (it.shape === "band") {
        key.style.height = "10px";
        key.style.borderRadius = "2px";
        key.style.opacity = "0.85";
      } else if (it.shape === "dot") {
        key.style.height = "10px";
        key.style.width = "10px";
        key.style.borderRadius = "50%";
      }
      row.appendChild(key);
      row.appendChild(el("span", null, it.label));
      holder.appendChild(row);
    }
  }

  // -- table views ----------------------------------------------------------
  /** Table builders return { head, rows } so a chart kind can hand one back
   *  without knowing where in the DOM it will land. */
  function buildTable(holderId, head, rows) {
    const holder = document.getElementById(holderId);
    if (!holder) return;
    holder.textContent = "";
    const table = el("table");
    const thead = el("thead");
    const hr = el("tr");
    for (const h of head) hr.appendChild(el("th", null, h));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tb = el("tbody");
    for (const r of rows) {
      const tr = el("tr");
      for (const c of r) tr.appendChild(el("td", null, c));
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    holder.appendChild(table);
  }

  /** Round numbers to sample for a time-series table, ~10 rows plus the end. */
  function sampledRounds(rounds) {
    const stepSize = Math.max(1, Math.round(rounds / 10));
    const out = [];
    for (let t = 0; t <= rounds; t += stepSize) out.push(t);
    if (out[out.length - 1] !== rounds) out.push(rounds);
    return out;
  }

  function tableTrajectory(ps, pr) {
    const rows = sampledRounds(pr.rounds).map((t) => [
      String(t), F().money(ps.q05[t]), F().money(ps.q25[t]),
      F().money(ps.median[t]), F().money(ps.q75[t]),
      F().money(ps.q95[t]), F().money(ps.mean[t]),
    ]);
    return {
      head: ["Round", "5th pct", "25th pct", "Median", "75th pct", "95th pct", "Mean"],
      rows,
    };
  }

  function tableHistogram(hist, pr) {
    const rows = hist.counts.map((c, i) => [
      `${F().money(Math.pow(10, hist.edges[i]))} – ${F().money(Math.pow(10, hist.edges[i + 1]))}`,
      F().count(c),
      F().pct(c / pr.nPaths),
    ]).filter((r, i) => hist.counts[i] > 0);
    return { head: ["Final wealth", "Players", "Share"], rows };
  }

  function tableSweep(sw, pr) {
    const rows = [];
    for (let i = 0; i < sw.fs.length; i += Math.max(1, Math.round(sw.fs.length / 12))) {
      const g = sw.g[i];
      rows.push([
        F().pct(sw.fs[i]),
        isFinite(g) ? F().pctSigned(g) : "ruin",
        isFinite(g) ? F().money(pr.w0 * Math.exp(g * pr.rounds)) : "$0",
      ]);
    }
    return {
      head: ["Stake", "Growth per round", `Median wealth after ${pr.rounds} rounds`],
      rows,
    };
  }

  function tableRuinPaths(d, pr) {
    const { sim, walk } = d;
    const { paths, stride, nPaths, bet, n } = sim;
    const rows = sampledRounds(pr.rounds).map((t) => {
      // Counted from the paths themselves rather than from the absorption round,
      // so the column always agrees with what the chart is drawing.
      let broke = 0, won = 0;
      for (let i = 0; i < nPaths; i++) {
        const v = paths[i * stride + t];
        if (v <= 0) broke++;
        else if (v >= n) won++;
      }
      return [
        String(t),
        F().money(walk.q05[t] * bet), F().money(walk.median[t] * bet),
        F().money(walk.q95[t] * bet),
        F().pct(broke / nPaths), F().pct(won / nPaths),
      ];
    });
    return {
      head: ["Round", "5th pct", "Median", "95th pct", "Broke", "At target"],
      rows,
    };
  }

  function tableRuinCurve(d, pr) {
    const { curve } = d;
    const step = Math.max(1, Math.round(curve.ks.length / 14));
    const rows = [];
    for (let i = 0; i < curve.ks.length; i += step) {
      const k = curve.ks[i];
      const fair = k === 0 ? 1 : k === curve.n ? 0 : 1 - k / curve.n;
      rows.push([
        F().money(k * curve.bet), F().pct(curve.ruin[i]), F().pct(fair),
        F().pctSigned(curve.ruin[i] - fair),
      ]);
    }
    return {
      head: ["Starting bankroll", "This coin", "Fair coin", "Cost of the edge"],
      rows,
    };
  }

  function tableRuinBet(d, pr) {
    const { betCurve } = d;
    const step = Math.max(1, Math.round(betCurve.sizes.length / 14));
    const rows = [];
    for (let i = 0; i < betCurve.sizes.length; i += step) {
      const b = betCurve.sizes[i];
      rows.push([
        F().money(b), F().pct(betCurve.ruin[i]),
        F().count(EP.ruinDuration(pr.bankroll, pr.target, pr.p, b)),
      ]);
    }
    return {
      head: ["Bet per round", "Chance of ruin", "Expected rounds"],
      rows,
    };
  }

  function tableSpMean(d, pr) {
    const { sim } = d;
    const step = Math.max(1, Math.round(sim.xs.length / 14));
    const rows = [];
    for (let i = 0; i < sim.xs.length; i += step) {
      let lo = Infinity, hi = -Infinity;
      for (const c of sim.curves) {
        if (c[i] < lo) lo = c[i];
        if (c[i] > hi) hi = c[i];
      }
      rows.push([
        F().count(sim.xs[i]), F().money(sim.curves[0][i]),
        F().money(lo), F().money(hi),
      ]);
    }
    return {
      head: ["Games played", "Highlighted player", "Lowest player", "Highest player"],
      rows,
    };
  }

  function tableSpOctaves(d, pr) {
    const rows = d.tiers.map((r) => [
      String(r.tier), F().money(r.payout),
      `${(r.prob * 100).toFixed(r.prob < 0.001 ? 4 : 2)}%`,
      F().money(r.contribution), F().money(r.cumulative),
    ]);
    return {
      head: ["Tosses", "Pays", "Happens", "Adds to the expectation", "Running total"],
      rows,
    };
  }

  function tablePdScores(d, pr) {
    const rows = EP.STRATEGIES
      .map((id, i) => ({ id, score: d.stats.scores[i] }))
      .sort((a, b) => b.score - a.score)
      .map((r, rank) => [
        `${rank + 1}. ${EP.STRATEGY_LABELS[r.id]}`,
        F().num(r.score),
        F().num(r.score * pr.rounds * EP.STRATEGIES.length, 0),
        EP.STRATEGY_NOTES[r.id],
      ]);
    return {
      head: ["Strategy", "Points per round", "Points in total", "How it plays"],
      rows,
    };
  }

  function tablePdMatrix(d, pr) {
    const labels = EP.STRATEGIES.map((s) => EP.STRATEGY_LABELS[s]);
    const rows = d.stats.matrix.map((row, i) =>
      [labels[i]].concat(row.map((v) => F().num(v))));
    return { head: ["Scores…"].concat(labels.map((l) => `vs ${l}`)), rows };
  }

  function tablePdShares(d, pr) {
    const hist = d.stats.shares;
    const step = Math.max(1, Math.round(hist.length / 12));
    const rows = [];
    for (let g = 0; g < hist.length; g += step) {
      rows.push([String(g)].concat(hist[g].map((v) => F().pct(v))));
    }
    const last = hist.length - 1;
    if (rows[rows.length - 1][0] !== String(last)) {
      rows.push([String(last)].concat(hist[last].map((v) => F().pct(v))));
    }
    return {
      head: ["Generation"].concat(EP.STRATEGIES.map((s) => EP.STRATEGY_LABELS[s])),
      rows,
    };
  }

  // -- boot -----------------------------------------------------------------
  function boot() {
    initTheme();
    buildPicker();
    const fromHash = location.hash.slice(1);
    selectScenario(EP.byId(fromHash) ? fromHash : EP.SCENARIOS[0].id);
    window.addEventListener("resize", () => {
      if (window.Plotly) {
        document.querySelectorAll(".plot").forEach((p) => Plotly.Plots.resize(p));
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window.EP);
