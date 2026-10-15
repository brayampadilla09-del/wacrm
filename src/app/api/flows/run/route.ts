import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { startFlowManually } from '@/lib/flows/engine'

/**
 * POST /api/flows/run  (agent+)
 *
 * Body: { conversation_id, flow_id }
 *
 * Botón de emergencia del inbox: corre un Flow a mano sobre una conversación cuando el
 * bot no contestó. Cierra el run activo del contacto y arranca el Flow desde su entrada.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`flow-run:${userId}`, { limit: 20, windowMs: 60_000 })
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const conversationId =
      body && typeof body.conversation_id === 'string' ? body.conversation_id : ''
    const flowId = body && typeof body.flow_id === 'string' ? body.flow_id : ''
    if (!conversationId || !flowId) {
      return NextResponse.json({ error: 'conversation_id and flow_id are required' }, { status: 400 })
    }

    const result = await startFlowManually({ accountId, conversationId, flowId })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ flow_run_id: result.flowRunId, outcome: result.outcome })
  } catch (err) {
    return toErrorResponse(err)
  }
}
