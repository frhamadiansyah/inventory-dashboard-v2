-- A configurable rounding step for the Profit Margin method.
--
-- It always had one — ceilTo1000() in lib/pricing.ts, hardcoded — while every other rounded
-- method read product_defaults.tier_kurs_round_to. So the catalogue had two rounding rules,
-- one editable and one not, and nothing said which applied where.
--
-- A SECOND column rather than reusing tier_kurs_round_to: the two steps are genuinely
-- different numbers today (1000 here, 5000 there) and the owner set neither of them
-- together. Folding them into one would silently move every Profit Margin price to the
-- nearest 5000 on its next save, which is a repricing decision this migration has no
-- business making.
--
-- DEFAULT 1000 is exactly what ceilTo1000 did, so nothing changes on deploy until the owner
-- edits it. Existing prices are stored per row and are not touched; each one reprices on its
-- next save, the same rule the other rounding step carries.
ALTER TABLE product_defaults
  ADD COLUMN IF NOT EXISTS profit_margin_round_to INTEGER NOT NULL DEFAULT 1000;

-- At least 1. A step of 0 would divide by zero in ceilTo(); the helper guards it, but a
-- column that cannot hold the bad value is better than a helper that survives it.
ALTER TABLE product_defaults DROP CONSTRAINT IF EXISTS product_defaults_profit_margin_round_to_check;
ALTER TABLE product_defaults ADD CONSTRAINT product_defaults_profit_margin_round_to_check
  CHECK (profit_margin_round_to >= 1);
