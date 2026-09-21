import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A new lead has no single natural recipient (unlike an assigned
 * conversation, which notifies the assignee) — every active member of
 * the account gets their own `new_lead` notification row instead of
 * the trigger-based approach migration 027 uses for
 * conversation_assigned. Shared by the Meta Lead Ads webhook
 * (src/app/api/meta/leadgen/webhook) and the public API's contact
 * creation path (opt-in via `notify: true` — see
 * src/app/api/v1/contacts/route.ts) so both sources of "the website
 * or an ad brought in a new person" surface the same way.
 *
 * Best-effort: a notification failure must never fail the contact
 * creation it's attached to.
 */
export async function notifyNewLead(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  source: string,
  leadLabel: string,
): Promise<void> {
  try {
    const { data: members, error } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId);
    if (error || !members || members.length === 0) {
      if (error) console.error('[notifyNewLead] failed to list account members:', error);
      return;
    }

    const rows = (members as { user_id: string }[]).map((m) => ({
      account_id: accountId,
      user_id: m.user_id,
      type: 'new_lead',
      contact_id: contactId,
      title: `New lead from ${source}`,
      body: `${leadLabel} came in as a new contact`,
    }));

    const { error: insertError } = await db.from('notifications').insert(rows);
    if (insertError) {
      console.error('[notifyNewLead] failed to insert notifications:', insertError);
    }
  } catch (err) {
    console.error('[notifyNewLead] unexpected failure:', err);
  }
}
