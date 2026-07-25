import sql from "../db-pool"
import { normalizeId } from "./helpers"
import { lookupCustomerDetail } from "./customers"
import { getMessageTemplates, getBusinessProfile } from "./settings"
import { fillTemplate } from "../message-templates"
import type { BusinessProfile } from "../business-profile"
import type { InvoiceResult, InvoiceEvent, InvoiceShipment, InvoiceOrderLine, PublicInvoiceResult, PublicInvoiceEvent, PublicInvoiceOrderLine, PaymentRow, AdjustmentRow } from "./types"

// ─── Invoice ────────────────────────────────────────────────────────────────

function formatIdrNumber(n: number | null | undefined): string {
  const v = Number(n)
  return new Intl.NumberFormat("id-ID").format(Number.isFinite(v) ? v : 0)
}

function buildInvoiceMessage(
  event: Omit<InvoiceEvent, "message">,
  customer: string,
  template: string,
  profile: BusinessProfile,
  extraVars: Record<string, string> = {},
): string {
  const { orders, totals, invoice } = event
  const handle = customer.startsWith("@") ? customer : `@${customer}`
  // e.g. "Lip Balm x 2 x Rp 150,000" — o.order is "name x unit", o.price is the
  // formatted unit price.
  const produkLines = orders.map((o) => `${o.order} x Rp ${o.price}`).join("\n")

  const perKgCandidate = Number(invoice.ongkirPerKg)
  const perKg =
    Number.isFinite(perKgCandidate) && perKgCandidate > 0
      ? perKgCandidate
      : totals.weightKg > 0
        ? Math.round(invoice.estimasiOngkir / totals.weightKg)
        : 0

  const biayaLainnyaBlock = invoice.biayaLainnya !== 0
    ? `\nBiaya Lainnya: Rp ${formatIdrNumber(invoice.biayaLainnya)}`
    : ""

  return fillTemplate(template, {
    eventId: event.eventId,
    handle,
    produkLines,
    subtotalBarang: formatIdrNumber(invoice.subtotalBarang),
    weightKg: formatIdrNumber(totals.weightKg),
    perKgRate: formatIdrNumber(perKg),
    biayaLainnyaBlock,
    sisaPelunasan: formatIdrNumber(invoice.sisaPelunasan),
    bankAccountHolder: profile.bankAccountHolder,
    bankAccountLines: profile.bankAccountLines,
    publicSiteUrl: profile.publicSiteUrl,
    ...extraVars,
  })
}

function cleanResi(s: string): string {
  return s.trim().replace(/^['‘’ʹ`]+/, "")
}

function parseShipments(
  resiRaw: string,
  tanggalRaw: string,
  status: string,
): { shipments: InvoiceShipment[]; showShipments: boolean } {
  const resiList = resiRaw ? resiRaw.split("\n").map(cleanResi).filter(Boolean) : []
  const tanggalList = tanggalRaw
    ? tanggalRaw.split("\n").map((s) => s.trim()).filter(Boolean)
    : []
  const shipments = resiList.map((resi, i) => ({ resi, tanggalKirim: tanggalList[i] || "" }))
  const showShipments =
    shipments.length > 0 && (status === "Completed" || status.includes("Shipped"))
  return { shipments, showShipments }
}

// Porsager rows are string-indexed (any). These helpers read the order-row
// fields: event, unit, unit_price, unit_arrive, gram, event_eta.
type OrderRowLike = Record<string, any>

/** Group order rows by event, preserving first-seen order. */
function groupRowsByEvent<T extends OrderRowLike>(
  rows: readonly T[],
): { order: string[]; groups: Record<string, T[]> } {
  const groups: Record<string, T[]> = {}
  const order: string[] = []
  for (const row of rows) {
    const eid = String(row.event ?? "")
    if (!groups[eid]) {
      groups[eid] = []
      order.push(eid)
    }
    groups[eid].push(row)
  }
  return { order, groups }
}

/** Per-event totals + invoice math shared by the internal and public invoices. */
function computeEventCore(
  group: readonly OrderRowLike[],
  ongkirPerKg: number,
  pembayaran: number,
  biayaLainnya: number,
) {
  const unit = group.reduce((s, r) => s + Number(r.unit), 0)
  const subtotal = group.reduce((s, r) => s + Number(r.unit_price) * Number(r.unit), 0)
  const arrive = group.reduce((s, r) => s + Number(r.unit_arrive ?? 0), 0)
  const totalGram = group.reduce((s, r) => s + Number(r.gram ?? 0) * Number(r.unit), 0)
  const weightKg = Math.ceil(totalGram / 1000)
  const estimasiOngkir = ongkirPerKg * weightKg
  const total = subtotal + estimasiOngkir + biayaLainnya
  return {
    eta: String(group[0]?.event_eta ?? ""),
    totals: { unit, subtotal, arrive, weightKg },
    invoice: {
      subtotalBarang: subtotal,
      estimasiOngkir,
      ongkirPerKg,
      biayaLainnya,
      total,
      pembayaran,
      sisaPelunasan: total - pembayaran,
    },
  }
}

/**
 * Invoice data is computed by joining orders + products + customers.
 *
 * The old Google Sheets "Order_JanganDisort_DifilterAja" tab had ~31 columns
 * with many formulas. In SQL, we derive the same data from the orders table
 * joined with products (for price/weight) and customers (for ongkir rate).
 *
 * Columns that were manually entered in the invoice sheet (ETA, Status,
 * Pembayaran, BiayaLainnya, etc.) are NOT yet migrated — those would need
 * a dedicated `invoice_events` table. For now we return empty defaults for
 * those fields, matching what a fresh start provides.
 */
export async function getInvoiceForCustomer(
  instagramId: string,
  // lean: skip the message-template/business-profile reads and return
  // message: "" per event. The customer detail drawer doesn't render the
  // WhatsApp message text, and dropping those two queries keeps its fan-out
  // (this plus getCustomerLedger, doubled by dev StrictMode) inside the
  // pool's max. customerDetail is still fetched — the drawer does show it.
  //
  // ledger: payment/adjustment rows the caller already fetched (via
  // getCustomerLedger) — the per-event sums are computed from them in JS
  // instead of re-querying both tables. Callers must pass this customer's
  // complete ledger, nothing filtered.
  opts?: { lean?: boolean; ledger?: { payments: PaymentRow[]; adjustments: AdjustmentRow[] } },
): Promise<InvoiceResult> {
  const searchId = normalizeId(instagramId)
  const lean = opts?.lean === true
  const ledger = opts?.ledger

  const [orderRows, customerDetail, paymentRows, adjustmentRows, templates, businessProfile] = await Promise.all([
    sql`
      SELECT o.id, o.event, o.customer, o.unit, o.note,
             o.unit_price, o.product_id,
             o.unit_buy, o.receipt, o.unit_arrive, o.unit_ship, o.unit_hold,
             p.name AS product_name, COALESCE(p.store, '') AS store,
             COALESCE(p.gram, 0) AS gram,
             COALESCE(e.eta, '') AS event_eta,
             -- Ongkir for this order = the rate the customer pays from the
             -- event's warehouse (per-event routing).
             COALESCE(
               (SELECT s.ongkir
                  FROM shipments s
                 WHERE s.event = o.event
                   AND lower(replace(s.customer, '@', '')) = ${searchId}
                   AND s.tracking_number <> ''
                 ORDER BY s.id DESC
                 LIMIT 1),
               cwo.ongkos_kirim, 0
             ) AS ongkir
      FROM orders o
      JOIN products p ON p.id = o.product_id
      LEFT JOIN events e ON e.name = o.event
      LEFT JOIN customers c ON lower(replace(c.instagram_id, '@', '')) = ${searchId}
      LEFT JOIN customer_warehouse_ongkir cwo
        ON cwo.customer_id = c.id AND cwo.warehouse_id = e.warehouse_id
      WHERE lower(replace(o.customer, '@', '')) = ${searchId}
      -- Newest event first, matching the public customer recap
      -- (getPublicInvoiceForCustomer). groupRowsByEvent keeps this row order,
      -- so events surface by creation date (desc); o.id keeps each event's
      -- lines stable. NULLS LAST guards an orphaned event name.
      ORDER BY e.created_at DESC NULLS LAST, o.event, o.id
    `,
    lookupCustomerDetail(instagramId),
    // Only checked payments count toward the invoice's paid total; the JS
    // branch below must mirror the is_checked filter here.
    ledger ? null : sql`
      SELECT event, COALESCE(SUM(amount), 0) AS total_paid
      FROM payments
      WHERE lower(replace(customer, '@', '')) = ${searchId}
        AND is_checked = true
      GROUP BY event
    `,
    ledger ? null : sql`
      SELECT event, COALESCE(SUM(amount), 0) AS total_adj
      FROM adjustments
      WHERE lower(replace(customer, '@', '')) = ${searchId}
      GROUP BY event
    `,
    lean ? null : getMessageTemplates(),
    lean ? null : getBusinessProfile(),
  ])

  if (orderRows.length === 0) {
    return { customer: "", customerDetail, events: [] }
  }

  const customer = orderRows[0].customer

  const paymentByEvent = new Map<string, number>()
  const adjustmentByEvent = new Map<string, number>()
  if (ledger) {
    for (const p of ledger.payments) {
      if (!p.isChecked) continue
      paymentByEvent.set(p.event, (paymentByEvent.get(p.event) ?? 0) + p.amount)
    }
    for (const a of ledger.adjustments) {
      adjustmentByEvent.set(a.event, (adjustmentByEvent.get(a.event) ?? 0) + a.amount)
    }
  } else {
    for (const r of paymentRows!) paymentByEvent.set(r.event, Number(r.total_paid))
    for (const r of adjustmentRows!) adjustmentByEvent.set(r.event, Number(r.total_adj))
  }

  const { order, groups } = groupRowsByEvent(orderRows)

  const events: InvoiceEvent[] = order.map((eid) => {
    const group = groups[eid]

    const orders: InvoiceOrderLine[] = group.map((r) => ({
      order: `${r.product_name} x ${r.unit}`,
      unit: r.unit,
      price: formatIdrNumber(r.unit_price),
      subtotal: formatIdrNumber(r.unit_price * r.unit),
      unitArrive: r.unit_arrive ?? 0,
      orderId: r.id as number,
      productName: r.product_name as string,
      rawUnitPrice: r.unit_price as number,
      unitBuy: (r.unit_buy as number) ?? 0,
    }))

    const { eta, totals, invoice } = computeEventCore(
      group,
      Number(group[0]?.ongkir ?? 0),
      paymentByEvent.get(eid) ?? 0,
      adjustmentByEvent.get(eid) ?? 0,
    )

    const base = {
      eventId: eid,
      eta,
      status: "",
      shipments: [] as InvoiceShipment[],
      showShipments: false,
      orders,
      totals,
      invoice,
    }
    // DP is a percentage of the goods subtotal (subtotal barang) — excludes
    // ongkir and adjustments.
    const dpThreshold = invoice.subtotalBarang * ((businessProfile?.dpPercent ?? 0) / 100)
    const meetsDpThreshold = invoice.subtotalBarang === 0 || invoice.pembayaran >= dpThreshold

    let message = ""
    if (templates && businessProfile) {
      message = meetsDpThreshold
        ? buildInvoiceMessage(base, customer, templates.invoice, businessProfile)
        : buildInvoiceMessage(base, customer, templates.invoice_dp, businessProfile, {
            dpPercent: String(businessProfile.dpPercent),
            dpAmount: formatIdrNumber(Math.round(dpThreshold)),
            dpShortfall: formatIdrNumber(Math.round(Math.max(0, dpThreshold - invoice.pembayaran))),
          })
    }

    return { ...base, message }
  })

  return { customer, customerDetail, events }
}

function formatShipDate(d: Date | string | null | undefined): string {
  if (!d) return ""
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" })
}

/**
 * Derive the order status the recap page shows, from unit tracking + resi
 * presence. Mirrors the labels documented in the public site's status popup:
 *   Pending           — barang belum lengkap (not all units arrived)
 *   Processing        — barang sudah lengkap, antri packing (all arrived, none shipped)
 *   Partially Shipped — dikirim sebagian
 *   Shipped           — dikirim lengkap, menunggu resi (all shipped, no resi yet)
 *   Completed         — resi sudah dapat diakses (all shipped + resi present)
 */
function derivePublicStatus(group: readonly OrderRowLike[], hasResi: boolean): string {
  const totalUnit = group.reduce((s, r) => s + Number(r.unit), 0)
  if (totalUnit <= 0) return ""
  const totalArrive = group.reduce((s, r) => s + Number(r.unit_arrive ?? 0), 0)
  const totalShip = group.reduce((s, r) => s + Number(r.unit_ship ?? 0), 0)
  if (totalShip >= totalUnit) return hasResi ? "Completed" : "Shipped"
  if (totalShip > 0) return "Partially Shipped"
  if (totalArrive >= totalUnit) return "Processing"
  return "Pending"
}

/**
 * Public, no-login invoice lookup for the customer-facing recap site.
 *
 * Deliberately separate from getInvoiceForCustomer: it returns ONLY orders,
 * payment status, derived shipping status, and tracking numbers (what the
 * public page shows) and reads ONLY ongkos_kirim from customers — never name,
 * WhatsApp, data_diri, or bank details. Pass the read-only `invoice_reader`
 * connection (lib/db-public.ts) as `db` so the PII columns are physically
 * unreadable on this path. The seller's payment/bank block is a frontend
 * constant and is intentionally not returned here.
 */
export async function getPublicInvoiceForCustomer(
  instagramId: string,
  db: typeof sql,
): Promise<PublicInvoiceResult> {
  const searchId = normalizeId(instagramId)

  const [orderRows, paymentRows, adjustmentRows, shipmentRows] = await Promise.all([
    db`
      SELECT o.event, o.customer, o.unit, o.unit_price, o.unit_arrive, o.unit_ship,
             p.name AS product_name, COALESCE(p.gram, 0) AS gram,
             COALESCE(e.eta, '') AS event_eta,
             -- Per-event ongkir: the rate from the event's warehouse. The
             -- invoice_reader role can read customer id + the join table but
             -- still cannot read name/whatsapp/bank columns.
             COALESCE(
               (SELECT s.ongkir
                  FROM shipments s
                 WHERE s.event = o.event
                   AND lower(replace(s.customer, '@', '')) = ${searchId}
                   AND s.tracking_number <> ''
                 ORDER BY s.id DESC
                 LIMIT 1),
               cwo.ongkos_kirim, 0
             ) AS ongkir
      FROM orders o
      JOIN products p ON p.id = o.product_id
      LEFT JOIN events e ON e.name = o.event
      LEFT JOIN customers c ON lower(replace(c.instagram_id, '@', '')) = ${searchId}
      LEFT JOIN customer_warehouse_ongkir cwo
        ON cwo.customer_id = c.id AND cwo.warehouse_id = e.warehouse_id
      WHERE lower(replace(o.customer, '@', '')) = ${searchId}
      -- Newest event first on the customer recap. groupRowsByEvent keeps this
      -- row order, so events surface by creation date (desc); o.id keeps each
      -- event's lines stable. NULLS LAST guards an orphaned event name.
      ORDER BY e.created_at DESC NULLS LAST, o.event, o.id
    `,
    db`
      SELECT event, COALESCE(SUM(amount), 0) AS total_paid
      FROM payments
      WHERE lower(replace(customer, '@', '')) = ${searchId}
        AND is_checked = true
      GROUP BY event
    `,
    db`
      SELECT event, COALESCE(SUM(amount), 0) AS total_adj
      FROM adjustments
      WHERE lower(replace(customer, '@', '')) = ${searchId}
      GROUP BY event
    `,
    db`
      SELECT event, tracking_number, created_at
      FROM shipments
      WHERE lower(replace(customer, '@', '')) = ${searchId}
        AND tracking_number != ''
      ORDER BY event, id
    `,
  ])

  if (orderRows.length === 0) return { customer: "", events: [] }

  const customer = String(orderRows[0].customer ?? "")

  const paymentByEvent = new Map<string, number>()
  for (const r of paymentRows) paymentByEvent.set(r.event, Number(r.total_paid))

  const adjustmentByEvent = new Map<string, number>()
  for (const r of adjustmentRows) adjustmentByEvent.set(r.event, Number(r.total_adj))

  const shipmentsByEvent = new Map<string, InvoiceShipment[]>()
  for (const r of shipmentRows) {
    const list = shipmentsByEvent.get(r.event) ?? []
    list.push({ resi: cleanResi(String(r.tracking_number)), tanggalKirim: formatShipDate(r.created_at) })
    shipmentsByEvent.set(r.event, list)
  }

  const { order, groups } = groupRowsByEvent(orderRows)

  const events: PublicInvoiceEvent[] = order.map((eid) => {
    const group = groups[eid]

    const orders: PublicInvoiceOrderLine[] = group.map((r) => ({
      order: `${r.product_name} x ${r.unit}`,
      unit: r.unit,
      price: formatIdrNumber(r.unit_price),
      subtotal: formatIdrNumber(r.unit_price * r.unit),
      unitArrive: r.unit_arrive ?? 0,
    }))

    const { eta, totals, invoice } = computeEventCore(
      group,
      Number(group[0]?.ongkir ?? 0),
      paymentByEvent.get(eid) ?? 0,
      adjustmentByEvent.get(eid) ?? 0,
    )

    const shipments = shipmentsByEvent.get(eid) ?? []
    const status = derivePublicStatus(group, shipments.length > 0)
    const showShipments =
      shipments.length > 0 && (status === "Completed" || status.includes("Shipped"))

    return { eventId: eid, eta, status, shipments, showShipments, orders, totals, invoice }
  })

  return { customer, events }
}

