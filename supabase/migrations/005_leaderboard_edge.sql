-- The leaderboard now shows forecasting edge instead of % return. Denormalize the per-position
-- mean edge into leaderboard_cache (mirroring wallet_stats.avg_edge_per_share) so the leaderboard
-- stays a single fast read. Nullable; backfilled by the next rebuildLeaderboardCache on ingest.
ALTER TABLE leaderboard_cache ADD COLUMN avg_edge_per_share NUMERIC(8,4);
