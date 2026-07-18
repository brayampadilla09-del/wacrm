/**
 * Substitute a template's `{{1}}`, `{{2}}`, … body placeholders with
 * send-time values, for display purposes (inbox thread, conversation
 * preview) — not for the Meta API payload itself (see
 * `template-send-builder.ts` for that).
 *
 * Previously duplicated in `components/inbox/message-thread.tsx` and
 * `lib/automations/meta-send.ts`; consolidated here so `send-message.ts`
 * (the public-API send path) can use the same logic instead of a third
 * copy.
 */
export function renderTemplateBody(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const idx = Number(raw) - 1;
    return params[idx] ?? `{{${raw}}}`;
  });
}
