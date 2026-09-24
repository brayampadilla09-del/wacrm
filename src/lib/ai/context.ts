import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
}

/**
 * Message kinds whose `content_text` is conversation the model should
 * see: plain text, interactive messages (a flow's menu prompt, or the
 * title of the button/row the customer tapped) and templates (the
 * appointment/order notifications the customer is often replying to).
 * Media without a caption carries no text and is left out.
 */
export const CONTEXT_CONTENT_TYPES = ['text', 'interactive', 'template'] as const

/**
 * Fetch the last N text-bearing messages of a conversation and map them
 * to the provider-neutral chat shape. Customer messages become `user`;
 * agent and bot messages become `assistant`.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_text')
    .eq('conversation_id', conversationId)
    .in('content_type', [...CONTEXT_CONTENT_TYPES])
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  return rows
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: m.content_text!.trim(),
    }))
}
