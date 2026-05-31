-- Forecasting edge: measures how far a trader's entry price beat the market's eventual 0/1
-- resolution, over positions whose market has resolved (exit timing ignored). pct_edge is edge as
-- a return on the capital deployed in those positions; avg_edge_per_share is the share-weighted
-- (outcome - entryPrice), i.e. cents of edge per share; n_resolved is the resolved-position sample
-- size (drives the edge term's confidence ramp in the Skill Score).
--
-- pct_edge is unbounded above for low entry prices ((1 - p)/p), so it gets a wider precision than
-- the other ratio columns. All nullable: rows ingested before this migration won't have them until
-- the next ingest backfills.
ALTER TABLE wallet_stats ADD COLUMN pct_edge NUMERIC(12,4);
ALTER TABLE wallet_stats ADD COLUMN avg_edge_per_share NUMERIC(8,4);
ALTER TABLE wallet_stats ADD COLUMN n_resolved INTEGER;
