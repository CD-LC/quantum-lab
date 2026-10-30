/**
 * client.ts — the typed fetch client for the Python hardware API.
 *
 * Design rule: THIS MODULE NEVER THROWS AND NEVER HANGS.
 *
 * In local development the Python service is usually not running, and that is
 * the expected case rather than a fault. So every call returns a discriminated
 * `Result<T>` and every request is bounded by an AbortController timeout — a
 * promise that never settles would leave the UI spinning forever, which is a
 * worse outcome than any error message.
 *
 * `offline` distinguishes "nothing answered on the socket" (start the API) from
 * "the API answered with a 4xx/5xx" (read the message); the UI shows very
 * different copy for the two.
 *
 * ── The calls now go through the Next server ────────────────────────────────
 *
 * Every endpoint the app uses is fetched from a same-origin route under
 * `/api/hardware/*`, which forwards to `services/api` and attaches the shared
 * secret when one is configured. See lib/hardware/proxy.ts. The browser never
 * talks to the Python service directly, which is what made the opt-in
 * `API_SHARED_SECRET` unusable before (docs/SECURITY.md §4, step 3).
 *
 * The user-visible behaviour is unchanged. Error messages still name
 * `NEXT_PUBLIC_API_URL` rather than the proxy, because when the hardware page
 * says "could not reach it, run `uvicorn app.main:app`" the useful host to name
 * is the Python one. The proxy reports an unreachable upstream as a 504 with
 * `offline: true` in the body, which `request()` folds back into the same
 * offline Result the browser used to build from its own thrown fetch.
 *
 * ── The calls carry the caller's session token ──────────────────────────────
 *
 * `/api/hardware/submit` spends the operator's money and `/api/hardware/job/*`
 * returns somebody's measurement results, so both now require a Supabase-
 * verified caller (see the gate chains in those route files). The token is
 * attached by `lib/authFetch.ts` — the ONE place in the app that reads the
 * session and shapes the `Authorization: Bearer …` header the routes parse.
 *
 * THIS IS NOT OPTIONAL PLUMBING. Adding the server-side gate without this line
 * would 401 every paying customer while leaving `curl` exactly as refused, i.e.
 * it would break the product and fix nothing for the people who matter. When
 * nobody is signed in, `authFetch` sends no header at all and the route answers
 * 401 with copy the page renders — which is the correct outcome, not a bug.
 */

import { authFetch } from '@/lib/authFetch'
import type {
  CircuitAnalysis,
  HardwareJobHistoryEntry,
  RuntimeSession,
  CostEstimate,
  HardwareDevice,
  JobStatus,
  QueueJob,
  SubmittedJob,
  TranspileResult,
} from '@/lib/hardware/types'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'

/** Requests are cut off after this long; the API may simply not be listening. */
const TIMEOUT_MS = 8000
/** Submitting a job waits for the provider; must exceed the proxy's SUBMIT_TIMEOUT_MS (45s). */
const SUBMIT_CLIENT_TIMEOUT_MS = 50_000

export type Result<T> =
  | { ok: true; data: T }
  /**
   * `status` is the HTTP status when there was one, and undefined when the
   * request never got an answer (a timeout or a dead host — the cases
   * `offline` already marks).
   *
   * It is here because 401 is not a failure for every caller: the job-history
   * panel renders it as "sign in to see your runs", which is the normal state
   * for a visitor, not an error to apologise for. Distinguishing it by parsing
   * the message text would break the first time the copy changed.
   */
  | { ok: false; error: string; offline: boolean; status?: number }

/** The base URL every call targets, so the UI can name the exact host that failed. */
export function apiBaseUrl(): string {
  return API_BASE
}

/**
 * Same-origin path for a proxied endpoint. Relative on purpose: this module
 * runs in the browser, and hard-coding an origin would break preview
 * deployments and any reverse proxy in front of the app.
 */
function proxied(path: string): string {
  return path
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Pull a human message out of a FastAPI error body without trusting its shape. */
function detailFrom(body: unknown, status: number): string {
  if (typeof body === 'string' && body.trim()) return body.trim()
  if (body && typeof body === 'object') {
    const detail = (body as { detail?: unknown }).detail
    if (typeof detail === 'string' && detail.trim()) return detail.trim()
    if (Array.isArray(detail)) {
      const messages = detail
        .map((item) =>
          item && typeof item === 'object' && typeof (item as { msg?: unknown }).msg === 'string'
            ? (item as { msg: string }).msg
            : null,
        )
        .filter((msg): msg is string => msg !== null)
      if (messages.length) return messages.join('; ')
    }
  }
  return `The API responded with HTTP ${status}.`
}

/**
 * Perform one request and fold every failure mode into a Result.
 *
 * @param url  Where to send it. Use `proxied()` for anything the Next server
 *             forwards; a bare `${API_BASE}${path}` still works and is what the
 *             two unproxied helpers at the bottom of this file do.
 * @param init Standard fetch options; a JSON content-type is added for bodies.
 * @param send Which fetch to use. Defaults to `authFetch`, which attaches the
 *             signed-in user's bearer token; the unproxied helpers at the
 *             bottom of this file pass plain `fetch` because they talk to
 *             another origin and have no route of ours to authenticate to.
 */
async function request<T>(
  url: string,
  init?: RequestInit,
  send: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = authFetch,
  timeoutMs: number = TIMEOUT_MS,
): Promise<Result<T>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await send(url, {
      ...init,
      signal: controller.signal,
      headers:
        init?.body === undefined
          ? init?.headers
          : { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })

    let body: unknown = null
    const text = await response.text()
    if (text) {
      try {
        body = JSON.parse(text) as unknown
      } catch {
        body = text
      }
    }

    if (!response.ok) {
      // The proxy could not reach services/api. Restore the distinction the
      // browser used to get for free from a thrown fetch: this is "start the
      // API", not "the API said no". Only the proxy sets this flag, and it sets
      // it alongside a `detail` already worded for the user.
      if (isRecord(body) && body.offline === true) {
        return {
          ok: false,
          error: detailFrom(body, response.status),
          offline: true,
          status: response.status,
        }
      }
      return {
        ok: false,
        error: detailFrom(body, response.status),
        offline: false,
        status: response.status,
      }
    }

    // The API answered 2xx: the body is whatever its pydantic response_model
    // declared, mirrored in lib/hardware/types.ts.
    return { ok: true, data: body as T }
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError'
    return {
      ok: false,
      offline: true,
      error: aborted
        ? `No response from ${API_BASE} within ${timeoutMs / 1000}s.`
        : `Could not reach ${API_BASE}.`,
    }
  } finally {
    clearTimeout(timer)
  }
}

// ── proxied: these go through the Next server (app/api/hardware/**) ─────────
//
// The path is the same on both sides, so a route file's folder name is also
// the upstream path. Keep it that way; a rename here needs the matching route.

/** GET /api/hardware/devices */
export function listDevices(): Promise<Result<HardwareDevice[]>> {
  return request<HardwareDevice[]>(proxied('/api/hardware/devices'))
}

/** POST /api/hardware/estimate */
export function estimate(
  backend: string,
  shots: number,
  qasm: string,
): Promise<Result<CostEstimate>> {
  return request<CostEstimate>(proxied('/api/hardware/estimate'), {
    method: 'POST',
    body: JSON.stringify({ backend, shots, qasm }),
  })
}

/** POST /api/hardware/transpile */
export function transpile(
  qasm: string,
  backend: string,
  level = 1,
): Promise<Result<TranspileResult>> {
  return request<TranspileResult>(proxied('/api/hardware/transpile'), {
    method: 'POST',
    body: JSON.stringify({ qasm, backend, optimization_level: level }),
  })
}

/** POST /api/hardware/submit — returns a handle, never a result. */
export interface SubmitOptions {
  provider?: string
  /**
   * The Qiskit preset pass-manager level to transpile at, 0-3.
   *
   * Send the SAME level the transpile preview was taken at. Submission used to
   * be hardcoded to 1 upstream while the preview ran at whatever the page
   * asked for, so a user who previewed at level 3 was shown a depth and a
   * two-qubit count belonging to a circuit that was never sent to the device.
   */
  optimizationLevel?: number
  /** Ask for idle-time dynamical decoupling. Free; IBM only, ignored elsewhere. */
  dynamicalDecoupling?: boolean
  /** Ask for readout twirling. Also free; IBM only, ignored elsewhere. */
  measurementTwirling?: boolean
  /**
   * Turn this into an ESTIMATOR job: the device measures ⟨ψ|H|ψ⟩ for each
   * observable instead of returning a histogram.
   *
   * Shape: `[{label, terms: [{pauli, coefficient}]}]`. Every rule about it is
   * enforced server-side in services/api/app/quantum/observables.py, which is
   * the only place that knows the circuit's qubit count.
   *
   * The circuit must NOT contain measurements — a terminal measurement
   * collapses the state before the observable is applied, and the server
   * refuses rather than silently editing your circuit.
   */
  observables?: unknown[]
  /** Estimator error mitigation: 0 none, 1 readout (default), 2 + ZNE. */
  resilienceLevel?: number
  /** An open runtime session to run inside, from `openSession`. */
  sessionId?: string
  /**
   * Sweep the circuit's free parameters — one job, one queue position, and
   * ONE unit of the monthly allowance for every point.
   *
   * Shape: `{points: [{theta: 0}, ...]}` or
   * `{ranges: [{parameter: 'theta', start: 0, stop: 3.14, points: 20}]}`.
   * The circuit must declare its parameters (`input float[64] theta;`).
   *
   * KEEP `sweep_points` from the response: polling without it reads every
   * point's shots as one merged histogram.
   */
  sweep?: Record<string, unknown>
}

export function submit(
  qasm: string,
  backend: string,
  shots: number,
  options: SubmitOptions | string = {},
): Promise<Result<SubmittedJob>> {
  // The fourth argument was a bare `provider?: string` before it grew a second
  // and a third companion. Accepting both shapes keeps every existing call
  // site — and `lib/workbench/targets.ts`, which passes a provider string —
  // compiling and behaving identically.
  const opts: SubmitOptions = typeof options === 'string' ? { provider: options } : options
  return request<SubmittedJob>(proxied('/api/hardware/submit'), {
    method: 'POST',
    body: JSON.stringify({
      qasm,
      backend,
      shots,
      provider: opts.provider ?? null,
      optimization_level: opts.optimizationLevel ?? 1,
      dynamical_decoupling: opts.dynamicalDecoupling ?? false,
      measurement_twirling: opts.measurementTwirling ?? false,
      // Omitted rather than sent as null when absent, so the server's
      // "observables present => estimator" test is unambiguous.
      ...(opts.observables ? { observables: opts.observables } : {}),
      ...(opts.resilienceLevel !== undefined
        ? { resilience_level: opts.resilienceLevel }
        : {}),
      ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
      ...(opts.sweep ? { sweep: opts.sweep } : {}),
    }),
    // Longer than a read: the proxy waits up to SUBMIT_TIMEOUT_MS for the
    // provider, and giving up sooner here would report "offline" for a job
    // that is in fact being enqueued.
  }, authFetch, SUBMIT_CLIENT_TIMEOUT_MS)
}

/**
 * POST /api/hardware/session — reserve a device for an iterative workload.
 *
 * THIS BILLS FOR AS LONG AS IT IS OPEN, whether or not jobs are running. Close
 * it with `closeSession` when the loop ends; `maxTimeSeconds` is the backstop
 * for when that does not happen.
 *
 * @param backend The IBM device to reserve.
 * @param maxTimeSeconds Hard ceiling on the session's life, 60 to 28,800.
 */
export function openSession(
  backend: string,
  maxTimeSeconds = 3600,
): Promise<Result<RuntimeSession>> {
  return request<RuntimeSession>(proxied('/api/hardware/session'), {
    method: 'POST',
    body: JSON.stringify({ backend, max_time_seconds: maxTimeSeconds }),
  })
}

/**
 * DELETE /api/hardware/session/{id} — stop holding the device.
 *
 * Jobs already submitted into the session are NOT cancelled; they drain.
 *
 * @param sessionId The id from `openSession`.
 */
export function closeSession(
  sessionId: string,
): Promise<Result<{ session_id: string; closed: boolean }>> {
  return request<{ session_id: string; closed: boolean }>(
    proxied(`/api/hardware/session/${encodeURIComponent(sessionId)}`),
    { method: 'DELETE' },
  )
}

/**
 * GET /api/hardware/jobs — this account's durable hardware job history.
 *
 * Not proxied to `services/api`: the history lives in OUR database, written by
 * the job-status route as it observes each job. `services/api` has no idea who
 * submitted what.
 *
 * Requires a signed-in caller; signed out it answers 401, which the panel
 * renders as "sign in to see your runs" rather than as an error.
 *
 * @param limit How many rows, 1-200.
 * @param includeQasm Ask for the circuit source too. Off by default because it
 *   is the largest column and the list does not render it; the export does.
 */
export function listJobs(
  limit = 50,
  includeQasm = false,
): Promise<Result<{ jobs: HardwareJobHistoryEntry[] }>> {
  const query = new URLSearchParams({ limit: String(limit) })
  if (includeQasm) query.set('include_qasm', '1')
  return request<{ jobs: HardwareJobHistoryEntry[] }>(`/api/hardware/jobs?${query.toString()}`)
}

/**
 * GET /api/hardware/job/{provider}/{job_id} — the job id may be a Braket ARN.
 *
 * @param provider 'ibm', 'braket' or 'azure'.
 * @param jobId The vendor's job handle.
 * @param observableLabels For an ESTIMATOR job, the labels from the submission
 *   response, in order. Passing them is what turns the result's array of
 *   floats back into named expectation values — IBM stores the observables but
 *   not our names for them, so this array is the caller's own record.
 * @param sweepPoints For a SWEPT job, `sweep_points` from the submission
 *   response. Without it the points are merged into one histogram.
 */
export function pollJob(
  provider: string,
  jobId: string,
  observableLabels?: string[],
  sweepPoints?: number,
): Promise<Result<JobStatus>> {
  const path = `/api/hardware/job/${encodeURIComponent(provider)}/${jobId
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
  const params = new URLSearchParams()
  if (observableLabels) params.set('observables', observableLabels.join(','))
  // From the submission record. Omitting it for a swept job is the silent
  // failure — see `sweep` in SubmitOptions.
  if (sweepPoints && sweepPoints > 1) params.set('sweep_points', String(sweepPoints))
  const query = params.toString()
  return request<JobStatus>(proxied(query ? `${path}?${query}` : path))
}

// ── NOT proxied: dead code that still talks to services/api directly ────────
//
// Nothing in the app calls any of the three functions below — `analyse` has no
// importer and the local job queue was never wired into a page. They are left
// pointing straight at NEXT_PUBLIC_API_URL rather than proxied, because
// docs/SECURITY.md §4 says do not widen what the proxy exposes, and adding a
// route handler for an endpoint no page uses does exactly that.
//
// CONSEQUENCE, stated plainly: with API_SHARED_SECRET set on services/api these
// three return 401, and with the API on a private network they cannot connect
// at all. That is a real, known gap and it is not fixed here. If you wire one
// into a page, add a route handler under app/api/hardware/** first and switch
// it to `proxied()` — do not "fix" it by re-publishing the API to the browser.

/** POST /api/hardware/analyse — unproxied; see the note above. */
export function analyse(qasm: string): Promise<Result<CircuitAnalysis>> {
  return request<CircuitAnalysis>(
    `${API_BASE}/api/hardware/analyse`,
    { method: 'POST', body: JSON.stringify({ qasm }) },
    fetch,
  )
}

/** POST /api/jobs — the local simulator queue, not a real device. Unproxied. */
export function submitLocalJob(
  qasm: string,
  backend = 'aer_simulator',
  shots = 1024,
  noise = 0,
  label?: string,
): Promise<Result<QueueJob>> {
  return request<QueueJob>(
    `${API_BASE}/api/jobs`,
    {
      method: 'POST',
      body: JSON.stringify({ qasm, backend, shots, noise, label: label ?? null }),
    },
    fetch,
  )
}

/** GET /api/jobs/{id} — unproxied; see the note above. */
export function pollLocalJob(id: string): Promise<Result<QueueJob>> {
  return request<QueueJob>(`${API_BASE}/api/jobs/${encodeURIComponent(id)}`, undefined, fetch)
}
