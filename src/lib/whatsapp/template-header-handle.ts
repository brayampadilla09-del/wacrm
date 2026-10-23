import { uploadResumableMedia } from '@/lib/whatsapp/meta-api'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'

/**
 * Meta requires an `example.header_handle` (from the Resumable Upload
 * API) to create/edit a template with an IMAGE header — a plain public
 * URL is not accepted at creation time. This helper turns the template's
 * `header_media_url` (whether the user uploaded a file or pasted a link)
 * into a handle and writes it onto the payload, so both the upload path
 * and the legacy URL path actually succeed.
 *
 * No-op unless the header is an image or a document (PDF) that has a URL
 * but no handle yet. Video handles can follow the same shape.
 */

// Meta's image-header sample limits.
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png']
// Meta's document-header sample: a PDF (kept well under its 100 MB cap).
const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024
const DOCUMENT_TYPE = 'application/pdf'

export async function ensureImageHeaderHandle(
  payload: TemplatePayload,
  accessToken: string,
): Promise<void> {
  if (payload.header_type !== 'image' && payload.header_type !== 'document') return
  const isDocument = payload.header_type === 'document'
  if (payload.header_handle) return // already have one
  if (!payload.header_media_url) return // validator already requires url-or-handle

  const appId = process.env.META_APP_ID
  if (!appId) {
    throw new Error(
      'Image and document header templates need META_APP_ID set (used for Meta’s Resumable Upload). Add it to your environment, or remove the media header.',
    )
  }

  // SSRF guard: `header_media_url` is caller-supplied (any authenticated
  // member can submit a template) and the fetch below happens server-side,
  // so refuse any destination that resolves to a private / loopback /
  // link-local / reserved address. Same guard, same message as the two
  // other outbound-fetch call sites (see lib/webhooks/ssrf.ts) — matching
  // the unreachable-host message keeps the failure from being an oracle.
  if (!(await isDeliverableUrl(payload.header_media_url))) {
    throw new Error('Could not fetch the header file URL. Make sure it is publicly reachable.')
  }

  // Fetch the sample image bytes (works for our uploaded chat-media URL
  // and for a manually-pasted public link).
  let res: Response
  try {
    res = await fetch(payload.header_media_url, {
      // Do NOT follow redirects — a public URL could 3xx-bounce to an
      // internal address, defeating the guard above. Bound the request so
      // a hung host can't tie up the template-submit handler.
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new Error('Could not fetch the header file URL. Make sure it is publicly reachable.')
  }
  if (!res.ok) {
    throw new Error(`Header file URL returned ${res.status}. It must be publicly reachable.`)
  }

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (isDocument) {
    if (contentType && contentType !== DOCUMENT_TYPE) {
      throw new Error(`Header document must be a PDF (got ${contentType}).`)
    }
  } else if (contentType && !ALLOWED_IMAGE_TYPES.includes(contentType)) {
    throw new Error(`Header image must be JPEG or PNG (got ${contentType}).`)
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength === 0) {
    throw new Error('Header file is empty.')
  }
  const maxBytes = isDocument ? DOCUMENT_MAX_BYTES : IMAGE_MAX_BYTES
  if (bytes.byteLength > maxBytes) {
    throw new Error(
      `Header file is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — the limit here is ${maxBytes / 1024 / 1024} MB.`,
    )
  }

  const mimeType = isDocument
    ? DOCUMENT_TYPE
    : ALLOWED_IMAGE_TYPES.includes(contentType)
      ? contentType
      : 'image/jpeg'
  const fileName = isDocument ? 'header.pdf' : mimeType === 'image/png' ? 'header.png' : 'header.jpg'

  const { handle } = await uploadResumableMedia({
    appId,
    accessToken,
    fileName,
    mimeType,
    bytes,
  })
  payload.header_handle = handle
}
