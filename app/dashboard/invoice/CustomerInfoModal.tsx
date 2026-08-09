"use client"

import { displayIg } from "@/lib/format"
import type { CustomerDetail } from "@/lib/db"
import { useModalDismiss } from "@/hooks/useModalDismiss"

export function CustomerInfoModal({
  customer,
  detail,
  onClose,
}: {
  customer: string
  detail: CustomerDetail
  onClose: () => void
}) {
  useModalDismiss(onClose)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-3 border-b border-cream-border flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">{displayIg(customer).toUpperCase()}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-foreground transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <div className="px-5 py-4 flex flex-col gap-3 text-sm">
          {detail.whatsapp && (
            <div>
              <div className="text-xs font-medium text-gray-500 mb-0.5">WhatsApp</div>
              <div className="text-foreground">{detail.whatsapp}</div>
            </div>
          )}
          {detail.dataDiri && (
            <div>
              <div className="text-xs font-medium text-gray-500 mb-0.5">Data Diri</div>
              <pre className="whitespace-pre-wrap font-sans text-foreground leading-relaxed">{detail.dataDiri}</pre>
            </div>
          )}
          {detail.ekspedisi && (
            <div>
              <div className="text-xs font-medium text-gray-500 mb-0.5">Ekspedisi</div>
              <div className="text-foreground">{detail.ekspedisi}</div>
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-cream-border flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
