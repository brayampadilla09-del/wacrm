// `next` on /auth/callback arrives from whoever crafted the link, not
// from a trusted source — including a reset email an attacker mailed
// themselves and then forwarded with the query string edited. Without
// this check, a successful auth exchange could bounce the user (now
// signed in) straight to an external site: a phishing page primed to
// look like the next step, or a credential-harvesting clone. That is
// worse than a plain open redirect because it happens right after a
// real authentication.
//
// Only a same-origin absolute path is allowed through:
//   - anything not starting with "/" is rejected (a bare hostname, a
//     scheme like "javascript:", a relative path)
//   - "//evil.example" is rejected too — browsers parse a leading
//     "//" as a protocol-relative host, not a path, so it would
//     escape the origin exactly like a full URL would
//   - "/\evil.example" is rejected for the same reason: some
//     browsers normalise a leading backslash to a forward slash
//     before resolving the URL, so this collapses to "//evil.example"
export function safeNext(raw: string | null, fallback = "/dashboard"): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  if (raw.startsWith("/\\")) return fallback;
  return raw;
}
