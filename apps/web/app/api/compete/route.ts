/**
 * /api/compete — the weekly gate-golf competition.
 *
 * GET  → this week's puzzle (derived from the ISO week, no operator), the
 *        server-stamped deadline, the top-20 leaderboard, and — for a
 *        signed-in caller — their own standing including their own QASM.
 * POST → submit an entry. Supabase-verified callers only, rate limited.
 *
 * TRUST BOUNDARY, spelled out because a leaderboard is a magnet for it:
 *   - identity comes from `verifiedCaller` (lib/security/auth.ts) — a token
 *     Supabase validates, never a userId in the body;
 *   - the SCORE comes from the server: the submitted QASM is re-parsed and
 *     re-graded by `validateEntry` (lib/compete/engine.ts), and a client-
 *     claimed gate count that disagrees with the recount rejects the entry;
 *   - the response never carries another player's QASM. A leader's circuit is
 *     the answer to a puzzle that is still running; each player gets only
 *     their own back.
 *
 * `dynamic = 'force-dynamic'`: the deadline countdown is anchored to
 * `serverNow`, and the caller-specific `you` block depends on a bearer token.
 * A cached copy would hand one player's standing (and circuit) to another.
 */

import { NextResponse } from 'next/server'
import { apiError, badRequest, failure } from '@/lib/apiError'
import {
  currentCompetition,
  validateEntry,
  type WeeklyCompetition,
} from '@/lib/compete/engine'
import {
  CompeteStoreUnavailableError,
  getCompeteStore,
  type CompetitionEntry,
} from '@/lib/compete/store'
import { callerKey, rateLimit, retryAfterHeaders } from '@/lib/rateLimit'
import { verifiedCaller } from '@/lib/security/auth'
import { readBodyText } from '@/lib/security/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const LEADERBOARD_SIZE = 20
/** Generous for a 256-op circuit; small enough to refuse before parsing. */
const MAX_BODY_BYTES = 32_768
const MAX_NAME_CHARS = 40
/** Submissions per caller per minute. Grading is cheap; noise is not. */
const POST_RULE = { limit: 12, windowMs: 60_000 }
/**
 * Reads per caller per minute. Each uncached GET costs a Supabase query (three,
 * plus an auth lookup when a bearer is attached), and it is anonymous, so
 * without this a loop drives database load for free. A page load makes one.
 */
const GET_RULE = { limit: 60, windowMs: 60_000 }

/**
 * The client-safe slice of a competition. An explicit field list, not a
 * spread: the engine's types keep hints and reference solutions server-side,
 * and this function is the second fence in case that ever changes.
 */
function publicCompetition(comp: WeeklyCompetition) {
  return {
    id: comp.id,
    weekKey: comp.weekKey,
    startsAt: comp.startsAt,
    endsAt: comp.endsAt,
    par: comp.par,
    title: comp.challenge.title,
    brief: comp.challenge.brief,
    numQubits: comp.challenge.numQubits,
    targetProbabilities: comp.challenge.targetProbabilities,
    tolerance: comp.challenge.tolerance,
  }
}

/** Printable, bounded, never empty. Falls back to a stable per-account tag. */
function sanitiseDisplayName(raw: unknown, accountId: string): string {
  const cleaned =
    typeof raw === 'string'
      ? raw
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, MAX_NAME_CHARS)
      : ''
  return cleaned || `player-${accountId.replace(/[^a-z0-9]/gi, '').slice(0, 8)}`
}

export async function GET(req: Request): Promise<Response> {
  // Keyed on the IP: this runs before (and so without paying for) token
  // verification, which is the expensive part for an anonymous flood.
  const readDecision = await rateLimit(callerKey(req.headers, 'compete-read'), GET_RULE)
  if (!readDecision.allowed) {
    return apiError('rate_limited', { headers: retryAfterHeaders(readDecision) })
  }

  const comp = currentCompetition(new Date())
  const store = getCompeteStore()

  try {
    const leaderboard = (await store.topEntries(comp.id, LEADERBOARD_SIZE)).map((row, i) => ({
      rank: i + 1,
      ...row,
    }))

    const caller = await verifiedCaller(req)
    let you: {
      displayName: string
      gates: number
      submittedAt: string
      rank: number | null
      qasm: string
    } | null = null
    if (caller) {
      const mine = await store.getEntry(comp.id, caller.id)
      if (mine) {
        you = {
          displayName: mine.displayName,
          gates: mine.gates,
          submittedAt: mine.submittedAt,
          rank: await store.rankOf(comp.id, caller.id),
          qasm: mine.qasm, // the caller's own circuit, nobody else's
        }
      }
    }

    return NextResponse.json({
      competition: publicCompetition(comp),
      serverNow: new Date().toISOString(),
      durable: store.durable,
      leaderboard,
      you,
    })
  } catch (err) {
    if (err instanceof CompeteStoreUnavailableError) {
      return failure('upstream_unavailable', err, { scope: 'compete.get' })
    }
    return failure('internal', err, { scope: 'compete.get' })
  }
}

export async function POST(req: Request): Promise<Response> {
  const caller = await verifiedCaller(req)
  if (!caller) return apiError('unauthorized')

  // Keyed on the verified account, not the IP: a signed-in submitter cannot
  // widen their budget by rotating addresses.
  const decision = await rateLimit(callerKey(req.headers, 'compete', caller.id), POST_RULE)
  if (!decision.allowed) {
    return apiError('rate_limited', {
      headers: { 'Retry-After': String(Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000))) },
    })
  }

  // Cap enforced while reading, so an oversized upload is never buffered.
  const rawBody = await readBodyText(req, MAX_BODY_BYTES)
  if (!rawBody.ok) return rawBody.tooLarge ? apiError('payload_too_large') : badRequest(rawBody.error)
  let body: unknown
  try {
    body = JSON.parse(rawBody.value)
  } catch {
    return badRequest('The request body must be JSON.')
  }
  if (typeof body !== 'object' || body === null) return badRequest('The request body must be an object.')
  const { qasm, gates, displayName } = body as {
    qasm?: unknown
    gates?: unknown
    displayName?: unknown
  }
  if (typeof qasm !== 'string' || !qasm.trim()) {
    return badRequest('Send your circuit as OpenQASM in the `qasm` field.')
  }
  if (gates !== undefined && (typeof gates !== 'number' || !Number.isInteger(gates))) {
    return badRequest('`gates`, when sent, must be an integer.')
  }

  // Grade before touching the store: an entry that fails never costs a write.
  const comp = currentCompetition(new Date())
  const verdict = validateEntry(comp, qasm, gates as number | undefined)
  if (!verdict.ok) return badRequest(verdict.reason)

  const entry: CompetitionEntry = {
    competitionId: comp.id,
    accountId: caller.id,
    displayName: sanitiseDisplayName(displayName, caller.id),
    gates: verdict.gates, // the recount — never the claim
    qasm,
    submittedAt: new Date().toISOString(),
  }

  const store = getCompeteStore()
  try {
    // Audit row first so the entry's FK target exists (see the schema comment).
    await store.saveCompetition({
      id: comp.id,
      weekKey: comp.weekKey,
      numQubits: comp.challenge.numQubits,
      par: comp.par,
      targetProbabilities: comp.challenge.targetProbabilities ?? [],
      startsAt: comp.startsAt,
      endsAt: comp.endsAt,
    })
    const { entry: standing, improved } = await store.upsertBest(entry)
    return NextResponse.json({
      accepted: true,
      improved,
      gates: verdict.gates,
      summary: verdict.summary,
      standing: {
        displayName: standing.displayName,
        gates: standing.gates,
        submittedAt: standing.submittedAt,
        rank: await store.rankOf(comp.id, caller.id),
      },
      durable: store.durable,
    })
  } catch (err) {
    if (err instanceof CompeteStoreUnavailableError) {
      return failure('upstream_unavailable', err, { scope: 'compete.post' })
    }
    return failure('internal', err, { scope: 'compete.post' })
  }
}
