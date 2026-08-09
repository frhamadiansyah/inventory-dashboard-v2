-- Add the "Other" catch-all category to operational_expenses, alongside the
-- existing 11. No data change — existing rows stay valid.
--
-- Mirrors migration 036: the CHECK is an inline (named) constraint, so drop and
-- re-add it widened to include 'Other'. (If your constraint name differs, adjust
-- the DROP below — check with:
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = 'operational_expenses'::regclass AND contype = 'c';)

ALTER TABLE operational_expenses
  DROP CONSTRAINT operational_expenses_category_check,
  ADD CONSTRAINT operational_expenses_category_check
    CHECK (category IN (
      'Flight','Lodging','Cargo','Meal','Transport','Shop',
      'Supplies','Delivery','Personal','Payroll','Dividend','Other'
    ));
