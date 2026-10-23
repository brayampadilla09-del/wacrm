import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { swapComingSoonFlows } from '@/lib/ai/coming-soon'

/**
 * "Modo muy pronto" switch (migration 046).
 *
 * ON: the assistant uses `coming_soon_prompt` and ignores the knowledge
 * base (see loadAiConfig / retrieveKnowledge), flows tagged 'off_only'
 * (the full menu) go to draft and flows tagged 'on_only' (the handoff
 * notice) go active. OFF reverses it. Untagged flows are never touched.
 */

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('ai_configs')
      .select('coming_soon_enabled, coming_soon_prompt')
      .eq('account_id', accountId)
      .maybeSingle()
    if (error) {
      console.error('[ai/coming-soon GET]', error)
      return NextResponse.json({ error: 'Failed to load coming soon mode' }, { status: 500 })
    }
    return NextResponse.json({
      configured: !!data,
      enabled: data?.coming_soon_enabled === true,
      prompt: data?.coming_soon_prompt ?? '',
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** POST { enabled?: boolean, prompt?: string }  (admin+) */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-coming-soon:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
    const hasEnabled = typeof body.enabled === 'boolean'
    const hasPrompt = typeof body.prompt === 'string'
    if (!hasEnabled && !hasPrompt) {
      return NextResponse.json({ error: 'enabled or prompt is required' }, { status: 400 })
    }

    const db = supabaseAdmin()
    const { data: cfg } = await db
      .from('ai_configs')
      .select('coming_soon_prompt')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!cfg) {
      return NextResponse.json({ error: 'Set up the AI assistant first' }, { status: 400 })
    }

    const update: Record<string, unknown> = {}
    if (hasPrompt) update.coming_soon_prompt = body.prompt.trim() || null
    if (hasEnabled) {
      // Turning it on without a prompt would silently keep the normal
      // one (with plans and prices) live, so refuse.
      const effectivePrompt = hasPrompt ? update.coming_soon_prompt : cfg.coming_soon_prompt
      if (body.enabled && !effectivePrompt) {
        return NextResponse.json(
          { error: 'Write the coming soon text before turning the mode on' },
          { status: 400 },
        )
      }
      update.coming_soon_enabled = body.enabled
    }

    const { error: upErr } = await db.from('ai_configs').update(update).eq('account_id', accountId)
    if (upErr) {
      console.error('[ai/coming-soon POST] update', upErr)
      return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
    }

    if (hasEnabled) {
      await swapComingSoonFlows(db, accountId, body.enabled as boolean)
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
