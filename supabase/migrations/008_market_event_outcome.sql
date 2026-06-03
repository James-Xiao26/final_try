-- The Markets page now groups Polymarket's per-outcome markets into one row per *event* (sourced
-- from the Gamma /events endpoint). A multi-outcome event has no single price, so we surface the
-- leading (favorite) outcome: its implied probability is stored in the existing last_trade_price
-- column (the displayed "current price") and its label goes here.
ALTER TABLE markets ADD COLUMN top_outcome TEXT;
