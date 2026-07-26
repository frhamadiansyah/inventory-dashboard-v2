-- Tier Rp: make the domestic fixed-profit brackets editable instead of hardcoded.
--
-- The domestic (Tier Rp) method prices a product as `cost + profit_fixed`, and the
-- Add Product form has always SUGGESTED a profit_fixed from the base cost using a
-- table hardcoded in app/dashboard/products/ProductsPageClient.tsx:
--
--   cost >= 800.000  ->  15% of cost      cost >  198.000  ->  25.000
--   cost >= 700.000  ->  80.000           cost >   98.000  ->  20.000
--   cost >  498.000  ->  55.000           cost >   28.000  ->  10.000
--   cost >  398.000  ->  45.000           otherwise        ->   5.000
--   cost >  298.000  ->  35.000
--
-- Note the mixed shape: the top bracket is a PERCENTAGE of cost, the rest are flat
-- rupiah amounts. Both have to survive the move, hence profit_mode.
--
-- This stays a SUGGESTION, not an authority. It pre-fills one form field, the owner
-- can type over it, and nothing recomputes it afterwards — not the edit modal, not
-- the server. That is deliberate: profit_fixed is a per-product decision, and
-- making the brackets authoritative would overwrite every manual override and
-- reprice the existing domestic rows. Contrast country_kurs_tiers (migration 050),
-- which IS authoritative and is resolved server-side on every save.

-- ─── 1. The brackets ───────────────────────────────────────────────────────
--
-- NOTE FOR RE-RUNS: migration 053 renames this table to tier_fee_brackets, which
-- makes the IF NOT EXISTS below useless — the old name is gone, so a re-run would
-- create a second, empty, stale table and re-seed it. Guarded on EITHER name
-- existing so that cannot happen. Production migrations here are applied by hand, so
-- "nobody would run an old migration again" is not a safe assumption.

DO $$
BEGIN
IF EXISTS (
  SELECT 1 FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name IN ('domestic_profit_tiers', 'tier_fee_brackets')
) THEN
  RAISE NOTICE 'tier fee brackets already exist (under either name) — skipping 051';
  RETURN;
END IF;

CREATE TABLE IF NOT EXISTS domestic_profit_tiers (
  id           SERIAL PRIMARY KEY,
  -- INCLUSIVE lower bound, and the HIGHEST matching minimum wins, so row order
  -- never affects the result — the same rule as country_kurs_tiers.min_valas.
  -- INTEGER because products.cost is INTEGER; there are no fractional rupiah here.
  min_cost     INTEGER NOT NULL DEFAULT 0,
  -- 'fixed'   -> profit_value is a rupiah amount
  -- 'percent' -> profit_value is a percentage OF cost
  profit_mode  TEXT NOT NULL DEFAULT 'fixed',
  profit_value NUMERIC(12,2) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ,
  CONSTRAINT domestic_profit_tiers_min_cost_nonneg CHECK (min_cost >= 0),
  CONSTRAINT domestic_profit_tiers_value_nonneg    CHECK (profit_value >= 0),
  CONSTRAINT domestic_profit_tiers_mode_check      CHECK (profit_mode IN ('fixed', 'percent')),
  -- Two brackets with the same floor are ambiguous. Also provides the index the
  -- lookup needs, so no separate CREATE INDEX.
  UNIQUE (min_cost)
);

-- ─── 2. Seed today's behaviour, exactly ────────────────────────────────────
--
-- The hardcoded table mixes inclusive (>=) and exclusive (>) boundaries. Everything
-- here is inclusive, so the exclusive ones shift up by one: `cost > 498.000` becomes
-- `min_cost 498.001`. That is an EXACT translation, not an approximation, because
-- products.cost is INTEGER — there is no value strictly between 498.000 and 498.001
-- for it to disagree on. (scripts/dryrun-domestic-tiers.ts sweeps every integer cost
-- from 0 to 1.200.000 and asserts the two agree on all of them.)
--
-- Guarded on the table not existing at all (see section 1) rather than ON CONFLICT DO
-- NOTHING: re-running the migration must not resurrect a bracket the owner
-- deliberately deleted.

-- Reached only when the table was just created, so it is empty by construction and
-- needs no further guard.
INSERT INTO domestic_profit_tiers (min_cost, profit_mode, profit_value) VALUES
  (     0, 'fixed',    5000),
  ( 28001, 'fixed',   10000),
  ( 98001, 'fixed',   20000),
  (198001, 'fixed',   25000),
  (298001, 'fixed',   35000),
  (398001, 'fixed',   45000),
  (498001, 'fixed',   55000),
  (700000, 'fixed',   80000),
  (800000, 'percent',    15);

-- No product row is touched: this table feeds a form default, and every stored
-- price and profit_fixed stays exactly as it was.

-- ─── 3. Audit ──────────────────────────────────────────────────────────────
-- Same drop-then-create idiom as the table loop in 029_audit_log.sql, since
-- Postgres has no CREATE TRIGGER IF NOT EXISTS. No GRANT needed — migration 019's
-- ALTER DEFAULT PRIVILEGES covers new tables and sequences for app_runtime.

EXECUTE 'DROP TRIGGER IF EXISTS audit_domestic_profit_tiers ON domestic_profit_tiers';
EXECUTE 'CREATE TRIGGER audit_domestic_profit_tiers
  AFTER INSERT OR UPDATE OR DELETE ON domestic_profit_tiers
  FOR EACH ROW EXECUTE FUNCTION audit.log_change()';
END
$$;
