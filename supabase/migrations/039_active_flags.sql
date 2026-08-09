-- Active/inactive flag for events and products.
--
-- An inactive event or product is hidden from the List Order input dropdowns
-- (the event picker and item picker on the Order page's add-order forms) so
-- it can't be picked for new orders. It still shows everywhere else: its own
-- management table (so it can be reactivated), every other picker, and all
-- existing orders/reports.
--
-- DEFAULT TRUE means every existing row is active on deploy — nothing is
-- hidden until an owner explicitly toggles it off.

ALTER TABLE events   ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE products ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;
