// Shared types for the db/* modules.

import type { PaymentStatus } from "./finance"
import type { PricingMethod } from "@/lib/pricing"
import type { TierFeeMode } from "@/lib/tier-fee"

// ─── Types (same interfaces as the old sheets.ts) ───────────────────────────

export interface ItemOption {
  id: number
  name: string
  store: string
  price: number
  /** False when the product is deactivated — the List Order item picker drops
   *  inactive items; every other picker ignores this flag and shows them all. */
  active: boolean
}

export interface SheetOptions {
  events: string[]
  /** Subset of `events` that are active. Only the List Order event picker uses
   *  this; the other pickers keep using the full `events` list. */
  activeEvents: string[]
  items: ItemOption[]
  customers: string[]
  /** Canonical customer handle → mobile (whatsapp), shown as the customer
   *  picker's right-aligned meta. Absent/empty when the customer has no number. */
  customerMobiles: Record<string, string>
  /** Distinct payment accounts in use (e.g. "BCA", "JAGO") — the Payments
   *  page's Account field is free text with autocomplete, not a fixed set. */
  accounts: string[]
}

export interface OrderRow {
  event: string
  customer: string
  productId: number
  unitPrice: number
  unit: number
  note: string
}

export interface FormRow {
  rowNumber: number
  event: string
  customer: string
  productId: number
  items: string
  unitPrice: number
  unit: number
  note: string
  createdAt: string
  updatedAt: string
  unitBuy: number | null
  receipt: string
  unitArrive: number | null
  unitShip: number | null
  unitDispatch: number | null
  dispatchReceipt: string
  unitHold: number | null
  // True when the customer's data_diri (free-text address blob) is filled.
  // Joined from the customers table by normalized handle; the List Order page
  // shows an amber warning icon when this is false.
  hasAddress: boolean
}

export type ExcessReason = "overbuy" | "overship" | "wrong_product" | "broken" | "missing" | "customer_cancelled" | "manual"

export interface ExcessRow {
  rowNumber: number
  event: string
  items: string
  unitBuy: number
  receipt: string
  reason: ExcessReason
  expectedItem: string
  createdAt: string
  updatedAt: string
  /** Item's sell price, joined by name from products — only populated by the
   *  paginated fetch (for display); undefined elsewhere. */
  price?: number | null
}

export interface PurchaseUpdate {
  rowNumber: number
  unitBuy: number
  receipt: string
}

export interface ArriveUpdate {
  rowNumber: number
  unitArrive: number
}

export interface DispatchUpdate {
  rowNumber: number
  unitDispatch: number
  dispatchReceipt: string
}

export interface InvoiceOrderLine {
  order: string
  unit: number
  price: string
  subtotal: string
  unitArrive: number
  // Raw fields for pre-filling the refund / cancel modals
  orderId: number
  productName: string
  rawUnitPrice: number
  // Units purchased for this line — how many can return to Inventory on a
  // customer cancellation (0 when not yet bought).
  unitBuy: number
}

export interface InvoiceShipment {
  resi: string
  tanggalKirim: string
}

export interface InvoiceEvent {
  eventId: string
  eta: string
  status: string
  shipments: InvoiceShipment[]
  showShipments: boolean
  orders: InvoiceOrderLine[]
  totals: { unit: number; subtotal: number; arrive: number; weightKg: number }
  invoice: {
    subtotalBarang: number
    estimasiOngkir: number
    ongkirPerKg: number
    biayaLainnya: number
    total: number
    pembayaran: number
    sisaPelunasan: number
  }
  message: string
}

export interface ShipOrderLine {
  rowNumber: number
  event: string
  items: string
  productId: number
  productName: string
  gram: number
  unit: number
  unitPrice: number
  unitArrive: number
  unitShip: number
  unitHold: number
  toShip: number
}

export interface CustomerDetail {
  name: string
  whatsapp: string
  dataDiri: string
  ekspedisi: string
  bankName: string
  bankAccountNumber: string
  bankAccountHolder: string
}

// Per-warehouse shipping rate, keyed by warehouse id. The shipping cost a
// customer pays now depends on which warehouse an order ships from (the event's
// warehouse), so a single ongkos_kirim is replaced by this map.
export type OngkirByWarehouse = Record<number, number>

export interface CustomerRow {
  id: number
  instagramId: string
  name: string
  whatsapp: string
  dataDiri: string
  ekspedisi: string
  ongkir: OngkirByWarehouse
  bankName: string
  bankAccountNumber: string
  bankAccountHolder: string
  // Invoice roll-up from customer_invoice_summary (0 for callers that don't
  // join it, e.g. the full getCustomers list). totalOutstanding > 0 = owes,
  // < 0 = overpaid, 0 = settled. Voids excluded from invoiceCount.
  invoiceCount: number
  totalInvoiced: number
  totalOutstanding: number
  createdAt: string | null
  updatedAt: string | null
}

export interface CustomerInput {
  instagramId: string
  name: string
  whatsapp: string
  dataDiri: string
  ekspedisi: string
  ongkir: OngkirByWarehouse
  bankName: string
  bankAccountNumber: string
  bankAccountHolder: string
}

export interface WarehouseRow {
  id: number
  code: string
  name: string
  isDefault: boolean
}

// Free text — "overpayment" stays special-cased in code (materializeOverpaymentRefunds,
// the apply-as-credit flow, the one-active-overpayment unique index), but any other
// reason is just a label. REFUND_REASONS are the suggested presets in the picker.
export type RefundReason = string
export const REFUND_REASONS: RefundReason[] = ["overpayment", "unavailable", "shipping_loss", "damaged", "goodwill", "other"]
export type RefundStatus = "pending" | "awaiting_bank_info" | "ready_to_refund" | "refunded" | "applied_to_next_order" | "cancelled"

export interface RefundRow {
  id: number
  event: string
  customer: string
  reason: RefundReason
  refundAmount: number
  status: RefundStatus
  bankName: string
  bankAccountNumber: string
  bankAccountHolder: string
  transferReference: string
  paymentId: number | null
  orderId: number | null
  affectedUnits: number
  note: string
  /** True when this refund has linked `credit` payments — i.e. some/all of it
   *  was applied to another order and can be undone. */
  hasAppliedCredit: boolean
  /** Total applied as credit to other orders (sum of the +credit legs). For a
   *  fully-applied refund `refundAmount` is 0 (no overpayment remaining), so the
   *  UI shows this instead. */
  appliedCreditAmount: number
  /** Current live overpayment (totalPaid − invoiceTotal) for this refund's
   *  (customer, event), when it differs from the stored `refundAmount` and the
   *  auto-reconcile can't fix it (credit already applied). null when in sync or
   *  not applicable — a non-null value means "review": the invoice changed after
   *  credit was applied, so the stored amount is stale. */
  liveOverpayment: number | null
  createdAt: string | null
  updatedAt: string | null
}

/**
 * Arrival/ship state of a whole (customer, event) invoice, arrival-first:
 *   not_arrived — nothing has arrived yet
 *   partial       — some lines arrived but not every line is fully arrived
 *   ready         — fully arrived, units to ship, AND invoice is paid/overpaid
 *   ready_unpaid  — fully arrived with units to ship, but payment is not in yet
 *                   (split out from "ready" so ops can see what's payment-blocked)
 *   hold          — customer asked to delay shipment (usually to combine with a
 *                   later event); unit_hold absorbs the toShip qty so the card
 *                   drops out of "ready" until released.
 *   shipped       — every line fully arrived AND nothing left to ship
 */
export type ShipStatus = "not_arrived" | "partial" | "ready" | "ready_unpaid" | "hold" | "shipped"

export interface ShipCustomer {
  customer: string
  event: string
  customerDetail: CustomerDetail | null
  orders: ShipOrderLine[]
  totalToShip: number
  weightKg: number
  ongkirPerKg: number
  status: ShipStatus
  paymentStatus: PaymentStatus
}

export interface InvoiceResult {
  customer: string
  customerDetail: CustomerDetail | null
  events: InvoiceEvent[]
}

// Minimal, PII-free shape for the public no-login invoice recap. Mirrors what
// the customer-facing page renders — orders + payment status — and nothing else.
export interface PublicInvoiceOrderLine {
  order: string
  unit: number
  price: string
  subtotal: string
  unitArrive: number
}

export interface PublicInvoiceEvent {
  eventId: string
  eta: string
  status: string
  shipments: InvoiceShipment[]
  showShipments: boolean
  orders: PublicInvoiceOrderLine[]
  totals: { unit: number; subtotal: number; arrive: number; weightKg: number }
  invoice: {
    subtotalBarang: number
    estimasiOngkir: number
    ongkirPerKg: number
    biayaLainnya: number
    total: number
    pembayaran: number
    sisaPelunasan: number
  }
}

export interface PublicInvoiceResult {
  customer: string
  events: PublicInvoiceEvent[]
}

export interface ShipOrdersParams {
  customer: string
  event: string
  orders: Array<{ rowNumber: number; productId: number; productName: string; toShip: number; unitShip: number }>
  weightKg: number
  ongkirPerKg: number
  // Optional one-time receiving address. When provided, persisted on the
  // resulting shipment row so reprints/messages render this address instead of
  // the customer's profile data_diri.
  tempAddress?: string | null
}

/**
 * "Ship together": one customer's ready orders across several events shipped as
 * a single physical package. One shipment row is written per event (linked by a
 * merge_group), the combined weight/ongkir lands on the primary row, and a
 * single negative "Gabung ongkir" adjustment bills shipping once.
 */
export interface ShipMergedParams {
  customer: string
  ongkirPerKg: number
  groups: Array<{
    event: string
    orders: Array<{ rowNumber: number; productName: string; toShip: number; gram: number }>
  }>
  // Optional one-time receiving address for the combined package. Written to
  // every row in the merge_group so any reprint path renders it consistently.
  tempAddress?: string | null
}

export interface ShipMergedResult {
  mergeGroup: string
  shippingId: string        // the primary row's id (used for the combined label)
  shippingIds: string[]
  discount: number          // the merged-shipping ongkir discount applied (Rp)
  combinedKg: number        // physical weight of the combined package
  combinedOngkir: number    // physical ongkir of the combined package (Rp)
}

export interface ShippingRecord {
  rowNumber: number
  event: string
  customer: string
  customerName: string  // joined from customers.name; "" when unknown/backfill missed
  shippingId: string
  invoicing: string
  weightEstimation: number
  ongkir: number
  ongkirTotal: number
  isLastShipment: boolean
  createdAt: string
  updatedAt: string
  // Epoch ms for chronological sorting — createdAt/updatedAt are localized
  // display strings (DD/MM/YYYY …) that don't sort by date as text. 0 when null.
  createdAtTs: number
  updatedAtTs: number
  trackingNumber: string
  // Non-null when this row is part of a "Ship together" merged package; all
  // rows sharing the id were one physical shipment (one box, one resi).
  mergeGroup: string | null
  // One-time override of the receiving address. When set, label generation,
  // reprints, and the shipment confirmation message all use this instead of
  // the customer's profile data_diri. Persisted on every row of a merge_group.
  tempAddress: string | null
}

export interface CountryRow {
  id: number
  name: string
  currency: string
  kurs: number
  cargoPerKg: number
  createdAt: string
  updatedAt: string
}

/**
 * One Tier Kurs bracket: from `minValas` upward, charge `kurs` instead of the
 * country's flat rate. `minValas` is INCLUSIVE and the highest matching minimum
 * wins — the resolution itself lives in lib/kurs-tiers.ts.
 */
export interface KursTierRow {
  id: number
  countryId: number
  minValas: number
  kurs: number
  createdAt: string
  updatedAt: string
}

/**
 * One Tier Fee bracket: from `minBase` upward, charge this much
 * fixed profit. `minBase` is INCLUSIVE and the highest matching minimum wins — the
 * resolution lives in lib/tier-fee.ts.
 *
 * A SUGGESTION for the Add Product form, not a stored pricing rule: see
 * migration 051.
 */
export interface TierFeeBracketRow {
  id: number
  /** null = the rupiah scope; a number = that country's valas scope. */
  countryId: number | null
  minBase: number
  feeMode: TierFeeMode
  feeValue: number
  createdAt: string
  updatedAt: string
}

export interface ProductRow {
  id: number
  name: string
  store: string
  price: number
  gram: number
  countryId: number | null
  countryName: string
  valas: number
  kurs: number
  /** The tiered rate this row was priced with, snapshotted at save time like
   *  `kurs`. Null unless pricingMethod is "tier_kurs". See lib/kurs-tiers.ts. */
  tieredKurs: number | null
  /** The fee this row was priced with, in the country's currency, snapshotted at
   *  save time like `kurs`. Null unless pricingMethod is "tier_fee" AND the row has
   *  a country (valas mode). See lib/tier-fee.ts. */
  feeValas: number | null
  cargoPerKg: number
  profitPct: number
  operationalFee: number
  packingFee: number
  cost: number
  profitFixed: number
  /** Which formula prices this row. Replaced `country_id IS NULL` as the
   *  discriminator in migration 050 — a Tier Kurs product has a country but must
   *  not use the overseas formula. */
  pricingMethod: PricingMethod
  /** False when deactivated — hidden from the List Order item picker. */
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface ProductIndoRow {
  rowNumber: number
  product: string
  store: string
  price: number
  createdAt: string
  updatedAt: string
}

/** deposit = money in · refund = cash out · credit = internal overpayment transfer */
export type PaymentKind = "deposit" | "refund" | "credit"

export interface PaymentRow {
  rowNumber: number
  event: string
  customer: string
  amount: number
  account: string
  isChecked: boolean
  payDate: string
  remarks: string
  kind: PaymentKind
  createdAt: string
  updatedAt: string
}

export interface AdjustmentRow {
  rowNumber: number
  event: string
  customer: string
  description: string
  amount: number
  createdAt: string
  updatedAt: string
}

/** Free text (no DB constraint, same as `method`) — users can add new
 *  categories on the fly via the dashboard's SearchableSelect+allowNewValue. */
export type ExpenseCategory = string

/** Suggested categories offered in the picker; not an exhaustive list. */
export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  "Flight", "Lodging", "Cargo", "Meal", "Transport", "Shop",
  "Supplies", "Delivery", "Personal", "Payroll", "Dividend", "Other"
]

/** One operational expense row (replaces the "Operational_2026" sheet). */
export interface OperationalExpenseRow {
  rowNumber: number
  event: string
  /** ISO date (YYYY-MM-DD), or "" when unset. */
  expenseDate: string
  description: string
  category: ExpenseCategory
  /** Cost in the currency it was paid in (the "# VLS" column). */
  amountForeign: number
  /** IDR per unit of foreign currency (the "Kurs" column); 1 for IDR rows. */
  rate: number
  /** Cost in rupiah (the "IDR" column). */
  amountIdr: number
  isSettled: boolean
  /** Payment method — card last-4, account label, etc. */
  method: string
  remarks: string
  createdAt: string
  updatedAt: string
}

