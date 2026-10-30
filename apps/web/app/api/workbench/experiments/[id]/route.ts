/**
 * GET /api/workbench/experiments/[id] — one experiment record, in full, for
 * the /workbench/experiments/[id] page. Same store and same shape as the MCP
 * tool `get_experiment`; see ../route.ts for the posture.
 */

import { NextResponse } from 'next/server'
import { apiError } from '@/lib/apiError'
import { callerKey, rateLimit, retryAfterHeaders, type RateLimitRule } from '@/lib/rateLimit'
import { uuid } from '@/lib/security/validate'
import { toPublic } from '@/lib/workbench/experiments'
import { reportError } from '@/lib/observability/report'
import { getExperimentStore } from '@/lib/workbench/experimentStore'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const GET_LIMIT: RateLimitRule = { limit: 120, windowMs: 60_000 }

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const limited = await rateLimit(callerKey(req.headers, 'wb-exp-one'), GET_LIMIT)
  if (!limited.allowed) return apiError('rate_limited', { headers: retryAfterHeaders(limited) })

  const { id } = await context.params
  const checked = uuid(id, 'id')
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 })

  const store = getExperimentStore()
  try {
    const experiment = await store.get(checked.value)
    if (!experiment) return NextResponse.json({ error: 'No experiment with that id.' }, { status: 404 })
    return NextResponse.json({ storage: store.kind, experiment: toPublic(experiment) })
  } catch (cause) {
    reportError(cause, { route: 'api/workbench/experiments/[id]', stage: 'get' })
    return apiError('upstream_unavailable', { message: 'The experiment store is unavailable right now.', status: 503 })
  }
}
