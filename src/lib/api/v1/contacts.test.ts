import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  serializeContact,
  findOrCreateContact,
  planTagChanges,
  ContactError,
} from './contacts';

describe('planTagChanges', () => {
  const existing = new Set(['bimi', 'meta-ads', 'vip']);

  it('replace mode makes the contact end up with exactly the desired tags', () => {
    const plan = planTagChanges(existing, new Set(['web', 'vip']), 'replace');
    expect(plan.toAdd).toEqual(['web']);
    expect(plan.toRemove.sort()).toEqual(['bimi', 'meta-ads']);
  });

  it('add mode only adds: a website lead must not strip "Conversó con Bimi" or "Meta Ads"', () => {
    const plan = planTagChanges(existing, new Set(['web']), 'add');
    expect(plan.toAdd).toEqual(['web']);
    expect(plan.toRemove).toEqual([]);
  });

  it('add mode is a no-op when every desired tag is already on the contact', () => {
    const plan = planTagChanges(existing, new Set(['vip', 'bimi']), 'add');
    expect(plan).toEqual({ toAdd: [], toRemove: [] });
  });

  it('replace with an empty set clears the contact; add with an empty set changes nothing', () => {
    expect(planTagChanges(existing, new Set(), 'replace').toRemove.sort()).toEqual(['bimi', 'meta-ads', 'vip']);
    expect(planTagChanges(existing, new Set(), 'add')).toEqual({ toAdd: [], toRemove: [] });
  });
});

describe('serializeContact', () => {
  it('flattens contact_tags(tags(*)) onto a tags array and nulls missing fields', () => {
    const row = {
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      contact_tags: [
        { tags: { id: 't1', name: 'vip', color: '#fff' } },
        { tags: null }, // orphaned join — dropped
      ],
    };
    expect(serializeContact(row)).toEqual({
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      tags: [{ id: 't1', name: 'vip', color: '#fff' }],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    });
  });

  it('tolerates a row with no contact_tags key', () => {
    const row = {
      id: 'c2',
      phone: '+1',
      name: null,
      email: null,
      company: null,
      avatar_url: null,
      created_at: 'a',
      updated_at: 'b',
    };
    expect(serializeContact(row).tags).toEqual([]);
  });
});

describe('findOrCreateContact', () => {
  const noopDb = {} as SupabaseClient;

  it('rejects a non-E.164 phone with a 400 ContactError', async () => {
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toBeInstanceOf(ContactError);
  });
});
