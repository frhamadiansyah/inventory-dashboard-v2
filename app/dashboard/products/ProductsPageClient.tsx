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
import {
  calcAbroadPrice, calcRupiahFeePrice, abroadProfit, calcKursPrice, kursProfit,
  calcFlatFeeValasPrice, flatFeeAmount, flatFeeFloorApplies, landedCost, type FlatFeeMode,
  calcTierFeeValasPrice,
  PRICING_METHOD_LABEL, isKursMethod, type PricingMethod,
} from "@/lib/pricing"
import { resolveTieredKurs, resolveFlatKurs, tiersForCountry } from "@/lib/kurs-tiers"
import {
  resolveTierFee, resolveRupiahTierFee, bracketsForScope, DEFAULT_RUPIAH_TIER_FEE_BRACKETS,
} from "@/lib/tier-fee"
import { useKursTiers } from "@/hooks/useKursTiers"
import { useTierFeeBrackets } from "@/hooks/useTierFeeBrackets"
import TierFeePopover from "./TierFeePopover"
import KursTierPopover from "./KursTierPopover"
import { useCopyFeedback } from "@/hooks/useCopyFeedback"
import { useProductDefaults } from "@/hooks/useProductDefaults"
import { useLiveIdrRate, markupRate } from "@/hooks/useLiveIdrRate"
import { DEFAULT_PRODUCT_DEFAULTS } from "@/lib/product-defaults"

const PAGE_SIZE = 25

// Flat Fee gets no tab of its own: it lives inside Tier Fee behind the Fee toggle,
// because the two differ in one thing only — whether the fee comes from the brackets or
// from the single Settings value. They stay SEPARATE pricing_method values in the
// database (migration 052), because that difference decides who has authority over the
// fee, so this is a grouping of the picker and nothing more.
const METHOD_TABS: readonly PricingMethod[] = ["overseas", "tier_fee", "tier_kurs"]
const isFeeMethod = (m: PricingMethod) => m === "tier_fee" || m === "flat_fee"


const formInputCls =
  "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
const rowInputCls =
  "w-full border border-cream-border rounded-md px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors disabled:opacity-50"

const fmt = (n: number) => n.toLocaleString("id-ID")
// For rates rather than amounts: a markup rate like 114,81 loses its meaning rounded
// to a whole rupiah.
const fmtRp2 = (n: number) => n.toLocaleString("id-ID", { maximumFractionDigits: 2 })

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

/** `action` puts something — in practice an info popover — beside the label rather
 *  than beside the input, so it never eats into the input's width.
 *
 *  The wrapper is h-4, exactly text-xs's 1rem line-height, so the label line keeps
 *  its height whatever goes in it — anything taller overflows symmetrically rather
 *  than growing the line, and nothing clips it. That matters because sibling fields
 *  in a row align on their label line: let this one grow and its input drops below
 *  its neighbours'.
 *
 *  Without `action` the markup is byte-identical to what it always was. */
function Field({ label, action, children }: {
  label: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      {action ? (
        <span className="flex items-center gap-1.5 h-4">
          <span className="text-xs font-medium text-gray-500">{label}</span>
          {action}
        </span>
      ) : (
        <span className="text-xs font-medium text-gray-500">{label}</span>
      )}
      {children}
    </label>
  )
}

// Keyed on pricing_method rather than `countryId != null` (migration 050): a Tier
// Kurs product HAS a country — it needs the FX link for valas and the actual rate —
// but must not use the overseas formula or show its inputs.
function isAbroad(p: ProductRow) {
  return p.pricingMethod === "overseas"
}

/** True for either Rate method. Both book freight into cost and both snapshot the rate they
 *  were charged at onto products.tiered_kurs, so the two columns gated on this are true of
 *  the pair rather than of the bracketed one alone. */
function isKursProduct(p: ProductRow) {
  return isKursMethod(p.pricingMethod)
}

/** True for a row priced from a rupiah base cost plus a rupiah fee — which since
 *  migrations 056/057 is BOTH fee methods, in either of their modes:
 *
 *    no country  the base cost is typed, the fee is rupiah.
 *    a country   the base cost is landed cost (valas × kurs + freight) and the fee is
 *                still rupiah; the server derives the cost and stores it, so the column
 *                holds a real figure rather than the 0 the rupiah modes' absent field
 *                would leave.
 *
 *  Both land in products.cost and products.profit_fixed, so both read out the same way.
 *  The superseded shape gave a valas-mode Markup row a foreign-currency fee in its own
 *  column, which is why this used to exclude it. */
function usesRupiahCost(p: ProductRow) {
  return p.pricingMethod === "flat_fee" || p.pricingMethod === "tier_fee"
}

/** True for the methods that CANNOT price without a country. Tier Fee is absent on
 *  purpose: a country is optional there, and whether it has one is exactly what
 *  chooses between its rupiah and valas modes. */
function methodNeedsCountry(m: PricingMethod) {
  // Both Rate methods resolve their charged rate from the country — brackets for one, the
  // country's flat rate for the other — so neither has a domestic form. This is the opposite
  // of the fee pair, where Flat CLEARS the country because its fee is a rupiah setting.
  return m === "overseas" || isKursMethod(m)
}

/** Every method may now carry a country, so what a country MEANS is the only thing that
 *  varies: overseas and tier_kurs require one, while tier_fee and flat_fee use its
 *  presence to pick between a rupiah base cost and a foreign-currency one. Callers key on
 *  `countryId != null` rather than on the method for anything currency-related. */

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

  // Mobile-only filter sheet: store (searchable) + valas/gram blank-or-filled.
  const [filterOpen, setFilterOpen] = useState(false)
  const [mStore, setMStore] = useState("")
  const [mValas, setMValas] = useState<"" | "filled" | "blank">("")
  const [mGram, setMGram] = useState<"" | "filled" | "blank">("")
  const mobileFilterCount = [mStore, mValas, mGram].filter(Boolean).length

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
    // Mobile filter sheet (store overrides any desktop store column filter).
    if (mStore) f.store = mStore
    if (mValas) f.valas = mValas
    if (mGram) f.gram = mGram
    return f
  }, [columnFilters, mStore, mValas, mGram])

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
  // Mobile filter sheet changes also reset to page 1.
  useEffect(() => { setPagination((p) => ({ ...p, pageIndex: 0 })) }, [mStore, mValas, mGram])

  // Inline store edit from the table. The products PUT is a full-row update, so
  // we rebuild the body from the existing row (store is independent of price)
  // and override only the store. Local data is patched so the cell reflects the
  // new value without a refetch.
  const handleStoreSave = useCallback(async (row: ProductRow, store: string) => {
    const res = await fetch(`/api/sheets/products/${row.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      // PUT is a full-row update, so every field has to be resent even though only
      // `store` changed. pricingMethod and countryId are sent explicitly rather
      // than left to the server's keep-if-absent fallback. tieredKurs is NOT sent:
      // the server re-resolves it from the brackets, and sending a value would imply
      // the client had a say in it. countryId matters precisely because both lookups
      // key on it — and for Tier Fee it also picks the mode.
      body: JSON.stringify({
        name: row.name,
        store,
        price: row.price,
        gram: row.gram,
        pricingMethod: row.pricingMethod,
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
      // accessorFn receives the row DATA, not a Row wrapper.
      accessorFn: (row) => PRICING_METHOD_LABEL[row.pricingMethod],
      filterFn: "textContains",
      cell: ({ row }) => {
        const method = row.original.pricingMethod
        const tone: Record<PricingMethod, string> = {
          overseas: "bg-blue-50 text-blue-600",
          tier_fee: "bg-green-50 text-green-600",
          flat_fee: "bg-amber-50 text-amber-700",
          tier_kurs: "bg-purple-50 text-purple-600",
          // One step from its sibling: the pair reads as a family without the two being
          // mistakable for each other at a glance down the column.
          flat_kurs: "bg-violet-50 text-violet-600",
        }
        return (
          <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${tone[method]}`}>
            {PRICING_METHOD_LABEL[method]}
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
      cell: ({ row }) => <span className="tabular-nums">{row.original.pricingMethod !== "tier_fee" ? fmt(row.original.valas) : "—"}</span>,
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
      cell: ({ row }) => <span className="tabular-nums">{row.original.pricingMethod !== "tier_fee" ? fmt(row.original.kurs) : "—"}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "tieredKurs",
      header: "Tier Rate",
      size: 100,
      filterFn: "numeric",
      enableColumnFilter: false,
      // Only Tier Kurs rows have one; the rest store NULL.
      cell: ({ row }) => (
        <span className="tabular-nums">
          {isKursProduct(row.original) && row.original.tieredKurs != null
            ? fmt(row.original.tieredKurs)
            : "—"}
        </span>
      ),
      meta: { align: "right" },
    },
    {
      accessorKey: "cargoPerKg",
      header: "Cargo/kg",
      size: 100,
      filterFn: "numeric",
      enableColumnFilter: false,
      // Tier Kurs books freight into its cost too, so its rate is no longer a dash.
      cell: ({ row }) => <span className="tabular-nums">{isAbroad(row.original) || isKursProduct(row.original) ? fmt(row.original.cargoPerKg) : "—"}</span>,
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
      cell: ({ row }) => <span className="tabular-nums">{usesRupiahCost(row.original) ? fmt(row.original.cost) : "—"}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "profitFixed",
      header: "Fee",
      size: 110,
      filterFn: "numeric",
      enableColumnFilter: false,
      // One unit throughout: rupiah. Every fee-bearing row snapshots its fee onto
      // profit_fixed, valas-mode Markup included — this used to read a separate
      // foreign-currency fee column for those, which no longer exists.
      cell: ({ row }) => {
        const p = row.original
        if (usesRupiahCost(p)) return <span className="tabular-nums">{fmt(p.profitFixed)}</span>
        return <span className="tabular-nums">—</span>
      },
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
            tieredKurs: false,
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
          <button
            type="button"
            onClick={() => setFilterOpen(true)}
            aria-label="Filter products"
            className={`relative shrink-0 inline-flex items-center justify-center w-[42px] rounded-lg border bg-white active:border-brand active:text-brand ${mobileFilterCount > 0 ? "border-brand text-brand" : "border-cream-border text-gray-600"}`}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
            </svg>
            {mobileFilterCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-brand text-white text-[10px] font-bold flex items-center justify-center">{mobileFilterCount}</span>
            )}
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

      {/* Mobile filter sheet */}
      {filterOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/40 flex flex-col justify-end" onClick={() => setFilterOpen(false)}>
          <div className="bg-white rounded-t-2xl border-t border-cream-border p-5 pb-8 flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <div className="text-base font-semibold text-foreground">Filter products</div>
              <button type="button" onClick={() => { setMStore(""); setMValas(""); setMGram("") }} className="text-xs text-gray-400 hover:text-brand">Clear all</button>
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500">Store</span>
              <SearchableSelect
                value={mStore}
                onChange={setMStore}
                options={stores.map((s) => ({ value: s, label: s }))}
                placeholder="Any store"
                clearable
              />
            </label>

            {([["valas", "Valas / IDR", mValas, setMValas] as const, ["gram", "Gram", mGram, setMGram] as const]).map(([key, label, val, set]) => (
              <div key={key} className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">{label}</span>
                <div className="flex rounded-lg border border-cream-border overflow-hidden text-sm">
                  {([["", "Any"], ["filled", "Has value"], ["blank", "Blank"]] as const).map(([v, t]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => set(v)}
                      className={`flex-1 px-2 py-2 font-medium transition-colors ${val === v ? "bg-brand text-white" : "text-gray-500 hover:bg-cream"}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            <button type="button" onClick={() => setFilterOpen(false)} className="mt-1 px-4 py-2.5 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 transition-colors">
              Done
            </button>
          </div>
        </div>
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
          {/* Fixed height, not max-height: the four methods have quite different field
              counts, so a content-sized sheet jumped its top edge every time the tab
              changed. h-[80vh] holds the tallest of them without scrolling and the
              shortest without looking empty, and the inner scroll picks up the rest.

              h-, not min-h-: a min-height still grows for a taller tab, which is the jump
              this is meant to remove.

              The wrapper carries the sheet's own surface — bg-white and the rounded top —
              because the form inside is shorter than 80vh on the smaller tabs, and without
              it the overlay showed through below the form. */}
          <div
            className="h-[80vh] overflow-y-auto bg-white rounded-t-2xl border-t border-cream-border"
            onClick={(e) => e.stopPropagation()}
          >
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
  const [type, setType] = useState<PricingMethod>("overseas")
  const [name, setName] = useState("")
  const [store, setStore] = useState("")
  // Starts empty and is set from product_defaults.default_country_id by the effect below. It
  // used to initialise to countries[0] — the alphabetically first country, which moved whenever
  // one was renamed. Migration 052 seeded that same country as the default, so the field lands
  // where it always did until the owner picks another.
  const [countryId, setCountryId] = useState<number | null>(null)
  const [valas, setValas] = useState("")
  const [gram, setGram] = useState("")
  const [profitPct, setProfitPct] = useState("30")
  const [opFee, setOpFee] = useState("5000")
  const [packFee, setPackFee] = useState("5000")
  const [cost, setCost] = useState("")
  const [profitFixed, setProfitFixed] = useState("")
  const [profitManual, setProfitManual] = useState(false)
  /** Flat Fee only: whether its fee is the fixed Settings amount or a share of base cost
   *  (migration 054). Stored per row, so it is form state rather than a setting. */
  const [flatFeeMode, setFlatFeeMode] = useState<FlatFeeMode>("fixed")
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  // Settings-configured defaults (profit % / operational fee / packing fee)
  // replace the hardcoded "30"/"5000"/"5000" once fetched — but only if the
  // user hasn't started a duplicate flow (seed) in the meantime.
  const productDefaults = useProductDefaults()
  const { tiers: kursTiers } = useKursTiers()

  // Suggested rupiah fee for a Tier Fee product with no country, from the owner's
  // brackets (Settings → Pricing) rather than the table that used to be hardcoded
  // here.
  //
  // Falls back to the pre-migration defaults only while the fetch is in flight, so a
  // fast typist gets the same suggestion they always did. Once `brackets` is non-null
  // an empty set means an empty set — the owner is allowed to turn suggestions off,
  // and this must not overrule that.
  const { brackets: tierFeeBrackets } = useTierFeeBrackets()

  // Tier Fee prices in rupiah or in a country's currency. The mode is STORED as
  // whether the row has a country (migration 053), but the form needs it before a
  // country has been picked, so it is explicit state here and countryId follows it.
  // No separate rupiah/valas flag: `countryId == null` IS rupiah mode in the stored row
  // (migration 053), and the Country field offers "IDR (Rupiah)" as an option, so the
  // control the user touches and the value that decides the formula are the same thing.
  // A flag alongside it could only ever disagree with it.
  const tierFeeValas = type === "tier_fee" && countryId != null
  const tierFeeRupiah = type === "tier_fee" && countryId == null
  // Flat Fee gained the same split: with a country the base is bought in valas and the
  // rupiah cost is derived (converted goods + freight); without one it is typed.
  const flatFeeValas = type === "flat_fee" && countryId != null
  const flatFeeRupiah = type === "flat_fee" && countryId == null
  /** Either fee method priced in foreign currency: no typed Base Cost, and Gram belongs
   *  in the header row beside Product Name. */
  const valasFeeForm = tierFeeValas || flatFeeValas
  // Rows whose base cost and fee are both rupiah.
  // Which forms show a TYPED rupiah Base Cost. The valas modes show a derived one.
  const rupiahCostForm = tierFeeRupiah || flatFeeRupiah

  // Scoped brackets for whichever mode is active, and the fee they yield.
  // Which of the two rupiah sets applies. Both are shared — the valas one across every
  // country (migrations 056/057) — so no country is needed to pick it, and the old
  // "no country yet, no scope" case is gone.
  const scopedFeeBrackets = tierFeeBrackets
    ? bracketsForScope(tierFeeBrackets, tierFeeValas ? "valas" : "rupiah")
    : null

  const suggestRupiahFee = (cost: number) =>
    resolveRupiahTierFee(
      tierFeeBrackets ? bracketsForScope(tierFeeBrackets, "rupiah") : DEFAULT_RUPIAH_TIER_FEE_BRACKETS,
      cost,
    )


  // Set once, when the settings arrive. The ref is what makes it once-only: without it, every
  // refetch would overwrite whatever the user had typed.
  //
  // It is also set by the duplicate effect below, which is load-bearing. Both this and the
  // duplicate populate the same fields, and the duplicate can win the race — a user who clicks
  // Duplicate before this fetch resolves had their copied profit %, fees and country silently
  // replaced by the Settings values a moment later. Consuming the seed clears it, so the `seed`
  // guard alone does not prevent that.
  const defaultsAppliedRef = useRef(false)
  useEffect(() => {
    if (defaultsAppliedRef.current || !productDefaults || seed) return
    defaultsAppliedRef.current = true
    setProfitPct(String(productDefaults.profitPct))
    setOpFee(String(productDefaults.operationalFee))
    setPackFee(String(productDefaults.packingFee))
    // null is a real value here — "start on IDR (Rupiah)" — so it is assigned as-is rather than
    // falling back to a country.
    setCountryId(productDefaults.defaultCountryId)
  }, [productDefaults, seed])

  // Duplicate flow: when a seed product arrives, copy its fields into local
  // state, scroll the form into view, and focus the name. We pre-fill the
  // name as-is — the user must edit it before saving (UNIQUE(name, store)),
  // which is intentional so they don't accidentally create a near-duplicate.
  // onConsumeSeed clears the parent state so re-clicking the same row's
  // Duplicate button still re-fires this effect.
  useEffect(() => {
    if (!seed) return
    // Copy the method straight off the seed. Re-deriving it from countryId would
    // silently turn a duplicated Tier Kurs product into an Overseas one.
    // A duplicate is fully populated, so the Settings defaults must not be applied over it —
    // see defaultsAppliedRef above. Set here rather than in a cleanup, because the seed is
    // consumed immediately below and the flag has to outlive it.
    defaultsAppliedRef.current = true
    setType(seed.pricingMethod)
    setName(seed.name)
    setStore(seed.store ?? "")
    setGram(String(seed.gram ?? 0))
    // Every method copies the country and the valas — a country is legal on all four, and it is
    // what puts the two fee methods in valas mode.
    setCountryId(seed.countryId)
    setValas(String(seed.valas ?? 0))

    // A switch, not an if/else chain: this has to name every method, and a chain would let a
    // fifth one fall through to whatever the last branch happened to be. The `never` makes that
    // a compile error instead.
    switch (seed.pricingMethod) {
      case "overseas":
        setProfitPct(String(seed.profitPct ?? 0))
        setOpFee(String(seed.operationalFee ?? 5000))
        setPackFee(String(seed.packingFee ?? 5000))
        break
      case "tier_kurs":
      case "flat_kurs":
        // The pack fee is part of both methods' price — ceil(valas × rate + packFee) — so a
        // duplicate that dropped it repriced itself against the Settings default.
        //
        // The RATE is deliberately not copied for either: the server re-resolves it, from
        // the duplicated valas for Tier and from the country for Flat, so a stale snapshot
        // must not ride along.
        setPackFee(String(seed.packingFee ?? 5000))
        break
      case "tier_fee":
        // Rupiah mode is the no-country case, and only it has a typed base cost and a typed
        // fee. In valas mode both are derived server-side, so copying them would imply this
        // form had a say in them.
        if (seed.countryId == null) {
          setCost(String(seed.cost ?? 0))
          setProfitFixed(String(seed.profitFixed ?? 0))
          setProfitManual(true)
        }
        break
      case "flat_fee":
        // The percent flag comes along because it decides how the fee is expressed. The fee
        // itself is one Settings figure the server re-reads, so it is never copied. Cost is
        // re-derived from valas in valas mode, which makes copying it a rupiah-mode concern.
        setFlatFeeMode(seed.flatFeeMode)
        setCost(String(seed.cost ?? 0))
        break
      default: {
        // Unreachable by construction; `void` rather than a return, because anything an effect
        // returns is treated as its cleanup function.
        const exhaustive: never = seed.pricingMethod
        void exhaustive
      }
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

  // The rate this valas will actually be charged. Recomputed as the valas is typed,
  // so the preview jumps the moment it crosses a bracket floor. The server
  // re-resolves it on save — this is presentation only.
  // Matched against the DERIVED base cost, in rupiah, which is what the shared set keys on.
  //
  // Math.round because the server rounds before it resolves, and a fee is a STEP function of
  // this number: a base sitting half a rupiah below a bracket floor picks the bracket below
  // it here and the one above it there, so the preview would show a fee — and a price — the
  // save then contradicts. Rounding both sides is what makes them the same number.
  const valasBase = tierFeeValas
    ? Math.round(landedCost({
        valas: Number(valas) || 0,
        kurs: selectedCountry?.kurs ?? 0,
        gram: Number(gram) || 0,
        cargoPerKg: selectedCountry?.cargoPerKg ?? 0,
      }))
    : 0
  const valasFee = tierFeeValas ? resolveRupiahTierFee(scopedFeeBrackets ?? [], valasBase) : 0

  // Both Rate methods book cost at the country's MARKUP RATE — the live mid-market rate plus
  // product_defaults.markup_pct — not at the stored countries.kurs. That stored figure is
  // hand-entered from this same calculation (see the Live rate / Markup rate boxes on the
  // Countries page), so it is only ever as fresh as the last time someone typed it.
  //
  // It falls back to the stored rate whenever there is no live one: a third-party endpoint
  // being reachable must not decide whether a product can be saved. `costRateIsLive` says
  // which of the two is in play, so the readout can never be ambiguous about it.
  //
  // Declared ABOVE chargedKurs, which reads costRate during render. Below it, the flat
  // branch would hit the temporal dead zone — see 9eda039, where exactly that shape threw
  // "Cannot access 'Q' before initialization" on every Tier Kurs edit.
  const { rate: liveRate, loading: liveRateLoading } = useLiveIdrRate(selectedCountry?.currency ?? "")
  const liveMarkupRate = markupRate(liveRate, productDefaults?.markupPct ?? DEFAULT_PRODUCT_DEFAULTS.markupPct)
  const costRate = liveMarkupRate ?? selectedCountry?.kurs ?? 0
  const costRateIsLive = liveMarkupRate != null

  // The rate this valas will be charged, for whichever Rate method is selected.
  //
  // The flat fallback is costRate, not selectedCountry.kurs, and it must be: the server
  // resolves against body.kurs — the snapshot this form is about to send — so anything else
  // would preview a spread the save then removes. The tiered branch below still falls back to
  // selectedCountry.kurs, which is that same mismatch; widening it would move the preview for
  // every bracket-less country, which is a repricing decision rather than a cleanup.
  const chargedKurs = useMemo(
    () => {
      if (!selectedCountry) return 0
      if (type === "flat_kurs") return resolveFlatKurs(selectedCountry.flatKurs, costRate)
      return resolveTieredKurs(
        tiersForCountry(kursTiers, selectedCountry.id),
        Number(valas) || 0,
        selectedCountry.kurs,
      )
    },
    [kursTiers, selectedCountry, valas, type, costRate],
  )

  // The Flat Fee method's fee. Settings owns BOTH figures and the server re-reads them on
  // save, so this is only ever used to render the preview.
  //
  // In percent mode the fee depends on the base cost, so it is derived from whichever base
  // this mode uses — the typed rupiah cost, or the landed cost in valas mode. That is the
  // same base the server will resolve it from.
  // Rounded for the same reason as valasBase: in percent mode the server takes its cut of
  // the ROUNDED cost, and the floor comparison keys on the result.
  const flatFeeBase = flatFeeValas ? Math.round(landedCost({
    valas: Number(valas) || 0,
    kurs: selectedCountry?.kurs ?? 0,
    gram: Number(gram) || 0,
    cargoPerKg: selectedCountry?.cargoPerKg ?? 0,
  })) : Number(cost) || 0
  const flatFeePctSetting = productDefaults?.flatFeePct ?? DEFAULT_PRODUCT_DEFAULTS.flatFeePct
  const flatFeeMinSetting = productDefaults?.flatFeeMin ?? DEFAULT_PRODUCT_DEFAULTS.flatFeeMin
  const flatFee = flatFeeAmount(
    flatFeeMode,
    flatFeeBase,
    productDefaults?.flatFee ?? DEFAULT_PRODUCT_DEFAULTS.flatFee,
    flatFeePctSetting,
    flatFeeMinSetting,
  )
  /** True when the floor set the fee rather than the percentage — the readout says which. */
  const flatFeeFloored = flatFeeFloorApplies(flatFeeMode, flatFeeBase, flatFeePctSetting, flatFeeMinSetting)

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
        roundTo: productDefaults?.profitMarginRoundTo ?? DEFAULT_PRODUCT_DEFAULTS.profitMarginRoundTo,
      })
      return { cogs, price }
    }
    // Both Rate methods, one branch: the formula is identical and only chargedKurs above
    // knows which rate it resolved.
    if (isKursMethod(type)) {
      return calcKursPrice({
        valas: Number(valas) || 0,
        chargedKurs,
        // The markup rate, not the stored country rate — see costRate.
        kurs: costRate,
        gram: Number(gram) || 0,
        cargoPerKg: selectedCountry?.cargoPerKg ?? 0,
        packingFee: Number(packFee) || 0,
        roundTo: productDefaults?.tierKursRoundTo ?? DEFAULT_PRODUCT_DEFAULTS.tierKursRoundTo,
      })
    }
    if (tierFeeValas) {
      return calcTierFeeValasPrice({
        valas: Number(valas) || 0,
        kurs: selectedCountry?.kurs ?? 0,
        gram: Number(gram) || 0,
        cargoPerKg: selectedCountry?.cargoPerKg ?? 0,
        fee: valasFee,
        roundTo: productDefaults?.tierKursRoundTo ?? DEFAULT_PRODUCT_DEFAULTS.tierKursRoundTo,
      })
    }
    if (flatFeeValas) {
      return calcFlatFeeValasPrice({
        valas: Number(valas) || 0,
        kurs: selectedCountry?.kurs ?? 0,
        gram: Number(gram) || 0,
        cargoPerKg: selectedCountry?.cargoPerKg ?? 0,
        fee: flatFee,
      })
    }
    if (type === "flat_fee") {
      // The fee comes from Settings, not the form, and the server re-reads it on
      // save — so this preview can disagree with the stored price only if the
      // setting changes between load and save.
      const base = Number(cost) || 0
      return { cogs: base, price: calcRupiahFeePrice(base, flatFee) }
    }
    // Rupiah-mode Tier Fee. cogs is the typed base cost — it used to return 0 here, which
    // was harmless while nothing read it, but the readout below does now.
    const base = Number(cost) || 0
    return { cogs: base, price: calcRupiahFeePrice(base, Number(profitFixed) || 0) }
  }, [type, valas, gram, profitPct, opFee, packFee, cost, profitFixed, selectedCountry,
      chargedKurs, costRate, productDefaults, flatFee, tierFeeValas, valasFee])

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
        pricingMethod: type,
        // Sent for every method: the column is only read for flat_fee, and sending it
        // unconditionally keeps this out of the per-method branches below.
        flatFeeMode,
      }

      if (type === "overseas") {
        body.countryId = countryId
        body.valas = Number(valas) || 0
        body.kurs = selectedCountry?.kurs ?? 0
        body.cargoPerKg = selectedCountry?.cargoPerKg ?? 0
        body.profitPct = Number(profitPct) || 0
        body.operationalFee = Number(opFee) || 0
        body.packingFee = Number(packFee) || 0
      } else if (isKursMethod(type)) {
        // No tieredKurs and no price: the server resolves the rate itself — from the
        // brackets for Tier, from the country's flat rate for Flat — and ignores anything
        // sent for either. countryId is what it keys the lookup on, for both.
        body.countryId = countryId
        body.valas = Number(valas) || 0
        // The markup rate, snapshotted. products.kurs has always been a save-time
        // snapshot, and storing it here is what keeps a row's COGS reproducible later
        // without the server or the products table needing the live endpoint.
        body.kurs = costRate
        // Snapshotted like kurs, and for the same reason: freight is part of this
        // method's cost now, so the rate it was costed at has to live on the row or
        // the COGS readout stops being reproducible when a country's rate changes.
        body.cargoPerKg = selectedCountry?.cargoPerKg ?? 0
        // Part of the price now, so it is stored per row rather than left to the route's
        // 5000 default — otherwise the price is not reproducible from the row.
        body.packingFee = Number(packFee) || 0
      } else if (tierFeeValas) {
        // No fee and no meaningful price: the server resolves the bracket fee
        // from countryId and valas, and ignores anything sent for either.
        body.countryId = countryId
        body.valas = Number(valas) || 0
        body.kurs = selectedCountry?.kurs ?? 0
        // Freight is part of this method's cost now, so the rate it was costed at has to
        // live on the row — cost itself is derived, not stored, for these products.
        body.cargoPerKg = selectedCountry?.cargoPerKg ?? 0
      } else if (flatFeeValas) {
        // No profitFixed, no price and no cost: the server reads the flat fee from
        // product_defaults and derives the rupiah cost from these four, so anything sent
        // for the other three is ignored.
        body.countryId = countryId
        body.valas = Number(valas) || 0
        body.kurs = selectedCountry?.kurs ?? 0
        body.cargoPerKg = selectedCountry?.cargoPerKg ?? 0
      } else if (type === "flat_fee") {
        // No profitFixed and no meaningful price: the server reads the flat fee
        // from product_defaults and ignores anything sent for either.
        body.cost = Number(cost) || 0
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

  // The three fields every method shows, hoisted because each method arranges them
  // in a different grid and only one of those grids renders at a time. Written out
  // per branch they were duplicated twice already; Tier Kurs pulling Gram up into
  // its header row would have made three copies.
  const nameField = (
    <Field label="Product Name">
      <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="Product name" required disabled={adding} className={formInputCls} />
    </Field>
  )
  const storeField = (
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
  )
  const gramField = (
    <Field label="Gram">
      <input value={gram} onChange={(e) => setGram(e.target.value)} type="number" min="0" placeholder="0" disabled={adding} className={formInputCls} />
    </Field>
  )
  // Where the fee comes from, which is the whole difference between tier_fee and
  // flat_fee: Tier looks it up from the brackets, Flat takes the one value in Settings
  // and lets the server resolve it. Flat clears the country and forces rupiah — its fee
  // is a single rupiah setting, so it has no valas form to be in.
  //
  // Hoisted because it renders in two places depending on mode: beside Base Cost in the
  // header grid whenever there IS a Base Cost, and back down with the Priced-in toggle
  // in valas mode, where there is no rupiah cost row to sit in.
  const feeSourceToggle = (
    <Field label="Fee">
      {/* py-2.5 puts the toggle at the same 38px as the Country and Base Cost inputs
          beside it. Both are border + padding + line-height:
            input   2 + ( 8+ 8) + 20 (text-sm)
            toggle  2 + (10+10) + 16 (text-xs)
          Its smaller text is what has to be paid back in padding — same arithmetic as
          readoutBar's md:py-2.5. */}
      {/* No self-start at either breakpoint: the toggle fills its grid cell, so it lines up
          with the field beside it instead of leaving a gap before Country. flex-1 on the
          buttons splits that width evenly between Tier and Flat. */}
      <div className="flex rounded-lg border border-cream-border overflow-hidden text-xs">
        <button
          type="button"
          onClick={() => setType("tier_fee")}
          disabled={adding}
          className={`flex-1 px-3 py-2.5 transition-colors ${type === "tier_fee" ? "bg-brand text-white font-medium" : "bg-white text-gray-600 hover:bg-cream"}`}
        >
          Tier
        </button>
        <button
          type="button"
          onClick={() => { setType("flat_fee"); setCountryId(null) }}
          disabled={adding}
          className={`flex-1 px-3 py-2.5 transition-colors ${type === "flat_fee" ? "bg-brand text-white font-medium" : "bg-white text-gray-600 hover:bg-cream"}`}
        >
          Flat
        </button>
      </div>
    </Field>
  )

  // Where the charged rate comes from, which is the whole difference between tier_kurs and
  // flat_kurs: Tier looks it up from that country's brackets, Flat takes the country's one
  // configured rate. Both are re-resolved by the server on save.
  //
  // Unlike feeSourceToggle above, NEITHER side touches the country — both methods need one,
  // because a rate is meaningless without a currency to be a rate for. The fee pair's Flat
  // clears it, which is the opposite. The two toggles look identical and behave differently
  // on purpose.
  const rateSourceToggle = (
    <Field label="Rate">
      <div className="flex rounded-lg border border-cream-border overflow-hidden text-xs">
        <button
          type="button"
          onClick={() => setType("tier_kurs")}
          disabled={adding}
          className={`flex-1 px-3 py-2.5 transition-colors ${type === "tier_kurs" ? "bg-brand text-white font-medium" : "bg-white text-gray-600 hover:bg-cream"}`}
        >
          Tier
        </button>
        <button
          type="button"
          onClick={() => setType("flat_kurs")}
          disabled={adding}
          className={`flex-1 px-3 py-2.5 transition-colors ${type === "flat_kurs" ? "bg-brand text-white font-medium" : "bg-white text-gray-600 hover:bg-cream"}`}
        >
          Flat
        </button>
      </div>
    </Field>
  )

  // The Country field doubles as the rupiah/valas switch, which is why there is no
  // "Priced in" toggle: "IDR (Rupiah)" is a real option whose value is "", and that maps
  // straight onto countryId null — the stored row's own definition of rupiah mode. One
  // control, one source of truth.
  //
  // Not `clearable`: clearing would land on the same state as picking IDR, so the × would
  // be a second, unlabelled way to do the same thing.
  const countrySelect = (
    <Field label="Country">
      <SearchableSelect
        value={countryId != null ? String(countryId) : ""}
        onChange={(v) => setCountryId(v ? Number(v) : null)}
        options={[
          { value: "", label: "IDR (Rupiah)" },
          ...countries.map((c) => ({ value: String(c.id), label: `${c.name} (${c.currency})` })),
        ]}
        placeholder="IDR (Rupiah)"
        disabled={adding}
        searchable={false}
        alwaysShowAll
      />
    </Field>
  )

  // A × or = sitting between two fields, on the inputs' line rather than the labels'.
  //
  // Built as a Field with a non-breaking-space label so it carries the same label line
  // and gap-1 every real field has, and the box repeats formInputCls's vertical metrics
  // (py-2, a transparent 1px border). Alignment is then structural: every child of the
  // row has an identical top structure, so items-start lands them all on the same line
  // with no centering offset to hardcode.
  //
  // The label must be U+00A0, not a plain space: an ASCII space is collapsible, which
  // would leave that line with no height and drop the glyph a label's worth too high.
  // The grey RATE / COST / PROFIT bar, one per method. Hoisted because each renders in
  // two places at two breakpoints: among the fields on mobile, and inside the button row
  // on desktop, where there is spare width to the left of Cancel.
  //
  // A Record over PricingMethod rather than an if-chain, so a fifth method cannot
  // quietly ship without one — it fails to compile until an entry exists, even if that
  // entry is null.
  // md:py-2.5 makes the desktop bar exactly as tall as the Cancel button beside it.
  // Both are border + padding + line-height, and they land on the same 38px:
  //   button   2 + (8+8)   + 20 (text-sm)
  //   bar      2 + (10+10) + 16 (text-xs)
  // The bar's smaller text is what has to be paid back in padding. Mobile keeps py-3,
  // where the bar stands alone with no button to match.
  const readoutBar = (children: React.ReactNode) => (
    <div className="flex items-center justify-between gap-1 flex-nowrap whitespace-nowrap rounded-lg bg-gray-50 border border-cream-border px-3 py-3 md:py-2.5 text-[9px] md:text-xs text-gray-500">
      {children}
    </div>
  )
  const profitTone = (n: number) => `font-semibold ${n >= 0 ? "text-green-700" : "text-red-600"}`

  // No profit %, no cargo, no fees: the margin is the spread between the charged rate and
  // the actual one. Shared by BOTH Rate methods — their cost side is identical, and only
  // where chargedKurs came from differs — so it is one node assigned to two keys rather
  // than a copy that would be a second thing to keep in step.
  const kursReadout = selectedCountry
    ? readoutBar(
        <>
          {/* The rate cost is actually booked at. Labelled "STORED" on the fallback path
              so it is never unclear which of the two rates produced COST. */}
          <span>
            {liveRateLoading ? "MARKUP RATE: …" : (
              <>
                MARKUP RATE: Rp {fmtRp2(costRate)}
                {!costRateIsLive && <span className="text-amber-700"> (stored)</span>}
              </>
            )}
          </span>
          {/* Cost carries a freight term now, so the rate behind it has to be visible —
              otherwise COST is an unexplained number. Same span the overseas readout has
              always had. */}
          <span>SHIPPING/KG: {fmt(selectedCountry.cargoPerKg)}</span>
          <span>COST: {fmt(Math.round(pricePreview.cogs))}</span>
          {/* No PACK FEE span: it is an editable field in the row above, so repeating it
              here was the only duplicated figure in any of these bars. Still SUBTRACTED
              from profit below, as the overseas readout does with its two fees — the
              charge is recovered through the price, not margin. One consequence worth
              knowing: price − COST will exceed PROFIT by the pack fee. */}
          <span className={profitTone(kursProfit({ ...pricePreview, packingFee: Number(packFee) || 0 }))}>
            PROFIT: Rp {fmt(kursProfit({ ...pricePreview, packingFee: Number(packFee) || 0 }))}
          </span>
        </>,
      )
    : null

  const readouts: Record<PricingMethod, React.ReactNode> = {
    overseas: selectedCountry
      ? readoutBar(
          <>
            <span>RATE: {fmt(selectedCountry.kurs)}</span>
            <span>SHIPPING/KG: {fmt(selectedCountry.cargoPerKg)}</span>
            <span>COGS: {fmt(Math.round(pricePreview.cogs))}</span>
            {/* Unconditionally green, unlike the others: left as it was rather than
                switched to profitTone, which would be a behaviour change nobody asked
                for. The overseas formula can only go negative via a profit % ≥ 100,
                which it already refuses. */}
            <span className="text-green-700 font-semibold">
              PROFIT: Rp {fmt(abroadProfit({ price: pricePreview.price, cogs: pricePreview.cogs, operationalFee: Number(opFee) || 0, packingFee: Number(packFee) || 0 }))}
            </span>
          </>,
        )
      : null,

    tier_kurs: kursReadout,
    flat_kurs: kursReadout,

    // Two shapes, because the modes have different inputs: valas mode has a rate and a
    // converted fee to account for, rupiah mode is just cost + the typed fee. Both end in
    // COST and PROFIT, so the bar reads the same way whichever is showing.
    tier_fee: tierFeeValas
      ? selectedCountry
        ? readoutBar(
            <>
              <span>RATE: {fmt(selectedCountry.kurs)}</span>
              <span>SHIPPING/KG: {fmt(selectedCountry.cargoPerKg)}</span>
              <span>FEE: {fmt(Math.round(valasFee))}</span>
              <span>COST: {fmt(Math.round(pricePreview.cogs))}</span>
              <span className={profitTone(pricePreview.price - pricePreview.cogs)}>
                PROFIT: Rp {fmt(Math.round(pricePreview.price - pricePreview.cogs))}
              </span>
            </>,
          )
        : null
      : readoutBar(
          <>
            <span>COST: {fmt(Math.round(pricePreview.cogs))}</span>
            <span>FEE: {fmt(Number(profitFixed) || 0)}</span>
            {/* price − cost is exactly the typed fee here, so this is not a second
                calculation of the same thing — it is the same number, labelled as what it
                means. */}
            <span className={profitTone(pricePreview.price - pricePreview.cogs)}>
              PROFIT: Rp {fmt(Math.round(pricePreview.price - pricePreview.cogs))}
            </span>
          </>,
        ),

    flat_fee: readoutBar(
      <>
        {/* Only in valas mode is there a rate or a freight charge behind COST. */}
        {flatFeeValas && selectedCountry && (
          <>
            <span>RATE: {fmt(selectedCountry.kurs)}</span>
            <span>SHIPPING/KG: {fmt(selectedCountry.cargoPerKg)}</span>
          </>
        )}
        <span>COST: {fmt(Math.round(pricePreview.cogs))}</span>
        <span>
          FEE: {fmt(flatFee)}
          {/* Naming the percentage when the FLOOR produced the number would explain it
              wrongly, so the bar names whichever figure actually applied. */}
          {flatFeeMode === "percent" && (flatFeeFloored ? " (min)" : ` (${fmtRp2(flatFeePctSetting)}%)`)}
        </span>
        <span className={profitTone(flatFee)}>PROFIT: Rp {fmt(flatFee)}</span>
      </>,
    ),
  }
  const readout = readouts[type]

  const operator = (glyph: string) => (
    <Field label={" "}>
      <span className="border border-transparent px-1 py-2 text-sm text-gray-400 flex items-center justify-center select-none">
        {glyph}
      </span>
    </Field>
  )

  return (
    <form ref={formRef} onSubmit={handleAdd} className="rounded-t-2xl md:rounded-xl border-x border-t border-cream-border md:border bg-white p-5 pb-8 md:pb-5 flex flex-col gap-4 scroll-mt-14">
      <div className="flex items-center gap-4 -mx-5 px-5 border-b border-cream-border pb-3 md:mx-0 md:px-0 md:border-b-0 md:pb-0">
        <span className="text-base md:text-sm font-semibold text-foreground">Add Product</span>
        {/* Driven off METHOD_TABS rather than PRICING_METHODS: Flat Fee is reached
            through Tier Fee's Fee toggle, so the Tier Fee tab reads as selected for
            either of the two. */}
        <div className="flex rounded-lg border border-cream-border overflow-hidden text-xs">
          {METHOD_TABS.map((m) => {
            const active = m === "tier_fee"
              ? isFeeMethod(type)
              : m === "tier_kurs"
                ? isKursMethod(type)
                : type === m
            return (
              <button
                key={m}
                type="button"
                onClick={() => setType(m)}
                className={`px-3 py-1 whitespace-nowrap transition-colors ${active ? "bg-brand text-white font-medium" : "bg-white text-gray-600 hover:bg-cream"}`}
              >
                {PRICING_METHOD_LABEL[m]}
              </button>
            )
          })}
        </div>
      </div>

      {rupiahCostForm ? (
        // All four header fields share ONE 6-column grid rather than two grids of
        // three and two, because Store has to change which visual row it sits in:
        // leftmost on desktop, beside Name and Gram, but still paired with Base Cost
        // on mobile. Spans out of a single grid are the only way to do that without
        // rendering Store twice.
        //
        //   mobile   8+4 | 12 | 6+6 | 12 — Name+Gram, Store, Fee+Country, Base Cost
        //   md and up  4+6+2 | 2+4+6     — Store+Name+Gram, then Fee+Country+Base Cost
        //
        // Twelve columns, not six, so Base Cost can take the right HALF — columns 7-12,
        // the same width AND position as Price on the row below, in all four modes. The
        // valas grids reach column 7 by squeezing Country and Valas to 2 each; here Country
        // keeps 4 and there is no Valas, so the row fills exactly. No col-start needed —
        // the spans land Base Cost on column 7 either way.
        //
        // Mobile proportions are unchanged: every span is exactly double what it was.
        //
        // Country appears for both fee methods: picking one switches that method to a
        // foreign-currency base, which is why this branch only renders when there is none.
        //
        // Store keeps its mobile DOM position and moves with md:order-first, so the
        // mobile layout needs no order classes at all. Consequence: on desktop the
        // tab order is Name → Gram → Store, left-to-right only from Name onward.
        //
        // Each Field is wrapped in a div: Field renders the <label> itself, so the
        // span has to go on something outside it.
        <div className="grid grid-cols-12 gap-x-3 gap-y-4">
          <div className="col-span-8 md:col-span-6">{nameField}</div>
          <div className="col-span-4 md:col-span-2">{gramField}</div>
          <div className="col-span-12 md:col-span-4 md:order-first">{storeField}</div>
          {/* Fee and Country sit ahead of Base Cost in DOM order, so they land to its left
              on either breakpoint with no order class of their own. Store goes full width
              on mobile so those two get a line to share. */}
          <div className="col-span-6 md:col-span-2">{feeSourceToggle}</div>
          <div className="col-span-6 md:col-span-4">{countrySelect}</div>
          <div className="col-span-12 md:col-span-6">
            <Field label="Base Cost (IDR)">
              <input
                value={cost}
                onChange={(e) => {
                  const v = e.target.value
                  setCost(v)
                  if (!profitManual) {
                    setProfitFixed(String(suggestRupiahFee(Number(v) || 0)))
                  }
                }}
                type="number" min="0" placeholder="0" disabled={adding} className={formInputCls}
              />
            </Field>
          </div>
        </div>
      ) : isKursMethod(type) ? (
        // Tier Kurs renders no shared header: its Gram belongs on the header row on
        // desktop, so Store, Name, Gram, Country, Valas and Price all have to live in
        // ONE grid for spans and order to reach across what are two visual rows.
        //
        //   mobile     16+8 | 24 | 12+12 | 24 | 24 — Name+Gram, Store, Rate+Country, Valas,
        //                                             then the Charged / Pack Fee / Price
        //                                             expression
        //   md and up  8+12+4 | 3+3+4+14           — Store+Name+Gram, then Rate+Country+
        //                                             Valas+(× Charged i = Price)
        //
        // Twenty-four columns because the Rate toggle, Country and Valas TOGETHER have to
        // equal Store's 8 — 3, 3 and 4 — which 12 columns could not split that way. The
        // remaining 14 go to one cell holding the whole `× Charged = Price` expression, so
        // the row fills edge to edge with no gap. Before the Rate toggle it was 3+5+16.
        //
        // Mobile is DOM order with no order classes, so nothing there depends on the md
        // orders below. Between sm and md the fields show the mobile two-across shape
        // instead of the old four-across, which is easier to read at that width, not
        // harder.
        <div className="grid grid-cols-24 gap-x-3 gap-y-4">
          {/* Gram sits beside Name in DOM order so it shares Name's line on mobile, the
              same shape the other tabs have. Desktop is unaffected: every cell in this grid
              carries an explicit md:order, so its position there is set independently. */}
          <div className="col-span-16 md:col-span-12 md:order-2">{nameField}</div>
          <div className="col-span-8 md:col-span-4 md:order-3">{gramField}</div>
          <div className="col-span-24 md:col-span-8 md:order-1">{storeField}</div>

          <div className="col-span-12 md:col-span-3 md:order-4">{rateSourceToggle}</div>
          <div className="col-span-12 md:col-span-3 md:order-5">
            <Field label="Country">
              {/* Countries only — no "IDR (Rupiah)" option and not clearable, unlike the
                  hoisted countrySelect the fee methods use. Both Rate methods need a
                  country, and the server rejects a Rate row without one. */}
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
          </div>
          <div className="col-span-24 md:col-span-4 md:order-6">
            <Field label="Valas">
              <input value={valas} onChange={(e) => setValas(e.target.value)} type="number" step="any" min="0" placeholder="0" disabled={adding} className={formInputCls} />
            </Field>
          </div>
          {/* The charged rate, promoted out of the grey readout into the row it belongs
              to: it is the one input the whole price hangs on, and unlike RATE/COST/
              PROFIT it is not derived from the fields beside it — it comes from the
              brackets. Read-only all the same, styled like Price, because the server
              resolves it on save and a typed value would be a typed margin.

              The bracket popover sits here rather than on Valas: this is the field it
              explains — which bracket the valas landed in and what it charges. */}
          {/* Charged and Price share ONE cell holding a flex row, rather than being two
              grid cells: the × and = have to sit between them, and flex gives the
              glyphs their natural width while the two boxes split whatever is left.
              Column arithmetic would have had to guess a span for a glyph. */}
          <div className="col-span-24 md:col-span-14 md:order-7 flex items-start gap-2">
            {/* Decorative — the popover spells the formula out properly. */}
            <div className="hidden md:block" aria-hidden>{operator("×")}</div>
            <div className="flex-1 min-w-0">
              {/* The popover rides the label, not the box: the rate is short but the
                  box should still stretch with the row. */}
              <Field
                label="Charged"
                action={
                  <KursTierPopover
                    mode={type === "flat_kurs" ? "flat" : "tier"}
                    costRate={costRate}
                    country={selectedCountry}
                    valas={Number(valas) || 0}
                    gram={Number(gram) || 0}
                    tiers={kursTiers}
                    packingFee={Number(packFee) || 0}
                    roundTo={productDefaults?.tierKursRoundTo ?? DEFAULT_PRODUCT_DEFAULTS.tierKursRoundTo}
                    disabled={adding}
                  />
                }
              >
                <div className={`${formInputCls} bg-gray-50 text-gray-500 flex items-center tabular-nums`}>{fmt(chargedKurs)}</div>
              </Field>
            </div>
            {/* Part of the price, so it belongs in the expression rather than tucked away:
                the row reads valas × charged + pack fee = price. */}
            <div className="hidden md:block" aria-hidden>{operator("+")}</div>
            <div className="flex-1 min-w-0">
              <Field label="Pack Fee">
                <input value={packFee} onChange={(e) => setPackFee(e.target.value)} type="number" min="0" placeholder="5000" disabled={adding} className={formInputCls} />
              </Field>
            </div>
            <div className="hidden md:block" aria-hidden>{operator("=")}</div>
            <div className="flex-1 min-w-0">
              <Field label="Price">
                <div className={`${formInputCls} bg-gray-50 text-gray-500 flex items-center`}>Rp {fmt(pricePreview.price)}</div>
              </Field>
            </div>
          </div>
        </div>
      ) : (
        // Profit Margin and valas-mode Tier Fee. Valas mode takes Gram here too, so its
        // header row matches rupiah mode's exactly — 2+3+1. Profit Margin keeps Gram in
        // its own four-across grid alongside Country, Valas and Profit %, so pulling it
        // up here would render it twice.
        //
        //   mobile     valas 4+2 | 6   · margin 6 | 6
        //   md and up  valas 2+3+1     · margin 2+4
        //
        // Gram shows for BOTH valas fee modes. Flat Fee's landed cost has a freight term,
        // so leaving it out priced every such product as if it weighed nothing.
        <div className="grid grid-cols-6 gap-x-3 gap-y-4">
          <div className={valasFeeForm ? "col-span-4 md:col-span-3" : "col-span-6 md:col-span-4"}>{nameField}</div>
          {valasFeeForm && <div className="col-span-2 md:col-span-1">{gramField}</div>}
          <div className="col-span-6 md:col-span-2 md:order-first">{storeField}</div>
        </div>
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

          {/* Mobile keeps the readout here, where it has always been; desktop renders it
              again in the button row. Two render sites, not a move, so mobile's ORDER
              survives — readout, then any warning, then the buttons. It holds no state
              and nothing focusable, so the second copy costs only nodes. */}
          <div className="md:hidden">{readout}</div>
        </>
      )}

      {/* Country, Valas, Gram and Price live in the merged header grid above, not here:
          Gram shares the desktop header row, and one grid is what lets it. */}
      {/* Both Rate methods: the readout is the same node for either (readouts.flat_kurs is
          kursReadout), and gated on tier_kurs alone a Flat Rate row lost its readout
          entirely below md. Desktop was unaffected, which is what made it easy to miss. */}
      {isKursMethod(type) && (
        <>
          {/* Mobile keeps the readout here, where it has always been; desktop renders it
              again in the button row. Two render sites, not a move, so mobile's ORDER
              survives — readout, then any warning, then the buttons. It holds no state
              and nothing focusable, so the second copy costs only nodes. */}
          <div className="md:hidden">{readout}</div>

          {/* Flat's own "nothing configured" warning is the one below; this test is
              tier-specific — a flat row's fallback is costRate, not selectedCountry.kurs. */}
          {type === "flat_kurs" && selectedCountry && !(Number(selectedCountry.flatKurs) > 0) && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              {selectedCountry.name} has no flat rate, so this product is charged its cost
              rate and there is no margin. Set one in Settings → Pricing.
            </p>
          )}

          {type === "tier_kurs" && selectedCountry && chargedKurs === selectedCountry.kurs && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              No kurs bracket covers this valas for {selectedCountry.name}, so the flat
              rate is used and there is no margin. Add brackets in Settings → Pricing.
            </p>
          )}
        </>
      )}

      {isFeeMethod(type) && (
        <>
          {tierFeeRupiah && (
            <div className="grid grid-cols-2 gap-3">
              {/* Popover on the label, like Tier Kurs's Charged field: the icon then sits
                  in Field's h-4 label line instead of beside a 38px input, which is what
                  made the same 13px button read larger here. The input also gets the full
                  cell width back. */}
              <Field
                label="Fee (IDR)"
                action={
                  <TierFeePopover
                    base={Number(cost) || 0}
                    entered={Number(profitFixed) || 0}
                    brackets={scopedFeeBrackets}
                    unit="Rp"
                    disabled={adding}
                  />
                }
              >
                <input
                  value={profitFixed}
                  onChange={(e) => { setProfitFixed(e.target.value); setProfitManual(true) }}
                  type="number" min="0" placeholder="0" disabled={adding}
                  className={formInputCls}
                />
              </Field>
              <Field label="Price">
                <div className={`${formInputCls} bg-gray-50 text-gray-500 flex items-center`}>Rp {fmt(pricePreview.price)}</div>
              </Field>
            </div>
          )}

          {/* Mobile copy of the readout, as every other mode has: on desktop it renders in
              the button row instead. */}
          {tierFeeRupiah && <div className="md:hidden">{readout}</div>}

          {tierFeeValas && (
            <>
              {/* Both toggles live here rather than in a row of their own: within
                  isFeeMethod, !rupiahCostForm is exactly this mode, so there is no other
                  branch that needs them.

                  Country and Valas are squeezed to 2 each so Base Cost can take the right
                  half — columns 7-12, the same width and position it has in every other
                  mode, and the same as Fee and Price on the row below it. Neither the
                  country code nor a valas figure needs more than 2/12.

                    mobile     6+6 | 6+6 | 6+6
                    md and up  2+2+2+6 | 6+6                                          */}
              <div className="grid grid-cols-12 gap-x-3 gap-y-4">
                <div className="col-span-6 md:col-span-2">{feeSourceToggle}</div>
                <div className="col-span-6 md:col-span-2">{countrySelect}</div>
                <div className="col-span-6 md:col-span-2">
                  <Field label={`Valas${selectedCountry ? ` (${selectedCountry.currency})` : ""}`}>
                    <input value={valas} onChange={(e) => setValas(e.target.value)} type="number" step="any" min="0" placeholder="0" disabled={adding} className={formInputCls} />
                  </Field>
                </div>
                {/* The valas amount in rupiah — valas × the country's rate. Derived, not an
                    input: in this mode the base IS the valas figure, and products.cost stays
                    0 for these rows. Same number the readout bar calls COST; shown here so
                    the row reads as its own conversion. */}
                <div className="col-span-6 md:col-span-6">
                  <Field label="Base Cost (IDR)">
                    <div className={`${formInputCls} bg-gray-50 text-gray-500 flex items-center tabular-nums`}>
                      Rp {fmt(Math.round(pricePreview.cogs))}
                    </div>
                  </Field>
                </div>
                {/* Gram lives in the header row beside Product Name now, same as rupiah
                    mode, so the second line is the resolved fee and the price it produces.

                    Read-only, unlike rupiah mode's Fee input: this one comes from the
                    country's brackets and the server resolves it on save, so a typed value
                    would be a typed margin. Shown to two decimals because a valas fee can
                    be fractional where a rupiah one cannot. */}
                <div className="col-span-6 md:col-span-6">
                  {/* Rupiah, not the country's currency: the shared valas set is keyed on the
                      DERIVED base cost, so both the floor and the fee are rupiah. The popover
                      is matched on that same base cost. */}
                  <Field
                    label="Fee (IDR)"
                    action={
                      <TierFeePopover
                        base={valasBase}
                        brackets={scopedFeeBrackets}
                        unit="Rp"
                        rounding={productDefaults?.tierKursRoundTo ?? DEFAULT_PRODUCT_DEFAULTS.tierKursRoundTo}
                        disabled={adding}
                      />
                    }
                  >
                    <div className={`${formInputCls} bg-gray-50 text-gray-500 flex items-center tabular-nums`}>
                      Rp {fmt(Math.round(valasFee))}
                    </div>
                  </Field>
                </div>
                <div className="col-span-6 md:col-span-6">
                  <Field label="Price">
                    <div className={`${formInputCls} bg-gray-50 text-gray-500 flex items-center`}>Rp {fmt(pricePreview.price)}</div>
                  </Field>
                </div>
              </div>

              <div className="md:hidden">{readout}</div>


              {selectedCountry && (scopedFeeBrackets?.length ?? 0) === 0 && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  No Tier Fee brackets for {selectedCountry.name}, so the fee is 0 and this
                  product is priced at cost. Add them in Settings → Pricing.
                </p>
              )}
            </>
          )}
        </>
      )}

      {/* Reached through the Fee toggle above, not a tab — but still its own
          pricing_method, so it keeps its own field block.

          No fee INPUT by design: the fee is one Settings value and the server resolves it
          on save. Shown read-only rather than not at all, so the price is not an
          unexplained number. */}
      {/* Valas mode: the base is bought in foreign currency, so Country and Valas replace
          the typed Base Cost and the rupiah cost is derived. Mirrors valas-mode Tier Fee,
          except the fee stays a rupiah amount and nothing is rounded. */}
      {flatFeeValas && (
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-6 md:col-span-2">{feeSourceToggle}</div>
          <div className="col-span-6 md:col-span-2">{countrySelect}</div>
          <div className="col-span-6 md:col-span-2">
            <Field label={`Valas${selectedCountry ? ` (${selectedCountry.currency})` : ""}`}>
              <input value={valas} onChange={(e) => setValas(e.target.value)} type="number" step="any" min="0" placeholder="0" disabled={adding} className={formInputCls} />
            </Field>
          </div>
          {/* valas × the country's rate, plus freight for the gram weight. Derived, and
              the server recomputes it from the same four inputs on save. */}
          <div className="col-span-6 md:col-span-6">
            <Field label="Base Cost (IDR)">
              <div className={`${formInputCls} bg-gray-50 text-gray-500 flex items-center tabular-nums`}>
                Rp {fmt(Math.round(pricePreview.cogs))}
              </div>
            </Field>
          </div>
        </div>
      )}

      {type === "flat_fee" && (
        <>
          <div className="grid grid-cols-12 gap-x-3 gap-y-4">
            {/* 2+2+2+6. Price gets the right half — columns 7-12, the same span and the same
                position as Base Cost on the row above — and the three fee controls share the
                left half. None of them needs more: two hold short read-only figures and the
                third is a two-word toggle that stretches to whatever it is given. */}
            <div className="col-span-6 md:col-span-2">
              <Field label="Flat Fee (IDR)">
                <div className={`${formInputCls} bg-gray-50 text-gray-500 flex items-center`}>Rp {fmt(flatFee)}</div>
              </Field>
            </div>
            {/* The percentage itself, straight from Settings. Read-only for the same reason
                the fee above it is: the server re-reads both on save, and one number in one
                place is what separates this method from Tier Fee. Shown greyed rather than
                hidden while Percent is Off, so switching the toggle explains itself. */}
            <div className="col-span-6 md:col-span-2">
              <Field label="Flat Fee %">
                <div
                  title="Set under Settings → Pricing. Applies to every percent-mode Flat Fee product on its next save."
                  className={`${formInputCls} bg-gray-50 flex items-center tabular-nums ${
                    flatFeeMode === "percent" ? "text-gray-500" : "text-gray-300"
                  }`}
                >
                  {fmtRp2(flatFeePctSetting)}%{flatFeeFloored && " → min"}
                </div>
              </Field>
            </div>
            {/* Percent on/off. Both figures live in Settings — this only chooses which of
                them applies to THIS product, which is why it is stored on the row. */}
            <div className="col-span-6 md:col-span-2">
              <Field label="Percent">
                <div className="flex rounded-lg border border-cream-border overflow-hidden text-xs">
                  <button
                    type="button"
                    onClick={() => setFlatFeeMode("fixed")}
                    disabled={adding}
                    className={`flex-1 px-3 py-2.5 transition-colors ${flatFeeMode === "fixed" ? "bg-brand text-white font-medium" : "bg-white text-gray-600 hover:bg-cream"}`}
                  >
                    Off
                  </button>
                  <button
                    type="button"
                    onClick={() => setFlatFeeMode("percent")}
                    disabled={adding}
                    className={`flex-1 px-3 py-2.5 transition-colors ${flatFeeMode === "percent" ? "bg-brand text-white font-medium" : "bg-white text-gray-600 hover:bg-cream"}`}
                  >
                    On
                  </button>
                </div>
              </Field>
            </div>
            <div className="col-span-6 md:col-span-6">
              <Field label="Price">
                <div className={`${formInputCls} bg-gray-50 text-gray-500 flex items-center`}>Rp {fmt(pricePreview.price)}</div>
              </Field>
            </div>
          </div>
          <div className="md:hidden">{readout}</div>
        </>
      )}

      {/* justify-end still holds when the readout is absent, so every other method's
          button row is unchanged. When it is present it takes the slack on the left. */}
      <div className="flex items-center justify-end gap-3">
        {readout && <div className="hidden md:block flex-1 min-w-0">{readout}</div>}
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
  const productDefaults = useProductDefaults()
  const { tiers: kursTiers } = useKursTiers()
  // Read-only here — see the Tier Fee fields below.
  const { brackets: tierFeeBrackets } = useTierFeeBrackets()
  const [draft, setDraft] = useState({
    name: row.name,
    store: row.store,
    method: row.pricingMethod,
    countryId: row.countryId,
    valas: String(row.valas),
    gram: String(row.gram),
    profitPct: String(row.profitPct),
    opFee: String(row.operationalFee),
    packFee: String(row.packingFee),
    flatFeeMode: row.flatFeeMode,
    cost: String(row.cost),
    profitFixed: String(row.profitFixed),
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const draftCountry = countries.find((c) => c.id === draft.countryId)
  const draftAbroad = draft.method === "overseas"
  const draftTierKurs = draft.method === "tier_kurs"
  const draftFlatKurs = draft.method === "flat_kurs"
  /** Either Rate method: same formula, same stored columns, different rate source. */
  const draftKurs = isKursMethod(draft.method)
  const draftFlatFee = draft.method === "flat_fee"
  // Same country-driven split Tier Fee has: with one, cost is landed cost and derived.
  const draftFlatFeeValas = draftFlatFee && draft.countryId != null
  const draftFlatFeeRupiah = draftFlatFee && draft.countryId == null
  // Tier Fee's mode is whether it has a country — that IS the stored discriminator,
  // so the modal needs no extra toggle: clearing the Country field switches to rupiah.
  const draftTierFeeValas = draft.method === "tier_fee" && draft.countryId != null
  const draftTierFeeRupiah = draft.method === "tier_fee" && draft.countryId == null
  const draftFeeBrackets = tierFeeBrackets
    ? bracketsForScope(tierFeeBrackets, draftTierFeeValas ? "valas" : "rupiah")
    : null
  // The shared valas set keys on the DERIVED rupiah base cost, not on the valas figure.
  // Rounded to match the server, which resolves the bracket from a rounded base — see the
  // Add form's valasBase for why half a rupiah matters here.
  const draftValasBase = draftTierFeeValas
    ? Math.round(landedCost({
        valas: Number(draft.valas) || 0,
        kurs: draftCountry?.kurs ?? row.kurs,
        gram: Number(draft.gram) || 0,
        cargoPerKg: draftCountry?.cargoPerKg ?? row.cargoPerKg,
      }))
    : 0
  const draftValasFee = draftTierFeeValas
    ? resolveRupiahTierFee(draftFeeBrackets ?? [], draftValasBase)
    : 0
  // Settings owns both flat-fee figures and the server re-reads them on save; this only
  // feeds the preview and the optimistic row patch. In percent mode the fee comes off the
  // base this row is priced from, the same one the server will use.
  const flatFeePctSetting = productDefaults?.flatFeePct ?? DEFAULT_PRODUCT_DEFAULTS.flatFeePct
  const flatFeeBase = draftFlatFeeValas
    ? Math.round(landedCost({
        valas: Number(draft.valas) || 0,
        kurs: draftCountry?.kurs ?? row.kurs,
        gram: Number(draft.gram) || 0,
        cargoPerKg: draftCountry?.cargoPerKg ?? row.cargoPerKg,
      }))
    : Number(draft.cost) || 0
  const flatFeeMinSetting = productDefaults?.flatFeeMin ?? DEFAULT_PRODUCT_DEFAULTS.flatFeeMin
  const flatFee = flatFeeAmount(
    draft.flatFeeMode,
    flatFeeBase,
    productDefaults?.flatFee ?? DEFAULT_PRODUCT_DEFAULTS.flatFee,
    flatFeePctSetting,
    flatFeeMinSetting,
  )

  // A Rate row was costed at the markup rate that was live when it was added, and that
  // figure lives in products.kurs. Keep it: rewriting it from countries.kurs on an unrelated
  // edit would re-cost the row at a rate it was never priced with, and this modal has no
  // live rate of its own to offer instead.
  //
  // The one exception is a country change, where the old snapshot is a rate for the wrong
  // currency entirely; the new country's stored rate is then the best available.
  //
  // Declared above BOTH draftChargedKurs and editCalc, which read it during render. Below
  // either one it is a temporal dead zone — see 9eda039, where exactly that threw
  // "Cannot access 'Q' before initialization" on every Tier Kurs edit.
  const tierKursCostRate =
    draft.countryId === row.countryId ? row.kurs : (draftCountry?.kurs ?? row.kurs)

  // The rate this valas would be charged, re-resolved as it is edited. Falls back
  // to the row's own snapshot when there is no country to resolve against, so an
  // edit never silently zeroes the rate the price was built from.
  //
  // The flat fallback is tierKursCostRate — the rate this row books as COST, and the value
  // handleSave is about to send as body.kurs. The server resolves against that same figure,
  // so an unconfigured country previews a zero spread here and stores one there.
  const draftChargedKurs = !draftCountry
    ? (row.tieredKurs ?? 0)
    : draftFlatKurs
      ? resolveFlatKurs(draftCountry.flatKurs, tierKursCostRate)
      : resolveTieredKurs(
          tiersForCountry(kursTiers, draftCountry.id),
          Number(draft.valas) || 0,
          draftCountry.kurs,
        )

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
        roundTo: productDefaults?.profitMarginRoundTo ?? DEFAULT_PRODUCT_DEFAULTS.profitMarginRoundTo,
      })
      const profit = abroadProfit({ price, cogs, operationalFee: Number(draft.opFee) || 0, packingFee: Number(draft.packFee) || 0 })
      return { price, cogs: Math.round(cogs), profit }
    }
    // Both Rate methods: identical formula, and draftChargedKurs above already knows
    // which rate it resolved.
    if (draftKurs) {
      const { cogs, price } = calcKursPrice({
        gram: Number(draft.gram) || 0,
        cargoPerKg: draftCountry?.cargoPerKg ?? row.cargoPerKg,
        valas: Number(draft.valas) || 0,
        chargedKurs: draftChargedKurs,
        kurs: tierKursCostRate,
        packingFee: Number(draft.packFee) || 0,
        roundTo: productDefaults?.tierKursRoundTo ?? DEFAULT_PRODUCT_DEFAULTS.tierKursRoundTo,
      })
      return {
        price,
        cogs: Math.round(cogs),
        profit: kursProfit({ price, cogs, packingFee: Number(draft.packFee) || 0 }),
      }
    }
    if (draftTierFeeValas) {
      const { cogs, price } = calcTierFeeValasPrice({
        valas: Number(draft.valas) || 0,
        kurs: draftCountry?.kurs ?? row.kurs,
        gram: Number(draft.gram) || 0,
        cargoPerKg: draftCountry?.cargoPerKg ?? row.cargoPerKg,
        fee: draftValasFee,
        roundTo: productDefaults?.tierKursRoundTo ?? DEFAULT_PRODUCT_DEFAULTS.tierKursRoundTo,
      })
      return { price, cogs: Math.round(cogs), profit: Math.round(price - cogs) }
    }
    if (draftFlatFeeValas) {
      const { cogs, price } = calcFlatFeeValasPrice({
        valas: Number(draft.valas) || 0,
        kurs: draftCountry?.kurs ?? row.kurs,
        gram: Number(draft.gram) || 0,
        cargoPerKg: draftCountry?.cargoPerKg ?? row.cargoPerKg,
        fee: flatFee,
      })
      return { price, cogs: Math.round(cogs), profit: flatFee }
    }
    if (draftFlatFee) {
      const base = Number(draft.cost) || 0
      return { price: calcRupiahFeePrice(base, flatFee), cogs: base, profit: flatFee }
    }
    return { price: calcRupiahFeePrice(Number(draft.cost) || 0, Number(draft.profitFixed) || 0), cogs: null, profit: null }
  }, [draft, draftAbroad, draftKurs, draftFlatFee, draftFlatFeeValas, draftTierFeeValas, draftValasFee,
      draftChargedKurs, draftCountry, row.kurs, row.cargoPerKg, productDefaults, flatFee, tierKursCostRate])

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    try {
      const body: Record<string, unknown> = {
        name: draft.name.trim(),
        store: draft.store.trim(),
        price: editCalc.price,
        gram: Number(draft.gram) || 0,
        pricingMethod: draft.method,
        countryId: draft.countryId,
        // Keyed on the country's presence, not on the method: that is what decides
        // whether the row is priced in foreign currency at all, for every method.
        valas: draft.countryId != null ? Number(draft.valas) || 0 : 0,
        kurs: draftKurs
          ? tierKursCostRate
          : draft.countryId != null ? (draftCountry?.kurs ?? row.kurs) : 0,
        // Freight is booked by the three methods whose cost is landed cost — overseas,
        // Tier Kurs, and Flat Fee with a country. Valas-mode Tier Fee has no weight term:
        // its cost is the converted goods alone.
        // Every foreign-currency method books freight into cost now, so all of them
        // snapshot the rate. Only the two rupiah modes have no weight term.
        cargoPerKg: draft.countryId != null ? (draftCountry?.cargoPerKg ?? row.cargoPerKg) : 0,
        profitPct: draftAbroad ? Number(draft.profitPct) || 0 : 0,
        operationalFee: draftAbroad ? Number(draft.opFee) || 0 : 5000,
        flatFeeMode: draft.flatFeeMode,
        // Tier Kurs recovers a packing charge in its price too, so it stores its own.
        packingFee: draftAbroad || draftKurs ? Number(draft.packFee) || 0 : 5000,
        // Not sent for valas-mode Flat Fee: the server derives that cost from valas, the
        // rate and the freight, and ignores anything here.
        cost: draftTierFeeRupiah || draftFlatFeeRupiah ? Number(draft.cost) || 0 : 0,
        // Sent for rupiah-mode Tier Fee only. For flat_fee and valas-mode Tier Fee the
        // server resolves the fee and ignores this, so sending one would imply
        // otherwise.
        profitFixed: draftTierFeeRupiah ? Number(draft.profitFixed) || 0 : 0,
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
        pricingMethod: draft.method,
        countryId: draft.countryId,
        countryName: draftCountry?.name ?? "",
        valas: Number(body.valas) || 0,
        kurs: Number(body.kurs) || 0,
        // Mirrors the server's rule: null for every method but tier_kurs, so the
        // Tier Rate cell doesn't show a number the row doesn't have.
        tieredKurs: draftKurs ? draftChargedKurs : null,
        cargoPerKg: Number(body.cargoPerKg) || 0,
        profitPct: Number(body.profitPct) || 0,
        operationalFee: Number(body.operationalFee) || 0,
        packingFee: Number(body.packingFee) || 0,
        // The two valas fee modes send no cost — the server derives and stores landed cost —
        // so the patch has to supply the same figure or the Base Cost cell reads 0 until the
        // next refetch. editCalc.cogs is that figure, already rounded.
        cost: draftTierFeeValas || draftFlatFeeValas ? (editCalc.cogs ?? 0) : Number(body.cost) || 0,
        // Mirrors the server: the resolved fee lands in profit_fixed for BOTH server-resolved
        // fee modes, so the Fee cell shows it immediately instead of a 0 until the next
        // refresh. draftValasFee is the Markup valas one, flatFee the Flat Fee one.
        profitFixed: draftFlatFee ? flatFee
          : draftTierFeeValas ? Math.round(draftValasFee)
          : Number(body.profitFixed) || 0,
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

        {/* Store then Name on one desktop row, matching the Add form. This block sits
            above the method picker, so all four methods get it from the one change.
            Half and half rather than the Add form's 2/4: the modal is md:max-w-lg, so
            a 2/6 Store would be ~140px and truncate most store names. Every other row
            in here is a plain two-column grid too.

            Mobile keeps one field per line, in DOM order, at the parent's gap-4 —
            Store moves with md:order-first alone. */}
        <div className="grid gap-4 md:grid-cols-2 md:gap-3">
          <Field label="Name">
            <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} disabled={saving} className={formInputCls} />
          </Field>

          {/* Field renders the <label>, so the order class goes on a wrapper. */}
          <div className="md:order-first">
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
          </div>
        </div>

        {/* Explicit method picker. Before Tier Kurs the method was implied by
            whether a country was set, which cannot distinguish overseas from
            tier_kurs — both have one.

            METHOD_TABS, not PRICING_METHODS: Flat Fee is reached through the Fee toggle
            below, exactly as in the Add form, so the Tier Fee button reads as selected
            for either of the two fee methods. */}
        <div className="flex flex-wrap items-start gap-4">
          <Field label="Pricing">
            <div className="flex rounded-lg border border-cream-border overflow-hidden text-xs self-start">
              {METHOD_TABS.map((m) => {
                const active = m === "tier_fee"
                  ? isFeeMethod(draft.method)
                  : m === "tier_kurs"
                    ? isKursMethod(draft.method)
                    : draft.method === m
                return (
                  <button
                    key={m}
                    type="button"
                    disabled={saving}
                    onClick={() => setDraft((d) => ({
                      ...d,
                      method: m,
                      // Domestic has no country; the other two require one, so carry
                      // the row's original rather than leaving it null.
                      countryId: methodNeedsCountry(m) ? (d.countryId ?? row.countryId) : null,
                    }))}
                    className={`px-3 py-1.5 transition-colors ${active ? "bg-brand text-white font-medium" : "bg-white text-gray-600 hover:bg-cream"}`}
                  >
                    {PRICING_METHOD_LABEL[m]}
                  </button>
                )
              })}
            </div>
          </Field>

          {/* Where the fee comes from. No "Priced in" counterpart here: in this modal the
              Country field above is what picks rupiah vs valas mode for Tier, so a second
              control for it would be two ways to set one thing. Flat clears the country —
              its fee is a single rupiah setting, and a Flat row carrying a country would
              silently ignore it. */}
          {isFeeMethod(draft.method) && (
            <Field label="Fee">
              <div className="flex rounded-lg border border-cream-border overflow-hidden text-xs self-start">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setDraft((d) => ({ ...d, method: "tier_fee" }))}
                  className={`px-3 py-1.5 transition-colors ${draft.method === "tier_fee" ? "bg-brand text-white font-medium" : "bg-white text-gray-600 hover:bg-cream"}`}
                >
                  Tier
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setDraft((d) => ({ ...d, method: "flat_fee", countryId: null }))}
                  className={`px-3 py-1.5 transition-colors ${draft.method === "flat_fee" ? "bg-brand text-white font-medium" : "bg-white text-gray-600 hover:bg-cream"}`}
                >
                  Flat
                </button>
              </div>
            </Field>
          )}

          {/* Where the charged rate comes from. Neither side clears the country, unlike the
              Fee toggle above — both Rate methods need one, because a rate is meaningless
              without a currency to be a rate for. */}
          {isKursMethod(draft.method) && (
            <Field label="Rate">
              <div className="flex rounded-lg border border-cream-border overflow-hidden text-xs self-start">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setDraft((d) => ({ ...d, method: "tier_kurs" }))}
                  className={`px-3 py-1.5 transition-colors ${draft.method === "tier_kurs" ? "bg-brand text-white font-medium" : "bg-white text-gray-600 hover:bg-cream"}`}
                >
                  Tier
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setDraft((d) => ({ ...d, method: "flat_kurs" }))}
                  className={`px-3 py-1.5 transition-colors ${draft.method === "flat_kurs" ? "bg-brand text-white font-medium" : "bg-white text-gray-600 hover:bg-cream"}`}
                >
                  Flat
                </button>
              </div>
            </Field>
          )}
        </div>

        {/* Shown for every method: for Profit Margin and the two Rate methods it is
            required, and for the two fee methods its presence is what selects a
            foreign-currency base.

            `clearable` is GATED, and must stay gated. Clearing the country on a Rate row
            sent countryId null and — because valas is gated on the country — valas 0, so
            the server resolved no rate and stored ceil(0 × kurs + packFee): Rp 5.000,
            non-zero, straight past the Sheets-import guard. A real price replaced by 5000
            by clearing one field. The server rejects it now too; this stops the owner
            reaching the rejection. */}
        {true ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Country">
              <SearchableSelect
                value={draft.countryId != null ? String(draft.countryId) : ""}
                onChange={(v) => setDraft((d) => ({ ...d, countryId: v ? Number(v) : null }))}
                options={countries.map((c) => ({ value: String(c.id), label: `${c.name} (${c.currency})` }))}
                placeholder={methodNeedsCountry(draft.method) ? "Select country…" : "Domestic"}
                disabled={saving}
                searchable={false}
                clearable={!methodNeedsCountry(draft.method)}
                alwaysShowAll
              />
            </Field>
            <Field label="Valas">
              {/* This field is shared with Profit Margin, which has no brackets, so
                  the popover only appears for Tier Kurs. */}
              <div className="flex items-center gap-2">
                <input value={draft.valas} onChange={(e) => setDraft((d) => ({ ...d, valas: e.target.value }))} type="number" step="any" min="0" disabled={saving} className={`${formInputCls} flex-1 min-w-0`} />
                {draftKurs && (
                  <KursTierPopover
                    mode={draft.method === "flat_kurs" ? "flat" : "tier"}
                    costRate={tierKursCostRate}
                    country={draftCountry}
                    valas={Number(draft.valas) || 0}
                    gram={Number(draft.gram) || 0}
                    tiers={kursTiers}
                    packingFee={Number(draft.packFee) || 0}
                    roundTo={productDefaults?.tierKursRoundTo ?? DEFAULT_PRODUCT_DEFAULTS.tierKursRoundTo}
                    disabled={saving}
                  />
                )}
              </div>
            </Field>
          </div>
        ) : null}

        {/* Both Rate methods, not just the bracketed one: they share every field in here —
            Gram and Pack Fee both feed the same formula, and the price readout is the same
            editCalc. Gated on tier_kurs alone, a Flat Rate row lost the whole pricing half
            of the modal. */}
        {draftKurs && (
          <>
            {/* Pack Fee is editable here for the same reason as in the Add form: it is part
                of the price, so hiding it would leave the price unexplained. */}
            <div className="grid grid-cols-3 gap-3">
              <Field label="Gram">
                <input value={draft.gram} onChange={(e) => setDraft((d) => ({ ...d, gram: e.target.value }))} type="number" min="0" disabled={saving} className={formInputCls} />
              </Field>
              <Field label="Pack Fee">
                <input value={draft.packFee} onChange={(e) => setDraft((d) => ({ ...d, packFee: e.target.value }))} type="number" min="0" disabled={saving} className={formInputCls} />
              </Field>
              <Field label="Price">
                <div className={`${formInputCls} bg-gray-50 text-gray-500 flex items-center`}>Rp {fmt(editCalc.price)}</div>
              </Field>
            </div>

            {draftCountry && (
              <div className="flex items-center justify-between gap-1 flex-nowrap whitespace-nowrap rounded-lg bg-gray-50 border border-cream-border px-3 py-3 text-[9px] md:text-xs text-gray-500">
                <span>
                  RATE: {fmt(draftCountry.kurs)}
                  {draftChargedKurs !== draftCountry.kurs && (
                    <> → <span className="font-semibold text-foreground">CHARGED: {fmt(draftChargedKurs)}</span></>
                  )}
                </span>
                <span>COST: {fmt(editCalc.cogs ?? 0)}</span>
                <span className={`font-semibold ${(editCalc.profit ?? 0) >= 0 ? "text-green-700" : "text-red-600"}`}>
                  PROFIT: Rp {fmt(editCalc.profit ?? 0)}
                </span>
              </div>
            )}

            {/* "Nothing configured" reads differently per method, and so does the test for
                it: Tier compares against the country's own rate, while Flat's fallback is
                tierKursCostRate, so comparing it to draftCountry.kurs would both miss the
                real case and fire on a live-rate row that is fine. */}
            {draftFlatKurs
              ? draftCountry && !(Number(draftCountry.flatKurs) > 0) && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    {draftCountry.name} has no flat rate, so this product is charged its cost
                    rate and there is no margin. Set one in Settings → Pricing.
                  </p>
                )
              : draftCountry && draftChargedKurs === draftCountry.kurs && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    No kurs bracket covers this valas for {draftCountry.name}, so the flat rate
                    is used and there is no margin. Add brackets in Settings → Pricing.
                  </p>
                )}
          </>
        )}

        {draftAbroad && (
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
        )}

        {/* Rupiah mode: no country, so a rupiah base cost and a typed fee. Gated on
            the mode explicitly, not on `!draftAbroad`, which would also catch
            tier_kurs and render these inputs for it. */}
        {draftTierFeeRupiah && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Base Cost">
              <input value={draft.cost} onChange={(e) => setDraft((d) => ({ ...d, cost: e.target.value }))} type="number" min="0" disabled={saving} className={formInputCls} />
            </Field>
            <Field label="Fee">
              <div className="flex items-center gap-2">
                <input value={draft.profitFixed} onChange={(e) => setDraft((d) => ({ ...d, profitFixed: e.target.value }))} type="number" min="0" disabled={saving} className={`${formInputCls} flex-1 min-w-0`} />
                {/* Read-only here: the edit modal never re-derives the fee, so this
                    explains what the brackets WOULD charge without changing it. */}
                <TierFeePopover
                  base={Number(draft.cost) || 0}
                  entered={Number(draft.profitFixed) || 0}
                  brackets={draftFeeBrackets}
                  unit="Rp"
                  disabled={saving}
                />
              </div>
            </Field>
            <Field label="Gram">
              <input value={draft.gram} onChange={(e) => setDraft((d) => ({ ...d, gram: e.target.value }))} type="number" min="0" disabled={saving} className={formInputCls} />
            </Field>
            {calcSummary}
          </div>
        )}

        {/* Valas mode: the Country + Valas row above supplies the inputs, so all this
            adds is the resolved fee, the price, and the arithmetic between them. The
            fee is NOT an input — the server resolves it from the brackets. */}
        {draftTierFeeValas && (
          <>
            <div className="grid grid-cols-2 gap-3">
              {/* Rupiah, matched on the derived base cost — see draftValasBase. */}
              <Field
                label="Fee (IDR)"
                action={
                  <TierFeePopover
                    base={draftValasBase}
                    brackets={draftFeeBrackets}
                    unit="Rp"
                    rounding={productDefaults?.tierKursRoundTo ?? DEFAULT_PRODUCT_DEFAULTS.tierKursRoundTo}
                    disabled={saving}
                  />
                }
              >
                <div className={`${formInputCls} bg-gray-50 text-gray-400 cursor-not-allowed flex items-center`}>
                  Rp {fmt(Math.round(draftValasFee))}
                </div>
              </Field>
              <Field label="Gram">
                <input value={draft.gram} onChange={(e) => setDraft((d) => ({ ...d, gram: e.target.value }))} type="number" min="0" disabled={saving} className={formInputCls} />
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
                {/* Rupiah, not {draftCountry.currency}: since migration 056 the valas set's
                    fee is a rupiah amount matched on the rupiah base cost. The field above
                    says "Fee (IDR)" — this used to contradict it. */}
                <span>FEE: Rp {fmt(Math.round(draftValasFee))}</span>
                <span>COGS: Rp {fmt(editCalc.cogs ?? 0)}</span>
                <span className="text-green-700 font-semibold">PROFIT: Rp {fmt(editCalc.profit ?? 0)}</span>
              </div>
            )}

            {/* profit_fixed is where the fee a valas-mode row was priced with lives. The
                superseded shape kept it in a foreign-currency column, so this comparison used
                to weigh a rupiah fee against a valas one. */}
            {Math.abs(row.profitFixed - draftValasFee) > 0.5 && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                This product was priced with a fee of Rp {fmt(row.profitFixed)}. Saving will
                reprice it at the current Rp {fmt(Math.round(draftValasFee))}.
              </p>
            )}
          </>
        )}

        {/* No fee input: the fee is one Settings value, resolved server-side on
            save. Shown read-only so the price isn't unexplained. */}
        {draftFlatFee && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Base Cost">
                <input value={draft.cost} onChange={(e) => setDraft((d) => ({ ...d, cost: e.target.value }))} type="number" min="0" disabled={saving} className={formInputCls} />
              </Field>
              <Field label={draft.flatFeeMode === "percent" ? `Flat Fee (${fmtRp2(flatFeePctSetting)}%)` : "Flat Fee"}>
                <div
                  title="Set under Settings → Pricing. Applies to every Flat Fee product on its next save."
                  className={`${formInputCls} bg-gray-50 text-gray-400 cursor-not-allowed flex items-center`}
                >
                  Rp {fmt(flatFee)}
                </div>
              </Field>
              {/* Which of the two Settings figures applies to this row. Stored per row, so
                  unlike the amounts themselves it is editable here. */}
              <Field label="Percent">
                <div className="flex rounded-lg border border-cream-border overflow-hidden text-xs">
                  {(["fixed", "percent"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      disabled={saving}
                      onClick={() => setDraft((d) => ({ ...d, flatFeeMode: m }))}
                      className={`flex-1 px-3 py-2.5 transition-colors ${draft.flatFeeMode === m ? "bg-brand text-white font-medium" : "bg-white text-gray-600 hover:bg-cream"}`}
                    >
                      {m === "fixed" ? "Off" : "On"}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Gram">
                <input value={draft.gram} onChange={(e) => setDraft((d) => ({ ...d, gram: e.target.value }))} type="number" min="0" disabled={saving} className={formInputCls} />
              </Field>
              <Field label="Price">
                <div className={`${formInputCls} bg-gray-50 text-gray-500 flex items-center`}>Rp {fmt(editCalc.price)}</div>
              </Field>
            </div>
            {Number(row.profitFixed) !== flatFee && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                This product was priced with a fee of Rp {fmt(row.profitFixed)}. Saving
                will reprice it at the current Rp {fmt(flatFee)}.
              </p>
            )}
          </>
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
