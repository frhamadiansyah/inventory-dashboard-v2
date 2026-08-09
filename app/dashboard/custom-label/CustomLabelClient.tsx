"use client"

import { useEffect, useRef, useState } from "react"
import { generateShippingLabel } from "@/lib/shipping-label"

const FIELD =
  "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
const LABEL = "text-sm font-medium text-foreground mb-1.5 block"

export default function CustomLabelClient() {
  const [event, setEvent] = useState("")
  const [customer, setCustomer] = useState("")
  const [shippingId, setShippingId] = useState("")
  const [dataDiri, setDataDiri] = useState("")
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)

  const urlRef = useRef<string | null>(null)
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current) }, [])

  async function handleGenerate() {
    setGenerating(true)
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
      setPdfUrl(null)
    }
    try {
      const blob = await generateShippingLabel({
        event,
        customer,
        shippingId,
        dataDiri,
        packingLines: [],
      })
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      setPdfUrl(url)
    } finally {
      setGenerating(false)
    }
  }

  const canGenerate = Boolean(shippingId.trim()) && !generating

  return (
    <div className="flex flex-col md:flex-row gap-6 md:items-start">
      {/* Form */}
      <div className="w-full md:w-72 md:shrink-0">
        <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
          <div className="px-5 py-4 border-b border-cream-border bg-cream">
            <p className="text-xs text-gray-500">
              Fill in the fields and generate a custom shipping label PDF.
            </p>
          </div>
          <div className="p-5 space-y-4">
            <div>
              <label className={LABEL}>Event</label>
              <input
                type="text"
                value={event}
                onChange={(e) => setEvent(e.target.value)}
                placeholder="e.g. LSMD202604"
                className={FIELD}
              />
            </div>
            <div>
              <label className={LABEL}>Customer</label>
              <input
                type="text"
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
                placeholder="e.g. tree.deco"
                className={FIELD}
              />
            </div>
            <div>
              <label className={LABEL}>
                Shipping ID <span className="text-brand">*</span>
              </label>
              <input
                type="text"
                value={shippingId}
                onChange={(e) => setShippingId(e.target.value)}
                placeholder="e.g. 0042"
                className={FIELD}
              />
            </div>
            <div>
              <label className={LABEL}>PENERIMA</label>
              <textarea
                value={dataDiri}
                onChange={(e) => setDataDiri(e.target.value)}
                rows={5}
                placeholder={"Nama Penerima\nAlamat lengkap\nNo. telepon"}
                className={FIELD + " resize-none"}
              />
            </div>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!canGenerate}
              className="w-full py-2 text-sm font-medium rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {generating ? "Generating…" : "Generate Label"}
            </button>
          </div>
        </div>
      </div>

      {/* Preview */}
      {pdfUrl && (
        <div className="flex-1 rounded-xl border border-cream-border bg-white overflow-hidden flex flex-col" style={{ minHeight: "600px" }}>
          <div className="px-5 py-3 border-b border-cream-border bg-cream flex items-center justify-between shrink-0">
            <span className="text-sm font-medium text-foreground">Preview</span>
            <a
              href={pdfUrl}
              download={`label-${shippingId}.pdf`}
              className="text-xs font-medium text-brand hover:underline"
            >
              Download PDF
            </a>
          </div>
          <iframe
            src={pdfUrl}
            title="Custom Label"
            className="flex-1 w-full border-0 min-h-0"
          />
        </div>
      )}
    </div>
  )
}
