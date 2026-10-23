import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * "Reset to new": leaves a contact as if it had never talked to the bot. The contact row (name, phone, email) stays;
 * everything that remembers the relationship goes: conversations (their messages cascade), notes (including the proposal
 * note the AI reads), tags, custom field values, flow runs and queued automation steps. Broadcast recipients, deals,
 * automation logs and notifications are history and stay (their contact link is already nullable and the UI is null-safe).
 *
 * Meant for cleaning up test contacts, so the route behind it asks the caller to type the contact's phone first.
 */

export class ContactResetError extends Error {
  readonly status: number

  constructor(message: string, status = 500) {
    super(message)
    this.name = 'ContactResetError'
    this.status = status
  }
}

/** Tables wiped for the contact, in order; each one links to the contact through `contact_id`. */
export const RESET_TABLES = [
  'conversations',
  'contact_notes',
  'contact_tags',
  'contact_custom_values',
  'flow_runs',
  'automation_pending_executions',
] as const

export type ResetCounts = Record<(typeof RESET_TABLES)[number], number>

/**
 * `db` is the caller's own (RLS scoped) client: it only proves the contact belongs to the caller's account. The deletes
 * go through `admin` (service role) because flow runs and queued automation steps are written, and so removed, by the
 * engine and have no delete policy for users.
 */
export async function resetContact(
  db: SupabaseClient,
  admin: SupabaseClient,
  input: { accountId: string; contactId: string; confirmPhone: string },
): Promise<{ contactId: string; deleted: ResetCounts }> {
  const { data: contact, error } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (error) throw new ContactResetError('Could not read the contact', 500)
  if (!contact) throw new ContactResetError('Contact not found', 404)

  // Typing the phone is the guard (like typing a repo name on GitHub): names can be empty or repeated, phones cannot.
  const typed = input.confirmPhone.replace(/\s+/g, '')
  if (!typed || typed !== String(contact.phone).replace(/\s+/g, '')) {
    throw new ContactResetError("Type the contact's phone number exactly to confirm", 409)
  }

  const deleted = {} as ResetCounts
  for (const table of RESET_TABLES) {
    const { count, error: deleteError } = await admin
      .from(table)
      .delete({ count: 'exact' })
      .eq('contact_id', input.contactId)
    if (deleteError) {
      throw new ContactResetError(`Could not clear ${table}`, 500)
    }
    deleted[table] = count ?? 0
  }
  return { contactId: input.contactId, deleted }
}
