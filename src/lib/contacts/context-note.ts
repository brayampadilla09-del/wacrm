import type { SupabaseClient } from '@supabase/supabase-js'

import {
  buildProposalNote,
  PROPOSAL_NOTE_MARKER,
  PROPOSAL_NOTE_MAX_CHARS,
} from '@/lib/ai/proposal-context'
import { ContactError } from '@/lib/api/v1/contacts'

/** Kinds of context note the public API accepts (`context_note.kind`). */
export const CONTEXT_NOTE_KINDS = ['proposal'] as const
export type ContextNoteKind = (typeof CONTEXT_NOTE_KINDS)[number]

export interface ContextNoteInput {
  kind: ContextNoteKind
  text: string
}

/**
 * Validate the optional `context_note` of POST /api/v1/contacts. Returns null
 * when absent; throws a 400 ContactError when malformed.
 */
export function parseContextNote(raw: unknown): ContextNoteInput | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ContactError("'context_note' must be an object", 400)
  }
  const { kind, text } = raw as Record<string, unknown>
  if (typeof kind !== 'string' || !(CONTEXT_NOTE_KINDS as readonly string[]).includes(kind)) {
    throw new ContactError(
      `'context_note.kind' must be one of: ${CONTEXT_NOTE_KINDS.join(', ')}`,
      400,
    )
  }
  if (typeof text !== 'string' || !text.trim()) {
    throw new ContactError("'context_note.text' is required", 400)
  }
  if (text.length > PROPOSAL_NOTE_MAX_CHARS) {
    throw new ContactError(
      `'context_note.text' must be at most ${PROPOSAL_NOTE_MAX_CHARS} characters`,
      400,
    )
  }
  return { kind: kind as ContextNoteKind, text: text.trim() }
}

/**
 * Save the proposal summary as the contact's single "proposal" note (replacing
 * a previous one) and hand the thread back to the bot: a new proposal resets
 * the AI reply budget and lifts an old handoff pause, unless a person is
 * assigned to the conversation.
 */
export async function saveProposalContextNote(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  contactId: string,
  text: string,
): Promise<void> {
  const { error: delErr } = await db
    .from('contact_notes')
    .delete()
    .eq('contact_id', contactId)
    .like('note_text', `${PROPOSAL_NOTE_MARKER}%`)
  if (delErr) throw new ContactError('Failed to replace the proposal note', 500)

  const { error: insErr } = await db.from('contact_notes').insert({
    contact_id: contactId,
    account_id: accountId,
    user_id: auditUserId,
    note_text: buildProposalNote(text),
  })
  if (insErr) {
    console.error('[api/v1/contacts] proposal note insert failed:', insErr)
    throw new ContactError('Failed to save the proposal note', 500)
  }

  const { error: resetErr } = await db
    .from('conversations')
    .update({ ai_reply_count: 0, ai_autoreply_disabled: false })
    .eq('contact_id', contactId)
    .is('assigned_agent_id', null)
  if (resetErr) {
    // Best effort: the note is saved; a stale pause only delays the bot.
    console.error('[api/v1/contacts] AI state reset failed:', resetErr.message)
  }

  // A menu run still waiting on a tap would swallow the customer's reply to
  // the proposal ("ok", "¿cuánto cuesta?"): the engine reads it as an aside to
  // that menu, the generic AI answers without the proposal and the menu step
  // is re-sent, so the thread never reaches the proposal answers. Close it.
  const { error: runErr } = await db
    .from('flow_runs')
    .update({
      status: 'completed',
      ended_at: new Date().toISOString(),
      end_reason: 'proposal_sent',
    })
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'active')
  if (runErr) {
    console.error('[api/v1/contacts] closing the active flow run failed:', runErr.message)
  }
}
