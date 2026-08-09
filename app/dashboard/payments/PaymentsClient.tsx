"use client"

import { displayIg } from "@/lib/format"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { PaymentRow } from "@/lib/db"
import type { Role } from "@/lib/roles"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import { useModalDismiss } from "@/hooks/useModalDismiss"
import SearchableSelect from "@/components/SearchableSelect"
import SearchInput from "@/components/SearchInput"
import EventSelect from "@/components/EventSelect"
import DataGrid, {
  numericFilter,
  textContainsFilter,
  booleanFilter,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type PaginationState,
} from "@/components/DataGrid"
import { usePaginatedFetch, type PageData } from "@/hooks/usePaginatedFetch"

const PAGE_SIZE = 25

// py-2 so plain inputs match the SearchableSelect's height across the payment
// forms (Amount/Account/Date/Remarks line up with Event/Customer).
const INPUT_CLASS_TALL =
  "w-full border border-cream-border rounded-md px-2 py-2 text-sm text-foreground bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
// Native <input type="date"> renders taller than a text input on iOS Safari;
// pin the height and drop the native chrome so it matches the Remarks box.
const DATE_INPUT_CLASS = `${INPUT_CLASS_TALL} h-[38px] appearance-none`
const LABEL = "text-xs text-gray-500 mb-1 block"
// Fallback while options are still loading — the real list comes from
// useSheetOptions().accounts (distinct values already in use, autocompleted
// via SearchableSelect, same pattern as the Products page's Store field).
const FALLBACK_ACCOUNT_OPTIONS = ["BCA", "JAGO", "QRIS", "TRANSFER"]

// Checked-status filter: "" = all, "true" = checked only, "false" = unchecked.
type CheckedFilter = "" | "true" | "false"
const CHECKED_FILTER_OPTIONS = [
  { value: "", label: "All status" },
  { value: "true", label: "Checked" },
  { value: "false", label: "Unchecked" },
]

// Payment kind filter, driven by the type tabs. "" = all.
type KindFilter = "" | "deposit" | "credit" | "refund"
const KIND_TABS: { key: KindFilter; label: string }[] = [
  { key: "", label: "All" },
  { key: "deposit", label: "Deposit" },
  { key: "credit", label: "Credit" },
  { key: "refund", label: "Refund" },
]
// Same options as the type tabs, for the mobile popover's click-only dropdown.
const KIND_FILTER_OPTIONS = KIND_TABS.map(({ key, label }) => ({
  value: key,
  label: key ? label : "All types",
}))

type EditForm = {
  event: string
  customer: string
  amount: string
  account: string
  isChecked: boolean
  payDate: string
  remarks: string
}

function formatAmount(n: number): string {
  return new Intl.NumberFormat("id-ID").format(n)
}

function formatDate(iso: string): string {
  if (!iso) return "—"
  const d = new Date(iso + "T00:00:00")
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
}

export default function PaymentsClient({ role }: { role: Role | null }) {
  const isAdmin = role === "admin"
  const options = useSheetOptions()
  const [rows, setRows] = useState<PaymentRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [depositSum, setDepositSum] = useState<number | null>(null)
  const [refundSum, setRefundSum] = useState<number | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [mobileAddOpen, setMobileAddOpen] = useState(false)
  const [editingRow, setEditingRow] = useState<PaymentRow | null>(null)

  // Server-side table state.
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState("")
  const [checkedFilter, setCheckedFilter] = useState<CheckedFilter>("")
  const [kindFilter, setKindFilter] = useState<KindFilter>("deposit")
  // Mobile: both filters (status + type) live behind one popover button.
  const [filterOpen, setFilterOpen] = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!filterOpen) return
    const h = (e: MouseEvent) => { if (!filterRef.current?.contains(e.target as Node)) setFilterOpen(false) }
    document.addEventListener("mousedown", h)
    return () => document.removeEventListener("mousedown", h)
  }, [filterOpen])
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE })

  // Only the text columns are server-filterable via column headers; amount/date
  // filters are disabled (see column defs). The checked-status filter is driven
  // by its own toolbar control (checkedFilter), not a column header.
  const fetchFilters = useMemo<Record<string, string>>(() => {
    const f: Record<string, string> = {}
    for (const cf of columnFilters) {
      // Date column carries a {from,to} range object, not a plain string.
      if (cf.id === "payDate") {
        const { from, to } = (cf.value as { from?: string; to?: string } | undefined) ?? {}
        if (from) f.dateFrom = from
        if (to) f.dateTo = to
        continue
      }
      const v = String(cf.value ?? "").trim()
      if (!v) continue
      if (cf.id === "event") f.event = v
      else if (cf.id === "customer") f.customer = v
      else if (cf.id === "account") f.account = v
      else if (cf.id === "remarks") f.remarks = v
    }
    // Sent as ?isChecked=true|false; the API maps absent → all.
    if (checkedFilter) f.isChecked = checkedFilter
    // Type is driven by the tabs, not a column filter.
    if (kindFilter) f.kind = kindFilter
    return f
  }, [columnFilters, checkedFilter, kindFilter])

  const fetchSort = useMemo(() => {
    if (sorting.length === 0) return null
    return { key: sorting[0].id, direction: sorting[0].desc ? ("desc" as const) : ("asc" as const) }
  }, [sorting])

  const onData = useCallback((d: PageData & { depositSum?: number | null; refundSum?: number | null }) => {
    setRows(d.rows as PaymentRow[])
    setTotalCount(d.totalCount)
    // skipCount responses omit the sums (undefined) — keep the last known values.
    if (d.depositSum !== undefined) setDepositSum(d.depositSum)
    if (d.refundSum !== undefined) setRefundSum(d.refundSum)
  }, [])

  const { fetchState, refresh } = usePaginatedFetch({
    endpoint: "/api/sheets/payments",
    pageSize: PAGE_SIZE,
    page: pagination.pageIndex + 1,
    search: globalFilter,
    filters: fetchFilters,
    sort: fetchSort,
    onData,
  })

  // Stable ref so row-action callbacks captured in column defs call latest refresh.
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  // Reset to page 1 when the query shape (sort/filter/search) changes.
  const handleSortingChange = useCallback((u: SortingState | ((p: SortingState) => SortingState)) => {
    setSorting(u); setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])
  const handleColumnFiltersChange = useCallback((u: ColumnFiltersState | ((p: ColumnFiltersState) => ColumnFiltersState)) => {
    setColumnFilters(u); setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])
  const handleGlobalFilterChange = useCallback((u: string | ((p: string) => string)) => {
    setGlobalFilter(u); setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])
  const handleCheckedFilterChange = useCallback((v: CheckedFilter) => {
    setCheckedFilter(v); setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])
  const handleKindFilterChange = useCallback((v: KindFilter) => {
    setKindFilter(v); setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])

  async function handleToggleCheck(row: PaymentRow) {
    if (isAdmin) return
    const newChecked = !row.isChecked
    setRows((prev) =>
      prev.map((r) => (r.rowNumber === row.rowNumber ? { ...r, isChecked: newChecked } : r)),
    )
    try {
      const res = await fetch(`/api/sheets/payments/${row.rowNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isChecked: newChecked }),
      })
      if (!res.ok) throw new Error("Failed")
    } catch {
      setRows((prev) =>
        prev.map((r) => (r.rowNumber === row.rowNumber ? { ...r, isChecked: !newChecked } : r)),
      )
    }
  }

  async function handleSaveRemarks(row: PaymentRow, remarks: string) {
    if (remarks === row.remarks) return
    const previous = row.remarks
    setRows((prev) =>
      prev.map((r) => (r.rowNumber === row.rowNumber ? { ...r, remarks } : r)),
    )
    try {
      const res = await fetch(`/api/sheets/payments/${row.rowNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remarks }),
      })
      if (!res.ok) throw new Error("Failed")
    } catch {
      setRows((prev) =>
        prev.map((r) => (r.rowNumber === row.rowNumber ? { ...r, remarks: previous } : r)),
      )
    }
  }

  async function handleDeleteRow(row: PaymentRow) {
    if (!confirm("Delete this payment? This cannot be undone.")) return
    try {
      const res = await fetch(`/api/sheets/payments/${row.rowNumber}`, { method: "DELETE" })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? "Failed to delete")
      }
      refreshRef.current()
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  const columns = useMemo<ColumnDef<PaymentRow, unknown>[]>(() => [
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
      accessorKey: "amount",
      header: "Amount",
      size: 130,
      enableColumnFilter: false,
      meta: { align: "right" },
      cell: ({ row }) => (
        <span className="tabular-nums font-medium">{formatAmount(row.original.amount)}</span>
      ),
    },
    {
      accessorKey: "kind",
      header: "Type",
      size: 100,
      enableColumnFilter: false,
      cell: ({ getValue }) => {
        const k = getValue<PaymentRow["kind"]>()
        // Deposit = real money in; refund = cash out; credit = internal
        // overpayment transfer (no cash moved).
        const cls = k === "credit"
          ? "bg-purple-50 text-purple-700 border-purple-200"
          : k === "refund"
            ? "bg-orange-50 text-orange-700 border-orange-200"
            : "bg-gray-50 text-gray-500 border-cream-border"
        const label = k === "credit" ? "Credit" : k === "refund" ? "Refund" : "Deposit"
        return <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium border ${cls}`}>{label}</span>
      },
    },
    {
      accessorKey: "account",
      header: "Account",
      size: 120,
      filterFn: "textContains",
      cell: ({ row }) => (
        <span className="text-gray-500">{row.original.account || "—"}</span>
      ),
    },
    {
      accessorKey: "isChecked",
      header: "✓",
      enableColumnFilter: false,
      enableSorting: false,
      size: 60,
      cell: ({ row }) => (
        <input
          type="checkbox"
          checked={row.original.isChecked}
          onChange={() => handleToggleCheck(row.original)}
          disabled={isAdmin}
          className={`accent-brand ${isAdmin ? "cursor-default" : "cursor-pointer"}`}
        />
      ),
    },
    {
      accessorKey: "payDate",
      header: "Date",
      size: 100,
      filterFn: "dateRange",
      cell: ({ row }) => (
        <span className="text-gray-500 text-xs whitespace-nowrap">
          {formatDate(row.original.payDate)}
        </span>
      ),
    },
    {
      accessorKey: "remarks",
      header: "Remarks",
      size: 140,
      filterFn: "textContains",
      cell: ({ row }) => <InlineRemarks row={row.original} onSave={handleSaveRemarks} />,
    },
    {
      accessorKey: "createdAt",
      header: "Created",
      size: 110,
      enableColumnFilter: false,
      cell: ({ row }) => (
        <span className="text-gray-400 text-xs whitespace-nowrap">{row.original.createdAt}</span>
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [isAdmin])

  const refreshButton = useMemo(() => (
    <>
      <button
        onClick={() => { setAddOpen((o) => !o); setEditingRow(null) }}
        className={`inline-flex items-center gap-1.5 h-[38px] px-3 text-sm rounded-lg border transition-colors ${
          addOpen ? "bg-brand-light text-brand border-brand/30" : "bg-brand text-white border-transparent hover:bg-brand-hover"
        }`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        Add Payment
      </button>
    </>
  ), [addOpen])

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
      {/* Stat cards: Deposit (cash in, 2/3 width) + Refund (cash out, 1/3 width)
          on one row. Sums honour the active filters but ignore the type tab. */}
      <div className="grid grid-cols-[53fr_47fr] gap-2 sm:gap-4">
        <div className="rounded-xl border border-cream-border border-l-4 border-l-brand bg-white px-3 py-3 sm:px-5 sm:py-4">
          <div className="text-xs font-medium text-gray-400 uppercase tracking-wide">Deposit</div>
          <div className="text-lg sm:text-2xl font-bold text-foreground mt-1 tabular-nums whitespace-nowrap">
            {depositSum !== null ? `Rp ${formatAmount(depositSum)}` : "—"}
          </div>
        </div>
        <div className="rounded-xl border border-cream-border border-l-4 border-l-orange-500 bg-white px-3 py-3 sm:px-5 sm:py-4">
          <div className="text-xs font-medium text-gray-400 uppercase tracking-wide">Refund</div>
          <div className="text-lg sm:text-2xl font-bold text-foreground mt-1 tabular-nums whitespace-nowrap">
            {refundSum !== null ? `Rp ${formatAmount(refundSum)}` : "—"}
          </div>
        </div>
      </div>

      {/* Type filter tabs */}
      <div className="hidden md:flex items-center gap-1 w-full rounded-xl border border-cream-border bg-white p-1 overflow-x-auto">
        {KIND_TABS.map(({ key, label }) => {
          const active = kindFilter === key
          return (
            <button
              key={key || "all"}
              onClick={() => handleKindFilterChange(key)}
              className={`flex-1 shrink-0 flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                active ? "bg-brand text-white" : "text-gray-500 hover:text-foreground"
              }`}
            >
              {label}
            </button>
          )
        })}
      </div>

      {/* Desktop table */}
      <div className="hidden md:block">
        <DataGrid
          data={rows}
          columns={columns}
          getRowId={(row) => String(row.rowNumber)}
          searchPlaceholder="Search name, amount, account..."
          fullWidthSearch
          tightToolbar
          boldUppercaseHeader
          hideRowCount
          belowToolbar={
            addOpen ? (
              <AddPaymentForm
                options={options}
                onAdded={() => refreshRef.current()}
                onClose={() => setAddOpen(false)}
              />
            ) : undefined
          }
          toolbarExtra={
            <div className="w-36 shrink-0">
              <SearchableSelect
                value={checkedFilter}
                onChange={(v) => handleCheckedFilterChange(v as CheckedFilter)}
                options={CHECKED_FILTER_OPTIONS}
                searchable={false}
              />
            </div>
          }
          toolbarExtraEnd={refreshButton}
          initialVisibility={{ createdAt: false, updatedAt: false }}
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
      </div>

      {/* Mobile cards */}
      <div className="md:hidden flex flex-col gap-2.5">
        <div className="flex gap-2">
          <SearchInput
            value={globalFilter}
            onChange={handleGlobalFilterChange}
            placeholder="Cari nama, nominal, akun…"
            className="flex-1 min-w-0"
          />
          <div className="relative shrink-0" ref={filterRef}>
            <button
              type="button"
              onClick={() => setFilterOpen((o) => !o)}
              aria-label="Filters"
              className="h-full border border-cream-border rounded-lg px-3 py-2 text-sm text-gray-600 bg-white flex items-center gap-1.5 hover:border-brand transition-colors"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
              {(checkedFilter || kindFilter) && <span className="w-1.5 h-1.5 rounded-full bg-brand" />}
            </button>
            {filterOpen && (
              <div className="absolute right-0 top-full mt-1 z-30 w-52 rounded-lg border border-cream-border bg-white shadow-lg p-3 flex flex-col gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-gray-500">Status</span>
                  <SearchableSelect
                    value={checkedFilter}
                    onChange={(v) => handleCheckedFilterChange(v as CheckedFilter)}
                    options={CHECKED_FILTER_OPTIONS}
                    searchable={false}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-gray-500">Type</span>
                  <SearchableSelect
                    value={kindFilter}
                    onChange={(v) => handleKindFilterChange(v as KindFilter)}
                    options={KIND_FILTER_OPTIONS}
                    searchable={false}
                  />
                </label>
              </div>
            )}
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-gray-400">
            {fetchState.loading ? "Loading…" : globalFilter ? "No matches" : "No payments yet"}
          </div>
        ) : (
          rows.map((row) => (
            <PaymentCard
              key={row.rowNumber}
              row={row}
              isAdmin={isAdmin}
              onToggleCheck={() => handleToggleCheck(row)}
              onEdit={() => setEditingRow(row)}
            />
          ))
        )}
        {totalCount > PAGE_SIZE && (
          <div className="flex items-center justify-between gap-3 pt-1">
            <button type="button" disabled={pagination.pageIndex === 0} onClick={() => setPagination((p) => ({ ...p, pageIndex: p.pageIndex - 1 }))} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm text-gray-600 disabled:opacity-40">Prev</button>
            <span className="text-xs text-gray-400">Page {pagination.pageIndex + 1} of {Math.max(1, Math.ceil(totalCount / PAGE_SIZE))}</span>
            <button type="button" disabled={(pagination.pageIndex + 1) * PAGE_SIZE >= totalCount} onClick={() => setPagination((p) => ({ ...p, pageIndex: p.pageIndex + 1 }))} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm text-gray-600 disabled:opacity-40">Next</button>
          </div>
        )}
      </div>

      {/* Mobile add FAB */}
      <button
        type="button"
        onClick={() => setMobileAddOpen(true)}
        aria-label="Add payment"
        className="md:hidden fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 w-14 h-14 rounded-full bg-brand text-white text-3xl leading-none shadow-lg flex items-center justify-center active:bg-brand/90"
      >
        +
      </button>

      {/* Mobile add bottom sheet */}
      {mobileAddOpen && (
        <MobileAddPaymentSheet
          options={options}
          onClose={() => setMobileAddOpen(false)}
          onAdded={() => { refreshRef.current(); setMobileAddOpen(false); window.scrollTo({ top: 0, behavior: "smooth" }) }}
        />
      )}

      {editingRow && (
        <EditPaymentModal
          row={editingRow}
          options={options}
          isAdmin={isAdmin}
          onClose={() => setEditingRow(null)}
          onSaved={() => { setEditingRow(null); refreshRef.current() }}
          onDeleted={() => { setEditingRow(null); refreshRef.current() }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline-editable Remarks cell
// ---------------------------------------------------------------------------

function InlineRemarks({
  row,
  onSave,
}: {
  row: PaymentRow
  onSave: (row: PaymentRow, remarks: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(row.remarks)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])
  // Re-sync when the row changes externally (e.g. refresh) and we're not editing.
  useEffect(() => { if (!editing) setValue(row.remarks) }, [row.remarks, editing])

  function commit() {
    setEditing(false)
    const next = value.trim()
    if (next !== row.remarks) onSave(row, next)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit() }
          if (e.key === "Escape") { setValue(row.remarks); setEditing(false) }
        }}
        placeholder="Add remark…"
        className="w-full max-w-[220px] border border-cream-border rounded px-1.5 py-0.5 text-sm text-foreground bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to edit remarks"
      className="text-left text-sm text-gray-500 uppercase truncate block max-w-[220px] w-full hover:text-brand transition-colors"
    >
      {row.remarks || <span className="text-gray-300 normal-case">Add remark…</span>}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Edit Payment Modal
// ---------------------------------------------------------------------------

function EditPaymentModal({
  row,
  options,
  isAdmin,
  onClose,
  onSaved,
  onDeleted,
}: {
  row: PaymentRow
  options: ReturnType<typeof useSheetOptions>
  isAdmin: boolean
  onClose: () => void
  onSaved: (updated: Partial<PaymentRow> & { rowNumber: number }) => void
  onDeleted: (rowNumber: number) => void
}) {
  const [form, setForm] = useState<EditForm>({
    event: row.event,
    customer: row.customer,
    amount: String(row.amount),
    account: row.account,
    isChecked: row.isChecked,
    payDate: row.payDate,
    remarks: row.remarks,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useModalDismiss(onClose)

  const customerOptions = useMemo(
    () => (options?.customers ?? []).map((c) => ({ value: c, label: displayIg(c) })),
    [options],
  )
  const accountOptions = useMemo(
    () => (options?.accounts ?? FALLBACK_ACCOUNT_OPTIONS).map((a) => ({ value: a, label: a })),
    [options],
  )

  async function handleSave() {
    setSaving(true)
    setError("")
    try {
      const res = await fetch(`/api/sheets/payments/${row.rowNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: form.event,
          customer: form.customer,
          amount: Number(form.amount),
          account: form.account,
          isChecked: form.isChecked,
          payDate: form.payDate,
          remarks: form.remarks,
        }),
      })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? "Failed to save")
      }
      onSaved({
        rowNumber: row.rowNumber,
        event: form.event,
        customer: form.customer,
        amount: Number(form.amount),
        account: form.account,
        isChecked: form.isChecked,
        payDate: form.payDate,
        remarks: form.remarks,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this payment? This cannot be undone.")) return
    try {
      const res = await fetch(`/api/sheets/payments/${row.rowNumber}`, { method: "DELETE" })
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
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center md:px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-t-2xl shadow-xl border-x border-t border-cream-border md:border w-full max-h-[90vh] overflow-y-auto md:max-w-md md:rounded-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-4 border-b border-cream-border md:border-b-0 md:pb-0 flex items-center justify-between">
          <h3 className="text-base md:text-sm font-semibold text-foreground">Edit Payment</h3>
        </div>

        <div className="px-5 py-4 space-y-3">
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
          <div className="flex gap-3">
            <div className="flex-1 min-w-0">
              <label className={LABEL}>Amount</label>
              <input type="number" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className={INPUT_CLASS_TALL} />
            </div>
            {/* Mobile: shrink the select trigger to py-1 so it matches the
                Amount input's height; desktop keeps the default py-2. */}
            <div className="flex-1 min-w-0">
              <label className={LABEL}>Account</label>
              <SearchableSelect
                value={form.account}
                onChange={(v) => setForm({ ...form, account: v })}
                options={accountOptions}
                placeholder="Account..."
                allowNewValue
              />
            </div>
          </div>
          <div className="hidden">
            <input type="checkbox" checked={form.isChecked} onChange={(e) => setForm({ ...form, isChecked: e.target.checked })} disabled={isAdmin} id="edit-checked" className="accent-brand disabled:cursor-default" />
            <label htmlFor="edit-checked" className="text-xs text-gray-500">Checked</label>
          </div>
          <div className="flex gap-3">
            <div className="flex-1 min-w-0">
              <label className={LABEL}>Date</label>
              <input type="date" value={form.payDate} onChange={(e) => setForm({ ...form, payDate: e.target.value })} className={DATE_INPUT_CLASS} />
            </div>
            <div className="flex-1 min-w-0">
              <label className={LABEL}>Remarks</label>
              <input type="text" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} placeholder="Optional" className={INPUT_CLASS_TALL} />
            </div>
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <div className="px-5 pt-3 pb-8 md:py-3 flex items-center gap-2">
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
          <button onClick={onClose} disabled={saving} className="ml-auto px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
            Cancel
          </button>
          <button
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

// ---------------------------------------------------------------------------
// Add Payment Form
// ---------------------------------------------------------------------------

function AddPaymentForm({
  options,
  onAdded,
  onClose,
}: {
  options: ReturnType<typeof useSheetOptions>
  onAdded: () => void
  onClose: () => void
}) {
  const [event, setEvent] = useState("")
  const [customer, setCustomer] = useState("")
  const [amount, setAmount] = useState("")
  const [account, setAccount] = useState("BCA")
  const [payDate, setPayDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [remarks, setRemarks] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null)

  const customerOptions = useMemo(
    () => (options?.customers ?? []).map((c) => ({ value: c, label: displayIg(c) })),
    [options],
  )
  const accountOptions = useMemo(
    () => (options?.accounts ?? FALLBACK_ACCOUNT_OPTIONS).map((a) => ({ value: a, label: a })),
    [options],
  )

  const canSubmit = Boolean(event) && Boolean(customer) && Boolean(amount) && Number(amount) > 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setFeedback(null)
    try {
      const res = await fetch("/api/sheets/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, customer, amount: Number(amount), account, isChecked: false, payDate, remarks }),
      })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? "Failed to save")
      }
      setFeedback({ type: "success", message: "Payment added" })
      setCustomer("")
      setAmount("")
      setRemarks("")
      onAdded()
    } catch (err) {
      setFeedback({ type: "error", message: err instanceof Error ? err.message : "Failed to save" })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-xl border border-cream-border bg-white p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-foreground">Add Payment</h3>
      </div>
      <form onSubmit={handleSubmit} className="flex items-end gap-3 flex-wrap">
        <div>
          <label className={LABEL}>Event <span className="text-brand">*</span></label>
          <div style={{ width: "10rem" }}>
            <EventSelect value={event} onChange={(v) => { setEvent(v); setFeedback(null) }} events={options?.events ?? []} />
          </div>
        </div>
        <div>
          <label className={LABEL}>Customer <span className="text-brand">*</span></label>
          <div style={{ width: "10rem" }}>
            <SearchableSelect
              value={customer}
              onChange={(v) => { setCustomer(v); setFeedback(null) }}
              options={customerOptions}
              placeholder="Customer..."
              allowNewValue
            />
          </div>
        </div>
        <div>
          <label className={LABEL}>Amount <span className="text-brand">*</span></label>
          <input type="number" min="0" value={amount} onChange={(e) => { setAmount(e.target.value); setFeedback(null) }} placeholder="0" className={INPUT_CLASS_TALL} style={{ width: "7rem" }} />
        </div>
        <div>
          <label className={LABEL}>Account</label>
          <div style={{ width: "9rem" }}>
            <SearchableSelect
              value={account}
              onChange={setAccount}
              options={accountOptions}
              placeholder="Account..."
              allowNewValue
            />
          </div>
        </div>
        <div>
          <label className={LABEL}>Date</label>
          <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} className={INPUT_CLASS_TALL} style={{ width: "9rem" }} />
        </div>
        <div className="flex-1 min-w-[8rem]">
          <label className={LABEL}>Remarks</label>
          <input type="text" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional" className={INPUT_CLASS_TALL} />
        </div>
        <div className="w-full flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !canSubmit}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-brand text-white hover:bg-brand-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {submitting ? "Saving…" : "Add"}
          </button>
        </div>
      </form>
      {feedback && <p className={`text-xs mt-2 ${feedback.type === "success" ? "text-green-600" : "text-red-600"}`}>{feedback.message}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Mobile: single-payment card
// ---------------------------------------------------------------------------

function PaymentCard({
  row,
  isAdmin,
  onToggleCheck,
  onEdit,
}: {
  row: PaymentRow
  isAdmin: boolean
  onToggleCheck: () => void
  onEdit: () => void
}) {
  return (
    <div
      onClick={onEdit}
      className="rounded-xl border border-cream-border bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex flex-col gap-2 cursor-pointer active:bg-cream/40 transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground uppercase truncate">{displayIg(row.customer)}</div>
          <div className="text-xs text-gray-500 mt-2 truncate uppercase">{row.remarks}</div>
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleCheck() }}
          disabled={isAdmin}
          aria-label={row.isChecked ? "Tandai belum dicek" : "Tandai sudah dicek"}
          className={`shrink-0 p-1 rounded-md transition-colors ${
            row.isChecked
              ? "bg-green-100 text-green-700 active:bg-green-200"
              : "text-gray-300 active:bg-cream"
          } ${isAdmin ? "cursor-default" : "cursor-pointer"}`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </button>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-cream-border pt-2">
        <div className="text-xs text-gray-400 uppercase truncate min-w-0">{row.event} · {formatDate(row.payDate)}{row.account ? ` · ${row.account}` : ""}</div>
        <span className="text-sm font-semibold tabular-nums text-foreground whitespace-nowrap shrink-0">Rp {formatAmount(row.amount)}</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Mobile: add-payment bottom sheet
// ---------------------------------------------------------------------------

function MobileAddPaymentSheet({
  options,
  onClose,
  onAdded,
}: {
  options: ReturnType<typeof useSheetOptions>
  onClose: () => void
  onAdded: () => void
}) {
  const [event, setEvent] = useState("")
  const [customer, setCustomer] = useState("")
  const [amount, setAmount] = useState("")
  const [account, setAccount] = useState("BCA")
  // New mobile-added payments default to unchecked (the checkbox was removed
  // from this sheet); the value is still sent so the API shape is unchanged.
  const isChecked = false
  const [payDate, setPayDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [remarks, setRemarks] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const customerOptions = useMemo(
    () => (options?.customers ?? []).map((c) => ({ value: c, label: displayIg(c) })),
    [options],
  )
  const accountOptions = useMemo(
    () => (options?.accounts ?? FALLBACK_ACCOUNT_OPTIONS).map((a) => ({ value: a, label: a })),
    [options],
  )

  const canSubmit = Boolean(event) && Boolean(customer) && Boolean(amount) && Number(amount) > 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, customer, amount: Number(amount), account, isChecked, payDate, remarks }),
      })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? "Failed to save")
      }
      onAdded()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="md:hidden fixed inset-0 z-40 flex items-end bg-black/40" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full bg-white rounded-t-2xl p-5 pb-8 flex flex-col gap-3 max-h-[88vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between -mx-5 px-5 border-b border-cream-border pb-3">
          <span className="text-base font-semibold text-foreground">Add Payment</span>
        </div>

        <div>
          <label className={LABEL}>Event <span className="text-brand">*</span></label>
          <EventSelect value={event} onChange={setEvent} events={options?.events ?? []} />
        </div>
        <div>
          <label className={LABEL}>Customer <span className="text-brand">*</span></label>
          <SearchableSelect
            value={customer}
            onChange={setCustomer}
            options={customerOptions}
            placeholder="Customer..."
            allowNewValue
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>Amount <span className="text-brand">*</span></label>
            <input type="number" min="0" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" className={INPUT_CLASS_TALL} />
          </div>
          <div>
            <label className={LABEL}>Account</label>
            <SearchableSelect
              value={account}
              onChange={setAccount}
              options={accountOptions}
              placeholder="Account..."
              allowNewValue
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>Date</label>
            <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} className={DATE_INPUT_CLASS} />
          </div>
          <div>
            <label className={LABEL}>Remarks</label>
            <input type="text" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional" className={INPUT_CLASS_TALL} />
          </div>
        </div>

        {error && <p className="text-xs text-red-500">{error}</p>}

        <div className="flex items-center justify-end gap-2 mt-1">
          <button type="button" onClick={onClose} disabled={submitting} className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
            Cancel
          </button>
          <button type="submit" disabled={submitting || !canSubmit} className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
            {submitting ? "Saving…" : "Add"}
          </button>
        </div>
      </form>
    </div>
  )
}
