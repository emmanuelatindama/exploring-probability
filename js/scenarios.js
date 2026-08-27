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
 *   story    where the game comes from and what it costs you to misread it
 *   controls parameter definitions -> the filter row
 *   fixed    params the scenario pins (not user-editable)
 *   derive   optional (params) -> void, for params computed from other params
 *   compute  params -> { stats, ...chart data }; the only place that calls the
 *            engine, so a chart form never has to know which scenario it is in
 *   charts   which panels to render, in order
 *   tiles    (params, stats) -> KPI row
 *   note     the takeaway prose under the charts
 *
 * A `planned` entry needs id, name, blurb, story and note.
 */
window.EP = window.EP || {};

(function (EP) {
  "use strict";

  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const pctSigned = (v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
  const num = (v, dp) => v.toFixed(dp === undefined ? 2 : dp);
  const count = (v) => Math.round(v).toLocaleString("en-US");

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

  /**
   * Round a vector of exact real counts to integers that still sum to
   * `total` (largest-remainder apportionment).
   *
   * Rounding each cell on its own is what used to put "10 real, 50 false"
   * underneath a headline of 59 on the base-rate tiles: at prevalence 1%
   * with a 95/95 test every one of the four cells lands exactly on a .5
   * boundary, so four independent roundings invented two extra people and
   * the parts stopped summing to the whole. Apportioning once fixes both
   * sums at the same time -- the headline is the sum of the parts shown,
   * and the four cells sum to the population -- while keeping every tile an
   * integer, which reads better on a KPI than "9.5 real, 49.5 false".
   *
   * Assumes the exact values already sum to `total`, which brCounts
   * guarantees; `left` is then 0..values.length-1.
   */
  function largestRemainder(values, total) {
    const floors = values.map(Math.floor);
    // Ties are the common case here rather than the exotic one (four cells
    // all on .5), and the exact values carry float dust, so compare the
    // remainders with a tolerance and fall back to cell order -- otherwise
    // which cell gains the extra person is decided by the last bit of a
    // double and can flip between two visually identical parameter sets.
    const order = values
      .map((v, i) => ({ i, frac: v - Math.floor(v) }))
      .sort((a, b) => (Math.abs(a.frac - b.frac) < 1e-9 ? a.i - b.i : b.frac - a.frac));
    const out = floors.slice();
    let left = Math.round(total) - floors.reduce((a, b) => a + b, 0);
    for (let k = 0; k < order.length && left > 0; k++, left--) out[order[k].i] += 1;
    return out;
  }

  /** Shared by the coin flip and Kelly: E and SD of terminal wealth, exact.
   *  Both scenarios run the identical product-of-multipliers process; Kelly
   *  just exposes f as a slider instead of pinning it to 1. */
  /** A half-life or doubling time is legitimately infinite whenever the thing
   *  is not decaying (or not growing), so every formatter that touches one
   *  needs this rather than printing "Infinity" at the reader. */
  const rounds = (v, unit) =>
    isFinite(v) ? `${num(v, 1)} ${unit}` : "never";

  /** The ergodic coin. The two means ARE the paradox, so they lead: the
   *  arithmetic mean is what "expected value" means and it is above 1, the
   *  geometric mean is what a single player actually compounds at and it is
   *  below 1. Everything else on the page is downstream of that one gap. */
  function coinMeansBox(pr, s) {
    const decays = s.geometricMultiplier < 1;
    // The multipliers actually compounded, after the stake fraction. At f = 1
    // (the ergodic tab) these are just `up` and `down`; Kelly moves them.
    const u = 1 + (pr.up - 1) * pr.f;
    const d = 1 - (1 - pr.down) * pr.f;
    const q = 1 - pr.p;
    const n4 = (v) => num(v, 4);
    return [
      "\\(W_T = w_0\\prod_i M_i\\), each \\(M_i = u\\) w.p. \\(p\\) and \\(d\\) w.p. \\(1-p\\).",
      `Arithmetic mean — the ENSEMBLE average, across many players at one moment: \\(A = p\\,u + (1-p)\\,d = ${n4(pr.p)}\\times${n4(u)} + ${n4(q)}\\times${n4(d)} = ${n4(pr.p * u)} + ${n4(q * d)} = \\mathbf{${n4(s.arithmeticMultiplier)}}\\)`,
      `Geometric mean — the TIME average, along one player's own path: \\(G = u^{p}d^{\\,1-p} = ${n4(u)}^{${n4(pr.p)}}\\times${n4(d)}^{${n4(q)}} = ${n4(Math.pow(u, pr.p))}\\times${n4(Math.pow(d, q))} = \\mathbf{${n4(s.geometricMultiplier)}}\\)`,
      `Same thing as an expected log — this is the definition the engine uses: \\(\\ln G = E[\\ln M] = p\\ln u + (1-p)\\ln d = ${n4(pr.p * Math.log(u))} ${q * Math.log(d) < 0 ? "-" : "+"} ${n4(Math.abs(q * Math.log(d)))} = ${n4(Math.log(s.geometricMultiplier))}\\), so \\(G = e^{E[\\ln M]} = ${n4(s.geometricMultiplier)}\\).`,
      `Volatility drag \\(A - G = ${n4(s.arithmeticMultiplier)} - ${n4(s.geometricMultiplier)} = ${n4(s.volatilityDrag)}\\). This gap IS Jensen's inequality — \\(e^{E[\\ln M]}\\le E[M]\\), equal only if the coin has no spread — and it is the whole distance between the ensemble and one life lived through it.`,
      `\\(E[W_T] = w_0A^{n}\\) = ${money(s.expectedFinal)}, but the typical path compounds at \\(G\\), not \\(A\\).`,
      decays
        ? `\\(G<1\\): the median halves every ${rounds(s.medianHalfLife, "rounds")}. You need ${num(s.breakEvenHeads, 1)} heads of ${count(pr.rounds)} to break even and expect ${num(s.expectedHeads, 1)}.`
        : `\\(G>1\\): the median doubles every ${rounds(s.doublingTime, "rounds")}. Break-even needs ${num(s.breakEvenHeads, 1)} heads of ${count(pr.rounds)}; you expect ${num(s.expectedHeads, 1)}.`,
    ];
  }

  /** Kelly. Same process, but f is the dial, so the box is about where the
   *  growth rate peaks and where it returns to zero rather than about the
   *  two means. */
  function kellyBox(pr, s) {
    // zeroGrowthFraction is a bisection, not algebra, and returns NaN at the
    // degenerate slider ends (up = 1 or down = 1, where there is no game).
    const f0 = isFinite(s.zeroGrowthF) && s.zeroGrowthF > 0
      ? `${pct(s.zeroGrowthF)}` : "—";
    return [
      "Stake a fraction \\(f\\): \\(M = 1+af\\) w.p. \\(p\\), \\(1-bf\\) w.p. \\(1-p\\).",
      `Growth per round \\(g(f) = p\\ln(1+af) + (1-p)\\ln(1-bf)\\) = ${pctSigned(s.timeGrowth)}`,
      `Optimum \\(f^{*} = \\dfrac{pa - (1-p)b}{ab}\\) = ${pct(s.kellyF)}, worth ${pctSigned(s.kellyGrowth)} a round.`,
      `Growth returns to zero at \\(f_0\\) = ${f0} — past there, more stake makes you poorer.`,
      `At your \\(f\\), wealth doubles every ${rounds(s.doublingTime, "rounds")}.`,
      `Geometric mean \\(G = u^{p}d^{\\,1-p}\\) = ${num(s.geometricMultiplier, 4)}; the drag \\(A-G\\) = ${num(s.volatilityDrag, 4)}.`,
      "\\(f_0 = 2f^{*}\\) exactly when \\(p = 1/2\\); elsewhere it is a root find, not algebra.",
    ];
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
              value: 100, int: true, fmt: (v) => `${v}` },
    nPaths: { key: "nPaths", label: "Players simulated", min: 50, max: 2000, step: 50,
              value: 500, int: true, fmt: count },
    f: { key: "f", label: "Fraction of wealth staked", min: 0, max: 1, step: 0.01,
         value: 0.25, fmt: pct },
  };

  const ctrl = (base, over) => Object.assign({}, base, over || {});


  /** Chart data for both multiplicative scenarios. */
  function coinCompute(pr) {
    const sim = EP.simulatePaths(pr);
    return {
      stats: EP.summary(pr),
      sim,
      pathStats: EP.pathStats(sim),
      hist: EP.logHistogram(sim.terminal, 40),
      sweep: EP.kellySweep(pr, 200),
    };
  }

  const SCENARIOS = [
    {
      id: "ergodic-coin",
      status: "ready",
      why:
        "Illustrates that all that glitters is not gold — a positive " +
        "average can still ruin every player who takes it.",
      name: "Ergodic coin flip",
      blurb:
        "Start with $100. Heads adds 50%, tails takes 40%. Positive expected " +
        "value, near-certain ruin — both statements are true at once.",
      story:
        "Does a coin that pays +50% on heads and −40% on tails sound like a " +
        "good deal? The average says yes: +5% a round, forever. In 2011 the " +
        "physicist Ole Peters pointed out that nobody actually collects the " +
        "average. One player, flipping over and over, loses about 5% a round " +
        "and ends up broke. The two numbers describe different things — many " +
        "players at one moment, versus one player over time — and economics " +
        "had quietly assumed they were the same for a century. They are not. " +
        "The process is non-ergodic, and you are not an ensemble.",
      controls: [
        ctrl(COIN_CONTROLS.up), ctrl(COIN_CONTROLS.down), ctrl(COIN_CONTROLS.p),
        ctrl(COIN_CONTROLS.rounds), ctrl(COIN_CONTROLS.nPaths),
      ],
      fixed: { w0: 100, f: 1 },
      compute: coinCompute,
      charts: ["trajectory", "histogram"],
      // CONDITIONAL. The whole verdict turns on the geometric mean per round,
      // s.geometricMultiplier, against 1 -- that is the same crossing the
      // median follows, and it genuinely flips inside the slider ranges (at
      // up=1.5/down=0.6 it crosses near p = 0.56).
      verdict: (pr, s) => {
        const g = s.geometricMultiplier;
        if (g >= 1) {
          return {
            tone: "good",
            headline: "At these settings the typical player compounds — this coin is worth playing.",
            body:
              `The geometric mean, ${num(g, 4)}, is at or above 1 — and that is the time average, the rate ` +
              `one player's wealth actually compounds along a single trajectory. The arithmetic mean, ` +
              `${pctSigned(s.ensembleGrowth)} a round, is the ensemble average across many players at one ` +
              `moment. Here the two agree, so the expected value is not misleading: a typical player ends ` +
              `on ${money(s.medianFinal)} from $100 and only ${pct(s.pBelowStart)} finish below their start.`,
          };
        }
        return {
          tone: "bad",
          headline: "Don't play this coin with your whole stack — the average is not what you collect.",
          body:
            `The geometric mean, ${num(g, 4)}, is below 1 — the time average, what one player's wealth ` +
            `actually compounds at over time. The arithmetic mean, ${pctSigned(s.ensembleGrowth)} a round, ` +
            `is the ensemble average: what you would collect if you could be every player at once. You are ` +
            `one player, not an ensemble, so the two come apart — that is what non-ergodic means. The ` +
            `median ends on ${money(s.medianFinal)} and ${pct(s.pBelowStart)} finish below their stake. ` +
            `Stake a fraction instead — see the Kelly tab.`,
        };
      },
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
      mathBox: coinMeansBox,
      notation: {
        "\\(W_T\\)": "Final wealth after \\(T\\) rounds",
        "\\(w_0\\)": "Initial wealth",
        "\\(n\\)": "Number of rounds",
        "\\(p\\)": "Probability of heads (winning)",
        "\\(1-p\\)": "Probability of tails (losing)",
        "\\(u\\)": "Up-multiplier on heads (e.g. 1.5 = +50%)",
        "\\(d\\)": "Down-multiplier on tails (e.g. 0.6 = −40%)",
        "\\(E[W_T]\\)": "Expected value (long-run average across all players)",
        "\\(SD[W_T]\\)": "Standard deviation (typical spread around the mean)",
      },
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
      why:
        "Extends the ergodic flip: one number turns the same ruinous game " +
        "into a winning one.",
      name: "Kelly bet sizing",
      blurb:
        "The same coin, but you stake only a fraction of your wealth each round. " +
        "One number turns the losing game above into a winning one.",
      story:
        "Bell Labs, 1956. John Kelly had been thinking about noisy telephone " +
        "lines when he noticed that a gambler with inside tips on a horse race " +
        "faces the same mathematics as a signal squeezed down a wire. His " +
        "answer was a single fraction: stake this much of your money and no " +
        "more, and your wealth grows faster than under any other rule. Stake " +
        "more and volatility eats you; stake less and you leave growth on the " +
        "table. Ed Thorp carried it to the blackjack tables and then to Wall " +
        "Street. The fix for the coin above is one line long.",
      controls: [
        ctrl(COIN_CONTROLS.f), ctrl(COIN_CONTROLS.up), ctrl(COIN_CONTROLS.down),
        ctrl(COIN_CONTROLS.p), ctrl(COIN_CONTROLS.rounds), ctrl(COIN_CONTROLS.nPaths),
      ],
      fixed: { w0: 100 },
      compute: coinCompute,
      charts: ["sweep", "trajectory", "histogram"],
      // CONDITIONAL, four ways. The bands are pr.f against s.kellyF: under
      // 0.75x, within +/-25%, over 1.25x but still growing, and past the point
      // where s.timeGrowth itself goes negative (which is roughly 2x Kelly).
      // timeGrowth is used for the last band rather than s.zeroGrowthF because
      // zeroGrowthF is NaN at the slider ends (up = 1.00 or down = 1.00).
      verdict: (pr, s) => {
        const k = s.kellyF;
        if (!(k > 0)) {
          return {
            tone: "bad",
            headline: "There is no edge in this coin — the only stake that doesn't lose is zero.",
            body:
              `There is no positive Kelly fraction for this coin, so no stake on the slider is the ` +
              `growth-maximising one. At your ${pct(pr.f)} stake growth is ${pctSigned(s.timeGrowth)} ` +
              `a round and ${pct(s.pBelowStart)} of players end below their starting stake.`,
          };
        }
        const ratio = pr.f / k;
        if (pr.f <= 0) {
          return {
            tone: "neutral",
            headline: `You are staking nothing, so nothing happens — the growth-maximising stake is ${pct(k)}.`,
            body:
              `Kelly here is ${pct(k)} of wealth per round, worth ${pctSigned(s.kellyGrowth)} a round. ` +
              `Sitting out is safe and returns exactly zero; there is a real edge on the table.`,
          };
        }
        if (s.timeGrowth < 0) {
          return {
            tone: "bad",
            headline: `Cut your stake: at ${pct(pr.f)} you are past the point where more edge makes you poorer.`,
            body:
              `You are betting ${num(ratio)}× the Kelly fraction of ${pct(k)}, and growth has already ` +
              `crossed back through zero to ${pctSigned(s.timeGrowth)} a round. The typical player ends ` +
              `on ${money(s.medianFinal)} and ${pct(s.pBelowStart)} finish below their stake. Kelly itself ` +
              `would compound at ${pctSigned(s.kellyGrowth)}.`,
          };
        }
        if (ratio > 1.25) {
          return {
            tone: "bad",
            headline: `You are betting ${num(ratio)}× Kelly — cut the stake back toward ${pct(k)}.`,
            body:
              `Growth at ${pct(pr.f)} is ${pctSigned(s.timeGrowth)} a round against ${pctSigned(s.kellyGrowth)} ` +
              `at the optimum, so you are taking strictly more volatility for strictly less compounding. ` +
              `${pct(s.pBelowStart)} of players end below their starting stake, and the penalty gets steeper, ` +
              `not gentler, from here.`,
          };
        }
        if (ratio < 0.75) {
          return {
            tone: "neutral",
            headline: `Under-betting at ${num(ratio)}× Kelly — safe, but you are leaving growth on the table.`,
            body:
              `Your ${pct(pr.f)} stake compounds at ${pctSigned(s.timeGrowth)} a round against ` +
              `${pctSigned(s.kellyGrowth)} at the ${pct(k)} optimum. This is the right side to err on — the ` +
              `growth curve is far gentler below the peak than above it — but the gap is real: ` +
              `${money(s.medianFinal)} typical against a Kelly bettor's better outcome.`,
          };
        }
        return {
          tone: "good",
          headline: `Leave it: ${pct(pr.f)} is within a whisker of the ${pct(k)} Kelly optimum.`,
          body:
            `You compound at ${pctSigned(s.timeGrowth)} a round against ${pctSigned(s.kellyGrowth)} at the ` +
            `exact optimum — a difference not worth chasing, because the peak is flat and the cost of ` +
            `overshooting is much larger than the cost of sitting slightly under it. Typical outcome ` +
            `${money(s.medianFinal)}, with ${pct(s.pBelowStart)} of players below their stake.`,
        };
      },
      tiles: (pr, s) => [
        { label: "Optimal stake (Kelly)", value: pct(s.kellyF),
          note: "maximises long-run growth" },
        { label: "Growth per round at your stake", value: pctSigned(s.timeGrowth),
          note: `you are staking ${pct(pr.f)}` },
        { label: "Median final wealth", value: money(s.medianFinal),
          note: "what a typical player gets" },
        { label: "Players who end below start", value: pct(s.pBelowStart),
          note: `of ${count(pr.nPaths)}` },
      ],
      mathBox: kellyBox,
      notation: {
        "\\(W_T\\)": "Final wealth after \\(T\\) rounds",
        "\\(w_0\\)": "Initial wealth",
        "\\(n\\)": "Number of rounds",
        "\\(f\\)": "Fraction of wealth staked each round (Kelly optimizes this)",
        "\\(p\\)": "Probability of heads (winning)",
        "\\(1-p\\)": "Probability of tails (losing)",
        "\\(u\\)": "Up-multiplier on heads (e.g. 1.5 = +50%)",
        "\\(d\\)": "Down-multiplier on tails (e.g. 0.6 = −40%)",
        "\\(E[W_T]\\)": "Expected value (average across all players)",
        "\\(SD[W_T]\\)": "Standard deviation (typical spread)",
      },
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
      status: "ready",
      why:
        "Illustrates absorbing barriers, bankroll constraints, and why " +
        "“just keep playing” fails.",
      name: "Gambler's ruin",
      blurb:
        "Fixed-dollar bets against an absorbing barrier at $0. Additive " +
        "dynamics, for contrast with the multiplicative game — and here the " +
        "safest way to play a bad game is to play it as little as possible.",
      story:
        "You have $100, the house has millions, and the coin is very nearly " +
        "fair. Is “very nearly” good enough? Pascal put a version of this to " +
        "Fermat in 1656, and Huygens made it the fifth problem in the first " +
        "printed textbook of probability a year later. The answer is bleak. " +
        "Against an opponent with unlimited money, even a perfectly fair coin " +
        "ruins you with certainty — the only question is when. Add the " +
        "thinnest edge for the house and ruin arrives sooner. The strangest " +
        "consequence: when the odds are against you, betting big is safer " +
        "than betting small.",
      controls: [
        { key: "bankroll", label: "Your bankroll", min: 20, max: 500, step: 10,
          value: 100, fmt: money },
        { key: "goal", label: "Target", min: 1.2, max: 5, step: 0.1, value: 2.0,
          fmt: (v) => `×${v.toFixed(1)} your bankroll` },
        { key: "p", label: "P(win each round)", min: 0.35, max: 0.65, step: 0.005,
          value: 0.49, fmt: (v) => `${pct(v)} (edge ${pctSigned(2 * v - 1)})` },
        { key: "bet", label: "Bet per round", min: 1, max: 50, step: 1, value: 5,
          int: true, fmt: money },
        { key: "rounds", label: "Rounds played", min: 100, max: 2000, step: 100,
          value: 800, int: true, fmt: count },
        { key: "nPaths", label: "Players simulated", min: 50, max: 1000, step: 50,
          value: 400, int: true, fmt: count },
      ],
      fixed: {},
      // The target is a multiple of the bankroll rather than its own slider, so
      // it can never be set below the starting stake -- a state in which "reach
      // the target before going broke" has no meaning and the closed form has
      // no domain.
      derive: (pr) => { pr.target = pr.bankroll * pr.goal; },
      compute: (pr) => {
        const sim = EP.simulateRuin(pr);
        return {
          stats: EP.ruinSummary(pr),
          sim,
          walk: EP.walkStats(sim),
          curve: EP.ruinCurve(pr, 160),
          betCurve: EP.ruinBetCurve(pr, 120),
        };
      },
      charts: ["ruin-paths", "ruin-curve", "ruin-bet"],
      // CONDITIONAL, and the inversion IS the scenario: the advice about bet
      // size and number of rounds flips sign at pr.p = 0.5 exactly.
      verdict: (pr, s) => {
        if (pr.p < 0.5) {
          return {
            tone: "bad",
            headline: "The edge is against you — if you play at all, bet big and quit early.",
            body:
              `At ${pct(pr.p)} a round the edge is ${pctSigned(s.edge)}, and you go broke with ` +
              `probability ${pct(s.ruinProb)} before reaching ${money(pr.target)}. Every extra round is ` +
              `another chance for the edge to bite, so raising the bet above ${money(pr.bet)} lowers your ` +
              `ruin chance rather than raising it — bold play is the correct play in a bad game. With no ` +
              `target to quit at, ruin is ${pct(s.ruinUnbounded)}.`,
          };
        }
        if (pr.p > 0.5) {
          return {
            tone: "good",
            headline: "The edge is yours — bet small and play long; that is the exact opposite of below 50%.",
            body:
              `At ${pct(pr.p)} the edge is ${pctSigned(s.edge)}, ruin is ${pct(s.ruinProb)} and you reach ` +
              `${money(pr.target)} with probability ${pct(s.reachProb)}. Now that time is working for you, ` +
              `cutting the bet below ${money(pr.bet)} lowers ruin: more rounds means more chances for the ` +
              `edge to assert itself. Even here, ${pct(s.ruinUnbounded)} of players are wiped out if they ` +
              `never set a target to quit at.`,
          };
        }
        return {
          tone: "bad",
          headline: "A fair coin against a deeper pocket is not fair — set a target and walk away at it.",
          body:
            `At exactly 50% ruin is ${pct(s.ruinProb)} against your ${money(pr.target)} target, but with no ` +
            `target at all it is ${pct(s.ruinUnbounded)}: certain, not merely likely. The asymmetry is the ` +
            `barrier, not the odds — $0 absorbs and the house's bankroll does not. Expect ` +
            `${count(s.duration)} rounds either way.`,
        };
      },
      tiles: (pr, s) => [
        { label: "Chance you go broke", value: pct(s.ruinProb),
          note: `exact — a fair coin would be ${pct(s.fairRuinProb)}` },
        { label: `Chance you reach ${money(pr.target)}`, value: pct(s.reachProb),
          note: "exact" },
        { label: "Expected rounds either way", value: count(s.duration),
          note: `${money(pr.bet)} a round, ${s.k} bets in hand` },
        { label: "If the house had no limit", value: pct(s.ruinUnbounded),
          note: "ruin with no target to quit at" },
      ],
      mathBox: (pr, s) => [
        "\\(W\\) is two-point: \\(0\\) or the target, nothing between",
        `\\(E[W] = \\text{target} \\cdot P(\\text{reach})\\)  =  ${money(s.terminalMean)}`,
        `\\(SD[W] = \\text{target}\\sqrt{P(\\text{reach})\\,(1-P(\\text{reach}))}\\)  =  ${money(s.terminalSd)}`,
        "A two-point distribution's mean and SD contain no more information " +
        "than the single probability already on the tiles above — they are " +
        "the same fact, twice.",
      ],
      notation: {
        "\\(W\\)": "Terminal wealth (either $0 or the target)",
        "target": "Goal amount (multiple of your starting bankroll)",
        "\\(P(\\text{reach})\\)": "Probability of reaching the target before going broke",
        "\\(E[W]\\)": "Expected value of terminal wealth",
        "\\(SD[W]\\)": "Standard deviation of terminal wealth",
        "bet": "Fixed dollar amount wagered each round",
        "\\(p\\)": "Probability of winning a single bet",
      },
      note:
        "This game is additive: every round moves you one bet up or down, so " +
        "wealth is a random walk rather than a product. Ruin is not caused by " +
        "the geometry of the returns — it is caused by the barrier. A walk " +
        "that wanders far enough touches $0, and $0 is absorbing, which " +
        "breaks the symmetry between winning and losing streaks. Two things " +
        "are worth playing with. First, set the coin exactly fair and remove " +
        "the target: ruin becomes certain, not likely. A fair game is only " +
        "fair to a player with infinite money, and the house is always the " +
        "one closer to infinite. Second, watch the last chart while you drag " +
        "the win probability across 50%. Below it, raising your bet size " +
        "lowers your chance of ruin: with the edge against you, every extra " +
        "round is another chance for it to bite. Above 50% the curve flips " +
        "and patience wins. That is the exact opposite of the Kelly lesson " +
        "next door, because the barrier here is a fixed number of dollars, " +
        "not a fraction of what you hold.",
    },
    {
      id: "st-petersburg",
      status: "ready",
      why:
        "Challenges naive use of expected value, and connects it to " +
        "utility, finite resources and risk.",
      name: "St Petersburg paradox",
      blurb:
        "A wager with infinite expected value that nobody will pay $20 for. " +
        "Half of all games pay exactly $1.",
      story:
        "A casino offers you this: the pot starts at $1, and every head " +
        "doubles it before the next toss; the first tail ends the game and " +
        "pays out whatever the pot reached — half the time that is still " +
        "just $1, on the very first toss. Keep flipping heads and it " +
        "compounds without limit, so the expected payout is infinite. " +
        "Nicolaus Bernoulli posed this in 1713; nobody offered more than a " +
        "few coins, and nobody could explain why they were right to " +
        "refuse. His cousin Daniel answered from the St Petersburg Academy " +
        "in 1738: money's worth is not its amount.",
      controls: [
        { key: "p", label: "P(the coin keeps going)", min: 0.2, max: 0.7,
          step: 0.01, value: 0.5, fmt: pct },
        { key: "m", label: "Pot multiplier per toss", min: 1.2, max: 3.0,
          step: 0.1, value: 2.0, fmt: (v) => `×${v.toFixed(1)}` },
        { key: "plays", label: "Games played", min: 500, max: 50000, step: 500,
          value: 20000, int: true, fmt: count },
        { key: "runs", label: "Players simulated", min: 3, max: 24, step: 1,
          value: 12, int: true, fmt: count },
        { key: "tiers", label: "Tosses the house will honour", min: 5, max: 40,
          step: 1, value: 31, int: true, fmt: (v) => `${Math.round(v)}` },
      ],
      fixed: {},
      compute: (pr) => {
        const stats = EP.spSummary(pr);
        const shown = Math.min(Math.round(pr.tiers), 20);
        const tiers = [];
        let cumulative = 0;
        for (let t = 1; t <= shown; t++) {
          const contribution = EP.spTierContribution(t, pr.p, pr.m);
          cumulative += contribution;
          tiers.push({
            tier: t,
            payout: Math.pow(pr.m, t - 1),
            prob: EP.spSurvival(t, pr.p) * (1 - pr.p),
            survival: EP.spSurvival(t, pr.p),
            contribution,
            cumulative,
          });
        }
        return { stats, sim: EP.simulateStPetersburg(pr), tiers };
      },
      charts: ["sp-mean", "sp-octaves"],
      // CONDITIONAL on s.divergent, i.e. on m*p >= 1. The recommendation is a
      // price ceiling either way; what changes is whether the advertised mean
      // is a number at all.
      verdict: (pr, s) => {
        if (s.divergent) {
          return {
            tone: "bad",
            headline: `Refuse to pay more than ${money(s.capped)} — the infinite expectation is not collectable.`,
            body:
              `m·p = ${num(s.mp)}, at or above 1, so the mean diverges and no price is "too low" by the ` +
              `expected-value argument. Two finite answers replace it: against a house that can only ` +
              `honour ${money(s.capAmount)} the ticket is worth ${money(s.capped)}, while a log-utility ` +
              `player — Bernoulli's own 1738 resolution — is indifferent at just ` +
              `${money(s.certaintyEquivalent)}. The first prices the counterparty's solvency, the second ` +
              `your own risk appetite. Half of all games pay ${money(s.median)} or less.`,
          };
        }
        const ceiling = Math.min(s.expected, s.capped);
        return {
          tone: "neutral",
          headline: `Pay up to ${money(ceiling)} for this ticket and not a cent more.`,
          body:
            `m·p = ${num(s.mp)} is below 1, so the series converges and the expected payout is an ordinary ` +
            `${money(s.expected)} — the paradox is gone. The median game still pays only ${money(s.median)}, ` +
            `and a real house capped at ${money(s.capAmount)} makes it worth ${money(s.capped)}. ` +
            (s.sdDivergent
              ? `The spread is still infinite (m²p = ${num(s.m2p)} ≥ 1), so a finite mean here does not mean a well-behaved bet.`
              : `The spread is finite too (m²p = ${num(s.m2p)}), so the average of many games actually settles.`),
        };
      },
      tiles: (pr, s) => [
        { label: "Expected payout", value: s.divergent ? "∞" : money(s.expected),
          note: s.divergent
            ? `exact — the series diverges at m·p = ${num(s.mp)} ≥ 1`
            : `exact, m·p = ${num(s.mp)}` },
        { label: "Median payout", value: money(s.median),
          note: "half of all games pay this or less" },
        { label: "Worth against a real house", value: money(s.capped),
          note: `if it can pay at most ${money(s.capAmount)}` },
        { label: `Typical average over ${count(pr.plays)} games`,
          value: money(s.typicalMean),
          note: "approximation — there is no limit to converge to" },
      ],
      mathBox: (pr, s) => [
        "\\(X = m^{N-1}\\), \\(N\\) = toss the first tail lands on. Exact:",
        `\\(E[X] = \\dfrac{1-p}{1-mp}\\)  =  ${s.divergent ? "∞ (mp≥1)" : money(s.expected)}`,
        `\\(SD[X]\\) needs the stricter \\(m^2p<1\\), not just \\(mp<1\\) (\\(m^2p\\) = ${num(s.m2p)})`,
        `\\(SD[X]\\)  =  ${s.sdDivergent ? "∞ — undefined spread" : money(s.sd)}`,
        `Daniel Bernoulli's 1738 answer: \\(E[\\ln X] = \\ln m\\cdot\\dfrac{p}{1-p}\\) = ${num(s.logUtility, 3)}, which converges even where \\(E[X]\\) does not.`,
        `So a log-utility player is indifferent at \\(e^{E[\\ln X]}\\) = ${money(s.certaintyEquivalent)} — a finite price for an infinite expectation.`,
        s.sdDivergent && !s.divergent
          ? "A finite mean and an infinite spread, at once: this is that case."
          : "Whenever mp is close to 1, small changes move both by a lot.",
      ],
      notation: {
        "\\(X\\)": "Payout amount",
        "\\(m\\)": "Pot multiplier per heads flip (e.g., 2 = doubles)",
        "\\(N\\)": "The toss number where the first tail lands",
        "\\(p\\)": "Probability that the coin shows heads (game continues)",
        "\\(1-p\\)": "Probability that the coin shows tails (game ends)",
        "\\(E[X]\\)": "Expected payout (mean across many games)",
        "\\(SD[X]\\)": "Standard deviation of payouts",
        "\\(mp\\)": "Determines if the mean is finite (must be \\(<1\\))",
        "\\(m^2p\\)": "Determines if the SD is finite (must be \\(<1\\), stricter)",
      },
      note:
        "The second chart is the paradox drawn directly. Each bar is one " +
        "outcome's contribution to the expectation — what it pays, times how " +
        "often it happens — and those cancel exactly, so every bar is worth " +
        "$0.50 and the sum runs to infinity by never shrinking. The " +
        "arithmetic is fine; the expectation is just not a number you can " +
        "win. Three things dissolve it, and the nuance is that they are " +
        "independent — no one of them is the answer. Drag m·p below 1 and the " +
        "series converges. Or cap the house: a billion-dollar counterparty " +
        "makes the ticket worth $16, and a richer one barely helps, since " +
        "each doubling adds only fifty cents. Or keep the infinite house and " +
        "price it by log utility, Bernoulli's 1738 answer, which gives $2. So " +
        "there is no single right price. The paradox needs an infinitely rich " +
        "house AND a player who values their millionth dollar as much as " +
        "their first. Mean and spread also come apart: the mean needs m·p < " +
        "1, the spread the stricter m²·p < 1, so at m = 2, p = 0.3 the " +
        "expected payout is $1.75 and the standard deviation infinite.",
    },
    {
      id: "prisoners-dilemma",
      status: "ready",
      why:
        "Connects probability, incentives, cooperation and game theory.",
      name: "Iterated prisoner's dilemma",
      blurb:
        "Actual game theory: five strategies in a round-robin tournament, " +
        "then let the winners breed.",
      story:
        "Two suspects, separate rooms. Betray the other and walk free; stay " +
        "silent together and you both get off lightly. Whatever the other " +
        "does, betraying pays — so both betray, and both lose. RAND invented " +
        "the game in 1950 and Albert Tucker added the prison. Then in 1980 " +
        "Robert Axelrod invited game theorists to submit programs to play it " +
        "over and over. The winner, from the psychologist Anatol Rapoport, " +
        "was four lines long: cooperate first, then copy whatever your " +
        "opponent just did. It beat every clever exploiter in the field " +
        "without ever once outscoring an opponent.",
      controls: [
        { key: "rounds", label: "Rounds per match", min: 5, max: 200, step: 5,
          value: 50, int: true, fmt: count },
        { key: "t", label: "Payoff for betraying (T)", min: 3.1, max: 5.9,
          step: 0.1, value: 5.0,
          fmt: (v) => `${num(v, 1)} vs 3.0 for cooperating` },
        { key: "noise", label: "Chance of a mistaken move", min: 0, max: 0.25,
          step: 0.01, value: 0, fmt: pct },
        { key: "generations", label: "Generations", min: 10, max: 200, step: 10,
          value: 60, int: true, fmt: count },
      ],
      fixed: {},
      compute: (pr) => ({ stats: EP.pdSummary(pr) }),
      charts: ["pd-scores", "pd-matrix", "pd-shares"],
      // ESSENTIALLY FIXED -- but only if you read the right number. A grid
      // sweep over rounds x T x noise gives always-defect the raw TOURNAMENT
      // SCORE at roughly 40% of settings (it takes it whenever matches are
      // short or T is near its ceiling), so hanging the verdict on s.winner
      // would claim a stability the numbers do not support. The evolutionary
      // outcome, s.dominant, is the stable one: reciprocity -- tit for tat or
      // grim trigger -- takes the population nearly everywhere and only
      // surrenders it near the top of the noise slider. So the verdict tracks
      // s.dominant and reports s.winner honestly beside it.
      verdict: (pr, s) => {
        const dom = s.dominant;
        const reciprocal = dom === "tft" || dom === "grim";
        const noisy = pr.noise > 0.05;
        const shared =
          `After ${count(pr.generations)} generations ${EP.STRATEGY_LABELS[dom]} holds ${pct(s.dominantShare)} ` +
          `of the population, while ${EP.STRATEGY_LABELS[s.winner]} tops the round-robin at ` +
          `${num(s.winnerScore)} a round. Always-defect scores ` +
          `${num(s.scores[EP.STRATEGIES.indexOf("alld")])} and never loses a match — which is not the same ` +
          `as collecting the most points.`;
        if (dom === "alld") {
          return {
            tone: "bad",
            headline: "Reciprocity breaks down here: always-defect takes over the population.",
            body:
              shared +
              ` This is the exception, not the rule: across most of these sliders a strategy that cooperates ` +
              `first and then retaliates owns the population. At ${pct(pr.noise)} noise over ` +
              `${count(pr.rounds)} rounds, cooperation is not surviving the mistakes.`,
          };
        }
        if (!reciprocal) {
          // allc (or, rarely, rand) taking the population is the replicator
          // arriving at the fully-cooperative fixed point: once the defectors
          // are gone nothing distinguishes tit for tat from unconditional
          // cooperation, so the share drifts. Calling that a failure of
          // reciprocity would be exactly backwards.
          return {
            tone: "neutral",
            headline: "Cooperation has already won here — there are no defectors left to punish.",
            body:
              shared +
              ` Reciprocity did the work and then became indistinguishable from unconditional cooperation: ` +
              `with the defectors gone, retaliating and never retaliating score identically, so the share ` +
              `drifts. Add noise or a larger temptation payoff and the punishers are the ones that survive.`,
          };
        }
        return {
          tone: "good",
          headline: noisy
            ? `Retaliate once, then forgive — at ${pct(pr.noise)} noise that is what survives.`
            : "Cooperate first, then copy your opponent — that answer holds across nearly all these sliders.",
          body:
            shared +
            (noisy
              ? ` With mistakes at ${pct(pr.noise)} a move, forgiveness is error correction rather than ` +
                `sentiment: grim trigger locks two of its own into permanent mutual defection after a single ` +
                `slip, while tit for tat punishes once and recovers.`
              : ` Raising the noise shifts the crown between forgiving and unforgiving retaliation, and a short ` +
                `match or a large temptation payoff can hand the raw tournament score to always-defect — but ` +
                `reciprocity still owns the population nearly everywhere.`),
        };
      },
      tiles: (pr, s) => {
        const alld = EP.STRATEGIES.indexOf("alld");
        return [
          { label: "Tournament winner", value: EP.STRATEGY_LABELS[s.winner],
            note: `${num(s.winnerScore)} points per round` },
          { label: "Always defect scores", value: num(s.scores[alld]),
            note: "and it never loses a single match" },
          { label: "Tit for tat vs always defect", value: num(s.tftVsAlld),
            note: `the defector gets ${num(s.alldVsTft)}` },
          { label: `Dominant after ${count(pr.generations)} generations`,
            value: EP.STRATEGY_LABELS[s.dominant],
            note: `${pct(s.dominantShare)} of the population` },
        ];
      },
      mathBox: () => [
        "Not applicable here, honestly: with noise=0 these scores ARE the",
        "exact expectation already, from a 16-state Markov chain over the",
        "two players' joint history — not a sample from some distribution",
        "with a mean and a spread of its own. The number on the tile above",
        "is not an estimate of anything; there is nothing left to average.",
      ],
      notation: {
        "\\(T\\)": "Payoff for betraying (temptation to defect)",
        "\\(R\\)": "Payoff for mutual cooperation (reward)",
        "\\(P\\)": "Payoff for mutual defection (punishment)",
        "\\(S\\)": "Payoff for unilateral cooperation (sucker's payoff)",
        "Score": "Points earned per round for each strategy",
      },
      note:
        "Every number here is exact, not simulated. Each strategy needs at " +
        "most two bits of history — your last move, and whether you have ever " +
        "defected — so a pair's joint state is one of sixteen and the " +
        "expected score is a short forward pass, not a Monte Carlo run. The " +
        "result that made Axelrod's tournament famous is in the first two " +
        "charts together. Always-defect cannot be beaten in a single match: " +
        "read down its column and no strategy scores more against it than it " +
        "scores back. It still loses the tournament, because a match is not " +
        "the unit that matters — the total is. Defection wins every " +
        "confrontation and collects 1 point a round doing it, while the " +
        "cooperators quietly bank 3 points a round off each other. Then push " +
        "the noise slider up. Tit for tat and grim trigger both punish " +
        "defection, but grim never forgives, so one mistaken move condemns " +
        "two grim players to defect at each other forever. Tit for tat " +
        "retaliates once and moves on. Forgiveness is not sentiment here; it " +
        "is error correction.",
    },
    {
      id: "monty-hall",
      status: "ready",
      why:
        "Shows how information, and conditional probability, change the " +
        "odds.",
      name: "Monty Hall",
      blurb:
        "Three doors, one prize, a host who knows where it is — and an offer " +
        "to change your mind.",
      story:
        "Three doors: a million dollars behind one, a goat behind each of the " +
        "others. You pick a door. The host, who knows where the money is, " +
        "opens one of the other two to show you a goat, then offers you the " +
        "switch. Does it matter? In 1990 Marilyn vos Savant answered in a " +
        "magazine column: switch, and you win two times out of three. Around " +
        "ten thousand readers wrote in to correct her, hundreds of them with " +
        "doctorates. She was right. Paul Erdős, one of the century's great " +
        "mathematicians, refused to believe it until he was shown a simulation.",
      controls: [
        { key: "doors", label: "Number of doors", min: 3, max: 20, step: 1,
          value: 3, int: true, fmt: (v) => `${Math.round(v)}` },
        { key: "opened", label: "Doors the host opens", min: 1, max: 8, step: 1,
          value: 1, int: true, fmt: (v) => `${Math.round(v)}` },
        { key: "know", label: "P(the host knows where the prize is)",
          min: 0, max: 1, step: 0.01, value: 1.0, fmt: pct },
      ],
      fixed: {},
      // At least one door must remain to switch to -- see mhBoard's clamp on
      // the Python and JS sides. Clamped here too so the tiles and the reader's
      // slider position always agree on what "opened" actually is.
      derive: (pr) => { pr.opened = Math.min(pr.opened, pr.doors - 2); },
      compute: (pr) => ({
        stats: EP.mhSummary(pr),
        knowCurve: EP.mhKnowCurve(pr.doors, pr.opened, 101),
        doorsCurve: EP.mhDoorsCurve(pr.opened, Math.max(15, pr.doors + 5)),
      }),
      charts: ["mh-know", "mh-doors"],
      // FIXED, deliberately. Switching is weakly better at every setting on
      // this page; the single exception is know = 0, where the two are exactly
      // equal. No slider ever makes staying strictly better, and the verdict
      // says that rather than manufacturing contingency.
      verdict: (pr, s) => {
        if (pr.know <= 0) {
          return {
            tone: "neutral",
            headline: "This is the one exception: with a host who knows nothing, switching and staying are worth the same.",
            body:
              `A host opening doors at random who merely happens to reveal only goats has told you nothing, ` +
              `so both doors are worth ${pct(s.switchProb)}. Move the knowledge slider off zero and switching ` +
              `pulls ahead immediately; it never falls behind.`,
          };
        }
        return {
          tone: "good",
          headline: "Switch. No setting on this page makes staying the better play.",
          body:
            `With ${count(s.doors)} doors and ${count(s.opened)} opened, switching wins ${pct(s.switchProb)} ` +
            `against ${pct(s.stayProb)} for staying — ${num(s.ratio)}× as likely. Changing the door count or ` +
            `the number opened moves the size of the advantage, never its sign. The only thing that erases it ` +
            `is the host's knowledge going to zero, where switching is worth ${pct(s.switchRandom)}, exactly ` +
            `what staying is worth.`,
        };
      },
      tiles: (pr, s) => [
        { label: "Switching wins", value: pct(s.switchProb),
          note: "exact, conditional on only goats having been revealed" },
        { label: "Staying wins", value: pct(s.stayProb), note: "exact" },
        { label: "Switching is better by", value: pctSigned(s.advantage),
          note: `${num(s.ratio, 2)}× as likely to win` },
        { label: "If the host opened at random", value: pct(s.switchRandom),
          note: "no advantage to switching at all" },
      ],
      mathBox: (pr, s) => [
        "Switching's outcome is Bernoulli: win the prize w.p. \\(p_{switch}\\)",
        `\\(E[\\text{win}] = p_{switch}\\)  =  ${pct(s.switchProb)}`,
        `\\(SD[\\text{win}] = \\sqrt{p_{switch}(1-p_{switch})}\\)  =  ${num(Math.sqrt(s.switchProb * (1 - s.switchProb)), 3)}`,
        "Same number that is already on the first tile, just named as a " +
        "distribution's own mean and spread rather than a probability.",
      ],
      notation: {
        "\\(p_{switch}\\)": "Probability of winning if you switch doors",
        "\\(1-p_{switch}\\)": "Probability of losing if you switch",
        "\\(E[\\text{win}]\\)": "Expected value of the switching strategy",
        "\\(SD[\\text{win}]\\)": "Standard deviation of the outcome",
        "\\(N\\)": "Total number of doors",
        "\\(k\\)": "Number of doors the host opens to reveal goats",
      },
      note:
        "The two lines on the first chart are the whole mechanism. A knowing " +
        "host can never open the door hiding the prize, so every bit of " +
        "probability that used to sit on the doors he opened has nowhere to " +
        "go but the one door you did not pick and he did not open — which is " +
        "why switching wins with probability (N-1)/(N(N-1-k)) rather than the " +
        "1/(N-k) a coin flip would give you. A host who opens doors at random " +
        "and simply happens not to reveal the prize has told you nothing: the " +
        "lines meet at know=0, and switching is worth exactly what staying is. " +
        "The second chart holds the host's knowledge fixed at each extreme and " +
        "sweeps the number of doors instead — more doors make a knowing host's " +
        "advantage larger, but they cannot manufacture one for a host who " +
        "reveals goats by luck.",
    },
    {
      id: "parrondo",
      status: "ready",
      why:
        "Shows that “losing” is not a property a game carries on its own, " +
        "so options evaluated one at a time can mislead.",
      name: "Parrondo's paradox",
      blurb:
        "Two games that each lose money. Pick between them at random every " +
        "round and the pair of them wins.",
      story:
        "Two games. Play either one on its own, long enough, and you go " +
        "broke. Choose between them at random each round — no pattern, just " +
        "a coin — and you get rich. Juan Parrondo, a physicist in Madrid, " +
        "built this in 1996 out of Feynman's ratchet: random jiggling can be " +
        "rectified into directed motion when the rules keep changing. One " +
        "game's losses reset the odds of the other. The conclusion is " +
        "uncomfortable for anyone who evaluates options one at a time: " +
        "“losing” is not a property a game carries around by itself.",
      controls: [
        { key: "q", label: "P(play game B this round)", min: 0, max: 1,
          step: 0.01, value: 0.5, fmt: pct },
        { key: "eps", label: "House edge on each game", min: 0, max: 0.03,
          step: 0.001, value: 0.005, fmt: pct },
        // A single seeded walk's own noise grows like sqrt(rounds), while its
        // drift from the mix grows like rounds -- at only a couple of
        // thousand rounds the two are the same order of magnitude, and which
        // line looks highest is coin-flip noise, not the real long-run edge.
        // The default is large enough that the drift wins visibly.
        { key: "rounds", label: "Rounds", min: 500, max: 20000, step: 500,
          value: 8000, int: true, fmt: count },
      ],
      fixed: { pBad: 0.1, pGood: 0.75, w0: 0, nPaths: 1 },
      compute: (pr) => {
        const stats = EP.paSummary(pr);
        const [qs, drifts] = EP.paDriftCurve(pr.eps, pr.pBad, pr.pGood, 101);
        const sim = EP.simulateParrondo(pr);
        return { stats, driftCurve: { qs, drifts }, sim };
      },
      charts: ["pa-drift", "pa-paths"],
      // CONDITIONAL: whether s.driftMix clears zero and both pure games, and
      // how far pr.q sits from s.bestQ. q = 0 and q = 1 are the pure games and
      // both lose; the interior wins.
      verdict: (pr, s) => {
        const beatsBoth = s.driftMix > s.driftA && s.driftMix > s.driftB;
        const gap = s.bestDrift - s.driftMix;
        const perRound = (v) => `${v >= 0 ? "+" : ""}${num(v, 4)} per round`;
        if (s.driftMix <= 0) {
          return {
            tone: "bad",
            headline: `Your mix loses money — move q toward ${pct(s.bestQ)}, where the pair of them wins.`,
            body:
              `At q = ${pct(pr.q)} the drift is ${perRound(s.driftMix)}, against ${perRound(s.driftA)} for ` +
              `game A alone and ${perRound(s.driftB)} for game B alone. The best mix, at q = ${pct(s.bestQ)}, ` +
              `earns ${perRound(s.bestDrift)}. Nothing about either game changed; only how often you switch did.`,
          };
        }
        if (beatsBoth && gap <= 0.0002) {
          return {
            tone: "good",
            headline: "Keep this mix: two games that each lose money are, together, making you money.",
            body:
              `q = ${pct(pr.q)} drifts ${perRound(s.driftMix)} while game A alone drifts ${perRound(s.driftA)} ` +
              `and game B alone ${perRound(s.driftB)}. You are effectively at the optimum ` +
              `(q = ${pct(s.bestQ)}, ${perRound(s.bestDrift)}). "Losing" is not a property either game carries ` +
              `on its own — it depends on what it is played alongside.`,
          };
        }
        if (beatsBoth) {
          return {
            tone: "good",
            headline: `Mixing already works — but shift q from ${pct(pr.q)} to ${pct(s.bestQ)} to collect the rest.`,
            body:
              `Your mix drifts ${perRound(s.driftMix)}, ahead of both pure games (${perRound(s.driftA)} and ` +
              `${perRound(s.driftB)}), yet ${num(gap, 4)} per round short of the best mix's ` +
              `${perRound(s.bestDrift)} at q = ${pct(s.bestQ)}.`,
          };
        }
        return {
          tone: "neutral",
          headline: `You are winning, but not from mixing — move q toward ${pct(s.bestQ)} for the paradox itself.`,
          body:
            `At q = ${pct(pr.q)} the drift is ${perRound(s.driftMix)}, which does not beat both pure games ` +
            `(${perRound(s.driftA)} and ${perRound(s.driftB)}). The interesting region is the interior: ` +
            `q = ${pct(s.bestQ)} pays ${perRound(s.bestDrift)}.`,
        };
      },
      tiles: (pr, s) => [
        { label: "Game A alone", value: `${s.driftA >= 0 ? "+" : ""}${s.driftA.toFixed(4)} $/round`,
          note: "a flat, slightly unfavourable coin" },
        { label: "Game B alone", value: `${s.driftB >= 0 ? "+" : ""}${s.driftB.toFixed(4)} $/round`,
          note: "favourable most of the time, terrible at one residue" },
        { label: "Your mix", value: `${s.driftMix >= 0 ? "+" : ""}${s.driftMix.toFixed(4)} $/round`,
          note: `q = ${pct(pr.q)}` },
        { label: "Best possible mix", value: `${s.bestDrift >= 0 ? "+" : ""}${s.bestDrift.toFixed(4)} $/round`,
          note: `at q = ${pct(s.bestQ)}` },
      ],
      mathBox: (pr, s) => [
        "Capital mod 3 is a 3-state Markov chain. Each round you play game B "
        + "w.p. \\(q\\) and game A otherwise, so at residue \\(r\\):",
        `\\(p_r = (1-q)\\left(\\tfrac{1}{2}-\\epsilon\\right) + q\\left(p_r^{B}-\\epsilon\\right)\\), with \\(q\\) = ${pct(pr.q)} and \\(\\epsilon\\) = ${pct(pr.eps)}`,
        `\\(\\text{drift} = \\sum_{r=0}^{2} \\pi_r\\,(2p_r - 1)\\)  =  ${num(s.driftMix, 4)} per round`,
        `Game A alone (\\(q=0\\)): ${num(s.driftA, 4)}; game B alone (\\(q=1\\)): ${num(s.driftB, 4)}; best mix, at \\(q\\) = ${pct(s.bestQ)}: ${num(s.bestDrift, 4)}`,
        "\\(\\pi\\) solves \\(\\pi P = \\pi\\) with \\(\\sum_r \\pi_r = 1\\) — a 3×3 linear "
        + "system, solved exactly rather than sampled, so every drift above "
        + "is a closed form and not a simulated average.",
        "The mix's drift is not the \\(q\\)-weighted average of the two pure "
        + "drifts, because changing \\(q\\) moves \\(\\pi\\) as well as \\(p_r\\). "
        + "That single inequality is the whole paradox.",
      ],
      notation: {
        "\\(q\\)": "Probability of playing game B this round (the mix)",
        "\\(\\epsilon\\)": "House edge subtracted from both games' win probabilities",
        "\\(r\\)": "Your capital modulo 3 — the chain's state",
        "\\(p_r\\)": "P(win this round) at residue \\(r\\) under the mix",
        "\\(p_r^{B}\\)": "Game B's win probability at residue \\(r\\): bad at \\(r=0\\), good otherwise",
        "\\(P\\)": "3×3 transition matrix over the residue \\(r\\)",
        "\\(\\pi\\)": "Stationary distribution: the long-run share of rounds spent at each residue",
        "drift": "Expected dollar change per round, \\(2p-1\\) averaged over \\(\\pi\\)",
      },
      note:
        "Every number on the drift chart is exact: the stationary " +
        "distribution of a 3-state Markov chain over your capital modulo 3, " +
        "solved directly rather than sampled. Both pure games sit below " +
        "zero — that part is not surprising, eps was chosen to guarantee it. " +
        "What is surprising is that a chain mixing the two spends less time " +
        "than one-third each at the residue where game B is terrible, " +
        "because game A's flat coin keeps nudging capital out of it before " +
        "game B's own bad odds can compound there. Set eps to zero and both " +
        "pure games become exactly fair — and a 50/50 mix of them is still " +
        "biased, which is worth dwelling on: the paradox's engine is the " +
        "coupling between which state you tend to occupy and which game's " +
        "probability applies there, and the house edge only decides which " +
        "direction that coupling points, not whether it exists.",
    },
    {
      id: "shannon-demon",
      status: "ready",
      why:
        "Shows that volatility itself can be harvested, and why rebalancing " +
        "is a source of return rather than housekeeping.",
      name: "Shannon's demon",
      blurb:
        "A stock that ends exactly where it started, and a rebalancing rule " +
        "that makes money from it anyway.",
      story:
        "Claude Shannon, who invented information theory, is said to have " +
        "shown an MIT audience how to make money from a stock that goes " +
        "nowhere. Split your money evenly between the stock and cash. Every " +
        "so often, rebalance back to half and half — sell some after it " +
        "rises, buy some after it falls. The stock finishes where it began; " +
        "you finish ahead. What you have harvested is volatility itself, not " +
        "direction. It is Kelly sizing seen from the other side, and it is " +
        "why the ruinous coin becomes a winning one when you stake a quarter.",
      controls: [
        { key: "vol", label: "Size of each move", min: 0.05, max: 0.6, step: 0.01,
          value: 0.3, fmt: (v) => `up ×${(1 + v).toFixed(2)}, down ×${(1 / (1 + v)).toFixed(2)}` },
        { key: "p", label: "P(the stock goes up)", min: 0.3, max: 0.7, step: 0.01,
          value: 0.5, fmt: pct },
        { key: "w", label: "Stock weight (rest in cash)", min: 0, max: 1,
          step: 0.01, value: 0.5, fmt: pct },
        { key: "interval", label: "Rebalance every N periods", min: 1, max: 60,
          step: 1, value: 5, int: true, fmt: (v) => `${Math.round(v)}` },
        { key: "cost", label: "Trading cost (of turnover)", min: 0, max: 0.05,
          step: 0.001, value: 0, fmt: pct },
        { key: "rounds", label: "Periods", min: 50, max: 500, step: 10,
          value: 200, int: true, fmt: count },
      ],
      // One path, deliberately: the scenario is about one seeded price path
      // seen two ways, not a fan of many players -- "New random draw" reseeds
      // the walk (and the interval sweep with it) via the same state.seed the
      // other scenarios already use.
      fixed: { w0: 100, nPaths: 1 },
      compute: (pr) => {
        const stats = EP.sdSummary(pr);
        const sim = EP.simulateRebalance(pr);
        const [xs, gs] = EP.sdIntervalCurve(pr.rounds, pr.p, pr.vol, pr.w,
                                            pr.cost, pr.rounds);
        const harvest = gs.map((g) => g - stats.holdGrowth);
        return { stats, sim, harvestCurve: { xs, harvest } };
      },
      charts: ["sd-paths", "sd-sweep"],
      // CONDITIONAL on the sign of s.harvest (rebalanced growth minus
      // buy-and-hold growth at the same weight). It goes negative as pr.p
      // moves away from 0.5 -- you end up selling a winner into a trend -- and
      // as pr.cost rises past what the variance recovers.
      verdict: (pr, s) => {
        // "every period" / "every 5 periods" -- the interval is a slider that
        // reaches 1, and "every 1 periods" reads like a bug.
        const every = (n) => (Math.round(n) === 1 ? "every period" : `every ${count(n)} periods`);
        // All-cash and all-stock are one-asset portfolios: there is nothing to
        // rebalance between, the harvest is identically zero, and at w = 1 the
        // buy-and-hold growth rate is not even finite. Handled first so no
        // arithmetic below ever has to print it.
        if (pr.w <= 0 || pr.w >= 1 || !isFinite(s.harvest)) {
          return {
            tone: "neutral",
            headline: "Nothing to rebalance: a one-asset portfolio has no volatility to harvest.",
            body:
              `At a ${pct(pr.w)} stock weight the portfolio holds only one thing, so rebalancing is a no-op ` +
              `and the harvest is zero by construction. The stock's own growth rate is ` +
              `${pctSigned(s.stockGrowth)} a period. Move the weight into the interior — ${pct(s.optimalWeight)} ` +
              `is the growth-maximising split for this coin — and the harvest appears.`,
          };
        }
        if (s.harvest > 0) {
          const atBest = Math.round(pr.interval) === Math.round(s.bestInterval);
          return {
            tone: "good",
            headline: atBest
              ? `Keep rebalancing ${every(pr.interval)} — that is the interval that harvests most.`
              : `Rebalance ${every(s.bestInterval)} instead: the harvest is real but you are off the peak.`,
            body:
              `Rebalancing ${every(pr.interval)} grows ${pctSigned(s.rebalGrowth)} a period ` +
              `against ${pctSigned(s.holdGrowth)} for the same mix held untouched — a harvest of ` +
              `${pctSigned(s.harvest)} from a stock whose own growth is ${pctSigned(s.stockGrowth)}. ` +
              `This reverses: push P(up) away from 50% (it is ${pct(pr.p)} now) and you are selling a ` +
              `trending winner, or raise the trading cost above ${pct(pr.cost)} and turnover eats the ` +
              `variance you were collecting. The best schedule here is ${every(s.bestInterval)}, ` +
              `worth ${pctSigned(s.bestGrowth)}.`,
          };
        }
        return {
          tone: "bad",
          headline: "Stop rebalancing at these settings — it is costing you money, not harvesting volatility.",
          body:
            `Rebalancing ${every(pr.interval)} grows ${pctSigned(s.rebalGrowth)} a period ` +
            `against ${pctSigned(s.holdGrowth)} for simply holding the same ${pct(pr.w)} stock weight: a ` +
            `harvest of ${pctSigned(s.harvest)}. The two things that do this are a trending stock ` +
            `(P(up) is ${pct(pr.p)}, and the trick needs roughly 50%) and trading costs (${pct(pr.cost)} of ` +
            `turnover). Even the best available schedule, ${every(s.bestInterval)}, only reaches ` +
            `${pctSigned(s.bestGrowth)}.`,
        };
      },
      tiles: (pr, s) => [
        { label: "Stock's own growth rate", value: pctSigned(s.stockGrowth),
          note: "time-average; zero for the default trendless coin" },
        { label: "Rebalanced growth rate", value: pctSigned(s.rebalGrowth),
          note: `rebalancing every ${pr.interval} period(s)` },
        { label: "Buy-and-hold growth rate", value: pctSigned(s.holdGrowth),
          note: `same mix, never rebalanced, over ${pr.rounds} periods` },
        { label: "Volatility harvested", value: pctSigned(s.harvest),
          note: `best: every ${s.bestInterval} period(s)` },
      ],
      mathBox: (pr, s) => [
        "The growth RATE per period is closed form; wealth in dollars is not,",
        "because each period's return depends on the last rebalance. So the",
        "tiles are exact and the terminal wealth below them is simulated.",
        `Exact discrete harvest at your settings: ${pctSigned(s.harvest)} per period.`,
        `Continuous-rebalancing limit \\(w(1-w)\\sigma^{2}/2\\) = ${pctSigned(s.harvestContinuous)} — an APPROXIMATION to the coin above, and it over-estimates.`,
        `Growth is maximised at \\(w^{*}\\) = ${pct(s.optimalWeight)}, which is exactly the Kelly fraction for this coin.`,
        "Shannon's 50/50 is not a magic split — it is Kelly, and it is 1/2 only because the coin is symmetric.",
      ],
      notation: {
        "\\(w\\)": "Stock weight (fraction of wealth invested in the stock)",
        "\\(1-w\\)": "Cash weight (fraction kept in cash)",
        "\\(p\\)": "Probability the stock goes up each period",
        "vol": "Size of each move (volatility)",
        "\\(u\\)": "Multiplier for an up move, \\(1 + \\text{vol}\\)",
        "\\(d\\)": "Multiplier for a down move, \\(1/(1+\\text{vol})\\)",
        "\\(G\\)": "Growth rate per period (exact, from the tiles above)",
      },
      note:
        "The stock alone has zero time-average growth by construction — up " +
        "and down are reciprocals, so a coin that is heads half the time " +
        "multiplies wealth by up and by 1/up equally often, and those cancel " +
        "in log space. A 50/50 mix rebalanced every period does not cancel: " +
        "each round locks in some of a rise as cash before the next can give " +
        "it back, and buys back cheap after a fall. That asymmetry is the " +
        "harvest, and the second chart shows it has a shape rather than a " +
        "direction: free at zero cost, but pushed to an interior optimum the " +
        "moment trading costs money, because every rebalance past that point " +
        "spends more in turnover than it recovers. Two caveats. This needs a " +
        "trendless or mean-reverting stock — set P(up) away from 50% and " +
        "rebalancing costs you money, because you are selling the winner as " +
        "it starts to run. And the weight that harvests most is exactly the " +
        "Kelly fraction for this coin, which is 1/2 only because the coin is " +
        "symmetric: Shannon's 50/50 is not a magic number, it is Kelly sizing " +
        "under another name.",
    },
    {
      id: "insurance",
      status: "ready",
      why:
        "Explains why both sides of a contract with negative expected value " +
        "can be right to sign it.",
      name: "Insurance and risk pooling",
      blurb:
        "A contract with negative expected value for both sides, which both " +
        "sides are right to sign.",
      story:
        "Insurance is a bad bet. The premium exceeds the expected payout — " +
        "that is how the insurer stays in business — so a player who " +
        "maximises expected wealth should never buy any. Everybody buys it " +
        "anyway, and they are not being stupid. Lloyd's began in a London " +
        "coffee house in 1686, where shipowners who could not survive the " +
        "loss of a single hull found others willing to share it. Both sides " +
        "of that contract gain, which expected value says is impossible. " +
        "Work out how, and you have understood why the average is the wrong " +
        "thing to maximise.",
      controls: [
        { key: "wealth", label: "Buyer's wealth", min: 20000, max: 500000,
          step: 5000, value: 100000, int: true, fmt: money },
        { key: "loss", label: "Loss if it happens", min: 5000, max: 150000,
          step: 1000, value: 30000, int: true, fmt: money },
        { key: "hazard", label: "P(the loss happens)", min: 0.01, max: 0.3,
          step: 0.005, value: 0.05, fmt: pct },
        { key: "sellerWealth", label: "Seller's wealth", min: 200000,
          max: 5000000, step: 50000, value: 1000000, int: true, fmt: money },
        // Defaults to a premium *inside* the mutual-gain band, which for the
        // other default settings is $1,522-$1,768. At $2,000 the opening view
        // contradicted the scenario's own claim: the buyer's curve sat below
        // zero, and "smallest pool that beats buying" collapsed to 1 -- a pool
        // of one being just the uninsured player, i.e. "don't insure at all".
        { key: "premium", label: "Premium you pay", min: 0, max: 20000,
          step: 100, value: 1600, int: true, fmt: money },
        { key: "members", label: "Pool size", min: 1, max: 500, step: 1,
          value: 50, int: true, fmt: count },
      ],
      fixed: {},
      // A loss the buyer's wealth cannot survive breaks ins_uninsured_growth's
      // domain (ln of a negative number), so it is clamped here rather than at
      // every call site -- the same pattern gambler's ruin uses for its target.
      derive: (pr) => { pr.loss = Math.min(pr.loss, pr.wealth * 0.95); },
      compute: (pr) => ({
        stats: EP.insSummary(pr),
        premiumCurve: EP.insPremiumCurve(pr, 160),
        poolCurve: EP.insPoolCurve(pr, Math.max(200, pr.members * 2)),
      }),
      charts: ["ins-band", "ins-pool"],
      // CONDITIONAL: is pr.premium inside [s.sellerMin, s.buyerMax]? Outside,
      // the verdict names which side the contract fails.
      verdict: (pr, s) => {
        if (!s.bandOk) {
          return {
            tone: "bad",
            headline: "No premium works here — there is no price both sides can sign.",
            body:
              `The buyer cannot pay more than ${money(s.buyerMax)} and the seller cannot accept less than ` +
              `${money(s.sellerMin)}, so the band is empty. The seller is too small relative to the ` +
              `${money(pr.loss)} loss to carry it. Pooling is the way out: ${count(pr.members)} equals sharing ` +
              `the risk grow ${pctSigned(s.poolGrowth)} against ${pctSigned(s.uninsuredGrowth)} going it alone.`,
          };
        }
        if (pr.premium < s.sellerMin) {
          return {
            tone: "bad",
            headline: `Too cheap to exist: no insurer writes this below ${money(s.sellerMin)}.`,
            body:
              `At ${money(pr.premium)} the seller's growth rate is ${pctSigned(s.sellerGrowth)} — they are ` +
              `worse off for having written the policy. The mutually acceptable band runs ` +
              `${money(s.sellerMin)} to ${money(s.buyerMax)}, ${money(s.bandWidth)} wide, and sits above the ` +
              `${money(s.expectedPayout)} expected payout precisely because a fair premium helps nobody.`,
          };
        }
        if (pr.premium > s.buyerMax) {
          return {
            tone: "bad",
            headline: `Don't buy at this price — above ${money(s.buyerMax)} you are better off bare.`,
            body:
              `At ${money(pr.premium)} the buyer's insured growth rate is ${pctSigned(s.insuredGrowth)} ` +
              `against ${pctSigned(s.uninsuredGrowth)} uninsured. Anything from ${money(s.sellerMin)} to ` +
              `${money(s.buyerMax)} would leave both sides ahead; you are outside that band by ` +
              `${money(pr.premium - s.buyerMax)}.`,
          };
        }
        return {
          tone: "good",
          headline: `Sign it: at ${money(pr.premium)} both sides raise their long-run growth rate.`,
          body:
            `The premium sits inside the ${money(s.sellerMin)}–${money(s.buyerMax)} band, so the buyer goes ` +
            `from ${pctSigned(s.uninsuredGrowth)} to ${pctSigned(s.insuredGrowth)} and the seller earns ` +
            `${pctSigned(s.sellerGrowth)} — both better off, at a price ${money(pr.premium - s.expectedPayout)} ` +
            `above the ${money(s.expectedPayout)} expected payout. Expected value calls that impossible; it is ` +
            `expected value that is measuring the wrong thing.`,
        };
      },
      tiles: (pr, s) => [
        { label: "Expected payout", value: money(s.expectedPayout),
          note: "what expected value says the premium should be" },
        { label: "Buyer's max premium", value: money(s.buyerMax),
          note: "most the buyer can pay and still improve" },
        { label: "Seller's min premium", value: money(s.sellerMin),
          note: "least the seller can accept and still improve" },
        { label: "A band exists", value: s.bandOk ? "Yes" : "No",
          note: s.bandOk ? `width ${money(s.bandWidth)}`
                          : "no premium helps both sides" },
      ],
      mathBox: (pr, s) => [
        "The loss event is Bernoulli: lose \\(L\\) w.p. \\(h\\) (the hazard)",
        `\\(E[\\text{loss}] = h \\cdot L\\)  =  ${money(s.expectedPayout)}`,
        `\\(SD[\\text{loss}] = L\\sqrt{h(1-h)}\\)  =  ${money(pr.loss * Math.sqrt(pr.hazard * (1 - pr.hazard)))}`,
        "This pair is exactly what expected-value logic gets right on its " +
        "own terms — and still not enough, on its own, to explain why both " +
        "sides are correct to sign at a premium above \\(h \\cdot L\\).",
      ],
      notation: {
        "\\(L\\)": "Dollar amount of the loss if it happens",
        "\\(h\\)": "Hazard: probability the loss event occurs",
        "\\(1-h\\)": "Probability the loss does not occur",
        "premium": "Price of the insurance contract",
        "\\(E[\\text{loss}]\\)": "Expected value of the loss",
        "\\(SD[\\text{loss}]\\)": "Standard deviation of the loss",
        "wealth": "Buyer's starting capital",
        "sellerWealth": "Seller's/insurer's starting capital",
      },
      note:
        "Expected value says a fair premium is pi × L, and that a rational " +
        "insurer must charge more than that to survive — so on that measure " +
        "insurance can only be a transfer, never a mutual gain. The band on " +
        "the first chart is the rebuttal: because ln is concave, the same " +
        "dollar of variance costs the small buyer more than the large seller, " +
        "so a premium well above pi × L still leaves the buyer better off, " +
        "and a seller who could never accept exactly pi × L can profitably " +
        "accept anything above their own minimum. Dial in any premium inside " +
        "the shaded band and both curves are positive — both parties improved " +
        "their growth rate, and nobody had to be wrong. The second chart " +
        "drops the seller entirely: a mutual pool of equals, each carrying an " +
        "equal share of however many losses land among them. Even a pool of " +
        "two beats going it alone, and the curve climbs toward the dashed " +
        "line — the growth rate an infinitely large insurer could offer at " +
        "cost — without any counterparty taking the other side.",
    },
    {
      id: "base-rates",
      status: "ready",
      why:
        "Explains why a highly accurate test can still be wrong most of the " +
        "times it fires.",
      name: "Base rates and the 95% test",
      blurb:
        "A 95% accurate test comes back positive. The chance you are ill is " +
        "about 2%.",
      story:
        "A test for a disease is 95% accurate. Your result is positive. What " +
        "is the chance you have it? A version of this was put to staff and " +
        "students at Harvard Medical School in 1978; the single most popular " +
        "answer was 95%. The right answer was about 2%. The missing quantity " +
        "is how rare the disease was to begin with, and almost nobody reaches " +
        "for it unprompted. Kahneman and Tversky built a career on this blind " +
        "spot. It isn't innumeracy — ask the same question in counts of " +
        "people rather than percentages and most of the error evaporates.",
      controls: [
        { key: "prior", label: "Prevalence", min: 0.0005, max: 0.3, step: 0.0005,
          value: 0.001, fmt: pct },
        { key: "sens", label: "Sensitivity: P(positive | sick)", min: 0.5,
          max: 0.999, step: 0.001, value: 0.95, fmt: pct },
        { key: "spec", label: "Specificity: P(negative | healthy)", min: 0.5,
          max: 0.999, step: 0.001, value: 0.95, fmt: pct },
        { key: "population", label: "People tested", min: 100, max: 100000,
          step: 100, value: 1000, int: true, fmt: count },
      ],
      fixed: {},
      compute: (pr) => {
        const stats = EP.brSummary(pr);
        const [xs, ys] = EP.brPrevalenceCurve(pr.sens, pr.spec, 200);
        return { stats, prevalenceCurve: { xs, ys } };
      },
      charts: ["br-prevalence", "br-grid"],
      // CONDITIONAL, and it genuinely flips: s.posteriorPos crosses 20% and
      // then 50% as prevalence rises, turning "ignore this result" into
      // "act on it" without the test itself changing at all.
      verdict: (pr, s) => {
        const post = s.posteriorPos;
        const lr = pr.sens / (1 - pr.spec);
        const shared =
          `At a prevalence of ${pct(pr.prior)} with a ${pct(pr.sens)}/${pct(pr.spec)} test, a positive means ` +
          `${pct(post)}. Of ${count(pr.population)} people tested, ${count(Math.round(s.tp))} are real positives ` +
          `and ${count(Math.round(s.fp))} are false ones. The test's likelihood ratio is ${num(lr, 1)} and does ` +
          `not depend on prevalence at all — the prior odds do all the moving.`;
        if (post >= 0.5) {
          return {
            tone: "good",
            headline: `A positive is actionable here: ${pct(post)} of the people it flags really are sick.`,
            body:
              shared +
              ` Confirmatory testing is still worth it, but at this prevalence the single result already ` +
              `carries most of the answer. Drag prevalence down and this reverses completely.`,
          };
        }
        if (post >= 0.2) {
          return {
            tone: "neutral",
            headline: `Treat a positive as a reason to test again, not to treat: only ${pct(post)} are real.`,
            body:
              shared +
              ` This is the genuinely awkward middle — too high to dismiss, too low to act on alone. A second ` +
              `independent test multiplies the odds by ${num(lr, 1)} again, which is what resolves it.`,
          };
        }
        return {
          tone: "bad",
          headline: `Don't act on a single positive — ${pct(1 - s.precision)} of the people it flags are healthy.`,
          body:
            shared +
            ` The false positives among a large healthy group outnumber the true positives among a small sick ` +
            `one. A negative, meanwhile, leaves only ${pct(s.posteriorNeg)} — the reassuring number nobody asks for.`,
        };
      },
      // brCounts is exact and lands on half-people at plenty of ordinary
      // settings (prevalence 1%, 95/95, 1000 people puts all four cells on a
      // .5 boundary). Rounding each cell independently made the headline
      // disagree with its own note -- 59 positives over "10 real, 50 false"
      // -- and made the four cells sum to 1,002 of a 1,000-person
      // population. One apportionment fixes both: see largestRemainder.
      tiles: (pr, s) => {
        const [tp, fp] = largestRemainder([s.tp, s.fp, s.fn, s.tn], pr.population);
        return [
          { label: "P(sick | positive)", value: pct(s.posteriorPos),
            note: "the number the test result actually supports" },
          { label: "P(sick | negative)", value: pct(s.posteriorNeg),
            note: "the reassuring number nobody asks for" },
          { label: "Positives, real and false", value: count(tp + fp),
            note: `${count(tp)} real, ${count(fp)} false, of ${count(pr.population)}` },
          { label: "Precision of a positive", value: pct(s.precision),
            note: "share of positives that are actually sick" },
        ];
      },
      mathBox: (pr, s) => [
        "Prevalence \\(\\pi\\), sensitivity \\(=P(T^+\\mid D^+)\\), specificity \\(=P(T^-\\mid D^-)\\). Bayes' theorem:",
        `\\(P(D^+\\mid T^+) = \\dfrac{\\text{sens}\\cdot\\pi}{\\text{sens}\\cdot\\pi + (1-\\text{spec})(1-\\pi)}\\)  =  ${pct(s.posteriorPos)}`,
        `\\(P(D^+\\mid T^-) = \\dfrac{(1-\\text{sens})\\,\\pi}{(1-\\text{sens})\\,\\pi + \\text{spec}\\,(1-\\pi)}\\)  =  ${pct(s.posteriorNeg)}`,
        `In odds form: \\(\\dfrac{P(D^+\\mid T^+)}{P(D^-\\mid T^+)} = \\Lambda \\cdot \\dfrac{\\pi}{1-\\pi}\\), with \\(\\Lambda = \\dfrac{\\text{sens}}{1-\\text{spec}}\\)  =  ${num(pr.sens / (1 - pr.spec), 1)}`,
        `Among \\(N\\) = ${count(pr.population)}: \\(TP = N\\,\\text{sens}\\,\\pi\\) = ${num(s.tp, 1)}, \\(FP = N(1-\\text{spec})(1-\\pi)\\) = ${num(s.fp, 1)}, \\(FN\\) = ${num(s.fn, 1)}, \\(TN\\) = ${num(s.tn, 1)}`,
        `\\(\\Lambda\\) is everything the test contributes, and it does not depend on \\(\\pi\\) at all: the posterior swings from single digits to near-certainty purely because the prior odds \\(\\pi/(1-\\pi)\\) move, which is exactly the term the 1978 respondents dropped.`,
      ],
      notation: {
        "\\(\\pi\\)": "Prevalence: P(sick) before any test, the base rate",
        "\\(D^+\\) / \\(D^-\\)": "The person is sick / not sick",
        "\\(T^+\\) / \\(T^-\\)": "The test reads positive / negative",
        "sens": "Sensitivity, \\(P(T^+\\mid D^+)\\) — the true-positive rate",
        "spec": "Specificity, \\(P(T^-\\mid D^-)\\) — the true-negative rate",
        "\\(1-\\text{spec}\\)": "False-positive rate: healthy people the test flags anyway",
        "\\(\\Lambda\\)": "Likelihood ratio of a positive result, \\(\\text{sens}/(1-\\text{spec})\\)",
        "\\(P(D^+\\mid T^+)\\)": "The posterior: P(sick) given a positive result",
        "\\(N\\)": "People tested; \\(TP, FP, FN, TN\\) are the four cells of the 2×2 table",
      },
      note:
        "The first chart is Bayes' theorem with the prevalence doing all the " +
        "work: sensitivity and specificity held fixed at 95%, P(sick | " +
        "positive) still swings from single digits to near-certainty purely " +
        "as the disease gets more or less common. The second chart is the " +
        "same theorem multiplied through by a headcount instead of left as a " +
        "ratio — the false positives among healthy people (a large group, " +
        "each facing a small individual chance) can still outnumber the true " +
        "positives among sick people (a small group, each facing a large " +
        "chance), and counting that out directly is what the 1978 Harvard " +
        "study found fixed the intuition that the probability form alone " +
        "kept breaking.",
    },
    {
      id: "simpsons-paradox",
      status: "ready",
      why:
        "Highly relevant to business, clinical and observational data " +
        "analysis.",
      name: "Simpson's paradox",
      blurb:
        "A treatment that wins in every subgroup and loses overall. Nothing " +
        "is faked — the two arms were simply filled differently.",
      story:
        "A new treatment does better than the old one for mild cases. It " +
        "also does better for severe cases. Pooled together, it does worse. " +
        "Nothing has been faked and no arithmetic is wrong. Edward Simpson " +
        "described the effect in 1951, though Yule had it in 1903; the " +
        "famous instance is Berkeley's 1973 graduate admissions, where women " +
        "were admitted at a higher rate in almost every department and a " +
        "lower rate overall. The trap is that the groups were not filled the " +
        "same way, and pooling hides who went where.",
      controls: [
        { key: "pEasy", label: "Success rate, easy cases", min: 0.5, max: 0.98,
          step: 0.01, value: 0.9, fmt: pct },
        { key: "pHard", label: "Success rate, hard cases", min: 0.05, max: 0.6,
          step: 0.01, value: 0.4, fmt: pct },
        { key: "delta", label: "Treatment A's real advantage", min: 0, max: 0.2,
          step: 0.005, value: 0.05, fmt: (v) => `+${pct(v)} in BOTH subgroups` },
        { key: "wA", label: "Share of A's cases that are easy", min: 0.05,
          max: 0.95, step: 0.01, value: 0.2, fmt: pct },
        { key: "wB", label: "Share of B's cases that are easy", min: 0.05,
          max: 0.95, step: 0.01, value: 0.8, fmt: pct },
        { key: "nA", label: "Cases given treatment A", min: 100, max: 2000,
          step: 100, value: 200, int: true, fmt: count },
      ],
      // B's caseload matches A's: the paradox is about the MIX, and letting
      // the two totals differ as well would muddy which asymmetry is doing
      // the work.
      fixed: { nB: 200 },
      // analytics.py deliberately does NOT clamp these -- clamping inside the
      // closed form would break the reversal identity rather than protect it
      // -- so bounding them is the caller's job, the same way gambler's ruin
      // clamps its target and Monty Hall its opened-door count.
      derive: (pr) => {
        pr.nB = pr.nA;
        // The "easy" subgroup has to actually be easier, or the labels lie
        // and the difficulty gap silently changes sign.
        pr.pHard = Math.min(pr.pHard, pr.pEasy - 0.01);
        // A success rate cannot exceed 1, and p_easy + delta is a rate.
        pr.delta = Math.min(pr.delta, 1 - pr.pEasy);
      },
      compute: (pr) => {
        const stats = EP.simpsonsSummary(pr);
        // The boundary is delta_crit as the allocation gap varies, holding the
        // difficulty gap fixed. Swept through the engine rather than
        // multiplied out here, so there is one definition of "critical".
        const gaps = [], deltaCrit = [];
        for (let i = 0; i <= 100; i++) {
          const g = i / 100;
          gaps.push(g);
          deltaCrit.push(EP.simpsonsDeltaCritical(pr.pEasy, pr.pHard, 0, g));
        }
        return {
          stats,
          bars: {
            groups: ["Easy cases", "Hard cases", "Everyone (pooled)"],
            a: [stats.rateEasyA, stats.rateHardA, stats.pooledA],
            b: [stats.rateEasyB, stats.rateHardB, stats.pooledB],
            reverses: stats.reverses,
          },
          boundary: {
            gaps, deltaCrit,
            // The chart shades "below the line" as the reversal region, which
            // only reads correctly on the non-negative side. A gap favouring A
            // cannot reverse anything, so clamping to 0 is the honest marker
            // position, and the verdict states the real sign.
            gapNow: Math.max(0, stats.allocationGap),
            deltaNow: pr.delta,
            reverses: stats.reverses,
          },
        };
      },
      charts: ["simpson-bars", "simpson-boundary"],
      tiles: (pr, s) => [
        { label: "A's edge in each subgroup", value: pctSigned(s.subgroupDiff),
          note: "the same in easy and hard cases, by construction" },
        { label: "A's edge once pooled", value: pctSigned(s.pooledDiff),
          note: s.reverses ? "the sign has flipped" : "same sign — no reversal" },
        { label: "Effect needed to survive pooling",
          value: pctSigned(s.deltaCritical),
          note: "exact — allocation gap × difficulty gap" },
        { label: "Allocation gap", value: pctSigned(s.allocationGap),
          note: `B gets this much more of the easy cases` },
      ],
      mathBox: (pr, s) => [
        `A beats B by \\(\\delta\\) = ${pct(pr.delta)} in BOTH subgroups, by construction.`,
        `Pooled: \\(P_A = w_A\\,p_e + (1-w_A)\\,p_h + \\delta = ${pct(s.pooledA)}\\)`,
        `\\(P_B = w_B\\,p_e + (1-w_B)\\,p_h = ${pct(s.pooledB)}\\)`,
        `Subtract: \\(P_A - P_B = \\delta - (w_B - w_A)(p_e - p_h) = ${pctSigned(s.pooledDiff)}\\)`,
        `So the trend reverses exactly when \\(\\delta < (w_B - w_A)(p_e - p_h)\\) = ${pct(s.deltaCritical)}, and here \\(\\delta\\) = ${pct(pr.delta)}.`,
        `That threshold is a product of two gaps: allocation ${pctSigned(s.allocationGap)} times difficulty ${pct(s.difficultyGap)}.`,
        "Set the two allocation sliders equal and the threshold is 0 — no effect size, however small, can reverse. That is what randomising does.",
      ],
      notation: {
        "\\(p_e\\)": "Success rate in the easy subgroup, before any treatment effect",
        "\\(p_h\\)": "Success rate in the hard subgroup",
        "\\(\\delta\\)": "Treatment A's true advantage, added in BOTH subgroups",
        "\\(w_A\\)": "Fraction of A's cases drawn from the easy subgroup",
        "\\(w_B\\)": "The same fraction for B",
        "\\(P_A, P_B\\)": "Each treatment's pooled success rate",
      },
      verdict: (pr, s) => {
        if (s.reverses) {
          return {
            tone: "bad",
            headline: "Do not read the pooled number here — it points the opposite way to the evidence.",
            body:
              `A beats B by ${pctSigned(s.subgroupDiff)} in easy cases and by the same ` +
              `${pctSigned(s.subgroupDiff)} in hard ones, yet trails by ${pctSigned(-s.pooledDiff)} pooled. ` +
              `B simply received ${pctSigned(s.allocationGap)} more of the easy caseload. Report the ` +
              `subgroups, or the effect needs to clear ${pct(s.deltaCritical)} to survive pooling.`,
          };
        }
        if (s.allocationGap <= 0) {
          return {
            tone: "good",
            headline: "Safe to pool: the mix favours A, so pooling cannot hide A's advantage.",
            body:
              `A leads by ${pctSigned(s.subgroupDiff)} in both subgroups and by ` +
              `${pctSigned(s.pooledDiff)} pooled. With B taking no more of the easy cases than A, ` +
              `there is no confound pushing the other way.`,
          };
        }
        return {
          tone: "neutral",
          headline: "The pooled number survives here, but only because the effect is bigger than the confound.",
          body:
            `A's ${pctSigned(s.subgroupDiff)} edge clears the ${pct(s.deltaCritical)} needed to ` +
            `absorb an allocation gap of ${pctSigned(s.allocationGap)}, leaving ${pctSigned(s.pooledDiff)} ` +
            `pooled. Shrink the effect below that threshold and the sign flips.`,
        };
      },
      note:
        "The first chart is the paradox itself: A above B in the easy cases, " +
        "above B in the hard cases, and below B once the two are pooled. " +
        "Every number is a real rate over real cases. " +
        "The mechanism is the mix, not the medicine. Easy cases succeed more " +
        "often whoever treats them, so an arm handed mostly easy cases " +
        "inherits a high pooled rate it did not earn. Pooling weights each " +
        "subgroup by how many cases that arm happened to receive, so if the " +
        "two arms received different mixes the pooled comparison is " +
        "answering a different question from either subgroup comparison. " +
        "The second chart draws the exact line. Reversal needs the " +
        "allocation gap times the difficulty gap to exceed the true effect; " +
        "anything above that line survives pooling. Drag the two allocation " +
        "sliders together and the threshold falls to zero, so no effect size " +
        "however small can reverse — which is the whole argument for " +
        "randomising: it forces the mixes to match, and then the pooled " +
        "number and the subgroup numbers cannot disagree.",
    },
    {
      id: "birthday",
      status: "ready",
      why:
        "Demonstrates how quickly the number of possible pairs grows.",
      name: "The birthday problem",
      blurb:
        "Twenty-three people in a room, and better-than-even odds that two " +
        "share a birthday.",
      story:
        "How many people do you need in a room before two of them probably " +
        "share a birthday? The answer is 23, and almost nobody guesses it — " +
        "intuition reaches for 183, half of 365. Richard von Mises worked it " +
        "out in 1939. What intuition misses is that you are not comparing " +
        "yourself against everyone else; you are comparing everyone against " +
        "everyone, and 23 people make 253 pairs. Cryptographers took the same " +
        "arithmetic and turned it into a way of breaking hash functions, " +
        "where it still goes by the name of the birthday attack.",
      controls: [
        { key: "n", label: "People in the room", min: 2, max: 100, step: 1,
          value: 23, int: true, fmt: (v) => `${Math.round(v)}` },
        { key: "days", label: "Days in a year", min: 10, max: 365, step: 1,
          value: 365, int: true, fmt: (v) => `${Math.round(v)}` },
        { key: "bits", label: "Digest length (bits)", min: 8, max: 64, step: 1,
          value: 8, int: true, fmt: (v) => `${Math.round(v)}` },
      ],
      fixed: {},
      compute: (pr) => {
        const stats = EP.bdSummary(pr);
        const [cxs, cys] = EP.bdCollisionCurve(pr.days, 80);
        const [bxs, bys] = EP.bdHashBitsCurve(8, 64, 57);
        return { stats, collisionCurve: { xs: cxs, ys: cys },
                 hashBitsCurve: { xs: bxs, ys: bys } };
      },
      charts: ["bd-collision", "bd-hash"],
      // FIXED. Collisions are always far more likely than intuition says, and
      // digest length always has to grow to compensate; no slider reverses
      // either. Only the size of the number changes.
      verdict: (pr, s) => {
        const bits = Math.round(pr.bits);
        const shared =
          `${count(pr.n)} people in a ${count(pr.days)}-day year make ${count(s.pairs)} pairs, not ` +
          `${count(pr.n)} comparisons — which is why the collision probability is ${pct(s.collisionProb)} ` +
          `and even odds arrive at ${count(s.halfLifeN)} people. At ${count(bits)} bits the same ` +
          `arithmetic collides after about ${count(s.hashN50)} hashes.`;
        if (s.hashN50 < 1e9) {
          return {
            tone: "bad",
            headline: `Never ship a digest this short: ${count(bits)} bits collides after about ${count(s.hashN50)} hashes.`,
            body:
              shared +
              ` No setting on this page makes collisions rarer than intuition expects — the conclusion does ` +
              `not reverse, only its scale changes. Budget for the square root of the space: doubling the ` +
              `digest length squares the attacker's work.`,
          };
        }
        return {
          tone: "neutral",
          headline: "Size digests by the square root of the space — that rule never reverses here.",
          body:
            shared +
            ` Collisions are always far more likely than the "half the space" intuition suggests, at every ` +
            `setting here. And doubling the digest length squares the attacker's work, which is the actual ` +
            `reason hash lengths come in the sizes they do.`,
        };
      },
      tiles: (pr, s) => [
        { label: "P(shared birthday)", value: pct(s.collisionProb), note: "exact" },
        { label: "Pairs being compared", value: count(s.pairs),
          note: `${count(pr.n)} people, C(n,2) pairs` },
        { label: "50% odds at", value: `${s.halfLifeN} people`,
          note: `for a ${count(pr.days)}-day year` },
        { label: "8-bit hash, 50% odds at", value: count(s.hashN50),
          note: "approximation — exact enumeration is infeasible past ~40 bits" },
      ],
      mathBox: (pr, s) => [
        "With \\(n\\) people and \\(d\\) equally likely days, count the orderings that avoid a repeat:",
        `\\(P(\\text{no collision}) = \\dfrac{d!}{(d-n)!\\,d^{\\,n}} = \\prod_{i=0}^{n-1}\\left(1-\\dfrac{i}{d}\\right)\\)  =  ${pct(1 - s.collisionProb)}`,
        `\\(P(\\text{collision}) = 1 - \\prod_{i=0}^{n-1}\\left(1-\\dfrac{i}{d}\\right)\\)  =  ${pct(s.collisionProb)}`,
        `\\(\\binom{n}{2} = \\dfrac{n(n-1)}{2}\\)  =  ${count(s.pairs)} pairs — quadratic in \\(n\\), which is what the product is really tracking`,
        `Smallest \\(n\\) with \\(P(\\text{collision}) \\ge \\tfrac{1}{2}\\)  =  ${count(s.halfLifeN)}, found by scanning that exact product, not by a formula`,
        `APPROXIMATION, and the only one here: for a \\(b\\)-bit digest (\\(d = 2^{b}\\)), \\(n_{50\\%} \\approx \\sqrt{2d\\ln 2} \\approx 1.177\\sqrt{d}\\)  =  ${count(s.hashN50)}`,
        "Everything above the last line is exact. The hash tile has to be an "
        + "approximation because the exact product needs \\(n\\) terms and \\(n\\) "
        + "runs into the billions — but \\(\\sqrt{d}\\) is also the honest headline: "
        + "doubling the digest length squares the attacker's work.",
      ],
      notation: {
        "\\(n\\)": "People in the room (or hashes an attacker computes)",
        "\\(d\\)": "Number of equally likely days — or \\(2^{b}\\) possible digests",
        "\\(b\\)": "Digest length in bits",
        "\\(\\binom{n}{2}\\)": "Number of distinct pairs among \\(n\\) people",
        "\\(P(\\text{collision})\\)": "Probability at least two people share a day",
        "\\(n_{50\\%}\\)": "Group size at which a collision becomes more likely than not",
      },
      note:
        "The first chart's steepness is the whole surprise: with 365 days, " +
        "the curve crosses 50% at 23 people, not 183 (half a year), because " +
        "the comparison is between every pair of people, not between you and " +
        "everyone else. 23 people make 253 pairs — quadratic in the group " +
        "size — and it is that quadratic growth in comparisons the curve is " +
        "actually tracking. The second chart takes the identical mathematics " +
        "to a cryptographic hash, where 'days in a year' becomes 2^bits " +
        "possible digests: exact enumeration stops being possible once the " +
        "answer itself reaches into the billions, so past that point the " +
        "curve is the closed-form approximation n ~ sqrt(2 * 2^bits * ln 2) " +
        "rather than a counted answer — checked against exact enumeration " +
        "while enumeration is still fast, and it only gets more accurate as " +
        "the digest grows. Doubling the digest length does not double the " +
        "attacker's work, it roughly squares it, which is the actual reason " +
        "hash lengths come in the sizes they do.",
    },
    {
      id: "secretary",
      status: "ready",
      why:
        "A practical model for hiring, purchasing and search decisions.",
      name: "The secretary problem",
      blurb:
        "Candidates arrive one at a time and you cannot go back. Look at 37%, " +
        "then take the next one that beats them all.",
      story:
        "Candidates arrive one at a time. You must accept or reject each on " +
        "the spot, and rejection is final. How do you maximise the chance of " +
        "choosing the best? Kepler, hunting for a second wife in 1611, " +
        "interviewed eleven and agonised for two years. The mathematics " +
        "arrived in the 1950s and reached the public through Martin Gardner " +
        "in 1960: reject the first 37% no matter how good they are, then take " +
        "the first candidate better than everyone you have seen. It finds the " +
        "very best about 37% of the time, and nothing does better.",
      controls: [
        { key: "n", label: "Candidates", min: 5, max: 500, step: 1, value: 100,
          int: true, fmt: count },
        { key: "s", label: "Candidates skipped before deciding", min: 0, max: 100,
          step: 1, value: 37, int: true, fmt: (v) => `${Math.round(v)}` },
      ],
      // The skip count is a count, not a fraction, so it can outrun a smaller
      // n the reader dials down to afterward -- clamped here for the same
      // reason Monty Hall's `opened` is, and synced back to the slider by
      // the same app.js machinery.
      derive: (pr) => { pr.s = Math.min(pr.s, pr.n); },
      fixed: {},
      compute: (pr) => {
        const stats = EP.secSummary(pr);
        const [xs, ys] = EP.secWinCurve(pr.n);
        const [ns, asymYs] = EP.secAsymptoticCurve(5, 500, 30);
        return { stats, winCurve: { xs, ys }, asymptotic: { ns, ys: asymYs } };
      },
      charts: ["sec-threshold", "sec-asymptotic"],
      // CONDITIONAL on how much st.bestProb - st.winProb your skip costs, but
      // the honest lesson is the flatness: within 2 points of the optimum the
      // right advice is "stop tuning it".
      // (pr, st): this scenario's own skip count is pr.s, so `s` is taken.
      verdict: (pr, st) => {
        const cost = st.bestProb - st.winProb;
        if (cost <= 0.02) {
          return {
            tone: "good",
            headline: `Stop tuning it — skipping ${count(pr.s)} is worth ${pct(st.winProb)} against the best possible ${pct(st.bestProb)}.`,
            body:
              `The optimum is ${count(st.bestS)}, or ${pct(st.bestFraction)} of the field, but the peak is flat: ` +
              `you are giving up ${pct(cost)} of win probability for being off it. That flatness is the useful ` +
              `half of the 37% rule — approximately right is nearly as good as exactly right, and ` +
              `${pct(st.invE)} is where both numbers land as the field grows.`,
          };
        }
        if (cost <= 0.05) {
          return {
            tone: "neutral",
            headline: `Close enough, but nudge toward skipping ${count(st.bestS)} — you are ${pct(cost)} off the peak.`,
            body:
              `Skipping ${count(pr.s)} of ${count(pr.n)} wins ${pct(st.winProb)} against ${pct(st.bestProb)} at the ` +
              `optimum of ${count(st.bestS)} (${pct(st.bestFraction)} of the field). A few points of skip either ` +
              `way barely matters here; that is the real content of the result, not the constant ${pct(st.invE)}.`,
          };
        }
        return {
          tone: "bad",
          headline: `This skip is costing you ${pct(cost)} of win probability — move it to about ${count(st.bestS)}.`,
          body:
            `Skipping ${count(pr.s)} of ${count(pr.n)} wins only ${pct(st.winProb)}, against ${pct(st.bestProb)} at ` +
            `the optimum of ${count(st.bestS)} (${pct(st.bestFraction)} of the field). The curve is flat near its ` +
            `peak but not out here: you are far enough down the shoulder that the error is real, and the fix is ` +
            `roughly "look at a third, then take the next one that beats them all."`,
        };
      },
      tiles: (pr, s) => [
        { label: "P(win) at your skip", value: pct(s.winProb),
          note: `skipping ${pr.s} of ${pr.n}` },
        { label: "Optimal skip", value: count(s.bestS),
          note: `${pct(s.bestFraction)} of the candidates` },
        { label: "Optimal P(win)", value: pct(s.bestProb), note: "exact" },
        { label: "1/e", value: pct(s.invE),
          note: "the n → ∞ limit of both numbers above" },
      ],
      // (pr, st) rather than the usual (pr, s) here: this scenario's own skip
      // count is called `s`, and pr.s vs stats.s in one expression is a trap.
      mathBox: (pr, st) => [
        "Skip the first \\(s\\) of \\(n\\), then take the first candidate better than every one seen. Exact:",
        `\\(P(\\text{win}\\mid s) = \\dfrac{s}{n}\\displaystyle\\sum_{i=s+1}^{n}\\dfrac{1}{i-1}\\)  =  ${pct(st.winProb)}  (at \\(s\\) = ${count(pr.s)}, \\(n\\) = ${count(pr.n)})`,
        `The \\(s=0\\) case is separate: with nothing to compare against you take candidate one, so \\(P = 1/n\\)  =  ${pct(1 / Math.max(1, pr.n))}`,
        `\\(s^{*} = \\arg\\max_{s} P(\\text{win}\\mid s)\\)  =  ${count(st.bestS)}, giving ${pct(st.bestProb)} — an argmax over the exact curve, not an approximation`,
        `Writing \\(x = s/n\\) and letting \\(n \\to \\infty\\), the sum becomes \\(P(x) = -x\\ln x\\), maximised at \\(x = 1/e\\) with \\(P = 1/e\\)  =  ${pct(st.invE)}`,
        "\\(-x\\ln x\\) is flat near its peak, which is why \"about a third\" "
        + "costs you almost nothing against the exact optimum — the useful "
        + "half of the result is the flatness, not the constant.",
      ],
      notation: {
        "\\(n\\)": "Total number of candidates",
        "\\(s\\)": "How many candidates you skip before you will accept anyone",
        "\\(s^{*}\\)": "The skip count that maximises the win probability",
        "\\(P(\\text{win}\\mid s)\\)": "Probability of ending up with the single best candidate",
        "\\(x\\)": "The skip as a fraction of the field, \\(s/n\\)",
        "\\(1/e\\)": "≈ 37%, the \\(n \\to \\infty\\) limit of both \\(x^{*}\\) and \\(P(\\text{win})\\)",
      },
      note:
        "Every point on the first chart is exact — a closed-form sum, not a " +
        "simulated average over shuffles. Two things are worth dragging the " +
        "sliders to see. First, the curve is flat on top: at n=100 the " +
        "optimum sits at skip=37, but skip=30 or skip=45 costs only a point " +
        "or two of win probability, which is the real, useful content of the " +
        "37% rule — approximately right is nearly as good as exactly right. " +
        "Second, the second chart shows the SAME optimal probability, " +
        "recomputed at every group size from 5 to 500, visibly settling onto " +
        "1/e as n grows — the rule of thumb is not an approximation bolted " +
        "on top of the maths, it is a limit the exact maths actually reaches.",
    },
    {
      id: "two-envelopes",
      status: "ready",
      why:
        "Reveals hidden assumptions about distributions and conditional " +
        "expectations.",
      name: "The two-envelope paradox",
      blurb:
        "Whatever you find in the envelope you opened, swapping looks worth " +
        "25% more. So does swapping back.",
      story:
        "Two envelopes; one holds twice what the other does. You pick one, " +
        "open it, and find $100. The other holds $50 or $200, equally likely, " +
        "so swapping is worth $125 — a clear gain. But the same argument " +
        "works for any amount you might have found, and it works before you " +
        "open anything at all, which means you should swap forever. Maurice " +
        "Kraitchik published the puzzle as a pair of neckties in 1943. " +
        "Locating the error took decades of argument, and it is the same " +
        "error that makes the coin game on the first tab look attractive.",
      controls: [
        { key: "rate", label: "How common is a large smaller-amount",
          min: 0.001, max: 0.05, step: 0.001, value: 0.01,
          fmt: (v) => `mean ${money(1 / v)}` },
        { key: "x", label: "Amount found in your envelope", min: 1, max: 1000,
          step: 1, value: 100, int: true, fmt: money },
      ],
      fixed: {},
      compute: (pr) => {
        const stats = EP.teSummary(pr);
        const [xs, gains, probs] = EP.teGainCurve(pr.rate, 200);
        return { stats, gainCurve: { xs, gains, probs } };
      },
      charts: ["te-gain", "te-prob"],
      // CONDITIONAL on pr.x against s.crossover = 4·ln2/rate. Swap below it,
      // keep above it -- the always-swap argument is wrong on one side of that
      // line and right on the other.
      verdict: (pr, s) => {
        if (s.shouldSwap) {
          return {
            tone: "good",
            headline: `Swap. ${money(pr.x)} is below the ${money(s.crossover)} crossover, so the other envelope is worth more.`,
            body:
              `Against a prior whose typical smaller amount is ${money(s.meanSmaller)}, finding ${money(pr.x)} is ` +
              `evidence you hold the smaller half — ${pct(s.pSmaller)} likely — and swapping gains ` +
              `${money(s.swapGain)} on average. Note this is not the "always swap" argument: it is true here and ` +
              `false above ${money(s.crossover)}.`,
          };
        }
        return {
          tone: "neutral",
          headline: `Keep it. ${money(pr.x)} is above the ${money(s.crossover)} crossover, and swapping loses money.`,
          body:
            `Only ${pct(s.pSmaller)} of the time is an amount this large the smaller half, against a prior whose ` +
            `typical smaller amount is ${money(s.meanSmaller)}, so swapping is worth ${money(s.swapGain)}. The ` +
            `classic 1.25x argument gets this backwards by insisting P is 1/2 at every amount, which no ` +
            `distribution on the positive reals can deliver.`,
        };
      },
      tiles: (pr, s) => [
        { label: "P(you hold the smaller half)", value: pct(s.pSmaller), note: "exact" },
        { label: "Expected gain from swapping", value: money(s.swapGain),
          note: s.shouldSwap ? "swap" : "keep" },
        { label: "Crossover amount", value: money(s.crossover),
          note: "swap below this, keep above it" },
        { label: "Typical smaller amount", value: money(s.meanSmaller),
          note: "the prior's mean" },
      ],
      mathBox: (pr, s) => [
        "Give the smaller amount a real prior: \\(S \\sim \\text{Exponential}(\\lambda)\\), so the envelopes hold \\(S\\) and \\(2S\\). You opened \\(x\\).",
        `\\(P(\\text{you hold } S \\mid x) = \\dfrac{1}{1 + \\tfrac{1}{2}e^{\\lambda x/2}}\\)  =  ${pct(s.pSmaller)}`,
        `\\(E[\\text{gain from swapping}\\mid x] = P\\cdot x - (1-P)\\cdot\\dfrac{x}{2}\\)  =  ${money(s.swapGain)}`,
        `That is positive exactly when \\(P > \\tfrac{1}{3}\\), i.e. when \\(x < \\dfrac{4\\ln 2}{\\lambda}\\)  =  ${money(s.crossover)}`,
        `\\(E[S] = 1/\\lambda\\)  =  ${money(s.meanSmaller)} — the scale that decides whether the \\(x\\) you found is small or large`,
        "The classic \\(1.25x\\) argument is what you get by forcing \\(P = \\tfrac{1}{2}\\) "
        + "at every \\(x\\). No probability distribution on the positive reals "
        + "can do that, which is where the paradox actually lives.",
      ],
      notation: {
        "\\(S\\)": "The smaller of the two amounts, drawn from the prior",
        "\\(2S\\)": "The larger amount — the envelopes hold \\(S\\) and \\(2S\\)",
        "\\(x\\)": "The amount you actually found in the envelope you opened",
        "\\(\\lambda\\)": "Rate of the exponential prior; larger \\(\\lambda\\) means large amounts are rarer",
        "\\(P\\)": "\\(P(x \\text{ is the smaller half} \\mid x)\\), the posterior after opening",
        "\\(1/\\lambda\\)": "Mean of the prior — the typical smaller amount",
        "\\(4\\ln 2/\\lambda\\)": "Crossover: swap below this amount, keep above it",
      },
      note:
        "Give the smaller amount a real prior — here, an exponential one, so " +
        "large amounts are rarer than small ones — and the always-swap " +
        "argument stops being the same argument at every x. Finding $10 is " +
        "strong evidence you are holding the smaller half (there is far more " +
        "prior mass just below $10 than the alternative requires above it), " +
        "so swapping is a good bet; finding $10,000 against a prior whose " +
        "typical value is $100 is strong evidence of the opposite, so " +
        "swapping is a bad one. The two effects exactly cancel if you " +
        "average over every amount you might have found, which is the " +
        "resolution: 'always swap' silently swaps the conditional question " +
        "(given what I see) for the unconditional one (before I look at " +
        "anything), and only a real prior makes the difference visible. The " +
        "classic puzzle avoids ever specifying one — try to write down a " +
        "uniform prior over all positive amounts and there is no such " +
        "probability distribution, which is where the paradox actually " +
        "lives.",
    },
    {
      id: "bertrand-paradox",
      status: "ready",
      why:
        "Shows that probability questions require a clearly specified " +
        "sampling process.",
      name: "Bertrand's paradox",
      blurb:
        "Three impeccable arguments give three different answers to the same " +
        "question, because “at random” was never actually defined.",
      story:
        "Draw a chord of a circle at random. How often is it longer than the " +
        "side of the inscribed equilateral triangle? Pick two random points " +
        "on the rim and the answer is one third. Pick a random radius and a " +
        "random point along it, one half. Pick a random point in the disc, " +
        "one quarter. All three are impeccable. Joseph Bertrand set this out " +
        "in 1889, and the argument over which answer is the right one is " +
        "still going: “at random” is not a specification, and a probability " +
        "question without a sampling rule has no answer.",
      controls: [
        { key: "method", type: "select", label: "What does “at random” mean?",
          value: "endpoints", options: [
            { value: "endpoints", label: "Two random endpoints on the rim" },
            { value: "radius", label: "Random point along a random radius" },
            { value: "midpoint", label: "Random midpoint in the disc" },
          ],
          fmt: (v) => String(v) },
        { key: "c", label: "Target length, as a fraction of the diameter",
          min: 0.05, max: 0.99, step: 0.01, value: 0.87,
          fmt: (v) => `${num(v, 2)} × diameter` },
        { key: "n", label: "Chords drawn", min: 50, max: 1500, step: 50,
          value: 300, int: true, fmt: count },
      ],
      fixed: { radius: 1 },
      compute: (pr) => {
        const stats = EP.bertrandSummary(pr);
        const [cs, e, r, m] = EP.bertrandCCurve(201);
        const lots = EP.bertrandSample(pr.method, pr.n, pr.radius, pr.c, pr.seed);
        const pExact = { endpoints: stats.pEndpoints, radius: stats.pRadius,
                         midpoint: stats.pMidpoint }[pr.method];
        const label = { endpoints: "Two random endpoints on the rim",
                        radius: "Random point along a random radius",
                        midpoint: "Random midpoint in the disc" }[pr.method];
        return {
          stats,
          curves: {
            cs, endpoints: e, radius: r, midpoint: m, cNow: pr.c,
            pNow: { endpoints: stats.pEndpoints, radius: stats.pRadius,
                    midpoint: stats.pMidpoint },
          },
          chords: {
            method: pr.method, label,
            x0: lots.map((d) => d.x1), y0: lots.map((d) => d.y1),
            x1: lots.map((d) => d.x2), y1: lots.map((d) => d.y2),
            mx: lots.map((d) => d.mx), my: lots.map((d) => d.my),
            long: lots.map((d) => d.long),
            cNow: pr.c,
            // Passed rather than re-derived in the chart: one definition of
            // the long/short locus, and the exact answer beside the sampled
            // one so the reader can tell sampling noise from the paradox.
            uThresh: stats.threshold,
            pExact,
          },
        };
      },
      charts: ["bertrand-curves", "bertrand-chords"],
      tiles: (pr, s) => [
        { label: "Two random endpoints", value: pct(s.pEndpoints),
          note: s.isClassic ? "exactly 1/3" : "exact" },
        { label: "Random point on a random radius", value: pct(s.pRadius),
          note: s.isClassic ? "exactly 1/2" : "exact" },
        { label: "Random midpoint in the disc", value: pct(s.pMidpoint),
          note: s.isClassic ? "exactly 1/4" : "exact" },
        { label: "Spread between the answers", value: pct(s.spread),
          note: "same question, same circle, three sampling rules" },
      ],
      mathBox: (pr, s) => [
        `A chord at distance \\(d\\) from the centre has length \\(2\\sqrt{R^2-d^2}\\), so it beats \\(L = c\\cdot 2R\\) exactly when \\(u = d/R < \\sqrt{1-c^2}\\) = ${num(s.threshold, 4)}.`,
        "Each rule is uniform in a different variable, so each gives \\(u\\) a different distribution — and the answer is just that distribution's CDF at the one threshold above.",
        `Endpoints, \\(u=|\\cos(\\theta/2)|\\): \\(P = 1 - \\frac{2}{\\pi}\\arcsin c\\) = ${pct(s.pEndpoints)}`,
        `Radius, \\(u\\sim U(0,1)\\): \\(P = \\sqrt{1-c^2}\\) = ${pct(s.pRadius)}`,
        `Midpoint, uniform by AREA so \\(P(u\\le t)=t^2\\): \\(P = 1-c^2\\) = ${pct(s.pMidpoint)}`,
        s.isClassic
          ? "At \\(c=\\sqrt3/2\\), the inscribed triangle's side, these are exactly 1/3, 1/2 and 1/4 — the classical statement."
          : `At \\(c=\\sqrt3/2\\) these become exactly 1/3, 1/2 and 1/4; you are at \\(c\\) = ${num(pr.c, 2)}.`,
        "All three are correct. None is the answer, because the question never said uniform in what.",
      ],
      notation: {
        "\\(R\\)": "The circle's radius",
        "\\(L\\)": "The target chord length",
        "\\(c\\)": "\\(L/2R\\) — the target as a fraction of the diameter",
        "\\(d\\)": "Distance from the centre to the chord's midpoint",
        "\\(u\\)": "\\(d/R\\), that distance rescaled to \\([0,1]\\)",
        "\\(\\theta\\)": "Central angle between a chord's two endpoints",
        "\\(P\\)": "Probability the chord is longer than \\(L\\)",
      },
      verdict: (pr, s) => {
        const shown = { endpoints: s.pEndpoints, radius: s.pRadius,
                        midpoint: s.pMidpoint }[pr.method];
        return {
          tone: "neutral",
          headline: "Specify the sampling rule before you ask for the probability — this question has three right answers.",
          body:
            (s.isClassic
              ? "At the classical threshold the three rules give exactly 1/3, 1/2 and 1/4. "
              : `At this threshold they give ${pct(s.pEndpoints)}, ${pct(s.pRadius)} and ` +
                `${pct(s.pMidpoint)} — a spread of ${pct(s.spread)}. `) +
            `You have picked one, and it answers ${pct(shown)}. No amount of ` +
            `extra care with the arithmetic narrows that spread, because the ` +
            `ambiguity is in the word “random”, not in the maths.`,
        };
      },
      note:
        "All three answers are exactly correct. They differ because they " +
        "answer three different questions, and the English sentence does not " +
        "distinguish them. Each rule is uniform in something — endpoints " +
        "uniform on the rim, midpoint uniform along a radius, midpoint " +
        "uniform over the disc — and there is no such thing as uniform over " +
        "chords without saying uniform in what. " +
        "The second chart makes it visible. Uniform endpoints crowd the " +
        "midpoints toward the rim; uniform-over-the-disc spreads them evenly " +
        "by area, putting more of them far from the centre; " +
        "uniform-along-a-radius spreads them evenly by distance. The dotted " +
        "circle is the " +
        "exact locus separating long chords from short ones, so each rule's " +
        "answer is simply the share of its midpoints inside that circle — " +
        "and the three clouds plainly put different shares there. " +
        "The ranking is not even fixed: the endpoint and midpoint rules " +
        "cross at c = 1/√2, where both give 1/2, so the textbook 1/3 > 1/4 " +
        "holds only because √3/2 sits above that crossing. " +
        "Jaynes argued in 1973 that invariance under translation and " +
        "scaling singles out the radius rule — a good argument for one " +
        "physical setup, not a proof that the bare question had an answer.",
    },
    {
      id: "optional-stopping",
      status: "ready",
      why:
        "Shows how ordinary-looking analysis flexibility manufactures false " +
        "positives.",
      name: "Optional stopping",
      blurb:
        "Test as you go, and stop when the result is significant. The false " +
        "positive rate goes wherever you like.",
      story:
        "Run an experiment. If the result isn't significant, collect a little " +
        "more data and test again. Repeat as needed. This sounds like " +
        "diligence; it is a machine for manufacturing false positives. Feller " +
        "warned about it in the 1940s, Peter Armitage showed in the 1960s " +
        "that repeated testing drives the error rate toward certainty, and in " +
        "2011 Simmons, Nelson and Simonsohn showed that ordinary research " +
        "flexibility can push a nominal 5% error rate past 60%. It is " +
        "gambler's ruin in a lab coat: a random walk, an absorbing barrier, " +
        "and a player who only stops when winning.",
      controls: [
        { key: "looks", label: "Number of looks", min: 1, max: 100, step: 1,
          value: 40, int: true, fmt: (v) => `${Math.round(v)}` },
        { key: "batch", label: "New observations per look", min: 5, max: 200,
          step: 5, value: 20, int: true, fmt: count },
        { key: "alpha", label: "Nominal significance level", min: 0.01,
          max: 0.2, step: 0.01, value: 0.05, fmt: pct },
      ],
      fixed: { nPaths: 8 },
      compute: (pr) => {
        const stats = EP.osSummary(pr);
        const [xs, ys] = EP.osFalsePositiveCurve(pr.looks, pr.batch, pr.alpha);
        const sim = EP.simulateOptionalStopping(pr);
        return { stats, fpCurve: { xs, ys }, sim };
      },
      charts: ["os-curve", "os-paths"],
      // CONDITIONAL on how far s.cumFp has run above s.nominalAlpha. At one
      // look there is no inflation at all; by a hundred looks the nominal
      // level is fiction.
      verdict: (pr, s) => {
        const inflation = s.cumFp / Math.max(1e-12, s.nominalAlpha);
        const looks = Math.round(pr.looks);
        const shared =
          `Across ${count(looks)} looks of ${count(pr.batch)} observations on data with no real effect, the ` +
          `chance of declaring significance at least once is ${pct(s.cumFp)}, against the ` +
          `${pct(s.nominalAlpha)} a single test promises.`;
        if (looks <= 1 || inflation < 1.1) {
          return {
            tone: "good",
            headline: "One look at a pre-set sample size: your error rate is the level you promised.",
            body:
              shared +
              ` Nothing is inflated because nothing was re-tested. Add looks and this stops being true fast — ` +
              `the cure is to fix the number of looks in advance and test each at the corrected ` +
              `${pct(s.bonferroniAlpha)}.`,
          };
        }
        if (inflation < 1.5) {
          return {
            tone: "neutral",
            headline: `Mild peeking, but correct for it: test each look at ${pct(s.bonferroniAlpha)}, not ${pct(s.nominalAlpha)}.`,
            body:
              shared +
              ` That is ${num(inflation)}× the nominal rate — small enough to look harmless and large enough to ` +
              `matter across a literature. Bonferroni is conservative but exact as a bound, and it is the ` +
              `cheapest honest fix.`,
          };
        }
        return {
          tone: "bad",
          headline: `Your real false-positive rate is ${pct(s.cumFp)}, not ${pct(s.nominalAlpha)} — pre-register the looks and test each at ${pct(s.bonferroniAlpha)}.`,
          body:
            shared +
            ` That is ${num(inflation)}× what you claimed. Stopping when the result turns significant ` +
            `manufactures findings: a driftless walk given enough free runs at a boundary eventually crosses ` +
            `it. Bonferroni at ${pct(s.bonferroniAlpha)} per look restores the nominal rate; O'Brien-Fleming ` +
            `and Pocock boundaries lose less power.`,
        };
      },
      tiles: (pr, s) => [
        { label: "Nominal alpha", value: pct(s.nominalAlpha),
          note: "the false-positive rate a single test promises" },
        { label: "Actual cumulative rate", value: pct(s.cumFp),
          note: `after ${pr.looks} looks` },
        { label: "Total sample size", value: count(s.totalN),
          note: `${pr.looks} looks of ${pr.batch}` },
        { label: "Bonferroni-corrected alpha", value: pct(s.bonferroniAlpha),
          note: "the per-look bar that restores the nominal rate" },
      ],
      mathBox: (pr, s) => [
        `A single look at \\(n_k = k\\,b\\) observations rejects when \\(|Z_k| \\ge z_{1-\\alpha/2}\\), with \\(\\alpha\\) = ${pct(s.nominalAlpha)} and \\(z_{1-\\alpha/2}\\)  =  ${num(s.zCrit, 3)}`,
        `\\(P(\\text{reject at some look})\\) after \\(k\\) = ${count(pr.looks)} looks  =  ${pct(s.cumFp)}`,
        "That one has no simple closed form. It is \\(1 - P\\big(|S_{n_k}| < z\\sqrt{n_k} "
        + "\\text{ for every } k\\big)\\), a probability over the walk's whole path, "
        + "which the page evaluates by an exact forward DP over the distribution "
        + "of \\(S_{n}\\) — exact, but computed, not written down.",
        `The tempting shortcut \\(1-(1-\\alpha)^{k}\\) = ${pct(1 - Math.pow(1 - pr.alpha, Math.round(pr.looks)))} would need the looks to be independent, and they are not: every look reuses all the earlier data, so it overstates the damage.`,
        `Bonferroni, exact as a bound: \\(\\alpha' = \\alpha/k\\)  =  ${pct(s.bonferroniAlpha)} per look`,
        "So the honest summary is: the nominal level is a closed form, the "
        + "correction is a closed form, and the thing between them — what "
        + "peeking actually costs you — has to be computed.",
      ],
      notation: {
        "\\(\\alpha\\)": "Nominal significance level promised by a single test",
        "\\(k\\)": "Number of looks (interim analyses) taken",
        "\\(b\\)": "New observations added per look",
        "\\(n_k\\)": "Total sample size at look \\(k\\), equal to \\(k\\,b\\)",
        "\\(S_n\\)": "The driftless random walk's position after \\(n\\) observations (no real effect)",
        "\\(Z_k\\)": "Test statistic at look \\(k\\), \\(S_{n_k}/\\sqrt{n_k}\\)",
        "\\(z_{1-\\alpha/2}\\)": "Two-sided critical value; the boundary sits at \\(\\pm z\\sqrt{n_k}\\)",
        "\\(\\alpha'\\)": "Bonferroni-corrected per-look level, \\(\\alpha/k\\)",
      },
      note:
        "This is gambler's ruin with the null hypothesis playing the " +
        "gambler: a driftless random walk (there is no real effect, so no " +
        "step is biased either way) against a boundary that moves outward " +
        "like the square root of the sample size. On the ruin tab a fixed " +
        "barrier is what a patient-enough fair walk eventually hits with " +
        "certainty; here the barrier retreats just fast enough that the " +
        "test remains well-calibrated FOR ONE LOOK, but re-testing after " +
        "every batch gives the walk another free run at a barrier it hasn't " +
        "crossed yet, and the false-positive rate climbs with every " +
        "additional look rather than staying flat at the nominal level. " +
        "The curve is exact — a forward dynamic-programming pass over the " +
        "walk's distribution, not a simulated approximation — so the gap " +
        "between the two tiles above is not sampling noise. The honest way " +
        "back out is on the tiles too: a Bonferroni correction (dividing the " +
        "per-look alpha by the number of looks planned) is conservative but " +
        "exact, and is the simplest member of the family of corrections " +
        "(O'Brien-Fleming and Pocock boundaries chief among them) that let " +
        "researchers look early and often without this bill coming due.",
    },
  ];

  /** Merge a scenario's fixed params with the live control values. */
  function resolveParams(scenario, values) {
    const pr = Object.assign({ seed: 7 }, scenario.fixed || {});
    for (const c of scenario.controls || []) {
      const v = values[c.key] !== undefined ? values[c.key] : c.value;
      // Round here rather than at the point of use: a slider step of 1 still
      // yields floats, and a fractional round count or player count silently
      // breaks any loop bound by it.
      pr[c.key] = c.int ? Math.round(v) : v;
    }
    if (scenario.derive) scenario.derive(pr);
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
    fmt: { money, pct, pctSigned, num, count },
  });
})(window.EP);
