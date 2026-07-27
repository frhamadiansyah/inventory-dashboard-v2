-- The two bracket tables the pricing methods look up.
--
--   country_kurs_tiers   Tier Kurs: from which valas upward to charge which RATE. Per
--                        country, because a rate is meaningless without one.
--   tier_fee_brackets    Markup: from which RUPIAH base cost upward to charge which fee.
--                        Two scopes, both rupiah, shared by every country.
--
-- Both share one rule, deliberately: the floor is INCLUSIVE and the HIGHEST matching floor
-- wins, so row order never affects the result. Two different answers to "which bracket
-- applies" in one app would be a bug waiting to happen. resolveTieredKurs() in
-- lib/kurs-tiers.ts and pickTierFeeBracket() in lib/tier-fee.ts implement the same rule.
--
-- Replaces the bracket half of the squashed 050–057 — see 050 for what that was and why the
-- history is not worth replaying. Two files rather than one because the seed at the bottom
-- needs the tables to exist, and this is the boundary that guarantees it.

-- ─── 1. Tier Kurs: the rate charged, per country ────────────────────────────

CREATE TABLE IF NOT EXISTS country_kurs_tiers (
  id         SERIAL PRIMARY KEY,
  country_id INTEGER NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
  -- valas is NUMERIC(12,2), so with min_valas 1001 a valas of 1000.50 still falls in the
  -- band BELOW. Enter 1000.01 if that is what you meant. Surfaced in the editor's helper
  -- text too, because it is the one boundary rule that can surprise.
  min_valas  NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- The rate CHARGED — not the country's actual rate. Same precision as countries.kurs
  -- (migration 025), since it is the same kind of number.
  kurs       NUMERIC(12,4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  CONSTRAINT country_kurs_tiers_min_valas_nonneg CHECK (min_valas >= 0),
  CONSTRAINT country_kurs_tiers_kurs_positive    CHECK (kurs > 0),
  -- Two brackets with the same floor are ambiguous. Also provides the (country_id, min_valas)
  -- index the lookup needs, so no separate CREATE INDEX.
  UNIQUE (country_id, min_valas)
);

-- NO BRACKETS ARE SEEDED, on purpose. The owner's illustration (3000/2700/2600 against an
-- actual 2500) is not production data — CN's countries.kurs is 2700 — so seeding it would
-- ship real, wrong pricing config. A country with no brackets falls back to its flat kurs,
-- which prices a Tier Kurs product at valas × kurs with a zero spread: safe, visible (the
-- profit readout reads 0), and self-correcting once brackets are entered in Settings.

-- ─── 2. Markup: the fee, by rupiah base cost ───────────────────────────────
--
-- Two scopes, and BOTH are denominated in rupiah — floors and fees alike. They differ in
-- which base cost they are matched against, and in who has the last word:
--
--   'rupiah'  the TYPED base cost of a Markup row with no country. A SUGGESTION only: it
--             pre-fills the form's Fee field, the owner types over it, and nothing recomputes
--             it afterwards. That is deliberate — the fee has been a per-product decision
--             since before this table existed, and making it authoritative would overwrite
--             every manual override in the catalogue.
--   'valas'   the DERIVED base cost (valas × kurs + freight) of a Markup row with a country,
--             SHARED by every country. Authoritative: re-resolved server-side inside the
--             write transaction on every save.
--
-- One shared valas set rather than one per country is only coherent because the floors and
-- the fee are rupiah. A shared `fee = 20` in each country's own currency would mean 20 CNY
-- for China and 20 JPY for Japan — a twentyfold difference — and rupiah floors are the only
-- ones comparable across countries at all, since the base cost is already rupiah by the time
-- a bracket is chosen.

CREATE TABLE IF NOT EXISTS tier_fee_brackets (
  id         SERIAL PRIMARY KEY,
  -- A two-valued discriminator, not a country_id FK: there are exactly two sets and neither
  -- belongs to a country. Same shape as fee_mode below — a small closed vocabulary with a
  -- CHECK. Defaults to the suggestion-only scope, so a bad insert cannot become
  -- authoritative by accident.
  scope      TEXT NOT NULL DEFAULT 'rupiah',
  -- NUMERIC, not INTEGER: the valas scope matches a DERIVED base cost, which is fractional
  -- before it is rounded. 14 digits leaves room for a rupiah cost well past any real product.
  min_base   NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- 'fixed'   → fee_value is a rupiah amount
  -- 'percent' → fee_value is a percentage OF the base cost
  fee_mode   TEXT NOT NULL DEFAULT 'fixed',
  fee_value  NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  CONSTRAINT tier_fee_brackets_min_base_nonneg CHECK (min_base >= 0),
  CONSTRAINT tier_fee_brackets_fee_value_nonneg CHECK (fee_value >= 0),
  CONSTRAINT tier_fee_brackets_fee_mode_check   CHECK (fee_mode IN ('fixed', 'percent')),
  CONSTRAINT tier_fee_brackets_scope_check      CHECK (scope IN ('rupiah', 'valas')),
  -- Named rather than left to Postgres (which would say ..._scope_min_base_key) because
  -- replaceTierFeeBrackets' upsert targets these columns and a dev database carries this
  -- name from the superseded migrations. Two brackets with the same floor in the same scope
  -- are ambiguous; this is also the index the lookup uses.
  CONSTRAINT tier_fee_brackets_scope_base_key   UNIQUE (scope, min_base)
);

-- ─── 3. Seed both scopes with the formerly hardcoded table ─────────────────
--
-- These nine rows were hardcoded in app/dashboard/products/ProductsPageClient.tsx before
-- there was a table to hold them:
--
--   cost >= 800.000  →  15% of cost      cost >  198.000  →  25.000
--   cost >= 700.000  →  80.000           cost >   98.000  →  20.000
--   cost >  498.000  →  55.000           cost >   28.000  →  10.000
--   cost >  398.000  →  45.000           otherwise        →   5.000
--   cost >  298.000  →  35.000
--
-- Note the mixed shape: the top bracket is a PERCENTAGE, the rest flat amounts — which is
-- why fee_mode exists. The hardcoded table also mixes inclusive (>=) and exclusive (>)
-- boundaries; everything here is inclusive, so the exclusive ones shift up by one:
-- `cost > 498.000` becomes `min_base 498.001`. An EXACT translation, not an approximation,
-- because products.cost is INTEGER — there is no value strictly between them to disagree on.
-- (scripts/dryrun-tier-fee.ts sweeps every integer cost 0–1.200.000 and asserts the table
-- and the old hardcoded function agree on all of them.)
--
-- The valas scope starts as a copy. It has no history of its own — the superseded per-country
-- sets were denominated in foreign currency and could not be reinterpreted as rupiah, so
-- duplicating the rupiah set was the migration path, and it is the sensible starting point
-- for a fresh install too. Both are editable in Settings, independently, from the first save.

INSERT INTO tier_fee_brackets (scope, min_base, fee_mode, fee_value)
SELECT scope, min_base, fee_mode, fee_value
  FROM (VALUES
    (     0, 'fixed',    5000),
    ( 28001, 'fixed',   10000),
    ( 98001, 'fixed',   20000),
    (198001, 'fixed',   25000),
    (298001, 'fixed',   35000),
    (398001, 'fixed',   45000),
    (498001, 'fixed',   55000),
    (700000, 'fixed',   80000),
    (800000, 'percent',    15)
  ) AS seed(min_base, fee_mode, fee_value)
  CROSS JOIN (VALUES ('rupiah'), ('valas')) AS scopes(scope)
-- Guarded on the SCOPE being empty, not per row: re-running must not resurrect a bracket the
-- owner deliberately deleted, and a scope with any rows in it has already been through the
-- owner's hands. ON CONFLICT DO NOTHING would silently re-add deleted floors.
 WHERE NOT EXISTS (
   SELECT 1 FROM tier_fee_brackets existing WHERE existing.scope = scopes.scope
 );

-- No product row is touched. The rupiah scope feeds a form default; the valas scope is read
-- when a product is saved, and no product uses that mode yet — production has no
-- valas-mode Markup row, because it has no pricing_method column until 050 lands.

-- ─── 4. Audit ──────────────────────────────────────────────────────────────
-- Drop-then-create, the idiom from the table loop in 029_audit_log.sql, since Postgres has no
-- CREATE TRIGGER IF NOT EXISTS. No GRANT needed: migration 019's ALTER DEFAULT PRIVILEGES
-- covers new tables and their sequences for app_runtime.

DROP TRIGGER IF EXISTS audit_country_kurs_tiers ON country_kurs_tiers;
CREATE TRIGGER audit_country_kurs_tiers
  AFTER INSERT OR UPDATE OR DELETE ON country_kurs_tiers
  FOR EACH ROW EXECUTE FUNCTION audit.log_change();

DROP TRIGGER IF EXISTS audit_tier_fee_brackets ON tier_fee_brackets;
CREATE TRIGGER audit_tier_fee_brackets
  AFTER INSERT OR UPDATE OR DELETE ON tier_fee_brackets
  FOR EACH ROW EXECUTE FUNCTION audit.log_change();
