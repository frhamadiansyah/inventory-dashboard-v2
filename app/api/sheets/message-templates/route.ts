import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole, requireOwner } from "@/lib/api"
import { getMessageTemplates, updateMessageTemplate, withActor } from "@/lib/db"
import { cached, invalidate } from "@/lib/route-cache"
import { TEMPLATE_KEYS, findMissingTokens, type TemplateKey } from "@/lib/message-templates"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const templates = await cached("message-templates", getMessageTemplates)
    return NextResponse.json({ templates }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch message templates:", err)
    return NextResponse.json({ error: "Failed to fetch message templates" }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const { key, body } = await req.json()

    if (!TEMPLATE_KEYS.includes(key)) {
      return NextResponse.json({ error: "Invalid template key" }, { status: 400 })
    }
    if (typeof body !== "string" || !body.trim()) {
      return NextResponse.json({ error: "Template body is required" }, { status: 400 })
    }

    const missing = findMissingTokens(body, key as TemplateKey)
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `Missing required token(s): ${missing.join(", ")}` },
        { status: 400 },
      )
    }

    await withActor(session.user.email, (tx) => updateMessageTemplate(key as TemplateKey, body, tx))
    invalidate("message-templates")
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("Failed to update message template:", err)
    return NextResponse.json({ error: "Failed to update message template" }, { status: 500 })
  }
}
