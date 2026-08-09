-- Dispatch tracking reference + backfill unit_dispatch for existing rows.
-- Backfill treats every already-bought unit as already dispatched, so the
-- re-gated arrival list (arrive < dispatch) behaves exactly as before
-- (arrive < buy) for in-flight orders, and the Dispatch List starts empty.
ALTER TABLE orders ADD COLUMN dispatch_receipt TEXT NOT NULL DEFAULT '';
UPDATE orders SET unit_dispatch = unit_buy WHERE unit_buy IS NOT NULL;
