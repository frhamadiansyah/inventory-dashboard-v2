// Shared business identity fields, edited once from /dashboard/settings and
// reused wherever a message needs them (today: the invoice's bank details;
// ownerName/storeName/phoneNumber aren't wired into any message yet, they're
// just stored for later).
//
// The DP threshold used to live here (migration 043) but moved to
// ProductDefaults (migration 057) — it's a pricing-adjacent setting, not
// business identity, and the Settings page groups it with the rest of the
// Pricing tab.

export interface BusinessProfile {
  bankAccountHolder: string
  /** One "Bank Name 123456789" per line. */
  bankAccountLines: string
  ownerName: string
  storeName: string
  phoneNumber: string
  /** Public order-status site, e.g. "Cek rekapan mandiri {publicSiteUrl}" in
   *  the invoice message and "Cek resi {publicSiteUrl}" in the shipment one. */
  publicSiteUrl: string
}

export const DEFAULT_BUSINESS_PROFILE: BusinessProfile = {
  bankAccountHolder: "Shinta Michiko",
  bankAccountLines: "Bank Jago (Artos) 103382719370\nBank Central Asia 4419051991",
  ownerName: "",
  storeName: "Yubisayu",
  phoneNumber: "",
  publicSiteUrl: "https://yubisayu-invoice.netlify.app/",
}
