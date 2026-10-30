/**
 * POST /api/orgs/classes/assignments — publish an assignment TO ONE CLASS.
 *
 * Why this is a separate route rather than a `classId` field on
 * POST /api/orgs/assignments: that route belongs to the original classroom
 * workstream and its contract — "no classId, targets everyone" — is exactly the
 * behaviour existing callers depend on. This route is the class-shaped door,
 * owned by the classes workstream, and the only extra thing it does before
 * calling the same `createAssignment` is prove the named class belongs to the
 * named org. Folding it into /api/orgs/assignments later removes the
 * duplicated field validation below; until then the two must not drift — both
 * validate with the same functions from lib/orgs/assignments.
 *
 * Role: owner or admin, via the same `guard()` as every other publish. A class
 * id is a claim, never a credential — naming a class of another org gets a 404
 * AFTER the org role check, so the response can never become a membership
 * oracle for orgs the caller is not in.
 */

import {
  MANAGE_ROLES,
  bad,
  guard,
  jsonOk,
  orgIdFrom,
  rateLimit,
  KNOWN_REFS,
} from '@/lib/orgs/apiHelpers'
import {
  MAX_INSTRUCTIONS,
  MAX_ITEMS,
  MAX_TITLE,
  isValidDueAt,
  normalizeItems,
  unknownRefs,
} from '@/lib/orgs/assignments'
import { createAssignment, listClasses } from '@/lib/orgs/classroomStore'
import { readJsonBody, str, isRecord } from '@/lib/security/validate'
import { apiError } from '@/lib/apiError'
import { reportError } from '@/lib/observability/report'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Body cap: MAX_ITEMS items plus 2 kB of instructions fits comfortably. */
const BODY_BYTES = 16_384

// ── POST { orgId, classId, title, instructions?, items, dueAt } ──

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

  const classId = str(body.classId, 128, 'classId')
  if (!classId.ok) return bad(classId.error, 400)

  const title = str(body.title, MAX_TITLE, 'title')
  if (!title.ok) return bad(title.error, 400)

  if (!isValidDueAt(body.dueAt)) {
    return bad('dueAt must be an ISO-8601 date within ten years of today.', 400)
  }

  const items = normalizeItems(body.items)
  if (items.length === 0) {
    return bad(
      'An assignment needs at least one lesson, challenge or exam. ' +
        'Each item must be { kind: "lesson" | "challenge" | "exam", ref: "<id>" }.',
      400
    )
  }
  if (items.length > MAX_ITEMS) {
    return bad(`An assignment may hold at most ${MAX_ITEMS} items.`, 400)
  }
  const missing = unknownRefs(items, KNOWN_REFS)
  if (missing.length > 0) {
    const named = missing.map((m) => `${m.kind}:${m.ref}`).join(', ')
    return bad(`No such ${missing.length === 1 ? 'item' : 'items'}: ${named}.`, 400)
  }

  let instructions: string | undefined
  if (body.instructions !== undefined && body.instructions !== null && body.instructions !== '') {
    const checked = str(body.instructions, MAX_INSTRUCTIONS, 'instructions')
    if (!checked.ok) return bad(checked.error, 400)
    instructions = checked.value
  }

  const access = await guard(req, orgId.value, MANAGE_ROLES)
  if (!access.ok) return access.response

  try {
    // The class must be THIS org's. Checked through the org-scoped list rather
    // than a bare id lookup, so a class id from another licence reads as
    // missing here — never as anything more informative.
    const classes = await listClasses(orgId.value, access.access.context)
    if (!classes.some((c) => c.id === classId.value)) {
      return bad('That class is not part of this organisation.', 404)
    }

    const assignment = await createAssignment(
      {
        orgId: orgId.value,
        classId: classId.value,
        title: title.value,
        ...(instructions ? { instructions } : {}),
        items,
        dueAt: new Date(body.dueAt as string).toISOString(),
        createdBy: access.access.callerId,
      },
      access.access.context
    )
    return jsonOk({ assignment }, 201)
  } catch (err) {
    console.error('[api/orgs/classes/assignments POST]', err)
    reportError(err, { route: 'api/orgs/classes/assignments POST' })
    return bad('Could not publish that assignment. Try again in a moment.', 500)
  }
}
