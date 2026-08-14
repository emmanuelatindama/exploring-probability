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

    if (sc.mathBox) {
      const details = el("details", "math-box");
      details.appendChild(el("summary", null, "For math enthusiasts"));
      const pre = el("pre");
      pre.id = "math-box-lines";
      details.appendChild(pre);
      body.appendChild(details);
    }
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

      const isSelect = (c.type || "range") === "select";

      // The dropdown already shows the chosen label, so the separate value
      // readout (needed for a slider, whose handle carries no text) would
      // just repeat it -- skip it for select controls.
      let val = null;
      if (!isSelect) {
        val = el("div", "val", c.fmt(state.values[c.key]));
        val.id = `${id}-val`;
        box.appendChild(val);
      }

      if (isSelect) {
        // <select> control for categorical choices (tickers, etc.)
        const select = document.createElement("select");
        select.id = id;
        select.setAttribute("aria-label", c.label);
        for (const opt of (c.options || [])) {
          const option = document.createElement("option");
          option.value = opt.value;
          option.textContent = opt.label || opt.value;
          select.appendChild(option);
        }
        select.value = state.values[c.key];
        select.addEventListener("change", () => {
          state.values[c.key] = select.value;
          scheduleRender();
        });
        box.appendChild(select);
      } else {
        // <input type="range"> slider (default)
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
      }
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

    "mh-know": {
      title: "Switching vs staying, as the host's knowledge changes",
      cap: "Closed form. The two lines meet at know=0 — a host who reveals a goat by luck has told you nothing.",
      short: true,
      render: (node, d, pr) => ({
        plot: EP.mhKnow(node, d, pr),
        legend: [
          { color: getVar("--series-1"), label: "Switching" },
          { color: getVar("--deemphasis"), label: "Staying" },
          { color: getVar("--series-1"), shape: "dot",
            label: `Your dial (${F().pct(pr.know)})` },
        ],
        table: tableMhKnow(d, pr),
      }),
    },

    "mh-doors": {
      title: "Switching's edge vs the number of doors",
      cap: "Closed form. More doors grow a knowing host's advantage; they cannot create one for a host who reveals goats by chance.",
      short: true,
      render: (node, d, pr) => ({
        plot: EP.mhDoors(node, d, pr),
        legend: [
          { color: getVar("--series-1"), label: "Knowing host" },
          { color: getVar("--deemphasis"), label: "Random host" },
          { color: getVar("--series-1"), shape: "dot",
            label: `Your board (${F().count(pr.doors)} doors)` },
        ],
        table: tableMhDoors(d, pr),
      }),
    },

    "sd-paths": {
      title: "The stock, held plain vs held and rebalanced",
      cap: "Log scale, one seeded price path shared by all three lines.",
      render: (node, d, pr) => ({
        plot: EP.sdPaths(node, d, pr),
        legend: [
          { color: getVar("--deemphasis"), label: "Stock alone" },
          { color: getVar("--series-2"), label: "Buy and hold the mix" },
          { color: getVar("--series-1"),
            label: `Rebalanced every ${pr.interval} period(s)` },
        ],
        table: tableSdPaths(d, pr),
      }),
    },

    "sd-sweep": {
      title: "Volatility harvested vs the rebalancing interval",
      cap: "Closed form, not simulated — the exact growth rate for every possible interval, relative to buy-and-hold.",
      short: true,
      render: (node, d, pr) => ({
        plot: EP.sdSweep(node, d, pr),
        legend: [
          { color: getVar("--series-1"), label: "Harvests volatility" },
          { color: getVar("--diverging-neg"), label: "Costs more than it harvests" },
        ],
        table: tableSdSweep(d, pr),
      }),
    },

    "ins-band": {
      title: "What the premium is worth to each side",
      cap: "Closed form. Value is growth-equivalent dollars per period — where both curves clear zero, both sides have improved.",
      render: (node, d, pr) => ({
        plot: EP.insBand(node, d, pr),
        legend: [
          { color: getVar("--series-1"), label: "Buyer's value" },
          { color: getVar("--series-3"), label: "Seller's value" },
          { shape: "band", fill: withAlpha(getVar("--series-1"), 0.12),
            label: "Both sides improve here" },
        ],
        table: tableInsBand(d, pr),
      }),
    },

    "ins-pool": {
      title: "One member's growth rate vs the pool's size",
      cap: "Closed form. No counterparty here — every member carries an equal share of however many losses land.",
      short: true,
      render: (node, d, pr) => ({
        plot: EP.insPool(node, d, pr),
        legend: [
          { color: getVar("--series-1"), label: "Pool of this size" },
          { color: getVar("--deemphasis"), label: "Infinite-pool limit" },
        ],
        table: tableInsPool(d, pr),
      }),
    },

    "wheel-paths": {
      title: "One account, four strategies, the same stock",
      cap: "Log scale. Markers show the wheel's own major transitions — worthless expiries and take-profit closes are far too frequent to mark, and are left to the table view.",
      render: (node, d, pr) => ({
        plot: EP.wheelPaths(node, d, pr),
        legend: [
          { color: getVar("--deemphasis"), label: "Buy and hold" },
          { color: getVar("--series-4"), label: "Buy the dip, sell the high" },
          { color: getVar("--series-2"), label: "Puts only (no covered calls)" },
          { color: getVar("--series-1"), label: "The wheel" },
          { color: getVar("--series-1"), shape: "dot", label: "Put sold" },
          { color: getVar("--series-3"), shape: "dot", label: "Assigned" },
          { color: getVar("--series-2"), shape: "dot", label: "Call sold" },
          { color: getVar("--series-3"), shape: "dot", label: "Called away" },
          { color: getVar("--diverging-neg"), shape: "dot", label: "Shares stopped out" },
        ],
        table: tableWheelPaths(d, pr),
      }),
    },

    "wheel-bars": {
      title: "Who won, on this one path",
      cap: "Annualized growth rate. Rerun with a new seed and any of the four can come out on top.",
      short: true,
      render: (node, d) => ({
        plot: EP.wheelBars(node, d),
        legend: [
          { color: getVar("--series-1"), shape: "rect", label: "The wheel" },
          { color: getVar("--series-2"), shape: "rect", label: "Puts only" },
          { color: getVar("--series-4"), shape: "rect", label: "Buy the dip, sell the high" },
          { color: getVar("--deemphasis"), shape: "rect", label: "Buy and hold" },
        ],
        table: tableWheelBars(d),
      }),
    },

    "wheel-sweep": {
      title: "The wheel's growth rate vs its own edge",
      cap: "Monte Carlo, not closed form — averaged over several seeds per point, because no exact formula exists for a strategy with a stop on the option's own marked value.",
      short: true,
      render: (node, d, pr) => ({
        plot: EP.wheelSweep(node, d, pr),
        legend: [
          { color: getVar("--series-1"), label: "The edge wins" },
          { color: getVar("--diverging-neg"), label: "Frictions win" },
          { color: getVar("--series-1"), shape: "dot", label: "Your dialled-in spread" },
        ],
        table: tableWheelSweep(d, pr),
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
  let inFlight = false;
  let dirty = false;

  /**
   * Coalesce slider input into one render, and never start a second render
   * while the first is still drawing.
   *
   * A frame here is tens of milliseconds of simulation plus a Plotly redraw,
   * which is longer than the gap between two `input` events from a dragged
   * slider. Without the in-flight latch every drag queued renders faster than
   * they could retire and the page locked up mid-gesture; with it, the
   * intermediate states are dropped and the last one always draws. The chart
   * is held at reduced opacity meanwhile rather than flashing a skeleton.
   */
  function scheduleRender() {
    const body = $("#scenario-body");
    body.classList.add("busy");
    if (inFlight) { dirty = true; return; }
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      pending = null;
      render();
    });
  }

  /**
   * If a scenario's `derive` clamps a value that is itself a directly-displayed
   * slider (Monty Hall's `opened`, clamped to doors-2), the slider and its label
   * would otherwise keep showing the pre-clamp number forever, disagreeing with
   * every tile and chart on the page. Pulling the clamped value back into
   * state keeps the control honest, and it self-corrects instead of fighting
   * the next render: once opened has been pulled down to fit the door count,
   * raising the door count again does not un-clamp it on its own, which is the
   * right behaviour -- the reader did not touch that slider.
   */
  function syncDerivedControls(sc, pr) {
    for (const c of sc.controls || []) {
      if (pr[c.key] === undefined || pr[c.key] === state.values[c.key]) continue;
      state.values[c.key] = pr[c.key];
      const input = document.getElementById(`ctl-${c.key}`);
      const val = document.getElementById(`ctl-${c.key}-val`);
      if (input) input.value = pr[c.key];
      if (val) val.textContent = c.fmt(pr[c.key]);
    }
  }

  function render() {
    const sc = EP.byId(state.id);
    if (!sc || sc.status !== "ready") return;

    const pr = EP.resolveParams(sc, state.values);
    if (state.seed !== undefined) pr.seed = state.seed;
    syncDerivedControls(sc, pr);

    const d = sc.compute(pr);
    renderTiles(sc, pr, d.stats);
    renderMathBox(sc, pr, d.stats);

    const jobs = [];
    for (const kind of sc.charts) {
      const node = $(`#plot-${kind}`);
      if (!node) continue;
      const out = CHART_KINDS[kind].render(node, d, pr);
      jobs.push(out.plot);
      legendFor(kind, out.legend);
      buildTable(`table-${kind}`, out.table.head, out.table.rows);
    }

    inFlight = true;
    Promise.all(jobs).then(() => {
      inFlight = false;
      // Whatever the sliders did while this frame was drawing, draw it now:
      // the reader's last input must always be the state on screen.
      if (dirty) { dirty = false; scheduleRender(); return; }
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

  /** A scenario's closed forms, for readers who want the formula behind the
   *  tiles rather than just the number -- at most 7 lines, textContent only
   *  (never innerHTML), same as every other computed label on this page. */
  function renderMathBox(sc, pr, stats) {
    const pre = $("#math-box-lines");
    if (!pre || !sc.mathBox) return;
    pre.textContent = sc.mathBox(pr, stats).join("\n");
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

  function tableMhKnow(d, pr) {
    const { ks, switchP, stayP } = d.knowCurve;
    const step = Math.max(1, Math.round(ks.length / 12));
    const rows = [];
    for (let i = 0; i < ks.length; i += step) {
      rows.push([F().pct(ks[i]), F().pct(switchP[i]), F().pct(stayP[i])]);
    }
    return { head: ["Host knows (P)", "Switching wins", "Staying wins"], rows };
  }

  function tableMhDoors(d, pr) {
    const { xs, knowing, random } = d.doorsCurve;
    const rows = xs.map((x, i) =>
      [String(x), F().pct(knowing[i]), F().pct(random[i])]);
    return { head: ["Doors", "Knowing host", "Random host"], rows };
  }

  function tableSdPaths(d, pr) {
    const { price, hold, rebal } = d.sim;
    const rows = sampledRounds(pr.rounds).map((t) => [
      String(t), F().money(price[t]), F().money(hold[t]), F().money(rebal[t]),
    ]);
    return { head: ["Period", "Stock alone", "Buy and hold", "Rebalanced"], rows };
  }

  function tableSdSweep(d, pr) {
    const { xs, harvest } = d.harvestCurve;
    const step = Math.max(1, Math.round(xs.length / 14));
    const rows = [];
    for (let i = 0; i < xs.length; i += step) {
      rows.push([String(xs[i]), F().pctSigned(harvest[i])]);
    }
    return { head: ["Rebalance every N periods", "Harvest vs buy-and-hold"], rows };
  }

  function tableInsBand(d, pr) {
    const { xs, buyer, seller } = d.premiumCurve;
    const step = Math.max(1, Math.round(xs.length / 14));
    const rows = [];
    for (let i = 0; i < xs.length; i += step) {
      rows.push([F().money(xs[i]), F().money(buyer[i]), F().money(seller[i])]);
    }
    return { head: ["Premium", "Buyer's value", "Seller's value"], rows };
  }

  function tableInsPool(d, pr) {
    const { sizes, growth } = d.poolCurve;
    const step = Math.max(1, Math.round(sizes.length / 14));
    const rows = [];
    for (let i = 0; i < sizes.length; i += step) {
      rows.push([String(sizes[i]), F().pctSigned(growth[i])]);
    }
    return { head: ["Pool size", "Growth per period"], rows };
  }

  /** Every event on the wheel's own path, not just the ones the chart marks
   *  -- top-ups and individual stop-outs live here, since they are too
   *  frequent to mark on the plot without turning into visual noise. */
  function tableWheelPaths(d, pr) {
    const { wheel } = d.fam;
    const EVENT_LABELS = {
      sell_put: "Sold put",
      put_expired: "Put expired worthless",
      assigned: "Assigned",
      sell_call: "Sold covered call",
      close_call: "Call bought back at a profit",
      close_call_on_stop: "Call bought back — shares stopping out",
      call_expired: "Call expired worthless",
      called_away: "Called away — shares sold",
      stop_shares: "Shares stopped out",
    };
    const rows = wheel.events.map((e) => [
      String(e.t), EVENT_LABELS[e.kind] || e.kind, String(e.contracts),
      e.strike !== undefined ? F().money(e.strike) : "—",
      F().money(wheel.equity[e.t]),
    ]);
    return { head: ["Day", "Event", "Contracts", "Strike", "Account value"], rows };
  }

  function tableWheelBars(d) {
    const labels = { wheel: "The wheel", putsOnly: "Puts only",
      dip: "Buy the dip, sell the high", hold: "Buy and hold" };
    const rows = Object.keys(labels)
      .map((k) => ({ k, cagr: d.stats.cagrs[k] }))
      .sort((a, b) => b.cagr - a.cagr)
      .map((r, i) => [`${i + 1}. ${labels[r.k]}`, F().pctSigned(r.cagr)]);
    return { head: ["Strategy", "Annualized growth"], rows };
  }

  function tableWheelSweep(d, pr) {
    const { xs, gs } = d.sweep;
    const step = Math.max(1, Math.round(xs.length / 14));
    const rows = [];
    for (let i = 0; i < xs.length; i += step) {
      rows.push([F().pctSigned(xs[i]), F().pctSigned(gs[i])]);
    }
    return { head: ["Implied − realized vol", "Wheel's growth rate"], rows };
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
