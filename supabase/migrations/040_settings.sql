-- /dashboard/settings — owner-editable wording for the app's customer-facing
-- messages (invoice, shipment confirmation, refund), the shared business
-- identity fields they draw on, and the Add Product form's default values.
-- See lib/message-templates.ts / lib/business-profile.ts / lib/product-defaults.ts
-- for the token contract and defaults (the seed values below must match those
-- defaults verbatim).
--
-- Owner-only feature: enforced in the app (requireOwner on the PATCH routes +
-- the /dashboard/settings route is absent from lib/access.ts ADMIN_ROUTES, so
-- it never shows for admins). No extra DB grant beyond migration 019's
-- ALTER DEFAULT PRIVILEGES, which auto-grants app_runtime DML on new public
-- tables. Reading (GET) stays available to any logged-in session — admins
-- already see this wording/these defaults rendered into what they do today.

CREATE TABLE IF NOT EXISTS message_templates (
  key        TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO message_templates (key, body) VALUES
('invoice', $tpl$INVOICE
{eventId} {handle}

Produk:
{produkLines}

Subtotal Barang: Rp {subtotalBarang}
Estimasi Ongkir: {weightKg} kg x Rp {perKgRate}{biayaLainnyaBlock}

Pelunasan: Rp {sisaPelunasan}

Rekening an {bankAccountHolder}:
{bankAccountLines}

Apabila memesan lebih dari 1 barang, transfer boleh digabung.

Cek rekapan mandiri https://yubisayu-invoice.netlify.app/

Jika ada kesalahan/kekurangan rekap, mohon infokan kembali untuk direvisi.$tpl$),

('shipment', $tpl$Konfirmasi Pengiriman Yubisayu
{event} {handle}

{dataDiri}

{items}

Paket sedang dikemas dan akan segera dikirim.

Cek kembali detail pesanan (jumlah, ukuran, warna jika ada) dan alamat, info jika ada perubahan alamat.

Cek resi https://yubisayu-invoice.netlify.app/ atau WA Channel.

Mohon konfirmasi jika paket sudah diterima.

Sebelum dikirim, barang dicek dan dikirim dalam kondisi baik. Paket dikirim oleh ekspedisi, wajib video unboxing tanpa terputus.

Tanpa video unboxing tidak terputus, mohon maaf claim jika ada kerusakan/kesalahan tidak bisa dibantu.

Terima kasih.$tpl$),

('refund_specific', $tpl$Halo {customer} 👋

Kami ingin menginformasikan bahwa barang berikut tidak tersedia dari event *{event}*:
{itemsList}

Sehingga perlu dilakukan pengembalian dana sebesar *{refundAmount}*.

Mohon balas pesan ini dengan informasi berikut:
- Nama Bank:
- Nomor Rekening:
- Nama Pemilik Rekening:

Terima kasih 🙏$tpl$),

('refund_generic', $tpl$Halo {customer} 👋

Kami ingin menginformasikan bahwa ada barang yang tidak tersedia dari event *{event}* sehingga perlu dilakukan pengembalian dana sebesar *{refundAmount}*.

Mohon balas pesan ini dengan informasi berikut:
- Nama Bank:
- Nomor Rekening:
- Nama Pemilik Rekening:

Terima kasih 🙏$tpl$)

ON CONFLICT (key) DO NOTHING;

-- Shared business identity fields. Single row (id always 1).
-- bankAccountHolder/bankAccountLines feed the invoice message's
-- {bankAccountHolder}/{bankAccountLines} tokens above; ownerName/storeName/
-- phoneNumber aren't wired into any message yet — stored for future use.
CREATE TABLE IF NOT EXISTS business_profile (
  id                  INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  bank_account_holder TEXT NOT NULL DEFAULT '',
  bank_account_lines  TEXT NOT NULL DEFAULT '',
  owner_name          TEXT NOT NULL DEFAULT '',
  store_name          TEXT NOT NULL DEFAULT '',
  phone_number        TEXT NOT NULL DEFAULT '',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO business_profile (id, bank_account_holder, bank_account_lines, owner_name, store_name, phone_number)
VALUES (1, 'Shinta Michiko', $lines$Bank Jago (Artos) 103382719370
Bank Central Asia 4419051991$lines$, '', 'Yubisayu', '')
ON CONFLICT (id) DO NOTHING;

-- Default values pre-filled into the Add Product form (overseas pricing).
-- Single row (id always 1). Editing this never touches already-saved
-- products — only what new ones start with.
CREATE TABLE IF NOT EXISTS product_defaults (
  id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  profit_pct      NUMERIC(6,2) NOT NULL DEFAULT 30,
  operational_fee INTEGER NOT NULL DEFAULT 5000,
  packing_fee     INTEGER NOT NULL DEFAULT 5000,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO product_defaults (id, profit_pct, operational_fee, packing_fee)
VALUES (1, 30, 5000, 5000)
ON CONFLICT (id) DO NOTHING;

-- Audit triggers, same idiom as 029_audit_log.sql / 033_operational_expenses.sql.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['message_templates', 'business_profile', 'product_defaults'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_%1$s ON %1$I', t);
    EXECUTE format(
      'CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I '
      'FOR EACH ROW EXECUTE FUNCTION audit.log_change()', t);
  END LOOP;
END
$$;
