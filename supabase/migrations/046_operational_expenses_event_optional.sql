-- Make operational_expenses.event optional.
--
-- Some operating costs aren't tied to a specific event/trip, but the column was
-- NOT NULL with a FK to events(name), so the add form forced an event. Drop the
-- NOT NULL; the FK still validates any non-null value, and Postgres does not
-- enforce a FK on NULL, so event-less expenses are now allowed.
ALTER TABLE operational_expenses ALTER COLUMN event DROP NOT NULL;
