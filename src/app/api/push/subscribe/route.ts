import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

// Web Push subscription registry (migration 043). RLS on
// push_subscriptions already scopes every row to auth.uid() = user_id,
// so these routes just pass the caller's session client straight
// through — no service-role client needed.

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : ''
  const p256dh = typeof body?.keys?.p256dh === 'string' ? body.keys.p256dh : ''
  const authKey = typeof body?.keys?.auth === 'string' ? body.keys.auth : ''
  if (!endpoint || !p256dh || !authKey) {
    return NextResponse.json({ error: 'Invalid subscription payload' }, { status: 400 })
  }

  const userAgent = request.headers.get('user-agent')

  const { error } = await ctx.supabase.from('push_subscriptions').upsert(
    {
      user_id: ctx.userId,
      endpoint,
      p256dh,
      auth_key: authKey,
      user_agent: userAgent,
    },
    { onConflict: 'endpoint' },
  )

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true }, { status: 201 })
}

export async function DELETE(request: Request) {
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : ''
  if (!endpoint) {
    return NextResponse.json({ error: 'endpoint is required' }, { status: 400 })
  }

  const { error } = await ctx.supabase
    .from('push_subscriptions')
    .delete()
    .eq('endpoint', endpoint)
    .eq('user_id', ctx.userId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
