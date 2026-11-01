/**
 * attemptRoutes.test.ts — THE TESTS THAT FAIL AGAINST THE OLD DESIGN.
 *
 * Every assertion in this file was impossible to make a week ago, because
 * there was nothing to assert against: the question bank shipped to the
 * browser, the score was computed there, the attempt was a JSON blob in
 * localStorage and the certificate was a hash of a name the candidate typed.
 * There was no server in the loop to refuse anything.
 *
 * So each test below is written against the specific hole it closes:
 *
 *   · the paper a candidate receives carries no answer key at all;
 *   · a submission that claims its own score is graded from the bank instead;
 *   · a submission that arrives after the server's deadline is refused, and
 *     the answers it carries are not counted;
 *   · an attempt started in one browser resumes, with its answers, in another
 *     — the thing localStorage could never do;
 *   · one candidate cannot touch another's attempt;
 *   · the paid exam is refused to a free account BEFORE a question is drawn;
 *   · /verify confirms a real pass and denies a fabricated number.
 *
 * ── What is faked, and what is real ─────────────────────────────────────────
 *
 * Only `@supabase/supabase-js` and the `getSupabase` the auth helper reads: an
 * in-memory table store plus a token→user map, the same double
 * `lib/hardware/submitGate.test.ts` uses. Everything else runs for real —
 * `verifiedCaller`, `getEntitlement`, `assertFeature`, the whole of
 * `lib/exams/service.ts`, the grader, and the real 103-question bank. A test
 * that mocked the grader would pass just as happily with the grader deleted.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` is deliberately NOT set, so the attempt store is
 * the in-process fallback. That exercises the same `ExamStore` interface the
 * Supabase backend implements; the row mapping specific to Postgres is covered
 * separately in `storeSupabase.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  }

  function table(name: string) {
    const q = {
      op: 'select' as 'select' | 'insert' | 'update' | 'delete',
      eqs: [] as Array<[string, unknown]>,
      head: false,
    }
    const rows = (): Record<string, unknown>[] =>
      name === 'subscriptions' ? (state.subscriptions as unknown as Record<string, unknown>[]) : []

    const matches = (row: Record<string, unknown>): boolean =>
      q.eqs.every(([col, val]) => row[col] === val)

    function run(mode: 'many' | 'single' | 'maybe'): Promise<unknown> {
      const hits = rows().filter(matches)
      if (q.head) return Promise.resolve({ data: null, error: null, count: hits.length })
      if (mode !== 'many') return Promise.resolve({ data: hits[0] ?? null, error: null })
      return Promise.resolve({ data: hits, error: null, count: hits.length })
    }

    const api = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.head) q.head = true
        return api
      },
      eq(col: string, val: unknown) {
        q.eqs.push([col, val])
        return api
      },
      gte() {
        return api
      },
      order() {
        return api
      },
      limit() {
        return api
      },
      single: () => run('single'),
      maybeSingle: () => run('maybe'),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        run('many').then(resolve, reject),
    }
    return api
  }

  const client = {
    from: (name: string) => table(name),
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

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.test'
// Left unset on purpose: see the header. The exam store falls back to memory.
delete process.env.SUPABASE_SERVICE_ROLE_KEY

const { __resetRateLimitForTests } = await import('@/lib/rateLimit')
const { __resetExamStoreForTests } = await import('@/lib/exams/store')
const { questionsFor } = await import('@/lib/exams/questions')
const attemptRoute = await import('@/app/api/exams/[examId]/attempt/route')
const answersRoute = await import('@/app/api/exams/[examId]/answers/route')
const submitRoute = await import('@/app/api/exams/[examId]/submit/route')
const certificateRoute = await import('@/app/api/exams/[examId]/certificate/route')
const verifyRoute = await import('@/app/api/exams/verify/[certificateId]/route')
const summaryRoute = await import('@/app/api/exams/summary/route')

const FOUNDATIONS = 'foundations-cert'
const ADVANCED = 'advanced-cert'

// ── a browser ───────────────────────────────────────────────────────────────

/**
 * One browser: its own cookie jar, its own source address, optionally a bearer
 * token. Two of these sharing a token but not a jar is exactly the "signed in
 * on a different machine" case, and it is how the resume test is written.
 */
class Browser {
  private jar = new Map<string, string>()

  constructor(
    private readonly ip: string,
    private readonly token: string | null = null
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'x-forwarded-for': this.ip, ...extra }
    if (this.token) h.authorization = `Bearer ${this.token}`
    if (this.jar.size > 0) {
      h.cookie = [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
    }
    return h
  }

  /** Put a cookie in the jar by hand — for a caller who chooses their own. */
  presentCookie(name: string, value: string): void {
    this.jar.set(name, value)
  }

  private absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(';')[0] ?? ''
      const eq = pair.indexOf('=')
      if (eq > 0) this.jar.set(pair.slice(0, eq), pair.slice(eq + 1))
    }
  }

  async call(
    handler: (req: Request, ctx: never) => Promise<Response>,
    url: string,
    ctx: unknown,
    init: { method?: string; body?: unknown } = {}
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const req = new Request(`http://app.test${url}`, {
      method: init.method ?? 'GET',
      headers: this.headers(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    })
    const res = await handler(req, ctx as never)
    this.absorb(res)
    let body: Record<string, unknown> = {}
    try {
      body = (await res.json()) as Record<string, unknown>
    } catch {
      body = {}
    }
    return { status: res.status, body }
  }

  state(examId = FOUNDATIONS) {
    return this.call(attemptRoute.GET, `/api/exams/${examId}/attempt`, { params: { examId } })
  }
  start(examId = FOUNDATIONS) {
    return this.call(attemptRoute.POST, `/api/exams/${examId}/attempt`, { params: { examId } }, {
      method: 'POST',
    })
  }
  saveAnswers(examId: string, body: unknown) {
    return this.call(answersRoute.PUT, `/api/exams/${examId}/answers`, { params: { examId } }, {
      method: 'PUT',
      body,
    })
  }
  submit(examId: string, body: unknown) {
    return this.call(submitRoute.POST, `/api/exams/${examId}/submit`, { params: { examId } }, {
      method: 'POST',
      body,
    })
  }
  claim(examId: string, body: unknown) {
    return this.call(
      certificateRoute.POST,
      `/api/exams/${examId}/certificate`,
      { params: { examId } },
      { method: 'POST', body }
    )
  }
  verify(certificateId: string) {
    return this.call(verifyRoute.GET, `/api/exams/verify/${certificateId}`, {
      params: { certificateId },
    })
  }
  summary() {
    return this.call(summaryRoute.GET, '/api/exams/summary', undefined)
  }
}

let seq = 0
function signedIn(userId: string, plan: 'free' | 'pro' = 'free'): Browser {
  const token = `jwt-${userId}`
  db.state.tokens.set(token, userId)
  if (plan !== 'free') {
    db.state.subscriptions.push({
      user_id: userId,
      plan_id: plan,
      status: 'active',
      current_period_end: null,
      cancel_at_period_end: false,
    })
  }
  return new Browser(`198.51.100.${(seq++ % 200) + 1}`, token)
}

function guest(): Browser {
  return new Browser(`203.0.113.${(seq++ % 200) + 1}`)
}

/** Perfect answers for a paper, built from the bank — which only we can see. */
function correctAnswersFor(examId: string, questionIds: string[]): Record<string, unknown> {
  const byId = new Map(questionsFor(examId).map((q) => [q.id, q]))
  const out: Record<string, unknown> = {}
  for (const id of questionIds) {
    const q = byId.get(id)
    if (!q) continue
    out[id] =
      q.kind === 'numeric'
        ? { questionId: id, selectedIds: [], numberValue: q.correctNumber, flagged: false }
        : { questionId: id, selectedIds: [...(q.correctIds ?? [])], flagged: false }
  }
  return out
}

/** Every key in a nested structure, flattened. */
function allKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, into)
    return into
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k)
      allKeys(v, into)
    }
  }
  return into
}

beforeEach(() => {
  __resetRateLimitForTests()
  __resetExamStoreForTests()
  db.state.tokens.clear()
  db.state.subscriptions.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

// ────────────────────────────────────────────────────────────
describe('the paper the browser receives', () => {
  it('contains no correct answers, no tolerances and no explanations', async () => {
    const browser = signedIn('user-paper')
    const { status, body } = await browser.start()

    expect(status).toBe(201)
    expect(body.state).toBe('open')

    const paper = body.paper as Array<Record<string, unknown>>
    expect(paper.length).toBe(15)

    // The whole response, not just the questions: a leak in `attempt` or in a
    // future top-level field would be just as bad.
    const keys = allKeys(body)
    for (const forbidden of ['correctIds', 'correctNumber', 'tolerance', 'explanation']) {
      expect(keys.has(forbidden), `the paper leaked ${forbidden}`).toBe(false)
    }

    // …and it is still a usable exam: prompts and options are there.
    for (const q of paper) {
      expect(typeof q.prompt).toBe('string')
      expect((q.prompt as string).length).toBeGreaterThan(10)
      if (q.kind !== 'numeric') {
        expect(Array.isArray(q.options)).toBe(true)
        expect((q.options as unknown[]).length).toBeGreaterThan(1)
      }
    }
  })

  it('serialises the whole bank nowhere: a paper is 15 of 58 items', async () => {
    const browser = signedIn('user-pool')
    const { body } = await browser.start()
    const ids = (body.paper as Array<{ id: string }>).map((q) => q.id)
    expect(new Set(ids).size).toBe(15)
    expect(questionsFor(FOUNDATIONS).length).toBe(58)
  })
})

// ────────────────────────────────────────────────────────────
describe('grading', () => {
  it('ignores a score claimed by the client and computes its own', async () => {
    const browser = signedIn('user-forge')
    const started = await browser.start()
    const attemptId = (started.body.attempt as { id: string }).id

    // The forgery: a body that asserts a perfect pass, with no answers at all.
    const submitted = await browser.submit(FOUNDATIONS, {
      attemptId,
      score: 1,
      passed: true,
      earned: 999,
      answers: {},
    })

    expect(submitted.status).toBe(200)
    const result = submitted.body.result as Record<string, unknown>
    expect(result.score).toBe(0)
    expect(result.passed).toBe(false)
    expect(result.certificateId).toBeUndefined()

    // And it did not merely lie in the response: the record agrees.
    const after = await browser.state()
    expect((after.body.result as Record<string, unknown>).passed).toBe(false)
  })

  it('grades a genuinely correct paper as a pass', async () => {
    const browser = signedIn('user-honest')
    const started = await browser.start()
    const attempt = started.body.attempt as { id: string }
    const ids = (started.body.paper as Array<{ id: string }>).map((q) => q.id)

    const submitted = await browser.submit(FOUNDATIONS, {
      attemptId: attempt.id,
      answers: correctAnswersFor(FOUNDATIONS, ids),
    })

    const result = submitted.body.result as Record<string, unknown>
    expect(result.score).toBe(1)
    expect(result.passed).toBe(true)
    // Only now does an answer key cross the wire, and only for these 15 items.
    expect((result.review as Array<Record<string, unknown>>).length).toBe(15)
    expect(allKeys(result).has('explanation')).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────
describe('the server clock', () => {
  it('refuses a late submission and does not count the answers it carries', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T10:00:00Z'))

    const browser = signedIn('user-late')
    const started = await browser.start()
    const attempt = started.body.attempt as { id: string; expiresAt: string }
    const ids = (started.body.paper as Array<{ id: string }>).map((q) => q.id)

    expect(new Date(attempt.expiresAt).toISOString()).toBe('2026-08-17T10:25:00.000Z')

    // One second past the deadline plus the 3s network grace.
    vi.setSystemTime(new Date('2026-08-17T10:25:04Z'))

    const submitted = await browser.submit(FOUNDATIONS, {
      attemptId: attempt.id,
      answers: correctAnswersFor(FOUNDATIONS, ids),
    })

    expect(submitted.status).toBe(409)
    const result = submitted.body.result as Record<string, unknown>
    // A perfect set of answers arrived — after time. It counts for nothing.
    expect(result.score).toBe(0)
    expect(result.passed).toBe(false)
    expect(result.closedBy).toBe('expiry')
    // Closed AT the deadline, not at the moment the late request landed.
    expect(result.submittedAt).toBe('2026-08-17T10:25:00.000Z')
  })

  it('accepts a submission inside the grace window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T11:00:00Z'))

    const browser = signedIn('user-grace')
    const started = await browser.start()
    const attempt = started.body.attempt as { id: string }
    const ids = (started.body.paper as Array<{ id: string }>).map((q) => q.id)

    // 2 seconds late: inside SUBMIT_GRACE_MS, which is a network budget.
    vi.setSystemTime(new Date('2026-08-17T11:25:02Z'))

    const submitted = await browser.submit(FOUNDATIONS, {
      attemptId: attempt.id,
      answers: correctAnswersFor(FOUNDATIONS, ids),
    })
    expect(submitted.status).toBe(200)
    expect((submitted.body.result as Record<string, unknown>).score).toBe(1)
  })

  it('refuses an answer written after the deadline and closes the paper', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T12:00:00Z'))

    const browser = signedIn('user-latewrite')
    const started = await browser.start()
    const attempt = started.body.attempt as { id: string }
    const ids = (started.body.paper as Array<{ id: string }>).map((q) => q.id)

    vi.setSystemTime(new Date('2026-08-17T12:30:00Z'))
    const saved = await browser.saveAnswers(FOUNDATIONS, {
      attemptId: attempt.id,
      answers: correctAnswersFor(FOUNDATIONS, ids),
    })

    expect(saved.status).toBe(409)
    expect((saved.body.result as Record<string, unknown>).score).toBe(0)
  })

  it('grades an abandoned paper when the candidate comes back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T13:00:00Z'))

    const browser = signedIn('user-abandon')
    await browser.start()

    // A week later. The old design only graded this if the tab was reopened.
    vi.setSystemTime(new Date('2026-08-24T13:00:00Z'))
    const back = await browser.state()

    expect(back.body.state).toBe('submitted')
    const result = back.body.result as Record<string, unknown>
    expect(result.closedBy).toBe('expiry')
    // Time spent is the limit, not a week.
    expect(result.timeSpentMs).toBe(25 * 60_000)
  })
})

// ────────────────────────────────────────────────────────────
describe('resumability', () => {
  it('resumes the same attempt, with its answers, in a different browser', async () => {
    const laptop = signedIn('user-two-machines')
    const started = await laptop.start()
    const attempt = started.body.attempt as { id: string }
    const paper = started.body.paper as Array<{ id: string }>

    const firstId = paper[0]?.id as string
    await laptop.saveAnswers(FOUNDATIONS, {
      attemptId: attempt.id,
      answers: {
        [firstId]: { questionId: firstId, selectedIds: ['a'], flagged: true },
      },
    })

    // A different machine: new cookie jar, new address, same account.
    const phone = new Browser('192.0.2.77', 'jwt-user-two-machines')
    const resumed = await phone.state()

    expect(resumed.body.state).toBe('open')
    const resumedAttempt = resumed.body.attempt as {
      id: string
      answers: Record<string, { selectedIds: string[]; flagged: boolean }>
    }
    expect(resumedAttempt.id).toBe(attempt.id)
    expect(resumedAttempt.answers[firstId]?.selectedIds).toEqual(['a'])
    expect(resumedAttempt.answers[firstId]?.flagged).toBe(true)

    // Same paper, same order.
    expect((resumed.body.paper as Array<{ id: string }>).map((q) => q.id)).toEqual(
      paper.map((q) => q.id)
    )
  })

  it('does not resume somebody else attempt', async () => {
    const alice = signedIn('user-alice')
    await alice.start()
    const bob = signedIn('user-bob')
    const bobState = await bob.state()
    expect(bobState.body.state).toBe('none')
  })

  it('refuses to submit an attempt the caller does not own', async () => {
    const alice = signedIn('user-owner')
    const started = await alice.start()
    const attemptId = (started.body.attempt as { id: string }).id

    const mallory = signedIn('user-mallory')
    const stolen = await mallory.submit(FOUNDATIONS, { attemptId, answers: {} })
    expect(stolen.status).toBe(404)

    // Alice's paper is untouched and still running.
    const alices = await alice.state()
    expect(alices.body.state).toBe('open')
  })

  it('hands a double-clicked start the same paper rather than dealing a second', async () => {
    const browser = signedIn('user-doubleclick')
    const first = await browser.start()
    const second = await browser.start()
    expect((second.body.attempt as { id: string }).id).toBe(
      (first.body.attempt as { id: string }).id
    )
    expect(second.status).toBe(200)
  })
})

// ────────────────────────────────────────────────────────────
describe('entitlement', () => {
  it('refuses the advanced paper to a free account before drawing a question', async () => {
    const browser = signedIn('user-free', 'free')
    const started = await browser.start(ADVANCED)
    expect(started.status).toBe(402)
    expect(started.body.paper).toBeUndefined()
    expect(started.body.requiredPlan).toBe('pro')
  })

  it('refuses the advanced paper to an anonymous caller', async () => {
    const anon = guest()
    const started = await anon.start(ADVANCED)
    expect(started.status).toBe(402)
    expect(started.body.paper).toBeUndefined()
  })

  it('serves the advanced paper to a Pro account', async () => {
    const browser = signedIn('user-pro', 'pro')
    const started = await browser.start(ADVANCED)
    expect(started.status).toBe(201)
    expect((started.body.paper as unknown[]).length).toBe(20)
  })

  it('still serves the free foundations paper to an anonymous caller', async () => {
    const anon = guest()
    const started = await anon.start(FOUNDATIONS)
    expect(started.status).toBe(201)
    expect((started.body.attempt as { certifiable: boolean }).certifiable).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────
describe('certificates and verification', () => {
  async function passExam(browser: Browser): Promise<Record<string, unknown>> {
    const started = await browser.start()
    const attempt = started.body.attempt as { id: string }
    const ids = (started.body.paper as Array<{ id: string }>).map((q) => q.id)
    const submitted = await browser.submit(FOUNDATIONS, {
      attemptId: attempt.id,
      answers: correctAnswersFor(FOUNDATIONS, ids),
    })
    return submitted.body.result as Record<string, unknown>
  }

  it('issues a certificate for a real pass and verifies it', async () => {
    const browser = signedIn('user-cert')
    const result = await passExam(browser)
    expect(result.passed).toBe(true)

    const claimed = await browser.claim(FOUNDATIONS, {
      attemptId: result.attemptId,
      name: 'Ada Lovelace',
    })
    expect(claimed.status).toBe(201)
    const cert = claimed.body.certificate as { id: string }
    expect(cert.id).toMatch(/^QL-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]$/)

    // Anyone at all — no token, no cookie — can check it.
    const stranger = guest()
    const checked = await stranger.verify(cert.id)
    expect(checked.status).toBe(200)
    expect(checked.body.valid).toBe(true)
    expect(checked.body.name).toBe('Ada Lovelace')
    expect(checked.body.examId).toBe(FOUNDATIONS)
    expect(typeof checked.body.issuedAt).toBe('string')

    // …and learns nothing else. This list is the privacy contract.
    for (const leak of ['score', 'userId', 'user_id', 'attemptId', 'email', 'answers']) {
      expect(allKeys(checked.body).has(leak), `verification leaked ${leak}`).toBe(false)
    }
  })

  it('denies a fabricated certificate number', async () => {
    const stranger = guest()

    // Well-formed and never issued: the checksum is right ('4' is the correct
    // check character for a payload of ten As), the row is not there.
    const invented = await stranger.verify('QL-AAAAA-AAAAA-4')
    expect(invented.body.valid).toBe(false)
    expect(String(invented.body.reason)).toMatch(/no certificate/i)

    // Not even the right shape.
    const junk = await stranger.verify('DEFINITELY-A-CERTIFICATE')
    expect(junk.body.valid).toBe(false)
    expect(String(junk.body.reason)).toMatch(/not the shape/i)
  })

  it('refuses to certify a failed attempt', async () => {
    const browser = signedIn('user-failed')
    const started = await browser.start()
    const attempt = started.body.attempt as { id: string }
    const submitted = await browser.submit(FOUNDATIONS, { attemptId: attempt.id, answers: {} })
    const result = submitted.body.result as { attemptId: string; passed: boolean }
    expect(result.passed).toBe(false)

    const claimed = await browser.claim(FOUNDATIONS, {
      attemptId: result.attemptId,
      name: 'Ada Lovelace',
    })
    expect(claimed.status).toBe(409)
  })

  it('refuses to certify an anonymous pass', async () => {
    const anon = guest()
    const result = await passExam(anon)
    expect(result.passed).toBe(true)
    expect(result.certifiable).toBe(false)

    const claimed = await anon.claim(FOUNDATIONS, {
      attemptId: result.attemptId,
      name: 'Nobody In Particular',
    })
    expect(claimed.status).toBe(401)
  })

  it('issues one certificate per pass, however many times it is claimed', async () => {
    const browser = signedIn('user-once')
    const result = await passExam(browser)
    const first = await browser.claim(FOUNDATIONS, {
      attemptId: result.attemptId,
      name: 'Grace Hopper',
    })
    const second = await browser.claim(FOUNDATIONS, {
      attemptId: result.attemptId,
      name: 'Someone Else Entirely',
    })
    expect((second.body.certificate as { id: string }).id).toBe(
      (first.body.certificate as { id: string }).id
    )
    // The name on a credential is not editable after the fact.
    expect((second.body.certificate as { name: string }).name).toBe('Grace Hopper')
  })
})

// ────────────────────────────────────────────────────────────
describe('summary', () => {
  it('reports the caller history from server records, not from a claim', async () => {
    const browser = signedIn('user-summary')
    const started = await browser.start()
    const attempt = started.body.attempt as { id: string }
    const ids = (started.body.paper as Array<{ id: string }>).map((q) => q.id)
    await browser.submit(FOUNDATIONS, {
      attemptId: attempt.id,
      answers: correctAnswersFor(FOUNDATIONS, ids),
    })

    const summary = await browser.summary()
    const rows = summary.body.summaries as Array<Record<string, unknown>>
    const foundations = rows.find((r) => r.examId === FOUNDATIONS)
    expect(foundations?.passed).toBe(true)
    expect(foundations?.bestScore).toBe(1)
    expect(summary.body.signedIn).toBe(true)

    // A different account sees nothing of it.
    const other = signedIn('user-summary-other')
    const otherSummary = await other.summary()
    expect((otherSummary.body.summaries as unknown[]).length).toBe(0)
  })

  it('tells the caller when attempts are not being stored durably', async () => {
    const browser = signedIn('user-durable')
    const summary = await browser.summary()
    // No SUPABASE_SERVICE_ROLE_KEY in this suite, so the store is in-process
    // memory and the UI is expected to warn the candidate before they start.
    expect(summary.body.durable).toBe(false)
  })
})

/**
 * The rate limit is only a limit if refused requests land in the same bucket as
 * the ones before them.
 *
 * REGRESSION. `resolveSubject` mints a fresh `guest_<128 bits>` for a request
 * that carries no cookie, and `service.ts` handed that freshly-minted id to
 * `callerKey` as the rate-limit subject. So every cookie-less request opened a
 * private bucket and START_LIMIT (10/min) bounded nothing: an anonymous script
 * could create `exam_attempts` rows without limit from one address. Measured
 * against the running app before the fix — 14 POSTs, no cookie, one IP, 14×201.
 *
 * The test is written so it CANNOT pass by accident: the same 14 requests sent
 * from one browser (which keeps its cookie) must still be refused at the
 * eleventh, so a limiter that has simply been turned off fails the second half.
 */
describe('rate limiting an identity the server just invented', () => {
  it('bounds a cookie-less flood from one address', async () => {
    const ip = '203.0.113.240'
    const statuses: number[] = []
    for (let i = 0; i < 14; i += 1) {
      // A NEW Browser every iteration: same address, empty cookie jar, so the
      // server mints a new guest id each time. This is `curl` in a loop.
      const res = await new Browser(ip).start()
      statuses.push(res.status)
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0)
    expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(10)
  })

  it('is not fooled by a caller who mints their own guest cookie each request', async () => {
    // The cookie is unsigned and its shape is public, so "has presented a
    // cookie" is not evidence of anything. Each request here carries a
    // DIFFERENT, self-chosen, perfectly well-formed guest id from one address.
    const ip = '203.0.113.241'
    const statuses: number[] = []
    for (let i = 0; i < 14; i += 1) {
      const forged = `guest_${String(i).padStart(32, '0')}`
      const browser = new Browser(ip)
      browser.presentCookie('ql_exam_guest', forged)
      statuses.push((await browser.start()).status)
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0)
  })

  it('still lets a signed-in candidate through, then refuses the eleventh', async () => {
    // The control: a limiter that has simply been switched off fails here.
    const browser = signedIn('user-ratelimit-control')
    const statuses: number[] = []
    for (let i = 0; i < 14; i += 1) {
      statuses.push((await browser.start()).status)
    }
    expect(statuses.slice(0, 10).every((s) => s === 201 || s === 200)).toBe(true)
    expect(statuses[10]).toBe(429)
  })
})

// ────────────────────────────────────────────────────────────
describe('request bodies are capped, after the rate limit', () => {
  it('refuses an oversized body on every write route with 413', async () => {
    const browser = signedIn('user-bigbody')
    const started = await browser.start()
    const attemptId = (started.body.attempt as { id: string }).id
    const pad = 'a'.repeat(200_000)

    const put = await browser.saveAnswers(FOUNDATIONS, { attemptId, pad })
    const sub = await browser.submit(FOUNDATIONS, { attemptId, pad })
    const cert = await browser.claim(FOUNDATIONS, { attemptId, name: 'Ada', pad })
    expect([put.status, sub.status, cert.status]).toEqual([413, 413, 413])

    // Nothing was closed by the refused submit.
    const after = await browser.state()
    expect(after.body.state).toBe('open')
  })

  it('refuses an oversized body without content-length too (streamed)', async () => {
    const big = new TextEncoder().encode(JSON.stringify({ attemptId: 'x', pad: 'a'.repeat(200_000) }))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big)
        controller.close()
      },
    })
    const req = new Request('http://app.test/api/exams/foundations-cert/answers', {
      method: 'PUT',
      headers: { 'x-forwarded-for': '203.0.113.250' },
      body: stream,
      // @ts-expect-error duplex is required by undici for stream bodies
      duplex: 'half',
    })
    const res = await answersRoute.PUT(req, { params: Promise.resolve({ examId: FOUNDATIONS }) } as never)
    expect(res.status).toBe(413)
  })

  it('rate limits before reading the body', async () => {
    const ip = '203.0.113.251'
    const pad = 'a'.repeat(200_000)
    const statuses: number[] = []
    for (let i = 0; i < 12; i += 1) {
      statuses.push((await new Browser(ip).submit(FOUNDATIONS, { attemptId: 'x', pad })).status)
    }
    // START_LIMIT is 10/min for submit: the 11th is a 429, not a 413.
    expect(statuses.slice(0, 10).every((s) => s === 413)).toBe(true)
    expect(statuses[10]).toBe(429)
  })

  it('still accepts a normal-sized body', async () => {
    const browser = signedIn('user-smallbody')
    const started = await browser.start()
    const attemptId = (started.body.attempt as { id: string }).id
    expect((await browser.saveAnswers(FOUNDATIONS, { attemptId, answers: {} })).status).toBe(200)
  })
})

// ────────────────────────────────────────────────────────────
describe('answer-key harvesting', () => {
  it('withholds the key for every question an empty submission left blank', async () => {
    const browser = signedIn('user-harvest')
    const started = await browser.start()
    const attemptId = (started.body.attempt as { id: string }).id
    const submitted = await browser.submit(FOUNDATIONS, { attemptId, answers: {} })
    const review = (submitted.body.result as { review: Array<Record<string, unknown>> }).review
    expect(review.length).toBe(15)
    for (const q of review) {
      expect(q.answered).toBe(false)
      expect(q.correctIds).toBeUndefined()
      expect(q.correctNumber).toBeUndefined()
      expect(q.tolerance).toBeUndefined()
      expect(q.explanation).toBeUndefined()
    }
  })

  it('refuses a new paper inside the cooldown after a fail, then allows it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-22T10:00:00Z'))
    const browser = signedIn('user-cooldown')
    const started = await browser.start()
    const attemptId = (started.body.attempt as { id: string }).id
    const failed = await browser.submit(FOUNDATIONS, { attemptId, answers: {} })
    expect((failed.body.result as Record<string, unknown>).retakeAvailableAt).toBeDefined()

    const tooSoon = await browser.start()
    expect(tooSoon.status).toBe(429)
    expect(typeof tooSoon.body.retakeAvailableAt).toBe('string')

    vi.setSystemTime(new Date('2026-10-22T10:16:00Z'))
    const later = await browser.start()
    expect(later.status).toBe(201)
  })

  it('does not delay a candidate who passed', async () => {
    const browser = signedIn('user-passretake')
    const started = await browser.start()
    const ids = (started.body.paper as Array<{ id: string }>).map((q) => q.id)
    const attemptId = (started.body.attempt as { id: string }).id
    const done = await browser.submit(FOUNDATIONS, {
      attemptId,
      answers: correctAnswersFor(FOUNDATIONS, ids),
    })
    expect((done.body.result as Record<string, unknown>).retakeAvailableAt).toBeUndefined()
    expect((await browser.start()).status).toBe(201)
  })
})

// ────────────────────────────────────────────────────────────
describe('the countdown follows the server clock', () => {
  it('carries serverNow on an open attempt', async () => {
    const browser = signedIn('user-servernow')
    const started = await browser.start()
    const attempt = started.body.attempt as { serverNow?: string; startedAt: string }
    expect(Math.abs(Date.parse(attempt.serverNow ?? '') - Date.parse(attempt.startedAt))).toBeLessThan(5_000)
    const resumed = await browser.state()
    expect(typeof (resumed.body.attempt as { serverNow?: string }).serverNow).toBe('string')
  })
})

// ────────────────────────────────────────────────────────────
describe('the guest cookie', () => {
  it('is Secure over https and plain over http', async () => {
    const mk = (url: string, extra: Record<string, string> = {}) =>
      attemptRoute.GET(
        new Request(url, { headers: { 'x-forwarded-for': '203.0.113.252', ...extra } }),
        { params: Promise.resolve({ examId: FOUNDATIONS }) } as never
      )
    const https = await mk('https://app.test/api/exams/foundations-cert/attempt')
    expect(https.headers.get('set-cookie')).toMatch(/; Secure/)
    const proxied = await mk('http://app.test/api/exams/foundations-cert/attempt', {
      'x-forwarded-proto': 'https',
    })
    expect(proxied.headers.get('set-cookie')).toMatch(/; Secure/)
    const http = await mk('http://localhost/api/exams/foundations-cert/attempt')
    expect(http.headers.get('set-cookie')).not.toMatch(/Secure/)
  })
})

// ────────────────────────────────────────────────────────────
describe('the badge route', () => {
  it('answers a malformed percent-encoded id with 404, not a thrown 500', async () => {
    const badge = await import('@/app/api/certificates/[certificateId]/badge/route')
    for (const id of ['%E0', '%', '%25']) {
      const res = await badge.GET(new Request('http://app.test/api/certificates/x/badge'), {
        params: Promise.resolve({ certificateId: id }),
      })
      expect(res.status).toBe(404)
    }
  })
})

// ────────────────────────────────────────────────────────────
describe('request body cap', () => {
  it('refuses an oversized body on all three write routes, before parsing it', async () => {
    const browser = signedIn('user-bigbody')
    const started = await browser.start()
    const attemptId = (started.body.attempt as { id: string }).id
    const padding = 'x'.repeat(80 * 1024)
    for (const call of [
      () => browser.saveAnswers(FOUNDATIONS, { attemptId, answers: {}, pad: padding }),
      () => browser.submit(FOUNDATIONS, { attemptId, answers: {}, pad: padding }),
      () => browser.claim(FOUNDATIONS, { attemptId, name: 'A', pad: padding }),
    ]) {
      const res = await call()
      expect(res.status).toBe(413)
    }
    // A normal body still works afterwards.
    expect((await browser.saveAnswers(FOUNDATIONS, { attemptId, answers: {} })).status).toBe(200)
  })
})
