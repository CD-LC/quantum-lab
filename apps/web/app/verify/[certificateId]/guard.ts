/**
 * guard.ts — the two checks /verify/[certificateId] runs before it touches the
 * certificate store: decode the URL segment safely, and rate limit the lookup.
 *
 * Kept out of page.tsx so they can be unit tested (a Next page module may only
 * export what the framework knows about) and so the page stays a template.
 */

import { callerKey, rateLimit, type RateLimitRule } from '@/lib/rateLimit'

/**
 * The same ceiling and the same bucket prefix as `verifyCertificate` in
 * lib/exams/service.ts (`exam-verify`, 30 a minute), so the HTML page cannot be
 * used to read what the API route refuses to serve. Keep the numbers in step.
 */
export const VERIFY_PAGE_LIMIT: RateLimitRule = { limit: 30, windowMs: 60_000 }

/**
 * Turn the route segment into the string to look up, or null when it is not a
 * valid percent-encoding at all.
 *
 * Next has normally decoded the segment already, so a second blind
 * `decodeURIComponent` throws a URIError on a literal `%` (HTTP 500, and the
 * response carries none of the security headers). A legitimate certificate
 * number is `QL-XXXXX-XXXXX-X` and never contains `%`, so: no `%` means use the
 * segment as it is; a `%` means decode it, and an undecodable one is null,
 * which the caller turns into a 404.
 */
export function decodeCertificateSegment(segment: string): string | null {
  if (!segment.includes('%')) return segment
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/** True when this caller may do another lookup now. Counts the call. */
export async function allowVerifyLookup(headers: Headers): Promise<boolean> {
  try {
    const decision = await rateLimit(callerKey(headers, 'exam-verify'), VERIFY_PAGE_LIMIT)
    return decision.allowed
  } catch {
    // The limiter has its own in-memory fallback and should not throw; if it
    // somehow does, a legitimate verifier must still get an answer.
    return true
  }
}
