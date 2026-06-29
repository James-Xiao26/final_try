-- The chip feature broadened from PnL-only to PnL + Volume boards, with the rank stored per board
-- (entries are "code:rank", e.g. "pnl-all:3", "vol-month:241"). Rename the column accordingly. The
-- column is still empty (added in 024, populated only by a full ingest), so this rename is safe.
alter table wallets rename column pnl_boards to leaderboard_chips;
