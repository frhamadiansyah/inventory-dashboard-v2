"use client"

import { displayIg } from "@/lib/format"
import TableSkeleton from "@/components/TableSkeleton"
import { useCallback, useMemo, useRef, useState } from "react"
import type { FormRow } from "@/lib/db"
import type { Role } from "@/lib/roles"
import { usePaginatedFetch, type PageData } from "@/hooks/usePaginatedFetch"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import DataGrid, {
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type PaginationState,
} from "@/components/DataGrid"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 30

function fmtNum(v: number | null): string {
  if (v == null) return "—"
  return v.toLocaleString("id-ID")
}

// ---------------------------------------------------------------------------
// Inline receipt cell (owner-only)
// ---------------------------------------------------------------------------

function InlineReceipt({ row, onSave }: { row: FormRow; onSave: (row: FormRow, value: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(row.receipt)
  const inputRef = useRef<HTMLInputElement>(null)

  function startEdit() {
    setDraft(row.receipt)
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  function commit() {
    setEditing(false)
    if (draft !== row.receipt) onSave(row, draft)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.currentTarget.blur() }
          if (e.key === "Escape") { setDraft(row.receipt); setEditing(false) }
        }}
        className="w-full border border-brand rounded px-1.5 py-0.5 text-xs bg-white focus:outline-none"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={startEdit}
      title="Click to edit"
      className="text-left w-full text-xs hover:text-brand transition-colors"
    >
      {row.receipt || <span className="text-gray-300">—</span>}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function FormRecordsTable({ role }: { role: Role | null }) {
  const isOwner = role === "owner"
  const options = useSheetOptions()

  // -- Server-side state --
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState("")
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE })

  // -- Data --
  const [rows, setRows] = useState<FormRow[]>([])
  const [totalCount, setTotalCount] = useState(0)

  // -- Convert TanStack state → usePaginatedFetch params --
  const fetchFilters = useMemo(() => {
    const f = { event: "", customer: "", items: "", dateFrom: "", dateTo: "" }
    for (const cf of columnFilters) {
      // Date column carries a {from,to} range object, not a plain string.
      if (cf.id === "createdAt") {
        const { from, to } = (cf.value as { from?: string; to?: string } | undefined) ?? {}
        f.dateFrom = from ?? ""
        f.dateTo = to ?? ""
        continue
      }
      if (cf.id in f) f[cf.id as keyof typeof f] = String(cf.value ?? "")
    }
    return f
  }, [columnFilters])

  const fetchSort = useMemo(() => {
    if (sorting.length === 0) return null
    return { key: sorting[0].id, direction: sorting[0].desc ? "desc" as const : "asc" as const }
  }, [sorting])

  const onData = useCallback((data: PageData) => {
    setRows(data.rows as FormRow[])
    setTotalCount(data.totalCount)
  }, [])

  const { fetchState, refresh } = usePaginatedFetch({
    endpoint: "/api/sheets/duplicate-form",
    pageSize: PAGE_SIZE,
    page: pagination.pageIndex + 1,
    search: globalFilter,
    filters: fetchFilters,
    sort: fetchSort,
    onData,
  })

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  // -- Reset page on filter/sort change --
  const handleSortingChange = useCallback((updater: SortingState | ((prev: SortingState) => SortingState)) => {
    setSorting(updater)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])

  const handleColumnFiltersChange = useCallback((updater: ColumnFiltersState | ((prev: ColumnFiltersState) => ColumnFiltersState)) => {
    setColumnFilters(updater)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])

  const handleGlobalFilterChange = useCallback((updater: string | ((prev: string) => string)) => {
    setGlobalFilter(updater)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])

  const handleSaveReceipt = useCallback(async (row: FormRow, value: string) => {
    const previous = row.receipt
    setRows((prev) => prev.map((r) => r.rowNumber === row.rowNumber ? { ...r, receipt: value } : r))
    try {
      const res = await fetch(`/api/sheets/duplicate-form/${row.rowNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: "receipt_cell", value }),
      })
      if (!res.ok) throw new Error("Failed")
    } catch {
      setRows((prev) => prev.map((r) => r.rowNumber === row.rowNumber ? { ...r, receipt: previous } : r))
    }
  }, [])

  // -- Column definitions --
  const columns: ColumnDef<FormRow, unknown>[] = useMemo(() => [
    {
      accessorKey: "event",
      header: "Event",
      size: 130,
      filterFn: "textContains",
    },
    {
      accessorKey: "customer",
      header: "Customer",
      size: 150,
      filterFn: "textContains",
      cell: ({ getValue }) => <span>{displayIg(getValue<string>())}</span>,
    },
    {
      accessorKey: "items",
      header: "Item",
      size: 180,
      filterFn: "textContains",
      enableHiding: false,
    },
    {
      accessorKey: "unit",
      header: "Qty",
      enableColumnFilter: false,
      size: 80,
      meta: { align: "right" },
    },
    {
      accessorKey: "unitBuy",
      header: "Unit Buy",
      enableColumnFilter: false,
      size: 80,
      meta: { align: "right" },
      cell: ({ getValue }) => {
        const v = fmtNum(getValue<number | null>())
        return <span className={v === "—" ? "text-gray-400" : "font-medium tabular-nums"}>{v}</span>
      },
    },
    {
      accessorKey: "receipt",
      header: "Receipt",
      size: 140,
      enableColumnFilter: false,
      cell: ({ row }) => isOwner
        ? <InlineReceipt row={row.original} onSave={handleSaveReceipt} />
        : <span className={row.original.receipt ? "" : "text-gray-400"}>{row.original.receipt || "—"}</span>,
    },
    {
      accessorKey: "unitArrive",
      header: "Arrive",
      enableColumnFilter: false,
      size: 80,
      meta: { align: "right" },
      cell: ({ getValue }) => {
        const v = fmtNum(getValue<number | null>())
        return <span className={v === "—" ? "text-gray-400" : "font-medium tabular-nums"}>{v}</span>
      },
    },
    {
      accessorKey: "unitShip",
      header: "Ship",
      enableColumnFilter: false,
      size: 80,
      meta: { align: "right" },
      cell: ({ getValue }) => {
        const v = fmtNum(getValue<number | null>())
        return <span className={v === "—" ? "text-gray-400" : "font-medium tabular-nums"}>{v}</span>
      },
    },
    {
      accessorKey: "unitHold",
      header: "Hold",
      enableColumnFilter: false,
      size: 80,
      meta: { align: "right" },
      cell: ({ getValue }) => {
        const v = fmtNum(getValue<number | null>())
        return <span className={v === "—" ? "text-gray-400" : "font-medium tabular-nums"}>{v}</span>
      },
    },
    {
      accessorKey: "note",
      header: "Note",
      size: 160,
      enableColumnFilter: false,
      cell: ({ getValue }) => <span className="text-gray-500 text-xs">{getValue<string>() || "—"}</span>,
    },
    {
      accessorKey: "createdAt",
      header: "Created At",
      size: 110,
      filterFn: "dateRange",
      cell: ({ getValue }) => <span className="text-gray-400 text-xs whitespace-nowrap">{getValue<string>() || "—"}</span>,
    },
    {
      accessorKey: "updatedAt",
      header: "Updated At",
      size: 110,
      enableColumnFilter: false,
      cell: ({ getValue }) => <span className="text-gray-400 text-xs whitespace-nowrap">{getValue<string>() || "—"}</span>,
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [isOwner, handleSaveReceipt])

  const renderMobileCard = useCallback((row: FormRow) => (
    <div className="rounded-xl border border-cream-border bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-foreground truncate">{displayIg(row.customer)}</span>
        <span className="text-xs text-gray-400 shrink-0">{row.event}</span>
      </div>
      <div className="text-xs text-gray-600 truncate">{row.items}</div>
      <div className="flex items-center justify-between gap-3 text-xs text-gray-500 tabular-nums">
        <span>Qty <span className="font-medium text-foreground">{row.unit}</span></span>
        <span>Buy <span className="font-medium text-foreground">{fmtNum(row.unitBuy)}</span></span>
        <span>Arrive <span className="font-medium text-foreground">{fmtNum(row.unitArrive)}</span></span>
        <span>Ship <span className="font-medium text-foreground">{fmtNum(row.unitShip)}</span></span>
      </div>
      {isOwner ? (
        <div className="pt-2.5 border-t border-cream-border mt-1">
          <InlineReceipt row={row} onSave={handleSaveReceipt} />
        </div>
      ) : row.receipt ? (
        <div className="text-xs text-gray-500 pt-2.5 border-t border-cream-border mt-1">{row.receipt}</div>
      ) : null}
    </div>
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [isOwner, handleSaveReceipt])

  // -- Loading / error states --
  if (fetchState.loading && rows.length === 0) return <TableSkeleton />

  if (fetchState.error) {
    return (
      <div className="rounded-xl border border-cream-border bg-white p-10 text-center text-sm text-red-500">
        {fetchState.error}
      </div>
    )
  }

  return (
    <DataGrid
      data={rows}
      columns={columns}
      getRowId={(row) => String(row.rowNumber)}
      searchPlaceholder="Search…"
      fullWidthSearch
      tightToolbar
      boldUppercaseHeader
      hideRowCount
      renderMobileCard={renderMobileCard}
      initialVisibility={{
        receipt: false,
        unitArrive: false,
        unitShip: false,
        unitHold: false,
        note: false,
        updatedAt: false,
      }}
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
  )
}
