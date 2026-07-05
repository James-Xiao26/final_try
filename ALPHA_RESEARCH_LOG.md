# Alpha Research Log — Smart-Money Signal

Running notes on the attempt to find a tradeable edge in the leaderboard's "smart money" signal
(smart-money implied odds vs. the market's real odds). Newest findings at the top of each section.

**One-line status (2026-07-05):** No tradeable alpha demonstrated, but the strongest lean yet. The
cross-theme persistence test (§9) finds a wallet's Iran-cluster edge tracks its non-Iran edge, and the
signal SURVIVED three confound-strips — duplicate-book de-herding, favorite-harvesting (their edge is
underdog-skill, +0.10/sh profit vs favorites' ~0), and price/favorite-longshot de-biasing — actually
strengthening to r=0.428 (t≈3.35). One confound remains (common thematic factor), the level is pure
survivorship, and this is the exact "survives many checks then dies on the independence check" pattern
that's cried wolf before. Prior nudges ~15% → ~30-35%. Do NOT deploy or flip the live weight; the forward
test (alive: 55 predictions in 2 days, 0 resolved yet) is the only instrument that kills the last confound.

---

## 1. The thesis being tested

Traders on the leaderboard have a forecasting edge. If we aggregate their entry prices on a market
into a single "smart-money implied probability" and it systematically beats the market's own price,
we can copy it: bet the side smart money favors and hold to resolution.

**For this to be real alpha, three things must ALL be true:**
1. **Better than the market** — the signal predicts outcomes more accurately than the price you'd pay.
2. **Capturable** — you can enter at a price that doesn't already reflect the information.
3. **Repeatable** — it works out-of-sample, on new/independent markets, not one lucky event.

The signal fails #3 outright and is compromised on #1 and #2. Details below.

---

## 2. The signal & weighting formulas tried

Signal = weighted average of the wallets' YES-equivalent entry prices, over markets where ≥5
leaderboard wallets each hold a non-dust (≥$10) position. Weighting variants tested:

| Formula | Weight per wallet | Idea |
|---|---|---|
| `equal` | 1 | one wallet, one vote |
| `v1` (production) | `skill × √cost` | skill-weighted, √ dampens big bets |
| `dollar` | `cost = size × price` | weight by dollars in |
| `sqrt(cost)` | `√cost` | dampened dollars |
| `skill × cost` | `skill × cost` | |
| **`payout` (best)** | **`size`** | **weight by payout-if-it-wins (= shares); price drops out of the weight** |
| `biggest bettor` | — | just the largest position |

**Payout insight (2026-07-03):** cost-weighting over-weights high-price favorites — N shares of an
80¢ favorite cost 4× N shares of a 20¢ longshot despite identical payout/conviction. Weighting by
`size` (= payout, since each winning share pays $1) removes that bias. Payout won the backtest ranking.
It is also more robust than dollar-weighting when a whale sells out early (less hostage to one big
dollar bet). Wired into `backtestSmartMoney.ts`, `forwardAlpha.ts`, migration 030.

---

## 3. The backtests built

- **`scripts/backtestSmartMoney.ts`** — ranks every weighting on one clean snapshot of
  `wallet_closed_positions`. Brier, directional accuracy, paired significance, favorite baseline,
  whale-rode-vs-sold split, profit simulation. Survivorship-biased (see §5).
- **`scripts/backtestWhaleExit.ts`** — the rigorous stress test. Resolves outcomes from the **CLOB
  settlement price** (independent of the wallets, includes abandonment markets), adds a favorite
  baseline per group, and clusters by `event_slug` and by market **family** to get the honest sample
  size. Writes `scripts/convergedMarkets.csv` (every converged market, openable in a spreadsheet).
- **`scripts/forwardAlpha.ts`** + migrations 028/029/030 — the survivorship-FREE forward test. Locks a
  prediction the moment a market qualifies, scores it only after it resolves. The one clean instrument;
  slow to accumulate.

---

## 4. Full stats (latest run — numbers drift a few points as the leaderboard/data refresh)

### 4a. Brier ranking, n=302 (backtestSmartMoney)
```
payout (size)        Brier 0.1058   accuracy 86.4%   <- best
dollar size          0.1102         86.1%
skill × cost         0.1117         86.1%
sqrt(cost)           0.1152         87.1%
v1 skill × √cost     0.1170         85.4%   (production)
biggest bettor       0.1217         83.1%
equal                0.1278         84.8%
naive 50/50          0.2500
```
Paired: v1 vs dollar, mean ΔBrier +0.0068, **t=3.61** — looks very significant. (It isn't; see §5.)

### 4b. Can the signal beat the MARKET'S OWN price? (n=212 price-matched)
```
market price (favorite)  Brier 0.1699   dir.acc 75.9%   <- the bar
payout (size)            Brier 0.1220   dir.acc 83.5%
dollar size              Brier 0.1211   dir.acc 84.0%
```
Signal beats the market on Brier — but the favorite alone already gets 75.9% accuracy, so most of the
83.5% is free. The marginal edge is what matters, and it's confounded (§5).

### 4c. Hold-to-resolution robustness — whale rode vs. sold out early (CLOB-resolved)
```
group                     n    signal win   favorite win   EDGE
ALL resolved             156     89.1%         77.6%      +11.5pt
whale RODE to resolution  61     98.4%         83.6%      +14.8pt   (partly circular — see §5)
whale SOLD OUT early      95     83.2%         73.7%       +9.5pt   (the realistic copy case)
EVERYONE bailed (ugliest) 11     72.7%         72.7%       +0.0pt   <- alpha dies
```
Encouraging: even when a whale bails, holding to resolution still beat the favorite by ~9.5pt. Fatal:
when the whole crowd bailed, edge = 0.

### 4d. Profit simulation (payout, buy the divergence-from-market side, per gap threshold)
```
≥5pt gap:  win 55.1%   ≥10pt: 59.6%   ≥20pt: 56.1%     (payout beats dollar/v1 at every gap)
```

### 4e. What markets did smart money actually converge on? (n=156)
```
Geopolitics  81%   Other 15%   Sports 3%   Economy 1%   Crypto 1%
```
**73% of the converged markets are ONE situation: US/Iran, spring 2026, sliced across ~41 date-variant
markets** (peace deal by May 26/31, June 15/30; ceasefire by Apr 7/22; Hormuz; airspace; etc.).

### 4f. The decisive test — clustering to stop double-counting correlated markets
```
clustering              overall edge          non-Iran edge
markets (naive)         +9–13pt, "t=3.6"      —
event_slug (72 events)  +9.6pt, t=2.54        +0.0pt, t=0.00
family (bucket-merged)  +7.9pt, t=1.89        +1.6pt, t=0.33
```
Every time correlated markets are counted once, the edge shrinks. Family clustering drops overall
significance **below the 95% bar (t=1.89)**, and outside Iran the edge is flat **zero** by both methods.

### 4g. Recurring single-wallet bucket families (all 15,456 closed rows)
453 families have ≥3 date/number variants; **321 (71%) are >60% one wallet** (Elon tweet-count = 381
markets/69% one wallet; S&P & NVDA Up-or-Down; Trump post-count; temperature; BTC-level; flight-delay;
"White House full lid"). These are single-wallet actuarial niches, not convergence.

---

## 5. Why the good Brier / high win rate is NOT alpha

The headline numbers (Brier 0.106, ~86% accuracy, +11.5pt over favorite) look like a strong edge. They
are not, for five stacked reasons — each independently deflates it, and they compound:

1. **Accuracy ≠ edge. A low Brier measures being right, not being right *more than the price you pay*.**
   The market's own price is already ~76% accurate on these markets. Being 86% accurate is only worth
   money to the extent it exceeds the market — the marginal +11.5pt — not the raw 86%. Most of the
   impressive number is just "favorites usually win," which you can get for free without any signal.

2. **Survivorship bias.** The sample is the past trades of wallets *on the current leaderboard* — i.e.
   wallets selected *because they already won*. Backtesting their own winning history is rigged to look
   good. The ranking of formulas survives this; the absolute edge does not.

3. **Timing artifact.** The signal is the wallets' *blended* average entry price, which absorbs
   information up to their *last* buy. The favorite baseline is the market price at their *first* trade.
   So the signal is effectively timestamped later, with more information, than the price it's compared
   against — it looks prescient partly because it's measured later. The biggest "wins" (signal 92% vs
   market 58%) are exactly the pattern you'd get from this artifact, not from foresight. The forward
   test avoids this; the backtest cannot.

4. **Correlation / fake sample size.** 73% of the markets are the *same* Iran situation in different
   date-wrappers. Counting "peace deal by May 31" and "by June 30" as two independent wins inflates the
   sample ~10–30×. Cluster them honestly and significance falls below the 95% threshold (t=1.89).

5. **It doesn't generalize — the killer.** Outside the single Iran theme, the edge over the favorite is
   **zero** (event-clustered +0.0pt t=0.00; family-clustered +1.6pt t=0.33). A real forecasting skill
   would leave *some* trace on other themes. It leaves none. What we have is one correct macro read of
   one geopolitical crisis, dressed up by dozens of date-variant markets to look like a broad edge.

**Plain-language summary:** the backtest shows we correctly noticed two things — (a) favorites usually
win, and (b) one specific 2026 Iran crisis went a certain way. Neither is a repeatable process that
makes money on *new* markets. Alpha has to be repeatable and capturable at a fair price; this is one
lucky/skilled event, measured with hindsight, on a survivorship-selected sample. That is not alpha.

---

## 6. Confounds catalogue (things that masquerade as forecasting edge)

Beyond the five above, other non-forecasting edges a leaderboard wallet could have that would NOT
transfer to a hold-to-resolution copier: market-making/spread capture, same-event & cross-market
arbitrage, settlement carry (buying 97¢ certainties), liquidity-reward farming, wash trading,
favorite-longshot harvesting, latency/already-priced-in, price impact from their own size, insider/
private info, stale-quote sniping, cross-venue arb vs sharper books (Pinnacle), and correlated-book
PnL smoothing. The forward test neutralizes most (it's outcome-based); insider and cross-venue arb are
the ones it can't distinguish from skill.

---

## 7. What's left to try (besides waiting for the forward test)

- **External sharp-book attribution** (runnable now): for markets that also trade on Pinnacle/Betfair
  or another venue, check whether the signal just *tracks the sharper book*. If so, the "edge" is
  cross-venue lag, not forecasting, and it decays.
- **Per-wallet cross-theme persistence**: do wallets good on Iran also beat the market on unrelated
  themes? Currently crippled by the monoculture (most wallets only have Iran history) — which is itself
  the finding.
- **Start archiving `wallet_closed_positions`** so the rolling 90-day window stops discarding history.
  In months you'd have multiple distinct crises/elections to test cross-theme persistence properly.
  **DONE (2026-07-04):** `closed_positions_archive` (migration 031), append-only, written by the daily
  ingest (`archiveClosedPositions`) and seedable immediately via a one-off `archiveBackfill.ts` (~1yr
  deep pull; `getClosedPositions` gained an optional `maxDays`). The cross-theme persistence test itself
  is now built — `crossThemePersistence.ts`: time-split (first vs second half) and geo-vs-non-geo edge
  persistence, Pearson r across wallets, family-collapsed like the Skill Score. Run `archiveBackfill.ts`
  then `crossThemePersistence.ts`; r≈0 on both would confirm §5.5.
- **The forward test** (`forwardAlpha.ts`) — the only clean instrument. Scripts + webhook routes
  (`/refresh/forward-record`, `/refresh/forward-score`) + package.json entries all exist; the ONLY
  missing piece is two cron-job.org jobs pointing at those routes (daily record + daily score). `--score`
  now prints **marginal** edge over the market (ΔBrier / Δacc) so raw accuracy isn't mistaken for alpha.
  Still needs weeks/months to clear several *distinct* themes. Slow precisely because real convergence is rare.

## 8. Product fixes surfaced (independent of alpha)

**Both IMPLEMENTED 2026-07-04 (uncommitted; unit-tested, typecheck clean, 406/406 tests pass).**

- **Fix 1 — score no longer over-credits recurring-series grinds.** `computeMetrics` (`scripts/metrics.ts`)
  now FAMILY-COLLAPSES the forecasting-edge sample: each market family (date/number variants of one
  series, via `marketFamilyKey`) contributes ONE equal-weight edge observation, and `nResolved` (the
  Bayesian-shrinkage denominator) is the count of distinct resolved *families*, not positions. A wallet
  grinding 381 Elon-tweet buckets (or a dozen Iran date-variants) now gets ~1 prediction's credit, not N.
  `nTrades`/volume/win-rate (eligibility gates) are untouched — only the edge/score sample collapses.
  Chosen over a market-type blocklist because predicting tweet counts *is* forecasting — the defect is
  correlation/concentration, not the market type. **NOT a pure refactor: this changes live Skill Scores
  and will reshuffle the leaderboard — validate with a real `pnpm ingest` before deploying.**
- **Fix 2 — whale-concentration cap on convergence + trending.** A market whose committed capital is
  >`MAX_WHALE_COST_SHARE` (0.6) in a single wallet no longer counts as multi-wallet convergence.
  Applied in `summarizeCrowdedMarkets` (both `scripts/` + `web/lib/` copies; wired at ingest via
  `CONFIG.MAX_WHALE_COST_SHARE`) and `qualifyingConditionIds` (`web/lib/trendingMarkets.ts`, wired in
  `getTrendingMarkets`). Cap param defaults off in the pure fns (unit-fixture ergonomics); production
  callers pass the real value.

- **Fix 3 — specialty family-collapse (2026-07-04, closes the item below).** `walletSpecialty`
  (`scripts/specialty.ts`) now groups each category's resolved positions by `marketFamilyKey` and counts
  distinct *families*, not positions, against both `MIN_SPECIALTY_TRADES` and the shrinkage denominator —
  so a recurring-series grind (one family repeated N times) can no longer mint a specialty chip. Same
  collapse `computeMetrics` uses; no-op for diversified wallets. Tests updated to distinct-family fixtures.

---

## 9. Cross-theme persistence test (2026-07-05) — the FIRST non-null lean, but still not alpha

Built to answer §7's blocked question head-on: does a wallet's edge on one theme transfer to unrelated
themes, or is the board just one lucky Iran read? `scripts/crossThemePersistence.ts` reads the new
append-only `closed_positions_archive` (migration 031, backfilled ~1yr by `archiveBackfill.ts`) —
**32,992 resolved positions across 148 board wallets** — and correlates each wallet's Bayesian-shrunk,
family-collapsed per-share edge on one side vs the other, across wallets.

Results (n = wallets with ≥4 distinct families on BOTH sides), after knocking down three confounds:
```
TIME  1st-half vs 2nd-half history        r=0.600  n=145   theme-CONFOUNDED — discard
THEME Iran vs rest — RAW edge             r=0.352  n=52    survives...
THEME Iran vs rest — DE-HERDED books      r=0.352  n=52    ...duplicate-book herding (dedup dropped 2/148)
THEME Iran vs rest — DE-BIASED (price)    r=0.428  n=52    ...favorite/price/baseline — and STRENGTHENS
THEME Geopolitics(all) vs rest — RAW      r=0.184  n=64    weak/ambiguous
Favorite-baseline (PROFIT, all 32,992):  wallet +0.102/sh  vs always-favorite +0.001  MARGINAL +0.101
```
The time split can't separate themes (one long-running theme across both halves inflates it) — discard.
The **Iran-isolated** split is the real test, and it survived every confound I could strip in-sample,
getting *stronger* each time:
1. **Duplicate-book herding — ruled out.** Jaccard>0.5 book-overlap dedup removed only 2 of 148 wallets
   and left r identical: full ~1yr books are large/idiosyncratic even when two wallets share the Iran
   cluster, so the correlation isn't the crowd double-counted.
2. **Favorite-harvesting — ruled out.** On PROFIT (not win rate), the board makes +0.102/share while
   always-buying-the-favorite makes ~0 (+0.001, i.e. favorites are ~fairly priced). Their edge is
   *underdog-skill-shaped*, not settlement-carry on 90¢ certainties. (Their 59.5% win rate is BELOW the
   favorite's 74% purely because they take underdogs — a lower win rate at a good price is still profit.)
3. **Favorite-longshot / price-level / board-wide baseline — ruled out.** De-biasing every position by
   the pooled price→realized-outcome calibration collapses the *level* of edge to ≈0 (mean de-biased Iran
   +0.005, non-Iran +0.003 — so the board's positive raw edge IS almost entirely the price/baseline
   effect), yet the cross-theme *correlation* of the residual survives and rises to **r=0.428 (t≈3.35)**.
   I.e. after removing everything the price predicts, wallets that beat the outcome on Iran still beat it
   elsewhere. This is the cleanest pro-skill signal in the whole investigation.

Why it is STILL only "suggestive," NOT deployable alpha:
- **The one confound left standing: common thematic FACTOR.** Distinct books exposed to the same handful
  of theme-level outcome surprises (Iran resolved one way; some other theme another) share residual edge
  WITHOUT sharing positions — neither Jaccard nor price-de-biasing can see it, so effective n is still
  below 52 and r could be a few correlated theme-surprises, not N independent skill draws.
- **The +0.102/share profit edge is pure survivorship** — the sample is board WINNERS, selected because
  they won; only the cross-theme *correlation* (which selection should attenuate, not create) is the real
  signal, not the level.
- **§4f precedent:** every prior signal here also survived several checks before dying on the
  independence/clustering check. "It keeps surviving" is exactly the pattern that has cried wolf before.

**Standing decision UNCHANGED:** production `smartMoneyImpliedPrice` stays `skill·√cost`; do NOT flip the
live weight or deploy capital. Further in-sample surgery now has diminishing returns and risks p-hacking —
I've stripped every confound the survivorship sample allows. The **forward test** is the only instrument
that kills the last confound (independent locked predictions, no survivorship, real market baseline), and
it is alive: **55 predictions recorded over 2 days (2026-07-03/04), ~27/day, 0 resolved yet** (young, not
broken). Net: prior on a real forward-persistent edge moves **~15% → ~30-35%** — enough to take seriously,
NOT enough to bet. Let the forward test resolve across several distinct themes; re-run this as the archive
deepens.
