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
      note:
        "This game is additive: every round moves you one bet up or one bet " +
        "down, so wealth is a random walk rather than a product, and the axis " +
        "here is linear rather than logarithmic. Ruin is not caused by the " +
        "geometry of the returns — it is caused by the barrier. A walk that " +
        "wanders far enough will touch $0, and $0 is absorbing: there is no " +
        "coming back from it, which is what breaks the symmetry between winning " +
        "and losing streaks. " +
        "Two things are worth playing with. First, set the coin exactly fair " +
        "(50%) and remove the target: ruin becomes certain, not likely. A fair " +
        "game is only fair to a player with infinite money, and the house is " +
        "always the one closer to infinite. Second, watch the last chart while " +
        "you drag the win probability across 50%. Below it, raising your bet " +
        "size lowers your chance of ruin — with the edge against you, every " +
        "extra round is another chance for it to bite, so the way to survive a " +
        "bad game is to play as few rounds as possible. Above 50% the curve " +
        "flips and patience becomes the right answer. This is the exact " +
        "opposite of the Kelly lesson next door, because the barrier here is a " +
        "fixed number of dollars rather than a fraction of what you hold.",
    },
    {
      id: "st-petersburg",
      status: "ready",
      name: "St Petersburg paradox",
      blurb:
        "A wager with infinite expected value that nobody will pay $20 for. " +
        "Half of all games pay exactly $1.",
      story:
        "A casino offers you this: a coin is tossed until it comes up tails, " +
        "and the pot doubles every time it doesn't. The expected payout is " +
        "infinite. What would you pay to play? Nicolaus Bernoulli posed the " +
        "question in 1713. Nobody would offer more than a few coins, and " +
        "nobody could explain why they were right to refuse. His cousin " +
        "Daniel published an answer from the St Petersburg Academy in 1738 " +
        "and invented, on the way, the idea that money's worth is not its " +
        "amount. The infinity is real. It lives entirely in outcomes you will " +
        "never see.",
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
      note:
        "The second chart is the paradox drawn directly. Each bar is one " +
        "outcome's contribution to the expected value: what it pays, times how " +
        "often it happens. For the classic game those two factors cancel " +
        "exactly — every further toss doubles the prize and halves the odds — " +
        "so every bar is worth the same $0.50 and the sum runs off to infinity " +
        "by never getting smaller. Nothing is wrong with the arithmetic. The " +
        "expectation simply is not a number you can win. " +
        "Two dials dissolve it. Drag the multiplier below 2 (or the continue " +
        "probability below 50%) so that m·p < 1: the bars start shrinking, the " +
        "series converges, and the expected payout becomes an ordinary finite " +
        "amount. Or leave the game alone and cap what the house can pay — a " +
        "house good for a billion dollars makes an infinitely valuable ticket " +
        "worth about $16, because the whole of the infinity was sitting in " +
        "payouts no counterparty on earth could honour. " +
        "The first chart shows what this feels like from the inside: the " +
        "running average drifts down for thousands of games, jumps when a deep " +
        "run finally lands, then drifts down again. It is not converging " +
        "slowly. It is not converging.",
    },
    {
      id: "prisoners-dilemma",
      status: "ready",
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
      note:
        "Every number here is exact, not simulated. Each strategy needs at " +
        "most two bits of history — what you did last round, and whether you " +
        "have ever defected — so a pair's joint state is one of sixteen and " +
        "the expected score is a short forward pass rather than a Monte Carlo " +
        "run. That holds even with a random player and a trembling hand. " +
        "The result that made Axelrod's tournament famous is in the first two " +
        "charts together. Always-defect cannot be beaten in a single match: " +
        "read down its column and no strategy scores more against it than it " +
        "scores back. It still loses the tournament, because a match is not " +
        "the unit that matters — the total is. Defection wins every " +
        "confrontation and collects 1 point a round doing it, while the " +
        "cooperators quietly bank 3 points a round off each other. " +
        "Then push the noise slider up. Tit for tat and grim trigger both " +
        "punish defection, but grim never forgives, so a single mistaken move " +
        "condemns two grim players to defect at each other for the rest of " +
        "time. Tit for tat retaliates once and moves on. Forgiveness is not " +
        "sentiment here; it is error correction, and you can watch the " +
        "generations chart change hands as the noise rises.",
    },
    {
      id: "monty-hall",
      status: "ready",
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
      tiles: (pr, s) => [
        { label: "Switching wins", value: pct(s.switchProb),
          note: "exact, conditional on only goats having been revealed" },
        { label: "Staying wins", value: pct(s.stayProb), note: "exact" },
        { label: "Switching is better by", value: pctSigned(s.advantage),
          note: `${num(s.ratio, 2)}× as likely to win` },
        { label: "If the host opened at random", value: pct(s.switchRandom),
          note: "no advantage to switching at all" },
      ],
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
      status: "planned",
      name: "Parrondo's paradox",
      blurb:
        "Two games that each lose money. Alternate between them and you win.",
      story:
        "Two games. Play either one on its own, long enough, and you go " +
        "broke. Alternate between them and you get rich. This is not an " +
        "accounting trick: Juan Parrondo, a physicist in Madrid, built it in " +
        "1996 out of Feynman's ratchet — the observation that random jiggling " +
        "can be rectified into directed motion if the rules change at the " +
        "right moments. One game's losses reset the odds of the other. The " +
        "conclusion is uncomfortable for anyone who evaluates options one at " +
        "a time: “losing” is not a property a game carries around by itself.",
      note:
        "Will run game A (a slightly biased coin) and game B (whose odds " +
        "depend on your capital modulo 3) separately and in alternation, " +
        "showing all three capital curves on one axis. The mechanism to draw " +
        "out is that B's good branch is reachable only when A keeps nudging " +
        "your capital off the bad residue — the two games are coupled through " +
        "the state, which is precisely what an expected value computed per " +
        "game throws away.",
    },
    {
      id: "shannon-demon",
      status: "ready",
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
      note:
        "The stock alone has zero time-average growth here by construction — " +
        "up and down are reciprocals, so a coin that is heads half the time " +
        "multiplies wealth by up and by 1/up equally often, and those cancel " +
        "exactly in log space. A 50/50 mix rebalanced every period does not " +
        "cancel: every round it locks in some of a rise as cash before the " +
        "next round can give it back, and buys back in cheap after a fall. " +
        "That asymmetry is the harvest, and the second chart shows it has a " +
        "shape rather than a direction — free at zero cost, where rebalancing " +
        "as often as possible is always best, but pushed to an interior " +
        "optimum the moment trading costs money, because every rebalance past " +
        "that point spends more in turnover than it recovers in variance. " +
        "Two honest caveats belong here. First, this needs a trendless or " +
        "mean-reverting stock — set P(up) away from 50% and rebalancing can " +
        "cost you money instead, because you would be selling the winner just " +
        "as it starts to run. Second, the weight that harvests the most here " +
        "is exactly the Kelly fraction for this coin, which is 1/2 only " +
        "because the coin is symmetric: Shannon's 50/50 split is not a magic " +
        "number, it is Kelly sizing wearing a different name.",
    },
    {
      id: "insurance",
      status: "ready",
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
      note:
        "Expected value says a fair premium is pi × L, and that a rational " +
        "insurer must charge more than that to survive — so on that measure " +
        "insurance can only ever be a transfer, never a mutual gain. The band " +
        "on the first chart is the rebuttal: because ln is concave, the same " +
        "dollar of variance costs the small buyer more than it costs the " +
        "large seller, so a premium well above pi × L can still leave the " +
        "buyer better off, and a seller who could never accept exactly pi × L " +
        "(that premium leaves their own growth rate negative, the mirror of " +
        "the buyer's problem) can profitably accept anything above their own " +
        "minimum. Whatever premium you dial in, if it lands inside the shaded " +
        "band, both curves are positive — both parties have improved their " +
        "long-run growth rate, and nobody had to be wrong about anything. " +
        "The second chart drops the seller entirely: a mutual pool of equals, " +
        "each carrying an equal share of however many losses land among them. " +
        "Even a pool of two beats going it alone, and the curve climbs toward " +
        "the dashed line — the same growth rate an infinitely large insurer " +
        "could offer at cost — without any counterparty ever taking the other " +
        "side of the bet.",
    },
    {
      id: "the-wheel",
      status: "ready",
      name: "The wheel strategy",
      blurb:
        "Sell puts below the dips, sell calls above the highs, and let " +
        "assignment do the buying — compared against the stock alone and " +
        "against doing nothing at all.",
      story:
        "Sell a put below a recent dip and you are paid twice: keep the " +
        "premium if the stock recovers, or buy it at a discount if it " +
        "doesn't. Take the shares, keep them, and sell a call at every new " +
        "high — paid again, either way. Traders call this cycle “the " +
        "wheel,” and it looks like manufacturing income from nothing. " +
        "Selling puts and calls this way is decades old; running them as " +
        "one repeating cycle is newer, popularised on trading forums in " +
        "the 2010s. None of it beats holding the stock unless the premium " +
        "pays more than the stock's risk is worth. Pick a real index or " +
        "stock below to run it on what actually happened since 2009.",
      controls: [
        { key: "underlying", type: "select", label: "What are you trading?",
          value: "simulated", options: marketOptions(),
          fmt: (v) => v === "simulated" ? "Simulated stock" : (marketEntry(v) || {}).name || v },
        { key: "w0", label: "Starting capital", min: 20000, max: 300000,
          step: 5000, value: 100000, int: true, fmt: money },
        { key: "mu", label: "Stock's real-world drift (simulated only)", min: 0,
          max: 0.15, step: 0.01, value: 0.08, fmt: pct },
        { key: "sigmaRv", label: "Realized volatility (simulated only)",
          min: 0.10, max: 0.45, step: 0.01, value: 0.20, fmt: pct },
        { key: "sigmaIv", label: "Implied volatility (what you sell options at)",
          min: 0.10, max: 0.45, step: 0.01, value: 0.24, fmt: pct },
        { key: "dipPct", label: "Dip trigger, below the rolling high", min: 0.01,
          max: 0.15, step: 0.01, value: 0.05, fmt: pct },
        { key: "years", label: "Horizon (simulated only — real data runs its full history)",
          min: 1, max: 18, step: 1, value: 5, int: true,
          fmt: (v) => `${Math.round(v)} yr` },
      ],
      // The rules of the wheel itself -- tenors, the sale haircut, the
      // take-profit threshold -- are the definition of this strategy, not a
      // dial for exploring it, the same way the ergodic coin fixes f=1 and
      // leaves f as Kelly's own dial instead. s0 is fixed because only its
      // ratio to w0 (how many contracts one lot buys) matters, and w0 alone
      // already exposes that. There is deliberately no stop-loss on the put:
      // see the note, and lab/analytics.py:simulate_wheel.
      fixed: { s0: 100, r: 0.03, q: 0, xMonths: 6, yMonths: 3, sellHaircut: 0.10,
               callTp: 0.70, stockFeePct: 0.005, optFee: 0.65 },
      // A real ticker replaces the simulated GBM path outright: its daily
      // closes (already split/dividend-adjusted by fetch_market_data.py) are
      // rebased to start at s0 so the wheel's 100-shares-per-contract sizing
      // behaves the same regardless of the security's real price level or
      // currency, and the horizon is pinned to however much history that
      // series actually has -- mu and years stop doing anything, since there
      // is now exactly one path and it is not simulated from either of them.
      derive: (pr) => {
        if (pr.underlying === "simulated") { delete pr.realPath; return; }
        const entry = marketEntry(pr.underlying);
        if (!entry) { pr.underlying = "simulated"; delete pr.realPath; return; }
        const scale = pr.s0 / entry.prices[0];
        const path = new Float64Array(entry.prices.length);
        for (let i = 0; i < entry.prices.length; i++) path[i] = entry.prices[i] * scale;
        pr.realPath = path;
        pr.years = (path.length - 1) / 252;
        pr.underlyingMeta = entry;
      },
      compute: (pr) => {
        const fam = EP.simulateWheelFamily(pr);
        const w = EP.wheelSummary(pr);
        // A real path is the same on every seed -- it is not simulated --
        // so sweeping seeds there would just repeat one number nSeeds times.
        const nSeeds = pr.realPath ? 1 : 8;
        const sweep = EP.wheelIvSweep(Object.assign({}, pr, {
          points: 10, nSeeds, spreadLo: -0.10, spreadHi: 0.20, baseSeed: 1000,
        }));
        if (pr.realPath) {
          // holdSummary's closed form assumes GBM with the mu/sigmaRv
          // sliders, which real data does not obey -- with one actual path
          // and no ensemble, "exact" and "this one path" are the same number.
          w.holdCagrExact = w.holdCagrSample;
          w.holdFinalExact = w.holdFinalSample;
          w.holdMedianExact = w.holdFinalSample;
        }
        return {
          stats: Object.assign({
            cagrs: { wheel: w.wheelCagr, putsOnly: w.putsOnlyCagr,
                     dip: w.dipCagr, hold: w.holdCagrSample },
          }, w),
          fam, sweep,
        };
      },
      charts: ["wheel-paths", "wheel-bars", "wheel-sweep"],
      tiles: (pr, s) => [
        { label: "The wheel's growth rate", value: pctSigned(s.wheelCagr),
          note: pr.realPath
            ? `${pr.underlyingMeta.name}, ${pr.underlyingMeta.startDate.slice(0, 4)}–${pr.underlyingMeta.endDate.slice(0, 4)}`
            : "this one seeded path" },
        { label: "Buy-and-hold's growth rate", value: pctSigned(s.holdCagrExact),
          note: pr.realPath ? "what actually happened, this one history"
                             : "exact, over every possible path" },
        { label: "A single put's real-world odds of assignment",
          value: pct(s.putNaiveAssignProb),
          note: "exact — one put held to expiry, from the drift/vol sliders" },
        { label: "This simulation's actual assignment rate",
          value: pct(s.simAssignRate),
          note: `of ${count(s.putsSold)} puts sold — the gap is entry timing` },
      ],
      note:
        "Two rules here follow from the word acquisition, and both are " +
        "worth stating because the obvious alternative is a trap. First, " +
        "the puts carry no stop-loss. A put going into the money is the " +
        "strategy working, not a loss to cut — and a stop defined on the " +
        "put's own marked value is self-defeating in the most literal way, " +
        "because any path that ends in assignment must first push the put " +
        "deep enough in to trip the stop. An earlier version of this page " +
        "carried a -30% stop and, run over the S&P's 2009-2026 history, " +
        "sold 161 puts and took delivery exactly zero times: an " +
        "acquisition strategy that structurally could not acquire, sitting " +
        "in cash for seventeen years while the thing it meant to buy went " +
        "up eightfold. A risk control defined on the wrong variable can " +
        "quietly delete the strategy it is meant to protect. Second, the " +
        "shares are never sold — a call finishing in the money is bought " +
        "back at intrinsic rather than delivered, so exposure only " +
        "ratchets up and the comparison against buy-and-hold stays a " +
        "comparison of the same holding. " +
        "That is what the first two tiles are for. With no stop in the " +
        "way, the simulation's assignment rate lands close to the exact " +
        "formula's, and the remaining gap is pure entry timing: the wheel " +
        "only writes after price crosses the dip line, which the formula " +
        "does not know about. " +
        "The bars are one path's race, not a law: rerun it and any of the " +
        "four can win. The sweep is the number that generalises. It " +
        "answers the only question that actually decides whether selling " +
        "options for a living works — not the win rate on any one trade, " +
        "but whether the implied volatility you are paid exceeds the " +
        "realized volatility the stock actually delivers by more than the " +
        "haircut and the fees cost. Below that line the wheel is not a " +
        "source of yield; it is a more expensive way to hold the stock. " +
        "Picking a real index or stock swaps the simulated path for what " +
        "that security's daily closes actually did since 2009 (split- and " +
        "dividend-adjusted); the drift and volatility sliders then stop " +
        "drawing the path and only feed the formula-based tiles, and the " +
        "horizon locks to that security's own history. Every real series " +
        "is rebased to start at the same price so the contract math " +
        "behaves the same regardless of the ticker's real level or " +
        "currency — the wheel neither knows nor cares that it is trading a " +
        "rescaled Nikkei instead of a $100 stock.",
    },
    {
      id: "base-rates",
      status: "planned",
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
      note:
        "Will show how the probability of actually being ill given a positive " +
        "result moves with prevalence, sensitivity and specificity, with the " +
        "same situation drawn twice: once as probabilities and once as a grid " +
        "of a thousand people. The second form is the intervention that " +
        "works, and the chart should demonstrate that rather than assert it.",
    },
    {
      id: "birthday",
      status: "planned",
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
      note:
        "Will plot collision probability against group size, alongside the " +
        "count of pairs, so the quadratic growth in comparisons sits next to " +
        "the curve it explains. Extending the same axis to hash collisions " +
        "gives the security version for free: doubling the digest length " +
        "squares the work rather than doubling it.",
    },
    {
      id: "secretary",
      status: "planned",
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
      note:
        "Will sweep the look-then-leap threshold against the probability of " +
        "landing the best candidate, showing the flat optimum at 1/e and how " +
        "little the answer costs when the threshold is wrong. Then the more " +
        "useful variant: if you are willing to settle for a good candidate " +
        "rather than the single best, the optimal stopping point moves " +
        "earlier and the payoff gets much less fragile.",
    },
    {
      id: "two-envelopes",
      status: "planned",
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
      note:
        "Will let you choose an actual prior over the smaller amount and then " +
        "show the expected gain from swapping as a function of what you " +
        "found — which is positive for small amounts, negative for large " +
        "ones, and zero on average. The paradox needs a uniform prior over an " +
        "unbounded range to survive, and that is not a probability " +
        "distribution.",
    },
    {
      id: "optional-stopping",
      status: "planned",
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
      note:
        "Will run a null effect and test repeatedly as the sample grows, " +
        "plotting the accumulating false-positive rate against the number of " +
        "looks — the same absorbing-barrier picture as the gambler's ruin " +
        "tab, with the p-value as the walk and 0.05 as the barrier. Then the " +
        "corrections that make sequential testing legitimate, so the tab ends " +
        "somewhere other than despair.",
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

  const marketEntry = (symbol) =>
    (window.EP_MARKET || []).find((e) => e.symbol === symbol);

  /** "Simulated stock" plus every real series lab/fetch_market_data.py baked
   *  into js/market_data.js -- load order in index.html puts that file before
   *  this one, so window.EP_MARKET already exists by the time this runs. */
  function marketOptions() {
    const opts = [{ value: "simulated", label: "Simulated stock (Monte Carlo)" }];
    for (const e of (window.EP_MARKET || [])) {
      opts.push({ value: e.symbol, label: `${e.name} (${e.kind === "index" ? "Index" : e.category})` });
    }
    return opts;
  }

  Object.assign(EP, {
    SCENARIOS, byId, resolveParams, defaultValues,
    fmt: { money, pct, pctSigned, num, count },
  });
})(window.EP);
