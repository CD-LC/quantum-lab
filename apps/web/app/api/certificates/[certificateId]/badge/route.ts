/**
 * GET /api/certificates/[certificateId]/badge — the machine-readable badge.
 *
 * PUBLIC AND UNAUTHENTICATED, like /api/exams/verify: a credential exists to
 * be checked by strangers. The document is an Open Badges 3.0-style JSON-LD
 * `OpenBadgeCredential`, built from the SAME verified lookup the /verify page
 * uses — so it can only ever say what /verify says: name, exam, date, number.
 * Score and attempt history are not in the input type and cannot appear here.
 *
 * Unlike /api/exams/verify (which answers "is this valid?" with a 200 either
 * way), this route serves a RESOURCE: a badge for a certificate that was never
 * issued does not exist, so an unknown or malformed id is a 404. That reveals
 * nothing /verify does not already say for free, and it keeps badge consumers
 * — which dereference the assertion's `id` URL and expect a document or an
 * error — from caching a JSON body that says "invalid" as if it were a badge.
 */

import { lookupCertificate } from '@/lib/exams/service'
import { badgeAssertion } from '@/lib/certificate'
import { absoluteUrl } from '@/lib/seo'
import { apiError } from '@/lib/apiError'
import { callerKey, rateLimit, retryAfterHeaders, type RateLimitRule } from '@/lib/rateLimit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Same shape as the verify route's limit: a page-level public lookup. */
const BADGE_LIMIT: RateLimitRule = { limit: 30, windowMs: 60_000 }

export async function GET(
  req: Request,
  props: { params: Promise<{ certificateId: string }> }
): Promise<Response> {
  const params = await props.params

  const decision = await rateLimit(callerKey(req.headers, 'cert-badge'), BADGE_LIMIT)
  if (!decision.allowed) {
    return apiError('rate_limited', { headers: retryAfterHeaders(decision) })
  }

  // Next has already percent-decoded the segment; decoding it again threw a
  // URIError (a 500) on input such as `%E0`. parseCertificateId rejects
  // anything malformed, so the value goes straight through.
  const result = await lookupCertificate(params.certificateId)
  if (!result.valid || !result.name || !result.issuedAt) {
    return apiError('not_found', {
      message: 'No badge exists for that certificate number.',
    })
  }

  const assertion = badgeAssertion(
    {
      id: result.id,
      name: result.name,
      // A retired exam still names a real pass; fall back to its catalogue id.
      examTitle: result.examTitle ?? result.examId ?? 'Qubit16 Certification',
      issuedAt: result.issuedAt,
      ...(result.examId ? { examId: result.examId } : {}),
    },
    absoluteUrl('/')
  )

  return new Response(JSON.stringify(assertion, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/ld+json',
      // Public and cacheable for a short while: issuance is append-only and
      // the only change that matters (a retired exam) is cosmetic.
      'cache-control': 'public, max-age=300',
    },
  })
}
