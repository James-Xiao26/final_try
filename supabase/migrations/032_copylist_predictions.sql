-- 032_copylist_predictions.sql
--
-- Survivorship-FREE forward test for the copylist signal (copy elite wallets' fresh entries), the
-- counterpart to the in-sample copy backtest. copyList.ts surfaces markets elite wallets just bought;
-- the in-sample backtest of that is rigged (elite = wallets picked because they already won). This table
-- locks a prediction the moment the copylist would surface a (market, side) — with the price you'd copy
-- at frozen at record time — and scores it only after the market resolves. As markets settle over the
-- coming weeks it becomes a bias-free track record of whether copying elite wallets actually makes money,
-- and whether multi-wallet agreement (participant_count) predicts, exactly like forward_alpha_predictions
-- does for the convergence signal.
--
-- One row per (condition_id, outcome_index) — a market SIDE, since the signal is "elite wallets bought
-- THIS side". First sighting wins (a locked prediction is never revised). Research-only, read by
-- copylistForward.ts; never touched by the web app, so no RLS / egress concern.
create table if not exists copylist_predictions (
  condition_id text not null,
  outcome_index int not null,
  market text,
  bet_label text,                 -- the exact side, e.g. "Mexico" / "Over" / "Yes"
  entry_price numeric not null,    -- copylist avg entry price at record (what you'd copy at)
  participant_count int not null,  -- distinct elite wallets on this side (the agreement signal)
  avg_elite_edge numeric,          -- mean historical per-share edge of those wallets
  end_date timestamptz,
  recorded_at timestamptz not null default now(),
  resolved_outcome int,            -- 1 if YES(index 0) won, 0 if NO(index 1) won; null = still open
  resolved_at timestamptz,
  primary key (condition_id, outcome_index)
);

create index if not exists idx_copylist_pred_unresolved on copylist_predictions (resolved_outcome) where resolved_outcome is null;
