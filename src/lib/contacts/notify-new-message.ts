import type { SupabaseClient } from '@supabase/supabase-js';
import { sendPushToUsers } from '@/lib/push/send-push';

/**
 * A `new_message` notification (migration 043) for an inbound customer
 * message. Unlike `conversation_assigned` (one recipient, DB trigger)
 * this has to be app-code like `notifyNewLead`: an unassigned
 * conversation has no single natural recipient, so every active
 * account member gets notified; an assigned one only notifies its
 * assignee (self-notifying isn't useful — the assignee is the one
 * looking at the inbox that just updated).
 *
 * Called from the webhook (src/app/api/whatsapp/webhook/route.ts)
 * after a customer message is inserted, for both 'bot' and 'human'
 * channels — this is the one responder that human channels (a plain
 * manual inbox, no flows/automations/AI) still get.
 *
 * Best-effort: a notification failure must never fail message
 * ingestion.
 */
export async function notifyNewMessage(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  contactId: string,
  assignedAgentId: string | null,
  contactLabel: string,
  preview: string,
): Promise<void> {
  try {
    let recipientIds: string[];
    if (assignedAgentId) {
      recipientIds = [assignedAgentId];
    } else {
      const { data: members, error } = await db
        .from('profiles')
        .select('user_id')
        .eq('account_id', accountId);
      if (error || !members || members.length === 0) {
        if (error) console.error('[notifyNewMessage] failed to list account members:', error);
        return;
      }
      recipientIds = (members as { user_id: string }[]).map((m) => m.user_id);
    }

    const rows = recipientIds.map((userId) => ({
      account_id: accountId,
      user_id: userId,
      type: 'new_message',
      conversation_id: conversationId,
      contact_id: contactId,
      title: `New message from ${contactLabel}`,
      body: preview,
    }));

    const { error: insertError } = await db.from('notifications').insert(rows);
    if (insertError) {
      console.error('[notifyNewMessage] failed to insert notifications:', insertError);
    }

    await sendPushToUsers(db, recipientIds, {
      title: `New message from ${contactLabel}`,
      body: preview,
      url: `/inbox?c=${conversationId}`,
    });
  } catch (err) {
    console.error('[notifyNewMessage] unexpected failure:', err);
  }
}
