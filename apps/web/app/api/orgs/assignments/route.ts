/**
 * /api/orgs/assignments — coursework for one cohort.
 *
 * WHO MAY DO WHAT, and it is decided here rather than in the browser:
 *   GET    any active seat in this org  (a learner must see what they owe)
 *   POST   owner or admin               (publishing work to a cohort)
 *   PATCH  owner or admin
 *   DELETE owner or admin
 *
 * Every one of those runs through `guard()` → `requireOrgRole()` in
 * lib/orgs/access.ts, which resolves the caller from a Supabase-verified bearer
 * token and reads their membership row for THE ORG NAMED IN THIS REQUEST. An
 * instructor of one cohort naming another cohort's id gets the same 403 as a
 * stranger, with the same sentence — the 403 is not a membership oracle.
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
  KNOWN_REFS,
} from '@/lib/orgs/apiHelpers'
import {
  MAX_INSTRUCTIONS,
  MAX_ITEMS,
  MAX_TITLE,
  isValidDueAt,
  normalizeItems,
  unknownRefs,
  type AssignmentItem,
} from '@/lib/orgs/assignments'
import {
  createAssignment,
  deleteAssignment,
  listAssignments,
  updateAssignment,
  type AssignmentPatch,
} from '@/lib/orgs/classroomStore'
import { readJsonBody, str, isRecord } from '@/lib/security/validate'
import { apiError } from '@/lib/apiError'
import { verifiedCallerId } from '@/lib/security/auth'
import { reportError } from '@/lib/observability/report'

export const runtime = 'nodejs'
/** Reads searchParams and a bearer token — never prerender it. */
export const dynamic = 'force-dynamic'

/** Body cap: MAX_ITEMS items plus 2 kB of instructions fits comfortably. */
const BODY_BYTES = 16_384

function itemsOrError(
  value: unknown
): { ok: true; items: AssignmentItem[] } | { ok: false; response: Response } {
  const items = normalizeItems(value)
  if (items.length === 0) {
    return {
      ok: false,
      response: bad(
        'An assignment needs at least one lesson, challenge or exam. ' +
          'Each item must be { kind: "lesson" | "challenge" | "exam", ref: "<id>" }.',
        400
      ),
    }
  }
  if (items.length > MAX_ITEMS) {
    return { ok: false, response: bad(`An assignment may hold at most ${MAX_ITEMS} items.`, 400) }
  }
  // Existence, not just shape: an assignment naming a lesson this deployment
  // does not have is one no learner can ever complete, and it would sit in the
  // denominator of every completion figure for the rest of the term.
  const missing = unknownRefs(items, KNOWN_REFS)
  if (missing.length > 0) {
    const named = missing.map((m) => `${m.kind}:${m.ref}`).join(', ')
    return { ok: false, response: bad(`No such ${missing.length === 1 ? 'item' : 'items'}: ${named}.`, 400) }
  }
  return { ok: true, items }
}

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

    const assignments = await listAssignments(orgId.value, access.access.context)
    return jsonOk({ assignments })
  } catch (err) {
    console.error('[api/orgs/assignments GET]', err)
    reportError(err, { route: 'api/orgs/assignments GET' })
    return bad('Could not load coursework. Try again in a moment.', 500)
  }
}

// ── POST { orgId, title, instructions?, items, dueAt } ────────

export async function POST(req: Request): Promise<Response> {
  const limited = rateLimit(req, 'orgs-assignments', 30)
  if (limited) return limited

  const parsed = await readJsonBody(req, BODY_BYTES)
  if (!parsed.ok && parsed.tooLarge) return apiError('payload_too_large')
  if (!parsed.ok) return bad(parsed.error, 400)
  if (!isRecord(parsed.value)) return bad('Expected a JSON object.', 400)
  const body = parsed.value

  const orgId = orgIdFrom(body.orgId)
  if (!orgId.ok) return orgId.response

  const title = str(body.title, MAX_TITLE, 'title')
  if (!title.ok) return bad(title.error, 400)

  if (!isValidDueAt(body.dueAt)) {
    return bad('dueAt must be an ISO-8601 date within ten years of today.', 400)
  }

  const items = itemsOrError(body.items)
  if (!items.ok) return items.response

  let instructions: string | undefined
  if (body.instructions !== undefined && body.instructions !== null && body.instructions !== '') {
    const checked = str(body.instructions, MAX_INSTRUCTIONS, 'instructions')
    if (!checked.ok) return bad(checked.error, 400)
    instructions = checked.value
  }

  const access = await guard(req, orgId.value, MANAGE_ROLES)
  if (!access.ok) return access.response

  try {
    const assignment = await createAssignment(
      {
        orgId: orgId.value,
        title: title.value,
        ...(instructions ? { instructions } : {}),
        items: items.items,
        dueAt: new Date(body.dueAt).toISOString(),
        // Overwritten by the store with the verified caller; passed so the
        // local-mode path has a value at all.
        createdBy: access.access.callerId,
      },
      access.access.context
    )
    return jsonOk({ assignment }, 201)
  } catch (err) {
    console.error('[api/orgs/assignments POST]', err)
    reportError(err, { route: 'api/orgs/assignments POST' })
    return bad('Could not publish that assignment. Try again in a moment.', 500)
  }
}

// ── PATCH { orgId, assignmentId, title?, instructions?, items?, dueAt? } ──

export async function PATCH(req: Request): Promise<Response> {
  const limited = rateLimit(req, 'orgs-assignments', 30)
  if (limited) return limited

  const parsed = await readJsonBody(req, BODY_BYTES)
  if (!parsed.ok && parsed.tooLarge) return apiError('payload_too_large')
  if (!parsed.ok) return bad(parsed.error, 400)
  if (!isRecord(parsed.value)) return bad('Expected a JSON object.', 400)
  const body = parsed.value

  const orgId = orgIdFrom(body.orgId)
  if (!orgId.ok) return orgId.response

  const assignmentId = str(body.assignmentId, 128, 'assignmentId')
  if (!assignmentId.ok) return bad(assignmentId.error, 400)

  const patch: AssignmentPatch = {}
  if (body.title !== undefined) {
    const title = str(body.title, MAX_TITLE, 'title')
    if (!title.ok) return bad(title.error, 400)
    patch.title = title.value
  }
  if (body.dueAt !== undefined) {
    if (!isValidDueAt(body.dueAt)) {
      return bad('dueAt must be an ISO-8601 date within ten years of today.', 400)
    }
    patch.dueAt = new Date(body.dueAt).toISOString()
  }
  if (body.items !== undefined) {
    const items = itemsOrError(body.items)
    if (!items.ok) return items.response
    patch.items = items.items
  }
  if (body.instructions !== undefined) {
    if (body.instructions === null || body.instructions === '') {
      patch.instructions = ''
    } else {
      const checked = str(body.instructions, MAX_INSTRUCTIONS, 'instructions')
      if (!checked.ok) return bad(checked.error, 400)
      patch.instructions = checked.value
    }
  }
  if (Object.keys(patch).length === 0) return bad('Provide a field to change.', 400)

  const access = await guard(req, orgId.value, MANAGE_ROLES)
  if (!access.ok) return access.response

  try {
    const assignment = await updateAssignment(
      orgId.value,
      assignmentId.value,
      patch,
      access.access.context
    )
    if (!assignment) return bad('That assignment is not part of this organisation.', 404)
    return jsonOk({ assignment })
  } catch (err) {
    console.error('[api/orgs/assignments PATCH]', err)
    reportError(err, { route: 'api/orgs/assignments PATCH' })
    return bad('Could not update that assignment. Try again in a moment.', 500)
  }
}

// ── DELETE ?orgId=&assignmentId= ──────────────────────────────

export async function DELETE(req: Request): Promise<Response> {
  const limited = rateLimit(req, 'orgs-assignments', 30)
  if (limited) return limited

  try {
    const params = new URL(req.url).searchParams
    const orgId = orgIdFrom(params.get('orgId'))
    if (!orgId.ok) return orgId.response
    const assignmentId = str(params.get('assignmentId'), 128, 'assignmentId')
    if (!assignmentId.ok) return bad(assignmentId.error, 400)

    const access = await guard(req, orgId.value, MANAGE_ROLES)
    if (!access.ok) return access.response

    const removed = await deleteAssignment(orgId.value, assignmentId.value, access.access.context)
    if (!removed) return bad('That assignment is not part of this organisation.', 404)
    return jsonOk({ removed })
  } catch (err) {
    console.error('[api/orgs/assignments DELETE]', err)
    reportError(err, { route: 'api/orgs/assignments DELETE' })
    return bad('Could not withdraw that assignment. Try again in a moment.', 500)
  }
}
