-- Promote the customer's full name from the data_diri free-text blob into a
-- first-class column. The registration form already collects nama_depan +
-- nama_belakang; we used to throw them away after composing data_diri.
--
-- Going forward registerCustomer writes this column directly; this migration
-- backfills existing rows by parsing data_diri:
--   1. If a line matches "Nama: X" (legacy labeled format), take X.
--   2. Otherwise fall back to the first non-empty line.
-- Rows with empty data_diri stay with an empty name (admin can edit later).

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';

-- WHERE name = '' makes the backfill itself idempotent: rows that already have
-- a name (because this migration was partially applied before, or because the
-- registration endpoint already wrote one) are skipped.
UPDATE customers
SET name = TRIM(COALESCE(
  -- Prefer the legacy labeled form "Nama: X"
  (regexp_match(data_diri, '^Nama:\s*(.+)$', 'm'))[1],
  -- Otherwise first non-empty line
  split_part(data_diri, E'\n', 1)
))
WHERE name = '' AND data_diri <> '';
