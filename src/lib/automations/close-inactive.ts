import type { SupabaseClient } from '@supabase/supabase-js'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'

// A conversation with Bimi that's been waiting on the customer for this
// long, with no reply, gets wrapped up instead of left open forever.
// "At least 1 hour" per the operator's instruction — short enough that a
// same-day follow-up from the customer starts a clean new exchange
// instead of resuming a stale one days later.
const INACTIVITY_HOURS = 1

const CLOSING_MESSAGE =
  '¡Hola! Como no he tenido noticias tuyas, por ahora voy a cerrar esta conversación 🙂 Cuando quieras retomarla, solo escríbeme y seguimos donde quedamos.'

/**
 * Wraps up WhatsApp conversations Bimi has been waiting on for
 * INACTIVITY_HOURS+ with no reply — sends a closing message and marks
 * the conversation `closed` (same status the `close_conversation`
 * automation step already uses, see engine.ts) instead of leaving it
 * open indefinitely. Applies whether this is the contact's very first
 * exchange or a Flow they went quiet mid-way through.
 *
 * Only 'bot' channels (Bimi) — a 'human' channel (Asesor) is a plain
 * manual inbox; auto-closing it would take control away from whoever's
 * actually answering it by hand.
 *
 * Scoping "waiting on the customer": the conversation's last message
 * must NOT be from the customer — if it is, we owe THEM a reply, which
 * is a different problem (an unanswered inbound), not abandonment on
 * our side, so it's left alone.
 *
 * Runs on a schedule independent of Vercel Cron (which on this
 * project's plan only fires once a day — nowhere near tight enough
 * to catch something at ~1 hour) — see supabase/migrations for the
 * pg_cron + pg_net job that hits this on a short interval instead.
 */
export async function closeInactiveConversations(
  db: SupabaseClient
): Promise<{ closed: number; failed: number }> {
  const cutoff = new Date(Date.now() - INACTIVITY_HOURS * 60 * 60 * 1000).toISOString()

  const { data: candidates, error } = await db
    .from('conversations')
    .select('id, account_id, contact_id, whatsapp_config!inner(kind)')
    .neq('status', 'closed')
    .lte('last_message_at', cutoff)
    .eq('whatsapp_config.kind', 'bot')

  if (error) {
    console.error('[close-inactive] candidate scan failed:', error.message)
    return { closed: 0, failed: 0 }
  }
  if (!candidates?.length) return { closed: 0, failed: 0 }

  let closed = 0
  let failed = 0

  for (const conv of candidates as { id: string; account_id: string; contact_id: string }[]) {
    const { data: lastMessage } = await db
      .from('messages')
      .select('sender_type')
      .eq('conversation_id', conv.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // The customer has the last word — we owe them a reply, not the
    // other way around. Leave it for a human/the bot to actually answer.
    if (lastMessage?.sender_type === 'customer') continue

    try {
      // skipFlowPause: true — we're ending the run ourselves (below)
      // with an accurate status/reason, so the generic "agent stepped
      // in" pause (paused_by_agent) sendMessageToConversation would
      // otherwise apply doesn't fit what's actually happening here.
      await sendMessageToConversation(db, conv.account_id, {
        conversationId: conv.id,
        messageType: 'text',
        contentText: CLOSING_MESSAGE,
        skipFlowPause: true,
      })
    } catch (err) {
      console.error('[close-inactive] send failed for conversation', conv.id, err)
      failed++
      continue
    }

    // Mirrors /api/flows/cron's sweep — same terminal status, own
    // end_reason so the two are distinguishable in flow_run_events.
    await db
      .from('flow_runs')
      .update({ status: 'timed_out', ended_at: new Date().toISOString(), end_reason: 'inactivity_closed' })
      .eq('account_id', conv.account_id)
      .eq('contact_id', conv.contact_id)
      .eq('status', 'active')

    await db
      .from('conversations')
      .update({ status: 'closed', updated_at: new Date().toISOString() })
      .eq('id', conv.id)

    closed++
  }

  return { closed, failed }
}
