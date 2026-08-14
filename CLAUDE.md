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
| `lab/analytics.py` | **Source of truth.** Eight numbered sections: the multiplicative coin, gambler's ruin, St Petersburg, the prisoner's dilemma, Monty Hall, Shannon's demon, insurance and risk pooling, the wheel strategy. |
| `lab/verify.py` | Checks the closed forms against Monte Carlo, then writes `js/golden.js`. |
| `js/engine.js` | Simulation + the same closed forms, mirroring `analytics.py` section for section. |
| `js/scenarios.js` | The scenario registry. Adding a scenario touches only this file plus a chart if it needs a new form. |
| `js/charts.js` | Plotly wrappers. Reads all colour from CSS custom properties. |
| `js/app.js` | Page wiring: the `CHART_KINDS` registry, controls, tiles, legends, table views, theme. |
| `tests.html` | Runs `engine.js` against `js/golden.js` in the browser. |
| `lab/fetch_market_data.py` | Offline, one-shot: fetches real daily prices from Yahoo Finance and writes `js/market_data.js`. Not part of the Python-derives-JS-ships contract above — there is no closed form to check a price against, so it has no `verify.py` case. Re-run it to move "present day" forward. |
| `js/market_data.js` | **Generated, not hand-edited.** `window.EP_MARKET`: real daily closes (2009–present) for 5 indices and 20 stocks, for the wheel scenario's "choose your underlying" control. |

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

**Two different tolerance classes exist now, not one.** Every scenario before
the wheel checked JS against Python at 1e-8/1e-9, because every quantity was
either exact arithmetic or the shared mulberry32 PRNG, and both sides compute
those bit-for-bit identically. The wheel introduces a second class: `normCdf`
and `normPpf` are *approximations* in `engine.js` (Abramowitz-Stegun and
Acklam) checked against scipy's exact routines in `analytics.py`, and every
Black-Scholes price, real-world ITM probability, and buy-and-hold quantile
runs through one of them. `tests.html` holds that whole family to 1e-5/1e-6,
deliberately looser than the PRNG-only bar (`path[i]`, dip and hold equity
never call either function, so they stay at 1e-9). Adding a scenario with its
own transcendental approximation should reuse this split rather than
discovering it again by watching an all-green suite turn red at 1e-9 for a
value that is correct to six decimal places.

**A relative tolerance cannot compare two numbers that are each "zero plus
floating-point noise."** Shannon's demon's `stockGrowth` is analytically zero
for a symmetric coin; Python and JS each land within 1 ULP of it but not of
each other, and `abs(got-want)/abs(want)` explodes when `want` is ~1e-17. Same
failure mode as the St Petersburg infinity case above, same fix: `tests.html`
now switches to `absTol` whenever the golden value itself is smaller than
1e-9, rather than trusting a relative bar to mean anything near a true zero.

**A helper's own parameter name is not the scenario's field name, and passing
`pr` straight through hides the mismatch instead of erroring on it.**
`holdSummary`/`hold_summary` take a parameter called `sigma`, standalone; the
wheel's own params object calls the same quantity `sigmaRv`, because `sigmaIv`
also exists and both need distinct names. Calling `holdSummary(pr)` directly
compiles, runs, and returns `NaN` propagated all the way through -- `pr.sigma`
is `undefined`, and `undefined * dt` degrades to `NaN` silently rather than
throwing. `simulateGbmPath` had the identical trap for the same reason.
Neither was caught by writing the code carefully; both were caught by running
it and finding `NaN`/`null` in the output. Map field names explicitly at the
call site (`holdSummary({ sigma: pr.sigmaRv, ... })`) whenever a shared helper
predates a scenario that needs a more specific name for the same quantity.

**A risk control defined on the wrong variable can silently delete the
strategy it protects, and every test will still pass — and this bit the wheel
*twice*, from two different stop thresholds.** A stop on the put's own marked
value is incompatible with the wheel's purpose: any path ending in assignment
must first push the short put deep enough into the money to trip the stop, so
the stop fires first, essentially always. This is not a knife-edge -30%
threshold either — -30%, -50%, and even -100% (a threshold that cannot be
reached by a real short position, since 100% of premium is the max possible
gain) *all* produced zero assignments over the S&P's 2009-2026 history. Only
around -200% did the stop stop blocking assignment, by which point it is not
meaningfully a stop. The fix that finally held: no stop on the put at all —
its premium is banked the moment it is sold, so there is nothing left on that
leg to protect — and the one loss cap in the strategy sits on the *shares*
instead, which carry a real, unbanked, open-ended mark that a stop can
meaningfully cut. Nothing about bookkeeping or parity testing catches this
kind of bug: the identities balance (zero is a valid count), Python and JS
agree (both sides are equally wrong), and the equity curve looks smooth and
plausible. What catches it is printing the event counts and reading them, and
asserting the scenario's stated goal actually happens — `verify_wheel` checks
that assignments across a batch of seeds is greater than zero.

**Two arms that are supposed to differ can collapse onto each other, and a
chart will not tell you.** Two different versions of this scenario produced a
wheel that was, on the default seed, pixel-identical to the puts-only arm —
once because the covered-call leg was gated on a fresh *all-time* high (which
a drawdown can leave shut for good), and again because the put's stop-loss
above made assignment near-impossible in the first place, so there was rarely
a share position for the call leg to act on at all. A comparison scenario
should assert its arms actually diverge; identical lines read as a rendering
bug, and worse, read as a *finding*.

**A cohort still open when the horizon ends is a fourth outcome, not a
missing one.** `simulateWheel`'s bookkeeping identity is `sold = closed early
+ expired + assigned/called-away + still-open` -- the last term exists because
a six-month put tenor and a five-year horizon routinely land mid-cohort at the
last day simulated. Dropping it made `puts_sold` disagree with the sum of
every *other* bucket by exactly the size of the last cohort, which reads like
a bookkeeping bug and is actually just an unfinished trade at the edge of the
chart.

**Real market data is baked in once, offline — never fetched at request time.**
This is a static GitHub Pages site with no backend, so `js/market_data.js` is
generated by running `lab/fetch_market_data.py` against Yahoo Finance's public
chart endpoint and committing the output, the same way `js/golden.js` is
generated by `verify.py` rather than hand-written. Two consequences worth
remembering: (1) "present day" on the wheel's real-data option is frozen at
whenever the script last ran, not actually live — re-run it to move that
forward; (2) it is `adjclose`, not `close` — split- and dividend-adjusted —
because an unadjusted close would silently show a fake price collapse on every
split date and understate a stock's real total return by however much it has
paid in dividends since 2009.

**A real price series has its own scale and currency; the wheel's contract
math assumes neither.** 100-shares-per-contract sizing against the S&P 500's
raw level (~4 digits) or the Nikkei's (~5 digits, in yen) would price a single
lot far outside any sane starting-capital slider. `derive()` in the wheel's
scenario entry rebases every real series to start at `s0` before handing it to
`simulateWheelFamily` — indexed-to-100 is standard practice for comparing
returns across securities, and it means the mechanics never need to know or
care what the real security's price level or currency was.

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
