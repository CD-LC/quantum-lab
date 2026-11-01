/**
 * /api/orgs/progress/consent — the learner's own decision, and only their own.
 *
 *   GET    is sharing on for me, in this org?
 *   POST   turn it on
 *   DELETE turn it off, and delete the snapshot that was shared
 *
 * The subject of every method is the VERIFIED CALLER. There is no `userId`
 * parameter anywhere in this file, and adding one would make it possible for an
 * admin to consent on a learner's behalf — which would make the entire opt-in
 * theatre. An instructor cannot grant this; a learner grants it or nobody does.
 *
 * A seat in the org is required (READ_ROLES): consenting to share with an
 * organisation you have nothing to do with is not a thing that should be
 * storable, and a suspended seat cannot consent because requireOrgRole refuses
 * one outright.
 */

import { READ_ROLES, bad, guard, jsonOk, orgIdFrom, rateLimit } from '@/lib/orgs/apiHelpers'
import { getConsent, grantConsent, revokeConsent } from '@/lib/orgs/classroomStore'
import { readJsonBody, isRecord } from '@/lib/security/validate'
import { apiError } from '@/lib/apiError'
import { reportError } from '@/lib/observability/report'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<Response> {
  try {
    const orgId = orgIdFrom(new URL(req.url).searchParams.get('orgId'))
    if (!orgId.ok) return orgId.response

    const access = await guard(req, orgId.value, READ_ROLES)
    if (!access.ok) return access.response

    const consent = await getConsent(orgId.value, access.access.callerId, access.access.context)
    return jsonOk({
      granted: consent !== null,
      grantedAt: consent?.grantedAt ?? null,
    })
  } catch (err) {
    console.error('[api/orgs/progress/consent GET]', err)
    reportError(err, { route: 'api/orgs/progress/consent GET' })
    // Fail closed: if we cannot prove consent, report that there is none. The
    // UI then shows the opt-in card rather than "you are sharing".
    return jsonOk({ granted: false, grantedAt: null })
  }
}

export async function POST(req: Request): Promise<Response> {
  const limited = rateLimit(req, 'orgs-consent', 20)
  if (limited) return limited

  const parsed = await readJsonBody(req, 2_048)
  if (!parsed.ok && parsed.tooLarge) return apiError('payload_too_large')
  if (!parsed.ok) return bad(parsed.error, 400)
  if (!isRecord(parsed.value)) return bad('Expected a JSON object.', 400)

  const orgId = orgIdFrom(parsed.value.orgId)
  if (!orgId.ok) return orgId.response

  const access = await guard(req, orgId.value, READ_ROLES)
  if (!access.ok) return access.response

  try {
    const consent = await grantConsent(
      orgId.value,
      access.access.callerId,
      access.access.context
    )
    return jsonOk({ granted: true, grantedAt: consent.grantedAt }, 201)
  } catch (err) {
    console.error('[api/orgs/progress/consent POST]', err)
    reportError(err, { route: 'api/orgs/progress/consent POST' })
    return bad('Could not turn sharing on. Try again in a moment.', 500)
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const limited = rateLimit(req, 'orgs-consent', 20)
  if (limited) return limited

  try {
    const orgId = orgIdFrom(new URL(req.url).searchParams.get('orgId'))
    if (!orgId.ok) return orgId.response

    const access = await guard(req, orgId.value, READ_ROLES)
    if (!access.ok) return access.response

    // Deletes the snapshot first, then the consent row — see revokeConsent().
    await revokeConsent(orgId.value, access.access.callerId, access.access.context)
    return jsonOk({ granted: false })
  } catch (err) {
    console.error('[api/orgs/progress/consent DELETE]', err)
    reportError(err, { route: 'api/orgs/progress/consent DELETE' })
    // Deliberately a 500 and not a cheerful 200: a learner who asked to stop
    // sharing must not be told it worked when the row may still be there.
    return bad(
      'Could not stop sharing. Your shared progress may still be visible — try again.',
      500
    )
  }
}
