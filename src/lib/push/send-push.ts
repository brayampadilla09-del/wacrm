// ============================================================
// Web Push — sends a real OS-level notification to every device a
// user has subscribed from (migration 043). Independent of the
// in-app `notifications` table: that table drives the bell/badge for
// whoever has the app open, this drives the phone/desktop push for
// whoever doesn't. Callers create both (see notify-new-lead.ts /
// notify-new-message.ts) rather than one implying the other.
//
// Best-effort by design, same contract as notifyNewLead: a push
// failure must never fail the request that triggered it.
// ============================================================

import webpush from 'web-push'
import type { SupabaseClient } from '@supabase/supabase-js'

let _vapidConfigured = false

function ensureVapid() {
  if (_vapidConfigured) return
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT
  if (!publicKey || !privateKey || !subject) {
    throw new Error('VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT must all be set')
  }
  webpush.setVapidDetails(subject, publicKey, privateKey)
  _vapidConfigured = true
}

export interface PushPayload {
  title: string
  body: string
  /** App-relative path to open on click, e.g. `/inbox?c=<id>`. */
  url?: string
}

/**
 * Push `payload` to every subscription owned by any of `userIds`.
 * Expired/unregistered subscriptions (Meta-equivalent: 404/410 from the
 * push service) are deleted so they stop being retried forever.
 */
export async function sendPushToUsers(
  db: SupabaseClient,
  userIds: string[],
  payload: PushPayload,
): Promise<void> {
  const uniqueIds = [...new Set(userIds)]
  if (uniqueIds.length === 0) return

  try {
    ensureVapid()
  } catch (err) {
    console.error('[sendPushToUsers] VAPID not configured, skipping:', err)
    return
  }

  const { data: subs, error } = await db
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth_key')
    .in('user_id', uniqueIds)

  if (error) {
    console.error('[sendPushToUsers] failed to load subscriptions:', error)
    return
  }
  if (!subs || subs.length === 0) return

  const body = JSON.stringify(payload)

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth_key },
          },
          body,
        )
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode
        if (statusCode === 404 || statusCode === 410) {
          // Subscription no longer exists on the push service (browser
          // data cleared, uninstalled, etc.) — stop trying it forever.
          await db.from('push_subscriptions').delete().eq('id', sub.id)
        } else {
          console.error('[sendPushToUsers] send failed for subscription', sub.id, err)
        }
      }
    }),
  )
}
