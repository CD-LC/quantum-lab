import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ENTITLEMENT_TTL_MS,
  __resetEntitlementLoader,
  loadEntitlement,
} from './entitlementLoader'

const PRO = { entitlement: { planId: 'pro', status: 'active' }, billingEnabled: true }

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

beforeEach(() => __resetEntitlementLoader())

describe('loadEntitlement — one fetch per page', () => {
  it('shares one in-flight request between concurrent callers', async () => {
    const fetcher = vi.fn(async () => ok(PRO))

    const results = await Promise.all(
      Array.from({ length: 12 }, () => loadEntitlement('u1', fetcher))
    )

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(results.every((r) => r.kind === 'ok')).toBe(true)
  })

  it('reuses a good answer for the TTL, then refetches', async () => {
    const fetcher = vi.fn(async () => ok(PRO))
    await loadEntitlement('u1', fetcher, { now: 1_000 })
    await loadEntitlement('u1', fetcher, { now: 1_000 + ENTITLEMENT_TTL_MS - 1 })
    expect(fetcher).toHaveBeenCalledTimes(1)

    await loadEntitlement('u1', fetcher, { now: 1_000 + ENTITLEMENT_TTL_MS })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does not share across users', async () => {
    const fetcher = vi.fn(async () => ok(PRO))
    await loadEntitlement('u1', fetcher)
    await loadEntitlement('u2', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('force bypasses the cache', async () => {
    const fetcher = vi.fn(async () => ok(PRO))
    await loadEntitlement('u1', fetcher)
    await loadEntitlement('u1', fetcher, { force: true })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('loadEntitlement — transient failures keep the previous value', () => {
  it.each([429, 500, 503])('reports %i as transient with the last good body', async (status) => {
    await loadEntitlement('u1', async () => ok(PRO), { now: 0 })

    const result = await loadEntitlement('u1', async () => new Response('{}', { status }), {
      force: true,
    })

    expect(result).toMatchObject({ kind: 'transient', lastGood: PRO })
  })

  it('honours Retry-After, clamped', async () => {
    const limited = (seconds: string) => async () =>
      new Response('{}', { status: 429, headers: { 'retry-after': seconds } })

    const a = await loadEntitlement('a', limited('7'))
    const b = await loadEntitlement('b', limited('9999'))
    const c = await loadEntitlement('c', limited('nonsense'))

    expect(a).toMatchObject({ kind: 'transient', retryAfterMs: 7_000 })
    expect(b).toMatchObject({ kind: 'transient', retryAfterMs: 30_000 })
    expect(c).toMatchObject({ kind: 'transient', retryAfterMs: 5_000 })
  })

  it('treats a network error and an unreadable 200 as transient', async () => {
    const down = await loadEntitlement('a', async () => {
      throw new Error('offline')
    })
    const garbled = await loadEntitlement('b', async () => new Response('<html>', { status: 200 }))
    expect(down.kind).toBe('transient')
    expect(garbled.kind).toBe('transient')
  })

  it('does not cache a failure: the next call retries', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(ok(PRO))
    const first = await loadEntitlement('u1', fetcher)
    const second = await loadEntitlement('u1', fetcher)
    expect(first.kind).toBe('transient')
    expect(second.kind).toBe('ok')
  })

  it('treats a definitive 404 as "none" (Free), not transient', async () => {
    const result = await loadEntitlement('u1', async () => new Response('{}', { status: 404 }))
    expect(result.kind).toBe('none')
  })
})
