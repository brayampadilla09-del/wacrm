// ============================================================
// /auth/callback — the landing strip for every emailed auth link.
//
// This route did not exist. `resetPasswordForEmail` in
// forgot-password/page.tsx has always pointed its `redirectTo`
// here, so every password-reset email ever sent by this app led
// to a 404: the mail arrived, the link resolved, and the user
// landed on nothing. Same for the signup confirmation links,
// which Supabase routes through the project's Site URL.
//
// Supabase can hand the session back in two different shapes and
// which one you get depends on the project's auth flow setting,
// so both are handled here:
//
//   1. `?code=…`        — PKCE (the default for @supabase/ssr).
//      The verifier was stored as a cookie when the reset was
//      requested, so the exchange must happen server-side where
//      that cookie is readable. That is the whole reason this is
//      a route handler and not a page.
//
//   2. `?token_hash=…&type=recovery` — the OTP shape, used when
//      the project runs the implicit flow or when the email
//      template was customised to emit a token hash. No verifier
//      involved, so it survives being opened in a different
//      browser than the one that asked for the reset (phone vs
//      laptop, which is what people actually do).
//
// A third shape exists — the implicit flow's `#access_token=…`
// fragment — but fragments are never sent to the server, so that
// one can only be picked up client-side. /reset-password handles
// it there.
//
// On success the session cookies are set and the user is sent to
// `next`. On failure they go back to /forgot-password carrying a
// readable reason, rather than being dropped on a blank screen.
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { safeNext } from '@/lib/auth/safe-redirect'

function failure(origin: string, reason: string) {
  const url = new URL('/forgot-password', origin)
  url.searchParams.set('error', reason)
  return NextResponse.redirect(url)
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)

  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type')
  const next = safeNext(searchParams.get('next'))

  // Supabase reports a refused link (expired, already consumed) by
  // redirecting here with its own error params rather than a code.
  // Surface that verbatim instead of letting it fall through to the
  // generic "invalid link" below, because "Email link is invalid or
  // has expired" is the one message that tells the user to just
  // request a new one.
  const providerError =
    searchParams.get('error_description') ?? searchParams.get('error')
  if (providerError) {
    return failure(origin, providerError)
  }

  const supabase = await createClient()

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) {
      return failure(origin, error.message)
    }
    return NextResponse.redirect(new URL(next, origin))
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type: type as 'recovery' | 'email' | 'invite' | 'magiclink' | 'signup',
      token_hash: tokenHash,
    })
    if (error) {
      return failure(origin, error.message)
    }
    return NextResponse.redirect(new URL(next, origin))
  }

  return failure(
    origin,
    'This link is missing its verification code. Request a new reset email.',
  )
}
