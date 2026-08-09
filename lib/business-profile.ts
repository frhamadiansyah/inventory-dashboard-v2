// Shared business identity fields, edited once from /dashboard/settings and
// reused wherever a message needs them (today: the invoice's bank details
// and DP threshold; ownerName/storeName/phoneNumber aren't wired into any
// message yet, they're just stored for later).

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
  /** % of an event's invoice total that must be paid before the default
   *  invoice message is sent instead of the invoice_dp reminder (see
   *  lib/db/invoice.ts). Whole number (30 means 30%), not a fraction. 0
   *  disables the feature — every event always meets a 0% threshold. */
  dpPercent: number
}

export const DEFAULT_BUSINESS_PROFILE: BusinessProfile = {
  bankAccountHolder: "Shinta Michiko",
  bankAccountLines: "Bank Jago (Artos) 103382719370\nBank Central Asia 4419051991",
  ownerName: "",
  storeName: "Yubisayu",
  phoneNumber: "",
  publicSiteUrl: "https://yubisayu-invoice.netlify.app/",
  dpPercent: 0,
}
