import { describe, it, expect } from 'vitest'
import { parseContextNote } from './context-note'

describe('parseContextNote', () => {
  it('is null when absent', () => {
    expect(parseContextNote(undefined)).toBeNull()
    expect(parseContextNote(null)).toBeNull()
  })

  it('accepts a proposal note and trims it', () => {
    expect(parseContextNote({ kind: 'proposal', text: '  Plan: Sketch ' })).toEqual({ kind: 'proposal', text: 'Plan: Sketch' })
  })

  it('rejects malformed notes with a 400', () => {
    for (const bad of ['x', [], { kind: 'other', text: 'a' }, { kind: 'proposal' }, { kind: 'proposal', text: '   ' }, { kind: 'proposal', text: 'x'.repeat(3001) }]) {
      expect(() => parseContextNote(bad)).toThrowError(expect.objectContaining({ status: 400 }))
    }
  })
})
