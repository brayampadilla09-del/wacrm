/**
 * Meta Lead Ads (leadgen) helpers.
 *
 * A leadgen webhook event carries only the id of the submitted lead —
 * the actual answers (name, email, phone, ...) have to be fetched
 * separately from the Graph API with a Page access token that has the
 * `leads_retrieval` permission. See docs/meta-lead-ads.md for how to
 * get that token.
 */

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

export interface LeadgenField {
  name: string
  values: string[]
}

export interface LeadgenLead {
  id: string
  created_time: string
  field_data: LeadgenField[]
  ad_id?: string
  ad_name?: string
  form_id?: string
  page_id?: string
}

/** Fetches the full answers for one lead by its leadgen_id. */
export async function fetchLeadgenLead(
  leadgenId: string,
  pageAccessToken: string,
): Promise<LeadgenLead> {
  const url = `${META_API_BASE}/${leadgenId}?access_token=${encodeURIComponent(pageAccessToken)}`
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Graph API leadgen fetch failed (${res.status}): ${body}`)
  }
  return res.json()
}

/**
 * Meta lead forms let advertisers name fields however they want
 * ("phone_number", "PHONE", "telefono_de_contacto", ...) — match by
 * substring against the common variants instead of an exact key list.
 */
const FIELD_MATCHERS: Record<'phone' | 'email' | 'name', RegExp> = {
  phone: /phone|telefono|teléfono|celular|whatsapp/i,
  email: /email|correo/i,
  name: /full_name|nombre|^name$/i,
}

export interface ParsedLead {
  phone: string | null
  email: string | null
  name: string | null
}

/** Pulls phone/email/name out of a lead's raw `field_data` answers. */
export function parseLeadFields(fieldData: LeadgenField[]): ParsedLead {
  const result: ParsedLead = { phone: null, email: null, name: null }
  for (const field of fieldData) {
    const value = field.values?.[0]?.trim()
    if (!value) continue
    if (!result.phone && FIELD_MATCHERS.phone.test(field.name)) result.phone = value
    else if (!result.email && FIELD_MATCHERS.email.test(field.name)) result.email = value
    else if (!result.name && FIELD_MATCHERS.name.test(field.name)) result.name = value
  }
  return result
}
