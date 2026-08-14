# Exploring Probability

Interactive visualisations of multiplicative betting games, deployed as a static
site on GitHub Pages. The recurring theme: the average outcome and the typical
outcome disagree, and the gap between them is the lesson.

## Environment

Use the **`web-dev` conda environment** for anything Python:

```bash
conda activate web-dev            # python 3.13, numpy, scipy, pandas, matplotlib
python lab/verify.py              # verify analytics + regenerate js/golden.js
python lab/validate_palette.py "#hex,#hex" --mode light --pairs all
```

There is **no `node`, no `npm`, and no `plotly` for Python** on this machine.
That is a deliberate constraint, not an oversight:

- Plotly comes from a **pinned CDN script tag**, so there is no build step and
  nothing to install.
- The dataviz skill's `validate_palette.js` cannot run, so it is ported to
  `lab/validate_palette.py`. Keep the two in lockstep if either changes.
- JS is verified by opening `tests.html` in a browser, not from a CLI runner.
  Headless Chrome works for this (`google-chrome --headless=new --dump-dom`),
  but needs the sandbox disabled — it calls `socket()` and writes a profile dir.

## Architecture

**Python derives, JS ships.** This is the load-bearing invariant.

| Path | Role |
|---|---|
| `lab/analytics.py` | **Source of truth.** Seven numbered sections: the multiplicative coin, gambler's ruin, St Petersburg, the prisoner's dilemma, Monty Hall, Shannon's demon, insurance and risk pooling. |
| `lab/verify.py` | Checks the closed forms against Monte Carlo, then writes `js/golden.js`. |
| `js/engine.js` | Simulation + the same closed forms, mirroring `analytics.py` section for section. |
| `js/scenarios.js` | The scenario registry. Adding a scenario touches only this file plus a chart if it needs a new form. |
| `js/charts.js` | Plotly wrappers. Reads all colour from CSS custom properties. |
| `js/app.js` | Page wiring: the `CHART_KINDS` registry, controls, tiles, legends, table views, theme. |
| `tests.html` | Runs `engine.js` against `js/golden.js` in the browser. |

If you change a formula in `engine.js`, change it in `analytics.py` and re-run
`python lab/verify.py`. A formula that exists in only one of the two is a bug.

A scenario entry owns its own data: `compute(params)` is the only place that
calls the engine, and it returns `{ stats, ...chart data }`. Chart forms read
that object by name, so no chart knows which scenario it is drawing and `app.js`
never grows a per-scenario branch. `derive(params)` exists for parameters
computed from other parameters (the ruin target is a multiple of the bankroll,
so it can never be set below it), and `int: true` on a control rounds it once at
the source rather than at every use.

## Rules that are easy to get wrong

**Plotly's log-axis units are inconsistent.** `range`, `shapes` and
`annotations` take log10 units; **`tickvals` takes data units**. Passing log10
values as tickvals silently drops the non-positive entries and misplaces the
rest — this shipped once and looked like a layout glitch. `decadeTicks(lo, hi,
logAxis)` in `charts.js` handles both conventions; use it rather than hand-rolling
ticks.

**Never use Plotly's SI tick format for money.** `",.3~s"` renders $0.10 as
`$100m` (milli), which reads as "$100 million". Always explicit dollar labels.

**Wealth axes are log scale, always.** Terminal wealth spans tens of orders of
magnitude; on a linear axis one lucky path flattens everything else onto the
floor. Values are clamped at `FLOOR = $0.01` for display.

**Do not draw hundreds of trajectories.** Every round multiplies wealth by one of
two constants, so in log space the paths sit on a binomial lattice and overplot
into a diamond moire. Use quantile bands for "where is everybody" plus ~8
individual paths for "what does one player experience".

**Distinguish the exact mean from the sample mean.** Stat tiles show closed-form
values; the mean line on a trajectory chart is the average of the simulated
players. For a heavy-tailed variable these differ enormously (\~$13,150 vs
\~$788 at the default settings) and that is a feature worth explaining, not an
inconsistency to paper over.

**The PRNG is a shared contract.** `mulberry32` is implemented in both
`analytics.py` and `engine.js` so a given (seed, params) yields identical paths.
`tests.html` asserts bit-for-bit equality. Do not "improve" one side alone. The
contract covers *draw order*, not just the generator: `simulate_ruin` draws
nothing once a walk is absorbed, so an engine that keeps drawing past the barrier
diverges from round one even though its logic looks right.

**`window.EP` is one namespace shared by the engine and the charts**, and
`charts.js` loads *after* `engine.js`. A chart form named after the engine
function that feeds it silently replaces that function, and the failure surfaces
much later as "this is not a function" or, worse, as a chart quietly drawing the
wrong thing. Chart forms are therefore named distinctly from their data
functions: `ruinOdds` draws what `ruinCurve` computes, `pdHeatmap` draws what
`pdMatrix` computes.

**Python's `round()` is banker's rounding; JavaScript's `Math.round` is not.**
`round(2.5)` is 2 in Python and 3 in JS. `bets()` converts dollars to whole bets
and lands on exact `.5` ties for ordinary inputs (a $100 bankroll at a $40 bet),
so it uses `floor(x + 0.5)` on the Python side to match. Any new dollars-to-units
conversion needs the same treatment.

**Do not sweep a parameter that gets rounded twice.** The bet-size sweep started
out mapping dollars to a board by rounding both the bankroll and the target into
whole bets. The two roundings beat against each other and printed a ±5pp sawtooth
on a curve that is genuinely smooth and monotone — it read as a rendering bug.
Sweeps go over the integer units (`ruinProbUnits(k, n, p)`), never over the
dollar amount that has to be divided to get them.

**Quantile bands are the wrong summary for an absorbing process.** On the ruin
tab the 5th percentile pins to $0 and the 95th to the target within a couple of
hundred rounds, so the fan inflates into a solid block covering the whole board:
accurate and useless. Individual walks are the readable form there, and an
additive walk has no binomial lattice in log space, so two dozen of them can be
drawn without the moire that limits the multiplicative tabs to eight.

**A tolerance test cannot compare infinities.** `abs(inf - inf)` is `nan`, and
`nan <= tol` is false, so `verify.py:check` reported the St Petersburg
expectation as a failure while printing `got inf, want inf`. Both `check`
implementations now special-case non-finite values to equality.

**No numpy in JS: use a binomial-weight recurrence, not a pmf call per term.**
`sd_cycle_growth` and `ins_pool_growth` are each a sum over a binomial
distribution, and `lab/analytics.py` gets the whole array of weights from one
vectorised `binom.pmf` call. `js/engine.js` has no numpy, so `binomWeights(n,
p)` builds the same array with the elementary recurrence `pmf(k+1) = pmf(k) *
(n-k)/(k+1) * p/q` — one multiply per term instead of a `logGamma`-based
`binomPmf` call per term. This is the JS answer to "vectorise it": not a
library, a cheaper loop body. It stays numerically stable for any n this
project sweeps (up to a few thousand); `pmf(0)` only underflows to a hard zero
past n ≈ 1074 at p = 0.5, far outside any control range on the page.

**A `derive` that clamps a control's own displayed value must write the clamp
back into `state`.** Monty Hall's `opened` (doors the host opens) is clamped to
`doors - 2` inside `mhBoard`, and `opened` is also a slider the reader can see
and drag directly — unlike the gambler's ruin `target`, which is derived but
never itself displayed. Without syncing, the slider could show "8" while every
tile and chart quietly used the clamped value the formulas actually saw.
`app.js:syncDerivedControls` pulls the post-`derive` value back into
`state.values` and the DOM after every render, so the number on screen is
always the number in the maths. Any future scenario where `derive` clamps a
*visible* control needs this, not just Monty Hall.

**Hovering a slider and scrolling the page changes its value.** This is
standard `<input type="range">` browser behaviour (Chrome and Firefox both
apply wheel deltas to a focused/hovered range input), not a bug in this
project's controls, but it bit screenshot automation: scrolling the page with
the cursor left over a control changed `doors`/`opened` mid-test and produced
tiles that looked like a wrong formula until the actual slider values were
checked. Worth remembering when driving the page programmatically — move the
pointer (or scroll) away from the controls row before dispatching wheel/scroll
events.

## Dataviz

Follow the `dataviz` skill. Specifics already settled for this project:

- Palette is the skill's reference instance, in CSS custom properties in
  `index.html`. Series slots 1–4 (blue/orange/aqua/magenta) validate all-pairs in
  both modes; the sweep chart uses the blue↔red diverging pair around a zero
  baseline. Re-check with:

  ```bash
  python lab/validate_palette.py "#2a78d6,#eb6834,#1baf7a,#a01a6e" --mode light --pairs all
  python lab/validate_palette.py "#3987e5,#d95926,#199e70,#c026a8" --mode dark  --pairs all
  ```

- **The prisoner's dilemma has five categories and there are four chromatic
  slots.** The fifth, the random player, uses `--deemphasis` on purpose: it is
  the null baseline rather than a strategy with a position to defend, so the
  neutral ink is the honest slot for it. Reach for that reading before adding a
  fifth hue — a fifth colour that clears all-pairs CVD separation against these
  four is hard to find and the search that produced slot 4 only returned another
  green, distinguished from the aqua by lightness alone.

- Text sitting *on* a filled mark (the heatmap's cell labels) uses
  `--ink-on-light` / `--ink-on-dark`, chosen per cell by the luminance of the
  interpolated fill in `readableInk()`. Both variables are declared in both
  themes: which one applies is a per-mark decision, not a theme decision.
- Light-mode aqua is 2.74:1 against the surface, so the **relief rule** applies:
  direct labels and the table view are mandatory, not optional.
- Dark mode is declared under **both** the `prefers-color-scheme` media query and
  the `[data-theme]` scope, so the in-page toggle wins either way.
- Every chart has a table view. Legend keys mirror the mark: a 2px stroke for
  lines, a filled block for bars and bands.
- Scripts are **classic, not ES modules** — `type="module"` is CORS-blocked on
  `file://`, which would break local preview-by-double-click.

## Adding a scenario

Use the `/new-scenario` skill in `.claude/skills/new-scenario/`. It covers the
full path: closed forms in the lab, golden values, the registry entry, and the
chart forms. Entries with `status: "planned"` render as a roadmap card, so a
scenario can be declared before it is built.
