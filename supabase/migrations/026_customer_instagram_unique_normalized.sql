-- Enforce case-insensitive uniqueness on customer handles.
--
-- The base column constraint `UNIQUE(instagram_id)` is byte-exact, so
-- "@User", "user", and "USER" are three distinct values. The dashboard's
-- addCustomer write path used to insert handles as typed; the order path
-- normalizes (lowercase, no '@') before its own ON CONFLICT insert. Result:
-- "testFandri" entered via the dashboard and "testfandri" entered via the
-- order auto-create flow co-existed as two rows, and orders attached to the
-- wrong row.
--
-- Adding a UNIQUE INDEX on the normalized expression makes the DB itself
-- reject any future write that would create a case-variant duplicate, so
-- even if a code path forgets to normalize, the bug surfaces immediately
-- instead of silently splitting one customer into two.
--
-- The existing `idx_customers_instagram_normalized` is a plain (non-unique)
-- lookup index, so we replace it with this unique one. Idempotent: drops
-- the old index if present and creates the new one only if absent.

DROP INDEX IF EXISTS idx_customers_instagram_normalized;

CREATE UNIQUE INDEX IF NOT EXISTS customers_instagram_normalized_uniq
  ON customers (lower(replace(instagram_id, '@', '')));
