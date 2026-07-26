-- Tier Fee: rename the domestic method, and let it price in foreign currency too.
--
-- The method formerly labelled "Tier Rp" priced only in rupiah: cost + a fee looked
-- up from cost brackets. It becomes "Tier Fee" and gains a second mode where the
-- base cost is a valas amount, the fee is ALSO a valas amount, and the sum is
-- converted at the country's rate:
--
--   Rupiah mode   price = cost + fee                       (exact, unchanged)
--   Valas mode    price = ceil5000((valas + feeValas) × kurs)
--
-- The fee is added BEFORE the conversion, deliberately: that is what makes the
-- bracket figures readable in the currency the buying actually happens in. It is
-- also why the fee brackets have to be per country — a fee of 20 is a fifth of a
-- 100 CNY item and a rounding error on a 100 JPY one.
--
-- ─── The mode discriminator ─────────────────────────────────────────────────
--
-- `country_id IS NULL` distinguishes the two modes, and no new column is needed.
--
-- That looks like a step back towards what migration 050 removed, so to be precise
-- about the difference: 050 stopped country_id choosing the FORMULA, because a Tier
-- Kurs product has a country yet must not use the overseas formula. pricing_method
-- still does that job here. Within tier_fee, country_id keeps exactly the role 050
-- left it — "which currency and which rate" — and having no country means "rupiah,
-- no conversion". A Tier Fee row cannot be ambiguous: either it has a currency to
-- convert from or it does not.
--
-- Consequence worth stating: every one of the 43 existing rows has country_id NULL,
-- so they all land in rupiah mode, which is the behaviour they already had. This
-- migration cannot change a stored price.

-- ─── 1. Rename the method value ────────────────────────────────────────────

-- Drop BEFORE the update, not after: the constraint from migration 052 does not
-- list 'tier_fee', so updating first fails on its own rows.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_pricing_method_check;

UPDATE products SET pricing_method = 'tier_fee' WHERE pricing_method = 'domestic';

ALTER TABLE products ADD CONSTRAINT products_pricing_method_check
  CHECK (pricing_method IN ('overseas', 'tier_fee', 'flat_fee', 'tier_kurs'));

-- ─── 2. Rename the brackets table and scope it by country ──────────────────
--
-- Renamed rather than left alone: "domestic" is no longer a thing this app has, and
-- the table now holds valas brackets too. Migration 051 created it days ago and it
-- has never been deployed, so nothing outside this repo refers to the old name.

ALTER TABLE IF EXISTS domestic_profit_tiers RENAME TO tier_fee_brackets;

DO $$
BEGIN
  -- Constraint names do not follow a RENAME TABLE, so bring them along too.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'domestic_profit_tiers_pkey') THEN
    ALTER TABLE tier_fee_brackets RENAME CONSTRAINT domestic_profit_tiers_pkey
      TO tier_fee_brackets_pkey;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'domestic_profit_tiers_min_cost_nonneg') THEN
    ALTER TABLE tier_fee_brackets RENAME CONSTRAINT domestic_profit_tiers_min_cost_nonneg
      TO tier_fee_brackets_min_base_nonneg;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'domestic_profit_tiers_value_nonneg') THEN
    ALTER TABLE tier_fee_brackets RENAME CONSTRAINT domestic_profit_tiers_value_nonneg
      TO tier_fee_brackets_fee_value_nonneg;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'domestic_profit_tiers_mode_check') THEN
    ALTER TABLE tier_fee_brackets RENAME CONSTRAINT domestic_profit_tiers_mode_check
      TO tier_fee_brackets_fee_mode_check;
  END IF;
END
$$;

-- min_cost held a rupiah cost; it now holds whichever base amount the row's scope
-- uses — rupiah cost for the NULL-country set, valas for a country's set. Renamed so
-- nobody reads "cost" and assumes rupiah. profit_* likewise: the value is a fee, and
-- for a percent row it is a percentage of the base.
ALTER TABLE tier_fee_brackets RENAME COLUMN min_cost     TO min_base;
ALTER TABLE tier_fee_brackets RENAME COLUMN profit_mode  TO fee_mode;
ALTER TABLE tier_fee_brackets RENAME COLUMN profit_value TO fee_value;

-- min_base is NUMERIC now, not INTEGER: a valas floor can be fractional, where a
-- rupiah one cannot. Widening keeps every existing row valid.
ALTER TABLE tier_fee_brackets ALTER COLUMN min_base TYPE NUMERIC(14,2);

-- NULL = the rupiah set. CASCADE because a country's brackets are meaningless
-- without it, matching country_kurs_tiers.
ALTER TABLE tier_fee_brackets
  ADD COLUMN IF NOT EXISTS country_id INTEGER REFERENCES countries(id) ON DELETE CASCADE;

-- Two brackets with the same floor in the same scope are ambiguous.
--
-- NULLS NOT DISTINCT is load-bearing: by default Postgres treats every NULL as
-- distinct, so a plain UNIQUE (country_id, min_base) would happily allow two rupiah
-- brackets both starting at 0 — the one case that most needs preventing. Requires
-- Postgres 15+; this project runs 17.
ALTER TABLE tier_fee_brackets DROP CONSTRAINT IF EXISTS domestic_profit_tiers_min_cost_key;
ALTER TABLE tier_fee_brackets DROP CONSTRAINT IF EXISTS tier_fee_brackets_scope_base_key;
ALTER TABLE tier_fee_brackets ADD CONSTRAINT tier_fee_brackets_scope_base_key
  UNIQUE NULLS NOT DISTINCT (country_id, min_base);

-- ─── 3. The valas fee snapshot ─────────────────────────────────────────────
--
-- The fee a valas-mode row was actually priced with, in valas, captured at save time
-- exactly like products.kurs and products.tiered_kurs. NULL means "not priced on a
-- valas fee", which a 0 could not distinguish.
--
-- Kept separate from profit_fixed rather than converted into it: each row then
-- carries exactly one fee number, in its own unit — profit_fixed in rupiah for
-- rupiah mode, fee_valas in foreign currency for valas mode. Storing both would mean
-- storing the same fact twice at different precisions, which is how they drift.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS fee_valas NUMERIC(12,2);

-- ─── 4. Rounding ───────────────────────────────────────────────────────────
--
-- Valas mode reuses product_defaults.tier_kurs_round_to (migration 050) rather than
-- adding a second step, because both methods round for the same reason: a kurs
-- multiply produces figures the catalogue has never used. The column keeps its name
-- — renaming it would churn more code than the clarity is worth — but it is now the
-- shared price rounding step for tier_kurs AND valas-mode tier_fee, and the Settings
-- label says so.
--
-- Rupiah mode is NOT rounded. It has no conversion to produce awkward numbers, and
-- rounding it would reprice the 43 existing rows.

-- ─── 5. Audit ──────────────────────────────────────────────────────────────
-- The trigger followed the table through the RENAME, but its name still says
-- domestic. Recreate it under the new name; drop-then-create as in 029_audit_log.sql.

DROP TRIGGER IF EXISTS audit_domestic_profit_tiers ON tier_fee_brackets;
DROP TRIGGER IF EXISTS audit_tier_fee_brackets ON tier_fee_brackets;
CREATE TRIGGER audit_tier_fee_brackets
  AFTER INSERT OR UPDATE OR DELETE ON tier_fee_brackets
  FOR EACH ROW EXECUTE FUNCTION audit.log_change();
