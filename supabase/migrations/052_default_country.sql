-- Which country the Add Product form starts on.
--
-- The form has always defaulted its Country field to `countries[0]` — whichever country sorts
-- first by name, since that is the order getCountries() returns. So a default already existed;
-- it just was not the owner's to choose, and it moves whenever a country is renamed or added
-- ahead of it alphabetically.
--
-- NULL is a legitimate value, not "unset": the Country field offers "IDR (Rupiah)" as a real
-- option, so a NULL default means the form starts in rupiah mode. That matters for the two fee
-- methods, where the presence of a country is what picks between a typed base cost and a
-- derived one.
--
-- A pre-fill only, like profit_pct and the two fees beside it — read once when the form mounts,
-- never at price-computation time. Changing it cannot touch a stored price. (tier_kurs_round_to
-- and the flat_fee figures in the same table are the exceptions; see 050.)

DO $$
DECLARE
  fresh BOOLEAN;
BEGIN
  SELECT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'product_defaults' AND column_name = 'default_country_id'
  ) INTO fresh;

  IF NOT fresh THEN
    RAISE NOTICE 'product_defaults.default_country_id already exists — skipping 052';
    RETURN;
  END IF;

  -- ON DELETE SET NULL, emphatically not CASCADE: product_defaults is a SINGLETON row that
  -- every pricing form reads, and cascading from a country would delete it outright. Falling
  -- back to "no default" is the correct answer when the chosen country goes away.
  EXECUTE 'ALTER TABLE product_defaults
             ADD COLUMN default_country_id INTEGER REFERENCES countries(id) ON DELETE SET NULL';

  -- Seed the behaviour the form already had, so nothing changes on deploy: the first country by
  -- name is exactly what countries[0] resolved to. Without this the field would start on IDR
  -- for everyone until the owner set a default, which would silently flip a newly created
  -- Markup or Flat Fee product from valas mode to rupiah mode.
  --
  -- Inside the freshness check rather than `WHERE default_country_id IS NULL`, because NULL is a
  -- value here. A re-run must not resurrect a country the owner deliberately cleared.
  EXECUTE 'UPDATE product_defaults
              SET default_country_id = (SELECT id FROM countries ORDER BY name LIMIT 1)
            WHERE id = 1';
END
$$;

-- No GRANT needed — migration 019's ALTER DEFAULT PRIVILEGES covers new columns on existing
-- tables for app_runtime, and product_defaults already carries a row-level audit trigger, which
-- a new column needs no re-registration for.
