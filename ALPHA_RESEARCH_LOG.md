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
test is the only instrument that kills the last confound. **2026-07-05 (§10): audited the forward test —
theme diversity is HEALTHY (Iran only 27% of 55, multi-theme near-term), but its resolver was silently
BROKEN (inferred resolution from last CLOB trade, which never hits {0,1} on oracle-settled markets, so ~0
resolved and the resolvable subset was biased to blowouts). Fixed to read Gamma/UMA settlement; 3 stuck
predictions resolved live. Needs `git push heroku master` to go live on the cron. Alpha verdict unchanged.**

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

---

## 10. The forward-test instrument itself was broken (2026-07-05) — resolution never fired

Before trusting the forward test to settle the question over the coming months, I audited it. Two findings.

### 10a. Theme diversity — HEALTHY (the good news)
Worry: the forward sample could be a second Iran monoculture, in which case no amount of waiting clears
the "several distinct themes" bar. It isn't. Of the 55 locked predictions: **Iran only 27% (15/55), 53
distinct market families out of 55.** The near-term scorable set (≤90 days to resolution: 4 already past
end-date, 12 within 30d, 3 within 90d) spans **World Cup football, the LA mayoral race, US Fed rates, a
Russian parliamentary election, and the Iran cluster** — genuinely multi-theme. So the *first* batch of
forward results will test cross-theme skill, exactly what §9's last confound needs. Only 5 predictions are
>1yr out (2028 election etc.).

### 10b. The resolver was silently stuck — FIXED
`forwardAlpha.resolvedOutcome` inferred resolution from the **last CLOB traded price**, calling a market
resolved only if that price was within `RESOLVE_EPSILON` (0.03) of {0,1}. But Polymarket markets settle
**off-market via the UMA oracle** — trading stops with the last *trade* sitting mid-range, which never
reaches the gate. Probed the 4 past-end predictions live:
```
"Will France win on 2026-07-04?"        France WON (YES)  last CLOB trade 0.825 -> read as OPEN (stuck)
"Paraguay vs France: Team to Advance"   Paraguay LOST     last CLOB trade 0.085 -> read as OPEN (stuck)
"Spread: France (-1.5)"                  resolved          last CLOB trade 0.595 -> read as OPEN (stuck)
"Nithya Raman LA mayoral"                (Gamma has no record) getYesTokenId null -> null (stuck)
```
**The instrument the entire standing decision defers to was resolving ~nothing — and worse, the markets it
*could* resolve (last trade cleanly ≥0.97 / ≤0.03) are a biased subset (blowouts / lopsided books), while
contested markets silently drop.** That would have quietly corrupted the forward Brier toward easy markets
months from now, and looked like "still accumulating" the whole time.

Fix: read the **authoritative UMA settlement from Gamma** instead of inferring from CLOB trades. Gamma's
market record carries `umaResolutionStatus="resolved"` + `outcomePrices` (the settled `[YES,NO]` pair,
`["1","0"]`), indexed the same index-0-is-YES way the forward signal already uses. New pure
`resolvedOutcomeFromMarket()` + `PolymarketClient.getResolvedOutcome()` (`scripts/polymarket.ts`, unit-
tested incl. the 0.82-last-trade regression case); `forwardAlpha.resolvedOutcome` deleted, `score()` now
calls the Gamma resolver. **Verified live: the 3 stuck France-match predictions resolved on the first run
after the fix** (the LA mayoral one Gamma has no record of — legitimately stays pending). Forward test now
holds 3 resolved / 52 pending and will actually accumulate.

(First 3 resolved: smart money slightly *underperformed* the market — but it's n=3, all one correlated
World-Cup event, market went 3/3; statistically meaningless, do not read anything into it. The point is
only that the resolver fires now.)

**Standing decision still UNCHANGED.** This changes nothing about the alpha verdict — it repairs the
instrument that will eventually deliver one. Deploy note: the resolver runs on the Heroku dyno via the
`/refresh/forward-score` cron, so this fix must be pushed to Heroku (`git push heroku master`) to take
effect on the daily job — it is not live until then.

---

## 11. Copy-list tool (2026-07-05) — trading the signal at tiny size

For actually starting to trade small (<$1/position), built `scripts/copyList.ts` (`pnpm copylist`): the
markets ELITE wallets bought in the last few days, so you mirror fresh entries near their price. Two
deliberate choices from this investigation: (a) it uses FRESH entries, not the Trending divergence
signal, which mis-fires via the §5.3 timing artifact (confirmed live — the top divergence rows, Becerra/
Iran, had zero recent trades = stale winners the signal told you to fade); (b) "elite" is a strict cut,
not the whole board — `scripts/eliteWallets.ts` reads the deep archive and keeps wallets whose family-
collapsed shrunk per-share edge is both strong (≥0.03/sh over ≥8 families) AND consistent (positive in
BOTH history halves — the §9 time-persistence signal, which is theme-confounded as PROOF but exactly the
right practical filter for SELECTING who to copy). Live: 123/148 archive wallets clear the gate; ranked
by multi-wallet agreement → edge → size, so the top rows are 2–4 elite wallets on the same side. Gamma
enrichment labels the exact bet (Over/team/Yes) and drops resolved/ended markets. Output is GROUPED by
Polymarket's own event (title stem before " - "), so one game is one slot instead of eating five — its
distinct bet types (moneyline / O/U / corners) stay separate lines (never merged, to avoid conflating
different bets), and opposite sides of the SAME market (same condition_id) are netted to one line with
the dissent flagged. Known gap: a cross-EVENT complement (e.g. "Team to Advance" vs "Stage of
Elimination", different Polymarket events) isn't auto-merged — deliberately, since forcing it needs
fragile semantic matching.

Honesty ceiling (unchanged verdict): the edge/share shown is RAW and survivorship-inflated; this is the
best available RANKING of who to copy, not proof of forward edge. It doubles as forward-test data
generation. Do NOT scale capital on it — the forward test is still the arbiter.

### 11a. In-sample copy backtest (2026-07-05) — encouraging STRUCTURE, inflated LEVEL
Quick gut-check on the archive: "if I'd copied elite wallets' entries (0.10–0.90 price band) and held to
resolution, what would $1/bet have returned?" One bet per (condition_id, outcome_index); 14,816 distinct
market-sides across 133 elite wallets.
```
ALL elite copies        win 64.0%   mean $/$1 +0.308   (survivorship-inflated — ignore the level)
  by AGREEMENT (copylist's headline signal — validated in sample):
  1 wallet   n=12789   win 63.2%   +0.294
  2 wallets  n= 1250   win 67.3%   +0.375
  3+ wallets n=  777   win 71.4%   +0.419      <- monotonic: more elite agreement = better
  by PRICE: favorites .65-.90 win 89% +0.171 | mids win 68% | longshots .10-.35 win 31% median -1.00 (lottery)
NON-elite board wallets  win 54.3%   +0.092      <- elite filter ~3x's the return, +10pt win rate
```
Reads: the STRUCTURE is real and pro-copylist — agreement predicts, and the elite filter earns its keep.
The LEVEL (+30%/bet) is rigged (elite = wallets picked because they won; the agreement gradient is also
partly circular since a market 3 elite wallets won on is what made them elite). Only the forward test
gives the honest number.

### 11b. Copylist forward test (2026-07-05) — survivorship-FREE, built
`scripts/copylistForward.ts` (`copylist:record`/`copylist:score`) + migration 032 (`copylist_predictions`)
+ webhook routes `/refresh/copylist-record`+`/refresh/copylist-score`, same proven pattern as the
convergence forward test (§7). `--record` locks each copylist (market, side) the moment it qualifies —
freezing the entry price you'd copy at + the elite-agreement count — and never revises it; `--score`
settles via Gamma/UMA and prints win rate + mean $/$1 OVERALL and BY agreement bucket (does 2–3 wallets
beat 1 out-of-sample?). Shares `buildCandidates`/`copyPnlPerDollar` (extracted to `copyCandidates.ts`)
with the live tool, so it tests exactly what `copylist` shows. Needs migration 032 applied + two daily
cron-job.org jobs. This is the arbiter for the copylist signal; the in-sample +30% is NOT.

---

## 12. Forward-test honesty upgrade (2026-07-11) — score what a FOLLOWER actually gets

First real scorecard read (26 settled): ALL copies −0.150 $/$1, win 34.6% — copying the whole list
loses. The post-hoc high-edge tertile showed +0.274 (n=9), but scanning fixed edge thresholds on the
same 26 resolved rows flips the sign (edge≥0.10 → −0.067) — the slice is noise-sensitive at this n, and
picking a threshold by peeking at outcomes is exactly the §4f mistake. So three changes (migration 033):

1. **`copy_price`** — the forward test froze `entry_price` = the ELITE WALLETS' own fill. By the time
   the list surfaces a bet the market has often moved toward it, so scoring at their fill flatters the
   copier. Now the CURRENT market price at record time (Gamma `outcomePrices`) is frozen too, and the
   scorecard's headline is $/$1 **at the copy price** — the number a follower actually gets. Elite-fill
   $/$1 stays as a reference line; the gap between the two ≈ the cost of being late.
2. **`edge_rank`** — 1-based position in the edge-ranked list, frozen at record time. Pre-registers the
   real betting policy ("take the top rows") so it can be scored without post-hoc slicing.
3. **`source`** ('board' | 'scout') — **the live `pnpm copylist` tool (sportsScout: discovered
   off-board wallets, holder-vetted) was never being forward-tested at all**; copylistForward records
   the older board-elite signal. Real bets are placed from the scout list → untested signal. Now every
   pick sportsScout PRINTS is auto-locked into `copylist_predictions` with `source='scout'` at the shown
   (current) price, in display order (`SCOUT_NO_RECORD=1` skips). The scorecard splits by source, so the
   two signals are judged separately. First-sighting-wins is unchanged; scout rows fail soft if the
   migration isn't applied.

Deployment rule stays: NOTHING here is proven edge. The bar before real-money scaling: the
**scout-source, copy-price, top-rank slice must be positive on ≥30 settled predictions spanning
multiple sports/weeks**. Until then bets are $1-sized data generation.
