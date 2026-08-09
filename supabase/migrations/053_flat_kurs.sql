-- Flat Kurs: a second Rate method, charging ONE rate per country whatever the valas.
--
-- Its sibling tier_kurs resolves the charged rate from country_kurs_tiers, so the rate
-- moves with the size of the purchase. This one does not. The price formula is otherwise
-- identical — ceil(valas × charged rate + packing fee) — which is why lib/pricing.ts gains
-- no new function: only the SOURCE of the rate differs, and that value was already passed in.
--
-- A fifth pricing_method rather than a mode column on tier_kurs, matching how the Markup
-- pair is stored: tier_fee and flat_fee are two methods behind one tab and one toggle. Two
-- toggles that look identical in the UI must not store differently.

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_pricing_method_check;
ALTER TABLE products ADD CONSTRAINT products_pricing_method_check
  CHECK (pricing_method IN ('overseas', 'tier_fee', 'flat_fee', 'tier_kurs', 'flat_kurs'));

-- The rate CHARGED to a Flat Kurs product bought in this country's currency.
--
-- NOT countries.kurs, which is what the goods actually COST — charging at that rate would
-- be a zero margin. Same NUMERIC(12,4) as countries.kurs and country_kurs_tiers.kurs,
-- because it is the same kind of number.
--
-- 0 means unset, which is what every existing country gets. The server then falls back to
-- the rate the row books as cost, pricing the product at cost with a zero spread: visible,
-- and self-correcting once a rate is entered. That is the same failure shape a country with
-- no brackets already has for tier_kurs.
--
-- Naming: 051's prose uses the words "its flat kurs" for countries.kurs. That comment is in
-- an applied migration and cannot be reworded. Here, kurs is the cost rate and flat_kurs the
-- charged one.
ALTER TABLE countries
  ADD COLUMN IF NOT EXISTS flat_kurs NUMERIC(12,4) NOT NULL DEFAULT 0;

ALTER TABLE countries DROP CONSTRAINT IF EXISTS countries_flat_kurs_nonneg;
ALTER TABLE countries ADD CONSTRAINT countries_flat_kurs_nonneg CHECK (flat_kurs >= 0);
