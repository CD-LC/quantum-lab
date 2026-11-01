/**
 * POST /api/hardware/submit — server-side proxy for the same path on
 * `services/api`.
 *
 * THIS IS THE ONE THAT SPENDS MONEY. Each accepted call enqueues a job on IBM
 * or Braket, and `forward()` presents the operator's shared secret upstream on
 * the caller's behalf.
 *
 * WHOSE money depends on step 4b. By default it is the OPERATOR's vendor
 * allowance, metered by steps 5–6. When the caller has stored their own vendor
 * credential (BYOK, the internal handoff notes §4) it is theirs, the job is recorded but
 * not metered, and steps 5–6 are replaced by `reserveByokJob`. Read the long
 * comment on that function before deciding a gate was skipped by accident.
 *
 * ── The regression this file used to be ─────────────────────────────────────
 *
 * Between the proxy landing and this change, the only gate here was an IP rate
 * limit of 5/minute. That is not a control on a billable endpoint: IP rotation
 * costs a few dollars an hour. Worse, it was a REGRESSION — before the proxy,
 * an operator who set `API_SHARED_SECRET` (the control docs/SECURITY.md §4
 * recommends) got a 401 upstream for browser traffic, so the hardware page was
 * broken but the endpoint that spends money was shut. The proxy then began
 * attaching that secret on behalf of ANY anonymous caller, so turning on the
 * documented lock stopped protecting the only endpoint with a cost attached.
 * `curl -X POST …/api/hardware/submit` from a signed-out client was accepted.
 *
 * The enforcement layer existed the whole time and had zero callers. It has
 * callers now, and `lib/hardware/submitGate.test.ts` fails if they are removed.
 *
 * ── The gate chain, in order, and why each link is where it is ──────────────
 *
 *  1. IP rate limit (SUBMIT_LIMIT). FIRST, before anything expensive, because
 *     step 2 makes a network call to Supabase and an unauthenticated flood must
 *     not be able to turn this route into a load generator against our own auth
 *     service.
 *  2. `requireCaller` → a Supabase-verified user id, or 401. Identity comes from
 *     a token Supabase validated and from nothing else.
 *  3. Per-ACCOUNT rate limit. The IP bucket bounds one machine; this bucket
 *     bounds one account, and an account is not free to rotate.
 *  4. Shape validation. Cheap, and it keeps a malformed body from ever reaching
 *     the billing layer.
 *  4b. `resolveSubmissionCredential` → whose vendor credential pays. A store
 *     failure REFUSES rather than falling back to the operator's credentials:
 *     a user who attached their own token arranged not to spend ours, and
 *     quietly spending it because a lookup failed is an invisible bill.
 *  5. `requireFeature(id, 'hardware.real')` → 402 for Free. A billing-lookup
 *     failure degrades to the free tier, which here means REFUSE — the safe
 *     direction.
 *  6. `reserveHardwareJobWithinBudget` → ONE call to
 *     `public.reserve_hardware_job_within_budget`, which wraps
 *     `public.reserve_hardware_job` (below) and additionally prices the window
 *     against any spending limit on the account, inside the same transaction
 *     and the same advisory lock. With no budget configured it is the plain
 *     reservation plus one no-op comparison. What the inner function does:
 *     counts the window and inserts the reservation under a per-user advisory
 *     lock. `reserved: false` is a 402; nothing was written for it. This
 *     replaces the insert-then-count dance that STATUS.md carried as a known
 *     race: two genuinely simultaneous submissions could both pass a limit only
 *     one of them fitted under.
 *  7. `forward` — and ONLY now does the shared secret leave this process.
 *  8. `recordHardwareJob` stamps the provider's job handle onto the reserved
 *     row, which is what makes the job pollable by its owner and nobody else.
 *     A non-2xx upstream releases the reservation instead.
 *
 * Steps 5–6 are the only thing that makes `lib/plans.ts`'s advertised 50 / 500 /
 * 5,000 hardware jobs a month mean anything. Before this they were marketing.
 *
 * ── What "a month" means here ───────────────────────────────────────────────
 *
 * The subscription's monthly anniversary, not the calendar month. A customer
 * who subscribes on the 20th would otherwise get the tail of one calendar month
 * plus a full fresh allowance days later — up to double what they paid for, in
 * IBM time the operator buys. lib/billing/period.ts holds the decision and the
 * fallback for accounts with no billing anchor.
 */

import {
  circuitFields,
  forward,
  forwardedJson,
  badRequest,
  featureLocked,
  limitOrNull,
  quotaUnavailable,
  readJsonObject,
  requireCaller,
  MAX_SHOTS,
  outcomeUnknown,
  SUBMIT_LIMIT,
  SUBMIT_TIMEOUT_MS,
} from '@/lib/hardware/proxy'
import { requireFeature } from '@/lib/billing/entitlements'
import { usagePeriodStart } from '@/lib/billing/period'
import {
  hardwareAllowance,
  hardwareJobsInPeriod,
  markHardwareJobUnmatched,
  recordByokHardwareJob,
  recordHardwareCompilation,
  recordHardwareJob,
  releaseHardwareJob,
  reserveHardwareJob,
  QuotaUnavailableError,
  type HardwareReservation,
} from '@/lib/billing/usage'
import {
  BudgetUnavailableError,
  reserveHardwareJobWithinBudget,
} from '@/lib/billing/budget'
import { resolveSubmissionCredential } from '@/lib/hardware/byok'
import {
  ProviderCredentialStoreError,
  touchProviderCredential,
  type ResolvedCredential,
} from '@/lib/security/providerCredentials'
import { FeatureLockedError } from '@/lib/plans'
import { int, isRecord, oneOf, str } from '@/lib/security/validate'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The providers `submit_job()` in services/api/app/quantum/hardware.py
 * dispatches on.
 *
 * `azure` was missing from this list while the upstream dispatcher, the
 * `BACKEND_PROVIDER` table and the device catalogue all handled it, so an
 * explicit `provider: 'azure'` was refused here with a 400 naming two valid
 * values — for a backend the picker had just offered. Omitting the field
 * worked, because upstream derives the provider from the backend id, which is
 * why it went unnoticed: the page's own happy path never sends it.
 */
const PROVIDERS = ['ibm', 'braket', 'azure'] as const

/** Per-account submissions per minute. Tighter than any plan's monthly rate. */
const ACCOUNT_SUBMIT_LIMIT = { limit: 5, windowMs: 60_000 }

/**
 * Mirrors `MAX_OBSERVABLES` in services/api/app/quantum/observables.py, which
 * is authoritative. The copy is here for the same reason the shots and QASM
 * bounds are: a body that would be refused upstream should not first cost a
 * network round trip and a Qiskit parse.
 */
const MAX_OBSERVABLES = 32

/**
 * A finite number, or null.
 *
 * The upstream omits a field it cannot report rather than sending a zero,
 * because an unknown depth and a depth of zero are different claims and the
 * history has to be able to say which one it holds.
 *
 * @param value A field from the upstream submission record.
 * @returns The number, or null when it is absent or not finite.
 */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * A stable, opaque tag for one account, for the vendor's job record.
 *
 * IBM shows job tags in the account console and `service.jobs(job_tags=…)`
 * filters on them, which makes this the one handle that survives when our own
 * record of a job does not — an operator can answer "whose is this job that
 * is burning our QPU seconds" without our database being up.
 *
 * It is hashed rather than sent raw because it crosses a trust boundary into a
 * third party's console and logs. The Supabase user id is already opaque, so
 * this is defence in depth rather than a fix for a leak: a truncated SHA-256
 * is enough to match a tag back to a user we already know, and not enough to
 * enumerate users we do not.
 *
 * Web Crypto rather than `node:crypto` so the module keeps working if this
 * route is ever moved to the edge runtime.
 *
 * @param userId The Supabase-verified caller id. Never a body field.
 * @returns 16 hex characters of SHA-256 over the id.
 */
async function ownerTag(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId))
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function POST(req: Request): Promise<Response> {
  // 1 ── bound the anonymous flood before spending a Supabase round trip on it.
  const limited = await limitOrNull(req, 'hw-submit', SUBMIT_LIMIT)
  if (limited) return limited

  // 2 ── who is this, and may this credential spend?
  //
  // 'hardware:submit' rather than the default read scope. A key issued for
  // reading a job history must not be able to enqueue a billable job — that
  // is the entire reason scopes exist here, and it is the one route where
  // getting it wrong costs money rather than privacy.
  const caller = await requireCaller(req, 'hardware:submit')
  if (!caller.ok) return caller.response

  // 3 ── bound the account, which cannot be rotated the way an IP can.
  const perAccount = await limitOrNull(req, 'hw-submit-acct', ACCOUNT_SUBMIT_LIMIT, caller.id)
  if (perAccount) return perAccount

  // 4 ── shape.
  const body = await readJsonObject(req)
  if (!body.ok) return body.response

  const circuit = circuitFields(body.value)
  if (!circuit.ok) return circuit.response

  const shots = int(body.value.shots, 1, MAX_SHOTS, 'shots')
  if (!shots.ok) return badRequest(shots.error)

  // Mirrors Qiskit's preset pass-manager range and the `ge=0, le=3` bound on
  // the upstream schema. Optional, defaulting to 1 — the value the upstream
  // used unconditionally before it took the field — so a caller that omits it
  // gets exactly the previous behaviour.
  let optimizationLevel = 1
  if (body.value.optimization_level !== undefined && body.value.optimization_level !== null) {
    const checked = int(body.value.optimization_level, 0, 3, 'optimization_level')
    if (!checked.ok) return badRequest(checked.error)
    optimizationLevel = checked.value
  }

  // Free at the vendor: it changes the pulse schedule, not the shot count.
  // Anything other than a literal boolean is refused rather than coerced —
  // `"false"` is truthy in JavaScript, and silently enabling a pulse-level
  // option because a client sent a string is the kind of coercion bug that is
  // only ever found by reading the vendor's job record.
  let dynamicalDecoupling = false
  if (body.value.dynamical_decoupling !== undefined && body.value.dynamical_decoupling !== null) {
    if (typeof body.value.dynamical_decoupling !== 'boolean') {
      return badRequest('dynamical_decoupling must be true or false.')
    }
    dynamicalDecoupling = body.value.dynamical_decoupling
  }

  // Also free at the vendor: the same shot budget is split across Pauli
  // randomisations rather than added to. Same strict boolean check, same
  // reason.
  let measurementTwirling = false
  if (body.value.measurement_twirling !== undefined && body.value.measurement_twirling !== null) {
    if (typeof body.value.measurement_twirling !== 'boolean') {
      return badRequest('measurement_twirling must be true or false.')
    }
    measurementTwirling = body.value.measurement_twirling
  }

  // Observables turn this into an ESTIMATOR job. Shape is NOT re-validated
  // here — every rule about a Pauli string (alphabet, one letter per qubit,
  // term and observable counts, finite coefficients, unique labels) lives in
  // services/api/app/quantum/observables.py, which needs the circuit's qubit
  // count to check the important one. Copying half of it here would give two
  // places to disagree. What IS checked is the coarse shape and a size bound,
  // so a junk body never costs a round trip and a Qiskit parse.
  let observables: unknown[] | null = null
  if (body.value.observables !== undefined && body.value.observables !== null) {
    if (!Array.isArray(body.value.observables)) {
      return badRequest('observables must be an array.')
    }
    if (body.value.observables.length === 0) {
      return badRequest('observables must not be empty. Omit the field to sample instead.')
    }
    if (body.value.observables.length > MAX_OBSERVABLES) {
      return badRequest(`At most ${MAX_OBSERVABLES} observables per job.`)
    }
    observables = body.value.observables
  }

  let resilienceLevel = 1
  if (body.value.resilience_level !== undefined && body.value.resilience_level !== null) {
    const checked = int(body.value.resilience_level, 0, 2, 'resilience_level')
    if (!checked.ok) return badRequest(checked.error)
    resilienceLevel = checked.value
  }

  let sessionId: string | null = null
  if (body.value.session_id !== undefined && body.value.session_id !== null && body.value.session_id !== '') {
    const checked = str(body.value.session_id, 128, 'session_id')
    if (!checked.ok) return badRequest(checked.error)
    sessionId = checked.value
  }

  // A sweep runs the circuit at every point in ONE job — one queue position
  // and ONE unit of the monthly allowance, which is the entire reason it
  // exists. Shape is not re-validated here: every rule about it, including the
  // binding ORDER that is the easy thing to get silently wrong, lives in
  // services/api/app/quantum/parameters.py. What IS checked is that it is an
  // object at all, so junk never costs a round trip and a Qiskit parse.
  let sweep: Record<string, unknown> | null = null
  if (body.value.sweep !== undefined && body.value.sweep !== null) {
    if (!isRecord(body.value.sweep)) {
      return badRequest('sweep must be an object with "points" or "ranges".')
    }
    sweep = body.value.sweep
  }

  // The provider is optional: upstream derives it from the backend id when it
  // is absent, which is what the hardware page relies on. When it IS supplied
  // it must be one of the two the upstream dispatcher knows, so a junk value
  // fails here with a readable message instead of upstream with a 500.
  let provider: string | null = null
  if (body.value.provider !== undefined && body.value.provider !== null && body.value.provider !== '') {
    const checked = oneOf(body.value.provider, PROVIDERS, 'provider')
    if (!checked.ok) return badRequest(checked.error)
    provider = checked.value
  }

  // 4b ── WHOSE CREDENTIAL PAYS FOR THIS JOB.
  //
  // Resolved here, after the body is known to be well formed and before a
  // single billing decision is made, because the answer changes which billing
  // decisions even apply. A caller who has stored their own IBM token is
  // spending their own IBM allowance: this platform's monthly quota is
  // metering a cost it is not about to incur, and charging them a job of it
  // would be charging for nothing. the internal handoff notes §4.
  //
  // A STORE FAILURE REFUSES. It does not fall back to the operator's
  // credentials, and the distinction is the whole reason this is a try/catch
  // rather than a `.catch(() => null)`: a user who attached their own token
  // has arranged NOT to spend the operator's allowance, and silently spending
  // it because Supabase blinked is an invisible, billable surprise. Fail
  // closed, say so, let them retry.
  let credential: ResolvedCredential | null = null
  try {
    credential = await resolveSubmissionCredential(caller.id, provider, circuit.backend)
  } catch (err) {
    if (err instanceof ProviderCredentialStoreError) {
      console.error(`[api/hardware/submit] refusing: ${err.why}`)
      const detail =
        'Your saved provider credential could not be read, so this job was not submitted. ' +
        'Nothing was spent — neither your allowance nor your own provider account. Retry ' +
        'shortly, or remove the stored credential to run on the platform’s credentials instead.'
      return NextResponse.json({ detail, error: detail }, { status: 503 })
    }
    throw err
  }

  // 5–6 ── entitlement, then one atomic reservation — unless the caller is
  //        paying for this job themselves, in which case there is no allowance
  //        to reserve against and only the history row to write.
  const reserved = credential
    ? await reserveByokJob(caller.id, circuit.backend, shots.value)
    : await reserveOperatorJob(caller.id, circuit.backend, shots.value)
  if (reserved instanceof NextResponse) return reserved
  const reservation: HardwareReservation = reserved

  // 7 ── the secret leaves the process here, and not one line earlier.
  const response = await forward(
    '/api/hardware/submit',
    {
      qasm: circuit.qasm,
      backend: circuit.backend,
      shots: shots.value,
      provider,
      optimization_level: optimizationLevel,
      dynamical_decoupling: dynamicalDecoupling,
      measurement_twirling: measurementTwirling,
      observables,
      resilience_level: resilienceLevel,
      session_id: sessionId,
      sweep,
      // NEVER `body.value.owner`. This becomes a tag on the vendor's job, and a
      // caller-supplied one would let anyone label their spend as somebody
      // else's — useless as attribution and actively misleading in an audit.
      // `caller.id` is the id Supabase verified two steps above; `ownerTag`
      // hashes it so the vendor's console holds a stable handle we can match
      // rather than an account identifier we handed to a third party.
      owner: await ownerTag(caller.id),
    },
    undefined,
    // The credential, if any, travels as a header on THIS request and is never
    // written anywhere. `forward` attaches it; nothing here logs it.
    credential,
    // A job submission is slow upstream (it transpiles and enqueues before it
    // answers), so it gets a longer timeout than a read.
    { timeoutMs: SUBMIT_TIMEOUT_MS }
  )

  // Best-effort, and deliberately not awaited before the response is settled:
  // "when did I last use this credential" is bookkeeping for the owner, and a
  // failed write of it is not a reason to fail a submission that has already
  // reached the vendor.
  if (credential) void touchProviderCredential(caller.id, credential.provider)

  // 8 ── settle the reservation against what actually happened upstream.
  const accepted = response.status >= 200 && response.status < 300
  if (!accepted) {
    if (outcomeUnknown(response)) {
      // The request was sent and no answer came back in time. The upstream
      // handler is synchronous and an aborted connection does not cancel it, so
      // the job may well be enqueued. Releasing the reservation here would give
      // a free vendor job (and leave an untracked one). Keep the row, mark it
      // unmatched for reconciliation, and say so honestly.
      return unknownOutcomeJob(reservation)
    }
    // Upstream refused, or could not be reached at all (`forward` turns that
    // into its own 504 without the outcome header). No job exists, so no
    // allowance was spent.
    await releaseHardwareJob(reservation)
    return response
  }

  const payload = await forwardedJson(response)
  const jobId = str(payload?.job_id, 512, 'job_id')
  const submittedProvider = str(payload?.provider, 32, 'provider')
  if (payload && jobId.ok && submittedProvider.ok) {
    // The handle FIRST and on its own. This is the write that makes the job
    // pollable at all, and it must not be made conditional on columns that a
    // deployment running an older schema does not have yet.
    await recordHardwareJob(reservation, submittedProvider.value, jobId.value)
    // Then the experimental record: the circuit that was sent and what
    // compiling it produced. Without this the history is a list of histograms
    // with no provenance — a researcher cannot tell which of six variants
    // produced which distribution, or re-run one.
    await recordHardwareCompilation(reservation.id, {
      qasm: circuit.qasm,
      optimizationLevel: optimizationLevel,
      transpiledDepth: numberOrNull(payload.transpiled_depth),
      transpiledTwoQubitGates: numberOrNull(payload.transpiled_two_qubit_gates),
    })
    // Tells the page which allowance this job drew on, so the UI can say "ran
    // on your own IBM account" instead of silently not decrementing a counter
    // the user is watching. A header rather than a body field because the body
    // is the upstream's, passed through verbatim, and rewriting it here would
    // make this proxy a place where response shapes are invented.
    response.headers.set('X-Qubit16-Credential-Owner', credential ? 'user' : 'operator')
    return response
  }

  // A 2xx with no usable handle — including a 2xx whose body would not parse.
  return unmatchedJob(reservation, submittedProvider.ok ? submittedProvider.value : null)
}

/**
 * The allowance path: entitlement, then one atomic reservation.
 *
 * Lifted out of the handler when BYOK arrived, unchanged in behaviour. It is a
 * function rather than an inline block so the handler can read as one line of
 * "who is paying?" followed by one line of "reserve accordingly", instead of
 * seventy lines of billing nested inside an `else`.
 *
 * @returns The reservation, or the refusal to send back.
 */
async function reserveOperatorJob(
  userId: string,
  backend: string,
  shots: number
): Promise<HardwareReservation | NextResponse> {
  try {
    // Ask the meter for a number BEFORE asking the billing layer for a plan.
    // Order matters for the error the caller sees, not for safety: both
    // branches refuse. `getEntitlement` degrades to Free on any failure, so a
    // Pro user would otherwise be told "upgrade to Pro" during a database
    // outage — technically fail-closed, and a support ticket. Reading the count
    // first turns that case into an honest 503. (If the `subscriptions` read
    // fails while `hardware_usage` answers, a Pro caller still sees 402. That
    // is the one ambiguous case left and it errs towards refusing.) The count
    // itself is discarded: the authoritative one is taken inside the lock. The
    // window passed here is therefore arbitrary — `usagePeriodStart(null)` is
    // the calendar month, and this call exists only to make the store answer.
    await hardwareJobsInPeriod(userId, usagePeriodStart(null))
    const entitlement = await requireFeature(userId, 'hardware.real')

    // Allowance AND budget, in one RPC under one advisory lock.
    //
    // `reserveHardwareJobWithinBudget` wraps `reserve_hardware_job` rather than
    // replacing it, so an account with no budget configured gets byte-identical
    // behaviour and one extra no-op comparison. It also falls back to the plain
    // reservation, with a log, when supabase/schema-budgets.sql has not been
    // applied — which is why this is safe to ship before that migration runs.
    //
    // A budget is checked in the SAME transaction as the count for the same
    // reason the count moved into Postgres in the first place: a check-then-act
    // budget has exactly the race the quota used to have, where two
    // simultaneous submissions both pass a limit only one of them fits under.
    const outcome = await reserveHardwareJobWithinBudget(
      userId,
      backend,
      shots,
      hardwareAllowance(entitlement),
      usagePeriodStart(entitlement.currentPeriodEnd)
    )
    if (!outcome.reserved || !outcome.reservation) {
      // Nothing was written for any of these, so a refusal costs the caller
      // nothing. The message names WHICH ceiling stopped them, because
      // "upgrade your plan" is the wrong advice for somebody who set their own
      // spending limit and the right advice for somebody who ran out of jobs.
      if (outcome.refusedBy === 'budget') {
        const limit = outcome.budgetLimitUsd
        return featureLocked(
          limit === null
            ? 'This job would exceed the spending limit set on this account.'
            : `This job would take this account past its $${limit.toFixed(2)} spending limit ` +
              'for the current period. Raise the limit or wait for the period to roll over.'
        )
      }
      if (outcome.refusedBy === 'unpriced') {
        // A budget is set and this device cannot be priced in dollars —
        // Quantinuum bills in H-System Credits at a customer-specific rate. We
        // will not silently count an unpriceable job as $0 against a ceiling
        // somebody set precisely so they could stop worrying about cost.
        return featureLocked(
          'This device cannot be priced in dollars, so it cannot be checked against the ' +
            'spending limit on this account. Remove the limit to run on it, or choose a ' +
            'device with published per-shot pricing.'
        )
      }
      return featureLocked('You have used every hardware job included in your plan this month.')
    }
    return outcome.reservation
  } catch (err) {
    if (err instanceof FeatureLockedError) return featureLocked(err.message)
    if (err instanceof QuotaUnavailableError) return quotaUnavailable(err, 'api/hardware/submit')
    // Same fail-closed rule, one layer out: if the budget store cannot answer,
    // we do not know whether this job fits under a ceiling somebody set, and
    // an unknown answer on a spending path is a refusal.
    if (err instanceof BudgetUnavailableError) {
      return quotaUnavailable(
        new QuotaUnavailableError(`the spend budget could not be read: ${err.message}`),
        'api/hardware/submit'
      )
    }
    // Anything else is a bug in the gate itself. Refuse: an unexplained error
    // on the path that authorises spending is not a reason to spend.
    console.error('[api/hardware/submit] gate threw:', err)
    return quotaUnavailable(
      new QuotaUnavailableError('the entitlement gate threw an unexpected error'),
      'api/hardware/submit'
    )
  }
}

/**
 * The BYOK path: no entitlement, no allowance, no budget — just the record.
 *
 * ── Why every gate above this one is skipped, one at a time ─────────────────
 *
 *  · `requireFeature(id, 'hardware.real')` — a 402 that says "upgrade to Pro to
 *    run on real hardware" is an answer about who pays for the hardware. When
 *    the caller pays, the question does not arise. Keeping the gate would mean
 *    charging a subscription for the privilege of spending your own IBM
 *    allowance through our front end, which is not a product, it is a toll.
 *  · The monthly allowance — meters the operator's vendor spend. This job
 *    creates none.
 *  · The spend budget — denominated in OUR published-price estimate of what a
 *    job costs US. The user's own IBM plan bills them on its own terms and we
 *    never see the invoice, so enforcing our estimate against their money
 *    would be a projection presented as a measurement. supabase/schema-
 *    budgets.sql refuses to do that everywhere else and this is not the place
 *    to start.
 *
 * What is NOT skipped, and must never be: identity (`requireCaller`), both
 * rate limits, and every shape check. Those bound abuse and malformed input,
 * neither of which becomes acceptable because somebody brought their own
 * token — a credential that lets you drive our servers in a loop is still our
 * CPU, and the per-account submit limit is the thing standing in front of it.
 *
 * @returns The reservation, or the refusal to send back.
 */
async function reserveByokJob(
  userId: string,
  backend: string,
  shots: number
): Promise<HardwareReservation | NextResponse> {
  try {
    return await recordByokHardwareJob(userId, backend, shots)
  } catch (err) {
    if (err instanceof QuotaUnavailableError) {
      // Worth the distinct wording: the standard copy says usage "cannot be
      // metered", which would be a baffling reason to refuse a job with no
      // meter attached. What actually failed is the history write, and the
      // consequence — an unpollable job — is the thing worth explaining.
      return quotaUnavailable(
        err,
        'api/hardware/submit',
        'This job was not submitted because it could not be recorded, which would have left ' +
          'you with a job running on your own provider account that this site could not show ' +
          'you. Nothing was spent. Retry shortly.'
      )
    }
    console.error('[api/hardware/submit] BYOK record threw:', err)
    return quotaUnavailable(
      new QuotaUnavailableError('the BYOK record threw an unexpected error'),
      'api/hardware/submit'
    )
  }
}

/**
 * The upstream said yes and gave us nothing to poll.
 *
 * WHAT WAS HERE BEFORE: the reservation was kept, a line was written to the
 * console, and the upstream's 2xx was passed through unchanged. That is the
 * worst of the three available outcomes. The browser's `submit()` types the
 * body as `SubmittedJob` and the hardware page immediately starts a monitor on
 * `job_id`, so the user got a job card polling `undefined` — a broken card and
 * no way to find out whether their circuit is running. STATUS.md listed it as
 * "logged, not handled".
 *
 * THE DECISION, and the two rejected alternatives:
 *
 *  · REFUND AND REPORT SUCCESS was rejected: the vendor may well have accepted
 *    the job (a 2xx normally means it did), and handing allowance back for
 *    spend we cannot rule out is the expensive direction — the same reasoning
 *    that makes this whole module fail closed.
 *  · PASS THE 2xx THROUGH was rejected: a response that claims success and
 *    omits the only field the caller needs is a lie the UI cannot detect.
 *
 * So: KEEP the usage row, MARK it `settlement = 'unmatched'` so an operator can
 * find it (query 5 in supabase/schema-billing.sql), and answer 502 with copy
 * that tells the user exactly what is true — it may be running, we cannot show
 * it, look in the provider's console. That is an honest answer to an honest
 * mess, and it is actionable by both the user and support.
 *
 * If this fires more than rarely, the bug is upstream in `services/api`'s
 * hardware dispatcher and this route is the wrong place to fix it.
 */
/**
 * The upstream did not answer within the submit timeout. The job may be
 * running at the provider, so the usage row is kept (counted against the
 * allowance) and marked unmatched rather than refunded.
 */
async function unknownOutcomeJob(reservation: HardwareReservation): Promise<Response> {
  console.error(
    `[api/hardware/submit] upstream timed out; usage row ${reservation.id} kept and ` +
      'marked unmatched because the job may have been enqueued.'
  )
  await markHardwareJobUnmatched(reservation, null)
  const detail =
    'The provider did not confirm this submission in time, so the job may still be running. ' +
    'It has been counted against your allowance until it can be checked — look at your job ' +
    'history in a few minutes before submitting it again.'
  return NextResponse.json({ detail, error: detail, offline: false, unknownOutcome: true }, { status: 504 })
}

async function unmatchedJob(
  reservation: HardwareReservation,
  provider: string | null
): Promise<Response> {
  console.error(
    '[api/hardware/submit] upstream returned 2xx without a usable job_id/provider; ' +
      `usage row ${reservation.id} kept and marked unmatched. The job may exist at the ` +
      'provider and cannot be polled through this proxy.'
  )
  await markHardwareJobUnmatched(reservation, provider)
  const detail =
    'The provider accepted the circuit but did not return a job id, so this job cannot be ' +
    'tracked here. It has been counted against your allowance because it may be running — ' +
    "check the provider's console, or contact support with the time of this submission."
  return NextResponse.json({ detail, error: detail, unpollable: true }, { status: 502 })
}
