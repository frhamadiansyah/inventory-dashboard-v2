import { randomUUID } from "node:crypto"
import sql from "../db-pool"
import { normalizeId, normalizeCustomer, tsToString } from "./helpers"
import { allocateFifo } from "../fifo-fill"
import type { DBExecutor } from "./actor"
import type { ShipOrderLine, ShipCustomer, ShipStatus, ShipOrdersParams, ShipMergedParams, ShipMergedResult, ShippingRecord, CustomerDetail } from "./types"
import { getPaymentStatus, type PaymentStatus } from "./finance"
import { fetchPaidStatusMap, compareOrderPriority, type PaidStatus } from "./shopping-list"

// ─── Ship Orders ────────────────────────────────────────────────────────────

function buildSearchFilters(opts: { event?: string; search?: string }) {
  const conditions: string[] = []
  const params: (string | number)[] = []
  if (opts.event) {
    params.push(opts.event)
    conditions.push(`o.event = $${params.length}`)
  }
  if (opts.search) {
    params.push(`%${normalizeId(opts.search)}%`)
    conditions.push(`lower(replace(o.customer, '@', '')) LIKE $${params.length}`)
  }
  return { conditions, params }
}

function buildShipGroups(
  orderRows: Record<string, unknown>[],
  detailMap: Map<string, CustomerDetail>,
  paymentMap: Map<string, PaymentStatus>,
  ongkirMap: Map<string, number>,
): ShipCustomer[] {
  const groupMap = new Map<string, { customer: string; event: string; rows: Record<string, unknown>[] }>()
  for (const row of orderRows) {
    const key = `${normalizeId(row.customer as string)}|${row.event}`
    if (!groupMap.has(key)) groupMap.set(key, { customer: row.customer as string, event: row.event as string, rows: [] })
    groupMap.get(key)!.rows.push(row)
  }

  return Array.from(groupMap.values()).flatMap(({ customer, event, rows }) => {
    const customerKey = normalizeId(customer)
    // Lines with unit === 0 are cancelled (missing/wrong-product/broken arrival,
    // or a fully-voided order) — nothing to receive or ship, so drop them from
    // the packing list entirely rather than let them park a card in "Belum Tiba".
    const orders: ShipOrderLine[] = rows
      .filter((r) => ((r.unit as number) ?? 0) > 0)
      .map((r) => {
        const unitArrive = (r.unit_arrive as number) ?? 0
        const unitShip = (r.unit_ship as number) ?? 0
        const unitHold = (r.unit_hold as number) ?? 0
        return {
          rowNumber: r.id as number,
          event,
          items: `${r.product_name} x ${r.unit}`,
          productId: r.product_id as number,
          productName: r.product_name as string,
          gram: (r.gram as number) ?? 0,
          unit: r.unit as number,
          unitPrice: (r.unit_price as number) ?? 0,
          unitArrive,
          unitShip,
          unitHold,
          toShip: Math.max(0, unitArrive - unitShip - unitHold),
        }
      })
    if (orders.length === 0) return []
    const totalToShipGram = orders.reduce((s, o) => s + o.gram * o.toShip, 0)
    const totalToShip = orders.reduce((s, o) => s + o.toShip, 0)
    const totalHold = orders.reduce((s, o) => s + o.unitHold, 0)
    const ongkirPerKg = ongkirMap.get(`${customerKey}|${event}`) ?? 0

    // Arrival-first status: compare arrived vs ordered units per line.
    const anyArrived = orders.some((o) => o.unitArrive > 0)
    const allArrived = orders.every((o) => o.unitArrive >= o.unit)
    // Default "unpaid" when no payment row exists (e.g. a customer who never had
    // orders/payments tied to this event yet) — keeps physically-ready cards
    // out of "Siap Dikirim" by default rather than slipping through.
    const paymentStatus: PaymentStatus = paymentMap.get(`${customerKey}|${event}`) ?? "unpaid"
    // "void" counts as clear: a zeroed invoice (e.g. offset by a Personal
    // Expense adjustment) has nothing to pay, so payment can't block shipping.
    const paymentClear = paymentStatus === "paid" || paymentStatus === "overpaid" || paymentStatus === "void"
    // "hold" wins over ready/shipped when any unit is parked — the customer
    // asked to wait, so we surface that even if some other units already went out.
    const status: ShipStatus = !anyArrived
      ? "not_arrived"
      : !allArrived
        ? "partial"
        : totalHold > 0
          ? "hold"
          : totalToShip > 0
            ? (paymentClear ? "ready" : "ready_unpaid")
            : "shipped"

    return [{
      customer,
      event,
      customerDetail: detailMap.get(customerKey) ?? null,
      orders,
      totalToShip,
      // Billed weight is rounded up to the next whole kg (courier-style),
      // matching how invoices compute ongkir.
      weightKg: Math.ceil(totalToShipGram / 1000),
      ongkirPerKg,
      status,
      paymentStatus,
    }]
  })
}

async function fetchCustomerDetails(customerIds: Set<string>): Promise<Map<string, CustomerDetail>> {
  const detailMap = new Map<string, CustomerDetail>()
  if (customerIds.size === 0) return detailMap
  const rows = await sql`
    SELECT instagram_id, name, whatsapp, data_diri, ekspedisi,
           bank_name, bank_account_number, bank_account_holder
    FROM customers
    WHERE lower(replace(instagram_id, '@', '')) = ANY(${[...customerIds]})
  `
  for (const r of rows) {
    const id = normalizeId(r.instagram_id)
    if (id) {
      detailMap.set(id, {
        name: r.name ?? "",
        whatsapp: r.whatsapp ?? "",
        dataDiri: r.data_diri ?? "",
        ekspedisi: r.ekspedisi ?? "",
        bankName: r.bank_name ?? "",
        bankAccountNumber: r.bank_account_number ?? "",
        bankAccountHolder: r.bank_account_holder ?? "",
      })
    }
  }
  return detailMap
}

/**
 * Per-(customer, event) ongkir, resolved from the event's warehouse. Keyed
 * `${normalizedCustomer}|${event}`. Ship groups are per (customer, event), so
 * each gets the rate for the warehouse that fulfills its event.
 */
async function fetchEventOngkir(
  customerIds: Set<string>,
  eventNames: Set<string>,
): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  if (customerIds.size === 0 || eventNames.size === 0) return map
  const rows = await sql`
    SELECT ev.name AS event,
           lower(replace(c.instagram_id, '@', '')) AS norm_cust,
           COALESCE(cwo.ongkos_kirim, 0)::int AS ongkir
    FROM events ev
    JOIN customer_warehouse_ongkir cwo ON cwo.warehouse_id = ev.warehouse_id
    JOIN customers c ON c.id = cwo.customer_id
    WHERE ev.name = ANY(${[...eventNames]})
      AND lower(replace(c.instagram_id, '@', '')) = ANY(${[...customerIds]})
  `
  for (const r of rows) map.set(`${r.norm_cust}|${r.event}`, Number(r.ongkir) || 0)
  return map
}

export type ShipSegment = "all" | ShipStatus

export interface ShipOrdersFiltered {
  groups: ShipCustomer[]
  totalCount: number
  counts: Record<ShipSegment, number>
}

export async function getShipOrdersFiltered(opts: {
  segment?: ShipSegment
  search?: string
  event?: string
}): Promise<ShipOrdersFiltered> {
  const { segment = "all", search, event } = opts

  // Fetch every order line in scope (no arrival pre-filter) so each invoice
  // group carries its full set of lines — required to tell a fully-arrived
  // invoice from a partially-arrived one, and to show the not-yet-arrived
  // lines on a "Tiba Sebagian" card.
  const { conditions, params } = buildSearchFilters({ event, search })
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

  const orderRows = await sql.unsafe(
    `SELECT o.id, o.event, o.customer, o.product_id, p.name AS product_name,
            COALESCE(p.gram, 0) AS gram, o.unit, o.unit_price, o.unit_arrive, o.unit_ship, o.unit_hold
     FROM orders o
     JOIN products p ON p.id = o.product_id
     ${where}
     ORDER BY o.event, o.customer, o.id`,
    params,
  )

  const customerIds = new Set<string>()
  const eventNames = new Set<string>()
  for (const r of orderRows) {
    customerIds.add(normalizeId(r.customer))
    eventNames.add(String(r.event))
  }

  // Fetch customer details, per-event ongkir, and payment status concurrently —
  // all keyed by normalized customer handle (ongkir/payment additionally by event).
  const [detailMap, ongkirMap, paymentRows] = await Promise.all([
    fetchCustomerDetails(customerIds),
    fetchEventOngkir(customerIds, eventNames),
    getPaymentStatus(event),
  ])
  const paymentMap = new Map<string, PaymentStatus>()
  for (const row of paymentRows) paymentMap.set(`${row.customer}|${row.event}`, row.status)

  const allGroups = buildShipGroups(orderRows, detailMap, paymentMap, ongkirMap)

  // Counts and the filtered list both derive from the same in-memory status,
  // so the tab badges can never drift from the rows actually shown.
  const counts: Record<ShipSegment, number> = {
    all: 0, not_arrived: 0, partial: 0, ready: 0, ready_unpaid: 0, hold: 0, shipped: 0,
  }
  const filteredGroups: ShipCustomer[] = []
  for (const g of allGroups) {
    counts.all++
    counts[g.status]++
    if (segment === "all" || g.status === segment) filteredGroups.push(g)
  }

  return {
    groups: filteredGroups,
    totalCount: filteredGroups.length,
    counts,
  }
}

export async function shipCustomerOrders(params: ShipOrdersParams, actor?: string | null): Promise<{ shippingId: string }> {
  const { customer, event, orders, weightKg, ongkirPerKg, tempAddress } = params
  // Empty-string and undefined both mean "no override" — store NULL so the
  // label flow can fall back to the customer's profile address.
  const tempAddressValue = tempAddress && tempAddress.trim() ? tempAddress : null

  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.actor', ${actor ?? ""}, true)`
    const [maxRow] = await tx`
      SELECT COALESCE(MAX(shipping_id::integer), 0) AS max_id FROM shipments
    `
    const shippingId = String((maxRow.max_id ?? 0) + 1).padStart(4, "0")

    const toShipRows = orders.filter((o) => o.toShip > 0)
    const invoicingText = toShipRows.map((o) => `${o.productName} x ${o.toShip}`).join("\n")
    // Bill ongkir per kg, rounded up to the next whole kg (courier-style).
    const billedKg = Math.ceil(weightKg)
    const ongkirTotal = ongkirPerKg * billedKg

    await tx`
      INSERT INTO shipments (event, customer, shipping_id, invoicing, weight_estimation, ongkir, ongkir_total, is_last_shipment, temp_address)
      VALUES (${event}, ${customer}, ${shippingId}, ${invoicingText}, ${billedKg}, ${ongkirPerKg}, ${ongkirTotal}, true, ${tempAddressValue})
    `

    for (const order of toShipRows) {
      await tx`
        UPDATE orders
        SET unit_ship = COALESCE(unit_ship, 0) + ${order.toShip}, updated_at = NOW()
        WHERE id = ${order.rowNumber}
      `
    }

    return { shippingId }
  })
}

/**
 * "Ship together": ship one customer's ready orders across several events as a
 * single physical package, in one transaction.
 *
 *  - Writes one shipment row per event, all sharing a generated merge_group, so
 *    the Shipments page can collapse them into one entry and one resi covers all.
 *  - The combined physical weight + ongkir land on the primary (first) row; the
 *    others get 0 weight/ongkir_total so summing the group isn't double-counted.
 *  - Marks the shipped order units like the single-event flow.
 *  - Bills ongkir ONCE: invoices recompute ongkir per event from the customer's
 *    FULL event order weight, so we add a single negative "Gabung ongkir"
 *    adjustment equal to the round-up overlap removed by combining the events
 *    (computed from those same full event weights, to stay consistent with the
 *    invoice math). Skipped when combining saves nothing.
 */
export async function shipMergedCustomerOrders(params: ShipMergedParams, actor?: string | null): Promise<ShipMergedResult> {
  const { customer, ongkirPerKg, groups, tempAddress } = params
  // Same value written to every row in the merge_group — one physical box,
  // one receiving address. NULL means "use the customer's profile address."
  const tempAddressValue = tempAddress && tempAddress.trim() ? tempAddress : null
  const custKey = normalizeId(customer)
  const events = groups.map((g) => g.event)

  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.actor', ${actor ?? ""}, true)`
    // Physical weight of what's actually in the box (rounded up once overall).
    let totalShippedGram = 0
    for (const g of groups) for (const o of g.orders) totalShippedGram += (o.gram || 0) * o.toShip
    const combinedKg = Math.ceil(totalShippedGram / 1000)
    const combinedOngkir = ongkirPerKg * combinedKg

    // Billing discount: compare ongkir billed per event (full event weight,
    // each rounded up) against ongkir on the combined full weight (rounded once).
    const fullRows = await tx<{ event: string; full_gram: string }[]>`
      SELECT o.event AS event, SUM(COALESCE(p.gram, 0) * o.unit) AS full_gram
      FROM orders o
      JOIN products p ON p.id = o.product_id
      WHERE lower(replace(o.customer, '@', '')) = ${custKey} AND o.event = ANY(${events})
      GROUP BY o.event
    `
    let sumFullGram = 0
    let perEventOngkirTotal = 0
    for (const r of fullRows) {
      const fg = Number(r.full_gram) || 0
      sumFullGram += fg
      perEventOngkirTotal += ongkirPerKg * Math.ceil(fg / 1000)
    }
    const combinedBillingOngkir = ongkirPerKg * Math.ceil(sumFullGram / 1000)
    const discount = Math.max(0, perEventOngkirTotal - combinedBillingOngkir)

    // One shipping_id for the whole package — shared across the per-event rows.
    const [maxRow] = await tx`SELECT COALESCE(MAX(shipping_id::integer), 0) AS max_id FROM shipments`
    const shippingId = String(((maxRow.max_id ?? 0) as number) + 1).padStart(4, "0")
    const mergeGroup = randomUUID()

    let isPrimary = true
    for (const g of groups) {
      const toShipRows = g.orders.filter((o) => o.toShip > 0)
      const invoicingText = toShipRows.map((o) => `${o.productName} x ${o.toShip}`).join("\n")
      // Combined weight + ongkir live on the primary row only, so summing the
      // group's rows isn't double-counted.
      const weight = isPrimary ? combinedKg : 0
      const ongkirTotal = isPrimary ? combinedOngkir : 0

      await tx`
        INSERT INTO shipments (event, customer, shipping_id, invoicing, weight_estimation, ongkir, ongkir_total, is_last_shipment, merge_group, temp_address)
        VALUES (${g.event}, ${customer}, ${shippingId}, ${invoicingText}, ${weight}, ${ongkirPerKg}, ${ongkirTotal}, true, ${mergeGroup}, ${tempAddressValue})
      `
      for (const o of toShipRows) {
        await tx`
          UPDATE orders
          SET unit_ship = COALESCE(unit_ship, 0) + ${o.toShip}, updated_at = NOW()
          WHERE id = ${o.rowNumber}
        `
      }
      isPrimary = false
    }

    if (discount > 0) {
      const normCust = normalizeCustomer(customer)
      const others = groups.slice(1).map((g) => g.event).join(", ")
      await tx`INSERT INTO customers (instagram_id) VALUES (${normCust}) ON CONFLICT (instagram_id) DO NOTHING`
      await tx`
        INSERT INTO adjustments (event, customer, description, amount)
        VALUES (${groups[0].event}, ${normCust}, ${`Gabung ongkir dengan ${others}`}, ${-discount})
      `
    }

    return {
      mergeGroup,
      shippingId,
      shippingIds: [shippingId],
      discount,
      combinedKg,
      combinedOngkir,
    }
  })
}

// ─── Hold / Release ─────────────────────────────────────────────────────────

/**
 * Park every ready-to-ship unit on a customer's event into hold. Used when the
 * customer asks to delay shipment (typically to combine with a later event).
 * Sets unit_hold = unit_arrive - unit_ship for each line, which zeroes out toShip
 * and moves the card into the "Hold" segment until released.
 */
export async function holdPackingList(params: {
  customer: string
  event: string
}, db: DBExecutor = sql): Promise<void> {
  const { customer, event } = params
  const custKey = normalizeId(customer)
  await db`
    UPDATE orders
    SET unit_hold = GREATEST(COALESCE(unit_arrive, 0) - COALESCE(unit_ship, 0), 0),
        updated_at = NOW()
    WHERE event = ${event}
      AND lower(replace(customer, '@', '')) = ${custKey}
      AND COALESCE(unit_arrive, 0) - COALESCE(unit_ship, 0) > 0
  `
}

/**
 * Release a held packing list back to the ready pool by zeroing unit_hold across
 * the customer's event lines. After release the card returns to ready/ready_unpaid
 * (depending on payment) and can be shipped normally or via "Ship together".
 */
export async function releasePackingList(params: {
  customer: string
  event: string
}, db: DBExecutor = sql): Promise<void> {
  const { customer, event } = params
  const custKey = normalizeId(customer)
  await db`
    UPDATE orders
    SET unit_hold = 0, updated_at = NOW()
    WHERE event = ${event}
      AND lower(replace(customer, '@', '')) = ${custKey}
      AND COALESCE(unit_hold, 0) > 0
  `
}

// ─── Shipments ──────────────────────────────────────────────────────────────

export async function getShippingRecords(sinceDays?: number | null): Promise<ShippingRecord[]> {
  // The shipments grid loads everything client-side (search/sort/merge/bulk
  // print all need the full set), and the `invoicing` packing text makes each
  // row heavy — so the whole-history fetch grows unbounded and dominates DB
  // egress over time. Default callers to a recent window; pass null for "all".
  // Filtering on created_at is safe for merge groups: rows shipped together
  // share a timestamp, so a window never splits a group.
  const windowClause =
    sinceDays != null && sinceDays > 0
      ? sql`AND s.created_at >= now() - make_interval(days => ${sinceDays})`
      : sql``
  // Join customers via the existing FK (shipments.customer → customers.instagram_id)
  // so the page can show the human-readable name alongside the IG handle.
  const rows = await sql`
    SELECT s.id, s.event, s.customer, c.name AS customer_name,
           s.shipping_id, s.invoicing,
           s.weight_estimation, s.ongkir, s.ongkir_total, s.is_last_shipment,
           s.created_at, s.updated_at, s.tracking_number, s.merge_group, s.temp_address
    FROM shipments s
    LEFT JOIN customers c ON c.instagram_id = s.customer
    WHERE s.shipping_id != ''
      ${windowClause}
    ORDER BY s.id ASC
  `
  return rows.map((r) => ({
    rowNumber: r.id,
    event: r.event,
    customer: r.customer,
    customerName: r.customer_name ?? "",
    shippingId: String(r.shipping_id).padStart(4, "0"),
    invoicing: r.invoicing ?? "",
    weightEstimation: Number(r.weight_estimation) || 0,
    ongkir: r.ongkir ?? 0,
    ongkirTotal: r.ongkir_total ?? 0,
    isLastShipment: r.is_last_shipment ?? false,
    createdAt: tsToString(r.created_at),
    updatedAt: tsToString(r.updated_at),
    createdAtTs: r.created_at ? new Date(r.created_at as string).getTime() : 0,
    updatedAtTs: r.updated_at ? new Date(r.updated_at as string).getTime() : 0,
    trackingNumber: r.tracking_number ?? "",
    mergeGroup: r.merge_group ?? null,
    tempAddress: r.temp_address ?? null,
  }))
}

export async function updateTrackingNumber(
  rowNumber: number,
  trackingNumber: string,
  db: DBExecutor = sql,
): Promise<void> {
  // For a merged ("Ship together") shipment the resi is shared, so setting it on
  // any row applies to every row in the same merge_group; otherwise just the row.
  await db`
    UPDATE shipments
    SET tracking_number = ${trackingNumber}, updated_at = NOW()
    WHERE id = ${rowNumber}
       OR merge_group = (SELECT merge_group FROM shipments WHERE id = ${rowNumber} AND merge_group IS NOT NULL)
  `
}

/**
 * Replace (or clear, when `tempAddress` is null) the one-time receiving address
 * on a shipment. Mirrors updateTrackingNumber's merge_group propagation: a
 * merged "Ship together" package is one physical box with one address, so
 * editing any row of the merge updates every row.
 */
export async function updateShipmentTempAddress(
  rowNumber: number,
  tempAddress: string | null,
  db: DBExecutor = sql,
): Promise<void> {
  const value = tempAddress && tempAddress.trim() ? tempAddress : null
  await db`
    UPDATE shipments
    SET temp_address = ${value}, updated_at = NOW()
    WHERE id = ${rowNumber}
       OR merge_group = (SELECT merge_group FROM shipments WHERE id = ${rowNumber} AND merge_group IS NOT NULL)
  `
}

// ─── Arrival List ──────────────────────────────────────────────────────────

export interface ArrivalListOrder {
  id: number
  customer: string
  unitBuy: number
  unitArrive: number
  pending: number
  paidStatus: PaidStatus
}

export interface ArrivalListItem {
  event: string
  productId: number
  productName: string
  store: string
  totalPending: number   // remaining to arrive
  totalBought: number    // full quantity we bought (for partial-state display)
  customerCount: number
  customers: string[]
  orderIds: number[]
  orders: ArrivalListOrder[]
  // Purchase cost in the product's foreign currency, for the cargo document.
  // valas = unit price in that currency; currency = its code (from the product's
  // country); kurs = IDR per unit of valas. 0 / "" when the product has none.
  valas: number
  kurs: number
  currency: string
}

/**
 * Items that have been dispatched (unit_dispatch IS NOT NULL) but haven't fully
 * arrived yet (unit_arrive IS NULL OR unit_arrive < unit_dispatch) — you can only
 * receive what was dispatched. Grouped by event + product, with the per-customer
 * order list nested for the mark-arrived modal.
 */
export async function getArrivalList(event?: string): Promise<ArrivalListItem[]> {
  // Arrival gates on unit_dispatch (dispatched stock is what can be received); 'unitBuy' JSON key carries the dispatched count.
  const rows = event
    ? await sql`
        SELECT
          o.event,
          o.product_id,
          p.name AS product_name,
          p.store,
          p.valas,
          p.kurs,
          COALESCE(c.currency, '') AS currency,
          SUM(o.unit_dispatch - COALESCE(o.unit_arrive, 0))::int AS total_pending,
          SUM(o.unit_dispatch)::int AS total_bought,
          COUNT(DISTINCT o.customer)::int AS customer_count,
          ARRAY_AGG(DISTINCT o.customer ORDER BY o.customer) AS customers,
          ARRAY_AGG(o.id ORDER BY o.id) AS order_ids,
          JSON_AGG(JSON_BUILD_OBJECT(
            'id', o.id,
            'customer', o.customer,
            'unitBuy', o.unit_dispatch,
            'unitArrive', COALESCE(o.unit_arrive, 0),
            'pending', o.unit_dispatch - COALESCE(o.unit_arrive, 0)
          ) ORDER BY o.customer, o.id) AS orders
        FROM orders o
        JOIN products p ON p.id = o.product_id
        LEFT JOIN countries c ON c.id = p.country_id
        WHERE o.unit_dispatch IS NOT NULL
          AND (o.unit_arrive IS NULL OR o.unit_arrive < o.unit_dispatch)
          AND o.event = ${event}
        GROUP BY o.event, o.product_id, p.name, p.store, p.valas, p.kurs, c.currency
        HAVING SUM(o.unit_dispatch - COALESCE(o.unit_arrive, 0)) > 0
        ORDER BY p.name, p.store
      `
    : await sql`
        SELECT
          o.event,
          o.product_id,
          p.name AS product_name,
          p.store,
          p.valas,
          p.kurs,
          COALESCE(c.currency, '') AS currency,
          SUM(o.unit_dispatch - COALESCE(o.unit_arrive, 0))::int AS total_pending,
          SUM(o.unit_dispatch)::int AS total_bought,
          COUNT(DISTINCT o.customer)::int AS customer_count,
          ARRAY_AGG(DISTINCT o.customer ORDER BY o.customer) AS customers,
          ARRAY_AGG(o.id ORDER BY o.id) AS order_ids,
          JSON_AGG(JSON_BUILD_OBJECT(
            'id', o.id,
            'customer', o.customer,
            'unitBuy', o.unit_dispatch,
            'unitArrive', COALESCE(o.unit_arrive, 0),
            'pending', o.unit_dispatch - COALESCE(o.unit_arrive, 0)
          ) ORDER BY o.customer, o.id) AS orders
        FROM orders o
        JOIN products p ON p.id = o.product_id
        LEFT JOIN countries c ON c.id = p.country_id
        JOIN events e ON e.name = o.event
        WHERE o.unit_dispatch IS NOT NULL
          AND (o.unit_arrive IS NULL OR o.unit_arrive < o.unit_dispatch)
        GROUP BY o.event, o.product_id, p.name, p.store, p.valas, p.kurs, c.currency
        HAVING SUM(o.unit_dispatch - COALESCE(o.unit_arrive, 0)) > 0
        -- Most recently created event first (matches the shopping list and
        -- dashboard); product name then store within each event. MAX() because
        -- created_at is constant per event but not in the GROUP BY.
        ORDER BY MAX(e.created_at) DESC NULLS LAST, o.event, p.name, p.store
      `

  const items: ArrivalListItem[] = rows.map((r) => ({
    event: r.event as string,
    productId: r.product_id as number,
    productName: r.product_name as string,
    store: r.store as string,
    totalPending: r.total_pending as number,
    totalBought: r.total_bought as number,
    customerCount: r.customer_count as number,
    customers: r.customers as string[],
    orderIds: r.order_ids as number[],
    orders: r.orders as ArrivalListOrder[],
    valas: Number(r.valas) || 0,
    // kurs is NUMERIC(12,4) — postgres-js returns it as a string, so coerce.
    kurs: Number(r.kurs) || 0,
    currency: (r.currency as string) ?? "",
  }))

  // Order each product's customers by allocation priority (paid → partial →
  // unpaid, then earliest order) so the arrive modal's fill preview matches the
  // server-side allocation in markProductArrived.
  const statusMap = await fetchPaidStatusMap(event ? [event] : null)
  for (const item of items) {
    item.orders.sort(compareOrderPriority(item.event, statusMap))
    for (const order of item.orders) {
      order.paidStatus = statusMap.get(`${item.event}|${order.customer}`) ?? "unpaid"
    }
  }

  return items
}

// ─── Received Report ───────────────────────────────────────────────────────

export interface ReceivedReportItem {
  event: string
  dispatchReceipt: string
  store: string
  productId: number
  productName: string
  unitsReceived: number
}

/**
 * Per-product tally of units *received* for one event, optionally narrowed to a
 * local (Asia/Jakarta) date range (inclusive on both ends). `event` is required;
 * pass `from`/`to` as null (or omit) to include every date for that event. Pass
 * the same value for `from` and `to` for a single day.
 *
 * Receiving is incremental — `unit_arrive` accumulates in batches and only
 * bumps `updated_at`, which any edit also touches — so `orders` itself can't
 * say what arrived on a date. Instead we read the append-only `audit.audit_log`
 * (migration 029): each orders write stores old/new JSONB, so the per-row delta
 * `new.unit_arrive − old.unit_arrive` is exactly the units booked in that
 * transaction. Summing the positive deltas gives the receipts; a product
 * received across several days is one summed row.
 *
 * Only increases count (gross receipts): a downward correction that fixes an
 * over-count is intentionally excluded — this is a "what came in" log, not a
 * net-change log. `from`/`to` are 'YYYY-MM-DD' strings compared against the
 * audit timestamp converted to Asia/Jakarta, so day boundaries match the wall
 * clock rather than UTC.
 */
export async function getReceivedReport(
  event: string,
  from?: string | null,
  to?: string | null,
): Promise<ReceivedReportItem[]> {
  // Apply the date window only when a range was given; otherwise every receipt
  // for the event is included regardless of date.
  const dateFilter =
    from && to
      ? sql`AND (a.at AT TIME ZONE 'Asia/Jakarta')::date BETWEEN ${from}::date AND ${to}::date`
      : sql``
  const rows = await sql`
    SELECT
      (a.new_row->>'event')                                        AS event,
      (a.new_row->>'product_id')::int                              AS product_id,
      p.name                                                       AS product_name,
      p.store                                                      AS store,
      STRING_AGG(DISTINCT NULLIF(a.new_row->>'dispatch_receipt', ''), ', '
                 ORDER BY NULLIF(a.new_row->>'dispatch_receipt', '')) AS dispatch_receipt,
      SUM( (a.new_row->>'unit_arrive')::int
           - COALESCE((a.old_row->>'unit_arrive')::int, 0) )::int  AS units_received
    FROM audit.audit_log a
    JOIN products p ON p.id = (a.new_row->>'product_id')::int
    WHERE a.table_name = 'orders'
      AND a.action IN ('INSERT', 'UPDATE')
      AND (a.new_row->>'event') = ${event}
      ${dateFilter}
      AND COALESCE((a.new_row->>'unit_arrive')::int, 0)
          > COALESCE((a.old_row->>'unit_arrive')::int, 0)
    GROUP BY event, product_id, p.name, p.store
    ORDER BY event, dispatch_receipt NULLS FIRST, p.store, p.name
  `

  return rows.map((r) => ({
    event: r.event as string,
    dispatchReceipt: (r.dispatch_receipt as string) ?? "",
    store: (r.store as string) ?? "",
    productId: r.product_id as number,
    productName: r.product_name as string,
    unitsReceived: r.units_received as number,
  }))
}

/**
 * Partial allocation: shipments arrive in batches, so an order can have
 * unit_arrive < unit_dispatch and still appear in the arrival list with
 * reduced pending qty. Gates/caps on unit_dispatch (not unit_buy) — only
 * dispatched stock is eligible to be marked arrived.
 */
export async function markProductArrived(data: {
  event: string
  productId: number
  quantityArrived: number
}, actor?: string | null): Promise<{ filledOrderIds: number[]; unassignedUnits: number }> {
  type Row = { id: number; customer: string; unitDispatch: number; unitArrive: number; pending: number }
  const orders = (await sql`
    SELECT
      id,
      customer,
      unit_dispatch::int AS "unitDispatch",
      COALESCE(unit_arrive, 0)::int AS "unitArrive",
      (unit_dispatch - COALESCE(unit_arrive, 0))::int AS pending
    FROM orders
    WHERE event = ${data.event}
      AND product_id = ${data.productId}
      AND unit_dispatch IS NOT NULL
      AND (unit_arrive IS NULL OR unit_arrive < unit_dispatch)
    ORDER BY id ASC
  `) as unknown as Row[]

  // Allocate arrivals to paid customers first, then partial, then unpaid
  // (earliest order within a tier). Matches the arrive modal's preview ordering.
  const statusMap = await fetchPaidStatusMap([data.event])
  orders.sort(compareOrderPriority(data.event, statusMap))

  const { allocations, excess: unassignedUnits } = allocateFifo(orders, (o) => o.pending, data.quantityArrived)
  const filledOrderIds: number[] = []

  if (allocations.length > 0) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.actor', ${actor ?? ""}, true)`
      for (const { item: o, allocated } of allocations) {
        const newUnitArrive = o.unitArrive + allocated
        if (newUnitArrive >= o.unitDispatch) filledOrderIds.push(o.id)
        await tx`
          UPDATE orders
          SET unit_arrive = ${newUnitArrive}, updated_at = NOW()
          WHERE id = ${o.id}
        `
      }
    })
  }

  return { filledOrderIds, unassignedUnits }
}

