import { isBsuid } from '@/lib/whatsapp/meta-api'
import { isValidE164, phoneVariants, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'

// Quien oculta su número (nombre de usuario de WhatsApp) no tiene teléfono: solo su BSUID.
// Los envíos del motor de Flows y de automatizaciones exigían contact.phone y fallaban con
// "contact not found for this account" justo en el primer mensaje, así que Bimi nunca contestaba.

export function hasRecipient(contact: { phone?: string | null; bsuid?: string | null }): boolean {
  return Boolean(contact.phone || contact.bsuid)
}

/** Lo que va en `to`/`recipient` de Meta: el teléfono saneado, o el BSUID si no hay teléfono. */
export function resolveRecipient(contact: { phone?: string | null; bsuid?: string | null }): string {
  if (contact.phone) {
    const sanitized = sanitizePhoneForMeta(contact.phone)
    if (!isValidE164(sanitized)) {
      throw new Error(`contact phone invalid: ${contact.phone}`)
    }
    return sanitized
  }
  if (contact.bsuid && isBsuid(contact.bsuid)) return contact.bsuid
  throw new Error(`contact bsuid invalid: ${contact.bsuid}`)
}

/** Un BSUID no tiene variantes de teléfono que reintentar. */
export function recipientVariants(recipient: string): string[] {
  return isBsuid(recipient) ? [recipient] : phoneVariants(recipient)
}
