# Dispatch Document Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a "download document" bar to the Dispatch List page that reprints a cargo-style manifest of dispatched lines, filtered by event (required) + dispatch_receipt (optional substring).

**Architecture:** New `getDispatchDocument(event, receipt?)` aggregates dispatched order lines per product → `GET /api/sheets/dispatch-report` → `DispatchDocControls` feeds the existing `generateCargoDocument` PDF. Mirrors the Receiving List's `ReceivedReportControls` flow.

**Tech Stack:** Next.js App Router, React, postgres.js raw SQL, TypeScript, jsPDF (via existing cargo generator).

## Global Constraints

- Tests run against the LOCAL DB only; run with `node --env-file=.env.development.local --import=tsx scratchpad/<file>` (or `.env.nrtest.local` if Docker is down). Guard the host (refuse non-127.0.0.1). Seed → assert → clean up. Never `supabase db reset`.
- No DB migration — reads existing `orders.unit_dispatch` / `orders.dispatch_receipt` / `products.valas` / `countries.currency`.
- Receipt filter is a case-insensitive SUBSTRING match (`ILIKE '%'||receipt||'%'`): `MNC` matches `MNC38179`. Empty/absent receipt = no receipt filter.
- qty = `SUM(unit_dispatch)` (dispatched units), per product.
- Route owner-gated (`requireSession` + `requireOwner`), matching `app/api/sheets/receiving-report/route.ts`.
- Reuse `generateCargoDocument` unchanged; do not touch the in-list `CargoDocPanel` or `getDispatchList`.

---

## File Structure

- `lib/db/dispatch.ts` — add `DispatchDocLine` + `getDispatchDocument` (Task 1). Auto-exported via the `@/lib/db` barrel (`export * from "./db/dispatch"`).
- `app/api/sheets/dispatch-report/route.ts` — new GET route (Task 2).
- `app/dashboard/dispatch-list/DispatchDocControls.tsx` — new client component (Task 3).
- `app/dashboard/dispatch-list/page.tsx` — render the controls (Task 3).

---

### Task 1: `getDispatchDocument` query

**Files:**
- Modify: `lib/db/dispatch.ts` (add at end, after `getDispatchList`)
- Test: `scratchpad/test-dispatch-document.ts`

**Interfaces:**
- Produces: `DispatchDocLine = { productName: string; qty: number; valas: number; currency: string }` and `getDispatchDocument(event: string, receipt?: string | null): Promise<DispatchDocLine[]>` — consumed by the route (Task 2). `DispatchDocLine` is structurally the cargo generator's `CargoDocLine`.

- [ ] **Step 1: Write the failing test**

`scratchpad/test-dispatch-document.ts`:

```ts
import sql from "@/lib/db-pool"
import { getDispatchDocument } from "@/lib/db"

const CUST = "__test_dispdoc__"
const created: number[] = []
let event = ""
let pA = 0, pB = 0, nameA = "", nameB = ""
function assert(c: boolean, m: string) { console.log(`${c ? "PASS" : "FAIL"}: ${m}`); if (!c) process.exitCode = 1 }

async function seed(productId: number, unitDispatch: number, receipt: string) {
  const [o] = await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, dispatch_receipt)
    VALUES (${event}, ${CUST}, ${productId}, 0, ${unitDispatch}, ${unitDispatch}, ${unitDispatch}, ${receipt})
    RETURNING id`
  created.push(o.id as number)
}

async function main() {
  const host = (process.env.DATABASE_URL ?? "").match(/@([^/]+)\//)?.[1] ?? ""
  if (!/(localhost|127\.0\.0\.1)/.test(host)) throw new Error(`Refusing non-local host: ${host}`)
  const [ev] = await sql`SELECT name FROM events LIMIT 1`; event = ev.name as string
  const prods = await sql`SELECT id, name FROM products WHERE id NOT IN (SELECT DISTINCT product_id FROM orders) LIMIT 2`
  pA = prods[0].id as number; nameA = prods[0].name as string
  pB = prods[1].id as number; nameB = prods[1].name as string
  await sql`INSERT INTO customers (instagram_id) VALUES (${CUST}) ON CONFLICT DO NOTHING`

  await seed(pA, 3, "MNC38179")
  await seed(pA, 2, "MNC38179") // same product+receipt → sums to 5
  await seed(pB, 4, "TRK999")

  // event-only: both products, qty summed.
  const all = await getDispatchDocument(event)
  const a = all.find((l) => l.productName === nameA)
  const b = all.find((l) => l.productName === nameB)
  assert(!!a && a.qty === 5, "event-only: product A qty = 5 (summed dispatch)")
  assert(!!b && b.qty === 4, "event-only: product B qty = 4")
  assert(a!.valas >= 0 && typeof a!.currency === "string", "lines carry valas + currency")

  // substring receipt "MNC" → only product A.
  const mnc = await getDispatchDocument(event, "MNC")
  assert(mnc.length === 1 && mnc[0].productName === nameA && mnc[0].qty === 5, "receipt 'MNC' substring → only A (qty 5)")

  // case-insensitive substring.
  const lower = await getDispatchDocument(event, "trk")
  assert(lower.length === 1 && lower[0].productName === nameB, "receipt 'trk' case-insensitive → only B")

  // no match → empty.
  const none = await getDispatchDocument(event, "ZZZNOPE")
  assert(none.length === 0, "non-matching receipt → empty")
}

main().catch((e) => { console.error("ERR:", e.message); process.exitCode = 1 })
  .finally(async () => {
    if (created.length) await sql`DELETE FROM orders WHERE id = ANY(${created})`
    await sql`DELETE FROM customers WHERE instagram_id = ${CUST}`
    await sql.end()
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --env-file=.env.development.local --import=tsx scratchpad/test-dispatch-document.ts`
Expected: fails importing `getDispatchDocument` (not exported).

- [ ] **Step 3: Implement**

Append to `lib/db/dispatch.ts`:

```ts
export interface DispatchDocLine {
  productName: string
  qty: number
  valas: number
  currency: string
}

/**
 * Per-product tally of *dispatched* units for one event, for the cargo-style
 * dispatch document. `receipt` is an optional case-insensitive SUBSTRING match
 * on dispatch_receipt (e.g. "MNC" matches "MNC38179"); empty/absent = every
 * dispatched line for the event. qty = SUM(unit_dispatch). valas/currency come
 * from the product and its country (same join as getDispatchList), so the
 * cargo template can price and group the lines by currency.
 */
export async function getDispatchDocument(
  event: string,
  receipt?: string | null,
): Promise<DispatchDocLine[]> {
  const receiptFilter =
    receipt && receipt.trim()
      ? sql`AND o.dispatch_receipt ILIKE '%' || ${receipt.trim()} || '%'`
      : sql``
  const rows = await sql`
    SELECT
      p.name  AS product_name,
      p.valas,
      COALESCE(c.currency, '') AS currency,
      SUM(o.unit_dispatch)::int AS qty
    FROM orders o
    JOIN products p ON p.id = o.product_id
    LEFT JOIN countries c ON c.id = p.country_id
    WHERE o.event = ${event}
      AND o.unit_dispatch IS NOT NULL
      AND o.unit_dispatch > 0
      ${receiptFilter}
    GROUP BY p.id, c.currency
    HAVING SUM(o.unit_dispatch) > 0
    ORDER BY p.store NULLS LAST, p.name
  `
  return rows.map((r) => ({
    productName: r.product_name as string,
    qty: r.qty as number,
    valas: Number(r.valas) || 0,
    currency: (r.currency as string) ?? "",
  }))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --env-file=.env.development.local --import=tsx scratchpad/test-dispatch-document.ts`
Expected: all `PASS`.
Run: `npx tsc --noEmit` → EXIT 0.

- [ ] **Step 5: Commit** (production file only)

```bash
git add lib/db/dispatch.ts
git commit -m "feat(dispatch): getDispatchDocument — dispatched lines by event + receipt substring"
```

---

### Task 2: `GET /api/sheets/dispatch-report`

**Files:**
- Create: `app/api/sheets/dispatch-report/route.ts`

**Interfaces:**
- Consumes: `getDispatchDocument` (from `@/lib/db`).
- Produces: `GET /api/sheets/dispatch-report?event=&receipt=` → `{ event, receipt, lines }`.

- [ ] **Step 1: Create the route**

`app/api/sheets/dispatch-report/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getDispatchDocument } from "@/lib/db"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireOwner(session)
  if (roleError) return roleError

  const params = req.nextUrl.searchParams
  const event = params.get("event")
  if (!event) {
    return NextResponse.json({ error: "event is required" }, { status: 400 })
  }
  // Optional receipt substring; blank → no filter.
  const receipt = params.get("receipt")?.trim() || null

  try {
    const lines = await getDispatchDocument(event, receipt)
    return NextResponse.json(
      { event, receipt, lines },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (err) {
    console.error("Failed to fetch dispatch document:", err)
    return NextResponse.json({ error: "Failed to fetch dispatch document" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit` → EXIT 0.

- [ ] **Step 3: Commit**

```bash
git add app/api/sheets/dispatch-report/route.ts
git commit -m "feat(api): dispatch-report route (dispatched lines by event + receipt)"
```

---

### Task 3: `DispatchDocControls` + page placement

**Files:**
- Create: `app/dashboard/dispatch-list/DispatchDocControls.tsx`
- Modify: `app/dashboard/dispatch-list/page.tsx`

**Interfaces:**
- Consumes: `getDispatchDocument`'s response shape via the route; `generateCargoDocument` + `CargoDocLine` (`@/lib/cargo-document-pdf`); `EventSelect`; `useSheetOptions`; `fetchJson`.

- [ ] **Step 1: Create the controls component**

`app/dashboard/dispatch-list/DispatchDocControls.tsx`:

```tsx
"use client"

import { useState } from "react"
import { fetchJson } from "@/lib/api-fetch"
import { generateCargoDocument, type CargoDocLine } from "@/lib/cargo-document-pdf"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import EventSelect from "@/components/EventSelect"

const INPUT_CLASS =
  "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

// Today in Asia/Jakarta as YYYY-MM-DD, so the document is dated by business day
// regardless of the browser's timezone.
function jakartaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date())
}

type DocResponse = { event: string; receipt: string | null; lines: CargoDocLine[] }

export default function DispatchDocControls() {
  const options = useSheetOptions()
  const [event, setEvent] = useState("")
  const [receipt, setReceipt] = useState("")
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function download() {
    if (!event) return
    setLoading(true)
    setMessage(null)
    try {
      const query = new URLSearchParams({ event })
      const trimmedReceipt = receipt.trim()
      if (trimmedReceipt) query.set("receipt", trimmedReceipt)
      const doc = await fetchJson<DocResponse>(`/api/sheets/dispatch-report?${query.toString()}`)
      if (doc.lines.length === 0) {
        setMessage(`No dispatched items for ${event}${trimmedReceipt ? ` matching "${trimmedReceipt}"` : ""}.`)
        return
      }
      const title = `${event}${trimmedReceipt ? ` · ${trimmedReceipt}` : ""}`
      const blob = await generateCargoDocument({ name: title, date: jakartaToday(), lines: doc.lines })
      const url = URL.createObjectURL(blob)
      try {
        const a = document.createElement("a")
        a.href = url
        a.download = `dispatch-${event}${trimmedReceipt ? `-${trimmedReceipt}` : ""}.pdf`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to generate document")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mb-6 rounded-xl border border-cream-border bg-white p-4 flex items-end gap-2 sm:gap-3 flex-wrap">
      <div className="w-full sm:w-auto sm:flex-1 min-w-0 sm:min-w-[200px]">
        <EventSelect
          value={event}
          onChange={(v) => { setEvent(v); setMessage(null) }}
          events={options?.events ?? []}
          placeholder="Select event…"
        />
      </div>
      <input
        type="text"
        value={receipt}
        onChange={(e) => setReceipt(e.target.value)}
        aria-label="Dispatch receipt (optional)"
        placeholder="Receipt (optional)"
        className={`${INPUT_CLASS} h-[38px] flex-1 min-w-0 sm:min-w-[160px]`}
      />
      <button
        type="button"
        onClick={download}
        disabled={loading || !event}
        aria-label="Download PDF"
        title={event ? "Download PDF" : "Select an event first"}
        className="h-[38px] w-[38px] sm:w-auto shrink-0 rounded-lg border border-cream-border bg-white sm:px-4 text-sm font-medium text-gray-600 transition-colors hover:border-brand hover:text-brand disabled:opacity-50 flex items-center justify-center"
      >
        <svg className="sm:hidden" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        <span className="hidden sm:inline">{loading ? "Preparing…" : "Download PDF"}</span>
      </button>
      {message && <span className="text-sm text-gray-500 basis-full">{message}</span>}
    </div>
  )
}
```

- [ ] **Step 2: Render it on the page**

Modify `app/dashboard/dispatch-list/page.tsx` — import and place between the header and the client:

```tsx
import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import DispatchListClient from "./DispatchListClient"
import DispatchDocControls from "./DispatchDocControls"

export default function DispatchListPage() {
  return (
    <PageShell>
      <PageHeader
        title="Dispatch List"
        subtitle="Bought orders not yet dispatched"
      />
      <DispatchDocControls />
      <DispatchListClient />
    </PageShell>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit` → EXIT 0.

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/dispatch-list/DispatchDocControls.tsx app/dashboard/dispatch-list/page.tsx
git commit -m "feat(dispatch): dispatch document download controls on Dispatch List page"
```

---

## Self-Review

- Spec coverage: query (Task 1) + route (Task 2) + controls & placement (Task 3) — all spec sections mapped.
- Type consistency: `DispatchDocLine` is structurally `CargoDocLine` ({ productName, qty, valas, currency }); the controls type the response `lines` as `CargoDocLine[]` and pass them straight to `generateCargoDocument`.
- No placeholders; every step has complete code.
