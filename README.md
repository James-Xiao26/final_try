# EdgeBoard

EdgeBoard is a public Polymarket skill leaderboard that ranks traders by risk-adjusted realized performance instead of raw PnL, luck, or volume. The monorepo includes a Next.js 14 App Router frontend, a strict TypeScript ingestion pipeline for Polymarket's public Data API, and a Supabase schema for wallet metadata, computed stats, daily equity curves, and cached leaderboard ranks.

## Prerequisites

- Node.js 20+
- pnpm 9+
- A Supabase project
- Supabase CLI if you want to apply migrations locally with `supabase db push`

## Setup

```bash
pnpm install
cp .env.example .env.local
```

Fill in the Supabase values in `.env.local`. The web app uses the public anon key. The ingestion script requires the service role key because it writes computed leaderboard data.

Apply the database schema:

```bash
supabase db push
```

You can also paste `supabase/migrations/001_initial_schema.sql` into the Supabase SQL editor.

Seed and compute leaderboard data:

```bash
cd scripts
pnpm run ingest
```

Run the frontend:

```bash
cd web
pnpm dev
```

Open `http://localhost:3000`.

## Skill Score Tuning

All ingestion and scoring constants live in `scripts/config.ts`. Tune horizons, minimum trades, minimum volume, outlier handling, bot heuristics, and Skill Score weights there. The scoring pipeline imports these values instead of scattering thresholds across the codebase.

## Adding More Wallets

The default seed list comes from Polymarket's public `/v1/leaderboard` endpoint, paginated up to `CONFIG.SEED_WALLET_COUNT`. To expand discovery, raise `SEED_WALLET_COUNT` or extend `discoverTopWallets()` in `scripts/polymarket.ts` to merge more sources such as high-volume `/trades` pages, curated wallet files, or external verified trader lists.
