import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { closeInactiveConversations } from '@/lib/automations/close-inactive'

/**
 * Wraps up conversations Bimi has been waiting on for 1h+ (see
 * closeInactiveConversations). Meant to be hit every ~15 minutes — far
 * tighter than Vercel Cron allows on this project's plan (once a day),
 * so this is driven by Supabase's own pg_cron + pg_net instead (see
 * supabase/migrations/*_close_inactive_schedule.sql), not vercel.json.
 *
 * Same auth scheme as /api/flows/cron (AUTOMATION_CRON_SECRET via the
 * x-cron-secret header) — one shared secret for every scheduled sweep,
 * whatever ends up calling it.
 */
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

  const result = await closeInactiveConversations(supabaseAdmin())
  return NextResponse.json(result)
}
