-- Give excess_purchase (the overbuy/overship/etc "Ready stock" table) the same
-- buy -> dispatch -> arrive lifecycle orders has (migration 048/049), so stock
-- that's been bought but isn't physically in hand yet doesn't silently read as
-- "ready" just because it landed in this table.
ALTER TABLE excess_purchase ADD COLUMN unit_dispatch INTEGER;
ALTER TABLE excess_purchase ADD COLUMN unit_arrive INTEGER;
ALTER TABLE excess_purchase ADD COLUMN dispatch_receipt TEXT NOT NULL DEFAULT '';

-- Backfill: every existing row was always treated as ready stock (this table
-- had no other concept), so mark it fully dispatched+arrived to match current
-- behavior with zero regression -- EXCEPT the LSJP202608 overbuy rows, which
-- are known to still be in transit right now. Leave those NULL so they show up
-- in the new "Overbuy in transit" sections for reconciliation.
UPDATE excess_purchase
SET unit_dispatch = unit_buy, unit_arrive = unit_buy
WHERE NOT (event = 'LSJP202608' AND reason = 'overbuy');
