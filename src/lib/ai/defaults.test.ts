import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, HANDOFF_SENTINEL } from './defaults'

describe('buildSystemPrompt', () => {
  it('teaches the handoff protocol only in automatic modes', () => {
    expect(buildSystemPrompt({ userPrompt: null, mode: 'draft' })).not.toContain(HANDOFF_SENTINEL)
    expect(buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })).toContain(HANDOFF_SENTINEL)
    expect(buildSystemPrompt({ userPrompt: null, mode: 'flow_assist' })).toContain(HANDOFF_SENTINEL)
  })

  it('gives flow_assist the menu step and tells it not to repeat the options', () => {
    const prompt = buildSystemPrompt({
      userPrompt: 'Somos BSign.',
      mode: 'flow_assist',
      flowStep: {
        prompt: '¿En qué te ayudo hoy?',
        expects: 'choice',
        options: ['Cita de descubrimiento', 'Ver proyectos'],
      },
    })
    expect(prompt).toContain('"¿En qué te ayudo hoy?"')
    expect(prompt).toContain('- Cita de descubrimiento\n- Ver proyectos')
    expect(prompt).toContain('re-sent automatically')
    expect(prompt).toContain('Somos BSign.')
  })

  it('describes a typed-answer step without an options list', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'flow_assist',
      flowStep: { prompt: '¿A qué correo te envío la confirmación?', expects: 'text', options: [] },
    })
    expect(prompt).toContain('expects a typed answer')
    expect(prompt).not.toContain('with these options')
  })

  it('tells automatic modes to hand off when the knowledge base does not cover it', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'flow_assist',
      knowledge: ['Planes: Origen $80.000'],
    })
    expect(prompt).toContain('[1] Planes: Origen $80.000')
    expect(prompt).toContain(`do not guess — reply with exactly ${HANDOFF_SENTINEL}`)
  })
})
