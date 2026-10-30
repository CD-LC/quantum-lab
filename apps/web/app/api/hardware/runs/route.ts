/**
 * POST /api/hardware/runs — publish one hardware run as a citable permalink.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * A paper needs a reproducibility artefact and currently attaches a GitHub
 * gist. A permalink here carries the circuit, the device, the compilation
 * settings, the raw counts and — the part nobody else keeps — the calibration
 * the device reported at submission time. That last field is what makes a
 * result reproducible rather than merely repeatable: "IBM Brisbane" in 2026 is
 * not the same machine as "IBM Brisbane" in 2027.
 *
 * ── Publishing is irreversible in the way that matters ──────────────────────
 *
 * The row is immutable once written (a trigger in supabase/schema-runs.sql
 * permits exactly one UPDATE, setting `withdrawn_at`), and until it is
 * withdrawn anyone with the link can read it without an account. That is the
 * point of a citation, and it is also why:
 *
 *   * `optIn` has no default anywhere in this path. A default of false lets a
 *     backfill write dead rows; a default of true publishes somebody's data
 *     silently. A required field simply fails, which is the only one of the
 *     three anybody notices.
 *   * The circuit is published VERBATIM, comments included. The UI says so
 *     before the button is pressed.
 *   * The account id, the vendor job id and the owner tag are removed by
 *     `buildPublishedRun` — the job id in particular is a handle into the
 *     owner's own vendor console and has no business in a public record.
 *
 * ── Re-publishing is not an error ───────────────────────────────────────────
 *
 * The public id is derived from the source row, so publishing the same run
 * twice produces the same id and the second insert hits a unique violation.
 * That is answered with the existing permalink and a 200, because from the
 * caller's side "it is published, here is the link" is true either way.
 */

import { NextResponse } from 'next/server'
import { limitOrNull, quotaUnavailable, requireCaller, SUBMIT_LIMIT } from '@/lib/hardware/proxy'
import { readJsonObject } from '@/lib/hardware/proxy'
import { QuotaUnavailableError, readOwnedHardwareRun } from '@/lib/billing/usage'
import { getServiceSupabase, isServiceRoleConfigured } from '@/lib/billing/entitlements'
import {
  buildPublishedRun,
  publishedRunInsert,
  runPermalinkPath,
  type PublishRefusalReason,
} from '@/lib/hardware/permalink'
import { str } from '@/lib/security/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Which refusals are the caller's fault and which are the run's state.
 *
 * 409 rather than 400 for the two that describe a run that simply is not
 * publishable yet — a job still queued, or one with no stored circuit. Nothing
 * about the request was wrong, and a 400 would send somebody looking for a
 * typo in a body that is fine.
 */
const REFUSAL_STATUS: Record<PublishRefusalReason, number> = {
  'not-opted-in': 400,
  'metadata-too-long': 400,
  'circuit-too-large': 400,
  'unknown-calibration-source': 400,
  'not-terminal': 409,
  'no-circuit': 409,
  'no-source-id': 409,
  'no-account-id': 409,
}

/** Postgres unique violation. Here it means "already published", not an error. */
const UNIQUE_VIOLATION = '23505'

export async function POST(req: Request): Promise<Response> {
  const limited = await limitOrNull(req, 'hw-publish', SUBMIT_LIMIT)
  if (limited) return limited

  // The read scope: publishing spends nothing at a vendor. It DOES make
  // somebody's data public, which is what the per-row opt-in below is for.
  const caller = await requireCaller(req, 'hardware:read')
  if (!caller.ok) return caller.response

  // Publishing is irreversible and world-readable (published_runs rows are
  // immutable and served to anonymous visitors), so a read-scoped API key —
  // the credential that sits in CI variables and notebooks — must not be able
  // to do it. A person signed in with a session token can; the `optIn` check
  // below is then that person's explicit consent, not a script's.
  if (caller.via !== 'session') {
    return NextResponse.json(
      {
        detail:
          'Publishing a run makes it public and cannot be undone, so it needs a signed-in ' +
          'session rather than an API key. Publish it from the Qubit16 site while signed in.',
      },
      { status: 403 }
    )
  }

  const body = await readJsonObject(req)
  if (!body.ok) return body.response

  const rowId = str(body.value.rowId, 64, 'rowId')
  if (!rowId.ok) return NextResponse.json({ detail: rowId.error }, { status: 400 })

  // Checked as a literal `true`, not for truthiness. A string "false" is
  // truthy in JavaScript, and consent inferred from a coercion is not consent.
  if (body.value.optIn !== true) {
    return NextResponse.json(
      {
        detail:
          'Publishing requires an explicit opt-in for this run. Send optIn: true only when ' +
          'the owner has been shown what will become public.',
      },
      { status: 400 }
    )
  }

  if (!isServiceRoleConfigured) {
    return NextResponse.json(
      { detail: 'Publishing is unavailable: this deployment has no service-role key.' },
      { status: 503 }
    )
  }

  let run
  try {
    run = await readOwnedHardwareRun(caller.id, rowId.value)
  } catch (err) {
    if (err instanceof QuotaUnavailableError) return quotaUnavailable(err, 'api/hardware/runs')
    throw err
  }
  // Somebody else's run and a run that never existed answer the same 404, for
  // the same reason the job-status route does: a distinct 403 would confirm
  // that a row id is real.
  if (!run) return NextResponse.json({ detail: 'No such run.' }, { status: 404 })

  const outcome = await buildPublishedRun(
    { ...run, ownerTag: null },
    {
      optIn: true,
      title: optionalText(body.value.title, 200),
      attribution: optionalText(body.value.attribution, 200),
      notes: optionalText(body.value.notes, 2000),
      // Not captured at submission time yet, so it is honestly absent rather
      // than back-filled from today's calibration — which would be a different
      // machine's numbers attached to an old run. The public page renders
      // NO_CALIBRATION_NOTICE for exactly this case.
      calibration: null,
      calibrationCapturedAt: null,
    }
  )

  if (!outcome.ok) {
    return NextResponse.json(
      { detail: outcome.refusal.detail, reason: outcome.refusal.reason },
      { status: REFUSAL_STATUS[outcome.refusal.reason] ?? 400 }
    )
  }

  const supabase = getServiceSupabase()
  if (!supabase) {
    return NextResponse.json({ detail: 'Publishing is unavailable right now.' }, { status: 503 })
  }

  const { error } = await supabase
    .from('published_runs')
    .insert(publishedRunInsert(outcome.snapshot, outcome.digest, {
      sourceId: rowId.value,
      ownerId: caller.id,
    }))

  if (error && error.code !== UNIQUE_VIOLATION) {
    console.error(`[api/hardware/runs] insert failed: ${error.message}`)
    return NextResponse.json({ detail: 'The run could not be published.' }, { status: 503 })
  }

  return NextResponse.json(
    {
      publicId: outcome.snapshot.publicId,
      path: runPermalinkPath(outcome.snapshot.publicId),
      // True on a re-publish. The caller gets the same link either way; this
      // just lets a UI say "already published" instead of "published".
      alreadyPublished: Boolean(error),
    },
    { status: error ? 200 : 201, headers: { 'cache-control': 'no-store' } }
  )
}

/**
 * A bounded optional string, or null.
 *
 * Over-length metadata is refused by `buildPublishedRun` with a reason the
 * caller can act on, so this only normalises absence — it must not truncate,
 * which would publish something the owner did not write.
 *
 * @param value The raw field.
 * @param max The limit, for the early bound only.
 * @returns The trimmed string, or null.
 */
function optionalText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  // Deliberately NOT sliced: `buildPublishedRun` refuses over-length metadata
  // and says so. Passing the full value through is what lets it.
  return trimmed.length > max * 4 ? trimmed.slice(0, max * 4) : trimmed
}
