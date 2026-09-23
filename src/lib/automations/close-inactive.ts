import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendText } from '@/lib/flows/meta-send'

// A conversation with Bimi that's been waiting on the customer for this
// long, with no reply, gets wrapped up instead of left open forever.
// "At least 1 hour" per the operator's instruction — short enough that a
// same-day follow-up from the customer starts a clean new exchange
// instead of resuming a stale one days later.
const INACTIVITY_HOURS = 1

// Meta only accepts free-form text within 24h of the customer's last
// message; past that the send is rejected, so we don't even try. A small
// margin under 24h keeps a slow sweep from landing right on the edge.
const CUSTOMER_WINDOW_MS = 23 * 60 * 60 * 1000

const CLOSING_MESSAGE =
  '¡Hola! Como no he tenido noticias tuyas, por ahora voy a cerrar esta conversación 🙂 Cuando quieras retomarla, solo escríbeme y seguimos donde quedamos.'

/**
 * Wraps up WhatsApp conversations Bimi has been waiting on for
 * INACTIVITY_HOURS+ with no reply, instead of leaving them open
 * indefinitely.
 *
 * Only 'bot' channels (Bimi), and only conversations in 'open' status:
 * 'pending' means the bot handed off and a person still has to answer.
 *
 * The conversation must be one BIMI left hanging — its last message is
 * a bot message:
 *   - last message from the customer → we owe THEM a reply; left alone.
 *   - last message from an agent → either a person is handling it, or it
 *     is a notification template sent by pagina-estudio (cita_confirmada,
 *     recordatorio…). Neither is Bimi waiting on anyone; the old version
 *     answered those with "como no he tenido noticias tuyas…", including
 *     to customers whose last contact was a cancellation months earlier.
 *
 * The closing message itself is only sent when a Flow run is actually
 * active (Bimi asked something and is waiting) and the customer's 24h
 * window is still open. Otherwise — the flow already said goodbye, or
 * the window is gone — the conversation is just closed silently.
 *
 * Runs on a schedule independent of Vercel Cron (which on this
 * project's plan only fires once a day — nowhere near tight enough
 * to catch something at ~1 hour): a Supabase pg_cron + pg_net job hits
 * /api/automations/close-inactive every 15 minutes.
 */
export async function closeInactiveConversations(
  db: SupabaseClient
): Promise<{ closed: number; failed: number }> {
  const cutoff = new Date(Date.now() - INACTIVITY_HOURS * 60 * 60 * 1000).toISOString()

  const { data: candidates, error } = await db
    .from('conversations')
    .select('id, account_id, contact_id, user_id, whatsapp_config!inner(kind)')
    .eq('status', 'open')
    .lte('last_message_at', cutoff)
    .eq('whatsapp_config.kind', 'bot')

  if (error) {
    console.error('[close-inactive] candidate scan failed:', error.message)
    return { closed: 0, failed: 0 }
  }
  if (!candidates?.length) return { closed: 0, failed: 0 }

  let closed = 0
  let failed = 0

  for (const conv of candidates as {
    id: string
    account_id: string
    contact_id: string
    user_id: string
  }[]) {
    const { data: lastMessage } = await db
      .from('messages')
      .select('sender_type')
      .eq('conversation_id', conv.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (lastMessage?.sender_type !== 'bot') continue

    const { data: activeRun } = await db
      .from('flow_runs')
      .select('id')
      .eq('account_id', conv.account_id)
      .eq('contact_id', conv.contact_id)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle()

    const { data: lastCustomerMessage } = await db
      .from('messages')
      .select('created_at')
      .eq('conversation_id', conv.id)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const withinWindow =
      !!lastCustomerMessage?.created_at &&
      Date.now() - new Date(lastCustomerMessage.created_at).getTime() < CUSTOMER_WINDOW_MS

    if (activeRun && withinWindow) {
      try {
        // Through the flow sender, so the message is recorded as Bimi's
        // ('bot'), not as a human agent's — the engine treats a recent
        // agent text as "a person took over" and would keep the bot quiet.
        await engineSendText({
          accountId: conv.account_id,
          userId: conv.user_id,
          conversationId: conv.id,
          contactId: conv.contact_id,
          text: CLOSING_MESSAGE,
        })
      } catch (err) {
        // Still close it below: retrying every 15 minutes won't make a
        // rejected send succeed, it just piles up failed messages.
        console.error('[close-inactive] send failed for conversation', conv.id, err)
        failed++
      }
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
