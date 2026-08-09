-- Which pricing method the Add Product form opens on.
--
-- The form has always started on 'overseas' because that is what the useState hook was
-- initialised with. For an owner whose catalogue is mostly one of the other four, that is a
-- tab click on every single product.
--
-- A pre-fill and nothing more, exactly like default_country_id (migration 052): it decides
-- what a NEW form starts as, and no stored product reads it. A row's method lives in
-- products.pricing_method and is set when it is saved.
--
-- The CHECK mirrors products_pricing_method_check (migration 053). Both lists have to move
-- together when a method is added — there is no shared enum type to lean on, because the
-- products constraint predates this column and converting it now would rewrite that table.
ALTER TABLE product_defaults
  ADD COLUMN IF NOT EXISTS default_pricing_method TEXT NOT NULL DEFAULT 'overseas';

ALTER TABLE product_defaults DROP CONSTRAINT IF EXISTS product_defaults_default_pricing_method_check;
ALTER TABLE product_defaults ADD CONSTRAINT product_defaults_default_pricing_method_check
  CHECK (default_pricing_method IN ('overseas', 'tier_fee', 'flat_fee', 'tier_kurs', 'flat_kurs'));
