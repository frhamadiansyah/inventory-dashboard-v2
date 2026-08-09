-- Add 5 business-cost categories to operational_expenses, ALONGSIDE the existing
-- 6 travel categories (no data change — existing rows stay valid).
--
-- The CHECK constraint from migration 033 was defined inline, so Postgres named
-- it operational_expenses_category_check. Drop and re-add it widened to all 11.
-- (If your constraint name differs, adjust the DROP below — check with:
--   SELECT conname FROM pg_constraint WHERE conrelid = 'operational_expenses'::regclass AND contype = 'c';)

ALTER TABLE operational_expenses
  DROP CONSTRAINT operational_expenses_category_check,
  ADD CONSTRAINT operational_expenses_category_check
    CHECK (category IN (
      'Flight','Lodging','Cargo','Meal','Transport','Shop',
      'Supplies','Delivery','Personal','Payroll','Dividend'
    ));
