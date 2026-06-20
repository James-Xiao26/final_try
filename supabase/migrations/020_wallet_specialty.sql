-- The market category a wallet is demonstrably best at — its "specialty" — derived during ingest by
-- slicing the wallet's resolved-position forecasting edge per category (scripts/specialty.ts) and
-- keeping the strongest category that clears a sample + positive-edge floor. Nullable: most wallets
-- have no standout specialty (the leaderboard shows a chip only when this is set). Stored on `wallets`
-- (one row per wallet, horizon-independent) so the leaderboard read piggybacks on its existing handle
-- join — no leaderboard_cache column and no extra query. Recomputed on every full ingest / rescore.
ALTER TABLE wallets ADD COLUMN specialty TEXT;
