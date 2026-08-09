"use client"

import { displayIg } from "@/lib/format"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { AdjustmentRow } from "@/lib/db"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import { useModalDismiss } from "@/hooks/useModalDismiss"
import SearchableSelect from "@/components/SearchableSelect"
import EventSelect from "@/components/EventSelect"
import DataGrid, {
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type PaginationState,
} from "@/components/DataGrid"
import { usePaginatedFetch, type PageData } from "@/hooks/usePaginatedFetch"
import { descriptionOptions, AmountSignHint } from "./shared"

const PAGE_SIZE = 25

const INPUT_CLASS =
  "w-full border border-cream-border rounded-md px-2 py-1 text-sm text-foreground bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
const LABEL = "text-xs text-gray-500 mb-1 block"

type EditForm = {
  event: string
  customer: string
  description: string
  amount: string
}

function formatAmount(n: number): string {
  return new Intl.NumberFormat("id-ID").format(n)
}

export default function AdjustmentsClient() {
  const options = useSheetOptions()
  const [rows, setRows] = useState<AdjustmentRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [filteredSum, setFilteredSum] = useState<number | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [mobileAddOpen, setMobileAddOpen] = useState(false)
  const [editingRow, setEditingRow] = useState<AdjustmentRow | null>(null)

  // Every previously typed description, so the picker keeps suggesting them
  // (not just the two built-in presets).
  const [dbDescriptions, setDbDescriptions] = useState<string[]>([])
  useEffect(() => {
    fetch("/api/sheets/adjustments?meta=descriptions")
      .then((res) => res.json())
      .then((data) => setDbDescriptions(data.descriptions ?? []))
      .catch(() => {})
  }, [])

  // Server-side table state.
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState("")
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE })

  const fetchFilters = useMemo<Record<string, string>>(() => {
    const f: Record<string, string> = {}
    for (const cf of columnFilters) {
      // Date column carries a {from,to} range object, not a plain string.
      if (cf.id === "createdAt") {
        const { from, to } = (cf.value as { from?: string; to?: string } | undefined) ?? {}
        if (from) f.dateFrom = from
        if (to) f.dateTo = to
        continue
      }
      const v = String(cf.value ?? "").trim()
      if (!v) continue
      if (cf.id === "event") f.event = v
      else if (cf.id === "customer") f.customer = v
      else if (cf.id === "description") f.description = v
    }
    return f
  }, [columnFilters])

  const fetchSort = useMemo(() => {
    if (sorting.length === 0) return null
    return { key: sorting[0].id, direction: sorting[0].desc ? ("desc" as const) : ("asc" as const) }
  }, [sorting])

  const onData = useCallback((d: PageData) => {
    setRows(d.rows as AdjustmentRow[])
    setTotalCount(d.totalCount)
    setFilteredSum(d.filteredSum)
  }, [])

  const { fetchState, refresh } = usePaginatedFetch({
    endpoint: "/api/sheets/adjustments",
    pageSize: PAGE_SIZE,
    page: pagination.pageIndex + 1,
    search: globalFilter,
    filters: fetchFilters,
    sort: fetchSort,
    onData,
  })

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  const handleSortingChange = useCallback((u: SortingState | ((p: SortingState) => SortingState)) => {
    setSorting(u); setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])
  const handleColumnFiltersChange = useCallback((u: ColumnFiltersState | ((p: ColumnFiltersState) => ColumnFiltersState)) => {
    setColumnFilters(u); setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])
  const handleGlobalFilterChange = useCallback((u: string | ((p: string) => string)) => {
    setGlobalFilter(u); setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])

  async function handleDeleteRow(row: AdjustmentRow) {
    if (!confirm("Delete this adjustment? This cannot be undone.")) return
    try {
      const res = await fetch(`/api/sheets/adjustments/${row.rowNumber}`, { method: "DELETE" })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? "Failed to delete")
      }
      refreshRef.current()
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  const columns = useMemo<ColumnDef<AdjustmentRow, unknown>[]>(() => [
    {
      accessorKey: "event",
      header: "Event",
      size: 130,
      filterFn: "textContains",
    },
    {
      accessorKey: "customer",
      header: "Customer",
      size: 160,
      filterFn: "textContains",
      cell: ({ getValue }) => <span>{displayIg(getValue<string>())}</span>,
    },
    {
      accessorKey: "description",
      header: "Description",
      size: 220,
      filterFn: "textContains",
      cell: ({ getValue }) => {
        const v = getValue<string>()
        return v || "—"
      },
    },
    {
      accessorKey: "amount",
      header: "Amount",
      size: 130,
      enableColumnFilter: false,
      meta: { align: "right" },
      cell: ({ getValue }) => {
        const n = getValue<number>()
        return (
          <span className="font-medium tabular-nums text-foreground">
            {n < 0 ? `−${formatAmount(Math.abs(n))}` : formatAmount(n)}
          </span>
        )
      },
    },
    {
      accessorKey: "createdAt",
      header: "Created",
      size: 110,
      filterFn: "dateRange",
      cell: ({ getValue }) => (
        <span className="text-gray-400 text-xs">{getValue<string>()}</span>
      ),
    },
    {
      accessorKey: "updatedAt",
      header: "Updated",
      size: 110,
      enableColumnFilter: false,
      enableHiding: true,
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableColumnFilter: false,
      enableHiding: false,
      size: 80,
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setEditingRow(row.original)}
            title="Edit"
            className="text-gray-400 hover:text-brand transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => handleDeleteRow(row.original)}
            title="Delete"
            className="text-gray-400 hover:text-red-500 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      ),
    },
  ], [])

  const renderMobileCard = useCallback((row: AdjustmentRow) => (
    <div
      onClick={() => setEditingRow(row)}
      className="rounded-xl border border-cream-border bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex items-center justify-between gap-3 cursor-pointer active:bg-cream/40 transition-colors"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-foreground">{row.event}</span>
          <span className="text-xs text-gray-400 uppercase">{displayIg(row.customer)}</span>
        </div>
      </div>
      <span className="text-sm font-semibold tabular-nums shrink-0 text-foreground">
        {row.amount < 0 ? `−Rp ${formatAmount(Math.abs(row.amount))}` : `Rp ${formatAmount(row.amount)}`}
      </span>
    </div>
  ), [])

  if (fetchState.error) {
    return (
      <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-red-500">
        {fetchState.error}
        <button onClick={() => refreshRef.current()} className="ml-2 underline hover:no-underline">Retry</button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <DataGrid
        data={rows}
        columns={columns}
        searchPlaceholder="Search adjustments..."
        fullWidthSearch
        tightToolbar
        boldUppercaseHeader
        toolbarExtraAfterColumns
        hideRowCount
        getRowId={(row) => String(row.rowNumber)}
        initialVisibility={{ updatedAt: false }}
        renderMobileCard={renderMobileCard}
        paginationVariant="simple"
        belowToolbar={
          addOpen ? (
            <div className="hidden md:block">
              <AddAdjustmentForm
                options={options}
                dbDescriptions={dbDescriptions}
                onClose={() => setAddOpen(false)}
                onAdded={() => refreshRef.current()}
              />
            </div>
          ) : undefined
        }
        toolbarExtra={
          <>
            <button
              onClick={() => { setAddOpen((o) => !o); setEditingRow(null) }}
              className={`hidden md:inline-flex items-center gap-1.5 h-[38px] px-3 text-sm rounded-lg border transition-colors ${
                addOpen ? "bg-brand-light text-brand border-brand/30" : "bg-brand text-white border-transparent hover:bg-brand-hover"
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Add Adjustment
            </button>
          </>
        }
        serverSide={{
          rowCount: totalCount,
          loading: fetchState.loading,
          sorting,
          onSortingChange: handleSortingChange,
          columnFilters,
          onColumnFiltersChange: handleColumnFiltersChange,
          globalFilter,
          onGlobalFilterChange: handleGlobalFilterChange,
          pagination,
          onPaginationChange: setPagination,
        }}
      />

      {editingRow && (
        <EditAdjustmentModal
          row={editingRow}
          options={options}
          dbDescriptions={dbDescriptions}
          onClose={() => setEditingRow(null)}
          onSaved={() => { setEditingRow(null); refreshRef.current() }}
          onDeleted={() => { setEditingRow(null); refreshRef.current() }}
        />
      )}

      {/* Mobile row action sheet */}
      {/* Mobile add FAB */}
      <button
        type="button"
        onClick={() => { setMobileAddOpen(true); setEditingRow(null) }}
        aria-label="Add adjustment"
        className="md:hidden fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 w-14 h-14 rounded-full bg-brand text-white text-3xl leading-none shadow-lg flex items-center justify-center active:bg-brand/90"
      >
        +
      </button>

      {/* Mobile add sheet */}
      {mobileAddOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/40 flex flex-col justify-end" onClick={() => setMobileAddOpen(false)}>
          <div className="max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <AddAdjustmentForm
              options={options}
              dbDescriptions={dbDescriptions}
              onClose={() => setMobileAddOpen(false)}
              onAdded={() => { refreshRef.current(); setMobileAddOpen(false); window.scrollTo({ top: 0, behavior: "smooth" }) }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Edit Adjustment Modal
// ---------------------------------------------------------------------------

function EditAdjustmentModal({
  row,
  options,
  dbDescriptions,
  onClose,
  onSaved,
  onDeleted,
}: {
  row: AdjustmentRow
  options: ReturnType<typeof useSheetOptions>
  dbDescriptions: string[]
  onClose: () => void
  onSaved: (updated: AdjustmentRow) => void
  onDeleted: (rowNumber: number) => void
}) {
  useModalDismiss(onClose)

  const [form, setForm] = useState<EditForm>({
    event: row.event,
    customer: row.customer,
    description: row.description,
    amount: String(row.amount),
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const customerOptions = useMemo(
    () => (options?.customers ?? []).map((c) => ({ value: c, label: displayIg(c) })),
    [options],
  )

  async function handleSave() {
    setSaving(true)
    setError("")
    try {
      const res = await fetch(`/api/sheets/adjustments/${row.rowNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: form.event,
          customer: form.customer,
          description: form.description,
          amount: Number(form.amount),
        }),
      })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? "Failed to save")
      }
      onSaved({
        ...row,
        event: form.event,
        customer: form.customer,
        description: form.description,
        amount: Number(form.amount),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this adjustment? This cannot be undone.")) return
    try {
      const res = await fetch(`/api/sheets/adjustments/${row.rowNumber}`, { method: "DELETE" })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? "Failed to delete")
      }
      onDeleted(row.rowNumber)
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40 md:flex-row md:items-center md:justify-center md:px-4" onClick={onClose}>
      <div className="w-full max-h-[90vh] overflow-y-auto md:max-w-md" onClick={e => e.stopPropagation()}>
      <div className="bg-white rounded-t-2xl md:rounded-xl border-x border-t border-cream-border md:border shadow-xl p-6 pb-8 md:pb-6" role="dialog" aria-modal="true">
        <div className="flex items-center justify-between mb-4 -mx-6 px-6 border-b border-cream-border pb-3 md:mx-0 md:px-0 md:border-b-0 md:pb-0">
          <h3 className="text-base md:text-sm font-semibold text-foreground">Edit Adjustment</h3>
        </div>

        <div className="space-y-3">
          <div>
            <label className={LABEL}>Event</label>
            <EventSelect value={form.event} onChange={(v) => setForm({ ...form, event: v })} events={options?.events ?? []} />
          </div>

          <div>
            <label className={LABEL}>Customer</label>
            <SearchableSelect
              value={form.customer}
              onChange={(v) => setForm({ ...form, customer: v })}
              options={customerOptions}
              placeholder="Customer..."
              allowNewValue
            />
          </div>

          <div>
            <label className={LABEL}>Description</label>
            <SearchableSelect
              value={form.description}
              onChange={(v) => setForm({ ...form, description: v })}
              options={descriptionOptions([...dbDescriptions, form.description])}
              placeholder="Select or type…"
              allowNewValue
            />
          </div>

          <div>
            <label className={LABEL}>Amount</label>
            <input
              type="number"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              className={INPUT_CLASS}
            />
            <AmountSignHint value={form.amount} />
          </div>
        </div>

        {error && <p className="text-xs text-red-500 mt-2">{error}</p>}

        <div className="flex items-center gap-2 pt-4">
          <button
            type="button"
            onClick={handleDelete}
            aria-label="Delete"
            className="inline-flex items-center justify-center h-[38px] border border-cream-border rounded-lg px-3 text-sm text-gray-400 hover:border-brand disabled:opacity-50 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add Adjustment Form
// ---------------------------------------------------------------------------

function AddAdjustmentForm({
  options,
  dbDescriptions,
  onClose,
  onAdded,
}: {
  options: ReturnType<typeof useSheetOptions>
  dbDescriptions: string[]
  onClose: () => void
  onAdded: () => void
}) {
  const [event, setEvent] = useState("")
  const [customer, setCustomer] = useState("")
  const [description, setDescription] = useState("")
  const [amount, setAmount] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null)

  const customerOptions = useMemo(
    () => (options?.customers ?? []).map((c) => ({ value: c, label: displayIg(c) })),
    [options],
  )

  const canSubmit = Boolean(event) && Boolean(customer) && Boolean(amount) && Number(amount) !== 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setFeedback(null)
    try {
      const res = await fetch("/api/sheets/adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, customer, description, amount: Number(amount) }),
      })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? "Failed to save")
      }
      setFeedback({ type: "success", message: "Adjustment added" })
      setEvent("")
      setCustomer("")
      setDescription("")
      setAmount("")
      onAdded()
    } catch (err) {
      setFeedback({ type: "error", message: err instanceof Error ? err.message : "Failed to save" })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-t-2xl md:rounded-xl border-x border-t border-cream-border md:border bg-white p-4 pb-8 md:pb-4">
      <div className="flex items-center justify-between mb-3 -mx-4 px-4 border-b border-cream-border pb-3 md:mx-0 md:px-0 md:border-b-0 md:pb-0">
        <h3 className="text-base md:text-sm font-semibold text-foreground">Add Adjustment</h3>
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="grid grid-cols-2 gap-3 w-full">
            <div className="min-w-0">
              <label className={LABEL}>Event <span className="text-brand">*</span></label>
              <EventSelect value={event} onChange={(v) => { setEvent(v); setFeedback(null) }} events={options?.events ?? []} />
            </div>
            <div className="min-w-0">
              <label className={LABEL}>Customer <span className="text-brand">*</span></label>
              <SearchableSelect
                value={customer}
                onChange={(v) => { setCustomer(v); setFeedback(null) }}
                options={customerOptions}
                placeholder="Customer..."
                allowNewValue
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 w-full">
            <div className="min-w-0">
              <label className={LABEL}>Description</label>
              <SearchableSelect
                value={description}
                onChange={(v) => { setDescription(v); setFeedback(null) }}
                options={descriptionOptions([...dbDescriptions, description])}
                placeholder="Select or type…"
                allowNewValue
              />
            </div>
            <div className="min-w-0">
              <label className={LABEL}>Amount <span className="text-brand">*</span></label>
              <input type="number" value={amount} onChange={(e) => { setAmount(e.target.value); setFeedback(null) }} placeholder="0" className="w-full border border-cream-border rounded-md px-2 py-2 text-sm text-foreground bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors" />
            </div>
          </div>
        </div>
        <p className="text-[11px] text-gray-400 leading-snug">
          <strong>Positive</strong> = Biaya Lainnya (adds to total). <strong>Negative</strong> = Diskon (reduces total).
        </p>
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} disabled={submitting} className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
            Cancel
          </button>
          <button type="submit" disabled={submitting || !canSubmit} className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
            {submitting ? "Saving…" : "Add"}
          </button>
        </div>
      </form>
      {feedback && <p className={`text-xs mt-2 ${feedback.type === "success" ? "text-green-600" : "text-red-600"}`}>{feedback.message}</p>}
    </div>
  )
}
