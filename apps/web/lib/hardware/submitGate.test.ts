/**
 * submitGate.test.ts — THE TESTS THAT WOULD HAVE CAUGHT THE REGRESSION.
 *
 * `POST /api/hardware/submit` is the only endpoint in this repository that
 * spends the operator's money, and the Next server attaches the operator's
 * shared secret to every upstream call. For a while the route's only gate was
 * an IP rate limit, so a signed-out `curl` could enqueue jobs on IBM at 5 a
 * minute per address, with the secret helpfully supplied. There was no test
 * asserting that an anonymous caller is refused; that absence is what let it
 * ship. The first test in this file is exactly that assertion.
 *
 * ── What is faked, and what is real ─────────────────────────────────────────
 *
 * Only two things are faked: `@supabase/supabase-js`'s client (an in-memory
 * table store plus a token→user map) and the module-level `getSupabase` the auth
 * helper uses. Everything between the route handler and those — `verifiedCaller`,
 * `getEntitlement`, `requireFeature`, `assertHardwareQuota`, the reservation
 * dance in `lib/billing/usage.ts`, `lib/plans.ts`'s allowances — runs for real.
 * A test that mocked the entitlement layer would pass just as happily with the
 * entitlement layer deleted, which is the state this whole change is fixing.
 *
 * `fetch` is stubbed, so what is observed at the boundary is: was the upstream
 * called at all, and did the shared secret leave the process.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SECRET_HEADER = 'X-Quantum-Lab-Secret'
const UPSTREAM = 'http://localhost:8000'
const QASM = 'OPENQASM 3.0;\nqubit[2] q;\nh q[0];\ncx q[0], q[1];\n'

// ── the in-memory Supabase ──────────────────────────────────────────────────

interface UsageRow {
  id: string
  user_id: string
  backend: string
  shots: number
  provider: string | null
  job_id: string | null
  /** null | 'confirmed' | 'unmatched' — see supabase/schema-billing.sql. */
  settlement?: string | null
  created_at: string
}

const db = vi.hoisted(() => {
  interface Sub {
    user_id: string
    plan_id: string
    status: string
    current_period_end: string | null
    cancel_at_period_end: boolean
  }
  const state = {
    /** access token → user id. A token that is not here is not a session. */
    tokens: new Map<string, string>(),
    subscriptions: [] as Sub[],
    hardware_usage: [] as UsageRow[],
    /** When true every query fails — the "quota store is unreachable" case. */
    down: false,
    /**
     * When true, `rpc()` answers as PostgREST does for a function that is not
     * in the project: the state of any deployment that has not yet applied the
     * new supabase/schema-billing.sql.
     */
    noRpc: false,
    nextId: 1,
    /** Call counters, so a test can assert HOW the reservation was made. */
    rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
    directInserts: 0,
  }

  const REFUSED = { message: 'store unavailable' }

  function rows(table: string): Record<string, unknown>[] {
    if (table === 'subscriptions') return state.subscriptions as unknown as Record<string, unknown>[]
    if (table === 'hardware_usage')
      return state.hardware_usage as unknown as Record<string, unknown>[]
    return []
  }

  function table(name: string) {
    const q = {
      op: 'select' as 'select' | 'insert' | 'update' | 'delete',
      eqs: [] as Array<[string, unknown]>,
      gtes: [] as Array<[string, string]>,
      head: false,
      payload: null as Record<string, unknown> | null,
    }

    const matches = (row: Record<string, unknown>): boolean =>
      q.eqs.every(([col, val]) => row[col] === val) &&
      q.gtes.every(([col, val]) => String(row[col]) >= val)

    function run(mode: 'many' | 'single' | 'maybe'): Promise<unknown> {
      if (state.down) {
        return Promise.resolve({ data: null, error: REFUSED, count: null })
      }
      const all = rows(name)

      if (q.op === 'insert') {
        if (name === 'hardware_usage') state.directInserts += 1
        const row = {
          id: `row-${state.nextId++}`,
          provider: null,
          job_id: null,
          created_at: new Date().toISOString(),
          ...(q.payload ?? {}),
        }
        all.push(row)
        return Promise.resolve({ data: mode === 'many' ? [row] : row, error: null })
      }

      const hits = all.filter(matches)

      if (q.op === 'delete') {
        for (const hit of hits) all.splice(all.indexOf(hit), 1)
        return Promise.resolve({ data: hits, error: null })
      }
      if (q.op === 'update') {
        for (const hit of hits) Object.assign(hit, q.payload ?? {})
        return Promise.resolve({ data: hits, error: null })
      }
      if (q.head) return Promise.resolve({ data: null, error: null, count: hits.length })
      if (mode === 'single') return Promise.resolve({ data: hits[0] ?? null, error: null })
      if (mode === 'maybe') return Promise.resolve({ data: hits[0] ?? null, error: null })
      return Promise.resolve({ data: hits, error: null, count: hits.length })
    }

    const api = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.head) q.head = true
        return api
      },
      insert(payload: Record<string, unknown>) {
        q.op = 'insert'
        q.payload = payload
        return api
      },
      update(payload: Record<string, unknown>) {
        q.op = 'update'
        q.payload = payload
        return api
      },
      delete() {
        q.op = 'delete'
        return api
      },
      eq(col: string, val: unknown) {
        q.eqs.push([col, val])
        return api
      },
      gte(col: string, val: string) {
        q.gtes.push([col, val])
        return api
      },
      limit(_n: number) {
        return api
      },
      single: () => run('single'),
      maybeSingle: () => run('maybe'),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        run('many').then(resolve, reject),
    }
    return api
  }

  /**
   * `public.reserve_hardware_job`, emulated.
   *
   * IT IS EMULATED, and that bound is worth stating: this repository has never
   * had a Postgres to run against, so what these tests can prove is that the
   * app makes ONE call which counts and reserves together, and that it behaves
   * correctly on each answer that call can give. That the real function is
   * atomic under concurrent transactions is a property of its advisory lock,
   * and it is checked by verification query 3 at the bottom of
   * supabase/schema-billing.sql — by hand, against a live project.
   *
   * The emulation counts and inserts with no `await` between them, which is
   * exactly the property the SQL function buys and the property the old
   * insert-then-count path lacked.
   */
  function reserveHardwareJob(args: Record<string, unknown>) {
    const userId = args.p_user_id as string
    const limit = args.p_limit as number
    const periodStart = String(args.p_period_start)
    const used = state.hardware_usage.filter(
      (r) => r.user_id === userId && r.created_at >= periodStart
    ).length
    if (used >= limit) {
      return { data: [{ reserved: false, used, reservation_id: null }], error: null }
    }
    const row: UsageRow = {
      id: `row-${state.nextId++}`,
      user_id: userId,
      backend: String(args.p_backend ?? ''),
      shots: Number(args.p_shots ?? 0),
      provider: null,
      job_id: null,
      created_at: new Date().toISOString(),
    }
    state.hardware_usage.push(row)
    return { data: [{ reserved: true, used: used + 1, reservation_id: row.id }], error: null }
  }

  const client = {
    from: (name: string) => table(name),
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args })
      if (state.down) return { data: null, error: REFUSED }
      if (state.noRpc) {
        // PostgREST's shape for "no such function" — the un-migrated project.
        return {
          data: null,
          error: { code: 'PGRST202', message: 'Could not find the function in the schema cache' },
        }
      }
      if (name === 'reserve_hardware_job') return reserveHardwareJob(args)
      return { data: null, error: { code: 'PGRST202', message: 'unknown function' } }
    },
    auth: {
      getUser: async (token: string) => {
        const id = state.tokens.get(token)
        if (!id) return { data: { user: null }, error: { message: 'bad jwt' } }
        return { data: { user: { id, email: `${id}@example.test` } }, error: null }
      },
    },
  }

  return { state, client }
})

vi.mock('@supabase/supabase-js', () => ({ createClient: () => db.client }))
vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  getSupabase: () => db.client,
}))

// entitlements.ts reads these at module load, so they must be set before the
// dynamic imports below. A service-role key present is the configured state:
// without it the quota cannot be written and every submission is refused (which
// is asserted further down).
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.test'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'

const { __resetRateLimitForTests } = await import('@/lib/rateLimit')
const { POST: submitPOST } = await import('@/app/api/hardware/submit/route')
const { GET: jobGET } = await import('@/app/api/hardware/job/[provider]/[...jobId]/route')
const { GET: devicesGET } = await import('@/app/api/hardware/devices/route')

// ── helpers ─────────────────────────────────────────────────────────────────

let upstream: ReturnType<typeof vi.fn>

function stubUpstream(payload: unknown, status = 200): void {
  upstream = vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      })
  )
  vi.stubGlobal('fetch', upstream)
}

/** Headers of the Nth upstream call. */
function upstreamHeaders(index = 0): Record<string, string> {
  return (upstream.mock.calls[index]?.[1] as RequestInit).headers as Record<string, string>
}

let ip = 0
function submitRequest(token: string | null, body: Record<string, unknown> = {}): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // A fresh address per request so the IP limiter never colours a result.
    'x-forwarded-for': `198.51.100.${(ip++ % 200) + 1}`,
  }
  if (token) headers.authorization = `Bearer ${token}`
  return new Request('http://app.test/api/hardware/submit', {
    method: 'POST',
    headers,
    body: JSON.stringify({ qasm: QASM, backend: 'ibm_brisbane', shots: 1024, ...body }),
  })
}

function jobRequest(token: string | null): Request {
  const headers: Record<string, string> = { 'x-forwarded-for': `203.0.113.${(ip++ % 200) + 1}` }
  if (token) headers.authorization = `Bearer ${token}`
  return new Request('http://app.test/api/hardware/job/ibm/job-1', { headers })
}

/** A user with a plan and a session token. Returns the token. */
function signIn(userId: string, plan: 'free' | 'pro' | 'team' | null): string {
  const token = `jwt-${userId}`
  db.state.tokens.set(token, userId)
  if (plan && plan !== 'free') {
    db.state.subscriptions.push({
      user_id: userId,
      plan_id: plan,
      status: 'active',
      current_period_end: null,
      cancel_at_period_end: false,
    })
  }
  return token
}

/** Pre-load N used hardware jobs for a user in the current month. */
function usedJobs(userId: string, n: number): void {
  for (let i = 0; i < n; i += 1) {
    db.state.hardware_usage.push({
      id: `seed-${userId}-${i}`,
      user_id: userId,
      backend: 'ibm_brisbane',
      shots: 100,
      provider: 'ibm',
      job_id: `old-${i}`,
      created_at: new Date().toISOString(),
    })
  }
}

const usageRows = (userId: string): UsageRow[] =>
  db.state.hardware_usage.filter((r) => r.user_id === userId)

beforeEach(() => {
  db.state.tokens.clear()
  db.state.subscriptions.length = 0
  db.state.hardware_usage.length = 0
  db.state.down = false
  db.state.noRpc = false
  db.state.nextId = 1
  db.state.rpcCalls.length = 0
  db.state.directInserts = 0
  __resetRateLimitForTests()
  process.env.QUANTUM_API_SECRET = 'operator-secret'
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  stubUpstream({ job_id: 'job-1', provider: 'ibm', backend: 'ibm_brisbane', shots: 1024 })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete process.env.QUANTUM_API_SECRET
  __resetRateLimitForTests()
})

// ── the gate ────────────────────────────────────────────────────────────────

describe('POST /api/hardware/submit — identity', () => {
  it('REFUSES AN ANONYMOUS CALLER (the regression test)', async () => {
    const response = await submitPOST(submitRequest(null))

    expect(response.status).toBe(401)
    // The whole point: nothing left this process, so no job was enqueued and
    // the operator's shared secret was never presented on a stranger's behalf.
    expect(upstream).not.toHaveBeenCalled()
  })

  it('refuses a bearer token Supabase does not recognise', async () => {
    const response = await submitPOST(submitRequest('forged-token'))

    expect(response.status).toBe(401)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('takes identity from the token, never from the body', async () => {
    const pro = signIn('pro-user', 'pro')
    signIn('other-user', 'pro')

    await submitPOST(submitRequest(pro, { userId: 'other-user', user_id: 'other-user' }))

    // The usage row is charged to the token's owner, not to the id in the body.
    expect(usageRows('pro-user')).toHaveLength(1)
    expect(usageRows('other-user')).toHaveLength(0)
  })
})

describe('POST /api/hardware/submit — entitlement', () => {
  it('refuses a signed-in Free account: no hardware.real', async () => {
    const free = signIn('free-user', 'free')

    const response = await submitPOST(submitRequest(free))
    const body = (await response.json()) as { requiredPlan?: string; upgradeUrl?: string }

    expect(response.status).toBe(402)
    expect(body.requiredPlan).toBe('pro')
    expect(body.upgradeUrl).toBe('/pricing')
    expect(upstream).not.toHaveBeenCalled()
    // A refused submission must not consume a slot of anything.
    expect(usageRows('free-user')).toHaveLength(0)
  })

  it('refuses an account whose subscription is canceled, not just absent', async () => {
    const token = `jwt-lapsed`
    db.state.tokens.set(token, 'lapsed-user')
    db.state.subscriptions.push({
      user_id: 'lapsed-user',
      plan_id: 'pro',
      status: 'canceled',
      current_period_end: null,
      cancel_at_period_end: true,
    })

    const response = await submitPOST(submitRequest(token))

    expect(response.status).toBe(402)
    expect(upstream).not.toHaveBeenCalled()
  })
})

describe('POST /api/hardware/submit — quota', () => {
  it('refuses a Pro account that has spent its monthly allowance', async () => {
    const pro = signIn('busy-user', 'pro')
    usedJobs('busy-user', 50) // PLANS.pro.limits.hardwareJobsPerMonth

    const response = await submitPOST(submitRequest(pro))

    expect(response.status).toBe(402)
    expect(upstream).not.toHaveBeenCalled()
    // The reservation taken to make the count race-safe was handed back, so the
    // refusal itself did not cost the user a job.
    expect(usageRows('busy-user')).toHaveLength(50)
  })

  it('lets a Team account past the point where Pro would be refused', async () => {
    const team = signIn('team-user', 'team')
    usedJobs('team-user', 60)

    const response = await submitPOST(submitRequest(team))

    expect(response.status).toBe(200)
    expect(usageRows('team-user')).toHaveLength(61)
  })

  it('counts only the caller: one account cannot exhaust another', async () => {
    const a = signIn('user-a', 'pro')
    signIn('user-b', 'pro')
    usedJobs('user-b', 50)

    const response = await submitPOST(submitRequest(a))

    expect(response.status).toBe(200)
  })

  it('FAILS CLOSED when the quota store cannot answer', async () => {
    const pro = signIn('pro-user', 'pro')
    db.state.down = true

    const response = await submitPOST(submitRequest(pro))

    // 503, not 200. "Allow when unsure" on this route is an unbounded bill.
    expect(response.status).toBe(503)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('FAILS CLOSED when no service-role key is configured to write usage with', async () => {
    // Re-import the billing modules with the key absent: without it RLS denies
    // the insert, so nothing can be metered and nothing may be submitted.
    vi.resetModules()
    const saved = process.env.SUPABASE_SERVICE_ROLE_KEY
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    try {
      const { POST } = await import('@/app/api/hardware/submit/route')
      const pro = signIn('pro-user', 'pro')
      const response = await POST(submitRequest(pro))
      expect(response.status).toBe(503)
      expect(upstream).not.toHaveBeenCalled()
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = saved
      vi.resetModules()
    }
  })
})

describe('POST /api/hardware/submit — the happy path and the secret', () => {
  it('submits, attaches the secret, and records the job', async () => {
    const pro = signIn('pro-user', 'pro')

    const response = await submitPOST(submitRequest(pro, { shots: 2048 }))

    expect(response.status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(upstream.mock.calls[0]?.[0]).toBe(`${UPSTREAM}/api/hardware/submit`)
    // The secret leaves the process ONLY on this path.
    expect(upstreamHeaders()[SECRET_HEADER]).toBe('operator-secret')

    const rows = usageRows('pro-user')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.backend).toBe('ibm_brisbane')
    expect(rows[0]?.shots).toBe(2048)
    // Stamped with the provider handle — this is the ownership record.
    expect(rows[0]?.provider).toBe('ibm')
    expect(rows[0]?.job_id).toBe('job-1')
  })

  it('never attaches the secret for a caller that failed a check', async () => {
    const free = signIn('free-user', 'free')

    await submitPOST(submitRequest(null))
    await submitPOST(submitRequest('forged'))
    await submitPOST(submitRequest(free))
    db.state.down = true
    await submitPOST(submitRequest(signIn('pro-user', 'pro')))

    expect(upstream).not.toHaveBeenCalled()
  })

  it('gives the allowance back when the upstream refuses the job', async () => {
    const pro = signIn('pro-user', 'pro')
    stubUpstream({ detail: 'backend ibm_brisbane is not available.' }, 400)

    const response = await submitPOST(submitRequest(pro))

    expect(response.status).toBe(400)
    // No job exists, so no job may be charged against the month.
    expect(usageRows('pro-user')).toHaveLength(0)
  })

  it('gives the allowance back when the upstream cannot be reached', async () => {
    const pro = signIn('pro-user', 'pro')
    vi.stubGlobal(
      'fetch',
      (upstream = vi.fn(async () => {
        throw new TypeError('fetch failed')
      }))
    )

    const response = await submitPOST(submitRequest(pro))

    expect(response.status).toBe(504)
    expect(usageRows('pro-user')).toHaveLength(0)
  })

  it('keeps the usage row when the upstream times out, because the job may be enqueued', async () => {
    const pro = signIn('pro-user', 'pro')
    vi.stubGlobal(
      'fetch',
      (upstream = vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError')
      }))
    )

    const response = await submitPOST(submitRequest(pro))

    expect(response.status).toBe(504)
    const body = (await response.json()) as { unknownOutcome?: boolean }
    expect(body.unknownOutcome).toBe(true)
    // Not refunded: a free vendor job would otherwise be one timeout away.
    expect(usageRows('pro-user')).toHaveLength(1)
  })

  it('still refuses a malformed body from a paying caller, before any billing', async () => {
    const pro = signIn('pro-user', 'pro')

    const response = await submitPOST(submitRequest(pro, { shots: 20_001 }))

    expect(response.status).toBe(400)
    expect(usageRows('pro-user')).toHaveLength(0)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('bounds a single account even when it rotates its address', async () => {
    const pro = signIn('pro-user', 'pro')

    const codes: number[] = []
    for (let i = 0; i < 7; i += 1) {
      // Every call comes from a different IP, so only the per-ACCOUNT bucket
      // can refuse it.
      codes.push((await submitPOST(submitRequest(pro))).status)
    }

    expect(codes.filter((c) => c === 200)).toHaveLength(5)
    expect(codes.filter((c) => c === 429)).toHaveLength(2)
  })
})

// ── the atomic reservation ──────────────────────────────────────────────────
//
// STATUS.md carried this as a known open bug: "a reservation row is inserted
// before the count is read, so sequential submits cannot both pass, but two
// genuinely simultaneous ones can". These tests pin the shape of the fix. What
// they can and cannot prove is written out on the `reserve_hardware_job`
// emulation above — read that before trusting this section further than it
// goes.

describe('POST /api/hardware/submit — the quota is reserved atomically', () => {
  it('counts and reserves in ONE call, not insert-then-count', async () => {
    const pro = signIn('pro-user', 'pro')

    const response = await submitPOST(submitRequest(pro))

    expect(response.status).toBe(200)
    const reserve = db.state.rpcCalls.filter((c) => c.name === 'reserve_hardware_job')
    expect(reserve).toHaveLength(1)
    // The old path's fingerprint: a bare INSERT into hardware_usage from the
    // application. If this is ever non-zero again on the happy path, the race
    // is back — the whole point is that the count and the insert are one
    // indivisible decision taken inside Postgres.
    expect(db.state.directInserts).toBe(0)
    // The limit is passed in, so the function never has to know about plans,
    // and the window is passed in, so it never has to know about billing
    // anchors. Both are the caller's job; see lib/billing/period.ts.
    expect(reserve[0]?.args.p_limit).toBe(50)
    expect(reserve[0]?.args.p_user_id).toBe('pro-user')
  })

  it('refuses without writing anything when the allowance is spent', async () => {
    const pro = signIn('busy-user', 'pro')
    usedJobs('busy-user', 50)

    const response = await submitPOST(submitRequest(pro))

    expect(response.status).toBe(402)
    // The old path INSERTED and then deleted the row again. A refusal that
    // writes nothing cannot lose a slot to a failed rollback.
    expect(usageRows('busy-user')).toHaveLength(50)
    expect(db.state.directInserts).toBe(0)
  })

  it('grants the 50th job of an advertised 50', async () => {
    // The old flow fed a count that INCLUDED the just-inserted row into
    // `canRunHardware`, which refuses at `used >= limit` — so Pro delivered 49
    // of the 50 jobs the pricing page sells. The function counts before it
    // inserts and does not have the off-by-one.
    const pro = signIn('pro-user', 'pro')
    usedJobs('pro-user', 49)

    const response = await submitPOST(submitRequest(pro))

    expect(response.status).toBe(200)
    expect(usageRows('pro-user')).toHaveLength(50)
  })

  it('admits exactly one of two simultaneous submissions at the last slot', async () => {
    const pro = signIn('edge-user', 'pro')
    usedJobs('edge-user', 49)

    // Both requests are in flight before either finishes. Under the old
    // insert-then-count path both inserts landed before either count ran and
    // both were admitted — 51 rows against an allowance of 50.
    const [a, b] = await Promise.all([
      submitPOST(submitRequest(pro)),
      submitPOST(submitRequest(pro)),
    ])

    const codes = [a.status, b.status].sort()
    expect(codes).toEqual([200, 402])
    expect(usageRows('edge-user')).toHaveLength(50)
  })

  it('counts the billing window, not the calendar month', async () => {
    // A subscription anchored on the 20th. Jobs run before the 20th of this
    // month belong to the PREVIOUS window and must not count against this one —
    // under a calendar month they would, and the customer would be refused
    // partway through a period they have paid for.
    const token = 'jwt-anchored'
    db.state.tokens.set(token, 'anchored-user')
    const now = new Date()
    const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 20, 12, 0, 0))
    const inWindow = anchor.getTime() <= now.getTime()
    db.state.subscriptions.push({
      user_id: 'anchored-user',
      plan_id: 'pro',
      status: 'active',
      current_period_end: anchor.toISOString(),
      cancel_at_period_end: false,
    })
    // 50 jobs, all stamped a full year ago: inside no plausible current window
    // under either rule, but inside the same CALENDAR month-of-year.
    for (let i = 0; i < 50; i += 1) {
      db.state.hardware_usage.push({
        id: `old-${i}`,
        user_id: 'anchored-user',
        backend: 'ibm_brisbane',
        shots: 100,
        provider: 'ibm',
        job_id: `j-${i}`,
        created_at: new Date(now.getTime() - 365 * 24 * 3600_000).toISOString(),
      })
    }

    const response = await submitPOST(submitRequest(token))

    expect(response.status).toBe(200)
    const reserve = db.state.rpcCalls.find((c) => c.name === 'reserve_hardware_job')
    // The window start handed to Postgres is the anchor, not the 1st.
    const periodStart = new Date(String(reserve?.args.p_period_start))
    expect(periodStart.getUTCDate()).toBe(20)
    expect(periodStart.getTime()).toBeLessThanOrEqual(now.getTime())
    if (inWindow) expect(periodStart.getUTCMonth()).toBe(now.getUTCMonth())
  })
})

describe('POST /api/hardware/submit — a project that has not applied the SQL', () => {
  it('falls back to insert-then-count and still enforces the limit', async () => {
    // The function is only in the database once an operator runs
    // supabase/schema-billing.sql. Until then the gate must keep working — the
    // race it closes is smaller than the outage of refusing every paying
    // customer — and it must still refuse a spent allowance.
    db.state.noRpc = true
    const pro = signIn('busy-user', 'pro')
    usedJobs('busy-user', 50)

    const response = await submitPOST(submitRequest(pro))

    expect(response.status).toBe(402)
    expect(upstream).not.toHaveBeenCalled()
    // The legacy path claims a row and hands it back on refusal, so the count
    // is where it started.
    expect(usageRows('busy-user')).toHaveLength(50)
    expect(db.state.directInserts).toBe(1)
  })

  it('still submits for a caller who is under the limit', async () => {
    db.state.noRpc = true
    const pro = signIn('pro-user', 'pro')

    const response = await submitPOST(submitRequest(pro))

    expect(response.status).toBe(200)
    expect(usageRows('pro-user')).toHaveLength(1)
    expect(usageRows('pro-user')[0]?.job_id).toBe('job-1')
  })
})

describe('POST /api/hardware/submit — 2xx with no job id', () => {
  it('keeps the usage row, marks it unmatched, and refuses to claim success', async () => {
    const pro = signIn('pro-user', 'pro')
    // The upstream accepted (2xx) and returned nothing to poll. The job may be
    // running and may be billed for.
    stubUpstream({ backend: 'ibm_brisbane', shots: 1024 }, 200)

    const response = await submitPOST(submitRequest(pro))
    const body = (await response.json()) as { detail?: string; unpollable?: boolean }

    // NOT a pass-through 2xx: the browser types this body as SubmittedJob and
    // would start a monitor on `undefined`.
    expect(response.status).toBe(502)
    expect(body.unpollable).toBe(true)
    expect(body.detail).toMatch(/did not return a job id/i)

    // The row STAYS — refunding allowance for spend we cannot rule out is the
    // expensive direction — and it is findable by an operator.
    const rows = usageRows('pro-user')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.settlement).toBe('unmatched')
    expect(rows[0]?.job_id).toBeNull()
  })

  it('treats a 2xx whose body will not parse the same way', async () => {
    const pro = signIn('pro-user', 'pro')
    vi.stubGlobal(
      'fetch',
      (upstream = vi.fn(
        async () =>
          new Response('not json', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      ))
    )

    const response = await submitPOST(submitRequest(pro))

    // This used to fall into the same branch as "upstream refused" and hand the
    // allowance back, which is a refund for a job that may well be running.
    expect(response.status).toBe(502)
    expect(usageRows('pro-user')[0]?.settlement).toBe('unmatched')
  })
})

// ── job ownership ───────────────────────────────────────────────────────────

describe('GET /api/hardware/job — ownership', () => {
  async function submitAs(token: string): Promise<void> {
    const response = await submitPOST(submitRequest(token))
    expect(response.status).toBe(200)
  }

  it('refuses an anonymous poll: results are the submitter’s data', async () => {
    const response = await jobGET(jobRequest(null), {
      params: Promise.resolve({ provider: 'ibm', jobId: ['job-1'] }),
    })

    expect(response.status).toBe(401)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('lets the submitter poll their own job', async () => {
    const pro = signIn('pro-user', 'pro')
    await submitAs(pro)
    upstream.mockClear()

    const response = await jobGET(jobRequest(pro), {
      params: Promise.resolve({ provider: 'ibm', jobId: ['job-1'] }),
    })

    expect(response.status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('answers 404 for somebody else’s job id, and says nothing more', async () => {
    const owner = signIn('owner', 'pro')
    const stranger = signIn('stranger', 'pro')
    await submitAs(owner)
    upstream.mockClear()

    const response = await jobGET(jobRequest(stranger), {
      params: Promise.resolve({ provider: 'ibm', jobId: ['job-1'] }),
    })

    expect(response.status).toBe(404)
    // Identical body to an id that never existed, so this is not an oracle.
    expect(await response.text()).toBe('{"detail":"No such job."}')
    expect(upstream).not.toHaveBeenCalled()
  })

  it('answers the same 404 for an id nobody ever submitted', async () => {
    const pro = signIn('pro-user', 'pro')

    const response = await jobGET(jobRequest(pro), {
      params: Promise.resolve({ provider: 'ibm', jobId: ['never-existed'] }),
    })

    expect(response.status).toBe(404)
    expect(await response.text()).toBe('{"detail":"No such job."}')
  })

  it('does not confuse the same id under a different provider', async () => {
    const pro = signIn('pro-user', 'pro')
    await submitAs(pro)
    upstream.mockClear()

    const response = await jobGET(jobRequest(pro), {
      params: Promise.resolve({ provider: 'braket', jobId: ['job-1'] }),
    })

    expect(response.status).toBe(404)
  })

  it('binds and re-encodes a Braket ARN across the catch-all segment', async () => {
    const arn = 'arn:aws:braket:us-east-1:123456789012:quantum-task/abc-123'
    const pro = signIn('pro-user', 'pro')
    stubUpstream({ job_id: arn, provider: 'braket', backend: 'sv1', shots: 1024 })
    await submitAs(pro)

    // Stored exactly as upstream reported it, slashes and all — that string is
    // what the poll has to reconstruct from its path segments to match.
    expect(usageRows('pro-user')[0]?.job_id).toBe(arn)

    stubUpstream({ status: 'COMPLETED' })
    const response = await jobGET(jobRequest(pro), {
      params: Promise.resolve({
        provider: 'braket',
        jobId: ['arn:aws:braket:us-east-1:123456789012:quantum-task', 'abc-123'],
      }),
    })

    expect(response.status).toBe(200)
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `${UPSTREAM}/api/hardware/job/braket/` +
        'arn%3Aaws%3Abraket%3Aus-east-1%3A123456789012%3Aquantum-task/abc-123'
    )
  })

  it('FAILS CLOSED when ownership cannot be checked', async () => {
    const pro = signIn('pro-user', 'pro')
    await submitAs(pro)
    upstream.mockClear()
    db.state.down = true

    const response = await jobGET(jobRequest(pro), {
      params: Promise.resolve({ provider: 'ibm', jobId: ['job-1'] }),
    })

    // An outage is not a reason to publish a stranger's measurement results.
    expect(response.status).toBe(503)
    expect(upstream).not.toHaveBeenCalled()
  })
})

// ── the endpoints that are deliberately still open ──────────────────────────

describe('the free endpoints stay free', () => {
  it('lists devices for a signed-out visitor', async () => {
    stubUpstream([{ id: 'ibm_brisbane' }])

    const response = await devicesGET(
      new Request('http://app.test/api/hardware/devices', {
        headers: { 'x-forwarded-for': '192.0.2.7' },
      })
    )

    // No vendor spend, no user data, and it is what the page renders before
    // anyone decides to upgrade. See the route file for the full reasoning.
    expect(response.status).toBe(200)
  })
})
