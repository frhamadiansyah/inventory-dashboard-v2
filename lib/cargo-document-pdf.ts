// Brand red (matches --brand in globals.css), as RGB for jsPDF.
const BRAND: [number, number, number] = [0x7b, 0x1a, 0x1a]

export interface CargoDocLine {
  productName: string
  qty: number
  valas: number // unit price in `currency`
  currency: string // currency code, e.g. "USD"; "" when the product has none
  receipt?: string // optional dispatch receipt; shown as a RECEIPT column when present
}

export interface CargoDocData {
  name?: string // optional document title, e.g. "Box 3"
  date: string // YYYY-MM-DD — shown top-right in the header
  lines: CargoDocLine[]
}

// "25 Jun 2026" from a plain YYYY-MM-DD string, no timezone math.
function formatDate(d: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const [y, m, day] = d.split("-").map(Number)
  return `${String(day).padStart(2, "0")} ${months[m - 1] ?? "?"} ${y}`
}

// Money with thousands separators and up to 2 decimals (drops trailing zeros).
const fmtNum = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })

// A4 portrait, millimetres. Mirrors lib/receiving-report-pdf.ts.
const PAGE_W = 210
const PAGE_H = 297
const MARGIN = 14
const CONTENT_W = PAGE_W - MARGIN * 2
const BOTTOM = PAGE_H - MARGIN

// Column anchors. Item is left-aligned; qty / unit price / line total are
// right-aligned at fixed x-positions across the page width.
const COL_ITEM_X = MARGIN
const COL_TOTAL_R = PAGE_W - MARGIN
const COL_PRICE_R = COL_TOTAL_R - 42
const COL_QTY_R = COL_PRICE_R - 28

const LINE_H = 5

/**
 * Build the printable cargo document as a PDF Blob: selected receiving-list
 * items with quantity and foreign-currency price. Lines are grouped by currency
 * with a subtotal per currency (no cross-currency grand total — you can't add
 * USD to CNY). Mirrors the hand-drawn jsPDF table in lib/receiving-report-pdf.ts.
 */
export async function generateCargoDocument({ name, date, lines }: CargoDocData): Promise<Blob> {
  const { default: jsPDF } = await import("jspdf")
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" })

  let y = MARGIN

  // Optional RECEIPT column (before ITEM), shown only when some line carries a
  // dispatch receipt (the dispatch-document flow). The in-list cargo panel has
  // no receipts, so its layout is unchanged.
  const hasReceipt = lines.some((l) => !!l.receipt && l.receipt.trim() !== "")
  const RECEIPT_W = 30
  const receiptX = MARGIN
  const itemX = hasReceipt ? MARGIN + RECEIPT_W + 4 : COL_ITEM_X
  const itemW = COL_QTY_R - itemX - 22

  function header() {
    // The box name is the headline; fall back to the brand name when unset.
    const title = name || "YUBISAYU"
    doc.setTextColor(...BRAND)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(16)
    const titleLines = doc.splitTextToSize(title, CONTENT_W - 40) as string[]
    doc.text(titleLines, MARGIN, y + 4)
    doc.setFontSize(13)
    doc.text("Cargo Document", MARGIN, y + 11)

    // Date, top-right.
    doc.setTextColor(80)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(11)
    doc.text(formatDate(date), COL_TOTAL_R, y + 11, { align: "right" })

    doc.setDrawColor(...BRAND)
    doc.setLineWidth(0.4)
    doc.line(MARGIN, y + 14, PAGE_W - MARGIN, y + 14)
    y += 20
  }

  function columnHeads() {
    doc.setTextColor(120)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(8.5)
    if (hasReceipt) doc.text("RECEIPT", receiptX, y)
    doc.text("ITEM", itemX, y)
    doc.text("QTY", COL_QTY_R, y, { align: "right" })
    doc.text("UNIT PRICE", COL_PRICE_R, y, { align: "right" })
    doc.text("LINE TOTAL", COL_TOTAL_R, y, { align: "right" })
    y += 2
    doc.setDrawColor(220)
    doc.setLineWidth(0.2)
    doc.line(MARGIN, y, PAGE_W - MARGIN, y)
    y += 4
  }

  // Page-break helper: start a fresh page (re-drawing column heads) when the
  // next block of `need` mm wouldn't fit above the bottom margin.
  function ensureSpace(need: number) {
    if (y + need > BOTTOM) {
      doc.addPage()
      y = MARGIN
      columnHeads()
      doc.setTextColor(30)
      doc.setFont("helvetica", "normal")
      doc.setFontSize(10)
    }
  }

  header()
  columnHeads()

  // Group by currency, preserving first-seen order. "" → "—" label.
  const groups = new Map<string, CargoDocLine[]>()
  for (const line of lines) {
    const key = line.currency || ""
    const arr = groups.get(key) ?? []
    arr.push(line)
    groups.set(key, arr)
  }

  // The currency is shown per-line, so the group heading is redundant noise on a
  // single-currency document (the common case). Only label groups when the
  // document actually mixes currencies.
  const multiCurrency = groups.size > 1

  for (const [currency, groupLines] of groups) {
    const label = currency || "—"
    const suffix = currency ? ` ${currency}` : ""

    if (multiCurrency) {
      ensureSpace(8)
      doc.setFont("helvetica", "bold")
      doc.setFontSize(9.5)
      doc.setTextColor(...BRAND)
      doc.text(label, COL_ITEM_X, y + 3)
      y += 7
    }

    doc.setTextColor(30)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(10)

    let subtotal = 0
    let totalQty = 0
    for (const line of groupLines) {
      const productLines = doc.splitTextToSize(line.productName, itemW) as string[]
      const receiptLines = hasReceipt
        ? (doc.splitTextToSize(line.receipt || "—", RECEIPT_W) as string[])
        : []
      const rowH = Math.max(productLines.length, receiptLines.length || 1) * LINE_H
      ensureSpace(rowH)

      const lineTotal = line.qty * line.valas
      subtotal += lineTotal
      totalQty += line.qty

      if (hasReceipt) doc.text(receiptLines, receiptX, y + 3.5)
      doc.text(productLines, itemX, y + 3.5)
      doc.text(String(line.qty), COL_QTY_R, y + 3.5, { align: "right" })
      doc.text(`${fmtNum(line.valas)}${suffix}`, COL_PRICE_R, y + 3.5, { align: "right" })
      doc.text(`${fmtNum(lineTotal)}${suffix}`, COL_TOTAL_R, y + 3.5, { align: "right" })

      y += rowH + 1
      doc.setDrawColor(235)
      doc.setLineWidth(0.1)
      doc.line(MARGIN, y - 0.5, PAGE_W - MARGIN, y - 0.5)
    }

    // Per-currency subtotal.
    ensureSpace(8)
    y += 1
    doc.setDrawColor(...BRAND)
    doc.setLineWidth(0.3)
    doc.line(MARGIN, y, PAGE_W - MARGIN, y)
    y += 5
    doc.setFont("helvetica", "bold")
    doc.setFontSize(10)
    doc.setTextColor(...BRAND)
    doc.text("Subtotal", COL_ITEM_X, y)
    // Total qty aligns under the QTY column; money under LINE TOTAL.
    doc.text(String(totalQty), COL_QTY_R, y, { align: "right" })
    doc.text(`${fmtNum(subtotal)}${suffix}`, COL_TOTAL_R, y, { align: "right" })
    y += 8

    doc.setTextColor(30)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(10)
  }

  return doc.output("blob")
}
