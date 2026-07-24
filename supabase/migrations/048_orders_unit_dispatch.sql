-- Add a "dispatch" lifecycle quantity to orders, alongside buy/arrive/ship.
-- Nullable (no default), same shape as unit_ship/unit_hold. Editable inline from
-- the List Order table; not yet wired into any downstream ship/shipment logic.
ALTER TABLE orders ADD COLUMN unit_dispatch INTEGER;
