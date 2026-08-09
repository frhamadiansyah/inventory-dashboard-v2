"use client"

import { useState } from "react"
import type { InvoiceEvent } from "@/lib/db"
import { useCopyFeedback } from "@/hooks/useCopyFeedback"
import { useModalDismiss } from "@/hooks/useModalDismiss"

// Build a WhatsApp deep link with the message prefilled. Indonesian numbers are
// normalized to international (0… → 62…, 8… → 62…). Without a number we fall
// back to the send picker so the user can choose a chat.
function waLink(whatsapp: string | null | undefined, message: string): string {
  const text = encodeURIComponent(message)
  let num = (whatsapp ?? "").replace(/\D/g, "")
  if (num.startsWith("0")) num = "62" + num.slice(1)
  else if (num.startsWith("8")) num = "62" + num
  return num ? `https://wa.me/${num}?text=${text}` : `https://api.whatsapp.com/send?text=${text}`
}

export function InvoiceMessageActions({ event, whatsapp }: { event: InvoiceEvent; whatsapp?: string | null }) {
  const [open, setOpen] = useState(false)
  const { copied, copy } = useCopyFeedback()
  const { message } = event

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors"
      >
        View message
      </button>
      <button
        type="button"
        onClick={() => copy(message)}
        className="shrink-0 px-3 py-1.5 rounded-lg border border-brand text-brand text-xs font-medium hover:bg-brand hover:text-white transition-colors"
      >
        {copied ? "Copied!" : "Copy message"}
      </button>
      {open && (
        <InvoiceMessageModal
          message={message}
          whatsapp={whatsapp}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

function InvoiceMessageModal({
  message,
  whatsapp,
  onClose,
}: {
  message: string
  whatsapp?: string | null
  onClose: () => void
}) {
  const { copied, copy } = useCopyFeedback()

  useModalDismiss(onClose)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-3 border-b border-cream-border flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">Invoice message</div>
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
        <pre className="px-5 py-4 overflow-auto text-sm text-foreground whitespace-pre-wrap font-sans flex-1">
          {message}
        </pre>
        <div className="px-5 py-3 border-t border-cream-border flex justify-end gap-2">
          <button
            type="button"
            onClick={() => copy(message)}
            className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
          <a
            href={waLink(whatsapp, message)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M17.5 14.4c-.3-.15-1.77-.87-2.04-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51-.17-.01-.37-.01-.57-.01-.2 0-.52.07-.8.37-.27.3-1.05 1.02-1.05 2.5s1.07 2.9 1.22 3.1c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.7.62.71.23 1.36.2 1.87.12.57-.08 1.77-.72 2.02-1.42.25-.7.25-1.3.17-1.42-.07-.12-.27-.2-.57-.35zM12.05 21.5h-.01a9.4 9.4 0 0 1-4.8-1.32l-.34-.2-3.57.94.95-3.48-.22-.36a9.42 9.42 0 0 1-1.44-5.02c0-5.2 4.24-9.44 9.45-9.44 2.52 0 4.89.98 6.67 2.77a9.38 9.38 0 0 1 2.76 6.68c0 5.2-4.24 9.44-9.45 9.44zm8.04-17.49A11.36 11.36 0 0 0 12.05.5C5.8.5.72 5.58.72 11.83c0 2 .52 3.95 1.51 5.67L.63 23.5l6.14-1.61a11.33 11.33 0 0 0 5.28 1.34h.01c6.25 0 11.33-5.08 11.33-11.33 0-3.03-1.18-5.87-3.32-8.01z" />
            </svg>
            Send message
          </a>
        </div>
      </div>
    </div>
  )
}
