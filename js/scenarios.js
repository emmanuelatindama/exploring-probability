/* Scenario registry.
 *
 * Adding a scenario means adding one entry here -- nothing else in the page
 * knows the list. Entries with `status: "planned"` render as a card describing
 * what the scenario will show, so the roadmap is visible rather than implied.
 *
 * Contract for a `ready` entry:
 *   id       unique slug, used in the URL hash
 *   name     short label for the picker
 *   blurb    one sentence, shown under the title
 *   controls parameter definitions -> the filter row
 *   fixed    params the scenario pins (not user-editable)
 *   charts   which panels to render, in order
 *   tiles    (params, stats) -> KPI row
 *   note     the takeaway prose under the charts
 */
window.EP = window.EP || {};

(function (EP) {
  "use strict";

  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const pctSigned = (v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

  /** Compact currency: $1,284 / $12.9K / $4.2M, and $0.52 for small values. */
  function money(v) {
    if (!isFinite(v)) return "—";
    const a = Math.abs(v);
    if (a >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
    if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
    if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    if (a >= 1e4) return `$${(v / 1e3).toFixed(1)}K`;
    if (a >= 1) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    if (a >= 0.01) return `$${v.toFixed(2)}`;
    return `$${v.toExponential(1)}`;
  }

  // Controls shared by the two multiplicative scenarios.
  const COIN_CONTROLS = {
    up: { key: "up", label: "Heads multiplier", min: 1.0, max: 2.5, step: 0.05,
          value: 1.5, fmt: (v) => `×${v.toFixed(2)} (${pctSigned(v - 1)})` },
    down: { key: "down", label: "Tails multiplier", min: 0.1, max: 1.0, step: 0.05,
            value: 0.6, fmt: (v) => `×${v.toFixed(2)} (${pctSigned(v - 1)})` },
    p: { key: "p", label: "P(heads)", min: 0.05, max: 0.95, step: 0.01,
         value: 0.5, fmt: pct },
    rounds: { key: "rounds", label: "Rounds", min: 10, max: 500, step: 10,
              value: 100, fmt: (v) => `${v}` },
    nPaths: { key: "nPaths", label: "Players simulated", min: 50, max: 2000, step: 50,
              value: 500, fmt: (v) => v.toLocaleString("en-US") },
    f: { key: "f", label: "Fraction of wealth staked", min: 0, max: 1, step: 0.01,
         value: 0.25, fmt: pct },
  };

  const ctrl = (base, over) => Object.assign({}, base, over || {});

  const SCENARIOS = [
    {
      id: "ergodic-coin",
      status: "ready",
      name: "Ergodic coin flip",
      blurb:
        "Start with $100. Heads adds 50%, tails takes 40%. Positive expected " +
        "value, near-certain ruin — both statements are true at once.",
      controls: [
        ctrl(COIN_CONTROLS.up), ctrl(COIN_CONTROLS.down), ctrl(COIN_CONTROLS.p),
        ctrl(COIN_CONTROLS.rounds), ctrl(COIN_CONTROLS.nPaths),
      ],
      fixed: { w0: 100, f: 1 },
      charts: ["trajectory", "histogram"],
      tiles: (pr, s) => [
        { label: "Expected final wealth", value: money(s.expectedFinal),
          note: "exact, over all possible outcomes" },
        { label: "Median final wealth", value: money(s.medianFinal),
          note: "what a typical player gets" },
        { label: "Players who end below start", value: pct(s.pBelowStart),
          note: "exact probability" },
        { label: "Growth per round, typical player", value: pctSigned(s.timeGrowth),
          note: `vs ${pctSigned(s.ensembleGrowth)} expected` },
      ],
      note:
        "The gap between those first two tiles is the whole point. The mean is " +
        "dragged upward by a vanishingly small number of enormous winners, so it " +
        "describes nobody's experience. The median follows the geometric mean " +
        "√(up·down), which is below 1 whenever the swings are large enough " +
        "— so the typical path decays even though the average grows. Averaging " +
        "across players (ensemble) and averaging across time (one player, many " +
        "rounds) give different answers: the process is non-ergodic. " +
        "One consequence worth noticing: the mean line on the first chart is the " +
        "average of the simulated players, and it usually sits far below the " +
        "exact expected value in the tile. That is not a bug in either number. " +
        "The expectation is carried by outcomes so rare that a few hundred — or " +
        "a few hundred thousand — players almost never contain one, so the " +
        "sample mean of a heavy-tailed variable is itself close to useless. " +
        "Raise the player count and watch it lurch upward but never settle.",
    },
    {
      id: "kelly",
      status: "ready",
      name: "Kelly bet sizing",
      blurb:
        "The same coin, but you stake only a fraction of your wealth each round. " +
        "One number turns the losing game above into a winning one.",
      controls: [
        ctrl(COIN_CONTROLS.f), ctrl(COIN_CONTROLS.up), ctrl(COIN_CONTROLS.down),
        ctrl(COIN_CONTROLS.p), ctrl(COIN_CONTROLS.rounds), ctrl(COIN_CONTROLS.nPaths),
      ],
      fixed: { w0: 100 },
      charts: ["sweep", "trajectory", "histogram"],
      tiles: (pr, s) => [
        { label: "Optimal stake (Kelly)", value: pct(s.kellyF),
          note: "maximises long-run growth" },
        { label: "Growth per round at your stake", value: pctSigned(s.timeGrowth),
          note: `you are staking ${pct(pr.f)}` },
        { label: "Median final wealth", value: money(s.medianFinal),
          note: "what a typical player gets" },
        { label: "Players who end below start", value: pct(s.pBelowStart),
          note: `of ${pr.nPaths.toLocaleString("en-US")}` },
      ],
      note:
        "Growth per round peaks at f* = (p·a − q·b) / (a·b), where a is " +
        "the fractional gain and b the fractional loss. Below f* you leave growth " +
        "on the table; above it, volatility drag eats more than the edge adds, and " +
        "the curve crosses back through zero — past that point more edge makes " +
        "you poorer. Staking everything (f = 1) sits far out in the losing region, " +
        "which is exactly why the first scenario ruins almost everyone.",
    },
    {
      id: "gamblers-ruin",
      status: "planned",
      name: "Gambler's ruin",
      blurb:
        "Fixed-dollar bets against an absorbing barrier at $0 — additive " +
        "dynamics, for contrast with the multiplicative game.",
      note:
        "Will show hitting probability against starting bankroll and bet size, " +
        "plus expected time to absorption. The instructive contrast: here ruin " +
        "comes from the barrier, not from the geometry of the returns.",
    },
    {
      id: "st-petersburg",
      status: "planned",
      name: "St. Petersburg paradox",
      blurb:
        "A wager with infinite expected value that nobody will pay $20 for.",
      note:
        "Will plot the running sample mean refusing to converge as the number of " +
        "plays grows — the cleanest possible demonstration that an expected " +
        "value can exist on paper and be useless in practice.",
    },
    {
      id: "prisoners-dilemma",
      status: "planned",
      name: "Iterated prisoner's dilemma",
      blurb:
        "Actual game theory: tit-for-tat, always-defect and random in a " +
        "round-robin tournament.",
      note:
        "Will show a payoff matrix, cumulative score per strategy, and " +
        "strategy-share evolution under replicator dynamics across generations.",
    },
  ];

  /** Merge a scenario's fixed params with the live control values. */
  function resolveParams(scenario, values) {
    const pr = Object.assign({ seed: 7 }, scenario.fixed || {});
    for (const c of scenario.controls || []) {
      pr[c.key] = values[c.key] !== undefined ? values[c.key] : c.value;
    }
    return pr;
  }

  /** Default control values for a scenario. */
  function defaultValues(scenario) {
    const v = {};
    for (const c of scenario.controls || []) v[c.key] = c.value;
    return v;
  }

  const byId = (id) => SCENARIOS.find((s) => s.id === id);

  Object.assign(EP, {
    SCENARIOS, byId, resolveParams, defaultValues,
    fmt: { money, pct, pctSigned },
  });
})(window.EP);
