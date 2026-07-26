-- Flat Fee: a fourth pricing method. Base cost plus ONE fee, the same for every
-- product using it.
--
--   price = cost + flat_fee          (flat_fee from product_defaults)
--
-- It is Tier Rp with the brackets removed. That sounds redundant until you look at
-- where the fee comes from: Tier Rp's fee lives on the product and is typed in (the
-- brackets only pre-fill it), so two products with the same cost can carry different
-- fees. Flat Fee's fee lives in Settings and is resolved server-side on save, so
-- every Flat Fee product is priced from the same number by construction, and
-- changing that number reprices them all on their next save.
--
-- That makes it the second authoritative method, alongside Tier Kurs (migration
-- 050) and unlike Tier Rp (051).

-- ─── 1. The fee ────────────────────────────────────────────────────────────
--
-- product_defaults, next to tier_kurs_round_to, which is the other column in that
-- table read at price-computation time rather than merely pre-filled into a form.
-- 10.000 is the owner's chosen starting value, not a derived one; it is editable
-- from Settings → Pricing.

ALTER TABLE product_defaults
  ADD COLUMN IF NOT EXISTS flat_fee INTEGER NOT NULL DEFAULT 10000;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_defaults_flat_fee_check'
  ) THEN
    -- 0 is allowed: it prices at cost, which is visible in the profit readout and
    -- self-corrects once a fee is set. Negative is not.
    ALTER TABLE product_defaults ADD CONSTRAINT product_defaults_flat_fee_check
      CHECK (flat_fee >= 0);
  END IF;
END
$$;

-- ─── 2. Admit the new method ───────────────────────────────────────────────
--
-- Migration 050 constrained pricing_method to three values. Postgres has no
-- ALTER CONSTRAINT for a CHECK, so drop and recreate.

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_pricing_method_check;
ALTER TABLE products ADD CONSTRAINT products_pricing_method_check
  CHECK (pricing_method IN ('overseas', 'domestic', 'tier_kurs', 'flat_fee'));

-- ─── 3. No new product column ──────────────────────────────────────────────
--
-- The fee applied is snapshotted onto products.profit_fixed, the column Tier Rp
-- already uses for the same purpose, so the two share one stored shape and one
-- formula (calcDomesticPrice in lib/pricing.ts). The difference is entirely in WHO
-- writes it: the user for domestic, the server for flat_fee.
--
-- Storing rather than deriving it at read time also means the products table shows
-- the fee each row was actually priced with, which is the only way to see that a
-- row predates a fee change.

-- No product is moved onto the new method and no stored value is touched, so this
-- migration cannot change a single price.
