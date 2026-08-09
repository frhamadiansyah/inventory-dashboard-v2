-- Moves the DP threshold from business_profile to product_defaults.
--
-- dp_percent (migration 043) never really belonged on the business identity
-- row — it's read once, in lib/db/invoice.ts, alongside every other
-- pricing-adjacent setting, and the Settings page groups it with those on
-- screen. business_profile stays what it was before 043: pure business
-- identity (bank details, names, the public site URL).
--
-- DEFAULT 0 here too, and the backfill below carries over whatever the
-- owner already set, so this ships with identical invoice-message
-- behavior — nothing crosses the 0% (always met) vs >0% threshold
-- differently than it did the moment before this migration ran.

ALTER TABLE product_defaults
  ADD COLUMN IF NOT EXISTS dp_percent NUMERIC(6,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_defaults_dp_percent_check'
  ) THEN
    -- Same bound as the sibling percent column (flat_fee_pct, migration 050):
    -- capped at 100, since a DP threshold above the invoice total can never
    -- be met and would silently turn every invoice into a DP reminder.
    ALTER TABLE product_defaults ADD CONSTRAINT product_defaults_dp_percent_check
      CHECK (dp_percent >= 0 AND dp_percent <= 100);
  END IF;
END
$$;

-- Carry over whatever the owner already configured before dropping the old column.
UPDATE product_defaults
SET dp_percent = (SELECT dp_percent FROM business_profile WHERE id = 1)
WHERE id = 1;

ALTER TABLE business_profile DROP COLUMN IF EXISTS dp_percent;
