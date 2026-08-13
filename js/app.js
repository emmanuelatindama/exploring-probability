/* Page wiring: scenario picker, the filter row, KPI tiles, charts, table views.
 *
 * Series/category labels go into the DOM via textContent, never innerHTML string
 * concatenation -- they are treated as untrusted data on principle, so that this
 * stays true when a future scenario's labels come from a data file.
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

  const CARD_META = {
    trajectory: {
      title: "Every player's wealth over time",
      cap: "Log scale — on a linear axis one lucky path would flatten all the others into the floor.",
      short: false,
    },
    histogram: {
      title: "Where everyone ended up",
      cap: "Log-spaced bins. The distribution is heavily right-skewed, which is why the mean sits so far from the bulk.",
      short: false,
    },
    sweep: {
      title: "Long-run growth vs how much you stake",
      cap: "Closed form, not simulated — this is the exact growth rate for every possible bet size.",
      short: true,
    },
  };

  function buildCard(kind) {
    const meta = CARD_META[kind];
    const card = el("div", "card");
    card.appendChild(el("h3", null, meta.title));
    card.appendChild(el("p", "cap", meta.cap));

    const plot = el("div", `plot${meta.short ? " short" : ""}`);
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
    pr.rounds = Math.round(pr.rounds);
    pr.nPaths = Math.round(pr.nPaths);
    if (state.seed !== undefined) pr.seed = state.seed;

    const stats = EP.summary(pr);
    renderTiles(sc, pr, stats);

    const needsSim = sc.charts.includes("trajectory") || sc.charts.includes("histogram");
    let sim = null, pathStats = null, hist = null;
    if (needsSim) {
      sim = EP.simulatePaths(pr);
      pathStats = EP.pathStats(sim);
      hist = EP.logHistogram(sim.terminal, 40);
    }

    const jobs = [];
    if (sc.charts.includes("sweep")) {
      const sw = EP.kellySweep(pr, 200);
      jobs.push(EP.sweep($("#plot-sweep"), sw, pr));
      legendFor("sweep", [
        { color: getVar("--series-1"), label: "Wealth grows over time" },
        { color: getVar("--diverging-neg"), label: "Wealth shrinks over time" },
      ]);
      tableSweep(sw, pr);
    }
    if (sc.charts.includes("trajectory")) {
      jobs.push(EP.trajectory($("#plot-trajectory"), sim, pathStats, pr));
      legendFor("trajectory", [
        { color: getVar("--series-1"), label: "Median — the typical player" },
        { color: getVar("--series-2"),
          label: `Mean of these ${pr.nPaths.toLocaleString("en-US")} players` },
        { shape: "band", fill: withAlpha(getVar("--series-1"), 0.18),
          label: "Middle 50% of players" },
        { shape: "band", fill: withAlpha(getVar("--series-1"), 0.1),
          label: "Middle 90% of players" },
        { color: getVar("--deemphasis"),
          label: `${Math.min(pr.nPaths, EP.SAMPLE_PATHS)} individual players` },
      ]);
      tableTrajectory(pathStats, pr);
    }
    if (sc.charts.includes("histogram")) {
      jobs.push(EP.histogram($("#plot-histogram"), hist, stats, pr));
      legendFor("histogram", [
        { color: getVar("--series-1"), shape: "rect",
          label: `Players per wealth bin (${pr.nPaths.toLocaleString("en-US")} total)` },
      ]);
      tableHistogram(hist, pr);
    }

    Promise.all(jobs).then(() => {
      $("#scenario-body").classList.remove("busy");
    });
  }

  const getVar = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

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
   *  filled block for bars and bands. Always present for >=2 series; a
   *  single-series chart still gets one row naming what the marks are. */
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
      }
      row.appendChild(key);
      row.appendChild(el("span", null, it.label));
      holder.appendChild(row);
    }
  }

  /** rgba() from a resolved hex, for band swatches. */
  function withAlpha(hex, alpha) {
    const h = hex.replace("#", "");
    const n = h.length === 3
      ? h.split("").map((c) => parseInt(c + c, 16))
      : [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return `rgba(${n[0]},${n[1]},${n[2]},${alpha})`;
  }

  // -- table views ----------------------------------------------------------
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

  /** Every ~10th round, so the table stays readable at 500 rounds. */
  function tableTrajectory(ps, pr) {
    const row = (t) => [
      String(t), EP.fmt.money(ps.q05[t]), EP.fmt.money(ps.q25[t]),
      EP.fmt.money(ps.median[t]), EP.fmt.money(ps.q75[t]),
      EP.fmt.money(ps.q95[t]), EP.fmt.money(ps.mean[t]),
    ];
    const stepSize = Math.max(1, Math.round(pr.rounds / 10));
    const rows = [];
    for (let t = 0; t <= pr.rounds; t += stepSize) rows.push(row(t));
    if (rows[rows.length - 1][0] !== String(pr.rounds)) rows.push(row(pr.rounds));
    buildTable("table-trajectory",
      ["Round", "5th pct", "25th pct", "Median", "75th pct", "95th pct", "Mean"],
      rows);
  }

  function tableHistogram(hist, pr) {
    const rows = hist.counts.map((c, i) => [
      `${EP.fmt.money(Math.pow(10, hist.edges[i]))} – ${EP.fmt.money(Math.pow(10, hist.edges[i + 1]))}`,
      c.toLocaleString("en-US"),
      EP.fmt.pct(c / pr.nPaths),
    ]).filter((r, i) => hist.counts[i] > 0);
    buildTable("table-histogram", ["Final wealth", "Players", "Share"], rows);
  }

  function tableSweep(sw, pr) {
    const rows = [];
    for (let i = 0; i < sw.fs.length; i += Math.max(1, Math.round(sw.fs.length / 12))) {
      const g = sw.g[i];
      rows.push([
        EP.fmt.pct(sw.fs[i]),
        isFinite(g) ? EP.fmt.pctSigned(g) : "ruin",
        isFinite(g) ? EP.fmt.money(pr.w0 * Math.exp(g * pr.rounds)) : "$0",
      ]);
    }
    buildTable("table-sweep",
      ["Stake", "Growth per round", `Median wealth after ${pr.rounds} rounds`], rows);
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
