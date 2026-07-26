-- Four pricing methods on one products table.
--
-- Until now the formula was implied by `country_id IS NULL`: a row with a country used
-- valas/kurs/cargo/margin/fees, a row without one used cost + a fixed fee. That is no
-- longer enough, because three of the four methods below can legitimately have a country
-- and must NOT all use the overseas formula. So the discriminator moves to its own column
-- and `country_id` keeps only its other job — supplying the currency, the rate and the
-- freight rate.
--
--   overseas   price = ceil1000( landedCost × 100/(100−profit%) + opFee + packFee )
--   tier_fee   "Markup". A bracket table maps a RUPIAH base cost to a fee.
--                no country   base cost is typed;  price = cost + fee     (fee suggested,
--                                                                         then typed)
--                a country    base cost is landed; price = ceil( cost + fee )
--   flat_fee   one fee from product_defaults, not per product.
--                fixed mode    fee = flat_fee
--                percent mode  fee = MAX( round(cost × flat_fee_pct / 100), flat_fee_min )
--   tier_kurs  the RATE CHARGED varies by valas; the margin is baked into the rate.
--                price = ceil( valas × tiered_kurs + packFee )
--
-- landedCost = valas × kurs + (gram / 1000) × cargo_per_kg, for every method that has a
-- country. The math lives in lib/pricing.ts; lib/pricing-server.ts is the authority for
-- everything a client must not be able to set.
--
-- countries.kurs and products.kurs KEEP their meaning as the ACTUAL rate. lib/db/dispatch.ts
-- and lib/db/fulfillment.ts price cargo and dispatch-document lines in foreign currency from
-- products.valas, so cost is booked at `kurs` while a Tier Kurs price is built from
-- `tiered_kurs` — which is what makes that method's profit readout exactly the FX spread.
--
-- ─── What this file replaces ────────────────────────────────────────────────
--
-- Migrations 050–057 built this in eight steps, and three of them undid earlier ones: a
-- `domestic_profit_tiers` table renamed to `tier_fee_brackets`, a `domestic` method renamed
-- to `tier_fee`, and a per-country bracket set replaced by two shared rupiah ones. None of
-- it ever reached production, which is still at 049, so the intermediate states are history
-- nobody needs to replay — they are squashed into this file and 051.
--
-- Consequence worth stating: a DEV database that already ran the old 050–057 is at the same
-- end state, so this file is a no-op there. Every statement is guarded, so applying it to
-- either shape is safe.

-- ─── 1. The formula discriminator ──────────────────────────────────────────

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS pricing_method TEXT;

-- Backfill preserves exactly the pre-050 behaviour, so no stored price changes: a row with
-- no country was priced cost + fixed fee, which is what tier_fee means in rupiah mode.
UPDATE products
   SET pricing_method = CASE WHEN country_id IS NULL THEN 'tier_fee' ELSE 'overseas' END
 WHERE pricing_method IS NULL;

-- Only after the backfill, or NOT NULL would fail on the existing 2,800+ rows. Guarded so
-- re-running is safe.
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
      CHECK (pricing_method IN ('overseas', 'tier_fee', 'flat_fee', 'tier_kurs'));
  END IF;
END
$$;

-- The catalogue filters and sorts on the method, on every page.
CREATE INDEX IF NOT EXISTS idx_products_pricing_method ON products (pricing_method);

-- ─── 2. The snapshotted tiered rate ────────────────────────────────────────
--
-- The rate a Tier Kurs product was actually priced with, captured at save time exactly like
-- products.kurs. NULLABLE with no default: NULL means "not priced on a tiered rate", which a
-- 0 could not be told apart from.
--
-- No GRANT needed. Migration 019's ALTER DEFAULT PRIVILEGES covers new tables and sequences
-- for app_runtime, and a table-level grant already covers new columns. invoice_reader's
-- products grant (migration 018) is table-level on this branch, so it WOULD see these
-- columns — but getPublicInvoiceForCustomer selects only name and gram, so nothing is
-- exposed. The narrowing to explicit columns lives on the `pricing-templates` branch.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS tiered_kurs NUMERIC(12,4);

-- NOTE: there is deliberately no `fee_valas` column. The superseded 053 shape denominated a
-- Markup row's fee in the country's currency and needed somewhere to snapshot it; the shared
-- rupiah brackets in 051 do not, and that fee now lands in profit_fixed like every other. The
-- column existed only between 053 and 057, was never written after 056, and never reached
-- production — so it is not created rather than created-and-ignored.

-- ─── 3. How a Flat Fee row expresses its fee ───────────────────────────────
--
-- A mode column, NOT a fifth pricing_method: the choice is a modifier on one method, not a
-- different formula — the price is cost + fee either way. Everything that keys on the method
-- (which fields to show, whether a country is allowed, which readout to draw) would
-- otherwise have to list the two together everywhere. Same split tier_fee_brackets.fee_mode
-- already uses, and the same two words.
--
-- Meaningless for the other three methods, which never read it. 'fixed' is the default and
-- the behaviour every row had before percent mode existed.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS flat_fee_mode TEXT NOT NULL DEFAULT 'fixed';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_flat_fee_mode_check'
  ) THEN
    ALTER TABLE products ADD CONSTRAINT products_flat_fee_mode_check
      CHECK (flat_fee_mode IN ('fixed', 'percent'));
  END IF;
END
$$;

-- ─── 4. The global pricing settings ────────────────────────────────────────
--
-- Four numbers in product_defaults. Unlike the rest of that table these are NOT merely form
-- pre-fills: lib/pricing-server.ts reads them inside the write transaction, so changing one
-- reprices the affected products on their next save. That asymmetry is the point of Flat Fee
-- — one figure, one authority, changed in one place — and it is what distinguishes it from
-- Markup, whose rupiah fee is typed per product.

ALTER TABLE product_defaults
  -- The rounding step for the two methods that ceil. 5.000 matches how the catalogue is
  -- actually priced: 2.761 of 2.779 overseas products reproduce exactly at 5.000, and 1.272
  -- sit more than 2.500 below their stored price, which rules out 2.500 outright.
  -- (lib/pricing.ts rounds the OVERSEAS formula to 1.000 and has always disagreed with the
  -- data; left alone here, since changing it would reprice the catalogue.)
  ADD COLUMN IF NOT EXISTS tier_kurs_round_to INTEGER NOT NULL DEFAULT 5000,
  -- Flat Fee, fixed mode. The owner's starting value, not a derived one.
  ADD COLUMN IF NOT EXISTS flat_fee           INTEGER NOT NULL DEFAULT 10000,
  -- Flat Fee, percent mode. NUMERIC so 4,5% is expressible. Default 0, not a guessed rate:
  -- 0 prices at cost, which is visible in the profit readout and self-corrects once the
  -- owner sets a real figure.
  ADD COLUMN IF NOT EXISTS flat_fee_pct       NUMERIC NOT NULL DEFAULT 0,
  -- A floor under the percentage: below some base, the work of buying and shipping an item
  -- costs more than the cut. PERCENT MODE ONLY — a floor under a fixed amount would either
  -- do nothing (min <= flat_fee) or silently replace the owner's chosen fee with a different
  -- constant, and the second is the kind of surprise found through a wrong invoice.
  --
  -- Default 0 and MAX(fee, 0) is fee, so the floor is inert until set. No separate on/off
  -- flag: "a minimum of nothing" already means no minimum, and a second switch could
  -- disagree with the number beside it. Same reason flat_fee_pct has none.
  ADD COLUMN IF NOT EXISTS flat_fee_min       INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_defaults_tier_kurs_round_to_check'
  ) THEN
    -- >= 1 because it divides in ceilTo(): a 0 step is a runtime hazard, not a bad default.
    ALTER TABLE product_defaults ADD CONSTRAINT product_defaults_tier_kurs_round_to_check
      CHECK (tier_kurs_round_to >= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_defaults_flat_fee_check'
  ) THEN
    ALTER TABLE product_defaults ADD CONSTRAINT product_defaults_flat_fee_check
      CHECK (flat_fee >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_defaults_flat_fee_pct_check'
  ) THEN
    -- Capped at 100: a fee larger than the base is not a percentage of it in any useful
    -- sense. Unlike the overseas profit % this one cannot divide by zero, so the bound is
    -- about intent rather than arithmetic.
    ALTER TABLE product_defaults ADD CONSTRAINT product_defaults_flat_fee_pct_check
      CHECK (flat_fee_pct >= 0 AND flat_fee_pct <= 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_defaults_flat_fee_min_check'
  ) THEN
    -- No upper bound. A floor above any realistic percentage result is legal and simply makes
    -- every percent-mode row charge that flat amount, which is a coherent thing to want; the
    -- readout names whichever figure actually applied.
    ALTER TABLE product_defaults ADD CONSTRAINT product_defaults_flat_fee_min_check
      CHECK (flat_fee_min >= 0);
  END IF;
END
$$;

-- ─── 5. Audit ──────────────────────────────────────────────────────────────
--
-- Nothing to register. products and product_defaults already carry row-level audit triggers
-- from 029_audit_log.sql, and a new column needs no re-registration. The two tables created
-- in 051 do need theirs.
--
-- No stored price moves: every column above is additive, the backfill reproduces the previous
-- behaviour exactly, and no product is switched to a new method by this file.
