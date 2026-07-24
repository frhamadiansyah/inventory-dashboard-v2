-- Make excess_purchase.event optional (the "Add Inventory" / edit-inventory form).
--
-- Same rationale as operational_expenses (migration 046): some tracked stock
-- isn't tied to a specific event yet. Drop the NOT NULL; the FK to events(name)
-- still validates any non-null value, and Postgres does not enforce a FK on
-- NULL, so event-less inventory rows are allowed.
ALTER TABLE excess_purchase ALTER COLUMN event DROP NOT NULL;
