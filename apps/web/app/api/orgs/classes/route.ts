/**
 * /api/orgs/classes — named classes within one licence, and their rosters.
 *
 * WHO MAY DO WHAT, decided here rather than in the browser, exactly as the
 * assignments route does it:
 *   GET    any active seat in this org  (a learner may see which class their
 *                                        work belongs to — the class list is no
 *                                        more secret than the seat roster every
 *                                        member can already read)
 *   POST   owner or admin               (create a class)
 *   PATCH  owner or admin               (replace a class's roster)
 *   DELETE owner or admin               (remove a class; its assignments fall
 *                                        back to targeting the whole licence)
 *
 * "Instructor" in the UI means an owner or admin seat — there is no fourth
 * role. Every verb runs through `guard()` → `requireOrgRole()` against THE ORG
 * NAMED IN THIS REQUEST, and a classId is verified to belong to that org before
 * anything is written: an id is a claim, never a credential.
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
import { MAX_CLASS_NAME } from '@/lib/orgs/assignments'
import {
  createClass,
  deleteClass,
  listClasses,
  listClassMemberships,
  setClassMembers,
} from '@/lib/orgs/classroomStore'
import { listMembers } from '@/lib/orgs/store'
import { readJsonBody, str, isRecord } from '@/lib/security/validate'
import { apiError } from '@/lib/apiError'
import { verifiedCallerId } from '@/lib/security/auth'
import { reportError } from '@/lib/observability/report'

export const runtime = 'nodejs'
/** Reads searchParams and a bearer token — never prerender it. */
export const dynamic = 'force-dynamic'

const BODY_BYTES = 16_384
/** A licence's worth of classes. A cap, not a product decision. */
const MAX_CLASSES = 50

// ── GET ?orgId= ───────────────────────────────────────────────

export async function GET(req: Request): Promise<Response> {
  try {
    const orgId = orgIdFrom(new URL(req.url).searchParams.get('orgId'))
    if (!orgId.ok) {
      // Authenticate before validating: an anonymous caller gets 401, not a 400
      // that tells them which parameters the route wants.
      if (!(await verifiedCallerId(req))) return signInRequired()
      return orgId.response
    }

    const access = await guard(req, orgId.value, READ_ROLES)
    if (!access.ok) return access.response

    const [classes, memberships] = await Promise.all([
      listClasses(orgId.value, access.access.context),
      listClassMemberships(orgId.value, access.access.context),
    ])
    return jsonOk({ classes, memberships })
  } catch (err) {
    console.error('[api/orgs/classes GET]', err)
    reportError(err, { route: 'api/orgs/classes GET' })
    return bad('Could not load the classes. Try again in a moment.', 500)
  }
}

// ── POST { orgId, name } ──────────────────────────────────────

export async function POST(req: Request): Promise<Response> {
  const limited = rateLimit(req, 'orgs-classes', 30)
  if (limited) return limited

  const parsed = await readJsonBody(req, BODY_BYTES)
  if (!parsed.ok && parsed.tooLarge) return apiError('payload_too_large')
  if (!parsed.ok) return bad(parsed.error, 400)
  if (!isRecord(parsed.value)) return bad('Expected a JSON object.', 400)
  const body = parsed.value

  const orgId = orgIdFrom(body.orgId)
  if (!orgId.ok) return orgId.response

  const name = str(body.name, MAX_CLASS_NAME, 'name')
  if (!name.ok) return bad(name.error, 400)

  const access = await guard(req, orgId.value, MANAGE_ROLES)
  if (!access.ok) return access.response

  try {
    const existing = await listClasses(orgId.value, access.access.context)
    if (existing.length >= MAX_CLASSES) {
      return bad(`A licence may hold at most ${MAX_CLASSES} classes.`, 400)
    }
    if (existing.some((c) => c.name.toLowerCase() === name.value.toLowerCase())) {
      return bad('A class with that name already exists on this licence.', 409)
    }
    const created = await createClass(
      {
        orgId: orgId.value,
        name: name.value,
        // Overwritten by the store with the verified caller; passed so the
        // local-mode path has a value at all.
        createdBy: access.access.callerId,
      },
      access.access.context
    )
    return jsonOk({ class: created }, 201)
  } catch (err) {
    console.error('[api/orgs/classes POST]', err)
    reportError(err, { route: 'api/orgs/classes POST' })
    return bad('Could not create that class. Try again in a moment.', 500)
  }
}

// ── PATCH { orgId, classId, memberIds } ───────────────────────

export async function PATCH(req: Request): Promise<Response> {
  const limited = rateLimit(req, 'orgs-classes', 30)
  if (limited) return limited

  const parsed = await readJsonBody(req, BODY_BYTES)
  if (!parsed.ok && parsed.tooLarge) return apiError('payload_too_large')
  if (!parsed.ok) return bad(parsed.error, 400)
  if (!isRecord(parsed.value)) return bad('Expected a JSON object.', 400)
  const body = parsed.value

  const orgId = orgIdFrom(body.orgId)
  if (!orgId.ok) return orgId.response

  const classId = str(body.classId, 128, 'classId')
  if (!classId.ok) return bad(classId.error, 400)

  if (!Array.isArray(body.memberIds) || body.memberIds.some((m) => typeof m !== 'string')) {
    return bad('memberIds must be an array of seat ids (the full roster of the class).', 400)
  }
  const memberIds = [...new Set(body.memberIds as string[])]

  const access = await guard(req, orgId.value, MANAGE_ROLES)
  if (!access.ok) return access.response

  try {
    const classes = await listClasses(orgId.value, access.access.context)
    if (!classes.some((c) => c.id === classId.value)) {
      return bad('That class is not part of this organisation.', 404)
    }

    // Every id must name a seat ON THIS LICENCE. A seat id from another org in
    // the list would otherwise let a manager write rows that reference someone
    // else's roster — refused as a whole, naming nothing about other orgs.
    const seats = new Set((await listMembers(orgId.value, access.access.context)).map((m) => m.id))
    if (memberIds.some((id) => !seats.has(id))) {
      return bad('Every memberId must be a seat on this licence.', 400)
    }

    await setClassMembers(orgId.value, classId.value, memberIds, access.access.context)
    return jsonOk({ classId: classId.value, memberIds })
  } catch (err) {
    console.error('[api/orgs/classes PATCH]', err)
    reportError(err, { route: 'api/orgs/classes PATCH' })
    return bad('Could not update that class. Try again in a moment.', 500)
  }
}

// ── DELETE ?orgId=&classId= ───────────────────────────────────

export async function DELETE(req: Request): Promise<Response> {
  const limited = rateLimit(req, 'orgs-classes', 30)
  if (limited) return limited

  try {
    const params = new URL(req.url).searchParams
    const orgId = orgIdFrom(params.get('orgId'))
    if (!orgId.ok) return orgId.response
    const classId = str(params.get('classId'), 128, 'classId')
    if (!classId.ok) return bad(classId.error, 400)

    const access = await guard(req, orgId.value, MANAGE_ROLES)
    if (!access.ok) return access.response

    const removed = await deleteClass(orgId.value, classId.value, access.access.context)
    if (!removed) return bad('That class is not part of this organisation.', 404)
    return jsonOk({ removed })
  } catch (err) {
    console.error('[api/orgs/classes DELETE]', err)
    reportError(err, { route: 'api/orgs/classes DELETE' })
    return bad('Could not remove that class. Try again in a moment.', 500)
  }
}
