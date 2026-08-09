"use client"

import { displayIg } from "@/lib/format"
import TableSkeleton from "@/components/TableSkeleton"
import DataGrid, { type ColumnDef } from "@/components/DataGrid"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { InvoiceEvent, InvoiceResult, RefundRow, RefundReason, RefundStatus } from "@/lib/db"
import { REFUND_REASONS } from "@/lib/db/types"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import { fetchJson } from "@/lib/api-fetch"
import EventSelect from "@/components/EventSelect"
import SearchableSelect from "@/components/SearchableSelect"
import { InvoiceDetailDrawer } from "@/app/dashboard/invoice/InvoiceDetailDrawer"
import { useMessageTemplates } from "@/hooks/useMessageTemplates"
import { fillTemplate, DEFAULT_TEMPLATES } from "@/lib/message-templates"

const INPUT_CLASS =
  "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

const REASON_LABELS: Record<string, string> = {
  overpayment: "Overpayment",
  unavailable: "Item Unavailable",
  shipping_loss: "Lost in Shipping",
  damaged: "Damaged",
  goodwill: "Goodwill",
  other: "Other",
}

// Any reason outside the known presets is a user-typed value — show it as-is.
const reasonLabel = (reason: RefundReason) => REASON_LABELS[reason] ?? reason
const toReasonOptions = (reasons: string[]) =>
  Array.from(new Set([...REFUND_REASONS, ...reasons])).map((r) => ({ value: r, label: REASON_LABELS[r] ?? r }))

const STATUS_LABELS: Record<RefundStatus, string> = {
  pending: "Pending",
  awaiting_bank_info: "Bank Info",
  ready_to_refund: "Transfer",
  refunded: "Refunded",
  applied_to_next_order: "Applied to Next Order",
  cancelled: "Cancelled",
}

const STATUS_COLORS: Record<RefundStatus, string> = {
  pending: "bg-yellow-50 text-yellow-700 border-yellow-200",
  awaiting_bank_info: "bg-blue-50 text-blue-700 border-blue-200",
  ready_to_refund: "bg-orange-50 text-orange-700 border-orange-200",
  refunded: "bg-green-50 text-green-700 border-green-200",
  applied_to_next_order: "bg-purple-50 text-purple-700 border-purple-200",
  cancelled: "bg-gray-50 text-gray-500 border-gray-200",
}

const ACTIVE_TABS: { key: RefundStatus | "active"; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "awaiting_bank_info", label: "Bank Info" },
  { key: "ready_to_refund", label: "Transfer" },
  { key: "refunded", label: "Done" },
]

function formatRp(n: number) {
  return `Rp ${new Intl.NumberFormat("id-ID").format(n)}`
}

// A refund with a partial credit applied still has a real remaining amount
// owed back — that (refundAmount) is what should be shown everywhere. Only
// once it's fully consumed as credit (refundAmount hits 0) does the historical
// "applied as credit" figure become the more meaningful number to display.
function isFullyAppliedAsCredit(row: RefundRow): boolean {
  return row.refundAmount <= 0 && row.appliedCreditAmount > 0
}
function displayAmount(row: RefundRow): number {
  return isFullyAppliedAsCredit(row) ? row.appliedCreditAmount : row.refundAmount
}

// A non-null liveOverpayment means the server found this refund's stored amount
// no longer matches the real overpayment and couldn't auto-fix it (credit was
// already applied). Returns the human message, or null when nothing to review.
function reviewMessage(row: RefundRow): string | null {
  const live = row.liveOverpayment
  if (live == null) return null
  if (live <= 0) {
    const owed = -live
    return owed > 0
      ? `No overpayment left — the customer now owes ${formatRp(owed)} on this event (items were added after credit was applied). Consider cancelling this refund.`
      : `No overpayment left — this event is now fully settled. Consider cancelling this refund.`
  }
  return `Overpayment is now ${formatRp(live)}, but this refund still shows ${formatRp(row.refundAmount)} (the invoice changed after credit was applied). Review before refunding.`
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function RefundsClient() {
  const options = useSheetOptions()
  const [rows, setRows] = useState<RefundRow[]>([])
  const [dbReasons, setDbReasons] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [tab, setTab] = useState<RefundStatus>("pending")
  const [creating, setCreating] = useState(false)
  const [mobileCreating, setMobileCreating] = useState(false)
  const [editRow, setEditRow] = useState<RefundRow | null>(null)
  const [eventFilter, setEventFilter] = useState("")

  const reasonOptions = useMemo(() => toReasonOptions(dbReasons), [dbReasons])

  const fetchRows = useCallback((forceScan = false) => {
    setLoading(true)
    setError("")
    const params = new URLSearchParams()
    // GET /refunds auto-materializes overpayment refunds server-side (throttled).
    // Refresh passes forceScan=1 to run the detection immediately regardless of
    // the throttle window; normal opens reuse the throttled result. Event/search
    // filtering is done client-side by the DataGrid, so we always load all rows.
    if (forceScan) params.set("forceScan", "1")
    fetchJson<{ rows: RefundRow[]; reasons: string[] }>(`/api/sheets/refunds?${params}`)
      .then((data) => { setRows(data.rows ?? []); setDbReasons(data.reasons ?? []) })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { fetchRows() }, [fetchRows])

  const doneStatuses: RefundStatus[] = ["refunded", "applied_to_next_order", "cancelled"]

  // Tabs pre-filter by status stage; the DataGrid then does search / per-column
  // sort & filter over the resulting set.
  const tabFiltered = useMemo(() => {
    return rows.filter((r) =>
      (tab === "refunded" ? doneStatuses.includes(r.status) : r.status === tab) &&
      (!eventFilter || r.event === eventFilter),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, tab, eventFilter])

  const counts = useMemo(() => {
    const c: Partial<Record<RefundStatus | "done", number>> = {}
    for (const r of rows) {
      c[r.status] = (c[r.status] ?? 0) + 1
    }
    const done = (c.refunded ?? 0) + (c.applied_to_next_order ?? 0) + (c.cancelled ?? 0)
    return { ...c, done }
  }, [rows])

  const columns = useMemo<ColumnDef<RefundRow, unknown>[]>(() => [
    {
      accessorKey: "customer",
      header: "Customer",
      size: 180,
      filterFn: "textContains",
      cell: ({ row }) => {
        const r = row.original
        const msg = reviewMessage(r)
        return (
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            {displayIg(r.customer)}
            {msg && (
              <span title={msg} className="text-amber-500 shrink-0">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </span>
            )}
          </div>
        )
      },
    },
    {
      accessorKey: "event",
      header: "Event",
      size: 130,
      filterFn: "textContains",
      cell: ({ getValue }) => <span className="text-gray-600">{getValue<string>()}</span>,
    },
    {
      id: "reason",
      accessorFn: (r) => reasonLabel(r.reason),
      header: "Reason",
      size: 150,
      filterFn: "textContains",
      cell: ({ getValue }) => <span className="text-gray-600">{getValue<string>()}</span>,
    },
    {
      id: "amount",
      accessorFn: (r) => displayAmount(r),
      header: "Amount",
      size: 150,
      filterFn: "numeric",
      meta: { align: "right" },
      cell: ({ getValue }) => (
        <span className="tabular-nums font-semibold text-foreground">{formatRp(getValue<number>())}</span>
      ),
    },
    {
      id: "status",
      accessorFn: (r) => STATUS_LABELS[r.status],
      header: "Status",
      size: 150,
      filterFn: "textContains",
      cell: ({ row }) => (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_COLORS[row.original.status]}`}>
          {STATUS_LABELS[row.original.status]}
        </span>
      ),
    },
    {
      // Hidden by default — exists only so the Done tab can sort by completion
      // time (updatedAt = when the refund reached its terminal status).
      accessorKey: "updatedAt",
      header: "Updated",
      enableColumnFilter: false,
    },
  ], [])

  const renderMobileCard = useCallback((r: RefundRow) => {
    const msg = reviewMessage(r)
    return (
      <div className="rounded-xl border border-cream-border bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-semibold text-foreground">{r.event}</span>
            <span className="text-xs text-gray-400 uppercase truncate">{displayIg(r.customer)}</span>
            {msg && (
              <span title={msg} className="text-amber-500 shrink-0">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </span>
            )}
          </div>
        </div>
        <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">{formatRp(displayAmount(r))}</span>
      </div>
    )
  }, [])

  function handleUpdated(updated: RefundRow) {
    setRows((prev) => prev.map((r) => r.id === updated.id ? updated : r))
    setEditRow(null)
  }

  function handleCreated(created: RefundRow) {
    setRows((prev) => [created, ...prev])
    setTab("pending")
  }

  function handleDeleted(id: number) {
    setRows((prev) => prev.filter((r) => r.id !== id))
    setEditRow(null)
  }

  if (loading) return <TableSkeleton />
  if (error) {
    return (
      <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-red-500">
        {error}
      </div>
    )
  }

  return (
    <>
      {/* Tabs */}
      <div className="flex items-center gap-1 w-full rounded-xl border border-cream-border bg-white p-1 overflow-x-auto">
        {ACTIVE_TABS.map(({ key, label }) => {
          const count = key === "refunded" ? counts.done : counts[key as RefundStatus]
          const active = tab === key || (key === "refunded" && doneStatuses.includes(tab))
          return (
            <button
              key={key}
              onClick={() => setTab(key === "refunded" ? "refunded" : key as RefundStatus)}
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
          key={tab}
          data={tabFiltered}
          columns={columns}
          pageSize={25}
          searchPlaceholder="Search customer or event…"
          fullWidthSearch
          tightToolbar
          boldUppercaseHeader
          toolbarExtraAfterColumns
          hideRowCount
          getRowId={(row) => String(row.id)}
          onRowClick={(row) => setEditRow(row)}
          renderMobileCard={renderMobileCard}
          paginationVariant="simple"
          initialVisibility={{ updatedAt: false }}
          // Done tab sorts by completion time (newest first); other tabs by
          // amount. key={tab} remounts so this re-seeds on tab change.
          initialSorting={tab === "refunded" ? [{ id: "updatedAt", desc: true }] : [{ id: "amount", desc: true }]}
          belowToolbar={
            creating ? (
              <div className="hidden md:block">
                <CreateRefundCard
                  events={options?.events ?? []}
                  reasonOptions={reasonOptions}
                  onCreated={handleCreated}
                  onClose={() => setCreating(false)}
                />
              </div>
            ) : undefined
          }
          toolbarExtra={
            <>
              <div className="md:hidden w-40 shrink-0">
                <EventSelect
                  value={eventFilter}
                  onChange={setEventFilter}
                  events={options?.events ?? []}
                  placeholder="All event"
                  clearable
                />
              </div>
              <button
                onClick={() => setCreating((o) => !o)}
                className={`hidden md:inline-flex items-center gap-1.5 h-[38px] px-3 text-sm rounded-lg border transition-colors ${
                  creating ? "bg-brand-light text-brand border-brand/30" : "bg-brand text-white border-transparent hover:bg-brand-hover"
                }`}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                New Refund
              </button>
            </>
          }
        />
      </div>

      {/* Mobile add FAB */}
      <button
        type="button"
        onClick={() => setMobileCreating(true)}
        aria-label="New refund"
        className="md:hidden fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 w-14 h-14 rounded-full bg-brand text-white text-3xl leading-none shadow-lg flex items-center justify-center active:bg-brand/90"
      >
        +
      </button>

      {/* Mobile add sheet */}
      {mobileCreating && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/40 flex flex-col justify-end" onClick={() => setMobileCreating(false)}>
          <div className="max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <CreateRefundCard
              events={options?.events ?? []}
              reasonOptions={reasonOptions}
              onCreated={(row) => { handleCreated(row); setMobileCreating(false); window.scrollTo({ top: 0, behavior: "smooth" }) }}
              onClose={() => setMobileCreating(false)}
            />
          </div>
        </div>
      )}

      {editRow && (
        <RefundDetailModal
          row={editRow}
          accounts={options?.accounts ?? []}
          onUpdated={handleUpdated}
          onDeleted={() => handleDeleted(editRow.id)}
          onClose={() => setEditRow(null)}
        />
      )}
    </>
  )
}

// ─── Create refund card ──────────────────────────────────────────────────────

function CreateRefundCard({
  events,
  reasonOptions,
  onCreated,
  onClose,
}: {
  events: string[]
  reasonOptions: { value: string; label: string }[]
  onCreated: (row: RefundRow) => void
  onClose: () => void
}) {
  const [form, setForm] = useState({
    event: "",
    customer: "",
    reason: "overpayment" as RefundReason,
    refundAmount: "",
    note: "",
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function field<K extends keyof typeof form>(key: K) {
    return {
      value: form[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
        setForm((f) => ({ ...f, [key]: e.target.value })),
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: form.event,
          customer: form.customer.trim(),
          reason: form.reason,
          refundAmount: Number(form.refundAmount),
          note: form.note.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to create")
      setForm({ event: "", customer: "", reason: "overpayment", refundAmount: "", note: "" })
      onCreated(data.row)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create")
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-t-2xl md:rounded-xl border-x border-t border-cream-border md:border bg-white p-5 pb-8 md:pb-5 flex flex-col gap-4">
      <div className="flex items-center justify-between -mx-5 px-5 border-b border-cream-border pb-3 md:mx-0 md:px-0 md:border-b-0 md:pb-0">
        <span className="text-base md:text-sm font-semibold text-foreground">New Refund</span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-500">Event</span>
          <EventSelect value={form.event} onChange={(v) => setForm((f) => ({ ...f, event: v }))} events={events} disabled={saving} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-500">Customer (Instagram ID)</span>
          <input {...field("customer")} required disabled={saving} placeholder="@username" className={`${INPUT_CLASS} w-full`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-500">Reason</span>
          <SearchableSelect
            value={form.reason}
            onChange={(v) => setForm((f) => ({ ...f, reason: v }))}
            options={reasonOptions}
            placeholder="Select or type…"
            allowNewValue
            disabled={saving}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-500">Refund Amount (Rp)</span>
          <input
            {...field("refundAmount")}
            type="number"
            min="1"
            required
            disabled={saving}
            placeholder="e.g. 150000"
            className={`${INPUT_CLASS} w-full`}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-500">Note <span className="font-normal text-gray-400">(optional)</span></span>
        <textarea {...field("note")} disabled={saving} rows={2} placeholder="Additional context…" className={`${INPUT_CLASS} w-full resize-none`} />
      </label>

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
          Cancel
        </button>
        <button type="submit" disabled={saving} className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors">
          {saving ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  )
}

// ─── Refund detail modal ──────────────────────────────────────────────────────

// The cash-refund pipeline as linear steps, up to the last one with an action.
// Once transferred the refund goes read-only and shows a "Transfer Complete"
// summary instead — no separate "Done" node needed. Terminal side-tracks
// (cancelled, applied_to_next_order) render their own blocks instead of this.
const FLOW_STEPS: { status: RefundStatus; label: string }[] = [
  { status: "pending", label: "Message" },
  { status: "awaiting_bank_info", label: "Bank Info" },
  { status: "ready_to_refund", label: "Transfer" },
]

function StepIndicator({ status }: { status: RefundStatus }) {
  const current = FLOW_STEPS.findIndex((s) => s.status === status)
  if (current < 0) return null
  return (
    <div className="flex items-center px-6 py-3 border-b border-cream-border">
      {FLOW_STEPS.map((step, i) => (
        <div key={step.status} className={`flex items-center ${i > 0 ? "flex-1" : ""}`}>
          {i > 0 && <div className={`flex-1 h-px mx-2 ${i <= current ? "bg-brand" : "bg-cream-border"}`} />}
          <div className="flex items-center gap-1.5 shrink-0">
            <span
              className={`w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center border ${
                i < current
                  ? "bg-brand border-brand text-white"
                  : i === current
                    ? "border-brand text-brand bg-white"
                    : "border-gray-300 text-gray-400 bg-white"
              }`}
            >
              {i < current ? "✓" : i + 1}
            </span>
            <span className={`text-[11px] ${i === current ? "font-semibold text-brand" : "text-gray-400"}`}>
              {step.label}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

function RefundDetailModal({
  row,
  accounts,
  onUpdated,
  onDeleted,
  onClose,
}: {
  row: RefundRow
  /** OUR bank names (BCA/JAGO/...) for the execute step's Account picker. */
  accounts: string[]
  onUpdated: (updated: RefundRow) => void
  onDeleted: () => void
  onClose: () => void
}) {
  const [bankName, setBankName] = useState(row.bankName)
  const [bankAccountNumber, setBankAccountNumber] = useState(row.bankAccountNumber)
  const [bankAccountHolder, setBankAccountHolder] = useState(row.bankAccountHolder)
  const [transferRef, setTransferRef] = useState(row.transferReference)
  const [refundAccount, setRefundAccount] = useState("")
  const [note, setNote] = useState(row.note)
  const [refundAmount, setRefundAmount] = useState(String(row.refundAmount))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const [invoiceEvent, setInvoiceEvent] = useState<InvoiceEvent | null>(null)
  const [invoiceLoading, setInvoiceLoading] = useState(true)
  const [invoiceError, setInvoiceError] = useState<string | null>(null)
  // Collapsed-by-default sections keep the modal short enough to never scroll
  // in the common case — the old layout hid half the workflow below the fold.
  const [showMessage, setShowMessage] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  // Opens the full invoice as a drawer over this modal instead of navigating
  // away to /dashboard/invoice, so the refund list keeps its place.
  const [showFullInvoice, setShowFullInvoice] = useState(false)

  // Apply-as-credit flow: the customer's other orders are the valid targets.
  const [customerEvents, setCustomerEvents] = useState<InvoiceEvent[]>([])
  const [showCredit, setShowCredit] = useState(false)
  const [creditTarget, setCreditTarget] = useState("")
  const [creditAmount, setCreditAmount] = useState("")

  useEffect(() => {
    let cancelled = false
    setInvoiceLoading(true)
    setInvoiceError(null)
    fetchJson<InvoiceResult>(`/api/sheets/invoice?customer=${encodeURIComponent(row.customer)}`)
      .then((data) => {
        if (cancelled) return
        setCustomerEvents(data.events)
        const match = data.events.find((ev) => ev.eventId === row.event) ?? null
        setInvoiceEvent(match)
        if (!match) setInvoiceError("No invoice found for this event")
      })
      .catch((err) => {
        if (!cancelled) setInvoiceError(err instanceof Error ? err.message : "Failed to load invoice")
      })
      .finally(() => { if (!cancelled) setInvoiceLoading(false) })
    return () => { cancelled = true }
  }, [row.customer, row.event])

  const isReadOnly = row.status === "refunded" || row.status === "cancelled" || row.status === "applied_to_next_order"

  async function patch(body: object) {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/sheets/refunds/${row.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      return false
    } finally {
      setSaving(false)
    }
  }

  async function handleStatusChange(status: RefundStatus) {
    const ok = await patch({ status })
    if (ok) onUpdated({ ...row, status })
  }

  async function handleApplyCredit() {
    if (!creditTarget) { setError("Pick a target order"); return }
    const amt = Math.round(Number(creditAmount))
    if (!Number.isFinite(amt) || amt <= 0) { setError("Enter a valid amount"); return }
    if (amt > row.refundAmount) { setError(`Amount exceeds the overpayment (${formatRp(row.refundAmount)})`); return }
    const ok = await patch({ action: "apply_credit", targetEvent: creditTarget, amount: amt })
    if (ok) {
      const remaining = row.refundAmount - amt
      onUpdated({
        ...row,
        refundAmount: Math.max(0, remaining),
        appliedCreditAmount: (row.appliedCreditAmount ?? 0) + amt,
        status: remaining <= 0 ? "applied_to_next_order" : "pending",
        hasAppliedCredit: true,
        note: remaining <= 0
          ? `Applied as credit to ${creditTarget}`
          : `Applied ${formatRp(amt)} as credit to ${creditTarget}; ${formatRp(remaining)} overpayment remaining`,
      })
      setShowCredit(false); setCreditTarget(""); setCreditAmount("")
    }
  }

  // Reverses the credit payments and reopens — for when it was applied to the
  // wrong order (or by mistake). Restores the full overpayment.
  async function handleUndoCredit() {
    const ok = await patch({ action: "undo_credit" })
    if (ok) onUpdated({
      ...row,
      status: "pending",
      hasAppliedCredit: false,
      // Restore the full overpayment = remaining + what had been applied.
      refundAmount: row.refundAmount + (row.appliedCreditAmount ?? 0),
      appliedCreditAmount: 0,
      note: "",
    })
  }

  async function handleSaveBankInfo() {
    const ok = await patch({ status: "ready_to_refund", bankName, bankAccountNumber, bankAccountHolder })
    if (!ok) return
    // Also update customer's bank info for future reuse
    await fetch("/api/sheets/customer", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instagramId: row.customer, bankName, bankAccountNumber, bankAccountHolder }),
    })
    onUpdated({ ...row, status: "ready_to_refund", bankName, bankAccountNumber, bankAccountHolder })
  }

  async function handleExecute() {
    if (!transferRef.trim()) { setError("Transfer reference is required"); return }
    if (!refundAccount.trim()) { setError("Pick the account the refund was sent from"); return }
    const ok = await patch({ action: "execute", transferReference: transferRef.trim(), account: refundAccount.trim() })
    if (ok) onUpdated({ ...row, status: "refunded", transferReference: transferRef.trim() })
  }

  async function handleSaveEdit() {
    const ok = await patch({ note, refundAmount: Number(refundAmount) })
    if (ok) {
      onUpdated({ ...row, note, refundAmount: Number(refundAmount) })
      setShowEdit(false)
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this refund? This cannot be undone.")) return
    setSaving(true)
    try {
      const res = await fetch(`/api/sheets/refunds/${row.id}`, { method: "DELETE" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to delete")
      onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete")
      setSaving(false)
    }
  }

  // Fully-cancelled invoice lines (unit === 0 is the canonical void marker) are
  // the items that became unavailable — name them in the message. Lines merely
  // reduced (e.g. 3 → 2) keep no record of the original quantity, so partial
  // shortages can't be listed and the message falls back to the generic phrasing.
  const unavailableItems = (invoiceEvent?.orders ?? [])
    .filter((o) => o.unit === 0)
    .map((o) => o.productName)
  const templates = useMessageTemplates()
  const waMessageText =
    unavailableItems.length > 0
      ? fillTemplate(templates?.refund_specific ?? DEFAULT_TEMPLATES.refund_specific, {
          customer: row.customer,
          event: row.event,
          itemsList: unavailableItems.map((n) => `- ${n}`).join("\n"),
          refundAmount: formatRp(row.refundAmount),
        })
      : fillTemplate(templates?.refund_generic ?? DEFAULT_TEMPLATES.refund_generic, {
          customer: row.customer,
          event: row.event,
          refundAmount: formatRp(row.refundAmount),
        })
  const waMessage = encodeURIComponent(waMessageText)

  async function handleCopyMessage() {
    try {
      await navigator.clipboard.writeText(waMessageText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError("Failed to copy")
    }
  }

  // One always-visible primary action per step, pinned in the footer — the old
  // layout buried each step's CTA inside a scroll area with no scroll affordance.
  const primaryAction =
    row.status === "pending" ? (
      <button
        onClick={() => handleStatusChange("awaiting_bank_info")}
        disabled={saving}
        className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
      >
        Sent
      </button>
    ) : row.status === "awaiting_bank_info" ? (
      <button
        onClick={handleSaveBankInfo}
        disabled={saving || !bankName || !bankAccountNumber || !bankAccountHolder}
        className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
      >
        {saving ? "Saving…" : "Save"}
      </button>
    ) : row.status === "ready_to_refund" ? (
      <button
        onClick={handleExecute}
        disabled={saving || !transferRef.trim() || !refundAccount.trim()}
        className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
      >
        {saving ? "Processing…" : "Refund"}
      </button>
    ) : null

  const whatsAppCard = (
    <div className="flex flex-col gap-2 p-3 rounded-lg bg-gray-50 border border-cream-border">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-gray-600">Refund message</div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowMessage((v) => !v)}
            title={showMessage ? "Hide message" : "Preview message"}
            className="inline-flex items-center justify-center w-6 h-6 rounded border border-cream-border text-gray-500 hover:bg-gray-100 transition-colors shrink-0"
          >
            {showMessage ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-10-8-10-8a18.4 18.4 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19" />
                <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                <path d="M1 1l22 22" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s3-8 11-8 11 8 11 8-3 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
          <button
            type="button"
            onClick={handleCopyMessage}
            disabled={!templates}
            title={copied ? "Copied" : "Copy message"}
            className="inline-flex items-center justify-center w-6 h-6 rounded border border-cream-border text-gray-500 hover:bg-gray-100 transition-colors shrink-0 disabled:opacity-50"
          >
            {copied ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
          <a
            href={`https://wa.me/?text=${waMessage}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => { if (!templates) e.preventDefault() }}
            title="Open in WhatsApp"
            className={`inline-flex items-center justify-center w-6 h-6 rounded border border-cream-border text-gray-500 hover:bg-gray-100 transition-colors shrink-0 ${templates ? "" : "opacity-50 pointer-events-none"}`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.44 1.32 4.94L2.05 22l5.29-1.38a9.9 9.9 0 0 0 4.7 1.2h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.85 9.85 0 0 0 12.04 2zm5.8 14.16c-.24.68-1.2 1.25-1.96 1.41-.52.11-1.2.2-3.5-.75-2.94-1.22-4.83-4.2-4.98-4.4-.15-.19-1.2-1.59-1.2-3.04 0-1.44.75-2.15 1.02-2.45.24-.26.55-.36.79-.36.2 0 .38.01.55.01.18.01.42-.07.65.5.24.6.82 2.06.89 2.21.07.15.12.33.02.53-.1.19-.15.31-.29.48-.15.17-.31.38-.44.51-.15.15-.3.31-.13.6.17.29.75 1.24 1.62 2.01 1.11.99 2.05 1.3 2.34 1.44.29.15.46.13.63-.08.17-.2.72-.84.92-1.13.19-.29.39-.24.65-.14.27.09 1.7.8 1.99.95.29.15.48.22.55.35.07.13.07.75-.17 1.43z" />
            </svg>
          </a>
        </div>
      </div>
      {showMessage ? (
        <p className="text-xs text-gray-600 whitespace-pre-wrap leading-relaxed">{waMessageText}</p>
      ) : null}
    </div>
  )

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center md:px-4" onClick={onClose}>
      <div
        className="bg-white rounded-t-2xl md:rounded-xl border-x border-t border-cream-border md:border shadow-xl w-full flex flex-col gap-0 overflow-hidden max-h-[96vh] md:max-h-[90vh] md:max-w-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — identity + the one number that matters */}
        <div className="shrink-0 flex items-start justify-between gap-3 px-6 py-4 border-b border-cream-border">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2">
              <span className="text-sm font-semibold text-foreground">{row.event}</span>
              <span className="text-sm text-gray-400 truncate uppercase">{displayIg(row.customer)}</span>
              {invoiceEvent && (
                <button
                  type="button"
                  onClick={() => setShowFullInvoice(true)}
                  aria-label="Open full invoice"
                  title="Open full invoice"
                  className="text-gray-400 hover:text-brand transition-colors shrink-0"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  </svg>
                </button>
              )}
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="text-lg font-bold text-foreground tabular-nums">{formatRp(displayAmount(row))}</span>
              {isFullyAppliedAsCredit(row) && (
                <span className="text-[11px] text-gray-400">applied as credit</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_COLORS[row.status]}`}>
              {STATUS_LABELS[row.status]}
            </span>
          </div>
        </div>

        {/* Invoice — one line, expandable. Was a 6-row block eating the modal.
            Hidden on mobile: the open-invoice icon in the header covers it there. */}
        <div className="hidden md:block shrink-0 border-b border-cream-border">
          {invoiceLoading ? (
            <div className="px-6 py-2.5 text-xs text-gray-400">Loading invoice…</div>
          ) : invoiceError ? (
            <div className="px-6 py-2.5 text-xs text-red-500">{invoiceError}</div>
          ) : invoiceEvent ? (
            <button
              type="button"
              onClick={() => setShowFullInvoice(true)}
              className="w-full flex items-center justify-between gap-2 px-6 py-2.5 text-xs hover:bg-gray-50/60 transition-colors"
            >
              <span className="text-gray-500">
                Invoice <span className="font-semibold text-foreground tabular-nums">{formatRp(invoiceEvent.invoice.total)}</span>
                {" · "}Paid <span className="font-semibold text-foreground tabular-nums">{formatRp(invoiceEvent.invoice.pembayaran)}</span>
              </span>
            </button>
          ) : null}
        </div>

        {/* Pipeline position (cash flow only — terminal side-tracks skip it) */}
        {!isReadOnly && <StepIndicator status={row.status} />}

        <div className="flex-1 min-h-0 flex flex-col gap-3 md:gap-4 px-6 py-3 md:py-4 overflow-y-auto">
          {/* Stale-amount review banner — the invoice changed after credit was
              applied, so the stored amount no longer matches the real overpayment
              and the auto-reconcile left it for a human. */}
          {(() => {
            const msg = reviewMessage(row)
            if (!msg) return null
            return (
              <div className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-50 border border-amber-200">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-600 shrink-0 mt-0.5">
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <div className="text-xs text-amber-800">
                  <span className="font-semibold">Needs review.</span> {msg}
                </div>
              </div>
            )
          })()}

          {/* ── Current step ── */}

          {row.status === "pending" && whatsAppCard}

          {row.status === "awaiting_bank_info" && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-3 p-3 rounded-lg bg-gray-50 border border-cream-border">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-gray-600">Bank Name</span>
                  <input
                    value={bankName}
                    onChange={(e) => setBankName(e.target.value)}
                    disabled={saving}
                    placeholder="e.g. BCA, Mandiri"
                    className={`${INPUT_CLASS} w-full`}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-gray-600">Account Number</span>
                  <input
                    value={bankAccountNumber}
                    onChange={(e) => setBankAccountNumber(e.target.value)}
                    disabled={saving}
                    placeholder="e.g. 1234567890"
                    className={`${INPUT_CLASS} w-full`}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-gray-600">Account Holder Name</span>
                  <input
                    value={bankAccountHolder}
                    onChange={(e) => setBankAccountHolder(e.target.value)}
                    disabled={saving}
                    placeholder="Full name on account"
                    className={`${INPUT_CLASS} w-full`}
                  />
                </label>
              </div>
              {/* Customer hasn't replied yet? Message tools stay one click away. */}
              {whatsAppCard}
            </div>
          )}

          {row.status === "ready_to_refund" && (
            <div className="flex flex-col gap-3 p-3 rounded-lg bg-gray-50 border border-cream-border">
              <div className="text-xs font-medium text-gray-600">Execute transfer</div>
              <div className="text-xs text-gray-500">
                Transfer <span className="font-bold text-foreground">{formatRp(row.refundAmount)}</span> to{" "}
                <span className="font-medium text-foreground">{row.bankName}</span> · {row.bankAccountNumber} · {row.bankAccountHolder}
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-600">Sent from account <span className="text-brand">*</span></span>
                <SearchableSelect
                  value={refundAccount}
                  onChange={setRefundAccount}
                  options={accounts.map((a) => ({ value: a, label: a }))}
                  placeholder="Which of our accounts sent it..."
                  allowNewValue
                  disabled={saving}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-600">Transfer Reference</span>
                <input
                  value={transferRef}
                  onChange={(e) => setTransferRef(e.target.value)}
                  disabled={saving}
                  placeholder="e.g. TRF20240510-001"
                  className={`${INPUT_CLASS} w-full`}
                />
              </label>
            </div>
          )}

          {/* Refunded — show summary */}
          {row.status === "refunded" && (
            <div className="flex flex-col gap-1.5 p-3 rounded-lg bg-gray-50 border border-cream-border text-xs text-gray-500">
              <div className="font-medium text-gray-600">Transfer complete</div>
              <div>Reference: <span className="font-medium text-foreground">{row.transferReference || "—"}</span></div>
              <div>Bank: <span className="font-medium text-foreground">{row.bankName} · {row.bankAccountNumber}</span></div>
              <div>Holder: <span className="font-medium text-foreground">{row.bankAccountHolder}</span></div>
            </div>
          )}

          {/* Cancelled, or marked applied with no credit actually moved (legacy
              label-only) — nothing to reverse, so a plain status reopen is safe. */}
          {(row.status === "cancelled" || (row.status === "applied_to_next_order" && !row.hasAppliedCredit)) && (
            <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-gray-50 border border-gray-200">
              <div className="text-xs text-gray-600">
                {row.status === "cancelled"
                  ? "This refund was cancelled."
                  : "Marked as applied to a next order, but no credit was actually moved."}
                <br />
                <span className="text-gray-400">Pressed by mistake? Reopen to continue processing.</span>
              </div>
              <button
                type="button"
                onClick={() => handleStatusChange("pending")}
                disabled={saving}
                className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
              >
                ↩ Reopen
              </button>
            </div>
          )}

          {/* Credit applied (fully or partially) — undoing REVERSES the credit
              payments and restores the overpayment, not just relabels. */}
          {row.hasAppliedCredit && (
            <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-purple-50 border border-purple-200">
              <div className="text-xs text-purple-700">
                {row.note || "Applied as credit to another order."}
                <br />
                <span className="text-purple-500">Wrong order? Undo to reverse the credit{row.status !== "applied_to_next_order" ? " applied so far" : " and reopen this refund"}.</span>
              </div>
              <button
                type="button"
                onClick={handleUndoCredit}
                disabled={saving}
                className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-purple-300 text-purple-700 hover:border-purple-500 hover:bg-purple-100 disabled:opacity-50 transition-colors"
              >
                {saving ? "Undoing…" : "↩ Undo credit"}
              </button>
            </div>
          )}

          {/* Edit amount & note — off the main path, one click away */}
          {!isReadOnly && (
            <div className="flex flex-col gap-2 p-3 rounded-lg bg-gray-50 border border-cream-border">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-gray-600">Amount and note</div>
                <button
                  type="button"
                  onClick={() => setShowEdit((v) => !v)}
                  title={showEdit ? "Hide" : "Edit"}
                  className="inline-flex items-center justify-center w-6 h-6 rounded border border-cream-border text-gray-500 hover:bg-gray-100 transition-colors shrink-0"
                >
                  {showEdit ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
                    </svg>
                  )}
                </button>
              </div>
              {showEdit && (
                <div className="flex flex-col gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-gray-500">Refund Amount (Rp)</span>
                    <input
                      type="number"
                      min="1"
                      value={refundAmount}
                      onChange={(e) => setRefundAmount(e.target.value)}
                      disabled={saving}
                      className={`${INPUT_CLASS} w-full`}
                    />
                  </label>
                  {row.appliedCreditAmount > 0 && !isFullyAppliedAsCredit(row) && (
                    <p className="text-[11px] text-gray-400 -mt-2">
                      {formatRp(row.appliedCreditAmount)} already applied as credit elsewhere — the amount above is what's still left to refund.
                    </p>
                  )}
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-gray-500">Note</span>
                    <textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      disabled={saving}
                      rows={2}
                      className={`${INPUT_CLASS} w-full resize-none`}
                    />
                  </label>
                  <div className="flex justify-end">
                    <button onClick={handleSaveEdit} disabled={saving} className="text-xs px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
                      {saving ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {isReadOnly && row.note && (
            <p className="text-xs text-gray-500"><span className="font-medium text-gray-400">Note:</span> {row.note}</p>
          )}

          {/* Apply as credit — pick which of the customer's other orders to credit */}
          {!isReadOnly && (
            <div className="flex flex-col gap-2 p-3 rounded-lg bg-gray-50 border border-cream-border">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-gray-600">Apply as credit</div>
                <button
                  type="button"
                  onClick={() => setShowCredit((v) => !v)}
                  title={showCredit ? "Hide" : "Apply as credit"}
                  className="inline-flex items-center justify-center w-6 h-6 rounded border border-cream-border text-gray-500 hover:bg-gray-100 transition-colors shrink-0"
                >
                  {showCredit ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                  )}
                </button>
              </div>
              {showCredit && (
              <div className="flex flex-col gap-3">
              <div className="text-xs text-purple-700">
                Move up to <span className="font-bold">{formatRp(row.refundAmount)}</span> of overpayment credit to
                another order for <span className="font-medium">{displayIg(row.customer)}</span>. No cash moves — it
                leaves this order and counts as payment on the chosen one.
              </div>
              {customerEvents.filter((ev) => ev.eventId !== row.event).length === 0 ? (
                <p className="text-xs text-purple-600">
                  This customer has no other orders to credit. Create their next order first, then apply the credit.
                </p>
              ) : (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-purple-800">Target order (event)</span>
                    <select
                      value={creditTarget}
                      onChange={(e) => {
                        const id = e.target.value
                        setCreditTarget(id)
                        // Default the amount to what the target owes, capped at
                        // the overpayment — so the common case fully settles the
                        // target without over-crediting it.
                        const tgt = customerEvents.find((ev) => ev.eventId === id)
                        const owed = Math.max(0, tgt?.invoice.sisaPelunasan ?? 0)
                        setCreditAmount(id ? String(Math.min(row.refundAmount, owed) || row.refundAmount) : "")
                      }}
                      disabled={saving}
                      className={`${INPUT_CLASS} w-full`}
                    >
                      <option value="">Select an order…</option>
                      {customerEvents
                        .filter((ev) => ev.eventId !== row.event)
                        .map((ev) => {
                          const owed = Math.max(0, ev.invoice.sisaPelunasan)
                          return (
                            <option key={ev.eventId} value={ev.eventId}>
                              {ev.eventId} — {owed > 0 ? `owes ${formatRp(owed)}` : "fully paid"}
                            </option>
                          )
                        })}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-purple-800">Amount to apply (max {formatRp(row.refundAmount)})</span>
                    <input
                      type="number"
                      min="1"
                      max={row.refundAmount}
                      value={creditAmount}
                      onChange={(e) => setCreditAmount(e.target.value)}
                      disabled={saving || !creditTarget}
                      className={`${INPUT_CLASS} w-full`}
                    />
                  </label>
                  {(() => {
                    // Warn (but don't block) when the chosen amount exceeds what
                    // the target owes: the excess resurfaces as a fresh
                    // overpayment on that order rather than fully clearing.
                    const tgt = customerEvents.find((ev) => ev.eventId === creditTarget)
                    const amt = Math.round(Number(creditAmount)) || 0
                    if (!tgt || amt <= 0) return null
                    const owed = Math.max(0, tgt.invoice.sisaPelunasan)
                    if (amt <= owed) return null
                    const excess = amt - owed
                    return (
                      <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2">
                        ⚠ {formatRp(amt)} is more than {tgt.eventId} owes ({formatRp(owed)}). The extra{" "}
                        <span className="font-semibold">{formatRp(excess)}</span> will resurface as a new overpayment
                        on {tgt.eventId} — no money is lost, but it won't fully clear there.
                      </p>
                    )
                  })()}
                  <div className="flex gap-2">
                    <button
                      onClick={handleApplyCredit}
                      disabled={saving || !creditTarget || !(Math.round(Number(creditAmount)) > 0)}
                      className="px-4 py-2 rounded-lg bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 disabled:opacity-50 transition-colors"
                    >
                      {saving ? "Applying…" : "Apply Credit"}
                    </button>
                    <button
                      onClick={() => { setShowCredit(false); setCreditTarget(""); setCreditAmount("") }}
                      disabled={saving}
                      className="px-3 py-2 rounded-lg border border-purple-200 text-purple-700 text-sm hover:bg-purple-100 disabled:opacity-50 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
              </div>
              )}
            </div>
          )}
        </div>

        {/* Footer — Delete (when editable) on the left, Cancel + primary CTA right */}
        {error && <p className="shrink-0 text-xs text-red-500 px-6 pb-2">{error}</p>}
        <div className="shrink-0 flex items-center justify-between gap-2 px-6 py-4 border-t border-cream-border">
          {!isReadOnly ? (
            <button
              type="button"
              onClick={handleDelete}
              disabled={saving}
              aria-label="Delete"
              className="inline-flex items-center justify-center h-[38px] border border-cream-border rounded-lg px-3 text-sm text-gray-400 hover:border-brand disabled:opacity-50 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" />
              </svg>
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
            {primaryAction}
          </div>
        </div>
      </div>
    </div>
    {showFullInvoice && (
      // Wrapper raises the drawer (z-40) above this refund modal (z-50).
      <div className="relative z-[60]">
        <InvoiceDetailDrawer customer={row.customer} onClose={() => setShowFullInvoice(false)} />
      </div>
    )}
    </>
  )
}
