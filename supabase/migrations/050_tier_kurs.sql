-- Tier Kurs: a third product pricing method, where the exchange rate CHARGED to
-- the customer varies by how large the product's foreign-currency cost (valas) is.
-- Brackets are configured per country in Settings.
--
--   CNY, actual rate 2700         valas 500
--     valas     0 – 1000  → 3000    price = ceil5000(500 × 3000) = 1.500.000
--     valas  1001 – 20000 → 2700    cost  =           500 × 2700 = 1.350.000
--     valas 20001 and up  → 2600    profit =                        150.000
--
-- The margin is baked into an inflated rate rather than added as a percentage, so
-- this method has no profit_pct, no cargo and no fees — just the tiered rate and a
-- rounding step. See calcTierKursPrice() in lib/pricing.ts.
--
-- countries.kurs KEEPS its meaning as the ACTUAL rate, and so does products.kurs:
-- lib/db/dispatch.ts and lib/db/fulfillment.ts price cargo and dispatch-document
-- lines in foreign currency from products.valas/products.kurs, and that must not
-- change. Cost is therefore booked at `kurs` and the price at `tiered_kurs`, which
-- makes the profit readout exactly the FX spread.
--
-- NOTE ON NUMBERING: the unmerged `pricing-templates` branch also has a 050
-- (050_invoice_reader_product_columns.sql). If that branch is ever merged, one of
-- the two needs renumbering — they are unrelated changes that happened to be next
-- in line.

-- ─── 1. Per-country brackets ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS country_kurs_tiers (
  id         SERIAL PRIMARY KEY,
  country_id INTEGER NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
  -- INCLUSIVE lower bound, and the HIGHEST matching minimum wins, so the order of
  -- the rows never affects the result. A "1001 and up" bracket is min_valas 1001 —
  -- note valas is NUMERIC(12,2), so a valas of 1000.50 still falls in the band
  -- below it. Enter 1000.01 if that is what you meant.
  min_valas  NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- The rate charged. Same precision as countries.kurs (see migration 025).
  kurs       NUMERIC(12,4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  CONSTRAINT country_kurs_tiers_min_valas_nonneg CHECK (min_valas >= 0),
  CONSTRAINT country_kurs_tiers_kurs_positive    CHECK (kurs > 0),
  -- Two brackets with the same floor are ambiguous. This also provides the
  -- (country_id, min_valas) index the lookup needs, so no separate CREATE INDEX.
  UNIQUE (country_id, min_valas)
);

-- ─── 2. The pricing-method discriminator ───────────────────────────────────
--
-- Until now the formula was implied by `country_id IS NULL`: overseas rows used
-- valas/kurs/cargo/margin/fees, domestic rows used cost + profit_fixed. Tier Kurs
-- breaks that, because a Tier Kurs product HAS a country (it needs the FX link for
-- valas and the actual rate) but must not use the overseas formula.
--
-- So the formula discriminator moves to its own column. `country_id` keeps its
-- other job — supplying the currency and the actual rate — unchanged.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS pricing_method TEXT;

-- Backfill preserves exactly today's behaviour, so no stored price changes.
UPDATE products
   SET pricing_method = CASE WHEN country_id IS NULL THEN 'domestic' ELSE 'overseas' END
 WHERE pricing_method IS NULL;

-- Only after the backfill, or NOT NULL would fail on the existing 2,800+ rows.
-- Guarded so re-running the migration is safe.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'products' AND column_name = 'pricing_method'
       AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE products ALTER COLUMN pricing_method SET NOT NULL;
    ALTER TABLE products ALTER COLUMN pricing_method SET DEFAULT 'overseas';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_pricing_method_check'
  ) THEN
    ALTER TABLE products ADD CONSTRAINT products_pricing_method_check
      CHECK (pricing_method IN ('overseas', 'domestic', 'tier_kurs'));
  END IF;
END
$$;

-- The products list filters and sorts on the method, and it is read on every page
-- of the catalogue.
CREATE INDEX IF NOT EXISTS idx_products_pricing_method ON products (pricing_method);

-- ─── 3. The snapshotted tiered rate ────────────────────────────────────────
--
-- The rate a Tier Kurs product was actually priced with, captured at save time
-- exactly like products.kurs. NULLABLE with no default: NULL means "this row is
-- not priced on a tiered rate", which a 0 could not distinguish.
--
-- No GRANT is needed. Migration 019's ALTER DEFAULT PRIVILEGES covers the new
-- table and its sequence for app_runtime, and a table-level grant already covers
-- new columns. invoice_reader's products grant (migration 018) is table-level on
-- this branch, so it WOULD see these columns — but the public invoice query
-- (getPublicInvoiceForCustomer in lib/db/invoice.ts) selects only name and gram,
-- so nothing is exposed. The narrowing to explicit columns lives on the
-- `pricing-templates` branch.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS tiered_kurs NUMERIC(12,4);

-- ─── 4. The adjustable rounding step ───────────────────────────────────────
--
-- 5,000 matches how the catalogue is actually priced: of the overseas products,
-- 2,761 of 2,779 reproduce exactly at 5,000, and 1,272 of them sit more than 2,500
-- below their stored price, which rules out a 2,500 rule outright. (lib/pricing.ts
-- rounds the OVERSEAS formula to 1,000 and has always disagreed with the data;
-- that is left alone here — changing it would reprice the catalogue.)
--
-- It lives in product_defaults, next to the other pricing settings, so the owner
-- can change the step from Settings without a code change. Unlike the rest of
-- product_defaults this is NOT merely a form pre-fill: it is read at price
-- computation time, so changing it reprices Tier Kurs products on their next save.
ALTER TABLE product_defaults
  ADD COLUMN IF NOT EXISTS tier_kurs_round_to INTEGER NOT NULL DEFAULT 5000;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_defaults_tier_kurs_round_to_check'
  ) THEN
    ALTER TABLE product_defaults ADD CONSTRAINT product_defaults_tier_kurs_round_to_check
      CHECK (tier_kurs_round_to >= 1);
  END IF;
END
$$;

-- No brackets are seeded, and no product is moved onto the new method, so this
-- migration cannot change a single stored price.
--
-- The example figures above (3000/2700/2600 against an actual 2500) are the
-- owner's illustration, not production data — countries.kurs for CN is 2700 — so
-- seeding them would ship real, wrong pricing config. A country with no brackets
-- falls back to its flat kurs, which prices a Tier Kurs product at valas × kurs
-- with a zero spread: safe, visible (the profit readout reads 0), and
-- self-correcting once brackets are entered in Settings.

-- ─── 5. Audit ──────────────────────────────────────────────────────────────
-- Same drop-then-create idiom as the table loop in 029_audit_log.sql. products
-- and product_defaults already have row-level audit triggers, and a new column
-- needs no re-registration.

DROP TRIGGER IF EXISTS audit_country_kurs_tiers ON country_kurs_tiers;
CREATE TRIGGER audit_country_kurs_tiers
  AFTER INSERT OR UPDATE OR DELETE ON country_kurs_tiers
  FOR EACH ROW EXECUTE FUNCTION audit.log_change();
