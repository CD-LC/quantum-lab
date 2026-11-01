/**
 * /api/orgs/progress — the only path by which a learner's coursework leaves
 * their device, and the only path by which an instructor reads it.
 *
 *   POST  a learner shares THEIR OWN snapshot. Requires an active seat in the
 *         org AND a consent row. No consent, no write — 403, every time.
 *   GET   an owner or admin reads the cohort. Returns one row per seat, with
 *         `snapshot: null` for everyone who has not opted in.
 *
 * ── Three rules that must survive every future edit ──────────
 *  1. The subject of a POST is the VERIFIED CALLER. There is no `userId` field
 *     in the body and there must never be one: it would let any member write a
 *     colleague's progress row.
 *  2. Consent is checked server-side, here and again in the store. A client-side
 *     check is decoration — see the note at the top of docs/CLASSROOM.md.
 *  3. GET returns non-sharing members as `snapshot: null`, never as an empty
 *     snapshot. An instructor reading zeroes for someone who simply declined has
 *     been actively misinformed.
 */

import {
  MANAGE_ROLES,
  READ_ROLES,
  bad,
  guard,
  jsonOk,
  orgIdFrom,
  rateLimit,
  signInRequired,
} from '@/lib/orgs/apiHelpers'
import { mergeCompletions, type CohortMemberProgress } from '@/lib/orgs/assignments'
import { normalizeSnapshot } from '@/lib/orgs/progressShare'
import {
  getConsent,
  isConsentRequiredError,
  listAssignments,
  listProgress,
  upsertSnapshot,
} from '@/lib/orgs/classroomStore'
import { listMembers } from '@/lib/orgs/store'
import { readJsonBody, isRecord } from '@/lib/security/validate'
import { apiError } from '@/lib/apiError'
import { verifiedCallerId } from '@/lib/security/auth'
import { reportError } from '@/lib/observability/report'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** A snapshot is a few hundred short ids. 32 kB is already generous. */
const BODY_BYTES = 32_768

const NO_CONSENT =
  'You have not agreed to share your progress with this organisation. ' +
  'Turn sharing on first — nothing is stored until you do.'

// ── GET ?orgId= — the instructor's view ───────────────────────

export async function GET(req: Request): Promise<Response> {
  try {
    const orgId = orgIdFrom(new URL(req.url).searchParams.get('orgId'))
    if (!orgId.ok) {
      // Authenticate before validating: an anonymous caller gets 401, not a 400
      // that tells them which parameters the route wants.
      if (!(await verifiedCallerId(req))) return signInRequired()
      return orgId.response
    }

    // Reading a cohort's coursework is an instructor capability, so it needs an
    // owner/admin seat in THIS org — not merely any seat, and not merely a
    // valid token.
    const access = await guard(req, orgId.value, MANAGE_ROLES)
    if (!access.ok) return access.response
    const ctx = access.access.context

    const [members, shared] = await Promise.all([
      listMembers(orgId.value, ctx),
      listProgress(orgId.value, ctx),
    ])
    const byUser = new Map(shared.map((row) => [row.userId, row]))

    const rows: CohortMemberProgress[] = members.map((member) => {
      const row = member.userId ? byUser.get(member.userId) : undefined
      const out: CohortMemberProgress = {
        memberId: member.id,
        email: member.email,
        role: member.role,
        userId: member.userId,
        // null, not an empty snapshot — see rule 3 at the top of this file.
        snapshot: row ? row.snapshot : null,
      }
      if (row) {
        out.sharedAt = row.updatedAt
        out.completedAt = row.completions
      }
      return out
    })

    return jsonOk({ rows })
  } catch (err) {
    console.error('[api/orgs/progress GET]', err)
    reportError(err, { route: 'api/orgs/progress GET' })
    return bad('Could not load cohort progress. Try again in a moment.', 500)
  }
}

// ── POST { orgId, snapshot } — the learner shares ─────────────

export async function POST(req: Request): Promise<Response> {
  const limited = rateLimit(req, 'orgs-progress', 20)
  if (limited) return limited

  const parsed = await readJsonBody(req, BODY_BYTES)
  if (!parsed.ok && parsed.tooLarge) return apiError('payload_too_large')
  if (!parsed.ok) return bad(parsed.error, 400)
  if (!isRecord(parsed.value)) return bad('Expected a JSON object.', 400)
  const body = parsed.value

  const orgId = orgIdFrom(body.orgId)
  if (!orgId.ok) return orgId.response

  // Any active seat may share their own progress; a suspended one may not,
  // which requireOrgRole already enforces.
  const access = await guard(req, orgId.value, READ_ROLES)
  if (!access.ok) return access.response
  const { callerId, context: ctx } = access.access

  try {
    const consent = await getConsent(orgId.value, callerId, ctx)
    if (!consent) return bad(NO_CONSENT, 403)

    const snapshot = normalizeSnapshot(body.snapshot)

    // The email on the row is the one from the SEAT, never one supplied by the
    // caller: the row is what an instructor grades against, and a learner must
    // not be able to file their work under a colleague's address.
    const members = await listMembers(orgId.value, ctx)
    const seat = members.find((m) => m.userId === callerId)
    if (!seat) return bad('You do not hold a seat in this organisation.', 403)

    const [assignments, existing] = await Promise.all([
      listAssignments(orgId.value, ctx),
      listProgress(orgId.value, ctx),
    ])
    const previous = existing.find((row) => row.userId === callerId)

    const completions = mergeCompletions(
      assignments,
      snapshot,
      previous?.completions ?? {},
      new Date().toISOString()
    )

    const row = await upsertSnapshot(
      {
        orgId: orgId.value,
        userId: callerId,
        email: seat.email,
        snapshot,
        completions,
      },
      ctx
    )
    return jsonOk({ sharedAt: row.updatedAt, completedAt: row.completions })
  } catch (err) {
    if (isConsentRequiredError(err)) return bad(NO_CONSENT, 403)
    console.error('[api/orgs/progress POST]', err)
    reportError(err, { route: 'api/orgs/progress POST' })
    return bad('Could not share your progress. Try again in a moment.', 500)
  }
}
