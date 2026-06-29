-- Trade history showed a bare "Yes/No" derived from outcome_index and a market title that, for some
-- grouped sports markets (e.g. CS2 "Games Total: O/U 2.5"), omits the event and the real side. Store
-- Polymarket's actual outcome label ("Over"/"Under"/team/"Yes"/"No") and the event slug so the
-- wallet-profile trade history can show which event it is and which side the wallet took.
alter table wallet_trades            add column if not exists outcome_label text;
alter table wallet_trades            add column if not exists event_slug    text;
alter table wallet_closed_positions  add column if not exists outcome_label text;
alter table wallet_closed_positions  add column if not exists event_slug    text;
