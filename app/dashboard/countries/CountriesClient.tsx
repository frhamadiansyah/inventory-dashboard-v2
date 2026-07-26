"use client"

import TableSkeleton from "@/components/TableSkeleton"
import { useEffect, useMemo, useRef, useState } from "react"
import type { CountryRow } from "@/lib/db"
import DataGrid, { type ColumnDef, numericFilter, textContainsFilter } from "@/components/DataGrid"
import { useLiveIdrRate } from "@/hooks/useLiveIdrRate"

const EMPTY_FORM = { name: "", currency: "", kurs: "", cargoPerKg: "" }

// Mobile-only read-only boxes: the live 1-unit rate to IDR for the typed
// currency, plus a +5% markup rate. Styled to match the form's input boxes.
// Markup % is configured in Settings → Pricing; falls back to +5% until loaded.
function LiveIdrRate({ currency, markupPct = 5 }: { currency: string; markupPct?: number }) {
  const { rate, loading } = useLiveIdrRate(currency)
  const code = currency.trim().toUpperCase()
  const valid = /^[A-Z]{3}$/.test(code)
  const markup = 1 + markupPct / 100
  const fmtRp = (n: number) => `Rp ${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(n)}`
  const body = (value: number | null) =>
    !valid ? "Enter a 3-letter currency" : loading ? "Loading…" : value != null ? fmtRp(value) : "Unavailable"
  // Shrink only the placeholder/hint so it fits one line; keep the value at text-sm.
  const sizeCls = (value: number | null) => (valid && !loading && value != null ? "text-sm" : "text-xs")
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-500">Live rate</span>
        <div className={`w-full h-[38px] flex items-center border border-cream-border rounded-lg px-3 bg-gray-50 text-gray-600 ${sizeCls(rate)}`}>{body(rate)}</div>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-500">Markup rate</span>
        <div className={`w-full h-[38px] flex items-center border border-cream-border rounded-lg px-3 bg-gray-50 text-gray-600 ${sizeCls(rate != null ? rate * markup : null)}`}>{body(rate != null ? rate * markup : null)}</div>
      </div>
    </div>
  )
}

const formInputCls = "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
const modalInputCls = "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors disabled:opacity-50"

const fmt = (n: number) => n.toLocaleString("id-ID")

// ISO 4217 currency → flag emoji, for the small circular badge on the mobile
// card. Covers the currencies this business actually deals with; unmapped
// currencies fall back to a 2-letter initial in CountryFlag below.
const CURRENCY_FLAG: Record<string, string> = {
  IDR: "🇮🇩", USD: "🇺🇸", CNY: "🇨🇳", VND: "🇻🇳", THB: "🇹🇭", MYR: "🇲🇾",
  SGD: "🇸🇬", HKD: "🇭🇰", KRW: "🇰🇷", JPY: "🇯🇵", PHP: "🇵🇭", INR: "🇮🇳",
  GBP: "🇬🇧", EUR: "🇪🇺", AUD: "🇦🇺", CAD: "🇨🇦", TWD: "🇹🇼", AED: "🇦🇪",
  SAR: "🇸🇦",
}

function CountryFlag({ name, currency }: { name: string; currency: string }) {
  const flag = CURRENCY_FLAG[currency.trim().toUpperCase()]
  return (
    <div className="shrink-0 w-9 h-9 rounded-full bg-cream border border-cream-border flex items-center justify-center overflow-hidden">
      {flag ? (
        <span className="text-base leading-none">{flag}</span>
      ) : (
        <span className="text-xs font-semibold text-gray-500">{name.slice(0, 2).toUpperCase()}</span>
      )}
    </div>
  )
}

export default function CountriesClient() {
  const [data, setData] = useState<CountryRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [form, setForm] = useState(EMPTY_FORM)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [mobileAddOpen, setMobileAddOpen] = useState(false)

  const [editRow, setEditRow] = useState<CountryRow | null>(null)
  const [markupPct, setMarkupPct] = useState(5)

  useEffect(() => {
    fetch("/api/sheets/product-defaults")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.defaults?.markupPct != null) setMarkupPct(Number(d.defaults.markupPct)) })
      .catch(() => {})
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/countries")
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to load")
      setData(json.rows as CountryRow[])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setAdding(true)
    setAddError(null)
    try {
      const res = await fetch("/api/sheets/countries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          currency: form.currency.trim(),
          kurs: Number(form.kurs) || 0,
          cargoPerKg: Number(form.cargoPerKg) || 0,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to add")
      setForm(EMPTY_FORM)
      setMobileAddOpen(false)
      load()
      if (window.innerWidth < 768) window.scrollTo({ top: 0, behavior: "smooth" })
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

  async function handleDelete(row: CountryRow) {
    if (!confirm(`Delete "${row.name}"? Products using this country will be affected.`)) return
    try {
      const res = await fetch(`/api/sheets/countries/${row.id}`, { method: "DELETE" })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      setData((prev) => prev?.filter((r) => r.id !== row.id) ?? null)
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  const columns = useMemo<ColumnDef<CountryRow, unknown>[]>(() => [
    {
      accessorKey: "name",
      header: "Country",
      size: 160,
      filterFn: "textContains",
      cell: ({ getValue }) => (
        <span className="font-medium">{getValue<string>()}</span>
      ),
    },
    {
      accessorKey: "currency",
      header: "Currency",
      size: 110,
      filterFn: "textContains",
      cell: ({ getValue }) => (
        <span className="text-gray-600">{getValue<string>()}</span>
      ),
    },
    {
      accessorKey: "kurs",
      header: "Kurs (IDR)",
      size: 130,
      filterFn: "numeric",
      meta: { align: "right" },
      cell: ({ getValue }) => (
        <span className="tabular-nums font-medium">{fmt(getValue<number>())}</span>
      ),
    },
    {
      accessorKey: "cargoPerKg",
      header: "Shipping / kg",
      size: 120,
      filterFn: "numeric",
      meta: { align: "right" },
      cell: ({ getValue }) => (
        <span className="tabular-nums font-medium">{fmt(getValue<number>())}</span>
      ),
    },
    {
      accessorKey: "createdAt",
      header: "Created",
      size: 110,
      enableColumnFilter: false,
      cell: ({ getValue }) => {
        const v = getValue<string | null>()
        return v ? new Date(v).toLocaleDateString("id-ID") : ""
      },
    },
    {
      accessorKey: "updatedAt",
      header: "Updated",
      size: 110,
      enableColumnFilter: false,
      cell: ({ getValue }) => {
        const v = getValue<string | null>()
        return v ? new Date(v).toLocaleDateString("id-ID") : ""
      },
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableColumnFilter: false,
      enableHiding: false,
      size: 80,
      cell: ({ row }) => (
        <div className="flex gap-2">
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
  ], [])

  const renderMobileCard = (row: CountryRow) => (
    <div
      onClick={() => setEditRow(row)}
      className="rounded-xl border border-cream-border bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex items-center justify-between gap-3 cursor-pointer active:bg-cream/40 transition-colors"
    >
      <CountryFlag name={row.name} currency={row.currency} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-semibold text-foreground">{row.currency || "—"}</span>
          <span className="text-xs text-gray-400 tabular-nums">· RATE {fmt(row.kurs)}</span>
        </div>
        <div className="text-xs text-gray-400 tabular-nums mt-0.5">
          SHIPPING {fmt(row.cargoPerKg)}/KG
        </div>
      </div>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-gray-400 shrink-0">
        <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
      </svg>
    </div>
  )


  const addForm = (
    <form onSubmit={handleAdd} className="hidden md:flex rounded-xl border border-cream-border bg-white p-5 flex-col gap-4">
      <div className="text-sm font-semibold text-foreground">Add Country</div>
      <div className="flex items-end gap-3">
        <label className="flex-1 min-w-0 flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-500">Country Name</span>
          <input
            {...field("name")}
            placeholder="Country name"
            required
            disabled={adding}
            className={`${formInputCls} w-full`}
          />
        </label>
        <label className="flex-1 min-w-0 flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-500">Currency</span>
          <input
            {...field("currency")}
            placeholder="Currency (e.g. CNY)"
            disabled={adding}
            className={`${formInputCls} w-full`}
          />
        </label>
        <label className="flex-1 min-w-0 flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-500">Shipping / kg (IDR)</span>
          <input
            {...field("cargoPerKg")}
            type="number"
            min="0"
            placeholder="Shipping / kg (IDR)"
            disabled={adding}
            className={`${formInputCls} w-full`}
          />
        </label>
      </div>
      <div className="flex items-end gap-3">
        <div className="flex-[2] min-w-0">
          <LiveIdrRate currency={form.currency} markupPct={markupPct} />
        </div>
        <label className="flex-1 min-w-0 flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-500">Rate</span>
          <input
            {...field("kurs")}
            type="number"
            min="0"
            step="any"
            placeholder="Kurs (IDR)"
            disabled={adding}
            className={`${formInputCls} w-full`}
          />
        </label>
      </div>
      <div className="flex items-center justify-end gap-2">
        {addError && <p className="mr-auto text-xs text-red-500">{addError}</p>}
        <button
          type="button"
          onClick={() => { setAddOpen(false); setAddError(null) }}
          disabled={adding}
          className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={adding}
          className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors shrink-0"
        >
          {adding ? "Saving…" : "Add"}
        </button>
      </div>
    </form>
  )

  return (
    <div className="flex flex-col gap-6">
      {/* Data grid */}
      {loading && <TableSkeleton />}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {!loading && !error && data && (
        <DataGrid
          data={data}
          columns={columns}
          pageSize={25}
          searchPlaceholder="Search countries…"
          fullWidthSearch
          tightToolbar
          boldUppercaseHeader
          toolbarExtraAfterColumns
          hideRowCount
          belowToolbar={addOpen ? addForm : undefined}
          toolbarExtra={
            <button
              type="button"
              onClick={() => setAddOpen((o) => !o)}
              className={`hidden md:inline-flex items-center gap-1.5 h-[38px] px-3 text-sm rounded-lg border transition-colors ${
                addOpen ? "bg-brand-light text-brand border-brand/30" : "bg-brand text-white border-transparent hover:bg-brand-hover"
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Add Country
            </button>
          }
          getRowId={(row) => String(row.id)}
          initialVisibility={{ createdAt: false, updatedAt: false }}
          initialSorting={[{ id: "name", desc: false }]}
          renderMobileCard={renderMobileCard}
        />
      )}

      {/* Edit modal */}
      {editRow && (
        <EditCountryModal
          row={editRow}
          onSave={(updated) => {
            setData((prev) =>
              prev?.map((r) => r.id === editRow.id ? { ...r, ...updated } : r) ?? null
            )
            setEditRow(null)
          }}
          onCancel={() => setEditRow(null)}
          onDelete={() => { const r = editRow; setEditRow(null); handleDelete(r) }}
          markupPct={markupPct}
        />
      )}

      {/* Mobile add FAB */}
      <button
        type="button"
        onClick={() => setMobileAddOpen(true)}
        aria-label="Add country"
        className="md:hidden fixed right-4 bottom-20 z-30 w-14 h-14 rounded-full bg-brand text-white text-3xl leading-none shadow-lg flex items-center justify-center active:bg-brand/90"
      >
        +
      </button>

      {/* Mobile add sheet */}
      {mobileAddOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex items-end bg-black/40" onClick={() => setMobileAddOpen(false)}>
          <form onSubmit={handleAdd} onClick={(e) => e.stopPropagation()} className="w-full bg-white rounded-t-2xl p-5 pb-8 flex flex-col gap-4">
            <div className="flex items-center justify-between -mx-5 px-5 border-b border-cream-border pb-3">
              <span className="text-base font-semibold text-foreground">Add Country</span>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500">Country Name</span>
              <input {...field("name")} placeholder="Country name" required disabled={adding} className={modalInputCls} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500">Currency</span>
              <input {...field("currency")} placeholder="Currency (e.g. CNY)" disabled={adding} className={modalInputCls} />
            </label>
            <LiveIdrRate currency={form.currency} markupPct={markupPct} />
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500">Rate</span>
              <input {...field("kurs")} type="number" min="0" step="any" placeholder="Kurs (IDR)" disabled={adding} className={modalInputCls} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500">Shipping / kg (IDR)</span>
              <input {...field("cargoPerKg")} type="number" min="0" placeholder="Shipping / kg (IDR)" disabled={adding} className={modalInputCls} />
            </label>
            {addError && <p className="text-xs text-red-500">{addError}</p>}
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={() => setMobileAddOpen(false)} disabled={adding} className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={adding} className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors">
                {adding ? "Saving…" : "Add"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

// ─── Edit modal ────────────────────────────────────────────────────────────

function EditCountryModal({
  row,
  onSave,
  onCancel,
  onDelete,
  markupPct = 5,
}: {
  row: CountryRow
  onSave: (updated: Partial<CountryRow>) => void
  onCancel: () => void
  onDelete: () => void
  markupPct?: number
}) {
  const [draft, setDraft] = useState({
    name: row.name,
    currency: row.currency,
    kurs: String(row.kurs),
    cargoPerKg: String(row.cargoPerKg),
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const firstInputRef = useRef<HTMLInputElement>(null)

  // Autofocus the name field on desktop only — on mobile it pops the keyboard
  // over the sheet before the user has chosen to edit anything.
  useEffect(() => { if (window.innerWidth >= 768) firstInputRef.current?.focus() }, [])

  function draftField(key: keyof typeof draft) {
    return {
      value: draft[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setDraft((d) => ({ ...d, [key]: e.target.value })),
      disabled: saving,
    }
  }

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    const kurs = Number(draft.kurs) || 0
    const cargoPerKg = Number(draft.cargoPerKg) || 0
    try {
      const res = await fetch(`/api/sheets/countries/${row.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name.trim(),
          currency: draft.currency.trim(),
          kurs,
          cargoPerKg,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      onSave({ name: draft.name.trim(), currency: draft.currency.trim(), kurs, cargoPerKg })
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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center md:px-4" onClick={onCancel}>
      <div
        className="bg-white rounded-t-2xl md:rounded-xl border-x border-t border-cream-border md:border shadow-xl p-6 pb-8 md:pb-6 w-full max-h-[90vh] overflow-y-auto flex flex-col gap-4 md:max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between -mx-6 px-6 border-b border-cream-border pb-3 md:mx-0 md:px-0 md:border-b-0 md:pb-0">
          <span className="text-base md:text-sm font-semibold text-foreground">Edit Country</span>
          <span className="text-xs text-gray-400">ID: {row.id}</span>
        </div>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500">Country Name</span>
              <input
                ref={firstInputRef}
                {...draftField("name")}
                onKeyDown={handleKeyDown}
                placeholder="Country"
                className={modalInputCls}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500">Currency</span>
              <input
                {...draftField("currency")}
                onKeyDown={handleKeyDown}
                placeholder="Currency"
                className={modalInputCls}
              />
            </label>
          </div>
          <LiveIdrRate currency={draft.currency} markupPct={markupPct} />
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500">Rate</span>
              <input
                {...draftField("kurs")}
                onKeyDown={handleKeyDown}
                type="number"
                min="0"
                step="any"
                placeholder="Kurs"
                className={modalInputCls}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500">Shipping / kg (IDR)</span>
              <input
                {...draftField("cargoPerKg")}
                onKeyDown={handleKeyDown}
                type="number"
                min="0"
                placeholder="Shipping per kg"
                className={modalInputCls}
              />
            </label>
          </div>
        </div>

        {saveError && <p className="text-xs text-red-500">{saveError}</p>}

        <div className="flex items-center gap-2 pt-2">
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
