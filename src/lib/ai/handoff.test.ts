import { describe, it, expect } from 'vitest'
import { buildHandoffSummary, describeFlowVars } from './handoff'

describe('buildHandoffSummary', () => {
  it('states the reason and quotes the last customer message', () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: 'user', content: 'Hola' },
        { role: 'assistant', content: '¡Hola! ¿En qué te ayudo?' },
        { role: 'user', content: 'quiero un reembolso' },
      ],
      reason: 'ai_unsure',
    })
    expect(summary).toBe(
      '🤖 Pasó al equipo: la IA no tenía cómo responder con certeza.\nÚltimo mensaje del cliente: “quiero un reembolso”',
    )
  })

  it('lists the scalar flow answers', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: 'no entiendo' }],
      reason: 'flow_fallback',
      vars: { space_type: 'Residencial', color_choice: 'Neutros y cálidos' },
    })
    expect(summary).toContain('Datos del flujo: space_type: Residencial · color_choice: Neutros y cálidos.')
  })

  it('picks the most recent customer turn, ignoring assistant turns', () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'a reply' },
      ],
      reason: 'ai_limit',
    })
    expect(summary).toContain('“second”')
  })

  it('collapses whitespace and truncates a long message', () => {
    const long = 'x'.repeat(300)
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: long }],
      reason: 'flow_node',
    })
    expect(summary).toContain('…')
    // 160-char cap on the quote; the whole note stays well under 250.
    expect(summary.length).toBeLessThan(250)
  })

  it('degrades gracefully when there is no customer message', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'assistant', content: 'greeting' }],
      reason: 'flow_node',
    })
    expect(summary).toBe('🤖 Pasó al equipo: el flujo lo pasó al equipo.')
  })
})

describe('describeFlowVars', () => {
  it('keeps scalars and drops internal keys and fetched payloads', () => {
    expect(
      describeFlowVars({
        space_type: 'Oficina',
        _returning: 'true',
        avail: { options: [{ id: 'a', title: 'b' }] },
        rows: ['x'],
        count: 3,
        empty: '  ',
      }),
    ).toEqual(['space_type: Oficina', 'count: 3'])
  })

  it('returns [] for missing vars', () => {
    expect(describeFlowVars(null)).toEqual([])
  })
})
