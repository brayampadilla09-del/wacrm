import crypto from 'node:crypto'

/**
 * Verify the HMAC-SHA256 signature Meta attaches to webhook POSTs,
 * against an explicit secret.
 *
 * Meta signs the raw request body with the App Secret of whichever
 * Meta App owns the webhook subscription, and sends the result in the
 * `x-hub-signature-256: sha256=<hex>` header. Without verification,
 * anyone who knows our webhook URL can POST fabricated events.
 *
 * Reference:
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verify-payloads
 */
export function verifySignatureWithSecret(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader) return false
  if (!signatureHeader.startsWith('sha256=')) return false

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex')

  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  // Bail if lengths differ — timingSafeEqual throws otherwise.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * Verify a webhook POST from the WhatsApp Business Account app —
 * always `META_APP_SECRET`.
 *
 * Contract: `META_APP_SECRET` is **required**. If it's missing we fail
 * closed — every request is rejected until the operator configures
 * the secret. A previous version fell open with a warning log, which
 * is unsafe for a public template: anyone who forgets the env var
 * would be running a fully spoofable webhook.
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  const secret = process.env.META_APP_SECRET
  if (!secret) {
    console.error(
      '[webhook] META_APP_SECRET is not set — rejecting request. ' +
        'Configure the env var (Meta → App Settings → Basic → App Secret) ' +
        'to enable signature verification.',
    )
    return false
  }
  return verifySignatureWithSecret(rawBody, signatureHeader, secret)
}
