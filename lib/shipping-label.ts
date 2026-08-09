const FROM_NAME = "YUBISAYU"
const FROM_PHONE = "081-1121-39-111"

export interface ShippingLabelParams {
  event: string
  customer: string
  shippingId: string
  dataDiri: string
  packingLines: string[] // each line: "Item Name x qty"
}

export async function generateMultipleShippingLabels(labels: ShippingLabelParams[]): Promise<Blob> {
  if (labels.length === 0) throw new Error("No labels to generate")

  const { default: jsPDF } = await import("jspdf")
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: [78, 100] })

  function drawLabel({ event, customer, shippingId, dataDiri, packingLines }: ShippingLabelParams) {
    const topMargin = 4
    const leadingMargin = 4
    const trailingMargin = 4
    const pageW = 78
    const pageH = 100
    const contentW = pageW - leadingMargin - trailingMargin
    const halfW = contentW / 2
    const x = leadingMargin

    // Row 1: event+customer (left) | shipping ID (right)
    const r1Y = topMargin
    const r1H = 16

    doc.setFontSize(10)
    doc.setFont("helvetica", "bold")
    const r1Lines = doc.splitTextToSize(`${event} ${customer.toUpperCase()}`, halfW - 4)
    doc.text(r1Lines.slice(0, 2), x + 2, r1Y + 7)

    doc.setFontSize(30)
    doc.setFont("helvetica", "bold")
    doc.text(shippingId, x + halfW + halfW / 2, r1Y + 12, { align: "center" })

    // Row 3: PENGIRIM — pinned to bottom
    const r3H = 16
    const r3Y = pageH - r3H

    // Row 2: PENERIMA — fills the space between row 1 and row 3
    const r2Y = r1Y + r1H + 1
    const r2H = r3Y - r2Y - 1

    doc.line(x, r2Y, x + contentW, r2Y)
    doc.setFontSize(12)
    doc.setFont("helvetica", "bold")
    doc.text("PENERIMA :", x + 2, r2Y + 7)
    doc.setFontSize(11)
    doc.setFont("helvetica", "bold")
    const toLines = doc.splitTextToSize(dataDiri, contentW - 4)
    doc.text(toLines, x + 2, r2Y + 13)

    doc.line(x, r3Y, x + contentW, r3Y)
    doc.setFontSize(12)
    doc.setFont("helvetica", "bold")
    doc.text("PENGIRIM :", x + 2, r3Y + 7)
    doc.setFontSize(11)
    doc.setFont("helvetica", "bold")
    doc.text(`${FROM_NAME}  ·  ${FROM_PHONE}`, x + 2, r3Y + 12)

  }

  // Order list — a separate label-sized page (or more, if the items overflow)
  // placed after each label, listing the customer's items. Skipped when there
  // are no items (e.g. the Custom Label flow passes an empty list).
  function drawOrderList({ event, customer, shippingId, packingLines }: ShippingLabelParams) {
    const m = 4
    const contentW = 78 - m * 2
    const x = m
    const lineH = 4.6
    const bottom = 100 - m

    doc.setFontSize(9)
    doc.setFont("helvetica", "normal")
    const wrapped: string[] = packingLines.flatMap((l) => doc.splitTextToSize(`• ${l}`, contentW))

    let idx = 0
    let cont = false
    do {
      doc.addPage([78, 100], "portrait")
      let y = m + 5

      doc.setFont("helvetica", "bold")
      doc.setFontSize(11)
      doc.text(cont ? "ORDER LIST (cont.)" : "ORDER LIST", x, y)
      doc.setFontSize(14)
      doc.text(shippingId, 78 - m, y, { align: "right" })

      y += 5
      doc.setFontSize(8)
      const hdr = doc.splitTextToSize(`${event}  ${customer.toUpperCase()}`, contentW).slice(0, 2)
      doc.text(hdr, x, y)
      y += hdr.length * 3.5 + 1.5
      doc.line(x, y, x + contentW, y)
      y += 4

      doc.setFont("helvetica", "normal")
      doc.setFontSize(9)
      while (idx < wrapped.length && y <= bottom) {
        doc.text(wrapped[idx], x, y)
        y += lineH
        idx++
      }
      cont = true
    } while (idx < wrapped.length)
  }

  for (let i = 0; i < labels.length; i++) {
    if (i > 0) doc.addPage([78, 100], "portrait")
    drawLabel(labels[i])
    if (labels[i].packingLines.length > 0) drawOrderList(labels[i])
  }

  return doc.output("blob")
}

export async function generateShippingLabel(params: ShippingLabelParams): Promise<Blob> {
  return generateMultipleShippingLabels([params])
}
