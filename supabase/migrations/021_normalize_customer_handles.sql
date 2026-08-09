-- 021_normalize_customer_handles.sql
--
-- One-time cleanup: canonicalize customers.instagram_id to BARE LOWERCASE
-- (strip leading "@", lowercase) and MERGE duplicate rows that collapse to the
-- same handle (e.g. "8_davinas" + "@8_davinas").
--
-- Child tables (orders, payments, shipments, adjustments, refunds) reference
-- customers.instagram_id with ON UPDATE CASCADE, so renaming the surviving
-- handle propagates to them automatically. Non-survivor children are repointed
-- to the survivor BEFORE the duplicate customer row is deleted (FK is
-- ON DELETE RESTRICT).
--
-- Merge rule: per normalized handle, the survivor is the row with contact data,
-- preferring the non-"@" (legacy) form; empty fields are filled from the twin
-- (survivor's non-empty value always wins). Verified against the data: the only
-- field "conflicts" are cosmetic casing/typos on the same person/address.
--
-- Sentinel rows ('_old%', 'gantialamat') are left untouched.
-- Idempotent + safe to re-run. Run AFTER deploying the normalizeCustomer()
-- change; re-run once more to sweep any "@" twin created during the deploy gap.

BEGIN;

SET LOCAL statement_timeout = 0;

-- 1. Rank every non-sentinel customer within its normalized-handle group.
--    rn = 1 is the survivor (has contact data, prefers the non-"@" form).
CREATE TEMP TABLE _cust_norm ON COMMIT DROP AS
SELECT
  id,
  instagram_id,
  lower(replace(instagram_id, '@', ''))                              AS k,
  whatsapp, data_diri, ekspedisi, ongkos_kirim,
  bank_name, bank_account_number, bank_account_holder,
  row_number() OVER (
    PARTITION BY lower(replace(instagram_id, '@', ''))
    ORDER BY
      (whatsapp  <> '')::int DESC,            -- rows with a phone first
      (data_diri <> '')::int DESC,            -- then rows with an address
      (instagram_id LIKE '@%')::int ASC,      -- then the legacy (non-"@") form
      id ASC
  ) AS rn
FROM customers
WHERE instagram_id NOT LIKE '\_old%' AND instagram_id <> 'gantialamat';

CREATE INDEX ON _cust_norm (k);
CREATE INDEX ON _cust_norm (instagram_id);

-- 2. Per group: survivor + merged field values (survivor wins, fill from twins).
CREATE TEMP TABLE _cust_target ON COMMIT DROP AS
SELECT
  s.k,
  s.id           AS survivor_id,
  s.instagram_id AS survivor_ig,
  g.n,
  COALESCE(NULLIF(s.whatsapp, ''),            g.m_whatsapp,    '') AS whatsapp,
  COALESCE(NULLIF(s.data_diri, ''),           g.m_data_diri,   '') AS data_diri,
  COALESCE(NULLIF(s.ekspedisi, ''),           g.m_ekspedisi,   '') AS ekspedisi,
  COALESCE(NULLIF(s.ongkos_kirim, 0),         g.m_ongkir,      0)  AS ongkos_kirim,
  COALESCE(NULLIF(s.bank_name, ''),           g.m_bank_name,   '') AS bank_name,
  COALESCE(NULLIF(s.bank_account_number, ''), g.m_bank_num,    '') AS bank_account_number,
  COALESCE(NULLIF(s.bank_account_holder, ''), g.m_bank_holder, '') AS bank_account_holder
FROM _cust_norm s
JOIN (
  SELECT
    k,
    count(*)                            AS n,
    max(NULLIF(whatsapp, ''))            AS m_whatsapp,
    max(NULLIF(data_diri, ''))           AS m_data_diri,
    max(NULLIF(ekspedisi, ''))           AS m_ekspedisi,
    max(NULLIF(ongkos_kirim, 0))         AS m_ongkir,
    max(NULLIF(bank_name, ''))           AS m_bank_name,
    max(NULLIF(bank_account_number, '')) AS m_bank_num,
    max(NULLIF(bank_account_holder, '')) AS m_bank_holder
  FROM _cust_norm
  GROUP BY k
) g ON g.k = s.k
WHERE s.rn = 1;

CREATE INDEX ON _cust_target (k);

-- 3. Repoint child rows from each non-survivor handle to the survivor handle.
--    (Survivor still carries its OLD handle here; step 6 canonicalizes it.)
UPDATE orders o
SET customer = t.survivor_ig
FROM _cust_norm n JOIN _cust_target t ON t.k = n.k
WHERE n.rn > 1 AND o.customer = n.instagram_id;

UPDATE payments p
SET customer = t.survivor_ig
FROM _cust_norm n JOIN _cust_target t ON t.k = n.k
WHERE n.rn > 1 AND p.customer = n.instagram_id;

UPDATE shipments sh
SET customer = t.survivor_ig
FROM _cust_norm n JOIN _cust_target t ON t.k = n.k
WHERE n.rn > 1 AND sh.customer = n.instagram_id;

UPDATE adjustments a
SET customer = t.survivor_ig
FROM _cust_norm n JOIN _cust_target t ON t.k = n.k
WHERE n.rn > 1 AND a.customer = n.instagram_id;

UPDATE refunds r
SET customer = t.survivor_ig
FROM _cust_norm n JOIN _cust_target t ON t.k = n.k
WHERE n.rn > 1 AND r.customer = n.instagram_id;

-- 4. Delete the now-childless duplicate (non-survivor) customer rows.
DELETE FROM customers c
USING _cust_norm n
WHERE c.id = n.id AND n.rn > 1;

-- 5. Apply merged contact/bank fields onto survivors that absorbed a twin.
UPDATE customers c
SET whatsapp            = t.whatsapp,
    data_diri           = t.data_diri,
    ekspedisi           = t.ekspedisi,
    ongkos_kirim        = t.ongkos_kirim,
    bank_name           = t.bank_name,
    bank_account_number = t.bank_account_number,
    bank_account_holder = t.bank_account_holder,
    updated_at          = NOW()
FROM _cust_target t
WHERE c.id = t.survivor_id AND t.n > 1;

-- 6. Canonicalize every remaining handle to bare lowercase. Dedup is done, so
--    no UNIQUE collisions; ON UPDATE CASCADE rewrites all child.customer values.
UPDATE customers
SET instagram_id = lower(replace(instagram_id, '@', '')),
    updated_at   = NOW()
WHERE instagram_id NOT LIKE '\_old%'
  AND instagram_id <> 'gantialamat'
  AND instagram_id <> lower(replace(instagram_id, '@', ''));

COMMIT;
