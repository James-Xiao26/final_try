-- Max drawdown removed from the metric set and Skill Score. Drop the columns so the schema matches
-- the (hand-maintained) Database types, which no longer carry max_drawdown. Destructive: the stored
-- drawdown values are discarded, which is intended — the metric is no longer computed or served.
ALTER TABLE wallet_stats DROP COLUMN IF EXISTS max_drawdown;
ALTER TABLE leaderboard_cache DROP COLUMN IF EXISTS max_drawdown;
