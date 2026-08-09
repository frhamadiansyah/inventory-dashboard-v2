// Freeform, owner-editable wording for the customer-facing messages the app
// builds (invoice, shipment confirmation, refund). Each template is one body
// of text with {token} placeholders for the data-dependent parts; everything
// else is free text the owner controls from /dashboard/settings.
//
// REQUIRED_TOKENS is the save-time safeguard: a template missing one of its
// required tokens would silently print "{token}" (or drop data) once sent, so
// both the settings UI and the PATCH route reject a save that's missing any.

export type TemplateKey = "invoice" | "invoice_dp" | "shipment" | "refund_specific" | "refund_generic"

export const TEMPLATE_KEYS: TemplateKey[] = ["invoice", "invoice_dp", "shipment", "refund_specific", "refund_generic"]

export const REQUIRED_TOKENS: Record<TemplateKey, string[]> = {
  invoice: [
    "{eventId}", "{handle}", "{produkLines}", "{subtotalBarang}", "{weightKg}", "{perKgRate}", "{sisaPelunasan}",
    "{bankAccountHolder}", "{bankAccountLines}", "{publicSiteUrl}",
  ],
  invoice_dp: [
    "{eventId}", "{handle}", "{produkLines}", "{subtotalBarang}", "{weightKg}", "{perKgRate}",
    "{dpPercent}", "{dpAmount}", "{dpShortfall}", "{bankAccountHolder}", "{bankAccountLines}", "{publicSiteUrl}",
  ],
  shipment: ["{event}", "{handle}", "{dataDiri}", "{items}", "{publicSiteUrl}"],
  refund_specific: ["{customer}", "{event}", "{itemsList}", "{refundAmount}"],
  refund_generic: ["{customer}", "{event}", "{refundAmount}"],
}

// Tokens allowed but not mandatory — currently the invoice/invoice_dp fee
// line, plus invoice_dp's optional full-remaining-balance figure.
export const OPTIONAL_TOKENS: Record<TemplateKey, string[]> = {
  invoice: ["{biayaLainnyaBlock}"],
  invoice_dp: ["{biayaLainnyaBlock}", "{sisaPelunasan}"],
  shipment: [],
  refund_specific: [],
  refund_generic: [],
}

export const DEFAULT_TEMPLATES: Record<TemplateKey, string> = {
  invoice: [
    "INVOICE",
    "{eventId} {handle}",
    "",
    "Produk:",
    "{produkLines}",
    "",
    "Subtotal Barang: Rp {subtotalBarang}",
    "Estimasi Ongkir: {weightKg} kg x Rp {perKgRate}{biayaLainnyaBlock}",
    "",
    "Pelunasan: Rp {sisaPelunasan}",
    "",
    "Rekening an {bankAccountHolder}:",
    "{bankAccountLines}",
    "",
    "Apabila memesan lebih dari 1 barang, transfer boleh digabung.",
    "",
    "Cek rekapan mandiri {publicSiteUrl}",
    "",
    "Jika ada kesalahan/kekurangan rekap, mohon infokan kembali untuk direvisi.",
  ].join("\n"),

  invoice_dp: [
    "INVOICE - DOWN PAYMENT",
    "{eventId} {handle}",
    "",
    "Produk:",
    "{produkLines}",
    "",
    "Subtotal Barang: Rp {subtotalBarang}",
    "Estimasi Ongkir: {weightKg} kg x Rp {perKgRate}{biayaLainnyaBlock}",
    "",
    "Down Payment yang dibutuhkan: {dpPercent}% (Rp {dpAmount})",
    "Kekurangan Down Payment: Rp {dpShortfall}",
    "",
    "Rekening an {bankAccountHolder}:",
    "{bankAccountLines}",
    "",
    "Mohon lakukan pembayaran down payment agar pesanan diproses.",
    "",
    "Cek rekapan mandiri {publicSiteUrl}",
  ].join("\n"),

  shipment: [
    "Konfirmasi Pengiriman Yubisayu",
    "{event} {handle}",
    "",
    "{dataDiri}",
    "",
    "{items}",
    "",
    "Paket sedang dikemas dan akan segera dikirim.",
    "",
    "Cek kembali detail pesanan (jumlah, ukuran, warna jika ada) dan alamat, info jika ada perubahan alamat.",
    "",
    "Cek resi {publicSiteUrl} atau WA Channel.",
    "",
    "Mohon konfirmasi jika paket sudah diterima.",
    "",
    "Sebelum dikirim, barang dicek dan dikirim dalam kondisi baik. Paket dikirim oleh ekspedisi, wajib video unboxing tanpa terputus.",
    "",
    "Tanpa video unboxing tidak terputus, mohon maaf claim jika ada kerusakan/kesalahan tidak bisa dibantu.",
    "",
    "Terima kasih.",
  ].join("\n"),

  refund_specific: [
    "Halo {customer} 👋",
    "",
    "Kami ingin menginformasikan bahwa barang berikut tidak tersedia dari event *{event}*:",
    "{itemsList}",
    "",
    "Sehingga perlu dilakukan pengembalian dana sebesar *{refundAmount}*.",
    "",
    "Mohon balas pesan ini dengan informasi berikut:",
    "- Nama Bank:",
    "- Nomor Rekening:",
    "- Nama Pemilik Rekening:",
    "",
    "Terima kasih 🙏",
  ].join("\n"),

  refund_generic: [
    "Halo {customer} 👋",
    "",
    "Kami ingin menginformasikan bahwa ada barang yang tidak tersedia dari event *{event}* sehingga perlu dilakukan pengembalian dana sebesar *{refundAmount}*.",
    "",
    "Mohon balas pesan ini dengan informasi berikut:",
    "- Nama Bank:",
    "- Nomor Rekening:",
    "- Nama Pemilik Rekening:",
    "",
    "Terima kasih 🙏",
  ].join("\n"),
}

// Single pass so substituted values are never re-scanned — a customer-typed
// value containing a literal "{token}" must come through verbatim, not expand.
// Unknown {tokens} are left as-is (visible in the message, easy to spot).
export function fillTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  )
}

/** Returns the required tokens (e.g. "{customer}") missing from `body`, if any. */
export function findMissingTokens(body: string, key: TemplateKey): string[] {
  return REQUIRED_TOKENS[key].filter((token) => !body.includes(token))
}
