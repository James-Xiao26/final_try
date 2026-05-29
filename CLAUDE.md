# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

EdgeBoard ranks Polymarket traders by a risk-adjusted "Skill Score" (return, win rate, drawdown, sample size, outlier discipline) rather than raw PnL. A pnpm monorepo with two workspaces:

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

pnpm --filter edgeboard-scripts test   # run the unit tests (from repo root)
```

**Unit tests** live in the `scripts/` workspace and run on Node's built-in test runner via tsx (`node --import tsx --test "**/*.test.ts"`, wired up as the `test` script in `scripts/package.json` — there is no root-level `test` script, so run it with `pnpm --filter edgeboard-scripts test` or `pnpm test` from inside `scripts/`). No jest/vitest. Current coverage:

- `scripts/metrics.test.ts` — pure-function tests for scoring:
  - `computeMetrics` derives `pctReturn`, `winRate`, `maxDrawdown`, `nTrades`, and volume from the realized PnL path; excludes positions older than the horizon; and handles an empty position set without dividing by zero.
  - `computeSkillScore` returns `null` for ineligible wallets (below `MIN_TRADES`, below `MIN_VOLUME_USD`, or `outlierFlag` set), applies the sqrt sample-size confidence ramp with a 0.6 floor at `MIN_TRADES`, saturates confidence at `MIN_TRADES * 3`, and penalizes drawdown beyond the threshold. Expected scores are asserted as exact constants/approximations, so changing any weight or the ramp in `config.ts`/`metrics.ts` will require updating these.
- `scripts/botDetection.test.ts` — tests for the bot heuristics.

"Verifying a change" now means `pnpm typecheck`, `pnpm build`, and the unit tests all pass — and for the full pipeline, running `pnpm ingest` against a real Supabase + the live Polymarket API.

Apply the DB schema with `supabase db push`, or paste `supabase/migrations/001_initial_schema.sql` into the Supabase SQL editor.

## Architecture and data flow

The system is a **batch-compute-then-serve** design. The web app never calls Polymarket and never computes metrics; it only reads pre-computed rows.

Ingestion (`scripts/ingest.ts` `main()`):
1. `discoverTopWallets()` (`polymarket.ts`) seeds wallets from Polymarket's `/v1/leaderboard`, falling back to `/trades` if that fails.
2. For each wallet (batched, `WALLET_BATCH_SIZE` at a time): fetch `/activity` → `isSuspectedBot()`; fetch `/closed-positions` → `computeMetrics()` for each horizon in `CONFIG.HORIZONS` (30/90 days). The max horizon also bounds how far back `getClosedPositions` paginates, so it drives ingest API cost. The web app's `web/lib/types.ts` still lists 365 as a selectable horizon, but ingest no longer computes it — the 365D leaderboard view shows an "under maintenance" banner and serves stale rows.
3. Upsert into `wallet_stats` and `equity_curve`.
4. `rebuildLeaderboardCache()` re-derives `leaderboard_cache`: orders by `skill_score`, **excludes bot-suspected wallets**, keeps top `TOP_N`.

Web read path: `web/lib/supabase.ts` (`getLeaderboard`, `getWalletProfile`) is the only DB access layer. Pages (`web/app/page.tsx`, `web/app/wallet/[address]/page.tsx`) and API routes (`web/app/api/**`) call it. Leaderboard reads come straight from `leaderboard_cache`; wallet profiles join `wallet_stats` + `equity_curve` + `leaderboard_cache` (for rank badges).

### Scoring lives in two files
- `scripts/config.ts` — the **single source of truth** for every tunable threshold (horizons, min trades/volume, skill weights, drawdown penalty, bot heuristics, API pagination/retry). Change tuning here, not inline.
- `scripts/metrics.ts` — `computeMetrics` (per-horizon realized PnL, % return, win rate, max drawdown, daily equity curve) and `computeSkillScore` (returns `null` for ineligible wallets: too few trades, too little volume, or one win dominating PnL).

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
