"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { OperationalExpenseRow, ExpenseCategory } from "@/lib/db/types"
import { EXPENSE_CATEGORIES } from "@/lib/db/types"
import DataGrid, {
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type PaginationState,
} from "@/components/DataGrid"
import { usePaginatedFetch, type PageData } from "@/hooks/usePaginatedFetch"
import SearchableSelect from "@/components/SearchableSelect"
import SearchInput from "@/components/SearchInput"
import EventSelect from "@/components/EventSelect"

const PAGE_SIZE = 25

/** An event plus the currency/kurs derived from its country (1 event = 1
 *  country). currency is "" and kurs 0 when the event has no country set. */
type EventOption = { name: string; currency: string; kurs: number }

const IDR = "IDR"

const fmt = (n: number) => n.toLocaleString("id-ID")

const formInputCls =
  "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

const CATEGORY_BADGE: Record<ExpenseCategory, string> = {
  Flight: "bg-sky-50 text-sky-600",
  Lodging: "bg-violet-50 text-violet-600",
  Cargo: "bg-amber-50 text-amber-600",
  Meal: "bg-rose-50 text-rose-600",
  Transport: "bg-emerald-50 text-emerald-600",
  Shop: "bg-blue-50 text-blue-600",
  Supplies: "bg-teal-50 text-teal-600",
  Delivery: "bg-orange-50 text-orange-600",
  Personal: "bg-pink-50 text-pink-600",
  Payroll: "bg-indigo-50 text-indigo-600",
  Dividend: "bg-green-50 text-green-600",
  Other: "bg-gray-50 text-gray-600",
}

/** Parses an amount typed with optional thousands commas ("1,500,000" → 1500000).
 *  Dots stay decimal points ("10.50" → 10.5), matching what type="number" accepted. */
function parseAmount(s: string): number {
  const n = Number(s.replace(/,/g, "").trim())
  return Number.isFinite(n) ? n : 0
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function formatDate(iso: string): string {
  if (!iso) return "—"
  const d = new Date(iso + "T00:00:00")
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
}

/** The real exchange rate actually paid: IDR ÷ foreign, rounded to 2 dp. Returns
 *  0 when foreign is 0 (rate is undefined until an amount is entered). Unlike the
 *  event's country kurs (marked up for product-cost simplification), this is the
 *  true rate implied by what was spent. */
function calcRate(idr: number, foreign: number): number {
  if (!foreign) return 0
  return Math.round(((Number(idr) || 0) / foreign) * 100) / 100
}

/** Infers a row's currency from its stored kurs: 1 = paid in IDR, otherwise the
 *  event's foreign currency (or "FX" if the event has no country recorded). */
function inferCurrency(row: OperationalExpenseRow, events: EventOption[]): string {
  if (Number(row.rate) === 1) return IDR
  return events.find((e) => e.name === row.event)?.currency || "FX"
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-gray-500">{label}</span>
      {children}
    </label>
  )
}

function CategoryBadge({ category }: { category: ExpenseCategory }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${CATEGORY_BADGE[category] ?? "bg-gray-100 text-gray-500"}`}>
      {category}
    </span>
  )
}

// Per-category glyph for the mobile card's leading circle avatar.
const CATEGORY_ICON: Record<ExpenseCategory, React.ReactNode> = {
  Flight: <><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" /></>,
  Lodging: <><path d="M2 4v16" /><path d="M2 8h18a2 2 0 0 1 2 2v10" /><path d="M2 17h20" /><path d="M6 8v9" /></>,
  Cargo: <><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></>,
  Meal: <><path d="M5 2v5" /><path d="M8 2v5" /><path d="M6.5 7v14" /><path d="M5 7h3" /><path d="M17 2c-1.66 0-3 2.24-3 5v3a1 1 0 0 0 1 1h2Z" /><path d="M17 11v10" /></>,
  Transport: <><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9L18.4 5c-.3-.6-.9-1-1.5-1H7c-.6 0-1.2.4-1.5 1l-2.1 6.1C2.7 11.3 2 12.1 2 13v3c0 .6.4 1 1 1h2" /><circle cx="7" cy="17" r="2" /><circle cx="17" cy="17" r="2" /></>,
  Shop: <><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" /><path d="M3 6h18" /><path d="M16 10a4 4 0 0 1-8 0" /></>,
  Supplies: <><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></>,
  Delivery: <><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" /><path d="M15 18H9" /><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14" /><circle cx="17" cy="18" r="2" /><circle cx="7" cy="18" r="2" /></>,
  Personal: <><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>,
  Payroll: <><rect x="2" y="5" width="20" height="14" rx="2" /><circle cx="12" cy="12" r="2" /><path d="M6 12h.01M18 12h.01" /></>,
  Dividend: <><circle cx="8" cy="8" r="6" /><path d="M18.09 10.37A6 6 0 1 1 10.34 18" /><path d="M7 6h1v4" /></>,
  Other: <><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" /><circle cx="7.5" cy="7.5" r=".5" fill="currentColor" /></>,
}

function CategoryIcon({ category }: { category: ExpenseCategory }) {
  return (
    <div className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 ${CATEGORY_BADGE[category] ?? "bg-gray-100 text-gray-500"}`} title={category}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {CATEGORY_ICON[category] ?? CATEGORY_ICON.Other}
      </svg>
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function OperationalExpensesClient() {
  const [data, setData] = useState<OperationalExpenseRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [filteredSum, setFilteredSum] = useState<number | null>(null)
  const [cogsSum, setCogsSum] = useState<number | null>(null)
  const [opexSum, setOpexSum] = useState<number | null>(null)
  // Full dropdown lists (event names + distinct methods/categories) — load once
  // from the meta endpoint (a GET with no `page` param), like products'
  // countries/stores.
  const [events, setEvents] = useState<EventOption[]>([])
  const [methods, setMethods] = useState<string[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [metaError, setMetaError] = useState<string | null>(null)

  const [sorting, setSorting] = useState<SortingState>([{ id: "id", desc: true }])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState("")
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE })
  // Date-range filter, separate from columnFilters — expenseDate has no column
  // header filter, this is its own control above the search bar.
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")

  const [addOpen, setAddOpen] = useState(false)
  const [mobileAddOpen, setMobileAddOpen] = useState(false)
  // Mobile row action sheet + the edit modal it can open — separate from
  // ExpenseActions' own internal edit state (which desktop's inline icons use).
  const [editingExpense, setEditingExpense] = useState<OperationalExpenseRow | null>(null)
  const [mobileDeleting, setMobileDeleting] = useState(false)
  // Set when "Duplicate" is clicked on a row — seeds the Add form with that
  // row's fields (fresh date, unsettled) so a similar entry can be added fast.
  const [duplicateSeed, setDuplicateSeed] = useState<{ row: OperationalExpenseRow; version: number } | null>(null)
  const addFormRef = useRef<HTMLDivElement>(null)

  const loadMeta = useCallback(async () => {
    try {
      const res = await fetch("/api/sheets/operational-expenses")
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to load")
      setEvents(json.events as EventOption[])
      setMethods(json.methods as string[])
      setCategories(json.categories as string[])
    } catch (err) {
      setMetaError(err instanceof Error ? err.message : "Failed to load")
    }
  }, [])
  useEffect(() => { loadMeta() }, [loadMeta])

  // Server-filterable text columns → query params (event / category / method),
  // plus the standalone date-range filter above the search bar.
  const fetchFilters = useMemo<Record<string, string>>(() => {
    const f: Record<string, string> = {}
    for (const cf of columnFilters) {
      const v = String(cf.value ?? "").trim()
      if (!v) continue
      if (cf.id === "event") f.event = v
      else if (cf.id === "category") f.category = v
      else if (cf.id === "method") f.method = v
      else if (cf.id === "isSettled") f.settled = v
    }
    if (dateFrom) f.dateFrom = dateFrom
    if (dateTo) f.dateTo = dateTo
    return f
  }, [columnFilters, dateFrom, dateTo])

  const fetchSort = useMemo(() => {
    if (sorting.length === 0) return null
    return { key: sorting[0].id, direction: sorting[0].desc ? ("desc" as const) : ("asc" as const) }
  }, [sorting])

  const onData = useCallback((d: PageData & { cogsSum?: number | null; opexSum?: number | null }) => {
    setData(d.rows as OperationalExpenseRow[])
    setTotalCount(d.totalCount)
    setFilteredSum(d.filteredSum)
    if (d.cogsSum !== undefined) setCogsSum(d.cogsSum)
    if (d.opexSum !== undefined) setOpexSum(d.opexSum)
  }, [])

  const { fetchState, refresh } = usePaginatedFetch({
    endpoint: "/api/sheets/operational-expenses",
    pageSize: PAGE_SIZE,
    page: pagination.pageIndex + 1,
    search: globalFilter,
    filters: fetchFilters,
    sort: fetchSort,
    onData,
  })

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  // After a mutation: refetch the current page + the meta (a new method may have
  // appeared for the autocomplete).
  const reloadAll = useCallback(() => { refreshRef.current(); loadMeta() }, [loadMeta])

  // Reset to page 1 whenever the query shape (sort / filter / search) changes.
  const handleSortingChange = useCallback((u: SortingState | ((p: SortingState) => SortingState)) => {
    setSorting(u)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])
  const handleColumnFiltersChange = useCallback((u: ColumnFiltersState | ((p: ColumnFiltersState) => ColumnFiltersState)) => {
    setColumnFilters(u)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])
  // Upserts the "event" column filter — shares state with the Event column's
  // own header filter, so the dropdown above the search bar and that header
  // filter always agree.
  const handleEventPickerChange = useCallback((name: string) => {
    handleColumnFiltersChange((prev) => {
      const rest = prev.filter((cf) => cf.id !== "event")
      return name ? [...rest, { id: "event", value: name }] : rest
    })
  }, [handleColumnFiltersChange])
  const handleDateFromChange = useCallback((v: string) => {
    setDateFrom(v)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])
  const handleDateToChange = useCallback((v: string) => {
    setDateTo(v)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])
  const handleGlobalFilterChange = useCallback((u: string | ((p: string) => string)) => {
    setGlobalFilter(u)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])

  const mobileIdDesc = (sorting.find((s) => s.id === "id")?.desc) ?? true

  // Current "event" column-filter value, so the Event picker above the search
  // bar stays in sync with the (shared) column header filter.
  const eventFilterValue = (columnFilters.find((cf) => cf.id === "event")?.value as string) ?? ""
  // Method + settled-status filters share the columnFilters store (ids "method"
  // / "isSettled"), driven by the mobile filter popover.
  const methodFilterValue = (columnFilters.find((cf) => cf.id === "method")?.value as string) ?? ""
  const settledFilterValue = (columnFilters.find((cf) => cf.id === "isSettled")?.value as string) ?? ""
  const upsertColumnFilter = useCallback((id: string, value: string) => {
    handleColumnFiltersChange((prev) => {
      const rest = prev.filter((cf) => cf.id !== id)
      return value ? [...rest, { id, value }] : rest
    })
  }, [handleColumnFiltersChange])

  // Mobile filter popover (settled status + method), like the Payments page.
  const [filterOpen, setFilterOpen] = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!filterOpen) return
    const h = (e: MouseEvent) => { if (!filterRef.current?.contains(e.target as Node)) setFilterOpen(false) }
    document.addEventListener("mousedown", h)
    return () => document.removeEventListener("mousedown", h)
  }, [filterOpen])

  // Suggested categories + whatever's actually in the DB, deduped.
  const categoryOptions = useMemo(
    () => Array.from(new Set([...EXPENSE_CATEGORIES, ...categories])),
    [categories],
  )

  // Seed the Add form (desktop: open + scroll to it; mobile: open the add sheet).
  const handleDuplicate = useCallback((row: OperationalExpenseRow) => {
    setDuplicateSeed({ row, version: Date.now() })
    setAddOpen(true)
    setMobileAddOpen(true)
    addFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [])

  // Mirrors ExpenseActions' own delete handler — used by the mobile action
  // sheet, which triggers Delete without mounting an ExpenseActions instance.
  const handleMobileDelete = useCallback(async (row: OperationalExpenseRow) => {
    if (!confirm(`Delete this expense (${row.description || row.event})?`)) return
    setMobileDeleting(true)
    try {
      const res = await fetch(`/api/sheets/operational-expenses/${row.rowNumber}`, { method: "DELETE" })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      refreshRef.current()
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete")
    } finally {
      setMobileDeleting(false)
    }
  }, [])

  const columns = useMemo<ColumnDef<OperationalExpenseRow, unknown>[]>(() => [
    { accessorKey: "id", header: "ID", enableColumnFilter: false, size: 60 },
    {
      accessorKey: "event",
      header: "Event",
      size: 130,
      filterFn: "textContains",
      cell: ({ row }) => <span className="font-medium whitespace-nowrap">{row.original.event}</span>,
    },
    {
      accessorKey: "expenseDate",
      header: "Date",
      size: 100,
      enableColumnFilter: false,
      cell: ({ row }) => <span className="whitespace-nowrap text-gray-600">{formatDate(row.original.expenseDate)}</span>,
    },
    {
      accessorKey: "description",
      header: "Expenses",
      size: 180,
      enableColumnFilter: false,
      cell: ({ row }) => <span className="whitespace-nowrap">{row.original.description || "—"}</span>,
    },
    {
      accessorKey: "category",
      header: "Category",
      size: 120,
      filterFn: "textContains",
      cell: ({ row }) => <CategoryBadge category={row.original.category} />,
    },
    {
      accessorKey: "amountForeign",
      header: "VLS",
      size: 100,
      filterFn: "numeric",
      enableColumnFilter: false,
      cell: ({ row }) => <span className="tabular-nums">{fmt(row.original.amountForeign)}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "rate",
      header: "Kurs",
      size: 90,
      filterFn: "numeric",
      enableColumnFilter: false,
      cell: ({ row }) => <span className="tabular-nums">{fmt(row.original.rate)}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "amountIdr",
      header: "IDR",
      size: 120,
      filterFn: "numeric",
      enableColumnFilter: false,
      cell: ({ row }) => <span className="tabular-nums font-medium">{fmt(row.original.amountIdr)}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "isSettled",
      header: "Settle",
      size: 90,
      filterFn: "boolean",
      cell: ({ row }) => (
        <SettleToggle row={row.original} onToggled={() => refreshRef.current()} />
      ),
      meta: { align: "center", booleanLabels: { true: "Settled", false: "Unsettled" } },
    },
    {
      accessorKey: "method",
      header: "Method",
      size: 120,
      filterFn: "textContains",
      cell: ({ row }) => <span className="whitespace-nowrap text-gray-600">{row.original.method || "—"}</span>,
    },
    {
      accessorKey: "remarks",
      header: "Remarks",
      size: 180,
      enableColumnFilter: false,
      enableSorting: false,
      cell: ({ row }) => <InlineRemarks row={row.original} onSaved={() => refreshRef.current()} />,
    },
    { accessorKey: "createdAt", header: "Created", size: 110, enableColumnFilter: false },
    { accessorKey: "updatedAt", header: "Updated", size: 110, enableColumnFilter: false },
    {
      id: "actions",
      header: "",
      size: 100,
      enableSorting: false,
      enableColumnFilter: false,
      enableHiding: false,
      cell: ({ row }) => (
        <ExpenseActions
          row={row.original}
          events={events}
          methods={methods}
          categories={categoryOptions}
          onUpdated={() => refreshRef.current()}
          onDeleted={() => refreshRef.current()}
          onDuplicate={handleDuplicate}
        />
      ),
    },
  ], [events, methods, categoryOptions, handleDuplicate])

  const hasDateFilter = Boolean(dateFrom || dateTo)
  const clearFilters = () => {
    handleEventPickerChange("")
    upsertColumnFilter("method", "")
    upsertColumnFilter("isSettled", "")
    setDateFrom("")
    setDateTo("")
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }

  const errorMsg = fetchState.error || metaError

  return (
    <div className="flex flex-col gap-6">
      {/* Stat cards: Total, COGS (Shop + Cargo), OPEX (everything else except Dividend).
          On mobile Total spans the full width, COGS + OPEX sit side by side below. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-4">
        <div className="col-span-2 sm:col-span-1 rounded-xl border border-cream-border border-l-4 border-l-brand bg-white px-3 py-3 sm:px-5 sm:py-4">
          <div className="text-xs font-medium text-gray-400 uppercase tracking-wide">Total</div>
          <div className="text-lg sm:text-2xl font-bold text-foreground mt-1 tabular-nums whitespace-nowrap">
            {filteredSum !== null ? `Rp ${fmt(filteredSum)}` : "—"}
          </div>
        </div>
        <div className="rounded-xl border border-cream-border border-l-4 border-l-amber-500 bg-white px-3 py-3 sm:px-5 sm:py-4">
          <div className="text-xs font-medium text-gray-400 uppercase tracking-wide">COGS</div>
          <div className="text-sm sm:text-2xl font-bold text-foreground mt-1 tabular-nums whitespace-nowrap">
            {cogsSum !== null ? `Rp ${fmt(cogsSum)}` : "—"}
          </div>
        </div>
        <div className="rounded-xl border border-cream-border border-l-4 border-l-rose-500 bg-white px-3 py-3 sm:px-5 sm:py-4">
          <div className="text-xs font-medium text-gray-400 uppercase tracking-wide">OPEX</div>
          <div className="text-sm sm:text-2xl font-bold text-foreground mt-1 tabular-nums whitespace-nowrap">
            {opexSum !== null ? `Rp ${fmt(opexSum)}` : "—"}
          </div>
        </div>
      </div>

      {/* Filters: date range + event, sit above the search bar (both layouts) */}
      <div className="rounded-xl border border-cream-border bg-white p-4 flex items-end gap-x-3 gap-y-1.5 flex-wrap">
        <div className="relative flex-1 min-w-0 sm:min-w-[140px]">
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => handleDateFromChange(e.target.value)}
            aria-label="From date"
            className={`${formInputCls} w-full min-w-0 h-[38px] appearance-none ${dateFrom ? "" : "[&::-webkit-datetime-edit]:opacity-0"}`}
          />
          {!dateFrom && (
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 select-none">From</span>
          )}
        </div>
        <span className="shrink-0 self-center text-gray-400 select-none">–</span>
        <div className="relative flex-1 min-w-0 sm:min-w-[140px]">
          <input
            type="date"
            value={dateTo}
            onChange={(e) => handleDateToChange(e.target.value)}
            aria-label="To date"
            className={`${formInputCls} w-full min-w-0 h-[38px] appearance-none ${dateTo ? "" : "[&::-webkit-datetime-edit]:opacity-0"}`}
          />
          {!dateTo && (
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 select-none">To</span>
          )}
        </div>
        <div className="basis-full h-0 md:hidden" />
        <div className="flex-1 min-w-0 md:min-w-[160px] [&_input]:h-[38px]">
          <EventSelect
            value={eventFilterValue}
            onChange={handleEventPickerChange}
            events={events.map((e) => e.name)}
            placeholder="All event"
            clearable
          />
        </div>
        <div className="relative shrink-0" ref={filterRef}>
          <button
            type="button"
            onClick={() => setFilterOpen((o) => !o)}
            aria-label="Filters"
            className="relative h-[38px] w-[38px] flex items-center justify-center rounded-lg border border-cream-border text-gray-500 hover:bg-gray-50 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 3H2l8 9.46V19l4 2v-8.54z" />
            </svg>
            {(methodFilterValue || settledFilterValue) && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-brand" />}
          </button>
          {filterOpen && (
            <div className="absolute right-0 top-full mt-1 z-30 w-52 rounded-lg border border-cream-border bg-white shadow-lg p-3 flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">Status</span>
                <select
                  value={settledFilterValue}
                  onChange={(e) => upsertColumnFilter("isSettled", e.target.value)}
                  className="w-full border border-cream-border rounded-lg px-2 py-2 text-sm text-gray-600 bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
                >
                  <option value="">All status</option>
                  <option value="true">Settled</option>
                  <option value="false">Unsettled</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">Method</span>
                <select
                  value={methodFilterValue}
                  onChange={(e) => upsertColumnFilter("method", e.target.value)}
                  className="w-full border border-cream-border rounded-lg px-2 py-2 text-sm text-gray-600 bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
                >
                  <option value="">All methods</option>
                  {methods.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </div>
        {(() => {
          const active = Boolean(eventFilterValue || hasDateFilter || methodFilterValue || settledFilterValue)
          return (
            <button
              type="button"
              onClick={active ? clearFilters : undefined}
              disabled={!active}
              title={active ? "Clear filters" : "No filters applied"}
              className={`shrink-0 h-[38px] w-[38px] flex items-center justify-center rounded-lg border border-cream-border text-gray-500 transition-colors ${
                active ? "hover:bg-gray-50 cursor-pointer" : "text-gray-300 cursor-default"
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
            </button>
          )
        })()}
      </div>

      {errorMsg && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{errorMsg}</div>
      )}

      {/* Desktop table — server-side paginated */}
      <div className="hidden md:block">
        <DataGrid
          data={data}
          columns={columns}
          getRowId={(row) => String(row.rowNumber)}
          searchPlaceholder="Search event, expense, category, method, remarks, VLS, IDR…"
          fullWidthSearch
          tightToolbar
          hideRowCount
          hiddenFilterChips={["event"]}
          boldUppercaseHeader
          toolbarExtraAfterColumns
          belowToolbar={
            addOpen ? (
              <div ref={addFormRef}>
                <AddExpenseForm
                  events={events}
                  methods={methods}
                  categories={categoryOptions}
                  onAdded={() => reloadAll()}
                  onCancel={() => setAddOpen(false)}
                  seed={duplicateSeed}
                />
              </div>
            ) : undefined
          }
          toolbarExtra={
            <button
              type="button"
              onClick={() => setAddOpen((o) => !o)}
              className={`inline-flex items-center gap-1.5 h-[38px] px-3 text-sm rounded-lg border transition-colors ${
                addOpen ? "bg-brand-light text-brand border-brand/30" : "bg-brand text-white border-transparent hover:bg-brand-hover"
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              New Expenses
            </button>
          }
          initialVisibility={{ id: false, remarks: false, createdAt: false, updatedAt: false }}
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

      {/* Mobile: search + sort + cards (server-driven) */}
      <div className="md:hidden flex flex-col gap-2.5">
        <div className="flex gap-2">
          <SearchInput
            value={globalFilter}
            onChange={handleGlobalFilterChange}
            placeholder="Search expenses…"
            className="flex-1 min-w-0"
          />
          <button
            type="button"
            onClick={() => handleSortingChange([{ id: "id", desc: !mobileIdDesc }])}
            aria-label="Toggle sort order"
            className="shrink-0 inline-flex items-center gap-1 px-3 rounded-lg border border-cream-border bg-white text-sm font-medium text-gray-600 active:border-brand active:text-brand"
          >
            {mobileIdDesc ? "Newest" : "Oldest"}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {mobileIdDesc ? <path d="m6 9 6 6 6-6" /> : <path d="m18 15-6-6-6 6" />}
            </svg>
          </button>
        </div>
        {data.length === 0 && (
          <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-gray-400">{fetchState.loading ? "Loading…" : "No expenses"}</div>
        )}
        {data.map((x) => (
          <div
            key={x.rowNumber}
            onClick={() => setEditingExpense(x)}
            className="rounded-xl border border-cream-border bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] cursor-pointer active:bg-cream/40 transition-colors"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <CategoryIcon category={x.category} />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground truncate">{x.description || "—"}</div>
                  <div className="text-xs text-gray-500 mt-2 truncate uppercase tabular-nums">{x.rate !== 1 ? `${fmt(x.amountForeign)} × ${fmt(x.rate)}` : "—"}</div>
                </div>
              </div>
              <SettleToggle row={x} onToggled={() => refreshRef.current()} iconButton />
            </div>
            <div className="flex items-center justify-between gap-3 mt-2.5 pt-2.5 border-t border-cream-border">
              <span className="text-xs text-gray-400 min-w-0 truncate uppercase">
                {x.event} · {formatDate(x.expenseDate)}{x.method ? ` · ${x.method}` : ""}
              </span>
              <span className="text-sm font-semibold tabular-nums text-foreground whitespace-nowrap">Rp {fmt(x.amountIdr)}</span>
            </div>
          </div>
        ))}
        {totalCount > PAGE_SIZE && (
          <div className="flex items-center justify-between gap-3 pt-1">
            <button type="button" disabled={pagination.pageIndex === 0} onClick={() => setPagination((p) => ({ ...p, pageIndex: p.pageIndex - 1 }))} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm text-gray-600 disabled:opacity-40">Prev</button>
            <span className="text-xs text-gray-400">Page {pagination.pageIndex + 1} of {Math.max(1, Math.ceil(totalCount / PAGE_SIZE))}</span>
            <button type="button" disabled={(pagination.pageIndex + 1) * PAGE_SIZE >= totalCount} onClick={() => setPagination((p) => ({ ...p, pageIndex: p.pageIndex + 1 }))} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm text-gray-600 disabled:opacity-40">Next</button>
          </div>
        )}
      </div>


      {editingExpense && (
        <EditExpenseModal
          row={editingExpense}
          events={events}
          methods={methods}
          categories={categoryOptions}
          onSave={() => { refreshRef.current(); setEditingExpense(null) }}
          onCancel={() => setEditingExpense(null)}
          onDelete={() => { const r = editingExpense; setEditingExpense(null); handleMobileDelete(r) }}
          onDuplicate={() => { const r = editingExpense; setEditingExpense(null); handleDuplicate(r) }}
        />
      )}

      {/* Mobile add FAB */}
      <button
        type="button"
        onClick={() => setMobileAddOpen(true)}
        aria-label="Add expense"
        className="md:hidden fixed right-4 bottom-20 z-30 w-14 h-14 rounded-full bg-brand text-white text-3xl leading-none shadow-lg flex items-center justify-center active:bg-brand/90"
      >
        +
      </button>

      {/* Mobile add sheet */}
      {mobileAddOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/40 flex flex-col justify-end" onClick={() => setMobileAddOpen(false)}>
          <div className="max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <AddExpenseForm events={events} methods={methods} categories={categoryOptions} onAdded={() => { setMobileAddOpen(false); reloadAll(); window.scrollTo({ top: 0, behavior: "smooth" }) }} onCancel={() => setMobileAddOpen(false)} seed={duplicateSeed} />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Settle toggle (quick PATCH) ─────────────────────────────────────────────

function SettleToggle({ row, onToggled, iconButton }: {
  row: OperationalExpenseRow; onToggled: () => void; iconButton?: boolean
}) {
  const [saving, setSaving] = useState(false)
  async function toggle() {
    setSaving(true)
    try {
      const res = await fetch(`/api/sheets/operational-expenses/${row.rowNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isSettled: !row.isSettled }),
      })
      if (!res.ok) throw new Error()
      onToggled()
    } catch {
      // Revert is implicit — the row keeps its old value until the next fetch.
    } finally {
      setSaving(false)
    }
  }
  // iconButton: mobile card variant matching the payments page's checked-toggle
  // button (rounded icon, green when settled) instead of a plain checkbox.
  if (iconButton) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); toggle() }}
        disabled={saving}
        aria-label={row.isSettled ? "Tandai belum settled" : "Tandai settled"}
        className={`shrink-0 p-1 rounded-md transition-colors ${
          row.isSettled
            ? "bg-green-100 text-green-700 active:bg-green-200"
            : "text-gray-300 active:bg-cream"
        } cursor-pointer disabled:opacity-50`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </button>
    )
  }
  return (
    <input
      type="checkbox"
      checked={row.isSettled}
      onChange={toggle}
      disabled={saving}
      aria-label="Settled"
      className="h-4 w-4 rounded border-cream-border text-brand accent-brand cursor-pointer disabled:opacity-50"
    />
  )
}

// ─── Inline remarks (PATCH on blur) ──────────────────────────────────────────

function InlineRemarks({ row, onSaved }: { row: OperationalExpenseRow; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(row.remarks)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])
  useEffect(() => { if (!editing) setValue(row.remarks) }, [row.remarks, editing])

  async function save() {
    setEditing(false)
    if (value.trim() === row.remarks) return
    try {
      const res = await fetch(`/api/sheets/operational-expenses/${row.rowNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remarks: value }),
      })
      if (!res.ok) throw new Error()
      onSaved()
    } catch {
      setValue(row.remarks)
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save()
          else if (e.key === "Escape") { setValue(row.remarks); setEditing(false) }
        }}
        className="w-full border border-cream-border rounded-md px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
      />
    )
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to edit"
      className="text-left text-xs text-gray-500 hover:text-brand min-w-[3rem] truncate"
    >
      {row.remarks || <span className="text-gray-300">— add —</span>}
    </button>
  )
}

// ─── Add form ────────────────────────────────────────────────────────────────

const emptyDraft = () => ({
  event: "",
  expenseDate: todayIso(),
  description: "",
  category: "Shop" as ExpenseCategory,
  currency: IDR,
  amountForeign: "",
  rate: "1",
  amountIdr: "",
  isSettled: false,
  method: "",
})

function AddExpenseForm({
  events,
  methods,
  categories,
  onAdded,
  onCancel,
  seed,
}: {
  events: EventOption[]
  methods: string[]
  categories: string[]
  onAdded: () => void
  onCancel?: () => void
  seed?: { row: OperationalExpenseRow; version: number } | null
}) {
  const [draft, setDraft] = useState(emptyDraft)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  // Duplicate: refill from the source row, but with a fresh date and unsettled
  // — it's a new expense, not the same payment recorded twice.
  useEffect(() => {
    if (!seed) return
    const r = seed.row
    setDraft({
      event: r.event,
      expenseDate: todayIso(),
      description: r.description,
      category: r.category,
      currency: inferCurrency(r, events),
      amountForeign: String(r.amountForeign),
      rate: String(r.rate),
      amountIdr: String(r.amountIdr),
      isSettled: false,
      method: r.method,
    })
    setAddError(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.version])

  const selectedEvent = events.find((e) => e.name === draft.event)
  const eventCurrency = selectedEvent?.currency || ""
  const currencyOptions = eventCurrency ? [IDR, eventCurrency] : [IDR]
  const isIdr = draft.currency === IDR

  const foreignNum = parseAmount(draft.amountForeign)
  // IDR rows: the single amount IS the rupiah. FX rows: the user enters the
  // actual rupiah paid separately, and the kurs is derived from it (IDR ÷ Valas)
  // rather than pulled from the event's marked-up country kurs.
  const idrNum = isIdr ? foreignNum : parseAmount(draft.amountIdr)
  const derivedRate = isIdr ? 1 : calcRate(idrNum, foreignNum)

  // Picking an event/currency only sets the currency now — the kurs is always
  // derived from the amounts, never pre-filled from the country.
  function pickEvent(name: string) {
    const ev = events.find((e) => e.name === name)
    setDraft((d) => ({ ...d, event: name, currency: ev?.currency || IDR }))
  }
  function pickCurrency(cur: string) {
    setDraft((d) => ({ ...d, currency: cur }))
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setAdding(true)
    setAddError(null)
    try {
      const res = await fetch("/api/sheets/operational-expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: draft.event.trim(),
          expenseDate: draft.expenseDate,
          description: draft.description.trim(),
          category: draft.category,
          amountForeign: foreignNum,
          rate: derivedRate,
          amountIdr: idrNum,
          isSettled: draft.isSettled,
          method: draft.method.trim(),
          remarks: "",
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to add")
      setDraft(emptyDraft())
      onAdded()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add")
    } finally {
      setAdding(false)
    }
  }

  return (
    <form onSubmit={handleAdd} className="rounded-t-2xl md:rounded-xl border-x border-t border-cream-border md:border bg-white p-5 pb-8 md:pb-5 flex flex-col gap-4">
      <div className="flex items-center justify-between -mx-5 px-5 border-b border-cream-border pb-3 md:mx-0 md:px-0 md:border-b-0 md:pb-0">
        <span className="text-base md:text-sm font-semibold text-foreground">Add Expense</span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Event">
          <SearchableSelect
            value={draft.event}
            onChange={pickEvent}
            options={events.map((e) => ({ value: e.name, label: e.name, meta: e.currency || IDR }))}
            placeholder="Select event…"
            clearable
            disabled={adding}
          />
        </Field>
        <Field label="Date">
          <input type="date" value={draft.expenseDate} onChange={(e) => setDraft((d) => ({ ...d, expenseDate: e.target.value }))} disabled={adding} className={`${formInputCls} h-[38px] appearance-none`} />
        </Field>
        <Field label="Expenses">
          <input value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} placeholder="Vendor / description" disabled={adding} className={formInputCls} />
        </Field>
        <Field label="Category">
          <SearchableSelect
            value={draft.category}
            onChange={(v) => setDraft((d) => ({ ...d, category: v as ExpenseCategory }))}
            options={categories.map((c) => ({ value: c, label: c }))}
            placeholder="Category…"
            allowNewValue
            alwaysShowAll
            disabled={adding}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Currency">
          <SearchableSelect
            value={draft.currency}
            onChange={pickCurrency}
            options={currencyOptions.map((c) => ({ value: c, label: c }))}
            placeholder="Currency"
            disabled={adding}
            searchable={false}
            alwaysShowAll
          />
        </Field>
        <Field label={`Amount (${draft.currency})`}>
          <input value={draft.amountForeign} onChange={(e) => setDraft((d) => ({ ...d, amountForeign: e.target.value }))} type="text" inputMode="decimal" placeholder="0" disabled={adding} className={formInputCls} />
        </Field>
        <Field label="IDR">
          <input
            value={isIdr ? draft.amountForeign : draft.amountIdr}
            onChange={(e) => setDraft((d) => ({ ...d, amountIdr: e.target.value }))}
            type="text" inputMode="decimal" placeholder="0"
            disabled={adding || isIdr}
            title={isIdr ? "IDR expense — same as the amount" : "Actual rupiah paid (used to derive the kurs)"}
            className={`${formInputCls} ${isIdr ? "bg-gray-50 text-gray-400" : ""}`}
          />
        </Field>
        <Field label="Method">
          <SearchableSelect
            value={draft.method}
            onChange={(v) => setDraft((d) => ({ ...d, method: v }))}
            options={methods.map((m) => ({ value: m, label: m }))}
            placeholder="Method…"
            allowNewValue
            disabled={adding}
          />
        </Field>
      </div>

      <div className="flex items-center justify-end gap-2">
        {addError && <p className="mr-auto text-xs text-red-500">{addError}</p>}
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={adding} className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
            Cancel
          </button>
        )}
        <button type="submit" disabled={adding} className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors">
          {adding ? "Saving…" : "Add"}
        </button>
      </div>
    </form>
  )
}

// ─── Actions (edit / delete) ─────────────────────────────────────────────────

function ExpenseActions({
  row,
  events,
  methods,
  categories,
  onUpdated,
  onDeleted,
  onDuplicate,
}: {
  row: OperationalExpenseRow
  events: EventOption[]
  methods: string[]
  categories: string[]
  onUpdated: () => void
  onDeleted: () => void
  onDuplicate: (row: OperationalExpenseRow) => void
}) {
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  async function handleDelete() {
    if (!confirm(`Delete this expense (${row.description || row.event})?`)) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/sheets/operational-expenses/${row.rowNumber}`, { method: "DELETE" })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      onDeleted()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to delete")
    } finally {
      setDeleting(false)
    }
  }

  if (editing) {
    return (
      <EditExpenseModal
        row={row}
        events={events}
        methods={methods}
        categories={categories}
        onSave={() => { onUpdated(); setEditing(false) }}
        onCancel={() => setEditing(false)}
        onDelete={() => { setEditing(false); handleDelete() }}
        onDuplicate={() => { setEditing(false); onDuplicate(row) }}
      />
    )
  }

  return (
    <div className="flex gap-2 items-center">
      <button type="button" onClick={() => { setSaveError(null); setEditing(true) }} title="Edit" className="text-gray-400 hover:text-brand transition-colors">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
        </svg>
      </button>
      <button type="button" onClick={() => onDuplicate(row)} title="Duplicate — prefill the Add form with this row" className="text-gray-400 hover:text-brand transition-colors">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>
      <button type="button" onClick={handleDelete} disabled={deleting} title="Delete" className="text-gray-400 hover:text-red-500 disabled:opacity-50 transition-colors">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </button>
      {saveError && <span className="text-xs text-red-500">{saveError}</span>}
    </div>
  )
}

// ─── Edit modal ──────────────────────────────────────────────────────────────

function EditExpenseModal({
  row,
  events,
  methods,
  categories,
  onSave,
  onCancel,
  onDelete,
  onDuplicate,
}: {
  row: OperationalExpenseRow
  events: EventOption[]
  methods: string[]
  categories: string[]
  onSave: () => void
  onCancel: () => void
  onDelete: () => void
  onDuplicate?: () => void
}) {
  const [draft, setDraft] = useState({
    event: row.event,
    expenseDate: row.expenseDate,
    description: row.description,
    category: row.category,
    currency: inferCurrency(row, events),
    amountForeign: String(row.amountForeign),
    rate: String(row.rate),
    amountIdr: String(row.amountIdr),
    isSettled: row.isSettled,
    method: row.method,
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const selectedEvent = events.find((e) => e.name === draft.event)
  const foreignCurrency = selectedEvent?.currency || (draft.currency !== IDR ? draft.currency : "")
  const currencyOptions = foreignCurrency ? [IDR, foreignCurrency] : [IDR]
  const isIdr = draft.currency === IDR

  const foreignNum = parseAmount(draft.amountForeign)
  // IDR rows: the amount IS the rupiah. FX rows: the actual rupiah paid is its
  // own input, and the kurs is derived (IDR ÷ Valas), not the country's kurs.
  const idrNum = isIdr ? foreignNum : parseAmount(draft.amountIdr)
  const derivedRate = isIdr ? 1 : calcRate(idrNum, foreignNum)

  function pickEvent(name: string) {
    const ev = events.find((e) => e.name === name)
    setDraft((d) => ({ ...d, event: name, currency: ev?.currency || IDR }))
  }
  function pickCurrency(cur: string) {
    setDraft((d) => ({ ...d, currency: cur }))
  }

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch(`/api/sheets/operational-expenses/${row.rowNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: draft.event.trim(),
          expenseDate: draft.expenseDate,
          description: draft.description.trim(),
          category: draft.category,
          amountForeign: foreignNum,
          rate: derivedRate,
          amountIdr: idrNum,
          isSettled: draft.isSettled,
          method: draft.method.trim(),
          remarks: row.remarks,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      onSave()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center md:px-4" onClick={onCancel}>
      <div className="bg-white rounded-t-2xl md:rounded-xl border-x border-t border-cream-border md:border shadow-xl p-6 pb-8 md:pb-6 w-full max-h-[90vh] overflow-y-auto flex flex-col gap-4 md:max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between -mx-6 px-6 border-b border-cream-border pb-3 md:mx-0 md:px-0 md:border-b-0 md:pb-0">
          <span className="text-base md:text-sm font-semibold text-foreground">Edit Expense</span>
          <span className="text-xs text-gray-400">ID: {row.rowNumber}</span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Event">
            <SearchableSelect
              value={draft.event}
              onChange={pickEvent}
              options={events.map((e) => ({ value: e.name, label: e.name, meta: e.currency || IDR }))}
              placeholder="Select event…"
              clearable
              disabled={saving}
            />
          </Field>
          <Field label="Date">
            <input type="date" value={draft.expenseDate} onChange={(e) => setDraft((d) => ({ ...d, expenseDate: e.target.value }))} disabled={saving} className={`${formInputCls} h-[38px] appearance-none`} />
          </Field>
          <Field label="Expenses">
            <input value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} disabled={saving} className={formInputCls} />
          </Field>
          <Field label="Category">
            <SearchableSelect
              value={draft.category}
              onChange={(v) => setDraft((d) => ({ ...d, category: v as ExpenseCategory }))}
              options={categories.map((c) => ({ value: c, label: c }))}
              placeholder="Category…"
              allowNewValue
              alwaysShowAll
              disabled={saving}
            />
          </Field>
          {/* Currency + Amount + Kurs share one 3-col row (desktop + mobile). */}
          <div className="col-span-2 grid grid-cols-3 gap-3">
            <Field label="Currency">
              <SearchableSelect
                value={draft.currency}
                onChange={pickCurrency}
                options={currencyOptions.map((c) => ({ value: c, label: c }))}
                placeholder="Currency"
                disabled={saving}
                searchable={false}
                alwaysShowAll
              />
            </Field>
            <Field label={`Amount (${draft.currency})`}>
              <input value={draft.amountForeign} onChange={(e) => setDraft((d) => ({ ...d, amountForeign: e.target.value }))} type="text" inputMode="decimal" disabled={saving} className={formInputCls} />
            </Field>
            <Field label="Kurs">
              <input
                value={isIdr ? "1" : (foreignNum > 0 && idrNum > 0 ? String(derivedRate) : "")}
                type="number" readOnly disabled placeholder="—"
                title={isIdr ? "IDR expense — kurs is always 1" : "Auto: IDR ÷ amount (the real rate paid)"}
                className={`${formInputCls} bg-gray-50 text-gray-400`}
              />
            </Field>
          </div>
          <Field label="IDR">
            <input
              value={isIdr ? draft.amountForeign : draft.amountIdr}
              onChange={(e) => setDraft((d) => ({ ...d, amountIdr: e.target.value }))}
              type="text" inputMode="decimal"
              disabled={saving || isIdr}
              title={isIdr ? "IDR expense — same as the amount" : "Actual rupiah paid (used to derive the kurs)"}
              className={`${formInputCls} ${isIdr ? "bg-gray-50 text-gray-400" : ""}`}
            />
          </Field>
          <Field label="Method">
            <SearchableSelect
              value={draft.method}
              onChange={(v) => setDraft((d) => ({ ...d, method: v }))}
              options={methods.map((m) => ({ value: m, label: m }))}
              placeholder="Method…"
              allowNewValue
              disabled={saving}
            />
          </Field>
        </div>

        <label className="hidden" title="Settled">
          <input type="checkbox" checked={draft.isSettled} onChange={(e) => setDraft((d) => ({ ...d, isSettled: e.target.checked }))} disabled={saving} className="h-4 w-4 rounded border-cream-border accent-brand" />
          <span className="text-xs text-gray-500">Settled</span>
        </label>

        {saveError && <p className="text-xs text-red-500">{saveError}</p>}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onDelete}
            disabled={saving}
            aria-label="Delete"
            className="inline-flex items-center justify-center h-[38px] border border-cream-border rounded-lg px-3 text-sm text-gray-400 hover:border-brand disabled:opacity-50 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" />
            </svg>
          </button>
          {onDuplicate && (
            <button
              type="button"
              onClick={onDuplicate}
              disabled={saving}
              aria-label="Duplicate"
              className="md:hidden inline-flex items-center justify-center h-[38px] border border-cream-border rounded-lg px-3 text-sm text-gray-400 hover:border-brand disabled:opacity-50 transition-colors"
            >
              <svg className="md:hidden" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <span className="hidden md:inline">Duplicate</span>
            </button>
          )}
          <button type="button" onClick={onCancel} disabled={saving} className="ml-auto px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
            Cancel
          </button>
          <button type="button" onClick={handleSave} disabled={saving} className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  )
}
