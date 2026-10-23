import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { createBroadcast, deliverBroadcast, BroadcastError } from '@/lib/whatsapp/broadcast-core'
import { swapComingSoonFlows } from '@/lib/ai/coming-soon'

/**
 * Launch-day notice. Hit by pg_cron on Oct 26 at 8:00 a.m. Colombia
 * (13:00 UTC), with retries at 13:30, 14:00 and 14:30 UTC.
 *
 *   1. Sends the `lanzamiento_bsign` template to every contact tagged
 *      "Aviso de lanzamiento" (the ones who asked Bimi to be told).
 *   2. Turns "modo muy pronto" OFF so Bimi goes back to the full menu.
 *
 * Safe to call repeatedly: a broadcast named LAUNCH_BROADCAST that is
 * already sending/sent blocks a second send, and if the template is
 * not APPROVED yet nothing is sent (the next retry tries again).
 * Same auth as the other sweeps (AUTOMATION_CRON_SECRET).
 */

const TEMPLATE = 'lanzamiento_bsign'
const LANGUAGE = 'es_CO'
const TAG = 'Aviso de lanzamiento'
const LAUNCH_BROADCAST = 'Lanzamiento BSign 2026-10-26'
const FALLBACK_NAME = 'de nuevo'

/** First name if the contact has a real one, otherwise a neutral filler. */
function greetingName(name: string | null): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? ''
  if (first.length < 2 || !/^\p{L}[\p{L}'’-]*$/u.test(first)) return FALLBACK_NAME
  return first
}

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Never fire before launch day, whatever hits this URL.
  if (Date.now() < Date.parse('2026-10-26T13:00:00Z')) {
    return NextResponse.json({ skipped: 'before launch day' })
  }

  const db = supabaseAdmin()

  const { data: tag } = await db
    .from('tags')
    .select('id, account_id, user_id')
    .eq('name', TAG)
    .limit(1)
    .maybeSingle()
  if (!tag) return NextResponse.json({ error: `tag "${TAG}" not found` }, { status: 404 })
  const accountId = tag.account_id as string

  const result: Record<string, unknown> = {}

  // 1. The notice.
  const { data: already } = await db
    .from('broadcasts')
    .select('id, status')
    .eq('account_id', accountId)
    .eq('name', LAUNCH_BROADCAST)
    .in('status', ['sending', 'sent'])
    .limit(1)
    .maybeSingle()

  if (already) {
    result.notice = { skipped: 'already sent', broadcast_id: already.id }
  } else {
    const { data: tpl } = await db
      .from('message_templates')
      .select('status')
      .eq('account_id', accountId)
      .eq('name', TEMPLATE)
      .eq('language', LANGUAGE)
      .maybeSingle()
    if (!tpl || String(tpl.status).toUpperCase() !== 'APPROVED') {
      result.notice = { skipped: `template ${TEMPLATE} is ${tpl?.status ?? 'missing'}, will retry` }
    } else {
      const { data: rows } = await db
        .from('contact_tags')
        .select('contacts ( id, name, phone )')
        .eq('tag_id', tag.id)
      const recipients = (rows ?? [])
        .map((r) => (Array.isArray(r.contacts) ? r.contacts[0] : r.contacts) as
          { name: string | null; phone: string | null } | null)
        // No phone (e.g. BSUID-only) or the 573000000000 test placeholder.
        .filter((c): c is { name: string | null; phone: string } => !!c?.phone && !/^5730{9}$/.test(c.phone))
        .map((c) => ({ to: c.phone, params: [greetingName(c.name)] }))

      if (recipients.length === 0) {
        result.notice = { skipped: 'no recipients' }
      } else {
        try {
          const plan = await createBroadcast(db, accountId, tag.user_id as string, {
            name: LAUNCH_BROADCAST,
            templateName: TEMPLATE,
            templateLanguage: LANGUAGE,
            recipients,
          })
          await deliverBroadcast(db, plan)
          result.notice = { broadcast_id: plan.broadcastId, sent_to: plan.planned.length, rejected: plan.rejected }
        } catch (err) {
          console.error('[launch-notice]', err)
          result.notice = { error: err instanceof BroadcastError ? err.message : 'failed' }
        }
      }
    }
  }

  // 2. Bimi back to normal.
  const { data: cfg } = await db
    .from('ai_configs')
    .select('coming_soon_enabled')
    .eq('account_id', accountId)
    .maybeSingle()
  if (cfg?.coming_soon_enabled) {
    await db.from('ai_configs').update({ coming_soon_enabled: false }).eq('account_id', accountId)
    await swapComingSoonFlows(db, accountId, false)
    result.coming_soon = 'turned off'
  } else {
    result.coming_soon = 'already off'
  }

  return NextResponse.json(result)
}
