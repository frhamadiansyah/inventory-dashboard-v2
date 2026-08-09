"use client"

import TableSkeleton from "@/components/TableSkeleton"
import { useEffect, useMemo, useState } from "react"
import type { ProductIndoRow } from "@/lib/db"
import DataGrid, { numericFilter, textContainsFilter, type ColumnDef } from "@/components/DataGrid"

const EMPTY_FORM = { product: "", store: "", price: "" }

const formInputCls =
  "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

const fmt = (n: number) => n.toLocaleString("id-ID")

export default function ProductsClient() {
  const [data, setData] = useState<ProductIndoRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [form, setForm] = useState(EMPTY_FORM)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const [editingRow, setEditingRow] = useState<ProductIndoRow | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/products-indo")
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to load")
      setData(json as ProductIndoRow[])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const stores = useMemo(() => {
    if (!data) return []
    return [...new Set(data.map((r) => r.store).filter(Boolean))].sort()
  }, [data])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setAdding(true)
    setAddError(null)
    try {
      const res = await fetch("/api/sheets/products-indo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product: form.product,
          store: form.store,
          price: Number(form.price) || 0,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to add")
      setForm(EMPTY_FORM)
      setData((prev) => [...(prev ?? []), json as ProductIndoRow])
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add")
    } finally {
      setAdding(false)
    }
  }

  function field(key: keyof typeof EMPTY_FORM) {
    return {
      value: form[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setForm((f) => ({ ...f, [key]: e.target.value })),
    }
  }

  const columns = useMemo<ColumnDef<ProductIndoRow, unknown>[]>(() => [
    {
      accessorKey: "product",
      header: "Product",
      filterFn: "textContains",
      cell: ({ row }) => <span className="font-medium whitespace-nowrap">{row.original.product}</span>,
    },
    {
      accessorKey: "store",
      header: "Store",
      filterFn: "textContains",
    },
    {
      accessorKey: "price",
      header: "Price",
      filterFn: "numeric",
      cell: ({ row }) => <span className="tabular-nums font-medium">{fmt(row.original.price)}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "createdAt",
      header: "Created",
      filterFn: "textContains",
    },
    {
      accessorKey: "updatedAt",
      header: "Updated",
      filterFn: "textContains",
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableColumnFilter: false,
      enableHiding: false,
      cell: ({ row }) => (
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
      ),
    },
  ], [])

  const renderMobileCard = (row: ProductIndoRow) => (
    <div className="rounded-xl border border-cream-border bg-white p-3.5 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-foreground truncate">{row.product}</div>
        <div className="text-xs text-gray-500 mt-0.5">{row.store}</div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-sm font-medium tabular-nums text-foreground">{fmt(row.price)}</span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setEditingRow(row) }}
          title="Edit"
          className="text-gray-400 hover:text-brand transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
          </svg>
        </button>
      </div>
    </div>
  )


  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={handleAdd} className="rounded-xl border border-cream-border bg-white p-5 flex flex-col gap-4">
        <div className="text-sm font-semibold text-foreground">Tambah Produk</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <input
            {...field("product")}
            placeholder="Product"
            required
            disabled={adding}
            className={formInputCls}
          />
          <input
            {...field("store")}
            list="stores-list"
            placeholder="Store"
            required
            disabled={adding}
            className={formInputCls}
          />
          <input
            {...field("price")}
            type="number"
            min="0"
            placeholder="Price"
            required
            disabled={adding}
            className={formInputCls}
          />
        </div>

        <datalist id="stores-list">
          {stores.map((s) => <option key={s} value={s} />)}
        </datalist>

        <div className="flex items-center justify-end gap-3">
          {addError && <p className="text-xs text-red-500">{addError}</p>}
          <button
            type="submit"
            disabled={adding}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {adding ? "Menyimpan…" : "Tambah"}
          </button>
        </div>
      </form>

      {loading && <TableSkeleton />}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {!loading && !error && data && (
        <DataGrid
          data={data}
          columns={columns}
          getRowId={(row) => String(row.rowNumber)}
          searchPlaceholder="Search product, store…"
          fullWidthSearch
          tightToolbar
          boldUppercaseHeader
          hideRowCount
          renderMobileCard={renderMobileCard}
          initialVisibility={{
            createdAt: false,
            updatedAt: false,
          }}
        />
      )}

      {editingRow && (
        <EditProductIndoModal
          row={editingRow}
          stores={stores}
          onSave={(updated) => {
            setData((prev) =>
              prev?.map((r) => r.rowNumber === editingRow.rowNumber ? { ...r, ...updated } : r) ?? null,
            )
            setEditingRow(null)
          }}
          onCancel={() => setEditingRow(null)}
        />
      )}
    </div>
  )
}

// ─── Edit modal ────────────────────────────────────────────────────────────

function EditProductIndoModal({
  row,
  stores,
  onSave,
  onCancel,
}: {
  row: ProductIndoRow
  stores: string[]
  onSave: (updated: Partial<ProductIndoRow>) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState({
    product: row.product,
    store: row.store,
    price: String(row.price),
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    const price = Number(draft.price) || 0
    try {
      const res = await fetch("/api/sheets/products-indo", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rowNumber: row.rowNumber,
          product: draft.product.trim(),
          store: draft.store.trim(),
          price,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      onSave({ product: draft.product.trim(), store: draft.store.trim(), price })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") { e.preventDefault(); handleSave() }
    if (e.key === "Escape") onCancel()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onCancel}>
      <div className="bg-white rounded-xl border border-cream-border shadow-xl p-6 w-full max-w-md flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">Edit Produk</span>
          <span className="text-xs text-gray-400">Row: {row.rowNumber}</span>
        </div>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Product</span>
            <input
              value={draft.product}
              onChange={(e) => setDraft((d) => ({ ...d, product: e.target.value }))}
              onKeyDown={handleKeyDown}
              disabled={saving}
              autoFocus
              className={formInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Store</span>
            <input
              value={draft.store}
              onChange={(e) => setDraft((d) => ({ ...d, store: e.target.value }))}
              onKeyDown={handleKeyDown}
              list="edit-stores-list"
              disabled={saving}
              className={formInputCls}
            />
            <datalist id="edit-stores-list">
              {stores.map((s) => <option key={s} value={s} />)}
            </datalist>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Price</span>
            <input
              value={draft.price}
              onChange={(e) => setDraft((d) => ({ ...d, price: e.target.value }))}
              onKeyDown={handleKeyDown}
              type="number"
              min="0"
              disabled={saving}
              className={formInputCls}
            />
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-cream-border">
          {saveError && <p className="text-xs text-red-500">{saveError}</p>}
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-500 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {saving ? "Menyimpan…" : "Simpan"}
          </button>
        </div>
      </div>
    </div>
  )
}
