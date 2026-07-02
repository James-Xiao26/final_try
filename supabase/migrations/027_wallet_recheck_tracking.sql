-- Supports the main-discovery-loop tiered recheck cooldown (scripts/walletRecheck.ts): why a wallet
-- is ineligible (not just that it is) and when its own trading history actually started, so a future
-- full ingest can decide how long to skip re-fetching it without needing fresh /activity data to find
-- out. wallets.updated_at (existing, trigger-maintained) already covers the bot-cooldown clock.
ALTER TABLE wallet_stats ADD COLUMN ineligible_reason TEXT;
ALTER TABLE wallets ADD COLUMN earliest_trade_at TIMESTAMPTZ;
