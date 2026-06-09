# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

EdgeBoard ranks Polymarket traders by a 0–10 "Skill Score" that is purely statistical forecasting edge — how reliably a trader's entry prices beat the market's eventual resolution, Bayesian-shrunk for sample size — rather than raw PnL. A pnpm monorepo with two workspaces:

- `scripts/` (`edgeboard-scripts`) — TypeScript ingestion pipeline run via `tsx`. Pulls Polymarket's public Data API, computes metrics, writes to Supabase.
- `web/` (`edgeboard-web`) — Next.js 14 App Router frontend that reads computed data from Supabase.
- `supabase/migrations/` — the Postgres schema.

## Commands

Run from the repo root unless noted:

```bash
pnpm install
pnpm dev          # next dev (web), http://localhost:3000
pnpm build        # next build (web)
pnpm typecheck    # tsc --noEmit across BOTH workspaces (recursive)
pnpm ingest       # run the ingestion pipeline (scripts/ingest.ts via tsx)

pnpm --filter edgeboard-scripts test   # run the scripts unit tests (from repo root)
pnpm --filter edgeboard-web test       # run the web unit tests (pure lib/ logic)
```

**Unit tests** run on Node's built-in test runner via tsx (`node --import tsx --test`); no jest/vitest, and there is no root-level `test` script — run each workspace's with `pnpm --filter <workspace> test`. Most tests live in `scripts/` (glob `**/*.test.ts`). The `web/` workspace also has a `test` script (glob `lib/**/*.test.ts`) for pure, framework-free `lib/` logic (e.g. the read-time trade collapse); component/page tests are not set up. Current coverage:

- `scripts/metrics.test.ts` — pure-function tests for scoring:
  - `computeMetrics` derives `pctReturn`, `winRate`, `avgEdgePerShare` (per-position mean forecasting edge), `pctEdge`, `nResolved`, `nTrades`, and volume; excludes positions older than the horizon; and handles an empty position set without dividing by zero.
  - `computeSkillScore` returns `null` for ineligible wallets (below `MIN_TRADES`, below `MIN_VOLUME_USD`, sub-cent longshot trader, or `outlierFlag` set), then scores the Bayesian-shrunk per-share edge: `shrunk = avgEdgePerShare·nResolved/(nResolved+EDGE_SHRINKAGE_K)`; zero/negative edge → 0, and any positive shrunk edge maps into `[SCORE_FLOOR, SCORE_MAX]` via `score = clamp(SCORE_FLOOR, SCORE_MAX, SCORE_FLOOR + (SCORE_MAX−SCORE_FLOOR)·shrunk/EDGE_FOR_TEN)` (a hard floor at `SCORE_FLOOR` for any proven edge). Expected scores are asserted as exact constants, so changing `EDGE_SHRINKAGE_K`/`EDGE_FOR_TEN`/`SCORE_FLOOR` in `config.ts` requires updating these.
- `scripts/botDetection.test.ts` — tests for the bot heuristics.
- `scripts/walletDetail.test.ts` — `profileFillsFromActivity` (last-N raw fills, newest-first) and `openPositionRecords` (open-only holdings, endDate normalization) for the wallet-profile detail.
- `web/lib/walletTrades.test.ts` — `groupWalletTrades`, the read-time collapse of raw fills into per-position groups (volume-weighted avg entry/exit, null exit when still held).

"Verifying a change" now means `pnpm typecheck`, `pnpm build`, and the unit tests all pass — and for the full pipeline, running `pnpm ingest` against a real Supabase + the live Polymarket API.

Apply the DB schema with `supabase db push`, or paste `supabase/migrations/001_initial_schema.sql` into the Supabase SQL editor.

## Architecture and data flow

The system is a **batch-compute-then-serve** design. The web app never calls Polymarket and never computes metrics; it only reads pre-computed rows.

Ingestion (`scripts/ingest.ts` `main()`):
1. `discoverTopWallets()` (`polymarket.ts`) seeds wallets from Polymarket's `/v1/leaderboard`, falling back to `/trades` if that fails.
2. For each wallet (processed by a worker pool, `WALLET_CONCURRENCY` in flight at a time): fetch `/activity` → `isSuspectedBot()`; fetch `/closed-positions` → `computeMetrics()` for each horizon in `CONFIG.HORIZONS` (30/90 days). The max horizon also bounds how far back `getClosedPositions` paginates, so it drives ingest API cost. The web app's `HORIZONS` (`web/lib/types.ts`) matches: only 30 and 90 are exposed. (The 365-day horizon was removed end-to-end; the schema's `horizon_days IN (30, 90, 365)` CHECK constraints still permit 365 but nothing writes it.)
3. Upsert into `wallet_stats` and `equity_curve`.
4. `rebuildLeaderboardCache()` re-derives `leaderboard_cache`: orders by `skill_score`, **excludes bot-suspected wallets**, keeps top `TOP_N`.

Web read path: `web/lib/supabase.ts` (`getLeaderboard`, `getWalletProfile`) is the only DB access layer. Pages (`web/app/page.tsx`, `web/app/wallet/[address]/page.tsx`) and API routes (`web/app/api/**`) call it. Leaderboard reads come straight from `leaderboard_cache`; wallet profiles join `wallet_stats` + `equity_curve` + `leaderboard_cache` (for rank badges).

### Scoring lives in two files
- `scripts/config.ts` — the **single source of truth** for every tunable threshold (horizons, min trades/volume, skill-score knobs `EDGE_SHRINKAGE_K`/`EDGE_FOR_TEN`/`SCORE_FLOOR`/`SCORE_MAX`, eligibility gates, bot heuristics, API pagination/retry). Change tuning here, not inline.
- `scripts/metrics.ts` — `computeMetrics` (per-horizon realized PnL, % return, win rate, forecasting edge, daily equity curve) and `computeSkillScore` (the Bayesian-shrunk edge score: 0 for zero/negative edge, else `[SCORE_FLOOR, SCORE_MAX]`; `null` for ineligible wallets: too few trades, too little volume, sub-cent longshot, or one win dominating PnL).

Bot detection (`scripts/botDetection.ts`): flags wallets exceeding trades/day, simultaneous-market, or min-avg-trade-size limits.

## Critical conventions and gotchas

- **The Supabase `Database` type is hand-maintained and duplicated.** It appears inline in `scripts/ingest.ts`, again in `web/lib/types.ts`, and must match `supabase/migrations/001_initial_schema.sql`. There is no codegen — if you change the schema, update all three by hand or things drift silently.
- **`scripts/` is ESM (`NodeNext`) and imports use `.js` extensions** (e.g. `import { CONFIG } from "./config.js"` resolves to `config.ts`). Keep the `.js` suffix on relative imports there or `tsx`/`tsc` will fail. `web/` uses Bundler resolution and the `@/*` path alias — do not mix the styles.
- **Two TypeScript configs with different rules.** Both enable `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`, so optional props and indexed access need care.
- **Env vars** (copy `.env.example` → `.env.local`; root `.env.example` covers scripts, `web/.env.example` covers the web app):
  - web (browser-safe): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
  - scripts (writes): also needs `SUPABASE_SERVICE_ROLE_KEY`; optional `POLYMARKET_API_BASE`. `ingest.ts` loads `../.env.local` then a local `.env.local`.
  - Keep the **service-role key out of the web app** — the read path uses the anon key only.
- Polymarket's API field names are inconsistent, so `polymarket.ts` maps responses defensively via `readString`/`readNumber` with fallback key lists. When the API shape shifts, extend those key arrays rather than assuming one field name.
- Addresses are normalized to lowercase everywhere (ingestion, API routes, lib). Preserve this when adding lookups.
- **Polymarket rate limits** ([docs](https://docs.polymarket.com/api-reference/rate-limits)). We only hit the Data API (`data-api.polymarket.com`), enforced by Cloudflare over sliding 10s windows (requests are queued, not hard-rejected). Per-endpoint limits for the endpoints we call:
  - `/closed-positions`, `/positions` — **150 req / 10s** (the binding constraint)
  - `/trades` — **200 req / 10s**
  - `/activity`, `/value`, `/v1/leaderboard` — fall under the general Data API limit of **1,000 req / 10s**

  `polymarket.ts` runs **one serial rate gate per lane** (`throttle(lane)`), keyed by `CONFIG.REQUEST_INTERVAL_MS`: the `restricted` lane (`/closed-positions`, `/positions`) and the `general` lane (everything else). Spacing them separately lets cheap general calls run in parallel with the expensive closed-position pagination. Intervals target ~75% of each cap: restricted 90ms (~111 req/10s, under 150), general 30ms (~333 req/10s, under the ≥200 budget). When tuning an interval down, keep that lane under its cap — `restricted` must stay ≥67ms (150/10s) and `general` ≥50ms (200/10s for `/trades`). `fetchJson` also honors the `Retry-After` header on a throttled response before exponential backoff.
