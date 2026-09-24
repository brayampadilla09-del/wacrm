import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { summarizeConversation } from '@/lib/ai/summary'
import { HANDOFF_REASON_LABEL } from '@/lib/ai/handoff'
import { supabaseAdmin } from '@/lib/ai/admin-client'

/**
 * POST /api/ai/summarize  (agent+)
 *
 * Body: { conversation_id }
 * Returns: { summary }
 *
 * On-demand version of the note the bot leaves when it hands a
 * conversation off: what the customer wants, what the flow captured
 * (the latest run's vars) and where it stands. Stored on the
 * conversation (inbox banner) and as a contact note, so it isn't lost
 * when the agent navigates away.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    // Same buckets as drafts: one agent-facing LLM call per click.
    const userLimit = checkRateLimit(`ai-draft:${userId}`, RATE_LIMITS.aiDraft)
    if (!userLimit.success) return rateLimitResponse(userLimit)
    const accountLimit = checkRateLimit(
      `ai-draft-acct:${accountId}`,
      RATE_LIMITS.aiDraftAccount,
    )
    if (!accountLimit.success) return rateLimitResponse(accountLimit)

    const body = await request.json().catch(() => null)
    const conversationId =
      body && typeof body.conversation_id === 'string' ? body.conversation_id : ''
    if (!conversationId) {
      return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 })
    }

    // RLS-scoped read: a missing row means "not yours / not found".
    const { data: conversation, error: convErr } = await supabase
      .from('conversations')
      .select('id, contact_id')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr) {
      console.error('[ai/summarize] conversation lookup error:', convErr)
      return NextResponse.json({ error: 'Failed to load conversation' }, { status: 500 })
    }
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const admin = supabaseAdmin()
    const { data: lastRun } = await admin
      .from('flow_runs')
      .select('vars')
      .eq('conversation_id', conversationId)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const summary = await summarizeConversation(admin, {
      accountId,
      conversationId,
      reason: 'manual',
      vars: (lastRun?.vars as Record<string, unknown> | null) ?? null,
    })
    if (!summary) {
      return NextResponse.json(
        {
          error: 'Could not summarize this conversation. Check that the AI assistant is set up and active.',
          code: 'summary_unavailable',
        },
        { status: 502 },
      )
    }

    await admin
      .from('conversations')
      .update({ ai_handoff_summary: summary })
      .eq('id', conversationId)
    const { error: noteErr } = await admin.from('contact_notes').insert({
      contact_id: conversation.contact_id,
      account_id: accountId,
      user_id: userId,
      note_text: `🤖 Resumen de la conversación (${HANDOFF_REASON_LABEL.manual})\n${summary}`,
    })
    if (noteErr) console.error('[ai/summarize] contact note insert failed:', noteErr)

    return NextResponse.json({ summary })
  } catch (err) {
    return toErrorResponse(err)
  }
}
