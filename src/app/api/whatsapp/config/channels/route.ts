import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/whatsapp/config/channels
 *
 * Lists every WhatsApp channel (whatsapp_config row) belonging to the
 * caller's account (migration 039 — an account can now own more than
 * one number, e.g. "Bimi" the bot number + "Asesor" a human advisor's
 * own number). Used by the Settings channel list and by the
 * channel-switcher context. Never returns `access_token`/`verify_token`.
 */
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 403 },
    )
  }

  const { data: channels, error } = await supabase
    .from('whatsapp_config')
    .select(
      'id, label, kind, is_default, notify_user_id, phone_number_id, waba_id, status, connected_at, registered_at, last_registration_error',
    )
    .eq('account_id', accountId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true })

  if (error) {
    console.error('[whatsapp/config/channels GET] error:', error)
    return NextResponse.json({ error: 'Failed to load channels' }, { status: 500 })
  }

  return NextResponse.json({ channels: channels ?? [] })
}
