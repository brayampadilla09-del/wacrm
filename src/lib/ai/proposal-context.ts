import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Contexto de propuesta: tras enviarle al cliente el PDF de su propuesta,
// pagina-estudio deja en wacrm (POST /api/v1/contacts) la etiqueta
// «Propuesta enviada» y un resumen estructurado como nota del contacto.
// Mientras ambas existan y la nota sea reciente, la IA responde preguntas
// SOLO con ese resumen y el menú del flow solo arranca con "menú".
// ============================================================

/** Etiqueta que marca al contacto que recibió su propuesta. */
export const PROPOSAL_TAG = 'Propuesta enviada'
/** Primera línea de la nota que guarda el resumen (distingue esta nota de las del equipo). */
export const PROPOSAL_NOTE_MARKER = '[[propuesta]]'
/** Cuánto tiempo después de enviada la propuesta la IA sigue usando su resumen. */
export const PROPOSAL_CONTEXT_MAX_AGE_DAYS = 14
/** Una conversación con propuesta reciente no se cierra por inactividad antes de estas horas. */
export const PROPOSAL_INACTIVITY_HOURS = 24
/** Respuestas de IA por conversación mientras explica la propuesta (el tope normal, 3, se queda corto). */
export const PROPOSAL_MAX_REPLIES = 8
/** Tope del resumen que entra al prompt (mantiene el contexto pequeño). */
export const PROPOSAL_NOTE_MAX_CHARS = 3000

export interface ProposalContext {
  text: string
  createdAt: string
}

/** Nota del contacto con el resumen: marcador + salto + texto recortado. */
export function buildProposalNote(text: string): string {
  const body = text.trim().slice(0, PROPOSAL_NOTE_MAX_CHARS)
  return `${PROPOSAL_NOTE_MARKER}\n${body}`
}

/** Texto del resumen si la nota es de propuesta; null si es una nota cualquiera. */
export function parseProposalNote(noteText: string | null | undefined): string | null {
  if (!noteText || !noteText.startsWith(PROPOSAL_NOTE_MARKER)) return null
  const body = noteText.slice(PROPOSAL_NOTE_MARKER.length).trim()
  return body || null
}

export function isProposalContextFresh(createdAt: string, now: Date = new Date()): boolean {
  const t = new Date(createdAt).getTime()
  if (!Number.isFinite(t)) return false
  return now.getTime() - t <= PROPOSAL_CONTEXT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const MENU_RESTART = new Set(['menu', 'ver menu', 'el menu', 'menu principal', 'volver al menu', 'abrir menu', 'mostrar menu'])

/** Palabra explícita de reinicio: con propuesta reciente solo esto arranca el menú del flow. */
export function isMenuRestart(text: string): boolean {
  return MENU_RESTART.has(normalize(text))
}

/**
 * El resumen de la propuesta vigente del contacto, o null. Exige la etiqueta
 * «Propuesta enviada» Y una nota de propuesta de los últimos 14 días. Nunca lanza.
 */
export async function loadProposalContext(
  db: SupabaseClient,
  contactId: string,
  now: Date = new Date(),
): Promise<ProposalContext | null> {
  try {
    const { data: tagged } = await db
      .from('contact_tags')
      .select('tags!inner(name)')
      .eq('contact_id', contactId)
      .ilike('tags.name', PROPOSAL_TAG)
      .limit(1)
    if (!tagged || tagged.length === 0) return null

    const { data: notes } = await db
      .from('contact_notes')
      .select('note_text, created_at')
      .eq('contact_id', contactId)
      .like('note_text', `${PROPOSAL_NOTE_MARKER}%`)
      .order('created_at', { ascending: false })
      .limit(1)
    const row = notes?.[0] as { note_text: string; created_at: string } | undefined
    if (!row) return null
    const text = parseProposalNote(row.note_text)
    if (!text || !isProposalContextFresh(row.created_at, now)) return null
    return { text, createdAt: row.created_at }
  } catch (err) {
    console.error('[ai proposal-context] load failed:', err)
    return null
  }
}

/** Instrucciones para la IA cuando el cliente acaba de recibir su propuesta. */
export function buildProposalPrompt(summary: string): string {
  return [
    'Contexto de la conversación: BSign le acaba de enviar a este cliente, por este mismo chat, el PDF de su propuesta de diseño (el mensaje dice algo como "Aquí tienes tu propuesta de diseño de BSign. Si quieres, te la explico por aquí"). Eres Bimi, el asistente de BSign Estudio, y estás aquí para explicarle SU propuesta.',
    `Datos de la propuesta del cliente (única fuente de verdad):\n${summary.trim()}`,
    [
      'Reglas:',
      '- Responde SOLO con lo que esos datos dicen: plan, valor, descuento, anticipo, vigencia, qué incluye y qué no, tiempo estimado y lo que el cliente contó de su espacio.',
      '- No inventes precios, descuentos extra, fechas de entrega o de inicio, formas de pago ni condiciones que no estén en los datos.',
      '- Si pregunta algo que no está en los datos (descuentos adicionales, fechas exactas, cambiar de plan, formas de pago, contrato, otros servicios), responde exactamente [[HANDOFF]] y nada más: el equipo lo confirma.',
      '- Si el mensaje es genérico (sí, hola, gracias, ok, un emoji), reconoce que acaba de recibir su propuesta y pregunta en una línea qué quiere saber de ella, por ejemplo el plan, el valor, qué incluye o los tiempos. No te presentes de nuevo ni mandes el menú.',
      '- Respuestas cortas para WhatsApp (máximo 4 frases), cálidas y en español. No uses guiones largos.',
      '- Si quiere agendar o cancelar una cita u otro trámite, dile que escriba *menú*.',
    ].join('\n'),
  ].join('\n\n')
}
