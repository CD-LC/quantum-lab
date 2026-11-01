/**
 * The sign-in migration of locally saved circuits must ride out a 429 from
 * POST /api/circuits (honour retry-after, retry the same circuit, continue)
 * instead of stopping at the first rate-limited save.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authFetchMock = vi.fn()

vi.mock('@/lib/authFetch', () => ({ authFetch: (...a: unknown[]) => authFetchMock(...a) }))
vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } }, error: null }) },
    from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }),
  }),
}))

const { migrateLocalCircuits } = await import('@/lib/circuit-store')

const KEY = 'quantum-lab.circuits'
const store = new Map<string, string>()

function local(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    name: `circuit ${i}`,
    qasm: `OPENQASM 2.0; // ${i}`,
    numQubits: 2,
    createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
    updatedAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
  }))
}

function ok(): Response {
  return new Response(JSON.stringify({ circuit: { id: 'r', name: 'n' } }), { status: 201 })
}
function tooMany(seconds: number): Response {
  return new Response(JSON.stringify({ error: 'Too many saves.' }), {
    status: 429,
    headers: { 'retry-after': String(seconds) },
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  store.clear()
  authFetchMock.mockReset()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('migrateLocalCircuits and 429', () => {
  it('waits for retry-after and then finishes migrating every circuit', async () => {
    store.set(KEY, JSON.stringify(local(4)))
    let calls = 0
    authFetchMock.mockImplementation(async () => {
      calls += 1
      // The third POST is rate limited once.
      return calls === 3 ? tooMany(20) : ok()
    })

    const done = migrateLocalCircuits('u1')
    await vi.advanceTimersByTimeAsync(19_000)
    // Still waiting: 2 moved, the 3rd is parked on the 429.
    expect(calls).toBe(3)
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(done).resolves.toBe(4)
    expect(calls).toBe(5)
    expect(JSON.parse(store.get(KEY) ?? '[]')).toEqual([])
  })

  it('gives up after repeated 429s and keeps the rest locally', async () => {
    store.set(KEY, JSON.stringify(local(2)))
    let calls = 0
    authFetchMock.mockImplementation(async () => {
      calls += 1
      return calls === 1 ? ok() : tooMany(1)
    })
    const done = migrateLocalCircuits('u1')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await expect(done).resolves.toBe(1)
    const left = JSON.parse(store.get(KEY) ?? '[]') as { id: string }[]
    expect(left.map((c) => c.id)).toEqual(['c1'])
  })

  it('still stops on a non-429 failure', async () => {
    store.set(KEY, JSON.stringify(local(3)))
    let calls = 0
    authFetchMock.mockImplementation(async () => {
      calls += 1
      return calls === 2 ? new Response('{}', { status: 503 }) : ok()
    })
    await expect(migrateLocalCircuits('u1')).resolves.toBe(1)
    expect(calls).toBe(2)
  })
})
