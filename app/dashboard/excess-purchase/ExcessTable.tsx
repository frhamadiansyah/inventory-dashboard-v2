"use client"

import { useState, useMemo, useCallback, useRef, useEffect } from "react"
import type { ExcessRow, ExcessReason } from "@/lib/db"
import DataGrid, {
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type PaginationState,
} from "@/components/DataGrid"
import { usePaginatedFetch, type PageData } from "@/hooks/usePaginatedFetch"
import { fmt, displayIg } from "@/lib/format"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import EventSelect from "@/components/EventSelect"
import CopyButton from "@/components/CopyButton"
import SearchableSelect from "@/components/SearchableSelect"

const PAGE_SIZE = 25

const REASON_LABEL: Record<ExcessReason, string> = {
  overbuy: "Overbuy",
  overship: "Overship",
  wrong_product: "Wrong",
  broken: "Broken",
  customer_cancelled: "Customer cancelled",
  manual: "Manual entry",
}

const REASON_CLASS: Record<ExcessReason, string> = {
  overbuy: "bg-gray-100 text-gray-700 border-gray-200",
  overship: "bg-blue-50 text-blue-700 border-blue-200",
  wrong_product: "bg-yellow-50 text-yellow-700 border-yellow-200",
  broken: "bg-red-50 text-red-700 border-red-200",
  customer_cancelled: "bg-purple-50 text-purple-700 border-purple-200",
  manual: "bg-teal-50 text-teal-700 border-teal-200",
}

function ReasonBadge({ reason }: { reason: ExcessReason }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded-full text-[10px] font-medium border ${REASON_CLASS[reason]}`}>
      {REASON_LABEL[reason]}
    </span>
  )
}

type UpdatedRow = { rowNumber: number; event: string; customer: string; oldUnitBuy: number; unitBuy: number }
type ApplyResult = { filled: UpdatedRow[]; remainder: number }

export default function ExcessTable() {
  const options = useSheetOptions()
  const [rows, setRows] = useState<ExcessRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [filteredSum, setFilteredSum] = useState<number | null>(null)
  const [filteredValue, setFilteredValue] = useState<number | null>(null)
  const [busyRow, setBusyRow] = useState<number | null>(null)
  const [pendingRow, setPendingRow] = useState<number | null>(null)
  const [pendingReceipt, setPendingReceipt] = useState("apply excess")
  const [applyResult, setApplyResult] = useState<{ excessRowNumber: number; result: ApplyResult } | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [mobileAddOpen, setMobileAddOpen] = useState(false)
  const [editRow, setEditRow] = useState<ExcessRow | null>(null)
  const [deleteRow, setDeleteRow] = useState<ExcessRow | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Server-side table state.
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState("")
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE })

  const fetchFilters = useMemo<Record<string, string>>(() => {
    const f: Record<string, string> = {}
    for (const cf of columnFilters) {
      const v = String(cf.value ?? "").trim()
      if (!v) continue
      if (cf.id === "event") f.event = v
      else if (cf.id === "items") f.items = v
      else if (cf.id === "receipt") f.receipt = v
      else if (cf.id === "reason") f.reason = v
    }
    return f
  }, [columnFilters])

  const fetchSort = useMemo(() => {
    if (sorting.length === 0) return null
    return { key: sorting[0].id, direction: sorting[0].desc ? ("desc" as const) : ("asc" as const) }
  }, [sorting])

  const onData = useCallback((d: PageData & { filteredValue?: number | null }) => {
    setRows(d.rows as ExcessRow[])
    setTotalCount(d.totalCount)
    setFilteredSum(d.filteredSum)
    if (d.filteredValue !== undefined) setFilteredValue(d.filteredValue)
  }, [])

  const { fetchState, refresh } = usePaginatedFetch({
    endpoint: "/api/sheets/excess-purchase",
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

  function openPending(rowNumber: number) {
    setPendingRow(rowNumber)
    setPendingReceipt("apply excess")
    setApplyResult(null)
  }

  function cancelPending() {
    setPendingRow(null)
  }

  async function handleApply(row: ExcessRow, allocations: { rowNumber: number; allocate: number }[]) {
    setBusyRow(row.rowNumber)
    setPendingRow(null)
    setApplyResult(null)
    try {
      const res = await fetch(`/api/sheets/excess-purchase/${row.rowNumber}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receipt: pendingReceipt, allocations }),
      })
      const data: ApplyResult & { error?: string } = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to apply")

      setApplyResult({ excessRowNumber: row.rowNumber, result: data })
      // Row was fully consumed (deleted) or partially reduced — reload the page.
      refreshRef.current()
    } catch (err) {
      setApplyResult({
        excessRowNumber: row.rowNumber,
        result: { filled: [], remainder: row.unitBuy },
      })
    } finally {
      setBusyRow(null)
    }
  }

  async function handleDelete() {
    if (!deleteRow) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const res = await fetch(`/api/sheets/excess-purchase/${deleteRow.rowNumber}`, { method: "DELETE" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Failed to delete")
      refreshRef.current()
      setDeleteRow(null)
      setEditRow(null)
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete")
    } finally {
      setDeleteBusy(false)
    }
  }

  const columns = useMemo<ColumnDef<ExcessRow, unknown>[]>(
    () => [
      {
        accessorKey: "event",
        header: "Event",
        filterFn: "textContains",
        size: 140,
      },
      {
        accessorKey: "items",
        header: "Item",
        filterFn: "textContains",
        size: 240,
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="text-foreground truncate">{row.original.items}</div>
            {row.original.expectedItem && (
              <div className="text-[11px] text-yellow-700 truncate">
                expected: {row.original.expectedItem}
              </div>
            )}
          </div>
        ),
      },
      {
        accessorKey: "reason",
        header: "Reason",
        filterFn: "textContains",
        size: 140,
        cell: ({ getValue }) => <ReasonBadge reason={getValue<ExcessReason>()} />,
      },
      {
        accessorKey: "unitBuy",
        header: "Unit Buy",
        enableColumnFilter: false,
        size: 90,
        meta: { align: "right" },
        cell: ({ getValue }) => (
          <span className="font-medium tabular-nums">{fmt(getValue<number>())}</span>
        ),
      },
      {
        accessorKey: "price",
        header: "Price",
        enableColumnFilter: false,
        size: 130,
        meta: { align: "right" },
        cell: ({ getValue }) => {
          const price = getValue<number | null>()
          return <span className="text-gray-500 tabular-nums whitespace-nowrap">{price != null ? `Rp ${fmt(price)}` : "—"}</span>
        },
      },
      {
        accessorKey: "receipt",
        header: "Receipt",
        filterFn: "textContains",
        size: 120,
        cell: ({ getValue }) => {
          const v = getValue<string>()
          return <span className="text-gray-500 block truncate" title={v || undefined}>{v || "—"}</span>
        },
      },
      {
        accessorKey: "createdAt",
        header: "Created At",
        enableColumnFilter: false,
        size: 120,
        cell: ({ getValue }) => (
          <span className="text-gray-400 text-xs whitespace-nowrap">{getValue<string>()}</span>
        ),
      },
      {
        accessorKey: "updatedAt",
        header: "Updated At",
        enableColumnFilter: false,
        size: 120,
        cell: ({ getValue }) => (
          <span className="text-gray-400 text-xs whitespace-nowrap">{getValue<string>() || "—"}</span>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        enableColumnFilter: false,
        enableHiding: false,
        size: 150,
        cell: ({ row }) => {
          const r = row.original
          const busy = busyRow === r.rowNumber
          const isPending = pendingRow === r.rowNumber
          return (
            <div className="flex items-center justify-end gap-2">
              {/* Broken stock isn't sellable — no apply action. */}
              {r.reason === "broken" ? (
                <span className="inline-flex p-1 text-gray-300" title="Not available — broken inventory can't be applied">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="m4.9 4.9 14.2 14.2" />
                  </svg>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => isPending ? cancelPending() : openPending(r.rowNumber)}
                  disabled={busy || busyRow !== null}
                  title={busy ? "Applying…" : isPending ? "Cancel" : "Apply Excess"}
                  className={`transition-colors p-1 disabled:opacity-50 disabled:cursor-not-allowed ${
                    isPending ? "text-gray-400 hover:text-red-500" : "text-gray-400 hover:text-brand"
                  }`}
                >
                  {busy ? (
                    <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                  ) : isPending ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                      <path d="m9 11 3 3L22 4" />
                    </svg>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={() => setEditRow(r)}
                title="Edit"
                className="text-gray-400 hover:text-brand transition-colors p-1"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => { setDeleteRow(r); setDeleteError(null) }}
                title="Delete"
                className="text-gray-400 hover:text-red-500 transition-colors p-1"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
                </svg>
              </button>
            </div>
          )
        },
      },
    ],
    [busyRow, pendingRow],
  )

  const renderMobileCard = useCallback((r: ExcessRow) => {
    const busy = busyRow === r.rowNumber
    const isPending = pendingRow === r.rowNumber
    return (
      <div className="rounded-xl border border-cream-border bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1 min-w-0">
              <span className="text-sm text-foreground truncate">{r.items}</span>
              <CopyButton value={`${r.items}${r.price != null ? ` ${fmt(r.price)}` : ""}`} label="Copy name & price" />
            </div>
            {r.expectedItem && r.reason !== "wrong_product" && (
              <div className="text-[11px] text-yellow-700 truncate">expected: {r.expectedItem}</div>
            )}
            <div className="text-xs text-gray-400 mt-0.5">{r.event}</div>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <span className="text-sm font-semibold tabular-nums text-foreground">{fmt(r.unitBuy)}</span>
            <span className="text-xs text-gray-400 tabular-nums whitespace-nowrap">
              {r.price != null ? `Rp ${fmt(r.price)}` : "—"}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-end pt-2.5 border-t border-cream-border">
          <span className="mr-auto"><ReasonBadge reason={r.reason} /></span>
          {/* Broken stock isn't sellable — no apply action. */}
          {r.reason === "broken" ? (
            <span className="inline-flex px-1 py-1.5 text-gray-300" title="Not available — broken inventory can't be applied">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="m4.9 4.9 14.2 14.2" />
              </svg>
            </span>
          ) : (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); isPending ? cancelPending() : openPending(r.rowNumber) }}
              disabled={busy || busyRow !== null}
              title={busy ? "Applying…" : isPending ? "Cancel" : "Apply Excess"}
              className={`transition-colors px-1 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed ${
                isPending ? "text-gray-400 hover:text-red-500" : "text-gray-400 hover:text-brand"
              }`}
            >
              {busy ? (
                <svg className="animate-spin" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : isPending ? (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
              ) : (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <path d="m9 11 3 3L22 4" />
                </svg>
              )}
            </button>
          )}
          {/* Kebab opens the action sheet — Apply/Cancel above stays the
              direct-tap primary action, unchanged. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setEditRow(r) }}
            aria-label="Edit"
            className="px-1 py-1.5 text-gray-400 hover:text-brand transition-colors"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
            </svg>
          </button>
        </div>
      </div>
    )
  }, [busyRow, pendingRow])

  // Find the row object for the pending modal
  const pendingExcessRow = pendingRow != null ? rows.find((r) => r.rowNumber === pendingRow) : null

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
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-2 sm:gap-4">
        <div className="rounded-xl border border-cream-border border-l-4 border-l-brand bg-white px-3 py-3 sm:px-5 sm:py-4">
          <div className="text-xs font-medium text-gray-400 uppercase tracking-wide">Total Value</div>
          <div className="text-sm sm:text-2xl font-bold text-foreground mt-1 tabular-nums whitespace-nowrap">
            {filteredValue !== null ? `Rp ${fmt(filteredValue)}` : "—"}
          </div>
        </div>
        <div className="rounded-xl border border-cream-border border-l-4 border-l-amber-500 bg-white px-3 py-3 sm:px-5 sm:py-4">
          <div className="text-xs font-medium text-gray-400 uppercase tracking-wide">Total Units</div>
          <div className="text-sm sm:text-2xl font-bold text-foreground mt-1 tabular-nums whitespace-nowrap">
            {filteredSum !== null ? fmt(filteredSum) : "—"}
          </div>
        </div>
      </div>

      {/* Apply result banner */}
      {applyResult && (
        <ApplyResultBanner
          result={applyResult.result}
          onDismiss={() => setApplyResult(null)}
        />
      )}

      {/* Apply excess modal */}
      {pendingExcessRow && (
        <ApplyExcessModal
          row={pendingExcessRow}
          receipt={pendingReceipt}
          onReceiptChange={setPendingReceipt}
          onConfirm={(allocations) => { handleApply(pendingExcessRow, allocations) }}
          onCancel={cancelPending}
        />
      )}

      {/* Mobile add FAB */}
      <button
        type="button"
        onClick={() => setMobileAddOpen(true)}
        aria-label="Add inventory"
        className="md:hidden fixed right-4 bottom-20 z-30 w-14 h-14 rounded-full bg-brand text-white text-3xl leading-none shadow-lg flex items-center justify-center active:bg-brand/90"
      >
        +
      </button>

      {/* Mobile add sheet */}
      {mobileAddOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/40 flex flex-col justify-end" onClick={() => setMobileAddOpen(false)}>
          <div className="max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <AddInventoryCard
              eventOptions={options?.events ?? []}
              itemOptions={(options?.items ?? []).map((it) => ({ value: it.name, label: it.name, meta: `Rp ${fmt(it.price)}` }))}
              onClose={() => setMobileAddOpen(false)}
              onCreated={() => { refreshRef.current(); setMobileAddOpen(false); window.scrollTo({ top: 0, behavior: "smooth" }) }}
            />
          </div>
        </div>
      )}

      {/* Edit inventory modal */}
      {editRow && (
        <EditInventoryModal
          existing={editRow}
          eventOptions={options?.events ?? []}
          itemOptions={(options?.items ?? []).map((it) => ({ value: it.name, label: it.name, meta: it.store || undefined }))}
          onClose={() => setEditRow(null)}
          onUpdated={() => { refreshRef.current(); setEditRow(null) }}
          onRequestDelete={() => { setDeleteRow(editRow); setDeleteError(null) }}
        />
      )}

      {/* Delete confirmation */}
      {deleteRow && (
        <DeleteConfirmModal
          row={deleteRow}
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => { setDeleteRow(null); setDeleteError(null) }}
          onConfirm={handleDelete}
        />
      )}


      <DataGrid
        data={rows}
        columns={columns}
        getRowId={(row) => String(row.rowNumber)}
        searchPlaceholder="Search event, item, receipt…"
        fullWidthSearch
        tightToolbar
        boldUppercaseHeader
        hideRowCount
        initialVisibility={{ createdAt: false, updatedAt: false }}
        renderMobileCard={renderMobileCard}
        paginationVariant="simple"
        belowToolbar={
          addOpen ? (
            <div className="hidden md:block">
              <AddInventoryCard
                eventOptions={options?.events ?? []}
                itemOptions={(options?.items ?? []).map((it) => ({ value: it.name, label: it.name, meta: `Rp ${fmt(it.price)}` }))}
                onClose={() => setAddOpen(false)}
                onCreated={() => refreshRef.current()}
              />
            </div>
          ) : undefined
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
        toolbarExtraEnd={
          <button
            type="button"
            onClick={() => setAddOpen((o) => !o)}
            className={`hidden md:inline-flex items-center gap-1.5 h-[38px] px-3 text-sm font-medium rounded-lg border transition-colors shrink-0 ${
              addOpen ? "bg-brand-light text-brand border-brand/30" : "bg-brand text-white border-transparent hover:bg-brand-hover"
            }`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add Inventory
          </button>
        }
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Apply excess modal
// ---------------------------------------------------------------------------

type EligibleOrder = { rowNumber: number; event: string; customer: string; needed: number }
type Allocation = { rowNumber: number; allocate: number }

function ApplyExcessModal({
  row,
  receipt,
  onReceiptChange,
  onConfirm,
  onCancel,
}: {
  row: ExcessRow
  receipt: string
  onReceiptChange: (v: string) => void
  onConfirm: (allocations: Allocation[]) => void
  onCancel: () => void
}) {
  const [orders, setOrders] = useState<EligibleOrder[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [inputs, setInputs] = useState<Record<number, string>>({})

  useEffect(() => {
    let cancelled = false
    setOrders(null)
    setLoadError(null)
    fetch(`/api/sheets/excess-purchase/${row.rowNumber}`)
      .then(async (res) => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to load")
        if (!cancelled) setOrders(data.orders as EligibleOrder[])
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load")
      })
    return () => { cancelled = true }
  }, [row.rowNumber])

  const totalAllocated = Object.values(inputs).reduce((sum, v) => sum + (Number(v) || 0), 0)
  const overAllocated = totalAllocated > row.unitBuy
  const canConfirm = totalAllocated > 0 && !overAllocated

  function handleConfirm() {
    if (!canConfirm) return
    const allocations: Allocation[] = Object.entries(inputs)
      .map(([rowNumber, v]) => ({ rowNumber: Number(rowNumber), allocate: Number(v) || 0 }))
      .filter((a) => a.allocate > 0)
    onConfirm(allocations)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onCancel}>
      <div
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-md flex flex-col gap-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-foreground">Apply Excess</div>
        <p className="text-sm text-gray-600">
          <span className="font-medium">{row.items}</span> — {row.unitBuy} unit{row.unitBuy === 1 ? "" : "s"} available. Choose which order(s) to apply to.
        </p>

        {loadError && <p className="text-xs text-red-500">{loadError}</p>}
        {!orders && !loadError && <p className="text-xs text-gray-400">Loading eligible orders…</p>}
        {orders && orders.length === 0 && (
          <p className="text-xs text-gray-400">No pending orders found for this item.</p>
        )}
        {orders && orders.length > 0 && (
          <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
            {orders.map((o) => (
              <div key={o.rowNumber} className="flex items-center gap-3 border border-cream-border rounded-lg px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-foreground truncate">{displayIg(o.customer)}</div>
                  <div className="text-xs text-gray-400">{o.event} · needs {o.needed}</div>
                </div>
                <input
                  type="number"
                  min={0}
                  max={o.needed}
                  value={inputs[o.rowNumber] ?? ""}
                  onChange={(e) => setInputs((prev) => ({ ...prev, [o.rowNumber]: e.target.value }))}
                  placeholder="0"
                  className="w-20 border border-cream-border rounded-md px-2 py-1 text-sm text-right bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
                />
              </div>
            ))}
          </div>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-500">Receipt</span>
          <input
            type="text"
            value={receipt}
            onChange={(e) => onReceiptChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleConfirm()
              if (e.key === "Escape") onCancel()
            }}
            className="w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
          />
        </label>

        <div className={`text-xs ${overAllocated ? "text-red-500" : "text-gray-400"}`}>
          {totalAllocated} / {row.unitBuy} units allocated{overAllocated ? " — exceeds available" : ""}
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add / Edit inventory modal
// ---------------------------------------------------------------------------
//
// Shared by "Add Inventory" (e.g. logging pre-dashboard stock) and "Edit" on
// an existing row. Item is picked from the product catalog rather than typed
// free-text — "Apply" matches purely on exact item-name equality against
// order lines, so a typo here would silently make a row unmatchable forever.

// Shared field set for the Add card and the Edit modal below. `inline` lays
// the fields out in one flex row (with fixed field widths) instead of the
// default responsive grid, so a caller can append a trailing button
// (e.g. Submit) on the same line.
function InventoryFields({
  event, setEvent, items, setItems, unitBuy, setUnitBuy, receipt, setReceipt,
  eventOptions, itemOptions, saving, inline, trailing,
}: {
  event: string; setEvent: (v: string) => void
  items: string; setItems: (v: string) => void
  unitBuy: string; setUnitBuy: (v: string) => void
  receipt: string; setReceipt: (v: string) => void
  eventOptions: string[]
  itemOptions: { value: string; label: string; meta?: string }[]
  saving: boolean
  inline?: boolean
  trailing?: React.ReactNode
}) {
  const eventField = (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-xs font-medium text-gray-500">Event</span>
      <EventSelect value={event} onChange={setEvent} events={eventOptions} placeholder="Select event…" clearable disabled={saving} />
    </label>
  )
  const itemField = (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-xs font-medium text-gray-500">Item</span>
      <SearchableSelect value={items} onChange={setItems} options={itemOptions} placeholder="Search item…" disabled={saving} />
    </label>
  )
  const quantityField = (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-xs font-medium text-gray-500">Quantity</span>
      <input
        type="number"
        min={1}
        value={unitBuy}
        onChange={(e) => setUnitBuy(e.target.value)}
        disabled={saving}
        className="w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
      />
    </label>
  )
  // Bound to the excess row's `receipt` column, which despite the name is
  // used as a free-text reference/note (e.g. "pre-dashboard stock") — not
  // always an actual receipt number, hence the placeholder.
  const receiptField = (
    <label className="flex flex-col gap-1 w-full min-w-0">
      <span className="text-xs font-medium text-gray-500">Receipt <span className="text-gray-400 font-normal">(optional)</span></span>
      <input
        type="text"
        value={receipt}
        onChange={(e) => setReceipt(e.target.value)}
        disabled={saving}
        placeholder="e.g. pre-dashboard stock"
        className="w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
      />
    </label>
  )

  if (inline) {
    // 2-col grid: Event | Quantity on the first row, Item | Receipt on the
    // second — so Event matches Item's width and Quantity matches Receipt's.
    return (
      <div className="grid grid-cols-2 gap-3">
        {eventField}
        {quantityField}
        {itemField}
        {receiptField}
        {trailing}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        {eventField}
        {quantityField}
      </div>
      {itemField}
      {receiptField}
      {trailing}
    </div>
  )
}

function AddInventoryCard({
  eventOptions,
  itemOptions,
  onClose,
  onCreated,
}: {
  eventOptions: string[]
  itemOptions: { value: string; label: string; meta?: string }[]
  onClose: () => void
  onCreated: (rows: ExcessRow[]) => void
}) {
  const [event, setEvent] = useState("")
  const [items, setItems] = useState("")
  const [unitBuy, setUnitBuy] = useState("")
  const [receipt, setReceipt] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const qtyNum = Math.round(Number(unitBuy)) || 0
  const valid = items.trim() !== "" && qtyNum >= 1

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/excess-purchase", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, items, unitBuy: qtyNum, receipt: receipt.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to add inventory")
      setItems("")
      setUnitBuy("")
      setReceipt("")
      onCreated(data.rows ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-t-2xl md:rounded-xl md:border md:border-cream-border bg-white p-5 pb-8 md:pb-5 flex flex-col gap-4">
      <div className="flex items-center justify-between -mx-5 px-5 border-b border-cream-border pb-3 md:mx-0 md:px-0 md:border-b-0 md:pb-0">
        <span className="text-base md:text-sm font-semibold text-foreground">Add Inventory</span>
      </div>

      <InventoryFields
        event={event} setEvent={setEvent}
        items={items} setItems={setItems}
        unitBuy={unitBuy} setUnitBuy={setUnitBuy}
        receipt={receipt} setReceipt={setReceipt}
        eventOptions={eventOptions} itemOptions={itemOptions} saving={saving}
        inline
      />

      <p className="text-[11px] text-gray-400">
        Apply fills this row&apos;s own event first, then spills to matching orders
        in other events — so Event just sets fill priority.
      </p>

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
          Cancel
        </button>
        <button type="submit" disabled={saving || !valid} className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors">
          {saving ? "Saving…" : "Add"}
        </button>
      </div>
    </form>
  )
}

function EditInventoryModal({
  existing,
  eventOptions,
  itemOptions,
  onClose,
  onUpdated,
  onRequestDelete,
}: {
  existing: ExcessRow
  eventOptions: string[]
  itemOptions: { value: string; label: string; meta?: string }[]
  onClose: () => void
  onUpdated: (rowNumber: number, patch: { event: string; items: string; unitBuy: number; receipt: string }) => void
  onRequestDelete: () => void
}) {
  const [event, setEvent] = useState(existing.event)
  const [items, setItems] = useState(existing.items)
  const [unitBuy, setUnitBuy] = useState(String(existing.unitBuy))
  const [receipt, setReceipt] = useState(existing.receipt)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const qtyNum = Math.round(Number(unitBuy)) || 0
  const valid = items.trim() !== "" && qtyNum >= 1

  async function handleSubmit() {
    if (!valid) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/sheets/excess-purchase/${existing.rowNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, items, unitBuy: qtyNum, receipt: receipt.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to update")
      onUpdated(existing.rowNumber, { event, items, unitBuy: qtyNum, receipt: receipt.trim() })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 md:items-center" onClick={onClose}>
      <div
        className="bg-white rounded-t-2xl md:border md:border-cream-border md:shadow-xl w-full max-h-[90vh] overflow-y-auto flex flex-col gap-4 p-6 pb-8 md:pb-6 md:max-w-sm md:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 -mx-6 px-6 border-b border-cream-border pb-3 md:mx-0 md:px-0 md:border-b-0 md:pb-0">
          <div className="text-base md:text-sm font-semibold text-foreground">Edit Inventory</div>
          <button type="button" onClick={onClose} className="hidden md:block text-gray-400 hover:text-brand transition-colors shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <InventoryFields
          event={event} setEvent={setEvent}
          items={items} setItems={setItems}
          unitBuy={unitBuy} setUnitBuy={setUnitBuy}
          receipt={receipt} setReceipt={setReceipt}
          eventOptions={eventOptions} itemOptions={itemOptions} saving={saving}
        />

        <p className="text-[11px] text-gray-400">
          Apply fills this row&apos;s own event first, then spills to matching orders
          in other events — so Event just sets fill priority.
        </p>

        {error && <p className="text-xs text-red-500">{error}</p>}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRequestDelete}
            disabled={saving}
            aria-label="Delete"
            className="inline-flex items-center justify-center h-[38px] border border-cream-border rounded-lg px-3 text-sm text-gray-400 hover:border-brand disabled:opacity-50 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" />
            </svg>
          </button>
          <button type="button" onClick={onClose} disabled={saving} className="ml-auto px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
            Cancel
          </button>
          <button type="button" onClick={handleSubmit} disabled={saving || !valid} className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Delete confirmation
// ---------------------------------------------------------------------------

function DeleteConfirmModal({
  row,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  row: ExcessRow
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onCancel}>
      <div
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-sm flex flex-col gap-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-foreground">Delete Inventory Row</div>
        <p className="text-sm text-gray-600">
          Remove <span className="font-medium">{row.items}</span> ({row.unitBuy} unit{row.unitBuy === 1 ? "" : "s"}) from {row.event}? This cannot be undone.
        </p>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
            Keep
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className="px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-medium hover:bg-red-600 disabled:opacity-50 transition-colors">
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Result banner
// ---------------------------------------------------------------------------

function ApplyResultBanner({
  result,
  onDismiss,
}: {
  result: ApplyResult
  onDismiss: () => void
}) {
  const { filled, remainder } = result
  const noOrders = filled.length === 0

  return (
    <div className={`rounded-xl border overflow-hidden ${noOrders ? "border-gray-200 bg-gray-50" : "border-green-200 bg-green-50"}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-inherit">
        <span className={`text-xs font-medium ${noOrders ? "text-gray-500" : "text-green-700"}`}>
          {noOrders
            ? "No pending orders found for this item."
            : `${filled.length} order${filled.length === 1 ? "" : "s"} filled`}
        </span>
        <div className="flex items-center gap-3">
          {remainder > 0 && (
            <span className="text-xs text-yellow-700 bg-yellow-100 border border-yellow-200 rounded-md px-2 py-0.5">
              {remainder} remaining in excess
            </span>
          )}
          <button
            type="button"
            onClick={onDismiss}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="Dismiss"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Filled rows */}
      {filled.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[420px]">
            <thead>
              <tr className="border-b border-inherit text-left">
                <th className="px-4 py-2 font-medium text-gray-500 w-8">#</th>
                <th className="px-4 py-2 font-medium text-gray-500">Event</th>
                <th className="px-4 py-2 font-medium text-gray-500">Customer</th>
                <th className="px-4 py-2 font-medium text-gray-500 text-right">Unit Buy</th>
                <th className="px-4 py-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {filled.map((row, i) => (
                <tr key={row.rowNumber} className="border-b border-inherit last:border-0">
                  <td className="px-4 py-2 text-gray-400">{i + 1}</td>
                  <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{row.event}</td>
                  <td className="px-4 py-2 text-foreground">{displayIg(row.customer)}</td>
                  <td className="px-4 py-2 text-foreground text-right font-semibold tabular-nums">{row.unitBuy}</td>
                  <td className="px-4 py-2 text-right text-gray-400">
                    {row.oldUnitBuy > 0 && `(was ${row.oldUnitBuy})`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bulk result banner
// ---------------------------------------------------------------------------

