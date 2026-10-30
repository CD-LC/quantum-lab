/**
 * reconcile.test.ts — the background sweep, and the four ways it could be
 * worse than not having it at all.
 *
 * FAKED: the service-role Supabase client and `lib/hardware/proxy`'s upstream
 * call. REAL: every decision this module makes — which rows it asks for, what
 * it is willing to write onto them, what it reports about the rows it did not
 * reach, and who the route lets in.
 *
 * The failures these tests exist to catch, each of which is silent:
 *
 *  1. A capped batch reported as a finished one. "polled 50, everything is
 *     reconciled" while nine hundred rows sit untouched is worse than no
 *     sweep, because it is a sweep an operator believes.
 *  2. A queued poll erasing a finished job's counts. The sweep runs
 *     unattended over every account's rows, so the blast radius of a null
 *     written over a histogram is the whole table, and nobody is watching.
 *  3. A cron endpoint that runs for a caller with the wrong secret — or, the
 *     classic, that runs for EVERYONE because the secret was never configured
 *     and an empty string compares equal to an empty header.
 *  4. Two overlapping passes both spending a vendor round trip on the same
 *     job, and the slower one dragging a finished job back to `queued`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeUpdate {
  /** The row id the update was aimed at. */
  id: string
  /** Exactly the columns the sweep was willing to write. */
  patch: Record<string, unknown>
  /** Whether the write was guarded to rows that are still non-terminal. */
  guarded: boolean
}

const fake = vi.hoisted(() => {
  const state = {
    serviceRole: true,
    /** Rows the select will hand back, oldest-first as the query asks for. */
    rows: [] as Array<Record<string, unknown>>,
    /** What the exact-count head request answers. Null means "refused". */
    eligible: null as number | null,
    selectError: null as { message: string } | null,
    updates: [] as FakeUpdate[],
    /** False makes every guarded update match zero rows — the race. */
    updateMatches: true,
    /** Set to make every UPDATE come back as a Postgres error. */
    updateError: null as { message: string } | null,
    /** Upstream payload per job id. A missing entry is a 404. */
    payloads: new Map<string, Record<string, unknown>>(),
    /** Every upstream path the sweep asked for, in order. */
    polls: [] as string[],
    /** The credential (if any) presented on each poll, parallel to `polls`. */
    pollCredentials: [] as unknown[],
    /** Stored BYOK credentials by `userId:provider`. Missing means none. */
    credentials: new Map<string, { provider: string; secret: string }>(),
    /** Makes opening a BYOK credential throw (store outage). */
    credentialStoreDown: false,
    /** Resolves a poll only when released, so overlap can be staged. */
    gate: null as null | Promise<void>,
  }

  function client() {
    return {
      from() {
        const q = {
          head: false,
          mode: 'select' as 'select' | 'update',
          patch: {} as Record<string, unknown>,
          id: '',
          guarded: false,
          limit: Number.POSITIVE_INFINITY,
        }
        const builder = {
          select(_columns?: string, options?: { head?: boolean; count?: string }) {
            if (options?.head) q.head = true
            return builder
          },
          // `.update(...).select('id')` asks for the changed rows back, which
          // is how the sweep tells a landed write from one the guard blocked;
          // `state.updateMatches` is what stages the blocked case.
          update(patch: Record<string, unknown>) {
            q.mode = 'update'
            q.patch = patch
            return builder
          },
          not() {
            return builder
          },
          or(expression: string) {
            // The only `or` on an update is the non-terminal guard.
            if (q.mode === 'update' && expression.includes('status.in.(queued,running)')) {
              q.guarded = true
            }
            return builder
          },
          lt() {
            return builder
          },
          gt() {
            return builder
          },
          eq(_column: string, value: string) {
            q.id = value
            return builder
          },
          order() {
            return builder
          },
          limit(n: number) {
            q.limit = n
            return builder
          },
          then(resolve: (value: unknown) => void) {
            if (q.mode === 'update') {
              state.updates.push({ id: q.id, patch: q.patch, guarded: q.guarded })
              if (state.updateError) {
                resolve({ data: null, error: state.updateError })
                return
              }
              resolve({ data: state.updateMatches ? [{ id: q.id }] : [], error: null })
              return
            }
            if (q.head) {
              resolve({ count: state.eligible, error: state.selectError, data: null })
              return
            }
            resolve({
              data: state.selectError ? null : state.rows.slice(0, q.limit),
              error: state.selectError,
            })
          },
        }
        return builder
      },
    }
  }

  return { state, client }
})

vi.mock('@/lib/billing/entitlements', () => ({
  get isServiceRoleConfigured() {
    return fake.state.serviceRole
  },
  getServiceSupabase: () => (fake.state.serviceRole ? fake.client() : null),
}))

vi.mock('@/lib/hardware/proxy', () => ({
  async forward(path: string, _body?: unknown, _method?: string, credential?: unknown) {
    fake.state.polls.push(path)
    fake.state.pollCredentials.push(credential ?? null)
    if (fake.state.gate) await fake.state.gate
    const jobId = decodeURIComponent(path.split('/').slice(5).join('/'))
    const payload = fake.state.payloads.get(jobId)
    if (!payload) return new Response(JSON.stringify({ detail: 'No such job.' }), { status: 404 })
    return new Response(JSON.stringify(payload), { status: 200 })
  },
  async forwardedJson(response: Response) {
    if (response.status < 200 || response.status >= 300) return null
    return (await response.clone().json()) as Record<string, unknown>
  },
}))

vi.mock('@/lib/hardware/byok', () => ({
  async resolveSubmissionCredential(userId: string, provider: string) {
    if (fake.state.credentialStoreDown) throw new Error('credential store down')
    return fake.state.credentials.get(`${userId}:${provider}`) ?? null
  },
}))

const { reconcileHardwareJobs, __resetReconcileForTests } = await import(
  '@/lib/hardware/reconcile'
)
const { POST } = await import('@/app/api/hardware/reconcile/route')
const { __resetRateLimitForTests } = await import('@/lib/rateLimit')

const SECRET = 'hardware-reconcile-secret-for-tests-0123456789'

/** A row as PostgREST would hand it back. Old enough to be past the grace. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'row-1',
    user_id: '11111111-1111-4111-8111-111111111111',
    provider: 'ibm',
    job_id: 'cxyz123abc',
    status: null,
    created_at: new Date(Date.now() - 3_600_000).toISOString(),
    ...overrides,
  }
}

beforeEach(() => {
  fake.state.serviceRole = true
  fake.state.rows = []
  fake.state.eligible = null
  fake.state.selectError = null
  fake.state.updates = []
  fake.state.updateMatches = true
  fake.state.updateError = null
  fake.state.payloads = new Map()
  fake.state.polls = []
  fake.state.pollCredentials = []
  fake.state.credentials = new Map()
  fake.state.credentialStoreDown = false
  fake.state.gate = null
  __resetReconcileForTests()
  __resetRateLimitForTests()
  process.env.HARDWARE_RECONCILE_SECRET = SECRET
})

afterEach(() => {
  delete process.env.HARDWARE_RECONCILE_SECRET
})

describe('the batch bound', () => {
  it('reports the rows it did NOT reach, rather than implying it reached them', async () => {
    // The failure this catches: a capped pass that looks finished. An operator
    // reading `polled: 3` with no `remaining` has no way to know that 897 rows
    // are still saying `queued` from three weeks ago.
    fake.state.eligible = 900
    fake.state.rows = [
      row({ id: 'a', job_id: 'job-a' }),
      row({ id: 'b', job_id: 'job-b' }),
      row({ id: 'c', job_id: 'job-c' }),
    ]
    for (const id of ['job-a', 'job-b', 'job-c']) {
      fake.state.payloads.set(id, { status: 'queued' })
    }

    const report = await reconcileHardwareJobs({ limit: 3 })

    expect(report.claimed).toBe(3)
    expect(report.polled).toBe(3)
    expect(report.remaining).toBe(897)
    expect(report.stoppedBecause).toBe('batch_limit')
    expect(report.note).toContain('897')
  })

  it('says remaining is unknown when the eligibility count was refused', async () => {
    // A zero here would be a lie of exactly the kind this module is meant to
    // stop: "nothing left" and "we could not ask" are opposite facts.
    fake.state.eligible = null
    fake.state.rows = [row({ id: 'a', job_id: 'job-a' })]
    fake.state.payloads.set('job-a', { status: 'running' })

    const report = await reconcileHardwareJobs({ limit: 10 })

    expect(report.remaining).toBeNull()
    expect(report.note).toContain('unknown')
  })

  it('clamps an absurd limit instead of asking Postgres for everything', async () => {
    fake.state.eligible = 0
    const report = await reconcileHardwareJobs({ limit: 10_000_000 })
    expect(report.claimed).toBe(0)
    expect(report.stoppedBecause).toBe('complete')
  })

  it('still says batch_limit on a FULL batch when the eligibility count was refused', async () => {
    // The regression this pins. `stoppedBecause` used to be decided by
    // `eligible > rawRows.length` alone, and `eligible` is null whenever the
    // count query is refused — so a pass that came back with a completely full
    // page, the definitive sign that there is more, answered `complete` with
    // the note "The eligible snapshot was exhausted." while `remaining` was
    // null. That is the exact lie this module exists to prevent, told about
    // itself: an operator watching a database under load would read "nothing
    // left" on every pass while the backlog grew.
    fake.state.eligible = null
    fake.state.rows = [
      row({ id: 'a', job_id: 'job-a' }),
      row({ id: 'b', job_id: 'job-b' }),
    ]
    for (const id of ['job-a', 'job-b']) fake.state.payloads.set(id, { status: 'running' })

    const report = await reconcileHardwareJobs({ limit: 2 })

    expect(report.claimed).toBe(2)
    expect(report.stoppedBecause).toBe('batch_limit')
    expect(report.remaining).toBeNull()
    expect(report.note).not.toContain('exhausted')
  })

  it('stops at the wall-clock budget and reports the rows it never reached', async () => {
    // Without this the deadline path was entirely untested: a pass killed
    // mid-sweep would have reported `complete`, and the rows it never looked
    // at would have been counted as reconciled.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      fake.state.eligible = 5
      fake.state.rows = [
        row({ id: 'a', job_id: 'job-a' }),
        row({ id: 'b', job_id: 'job-b' }),
      ]
      for (const id of ['job-a', 'job-b']) fake.state.payloads.set(id, { status: 'done' })

      let release = (): void => {}
      fake.state.gate = new Promise<void>((resolve) => {
        release = resolve
      })

      const pass = reconcileHardwareJobs({ concurrency: 1, deadlineMs: 1_000 })
      await new Promise((resolve) => setTimeout(resolve, 0))
      // The first poll is still in flight when the budget expires.
      vi.setSystemTime(Date.now() + 30_000)
      release()
      const report = await pass

      expect(report.polled).toBe(1)
      expect(report.stoppedBecause).toBe('deadline')
      // 5 eligible, 1 attempted — the other four are still owed.
      expect(report.remaining).toBe(4)
      expect(fake.state.polls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let an injected `now` silently disable the pass', async () => {
    // `now` shifts the eligibility window only. It used to anchor the deadline
    // too, so a caller passing a fixed epoch produced a deadline in the past:
    // the sweep polled nothing, answered `deadline`, and read as a healthy
    // sweep against a slow upstream.
    fake.state.eligible = 1
    fake.state.rows = [row({ id: 'a', job_id: 'job-a' })]
    fake.state.payloads.set('job-a', { status: 'done' })

    const report = await reconcileHardwareJobs({ now: 1_700_000_000_000 })

    expect(report.polled).toBe(1)
    expect(report.stoppedBecause).not.toBe('deadline')
  })
})

describe('what a poll is allowed to write', () => {
  it('a queued poll writes ONLY the status — never a null over counts', async () => {
    // The one way this module could destroy the data it exists to preserve.
    // `recordHardwareResult` in lib/billing/usage.ts has the same rule and the
    // same comment; if either loses it, a nightly sweep blanks every finished
    // job it revisits.
    fake.state.eligible = 1
    fake.state.rows = [row({ id: 'queued-row', job_id: 'job-q' })]
    fake.state.payloads.set('job-q', {
      status: 'queued',
      counts: null,
      error: null,
      qpu_seconds: null,
    })

    await reconcileHardwareJobs()

    expect(fake.state.updates).toHaveLength(1)
    const [update] = fake.state.updates
    expect(Object.keys(update.patch).sort()).toEqual(['status'])
    expect(update.patch).not.toHaveProperty('counts')
    expect(update.patch).not.toHaveProperty('completed_at')
  })

  it('a finished poll writes the histogram, the QPU seconds and completed_at', async () => {
    fake.state.eligible = 1
    fake.state.rows = [row({ id: 'done-row', job_id: 'job-d', status: 'running' })]
    fake.state.payloads.set('job-d', {
      status: 'done',
      counts: { '00': 501, '11': 523 },
      qpu_seconds: 2.5,
      backend: 'ibm_kyiv',
    })

    const report = await reconcileHardwareJobs()

    const [update] = fake.state.updates
    expect(update.patch.status).toBe('done')
    expect(update.patch.counts).toEqual({ '00': 501, '11': 523 })
    expect(update.patch.qpu_seconds).toBe(2.5)
    // The device it actually RAN on, which IBM can change mid-queue.
    expect(update.patch.backend).toBe('ibm_kyiv')
    expect(typeof update.patch.completed_at).toBe('string')
    expect(report.finished).toBe(1)
  })

  it('refuses a malformed histogram rather than storing it in the jsonb column', async () => {
    // An array would be stored perfectly happily by Postgres and then break
    // every reader of the history panel and the CSV export.
    fake.state.eligible = 1
    fake.state.rows = [row({ id: 'bad-counts', job_id: 'job-b' })]
    fake.state.payloads.set('job-b', { status: 'done', counts: ['00', '11'] })

    await reconcileHardwareJobs()

    expect(fake.state.updates[0].patch).not.toHaveProperty('counts')
    expect(fake.state.updates[0].patch.status).toBe('done')
  })

  it('issues NO write when the job has not moved, and does not count it as work', async () => {
    // The number that would otherwise lie. Fifty jobs stuck in IBM's queue for
    // a week are re-polled on every tick; writing `status = 'queued'` over a
    // row that already says `queued` would report fifty reconciliations a
    // minute, forever, for a table in which nothing is changing at all. The
    // row is still counted as POLLED, so the sweep cannot read as idle either.
    fake.state.eligible = 1
    fake.state.rows = [row({ id: 'stuck', job_id: 'job-s', status: 'queued' })]
    fake.state.payloads.set('job-s', { status: 'queued' })

    const report = await reconcileHardwareJobs()

    expect(fake.state.updates).toHaveLength(0)
    expect(report.unchanged).toBe(1)
    expect(report.updated).toBe(0)
    expect(report.polled).toBe(1)
  })

  it('DOES write when a never-polled row first reports queued', async () => {
    // The other side of the same branch: null and 'queued' are different
    // claims, and collapsing them would leave the history panel rendering
    // "never checked" for a job the sweep has in fact observed.
    fake.state.eligible = 1
    fake.state.rows = [row({ id: 'fresh', job_id: 'job-f', status: null })]
    fake.state.payloads.set('job-f', { status: 'queued' })

    const report = await reconcileHardwareJobs()

    expect(fake.state.updates).toHaveLength(1)
    expect(fake.state.updates[0].patch.status).toBe('queued')
    expect(report.updated).toBe(1)
  })

  it('refuses to store a status outside the five normalised states', async () => {
    // The trap: the sweep's own SELECT asks for null/queued/running. Writing
    // anything else makes the row invisible to this sweep for good WITHOUT
    // making it terminal — the job would never be swept again, never finish,
    // and `isTerminalStatus` would keep calling it live.
    fake.state.eligible = 1
    fake.state.rows = [row({ id: 'weird', job_id: 'job-w' })]
    fake.state.payloads.set('job-w', { status: 'INITIALIZING' })

    const report = await reconcileHardwareJobs()

    expect(fake.state.updates).toHaveLength(0)
    expect(report.skippedUnknownStatus).toBe(1)
    expect(report.updated).toBe(0)
    expect(report.note).toContain('five normalised states')
  })

  it('leaves the row completely alone when the upstream cannot answer', async () => {
    // A vendor 404 and an upstream that is misconfigured for five minutes look
    // identical from here, so neither is written down as an error.
    fake.state.eligible = 1
    fake.state.rows = [row({ id: 'gone', job_id: 'job-gone' })]

    const report = await reconcileHardwareJobs()

    expect(fake.state.updates).toHaveLength(0)
    expect(report.unreachable).toBe(1)
    expect(report.updated).toBe(0)
  })

  it('skips a row whose job handle could not aim a request anywhere', async () => {
    // Traversal defence on data from our own table: `..` in a stamped handle
    // would point `forward` — which carries the operator's shared secret — at
    // an upstream path this proxy deliberately does not expose.
    fake.state.eligible = 2
    fake.state.rows = [
      row({ id: 'evil', job_id: '../../circuits/run' }),
      row({ id: 'fine', job_id: 'job-ok' }),
    ]
    fake.state.payloads.set('job-ok', { status: 'done' })

    const report = await reconcileHardwareJobs()

    expect(report.skippedMalformed).toBe(1)
    expect(fake.state.polls.every((path) => !path.includes('..'))).toBe(true)
    expect(fake.state.updates.map((u) => u.id)).toEqual(['fine'])
  })
})

describe('BYOK jobs', () => {
  const OWNER = '22222222-2222-4222-8222-222222222222'

  it('polls a user-funded job with its owner\'s stored credential, not the operator\'s', async () => {
    fake.state.eligible = 2
    fake.state.rows = [
      row({ id: 'byok-row', job_id: 'job-byok', user_id: OWNER, credential_owner: 'user' }),
      row({ id: 'op-row', job_id: 'job-op', credential_owner: 'operator' }),
    ]
    const stored = { provider: 'ibm', secret: 'ibm-token' }
    fake.state.credentials.set(`${OWNER}:ibm`, stored)
    fake.state.payloads.set('job-byok', { status: 'running' })
    fake.state.payloads.set('job-op', { status: 'running' })

    const report = await reconcileHardwareJobs()

    expect(report.updated).toBe(2)
    const byPath = new Map(fake.state.polls.map((p, i) => [p, fake.state.pollCredentials[i]]))
    expect(byPath.get('/api/hardware/job/ibm/job-byok')).toBe(stored)
    expect(byPath.get('/api/hardware/job/ibm/job-op')).toBeNull()
  })

  it('counts a BYOK job unreachable, and never falls back to the operator token, when the credential is gone', async () => {
    fake.state.eligible = 1
    fake.state.rows = [
      row({ id: 'byok-row', job_id: 'job-byok', user_id: OWNER, credential_owner: 'user' }),
    ]
    fake.state.payloads.set('job-byok', { status: 'done' })

    const report = await reconcileHardwareJobs()

    expect(report.unreachable).toBe(1)
    expect(fake.state.polls).toHaveLength(0)
    expect(fake.state.updates).toHaveLength(0)
  })

  it('counts a BYOK job unreachable when the credential store is down', async () => {
    fake.state.eligible = 1
    fake.state.credentialStoreDown = true
    fake.state.rows = [
      row({ id: 'byok-row', job_id: 'job-byok', user_id: OWNER, credential_owner: 'user' }),
    ]
    fake.state.payloads.set('job-byok', { status: 'done' })

    const report = await reconcileHardwareJobs()

    expect(report.unreachable).toBe(1)
    expect(fake.state.polls).toHaveLength(0)
  })
})

describe('estimator jobs', () => {
  it('reconciles status only, and SAYS it did, because labels are not stored', async () => {
    // Inventing positional labels would produce a record that looks like a
    // result and cannot be matched back to the Hamiltonian terms it came from.
    fake.state.eligible = 1
    fake.state.rows = [row({ id: 'est', job_id: 'job-est' })]
    fake.state.payloads.set('job-est', {
      status: 'done',
      primitive: 'estimator',
      expectation_values: [{ label: '0', value: -1.117 }],
    })

    const report = await reconcileHardwareJobs()

    expect(report.estimatorWithoutLabels).toBe(1)
    expect(report.note).toContain('observable labels are not stored')
    // Status yes, values no — there is nowhere honest to put them.
    expect(fake.state.updates[0].patch.status).toBe('done')
    expect(fake.state.updates[0].patch).not.toHaveProperty('expectation_values')
  })
})

describe('two overlapping passes', () => {
  it('guards every write to rows that are still non-terminal', async () => {
    // Without the guard, a slow pass that saw `queued` writes that over the
    // `done` a faster pass has already recorded, and the job goes backwards.
    fake.state.eligible = 1
    fake.state.rows = [row({ id: 'r', job_id: 'job-r' })]
    fake.state.payloads.set('job-r', { status: 'queued' })

    await reconcileHardwareJobs()

    expect(fake.state.updates[0].guarded).toBe(true)
  })

  it('counts a write the guard blocked as raced, not as an update', async () => {
    // The number that would otherwise lie: a sweep racing another sweep would
    // report every blocked write as a successful reconciliation, so two crons
    // fighting each other would look like twice the work being done.
    fake.state.eligible = 1
    fake.state.updateMatches = false
    fake.state.rows = [row({ id: 'r', job_id: 'job-r' })]
    fake.state.payloads.set('job-r', { status: 'queued' })

    const report = await reconcileHardwareJobs()

    expect(report.raced).toBe(1)
    expect(report.updated).toBe(0)
    expect(report.finished).toBe(0)
  })

  it('does not spend two vendor round trips on the same job in one process', async () => {
    fake.state.eligible = 1
    fake.state.rows = [row({ id: 'r', job_id: 'job-r' })]
    fake.state.payloads.set('job-r', { status: 'done' })

    // Hold the first pass inside its poll, start a second, then release.
    let release = (): void => {}
    fake.state.gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = reconcileHardwareJobs()
    // Let the first pass reach the gate before the second pass claims the row.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = reconcileHardwareJobs()
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    const [a, b] = await Promise.all([first, second])

    expect(fake.state.polls).toHaveLength(1)
    expect(a.polled + b.polled).toBe(1)
    expect(a.skippedInFlight + b.skippedInFlight).toBe(1)
    expect(fake.state.updates).toHaveLength(1)
  })
})

describe('the store being unavailable', () => {
  it('counts a refused WRITE, so a mid-pass outage is not a green cron', async () => {
    // The accounting hole this closes. Every other outcome of a poll lands in
    // exactly one counter; a refused write landed in none. A pass that read
    // fifty finished jobs from the vendor and had all fifty writes rejected
    // reported `polled: 50`, every other number zero, `stoppedBecause:
    // 'complete'` and HTTP 200 — an operator's dashboard would show a healthy
    // sweep over a database that is not accepting writes, and the vendor round
    // trips would be silently thrown away on every tick.
    fake.state.eligible = 2
    fake.state.updateError = { message: 'deadlock detected' }
    fake.state.rows = [
      row({ id: 'a', job_id: 'job-a' }),
      row({ id: 'b', job_id: 'job-b' }),
    ]
    for (const id of ['job-a', 'job-b']) fake.state.payloads.set(id, { status: 'done' })

    const report = await reconcileHardwareJobs()

    expect(report.polled).toBe(2)
    expect(report.writeFailed).toBe(2)
    expect(report.updated).toBe(0)
    expect(report.finished).toBe(0)
    expect(report.note).toContain('REFUSED by the store')
    // The invariant: every polled row is accounted for exactly once.
    expect(
      report.updated + report.unchanged + report.raced + report.unreachable +
        report.skippedUnknownStatus + report.writeFailed
    ).toBe(report.polled)
  })

  it('reports store_unavailable instead of an empty, reassuring pass', async () => {
    fake.state.selectError = { message: 'connection refused' }
    const report = await reconcileHardwareJobs()
    expect(report.stoppedBecause).toBe('store_unavailable')
    expect(report.polled).toBe(0)
  })

  it('reports not_configured with no service-role key, and polls nothing', async () => {
    fake.state.serviceRole = false
    const report = await reconcileHardwareJobs()
    expect(report.configured).toBe(false)
    expect(report.stoppedBecause).toBe('not_configured')
    expect(fake.state.polls).toHaveLength(0)
  })
})

/** Each request gets its own IP so the per-minute limiter never bleeds. */
let ipCounter = 0
function request(headers: Record<string, string> = {}, body?: unknown): Request {
  ipCounter += 1
  return new Request('http://app.test/api/hardware/reconcile', {
    method: 'POST',
    headers: { 'x-forwarded-for': `198.51.100.${(ipCounter % 250) + 1}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` }
}

describe('POST /api/hardware/reconcile — who may call it', () => {
  it('refuses with no Authorization header', async () => {
    const response = await POST(request())
    expect(response.status).toBe(401)
    expect(fake.state.polls).toHaveLength(0)
  })

  it('refuses a wrong secret of the same length', async () => {
    // Same length so the length check cannot be what saves us: the constant-
    // time comparison has to be doing the work.
    const wrong = 'x'.repeat(SECRET.length)
    const response = await POST(request(bearer(wrong)))
    expect(response.status).toBe(401)
    expect(fake.state.polls).toHaveLength(0)
  })

  it('refuses a same-LENGTH token whose bytes are a different length, without throwing', async () => {
    // The bug this pins, which was a 500 on an unauthenticated path. The length
    // guard compared `String.length` (UTF-16 code units) while
    // `timingSafeEqual` requires equal BYTE length, so a token of the same
    // character count and a different byte count skipped the guard and threw a
    // RangeError out of the handler. Any anonymous caller could crash the
    // endpoint with one header.
    const multibyte = 'é'.repeat(SECRET.length)
    expect(multibyte.length).toBe(SECRET.length)
    expect(Buffer.from(multibyte, 'utf8').length).not.toBe(Buffer.from(SECRET, 'utf8').length)

    const response = await POST(request(bearer(multibyte)))

    expect(response.status).toBe(401)
    expect(fake.state.polls).toHaveLength(0)
  })

  it('refuses when the secret is whitespace only — a blank value configures nothing', async () => {
    // An operator who sets HARDWARE_RECONCILE_SECRET="" or "   " in a dashboard
    // has configured nothing, and must be treated exactly like the unset case
    // rather than given a secret that a blank header could match.
    process.env.HARDWARE_RECONCILE_SECRET = '   '
    for (const headers of [{}, bearer(''), bearer('   '), bearer(SECRET)]) {
      const response = await POST(request(headers))
      expect(response.status).toBe(401)
    }
    expect(fake.state.polls).toHaveLength(0)
  })

  it('refuses EVERYONE when the secret is unset — empty never authorises', async () => {
    // The failure this catches is a cron endpoint that sweeps every account's
    // jobs for any anonymous caller because the env var was never set and
    // '' === '' was the whole check.
    delete process.env.HARDWARE_RECONCILE_SECRET
    for (const headers of [{}, bearer(''), { authorization: 'Bearer' }, bearer(SECRET)]) {
      const response = await POST(request(headers))
      expect(response.status).toBe(401)
    }
    expect(fake.state.polls).toHaveLength(0)
  })

  it('accepts the configured secret and returns the report', async () => {
    fake.state.eligible = 4
    fake.state.rows = [row({ id: 'a', job_id: 'job-a' })]
    fake.state.payloads.set('job-a', { status: 'done' })

    const response = await POST(request(bearer(SECRET)))

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.polled).toBe(1)
    expect(body.remaining).toBe(3)
  })

  it('answers 503, not 200, when nothing is configured to sweep', async () => {
    // A cron told "ok" while nothing is reconciled keeps saying nothing is
    // wrong for months.
    fake.state.serviceRole = false
    const response = await POST(request(bearer(SECRET)))
    expect(response.status).toBe(503)
  })

  it('rejects a limit that is not an integer in range', async () => {
    const response = await POST(
      request({ ...bearer(SECRET), 'content-type': 'application/json' }, { limit: 0 })
    )
    expect(response.status).toBe(400)
  })

  it('rate-limits a burst from one address before the secret is even checked', async () => {
    const ip = { 'x-forwarded-for': '203.0.113.251' }
    let limited = 0
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const response = await POST(
        new Request('http://app.test/api/hardware/reconcile', { method: 'POST', headers: ip })
      )
      if (response.status === 429) limited += 1
    }
    expect(limited).toBeGreaterThan(0)
  })
})
