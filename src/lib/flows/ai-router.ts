import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

export interface FlowIntentCandidate {
  id: string
  name: string
  description: string | null
}

export interface MenuOptionCandidate {
  reply_id: string
  title: string
  description?: string
}

/**
 * Shared "pick the best-matching numbered option, or none" call. Both
 * classifiers below are the same shape — a customer message + a numbered
 * list of options + a system prompt telling the model what the options
 * represent — so the provider call, rate limit, and response parsing
 * live here once.
 *
 * Returns a 1-based index into `optionLines`, or null when: AI isn't
 * configured/active for the account, the account hit its routing rate
 * limit, the provider call failed, or the model answered with 0 / didn't
 * confidently pick one. Every null case is a no-op for the caller — this
 * never throws and never forces a match.
 */
async function classifyAgainstOptions(args: {
  db: SupabaseClient
  accountId: string
  text: string
  systemPrompt: string
  optionLines: string[]
}): Promise<number | null> {
  const { db, accountId, text, systemPrompt, optionLines } = args
  if (!text.trim() || optionLines.length === 0) return null

  try {
    const config = await loadAiConfig(db, accountId)
    if (!config) return null

    const limit = checkRateLimit(
      `ai-flow-router:${accountId}`,
      RATE_LIMITS.aiFlowRouterAccount,
    )
    if (!limit.success) return null

    const { text: raw } = await generateReply({
      config,
      systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Mensaje del cliente: "${text.trim()}"\n\nOpciones:\n${optionLines.join('\n')}\n\nNúmero:`,
        },
      ],
    })

    const match = raw.trim().match(/\d+/)
    if (!match) return null
    const idx = Number(match[0])
    if (!Number.isInteger(idx) || idx < 1 || idx > optionLines.length) return null
    return idx
  } catch (err) {
    console.error('[flows] AI classification failed:', err)
    return null
  }
}

/**
 * AI-assisted fallback for flow entry-trigger matching.
 *
 * `findEntryFlow` in engine.ts calls this ONLY after its deterministic
 * keyword/first-inbound loop comes up empty — so an exact keyword hit
 * always wins and never reaches an LLM call. This just widens what counts
 * as "the customer wants flow X" beyond literal keywords: a greeting that
 * doesn't include the exact trigger word, "necesito una cita para el
 * jueves" against a flow whose keywords are just ["agendar", "cita"],
 * etc. Flows stay the deterministic, precedence-winning layer described
 * in the webhook's CANONICAL PRECEDENCE ORDER block — this only makes the
 * matching step smarter, not lower-priority.
 */
export async function classifyFlowIntent(
  db: SupabaseClient,
  accountId: string,
  text: string,
  candidates: FlowIntentCandidate[],
): Promise<string | null> {
  const idx = await classifyAgainstOptions({
    db,
    accountId,
    text,
    systemPrompt:
      'Eres un clasificador de intención para un bot de WhatsApp. Se te da el mensaje de un cliente y una lista numerada de flujos de conversación disponibles, cada uno con su nombre y una descripción de cuándo aplica. ' +
      'Responde ÚNICAMENTE con el número del flujo cuya intención coincide mejor con el mensaje del cliente, o con 0 si ninguno aplica con confianza — incluye saludos genéricos sin intención clara, mensajes ambiguos, o cualquier cosa que no encaje bien con una de las descripciones. ' +
      'No expliques tu respuesta, no agregues texto adicional — responde solo con el número.',
    optionLines: candidates.map(
      (c, i) => `${i + 1}. ${c.name}${c.description ? ` — ${c.description}` : ''}`,
    ),
  })
  return idx ? candidates[idx - 1].id : null
}

/**
 * AI-assisted fallback for matching a customer's free-text reply against
 * the options on the flow's CURRENT send_buttons/send_list node.
 *
 * `handleReplyForActiveRun` in engine.ts calls this only after the
 * deterministic tap match and `matchButtonTextReply`'s literal
 * phrase-contains check both come up empty. That literal check is what
 * misses things like "quiero agendar una cita" against a button titled
 * "Agendar cita de diseño" ("una" breaks the substring match) — without
 * this AI pass, that reply falls through to the restart-by-keyword check,
 * and when the flow's own entry keywords overlap with its menu option
 * words (as "agendar" typically does), the flow restarts itself from the
 * welcome message instead of advancing — which reads to the customer as
 * the bot ignoring what they just said.
 */
export async function classifyMenuOptionIntent(
  db: SupabaseClient,
  accountId: string,
  text: string,
  options: MenuOptionCandidate[],
): Promise<string | null> {
  const idx = await classifyAgainstOptions({
    db,
    accountId,
    text,
    systemPrompt:
      'Eres un clasificador de intención para un bot de WhatsApp. El bot le mostró al cliente un menú de opciones (botones o una lista), y el cliente respondió con texto libre en vez de tocar una. ' +
      'Se te da su mensaje y la lista numerada de opciones disponibles. Responde ÚNICAMENTE con el número de la opción que el cliente probablemente quiso elegir, o con 0 si su mensaje no corresponde con confianza a ninguna opción de la lista (por ejemplo, si parece una pregunta distinta o un comentario). ' +
      'No expliques tu respuesta, no agregues texto adicional — responde solo con el número.',
    optionLines: options.map(
      (o, i) => `${i + 1}. ${o.title}${o.description ? ` — ${o.description}` : ''}`,
    ),
  })
  return idx ? options[idx - 1].reply_id : null
}
