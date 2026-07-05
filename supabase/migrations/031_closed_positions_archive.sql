-- 031_closed_positions_archive.sql
--
-- Append-only archive of leaderboard wallets' resolved closed positions.
--
-- wallet_closed_positions is a rolling ~90-day wipe-and-replace cache (its pagination is bounded by the
-- max scoring horizon), so any history older than 90 days is permanently discarded on the next full
-- ingest. That blocks the one test the alpha research actually needs — cross-theme persistence: whether
-- a wallet with edge on theme A (e.g. the spring-2026 Iran cluster) also beats the market on unrelated
-- themes. Right now almost every wallet's in-window history IS that one theme, so the question can't be
-- asked (see ALPHA_RESEARCH_LOG.md §5.5/§7).
--
-- This table never prunes. The daily full ingest upserts each board wallet's closed positions here with
-- ignoreDuplicates (first-seen wins, since a resolved position is immutable), so distinct market themes
-- accumulate over months. Unlike wallet_closed_positions it also stores `outcome` (the resolved 0/1),
-- which the edge/persistence analysis needs. Read only by ad-hoc research scripts (crossThemePersistence,
-- backtests) — NEVER by the web app, so it doesn't touch the per-request egress budget.
create table if not exists closed_positions_archive (
  address text not null,
  condition_id text not null,
  outcome_index int not null,
  close_time timestamptz not null,
  market text,
  avg_price numeric,
  realized_pnl numeric,
  size numeric,
  outcome int,
  event_slug text,
  first_seen_at timestamptz not null default now(),
  primary key (address, condition_id, outcome_index, close_time)
);

create index if not exists idx_cpa_address on closed_positions_archive (address);
