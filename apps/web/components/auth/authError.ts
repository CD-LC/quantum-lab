/**
 * authError.ts — what the account page says when the sign-in redirect comes
 * back with an error.
 *
 * The redirect URL is attacker-writable: anyone can send a link such as
 * `/account?error_code=x&error_description=<any sentence>`. Echoing that
 * sentence into a red `role="alert"` on the genuine domain is a content-
 * spoofing vector (phishing text that looks like it came from us), so the
 * URL only ever SELECTS one of the fixed messages below. Nothing from it is
 * rendered.
 */

export const AUTH_ERROR_EXPIRED =
  'That sign-in link has expired or was already used. Request a new one below — links are single-use and valid for a short time.'

export const AUTH_ERROR_DENIED =
  'Sign-in was cancelled or not allowed. Request a new link below to try again.'

export const AUTH_ERROR_GENERIC = 'Sign-in failed. Request a new link below.'

/** `error_code` values that mean "the link is no longer usable". */
const EXPIRED_CODES = new Set(['otp_expired', 'flow_state_expired', 'flow_state_not_found'])
/** `error_code` / `error` values that mean the user or provider refused. */
const DENIED_CODES = new Set(['access_denied', 'user_banned', 'signup_disabled'])

/**
 * Pick a fixed message for a redirect error. `description` is consulted only
 * to recognise "expired" (it is matched, never shown).
 */
export function authErrorMessage(parts: {
  code?: string | null
  error?: string | null
  description?: string | null
}): string {
  const code = (parts.code ?? '').trim().toLowerCase()
  const error = (parts.error ?? '').trim().toLowerCase()
  if (EXPIRED_CODES.has(code) || /expired/i.test(parts.description ?? '')) return AUTH_ERROR_EXPIRED
  if (DENIED_CODES.has(code) || DENIED_CODES.has(error)) return AUTH_ERROR_DENIED
  return AUTH_ERROR_GENERIC
}
