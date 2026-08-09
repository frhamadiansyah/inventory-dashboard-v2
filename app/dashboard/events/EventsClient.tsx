"use client"

import TableSkeleton from "@/components/TableSkeleton"
import { useEffect, useMemo, useRef, useState } from "react"
import type { EventRow, WarehouseRow, CountryRow, EventPerformance } from "@/lib/db"
import DataGrid, { type ColumnDef } from "@/components/DataGrid"
import ToggleSwitch from "@/components/ToggleSwitch"
import SearchableSelect from "@/components/SearchableSelect"
import EventPerformancePanel from "./EventPerformancePanel"

const EMPTY_FORM = { name: "", eta: "", warehouseId: "", countryId: "" }

const formInputCls = "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
const modalInputCls = "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors disabled:opacity-50"

export default function EventsClient() {
  const [data, setData] = useState<EventRow[] | null>(null)
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([])
  const [countries, setCountries] = useState<CountryRow[]>([])
  const [perfByName, setPerfByName] = useState<Map<string, EventPerformance>>(new Map())
  const [expandedMobile, setExpandedMobile] = useState<Record<number, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [form, setForm] = useState(EMPTY_FORM)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const [editRow, setEditRow] = useState<EventRow | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [mobileAddOpen, setMobileAddOpen] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [evRes, whRes, coRes, perfRes] = await Promise.all([
        fetch("/api/sheets/events"),
        fetch("/api/sheets/warehouses"),
        fetch("/api/sheets/countries"),
        fetch("/api/sheets/events/performance"),
      ])
      const evJson = await evRes.json()
      if (!evRes.ok) throw new Error(evJson.error ?? "Failed to load events")
      const whJson = await whRes.json()
      if (!whRes.ok) throw new Error(whJson.error ?? "Failed to load warehouses")
      const coJson = await coRes.json()
      if (!coRes.ok) throw new Error(coJson.error ?? "Failed to load countries")
      const perfJson = await perfRes.json()
      if (!perfRes.ok) throw new Error(perfJson.error ?? "Failed to load event performance")
      setData(evJson.rows as EventRow[])
      setWarehouses(whJson.rows as WarehouseRow[])
      setCountries(coJson.rows as CountryRow[])
      setPerfByName(new Map((perfJson.rows as EventPerformance[]).map((p) => [p.name, p])))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // Default the add-form warehouse to the default warehouse once loaded.
  useEffect(() => {
    if (warehouses.length > 0 && !form.warehouseId) {
      const def = warehouses.find((w) => w.isDefault) ?? warehouses[0]
      setForm((f) => ({ ...f, warehouseId: String(def.id) }))
    }
  }, [warehouses, form.warehouseId])

  const warehouseById = useMemo(
    () => new Map(warehouses.map((w) => [w.id, w])),
    [warehouses],
  )

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setAdding(true)
    setAddError(null)
    try {
      const res = await fetch("/api/sheets/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          eta: form.eta.trim(),
          warehouseId: form.warehouseId ? Number(form.warehouseId) : null,
          countryId: form.countryId ? Number(form.countryId) : null,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to add")
      setForm({ ...EMPTY_FORM, warehouseId: form.warehouseId })
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

  async function handleDelete(row: EventRow) {
    if (!confirm(`Delete event "${row.name}"? Orders using this event will be affected.`)) return
    try {
      const res = await fetch(`/api/sheets/events/${row.id}`, { method: "DELETE" })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      setData((prev) => prev?.filter((r) => r.id !== row.id) ?? null)
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  // Optimistic active/inactive flip: update the row immediately, revert if the
  // PATCH fails. Inactive events drop out of the List Order event picker.
  async function handleToggleActive(row: EventRow, next: boolean) {
    setData((prev) => prev?.map((r) => (r.id === row.id ? { ...r, isActive: next } : r)) ?? null)
    try {
      const res = await fetch(`/api/sheets/events/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: next }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed")
    } catch (err) {
      setData((prev) => prev?.map((r) => (r.id === row.id ? { ...r, isActive: !next } : r)) ?? null)
      alert(err instanceof Error ? err.message : "Failed to update")
    }
  }

  const columns = useMemo<ColumnDef<EventRow, unknown>[]>(() => [
    {
      accessorKey: "name",
      header: "Event Name",
      size: 200,
      filterFn: "textContains",
      enableHiding: false,
      cell: ({ row }) => (
        <span className="font-medium">{row.original.name}</span>
      ),
    },
    {
      accessorKey: "eta",
      header: "ETA",
      size: 160,
      filterFn: "textContains",
      cell: ({ getValue }) => {
        const v = getValue<string>()
        return <span className={`whitespace-nowrap ${v ? "text-foreground" : "text-gray-400"}`}>{v || "—"}</span>
      },
    },
    {
      accessorKey: "warehouseId",
      header: "Gudang",
      size: 110,
      filterFn: "textContains",
      cell: ({ getValue }) => {
        const wh = warehouseById.get(getValue<number>())
        return wh
          ? <span className="text-foreground">{wh.code}</span>
          : <span className="text-gray-400">—</span>
      },
    },
    {
      accessorKey: "countryName",
      header: "Country",
      size: 150,
      filterFn: "textContains",
      cell: ({ row }) => {
        const { countryName, currency } = row.original
        return countryName
          ? <span className="text-foreground">{countryName} <span className="text-gray-400">({currency})</span></span>
          : <span className="text-gray-400">— IDR</span>
      },
    },
    {
      accessorKey: "createdAt",
      header: "Created",
      size: 110,
      enableColumnFilter: false,
      cell: ({ getValue }) => {
        const v = getValue<string | null>()
        return v ? <span className="text-gray-400 text-xs whitespace-nowrap">{v}</span> : ""
      },
    },
    {
      accessorKey: "updatedAt",
      header: "Updated",
      size: 110,
      enableColumnFilter: false,
      cell: ({ getValue }) => {
        const v = getValue<string | null>()
        return v ? <span className="text-gray-400 text-xs whitespace-nowrap">{v}</span> : ""
      },
    },
    {
      id: "active",
      header: "Active",
      enableSorting: false,
      enableColumnFilter: false,
      enableHiding: false,
      size: 90,
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
  ], [warehouseById])


  const addForm = (
    <form onSubmit={handleAdd} className="hidden md:flex rounded-xl border border-cream-border bg-white p-5 flex-col gap-4">
      <div className="text-sm font-semibold text-foreground">Add Event</div>
      <div className="flex items-end gap-3 flex-wrap">
        <input
          {...field("name")}
          placeholder="Event name"
          required
          disabled={adding}
          className={`${formInputCls} flex-1 min-w-[10rem]`}
        />
        <input
          {...field("eta")}
          placeholder="ETA (e.g. 2026-06-15)"
          disabled={adding}
          className={formInputCls}
          style={{ width: "10rem" }}
        />
        <div style={{ width: "10rem" }}>
          <SearchableSelect
            value={form.warehouseId}
            onChange={(v) => setForm((f) => ({ ...f, warehouseId: v }))}
            options={warehouses.map((w) => ({ value: String(w.id), label: `${w.name} (${w.code})` }))}
            placeholder="Select gudang…"
            disabled={adding || warehouses.length === 0}
            searchable={false}
                alwaysShowAll
          />
        </div>
        <div style={{ width: "10rem" }}>
          <SearchableSelect
            value={form.countryId}
            onChange={(v) => setForm((f) => ({ ...f, countryId: v }))}
            options={countries.map((c) => ({ value: String(c.id), label: `${c.name} (${c.currency})` }))}
            placeholder="No country (IDR)"
            disabled={adding}
            searchable={false}
            clearable
            alwaysShowAll
          />
        </div>
        {addError && <p className="text-xs text-red-500">{addError}</p>}
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
      {/* Loading */}
      {loading && (
        <>
          <div className="hidden md:block"><TableSkeleton /></div>
          <div className="md:hidden rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-gray-400">Loading…</div>
        </>
      )}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {!loading && !error && data && (
        <>
          {/* Desktop table */}
          <div className="hidden md:block">
            <DataGrid
              data={data}
              columns={columns}
              pageSize={25}
              searchPlaceholder="Search events…"
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
                  Add Event
                </button>
              }
              getRowId={(row) => String(row.id)}
              initialVisibility={{ createdAt: false, updatedAt: false }}
              initialSorting={[{ id: "name", desc: false }]}
              rowClassName={(row) => (row.isActive ? "" : "opacity-60")}
              renderExpandedRow={(row) => <EventPerformancePanel perf={perfByName.get(row.name)} />}
            />
          </div>

          {/* Mobile cards */}
          <div className="md:hidden flex flex-col gap-2.5">
            {data.length === 0 && (
              <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-gray-400">No events yet</div>
            )}
            {data.map((ev) => {
              const isExpanded = Boolean(expandedMobile[ev.id])
              return (
              <div key={ev.id} className="rounded-xl border border-cream-border bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <div className="flex items-start justify-between gap-3 p-3.5">
                  <button
                    type="button"
                    onClick={() => setExpandedMobile((prev) => ({ ...prev, [ev.id]: !prev[ev.id] }))}
                    aria-expanded={isExpanded}
                    className="flex items-start gap-2 min-w-0 text-left"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`mt-0.5 shrink-0 text-gray-400 transition-transform ${isExpanded ? "rotate-90" : ""}`}><path d="m9 18 6-6-6-6" /></svg>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-foreground truncate">{ev.name}</span>
                      <span className={`block text-xs mt-0.5 ${ev.eta ? "text-gray-500" : "text-gray-400"}`}>
                        {ev.countryName ? ev.currency : "IDR"}
                        {` · ${ev.eta || "No ETA"}`}
                      </span>
                    </span>
                  </button>
                  <div className="shrink-0 flex items-center gap-1">
                  <ToggleSwitch
                    checked={ev.isActive}
                    onChange={(next) => handleToggleActive(ev, next)}
                    label={`Toggle ${ev.name} active`}
                  />
                  {/* Kebab opens Edit directly — tapping the row body still
                      expands/collapses the performance panel, unchanged. */}
                  <button
                    type="button"
                    onClick={() => setEditRow(ev)}
                    aria-label="Edit"
                    className="p-2 rounded-lg text-gray-400 active:bg-cream active:text-brand transition-colors"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
                    </svg>
                  </button>
                  </div>
                </div>
                {isExpanded && (
                  <div className="border-t border-cream-border">
                    <EventPerformancePanel perf={perfByName.get(ev.name)} />
                  </div>
                )}
              </div>
              )
            })}
          </div>
        </>
      )}

      {/* Mobile add FAB */}
      <button
        type="button"
        onClick={() => setMobileAddOpen(true)}
        aria-label="Add event"
        className="md:hidden fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 w-14 h-14 rounded-full bg-brand text-white text-3xl leading-none shadow-lg flex items-center justify-center active:bg-brand/90"
      >
        +
      </button>

      {/* Mobile add sheet */}
      {mobileAddOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex items-end bg-black/40" onClick={() => setMobileAddOpen(false)}>
          <form onSubmit={handleAdd} onClick={(e) => e.stopPropagation()} className="w-full bg-white rounded-t-2xl p-5 pb-8 flex flex-col gap-4">
            <div className="flex items-center justify-between -mx-5 px-5 border-b border-cream-border pb-3">
              <span className="text-base font-semibold text-foreground">Add Event</span>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500">Event Name</span>
              <input {...field("name")} placeholder="Event name" required disabled={adding} className={modalInputCls} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500">ETA</span>
              <input {...field("eta")} placeholder="ETA (e.g. 2026-06-15)" disabled={adding} className={modalInputCls} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500">Gudang</span>
              <SearchableSelect
                value={form.warehouseId}
                onChange={(v) => setForm((f) => ({ ...f, warehouseId: v }))}
                options={warehouses.map((w) => ({ value: String(w.id), label: `${w.name} (${w.code})` }))}
                placeholder="Select gudang…"
                disabled={adding || warehouses.length === 0}
                searchable={false}
                alwaysShowAll
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500">Country (sets expense currency &amp; kurs)</span>
              <SearchableSelect
                value={form.countryId}
                onChange={(v) => setForm((f) => ({ ...f, countryId: v }))}
                options={countries.map((c) => ({ value: String(c.id), label: `${c.name} (${c.currency})` }))}
                placeholder="No country (IDR)"
                disabled={adding}
                searchable={false}
                clearable
                alwaysShowAll
              />
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

      {/* Edit modal */}
      {editRow && (
        <EditEventModal
          row={editRow}
          warehouses={warehouses}
          countries={countries}
          onSave={(updated) => {
            setData((prev) =>
              prev?.map((r) => r.id === editRow.id ? { ...r, ...updated } : r) ?? null
            )
            setEditRow(null)
          }}
          onCancel={() => setEditRow(null)}
          onDelete={() => { const r = editRow; setEditRow(null); handleDelete(r) }}
        />
      )}
    </div>
  )
}

// ─── Edit modal ────────────────────────────────────────────────────────────

function EditEventModal({
  row,
  warehouses,
  countries,
  onSave,
  onCancel,
  onDelete,
}: {
  row: EventRow
  warehouses: WarehouseRow[]
  countries: CountryRow[]
  onSave: (updated: Partial<EventRow>) => void
  onCancel: () => void
  onDelete: () => void
}) {
  const [draft, setDraft] = useState({
    name: row.name,
    eta: row.eta,
    warehouseId: String(row.warehouseId),
    countryId: row.countryId != null ? String(row.countryId) : "",
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const firstInputRef = useRef<HTMLInputElement>(null)

  // Autofocus on desktop only — on mobile it pops the keyboard over the sheet.
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
    try {
      const res = await fetch(`/api/sheets/events/${row.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name.trim(),
          eta: draft.eta.trim(),
          warehouseId: draft.warehouseId ? Number(draft.warehouseId) : null,
          countryId: draft.countryId ? Number(draft.countryId) : null,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      const selectedCountry = countries.find((c) => String(c.id) === draft.countryId)
      onSave({
        name: draft.name.trim(),
        eta: draft.eta.trim(),
        warehouseId: Number(draft.warehouseId),
        countryId: draft.countryId ? Number(draft.countryId) : null,
        countryName: selectedCountry?.name ?? "",
        currency: selectedCountry?.currency ?? "",
        kurs: selectedCountry?.kurs ?? 0,
      })
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
          <span className="text-base md:text-sm font-semibold text-foreground">Edit Event</span>
          <span className="text-xs text-gray-400">ID: {row.id}</span>
        </div>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Event Name</span>
            <input
              ref={firstInputRef}
              {...draftField("name")}
              onKeyDown={handleKeyDown}
              placeholder="Event name"
              className={modalInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">ETA</span>
            <input
              {...draftField("eta")}
              onKeyDown={handleKeyDown}
              placeholder="ETA (e.g. 2026-06-15)"
              className={modalInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Gudang</span>
            <SearchableSelect
              value={draft.warehouseId}
              onChange={(v) => setDraft((d) => ({ ...d, warehouseId: v }))}
              options={warehouses.map((w) => ({ value: String(w.id), label: `${w.name} (${w.code})` }))}
              placeholder="Select gudang…"
              disabled={saving || warehouses.length === 0}
              searchable={false}
                alwaysShowAll
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Country (sets expense currency &amp; kurs)</span>
            <SearchableSelect
              value={draft.countryId}
              onChange={(v) => setDraft((d) => ({ ...d, countryId: v }))}
              options={countries.map((c) => ({ value: String(c.id), label: `${c.name} (${c.currency})` }))}
              placeholder="No country (IDR)"
              disabled={saving}
              searchable={false}
              clearable
              alwaysShowAll
            />
          </label>
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
