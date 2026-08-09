-- JNE shipping-rate reference table.
--
-- Migrated out of the `Database_JNE` Google Sheet (the last Sheets dependency in
-- the registration flow). The public registration endpoint derives a customer's
-- `ongkos_kirim` by matching their destination on the (city, district) pair:
--   kab_kota_nama + kecamatan_nama -> final_price
-- kecamatan names repeat across cities, so the lookup MUST use both columns.
--
-- Reference data is re-importable from CSV via scripts/import-jne-rates.ts
-- (TRUNCATE + reload), so this table is not backed up / version-controlled.

CREATE TABLE IF NOT EXISTS jne_rates (
  id                   SERIAL PRIMARY KEY,
  provinsi_nama        TEXT NOT NULL,
  kab_kota_nama        TEXT NOT NULL,
  kecamatan_nama       TEXT NOT NULL,
  village_postal_codes TEXT NOT NULL DEFAULT '',
  reg_duration         TEXT NOT NULL DEFAULT '',  -- source col: bs_jne_reg_duration
  final_price          INTEGER NOT NULL DEFAULT 0  -- 0 = unserviced; admin fills later
);

-- Case-insensitive composite lookup (city + district). Plain index, NOT unique:
-- the source has a couple of benign duplicate pairs (identical price), so reads
-- use LIMIT 1.
CREATE INDEX IF NOT EXISTS idx_jne_rates_lookup
  ON jne_rates (upper(kab_kota_nama), upper(kecamatan_nama));

-- Read-only access for the runtime role (matches 019_app_runtime_role.sql).
-- ALTER DEFAULT PRIVILEGES already covers owner-created tables, but grant
-- explicitly so this is self-documenting and safe regardless of run order.
-- (Re-granting an already-granted privilege is a no-op.)
GRANT SELECT ON jne_rates TO app_runtime;
