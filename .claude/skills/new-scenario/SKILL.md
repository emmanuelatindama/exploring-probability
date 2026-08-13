---
name: new-scenario
description: Add a new probability/game-theory scenario to the Exploring Probability site — closed-form analytics in the Python lab, golden values, a registry entry, and the chart forms. Use when asked to add, build out, or implement a scenario (gambler's ruin, St. Petersburg, iterated prisoner's dilemma, or a new one), or to promote a `status: "planned"` entry to a working one.
---

# Adding a scenario

Scenarios are the unit of growth for this project. The registry already declares
several with `status: "planned"`; promoting one to `ready` is the common case.

Read `CLAUDE.md` first — the "Rules that are easy to get wrong" section exists
because each of those was a real bug.

## The order matters

Derive before you simulate. A simulation agrees with whatever you coded, so it
cannot tell you the formula is wrong; a closed form checked against a simulation
can.

### 1. Derive the closed forms in `lab/analytics.py`

Add functions for whatever the scenario can state exactly. Aim for:

- the exact expectation (the "looks attractive" number)
- the exact median or typical outcome (the "what actually happens" number)
- tail probabilities — ruin, below-start, below some threshold
- any optimum the scenario has (a bet size, a threshold, a strategy mix)

Prefer exact discrete methods over normal approximations. For the multiplicative
game, wealth is monotone in the win count, so quantiles come from the binomial
quantile rather than a log-normal fit — see `median_final`. If a quantity has no
closed form, say so in the docstring and simulate it, but do not quietly swap a
simulation in where a formula is expected.

### 2. Check the derivation in `lab/verify.py`

Add a case to `verify_closed_forms()` comparing each formula against a large
Monte Carlo run, plus a brute-force check for any optimum (see `verify_kelly`).

Two traps, both of which have bitten here:

- **Use absolute tolerance for probabilities.** A relative bar on a probability
  of 1e-9 just measures floating-point noise. `check(..., rel=True)` is opt-in
  for exactly this reason.
- **Do not check a heavy-tailed mean against a sample mean.** It will not
  converge, at any sample size. Check the mean against an algebraic identity and
  let the simulation check the median and the tails.

Then add the scenario to `GOLDEN_CASES` and run:

```bash
conda activate web-dev && python lab/verify.py
```

This must print `all checks pass` and rewrite `js/golden.js`.

### 3. Mirror the formulas in `js/engine.js`

Same names, same arguments, same results. If the scenario needs new dynamics
(an absorbing barrier, additive bets, multiple agents), add a simulate function
beside `simulatePaths` rather than overloading it with flags.

Verify by opening `tests.html`, or headless:

```bash
PROF=$(mktemp -d)
google-chrome --headless=new --disable-gpu --no-sandbox --no-first-run \
  --disable-crash-reporter --user-data-dir="$PROF" --virtual-time-budget=8000 \
  --dump-dom "file://$PWD/tests.html" | grep -o 'id="summary"[^>]*>[^<]*'
```

The sandbox must be disabled for Chrome — it needs `socket()` and a writable
profile directory.

### 4. Add the registry entry in `js/scenarios.js`

Replace the `planned` stub with a full entry: `controls`, `fixed`, `compute`,
`charts`, `tiles`, `note`, plus `derive` if any parameter is computed from
another. Nothing outside this file knows the scenario list.

- **Keep the `story`.** A planned stub already has one, and it carries over
  unchanged — it is the reader's way in, and it is the same 100 words whether or
  not the charts exist yet.
- **`compute(params)` is the scenario's only call into the engine.** It returns
  `{ stats, ...chart data }`; the chart forms read that by name. If a chart needs
  something new, compute it there rather than reaching for the engine from
  `charts.js`.

- **Tiles carry the punchline.** Put the two numbers that disagree side by side.
- **Label exactness.** If a tile is closed-form, its note should say so, because
  a chart's empirical version of the same quantity will differ.
- **The note explains the mechanism**, not just the result.

### 4b. The origin story

Every entry carries a `story`, rendered above the controls, and it has a house
style worth matching:

- **Open with the hook, not the history.** A question the reader will get wrong,
  or an offer that sounds good: *"Does a coin that pays +50% on heads and −40% on
  tails sound like a good deal?"* The date and the names come second.
- **Then the real provenance** — who posed it, when, and what they were actually
  working on. These are checkable claims, so keep them checkable and do not
  invent precision. "Around ten thousand readers" is right; a specific figure
  presented as exact is not.
- **Land on what it costs to misread it.** The story ends where the lesson
  starts.
- **100 words, hard limit.** Roughly 85–95 is the working range. It is one
  paragraph in a card, not an essay.

### 5. Chart forms

Reuse `trajectory`, `histogram` and `sweep` where they fit. If the scenario needs
a new form, pick it by the data's job (see the `dataviz` skill) before picking
colour, and add it to `charts.js` reading colour from the CSS custom properties —
never a literal hex.

Existing forms and what they are for: `trajectory` and `histogram` (log-scale
wealth), `sweep` (a closed-form curve over one parameter with a meaningful zero,
drawn in the diverging pair), `ruin-paths` (a linear-axis walk between reference
lines), `ruin-curve` / `ruin-bet` (a probability against a parameter, with the
reader's own position marked), `sp-mean` (the emphasis form: a cloud of runs with
one highlighted), `sp-octaves` (a decomposition into per-outcome bars),
`pd-scores` (ranked horizontal bars), `pd-matrix` (single-hue sequential heatmap
with a label in every cell), `pd-shares` (stacked area, fixed slot order).

Guidance for the scenarios still marked `planned`:

- **Monty Hall** — the whole mechanism is the host's knowledge, so the comparison
  that matters is a knowing host against a random one. Two lines, not one.
- **Parrondo's paradox** — three capital curves on one axis (A, B, and the
  alternation). Nothing new is needed beyond a linear-axis line chart.
- **Shannon's demon** — buy-and-hold against rebalancing on the *same* seeded
  price path, plus a sweep over the rebalancing interval. Say out loud that the
  effect needs trendless prices and zero costs, and reverses on a trend.
- **Insurance and risk pooling** — the deliverable is the band of premiums where
  *both* sides improve their growth rate, which is the thing expected value
  cannot produce. That band is a shaded region between two closed-form curves.
- **Base rates** — draw the same situation twice, as probabilities and as a grid
  of a thousand people. The second framing is the intervention; demonstrate it
  rather than asserting it.
- **The birthday problem** — collision probability and the pair count belong on
  the same chart, because the quadratic pair growth is the explanation.
- **The secretary problem** — sweep the threshold; the flat optimum at 1/e is the
  point, and so is how little a wrong threshold costs.
- **The two-envelope paradox** — needs a real prior to be dissolved. Plot the
  expected gain from swapping against what you found: positive low, negative
  high, zero on average.
- **Optional stopping** — this is the ruin picture again, with the p-value as the
  walk and 0.05 as the barrier. Reuse `ruin-paths` if it fits rather than adding
  a form, and end on the corrections, not on despair.

### 6. Check it renders

Screenshot both modes and look at the result — the palette validator checks
colour, not layout, and every layout bug in this project so far was found by
looking:

```bash
google-chrome --headless=new --disable-gpu --no-sandbox --window-size=1200,2500 \
  --virtual-time-budget=20000 --screenshot=/tmp/check.png "file://$PWD/index.html"
```

Confirm: no clipped or colliding labels, no axis band cut off, log axes labelled
in plain dollars, legend present with the right key shape, table view populated.

## Checklist

- [ ] Closed forms in `lab/analytics.py`, with docstrings saying what is exact
- [ ] `lab/verify.py` case added; `python lab/verify.py` passes
- [ ] `js/golden.js` regenerated (do not hand-edit it)
- [ ] `js/engine.js` mirrors the formulas; `tests.html` all green
- [ ] Registry entry replaces the `planned` stub, `compute()` is its only engine call
- [ ] `story` present, hook first, under 100 words, claims checkable
- [ ] Charts read colour from CSS variables only
- [ ] Legend + table view present for every chart
- [ ] Screenshotted in light and dark, and actually looked at
- [ ] `CLAUDE.md` updated if a new sharp edge was found
