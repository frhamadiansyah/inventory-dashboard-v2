import type { ReceivedReportItem } from "@/lib/db"

// Brand red (matches --brand in globals.css), as RGB for jsPDF.
const BRAND: [number, number, number] = [0x7b, 0x1a, 0x1a]

export interface ReceivedReportData {
  event: string
  from: string | null // YYYY-MM-DD (inclusive); null = no date filter (all dates)
  to: string | null // YYYY-MM-DD (inclusive); equals `from` for a single day
  items: ReceivedReportItem[]
  totalUnits: number
}

// "25 Jun 2026" for a single day, "20 – 22 Jun 2026" / "29 Jun – 02 Jul 2026"
// for a range. Plain YYYY-MM-DD strings, formatted without timezone math.
function formatRange(from: string, to: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const parts = (d: string) => {
    const [y, m, day] = d.split("-").map(Number)
    return { y, m: months[m - 1] ?? "?", day }
  }
  const a = parts(from)
  const b = parts(to)
  const one = (p: { y: number; m: string; day: number }) => `${String(p.day).padStart(2, "0")} ${p.m} ${p.y}`
  if (from === to) return one(a)
  if (a.y === b.y && a.m === b.m) return `${String(a.day).padStart(2, "0")} – ${one(b)}`
  if (a.y === b.y) return `${String(a.day).padStart(2, "0")} ${a.m} – ${one(b)}`
  return `${one(a)} – ${one(b)}`
}

// A4 portrait, millimetres.
const PAGE_W = 210
const PAGE_H = 297
const MARGIN = 14
const CONTENT_W = PAGE_W - MARGIN * 2
const BOTTOM = PAGE_H - MARGIN

// Column x-positions / widths. Units is right-aligned at the right edge.
// Columns: EVENT · RECEIPT · PRODUCT · UNITS (store intentionally omitted).
const COL_EVENT_X = MARGIN
const COL_RECEIPT_X = MARGIN + 36
const COL_PRODUCT_X = MARGIN + 78
const COL_UNITS_R = PAGE_W - MARGIN
const PRODUCT_W = COL_UNITS_R - COL_PRODUCT_X - 14
const EVENT_W = COL_RECEIPT_X - COL_EVENT_X - 3
const RECEIPT_W = COL_PRODUCT_X - COL_RECEIPT_X - 3

const LINE_H = 5

/**
 * Build the printable "Items Received" report as a PDF Blob. Per-product totals
 * in the query's order (event → dispatch receipt → store → product). Mirrors the
 * client-side jsPDF approach in lib/shipping-label.ts (hand-drawn table, no
 * autotable dependency) and returns a Blob for the standard download flow.
 */
export async function generateReceivedReport({
  event,
  from,
  to,
  items,
  totalUnits,
}: ReceivedReportData): Promise<Blob> {
  const { default: jsPDF } = await import("jspdf")
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" })

  // Date subtitle: the range when given, else "All dates".
  const dateText = from && to ? formatRange(from, to) : "All dates"

  let y = MARGIN

  function header() {
    doc.setTextColor(...BRAND)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(16)
    doc.text("YUBISAYU", MARGIN, y + 4)
    doc.setFontSize(13)
    doc.text(`Items Received · ${event}`, MARGIN, y + 11)

    doc.setTextColor(80)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(11)
    doc.text(dateText, COL_UNITS_R, y + 11, { align: "right" })

    doc.setDrawColor(...BRAND)
    doc.setLineWidth(0.4)
    doc.line(MARGIN, y + 14, PAGE_W - MARGIN, y + 14)
    y += 20
  }

  function columnHeads() {
    doc.setTextColor(120)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(8.5)
    doc.text("EVENT", COL_EVENT_X, y)
    doc.text("RECEIPT", COL_RECEIPT_X, y)
    doc.text("PRODUCT", COL_PRODUCT_X, y)
    doc.text("UNITS", COL_UNITS_R, y, { align: "right" })
    y += 2
    doc.setDrawColor(220)
    doc.setLineWidth(0.2)
    doc.line(MARGIN, y, PAGE_W - MARGIN, y)
    y += 4
  }

  header()
  columnHeads()

  if (items.length === 0) {
    doc.setTextColor(120)
    doc.setFont("helvetica", "italic")
    doc.setFontSize(11)
    doc.text("No items were received in this period.", MARGIN, y + 4)
    return doc.output("blob")
  }

  doc.setTextColor(30)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(10)

  for (const item of items) {
    const productLines = doc.splitTextToSize(item.productName, PRODUCT_W) as string[]
    const eventLines = doc.splitTextToSize(item.event, EVENT_W) as string[]
    const receiptLines = doc.splitTextToSize(item.dispatchReceipt || "—", RECEIPT_W) as string[]
    const rowH = Math.max(productLines.length, eventLines.length, receiptLines.length) * LINE_H

    // Page break before drawing a row that would overflow.
    if (y + rowH > BOTTOM) {
      doc.addPage()
      y = MARGIN
      columnHeads()
      doc.setTextColor(30)
      doc.setFont("helvetica", "normal")
      doc.setFontSize(10)
    }

    doc.text(eventLines, COL_EVENT_X, y + 3.5)
    doc.text(receiptLines, COL_RECEIPT_X, y + 3.5)
    doc.text(productLines, COL_PRODUCT_X, y + 3.5)
    doc.text(String(item.unitsReceived), COL_UNITS_R, y + 3.5, { align: "right" })

    y += rowH + 1
    doc.setDrawColor(235)
    doc.setLineWidth(0.1)
    doc.line(MARGIN, y - 0.5, PAGE_W - MARGIN, y - 0.5)
  }

  // Grand total.
  y += 2
  if (y + 8 > BOTTOM) {
    doc.addPage()
    y = MARGIN
  }
  doc.setDrawColor(...BRAND)
  doc.setLineWidth(0.4)
  doc.line(MARGIN, y, PAGE_W - MARGIN, y)
  y += 6
  doc.setFont("helvetica", "bold")
  doc.setFontSize(11)
  doc.setTextColor(...BRAND)
  doc.text("TOTAL UNITS RECEIVED", COL_EVENT_X, y)
  doc.text(String(totalUnits), COL_UNITS_R, y, { align: "right" })

  return doc.output("blob")
}
