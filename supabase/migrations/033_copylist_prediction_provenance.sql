-- 033_copylist_prediction_provenance.sql
--
-- Three honesty columns for the copylist forward test (copylist_predictions, migration 032):
--
--   copy_price  numeric — the CURRENT market price of the bet's outcome at record time. entry_price is
--                the elite wallets' own fill price; by the time the list surfaces a bet the market has
--                often moved toward it, so scoring at entry_price flatters the copier. copy_price is
--                what a follower actually pays — the scorecard's headline uses it when present.
--   source      text    — which tool surfaced the bet: 'board' (copylistForward's board-elite recorder)
--                or 'scout' (sportsScout's discovered-wallet picks, i.e. what `pnpm copylist` shows and
--                what real bets are placed from). Lets the scorecard judge each signal separately.
--   edge_rank   int     — 1-based position in that run's edge-ranked list at record time. Pre-registers
--                the "take the top rows" policy so it can be scored without post-hoc slicing (a fixed
--                edge threshold chosen by scanning resolved outcomes would be overfitting).
--
-- All nullable/defaulted so rows recorded by older code keep working.
alter table copylist_predictions add column if not exists copy_price numeric;
alter table copylist_predictions add column if not exists source text not null default 'board';
alter table copylist_predictions add column if not exists edge_rank int;
