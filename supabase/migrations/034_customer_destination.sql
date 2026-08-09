-- Store each customer's shipping destination (kota/kecamatan/kode_pos) on the
-- customers row.
--
-- Why: ongkir is now per-warehouse (migration 032), resolved by matching the
-- customer's destination against each warehouse origin's JNE rate set. The
-- destination was previously only used transiently at registration and thrown
-- away, so when a NEW warehouse is added there was no way to backfill existing
-- customers' rates. Persisting the destination makes every future warehouse a
-- trivial re-lookup: lookupOngkir(<new origin>, kota, kecamatan).
--
-- kota holds the kabupaten/kota name (matches jne_rates.kab_kota_nama and the
-- registration form's `kota` field). All default '' so existing rows are valid;
-- a one-off backfill (scripts/backfill-customer-destination.ts) fills them from
-- the registration-response export.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS kota      TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS kecamatan TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS kode_pos  TEXT NOT NULL DEFAULT '';
