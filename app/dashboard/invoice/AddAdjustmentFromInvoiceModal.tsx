"use client"

import { useEffect, useMemo, useState } from "react"
import { displayIg } from "@/lib/format"
import SearchableSelect from "@/components/SearchableSelect"
import { useModalDismiss } from "@/hooks/useModalDismiss"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import { descriptionOptions, AmountSignHint } from "../adjustments/shared"

const INPUT_CLASS =
  "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

// Mirrors PaymentsClient: distinct accounts already in use come from
// useSheetOptions().accounts; this is the fallback when that list is empty.
const FALLBACK_ACCOUNTS = ["BCA", "JAGO", "QRIS", "TRANSFER"]

type Tab = "payment" | "adjustment"

export function AddAdjustmentFromInvoiceModal({
  event,
  customer,
  onClose,
  onSaved,
}: {
  event: string
  customer: string
  onClose: () => void
  onSaved: () => void
}) {
  useModalDismiss(onClose)
  const options = useSheetOptions()

  const [tab, setTab] = useState<Tab>("payment")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Which action completed (drives the success screen), or null while editing.
  const [done, setDone] = useState<Tab | null>(null)

  // Payment fields.
  const [payAmount, setPayAmount] = useState("")
  const [account, setAccount] = useState("BCA")
  const [payDate, setPayDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [remarks, setRemarks] = useState("")

  // Adjustment fields.
  const [description, setDescription] = useState("")
  const [adjAmount, setAdjAmount] = useState("")
  const [dbDescriptions, setDbDescriptions] = useState<string[]>([])

  // Pull in previously-typed descriptions so they show up as suggestions.
  useEffect(() => {
    fetch("/api/sheets/adjustments?meta=descriptions")
      .then((res) => res.json())
      .then((data) => setDbDescriptions(data.descriptions ?? []))
      .catch(() => {})
  }, [])

  const descOptions = useMemo(() => descriptionOptions([...dbDescriptions, description]), [dbDescriptions, description])
  const accountOptions = useMemo(
    () => (options?.accounts ?? FALLBACK_ACCOUNTS).map((a) => ({ value: a, label: a })),
    [options],
  )

  // Switching tabs clears any inline error but keeps each tab's field values.
  function switchTab(t: Tab) {
    setTab(t)
    setError(null)
  }

  const canSubmitPayment = Boolean(payAmount) && Number(payAmount) > 0 && Number.isFinite(Number(payAmount))
  const canSubmitAdjustment = Boolean(adjAmount) && Number(adjAmount) !== 0 && Number.isFinite(Number(adjAmount))
  const canSubmit = tab === "payment" ? canSubmitPayment : canSubmitAdjustment

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    try {
      if (tab === "payment") {
        const res = await fetch("/api/sheets/payments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event, customer, amount: Number(payAmount), account, isChecked: false, payDate, remarks }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to save")
        setDone("payment")
      } else {
        const res = await fetch("/api/sheets/adjustments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event, customer, description, amount: Number(adjAmount) }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to save")
        setDone("adjustment")
      }
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center md:bg-black/30 md:px-4" onClick={onClose}>
      <form
        className="bg-white rounded-t-2xl md:rounded-xl border-x border-t border-cream-border md:border shadow-xl w-full md:max-w-sm flex flex-col gap-4 p-5 pb-8 md:p-6"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="-mx-5 px-5 border-b border-cream-border pb-3 md:mx-0 md:px-0 md:border-b-0 md:pb-0">
          <div className="text-xs text-gray-400">
            {displayIg(customer)} · {event}
          </div>
        </div>

        {done ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-500">
              <circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" />
            </svg>
            <p className="text-sm font-medium text-foreground">{done === "payment" ? "Payment added" : "Adjustment added"}</p>
            <button type="button" onClick={onClose} className="mt-1 px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 transition-colors">
              Done
            </button>
          </div>
        ) : (
          <>
            {/* Tabs */}
            <div className="flex rounded-lg border border-cream-border overflow-hidden text-sm">
              {([["payment", "Add Payment"], ["adjustment", "Add Adjustment"]] as const).map(([t, label]) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => switchTab(t)}
                  className={`flex-1 px-3 py-2 font-medium transition-colors ${tab === t ? "bg-brand text-white" : "text-gray-500 hover:bg-cream"}`}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === "payment" ? (
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-gray-500">Amount (Rp) <span className="text-brand">*</span></span>
                  <input
                    type="number"
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                    disabled={saving}
                    placeholder="0"
                    className={INPUT_CLASS}
                    autoFocus
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-gray-500">Account</span>
                  <SearchableSelect
                    value={account}
                    onChange={setAccount}
                    options={accountOptions}
                    placeholder="Select or type…"
                    allowNewValue
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-gray-500">Date</span>
                  <input
                    type="date"
                    value={payDate}
                    onChange={(e) => setPayDate(e.target.value)}
                    disabled={saving}
                    className={INPUT_CLASS}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-gray-500">Remarks <span className="text-gray-400 font-normal">(optional)</span></span>
                  <input
                    type="text"
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    disabled={saving}
                    placeholder="e.g. DP, transfer ref…"
                    className={INPUT_CLASS}
                  />
                </label>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-gray-500">Description</span>
                  <SearchableSelect
                    value={description}
                    onChange={setDescription}
                    options={descOptions}
                    placeholder="Select or type…"
                    allowNewValue
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-gray-500">Amount (Rp) <span className="text-brand">*</span></span>
                  <input
                    type="number"
                    value={adjAmount}
                    onChange={(e) => setAdjAmount(e.target.value)}
                    disabled={saving}
                    placeholder="0"
                    className={INPUT_CLASS}
                    autoFocus
                  />
                  <AmountSignHint value={adjAmount} />
                </label>
              </div>
            )}

            {error && <p className="text-xs text-red-500">{error}</p>}

            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={saving || !canSubmit} className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors">
                {saving ? "Saving…" : "Add"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}
