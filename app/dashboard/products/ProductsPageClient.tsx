"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ProductRow, CountryRow } from "@/lib/db"
import DataGrid, {
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type PaginationState,
} from "@/components/DataGrid"
import { usePaginatedFetch, type PageData } from "@/hooks/usePaginatedFetch"
import ToggleSwitch from "@/components/ToggleSwitch"
import SearchableSelect from "@/components/SearchableSelect"
import SearchInput from "@/components/SearchInput"
import { calcAbroadPrice, calcDomesticPrice, abroadProfit } from "@/lib/pricing"
import { useCopyFeedback } from "@/hooks/useCopyFeedback"
import { useProductDefaults } from "@/hooks/useProductDefaults"

const PAGE_SIZE = 25

type PricingType = "overseas" | "domestic"

const formInputCls =
  "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
const rowInputCls =
  "w-full border border-cream-border rounded-md px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors disabled:opacity-50"

const fmt = (n: number) => n.toLocaleString("id-ID")

// Shared <datalist> id for the inline store editors in the table.
const STORE_LIST_ID = "product-stores-edit-list"

// Inline copy button. Stays subtly visible (not hover-only) so it's usable on
// the mobile card too, where there's no hover. Stops propagation so it doesn't
// trigger the row/card click that opens the edit modal.
function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const { copied, copy } = useCopyFeedback()
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); copy(value) }}
      title={label}
      aria-label={label}
      className="shrink-0 p-0.5 rounded text-gray-300 hover:text-brand transition-colors"
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-600">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-gray-500">{label}</span>
      {children}
    </label>
  )
}

function defaultDomesticProfit(cost: number): number {
  if (cost >= 800_000) return Math.round(cost * 0.15)
  if (cost >= 700_000) return 80_000
  if (cost > 498_000) return 55_000
  if (cost > 398_000) return 45_000
  if (cost > 298_000) return 35_000
  if (cost > 198_000) return 25_000
  if (cost > 98_000) return 20_000
  if (cost > 28_000) return 10_000
  return 5_000
}

function isAbroad(p: ProductRow) {
  return p.countryId != null
}

// ─── Main component ────────────────────────────────────────────────────────

export default function ProductsPageClient() {
  // Current page of rows + total — both come from the server now.
  const [data, setData] = useState<ProductRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  // Dropdown data: the FULL country + distinct-store lists. These can't be
  // derived from a single page of products, so they load once from the meta
  // endpoint (a GET with no `page` param).
  const [countries, setCountries] = useState<CountryRow[]>([])
  const [stores, setStores] = useState<string[]>([])
  const [metaError, setMetaError] = useState<string | null>(null)

  // Server-side table state.
  const [sorting, setSorting] = useState<SortingState>([{ id: "id", desc: true }])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState("")
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE })

  const [addOpen, setAddOpen] = useState(false)
  const [mobileAddOpen, setMobileAddOpen] = useState(false)
  // Mobile row action sheet + the edit modal it can open — separate from
  // ProductActions' own internal edit state (which desktop's inline icons use).
  const [editingProduct, setEditingProduct] = useState<ProductRow | null>(null)
  const [mobileDeleting, setMobileDeleting] = useState(false)
  // When set, the Add form pre-fills itself from this product (Duplicate flow).
  // The Add form clears this via onConsumeSeed once it has copied the values.
  const [seedProduct, setSeedProduct] = useState<ProductRow | null>(null)
  const consumeSeed = useCallback(() => setSeedProduct(null), [])
  const handleDuplicate = useCallback((row: ProductRow) => {
    setSeedProduct(row)
    setAddOpen(true)
    // Open the mobile add sheet too — no-op on desktop (it's hidden anyway),
    // but on mobile the Add form is otherwise unreachable from a row card.
    setMobileAddOpen(true)
  }, [])

  // Load dropdown meta (countries + the full distinct store list) once.
  const loadMeta = useCallback(async () => {
    try {
      const res = await fetch("/api/sheets/products")
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to load")
      setCountries(json.countries as CountryRow[])
      setStores(json.stores as string[])
    } catch (err) {
      setMetaError(err instanceof Error ? err.message : "Failed to load")
    }
  }, [])
  useEffect(() => { loadMeta() }, [loadMeta])

  // Text column filters → server query params. Numeric/date columns aren't
  // server-filterable (their header filter inputs are disabled), so we skip them.
  const fetchFilters = useMemo<Record<string, string>>(() => {
    const f: Record<string, string> = {}
    for (const cf of columnFilters) {
      const v = String(cf.value ?? "").trim()
      if (!v) continue
      if (cf.id === "name") f.name = v
      else if (cf.id === "store") f.store = v
      else if (cf.id === "type") f.type = v
      else if (cf.id === "countryName") f.country = v
    }
    return f
  }, [columnFilters])

  const fetchSort = useMemo(() => {
    if (sorting.length === 0) return null
    return { key: sorting[0].id, direction: sorting[0].desc ? ("desc" as const) : ("asc" as const) }
  }, [sorting])

  const onData = useCallback((d: PageData) => {
    setData(d.rows as ProductRow[])
    setTotalCount(d.totalCount)
  }, [])

  const { fetchState, refresh } = usePaginatedFetch({
    endpoint: "/api/sheets/products",
    pageSize: PAGE_SIZE,
    page: pagination.pageIndex + 1,
    search: globalFilter,
    filters: fetchFilters,
    sort: fetchSort,
    onData,
  })

  // Stable ref so the row-action callbacks captured in column defs always call
  // the latest refresh.
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  // After a mutation, refetch the current page and the meta (a new product may
  // introduce a store the autocomplete hasn't seen yet).
  const reloadAll = useCallback(() => { refreshRef.current(); loadMeta() }, [loadMeta])

  // Mirrors ProductActions' own delete handler — used by the mobile action
  // sheet, which triggers Delete without mounting a ProductActions instance.
  const handleMobileDelete = useCallback(async (row: ProductRow) => {
    if (!confirm(`Delete "${row.name}"?`)) return
    setMobileDeleting(true)
    try {
      const res = await fetch(`/api/sheets/products/${row.id}`, { method: "DELETE" })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      refreshRef.current()
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete")
    } finally {
      setMobileDeleting(false)
    }
  }, [])

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

  // Inline store edit from the table. The products PUT is a full-row update, so
  // we rebuild the body from the existing row (store is independent of price)
  // and override only the store. Local data is patched so the cell reflects the
  // new value without a refetch.
  const handleStoreSave = useCallback(async (row: ProductRow, store: string) => {
    const res = await fetch(`/api/sheets/products/${row.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: row.name,
        store,
        price: row.price,
        gram: row.gram,
        countryId: row.countryId,
        valas: row.valas,
        kurs: row.kurs,
        cargoPerKg: row.cargoPerKg,
        profitPct: row.profitPct,
        operationalFee: row.operationalFee,
        packingFee: row.packingFee,
        cost: row.cost,
        profitFixed: row.profitFixed,
      }),
    })
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      throw new Error(json.error ?? "Failed to save")
    }
    setData((rows) => rows.map((r) => (r.id === row.id ? { ...r, store } : r)))
  }, [])

  // Optimistic active/inactive flip: update the page row immediately, revert if
  // the PATCH fails. Inactive products drop out of the List Order item picker.
  const handleToggleActive = useCallback(async (row: ProductRow, next: boolean) => {
    setData((rows) => rows.map((r) => (r.id === row.id ? { ...r, isActive: next } : r)))
    try {
      const res = await fetch(`/api/sheets/products/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: next }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed")
    } catch (err) {
      setData((rows) => rows.map((r) => (r.id === row.id ? { ...r, isActive: !next } : r)))
      alert(err instanceof Error ? err.message : "Failed to update")
    }
  }, [])

  // Mobile sort toggle reads/writes the `id` sort direction.
  const mobileIdDesc = (sorting.find((s) => s.id === "id")?.desc) ?? true

  const columns = useMemo<ColumnDef<ProductRow, unknown>[]>(() => [
    {
      accessorKey: "id",
      header: "ID",
      enableColumnFilter: false,
      size: 60,
    },
    {
      accessorKey: "name",
      header: "Name",
      size: 290,
      filterFn: "textContains",
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1">
          <span className="font-medium whitespace-nowrap">{row.original.name}</span>
          <CopyButton value={`${row.original.name} ${fmt(row.original.price)}`} label="Copy name & price" />
          {!row.original.isActive && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-500 border border-gray-200 whitespace-nowrap">Inactive</span>
          )}
        </span>
      ),
    },
    {
      accessorKey: "store",
      header: "Store",
      size: 120,
      filterFn: "textContains",
      cell: ({ row }) => (
        <EditableStoreCell
          row={row.original}
          listId={STORE_LIST_ID}
          onSave={(store) => handleStoreSave(row.original, store)}
        />
      ),
    },
    {
      accessorKey: "price",
      header: "Price",
      size: 110,
      filterFn: "numeric",
      enableColumnFilter: false,
      cell: ({ row }) => <span className="tabular-nums font-medium">{fmt(row.original.price)}</span>,
      meta: { align: "right" },
    },
    {
      id: "type",
      header: "Type",
      size: 100,
      accessorFn: (row) => isAbroad(row) ? "Profit Margin" : "Tier Rp",
      filterFn: "textContains",
      cell: ({ row }) => {
        const abroad = isAbroad(row.original)
        return (
          <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${abroad ? "bg-blue-50 text-blue-600" : "bg-green-50 text-green-600"}`}>
            {abroad ? "Profit Margin" : "Tier Rp"}
          </span>
        )
      },
    },
    {
      accessorKey: "countryName",
      header: "Country",
      size: 70,
      enableSorting: false,
      filterFn: "textContains",
      cell: ({ row }) => <span className="text-gray-600">{row.original.countryName || "—"}</span>,
    },
    {
      accessorKey: "valas",
      header: "Valas",
      size: 90,
      filterFn: "numeric",
      enableColumnFilter: false,
      cell: ({ row }) => <span className="tabular-nums">{isAbroad(row.original) ? fmt(row.original.valas) : "—"}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "gram",
      header: "Gram",
      size: 90,
      filterFn: "numeric",
      enableColumnFilter: false,
      cell: ({ row }) => <span className="tabular-nums">{row.original.gram ? fmt(row.original.gram) : "—"}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "kurs",
      header: "Kurs",
      size: 90,
      filterFn: "numeric",
      enableColumnFilter: false,
      cell: ({ row }) => <span className="tabular-nums">{isAbroad(row.original) ? fmt(row.original.kurs) : "—"}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "cargoPerKg",
      header: "Cargo/kg",
      size: 100,
      filterFn: "numeric",
      enableColumnFilter: false,
      cell: ({ row }) => <span className="tabular-nums">{isAbroad(row.original) ? fmt(row.original.cargoPerKg) : "—"}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "profitPct",
      header: "%",
      size: 70,
      filterFn: "numeric",
      enableColumnFilter: false,
      cell: ({ row }) => <span className="tabular-nums">{isAbroad(row.original) ? `${row.original.profitPct}%` : "—"}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "operationalFee",
      header: "Op Fee",
      size: 100,
      filterFn: "numeric",
      enableColumnFilter: false,
      cell: ({ row }) => <span className="tabular-nums">{isAbroad(row.original) ? fmt(row.original.operationalFee) : "—"}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "packingFee",
      header: "Pack Fee",
      size: 100,
      filterFn: "numeric",
      enableColumnFilter: false,
      cell: ({ row }) => <span className="tabular-nums">{isAbroad(row.original) ? fmt(row.original.packingFee) : "—"}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "cost",
      header: "Base Cost",
      size: 110,
      filterFn: "numeric",
      enableColumnFilter: false,
      cell: ({ row }) => <span className="tabular-nums">{!isAbroad(row.original) ? fmt(row.original.cost) : "—"}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "profitFixed",
      header: "Fixed Profit",
      size: 110,
      filterFn: "numeric",
      enableColumnFilter: false,
      cell: ({ row }) => <span className="tabular-nums">{!isAbroad(row.original) ? fmt(row.original.profitFixed) : "—"}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "createdAt",
      header: "Created",
      size: 110,
      enableColumnFilter: false,
    },
    {
      accessorKey: "updatedAt",
      header: "Updated",
      size: 110,
      enableColumnFilter: false,
    },
    {
      id: "active",
      header: "Active",
      size: 90,
      enableSorting: false,
      enableColumnFilter: false,
      enableHiding: false,
      cell: ({ row }) => (
        <ToggleSwitch
          checked={row.original.isActive}
          onChange={(next) => handleToggleActive(row.original, next)}
          label={`Toggle ${row.original.name} active`}
        />
      ),
    },
    {
      id: "actions",
      header: "",
      size: 80,
      enableSorting: false,
      enableColumnFilter: false,
      enableHiding: false,
      cell: ({ row }) => (
        <ProductActions
          row={row.original}
          countries={countries}
          stores={stores}
          onUpdated={() => refreshRef.current()}
          onDeleted={() => refreshRef.current()}
          onDuplicate={handleDuplicate}
        />
      ),
    },
  ], [countries, stores, handleDuplicate, handleStoreSave, handleToggleActive])

  const errorMsg = fetchState.error || metaError

  return (
    <div className="flex flex-col gap-6">
      {errorMsg && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{errorMsg}</div>
      )}

      {/* Desktop table — server-side paginated */}
      <div className="hidden md:block">
        {/* Shared autocomplete source for the inline store editors. */}
        <datalist id={STORE_LIST_ID}>
          {stores.map((s) => <option key={s} value={s} />)}
        </datalist>
        <DataGrid
          data={data}
          columns={columns}
          getRowId={(row) => String(row.id)}
          searchPlaceholder="Search name, store, country…"
          fullWidthSearch
          tightToolbar
          boldUppercaseHeader
          toolbarExtraAfterColumns
          hideRowCount
          belowToolbar={
            addOpen ? (
              <AddProductForm
                countries={countries}
                stores={stores}
                onAdded={reloadAll}
                onCancel={() => setAddOpen(false)}
                seed={seedProduct}
                onConsumeSeed={consumeSeed}
              />
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
              Add Product
            </button>
          }
          initialVisibility={{
            id: false,
            type: false,
            kurs: false,
            cargoPerKg: false,
            operationalFee: false,
            packingFee: false,
            cost: false,
            profitFixed: false,
            createdAt: false,
            updatedAt: false,
          }}
          rowClassName={(row) => (row.isActive ? "" : "opacity-60")}
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
            placeholder="Search products or store…"
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
          <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-gray-400">{fetchState.loading ? "Loading…" : "No products"}</div>
        )}
        {data.map((p) => {
          const abroad = isAbroad(p)
          return (
            <div
              key={p.id}
              onClick={() => setEditingProduct(p)}
              className={`rounded-xl border border-cream-border bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] cursor-pointer active:bg-cream/40 transition-colors ${p.isActive ? "" : "opacity-60"}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-foreground text-sm uppercase">{p.store || "—"}</div>
                  <div className="text-sm text-foreground flex items-start gap-1 mt-2">
                    <span className="min-w-0 break-words">{p.name}</span>
                    <CopyButton value={`${p.name} ${fmt(p.price)}`} label="Copy name & price" />
                    {!p.isActive && (
                      <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-500 border border-gray-200">Inactive</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 mt-2.5 pt-2.5 border-t border-cream-border">
                <span className="text-xs text-gray-400 min-w-0 truncate">
                  {[
                    abroad ? (countries.find((c) => c.id === p.countryId)?.currency || "—") + (p.valas ? ` ${fmt(p.valas)}` : "") : "",
                    p.gram ? `${fmt(p.gram)} GR` : "",
                  ].filter(Boolean).join(" · ")}
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-sm font-semibold text-foreground tabular-nums whitespace-nowrap">Rp {fmt(p.price)}</span>
                  <ToggleSwitch
                    checked={p.isActive}
                    onChange={(next) => handleToggleActive(p, next)}
                    label={`Toggle ${p.name} active`}
                  />
                </div>
              </div>
            </div>
          )
        })}
        {totalCount > PAGE_SIZE && (
          <div className="flex items-center justify-between gap-3 pt-1">
            <button type="button" disabled={pagination.pageIndex === 0} onClick={() => setPagination((p) => ({ ...p, pageIndex: p.pageIndex - 1 }))} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm text-gray-600 disabled:opacity-40">Prev</button>
            <span className="text-xs text-gray-400">Page {pagination.pageIndex + 1} of {Math.max(1, Math.ceil(totalCount / PAGE_SIZE))}</span>
            <button type="button" disabled={(pagination.pageIndex + 1) * PAGE_SIZE >= totalCount} onClick={() => setPagination((p) => ({ ...p, pageIndex: p.pageIndex + 1 }))} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm text-gray-600 disabled:opacity-40">Next</button>
          </div>
        )}
      </div>

      {/* Mobile row action sheet */}
      {editingProduct && (
        <EditProductModal
          row={editingProduct}
          countries={countries}
          stores={stores}
          onSave={() => { refreshRef.current(); setEditingProduct(null) }}
          onCancel={() => setEditingProduct(null)}
          onDelete={() => { const r = editingProduct; setEditingProduct(null); handleMobileDelete(r) }}
          onDuplicate={() => { const r = editingProduct; setEditingProduct(null); handleDuplicate(r) }}
        />
      )}

      {/* Mobile add FAB */}
      <button
        type="button"
        onClick={() => setMobileAddOpen(true)}
        aria-label="Add product"
        className="md:hidden fixed right-4 bottom-20 z-30 w-14 h-14 rounded-full bg-brand text-white text-3xl leading-none shadow-lg flex items-center justify-center active:bg-brand/90"
      >
        +
      </button>

      {/* Mobile add sheet */}
      {mobileAddOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/40 flex flex-col justify-end" onClick={() => setMobileAddOpen(false)}>
          <div className="max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <AddProductForm
              countries={countries}
              stores={stores}
              onAdded={() => { setMobileAddOpen(false); reloadAll(); window.scrollTo({ top: 0, behavior: "smooth" }) }}
              onCancel={() => setMobileAddOpen(false)}
              seed={seedProduct}
              onConsumeSeed={consumeSeed}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Add form ──────────────────────────────────────────────────────────────

function AddProductForm({
  countries,
  stores,
  onAdded,
  onCancel,
  seed,
  onConsumeSeed,
}: {
  countries: CountryRow[]
  stores: string[]
  onAdded: () => void
  onCancel?: () => void
  seed?: ProductRow | null
  onConsumeSeed?: () => void
}) {
  const [type, setType] = useState<PricingType>("overseas")
  const [name, setName] = useState("")
  const [store, setStore] = useState("")
  const [countryId, setCountryId] = useState<number | null>(countries[0]?.id ?? null)
  const [valas, setValas] = useState("")
  const [gram, setGram] = useState("")
  const [profitPct, setProfitPct] = useState("30")
  const [opFee, setOpFee] = useState("5000")
  const [packFee, setPackFee] = useState("5000")
  const [cost, setCost] = useState("")
  const [profitFixed, setProfitFixed] = useState("")
  const [profitManual, setProfitManual] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  // Settings-configured defaults (profit % / operational fee / packing fee)
  // replace the hardcoded "30"/"5000"/"5000" once fetched — but only if the
  // user hasn't started a duplicate flow (seed) in the meantime.
  const productDefaults = useProductDefaults()
  const defaultsAppliedRef = useRef(false)
  useEffect(() => {
    if (defaultsAppliedRef.current || !productDefaults || seed) return
    defaultsAppliedRef.current = true
    setProfitPct(String(productDefaults.profitPct))
    setOpFee(String(productDefaults.operationalFee))
    setPackFee(String(productDefaults.packingFee))
  }, [productDefaults, seed])

  // Duplicate flow: when a seed product arrives, copy its fields into local
  // state, scroll the form into view, and focus the name. We pre-fill the
  // name as-is — the user must edit it before saving (UNIQUE(name, store)),
  // which is intentional so they don't accidentally create a near-duplicate.
  // onConsumeSeed clears the parent state so re-clicking the same row's
  // Duplicate button still re-fires this effect.
  useEffect(() => {
    if (!seed) return
    const abroad = seed.countryId != null
    setType(abroad ? "overseas" : "domestic")
    setName(seed.name)
    setStore(seed.store ?? "")
    setGram(String(seed.gram ?? 0))
    if (abroad) {
      setCountryId(seed.countryId)
      setValas(String(seed.valas ?? 0))
      setProfitPct(String(seed.profitPct ?? 0))
      setOpFee(String(seed.operationalFee ?? 5000))
      setPackFee(String(seed.packingFee ?? 5000))
    } else {
      setCost(String(seed.cost ?? 0))
      setProfitFixed(String(seed.profitFixed ?? 0))
      setProfitManual(true)
    }
    setAddError(null)
    onConsumeSeed?.()
    // Defer scroll/focus to after layout so the form is visible first.
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
      nameRef.current?.focus()
      nameRef.current?.select()
    })
  }, [seed, onConsumeSeed])

  const selectedCountry = countries.find((c) => c.id === countryId)

  const pricePreview = useMemo(() => {
    if (type === "overseas") {
      const { cogs, price } = calcAbroadPrice({
        valas: Number(valas) || 0,
        kurs: selectedCountry?.kurs ?? 0,
        gram: Number(gram) || 0,
        cargoPerKg: selectedCountry?.cargoPerKg ?? 0,
        profitPct: Number(profitPct) || 0,
        operationalFee: Number(opFee) || 0,
        packingFee: Number(packFee) || 0,
      })
      return { cogs, price }
    }
    const price = calcDomesticPrice(Number(cost) || 0, Number(profitFixed) || 0)
    return { cogs: 0, price }
  }, [type, valas, gram, profitPct, opFee, packFee, cost, profitFixed, selectedCountry])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setAdding(true)
    setAddError(null)
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        store: store.trim(),
        price: pricePreview.price,
        gram: Number(gram) || 0,
      }

      if (type === "overseas") {
        body.countryId = countryId
        body.valas = Number(valas) || 0
        body.kurs = selectedCountry?.kurs ?? 0
        body.cargoPerKg = selectedCountry?.cargoPerKg ?? 0
        body.profitPct = Number(profitPct) || 0
        body.operationalFee = Number(opFee) || 0
        body.packingFee = Number(packFee) || 0
      } else {
        body.cost = Number(cost) || 0
        body.profitFixed = Number(profitFixed) || 0
      }

      const res = await fetch("/api/sheets/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to add")

      setName("")
      setStore("")
      setValas("")
      setGram("")
      setProfitPct(String(productDefaults?.profitPct ?? 30))
      setCost("")
      setProfitFixed("")
      setProfitManual(false)
      onAdded()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add")
    } finally {
      setAdding(false)
    }
  }

  return (
    <form ref={formRef} onSubmit={handleAdd} className="rounded-t-2xl md:rounded-xl border-x border-t border-cream-border md:border bg-white p-5 pb-8 md:pb-5 flex flex-col gap-4 scroll-mt-14">
      <div className="flex items-center gap-4 -mx-5 px-5 border-b border-cream-border pb-3 md:mx-0 md:px-0 md:border-b-0 md:pb-0">
        <span className="text-base md:text-sm font-semibold text-foreground">Add Product</span>
        <div className="flex rounded-lg border border-cream-border overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => setType("overseas")}
            className={`px-3 py-1 transition-colors ${type === "overseas" ? "bg-brand text-white font-medium" : "bg-white text-gray-600 hover:bg-cream"}`}
          >
            Profit Margin
          </button>
          <button
            type="button"
            onClick={() => setType("domestic")}
            className={`px-3 py-1 transition-colors ${type === "domestic" ? "bg-brand text-white font-medium" : "bg-white text-gray-600 hover:bg-cream"}`}
          >
            Tier Rp
          </button>
        </div>
      </div>

      {type === "domestic" ? (
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <Field label="Product Name">
              <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="Product name" required disabled={adding} className={formInputCls} />
            </Field>
          </div>
          <Field label="Gram">
            <input value={gram} onChange={(e) => setGram(e.target.value)} type="number" min="0" placeholder="0" disabled={adding} className={formInputCls} />
          </Field>
        </div>
      ) : (
        <Field label="Product Name">
          <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="Product name" required disabled={adding} className={formInputCls} />
        </Field>
      )}

      {type === "domestic" ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Store">
            <SearchableSelect
              value={store}
              onChange={setStore}
              options={stores.map((s) => ({ value: s, label: s }))}
              placeholder="Select or type store…"
              allowNewValue
              disabled={adding}
            />
          </Field>
          <Field label="Base Cost (IDR)">
            <input
              value={cost}
              onChange={(e) => {
                const v = e.target.value
                setCost(v)
                if (!profitManual) {
                  setProfitFixed(String(defaultDomesticProfit(Number(v) || 0)))
                }
              }}
              type="number" min="0" placeholder="0" disabled={adding} className={formInputCls}
            />
          </Field>
        </div>
      ) : (
        <Field label="Store">
          <SearchableSelect
            value={store}
            onChange={setStore}
            options={stores.map((s) => ({ value: s, label: s }))}
            placeholder="Select or type store…"
            allowNewValue
            disabled={adding}
          />
        </Field>
      )}

      {type === "overseas" && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Country">
              <SearchableSelect
                value={countryId != null ? String(countryId) : ""}
                onChange={(v) => setCountryId(v ? Number(v) : null)}
                options={countries.map((c) => ({ value: String(c.id), label: `${c.name} (${c.currency})` }))}
                placeholder="Select country…"
                disabled={adding}
                searchable={false}
                alwaysShowAll
              />
            </Field>
            <Field label="Valas">
              <input value={valas} onChange={(e) => setValas(e.target.value)} type="number" step="any" min="0" placeholder="0" disabled={adding} className={formInputCls} />
            </Field>
            <Field label="Gram">
              <input value={gram} onChange={(e) => setGram(e.target.value)} type="number" min="0" placeholder="0" disabled={adding} className={formInputCls} />
            </Field>
            <Field label="Profit %">
              <input value={profitPct} onChange={(e) => setProfitPct(e.target.value)} type="number" min="0" max="99" placeholder="30" disabled={adding} className={formInputCls} />
            </Field>
          </div>

          <div className="grid grid-cols-4 gap-3">
            <Field label="Op Fee">
              <input value={opFee} onChange={(e) => setOpFee(e.target.value)} type="number" min="0" placeholder="5000" disabled={adding} className={formInputCls} />
            </Field>
            <Field label="Pack Fee">
              <input value={packFee} onChange={(e) => setPackFee(e.target.value)} type="number" min="0" placeholder="5000" disabled={adding} className={formInputCls} />
            </Field>
            <div className="col-span-2">
              <Field label="Price">
                <div className={`${formInputCls} bg-gray-50 text-gray-500 flex items-center`}>Rp {fmt(pricePreview.price)}</div>
              </Field>
            </div>
          </div>

          {selectedCountry && (
            <div className="flex items-center justify-between gap-1 flex-nowrap whitespace-nowrap rounded-lg bg-gray-50 border border-cream-border px-3 py-3 text-[9px] md:text-xs text-gray-500">
              <span>RATE: {fmt(selectedCountry.kurs)}</span>
              <span>SHIPPING/KG: {fmt(selectedCountry.cargoPerKg)}</span>
              <span>COGS: {fmt(Math.round(pricePreview.cogs))}</span>
              <span className="text-green-700 font-semibold">
                PROFIT: Rp {fmt(abroadProfit({ price: pricePreview.price, cogs: pricePreview.cogs, operationalFee: Number(opFee) || 0, packingFee: Number(packFee) || 0 }))}
              </span>
            </div>
          )}
        </>
      )}

      {type === "domestic" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fixed Profit (IDR)">
            <input
              value={profitFixed}
              onChange={(e) => { setProfitFixed(e.target.value); setProfitManual(true) }}
              type="number" min="0" placeholder="0" disabled={adding} className={formInputCls}
            />
          </Field>
          <Field label="Price">
            <div className={`${formInputCls} bg-gray-50 text-gray-500 flex items-center`}>Rp {fmt(pricePreview.price)}</div>
          </Field>
        </div>
      )}

      <div className="flex items-center justify-end">
        <div className="flex items-center gap-2">
          {addError && <p className="text-xs text-red-500">{addError}</p>}
          {onCancel && (
            <button type="button" onClick={onCancel} disabled={adding} className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={adding}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {adding ? "Saving…" : "Add"}
          </button>
        </div>
      </div>
    </form>
  )
}

// ─── Inline store cell ─────────────────────────────────────────────────────

// Owner/admin inline edit of a product's store directly in the table. Shows the
// full store text (never cropped); click it to switch to an input. Saves on
// blur/Enter, reverts on Escape or on a failed save (e.g. UNIQUE(name, store)
// collision, whose error is surfaced via the title).
function EditableStoreCell({ row, listId, onSave }: {
  row: ProductRow
  listId: string
  onSave: (store: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(row.store ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function commit() {
    const next = draft.trim()
    setEditing(false)
    if (next === (row.store ?? "").trim()) {
      setError(null)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      setDraft(row.store ?? "")
    } finally {
      setSaving(false)
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => { setDraft(row.store ?? ""); setEditing(true) }}
        title={error ?? "Click to edit"}
        disabled={saving}
        className={`w-full text-left rounded px-2 py-0.5 -mx-2 whitespace-nowrap transition-colors hover:bg-cream disabled:opacity-50 ${
          error ? "text-red-700" : row.store ? "text-foreground" : "text-gray-300"
        }`}
      >
        {saving ? "Saving…" : <span className="uppercase">{row.store || "—"}</span>}
      </button>
    )
  }

  return (
    <input
      type="text"
      list={listId}
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur()
        if (e.key === "Escape") {
          setDraft(row.store ?? "")
          setEditing(false)
        }
      }}
      placeholder="—"
      className="w-full min-w-[8rem] bg-white border border-brand px-2 py-0.5 rounded focus:outline-none"
    />
  )
}

// ─── Product actions (edit/delete) ─────────────────────────────────────────

function ProductActions({
  row,
  countries,
  stores,
  onUpdated,
  onDeleted,
  onDuplicate,
}: {
  row: ProductRow
  countries: CountryRow[]
  stores: string[]
  onUpdated: (data: Partial<ProductRow>) => void
  onDeleted: () => void
  onDuplicate: (row: ProductRow) => void
}) {
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  async function handleDelete() {
    if (!confirm(`Delete "${row.name}"?`)) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/sheets/products/${row.id}`, { method: "DELETE" })
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
      <EditProductModal
        row={row}
        countries={countries}
        stores={stores}
        onSave={(updated) => { onUpdated(updated); setEditing(false) }}
        onCancel={() => setEditing(false)}
        onDelete={handleDelete}
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
      <button type="button" onClick={() => onDuplicate(row)} title="Duplicate" className="text-gray-400 hover:text-brand transition-colors">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
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

// ─── Edit modal ────────────────────────────────────────────────────────────

function EditProductModal({
  row,
  countries,
  stores,
  onSave,
  onCancel,
  onDelete,
  onDuplicate,
}: {
  row: ProductRow
  countries: CountryRow[]
  stores: string[]
  onSave: (updated: Partial<ProductRow>) => void
  onCancel: () => void
  onDelete?: () => void
  onDuplicate?: () => void
}) {
  const [draft, setDraft] = useState({
    name: row.name,
    store: row.store,
    countryId: row.countryId,
    valas: String(row.valas),
    gram: String(row.gram),
    profitPct: String(row.profitPct),
    opFee: String(row.operationalFee),
    packFee: String(row.packingFee),
    cost: String(row.cost),
    profitFixed: String(row.profitFixed),
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const draftCountry = countries.find((c) => c.id === draft.countryId)
  const draftAbroad = draft.countryId != null

  // Live price + per-unit COGS + profit. Profit (overseas) = price − COGS − fees,
  // matching the Add form's preview.
  const editCalc = useMemo<{ price: number; cogs: number | null; profit: number | null }>(() => {
    if (draftAbroad) {
      const { cogs, price } = calcAbroadPrice({
        valas: Number(draft.valas) || 0,
        kurs: draftCountry?.kurs ?? row.kurs,
        gram: Number(draft.gram) || 0,
        cargoPerKg: draftCountry?.cargoPerKg ?? row.cargoPerKg,
        profitPct: Number(draft.profitPct) || 0,
        operationalFee: Number(draft.opFee) || 0,
        packingFee: Number(draft.packFee) || 0,
      })
      const profit = abroadProfit({ price, cogs, operationalFee: Number(draft.opFee) || 0, packingFee: Number(draft.packFee) || 0 })
      return { price, cogs: Math.round(cogs), profit }
    }
    return { price: calcDomesticPrice(Number(draft.cost) || 0, Number(draft.profitFixed) || 0), cogs: null, profit: null }
  }, [draft, draftAbroad, draftCountry, row.kurs, row.cargoPerKg])

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    try {
      const body: Record<string, unknown> = {
        name: draft.name.trim(),
        store: draft.store.trim(),
        price: editCalc.price,
        gram: Number(draft.gram) || 0,
        countryId: draft.countryId,
        valas: draftAbroad ? Number(draft.valas) || 0 : 0,
        kurs: draftAbroad ? (draftCountry?.kurs ?? row.kurs) : 0,
        cargoPerKg: draftAbroad ? (draftCountry?.cargoPerKg ?? row.cargoPerKg) : 0,
        profitPct: draftAbroad ? Number(draft.profitPct) || 0 : 0,
        operationalFee: draftAbroad ? Number(draft.opFee) || 0 : 5000,
        packingFee: draftAbroad ? Number(draft.packFee) || 0 : 5000,
        cost: draftAbroad ? 0 : Number(draft.cost) || 0,
        profitFixed: draftAbroad ? 0 : Number(draft.profitFixed) || 0,
      }

      const res = await fetch(`/api/sheets/products/${row.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")

      onSave({
        name: draft.name.trim(),
        store: draft.store.trim(),
        price: editCalc.price,
        gram: Number(draft.gram) || 0,
        countryId: draft.countryId,
        countryName: draftCountry?.name ?? "",
        valas: Number(body.valas) || 0,
        kurs: Number(body.kurs) || 0,
        cargoPerKg: Number(body.cargoPerKg) || 0,
        profitPct: Number(body.profitPct) || 0,
        operationalFee: Number(body.operationalFee) || 0,
        packingFee: Number(body.packingFee) || 0,
        cost: Number(body.cost) || 0,
        profitFixed: Number(body.profitFixed) || 0,
      })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  // Price/COGS/Profit readout — sits in the empty grid cell next to Pack Fee /
  // Base Cost rather than crowding the button row.
  const calcSummary = (
    <div className="self-end inline-flex flex-col gap-0.5 rounded-lg border border-cream-border px-4 py-2 text-sm">
      <div>
        <span className="text-gray-500">Price: </span>
        <span className="font-semibold text-foreground">Rp {fmt(editCalc.price)}</span>
      </div>
      {editCalc.cogs != null && (
        <div>
          <span className="text-gray-500">COGS: </span>
          <span className="font-semibold text-foreground">Rp {fmt(editCalc.cogs)}</span>
        </div>
      )}
      {editCalc.profit != null && (
        <div>
          <span className="text-gray-500">Profit: </span>
          <span className="font-semibold text-green-700">Rp {fmt(editCalc.profit)}</span>
        </div>
      )}
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center md:px-4" onClick={onCancel}>
      <div className="bg-white rounded-t-2xl md:rounded-xl border-x border-t border-cream-border md:border shadow-xl p-6 pb-8 md:pb-6 w-full max-h-[90vh] overflow-y-auto flex flex-col gap-4 md:max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between -mx-6 px-6 border-b border-cream-border pb-3 md:mx-0 md:px-0 md:border-b-0 md:pb-0">
          <span className="text-base md:text-sm font-semibold text-foreground">Edit Product</span>
          <span className="text-xs text-gray-400">ID: {row.id}</span>
        </div>

        <Field label="Name">
          <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} disabled={saving} className={formInputCls} />
        </Field>

        <Field label="Store">
          <SearchableSelect
            value={draft.store}
            onChange={(v) => setDraft((d) => ({ ...d, store: v }))}
            options={stores.map((s) => ({ value: s, label: s }))}
            placeholder="Store…"
            allowNewValue
            disabled={saving}
          />
        </Field>
        {draftAbroad ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              <SearchableSelect
                value={draft.countryId != null ? String(draft.countryId) : ""}
                onChange={(v) => setDraft((d) => ({ ...d, countryId: v ? Number(v) : null }))}
                options={countries.map((c) => ({ value: String(c.id), label: `${c.name} (${c.currency})` }))}
                placeholder="Domestic"
                disabled={saving}
                searchable={false}
                clearable
                alwaysShowAll
              />
            </Field>
            <Field label="Valas">
              <input value={draft.valas} onChange={(e) => setDraft((d) => ({ ...d, valas: e.target.value }))} type="number" step="any" min="0" disabled={saving} className={formInputCls} />
            </Field>
          </div>
        ) : (
          <Field label="Type">
            <SearchableSelect
              value={draft.countryId != null ? String(draft.countryId) : ""}
              onChange={(v) => setDraft((d) => ({ ...d, countryId: v ? Number(v) : null }))}
              options={countries.map((c) => ({ value: String(c.id), label: `${c.name} (${c.currency})` }))}
              placeholder="Domestic"
              disabled={saving}
              searchable={false}
              clearable
              alwaysShowAll
            />
          </Field>
        )}

        {draftAbroad ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Gram">
                <input value={draft.gram} onChange={(e) => setDraft((d) => ({ ...d, gram: e.target.value }))} type="number" min="0" disabled={saving} className={formInputCls} />
              </Field>
              <Field label="Profit %">
                <input value={draft.profitPct} onChange={(e) => setDraft((d) => ({ ...d, profitPct: e.target.value }))} type="number" min="0" max="99" disabled={saving} className={formInputCls} />
              </Field>
            </div>

            <div className="grid grid-cols-4 gap-3">
              <Field label="Op Fee">
                <input
                  value={draft.opFee}
                  type="number"
                  disabled
                  readOnly
                  title="Locked — set when the product is created. Re-create the product to change this."
                  className={`${formInputCls} bg-gray-50 text-gray-400 cursor-not-allowed`}
                />
              </Field>
              <Field label="Pack Fee">
                <input
                  value={draft.packFee}
                  type="number"
                  disabled
                  readOnly
                  title="Locked — set when the product is created. Re-create the product to change this."
                  className={`${formInputCls} bg-gray-50 text-gray-400 cursor-not-allowed`}
                />
              </Field>
              <div className="col-span-2">
                <Field label="Price">
                  <div className={`${formInputCls} bg-gray-50 text-gray-500 flex items-center`}>Rp {fmt(editCalc.price)}</div>
                </Field>
              </div>
            </div>

            {draftCountry && (
              <div className="flex items-center justify-between gap-1 flex-nowrap whitespace-nowrap rounded-lg bg-gray-50 border border-cream-border px-3 py-3 text-[8px] md:text-[9px] text-gray-500">
                <span>RATE: {fmt(draftCountry.kurs)}</span>
                <span>SHIPPING/KG: {fmt(draftCountry.cargoPerKg)}</span>
                <span>COGS: Rp {fmt(editCalc.cogs ?? 0)}</span>
                <span className="text-green-700 font-semibold">PROFIT: Rp {fmt(editCalc.profit ?? 0)}</span>
              </div>
            )}
          </>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Base Cost">
              <input value={draft.cost} onChange={(e) => setDraft((d) => ({ ...d, cost: e.target.value }))} type="number" min="0" disabled={saving} className={formInputCls} />
            </Field>
            <Field label="Fixed Profit">
              <input value={draft.profitFixed} onChange={(e) => setDraft((d) => ({ ...d, profitFixed: e.target.value }))} type="number" min="0" disabled={saving} className={formInputCls} />
            </Field>
            <Field label="Gram">
              <input value={draft.gram} onChange={(e) => setDraft((d) => ({ ...d, gram: e.target.value }))} type="number" min="0" disabled={saving} className={formInputCls} />
            </Field>
            {calcSummary}
          </div>
        )}

        <div className="flex items-center pt-2">
          <div className="flex items-center gap-2 w-full">
            {saveError && <p className="text-xs text-red-500">{saveError}</p>}
            {onDelete && (
              <button type="button" onClick={onDelete} disabled={saving} aria-label="Delete" className="inline-flex items-center justify-center h-[38px] border border-cream-border rounded-lg px-3 text-sm text-gray-400 hover:border-brand disabled:opacity-50 transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" />
                </svg>
              </button>
            )}
            {onDuplicate && (
              <button type="button" onClick={onDuplicate} disabled={saving} aria-label="Duplicate" className="md:hidden inline-flex items-center justify-center h-[38px] border border-cream-border rounded-lg px-3 text-sm text-gray-400 hover:border-brand disabled:opacity-50 transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              </button>
            )}
            <button type="button" onClick={onCancel} disabled={saving} className="ml-auto px-3 py-1.5 rounded-lg border border-cream-border text-gray-500 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
              Cancel
            </button>
            <button type="button" onClick={handleSave} disabled={saving} className="px-4 py-1.5 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors">
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
