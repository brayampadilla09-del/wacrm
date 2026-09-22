// ============================================================
// GET /api/v1/contacts/{id}/last-reply — timestamp of this contact's
// most recent inbound (customer) message, across every conversation
// they have on this account (scope: messages:read).
//
// Built for external callers (pagina-estudio's proposal follow-up
// cron, see sendProposalFollowUps in booking-service.ts) that need to
// know "did this person write back after date X" without pulling
// whole conversation/message pages through the general-purpose
// endpoints — one purpose-built round trip instead of three.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'messages:read');
    const { id } = await params;

    const { data: contact } = await ctx.supabase
      .from('contacts')
      .select('id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!contact) return fail('not_found', 'Contact not found', 404);

    const { data: conversations } = await ctx.supabase
      .from('conversations')
      .select('id')
      .eq('contact_id', id)
      .eq('account_id', ctx.accountId);
    const conversationIds = (conversations ?? []).map((c) => c.id as string);
    if (conversationIds.length === 0) {
      return ok({ last_customer_message_at: null });
    }

    const { data: lastMessage, error } = await ctx.supabase
      .from('messages')
      .select('created_at')
      .in('conversation_id', conversationIds)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('[api/v1/contacts/last-reply] query error:', error);
      return fail('internal', 'Failed to look up last reply', 500);
    }

    return ok({ last_customer_message_at: lastMessage?.created_at ?? null });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
