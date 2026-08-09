-- Let operational_expenses.category be free text instead of a closed set.
-- Users can now add new categories on the fly, the same way the `method`
-- column already works (no constraint, SearchableSelect + allowNewValue on the
-- dashboard). Existing rows keep their values; the dashboard still offers the
-- prior 12 categories as suggested options, just no longer enforced by a CHECK.
--
-- Mirrors migrations 036/037: the CHECK is an inline (named) constraint, so
-- drop it. (If your constraint name differs, check with:
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = 'operational_expenses'::regclass AND contype = 'c';)

ALTER TABLE operational_expenses
  DROP CONSTRAINT operational_expenses_category_check;
