/**
 * Quick-reply buttons of TEMPLATE messages arrive from Meta as type "button"
 * (text + payload), not as "interactive" replies. pagina-estudio's templates
 * use them to start a 'manual' Flow, which is routed by a stable id:
 *
 *   reprog_yes / reprog_no  — reschedule-request template ("Sí, confirmo" / "No me sirve")
 *   propuesta_ver           — proposal-ready template ("Sí, quiero verla")
 *
 * The id is taken from the payload when it already is one, otherwise from the
 * visible text (accent, case and punctuation tolerant).
 */

/** Ids with this prefix may start a 'manual' Flow by button tap (see findEntryFlow). */
export const TAP_ENTRY_PREFIXES = ['reprog_', 'propuesta_'] as const;

export function isTapEntryId(id: string): boolean {
  return TAP_ENTRY_PREFIXES.some((p) => id.startsWith(p));
}

function norm(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function templateButtonReplyId(text: string | null | undefined, payload: string | null | undefined): string | undefined {
  const p = payload ?? '';
  if (isTapEntryId(p)) return p;
  switch (norm(text ?? '')) {
    case 'si confirmo':
      return 'reprog_yes';
    case 'no me sirve':
      return 'reprog_no';
    case 'si quiero verla':
      return 'propuesta_ver';
    default:
      return undefined;
  }
}
