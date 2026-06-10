# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

EdgeBoard (deployed as **WhaleWatcher**, getwhalewatcher.me) ranks Polymarket traders by a 0–10 "Skill Score" that is purely statistical forecasting edge — how reliably a trader's entry prices beat the market's eventual resolution, Bayesian-shrunk for sample size — rather than raw PnL. Beyond the leaderboard it also serves a **Markets** page, a **recent-trades activity feed**, and per-wallet **detail** (open positions, closed positions with P/L, a mark-to-market equity curve). A pnpm monorepo with two workspaces:

- `scripts/` (`edgeboard-scripts`) — TypeScript ingestion pipeline run via `tsx`. Pulls Polymarket's public APIs (Data + Gamma + CLOB), computes metrics, writes to Supabase.
- `web/` (`edgeboard-web`) — Next.js 14 App Router frontend that reads pre-computed data from Supabase (it never calls Polymarket and never computes metrics).
- `supabase/migrations/` — the Postgres schema (13 migrations as of writing).

## Commands

Run from the repo root unless noted:

```bash
pnpm install
pnpm dev          # next dev (web), http://localhost:3000
pnpm build        # next build (web)
pnpm typecheck    # tsc --noEmit across BOTH workspaces (recursive)
pnpm ingest       # run the FULL ingestion pipeline (scripts/ingest.ts via tsx)
pnpm ingest:feed  # partial: refresh only the activity feed for current leaderboard wallets (--feed-only)
pnpm ingest:markets  # partial: refresh only the Markets table (--markets-only)

pnpm --filter edgeboard-scripts test   # run the scripts unit tests (from repo root)
pnpm --filter edgeboard-web test       # run the web unit tests (pure lib/ logic)
pnpm --filter edgeboard-scripts probe  # probeClosedPositions.ts — ad-hoc inspect of the /closed-positions shape
```

The ingest CLI flags (`--feed-only`, `--markets-only`) let the scheduler run cheap partial refreshes between full passes. Root `engines.node` is `24.x`; the Heroku `heroku-postbuild` is a no-op ("scheduler-only deploy: skipping web build") — the web app deploys via Vercel, Heroku only runs the scheduled ingest.

**Unit tests** run on Node's built-in test runner via tsx (`node --import tsx --test`); no jest/vitest, and there is no root-level `test` script — run each workspace's with `pnpm --filter <workspace> test`. Most tests live in `scripts/` (glob `**/*.test.ts`). The `web/` workspace also has a `test` script (glob `lib/**/*.test.ts`) for pure, framework-free `lib/` logic; component/page tests are not set up. Current coverage:

- `scripts/metrics.test.ts` — pure-function tests for scoring:
  - `computeMetrics` derives `pctReturn`, `winRate`, `avgEdgePerShare` (per-position mean forecasting edge), `pctEdge`, `nResolved`, `nTrades`, and volume; excludes positions older than the horizon; and handles an empty position set without dividing by zero.
  - `computeSkillScore` returns `null` for ineligible wallets (below `MIN_TRADES`, below `MIN_VOLUME_USD`, sub-cent longshot trader, or `outlierFlag` set), then scores the Bayesian-shrunk per-share edge: `shrunk = avgEdgePerShare·nResolved/(nResolved+EDGE_SHRINKAGE_K)`; zero/negative edge → 0, and any positive shrunk edge maps into `[SCORE_FLOOR, SCORE_MAX]` via `score = clamp(SCORE_FLOOR, SCORE_MAX, SCORE_FLOOR + (SCORE_MAX−SCORE_FLOOR)·shrunk/EDGE_FOR_TEN)` (a hard floor at `SCORE_FLOOR` for any proven edge). Expected scores are asserted as exact constants, so changing `EDGE_SHRINKAGE_K`/`EDGE_FOR_TEN`/`SCORE_FLOOR` in `config.ts` requires updating these.
- `scripts/botDetection.test.ts` — the bot heuristics.
- `scripts/walletDetail.test.ts` — `profileFillsFromActivity` (last-N raw fills, newest-first) and `openPositionRecords` (open-only holdings, endDate normalization) for the wallet-profile detail.
- `scripts/recentTrades.test.ts` — `recentTradesFromActivity` (the activity feed's buy/sell extraction).
- `scripts/markets.test.ts` — `mapEvent` (rolls a Gamma `/events` row up into one Markets record: most-favored outcome by implied probability, 24h change, category/tags, status flags).
- `scripts/polymarket.test.ts` — the defensive `readString`/`readNumber` field mapping.
- `scripts/priceHistory.test.ts` — `dailyPointsFromHistory` (collapse raw CLOB points to one per UTC day, horizon-windowed) and `planPriceFetches` (skip resolved/fresh assets, honor the per-run cap).
- `web/lib/walletTrades.test.ts` — `groupWalletTrades`, the read-time collapse of raw fills into per-position groups (volume-weighted avg entry/exit, null exit when still held).
- `web/lib/recentTrades.test.ts` — read-time shaping of the recent-trades feed.
- `web/lib/equityCurve.test.ts` — `windowedCurve` (anchors the equity curve to a fixed `[end − horizon, end]` window, prepends a $0 baseline, uses the data's last point as the right edge for SSR-stable rendering).

"Verifying a change" now means `pnpm typecheck`, `pnpm build`, and the unit tests all pass — and for the full pipeline, running `pnpm ingest` against a real Supabase + the live Polymarket API.

Apply the DB schema with `supabase db push` (it runs every migration in `supabase/migrations/`), or paste the migration files into the Supabase SQL editor in order. **There are 13 migrations** — `001` is the base schema; later ones add unrealized PnL, forecasting edge, the leaderboard edge/lifetime-PnL columns, the `markets` table + event/outcome fields, `recent_trades`, `waitlist`, the wallet-detail tables (`wallet_open_positions`, `wallet_closed_positions`, profile fills), and `market_price_history` / `market_price_meta`.

## Architecture and data flow

The system is a **batch-compute-then-serve** design. The web app never calls Polymarket and never computes metrics; it only reads pre-computed rows.

Ingestion (`scripts/ingest.ts` `main()`):
1. `discoverTopWallets()` (`polymarket.ts`) seeds wallets from Polymarket's `/v1/leaderboard`, falling back to `/trades` if that fails.
2. For each wallet (worker pool, `WALLET_CONCURRENCY` in flight): fetch `/activity` → `isSuspectedBot()`, plus `recentTradesFromActivity()` (feed) and `profileFillsFromActivity()` (last-N fills); fetch `/closed-positions` → `computeMetrics()` for each horizon in `CONFIG.HORIZONS` (30/90 days). Also derives `openPositionRecords()`, per-wallet closed-position basis records, and the distinct **outcome-token ids (`assets`)** the wallet held in-window (union of closed + current) — these seed the price-history cache. The max horizon also bounds how far back `getClosedPositions` paginates, so it drives ingest API cost. The web app's `HORIZONS` (`web/lib/types.ts`) matches: only 30 and 90 are exposed. (The 365-day horizon was removed end-to-end; the schema's `horizon_days IN (30, 90, 365)` CHECK constraints still permit 365 but nothing writes it.)
3. Upsert into `wallet_stats` and `equity_curve`; collect recent trades, profile fills, open positions, closed positions, and assets.
4. `rebuildLeaderboardCache()` re-derives `leaderboard_cache`: orders by `skill_score`, **excludes bot-suspected wallets**, keeps top `TOP_N`.
5. **Scope-to-board then persist the board-only detail.** Reads the leaderboard address set (`getLeaderboardAddresses`) and writes the recent-trades feed, profile fills, open/closed positions only for ranked wallets (wipe-and-replace per table).
6. `cacheMarketPriceHistory()` — the **only step that hits the CLOB API**. For every outcome token a leaderboard wallet held, pull `/prices-history` and cache a daily series in `market_price_history` (newest day per asset tracked in `market_price_meta`). Append-only + immutable: a token gone stale (no new daily point for `PRICE_HISTORY_STALE_DAYS`) is treated as resolved and never re-fetched, so the heavy first run amortizes to ~zero; a per-run fetch cap (`PRICE_HISTORY_MAX_FETCHES_PER_RUN`) defers overflow to later runs; rows older than the max horizon are pruned. Feeds the wallet mark-to-market equity curve.
7. `ingestMarkets()` — one global Gamma `/events` pass, `mapEvent()` per event, keep top `MARKETS_TOP_N` by liquidity into `markets`. Global, independent of wallet processing.

Partial CLI modes skip most of this: `--feed-only` re-pulls just `/activity` for current leaderboard wallets and refreshes the feed (no scoring, no closed-positions); `--markets-only` runs just step 7.

Web read path: `web/lib/supabase.ts` is the only DB access layer — `getLeaderboard`, `getWalletProfile`, `getRecentLeaderboardTrades`, `getMarkets`, plus the server/browser/write client factories. Pages (`web/app/page.tsx`, `leaderboard/`, `markets/`, `wallet/[address]/`, `early-access/`) and API routes (`web/app/api/{leaderboard,markets,recent-trades,waitlist,wallet/[address]}`) call it. Leaderboard reads come straight from `leaderboard_cache`; wallet profiles join `wallet_stats` + `equity_curve` + `leaderboard_cache` (rank badges) + the wallet-detail tables (`wallet_positions`, `wallet_trades`, `wallet_closed_positions`). The equity curve is served from the precomputed `equity_curve` table — `web/lib/equityCurve.ts` (`windowedCurve`) only re-windows those points at read time; the web app never reads `market_price_history` (that cache feeds the ingest-time mark-to-market only). The waitlist route uses the **anon write client** (RLS allows INSERT, not SELECT). UI lives in `web/components/` (e.g. `LeaderboardTable`, `MarketsTable`, `RecentTradesFeed`, `WalletDossier`, `WalletActivity`, `WaitlistForm`, `OceanScene`).

**Pre-launch access gate** (`web/middleware.ts`): in production every route except `/early-access` and `/api/waitlist` is bounced to the waitlist unless the visitor holds the `eb_access` cookie. You unlock by visiting `/unlock?key=<SITE_ACCESS_KEY>` once (sets a 1-year httpOnly cookie). Fail-closed if `SITE_ACCESS_KEY` is unset; gating is production-only so local `next dev` shows every page.

### Scoring lives in two files
- `scripts/config.ts` — the **single source of truth** for every tunable threshold (horizons, min trades/volume, skill-score knobs `EDGE_SHRINKAGE_K`/`EDGE_FOR_TEN`/`SCORE_FLOOR`/`SCORE_MAX`, eligibility gates, bot heuristics, API pagination/retry, the Gamma/CLOB hosts, `MARKETS_TOP_N`, and the price-history knobs `PRICE_HISTORY_FIDELITY_MIN`/`PRICE_HISTORY_STALE_DAYS`/`PRICE_HISTORY_MAX_FETCHES_PER_RUN`). Change tuning here, not inline.
- `scripts/metrics.ts` — `computeMetrics` (per-horizon realized PnL, % return, win rate, forecasting edge, daily equity curve) and `computeSkillScore` (the Bayesian-shrunk edge score: 0 for zero/negative edge, else `[SCORE_FLOOR, SCORE_MAX]`; `null` for ineligible wallets: too few trades, too little volume, sub-cent longshot, or one win dominating PnL).

Bot detection (`scripts/botDetection.ts`): flags wallets exceeding trades/day, simultaneous-market, or min-avg-trade-size limits.

## Critical conventions and gotchas

- **The Supabase `Database` type is hand-maintained in two copies; there is no codegen.** It appears inline in `scripts/ingest.ts` and again in `web/lib/types.ts`. Each copy is a **subset of the migrations** typing only the tables that workspace touches — `scripts` (writes) has `market_price_history`/`market_price_meta` and omits `waitlist`; `web` (reads + the waitlist insert) has `waitlist` and omits the price tables. That divergence is expected. The risk is the *shared* tables silently going out of sync with a migration: for columns the code actually selects, `strict` + `noUncheckedIndexedAccess` make `pnpm typecheck` catch it; for newly-added columns nothing references yet, update the relevant copy (or both) by hand.
- **`scripts/` is ESM (`NodeNext`) and imports use `.js` extensions** (e.g. `import { CONFIG } from "./config.js"` resolves to `config.ts`). Keep the `.js` suffix on relative imports there or `tsx`/`tsc` will fail. `web/` uses Bundler resolution and the `@/*` path alias — do not mix the styles.
- **Two TypeScript configs with different rules.** Both enable `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`, so optional props and indexed access need care.
- **Env vars** (copy `.env.example` → `.env.local`; root `.env.example` covers scripts, `web/.env.example` covers the web app):
  - web (browser-safe): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
  - scripts (writes): also needs `SUPABASE_SERVICE_ROLE_KEY`; optional `POLYMARKET_API_BASE`. `ingest.ts` loads `../.env.local` then a local `.env.local`.
  - Keep the **service-role key out of the web app** — the read path uses the anon key only.
- Polymarket's API field names are inconsistent, so `polymarket.ts` maps responses defensively via `readString`/`readNumber` with fallback key lists. When the API shape shifts, extend those key arrays rather than assuming one field name.
- Addresses are normalized to lowercase everywhere (ingestion, API routes, lib). Preserve this when adding lookups.
- **Polymarket rate limits** ([docs](https://docs.polymarket.com/api-reference/rate-limits)). We hit three hosts, each its own Cloudflare bucket over sliding 10s windows (requests are queued, not hard-rejected): the **Data API** (`data-api.polymarket.com`), the **Gamma API** (`gamma-api.polymarket.com`, markets), and the **CLOB API** (`clob.polymarket.com`, price history). Per-endpoint limits for the endpoints we call:
  - Data API `/closed-positions`, `/positions` — **150 req / 10s** (the binding constraint)
  - Data API `/trades` — **200 req / 10s**
  - Data API `/activity`, `/value`, `/v1/leaderboard` — fall under the general Data API limit of **1,000 req / 10s**
  - CLOB `/prices-history` — falls under the CLOB **General** limit of **9,000 req / 10s** (far above the Data API caps)

  `polymarket.ts` runs **one serial rate gate per lane** (`throttle(lane)`), keyed by `CONFIG.REQUEST_INTERVAL_MS`: `restricted` (`/closed-positions`, `/positions`), `general` (the rest of the Data API plus Gamma `/events`), and `clob` (CLOB `/prices-history`). Separate gates let cheap calls run in parallel with the expensive closed-position pagination, and keep the CLOB price-history backfill off the Data API budget entirely. Intervals target a comfortable fraction of each cap: restricted 90ms (~111 req/10s, under 150), general 30ms (~333 req/10s, under the ≥200 budget), clob 10ms (~1,000 req/10s, ~11% of the 9,000 cap — paced more by Supabase upserts than the gate). When tuning an interval down, keep that lane under its cap — `restricted` must stay ≥67ms (150/10s) and `general` ≥50ms (200/10s for `/trades`). `fetchJson` also honors the `Retry-After` header on a throttled response before exponential backoff.
