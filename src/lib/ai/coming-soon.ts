import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Flip the "modo muy pronto" flow swap (migration 046).
 *
 * ON: flows tagged 'on_only' (the handoff) go active, 'off_only' (the
 * full menu) go to draft. OFF reverses it. Untagged flows are never
 * touched. Shared by POST /api/ai/coming-soon and the launch-day cron.
 */
export async function swapComingSoonFlows(
  db: SupabaseClient,
  accountId: string,
  on: boolean,
): Promise<void> {
  const swap = async (mode: 'off_only' | 'on_only', active: boolean) => {
    const { data: flows } = await db
      .from('flows')
      .select('id')
      .eq('account_id', accountId)
      .eq('coming_soon_mode', mode)
      .in('status', ['active', 'draft'])
    const ids = (flows ?? []).map((f) => f.id as string)
    if (!ids.length) return
    await db.from('flows').update({ status: active ? 'active' : 'draft' }).in('id', ids)
    if (!active) {
      // Whoever is mid-menu would keep getting its plan/price
      // nodes; close those runs so the next message starts clean.
      await db
        .from('flow_runs')
        .update({
          status: 'completed',
          ended_at: new Date().toISOString(),
          end_reason: 'coming_soon_switch',
        })
        .in('flow_id', ids)
        .eq('status', 'active')
    }
  }
  await swap('off_only', !on)
  await swap('on_only', on)
}
