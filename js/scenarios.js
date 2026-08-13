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
          walk: EP.pathStats(sim),
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
      status: "planned",
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
      note:
        "Will show the win rate for switching against staying as the number " +
        "of doors and the host's knowledge change — because the host's " +
        "knowledge is the entire mechanism. A host who opens a door at random " +
        "and happens to reveal a goat gives you nothing, while a host who is " +
        "guaranteed to reveal a goat has transferred the whole of the losing " +
        "door's probability onto the one you didn't pick. Same visible " +
        "outcome, different information, different answer.",
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
      status: "planned",
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
      note:
        "Will compare buy-and-hold against periodic rebalancing on the same " +
        "seeded price path, sweeping the rebalancing interval to show that the " +
        "harvest has an optimum rather than increasing forever. The honest " +
        "part of the story belongs here too: the effect needs mean-reverting " +
        "or trendless prices and zero costs, and it reverses on a trending " +
        "asset, which is where most retellings of this result stop early.",
    },
    {
      id: "insurance",
      status: "planned",
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
      note:
        "Will show the growth rate of an insured and an uninsured player " +
        "against the premium, with the range of premiums where both the buyer " +
        "and the seller improve their long-run growth — a band that expected " +
        "value alone cannot produce. Then the pooling version: identical " +
        "players sharing identical independent risks, where every one of them " +
        "ends up better off and nobody has taken the other side.",
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

  Object.assign(EP, {
    SCENARIOS, byId, resolveParams, defaultValues,
    fmt: { money, pct, pctSigned, num, count },
  });
})(window.EP);
