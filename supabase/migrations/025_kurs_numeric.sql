-- Allow `kurs` to be a decimal exchange rate (e.g., 14.5824 IDR per KRW), not
-- just a whole-rupiah integer. Both `countries.kurs` (the per-country master
-- rate) and `products.kurs` (the rate snapshotted onto each product at
-- creation/edit time) move together — products copy from countries, so they
-- must accept the same precision.
--
-- NUMERIC(12, 4) supports up to 99,999,999.9999 — far above any plausible FX
-- rate but with 4 decimals of accuracy, matching Bank Indonesia's published
-- precision. Existing INTEGER values cast cleanly.
--
-- Idempotent: guards on the current column type so re-running this migration
-- against an already-migrated database is a no-op.

DO $$
BEGIN
  IF (
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'countries'
      AND column_name  = 'kurs'
  ) = 'integer' THEN
    ALTER TABLE countries
      ALTER COLUMN kurs TYPE NUMERIC(12, 4) USING kurs::numeric;
  END IF;

  IF (
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'products'
      AND column_name  = 'kurs'
  ) = 'integer' THEN
    ALTER TABLE products
      ALTER COLUMN kurs TYPE NUMERIC(12, 4) USING kurs::numeric;
  END IF;
END $$;
