import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildProposalNote,
  buildProposalPrompt,
  isMenuRestart,
  isProposalContextFresh,
  loadProposalContext,
  parseProposalNote,
  PROPOSAL_NOTE_MARKER,
  PROPOSAL_NOTE_MAX_CHARS,
} from './proposal-context'

describe('proposal note', () => {
  it('round-trips the summary through the marker', () => {
    const note = buildProposalNote('  Plan: Wellness  ')
    expect(note.startsWith(PROPOSAL_NOTE_MARKER)).toBe(true)
    expect(parseProposalNote(note)).toBe('Plan: Wellness')
  })

  it('caps the summary and ignores ordinary notes', () => {
    expect(parseProposalNote(buildProposalNote('x'.repeat(10_000)))!.length).toBe(PROPOSAL_NOTE_MAX_CHARS)
    expect(parseProposalNote('Llamar el lunes')).toBeNull()
    expect(parseProposalNote(PROPOSAL_NOTE_MARKER)).toBeNull()
    expect(parseProposalNote(null)).toBeNull()
  })
})

describe('isProposalContextFresh', () => {
  const now = new Date('2026-10-23T12:00:00Z')
  it('is true within 14 days and false after', () => {
    expect(isProposalContextFresh('2026-10-10T12:00:00Z', now)).toBe(true)
    expect(isProposalContextFresh('2026-10-09T11:00:00Z', now)).toBe(false)
    expect(isProposalContextFresh('not a date', now)).toBe(false)
  })
})

describe('isMenuRestart', () => {
  it('accepts only the explicit menu words', () => {
    for (const t of ['menú', 'Menu', ' MENÚ! ', 'ver menú', 'menu principal']) expect(isMenuRestart(t)).toBe(true)
    for (const t of ['hola', 'sí', 'gracias', 'quiero el menú de la cita', 'cuánto cuesta', '']) expect(isMenuRestart(t)).toBe(false)
  })
})

function fakeDb(tagged: unknown[], notes: unknown[]): SupabaseClient {
  const make = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'ilike', 'like', 'order']) chain[m] = () => chain
    chain.limit = () => Promise.resolve({ data: rows, error: null })
    return chain
  }
  return {
    from: (table: string) => make(table === 'contact_tags' ? tagged : notes),
  } as unknown as SupabaseClient
}

describe('loadProposalContext', () => {
  const now = new Date('2026-10-23T12:00:00Z')
  const note = { note_text: buildProposalNote('Plan: Sueño'), created_at: '2026-10-20T12:00:00Z' }

  it('returns the summary when tagged and recent', async () => {
    const ctx = await loadProposalContext(fakeDb([{}], [note]), 'c1', now)
    expect(ctx).toEqual({ text: 'Plan: Sueño', createdAt: '2026-10-20T12:00:00Z' })
  })

  it('needs the tag', async () => {
    expect(await loadProposalContext(fakeDb([], [note]), 'c1', now)).toBeNull()
  })

  it('needs a recent proposal note', async () => {
    expect(await loadProposalContext(fakeDb([{}], []), 'c1', now)).toBeNull()
    const old = { ...note, created_at: '2026-09-01T00:00:00Z' }
    expect(await loadProposalContext(fakeDb([{}], [old]), 'c1', now)).toBeNull()
  })

  it('never throws', async () => {
    const broken = { from: () => { throw new Error('boom') } } as unknown as SupabaseClient
    expect(await loadProposalContext(broken, 'c1', now)).toBeNull()
  })
})

describe('buildProposalPrompt', () => {
  it('grounds on the summary, asks what they want to know on generic messages, hands off the rest', () => {
    const p = buildProposalPrompt('Plan: Wellness')
    expect(p).toContain('Plan: Wellness')
    expect(p).toContain('SOLO')
    expect(p).toContain('[[HANDOFF]]')
    expect(p).toContain('qué quiere saber de ella')
    expect(p).not.toMatch(/[—–]/)
  })
})
