import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { AiConfig, AiProvider } from './types'
import { loadProposalContext, PROPOSAL_MAX_REPLIES } from './proposal-context'

interface AiConfigRow {
  provider: AiProvider
  model: string
  api_key: string
  system_prompt: string | null
  is_active: boolean
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number
  handoff_agent_id: string | null
  embeddings_api_key: string | null
  coming_soon_enabled: boolean
  coming_soon_prompt: string | null
  coming_soon_max_replies: number
}

const CONFIG_COLUMNS =
  'provider, model, api_key, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, embeddings_api_key, coming_soon_enabled, coming_soon_prompt, coming_soon_max_replies'

/** Tag that exempts a contact from the coming soon mode (early-access tests). */
export const EARLY_ACCESS_TAG = 'acceso-anticipado'

export async function hasEarlyAccessTag(
  db: SupabaseClient,
  contactId: string,
): Promise<boolean> {
  const { data } = await db
    .from('contact_tags')
    .select('tags!inner(name)')
    .eq('contact_id', contactId)
    .eq('tags.name', EARLY_ACCESS_TAG)
    .limit(1)
  return (data?.length ?? 0) > 0
}

/**
 * Load and decrypt the account's AI config for *use* (draft or
 * auto-reply). Returns `null` when there's no row or the master switch
 * (`is_active`) is off — both mean "AI is not available", which callers
 * treat identically. Throws only if the stored key can't be decrypted
 * (mismatched `ENCRYPTION_KEY`), so that distinct failure surfaces
 * rather than looking like "not configured".
 *
 * Works with any client: pass the RLS-scoped SSR client from a
 * dashboard route, or the service-role admin client from the webhook.
 */
export async function loadAiConfig(
  db: SupabaseClient,
  accountId: string,
  opts: { requireActive?: boolean; contactId?: string } = {},
): Promise<AiConfig | null> {
  const { requireActive = true, contactId } = opts
  const { data, error } = await db
    .from('ai_configs')
    .select(CONFIG_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as AiConfigRow
  // Acceso anticipado: a contact carrying the early-access tag gets the
  // normal assistant even while the coming soon mode is on for everyone.
  if (row.coming_soon_enabled && contactId && (await hasEarlyAccessTag(db, contactId))) {
    row.coming_soon_enabled = false
  }
  // Propuesta enviada: a contact who just received their proposal PDF gets the
  // normal assistant (and the normal reply budget + handoff) even while the
  // coming soon mode is on, so they can ask about it. The prompt itself is
  // swapped for the proposal one in the auto-reply (see proposalContext).
  let proposalContext: string | null = null
  if (contactId) {
    proposalContext = (await loadProposalContext(db, contactId))?.text ?? null
    if (proposalContext && row.coming_soon_enabled) row.coming_soon_enabled = false
  }
  // The Playground passes requireActive:false so an admin can test the
  // agent before flipping the master switch on.
  if (requireActive && !row.is_active) return null
  // Defensive: the column is NOT NULL, but a partial write / manual DB
  // edit could leave it empty. Treat a missing key as "not configured"
  // rather than letting decrypt() throw on null.
  if (!row.api_key) return null

  // The embeddings key is optional and independent of the chat key —
  // a corrupt/undecryptable one should downgrade to lexical KB, not
  // take down draft/auto-reply, so decrypt failures are swallowed here.
  let embeddingsApiKey: string | null = null
  if (row.embeddings_api_key) {
    try {
      embeddingsApiKey = decrypt(row.embeddings_api_key)
    } catch {
      // Not silent — a rotated/mismatched ENCRYPTION_KEY here means
      // semantic search quietly stops working, so leave a breadcrumb.
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`,
      )
      embeddingsApiKey = null
    }
  }

  return {
    provider: row.provider,
    model: row.model,
    apiKey: decrypt(row.api_key),
    // "Modo muy pronto" swaps the persona/knowledge prompt wholesale, so
    // nothing in the normal one (plans, prices) can leak while it is on.
    systemPrompt:
      row.coming_soon_enabled && row.coming_soon_prompt
        ? row.coming_soon_prompt
        : row.system_prompt,
    comingSoon: row.coming_soon_enabled === true,
    isActive: row.is_active,
    autoReplyEnabled: row.auto_reply_enabled,
    // With nobody to hand over to, the coming soon mode gets its own,
    // larger reply budget; the normal one is left alone.
    autoReplyMaxPerConversation: row.coming_soon_enabled
      ? row.coming_soon_max_replies
      : proposalContext
        ? Math.max(row.auto_reply_max_per_conversation, PROPOSAL_MAX_REPLIES)
        : row.auto_reply_max_per_conversation,
    handoffAgentId: row.handoff_agent_id,
    embeddingsApiKey,
    proposalContext,
  }
}

/**
 * Load + decrypt just the embeddings key, independent of `is_active`.
 * Used by the knowledge-base ingest routes so the KB gets embedded (and
 * semantic search works) whenever an embeddings key is present, even if
 * the assistant's master switch is currently off.
 *
 * Returns `{ key, corrupt }`: `key` is null when there's no key OR it
 * can't be decrypted; `corrupt` distinguishes those cases so callers can
 * warn ("a key is set but unusable") rather than silently indexing
 * lexical-only and reporting success.
 */
export async function loadEmbeddingsKey(
  db: SupabaseClient,
  accountId: string,
): Promise<{ key: string | null; corrupt: boolean }> {
  const { data, error } = await db
    .from('ai_configs')
    .select('embeddings_api_key')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !data?.embeddings_api_key) return { key: null, corrupt: false }
  try {
    return { key: decrypt(data.embeddings_api_key), corrupt: false }
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`,
    )
    return { key: null, corrupt: true }
  }
}
