-- Forward alpha: add a PAYOUT-weighted smart-money price alongside the existing dollar/sqrt/v1 columns.
--
-- Weight by payout-if-it-wins = shares * $1 = size, which removes the entry price from the weight. Cost
-- (size * avg_price) over-weights high-price favorites: N shares of an 80c favorite cost 4x N shares of
-- a 20c longshot despite identical payout/conviction, so dollar-weighting hands the favorite 4x the say.
-- smart_payout tests whether share-count weighting predicts better. Nullable, like entry_dispersion (029):
-- rows recorded before this column existed stay NULL and the scorecard filters them from the payout slice.
ALTER TABLE forward_alpha_predictions ADD COLUMN smart_payout NUMERIC;
