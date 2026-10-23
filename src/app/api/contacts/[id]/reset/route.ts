import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { ContactResetError, resetContact } from '@/lib/contacts/reset';

// POST /api/contacts/{id}/reset — leaves a contact as new (see lib/contacts/reset.ts). Admins and owners only, and the
// body must carry the contact's phone number as `confirm_phone`.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id: contactId } = await params;
    const body = (await request.json().catch(() => null)) as {
      confirm_phone?: unknown;
    } | null;
    const confirmPhone =
      typeof body?.confirm_phone === 'string' ? body.confirm_phone : '';

    const result = await resetContact(ctx.supabase, supabaseAdmin(), {
      accountId: ctx.accountId,
      contactId,
      confirmPhone,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ContactResetError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return toErrorResponse(error);
  }
}
