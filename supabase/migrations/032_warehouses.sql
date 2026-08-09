-- Per-warehouse shipping cost (two shipping origins).
--
-- Yubisayu is opening a second warehouse in a different city. Shipping the same
-- package to the same customer costs differently depending on which warehouse it
-- ships from, so a single customers.ongkos_kirim (one rate per customer) is no
-- longer correct.
--
-- Model:
--   * warehouses                 — the shipping origins (seed: CIMAHI = current).
--   * events.warehouse_id        — each event is fulfilled from one warehouse
--                                  (routing is per-event; existing calcs already
--                                  group by event).
--   * customer_warehouse_ongkir  — the per-(customer, warehouse) rate. Becomes the
--                                  single source of truth for ongkir.
--   * jne_rates.origin_code      — origin dimension so the same destination can
--                                  hold a different price per warehouse, and the
--                                  registration auto-lookup can resolve a rate per
--                                  origin.
--
-- Existing data keeps today's numbers: everything is mapped to the seeded default
-- warehouse (CIMAHI). The legacy customers.ongkos_kirim column is left in place
-- (read paths move off it) and dropped in a later migration after verification.

-- ─── 1. warehouses ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warehouses (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,    -- also the jne_rates origin tag, e.g. 'CIMAHI'
  name        TEXT NOT NULL,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ
);

-- At most one default warehouse.
CREATE UNIQUE INDEX IF NOT EXISTS warehouses_one_default
  ON warehouses (is_default) WHERE is_default;

-- Seed the existing origin. ON CONFLICT keeps the migration idempotent.
INSERT INTO warehouses (code, name, is_default)
VALUES ('CIMAHI', 'Cimahi', TRUE)
ON CONFLICT (code) DO NOTHING;

-- The second warehouse is added once its code is known (it tags the second JNE
-- rate CSV). Uncomment and fill in, or insert out-of-band:
--   INSERT INTO warehouses (code, name) VALUES ('<WH2_CODE>', '<WH2 Name>')
--   ON CONFLICT (code) DO NOTHING;

-- ─── 2. events.warehouse_id ──────────────────────────────────────────────────
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE RESTRICT;

-- Backfill every existing event to the default warehouse, then enforce NOT NULL.
UPDATE events
SET warehouse_id = (SELECT id FROM warehouses WHERE is_default)
WHERE warehouse_id IS NULL;

ALTER TABLE events ALTER COLUMN warehouse_id SET NOT NULL;

-- ─── 3. customer_warehouse_ongkir ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_warehouse_ongkir (
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  warehouse_id  INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  ongkos_kirim  INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer_id, warehouse_id)
);

-- Backfill: every existing customer's current ongkos_kirim -> the default
-- warehouse. ON CONFLICT keeps it idempotent (re-running won't clobber edits).
INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
SELECT c.id, (SELECT id FROM warehouses WHERE is_default), c.ongkos_kirim
FROM customers c
ON CONFLICT (customer_id, warehouse_id) DO NOTHING;

-- ─── 4. jne_rates.origin_code ────────────────────────────────────────────────
-- final_price keeps its meaning (per-kg cost from one origin to one destination);
-- origin_code records WHICH origin. The DEFAULT stamps every existing row as the
-- current origin (CIMAHI) in one pass, then is dropped so future CSV imports must
-- state the origin explicitly.
ALTER TABLE jne_rates
  ADD COLUMN IF NOT EXISTS origin_code TEXT NOT NULL DEFAULT 'CIMAHI';
ALTER TABLE jne_rates ALTER COLUMN origin_code DROP DEFAULT;

-- Hard FK to warehouses.code: rejects rates imported under an unknown/misspelled
-- origin, and blocks deleting a warehouse that still has rates. ON UPDATE CASCADE
-- propagates a code rename. (warehouses.code is UNIQUE — required for this.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jne_rates_origin_fk'
  ) THEN
    ALTER TABLE jne_rates
      ADD CONSTRAINT jne_rates_origin_fk
      FOREIGN KEY (origin_code) REFERENCES warehouses(code) ON UPDATE CASCADE;
  END IF;
END
$$;

-- Rebuild the lookup index so origin leads. Non-unique: the source has benign
-- duplicate (city, district) pairs with identical prices and reads use LIMIT 1.
DROP INDEX IF EXISTS idx_jne_rates_lookup;
CREATE INDEX idx_jne_rates_lookup
  ON jne_rates (upper(origin_code), upper(kab_kota_nama), upper(kecamatan_nama));

-- ─── 5. invoice_reader grants ────────────────────────────────────────────────
-- The public, no-login invoice recap now resolves ongkir via the join table +
-- the event's warehouse instead of customers.ongkos_kirim. Grant the two new
-- tables (events is already fully granted, so its warehouse_id column is covered).
--
-- The recap query also bridges handle -> customer_warehouse_ongkir via
-- customers.id, so invoice_reader needs SELECT on that column too. Migration 018
-- only granted (instagram_id, ongkos_kirim); add id (NOT PII). The legacy
-- ongkos_kirim column grant stays until that column is dropped. app_runtime is
-- covered by 019's ALTER DEFAULT PRIVILEGES.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'invoice_reader') THEN
    GRANT SELECT ON warehouses, customer_warehouse_ongkir TO invoice_reader;
    GRANT SELECT (id) ON customers TO invoice_reader;
  END IF;
END
$$;

-- ─── 6. audit trigger for the new mutable table ──────────────────────────────
-- Mirror the loop in supabase/schema.sql so customer_warehouse_ongkir changes are
-- logged like every other mutable table. (warehouses is reference data edited
-- rarely; add it here too for completeness.)
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['warehouses', 'customer_warehouse_ongkir'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_%1$s ON %1$I', t);
    EXECUTE format(
      'CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I '
      'FOR EACH ROW EXECUTE FUNCTION audit.log_change()', t);
  END LOOP;
END
$$;
