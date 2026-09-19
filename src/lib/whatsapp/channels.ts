// ============================================================
// Channel resolution helpers.
//
// Since migration 039, an account can own more than one
// `whatsapp_config` row ("channel" — e.g. "Bimi" the bot number,
// "Asesor" a human advisor's own number). Call sites that predate
// multi-channel (the public v1 API, the manual contact form, CSV
// import, broadcasts) have no UI concept of "which channel" yet, so
// they fall back to the account's `is_default` channel — preserving
// their pre-039 behavior exactly for accounts that still only have one
// channel, and giving a well-defined target once a second channel
// exists, instead of the `.eq('account_id', accountId).single()`
// lookups this replaces silently breaking (PGRST116, "multiple rows")
// the moment an account connects a second number.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

/** The account's default channel id, or null if none is configured yet. */
export async function resolveDefaultChannelId(
  db: SupabaseClient,
  accountId: string
): Promise<string | null> {
  const { data } = await db
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    .eq('is_default', true)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/**
 * The full `whatsapp_config` row for a specific channel, or — when
 * `channelId` is omitted — the account's default channel. Used by send
 * paths that need `phone_number_id` / `access_token`, not just the id.
 */
export async function resolveChannelConfig(
  db: SupabaseClient,
  accountId: string,
  channelId?: string | null
) {
  let query = db.from('whatsapp_config').select('*').eq('account_id', accountId);
  query = channelId ? query.eq('id', channelId) : query.eq('is_default', true);
  const { data, error } = await query.maybeSingle();
  return { data, error };
}
