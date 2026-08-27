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

  function selectScenario(id, params) {
    const sc = EP.byId(id);
    if (!sc) return;
    state.id = id;
    state.values = EP.defaultValues(sc);
    delete state.seed; // Reset also means back to the reproducible default draw.
    if (params) applyHashParams(sc, params);
    syncHash();
    markPicker();
    buildBody(sc);
    render();
  }

  // -- the URL hash ---------------------------------------------------------
  /* The hash carries the whole configuration, not just the scenario:
   * `#ergodic-coin?p=0.55&rounds=200&seed=12345`. Only values that differ from
   * the scenario's own defaults are written, so the view a reader lands on
   * first stays a clean `#ergodic-coin` -- the query string appears exactly
   * when there is something in it worth sharing.
   *
   * Everything on the way back in is validated against the control that owns
   * the key (min/max/step, or the `options` list for a select) and silently
   * dropped if it does not fit. A hand-edited or truncated hash therefore
   * degrades to "that one parameter was ignored", never to a blank page.
   */

  /** `seed` is the reseed control, which is state rather than a control entry;
   *  no scenario uses it as a control key, and one must not start doing so. */
  const SEED_KEY = "seed";

  function hashFor(sc) {
    const parts = [];
    for (const c of sc.controls || []) {
      const v = state.values[c.key];
      if (v === undefined || String(v) === String(c.value)) continue;
      parts.push(`${encodeURIComponent(c.key)}=${encodeURIComponent(v)}`);
    }
    if (state.seed !== undefined) {
      parts.push(`${SEED_KEY}=${encodeURIComponent(state.seed)}`);
    }
    return parts.length ? `#${sc.id}?${parts.join("&")}` : `#${sc.id}`;
  }

  /** Split `#id?a=1&b=2` into an id and a plain object of raw strings. */
  function parseHash() {
    const raw = location.hash.slice(1);
    const cut = raw.indexOf("?");
    const params = {};
    let id = cut < 0 ? raw : raw.slice(0, cut);
    try { id = decodeURIComponent(id); } catch (e) { /* keep it raw */ }
    if (cut >= 0) {
      for (const pair of raw.slice(cut + 1).split("&")) {
        const eq = pair.indexOf("=");
        if (eq < 1) continue; // "", "&&", "=v" -- nothing usable
        try {
          params[decodeURIComponent(pair.slice(0, eq))] =
            decodeURIComponent(pair.slice(eq + 1));
        } catch (e) { /* a truncated %-escape throws; drop just this pair */ }
      }
    }
    return { id, params };
  }

  /**
   * One raw string against the control that owns it. Returns the accepted
   * value, or undefined for anything the control could not itself produce --
   * off the step grid, outside the range, not one of the listed options.
   */
  function validControlValue(c, raw) {
    if ((c.type || "range") === "select") {
      const hit = (c.options || []).some((o) => String(o.value) === raw);
      return hit ? raw : undefined;
    }
    const v = parseFloat(raw);
    if (!isFinite(v) || v < c.min || v > c.max) return undefined;
    const step = Number(c.step);
    if (step > 0) {
      // Anchored at min, the way the slider itself lays out its grid. The
      // tolerance absorbs the float noise in e.g. (0.55 - 0.05) / 0.01.
      const snapped = c.min + Math.round((v - c.min) / step) * step;
      if (Math.abs(snapped - v) > Math.max(1e-9, step * 1e-6)) return undefined;
    }
    return v;
  }

  function applyHashParams(sc, params) {
    for (const c of sc.controls || []) {
      if (!Object.prototype.hasOwnProperty.call(params, c.key)) continue;
      const v = validControlValue(c, params[c.key]);
      if (v !== undefined) state.values[c.key] = v;
    }
    if (params[SEED_KEY] !== undefined) {
      const s = parseInt(params[SEED_KEY], 10);
      if (isFinite(s)) state.seed = s;
    }
  }

  function syncHash() {
    const sc = EP.byId(state.id);
    if (!sc) return;
    const next = hashFor(sc);
    if (location.hash === next) return;
    // replaceState, never pushState: a dragged slider must not fill the back
    // button with one entry per frame. Wrapped because a page opened straight
    // off the filesystem has a null origin and some browsers refuse to write
    // history there -- a shareable URL is a nice-to-have, and it must never
    // take the render with it when it fails.
    try { history.replaceState(null, "", next); } catch (e) { /* file:// */ }
  }

  /**
   * Trailing-edge throttle for the slider path. replaceState is cheap but not
   * free -- some browsers rate-limit it -- and a drag emits far more input
   * events than the URL needs to see. The last one always lands.
   */
  let hashTimer = null;
  function scheduleHashSync() {
    if (hashTimer) return;
    hashTimer = setTimeout(() => { hashTimer = null; syncHash(); }, 200);
  }

  // -- body -----------------------------------------------------------------
  /**
   * Typeset a subtree exactly once, whenever MathJax is ready to do it.
   *
   * The library is loaded async, so at build time `window.MathJax` may still be
   * the bare config object with no typesetPromise on it yet. The flag on the
   * node is what guarantees "once": whichever attempt gets there first wins and
   * every later one is a no-op, so wiring this to a `toggle` event as a second
   * chance cannot cause a second typeset.
   */
  function typesetOnce(node) {
    if (!node || node.dataset.typeset === "1") return;
    const MJ = window.MathJax;
    if (!MJ || !MJ.typesetPromise) return;
    node.dataset.typeset = "1";
    MJ.typesetPromise([node]);
  }

  function buildBody(sc) {
    $("#sc-title").textContent = sc.name;
    $("#sc-blurb").textContent = sc.blurb;
    const body = $("#scenario-body");
    body.textContent = "";
    reseedBtn = null; // the old one just went out of the DOM with body
    seedProbePending = false;

    // One line, above everything, answering "why should I care?" before the
    // reader has to invest in the story or the controls. Static per scenario,
    // so it is built here rather than in render().
    if (sc.why) {
      const why = el("p", "why");
      why.appendChild(el("span", "why-label", "Why it is worth exploring"));
      why.appendChild(document.createTextNode(sc.why));
      body.appendChild(why);
    }

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

    // The verdict reads the live stats, so unlike the note it is rebuilt on
    // every render. Only the shell is created here.
    if (sc.verdict) {
      const box = el("aside", "verdict");
      box.id = "verdict";
      box.appendChild(el("h3", null, "So what should you actually do?"));
      box.appendChild(el("p", "verdict-headline", ""));
      box.appendChild(el("p", "verdict-body", ""));
      body.appendChild(box);
    }

    if (sc.mathBox) {
      const details = el("details", "math-box");
      details.appendChild(el("summary", null, "For math enthusiasts"));
      const holder = el("div");
      holder.id = "math-box-lines";
      details.appendChild(holder);

      if (sc.notation && Object.keys(sc.notation).length > 0) {
        // Nested one level deeper than the formulas on purpose: opening the
        // math box should show the closed forms, not half a screen of
        // definitions. The definitions are one further click for whoever
        // wants them.
        const notation = el("details", "notation-legend");
        notation.appendChild(el("summary", null, "What the symbols mean"));
        const list = el("dl");
        for (const [term, definition] of Object.entries(sc.notation)) {
          const dt = el("dt", null, term);
          const dd = el("dd", null, definition);
          list.appendChild(dt);
          list.appendChild(dd);
        }
        notation.appendChild(list);
        details.appendChild(notation);
        // The dt terms carry \(...\) delimiters too, same convention as the
        // math-box lines. Unlike the formulas, the notation never changes on a
        // re-render, so it is typeset once and never again -- renderMathBox
        // must not reach it, or every slider frame would re-typeset it.
        typesetOnce(notation);
        notation.addEventListener("toggle", () => typesetOnce(notation));
      }

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
    // The holder scrolls, not the page: a table wider than a phone viewport
    // would otherwise widen the document and give the whole page a horizontal
    // scrollbar. See .table-holder in index.html.
    const holder = el("div", "table-holder");
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
          // A select can switch a scenario between simulated and real data,
          // which is exactly the thing that decides whether reseeding does
          // anything -- so re-run the probe. Sliders never change that.
          seedProbePending = true;
          syncHash();
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
          scheduleHashSync();
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
      syncHash(); // a draw the reader liked should be shareable
      render();
    });
    actions.appendChild(reseed);
    // Rendered for every scenario, then hidden again for the ones where it
    // provably does nothing -- see probeSeedSensitivity.
    reseedBtn = reseed;
    seedProbePending = true;

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

    "pa-drift": {
      title: "Drift vs how often you play game B",
      cap: "Closed form — the stationary distribution of a 3-state Markov chain, not a simulated average.",
      short: true,
      render: (node, d, pr) => ({
        plot: EP.paDrift(node, d, pr),
        legend: [
          { color: getVar("--series-1"), label: "Winning" },
          { color: getVar("--diverging-neg"), label: "Losing" },
          { color: getVar("--deemphasis"), shape: "dot", label: "Pure A or pure B" },
        ],
        table: tablePaDrift(d),
      }),
    },

    "pa-paths": {
      title: "One seeded walk, three strategies",
      cap: "Linear scale — capital moves by exactly one dollar a round, additive like gambler's ruin.",
      render: (node, d, pr) => ({
        plot: EP.paPaths(node, d, pr),
        legend: [
          { color: getVar("--deemphasis"), label: "Game A alone" },
          { color: getVar("--series-2"), label: "Game B alone" },
          { color: getVar("--series-1"), label: "Your mix" },
        ],
        table: tablePaPaths(d, pr),
      }),
    },

    "br-prevalence": {
      title: "P(sick | positive) vs how common the disease is",
      cap: "Closed form — Bayes' theorem, swept over the one input that decides the most.",
      short: true,
      render: (node, d, pr) => ({
        plot: EP.brPrevalence(node, d, pr),
        legend: [
          { color: getVar("--series-1"), label: "P(sick | positive)" },
          { color: getVar("--series-1"), shape: "dot", label: "Your prevalence" },
        ],
        table: tableBrPrevalence(d),
      }),
    },

    "br-grid": {
      title: "The same theorem, as a population",
      cap: "Bayes' theorem multiplied through by a headcount — the natural-frequency form.",
      short: true,
      render: (node, d) => ({
        plot: EP.brGrid(node, d),
        legend: [
          { color: getVar("--series-1"), shape: "rect", label: "Actually sick" },
          { color: getVar("--deemphasis"), shape: "rect", label: "Actually healthy" },
        ],
        table: tableBrGrid(d),
      }),
    },

    "bd-collision": {
      title: "Collision odds vs group size",
      cap: "Closed form, exact.",
      short: true,
      render: (node, d, pr) => ({
        plot: EP.bdCollision(node, d, pr),
        legend: [
          { color: getVar("--series-1"), label: "P(shared birthday)" },
          { color: getVar("--series-1"), shape: "dot", label: "Your group" },
        ],
        table: tableBdCollision(d),
      }),
    },

    "bd-hash": {
      title: "The security version: bits vs items needed",
      cap: "Approximation — see the note below. Log scale on the item count.",
      short: true,
      render: (node, d, pr) => ({
        plot: EP.bdHash(node, d, pr),
        legend: [
          { color: getVar("--series-1"), label: "n for 50% odds (approx)" },
          { color: getVar("--series-1"), shape: "dot", label: "Your digest length" },
        ],
        table: tableBdHash(d),
      }),
    },

    "sec-threshold": {
      title: "P(win) vs how many you skip",
      cap: "Closed form, exact — and deliberately flat near the top.",
      short: true,
      render: (node, d, pr) => ({
        plot: EP.secThreshold(node, d, pr),
        legend: [
          { color: getVar("--series-1"), label: "P(win)" },
          { color: getVar("--series-1"), shape: "dot", label: "Optimal skip" },
          { color: getVar("--series-2"), shape: "dot", label: "Your skip" },
        ],
        table: tableSecThreshold(d),
      }),
    },

    "sec-asymptotic": {
      title: "The optimum, converging to 1/e",
      cap: "Closed form at every n — the limit is a fact about this curve, not an approximation drawing it.",
      short: true,
      render: (node, d, pr) => ({
        plot: EP.secAsymptotic(node, d, pr),
        legend: [
          { color: getVar("--series-1"), label: "Optimal P(win)" },
          { color: getVar("--series-1"), shape: "dot", label: "Your n" },
        ],
        table: tableSecAsymptotic(d),
      }),
    },

    "te-gain": {
      title: "Expected gain from swapping vs what you found",
      cap: "Closed form, under an exponential prior on the smaller amount.",
      render: (node, d, pr) => ({
        plot: EP.teGain(node, d, pr),
        legend: [
          { color: getVar("--series-1"), label: "Swapping gains on average" },
          { color: getVar("--diverging-neg"), label: "Swapping loses on average" },
          { color: getVar("--series-1"), shape: "dot", label: "What you found" },
        ],
        table: tableTeGain(d),
      }),
    },

    "te-prob": {
      title: "P(you're holding the smaller half)",
      cap: "Closed form — why the gain chart above changes sign.",
      short: true,
      render: (node, d, pr) => ({
        plot: EP.teProb(node, d, pr),
        legend: [
          { color: getVar("--series-1"), label: "P(smaller half)" },
          { color: getVar("--series-1"), shape: "dot", label: "What you found" },
        ],
        table: tableTeProb(d),
      }),
    },

    "os-curve": {
      title: "False positives, accumulating",
      cap: "Exact forward DP, not simulated — the same binomial-weight idea Shannon's demon and the insurance pool use.",
      short: true,
      render: (node, d, pr) => ({
        plot: EP.osCurve(node, d, pr),
        legend: [
          { color: getVar("--diverging-neg"), label: "Cumulative false-positive rate" },
        ],
        table: tableOsCurve(d),
      }),
    },

    "os-paths": {
      title: "A few seeded z-statistics vs the moving boundary",
      cap: "In z-units the bar is fixed; what moves is the walk. Each new look is another free run at a wall it has not yet crossed.",
      render: (node, d, pr) => ({
        plot: EP.osPaths(node, d, pr),
        legend: [
          { color: getVar("--deemphasis"), label: "One test's accumulating z-statistic" },
          { color: getVar("--diverging-neg"), label: "Significance boundary (±z)" },
        ],
        table: tableOsPaths(d, pr),
      }),
    },

    "simpson-bars": {
      title: "The same two treatments, counted two ways",
      cap: "Exact rates, not simulated. The two subgroups are one comparison; the pooled bar behind the divider is the same cases with the subgroup thrown away — not a third subgroup.",
      render: (node, d) => ({
        plot: EP.simpsonBars(node, d),
        legend: [
          { color: getVar("--series-1"), shape: "rect", label: "Treatment A" },
          { color: getVar("--series-2"), shape: "rect", label: "Treatment B" },
          // The wash on the chart is lighter than this. A 10px swatch at the
          // drawn alpha is invisible against the surface, so the key is
          // nudged up to the point where it reads as a key at all -- same
          // reasoning as the band swatch on `ins-band`.
          { shape: "band", fill: withAlpha(getVar("--deemphasis"), 0.18),
            label: d.bars.reverses
              ? "Pooled — where the order flips"
              : "Pooled — the order holds here" },
        ],
        table: tableSimpsonBars(d),
      }),
    },

    "simpson-boundary": {
      title: "How big an effect has to be to survive pooling",
      cap: "Closed form, exact — the boundary is the allocation gap times the difficulty gap, and it does not depend on the effect itself.",
      short: true,
      render: (node, d) => ({
        plot: EP.simpsonBoundary(node, d),
        legend: [
          { color: getVar("--diverging-neg"),
            label: "The effect a given allocation gap can swamp" },
          { shape: "band", fill: withAlpha(getVar("--diverging-neg"), 0.16),
            label: "Below the line — pooling reverses the trend" },
          { color: d.boundary.reverses
              ? getVar("--diverging-neg") : getVar("--series-1"),
            shape: "dot",
            label: d.boundary.reverses
              ? `You (${F().pct(d.boundary.deltaNow)} effect) — reversed`
              : `You (${F().pct(d.boundary.deltaNow)} effect) — survives` },
        ],
        table: tableSimpsonBoundary(d),
      }),
    },

    "bertrand-curves": {
      title: "Three definitions of “at random”, three exact answers",
      cap: "Closed form at every threshold. The curves meet only at the two degenerate ends; everywhere in between the question has three different correct answers.",
      render: (node, d) => ({
        plot: EP.bertrandCurves(node, d),
        legend: bertrandLegend(d),
        table: tableBertrandCurves(d),
      }),
    },

    "bertrand-chords": {
      title: "What each rule actually draws",
      cap: "A diagram, not a plot: equal aspect so the circle is a circle, and no axes because the coordinates mean nothing. The midpoint cloud is the lesson — each rule spreads chord middles differently, and that is the whole disagreement.",
      tall: true,
      render: (node, d) => ({
        plot: EP.bertrandChords(node, d),
        legend: [
          { color: getVar("--series-1"),
            label: `Chord longer than ${F().num(d.chords.cNow, 2)} × the diameter` },
          { color: getVar("--series-1"), shape: "dot", label: "…and its midpoint" },
          { color: getVar("--series-2"), label: "Chord shorter than that" },
          { color: getVar("--series-2"), shape: "dot", label: "…and its midpoint" },
          { color: getVar("--baseline"), label: "The circle" },
          { color: getVar("--deemphasis"),
            label: "Midpoints inside this circle make long chords" },
        ],
        table: tableBertrandChords(d),
      }),
    },
  };

  /** Legend for the three-rule curve chart, built from the same fixed
   *  rule→slot mapping charts.js draws with, so a colour can never drift
   *  between the line and the key that names it. Each rule gets a stroke for
   *  its curve and a dot for its answer at the reader's own threshold —
   *  those markers are three different colours, so one shared dot row could
   *  not honestly stand for them. */
  function bertrandLegend(d) {
    const t = EP.theme();
    const c = d.curves;
    const items = EP.BERTRAND_SERIES.map((s) => ({
      color: t[s.colorKey], label: s.label,
    }));
    for (const s of EP.BERTRAND_SERIES) {
      items.push({
        color: t[s.colorKey], shape: "dot",
        label: `${s.label} at your threshold — ${F().pct(c.pNow[s.key])}`,
      });
    }
    items.push({
      color: getVar("--muted"),
      label: `Your threshold (${F().num(c.cNow, 3)} × the diameter)`,
    });
    return items;
  }

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
    let changed = false;
    for (const c of sc.controls || []) {
      if (pr[c.key] === undefined || pr[c.key] === state.values[c.key]) continue;
      state.values[c.key] = pr[c.key];
      changed = true;
      const input = document.getElementById(`ctl-${c.key}`);
      const val = document.getElementById(`ctl-${c.key}-val`);
      if (input) input.value = pr[c.key];
      if (val) val.textContent = c.fmt(pr[c.key]);
    }
    // The hash mirrors state.values, so a clamp that rewrites one has to
    // rewrite the other -- otherwise a shared link carries the pre-clamp
    // number the page itself refused to use.
    if (changed) scheduleHashSync();
  }

  // -- does "New random draw" do anything here? -----------------------------
  /* Half the scenarios on this page are pure closed form -- Monty Hall, base
   * rates, the birthday problem and the rest never draw a random number -- and
   * for those the reseed button is a control that visibly does nothing.
   *
   * Rather than keep a list of which ones (a list that goes stale the moment a
   * scenario is added or changes), ask the scenario directly: compute it twice,
   * once on its own seed and once on a neighbouring one, and compare the two
   * results. That is the button's semantics exactly -- "does changing the seed
   * change what you see" -- so it cannot disagree with what the reader would
   * observe. It also tracks a scenario whose answer depends on its controls:
   * the wheel is a simulated GBM path on its default underlying, but a real
   * ticker is one fixed price series, so reseeding stops mattering the moment
   * the reader picks one, and the button disappears with it.
   *
   * Cost is one extra compute, only when the probe is pending -- on a scenario
   * switch or a select change, never on a slider frame. On a stochastic
   * scenario the comparison exits at the first differing number, and on a
   * deterministic one the whole result is small (a few curves of a few hundred
   * points) precisely because nothing was simulated.
   */
  let reseedBtn = null;
  let seedProbePending = false;

  /** Structural equality over the plain objects, arrays and typed arrays a
   *  compute() returns. NaN equals NaN here: two identical unsimulated results
   *  should compare equal even where the maths produced a NaN. */
  function sameData(a, b, depth) {
    if (a === b) return true;
    if (typeof a === "number" && typeof b === "number") {
      return Number.isNaN(a) && Number.isNaN(b);
    }
    if (depth > 12) return true; // deeper than anything on this page nests
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    if (typeof a.length === "number" && typeof b.length === "number") {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!sameData(a[i], b[i], depth + 1)) return false;
      }
      return true;
    }
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    for (const k of ka) if (!sameData(a[k], b[k], depth + 1)) return false;
    return true;
  }

  function probeSeedSensitivity(sc, pr, d) {
    try {
      const other = Object.assign({}, pr, { seed: (pr.seed | 0) + 1 });
      return !sameData(d, sc.compute(other), 0);
    } catch (e) {
      return true; // if the probe cannot run, leave the control alone
    }
  }

  function render() {
    const sc = EP.byId(state.id);
    if (!sc || sc.status !== "ready") return;

    const pr = EP.resolveParams(sc, state.values);
    if (state.seed !== undefined) pr.seed = state.seed;
    syncDerivedControls(sc, pr);

    const d = sc.compute(pr);
    if (seedProbePending) {
      seedProbePending = false;
      if (reseedBtn) reseedBtn.hidden = !probeSeedSensitivity(sc, pr, d);
    }
    renderTiles(sc, pr, d.stats);
    renderMathBox(sc, pr, d.stats);
    renderVerdict(sc, pr, d.stats);

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
   *  tiles rather than just the number -- at most 7 lines. Each line is set
   *  via textContent (never innerHTML, same as every other computed label on
   *  this page); MathJax then scans those text nodes for \(...\) and \[...\]
   *  and typesets the math in place without needing the source to be HTML. */
  /** The scenario's conclusion, recomputed from the live parameters.
   *
   *  Some scenarios genuinely change their advice as you drag a slider -- past
   *  the Kelly optimum the same game flips from worth playing to ruinous, and
   *  an insurance premium outside the band stops being mutually good. Others
   *  (Monty Hall, the birthday problem) reach the same conclusion whatever you
   *  set, and their verdict says so rather than manufacturing false contingency.
   *
   *  `tone` picks the accent colour, but it is never the only carrier of the
   *  message -- the headline text says the same thing in words, per the
   *  never-colour-alone rule in CLAUDE.md. */
  const VERDICT_TONES = { good: "--series-3", bad: "--diverging-neg",
                          neutral: "--series-1" };

  function renderVerdict(sc, pr, stats) {
    const box = $("#verdict");
    if (!box || !sc.verdict) return;
    let v;
    try {
      v = sc.verdict(pr, stats);
    } catch (e) {
      box.hidden = true;
      return;
    }
    if (!v || !v.headline) { box.hidden = true; return; }
    box.hidden = false;
    box.style.borderLeftColor = getVar(VERDICT_TONES[v.tone] || VERDICT_TONES.neutral);
    box.querySelector(".verdict-headline").textContent = v.headline;
    box.querySelector(".verdict-body").textContent = v.body || "";
  }

  function renderMathBox(sc, pr, stats) {
    const holder = $("#math-box-lines");
    if (!holder || !sc.mathBox) return;
    holder.textContent = "";
    for (const line of sc.mathBox(pr, stats)) {
      holder.appendChild(el("div", "math-line", line));
    }
    if (window.MathJax && window.MathJax.typesetPromise) {
      window.MathJax.typesetPromise([holder]);
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
      } else if (it.shape === "dot-open") {
        // Mirrors Plotly's circle-open: the ring, not a filled disc. Without
        // this an open marker and a filled one in the same hue produce two
        // byte-identical legend rows.
        key.style.height = "10px";
        key.style.width = "10px";
        key.style.borderRadius = "50%";
        key.style.background = "transparent";
        key.style.border = `2px solid ${it.fill || it.color}`;
      } else if (it.shape === "tri-up" || it.shape === "tri-down") {
        key.style.height = "10px";
        key.style.width = "10px";
        key.style.clipPath = it.shape === "tri-up"
          ? "polygon(50% 0%, 100% 100%, 0% 100%)"
          : "polygon(0% 0%, 100% 0%, 50% 100%)";
      } else if (it.shape === "cross") {
        key.style.height = "10px";
        key.style.width = "10px";
        key.style.background = "transparent";
        key.style.color = it.fill || it.color;
        key.style.font = "700 12px/10px system-ui, sans-serif";
        key.style.textAlign = "center";
        key.textContent = "✕";
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

  function tablePaDrift(d) {
    const { qs, drifts } = d.driftCurve;
    const step = Math.max(1, Math.round(qs.length / 14));
    const rows = [];
    for (let i = 0; i < qs.length; i += step) {
      rows.push([F().pct(qs[i]), drifts[i].toFixed(4)]);
    }
    return { head: ["P(play B)", "Drift ($/round)"], rows };
  }

  function tablePaPaths(d, pr) {
    const { pathsA, pathsB, pathsMix } = d.sim;
    const rows = sampledRounds(pr.rounds).map((t) => [
      String(t), String(pathsA[0][t]), String(pathsB[0][t]), String(pathsMix[0][t]),
    ]);
    return { head: ["Round", "Game A", "Game B", "Mixed"], rows };
  }

  function tableBrPrevalence(d) {
    const { xs, ys } = d.prevalenceCurve;
    const step = Math.max(1, Math.round(xs.length / 14));
    const rows = [];
    for (let i = 0; i < xs.length; i += step) {
      rows.push([F().pct(xs[i]), F().pct(ys[i])]);
    }
    return { head: ["Prevalence", "P(sick | positive)"], rows };
  }

  function tableBrGrid(d) {
    const { tp, fp, fn, tn } = d.stats;
    return {
      head: ["", "Actually sick", "Actually healthy", "Total"],
      rows: [
        ["Tested positive", F().count(tp), F().count(fp), F().count(tp + fp)],
        ["Tested negative", F().count(fn), F().count(tn), F().count(fn + tn)],
        ["Total", F().count(tp + fn), F().count(fp + tn), F().count(tp + fp + fn + tn)],
      ],
    };
  }

  function tableBdCollision(d) {
    const { xs, ys } = d.collisionCurve;
    const step = Math.max(1, Math.round(xs.length / 14));
    const rows = [];
    for (let i = 0; i < xs.length; i += step) {
      rows.push([String(xs[i]), F().pct(ys[i])]);
    }
    return { head: ["Group size", "P(collision)"], rows };
  }

  function tableBdHash(d) {
    const { xs, ys } = d.hashBitsCurve;
    const step = Math.max(1, Math.round(xs.length / 14));
    const rows = [];
    for (let i = 0; i < xs.length; i += step) {
      rows.push([F().num(xs[i], 0), ys[i].toExponential(2)]);
    }
    return { head: ["Digest bits", "Items for 50% odds (approx)"], rows };
  }

  function tableSecThreshold(d) {
    const { xs, ys } = d.winCurve;
    const step = Math.max(1, Math.round(xs.length / 14));
    const rows = [];
    for (let i = 0; i < xs.length; i += step) {
      rows.push([String(xs[i]), F().pct(ys[i])]);
    }
    return { head: ["Skip", "P(win)"], rows };
  }

  function tableSecAsymptotic(d) {
    const { ns, ys } = d.asymptotic;
    return {
      head: ["n", "Optimal P(win)"],
      rows: ns.map((n, i) => [F().count(n), F().pct(ys[i])]),
    };
  }

  function tableTeGain(d) {
    const { xs, gains, probs } = d.gainCurve;
    const step = Math.max(1, Math.round(xs.length / 14));
    const rows = [];
    for (let i = 0; i < xs.length; i += step) {
      rows.push([F().money(xs[i]), F().money(gains[i]), F().pct(probs[i])]);
    }
    return { head: ["Amount found", "Expected gain from swapping", "P(smaller half)"], rows };
  }

  function tableTeProb(d) {
    const { xs, probs } = d.gainCurve;
    const step = Math.max(1, Math.round(xs.length / 14));
    const rows = [];
    for (let i = 0; i < xs.length; i += step) {
      rows.push([F().money(xs[i]), F().pct(probs[i])]);
    }
    return { head: ["Amount found", "P(smaller half)"], rows };
  }

  function tableOsCurve(d) {
    const { xs, ys } = d.fpCurve;
    const step = Math.max(1, Math.round(xs.length / 10));
    const rows = [];
    for (let i = 0; i < xs.length; i += step) {
      rows.push([String(xs[i]), F().pct(ys[i])]);
    }
    const last = xs.length - 1;
    if (rows.length && rows[rows.length - 1][0] !== String(xs[last])) {
      rows.push([String(xs[last]), F().pct(ys[last])]);
    }
    return { head: ["Look", "Cumulative false-positive rate"], rows };
  }

  function tableOsPaths(d, pr) {
    const { allZ } = d.sim;
    const shown = Math.min(allZ.length, 8);
    const rows = [];
    for (let look = 0; look < pr.looks; look += Math.max(1, Math.round(pr.looks / 12))) {
      rows.push([String(look + 1)].concat(
        Array.from({ length: shown }, (_, p) => F().num(allZ[p][look], 2))));
    }
    return {
      head: ["Look"].concat(Array.from({ length: shown }, (_, p) => `Path ${p + 1}`)),
      rows,
    };
  }

  /** One row per group, with the A−B gap and the verdict spelled out in
   *  words: the reversal is a sign change, and a sign is exactly the thing a
   *  reader should not have to infer from two bar heights. */
  function tableSimpsonBars(d) {
    const b = d.bars;
    const rows = b.groups.map((g, i) => {
      const diff = b.a[i] - b.b[i];
      return [
        g, F().pct(b.a[i]), F().pct(b.b[i]), F().pctSigned(diff),
        diff === 0 ? "tied" : diff > 0 ? "A is better" : "B is better",
      ];
    });
    return {
      head: ["Group", "Treatment A", "Treatment B", "A − B", "Verdict"],
      rows,
    };
  }

  function tableSimpsonBoundary(d) {
    const bd = d.boundary;
    const step = Math.max(1, Math.round(bd.gaps.length / 14));
    const rows = [];
    for (let i = 0; i < bd.gaps.length; i += step) {
      rows.push([
        F().pct(bd.gaps[i]), F().pct(bd.deltaCrit[i]),
        bd.deltaNow > bd.deltaCrit[i] ? "survives pooling" : "reverses",
      ]);
    }
    return {
      head: [
        "Allocation gap",
        "Effect needed to survive pooling",
        `Your effect (${F().pct(bd.deltaNow)})`,
      ],
      rows,
    };
  }

  function tableBertrandCurves(d) {
    const c = d.curves;
    const step = Math.max(1, Math.round(c.cs.length / 14));
    const rows = [];
    for (let i = 0; i < c.cs.length; i += step) {
      rows.push([
        F().num(c.cs[i], 3), F().pct(c.endpoints[i]),
        F().pct(c.radius[i]), F().pct(c.midpoint[i]),
      ]);
    }
    // The reader's own threshold always gets its own row, wherever the
    // sampling above happened to land.
    rows.push([
      `${F().num(c.cNow, 3)} (yours)`, F().pct(c.pNow.endpoints),
      F().pct(c.pNow.radius), F().pct(c.pNow.midpoint),
    ]);
    return {
      head: ["Chord ÷ diameter", "Random endpoints", "Random radius",
             "Random midpoint"],
      rows,
    };
  }

  /** The midpoint cloud, counted into rings.
   *
   *  A row per chord would be hundreds of rows of coordinates nobody reads.
   *  The rings are the same information the picture carries -- how far from
   *  the centre this rule puts its midpoints -- in the form a screen reader
   *  or a copy-paste can actually use, which is the whole job of the table
   *  view for a chart whose content is a shape. */
  const MIDPOINT_RINGS = 5;

  function tableBertrandChords(d) {
    const c = d.chords;
    const n = c.mx.length;
    const total = new Array(MIDPOINT_RINGS).fill(0);
    const long = new Array(MIDPOINT_RINGS).fill(0);
    let nLong = 0;
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(c.mx[i], c.my[i]);
      // A midpoint exactly on the rim lands in the last ring, not past it.
      const k = Math.min(MIDPOINT_RINGS - 1, Math.floor(r * MIDPOINT_RINGS));
      total[k]++;
      if (c.long[i]) { long[k]++; nLong++; }
    }
    const rows = [];
    for (let k = 0; k < MIDPOINT_RINGS; k++) {
      rows.push([
        `${F().num(k / MIDPOINT_RINGS, 2)} – ${F().num((k + 1) / MIDPOINT_RINGS, 2)}`,
        F().count(total[k]), F().pct(n ? total[k] / n : 0), F().count(long[k]),
      ]);
    }
    rows.push(["All chords", F().count(n), F().pct(n ? 1 : 0), F().count(nLong)]);
    return {
      head: [`Midpoint distance from centre (${c.label})`, "Chords", "Share",
             "Longer than the threshold"],
      rows,
    };
  }

  // -- boot -----------------------------------------------------------------
  /** Whatever is in the hash, land on a working page: an unknown or empty id
   *  falls back to the first scenario, and syncHash then rewrites the bad
   *  fragment to the one actually on screen. */
  function openFromHash() {
    const { id, params } = parseHash();
    if (EP.byId(id)) selectScenario(id, params);
    else selectScenario(EP.SCENARIOS[0].id);
  }

  function boot() {
    initTheme();
    buildPicker();
    openFromHash();
    // Only a real navigation (a pasted or hand-edited fragment, or a bookmark
    // followed from this same page) fires this -- history.replaceState does
    // not, so the writes above cannot loop back round through here.
    window.addEventListener("hashchange", openFromHash);
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
