import { describe, expect, it } from 'vitest';
import { isTapEntryId, templateButtonReplyId } from './template-button-reply';

describe('templateButtonReplyId', () => {
  it('keeps a payload that is already a routing id', () => {
    expect(templateButtonReplyId('lo que sea', 'reprog_yes')).toBe('reprog_yes');
    expect(templateButtonReplyId('x', 'propuesta_ver')).toBe('propuesta_ver');
    expect(templateButtonReplyId('x', 'propuesta_otra')).toBe('propuesta_otra');
  });

  it('maps the reschedule buttons by visible text, as before', () => {
    expect(templateButtonReplyId('Sí, confirmo', '')).toBe('reprog_yes');
    expect(templateButtonReplyId('si, confirmo', undefined)).toBe('reprog_yes');
    expect(templateButtonReplyId('No me sirve', 'Sí, confirmo')).toBe('reprog_no');
  });

  it('maps the proposal button, tolerant to accents, case and punctuation', () => {
    for (const t of ['Sí, quiero verla', 'si quiero verla', 'SÍ, QUIERO VERLA', ' Sí quiero verla! ']) {
      expect(templateButtonReplyId(t, '')).toBe('propuesta_ver');
    }
  });

  it('ignores anything else', () => {
    expect(templateButtonReplyId('Quiero verla', '')).toBeUndefined();
    expect(templateButtonReplyId('Sí, quiero verlas ya', '')).toBeUndefined();
    expect(templateButtonReplyId(null, null)).toBeUndefined();
    expect(templateButtonReplyId('hola', 'otro_id')).toBeUndefined();
  });
});

describe('isTapEntryId', () => {
  it('accepts reprog_ and propuesta_ ids only', () => {
    expect(isTapEntryId('reprog_yes')).toBe(true);
    expect(isTapEntryId('propuesta_ver')).toBe(true);
    expect(isTapEntryId('menu_citas')).toBe(false);
    expect(isTapEntryId('')).toBe(false);
  });
});
