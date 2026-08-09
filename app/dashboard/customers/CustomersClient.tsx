"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { CustomerRow, WarehouseRow } from "@/lib/db"
import DataGrid, {
  numericFilter,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type PaginationState,
} from "@/components/DataGrid"
import { usePaginatedFetch, type PageData } from "@/hooks/usePaginatedFetch"
import { fmt, displayIg } from "@/lib/format"
import { CustomerDetailDrawer } from "./CustomerDetailDrawer"

const PAGE_SIZE = 25

// Build a wa.me link from a stored WhatsApp number. Indonesian numbers are
// normalized to international (0… → 62…, 8… → 62…). Returns null when empty.
function waHref(phone: string | null | undefined): string | null {
  let num = (phone ?? "").replace(/[^\d]/g, "")
  if (!num) return null
  if (num.startsWith("0")) num = "62" + num.slice(1)
  else if (num.startsWith("8")) num = "62" + num
  return `https://wa.me/${num}`
}

const modalInputCls = "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors disabled:opacity-50"

type DraftCustomer = {
  instagramId: string
  name: string
  whatsapp: string
  dataDiri: string
  ekspedisi: string
  // Per-warehouse ongkir, keyed by warehouse id (string for the number input).
  ongkir: Record<number, string>
  bankName: string
  bankAccountNumber: string
  bankAccountHolder: string
}

const EMPTY_DRAFT: DraftCustomer = {
  instagramId: "",
  name: "",
  whatsapp: "",
  dataDiri: "",
  ekspedisi: "",
  ongkir: {},
  bankName: "",
  bankAccountNumber: "",
  bankAccountHolder: "",
}

function rowToDraft(row: CustomerRow): DraftCustomer {
  const ongkir: Record<number, string> = {}
  for (const [wid, val] of Object.entries(row.ongkir ?? {})) {
    ongkir[Number(wid)] = val ? String(val) : ""
  }
  return {
    instagramId: row.instagramId,
    name: row.name,
    whatsapp: row.whatsapp,
    dataDiri: row.dataDiri,
    ekspedisi: row.ekspedisi,
    ongkir,
    bankName: row.bankName,
    bankAccountNumber: row.bankAccountNumber,
    bankAccountHolder: row.bankAccountHolder,
  }
}

export default function CustomersClient() {
  // Current page of rows + total — both come from the server now.
  const [data, setData] = useState<CustomerRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  // Warehouses drive the dynamic ongkir columns and the modal's per-warehouse
  // inputs; they can't be derived from one page of customers, so load once.
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([])
  const [metaError, setMetaError] = useState<string | null>(null)

  const [creating, setCreating] = useState(false)
  const [editRow, setEditRow] = useState<CustomerRow | null>(null)
  const [detailCustomer, setDetailCustomer] = useState<string | null>(null)

  // Server-side table state.
  const [sorting, setSorting] = useState<SortingState>([{ id: "instagramId", desc: false }])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState("")
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE })

  // Mobile-only balance-status filter, sent to the server (customer_invoice_summary).
  const [balanceFilter, setBalanceFilter] = useState<"" | "outstanding" | "overpayment" | "settled">("")
  const [balanceFilterOpen, setBalanceFilterOpen] = useState(false)
  const balanceFilterRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!balanceFilterOpen) return
    const h = (e: MouseEvent) => { if (!balanceFilterRef.current?.contains(e.target as Node)) setBalanceFilterOpen(false) }
    document.addEventListener("mousedown", h)
    return () => document.removeEventListener("mousedown", h)
  }, [balanceFilterOpen])

  const loadMeta = useCallback(async () => {
    try {
      const res = await fetch("/api/sheets/warehouses")
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to load warehouses")
      setWarehouses(json.rows as WarehouseRow[])
    } catch (err) {
      setMetaError(err instanceof Error ? err.message : "Failed to load")
    }
  }, [])
  useEffect(() => { loadMeta() }, [loadMeta])

  // Text column filters → server query params. The date column isn't
  // server-filterable. Ongkir columns are numeric ({op, value}, not a plain
  // string) and the server can only join one warehouse's ongkir per query, so
  // only the first active ongkir filter is sent — later ones are ignored.
  const fetchFilters = useMemo<Record<string, string>>(() => {
    const f: Record<string, string> = {}
    for (const cf of columnFilters) {
      const ongkirMatch = cf.id.match(/^ongkir_(\d+)$/)
      if (ongkirMatch) {
        if (f.ongkirWarehouseId) continue
        const { op, value } = (cf.value ?? {}) as { op?: string; value?: number }
        if (!op || value == null || Number.isNaN(value)) continue
        f.ongkirWarehouseId = ongkirMatch[1]
        f.ongkirOp = op
        f.ongkirValue = String(value)
        continue
      }
      const v = String(cf.value ?? "").trim()
      if (!v) continue
      if (cf.id === "instagramId") f.instagramId = v
      else if (cf.id === "name") f.name = v
      else if (cf.id === "whatsapp") f.whatsapp = v
      else if (cf.id === "ekspedisi") f.ekspedisi = v
      else if (cf.id === "dataDiri") f.dataDiri = v
      else if (cf.id === "bankName") f.bankName = v
    }
    if (balanceFilter) f.balanceStatus = balanceFilter
    return f
  }, [columnFilters, balanceFilter])

  const fetchSort = useMemo(() => {
    if (sorting.length === 0) return null
    return { key: sorting[0].id, direction: sorting[0].desc ? ("desc" as const) : ("asc" as const) }
  }, [sorting])

  const onData = useCallback((d: PageData) => {
    setData(d.rows as CustomerRow[])
    setTotalCount(d.totalCount)
  }, [])

  const { fetchState, refresh } = usePaginatedFetch({
    endpoint: "/api/sheets/customers",
    pageSize: PAGE_SIZE,
    page: pagination.pageIndex + 1,
    search: globalFilter,
    filters: fetchFilters,
    sort: fetchSort,
    onData,
  })

  // Stable ref so row-action callbacks captured in column defs always call the
  // latest refresh.
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  // Reset to page 1 whenever the query shape (sort / filter / search) changes.
  const handleSortingChange = useCallback((u: SortingState | ((p: SortingState) => SortingState)) => {
    setSorting(u)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])
  const handleColumnFiltersChange = useCallback((u: ColumnFiltersState | ((p: ColumnFiltersState) => ColumnFiltersState)) => {
    setColumnFilters(u)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])
  const handleGlobalFilterChange = useCallback((u: string | ((p: string) => string)) => {
    setGlobalFilter(u)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])

  async function handleDelete(row: CustomerRow) {
    if (!confirm(`Delete "${displayIg(row.instagramId)}"? This cannot be undone.`)) return
    try {
      const res = await fetch(`/api/sheets/customers/${row.id}`, { method: "DELETE" })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      refreshRef.current()
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  const columns = useMemo<ColumnDef<CustomerRow, unknown>[]>(() => [
    {
      accessorKey: "instagramId",
      header: "Instagram ID",
      size: 160,
      filterFn: "textContains",
      cell: ({ row }) => {
        const hasAddress = Boolean(row.original.dataDiri && row.original.dataDiri.trim())
        return (
          <span className="inline-flex items-center gap-1.5">
            <span className="font-medium tabular-nums">{displayIg(row.original.instagramId)}</span>
            {!hasAddress && (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-500 shrink-0" aria-label="No address filled">
                <title>No address filled</title>
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            )}
          </span>
        )
      },
    },
    {
      accessorKey: "name",
      header: "Name",
      size: 160,
      filterFn: "textContains",
      cell: ({ getValue }) => {
        const v = getValue<string>()
        return <span className={v ? "text-foreground" : "text-gray-400"}>{v || "—"}</span>
      },
    },
    {
      accessorKey: "whatsapp",
      header: "WhatsApp",
      size: 140,
      filterFn: "textContains",
      cell: ({ getValue }) => {
        const v = getValue<string>()
        return <span className={v ? "text-gray-600 tabular-nums" : "text-gray-400"}>{v || "—"}</span>
      },
    },
    {
      accessorKey: "ekspedisi",
      header: "Ekspedisi",
      size: 120,
      filterFn: "textContains",
      cell: ({ getValue }) => {
        const v = getValue<string>()
        return <span className={v ? "text-gray-600" : "text-gray-400"}>{v || "—"}</span>
      },
    },
    // One ongkir column per warehouse (origin). Header shows the warehouse code.
    // Server-sortable via a join scoped to that one warehouse (see
    // getCustomersPaginated). Column filter UI is hidden (sort only) — the
    // numeric filterFn/fetchFilters plumbing stays wired server-side in case
    // it's re-enabled later.
    ...warehouses.map((wh): ColumnDef<CustomerRow, unknown> => ({
      id: `ongkir_${wh.id}`,
      accessorFn: (row) => row.ongkir?.[wh.id] ?? 0,
      header: `Ongkir ${wh.code}`,
      size: 120,
      enableColumnFilter: false,
      meta: { align: "right" },
      cell: ({ getValue }) => {
        const v = getValue<number>()
        return v > 0
          ? <span className="tabular-nums">Rp {fmt(v)}</span>
          : <span className="text-gray-400">—</span>
      },
    })),
    {
      accessorKey: "dataDiri",
      header: "Alamat",
      // No explicit size — DataGrid leaves size-150 (tanstack default) columns
      // unset in the header style, so this one column flexes to absorb any
      // leftover table width instead of it landing on the actions column.
      filterFn: "textContains",
      cell: ({ getValue }) => {
        const v = getValue<string>()
        if (!v) return <span className="text-gray-400">—</span>
        return (
          <span className="text-gray-500 text-xs whitespace-pre-line line-clamp-2" title={v}>
            {v}
          </span>
        )
      },
    },
    {
      accessorKey: "bankName",
      header: "Bank",
      size: 180,
      filterFn: "textContains",
      cell: ({ row }) => {
        const { bankName, bankAccountNumber, bankAccountHolder } = row.original
        if (!bankName && !bankAccountNumber && !bankAccountHolder) {
          return <span className="text-gray-400">—</span>
        }
        return (
          <div className="text-xs leading-tight">
            <div className="font-medium text-gray-700">{bankName || "—"}</div>
            {bankAccountNumber && <div className="text-gray-500 tabular-nums">{bankAccountNumber}</div>}
            {bankAccountHolder && <div className="text-gray-400">{bankAccountHolder}</div>}
          </div>
        )
      },
    },
    {
      accessorKey: "updatedAt",
      header: "Updated",
      size: 110,
      enableColumnFilter: false,
      cell: ({ getValue }) => {
        const v = getValue<string | null>()
        return v ? (
          <span className="text-gray-400 text-xs whitespace-nowrap">{new Date(v).toLocaleDateString("id-ID")}</span>
        ) : ""
      },
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableColumnFilter: false,
      enableHiding: false,
      size: 100,
      cell: ({ row }) => (
        <div className="flex gap-2">
          {waHref(row.original.whatsapp) && (
            <a
              href={waHref(row.original.whatsapp)!}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title="Chat on WhatsApp"
              className="inline-flex items-center text-gray-400 hover:text-green-600 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
            </a>
          )}
          <button
            type="button"
            onClick={() => setEditRow(row.original)}
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
            onClick={() => handleDelete(row.original)}
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
  ], [warehouses])

  const renderMobileCard = useCallback((row: CustomerRow) => {
    const hasAddress = Boolean(row.dataDiri && row.dataDiri.trim())
    // Invoice roll-up now comes straight off the row (customer_invoice_summary).
    const agg = { count: row.invoiceCount, invoiced: row.totalInvoiced, balance: row.totalOutstanding }
    return (
      <div className="rounded-xl border border-cream-border bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {/* Invoice-count circle (like the expenses selection badge). Tinted
                by balance: green settled, red outstanding, blue overpayment;
                neutral when the customer has no invoices. */}
            <span
              className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold tabular-nums ${
                !agg || agg.count === 0
                  ? "bg-cream text-gray-400"
                  : (agg.balance ?? 0) > 0
                    ? "bg-red-100 text-red-600"
                    : (agg.balance ?? 0) < 0
                      ? "bg-blue-100 text-blue-700"
                      : "bg-green-100 text-green-700"
              }`}
              aria-label={`${agg?.count ?? 0} invoice${(agg?.count ?? 0) === 1 ? "" : "s"}`}
              title={`${agg?.count ?? 0} invoice${(agg?.count ?? 0) === 1 ? "" : "s"}`}
            >
              {agg?.count ?? 0}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-semibold text-foreground tabular-nums truncate">{displayIg(row.instagramId)}</span>
                {!hasAddress && (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-500 shrink-0" aria-label="No address filled">
                    <title>No address filled</title>
                    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                )}
              </div>
              <div className="text-xs text-gray-500 mt-0.5 truncate uppercase">{row.whatsapp || "—"}{row.name ? ` · ${row.name}` : ""}</div>
            </div>
          </div>
          {/* Chat + kebab. The kebab (not the row itself) opens the action sheet
              — tapping the row already opens the customer detail drawer. */}
          <div className="shrink-0 flex items-center -space-x-2.5">
            {waHref(row.whatsapp) && (
              <a
                href={waHref(row.whatsapp)!}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                aria-label="Chat on WhatsApp"
                className="inline-flex items-center justify-center p-1.5 text-gray-400 hover:text-green-600 transition-colors"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                </svg>
              </a>
            )}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setEditRow(row) }}
              aria-label="More actions"
              className="p-1.5 text-gray-400 hover:text-brand transition-colors"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
              </svg>
            </button>
          </div>
        </div>
        {/* Bottom row: outstanding balance (left) + total invoiced (right),
            separated like the expenses card's amount row. */}
        {agg && agg.count > 0 && (
          <div className="flex items-center justify-between gap-3 mt-2.5 pt-2.5 border-t border-cream-border">
            <span className="text-xs text-gray-400 tabular-nums whitespace-nowrap">
              {(agg.balance ?? 0) > 0 ? `OUTSTANDING Rp ${fmt(agg.balance)}` : (agg.balance ?? 0) < 0 ? `OVERPAYMENT Rp ${fmt(Math.abs(agg.balance))}` : "SETTLED"}
            </span>
            <span className="text-sm font-semibold tabular-nums text-foreground whitespace-nowrap">Rp {fmt(agg.invoiced ?? 0)}</span>
          </div>
        )}
      </div>
    )
  }, [])

  const BALANCE_OPTIONS: { key: typeof balanceFilter; label: string }[] = [
    { key: "", label: "All" },
    { key: "outstanding", label: "Outstanding" },
    { key: "overpayment", label: "Overpayment" },
    { key: "settled", label: "Settled" },
  ]

  // Current total-invoiced sort direction (drives the sort icon), read off the
  // server sorting state. Clicking cycles desc → asc → default (handle asc).
  const invSort: null | "desc" | "asc" =
    sorting[0]?.id === "totalInvoiced" ? (sorting[0].desc ? "desc" : "asc") : null
  const cycleInvSort = () => {
    handleSortingChange(
      invSort === null
        ? [{ id: "totalInvoiced", desc: true }]
        : invSort === "desc"
          ? [{ id: "totalInvoiced", desc: false }]
          : [{ id: "instagramId", desc: false }],
    )
  }
  const handleBalanceFilterChange = (key: typeof balanceFilter) => {
    setBalanceFilter(key)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }

  const toolbarExtra = (
    <>
      {/* Mobile: sort by total invoiced + filter by balance status (server-side). */}
      <button
        type="button"
        onClick={cycleInvSort}
        aria-label="Sort by total invoiced"
        title={invSort === "desc" ? "Invoiced: high → low" : invSort === "asc" ? "Invoiced: low → high" : "Sort by total invoiced"}
        className="md:hidden shrink-0 relative border border-cream-border rounded-lg h-[38px] px-3 text-sm text-gray-600 bg-white flex items-center gap-1.5 hover:border-brand transition-colors"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m3 16 4 4 4-4" /><path d="M7 20V4" /><path d="m21 8-4-4-4 4" /><path d="M17 4v16" />
        </svg>
        {invSort && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-brand" />}
      </button>
      <div className="relative md:hidden shrink-0" ref={balanceFilterRef}>
        <button
          type="button"
          onClick={() => setBalanceFilterOpen((o) => !o)}
          aria-label="Filter by balance status"
          className="relative border border-cream-border rounded-lg h-[38px] px-3 text-sm text-gray-600 bg-white flex items-center gap-1.5 hover:border-brand transition-colors"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 3H2l8 9.46V19l4 2v-8.54z" />
          </svg>
          {balanceFilter && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-brand" />}
        </button>
        {balanceFilterOpen && (
          <div className="absolute right-0 top-full mt-1 z-30 w-44 rounded-lg border border-cream-border bg-white shadow-lg p-1.5 flex flex-col">
            {BALANCE_OPTIONS.map(({ key, label }) => (
              <button
                key={key || "all"}
                type="button"
                onClick={() => { handleBalanceFilterChange(key); setBalanceFilterOpen(false) }}
                className={`text-left px-2.5 py-1.5 rounded-md text-sm transition-colors ${
                  balanceFilter === key ? "bg-brand-light text-brand font-medium" : "text-gray-600 hover:bg-cream"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => setCreating(true)}
        className="hidden md:inline-flex items-center h-[38px] px-3 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 transition-colors"
      >
        + Add Customer
      </button>
    </>
  )

  const errorMsg = fetchState.error || metaError

  return (
    <div className="flex flex-col gap-6">
      {errorMsg && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{errorMsg}</div>
      )}

      <DataGrid
        data={data}
        columns={columns}
        getRowId={(row) => String(row.id)}
        searchPlaceholder="Search customers…"
        fullWidthSearch
        tightToolbar
        boldUppercaseHeader
        toolbarExtraAfterColumns
        hideRowCount
        toolbarExtra={toolbarExtra}
        initialVisibility={{ updatedAt: false, dataDiri: false, bankName: false, whatsapp: false }}
        renderMobileCard={renderMobileCard}
        onRowClick={(row) => setDetailCustomer(row.instagramId)}
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

      {/* Mobile add FAB */}
      <button
        type="button"
        onClick={() => setCreating(true)}
        aria-label="Add customer"
        className="md:hidden fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 w-14 h-14 rounded-full bg-brand text-white text-3xl leading-none shadow-lg flex items-center justify-center active:bg-brand/90"
      >
        +
      </button>

      {creating && (
        <CreateCustomerModal
          warehouses={warehouses}
          onSaved={() => { setCreating(false); refreshRef.current() }}
          onCancel={() => setCreating(false)}
        />
      )}

      {editRow && (
        <EditCustomerModal
          rowId={editRow.id}
          warehouses={warehouses}
          initial={rowToDraft(editRow)}
          onSaved={() => { setEditRow(null); refreshRef.current() }}
          onCancel={() => setEditRow(null)}
          onDelete={() => { const r = editRow; setEditRow(null); handleDelete(r) }}
        />
      )}

      {detailCustomer && (
        <CustomerDetailDrawer customer={detailCustomer} onClose={() => setDetailCustomer(null)} />
      )}

    </div>
  )
}

// ─── Add / Edit form ──────────────────────────────────────────────────────

// Shared field set for the Add card and the Edit modal below.
function CustomerFields({
  draft, setDraft, warehouses, saving, firstInputRef,
}: {
  draft: DraftCustomer
  setDraft: React.Dispatch<React.SetStateAction<DraftCustomer>>
  warehouses: WarehouseRow[]
  saving: boolean
  firstInputRef?: React.RefObject<HTMLInputElement | null>
}) {
  // Only the plain string fields go through this helper; ongkir is a map and is
  // handled with its own per-warehouse inputs below.
  function field(key: Exclude<keyof DraftCustomer, "ongkir">) {
    return {
      value: draft[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setDraft((d) => ({ ...d, [key]: e.target.value })),
      disabled: saving,
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-500">Instagram ID <span className="text-red-500">*</span></span>
        <input
          ref={firstInputRef}
          {...field("instagramId")}
          placeholder="@username"
          className={modalInputCls}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-500">Name</span>
        <input
          {...field("name")}
          placeholder="Full name"
          className={modalInputCls}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-500">WhatsApp</span>
        <input
          {...field("whatsapp")}
          placeholder="08xx-xxxx-xxxx"
          className={modalInputCls}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-500">Alamat / Data Diri</span>
        <textarea
          {...field("dataDiri")}
          placeholder="Full name, address, phone…"
          rows={4}
          className={`${modalInputCls} resize-none`}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-500">Ekspedisi</span>
        <input
          {...field("ekspedisi")}
          placeholder="e.g. JNE, J&T"
          className={modalInputCls}
        />
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-500">Ongkos kirim per kg</span>
        {warehouses.length === 0 ? (
          <span className="text-xs text-gray-400">No warehouses configured.</span>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {warehouses.map((wh) => (
              <label key={wh.id} className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-gray-400">{wh.name} ({wh.code})</span>
                <input
                  value={draft.ongkir[wh.id] ?? ""}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, ongkir: { ...d.ongkir, [wh.id]: e.target.value } }))
                  }
                  disabled={saving}
                  type="number"
                  min="0"
                  placeholder="0"
                  className={modalInputCls}
                />
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="pt-2 border-t border-cream-border" />

      <div className="text-xs font-semibold text-gray-500 -mb-1">Bank Info</div>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-500">Bank Name</span>
        <input
          {...field("bankName")}
          placeholder="e.g. BCA, Mandiri"
          className={modalInputCls}
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-500">Account Number</span>
          <input
            {...field("bankAccountNumber")}
            placeholder="1234567890"
            className={modalInputCls}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-500">Account Holder</span>
          <input
            {...field("bankAccountHolder")}
            placeholder="Name as registered"
            className={modalInputCls}
          />
        </label>
      </div>
    </div>
  )
}

function buildCustomerPayload(draft: DraftCustomer, warehouses: WarehouseRow[]) {
  // Build the per-warehouse ongkir map (numbers) from the form's string inputs.
  const ongkir: Record<number, number> = {}
  for (const wh of warehouses) {
    ongkir[wh.id] = Number(draft.ongkir[wh.id]) || 0
  }
  return {
    instagramId: draft.instagramId.trim(),
    name: draft.name.trim(),
    whatsapp: draft.whatsapp.trim(),
    dataDiri: draft.dataDiri.trim(),
    ekspedisi: draft.ekspedisi.trim(),
    ongkir,
    bankName: draft.bankName.trim(),
    bankAccountNumber: draft.bankAccountNumber.trim(),
    bankAccountHolder: draft.bankAccountHolder.trim(),
  }
}

function CreateCustomerModal({
  warehouses,
  onSaved,
  onCancel,
}: {
  warehouses: WarehouseRow[]
  onSaved: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<DraftCustomer>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const firstInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { firstInputRef.current?.focus() }, [])

  async function handleSave() {
    if (!draft.instagramId.trim()) {
      setSaveError("Instagram ID is required")
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch("/api/sheets/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildCustomerPayload(draft, warehouses)),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      onSaved()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") onCancel()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onCancel}>
      <div
        className="bg-white rounded-xl border border-cream-border shadow-xl p-6 w-full max-w-lg flex flex-col gap-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">Add Customer</span>
        </div>

        <CustomerFields draft={draft} setDraft={setDraft} warehouses={warehouses} saving={saving} firstInputRef={firstInputRef} />

        {saveError && <p className="text-xs text-red-500">{saveError}</p>}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  )
}

function EditCustomerModal({
  rowId,
  warehouses,
  initial,
  onSaved,
  onCancel,
  onDelete,
}: {
  rowId: number
  warehouses: WarehouseRow[]
  initial: DraftCustomer
  onSaved: () => void
  onCancel: () => void
  onDelete: () => void
}) {
  const [draft, setDraft] = useState<DraftCustomer>(initial)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  async function handleSave() {
    if (!draft.instagramId.trim()) {
      setSaveError("Instagram ID is required")
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch(`/api/sheets/customers/${rowId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildCustomerPayload(draft, warehouses)),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")

      // The list re-fetches the current page from the server (onSaved → refresh),
      // so we don't reconstruct the row optimistically here.
      onSaved()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") onCancel()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onCancel}>
      <div
        className="bg-white rounded-xl border border-cream-border shadow-xl p-6 w-full max-w-lg flex flex-col gap-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">Edit Customer</span>
          <span className="text-xs text-gray-400">ID: {rowId}</span>
        </div>

        <CustomerFields draft={draft} setDraft={setDraft} warehouses={warehouses} saving={saving} />

        {saveError && <p className="text-xs text-red-500">{saveError}</p>}

        <div className="flex items-center gap-2 pt-2">
          <button
            type="button"
            onClick={onDelete}
            disabled={saving}
            aria-label="Delete"
            className="inline-flex items-center justify-center h-[38px] md:h-auto border border-cream-border md:border-transparent rounded-lg md:rounded-none px-3 md:px-0 md:py-2 text-sm text-gray-400 md:text-red-500 hover:border-brand md:hover:border-transparent md:hover:underline disabled:opacity-50 transition-colors"
          >
            <svg className="md:hidden" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" />
            </svg>
            <span className="hidden md:inline">Delete</span>
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
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
  )
}
