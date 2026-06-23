-- idx_mph_asset is (asset, ts) — identical to the (asset, ts) PRIMARY KEY index, so it's
-- 100% redundant: every lookup it could serve is already served by the PK's unique index.
-- It only cost ~280k duplicated index entries + a write on every price-history insert. Drop it.
DROP INDEX IF EXISTS idx_mph_asset;
