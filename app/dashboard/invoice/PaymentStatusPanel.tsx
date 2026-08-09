"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react"
import { displayIg, fmt } from "@/lib/format"
import type { InvoiceResult, PaymentStatus, PaymentStatusRow } from "@/lib/db"
import DataGrid, { type ColumnDef } from "@/components/DataGrid"
import EventSelect from "@/components/EventSelect"
import CopyInvoiceButton from "@/components/CopyInvoiceButton"
import InvoiceSummary from "@/components/InvoiceSummary"
import { AddAdjustmentFromInvoiceModal } from "./AddAdjustmentFromInvoiceModal"
import { InvoiceMessageActions } from "./InvoiceMessageActions"

// ─── Payment Status Panel ────────────────────────────────────────────────────

const STATUS_LABELS: Record<PaymentStatus, string> = {
  void: "Void",
  unpaid: "Unpaid",
  partial: "Partial",
  paid: "Paid",
  overpaid: "Overpaid",
}

const STATUS_COLORS: Record<PaymentStatus, string> = {
  void: "bg-gray-100 text-gray-500 border-gray-200",
  unpaid: "bg-red-50 text-red-700 border-red-200",
  partial: "bg-yellow-50 text-yellow-700 border-yellow-200",
  paid: "bg-green-50 text-green-700 border-green-200",
  overpaid: "bg-blue-50 text-blue-700 border-blue-200",
}

type StatusFilter = "all" | PaymentStatus

export function PaymentStatusPanel({
  onOpenCustomer,
}: {
  onOpenCustomer: (customer: string) => void
}) {
  const [rows, setRows] = useState<PaymentStatusRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusFilter>("unpaid")
  // Mobile-only event picker (next to the search bar); "" = all events.
  const [eventFilter, setEventFilter] = useState("")
  // Rows currently visible in the grid after the search box narrows them, so
  // the Outstanding/Overpaid totals track what the user is looking at. null
  // until the grid first reports (falls back to the full filtered set).
  const [searchedRows, setSearchedRows] = useState<PaymentStatusRow[] | null>(null)
  const [adjustingRow, setAdjustingRow] = useState<{ event: string; customer: string } | null>(null)
  // Per-customer invoice cache for expanded rows — one fetch covers every
  // event row of that customer; cleared on refresh so amounts stay current.
  const invoiceCache = useRef(new Map<string, InvoiceResult>())

  // Fetch every event's payment status once; the event picker filters client-side.
  const fetchRows = useCallback(async () => {
    setLoading(true)
    setError(null)
    invoiceCache.current.clear()
    try {
      const res = await fetch(`/api/sheets/invoice/payment-status`, { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to load")
      setRows(data.rows ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchRows() }, [fetchRows])

  const counts = useMemo(() => {
    const c: Record<PaymentStatus, number> = { void: 0, unpaid: 0, partial: 0, paid: 0, overpaid: 0 }
    for (const r of rows) c[r.status]++
    return c
  }, [rows])

  // Distinct events for the mobile event picker, in first-seen order.
  const eventOptions = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const r of rows) if (r.event && !seen.has(r.event)) { seen.add(r.event); out.push(r.event) }
    return out
  }, [rows])

  // The status chips + event picker pre-filter the rows fed to the grid; the
  // grid's own search box then narrows further and reports back via
  // onFilteredRowsChange.
  const gridRows = useMemo(
    () => rows.filter((r) =>
      (filter === "all" || r.status === filter) &&
      (!eventFilter || r.event === eventFilter),
    ),
    [rows, filter, eventFilter],
  )

  const totals = useMemo(() => {
    // Outstanding = money customers still owe (positive balances); overpaid =
    // money owed back to customers (negative balances), shown as a magnitude.
    // Summed over the searched rows so the figures match what's on screen; fall
    // back to the full status-filtered set until the grid first reports.
    const source = searchedRows ?? gridRows
    let outstanding = 0
    let overpaid = 0
    for (const r of source) {
      if (r.outstanding > 0) outstanding += r.outstanding
      else if (r.outstanding < 0) overpaid += -r.outstanding
    }
    return { outstanding, overpaid }
  }, [searchedRows, gridRows])

  const columns = useMemo<ColumnDef<PaymentStatusRow, unknown>[]>(() => [
    {
      accessorKey: "event",
      header: "Event",
      size: 130,
      filterFn: "textContains",
      cell: ({ getValue }) => <span className="text-gray-500 whitespace-nowrap">{getValue<string>()}</span>,
    },
    {
      accessorKey: "customer",
      header: "Customer",
      size: 160,
      filterFn: "textContains",
      cell: ({ row }) => (
        <button
          type="button"
          onClick={() => onOpenCustomer(row.original.customer)}
          className="font-medium text-foreground hover:text-brand transition-colors text-left"
        >
          {displayIg(row.original.customer)}
        </button>
      ),
    },
    {
      accessorKey: "invoiceTotal",
      header: "Invoice Total",
      size: 140,
      filterFn: "numeric",
      meta: { align: "right" },
      cell: ({ getValue }) => <span className="tabular-nums">Rp {fmt(getValue<number>())}</span>,
    },
    {
      accessorKey: "totalPaid",
      header: "Paid",
      size: 130,
      filterFn: "numeric",
      meta: { align: "right" },
      cell: ({ getValue }) => <span className="tabular-nums">Rp {fmt(getValue<number>())}</span>,
    },
    {
      accessorKey: "outstanding",
      header: "Balance",
      size: 140,
      filterFn: "numeric",
      meta: { align: "right" },
      cell: ({ getValue }) => {
        const v = getValue<number>()
        return (
          <span className={`tabular-nums font-medium ${v > 0 ? "text-red-600" : v < 0 ? "text-blue-600" : "text-green-600"}`}>
            {v > 0 ? "Rp " + fmt(v) : v < 0 ? "−Rp " + fmt(Math.abs(v)) : "—"}
          </span>
        )
      },
    },
    {
      accessorKey: "status",
      header: "Status",
      size: 120,
      enableColumnFilter: false,
      cell: ({ getValue }) => {
        const s = getValue<PaymentStatus>()
        return (
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_COLORS[s]}`}>
            {STATUS_LABELS[s]}
          </span>
        )
      },
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableColumnFilter: false,
      size: 72,
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-1">
          <CopyInvoiceButton customer={row.original.customer} event={row.original.event} />
          <button
            type="button"
            onClick={() => setAdjustingRow({ event: row.original.event, customer: row.original.customer })}
            title="Add adjustment for this invoice"
            className="text-gray-400 hover:text-brand transition-colors p-1 rounded"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
      ),
    },
  ], [onOpenCustomer])

  const tabs: { key: StatusFilter; label: string; count: number }[] = [
    { key: "all", label: "All", count: rows.length },
    { key: "unpaid", label: "Unpaid", count: counts.unpaid },
    { key: "partial", label: "Partial", count: counts.partial },
    { key: "paid", label: "Paid", count: counts.paid },
    { key: "overpaid", label: "Overpaid", count: counts.overpaid },
    { key: "void", label: "Void", count: counts.void },
  ]

  const renderExpandedRow = useCallback((r: PaymentStatusRow) => (
    <ExpandedInvoice event={r.event} customer={r.customer} cache={invoiceCache} />
  ), [])

  const renderMobileCard = useCallback((r: PaymentStatusRow) => (
    <div className="rounded-xl border border-cream-border bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-semibold text-sm text-foreground shrink-0">{r.event}</span>
          <button
            type="button"
            onClick={() => onOpenCustomer(r.customer)}
            className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-brand transition-colors text-left min-w-0 uppercase"
          >
            <span className="truncate">{displayIg(r.customer)}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            </svg>
          </button>
        </div>
      </div>

      <div className="mt-2.5 pt-2.5 border-t border-cream-border flex flex-col gap-1 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-gray-400">Items</span>
          <span className="tabular-nums text-foreground">{fmt(r.totalItems)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-gray-400">Invoice</span>
          <span className="tabular-nums text-foreground">Rp {fmt(r.invoiceTotal)}</span>
        </div>
        {r.outstanding !== 0 && (
          <div className="flex items-center justify-between">
            <span className="text-gray-400">{r.outstanding > 0 ? "Outstanding" : "Overpayment"}</span>
            <span className={`tabular-nums font-medium ${r.outstanding > 0 ? "text-red-600" : "text-blue-600"}`}>
              {r.outstanding > 0 ? "Rp " + fmt(r.outstanding) : "−Rp " + fmt(Math.abs(r.outstanding))}
            </span>
          </div>
        )}
      </div>

      <div className="mt-2.5 pt-2.5 border-t border-cream-border flex items-center justify-between gap-3">
        <span className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${STATUS_COLORS[r.status]}`}>
          {STATUS_LABELS[r.status]}
        </span>
        <div className="flex items-center gap-1">
        <CopyInvoiceButton customer={r.customer} event={r.event} />
        <button
          type="button"
          onClick={() => setAdjustingRow({ event: r.event, customer: r.customer })}
          title="Add adjustment for this invoice"
          className="text-gray-400 hover:text-brand transition-colors p-1 rounded"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        </div>
      </div>
    </div>
  ), [onOpenCustomer])

  if (loading) {
    return <div className="rounded-xl border border-cream-border bg-white py-12 text-center text-sm text-gray-400">Loading…</div>
  }
  if (error) {
    return <div className="rounded-xl border border-red-200 bg-red-50 py-8 px-4 text-sm text-red-500">{error}</div>
  }

  return (
    <>
      {rows.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:gap-4 mb-3">
          <div className="rounded-xl border border-cream-border border-l-4 border-l-red-500 bg-white px-3 py-3 sm:px-5 sm:py-4">
            <div className="text-xs font-medium text-gray-400 uppercase tracking-wide">Outstanding</div>
            <div className="text-lg sm:text-2xl font-bold text-foreground mt-1 tabular-nums">Rp {fmt(totals.outstanding)}</div>
          </div>
          <div className="rounded-xl border border-cream-border border-l-4 border-l-blue-500 bg-white px-3 py-3 sm:px-5 sm:py-4">
            <div className="text-xs font-medium text-gray-400 uppercase tracking-wide">Overpayment</div>
            <div className="text-lg sm:text-2xl font-bold text-foreground mt-1 tabular-nums">Rp {fmt(totals.overpaid)}</div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 w-full rounded-xl border border-cream-border bg-white p-1 overflow-x-auto">
        {tabs.map(({ key, label, count }) => {
          const active = filter === key
          return (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`flex-1 shrink-0 flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                active
                  ? "bg-brand text-white"
                  : "text-gray-500 hover:text-foreground"
              }`}
            >
              {label}
              {count ? (
                <span className={`hidden sm:inline text-xs rounded-full px-1.5 py-0.5 tabular-nums ${active ? "bg-white/20 text-white" : "bg-gray-100 text-gray-500"}`}>
                  {count}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <div className="mt-3">
        <DataGrid
          key={filter}
          data={gridRows}
          columns={columns}
          getRowId={(r) => `${r.event}-${r.customer}`}
          searchPlaceholder="Search customers, events…"
          fullWidthSearch
          tightToolbar
          boldUppercaseHeader
          hideRowCount
          onFilteredRowsChange={setSearchedRows}
          pageSize={50}
          initialSorting={[{ id: "outstanding", desc: true }]}
          toolbarExtra={
            <div className="md:hidden w-36 shrink-0">
              <EventSelect
                value={eventFilter}
                onChange={setEventFilter}
                events={eventOptions}
                placeholder="All events"
                clearable
              />
            </div>
          }
          renderMobileCard={renderMobileCard}
          renderExpandedRow={renderExpandedRow}
          paginationVariant="simple"
        />
      </div>

      {adjustingRow && (
        <AddAdjustmentFromInvoiceModal
          event={adjustingRow.event}
          customer={adjustingRow.customer}
          onClose={() => setAdjustingRow(null)}
          onSaved={() => { setAdjustingRow(null); fetchRows() }}
        />
      )}
    </>
  )
}

// ─── Expanded row: inline invoice detail ─────────────────────────────────────
//
// Read-only quick view of one (event, customer) invoice — order lines plus the
// summary block. Actions (refund, cancel, adjustments) live in the drawer,
// opened by clicking the customer name. The fetch covers all of the customer's
// events, so it's cached per customer and shared across their rows.

function ExpandedInvoice({
  event,
  customer,
  cache,
}: {
  event: string
  customer: string
  cache: MutableRefObject<Map<string, InvoiceResult>>
}) {
  const [result, setResult] = useState<InvoiceResult | null>(cache.current.get(customer) ?? null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const cached = cache.current.get(customer)
    if (cached) { setResult(cached); return }
    let cancelled = false
    setResult(null)
    setError(null)
    fetch(`/api/sheets/invoice?customer=${encodeURIComponent(customer)}`, { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to load")
        return data as InvoiceResult
      })
      .then((data) => {
        cache.current.set(customer, data)
        if (!cancelled) setResult(data)
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load") })
    return () => { cancelled = true }
  }, [customer, cache])

  if (error) {
    return <div className="px-6 py-4 bg-cream/40 text-sm text-red-500">{error}</div>
  }
  if (!result) {
    return <div className="px-6 py-4 bg-cream/40 text-sm text-gray-400">Loading invoice…</div>
  }

  const ev = result.events.find((e) => e.eventId === event)
  if (!ev) {
    return <div className="px-6 py-4 bg-cream/40 text-sm text-gray-400">No invoice found for {event}.</div>
  }

  return (
    <div className="bg-cream/40">
      {/* Order lines */}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-500 border-b border-cream-border">
            <th className="pl-12 pr-4 py-2 font-medium">Order</th>
            <th className="px-4 py-2 font-medium text-right w-20">Unit</th>
            <th className="px-4 py-2 font-medium text-right w-28">Price</th>
            <th className="px-4 py-2 font-medium text-right w-28">Subtotal</th>
            <th className="px-4 py-2 font-medium text-right w-20">Ready</th>
          </tr>
        </thead>
        <tbody>
          {[...ev.orders].reverse().map((r, i) => (
            <tr key={i} className="border-b border-cream-border/60">
              <td className="pl-12 pr-4 py-2">{r.productName || r.order}</td>
              <td className="px-4 py-2 text-right tabular-nums">{r.unit}</td>
              <td className="px-4 py-2 text-right tabular-nums">{r.price}</td>
              <td className="px-4 py-2 text-right tabular-nums">{r.subtotal}</td>
              <td className="px-4 py-2 text-right tabular-nums">{r.unitArrive}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Summary + message actions */}
      <InvoiceSummary
        event={ev}
        actions={<InvoiceMessageActions event={ev} whatsapp={result.customerDetail?.whatsapp} />}
        leftPadding="pl-12"
      />
    </div>
  )
}
