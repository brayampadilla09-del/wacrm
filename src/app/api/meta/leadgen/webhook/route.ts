import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifySignatureWithSecret } from '@/lib/whatsapp/webhook-signature'
import { fetchLeadgenLead, parseLeadFields } from '@/lib/meta/leadgen'
import {
  findOrCreateContact,
  setContactTags,
  resolveAuditUserId,
} from '@/lib/api/v1/contacts'
import { notifyNewLead } from '@/lib/contacts/notify-new-lead'

// Meta Lead Ads webhook (the "leadgen" field of a Page subscription —
// separate from /api/whatsapp/webhook, which only handles the
// WhatsApp Business Account fields). See docs/meta-lead-ads.md for the
// one-time setup this needs on the Meta side: a Meta App (any app —
// does NOT have to be the same one the WhatsApp number is registered
// under) with the Webhooks product, subscribed to the Page, "leadgen"
// field ticked, plus a Page access token with leads_retrieval.
//
// This CRM is single-tenant per deployment (see docs/meta-lead-ads.md)
// so, unlike the WhatsApp webhook (which resolves the account from the
// per-number config row), the target account is a fixed env var.

/** META_LEADGEN_APP_SECRET, falling back to META_APP_SECRET so setups
 *  that DO want to reuse the WhatsApp app still work without a second
 *  var — but a dedicated Lead-Ads-only Meta App never needs to touch
 *  META_APP_SECRET at all. */
function leadgenAppSecret(): string | null {
  return process.env.META_LEADGEN_APP_SECRET || process.env.META_APP_SECRET || null
}

export const maxDuration = 30

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

interface LeadgenChange {
  field: string
  value: {
    leadgen_id: string
    page_id: string
    form_id: string
    created_time: number
    ad_id?: string
  }
}

interface LeadgenEntry {
  id: string
  changes: LeadgenChange[]
}

// GET — webhook verification (same handshake as the WhatsApp webhook,
// but against a single dedicated token — this subscription isn't tied
// to a per-number `whatsapp_config` row).
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const challenge = searchParams.get('hub.challenge')
  const verifyToken = searchParams.get('hub.verify_token')

  const expected = process.env.META_LEADGEN_VERIFY_TOKEN
  if (!expected) {
    console.error('[leadgen webhook] META_LEADGEN_VERIFY_TOKEN is not set — rejecting request')
    return NextResponse.json({ error: 'Not configured' }, { status: 403 })
  }

  if (mode !== 'subscribe' || !challenge || verifyToken !== expected) {
    return NextResponse.json({ error: 'Verification token mismatch' }, { status: 403 })
  }

  return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
}

// POST — a lead was submitted on a Meta Lead Ads form.
export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  const secret = leadgenAppSecret()
  if (!secret) {
    console.error('[leadgen webhook] no app secret configured — rejecting request')
    return NextResponse.json({ error: 'Not configured' }, { status: 403 })
  }
  if (!verifySignatureWithSecret(rawBody, signature, secret)) {
    console.warn('[leadgen webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: { entry?: LeadgenEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Ack Meta immediately; do the Graph API round-trip + DB writes after
  // the response, same reasoning as /api/whatsapp/webhook's `after()`.
  after(async () => {
    try {
      await processLeadgenWebhook(body)
    } catch (error) {
      console.error('[leadgen webhook] processing failed:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processLeadgenWebhook(body: { entry?: LeadgenEntry[] }) {
  if (!body.entry) return

  const accountId = process.env.META_LEADGEN_ACCOUNT_ID
  const pageAccessToken = process.env.META_LEADGEN_PAGE_ACCESS_TOKEN
  if (!accountId || !pageAccessToken) {
    console.error(
      '[leadgen webhook] META_LEADGEN_ACCOUNT_ID / META_LEADGEN_PAGE_ACCESS_TOKEN not set — dropping lead(s)',
    )
    return
  }

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'leadgen') continue
      await handleLead(change.value.leadgen_id, accountId, pageAccessToken)
    }
  }
}

async function handleLead(leadgenId: string, accountId: string, pageAccessToken: string) {
  const db = supabaseAdmin()

  let lead
  try {
    lead = await fetchLeadgenLead(leadgenId, pageAccessToken)
  } catch (error) {
    console.error(`[leadgen webhook] failed to fetch lead ${leadgenId}:`, error)
    return
  }

  const { phone, email, name } = parseLeadFields(lead.field_data)
  if (!phone) {
    console.warn(`[leadgen webhook] lead ${leadgenId} has no phone field — skipping (raw:`, lead.field_data, ')')
    return
  }

  try {
    const auditUserId = await resolveAuditUserId(db, accountId)
    const { id: contactId, created } = await findOrCreateContact(db, accountId, auditUserId, {
      phone,
      name: name ?? undefined,
      email: email ?? undefined,
    })
    await setContactTags(db, accountId, auditUserId, contactId, ['Meta Ads'])
    if (created) await notifyNewLead(db, accountId, contactId, 'Meta Ads', name ?? phone)
    console.log(
      `[leadgen webhook] lead ${leadgenId} → contact ${contactId} (${created ? 'created' : 'matched existing'})`,
    )
  } catch (error) {
    console.error(`[leadgen webhook] failed to upsert contact for lead ${leadgenId}:`, error)
  }
}
