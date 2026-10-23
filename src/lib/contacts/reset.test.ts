import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { ContactResetError, RESET_TABLES, resetContact } from './reset';

function userDb(contact: { id: string; phone: string } | null): SupabaseClient {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => Promise.resolve({ data: contact, error: null }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

function adminDb(calls: string[], failOn?: string): SupabaseClient {
  return {
    from(table: string) {
      const builder = {
        delete: () => builder,
        eq: (_col: string, _id: string) => {
          calls.push(table);
          return Promise.resolve({ count: table === 'conversations' ? 2 : 1, error: table === failOn ? { message: 'boom' } : null });
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const input = { accountId: 'a1', contactId: 'c1', confirmPhone: '+57 300 100 0005' };

describe('resetContact', () => {
  it('clears every table once the phone matches, and reports the counts', async () => {
    const calls: string[] = [];
    const result = await resetContact(userDb({ id: 'c1', phone: '+573001000005' }), adminDb(calls), input);
    expect(calls).toEqual([...RESET_TABLES]);
    expect(result.deleted.conversations).toBe(2);
    expect(result.deleted.flow_runs).toBe(1);
  });

  it('refuses a wrong or empty phone and deletes nothing', async () => {
    const calls: string[] = [];
    for (const confirmPhone of ['', '+573009999999']) {
      await expect(resetContact(userDb({ id: 'c1', phone: '+573001000005' }), adminDb(calls), { ...input, confirmPhone })).rejects.toMatchObject({ status: 409 });
    }
    expect(calls).toEqual([]);
  });

  it('404s for a contact outside the account and surfaces a failing table', async () => {
    await expect(resetContact(userDb(null), adminDb([]), input)).rejects.toMatchObject({ status: 404 });
    await expect(resetContact(userDb({ id: 'c1', phone: '+573001000005' }), adminDb([], 'flow_runs'), input)).rejects.toBeInstanceOf(ContactResetError);
  });
});
