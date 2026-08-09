// Template for the WhatsApp confirmation message sent to a customer after
// (or while) their package is being shipped. Used by:
//   - /dashboard/shipments  (post-ship)  — items come from shipments.invoicing
//   - /dashboard/ship       (packing)    — items come from the ready-to-ship rows
//
// `dataDiri` is the free-text address blob the customer wrote at registration —
// it usually contains their name, phone, and full address on separate lines,
// so we paste it verbatim instead of breaking it into labeled fields.

import { displayIg } from "./format"
import { fillTemplate, DEFAULT_TEMPLATES } from "./message-templates"
import { DEFAULT_BUSINESS_PROFILE } from "./business-profile"

export interface ShipmentConfirmMessageInput {
  /** Event id, or "EVT1 + EVT2" for a merged shipment. */
  event: string
  /** Customer instagram handle in any stored form; the "@" is stripped. */
  customer: string
  /** Customer's free-text address blob. Pasted verbatim. */
  dataDiri: string
  /**
   * One line per packed line item, already formatted as "Product x N".
   * Caller decides whether to consolidate or keep one entry per order row.
   */
  items: string[]
}

export function buildShipmentConfirmMessage(
  input: ShipmentConfirmMessageInput,
  template: string = DEFAULT_TEMPLATES.shipment,
  publicSiteUrl: string = DEFAULT_BUSINESS_PROFILE.publicSiteUrl,
): string {
  const { event, customer, dataDiri, items } = input
  const handle = displayIg(customer)
  return fillTemplate(template, {
    event,
    handle,
    dataDiri,
    items: items.join("\n"),
    publicSiteUrl,
  })
}
