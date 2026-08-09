"use client"

import { useEffect, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { PaymentStatusPanel } from "./PaymentStatusPanel"
import { InvoiceDetailDrawer } from "./InvoiceDetailDrawer"

export default function InvoiceClient() {
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const [selectedCustomer, setSelectedCustomer] = useState<string | null>(null)

  // Deep-link support: ?customer=X auto-opens the drawer (used by the
  // refunds page "Open full invoice" button).
  const queryCustomer = searchParams.get("customer")
  useEffect(() => {
    if (queryCustomer) setSelectedCustomer(queryCustomer)
  }, [queryCustomer])

  function handleDrawerClose() {
    setSelectedCustomer(null)
    // Strip the customer query param so reopening the same row triggers a
    // fresh fetch (and the URL stays clean).
    if (queryCustomer) router.replace(pathname, { scroll: false })
  }

  return (
    <div>
      <PaymentStatusPanel onOpenCustomer={setSelectedCustomer} />
      {selectedCustomer && (
        <InvoiceDetailDrawer
          customer={selectedCustomer}
          onClose={handleDrawerClose}
        />
      )}
    </div>
  )
}
