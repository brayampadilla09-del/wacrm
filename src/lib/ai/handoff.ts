import type { ChatMessage } from './types'

/** Longest the quoted customer message runs before we ellipsize it —
 *  keeps the internal note to a glanceable one-liner. */
const MAX_QUOTE_LEN = 160

/** Longest a single flow variable value runs in a note. */
const MAX_VAR_LEN = 80

/**
 * Why a conversation left the bot. Drives the label on the internal
 * note and gives the summarizer the reason to state.
 */
export type HandoffReason =
  /** A flow `handoff` node ran (e.g. the customer picked "talk to an advisor"). */
  | 'flow_node'
  /** The customer kept replying off-menu until the flow's reprompts ran out. */
  | 'flow_fallback'
  /** The model said it couldn't answer confidently ([[HANDOFF]]). */
  | 'ai_unsure'
  /** The per-conversation AI reply budget ran out. */
  | 'ai_limit'
  /** An agent asked for a summary from the inbox. */
  | 'manual'

export const HANDOFF_REASON_LABEL: Record<HandoffReason, string> = {
  flow_node: 'el flujo lo pasó al equipo',
  flow_fallback: 'el bot no entendió varias respuestas seguidas',
  ai_unsure: 'la IA no tenía cómo responder con certeza',
  ai_limit: 'la IA ya respondió lo que podía en esta conversación',
  manual: 'resumen pedido desde la bandeja',
}

/**
 * Flow variables worth showing a person: scalar answers the flow
 * captured (space type, chosen slot, questionnaire picks). Skips
 * internal keys (leading `_`) and fetched payloads (objects/arrays,
 * e.g. an availability response), which are noise in a note.
 */
export function describeFlowVars(
  vars: Record<string, unknown> | null | undefined,
): string[] {
  if (!vars) return []
  const lines: string[] = []
  for (const [key, value] of Object.entries(vars)) {
    if (key.startsWith('_')) continue
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
    const text = truncate(String(value).trim(), MAX_VAR_LEN)
    if (!text) continue
    lines.push(`${key}: ${text}`)
  }
  return lines
}

/**
 * Deterministic internal note for a handoff — used when the AI summary
 * isn't available (AI off, provider error), so the team always gets
 * *something* to start from. Composed from context we already have (no
 * LLM call), so it can't fail or add latency to the handoff.
 *
 * Reads as, e.g.:
 *   "🤖 Pasó al equipo: el bot no entendió varias respuestas seguidas.
 *    Datos del flujo: space_type: Residencial · color_choice: Neutros.
 *    Último mensaje del cliente: “¿hacen cocinas?”"
 */
export function buildHandoffSummary(args: {
  messages: ChatMessage[]
  reason: HandoffReason
  vars?: Record<string, unknown> | null
}): string {
  const { messages, reason, vars } = args

  const parts = [`🤖 Pasó al equipo: ${HANDOFF_REASON_LABEL[reason]}.`]

  const varLines = describeFlowVars(vars)
  if (varLines.length > 0) parts.push(`Datos del flujo: ${varLines.join(' · ')}.`)

  const lastCustomer = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && m.content.trim())
  if (lastCustomer) {
    const quote = truncate(lastCustomer.content.trim(), MAX_QUOTE_LEN)
    parts.push(`Último mensaje del cliente: “${quote}”`)
  }

  return parts.join('\n')
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ')
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1).trimEnd()}…`
}
